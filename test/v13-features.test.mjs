import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { Duplex } from 'node:stream';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

const {
  CAPABILITY_BADGE_SPECS,
  DEFAULT_PREFS,
  MAX_FAVORITES,
  SUBMIT_PLUGIN_GUIDE_URL,
  formatBadgeLabel,
} = await import(pathToFileURL(join(REPO_ROOT, 'src', 'shared', 'constants.mjs')).href);

const { sanitizeFavorites, sanitizePrefs, toPublicPrefs } = await import(
  pathToFileURL(join(REPO_ROOT, 'src', 'shared', 'schemas.mjs')).href
);

const {
  EphemeralCdpSession,
  buildHubOpenPaneExpression,
  normalizeOpenPaneRequest,
  openSiblingSidecarPane,
  selectHubTargets,
} = await import(pathToFileURL(join(REPO_ROOT, 'src', 'sidecar', 'open-pane.mjs')).href);

const { createMarketSidecarServer } = await import(
  pathToFileURL(join(REPO_ROOT, 'src', 'sidecar', 'server.mjs')).href
);

function makeTempWorkspace(prefix = 'agy-v13-test-') {
  const baseTmp = process.env.AGY_MARKET_TEST_TMPDIR || tmpdir();
  mkdirSync(baseTmp, { recursive: true });
  const root = mkdtempSync(join(baseTmp, prefix));
  const configDir = join(root, 'config');
  const pluginsDir = join(configDir, 'plugins');
  const dataDir = join(root, 'sidecar_data');
  mkdirSync(pluginsDir, { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  return {
    root,
    configDir,
    pluginsDir,
    dataDir,
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function makeEmptyCatalogFetch() {
  return async () =>
    new Response(
      JSON.stringify({
        schemaVersion: 1,
        catalogVersion: '1.3.0-test',
        generatedAt: '2026-11-24T00:00:00Z',
        plugins: [],
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
}

/** Minimal RFC-6455 unmasked server text frame encoder for mock CDP WebSocket tests. */
function encodeWsServerTextFrame(text) {
  const payload = Buffer.from(String(text), 'utf8');
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x81, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

/** Creates an in-memory bidirectional Duplex socket pair so RFC-6455 WS framing runs sandbox-free without TCP connect(). */
function createVirtualSocketPair() {
  let a;
  let b;
  a = new Duplex({
    read() {},
    write(chunk, _enc, cb) {
      b.push(Buffer.from(chunk));
      cb();
    },
    final(cb) {
      b.push(null);
      cb();
    },
  });
  b = new Duplex({
    read() {},
    write(chunk, _enc, cb) {
      a.push(Buffer.from(chunk));
      cb();
    },
    final(cb) {
      a.push(null);
      cb();
    },
  });
  return { clientSocket: a, serverSocket: b };
}

/** Creates a sandbox-safe mock CDP `/json/list` + RFC-6455 WebSocket harness backed by real `EphemeralCdpSession`. */
function createMockCdpHarness({ port = 9444, onEvaluate } = {}) {
  const listRequests = [];
  const evaluateCalls = [];
  let sawClientCloseFrame = false;

  const httpGetJsonImpl = async (host, reqPort, pathname) => {
    listRequests.push({ host, port: reqPort, pathname });
    assert.equal(host, '127.0.0.1');
    assert.equal(reqPort, port);
    assert.equal(pathname, '/json/list');
    return [
      {
        id: 'sidecar-iframe',
        type: 'page',
        title: 'AGY Market',
        url: 'plugin://abc123def456/',
        webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/sidecar-iframe`,
      },
      {
        id: 'hub-main',
        type: 'page',
        title: 'Antigravity',
        url: 'https://127.0.0.1:51234/',
        webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/hub-main`,
      },
      {
        id: 'devtools-window',
        type: 'page',
        title: 'DevTools',
        url: 'devtools://devtools/bundled/inspector.html',
        webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/devtools-window`,
      },
    ];
  };

  const wsConnectImpl = async (wsUrl) => {
    const parsed = new URL(wsUrl);
    const { clientSocket, serverSocket } = createVirtualSocketPair();
    let rx = Buffer.alloc(0);

    serverSocket.on('data', (chunk) => {
      rx = rx.length === 0 ? chunk : Buffer.concat([rx, chunk]);
      while (rx.length >= 2) {
        const b0 = rx[0];
        const b1 = rx[1];
        const opcode = b0 & 0x0f;
        const masked = (b1 & 0x80) !== 0;
        let len = b1 & 0x7f;
        let offset = 2;
        if (len === 126) {
          if (rx.length < 4) return;
          len = rx.readUInt16BE(2);
          offset = 4;
        } else if (len === 127) {
          if (rx.length < 10) return;
          len = Number(rx.readBigUInt64BE(2));
          offset = 10;
        }
        const maskLen = masked ? 4 : 0;
        if (rx.length < offset + maskLen + len) return;
        let payload = rx.subarray(offset + maskLen, offset + maskLen + len);
        if (masked) {
          const mask = rx.subarray(offset, offset + 4);
          const unmasked = Buffer.allocUnsafe(len);
          for (let i = 0; i < len; i += 1) unmasked[i] = payload[i] ^ mask[i & 3];
          payload = unmasked;
        }
        rx = rx.subarray(offset + maskLen + len);

        if (opcode === 0x08) {
          sawClientCloseFrame = true;
          serverSocket.end();
          return;
        }
        if (opcode === 0x01) {
          const msg = JSON.parse(payload.toString('utf8'));
          if (msg.method === 'Runtime.evaluate') {
            evaluateCalls.push({ wsPath: parsed.pathname, params: msg.params });
            Promise.resolve(
              typeof onEvaluate === 'function'
                ? onEvaluate(msg.params, parsed.pathname)
                : { opened: true, detail: 'aux-plus-plugins-menu' },
            ).then((value) => {
              serverSocket.write(
                encodeWsServerTextFrame(
                  JSON.stringify({
                    id: msg.id,
                    result: { result: { type: 'object', value } },
                  }),
                ),
              );
            });
          }
        }
      }
    });

    return new EphemeralCdpSession(clientSocket);
  };

  return {
    port,
    listRequests,
    evaluateCalls,
    get sawClientCloseFrame() {
      return sawClientCloseFrame;
    },
    httpGetJsonImpl,
    wsConnectImpl,
  };
}

test('v1.3 badge wording cleanup removes Sidecar 面板 & 0 Token and exports SUBMIT_PLUGIN_GUIDE_URL', () => {
  const sidecarSpec = CAPABILITY_BADGE_SPECS['sidecar-ui'];
  assert.equal(sidecarSpec.zh, 'Sidebar 侧边栏');
  assert.equal(sidecarSpec.en, 'Sidebar Panel');
  assert.equal(sidecarSpec.descZh, '在右侧 Sidebar 辅助栏提供可视化交互界面。');
  assert.equal(sidecarSpec.descEn, 'Provides a visual interactive panel in the right Sidebar.');

  const declSpec = CAPABILITY_BADGE_SPECS['declarative-only'];
  assert.equal(declSpec.zh, '纯声明式技能');
  assert.equal(declSpec.en, 'Declarative Skill');

  assert.equal(formatBadgeLabel('sidecar-ui', {}, 'zh'), 'Sidebar 侧边栏');
  assert.equal(formatBadgeLabel('sidecar-ui', {}, 'en'), 'Sidebar Panel');
  assert.equal(formatBadgeLabel('declarative-only', {}, 'zh'), '纯声明式技能');
  assert.equal(formatBadgeLabel('declarative-only', {}, 'en'), 'Declarative Skill');

  // Assert zero occurrences of "0 Token" / "零 Token" / "Sidecar 面板" across every badge spec & formatted label
  for (const [id, spec] of Object.entries(CAPABILITY_BADGE_SPECS)) {
    for (const text of [
      spec.zh,
      spec.en,
      spec.descZh,
      spec.descEn,
      formatBadgeLabel(id, {}, 'zh'),
      formatBadgeLabel(id, {}, 'en'),
    ]) {
      assert.doesNotMatch(text, /0\s*token|零\s*token|sidecar\s*面板/i, `Stale wording in badge "${id}": ${text}`);
    }
  }

  assert.equal(
    SUBMIT_PLUGIN_GUIDE_URL,
    'https://github.com/azwosile/agy-market-catalog/blob/main/docs/SUBMISSION_GUIDE.md',
  );
  assert.deepEqual(DEFAULT_PREFS.favorites, []);
});

test('favorites sanitization deduplicates, ignores invalid entries, and caps at MAX_FAVORITES (500)', () => {
  const raw = ['  alpha  ', '', '   ', null, 42, {}, 'local:beta', 'alpha', 'gamma'];
  assert.deepEqual(sanitizeFavorites(raw), ['alpha', 'local:beta', 'gamma']);

  const oversized = Array.from({ length: MAX_FAVORITES + 40 }, (_, i) => `plugin-${i}`);
  const capped = sanitizePrefs({ favorites: oversized }).favorites;
  assert.equal(capped.length, MAX_FAVORITES);
  assert.equal(capped[0], 'plugin-0');
  assert.equal(capped[MAX_FAVORITES - 1], `plugin-${MAX_FAVORITES - 1}`);

  const pub = toPublicPrefs({ favorites: ['azwosile__agy-market', 'local:my-tool'], githubToken: 'ghp_secret' });
  assert.deepEqual(pub.favorites, ['azwosile__agy-market', 'local:my-tool']);
  assert.equal(pub.githubToken, undefined);
  assert.equal(pub.hasGithubToken, true);
});

test('POST /api/favorites toggles/sets favorites, enforces CSRF, persists to prefs.json, and survives POST /api/prefs', async () => {
  const ws = makeTempWorkspace('agy-favorites-');
  try {
    const srv = await createMarketSidecarServer({
      listen: false,
      configDir: ws.configDir,
      dataDir: ws.dataDir,
      recoveryDelayMs: -1,
      fetchImpl: makeEmptyCatalogFetch(),
    });

    try {
      const authHeaders = { 'X-Sidecar-Token': srv.sideToken };

      // 1. CSRF rejection without token
      const unauth = await srv.inject({
        method: 'POST',
        url: '/api/favorites',
        body: { key: 'azwosile__agy-wallpaper-prism' },
      });
      assert.equal(unauth.statusCode, 403);
      assert.match(unauth.json().error, /ERR_CSRF_TOKEN/);

      // 2. Invalid empty key returns 400
      const badKey = await srv.inject({
        method: 'POST',
        url: '/api/favorites',
        headers: authHeaders,
        body: { key: '   ' },
      });
      assert.equal(badKey.statusCode, 400);
      assert.match(badKey.json().error, /ERR_INVALID_FAVORITE_KEY/);

      // 3. Toggle ON via { key }
      const add1 = await srv.inject({
        method: 'POST',
        url: '/api/favorites',
        headers: authHeaders,
        body: { key: 'azwosile__agy-wallpaper-prism' },
      });
      assert.equal(add1.statusCode, 200);
      assert.deepEqual(add1.json(), {
        ok: true,
        key: 'azwosile__agy-wallpaper-prism',
        isFavorite: true,
        favorites: ['azwosile__agy-wallpaper-prism'],
      });

      // 4. Explicit set favorite: true (idempotent) + second local plugin key
      const setIdempotent = await srv.inject({
        method: 'POST',
        url: '/api/favorites',
        headers: authHeaders,
        body: { key: 'azwosile__agy-wallpaper-prism', favorite: true },
      });
      assert.equal(setIdempotent.statusCode, 200);
      assert.deepEqual(setIdempotent.json().favorites, ['azwosile__agy-wallpaper-prism']);

      const addLocal = await srv.inject({
        method: 'POST',
        url: '/api/favorites',
        headers: authHeaders,
        body: { key: 'local:gemini-neko-cockpit', favorite: true },
      });
      assert.equal(addLocal.statusCode, 200);
      assert.deepEqual(addLocal.json(), {
        ok: true,
        key: 'local:gemini-neko-cockpit',
        isFavorite: true,
        favorites: ['azwosile__agy-wallpaper-prism', 'local:gemini-neko-cockpit'],
      });

      // 5. GET /api/state exposes prefs.favorites
      const st1 = await srv.inject({ method: 'GET', url: '/api/state' });
      assert.equal(st1.statusCode, 200);
      assert.deepEqual(st1.json().prefs.favorites, ['azwosile__agy-wallpaper-prism', 'local:gemini-neko-cockpit']);

      // 6. POST /api/prefs omitting favorites MUST preserve existing favorites
      const prefsKeep = await srv.inject({
        method: 'POST',
        url: '/api/prefs',
        headers: authHeaders,
        body: { locale: 'en', networkMode: 'direct' },
      });
      assert.equal(prefsKeep.statusCode, 200);
      assert.equal(prefsKeep.json().prefs.locale, 'en');
      assert.deepEqual(prefsKeep.json().prefs.favorites, ['azwosile__agy-wallpaper-prism', 'local:gemini-neko-cockpit']);

      // 7. Toggle OFF via { key }
      const toggleOff = await srv.inject({
        method: 'POST',
        url: '/api/favorites',
        headers: authHeaders,
        body: { key: 'azwosile__agy-wallpaper-prism' },
      });
      assert.equal(toggleOff.statusCode, 200);
      assert.deepEqual(toggleOff.json(), {
        ok: true,
        key: 'azwosile__agy-wallpaper-prism',
        isFavorite: false,
        favorites: ['local:gemini-neko-cockpit'],
      });

      // 8. POST /api/prefs explicitly providing favorites updates them
      const prefsUpdate = await srv.inject({
        method: 'POST',
        url: '/api/prefs',
        headers: authHeaders,
        body: { favorites: ['custom__one', 'local:gemini-neko-cockpit', 'custom__one'] },
      });
      assert.equal(prefsUpdate.statusCode, 200);
      assert.deepEqual(prefsUpdate.json().prefs.favorites, ['custom__one', 'local:gemini-neko-cockpit']);

      // Verify on-disk atomic prefs.json
      const prefsOnDisk = JSON.parse(readFileSync(join(ws.dataDir, 'prefs.json'), 'utf8'));
      assert.deepEqual(prefsOnDisk.favorites, ['custom__one', 'local:gemini-neko-cockpit']);
    } finally {
      await srv.close();
    }

    // 9. Verify persistence across fresh server boot
    const srv2 = await createMarketSidecarServer({
      listen: false,
      configDir: ws.configDir,
      dataDir: ws.dataDir,
      recoveryDelayMs: -1,
      fetchImpl: makeEmptyCatalogFetch(),
    });
    try {
      const st2 = await srv2.inject({ method: 'GET', url: '/api/state' });
      assert.deepEqual(st2.json().prefs.favorites, ['custom__one', 'local:gemini-neko-cockpit']);
    } finally {
      await srv2.close();
    }
  } finally {
    ws.cleanup();
  }
});

test('POST /api/open-pane enforces CSRF, opens via mocked CDP /json/list + RFC-6455 WS Hub opener, and gracefully falls back when closed', async () => {
  const ws = makeTempWorkspace('agy-open-pane-');
  const mockCdp = createMockCdpHarness({
    port: 9444,
    onEvaluate: (params, wsPath) => {
      assert.equal(wsPath, '/devtools/page/hub-main');
      assert.equal(params.returnByValue, true);
      assert.equal(params.awaitPromise, true);
      assert.match(params.expression, /aux-panel-plus-dropdown-trigger/);
      assert.match(params.expression, /plugins-submenu-trigger/);
      assert.match(params.expression, /plugins-submenu-item/);
      assert.match(params.expression, /agy-wallpaper-prism\/prism_studio/);
      return { opened: true, detail: 'aux-plus-plugins-menu', sidecarId: 'agy-wallpaper-prism/prism_studio' };
    },
  });

  try {
    // Write a temp DevToolsActivePort file pointing at our mock CDP port
    const activePortFile = join(ws.root, 'DevToolsActivePort');
    writeFileSync(activePortFile, `${mockCdp.port}\n/devtools/browser/mock-guid\n`, 'utf8');

    const srv = await createMarketSidecarServer({
      listen: false,
      configDir: ws.configDir,
      dataDir: ws.dataDir,
      recoveryDelayMs: -1,
      fetchImpl: makeEmptyCatalogFetch(),
      openPaneOptions: {
        devToolsActivePortFiles: [activePortFile],
        includeDefaultPort: false,
        timeoutMs: 1500,
        httpGetJsonImpl: mockCdp.httpGetJsonImpl,
        wsConnectImpl: mockCdp.wsConnectImpl,
      },
    });

    try {
      const authHeaders = { 'X-Sidecar-Token': srv.sideToken };

      // 1. CSRF 403 without token
      const noTok = await srv.inject({
        method: 'POST',
        url: '/api/open-pane',
        body: {
          dir: 'agy-wallpaper-prism',
          sidecarFolder: 'prism_studio',
          viewPath: '/',
          title: 'Wallpaper Prism',
        },
      });
      assert.equal(noTok.statusCode, 403);
      assert.match(noTok.json().error, /ERR_CSRF_TOKEN/);

      // 2. CSRF 403 with disallowed Origin
      const badOrigin = await srv.inject({
        method: 'POST',
        url: '/api/open-pane',
        headers: { ...authHeaders, Origin: 'https://evil.example' },
        body: { dir: 'agy-wallpaper-prism', sidecarFolder: 'prism_studio' },
      });
      assert.equal(badOrigin.statusCode, 403);
      assert.match(badOrigin.json().error, /ERR_CSRF_ORIGIN/);

      // 3. Invalid empty body -> 400
      const emptyReq = await srv.inject({
        method: 'POST',
        url: '/api/open-pane',
        headers: authHeaders,
        body: {},
      });
      assert.equal(emptyReq.statusCode, 400);
      assert.match(emptyReq.json().error, /ERR_OPEN_PANE_INVALID/);

      // 4. Valid request discovers DevToolsActivePort -> /json/list -> Hub WS Runtime.evaluate -> opened: true
      const okRes = await srv.inject({
        method: 'POST',
        url: '/api/open-pane',
        headers: authHeaders,
        body: {
          dir: 'agy-wallpaper-prism',
          sidecarFolder: 'prism_studio',
          viewPath: '/',
          title: 'Wallpaper Prism',
          uri: 'sidecar://agy-wallpaper-prism/prism_studio/',
        },
      });
      assert.equal(okRes.statusCode, 200);
      const data = okRes.json();
      assert.equal(data.ok, true);
      assert.equal(data.opened, true);
      assert.equal(data.method, 'cdp-hub');
      assert.deepEqual(data.preloadPayload, {
        tabType: 'sidecarView',
        uri: 'sidecar://agy-wallpaper-prism/prism_studio/',
      });
      assert.match(data.messageZh, /Wallpaper Prism/);
      assert.match(data.messageEn, /Wallpaper Prism/);
      assert.equal(mockCdp.listRequests.length, 1);
      assert.equal(mockCdp.evaluateCalls.length, 1);
      assert.equal(mockCdp.sawClientCloseFrame, true);
    } finally {
      await srv.close();
    }

    // 5. Graceful fallback when CDP port is closed / unreachable
    const srvFallback = await createMarketSidecarServer({
      listen: false,
      configDir: ws.configDir,
      dataDir: ws.dataDir,
      recoveryDelayMs: -1,
      fetchImpl: makeEmptyCatalogFetch(),
      openPaneOptions: {
        cdpPorts: [59339],
        timeoutMs: 500,
        httpGetJsonImpl: async () => {
          const err = new Error('connect ECONNREFUSED 127.0.0.1:59339');
          err.code = 'ECONNREFUSED';
          throw err;
        },
      },
    });
    try {
      const fbRes = await srvFallback.inject({
        method: 'POST',
        url: '/api/open-pane',
        headers: { 'X-Sidecar-Token': srvFallback.sideToken },
        body: {
          dir: 'gemini-neko-cockpit',
          sidecarFolder: 'neko-cockpit',
          viewPath: '/ui.html',
          title: '反重力观察窗',
        },
      });
      assert.equal(fbRes.statusCode, 200);
      const fb = fbRes.json();
      assert.equal(fb.ok, true);
      assert.equal(fb.opened, false);
      assert.equal(fb.method, 'preload-only');
      assert.deepEqual(fb.preloadPayload, {
        tabType: 'sidecarView',
        uri: 'sidecar://gemini-neko-cockpit/neko-cockpit/ui.html',
      });
      assert.match(fb.messageZh, /\+ → Plugins → 反重力观察窗/);
      assert.doesNotMatch(fb.messageZh, /复制/);
      assert.match(fb.messageEn, /Plugins/);
    } finally {
      await srvFallback.close();
    }
  } finally {
    ws.cleanup();
  }
});

test('open-pane helpers normalize payload, filter Hub targets, and click Aux Pane + -> Plugins -> item in DOM', async () => {
  const norm = normalizeOpenPaneRequest({
    dir: 'agy-wallpaper-prism',
    sidecarFolder: 'prism_studio',
    viewPath: 'index.html',
    title: 'Prism Studio',
  });
  assert.equal(norm.sidecarId, 'agy-wallpaper-prism/prism_studio');
  assert.equal(norm.uri, 'sidecar://agy-wallpaper-prism/prism_studio/index.html');
  assert.deepEqual(norm.preloadPayload, {
    tabType: 'sidecarView',
    uri: 'sidecar://agy-wallpaper-prism/prism_studio/index.html',
  });

  // Non-loopback WS targets must be filtered out for SSRF safety
  const targets = selectHubTargets([
    { type: 'page', title: 'Evil', url: 'https://127.0.0.1:443/', webSocketDebuggerUrl: 'ws://10.0.0.2:9222/x' },
    { type: 'page', title: 'Sidecar', url: 'plugin://abc/', webSocketDebuggerUrl: 'ws://127.0.0.1:9339/s' },
    { type: 'page', title: 'Antigravity', url: 'https://127.0.0.1:50000/', webSocketDebuggerUrl: 'ws://127.0.0.1:9339/h' },
  ]);
  assert.equal(targets.length, 1);
  assert.equal(targets[0].webSocketDebuggerUrl, 'ws://127.0.0.1:9339/h');

  // Verify buildHubOpenPaneExpression drives "+ -> Plugins -> item" in a simulated DOM
  const expr = buildHubOpenPaneExpression({
    sidecarId: 'agy-wallpaper-prism/prism_studio',
    sidecarFolder: 'prism_studio',
    dir: 'agy-wallpaper-prism',
    title: 'Wallpaper Prism',
    uri: 'sidecar://agy-wallpaper-prism/prism_studio/',
  });

  let pluginsMenuMounted = false;
  let submenuItemMounted = false;
  let itemClicked = false;

  const makeEl = (attrs, text, onClick) => ({
    textContent: text,
    getAttribute: (k) => (k in attrs ? attrs[k] : null),
    focus() {},
    dispatchEvent() {},
    click() {
      onClick?.();
    },
  });

  const plusBtn = makeEl({ 'data-testid': 'aux-panel-plus-dropdown-trigger' }, '+', () => {
    pluginsMenuMounted = true;
  });
  const pluginsTrigger = makeEl({ 'data-testid': 'plugins-submenu-trigger' }, 'Plugins', () => {
    submenuItemMounted = true;
  });
  const prismItem = makeEl(
    { 'data-testid': 'plugins-submenu-item', 'data-sidecar-id': 'agy-wallpaper-prism/prism_studio' },
    'Wallpaper Prism',
    () => {
      itemClicked = true;
    },
  );

  const fakeDoc = {
    querySelector(sel) {
      if (sel === '[data-testid="aux-panel-plus-dropdown-trigger"]') return plusBtn;
      if (sel === '[data-testid="plugins-submenu-trigger"]') return pluginsMenuMounted ? pluginsTrigger : null;
      return null;
    },
    querySelectorAll(sel) {
      if (sel === '[data-testid="plugins-submenu-item"]') return submenuItemMounted ? [prismItem] : [];
      return [];
    },
    dispatchEvent() {},
  };

  const sandbox = {
    document: fakeDoc,
    window: {},
    setTimeout,
    Date,
    Promise,
    MouseEvent: class MouseEvent {
      constructor(type, init) {
        this.type = type;
        Object.assign(this, init);
      }
    },
    KeyboardEvent: class KeyboardEvent {
      constructor(type, init) {
        this.type = type;
        Object.assign(this, init);
      }
    },
  };

  const domResult = await vm.runInNewContext(expr, sandbox);
  assert.equal(domResult.opened, true);
  assert.equal(domResult.detail, 'aux-plus-plugins-menu');
  assert.equal(itemClicked, true);

  // Verify direct openSiblingSidecarPane with closed default port (no mock) degrades cleanly
  const realClosedRes = await openSiblingSidecarPane(
    { dir: 'demo', sidecarFolder: 'pane', title: 'Demo' },
    { cdpPorts: [59339], timeoutMs: 300 },
  );
  assert.equal(realClosedRes.ok, true);
  assert.equal(realClosedRes.opened, false);
  assert.equal(realClosedRes.method, 'preload-only');
  assert.equal(realClosedRes.preloadPayload.tabType, 'sidecarView');
  assert.equal(realClosedRes.preloadPayload.uri, 'sidecar://demo/pane/');
});
