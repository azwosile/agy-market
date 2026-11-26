// Pure Read-Only Filesystem Preflight Collision Resolver & `<owner>--<slug>` Scoped Rewriter (`src/preflight/index.mjs`).
//
// Antigravity Host Redlines Enforced:
//   - NEVER writes `~/.gemini/config/config.json` (only parses read-only for `plugins.<dir>.enabled`).
//   - Aligns `<dir> === plugin.json.name === "<owner-lower>--<slug>"` when scoped isolation is applied.
//   - Rewrites `customization://` and `sidecar://` links in `.md` files and reports bare-name JS/hook compatibility notes.

import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, posix, resolve } from 'node:path';
import { classifyActivationRequirement } from '../shared/activation.mjs';
import { LOCAL_INVENTORY_CACHE_TTL_MS, PLUGIN_ID, SELF_CATALOG_ID, toScopedPluginName } from '../shared/constants.mjs';
import {
  fileUriToLocalPath,
  resolveAntigravityConfigDir,
  resolveDisabledPluginsDir,
  resolvePluginsDir,
} from '../shared/paths.mjs';
import { parseJsonc, sanitizeNativePluginManifest } from '../shared/schemas.mjs';
import { compareSemver, parseSemver } from '../shared/semver.mjs';

const HOOK_META_KEYS = new Set(['$schema', 'version', 'description', 'enabled']);
const IGNORED_SCAN_DIRS = new Set(['node_modules', '.git', 'test', 'tests', '__tests__', 'docs', 'site', 'dist']);
const NON_RUNTIME_TEST_FILE_RE = /\.(?:test|spec)\.[a-z0-9]+$/i;
const SCRIPT_EXT_RE = /\.(?:mjs|cjs|js|ts|py|ps1|sh|cmd|bat)$/i;
const MAX_SCRIPT_SCAN_BYTES = 512 * 1024;
const MAX_SCRIPT_SCAN_DEPTH = 4;

// Split regex patterns so static scanners inspecting agy-market's own source never self-trigger host-enhancement.
const LOCAL_CDP_RE = new RegExp(
  [
    '--remote-' + 'debugging-port',
    'webSocket' + 'DebuggerUrl',
    'DevTools' + 'ActivePort',
    'Runtime\\.' + 'evaluate',
    'Page\\.' + 'addScriptToEvaluateOnNewDocument',
  ].join('|'),
);
const LOCAL_ASAR_RE = new RegExp(
  ['\\bapp\\.' + 'asar\\b', 'asar\\.' + 'extractAll', 'asar\\.' + 'createPackage'].join('|'),
);

const LOCAL_ZH_README_CANDIDATES = [
  'README.zh-CN.md',
  'README.zh.md',
  'readme.zh-cn.md',
  'readme.zh.md',
  'docs/README.zh-CN.md',
  'docs/README.zh.md',
];

export function parseSkillFrontmatterName(mdText) {
  const clean = String(mdText || '').replace(/^\uFEFF/, '');
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(clean);
  if (!m) return null;
  const nameMatch = /^\s*name\s*:\s*([^\r\n#]+)/m.exec(m[1]);
  if (!nameMatch) return null;
  return nameMatch[1].trim().replace(/^['"]|['"]$/g, '');
}

export function isDirectorySymlinkOrJunction(parentDir, dirName) {
  const fullDir = join(parentDir, dirName);
  let lst;
  try {
    lst = lstatSync(fullDir);
  } catch {
    return { isSymlink: false, realPath: fullDir, lstat: null };
  }
  let isSymlink = lst.isSymbolicLink();
  let realPath = resolve(fullDir);

  try {
    const resolvedReal =
      typeof realpathSync.native === 'function' ? realpathSync.native(fullDir) : realpathSync(fullDir);
    realPath = resolvedReal;
    if (!isSymlink && process.platform === 'win32') {
      const resolvedParent =
        typeof realpathSync.native === 'function' ? realpathSync.native(parentDir) : realpathSync(parentDir);
      const expected = resolve(join(resolvedParent, dirName)).toLowerCase();
      if (resolve(resolvedReal).toLowerCase() !== expected) {
        isSymlink = true;
      }
    }
  } catch {
    /* broken symlink or inaccessible target */
  }

  return { isSymlink, realPath, lstat: lst };
}

export function normalizeRepoUrl(rawRepo) {
  const s = typeof rawRepo === 'string' ? rawRepo : rawRepo && typeof rawRepo.url === 'string' ? rawRepo.url : '';
  if (!s) return '';
  let cleaned = s
    .trim()
    .replace(/[?#].*$/, '')
    .replace(/^git\+/, '')
    .replace(/^git:\/\/github\.com\//i, 'https://github.com/')
    .replace(/^ssh:\/\/git@github\.com\//i, 'https://github.com/')
    .replace(/^git@github\.com:/i, 'https://github.com/')
    .replace(/\.git$/i, '')
    .replace(/\/+$/, '');
  const ghMatch = /^https?:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)(?:\/.*)?$/i.exec(cleaned);
  if (ghMatch) {
    cleaned = `https://github.com/${ghMatch[1].toLowerCase()}/${ghMatch[2].toLowerCase()}`;
  } else {
    cleaned = cleaned.toLowerCase();
  }
  return cleaned;
}

const IGNORED_README_GH_OWNERS = new Set(['features', 'topics', 'settings', 'orgs', 'sponsors', 'marketplace']);

function resolveLocalPluginRepoUrl(fullDir, manifest, receipt) {
  const fromReceipt = normalizeRepoUrl(receipt?.repositoryUrl);
  if (receipt?.track === 'github-url' && fromReceipt) return fromReceipt;

  const fromRepo = normalizeRepoUrl(manifest?.repository);
  if (fromRepo) return fromRepo;

  if (fromReceipt) return fromReceipt;

  const fromHomepage = normalizeRepoUrl(manifest?.homepage);
  if (/^https:\/\/github\.com\/[^/]+\/[^/]+$/.test(fromHomepage)) {
    return fromHomepage;
  }

  const pkgPath = join(fullDir, 'package.json');
  if (existsSync(pkgPath)) {
    try {
      const pkg = parseJsonc(readFileSync(pkgPath, 'utf8'));
      const pkgRepo = normalizeRepoUrl(pkg?.repository);
      if (pkgRepo) return pkgRepo;
      const pkgHome = normalizeRepoUrl(pkg?.homepage);
      if (/^https:\/\/github\.com\/[^/]+\/[^/]+$/.test(pkgHome)) return pkgHome;
    } catch {
      /* ignore */
    }
  }

  if (!receipt) {
    const readmePath = join(fullDir, 'README.md');
    if (existsSync(readmePath)) {
      try {
        const head = readFileSync(readmePath, 'utf8').slice(0, 4096);
        const re = /https?:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)/gi;
        let m;
        while ((m = re.exec(head)) !== null) {
          const owner = m[1].toLowerCase();
          const repo = m[2].replace(/\.git$/i, '').toLowerCase();
          if (IGNORED_README_GH_OWNERS.has(owner) || !repo) continue;
          return `https://github.com/${owner}/${repo}`;
        }
      } catch {
        /* ignore */
      }
    }
  }

  return '';
}

function normalizeAuthorDisplay(rawAuthor) {
  if (typeof rawAuthor === 'string') return rawAuthor.trim();
  if (rawAuthor && typeof rawAuthor === 'object' && typeof rawAuthor.name === 'string') {
    return rawAuthor.name.trim();
  }
  return '';
}

export function readHostEnabledMapReadOnly(configDir) {
  const cfgPath = join(configDir, 'config.json');
  const enabledByDir = new Map();
  if (!existsSync(cfgPath)) return enabledByDir;
  try {
    const parsed = parseJsonc(readFileSync(cfgPath, 'utf8'));
    const pluginsSection = parsed?.plugins && typeof parsed.plugins === 'object' ? parsed.plugins : {};
    for (const [dir, entry] of Object.entries(pluginsSection)) {
      if (typeof entry === 'boolean') {
        enabledByDir.set(dir, entry);
      } else if (entry && typeof entry === 'object' && typeof entry.enabled === 'boolean') {
        enabledByDir.set(dir, entry.enabled);
      }
    }
  } catch {
    /* ignore unreadable or mid-write config.json */
  }
  return enabledByDir;
}

export function stripSourceComments(source, filePath = '') {
  const src = String(source || '');
  const relPath = String(filePath || '');
  if (/\.ps1$/i.test(relPath)) {
    return src.replace(/<#[\s\S]*?#>/g, '').replace(/^\s*#.*$/gm, '');
  }
  if (/\.(?:py|sh)$/i.test(relPath)) {
    return src.replace(/^\s*#.*$/gm, '');
  }
  if (/\.(?:cmd|bat)$/i.test(relPath)) {
    return src.replace(/^\s*(?:rem\b|::).*$/gim, '');
  }
  let out = '';
  let inSingle = false;
  let inDouble = false;
  let inTemplate = false;
  let inLineComment = false;
  let inBlockComment = false;
  let escaped = false;

  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    const next = src[i + 1];

    if (inLineComment) {
      if (ch === '\n') {
        inLineComment = false;
        out += ch;
      }
      continue;
    }
    if (inBlockComment) {
      if (ch === '*' && next === '/') {
        inBlockComment = false;
        out += ' ';
        i += 1;
      } else if (ch === '\n') {
        out += '\n';
      }
      continue;
    }
    if (inSingle) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === "'" || ch === '\n') inSingle = false;
      continue;
    }
    if (inDouble) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"' || ch === '\n') inDouble = false;
      continue;
    }
    if (inTemplate) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '`') inTemplate = false;
      continue;
    }

    if (ch === '/' && next === '/') {
      inLineComment = true;
      i += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      inBlockComment = true;
      i += 1;
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      out += ch;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      out += ch;
      continue;
    }
    if (ch === '`') {
      inTemplate = true;
      out += ch;
      continue;
    }
    out += ch;
  }
  return out;
}

function detectLocalHostEnhancementKinds(fullDir, dirName, manifestName, receipt) {
  const kinds = new Set();

  if (Array.isArray(receipt?.grantedCapabilities?.hostEnhancementKind)) {
    for (const k of receipt.grantedCapabilities.hostEnhancementKind) {
      if (k === 'cdp' || k === 'app-asar') kinds.add(k);
    }
  }

  // Never self-flag agy-market's own source code
  if (dirName === PLUGIN_ID || manifestName === PLUGIN_ID) {
    return [...kinds].sort();
  }

  function walk(curDir, depth) {
    if (depth > MAX_SCRIPT_SCAN_DEPTH || (kinds.has('cdp') && kinds.has('app-asar'))) return;
    let entries;
    try {
      entries = readdirSync(curDir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (kinds.has('cdp') && kinds.has('app-asar')) return;
      const full = join(curDir, entry);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (IGNORED_SCAN_DIRS.has(entry.toLowerCase())) continue;
        walk(full, depth + 1);
      } else if (st.isFile() && SCRIPT_EXT_RE.test(entry) && !NON_RUNTIME_TEST_FILE_RE.test(entry)) {
        if (st.size > MAX_SCRIPT_SCAN_BYTES) continue;
        try {
          const code = stripSourceComments(readFileSync(full, 'utf8'), entry);
          if (!kinds.has('cdp') && LOCAL_CDP_RE.test(code)) kinds.add('cdp');
          if (!kinds.has('app-asar') && LOCAL_ASAR_RE.test(code)) kinds.add('app-asar');
        } catch {
          /* ignore unreadable file */
        }
      }
    }
  }

  walk(fullDir, 0);
  return [...kinds].sort();
}

export function scanLocalPluginComponents(fullDir, dirName, manifestName, receipt) {
  // 1. Skills (`skills/*/SKILL.md`)
  const skills = [];
  const skillsDir = join(fullDir, 'skills');
  if (existsSync(skillsDir)) {
    try {
      for (const skillDir of readdirSync(skillsDir).sort()) {
        const skillMdPath = join(skillsDir, skillDir, 'SKILL.md');
        if (!existsSync(skillMdPath)) continue;
        let fmName = null;
        try {
          fmName = parseSkillFrontmatterName(readFileSync(skillMdPath, 'utf8'));
        } catch {
          fmName = null;
        }
        skills.push({
          dir: skillDir,
          name: fmName || skillDir,
          path: skillMdPath,
        });
      }
    } catch {
      /* ignore */
    }
  }

  // 2. Agents (`agents/*.md`)
  const agents = [];
  const agentEntries = [];
  const agentsDir = join(fullDir, 'agents');
  if (existsSync(agentsDir)) {
    try {
      for (const file of readdirSync(agentsDir).sort()) {
        if (!/\.md$/i.test(file)) continue;
        const full = join(agentsDir, file);
        let st;
        try {
          st = statSync(full);
        } catch {
          continue;
        }
        if (!st.isFile()) continue;
        const stem = file.replace(/\.md$/i, '');
        let fmName = null;
        try {
          fmName = parseSkillFrontmatterName(readFileSync(full, 'utf8'));
        } catch {
          fmName = null;
        }
        const resolvedName = fmName || stem;
        agents.push(resolvedName);
        agentEntries.push({ name: resolvedName, file: stem, path: full });
      }
    } catch {
      /* ignore */
    }
  }

  // 3. Rules (`rules/*.md`)
  let hasRules = false;
  let totalRuleBytes = 0;
  const rulesDir = join(fullDir, 'rules');
  if (existsSync(rulesDir)) {
    try {
      for (const file of readdirSync(rulesDir)) {
        if (!/\.md$/i.test(file)) continue;
        const full = join(rulesDir, file);
        try {
          const st = statSync(full);
          if (st.isFile()) {
            hasRules = true;
            totalRuleBytes += st.size;
          }
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* ignore */
    }
  }

  // 4. Sidecars (`sidecars/*/sidecar.json` or optional root `sidecars.json`)
  let hasSidecarUi = false;
  let hasSidecarPane = null;

  const inspectSidecarManifest = (sc, scFolder) => {
    if (!sc || typeof sc !== 'object') return;
    hasSidecarUi = true;
    const auxView = (sc?.ui_config?.views || []).find(
      (v) => v && v.entrypoint === 'SIDECAR_UI_ENTRYPOINT_AUX_PANE',
    );
    if (sc?.has_web_ui && auxView && !hasSidecarPane && scFolder) {
      const rawViewPath = String(auxView.path || '/');
      const viewPathClean = rawViewPath.replace(/^\/+/, '');
      hasSidecarPane = {
        sidecarFolder: scFolder,
        sidecarId: `${dirName}/${scFolder}`,
        viewPath: rawViewPath,
        title: auxView.title || sc.display_name || manifestName || dirName,
        uri: `sidecar://${dirName}/${scFolder}/${viewPathClean}`,
      };
    }
  };

  const sidecarsDir = join(fullDir, 'sidecars');
  if (existsSync(sidecarsDir)) {
    try {
      for (const scFolder of readdirSync(sidecarsDir).sort()) {
        const scJsonPath = join(sidecarsDir, scFolder, 'sidecar.json');
        if (!existsSync(scJsonPath)) continue;
        const sc = parseJsonc(readFileSync(scJsonPath, 'utf8'));
        inspectSidecarManifest(sc, scFolder);
      }
    } catch {
      /* ignore */
    }
  }

  // Fallback: optional root `sidecars.json` (array or `{ sidecars: [...] }` referencing relative subdirs/sidecar.json)
  const rootSidecarsJsonPath = join(fullDir, 'sidecars.json');
  if (!hasSidecarPane && existsSync(rootSidecarsJsonPath)) {
    try {
      const parsed = parseJsonc(readFileSync(rootSidecarsJsonPath, 'utf8'));
      const entries = Array.isArray(parsed)
        ? parsed
        : Array.isArray(parsed?.sidecars)
          ? parsed.sidecars
          : [];
      const absPluginRoot = resolve(fullDir);
      const isWithinPluginRoot = (target) =>
        target === absPluginRoot ||
        target.startsWith(`${absPluginRoot}\\`) ||
        target.startsWith(`${absPluginRoot}/`);

      for (const item of entries) {
        if (hasSidecarPane) break;
        if (typeof item === 'string') {
          const rel = item.trim();
          if (!rel) continue;
          const resolved = resolve(absPluginRoot, rel);
          if (!isWithinPluginRoot(resolved)) continue;
          const scJsonPath = resolved.toLowerCase().endsWith('.json') ? resolved : join(resolved, 'sidecar.json');
          if (!existsSync(scJsonPath)) continue;
          const sc = parseJsonc(readFileSync(scJsonPath, 'utf8'));
          const parentFolder = basename(dirname(scJsonPath));
          const folderName =
            parentFolder && resolve(dirname(scJsonPath)) !== absPluginRoot
              ? parentFolder
              : basename(scJsonPath, '.json');
          inspectSidecarManifest(sc, folderName);
        } else if (item && typeof item === 'object') {
          const relRef = String(
            item.sidecarJson || item.manifest || item.config || item.path || item.dir || item.folder || '',
          ).trim();
          if (relRef && !item.ui_config) {
            const resolved = resolve(absPluginRoot, relRef);
            if (!isWithinPluginRoot(resolved)) continue;
            const scJsonPath = resolved.toLowerCase().endsWith('.json') ? resolved : join(resolved, 'sidecar.json');
            if (!existsSync(scJsonPath)) continue;
            const sc = parseJsonc(readFileSync(scJsonPath, 'utf8'));
            const explicitFolder = String(item.sidecarFolder || item.folder || item.id || item.name || '').trim();
            const parentFolder = basename(dirname(scJsonPath));
            const folderName =
              explicitFolder ||
              (parentFolder && resolve(dirname(scJsonPath)) !== absPluginRoot
                ? parentFolder
                : basename(scJsonPath, '.json'));
            inspectSidecarManifest(sc, folderName);
          } else {
            const folderName = String(item.sidecarFolder || item.folder || item.id || item.name || '').trim();
            inspectSidecarManifest(item, folderName);
          }
        }
      }
    } catch {
      /* ignore */
    }
  }

  // 5. MCP Config (`mcp_config.json`)
  const mcpPath = join(fullDir, 'mcp_config.json');
  const hasMcp = existsSync(mcpPath);
  const mcpServerKeys = [];
  const mcpServers = [];
  const mcpRemoteDomains = new Set();
  let hasMcpStdio = false;
  let hasMcpRemote = false;

  if (hasMcp) {
    try {
      const parsed = parseJsonc(readFileSync(mcpPath, 'utf8'));
      const serversObj = parsed?.mcpServers && typeof parsed.mcpServers === 'object' ? parsed.mcpServers : {};
      for (const [serverKey, cfg] of Object.entries(serversObj)) {
        mcpServerKeys.push(serverKey);
        const namespaced = manifestName ? `${manifestName}_${serverKey}` : serverKey;
        mcpServers.push(namespaced);
        const remoteUrl = cfg?.serverUrl || cfg?.url || cfg?.httpUrl || '';
        if (typeof remoteUrl === 'string' && /^https?:\/\//i.test(remoteUrl)) {
          hasMcpRemote = true;
          try {
            mcpRemoteDomains.add(new URL(remoteUrl).hostname.toLowerCase());
          } catch {
            /* ignore invalid url */
          }
        }
        if (typeof cfg?.command === 'string' && cfg.command.trim()) {
          hasMcpStdio = true;
        }
      }
    } catch {
      /* ignore */
    }
  }

  // 6. Lifecycle Hooks (`hooks.json`)
  const hooksPath = join(fullDir, 'hooks.json');
  const hasHooks = existsSync(hooksPath);
  const hookEvents = new Set();
  if (hasHooks) {
    try {
      const parsed = parseJsonc(readFileSync(hooksPath, 'utf8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        for (const [topKey, topVal] of Object.entries(parsed)) {
          if (HOOK_META_KEYS.has(topKey)) continue;
          if (Array.isArray(topVal)) {
            hookEvents.add(topKey);
          } else if (topVal && typeof topVal === 'object') {
            if (topVal.enabled === false) continue;
            for (const [eventKey, eventVal] of Object.entries(topVal)) {
              if (HOOK_META_KEYS.has(eventKey)) continue;
              if (Array.isArray(eventVal)) hookEvents.add(eventKey);
            }
          }
        }
      }
    } catch {
      /* ignore */
    }
  }

  // 7. Host enhancement hints (CDP / app-asar)
  const hostEnhancementKind = detectLocalHostEnhancementKinds(fullDir, dirName, manifestName, receipt);

  // 8. Local Chinese README presence
  const hasLocalReadmeZh = LOCAL_ZH_README_CANDIDATES.some((rel) => existsSync(join(fullDir, rel)));

  // Assemble local capability profile
  const badges = [];
  const hasSkillsOrAgents = skills.length > 0 || agents.length > 0;
  const isPureDeclarative =
    hasSkillsOrAgents &&
    !hasRules &&
    !hasSidecarUi &&
    !hasMcpStdio &&
    !hasMcpRemote &&
    !hasHooks &&
    hostEnhancementKind.length === 0;

  if (isPureDeclarative) badges.push('declarative-only');
  if (hasRules) badges.push('global-rules');
  if (hasSidecarUi) badges.push('sidecar-ui');
  if (hasMcpStdio) badges.push('mcp-stdio');
  if (hasMcpRemote) badges.push('mcp-remote');
  if (hasHooks) badges.push('lifecycle-hooks');
  if (hostEnhancementKind.length > 0 || (receipt?.grantedCapabilities?.badges || []).includes('host-enhancement')) {
    badges.push('host-enhancement');
  }

  const capabilities = {
    badges: [...new Set(badges)],
    rulesEstimatedTokens: hasRules ? Math.ceil(totalRuleBytes / 4) : 0,
    mcpServers: mcpServers.sort(),
    mcpRemoteDomains: [...mcpRemoteDomains].sort(),
    hookEvents: [...hookEvents].sort(),
    hostEnhancementKind,
  };

  return {
    skills,
    agents,
    agentEntries,
    hasRules,
    hasSidecarUi,
    hasSidecarPane,
    hasMcp,
    mcpServerKeys,
    hasHooks,
    hostEnhancementKind,
    hasLocalReadmeZh,
    capabilities,
  };
}

function scanSinglePluginFolder(
  parentDir,
  dirName,
  scope,
  enabledByDir,
  { parkedByMarket = false, linkInfoOverride = null } = {},
) {
  const fullDir = join(parentDir, dirName);
  const { isSymlink, realPath, lstat: lst } =
    typeof linkInfoOverride === 'function'
      ? linkInfoOverride(parentDir, dirName) || isDirectorySymlinkOrJunction(parentDir, dirName)
      : isDirectorySymlinkOrJunction(parentDir, dirName);
  if (!lst) return null;
  if (!lst.isDirectory() && !isSymlink) return null;

  const manifestPath = join(fullDir, 'plugin.json');
  if (!existsSync(manifestPath)) return null;

  let manifest = { name: dirName };
  try {
    manifest = parseJsonc(readFileSync(manifestPath, 'utf8'));
  } catch {
    manifest = { name: dirName };
  }

  let receipt = null;
  const receiptPath = join(fullDir, '.agy-market-receipt.json');
  if (existsSync(receiptPath)) {
    try {
      receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
    } catch {
      receipt = null;
    }
  }

  const manifestName = String(manifest.name || dirName);
  const displayName = String(manifest.displayName || manifest.name || dirName);
  const components = scanLocalPluginComponents(fullDir, dirName, manifestName, receipt);
  if (components.hasSidecarPane && !components.hasSidecarPane.title) {
    components.hasSidecarPane.title = displayName;
  }

  const explicitEnabled = enabledByDir.get(dirName);
  const hostDisabled = explicitEnabled === false;
  const enabled = parkedByMarket ? false : explicitEnabled !== undefined ? explicitEnabled : manifest.disabled !== true;

  let toggleDisabledReason = '';
  if (dirName === PLUGIN_ID) {
    toggleDisabledReason = 'self';
  } else if (scope === 'workspace') {
    toggleDisabledReason = 'workspace';
  } else if (scope === 'builtin') {
    toggleDisabledReason = 'builtin';
  } else if (hostDisabled) {
    toggleDisabledReason = 'host-disabled';
  }
  const canToggle = scope === 'global' && dirName !== PLUGIN_ID && !hostDisabled;

  const uninstallDisabledReason =
    dirName === PLUGIN_ID
      ? 'self'
      : scope === 'workspace'
        ? 'workspace'
        : scope === 'builtin'
          ? 'builtin'
          : '';
  const canUninstall = scope === 'global' && dirName !== PLUGIN_ID;

  const activation = classifyActivationRequirement(components.capabilities);

  const hasGitDir = existsSync(join(fullDir, '.git'));
  const isGitManaged = Boolean(!receipt && hasGitDir);

  const receiptVersion = receipt?.installedVersion ? String(receipt.installedVersion).trim() : '';
  const manifestVersion = manifest.version ? String(manifest.version).trim() : '';
  const declaredVersion = manifestVersion;
  const hasDeclaredVersion = Boolean(receiptVersion || declaredVersion);
  const unmanagedReason = isGitManaged ? 'git-clone' : !receipt && !hasDeclaredVersion ? 'no-version' : null;
  const resolvedVersion =
    receiptVersion &&
    manifestVersion &&
    parseSemver(manifestVersion) &&
    parseSemver(receiptVersion) &&
    compareSemver(manifestVersion, receiptVersion) > 0
      ? manifestVersion
      : String(receipt?.installedVersion || manifest.version || '0.0.0');

  return {
    dir: dirName,
    path: fullDir,
    ...(isSymlink ? { realPath } : {}),
    scope, // 'global' | 'workspace' | 'builtin'
    isSymlink,
    isGitManaged,
    hasDeclaredVersion,
    unmanagedReason,
    name: manifestName,
    displayName,
    description: String(manifest.description || ''),
    version: resolvedVersion,
    author: normalizeAuthorDisplay(manifest.author),
    logo: typeof manifest.logo === 'string' ? manifest.logo.trim().replace(/\\/g, '/').replace(/^\.\/+/, '') : '',
    repositoryUrl: resolveLocalPluginRepoUrl(fullDir, manifest, receipt),
    enabled,
    parkedByMarket: Boolean(parkedByMarket),
    hostDisabled,
    canToggle,
    toggleDisabledReason,
    canUninstall,
    uninstallDisabledReason,
    hasMcp: components.hasMcp,
    mcpServerKeys: components.mcpServerKeys,
    hasHooks: components.hasHooks,
    hasRules: components.hasRules,
    skills: components.skills,
    agents: components.agents,
    agentEntries: components.agentEntries,
    hostEnhancementKind: components.hostEnhancementKind,
    hasLocalReadmeZh: components.hasLocalReadmeZh,
    capabilities: components.capabilities,
    activation,
    sidecarPane: components.hasSidecarPane,
    customizationUri: `customization://${dirName}`,
    receipt,
  };
}

/**
 * Scans global `~/.gemini/config/plugins/*`, optional parked `${dataDir}/disabled-plugins/*`,
 * active workspaces `.agents/plugins/*`, optional builtin plugins dir, and user `mcp_config.json`
 * without touching LS RPCs or mutating `config.json`.
 */
const localInventoryCache = new Map(); // cacheKey -> { cachedAtMs, signature, value }

export function invalidateLocalInventoryCache() {
  localInventoryCache.clear();
}

function statSignature(targetPath, useLstat = false) {
  try {
    const st = useLstat ? lstatSync(targetPath) : statSync(targetPath);
    return `${st.mtimeMs}:${st.size}:${st.isSymbolicLink?.() ? 1 : 0}`;
  } catch {
    return '-';
  }
}

function appendRootInventorySignature(parts, rootDir, label) {
  if (!rootDir || !existsSync(rootDir)) {
    parts.push(`${label}:0`);
    return;
  }
  parts.push(`${label}:${statSignature(rootDir)}`);
  let entries;
  try {
    entries = readdirSync(rootDir).sort();
  } catch {
    return;
  }
  for (const d of entries) {
    const full = join(rootDir, d);
    parts.push(
      d,
      statSignature(full, true),
      statSignature(join(full, 'plugin.json')),
      statSignature(join(full, '.agy-market-receipt.json')),
      statSignature(join(full, 'hooks.json')),
      statSignature(join(full, 'hooks', 'hooks.json')),
      statSignature(join(full, 'mcp_config.json')),
      statSignature(join(full, '.git')),
    );
  }
}

function computeInventorySignature({
  configDir,
  globalPluginsDir,
  disabledPluginsDir,
  workspaceRoots,
  builtinPluginsDir,
}) {
  const parts = [
    statSignature(join(configDir, 'config.json')),
    statSignature(join(configDir, 'plugins.json')),
    statSignature(join(configDir, 'mcp_config.json')),
  ];
  appendRootInventorySignature(parts, globalPluginsDir, 'g');
  appendRootInventorySignature(parts, disabledPluginsDir, 'd');
  for (const wsRoot of workspaceRoots) {
    appendRootInventorySignature(parts, join(wsRoot, '.agents', 'plugins'), `wa:${wsRoot}`);
    appendRootInventorySignature(parts, join(wsRoot, '.agent', 'plugins'), `wb:${wsRoot}`);
  }
  appendRootInventorySignature(parts, builtinPluginsDir, 'b');
  return parts.join('|');
}

export function scanLocalPluginInventory({
  configDir = resolveAntigravityConfigDir(),
  pluginsDir = '',
  dataDir = '',
  workspaceUris = [],
  builtinPluginsDir = '',
  linkInfoOverride = null,
  bypassCache = false,
} = {}) {
  const resolvedConfigDir = resolve(configDir);
  const globalPluginsDir = pluginsDir ? resolve(pluginsDir) : resolvePluginsDir(resolvedConfigDir);
  const disabledPluginsDir = dataDir ? resolveDisabledPluginsDir(dataDir) : '';
  const resolvedBuiltinDir = builtinPluginsDir ? resolve(builtinPluginsDir) : '';
  const workspaceRoots = [];
  for (const uri of workspaceUris || []) {
    const wsRoot = typeof uri === 'string' && uri.startsWith('file://') ? fileUriToLocalPath(uri) : uri;
    if (wsRoot) workspaceRoots.push(wsRoot);
  }

  const canCache = !bypassCache && typeof linkInfoOverride !== 'function';
  const cacheKey = canCache
    ? JSON.stringify([resolvedConfigDir, globalPluginsDir, disabledPluginsDir, workspaceRoots, resolvedBuiltinDir])
    : '';
  const nowMs = Date.now();
  let currentSig = '';
  if (canCache) {
    currentSig = computeInventorySignature({
      configDir: resolvedConfigDir,
      globalPluginsDir,
      disabledPluginsDir,
      workspaceRoots,
      builtinPluginsDir: resolvedBuiltinDir,
    });
    const hit = localInventoryCache.get(cacheKey);
    if (hit && nowMs - hit.cachedAtMs < LOCAL_INVENTORY_CACHE_TTL_MS && hit.signature === currentSig) {
      return {
        ...hit.value,
        installed: [...hit.value.installed],
        userMcpServerNames: new Set(hit.value.userMcpServerNames),
      };
    }
  }

  const enabledByDir = readHostEnabledMapReadOnly(resolvedConfigDir);
  const installed = [];
  const seenGlobalDirs = new Set();

  if (existsSync(globalPluginsDir)) {
    for (const d of readdirSync(globalPluginsDir).sort()) {
      const item = scanSinglePluginFolder(globalPluginsDir, d, 'global', enabledByDir, {
        parkedByMarket: false,
        linkInfoOverride,
      });
      if (item) {
        installed.push(item);
        seenGlobalDirs.add(d);
      }
    }
  }

  if (disabledPluginsDir && existsSync(disabledPluginsDir)) {
    for (const d of readdirSync(disabledPluginsDir).sort()) {
      if (seenGlobalDirs.has(d)) continue;
      const item = scanSinglePluginFolder(disabledPluginsDir, d, 'global', enabledByDir, { parkedByMarket: true });
      if (item) {
        installed.push(item);
        seenGlobalDirs.add(d);
      }
    }
  }

  for (const wsRoot of workspaceRoots) {
    for (const rel of ['.agents/plugins', '.agent/plugins']) {
      const wsPlugDir = join(wsRoot, rel);
      if (!existsSync(wsPlugDir)) continue;
      for (const d of readdirSync(wsPlugDir).sort()) {
        const item = scanSinglePluginFolder(wsPlugDir, d, 'workspace', enabledByDir, { parkedByMarket: false });
        if (item) installed.push(item);
      }
    }
  }

  if (resolvedBuiltinDir && existsSync(resolvedBuiltinDir)) {
    for (const d of readdirSync(resolvedBuiltinDir).sort()) {
      const item = scanSinglePluginFolder(resolvedBuiltinDir, d, 'builtin', enabledByDir, { parkedByMarket: false });
      if (item) installed.push(item);
    }
  }

  const userMcpServerNames = new Set();
  const userMcpPath = join(resolvedConfigDir, 'mcp_config.json');
  if (existsSync(userMcpPath)) {
    try {
      const mcp = parseJsonc(readFileSync(userMcpPath, 'utf8'));
      for (const k of Object.keys(mcp?.mcpServers || {})) userMcpServerNames.add(k);
    } catch {
      /* ignore */
    }
  }

  const result = {
    configDir: resolvedConfigDir,
    globalPluginsDir,
    disabledPluginsDir,
    installed,
    userMcpServerNames,
  };

  if (canCache) {
    if (localInventoryCache.size >= 16) {
      const oldestKey = localInventoryCache.keys().next().value;
      if (oldestKey !== undefined) localInventoryCache.delete(oldestKey);
    }
    localInventoryCache.set(cacheKey, {
      cachedAtMs: nowMs,
      signature: currentSig,
      value: {
        ...result,
        installed: [...installed],
        userMcpServerNames: new Set(userMcpServerNames),
      },
    });
  }

  return result;
}

/**
 * Resolves exact install target & collision strategy for `plugin` against `inventory`.
 * `conflictStrategy`: `'prompt'` (default) | `'isolate'` | `'replace'`
 */
export function resolveInstallPreflight(plugin, inventory, { conflictStrategy = 'prompt', preferredDir = '' } = {}) {
  const repoId = Number(plugin?.repository?.repositoryId || 0);
  const repoUrlNorm = normalizeRepoUrl(plugin?.repository?.url);
  const canonicalName = String(plugin.canonicalName || '').trim();
  if (
    !canonicalName ||
    canonicalName === '.' ||
    canonicalName === '..' ||
    canonicalName.includes('/') ||
    canonicalName.includes('\\') ||
    canonicalName.includes('..') ||
    /[\x00-\x1f<>:"|?*]/.test(canonicalName)
  ) {
    throw new Error(
      `ERR_INVALID_CANONICAL_NAME: Plugin "${plugin?.id || ''}" lacks a safe canonicalName ("${plugin?.canonicalName || ''}")`,
    );
  }
  const ownerFromId = String(plugin.id || '').includes('__') ? plugin.id.split('__')[0] : 'community';
  const scopedName = plugin.scopedName || toScopedPluginName(ownerFromId, canonicalName);

  // 1. Check if SAME plugin is already installed locally (active OR parked in `disabled-plugins/<dir>`)
  const sameSourceMatches = (inventory.installed || []).filter((loc) => {
    if (loc.scope !== 'global') return false;
    if (loc.receipt) {
      if (repoId > 0 && Number(loc.receipt.repositoryId || 0) > 0) {
        return loc.receipt.repositoryId === repoId && loc.receipt.id === plugin.id;
      }
      return loc.receipt.id === plugin.id;
    }
    if (repoUrlNorm && loc.repositoryUrl && loc.repositoryUrl === repoUrlNorm && loc.name === canonicalName) {
      return true;
    }
    return false;
  });
  const normPreferredDir = String(preferredDir || '').trim();
  const sameSource =
    (normPreferredDir && sameSourceMatches.find((loc) => loc.dir === normPreferredDir)) ||
    sameSourceMatches[0] ||
    null;

  if (sameSource) {
    const isScoped = Boolean(sameSource.receipt?.scopedRewriteApplied) || sameSource.dir === scopedName;
    const effectiveScopedName = sameSource.receipt?.effectivePluginName || sameSource.dir || scopedName;
    return {
      action: 'update',
      targetDir: sameSource.dir,
      effectivePluginName: isScoped ? effectiveScopedName : sameSource.name,
      applyScopedRewrite: isScoped,
      existingInstall: {
        ...sameSource,
        currentlyParked: Boolean(sameSource.parkedByMarket),
      },
      conflict: null,
    };
  }

  // 2. Track-2 Experimental plugins ALWAYS enforce Layer-2 `<owner>--<slug>` scoped isolation
  if (plugin.forceScopedInstall) {
    return {
      action: 'install-scoped',
      targetDir: scopedName,
      effectivePluginName: scopedName,
      applyScopedRewrite: true,
      existingInstall: null,
      conflict: null,
    };
  }

  // 3. Check for collision on `dir === canonicalName` OR `manifest.name === canonicalName` across global/workspace/builtin
  const conflicting = (inventory.installed || []).find(
    (loc) => loc.dir === canonicalName || loc.name === canonicalName,
  );

  if (!conflicting) {
    return {
      action: 'install-native',
      targetDir: canonicalName,
      effectivePluginName: canonicalName,
      applyScopedRewrite: false,
      existingInstall: null,
      conflict: null,
    };
  }

  const isForeignSelfCollision =
    (conflicting.dir === PLUGIN_ID || conflicting.name === PLUGIN_ID) && plugin.id !== SELF_CATALOG_ID;

  // 4. Foreign local/builtin collision detected!
  if (conflictStrategy === 'isolate') {
    return {
      action: 'install-scoped',
      targetDir: scopedName,
      effectivePluginName: scopedName,
      applyScopedRewrite: true,
      existingInstall: null,
      conflict: conflicting,
    };
  }

  if (conflictStrategy === 'replace') {
    if (isForeignSelfCollision) {
      throw new Error(
        `ERR_CANNOT_REPLACE_SELF: Foreign plugin "${plugin.id}" cannot overwrite "${PLUGIN_ID}"; choose isolated install (${scopedName}) instead`,
      );
    }
    if (conflicting.scope !== 'global') {
      throw new Error(
        `ERR_CANNOT_REPLACE_NON_GLOBAL: Conflicting plugin "${conflicting.dir}" has scope="${conflicting.scope}"; choose isolated install (${scopedName}) instead`,
      );
    }
    return {
      action: 'replace-local',
      targetDir: conflicting.dir,
      effectivePluginName: canonicalName,
      applyScopedRewrite: false,
      existingInstall: {
        ...conflicting,
        currentlyParked: Boolean(conflicting.parkedByMarket),
      },
      conflict: conflicting,
    };
  }

  const choices = ['isolate'];
  if (conflicting.scope === 'global' && !isForeignSelfCollision) choices.push('replace');

  return {
    action: 'conflict-prompt',
    targetDir: scopedName,
    effectivePluginName: scopedName,
    applyScopedRewrite: true,
    existingInstall: null,
    conflict: conflicting,
    scopedFallbackName: scopedName,
    choices,
  };
}

function escapeRegExp(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Applies Layer-2 `<owner>--<slug>` scoped rewrite inside `stagingBundleDir`:
 *   - Aligns `plugin.json.name = scopedName` and preserves original human title in `displayName`.
 *   - Rewrites `customization://<old>` and `sidecar://<old>/` protocol links in `.md` files.
 *   - Scans `.js`/`.mjs`/`.cjs`/`hooks.json` for hardcoded bare references and emits non-blocking compatibility notes.
 */
export function applyScopedIsolationRewrite(stagingBundleDir, { canonicalName, scopedName, fallbackDisplayName = '' }) {
  const absRoot = resolve(stagingBundleDir);
  const manifestPath = join(absRoot, 'plugin.json');
  const rawManifest = parseJsonc(readFileSync(manifestPath, 'utf8'));
  const oldName = String(rawManifest.name || canonicalName || '').trim();

  const nextManifest = sanitizeNativePluginManifest({
    ...rawManifest,
    name: scopedName,
    displayName: rawManifest.displayName || fallbackDisplayName || oldName,
  });
  // Never inject `"disabled": true` — preserve one-click immediate activation!
  delete nextManifest.disabled;

  writeFileSync(manifestPath, `${JSON.stringify(nextManifest, null, 2)}\n`, 'utf8');

  const compatibilityNotes = [];
  const oldTokens = [...new Set([oldName, canonicalName].filter(Boolean))];

  function walk(dir, relPrefix = '') {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const rel = relPrefix ? posix.join(relPrefix, entry) : entry;
      const st = statSync(full);
      if (st.isDirectory()) {
        walk(full, rel);
        continue;
      }
      if (!st.isFile()) continue;

      if (/\.md$/i.test(entry)) {
        let md = readFileSync(full, 'utf8');
        let changed = false;
        for (const tok of oldTokens) {
          const custRe = new RegExp(`customization://${escapeRegExp(tok)}(?=[)\\s"'\`]|$)`, 'g');
          const sideRe = new RegExp(`sidecar://${escapeRegExp(tok)}/`, 'g');
          const nextMd = md.replace(custRe, `customization://${scopedName}`).replace(sideRe, `sidecar://${scopedName}/`);
          if (nextMd !== md) {
            md = nextMd;
            changed = true;
          }
        }
        if (changed) writeFileSync(full, md, 'utf8');
      } else if (/\.(?:js|mjs|cjs)$/i.test(entry) || rel === 'hooks.json') {
        const src = readFileSync(full, 'utf8');
        for (const tok of oldTokens) {
          const hardRefRe = new RegExp(`(?:plugins|sidecar_data)[/\\\\]+${escapeRegExp(tok)}\\b`, 'i');
          if (hardRefRe.test(src)) {
            compatibilityNotes.push(
              `Scoped install (${scopedName}): "${rel}" references path "${tok}" directly; verify runtime behavior if paths are hardcoded.`,
            );
            break;
          }
        }
      }
    }
  }

  walk(absRoot);
  return { manifest: nextManifest, compatibilityNotes };
}
