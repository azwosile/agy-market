// Per-Plugin GitHub Discussions Integration (`src/discussions/index.mjs`).
//
// Resolves a plugin's GitHub repository URL and returns:
//   - Direct Discussions & New Discussion URLs (`https://github.com/<owner>/<repo>/discussions`)
//   - Discussion items via GitHub GraphQL API when optional `prefs.githubToken` is configured
//   - Disabled detection via GraphQL `hasDiscussionsEnabled` (with token) or cached REST `has_discussions` (without token)
// Strictly never logs or persists `prefs.githubToken` to cache files.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DISCUSSIONS_CACHE_TTL_MS,
  GITHUB_API_BASE_URL,
  PLUGIN_ID,
  SELF_CATALOG_ID,
  SELF_REPO_URL,
  UPDATE_CHECK_CACHE_TTL_MS,
} from '../shared/constants.mjs';
import { defaultProxyFetch } from '../shared/proxy-fetch.mjs';
import { sanitizePrefs } from '../shared/schemas.mjs';
import {
  getGithubCacheDir,
  isRateLimitResponse,
  parseGithubRepoSlug,
  redactSecret,
  safeGithubCacheKey,
} from '../updates/index.mjs';

const DEFAULT_DISCUSSIONS_TIMEOUT_MS = 8000;

const DISCUSSIONS_GRAPHQL_QUERY = `
query PluginDiscussions($owner: String!, $repo: String!) {
  repository(owner: $owner, name: $repo) {
    hasDiscussionsEnabled
    discussions(first: 10, orderBy: { field: UPDATED_AT, direction: DESC }) {
      nodes {
        title
        url
        updatedAt
        author {
          login
        }
        comments {
          totalCount
        }
        category {
          name
        }
      }
    }
  }
}
`.trim();

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

export function resolvePluginGithubRepo({ id, catalog = { plugins: [] }, inventory = { installed: [] } }) {
  const target = String(id || '').trim();
  if (!target) return null;

  const catalogPlugins = Array.isArray(catalog?.plugins) ? catalog.plugins : [];
  const catMatch = catalogPlugins.find(
    (p) => p.id === target || p.canonicalName === target || p.scopedName === target,
  );
  if (catMatch) {
    const slug = parseGithubRepoSlug(catMatch.repository?.url);
    if (slug) return { id: catMatch.id, slug };
  }

  const installed = Array.isArray(inventory?.installed) ? inventory.installed : [];
  const localMatch = installed.find(
    (loc) => loc.receipt?.id === target || loc.dir === target || loc.name === target,
  );
  if (localMatch) {
    const slug = parseGithubRepoSlug(localMatch.repositoryUrl);
    if (slug) return { id: localMatch.receipt?.id || target, slug };
  }

  if (target === SELF_CATALOG_ID || target === PLUGIN_ID) {
    const slug = parseGithubRepoSlug(SELF_REPO_URL);
    if (slug) return { id: SELF_CATALOG_ID, slug };
  }

  return null;
}

async function probeRepoDiscussionsEnabledRest({
  owner,
  repo,
  dataDir,
  force = false,
  fetchImpl = defaultProxyFetch,
  nowMs = Date.now(),
  ttlMs = UPDATE_CHECK_CACHE_TTL_MS,
  githubApiBaseUrl = GITHUB_API_BASE_URL,
  timeoutMs = DEFAULT_DISCUSSIONS_TIMEOUT_MS,
}) {
  const activeFetch = !fetchImpl || fetchImpl === fetch ? defaultProxyFetch : fetchImpl;
  const cacheDir = getGithubCacheDir(dataDir);
  const cachePath = join(cacheDir, `repo-meta-${safeGithubCacheKey(owner, repo)}.json`);
  const cached = readJsonSafe(cachePath);

  if (!force && cached && Number.isFinite(cached.checkedAtMs) && nowMs - cached.checkedAtMs < ttlMs) {
    return {
      hasDiscussions: cached.hasDiscussions,
      rateLimited: false,
      warning: null,
    };
  }

  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'agy-market-discussions/1.0',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (cached?.etag) {
    headers['If-None-Match'] = cached.etag;
  }

  const apiBase = String(githubApiBaseUrl || GITHUB_API_BASE_URL).replace(/\/+$/, '');
  const endpoint = `${apiBase}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;

  try {
    const res = await activeFetch(endpoint, {
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (res.status === 304 && cached) {
      writeJsonSafe(cachePath, { ...cached, checkedAtMs: nowMs, checkedAt: new Date(nowMs).toISOString() });
      return { hasDiscussions: cached.hasDiscussions, rateLimited: false, warning: null };
    }

    if (res.status === 200) {
      const data = await res.json();
      const hasDiscussions = typeof data?.has_discussions === 'boolean' ? data.has_discussions : true;
      const etag = res.headers?.get?.('etag') || '';
      writeJsonSafe(cachePath, {
        schemaVersion: 1,
        repo: `${owner}/${repo}`,
        hasDiscussions,
        etag,
        checkedAt: new Date(nowMs).toISOString(),
        checkedAtMs: nowMs,
      });
      return { hasDiscussions, rateLimited: false, warning: null };
    }

    if (res.status === 404) {
      return { hasDiscussions: false, rateLimited: false, warning: `Repository ${owner}/${repo} not found (HTTP 404).` };
    }

    const bodyText = await res.text().catch(() => '');
    if (isRateLimitResponse(res, bodyText)) {
      return {
        hasDiscussions: typeof cached?.hasDiscussions === 'boolean' ? cached.hasDiscussions : true,
        rateLimited: true,
        warning: `GitHub API rate limit reached (HTTP ${res.status}).`,
      };
    }

    return {
      hasDiscussions: typeof cached?.hasDiscussions === 'boolean' ? cached.hasDiscussions : true,
      rateLimited: false,
      warning: `GitHub repository metadata check returned HTTP ${res.status}.`,
    };
  } catch (err) {
    return {
      hasDiscussions: typeof cached?.hasDiscussions === 'boolean' ? cached.hasDiscussions : true,
      rateLimited: false,
      warning: `GitHub repository metadata check failed: ${err?.message || String(err)}`,
    };
  }
}

/**
 * Fetches GitHub Discussions metadata and recent items (when `prefs.githubToken` is set)
 * for the requested plugin `id`.
 */
export async function fetchPluginDiscussions({
  id,
  catalog = { plugins: [] },
  inventory = { installed: [] },
  dataDir,
  prefs = {},
  force = false,
  fetchImpl = defaultProxyFetch,
  nowMs = Date.now(),
  ttlMs = DISCUSSIONS_CACHE_TTL_MS,
  githubApiBaseUrl = GITHUB_API_BASE_URL,
  timeoutMs = DEFAULT_DISCUSSIONS_TIMEOUT_MS,
}) {
  const activeFetch = !fetchImpl || fetchImpl === fetch ? defaultProxyFetch : fetchImpl;
  const resolved = resolvePluginGithubRepo({ id, catalog, inventory });
  if (!resolved) {
    return {
      ok: false,
      statusCode: 404,
      error: `GitHub repository for plugin "${id}" not found`,
      id: String(id || '').trim(),
      url: '',
      newDiscussionUrl: '',
      items: [],
      disabled: true,
      needsToken: false,
      rateLimited: false,
    };
  }

  const { owner, repo, fullName } = resolved.slug;
  const discussionsUrl = `https://github.com/${owner}/${repo}/discussions`;
  const newDiscussionUrl = `https://github.com/${owner}/${repo}/discussions/new/choose`;

  const cleanPrefs = sanitizePrefs(prefs);
  const token = cleanPrefs.githubToken;

  // Unauthenticated path: GraphQL requires a token -> probe REST `has_discussions` to detect disabled state
  if (!token) {
    const restProbe = await probeRepoDiscussionsEnabledRest({
      owner,
      repo,
      dataDir,
      force,
      fetchImpl: activeFetch,
      nowMs,
      githubApiBaseUrl,
      timeoutMs,
    });
    const disabled = restProbe.hasDiscussions === false;
    return {
      ok: true,
      id: resolved.id,
      repo: fullName,
      url: discussionsUrl,
      newDiscussionUrl,
      items: [],
      disabled,
      needsToken: !disabled,
      rateLimited: restProbe.rateLimited,
      ...(restProbe.warning ? { warning: restProbe.warning } : {}),
    };
  }

  // Authenticated path: query GitHub GraphQL API with short cache (never caching token)
  const cacheDir = getGithubCacheDir(dataDir);
  const cachePath = join(cacheDir, `discussions-gql-${safeGithubCacheKey(owner, repo)}.json`);
  const cached = readJsonSafe(cachePath);

  if (!force && cached && Number.isFinite(cached.checkedAtMs) && nowMs - cached.checkedAtMs < ttlMs) {
    return {
      ok: true,
      id: resolved.id,
      repo: fullName,
      url: discussionsUrl,
      newDiscussionUrl,
      items: Array.isArray(cached.items) ? cached.items : [],
      disabled: Boolean(cached.disabled),
      needsToken: false,
      rateLimited: false,
    };
  }

  const apiBase = String(githubApiBaseUrl || GITHUB_API_BASE_URL).replace(/\/+$/, '');
  const graphqlEndpoint = `${apiBase}/graphql`;

  try {
    const res = await activeFetch(graphqlEndpoint, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        'User-Agent': 'agy-market-discussions/1.0',
      },
      body: JSON.stringify({
        query: DISCUSSIONS_GRAPHQL_QUERY,
        variables: { owner, repo },
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (res.status === 401) {
      return {
        ok: true,
        id: resolved.id,
        repo: fullName,
        url: discussionsUrl,
        newDiscussionUrl,
        items: [],
        disabled: false,
        needsToken: true,
        rateLimited: false,
        warning: 'GitHub token was rejected (HTTP 401); showing direct Discussions link.',
      };
    }

    if (!res.ok) {
      const bodyText = await res.text().catch(() => '');
      const rl = isRateLimitResponse(res, bodyText);
      return {
        ok: true,
        id: resolved.id,
        repo: fullName,
        url: discussionsUrl,
        newDiscussionUrl,
        items: Array.isArray(cached?.items) ? cached.items : [],
        disabled: Boolean(cached?.disabled),
        needsToken: false,
        rateLimited: rl,
        warning: rl
          ? `GitHub GraphQL rate limit reached (HTTP ${res.status}).`
          : `GitHub GraphQL request failed (HTTP ${res.status}).`,
      };
    }

    const payload = await res.json();
    const gqlErrors = Array.isArray(payload?.errors) ? payload.errors : [];
    const repoNode = payload?.data?.repository || null;

    if (!repoNode && gqlErrors.length > 0) {
      const isRl = gqlErrors.some((e) => e?.type === 'RATE_LIMITED' || /rate\s*limit/i.test(String(e?.message || '')));
      const isDisabledErr = gqlErrors.some((e) => /discussions.*disabled|not enabled/i.test(String(e?.message || '')));
      return {
        ok: true,
        id: resolved.id,
        repo: fullName,
        url: discussionsUrl,
        newDiscussionUrl,
        items: Array.isArray(cached?.items) && isRl ? cached.items : [],
        disabled: isDisabledErr,
        needsToken: false,
        rateLimited: isRl,
        warning: redactSecret(gqlErrors.map((e) => e?.message || 'GraphQL error').join('; '), token),
      };
    }

    if (!repoNode) {
      return {
        ok: true,
        id: resolved.id,
        repo: fullName,
        url: discussionsUrl,
        newDiscussionUrl,
        items: [],
        disabled: true,
        needsToken: false,
        rateLimited: false,
      };
    }

    const disabled = repoNode.hasDiscussionsEnabled === false;
    const rawNodes = disabled ? [] : Array.isArray(repoNode.discussions?.nodes) ? repoNode.discussions.nodes : [];
    const items = rawNodes
      .filter(Boolean)
      .map((node) => ({
        title: String(node.title || ''),
        url: String(node.url || discussionsUrl),
        author: String(node.author?.login || 'ghost'),
        comments: Number(node.comments?.totalCount || 0),
        updatedAt: String(node.updatedAt || ''),
        ...(node.category?.name ? { category: String(node.category.name) } : {}),
      }));

    writeJsonSafe(cachePath, {
      schemaVersion: 1,
      repo: fullName,
      disabled,
      items,
      checkedAt: new Date(nowMs).toISOString(),
      checkedAtMs: nowMs,
    });

    return {
      ok: true,
      id: resolved.id,
      repo: fullName,
      url: discussionsUrl,
      newDiscussionUrl,
      items,
      disabled,
      needsToken: false,
      rateLimited: false,
    };
  } catch (err) {
    return {
      ok: true,
      id: resolved.id,
      repo: fullName,
      url: discussionsUrl,
      newDiscussionUrl,
      items: Array.isArray(cached?.items) ? cached.items : [],
      disabled: Boolean(cached?.disabled),
      needsToken: false,
      rateLimited: false,
      warning: redactSecret(`GitHub Discussions query failed: ${err?.message || String(err)}`, token),
    };
  }
}
