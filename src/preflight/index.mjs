// Pure Read-Only Filesystem Preflight Collision Resolver & `<owner>--<slug>` Scoped Rewriter (`src/preflight/index.mjs`).
//
// Antigravity Host Redlines Enforced:
//   - NEVER writes `~/.gemini/config/config.json` (only parses read-only for `plugins.<dir>.enabled`).
//   - Aligns `<dir> === plugin.json.name === "<owner-lower>--<slug>"` when scoped isolation is applied.
//   - Rewrites `customization://` and `sidecar://` links in `.md` files and reports bare-name JS/hook compatibility notes.

import { existsSync, lstatSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, posix, resolve } from 'node:path';
import { toScopedPluginName } from '../shared/constants.mjs';
import { fileUriToLocalPath, resolveAntigravityConfigDir, resolvePluginsDir } from '../shared/paths.mjs';
import { parseJsonc, sanitizeNativePluginManifest } from '../shared/schemas.mjs';

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
  const fromRepo = normalizeRepoUrl(manifest?.repository);
  if (fromRepo) return fromRepo;

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

function scanSinglePluginFolder(parentDir, dirName, scope, enabledByDir) {
  const fullDir = join(parentDir, dirName);
  let lst;
  try {
    lst = lstatSync(fullDir);
  } catch {
    return null;
  }
  const isSymlink = lst.isSymbolicLink();
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

  let hasSidecarPane = null;
  const sidecarsDir = join(fullDir, 'sidecars');
  if (existsSync(sidecarsDir)) {
    try {
      for (const scFolder of readdirSync(sidecarsDir)) {
        const scJsonPath = join(sidecarsDir, scFolder, 'sidecar.json');
        if (!existsSync(scJsonPath)) continue;
        const sc = parseJsonc(readFileSync(scJsonPath, 'utf8'));
        const auxView = (sc?.ui_config?.views || []).find(
          (v) => v.entrypoint === 'SIDECAR_UI_ENTRYPOINT_AUX_PANE',
        );
        if (sc?.has_web_ui && auxView) {
          const viewPath = String(auxView.path || '/').replace(/^\/+/, '');
          hasSidecarPane = {
            sidecarFolder: scFolder,
            title: auxView.title || sc.display_name || manifest.displayName || manifest.name || dirName,
            uri: `sidecar://${dirName}/${scFolder}/${viewPath}`,
          };
          break;
        }
      }
    } catch {
      /* ignore */
    }
  }

  const hasMcp = existsSync(join(fullDir, 'mcp_config.json'));
  const explicitEnabled = enabledByDir.get(dirName);
  const enabled = explicitEnabled !== undefined ? explicitEnabled : manifest.disabled !== true;

  return {
    dir: dirName,
    path: fullDir,
    scope, // 'global' | 'workspace' | 'builtin'
    isSymlink,
    name: String(manifest.name || dirName),
    displayName: String(manifest.displayName || manifest.name || dirName),
    description: String(manifest.description || ''),
    version: String(receipt?.installedVersion || manifest.version || '0.0.0'),
    author: normalizeAuthorDisplay(manifest.author),
    logo: typeof manifest.logo === 'string' ? manifest.logo.trim().replace(/\\/g, '/').replace(/^\.\/+/, '') : '',
    repositoryUrl: resolveLocalPluginRepoUrl(fullDir, manifest, receipt),
    enabled,
    hasMcp,
    sidecarPane: hasSidecarPane,
    customizationUri: `customization://${dirName}`,
    receipt,
  };
}

/**
 * Scans global `~/.gemini/config/plugins/*`, active workspaces `.agents/plugins/*`,
 * optional builtin plugins dir, and user `mcp_config.json` without touching LS RPCs.
 */
export function scanLocalPluginInventory({
  configDir = resolveAntigravityConfigDir(),
  workspaceUris = [],
  builtinPluginsDir = '',
} = {}) {
  const enabledByDir = readHostEnabledMapReadOnly(configDir);
  const globalPluginsDir = resolvePluginsDir(configDir);
  const installed = [];

  if (existsSync(globalPluginsDir)) {
    for (const d of readdirSync(globalPluginsDir).sort()) {
      const item = scanSinglePluginFolder(globalPluginsDir, d, 'global', enabledByDir);
      if (item) installed.push(item);
    }
  }

  for (const uri of workspaceUris || []) {
    const wsRoot = typeof uri === 'string' && uri.startsWith('file://') ? fileUriToLocalPath(uri) : uri;
    if (!wsRoot) continue;
    for (const rel of ['.agents/plugins', '.agent/plugins']) {
      const wsPlugDir = join(wsRoot, rel);
      if (!existsSync(wsPlugDir)) continue;
      for (const d of readdirSync(wsPlugDir).sort()) {
        const item = scanSinglePluginFolder(wsPlugDir, d, 'workspace', enabledByDir);
        if (item) installed.push(item);
      }
    }
  }

  if (builtinPluginsDir && existsSync(builtinPluginsDir)) {
    for (const d of readdirSync(builtinPluginsDir).sort()) {
      const item = scanSinglePluginFolder(builtinPluginsDir, d, 'builtin', enabledByDir);
      if (item) installed.push(item);
    }
  }

  const userMcpServerNames = new Set();
  const userMcpPath = join(configDir, 'mcp_config.json');
  if (existsSync(userMcpPath)) {
    try {
      const mcp = parseJsonc(readFileSync(userMcpPath, 'utf8'));
      for (const k of Object.keys(mcp?.mcpServers || {})) userMcpServerNames.add(k);
    } catch {
      /* ignore */
    }
  }

  return {
    configDir,
    globalPluginsDir,
    installed,
    userMcpServerNames,
  };
}

/**
 * Resolves exact install target & collision strategy for `plugin` against `inventory`.
 * `conflictStrategy`: `'prompt'` (default) | `'isolate'` | `'replace'`
 */
export function resolveInstallPreflight(plugin, inventory, { conflictStrategy = 'prompt' } = {}) {
  const repoId = Number(plugin?.repository?.repositoryId || 0);
  const repoUrlNorm = normalizeRepoUrl(plugin?.repository?.url);
  const canonicalName = String(plugin.canonicalName || '').trim();
  const ownerFromId = String(plugin.id || '').includes('__') ? plugin.id.split('__')[0] : 'community';
  const scopedName = plugin.scopedName || toScopedPluginName(ownerFromId, canonicalName);

  // 1. Check if SAME plugin is already installed locally (by receipt repositoryId, receipt id, or matching repository URL)
  const sameSource = (inventory.installed || []).find((loc) => {
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

  if (sameSource) {
    const isScoped = Boolean(sameSource.receipt?.scopedRewriteApplied) || sameSource.dir === scopedName;
    return {
      action: 'update',
      targetDir: sameSource.dir,
      effectivePluginName: isScoped ? scopedName : sameSource.name,
      applyScopedRewrite: isScoped,
      existingInstall: sameSource,
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
      existingInstall: conflicting,
      conflict: conflicting,
    };
  }

  const choices = ['isolate'];
  if (conflicting.scope === 'global') choices.push('replace');

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
