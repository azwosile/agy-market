// Localhost 127.0.0.1 Sidecar HTTP Router, X-Sidecar-Token CSRF Guard & State Persistence (`src/sidecar/server.mjs`).

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { fetchPluginDiscussions } from '../discussions/index.mjs';
import {
  fixLocalConflict,
  installOrUpdateCatalogPlugin,
  removeMarketPluginFiles,
  toggleInstalledPlugin,
} from '../installer/index.mjs';
import { recoverInterruptedJournal } from '../installer/journal.mjs';
import { sweepRetiredBinaries } from '../installer/sync-dir.mjs';
import { scanLocalConflicts } from '../preflight/conflicts.mjs';
import { resolveInstallPreflight, scanLocalPluginInventory } from '../preflight/index.mjs';
import { resolveMarketCatalog } from '../registry/index.mjs';
import { classifyActivationRequirement } from '../shared/activation.mjs';
import {
  CUSTOMIZATION_URI,
  DEFAULT_PREFS,
  MAX_FAVORITES,
  PLUGIN_DISPLAY_NAME,
  PLUGIN_ID,
  PLUGIN_VERSION,
  SELF_CATALOG_ID,
  SIDECAR_URI,
} from '../shared/constants.mjs';
import {
  resolveAntigravityConfigDir,
  resolveDisabledPluginsDir,
  resolveMarketDataDir,
  resolvePluginsDir,
} from '../shared/paths.mjs';
import { computeCapabilityEscalation, sanitizeFavorites, sanitizePrefs, toPublicPrefs } from '../shared/schemas.mjs';
import { isNewerVersion } from '../shared/semver.mjs';
import { checkPluginUpdates, isCatalogPluginInstallable } from '../updates/index.mjs';
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
      toggleAuxPane: function(payload) {
        var posted = false;
        try {
          if (window.parent && window.parent !== window) {
            window.parent.postMessage({ type: 'toggle-aux-pane', payload: payload || {} }, '*');
            posted = true;
          }
        } catch (_) {}
        return Promise.resolve({ ok: false, fallback: true, posted: posted });
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
  if (!originHeader || originHeader === 'null') return true; // isolated host iframe or same-origin non-CORS
  const orig = String(originHeader).trim().toLowerCase();
  if (orig.startsWith('vscode-webview://')) return true;
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

function injectBootIntoHtml(rawHtml, token, conversationId = '') {
  const bootScript = `<script>window.__SIDECAR_BOOT__=${JSON.stringify({ token, conversationId })};</script>`;
  let html = rawHtml.includes('</head>') ? rawHtml.replace('</head>', `${bootScript}\n</head>`) : `${bootScript}\n${rawHtml}`;
  if (token) {
    html = html.replace(/src=(["'])\/preload\.js\1/g, `src=$1/preload.js?token=${encodeURIComponent(token)}$1`);
  }
  return html;
}

function sendJson(res, status, payload, onFlushed = null) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  if (typeof onFlushed === 'function') {
    res.end(body, onFlushed);
  } else {
    res.end(body);
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

function loadPrefsFromDisk(dataDir) {
  const prefsPath = join(dataDir, 'prefs.json');
  if (!existsSync(prefsPath)) return sanitizePrefs(DEFAULT_PREFS);
  try {
    return sanitizePrefs(JSON.parse(readFileSync(prefsPath, 'utf8')));
  } catch {
    return sanitizePrefs(DEFAULT_PREFS);
  }
}

function savePrefsToDisk(dataDir, nextPrefs) {
  mkdirSync(dataDir, { recursive: true });
  const clean = sanitizePrefs(nextPrefs);
  const tmpPath = join(dataDir, `prefs.json.${process.pid}.${Date.now()}.tmp`);
  const dstPath = join(dataDir, 'prefs.json');
  const writeOpts = clean.githubToken ? { encoding: 'utf8', mode: 0o600 } : { encoding: 'utf8' };
  const serialized = `${JSON.stringify(clean, null, 2)}\n`;
  writeFileSync(tmpPath, serialized, writeOpts);
  try {
    renameSync(tmpPath, dstPath);
  } catch {
    writeFileSync(dstPath, serialized, writeOpts);
    rmSync(tmpPath, { force: true });
  }
  return clean;
}

function isSelfPluginCandidate(plugin, installedDir = '') {
  return (
    installedDir === PLUGIN_ID ||
    plugin?.id === SELF_CATALOG_ID ||
    plugin?.canonicalName === PLUGIN_ID
  );
}

function mergeCapabilitiesForActivation(localCap = {}, catalogCap = {}) {
  const a = localCap && typeof localCap === 'object' ? localCap : {};
  const b = catalogCap && typeof catalogCap === 'object' ? catalogCap : {};
  const badges = [...new Set([...(a.badges || []), ...(b.badges || [])])];
  const hostEnhancementKind = [
    ...new Set([...(a.hostEnhancementKind || []), ...(b.hostEnhancementKind || [])]),
  ].sort();
  if (hostEnhancementKind.length > 0 && !badges.includes('host-enhancement')) {
    badges.push('host-enhancement');
  }
  return {
    badges,
    rulesEstimatedTokens: Math.max(Number(a.rulesEstimatedTokens || 0), Number(b.rulesEstimatedTokens || 0)),
    mcpServers: [...new Set([...(a.mcpServers || []), ...(b.mcpServers || [])])].sort(),
    mcpRemoteDomains: [...new Set([...(a.mcpRemoteDomains || []), ...(b.mcpRemoteDomains || [])])].sort(),
    hookEvents: [...new Set([...(a.hookEvents || []), ...(b.hookEvents || [])])].sort(),
    hostEnhancementKind,
  };
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

function isSafeDirSlug(raw) {
  const s = String(raw || '').trim();
  return Boolean(s && s !== '.' && s !== '..' && !s.includes('/') && !s.includes('\\') && !s.includes('..'));
}

export async function createMarketSidecarServer(options = {}) {
  const configDir = resolveAntigravityConfigDir(options.configDir || '');
  const pluginsDir = resolvePluginsDir(configDir);
  const dataDir = resolveMarketDataDir(options.dataDir || '');
  const disabledPluginsDir = resolveDisabledPluginsDir(dataDir);
  const indexHtmlPath = options.indexHtmlPath || DEFAULT_INDEX_HTML_PATH;
  const fetchImpl = options.fetchImpl || fetch;
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
  const onSelfRestart =
    typeof options.onSelfRestart === 'function'
      ? options.onSelfRestart
      : () => {
          setTimeout(() => process.exit(1), 150).unref?.();
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

  // Sweep retired Windows binaries immediately on boot
  sweepRetiredBinaries(dataDir);

  // Schedule 8s boot crash-recovery check for `pending-journal.json`
  const recoveryDelayMs = options.recoveryDelayMs ?? 8000;
  let recoveryTimer = null;
  if (recoveryDelayMs >= 0) {
    recoveryTimer = setTimeout(() => {
      try {
        recoverInterruptedJournal({ dataDir, pluginsDir });
      } catch {
        /* non-fatal */
      }
    }, recoveryDelayMs);
    recoveryTimer.unref?.();
  }

  let prefs = loadPrefsFromDisk(dataDir);
  let lastCatalog = null;
  let updateCheckGeneration = 0;
  let inFlightUpdates = null; // { key, generation, promise }

  function invalidateUpdateCheckState() {
    updateCheckGeneration += 1;
    inFlightUpdates = null;
  }

  function hasLoadedReadmes(cat) {
    if (!cat) return false;
    return (
      Object.keys(cat.readmes || {}).length > 0 ||
      Object.keys(cat.readmesZh || {}).length > 0 ||
      Object.keys(cat.readmesEn || {}).length > 0
    );
  }

  async function ensureCatalogLoaded({ forceCatalogRefresh = false, includeReadmes = false } = {}) {
    if (!lastCatalog || forceCatalogRefresh || (includeReadmes && !hasLoadedReadmes(lastCatalog))) {
      lastCatalog = await resolveMarketCatalog({
        dataDir,
        prefs,
        forceRefresh: forceCatalogRefresh,
        includeReadmes,
        fetchImpl,
        mirrors,
      });
    }
    return lastCatalog;
  }

  function findCatalogCapabilitiesForDir(dirName) {
    const plugins = lastCatalog?.plugins || [];
    const matched = plugins.find(
      (p) => p.canonicalName === dirName || p.scopedName === dirName || p.id === dirName,
    );
    return matched?.capabilities || null;
  }

  async function buildEnrichedState({ forceCatalogRefresh = false, workspaceUris = [] } = {}) {
    await ensureCatalogLoaded({ forceCatalogRefresh, includeReadmes: false });

    const inventory = scanLocalPluginInventory({ configDir, dataDir, workspaceUris, linkInfoOverride });
    const updatesAvailable = [];
    const catalogPlugins = lastCatalog.plugins || [];

    // Enrich installed items with merged catalog capabilities & activation classification
    const catalogById = new Map();
    const catalogByDir = new Map();
    for (const cp of catalogPlugins) {
      if (cp?.id) catalogById.set(cp.id, cp);
      if (cp?.canonicalName) catalogByDir.set(cp.canonicalName, cp);
      if (cp?.scopedName) catalogByDir.set(cp.scopedName, cp);
    }

    const enrichedInstalled = inventory.installed.map((loc) => {
      const catMatch =
        (loc.receipt?.id && catalogById.get(loc.receipt.id)) ||
        catalogByDir.get(loc.dir) ||
        catalogByDir.get(loc.name) ||
        null;
      if (!catMatch?.capabilities) return loc;
      const mergedCaps = mergeCapabilitiesForActivation(loc.capabilities, catMatch.capabilities);
      return {
        ...loc,
        capabilities: mergedCaps,
        hostEnhancementKind: mergedCaps.hostEnhancementKind,
        activation: classifyActivationRequirement(mergedCaps),
      };
    });

    const enrichedInventory = { ...inventory, installed: enrichedInstalled };
    const conflictsReport = scanLocalConflicts({
      inventory: enrichedInventory,
      configDir,
      dataDir,
      workspaceUris,
      catalogPlugins,
    });

    const enrichedCatalogPlugins = catalogPlugins.map((p) => {
      const preflight = resolveInstallPreflight(p, enrichedInventory, { conflictStrategy: 'prompt' });
      const localMatch = preflight.action === 'update' ? preflight.existingInstall : null;
      const hasUpdate = Boolean(localMatch && isNewerVersion(p.version, localMatch.version));
      const escalation = localMatch ? computeCapabilityEscalation(localMatch.receipt, p) : null;
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
        activation: catalogActivation,
        installStatus: {
          installed: Boolean(localMatch),
          installedDir: localMatch?.dir || null,
          installedVersion: localMatch?.version || null,
          enabled: localMatch ? localMatch.enabled : false,
          parkedByMarket: localMatch ? Boolean(localMatch.parkedByMarket) : false,
          hostDisabled: localMatch ? Boolean(localMatch.hostDisabled) : false,
          canToggle: localMatch ? Boolean(localMatch.canToggle) : false,
          toggleDisabledReason: localMatch ? localMatch.toggleDisabledReason || '' : '',
          scope: localMatch?.scope || null,
          hasUpdate,
          customizationUri: localMatch?.customizationUri || null,
          sidecarPane: localMatch?.sidecarPane || null,
          conflictDetected: preflight.action === 'conflict-prompt',
          escalation,
          activation: localMatch?.activation || catalogActivation,
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
        channelUsed: lastCatalog.channelUsed,
        catalogVersion: lastCatalog.catalogVersion,
        generatedAt: lastCatalog.generatedAt,
        warnings: lastCatalog.warnings,
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
    const urlObj = new URL(req.url || '/', 'http://127.0.0.1');
    const pathname = urlObj.pathname;

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
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end(injectBootIntoHtml(rawHtml, generatedSideToken, convId));
      return;
    }

    if (req.method === 'GET' && pathname === '/api/state') {
      const refresh = urlObj.searchParams.get('refresh') === '1';
      const wsParam = urlObj.searchParams.get('workspaceUris') || '';
      const workspaceUris = wsParam ? wsParam.split(',').filter(Boolean) : [];
      const state = await buildEnrichedState({ forceCatalogRefresh: refresh, workspaceUris });
      sendJson(res, 200, state);
      return;
    }

    if (req.method === 'GET' && pathname === '/api/conflicts') {
      const wsParam = urlObj.searchParams.get('workspaceUris') || '';
      const workspaceUris = wsParam ? wsParam.split(',').filter(Boolean) : [];
      if (!lastCatalog) {
        await ensureCatalogLoaded({ forceCatalogRefresh: false, includeReadmes: false }).catch(() => null);
      }
      const inventory = scanLocalPluginInventory({ configDir, dataDir, workspaceUris, linkInfoOverride });
      const report = scanLocalConflicts({
        inventory,
        configDir,
        dataDir,
        workspaceUris,
        catalogPlugins: lastCatalog?.plugins || [],
      });
      sendJson(res, 200, report);
      return;
    }

    if (req.method === 'GET' && pathname === '/api/updates') {
      const force = urlObj.searchParams.get('force') === '1' || urlObj.searchParams.get('force') === 'true';
      const wsParam = urlObj.searchParams.get('workspaceUris') || '';
      const workspaceUris = wsParam ? wsParam.split(',').filter(Boolean) : [];
      const flightKey = `${force ? '1' : '0'}|${workspaceUris.join(',')}`;

      if (!force && inFlightUpdates && inFlightUpdates.key === flightKey && inFlightUpdates.generation === updateCheckGeneration) {
        const sharedReport = await inFlightUpdates.promise;
        sendJson(res, 200, sharedReport);
        return;
      }

      const generation = updateCheckGeneration;
      const runCheck = async () => {
        await ensureCatalogLoaded({ forceCatalogRefresh: force, includeReadmes: false });
        const inventory = scanLocalPluginInventory({ configDir, dataDir, workspaceUris, linkInfoOverride });
        return checkPluginUpdates({
          catalog: lastCatalog,
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
      if (!force) {
        inFlightUpdates = { key: flightKey, generation, promise };
      }
      try {
        const report = await promise;
        sendJson(res, 200, report);
      } finally {
        if (inFlightUpdates?.promise === promise) {
          inFlightUpdates = null;
        }
      }
      return;
    }

    if (req.method === 'GET' && pathname === '/api/discussions') {
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
      if (!lastCatalog) {
        await ensureCatalogLoaded({ forceCatalogRefresh: false, includeReadmes: false }).catch(() => null);
      }
      const inventory = scanLocalPluginInventory({ configDir, dataDir, workspaceUris, linkInfoOverride });
      const disc = await fetchPluginDiscussions({
        id: pluginId,
        catalog: lastCatalog || { plugins: [] },
        inventory,
        dataDir,
        prefs,
        force,
        fetchImpl,
        nowMs: nowFn(),
        githubApiBaseUrl,
      });
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

    if (req.method === 'GET' && pathname === '/api/readme') {
      const pluginId = String(urlObj.searchParams.get('id') || '').trim();
      const requestedDir = String(urlObj.searchParams.get('dir') || '').trim();
      const rawLocale = String(urlObj.searchParams.get('locale') || prefs.locale || 'zh')
        .trim()
        .toLowerCase();
      const locale = rawLocale.startsWith('en') ? 'en' : 'zh';

      if (!pluginId && !requestedDir) {
        sendJson(res, 400, { ok: false, error: 'Missing query parameter: id or dir' });
        return;
      }

      if (pluginId && !hasLoadedReadmes(lastCatalog)) {
        try {
          lastCatalog = await resolveMarketCatalog({
            dataDir,
            prefs,
            forceRefresh: false,
            includeReadmes: true,
            fetchImpl,
            mirrors,
          });
        } catch {
          /* continue with local fallback */
        }
      }

      // Resolve optional local plugin root (active or parked)
      let localPluginPath = '';
      let resolvedDir = '';
      if (isSafeDirSlug(requestedDir)) {
        const activeCand = join(pluginsDir, requestedDir);
        const parkedCand = join(disabledPluginsDir, requestedDir);
        if (existsSync(activeCand)) {
          localPluginPath = activeCand;
          resolvedDir = requestedDir;
        } else if (existsSync(parkedCand)) {
          localPluginPath = parkedCand;
          resolvedDir = requestedDir;
        }
      }
      if (!localPluginPath && pluginId) {
        const inv = scanLocalPluginInventory({ configDir, dataDir });
        const matched = inv.installed.find(
          (x) => x.receipt?.id === pluginId || x.dir === pluginId || x.name === pluginId,
        );
        if (matched) {
          localPluginPath = matched.path;
          resolvedDir = matched.dir;
        }
      }

      const catZh = pluginId ? String(lastCatalog?.readmesZh?.[pluginId] || '') : '';
      const catEn = pluginId ? String(lastCatalog?.readmesEn?.[pluginId] || '') : '';
      const catDefault = pluginId ? String(lastCatalog?.readmes?.[pluginId] || '') : '';

      const localZh = localPluginPath ? readFirstExistingReadme(localPluginPath, ZH_README_FILENAMES) : '';
      const localEn = localPluginPath ? readFirstExistingReadme(localPluginPath, EN_README_FILENAMES) : '';
      const localDefault = localPluginPath ? readFirstExistingReadme(localPluginPath, DEFAULT_README_FILENAMES) : '';

      let markdown = '';
      let isTranslatedOrNativeZh = false;

      if (locale === 'zh') {
        if (catZh.trim()) {
          markdown = catZh;
          isTranslatedOrNativeZh = true;
        } else if (localZh.trim()) {
          markdown = localZh;
          isTranslatedOrNativeZh = true;
        } else if (catDefault.trim() && CJK_CHAR_RE.test(catDefault)) {
          markdown = catDefault;
          isTranslatedOrNativeZh = true;
        } else if (localDefault.trim() && CJK_CHAR_RE.test(localDefault)) {
          markdown = localDefault;
          isTranslatedOrNativeZh = true;
        } else if (catDefault.trim()) {
          markdown = catDefault;
          isTranslatedOrNativeZh = false;
        } else if (catEn.trim()) {
          markdown = catEn;
          isTranslatedOrNativeZh = false;
        } else if (localDefault.trim()) {
          markdown = localDefault;
          isTranslatedOrNativeZh = CJK_CHAR_RE.test(localDefault);
        } else if (localEn.trim()) {
          markdown = localEn;
          isTranslatedOrNativeZh = false;
        }
      } else {
        if (catEn.trim()) {
          markdown = catEn;
          isTranslatedOrNativeZh = CJK_CHAR_RE.test(catEn);
        } else if (localEn.trim()) {
          markdown = localEn;
          isTranslatedOrNativeZh = CJK_CHAR_RE.test(localEn);
        } else if (catDefault.trim()) {
          markdown = catDefault;
          isTranslatedOrNativeZh = CJK_CHAR_RE.test(catDefault);
        } else if (localDefault.trim()) {
          markdown = localDefault;
          isTranslatedOrNativeZh = CJK_CHAR_RE.test(localDefault);
        } else if (catZh.trim()) {
          markdown = catZh;
          isTranslatedOrNativeZh = true;
        } else if (localZh.trim()) {
          markdown = localZh;
          isTranslatedOrNativeZh = true;
        }
      }

      sendJson(res, 200, {
        ok: true,
        id: pluginId || resolvedDir || requestedDir,
        dir: resolvedDir || requestedDir,
        locale,
        isTranslatedOrNativeZh,
        markdown,
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
        const state = await buildEnrichedState({
          forceCatalogRefresh: true,
          workspaceUris: Array.isArray(body.workspaceUris) ? body.workspaceUris : [],
        });
        sendJson(res, 200, state);
        return;
      }

      if (pathname === '/api/prefs' || pathname === '/api/sources') {
        const merged = { ...prefs, ...body };
        if (body.clearGithubToken === true) {
          merged.githubToken = '';
        } else if (!Object.prototype.hasOwnProperty.call(body, 'githubToken')) {
          merged.githubToken = prefs.githubToken || '';
        }
        if (!Object.prototype.hasOwnProperty.call(body, 'favorites')) {
          merged.favorites = Array.isArray(prefs.favorites) ? [...prefs.favorites] : [];
        }
        prefs = savePrefsToDisk(dataDir, merged);
        invalidateUpdateCheckState();
        const state = await buildEnrichedState({
          forceCatalogRefresh: true,
          workspaceUris: Array.isArray(body.workspaceUris) ? body.workspaceUris : [],
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
        const current = sanitizeFavorites(prefs.favorites);
        const exists = current.includes(key);
        const targetState = typeof body.favorite === 'boolean' ? body.favorite : !exists;
        let nextFavorites;
        if (targetState) {
          if (exists) {
            nextFavorites = current;
          } else {
            const trimmed = current.length >= MAX_FAVORITES ? current.slice(-(MAX_FAVORITES - 1)) : current;
            nextFavorites = [...trimmed, key];
          }
        } else {
          nextFavorites = current.filter((item) => item !== key);
        }
        prefs = savePrefsToDisk(dataDir, { ...prefs, favorites: nextFavorites });
        const persisted = prefs.favorites || [];
        sendJson(res, 200, {
          ok: true,
          key,
          isFavorite: persisted.includes(key),
          favorites: persisted,
        });
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
        if (!lastCatalog) {
          await buildEnrichedState({ forceCatalogRefresh: false });
        }
        const plugin = (lastCatalog?.plugins || []).find((p) => p.id === targetId);
        if (!plugin) {
          sendJson(res, 404, { ok: false, error: `Plugin "${targetId}" not found in active catalog` });
          return;
        }
        const inventory = scanLocalPluginInventory({
          configDir,
          dataDir,
          workspaceUris: Array.isArray(body.workspaceUris) ? body.workspaceUris : [],
        });
        const preflight = resolveInstallPreflight(plugin, inventory, {
          conflictStrategy: body.conflictStrategy || 'prompt',
        });
        const escalation = computeCapabilityEscalation(preflight.existingInstall?.receipt || null, plugin);
        sendJson(res, 200, { ok: true, preflight, escalation });
        return;
      }

      if (pathname === '/api/toggle-plugin') {
        const workspaceUris = Array.isArray(body.workspaceUris) ? body.workspaceUris : [];
        if (!lastCatalog) {
          await ensureCatalogLoaded({ forceCatalogRefresh: false, includeReadmes: false }).catch(() => null);
        }
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
        const conflicts = scanLocalConflicts({
          inventory: { ...freshInv, installed: state.installed },
          configDir,
          dataDir,
          workspaceUris,
          catalogPlugins: lastCatalog?.plugins || [],
        });
        sendJson(res, 200, {
          ...fixRes,
          conflicts,
          state,
        });
        return;
      }

      if (pathname === '/api/install' || pathname === '/api/update') {
        const targetId = String(body.id || '').trim();
        if (!lastCatalog) {
          await buildEnrichedState({ forceCatalogRefresh: false });
        }
        const plugin =
          body.plugin && typeof body.plugin === 'object'
            ? body.plugin
            : (lastCatalog?.plugins || []).find((p) => p.id === targetId);

        if (!plugin) {
          sendJson(res, 404, { ok: false, error: `Plugin "${targetId}" not found in active catalog` });
          return;
        }

        const result = await installOrUpdateCatalogPlugin({
          plugin,
          track: plugin._track || (plugin.forceScopedInstall ? 'unverified' : 'verified'),
          prefs,
          conflictStrategy: body.conflictStrategy || 'prompt',
          confirmEscalation: Boolean(body.confirmEscalation),
          configDir,
          dataDir,
          workspaceUris: Array.isArray(body.workspaceUris) ? body.workspaceUris : [],
          fetchImpl,
        });

        invalidateUpdateCheckState();
        const state = await buildEnrichedState({
          forceCatalogRefresh: false,
          workspaceUris: Array.isArray(body.workspaceUris) ? body.workspaceUris : [],
        });
        sendJson(res, 200, { ...result, state });

        if (result.ok && result.isSelfUpdate) {
          onSelfRestart();
        }
        return;
      }

      if (pathname === '/api/update-all') {
        const workspaceUris = Array.isArray(body.workspaceUris) ? body.workspaceUris : [];
        const confirmEscalation = Boolean(body.confirmEscalation);
        await ensureCatalogLoaded({ forceCatalogRefresh: false, includeReadmes: false });
        const inventory = scanLocalPluginInventory({ configDir, dataDir, workspaceUris, linkInfoOverride });
        const catalogPlugins = lastCatalog?.plugins || [];

        const queue = [];
        if (Array.isArray(body.ids)) {
          const seenReqIds = new Set();
          for (const rawId of body.ids) {
            const reqId = String(rawId || '').trim();
            if (!reqId || seenReqIds.has(reqId)) continue;
            seenReqIds.add(reqId);
            const plugin = catalogPlugins.find((p) => p.id === reqId || p.canonicalName === reqId) || null;
            if (!plugin) {
              queue.push({
                id: reqId,
                missing: true,
                isSelf: reqId === SELF_CATALOG_ID || reqId === PLUGIN_ID,
              });
              continue;
            }
            const preflight = resolveInstallPreflight(plugin, inventory, { conflictStrategy: 'prompt' });
            const localDir = preflight.existingInstall?.dir || plugin.canonicalName;
            const isSelf = isSelfPluginCandidate(plugin, localDir);
            if (!isCatalogPluginInstallable(plugin)) {
              queue.push({
                id: plugin.id,
                dir: localDir,
                plugin,
                notInstallable: true,
                isSelf,
              });
              continue;
            }
            queue.push({
              id: plugin.id,
              dir: localDir,
              plugin,
              isSelf,
            });
          }
        } else {
          for (const plugin of catalogPlugins) {
            if (!isCatalogPluginInstallable(plugin)) continue;
            const preflight = resolveInstallPreflight(plugin, inventory, { conflictStrategy: 'prompt' });
            const localMatch = preflight.action === 'update' ? preflight.existingInstall : null;
            if (!localMatch || !isNewerVersion(plugin.version, localMatch.version)) continue;
            queue.push({
              id: plugin.id,
              dir: localMatch.dir,
              plugin,
              isSelf: isSelfPluginCandidate(plugin, localMatch.dir),
            });
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

          const plugin = item.plugin;
          try {
            const out = await installOrUpdateCatalogPlugin({
              plugin,
              track: plugin._track || (plugin.forceScopedInstall ? 'unverified' : 'verified'),
              prefs,
              conflictStrategy: item.isSelf ? 'replace' : 'prompt',
              confirmEscalation,
              configDir,
              dataDir,
              workspaceUris,
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
        const workspaceUris = Array.isArray(body.workspaceUris) ? body.workspaceUris : [];
        const forceRefresh = Boolean(body.force);
        await ensureCatalogLoaded({ forceCatalogRefresh: forceRefresh, includeReadmes: false });
        let selfPlugin =
          (lastCatalog?.plugins || []).find((p) => p.id === SELF_CATALOG_ID || p.canonicalName === PLUGIN_ID) || null;

        if (!selfPlugin && !forceRefresh) {
          await ensureCatalogLoaded({ forceCatalogRefresh: true, includeReadmes: false });
          selfPlugin =
            (lastCatalog?.plugins || []).find((p) => p.id === SELF_CATALOG_ID || p.canonicalName === PLUGIN_ID) || null;
        }

        if (!selfPlugin) {
          sendJson(res, 404, {
            ok: false,
            status: 'NOT_FOUND',
            error: `Self plugin "${SELF_CATALOG_ID}" not found in active catalog`,
          });
          return;
        }

        if (!isCatalogPluginInstallable(selfPlugin)) {
          sendJson(res, 400, {
            ok: false,
            status: 'NOT_INSTALLABLE',
            error: `Self plugin "${selfPlugin.id}" lacks a verified catalog tarball/sha256`,
          });
          return;
        }

        const result = await installOrUpdateCatalogPlugin({
          plugin: selfPlugin,
          track: selfPlugin._track || 'verified',
          prefs,
          conflictStrategy: 'replace',
          confirmEscalation: Boolean(body.confirmEscalation),
          configDir,
          dataDir,
          workspaceUris,
          fetchImpl,
        });

        invalidateUpdateCheckState();
        const state = await buildEnrichedState({ forceCatalogRefresh: false, workspaceUris });
        const willRestart = Boolean(result.ok && result.isSelfUpdate);
        sendJson(res, 200, { ...result, willRestart, state }, willRestart ? () => onSelfRestart() : null);
        return;
      }

      if (pathname === '/api/remove-files') {
        const out = removeMarketPluginFiles({
          dir: body.dir,
          configDir,
          dataDir,
        });
        invalidateUpdateCheckState();
        const state = await buildEnrichedState({ forceCatalogRefresh: false });
        sendJson(res, 200, { ok: true, ...out, state });
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
          sendJson(res, 400, { ok: false, error: err?.message || String(err) });
        }
      });
    });

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
    const lowerHeaders = {};
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
        sendJson(res, 400, { ok: false, error: err?.message || String(err) });
      }
    }
    return donePromise;
  };

  return {
    server,
    port: actualPort,
    origin,
    sideToken: generatedSideToken,
    dataDir,
    configDir,
    inject,
    close,
  };
}
