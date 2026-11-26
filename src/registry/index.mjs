// Dual-Channel Live Catalog Loader (`src/registry/index.mjs`).
//
// Resolution Order (Zero Hardcoded Snapshot):
//   1. Custom User/Enterprise static `index.json` feeds (`prefs.customFeeds`, highest priority on matching repositoryId)
//   2. Primary GitHub Pages CDN with `ETag` (`If-None-Match`) / `If-Modified-Since` (`304 Not Modified` -> <50ms cache hit)
//   3. Automatic Mainland China Mirror Fallback (`@agy-market/catalog` on `registry.npmmirror.com` / Tencent Cloud mirror):
//      streams the pure-JSON npm data tarball in memory and extracts `{index.json, unverified-index.json, readmes.json}`.

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseTarGzToMap } from '../installer/tar-extract.mjs';
import {
  CATALOG_NPM_PACKAGE,
  CHINA_NPM_MIRRORS,
  PRIMARY_CATALOG_BASE_URL,
  PRIMARY_FETCH_TIMEOUT_MS,
  RAW_GH_PAGES_CATALOG_BASE_URL,
  UNVERIFIED_FETCH_TIMEOUT_MS,
} from '../shared/constants.mjs';
import { fileUriToLocalPath } from '../shared/paths.mjs';
import { defaultProxyFetch } from '../shared/proxy-fetch.mjs';
import { sanitizePrefs } from '../shared/schemas.mjs';

function resolveFetch(fetchImpl) {
  return !fetchImpl || fetchImpl === fetch ? defaultProxyFetch : fetchImpl;
}

function getCacheDir(dataDir) {
  const d = join(dataDir, 'cache');
  mkdirSync(d, { recursive: true });
  return d;
}

function getPerPluginReadmesCacheDir(dataDir) {
  const d = join(getCacheDir(dataDir), 'readmes');
  mkdirSync(d, { recursive: true });
  return d;
}

function toSafeReadmeCacheKey(rawId) {
  const clean = String(rawId || '').trim();
  if (
    !clean ||
    clean === '.' ||
    clean === '..' ||
    clean.includes('/') ||
    clean.includes('\\') ||
    clean.includes('..') ||
    clean.includes('\0')
  ) {
    return '';
  }
  return clean.replace(/[^A-Za-z0-9._-]/g, '_');
}

function normalizePerPluginReadmePayload(raw, fallbackId = '') {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const hasKnownField =
    typeof raw.default === 'string' || typeof raw.zh === 'string' || typeof raw.en === 'string';
  if (!hasKnownField) return null;
  const def = typeof raw.default === 'string' ? raw.default : '';
  const zh = typeof raw.zh === 'string' ? raw.zh : '';
  const en = typeof raw.en === 'string' ? raw.en : '';
  if (!def.trim() && !zh.trim() && !en.trim() && raw.id !== fallbackId) return null;
  return {
    id: typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : fallbackId,
    default: def,
    zh,
    en,
  };
}

function extractPluginFromMonolithicReadmes(doc, id) {
  if (!doc || typeof doc !== 'object' || !id) return null;
  const entries = doc.entries && typeof doc.entries === 'object' ? doc.entries : doc.readmes || {};
  const entriesZh = doc.entriesZh && typeof doc.entriesZh === 'object' ? doc.entriesZh : doc.readmesZh || {};
  const entriesEn = doc.entriesEn && typeof doc.entriesEn === 'object' ? doc.entriesEn : doc.readmesEn || {};
  const def = typeof entries[id] === 'string' ? entries[id] : '';
  const zh = typeof entriesZh[id] === 'string' ? entriesZh[id] : '';
  const en = typeof entriesEn[id] === 'string' ? entriesEn[id] : '';
  if (!def.trim() && !zh.trim() && !en.trim()) return null;
  return { id, default: def, zh, en };
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

function writeJsonAtomic(filePath, value) {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(value), 'utf8');
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

function writeCachedJson(cacheDir, key, data, meta = {}) {
  writeJsonAtomic(join(cacheDir, `${key}.json`), data);
  writeJsonAtomic(join(cacheDir, `${key}.meta.json`), { ...meta, cachedAt: new Date().toISOString() });
}

async function fetchJsonWithConditionalCache(
  url,
  cacheDir,
  cacheKey,
  {
    timeoutMs = PRIMARY_FETCH_TIMEOUT_MS,
    forceRefresh = false,
    fetchImpl = defaultProxyFetch,
    channelLabel = 'github-pages',
  } = {},
) {
  const activeFetch = resolveFetch(fetchImpl);
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

  const res = await activeFetch(url, {
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
  { mirrors = CHINA_NPM_MIRRORS, fetchImpl = defaultProxyFetch, timeoutMs = 8000 } = {},
) {
  const activeFetch = resolveFetch(fetchImpl);
  const encodedPkg = `@${encodeURIComponent(CATALOG_NPM_PACKAGE.slice(1))}`;
  const errors = [];

  for (const mirrorBase of mirrors) {
    const packumentUrl = `${mirrorBase.replace(/\/+$/, '')}/${encodedPkg}/latest`;
    try {
      const metaRes = await activeFetch(packumentUrl, {
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
        const tgzRes = await activeFetch(tarballUrl, { signal: AbortSignal.timeout(timeoutMs * 2) });
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
      const realUnverified = pickJson('unverified-index.json');
      const unverifiedMissing = !realUnverified || !Array.isArray(realUnverified.plugins);
      const unverifiedIndexJson = unverifiedMissing
        ? { schemaVersion: 1, track: 'unverified', plugins: [] }
        : realUnverified;
      const readmesJson = pickJson('readmes.json') || { schemaVersion: 1, entries: {}, entriesZh: {}, entriesEn: {} };

      // Also extract any per-plugin `dist/readmes/<id>.json` files shipped in v1.6+ catalog tarballs
      const perPluginReadmes = {};
      const perPluginCacheDir = join(cacheDir, 'readmes');
      let ensuredPerPluginDir = false;
      for (const [relPath, buf] of filesMap.entries()) {
        const m = /^(?:dist\/)?readmes\/([^/]+)\.json$/.exec(relPath);
        if (!m) continue;
        try {
          const parsedItem = JSON.parse(buf.toString('utf8'));
          const norm = normalizePerPluginReadmePayload(parsedItem, m[1]);
          if (norm) {
            perPluginReadmes[norm.id] = norm;
            const safeKey = toSafeReadmeCacheKey(norm.id);
            if (safeKey) {
              if (!ensuredPerPluginDir) {
                mkdirSync(perPluginCacheDir, { recursive: true });
                ensuredPerPluginDir = true;
              }
              writeCachedJson(perPluginCacheDir, safeKey, norm, {
                channel: 'npm-mirror',
                mirrorBase,
                version: packument.version,
              });
            }
          }
        } catch {
          /* skip malformed per-plugin readme entry */
        }
      }

      writeCachedJson(cacheDir, 'index', indexJson, { channel: 'npm-mirror', mirrorBase, version: packument.version });
      if (!unverifiedMissing) {
        writeCachedJson(cacheDir, 'unverified-index', unverifiedIndexJson, {
          channel: 'npm-mirror',
          mirrorBase,
          version: packument.version,
        });
      }
      writeCachedJson(cacheDir, 'readmes', readmesJson, { channel: 'npm-mirror', mirrorBase, version: packument.version });

      return {
        indexJson,
        unverifiedIndexJson,
        unverifiedMissing,
        readmesJson,
        perPluginReadmes,
        channel: `npm-mirror (${mirrorBase})`,
        catalogVersion: packument.version || indexJson.catalogVersion || '',
      };
    } catch (err) {
      errors.push(`${mirrorBase}: ${err?.message || String(err)}`);
    }
  }

  throw new Error(`ERR_MIRROR_FALLBACK_FAILED: ${errors.join(' | ')}`);
}

async function fetchSingleCustomFeed(feedUrl, index, cacheDir, fetchImpl = defaultProxyFetch) {
  const res = await fetchJsonWithConditionalCache(feedUrl, cacheDir, `custom-feed-${index}`, {
    timeoutMs: 6000,
    fetchImpl: resolveFetch(fetchImpl),
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
  fetchImpl = defaultProxyFetch,
  mirrors = CHINA_NPM_MIRRORS,
}) {
  const activeFetch = resolveFetch(fetchImpl);
  const cleanPrefs = sanitizePrefs(prefs);
  const cacheDir = getCacheDir(dataDir);
  const baseUrl = (cleanPrefs.primaryCatalogUrl || PRIMARY_CATALOG_BASE_URL).replace(/\/+$/, '');

  let verifiedFeed = null;
  let unverifiedFeed = { schemaVersion: 1, track: 'unverified', plugins: [] };
  let readmesFeed = null;
  let channelUsed = 'offline-empty';
  let activePrimaryBase = '';
  const warnings = [];
  const warnBi = (zh, en) => warnings.push(`${zh} / ${en}`);
  const errMsg = (e) => e?.message || String(e);
  const wantTrack2 = Boolean(cleanPrefs.enableExperimentalTrack2);
  let track2Loaded = false;
  let mirrorLackedTrack2 = false;

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
          fetchImpl: activeFetch,
          channelLabel: candidate.channelLabel,
        });
        verifiedFeed = vRes.data;
        channelUsed = vRes.channel;
        activePrimaryBase = candidate.url;

        if (includeReadmes) {
          const rRes = await fetchJsonWithConditionalCache(`${candidate.url}/readmes.json`, cacheDir, 'readmes', {
            forceRefresh,
            fetchImpl: activeFetch,
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
      warnBi(
        `主目录不可达 (${primaryErrors.join(' | ')})`,
        `Primary catalog unreachable (${primaryErrors.join(' | ')})`,
      );
    }

    // Track 2 (`unverified-index.json`, ~2 MB): own long timeout, alternate primary, never silent.
    if (wantTrack2 && verifiedFeed) {
      const ordered = [
        ...primaryCandidates.filter((c) => c.url === activePrimaryBase),
        ...primaryCandidates.filter((c) => c.url !== activePrimaryBase),
      ];
      const t2Errors = [];
      for (const candidate of ordered) {
        try {
          const uRes = await fetchJsonWithConditionalCache(`${candidate.url}/unverified-index.json`, cacheDir, 'unverified-index', {
            timeoutMs: UNVERIFIED_FETCH_TIMEOUT_MS,
            forceRefresh,
            fetchImpl: activeFetch,
            channelLabel: candidate.channelLabel,
          });
          if (uRes?.data && Array.isArray(uRes.data.plugins)) {
            unverifiedFeed = uRes.data;
            track2Loaded = true;
            if (t2Errors.length > 0) {
              warnBi(
                `Track 2 主源失败，已改用备用源 ${candidate.channelLabel}: ${t2Errors.join(' | ')}`,
                `Track 2 primary failed, loaded from alternate ${candidate.channelLabel}: ${t2Errors.join(' | ')}`,
              );
            }
            break;
          }
          t2Errors.push(`${candidate.url}: invalid unverified-index payload`);
        } catch (e) {
          t2Errors.push(`${candidate.url}: ${errMsg(e)}`);
        }
      }
      if (!track2Loaded) {
        warnBi(
          `Track 2 在线加载失败，将尝试镜像/本地缓存 (${t2Errors.join(' | ')})`,
          `Track 2 online fetch failed, trying mirror/local cache (${t2Errors.join(' | ')})`,
        );
      }
    }
  }

  if (!verifiedFeed && tryChinaMirror) {
    try {
      const mirrorOut = await loadCatalogFromNpmMirror(cacheDir, { mirrors, fetchImpl: activeFetch });
      verifiedFeed = mirrorOut.indexJson;
      if (wantTrack2 && !mirrorOut.unverifiedMissing) {
        unverifiedFeed = mirrorOut.unverifiedIndexJson;
        track2Loaded = true;
      } else if (wantTrack2 && mirrorOut.unverifiedMissing) {
        mirrorLackedTrack2 = true;
      }
      if (includeReadmes) {
        readmesFeed = mirrorOut.readmesJson;
      }
      channelUsed = mirrorOut.channel;
    } catch (mirrorErr) {
      warnBi(
        `国内镜像回退不可达 (${errMsg(mirrorErr)})，将使用 GitHub/本地缓存`,
        `China mirror fallback unreachable (${errMsg(mirrorErr)}); using GitHub/local cache`,
      );
    }
  }

  // china-mirror mode with an unpublished/unreachable npm package: degrade to GitHub Pages / raw gh-pages (B2).
  if (!verifiedFeed && !tryPrimary) {
    const bases = [{ url: baseUrl, label: 'github-pages' }];
    if (baseUrl === PRIMARY_CATALOG_BASE_URL) bases.push({ url: RAW_GH_PAGES_CATALOG_BASE_URL, label: 'github-raw-gh-pages' });
    for (const b of bases) {
      try {
        const vRes = await fetchJsonWithConditionalCache(`${b.url}/index.json`, cacheDir, 'index', {
          forceRefresh,
          fetchImpl: activeFetch,
          channelLabel: b.label,
        });
        verifiedFeed = vRes.data;
        channelUsed = vRes.channel;
        activePrimaryBase = b.url;
        warnBi('镜像不可用，已回退到 GitHub 源', 'Mirror unavailable; fell back to GitHub source ' + b.url);
        break;
      } catch (e) {
        warnBi(`GitHub 回退失败 (${b.url}: ${errMsg(e)})`, `GitHub fallback failed (${b.url}: ${errMsg(e)})`);
      }
    }
  }

  // Track 2 raw-GitHub/gh-pages retry when in china-mirror mode (if mirror failed or lacked Track 2).
  if (wantTrack2 && !track2Loaded && !tryPrimary && cleanPrefs.networkMode === 'china-mirror') {
    const fallbackBases = [baseUrl];
    if (baseUrl === PRIMARY_CATALOG_BASE_URL && !fallbackBases.includes(RAW_GH_PAGES_CATALOG_BASE_URL)) {
      fallbackBases.push(RAW_GH_PAGES_CATALOG_BASE_URL);
    }
    const orderedBases = activePrimaryBase
      ? [activePrimaryBase, ...fallbackBases.filter((b) => b !== activePrimaryBase)]
      : fallbackBases;
    const errs = [];
    for (const b of orderedBases) {
      try {
        const uRes = await fetchJsonWithConditionalCache(`${b}/unverified-index.json`, cacheDir, 'unverified-index', {
          timeoutMs: UNVERIFIED_FETCH_TIMEOUT_MS,
          forceRefresh,
          fetchImpl: activeFetch,
          channelLabel: b === RAW_GH_PAGES_CATALOG_BASE_URL ? 'github-raw-gh-pages' : 'github-pages',
        });
        if (uRes?.data && Array.isArray(uRes.data.plugins)) {
          unverifiedFeed = uRes.data;
          track2Loaded = true;
          if (mirrorLackedTrack2 || errs.length > 0) {
            warnBi(
              `镜像未提供 Track 2，已从 ${b} 加载`,
              `Mirror lacked Track 2; loaded from ${b}`,
            );
          }
          break;
        }
        errs.push(`${b}: invalid unverified-index payload`);
      } catch (e) {
        errs.push(`${b}: ${errMsg(e)}`);
      }
    }
    if (!track2Loaded && errs.length > 0) {
      warnBi(
        `Track 2 GitHub 回退源不可达 (${errs.join(' | ')})`,
        `Track 2 GitHub fallback unreachable (${errs.join(' | ')})`,
      );
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
    if (includeReadmes) {
      readmesFeed = readCachedJson(cacheDir, 'readmes').data || {
        schemaVersion: 1,
        entries: {},
        entriesZh: {},
        entriesEn: {},
      };
    }
  }

  // Track 2 local-cache fallback, INDEPENDENT of whether the verified feed succeeded.
  if (wantTrack2 && !track2Loaded) {
    const diskT2 = readCachedJson(cacheDir, 'unverified-index');
    if (diskT2.data && Array.isArray(diskT2.data.plugins) && diskT2.data.plugins.length > 0) {
      unverifiedFeed = diskT2.data;
      track2Loaded = true;
      warnBi(
        `Track 2 使用本地缓存 (${diskT2.data.plugins.length} 个插件, 缓存于 ${diskT2.meta?.cachedAt || '未知'})，可能不是最新`,
        `Track 2 served from local cache (${diskT2.data.plugins.length} plugins, cached ${diskT2.meta?.cachedAt || 'unknown'}); may be stale`,
      );
    } else {
      warnBi(
        'Track 2 暂不可用：在线源与本地缓存均无数据，请检查网络后点击刷新',
        'Track 2 unavailable: no online source or local cache; check network and refresh',
      );
    }
  }

  const normalizePluginRoot = (rawRoot) => {
    const s = String(rawRoot || '.')
      .trim()
      .replace(/\\/g, '/')
      .replace(/^\.\/+/, '')
      .replace(/\/+$/, '');
    return s || '.';
  };

  const makeRepoRootKey = (plugin) => {
    const repoId = Number(plugin?.repository?.repositoryId || 0);
    if (repoId <= 0) return '';
    return `${repoId}:${normalizePluginRoot(plugin?.repository?.pluginRoot)}`;
  };

  // Merge Custom Feeds with highest priority on matching `(repositoryId, pluginRoot)` or `id`
  const mergedPlugins = [];
  const seenRepoRoots = new Set();
  const seenIds = new Set();

  for (let i = 0; i < cleanPrefs.customFeeds.length; i++) {
    const feedUrl = cleanPrefs.customFeeds[i];
    try {
      const custom = await fetchSingleCustomFeed(feedUrl, i, cacheDir, activeFetch);
      for (const p of custom.plugins) {
        const repoRootKey = makeRepoRootKey(p);
        if ((repoRootKey && seenRepoRoots.has(repoRootKey)) || seenIds.has(p.id)) continue;
        if (repoRootKey) seenRepoRoots.add(repoRootKey);
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
    const repoRootKey = makeRepoRootKey(p);
    if ((repoRootKey && seenRepoRoots.has(repoRootKey)) || seenIds.has(p.id)) continue;
    if (repoRootKey) seenRepoRoots.add(repoRootKey);
    seenIds.add(p.id);
    mergedPlugins.push({ ...p, _track: 'verified' });
  }

  if (cleanPrefs.enableExperimentalTrack2) {
    for (const rawP of unverifiedFeed?.plugins || []) {
      const p = normalizePluginMedia(rawP);
      const repoRootKey = makeRepoRootKey(p);
      if ((repoRootKey && seenRepoRoots.has(repoRootKey)) || seenIds.has(p.id)) continue;
      if (repoRootKey) seenRepoRoots.add(repoRootKey);
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
    primaryBaseUrl: activePrimaryBase || baseUrl,
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

/**
 * Lazy per-plugin README loader (`dist/readmes/<id>.json`) with per-plugin ETag caching at
 * `${dataDir}/cache/readmes/<id>.json` and seamless fallback to cached/monolithic `readmes.json`,
 * China `@agy-market/catalog` npm mirror, and offline disk cache.
 */
export async function fetchPluginReadme({
  id,
  dataDir,
  prefs = {},
  primaryBaseUrl = '',
  cachedCatalog = null,
  forceRefresh = false,
  fetchImpl = defaultProxyFetch,
  mirrors = CHINA_NPM_MIRRORS,
  timeoutMs = PRIMARY_FETCH_TIMEOUT_MS,
}) {
  const activeFetch = resolveFetch(fetchImpl);
  const pluginId = String(id || '').trim();
  const safeKey = toSafeReadmeCacheKey(pluginId);
  if (!safeKey) {
    return { ok: false, id: pluginId, default: '', zh: '', en: '', fromCache: false, channel: 'invalid-id' };
  }

  const cleanPrefs = sanitizePrefs(prefs);
  const cacheDir = getCacheDir(dataDir);
  const perPluginCacheDir = getPerPluginReadmesCacheDir(dataDir);
  const baseUrl = (primaryBaseUrl || cleanPrefs.primaryCatalogUrl || PRIMARY_CATALOG_BASE_URL).replace(/\/+$/, '');

  const tryPrimary = cleanPrefs.networkMode !== 'china-mirror';
  const tryChinaMirror = cleanPrefs.networkMode !== 'direct';

  const primaryCandidates = [];
  const pushCandidate = (url, channelLabel) => {
    const clean = String(url || '').replace(/\/+$/, '');
    if (!clean || primaryCandidates.some((c) => c.url === clean)) return;
    primaryCandidates.push({ url: clean, channelLabel });
  };
  pushCandidate(
    baseUrl,
    baseUrl === RAW_GH_PAGES_CATALOG_BASE_URL ? 'github-raw-gh-pages' : 'github-pages',
  );
  if (baseUrl === PRIMARY_CATALOG_BASE_URL || cleanPrefs.primaryCatalogUrl === PRIMARY_CATALOG_BASE_URL) {
    pushCandidate(PRIMARY_CATALOG_BASE_URL, 'github-pages');
    pushCandidate(RAW_GH_PAGES_CATALOG_BASE_URL, 'github-raw-gh-pages');
  }

  let anyPrimaryReachable = false;
  let monolithicData = null;

  // 1. Primary lazy per-plugin endpoint: `${base}/readmes/${encodeURIComponent(id)}.json` with ETag cache
  if (tryPrimary) {
    const cachedPerPlugin = readCachedJson(perPluginCacheDir, safeKey);
    for (const candidate of primaryCandidates) {
      const perUrl = `${candidate.url}/readmes/${encodeURIComponent(pluginId)}.json`;
      try {
        if (perUrl.startsWith('file://')) {
          const local = fileUriToLocalPath(perUrl);
          if (local && existsSync(local)) {
            const norm = normalizePerPluginReadmePayload(JSON.parse(readFileSync(local, 'utf8')), pluginId);
            if (norm) {
              writeCachedJson(perPluginCacheDir, safeKey, norm, { source: 'file', url: perUrl });
              return { ok: true, ...norm, fromCache: false, channel: 'local-file-per-plugin' };
            }
          }
          continue;
        }

        const headers = { Accept: 'application/json' };
        if (
          !forceRefresh &&
          cachedPerPlugin.data &&
          (!cachedPerPlugin.meta.url || cachedPerPlugin.meta.url === perUrl)
        ) {
          if (cachedPerPlugin.meta.etag) headers['If-None-Match'] = cachedPerPlugin.meta.etag;
          if (cachedPerPlugin.meta.lastModified) headers['If-Modified-Since'] = cachedPerPlugin.meta.lastModified;
        }

        const res = await activeFetch(perUrl, {
          headers,
          signal: AbortSignal.timeout(timeoutMs),
        });

        if (res.status === 304 && cachedPerPlugin.data) {
          const norm = normalizePerPluginReadmePayload(cachedPerPlugin.data, pluginId);
          if (norm) {
            return { ok: true, ...norm, fromCache: true, channel: `${candidate.channelLabel}-per-plugin-304` };
          }
        }

        if (res.ok) {
          anyPrimaryReachable = true;
          const rawJson = await res.json().catch(() => null);
          const norm = normalizePerPluginReadmePayload(rawJson, pluginId);
          if (norm) {
            const etag = res.headers?.get?.('etag') || '';
            const lastModified = res.headers?.get?.('last-modified') || '';
            writeCachedJson(perPluginCacheDir, safeKey, norm, { etag, lastModified, url: perUrl });
            return { ok: true, ...norm, fromCache: false, channel: `${candidate.channelLabel}-per-plugin` };
          }
        } else if (res.status >= 400 && res.status < 500) {
          // 404 on per-plugin endpoint may simply mean legacy catalog only serves monolithic readmes.json
          anyPrimaryReachable = true;
        }
      } catch {
        /* try next primary candidate */
      }
    }
  }

  // 2. Fallback to in-memory monolithic catalog readmes (already loaded)
  if (!forceRefresh && cachedCatalog) {
    const fromMem = extractPluginFromMonolithicReadmes(cachedCatalog, pluginId);
    if (fromMem) {
      return { ok: true, ...fromMem, fromCache: true, channel: 'monolithic-memory' };
    }
  }

  // 3. Fallback to primary monolithic `readmes.json` with conditional ETag cache
  if (tryPrimary) {
    let monolithicSucceeded = false;
    for (const candidate of primaryCandidates) {
      try {
        const rRes = await fetchJsonWithConditionalCache(`${candidate.url}/readmes.json`, cacheDir, 'readmes', {
          timeoutMs,
          forceRefresh,
          fetchImpl: activeFetch,
          channelLabel: candidate.channelLabel,
        });
        if (rRes?.data && typeof rRes.data === 'object') {
          anyPrimaryReachable = true;
          monolithicSucceeded = true;
          monolithicData = rRes.data;
          const found = extractPluginFromMonolithicReadmes(rRes.data, pluginId);
          if (found) {
            return {
              ok: true,
              ...found,
              fromCache: Boolean(rRes.fromCache),
              channel: rRes.fromCache ? `${candidate.channelLabel}-monolithic-304` : `${candidate.channelLabel}-monolithic`,
              monolithicReadmes: rRes.data,
            };
          }
          break;
        }
      } catch {
        /* try next primary candidate */
      }
    }
    if (monolithicSucceeded) {
      // Primary monolithic readmes loaded cleanly and does not contain this id — check local per-plugin cache before returning
      const cachedPer = normalizePerPluginReadmePayload(readCachedJson(perPluginCacheDir, safeKey).data, pluginId);
      if (cachedPer) {
        return {
          ok: true,
          ...cachedPer,
          fromCache: true,
          channel: 'disk-cache-per-plugin',
          ...(monolithicData ? { monolithicReadmes: monolithicData } : {}),
        };
      }
      return {
        ok: false,
        id: pluginId,
        default: '',
        zh: '',
        en: '',
        fromCache: false,
        channel: 'not-found',
        ...(monolithicData ? { monolithicReadmes: monolithicData } : {}),
      };
    }
  }

  // 4. Fallback to China `@agy-market/catalog` npm mirror (in china-mirror mode or when primary is unreachable)
  if (tryChinaMirror && (!tryPrimary || !anyPrimaryReachable)) {
    if (!forceRefresh) {
      const diskPer = normalizePerPluginReadmePayload(readCachedJson(perPluginCacheDir, safeKey).data, pluginId);
      if (diskPer) {
        return { ok: true, ...diskPer, fromCache: true, channel: 'disk-cache-per-plugin' };
      }
      const diskMono = readCachedJson(cacheDir, 'readmes');
      if (diskMono.data && diskMono.meta?.channel === 'npm-mirror') {
        const fromDiskMono = extractPluginFromMonolithicReadmes(diskMono.data, pluginId);
        if (fromDiskMono) {
          return {
            ok: true,
            ...fromDiskMono,
            fromCache: true,
            channel: 'npm-mirror-cache',
            monolithicReadmes: diskMono.data,
          };
        }
      }
    }

    try {
      const mirrorOut = await loadCatalogFromNpmMirror(cacheDir, { mirrors, fetchImpl: activeFetch });
      monolithicData = mirrorOut.readmesJson;
      if (mirrorOut.perPluginReadmes?.[pluginId]) {
        return {
          ok: true,
          ...mirrorOut.perPluginReadmes[pluginId],
          fromCache: false,
          channel: `${mirrorOut.channel}-per-plugin`,
          monolithicReadmes: mirrorOut.readmesJson,
        };
      }
      const fromMirrorMono = extractPluginFromMonolithicReadmes(mirrorOut.readmesJson, pluginId);
      if (fromMirrorMono) {
        return {
          ok: true,
          ...fromMirrorMono,
          fromCache: false,
          channel: `${mirrorOut.channel}-monolithic`,
          monolithicReadmes: mirrorOut.readmesJson,
        };
      }
    } catch {
      /* fall through to offline disk cache */
    }
  }

  // 5. Offline disk cache fallback (per-plugin cache first, then monolithic cache)
  const offlinePer = normalizePerPluginReadmePayload(readCachedJson(perPluginCacheDir, safeKey).data, pluginId);
  if (offlinePer) {
    return { ok: true, ...offlinePer, fromCache: true, channel: 'disk-cache-per-plugin' };
  }
  const offlineMono = readCachedJson(cacheDir, 'readmes').data;
  const fromOfflineMono = extractPluginFromMonolithicReadmes(offlineMono, pluginId);
  if (fromOfflineMono) {
    return {
      ok: true,
      ...fromOfflineMono,
      fromCache: true,
      channel: 'disk-cache-monolithic',
      monolithicReadmes: offlineMono,
    };
  }

  return {
    ok: false,
    id: pluginId,
    default: '',
    zh: '',
    en: '',
    fromCache: false,
    channel: 'not-found',
    ...(monolithicData ? { monolithicReadmes: monolithicData } : {}),
  };
}
