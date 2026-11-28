import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';
import { gunzipSync } from 'node:zlib';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

const { bundleZeroDepEsm } = await import(pathToFileURL(join(REPO_ROOT, 'scripts', 'build.mjs')).href);
const {
  GZIP_MIN_BYTES,
  LOCAL_INVENTORY_CACHE_TTL_MS,
  PLUGIN_VERSION,
  PRIMARY_CATALOG_BASE_URL,
  PRIMARY_FETCH_TIMEOUT_MS,
  RAW_GH_PAGES_CATALOG_BASE_URL,
  UNVERIFIED_FETCH_TIMEOUT_MS,
} = await import(pathToFileURL(join(REPO_ROOT, 'src', 'shared', 'constants.mjs')).href);
const { resolveMarketCatalog } = await import(pathToFileURL(join(REPO_ROOT, 'src', 'registry', 'index.mjs')).href);
const { checkPluginUpdates } = await import(pathToFileURL(join(REPO_ROOT, 'src', 'updates', 'index.mjs')).href);
const { createDeterministicTarGz } = await import(
  pathToFileURL(join(REPO_ROOT, 'src', 'installer', 'tar-extract.mjs')).href
);
const { createMarketSidecarServer } = await import(pathToFileURL(join(REPO_ROOT, 'src', 'sidecar', 'server.mjs')).href);

function makeTempWorkspace(prefix = 'agy-v171-t2-') {
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

function makeCatalogPlugin(index, { track = 'verified', owner = 'acme', repoPrefix = 'plug' } = {}) {
  const slug = `${repoPrefix}-${index}`;
  return {
    id: `${owner}__${slug}`,
    canonicalName: slug,
    scopedName: `${owner}--${slug}`,
    forceScopedInstall: track === 'unverified',
    displayName: `Plugin ${index}`,
    description: { zh: `插件 ${index} 简介`, en: `Plugin ${index} description` },
    version: '1.0.0',
    gitTag: 'v1.0.0',
    commitSha: 'a'.repeat(40),
    repository: {
      url: `https://github.com/${owner}/${slug}`,
      repositoryId: 70000 + index,
      ownerId: 9000 + index,
      stars: 100 - (index % 50),
      pluginRoot: '.',
    },
    distribution: {
      tarballUrl: `https://github.com/${owner}/${slug}/archive/refs/tags/v1.0.0.tar.gz`,
      sha256: 'b'.repeat(64),
      sizeBytes: 1024,
      npmMirrorPkg: null,
      preservePaths: [],
    },
    media: { iconUrl: null, screenshots: [] },
    taxonomy: { categories: ['developer-tools'], tags: [], platforms: ['win32', 'darwin', 'linux'] },
    capabilities: {
      badges: ['declarative-only'],
      rulesEstimatedTokens: 0,
      mcpServers: [],
      mcpRemoteDomains: [],
      hookEvents: [],
      hostEnhancementKind: [],
    },
    updatedAt: '2026-11-26T00:00:00Z',
  };
}

function jsonResp(obj, status = 200, headers = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

function createInteractiveUiHarness() {
  const bundled = bundleZeroDepEsm(join(REPO_ROOT, 'src', 'ui', 'app.mjs'));
  const bootMarker = 'void loadState(false);\nvoid checkUpdates(false, { silent: true });';
  assert.ok(bundled.includes(bootMarker), 'Bundled app.mjs must contain auto-boot marker');

  const instrumented = bundled.replace(
    bootMarker,
    [
      'globalThis.__V171_UI__ = {',
      '  state,',
      '  loadState,',
      '  updatePrefs,',
      '  showToast,',
      '  render,',
      '  loadMorePlugins,',
      '  renderDiscoverView,',
      '  syncTrack2PillDom,',
      '  DISCOVER_PAGE_SIZE,',
      '};',
    ].join('\n'),
  );

  let rootHtml = '';
  let toastHtml = '';
  let renderCount = 0;
  let toastRenderCount = 0;
  let rootListenerCount = 0;
  const rootListeners = new Map();
  const toastListeners = new Map();
  const observerInstances = [];

  class MockElement {
    constructor(id = '', classListInit = []) {
      this.id = id;
      this.nodeType = 1;
      this.parentNode = null;
      this._attrs = new Map();
      this._classes = new Set(classListInit);
      this._innerHTML = '';
      this.disabled = false;
      this.checked = false;
      this.value = '';
      this.scrollTop = 0;
      this.scrollLeft = 0;
      this.textContent = '';
      this.isConnected = true;
      this.style = { setProperty() {} };
      this.classList = {
        toggle: (cls, force) => {
          const has = this._classes.has(cls);
          const next = force !== undefined ? Boolean(force) : !has;
          if (next) this._classes.add(cls);
          else this._classes.delete(cls);
          return next;
        },
        contains: (cls) => this._classes.has(cls),
      };
    }
    setAttribute(k, v) {
      const lk = String(k).toLowerCase();
      this._attrs.set(lk, String(v));
      if (lk === 'disabled') this.disabled = true;
    }
    removeAttribute(k) {
      const lk = String(k).toLowerCase();
      this._attrs.delete(lk);
      if (lk === 'disabled') this.disabled = false;
    }
    getAttribute(k) {
      const lk = String(k).toLowerCase();
      return this._attrs.has(lk) ? this._attrs.get(lk) : null;
    }
    hasAttribute(k) {
      return this._attrs.has(String(k).toLowerCase());
    }
    insertAdjacentHTML(_pos, html) {
      this._innerHTML += String(html || '');
    }
    remove() {
      this.isConnected = false;
    }
  }

  let currentPill = null;
  let currentCheckbox = null;
  let currentSavingText = null;
  let currentSentinel = null;
  let currentGrid = null;
  let currentLoadMoreWrap = null;
  const currentScrollEl = new MockElement('', ['main-scroll']);

  function syncParsedElementsFromHtml(html) {
    const pillMatch = /<label\s+class="([^"]*track2-pill[^"]*)"([^>]*)>/.exec(html);
    if (pillMatch) {
      currentPill = new MockElement('', pillMatch[1].split(/\s+/).filter(Boolean));
      const busyM = /aria-busy="([^"]*)"/.exec(pillMatch[2]);
      if (busyM) currentPill.setAttribute('aria-busy', busyM[1]);
      const cbMatch = /<input\s+id="track2-checkbox"([^>]*)>/.exec(html);
      currentCheckbox = new MockElement('track2-checkbox');
      if (cbMatch) {
        currentCheckbox.checked = /\bchecked\b/.test(cbMatch[1]);
        currentCheckbox.disabled = /\bdisabled\b/.test(cbMatch[1]);
        if (/\baria-disabled="true"/.test(cbMatch[1])) currentCheckbox.setAttribute('aria-disabled', 'true');
      }
      const icoWrap = new MockElement('', ['track2-ico']);
      currentSavingText = html.includes('track2-saving-text') ? new MockElement('', ['track2-saving-text']) : null;
      currentPill.querySelector = (sel) => {
        if (sel === '#track2-checkbox') return currentCheckbox;
        if (sel === '.track2-ico') return icoWrap;
        if (sel === '.track2-saving-text') return currentSavingText;
        return null;
      };
      currentPill.insertAdjacentHTML = (_pos, frag) => {
        if (String(frag).includes('track2-saving-text')) {
          currentSavingText = new MockElement('', ['track2-saving-text']);
          currentSavingText.textContent = 'Switching…';
        }
      };
      if (currentSavingText) {
        currentSavingText.remove = () => {
          currentSavingText = null;
        };
      }
    } else {
      currentPill = null;
      currentCheckbox = null;
      currentSavingText = null;
    }
    currentSentinel = html.includes('id="load-more-sentinel"') ? new MockElement('load-more-sentinel') : null;
    currentGrid = html.includes('id="discover-grid"') ? new MockElement('discover-grid') : null;
    if (currentGrid) {
      currentGrid.insertAdjacentHTML = (_pos, chunk) => {
        rootHtml += String(chunk || '');
      };
    }
    currentLoadMoreWrap = html.includes('id="load-more-wrap"') ? new MockElement('load-more-wrap') : null;
    if (currentLoadMoreWrap) {
      let outer = '';
      Object.defineProperty(currentLoadMoreWrap, 'outerHTML', {
        get: () => outer,
        set: (v) => {
          outer = String(v || '');
        },
      });
    }
  }

  const mockToastHost = {
    id: 'toast-host',
    className: 'toast-host',
    setAttribute() {},
    addEventListener(ev, fn) {
      if (!toastListeners.has(ev)) toastListeners.set(ev, []);
      toastListeners.get(ev).push(fn);
    },
    get innerHTML() {
      return toastHtml;
    },
    set innerHTML(val) {
      toastRenderCount += 1;
      toastHtml = String(val || '');
    },
  };

  const mockRoot = {
    id: 'app',
    parentNode: null,
    get innerHTML() {
      return rootHtml;
    },
    set innerHTML(val) {
      renderCount += 1;
      rootHtml = String(val || '');
      syncParsedElementsFromHtml(rootHtml);
    },
    addEventListener(ev, fn) {
      rootListenerCount += 1;
      if (!rootListeners.has(ev)) rootListeners.set(ev, []);
      rootListeners.get(ev).push(fn);
    },
    querySelector(sel) {
      if (sel === '.main-scroll') return currentScrollEl;
      if (sel === '.track2-pill') return currentPill;
      if (sel === '#track2-checkbox') return currentCheckbox;
      if (sel === '#load-more-sentinel') return currentSentinel;
      if (sel === '#discover-grid') return currentGrid;
      if (sel === '#load-more-wrap') return currentLoadMoreWrap;
      return null;
    },
    querySelectorAll() {
      return [];
    },
  };

  let fetchImpl = async () => jsonResp({ ok: true });
  const mockFetchFn = async (url, opts = {}) => fetchImpl(String(url), opts);
  const storageMap = new Map();
  let nextTimerId = 1;
  const scheduledTimers = new Map();

  class MockIntersectionObserver {
    constructor(cb, opts) {
      this.cb = cb;
      this.opts = opts;
      this.observed = [];
      observerInstances.push(this);
    }
    observe(target) {
      this.observed.push(target);
    }
    disconnect() {
      this.disconnected = true;
    }
    trigger(isIntersecting = true) {
      this.cb([{ isIntersecting, target: this.observed[0] || null }]);
    }
  }

  const mockWindow = {
    localStorage: {
      getItem: (k) => (storageMap.has(k) ? storageMap.get(k) : null),
      setItem: (k, v) => storageMap.set(k, String(v)),
      removeItem: (k) => storageMap.delete(k),
    },
    addEventListener: () => {},
    location: { reload: () => {}, origin: 'http://127.0.0.1:43210', search: '' },
    matchMedia: () => ({ matches: false, addEventListener: () => {} }),
    __SIDECAR_BOOT__: { token: 'test-token-v171' },
    sidecar: null,
    fetch: mockFetchFn,
  };

  const mockDocument = {
    getElementById: (id) => {
      if (id === 'app') return mockRoot;
      if (id === 'toast-host') return mockToastHost;
      if (id === 'track2-checkbox') return currentCheckbox;
      if (id === 'load-more-sentinel') return currentSentinel;
      if (id === 'discover-grid') return currentGrid;
      if (id === 'load-more-wrap') return currentLoadMoreWrap;
      return null;
    },
    querySelector: (sel) => mockRoot.querySelector(sel),
    querySelectorAll: () => [],
    activeElement: null,
    documentElement: { setAttribute: () => {}, classList: { toggle: () => {} } },
    body: { classList: { toggle: () => {} }, appendChild: () => {} },
    addEventListener: () => {},
  };

  const sandbox = {
    window: mockWindow,
    document: mockDocument,
    fetch: mockFetchFn,
    IntersectionObserver: MockIntersectionObserver,
    URL,
    URLSearchParams,
    Headers,
    Response,
    console,
    setTimeout: (fn, ms) => {
      const id = nextTimerId++;
      scheduledTimers.set(id, { fn, ms });
      return id;
    },
    clearTimeout: (id) => {
      scheduledTimers.delete(id);
    },
    requestAnimationFrame: (cb) => {
      cb();
      return 1;
    },
  };
  sandbox.globalThis = sandbox;
  sandbox.self = mockWindow;

  vm.runInNewContext(instrumented, sandbox, { filename: 'agy-market-v171-ui-test.js' });
  const ui = sandbox.__V171_UI__;
  assert.ok(ui, 'Instrumented UI harness must expose __V171_UI__');

  return {
    ui,
    bundled,
    mockRoot,
    mockToastHost,
    observerInstances,
    scheduledTimers,
    setFetchImpl(fn) {
      fetchImpl = fn;
    },
    getCounts() {
      return {
        renderCount,
        toastRenderCount,
        rootListenerCount,
        rootHtml,
        toastHtml,
        currentPill,
        currentCheckbox,
        currentSavingText,
      };
    },
    resetRenderCounts() {
      renderCount = 0;
      toastRenderCount = 0;
    },
  };
}

test('v1.7.1 Track 2 timeout & fallback: index.json OK + unverified timeout falls back to alternate URL then local cache with warnings and >4 plugins', async () => {
  assert.equal(PLUGIN_VERSION, '1.7.2');
  assert.equal(PRIMARY_FETCH_TIMEOUT_MS, 3500);
  assert.equal(UNVERIFIED_FETCH_TIMEOUT_MS, 20000);
  assert.equal(LOCAL_INVENTORY_CACHE_TTL_MS, 30000);
  assert.equal(GZIP_MIN_BYTES, 65536);

  const ws = makeTempWorkspace('agy-v171-t2-fb-');
  try {
    const verifiedPlugins = [makeCatalogPlugin(1), makeCatalogPlugin(2)];
    const track2Plugins = [
      makeCatalogPlugin(101, { track: 'unverified', owner: 'bob', repoPrefix: 't2' }),
      makeCatalogPlugin(102, { track: 'unverified', owner: 'bob', repoPrefix: 't2' }),
      makeCatalogPlugin(103, { track: 'unverified', owner: 'bob', repoPrefix: 't2' }),
      makeCatalogPlugin(104, { track: 'unverified', owner: 'bob', repoPrefix: 't2' }),
      makeCatalogPlugin(105, { track: 'unverified', owner: 'bob', repoPrefix: 't2' }),
    ];

    const primaryHits = [];
    const altHits = [];

    // Phase 1: Primary index.json OK, primary unverified-index.json times out -> falls back to alternate raw.githubusercontent.com URL
    const altFallbackRes = await resolveMarketCatalog({
      dataDir: ws.dataDir,
      prefs: { enableExperimentalTrack2: true, networkMode: 'auto' },
      fetchImpl: async (url) => {
        const u = String(url);
        if (u === `${PRIMARY_CATALOG_BASE_URL}/index.json`) {
          primaryHits.push(u);
          return jsonResp({ schemaVersion: 1, track: 'verified', catalogVersion: '2026.1126.1', plugins: verifiedPlugins });
        }
        if (u === `${PRIMARY_CATALOG_BASE_URL}/unverified-index.json`) {
          primaryHits.push(u);
          const err = new Error('The operation was aborted due to timeout');
          err.name = 'TimeoutError';
          throw err;
        }
        if (u === `${RAW_GH_PAGES_CATALOG_BASE_URL}/unverified-index.json`) {
          altHits.push(u);
          return jsonResp({
            schemaVersion: 1,
            track: 'unverified',
            catalogVersion: '2026.1126.1',
            plugins: track2Plugins,
          });
        }
        return jsonResp({ message: 'Not Found' }, 404);
      },
    });

    assert.equal(primaryHits.length, 2);
    assert.deepEqual(altHits, [`${RAW_GH_PAGES_CATALOG_BASE_URL}/unverified-index.json`]);
    assert.ok(altFallbackRes.plugins.length > 4, `Expected >4 plugins, got ${altFallbackRes.plugins.length}`);
    assert.equal(altFallbackRes.plugins.length, 7);
    assert.equal(altFallbackRes.plugins.filter((p) => p._track === 'unverified').length, 5);
    assert.ok(altFallbackRes.warnings.length > 0, 'Alternate fallback must emit a warning');
    assert.ok(
      altFallbackRes.warnings.some((w) => /alternate|备用源/i.test(w)),
      `Expected alternate warning, got: ${JSON.stringify(altFallbackRes.warnings)}`,
    );

    const diskT2Raw = readFileSync(join(ws.dataDir, 'cache', 'unverified-index.json'), 'utf8');
    assert.equal(diskT2Raw.includes('\n  '), false, 'Cached unverified-index.json must be compact (no indentation)');

    // Phase 2: Primary index.json still 200 OK, BOTH primary & alternate unverified-index.json time out, mirror returns 404 -> local cache fallback!
    const localCacheRes = await resolveMarketCatalog({
      dataDir: ws.dataDir,
      prefs: { enableExperimentalTrack2: true, networkMode: 'auto' },
      forceRefresh: true,
      mirrors: ['https://mirror.test.invalid/npm'],
      fetchImpl: async (url) => {
        const u = String(url);
        if (u === `${PRIMARY_CATALOG_BASE_URL}/index.json`) {
          return jsonResp({ schemaVersion: 1, track: 'verified', catalogVersion: '2026.1126.2', plugins: verifiedPlugins });
        }
        if (u.endsWith('/unverified-index.json')) {
          const err = new Error('The operation was aborted due to timeout');
          err.name = 'TimeoutError';
          throw err;
        }
        return jsonResp({ message: 'Not Found' }, 404);
      },
    });

    assert.ok(localCacheRes.plugins.length > 4, `Expected >4 plugins from local cache, got ${localCacheRes.plugins.length}`);
    assert.equal(localCacheRes.plugins.length, 7);
    assert.equal(localCacheRes.plugins.filter((p) => p._track === 'unverified').length, 5);
    assert.ok(
      localCacheRes.warnings.some((w) => /local cache|本地缓存/i.test(w)),
      `Expected local cache warning, got: ${JSON.stringify(localCacheRes.warnings)}`,
    );

    // Phase 3 (B2): china-mirror mode when npm mirror returns 404 gracefully falls back to GitHub sources without wiping Track 2 cache
    const mirrorTgz = createDeterministicTarGz({
      'package/dist/index.json': JSON.stringify({ schemaVersion: 1, track: 'verified', plugins: verifiedPlugins }),
    });
    const chinaRes = await resolveMarketCatalog({
      dataDir: ws.dataDir,
      prefs: { enableExperimentalTrack2: true, networkMode: 'china-mirror' },
      mirrors: ['https://mirror1.test.invalid', 'https://mirror2.test.invalid'],
      fetchImpl: async (url) => {
        const u = String(url);
        if (u === 'https://mirror1.test.invalid/pkg.tgz') {
          return new Response(mirrorTgz, { status: 200 });
        }
        if (u.startsWith('https://mirror1.test.invalid/')) {
          return jsonResp({ version: '1.0.0', dist: { tarball: 'https://mirror1.test.invalid/pkg.tgz' } });
        }
        if (u.startsWith('https://mirror2.test.invalid/')) {
          return jsonResp({ message: 'Not Found' }, 404);
        }
        if (u === `${PRIMARY_CATALOG_BASE_URL}/unverified-index.json`) {
          return jsonResp({ schemaVersion: 1, track: 'unverified', plugins: track2Plugins });
        }
        return jsonResp({ message: 'Not Found' }, 404);
      },
    });
    assert.equal(chinaRes.plugins.length, 7);
    assert.ok(chinaRes.warnings.some((w) => /Track 2/.test(w)));
  } finally {
    ws.cleanup();
  }
});

test('v1.7.1 POST /api/prefs does not force-refresh when cache fresh, and B3 generation guard prevents stale overwrite', async () => {
  const ws = makeTempWorkspace('agy-v171-prefs-race-');
  try {
    const verifiedPlugins = [makeCatalogPlugin(1), makeCatalogPlugin(2)];
    const track2Plugins = [
      makeCatalogPlugin(101, { track: 'unverified', owner: 'bob', repoPrefix: 't2' }),
      makeCatalogPlugin(102, { track: 'unverified', owner: 'bob', repoPrefix: 't2' }),
      makeCatalogPlugin(103, { track: 'unverified', owner: 'bob', repoPrefix: 't2' }),
      makeCatalogPlugin(104, { track: 'unverified', owner: 'bob', repoPrefix: 't2' }),
    ];

    let indexFetchCount = 0;
    let unverifiedFetchCount = 0;
    const unverifiedIfNoneMatchSeen = [];
    let holdVerifiedOnce = null;
    let releaseVerifiedOnce = null;
    let onHoldVerifiedEntered = null;

    const mockFetch = async (url, init = {}) => {
      const u = String(url);
      if (u === `${PRIMARY_CATALOG_BASE_URL}/index.json`) {
        indexFetchCount += 1;
        if (holdVerifiedOnce) {
          const p = holdVerifiedOnce;
          holdVerifiedOnce = null;
          onHoldVerifiedEntered?.();
          onHoldVerifiedEntered = null;
          await p;
        }
        return jsonResp(
          { schemaVersion: 1, track: 'verified', catalogVersion: '2026.1126.1', plugins: verifiedPlugins },
          200,
          { etag: '"v1-etag"' },
        );
      }
      if (u === `${PRIMARY_CATALOG_BASE_URL}/unverified-index.json`) {
        unverifiedFetchCount += 1;
        const inm = init?.headers?.['If-None-Match'] || init?.headers?.['if-none-match'] || '';
        unverifiedIfNoneMatchSeen.push(inm);
        if (inm === '"t2-etag"') {
          return new Response(null, { status: 304 });
        }
        return jsonResp(
          { schemaVersion: 1, track: 'unverified', catalogVersion: '2026.1126.1', plugins: track2Plugins },
          200,
          { etag: '"t2-etag"' },
        );
      }
      return jsonResp({ message: 'Not Found' }, 404);
    };

    // Seed Track 2 = false explicitly so this test exercises the Track-2-off -> Track-2-on transition
    writeFileSync(
      join(ws.dataDir, 'prefs.json'),
      `${JSON.stringify({ schemaVersion: 1, enableExperimentalTrack2: false }, null, 2)}\n`,
      'utf8',
    );

    const srv = await createMarketSidecarServer({
      listen: false,
      configDir: ws.configDir,
      dataDir: ws.dataDir,
      recoveryDelayMs: -1,
      fetchImpl: mockFetch,
    });

    try {
      const authHeaders = { 'X-Sidecar-Token': srv.sideToken, Origin: 'http://127.0.0.1:43210' };

      // 1. Cold boot GET /api/state loads verified catalog (Track 2 off)
      const st0 = await srv.inject({ method: 'GET', url: '/api/state' });
      assert.equal(st0.statusCode, 200);
      assert.equal(st0.json().catalog.plugins.length, 2);
      assert.equal(indexFetchCount, 1);
      assert.equal(unverifiedFetchCount, 0);

      // 2. Non-catalog pref update (locale) must NOT force-refresh catalog at all
      const prefLocale = await srv.inject({
        method: 'POST',
        url: '/api/prefs',
        headers: authHeaders,
        body: { locale: 'en' },
      });
      assert.equal(prefLocale.statusCode, 200);
      assert.equal(indexFetchCount, 1, 'Locale-only POST /api/prefs must NOT re-fetch index.json');
      assert.equal(unverifiedFetchCount, 0);

      // 3. First Track 2 enable without cache fetches unverified-index.json and caches ETag
      const prefT2On = await srv.inject({
        method: 'POST',
        url: '/api/prefs',
        headers: authHeaders,
        body: { enableExperimentalTrack2: true },
      });
      assert.equal(prefT2On.statusCode, 200);
      assert.equal(prefT2On.json().catalog.plugins.length, 6);
      assert.equal(unverifiedFetchCount, 1);
      assert.equal(unverifiedIfNoneMatchSeen[0], '');

      // 4. Disable Track 2, then re-enable Track 2 while cache is already present/fresh -> sends If-None-Match (not forceRefresh!)
      const prefT2Off = await srv.inject({
        method: 'POST',
        url: '/api/prefs',
        headers: authHeaders,
        body: { enableExperimentalTrack2: false },
      });
      assert.equal(prefT2Off.statusCode, 200);
      assert.equal(prefT2Off.json().catalog.plugins.length, 2);

      const prefT2ReOn = await srv.inject({
        method: 'POST',
        url: '/api/prefs',
        headers: authHeaders,
        body: { enableExperimentalTrack2: true },
      });
      assert.equal(prefT2ReOn.statusCode, 200);
      assert.equal(prefT2ReOn.json().catalog.plugins.length, 6);
      assert.equal(unverifiedFetchCount, 2);
      assert.equal(
        unverifiedIfNoneMatchSeen[1],
        '"t2-etag"',
        'POST /api/prefs must reuse conditional ETag cache instead of force-refreshing when local Track 2 cache exists',
      );

      // 5. Reset Track 2 off, then trigger slow Track-1-only `/api/updates?force=1` BEFORE fast `POST /api/prefs` { enableExperimentalTrack2: true }
      await srv.inject({
        method: 'POST',
        url: '/api/prefs',
        headers: authHeaders,
        body: { enableExperimentalTrack2: false },
      });

      const slowStartedPromise = new Promise((r) => {
        onHoldVerifiedEntered = r;
      });
      holdVerifiedOnce = new Promise((r) => {
        releaseVerifiedOnce = () => r();
      });

      const slowUpdatesReq = srv.inject({ method: 'GET', url: '/api/updates?force=1' });
      await slowStartedPromise;

      // Now switch Track 2 ON while slow Track-1 request is still blocked in flight
      const fastPrefsOn = await srv.inject({
        method: 'POST',
        url: '/api/prefs',
        headers: authHeaders,
        body: { enableExperimentalTrack2: true },
      });
      assert.equal(fastPrefsOn.statusCode, 200);
      assert.equal(fastPrefsOn.json().catalog.plugins.length, 6);

      // Now release the old slow Track-1-only request AFTER POST /api/prefs completed
      releaseVerifiedOnce();
      const slowUpdRes = await slowUpdatesReq;
      assert.equal(slowUpdRes.statusCode, 200);

      // Subsequent GET /api/state MUST STILL have all 6 Track 1 + Track 2 plugins (generation guard prevented overwrite)
      const afterRaceState = await srv.inject({ method: 'GET', url: '/api/state' });
      assert.equal(afterRaceState.statusCode, 200);
      assert.equal(
        afterRaceState.json().catalog.plugins.length,
        6,
        'Stale slow request resolving after POST /api/prefs must NOT overwrite lastCatalog',
      );
      assert.equal(afterRaceState.json().prefs.enableExperimentalTrack2, true);
    } finally {
      await srv.close();
    }
  } finally {
    ws.cleanup();
  }
});

test('v1.7.1 checkPluginUpdates bounded concurrency (=4) preserves deterministic ordering and rate-limit short-circuit', async () => {
  const ws = makeTempWorkspace('agy-v171-upd-conc-');
  try {
    const names = ['zeta-plug', 'alpha-plug', 'delta-plug', 'beta-plug', 'epsilon-plug', 'gamma-plug'];
    const delays = {
      'zeta-plug': 45,
      'alpha-plug': 10,
      'delta-plug': 35,
      'beta-plug': 15,
      'epsilon-plug': 5,
      'gamma-plug': 30,
    };

    const installed = [
      ...names.map((n, idx) => ({
        dir: n,
        name: n,
        displayName: n,
        version: '1.0.0',
        scope: 'global',
        enabled: true,
        hasDeclaredVersion: true,
        isGitManaged: false,
        repositoryUrl: `https://github.com/acme/${n}`,
        receipt: {
          id: `acme__${n}`,
          track: 'verified',
          repositoryId: 2000 + idx,
          installedDir: n,
          installedVersion: '1.0.0',
        },
      })),
      {
        dir: 'agy-market',
        name: 'agy-market',
        displayName: 'AGY Market',
        version: '1.0.0',
        scope: 'global',
        enabled: true,
        hasDeclaredVersion: true,
        isGitManaged: false,
        repositoryUrl: 'https://github.com/azwosile/agy-market',
        receipt: {
          id: 'azwosile__agy-market',
          track: 'verified',
          repositoryId: 1468650761,
          installedDir: 'agy-market',
          installedVersion: '1.0.0',
        },
      },
    ];

    let active = 0;
    let maxActive = 0;
    const res = await checkPluginUpdates({
      catalog: { plugins: [] },
      inventory: { installed },
      dataDir: ws.dataDir,
      force: true,
      fetchImpl: async (url) => {
        const u = String(url);
        const m = /https:\/\/api\.github\.com\/repos\/[^/]+\/([^/]+)\/releases\/latest/.exec(u);
        if (m) {
          const repo = m[1];
          active += 1;
          if (active > maxActive) maxActive = active;
          try {
            await new Promise((r) => setTimeout(r, delays[repo] || 20));
          } finally {
            active -= 1;
          }
          return jsonResp({
            tag_name: 'v1.2.0',
            html_url: `https://github.com/acme/${repo}/releases/tag/v1.2.0`,
            body: `Release notes for ${repo}`,
          });
        }
        return jsonResp({ message: 'Not Found' }, 404);
      },
    });

    assert.ok(maxActive >= 2 && maxActive <= 4, `Expected concurrency in 2..4, observed maxActive=${maxActive}`);
    assert.deepEqual(
      res.items.map((x) => x.id),
      [
        'acme__alpha-plug',
        'acme__beta-plug',
        'acme__delta-plug',
        'acme__epsilon-plug',
        'acme__gamma-plug',
        'acme__zeta-plug',
        'azwosile__agy-market',
      ],
    );
    assert.equal(res.items[res.items.length - 1].isSelf, true);
    assert.ok(res.selfUpdate && res.selfUpdate.latestVersion === '1.2.0');

    // Rate-limit first-probe gate prevents firing all 6 repos to api.github.com after first 403
    let apiCalls = 0;
    const rlWs = makeTempWorkspace('agy-v171-rl-');
    try {
      const rlRes = await checkPluginUpdates({
        catalog: { plugins: [] },
        inventory: { installed },
        dataDir: rlWs.dataDir,
        force: true,
        fetchImpl: async (url) => {
          const u = String(url);
          if (u.startsWith('https://api.github.com/')) {
            apiCalls += 1;
            return new Response(JSON.stringify({ message: 'API rate limit exceeded' }), {
              status: 403,
              headers: { 'Content-Type': 'application/json', 'X-RateLimit-Remaining': '0' },
            });
          }
          return new Response('', { status: 404 });
        },
      });
      assert.equal(rlRes.rateLimited, true);
      assert.equal(apiCalls, 1, `First-probe rate-limit gate must short-circuit api.github.com calls, saw ${apiCalls}`);
    } finally {
      rlWs.cleanup();
    }
  } finally {
    ws.cleanup();
  }
});

test('v1.7.1 gzip compression for >64KB JSON responses (inject + TCP loopback) and trimmed uninstalled payload', async () => {
  const ws = makeTempWorkspace('agy-v171-gzip-');
  try {
    const manyPlugins = Array.from({ length: 180 }, (_, i) => makeCatalogPlugin(i + 1));

    const srv = await createMarketSidecarServer({
      listen: true,
      configDir: ws.configDir,
      dataDir: ws.dataDir,
      recoveryDelayMs: -1,
      fetchImpl: async (url) => {
        if (String(url).endsWith('/index.json')) {
          return jsonResp({ schemaVersion: 1, track: 'verified', plugins: manyPlugins });
        }
        return jsonResp({ message: 'Not Found' }, 404);
      },
    });

    try {
      // 1. inject() with Accept-Encoding: gzip -> compressed
      const gzRes = await srv.inject({
        method: 'GET',
        url: '/api/state',
        headers: { 'Accept-Encoding': 'gzip, deflate' },
      });
      assert.equal(gzRes.statusCode, 200);
      assert.equal(gzRes.headers['content-encoding'], 'gzip');
      assert.equal(gzRes.headers.vary, 'Accept-Encoding');

      const decompressed = gunzipSync(gzRes.body).toString('utf8');
      assert.ok(Buffer.byteLength(decompressed, 'utf8') > GZIP_MIN_BYTES, 'Uncompressed payload must exceed 64KB');
      assert.ok(gzRes.body.length < Buffer.byteLength(decompressed, 'utf8'), 'Gzipped bytes must be smaller');

      const stateObj = JSON.parse(decompressed);
      assert.equal(stateObj.catalog.plugins.length, 180);
      // Verify P2 payload trim for non-installed plugin
      const samplePlug = stateObj.catalog.plugins[0];
      assert.ok(samplePlug.activation, 'Top-level activation must remain present');
      assert.deepEqual(samplePlug.installStatus, { installed: false, hasUpdate: false });

      // 2. inject() without Accept-Encoding -> uncompressed JSON
      const plainRes = await srv.inject({ method: 'GET', url: '/api/state' });
      assert.equal(plainRes.statusCode, 200);
      assert.equal(plainRes.headers['content-encoding'], undefined);
      assert.equal(plainRes.json().catalog.plugins.length, 180);

      // 3. inject() small response (<64KB) with Accept-Encoding: gzip -> uncompressed JSON
      const healthRes = await srv.inject({
        method: 'GET',
        url: '/healthz',
        headers: { 'Accept-Encoding': 'gzip' },
      });
      assert.equal(healthRes.statusCode, 200);
      assert.equal(healthRes.headers['content-encoding'], undefined);

      // 4. Real HTTP loopback request to verify Node ServerResponse end-to-end
      const httpData = await new Promise((resolveReq, rejectReq) => {
        const req = http.get(
          {
            hostname: '127.0.0.1',
            port: srv.port,
            path: '/api/state',
            headers: { 'Accept-Encoding': 'gzip' },
          },
          (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => {
              resolveReq({
                statusCode: res.statusCode,
                headers: res.headers,
                raw: Buffer.concat(chunks),
              });
            });
          },
        );
        req.on('error', rejectReq);
      });
      assert.equal(httpData.statusCode, 200);
      assert.equal(httpData.headers['content-encoding'], 'gzip');
      const parsedHttp = JSON.parse(gunzipSync(httpData.raw).toString('utf8'));
      assert.equal(parsedHttp.catalog.plugins.length, 180);
    } finally {
      await srv.close();
    }
  } finally {
    ws.cleanup();
  }
});

test('v1.7.1 UI static + VM verification: single delegation, 48-card paging/IO, decoupled #track2-checkbox, optimistic prefs, CSS content-visibility/no-blur, and no double render', async () => {
  const {
    ui,
    bundled,
    observerInstances,
    scheduledTimers,
    setFetchImpl,
    getCounts,
    resetRenderCounts,
  } = createInteractiveUiHarness();

  // 1. Static assertions on bundled JS & built HTML/CSS
  assert.doesNotMatch(
    bundled,
    /querySelectorAll\(\s*['"]\[data-action\]['"]\s*\)\s*\.forEach/,
    'Bundled UI must NOT attach per-render [data-action] addEventListener loops',
  );
  assert.match(bundled, /DISCOVER_PAGE_SIZE\s*=\s*48/, 'Bundled UI must define DISCOVER_PAGE_SIZE = 48');
  assert.match(bundled, /IntersectionObserver/, 'Bundled UI must use IntersectionObserver for incremental loading');
  assert.match(bundled, /bindDelegatedEvents/, 'Bundled UI must use bindDelegatedEvents');

  const builtHtml = readFileSync(join(REPO_ROOT, 'sidecars', 'market_pane', 'index.html'), 'utf8');
  assert.doesNotMatch(
    builtHtml,
    /querySelectorAll\(\s*['"]\[data-action\]['"]\s*\)\s*\.forEach/,
    'Built index.html must NOT contain per-render [data-action] addEventListener loop',
  );
  const pluginCardCssMatch = /\.plugin-card\s*\{([^}]*)\}/.exec(builtHtml);
  assert.ok(pluginCardCssMatch, 'Built HTML must define .plugin-card CSS rule');
  assert.doesNotMatch(pluginCardCssMatch[1], /backdrop-filter/i, '.plugin-card must NOT use backdrop-filter');
  assert.match(pluginCardCssMatch[1], /content-visibility\s*:\s*auto/i, '.plugin-card must set content-visibility: auto');
  assert.match(
    pluginCardCssMatch[1],
    /contain-intrinsic-size\s*:\s*auto\s+220px/i,
    '.plugin-card must set contain-intrinsic-size: auto 220px',
  );

  // 2. Prepare 120 plugins in state and verify incremental 48-card paging + IntersectionObserver
  const plugins120 = Array.from({ length: 120 }, (_, i) => ({
    ...makeCatalogPlugin(i + 1),
    installStatus: { installed: false, hasUpdate: false },
  }));

  ui.state.serverState = {
    plugin: { id: 'agy-market', version: PLUGIN_VERSION },
    prefs: { locale: 'en', favorites: [], enableExperimentalTrack2: false },
    catalog: { channelUsed: 'github-pages', catalogVersion: '2026.1126.1', warnings: [], plugins: plugins120 },
    installed: [],
    updatesAvailable: [],
    conflictsSummary: { total: 0, critical: 0 },
  };

  // U1: #track2-checkbox MUST NOT be disabled while background updates/loading are active
  ui.state.updates.loading = true;
  ui.state.loading = true;
  ui.render();

  const initialSnap = getCounts();
  assert.equal(initialSnap.rootListenerCount > 0, true, 'Root delegated listeners must be bound');
  const listenerCountAfterFirstRender = initialSnap.rootListenerCount;
  const renderedCards = (initialSnap.rootHtml.match(/<article class="plugin-card\b/g) || []).length;
  assert.equal(renderedCards, 48, `Initial Discover render must slice to 48 cards, got ${renderedCards}`);
  assert.match(initialSnap.rootHtml, /id="load-more-sentinel"/);
  assert.match(initialSnap.rootHtml, /data-action="load-more"/);
  assert.ok(observerInstances.length >= 1, 'IntersectionObserver must be created for #load-more-sentinel');
  assert.ok(initialSnap.currentCheckbox, '#track2-checkbox must exist in rendered DOM');
  assert.equal(
    initialSnap.currentCheckbox.disabled,
    false,
    '#track2-checkbox MUST NOT be disabled by state.updates.loading or state.loading',
  );

  // Triggering IntersectionObserver appends next 48 cards (48 -> 96) without rebinding root listeners
  observerInstances[observerInstances.length - 1].trigger(true);
  assert.equal(ui.state.visibleLimit, 96);
  assert.equal((getCounts().rootHtml.match(/<article class="plugin-card\b/g) || []).length, 96);
  assert.equal(getCounts().rootListenerCount, listenerCountAfterFirstRender, 'Root listeners must bind once only');

  ui.state.updates.loading = false;
  ui.state.loading = false;
  ui.render();

  // 3. Optimistic updatePrefs + single render() + no double render + toast zero render
  let resolvePrefsReq;
  setFetchImpl(
    () =>
      new Promise((r) => {
        resolvePrefsReq = r;
      }),
  );

  resetRenderCounts();
  const prefsPromise = ui.updatePrefs({ enableExperimentalTrack2: true });

  // Synchronously right after calling updatePrefs (while request is still in flight):
  assert.equal(
    ui.state.serverState.prefs.enableExperimentalTrack2,
    true,
    'updatePrefs must optimistically set enableExperimentalTrack2 immediately',
  );
  assert.equal(ui.state.loading, false, 'updatePrefs must NOT set global state.loading');
  assert.equal(ui.state.prefsSaving, true, 'updatePrefs must set state.prefsSaving = true while in flight');
  assert.equal(getCounts().currentCheckbox.disabled, true, '#track2-checkbox must disable during in-flight prefs save');
  assert.equal(getCounts().renderCount, 0, 'In-flight toggle must update .track2-pill in place without full render()');

  resolvePrefsReq(
    jsonResp({
      ok: true,
      plugin: { id: 'agy-market', version: PLUGIN_VERSION },
      prefs: { locale: 'en', favorites: [], enableExperimentalTrack2: true },
      catalog: { channelUsed: 'github-pages', catalogVersion: '2026.1126.1', warnings: [], plugins: plugins120 },
      installed: [],
      updatesAvailable: [],
      conflictsSummary: { total: 0, critical: 0 },
    }),
  );
  await prefsPromise;

  const afterPrefsCounts = getCounts();
  assert.equal(afterPrefsCounts.renderCount, 1, `Expected exactly 1 render() after updatePrefs, got ${afterPrefsCounts.renderCount}`);
  assert.equal(afterPrefsCounts.toastRenderCount >= 1, true, 'Toast must render into dedicated #toast-host');
  assert.equal(ui.state.prefsSaving, false);
  assert.equal(afterPrefsCounts.currentCheckbox.disabled, false);

  // Toast auto-dismiss timer must NOT trigger a full render()
  resetRenderCounts();
  for (const [, timer] of scheduledTimers.entries()) {
    timer.fn();
  }
  assert.equal(getCounts().renderCount, 0, 'Toast dismissal must NOT trigger full render()');
  assert.equal(getCounts().toastRenderCount >= 1, true, 'Toast dismissal must clear #toast-host');

  // 4. Optimistic rollback on updatePrefs rejection
  setFetchImpl(async () => jsonResp({ ok: false, error: 'Simulated save failure' }, 500));
  resetRenderCounts();
  await ui.updatePrefs({ enableExperimentalTrack2: false });
  assert.equal(
    ui.state.serverState.prefs.enableExperimentalTrack2,
    true,
    'Failed updatePrefs must roll back optimistic change',
  );
  assert.equal(ui.state.prefsSaving, false);
  assert.equal(getCounts().renderCount, 1, 'Failed updatePrefs must perform at most 1 render()');
  assert.match(getCounts().toastHtml, /tone-danger/, 'Failed updatePrefs must display danger toast in #toast-host');
});
