// Localhost 127.0.0.1 Sidecar HTTP Router, X-Sidecar-Token CSRF Guard & State Persistence (`src/sidecar/server.mjs`).

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { installOrUpdateCatalogPlugin, removeMarketPluginFiles } from '../installer/index.mjs';
import { recoverInterruptedJournal } from '../installer/journal.mjs';
import { sweepRetiredBinaries } from '../installer/sync-dir.mjs';
import { resolveInstallPreflight, scanLocalPluginInventory } from '../preflight/index.mjs';
import { resolveMarketCatalog } from '../registry/index.mjs';
import {
  CUSTOMIZATION_URI,
  DEFAULT_PREFS,
  PLUGIN_DISPLAY_NAME,
  PLUGIN_ID,
  PLUGIN_VERSION,
  SIDECAR_URI,
} from '../shared/constants.mjs';
import { resolveAntigravityConfigDir, resolveMarketDataDir, resolvePluginsDir } from '../shared/paths.mjs';
import { computeCapabilityEscalation, sanitizePrefs } from '../shared/schemas.mjs';
import { isNewerVersion } from '../shared/semver.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');
const DEFAULT_INDEX_HTML_PATH = join(REPO_ROOT, 'sidecars', 'market_pane', 'index.html');
const MAX_JSON_BODY = 2 * 1024 * 1024;

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

  if (!window.sidecar) {
    window.sidecar = {
      conversationId: conversationId,
      fetch: secureFetch,
      getWorkspaceUris: function() { return Promise.resolve(workspaceUris.slice()); },
      onWorkspaceChange: function(fn) {
        if (typeof fn !== 'function') return function() {};
        wsListeners.add(fn);
        return function() { wsListeners.delete(fn); };
      }
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

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
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
  const tmpPath = join(dataDir, `prefs.json.${process.pid}.tmp`);
  const dstPath = join(dataDir, 'prefs.json');
  writeFileSync(tmpPath, `${JSON.stringify(clean, null, 2)}\n`, 'utf8');
  writeFileSync(dstPath, `${JSON.stringify(clean, null, 2)}\n`, 'utf8');
  rmSync(tmpPath, { force: true });
  return clean;
}

export async function createMarketSidecarServer(options = {}) {
  const configDir = resolveAntigravityConfigDir(options.configDir || '');
  const pluginsDir = resolvePluginsDir(configDir);
  const dataDir = resolveMarketDataDir(options.dataDir || '');
  const indexHtmlPath = options.indexHtmlPath || DEFAULT_INDEX_HTML_PATH;
  const fetchImpl = options.fetchImpl || fetch;
  const mirrors = options.mirrors || undefined;
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

  async function buildEnrichedState({ forceCatalogRefresh = false, workspaceUris = [] } = {}) {
    if (!lastCatalog || forceCatalogRefresh) {
      lastCatalog = await resolveMarketCatalog({
        dataDir,
        prefs,
        forceRefresh: forceCatalogRefresh,
        includeReadmes: false,
        fetchImpl,
        mirrors,
      });
    }

    const inventory = scanLocalPluginInventory({ configDir, workspaceUris });
    const updatesAvailable = [];

    const enrichedCatalogPlugins = lastCatalog.plugins.map((p) => {
      const preflight = resolveInstallPreflight(p, inventory, { conflictStrategy: 'prompt' });
      const localMatch = preflight.action === 'update' ? preflight.existingInstall : null;
      const hasUpdate = Boolean(localMatch && isNewerVersion(p.version, localMatch.version));
      const escalation = localMatch ? computeCapabilityEscalation(localMatch.receipt, p) : null;

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
        installStatus: {
          installed: Boolean(localMatch),
          installedDir: localMatch?.dir || null,
          installedVersion: localMatch?.version || null,
          enabled: localMatch ? localMatch.enabled : false,
          hasUpdate,
          customizationUri: localMatch?.customizationUri || null,
          sidecarPane: localMatch?.sidecarPane || null,
          conflictDetected: preflight.action === 'conflict-prompt',
          escalation,
        },
      };
    });

    return {
      ok: true,
      plugin: {
        id: PLUGIN_ID,
        displayName: PLUGIN_DISPLAY_NAME,
        version: PLUGIN_VERSION,
        sidecarUri: SIDECAR_URI,
        customizationUri: CUSTOMIZATION_URI,
      },
      prefs,
      catalog: {
        channelUsed: lastCatalog.channelUsed,
        catalogVersion: lastCatalog.catalogVersion,
        generatedAt: lastCatalog.generatedAt,
        warnings: lastCatalog.warnings,
        plugins: enrichedCatalogPlugins,
      },
      installed: inventory.installed,
      updatesAvailable,
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
      sendJson(res, 200, { ok: true, plugin: PLUGIN_ID, version: PLUGIN_VERSION });
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

    if (req.method === 'GET' && pathname === '/api/readme') {
      const pluginId = String(urlObj.searchParams.get('id') || '').trim();
      if (!pluginId) {
        sendJson(res, 400, { ok: false, error: 'Missing query parameter: id' });
        return;
      }
      let markdown = lastCatalog?.readmes?.[pluginId] || '';
      if (!markdown) {
        const withReadmes = await resolveMarketCatalog({
          dataDir,
          prefs,
          forceRefresh: false,
          includeReadmes: true,
          fetchImpl,
          mirrors,
        });
        lastCatalog = withReadmes;
        markdown = withReadmes.readmes?.[pluginId] || '';
      }
      sendJson(res, 200, { ok: true, id: pluginId, markdown });
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
        prefs = savePrefsToDisk(dataDir, { ...prefs, ...body });
        const state = await buildEnrichedState({
          forceCatalogRefresh: true,
          workspaceUris: Array.isArray(body.workspaceUris) ? body.workspaceUris : [],
        });
        sendJson(res, 200, state);
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
          workspaceUris: Array.isArray(body.workspaceUris) ? body.workspaceUris : [],
        });
        const preflight = resolveInstallPreflight(plugin, inventory, {
          conflictStrategy: body.conflictStrategy || 'prompt',
        });
        const escalation = computeCapabilityEscalation(preflight.existingInstall?.receipt || null, plugin);
        sendJson(res, 200, { ok: true, preflight, escalation });
        return;
      }

      if (pathname === '/api/install' || pathname === '/api/update') {
        const targetId = String(body.id || '').trim();
        if (!lastCatalog) {
          await buildEnrichedState({ forceCatalogRefresh: false });
        }
        const plugin = body.plugin && typeof body.plugin === 'object'
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

      if (pathname === '/api/remove-files') {
        const out = removeMarketPluginFiles({
          dir: body.dir,
          configDir,
          dataDir,
        });
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
      end(chunk) {
        if (ended) return;
        ended = true;
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
