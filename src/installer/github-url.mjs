// GitHub Full-URL Plugin Inspector, Zero-API Fallback Resolver & Two-Step Safe Installer (`src/installer/github-url.mjs`).
//
// Enforces all Antigravity host redlines and security gates:
//   - Strict hostname allowlist (`github.com`, `www.github.com`, `codeload.github.com`) against SSRF.
//   - Never leaks `Authorization` tokens to third-party `githubReleaseMirrorPrefix` proxies or cache files.
//   - Seamless 0-API fallback (`HEAD /releases/latest` redirect -> `info/refs` -> mirror/codeload HEAD archive
//     + 40-hex `commitSha` extracted from POSIX PAX global header `comment`) when GitHub API hits 403/429 rate limits.
//   - Hard-blocks symlinks/hardlinks, Zip-Slip path traversal, Unicode Tag/Bidi smuggling, `rules/*.md`
//     out-of-root `@[...](...)` exfiltration, and >24,000-byte rules.
//   - Exempts zero-dependency dynamic HTTP Sidecars (e.g. `view.path: "/"` backed by existing `server.mjs`/`main.mjs`).

import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { BUILTIN_AGENT_NAMES, BUILTIN_SKILL_NAMES, GENERIC_MCP_SERVER_KEYS } from '../preflight/conflicts.mjs';
import {
  normalizeRepoUrl,
  resolveInstallPreflight,
  scanLocalPluginComponents,
  scanLocalPluginInventory,
} from '../preflight/index.mjs';
import {
  GITHUB_API_BASE_URL,
  MAX_TARBALL_BYTES,
  NOMINATE_PLUGIN_ISSUE_BASE_URL,
  PLUGIN_ID,
  SELF_CATALOG_ID,
  SELF_REPO_URL,
  toScopedPluginName,
} from '../shared/constants.mjs';
import { resolveAntigravityConfigDir, resolveMarketDataDir } from '../shared/paths.mjs';
import { defaultProxyFetch } from '../shared/proxy-fetch.mjs';
import {
  computeCapabilityEscalation,
  parseJsonc,
  sanitizeNativePluginManifest,
  sanitizePrefs,
} from '../shared/schemas.mjs';
import { compareSemver, parseSemver } from '../shared/semver.mjs';
import {
  computeRateLimitResetMs,
  getGithubCacheDir,
  isRateLimitResponse,
  probeGithubGitRefs,
  probeGithubLatestReleaseRedirect,
  redactSecret,
} from '../updates/index.mjs';
import { isOfficialGithubTokenHost, streamUrlToFileAndHash } from './fetch-tarball.mjs';
import { installOrUpdateCatalogPlugin } from './index.mjs';
import { assertNoScopedSymlinks, inspectTarGzStream, validateSafeRelPath } from './tar-extract.mjs';

function resolveEffectiveFetch(fetchImpl) {
  return !fetchImpl || fetchImpl === fetch ? defaultProxyFetch : fetchImpl;
}

const MAX_INSPECT_TEXT_BYTES = 2 * 1024 * 1024;
const MAX_INSPECT_SCRIPT_BYTES = 512 * 1024;
const IGNORED_INSPECT_SCRIPT_DIR_RE = /(?:^|\/)(?:node_modules|\.git|test|tests|__tests__|docs|site|dist)\//i;

function shouldBufferInspectFile(relPath, byteSize = 0) {
  const norm = String(relPath || '').replace(/\\/g, '/');
  if (/(?:^|\/)(?:plugin\.json|agy-market\.json|package\.json|mcp_config\.json|hooks\.json|sidecar\.json|sidecars\.json)$/.test(norm)) {
    return byteSize <= MAX_INSPECT_TEXT_BYTES;
  }
  if (/(?:^|\/)readme(?:\.[^/]+)?\.md$/i.test(norm)) {
    return byteSize <= MAX_INSPECT_TEXT_BYTES;
  }
  if (/(?:^|\/)(?:skills\/[^/]+\/SKILL\.md|agents\/[^/]+\.md)$/i.test(norm)) {
    return byteSize <= MAX_INSPECT_TEXT_BYTES;
  }
  if (/(?:^|\/)rules\/[^/]+\.md$/i.test(norm)) {
    return byteSize <= MAX_RULE_FILE_BYTES;
  }
  if (/\.(?:mjs|cjs|js|ts|py|ps1|sh|cmd|bat)$/i.test(norm) && !IGNORED_INSPECT_SCRIPT_DIR_RE.test(norm)) {
    return byteSize <= MAX_INSPECT_SCRIPT_BYTES;
  }
  return false;
}

export const INSPECT_STAGING_TTL_MS = 15 * 60 * 1000; // 15 minutes
export const PUBLIC_REPO_PROBE_TIMEOUT_MS = 3_000; // 3 seconds
export const MAX_RULE_FILE_BYTES = 24_000; // Aligned with agy-market-catalog/scripts/lib/constants.mjs:9
export const INVISIBLE_SMUGGLING_RE = /[\u{E0000}-\u{E007F}\u202A-\u202E\u2066-\u2069]/u;

const DEFAULT_API_TIMEOUT_MS = 8_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ALLOWED_GITHUB_HOSTS = new Set(['github.com', 'www.github.com', 'codeload.github.com']);
const RESERVED_GITHUB_OWNERS = new Set([
  'features',
  'topics',
  'settings',
  'orgs',
  'sponsors',
  'marketplace',
  'explore',
  'issues',
  'pulls',
  'notifications',
  'search',
  'login',
  'signup',
  'about',
  'pricing',
  'apps',
  'enterprise',
  'collections',
  'events',
  'trending',
  'codespaces',
  'copilot',
  'security',
  'team',
  'solutions',
  'resources',
]);
const IGNORED_MANIFEST_PATH_RE = /(?:^|\/)(?:node_modules|\.git|test|tests|__tests__|fixtures|__fixtures__)\//i;
const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO_RE = /^[A-Za-z0-9._-]+$/;
const FULL_SHA_RE = /^[0-9a-f]{40}$/i;
const MAX_PREVIEW_README_CHARS = 64_000;
const CJK_HAN_RE = /[\u3400-\u4DBF\u4E00-\u9FFF]/;
const CJK_HAN_GLOBAL_RE = /[\u3400-\u4DBF\u4E00-\u9FFF]/g;
const LATIN_LETTER_GLOBAL_RE = /[A-Za-z]/g;

const ZH_README_CANDIDATES = [
  'README.zh-CN.md',
  'README_zh-CN.md',
  'README.zh.md',
  'README_zh.md',
  'docs/README.zh-CN.md',
  'docs/README.zh.md',
];
const EN_README_CANDIDATES = ['README.en.md', 'README.en-US.md', 'README_en.md', 'docs/README.en.md'];
const DEFAULT_README_CANDIDATES = ['README.md'];

const INTERPRETER_COMMANDS = new Set([
  'node',
  'node.exe',
  'python',
  'python3',
  'python.exe',
  'bun',
  'deno',
  'bash',
  'sh',
  'pwsh',
  'powershell',
  'powershell.exe',
]);

function normalizePluginRoot(rawRoot = '.') {
  const s = String(rawRoot || '.')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\/+/, '')
    .replace(/\/+$/, '');
  if (!s || s === '.') return '.';
  return validateSafeRelPath(s) || '.';
}

/**
 * Tier-0 Zero-PII public-repo check via unauthenticated `HEAD https://github.com/<owner>/<repo>`.
 * Never sends Authorization tokens; private repos (404 / 302 login redirect) or timeouts return `false`.
 */
export async function probeIsPublicGithubRepo(
  owner,
  repo,
  { fetchImpl = defaultProxyFetch, timeoutMs = PUBLIC_REPO_PROBE_TIMEOUT_MS } = {},
) {
  const activeFetch = resolveEffectiveFetch(fetchImpl);
  const cleanOwner = String(owner || '').trim();
  const cleanRepo = String(repo || '').trim();
  if (!OWNER_RE.test(cleanOwner) || !cleanRepo || cleanRepo === '.' || cleanRepo === '..' || !REPO_RE.test(cleanRepo)) {
    return false;
  }
  const repoUrl = `https://github.com/${encodeURIComponent(cleanOwner)}/${encodeURIComponent(cleanRepo)}`;
  try {
    const res = await activeFetch(repoUrl, {
      method: 'HEAD',
      headers: { 'User-Agent': 'agy-market-installer/1.0' },
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res?.status === 200;
  } catch {
    return false;
  }
}

/**
 * Builds the pre-filled Tier-0 community nomination GitHub Issue URL.
 * Strictly contains `owner/repo` and `pluginRoot` ONLY — zero user, machine, path, or token PII.
 */
export function buildPluginNominationUrl({ owner, repo, pluginRoot = '.' } = {}) {
  const cleanOwner = String(owner || '').trim();
  const cleanRepo = String(repo || '').trim();
  if (!OWNER_RE.test(cleanOwner) || !cleanRepo || cleanRepo === '.' || cleanRepo === '..' || !REPO_RE.test(cleanRepo)) {
    return '';
  }
  const repoSlug = `${cleanOwner}/${cleanRepo}`;
  const normRoot = normalizePluginRoot(pluginRoot);
  const titleSuffix = normRoot !== '.' ? `${repoSlug} (${normRoot})` : repoSlug;
  const params = new URLSearchParams();
  params.set('template', 'nominate-plugin.yml');
  params.set('labels', 'community-discovery');
  params.set('title', `[Nominate] ${titleSuffix}`);
  params.set('repo', repoSlug);
  params.set('plugin_root', normRoot);
  return `${NOMINATE_PLUGIN_ISSUE_BASE_URL}?${params.toString()}`;
}

function encodePathSegments(rawPath) {
  return String(rawPath || '')
    .split('/')
    .filter(Boolean)
    .map((seg) => encodeURIComponent(seg))
    .join('/');
}

function toSubpathSlug(pluginRoot) {
  return String(pluginRoot || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function deriveSyntheticPluginId(ownerLower, repoLower, pluginRoot) {
  const norm = normalizePluginRoot(pluginRoot);
  if (norm === '.') return `${ownerLower}__${repoLower}`;
  const slug = toSubpathSlug(norm);
  return slug ? `${ownerLower}__${repoLower}--${slug}` : `${ownerLower}__${repoLower}`;
}

function deriveSafeCanonicalName(rawName, fallbackSlug) {
  const trimmed = String(rawName || '').trim();
  if (
    trimmed &&
    trimmed !== '.' &&
    trimmed !== '..' &&
    !trimmed.includes('/') &&
    !trimmed.includes('\\') &&
    !trimmed.includes('..') &&
    !/[\x00-\x1f<>:"|?*\s]/.test(trimmed)
  ) {
    return trimmed;
  }
  const slug = (trimmed || fallbackSlug || 'plugin')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'plugin';
}

function normalizeAuthorDisplay(rawAuthor) {
  if (typeof rawAuthor === 'string') return rawAuthor.trim();
  if (rawAuthor && typeof rawAuthor === 'object' && typeof rawAuthor.name === 'string') {
    return rawAuthor.name.trim();
  }
  return '';
}

function stripMarkdownCodeExamples(mdText) {
  return String(mdText || '')
    .replace(/^ {0,3}(`{3,}|~{3,})[^\r\n]*\r?\n[\s\S]*?^ {0,3}\1[ \t]*$/gm, '')
    .replace(/`[^`\r\n]+`/g, '');
}

export function checkRulesExfiltration(relPath, contentText) {
  const proseOnly = stripMarkdownCodeExamples(contentText);
  const atIncludeRe = /@\[[^\]]*\]\(([^)]+)\)/g;
  let match;
  while ((match = atIncludeRe.exec(proseOnly)) !== null) {
    const rawTarget = match[1].trim();
    if (!rawTarget || /^https?:\/\//i.test(rawTarget)) continue;
    if (
      /(?:^|[\\/])\.\.(?:[\\/]|$)/.test(rawTarget) ||
      rawTarget.startsWith('~/') ||
      rawTarget.startsWith('~\\') ||
      rawTarget.startsWith('/') ||
      rawTarget.startsWith('\\') ||
      /^[A-Za-z]:/.test(rawTarget) ||
      /^file:/i.test(rawTarget) ||
      /\$[A-Za-z_{]|%[A-Za-z_]+%/.test(rawTarget)
    ) {
      throw new Error(
        `ERR_RULES_PATH_EXFILTRATION: "${relPath}" references out-of-root path "${rawTarget}" via @[...](...)`,
      );
    }
  }
}

function assertLocalStaticSafety(scopedFiles, scopedFileSizes = null) {
  const seen = new Set();
  for (const relPath of scopedFiles.keys()) {
    seen.add(relPath);
  }
  if (scopedFileSizes) {
    for (const relPath of scopedFileSizes.keys()) {
      seen.add(relPath);
    }
  }

  for (const relPath of seen) {
    const buf = scopedFiles.get(relPath) || Buffer.alloc(0);
    const actualBytes = scopedFileSizes?.get(relPath) ?? buf.length;
    if (/^rules\/[^/]+\.md$/i.test(relPath)) {
      if (actualBytes > MAX_RULE_FILE_BYTES) {
        throw new Error(
          `ERR_RULE_SIZE_EXCEEDED: "${relPath}" is ${actualBytes} bytes (Antigravity ceiling is ${MAX_RULE_FILE_BYTES} bytes)`,
        );
      }
      if (actualBytes > 0 && buf.length === 0) {
        throw new Error(
          `ERR_RULE_SIZE_EXCEEDED: "${relPath}" (${actualBytes} bytes) was omitted from inspection buffer`,
        );
      }
      const text = buf.toString('utf8');
      if (INVISIBLE_SMUGGLING_RE.test(text)) {
        throw new Error(
          `ERR_INVISIBLE_PROMPT_INJECTION: Disallowed Unicode Tag or bidi override characters in "${relPath}"`,
        );
      }
      checkRulesExfiltration(relPath, text);
    } else if (/^skills\/[^/]+\/SKILL\.md$/.test(relPath) || /^agents\/[^/]+\.md$/i.test(relPath)) {
      if (actualBytes > 0 && buf.length === 0) {
        throw new Error(
          `ERR_INVISIBLE_PROMPT_INJECTION: "${relPath}" (${actualBytes} bytes) exceeded text inspection buffer ceiling (${MAX_INSPECT_TEXT_BYTES} bytes)`,
        );
      }
      const text = buf.toString('utf8');
      if (INVISIBLE_SMUGGLING_RE.test(text)) {
        throw new Error(
          `ERR_INVISIBLE_PROMPT_INJECTION: Disallowed Unicode Tag or bidi override characters in "${relPath}"`,
        );
      }
    }
  }
}

/**
 * Checks whether a sidecar archive has missing explicit static HTML entrypoints, missing backend
 * entrypoint scripts, or unbundled runtime npm dependencies.
 * Crucially EXEMPTS zero-dependency dynamic HTTP Sidecars (where `view.path` is `/` or a non-`.html`
 * route and the declared backend script such as `server.mjs`/`main.mjs` exists in the archive).
 */
export function checkPrebuiltWarnings(scopedFiles) {
  const warnings = [];

  for (const [relPath, buf] of scopedFiles.entries()) {
    const m = /^sidecars\/([^/]+)\/sidecar\.json$/.exec(relPath);
    if (!m) continue;
    const sidecarId = m[1];
    let parsed = null;
    try {
      parsed = parseJsonc(buf.toString('utf8'));
    } catch {
      warnings.push(`Sidecar "${sidecarId}" 的 sidecar.json 无法解析，请检查格式。`);
      continue;
    }
    if (!parsed || typeof parsed !== 'object') continue;

    const cmdBase = String(parsed.command || '')
      .trim()
      .split(/[\\/]/)
      .pop()
      .toLowerCase();
    const argsList = Array.isArray(parsed.args) ? parsed.args.map((a) => String(a || '').trim()) : [];

    // Locate declared script entrypoint when using a script runtime (e.g. `node server.mjs`)
    let scriptEntryExists = true;
    let firstScriptArg = '';
    if (INTERPRETER_COMMANDS.has(cmdBase) && argsList.length > 0) {
      firstScriptArg = argsList.find((a) => a && !a.startsWith('-')) || '';
      if (firstScriptArg && !firstScriptArg.includes('${')) {
        const cleanArg = firstScriptArg.replace(/\\/g, '/').replace(/^\.\/+/, '');
        const scriptCandidates = [
          `sidecars/${sidecarId}/${cleanArg}`,
          cleanArg,
        ];
        scriptEntryExists = scriptCandidates.some((c) => scopedFiles.has(c));
        if (!scriptEntryExists) {
          warnings.push(
            `Sidecar "${sidecarId}" 声明的后端脚本入口 "${firstScriptArg}" 未在归档中找到，可能需要使用 Release 预构建包或本地构建。`,
          );
        }
      }
    }

    const views = Array.isArray(parsed?.ui_config?.views) ? parsed.ui_config.views : [];
    for (const view of views) {
      if (!view || typeof view.path !== 'string') continue;
      const cleanView = view.path.split('?')[0].split('#')[0].replace(/^\/+/, '');
      const isExplicitHtmlView = /\.(?:html|htm)$/i.test(cleanView);
      if (!isExplicitHtmlView) {
        // Dynamic HTTP Sidecar route (e.g. `/` or `/dashboard`): exempt when backend script exists!
        continue;
      }
      const htmlCandidates = [`sidecars/${sidecarId}/${cleanView}`, cleanView];
      if (!htmlCandidates.some((c) => scopedFiles.has(c))) {
        warnings.push(
          `Sidecar "${sidecarId}" 声明的静态界面 "${view.path}" 未在归档中找到，建议优先使用作者发布的 Release 预构建压缩包。`,
        );
      }
    }
  }

  const pkgBuf = scopedFiles.get('package.json');
  if (pkgBuf) {
    try {
      const pkg = JSON.parse(pkgBuf.toString('utf8'));
      const deps = pkg?.dependencies && typeof pkg.dependencies === 'object' ? Object.keys(pkg.dependencies) : [];
      if (deps.length > 0) {
        let hasBundledNodeModules = false;
        for (const k of scopedFiles.keys()) {
          if (k.startsWith('node_modules/')) {
            hasBundledNodeModules = true;
            break;
          }
        }
        if (!hasBundledNodeModules) {
          warnings.push(
            `package.json 声明了运行时依赖 (${deps.slice(0, 6).join(', ')}${deps.length > 6 ? '…' : ''})，但归档未包含 node_modules；若插件未预打包，安装后可能需按作者说明安装依赖或改用 Release 预构建包。`,
          );
        }
      }
    } catch {
      /* ignore non-standard package.json */
    }
  }

  return warnings;
}

function classifySecurityError(err, repoUrl) {
  const raw = String(err?.message || err || '');
  if (raw.includes('ERR_TAR_SYMLINK_FORBIDDEN')) {
    return {
      ok: false,
      status: 'SECURITY_BLOCKED',
      reasonCode: 'ERR_TAR_SYMLINK_FORBIDDEN',
      reasonZh: '该归档包含符号链接或硬链接（Windows 下 Antigravity 会跳过符号链接且存在路径逃逸风险），已按安全策略拦截安装。',
      reasonEn: `Archive contains forbidden symlink/hardlink entries and was blocked (${raw}).`,
      hintsZh: ['请检查上游仓库是否包含软链接文件，或联系作者提供不含符号链接的 Release 归档。'],
      hintsEn: ['Check whether the upstream repository contains symlinks or request a clean release tarball.'],
      fileOverview: [],
      repoUrl,
    };
  }
  if (
    raw.includes('ERR_TAR_PATH_TRAVERSAL') ||
    raw.includes('ERR_TAR_UNSAFE_PATH') ||
    raw.includes('ERR_TAR_ESCAPE')
  ) {
    return {
      ok: false,
      status: 'SECURITY_BLOCKED',
      reasonCode: 'ERR_TAR_PATH_TRAVERSAL',
      reasonZh: '归档包含非法路径穿越（`..` 或绝对路径），存在 Zip-Slip 安全风险，已拦截安装。',
      reasonEn: `Archive contains unsafe path traversal entries and was blocked (${raw}).`,
      hintsZh: ['该归档结构不安全，建议勿安装来源不明的压缩包。'],
      hintsEn: ['Do not install archives containing parent directory traversal or absolute paths.'],
      fileOverview: [],
      repoUrl,
    };
  }
  if (raw.includes('ERR_RULES_PATH_EXFILTRATION')) {
    return {
      ok: false,
      status: 'SECURITY_BLOCKED',
      reasonCode: 'ERR_RULES_PATH_EXFILTRATION',
      reasonZh: '检测到 rules/*.md 存在越界本地文件引用（`@[...](../...)` / 绝对路径 / 家目录引用），已拦截安装。',
      reasonEn: `Blocked potential local-file exfiltration in rules/*.md (${raw}).`,
      hintsZh: ['Antigravity 规则文件仅允许引用插件目录内部相对路径，禁止访问宿主敏感文件。'],
      hintsEn: ['Plugin rules may only reference files inside the plugin root directory.'],
      fileOverview: [],
      repoUrl,
    };
  }
  if (raw.includes('ERR_INVISIBLE_PROMPT_INJECTION')) {
    return {
      ok: false,
      status: 'SECURITY_BLOCKED',
      reasonCode: 'ERR_INVISIBLE_PROMPT_INJECTION',
      reasonZh: '检测到规则或技能文档中包含不可见 Unicode Tag / Bidi 控制字符（潜在隐藏提示词注入），已拦截安装。',
      reasonEn: `Blocked hidden Unicode Tag or Bidi override smuggling characters (${raw}).`,
      hintsZh: ['出于安全防护，包含不可见控制字符的提示词文件不允许直接安装。'],
      hintsEn: ['Documents containing hidden Unicode Tag or bidirectional override characters are blocked.'],
      fileOverview: [],
      repoUrl,
    };
  }
  if (raw.includes('ERR_RULE_SIZE_EXCEEDED')) {
    return {
      ok: false,
      status: 'SECURITY_BLOCKED',
      reasonCode: 'ERR_RULE_SIZE_EXCEEDED',
      reasonZh: `检测到 rules/*.md 单文件超过 ${MAX_RULE_FILE_BYTES} 字节安全上限，已拦截安装。`,
      reasonEn: `Blocked oversized rules/*.md exceeding ${MAX_RULE_FILE_BYTES} bytes (${raw}).`,
      hintsZh: ['请提醒插件作者拆分过大的常驻规则文件，控制在 24,000 字节以内。'],
      hintsEn: ['Each rules/*.md file must stay within the 24,000-byte ceiling.'],
      fileOverview: [],
      repoUrl,
    };
  }
  return null;
}

/**
 * Parses and strictly allowlists a full GitHub plugin URL (SSRF-safe).
 * Supports repo homepage, `/releases`, `/releases/latest`, `/releases/tag/<tag>`,
 * `/releases/download/<tag>/<asset>.tar.gz|.tgz`, `/tree/<ref>[/<subpath...>]`,
 * `/blob/<ref>/[<subpath>/]plugin.json`, `/commit/<sha>`, `/archive/...tar.gz|.zip`,
 * and `codeload.github.com/<owner>/<repo>/tar.gz/<ref>`.
 */
export function parseGithubPluginUrl(rawUrl) {
  const inputUrl = String(rawUrl || '').trim();
  if (!inputUrl) {
    throw new Error('ERR_EMPTY_URL: 请输入有效的 GitHub 插件链接。');
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(inputUrl);
  } catch {
    throw new Error(`ERR_INVALID_URL: 无法解析链接 "${inputUrl}"，请粘贴完整的 https://github.com/... 地址。`);
  }

  if (parsedUrl.protocol !== 'https:' && parsedUrl.protocol !== 'http:') {
    throw new Error(`ERR_UNSUPPORTED_URL_HOST: 仅支持 https:// GitHub 链接，拒绝协议 "${parsedUrl.protocol}"。`);
  }

  const host = parsedUrl.hostname.toLowerCase();
  if (!ALLOWED_GITHUB_HOSTS.has(host)) {
    throw new Error(
      `ERR_UNSUPPORTED_URL_HOST: 仅支持 github.com 与 codeload.github.com 域名，已拒绝 "${parsedUrl.hostname}"。`,
    );
  }

  const segments = parsedUrl.pathname
    .split('/')
    .map((s) => s.trim())
    .filter(Boolean);

  if (segments.length < 2) {
    throw new Error('ERR_INVALID_GITHUB_REPO_URL: 链接缺少 <owner>/<repo> 仓库路径。');
  }

  const owner = decodeURIComponent(segments[0]);
  const ownerLower = owner.toLowerCase();
  if (!OWNER_RE.test(owner) || RESERVED_GITHUB_OWNERS.has(ownerLower)) {
    throw new Error(`ERR_INVALID_GITHUB_OWNER: 非法或保留的 GitHub 仓库所有者路径 "${owner}"。`);
  }

  const repoRaw = decodeURIComponent(segments[1]);
  const repo = repoRaw.replace(/\.git$/i, '');
  const repoLower = repo.toLowerCase();
  if (!repo || repo === '.' || repo === '..' || !REPO_RE.test(repo)) {
    throw new Error(`ERR_INVALID_GITHUB_REPO: 非法的 GitHub 仓库名称 "${repoRaw}"。`);
  }

  const normalizedRepoUrl = `https://github.com/${owner}/${repo}`;

  // 1. `codeload.github.com/<owner>/<repo>/tar.gz/<ref...>` (or `/zip/<ref...>` auto-rewritten)
  if (host === 'codeload.github.com') {
    if (segments.length < 4) {
      throw new Error('ERR_INVALID_CODELOAD_URL: codeload 链接格式无效，应包含 /tar.gz/<ref>。');
    }
    const fmt = segments[2].toLowerCase();
    if (fmt !== 'tar.gz' && fmt !== 'legacy.tar.gz' && fmt !== 'zip') {
      throw new Error(`ERR_UNSUPPORTED_ARCHIVE_FORMAT: codeload 归档类型 "${segments[2]}" 不受支持。`);
    }
    const refSegments = segments.slice(3).map((s) => decodeURIComponent(s));
    const refRaw = refSegments.join('/');
    const cleanRef = refRaw.replace(/^refs\/(?:heads|tags)\//i, '');
    const refType = refRaw.startsWith('refs/tags/')
      ? 'tag'
      : refRaw.startsWith('refs/heads/')
        ? 'branch'
        : FULL_SHA_RE.test(cleanRef)
          ? 'commit'
          : 'branch';
    const directTarballUrl = `https://codeload.github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/tar.gz/${encodePathSegments(refRaw)}`;
    return {
      inputUrl,
      normalizedRepoUrl,
      owner,
      ownerLower,
      repo,
      repoLower,
      kind: 'archive',
      ref: cleanRef,
      refType,
      pluginRoot: '.',
      rawRestSegments: [],
      directTarballUrl,
      assetName: '',
      rewrittenFromZip: fmt === 'zip',
    };
  }

  // 2. Repository root: `https://github.com/<owner>/<repo>`
  if (segments.length === 2) {
    return {
      inputUrl,
      normalizedRepoUrl,
      owner,
      ownerLower,
      repo,
      repoLower,
      kind: 'repo',
      ref: '',
      refType: 'auto',
      pluginRoot: '.',
      rawRestSegments: [],
      directTarballUrl: '',
      assetName: '',
      rewrittenFromZip: false,
    };
  }

  const section = segments[2].toLowerCase();

  // 3. Releases: `/releases`, `/releases/latest`, `/releases/tag/<tag>`, `/releases/download/<tag>/<asset>`
  if (section === 'releases') {
    if (segments.length === 3 || (segments.length === 4 && segments[3].toLowerCase() === 'latest')) {
      return {
        inputUrl,
        normalizedRepoUrl,
        owner,
        ownerLower,
        repo,
        repoLower,
        kind: 'release-latest',
        ref: '',
        refType: 'release',
        pluginRoot: '.',
        rawRestSegments: [],
        directTarballUrl: '',
        assetName: '',
        rewrittenFromZip: false,
      };
    }
    if (segments[3].toLowerCase() === 'tag' && segments.length >= 5) {
      const tag = segments.slice(4).map((s) => decodeURIComponent(s)).join('/');
      return {
        inputUrl,
        normalizedRepoUrl,
        owner,
        ownerLower,
        repo,
        repoLower,
        kind: 'release-tag',
        ref: tag,
        refType: 'tag',
        pluginRoot: '.',
        rawRestSegments: [],
        directTarballUrl: '',
        assetName: '',
        rewrittenFromZip: false,
      };
    }
    if (segments[3].toLowerCase() === 'download' && segments.length >= 6) {
      const tag = decodeURIComponent(segments[4]);
      const assetSegs = segments.slice(5).map((s) => decodeURIComponent(s));
      const assetName = assetSegs.join('/');
      if (/\.zip$/i.test(assetName)) {
        throw new Error(
          `ERR_UNSUPPORTED_ARCHIVE_FORMAT: Release 附件 "${assetName}" 为 .zip 格式，暂不支持直接安装 .zip Release 附件；请改粘贴仓库主页链接 (${normalizedRepoUrl}) 或 .tar.gz 附件链接。`,
        );
      }
      if (!/\.(?:tar\.gz|tgz)$/i.test(assetName)) {
        throw new Error(
          `ERR_UNSUPPORTED_ARCHIVE_FORMAT: Release 附件 "${assetName}" 不是 .tar.gz / .tgz 归档文件；请粘贴仓库主页链接或 .tar.gz 链接。`,
        );
      }
      const directTarballUrl = `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/releases/download/${encodeURIComponent(tag)}/${encodePathSegments(assetName)}`;
      return {
        inputUrl,
        normalizedRepoUrl,
        owner,
        ownerLower,
        repo,
        repoLower,
        kind: 'release-asset',
        ref: tag,
        refType: 'asset',
        pluginRoot: '.',
        rawRestSegments: [],
        directTarballUrl,
        assetName,
        rewrittenFromZip: false,
      };
    }
    throw new Error(`ERR_UNSUPPORTED_GITHUB_URL_PATH: 不支持的 Releases 链接格式 "${parsedUrl.pathname}"。`);
  }

  // 4. Tree: `/tree/<ref>[/<subpath...>]`
  if (section === 'tree' && segments.length >= 4) {
    const rawRestSegments = segments.slice(3).map((s) => decodeURIComponent(s));
    const ref = rawRestSegments[0];
    const subParts = rawRestSegments.slice(1);
    const pluginRoot = subParts.length > 0 ? normalizePluginRoot(subParts.join('/')) : '.';
    return {
      inputUrl,
      normalizedRepoUrl,
      owner,
      ownerLower,
      repo,
      repoLower,
      kind: 'tree',
      ref,
      refType: FULL_SHA_RE.test(ref) ? 'commit' : 'branch',
      pluginRoot,
      rawRestSegments,
      directTarballUrl: '',
      assetName: '',
      rewrittenFromZip: false,
    };
  }

  // 5. Blob manifest link: `/blob/<ref>/[<subpath>/]plugin.json` (also `.antigravity-plugin/plugin.json`)
  if (section === 'blob' && segments.length >= 5) {
    const rest = segments.slice(3).map((s) => decodeURIComponent(s));
    const lastSeg = rest[rest.length - 1];
    if (lastSeg.toLowerCase() !== 'plugin.json') {
      throw new Error(
        `ERR_UNSUPPORTED_GITHUB_URL_PATH: 暂不支持单文件链接 "${lastSeg}"，请粘贴仓库主页、目录 (/tree/...) 或 plugin.json 文件链接。`,
      );
    }
    const dirParts = rest.slice(0, -1);
    if (dirParts.length >= 2 && dirParts[dirParts.length - 1] === '.antigravity-plugin') {
      dirParts.pop();
    }
    const ref = dirParts[0];
    const subParts = dirParts.slice(1);
    const pluginRoot = subParts.length > 0 ? normalizePluginRoot(subParts.join('/')) : '.';
    return {
      inputUrl,
      normalizedRepoUrl,
      owner,
      ownerLower,
      repo,
      repoLower,
      kind: 'tree',
      ref,
      refType: FULL_SHA_RE.test(ref) ? 'commit' : 'branch',
      pluginRoot,
      rawRestSegments: dirParts,
      directTarballUrl: '',
      assetName: '',
      rewrittenFromZip: false,
    };
  }

  // 6. Commit link: `/commit/<sha>`
  if (section === 'commit' && segments.length >= 4 && /^[0-9a-f]{7,40}$/i.test(segments[3])) {
    const sha = segments[3];
    return {
      inputUrl,
      normalizedRepoUrl,
      owner,
      ownerLower,
      repo,
      repoLower,
      kind: 'tree',
      ref: sha,
      refType: 'commit',
      pluginRoot: '.',
      rawRestSegments: [sha],
      directTarballUrl: '',
      assetName: '',
      rewrittenFromZip: false,
    };
  }

  // 7. Archive link: `/archive/...tar.gz` (or `/archive/...zip` auto-rewritten to `.tar.gz`)
  if (section === 'archive' && segments.length >= 4) {
    const rawArchiveRest = segments.slice(3).map((s) => decodeURIComponent(s)).join('/');
    let archiveRest = rawArchiveRest;
    let rewrittenFromZip = false;
    if (/\.zip$/i.test(archiveRest)) {
      archiveRest = archiveRest.replace(/\.zip$/i, '.tar.gz');
      rewrittenFromZip = true;
    }
    if (!/\.(?:tar\.gz|tgz)$/i.test(archiveRest)) {
      throw new Error(`ERR_UNSUPPORTED_ARCHIVE_FORMAT: 归档链接 "${rawArchiveRest}" 不是 .tar.gz/.tgz 格式。`);
    }
    const stripped = archiveRest.replace(/\.(?:tar\.gz|tgz)$/i, '');
    const cleanRef = stripped.replace(/^refs\/(?:heads|tags)\//i, '');
    const refType = stripped.startsWith('refs/tags/')
      ? 'tag'
      : stripped.startsWith('refs/heads/')
        ? 'branch'
        : FULL_SHA_RE.test(cleanRef)
          ? 'commit'
          : 'branch';
    const directTarballUrl = `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/archive/${encodePathSegments(archiveRest)}`;
    return {
      inputUrl,
      normalizedRepoUrl,
      owner,
      ownerLower,
      repo,
      repoLower,
      kind: 'archive',
      ref: cleanRef,
      refType,
      pluginRoot: '.',
      rawRestSegments: [],
      directTarballUrl,
      assetName: '',
      rewrittenFromZip,
    };
  }

  throw new Error(
    `ERR_UNSUPPORTED_GITHUB_URL_PATH: 不支持的 GitHub 路径 "${parsedUrl.pathname}"，请粘贴仓库主页、/tree/<分支>/<子目录>、/releases/tag/<标签> 或 .tar.gz 归档链接。`,
  );
}

function readRateLimitFile(dataDir) {
  if (!dataDir) return null;
  const p = join(getGithubCacheDir(dataDir), '_ratelimit.json');
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function writeRateLimitFile(dataDir, { resetAtMs, authenticated, nowMs }) {
  if (!dataDir) return;
  try {
    const p = join(getGithubCacheDir(dataDir), '_ratelimit.json');
    writeFileSync(
      p,
      `${JSON.stringify(
        {
          schemaVersion: 1,
          resetAtMs,
          authenticated: Boolean(authenticated),
          recordedAt: new Date(nowMs).toISOString(),
        },
        null,
        2,
      )}\n`,
      'utf8',
    );
  } catch {
    /* non-fatal */
  }
}

function isRateLimitCooldownActive(dataDir, { nowMs, authenticated }) {
  const state = readRateLimitFile(dataDir);
  if (!state || !Number.isFinite(state.resetAtMs)) return false;
  if (!state.authenticated && authenticated) return false;
  return nowMs < state.resetAtMs;
}

function buildGithubApiHeaders(token = '') {
  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'agy-market-installer/1.0',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

function pickReleaseTarballAsset(releaseJson) {
  const assets = Array.isArray(releaseJson?.assets) ? releaseJson.assets : [];
  const tarAssets = assets.filter(
    (a) =>
      a &&
      typeof a.browser_download_url === 'string' &&
      /\.(?:tar\.gz|tgz)$/i.test(String(a.name || a.browser_download_url)),
  );
  if (tarAssets.length === 0) return null;

  const platformTokens = [
    'darwin',
    'macos',
    'osx',
    'apple',
    'linux',
    'win32',
    'windows',
    'mingw',
    'msvc',
    'amd64',
    'x86_64',
    'x64',
    'arm64',
    'aarch64',
  ];
  const isPlatformSpecific = (name) => {
    const lower = String(name || '').toLowerCase();
    return platformTokens.some((tok) => new RegExp(`(?:^|[^a-z0-9])${tok}(?:$|[^a-z0-9])`).test(lower));
  };

  // Prefer platform-agnostic `.tar.gz` plugin bundle first
  const universal = tarAssets.find((a) => !isPlatformSpecific(a.name));
  if (universal) return universal;

  // Otherwise match current host OS/arch only (never silently download macOS binary on Windows)
  const osPattern =
    process.platform === 'win32'
      ? /(?:win32|windows|msvc|mingw)/i
      : process.platform === 'darwin'
        ? /(?:darwin|macos|osx|apple)/i
        : /linux/i;
  const archPattern = process.arch === 'arm64' ? /(?:arm64|aarch64)/i : /(?:x64|x86_64|amd64)/i;
  const exactPlatform = tarAssets.find((a) => osPattern.test(a.name) && archPattern.test(a.name));
  if (exactPlatform) return exactPlatform;
  const osOnly = tarAssets.find((a) => osPattern.test(a.name));
  return osOnly || null;
}

function appendMirroredAndDirect(list, rawGithubUrl, { mirrorPrefix = '', directChannel = 'direct', codeloadUrl = '' } = {}) {
  if (mirrorPrefix && /^https:\/\/github\.com\//i.test(rawGithubUrl)) {
    const normPrefix = mirrorPrefix.endsWith('/') ? mirrorPrefix : `${mirrorPrefix}/`;
    list.push({
      url: `${normPrefix}${rawGithubUrl}`,
      channel: 'github-mirror',
      canonicalUrl: rawGithubUrl,
      sendAuth: false,
    });
  }
  list.push({
    url: rawGithubUrl,
    channel: directChannel,
    canonicalUrl: rawGithubUrl,
    sendAuth: isOfficialGithubTokenHost(rawGithubUrl),
  });
  if (codeloadUrl) {
    list.push({
      url: codeloadUrl,
      channel: 'codeload',
      canonicalUrl: codeloadUrl,
      sendAuth: isOfficialGithubTokenHost(codeloadUrl),
    });
  }
}

function dedupeCandidates(candidates) {
  const seen = new Set();
  const out = [];
  for (const c of candidates) {
    if (!c?.url || seen.has(c.url)) continue;
    seen.add(c.url);
    out.push(c);
  }
  return out;
}

function buildTagCandidates(owner, repo, tagName, { mirrorPrefix = '' } = {}) {
  const list = [];
  const o = encodeURIComponent(owner);
  const r = encodeURIComponent(repo);
  const t = encodePathSegments(tagName);
  const ghUrl = `https://github.com/${o}/${r}/archive/refs/tags/${t}.tar.gz`;
  const codeloadUrl = `https://codeload.github.com/${o}/${r}/tar.gz/refs/tags/${t}`;
  appendMirroredAndDirect(list, ghUrl, { mirrorPrefix, directChannel: 'direct', codeloadUrl });
  return dedupeCandidates(list);
}

function buildHeadFallbackCandidates(owner, repo, { branch = '', mirrorPrefix = '' } = {}) {
  const list = [];
  const o = encodeURIComponent(owner);
  const r = encodeURIComponent(repo);
  if (branch && branch !== 'HEAD') {
    const b = encodePathSegments(branch);
    const ghBranch = `https://github.com/${o}/${r}/archive/refs/heads/${b}.tar.gz`;
    const codeloadBranch = `https://codeload.github.com/${o}/${r}/tar.gz/refs/heads/${b}`;
    appendMirroredAndDirect(list, ghBranch, { mirrorPrefix, directChannel: 'direct', codeloadUrl: codeloadBranch });
  }
  const ghHead = `https://github.com/${o}/${r}/archive/HEAD.tar.gz`;
  const codeloadHead = `https://codeload.github.com/${o}/${r}/tar.gz/HEAD`;
  if (mirrorPrefix) {
    const normPrefix = mirrorPrefix.endsWith('/') ? mirrorPrefix : `${mirrorPrefix}/`;
    list.push({
      url: `${normPrefix}${ghHead}`,
      channel: 'github-mirror',
      canonicalUrl: ghHead,
      sendAuth: false,
    });
  }
  list.push({
    url: codeloadHead,
    channel: 'codeload',
    canonicalUrl: codeloadHead,
    sendAuth: true,
  });
  list.push({
    url: ghHead,
    channel: 'direct',
    canonicalUrl: ghHead,
    sendAuth: true,
  });
  for (const fallbackBranch of ['main', 'master']) {
    if (fallbackBranch === branch) continue;
    const codeloadUrl = `https://codeload.github.com/${o}/${r}/tar.gz/refs/heads/${fallbackBranch}`;
    list.push({
      url: codeloadUrl,
      channel: 'codeload',
      canonicalUrl: codeloadUrl,
      sendAuth: true,
    });
  }
  return dedupeCandidates(list);
}

function buildTreeRefCandidates(owner, repo, ref, { mirrorPrefix = '' } = {}) {
  const list = [];
  const o = encodeURIComponent(owner);
  const r = encodeURIComponent(repo);
  if (FULL_SHA_RE.test(ref)) {
    const ghUrl = `https://github.com/${o}/${r}/archive/${encodeURIComponent(ref)}.tar.gz`;
    const codeloadUrl = `https://codeload.github.com/${o}/${r}/tar.gz/${encodeURIComponent(ref)}`;
    appendMirroredAndDirect(list, ghUrl, { mirrorPrefix, directChannel: 'direct', codeloadUrl });
    return dedupeCandidates(list);
  }
  const encodedRef = encodePathSegments(ref);
  const ghArchive = `https://github.com/${o}/${r}/archive/${encodedRef}.tar.gz`;
  const codeloadHead = `https://codeload.github.com/${o}/${r}/tar.gz/refs/heads/${encodedRef}`;
  const codeloadTag = `https://codeload.github.com/${o}/${r}/tar.gz/refs/tags/${encodedRef}`;
  const codeloadRaw = `https://codeload.github.com/${o}/${r}/tar.gz/${encodedRef}`;
  appendMirroredAndDirect(list, ghArchive, { mirrorPrefix, directChannel: 'direct', codeloadUrl: codeloadHead });
  list.push({ url: codeloadTag, channel: 'codeload', canonicalUrl: codeloadTag, sendAuth: true });
  list.push({ url: codeloadRaw, channel: 'codeload', canonicalUrl: codeloadRaw, sendAuth: true });
  return dedupeCandidates(list);
}

/**
 * Resolves ordered download candidate attempts for a parsed GitHub URL, using REST API when
 * available and seamlessly degrading to zero-API-quota `HEAD /releases/latest` -> `info/refs` ->
 * mirror/codeload HEAD archive fallback on 403/429 rate limits or cooldown.
 */
export async function resolveGithubArchiveCandidates(
  parsed,
  {
    dataDir = '',
    prefs = {},
    fetchImpl = defaultProxyFetch,
    githubApiBaseUrl = GITHUB_API_BASE_URL,
    timeoutMs = DEFAULT_API_TIMEOUT_MS,
    nowMs = Date.now(),
  } = {},
) {
  const activeFetch = resolveEffectiveFetch(fetchImpl);
  const cleanPrefs = sanitizePrefs(prefs);
  const token = cleanPrefs.githubToken;
  const mirrorPrefix = cleanPrefs.githubReleaseMirrorPrefix;
  const authenticated = Boolean(token);
  const apiBase = String(githubApiBaseUrl || GITHUB_API_BASE_URL).replace(/\/+$/, '');
  const { owner, repo, normalizedRepoUrl } = parsed;
  const o = encodeURIComponent(owner);
  const r = encodeURIComponent(repo);

  const meta = {
    owner,
    repo,
    repoUrl: normalizedRepoUrl,
    repositoryId: 0,
    ownerId: 0,
    stars: 0,
    repoDescription: '',
    defaultBranch: '',
    ref: parsed.ref || '',
    refType: parsed.refType || 'auto',
    gitTag: null,
    commitSha: FULL_SHA_RE.test(parsed.ref || '') ? parsed.ref.toLowerCase() : '',
    rateLimitedFallback: false,
  };

  // Tier 0: Direct release asset or archive URL -> 0 API calls
  if (parsed.kind === 'release-asset') {
    const candidates = [];
    appendMirroredAndDirect(candidates, parsed.directTarballUrl, {
      mirrorPrefix,
      directChannel: 'release-asset',
    });
    meta.gitTag = parsed.ref || null;
    meta.ref = parsed.ref || '';
    meta.refType = 'asset';
    return {
      meta,
      attempts: [{ ref: meta.ref, pluginRoot: parsed.pluginRoot || '.', candidates: dedupeCandidates(candidates) }],
    };
  }

  if (parsed.kind === 'archive') {
    const candidates = [];
    if (parsed.directTarballUrl.startsWith('https://codeload.github.com/')) {
      if (mirrorPrefix && parsed.ref) {
        const ghEquiv = `https://github.com/${o}/${r}/archive/${encodePathSegments(parsed.ref)}.tar.gz`;
        const normPrefix = mirrorPrefix.endsWith('/') ? mirrorPrefix : `${mirrorPrefix}/`;
        candidates.push({
          url: `${normPrefix}${ghEquiv}`,
          channel: 'github-mirror',
          canonicalUrl: ghEquiv,
          sendAuth: false,
        });
      }
      candidates.push({
        url: parsed.directTarballUrl,
        channel: 'codeload',
        canonicalUrl: parsed.directTarballUrl,
        sendAuth: true,
      });
    } else {
      appendMirroredAndDirect(candidates, parsed.directTarballUrl, { mirrorPrefix, directChannel: 'archive' });
    }
    if (parsed.refType === 'tag' && parsed.ref) {
      meta.gitTag = parsed.ref;
    }
    return {
      meta,
      attempts: [{ ref: meta.ref, pluginRoot: parsed.pluginRoot || '.', candidates: dedupeCandidates(candidates) }],
    };
  }

  // Tier 1: Tree / Blob / Commit URL -> 0 API calls, with progressive slash-branch fallback
  if (parsed.kind === 'tree') {
    const rest = Array.isArray(parsed.rawRestSegments) && parsed.rawRestSegments.length > 0
      ? parsed.rawRestSegments
      : [parsed.ref];
    const maxJoin = Math.min(3, rest.length);
    const attempts = [];
    for (let k = 1; k <= maxJoin; k += 1) {
      const candRef = rest.slice(0, k).join('/');
      const subSegs = rest.slice(k);
      const candPluginRoot = subSegs.length > 0 ? normalizePluginRoot(subSegs.join('/')) : '.';
      attempts.push({
        ref: candRef,
        pluginRoot: candPluginRoot,
        candidates: buildTreeRefCandidates(owner, repo, candRef, { mirrorPrefix }),
      });
    }
    return { meta, attempts };
  }

  const inCooldown = isRateLimitCooldownActive(dataDir, { nowMs, authenticated });

  // Tier 2: Release Tag URL
  if (parsed.kind === 'release-tag') {
    const candidates = [];
    meta.gitTag = parsed.ref;
    meta.ref = parsed.ref;
    meta.refType = 'tag';

    if (!inCooldown) {
      try {
        const res = await activeFetch(`${apiBase}/repos/${o}/${r}/releases/tags/${encodeURIComponent(parsed.ref)}`, {
          headers: buildGithubApiHeaders(token),
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (res.status === 200) {
          const rel = await res.json();
          meta.refType = 'release';
          const asset = pickReleaseTarballAsset(rel);
          if (asset?.browser_download_url) {
            appendMirroredAndDirect(candidates, asset.browser_download_url, {
              mirrorPrefix,
              directChannel: 'release-asset',
            });
          }
        } else if (res.status === 403 || res.status === 429) {
          const bodyText = await res.text().catch(() => '');
          if (isRateLimitResponse(res, bodyText)) {
            meta.rateLimitedFallback = true;
            writeRateLimitFile(dataDir, {
              resetAtMs: computeRateLimitResetMs(res, nowMs),
              authenticated,
              nowMs,
            });
          }
        }
      } catch {
        /* fall through to zero-API tag archive */
      }
    } else {
      meta.rateLimitedFallback = true;
    }

    candidates.push(...buildTagCandidates(owner, repo, parsed.ref, { mirrorPrefix }));
    return {
      meta,
      attempts: [{ ref: parsed.ref, pluginRoot: '.', candidates: dedupeCandidates(candidates) }],
    };
  }

  // Tier 3: Repo homepage or `/releases` / `/releases/latest`
  const candidates = [];
  let rateLimited = inCooldown;

  if (!rateLimited) {
    // 3a. Repo metadata
    try {
      const repoRes = await activeFetch(`${apiBase}/repos/${o}/${r}`, {
        headers: buildGithubApiHeaders(token),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (repoRes.status === 200) {
        const repoJson = await repoRes.json();
        meta.repositoryId = Number(repoJson?.id || 0);
        meta.ownerId = Number(repoJson?.owner?.id || 0);
        meta.stars = Number(repoJson?.stargazers_count || 0);
        meta.defaultBranch = String(repoJson?.default_branch || '').trim();
        meta.repoDescription = String(repoJson?.description || '').trim();
      } else if (repoRes.status === 404) {
        throw new Error(
          `ERR_GITHUB_REPO_NOT_FOUND: GitHub 仓库 "${owner}/${repo}" 不存在或为私有仓库（若为私有仓库请先在设置中配置 GitHub Token）。`,
        );
      } else if (repoRes.status === 403 || repoRes.status === 429) {
        const bodyText = await repoRes.text().catch(() => '');
        if (isRateLimitResponse(repoRes, bodyText)) {
          rateLimited = true;
          meta.rateLimitedFallback = true;
          writeRateLimitFile(dataDir, {
            resetAtMs: computeRateLimitResetMs(repoRes, nowMs),
            authenticated,
            nowMs,
          });
        }
      }
    } catch (err) {
      if (String(err?.message || '').includes('ERR_GITHUB_REPO_NOT_FOUND')) {
        throw err;
      }
      /* network blip on API: degrade to zero-API fallback below */
      rateLimited = true;
      meta.rateLimitedFallback = true;
    }
  } else {
    meta.rateLimitedFallback = true;
  }

  if (!rateLimited) {
    // 3b. Latest stable release
    let foundRelease = false;
    try {
      const relRes = await activeFetch(`${apiBase}/repos/${o}/${r}/releases/latest`, {
        headers: buildGithubApiHeaders(token),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (relRes.status === 200) {
        const rel = await relRes.json();
        const tagName = String(rel?.tag_name || '').trim();
        // On repo root URLs, ignore per-subpackage prefixed Monorepo releases (e.g. `pkg-v1.0.0`)
        // so full-repo inspection surfaces all Monorepo candidates; explicit `/releases/latest` stays allowed.
        const releaseSemver = parseSemver(tagName);
        const isRepoLevelRelease =
          parsed.kind !== 'repo' || Boolean(releaseSemver && releaseSemver.prerelease.length === 0);
        if (tagName && !rel?.draft && !rel?.prerelease && isRepoLevelRelease) {
          foundRelease = true;
          meta.gitTag = tagName;
          meta.ref = tagName;
          meta.refType = 'release';
          const asset = pickReleaseTarballAsset(rel);
          if (asset?.browser_download_url) {
            appendMirroredAndDirect(candidates, asset.browser_download_url, {
              mirrorPrefix,
              directChannel: 'release-asset',
            });
          }
          candidates.push(...buildTagCandidates(owner, repo, tagName, { mirrorPrefix }));
        }
      } else if (relRes.status === 403 || relRes.status === 429) {
        const bodyText = await relRes.text().catch(() => '');
        if (isRateLimitResponse(relRes, bodyText)) {
          rateLimited = true;
          meta.rateLimitedFallback = true;
          writeRateLimitFile(dataDir, {
            resetAtMs: computeRateLimitResetMs(relRes, nowMs),
            authenticated,
            nowMs,
          });
        }
      }
    } catch {
      /* continue to tags/branch */
    }

    // 3c. Highest SemVer tag when repo has no Release (e.g. huiyiyichen/agy-preview)
    if (!foundRelease && !rateLimited) {
      let foundTag = false;
      try {
        const tagsRes = await activeFetch(`${apiBase}/repos/${o}/${r}/tags?per_page=30`, {
          headers: buildGithubApiHeaders(token),
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (tagsRes.status === 200) {
          const rawTags = await tagsRes.json();
          let best = null;
          for (const t of Array.isArray(rawTags) ? rawTags : []) {
            const tagName = String(t?.name || '').trim();
            const sem = parseSemver(tagName);
            if (!sem || sem.prerelease.length > 0) continue;
            if (!best || compareSemver(sem.version, best.version) > 0) {
              best = { version: sem.version, tagName, sha: String(t?.commit?.sha || '') };
            }
          }
          if (best) {
            foundTag = true;
            meta.gitTag = best.tagName;
            meta.ref = best.tagName;
            meta.refType = 'tag';
            if (FULL_SHA_RE.test(best.sha)) meta.commitSha = best.sha.toLowerCase();
            candidates.push(...buildTagCandidates(owner, repo, best.tagName, { mirrorPrefix }));
          }
        } else if (tagsRes.status === 403 || tagsRes.status === 429) {
          const bodyText = await tagsRes.text().catch(() => '');
          if (isRateLimitResponse(tagsRes, bodyText)) {
            rateLimited = true;
            meta.rateLimitedFallback = true;
            writeRateLimitFile(dataDir, {
              resetAtMs: computeRateLimitResetMs(tagsRes, nowMs),
              authenticated,
              nowMs,
            });
          }
        }
      } catch {
        /* continue to default branch */
      }

      // 3d. Default branch archive when repo has neither Release nor SemVer Tag (e.g. zou172866/agy-cmd)
      if (!foundTag && !rateLimited) {
        const branch = meta.defaultBranch || 'HEAD';
        meta.gitTag = null;
        meta.ref = branch;
        meta.refType = 'branch';
        candidates.push(...buildHeadFallbackCandidates(owner, repo, { branch, mirrorPrefix }));
      }
    }
  }

  // Zero-API-Quota Fallback Path (when API is 403/429 rate-limited, in cooldown, or yielded no candidates)
  if (candidates.length === 0) {
    meta.rateLimitedFallback = true;
    const redirectHit = await probeGithubLatestReleaseRedirect({ owner, repo, fetchImpl: activeFetch, timeoutMs });
    if (redirectHit?.tagName) {
      meta.gitTag = redirectHit.tagName;
      meta.ref = redirectHit.tagName;
      meta.refType = 'release';
      candidates.push(...buildTagCandidates(owner, repo, redirectHit.tagName, { mirrorPrefix }));
    } else {
      const gitRefs = await probeGithubGitRefs({ owner, repo, fetchImpl: activeFetch, timeoutMs });
      if (gitRefs?.defaultBranch && !meta.defaultBranch) {
        meta.defaultBranch = gitRefs.defaultBranch;
      }
      if (gitRefs?.highestSemverTag?.tagName) {
        meta.gitTag = gitRefs.highestSemverTag.tagName;
        meta.ref = gitRefs.highestSemverTag.tagName;
        meta.refType = 'tag';
        if (FULL_SHA_RE.test(gitRefs.highestSemverTag.commitSha || '')) {
          meta.commitSha = gitRefs.highestSemverTag.commitSha.toLowerCase();
        }
        candidates.push(...buildTagCandidates(owner, repo, gitRefs.highestSemverTag.tagName, { mirrorPrefix }));
      } else {
        const branch = meta.defaultBranch || 'HEAD';
        meta.gitTag = null;
        meta.ref = branch;
        meta.refType = 'branch';
        if (FULL_SHA_RE.test(gitRefs?.headSha || '')) {
          meta.commitSha = gitRefs.headSha.toLowerCase();
        }
        candidates.push(...buildHeadFallbackCandidates(owner, repo, { branch, mirrorPrefix }));
      }
    }
  }

  return {
    meta,
    attempts: [{ ref: meta.ref || 'HEAD', pluginRoot: '.', candidates: dedupeCandidates(candidates) }],
  };
}

function inferBranchFromArchiveMeta({ repo, strippedTopDir = '', contentDisposition = '' }) {
  const repoPrefix = `${String(repo || '').toLowerCase()}-`;
  const extractSuffix = (raw) => {
    const clean = String(raw || '')
      .trim()
      .replace(/^["']|["']$/g, '')
      .replace(/\.(?:tar\.gz|tgz)$/i, '');
    if (!clean) return '';
    if (clean.toLowerCase().startsWith(repoPrefix)) {
      const suffix = clean.slice(repoPrefix.length).trim();
      if (suffix && !FULL_SHA_RE.test(suffix)) return suffix;
    }
    return '';
  };

  const cdMatch = /filename\*?=(?:UTF-8'')?["']?([^"';\r\n]+)["']?/i.exec(contentDisposition);
  if (cdMatch && cdMatch[1]) {
    const fromCd = extractSuffix(decodeURIComponent(cdMatch[1]));
    if (fromCd) return fromCd;
  }
  return extractSuffix(strippedTopDir);
}

function extractScopedFiles(allFilesMap, pluginRoot = '.') {
  const norm = normalizePluginRoot(pluginRoot);
  if (norm === '.') return new Map(allFilesMap);
  const prefix = `${norm}/`;
  const scoped = new Map();
  for (const [p, buf] of allFilesMap.entries()) {
    if (p.startsWith(prefix)) {
      scoped.set(p.slice(prefix.length), buf);
    }
  }
  return scoped;
}

function isPredominantlyChinese(text) {
  const s = String(text || '');
  const cjkCount = (s.match(CJK_HAN_GLOBAL_RE) || []).length;
  if (cjkCount === 0) return false;
  const latinCount = (s.match(LATIN_LETTER_GLOBAL_RE) || []).length;
  if (latinCount === 0) return true;
  return cjkCount >= 10 && cjkCount * 4 >= latinCount;
}

function findReadmeCandidate(scopedFiles, rootFiles, candidates) {
  const maps = rootFiles && rootFiles !== scopedFiles ? [scopedFiles, rootFiles] : [scopedFiles];
  for (const filesMap of maps) {
    if (!filesMap) continue;
    let lowerMap = null;
    for (const candidate of candidates) {
      if (filesMap.has(candidate)) return filesMap.get(candidate);
      if (!lowerMap) {
        lowerMap = new Map();
        for (const [k, v] of filesMap.entries()) {
          const lower = k.toLowerCase();
          if (!lowerMap.has(lower)) lowerMap.set(lower, v);
        }
      }
      const matched = lowerMap.get(candidate.toLowerCase());
      if (matched) return matched;
    }
  }
  return null;
}

function extractPreviewReadmes(scopedFiles, rootFiles) {
  const decode = (buf) => (buf ? buf.toString('utf8').replace(/^\uFEFF/, '').slice(0, MAX_PREVIEW_README_CHARS) : '');
  const defaultReadme = decode(findReadmeCandidate(scopedFiles, rootFiles, DEFAULT_README_CANDIDATES));
  const explicitZh = decode(findReadmeCandidate(scopedFiles, rootFiles, ZH_README_CANDIDATES));
  const explicitEn = decode(findReadmeCandidate(scopedFiles, rootFiles, EN_README_CANDIDATES));

  const rootDefaultReadme =
    rootFiles && rootFiles !== scopedFiles ? decode(findReadmeCandidate(rootFiles, null, DEFAULT_README_CANDIDATES)) : '';

  const defaultHasCjk = CJK_HAN_RE.test(defaultReadme);
  const defaultMostlyZh = isPredominantlyChinese(defaultReadme);

  let readmeZhMarkdown = explicitZh || (defaultHasCjk ? defaultReadme : '');
  if (!readmeZhMarkdown && rootDefaultReadme && CJK_HAN_RE.test(rootDefaultReadme)) {
    // Support single-subdir repos (e.g. Lumidarin/agy-capsule) where Chinese README sits at repo root
    readmeZhMarkdown = rootDefaultReadme;
  }

  let readmeEnMarkdown = explicitEn;
  if (!readmeEnMarkdown && defaultReadme) {
    if (!defaultHasCjk || (explicitZh && !defaultMostlyZh)) {
      readmeEnMarkdown = defaultReadme;
    }
  }
  const readmeMarkdown = defaultReadme || explicitEn || explicitZh || rootDefaultReadme || '';
  return { readmeMarkdown, readmeZhMarkdown, readmeEnMarkdown };
}

function summarizeCandidateComponents(scopedFiles) {
  let hasSkills = false;
  let hasAgents = false;
  let hasRules = false;
  let hasSidecar = false;
  let hasMcp = false;
  let hasHooks = false;

  for (const rel of scopedFiles.keys()) {
    if (/^skills\/[^/]+\/SKILL\.md$/.test(rel)) hasSkills = true;
    else if (/^agents\/[^/]+\.md$/i.test(rel)) hasAgents = true;
    else if (/^rules\/[^/]+\.md$/i.test(rel)) hasRules = true;
    else if (/^sidecars\/[^/]+\/sidecar\.json$/.test(rel) || rel === 'sidecars.json') hasSidecar = true;
    else if (rel === 'mcp_config.json') hasMcp = true;
    else if (rel === 'hooks.json') hasHooks = true;
  }

  return { hasSkills, hasAgents, hasRules, hasSidecar, hasMcp, hasHooks };
}

/**
 * Discovers all valid Antigravity plugin manifests inside an archive's `filesMap`:
 *   - Root `plugin.json` (`pluginRoot: "."`)
 *   - Dot-directory `.antigravity-plugin/plugin.json` (keeps `pluginRoot: "."` to preserve root components!)
 *   - Subdirectory `<subpath>/plugin.json` or `<subpath>/.antigravity-plugin/plugin.json`
 */
function discoverPluginManifests(filesMap) {
  const byRoot = new Map();

  for (const [relPath, buf] of filesMap.entries()) {
    if (IGNORED_MANIFEST_PATH_RE.test(relPath)) continue;

    let pluginRoot = null;
    let isDotManifest = false;
    if (relPath === 'plugin.json') {
      pluginRoot = '.';
    } else if (relPath === '.antigravity-plugin/plugin.json') {
      pluginRoot = '.';
      isDotManifest = true;
    } else if (relPath.endsWith('/.antigravity-plugin/plugin.json')) {
      pluginRoot = relPath.slice(0, -'/.antigravity-plugin/plugin.json'.length);
      isDotManifest = true;
    } else if (relPath.endsWith('/plugin.json')) {
      pluginRoot = relPath.slice(0, -'/plugin.json'.length);
    } else {
      continue;
    }

    const normRoot = normalizePluginRoot(pluginRoot);
    const existing = byRoot.get(normRoot);
    // Prefer direct `plugin.json` over `.antigravity-plugin/plugin.json` if both exist at the same root
    if (existing && !existing.isDotManifest && isDotManifest) continue;

    let parsedManifest = null;
    try {
      const obj = parseJsonc(buf.toString('utf8'));
      if (obj && typeof obj === 'object' && !Array.isArray(obj) && typeof obj.name === 'string' && obj.name.trim()) {
        parsedManifest = obj;
      }
    } catch {
      parsedManifest = null;
    }

    if (!parsedManifest) continue;

    byRoot.set(normRoot, {
      pluginRoot: normRoot,
      manifestRelPath: relPath,
      isDotManifest,
      rawManifest: parsedManifest,
    });
  }

  return [...byRoot.values()].sort((a, b) => {
    if (a.pluginRoot === '.') return -1;
    if (b.pluginRoot === '.') return 1;
    return a.pluginRoot.localeCompare(b.pluginRoot);
  });
}

function buildNotPluginRepoDiagnostic(filesMap, repoUrl) {
  const topEntries = new Set();
  let hasPartialComponents = false;
  let hasStandaloneScripts = false;
  let mentionsAsarPatch = false;

  for (const [rel, buf] of filesMap.entries()) {
    const slash = rel.indexOf('/');
    if (slash === -1) {
      topEntries.add(rel);
    } else {
      topEntries.add(`${rel.slice(0, slash)}/`);
    }
    if (
      /^skills\/[^/]+\/SKILL\.md$/i.test(rel) ||
      /^rules\/[^/]+\.md$/i.test(rel) ||
      /^agents\/[^/]+\.md$/i.test(rel) ||
      rel === 'mcp_config.json' ||
      rel === 'hooks.json'
    ) {
      hasPartialComponents = true;
    }
    if (/\.(?:ps1|sh|bat|cmd|py|exe)$/i.test(rel)) {
      hasStandaloneScripts = true;
    }
    if (!mentionsAsarPatch && /^readme(?:\.[^/]+)?\.md$/i.test(rel)) {
      const head = buf.toString('utf8').slice(0, 8192);
      if (/\bapp\.asar\b/i.test(head)) mentionsAsarPatch = true;
    }
  }

  const fileOverview = [...topEntries]
    .sort((a, b) => {
      const aDir = a.endsWith('/');
      const bDir = b.endsWith('/');
      if (aDir !== bDir) return aDir ? -1 : 1;
      return a.localeCompare(b);
    })
    .slice(0, 16);

  let reasonZh;
  let reasonEn;
  let hintsZh;
  let hintsEn;

  if (hasPartialComponents) {
    reasonZh = '检测到部分技能、规则或 MCP 配置文件，但仓库中缺少 Antigravity 必需的 plugin.json 插件清单，无法直接安装。';
    reasonEn =
      'Detected partial skills, rules, or MCP config files, but no Antigravity plugin.json manifest was found in the repository.';
    hintsZh = [
      'Antigravity 原生插件必须在插件根目录（或 .antigravity-plugin/）提供合法的 plugin.json。',
      '您可以前往 GitHub 仓库查看作者说明，或手动按文档复制对应文件。',
    ];
    hintsEn = [
      'Native Antigravity plugins require a valid plugin.json manifest at the plugin root (or .antigravity-plugin/).',
      'Open the GitHub repository to review the author installation instructions.',
    ];
  } else if (hasStandaloneScripts || mentionsAsarPatch) {
    reasonZh =
      '该仓库为独立脚本、工具或非标准补丁项目（全仓未找到 plugin.json），不支持作为原生 Antigravity 插件托管安装。';
    reasonEn =
      'This repository appears to be a standalone script, tool, or patch project without a plugin.json manifest and cannot be installed as a native Antigravity plugin.';
    hintsZh = [
      '请点击下方链接前往 GitHub 仓库查看作者提供的独立使用说明。',
      '若目标插件位于仓库特定分支或发布包中，请粘贴对应的 /tree/<分支> 或 Release .tar.gz 链接重试。',
    ];
    hintsEn = [
      'Visit the GitHub repository to follow the author standalone setup instructions.',
      'If the plugin lives on another branch or release tarball, paste that /tree/<branch> or .tar.gz URL instead.',
    ];
  } else {
    reasonZh = '未在该 GitHub 仓库中找到任何 plugin.json 插件清单，无法作为 Antigravity 插件直接安装。';
    reasonEn = 'No plugin.json manifest was found anywhere in this GitHub repository.';
    hintsZh = [
      '请确认链接指向的是 Antigravity 插件仓库（根目录或子目录应包含 plugin.json）。',
      '若插件仅发布在 Release 附件中，可直接粘贴对应的 .tar.gz 附件链接。',
    ];
    hintsEn = [
      'Verify that the link points to an Antigravity plugin repository containing plugin.json.',
      'If the plugin is distributed only as a Release asset, paste the .tar.gz download URL directly.',
    ];
  }

  return {
    ok: true,
    status: 'NOT_A_PLUGIN_REPO',
    reasonCode: 'ERR_NO_PLUGIN_JSON',
    reasonZh,
    reasonEn,
    hintsZh,
    hintsEn,
    fileOverview,
    totalFiles: filesMap.size,
    repoUrl,
  };
}

function extractCompanionPreservePaths(scopedFiles, allFiles) {
  const buf = scopedFiles.get('agy-market.json') || allFiles.get('agy-market.json') || null;
  if (!buf) return [];
  try {
    const parsed = parseJsonc(buf.toString('utf8'));
    if (!Array.isArray(parsed?.preservePaths)) return [];
    return parsed.preservePaths.filter(
      (p) => typeof p === 'string' && p.trim() && !p.includes('..') && !p.startsWith('/') && !/^[A-Za-z]:/.test(p),
    );
  } catch {
    return [];
  }
}

function collectComponentWarnings(components, canonicalName, inventory) {
  const warnings = [];
  const activeInstalled = (inventory?.installed || []).filter(
    (loc) => loc.enabled && !loc.parkedByMarket && loc.dir !== canonicalName && loc.name !== canonicalName,
  );
  const existingSkillOwners = new Map();
  const existingAgentOwners = new Map();
  const existingMcpOwners = new Map();

  for (const loc of activeInstalled) {
    for (const sk of loc.skills || []) {
      if (sk?.name && !existingSkillOwners.has(sk.name)) existingSkillOwners.set(sk.name, loc.dir);
    }
    for (const ag of loc.agents || []) {
      if (ag && !existingAgentOwners.has(ag)) existingAgentOwners.set(ag, loc.dir);
    }
    for (const mk of loc.mcpServerKeys || []) {
      const full = `${loc.name}_${mk}`;
      if (!existingMcpOwners.has(full)) existingMcpOwners.set(full, loc.dir);
    }
  }

  for (const sk of components.skills || []) {
    if (BUILTIN_SKILL_NAMES.has(sk.name)) {
      warnings.push(`Skill "${sk.name}" 与 Antigravity 内置技能重名，安装后可能覆盖内置技能。`);
    } else if (existingSkillOwners.has(sk.name)) {
      warnings.push(`Skill "${sk.name}" 与已启用插件 "${existingSkillOwners.get(sk.name)}" 的技能重名。`);
    }
  }

  for (const ag of components.agents || []) {
    if (BUILTIN_AGENT_NAMES.has(ag)) {
      warnings.push(`Subagent "${ag}" 与 Antigravity 内置代理重名，安装后可能产生遮蔽。`);
    } else if (existingAgentOwners.has(ag)) {
      warnings.push(`Subagent "${ag}" 与已启用插件 "${existingAgentOwners.get(ag)}" 的代理重名。`);
    }
  }

  for (const rawKey of components.mcpServerKeys || []) {
    if (GENERIC_MCP_SERVER_KEYS.has(String(rawKey).toLowerCase())) {
      warnings.push(`MCP 服务键 "${rawKey}" 属于通用名称（如 search/db/git），可能与其他插件工具混淆。`);
    }
    const full = `${canonicalName}_${rawKey}`;
    if (inventory?.userMcpServerNames?.has(full) || inventory?.userMcpServerNames?.has(rawKey)) {
      warnings.push(`MCP 服务键 "${rawKey}" 与用户全局 mcp_config.json 存在重名重叠。`);
    } else if (existingMcpOwners.has(full)) {
      warnings.push(`MCP 服务名 "${full}" 与已启用插件 "${existingMcpOwners.get(full)}" 冲突。`);
    }
  }

  return warnings;
}

function getInspectStagingDir(dataDir, inspectToken) {
  if (!UUID_RE.test(String(inspectToken || ''))) {
    throw new Error('ERR_INVALID_INSPECT_TOKEN: Invalid inspect token format');
  }
  return join(dataDir, 'staging', `inspect-${inspectToken}`);
}

/**
 * Lazily removes expired `staging/inspect-*` temporary archives older than `INSPECT_STAGING_TTL_MS`.
 */
export function sweepExpiredInspectStaging(dataDir, nowMs = Date.now(), { preserveToken = '' } = {}) {
  let removed = 0;
  if (!dataDir) return { removed };
  const stagingParent = join(dataDir, 'staging');
  if (!existsSync(stagingParent)) return { removed };

  let entries;
  try {
    entries = readdirSync(stagingParent);
  } catch {
    return { removed };
  }

  for (const name of entries) {
    if (!name.startsWith('inspect-')) continue;
    const tok = name.slice('inspect-'.length);
    if (preserveToken && tok === preserveToken) continue;
    const fullDir = join(stagingParent, name);
    try {
      let expired = false;
      const metaPath = join(fullDir, 'meta.json');
      if (existsSync(metaPath)) {
        try {
          const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
          if (!Number.isFinite(meta?.expiresAtMs) || nowMs > meta.expiresAtMs) {
            expired = true;
          }
        } catch {
          expired = true;
        }
      } else {
        const st = statSync(fullDir);
        if (nowMs - st.mtimeMs > INSPECT_STAGING_TTL_MS) {
          expired = true;
        }
      }
      if (expired) {
        rmSync(fullDir, { recursive: true, force: true });
        removed += 1;
      }
    } catch {
      /* ignore locked/in-use dir */
    }
  }

  return { removed };
}

function writePreviewFilesToDisk(previewDir, scopedFiles, selectedCandidate, cleanManifest, scopedFileSizes = null) {
  rmSync(previewDir, { recursive: true, force: true });
  mkdirSync(previewDir, { recursive: true });
  const absPreview = resolve(previewDir);

  for (const [relPath, buf] of scopedFiles.entries()) {
    const actualSize = scopedFileSizes?.get(relPath) ?? buf.length;
    if (buf.length === 0 && actualSize > 0) {
      // Unbuffered non-metadata binary/asset/oversized-script skipped during streaming inspection
      continue;
    }
    const safeRel = validateSafeRelPath(relPath);
    const outPath = resolve(absPreview, safeRel);
    if (!outPath.startsWith(absPreview)) {
      throw new Error(`ERR_TAR_ESCAPE: Preview path escaped staging directory ("${safeRel}")`);
    }
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, buf);
  }

  // Ensure root `plugin.json` exists in preview dir when layout is `.antigravity-plugin/plugin.json`
  const rootManifestPath = join(absPreview, 'plugin.json');
  if (selectedCandidate.isDotManifest || !existsSync(rootManifestPath)) {
    writeFileSync(rootManifestPath, `${JSON.stringify(cleanManifest, null, 2)}\n`, 'utf8');
  }
}

function loadValidStagedInspect(dataDir, inspectToken, nowMs = Date.now()) {
  if (!inspectToken || !UUID_RE.test(String(inspectToken))) return null;
  const stagingRootDir = getInspectStagingDir(dataDir, inspectToken);
  const archivePath = join(stagingRootDir, 'archive.tar.gz');
  const metaPath = join(stagingRootDir, 'meta.json');
  if (!existsSync(archivePath) || !existsSync(metaPath)) return null;
  try {
    const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
    if (!Number.isFinite(meta?.expiresAtMs) || nowMs > meta.expiresAtMs) {
      rmSync(stagingRootDir, { recursive: true, force: true });
      return null;
    }
    return { stagingRootDir, archivePath, metaPath, meta };
  } catch {
    return null;
  }
}

function buildSyntheticPluginRecord({
  inspectData,
  installMode = 'native',
  preserveReceiptId = '',
  preserveTrackBranch = '',
  preserveRepositoryId = 0,
  preserveForceScopedInstall = false,
  preservePaths: extraPreservePaths = [],
  includeGithubSource = true,
}) {
  const { plugin, resolution, parsed } = inspectData;
  const forceScopedInstall = Boolean(preserveForceScopedInstall) || installMode === 'isolate';
  const isReleaseOrTagResolution =
    resolution.refType === 'release' || resolution.refType === 'tag' || resolution.refType === 'asset';
  const keepBranchTracking = Boolean(preserveTrackBranch && !isReleaseOrTagResolution);
  const trackBranch = keepBranchTracking
    ? preserveTrackBranch
    : !isReleaseOrTagResolution && resolution.refType === 'branch' && resolution.ref && resolution.ref !== 'HEAD'
      ? resolution.ref
      : !isReleaseOrTagResolution
        ? resolution.defaultBranch || ''
        : '';
  const effectiveRefType = keepBranchTracking ? 'branch' : resolution.refType || 'branch';
  const effectiveRef = keepBranchTracking ? preserveTrackBranch : resolution.ref || '';
  const effectiveRepoId =
    Number(preserveRepositoryId) > 0 ? Number(preserveRepositoryId) : Number(resolution.repositoryId || 0);
  const mergedPreservePaths = [
    ...new Set([
      ...(Array.isArray(plugin.preservePaths) ? plugin.preservePaths : []),
      ...(Array.isArray(extraPreservePaths) ? extraPreservePaths : []),
    ]),
  ];

  return {
    id: preserveReceiptId || plugin.id,
    canonicalName: plugin.canonicalName,
    scopedName: plugin.scopedName,
    forceScopedInstall,
    displayName: plugin.displayName,
    description: {
      zh: plugin.description || plugin.displayName,
      en: plugin.description || plugin.displayName,
    },
    version: plugin.version,
    gitTag: plugin.gitTag || null,
    commitSha: plugin.commitSha || '',
    repository: {
      url: plugin.repoUrl,
      repositoryId: effectiveRepoId,
      ownerId: Number(resolution.ownerId || 0),
      stars: Number(resolution.stars || 0),
      pluginRoot: plugin.pluginRoot || '.',
    },
    distribution: {
      tarballUrl: plugin.tarballUrl,
      sha256: plugin.sha256,
      sizeBytes: plugin.sizeBytes,
      npmMirrorPkg: null,
      preservePaths: mergedPreservePaths,
    },
    capabilities: plugin.capabilities,
    ...(includeGithubSource
      ? {
          githubSource: {
            inputUrl: parsed?.inputUrl || plugin.repoUrl,
            kind: parsed?.kind || 'repo',
            ref: effectiveRef,
            refType: effectiveRefType,
            ...(trackBranch ? { trackBranch } : {}),
            tarballUrl: plugin.tarballUrl,
          },
        }
      : {}),
  };
}

/**
 * Step 1: Downloads (or reuses staged `inspectToken`) a GitHub plugin archive, computes SHA-256,
 * enforces local security gates, discovers root / `.antigravity-plugin` / single-subdir / Monorepo
 * manifests, scans capabilities, runs local conflict preflight, and returns structured four-state
 * diagnostics (`READY` | `SUBPATH_SELECTION_REQUIRED` | `NOT_A_PLUGIN_REPO` | `SECURITY_BLOCKED`).
 */
export async function inspectGithubPluginUrl({
  url = '',
  inspectToken = '',
  pluginRoot = '',
  prefs = {},
  configDir = resolveAntigravityConfigDir(),
  pluginsDir = '',
  dataDir = resolveMarketDataDir(),
  workspaceUris = [],
  builtinPluginsDir = '',
  catalogPlugins = [],
  fetchImpl = defaultProxyFetch,
  githubApiBaseUrl = GITHUB_API_BASE_URL,
  timeoutMs = DEFAULT_API_TIMEOUT_MS,
  nowMs = Date.now(),
} = {}) {
  const activeFetch = resolveEffectiveFetch(fetchImpl);
  const cleanPrefs = sanitizePrefs(prefs);
  const token = cleanPrefs.githubToken;
  mkdirSync(dataDir, { recursive: true });
  sweepExpiredInspectStaging(dataDir, nowMs, { preserveToken: inspectToken });

  let activeToken = '';
  let stagingRootDir = '';
  let archivePath = '';
  let stageMeta = null;
  let parsed = null;
  let explicitRootFromRequest = pluginRoot ? normalizePluginRoot(pluginRoot) : '';

  // Fast path: reuse staged archive for zero-redownload Monorepo subpath switch
  const existingStaged = inspectToken ? loadValidStagedInspect(dataDir, inspectToken, nowMs) : null;
  if (existingStaged) {
    activeToken = inspectToken;
    stagingRootDir = existingStaged.stagingRootDir;
    archivePath = existingStaged.archivePath;
    stageMeta = existingStaged.meta;
    parsed = stageMeta.parsed;
  } else {
    parsed = parseGithubPluginUrl(url);
    const resolved = await resolveGithubArchiveCandidates(parsed, {
      dataDir,
      prefs: cleanPrefs,
      fetchImpl: activeFetch,
      githubApiBaseUrl,
      timeoutMs,
      nowMs,
    });

    activeToken = randomUUID();
    stagingRootDir = getInspectStagingDir(dataDir, activeToken);
    archivePath = join(stagingRootDir, 'archive.tar.gz');
    mkdirSync(stagingRootDir, { recursive: true });

    const attemptErrors = [];
    let dlResult = null;
    let winningAttempt = null;
    let winningCandidate = null;

    outer: for (const attempt of resolved.attempts) {
      for (const cand of attempt.candidates) {
        try {
          const extraHeaders =
            token && cand.sendAuth && isOfficialGithubTokenHost(cand.url)
              ? { Authorization: `Bearer ${token}` }
              : null;
          dlResult = await streamUrlToFileAndHash(cand.url, archivePath, {
            maxBytes: MAX_TARBALL_BYTES,
            fetchImpl: activeFetch,
            extraHeaders,
            requireGzipMagic: true,
          });
          winningAttempt = attempt;
          winningCandidate = cand;
          break outer;
        } catch (err) {
          rmSync(archivePath, { force: true });
          attemptErrors.push(redactSecret(`${cand.channel}: ${err?.message || String(err)}`, token));
        }
      }
    }

    if (!dlResult || !winningAttempt || !winningCandidate) {
      rmSync(stagingRootDir, { recursive: true, force: true });
      throw new Error(
        redactSecret(
          `ERR_GITHUB_DOWNLOAD_FAILED: 无法下载 ${parsed.owner}/${parsed.repo} 归档（${attemptErrors.slice(0, 3).join(' | ')}）`,
          token,
        ),
      );
    }

    // If URL was `/tree/<ref>/<subpath>` and slash-branch fallback adjusted pluginRoot, adopt it
    if (!explicitRootFromRequest && winningAttempt.pluginRoot && winningAttempt.pluginRoot !== '.') {
      explicitRootFromRequest = winningAttempt.pluginRoot;
    }

    const resolution = {
      ...resolved.meta,
      ref: winningAttempt.ref || resolved.meta.ref || '',
    };

    stageMeta = {
      schemaVersion: 1,
      inspectToken: activeToken,
      createdAtMs: nowMs,
      expiresAtMs: nowMs + INSPECT_STAGING_TTL_MS,
      sha256: dlResult.sha256,
      sizeBytes: dlResult.bytes,
      channelUsed: winningCandidate.channel,
      urlUsed: winningCandidate.url,
      tarballUrl: winningCandidate.canonicalUrl || winningCandidate.url,
      contentDisposition: dlResult.contentDisposition || '',
      parsed: {
        ...parsed,
        pluginRoot: winningAttempt.pluginRoot || parsed.pluginRoot || '.',
      },
      resolution,
    };
    writeFileSync(join(stagingRootDir, 'meta.json'), `${JSON.stringify(stageMeta, null, 2)}\n`, 'utf8');
  }

  // Parse archive safely via streaming gunzip + tar parser (O(MB) RAM even for 200MB–2GB+ archives;
  // enforces Zip-Slip & typeFlag gates; defers symlink scope check until `selectedRoot` is known)
  let tarParsed;
  try {
    tarParsed = await inspectTarGzStream(archivePath, {
      stripSingleTopDir: true,
      allowDeferredSymlinkCheck: true,
      maxUncompressedBytes: MAX_TARBALL_BYTES,
      shouldBufferFile: shouldBufferInspectFile,
    });
  } catch (err) {
    rmSync(stagingRootDir, { recursive: true, force: true });
    const secBlock = classifySecurityError(err, stageMeta.resolution.repoUrl);
    if (secBlock) return secBlock;
    throw err;
  }

  const allFiles = tarParsed.files;
  const allFileSizes = tarParsed.fileSizes;
  const paxComment = String(tarParsed.globalPax?.comment || '').trim();
  let commitSha = stageMeta.resolution.commitSha || '';
  if (!commitSha && FULL_SHA_RE.test(paxComment)) {
    commitSha = paxComment.toLowerCase();
  }

  // Infer branch name when zero-API HEAD download returned repo-<branch>
  const inferredBranch = inferBranchFromArchiveMeta({
    repo: stageMeta.resolution.repo,
    strippedTopDir: tarParsed.strippedTopDir,
    contentDisposition: stageMeta.contentDisposition,
  });
  const effectiveResolution = {
    ...stageMeta.resolution,
    commitSha,
    defaultBranch: stageMeta.resolution.defaultBranch || inferredBranch || '',
    ref:
      stageMeta.resolution.ref && stageMeta.resolution.ref !== 'HEAD'
        ? stageMeta.resolution.ref
        : inferredBranch || stageMeta.resolution.ref || 'HEAD',
  };

  // Update persisted meta with discovered commitSha & inferredBranch
  stageMeta.resolution = effectiveResolution;
  try {
    writeFileSync(join(stagingRootDir, 'meta.json'), `${JSON.stringify(stageMeta, null, 2)}\n`, 'utf8');
  } catch {
    /* non-fatal */
  }

  // Discover all plugin.json / .antigravity-plugin/plugin.json candidates
  const candidates = discoverPluginManifests(allFiles);

  // Case 3: No `plugin.json` anywhere -> NOT_A_PLUGIN_REPO + immediate staging cleanup!
  if (candidates.length === 0) {
    rmSync(stagingRootDir, { recursive: true, force: true });
    return buildNotPluginRepoDiagnostic(allFiles, effectiveResolution.repoUrl);
  }

  // Resolve which candidate to inspect
  const requestedRoot =
    explicitRootFromRequest ||
    (stageMeta.parsed?.pluginRoot && stageMeta.parsed.pluginRoot !== '.' ? normalizePluginRoot(stageMeta.parsed.pluginRoot) : '');

  let selectedCandidate = null;
  let autoDetectedSubpath = false;

  if (requestedRoot) {
    selectedCandidate = candidates.find((c) => c.pluginRoot === requestedRoot) || null;
    if (!selectedCandidate) {
      // Requested subpath did not contain a valid plugin.json -> offer discovered candidates
      return {
        ok: true,
        status: 'SUBPATH_SELECTION_REQUIRED',
        inspectToken: activeToken,
        expiresAt: new Date(stageMeta.expiresAtMs).toISOString(),
        repoUrl: effectiveResolution.repoUrl,
        requestedPluginRoot: requestedRoot,
        reasonZh: `指定子目录 "${requestedRoot}" 下未找到有效的 plugin.json，请从以下已发现的插件子目录中选择：`,
        reasonEn: `No valid plugin.json found at "${requestedRoot}". Choose one of the discovered plugin directories:`,
        candidates: candidates.map((c) => {
          const subFiles = extractScopedFiles(allFiles, c.pluginRoot);
          return {
            pluginRoot: c.pluginRoot,
            name: c.rawManifest.name,
            displayName: String(c.rawManifest.displayName || c.rawManifest.name),
            version: String(c.rawManifest.version || '0.0.0'),
            description: String(c.rawManifest.description || ''),
            isDotManifest: c.isDotManifest,
            componentSummary: summarizeCandidateComponents(subFiles),
          };
        }),
      };
    }
  } else {
    const rootCand = candidates.find((c) => c.pluginRoot === '.') || null;
    if (rootCand) {
      selectedCandidate = rootCand;
    } else if (candidates.length === 1) {
      // Single named subdirectory layout (e.g. Lumidarin/agy-capsule -> agy-capsule/plugin.json)
      selectedCandidate = candidates[0];
      autoDetectedSubpath = true;
    } else {
      // Monorepo with >= 2 plugin subdirectories -> SUBPATH_SELECTION_REQUIRED (keep staging alive!)
      return {
        ok: true,
        status: 'SUBPATH_SELECTION_REQUIRED',
        inspectToken: activeToken,
        expiresAt: new Date(stageMeta.expiresAtMs).toISOString(),
        repoUrl: effectiveResolution.repoUrl,
        candidates: candidates.map((c) => {
          const subFiles = extractScopedFiles(allFiles, c.pluginRoot);
          return {
            pluginRoot: c.pluginRoot,
            name: c.rawManifest.name,
            displayName: String(c.rawManifest.displayName || c.rawManifest.name),
            version: String(c.rawManifest.version || '0.0.0'),
            description: String(c.rawManifest.description || ''),
            isDotManifest: c.isDotManifest,
            componentSummary: summarizeCandidateComponents(subFiles),
          };
        }),
      };
    }
  }

  const selectedRoot = selectedCandidate.pluginRoot;
  const scopedFiles = extractScopedFiles(allFiles, selectedRoot);
  const scopedFileSizes = allFileSizes ? extractScopedFiles(allFileSizes, selectedRoot) : null;

  // Hard security gates on selected plugin files:
  //   1. Scoped symlink/hardlink invariant (rejects any symlink inside `selectedRoot`, enclosing it,
  //      traversing into it, or anywhere in archive when `selectedRoot === '.'`)
  //   2. Unicode smuggling, rules exfiltration, >24KB rules
  try {
    assertNoScopedSymlinks(tarParsed.symlinks, selectedRoot, tarParsed.strippedTopDir);
    assertLocalStaticSafety(scopedFiles, scopedFileSizes);
  } catch (err) {
    rmSync(stagingRootDir, { recursive: true, force: true });
    const secBlock = classifySecurityError(err, effectiveResolution.repoUrl);
    if (secBlock) return secBlock;
    throw err;
  }

  // Sanitize manifest strictly to Antigravity 10-field allowlist
  const cleanManifest = sanitizeNativePluginManifest(selectedCandidate.rawManifest);
  delete cleanManifest.disabled;

  const ownerLower = parsed.ownerLower;
  const repoLower = parsed.repoLower;
  const canonicalName = deriveSafeCanonicalName(cleanManifest.name, repoLower);
  const scopedName = toScopedPluginName(ownerLower, canonicalName);
  const syntheticId = deriveSyntheticPluginId(ownerLower, repoLower, selectedRoot);
  const displayName = String(cleanManifest.displayName || cleanManifest.name || canonicalName);
  const description = String(cleanManifest.description || effectiveResolution.repoDescription || '');
  const manifestSem = parseSemver(cleanManifest.version);
  const tagSem = parseSemver(effectiveResolution.gitTag);
  const stableTagSem = tagSem && tagSem.prerelease.length === 0 ? tagSem : null;
  const version =
    (stableTagSem && (!manifestSem || compareSemver(stableTagSem.version, manifestSem.version) > 0)
      ? stableTagSem.version
      : manifestSem?.version) ||
    tagSem?.version ||
    (typeof cleanManifest.version === 'string' && cleanManifest.version.trim()) ||
    '0.0.0';
  const preservePaths = extractCompanionPreservePaths(scopedFiles, allFiles);
  const prebuiltWarnings = checkPrebuiltWarnings(scopedFiles);
  const readmes = extractPreviewReadmes(scopedFiles, allFiles);

  // Extract selected plugin subtree to ephemeral preview dir to reuse `scanLocalPluginComponents` 100%
  const previewDir = join(stagingRootDir, 'preview');
  let components;
  try {
    writePreviewFilesToDisk(previewDir, scopedFiles, selectedCandidate, cleanManifest, scopedFileSizes);
    components = scanLocalPluginComponents(previewDir, canonicalName, cleanManifest.name, null);
  } finally {
    rmSync(previewDir, { recursive: true, force: true });
  }

  // Cross-check local inventory & preflight collision
  const inventory = scanLocalPluginInventory({
    configDir,
    pluginsDir,
    dataDir,
    workspaceUris,
    builtinPluginsDir,
  });

  const isForeignSelfRepo = canonicalName === PLUGIN_ID && syntheticId !== SELF_CATALOG_ID;
  const probePlugin = {
    id: syntheticId,
    canonicalName,
    scopedName,
    forceScopedInstall: false,
    displayName,
    version,
    gitTag: effectiveResolution.gitTag || null,
    commitSha,
    repository: {
      url: effectiveResolution.repoUrl,
      repositoryId: Number(effectiveResolution.repositoryId || 0),
      pluginRoot: selectedRoot,
    },
    capabilities: components.capabilities,
  };

  const preflight = resolveInstallPreflight(probePlugin, inventory, { conflictStrategy: 'prompt' });
  const isForeignSelfCollision =
    isForeignSelfRepo ||
    Boolean(
      preflight.conflict &&
        (preflight.conflict.dir === PLUGIN_ID || preflight.conflict.name === PLUGIN_ID) &&
        syntheticId !== SELF_CATALOG_ID,
    );
  const canReplace =
    Boolean(preflight.conflict) && preflight.conflict.scope === 'global' && !isForeignSelfCollision;

  const esc = computeCapabilityEscalation(preflight.existingInstall?.receipt || null, probePlugin);
  const componentWarnings = collectComponentWarnings(components, canonicalName, inventory);

  // Cross-check active catalog for gentle notice if already listed
  const normRepo = normalizeRepoUrl(effectiveResolution.repoUrl);
  const matchedCatalog = (Array.isArray(catalogPlugins) ? catalogPlugins : []).find((cp) => {
    if (!cp) return false;
    if (cp.id === syntheticId) return true;
    const cpRepo = normalizeRepoUrl(cp?.repository?.url);
    if (!cpRepo || cpRepo !== normRepo) return false;
    const cpRoot = normalizePluginRoot(cp?.repository?.pluginRoot || '.');
    return cpRoot === selectedRoot || cp.canonicalName === canonicalName;
  });

  const catalogMatch = matchedCatalog
    ? {
        id: matchedCatalog.id,
        track: matchedCatalog._track || (matchedCatalog.forceScopedInstall ? 'unverified' : 'verified'),
        version: matchedCatalog.version || '',
        displayName: matchedCatalog.displayName || matchedCatalog.canonicalName || matchedCatalog.id,
      }
    : null;

  // Tier-0 Opt-In Nomination Hook: ONLY probe unauthenticated public accessibility when unlisted (`catalogMatch === null`).
  // Strictly NEVER prompts on private, 404, redirected, or unreachable repos.
  let isPublicRepo = false;
  let nomination = null;
  if (catalogMatch === null) {
    const repoKey = `${parsed.owner}/${parsed.repo}`;
    if (
      stageMeta.publicRepoProbe &&
      stageMeta.publicRepoProbe.repo === repoKey &&
      typeof stageMeta.publicRepoProbe.isPublic === 'boolean'
    ) {
      isPublicRepo = stageMeta.publicRepoProbe.isPublic;
    } else {
      isPublicRepo = await probeIsPublicGithubRepo(parsed.owner, parsed.repo, {
        fetchImpl: activeFetch,
        timeoutMs: Math.min(PUBLIC_REPO_PROBE_TIMEOUT_MS, timeoutMs),
      });
      stageMeta.publicRepoProbe = { repo: repoKey, isPublic: isPublicRepo };
      try {
        writeFileSync(join(stagingRootDir, 'meta.json'), `${JSON.stringify(stageMeta, null, 2)}\n`, 'utf8');
      } catch {
        /* non-fatal */
      }
    }
    if (isPublicRepo) {
      const issueUrl = buildPluginNominationUrl({
        owner: parsed.owner,
        repo: parsed.repo,
        pluginRoot: selectedRoot,
      });
      if (issueUrl) {
        nomination = {
          eligible: true,
          repo: repoKey,
          pluginRoot: selectedRoot,
          issueUrl,
        };
      }
    }
  }

  const defaultInstallMode =
    preflight.action === 'conflict-prompt' || isForeignSelfCollision ? 'isolate' : 'native';

  const pluginInfo = {
    id: syntheticId,
    canonicalName,
    scopedName,
    displayName,
    version,
    description,
    author: normalizeAuthorDisplay(cleanManifest.author) || effectiveResolution.owner,
    logo: typeof cleanManifest.logo === 'string' ? cleanManifest.logo : '',
    gitTag: effectiveResolution.gitTag || null,
    commitSha,
    sha256: stageMeta.sha256,
    sizeBytes: stageMeta.sizeBytes,
    pluginRoot: selectedRoot,
    autoDetectedSubpath,
    isDotManifest: selectedCandidate.isDotManifest,
    repoUrl: effectiveResolution.repoUrl,
    tarballUrl: stageMeta.tarballUrl,
    channelUsed: stageMeta.channelUsed,
    rateLimitedFallback: Boolean(effectiveResolution.rateLimitedFallback),
    capabilities: components.capabilities,
    sidecarPane: components.hasSidecarPane || null,
    preservePaths,
    readmeMarkdown: readmes.readmeMarkdown,
    readmeZhMarkdown: readmes.readmeZhMarkdown,
    readmeEnMarkdown: readmes.readmeEnMarkdown,
  };

  return {
    ok: true,
    status: 'READY',
    inspectToken: activeToken,
    expiresAt: new Date(stageMeta.expiresAtMs).toISOString(),
    plugin: pluginInfo,
    preflight: {
      action: preflight.action,
      targetDir: preflight.targetDir,
      effectivePluginName: preflight.effectivePluginName,
      scopedFallbackName: scopedName,
      defaultInstallMode,
      conflictItem: preflight.conflict
        ? {
            dir: preflight.conflict.dir,
            name: preflight.conflict.name,
            displayName: preflight.conflict.displayName,
            scope: preflight.conflict.scope,
            version: preflight.conflict.version,
          }
        : null,
      existingInstall: preflight.existingInstall
        ? {
            dir: preflight.existingInstall.dir,
            name: preflight.existingInstall.name,
            version: preflight.existingInstall.version,
            parkedByMarket: Boolean(preflight.existingInstall.parkedByMarket),
            track: preflight.existingInstall.receipt?.track || 'local',
          }
        : null,
      canReplace,
      isForeignSelfCollision,
      choices: preflight.choices || (canReplace ? ['isolate', 'replace'] : ['isolate']),
    },
    escalation: {
      hasEscalation: Boolean(esc.escalated),
      escalated: Boolean(esc.escalated),
      addedBadges: esc.addedBadges || [],
      addedDomains: esc.addedRemoteDomains || [],
      addedRemoteDomains: esc.addedRemoteDomains || [],
      addedHooks: esc.addedHookEvents || [],
      addedHookEvents: esc.addedHookEvents || [],
    },
    warnings: prebuiltWarnings,
    componentWarnings,
    catalogMatch,
    isPublicRepo,
    nomination,
    _internal: {
      stagingRootDir,
      archivePath,
      resolution: effectiveResolution,
      parsed: stageMeta.parsed,
    },
  };
}

/**
 * Step 2: Installs a GitHub URL plugin by consuming a staged `inspectToken` (with zero redundant
 * network download via `preverifiedArchivePath`), or automatically re-inspecting if expired and `url` is supplied.
 */
export async function installGithubPlugin({
  inspectToken = '',
  url = '',
  pluginRoot = '',
  installMode = '', // '' | 'native' | 'isolate' | 'replace'
  preferredDir = '',
  confirmEscalation = false,
  prefs = {},
  configDir = resolveAntigravityConfigDir(),
  pluginsDir = '',
  dataDir = resolveMarketDataDir(),
  workspaceUris = [],
  builtinPluginsDir = '',
  catalogPlugins = [],
  fetchImpl = defaultProxyFetch,
  githubApiBaseUrl = GITHUB_API_BASE_URL,
  timeoutMs = DEFAULT_API_TIMEOUT_MS,
  nowMs = Date.now(),
  writeOverride = null,
  preserveReceiptMeta = null,
  _preserveReceiptId = '',
  _preserveTrackBranch = '',
} = {}) {
  const activeFetch = resolveEffectiveFetch(fetchImpl);
  let activeToken = inspectToken;
  const staged = inspectToken ? loadValidStagedInspect(dataDir, inspectToken, nowMs) : null;

  if (!staged && !url) {
    throw new Error('ERR_INSPECT_TOKEN_EXPIRED: 预检暂存已过期，请重新粘贴 GitHub 链接执行预检。');
  }

  // Re-evaluate staged archive locally (0 network calls if `staged` is valid; downloads once if expired & `url` provided)
  const inspectRes = await inspectGithubPluginUrl({
    url,
    inspectToken: staged ? activeToken : '',
    pluginRoot,
    prefs,
    configDir,
    pluginsDir,
    dataDir,
    workspaceUris,
    builtinPluginsDir,
    catalogPlugins,
    fetchImpl: activeFetch,
    githubApiBaseUrl,
    timeoutMs,
    nowMs,
  });

  if (inspectRes.status !== 'READY') {
    return inspectRes;
  }

  activeToken = inspectRes.inspectToken;
  const { stagingRootDir, archivePath, resolution, parsed } = inspectRes._internal;
  const normalizedMode = ['native', 'isolate', 'replace'].includes(installMode) ? installMode : '';

  // Hard guard: never allow foreign GitHub repo to overwrite `agy-market` itself
  if (inspectRes.preflight.isForeignSelfCollision) {
    if (normalizedMode === 'replace') {
      throw new Error(
        `ERR_CANNOT_REPLACE_SELF: 禁止使用外部 GitHub 仓库覆盖 "${PLUGIN_ID}" 本体，请选择隔离安装 (${inspectRes.plugin.scopedName})。`,
      );
    }
  }

  const meta = preserveReceiptMeta && typeof preserveReceiptMeta === 'object' ? preserveReceiptMeta : null;
  const effectivePreserveId = String(meta?.id || _preserveReceiptId || '').trim();
  const effectiveTrack = ['verified', 'unverified', 'custom', 'github-url'].includes(meta?.track)
    ? meta.track
    : 'github-url';
  const effectivePreserveRepoId = Number(meta?.repositoryId || 0);
  const effectiveForceScopedInstall = Boolean(meta?.forceScopedInstall);
  const extraPreservePaths = Array.isArray(meta?.preservePaths) ? meta.preservePaths : [];

  const effectiveMode =
    normalizedMode ||
    (inspectRes.preflight.isForeignSelfCollision || effectiveForceScopedInstall ? 'isolate' : 'native');

  const conflictStrategy =
    effectiveMode === 'isolate'
      ? 'isolate'
      : effectiveMode === 'replace'
        ? 'replace'
        : 'prompt';

  const syntheticPlugin = buildSyntheticPluginRecord({
    inspectData: { plugin: inspectRes.plugin, resolution, parsed },
    installMode: effectiveMode,
    preserveReceiptId: effectivePreserveId,
    preserveTrackBranch: effectiveTrack === 'github-url' ? _preserveTrackBranch : '',
    preserveRepositoryId: effectivePreserveRepoId,
    preserveForceScopedInstall: effectiveForceScopedInstall,
    preservePaths: extraPreservePaths,
    includeGithubSource: effectiveTrack === 'github-url',
  });

  const installRes = await installOrUpdateCatalogPlugin({
    plugin: syntheticPlugin,
    track: effectiveTrack,
    prefs,
    conflictStrategy,
    preferredDir,
    confirmEscalation: Boolean(confirmEscalation),
    configDir,
    pluginsDir,
    dataDir,
    workspaceUris,
    builtinPluginsDir,
    fetchImpl: activeFetch,
    preverifiedArchivePath: archivePath,
    writeOverride,
  });

  if (installRes.ok && installRes.status === 'INSTALLED') {
    rmSync(stagingRootDir, { recursive: true, force: true });
    return {
      ...installRes,
      inspectToken: activeToken,
      pluginRoot: inspectRes.plugin.pluginRoot,
      repoUrl: inspectRes.plugin.repoUrl,
      commitSha: inspectRes.plugin.commitSha,
      sha256: inspectRes.plugin.sha256,
      catalogMatch: inspectRes.catalogMatch,
      isPublicRepo: Boolean(inspectRes.isPublicRepo),
      nomination: inspectRes.nomination || null,
    };
  }

  // Keep staging alive when awaiting conflict choice or escalation confirmation
  return {
    ...installRes,
    inspectToken: activeToken,
    catalogMatch: inspectRes.catalogMatch,
    isPublicRepo: Boolean(inspectRes.isPublicRepo),
    nomination: inspectRes.nomination || null,
  };
}

function findMatchingCatalogForLocalUpdate(loc, catalogPlugins = [], isSelf = false) {
  const list = Array.isArray(catalogPlugins) ? catalogPlugins : [];
  if (list.length === 0) return null;
  const receipt = loc?.receipt || null;
  if (receipt?.id) {
    const recRepoId = Number(receipt.repositoryId || 0);
    const byReceipt = list.find((p) => {
      const pRepoId = Number(p?.repository?.repositoryId || 0);
      if (recRepoId > 0 && pRepoId > 0) {
        return pRepoId === recRepoId && p.id === receipt.id;
      }
      return p.id === receipt.id;
    });
    if (byReceipt) return byReceipt;
  }
  const locRepo = normalizeRepoUrl(receipt?.repositoryUrl || loc?.repositoryUrl || '');
  if (locRepo) {
    const locRoot = normalizePluginRoot(receipt?.pluginRoot || '.');
    const byRepo = list.find((p) => {
      const pRepo = normalizeRepoUrl(p?.repository?.url);
      if (!pRepo || pRepo !== locRepo) return false;
      const pRoot = normalizePluginRoot(p?.repository?.pluginRoot || '.');
      if (receipt?.pluginRoot && pRoot !== locRoot) return false;
      return p.canonicalName === loc?.name || p.canonicalName === loc?.dir || p.scopedName === loc?.dir;
    });
    if (byRepo) return byRepo;
  }
  if (isSelf) {
    return list.find((p) => p.id === SELF_CATALOG_ID || p.canonicalName === PLUGIN_ID) || null;
  }
  return null;
}

/**
 * Resolves, stages, and updates any globally installed plugin with a valid GitHub repository URL
 * directly from upstream GitHub (Release tarball -> highest SemVer Tag -> default/tracked branch archive),
 * strictly preserving original catalog receipt metadata (`track`, `id`, `repositoryId`, `scopedRewriteApplied`),
 * `parkedByMarket`, `preservePaths`, T+N capability escalation checks, and official `agy-market` self-update guard.
 */
export async function resolveAndStageGithubUpdate({
  loc,
  catPlugin = null,
  updateHint = null,
  confirmEscalation = false,
  prefs = {},
  configDir = resolveAntigravityConfigDir(),
  pluginsDir = '',
  dataDir = resolveMarketDataDir(),
  workspaceUris = [],
  builtinPluginsDir = '',
  catalogPlugins = [],
  fetchImpl = defaultProxyFetch,
  githubApiBaseUrl = GITHUB_API_BASE_URL,
  timeoutMs = DEFAULT_API_TIMEOUT_MS,
  nowMs = Date.now(),
  writeOverride = null,
}) {
  const activeFetch = resolveEffectiveFetch(fetchImpl);
  if (loc?.scope && loc.scope !== 'global') {
    throw new Error(
      `ERR_CANNOT_UPDATE_NON_GLOBAL: Plugin "${loc?.dir || ''}" has scope="${loc.scope}" and cannot be updated in-place`,
    );
  }

  const receipt = loc?.receipt || null;
  const isSelf = Boolean(
    loc?.dir === PLUGIN_ID || loc?.name === PLUGIN_ID || receipt?.id === SELF_CATALOG_ID || catPlugin?.id === SELF_CATALOG_ID,
  );
  const matchedCatPlugin = catPlugin || findMatchingCatalogForLocalUpdate(loc, catalogPlugins, isSelf);

  const repoUrl = normalizeRepoUrl(
    updateHint?.repositoryUrl ||
      receipt?.repositoryUrl ||
      matchedCatPlugin?.repository?.url ||
      loc?.repositoryUrl ||
      (isSelf ? SELF_REPO_URL : ''),
  );
  if (!repoUrl || !/^https:\/\/github\.com\/[^/]+\/[^/]+$/i.test(repoUrl)) {
    throw new Error(
      `ERR_NO_UPDATE_SOURCE: Plugin "${loc?.dir || ''}" lacks a valid GitHub repository URL`,
    );
  }

  // Strictly block any non-official repository from overwriting agy-market itself
  if (isSelf && repoUrl !== normalizeRepoUrl(SELF_REPO_URL)) {
    throw new Error(
      `ERR_CANNOT_REPLACE_SELF: Official "${PLUGIN_ID}" can only self-update from ${SELF_REPO_URL}`,
    );
  }

  const pluginRoot = normalizePluginRoot(
    updateHint?.pluginRoot || receipt?.pluginRoot || matchedCatPlugin?.repository?.pluginRoot || '.',
  );
  const ghSource = receipt?.githubSource || {};
  const preserveTrackBranch =
    updateHint?.trackBranch ||
    ghSource.trackBranch ||
    (ghSource.refType === 'branch' && ghSource.ref && ghSource.ref !== 'HEAD' ? ghSource.ref : '');

  const validTracks = new Set(['verified', 'unverified', 'custom', 'github-url']);
  const catalogTrack = matchedCatPlugin
    ? matchedCatPlugin._track || (matchedCatPlugin.forceScopedInstall ? 'unverified' : 'verified')
    : '';
  const preservedTrack = validTracks.has(receipt?.track)
    ? receipt.track
    : catalogTrack || (isSelf ? 'verified' : 'github-url');
  const preservedId = String(receipt?.id || matchedCatPlugin?.id || (isSelf ? SELF_CATALOG_ID : '')).trim();
  const preservedRepoId = Number(receipt?.repositoryId || matchedCatPlugin?.repository?.repositoryId || 0);
  const preservedForceScoped = Boolean(
    receipt?.scopedRewriteApplied || (!receipt && matchedCatPlugin?.forceScopedInstall),
  );
  const preservedPaths = [
    ...new Set([
      ...(Array.isArray(receipt?.preservePaths) ? receipt.preservePaths : []),
      ...(Array.isArray(matchedCatPlugin?.distribution?.preservePaths)
        ? matchedCatPlugin.distribution.preservePaths
        : []),
    ]),
  ];

  const isTagOrReleaseTarget = Boolean(
    updateHint?.targetRef && updateHint.updateKind !== 'commit' && !FULL_SHA_RE.test(updateHint.targetRef),
  );

  let targetUrl = repoUrl;
  if (updateHint?.targetRef) {
    if (updateHint.updateKind === 'commit' || FULL_SHA_RE.test(updateHint.targetRef)) {
      targetUrl = `${repoUrl}/tree/${encodeURIComponent(updateHint.targetRef)}`;
    } else {
      targetUrl = `${repoUrl}/releases/tag/${encodePathSegments(updateHint.targetRef)}`;
    }
  } else if (receipt?.track === 'github-url' && ghSource.kind === 'tree' && preserveTrackBranch) {
    targetUrl =
      pluginRoot !== '.'
        ? `${repoUrl}/tree/${encodePathSegments(preserveTrackBranch)}/${encodePathSegments(pluginRoot)}`
        : `${repoUrl}/tree/${encodePathSegments(preserveTrackBranch)}`;
  }

  const installMode = isSelf ? 'replace' : preservedForceScoped ? 'isolate' : 'native';

  const result = await installGithubPlugin({
    url: targetUrl,
    pluginRoot,
    installMode,
    preferredDir: loc?.dir || '',
    confirmEscalation: Boolean(confirmEscalation),
    prefs,
    configDir,
    pluginsDir,
    dataDir,
    workspaceUris,
    builtinPluginsDir,
    catalogPlugins,
    fetchImpl: activeFetch,
    githubApiBaseUrl,
    timeoutMs,
    nowMs,
    writeOverride,
    preserveReceiptMeta: {
      id: preservedId,
      track: preservedTrack,
      repositoryId: preservedRepoId,
      forceScopedInstall: preservedForceScoped,
      preservePaths: preservedPaths,
    },
    _preserveReceiptId: preservedId,
    _preserveTrackBranch: preservedTrack === 'github-url' && !isTagOrReleaseTarget ? preserveTrackBranch : '',
  });

  if (result.status === 'NOT_A_PLUGIN_REPO' || result.status === 'SECURITY_BLOCKED') {
    throw new Error(`ERR_GITHUB_UPDATE_BLOCKED: ${result.reasonEn || result.reasonZh || result.status}`);
  }
  if (result.status === 'SUBPATH_SELECTION_REQUIRED') {
    throw new Error(`ERR_GITHUB_UPDATE_SUBPATH_MISSING: Subpath "${pluginRoot}" no longer contains plugin.json`);
  }

  return result;
}
