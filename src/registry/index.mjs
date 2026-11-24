// Dual-Channel Live Catalog Loader (`src/registry/index.mjs`).
//
// Resolution Order (Zero Hardcoded Snapshot):
//   1. Custom User/Enterprise static `index.json` feeds (`prefs.customFeeds`, highest priority on matching repositoryId)
//   2. Primary GitHub Pages CDN with `ETag` (`If-None-Match`) / `If-Modified-Since` (`304 Not Modified` -> <50ms cache hit)
//   3. Automatic Mainland China Mirror Fallback (`@agy-market/catalog` on `registry.npmmirror.com` / Tencent Cloud mirror):
//      streams the pure-JSON npm data tarball in memory and extracts `{index.json, unverified-index.json, readmes.json}`.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseTarGzToMap } from '../installer/tar-extract.mjs';
import {
  CATALOG_NPM_PACKAGE,
  CHINA_NPM_MIRRORS,
  PRIMARY_CATALOG_BASE_URL,
  PRIMARY_FETCH_TIMEOUT_MS,
  RAW_GH_PAGES_CATALOG_BASE_URL,
} from '../shared/constants.mjs';
import { fileUriToLocalPath } from '../shared/paths.mjs';
import { sanitizePrefs } from '../shared/schemas.mjs';

function getCacheDir(dataDir) {
  const d = join(dataDir, 'cache');
  mkdirSync(d, { recursive: true });
  return d;
}

function readCachedJson(cacheDir, key) {
  const filePath = join(cacheDir, `${key}.json`);
  const metaPath = join(cacheDir, `${key}.meta.json`);
  if (!existsSync(filePath)) return { data: null, meta: {} };
  try {
    const data = JSON.parse(readFileSync(filePath, 'utf8'));
    const meta = existsSync(metaPath) ? JSON.parse(readFileSync(metaPath, 'utf8')) : {};
    return { data, meta };
  } catch {
    return { data: null, meta: {} };
  }
}

function writeCachedJson(cacheDir, key, data, meta = {}) {
  writeFileSync(join(cacheDir, `${key}.json`), `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  writeFileSync(
    join(cacheDir, `${key}.meta.json`),
    `${JSON.stringify({ ...meta, cachedAt: new Date().toISOString() }, null, 2)}\n`,
    'utf8',
  );
}

async function fetchJsonWithConditionalCache(
  url,
  cacheDir,
  cacheKey,
  {
    timeoutMs = PRIMARY_FETCH_TIMEOUT_MS,
    forceRefresh = false,
    fetchImpl = fetch,
    channelLabel = 'github-pages',
  } = {},
) {
  if (url.startsWith('file://')) {
    const local = fileUriToLocalPath(url);
    if (!local || !existsSync(local)) throw new Error(`Local feed not found: ${url}`);
    const parsed = JSON.parse(readFileSync(local, 'utf8'));
    writeCachedJson(cacheDir, cacheKey, parsed, { source: 'file', url });
    return { data: parsed, fromCache: false, channel: 'local-file' };
  }

  const cached = readCachedJson(cacheDir, cacheKey);
  const headers = { Accept: 'application/json' };
  if (!forceRefresh && cached.data && (!cached.meta.url || cached.meta.url === url)) {
    if (cached.meta.etag) headers['If-None-Match'] = cached.meta.etag;
    if (cached.meta.lastModified) headers['If-Modified-Since'] = cached.meta.lastModified;
  }

  const res = await fetchImpl(url, {
    headers,
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (res.status === 304 && cached.data) {
    return { data: cached.data, fromCache: true, status: 304, channel: `${channelLabel}-304` };
  }

  if (!res.ok) {
    throw new Error(`HTTP ${res.status} fetching ${url}`);
  }

  const data = await res.json();
  const etag = res.headers?.get?.('etag') || '';
  const lastModified = res.headers?.get?.('last-modified') || '';
  writeCachedJson(cacheDir, cacheKey, data, { etag, lastModified, url });
  return { data, fromCache: false, status: 200, channel: channelLabel };
}

/**
 * Fetches `@agy-market/catalog` from mainland China npm mirrors (`npmmirror` -> Tencent Cloud),
 * streams its `.tgz` archive in memory, and extracts `dist/{index,unverified-index,readmes}.json`.
 */
export async function loadCatalogFromNpmMirror(
  cacheDir,
  { mirrors = CHINA_NPM_MIRRORS, fetchImpl = fetch, timeoutMs = 8000 } = {},
) {
  const encodedPkg = `@${encodeURIComponent(CATALOG_NPM_PACKAGE.slice(1))}`;
  const errors = [];

  for (const mirrorBase of mirrors) {
    const packumentUrl = `${mirrorBase.replace(/\/+$/, '')}/${encodedPkg}/latest`;
    try {
      const metaRes = await fetchImpl(packumentUrl, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!metaRes.ok) {
        errors.push(`${packumentUrl} -> HTTP ${metaRes.status}`);
        continue;
      }
      const packument = await metaRes.json();
      const tarballUrl = packument?.dist?.tarball;
      if (!tarballUrl) {
        errors.push(`${packumentUrl} -> missing dist.tarball`);
        continue;
      }

      let tgzBuf;
      if (tarballUrl.startsWith('file://')) {
        tgzBuf = readFileSync(fileUriToLocalPath(tarballUrl));
      } else {
        const tgzRes = await fetchImpl(tarballUrl, { signal: AbortSignal.timeout(timeoutMs * 2) });
        if (!tgzRes.ok) {
          errors.push(`${tarballUrl} -> HTTP ${tgzRes.status}`);
          continue;
        }
        tgzBuf = Buffer.from(await tgzRes.arrayBuffer());
      }

      const filesMap = parseTarGzToMap(tgzBuf, { stripSingleTopDir: true });
      const pickJson = (relName) => {
        const buf = filesMap.get(`dist/${relName}`) || filesMap.get(relName);
        return buf ? JSON.parse(buf.toString('utf8')) : null;
      };

      const indexJson = pickJson('index.json');
      if (!indexJson || !Array.isArray(indexJson.plugins)) {
        errors.push(`${tarballUrl} -> missing valid index.json`);
        continue;
      }
      const unverifiedIndexJson = pickJson('unverified-index.json') || {
        schemaVersion: 1,
        track: 'unverified',
        plugins: [],
      };
      const readmesJson = pickJson('readmes.json') || { schemaVersion: 1, entries: {}, entriesZh: {}, entriesEn: {} };

      writeCachedJson(cacheDir, 'index', indexJson, { channel: 'npm-mirror', mirrorBase, version: packument.version });
      writeCachedJson(cacheDir, 'unverified-index', unverifiedIndexJson, {
        channel: 'npm-mirror',
        mirrorBase,
        version: packument.version,
      });
      writeCachedJson(cacheDir, 'readmes', readmesJson, { channel: 'npm-mirror', mirrorBase, version: packument.version });

      return {
        indexJson,
        unverifiedIndexJson,
        readmesJson,
        channel: `npm-mirror (${mirrorBase})`,
        catalogVersion: packument.version || indexJson.catalogVersion || '',
      };
    } catch (err) {
      errors.push(`${mirrorBase}: ${err?.message || String(err)}`);
    }
  }

  throw new Error(`ERR_MIRROR_FALLBACK_FAILED: ${errors.join(' | ')}`);
}

async function fetchSingleCustomFeed(feedUrl, index, cacheDir, fetchImpl = fetch) {
  const res = await fetchJsonWithConditionalCache(feedUrl, cacheDir, `custom-feed-${index}`, {
    timeoutMs: 6000,
    fetchImpl,
  });
  return {
    feedUrl,
    plugins: Array.isArray(res.data?.plugins) ? res.data.plugins : [],
  };
}

/**
 * Resolves and merges custom feeds + Track 1 (`index.json`) + optional Track 2 (`unverified-index.json`).
 */
export async function resolveMarketCatalog({
  dataDir,
  prefs = {},
  forceRefresh = false,
  includeReadmes = false,
  fetchImpl = fetch,
  mirrors = CHINA_NPM_MIRRORS,
}) {
  const cleanPrefs = sanitizePrefs(prefs);
  const cacheDir = getCacheDir(dataDir);
  const baseUrl = (cleanPrefs.primaryCatalogUrl || PRIMARY_CATALOG_BASE_URL).replace(/\/+$/, '');

  let verifiedFeed = null;
  let unverifiedFeed = { schemaVersion: 1, track: 'unverified', plugins: [] };
  let readmesFeed = null;
  let channelUsed = 'offline-empty';
  let activePrimaryBase = '';
  const warnings = [];

  const tryPrimary = cleanPrefs.networkMode !== 'china-mirror';
  const tryChinaMirror = cleanPrefs.networkMode !== 'direct';

  if (tryPrimary) {
    const primaryCandidates = [{ url: baseUrl, channelLabel: 'github-pages' }];
    if (baseUrl === PRIMARY_CATALOG_BASE_URL) {
      primaryCandidates.push({
        url: RAW_GH_PAGES_CATALOG_BASE_URL,
        channelLabel: 'github-raw-gh-pages',
      });
    }

    const primaryErrors = [];
    for (const candidate of primaryCandidates) {
      try {
        const vRes = await fetchJsonWithConditionalCache(`${candidate.url}/index.json`, cacheDir, 'index', {
          forceRefresh,
          fetchImpl,
          channelLabel: candidate.channelLabel,
        });
        verifiedFeed = vRes.data;
        channelUsed = vRes.channel;
        activePrimaryBase = candidate.url;

        if (cleanPrefs.enableExperimentalTrack2) {
          const uRes = await fetchJsonWithConditionalCache(
            `${candidate.url}/unverified-index.json`,
            cacheDir,
            'unverified-index',
            { forceRefresh, fetchImpl, channelLabel: candidate.channelLabel },
          ).catch(() => null);
          if (uRes?.data) unverifiedFeed = uRes.data;
        }

        if (includeReadmes) {
          const rRes = await fetchJsonWithConditionalCache(`${candidate.url}/readmes.json`, cacheDir, 'readmes', {
            forceRefresh,
            fetchImpl,
            channelLabel: candidate.channelLabel,
          }).catch(() => null);
          if (rRes?.data) readmesFeed = rRes.data;
        }
        break;
      } catch (candErr) {
        primaryErrors.push(`${candidate.url}: ${candErr?.message || String(candErr)}`);
      }
    }

    if (!verifiedFeed && primaryErrors.length > 0) {
      warnings.push(`Primary catalog unreachable (${primaryErrors.join(' | ')})`);
    }
  }

  if (!verifiedFeed && tryChinaMirror) {
    try {
      const mirrorOut = await loadCatalogFromNpmMirror(cacheDir, { mirrors, fetchImpl });
      verifiedFeed = mirrorOut.indexJson;
      if (cleanPrefs.enableExperimentalTrack2) {
        unverifiedFeed = mirrorOut.unverifiedIndexJson;
      }
      if (includeReadmes) {
        readmesFeed = mirrorOut.readmesJson;
      }
      channelUsed = mirrorOut.channel;
    } catch (mirrorErr) {
      warnings.push(`China mirror fallback unreachable (${mirrorErr?.message || String(mirrorErr)})`);
    }
  }

  // Last-resort disk cache fallback when user is completely offline
  if (!verifiedFeed) {
    const diskIndex = readCachedJson(cacheDir, 'index').data;
    if (diskIndex) {
      verifiedFeed = diskIndex;
      channelUsed = 'disk-cache-offline';
    } else {
      verifiedFeed = { schemaVersion: 1, track: 'verified', catalogVersion: 'offline', plugins: [] };
    }
    if (cleanPrefs.enableExperimentalTrack2) {
      unverifiedFeed = readCachedJson(cacheDir, 'unverified-index').data || unverifiedFeed;
    }
    if (includeReadmes) {
      readmesFeed = readCachedJson(cacheDir, 'readmes').data || {
        schemaVersion: 1,
        entries: {},
        entriesZh: {},
        entriesEn: {},
      };
    }
  }

  // Merge Custom Feeds with highest priority on matching `repositoryId` or `id`
  const mergedPlugins = [];
  const seenRepoIds = new Set();
  const seenIds = new Set();

  for (let i = 0; i < cleanPrefs.customFeeds.length; i++) {
    const feedUrl = cleanPrefs.customFeeds[i];
    try {
      const custom = await fetchSingleCustomFeed(feedUrl, i, cacheDir, fetchImpl);
      for (const p of custom.plugins) {
        const repoId = Number(p?.repository?.repositoryId || 0);
        if ((repoId > 0 && seenRepoIds.has(repoId)) || seenIds.has(p.id)) continue;
        if (repoId > 0) seenRepoIds.add(repoId);
        seenIds.add(p.id);
        mergedPlugins.push({ ...p, _track: 'custom', _feedUrl: feedUrl });
      }
    } catch (err) {
      warnings.push(`Custom feed failed (${feedUrl}): ${err?.message || String(err)}`);
    }
  }

  const normalizePluginMedia = (p) => {
    if (
      activePrimaryBase === RAW_GH_PAGES_CATALOG_BASE_URL &&
      typeof p?.media?.iconUrl === 'string' &&
      p.media.iconUrl.startsWith(`${PRIMARY_CATALOG_BASE_URL}/`)
    ) {
      return {
        ...p,
        media: {
          ...p.media,
          iconUrl: `${RAW_GH_PAGES_CATALOG_BASE_URL}/${p.media.iconUrl.slice(PRIMARY_CATALOG_BASE_URL.length + 1)}`,
        },
      };
    }
    return p;
  };

  for (const rawP of verifiedFeed?.plugins || []) {
    const p = normalizePluginMedia(rawP);
    const repoId = Number(p?.repository?.repositoryId || 0);
    if ((repoId > 0 && seenRepoIds.has(repoId)) || seenIds.has(p.id)) continue;
    if (repoId > 0) seenRepoIds.add(repoId);
    seenIds.add(p.id);
    mergedPlugins.push({ ...p, _track: 'verified' });
  }

  if (cleanPrefs.enableExperimentalTrack2) {
    for (const rawP of unverifiedFeed?.plugins || []) {
      const p = normalizePluginMedia(rawP);
      const repoId = Number(p?.repository?.repositoryId || 0);
      if ((repoId > 0 && seenRepoIds.has(repoId)) || seenIds.has(p.id)) continue;
      if (repoId > 0) seenRepoIds.add(repoId);
      seenIds.add(p.id);
      mergedPlugins.push({
        ...p,
        forceScopedInstall: true,
        _track: 'unverified',
      });
    }
  }

  const resolvedReadmes = readmesFeed || readCachedJson(cacheDir, 'readmes').data || {};

  return {
    channelUsed,
    catalogVersion: verifiedFeed?.catalogVersion || '',
    generatedAt: verifiedFeed?.generatedAt || null,
    plugins: mergedPlugins,
    readmes: resolvedReadmes.entries && typeof resolvedReadmes.entries === 'object' ? resolvedReadmes.entries : {},
    readmesZh:
      resolvedReadmes.entriesZh && typeof resolvedReadmes.entriesZh === 'object' ? resolvedReadmes.entriesZh : {},
    readmesEn:
      resolvedReadmes.entriesEn && typeof resolvedReadmes.entriesEn === 'object' ? resolvedReadmes.entriesEn : {},
    warnings,
  };
}
