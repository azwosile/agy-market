import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash, createSign, generateKeyPairSync } from 'node:crypto';
import {
  cpSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import tls from 'node:tls';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';
import { createGzip, gzipSync } from 'node:zlib';
import { makeUiSandbox } from './helpers/ui-sandbox.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

const REPO_ROOT = resolve(__dirname, '..');

const { bundleZeroDepEsm } = await import(pathToFileURL(join(REPO_ROOT, 'scripts', 'build.mjs')).href);
const { MAX_TARBALL_BYTES, PLUGIN_VERSION } = await import(
  pathToFileURL(join(REPO_ROOT, 'src', 'shared', 'constants.mjs')).href
);
const { classifyActivationRequirement } = await import(
  pathToFileURL(join(REPO_ROOT, 'src', 'shared', 'activation.mjs')).href
);
const {
  createProxyAwareFetch,
  parseNoProxy,
  parseWindowsInternetSettingsOutput,
  parseWindowsProxyServer,
  resolveProxyUrlForTarget,
} = await import(pathToFileURL(join(REPO_ROOT, 'src', 'shared', 'proxy-fetch.mjs')).href);
const { scanLocalPluginInventory } = await import(
  pathToFileURL(join(REPO_ROOT, 'src', 'preflight', 'index.mjs')).href
);
const { checkPluginUpdates } = await import(
  pathToFileURL(join(REPO_ROOT, 'src', 'updates', 'index.mjs')).href
);
const { streamUrlToFileAndHash } = await import(
  pathToFileURL(join(REPO_ROOT, 'src', 'installer', 'fetch-tarball.mjs')).href
);
const {
  createDeterministicTarGz,
  extractTarGzStreamToDir,
  extractTarGzToDir,
  parseTarGzWithMeta,
} = await import(pathToFileURL(join(REPO_ROOT, 'src', 'installer', 'tar-extract.mjs')).href);
const { inspectGithubPluginUrl } = await import(
  pathToFileURL(join(REPO_ROOT, 'src', 'installer', 'github-url.mjs')).href
);
const { installOrUpdateCatalogPlugin } = await import(
  pathToFileURL(join(REPO_ROOT, 'src', 'installer', 'index.mjs')).href
);
const { createMarketSidecarServer } = await import(
  pathToFileURL(join(REPO_ROOT, 'src', 'sidecar', 'server.mjs')).href
);

const CLEAN_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><rect x="16" y="16" width="96" height="96" rx="20" fill="#6366f1"/></svg>';

function makeTempWorkspace(prefix = 'agy-v17-test-') {
  const baseTmp = process.env.AGY_MARKET_TEST_TMPDIR || tmpdir();
  mkdirSync(baseTmp, { recursive: true });
  const root = mkdtempSync(join(baseTmp, prefix));
  const configDir = join(root, 'config');
  const pluginsDir = join(configDir, 'plugins');
  const dataDir = join(root, 'sidecar_data');
  const artifactsDir = join(root, 'artifacts');
  mkdirSync(pluginsDir, { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(artifactsDir, { recursive: true });
  return {
    root,
    configDir,
    pluginsDir,
    dataDir,
    artifactsDir,
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function writePluginTree(parentDir, dirName, files) {
  const fullDir = join(parentDir, dirName);
  mkdirSync(fullDir, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(fullDir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    if (Buffer.isBuffer(content)) {
      writeFileSync(abs, content);
    } else {
      writeFileSync(abs, typeof content === 'string' ? content : `${JSON.stringify(content, null, 2)}\n`, 'utf8');
    }
  }
  return fullDir;
}

function jsonResp(obj, status = 200, headers = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

function binResp(buf, status = 200, headers = {}) {
  return new Response(buf, {
    status,
    headers: { 'Content-Type': 'application/gzip', ...headers },
  });
}

function buildGithubArchiveBuffer(filesObj, topDir = 'repo-v1') {
  const wrapped = {};
  for (const [rel, val] of Object.entries(filesObj)) {
    wrapped[`${topDir}/${rel}`] = val;
  }
  return createDeterministicTarGz(wrapped);
}

function makeCatalogPlugin({
  id,
  canonicalName,
  owner,
  repo,
  displayName,
  version,
  repoId,
  tarballUrl,
  sha256,
  sizeBytes = 512,
  preservePaths = [],
  badges = ['declarative-only'],
  hostEnhancementKind = [],
}) {
  return {
    id,
    canonicalName,
    scopedName: `${owner}--${canonicalName}`,
    forceScopedInstall: false,
    displayName,
    description: { zh: `${displayName} 中文简介`, en: `${displayName} description` },
    version,
    gitTag: `v${version}`,
    commitSha: 'a'.repeat(40),
    repository: {
      url: `https://github.com/${owner}/${repo}`,
      repositoryId: repoId,
      ownerId: 100 + repoId,
      stars: 42,
      pluginRoot: '.',
    },
    distribution: {
      tarballUrl,
      sha256,
      sizeBytes,
      npmMirrorPkg: null,
      preservePaths,
    },
    media: { iconUrl: null, screenshots: [] },
    taxonomy: { categories: ['developer-tools'], tags: [], platforms: ['win32', 'darwin', 'linux'] },
    capabilities: {
      badges,
      rulesEstimatedTokens: 0,
      mcpServers: [],
      mcpRemoteDomains: [],
      hookEvents: [],
      hostEnhancementKind,
    },
    updatedAt: '2026-11-26T12:00:00Z',
  };
}

// Pure-Node DER/X.509 v3 self-signed certificate builder (no external `openssl` binary needed)
function derLen(len) {
  if (len < 0x80) return Buffer.from([len]);
  const bytes = [];
  let n = len;
  while (n > 0) {
    bytes.unshift(n & 0xff);
    n >>= 8;
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}
function derTag(tag, content) {
  const buf = Buffer.isBuffer(content) ? content : Buffer.concat(content);
  return Buffer.concat([Buffer.from([tag]), derLen(buf.length), buf]);
}
function derSeq(...items) {
  return derTag(0x30, items);
}
function derSet(...items) {
  return derTag(0x31, items);
}
function derInt(val) {
  let buf = Buffer.isBuffer(val) ? val : Buffer.from([val]);
  if ((buf[0] & 0x80) !== 0) buf = Buffer.concat([Buffer.from([0x00]), buf]);
  return derTag(0x02, buf);
}
function derBitString(buf) {
  return derTag(0x03, Buffer.concat([Buffer.from([0x00]), buf]));
}
function derOctetString(buf) {
  return derTag(0x04, buf);
}
function derOid(oidStr) {
  const parts = oidStr.split('.').map(Number);
  const out = [parts[0] * 40 + parts[1]];
  for (let i = 2; i < parts.length; i++) {
    let v = parts[i];
    const seg = [v & 0x7f];
    while (v >= 0x80) {
      v >>= 7;
      seg.unshift((v & 0x7f) | 0x80);
    }
    out.push(...seg);
  }
  return derTag(0x06, Buffer.from(out));
}
function derUtf8(str) {
  return derTag(0x0c, Buffer.from(str, 'utf8'));
}
function derUtcTime(date) {
  const yy = String(date.getUTCFullYear() % 100).padStart(2, '0');
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(date.getUTCDate()).padStart(2, '0');
  const hh = String(date.getUTCHours()).padStart(2, '0');
  const mi = String(date.getUTCMinutes()).padStart(2, '0');
  const ss = String(date.getUTCSeconds()).padStart(2, '0');
  return derTag(0x17, Buffer.from(`${yy}${mm}${dd}${hh}${mi}${ss}Z`, 'ascii'));
}
function createSelfSignedCertForHost(dnsName) {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const spkiDer = publicKey.export({ type: 'spki', format: 'der' });
  const sigAlg = derSeq(derOid('1.2.840.113549.1.1.11'), Buffer.from([0x05, 0x00])); // sha256WithRSAEncryption
  const cnName = derSeq(derSet(derSeq(derOid('2.5.4.3'), derUtf8(dnsName))));
  const now = new Date();
  const notBefore = new Date(now.getTime() - 60_000);
  const notAfter = new Date(now.getTime() + 7 * 24 * 3600 * 1000);

  // BasicConstraints (CA=true) + SubjectAltName (dNSName)
  const basicConstraintsExt = derSeq(derOid('2.5.29.19'), Buffer.from([0x01, 0x01, 0xff]), derOctetString(derSeq(Buffer.from([0x01, 0x01, 0xff]))));
  const sanExt = derSeq(
    derOid('2.5.29.17'),
    derOctetString(derSeq(derTag(0x82, Buffer.from(dnsName, 'ascii')))),
  );
  const extensions = derTag(0xa3, derSeq(basicConstraintsExt, sanExt));

  const tbsCert = derSeq(
    derTag(0xa0, derInt(2)), // v3
    derInt(Buffer.from([0x12, 0x34, 0x56, 0x78])),
    sigAlg,
    cnName,
    derSeq(derUtcTime(notBefore), derUtcTime(notAfter)),
    cnName,
    spkiDer,
    extensions,
  );

  const signature = createSign('sha256').update(tbsCert).sign(privateKey);
  const certDer = derSeq(tbsCert, sigAlg, derBitString(signature));
  const certB64 = certDer.toString('base64').match(/.{1,64}/g).join('\n');
  const certPem = `-----BEGIN CERTIFICATE-----\n${certB64}\n-----END CERTIFICATE-----\n`;
  const keyPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  return { certPem, keyPem };
}

function makeUstarHeader(name, size, typeFlag = '0', linkName = '') {
  const h = Buffer.alloc(512, 0);
  h.write(name, 0, Math.min(100, Buffer.byteLength(name)), 'utf8');
  h.write('0000644\0', 100, 8, 'ascii');
  h.write('0000000\0', 108, 8, 'ascii');
  h.write('0000000\0', 116, 8, 'ascii');
  h.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 12, 'ascii');
  h.write('00000000000\0', 136, 12, 'ascii');
  h.fill(0x20, 148, 156);
  h.write(typeFlag, 156, 1, 'ascii');
  if (linkName) {
    h.write(linkName, 157, Math.min(100, Buffer.byteLength(linkName)), 'utf8');
  }
  h.write('ustar\0', 257, 6, 'ascii');
  h.write('00', 263, 2, 'ascii');
  let sum = 0;
  for (let i = 0; i < 512; i += 1) sum += h[i];
  h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  return h;
}

async function writeChunkSafe(stream, buf) {
  if (!stream.write(buf)) {
    await new Promise((res, rej) => {
      const onDrain = () => {
        stream.off('error', onErr);
        res();
      };
      const onErr = (err) => {
        stream.off('drain', onDrain);
        rej(err);
      };
      stream.once('drain', onDrain);
      stream.once('error', onErr);
    });
  }
}

async function buildLargeStreamingTarGz(outPath, { topDir = 'big-plugin-v1', payloadBytes, extraFiles = {} } = {}) {
  mkdirSync(dirname(outPath), { recursive: true });
  const gzip = createGzip({ level: 1 });
  const out = createWriteStream(outPath);
  const donePromise = new Promise((res, rej) => {
    out.once('finish', res);
    out.once('error', rej);
    gzip.once('error', rej);
  });
  gzip.pipe(out);

  for (const [rel, val] of Object.entries(extraFiles)) {
    const fullName = topDir ? `${topDir}/${rel}` : rel;
    const buf = Buffer.isBuffer(val) ? val : Buffer.from(String(val), 'utf8');
    await writeChunkSafe(gzip, makeUstarHeader(fullName, buf.length, '0'));
    await writeChunkSafe(gzip, buf);
    const rem = buf.length % 512;
    if (rem !== 0) await writeChunkSafe(gzip, Buffer.alloc(512 - rem, 0));
  }

  if (payloadBytes > 0) {
    const payloadName = topDir ? `${topDir}/assets/large-model.bin` : 'assets/large-model.bin';
    await writeChunkSafe(gzip, makeUstarHeader(payloadName, payloadBytes, '0'));
    const oneMb = Buffer.alloc(1024 * 1024, 0);
    let remaining = payloadBytes;
    while (remaining > 0) {
      const sliceLen = Math.min(oneMb.length, remaining);
      await writeChunkSafe(gzip, sliceLen === oneMb.length ? oneMb : oneMb.subarray(0, sliceLen));
      remaining -= sliceLen;
    }
    const rem = payloadBytes % 512;
    if (rem !== 0) await writeChunkSafe(gzip, Buffer.alloc(512 - rem, 0));
  }

  await writeChunkSafe(gzip, Buffer.alloc(1024, 0));
  gzip.end();
  await donePromise;
  const gzBytes = readFileSync(outPath);
  const sha256 = createHash('sha256').update(gzBytes).digest('hex');
  return { path: outPath, url: pathToFileURL(outPath).href, sha256, compressedSize: gzBytes.length };
}

function buildTarGzWithSymlink(filesObj, { topDir = 'sym-plugin', links = [] } = {}) {
  const chunks = [];
  for (const [rel, val] of Object.entries(filesObj)) {
    const fullName = topDir ? `${topDir}/${rel}` : rel;
    const buf = Buffer.isBuffer(val) ? val : Buffer.from(String(val), 'utf8');
    chunks.push(makeUstarHeader(fullName, buf.length, '0'));
    chunks.push(buf);
    const rem = buf.length % 512;
    if (rem !== 0) chunks.push(Buffer.alloc(512 - rem, 0));
  }
  for (const lk of links) {
    const fullName = topDir ? `${topDir}/${lk.name}` : lk.name;
    chunks.push(makeUstarHeader(fullName, 0, lk.type || '2', lk.target || ''));
  }
  chunks.push(Buffer.alloc(1024, 0));
  return gzipSync(Buffer.concat(chunks), { level: 6 });
}

function createUiVmHarness(mockFetchFn = async () => jsonResp({ ok: true })) {
  const bundled = bundleZeroDepEsm(join(REPO_ROOT, 'src', 'ui', 'app.mjs'));
  const bootMarker = 'void openMarketPanel();';
  assert.ok(bundled.includes(bootMarker), 'Bundled app.mjs must contain auto-boot marker');

  const instrumented = bundled.replace(
    bootMarker,
    [
      'globalThis.__V17_UI__ = {',
      '  state,',
      '  formatBytesCompact,',
      '  resolveActivationInfo,',
      '  maybeTriggerRestartBanner,',
      '  renderRestartBanner,',
      '  isLocalPluginUpdateManagedExternally,',
      '  isUpdateEffectiveForLocal,',
      '  renderInstalledCard,',
      '  renderDetailDrawer,',
      '  renderPluginCard, renderDiscoverView, renderFavoritesView, renderModals, getInstalledByDirMap, handleActionClick, applyServerState,',
      '  getFilteredPlugins, fitPanelToViewport, openMarketPanel, loadState, updatePrefs, renderDiscussTabContent,',
      '  triggerInstall, triggerUpdateAll, triggerSelfUpdate, triggerDirectPluginUpdate, triggerGithubUrlInstall,',
      '  getUpdateMaps,',
      '  getCatalogMaps,',
      '};',
    ].join('\n'),
  );

  const storageMap = new Map();
  const mockWindow = {
    localStorage: {
      getItem: (k) => (storageMap.has(k) ? storageMap.get(k) : null),
      setItem: (k, v) => storageMap.set(k, String(v)),
      removeItem: (k) => storageMap.delete(k),
    },
    addEventListener: () => {},
    location: { reload: () => {}, origin: 'http://127.0.0.1:43210', search: '' },
    matchMedia: () => ({ matches: false, addEventListener: () => {} }),
    __SIDECAR_BOOT__: { token: 'test-token-v17' },
    sidecar: null,
    fetch: mockFetchFn,
  };
  const sandbox = makeUiSandbox(mockWindow, mockFetchFn);
  vm.runInNewContext(instrumented, sandbox, { filename: 'agy-market-v17-ui-test.js' });
  return { ui: sandbox.__V17_UI__, bundled, mockWindow, sandbox };
}

function clickUiAction(ui, action, attrs = {}) {
  ui.handleActionClick({ getAttribute: key => key === 'data-action' ? action : attrs[key] }, { stopPropagation() {} });
}

test('panel fits the intersection of the host frame and zoomed viewport, then regains its full width', () => {
  const { ui, mockWindow, sandbox } = createUiVmHarness();
  const app = { style: {}, offsetWidth: 1000, getBoundingClientRect() {
    const width = this.offsetWidth * 1.25;
    return { left: 0, right: width, width };
  } };
  sandbox.document.getElementById = () => app;
  let onIntersection;
  let observing = false;
  sandbox.IntersectionObserver = class {
    constructor(callback) { onIntersection = callback; }
    observe(target) {
      if (!observing) onIntersection([{ isIntersecting: true, intersectionRect: target.getBoundingClientRect() }]);
      observing = true;
    }
    unobserve() { observing = false; }
  };
  let resizeFrame;
  mockWindow.addEventListener = (type, listener) => { if (type === 'resize') resizeFrame = listener; };
  const events = {};
  const viewport = mockWindow.visualViewport = {
    width: 1250, offsetLeft: 0, addEventListener(type, callback) { events[type] = callback; },
  };
  ui.fitPanelToViewport();
  const clip = (left, right) => onIntersection([{ isIntersecting: true, intersectionRect: { left, right } }]);
  clip(10, 1200);
  assert.deepEqual(app.style, { paddingLeft: '8px', paddingRight: '40px' });
  viewport.width = 900;
  viewport.offsetLeft = 50;
  events.scroll();
  assert.deepEqual(app.style, { paddingLeft: '40px', paddingRight: '240px' });
  viewport.width = 1250;
  viewport.offsetLeft = 0;
  events.resize();
  clip(0, 1250);
  assert.deepEqual(app.style, { paddingLeft: '0px', paddingRight: '0px' });
  app.offsetWidth = 1600;
  viewport.width = 2000;
  resizeFrame();
  events.resize();
  assert.equal(app.style.paddingRight, '0px');
});

test('a null catalog description renders and remains searchable in the pane and static showcase', async () => {
  const plugin = { id: 'acme__reader', canonicalName: 'reader', displayName: 'Reader', version: '1.0.0', description: null };
  const { ui } = createUiVmHarness();
  ui.state.loading = false;
  ui.applyServerState({ prefs: { locale: 'en' }, installed: [], catalog: { plugins: [plugin] } });
  for (const search of ['', 'reader']) {
    ui.state.search = search;
    assert.match(ui.renderDiscoverView(), /data-id="acme__reader"/);
  }
  const elements = new Map();
  const document = {
    querySelectorAll: () => [],
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, { value: '', options: [], handlers: {},
        addEventListener(event, fn) { this.handlers[event] = fn; } });
      return elements.get(id);
    },
  };
  document.getElementById('site-category').value = 'all';
  const sandbox = { document, fetch: async () => Response.json({ plugins: [null, plugin, { taxonomy: { categories: 7 } }] }) };
  const source = readFileSync(join(REPO_ROOT, 'site', 'app.js'), 'utf8');
  vm.runInNewContext(source.replace('void fetchCatalog();', 'globalThis.ready = fetchCatalog();'), sandbox);
  await sandbox.ready;
  assert.equal(document.getElementById('stat-total').textContent, '1 款');
  const search = document.getElementById('site-search');
  for (const term of ['', 'reader']) {
    search.value = term;
    search.handlers.input();
    assert.match(document.getElementById('site-grid').innerHTML, /Reader/);
  }
});

test('the opening update check waits for workspace and catalog revalidation and runs once', async () => {
  const requests = [];
  let finishOpening;
  const { ui, mockWindow } = createUiVmHarness(async url => {
    requests.push(new URL(url, 'http://localhost'));
    if (url.includes('panelOpen=1')) await new Promise(resolve => { finishOpening = resolve; });
    return jsonResp({ catalog: { plugins: [] }, installed: [] });
  });
  let resolveWorkspace;
  mockWindow.sidecar = { getWorkspaceUris: () => new Promise(resolve => { resolveWorkspace = resolve; }) };
  const opening = ui.openMarketPanel();
  assert.equal(requests.length, 0);
  resolveWorkspace(['file:///workspace A']);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(requests.map(url => url.pathname), ['/api/state']);
  finishOpening();
  await opening;
  mockWindow.sidecar = null;
  await ui.loadState(false);
  assert.deepEqual(requests.map(url => url.pathname), ['/api/state', '/api/updates', '/api/state']);
  const snapshots = requests.filter(url => url.pathname === '/api/state');
  assert.deepEqual(snapshots.map(url => url.searchParams.get('panelOpen')), ['1', null]);
  assert.ok(snapshots.every(url => url.searchParams.get('workspaceUris') === 'file:///workspace A'));
});

test('namesakes occupy their existing slots in author order without overriding explicit star order', () => {
  const { ui } = createUiVmHarness();
  const entry = (id, displayName, stars, author) => ({
    id, displayName, author, repository: { url: 'https://github.com/' + id.split('__')[0] + '/tools', stars },
  });
  const z = entry('acme__z', 'Reader', 90, { name: 'Zoe' });
  const other = entry('acme__x', 'Unrelated', 75);
  const a = entry('bob__reader', 'Reader', 50);
  ui.applyServerState({ prefs: { locale: 'en' }, installed: [], catalog: { plugins: [z, other, a] } });
  const order = () => Array.from(ui.getFilteredPlugins(), p => p.id);
  ui.state.sortBy = 'recommended';
  assert.deepEqual(order(), [a.id, other.id, z.id]);
  ui.state.sortBy = 'stars';
  assert.deepEqual(order(), [z.id, other.id, a.id]);
  ui.state.sortBy = 'name';
  assert.deepEqual(order(), [a.id, z.id, other.id]);
  a.author = 'Zoe';
  a.repository = { ...z.repository, pluginRoot: 'b' };
  z.repository.pluginRoot = 'a';
  assert.deepEqual(order(), [z.id, a.id, other.id]);
});

test('saving new credentials hides old discussions immediately and drops late replies', async () => {
  const plugin = { id: 'team__reader', canonicalName: 'reader', repository: { url: 'https://github.com/team/reader' } };
  const snapshot = { prefs: { locale: 'en' }, installed: [], catalog: { plugins: [plugin] } };
  const oldReply = Promise.withResolvers();
  const prefsSave = Promise.withResolvers();
  let fetchCount = 0;
  const { ui } = createUiVmHarness(async url => {
    if (url === '/api/prefs') { await prefsSave.promise; return jsonResp(snapshot); }
    if (url.startsWith('/api/discussions?')) {
      fetchCount++;
      const title = fetchCount <= 2 ? 'Private title from A' : fetchCount === 3 ? 'Visible to B' : 'Visible after another panel switched';
      if (fetchCount === 2) await oldReply.promise;
      return jsonResp({ items: [{ title, url: plugin.repository.url + '/discussions/1' }] });
    }
    return jsonResp({ ok: true });
  });
  const settle = () => new Promise(resolve => setImmediate(resolve));
  const view = () => ui.renderDiscussTabContent(ui.state.detailPlugin);
  ui.applyServerState(snapshot);
  clickUiAction(ui, 'detail', { 'data-id': plugin.id, 'data-detail-tab': 'discuss' });
  await settle();
  assert.match(view(), /Private title from A/);
  clickUiAction(ui, 'refresh-discussions', { 'data-id': plugin.id });
  const save = ui.updatePrefs({ githubToken: 'fixture-account-B' });
  assert.doesNotMatch(view(), /Private title from A/);
  prefsSave.resolve();
  await save;
  await settle();
  oldReply.resolve();
  await settle();
  assert.equal(fetchCount, 3);
  assert.match(view(), /Visible to B/);
  assert.doesNotMatch(view(), /Private title from A/);
  clickUiAction(ui, 'close-modal');
  clickUiAction(ui, 'detail', { 'data-id': plugin.id, 'data-detail-tab': 'discuss' });
  await settle();
  assert.equal(fetchCount, 4);
  assert.match(view(), /Visible after another panel switched/);
  assert.doesNotMatch(view(), /Visible to B/);
});

test('switching catalog source with a reused ID refreshes the open detail and its discussion links', async () => {
  const plugin = repo => ({ id: 'team__reader', canonicalName: 'reader', displayName: repo,
    repository: { url: 'https://github.com/team/' + repo } });
  let current = plugin('original');
  const snapshot = () => ({ prefs: { locale: 'en' }, installed: [], catalog: { plugins: [current] } });
  let releaseOld;
  let discussions = 0;
  const { ui } = createUiVmHarness(async url => {
    if (url === '/api/sources') return jsonResp(snapshot());
    if (url.startsWith('/api/readme?')) return jsonResp({ markdown: 'README ' + current.displayName });
    if (url.startsWith('/api/discussions?')) {
      discussions++;
      const target = current.repository.url + '/discussions';
      if (current.displayName === 'original') await new Promise(resolve => { releaseOld = resolve; });
      return jsonResp({ url: target, newDiscussionUrl: target + '/new/choose', items: [] });
    }
    throw new Error('Unexpected URL ' + url);
  });
  ui.applyServerState(snapshot());
  clickUiAction(ui, 'detail', { 'data-id': current.id, 'data-detail-tab': 'discuss' });
  current = plugin('replacement');
  await ui.updatePrefs({ customFeeds: ['https://catalog.example/index.json'] }, '', new Map());
  releaseOld();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(discussions, 2);
  assert.equal(ui.state.detailReadme, 'README replacement');
  const discussion = ui.renderDiscussTabContent(ui.state.detailPlugin);
  assert.match(discussion, /replacement\/discussions\/new\/choose/);
  assert.doesNotMatch(discussion, /original\/discussions/);
  clickUiAction(ui, 'close-modal');
  clickUiAction(ui, 'detail', { 'data-id': current.id, 'data-detail-tab': 'discuss' });
  assert.equal(discussions, 3);
});

test('snapshot versions are compact on cards and retain the full version in details and copy actions', () => {
  const { ui } = createUiVmHarness();
  const version = '1.0.0-git.20261123131750.d0f0741';
  const plugin = { id: 'demo__reader', displayName: 'Reader', canonicalName: 'reader', version };
  const loc = { scope: 'global', dir: 'reader', name: 'reader', version };
  ui.applyServerState({ prefs: { locale: 'en' }, installed: [loc], catalog: { plugins: [plugin] } });
  for (const card of [ui.renderPluginCard(plugin, new Map(), new Map()), ui.renderInstalledCard(loc, new Map(), new Map(), new Map(), new Map())]) {
    assert.ok(card.includes(`title="v${version}">v1.0.0 · git</span>`));
  }
  assert.match(ui.renderPluginCard({ ...plugin, version: '2.1.0-beta.2' }, new Map(), new Map()), />v2\.1\.0-beta\.2<\/span>/);
  ui.state.detailPlugin = plugin;
  const drawer = ui.renderDetailDrawer();
  assert.ok(drawer.includes(`data-copy-val="${version}"`));
  assert.ok(drawer.includes(`>v${version}</span>`));
});

test('a catalog favorite remains a bookmark when its id points to another repository', () => {
  const { ui } = createUiVmHarness();
  const key = 'demo__reader';
  const original = { displayName: 'Original Reader', repositoryUrl: 'https://github.com/demo/original', pluginRoot: 'plugin' };
  ui.applyServerState({ prefs: { locale: 'en', favorites: [key], favoriteSources: { [key]: original } }, installed: [],
    catalog: { plugins: [{ id: key, displayName: 'Different Reader', canonicalName: 'reader', version: '1.0.0',
      repository: { url: 'https://github.com/demo/different', pluginRoot: 'plugin' } }] } });
  const view = ui.renderFavoritesView();
  assert.match(view, /Original Reader/);
  assert.doesNotMatch(view, /Different Reader|data-action="install"/);
});

test('the workspace favorite card retains its selected copy without exposing global mutations', () => {
  const { ui } = createUiVmHarness();
  const global = { scope: 'global', dir: 'reader', name: 'reader', path: '/global/reader', favoriteKey: 'copy:global',
    version: '1.0.0', displayName: 'Global Reader', enabled: true };
  const workspace = { ...global, scope: 'workspace', path: '/workspace/reader', displayName: 'Workspace Reader',
    favoriteKey: 'copy:workspace', canToggle: false, canUninstall: false };
  ui.applyServerState({ prefs: { favorites: [workspace.favoriteKey] }, catalog: { plugins: [] }, installed: [global, workspace] });
  const view = ui.renderFavoritesView();
  assert.match(view, /Workspace Reader/);
  assert.match(view, /data-scope="workspace" data-path="\/workspace\/reader"/);
  assert.doesNotMatch(view, /Global Reader|data-action="prompt-uninstall"/);
  assert.match(view, /data-action="toggle-plugin"[^>]+disabled/);
});

test('inferred repositories have no update action before the first check', () => {
  const { ui } = createUiVmHarness();
  const local = { scope: 'global', name: 'reader', dir: 'reader', path: '/global/reader', version: '1.0.0',
    repositoryUrl: 'https://github.com/team/reader', inferredRepository: true };
  ui.applyServerState({ prefs: { locale: 'en' }, installed: [local], catalog: { plugins: [] } });
  const card = ui.renderInstalledCard(local, new Map(), new Map(), new Map(), new Map());
  clickUiAction(ui, 'detail-local', { 'data-dir': local.dir, 'data-scope': local.scope, 'data-path': local.path });
  for (const html of [card, ui.renderDetailDrawer()]) {
    assert.match(html, /No verified update source declared/);
    assert.doesNotMatch(html, /data-action="(?:sync-installed-plugin|update-plugin-direct|install)"/);
  }
});

test('local detail and uninstall keep a manual plugin separate from an unrelated catalog slug', async () => {
  const requests = [];
  const { ui } = createUiVmHarness(async (url, opts) => {
    requests.push({ url, body: opts.body && JSON.parse(opts.body) });
    return jsonResp({ ok: true });
  });
  const local = { scope: 'global', dir: 'notes', name: 'notes', path: '/fixture/plugins/notes', displayName: 'My Notes',
    version: '2.0.0', repositoryUrl: 'https://github.com/me/notes' };
  const other = { id: 'other__notes', canonicalName: 'notes', displayName: 'Other Notes',
    repository: { url: 'https://github.com/other/notes' }, installStatus: { installed: false, conflictDetected: true } };
  const snapshot = { prefs: { locale: 'en' }, installed: [local], catalog: { plugins: [other] } };
  ui.state.loading = false;
  ui.applyServerState(snapshot);
  clickUiAction(ui, 'detail-local', { 'data-dir': local.dir, 'data-scope': local.scope, 'data-path': local.path });
  ui.applyServerState(snapshot);
  const drawer = ui.renderDetailDrawer();
  assert.match(drawer, /data-action="prompt-uninstall" data-dir="notes" data-name="My Notes"/);
  assert.doesNotMatch(drawer, /Other Notes|github\.com\/other\/notes/);
  assert.equal(new URL(requests[0].url, 'http://localhost').searchParams.get('scope'), 'global');
  clickUiAction(ui, 'prompt-uninstall', { 'data-dir': 'notes', 'data-name': 'stale display label' });
  assert.match(ui.renderModals(), /permanently uninstalls.*My Notes/);
  clickUiAction(ui, 'confirm-uninstall', { 'data-dir': local.dir });
  assert.deepEqual(requests.find(req => req.url === '/api/uninstall').body.expectedInstall,
    { parked: false, name: 'notes', id: '', repositoryUrl: local.repositoryUrl });
  // A catalog ID reused by a different source must not override the server's identity match.
  local.receipt = { id: other.id, repositoryId: 11 };
  local.catalogId = null;
  clickUiAction(ui, 'detail-local', { 'data-dir': local.dir, 'data-scope': local.scope, 'data-path': local.path });
  assert.equal(ui.state.detailPlugin.displayName, 'My Notes');
  assert.equal(ui.state.detailPlugin._localOnly, true);
});

test('an isolated agy-market fork gets its own update button in Discover and Details', () => {
  const { ui } = createUiVmHarness();
  const dir = 'demo--agy-market';
  const id = 'demo__agy-market';
  const loc = { scope: 'global', dir, name: dir, version: '1.0.0', receipt: { id } };
  const plugin = { id, canonicalName: 'agy-market', scopedName: dir, displayName: 'Demo Market',
    version: '1.1.0', installStatus: { installed: true, installedDir: dir, installedVersion: '1.0.0' } };
  ui.state.serverState = { installed: [loc], catalog: { plugins: [plugin] } };
  ui.state.updates.items = [{ id, dir, isSelf: false, source: 'catalog', installedVersion: '1.0.0', latestVersion: '1.1.0' }];
  ui.state.detailPlugin = plugin;
  const updates = ui.getUpdateMaps();
  for (const html of [ui.renderPluginCard(plugin, updates.byId, ui.getInstalledByDirMap(), updates.byDir), ui.renderDetailDrawer()]) {
    assert.match(html, /data-action="install" data-id="demo__agy-market" data-dir="demo--agy-market"/);
    assert.doesNotMatch(html, /data-action="self-update"/);
  }
});

test('Re-sync selects the installed source, version and revision across catalog and GitHub channels', async () => {
  const posts = [];
  const { ui } = createUiVmHarness(async (url, opts) => {
    if (opts.method === 'POST') posts.push(JSON.parse(opts.body));
    return jsonResp({ ok: true, alreadyUpToDate: true });
  });
  const dir = 'notes', id = 'demo__notes';
  const receipt = { id, installedVersion: '2.0.0', gitTag: 'release-2', commitSha: 'a'.repeat(40), track: 'verified' };
  const loc = { scope: 'global', dir, name: dir, version: '2.0.0', receipt };
  const plugin = { id, version: '1.0.0', installStatus: { installed: true, installedDir: dir } };
  ui.state.loading = false;
  ui.state.serverState = { installed: [loc], catalog: { plugins: [plugin] } };
  await ui.triggerInstall(plugin, { dir, forceResync: true });
  assert.equal(posts[0].updateChannel, 'github-upstream');
  assert.equal(posts[0].targetVersion, loc.version);
  assert.equal(posts[0].targetRef, 'release-2');
  plugin.version = loc.version;
  await ui.triggerInstall(plugin, { dir, forceResync: true });
  assert.equal(posts[1].updateChannel, 'catalog');
  assert.equal(posts[1].targetVersion, loc.version);
  receipt.track = 'github-url';
  receipt.githubSource = { refType: 'branch', trackBranch: 'beta' };
  await ui.triggerDirectPluginUpdate({ id, dir, forceResync: true });
  assert.equal(posts[2].updateChannel, 'github-url');
  assert.equal(posts[2].targetRef, receipt.commitSha);
  assert.equal(posts[2].trackBranch, 'beta');
  loc.version = '3.0.0';
  await ui.triggerInstall(plugin, { dir, forceResync: true });
  assert.equal(posts[3].targetVersion, '3.0.0');
  assert.equal(posts[3].targetRef, undefined);
  loc.version = '1.0.0';
  loc.legacyRepoTagVersion = true;
  receipt.githubSource = { refType: 'tag' };
  receipt.gitTag = 'v2.0.0';
  await ui.triggerInstall(plugin, { dir, forceResync: true });
  assert.equal(posts[4].targetVersion, loc.version);
  assert.equal(posts[4].targetRef, receipt.gitTag);
});

test('capability confirmation resends the displayed approval key for each update entry point', async () => {
  const escalation = { hasEscalation: true, addedBadges: ['mcp-stdio'], approvalKey: 'reviewed-key' };
  const prompt = { ok: false, status: 'CAPABILITY_ESCALATION_CONFIRM_REQUIRED', escalation };
  for (const mode of ['catalog', 'direct', 'self', 'batch']) {
    const posts = [];
    const { ui } = createUiVmHarness(async (url, opts) => {
      if (opts.method !== 'POST') return jsonResp({ ok: true });
      posts.push(JSON.parse(opts.body));
      return jsonResp(mode === 'batch' ? { ok: false, results: [
        { ...prompt, id: 'a__notes', dir: 'notes' },
        { ...prompt, id: 'a__notes', dir: 'other-copy', escalation: { ...escalation, approvalKey: 'second-key' } },
      ] } : prompt);
    });
    ui.state.loading = false;
    if (mode === 'catalog') await ui.triggerInstall({ id: 'a__notes', installStatus: { installed: true, installedDir: 'notes' } });
    if (mode === 'direct') await ui.triggerDirectPluginUpdate({ id: 'a__notes', dir: 'notes' });
    if (mode === 'self') await ui.triggerSelfUpdate();
    if (mode === 'batch') await ui.triggerUpdateAll(['notes', 'other-copy']);
    assert.ok(!posts[0].approvalKey && !posts[0].approvalKeys);
    clickUiAction(ui, 'confirm-escalation');
    assert.equal(posts[1].confirmEscalation, true, mode);
    if (mode === 'batch') assert.deepEqual(posts[1].approvalKeys, { notes: 'reviewed-key', 'other-copy': 'second-key' });
    else assert.equal(posts[1].approvalKey, 'reviewed-key', mode);
  }
});

test('an expired GitHub preview clears its token, replace choice, and capability approval before reinspection', async () => {
  const posts = [];
  const { ui } = createUiVmHarness(async (url, opts) => {
    posts.push({ url, body: JSON.parse(opts.body) });
    return jsonResp({ ok: false, error: 'ERR_INSPECT_TOKEN_EXPIRED: Preview expired' }, 400);
  });
  const url = 'https://github.com/demo/notes';
  ui.state.loading = false;
  ui.state.githubUrlModal = { phase: 'preview', url, inspectToken: 'old-preview', installMode: 'replace',
    confirmEscalation: true, inspectResult: { escalation: { hasEscalation: true, approvalKey: 'old-key' } } };
  await ui.triggerGithubUrlInstall();
  assert.equal(posts.length, 1);
  assert.equal(posts[0].body.approvalKey, 'old-key');
  const modal = ui.state.githubUrlModal;
  assert.equal(modal.phase, 'input');
  assert.equal(modal.url, url);
  assert.equal(modal.inspectToken, '');
  assert.equal(modal.confirmEscalation, false);
  assert.equal(modal.installMode, 'native');
  assert.equal(modal.inspectResult, null);
  assert.ok(modal.error);
});

test('a GitHub preview reopens for staged capability changes and sends the displayed grant on confirmation', async () => {
  const posts = [];
  const { ui } = createUiVmHarness(async (url, opts) => {
    if (url !== '/api/github/install') return jsonResp({ ok: true, items: [] });
    posts.push(JSON.parse(opts.body));
    return jsonResp(posts.length === 1 ? { ok: false, status: 'CAPABILITY_ESCALATION_CONFIRM_REQUIRED',
      escalation: { escalated: true, addedBadges: ['mcp-remote'], addedRemoteDomains: ['fixture.example'],
        addedHookEvents: ['OnStart'], approvalKey: 'staged-grant' } }
      : { ok: true, status: 'INSTALLED', installedDir: 'reader', version: '2.0.0' });
  });
  ui.state.loading = false;
  ui.state.githubUrlModal = { phase: 'preview', inspectToken: 'preview-token', url: 'https://github.com/demo/reader',
    installMode: 'native', inspectResult: { plugin: { canonicalName: 'reader', version: '2.0.0' },
      preflight: { action: 'update' }, escalation: { hasEscalation: false } } };
  await ui.triggerGithubUrlInstall();
  const html = ui.renderModals();
  assert.match(html, /fixture\.example/);
  assert.match(html, /OnStart/);
  assert.match(html, /id="gh-confirm-escalation"/);
  assert.match(html, /data-action="install-github-url" disabled/);
  await ui.triggerGithubUrlInstall();
  assert.equal(posts.length, 1);
  ui.state.githubUrlModal.confirmEscalation = true;
  await ui.triggerGithubUrlInstall();
  assert.equal(posts[1].approvalKey, 'staged-grant');
  assert.equal(posts[1].inspectToken, 'preview-token');
  assert.equal(posts[1].confirmEscalation, true);
});

test('Issue #2A: createProxyAwareFetch routes external HTTP/HTTPS through proxy (incl. CONNECT+TLS) while bypassing 127.0.0.1/localhost/NO_PROXY & honoring Windows registry cache', async () => {
  const ws = makeTempWorkspace('agy-v17-proxy-');
  const httpHits = [];
  const proxyForwardHits = [];
  const connectTunnelHits = [];
  const tlsServerNames = [];
  const directBypassHits = [];

  const { certPem, keyPem } = createSelfSignedCertForHost('proxy.test.invalid');
  const caFile = join(ws.root, 'proxy-test-ca.pem');
  writeFileSync(caFile, certPem, 'utf8');

  const httpTarget = http.createServer((req, res) => {
    httpHits.push({ url: req.url, auth: req.headers.authorization || '', host: req.headers.host || '' });
    if (req.url === '/redirect') {
      res.writeHead(302, { Location: 'http://other.test.invalid/landed' });
      res.end();
      return;
    }
    if (req.url === '/slow') {
      setTimeout(() => {
        if (!res.destroyed) {
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          res.end('late');
        }
      }, 2000).unref?.();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, path: req.url, authSeen: req.headers.authorization || null }));
  });

  const tlsTarget = tls.createServer(
    {
      key: keyPem,
      cert: certPem,
      SNICallback: (servername, cb) => {
        tlsServerNames.push(servername);
        cb(null, tls.createSecureContext({ key: keyPem, cert: certPem }));
      },
    },
    (socket) => {
      let reqBuf = '';
      socket.on('data', (chunk) => {
        reqBuf += chunk.toString('utf8');
        if (reqBuf.includes('\r\n\r\n')) {
          const body = JSON.stringify({ ok: true, tunneled: true, sni: tlsServerNames[tlsServerNames.length - 1] || '' });
          socket.end(
            `HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
          );
        }
      });
    },
  );

  await new Promise((r) => httpTarget.listen(0, '127.0.0.1', r));
  await new Promise((r) => tlsTarget.listen(0, '127.0.0.1', r));
  const httpTargetPort = httpTarget.address().port;
  const tlsTargetPort = tlsTarget.address().port;

  const proxyServer = http.createServer((req, res) => {
    proxyForwardHits.push({
      method: req.method,
      url: req.url,
      proxyAuth: req.headers['proxy-authorization'] || '',
    });
    if (req.headers['proxy-authorization'] !== `Basic ${Buffer.from('alice:s3cr3t').toString('base64')}`) {
      res.writeHead(407, { 'Content-Type': 'text/plain' });
      res.end('Proxy Auth Required');
      return;
    }
    const targetUrl = new URL(req.url);
    const upstream = http.request(
      {
        host: '127.0.0.1',
        port: httpTargetPort,
        path: `${targetUrl.pathname}${targetUrl.search}`,
        method: req.method,
        headers: { ...req.headers, host: targetUrl.host },
      },
      (upRes) => {
        res.writeHead(upRes.statusCode || 200, upRes.headers);
        upRes.pipe(res);
      },
    );
    upstream.on('error', (err) => {
      res.writeHead(502);
      res.end(err.message);
    });
    req.pipe(upstream);
  });

  proxyServer.on('connect', (req, clientSocket, head) => {
    connectTunnelHits.push({
      url: req.url,
      proxyAuth: req.headers['proxy-authorization'] || '',
    });
    if (req.headers['proxy-authorization'] !== `Basic ${Buffer.from('alice:s3cr3t').toString('base64')}`) {
      clientSocket.write('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n');
      clientSocket.destroy();
      return;
    }
    const upstream = net.connect(tlsTargetPort, '127.0.0.1', () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head && head.length) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    upstream.on('error', () => clientSocket.destroy());
    clientSocket.on('error', () => upstream.destroy());
  });

  await new Promise((r) => proxyServer.listen(0, '127.0.0.1', r));
  const proxyPort = proxyServer.address().port;
  const proxyUrl = `http://alice:s3cr3t@127.0.0.1:${proxyPort}`;

  try {
    // 1. Unit assertions for proxy resolution, NO_PROXY & Windows registry parsing
    assert.equal(resolveProxyUrlForTarget('http://127.0.0.1:8080/x', { env: { HTTP_PROXY: proxyUrl } }), null);
    assert.equal(resolveProxyUrlForTarget('http://localhost:8080/x', { env: { HTTP_PROXY: proxyUrl } }), null);
    assert.equal(resolveProxyUrlForTarget('http://[::1]:8080/x', { env: { HTTP_PROXY: proxyUrl } }), null);
    assert.equal(resolveProxyUrlForTarget('file:///C:/plugin.tar.gz', { env: { ALL_PROXY: proxyUrl } }), null);
    assert.equal(
      resolveProxyUrlForTarget('https://api.internal.corp/v1', {
        env: { HTTPS_PROXY: proxyUrl, NO_PROXY: 'localhost,.internal.corp' },
      }),
      null,
    );
    assert.ok(
      resolveProxyUrlForTarget('https://api.github.com/repos', {
        env: { HTTPS_PROXY: proxyUrl, NO_PROXY: 'localhost,.internal.corp' },
      })?.startsWith('http://alice:s3cr3t@127.0.0.1:'),
    );

    for (const env of [{ ALL_PROXY: 'socks5://proxy.example:1080' }, { HTTP_PROXY: proxyUrl }]) {
      assert.equal(resolveProxyUrlForTarget('https://example.com', {
        env, winProxyConfig: { enabled: true, proxyServer: 'https=127.0.0.1:7891' },
      }), 'http://127.0.0.1:7891/');
    }

    const noProxyParsed = parseNoProxy('localhost, 127.0.0.1, <local>, *.corp.local');
    assert.equal(noProxyParsed.length, 4);
    assert.equal(parseWindowsProxyServer('http=127.0.0.1:7890;https=127.0.0.1:7891', 'https:'), 'http://127.0.0.1:7891/');
    assert.equal(parseWindowsProxyServer('http=127.0.0.1:7890;https=127.0.0.1:7891', 'http:'), 'http://127.0.0.1:7890/');
    const winRegParsed = parseWindowsInternetSettingsOutput(
      [
        'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings',
        '    ProxyEnable    REG_DWORD    0x1',
        '    ProxyServer    REG_SZ    127.0.0.1:7897',
        '    ProxyOverride    REG_SZ    localhost;127.*;<local>',
      ].join('\r\n'),
    );
    assert.deepEqual(winRegParsed, {
      enabled: true,
      proxyServer: '127.0.0.1:7897',
      proxyOverride: 'localhost;127.*;<local>',
    });

    // 2. Live HTTP forward proxy vs loopback / NO_PROXY bypass + cross-origin auth strip + AbortSignal
    const baseFetchSpy = async (url, init) => {
      directBypassHits.push(String(url));
      if (String(url).startsWith('file://')) return new Response('local-file', { status: 200 });
      if (String(url).includes('bypass.test.invalid') || String(url).includes('corp.local')) {
        return jsonResp({ ok: true, bypassed: true });
      }
      return fetch(url, init);
    };

    const proxyFetch = createProxyAwareFetch({
      baseFetch: baseFetchSpy,
      env: {
        HTTP_PROXY: proxyUrl,
        HTTPS_PROXY: proxyUrl,
        NO_PROXY: 'bypass.test.invalid,.corp.local',
      },
      readWinSystemProxy: false,
    });

    const rLoop1 = await proxyFetch(`http://127.0.0.1:${httpTargetPort}/loop1`);
    assert.equal(rLoop1.status, 200);
    const rLoop2 = await proxyFetch(`http://localhost:${httpTargetPort}/loop2`);
    assert.equal(rLoop2.status, 200);
    const rNoProxy = await proxyFetch('http://bypass.test.invalid/skip');
    assert.equal((await rNoProxy.json()).bypassed, true);
    const rSuffix = await proxyFetch('http://svc.corp.local/skip2');
    assert.equal((await rSuffix.json()).bypassed, true);
    assert.equal(proxyForwardHits.length, 0, 'Loopback and NO_PROXY requests must bypass proxy');
    assert.equal(directBypassHits.length, 4);

    const rExt = await proxyFetch('http://external.test.invalid/hello', {
      headers: { Authorization: 'Bearer secret-tok' },
    });
    assert.equal(rExt.status, 200);
    const extData = await rExt.json();
    assert.equal(extData.ok, true);
    assert.equal(extData.path, '/hello');
    assert.equal(extData.authSeen, 'Bearer secret-tok');
    assert.equal(proxyForwardHits.length, 1);
    assert.equal(proxyForwardHits[0].url, 'http://external.test.invalid/hello');

    // Redirect strips Authorization across origins
    const rRedir = await proxyFetch('http://external.test.invalid/redirect', {
      headers: { Authorization: 'Bearer top-secret' },
    });
    assert.equal(rRedir.status, 200);
    const redirData = await rRedir.json();
    assert.equal(redirData.path, '/landed');
    assert.equal(redirData.authSeen, null, 'Cross-origin redirect MUST strip Authorization header');

    // AbortSignal propagation
    const ac = new AbortController();
    setTimeout(() => ac.abort(new Error('user cancelled')), 40);
    await assert.rejects(
      () => proxyFetch('http://external.test.invalid/slow', { signal: ac.signal }),
      /user cancelled|AbortError/,
    );

    // 3. Real HTTPS CONNECT tunnel + TLS SNI verification (with NODE_EXTRA_CA_CERTS trusting generated cert)
    const childRes = await new Promise((resolveProc, rejectProc) => {
      const childScript = [
        `import { createProxyAwareFetch } from ${JSON.stringify(pathToFileURL(join(REPO_ROOT, 'src', 'shared', 'proxy-fetch.mjs')).href)};`,
        `const f = createProxyAwareFetch({ readWinSystemProxy: false });`,
        `const r = await f('https://proxy.test.invalid/secure');`,
        `console.log(JSON.stringify({ status: r.status, body: await r.json() }));`,
      ].join('\n');
      const child = spawn(process.execPath, ['--input-type=module', '-e', childScript], {
        env: {
          ...process.env,
          NODE_EXTRA_CA_CERTS: caFile,
          HTTPS_PROXY: proxyUrl,
          NO_PROXY: '',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '';
      let err = '';
      child.stdout.on('data', (d) => (out += d));
      child.stderr.on('data', (d) => (err += d));
      child.on('exit', (code) => {
        if (code !== 0) rejectProc(new Error(`HTTPS CONNECT child exited ${code}: ${err}`));
        else resolveProc(JSON.parse(out.trim()));
      });
    });
    assert.equal(childRes.status, 200);
    assert.equal(childRes.body.ok, true);
    assert.equal(childRes.body.tunneled, true);
    assert.equal(childRes.body.sni, 'proxy.test.invalid');
    assert.equal(connectTunnelHits.length, 1);
    assert.equal(connectTunnelHits[0].url, 'proxy.test.invalid:443');

    // 4. Windows registry system proxy + 30s TTL cache + `<local>` bypass
    let regCalls = 0;
    let fakeNow = 1_000_000;
    const winBypass = [];
    const winFetch = createProxyAwareFetch({
      baseFetch: async (url) => {
        winBypass.push(String(url));
        return jsonResp({ direct: true });
      },
      env: {},
      platform: 'win32',
      readWinSystemProxy: true,
      nowFn: () => fakeNow,
      execFileImpl: (_cmd, _args, _opts, cb) => {
        regCalls += 1;
        queueMicrotask(() =>
          cb(
            null,
            [
              '    ProxyEnable    REG_DWORD    0x1',
              `    ProxyServer    REG_SZ    http=alice:s3cr3t@127.0.0.1:${proxyPort};https=alice:s3cr3t@127.0.0.1:${proxyPort}`,
              '    ProxyOverride    REG_SZ    <local>;skipwin.test',
            ].join('\r\n'),
          ),
        );
      },
    });
    const w1 = await winFetch('http://extwin.test.invalid/one');
    assert.equal((await w1.json()).path, '/one');
    const w2 = await winFetch('http://intranet/local-host'); // `<local>` single-label hostname
    assert.equal((await w2.json()).direct, true);
    assert.equal(regCalls, 1, 'Windows registry query must be cached for 30s');
    fakeNow += 31_000;
    const w3 = await winFetch('http://skipwin.test/two');
    assert.equal((await w3.json()).direct, true);
    assert.equal(regCalls, 2, 'Expired 30s TTL must refresh Windows registry cache');
    assert.equal(winBypass.length, 2);
  } finally {
    proxyServer.close();
    httpTarget.close();
    tlsTarget.close();
    ws.cleanup();
  }
});

test('Issue #2B: Monorepo unreceipted plugin (context7) suppresses false update when <tag>/plugin.json is 404, mismatched name, or non-newer, while real root plugin updates', async () => {
  const ws = makeTempWorkspace('agy-v17-monorepo-');
  try {
    writePluginTree(ws.pluginsDir, 'context7', {
      'plugin.json': {
        name: 'context7',
        displayName: 'Context7',
        version: '1.0.1',
        repository: 'https://github.com/upstash/context7',
      },
      'skills/c7/SKILL.md': '---\nname: context7\ndescription: c7\n---\n# c7',
    });
    writePluginTree(ws.pluginsDir, 'real-root', {
      'plugin.json': {
        name: 'real-root',
        displayName: 'Real Root',
        version: '1.0.1',
        repository: 'https://github.com/acme/real-root',
      },
      'skills/rr/SKILL.md': '---\nname: real-root\ndescription: rr\n---\n# rr',
    });

    let rawMode = '404';
    const mockFetch = async (url) => {
      const u = String(url);
      if (u.endsWith('/index.json')) return jsonResp({ schemaVersion: 1, track: 'verified', plugins: [] });
      if (u.endsWith('/unverified-index.json')) return jsonResp({ schemaVersion: 1, track: 'unverified', plugins: [] });
      if (u.endsWith('/readmes.json')) return jsonResp({ entries: {} });

      if (u === 'https://api.github.com/repos/upstash/context7/releases/latest') {
        return jsonResp({ tag_name: 'v1.0.30', html_url: 'https://github.com/upstash/context7/releases/tag/v1.0.30', body: 'Monorepo release' });
      }
      if (u.startsWith('https://api.github.com/repos/upstash/context7/tags')) {
        return jsonResp([{ name: 'v1.0.30' }]);
      }
      if (u === 'https://raw.githubusercontent.com/upstash/context7/v1.0.30/plugin.json') {
        if (rawMode === '404') return jsonResp({ message: 'Not Found' }, 404);
        if (rawMode === 'same-version') return jsonResp({ name: 'context7', version: '1.0.1' });
        if (rawMode === 'mismatch-name') return jsonResp({ name: 'different-plug', version: '1.0.30' });
      }

      if (u === 'https://api.github.com/repos/acme/real-root/releases/latest') {
        return jsonResp({ tag_name: 'v1.2.0', html_url: 'https://github.com/acme/real-root/releases/tag/v1.2.0', body: 'Real v1.2.0' });
      }
      if (u.startsWith('https://api.github.com/repos/acme/real-root/tags')) {
        return jsonResp([{ name: 'v1.2.0' }]);
      }
      if (u === 'https://raw.githubusercontent.com/acme/real-root/v1.2.0/plugin.json') {
        return jsonResp({ name: 'real-root', version: '1.2.0' });
      }
      return jsonResp({ message: 'Not Found' }, 404);
    };

    const inventory = scanLocalPluginInventory({ configDir: ws.configDir, dataDir: ws.dataDir });

    // Mode 1: 404 on v1.0.30/plugin.json (actual upstash/context7 monorepo layout)
    const directRes = await checkPluginUpdates({
      catalog: { plugins: [] },
      inventory,
      dataDir: ws.dataDir,
      force: true,
      fetchImpl: mockFetch,
    });
    assert.equal(directRes.items.some((x) => x.dir === 'context7'), false, 'context7 with 404 raw plugin.json MUST NOT be flagged');
    const realItem = directRes.items.find((x) => x.dir === 'real-root');
    assert.ok(realItem, 'real-root with v1.2.0 raw plugin.json MUST be flagged');
    assert.equal(realItem.latestVersion, '1.2.0');
    assert.equal(realItem.updateChannel, 'github-upstream');

    // Mode 2 & 3: same-version and mismatch-name also suppressed via sidecar /api/updates
    const srv = await createMarketSidecarServer({
      listen: false,
      configDir: ws.configDir,
      dataDir: ws.dataDir,
      recoveryDelayMs: -1,
      fetchImpl: mockFetch,
    });
    try {
      for (const mode of ['404', 'same-version', 'mismatch-name']) {
        rawMode = mode;
        const res = await srv.inject({ method: 'GET', url: '/api/updates?force=1' });
        assert.equal(res.statusCode, 200);
        const items = res.json().items;
        assert.equal(items.some((x) => x.dir === 'context7'), false, `context7 must stay suppressed for mode=${mode}`);
        assert.equal(items.some((x) => x.dir === 'real-root' && x.latestVersion === '1.2.0'), true);
      }
    } finally {
      await srv.close();
    }
  } finally {
    ws.cleanup();
  }
});

test('Issue #3A: native .git (conductor) & unversioned (sepia) plugins get unmanaged flags, are excluded from updates/update-all, rejected by /api/update, and render read-only UI pills', async () => {
  const ws = makeTempWorkspace('agy-v17-unmanaged-');
  try {
    // 1. conductor: .git directory, no receipt
    writePluginTree(ws.pluginsDir, 'conductor', {
      '.git/HEAD': 'ref: refs/heads/main\n',
      'plugin.json': {
        name: 'conductor',
        displayName: 'Conductor',
        version: '0.1.0',
        repository: 'https://github.com/acme/conductor',
      },
      'skills/cond/SKILL.md': '---\nname: conductor\ndescription: cond\n---\n# cond',
    });

    // 2. sepia: no version in plugin.json, no receipt
    writePluginTree(ws.pluginsDir, 'sepia', {
      'plugin.json': {
        name: 'sepia',
        displayName: 'Sepia',
        repository: 'https://github.com/acme/sepia',
      },
      'skills/sep/SKILL.md': '---\nname: sepia\ndescription: sep\n---\n# sep',
    });

    // 3. control normal-gh: declared version 1.0.0, no .git, no receipt -> SHOULD update
    writePluginTree(ws.pluginsDir, 'normal-gh', {
      'plugin.json': {
        name: 'normal-gh',
        displayName: 'Normal GH',
        version: '1.0.0',
        repository: 'https://github.com/acme/normal-gh',
      },
      'skills/norm/SKILL.md': '---\nname: normal-gh\ndescription: norm\n---\n# norm',
    });

    const inv = scanLocalPluginInventory({ configDir: ws.configDir, dataDir: ws.dataDir });
    const byDir = new Map(inv.installed.map((x) => [x.dir, x]));
    const condLoc = byDir.get('conductor');
    const sepiaLoc = byDir.get('sepia');
    const normLoc = byDir.get('normal-gh');

    assert.equal(condLoc.isGitManaged, true);
    assert.equal(condLoc.hasDeclaredVersion, true);
    assert.equal(condLoc.unmanagedReason, 'git-clone');
    assert.equal(sepiaLoc.isGitManaged, false);
    assert.equal(sepiaLoc.hasDeclaredVersion, false);
    assert.equal(sepiaLoc.version, '0.0.0');
    assert.equal(sepiaLoc.unmanagedReason, 'no-version');
    assert.equal(normLoc.isGitManaged, false);
    assert.equal(normLoc.hasDeclaredVersion, true);
    assert.equal(normLoc.unmanagedReason, null);

    const normalV11Tar = buildGithubArchiveBuffer(
      {
        'plugin.json': JSON.stringify({
          name: 'normal-gh',
          displayName: 'Normal GH',
          version: '1.1.0',
          repository: 'https://github.com/acme/normal-gh',
          logo: 'assets/logo.svg',
        }),
        'assets/logo.svg': CLEAN_SVG,
        'skills/norm/SKILL.md': '---\nname: normal-gh\ndescription: norm v1.1\n---\n# norm v1.1',
      },
      'normal-gh-1.1.0',
    );

    const mockFetch = async (url) => {
      const u = String(url);
      if (u.endsWith('/index.json')) return jsonResp({ schemaVersion: 1, track: 'verified', plugins: [] });
      if (u.endsWith('/unverified-index.json')) return jsonResp({ schemaVersion: 1, track: 'unverified', plugins: [] });
      if (u.endsWith('/readmes.json')) return jsonResp({ entries: {} });
      for (const slug of ['acme/conductor', 'acme/sepia']) {
        if (u.includes(slug) && u.includes('/releases/latest')) {
          return jsonResp({ tag_name: 'v9.9.9', html_url: `https://github.com/${slug}/releases/tag/v9.9.9` });
        }
        if (u.startsWith(`https://raw.githubusercontent.com/${slug}/`)) {
          return jsonResp({ name: slug.split('/')[1], version: '9.9.9' });
        }
      }
      if (u === 'https://api.github.com/repos/acme/normal-gh/releases/latest') {
        return jsonResp({ tag_name: 'v1.1.0', html_url: 'https://github.com/acme/normal-gh/releases/tag/v1.1.0' });
      }
      if (u === 'https://raw.githubusercontent.com/acme/normal-gh/v1.1.0/plugin.json') {
        return jsonResp({ name: 'normal-gh', version: '1.1.0' });
      }
      if (u.includes('acme/normal-gh') && (u.includes('tar.gz') || u.includes('/archive/'))) {
        return binResp(normalV11Tar);
      }
      return jsonResp({ message: 'Not Found' }, 404);
    };

    const updCheck = await checkPluginUpdates({
      catalog: { plugins: [] },
      inventory: inv,
      dataDir: ws.dataDir,
      force: true,
      fetchImpl: mockFetch,
    });
    assert.equal(updCheck.items.some((x) => x.dir === 'conductor'), false);
    assert.equal(updCheck.items.some((x) => x.dir === 'sepia'), false);
    assert.equal(updCheck.items.some((x) => x.dir === 'normal-gh' && x.latestVersion === '1.1.0'), true);

    const srv = await createMarketSidecarServer({
      listen: false,
      configDir: ws.configDir,
      dataDir: ws.dataDir,
      recoveryDelayMs: -1,
      fetchImpl: mockFetch,
    });
    try {
      const authHeaders = { 'X-Sidecar-Token': srv.sideToken, Origin: 'http://127.0.0.1:43210' };

      const updRes = await srv.inject({ method: 'GET', url: '/api/updates?force=1' });
      assert.equal(updRes.statusCode, 200);
      assert.deepEqual(
        updRes.json().items.map((x) => x.dir),
        ['normal-gh'],
      );

      for (const dir of ['conductor', 'sepia']) {
        const rejRes = await srv.inject({
          method: 'POST',
          url: '/api/update',
          headers: authHeaders,
          body: { dir, updateChannel: 'github-upstream', targetRef: 'v9.9.9' },
        });
        assert.equal(rejRes.statusCode, 400);
        const body = rejRes.json();
        assert.equal(body.ok, false);
        assert.equal(body.status, 'UNMANAGED_PLUGIN');
        assert.equal(body.errorCode, 'ERR_UNMANAGED_GIT_OR_UNVERSIONED');
      }

      // Explicit ids batch rejects unmanaged plugins cleanly
      const explicitBatch = await srv.inject({
        method: 'POST',
        url: '/api/update-all',
        headers: authHeaders,
        body: { ids: ['conductor', 'sepia'] },
      });
      assert.equal(explicitBatch.statusCode, 200);
      assert.equal(explicitBatch.json().ok, false);
      assert.equal(explicitBatch.json().results.length, 2);
      assert.ok(
        explicitBatch
          .json()
          .results.every((r) => r.status === 'UNMANAGED_PLUGIN' && r.errorCode === 'ERR_UNMANAGED_GIT_OR_UNVERSIONED'),
      );

      // Auto-discover update-all updates normal-gh and leaves conductor .git intact
      const autoBatch = await srv.inject({
        method: 'POST',
        url: '/api/update-all',
        headers: authHeaders,
        body: {},
      });
      assert.equal(autoBatch.statusCode, 200);
      assert.equal(autoBatch.json().ok, true);
      assert.equal(autoBatch.json().results.length, 1);
      assert.equal(autoBatch.json().results[0].dir, 'normal-gh');
      assert.equal(existsSync(join(ws.pluginsDir, 'conductor', '.git', 'HEAD')), true);
      assert.equal(
        JSON.parse(readFileSync(join(ws.pluginsDir, 'normal-gh', 'plugin.json'), 'utf8')).version,
        '1.1.0',
      );
    } finally {
      await srv.close();
    }

    // Verify bundled app.mjs + built sidecars/market_pane/index.html read-only UI pills
    const builtHtml = readFileSync(join(REPO_ROOT, 'sidecars', 'market_pane', 'index.html'), 'utf8');
    assert.match(builtHtml, /isLocalPluginUpdateManagedExternally/);
    assert.match(builtHtml, /state-pill is-external/);
    assert.match(builtHtml, /Git 原生/);
    assert.match(builtHtml, /Git Native/);
    assert.match(builtHtml, /无版本号/);
    assert.match(builtHtml, /Unversioned/);

    const { ui } = createUiVmHarness();
    const fakeUpdCond = { dir: 'conductor', id: 'acme__conductor', latestVersion: '9.9.9' };
    const fakeUpdSepia = { dir: 'sepia', id: 'acme__sepia', latestVersion: '9.9.9' };
    assert.equal(ui.isUpdateEffectiveForLocal(fakeUpdCond, condLoc), false);
    assert.equal(ui.isUpdateEffectiveForLocal(fakeUpdSepia, sepiaLoc), false);

    ui.state.serverState = {
      plugin: { id: 'agy-market', version: PLUGIN_VERSION },
      prefs: { locale: 'en', favorites: [] },
      catalog: { plugins: [], channelUsed: 'primary' },
      installed: [condLoc, sepiaLoc],
      updatesAvailable: [],
    };
    ui.state.updates = { loading: false, checkedAt: '2026-11-26T12:00:00Z', items: [fakeUpdCond, fakeUpdSepia], selfUpdate: null };

    const { byId: updById, byDir: updByDir } = ui.getUpdateMaps();
    const { byId: catById, byDir: catByDir } = ui.getCatalogMaps();
    const condCard = ui.renderInstalledCard(condLoc, updById, updByDir, catById, catByDir);
    const sepiaCard = ui.renderInstalledCard(sepiaLoc, updById, updByDir, catById, catByDir);
    assert.match(condCard, /state-pill is-external is-git-native/);
    assert.match(condCard, /Git Native/);
    assert.doesNotMatch(condCard, /data-action="update-plugin-direct"|data-action="sync-installed-plugin"/);
    assert.match(sepiaCard, /state-pill is-external is-unversioned/);
    assert.match(sepiaCard, /Unversioned/);
    assert.doesNotMatch(sepiaCard, /data-action="update-plugin-direct"|data-action="sync-installed-plugin"/);

    ui.state.detailPlugin = {
      id: 'conductor',
      canonicalName: 'conductor',
      displayName: 'Conductor',
      version: '0.1.0',
      description: { en: 'Git plugin' },
      repository: { url: 'https://github.com/acme/conductor' },
      capabilities: { badges: ['declarative-only'] },
      installStatus: { installed: true, installedDir: 'conductor', enabled: true, scope: 'global', isGitManaged: true, hasDeclaredVersion: true, hasReceipt: false },
      _localOnly: true,
    };
    const condDrawer = ui.renderDetailDrawer();
    assert.match(condDrawer, /state-pill is-external is-git-native/);
    assert.doesNotMatch(condDrawer, /data-action="update-plugin-direct"|data-action="sync-installed-plugin"|data-force-resync="1"/);

    ui.state.detailPlugin = {
      id: 'sepia',
      canonicalName: 'sepia',
      displayName: 'Sepia',
      version: '0.0.0',
      description: { en: 'Unversioned plugin' },
      repository: { url: 'https://github.com/acme/sepia' },
      capabilities: { badges: ['declarative-only'] },
      installStatus: { installed: true, installedDir: 'sepia', enabled: true, scope: 'global', isGitManaged: false, hasDeclaredVersion: false, hasReceipt: false },
      _localOnly: true,
    };
    const sepiaDrawer = ui.renderDetailDrawer();
    assert.match(sepiaDrawer, /state-pill is-external is-unversioned/);
    assert.doesNotMatch(sepiaDrawer, /data-action="update-plugin-direct"|data-action="sync-installed-plugin"|data-force-resync="1"/);
  } finally {
    ws.cleanup();
  }
});

test('Issue #3B: app-asar activation/UI includes patch-script (setup.cjs) install & update guidance and installOrUpdateCatalogPlugin preserves existingReceipt.preservePaths', async () => {
  const ws = makeTempWorkspace('agy-v17-asar-preserve-');
  try {
    // 1. Backend activation check for app-asar
    const act = classifyActivationRequirement({
      badges: ['host-enhancement'],
      hostEnhancementKind: ['app-asar'],
    });
    assert.equal(act.level, 'host-restart');
    assert.equal(act.requiresPatchScript, true);
    assert.match(act.reasonZh, /setup\.cjs/);
    assert.match(act.reasonZh, /更新/);
    assert.match(act.reasonEn, /setup\.cjs/);
    assert.match(act.reasonEn, /market updates/);

    // 2. UI VM check for app-asar install & update guidance, restart banner & detail drawer
    const { ui } = createUiVmHarness();
    ui.state.serverState = {
      plugin: { id: 'agy-market', version: PLUGIN_VERSION },
      paths: { pluginsDir: ws.pluginsDir },
      prefs: { locale: 'en', favorites: [] },
      catalog: { plugins: [], channelUsed: 'primary' },
      installed: [
        {
          dir: 'asar-skin',
          path: join(ws.pluginsDir, 'asar-skin'),
          name: 'asar-skin',
          displayName: 'Asar Skin',
          version: '1.0.0',
          scope: 'global',
          enabled: true,
          hostEnhancementKind: ['app-asar'],
          capabilities: { badges: ['host-enhancement'], hostEnhancementKind: ['app-asar'] },
          activation: act,
        },
      ],
    };
    const uiInstallAct = ui.resolveActivationInfo(
      { capabilities: { badges: ['host-enhancement'], hostEnhancementKind: ['app-asar'] } },
      {},
      { operation: 'install' },
    );
    const uiUpdateAct = ui.resolveActivationInfo(
      { capabilities: { badges: ['host-enhancement'], hostEnhancementKind: ['app-asar'] } },
      {},
      { operation: 'update' },
    );
    assert.equal(uiInstallAct.requiresPatchScript, true);
    assert.equal(uiUpdateAct.requiresPatchScript, true);
    assert.match(uiInstallAct.reasonEn, /setup\.cjs/);
    assert.match(uiUpdateAct.reasonEn, /re-run the patch script/);

    ui.maybeTriggerRestartBanner({
      pluginName: 'Asar Skin',
      pluginDir: 'asar-skin',
      pluginId: 'acme__asar-skin',
      operation: 'update',
      restartRequired: true,
      activation: uiUpdateAct,
    });
    const bannerHtml = ui.renderRestartBanner();
    assert.match(bannerHtml, /data-agy-restart-banner="1"/);
    assert.match(bannerHtml, /Copy Plugin Folder/);
    assert.match(bannerHtml, /data-action="open-patch-docs"/);

    ui.state.detailPlugin = {
      id: 'acme__asar-skin',
      canonicalName: 'asar-skin',
      displayName: 'Asar Skin',
      version: '1.0.0',
      description: { en: 'Asar mod' },
      capabilities: { badges: ['host-enhancement'], hostEnhancementKind: ['app-asar'] },
      installStatus: { installed: true, installedDir: 'asar-skin', enabled: true, scope: 'global', activation: uiUpdateAct },
    };
    ui.state.detailTab = 'overview';
    const drawerHtml = ui.renderDetailDrawer();
    assert.match(drawerHtml, /data-agy-asar-guide="1"/);
    assert.match(drawerHtml, /Copy Folder Path/);

    // 3. installOrUpdateCatalogPlugin preserves existingReceipt.preservePaths even when catalog distribution.preservePaths is []
    writePluginTree(ws.pluginsDir, 'asar-skin', {
      'plugin.json': { name: 'asar-skin', displayName: 'Asar Skin', version: '1.0.0' },
      'user-data/prefs.json': '{"custom":true,"theme":"obsidian"}\n',
      'themes/custom.css': '/* user override */\n',
      '.agy-market-receipt.json': {
        schemaVersion: 1,
        id: 'acme__asar-skin',
        track: 'verified',
        repositoryId: 9101,
        installedDir: 'asar-skin',
        effectivePluginName: 'asar-skin',
        scopedRewriteApplied: false,
        installedVersion: '1.0.0',
        gitTag: 'v1.0.0',
        preservePaths: ['user-data/prefs.json', 'themes/custom.css'],
        grantedCapabilities: { badges: ['host-enhancement'], mcpRemoteDomains: [], hookEvents: [], hostEnhancementKind: ['app-asar'] },
      },
    });

    const v2Buf = createDeterministicTarGz({
      'plugin.json': JSON.stringify({ name: 'asar-skin', displayName: 'Asar Skin', version: '2.0.0', logo: 'assets/logo.svg' }),
      'assets/logo.svg': CLEAN_SVG,
      'user-data/prefs.json': '{"custom":false,"theme":"default"}\n',
      'setup.cjs': 'console.log("patch");\n',
    });
    const v2Path = join(ws.artifactsDir, 'asar-skin-2.0.0.tar.gz');
    writeFileSync(v2Path, v2Buf);
    const v2Sha = createHash('sha256').update(v2Buf).digest('hex');

    const catPlugin = makeCatalogPlugin({
      id: 'acme__asar-skin',
      canonicalName: 'asar-skin',
      owner: 'acme',
      repo: 'asar-skin',
      displayName: 'Asar Skin',
      version: '2.0.0',
      repoId: 9101,
      tarballUrl: pathToFileURL(v2Path).href,
      sha256: v2Sha,
      sizeBytes: v2Buf.length,
      preservePaths: [], // explicitly empty in catalog!
      badges: ['host-enhancement'],
      hostEnhancementKind: ['app-asar'],
    });

    const updRes = await installOrUpdateCatalogPlugin({
      plugin: catPlugin,
      track: 'verified',
      configDir: ws.configDir,
      dataDir: ws.dataDir,
    });
    assert.equal(updRes.ok, true);
    assert.equal(updRes.action, 'update');
    assert.equal(readFileSync(join(ws.pluginsDir, 'asar-skin', 'user-data', 'prefs.json'), 'utf8'), '{"custom":true,"theme":"obsidian"}\n');
    assert.equal(readFileSync(join(ws.pluginsDir, 'asar-skin', 'themes', 'custom.css'), 'utf8'), '/* user override */\n');
    const newReceipt = JSON.parse(readFileSync(join(ws.pluginsDir, 'asar-skin', '.agy-market-receipt.json'), 'utf8'));
    assert.deepEqual(newReceipt.preservePaths, ['user-data/prefs.json', 'themes/custom.css']);
  } finally {
    ws.cleanup();
  }
});

test('Issue #3C: install-local.mjs succeeds when repo lives under _npx/.../node_modules/agy-market while still excluding nested node_modules, and docs use npx github:azwosile/agy-market', async () => {
  const ws = makeTempWorkspace('agy-v17-npx-');
  try {
    const stagedRepo = join(ws.root, '_npx', 'test', 'node_modules', 'agy-market');
    const destPluginsDir = join(ws.root, 'dest-plugins');
    mkdirSync(stagedRepo, { recursive: true });
    mkdirSync(destPluginsDir, { recursive: true });

    for (const rel of ['plugin.json', 'agy-market.json', 'package.json', 'README.md', 'README.en.md', 'LICENSE', 'assets', 'bin', 'scripts', 'sidecars', 'skills', 'src']) {
      const src = join(REPO_ROOT, rel);
      if (existsSync(src)) {
        cpSync(src, join(stagedRepo, rel), { recursive: true, force: true });
      }
    }
    // Nested node_modules INSIDE staged repo MUST still be excluded!
    mkdirSync(join(stagedRepo, 'node_modules', 'dummy-dep'), { recursive: true });
    writeFileSync(join(stagedRepo, 'node_modules', 'dummy-dep', 'index.js'), 'module.exports = 1;\n', 'utf8');
    mkdirSync(join(stagedRepo, 'src', 'node_modules', 'nested-dep'), { recursive: true });
    writeFileSync(join(stagedRepo, 'src', 'node_modules', 'nested-dep', 'x.js'), 'export default 1;\n', 'utf8');

    const installedRoot = join(destPluginsDir, 'agy-market');
    const retiredSkill = 'skills/retired/SKILL.md';
    mkdirSync(join(installedRoot, 'skills/retired'), { recursive: true });
    writeFileSync(join(installedRoot, retiredSkill), 'old');
    writeFileSync(join(installedRoot, 'notes.txt'), 'user file');
    const receiptPath = join(installedRoot, '.agy-market-receipt.json');
    writeFileSync(receiptPath, JSON.stringify({ id: 'team__market', managedFiles: ['notes.txt'] }));
    assert.throws(() => execFileSync(process.execPath, [join(stagedRepo, 'scripts', 'install-local.mjs'), '--dest', destPluginsDir], {
      env: { ...process.env, AGY_MARKET_DATA_DIR: ws.dataDir }, stdio: 'pipe',
    }), /ERR_BOOTSTRAP_CONFLICT/);
    assert.equal(readFileSync(join(installedRoot, 'notes.txt'), 'utf8'), 'user file');
    assert.equal(existsSync(join(installedRoot, 'plugin.json')), false);
    writeFileSync(join(installedRoot, '.agy-market-receipt.json'), JSON.stringify({
      id: 'azwosile__agy-market', managedFiles: [retiredSkill],
    }));
    execFileSync(process.execPath, [join(stagedRepo, 'scripts', 'install-local.mjs'), '--dest', destPluginsDir], {
      cwd: stagedRepo,
      env: { ...process.env, AGY_MARKET_DATA_DIR: ws.dataDir },
      stdio: 'pipe',
    });

    assert.equal(existsSync(join(installedRoot, retiredSkill)), false);
    assert.equal(readFileSync(join(installedRoot, 'notes.txt'), 'utf8'), 'user file');
    const receipt = JSON.parse(readFileSync(join(installedRoot, '.agy-market-receipt.json')));
    assert.ok(receipt.managedFiles.includes('skills/agy-market/SKILL.md'));
    assert.equal(existsSync(join(installedRoot, 'plugin.json')), true);
    assert.equal(existsSync(join(installedRoot, 'assets', 'logo.png')), true);
    assert.equal(existsSync(join(installedRoot, 'bin', 'agy-market.mjs')), true);
    assert.equal(existsSync(join(installedRoot, 'sidecars', 'market_pane', 'index.html')), true);
    assert.equal(existsSync(join(installedRoot, 'src', 'sidecar', 'server.mjs')), true);
    assert.equal(existsSync(join(installedRoot, 'src', 'shared', 'proxy-fetch.mjs')), true);
    assert.equal(JSON.parse(readFileSync(join(installedRoot, 'plugin.json'), 'utf8')).version, PLUGIN_VERSION);
    assert.equal(existsSync(join(installedRoot, 'node_modules')), false, 'Nested repo node_modules must be excluded');
    assert.equal(existsSync(join(installedRoot, 'src', 'node_modules')), false, 'Nested src/node_modules must be excluded');

    // Also verify installOrUpdateCatalogPlugin backup filter works when target configDir lives under .../node_modules/...
    const nmConfigDir = join(ws.root, 'node_modules', 'host-env', 'config');
    const nmPluginsDir = join(nmConfigDir, 'plugins');
    writePluginTree(nmPluginsDir, 'nm-plug', {
      'plugin.json': { name: 'nm-plug', version: '1.0.0' },
      '.agy-market-receipt.json': {
        schemaVersion: 1,
        id: 'acme__nm-plug',
        track: 'verified',
        repositoryId: 9102,
        installedDir: 'nm-plug',
        installedVersion: '1.0.0',
        preservePaths: ['keep.txt'],
        grantedCapabilities: { badges: ['declarative-only'], mcpRemoteDomains: [], hookEvents: [] },
      },
      'keep.txt': 'keep-under-node-modules\n',
    });
    const nmTar = createDeterministicTarGz({
      'plugin.json': JSON.stringify({ name: 'nm-plug', displayName: 'NM Plug', version: '1.1.0', logo: 'assets/logo.svg' }),
      'assets/logo.svg': CLEAN_SVG,
    });
    const nmTarPath = join(ws.artifactsDir, 'nm-plug-1.1.0.tar.gz');
    writeFileSync(nmTarPath, nmTar);
    const nmUpd = await installOrUpdateCatalogPlugin({
      plugin: makeCatalogPlugin({
        id: 'acme__nm-plug',
        canonicalName: 'nm-plug',
        owner: 'acme',
        repo: 'nm-plug',
        displayName: 'NM Plug',
        version: '1.1.0',
        repoId: 9102,
        tarballUrl: pathToFileURL(nmTarPath).href,
        sha256: createHash('sha256').update(nmTar).digest('hex'),
      }),
      track: 'verified',
      configDir: nmConfigDir,
      dataDir: ws.dataDir,
    });
    assert.equal(nmUpd.ok, true);
    assert.equal(readFileSync(join(nmPluginsDir, 'nm-plug', 'keep.txt'), 'utf8'), 'keep-under-node-modules\n');

    // Docs & site npx 404 fix assertions
    for (const relDoc of ['site/index.html', 'docs/index.html', 'README.md', 'README.en.md', 'skills/agy-market/SKILL.md', 'AGENTS.md']) {
      const text = readFileSync(join(REPO_ROOT, relDoc), 'utf8');
      assert.match(text, /npx --yes github:azwosile\/agy-market/, `${relDoc} must use npx --yes github:azwosile/agy-market`);
      assert.doesNotMatch(text, /npx agy-market\b/, `${relDoc} must not use unpublished npx agy-market`);
    }
  } finally {
    ws.cleanup();
  }
});

test('100MB Ungate + Large Streaming Extract: >100MB (108 MiB) .tar.gz succeeds end-to-end on Node 24, formatBytesCompact handles GB, while symlink & 24KB rule guards still block', async () => {
  const ws = makeTempWorkspace('agy-v17-large-');
  const PAYLOAD_BYTES = 108 * 1024 * 1024; // 108 MiB (>100MB old gate)

  try {
    assert.equal(MAX_TARBALL_BYTES, 0, 'MAX_TARBALL_BYTES must be ungated (0)');

    const largeTarPath = join(ws.artifactsDir, 'large-108mb-plugin.tar.gz');
    const built = await buildLargeStreamingTarGz(largeTarPath, {
      topDir: 'big-plugin-v1',
      payloadBytes: PAYLOAD_BYTES,
      extraFiles: {
        'plugin.json': JSON.stringify({
          name: 'big-plugin',
          displayName: 'Big Plugin',
          version: '1.0.0',
          logo: 'assets/logo.svg',
        }),
        'assets/logo.svg': CLEAN_SVG,
        'skills/big/SKILL.md': '---\nname: big\ndescription: large binary plugin\n---\n# Big Plugin\n',
      },
    });

    // 1. streamUrlToFileAndHash via file://
    const dlFileDest = join(ws.root, 'dl-file.tar.gz');
    const dlFileRes = await streamUrlToFileAndHash(built.url, dlFileDest);
    assert.equal(dlFileRes.sha256, built.sha256);

    // 2. streamUrlToFileAndHash via HTTP
    const httpSrv = http.createServer((req, res) => {
      if (req.url === '/big.tar.gz') {
        const buf = readFileSync(largeTarPath);
        res.writeHead(200, { 'Content-Type': 'application/gzip', 'Content-Length': String(buf.length) });
        res.end(buf);
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise((r) => httpSrv.listen(0, '127.0.0.1', r));
    const httpPort = httpSrv.address().port;
    try {
      const dlHttpDest = join(ws.root, 'dl-http.tar.gz');
      const dlHttpRes = await streamUrlToFileAndHash(`http://127.0.0.1:${httpPort}/big.tar.gz`, dlHttpDest);
      assert.equal(dlHttpRes.sha256, built.sha256);
    } finally {
      httpSrv.close();
    }

    // 3. Streaming extractTarGzStreamToDir (O(MB) RAM) & sync extractTarGzToDir / parseTarGzWithMeta on Node 24
    const streamExtractDir = join(ws.root, 'extract-stream');
    await extractTarGzStreamToDir(largeTarPath, streamExtractDir);
    assert.equal(statSync(join(streamExtractDir, 'assets', 'large-model.bin')).size, PAYLOAD_BYTES);
    assert.equal(existsSync(join(streamExtractDir, 'plugin.json')), true);

    const syncExtractDir = join(ws.root, 'extract-sync');
    extractTarGzToDir(largeTarPath, syncExtractDir);
    assert.equal(statSync(join(syncExtractDir, 'assets', 'large-model.bin')).size, PAYLOAD_BYTES);
    const metaParsed = parseTarGzWithMeta(readFileSync(largeTarPath));
    assert.equal(metaParsed.files.get('assets/large-model.bin').length, PAYLOAD_BYTES);

    // 4. installOrUpdateCatalogPlugin end-to-end with 108 MiB plugin
    const installRes = await installOrUpdateCatalogPlugin({
      plugin: makeCatalogPlugin({
        id: 'acme__big-plugin',
        canonicalName: 'big-plugin',
        owner: 'acme',
        repo: 'big-plugin',
        displayName: 'Big Plugin',
        version: '1.0.0',
        repoId: 9103,
        tarballUrl: built.url,
        sha256: built.sha256,
        sizeBytes: built.compressedSize,
      }),
      track: 'verified',
      configDir: ws.configDir,
      dataDir: ws.dataDir,
    });
    assert.equal(installRes.ok, true);
    assert.equal(statSync(join(ws.pluginsDir, 'big-plugin', 'assets', 'large-model.bin')).size, PAYLOAD_BYTES);

    // 5. formatBytesCompact formats >=1GB cleanly as GB
    const { ui } = createUiVmHarness();
    assert.equal(ui.formatBytesCompact(1024 * 1024 * 1024), '1.00 GB');
    assert.equal(ui.formatBytesCompact(1.5 * 1024 * 1024 * 1024), '1.50 GB');

    // 6. Security gates MUST remain intact: symlink + >24KB rules/*.md
    const symTarPath = join(ws.artifactsDir, 'evil-symlink.tar.gz');
    writeFileSync(
      symTarPath,
      buildTarGzWithSymlink(
        { 'plugin.json': JSON.stringify({ name: 'evil-sym', version: '1.0.0' }) },
        { links: [{ name: 'bad-link', type: '2', target: '../secret' }] },
      ),
    );
    await assert.rejects(
      () => extractTarGzStreamToDir(symTarPath, join(ws.root, 'extract-sym')),
      /ERR_TAR_SYMLINK_FORBIDDEN/,
    );

    const ruleTarPath = join(ws.artifactsDir, 'oversized-rule.tar.gz');
    await buildLargeStreamingTarGz(ruleTarPath, {
      topDir: 'rule-plugin-main',
      payloadBytes: 0,
      extraFiles: {
        'plugin.json': JSON.stringify({ name: 'rule-plug', displayName: 'Rule Plug', version: '1.0.0' }),
        'rules/huge.md': 'A'.repeat(24_001),
      },
    });
    const ruleTarBuf = readFileSync(ruleTarPath);
    const ruleInspect = await inspectGithubPluginUrl({
      url: 'https://github.com/acme/rule-plug',
      configDir: ws.configDir,
      dataDir: ws.dataDir,
      fetchImpl: async (url) => {
        const u = String(url);
        if (u === 'https://api.github.com/repos/acme/rule-plug') {
          return jsonResp({ full_name: 'acme/rule-plug', default_branch: 'main', description: 'rule test' });
        }
        if (u.includes('codeload.github.com') || u.includes('archive')) {
          return binResp(ruleTarBuf);
        }
        return jsonResp({ message: 'Not Found' }, 404);
      },
    });
    assert.equal(ruleInspect.ok, false);
    assert.equal(ruleInspect.status, 'SECURITY_BLOCKED');
    assert.equal(ruleInspect.reasonCode, 'ERR_RULE_SIZE_EXCEEDED');

    // 7. Release workflow purity (pure LF, 0 BOM)
    const wfPath = join(REPO_ROOT, '.github', 'workflows', 'release.yml');
    const wfBuf = readFileSync(wfPath);
    assert.equal(wfBuf[0] === 0xef && wfBuf[1] === 0xbb && wfBuf[2] === 0xbf, false, 'release.yml must have 0 UTF-8 BOM');
    assert.equal(wfBuf.includes(0x0d), false, 'release.yml must be pure LF (0 CR)');
    const wfText = wfBuf.toString('utf8');
    assert.match(wfText, /node --test test\/\*\.test\.mjs/);
    assert.match(wfText, /node scripts\/build\.mjs --site/);
    assert.match(wfText, /node scripts\/pack-release\.mjs/);
  } finally {
    ws.cleanup();
  }
});
