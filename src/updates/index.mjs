// Remote GitHub + Live Catalog Auto Update Detection Engine (`src/updates/index.mjs`).
//
// Compares locally installed plugins (from `.agy-market-receipt.json` or `plugin.json` repository URL)
// against:
//   (a) the live catalog latest version (installable only when `distribution.tarballUrl` + 64-hex `sha256` exist)
//   (b) the repository's GitHub latest Release (`/releases/latest`) and highest SemVer tag (`/tags`) via api.github.com
//       using ETag (`If-None-Match`) + 30-minute TTL caching under `${dataDir}/cache/github`, graceful 403/429
//       rate-limit degradation, and optional `prefs.githubToken` (strictly never logged or cached).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { normalizeRepoUrl } from '../preflight/index.mjs';
import {
  GITHUB_API_BASE_URL,
  PLUGIN_DISPLAY_NAME,
  PLUGIN_ID,
  PLUGIN_VERSION,
  SELF_CATALOG_ID,
  SELF_REPO_URL,
  UPDATE_CHECK_CACHE_TTL_MS,
} from '../shared/constants.mjs';
import { computeCapabilityEscalation, parseJsonc, sanitizePrefs } from '../shared/schemas.mjs';
import { compareSemver, isNewerVersion, parseSemver } from '../shared/semver.mjs';

const MAX_CHANGELOG_CHARS = 8000;
const DEFAULT_GITHUB_TIMEOUT_MS = 8000;
const MIN_RATELIMIT_BACKOFF_MS = 60 * 1000;
const DEFAULT_RATELIMIT_BACKOFF_MS = 5 * 60 * 1000;
const MAX_RATELIMIT_BACKOFF_MS = 60 * 60 * 1000;

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

function inferRepoSlugFromReceiptId(receiptId) {
  const id = String(receiptId || '').trim();
  const m = /^([A-Za-z0-9-]+)__([A-Za-z0-9_.-]+?)(?:--.*)?$/.exec(id);
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
  writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
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
  if (latestRelease && highestTag) {
    if (compareSemver(latestRelease.version, highestTag.version) >= 0) {
      return {
        version: latestRelease.version,
        tagName: latestRelease.tagName,
        source: 'github-release',
        releaseUrl: latestRelease.releaseUrl,
        changelog: latestRelease.changelog || '',
        publishedAt: latestRelease.publishedAt || null,
      };
    }
    return {
      version: highestTag.version,
      tagName: highestTag.tagName,
      source: 'github-tag',
      releaseUrl: highestTag.releaseUrl,
      changelog: '',
      publishedAt: null,
    };
  }
  if (latestRelease) {
    return {
      version: latestRelease.version,
      tagName: latestRelease.tagName,
      source: 'github-release',
      releaseUrl: latestRelease.releaseUrl,
      changelog: latestRelease.changelog || '',
      publishedAt: latestRelease.publishedAt || null,
    };
  }
  if (highestTag) {
    return {
      version: highestTag.version,
      tagName: highestTag.tagName,
      source: 'github-tag',
      releaseUrl: highestTag.releaseUrl,
      changelog: '',
      publishedAt: null,
    };
  }
  return null;
}

function readRateLimitState(cacheDir) {
  return readJsonSafe(join(cacheDir, '_ratelimit.json'));
}

function writeRateLimitState(cacheDir, { resetAtMs, authenticated, nowMs }) {
  writeJsonSafe(join(cacheDir, '_ratelimit.json'), {
    schemaVersion: 1,
    resetAtMs,
    authenticated: Boolean(authenticated),
    recordedAt: new Date(nowMs).toISOString(),
  });
}

function isRateLimitBackoffActive(rateLimitState, { nowMs, authenticated }) {
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
  fetchImpl = fetch,
  timeoutMs = DEFAULT_GITHUB_TIMEOUT_MS,
}) {
  const url = `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/releases/latest`;
  try {
    const res = await fetchImpl(url, {
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

function normalizePluginRootForUpdate(rawRoot = '.') {
  const s = String(rawRoot || '.')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\/+/, '')
    .replace(/\/+$/, '');
  return s || '.';
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
  fetchImpl = fetch,
  timeoutMs = DEFAULT_GITHUB_TIMEOUT_MS,
}) {
  const url = `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}.git/info/refs?service=git-upload-pack`;
  try {
    const res = await fetchImpl(url, {
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
  fetchImpl = fetch,
  timeoutMs = DEFAULT_GITHUB_TIMEOUT_MS,
}) {
  const normRoot = normalizePluginRootForUpdate(pluginRoot);
  const subPart = normRoot !== '.' ? `/${encodePathSegments(normRoot)}` : '';
  const refSeg = encodePathSegments(branch || 'HEAD');
  const url = `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/${refSeg}${subPart}.atom`;
  const headers = {
    Accept: 'application/atom+xml, application/xml, text/xml',
    'User-Agent': 'agy-market-updater/1.0',
  };
  if (etag) headers['If-None-Match'] = etag;
  try {
    const res = await fetchImpl(url, {
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

async function probeRawManifestVersion({
  owner,
  repo,
  commitSha,
  pluginRoot = '.',
  fetchImpl = fetch,
  timeoutMs = 4000,
}) {
  const normRoot = normalizePluginRootForUpdate(pluginRoot);
  const candidates =
    normRoot !== '.'
      ? [`${normRoot}/plugin.json`, `${normRoot}/.antigravity-plugin/plugin.json`]
      : ['plugin.json', '.antigravity-plugin/plugin.json'];

  for (const relPath of candidates) {
    const url = `https://raw.githubusercontent.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${encodeURIComponent(commitSha)}/${encodePathSegments(relPath)}`;
    try {
      const res = await fetchImpl(url, {
        headers: { 'User-Agent': 'agy-market-updater/1.0' },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) continue;
      const manifest = parseJsonc(await res.text());
      const sem = parseSemver(manifest?.version);
      if (sem) return sem.version;
    } catch {
      /* non-fatal */
    }
  }
  return '';
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
  fetchImpl = fetch,
  nowMs = Date.now(),
  ttlMs = UPDATE_CHECK_CACHE_TTL_MS,
  githubApiBaseUrl = GITHUB_API_BASE_URL,
  timeoutMs = DEFAULT_GITHUB_TIMEOUT_MS,
  skipNetworkBecauseRateLimited = false,
  shouldPersistCache = () => true,
}) {
  const cleanPrefs = sanitizePrefs(prefs);
  const token = cleanPrefs.githubToken;
  const authenticated = Boolean(token);
  const normRoot = normalizePluginRootForUpdate(pluginRoot);
  const requestedBranch = String(branch || '').trim() || 'HEAD';
  const cacheDir = getGithubCacheDir(dataDir);
  const branchSlug = `${requestedBranch}__${normRoot}`.toLowerCase().replace(/[^a-z0-9_.-]/gi, '_');
  const cachePath = join(cacheDir, `branch-${safeGithubCacheKey(owner, repo)}-${branchSlug}.json`);
  const cached = readJsonSafe(cachePath);
  const apiBase = String(githubApiBaseUrl || GITHUB_API_BASE_URL).replace(/\/+$/, '');
  const fullName = `${owner}/${repo}`;

  if (!force && cached && Number.isFinite(cached.checkedAtMs) && nowMs - cached.checkedAtMs < ttlMs) {
    return {
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
    const apiUrl =
      normRoot !== '.'
        ? `${apiBase}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits?sha=${encodeURIComponent(requestedBranch)}&path=${encodeURIComponent(normRoot)}&per_page=1`
        : `${apiBase}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/${encodeURIComponent(requestedBranch)}`;
    try {
      const res = await fetchImpl(apiUrl, {
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
      pluginRoot: normRoot,
      etag: atomEtag,
      fetchImpl,
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
      anySuccess = true;
    } else {
      const gitRefs = await probeGithubGitRefs({ owner, repo, fetchImpl, timeoutMs });
      if (gitRefs) {
        const targetBranch =
          requestedBranch !== 'HEAD' ? requestedBranch : gitRefs.defaultBranch || 'main';
        const sha = gitRefs.heads.get(targetBranch) || gitRefs.headSha || '';
        if (/^[0-9a-f]{40}$/.test(sha)) {
          resolvedBranch = targetBranch;
          head = {
            commitSha: sha,
            message: head?.commitSha === sha ? head.message || '' : '',
            committedAt: head?.commitSha === sha ? head.committedAt || null : null,
            branch: targetBranch,
            remoteVersion: head?.commitSha === sha ? head.remoteVersion || '' : '',
          };
          anySuccess = true;
        }
      }
    }
  }

  // Optional raw `plugin.json` version lookup when commit SHA changed
  if (
    head?.commitSha &&
    installedCommitSha &&
    head.commitSha.toLowerCase() !== String(installedCommitSha).trim().toLowerCase() &&
    !head.remoteVersion
  ) {
    const remoteVer = await probeRawManifestVersion({
      owner,
      repo,
      commitSha: head.commitSha,
      pluginRoot: normRoot,
      fetchImpl,
      timeoutMs: Math.min(4000, timeoutMs),
    });
    if (remoteVer) {
      head = { ...head, remoteVersion: remoteVer };
    }
  }

  if (anySuccess && shouldPersistCache()) {
    writeJsonSafe(cachePath, {
      schemaVersion: 1,
      repo: fullName,
      branch: resolvedBranch || requestedBranch,
      pluginRoot: normRoot,
      checkedAt: new Date(nowMs).toISOString(),
      checkedAtMs: nowMs,
      resolvedBranch,
      apiEtag,
      atomEtag,
      head,
    });
  }

  return {
    head,
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
  fetchImpl = fetch,
  nowMs = Date.now(),
  ttlMs = UPDATE_CHECK_CACHE_TTL_MS,
  githubApiBaseUrl = GITHUB_API_BASE_URL,
  timeoutMs = DEFAULT_GITHUB_TIMEOUT_MS,
  skipNetworkBecauseRateLimited = false,
  shouldPersistCache = () => true,
}) {
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
        ? await probeGithubLatestReleaseRedirect({ owner, repo, fetchImpl, timeoutMs })
        : null;
    const mergedRelease =
      redirectFallback && (!cached?.latestRelease || compareSemver(redirectFallback.version, cached.latestRelease.version) > 0)
        ? redirectFallback
        : cached?.latestRelease || null;
    return {
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
    const res = await fetchImpl(releaseUrl, {
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
    const redirectFallback = await probeGithubLatestReleaseRedirect({ owner, repo, fetchImpl, timeoutMs });
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
      const res = await fetchImpl(tagsUrl, {
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
  if (anySuccess && shouldPersistCache()) {
    writeJsonSafe(cachePath, {
      schemaVersion: 1,
      repo: fullName,
      checkedAt: new Date(nowMs).toISOString(),
      checkedAtMs: partialFailure ? Number(cached?.checkedAtMs || 0) : nowMs,
      releaseEtag,
      tagsEtag,
      latestRelease,
      highestTag,
    });
  }

  return {
    latest: pickBestGithubReleaseOrTag({ latestRelease, highestTag }),
    fromCache: false,
    rateLimited,
    warning: warnings.length > 0 ? warnings.join(' ') : null,
  };
}

function findMatchingCatalogPlugin(loc, catalogPlugins) {
  const list = Array.isArray(catalogPlugins) ? catalogPlugins : [];

  if (loc.receipt) {
    const recRepoId = Number(loc.receipt.repositoryId || 0);
    const byReceipt = list.find((p) => {
      const pRepoId = Number(p?.repository?.repositoryId || 0);
      if (recRepoId > 0 && pRepoId > 0) {
        return pRepoId === recRepoId && p.id === loc.receipt.id;
      }
      return p.id === loc.receipt.id;
    });
    if (byReceipt) return byReceipt;
  }

  if (loc.repositoryUrl) {
    const locRoot = normalizePluginRootForUpdate(loc.receipt?.pluginRoot || '.');
    const byRepo = list.find((p) => {
      const pRepo = normalizeRepoUrl(p?.repository?.url);
      if (!pRepo || pRepo !== loc.repositoryUrl) return false;
      const pRoot = normalizePluginRootForUpdate(p?.repository?.pluginRoot || '.');
      if (loc.receipt?.pluginRoot && pRoot !== locRoot) return false;
      return p.canonicalName === loc.name || p.canonicalName === loc.dir;
    });
    if (byRepo) return byRepo;
  }

  if (loc.dir === PLUGIN_ID || loc.name === PLUGIN_ID) {
    return list.find((p) => p.id === SELF_CATALOG_ID || p.canonicalName === PLUGIN_ID) || null;
  }

  return null;
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
  repositoryUrl = '',
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
      repositoryUrl ||
      receipt?.repositoryUrl ||
      (ghSlug ? ghSlug.url : '') ||
      (isSelf ? SELF_REPO_URL : ''),
  );
  const resolvedPluginRoot = normalizePluginRootForUpdate(
    receipt?.pluginRoot || catPlugin?.repository?.pluginRoot || '.',
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
    const escalation = computeCapabilityEscalation(receipt, catPlugin);
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
  if (isGithubUrlTrack && branchHead?.commitSha) {
    const installedSha = String(receipt?.commitSha || '').trim().toLowerCase();
    const remoteSha = String(branchHead.commitSha || '').trim().toLowerCase();
    const remoteVersion = String(branchHead.remoteVersion || '').trim();
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
  fetchImpl = fetch,
  nowMs = Date.now(),
  ttlMs = UPDATE_CHECK_CACHE_TTL_MS,
  currentSelfVersion = PLUGIN_VERSION,
  githubApiBaseUrl = GITHUB_API_BASE_URL,
  timeoutMs = DEFAULT_GITHUB_TIMEOUT_MS,
  shouldPersistCache = () => true,
}) {
  const checkedAt = new Date(nowMs).toISOString();
  const catalogPlugins = Array.isArray(catalog?.plugins) ? catalog.plugins : [];
  const globalInstalled = (inventory?.installed || []).filter((loc) => loc.scope === 'global');

  const probeMemo = new Map();
  const branchProbeMemo = new Map();
  const warnings = [];
  let rateLimited = false;

  async function probeOnce(ghSlug) {
    if (!ghSlug) return null;
    if (probeMemo.has(ghSlug.fullName)) return probeMemo.get(ghSlug.fullName);
    const res = await probeGithubRepoUpdates({
      owner: ghSlug.owner,
      repo: ghSlug.repo,
      dataDir,
      prefs,
      force,
      fetchImpl,
      nowMs,
      ttlMs,
      githubApiBaseUrl,
      timeoutMs,
      skipNetworkBecauseRateLimited: rateLimited,
      shouldPersistCache,
    });
    if (res.rateLimited) rateLimited = true;
    if (res.warning) warnings.push(res.warning);
    probeMemo.set(ghSlug.fullName, res.latest);
    return res.latest;
  }

  async function probeBranchOnce(ghSlug, loc) {
    if (!ghSlug || !loc?.receipt) return null;
    const branch =
      loc.receipt?.githubSource?.trackBranch ||
      (loc.receipt?.githubSource?.refType === 'branch' && loc.receipt?.githubSource?.ref
        ? loc.receipt.githubSource.ref
        : '') ||
      'HEAD';
    const pluginRoot = normalizePluginRootForUpdate(loc.receipt?.pluginRoot || '.');
    const memoKey = `${ghSlug.fullName}|${branch}|${pluginRoot}`;
    if (branchProbeMemo.has(memoKey)) return branchProbeMemo.get(memoKey);

    const res = await probeGithubBranchHead({
      owner: ghSlug.owner,
      repo: ghSlug.repo,
      branch,
      pluginRoot,
      installedCommitSha: loc.receipt?.commitSha || '',
      dataDir,
      prefs,
      force,
      fetchImpl,
      nowMs,
      ttlMs,
      githubApiBaseUrl,
      timeoutMs,
      skipNetworkBecauseRateLimited: rateLimited,
      shouldPersistCache,
    });
    if (res.rateLimited) rateLimited = true;
    if (res.warning) warnings.push(res.warning);
    branchProbeMemo.set(memoKey, res.head);
    return res.head;
  }

  const items = [];
  let sawInstalledSelf = false;
  let selfUpdate = null;

  for (const loc of globalInstalled) {
    const isSelf = loc.dir === PLUGIN_ID || loc.name === PLUGIN_ID || loc.receipt?.id === SELF_CATALOG_ID;
    if (isSelf) sawInstalledSelf = true;

    const catPlugin = findMatchingCatalogPlugin(loc, catalogPlugins);
    const ghSlug =
      parseGithubRepoSlug(catPlugin?.repository?.url) ||
      parseGithubRepoSlug(loc.repositoryUrl) ||
      inferRepoSlugFromReceiptId(loc.receipt?.id) ||
      (isSelf ? parseGithubRepoSlug(SELF_REPO_URL) : null);

    const ghLatest = await probeOnce(ghSlug);
    const shouldProbeBranch = Boolean(
      loc.receipt?.track === 'github-url' &&
        !isSelf &&
        ghSlug &&
        (loc.receipt?.githubSource?.refType === 'branch' || (!ghLatest && Boolean(loc.receipt?.commitSha))),
    );
    const branchHead = shouldProbeBranch ? await probeBranchOnce(ghSlug, loc) : null;
    const fallbackId = catPlugin?.id || loc.receipt?.id || (ghSlug ? `${ghSlug.owner}__${ghSlug.repo}` : loc.dir);

    const item = buildUpdateItem({
      id: fallbackId,
      dir: loc.dir,
      displayName: loc.displayName || loc.name || loc.dir,
      installedVersion: loc.version,
      catPlugin,
      receipt: loc.receipt || null,
      repositoryUrl: loc.repositoryUrl || '',
      ghSlug,
      ghLatest,
      branchHead,
      isSelf,
    });

    if (item) {
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
  }

  // If `agy-market` is not present inside `configDir/plugins/` (e.g., dev/sandbox run), still check self against PLUGIN_VERSION
  if (!sawInstalledSelf) {
    const selfCat = catalogPlugins.find((p) => p.id === SELF_CATALOG_ID || p.canonicalName === PLUGIN_ID) || null;
    const selfSlug = parseGithubRepoSlug(selfCat?.repository?.url) || parseGithubRepoSlug(SELF_REPO_URL);
    const selfGhLatest = await probeOnce(selfSlug);
    const selfItem = buildUpdateItem({
      id: selfCat?.id || SELF_CATALOG_ID,
      dir: PLUGIN_ID,
      displayName: selfCat?.displayName || PLUGIN_DISPLAY_NAME,
      installedVersion: currentSelfVersion,
      catPlugin: selfCat,
      receipt: null,
      repositoryUrl: selfCat?.repository?.url || SELF_REPO_URL,
      ghSlug: selfSlug,
      ghLatest: selfGhLatest,
      isSelf: true,
    });
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
    warnings: [...new Set(warnings)],
  };
}
