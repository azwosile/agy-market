// Localhost 127.0.0.1 Sidecar HTTP Router, X-Sidecar-Token CSRF Guard & State Persistence (`src/sidecar/server.mjs`).

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { gzip } from 'node:zlib';
import { fetchPluginDiscussions } from '../discussions/index.mjs';
import {
  inspectGithubPluginUrl,
  installGithubPlugin,
  resolveAndStageGithubUpdate,
  sweepExpiredInspectStaging,
} from '../installer/github-url.mjs';
import {
  fixLocalConflict,
  getReplacementKey,
  getUpdateEscalation,
  installOrUpdateCatalogPlugin,
  toggleInstalledPlugin,
  uninstallPlugin,
} from '../installer/index.mjs';
import { recoverInterruptedJournal, trySweepRetiredBinaries } from '../installer/journal.mjs';
import { scanLocalConflicts } from '../preflight/conflicts.mjs';
import {
  findManagedSuccessor,
  matchLegacyLocalFavorite,
  findCatalogEntryForLocal,
  matchesInstalledSource,
  legacyDuplicateResult,
  invalidateLocalInventoryCache,
  normalizeRepoUrl,
  samePluginName,
  resolveInstallPreflight,
  scanLocalPluginInventory,
} from '../preflight/index.mjs';
import { fetchPluginReadme, hasCachedTrack2, resolveMarketCatalog } from '../registry/index.mjs';
import { classifyActivationRequirement } from '../shared/activation.mjs';
import {
  CUSTOMIZATION_URI,
  GZIP_MIN_BYTES,
  MAX_FAVORITES,
  MAX_IGNORED_CONFLICTS,
  PLUGIN_DISPLAY_NAME,
  PLUGIN_ID,
  PLUGIN_VERSION,
  SELF_CATALOG_ID,
  SELF_REPO_URL,
  SIDECAR_URI,
} from '../shared/constants.mjs';
import {
  resolveAntigravityConfigDir,
  resolveMarketDataDir,
  resolvePluginsDir,
} from '../shared/paths.mjs';
import { defaultProxyFetch } from '../shared/proxy-fetch.mjs';
import {
  computeCapabilityEscalation,
  loadPrefsFromDisk,
  makeFavoriteSource,
  mergeCapabilityProfiles,
  normalizePluginRoot,
  sanitizeIgnoredConflictIds,
  sanitizePrefs,
  updatePrefsOnDisk,
  toPublicPrefs,
} from '../shared/schemas.mjs';
import { isNewerVersion, parseSemver } from '../shared/semver.mjs';
import { checkPluginUpdates, isCatalogPluginInstallable, isForeignMarketInstall, isOfficialMarketEntry, isSameInstalledRelease, parseGithubRepoSlug, probeGithubBranchHead } from '../updates/index.mjs';
import { openSiblingSidecarPane } from './open-pane.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');
const DEFAULT_INDEX_HTML_PATH = join(REPO_ROOT, 'sidecars', 'market_pane', 'index.html');
const MAX_JSON_BODY = 2 * 1024 * 1024;
const MAX_LOCAL_README_CHARS = 64_000;
const CJK_CHAR_RE = /[\u4e00-\u9fff]/;

const ZH_README_FILENAMES = [
  'README.zh-CN.md',
  'README.zh.md',
  'readme.zh-cn.md',
  'readme.zh.md',
  'docs/README.zh-CN.md',
  'docs/README.zh.md',
];
const EN_README_FILENAMES = ['README.en.md', 'readme.en.md', 'docs/README.en.md'];
const DEFAULT_README_FILENAMES = ['README.md', 'readme.md'];
const INSTALL_ROUTES = new Set([
  '/api/install',
  '/api/update',
  '/api/update-all',
  '/api/self-update',
  '/api/github/install',
]);
const PLUGIN_MUTATION_ROUTES = new Set([
  ...INSTALL_ROUTES,
  '/api/uninstall',
  '/api/remove-files',
  '/api/toggle-plugin',
  '/api/fix-conflict',
]);

const PRELOAD_SHIM_JS = `(function() {
  var params = new URLSearchParams(window.location.search);
  var boot = window.__SIDECAR_BOOT__ || {};
  var token = params.get('token') || boot.token || '';
  var conversationId = params.get('conversationId') || boot.conversationId || '';
  var workspaceUris = [];
  var wsListeners = new Set();

  window.addEventListener('message', function(event) {
    if (!event.data || typeof event.data !== 'object') return;
    if (event.data.type === 'theme-change') {
      var vars = (event.data.payload && event.data.payload.cssVariables) || {};
      Object.keys(vars).forEach(function(k) {
        document.documentElement.style.setProperty(k, vars[k]);
      });
      if (event.data.payload && event.data.payload.theme) {
        document.documentElement.setAttribute('data-theme', event.data.payload.theme);
      }
      window.dispatchEvent(new CustomEvent('agy-market-theme', { detail: event.data.payload || {} }));
    } else if (event.data.type === 'workspace-change') {
      var list = (event.data.payload && event.data.payload.workspaceUris) || [];
      workspaceUris = Array.isArray(list) ? list.slice() : [];
      wsListeners.forEach(function(fn) { try { fn(workspaceUris.slice()); } catch (_) {} });
    }
  });

  function secureFetch(url, options) {
    var init = Object.assign({}, options || {});
    var headers = new Headers(init.headers || {});
    if (token) headers.set('X-Sidecar-Token', token);
    if (init.body && typeof init.body === 'string' && !headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json');
    }
    init.headers = headers;
    return window.fetch(url, init);
  }

  function createUiFallback() {
    return {
      toggleAuxPane: function(request) {
        try {
          if (window.parent && window.parent !== window) {
            window.parent.postMessage({ type: 'toggle-aux-pane', payload: request || {} }, '*');
          }
        } catch (_) {}
      }
    };
  }

  if (!window.sidecar) {
    window.sidecar = {
      conversationId: conversationId,
      fetch: secureFetch,
      getWorkspaceUris: function() { return Promise.resolve(workspaceUris.slice()); },
      onWorkspaceChange: function(fn) {
        if (typeof fn !== 'function') return function() {};
        wsListeners.add(fn);
        return function() { wsListeners.delete(fn); };
      },
      ui: createUiFallback()
    };
  } else {
    var origFetch = window.sidecar.fetch ? window.sidecar.fetch.bind(window.sidecar) : window.fetch.bind(window);
    window.sidecar.__marketFetch = function(url, options) {
      var init = Object.assign({}, options || {});
      var headers = new Headers(init.headers || {});
      if (token) headers.set('X-Sidecar-Token', token);
      if (init.body && typeof init.body === 'string' && !headers.has('Content-Type')) {
        headers.set('Content-Type', 'application/json');
      }
      init.headers = headers;
      return origFetch(url, init);
    };
    if (!window.sidecar.ui) {
      window.sidecar.ui = createUiFallback();
    } else if (typeof window.sidecar.ui.toggleAuxPane !== 'function') {
      window.sidecar.ui.toggleAuxPane = createUiFallback().toggleAuxPane;
    }
  }
})();`;

function safeCompareTokens(candidate, expected) {
  if (!candidate || !expected) return false;
  const a = Buffer.from(String(candidate), 'utf8');
  const b = Buffer.from(String(expected), 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

function isAllowedOriginHeader(originHeader) {
  if (originHeader === undefined) return true; // Non-browser clients may omit Origin.
  const orig = String(originHeader).trim().toLowerCase();
  if (orig.startsWith('vscode-webview://')) return true;
  if (orig.startsWith('plugin://')) return true;
  try {
    const u = new URL(orig);
    return (
      (u.protocol === 'http:' || u.protocol === 'https:') &&
      (u.hostname === '127.0.0.1' || u.hostname === 'localhost')
    );
  } catch {
    return false;
  }
}

function injectBootIntoHtml(rawHtml, token, conversationId = '', { preloadToken = token } = {}) {
  const bootPayload = JSON.stringify({ token, conversationId }).replace(/</g, '\\u003c');
  const bootScript = `<script>window.__SIDECAR_BOOT__=${bootPayload};</script>`;
  const preloadTagRe = /<script\b[^>]*\bsrc=(["'])\/preload\.js\1[^>]*>/i;
  let html;
  if (preloadTagRe.test(rawHtml)) {
    html = rawHtml.replace(preloadTagRe, (match) => `${bootScript}\n  ${match}`);
  } else if (rawHtml.includes('</head>')) {
    html = rawHtml.replace('</head>', `${bootScript}\n</head>`);
  } else {
    html = `${bootScript}\n${rawHtml}`;
  }
  const effectivePreloadToken = typeof preloadToken === 'string' ? preloadToken.trim() : '';
  if (effectivePreloadToken) {
    html = html.replace(
      /src=(["'])\/preload\.js\1/g,
      `src=$1/preload.js?token=${encodeURIComponent(effectivePreloadToken)}$1`,
    );
  }
  return html;
}

function parseWorkspaceUrisInput(raw) {
  if (Array.isArray(raw)) {
    return raw.filter((v) => typeof v === 'string' && v.trim().length > 0);
  }
  if (typeof raw === 'string' && raw.trim()) {
    return raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return [];
}

function acceptsGzipEncoding(acceptEncodingHeader) {
  if (!acceptEncodingHeader || typeof acceptEncodingHeader !== 'string') return false;
  for (const part of acceptEncodingHeader.split(',')) {
    const [rawCoding, ...params] = part.trim().toLowerCase().split(';');
    if (rawCoding.trim() !== 'gzip') continue;
    let q = 1;
    for (const p of params) {
      const m = /^q\s*=\s*([0-9.]+)$/.exec(p.trim());
      if (m) q = Number(m[1]);
    }
    if (Number.isFinite(q) && q > 0) return true;
  }
  return false;
}

function updateListMembership(list, key, enabled, limit) {
  if (!enabled) return list.filter(item => item !== key);
  if (list.includes(key)) return list;
  return [...list.slice(1 - limit), key];
}

function sendRequestError(res, err) {
  if (err?.code === 'ERR_PREFS_BUSY') {
    sendJson(res, 409, { ok: false, errorCode: err.code, error: err.message });
    return;
  }
  if (err?.code === 'ERR_PLUGIN_OPERATION_BUSY') {
    sendJson(res, 409, { ok: false, errorCode: 'ERR_MUTATION_BUSY', error: err.message });
    return;
  }
  sendJson(res, err?.result?.status === 'LEGACY_DUPLICATE' ? 409 : 400, err?.result || { ok: false, error: err?.message || String(err) });
}

function sendJson(res, status, payload, onFlushed = null) {
  const bodyBuf = Buffer.from(JSON.stringify(payload), 'utf8');
  const acceptEncoding = res.req?.headers?.['accept-encoding'] || '';
  const baseHeaders = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  };

  if (bodyBuf.length > GZIP_MIN_BYTES && acceptsGzipEncoding(acceptEncoding)) {
    gzip(bodyBuf, (err, gzBuf) => {
      if (res.writableEnded || res.destroyed) return;
      if (!err && gzBuf) {
        res.writeHead(status, {
          ...baseHeaders,
          'Content-Encoding': 'gzip',
          Vary: 'Accept-Encoding',
          'Content-Length': String(gzBuf.length),
        });
        if (typeof onFlushed === 'function') res.end(gzBuf, onFlushed);
        else res.end(gzBuf);
        return;
      }
      res.writeHead(status, { ...baseHeaders, 'Content-Length': String(bodyBuf.length) });
      if (typeof onFlushed === 'function') res.end(bodyBuf, onFlushed);
      else res.end(bodyBuf);
    });
    return;
  }

  res.writeHead(status, { ...baseHeaders, 'Content-Length': String(bodyBuf.length) });
  if (typeof onFlushed === 'function') {
    res.end(bodyBuf, onFlushed);
  } else {
    res.end(bodyBuf);
  }
}

function readJsonBody(req, maxBytes = MAX_JSON_BODY) {
  return new Promise((resolvePromise, rejectPromise) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        rejectPromise(new Error('ERR_BODY_TOO_LARGE: JSON request exceeds 2 MB'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (total === 0) {
        resolvePromise({});
        return;
      }
      try {
        resolvePromise(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (err) {
        rejectPromise(new Error(`ERR_INVALID_JSON: ${err?.message || String(err)}`));
      }
    });
    req.on('error', rejectPromise);
  });
}

function isSelfPluginCandidate(plugin, installedDir = '') {
  return samePluginName(installedDir, PLUGIN_ID) || isOfficialMarketEntry(plugin);
}

function readFirstExistingReadme(pluginRootDir, candidates) {
  if (!pluginRootDir || !existsSync(pluginRootDir)) return '';
  for (const rel of candidates) {
    const full = join(pluginRootDir, rel);
    if (!existsSync(full)) continue;
    try {
      const content = readFileSync(full, 'utf8').slice(0, MAX_LOCAL_README_CHARS);
      if (content.trim()) return content;
    } catch {
      /* try next */
    }
  }
  return '';
}

function isUnmanagedLocalPlugin(loc) {
  return Boolean(loc && (loc.isGitManaged || (!loc.receipt && loc.hasDeclaredVersion === false)));
}

function buildUnmanagedUpdateErrorMessage(loc) {
  const dir = loc?.dir || '';
  if (loc?.isGitManaged) {
    return `ERR_UNMANAGED_GIT_OR_UNVERSIONED: 插件 "${dir}" 为原生 .git 克隆安装（非 AGY Market 托管），已禁止自动更新以免覆盖本地 Git 仓库，请直接使用 git pull 更新。(Plugin "${dir}" is managed via native .git clone outside AGY Market; use git pull instead.)`;
  }
  return `ERR_UNMANAGED_GIT_OR_UNVERSIONED: 插件 "${dir}" 未声明 plugin.json version 且无安装收据，无法安全自动更新。(Plugin "${dir}" lacks a declared version in plugin.json and cannot be auto-updated.)`;
}

export async function createMarketSidecarServer(options = {}) {
  const configDir = resolveAntigravityConfigDir(options.configDir || '');
  const pluginsDir = resolvePluginsDir(configDir);
  const dataDir = resolveMarketDataDir(options.dataDir || '');
  const builtinPluginsDir = options.builtinPluginsDir || '';
  const indexHtmlPath = options.indexHtmlPath || DEFAULT_INDEX_HTML_PATH;
  const fetchImpl = options.fetchImpl || defaultProxyFetch;
  const mirrors = options.mirrors || undefined;
  const nowFn = typeof options.nowFn === 'function' ? options.nowFn : () => Date.now();
  const currentSelfVersion = options.currentSelfVersion || PLUGIN_VERSION;
  const githubApiBaseUrl = options.githubApiBaseUrl || undefined;
  const updateCheckTtlMs = options.updateCheckTtlMs ?? undefined;
  const renameOverride = options.renameOverride || null;
  const rmOverride = options.rmOverride || null;
  const unlinkOverride = options.unlinkOverride || null;
  const linkInfoOverride = options.linkInfoOverride || null;
  const unlinkLinkOverride = options.unlinkLinkOverride || null;
  const openPaneOptions = options.openPaneOptions || null;
  const openPaneImpl =
    typeof options.openPaneImpl === 'function' ? options.openPaneImpl : openSiblingSidecarPane;
  let restartScheduled = false;
  const onSelfRestart =
    typeof options.onSelfRestart === 'function'
      ? options.onSelfRestart
      : () => {
          if (restartScheduled) return;
          restartScheduled = true;
          const exitWhenIdle = () => {
            if (canRestartForDiskUpdate()) process.exit(1);
            else setTimeout(exitWhenIdle, 150).unref?.();
          };
          setTimeout(exitWhenIdle, 150).unref?.();
        };

  mkdirSync(dataDir, { recursive: true });

  // 256-bit random Sidecar CSRF token + optional host-provided Sidecar token
  const generatedSideToken = options.sideToken || randomBytes(32).toString('hex');
  const hostEnvToken = String(
    process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN ||
      process.env.ANTIGRAVITY_SIDECAR_AUTH_TOKEN ||
      process.env.ANTIGRAVITY_SIDECAR_WEB_TOKEN ||
      '',
  ).trim();
  const validTokens = [generatedSideToken, hostEnvToken].filter(Boolean);

  const envPort = parseInt(
    process.env.ANTIGRAVITY_SIDECAR_WEB_PORT ||
      process.env.ANTIGRAVITY_SIDECAR_PORT ||
      process.env.PORT ||
      '',
    10,
  );
  const listenPort = options.port !== undefined ? Number(options.port) : Number.isFinite(envPort) ? envPort : 0;

  // Sweep retired Windows binaries & expired GitHub URL inspect staging immediately on boot
  trySweepRetiredBinaries(dataDir, { pluginsDir });
  sweepExpiredInspectStaging(dataDir, nowFn());

  // Schedule 8s boot crash-recovery check for `pending-journal.json`
  const recoveryDelayMs = options.recoveryDelayMs ?? 8000;
  let recoveryTimer = null;
  function scheduleRecovery(delay) {
    recoveryTimer = setTimeout(() => {
      const result = recoverInterruptedJournal({ dataDir, pluginsDir });
      if (result.action === 'busy') scheduleRecovery(Math.max(delay, 1000));
      if (result.action === 'target-changed') console.warn('[recovery]', result.error, result.journalPath);
    }, delay);
    recoveryTimer.unref?.();
  }
  if (recoveryDelayMs >= 0) scheduleRecovery(recoveryDelayMs);

  let prefs = loadPrefsFromDisk(dataDir);
  let authenticatedDiscussions = new Map();
  let lastCatalog = null;
  let lastCatalogPrefsKey = '';
  let catalogFlight = null;
  let catalogConfigQueue = Promise.resolve();
  let updateCheckGeneration = 0;
  const inFlightUpdates = new Map(); // flightKey -> { key, force, generation, promise }
  let pendingMutationResponses = 0;
  let activeMutation = null; // { route, startedAt }

  function canRestartForDiskUpdate() {
    return !activeMutation && pendingMutationResponses === 0;
  }

  function enqueueCatalogConfigOp(taskFn) {
    const next = catalogConfigQueue.then(taskFn, taskFn);
    catalogConfigQueue = next.catch(() => {});
    return next;
  }

  function getCatalogPrefsKey(p = prefs) {
    return JSON.stringify([p.enableExperimentalTrack2, p.networkMode, p.primaryCatalogUrl, p.customFeeds]);
  }

  function usePrefs(next) {
    const catalogChanged = getCatalogPrefsKey(next) !== getCatalogPrefsKey(prefs);
    const tokenChanged = next.githubToken !== prefs.githubToken;
    if (catalogChanged) catalogFlight = null;
    if (tokenChanged) authenticatedDiscussions = new Map();
    if (catalogChanged || tokenChanged) invalidateUpdateCheckState();
    prefs = next;
  }

  function hasUsableTrack2Data() {
    if (lastCatalogPrefsKey === getCatalogPrefsKey() && lastCatalog?.plugins?.some(p => p?._track === 'unverified')) {
      return true;
    }
    return hasCachedTrack2(dataDir, prefs.primaryCatalogUrl);
  }

  function invalidateUpdateCheckState() {
    updateCheckGeneration += 1;
    inFlightUpdates.clear();
    invalidateLocalInventoryCache();
  }

  async function ensureCatalogLoaded({ forceCatalogRefresh = false, panelOpen = false } = {}) {
    const prefsKey = getCatalogPrefsKey(prefs);
    if (catalogFlight?.prefsKey === prefsKey && (!forceCatalogRefresh || catalogFlight.forceCatalogRefresh)) {
      return catalogFlight.promise;
    }
    if (!forceCatalogRefresh && !panelOpen && lastCatalog && lastCatalogPrefsKey === prefsKey) return lastCatalog;

    if (panelOpen) invalidateUpdateCheckState();
    const flight = { prefsKey, forceCatalogRefresh };
    catalogFlight = flight;
    flight.promise = resolveMarketCatalog({
      dataDir,
      prefs: sanitizePrefs(prefs),
      forceRefresh: forceCatalogRefresh,
      includeReadmes: false,
      shouldPersistCache: () => catalogFlight === flight,
      fetchImpl,
      mirrors,
    }).then(loaded => {
      // A manual refresh or source switch can finish before this request.
      if (catalogFlight !== flight) return ensureCatalogLoaded();
      lastCatalog = loaded;
      lastCatalogPrefsKey = prefsKey;
      return loaded;
    }).finally(() => {
      if (catalogFlight === flight) catalogFlight = null;
    });
    return flight.promise;
  }

  function findCatalogEntryForDir(dirName) {
    const plugins = lastCatalog?.plugins || [];
    return (
      plugins.find(
        (p) => (!p.forceScopedInstall && p.canonicalName === dirName) || p.scopedName === dirName || p.id === dirName,
      ) || null
    );
  }

  function findCatalogCapabilitiesForDir(dirName) {
    return findCatalogEntryForDir(dirName)?.capabilities || null;
  }

  function getValidGithubRepoUrl(rawUrl) {
    const norm = normalizeRepoUrl(rawUrl);
    return /^https:\/\/github\.com\/[^/]+\/[^/]+$/i.test(norm) ? norm : '';
  }

  function resolveCatalogPluginForMutation(catalogPlugins, { targetId = '', targetDir = '' } = {}) {
    const list = Array.isArray(catalogPlugins) ? catalogPlugins : [];
    if (targetId) {
      const serverMatch = list.find(p => p.id === targetId);
      if (targetId === SELF_CATALOG_ID) return isOfficialMarketEntry(serverMatch) ? serverMatch : null;
      return serverMatch || null;
    }
    return list.find(p => targetDir && ((!p.forceScopedInstall && p.canonicalName === targetDir) || p.scopedName === targetDir)) || null;
  }

  function matchesDisplayedCatalogEntry(displayed, current) {
    if (displayed.id !== current?.id || !current) return false;
    if (displayed._track && displayed._track !== current._track) return false;
    if (displayed._feedUrl && displayed._feedUrl !== current._feedUrl) return false;
    const repo = displayed.repository;
    if (!repo) return true;
    const selected = current.repository || {};
    return normalizeRepoUrl(repo.url) === normalizeRepoUrl(selected.url) &&
      normalizePluginRoot(repo.pluginRoot) === normalizePluginRoot(selected.pluginRoot) &&
      (!repo.repositoryId || !selected.repositoryId || String(repo.repositoryId) === String(selected.repositoryId));
  }

function applyIgnoredConflictsFilter(report, ignoredIds = []) {
  const base = report && typeof report === 'object' ? report : {};
  const rawItems = Array.isArray(base.items) ? base.items : [];
  const ignoredSet = new Set(sanitizeIgnoredConflictIds(ignoredIds));
  const items = rawItems.map((item) => ({
    ...item,
    ignored: Boolean(item?.id && ignoredSet.has(item.id)),
  }));

  let total = 0;
  let critical = 0;
  let warning = 0;
  let info = 0;
  let ignoredCount = 0;

  for (const item of items) {
    if (item.ignored) {
      ignoredCount += 1;
      continue;
    }
    total += 1;
    if (item.severity === 'critical') critical += 1;
    else if (item.severity === 'warning') warning += 1;
    else if (item.severity === 'info') info += 1;
  }

  return {
    ...base,
    summary: {
      total,
      critical,
      warning,
      info,
      ignoredCount,
      healthyCount: Number(base.summary?.healthyCount || 0),
    },
    items,
  };
}

  function favoriteSourceForLocal(loc) {
    return makeFavoriteSource(loc.displayName || loc.dir,
      loc.inferredRepository ? '' : parseGithubRepoSlug(loc.receipt?.repositoryUrl || loc.repositoryUrl)?.url,
      loc.receipt?.pluginRoot || loc.repositoryRoot, loc.receipt?.githubSource?.trackBranch);
  }

  function favoriteSourceForCatalog(plugin) {
    const repository = normalizeRepoUrl(plugin.repository?.url);
    const source = makeFavoriteSource(plugin.displayName || plugin.canonicalName, repository,
      normalizePluginRoot(plugin.repository?.pluginRoot), plugin.githubSource?.trackBranch);
    if (!source.repositoryUrl) source.catalogOrigin = createHash('sha256')
      .update(repository || plugin._feedUrl || prefs.primaryCatalogUrl || 'official').digest('hex');
    return source;
  }

  function favoriteMigration(currentPrefs, installed, catalogPlugins) {
    const sources = { ...currentPrefs.favoriteSources };
    const catalogById = new Map(catalogPlugins.map(entry => [entry.id, entry]));
    let changed = false;
    const favorites = currentPrefs.favorites.map(key => {
      if (!key.startsWith('local:')) {
        const prior = currentPrefs.favoriteSources[key];
        const id = prior?.catalogId || key;
        const entry = catalogById.get(id);
        if (!entry) return key;
        const current = favoriteSourceForCatalog(entry);
        if (!prior?.repositoryUrl && !prior?.catalogOrigin) {
          if (!prior) {
            sources[key] = current;
            changed = true;
          }
          return key;
        }
        // Free the shared catalog id for the current source while retaining
        // the original bookmark. Restore its id if its source comes back.
        const matches = prior.repositoryUrl.toLowerCase() === current.repositoryUrl.toLowerCase() &&
          prior.catalogOrigin === current.catalogOrigin &&
          (!prior.pluginRoot || prior.pluginRoot === current.pluginRoot);
        const target = matches ? id : 'saved:' + createHash('sha256')
          .update(JSON.stringify([id, prior.repositoryUrl || prior.catalogOrigin, prior.pluginRoot])).digest('hex');
        if (target !== key) {
          sources[target] = { ...prior, catalogId: id };
          changed = true;
        }
        return target;
      }
      const loc = matchLegacyLocalFavorite(key, installed, sources[key]);
      if (!loc) {
        const dir = key.slice(6);
        if (installed.filter(item => item.dir === dir).length <= 1) return key;
        // Older keys cannot distinguish these copies. Keep the bookmark without
        // attaching it to a different copy if a workspace closes later.
        const saved = 'saved:' + dir;
        sources[saved] = sources[key] || makeFavoriteSource(dir);
        delete sources[key];
        changed = true;
        return saved;
      }
      changed = true;
      sources[loc.favoriteKey] = sources[key] || favoriteSourceForLocal(loc);
      delete sources[key];
      return loc.favoriteKey;
    });
    return changed ? { favorites, favoriteSources: sources } : null;
  }

  async function buildEnrichedState({ forceCatalogRefresh = false, panelOpen = false, workspaceUris = [] } = {}) {
    usePrefs(loadPrefsFromDisk(dataDir));
    const loadedCatalog = await ensureCatalogLoaded({ forceCatalogRefresh, panelOpen });
    const activeCatalog =
      lastCatalog && lastCatalogPrefsKey === getCatalogPrefsKey(prefs) ? lastCatalog : loadedCatalog;

    const catalogPlugins = activeCatalog.plugins || [];
    const inventory = scanLocalPluginInventory({
      configDir,
      dataDir,
      workspaceUris,
      builtinPluginsDir,
      linkInfoOverride,
      catalogPlugins,
    });
    if (favoriteMigration(prefs, inventory.installed, catalogPlugins)) {
      usePrefs(updatePrefsOnDisk(dataDir, current => getCatalogPrefsKey(current) === lastCatalogPrefsKey
        ? favoriteMigration(current, inventory.installed, catalogPlugins) : null));
    }
    const updatesAvailable = [];

    // Enrich installed items with merged catalog capabilities & activation classification
    const enrichedInstalled = inventory.installed.map((loc) => {
      const successor = findManagedSuccessor(loc, inventory.installed);
      if (successor) return { ...loc, catalogId: null, successorDir: successor.dir };
      const catMatch = loc.scope === 'global' ? findCatalogEntryForLocal(loc, catalogPlugins, inventory.installed) : null;
      const catalogId = catMatch?.id || null;
      if (!catMatch?.capabilities) return { ...loc, catalogId };
      const mergedCaps = mergeCapabilityProfiles(loc.capabilities, catMatch.capabilities);
      return {
        ...loc,
        catalogId,
        capabilities: mergedCaps,
        hostEnhancementKind: mergedCaps.hostEnhancementKind,
        activation: classifyActivationRequirement(mergedCaps),
      };
    });

    const enrichedInventory = { ...inventory, installed: enrichedInstalled };
    const conflictsReport = applyIgnoredConflictsFilter(
      scanLocalConflicts({
        inventory: enrichedInventory,
        configDir,
        dataDir,
        workspaceUris,
        catalogPlugins,
      }),
      prefs.ignoredConflictIds,
    );

    const enrichedCatalogPlugins = catalogPlugins.map((p) => {
      const preflight = resolveInstallPreflight(p, enrichedInventory, { conflictStrategy: 'prompt' });
      const localMatch = preflight.action === 'update' ? preflight.existingInstall : null;
      const isLocalUnmanaged = isUnmanagedLocalPlugin(localMatch);
      const hasUpdate = Boolean(
        localMatch &&
          !isLocalUnmanaged &&
          isCatalogPluginInstallable(p) &&
          !isSameInstalledRelease(localMatch.receipt, { gitTag: p.gitTag, commitSha: p.commitSha }) &&
          isNewerVersion(p.version, localMatch.version),
      );
      const escalation = localMatch ? computeCapabilityEscalation(localMatch.receipt, p, localMatch.capabilities) : null;
      const catalogActivation = classifyActivationRequirement(p.capabilities || {});

      if (hasUpdate && localMatch) {
        updatesAvailable.push({
          id: p.id,
          installedDir: localMatch.dir,
          displayName: p.displayName,
          installedVersion: localMatch.version,
          latestVersion: p.version,
          escalation,
        });
      }

      return {
        ...p,
        activation: localMatch?.activation || catalogActivation,
        installStatus: localMatch
          ? {
              installed: true,
              installedDir: localMatch.dir,
              installedVersion: localMatch.version,
              enabled: localMatch.enabled,
              parkedByMarket: Boolean(localMatch.parkedByMarket),
              hostDisabled: Boolean(localMatch.hostDisabled),
              canToggle: Boolean(localMatch.canToggle),
              toggleDisabledReason: localMatch.toggleDisabledReason || '',
              canUninstall: Boolean(localMatch.canUninstall),
              uninstallDisabledReason: localMatch.uninstallDisabledReason || '',
              scope: localMatch.scope || null,
              hasUpdate,
              customizationUri: localMatch.customizationUri || null,
              sidecarPane: localMatch.sidecarPane || null,
              conflictDetected: preflight.action === 'conflict-prompt',
              escalation,
            }
          : {
              installed: false,
              hasUpdate: false,
              ...(preflight.conflict ? { conflictDetected: true } : {}),
            },
      };
    });

    return {
      ok: true,
      plugin: {
        id: PLUGIN_ID,
        displayName: PLUGIN_DISPLAY_NAME,
        version: currentSelfVersion,
        sidecarUri: SIDECAR_URI,
        customizationUri: CUSTOMIZATION_URI,
      },
      prefs: toPublicPrefs(prefs),
      catalog: {
        channelUsed: activeCatalog.channelUsed,
        catalogVersion: activeCatalog.catalogVersion,
        generatedAt: activeCatalog.generatedAt,
        warnings: activeCatalog.warnings,
        failedCustomFeeds: activeCatalog.failedCustomFeeds || [],
        plugins: enrichedCatalogPlugins,
      },
      installed: enrichedInstalled,
      updatesAvailable,
      conflictsSummary: conflictsReport.summary,
      paths: {
        configDir,
        pluginsDir,
        dataDir,
      },
    };
  }

  function verifyMutatingRequestAuth(req) {
    if (!isAllowedOriginHeader(req.headers.origin)) {
      return { ok: false, status: 403, error: 'ERR_CSRF_ORIGIN: Disallowed Origin header' };
    }
    const reqTok = typeof req.headers['x-sidecar-token'] === 'string' ? req.headers['x-sidecar-token'].trim() : '';
    const matched = validTokens.some((expected) => safeCompareTokens(reqTok, expected));
    if (!matched) {
      return { ok: false, status: 403, error: 'ERR_CSRF_TOKEN: Missing or invalid X-Sidecar-Token header' };
    }
    return { ok: true };
  }

  async function handleRequest(req, res) {
    if (!res.req) res.req = req;
    let acquiredMutationLock = false;
    const acquireMutationLock = (route) => {
      if (activeMutation || restartScheduled) {
        sendJson(res, 409, {
          ok: false,
          errorCode: 'ERR_MUTATION_BUSY',
          error: 'ERR_MUTATION_BUSY: Another plugin install/update operation is currently in progress.',
        });
        return false;
      }
      activeMutation = { route, startedAt: nowFn() };
      acquiredMutationLock = true;
      if (typeof res.once === 'function') {
        pendingMutationResponses++;
        const finished = () => {
          res.off('finish', finished);
          res.off('close', finished);
          pendingMutationResponses--;
        };
        res.once('finish', finished);
        res.once('close', finished);
      }
      invalidateUpdateCheckState();
      return true;
    };

    try {
      return await dispatchRequest(req, res, acquireMutationLock);
    } finally {
      if (acquiredMutationLock) {
        activeMutation = null;
        invalidateUpdateCheckState();
      }
    }
  }

  async function dispatchRequest(req, res, acquireMutationLock) {
    if (!/^(?:127\.0\.0\.1|localhost)(?::\d{1,5})?$/i.test(req.headers.host || '')) {
      sendJson(res, 403, { ok: false, error: 'ERR_INVALID_HOST: Expected a loopback host' });
      return;
    }
    const urlObj = new URL(req.url || '/', 'http://127.0.0.1');
    const pathname = urlObj.pathname;
    if (pathname.startsWith('/api/')) usePrefs(loadPrefsFromDisk(dataDir));
    const selectedScope = urlObj.searchParams.get('scope');
    const wantsScopedDetail = (pathname === '/api/readme' || pathname === '/api/discussions') &&
      (selectedScope === 'workspace' || selectedScope === 'builtin' ||
       (selectedScope === 'global' && urlObj.searchParams.has('localPath')));
    const selectedLocal = wantsScopedDetail && scanLocalPluginInventory({
      configDir, dataDir, workspaceUris: urlObj.searchParams.getAll('workspace'), builtinPluginsDir, linkInfoOverride,
    }).installed.find(loc => loc.scope === selectedScope && loc.dir === urlObj.searchParams.get('dir') &&
      loc.path === urlObj.searchParams.get('localPath'));
    if (wantsScopedDetail && !selectedLocal) {
      sendJson(res, 404, { ok: false, error: 'ERR_PLUGIN_NOT_FOUND: Refresh the plugin list' });
      return;
    }

    if (req.method === 'GET' && pathname === '/healthz') {
      sendJson(res, 200, { ok: true, plugin: PLUGIN_ID, version: currentSelfVersion });
      return;
    }

    if (req.method === 'GET' && pathname === '/preload.js') {
      res.writeHead(200, {
        'Content-Type': 'text/javascript; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end(PRELOAD_SHIM_JS);
      return;
    }

    if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
      const rawHtml = existsSync(indexHtmlPath)
        ? readFileSync(indexHtmlPath, 'utf8')
        : '<!doctype html><html><body><div id="app">Run node scripts/build.mjs to build AGY Market UI.</div></body></html>';
      const convId = urlObj.searchParams.get('conversationId') || '';
      const reqQueryToken = String(urlObj.searchParams.get('token') || '').trim();
      const reqHeaderToken =
        typeof req.headers['x-sidecar-token'] === 'string' ? req.headers['x-sidecar-token'].trim() : '';
      const verifiedReqToken =
        [reqQueryToken, reqHeaderToken].find(
          (tk) => tk && validTokens.some((expected) => safeCompareTokens(tk, expected)),
        ) || '';
      const hostToken = hostEnvToken || verifiedReqToken || '';
      const bootToken = hostToken || generatedSideToken;
      const preloadToken = hostToken || (!hostEnvToken ? generatedSideToken : '');
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end(injectBootIntoHtml(rawHtml, bootToken, convId, { preloadToken }));
      return;
    }

    if (req.method === 'GET' && pathname === '/api/state') {
      const refresh = urlObj.searchParams.get('refresh') === '1';
      const wsParam = urlObj.searchParams.get('workspaceUris') || '';
      const workspaceUris = wsParam ? wsParam.split(',').filter(Boolean) : [];
      if (refresh) invalidateLocalInventoryCache();
      const panelOpen = urlObj.searchParams.get('panelOpen') === '1';
      const state = await buildEnrichedState({ forceCatalogRefresh: refresh, panelOpen, workspaceUris });
      sendJson(res, 200, state);
      return;
    }

    if (req.method === 'GET' && pathname === '/api/conflicts') {
      const wsParam = urlObj.searchParams.get('workspaceUris') || '';
      const workspaceUris = wsParam ? wsParam.split(',').filter(Boolean) : [];
      await ensureCatalogLoaded().catch(() => null);
      const inventory = scanLocalPluginInventory({ configDir, dataDir, workspaceUris, builtinPluginsDir, linkInfoOverride, catalogPlugins: lastCatalog?.plugins || [] });
      const report = applyIgnoredConflictsFilter(
        scanLocalConflicts({
          inventory,
          configDir,
          dataDir,
          workspaceUris,
          catalogPlugins: lastCatalog?.plugins || [],
        }),
        prefs.ignoredConflictIds,
      );
      sendJson(res, 200, report);
      return;
    }

    if (req.method === 'GET' && pathname === '/api/updates') {
      const force = urlObj.searchParams.get('force') === '1' || urlObj.searchParams.get('force') === 'true';
      const wsParam = urlObj.searchParams.get('workspaceUris') || '';
      const workspaceUris = wsParam ? wsParam.split(',').filter(Boolean) : [];
      const flightKey = `${force ? '1' : '0'}|${workspaceUris.join(',')}`;
      const existingFlight = inFlightUpdates.get(flightKey);

      if (
        existingFlight &&
        existingFlight.key === flightKey &&
        existingFlight.force === force &&
        existingFlight.generation === updateCheckGeneration
      ) {
        const sharedReport = await existingFlight.promise;
        sendJson(res, 200, sharedReport);
        return;
      }

      const generation = updateCheckGeneration;
      const runCheck = async () => {
        const loadedCat = await ensureCatalogLoaded({ forceCatalogRefresh: force });
        const catalog = lastCatalog && lastCatalogPrefsKey === getCatalogPrefsKey(prefs) ? lastCatalog : loadedCat;
        const inventory = scanLocalPluginInventory({ configDir, dataDir, workspaceUris, builtinPluginsDir, linkInfoOverride,
          catalogPlugins: catalog.plugins });
        return checkPluginUpdates({
          catalog,
          inventory,
          dataDir,
          prefs,
          force,
          fetchImpl,
          nowMs: nowFn(),
          ...(updateCheckTtlMs !== undefined ? { ttlMs: updateCheckTtlMs } : {}),
          currentSelfVersion,
          githubApiBaseUrl,
          shouldPersistCache: () => generation === updateCheckGeneration,
        });
      };

      const promise = runCheck();
      inFlightUpdates.set(flightKey, { key: flightKey, force, generation, promise });
      try {
        const report = await promise;
        sendJson(res, 200, report);
      } finally {
        if (inFlightUpdates.get(flightKey)?.promise === promise) {
          inFlightUpdates.delete(flightKey);
        }
      }
      return;
    }

    if (req.method === 'GET' && pathname === '/api/discussions') {
      const requestPrefs = prefs;
      const requestCache = authenticatedDiscussions;
      const pluginId = String(urlObj.searchParams.get('id') || '').trim();
      if (!pluginId) {
        sendJson(res, 400, {
          ok: false,
          error: 'Missing query parameter: id',
          url: '',
          newDiscussionUrl: '',
          items: [],
          disabled: true,
          needsToken: false,
          rateLimited: false,
        });
        return;
      }
      const force = urlObj.searchParams.get('force') === '1' || urlObj.searchParams.get('force') === 'true';
      const wsParam = urlObj.searchParams.get('workspaceUris') || '';
      const workspaceUris = wsParam ? wsParam.split(',').filter(Boolean) : [];
      if (!selectedLocal) await ensureCatalogLoaded().catch(() => null);
      const inventory = selectedLocal ? { installed: [selectedLocal] } : scanLocalPluginInventory({ configDir, dataDir, workspaceUris, linkInfoOverride });
      const disc = await fetchPluginDiscussions({
        id: pluginId,
        catalog: (!selectedLocal && lastCatalog) || { plugins: [] },
        inventory,
        dataDir,
        prefs: requestPrefs,
        authenticatedCache: requestCache,
        force,
        fetchImpl,
        nowMs: nowFn(),
        githubApiBaseUrl,
      });
      usePrefs(loadPrefsFromDisk(dataDir));
      if (requestCache !== authenticatedDiscussions || requestPrefs.githubToken !== prefs.githubToken) {
        sendJson(res, 200, { ok: false, error: 'GitHub credentials changed. Refresh discussions.', items: [] });
        return;
      }
      if (!disc.ok) {
        sendJson(res, disc.statusCode || 404, {
          ok: false,
          error: disc.error,
          id: disc.id,
          url: '',
          newDiscussionUrl: '',
          items: [],
          disabled: true,
          needsToken: false,
          rateLimited: false,
        });
        return;
      }
      sendJson(res, 200, disc);
      return;
    }

    const pluginReadmeMatch =
      req.method === 'GET' ? /^\/api\/plugin\/([^/]+)\/readme$/.exec(pathname) : null;

    if (req.method === 'GET' && (pathname === '/api/readme' || pluginReadmeMatch)) {
      let pluginId = '';
      if (pluginReadmeMatch) {
        try {
          pluginId = decodeURIComponent(pluginReadmeMatch[1]).trim();
        } catch {
          sendJson(res, 400, { ok: false, error: 'Malformed plugin id in URL path' });
          return;
        }
      } else {
        pluginId = String(urlObj.searchParams.get('id') || '').trim();
      }
      const requestedDir = String(urlObj.searchParams.get('dir') || '').trim();
      const forceReadmeRefresh =
        urlObj.searchParams.get('refresh') === '1' || urlObj.searchParams.get('force') === '1';
      const rawLocale = String(urlObj.searchParams.get('locale') || prefs.locale || 'zh')
        .trim()
        .toLowerCase();
      const locale = rawLocale.startsWith('en') ? 'en' : 'zh';

      if (!pluginId && !requestedDir) {
        sendJson(res, 400, { ok: false, error: 'Missing query parameter: id or dir' });
        return;
      }

      // Lazy per-plugin README fetch (`dist/readmes/<id>.json` w/ per-plugin ETag cache),
      // seamlessly falling back to monolithic `readmes.json`, npm mirror, or offline cache.
      let fetchedReadme = null;
      const activeCatalog = pluginId && !selectedLocal ? await ensureCatalogLoaded() : null;
      const entry = activeCatalog?.plugins.find(p => p.id === pluginId);
      const customFeed = entry?._track === 'custom' ? entry._feedUrl : '';
      // In-memory README maps belong to the primary feed. Additional feeds have their own disk caches.
      const matchingCatalog = customFeed ? null : activeCatalog;
      if (pluginId && !selectedLocal) {
        try {
          fetchedReadme = await fetchPluginReadme({
            id: pluginId,
            dataDir,
            prefs,
            primaryBaseUrl: customFeed ? new URL('.', customFeed).href : matchingCatalog?.primaryBaseUrl || '',
            cachedCatalog: matchingCatalog,
            forceRefresh: forceReadmeRefresh,
            fetchImpl,
            mirrors,
          });
          if (matchingCatalog && matchingCatalog === lastCatalog && lastCatalogPrefsKey === getCatalogPrefsKey() && fetchedReadme?.monolithicReadmes) {
            const mono = fetchedReadme.monolithicReadmes;
            for (const [key, value] of [['readmes', mono.entries], ['readmesZh', mono.entriesZh], ['readmesEn', mono.entriesEn]]) {
              if (value && typeof value === 'object') matchingCatalog[key] = value;
            }
          }
        } catch {
          fetchedReadme = { channel: 'unavailable' };
        }
      }

      let local = selectedLocal;
      if (!local && (entry || !pluginId)) {
        const { installed } = scanLocalPluginInventory({ configDir, dataDir, catalogPlugins: activeCatalog?.plugins });
        const candidates = entry ? installed.filter(loc => matchesInstalledSource(loc, entry, installed)) : installed;
        local = candidates.find(loc => samePluginName(loc.dir, requestedDir)) || (entry && candidates[0]);
      }
      const localPluginPath = local?.path || '';
      const resolvedDir = local?.dir || '';

      const catZh = pluginId ? String(fetchedReadme?.zh || matchingCatalog?.readmesZh?.[pluginId] || '') : '';
      const catEn = pluginId ? String(fetchedReadme?.en || matchingCatalog?.readmesEn?.[pluginId] || '') : '';
      const catDefault = pluginId ? String(fetchedReadme?.default || matchingCatalog?.readmes?.[pluginId] || '') : '';

      const localZh = localPluginPath ? readFirstExistingReadme(localPluginPath, ZH_README_FILENAMES) : '';
      const localEn = localPluginPath ? readFirstExistingReadme(localPluginPath, EN_README_FILENAMES) : '';
      const localDefault = localPluginPath ? readFirstExistingReadme(localPluginPath, DEFAULT_README_FILENAMES) : '';

      let markdown = '';
      let isTranslatedOrNativeZh = false;
      let readmeSource = 'none';
      const catalogSourceLabel = fetchedReadme?.channel ? `catalog:${fetchedReadme.channel}` : 'catalog:cached';

      if (locale === 'zh') {
        if (catZh.trim()) {
          markdown = catZh;
          isTranslatedOrNativeZh = true;
          readmeSource = catalogSourceLabel;
        } else if (localZh.trim()) {
          markdown = localZh;
          isTranslatedOrNativeZh = true;
          readmeSource = 'local';
        } else if (catDefault.trim() && CJK_CHAR_RE.test(catDefault)) {
          markdown = catDefault;
          isTranslatedOrNativeZh = true;
          readmeSource = catalogSourceLabel;
        } else if (localDefault.trim() && CJK_CHAR_RE.test(localDefault)) {
          markdown = localDefault;
          isTranslatedOrNativeZh = true;
          readmeSource = 'local';
        } else if (catDefault.trim()) {
          markdown = catDefault;
          isTranslatedOrNativeZh = false;
          readmeSource = catalogSourceLabel;
        } else if (catEn.trim()) {
          markdown = catEn;
          isTranslatedOrNativeZh = false;
          readmeSource = catalogSourceLabel;
        } else if (localDefault.trim()) {
          markdown = localDefault;
          isTranslatedOrNativeZh = CJK_CHAR_RE.test(localDefault);
          readmeSource = 'local';
        } else if (localEn.trim()) {
          markdown = localEn;
          isTranslatedOrNativeZh = false;
          readmeSource = 'local';
        }
      } else {
        if (catEn.trim()) {
          markdown = catEn;
          isTranslatedOrNativeZh = CJK_CHAR_RE.test(catEn);
          readmeSource = catalogSourceLabel;
        } else if (localEn.trim()) {
          markdown = localEn;
          isTranslatedOrNativeZh = CJK_CHAR_RE.test(localEn);
          readmeSource = 'local';
        } else if (catDefault.trim()) {
          markdown = catDefault;
          isTranslatedOrNativeZh = CJK_CHAR_RE.test(catDefault);
          readmeSource = catalogSourceLabel;
        } else if (localDefault.trim()) {
          markdown = localDefault;
          isTranslatedOrNativeZh = CJK_CHAR_RE.test(localDefault);
          readmeSource = 'local';
        } else if (catZh.trim()) {
          markdown = catZh;
          isTranslatedOrNativeZh = true;
          readmeSource = catalogSourceLabel;
        } else if (localZh.trim()) {
          markdown = localZh;
          isTranslatedOrNativeZh = true;
          readmeSource = 'local';
        }
      }

      sendJson(res, 200, {
        ok: true,
        ...(readmeSource === 'none' && fetchedReadme?.channel === 'unavailable' ? { unavailable: true } : {}),
        id: pluginId || resolvedDir || requestedDir,
        dir: resolvedDir || requestedDir,
        locale,
        isTranslatedOrNativeZh,
        markdown,
        source: readmeSource,
      });
      return;
    }

    // All POST / DELETE routes strictly require X-Sidecar-Token + loopback Origin check
    if (req.method === 'POST' || req.method === 'DELETE') {
      const auth = verifyMutatingRequestAuth(req);
      if (!auth.ok) {
        sendJson(res, auth.status, { ok: false, error: auth.error });
        return;
      }

      const body = await readJsonBody(req);

      if (pathname === '/api/catalog/refresh') {
        const state = await enqueueCatalogConfigOp(async () => {
          invalidateUpdateCheckState();
          return buildEnrichedState({
            forceCatalogRefresh: true,
            workspaceUris: Array.isArray(body.workspaceUris) ? body.workspaceUris : [],
          });
        });
        sendJson(res, 200, state);
        return;
      }

      if (pathname === '/api/prefs' || pathname === '/api/sources') {
        if (pathname === '/api/sources') {
          for (const field of ['primaryCatalogUrl', 'githubReleaseMirrorPrefix']) {
            const value = body[field];
            if (!value) continue;
            if (typeof value !== 'string' || !/^https?:\/\//i.test(value.trim()) || !URL.canParse(value)) {
              const label = field === 'primaryCatalogUrl' ? '主目录源 / Primary catalog' : '下载加速前缀 / Download mirror';
              sendJson(res, 400, { ok: false, error: `${label} 需要完整地址 / Enter an http:// or https:// URL.` });
              return;
            }
          }
        }
        if (Object.hasOwn(body, 'customFeeds')) {
          const feeds = body.customFeeds;
          const invalid = !Array.isArray(feeds) ? 0 : feeds.findIndex(value => {
            if (typeof value !== 'string' || !/^(?:https?|file):\/\//i.test(value.trim())) return true;
            return !URL.canParse(value);
          });
          if (invalid !== -1) {
            sendJson(res, 400, { ok: false, error: `自定义源第 ${invalid + 1} 项需要完整 URL / Feed ${invalid + 1} requires an http://, https:// or file:// URL.` });
            return;
          }
        }
        const state = await enqueueCatalogConfigOp(async () => {
          const prevPrefs = prefs;
          usePrefs(updatePrefsOnDisk(dataDir, () => body.clearGithubToken === true ? { ...body, githubToken: '' } : body));
          const track2SwitchedOn = !prevPrefs.enableExperimentalTrack2 && Boolean(prefs.enableExperimentalTrack2);
          const needsForceCatalog = track2SwitchedOn && !hasUsableTrack2Data();
          if (pathname === '/api/sources') {
            catalogFlight = null;
          }
          invalidateUpdateCheckState();
          return buildEnrichedState({
            forceCatalogRefresh: needsForceCatalog || pathname === '/api/sources',
            workspaceUris: Array.isArray(body.workspaceUris) ? body.workspaceUris : [],
          });
        });
        sendJson(res, 200, state);
        return;
      }

      if (pathname === '/api/favorites') {
        const key = typeof body.key === 'string' ? body.key.trim() : '';
        if (!key || key.length > 200) {
          sendJson(res, 400, { ok: false, error: 'ERR_INVALID_FAVORITE_KEY: Non-empty string "key" is required' });
          return;
        }
        if (body.plugin) {
          await catalogConfigQueue;
          const { plugins } = await ensureCatalogLoaded();
          if (!matchesDisplayedCatalogEntry(body.plugin, plugins.find(plugin => plugin.id === key))) {
            sendJson(res, 409, { ok: false, error: 'Catalog entry or source changed. Refresh the plugin list.' });
            return;
          }
        }
        let conflict;
        const installed = body.favorite === false ? [] : scanLocalPluginInventory({
          configDir, pluginsDir, dataDir, builtinPluginsDir, workspaceUris: parseWorkspaceUrisInput(body.workspaceUris),
          catalogPlugins: lastCatalog?.plugins || [],
        }).installed;
        usePrefs(updatePrefsOnDisk(dataDir, latest => {
          if (body.plugin && getCatalogPrefsKey(latest) !== lastCatalogPrefsKey) {
            conflict = 'Catalog source changed. Refresh the plugin list.';
            return null;
          }
          const targetState = typeof body.favorite === 'boolean' ? body.favorite : !latest.favorites.includes(key);
          const favoriteSources = { ...latest.favoriteSources };
          if (targetState) {
            const loc = key.startsWith('copy:') ? installed.find(item => item.favoriteKey === key)
              : matchLegacyLocalFavorite(key, installed, favoriteSources[key]) ||
                installed.find(item => item.scope === 'global' && item.receipt?.id === key);
            if (!loc && key.startsWith('copy:')) {
              conflict = 'ERR_PLUGIN_NOT_FOUND: Refresh the plugin list.';
              return null;
            }
            const entry = lastCatalog?.plugins?.find(plugin => plugin.id === key);
            if (entry && !favoriteSources[key]) favoriteSources[key] = favoriteSourceForCatalog(entry);
            else if (loc && !favoriteSources[key]) favoriteSources[key] = favoriteSourceForLocal(loc);
          }
          return { favorites: updateListMembership(latest.favorites, key, targetState, MAX_FAVORITES), favoriteSources };
        }));
        if (conflict) {
          sendJson(res, 409, { ok: false, error: conflict });
          return;
        }
        const persisted = prefs.favorites || [];
        sendJson(res, 200, {
          ok: true,
          key,
          isFavorite: persisted.includes(key),
          favorites: persisted,
          ...(body.plugin || key.startsWith('copy:') || Object.hasOwn(prefs.favoriteSources, key)
            ? { favoriteSources: prefs.favoriteSources } : {}),
        });
        return;
      }

      if (pathname === '/api/conflicts/ignore') {
        const id = typeof body.id === 'string' ? body.id.trim() : '';
        if (!id || id.length > 200) {
          sendJson(res, 400, {
            ok: false,
            error: 'ERR_INVALID_CONFLICT_ID: Non-empty string "id" (<=200 chars) is required',
          });
          return;
        }
        if (typeof body.ignored !== 'boolean') {
          sendJson(res, 400, {
            ok: false,
            error: 'ERR_INVALID_IGNORED_FLAG: Boolean "ignored" is required',
          });
          return;
        }
        const workspaceUris = parseWorkspaceUrisInput(body.workspaceUris);
        const result = await enqueueCatalogConfigOp(async () => {
          usePrefs(updatePrefsOnDisk(dataDir, latest => ({
            ignoredConflictIds: updateListMembership(latest.ignoredConflictIds, id, body.ignored, MAX_IGNORED_CONFLICTS),
          })));
          invalidateUpdateCheckState();
          const state = await buildEnrichedState({ forceCatalogRefresh: false, workspaceUris });
          const freshInv = scanLocalPluginInventory({
            configDir,
            dataDir,
            workspaceUris,
            builtinPluginsDir,
            linkInfoOverride,
          });
          const conflicts = applyIgnoredConflictsFilter(
            scanLocalConflicts({
              inventory: { ...freshInv, installed: state.installed },
              configDir,
              dataDir,
              workspaceUris,
              catalogPlugins: lastCatalog?.plugins || [],
            }),
            prefs.ignoredConflictIds,
          );
          return {
            ok: true,
            id,
            ignored: Boolean(body.ignored),
            ignoredConflictIds: [...(prefs.ignoredConflictIds || [])],
            conflicts,
            conflictsSummary: conflicts.summary,
            state,
          };
        });
        sendJson(res, 200, result);
        return;
      }

      if (pathname === '/api/open-pane') {
        const dir = typeof body.dir === 'string' ? body.dir.trim() : '';
        const sidecarFolder =
          typeof body.sidecarFolder === 'string'
            ? body.sidecarFolder.trim()
            : typeof body.folder === 'string'
              ? body.folder.trim()
              : '';
        const viewPath =
          typeof body.viewPath === 'string'
            ? body.viewPath.trim()
            : typeof body.path === 'string'
              ? body.path.trim()
              : '/';
        const title = typeof body.title === 'string' ? body.title.trim() : '';
        const uri = typeof body.uri === 'string' ? body.uri.trim() : '';

        if (!dir && !uri) {
          sendJson(res, 400, { ok: false, error: 'ERR_OPEN_PANE_INVALID: Requires non-empty "dir" or "uri"' });
          return;
        }

        const result = await openPaneImpl(
          { dir, sidecarFolder, viewPath, title, uri },
          openPaneOptions || {},
        );
        sendJson(res, 200, result);
        return;
      }

      if (pathname === '/api/preflight') {
        const targetId = String(body.id || '').trim();
        const catalog = await ensureCatalogLoaded();
        const plugin = catalog.plugins.find((p) => p.id === targetId);
        if (!plugin) {
          sendJson(res, 404, { ok: false, error: `Plugin "${targetId}" not found in active catalog` });
          return;
        }
        const inventory = scanLocalPluginInventory({
          configDir,
          dataDir,
          workspaceUris: Array.isArray(body.workspaceUris) ? body.workspaceUris : [],
          catalogPlugins: catalog.plugins,
        });
        const preflight = resolveInstallPreflight(plugin, inventory, {
          conflictStrategy: body.conflictStrategy || 'prompt',
        });
        const escalation = getUpdateEscalation(plugin, preflight);
        const replacementKey = preflight.choices?.includes('replace') || preflight.action === 'replace-local'
          ? getReplacementKey(plugin, preflight.conflict) : '';
        sendJson(res, 200, { ok: true, preflight: { ...preflight, replacementKey }, escalation });
        return;
      }

      if (PLUGIN_MUTATION_ROUTES.has(pathname) && !acquireMutationLock(pathname)) {
        return;
      }
      if (INSTALL_ROUTES.has(pathname)) {
        // An I/O failure can leave a journal long after the one-time startup check.
        // Recover before selecting the next target or trusting its installed version.
        const recovery = recoverInterruptedJournal({ dataDir, pluginsDir });
        if (recovery.action === 'busy' || recovery.error) {
          sendJson(res, 409, { ok: false, error: recovery.error ||
            'ERR_PLUGIN_OPERATION_BUSY: Another process is recovering a plugin installation.' });
          return;
        }
        if (recovery.recovered) invalidateUpdateCheckState();
      }

      if (pathname === '/api/toggle-plugin') {
        const workspaceUris = Array.isArray(body.workspaceUris) ? body.workspaceUris : [];
        await ensureCatalogLoaded().catch(() => null);
        const catalogCapabilities = findCatalogCapabilitiesForDir(String(body.dir || '').trim());
        const toggleRes = toggleInstalledPlugin({
          dir: body.dir,
          enabled: body.enabled,
          configDir,
          dataDir,
          catalogCapabilities,
          nowMs: nowFn(),
          renameOverride,
          rmOverride,
          unlinkOverride,
        });
        invalidateUpdateCheckState();
        const state = await buildEnrichedState({ forceCatalogRefresh: false, workspaceUris });
        sendJson(res, 200, {
          ...toggleRes,
          conflictsSummary: state.conflictsSummary,
          state,
        });
        return;
      }

      if (pathname === '/api/fix-conflict') {
        const workspaceUris = Array.isArray(body.workspaceUris) ? body.workspaceUris : [];
        const fixRes = fixLocalConflict({
          type: body.type,
          targetDir: body.targetDir,
          suggestedDir: body.suggestedDir || '',
          configDir,
          dataDir,
          linkInfoOverride,
          unlinkLinkOverride,
        });
        invalidateUpdateCheckState();
        const state = await buildEnrichedState({ forceCatalogRefresh: false, workspaceUris });
        const freshInv = scanLocalPluginInventory({ configDir, dataDir, workspaceUris, linkInfoOverride });
        const conflicts = applyIgnoredConflictsFilter(
          scanLocalConflicts({
            inventory: { ...freshInv, installed: state.installed },
            configDir,
            dataDir,
            workspaceUris,
            catalogPlugins: lastCatalog?.plugins || [],
          }),
          prefs.ignoredConflictIds,
        );
        sendJson(res, 200, {
          ...fixRes,
          conflicts,
          state,
        });
        return;
      }

      if (pathname === '/api/github/inspect') {
        const workspaceUris = parseWorkspaceUrisInput(body.workspaceUris);
        await ensureCatalogLoaded().catch(() => null);
        const rawInspect = await inspectGithubPluginUrl({
          url: typeof body.url === 'string' ? body.url : '',
          inspectToken: typeof body.inspectToken === 'string' ? body.inspectToken.trim() : '',
          pluginRoot: typeof body.pluginRoot === 'string' ? body.pluginRoot.trim() : '',
          prefs,
          configDir,
          dataDir,
          workspaceUris,
          catalogPlugins: lastCatalog?.plugins || [],
          fetchImpl,
          githubApiBaseUrl,
          nowMs: nowFn(),
        });
        const { _internal, ...publicInspect } = rawInspect;
        sendJson(res, 200, publicInspect);
        return;
      }

      if (pathname === '/api/github/install') {
        const workspaceUris = parseWorkspaceUrisInput(body.workspaceUris);
        await ensureCatalogLoaded().catch(() => null);
        const rawResult = await installGithubPlugin({
          inspectToken: typeof body.inspectToken === 'string' ? body.inspectToken.trim() : '',
          url: typeof body.url === 'string' ? body.url : '',
          pluginRoot: typeof body.pluginRoot === 'string' ? body.pluginRoot.trim() : '',
          installMode: typeof body.installMode === 'string' ? body.installMode.trim() : '',
          replacementKey: body.replacementKey,
          confirmEscalation: Boolean(body.confirmEscalation),
          approvalKey: body.approvalKey,
          prefs,
          configDir,
          dataDir,
          workspaceUris,
          catalogPlugins: lastCatalog?.plugins || [],
          fetchImpl,
          githubApiBaseUrl,
          nowMs: nowFn(),
        });
        const { _internal, ...result } = rawResult;
        if (result.ok) {
          invalidateUpdateCheckState();
        }
        const state = await buildEnrichedState({ forceCatalogRefresh: false, workspaceUris });
        sendJson(res, 200, { ...result, state });
        return;
      }

      if (pathname === '/api/install' || pathname === '/api/update') {
        const targetId = String(body.id || body.plugin?.id || '').trim();
        const targetDir = String(body.dir || '').trim();
        const workspaceUris = parseWorkspaceUrisInput(body.workspaceUris);
        await catalogConfigQueue;
        const catalog = await ensureCatalogLoaded();
        const catalogPlugins = catalog.plugins || [];
        const selectedCatalogPlugin = resolveCatalogPluginForMutation(catalogPlugins, { targetId, targetDir });
        // A panel can outlive its catalog entry. Only the active catalog supplies install metadata.
        if (body.plugin && !matchesDisplayedCatalogEntry(body.plugin, selectedCatalogPlugin)) {
          sendJson(res, 409, { ok: false, status: 'CATALOG_ENTRY_CHANGED', error: 'Catalog entry or source changed. Refresh the plugin list.' });
          return;
        }

        if (pathname === '/api/install') {
          const plugin = selectedCatalogPlugin;
          if (!plugin) {
            sendJson(res, 404, { ok: false, error: `Plugin "${targetId || targetDir}" not found in active catalog` });
            return;
          }
          const result = await installOrUpdateCatalogPlugin({
            catalogPlugins,
            plugin,
            track: plugin._track || (plugin.forceScopedInstall ? 'unverified' : 'verified'),
            prefs,
            conflictStrategy: body.conflictStrategy || 'prompt',
            replacementKey: body.replacementKey,
            preferredDir: targetDir,
            confirmEscalation: Boolean(body.confirmEscalation),
            approvalKey: body.approvalKey,
            rejectDowngrade: true,
            configDir,
            dataDir,
            workspaceUris,
            builtinPluginsDir,
            fetchImpl,
          });
          invalidateUpdateCheckState();
          const state = await buildEnrichedState({ forceCatalogRefresh: false, workspaceUris });
          const willRestart = Boolean(result.ok && (result.isSelfUpdate || targetDir === PLUGIN_ID));
          sendJson(
            res,
            200,
            { ...result, ...(willRestart ? { willRestart: true } : {}), state },
            willRestart ? () => onSelfRestart() : null,
          );
          return;
        }

        // POST /api/update
        const reqChannel = String(body.updateChannel || '').trim();
        const reqSource = String(body.source || '').trim();
        const forceResync = Boolean(body.forceResync);
        const preferUpstream = Boolean(
          body.preferUpstream ||
            reqChannel === 'github-upstream' ||
            reqChannel === 'github-url' ||
            reqSource === 'github-url' ||
            reqSource === 'github-release' ||
            reqSource === 'github-tag' ||
            reqSource === 'github-branch',
        );

        const inventory = scanLocalPluginInventory({
          configDir,
          dataDir,
          workspaceUris,
          builtinPluginsDir,
          linkInfoOverride,
          catalogPlugins,
        });
        const requestedLocal = targetDir && inventory.installed.find(loc => loc.scope === 'global' && loc.dir === targetDir);
        const explicitMatch = targetId ? selectedCatalogPlugin : null;
        const localMatch = findCatalogEntryForLocal(requestedLocal, catalogPlugins, inventory.installed);
        if (!explicitMatch && targetId && requestedLocal) {
          const slug = parseGithubRepoSlug(requestedLocal.repositoryUrl);
          const localIds = [requestedLocal.dir, requestedLocal.name, requestedLocal.receipt?.id, localMatch?.id,
            localMatch?.canonicalName, slug && `${slug.owner}__${slug.repo}`];
          if (!localIds.includes(targetId)) {
            sendJson(res, 409, { ok: false, status: 'UPDATE_TARGET_MISMATCH', error: '插件 ID 与指定的安装目录不匹配。' });
            return;
          }
        }
        const catPlugin = explicitMatch || localMatch;

        // (i) Direct catalog update / re-sync when catalog package is installable and upstream wasn't explicitly requested
        if (!preferUpstream && catPlugin && isCatalogPluginInstallable(catPlugin)) {
          const preflight = resolveInstallPreflight(catPlugin, inventory, {
            conflictStrategy: 'prompt',
            preferredDir: targetDir,
            requireExistingDir: true,
          });
          if (preflight.action === 'update' && isUnmanagedLocalPlugin(preflight.existingInstall)) {
            sendJson(res, 400, {
              ok: false,
              status: 'UNMANAGED_PLUGIN',
              errorCode: 'ERR_UNMANAGED_GIT_OR_UNVERSIONED',
              unmanagedReason:
                preflight.existingInstall.unmanagedReason ||
                (preflight.existingInstall.isGitManaged ? 'git-clone' : 'no-version'),
              error: buildUnmanagedUpdateErrorMessage(preflight.existingInstall),
            });
            return;
          }
          if (
            !forceResync &&
            preflight.action === 'update' &&
            preflight.existingInstall &&
            (!isNewerVersion(catPlugin.version, preflight.existingInstall.version) ||
              isSameInstalledRelease(preflight.existingInstall.receipt, {
                gitTag: catPlugin.gitTag,
                commitSha: catPlugin.commitSha,
              }))
          ) {
            const state = await buildEnrichedState({ forceCatalogRefresh: false, workspaceUris });
            sendJson(res, 200, {
              ok: true,
              status: 'ALREADY_UP_TO_DATE',
              alreadyUpToDate: true,
              noop: true,
              installedDir: preflight.existingInstall.dir,
              version: preflight.existingInstall.version,
              parkedByMarket: Boolean(preflight.existingInstall.parkedByMarket),
              restartRequired: false,
              reloadRequired: false,
              state,
            });
            return;
          }

          const result = await installOrUpdateCatalogPlugin({
            catalogPlugins,
            plugin: catPlugin,
            track: catPlugin._track || (catPlugin.forceScopedInstall ? 'unverified' : 'verified'),
            prefs,
            conflictStrategy: body.conflictStrategy || (isSelfPluginCandidate(catPlugin, targetDir) ? 'replace' : 'prompt'),
            replacementKey: body.replacementKey,
            preferredDir: targetDir,
            requireExistingDir: true,
            confirmEscalation: Boolean(body.confirmEscalation),
            approvalKey: body.approvalKey,
            rejectDowngrade: true,
            resyncVersion: forceResync ? String(body.targetVersion || preflight.existingInstall?.version || '') : '',
            configDir,
            dataDir,
            workspaceUris,
            builtinPluginsDir,
            fetchImpl,
          });
          invalidateUpdateCheckState();
          const state = await buildEnrichedState({ forceCatalogRefresh: false, workspaceUris });
          const willRestart = Boolean(result.ok && (result.isSelfUpdate || targetDir === PLUGIN_ID));
          sendJson(
            res,
            200,
            { ...result, ...(willRestart ? { willRestart: true } : {}), state },
            willRestart ? () => onSelfRestart() : null,
          );
          return;
        }

        // (ii) Direct GitHub upstream / github-url update or on-demand re-sync
        const globalInstalled = inventory.installed.filter(loc => loc.scope === 'global');
        const localPlugin = targetDir ? requestedLocal :
          globalInstalled.find(loc => loc.receipt?.id === targetId) ||
          (catPlugin && globalInstalled.find(loc => matchesInstalledSource(loc, catPlugin, inventory.installed))) ||
          globalInstalled.find(loc => loc.dir === targetId || loc.name === targetId);

        if (!localPlugin) {
          const nonGlobal =
            (targetDir && inventory.installed.find((loc) => loc.scope !== 'global' && loc.dir === targetDir)) ||
            inventory.installed.find(
              (loc) => loc.scope !== 'global' && targetId && (loc.dir === targetId || loc.name === targetId),
            );
          if (nonGlobal) {
            sendJson(res, 400, {
              ok: false,
              status: 'NON_GLOBAL_PLUGIN',
              error: `ERR_CANNOT_UPDATE_NON_GLOBAL: Plugin "${nonGlobal.dir}" has scope="${nonGlobal.scope}" and cannot be updated in-place`,
            });
            return;
          }
          sendJson(res, 404, { ok: false, error: `Plugin "${targetId || targetDir}" not found in active catalog` });
          return;
        }

        if (!localPlugin.receipt && localPlugin.inferredRepository) {
          sendJson(res, 409, { ok: false, status: 'UNVERIFIED_UPDATE_SOURCE', error: 'The installed plugin does not declare a repository for updates.' });
          return;
        }
        if (localPlugin.repositoryRoot === null) {
          sendJson(res, 409, { ok: false, status: 'UNRESOLVED_PLUGIN_ROOT', error: '无法确认插件的仓库目录。' });
          return;
        }
        const successor = findManagedSuccessor(localPlugin, inventory.installed);
        if (successor) {
          sendJson(res, 409, legacyDuplicateResult(localPlugin.dir, successor.dir));
          return;
        }
        if (isUnmanagedLocalPlugin(localPlugin)) {
          sendJson(res, 400, {
            ok: false,
            status: 'UNMANAGED_PLUGIN',
            errorCode: 'ERR_UNMANAGED_GIT_OR_UNVERSIONED',
            unmanagedReason: localPlugin.unmanagedReason || (localPlugin.isGitManaged ? 'git-clone' : 'no-version'),
            error: buildUnmanagedUpdateErrorMessage(localPlugin),
          });
          return;
        }

        const matchedCat = findCatalogEntryForLocal(localPlugin, catalogPlugins, inventory.installed);
        // A GitHub update targets the installed copy even when a different feed now claims its catalog ID.
        const boundUpstream = preferUpstream && requestedLocal === localPlugin && targetId === localPlugin.receipt?.id &&
          (localPlugin.receipt?.repositoryUrl || (!localPlugin.inferredRepository && localPlugin.repositoryUrl));
        if (explicitMatch && !matchesInstalledSource(localPlugin, explicitMatch, inventory.installed) && !boundUpstream) {
          sendJson(res, 409, { ok: false, status: 'UPDATE_TARGET_MISMATCH', error: '插件来源与指定的安装目录不匹配。' });
          return;
        }
        const updateHint =
          body.updateHint && typeof body.updateHint === 'object'
            ? body.updateHint
            : body.targetRef || body.repositoryUrl || body.pluginRoot || body.trackBranch || body.updateKind
              ? {
                  ...(body.targetRef ? { targetRef: String(body.targetRef) } : {}),
                  ...(body.updateKind ? { updateKind: String(body.updateKind) } : {}),
                  ...(body.trackBranch ? { trackBranch: String(body.trackBranch) } : {}),
                  ...(body.repositoryUrl ? { repositoryUrl: String(body.repositoryUrl) } : {}),
                  ...(body.pluginRoot ? { pluginRoot: String(body.pluginRoot) } : {}),
                }
              : null;

        const isSelfLocal =
          localPlugin.dir === PLUGIN_ID ||
          localPlugin.name === PLUGIN_ID ||
          localPlugin.receipt?.id === SELF_CATALOG_ID;
        const candidateRepoUrl = getValidGithubRepoUrl(
          updateHint?.repositoryUrl ||
            localPlugin.receipt?.repositoryUrl ||
            matchedCat?.repository?.url ||
            localPlugin.repositoryUrl ||
            (isSelfLocal ? SELF_REPO_URL : ''),
        );

        if (!candidateRepoUrl) {
          sendJson(res, 400, {
            ok: false,
            status: 'NO_UPDATE_SOURCE',
            error: `ERR_NO_UPDATE_SOURCE: Plugin "${localPlugin.dir}" has neither an installable catalog entry nor a GitHub repository URL`,
          });
          return;
        }

        if (!forceResync && updateHint) {
          const hintTargetRef = String(updateHint.targetRef || '').trim();
          let upstreamAlreadyCurrent = false;
          if (updateHint.updateKind === 'commit') {
            const localSha = String(localPlugin.receipt?.commitSha || '').trim().toLowerCase();
            const targetSha = hintTargetRef.toLowerCase();
            if (localSha && targetSha && (localSha === targetSha || localSha.startsWith(targetSha))) {
              upstreamAlreadyCurrent = true;
            }
          } else if (hintTargetRef) {
            const localTag = String(localPlugin.receipt?.gitTag || '').trim().toLowerCase();
            const targetTag = hintTargetRef.toLowerCase();
            const isRoot = normalizePluginRoot(localPlugin.receipt?.pluginRoot || localPlugin.repositoryRoot) === '.';
            const targetSem = isRoot && parseSemver(hintTargetRef);
            if (
              (localTag && localTag === targetTag) ||
              (targetSem && !isNewerVersion(targetSem.version, localPlugin.version))
            ) {
              upstreamAlreadyCurrent = true;
            }
          }
          if (upstreamAlreadyCurrent) {
            const state = await buildEnrichedState({ forceCatalogRefresh: false, workspaceUris });
            sendJson(res, 200, {
              ok: true,
              status: 'ALREADY_UP_TO_DATE',
              alreadyUpToDate: true,
              noop: true,
              installedDir: localPlugin.dir,
              version: localPlugin.version,
              parkedByMarket: Boolean(localPlugin.parkedByMarket),
              restartRequired: false,
              reloadRequired: false,
              state,
            });
            return;
          }
          const source = localPlugin.receipt?.githubSource;
          if (/^[a-f0-9]{40}$/i.test(hintTargetRef) && localPlugin.receipt?.track === 'github-url' &&
              localPlugin.receipt.commitSha && (source?.trackBranch || source?.refType === 'branch' || updateHint.updateKind === 'commit')) {
            const repo = parseGithubRepoSlug(matchedCat?.repository?.url || localPlugin.receipt.repositoryUrl || localPlugin.repositoryUrl);
            const branch = source?.trackBranch || (source?.refType === 'branch' && source.ref) || 'HEAD';
            const probe = repo && await probeGithubBranchHead({
              owner: repo.owner, repo: repo.repo, branch, pluginRoot: localPlugin.receipt.pluginRoot || localPlugin.repositoryRoot,
              installedCommitSha: localPlugin.receipt.commitSha, dataDir, prefs, fetchImpl, githubApiBaseUrl,
              nowMs: nowFn(), ttlMs: updateCheckTtlMs,
            });
            if (!probe?.checked || probe.head?.commitSha !== hintTargetRef.toLowerCase() || probe.head.subtreeChanged === false) {
              sendJson(res, 409, { ok: false, status: 'UPDATE_TARGET_MISMATCH', error: 'The tracked branch changed or could not be verified. Check for updates again.' });
              return;
            }
          }
        }

        const rawResult = await resolveAndStageGithubUpdate({
          loc: localPlugin,
          catPlugin: matchedCat,
          updateHint,
          confirmEscalation: Boolean(body.confirmEscalation),
          approvalKey: body.approvalKey,
          resyncVersion: forceResync ? String(body.targetVersion || localPlugin.version) : '',
          prefs,
          configDir,
          dataDir,
          workspaceUris,
          builtinPluginsDir,
          catalogPlugins,
          fetchImpl,
          githubApiBaseUrl,
          nowMs: nowFn(),
        });
        const { _internal, ...result } = rawResult;
        invalidateUpdateCheckState();
        const state = await buildEnrichedState({ forceCatalogRefresh: false, workspaceUris });
        const willRestart = Boolean(
          result.ok && (result.isSelfUpdate || localPlugin.dir === PLUGIN_ID || targetDir === PLUGIN_ID),
        );
        sendJson(
          res,
          200,
          { ...result, ...(willRestart ? { willRestart: true } : {}), state },
          willRestart ? () => onSelfRestart() : null,
        );
        return;
      }

      if (pathname === '/api/update-all') {
        const workspaceUris = parseWorkspaceUrisInput(body.workspaceUris);
        const confirmEscalation = Boolean(body.confirmEscalation);
        const forceCheck = Boolean(body.forceCheck);
        const generation = updateCheckGeneration;
        await ensureCatalogLoaded({ forceCatalogRefresh: forceCheck });
        const catalogPlugins = lastCatalog?.plugins || [];
        const inventory = scanLocalPluginInventory({
          configDir,
          dataDir,
          workspaceUris,
          builtinPluginsDir,
          linkInfoOverride,
          catalogPlugins,
        });
        const globalInstalled = inventory.installed.filter((loc) => loc.scope === 'global');

        const updateReport = await checkPluginUpdates({
          catalog: lastCatalog,
          inventory,
          dataDir,
          prefs,
          force: forceCheck,
          fetchImpl,
          nowMs: nowFn(),
          ...(updateCheckTtlMs !== undefined ? { ttlMs: updateCheckTtlMs } : {}),
          currentSelfVersion,
          githubApiBaseUrl,
          shouldPersistCache: () => generation === updateCheckGeneration,
        });

        const updById = new Map();
        const updByDir = new Map();
        for (const upd of updateReport.items || []) {
          if (upd?.id && !updById.has(upd.id)) updById.set(upd.id, upd);
          if (upd?.dir && !updByDir.has(upd.dir)) updByDir.set(upd.dir, upd);
        }

        const queue = [];
        if (Array.isArray(body.ids)) {
          const seenReqIds = new Set();
          for (const rawId of body.ids) {
            const reqId = String(rawId || '').trim();
            if (!reqId || seenReqIds.has(reqId)) continue;
            seenReqIds.add(reqId);

            const requestedUpdate = updByDir.get(reqId) || updById.get(reqId);
            const exactDir = globalInstalled.find(loc => loc.dir === reqId);
            const requestedPlugin = catalogPlugins.find(p => p.id === reqId || p.canonicalName === reqId);
            const localLoc = exactDir || globalInstalled.find(loc => loc.dir === requestedUpdate?.dir) ||
              globalInstalled.find(loc => loc.receipt?.id === reqId) ||
              (requestedPlugin && globalInstalled.find(loc => matchesInstalledSource(loc, requestedPlugin, inventory.installed))) ||
              globalInstalled.find(loc => loc.name === reqId);
            const upd = localLoc ? updByDir.get(localLoc.dir) : requestedUpdate;
            const plugin = localLoc ? findCatalogEntryForLocal(localLoc, catalogPlugins, inventory.installed) : requestedPlugin;
            const isSelf = Boolean(upd?.isSelf || isSelfPluginCandidate(plugin, localLoc?.dir || reqId));

            const successor = findManagedSuccessor(localLoc, globalInstalled);
            if (successor) {
              queue.push({ id: reqId, dir: localLoc.dir, successorDir: successor.dir });
              continue;
            }
            if (isUnmanagedLocalPlugin(localLoc)) {
              queue.push({
                id: reqId,
                dir: localLoc.dir,
                displayName: localLoc.displayName || localLoc.dir,
                unmanagedLoc: localLoc,
                isSelf: false,
              });
              continue;
            }

            if (!upd && localLoc && updateReport.uncheckedDirs.includes(localLoc.dir)) {
              queue.push({ id: reqId, dir: localLoc.dir, targetError: '无法确认上游版本 / Could not verify the upstream version' });
              continue;
            }

            // Prefer GitHub direct update when update check found a newer github-upstream / github-url build
            if (upd && (upd.updateChannel === 'github-upstream' || upd.updateChannel === 'github-url') && localLoc) {
              queue.push({
                id: upd.id || plugin?.id || localLoc.receipt?.id || localLoc.dir,
                dir: localLoc.dir,
                githubLoc: localLoc,
                catPlugin: plugin,
                updateHint: upd,
                isSelf,
              });
              continue;
            }

            if (plugin && isCatalogPluginInstallable(plugin)) {
              let preflight;
              try {
                preflight = resolveInstallPreflight(plugin, inventory, {
                  conflictStrategy: 'prompt', preferredDir: localLoc?.dir || '', requireExistingDir: true,
                });
              } catch (err) {
                queue.push({ id: reqId, dir: localLoc?.dir, targetError: err.message });
                continue;
              }
              const localDir = preflight.existingInstall?.dir || localLoc?.dir || plugin.canonicalName;
              if (
                !upd &&
                preflight.action === 'update' &&
                preflight.existingInstall &&
                (!isNewerVersion(plugin.version, preflight.existingInstall.version) ||
                  isSameInstalledRelease(preflight.existingInstall.receipt, {
                    gitTag: plugin.gitTag,
                    commitSha: plugin.commitSha,
                  }))
              ) {
                queue.push({
                  id: plugin.id,
                  dir: localDir,
                  displayName: plugin.displayName || plugin.canonicalName,
                  alreadyUpToDate: true,
                  version: preflight.existingInstall.version,
                  parkedByMarket: Boolean(preflight.existingInstall.parkedByMarket),
                  isSelf: false,
                });
                continue;
              }
              queue.push({
                id: plugin.id,
                dir: localDir,
                plugin,
                isSelf: isSelfPluginCandidate(plugin, localDir),
              });
              continue;
            }

            if (localLoc) {
              if (!upd && localLoc.receipt?.track === 'github-url' && localLoc.receipt.githubSource?.refType === 'branch') {
                queue.push({ id: reqId, dir: localLoc.dir, displayName: localLoc.displayName, version: localLoc.version,
                  parkedByMarket: localLoc.parkedByMarket, alreadyUpToDate: true });
                continue;
              }
              const candidateRepoUrl = getValidGithubRepoUrl(
                upd?.repositoryUrl ||
                  localLoc.receipt?.repositoryUrl ||
                  plugin?.repository?.url ||
                  localLoc.repositoryUrl ||
                  (isSelf ? SELF_REPO_URL : ''),
              );
              if (candidateRepoUrl) {
                queue.push({
                  id: upd?.id || plugin?.id || localLoc.receipt?.id || localLoc.dir,
                  dir: localLoc.dir,
                  githubLoc: localLoc,
                  catPlugin: plugin,
                  updateHint: upd,
                  isSelf,
                });
                continue;
              }
              if (plugin) {
                queue.push({
                  id: plugin.id,
                  dir: localLoc.dir,
                  plugin,
                  notInstallable: true,
                  isSelf,
                });
                continue;
              }
              queue.push({
                id: reqId,
                dir: localLoc.dir,
                displayName: localLoc.displayName || localLoc.dir,
                noUpdateSource: true,
                isSelf: false,
              });
              continue;
            }

            if (plugin) {
              queue.push({
                id: plugin.id,
                dir: plugin.canonicalName,
                plugin,
                notInstallable: true,
                isSelf,
              });
              continue;
            }

            queue.push({
              id: reqId,
              missing: true,
              isSelf: reqId === SELF_CATALOG_ID || reqId === PLUGIN_ID,
            });
          }
        } else {
          const queuedDirs = new Set();
          for (const upd of updateReport.items || []) {
            if (!upd?.installable || queuedDirs.has(upd.dir)) continue;
            const localLoc = globalInstalled.find((loc) => loc.dir === upd.dir) || null;
            if (isUnmanagedLocalPlugin(localLoc)) continue;
            const catPlugin = findCatalogEntryForLocal(localLoc, catalogPlugins, inventory.installed);
            const isSelf = Boolean(upd.isSelf || isSelfPluginCandidate(catPlugin, upd.dir));

            if ((upd.updateChannel === 'catalog' || upd.source === 'catalog') && catPlugin && isCatalogPluginInstallable(catPlugin)) {
              queuedDirs.add(upd.dir);
              queue.push({
                id: catPlugin.id,
                dir: upd.dir,
                plugin: catPlugin,
                isSelf,
              });
              continue;
            }

            if (localLoc && (upd.updateChannel === 'github-upstream' || upd.updateChannel === 'github-url')) {
              queuedDirs.add(localLoc.dir);
              queue.push({
                id: upd.id || catPlugin?.id || localLoc.receipt?.id || localLoc.dir,
                dir: localLoc.dir,
                githubLoc: localLoc,
                catPlugin,
                updateHint: upd,
                isSelf,
              });
            }
          }
        }

        // Strict ordering invariant: non-self plugins first, self (`agy-market`) ALWAYS last
        const orderedQueue = [
          ...queue.filter((item) => !item.isSelf),
          ...queue.filter((item) => item.isSelf),
        ];

        const results = [];
        let didSelfUpdate = false;

        for (const item of orderedQueue) {
          if (item.missing) {
            results.push({
              id: item.id,
              ok: false,
              status: 'NOT_FOUND',
              error: `Plugin "${item.id}" not found in active catalog`,
            });
            continue;
          }
          if (item.targetError) {
            results.push({ id: item.id, dir: item.dir, ok: false, status: 'UPDATE_TARGET_ERROR', error: item.targetError });
            continue;
          }
          if (item.successorDir) {
            results.push({ id: item.id, ...legacyDuplicateResult(item.dir, item.successorDir) });
            continue;
          }
          if (item.noUpdateSource) {
            results.push({
              id: item.id,
              dir: item.dir,
              displayName: item.displayName || item.dir,
              ok: false,
              status: 'NO_UPDATE_SOURCE',
              error: `ERR_NO_UPDATE_SOURCE: Plugin "${item.dir}" has neither an installable catalog entry nor a GitHub repository URL`,
            });
            continue;
          }
          if (item.unmanagedLoc) {
            results.push({
              id: item.id,
              dir: item.dir,
              displayName: item.displayName || item.dir,
              ok: false,
              status: 'UNMANAGED_PLUGIN',
              errorCode: 'ERR_UNMANAGED_GIT_OR_UNVERSIONED',
              unmanagedReason:
                item.unmanagedLoc.unmanagedReason || (item.unmanagedLoc.isGitManaged ? 'git-clone' : 'no-version'),
              error: buildUnmanagedUpdateErrorMessage(item.unmanagedLoc),
            });
            continue;
          }
          if (item.notInstallable) {
            results.push({
              id: item.id,
              dir: item.dir,
              displayName: item.plugin.displayName || item.plugin.canonicalName,
              ok: false,
              status: 'NOT_INSTALLABLE',
              error: `Plugin "${item.id}" lacks a verified catalog tarball/sha256`,
            });
            continue;
          }
          if (item.alreadyUpToDate) {
            results.push({
              id: item.id,
              dir: item.dir,
              installedDir: item.dir,
              displayName: item.displayName || item.dir,
              ok: true,
              status: 'ALREADY_UP_TO_DATE',
              alreadyUpToDate: true,
              noop: true,
              version: item.version,
              parkedByMarket: Boolean(item.parkedByMarket),
              restartRequired: false,
              reloadRequired: false,
              isSelf: false,
            });
            continue;
          }

          if (item.githubLoc) {
            const ghLoc = item.githubLoc;
            try {
              const out = await resolveAndStageGithubUpdate({
                loc: ghLoc,
                catPlugin: item.catPlugin || null,
                updateHint: item.updateHint || null,
                confirmEscalation,
                approvalKey: body.approvalKeys?.[item.dir],
                prefs,
                configDir,
                dataDir,
                workspaceUris,
                builtinPluginsDir,
                catalogPlugins,
                fetchImpl,
                githubApiBaseUrl,
                nowMs: nowFn(),
              });
              const isSelfDone = Boolean(out.ok && (out.isSelfUpdate || item.isSelf || ghLoc.dir === PLUGIN_ID));
              if (isSelfDone) {
                didSelfUpdate = true;
              }
              results.push({
                id: item.id,
                dir: out.installedDir || ghLoc.dir,
                displayName: item.catPlugin?.displayName || ghLoc.displayName || ghLoc.name || ghLoc.dir,
                ok: Boolean(out.ok),
                status: out.status || (out.ok ? 'INSTALLED' : 'ERROR'),
                ...(out.error ? { error: out.error } : {}),
                ...(out.installedDir ? { installedDir: out.installedDir } : {}),
                ...(out.version ? { version: out.version } : {}),
                ...(out.installedVersion ? { installedVersion: out.installedVersion } : {}),
                ...(out.targetVersion ? { targetVersion: out.targetVersion } : {}),
                ...(out.escalation ? { escalation: out.escalation } : {}),
                ...(out.conflict ? { conflict: out.conflict } : {}),
                ...(isSelfDone ? { isSelfUpdate: true } : {}),
                ...(out.parkedByMarket !== undefined ? { parkedByMarket: out.parkedByMarket } : {}),
                ...(out.reloadRequired !== undefined ? { reloadRequired: out.reloadRequired } : {}),
                ...(out.restartRequired !== undefined ? { restartRequired: out.restartRequired } : {}),
                ...(out.activation ? { activation: out.activation } : {}),
                ...(out.customizationUri ? { customizationUri: out.customizationUri } : {}),
                ...(out.sidecarPane !== undefined ? { sidecarPane: out.sidecarPane } : {}),
              });
            } catch (err) {
              results.push({
                id: item.id,
                dir: ghLoc.dir,
                displayName: item.catPlugin?.displayName || ghLoc.displayName || ghLoc.name || ghLoc.dir,
                ok: false,
                status: 'ERROR',
                error: err?.message || String(err),
              });
            }
            continue;
          }

          const plugin = item.plugin;
          try {
            const out = await installOrUpdateCatalogPlugin({
              catalogPlugins,
              plugin,
              track: plugin._track || (plugin.forceScopedInstall ? 'unverified' : 'verified'),
              prefs,
              conflictStrategy: item.isSelf ? 'replace' : 'prompt',
              preferredDir: item.dir || '',
              requireExistingDir: globalInstalled.some(loc => loc.dir === item.dir),
              confirmEscalation,
              approvalKey: body.approvalKeys?.[item.dir],
              rejectDowngrade: true,
              configDir,
              dataDir,
              workspaceUris,
              builtinPluginsDir,
              fetchImpl,
            });

            if (out.ok && out.isSelfUpdate) {
              didSelfUpdate = true;
            }

            results.push({
              id: plugin.id,
              dir: out.installedDir || item.dir || plugin.canonicalName,
              displayName: plugin.displayName || plugin.canonicalName,
              ok: Boolean(out.ok),
              status: out.status || (out.ok ? 'INSTALLED' : 'ERROR'),
              ...(out.error ? { error: out.error } : {}),
              ...(out.installedDir ? { installedDir: out.installedDir } : {}),
              ...(out.version ? { version: out.version } : {}),
              ...(out.installedVersion ? { installedVersion: out.installedVersion } : {}),
              ...(out.targetVersion ? { targetVersion: out.targetVersion } : {}),
              ...(out.escalation ? { escalation: out.escalation } : {}),
              ...(out.conflict ? { conflict: out.conflict } : {}),
              ...(out.isSelfUpdate ? { isSelfUpdate: true } : {}),
              ...(out.parkedByMarket !== undefined ? { parkedByMarket: out.parkedByMarket } : {}),
              ...(out.reloadRequired !== undefined ? { reloadRequired: out.reloadRequired } : {}),
              ...(out.restartRequired !== undefined ? { restartRequired: out.restartRequired } : {}),
              ...(out.activation ? { activation: out.activation } : {}),
              ...(out.customizationUri ? { customizationUri: out.customizationUri } : {}),
              ...(out.sidecarPane !== undefined ? { sidecarPane: out.sidecarPane } : {}),
            });
          } catch (err) {
            results.push({
              id: plugin.id,
              dir: item.dir || plugin.canonicalName,
              displayName: plugin.displayName || plugin.canonicalName,
              ok: false,
              status: 'ERROR',
              error: err?.message || String(err),
            });
          }
        }

        invalidateUpdateCheckState();
        const state = await buildEnrichedState({ forceCatalogRefresh: false, workspaceUris });
        const allOk = results.every((r) => r.ok);
        const restartRequired = results.some((r) => Boolean(r.restartRequired));
        sendJson(
          res,
          200,
          {
            ok: allOk,
            results,
            willRestart: didSelfUpdate,
            restartRequired,
            state,
          },
          didSelfUpdate ? () => onSelfRestart() : null,
        );
        return;
      }

      if (pathname === '/api/self-update') {
        const workspaceUris = parseWorkspaceUrisInput(body.workspaceUris);
        const forceRefresh = Boolean(body.force);
        const reqChannel = String(body.updateChannel || '').trim();
        const targetVersion = String(body.targetVersion || '').trim();
        const targetRef = String(body.targetRef || '').trim();

        await ensureCatalogLoaded({ forceCatalogRefresh: forceRefresh });
        let selfPlugin =
          (lastCatalog?.plugins || []).find(isOfficialMarketEntry) || null;

        if (!selfPlugin && !forceRefresh) {
          await ensureCatalogLoaded({ forceCatalogRefresh: true }).catch(() => null);
          selfPlugin =
            (lastCatalog?.plugins || []).find(isOfficialMarketEntry) || null;
        }

        const catalogCanDirectSelf = Boolean(selfPlugin && isCatalogPluginInstallable(selfPlugin));
        const catalogBehindTarget = Boolean(
          targetVersion && selfPlugin?.version && isNewerVersion(targetVersion, selfPlugin.version),
        );
        const useGithubUpstreamSelf =
          reqChannel === 'github-upstream' || !catalogCanDirectSelf || catalogBehindTarget;

        const inventory = scanLocalPluginInventory({ configDir, dataDir, workspaceUris, builtinPluginsDir, linkInfoOverride });
        const installedSelf = inventory.installed.find(loc => loc.scope === 'global' && samePluginName(loc.dir, PLUGIN_ID));
        if (isUnmanagedLocalPlugin(installedSelf)) {
          sendJson(res, 400, { ok: false, status: 'UNMANAGED_PLUGIN', error: buildUnmanagedUpdateErrorMessage(installedSelf) });
          return;
        }
        if (isForeignMarketInstall(installedSelf)) {
          sendJson(res, 409, { ok: false, status: 'UPDATE_TARGET_MISMATCH', error: 'The market directory belongs to a different source.' });
          return;
        }
        let result;
        if (useGithubUpstreamSelf) {
          const existingSelf = installedSelf || {
            dir: PLUGIN_ID, name: PLUGIN_ID, scope: 'global', displayName: PLUGIN_DISPLAY_NAME,
            version: currentSelfVersion, repositoryUrl: SELF_REPO_URL, receipt: null,
          };
          const rawResult = await resolveAndStageGithubUpdate({
            loc: existingSelf,
            catPlugin: selfPlugin,
            updateHint: {
              repositoryUrl: SELF_REPO_URL,
              pluginRoot: '.',
              ...(targetRef ? { targetRef, updateKind: 'semver' } : {}),
            },
            confirmEscalation: Boolean(body.confirmEscalation),
            approvalKey: body.approvalKey,
            prefs,
            configDir,
            dataDir,
            workspaceUris,
            builtinPluginsDir,
            catalogPlugins: lastCatalog?.plugins || [],
            fetchImpl,
            githubApiBaseUrl,
            nowMs: nowFn(),
          });
          const { _internal, ...publicRes } = rawResult;
          result = publicRes;
        } else {
          result = await installOrUpdateCatalogPlugin({
            plugin: selfPlugin,
            track: selfPlugin._track || 'verified',
            prefs,
            preferredDir: installedSelf?.dir || '',
            requireExistingDir: Boolean(installedSelf),
            conflictStrategy: 'prompt',
            confirmEscalation: Boolean(body.confirmEscalation),
            approvalKey: body.approvalKey,
            rejectDowngrade: true,
            configDir,
            dataDir,
            workspaceUris,
            builtinPluginsDir,
            fetchImpl,
          });
        }

        invalidateUpdateCheckState();
        const state = await buildEnrichedState({ forceCatalogRefresh: false, workspaceUris });
        const willRestart = Boolean(result.ok && (result.isSelfUpdate || result.installedDir === PLUGIN_ID));
        sendJson(
          res,
          200,
          { ...result, ...(willRestart ? { isSelfUpdate: true } : {}), willRestart, state },
          willRestart ? () => onSelfRestart() : null,
        );
        return;
      }

      if (pathname === '/api/uninstall' || pathname === '/api/remove-files') {
        const workspaceUris = parseWorkspaceUrisInput(body.workspaceUris);
        const targetDir = String(body.dir || '').trim();
        const catalog = await ensureCatalogLoaded().catch(() => null);
        const out = await uninstallPlugin({
          dir: targetDir,
          expectedInstall: body.expectedInstall,
          configDir,
          dataDir,
          workspaceUris,
          builtinPluginsDir,
          catalogPlugins: catalog?.plugins || [],
          removeFavorite: Boolean(body.removeFavorite),
          nowMs: nowFn(),
          rmOverride,
          unlinkOverride,
          renameOverride,
          linkInfoOverride,
          unlinkLinkOverride,
          fetchImpl,
        });
        usePrefs(loadPrefsFromDisk(dataDir));
        invalidateUpdateCheckState();
        const state = await buildEnrichedState({ forceCatalogRefresh: false, workspaceUris });
        sendJson(res, 200, { ok: true, ...out, conflictsSummary: state.conflictsSummary, state });
        return;
      }
    }

    sendJson(res, 404, { ok: false, error: `Not found: ${req.method} ${pathname}` });
  }

  let server = null;
  let actualPort = 0;
  let origin = 'http://127.0.0.1:0';
  const serverInfoPath = join(dataDir, 'server_info.json');

  if (options.listen !== false) {
    server = createServer((req, res) => {
      handleRequest(req, res).catch((err) => {
        if (!res.headersSent) {
          sendRequestError(res, err);
        }
      });
    });
    // Allow long-running >5min streaming downloads/installs on localhost loopback
    server.requestTimeout = 0;

    await new Promise((resolvePromise, rejectPromise) => {
      server.once('error', rejectPromise);
      server.listen(listenPort, '127.0.0.1', () => resolvePromise());
    });

    const addr = server.address();
    actualPort = addr && typeof addr === 'object' ? addr.port : listenPort;
    origin = `http://127.0.0.1:${actualPort}`;

    try {
      writeFileSync(
        serverInfoPath,
        `${JSON.stringify(
          {
            plugin: PLUGIN_ID,
            pid: process.pid,
            port: actualPort,
            origin,
            startedAt: new Date().toISOString(),
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

  const close = async () => {
    if (recoveryTimer) {
      clearTimeout(recoveryTimer);
      recoveryTimer = null;
    }
    try {
      if (existsSync(serverInfoPath)) {
        const info = JSON.parse(readFileSync(serverInfoPath, 'utf8'));
        if (info?.pid === process.pid) rmSync(serverInfoPath, { force: true });
      }
    } catch {
      /* ignore */
    }
    if (server) {
      server.closeAllConnections?.();
      await new Promise((r) => server.close(() => r()));
      server = null;
    }
  };

  /**
   * Fast in-process HTTP request injector for sandboxed tests without TCP loopback dependencies.
   */
  const inject = async ({ method = 'GET', url = '/', headers = {}, body = null } = {}) => {
    const lowerHeaders = { host: '127.0.0.1' };
    for (const [k, v] of Object.entries(headers || {})) {
      lowerHeaders[k.toLowerCase()] = String(v);
    }
    let bodyBuf = Buffer.alloc(0);
    if (Buffer.isBuffer(body)) bodyBuf = body;
    else if (typeof body === 'string') bodyBuf = Buffer.from(body, 'utf8');
    else if (body && typeof body === 'object') {
      bodyBuf = Buffer.from(JSON.stringify(body), 'utf8');
      if (!lowerHeaders['content-type']) lowerHeaders['content-type'] = 'application/json';
    }

    const req = Readable.from(bodyBuf.length > 0 ? [bodyBuf] : []);
    req.method = String(method).toUpperCase();
    req.url = String(url);
    req.headers = lowerHeaders;
    req.destroy = () => {};

    let statusCode = 200;
    const resHeaders = {};
    const outChunks = [];
    let ended = false;
    let resolveDone;
    const donePromise = new Promise((r) => {
      resolveDone = r;
    });

    const res = {
      req,
      headersSent: false,
      writeHead(code, hdrs = {}) {
        statusCode = code;
        this.headersSent = true;
        for (const [k, v] of Object.entries(hdrs)) resHeaders[k.toLowerCase()] = v;
        return this;
      },
      write(chunk) {
        if (chunk) outChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
        return true;
      },
      end(chunk, cb) {
        if (ended) return;
        ended = true;
        if (typeof chunk === 'function') {
          cb = chunk;
          chunk = null;
        }
        if (chunk) outChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
        const rawBody = Buffer.concat(outChunks);
        const text = rawBody.toString('utf8');
        resolveDone({
          statusCode,
          headers: resHeaders,
          body: rawBody,
          text,
          json() {
            return JSON.parse(text);
          },
        });
        if (typeof cb === 'function') {
          cb();
        }
      },
    };

    try {
      await handleRequest(req, res);
    } catch (err) {
      if (!res.headersSent) {
        sendRequestError(res, err);
      }
    }
    return donePromise;
  };

  return {
    server,
    port: actualPort,
    origin,
    canRestartForDiskUpdate,
    sideToken: generatedSideToken,
    dataDir,
    configDir,
    inject,
    close,
  };
}
