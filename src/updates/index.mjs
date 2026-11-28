// Remote GitHub + Live Catalog Auto Update Detection Engine (`src/updates/index.mjs`).
//
// Compares locally installed plugins (from `.agy-market-receipt.json` or `plugin.json` repository URL)
// against:
//   (a) the live catalog latest version (installable only when `distribution.tarballUrl` + 64-hex `sha256` exist)
//   (b) the repository's GitHub latest Release (`/releases/latest`) and highest SemVer tag (`/tags`) via api.github.com
//       using ETag (`If-None-Match`) + 30-minute TTL caching under `${dataDir}/cache/github`, graceful 403/429
//       rate-limit degradation, and optional `prefs.githubToken` (strictly never logged or cached).

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { findCatalogEntryForLocal, findManagedSuccessor, normalizeRepoUrl, resolveCatalogPluginRoot, samePluginName } from '../preflight/index.mjs';
import {
  GITHUB_API_BASE_URL,
  PLUGIN_DISPLAY_NAME,
  PLUGIN_ID,
  PLUGIN_VERSION,
  SELF_CATALOG_ID,
  SELF_REPO_URL,
  UPDATE_CHECK_CACHE_TTL_MS,
} from '../shared/constants.mjs';
import { defaultProxyFetch } from '../shared/proxy-fetch.mjs';
import { computeCapabilityEscalation, normalizePluginRoot, parseJsonc, sanitizePrefs } from '../shared/schemas.mjs';
import { compareSemver, isNewerVersion, parseSemver } from '../shared/semver.mjs';

const MAX_CHANGELOG_CHARS = 8000;
const DEFAULT_GITHUB_TIMEOUT_MS = 8000;
const MIN_RATELIMIT_BACKOFF_MS = 60 * 1000;
const DEFAULT_RATELIMIT_BACKOFF_MS = 5 * 60 * 1000;
const MAX_RATELIMIT_BACKOFF_MS = 60 * 60 * 1000;
const UPDATE_PROBE_CONCURRENCY = 4;

function resolveEffectiveFetch(fetchImpl) {
  return !fetchImpl || fetchImpl === fetch ? defaultProxyFetch : fetchImpl;
}

export function isUnmanagedNonUpdatableLocal(loc) {
  return Boolean(loc && (loc.isGitManaged || (!loc.receipt && loc.hasDeclaredVersion === false)));
}

export function redactSecret(text, secret = '') {
  const msg = String(text || '');
  if (!secret) return msg;
  return msg.split(secret).join('[REDACTED]');
}

export function getGithubCacheDir(dataDir) {
  const dir = join(dataDir, 'cache', 'github');
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function safeGithubCacheKey(owner, repo) {
  return `${String(owner || '').toLowerCase()}__${String(repo || '').toLowerCase()}`.replace(/[^a-z0-9_.-]/gi, '_');
}

function refCacheKey(ref, pluginRoot) {
  return createHash('sha256').update(JSON.stringify([ref, pluginRoot])).digest('hex');
}

export function parseGithubRepoSlug(rawUrl) {
  const norm = normalizeRepoUrl(rawUrl);
  if (!norm) return null;
  const m = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/i.exec(norm);
  if (!m) return null;
  const owner = m[1].toLowerCase();
  const repo = m[2].toLowerCase();
  return {
    owner,
    repo,
    fullName: `${owner}/${repo}`,
    url: `https://github.com/${owner}/${repo}`,
  };
}

export function isCatalogPluginInstallable(plugin) {
  const tarballUrl = String(plugin?.distribution?.tarballUrl || '').trim();
  const sha256 = String(plugin?.distribution?.sha256 || '').trim();
  return Boolean(tarballUrl && /^[0-9a-f]{64}$/i.test(sha256));
}

export function isOfficialMarketEntry(plugin) {
  return plugin?.id === SELF_CATALOG_ID && plugin.canonicalName === PLUGIN_ID &&
    normalizeRepoUrl(plugin.repository?.url) === SELF_REPO_URL &&
    normalizePluginRoot(plugin.repository?.pluginRoot) === '.' && !plugin.forceScopedInstall;
}

export function isForeignMarketInstall(loc) {
  const repo = normalizeRepoUrl(loc?.receipt?.repositoryUrl || loc?.repositoryUrl);
  return Boolean((loc?.receipt?.id && loc.receipt.id !== SELF_CATALOG_ID) || (repo && repo !== SELF_REPO_URL));
}

export function isRateLimitResponse(res, bodyText = '') {
  const status = Number(res?.status || 0);
  if (status === 429) return true;
  if (status !== 403) return false;
  const remaining = res?.headers?.get?.('x-ratelimit-remaining');
  const retryAfter = res?.headers?.get?.('retry-after');
  if (remaining === '0' || Boolean(retryAfter)) return true;
  const trimmed = String(bodyText || '').trim();
  if (!trimmed) return true;
  return /rate\s*limit|secondary rate|abuse detection/i.test(trimmed);
}

export function computeRateLimitResetMs(res, nowMs = Date.now()) {
  const retryAfterRaw = res?.headers?.get?.('retry-after');
  if (retryAfterRaw) {
    const secs = Number(retryAfterRaw);
    if (Number.isFinite(secs) && secs > 0) {
      return Math.min(nowMs + MAX_RATELIMIT_BACKOFF_MS, Math.max(nowMs + MIN_RATELIMIT_BACKOFF_MS, nowMs + secs * 1000));
    }
  }
  const resetEpochRaw = res?.headers?.get?.('x-ratelimit-reset');
  if (resetEpochRaw) {
    const resetEpochSec = Number(resetEpochRaw);
    if (Number.isFinite(resetEpochSec) && resetEpochSec > 0) {
      const target = resetEpochSec * 1000;
      if (target > nowMs) {
        return Math.min(nowMs + MAX_RATELIMIT_BACKOFF_MS, Math.max(nowMs + MIN_RATELIMIT_BACKOFF_MS, target));
      }
    }
  }
  return nowMs + DEFAULT_RATELIMIT_BACKOFF_MS;
}

function readJsonSafe(filePath) {
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function writeJsonSafe(filePath, data) {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
    renameSync(tmp, filePath);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      /* ignore */
    }
    throw err;
  }
}

function truncateChangelog(raw, maxLen = MAX_CHANGELOG_CHARS) {
  const text = String(raw || '').trim();
  if (!text) return '';
  if (text.length <= maxLen) return text;
  return `${text.slice(0, maxLen).trimEnd()}\n…`;
}

function buildGithubHeaders(token = '', etag = '') {
  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'agy-market-updater/1.0',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  if (etag) {
    headers['If-None-Match'] = etag;
  }
  return headers;
}

export function pickBestGithubReleaseOrTag({ latestRelease = null, highestTag = null } = {}) {
  if (!latestRelease && !highestTag) return null;
  const useRelease = latestRelease && (!highestTag || compareSemver(latestRelease.version, highestTag.version) >= 0);
  const best = useRelease ? latestRelease : highestTag;
  return {
    version: best.version,
    tagName: best.tagName,
    source: useRelease ? 'github-release' : 'github-tag',
    releaseUrl: best.releaseUrl,
    changelog: useRelease ? best.changelog || '' : '',
    publishedAt: useRelease ? best.publishedAt || null : null,
  };
}

export function readRateLimitState(cacheDir) {
  return readJsonSafe(join(cacheDir, '_ratelimit.json'));
}

export function writeRateLimitState(cacheDir, { resetAtMs, authenticated, nowMs }) {
  writeJsonSafe(join(cacheDir, '_ratelimit.json'), {
    schemaVersion: 1,
    resetAtMs,
    authenticated: Boolean(authenticated),
    recordedAt: new Date(nowMs).toISOString(),
  });
}

export function isRateLimitBackoffActive(rateLimitState, { nowMs, authenticated }) {
  if (!rateLimitState || !Number.isFinite(rateLimitState.resetAtMs)) return false;
  // Adding a GitHub token immediately lifts an unauthenticated rate-limit pause
  if (!rateLimitState.authenticated && authenticated) return false;
  return nowMs < rateLimitState.resetAtMs;
}

/**
 * Zero-quota GitHub Release redirect probe (adopted from dsh-market `src/release-updates.ts:L12-L34`).
 * Used as a fallback ONLY when `api.github.com` is 403/429 rate-limited: `HEAD /releases/latest`
 * with `redirect: 'manual'` consumes zero REST API quota and returns a `301`/`302` `Location`
 * ending in `/releases/tag/<tag>`.
 */
export async function probeGithubLatestReleaseRedirect({
  owner,
  repo,
  fetchImpl = defaultProxyFetch,
  timeoutMs = DEFAULT_GITHUB_TIMEOUT_MS,
}) {
  const activeFetch = resolveEffectiveFetch(fetchImpl);
  const url = `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/releases/latest`;
  try {
    const res = await activeFetch(url, {
      method: 'HEAD',
      redirect: 'manual',
      headers: { 'User-Agent': 'agy-market-updater/1.0' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status !== 301 && res.status !== 302) return null;
    const loc = String(res.headers?.get?.('location') || '').trim();
    const m = /\/releases\/tag\/([^/?#]+)/i.exec(loc);
    if (!m) return null;
    const tagName = decodeURIComponent(m[1]);
    const sem = parseSemver(tagName);
    if (!sem || sem.prerelease.length > 0) return null;
    return {
      version: sem.version,
      tagName,
      releaseUrl: `https://github.com/${owner}/${repo}/releases/tag/${encodeURIComponent(tagName)}`,
      changelog: '',
      publishedAt: null,
    };
  } catch {
    return null;
  }
}

function encodePathSegments(rawPath) {
  return String(rawPath || '')
    .split('/')
    .filter(Boolean)
    .map((seg) => encodeURIComponent(seg))
    .join('/');
}

function decodeXmlEntities(raw) {
  return String(raw || '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .trim();
}

/**
 * Parses Git Smart HTTP `info/refs?service=git-upload-pack` output (both pkt-line wire format and
 * plain line format) to extract `HEAD`, `defaultBranch`, branch SHAs, and highest non-prerelease SemVer tag.
 */
export function parseGitUploadPackRefs(rawText) {
  const text = String(rawText || '');
  const heads = new Map();
  const tags = new Map();
  let headSha = '';
  let defaultBranch = '';

  let pos = 0;
  while (pos + 4 <= text.length) {
    const lenHex = text.slice(pos, pos + 4);
    if (!/^[0-9a-f]{4}$/i.test(lenHex)) break;
    const pktLen = parseInt(lenHex, 16);
    if (pktLen === 0) {
      pos += 4;
      continue;
    }
    if (pktLen < 4 || pos + pktLen > text.length) break;
    const payload = text.slice(pos + 4, pos + pktLen).replace(/\r?\n$/, '');
    pos += pktLen;
    if (!payload || payload.startsWith('#')) continue;

    const nulIdx = payload.indexOf('\0');
    const refPart = nulIdx === -1 ? payload : payload.slice(0, nulIdx);
    const capsPart = nulIdx === -1 ? '' : payload.slice(nulIdx + 1);

    if (capsPart) {
      const sym = /\bsymref=HEAD:refs\/heads\/([^\s]+)/.exec(capsPart);
      if (sym && sym[1]) defaultBranch = sym[1];
    }

    const sp = refPart.indexOf(' ');
    if (sp === -1) continue;
    const sha = refPart.slice(0, sp).trim();
    const refName = refPart.slice(sp + 1).trim();
    if (!/^[0-9a-f]{40}$/i.test(sha)) continue;

    if (refName === 'HEAD') {
      headSha = sha.toLowerCase();
    } else if (refName.startsWith('refs/heads/')) {
      heads.set(refName.slice('refs/heads/'.length), sha.toLowerCase());
    } else if (refName.startsWith('refs/tags/')) {
      const rawTag = refName.slice('refs/tags/'.length);
      if (rawTag.endsWith('^{}')) {
        tags.set(rawTag.slice(0, -3), sha.toLowerCase());
      } else if (!tags.has(rawTag)) {
        tags.set(rawTag, sha.toLowerCase());
      }
    }
  }

  // Fallback for plain line-based output (e.g., simplified test fixtures)
  if (!headSha && heads.size === 0 && tags.size === 0) {
    for (const rawLine of text.split(/\r?\n/)) {
      const m = /([0-9a-f]{40})\s+(HEAD|refs\/(?:heads|tags)\/[^\s\0]+)/i.exec(rawLine);
      if (!m) continue;
      const sha = m[1].toLowerCase();
      const refName = m[2];
      const sym = /\bsymref=HEAD:refs\/heads\/([^\s]+)/.exec(rawLine);
      if (sym && sym[1] && !defaultBranch) defaultBranch = sym[1];
      if (refName === 'HEAD') headSha = sha;
      else if (refName.startsWith('refs/heads/')) heads.set(refName.slice('refs/heads/'.length), sha);
      else if (refName.startsWith('refs/tags/')) {
        const rawTag = refName.slice('refs/tags/'.length);
        if (rawTag.endsWith('^{}')) tags.set(rawTag.slice(0, -3), sha);
        else if (!tags.has(rawTag)) tags.set(rawTag, sha);
      }
    }
  }

  let highestSemverTag = null;
  for (const [tagName, sha] of tags.entries()) {
    const sem = parseSemver(tagName);
    if (!sem || sem.prerelease.length > 0) continue;
    if (!highestSemverTag || compareSemver(sem.version, highestSemverTag.version) > 0) {
      highestSemverTag = { version: sem.version, tagName, commitSha: sha };
    }
  }

  return { headSha, defaultBranch, heads, tags, highestSemverTag };
}

/**
 * Zero-API-quota Git Smart HTTP `info/refs?service=git-upload-pack` probe.
 * Discovers `defaultBranch`, branch tip commit SHAs, and SemVer tags without touching `api.github.com`.
 */
export async function probeGithubGitRefs({
  owner,
  repo,
  fetchImpl = defaultProxyFetch,
  timeoutMs = DEFAULT_GITHUB_TIMEOUT_MS,
}) {
  const activeFetch = resolveEffectiveFetch(fetchImpl);
  const url = `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}.git/info/refs?service=git-upload-pack`;
  try {
    const res = await activeFetch(url, {
      headers: { 'User-Agent': 'git/2.45.0 agy-market-updater/1.0' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const text = await res.text();
    const parsed = parseGitUploadPackRefs(text);
    if (!parsed.headSha && parsed.heads.size === 0 && parsed.tags.size === 0) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Zero-API-quota GitHub Atom commit feed probe (`/commits/<branch>[/<subpath>].atom`).
 */
export async function probeGithubBranchAtom({
  owner,
  repo,
  branch = 'HEAD',
  pluginRoot = '.',
  etag = '',
  fetchImpl = defaultProxyFetch,
  timeoutMs = DEFAULT_GITHUB_TIMEOUT_MS,
}) {
  const activeFetch = resolveEffectiveFetch(fetchImpl);
  const normRoot = normalizePluginRoot(pluginRoot);
  const subPart = normRoot !== '.' ? `/${encodePathSegments(normRoot)}` : '';
  const refSeg = encodePathSegments(branch || 'HEAD');
  const url = `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/${refSeg}${subPart}.atom`;
  const headers = {
    Accept: 'application/atom+xml, application/xml, text/xml',
    'User-Agent': 'agy-market-updater/1.0',
  };
  if (etag) headers['If-None-Match'] = etag;
  try {
    const res = await activeFetch(url, {
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status === 304) {
      return { notModified: true, etag: res.headers?.get?.('etag') || etag };
    }
    if (!res.ok) return null;
    const xml = await res.text();
    const entryMatch = /<entry\b[\s\S]*?<\/entry>/i.exec(xml);
    const scope = entryMatch ? entryMatch[0] : xml;
    const shaMatch =
      /Grit::Commit\/([0-9a-f]{40})/i.exec(scope) || /\/commit\/([0-9a-f]{40})/i.exec(scope);
    if (!shaMatch) return null;
    const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(scope);
    const updatedMatch = /<updated[^>]*>([\s\S]*?)<\/updated>/i.exec(scope);
    return {
      notModified: false,
      commitSha: shaMatch[1].toLowerCase(),
      message: titleMatch ? truncateChangelog(decodeXmlEntities(titleMatch[1]), 400) : '',
      committedAt: updatedMatch ? updatedMatch[1].trim() : null,
      etag: res.headers?.get?.('etag') || '',
    };
  } catch {
    return null;
  }
}

async function probeRawPluginManifest({
  owner,
  repo,
  ref,
  pluginRoot = '.',
  token = '',
  githubApiBaseUrl = GITHUB_API_BASE_URL,
  fetchImpl = defaultProxyFetch,
  timeoutMs = 4000,
}) {
  const activeFetch = resolveEffectiveFetch(fetchImpl);
  const normRoot = normalizePluginRoot(pluginRoot);
  const candidates =
    normRoot !== '.'
      ? [`${normRoot}/plugin.json`, `${normRoot}/.antigravity-plugin/plugin.json`]
      : ['plugin.json', '.antigravity-plugin/plugin.json'];

  let saw404 = false;
  let sawError = false;
  const requests = candidates.map(path => ({
    url: `https://raw.githubusercontent.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${encodeURIComponent(ref)}/${encodePathSegments(path)}`,
    headers: { 'User-Agent': 'agy-market-updater/1.0' },
  }));
  if (token) {
    const base = githubApiBaseUrl.replace(/\/+$/, '');
    requests.unshift(...candidates.map(path => ({
      url: `${base}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodePathSegments(path)}?ref=${encodeURIComponent(ref)}`,
      headers: { ...buildGithubHeaders(token), Accept: 'application/vnd.github.raw+json' },
    })));
  }
  for (const { url, headers } of requests) {
    try {
      const res = await activeFetch(url, {
        headers,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.status === 404 || res.status === 410) {
        saw404 = true;
        continue;
      }
      if (!res.ok) {
        sawError = true;
        continue;
      }
      const manifest = parseJsonc(await res.text());
      if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
        return { found: false, status: 200, name: '', version: '', invalid: true };
      }
      const sem = parseSemver(manifest?.version);
      return {
        found: true,
        status: 200,
        name: typeof manifest.name === 'string' ? manifest.name.trim() : '',
        version: sem ? sem.version : '',
        rawVersion: typeof manifest.version === 'string' ? manifest.version.trim() : '',
      };
    } catch {
      sawError = true;
    }
  }
  return {
    found: false,
    status: saw404 && !sawError ? 404 : 0,
    name: '',
    version: '',
    transientError: sawError,
  };
}

async function probeRawManifestVersion({
  owner,
  repo,
  commitSha,
  pluginRoot = '.',
  token = '',
  githubApiBaseUrl = GITHUB_API_BASE_URL,
  fetchImpl = defaultProxyFetch,
  timeoutMs = 4000,
}) {
  const res = await probeRawPluginManifest({
    owner,
    repo,
    ref: commitSha,
    pluginRoot,
    token, githubApiBaseUrl,
    fetchImpl,
    timeoutMs,
  });
  return res?.found && res.version ? res.version : '';
}

async function probeRawManifestForTagCached({
  owner,
  repo,
  tagName,
  pluginRoot = '.',
  token = '',
  githubApiBaseUrl = GITHUB_API_BASE_URL,
  dataDir,
  force = false,
  fetchImpl = defaultProxyFetch,
  nowMs = Date.now(),
  ttlMs = UPDATE_CHECK_CACHE_TTL_MS,
  timeoutMs = DEFAULT_GITHUB_TIMEOUT_MS,
  shouldPersistCache = () => true,
}) {
  const normRoot = normalizePluginRoot(pluginRoot);
  const cacheDir = dataDir ? getGithubCacheDir(dataDir) : '';
  const tagSlug = refCacheKey(tagName, normRoot) + (token ? '-auth' : '');
  const cachePath = cacheDir ? join(cacheDir, `raw-${safeGithubCacheKey(owner, repo)}-${tagSlug}.json`) : '';
  const cached = cachePath ? readJsonSafe(cachePath) : null;

  if (!force && cached && Number.isFinite(cached.checkedAtMs) && nowMs - cached.checkedAtMs < ttlMs) {
    return cached.result || { found: false, status: 404, name: '', version: '' };
  }

  const result = await probeRawPluginManifest({
    owner,
    repo,
    ref: tagName,
    pluginRoot: normRoot,
    token, githubApiBaseUrl,
    fetchImpl,
    timeoutMs: Math.min(timeoutMs, 5000),
  });

  if (cachePath && !result.transientError && shouldPersistCache()) {
    writeJsonSafe(cachePath, {
      schemaVersion: 1,
      repo: `${owner}/${repo}`,
      tagName,
      pluginRoot: normRoot,
      checkedAt: new Date(nowMs).toISOString(),
      checkedAtMs: nowMs,
      result,
    });
  }

  return result;
}

/**
 * Probes the latest commit SHA (and optional `plugin.json.version`) on a tracked branch for
 * tagless `track === 'github-url'` plugins. Uses REST API with ETag + 30-min TTL when available,
 * and seamlessly falls back to zero-quota Atom feed + `git-upload-pack` `info/refs` when rate-limited.
 */
export async function probeGithubBranchHead({
  owner,
  repo,
  branch = 'HEAD',
  pluginRoot = '.',
  installedCommitSha = '',
  dataDir,
  prefs = {},
  force = false,
  fetchImpl = defaultProxyFetch,
  nowMs = Date.now(),
  ttlMs = UPDATE_CHECK_CACHE_TTL_MS,
  githubApiBaseUrl = GITHUB_API_BASE_URL,
  timeoutMs = DEFAULT_GITHUB_TIMEOUT_MS,
  skipNetworkBecauseRateLimited = false,
  shouldPersistCache = () => true,
}) {
  const activeFetch = resolveEffectiveFetch(fetchImpl);
  const cleanPrefs = sanitizePrefs(prefs);
  const token = cleanPrefs.githubToken;
  const authenticated = Boolean(token);
  const normRoot = normalizePluginRoot(pluginRoot);
  const requestedBranch = String(branch || '').trim() || 'HEAD';
  const cacheDir = getGithubCacheDir(dataDir);
  const branchSlug = refCacheKey(requestedBranch, normRoot);
  const cachePath = join(cacheDir, `branch-${safeGithubCacheKey(owner, repo)}-${branchSlug}.json`);
  // Older subdirectory entries mixed whole-archive SHAs with path-limited commit history.
  const stored = readJsonSafe(cachePath);
  const cached = stored?.schemaVersion === 4 ? stored : null;
  const installedSha = String(installedCommitSha || '').trim().toLowerCase();
  const apiBase = String(githubApiBaseUrl || GITHUB_API_BASE_URL).replace(/\/+$/, '');
  const fullName = `${owner}/${repo}`;

  if (!force && cached && (cached.installedCommitSha === installedSha || cached.head?.commitSha === installedSha) &&
      Number.isFinite(cached.checkedAtMs) && nowMs - cached.checkedAtMs < ttlMs) {
    return {
      checked: Boolean(cached.head),
      head: cached.head || null,
      fromCache: true,
      rateLimited: false,
      warning: null,
    };
  }

  const rlState = readRateLimitState(cacheDir);
  let rateLimited =
    skipNetworkBecauseRateLimited || (!force && isRateLimitBackoffActive(rlState, { nowMs, authenticated }));

  let head = cached?.head || null;
  let apiEtag = cached?.apiEtag || '';
  let atomEtag = cached?.atomEtag || '';
  let resolvedBranch = cached?.resolvedBranch || (requestedBranch !== 'HEAD' ? requestedBranch : '');
  let anySuccess = false;
  const warnings = [];

  // Layer 1: GitHub REST API commit check (with ETag 304)
  if (!rateLimited) {
    const apiUrl = `${apiBase}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/${encodeURIComponent(requestedBranch)}`;
    try {
      const res = await activeFetch(apiUrl, {
        headers: buildGithubHeaders(token, apiEtag),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.status === 304) {
        anySuccess = true;
      } else if (res.status === 200) {
        const raw = await res.json();
        const entry = Array.isArray(raw) ? raw[0] : raw;
        const sha = String(entry?.sha || '').trim().toLowerCase();
        if (/^[0-9a-f]{40}$/.test(sha)) {
          const msg = String(entry?.commit?.message || '').split(/\r?\n/)[0] || '';
          head = {
            commitSha: sha,
            message: truncateChangelog(msg, 400),
            committedAt: entry?.commit?.committer?.date || entry?.commit?.author?.date || null,
            branch: resolvedBranch || requestedBranch,
            remoteVersion: head?.commitSha === sha ? head.remoteVersion || '' : '',
          };
          apiEtag = res.headers?.get?.('etag') || '';
          atomEtag = '';
          anySuccess = true;
        }
      } else if (res.status === 403 || res.status === 429) {
        const bodyText = await res.text().catch(() => '');
        if (isRateLimitResponse(res, bodyText)) {
          rateLimited = true;
          const resetAtMs = computeRateLimitResetMs(res, nowMs);
          writeRateLimitState(cacheDir, { resetAtMs, authenticated, nowMs });
          warnings.push(`GitHub API rate limit reached (HTTP ${res.status}) while checking branch for ${fullName}; using zero-quota fallback.`);
        }
      }
    } catch (err) {
      warnings.push(redactSecret(`GitHub branch probe error for ${fullName}: ${err?.message || String(err)}`, token));
    }
  }

  // Layer 2: Zero-API-quota fallback (Atom feed -> git-upload-pack info/refs)
  if (!anySuccess) {
    const atomRes = await probeGithubBranchAtom({
      owner,
      repo,
      branch: resolvedBranch || requestedBranch,
      etag: atomEtag,
      fetchImpl: activeFetch,
      timeoutMs,
    });
    if (atomRes?.notModified) {
      anySuccess = true;
    } else if (atomRes?.commitSha) {
      head = {
        commitSha: atomRes.commitSha,
        message: atomRes.message || '',
        committedAt: atomRes.committedAt || null,
        branch: resolvedBranch || requestedBranch,
        remoteVersion: head?.commitSha === atomRes.commitSha ? head.remoteVersion || '' : '',
      };
      atomEtag = atomRes.etag || '';
      apiEtag = '';
      anySuccess = true;
    } else {
      const gitRefs = await probeGithubGitRefs({ owner, repo, fetchImpl: activeFetch, timeoutMs });
      if (gitRefs) {
        const targetBranch =
          requestedBranch !== 'HEAD' ? requestedBranch : gitRefs.defaultBranch || 'main';
        const sha = gitRefs.heads.get(targetBranch) || (requestedBranch === 'HEAD' ? gitRefs.headSha : '');
        if (/^[0-9a-f]{40}$/.test(sha)) {
          resolvedBranch = targetBranch;
          apiEtag = '';
          atomEtag = '';
          head = {
            commitSha: sha,
            message: head?.commitSha === sha ? head.message || '' : '',
            committedAt: head?.commitSha === sha ? head.committedAt || null : null,
            branch: targetBranch,
            remoteVersion: head?.commitSha === sha ? head.remoteVersion || '' : '',
          };
          anySuccess = true;
        } else if (requestedBranch !== 'HEAD') {
          head = null;
          warnings.push(`Tracked branch "${requestedBranch}" was not advertised by ${fullName}.`);
        }
      }
    }
  }

  // Receipts identify the archived repository commit. When the branch moves,
  // check the selected directory at both immutable revisions before offering an update.
  if (anySuccess && normRoot !== '.' && installedSha && head?.commitSha && head.commitSha !== installedSha) {
    const previous = cached?.head;
    if (previous?.commitSha === head.commitSha && cached.installedCommitSha === installedSha &&
        typeof previous.subtreeChanged === 'boolean') {
      head = { ...head, subtreeChanged: previous.subtreeChanged };
    } else {
      const lastChangeAt = async sha => {
        if (!rateLimited) {
          const url = new URL(`${apiBase}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits`);
          url.search = new URLSearchParams({ sha, path: normRoot, per_page: '1' });
          try {
            const res = await activeFetch(url.href, { headers: buildGithubHeaders(token), signal: AbortSignal.timeout(timeoutMs) });
            if (res.ok) {
              const id = (await res.json())?.[0]?.sha;
              if (FULL_COMMIT_SHA_RE.test(id)) return id.toLowerCase();
            }
          } catch { /* Try the immutable revision's Atom history. */ }
        }
        return (await probeGithubBranchAtom({ owner, repo, branch: sha, pluginRoot: normRoot, fetchImpl: activeFetch, timeoutMs }))?.commitSha || '';
      };
      const [installedChange, latestChange] = await Promise.all([lastChangeAt(installedSha), lastChangeAt(head.commitSha)]);
      if (installedChange && latestChange) {
        head = { ...head, subtreeChanged: installedChange !== latestChange };
      } else {
        anySuccess = false;
        head = { ...head, subtreeChanged: null };
        warnings.push(`Could not verify changes to ${normRoot} in ${fullName}.`);
      }
    }
  } else if (head) {
    head = { ...head, subtreeChanged: null };
  }

  // Optional raw `plugin.json` version lookup when commit SHA changed
  if (
    anySuccess && head?.subtreeChanged !== false && head?.commitSha &&
    installedCommitSha &&
    head.commitSha.toLowerCase() !== String(installedCommitSha).trim().toLowerCase() &&
    !head.remoteVersion
  ) {
    const remoteVer = await probeRawManifestVersion({
      owner,
      repo,
      commitSha: head.commitSha,
      pluginRoot: normRoot,
      token, githubApiBaseUrl,
      fetchImpl: activeFetch,
      timeoutMs: Math.min(4000, timeoutMs),
    });
    if (remoteVer) {
      head = { ...head, remoteVersion: remoteVer };
    }
  }

  if ((anySuccess || cached) && shouldPersistCache()) {
    writeJsonSafe(cachePath, {
      schemaVersion: 4,
      installedCommitSha: installedSha,
      repo: fullName,
      branch: resolvedBranch || requestedBranch,
      pluginRoot: normRoot,
      checkedAt: new Date(nowMs).toISOString(),
      checkedAtMs: anySuccess ? nowMs : null,
      resolvedBranch,
      apiEtag,
      atomEtag,
      head,
    });
  }

  return {
    head,
    checked: anySuccess && Boolean(head),
    fromCache: false,
    rateLimited,
    warning: warnings.length > 0 ? warnings.join(' ') : null,
  };
}

/**
 * Probes GitHub Releases (`/releases/latest`) and SemVer Tags (`/tags?per_page=30`) for `owner/repo`
 * with ETag (`If-None-Match`) + 30-minute TTL disk caching in `${dataDir}/cache/github/`.
 */
export async function probeGithubRepoUpdates({
  owner,
  repo,
  dataDir,
  prefs = {},
  force = false,
  fetchImpl = defaultProxyFetch,
  nowMs = Date.now(),
  ttlMs = UPDATE_CHECK_CACHE_TTL_MS,
  githubApiBaseUrl = GITHUB_API_BASE_URL,
  timeoutMs = DEFAULT_GITHUB_TIMEOUT_MS,
  skipNetworkBecauseRateLimited = false,
  shouldPersistCache = () => true,
}) {
  const activeFetch = resolveEffectiveFetch(fetchImpl);
  const cleanPrefs = sanitizePrefs(prefs);
  const token = cleanPrefs.githubToken;
  const authenticated = Boolean(token);
  const cacheDir = getGithubCacheDir(dataDir);
  const cachePath = join(cacheDir, `updates-${safeGithubCacheKey(owner, repo)}.json`);
  const cached = readJsonSafe(cachePath);
  const apiBase = String(githubApiBaseUrl || GITHUB_API_BASE_URL).replace(/\/+$/, '');
  const fullName = `${owner}/${repo}`;

  // 1. Local TTL cache hit when not forced
  if (!force && cached && Number.isFinite(cached.checkedAtMs) && nowMs - cached.checkedAtMs < ttlMs) {
    return {
      checked: true,
      latest: pickBestGithubReleaseOrTag(cached),
      fromCache: true,
      rateLimited: false,
      warning: null,
    };
  }

  // 2. Respect active rate-limit backoff (or short-circuit within the same pass)
  const rlState = readRateLimitState(cacheDir);
  if (skipNetworkBecauseRateLimited || (!force && isRateLimitBackoffActive(rlState, { nowMs, authenticated }))) {
    const redirectFallback =
      apiBase === GITHUB_API_BASE_URL
        ? await probeGithubLatestReleaseRedirect({ owner, repo, fetchImpl: activeFetch, timeoutMs })
        : null;
    const mergedRelease =
      redirectFallback && (!cached?.latestRelease || compareSemver(redirectFallback.version, cached.latestRelease.version) > 0)
        ? redirectFallback
        : cached?.latestRelease || null;
    return {
      checked: false, // The redirect cannot verify tags during rate limiting.
      latest: pickBestGithubReleaseOrTag({ latestRelease: mergedRelease, highestTag: cached?.highestTag || null }),
      fromCache: Boolean(cached) && !redirectFallback,
      rateLimited: true,
      warning: `GitHub API rate limit active for ${fullName}; using cached/catalog metadata.`,
    };
  }

  let latestRelease = cached?.latestRelease || null;
  let releaseEtag = cached?.releaseEtag || '';
  let highestTag = cached?.highestTag || null;
  let tagsEtag = cached?.tagsEtag || '';
  let anySuccess = false;
  let partialFailure = false;
  let rateLimited = false;
  const warnings = [];

  // 3. Query `/repos/{owner}/{repo}/releases/latest`
  const releaseUrl = `${apiBase}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/releases/latest`;
  try {
    const res = await activeFetch(releaseUrl, {
      headers: buildGithubHeaders(token, releaseEtag),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (res.status === 304) {
      anySuccess = true;
    } else if (res.status === 200) {
      const data = await res.json();
      const sem = parseSemver(data?.tag_name);
      if (sem && sem.prerelease.length === 0 && !data?.draft && !data?.prerelease) {
        latestRelease = {
          version: sem.version,
          tagName: String(data.tag_name),
          releaseUrl:
            typeof data.html_url === 'string' && data.html_url.trim()
              ? data.html_url.trim()
              : `https://github.com/${owner}/${repo}/releases/tag/${encodeURIComponent(data.tag_name)}`,
          changelog: truncateChangelog(data.body),
          publishedAt: data.published_at || data.created_at || null,
        };
      } else {
        latestRelease = null;
      }
      releaseEtag = res.headers?.get?.('etag') || '';
      anySuccess = true;
    } else if (res.status === 404) {
      latestRelease = null;
      releaseEtag = res.headers?.get?.('etag') || '';
      anySuccess = true;
    } else {
      partialFailure = true;
      const bodyText = await res.text().catch(() => '');
      if (isRateLimitResponse(res, bodyText)) {
        rateLimited = true;
        const resetAtMs = computeRateLimitResetMs(res, nowMs);
        writeRateLimitState(cacheDir, { resetAtMs, authenticated, nowMs });
        warnings.push(`GitHub API rate limit reached (HTTP ${res.status}) while checking ${fullName}.`);
      } else {
        warnings.push(`GitHub releases probe failed for ${fullName} (HTTP ${res.status}).`);
      }
    }
  } catch (err) {
    partialFailure = true;
    warnings.push(redactSecret(`GitHub releases probe error for ${fullName}: ${err?.message || String(err)}`, token));
  }

  // Zero-quota HEAD redirect fallback if `api.github.com` returned 403/429 rate-limit
  if (rateLimited && apiBase === GITHUB_API_BASE_URL) {
    const redirectFallback = await probeGithubLatestReleaseRedirect({ owner, repo, fetchImpl: activeFetch, timeoutMs });
    if (
      redirectFallback &&
      (!latestRelease || compareSemver(redirectFallback.version, latestRelease.version) > 0)
    ) {
      latestRelease = redirectFallback;
    }
  }

  // 4. Query `/repos/{owner}/{repo}/tags?per_page=30` (skipped if rate-limited above)
  if (!rateLimited) {
    const tagsUrl = `${apiBase}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/tags?per_page=30`;
    try {
      const res = await activeFetch(tagsUrl, {
        headers: buildGithubHeaders(token, tagsEtag),
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (res.status === 304) {
        anySuccess = true;
      } else if (res.status === 200) {
        const rawTags = await res.json();
        let best = null;
        for (const t of Array.isArray(rawTags) ? rawTags : []) {
          const tagName = String(t?.name || '').trim();
          const sem = parseSemver(tagName);
          if (!sem || sem.prerelease.length > 0) continue;
          if (!best || compareSemver(sem.version, best.version) > 0) {
            best = {
              version: sem.version,
              tagName,
              releaseUrl: `https://github.com/${owner}/${repo}/releases/tag/${encodeURIComponent(tagName)}`,
            };
          }
        }
        highestTag = best;
        tagsEtag = res.headers?.get?.('etag') || '';
        anySuccess = true;
      } else if (res.status === 404) {
        highestTag = null;
        tagsEtag = res.headers?.get?.('etag') || '';
        anySuccess = true;
      } else {
        partialFailure = true;
        const bodyText = await res.text().catch(() => '');
        if (isRateLimitResponse(res, bodyText)) {
          rateLimited = true;
          const resetAtMs = computeRateLimitResetMs(res, nowMs);
          writeRateLimitState(cacheDir, { resetAtMs, authenticated, nowMs });
          warnings.push(`GitHub API rate limit reached (HTTP ${res.status}) while checking tags for ${fullName}.`);
        } else {
          warnings.push(`GitHub tags probe failed for ${fullName} (HTTP ${res.status}).`);
        }
      }
    } catch (err) {
      partialFailure = true;
      warnings.push(redactSecret(`GitHub tags probe error for ${fullName}: ${err?.message || String(err)}`, token));
    }
  }

  // Persist sanitized cache (strictly zero secrets/tokens).
  // Mirrors dsh-market's partial-failure rule: preserve confirmed data, but do not stamp a fresh
  // 30-min TTL when a sub-probe failed so the next refresh can retry immediately.
  if ((anySuccess || cached) && shouldPersistCache()) {
    writeJsonSafe(cachePath, {
      schemaVersion: 1,
      repo: fullName,
      checkedAt: new Date(nowMs).toISOString(),
      checkedAtMs: partialFailure ? null : nowMs,
      releaseEtag,
      tagsEtag,
      latestRelease,
      highestTag,
    });
  }

  return {
    checked: anySuccess && !partialFailure,
    latest: pickBestGithubReleaseOrTag({ latestRelease, highestTag }),
    fromCache: false,
    rateLimited,
    warning: warnings.length > 0 ? warnings.join(' ') : null,
  };
}

const FULL_COMMIT_SHA_RE = /^[0-9a-f]{40}$/i;

export function isSameInstalledRelease(receipt, { gitTag = '', commitSha = '' } = {}) {
  if (!receipt || typeof receipt !== 'object') return false;
  const recTag = String(receipt.gitTag || '').trim().toLowerCase();
  const remTag = String(gitTag || '').trim().toLowerCase();
  const recSha = String(receipt.commitSha || '').trim().toLowerCase();
  const remSha = String(commitSha || '').trim().toLowerCase();

  if (recTag && remTag) {
    if (recTag !== remTag) return false;
    if (recSha && remSha && recSha !== remSha) return false;
    return true;
  }

  if (FULL_COMMIT_SHA_RE.test(recSha) && FULL_COMMIT_SHA_RE.test(remSha) && recSha === remSha) {
    return true;
  }

  return false;
}

function enforceUpdateItemInvariant(item) {
  if (!item || typeof item !== 'object') return null;
  if (item.updateKind === 'commit') {
    const curSha = String(item.installedCommitSha || '').trim().toLowerCase();
    const nextSha = String(item.latestCommitSha || '').trim().toLowerCase();
    return curSha && nextSha && curSha !== nextSha ? item : null;
  }
  const latestVer = String(item.latestVersion || '').trim();
  const curVer = String(item.installedVersion || '').trim();
  return latestVer && isNewerVersion(latestVer, curVer) ? item : null;
}

function buildUpdateItem({
  id,
  dir,
  displayName,
  installedVersion,
  catPlugin,
  receipt,
  installedCapabilities = null,
  repositoryUrl = '',
  repositoryRoot,
  ghSlug,
  ghLatest,
  branchHead = null,
  isSelf,
}) {
  const isGithubUrlTrack = Boolean(receipt?.track === 'github-url' && !isSelf);
  const catalogInstallable = isCatalogPluginInstallable(catPlugin);
  const sameCatalogRelease = Boolean(
    catPlugin && isSameInstalledRelease(receipt, { gitTag: catPlugin.gitTag, commitSha: catPlugin.commitSha }),
  );
  const sameGithubRelease = Boolean(
    ghLatest && isSameInstalledRelease(receipt, { gitTag: ghLatest.tagName, commitSha: ghLatest.commitSha || '' }),
  );
  const catalogHasUpdate = Boolean(
    catPlugin && catalogInstallable && !sameCatalogRelease && isNewerVersion(catPlugin.version, installedVersion),
  );
  const githubHasUpdate = Boolean(ghLatest && !sameGithubRelease && isNewerVersion(ghLatest.version, installedVersion));
  const resolvedRepoUrl = normalizeRepoUrl(
    catPlugin?.repository?.url ||
      receipt?.repositoryUrl ||
      repositoryUrl ||
      (ghSlug ? ghSlug.url : '') ||
      (isSelf ? SELF_REPO_URL : ''),
  );
  const resolvedPluginRoot = normalizePluginRoot(
    receipt?.pluginRoot || catPlugin?.repository?.pluginRoot || repositoryRoot || '.',
  );

  // Scenario A: Catalog has a direct-installable update and is not behind GitHub upstream
  if (catalogHasUpdate && (!githubHasUpdate || !isNewerVersion(ghLatest.version, catPlugin.version))) {
    const matchingGh = ghLatest && compareSemver(ghLatest.version, catPlugin.version) === 0 ? ghLatest : null;
    const explicitTag = typeof catPlugin.gitTag === 'string' ? catPlugin.gitTag.trim() : '';
    const catCommitSha = typeof catPlugin.commitSha === 'string' ? catPlugin.commitSha.trim() : '';
    let fallbackUrl = catPlugin.repository?.url || '';
    if (ghSlug) {
      if (explicitTag) {
        fallbackUrl = `https://github.com/${ghSlug.fullName}/releases/tag/${encodeURIComponent(explicitTag)}`;
      } else if (catCommitSha) {
        fallbackUrl = `https://github.com/${ghSlug.fullName}/commit/${encodeURIComponent(catCommitSha)}`;
      } else if (catPlugin.gitTag === undefined && catPlugin.version) {
        fallbackUrl = `https://github.com/${ghSlug.fullName}/releases/tag/${encodeURIComponent(`v${catPlugin.version}`)}`;
      } else {
        fallbackUrl = `https://github.com/${ghSlug.fullName}`;
      }
    }
    const escalation = computeCapabilityEscalation(receipt, catPlugin, installedCapabilities);
    return enforceUpdateItemInvariant({
      id: catPlugin.id,
      dir,
      displayName: catPlugin.displayName || displayName,
      installedVersion,
      latestVersion: catPlugin.version,
      source: 'catalog',
      updateChannel: 'catalog',
      ...(resolvedRepoUrl ? { repositoryUrl: resolvedRepoUrl } : {}),
      pluginRoot: resolvedPluginRoot,
      releaseUrl: matchingGh?.releaseUrl || fallbackUrl,
      changelog: matchingGh?.changelog || '',
      escalation,
      installable: true,
      isSelf: Boolean(isSelf),
    });
  }

  // Scenario B: GitHub Release/SemVer Tag is newer than local (and ahead of catalog, or unlisted) -> direct-installable in Sidebar
  if (githubHasUpdate) {
    return enforceUpdateItemInvariant({
      id: isGithubUrlTrack ? receipt?.id || catPlugin?.id || id : catPlugin?.id || receipt?.id || id,
      dir,
      displayName: catPlugin?.displayName || displayName,
      installedVersion,
      latestVersion: ghLatest.version,
      source: ghLatest.source,
      updateChannel: isGithubUrlTrack ? 'github-url' : 'github-upstream',
      updateKind: 'semver',
      targetRef: ghLatest.tagName,
      repositoryUrl: resolvedRepoUrl,
      pluginRoot: resolvedPluginRoot,
      releaseUrl: ghLatest.releaseUrl,
      changelog: ghLatest.changelog || '',
      escalation: null,
      installable: true,
      isSelf: Boolean(isSelf),
    });
  }

  // Scenario C: Default-branch / branch-tracked tagless `github-url` plugins (Commit SHA / version diff)
  if (isGithubUrlTrack && branchHead?.commitSha && branchHead.subtreeChanged !== false) {
    const installedSha = String(receipt?.commitSha || '').trim().toLowerCase();
    const remoteSha = String(branchHead.commitSha || '').trim().toLowerCase();
    const remoteVersion = String(branchHead.remoteVersion || '').trim();
    if (remoteVersion && compareSemver(remoteVersion, installedVersion) < 0) return null;
    const versionBumped = Boolean(remoteVersion && isNewerVersion(remoteVersion, installedVersion));
    const commitChanged = Boolean(installedSha && remoteSha && remoteSha !== installedSha);

    if (commitChanged || versionBumped) {
      const releaseUrl = ghSlug
        ? installedSha
          ? `https://github.com/${ghSlug.fullName}/compare/${installedSha.slice(0, 12)}...${remoteSha.slice(0, 12)}`
          : `https://github.com/${ghSlug.fullName}/commit/${remoteSha}`
        : '';
      return enforceUpdateItemInvariant({
        id: receipt?.id || id,
        dir,
        displayName,
        installedVersion,
        latestVersion: versionBumped ? remoteVersion : installedVersion,
        installedCommitSha: installedSha.slice(0, 7),
        latestCommitSha: remoteSha.slice(0, 7),
        source: 'github-branch',
        updateChannel: 'github-url',
        updateKind: versionBumped ? 'semver' : 'commit',
        targetRef: remoteSha,
        trackBranch: branchHead.branch || receipt?.githubSource?.trackBranch || '',
        repositoryUrl: resolvedRepoUrl,
        pluginRoot: resolvedPluginRoot,
        releaseUrl,
        changelog: branchHead.message || '',
        escalation: null,
        installable: true,
        isSelf: false,
      });
    }
  }

  return null;
}

/**
 * Checks all globally installed plugins + AGY Market itself against both the live catalog
 * and remote GitHub Releases / SemVer tags.
 */
export async function checkPluginUpdates({
  catalog = { plugins: [] },
  inventory = { installed: [] },
  dataDir,
  prefs = {},
  force = false,
  fetchImpl = defaultProxyFetch,
  nowMs = Date.now(),
  ttlMs = UPDATE_CHECK_CACHE_TTL_MS,
  currentSelfVersion = PLUGIN_VERSION,
  githubApiBaseUrl = GITHUB_API_BASE_URL,
  timeoutMs = DEFAULT_GITHUB_TIMEOUT_MS,
  shouldPersistCache = () => true,
}) {
  const activeFetch = resolveEffectiveFetch(fetchImpl);
  const checkedAt = new Date(nowMs).toISOString();
  const catalogPlugins = Array.isArray(catalog?.plugins) ? catalog.plugins : [];
  const globalInstalled = (inventory?.installed || []).filter(loc => loc.scope === 'global')
    .map(loc => resolveCatalogPluginRoot(loc, catalogPlugins));

  const probeMemo = new Map();
  const branchProbeMemo = new Map();
  const rawManifestMemo = new Map();
  const warnings = [];
  let rateLimited = false;
  let firstLiveChecked = false;
  let firstLiveGate = null;

  function probeOnce(ghSlug) {
    if (!ghSlug) return Promise.resolve(null);
    if (probeMemo.has(ghSlug.fullName)) return probeMemo.get(ghSlug.fullName);
    const pending = (async () => {
      while (!firstLiveChecked && firstLiveGate) {
        await firstLiveGate.catch(() => {});
      }
      const isGateLeader = !firstLiveChecked && !firstLiveGate;
      const runProbe = async () => {
        const res = await probeGithubRepoUpdates({
          owner: ghSlug.owner,
          repo: ghSlug.repo,
          dataDir,
          prefs,
          force,
          fetchImpl: activeFetch,
          nowMs,
          ttlMs,
          githubApiBaseUrl,
          timeoutMs,
          skipNetworkBecauseRateLimited: rateLimited,
          shouldPersistCache,
        });
        if (res.rateLimited) rateLimited = true;
        if (res.warning) warnings.push(res.warning);
        if (!res.fromCache || res.rateLimited) {
          firstLiveChecked = true;
        }
        return res;
      };
      if (!isGateLeader) {
        return runProbe();
      }
      const gatePromise = runProbe();
      firstLiveGate = gatePromise;
      try {
        return await gatePromise;
      } catch (err) {
        firstLiveChecked = true;
        throw err;
      } finally {
        if (firstLiveGate === gatePromise) firstLiveGate = null;
      }
    })();
    probeMemo.set(ghSlug.fullName, pending);
    return pending;
  }

  function probeBranchOnce(ghSlug, loc) {
    if (!ghSlug || !loc?.receipt) return Promise.resolve(null);
    const branch =
      loc.receipt?.githubSource?.trackBranch ||
      (loc.receipt?.githubSource?.refType === 'branch' && loc.receipt?.githubSource?.ref
        ? loc.receipt.githubSource.ref
        : '') ||
      'HEAD';
    const pluginRoot = normalizePluginRoot(loc.receipt?.pluginRoot || loc.repositoryRoot || '.');
    const memoKey = JSON.stringify([ghSlug.fullName, branch, pluginRoot, loc.receipt.commitSha || '']);
    if (branchProbeMemo.has(memoKey)) return branchProbeMemo.get(memoKey);

    const pending = (async () => {
      const res = await probeGithubBranchHead({
        owner: ghSlug.owner,
        repo: ghSlug.repo,
        branch,
        pluginRoot,
        installedCommitSha: loc.receipt?.commitSha || '',
        dataDir,
        prefs,
        force,
        fetchImpl: activeFetch,
        nowMs,
        ttlMs,
        githubApiBaseUrl,
        timeoutMs,
        skipNetworkBecauseRateLimited: rateLimited,
        shouldPersistCache,
      });
      if (res.rateLimited) rateLimited = true;
      if (res.warning) warnings.push(res.warning);
      return res;
    })();
    branchProbeMemo.set(memoKey, pending);
    return pending;
  }

  function probeRawManifestOnce(ghSlug, tagName, pluginRoot = '.') {
    if (!ghSlug || !tagName) return Promise.resolve(null);
    const normRoot = normalizePluginRoot(pluginRoot);
    const memoKey = JSON.stringify([ghSlug.fullName, tagName, normRoot]);
    if (rawManifestMemo.has(memoKey)) return rawManifestMemo.get(memoKey);
    const pending = probeRawManifestForTagCached({
      owner: ghSlug.owner,
      repo: ghSlug.repo,
      tagName,
      pluginRoot: normRoot,
      token: prefs?.githubToken || '', githubApiBaseUrl,
      dataDir,
      force,
      fetchImpl: activeFetch,
      nowMs,
      ttlMs,
      timeoutMs,
      shouldPersistCache,
    });
    rawManifestMemo.set(memoKey, pending);
    return pending;
  }

  const items = [];
  let sawInstalledSelf = false;
  let selfUpdate = null;

  const uncheckedDirs = new Set();
  const unavailableDirs = new Set();
  const probeSlots = new Array(globalInstalled.length);
  let nextSlot = 0;
  const workerCount = Math.min(UPDATE_PROBE_CONCURRENCY, globalInstalled.length);

  async function probeWorker() {
    while (nextSlot < globalInstalled.length) {
      const idx = nextSlot++;
      const loc = globalInstalled[idx];
      const isSelf = samePluginName(loc.dir, PLUGIN_ID);
      if (isSelf) sawInstalledSelf = true;
      if (!loc.receipt && loc.inferredRepository) {
        uncheckedDirs.add(loc.dir);
        continue;
      }

      // Issue #3A: Exclude native `.git` clones and unversioned unmanaged plugins from update checks
      if (isUnmanagedNonUpdatableLocal(loc) || (isSelf ? isForeignMarketInstall(loc) : findManagedSuccessor(loc, globalInstalled))) {
        probeSlots[idx] = null;
        continue;
      }

      const catPlugin = isSelf ? catalogPlugins.find(isOfficialMarketEntry) :
        findCatalogEntryForLocal(loc, catalogPlugins, inventory.installed);
      const ghSlug =
        (isSelf && parseGithubRepoSlug(SELF_REPO_URL)) ||
        parseGithubRepoSlug(catPlugin?.repository?.url) ||
        parseGithubRepoSlug(loc.receipt?.repositoryUrl || loc.repositoryUrl);

      if (!isSelf && (loc.repositoryRoot === null || (!catPlugin && !ghSlug))) {
        uncheckedDirs.add(loc.dir);
        continue;
      }
      const repoProbe = await probeOnce(ghSlug);
      let ghLatest = repoProbe?.latest || null;
      let incomplete = Boolean(repoProbe && !repoProbe.checked);

      const resolvedRoot = normalizePluginRoot(loc.receipt?.pluginRoot || loc.repositoryRoot || '.');
      const manualSource = !loc.receipt && !catPlugin;
      // Repository tags order releases, but a monorepo child's version belongs to its manifest.
      if (
        ghLatest && !isSelf && ghSlug &&
        (resolvedRoot !== '.' || (manualSource && isNewerVersion(ghLatest.version, loc.version)))
      ) {
        const rawMeta = await probeRawManifestOnce(ghSlug, ghLatest.tagName, resolvedRoot);
        const localNames = new Set(
          [loc.name, loc.dir].filter(Boolean).map((s) => String(s).trim().toLowerCase()),
        );
        const remoteName = String(rawMeta?.name || '').trim().toLowerCase();
        const remoteVersion = String(rawMeta?.version || '').trim();
        const nameMatches = Boolean(remoteName && localNames.has(remoteName));
        const versionIsNewer = Boolean(remoteVersion && isNewerVersion(remoteVersion, loc.version));
        if (rawMeta?.transientError) incomplete = true;
        else if (loc.implicitRepositoryRoot && (!rawMeta?.found || !nameMatches)) uncheckedDirs.add(loc.dir);
        if (!rawMeta?.found || (manualSource && !nameMatches) || !remoteVersion ||
            (resolvedRoot === '.' && !versionIsNewer)) {
          ghLatest = null;
        } else if (resolvedRoot !== '.') {
          ghLatest = { ...ghLatest, version: remoteVersion };
        }
      }

      const shouldProbeBranch = Boolean(
        loc.receipt?.track === 'github-url' &&
          !isSelf &&
          ghSlug &&
          (loc.receipt?.githubSource?.refType === 'branch' || (!repoProbe?.latest && Boolean(loc.receipt?.commitSha))),
      );
      const branchProbe = shouldProbeBranch ? await probeBranchOnce(ghSlug, loc) : null;
      if (branchProbe && !branchProbe.checked) incomplete = true;
      // Unlike a newer SemVer, a cached, different SHA can be an ancestor of the installed commit.
      const branchHead = branchProbe?.checked ? branchProbe.head : null;
      const fallbackId = catPlugin?.id || loc.receipt?.id || (ghSlug ? `${ghSlug.owner}__${ghSlug.repo}` : loc.dir);

      const item = buildUpdateItem({
        id: fallbackId,
        dir: loc.dir,
        displayName: loc.displayName || loc.name || loc.dir,
        installedVersion: loc.version,
        catPlugin,
        receipt: loc.receipt || null,
        installedCapabilities: loc.capabilities || {},
        repositoryUrl: loc.repositoryUrl || '',
        repositoryRoot: loc.repositoryRoot,
        ghSlug,
        ghLatest,
        branchHead,
        isSelf,
      });

      if (!item && incomplete) {
        uncheckedDirs.add(loc.dir);
        unavailableDirs.add(loc.dir);
      }
      probeSlots[idx] = { isSelf, item };
    }
  }

  if (workerCount > 0) {
    await Promise.all(Array.from({ length: workerCount }, () => probeWorker()));
  }

  for (const slot of probeSlots) {
    if (!slot?.item) continue;
    const { isSelf, item } = slot;
    items.push(item);
    if (isSelf) {
      selfUpdate = {
        id: item.id,
        installedVersion: item.installedVersion,
        latestVersion: item.latestVersion,
        source: item.source,
        updateChannel: item.updateChannel || 'catalog',
        ...(item.updateKind ? { updateKind: item.updateKind } : {}),
        ...(item.targetRef ? { targetRef: item.targetRef } : {}),
        ...(item.repositoryUrl ? { repositoryUrl: item.repositoryUrl } : {}),
        ...(item.pluginRoot ? { pluginRoot: item.pluginRoot } : {}),
        installable: item.installable,
        releaseUrl: item.releaseUrl,
        changelog: item.changelog,
      };
    }
  }

  // If `agy-market` is not present inside `configDir/plugins/` (e.g., dev/sandbox run), still check self against PLUGIN_VERSION
  if (!sawInstalledSelf) {
    const selfCat = catalogPlugins.find(isOfficialMarketEntry) || null;
    const selfSlug = parseGithubRepoSlug(selfCat?.repository?.url) || parseGithubRepoSlug(SELF_REPO_URL);
    const selfProbe = await probeOnce(selfSlug);
    const selfItem = buildUpdateItem({
      id: selfCat?.id || SELF_CATALOG_ID,
      dir: PLUGIN_ID,
      displayName: selfCat?.displayName || PLUGIN_DISPLAY_NAME,
      installedVersion: currentSelfVersion,
      catPlugin: selfCat,
      receipt: null,
      repositoryUrl: selfCat?.repository?.url || SELF_REPO_URL,
      ghSlug: selfSlug,
      ghLatest: selfProbe?.latest,
      isSelf: true,
    });
    if (!selfItem && selfProbe && !selfProbe.checked) {
      uncheckedDirs.add(PLUGIN_ID);
      unavailableDirs.add(PLUGIN_ID);
    }
    if (selfItem) {
      selfUpdate = {
        id: selfItem.id,
        installedVersion: selfItem.installedVersion,
        latestVersion: selfItem.latestVersion,
        source: selfItem.source,
        updateChannel: selfItem.updateChannel || 'catalog',
        ...(selfItem.updateKind ? { updateKind: selfItem.updateKind } : {}),
        ...(selfItem.targetRef ? { targetRef: selfItem.targetRef } : {}),
        ...(selfItem.repositoryUrl ? { repositoryUrl: selfItem.repositoryUrl } : {}),
        ...(selfItem.pluginRoot ? { pluginRoot: selfItem.pluginRoot } : {}),
        installable: selfItem.installable,
        releaseUrl: selfItem.releaseUrl,
        changelog: selfItem.changelog,
      };
    }
  }

  // Deterministic ordering: non-self plugins sorted by id, self (`agy-market`) always last
  items.sort((a, b) => {
    if (a.isSelf !== b.isSelf) return a.isSelf ? 1 : -1;
    return String(a.id).localeCompare(String(b.id));
  });

  return {
    ok: true,
    checkedAt,
    items,
    selfUpdate,
    rateLimited,
    uncheckedDirs: [...uncheckedDirs].sort(),
    unavailableDirs: [...unavailableDirs].sort(),
    warnings: [...new Set(warnings)],
  };
}
