import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { installOrUpdateCatalogPlugin, toggleInstalledPlugin, uninstallPlugin } from '../src/installer/index.mjs';
import { acquirePluginMutation, recoverInterruptedJournal } from '../src/installer/journal.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

function resolveRepoRoot() {
  const candidates = [
    resolve(__dirname, '..'),
    process.env.AGY_MARKET_ROOT ? resolve(process.env.AGY_MARKET_ROOT) : '',
    process.cwd(),
  ].filter(Boolean);

  for (const root of candidates) {
    if (
      existsSync(join(root, 'src', 'sidecar', 'server.mjs')) &&
      existsSync(join(root, 'src', 'updates', 'index.mjs')) &&
      existsSync(join(root, 'src', 'discussions', 'index.mjs')) &&
      existsSync(join(root, 'src', 'installer', 'index.mjs'))
    ) {
      return root;
    }
  }
  throw new Error(
    `Cannot locate overlaid agy-market repo root with src/updates/index.mjs and src/installer/index.mjs. Tried: ${candidates.join(', ')}`,
  );
}

const REPO_ROOT = resolveRepoRoot();
const { createMarketSidecarServer } = await import(pathToFileURL(join(REPO_ROOT, 'src', 'sidecar', 'server.mjs')).href);
const { createDeterministicTarGz } = await import(
  pathToFileURL(join(REPO_ROOT, 'src', 'installer', 'tar-extract.mjs')).href
);
const { resolveInstallPreflight, scanLocalPluginInventory } = await import(
  pathToFileURL(join(REPO_ROOT, 'src', 'preflight', 'index.mjs')).href
);

const CLEAN_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><rect x="16" y="16" width="96" height="96" rx="20" fill="#6366f1"/></svg>';

function makeTempWorkspace(prefix = 'agy-updates-test-') {
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

function buildTarArtifact(artifactsDir, fileName, filesObj) {
  const buf = createDeterministicTarGz(filesObj);
  const fullPath = join(artifactsDir, fileName);
  writeFileSync(fullPath, buf);
  const sha256 = createHash('sha256').update(buf).digest('hex');
  return {
    path: fullPath,
    url: pathToFileURL(fullPath).href,
    sha256,
    sizeBytes: buf.length,
  };
}

function installFakeLocalPlugin(pluginsDir, { dir, manifest, receipt = null }) {
  const dst = join(pluginsDir, dir);
  mkdirSync(dst, { recursive: true });
  writeFileSync(join(dst, 'plugin.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  if (receipt) {
    writeFileSync(join(dst, '.agy-market-receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
  }
}

function readAllFilesRecursively(dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      out.push(...readAllFilesRecursively(full));
    } else if (st.isFile()) {
      out.push({ path: full, content: readFileSync(full, 'utf8') });
    }
  }
  return out;
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
  badges = ['declarative-only'],
  hookEvents = [],
  mcpRemoteDomains = [],
}) {
  return {
    id,
    canonicalName,
    scopedName: `${owner}--${canonicalName}`,
    forceScopedInstall: false,
    displayName,
    description: { zh: displayName, en: displayName },
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
      preservePaths: [],
    },
    media: { iconUrl: null, screenshots: [] },
    taxonomy: { categories: ['productivity'], tags: [], platforms: ['win32', 'darwin', 'linux'] },
    capabilities: {
      badges,
      rulesEstimatedTokens: 0,
      mcpServers: [],
      mcpRemoteDomains,
      hookEvents,
      hostEnhancementKind: [],
    },
    updatedAt: '2026-11-23T12:00:00Z',
  };
}

async function openUpdateFixture(t, fetchImpl) {
  const ws = makeTempWorkspace();
  const server = await createMarketSidecarServer({
    configDir: ws.configDir, dataDir: ws.dataDir, listen: false, recoveryDelayMs: -1,
    currentSelfVersion: '1.0.0', onSelfRestart() {}, fetchImpl,
  });
  t.after(async () => { await server.close(); ws.cleanup(); });
  const post = async (url, body) => (await server.inject({
    method: 'POST', url, body, headers: { 'X-Sidecar-Token': server.sideToken },
  })).json();
  return { ws, server, post };
}

test('GitHub subdirectory updates check the component version and install from an archive containing that path', async t => {
  const repo = 'https://github.com/example/tools';
  const root = 'plugins/reader';
  let tag = 'v10.0.0';
  let version = '1.0.0';
  let flat = true;
  const reads = [];
  const manifest = v => ({ name: 'reader', version: v, repository: repo });
  const archive = prefix => createDeterministicTarGz({
    'release/README.md': 'release', ['release/' + prefix + 'plugin.json']: JSON.stringify(manifest(version)),
  });
  const { ws, server, post } = await openUpdateFixture(t, async url => {
    if (url.endsWith('/index.json')) return Response.json({ plugins: [] });
    if (url.includes('/repos/example/tools/releases/')) return Response.json({ tag_name: tag, assets: [
      { name: 'tools.tar.gz', browser_download_url: repo + '/releases/download/' + tag + '/tools.tar.gz' },
    ] });
    if (url.includes('/repos/example/tools/tags?')) return Response.json([{ name: tag }]);
    if (url.includes('raw.githubusercontent.com/example/tools/') && url.endsWith(root + '/plugin.json')) return Response.json(manifest(version));
    if (url.includes('/releases/download/')) { reads.push('asset'); return new Response(archive(flat ? '' : root + '/')); }
    if (url.includes('/tools/archive/')) { reads.push('source'); return new Response(archive(root + '/')); }
    return new Response('{}', { status: 404 });
  });
  const receipt = { id: 'example__tools--plugins-reader', track: 'github-url', repositoryUrl: repo,
    pluginRoot: root, installedVersion: '9.0.0', gitTag: 'v9.0.0', managedFiles: ['plugin.json'] };
  installFakeLocalPlugin(ws.pluginsDir, { dir: 'reader', manifest: manifest('7.0.0'), receipt });
  const check = async () => (await server.inject({ url: '/api/updates?force=1' })).json().items.filter(i => i.dir === 'reader');
  const update = targetRef => post('/api/update', { dir: 'reader', updateChannel: 'github-url', updateKind: 'semver', targetRef });
  assert.deepEqual(await check(), []);
  const rejected = await update(tag);
  assert.match(rejected.error, /ERR_UPDATE_DOWNGRADE/);
  const dir = join(ws.pluginsDir, 'reader');
  assert.equal(JSON.parse(readFileSync(join(dir, 'plugin.json'))).version, '7.0.0');
  assert.deepEqual(JSON.parse(readFileSync(join(dir, '.agy-market-receipt.json'))), receipt);
  reads.length = 0;
  const { pluginRoot, ...legacyReceipt } = receipt;
  installFakeLocalPlugin(ws.pluginsDir, { dir: 'reader', receipt: legacyReceipt,
    manifest: { ...manifest('7.0.0'), repository: { url: repo, directory: pluginRoot } } });
  tag = 'v2.0.0';
  version = '8.0.0';
  const [offered] = await check();
  assert.equal(offered.latestVersion, version);
  assert.equal(offered.installedVersion, '7.0.0');
  assert.equal((await update(offered.targetRef)).status, 'INSTALLED');
  assert.deepEqual(reads, ['asset', 'source']);
  assert.equal(JSON.parse(readFileSync(join(dir, '.agy-market-receipt.json'))).installedVersion, version);
  assert.deepEqual(await check(), []);
  reads.length = 0;
  tag = 'v2.1.0';
  version = '8.1.0';
  flat = false;
  assert.equal((await update(tag)).status, 'INSTALLED');
  assert.deepEqual(reads, ['asset']);
});

test('upstream updates retain the installed repository when another feed reuses its ID', async t => {
  const id = 'community__reader';
  const repo = 'https://github.com/first/reader';
  const other = { id, canonicalName: 'reader', version: '1.0.0', repository: { url: 'https://github.com/second/reader', repositoryId: 91 } };
  const manifest = version => ({ name: 'reader', version, repository: repo });
  const archive = createDeterministicTarGz({ 'reader/plugin.json': JSON.stringify(manifest('2.0.0')) });
  const { ws, server, post } = await openUpdateFixture(t, async url => {
    if (url.endsWith('/index.json')) return Response.json({ plugins: [other] });
    if (url.endsWith('/repos/first/reader')) return Response.json({ id: 23, default_branch: 'main' });
    if (url.includes('/repos/first/reader/releases/')) return Response.json({ tag_name: 'v2.0.0', assets: [
      { name: 'reader.tar.gz', browser_download_url: repo + '/releases/download/v2.0.0/reader.tar.gz' },
    ] });
    if (url.includes('/repos/first/reader/tags?')) return Response.json([{ name: 'v2.0.0' }]);
    if (url.includes('/first/reader/releases/download/') || url.includes('/first/reader/archive/')) return new Response(archive);
    return new Response('{}', { status: 404 });
  });
  for (const action of ['single', 'all', 'selected']) {
    installFakeLocalPlugin(ws.pluginsDir, { dir: 'reader', manifest: manifest('1.0.0'),
      receipt: { id, installedVersion: '1.0.0', repositoryUrl: repo, track: 'github-url', pluginRoot: '.' } });
    const report = (await server.inject({ url: '/api/updates?force=1' })).json();
    const item = report.items.find(i => i.dir === 'reader');
    assert.equal(item?.repositoryUrl, repo);
    if (action === 'single') {
      const result = await post('/api/update', { ...item, id, dir: 'reader' });
      assert.equal(result.ok, true, JSON.stringify(result.error));
    } else {
      await post('/api/update-all', action === 'selected' ? { ids: ['reader'] } : {});
    }
    const saved = JSON.parse(readFileSync(join(ws.pluginsDir, 'reader', '.agy-market-receipt.json')));
    assert.equal(saved.installedVersion, '2.0.0', action);
    assert.equal(saved.repositoryUrl, repo);
    assert.notEqual(saved.repositoryId, other.repository.repositoryId, action);
  }
});

test('four-part revisions upgrade numerically and cannot be downgraded by resync', async t => {
  const older = '2026.10.25.9', newer = '2026.10.25.10';
  const repo = 'https://github.com/demo/calendar';
  const manifest = version => ({ name: 'calendar', repository: repo, version });
  const plugin = makeCatalogPlugin({ id: 'demo__calendar', canonicalName: 'calendar', displayName: 'Calendar',
    owner: 'demo', repo: 'calendar', repoId: 42, version: newer, tarballUrl: 'https://example.com/calendar.tgz' });
  let archive;
  function publish(version) {
    archive = createDeterministicTarGz({ 'plugin.json': JSON.stringify(manifest(version)) });
    Object.assign(plugin, { version, gitTag: 'v' + version });
    plugin.distribution.sha256 = createHash('sha256').update(archive).digest('hex');
  }
  publish(newer);
  const { ws, server, post } = await openUpdateFixture(t, async url => {
    if (url === plugin.distribution.tarballUrl) return new Response(archive);
    if (url.endsWith('/index.json')) return Response.json({ plugins: [plugin] });
    return new Response('{}', { status: 404 });
  });
  installFakeLocalPlugin(ws.pluginsDir, { dir: 'calendar', manifest: manifest(older),
    receipt: { id: plugin.id, repositoryId: 42, repositoryUrl: repo, track: 'verified', installedVersion: older, gitTag: 'v' + older } });
  const updates = async () => (await server.inject({ url: '/api/updates?force=1' })).json().items.filter(i => i.dir === 'calendar');
  const req = { dir: 'calendar', id: plugin.id };
  assert.deepEqual((await updates()).map(i => i.latestVersion), [newer]);
  assert.equal((await post('/api/update', req)).ok, true);
  publish(older);
  await server.inject({ url: '/api/state?refresh=1' });
  assert.deepEqual(await updates(), []);
  assert.equal((await post('/api/update', req)).status, 'ALREADY_UP_TO_DATE');
  assert.match((await post('/api/update', { ...req, forceResync: true })).error, /ERR_UPDATE_DOWNGRADE/);
  assert.equal(JSON.parse(readFileSync(join(ws.pluginsDir, 'calendar', 'plugin.json'))).version, newer);
});

test('upstream updates follow a verified repository transfer and save the new address', async t => {
  const oldUrl = 'https://github.com/first/reader', newUrl = 'https://github.com/second/reader';
  const id = 'first__reader', tag = 'v2.0.0';
  const plugin = { id, canonicalName: 'reader', version: '1.0.0', repository: { url: newUrl, repositoryId: 42 } };
  const archive = createDeterministicTarGz({ 'reader/plugin.json': JSON.stringify({ name: 'reader', repository: newUrl, version: '2.0.0' }) });
  let liveId = 91, archiveRequests = 0;
  const { ws, server, post } = await openUpdateFixture(t, async url => {
    if (url.endsWith('/index.json')) return Response.json({ plugins: [plugin] });
    if (url.endsWith('/repos/second/reader')) return Response.json({ id: liveId });
    if (url.includes('/repos/second/reader/releases/')) return Response.json({ tag_name: tag, assets: [] });
    if (url.includes('/repos/second/reader/tags?')) return Response.json([{ name: tag }]);
    if (url.includes('/second/reader/archive/')) { archiveRequests++; return new Response(archive); }
    return new Response('{}', { status: 404 });
  });
  const installOld = () => installFakeLocalPlugin(ws.pluginsDir, { dir: 'reader',
    manifest: { name: 'reader', version: '1.0.0', repository: oldUrl },
    receipt: { id, track: 'verified', repositoryId: 42, repositoryUrl: oldUrl, installedVersion: '1.0.0', gitTag: 'v1.0.0' } });
  installOld();
  const report = async () => (await server.inject({ url: '/api/updates?force=1' })).json().items.find(i => i.dir === 'reader');
  const item = await report();
  assert.equal(item.repositoryUrl, newUrl);
  assert.match((await post('/api/update', item)).error, /ERR_UPDATE_TARGET_MISMATCH/);
  liveId = 42;
  assert.match((await post('/api/update', { ...item, pluginRoot: 'plugins/other' })).error, /ERR_UPDATE_TARGET_MISMATCH/);
  assert.match((await post('/api/update', { ...item, repositoryUrl: 'https://github.com/unrelated/reader' })).error, /ERR_UPDATE_TARGET_MISMATCH/);
  assert.equal(archiveRequests, 0);
  for (const action of ['single', 'batch']) {
    installOld();
    if (action === 'single') assert.equal((await post('/api/update', item)).ok, true);
    else assert.equal((await post('/api/update-all', { ids: ['reader'] })).results[0].ok, true);
    const saved = JSON.parse(readFileSync(join(ws.pluginsDir, 'reader', '.agy-market-receipt.json')));
    assert.equal(saved.repositoryId, 42);
    assert.equal(saved.repositoryUrl, newUrl);
    assert.equal(saved.id, id);
    assert.equal(saved.installedVersion, '2.0.0');
    assert.equal(await report(), undefined);
  }
});

test('catalog README fallback uses only the installed copy from the selected source', async t => {
  const entry = owner => ({ id: owner + '__reader', canonicalName: 'reader', version: '1.0.0',
    repository: { url: 'https://github.com/' + owner + '/reader' } });
  const { ws, server } = await openUpdateFixture(t, async url => {
    if (url.endsWith('/index.json')) return Response.json({ plugins: [entry('alice'), entry('bob')] });
    if (url.endsWith('/readmes/bob__reader.json')) return Response.json({ id: 'bob__reader', en: 'Bob instructions' });
    return new Response(null, { status: 404 });
  });
  installFakeLocalPlugin(ws.pluginsDir, { dir: 'reader',
    manifest: { name: 'reader', version: '1.0.0', repository: entry('alice').repository.url } });
  writeFileSync(join(ws.pluginsDir, 'reader', 'README.zh.md'), 'Alice instructions');
  const read = async (id, dir) => (await server.inject({
    url: '/api/readme?' + new URLSearchParams({ id, dir, locale: 'zh' }),
  })).json().markdown;
  // The first request can arrive before the UI has loaded /api/state.
  assert.equal(await read('bob__reader', 'reader'), 'Bob instructions');
  assert.equal(await read('alice__reader', ''), 'Alice instructions');
  assert.equal(await read('missing__reader', 'reader'), '');
  assert.equal(await read('', 'reader'), 'Alice instructions');
});

test('custom README requests use the winning feed for live, monolithic and offline documentation', async t => {
  const id = 'demo__reader', feed = 'https://catalog.example/custom/index.json';
  const entry = owner => ({ id, canonicalName: 'reader', version: '1.0.0', repository: { url: 'https://github.com/' + owner + '/reader' } });
  let offline = false;
  const { ws, server, post } = await openUpdateFixture(t, async url => {
    if (offline) throw new Error('offline');
    if (url.endsWith('/index.json')) return Response.json({ plugins: [entry(url.startsWith('https://catalog.example/') ? 'company' : 'community')] });
    if (url === new URL('readmes.json', feed).href) return Response.json({ entriesEn: { [id]: 'Company instructions' } });
    if (!url.startsWith('https://catalog.example/') && url.endsWith('/readmes/' + id + '.json')) return Response.json({ id, en: 'Community instructions' });
    return new Response('{}', { status: 404 });
  });
  const read = async () => (await server.inject({ url: '/api/readme?id=' + id + '&dir=reader&locale=en' })).json().markdown;
  await server.inject({ url: '/api/state' });
  assert.equal(await read(), 'Community instructions');
  const state = await post('/api/sources', { customFeeds: [feed] });
  assert.equal(state.catalog.plugins[0].repository.url, entry('company').repository.url);
  assert.equal(await read(), 'Company instructions');
  offline = true;
  const reopened = (await server.inject({ url: '/api/state?panelOpen=1' })).json();
  assert.equal(reopened.catalog.plugins[0]._feedUrl, feed);
  assert.equal(reopened.catalog.plugins[0].repository.url, entry('company').repository.url);
  assert.deepEqual(reopened.catalog.failedCustomFeeds.map(f => f.url), [feed]);
  assert.equal(await read(), 'Company instructions');
  const cold = await createMarketSidecarServer({ configDir: ws.configDir, dataDir: ws.dataDir, listen: false,
    recoveryDelayMs: -1, fetchImpl: async () => { throw new Error('offline'); } });
  try {
    const snapshot = (await cold.inject({ url: '/api/state?panelOpen=1' })).json();
    assert.equal(snapshot.catalog.plugins[0]._feedUrl, feed);
    assert.equal((await cold.inject({ url: '/api/readme?id=' + id + '&locale=en' })).json().markdown, 'Company instructions');
  } finally { await cold.close(); }
  offline = false;
  installFakeLocalPlugin(ws.pluginsDir, { dir: 'reader', manifest: { name: 'reader', version: '1.0.0', repository: entry('community').repository.url } });
  writeFileSync(join(ws.pluginsDir, 'reader', 'README.md'), 'Unrelated local instructions');
  await post('/api/sources', { customFeeds: ['https://catalog.example/empty/index.json'] });
  assert.equal(await read(), '');
  await post('/api/sources', { customFeeds: [] });
  assert.equal(await read(), 'Community instructions');
});

test('a transferred Track 2 entry updates its original scoped installation under the new catalog ID', async t => {
  const dir = 'first--reader', oldUrl = 'https://github.com/first/reader', newUrl = 'https://github.com/second/reader';
  const manifest = { name: 'reader', version: '2.0.0', repository: newUrl };
  const archive = createDeterministicTarGz({ 'plugin.json': JSON.stringify(manifest) });
  const plugin = makeCatalogPlugin({ id: 'second__reader', canonicalName: 'reader', displayName: 'Reader',
    owner: 'second', repo: 'reader', repoId: 42, version: manifest.version, tarballUrl: 'https://example.com/new.tgz',
    sha256: createHash('sha256').update(archive).digest('hex') });
  const { ws, server, post } = await openUpdateFixture(t, async url => {
    if (url.endsWith('/unverified-index.json')) return Response.json({ plugins: [plugin] });
    if (url.endsWith('/index.json')) return Response.json({ plugins: [] });
    if (url === plugin.distribution.tarballUrl || url.includes('/second/reader/archive/')) return new Response(archive);
    if (url.endsWith('/repos/second/reader')) return Response.json({ id: 42 });
    if (url.includes('/repos/second/reader/releases/')) return Response.json({ tag_name: 'v2.0.0', assets: [] });
    return new Response('{}', { status: 404 });
  });
  await post('/api/prefs', { enableExperimentalTrack2: true });
  for (const channel of ['catalog', 'upstream', 'recovery']) {
    const prefsPath = join(ws.dataDir, 'prefs.json');
    const oldId = 'first__reader';
    const other = { catalogId: oldId, repositoryUrl: oldUrl, pluginRoot: 'plugins/other' };
    const foreign = { catalogId: oldId, repositoryUrl: 'https://github.com/other/reader', pluginRoot: '.' };
    writeFileSync(prefsPath, JSON.stringify({ ...JSON.parse(readFileSync(prefsPath)),
      favorites: [oldId, 'saved:other-root', 'saved:foreign'],
      favoriteSources: { [oldId]: { repositoryUrl: oldUrl, pluginRoot: '.', trackBranch: 'stable' },
        'saved:other-root': other, 'saved:foreign': foreign } }));
    installFakeLocalPlugin(ws.pluginsDir, { dir, manifest: { name: dir, version: '1.0.0', repository: oldUrl },
      receipt: { id: 'first__reader', track: 'unverified', repositoryUrl: oldUrl, repositoryId: 42, pluginRoot: '.',
        installedVersion: '1.0.0', scopedRewriteApplied: true, effectivePluginName: dir } });
    const state = (await server.inject({ url: '/api/state' })).json();
    assert.equal(state.catalog.plugins.find(p => p.id === plugin.id).installStatus.installedDir, dir);
    let updated;
    if (channel === 'recovery') {
      await assert.rejects(installOrUpdateCatalogPlugin({ ...ws, plugin: state.catalog.plugins.find(p => p.id === plugin.id),
        track: 'unverified', fetchImpl: async () => new Response(archive),
        writeOverride() { throw new Error('interrupted transfer'); } }), /interrupted transfer/);
      assert.equal(JSON.parse(readFileSync(prefsPath)).favoriteSources[oldId].repositoryUrl, oldUrl);
      assert.equal(recoverInterruptedJournal(ws).action, 'completed-forward');
      updated = (await server.inject({ url: '/api/state' })).json().prefs;
    } else {
      const result = channel === 'upstream'
        ? await post('/api/update', { id: plugin.id, dir, updateChannel: 'github-upstream', targetRef: 'v2.0.0' })
        : await post('/api/install', { id: plugin.id });
      assert.equal(result.ok, true, JSON.stringify(result.error));
      updated = result.state.prefs;
    }
    assert.deepEqual(readdirSync(ws.pluginsDir), [dir]);
    const saved = JSON.parse(readFileSync(join(ws.pluginsDir, dir, '.agy-market-receipt.json')));
    assert.equal(saved.id, plugin.id);
    assert.equal(saved.repositoryUrl, newUrl);
    assert.equal(saved.effectivePluginName, dir);
    assert.equal(saved.installedVersion, '2.0.0');
    assert.deepEqual(updated.favorites, [plugin.id, 'saved:other-root', 'saved:foreign']);
    assert.equal(updated.favoriteSources[plugin.id].repositoryUrl, newUrl);
    assert.equal(updated.favoriteSources[plugin.id].trackBranch, 'stable');
    assert.equal(updated.favoriteSources['saved:other-root'].pluginRoot, other.pluginRoot);
    assert.equal(updated.favoriteSources['saved:foreign'].repositoryUrl, foreign.repositoryUrl);
    assert.deepEqual(JSON.parse(readFileSync(prefsPath)).favorites, updated.favorites);
  }
});

test('a tracked branch rollback is skipped while same-version commits still update', async t => {
  const installed = 'a'.repeat(40), repo = 'https://github.com/demo/reader';
  let head = 'b'.repeat(40), version = '1.0.0';
  const { ws, server, post } = await openUpdateFixture(t, async url => {
    if (url.endsWith('/index.json')) return Response.json({ plugins: [] });
    if (url.endsWith('/repos/demo/reader/commits/main')) return Response.json({ sha: head });
    if (url.includes('/repos/demo/reader/tags?')) return Response.json([]);
    if (url.endsWith(head + '/plugin.json')) return Response.json({ name: 'reader', version });
    return new Response('{}', { status: 404 });
  });
  installFakeLocalPlugin(ws.pluginsDir, { dir: 'reader', manifest: { name: 'reader', version: '2.0.0', repository: repo },
    receipt: { id: 'demo__reader', track: 'github-url', repositoryUrl: repo, commitSha: installed, installedVersion: '2.0.0',
      githubSource: { trackBranch: 'main', refType: 'branch', ref: 'main' } } });
  const offers = async () => (await server.inject({ url: '/api/updates?force=1' })).json().items.filter(i => i.dir === 'reader');
  assert.deepEqual(await offers(), []);
  assert.deepEqual((await post('/api/update-all', {})).results, []);
  assert.equal((await post('/api/update-all', { ids: ['reader'] })).results[0].status, 'ALREADY_UP_TO_DATE');
  head = 'c'.repeat(40);
  version = '2.0.0';
  assert.deepEqual((await offers()).map(i => [i.targetRef, i.updateKind]), [[head, 'commit']]);
});

test('monorepo branch checks use the same repository head across REST, Atom and Git refs', async t => {
  const repo = 'https://github.com/example/tools';
  const root = 'plugins/reader';
  const old = 'a'.repeat(40), installed = 'b'.repeat(40), next = 'c'.repeat(40);
  let head = installed;
  let lastChildChange = old;
  let channel = 'rest';
  const { ws, server, post } = await openUpdateFixture(t, async url => {
    if (url.endsWith('/index.json')) return Response.json({ plugins: [] });
    if (url.includes('/repos/example/tools/tags?')) return Response.json([]);
    if (url.endsWith('/repos/example/tools/commits/main') && channel === 'rest') return Response.json({ sha: head });
    if (url.endsWith('/tools/commits/main.atom') && channel === 'atom') {
      return new Response('<entry><id>Grit::Commit/' + head + '</id></entry>');
    }
    if (url.includes('/tools.git/info/refs') && channel === 'refs') return new Response(head + ' HEAD\n' + head + ' refs/heads/main\n');
    if (url.includes('/repos/example/tools/commits?')) {
      const { searchParams } = new URL(url);
      assert.equal(searchParams.get('path'), root);
      return Response.json([{ sha: searchParams.get('sha') === installed ? old : lastChildChange }]);
    }
    return new Response('{}', { status: 404 });
  });
  installFakeLocalPlugin(ws.pluginsDir, { dir: 'reader', manifest: { name: 'reader', version: '2.0.0', repository: repo },
    receipt: { id: 'example__reader', track: 'github-url', repositoryUrl: repo, pluginRoot: root, commitSha: installed,
      githubSource: { refType: 'branch', trackBranch: 'main' } } });
  const check = async () => (await server.inject({ url: '/api/updates?force=1' })).json();
  for (channel of ['rest', 'atom', 'refs']) {
    const report = await check();
    assert.deepEqual(report.items, []);
    assert.ok(!report.uncheckedDirs.includes('reader'));
  }
  head = next;
  assert.deepEqual((await check()).items, []);
  head = 'd'.repeat(40);
  lastChildChange = next;
  const report = await check();
  assert.deepEqual(report.items.map(item => [item.dir, item.targetRef]), [['reader', head]]);
  // A legacy receipt can recover the child path from the declared repository.
  installFakeLocalPlugin(ws.pluginsDir, { dir: 'reader', manifest: { name: 'reader', version: '2.0.0', repository: { url: repo, directory: root } },
    receipt: { id: 'example__reader', track: 'github-url', repositoryUrl: repo, commitSha: installed,
      githubSource: { refType: 'branch', trackBranch: 'main' } } });
  channel = 'rest';
  head = 'e'.repeat(40);
  lastChildChange = old;
  assert.deepEqual((await check()).items.filter(item => item.dir === 'reader'), []);
  const stale = await post('/api/update', { dir: 'reader', updateChannel: 'github-url', updateKind: 'commit', targetRef: head });
  assert.equal(stale.status, 'UPDATE_TARGET_MISMATCH');
});

test('self-update selects the official entry across a same-name fork and protects a Git checkout', async t => {
  let official;
  const { ws, server, post } = await openUpdateFixture(t, async url => {
    if (!url.endsWith('/index.json')) return new Response('{}', { status: 404 });
    const fork = { ...official, id: 'example__fork', scopedName: 'example--agy-market', forceScopedInstall: true,
      repository: { url: 'https://github.com/example/fork', repositoryId: 11 } };
    return Response.json({ plugins: [fork, official] });
  });
  const repository = 'https://github.com/azwosile/agy-market';
  const manifest = { name: 'agy-market', version: '1.0.0', repository };
  const tar = buildTarArtifact(ws.artifactsDir, 'market.tgz', { 'plugin.json': JSON.stringify({ ...manifest, version: '2.0.0' }) });
  official = makeCatalogPlugin({ id: 'azwosile__agy-market', canonicalName: 'agy-market', owner: 'azwosile',
    repo: 'agy-market', displayName: 'Market', version: '2.0.0', repoId: 12, tarballUrl: tar.url, sha256: tar.sha256 });
  installFakeLocalPlugin(ws.pluginsDir, { dir: 'agy-market', manifest });
  const git = join(ws.pluginsDir, 'agy-market', '.git');
  mkdirSync(git);
  assert.equal((await server.inject({ url: '/api/updates?force=1' })).json().selfUpdate, null);
  assert.equal((await post('/api/self-update', {})).status, 'UNMANAGED_PLUGIN');
  assert.deepEqual(JSON.parse(readFileSync(join(ws.pluginsDir, 'agy-market', 'plugin.json'))), manifest);
  rmSync(git, { recursive: true });
  await server.inject({ url: '/api/state?refresh=1' });
  const updated = await post('/api/self-update', { targetVersion: '2.0.0' });
  assert.equal(updated.installedDir, 'agy-market', updated.error);
  assert.equal(updated.receipt.id, official.id);
  assert.equal(existsSync(join(ws.pluginsDir, 'example--agy-market')), false);
});

test('single and batch capability consent follows the displayed release, archive, directory and grants', async t => {
  let current;
  const { ws, post, server } = await openUpdateFixture(t, async url =>
    url.endsWith('/index.json') ? Response.json({ plugins: [current] }) : new Response('{}', { status: 404 }));
  const id = 'owner__reader';
  const manifest = { name: 'reader', repository: 'https://github.com/owner/reader', version: '1.0.0' };
  installFakeLocalPlugin(ws.pluginsDir, { dir: 'reader', manifest });
  const tar = buildTarArtifact(ws.artifactsDir, 'reader.tgz', { 'plugin.json': JSON.stringify({ ...manifest, version: '2.0.0' }) });
  current = makeCatalogPlugin({ id, canonicalName: 'reader', owner: 'owner', repo: 'reader', repoId: 55,
    displayName: 'Reader', version: '2.0.0', tarballUrl: tar.url, sha256: tar.sha256, badges: ['mcp-remote'] });
  const request = { id, dir: 'reader' };
  const first = await post('/api/update', request);
  const firstKey = first.escalation.approvalKey;
  assert.match(firstKey, /^[0-9a-f]{64}$/);
  assert.equal((await post('/api/update', { ...request, confirmEscalation: true })).status, 'CAPABILITY_ESCALATION_CONFIRM_REQUIRED');
  current.capabilities.mcpRemoteDomains = ['new.example'];
  await server.inject({ url: '/api/state?refresh=1' });
  const changed = await post('/api/update', { ...request, confirmEscalation: true, approvalKey: firstKey });
  assert.equal(changed.status, 'CAPABILITY_ESCALATION_CONFIRM_REQUIRED');
  assert.deepEqual(changed.escalation.addedRemoteDomains, ['new.example']);
  assert.notEqual(changed.escalation.approvalKey, firstKey);
  const stale = await post('/api/update-all', { ids: ['reader'], confirmEscalation: true, approvalKeys: { reader: firstKey } });
  assert.equal(stale.results[0].status, 'CAPABILITY_ESCALATION_CONFIRM_REQUIRED');
  current.distribution.commitFallbackSha256 = 'd'.repeat(64);
  await server.inject({ url: '/api/state?refresh=1' });
  const newFallback = await post('/api/update', { ...request, confirmEscalation: true, approvalKey: changed.escalation.approvalKey });
  assert.equal(newFallback.status, 'CAPABILITY_ESCALATION_CONFIRM_REQUIRED');
  assert.notEqual(newFallback.escalation.approvalKey, changed.escalation.approvalKey);
  const sameVersionTar = buildTarArtifact(ws.artifactsDir, 'reader-repacked.tgz', {
    'plugin.json': JSON.stringify({ ...manifest, version: '2.0.0' }), 'readme.txt': 'repacked',
  });
  Object.assign(current.distribution, { sha256: sameVersionTar.sha256, tarballUrl: sameVersionTar.url });
  await server.inject({ url: '/api/state?refresh=1' });
  const repacked = await post('/api/update-all', { ids: ['reader'], confirmEscalation: true,
    approvalKeys: { reader: newFallback.escalation.approvalKey } });
  assert.equal(repacked.results[0].status, 'CAPABILITY_ESCALATION_CONFIRM_REQUIRED');
  assert.equal(JSON.parse(readFileSync(join(ws.pluginsDir, 'reader', 'plugin.json'))).version, '1.0.0');
  const approved = await post('/api/update-all', { ids: ['reader'], confirmEscalation: true,
    approvalKeys: { reader: repacked.results[0].escalation.approvalKey } });
  assert.equal(approved.results[0].status, 'INSTALLED', approved.results[0].error);
});

test('catalog writes follow the active source after a withdrawal, release rollback or Track 2 toggle', async t => {
  const feed = 'https://feed.example/catalog.json';
  let primary = [], custom = [], experimental = [];
  const { ws, server, post } = await openUpdateFixture(t, async url => {
    if (url === feed) return Response.json({ plugins: custom });
    if (url.endsWith('/index.json')) return Response.json({ plugins: primary });
    if (url.endsWith('/unverified-index.json')) return Response.json({ plugins: experimental });
    return new Response('{}', { status: 404 });
  });
  const manifest = { name: 'reader', version: '1.0.0' };
  const tar = buildTarArtifact(ws.artifactsDir, 'reader.tgz', { 'plugin.json': JSON.stringify(manifest) });
  const entry = makeCatalogPlugin({ id: 'owner__reader', canonicalName: 'reader', displayName: 'Reader', owner: 'owner',
    repo: 'reader', repoId: 55, version: manifest.version, tarballUrl: tar.url, sha256: tar.sha256 });
  primary = [entry];
  custom = [{ ...entry, version: '2.0.0', gitTag: 'v2.0.0' }];
  const oldCustom = (await post('/api/sources', { customFeeds: [feed] })).catalog.plugins[0];
  await post('/api/sources', { customFeeds: [] });
  assert.equal((await post('/api/install', { plugin: oldCustom })).status, 'CATALOG_ENTRY_CHANGED');
  assert.equal(existsSync(join(ws.pluginsDir, 'reader')), false);

  primary = [];
  experimental = [entry];
  const oldTrack2 = (await post('/api/prefs', { enableExperimentalTrack2: true })).catalog.plugins[0];
  await post('/api/prefs', { enableExperimentalTrack2: false });
  assert.equal((await post('/api/install', { plugin: oldTrack2 })).status, 'CATALOG_ENTRY_CHANGED');
  assert.equal(existsSync(join(ws.pluginsDir, 'owner--reader')), false);

  primary = [entry];
  await server.inject({ url: '/api/state?refresh=1' });
  const stale = { ...entry, version: '2.0.0', distribution: { tarballUrl: 'https://withdrawn.example/reader.tgz', sha256: 'f'.repeat(64) } };
  const good = await post('/api/install', { plugin: stale });
  assert.equal(good.version, '1.0.0', good.error);
  primary = [];
  await server.inject({ url: '/api/state?refresh=1' });
  assert.equal((await post('/api/update', { dir: 'reader', plugin: stale })).status, 'CATALOG_ENTRY_CHANGED');
  assert.equal(JSON.parse(readFileSync(join(ws.pluginsDir, 'reader', 'plugin.json'))).version, '1.0.0');
});

test('a changed installed commit invalidates branch cache and stale single-update targets', async t => {
  const first = 'a'.repeat(40), next = 'b'.repeat(40);
  let remote = first, probes = 0, offline = false;
  const { ws, server, post } = await openUpdateFixture(t, async url => {
    if (url.endsWith('/index.json')) return Response.json({ plugins: [] });
    if (url.endsWith('/commits/preview')) {
      probes++;
      if (!offline) return Response.json({ sha: remote });
    }
    return new Response('{}', { status: 404 });
  });
  const repo = 'https://github.com/owner/reader';
  const receipt = { id: 'owner__reader', track: 'github-url', repositoryUrl: repo, pluginRoot: '.', commitSha: first,
    githubSource: { refType: 'branch', ref: 'preview', trackBranch: 'preview' } };
  installFakeLocalPlugin(ws.pluginsDir, { dir: 'reader', manifest: { name: 'reader', version: '1.0.0', repository: repo }, receipt });
  const check = async () => (await server.inject({ url: '/api/updates' })).json();
  assert.deepEqual((await check()).items, []);
  assert.equal(probes, 1);
  assert.deepEqual((await check()).items, []);
  assert.equal(probes, 1);
  const receiptPath = join(ws.pluginsDir, 'reader', '.agy-market-receipt.json');
  writeFileSync(receiptPath, JSON.stringify({ ...receipt, commitSha: next }));
  remote = next;
  offline = true;
  const unchecked = await check();
  assert.deepEqual(unchecked.items, []);
  assert.ok(unchecked.uncheckedDirs.includes('reader'));
  offline = false;
  assert.deepEqual((await check()).items, []);
  assert.equal(probes, 3);
  const stale = await post('/api/update', { id: receipt.id, dir: 'reader', updateChannel: 'github-url', updateKind: 'commit', targetRef: first });
  assert.equal(stale.status, 'UPDATE_TARGET_MISMATCH');
  assert.equal(JSON.parse(readFileSync(receiptPath)).commitSha, next);
});

test('a README or homepage alone does not nominate an update source', async t => {
  const linkedRepo = 'https://github.com/example/guide';
  let repoRequests = 0;
  const { ws, server, post } = await openUpdateFixture(t, async url => {
    if (url.includes('/example/guide/')) repoRequests++;
    if (url.endsWith('/index.json')) return Response.json({ plugins: [] });
    return new Response('{}', { status: 404 });
  });
  for (const dir of ['readme-only', 'homepage-only']) {
    const manifest = { name: dir, version: '1.0.0' };
    if (dir === 'homepage-only') manifest.homepage = linkedRepo;
    installFakeLocalPlugin(ws.pluginsDir, { dir, manifest });
    if (dir === 'readme-only') writeFileSync(join(ws.pluginsDir, dir, 'README.md'), linkedRepo);
  }
  const report = (await server.inject({ url: '/api/updates?force=1' })).json();
  assert.deepEqual(report.items, []);
  assert.deepEqual(report.uncheckedDirs, ['homepage-only', 'readme-only']);
  for (const dir of report.uncheckedDirs) {
    const rejected = await post('/api/update', { id: dir, dir, preferUpstream: true, repositoryUrl: linkedRepo });
    assert.equal(rejected.status, 'UNVERIFIED_UPDATE_SOURCE');
  }
  const batch = await post('/api/update-all', { ids: report.uncheckedDirs });
  assert.ok(batch.results.every(item => item.status === 'UPDATE_TARGET_ERROR'));
  assert.equal(repoRequests, 0);
});

test('a removed tracked branch cannot borrow the default branch commit', async t => {
  const defaultSha = 'b'.repeat(40);
  const { ws, server } = await openUpdateFixture(t, async url => {
    if (url.endsWith('/index.json')) return Response.json({ plugins: [] });
    if (url.includes('/info/refs')) return new Response(`${defaultSha} HEAD\n${defaultSha} refs/heads/main\n`);
    return new Response('{}', { status: 404 });
  });
  const repository = 'https://github.com/owner/reader';
  installFakeLocalPlugin(ws.pluginsDir, { dir: 'reader', manifest: { name: 'reader', version: '1.0.0', repository },
    receipt: { id: 'owner__reader', track: 'github-url', repositoryUrl: repository, commitSha: 'a'.repeat(40),
      githubSource: { kind: 'tree', refType: 'branch', ref: 'preview', trackBranch: 'preview' } } });
  const report = (await server.inject({ url: '/api/updates?force=1' })).json();
  assert.deepEqual(report.items, []);
  assert.ok(report.uncheckedDirs.includes('reader'));
});

test('resync rejects an older catalog and malformed neighboring rows leave working entries available offline', async t => {
  let offline = false;
  let downloads = 0;
  const plugin = makeCatalogPlugin({ id: 'owner__reader', canonicalName: 'reader', owner: 'owner', repo: 'reader', repoId: 55,
    displayName: 'Reader', version: '1.0.0', tarballUrl: 'https://example.com/reader.tgz', sha256: 'a'.repeat(64) });
  const { ws, server, post } = await openUpdateFixture(t, async url => {
    if (url === plugin.distribution.tarballUrl) downloads++;
    if (!offline && url.endsWith('/index.json')) return Response.json({ plugins: [
      { id: 'old-entry' }, { ...plugin, id: 'bad-caps', capabilities: { badges: {} } }, plugin,
    ] });
    return new Response('{}', { status: 404 });
  });
  installFakeLocalPlugin(ws.pluginsDir, { dir: 'reader', manifest: { name: 'reader', version: '2.0.0', repository: plugin.repository.url } });
  for (const isOffline of [false, true]) {
    offline = isOffline;
    const state = (await server.inject({ url: '/api/state?refresh=1' })).json();
    assert.deepEqual(state.catalog.plugins.map(p => p.id), [plugin.id]);
    assert.equal(state.installed[0].catalogId, plugin.id);
    assert.ok(state.catalog.warnings.some(warning => warning.includes('2 invalid plugin entries')));
  }
  const result = await post('/api/update', { id: plugin.id, dir: 'reader', forceResync: true });
  assert.match(result.error, /ERR_UPDATE_DOWNGRADE/);
  assert.equal(downloads, 0);
  assert.equal(JSON.parse(readFileSync(join(ws.pluginsDir, 'reader', 'plugin.json'))).version, '2.0.0');
});

test('GET /api/updates detects catalog updates, GitHub-only releases/tags awaiting catalog sync, and selfUpdate', async () => {
  const ws = makeTempWorkspace('agy-upd-detect-');
  try {
    const alphaTar = buildTarArtifact(ws.artifactsDir, 'alpha-1.2.0.tar.gz', {
      'plugin.json': JSON.stringify({ name: 'alpha-plug', displayName: 'Alpha Plug', version: '1.2.0', logo: 'assets/logo.svg' }),
      'assets/logo.svg': CLEAN_SVG,
    });
    const betaTar = buildTarArtifact(ws.artifactsDir, 'beta-1.0.0.tar.gz', {
      'plugin.json': JSON.stringify({ name: 'beta-plug', displayName: 'Beta Plug', version: '1.0.0', logo: 'assets/logo.svg' }),
      'assets/logo.svg': CLEAN_SVG,
    });
    const selfTar = buildTarArtifact(ws.artifactsDir, 'agy-market-1.0.2.tar.gz', {
      'plugin.json': JSON.stringify({ name: 'agy-market', displayName: 'AGY Market', version: '1.0.2', logo: 'assets/logo.svg' }),
      'assets/logo.svg': CLEAN_SVG,
    });

    // Installed locally:
    // 1. alpha-plug v1.0.0 -> catalog has v1.2.0 (installable) + GitHub release v1.2.0
    installFakeLocalPlugin(ws.pluginsDir, {
      dir: 'alpha-plug',
      manifest: { name: 'alpha-plug', displayName: 'Alpha Plug', version: '1.0.0', repository: 'https://github.com/alice/alpha-plug' },
      receipt: {
        schemaVersion: 1,
        id: 'alice__alpha-plug',
        repositoryId: 101,
        installedDir: 'alpha-plug',
        installedVersion: '1.0.0',
        grantedCapabilities: { badges: ['declarative-only'], mcpRemoteDomains: [], hookEvents: [] },
      },
    });
    // 2. beta-plug v1.0.0 -> catalog still at v1.0.0, GitHub has v1.3.0 release (awaiting catalog sync)
    installFakeLocalPlugin(ws.pluginsDir, {
      dir: 'beta-plug',
      manifest: { name: 'beta-plug', displayName: 'Beta Plug', version: '1.0.0', repository: 'https://github.com/bob/beta-plug' },
      receipt: {
        schemaVersion: 1,
        id: 'bob__beta-plug',
        repositoryId: 102,
        installedDir: 'beta-plug',
        installedVersion: '1.0.0',
        grantedCapabilities: { badges: ['declarative-only'], mcpRemoteDomains: [], hookEvents: [] },
      },
    });
    // 3. gamma-plug v0.9.0 -> manual install (no receipt, not in catalog), GitHub has only tags (v1.0.5 + prerelease v1.1.0-beta.1)
    installFakeLocalPlugin(ws.pluginsDir, {
      dir: 'gamma-plug',
      manifest: {
        name: 'gamma-plug',
        displayName: 'Gamma Plug',
        version: '0.9.0',
        repository: { type: 'git', url: 'https://github.com/carol/gamma-plug.git' },
      },
    });
    // 4. agy-market v1.0.0 -> catalog has v1.0.2 (selfUpdate)
    installFakeLocalPlugin(ws.pluginsDir, {
      dir: 'agy-market',
      manifest: { name: 'agy-market', displayName: 'AGY Market', version: '1.0.0', repository: 'https://github.com/azwosile/agy-market' },
      receipt: {
        schemaVersion: 1,
        id: 'azwosile__agy-market',
        repositoryId: 1468650761,
        installedDir: 'agy-market',
        installedVersion: '1.0.0',
        grantedCapabilities: { badges: ['sidecar-ui'], mcpRemoteDomains: [], hookEvents: [] },
      },
    });

    const catalogIndex = {
      schemaVersion: 1,
      track: 'verified',
      catalogVersion: '2026.1123.5',
      plugins: [
        makeCatalogPlugin({
          id: 'alice__alpha-plug',
          canonicalName: 'alpha-plug',
          owner: 'alice',
          repo: 'alpha-plug',
          displayName: 'Alpha Plug',
          version: '1.2.0',
          repoId: 101,
          tarballUrl: alphaTar.url,
          sha256: alphaTar.sha256,
          sizeBytes: alphaTar.sizeBytes,
          badges: ['declarative-only', 'lifecycle-hooks'],
          hookEvents: ['SessionStart'],
        }),
        makeCatalogPlugin({
          id: 'bob__beta-plug',
          canonicalName: 'beta-plug',
          owner: 'bob',
          repo: 'beta-plug',
          displayName: 'Beta Plug',
          version: '1.0.0',
          repoId: 102,
          tarballUrl: betaTar.url,
          sha256: betaTar.sha256,
          sizeBytes: betaTar.sizeBytes,
        }),
        makeCatalogPlugin({
          id: 'azwosile__agy-market',
          canonicalName: 'agy-market',
          owner: 'azwosile',
          repo: 'agy-market',
          displayName: 'AGY Market',
          version: '1.0.2',
          repoId: 1468650761,
          tarballUrl: selfTar.url,
          sha256: selfTar.sha256,
          sizeBytes: selfTar.sizeBytes,
          badges: ['sidecar-ui'],
        }),
      ],
    };

    const mockFetch = async (url) => {
      const u = String(url);
      if (u.endsWith('/index.json')) {
        return new Response(JSON.stringify(catalogIndex), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (u === 'https://api.github.com/repos/alice/alpha-plug/releases/latest') {
        return new Response(
          JSON.stringify({
            tag_name: 'v1.2.0',
            html_url: 'https://github.com/alice/alpha-plug/releases/tag/v1.2.0',
            body: '## v1.2.0\n- Added SessionStart hook',
          }),
          { status: 200, headers: { etag: '"alpha-rel-1"' } },
        );
      }
      if (u.startsWith('https://api.github.com/repos/alice/alpha-plug/tags')) {
        return new Response(JSON.stringify([{ name: 'v1.2.0' }]), { status: 200, headers: { etag: '"alpha-tags-1"' } });
      }
      if (u === 'https://api.github.com/repos/bob/beta-plug/releases/latest') {
        return new Response(
          JSON.stringify({
            tag_name: 'v1.3.0',
            html_url: 'https://github.com/bob/beta-plug/releases/tag/v1.3.0',
            body: 'Upstream v1.3.0 release notes',
          }),
          { status: 200, headers: { etag: '"beta-rel-1"' } },
        );
      }
      if (u.startsWith('https://api.github.com/repos/bob/beta-plug/tags')) {
        return new Response(JSON.stringify([{ name: 'v1.3.0' }, { name: 'v1.0.0' }]), { status: 200 });
      }
      if (u === 'https://api.github.com/repos/carol/gamma-plug/releases/latest') {
        return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 });
      }
      if (u.startsWith('https://api.github.com/repos/carol/gamma-plug/tags')) {
        return new Response(
          JSON.stringify([{ name: 'v0.9.0' }, { name: 'v1.1.0-beta.1' }, { name: 'v1.0.5' }, { name: 'not-semver' }]),
          { status: 200, headers: { etag: '"gamma-tags-1"' } },
        );
      }
      if (u === 'https://raw.githubusercontent.com/carol/gamma-plug/v1.0.5/plugin.json') {
        return new Response(JSON.stringify({ name: 'gamma-plug', version: '1.0.5' }), { status: 200 });
      }
      if (u === 'https://api.github.com/repos/azwosile/agy-market/releases/latest') {
        return new Response(
          JSON.stringify({
            tag_name: 'v1.0.2',
            html_url: 'https://github.com/azwosile/agy-market/releases/tag/v1.0.2',
            body: 'UI upgrade and auto-updater',
          }),
          { status: 200, headers: { etag: '"self-rel-1"' } },
        );
      }
      if (u.startsWith('https://api.github.com/repos/azwosile/agy-market/tags')) {
        return new Response(JSON.stringify([{ name: 'v1.0.2' }]), { status: 200 });
      }
      return new Response('{}', { status: 404 });
    };

    const srv = await createMarketSidecarServer({
      listen: false,
      configDir: ws.configDir,
      dataDir: ws.dataDir,
      recoveryDelayMs: -1,
      fetchImpl: mockFetch,
    });

    try {
      const res = await srv.inject({ method: 'GET', url: '/api/updates?force=0' });
      assert.equal(res.statusCode, 200);
      const data = res.json();
      assert.equal(data.ok, true);
      assert.ok(typeof data.checkedAt === 'string' && data.checkedAt.length > 0);
      assert.equal(data.rateLimited, false);
      assert.equal(data.items.length, 4);

      // Self must be ordered last in items
      assert.equal(data.items[data.items.length - 1].dir, 'agy-market');

      const byDir = new Map(data.items.map((x) => [x.dir, x]));

      const alpha = byDir.get('alpha-plug');
      assert.equal(alpha.id, 'alice__alpha-plug');
      assert.equal(alpha.source, 'catalog');
      assert.equal(alpha.installable, true);
      assert.equal(alpha.installedVersion, '1.0.0');
      assert.equal(alpha.latestVersion, '1.2.0');
      assert.equal(alpha.releaseUrl, 'https://github.com/alice/alpha-plug/releases/tag/v1.2.0');
      assert.match(alpha.changelog, /Added SessionStart hook/);
      assert.equal(alpha.escalation.escalated, true);
      assert.deepEqual(alpha.escalation.addedBadges, ['lifecycle-hooks']);

      const beta = byDir.get('beta-plug');
      assert.equal(beta.source, 'github-release');
      assert.equal(beta.updateChannel, 'github-upstream');
      assert.equal(beta.installable, true);
      assert.equal(beta.targetRef, 'v1.3.0');
      assert.equal(beta.latestVersion, '1.3.0');
      assert.equal(beta.releaseUrl, 'https://github.com/bob/beta-plug/releases/tag/v1.3.0');
      assert.equal(beta.changelog, 'Upstream v1.3.0 release notes');

      const gamma = byDir.get('gamma-plug');
      assert.equal(gamma.source, 'github-tag');
      assert.equal(gamma.updateChannel, 'github-upstream');
      assert.equal(gamma.installable, true);
      assert.equal(gamma.targetRef, 'v1.0.5');
      assert.equal(gamma.installedVersion, '0.9.0');
      assert.equal(gamma.latestVersion, '1.0.5');
      assert.equal(gamma.releaseUrl, 'https://github.com/carol/gamma-plug/releases/tag/v1.0.5');

      assert.ok(data.selfUpdate);
      assert.equal(data.selfUpdate.installedVersion, '1.0.0');
      assert.equal(data.selfUpdate.latestVersion, '1.0.2');
      assert.equal(data.selfUpdate.source, 'catalog');
      assert.equal(data.selfUpdate.installable, true);
      assert.equal(data.selfUpdate.releaseUrl, 'https://github.com/azwosile/agy-market/releases/tag/v1.0.2');
      assert.equal(data.selfUpdate.changelog, 'UI upgrade and auto-updater');
    } finally {
      await srv.close();
    }
  } finally {
    ws.cleanup();
  }
});

test('GitHub update check honors 30-min TTL, ETag If-None-Match 304 reuse, and force=1 bypass', async () => {
  const ws = makeTempWorkspace('agy-upd-cache-');
  try {
    installFakeLocalPlugin(ws.pluginsDir, {
      dir: 'cache-plug',
      manifest: { name: 'cache-plug', displayName: 'Cache Plug', version: '1.0.0', repository: 'https://github.com/alice/cache-plug' },
    });

    let nowMs = Date.parse('2026-11-23T12:00:00Z');
    let ghRelCalls = 0;
    let ghTagCalls = 0;
    let sawIfNoneMatch304 = false;
    let remoteVersion = '1.1.0';

    const mockFetch = async (url, init = {}) => {
      const u = String(url);
      if (u.endsWith('/index.json')) {
        return new Response(JSON.stringify({ schemaVersion: 1, track: 'verified', plugins: [] }), { status: 200 });
      }
      if (u === 'https://api.github.com/repos/alice/cache-plug/releases/latest') {
        ghRelCalls++;
        if (init.headers?.['If-None-Match'] === '"etag-v110"' && remoteVersion === '1.1.0') {
          sawIfNoneMatch304 = true;
          return new Response(null, { status: 304 });
        }
        return new Response(
          JSON.stringify({
            tag_name: `v${remoteVersion}`,
            html_url: `https://github.com/alice/cache-plug/releases/tag/v${remoteVersion}`,
            body: `Release ${remoteVersion}`,
          }),
          { status: 200, headers: { etag: `"etag-v${remoteVersion.replace(/\./g, '')}"` } },
        );
      }
      if (u.startsWith('https://api.github.com/repos/alice/cache-plug/tags')) {
        ghTagCalls++;
        if (init.headers?.['If-None-Match'] === '"tags-v110"' && remoteVersion === '1.1.0') {
          return new Response(null, { status: 304 });
        }
        return new Response(JSON.stringify([{ name: `v${remoteVersion}` }]), {
          status: 200,
          headers: { etag: `"tags-v${remoteVersion.replace(/\./g, '')}"` },
        });
      }
      if (u === `https://raw.githubusercontent.com/alice/cache-plug/v${remoteVersion}/plugin.json`) {
        return new Response(JSON.stringify({ name: 'cache-plug', version: remoteVersion }), { status: 200 });
      }
      // Self repo probe
      if (u.includes('/azwosile/agy-market/')) {
        return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 });
      }
      return new Response('{}', { status: 404 });
    };

    const srv = await createMarketSidecarServer({
      listen: false,
      configDir: ws.configDir,
      dataDir: ws.dataDir,
      recoveryDelayMs: -1,
      nowFn: () => nowMs,
      fetchImpl: mockFetch,
    });

    try {
      // 1. Initial call populates cache
      const r1 = await srv.inject({ method: 'GET', url: '/api/updates?force=0' });
      assert.equal(r1.statusCode, 200);
      assert.equal(r1.json().items[0].latestVersion, '1.1.0');
      assert.equal(ghRelCalls, 1);
      assert.equal(ghTagCalls, 1);

      // 2. +10 min (inside 30-min TTL) -> zero GitHub calls
      nowMs += 10 * 60 * 1000;
      const r2 = await srv.inject({ method: 'GET', url: '/api/updates?force=0' });
      assert.equal(r2.statusCode, 200);
      assert.equal(r2.json().items[0].latestVersion, '1.1.0');
      assert.equal(ghRelCalls, 1);
      assert.equal(ghTagCalls, 1);

      // 3. +31 min (TTL expired) -> conditional GET with If-None-Match -> 304 Not Modified reuses cached payload
      nowMs += 21 * 60 * 1000;
      const r3 = await srv.inject({ method: 'GET', url: '/api/updates?force=0' });
      assert.equal(r3.statusCode, 200);
      assert.equal(sawIfNoneMatch304, true);
      assert.equal(r3.json().items[0].latestVersion, '1.1.0');
      assert.equal(ghRelCalls, 2);

      // 4. +1 min with force=1 -> bypasses TTL and picks up remote v1.4.0
      nowMs += 60 * 1000;
      remoteVersion = '1.4.0';
      const r4 = await srv.inject({ method: 'GET', url: '/api/updates?force=1' });
      assert.equal(r4.statusCode, 200);
      assert.equal(r4.json().items[0].latestVersion, '1.4.0');
      assert.equal(ghRelCalls, 3);
    } finally {
      await srv.close();
    }
  } finally {
    ws.cleanup();
  }
});

test('GitHub 403 rate-limit degrades gracefully and prefs.githubToken is never echoed or cached', async () => {
  const ws = makeTempWorkspace('agy-upd-ratelimit-');
  const SECRET_TOKEN = 'ghp_TestSuperSecretToken_NeverLeak_987654321';
  try {
    const plugTar = buildTarArtifact(ws.artifactsDir, 'rl-plug-2.0.0.tar.gz', {
      'plugin.json': JSON.stringify({ name: 'rl-plug', displayName: 'RL Plug', version: '2.0.0' }),
    });
    installFakeLocalPlugin(ws.pluginsDir, {
      dir: 'rl-plug',
      manifest: { name: 'rl-plug', displayName: 'RL Plug', version: '1.0.0', repository: 'https://github.com/alice/rl-plug' },
      receipt: { schemaVersion: 1, id: 'alice__rl-plug', repositoryId: 501, installedDir: 'rl-plug', installedVersion: '1.0.0' },
    });
    installFakeLocalPlugin(ws.pluginsDir, {
      dir: 'rl-second',
      manifest: { name: 'rl-second', displayName: 'RL Second', version: '1.0.0', repository: 'https://github.com/alice/rl-second' },
    });

    const catalogIndex = {
      schemaVersion: 1,
      track: 'verified',
      plugins: [
        makeCatalogPlugin({
          id: 'alice__rl-plug',
          canonicalName: 'rl-plug',
          owner: 'alice',
          repo: 'rl-plug',
          displayName: 'RL Plug',
          version: '2.0.0',
          repoId: 501,
          tarballUrl: plugTar.url,
          sha256: plugTar.sha256,
        }),
      ],
    };

    let sawBearerHeader = false;
    let ghApiCalls = 0;

    const mockFetch = async (url, init = {}) => {
      const u = String(url);
      if (u.endsWith('/index.json')) {
        return new Response(JSON.stringify(catalogIndex), { status: 200 });
      }
      if (u.startsWith('https://api.github.com/')) {
        ghApiCalls++;
        if (init.headers?.Authorization === `Bearer ${SECRET_TOKEN}`) {
          sawBearerHeader = true;
        }
        return new Response(JSON.stringify({ message: 'API rate limit exceeded' }), {
          status: 403,
          headers: {
            'x-ratelimit-remaining': '0',
            'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 600),
          },
        });
      }
      return new Response('{}', { status: 404 });
    };

    const srv = await createMarketSidecarServer({
      listen: false,
      configDir: ws.configDir,
      dataDir: ws.dataDir,
      recoveryDelayMs: -1,
      fetchImpl: mockFetch,
    });

    try {
      // Save githubToken via POST /api/prefs
      const setTok = await srv.inject({
        method: 'POST',
        url: '/api/prefs',
        headers: { 'X-Sidecar-Token': srv.sideToken, Origin: 'http://127.0.0.1:12345' },
        body: { githubToken: SECRET_TOKEN },
      });
      assert.equal(setTok.statusCode, 200);
      assert.equal(setTok.json().prefs.hasGithubToken, true);
      assert.equal('githubToken' in setTok.json().prefs, false);
      assert.equal(setTok.text.includes(SECRET_TOKEN), false, 'githubToken must never be echoed in HTTP responses');

      // Updating unrelated pref preserves stored githubToken
      const setLocale = await srv.inject({
        method: 'POST',
        url: '/api/prefs',
        headers: { 'X-Sidecar-Token': srv.sideToken, Origin: 'http://127.0.0.1:12345' },
        body: { locale: 'en' },
      });
      assert.equal(setLocale.statusCode, 200);
      assert.equal(setLocale.json().prefs.locale, 'en');
      assert.equal(setLocale.json().prefs.hasGithubToken, true);

      // Hit /api/updates when GitHub returns 403 rate limit
      const updRes = await srv.inject({ method: 'GET', url: '/api/updates?force=1' });
      assert.equal(updRes.statusCode, 200);
      const updJson = updRes.json();
      assert.equal(updJson.ok, true);
      assert.equal(updJson.rateLimited, true);
      assert.equal(sawBearerHeader, true);
      assert.equal(ghApiCalls, 1, 'Should short-circuit remaining GitHub probes in same pass after first 403 rate limit');
      assert.equal(updRes.text.includes(SECRET_TOKEN), false, 'githubToken must never appear in updates response/warnings');

      // Catalog update must still be detected despite GitHub 403!
      const rlItem = updJson.items.find((x) => x.id === 'alice__rl-plug');
      assert.ok(rlItem);
      assert.equal(rlItem.source, 'catalog');
      assert.equal(rlItem.installable, true);
      assert.equal(rlItem.latestVersion, '2.0.0');

      // Verify cache files on disk never contain the token
      const cacheFiles = readAllFilesRecursively(join(ws.dataDir, 'cache'));
      for (const f of cacheFiles) {
        assert.equal(f.content.includes(SECRET_TOKEN), false, `Cache file ${f.path} must never contain githubToken`);
      }

      // Clear githubToken explicitly
      const clearTok = await srv.inject({
        method: 'POST',
        url: '/api/prefs',
        headers: { 'X-Sidecar-Token': srv.sideToken, Origin: 'http://127.0.0.1:12345' },
        body: { githubToken: '' },
      });
      assert.equal(clearTok.statusCode, 200);
      assert.equal(clearTok.json().prefs.hasGithubToken, false);
    } finally {
      await srv.close();
    }
  } finally {
    ws.cleanup();
  }
});

test('POST /api/update-all runs sequentially, continues on failure, updates self last, and restarts only after response', async () => {
  const ws = makeTempWorkspace('agy-upd-all-');
  try {
    const cleanTar = buildTarArtifact(ws.artifactsDir, 'clean-2.0.0.tar.gz', {
      'plugin.json': JSON.stringify({ name: 'clean-plug', displayName: 'Clean Plug', version: '2.0.0', logo: 'assets/logo.svg' }),
      'assets/logo.svg': CLEAN_SVG,
    });
    const badTar = buildTarArtifact(ws.artifactsDir, 'bad-2.0.0.tar.gz', {
      'plugin.json': JSON.stringify({ name: 'bad-plug', displayName: 'Bad Plug', version: '2.0.0' }),
    });
    const escTar = buildTarArtifact(ws.artifactsDir, 'esc-2.0.0.tar.gz', {
      'plugin.json': JSON.stringify({ name: 'esc-plug', displayName: 'Esc Plug', version: '2.0.0' }),
      'hooks.json': JSON.stringify({ hooks: { SessionStart: [] } }),
    });
    const selfTar = buildTarArtifact(ws.artifactsDir, 'self-1.0.2.tar.gz', {
      'plugin.json': JSON.stringify({ name: 'agy-market', displayName: 'AGY Market', version: '1.0.2', logo: 'assets/logo.svg' }),
      'assets/logo.svg': CLEAN_SVG,
    });

    installFakeLocalPlugin(ws.pluginsDir, {
      dir: 'agy-market',
      manifest: { name: 'agy-market', displayName: 'AGY Market', version: '1.0.0', repository: 'https://github.com/azwosile/agy-market' },
      receipt: {
        schemaVersion: 1,
        id: 'azwosile__agy-market',
        repositoryId: 1468650761,
        installedDir: 'agy-market',
        installedVersion: '1.0.0',
        grantedCapabilities: { badges: ['sidecar-ui'], mcpRemoteDomains: [], hookEvents: [] },
      },
    });
    installFakeLocalPlugin(ws.pluginsDir, {
      dir: 'bad-plug',
      manifest: { name: 'bad-plug', displayName: 'Bad Plug', version: '1.0.0', repository: 'https://github.com/alice/bad-plug' },
      receipt: {
        schemaVersion: 1,
        id: 'alice__bad-plug',
        repositoryId: 201,
        installedDir: 'bad-plug',
        installedVersion: '1.0.0',
        grantedCapabilities: { badges: ['declarative-only'], mcpRemoteDomains: [], hookEvents: [] },
      },
    });
    installFakeLocalPlugin(ws.pluginsDir, {
      dir: 'esc-plug',
      manifest: { name: 'esc-plug', displayName: 'Esc Plug', version: '1.0.0', repository: 'https://github.com/alice/esc-plug' },
      receipt: {
        schemaVersion: 1,
        id: 'alice__esc-plug',
        repositoryId: 202,
        installedDir: 'esc-plug',
        installedVersion: '1.0.0',
        grantedCapabilities: { badges: ['declarative-only'], mcpRemoteDomains: [], hookEvents: [] },
      },
    });
    installFakeLocalPlugin(ws.pluginsDir, {
      dir: 'clean-plug',
      manifest: { name: 'clean-plug', displayName: 'Clean Plug', version: '1.0.0', repository: 'https://github.com/alice/clean-plug' },
      receipt: {
        schemaVersion: 1,
        id: 'alice__clean-plug',
        repositoryId: 203,
        installedDir: 'clean-plug',
        installedVersion: '1.0.0',
        grantedCapabilities: { badges: ['declarative-only'], mcpRemoteDomains: [], hookEvents: [] },
      },
    });

    const catalogIndex = {
      schemaVersion: 1,
      track: 'verified',
      plugins: [
        makeCatalogPlugin({
          id: 'azwosile__agy-market',
          canonicalName: 'agy-market',
          owner: 'azwosile',
          repo: 'agy-market',
          displayName: 'AGY Market',
          version: '1.0.2',
          repoId: 1468650761,
          tarballUrl: selfTar.url,
          sha256: selfTar.sha256,
          badges: ['sidecar-ui'],
        }),
        makeCatalogPlugin({
          id: 'alice__bad-plug',
          canonicalName: 'bad-plug',
          owner: 'alice',
          repo: 'bad-plug',
          displayName: 'Bad Plug',
          version: '2.0.0',
          repoId: 201,
          tarballUrl: badTar.url,
          sha256: 'f'.repeat(64), // Intentional SHA-256 mismatch failure
        }),
        makeCatalogPlugin({
          id: 'alice__esc-plug',
          canonicalName: 'esc-plug',
          owner: 'alice',
          repo: 'esc-plug',
          displayName: 'Esc Plug',
          version: '2.0.0',
          repoId: 202,
          tarballUrl: escTar.url,
          sha256: escTar.sha256,
          badges: ['lifecycle-hooks'],
          hookEvents: ['SessionStart'],
        }),
        makeCatalogPlugin({
          id: 'alice__clean-plug',
          canonicalName: 'clean-plug',
          owner: 'alice',
          repo: 'clean-plug',
          displayName: 'Clean Plug',
          version: '2.0.0',
          repoId: 203,
          tarballUrl: cleanTar.url,
          sha256: cleanTar.sha256,
        }),
      ],
    };

    const events = [];
    let restartCount = 0;

    const srv = await createMarketSidecarServer({
      listen: false,
      configDir: ws.configDir,
      dataDir: ws.dataDir,
      recoveryDelayMs: -1,
      onSelfRestart: () => {
        restartCount++;
        events.push('onSelfRestart');
      },
      fetchImpl: async (url) => {
        if (String(url).endsWith('/index.json')) {
          return new Response(JSON.stringify(catalogIndex), { status: 200 });
        }
        return new Response('{}', { status: 404 });
      },
    });

    try {
      // CSRF / Origin enforcement on POST /api/update-all
      const noTok = await srv.inject({ method: 'POST', url: '/api/update-all', body: {} });
      assert.equal(noTok.statusCode, 403);
      assert.match(noTok.json().error, /ERR_CSRF_TOKEN/);

      const badOrig = await srv.inject({
        method: 'POST',
        url: '/api/update-all',
        headers: { 'X-Sidecar-Token': srv.sideToken, Origin: 'https://evil.example' },
        body: {},
      });
      assert.equal(badOrig.statusCode, 403);
      assert.match(badOrig.json().error, /ERR_CSRF_ORIGIN/);

      // Pass self FIRST in ids to prove update-all reorders self to LAST
      const resPromise = srv.inject({
        method: 'POST',
        url: '/api/update-all',
        headers: { 'X-Sidecar-Token': srv.sideToken, Origin: 'http://127.0.0.1:43210' },
        body: {
          ids: ['azwosile__agy-market', 'alice__bad-plug', 'alice__esc-plug', 'alice__clean-plug'],
          confirmEscalation: false,
        },
      });
      // Track when response resolves
      const batchRes = await resPromise;
      events.push('responseReceived');

      assert.equal(batchRes.statusCode, 200);
      const payload = batchRes.json();
      assert.equal(payload.ok, false);
      assert.equal(payload.willRestart, true);
      assert.equal(restartCount, 1);

      // Verify exact order: bad-plug, esc-plug, clean-plug, self LAST!
      assert.deepEqual(
        payload.results.map((r) => r.id),
        ['alice__bad-plug', 'alice__esc-plug', 'alice__clean-plug', 'azwosile__agy-market'],
      );

      assert.equal(payload.results[0].ok, false);
      assert.equal(payload.results[0].status, 'ERROR');
      assert.match(payload.results[0].error, /INTEGRITY_SHA256_MISMATCH/);

      assert.equal(payload.results[1].ok, false);
      assert.equal(payload.results[1].status, 'CAPABILITY_ESCALATION_CONFIRM_REQUIRED');
      assert.equal(payload.results[1].escalation.escalated, true);
      assert.equal(payload.results[1].installedVersion, '1.0.0');
      assert.equal(payload.results[1].targetVersion, '2.0.0');

      assert.equal(payload.results[2].ok, true);
      assert.equal(payload.results[2].status, 'INSTALLED');
      assert.equal(payload.results[2].version, '2.0.0');
      assert.equal(
        JSON.parse(readFileSync(join(ws.pluginsDir, 'clean-plug', 'plugin.json'), 'utf8')).version,
        '2.0.0',
      );

      assert.equal(payload.results[3].ok, true);
      assert.equal(payload.results[3].status, 'INSTALLED');
      assert.equal(payload.results[3].version, '1.0.2');
      assert.equal(payload.results[3].isSelfUpdate, true);
      assert.equal(
        JSON.parse(readFileSync(join(ws.pluginsDir, 'agy-market', 'plugin.json'), 'utf8')).version,
        '1.0.2',
      );

      assert.ok(payload.state && payload.state.ok === true);

      // Retry escalated plugin with confirmEscalation: true
      const retryRes = await srv.inject({
        method: 'POST',
        url: '/api/update-all',
        headers: { 'X-Sidecar-Token': srv.sideToken, Origin: 'http://127.0.0.1:43210' },
        body: { ids: ['alice__esc-plug'], confirmEscalation: true, approvalKeys: { 'esc-plug': payload.results[1].escalation.approvalKey } },
      });
      assert.equal(retryRes.statusCode, 200);
      const retryJson = retryRes.json();
      assert.equal(retryJson.ok, true);
      assert.equal(retryJson.willRestart, false);
      assert.equal(retryJson.results[0].ok, true);
      assert.equal(retryJson.results[0].version, '2.0.0');
      assert.equal(restartCount, 1, 'Non-self retry must not trigger restart');

      // config.json must never be written
      assert.equal(existsSync(join(ws.configDir, 'config.json')), false);
    } finally {
      await srv.close();
    }
  } finally {
    ws.cleanup();
  }
});

test('POST /api/self-update enforces CSRF, installs latest azwosile__agy-market, and triggers onSelfRestart after response', async () => {
  const ws = makeTempWorkspace('agy-self-upd-');
  try {
    const selfTar = buildTarArtifact(ws.artifactsDir, 'agy-market-1.1.0.tar.gz', {
      'plugin.json': JSON.stringify({
        name: 'agy-market',
        displayName: 'AGY Market · 反重力插件市场',
        version: '1.1.0',
        logo: 'assets/logo.svg',
      }),
      'assets/logo.svg': CLEAN_SVG,
    });

    installFakeLocalPlugin(ws.pluginsDir, {
      dir: 'agy-market',
      manifest: { name: 'agy-market', displayName: 'AGY Market', version: '1.0.1' },
      receipt: {
        schemaVersion: 1,
        id: 'azwosile__agy-market',
        repositoryId: 1468650761,
        installedDir: 'agy-market',
        installedVersion: '1.0.1',
        grantedCapabilities: { badges: ['sidecar-ui'], mcpRemoteDomains: [], hookEvents: [] },
      },
    });

    const catalogIndex = {
      schemaVersion: 1,
      track: 'verified',
      plugins: [
        makeCatalogPlugin({
          id: 'azwosile__agy-market',
          canonicalName: 'agy-market',
          owner: 'azwosile',
          repo: 'agy-market',
          displayName: 'AGY Market',
          version: '1.1.0',
          repoId: 1468650761,
          tarballUrl: selfTar.url,
          sha256: selfTar.sha256,
          badges: ['sidecar-ui'],
        }),
      ],
    };

    const callOrder = [];
    const srv = await createMarketSidecarServer({
      listen: false,
      configDir: ws.configDir,
      dataDir: ws.dataDir,
      recoveryDelayMs: -1,
      onSelfRestart: () => {
        callOrder.push('restart');
      },
      fetchImpl: async (url) => {
        if (String(url).endsWith('/index.json')) {
          return new Response(JSON.stringify(catalogIndex), { status: 200 });
        }
        return new Response('{}', { status: 404 });
      },
    });

    try {
      // Missing token -> 403
      const unauth = await srv.inject({ method: 'POST', url: '/api/self-update', body: {} });
      assert.equal(unauth.statusCode, 403);

      // Bad origin -> 403
      const badOrig = await srv.inject({
        method: 'POST',
        url: '/api/self-update',
        headers: { 'X-Sidecar-Token': srv.sideToken, Origin: 'https://attacker.example' },
        body: {},
      });
      assert.equal(badOrig.statusCode, 403);

      // Real HTTP check or inject check: in inject, res.end resolves synchronously before onSelfRestart() is invoked
      const res = await srv.inject({
        method: 'POST',
        url: '/api/self-update',
        headers: { 'X-Sidecar-Token': srv.sideToken, Origin: 'http://127.0.0.1:43210' },
        body: {},
      });
      assert.equal(res.statusCode, 200);
      const data = res.json();
      assert.equal(data.ok, true);
      assert.equal(data.status, 'INSTALLED');
      assert.equal(data.isSelfUpdate, true);
      assert.equal(data.willRestart, true);
      assert.equal(data.version, '1.1.0');
      assert.deepEqual(callOrder, ['restart']);

      const diskManifest = JSON.parse(readFileSync(join(ws.pluginsDir, 'agy-market', 'plugin.json'), 'utf8'));
      assert.equal(diskManifest.version, '1.1.0');
      const diskReceipt = JSON.parse(readFileSync(join(ws.pluginsDir, 'agy-market', '.agy-market-receipt.json'), 'utf8'));
      assert.equal(diskReceipt.installedVersion, '1.1.0');
      assert.equal(diskReceipt.sha256, selfTar.sha256);
    } finally {
      await srv.close();
    }
  } finally {
    ws.cleanup();
  }
});

test('discussion caches follow credential changes, discard denied results, and ignore old credential responses', async t => {
  let graphqlResponse;
  let graphqlCalls = 0;
  const privateTitle = 'Private discussion from account A';
  const success = () => Response.json({ data: { repository: {
    hasDiscussionsEnabled: true, discussions: { nodes: [{ title: privateTitle }] },
  } } });
  const { ws, server, post } = await openUpdateFixture(t, async (url, init) => {
    if (String(url).endsWith('/graphql')) {
      graphqlCalls++;
      return graphqlResponse(init.headers.Authorization);
    }
    if (String(url).endsWith('/index.json')) return Response.json({ plugins: [] });
    return new Response('{}', { status: 404 });
  });
  installFakeLocalPlugin(ws.pluginsDir, { dir: 'notes', manifest: {
    name: 'notes', version: '1', repository: 'https://github.com/team/notes',
  } });
  const cacheDir = join(ws.dataDir, 'cache', 'github');
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(join(cacheDir, 'discussions-gql-team__notes.json'), JSON.stringify({
    items: [{ title: 'legacy private item' }], checkedAtMs: Date.now(),
  }));
  const read = async (force = false) => (await server.inject({
    url: '/api/discussions?id=notes' + (force ? '&force=1' : ''),
  })).json();
  await post('/api/prefs', { githubToken: 'fixture-account-A' });
  graphqlResponse = success;
  assert.equal((await read()).items[0].title, privateTitle);
  assert.equal((await read()).items[0].title, privateTitle);
  assert.equal(graphqlCalls, 1);
  const started = Promise.withResolvers();
  const delayed = Promise.withResolvers();
  graphqlResponse = auth => {
    assert.equal(auth, 'Bearer fixture-account-A');
    started.resolve();
    return delayed.promise;
  };
  const old = read(true);
  await started.promise;
  await post('/api/prefs', { githubToken: 'fixture-account-B' });
  graphqlResponse = auth => {
    assert.equal(auth, 'Bearer fixture-account-B');
    return new Response(null, { status: 404 });
  };
  assert.deepEqual((await read()).items, []);
  delayed.resolve(success());
  assert.deepEqual((await old).items, []);
  assert.deepEqual((await read()).items, []);

  for (const deny of [
    () => new Response(null, { status: 401 }),
    () => new Response(null, { status: 403 }),
    () => new Response(null, { status: 404 }),
    () => Response.json({ errors: [{ type: 'NOT_FOUND', message: 'Could not resolve repository' }] }),
    () => Response.json({ data: { repository: { discussions: { nodes: [{ title: privateTitle }] } } },
      errors: [{ extensions: { code: 'FORBIDDEN' }, message: 'Permission denied' }] }),
    () => Response.json({ data: { repository: null } }),
  ]) {
    graphqlResponse = success;
    assert.equal((await read(true)).items.length, 1);
    graphqlResponse = deny;
    assert.deepEqual((await read(true)).items, []);
    graphqlResponse = () => new Response(null, { status: 503 });
    assert.deepEqual((await read()).items, []);
  }
  graphqlResponse = success;
  await read(true);
  graphqlResponse = () => new Response(null, { status: 503 });
  assert.equal((await read(true)).items[0].title, privateTitle);
  await post('/api/prefs', { clearGithubToken: true });
  assert.deepEqual((await read()).items, []);
  for (const f of readAllFilesRecursively(cacheDir)) {
    assert.doesNotMatch(f.path + f.content, /fixture-account-|Private discussion from account A/);
  }
});

test('GET /api/discussions supports unauthenticated URL + disabled detection and authenticated GraphQL items', async () => {
  const ws = makeTempWorkspace('agy-disc-');
  const SECRET_TOKEN = 'ghp_DiscussionsToken_DoNotCache_112233';
  try {
    const dummySha = 'a'.repeat(64);
    const catalogIndex = {
      schemaVersion: 1,
      track: 'verified',
      plugins: [
        makeCatalogPlugin({
          id: 'alice__open-disc',
          canonicalName: 'open-disc',
          owner: 'alice',
          repo: 'open-disc',
          displayName: 'Open Disc',
          version: '1.0.0',
          repoId: 301,
          tarballUrl: 'https://example.com/open.tar.gz',
          sha256: dummySha,
        }),
        makeCatalogPlugin({
          id: 'bob__closed-disc',
          canonicalName: 'closed-disc',
          owner: 'bob',
          repo: 'closed-disc',
          displayName: 'Closed Disc',
          version: '1.0.0',
          repoId: 302,
          tarballUrl: 'https://example.com/closed.tar.gz',
          sha256: dummySha,
        }),
      ],
    };

    const mockFetch = async (url, init = {}) => {
      const u = String(url);
      if (u.endsWith('/index.json')) {
        return new Response(JSON.stringify(catalogIndex), { status: 200 });
      }
      if (u === 'https://api.github.com/repos/alice/open-disc') {
        return new Response(JSON.stringify({ full_name: 'alice/open-disc', has_discussions: true }), {
          status: 200,
          headers: { etag: '"repo-open-1"' },
        });
      }
      if (u === 'https://api.github.com/repos/bob/closed-disc') {
        return new Response(JSON.stringify({ full_name: 'bob/closed-disc', has_discussions: false }), {
          status: 200,
          headers: { etag: '"repo-closed-1"' },
        });
      }
      if (u === 'https://api.github.com/graphql') {
        assert.equal(init.headers?.Authorization, `Bearer ${SECRET_TOKEN}`);
        const reqBody = JSON.parse(String(init.body || '{}'));
        const { owner, repo } = reqBody.variables || {};
        if (owner === 'alice' && repo === 'open-disc') {
          return new Response(
            JSON.stringify({
              data: {
                repository: {
                  hasDiscussionsEnabled: true,
                  discussions: {
                    nodes: [
                      {
                        title: 'How to configure glass blur?',
                        url: 'https://github.com/alice/open-disc/discussions/12',
                        updatedAt: '2026-11-22T09:00:00Z',
                        author: { login: 'devuser' },
                        comments: { totalCount: 4 },
                        category: { name: 'Q&A' },
                      },
                    ],
                  },
                },
              },
            }),
            { status: 200 },
          );
        }
        if (owner === 'bob' && repo === 'closed-disc') {
          return new Response(
            JSON.stringify({
              data: {
                repository: {
                  hasDiscussionsEnabled: false,
                  discussions: { nodes: [] },
                },
              },
            }),
            { status: 200 },
          );
        }
      }
      return new Response('{}', { status: 404 });
    };

    const srv = await createMarketSidecarServer({
      listen: false,
      configDir: ws.configDir,
      dataDir: ws.dataDir,
      recoveryDelayMs: -1,
      fetchImpl: mockFetch,
    });

    try {
      // Missing id -> 400
      const missing = await srv.inject({ method: 'GET', url: '/api/discussions' });
      assert.equal(missing.statusCode, 400);

      // Unknown id -> 404
      const unknown = await srv.inject({ method: 'GET', url: '/api/discussions?id=nobody__missing' });
      assert.equal(unknown.statusCode, 404);

      // Unauthenticated enabled repo
      const noTokOpen = await srv.inject({ method: 'GET', url: '/api/discussions?id=alice__open-disc' });
      assert.equal(noTokOpen.statusCode, 200);
      const d1 = noTokOpen.json();
      assert.equal(d1.ok, true);
      assert.equal(d1.url, 'https://github.com/alice/open-disc/discussions');
      assert.equal(d1.newDiscussionUrl, 'https://github.com/alice/open-disc/discussions/new/choose');
      assert.deepEqual(d1.items, []);
      assert.equal(d1.disabled, false);
      assert.equal(d1.needsToken, true);

      // Unauthenticated disabled repo
      const noTokClosed = await srv.inject({ method: 'GET', url: '/api/discussions?id=bob__closed-disc' });
      assert.equal(noTokClosed.statusCode, 200);
      const d2 = noTokClosed.json();
      assert.equal(d2.ok, true);
      assert.equal(d2.disabled, true);
      assert.equal(d2.needsToken, false);
      assert.deepEqual(d2.items, []);

      // Configure githubToken via POST /api/prefs -> GraphQL fetches live discussion items
      const setTok = await srv.inject({
        method: 'POST',
        url: '/api/prefs',
        headers: { 'X-Sidecar-Token': srv.sideToken, Origin: 'http://127.0.0.1:43210' },
        body: { githubToken: SECRET_TOKEN },
      });
      assert.equal(setTok.statusCode, 200);

      const authOpen = await srv.inject({ method: 'GET', url: '/api/discussions?id=alice__open-disc' });
      assert.equal(authOpen.statusCode, 200);
      const d3 = authOpen.json();
      assert.equal(d3.ok, true);
      assert.equal(d3.disabled, false);
      assert.equal(d3.needsToken, false);
      assert.equal(d3.items.length, 1);
      assert.deepEqual(d3.items[0], {
        title: 'How to configure glass blur?',
        url: 'https://github.com/alice/open-disc/discussions/12',
        author: 'devuser',
        comments: 4,
        updatedAt: '2026-11-22T09:00:00Z',
        category: 'Q&A',
      });

      const authClosed = await srv.inject({ method: 'GET', url: '/api/discussions?id=bob__closed-disc' });
      assert.equal(authClosed.statusCode, 200);
      assert.equal(authClosed.json().disabled, true);
      assert.deepEqual(authClosed.json().items, []);

      // Token must never be persisted to cache files
      const cacheFiles = readAllFilesRecursively(join(ws.dataDir, 'cache'));
      for (const f of cacheFiles) {
        assert.equal(f.content.includes(SECRET_TOKEN), false);
      }
    } finally {
      await srv.close();
    }
  } finally {
    ws.cleanup();
  }
});

test('POST /api/update-all with omitted ids auto-discovers installable updates, skips GitHub-only items, and orders self last', async () => {
  const ws = makeTempWorkspace('agy-upd-all-auto-');
  try {
    const toolTar = buildTarArtifact(ws.artifactsDir, 'tool-1.5.0.tar.gz', {
      'plugin.json': JSON.stringify({ name: 'tool-plug', displayName: 'Tool Plug', version: '1.5.0', logo: 'assets/logo.svg' }),
      'assets/logo.svg': CLEAN_SVG,
    });
    const selfTar = buildTarArtifact(ws.artifactsDir, 'self-1.0.5.tar.gz', {
      'plugin.json': JSON.stringify({ name: 'agy-market', displayName: 'AGY Market', version: '1.0.5', logo: 'assets/logo.svg' }),
      'assets/logo.svg': CLEAN_SVG,
    });

    installFakeLocalPlugin(ws.pluginsDir, {
      dir: 'agy-market',
      manifest: { name: 'agy-market', displayName: 'AGY Market', version: '1.0.1' },
      receipt: {
        schemaVersion: 1,
        id: 'azwosile__agy-market',
        repositoryId: 1468650761,
        installedDir: 'agy-market',
        installedVersion: '1.0.1',
        grantedCapabilities: { badges: ['sidecar-ui'], mcpRemoteDomains: [], hookEvents: [] },
      },
    });
    installFakeLocalPlugin(ws.pluginsDir, {
      dir: 'tool-plug',
      manifest: { name: 'tool-plug', displayName: 'Tool Plug', version: '1.0.0' },
      receipt: {
        schemaVersion: 1,
        id: 'alice__tool-plug',
        repositoryId: 401,
        installedDir: 'tool-plug',
        installedVersion: '1.0.0',
        grantedCapabilities: { badges: ['declarative-only'], mcpRemoteDomains: [], hookEvents: [] },
      },
    });
    // Local-only plugin (not in catalog) must NOT break update-all
    installFakeLocalPlugin(ws.pluginsDir, {
      dir: 'manual-only',
      manifest: { name: 'manual-only', displayName: 'Manual Only', version: '0.1.0', repository: 'https://github.com/carol/manual-only' },
    });

    const catalogIndex = {
      schemaVersion: 1,
      track: 'verified',
      plugins: [
        // Deliberately list self FIRST in catalog to verify self is still executed LAST
        makeCatalogPlugin({
          id: 'azwosile__agy-market',
          canonicalName: 'agy-market',
          owner: 'azwosile',
          repo: 'agy-market',
          displayName: 'AGY Market',
          version: '1.0.5',
          repoId: 1468650761,
          tarballUrl: selfTar.url,
          sha256: selfTar.sha256,
          badges: ['sidecar-ui'],
        }),
        makeCatalogPlugin({
          id: 'alice__tool-plug',
          canonicalName: 'tool-plug',
          owner: 'alice',
          repo: 'tool-plug',
          displayName: 'Tool Plug',
          version: '1.5.0',
          repoId: 401,
          tarballUrl: toolTar.url,
          sha256: toolTar.sha256,
        }),
      ],
    };

    let restarts = 0;
    const srv = await createMarketSidecarServer({
      listen: false,
      configDir: ws.configDir,
      dataDir: ws.dataDir,
      recoveryDelayMs: -1,
      onSelfRestart: () => {
        restarts++;
      },
      fetchImpl: async (url) => {
        if (String(url).endsWith('/index.json')) {
          return new Response(JSON.stringify(catalogIndex), { status: 200 });
        }
        return new Response('{}', { status: 404 });
      },
    });

    try {
      const res = await srv.inject({
        method: 'POST',
        url: '/api/update-all',
        headers: { 'X-Sidecar-Token': srv.sideToken, Origin: 'http://127.0.0.1:43210' },
        body: {},
      });
      assert.equal(res.statusCode, 200);
      const data = res.json();
      assert.equal(data.ok, true);
      assert.equal(data.willRestart, true);
      assert.equal(restarts, 1);
      assert.deepEqual(
        data.results.map((r) => r.id),
        ['alice__tool-plug', 'azwosile__agy-market'],
      );
      assert.equal(data.results[0].version, '1.5.0');
      assert.equal(data.results[1].version, '1.0.5');
      assert.equal(data.results[1].isSelfUpdate, true);
    } finally {
      await srv.close();
    }
  } finally {
    ws.cleanup();
  }
});

test('GET /api/updates detects selfUpdate without local plugins/agy-market dir, surfaces upstreamVersion ahead of catalog, and GET /api/discussions handles 401 bad token & local-only repos', async () => {
  const ws = makeTempWorkspace('agy-edge-cases-');
  const BAD_TOKEN = 'ghp_InvalidRejectedToken_000000';
  try {
    const plugTar = buildTarArtifact(ws.artifactsDir, 'ahead-1.2.0.tar.gz', {
      'plugin.json': JSON.stringify({ name: 'ahead-plug', displayName: 'Ahead Plug', version: '1.2.0' }),
    });
    const selfTar = buildTarArtifact(ws.artifactsDir, 'self-2.0.0.tar.gz', {
      'plugin.json': JSON.stringify({ name: 'agy-market', displayName: 'AGY Market', version: '2.0.0' }),
    });

    // Note: agy-market is NOT installed in ws.pluginsDir — must still detect selfUpdate vs currentSelfVersion!
    installFakeLocalPlugin(ws.pluginsDir, {
      dir: 'ahead-plug',
      manifest: { name: 'ahead-plug', displayName: 'Ahead Plug', version: '1.0.0', repository: 'https://github.com/alice/ahead-plug' },
      receipt: { schemaVersion: 1, id: 'alice__ahead-plug', repositoryId: 601, installedDir: 'ahead-plug', installedVersion: '1.0.0' },
    });
    installFakeLocalPlugin(ws.pluginsDir, {
      dir: 'local-only-disc',
      manifest: { name: 'local-only-disc', displayName: 'Local Only Disc', version: '1.0.0', repository: 'https://github.com/dave/local-only-disc' },
    });

    const catalogIndex = {
      schemaVersion: 1,
      track: 'verified',
      plugins: [
        makeCatalogPlugin({
          id: 'alice__ahead-plug',
          canonicalName: 'ahead-plug',
          owner: 'alice',
          repo: 'ahead-plug',
          displayName: 'Ahead Plug',
          version: '1.2.0',
          repoId: 601,
          tarballUrl: plugTar.url,
          sha256: plugTar.sha256,
        }),
        makeCatalogPlugin({
          id: 'azwosile__agy-market',
          canonicalName: 'agy-market',
          owner: 'azwosile',
          repo: 'agy-market',
          displayName: 'AGY Market',
          version: '2.0.0',
          repoId: 1468650761,
          tarballUrl: selfTar.url,
          sha256: selfTar.sha256,
        }),
      ],
    };

    const mockFetch = async (url) => {
      const u = String(url);
      if (u.endsWith('/index.json')) {
        return new Response(JSON.stringify(catalogIndex), { status: 200 });
      }
      if (u === 'https://api.github.com/repos/alice/ahead-plug/releases/latest') {
        return new Response(
          JSON.stringify({
            tag_name: 'v1.3.0',
            html_url: 'https://github.com/alice/ahead-plug/releases/tag/v1.3.0',
            body: 'Even newer upstream release',
          }),
          { status: 200 },
        );
      }
      if (u === 'https://api.github.com/repos/azwosile/agy-market/releases/latest') {
        return new Response(
          JSON.stringify({
            tag_name: 'v2.0.0',
            html_url: 'https://github.com/azwosile/agy-market/releases/tag/v2.0.0',
            body: 'Major v2.0.0 release',
          }),
          { status: 200 },
        );
      }
      if (u === 'https://api.github.com/repos/dave/local-only-disc') {
        return new Response(JSON.stringify({ full_name: 'dave/local-only-disc', has_discussions: true }), { status: 200 });
      }
      if (u === 'https://api.github.com/graphql') {
        return new Response(JSON.stringify({ message: 'Bad credentials' }), { status: 401 });
      }
      return new Response('{}', { status: 404 });
    };

    const srv = await createMarketSidecarServer({
      listen: false,
      configDir: ws.configDir,
      dataDir: ws.dataDir,
      recoveryDelayMs: -1,
      currentSelfVersion: '1.0.1',
      fetchImpl: mockFetch,
    });

    try {
      const upd = await srv.inject({ method: 'GET', url: '/api/updates?force=0' });
      assert.equal(upd.statusCode, 200);
      const uJson = upd.json();

      // ahead-plug GitHub upstream 1.3.0 leads catalog 1.2.0 -> direct-installable via github-upstream
      const ahead = uJson.items.find((x) => x.id === 'alice__ahead-plug');
      assert.ok(ahead);
      assert.equal(ahead.source, 'github-release');
      assert.equal(ahead.updateChannel, 'github-upstream');
      assert.equal(ahead.installable, true);
      assert.equal(ahead.latestVersion, '1.3.0');
      assert.equal(ahead.targetRef, 'v1.3.0');
      assert.equal(ahead.releaseUrl, 'https://github.com/alice/ahead-plug/releases/tag/v1.3.0');

      // selfUpdate detected via currentSelfVersion even when plugins/agy-market isn't on disk
      assert.ok(uJson.selfUpdate);
      assert.equal(uJson.selfUpdate.installedVersion, '1.0.1');
      assert.equal(uJson.selfUpdate.latestVersion, '2.0.0');
      assert.equal(uJson.selfUpdate.installable, true);
      assert.equal(uJson.selfUpdate.changelog, 'Major v2.0.0 release');

      // Local-only plugin resolves discussions via plugin.json repository URL
      const localDisc = await srv.inject({ method: 'GET', url: '/api/discussions?id=local-only-disc' });
      assert.equal(localDisc.statusCode, 200);
      assert.equal(localDisc.json().url, 'https://github.com/dave/local-only-disc/discussions');
      assert.equal(localDisc.json().needsToken, true);

      // Bad token returns graceful fallback (needsToken: true, ok: true) without leaking token
      await srv.inject({
        method: 'POST',
        url: '/api/prefs',
        headers: { 'X-Sidecar-Token': srv.sideToken, Origin: 'http://127.0.0.1:43210' },
        body: { githubToken: BAD_TOKEN },
      });
      const badTokDisc = await srv.inject({ method: 'GET', url: '/api/discussions?id=local-only-disc' });
      assert.equal(badTokDisc.statusCode, 200);
      assert.equal(badTokDisc.json().ok, true);
      assert.equal(badTokDisc.json().needsToken, true);
      assert.equal(badTokDisc.json().tokenRejected, true);
      assert.match(badTokDisc.json().warning, /401/);
      assert.equal(badTokDisc.text.includes(BAD_TOKEN), false);
    } finally {
      await srv.close();
    }
  } finally {
    ws.cleanup();
  }
});

test('Zero-quota HEAD /releases/latest redirect fallback on 403 rate limit and single-flight coalescing on concurrent GET /api/updates', async () => {
  const ws = makeTempWorkspace('agy-dsh-parity-');
  try {
    installFakeLocalPlugin(ws.pluginsDir, {
      dir: 'redir-plug',
      manifest: { name: 'redir-plug', displayName: 'Redir Plug', version: '1.0.0', repository: 'https://github.com/alice/redir-plug' },
    });

    let apiCalls = 0;
    let headRedirectCalls = 0;
    const mockFetch = async (url, init = {}) => {
      const u = String(url);
      if (u.endsWith('/index.json')) {
        return new Response(JSON.stringify({ schemaVersion: 1, track: 'verified', plugins: [] }), { status: 200 });
      }
      if (u.startsWith('https://api.github.com/repos/alice/redir-plug/')) {
        apiCalls++;
        await new Promise((r) => setTimeout(r, 25));
        return new Response(JSON.stringify({ message: 'API rate limit exceeded' }), {
          status: 403,
          headers: { 'x-ratelimit-remaining': '0' },
        });
      }
      if (u === 'https://github.com/alice/redir-plug/releases/latest' && init.method === 'HEAD') {
        headRedirectCalls++;
        return new Response(null, {
          status: 302,
          headers: { location: 'https://github.com/alice/redir-plug/releases/tag/v1.6.0' },
        });
      }
      if (u === 'https://raw.githubusercontent.com/alice/redir-plug/v1.6.0/plugin.json') {
        return new Response(JSON.stringify({ name: 'redir-plug', version: '1.6.0' }), { status: 200 });
      }
      return new Response('{}', { status: 404 });
    };

    const srv = await createMarketSidecarServer({
      listen: false,
      configDir: ws.configDir,
      dataDir: ws.dataDir,
      recoveryDelayMs: -1,
      fetchImpl: mockFetch,
    });

    try {
      // Fire two concurrent GET /api/updates?force=0 requests -> must coalesce single-flight
      const [r1, r2] = await Promise.all([
        srv.inject({ method: 'GET', url: '/api/updates?force=0' }),
        srv.inject({ method: 'GET', url: '/api/updates?force=0' }),
      ]);
      assert.equal(r1.statusCode, 200);
      assert.equal(r2.statusCode, 200);
      assert.equal(apiCalls, 1, 'Concurrent GET /api/updates?force=0 must coalesce into a single flight');
      assert.equal(headRedirectCalls, 1);

      const d1 = r1.json();
      assert.equal(d1.ok, true);
      assert.equal(d1.rateLimited, true);
      const item = d1.items.find((x) => x.dir === 'redir-plug');
      assert.ok(item);
      assert.equal(item.source, 'github-release');
      assert.equal(item.updateChannel, 'github-upstream');
      assert.equal(item.installable, true);
      assert.equal(item.targetRef, 'v1.6.0');
      assert.equal(item.latestVersion, '1.6.0');
      assert.equal(item.releaseUrl, 'https://github.com/alice/redir-plug/releases/tag/v1.6.0');
    } finally {
      await srv.close();
    }
  } finally {
    ws.cleanup();
  }
});

test('Concurrent GET /api/updates?force=1 coalesces within the same generation and stays isolated from force=0', async () => {
  const ws = makeTempWorkspace('agy-upd-force1-sf-');
  try {
    installFakeLocalPlugin(ws.pluginsDir, {
      dir: 'force-plug',
      manifest: { name: 'force-plug', displayName: 'Force Plug', version: '1.0.0', repository: 'https://github.com/alice/force-plug' },
    });

    let apiCalls = 0;
    let releaseFirstWave;
    let firstWaveEntered;
    const firstWaveGate = new Promise((r) => {
      releaseFirstWave = r;
    });
    const firstWaveStarted = new Promise((r) => {
      firstWaveEntered = r;
    });
    let releaseIsoWave;
    let isoForce0Entered;
    let isoForce1Entered;
    const isoWaveGate = new Promise((r) => {
      releaseIsoWave = r;
    });
    const isoForce0Started = new Promise((r) => {
      isoForce0Entered = r;
    });
    const isoForce1Started = new Promise((r) => {
      isoForce1Entered = r;
    });

    const mockFetch = async (url) => {
      const u = String(url);
      if (u.endsWith('/index.json')) {
        return new Response(JSON.stringify({ schemaVersion: 1, track: 'verified', plugins: [] }), { status: 200 });
      }
      if (u === 'https://api.github.com/repos/alice/force-plug/releases/latest') {
        apiCalls += 1;
        if (apiCalls === 1) {
          firstWaveEntered();
          await firstWaveGate;
        } else if (apiCalls === 3) {
          isoForce0Entered();
          await isoWaveGate;
        } else if (apiCalls === 4) {
          isoForce1Entered();
          await isoWaveGate;
        } else {
          await new Promise((r) => setTimeout(r, 20));
        }
        return new Response(
          JSON.stringify({
            tag_name: 'v1.8.0',
            draft: false,
            prerelease: false,
            html_url: 'https://github.com/alice/force-plug/releases/tag/v1.8.0',
            assets: [],
          }),
          { status: 200 },
        );
      }
      if (u === 'https://raw.githubusercontent.com/alice/force-plug/v1.8.0/plugin.json') {
        return new Response(JSON.stringify({ name: 'force-plug', version: '1.8.0' }), { status: 200 });
      }
      return new Response('{}', { status: 404 });
    };

    const srv = await createMarketSidecarServer({
      listen: false,
      configDir: ws.configDir,
      dataDir: ws.dataDir,
      recoveryDelayMs: -1,
      fetchImpl: mockFetch,
    });

    try {
      // 1. Two concurrent GET /api/updates?force=1 in the same generation -> MUST coalesce into 1 upstream probe
      const p1 = srv.inject({ method: 'GET', url: '/api/updates?force=1' });
      await firstWaveStarted;
      const p2 = srv.inject({ method: 'GET', url: '/api/updates?force=1' });
      releaseFirstWave();
      const [r1, r2] = await Promise.all([p1, p2]);

      assert.equal(r1.statusCode, 200);
      assert.equal(r2.statusCode, 200);
      assert.equal(apiCalls, 1, 'Concurrent GET /api/updates?force=1 must coalesce into a single flight');
      assert.equal(r1.json().items.find((x) => x.dir === 'force-plug')?.latestVersion, '1.8.0');
      assert.equal(r2.json().items.find((x) => x.dir === 'force-plug')?.latestVersion, '1.8.0');

      // 2. Subsequent sequential GET /api/updates?force=1 after completion MUST trigger a fresh probe (no stale in-flight leak)
      const r3 = await srv.inject({ method: 'GET', url: '/api/updates?force=1' });
      assert.equal(r3.statusCode, 200);
      assert.equal(apiCalls, 2, 'Sequential GET /api/updates?force=1 must trigger a new upstream probe after prior flight ends');

      // 3. Clear disk cache and verify concurrent force=0 vs force=1 use distinct flight buckets while coalescing within each bucket
      rmSync(join(ws.dataDir, 'cache'), { recursive: true, force: true });
      const pf0a = srv.inject({ method: 'GET', url: '/api/updates?force=0' });
      await isoForce0Started;
      const pf0b = srv.inject({ method: 'GET', url: '/api/updates?force=0' });
      const pf1a = srv.inject({ method: 'GET', url: '/api/updates?force=1' });
      await isoForce1Started;
      const pf1b = srv.inject({ method: 'GET', url: '/api/updates?force=1' });
      releaseIsoWave();
      const isoResults = await Promise.all([pf0a, pf0b, pf1a, pf1b]);
      for (const res of isoResults) {
        assert.equal(res.statusCode, 200);
      }
      assert.equal(apiCalls, 4, 'Concurrent force=0 (2x) and force=1 (2x) must coalesce into 1 flight per bucket (2 total)');
    } finally {
      await srv.close();
    }
  } finally {
    ws.cleanup();
  }
});

test('Concurrent plugin mutation routes return HTTP 409 ERR_MUTATION_BUSY and release lock upon completion', async () => {
  const ws = makeTempWorkspace('agy-upd-mut-lock-');
  try {
    const alphaBuf = createDeterministicTarGz({
      'plugin.json': JSON.stringify({ name: 'alpha-plug', displayName: 'Alpha Plug', version: '1.2.0', logo: 'assets/logo.svg' }),
      'assets/logo.svg': CLEAN_SVG,
    });
    const alphaSha = createHash('sha256').update(alphaBuf).digest('hex');
    const betaBuf = createDeterministicTarGz({
      'plugin.json': JSON.stringify({ name: 'beta-plug', displayName: 'Beta Plug', version: '1.3.0', logo: 'assets/logo.svg' }),
      'assets/logo.svg': CLEAN_SVG,
    });
    const betaSha = createHash('sha256').update(betaBuf).digest('hex');

    const ALPHA_URL = 'https://github.com/alice/alpha-plug/releases/download/v1.2.0/alpha-plug.tar.gz';
    const BETA_URL = 'https://github.com/bob/beta-plug/releases/download/v1.3.0/beta-plug.tar.gz';

    installFakeLocalPlugin(ws.pluginsDir, {
      dir: 'alpha-plug',
      manifest: { name: 'alpha-plug', displayName: 'Alpha Plug', version: '1.0.0' },
      receipt: {
        schemaVersion: 1,
        id: 'alice__alpha-plug',
        repositoryId: 501,
        installedDir: 'alpha-plug',
        installedVersion: '1.0.0',
        grantedCapabilities: { badges: ['declarative-only'], mcpRemoteDomains: [], hookEvents: [] },
      },
    });
    installFakeLocalPlugin(ws.pluginsDir, {
      dir: 'beta-plug',
      manifest: { name: 'beta-plug', displayName: 'Beta Plug', version: '1.0.0' },
      receipt: {
        schemaVersion: 1,
        id: 'bob__beta-plug',
        repositoryId: 502,
        installedDir: 'beta-plug',
        installedVersion: '1.0.0',
        grantedCapabilities: { badges: ['declarative-only'], mcpRemoteDomains: [], hookEvents: [] },
      },
    });

    const catalogIndex = {
      schemaVersion: 1,
      track: 'verified',
      plugins: [
        makeCatalogPlugin({
          id: 'alice__alpha-plug',
          canonicalName: 'alpha-plug',
          owner: 'alice',
          repo: 'alpha-plug',
          displayName: 'Alpha Plug',
          version: '1.2.0',
          repoId: 501,
          tarballUrl: ALPHA_URL,
          sha256: alphaSha,
          sizeBytes: alphaBuf.length,
        }),
        makeCatalogPlugin({
          id: 'bob__beta-plug',
          canonicalName: 'beta-plug',
          owner: 'bob',
          repo: 'beta-plug',
          displayName: 'Beta Plug',
          version: '1.3.0',
          repoId: 502,
          tarballUrl: BETA_URL,
          sha256: betaSha,
          sizeBytes: betaBuf.length,
        }),
      ],
    };

    let markAlphaStarted;
    let releaseAlphaDownload;
    const alphaStarted = new Promise((r) => {
      markAlphaStarted = r;
    });
    const alphaGate = new Promise((r) => {
      releaseAlphaDownload = r;
    });

    const mockFetch = async (url) => {
      const u = String(url);
      if (u.endsWith('/index.json')) {
        return new Response(JSON.stringify(catalogIndex), { status: 200 });
      }
      if (u === ALPHA_URL) {
        markAlphaStarted();
        await alphaGate;
        return new Response(alphaBuf, { status: 200 });
      }
      if (u === BETA_URL) {
        return new Response(betaBuf, { status: 200 });
      }
      return new Response('{}', { status: 404 });
    };

    const srv = await createMarketSidecarServer({
      listen: false,
      configDir: ws.configDir,
      dataDir: ws.dataDir,
      recoveryDelayMs: -1,
      fetchImpl: mockFetch,
    });

    try {
      const authHeaders = { 'X-Sidecar-Token': srv.sideToken, Origin: 'http://127.0.0.1:43210' };

      // 1. Start first POST /api/update and pause mid-flight inside tarball download while mutation lock is held
      const firstUpdatePromise = srv.inject({
        method: 'POST',
        url: '/api/update',
        headers: authHeaders,
        body: { id: 'alice__alpha-plug', dir: 'alpha-plug' },
      });
      await alphaStarted;
      assert.equal(srv.canRestartForDiskUpdate(), false);

      // 2. Concurrent POST /api/update, POST /api/update-all, and POST /api/install must ALL receive HTTP 409 ERR_MUTATION_BUSY
      const [dupToggle, dupFix, dupUpdate, dupBatch, dupInstall] = await Promise.all([
        srv.inject({ method: 'POST', url: '/api/toggle-plugin', headers: authHeaders, body: { dir: 'alpha-plug', enabled: false } }),
        srv.inject({ method: 'POST', url: '/api/fix-conflict', headers: authHeaders, body: { type: 'isolate-rename', targetDir: 'alpha-plug' } }),
        srv.inject({
          method: 'POST',
          url: '/api/update',
          headers: authHeaders,
          body: { id: 'bob__beta-plug', dir: 'beta-plug' },
        }),
        srv.inject({
          method: 'POST',
          url: '/api/update-all',
          headers: authHeaders,
          body: { ids: ['bob__beta-plug'] },
        }),
        srv.inject({
          method: 'POST',
          url: '/api/install',
          headers: authHeaders,
          body: { id: 'bob__beta-plug' },
        }),
      ]);

      for (const [label, res] of [
        ['POST /api/toggle-plugin', dupToggle],
        ['POST /api/fix-conflict', dupFix],
        ['POST /api/update', dupUpdate],
        ['POST /api/update-all', dupBatch],
        ['POST /api/install', dupInstall],
      ]) {
        assert.equal(res.statusCode, 409, `${label} must return HTTP 409 while another mutation holds lock`);
        const body = res.json();
        assert.equal(body.ok, false);
        assert.equal(body.errorCode, 'ERR_MUTATION_BUSY');
        assert.match(String(body.error || ''), /ERR_MUTATION_BUSY|in progress/i);
      }

      // 3. Release first mutation -> completes with HTTP 200 and releases lock in finally
      releaseAlphaDownload();
      const firstRes = await firstUpdatePromise;
      assert.equal(firstRes.statusCode, 200);
      assert.equal(firstRes.json().ok, true);
      assert.equal(firstRes.json().version, '1.2.0');

      // 4. Subsequent POST /api/update succeeds with HTTP 200 after lock release
      const followUpRes = await srv.inject({
        method: 'POST',
        url: '/api/update',
        headers: authHeaders,
        body: { id: 'bob__beta-plug', dir: 'beta-plug' },
      });
      assert.equal(followUpRes.statusCode, 200);
      assert.equal(followUpRes.json().ok, true);
      assert.equal(followUpRes.json().version, '1.3.0');

      // 5. Failed mutation (400 self-uninstall guard) also releases lock cleanly in finally
      const badUninstall = await srv.inject({
        method: 'POST',
        url: '/api/uninstall',
        headers: authHeaders,
        body: { dir: 'agy-market' },
      });
      assert.equal(badUninstall.statusCode, 400);

      const postErrRes = await srv.inject({
        method: 'POST',
        url: '/api/update',
        headers: authHeaders,
        body: { id: 'bob__beta-plug', dir: 'beta-plug' },
      });
      assert.equal(postErrRes.statusCode, 200);
      assert.equal(postErrRes.json().ok, true);
      assert.equal(srv.canRestartForDiskUpdate(), true);
    } finally {
      await srv.close();
    }
  } finally {
    ws.cleanup();
  }
});

test('v1.5.4 server rejects stale body.plugin downgrade in POST /api/update and POST /api/install in favor of fresher lastCatalog', async () => {
  const ws = makeTempWorkspace('agy-upd-stale-body-');
  try {
    const neko120Buf = createDeterministicTarGz({
      'plugin.json': JSON.stringify({
        name: 'gemini-neko-cockpit',
        displayName: 'Gemini Neko Cockpit',
        version: '1.2.0',
        logo: 'assets/logo.svg',
      }),
      'assets/logo.svg': CLEAN_SVG,
    });
    const neko120Sha = createHash('sha256').update(neko120Buf).digest('hex');

    const neko130Buf = createDeterministicTarGz({
      'plugin.json': JSON.stringify({
        name: 'gemini-neko-cockpit',
        displayName: 'Gemini Neko Cockpit',
        version: '1.3.0',
        logo: 'assets/logo.svg',
      }),
      'assets/logo.svg': CLEAN_SVG,
      'docs/guide.md': '# v1.3.0 docs\n',
    });
    const neko130Sha = createHash('sha256').update(neko130Buf).digest('hex');

    const NEKO_120_URL = 'https://github.com/azwosile/gemini-neko-cockpit/releases/download/v1.2.0/neko-1.2.0.tar.gz';
    const NEKO_130_URL = 'https://github.com/azwosile/gemini-neko-cockpit/releases/download/v1.3.0/neko-1.3.0.tar.gz';

    const staleClientPlugin120 = {
      ...makeCatalogPlugin({
        id: 'azwosile__gemini-neko-cockpit',
        canonicalName: 'gemini-neko-cockpit',
        owner: 'azwosile',
        repo: 'gemini-neko-cockpit',
        displayName: 'Gemini Neko Cockpit',
        version: '1.2.0',
        repoId: 801,
        tarballUrl: NEKO_120_URL,
        sha256: neko120Sha,
        sizeBytes: neko120Buf.length,
      }),
      commitSha: '1'.repeat(40),
    };

    const freshCatalogPlugin130 = {
      ...makeCatalogPlugin({
        id: 'azwosile__gemini-neko-cockpit',
        canonicalName: 'gemini-neko-cockpit',
        owner: 'azwosile',
        repo: 'gemini-neko-cockpit',
        displayName: 'Gemini Neko Cockpit',
        version: '1.3.0',
        repoId: 801,
        tarballUrl: NEKO_130_URL,
        sha256: neko130Sha,
        sizeBytes: neko130Buf.length,
      }),
      commitSha: '2'.repeat(40),
    };

    installFakeLocalPlugin(ws.pluginsDir, {
      dir: 'gemini-neko-cockpit',
      manifest: {
        name: 'gemini-neko-cockpit',
        displayName: 'Gemini Neko Cockpit',
        version: '1.2.0',
        repository: 'https://github.com/azwosile/gemini-neko-cockpit',
      },
      receipt: {
        schemaVersion: 1,
        id: 'azwosile__gemini-neko-cockpit',
        track: 'verified',
        repositoryId: 801,
        installedDir: 'gemini-neko-cockpit',
        installedVersion: '1.2.0',
        gitTag: 'v1.2.0',
        commitSha: '1'.repeat(40),
        sha256: neko120Sha,
        grantedCapabilities: { badges: ['declarative-only'], mcpRemoteDomains: [], hookEvents: [] },
      },
    });

    const catalogIndex = {
      schemaVersion: 1,
      track: 'verified',
      catalogVersion: '2026.1125.1',
      plugins: [freshCatalogPlugin130],
    };

    let downloads120 = 0;
    let downloads130 = 0;
    const mockFetch = async (url) => {
      const u = String(url);
      if (u.endsWith('/index.json')) {
        return new Response(JSON.stringify(catalogIndex), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (u === NEKO_120_URL) {
        downloads120 += 1;
        return new Response(neko120Buf, { status: 200 });
      }
      if (u === NEKO_130_URL) {
        downloads130 += 1;
        return new Response(neko130Buf, { status: 200 });
      }
      if (u === 'https://api.github.com/repos/azwosile/gemini-neko-cockpit/releases/latest') {
        return new Response(
          JSON.stringify({
            tag_name: 'v1.3.0',
            html_url: 'https://github.com/azwosile/gemini-neko-cockpit/releases/tag/v1.3.0',
            body: '## v1.3.0',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response('{}', { status: 404 });
    };

    const srv = await createMarketSidecarServer({
      listen: false,
      configDir: ws.configDir,
      dataDir: ws.dataDir,
      recoveryDelayMs: -1,
      fetchImpl: mockFetch,
    });

    try {
      const authHeaders = { 'X-Sidecar-Token': srv.sideToken, Origin: 'http://127.0.0.1:43210' };

      // 1. Prime server lastCatalog to 1.3.0 via GET /api/updates?force=1 (matching check-updates flow)
      const chk = await srv.inject({ method: 'GET', url: '/api/updates?force=1' });
      assert.equal(chk.statusCode, 200);
      assert.equal(chk.json().items.length, 1);
      assert.equal(chk.json().items[0].latestVersion, '1.3.0');

      // 2. Client submits POST /api/update carrying stale body.plugin (1.2.0) -> server MUST install 1.3.0 from lastCatalog
      const updRes = await srv.inject({
        method: 'POST',
        url: '/api/update',
        headers: authHeaders,
        body: {
          id: 'azwosile__gemini-neko-cockpit',
          dir: 'gemini-neko-cockpit',
          plugin: staleClientPlugin120,
        },
      });
      assert.equal(updRes.statusCode, 200);
      const updBody = updRes.json();
      assert.equal(updBody.ok, true);
      assert.equal(updBody.status, 'INSTALLED');
      assert.equal(updBody.version, '1.3.0');
      assert.equal(downloads120, 0, 'Server must NEVER download stale body.plugin 1.2.0 tarball');
      assert.equal(downloads130, 1, 'Server must download fresher 1.3.0 tarball from lastCatalog');
      assert.equal(
        JSON.parse(readFileSync(join(ws.pluginsDir, 'gemini-neko-cockpit', 'plugin.json'), 'utf8')).version,
        '1.3.0',
      );
      assert.equal(existsSync(join(ws.pluginsDir, 'gemini-neko-cockpit', 'docs', 'guide.md')), true);

      // 3. Repeat POST /api/update with stale body.plugin (1.2.0) when already on 1.3.0 -> HTTP 200 ALREADY_UP_TO_DATE, 0 downloads
      const noopRes = await srv.inject({
        method: 'POST',
        url: '/api/update',
        headers: authHeaders,
        body: {
          id: 'azwosile__gemini-neko-cockpit',
          dir: 'gemini-neko-cockpit',
          plugin: staleClientPlugin120,
        },
      });
      assert.equal(noopRes.statusCode, 200);
      assert.equal(noopRes.json().ok, true);
      assert.equal(noopRes.json().status, 'ALREADY_UP_TO_DATE');
      assert.equal(noopRes.json().alreadyUpToDate, true);
      assert.equal(noopRes.json().noop, true);
      assert.equal(downloads120, 0);
      assert.equal(downloads130, 1);

      // 4. Remove local plugin and test POST /api/install with stale body.plugin (1.2.0) -> still installs 1.3.0
      rmSync(join(ws.pluginsDir, 'gemini-neko-cockpit'), { recursive: true, force: true });
      const instRes = await srv.inject({
        method: 'POST',
        url: '/api/install',
        headers: authHeaders,
        body: {
          id: 'azwosile__gemini-neko-cockpit',
          plugin: staleClientPlugin120,
        },
      });
      assert.equal(instRes.statusCode, 200);
      assert.equal(instRes.json().ok, true);
      assert.equal(instRes.json().version, '1.3.0');
      assert.equal(downloads120, 0);
      assert.equal(downloads130, 2);
    } finally {
      await srv.close();
    }
  } finally {
    ws.cleanup();
  }
});

test('v1.5.4 POST /api/update and /api/update-all return HTTP 200 ALREADY_UP_TO_DATE with 0 downloads, support forceResync: true, and honor preferredDir across dual global dirs', async () => {
  const ws = makeTempWorkspace('agy-upd-noop-resync-');
  try {
    const neko130Buf = createDeterministicTarGz({
      'plugin.json': JSON.stringify({
        name: 'gemini-neko-cockpit',
        displayName: 'Gemini Neko Cockpit',
        version: '1.3.0',
        logo: 'assets/logo.svg',
      }),
      'assets/logo.svg': CLEAN_SVG,
      'extra.txt': 'fresh-1.3.0-payload\n',
    });
    const neko130Sha = createHash('sha256').update(neko130Buf).digest('hex');

    const upstream130Buf = createDeterministicTarGz({
      'gemini-neko-cockpit-1.3.0/plugin.json': JSON.stringify({
        name: 'gemini-neko-cockpit',
        displayName: 'Gemini Neko Cockpit',
        version: '1.3.0',
        logo: 'assets/logo.svg',
      }),
      'gemini-neko-cockpit-1.3.0/assets/logo.svg': CLEAN_SVG,
      'gemini-neko-cockpit-1.3.0/upstream-marker.txt': 'upstream-resync\n',
    });

    const NEKO_130_URL = 'https://github.com/azwosile/gemini-neko-cockpit/releases/download/v1.3.0/neko-1.3.0.tar.gz';
    const NEKO_UPSTREAM_ARCHIVE_URL =
      'https://github.com/azwosile/gemini-neko-cockpit/archive/refs/tags/v1.3.0.tar.gz';

    // Dual global installs sharing the same receipt.id: main dir at 1.3.0 + isolated dir at 1.2.0
    installFakeLocalPlugin(ws.pluginsDir, {
      dir: 'gemini-neko-cockpit',
      manifest: {
        name: 'gemini-neko-cockpit',
        displayName: 'Gemini Neko Cockpit',
        version: '1.3.0',
        repository: 'https://github.com/azwosile/gemini-neko-cockpit',
      },
      receipt: {
        schemaVersion: 1,
        id: 'azwosile__gemini-neko-cockpit',
        track: 'verified',
        repositoryId: 802,
        installedDir: 'gemini-neko-cockpit',
        installedVersion: '1.3.0',
        gitTag: 'v1.3.0',
        commitSha: '2'.repeat(40),
        sha256: neko130Sha,
        grantedCapabilities: { badges: ['declarative-only'], mcpRemoteDomains: [], hookEvents: [] },
      },
    });
    installFakeLocalPlugin(ws.pluginsDir, {
      dir: 'azwosile--gemini-neko-cockpit',
      manifest: {
        name: 'azwosile--gemini-neko-cockpit',
        displayName: 'Gemini Neko Cockpit (Isolated)',
        version: '1.2.0',
        repository: 'https://github.com/azwosile/gemini-neko-cockpit',
      },
      receipt: {
        schemaVersion: 1,
        id: 'azwosile__gemini-neko-cockpit',
        track: 'verified',
        repositoryId: 802,
        installedDir: 'azwosile--gemini-neko-cockpit',
        effectivePluginName: 'azwosile--gemini-neko-cockpit',
        scopedRewriteApplied: true,
        installedVersion: '1.2.0',
        gitTag: 'v1.2.0',
        commitSha: '1'.repeat(40),
        grantedCapabilities: { badges: ['declarative-only'], mcpRemoteDomains: [], hookEvents: [] },
      },
    });

    const catEntry = {
      ...makeCatalogPlugin({
        id: 'azwosile__gemini-neko-cockpit',
        canonicalName: 'gemini-neko-cockpit',
        owner: 'azwosile',
        repo: 'gemini-neko-cockpit',
        displayName: 'Gemini Neko Cockpit',
        version: '1.3.0',
        repoId: 802,
        tarballUrl: NEKO_130_URL,
        sha256: neko130Sha,
        sizeBytes: neko130Buf.length,
      }),
      commitSha: '2'.repeat(40),
    };

    // Preflight preferredDir unit verification before HTTP calls
    const inv = scanLocalPluginInventory({ configDir: ws.configDir, dataDir: ws.dataDir });
    const preflightIsolated = resolveInstallPreflight(catEntry, inv, {
      conflictStrategy: 'prompt',
      preferredDir: 'azwosile--gemini-neko-cockpit',
    });
    assert.equal(preflightIsolated.action, 'update');
    assert.equal(preflightIsolated.existingInstall?.dir, 'azwosile--gemini-neko-cockpit');
    assert.equal(preflightIsolated.existingInstall?.version, '1.2.0');

    let catalogDownloads = 0;
    let upstreamDownloads = 0;
    const mockFetch = async (url) => {
      const u = String(url);
      if (u.endsWith('/index.json')) {
        return new Response(
          JSON.stringify({ schemaVersion: 1, track: 'verified', plugins: [catEntry] }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (u === NEKO_130_URL) {
        catalogDownloads += 1;
        return new Response(neko130Buf, { status: 200 });
      }
      if (u === 'https://api.github.com/repos/azwosile/gemini-neko-cockpit') {
        return new Response(
          JSON.stringify({ id: 802, full_name: 'azwosile/gemini-neko-cockpit', default_branch: 'main' }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (
        u === 'https://api.github.com/repos/azwosile/gemini-neko-cockpit/releases/tags/v1.3.0' ||
        u === 'https://api.github.com/repos/azwosile/gemini-neko-cockpit/releases/latest'
      ) {
        return new Response(
          JSON.stringify({
            tag_name: 'v1.3.0',
            tarball_url: NEKO_UPSTREAM_ARCHIVE_URL,
            html_url: 'https://github.com/azwosile/gemini-neko-cockpit/releases/tag/v1.3.0',
            assets: [],
            body: 'v1.3.0 release',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (u === NEKO_UPSTREAM_ARCHIVE_URL || u.includes('/archive/refs/tags/v1.3.0.tar.gz') || u.includes('/tarball/v1.3.0')) {
        upstreamDownloads += 1;
        return new Response(upstream130Buf, { status: 200 });
      }
      return new Response('{}', { status: 404 });
    };

    const srv = await createMarketSidecarServer({
      listen: false,
      configDir: ws.configDir,
      dataDir: ws.dataDir,
      recoveryDelayMs: -1,
      fetchImpl: mockFetch,
    });

    try {
      const authHeaders = { 'X-Sidecar-Token': srv.sideToken, Origin: 'http://127.0.0.1:43210' };

      // 1. Catalog POST /api/update on already-latest dir (gemini-neko-cockpit 1.3.0) -> HTTP 200 ALREADY_UP_TO_DATE, 0 downloads
      const noopCat = await srv.inject({
        method: 'POST',
        url: '/api/update',
        headers: authHeaders,
        body: { id: 'azwosile__gemini-neko-cockpit', dir: 'gemini-neko-cockpit' },
      });
      assert.equal(noopCat.statusCode, 200);
      const noopCatBody = noopCat.json();
      assert.equal(noopCatBody.ok, true);
      assert.equal(noopCatBody.status, 'ALREADY_UP_TO_DATE');
      assert.equal(noopCatBody.alreadyUpToDate, true);
      assert.equal(noopCatBody.noop, true);
      assert.equal(noopCatBody.installedDir, 'gemini-neko-cockpit');
      assert.equal(noopCatBody.version, '1.3.0');
      assert.equal(noopCatBody.restartRequired, false);
      assert.equal(noopCatBody.reloadRequired, false);
      assert.equal(catalogDownloads, 0, 'Same-version catalog POST /api/update MUST perform 0 tarball downloads');

      // 2. Catalog POST /api/update targeting isolated 1.2.0 dir via preferredDir -> updates isolated dir in-place!
      const isoUpd = await srv.inject({
        method: 'POST',
        url: '/api/update',
        headers: authHeaders,
        body: { id: 'azwosile__gemini-neko-cockpit', dir: 'azwosile--gemini-neko-cockpit' },
      });
      assert.equal(isoUpd.statusCode, 200);
      assert.equal(isoUpd.json().ok, true);
      assert.equal(isoUpd.json().status, 'INSTALLED');
      assert.equal(isoUpd.json().installedDir, 'azwosile--gemini-neko-cockpit');
      assert.equal(catalogDownloads, 1);
      assert.equal(
        JSON.parse(readFileSync(join(ws.pluginsDir, 'azwosile--gemini-neko-cockpit', 'plugin.json'), 'utf8')).version,
        '1.3.0',
      );

      // 3. Catalog POST /api/update WITH forceResync: true -> downloads and overwrites existing 1.3.0 directory
      assert.equal(existsSync(join(ws.pluginsDir, 'gemini-neko-cockpit', 'extra.txt')), false);
      const resyncCat = await srv.inject({
        method: 'POST',
        url: '/api/update',
        headers: authHeaders,
        body: { id: 'azwosile__gemini-neko-cockpit', dir: 'gemini-neko-cockpit', forceResync: true },
      });
      assert.equal(resyncCat.statusCode, 200);
      assert.equal(resyncCat.json().ok, true);
      assert.equal(resyncCat.json().status, 'INSTALLED');
      assert.equal(resyncCat.json().version, '1.3.0');
      assert.equal(catalogDownloads, 2, 'forceResync: true MUST bypass No-Op short-circuit and download tarball');
      assert.equal(existsSync(join(ws.pluginsDir, 'gemini-neko-cockpit', 'extra.txt')), true);

      // 4. POST /api/update-all with explicit ids pointing to already-latest plugin -> ALREADY_UP_TO_DATE, 0 extra downloads
      const batchNoop = await srv.inject({
        method: 'POST',
        url: '/api/update-all',
        headers: authHeaders,
        body: { ids: ['azwosile__gemini-neko-cockpit'] },
      });
      assert.equal(batchNoop.statusCode, 200);
      const batchBody = batchNoop.json();
      assert.equal(batchBody.ok, true);
      assert.equal(batchBody.results.length, 1);
      assert.equal(batchBody.results[0].status, 'ALREADY_UP_TO_DATE');
      assert.equal(batchBody.results[0].alreadyUpToDate, true);
      assert.equal(batchBody.results[0].noop, true);
      assert.equal(catalogDownloads, 2, 'Explicit ids on already-latest plugin in /api/update-all must do 0 downloads');

      // 5. Upstream direct channel (source: 'github-release', targetRef: 'v1.3.0'): No-Op without forceResync, installs with forceResync: true
      const noopUp = await srv.inject({
        method: 'POST',
        url: '/api/update',
        headers: authHeaders,
        body: {
          id: 'azwosile__gemini-neko-cockpit',
          dir: 'gemini-neko-cockpit',
          source: 'github-release',
          updateChannel: 'github-upstream',
          targetRef: 'v1.3.0',
        },
      });
      assert.equal(noopUp.statusCode, 200);
      assert.equal(noopUp.json().ok, true);
      assert.equal(noopUp.json().status, 'ALREADY_UP_TO_DATE');
      assert.equal(noopUp.json().alreadyUpToDate, true);
      assert.equal(noopUp.json().noop, true);
      assert.equal(upstreamDownloads, 0, 'Same-tag upstream POST /api/update MUST do 0 archive downloads');

      const resyncUp = await srv.inject({
        method: 'POST',
        url: '/api/update',
        headers: authHeaders,
        body: {
          id: 'azwosile__gemini-neko-cockpit',
          dir: 'gemini-neko-cockpit',
          source: 'github-release',
          updateChannel: 'github-upstream',
          targetRef: 'v1.3.0',
          forceResync: true,
        },
      });
      assert.equal(resyncUp.statusCode, 200);
      assert.equal(resyncUp.json().ok, true);
      assert.equal(resyncUp.json().status, 'INSTALLED');
      assert.equal(upstreamDownloads, 1, 'forceResync: true on upstream channel MUST download and overwrite');
      assert.equal(existsSync(join(ws.pluginsDir, 'gemini-neko-cockpit', 'upstream-marker.txt')), true);
    } finally {
      await srv.close();
    }
  } finally {
    ws.cleanup();
  }
});

test('v1.5.4 same version with different distribution sha256 (agy-dart & agy-market scenario) never reports false updates', async () => {
  const ws = makeTempWorkspace('agy-upd-diff-sha-');
  try {
    const dartTar = buildTarArtifact(ws.artifactsDir, 'agy-dart-1.7.2.tar.gz', {
      'plugin.json': JSON.stringify({ name: 'agy-dart', displayName: 'AGY Dart', version: '1.7.2' }),
    });
    const marketTar = buildTarArtifact(ws.artifactsDir, 'agy-market-1.5.4.tar.gz', {
      'plugin.json': JSON.stringify({ name: 'agy-market', displayName: 'AGY Market', version: '1.5.4' }),
    });

    // Local receipts have legitimately different sha256 digests vs catalog archive digests (e.g. local copy / tag tarball)
    installFakeLocalPlugin(ws.pluginsDir, {
      dir: 'agy-dart',
      manifest: {
        name: 'agy-dart',
        displayName: 'AGY Dart',
        version: '1.7.2',
        repository: 'https://github.com/azwosile/agy-dart',
      },
      receipt: {
        schemaVersion: 1,
        id: 'azwosile__agy-dart',
        track: 'verified',
        repositoryId: 901,
        installedDir: 'agy-dart',
        installedVersion: '1.7.2',
        gitTag: 'v1.7.2',
        commitSha: 'd'.repeat(40),
        sha256: `7369087c${'0'.repeat(56)}`,
        grantedCapabilities: { badges: ['declarative-only'], mcpRemoteDomains: [], hookEvents: [] },
      },
    });
    installFakeLocalPlugin(ws.pluginsDir, {
      dir: 'agy-market',
      manifest: {
        name: 'agy-market',
        displayName: 'AGY Market',
        version: '1.5.4',
        repository: 'https://github.com/azwosile/agy-market',
      },
      receipt: {
        schemaVersion: 1,
        id: 'azwosile__agy-market',
        track: 'verified',
        repositoryId: 1468650761,
        installedDir: 'agy-market',
        installedVersion: '1.5.4',
        gitTag: 'v1.5.4',
        sha256: `78f68582${'0'.repeat(56)}`,
        grantedCapabilities: { badges: ['sidecar-ui'], mcpRemoteDomains: [], hookEvents: [] },
      },
    });

    const catalogIndex = {
      schemaVersion: 1,
      track: 'verified',
      plugins: [
        {
          ...makeCatalogPlugin({
            id: 'azwosile__agy-dart',
            canonicalName: 'agy-dart',
            owner: 'azwosile',
            repo: 'agy-dart',
            displayName: 'AGY Dart',
            version: '1.7.2',
            repoId: 901,
            tarballUrl: dartTar.url,
            sha256: `e9f1435b${'f'.repeat(56)}`,
            sizeBytes: dartTar.sizeBytes,
          }),
          commitSha: 'd'.repeat(40),
        },
        {
          ...makeCatalogPlugin({
            id: 'azwosile__agy-market',
            canonicalName: 'agy-market',
            owner: 'azwosile',
            repo: 'agy-market',
            displayName: 'AGY Market',
            version: '1.5.4',
            repoId: 1468650761,
            tarballUrl: marketTar.url,
            sha256: `0691e6e1${'e'.repeat(56)}`,
            sizeBytes: marketTar.sizeBytes,
            badges: ['sidecar-ui'],
          }),
          commitSha: 'c'.repeat(40),
        },
      ],
    };

    const mockFetch = async (url) => {
      const u = String(url);
      if (u.endsWith('/index.json')) {
        return new Response(JSON.stringify(catalogIndex), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (u === 'https://api.github.com/repos/azwosile/agy-dart/releases/latest') {
        return new Response(JSON.stringify({ tag_name: 'v1.7.2', body: '1.7.2' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (u === 'https://api.github.com/repos/azwosile/agy-market/releases/latest') {
        return new Response(JSON.stringify({ tag_name: 'v1.5.4', body: '1.5.4' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('{}', { status: 404 });
    };

    const srv = await createMarketSidecarServer({
      listen: false,
      configDir: ws.configDir,
      dataDir: ws.dataDir,
      recoveryDelayMs: -1,
      fetchImpl: mockFetch,
    });

    try {
      const updRes = await srv.inject({ method: 'GET', url: '/api/updates?force=1' });
      assert.equal(updRes.statusCode, 200);
      const updBody = updRes.json();
      assert.deepEqual(updBody.items, [], 'Different sha256 on same SemVer must NEVER trigger updates');
      assert.equal(updBody.selfUpdate, null, 'Different sha256 on same agy-market SemVer must NEVER trigger selfUpdate');

      const stRes = await srv.inject({ method: 'GET', url: '/api/state' });
      assert.equal(stRes.statusCode, 200);
      const stBody = stRes.json();
      assert.deepEqual(stBody.updatesAvailable, []);
      for (const p of stBody.catalog.plugins) {
        assert.equal(p.installStatus.hasUpdate, false, `${p.id} must have hasUpdate === false`);
      }
    } finally {
      await srv.close();
    }
  } finally {
    ws.cleanup();
  }
});

test('v1.5.4 scanner version priority (RC-4): externally upgraded manifest.version beats stale receipt, while older manifest does not downgrade newer receipt', async () => {
  const ws = makeTempWorkspace('agy-upd-rc4-scanner-');
  try {
    // 1. Externally upgraded plugin: manifest.version (1.4.0) > stale receipt.installedVersion (1.2.0)
    installFakeLocalPlugin(ws.pluginsDir, {
      dir: 'ext-upgraded',
      manifest: {
        name: 'ext-upgraded',
        displayName: 'Externally Upgraded',
        version: '1.4.0',
        repository: 'https://github.com/alice/ext-upgraded',
      },
      receipt: {
        schemaVersion: 1,
        id: 'alice__ext-upgraded',
        track: 'verified',
        repositoryId: 911,
        installedDir: 'ext-upgraded',
        installedVersion: '1.2.0',
        gitTag: 'v1.2.0',
        grantedCapabilities: { badges: ['declarative-only'], mcpRemoteDomains: [], hookEvents: [] },
      },
    });

    // 2. Unbumped manifest inside newer tag release: manifest.version (1.2.0) < receipt.installedVersion (1.3.0)
    installFakeLocalPlugin(ws.pluginsDir, {
      dir: 'tag-newer',
      manifest: {
        name: 'tag-newer',
        displayName: 'Tag Newer',
        version: '1.2.0',
        repository: 'https://github.com/bob/tag-newer',
      },
      receipt: {
        schemaVersion: 1,
        id: 'bob__tag-newer',
        track: 'verified',
        repositoryId: 912,
        installedDir: 'tag-newer',
        installedVersion: '1.3.0',
        gitTag: 'v1.3.0',
        grantedCapabilities: { badges: ['declarative-only'], mcpRemoteDomains: [], hookEvents: [] },
      },
    });

    const inv = scanLocalPluginInventory({ configDir: ws.configDir, dataDir: ws.dataDir });
    const extLoc = inv.installed.find((x) => x.dir === 'ext-upgraded');
    const tagLoc = inv.installed.find((x) => x.dir === 'tag-newer');
    assert.equal(extLoc?.version, '1.4.0', 'Externally upgraded manifest.version > receipt must win');
    assert.equal(tagLoc?.version, '1.3.0', 'Older manifest.version < receipt must NOT downgrade receipt version');

    const dummyTar = buildTarArtifact(ws.artifactsDir, 'dummy-1.3.0.tar.gz', {
      'plugin.json': JSON.stringify({ name: 'dummy', version: '1.3.0' }),
    });
    const catalogIndex = {
      schemaVersion: 1,
      track: 'verified',
      plugins: [
        makeCatalogPlugin({
          id: 'alice__ext-upgraded',
          canonicalName: 'ext-upgraded',
          owner: 'alice',
          repo: 'ext-upgraded',
          displayName: 'Externally Upgraded',
          version: '1.3.0',
          repoId: 911,
          tarballUrl: dummyTar.url,
          sha256: dummyTar.sha256,
          sizeBytes: dummyTar.sizeBytes,
        }),
        makeCatalogPlugin({
          id: 'bob__tag-newer',
          canonicalName: 'tag-newer',
          owner: 'bob',
          repo: 'tag-newer',
          displayName: 'Tag Newer',
          version: '1.3.0',
          repoId: 912,
          tarballUrl: dummyTar.url,
          sha256: dummyTar.sha256,
          sizeBytes: dummyTar.sizeBytes,
        }),
      ],
    };

    const mockFetch = async (url) => {
      const u = String(url);
      if (u.endsWith('/index.json')) {
        return new Response(JSON.stringify(catalogIndex), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response('{}', { status: 404 });
    };

    const srv = await createMarketSidecarServer({
      listen: false,
      configDir: ws.configDir,
      dataDir: ws.dataDir,
      recoveryDelayMs: -1,
      fetchImpl: mockFetch,
    });

    try {
      const updRes = await srv.inject({ method: 'GET', url: '/api/updates?force=1' });
      assert.equal(updRes.statusCode, 200);
      assert.deepEqual(
        updRes.json().items,
        [],
        'Neither externally upgraded (1.4.0 vs 1.3.0) nor tag-newer (1.3.0 vs 1.3.0) may produce a spurious update',
      );
    } finally {
      await srv.close();
    }
  } finally {
    ws.cleanup();
  }
});

test('Update All updates a renamed root plugin in its original directory and skips a superseded legacy copy', async t => {
  const oldName = 'antigravity-plugin-context-mode';
  const repo = `https://github.com/domush/${oldName}`;
  const id = `domush__${oldName}`;
  const scoped = 'domush--context-mode';
  for (const [hasManagedCopy, catalogRenamed, byId] of [[false, false, false], [false, true, false], [false, true, true], [true, true, false]]) {
    await t.test(`managed=${hasManagedCopy} catalogRenamed=${catalogRenamed} byId=${byId}`, async () => {
      const ws = makeTempWorkspace();
      const oldManifest = { name: oldName, displayName: 'Context Mode', version: '2.0.0', repository: repo };
      const newManifest = { ...oldManifest, name: 'context-mode', version: '2.0.1' };
      const tar = createDeterministicTarGz({ 'plugin.json': JSON.stringify(newManifest) });
      const catalogEntry = makeCatalogPlugin({ id, canonicalName: catalogRenamed ? 'context-mode' : oldName, owner: 'domush', repo: oldName,
        displayName: 'Context Mode', version: '2.0.0', repoId: 42, sha256: 'f'.repeat(64), tarballUrl: repo + '/old.tar.gz' });
      catalogEntry.forceScopedInstall = true;
      installFakeLocalPlugin(ws.pluginsDir, { dir: oldName, manifest: oldManifest });
      if (hasManagedCopy) installFakeLocalPlugin(ws.pluginsDir, { dir: scoped, manifest: { ...newManifest, name: scoped },
        receipt: { id, repositoryId: 42, installedVersion: '2.0.1', gitTag: 'v2.0.1', repositoryUrl: repo,
          pluginRoot: '.', scopedRewriteApplied: true, effectivePluginName: scoped } });
      let downloads = 0;
      const srv = await createMarketSidecarServer({ listen: false, recoveryDelayMs: -1, configDir: ws.configDir, dataDir: ws.dataDir,
        fetchImpl: async url => {
          const u = String(url);
          if (u.endsWith('/unverified-index.json')) return Response.json({ schemaVersion: 1, track: 'unverified', plugins: [catalogEntry] });
          if (u.endsWith('/index.json')) return Response.json({ schemaVersion: 1, track: 'verified', plugins: [] });
          if (u.includes('domush/') && /releases\/(latest|tags\/v2\.0\.1)$/.test(u)) return Response.json({ tag_name: 'v2.0.1', html_url: repo + '/releases/tag/v2.0.1', assets: [] });
          if (u.endsWith('/repos/domush/' + oldName)) return Response.json({ id: 42, full_name: 'domush/' + oldName, default_branch: 'main' });
          if (u.includes('domush/') && u.includes('tar.gz')) { downloads++; return new Response(tar); }
          return new Response('{}', { status: 404 });
        } });
      const post = (url, body) => srv.inject({ method: 'POST', url, headers: { 'x-sidecar-token': srv.sideToken }, body });
      try {
        const state = (await srv.inject({ method: 'GET', url: '/api/state' })).json();
        assert.equal(state.catalog.plugins.find(p => p.id === id).installStatus.installedDir, hasManagedCopy ? scoped : oldName);
        if (hasManagedCopy) assert.equal(state.installed.find(loc => loc.dir === oldName).successorDir, scoped);
        const updates = async () => (await srv.inject({ method: 'GET', url: '/api/updates?force=1' })).json().items;
        assert.equal((await updates()).some(item => item.dir === oldName), !hasManagedCopy);
        const batch = (await post('/api/update-all', byId ? { ids: [id] } : {})).json();
        if (hasManagedCopy) {
          assert.equal(batch.results.length, 0);
          assert.equal((await post('/api/update-all', { ids: [oldName] })).json().results[0].status, 'LEGACY_DUPLICATE');
          for (const preferUpstream of [false, true]) {
            const rejection = await post('/api/update', { id, dir: oldName, preferUpstream });
            assert.equal(rejection.statusCode, 409);
            assert.equal(rejection.json().successorDir, scoped);
          }
          const conflicts = (await srv.inject({ method: 'GET', url: '/api/conflicts' })).json();
          assert.ok(conflicts.items.some(i => i.type === 'duplicate-repo-install' && i.paths.length === 2));
          assert.equal(downloads, 0);
        } else {
          assert.equal(batch.results[0]?.ok, true, JSON.stringify(batch.results));
          const receipt = JSON.parse(readFileSync(join(ws.pluginsDir, oldName, '.agy-market-receipt.json')));
          assert.equal(receipt.installedDir, oldName);
          assert.equal(receipt.effectivePluginName, newManifest.name);
          assert.equal(receipt.installedVersion, newManifest.version);
          assert.ok(!existsSync(join(ws.pluginsDir, scoped)));
        }
        assert.deepEqual(await updates(), []);
      } finally { await srv.close(); ws.cleanup(); }
    });
  }
});

test('a targeted rename cannot adopt another monorepo child, a missing directory, or the market itself', () => {
  const url = 'https://github.com/demo/legacy';
  const local = { scope: 'global', dir: 'legacy', name: 'legacy', repositoryUrl: url };
  const plugin = { id: 'demo__legacy', canonicalName: 'renamed', repository: { url, pluginRoot: 'plugins/b' } };
  const target = (entry, installed, dir) => resolveInstallPreflight(entry, { installed }, { preferredDir: dir, requireExistingDir: true });
  assert.throws(() => target(plugin, [local], local.dir), /ERR_UPDATE_TARGET_MISMATCH/);
  assert.throws(() => target(plugin, [local], 'missing'), /ERR_UPDATE_TARGET_MISMATCH/);
  assert.throws(() => target(plugin, [{ ...local, dir: 'agy-market' }], 'agy-market'), /ERR_CANNOT_REPLACE_SELF/);
  const managedChild = { scope: 'global', dir: 'demo--child', name: 'demo--child',
    receipt: { id: plugin.id, repositoryUrl: url, scopedRewriteApplied: true, pluginRoot: 'plugins/b' } };
  assert.equal(target({ ...plugin, canonicalName: 'legacy', repository: { url, pluginRoot: '.' } },
    [local, managedChild], local.dir).targetDir, local.dir);
});

test('manual monorepo metadata prevents root adoption, including same-name entries', () => {
  const ws = makeTempWorkspace();
  const url = 'https://github.com/demo/legacy';
  try {
    for (const [dir, repository] of [['legacy', { url, directory: 'plugins/legacy' }], ['tree', url + '/tree/main/plugins/tree']]) {
      installFakeLocalPlugin(ws.pluginsDir, { dir, manifest: { name: dir, version: '1.0.0', repository } });
    }
    const inventory = scanLocalPluginInventory({ configDir: ws.configDir, dataDir: ws.dataDir });
    for (const loc of inventory.installed) {
      for (const canonicalName of [loc.name, 'renamed']) {
        const plugin = { id: 'demo__legacy', canonicalName, repository: { url, pluginRoot: '.' } };
        assert.throws(() => resolveInstallPreflight(plugin, inventory, { preferredDir: loc.dir, requireExistingDir: true }), /ERR_UPDATE_TARGET_MISMATCH/);
      }
    }
  } finally { ws.cleanup(); }
});

test('two installed directories sharing a catalog ID keep their own receipts and staged manifest names', async () => {
  const ws = makeTempWorkspace();
  const url = 'https://github.com/demo/alias';
  const id = 'demo__alias';
  const dirs = ['alias', 'demo--alias'];
  const artifact = buildTarArtifact(ws.artifactsDir, 'alias.tar.gz', {
    'plugin.json': JSON.stringify({ name: 'real-name', version: '2.0.0', repository: url }),
  });
  const plugin = makeCatalogPlugin({ id, canonicalName: 'alias', owner: 'demo', repo: 'alias', displayName: 'Alias',
    version: '2.0.0', repoId: 42, tarballUrl: artifact.url, sha256: artifact.sha256 });
  for (const dir of dirs) {
    installFakeLocalPlugin(ws.pluginsDir, { dir, manifest: { name: dir, version: '1.0.0', repository: url },
      receipt: { id, repositoryId: 42, installedVersion: '1.0.0', installedDir: dir, repositoryUrl: url,
        pluginRoot: '.', scopedRewriteApplied: dir !== 'alias', effectivePluginName: dir } });
  }
  const srv = await createMarketSidecarServer({ listen: false, recoveryDelayMs: -1, configDir: ws.configDir,
    dataDir: ws.dataDir, fetchImpl: async url => String(url).endsWith('/index.json')
      ? Response.json({ schemaVersion: 1, track: 'verified', plugins: [plugin] }) : new Response('{}', { status: 404 }) });
  try {
    const post = (url, body) => srv.inject({ method: 'POST', url, headers: { 'x-sidecar-token': srv.sideToken }, body });
    const batch = (await post('/api/update-all', { ids: dirs })).json();
    assert.deepEqual(batch.results.map(r => [r.dir, r.ok]), dirs.map(dir => [dir, true]), JSON.stringify(batch.results));
    for (const dir of dirs) {
      const expectedName = dir === 'alias' ? 'real-name' : dir;
      assert.equal(JSON.parse(readFileSync(join(ws.pluginsDir, dir, 'plugin.json'))).name, expectedName);
      assert.equal(JSON.parse(readFileSync(join(ws.pluginsDir, dir, '.agy-market-receipt.json'))).effectivePluginName, expectedName);
    }
    const resync = (await post('/api/update', { id, dir: 'alias', forceResync: true })).json();
    assert.equal(resync.effectivePluginName, 'real-name');
  } finally { await srv.close(); ws.cleanup(); }
});

test('manual source identity reconciles repository, package and same-repository homepage evidence', async () => {
  const ws = makeTempWorkspace();
  const url = 'https://github.com/demo/legacy';
  const plugin = { id: 'demo__legacy', canonicalName: 'renamed', repository: { url, pluginRoot: '.' } };
  try {
    installFakeLocalPlugin(ws.pluginsDir, { dir: 'legacy', manifest: {
      name: 'legacy', version: '1.0.0', repository: url, homepage: url + '/tree/main/plugins/legacy',
    } });
    installFakeLocalPlugin(ws.pluginsDir, { dir: 'branch', manifest: {
      name: 'branch', version: '1.0.0', repository: url + '/tree/main',
    } });
    installFakeLocalPlugin(ws.pluginsDir, { dir: 'ambiguous', manifest: {
      name: 'ambiguous', version: '1.0.0', repository: { url, directory: 'plugins/a' }, homepage: url + '/tree/main/plugins/b',
    } });
    const inventory = scanLocalPluginInventory({ configDir: ws.configDir, dataDir: ws.dataDir });
    const byDir = new Map(inventory.installed.map(loc => [loc.dir, loc]));
    assert.equal(byDir.get('legacy').repositoryRoot, 'plugins/legacy');
    assert.equal(byDir.get('branch').repositoryRoot, '.');
    assert.equal(byDir.get('ambiguous').repositoryRoot, null);
    const srv = await createMarketSidecarServer({ listen: false, recoveryDelayMs: -1, configDir: ws.configDir, dataDir: ws.dataDir,
      fetchImpl: async () => new Response('{}', { status: 404 }) });
    try {
      const report = (await srv.inject({ method: 'GET', url: '/api/updates?force=1' })).json();
      assert.deepEqual(report.uncheckedDirs, ['ambiguous']);
      const direct = await srv.inject({ method: 'POST', url: '/api/update', headers: { 'x-sidecar-token': srv.sideToken },
        body: { dir: 'ambiguous', preferUpstream: true, targetRef: 'v1.0.0' } });
      assert.equal(direct.json().status, 'UNRESOLVED_PLUGIN_ROOT');
    } finally { await srv.close(); }
    assert.throws(() => resolveInstallPreflight(plugin, inventory, { preferredDir: 'legacy', requireExistingDir: true }), /TARGET_MISMATCH/);
  } finally { ws.cleanup(); }
});

test('scoped catalog updates reuse the receipt across equivalent root spellings and preserve user data', async () => {
  const ws = makeTempWorkspace();
  const dir = 'demo--reader';
  const id = 'demo__tools__reader';
  const url = 'https://github.com/demo/tools';
  const artifact = buildTarArtifact(ws.artifactsDir, 'reader.tar.gz', {
    'README.md': 'tools', 'plugins/reader/plugin.json': JSON.stringify({ name: 'reader', version: '2.0.0', repository: url }),
    'plugins/reader/settings.json': 'new default',
  });
  const plugin = makeCatalogPlugin({ id, canonicalName: 'reader', owner: 'demo', repo: 'tools', displayName: 'Reader',
    version: '2.0.0', repoId: 42, tarballUrl: artifact.url, sha256: artifact.sha256, badges: ['sidecar-ui'] });
  plugin.forceScopedInstall = true;
  plugin.repository.pluginRoot = './plugins/reader/';
  installFakeLocalPlugin(ws.pluginsDir, { dir, manifest: { name: dir, version: '1.0.0' },
    receipt: { id, repositoryId: 42, repositoryUrl: url, installedDir: dir, installedVersion: '1.0.0',
      effectivePluginName: dir, scopedRewriteApplied: true, pluginRoot: 'plugins/reader', preservePaths: ['settings.json'],
      grantedCapabilities: { badges: ['declarative-only'] } } });
  writeFileSync(join(ws.pluginsDir, dir, 'settings.json'), 'my settings');
  const srv = await createMarketSidecarServer({ listen: false, recoveryDelayMs: -1, configDir: ws.configDir, dataDir: ws.dataDir,
    fetchImpl: async u => String(u).endsWith('/index.json') ? Response.json({ schemaVersion: 1, track: 'verified', plugins: [plugin] }) : new Response('{}', { status: 404 }) });
  try {
    const post = async (path, body) => (await srv.inject({ method: 'POST', url: path, headers: { 'x-sidecar-token': srv.sideToken }, body })).json();
    const pending = await post('/api/install', { id });
    assert.equal(pending.status, 'CAPABILITY_ESCALATION_CONFIRM_REQUIRED');
    const updated = await post('/api/update', { id, dir, confirmEscalation: true, approvalKey: pending.escalation.approvalKey });
    assert.equal(updated.ok, true, JSON.stringify(updated.error));
    assert.equal(updated.receipt.pluginRoot, 'plugins/reader');
    assert.equal(readFileSync(join(ws.pluginsDir, dir, 'settings.json'), 'utf8'), 'my settings');
    assert.equal((await post('/api/update', { id, dir })).status, 'ALREADY_UP_TO_DATE');
    const mismatch = await post('/api/install', { plugin: { ...plugin, version: '3.0.0',
      repository: { ...plugin.repository, pluginRoot: 'plugins/unrelated' } } });
    assert.equal(mismatch.status, 'CATALOG_ENTRY_CHANGED');
    plugin.repository.pluginRoot = 'plugins/unrelated';
    await srv.inject({ url: '/api/state?refresh=1' });
    assert.match((await post('/api/install', { id })).error, /ERR_SCOPED_TARGET_OCCUPIED/);
    assert.equal(JSON.parse(readFileSync(join(ws.pluginsDir, dir, '.agy-market-receipt.json'))).installedVersion, '2.0.0');
  } finally { await srv.close(); ws.cleanup(); }
});

test('explicit catalog ID wins over an earlier directory alias when updating a renamed plugin', async () => {
  const ws = makeTempWorkspace();
  const dir = 'legacy';
  const url = 'https://github.com/zzz/legacy';
  installFakeLocalPlugin(ws.pluginsDir, { dir, manifest: { name: dir, version: '1.0.0', repository: url } });
  const tar = buildTarArtifact(ws.artifactsDir, 'release.tgz', { 'plugin.json': JSON.stringify({ name: 'renamed', version: '2.0.0', repository: url }) });
  const correct = makeCatalogPlugin({ id: 'zzz__legacy', owner: 'zzz', repo: dir, canonicalName: 'renamed', displayName: 'Z',
    version: '2.0.0', repoId: 2, sha256: tar.sha256, tarballUrl: tar.url });
  const alias = makeCatalogPlugin({ id: 'aaa__other', owner: 'aaa', repo: 'other', canonicalName: dir, displayName: 'A',
    version: '3.0.0', repoId: 1, sha256: 'f'.repeat(64), tarballUrl: 'https://example.invalid/other.tgz' });
  const srv = await createMarketSidecarServer({ listen: false, recoveryDelayMs: -1, configDir: ws.configDir, dataDir: ws.dataDir,
    fetchImpl: async u => String(u).endsWith('/index.json') ? Response.json({ schemaVersion: 1, plugins: [alias, correct] }) : new Response('{}', {status: 404}) });
  try {
    const post = async (url, body) => (await srv.inject({ method: 'POST', url, headers: { 'x-sidecar-token': srv.sideToken }, body })).json();
    const stale = await post('/api/update', { id: 'removed__entry', dir });
    assert.equal(stale.status, 'UPDATE_TARGET_MISMATCH');
    const foreign = await post('/api/update', { id: alias.id, dir, preferUpstream: true, targetRef: 'v1.0.0' });
    assert.equal(foreign.status, 'UPDATE_TARGET_MISMATCH');
    const result = await post('/api/update', { id: correct.id, dir, plugin: correct });
    assert.equal(result.ok, true, result.error);
    assert.equal(result.receipt.id, correct.id);
    const repeat = await post('/api/update', { dir });
    assert.equal(repeat.status, 'ALREADY_UP_TO_DATE', repeat.error);
    const batch = await post('/api/update-all', { ids: [dir] });
    assert.equal(batch.results[0].id, correct.id);
  } finally { await srv.close(); ws.cleanup(); }
});

test('bare manual monorepo source resolves a unique catalog child and leaves ambiguous roots unchecked', async () => {
  const ws = makeTempWorkspace();
  const url = 'https://github.com/demo/tools';
  const roots = ['plugins/reader', 'plugins/a', 'plugins/b'];
  for (const dir of ['reader', 'shared']) {
    installFakeLocalPlugin(ws.pluginsDir, { dir, manifest: { name: dir, version: '1.0.0', repository: url } });
  }
  const tar = buildTarArtifact(ws.artifactsDir, 'mono.tgz', { 'README.md': 'tools',
    'plugins/reader/plugin.json': JSON.stringify({ name: 'reader', version: '2.0.0', repository: url }) });
  const entries = roots.map((root, i) => {
    const name = i ? 'shared' : 'reader';
    const plugin = makeCatalogPlugin({ id: 'demo__tools--' + root.split('/')[1], owner: 'demo', repo: 'tools', canonicalName: name,
      displayName: name, version: '2.0.0', repoId: 42, sha256: tar.sha256, tarballUrl: tar.url });
    plugin.repository.pluginRoot = root;
    return plugin;
  });
  const srv = await createMarketSidecarServer({ listen: false, recoveryDelayMs: -1, configDir: ws.configDir, dataDir: ws.dataDir,
    fetchImpl: async u => String(u).endsWith('/index.json') ? Response.json({ schemaVersion: 1, plugins: entries }) : new Response('{}', {status: 404}) });
  try {
    const state = (await srv.inject({method: 'GET', url: '/api/state'})).json();
    assert.equal(state.catalog.plugins.find(p => p.id === entries[0].id).installStatus.installedDir, 'reader');
    assert.equal(state.installed.find(loc => loc.dir === 'shared').repositoryRoot, null);
    const report = (await srv.inject({method: 'GET', url: '/api/updates?force=1'})).json();
    assert.deepEqual(report.uncheckedDirs, ['shared']);
    assert.equal(report.items.find(item => item.dir === 'reader').id, entries[0].id);
    const post = async (path, body) => (await srv.inject({method: 'POST', url: path, headers: {'x-sidecar-token':srv.sideToken}, body})).json();
    assert.equal((await post('/api/update', {id: entries[1].id, dir: 'shared'})).ok, false);
    assert.equal((await post('/api/update', {dir: 'shared', preferUpstream: true})).status, 'UNRESOLVED_PLUGIN_ROOT');
    assert.equal((await post('/api/update-all', {ids: ['shared']})).results[0].ok, false);
    const batch = await post('/api/update-all', {ids: ['reader']});
    assert.equal(batch.results[0].ok, true, JSON.stringify(batch.results));
    assert.equal(JSON.parse(readFileSync(join(ws.pluginsDir,'reader','.agy-market-receipt.json'))).pluginRoot, roots[0]);
    assert.ok(!existsSync(join(ws.pluginsDir,'shared','.agy-market-receipt.json')));
  } finally { await srv.close(); ws.cleanup(); }
});

test('warm and cold update checks keep distinct raw manifests for colliding subdirectory spellings', async () => {
  const ws = makeTempWorkspace();
  const url = 'https://github.com/demo/tools';
  const roots = new Map([['one','plugins/a'], ['two','plugins_a'], ['three','Plugins/A']]);
  for (const [dir, directory] of roots) {
    installFakeLocalPlugin(ws.pluginsDir, { dir, manifest: { name: dir, version: '1.0.0', repository: {url, directory} } });
  }
  let rawReads = 0;
  const srv = await createMarketSidecarServer({ listen: false, recoveryDelayMs: -1, configDir: ws.configDir, dataDir: ws.dataDir,
    fetchImpl: async u => {
      const path = String(u);
      if (path.endsWith('/index.json')) return Response.json({schemaVersion:1, plugins:[]});
      if (path === 'https://api.github.com/repos/demo/tools/releases/latest') return Response.json({tag_name:'v2.0.0'});
      for (const [name, root] of roots) {
        if (path === 'https://raw.githubusercontent.com/demo/tools/v2.0.0/' + root + '/plugin.json') {
          rawReads++; return Response.json({name,version:'2.0.0'});
        }
      }
      return new Response('{}',{status:404});
    } });
  try {
    for (const force of [1, 0]) {
      const report = (await srv.inject({method:'GET',url:'/api/updates?force='+force})).json();
      assert.deepEqual(report.items.map(item=>item.dir).sort(), [...roots.keys()].sort());
      assert.equal(rawReads, roots.size);
    }
  } finally { await srv.close(); ws.cleanup(); }
});

function layoutInstaller(ws) {
  const repo = 'https://github.com/demo/layout';
  return async function install(version, files, options = {}) {
    const tar = buildTarArtifact(ws.artifactsDir, version + '.tgz', {
      'plugin.json': JSON.stringify({ name: 'layout', version, repository: repo }),
      'a.txt': version,
      ...files,
    });
    const plugin = makeCatalogPlugin({ id: 'demo__layout', owner: 'demo', repo: 'layout',
      canonicalName: 'layout', displayName: 'Layout', repoId: 42, version, sha256: tar.sha256, tarballUrl: tar.url });
    return installOrUpdateCatalogPlugin({ configDir: ws.configDir, dataDir: ws.dataDir, plugin, ...options });
  };
}

test('managed layout transitions preserve user files and a failed sync can complete from its own journal', async () => {
  const ws = makeTempWorkspace();
  const dir = join(ws.pluginsDir, 'layout');
  const install = layoutInstaller(ws);
  try {
    await install('1.0.0', { z: 'file' });
    await install('2.0.0', { 'z/entry': 'child' });
    assert.equal(readFileSync(join(dir, 'z/entry'), 'utf8'), 'child');
    writeFileSync(join(dir, 'z/user'), 'keep');
    await assert.rejects(install('3.0.0', { z: 'file again' }), /ERR_PLUGIN_LAYOUT_CONFLICT/);
    assert.equal(readFileSync(join(dir, 'a.txt'), 'utf8'), '2.0.0');
    assert.equal(readFileSync(join(dir, 'z/user'), 'utf8'), 'keep');
    assert.equal(existsSync(join(ws.dataDir, 'pending-journal.json')), false);
    rmSync(join(dir, 'z/user'));
    await assert.rejects(install('3.0.0', { z: 'file again' }, {
      writeOverride(src, dst, rel) {
        if (rel === 'z') throw new Error('simulated disk failure');
        copyFileSync(src, dst);
      },
    }), /simulated disk failure/);
    const pending = join(ws.dataDir, 'pending-journal.json');
    const journal = readFileSync(pending, 'utf8');
    await assert.rejects(install('4.0.0', { z: 'different' }), /ERR_PENDING_RECOVERY/);
    assert.equal(readFileSync(pending, 'utf8'), journal);
    assert.equal(recoverInterruptedJournal(ws).action, 'completed-forward');
    assert.equal(readFileSync(join(dir, 'z'), 'utf8'), 'file again');
    assert.equal(JSON.parse(readFileSync(join(dir, '.agy-market-receipt.json'))).installedVersion, '3.0.0');
    assert.equal(existsSync(pending), false);
  } finally { ws.cleanup(); }
});

test('case-only renames keep the updated content and receipt on the actual target filesystem', async () => {
  const ws = makeTempWorkspace();
  try {
    const install = layoutInstaller(ws);
    const root = join(ws.pluginsDir, 'layout');
    await install('1.0.0', { 'Bin/Runner.js': 'old' });
    const out = await install('2.0.0', { 'bin/runner.js': 'new' });
    assert.equal(readFileSync(join(root, 'bin/runner.js'), 'utf8'), 'new');
    assert.deepEqual(readdirSync(join(root, 'bin')), ['runner.js']);
    assert.ok(readdirSync(root).includes('bin'));
    assert.ok(out.receipt.managedFiles.includes('bin/runner.js'));
    await install('3.0.0', {});
    assert.equal(existsSync(join(root, 'bin/runner.js')), false);
  } finally { ws.cleanup(); }
});

test('live writers keep their journal; recovery and uninstall use the original destination', async () => {
  const ws = makeTempWorkspace();
  const custom = join(ws.root, 'custom');
  const install = layoutInstaller(ws);
  const moduleUrl = new URL('../src/installer/journal.mjs', import.meta.url).href;
  const recovery = `import {recoverInterruptedJournal} from ${JSON.stringify(moduleUrl)};
    console.log(recoverInterruptedJournal(JSON.parse(process.argv[1])).action);`;
  const simulatedFailure = { pluginsDir: custom, writeOverride() { throw new Error('interrupted'); } };
  try {
    await install('1.0.0', {}, { pluginsDir: custom });
    let liveResult;
    await install('2.0.0', {}, { pluginsDir: custom, writeOverride(src, dst) {
      if (!liveResult) liveResult = execFileSync(process.execPath, ['--input-type=module', '-e', recovery,
        JSON.stringify({ dataDir: ws.dataDir, pluginsDir: ws.pluginsDir })], { encoding: 'utf8' }).trim();
      copyFileSync(src, dst);
    } });
    assert.equal(liveResult, 'busy');
    await assert.rejects(install('3.0.0', {}, simulatedFailure), /interrupted/);
    await uninstallPlugin({ dir: 'layout', configDir: ws.configDir, dataDir: ws.dataDir });
    // Simulate a separate writer exiting without releasing its ticket.
    execFileSync(process.execPath, ['--input-type=module', '-e',
      `import {acquirePluginMutation} from ${JSON.stringify(moduleUrl)}; acquirePluginMutation(process.argv[1]);`, ws.dataDir]);
    assert.equal(recoverInterruptedJournal(ws).action, 'completed-forward');
    assert.equal(existsSync(join(ws.pluginsDir, 'layout')), false);
    assert.equal(JSON.parse(readFileSync(join(custom, 'layout/plugin.json'))).version, '3.0.0');
    await assert.rejects(install('4.0.0', {}, simulatedFailure), /interrupted/);
    assert.equal((await uninstallPlugin({ dir: 'layout', pluginsDir: custom, configDir: ws.configDir, dataDir: ws.dataDir })).removed, true);
    assert.equal(recoverInterruptedJournal(ws).action, 'none');
    assert.equal(existsSync(join(custom, 'layout')), false);
  } finally { ws.cleanup(); }
});

test('manual plugins use their installed capabilities for the first managed update', async () => {
  const ws = makeTempWorkspace();
  try {
    const name = 'reader';
    const repository = 'https://github.com/demo/reader';
    installFakeLocalPlugin(ws.pluginsDir, { dir: name, manifest: { name, version: '1.0.0', repository } });
    const dir = join(ws.pluginsDir, name);
    mkdirSync(join(dir, 'sidecars/pane'), { recursive: true });
    writeFileSync(join(dir, 'sidecars/pane/sidecar.json'), JSON.stringify({ has_web_ui: true }));
    const tar = buildTarArtifact(ws.artifactsDir, 'reader.tgz', {
      'plugin.json': JSON.stringify({ name, version: '2.0.0', repository }),
      'sidecars/pane/sidecar.json': JSON.stringify({ has_web_ui: true }),
    });
    const plugin = makeCatalogPlugin({ id: 'demo__reader', owner: 'demo', repo: name, canonicalName: name,
      displayName: 'Reader', version: '2.0.0', repoId: 42, tarballUrl: tar.url, sha256: tar.sha256,
      badges: ['sidecar-ui', 'mcp-remote'], mcpRemoteDomains: ['service.example'] });
    const options = { plugin, configDir: ws.configDir, dataDir: ws.dataDir };
    const pending = await installOrUpdateCatalogPlugin(options);
    assert.equal(pending.status, 'CAPABILITY_ESCALATION_CONFIRM_REQUIRED');
    assert.deepEqual(pending.escalation.addedBadges, ['mcp-remote']);
    assert.deepEqual(pending.escalation.addedRemoteDomains, ['service.example']);
    assert.equal(JSON.parse(readFileSync(join(dir, 'plugin.json'))).version, '1.0.0');
    const updated = await installOrUpdateCatalogPlugin({ ...options, confirmEscalation: true, approvalKey: pending.escalation.approvalKey });
    assert.equal(updated.ok, true);
    assert.deepEqual(updated.receipt.grantedCapabilities.mcpRemoteDomains, ['service.example']);
  } finally { ws.cleanup(); }
});


test('update commits to the current active or parked copy and never resurrects an uninstall during download', async () => {
  const ws = makeTempWorkspace();
  const active = join(ws.pluginsDir, 'layout', 'plugin.json');
  const parked = join(ws.dataDir, 'disabled-plugins', 'layout', 'plugin.json');
  const options = { configDir: ws.configDir, dataDir: ws.dataDir };
  async function updateDuring(version, move) {
    const tar = buildTarArtifact(ws.artifactsDir, version + '.tgz', {
      'plugin.json': JSON.stringify({ name: 'layout', version, repository: 'https://github.com/demo/layout' }),
    });
    const plugin = makeCatalogPlugin({ id: 'demo__layout', owner: 'demo', repo: 'layout',
      canonicalName: 'layout', displayName: 'Layout', repoId: 42, version, sha256: tar.sha256,
      tarballUrl: 'https://github.com/demo/layout/releases/download/v' + version + '/layout.tgz' });
    return installOrUpdateCatalogPlugin({ ...options, plugin, fetchImpl: async () => {
      await move();
      return new Response(readFileSync(tar.path));
    } });
  }
  try {
    await layoutInstaller(ws)('1.0.0', {});
    for (const [version, enabled] of [['2.0.0', false], ['3.0.0', true]]) {
      const result = await updateDuring(version, () => toggleInstalledPlugin({ ...options, dir: 'layout', enabled }));
      assert.equal(result.parkedByMarket, !enabled);
      assert.equal(existsSync(enabled ? parked : active), false);
      assert.equal(JSON.parse(readFileSync(enabled ? active : parked)).version, version);
    }
    await assert.rejects(updateDuring('4.0.0', () => uninstallPlugin({ ...options, dir: 'layout' })), /ERR_UPDATE_TARGET_MISMATCH/);
    assert.equal(existsSync(active) || existsSync(parked), false);
  } finally { ws.cleanup(); }
});

test('npx bootstrap supersedes only its interrupted self-update after a successful install', async () => {
  const ws = makeTempWorkspace();
  const version = JSON.parse(readFileSync(join(REPO_ROOT, 'plugin.json'))).version;
  const pending = join(ws.dataDir, 'pending-journal.json');
  const cli = join(REPO_ROOT, 'bin', 'agy-market.mjs');
  const env = { ...process.env, AGY_MARKET_DATA_DIR: ws.dataDir, ANTIGRAVITY_CONFIG_DIR: ws.configDir };
  delete env.ELECTRON_RUN_AS_NODE;
  function bootstrap(dest) {
    execFileSync(process.execPath, [cli, 'install', '--dest', dest], { env, stdio: 'pipe' });
  }
  const target = join(ws.pluginsDir, 'agy-market');
  async function installSelf(v, fail = false) {
    const tar = buildTarArtifact(ws.artifactsDir, v + '.tgz', {
      'plugin.json': JSON.stringify({ name: 'agy-market', version: v }),
    });
    const plugin = makeCatalogPlugin({ id: 'azwosile__agy-market', owner: 'azwosile', repo: 'agy-market',
      canonicalName: 'agy-market', displayName: 'AGY Market', repoId: 1468650761, version: v,
      sha256: tar.sha256, tarballUrl: tar.url });
    return installOrUpdateCatalogPlugin({ configDir: ws.configDir, dataDir: ws.dataDir, plugin,
      writeOverride: fail ? () => { throw new Error('interrupted self-update'); } : null });
  }
  try {
    await installSelf('1.7.1');
    await assert.rejects(installSelf('1.7.2', true), /interrupted self-update/);
    // Older journals infer the global plugins root from the host, even when bootstrap uses --dest.
    const journal = JSON.parse(readFileSync(pending));
    delete journal.pluginsDir;
    writeFileSync(pending, JSON.stringify(journal));
    const otherRoot = join(ws.root, 'other');
    bootstrap(otherRoot);
    assert.deepEqual(JSON.parse(readFileSync(pending)), journal);
    const release = acquirePluginMutation(ws.dataDir);
    try { assert.throws(() => bootstrap(ws.pluginsDir), /Another plugin operation is active/); }
    finally { release(); }
    // A user-owned directory blocks a required file. Failed bootstrap must keep recovery available.
    const blocked = join(target, 'package.json');
    mkdirSync(blocked);
    writeFileSync(join(blocked, 'notes'), 'user');
    assert.throws(() => bootstrap(ws.pluginsDir), /ERR_PLUGIN_LAYOUT_CONFLICT/);
    assert.deepEqual(JSON.parse(readFileSync(pending)), journal);
    assert.equal(existsSync(journal.stagingBundleDir), true);
    rmSync(blocked, { recursive: true });
    bootstrap(ws.pluginsDir);
    assert.equal(recoverInterruptedJournal(ws).action, 'none');
    assert.equal(JSON.parse(readFileSync(join(target, 'plugin.json'))).version, version);
    assert.equal(JSON.parse(readFileSync(join(target, '.agy-market-receipt.json'))).installedVersion, version);
    assert.equal(existsSync(journal.stagingRootDir), false);
    assert.equal(existsSync(journal.backupDir), false);
  } finally { ws.cleanup(); }
});

test('upstream outages identify unchecked installs, preserve known updates and retry a failed forced check', async () => {
  const ws = makeTempWorkspace();
  let failing = false;
  for (const name of ['alpha', 'beta']) installFakeLocalPlugin(ws.pluginsDir, {
    dir: name, manifest: { name, version: '1.0.0', repository: 'https://github.com/demo/' + name },
    receipt: { id: 'demo__' + name, track: 'github-url' },
  });
  const srv = await createMarketSidecarServer({ ...ws, listen: false, recoveryDelayMs: -1, fetchImpl: async url => {
    const path = String(url);
    if (path.endsWith('/index.json')) return Response.json({ schemaVersion: 1, plugins: [] });
    if (failing && (path.includes('/demo/alpha/') || path.includes('/demo/beta/tags'))) return new Response('', { status: 502 });
    if (path.includes('/demo/beta/releases/latest')) return Response.json({ tag_name: 'v2.0.0' });
    if (path.includes('/tags?')) return Response.json([]);
    return new Response('{}', { status: 404 });
  } });
  const check = async force => (await srv.inject({ method: 'GET', url: '/api/updates?force=' + Number(force) })).json();
  try {
    assert.deepEqual((await check(true)).uncheckedDirs, []);
    failing = true;
    for (const force of [true, false]) {
      const report = await check(force);
      assert.deepEqual(report.uncheckedDirs, ['alpha']);
      assert.deepEqual(report.unavailableDirs, ['alpha']);
      assert.ok(report.items.some(item => item.dir === 'beta' && item.latestVersion === '2.0.0'));
    }
    failing = false;
    assert.deepEqual((await check(false)).uncheckedDirs, []);
  } finally { await srv.close(); ws.cleanup(); }
});

test('favorite keys separate global, builtin and multiple workspace copies across removal and restart', async () => {
  const ws = makeTempWorkspace();
  const workspaceRoots = ['workspace-a', 'workspace-b'].map(name => join(ws.root, name));
  const builtinPluginsDir = join(ws.root, 'builtin');
  const roots = [ws.pluginsDir, builtinPluginsDir, ...workspaceRoots.map(root => join(root, '.agents', 'plugins'))];
  roots.forEach((root, i) => installFakeLocalPlugin(root, { dir: 'reader',
    manifest: { name: 'reader', version: '1.0.0', displayName: 'Reader', repository: 'https://github.com/team' + i + '/reader' } }));
  const workspaceUris = workspaceRoots.map(path => pathToFileURL(path).href);
  writeFileSync(join(ws.dataDir, 'prefs.json'), JSON.stringify({ favorites: ['local:reader'],
    favoriteSources: { 'local:reader': { repositoryUrl: 'https://github.com/team3/reader', pluginRoot: '.' } } }));
  const opts = { ...ws, builtinPluginsDir, listen: false, recoveryDelayMs: -1, fetchImpl: async () => Response.json({ plugins: [] }) };
  let srv = await createMarketSidecarServer(opts);
  const state = async () => (await srv.inject({ method: 'GET', url: '/api/state?workspaceUris=' + encodeURIComponent(workspaceUris.join(',')) })).json();
  const post = async (url, body) => (await srv.inject({ method: 'POST', url,
    headers: { 'x-sidecar-token': srv.sideToken }, body: { ...body, workspaceUris } })).json();
  try {
    let data = await state();
    const byRepo = new Map(data.installed.map(loc => [loc.repositoryUrl, loc.favoriteKey]));
    const keys = roots.map((_, i) => byRepo.get('https://github.com/team' + i + '/reader'));
    assert.equal(new Set(keys).size, 4);
    for (const key of keys) assert.match(key, /^copy:[a-f0-9]{64}$/);
    assert.deepEqual(data.prefs.favorites, [keys[3]]);
    for (const key of keys.slice(0, 3)) await post('/api/favorites', { key, favorite: true });
    await srv.close();
    srv = await createMarketSidecarServer(opts);
    data = await state();
    assert.deepEqual(new Set(data.prefs.favorites), new Set(keys));
    keys.forEach((key, i) => assert.equal(data.prefs.favoriteSources[key].repositoryUrl, 'https://github.com/team' + i + '/reader'));
    const removed = await post('/api/uninstall', { dir: 'reader', removeFavorite: true });
    assert.equal(removed.removed, true);
    assert.deepEqual(new Set(removed.state.prefs.favorites), new Set(keys.slice(1)));
    assert.equal(removed.state.prefs.favoriteSources[keys[0]], undefined);
    await srv.close();
    writeFileSync(join(ws.dataDir, 'prefs.json'), JSON.stringify({ favorites: ['local:reader'] }));
    srv = await createMarketSidecarServer(opts);
    assert.deepEqual((await state()).prefs.favorites, ['saved:reader']);
    const closedWorkspaces = (await srv.inject({ method: 'GET', url: '/api/state' })).json();
    assert.deepEqual(closedWorkspaces.prefs.favorites, ['saved:reader']);
  } finally { await srv.close(); ws.cleanup(); }
});

test('replacing a catalog conflict binds the displayed copy across the confirmation interval', async t => {
  let plugin;
  const { ws, post } = await openUpdateFixture(t, async () => Response.json({ plugins: [plugin] }));
  const archive = buildTarArtifact(ws.artifactsDir, 'reader.tgz', { 'plugin.json': JSON.stringify({ name: 'reader', version: '2.0.0' }) });
  plugin = makeCatalogPlugin({ id: 'demo__reader', canonicalName: 'reader', owner: 'demo', repo: 'reader',
    displayName: 'Reader', version: '2.0.0', repoId: 221, tarballUrl: archive.url, sha256: archive.sha256 });
  for (const dir of ['first', 'second']) installFakeLocalPlugin(ws.pluginsDir, { dir,
    manifest: { name: 'reader', version: '1.0.0', repository: 'https://github.com/' + dir + '/reader' } });
  const request = { id: plugin.id };
  const preview = await post('/api/install', request);
  assert.equal(preview.conflict.dir, 'first');
  assert.match(preview.replacementKey, /^[a-f0-9]{64}$/);
  rmSync(join(ws.pluginsDir, 'first'), { recursive: true });
  const result = await post('/api/install', { ...request, conflictStrategy: 'replace', replacementKey: preview.replacementKey });
  assert.match(result.error, /ERR_REPLACEMENT_TARGET_CHANGED/);
  assert.equal(JSON.parse(readFileSync(join(ws.pluginsDir, 'second', 'plugin.json'))).version, '1.0.0');
  const next = await post('/api/install', { ...request, conflictStrategy: 'replace' });
  assert.equal(next.status, 'CONFLICT_CHOICE_REQUIRED');
  assert.notEqual(next.replacementKey, preview.replacementKey);
  assert.equal((await post('/api/install', { ...request, conflictStrategy: 'replace', replacementKey: next.replacementKey })).installedDir, 'second');
});

test('kept favorites retain GitHub source, tracked branch and subdirectory across uninstall and restart', async () => {
  const ws = makeTempWorkspace();
  const id = 'demo__tools--reader';
  const repo = 'https://github.com/demo/tools';
  const opts = { ...ws, listen: false, recoveryDelayMs: -1,
    fetchImpl: async () => Response.json({ schemaVersion: 1, plugins: [] }) };
  installFakeLocalPlugin(ws.pluginsDir, { dir: 'reader', manifest: { name: 'reader', displayName: 'Ledger Reader', version: '1.0.0' },
    receipt: { id, track: 'github-url', repositoryUrl: repo, pluginRoot: 'plugins/reader', githubSource: { trackBranch: 'preview' } } });
  // An existing string-only bookmark from a previous version.
  writeFileSync(join(ws.dataDir, 'prefs.json'), JSON.stringify({ favorites: [id] }));
  let srv = await createMarketSidecarServer(opts);
  const post = async (url, body) => (await srv.inject({ method: 'POST', url, headers: { 'x-sidecar-token': srv.sideToken }, body })).json();
  try {
    const res = await post('/api/uninstall', { dir: 'reader', removeFavorite: false });
    assert.equal(res.removed, true);
    const expected = { displayName: 'Ledger Reader', repositoryUrl: repo, pluginRoot: 'plugins/reader', trackBranch: 'preview' };
    assert.deepEqual(res.state.prefs.favoriteSources[id], expected);
    await srv.close();
    srv = await createMarketSidecarServer(opts);
    const prefs = (await srv.inject({ method: 'GET', url: '/api/state' })).json().prefs;
    assert.deepEqual(prefs.favorites, [id]);
    assert.deepEqual(prefs.favoriteSources[id], expected);
    await post('/api/favorites', { key: id, favorite: false });
    assert.deepEqual(JSON.parse(readFileSync(join(ws.dataDir, 'prefs.json'))).favoriteSources, {});
  } finally { await srv.close(); ws.cleanup(); }
});


test('native install offers isolation for unidentified active and parked directories', async () => {
  for (const parked of [false, true]) {
    const ws = makeTempWorkspace();
    try {
      const parent = parked ? join(ws.dataDir, 'disabled-plugins') : ws.pluginsDir;
      const occupied = join(parent, 'reader');
      mkdirSync(occupied, { recursive: true });
      writeFileSync(join(occupied, 'notes.txt'), 'local draft');
      const tar = buildTarArtifact(ws.artifactsDir, 'reader.tgz', {
        'plugin.json': JSON.stringify({ name: 'reader', version: '1.0.0' }), 'notes.txt': 'package default',
      });
      const plugin = makeCatalogPlugin({ id: 'demo__reader', canonicalName: 'reader', owner: 'demo', repo: 'reader',
        displayName: 'Reader', repoId: 41, version: '1.0.0', tarballUrl: tar.url, sha256: tar.sha256 });
      const options = { plugin, configDir: ws.configDir, dataDir: ws.dataDir };
      const prompt = await installOrUpdateCatalogPlugin(options);
      assert.equal(prompt.status, 'CONFLICT_CHOICE_REQUIRED');
      assert.deepEqual(prompt.choices, ['isolate']);
      await assert.rejects(installOrUpdateCatalogPlugin({ ...options, conflictStrategy: 'replace' }), /ERR_TARGET_DIR_EXISTS/);
      const result = await installOrUpdateCatalogPlugin({ ...options, conflictStrategy: 'isolate' });
      assert.equal(result.installedDir, 'demo--reader');
      assert.equal(readFileSync(join(occupied, 'notes.txt'), 'utf8'), 'local draft');
      assert.equal(existsSync(join(occupied, 'plugin.json')), false);
    } finally { ws.cleanup(); }
  }
});

test('unpark refuses an occupied active directory and keeps both copies available', () => {
  const ws = makeTempWorkspace();
  try {
    const dir = 'reader';
    const toggle = enabled => toggleInstalledPlugin({ configDir: ws.configDir, dataDir: ws.dataDir, dir, enabled });
    const active = join(ws.pluginsDir, dir);
    const parked = join(ws.dataDir, 'disabled-plugins', dir);
    installFakeLocalPlugin(ws.pluginsDir, { dir, manifest: { name: 'reader', version: '1.0.0' } });
    toggle(false);
    installFakeLocalPlugin(ws.pluginsDir, { dir, manifest: { name: 'different-plugin', version: '3.0.0' } });
    assert.throws(() => toggle(true), /ERR_TARGET_DIR_EXISTS/);
    assert.equal(JSON.parse(readFileSync(join(active, 'plugin.json'))).name, 'different-plugin');
    assert.equal(JSON.parse(readFileSync(join(parked, 'plugin.json'))).name, 'reader');
    rmSync(join(active, 'plugin.json'));
    writeFileSync(join(active, 'notes.txt'), 'local draft');
    assert.throws(() => toggle(true), /ERR_TARGET_DIR_EXISTS/);
    assert.equal(readFileSync(join(active, 'notes.txt'), 'utf8'), 'local draft');
    rmSync(join(active, 'notes.txt'));
    assert.equal(toggle(true).enabled, true);
    assert.equal(JSON.parse(readFileSync(join(active, 'plugin.json'))).name, 'reader');
  } finally { ws.cleanup(); }
});

test('rollback restores bundled dependencies and retains the journal if the backup is incomplete', async () => {
  const ws = makeTempWorkspace();
  const dependency = 'node_modules/helper/index.js';
  const manifest = version => JSON.stringify({ name: 'reader', version });
  function release(version, files) {
    const tar = buildTarArtifact(ws.artifactsDir, version + '.tgz', { 'plugin.json': manifest(version), ...files });
    return makeCatalogPlugin({ id: 'demo__reader', canonicalName: 'reader', owner: 'demo', repo: 'reader',
      displayName: 'Reader', repoId: 41, version, tarballUrl: tar.url, sha256: tar.sha256 });
  }
  try {
    const options = { configDir: ws.configDir, dataDir: ws.dataDir };
    const active = join(ws.pluginsDir, 'reader');
    await installOrUpdateCatalogPlugin({ ...options, plugin: release('1.0.0', { [dependency]: 'original' }) });
    const newOnly = 'node_modules/helper/extra.js';
    await assert.rejects(installOrUpdateCatalogPlugin({ ...options,
      plugin: release('2.0.0', { [dependency]: 'updated', [newOnly]: 'new' }),
      writeOverride(src, dst, rel) {
        if (rel === 'plugin.json') throw new Error('interrupted');
        copyFileSync(src, dst);
      },
    }), /interrupted/);
    const journalPath = join(ws.dataDir, 'pending-journal.json');
    const record = JSON.parse(readFileSync(journalPath));
    // Keep the new manifest but lose one required staged payload file.
    rmSync(join(record.stagingBundleDir, dependency));
    const savedFile = join(record.backupDir, dependency);
    assert.equal(readFileSync(savedFile, 'utf8'), 'original');
    rmSync(savedFile);
    assert.match(recoverInterruptedJournal(ws).error, /ERR_INCOMPLETE_BACKUP/);
    assert.ok(existsSync(journalPath));
    assert.equal(readFileSync(join(active, dependency), 'utf8'), 'updated');
    writeFileSync(savedFile, 'original');
    assert.equal(recoverInterruptedJournal(ws).action, 'rolled-back');
    assert.equal(readFileSync(join(active, dependency), 'utf8'), 'original');
    assert.equal(existsSync(join(active, newOnly)), false);
    assert.equal(JSON.parse(readFileSync(join(active, '.agy-market-receipt.json'))).installedVersion, '1.0.0');
    assert.equal(existsSync(journalPath), false);
  } finally { ws.cleanup(); }
});


test('uninstall confirmation stays bound to the selected manual copy even with identical metadata', async t => {
  const { ws, server, post } = await openUpdateFixture(t, async () => Response.json({ plugins: [] }));
  const dir = 'reader';
  const manifest = { name: dir, version: '1.0.0' };
  installFakeLocalPlugin(ws.pluginsDir, { dir, manifest });
  const current = async () => (await server.inject({ url: '/api/state?refresh=1' })).json().installed.find(loc => loc.dir === dir);
  const selected = await current();
  assert.match(selected.uninstallKey, /^[\da-f]{64}$/);
  const expected = { parked: false, id: '', name: dir, repositoryUrl: '', key: selected.uninstallKey };
  const path = join(ws.pluginsDir, dir);
  renameSync(path, join(ws.root, 'old-copy'));
  installFakeLocalPlugin(ws.pluginsDir, { dir, manifest });
  writeFileSync(join(path, 'work.txt'), 'private draft');
  const refused = await post('/api/uninstall', { dir, expectedInstall: expected });
  assert.match(refused.error, /ERR_UNINSTALL_TARGET_CHANGED/);
  assert.equal(readFileSync(join(path, 'work.txt'), 'utf8'), 'private draft');
  const next = await current();
  assert.notEqual(next.uninstallKey, selected.uninstallKey);
  assert.equal((await post('/api/uninstall', { dir, expectedInstall: { ...expected, key: next.uninstallKey } })).removed, true);
});

test('opening a warm panel conditionally revalidates once and a newer refresh wins on disk and in memory', async t => {
  const old = { id: 'team__reader', canonicalName: 'reader', version: '1.0.0' };
  const headers = [];
  let release;
  let started;
  const blocked = new Promise(resolve => { started = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const modified = 'Wed, 25 Nov 2026 12:00:00 GMT';
  const { server, post } = await openUpdateFixture(t, async (url, init) => {
    assert.ok(url.endsWith('/index.json'));
    headers.push(new Headers(init.headers));
    switch (headers.length) {
      case 1: return Response.json({ plugins: [old] }, { headers: { etag: '"v1"', 'last-modified': modified } });
      case 2: return new Response(null, { status: 304 });
      case 3:
        started();
        await gate;
        return Response.json({ plugins: [old] }, { headers: { etag: '"withdrawn"' } });
      case 4: return Response.json({ plugins: [] }, { headers: { etag: '"v2"' } });
      case 5: return new Response(null, { status: 304 });
      default: return Response.json({ plugins: [old] }, { headers: { etag: '"v3"' } });
    }
  });
  const state = async query => (await server.inject({ url: '/api/state' + query })).json().catalog.plugins.map(p => p.id);
  assert.deepEqual(await state('?panelOpen=1'), [old.id]);
  assert.deepEqual(await state(''), [old.id]);
  assert.equal(headers.length, 1);
  assert.deepEqual(await state('?panelOpen=1'), [old.id]);
  assert.equal(headers[1].get('if-none-match'), '"v1"');
  assert.equal(headers[1].get('if-modified-since'), modified);

  const reopening = state('?panelOpen=1');
  await blocked;
  const anotherPanel = state('?panelOpen=1');
  const reader = state('');
  const preflight = post('/api/preflight', { id: old.id });
  try {
    assert.deepEqual(await state('?refresh=1'), []);
    assert.equal(headers.length, 4);
    assert.equal(headers[3].get('if-none-match'), null);
  } finally { release(); }
  for (const ids of await Promise.all([reopening, anotherPanel, reader])) assert.deepEqual(ids, []);
  assert.match((await preflight).error, /not found in active catalog/);
  assert.deepEqual(await state('?panelOpen=1'), []);
  assert.equal(headers.at(-1).get('if-none-match'), '"v2"');
  assert.deepEqual(await state('?panelOpen=1'), [old.id]);
  assert.deepEqual(await state(''), [old.id]);
  assert.equal(headers.length, 6);
});

test('uninstall only changes a catalog favorite when the installed source owns it', async t => {
  const entry = { id: 'team__reader', canonicalName: 'reader', version: '1.0.0',
    repository: { url: 'https://github.com/team/reader', pluginRoot: '.' } };
  const { ws, server, post } = await openUpdateFixture(t, async () => Response.json({ plugins: [entry] }));
  await server.inject({ url: '/api/state' });
  const favorite = await post('/api/favorites', { key: entry.id, favorite: true, plugin: entry });
  const other = 'https://github.com/other/reader';
  for (const receipt of [null, { id: entry.id, repositoryUrl: other, pluginRoot: '.', installedVersion: '1.0.0' },
    { id: entry.id, repositoryUrl: entry.repository.url, pluginRoot: 'plugins/other', installedVersion: '1.0.0' }]) {
    for (const removeFavorite of [false, true]) {
      installFakeLocalPlugin(ws.pluginsDir, { dir: 'reader', manifest: {
        name: 'reader', version: '1.0.0', repository: receipt?.repositoryUrl || other,
      }, receipt });
      const result = await post('/api/uninstall', { dir: 'reader', removeFavorite });
      assert.equal(result.removed, true, result.error);
      assert.deepEqual(result.state.prefs.favorites, [entry.id]);
      assert.deepEqual(result.state.prefs.favoriteSources, favorite.favoriteSources);
    }
  }
  installFakeLocalPlugin(ws.pluginsDir, { dir: 'reader', manifest: {
    name: 'reader', version: '1.0.0', repository: entry.repository.url,
  } });
  const result = await post('/api/uninstall', { dir: 'reader', removeFavorite: true });
  assert.equal(result.removed, true);
  assert.deepEqual(result.state.prefs.favorites, []);
});

test('legacy receipt ids alone cannot grant another catalog source ownership during uninstall', async t => {
  const id = 'team__reader';
  const catalogRepo = 'https://github.com/team/reader';
  const oldRepo = 'https://github.com/other/reader';
  const entry = { id, canonicalName: 'reader', version: '1.0.0', repository: { url: catalogRepo, pluginRoot: '.' },
    capabilities: { badges: ['mcp-stdio'], mcpServers: ['reader'] } };
  const { ws, post } = await openUpdateFixture(t, async () => Response.json({ plugins: [entry] }));
  writeFileSync(join(ws.dataDir, 'prefs.json'), JSON.stringify({ favorites: [id] }));
  installFakeLocalPlugin(ws.pluginsDir, { dir: 'reader', manifest: { name: 'reader', version: '1.0.0', repository: oldRepo },
    receipt: { id, installedVersion: '1.0.0' } });
  const removed = await post('/api/uninstall', { dir: 'reader', removeFavorite: true });
  assert.equal(removed.removed, true);
  assert.equal(removed.hadMcp, false);
  assert.deepEqual(removed.state.prefs.favorites, [id]);
  assert.equal(removed.state.prefs.favoriteSources[id].repositoryUrl, catalogRepo);
});

test('keeping a catalog favorite uses its installed receipt source across an upstream manifest URL', async t => {
  const id = 'team__reader';
  const repositoryUrl = 'https://github.com/team/reader';
  const entry = { id, canonicalName: 'reader', version: '1.0.0', repository: { url: repositoryUrl, pluginRoot: '.' } };
  const { ws, server, post } = await openUpdateFixture(t, async () => Response.json({ plugins: [entry] }));
  await server.inject({ url: '/api/state' });
  await post('/api/favorites', { key: id, favorite: true, plugin: entry });
  installFakeLocalPlugin(ws.pluginsDir, { dir: 'reader', manifest: { name: 'reader', version: '1.0.0',
    repository: 'https://github.com/upstream/reader' }, receipt: { id, track: 'verified', installedVersion: '1.0.0',
    repositoryUrl, pluginRoot: '.' } });
  const removed = await post('/api/uninstall', { dir: 'reader', removeFavorite: false });
  assert.equal(removed.removed, true);
  assert.deepEqual(removed.state.prefs.favorites, [id]);
  assert.equal(removed.state.prefs.favoriteSources[id].repositoryUrl, repositoryUrl);
});

test('catalog favorites retain the reviewed repository and root across feed changes', async t => {
  const key = 'team__reader';
  const makeEntry = (repo, root) => ({ id: key, canonicalName: 'reader', version: '1.0.0', displayName: repo,
    repository: { url: 'https://github.com/team/' + repo, pluginRoot: root } });
  const original = makeEntry('original', 'plugins/reader');
  let entry = original;
  const { server, post } = await openUpdateFixture(t, async () => Response.json({ plugins: [entry] }));
  const state = async () => (await server.inject({ url: '/api/state?refresh=1' })).json();
  await state();
  const added = await post('/api/favorites', { key, favorite: true, plugin: original });
  assert.equal(added.favoriteSources[key].repositoryUrl, original.repository.url);
  assert.equal(added.favoriteSources[key].pluginRoot, 'plugins/reader');
  entry = makeEntry('new', '.');
  const switched = await state();
  const [oldBookmark] = switched.prefs.favorites;
  assert.match(oldBookmark, /^saved:/);
  assert.equal(switched.prefs.favoriteSources[oldBookmark].repositoryUrl, original.repository.url);
  assert.equal((await post('/api/favorites', { key, favorite: true, plugin: original })).ok, false);
  const second = await post('/api/favorites', { key, favorite: true, plugin: entry });
  assert.deepEqual(new Set(second.favorites), new Set([key, oldBookmark]));
  entry = original;
  const restored = await state();
  assert.equal(restored.prefs.favoriteSources[key].repositoryUrl, original.repository.url);
  assert.deepEqual(Object.values(restored.prefs.favoriteSources).map(src => src.repositoryUrl).sort(),
    ['https://github.com/team/new', original.repository.url]);
});

test('uninstall removes only the visible installation and keeps a different parked copy', async () => {
  const ws = makeTempWorkspace();
  try {
    const dir = 'reader';
    const parkedParent = join(ws.dataDir, 'disabled-plugins');
    installFakeLocalPlugin(parkedParent, { dir, manifest: { name: 'old-reader', version: '1.0.0' } });
    installFakeLocalPlugin(ws.pluginsDir, { dir, manifest: { name: 'new-reader', version: '2.0.0' } });
    const notes = join(parkedParent, dir, 'notes.txt');
    writeFileSync(notes, 'user notes');
    const pending = join(ws.dataDir, 'pending-journal.json');
    writeFileSync(pending, JSON.stringify({ dir, pluginsDir: ws.pluginsDir, parkedByMarket: true }));
    const expectedInstall = { name: 'new-reader', id: '', parked: false };
    await assert.rejects(uninstallPlugin({ ...ws, dir,
      expectedInstall: { ...expectedInstall, repositoryUrl: 'https://github.com/previous/reader' },
    }), /ERR_UNINSTALL_TARGET_CHANGED/);
    assert.equal((await uninstallPlugin({ ...ws, dir, expectedInstall })).removed, true);
    await assert.rejects(uninstallPlugin({ ...ws, dir, expectedInstall }), /ERR_UNINSTALL_TARGET_CHANGED/);
    assert.equal(existsSync(join(ws.pluginsDir, dir)), false);
    assert.equal(readFileSync(notes, 'utf8'), 'user notes');
    assert.ok(existsSync(pending));
    mkdirSync(join(ws.pluginsDir, dir));
    const draft = join(ws.pluginsDir, dir, 'draft.txt');
    writeFileSync(draft, 'unrelated');
    assert.equal((await uninstallPlugin({ ...ws, dir })).removed, true);
    assert.equal(existsSync(join(parkedParent, dir)), false);
    assert.equal(readFileSync(draft, 'utf8'), 'unrelated');
    assert.equal(existsSync(pending), false);
    await assert.rejects(uninstallPlugin({ ...ws, dir }), /ERR_UNINSTALL_TARGET_CHANGED/);
    assert.equal(readFileSync(draft, 'utf8'), 'unrelated');
  } finally { ws.cleanup(); }
});
test('legacy managed updates require the same repository and plugin root', async t => {
  const id = 'team__reader';
  const repo = 'https://github.com/first/reader';
  const entry = { id, canonicalName: 'reader', version: '2.0.0', repository: { repositoryId: 17, url: repo, pluginRoot: '.' } };
  let catalogEntry = entry;
  const { ws, post } = await openUpdateFixture(t, async () => Response.json({ plugins: [catalogEntry] }));
  const plan = (receipt, repository, manifestRepo = repo) => {
    installFakeLocalPlugin(ws.pluginsDir, { dir: 'reader', manifest: { name: 'reader', version: '1.0.0', repository: manifestRepo },
      receipt: { id, installedVersion: '1.0.0', ...receipt } });
    const inventory = scanLocalPluginInventory({ ...ws, bypassCache: true });
    return resolveInstallPreflight({ ...entry, repository }, inventory, { preferredDir: 'reader', requireExistingDir: true }).action;
  };
  const other = { ...entry.repository, url: 'https://github.com/other/reader' };
  assert.throws(() => plan({ repositoryUrl: repo }, other), /ERR_UPDATE_TARGET_MISMATCH/);
  assert.throws(() => plan({}, other), /ERR_UPDATE_TARGET_MISMATCH/);
  assert.throws(() => plan({ repositoryId: 17, repositoryUrl: repo }, { ...other, repositoryId: 0 }), /ERR_UPDATE_TARGET_MISMATCH/);
  assert.throws(() => plan({ repositoryUrl: repo }, { ...entry.repository, pluginRoot: 'plugins/other' }), /ERR_UPDATE_TARGET_MISMATCH/);
  assert.equal(plan({ repositoryUrl: repo + '.git' }, entry.repository, other.url), 'update');
  assert.equal(plan({}, entry.repository), 'update');
  assert.equal(plan({ repositoryId: 17 }, other), 'update');
  assert.equal(plan({ pluginRoot: './plugins/reader/' }, { ...entry.repository, pluginRoot: 'plugins/reader' }), 'update');
  assert.throws(() => plan({}, { ...entry.repository, pluginRoot: '.' },
    { url: repo, directory: 'plugins/reader' }), /ERR_UPDATE_TARGET_MISMATCH/);
  const pkg = join(ws.pluginsDir, 'reader', 'package.json');
  writeFileSync(pkg, JSON.stringify({ repository: { url: repo, directory: 'plugins/reader' } }));
  assert.throws(() => plan({ repositoryUrl: repo }, entry.repository), /ERR_UPDATE_TARGET_MISMATCH/);
  assert.equal(plan({ repositoryUrl: repo }, { ...entry.repository, pluginRoot: 'plugins/reader' }), 'update');
  const [legacy] = scanLocalPluginInventory({ ...ws, bypassCache: true }).installed;
  const oldKey = createHash('sha256').update(JSON.stringify(['global', 'reader', 'reader', repo, '', id])).digest('hex');
  assert.equal(legacy.favoriteKey, 'copy:' + oldKey);
  rmSync(pkg);
  assert.throws(() => plan({}, entry.repository, ''), /ERR_UPDATE_TARGET_MISMATCH/);
  const artifact = buildTarArtifact(ws.artifactsDir, 'reader.tgz', {
    'plugin.json': JSON.stringify({ name: 'reader', version: '2.0.0', repository: repo }),
  });
  const distribution = { tarballUrl: artifact.url, sha256: artifact.sha256 };
  installFakeLocalPlugin(ws.pluginsDir, { dir: 'reader', manifest: { name: 'reader', version: '1.0.0', repository: repo },
    receipt: { id, repositoryUrl: repo, installedVersion: '1.0.0' } });
  catalogEntry = { ...entry, repository: other, distribution };
  const blocked = await post('/api/update', { id, dir: 'reader' });
  assert.match(blocked.error, /ERR_UPDATE_TARGET_MISMATCH/);
  const manifestPath = join(ws.pluginsDir, 'reader', 'plugin.json');
  assert.equal(JSON.parse(readFileSync(manifestPath)).version, '1.0.0');
  catalogEntry = { ...entry, distribution };
  await post('/api/catalog/refresh', {});
  const updated = await post('/api/update', { id, dir: 'reader' });
  assert.equal(updated.ok, true, updated.error);
  assert.equal(JSON.parse(readFileSync(manifestPath)).version, '2.0.0');
});

test('independent market sessions preserve each other\'s favorite and preference edits', async t => {
  const fetchImpl = async () => Response.json({ plugins: [] });
  const { ws, post } = await openUpdateFixture(t, fetchImpl);
  const second = await createMarketSidecarServer({ ...ws, listen: false, recoveryDelayMs: -1, fetchImpl });
  t.after(() => second.close());
  const other = async (url, body) => (await second.inject({ method: 'POST', url, body,
    headers: { 'X-Sidecar-Token': second.sideToken } })).json();
  const disk = () => JSON.parse(readFileSync(join(ws.dataDir, 'prefs.json'), 'utf8'));
  await post('/api/favorites', { key: 'one', favorite: true });
  await other('/api/prefs', { locale: 'en' });
  assert.deepEqual(disk().favorites, ['one']);
  await other('/api/favorites', { key: 'two', favorite: true });
  await post('/api/favorites', { key: 'one', favorite: false });
  assert.deepEqual(disk().favorites, ['two']);
  assert.equal(disk().locale, 'en');
  await other('/api/conflicts/ignore', { id: 'test-conflict', ignored: true });
  assert.deepEqual(disk().favorites, ['two']);
  assert.deepEqual(disk().ignoredConflictIds, ['test-conflict']);

  const id = 'team__reader';
  const repositoryUrl = 'https://github.com/team/reader';
  installFakeLocalPlugin(ws.pluginsDir, { dir: 'reader',
    manifest: { name: 'reader', version: '1.0.0', repository: repositoryUrl },
    receipt: { id, installedVersion: '1.0.0', repositoryUrl, pluginRoot: '.' } });
  await post('/api/favorites', { key: id, favorite: true });
  assert.ok(disk().favorites.includes(id));
  execFileSync(process.execPath, [join(REPO_ROOT, 'bin/agy-market.mjs'), 'uninstall', 'reader', '--yes', '--remove-favorite'], {
    env: { ...process.env, ANTIGRAVITY_CONFIG_DIR: ws.configDir, AGY_MARKET_DATA_DIR: ws.dataDir }, windowsHide: true,
  });
  assert.deepEqual(disk().favorites, ['two']);
  await post('/api/prefs', { locale: 'zh' });
  assert.deepEqual(disk().favorites, ['two']);
});

test('concurrent Sidecar processes commit all favorite additions on the same disk', async t => {
  const ws = makeTempWorkspace();
  t.after(ws.cleanup);
  const worker = `
    import { createMarketSidecarServer } from './src/sidecar/server.mjs';
    const [configDir, dataDir, prefix] = process.argv.slice(1);
    const server = await createMarketSidecarServer({ configDir, dataDir, listen: false, recoveryDelayMs: -1 });
    try {
      for (let i = 0; i < 8; i++) {
        const result = await server.inject({ method: 'POST', url: '/api/favorites',
          headers: { 'X-Sidecar-Token': server.sideToken }, body: { key: prefix + i, favorite: true } });
        if (result.statusCode !== 200) throw Error(result.body);
      }
    } finally { await server.close(); }
  `;
  const run = promisify(execFile);
  const writers = ['alpha', 'beta', 'gamma', 'delta'];
  await Promise.all(writers.map(prefix => run(process.execPath,
    ['--input-type=module', '-e', worker, ws.configDir, ws.dataDir, prefix], { cwd: REPO_ROOT, windowsHide: true })));
  const saved = JSON.parse(readFileSync(join(ws.dataDir, 'prefs.json'), 'utf8'));
  assert.deepEqual(saved.favorites.sort(), writers.flatMap(name => Array.from({ length: 8 }, (_, i) => name + i)).sort());
});
