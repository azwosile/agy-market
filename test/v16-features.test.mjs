import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';
import { gzipSync } from 'node:zlib';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

const { bundleZeroDepEsm } = await import(pathToFileURL(join(REPO_ROOT, 'scripts', 'build.mjs')).href);
const { PLUGIN_VERSION } = await import(pathToFileURL(join(REPO_ROOT, 'src', 'shared', 'constants.mjs')).href);
const {
  computeMonorepoDampeningFactor,
  sortCatalogPlugins,
  sortPluginsRecommendedWithDampening,
} = await import(pathToFileURL(join(REPO_ROOT, 'src', 'shared', 'ranking.mjs')).href);
const {
  assertNoScopedSymlinks,
  createDeterministicTarGz,
  encodePaxRecord,
  extractTarGzToDir,
  parseTarGzWithMeta,
} = await import(pathToFileURL(join(REPO_ROOT, 'src', 'installer', 'tar-extract.mjs')).href);
const { fetchVerifiedPluginTarball } = await import(
  pathToFileURL(join(REPO_ROOT, 'src', 'installer', 'fetch-tarball.mjs')).href
);
const {
  buildPluginNominationUrl,
  inspectGithubPluginUrl,
  installGithubPlugin,
  probeIsPublicGithubRepo,
} = await import(pathToFileURL(join(REPO_ROOT, 'src', 'installer', 'github-url.mjs')).href);
const { fetchPluginReadme } = await import(pathToFileURL(join(REPO_ROOT, 'src', 'registry', 'index.mjs')).href);
const { createMarketSidecarServer } = await import(pathToFileURL(join(REPO_ROOT, 'src', 'sidecar', 'server.mjs')).href);

const CLEAN_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><rect x="16" y="16" width="96" height="96" rx="20" fill="#6366f1"/></svg>';
const COMMIT_SHA = '4f5e6d7c8b9a0123456789abcdef0123456789ab';

function makeTempWorkspace(prefix = 'agy-v16-test-') {
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

function buildTarGzWithSymlinks(filesObj, { topDir = 'repo-main', commitSha = '', links = [] } = {}) {
  const chunks = [];
  const makeHeader = (name, size, typeFlag = '0', linkName = '') => {
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
  };
  const pushPadded = (buf) => {
    chunks.push(buf);
    const rem = buf.length % 512;
    if (rem !== 0) chunks.push(Buffer.alloc(512 - rem, 0));
  };

  if (commitSha) {
    const paxPayload = encodePaxRecord('comment', commitSha);
    chunks.push(makeHeader('pax_global_header', paxPayload.length, 'g'));
    pushPadded(paxPayload);
  }

  for (const [rel, val] of Object.entries(filesObj)) {
    const fullName = topDir ? `${topDir}/${rel}` : rel;
    const buf = Buffer.isBuffer(val) ? val : Buffer.from(String(val), 'utf8');
    chunks.push(makeHeader(fullName, buf.length, '0'));
    pushPadded(buf);
  }

  for (const lk of links) {
    const fullName = topDir ? `${topDir}/${lk.name}` : lk.name;
    chunks.push(makeHeader(fullName, 0, lk.type || '2', lk.target || ''));
  }

  chunks.push(Buffer.alloc(1024, 0));
  return gzipSync(Buffer.concat(chunks), { level: 6 });
}

function jsonResp(obj, status = 200, headers = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

function binResp(buf, status = 200) {
  return new Response(buf, {
    status,
    headers: { 'Content-Type': 'application/gzip' },
  });
}

// ============================================================================
// 1. Scoped Symlink Support & Security Invariants
// ============================================================================

test('v1.6.0 scoped symlinks: outside-pluginRoot allowed & skipped; inside/traversing/ancestor/root symlinks HARD-REJECTED', async () => {
  const ws = makeTempWorkspace('agy-v16-symlinks-');
  try {
    const baseSubdirFiles = {
      'README.md': '# Dual-Host Repo\n',
      'docs/guide.md': '# Guide\n',
      'plugins/my-plug/plugin.json': JSON.stringify({
        name: 'my-plug',
        displayName: 'My Plug',
        version: '1.0.0',
        description: 'Subdir plugin in dual-host repo',
        logo: 'assets/logo.svg',
      }),
      'plugins/my-plug/assets/logo.svg': CLEAN_SVG,
      'plugins/my-plug/skills/demo/SKILL.md': '---\nname: demo\ndescription: d\n---\n# Demo\n',
    };

    // (a) Outside-pluginRoot symlinks (.claude/ and docs/) ALLOWED when scoped to plugins/my-plug
    const outsideSymTar = buildTarGzWithSymlinks(baseSubdirFiles, {
      topDir: 'dual-host-1.0.0',
      commitSha: COMMIT_SHA,
      links: [
        { name: '.claude/commands/guide.md', target: '../../docs/guide.md', type: '2' },
        { name: 'docs/readme-link.md', target: '../README.md', type: '2' },
        { name: 'plugins/other/alias.md', target: '../../docs/guide.md', type: '2' },
      ],
    });

    // Unscoped / root parse STILL hard-rejects any symlink!
    assert.throws(
      () => parseTarGzWithMeta(outsideSymTar, { stripSingleTopDir: true, pluginRoot: '.' }),
      /ERR_TAR_SYMLINK_FORBIDDEN/,
    );
    assert.throws(
      () => parseTarGzWithMeta(outsideSymTar, { stripSingleTopDir: true }),
      /ERR_TAR_SYMLINK_FORBIDDEN/,
    );

    // Scoped to plugins/my-plug -> SUCCEEDS and skips outside symlinks completely!
    const parsedScoped = parseTarGzWithMeta(outsideSymTar, {
      stripSingleTopDir: true,
      pluginRoot: 'plugins/my-plug',
    });
    assert.equal(parsedScoped.files.has('plugins/my-plug/plugin.json'), true);
    assert.equal(parsedScoped.files.has('.claude/commands/guide.md'), false);
    assert.equal(parsedScoped.symlinks.length, 3);

    const outDir = join(ws.artifactsDir, 'extracted-ok');
    const extRes = extractTarGzToDir(outsideSymTar, outDir, { pluginRoot: 'plugins/my-plug' });
    assert.equal(extRes.writtenCount, 3);
    assert.equal(existsSync(join(outDir, 'plugin.json')), true);
    assert.equal(existsSync(join(outDir, 'skills', 'demo', 'SKILL.md')), true);
    assert.equal(existsSync(join(outDir, '.claude')), false);

    // Commit-fallback PAX check in fetchVerifiedPluginTarball also honors scoped pluginRoot
    const expectedOldSha = createHash('sha256').update(Buffer.from('drifted-tag-bytes')).digest('hex');
    const fallbackOut = await fetchVerifiedPluginTarball({
      plugin: {
        id: 'alice__dual-host--plugins-my-plug',
        version: '1.0.0',
        commitSha: COMMIT_SHA,
        repository: { pluginRoot: 'plugins/my-plug' },
        distribution: {
          tarballUrl: 'https://github.com/alice/dual-host/archive/refs/tags/v1.0.0.tar.gz',
          sha256: expectedOldSha,
        },
      },
      stagingDir: join(ws.artifactsDir, 'stage-fb'),
      stagingArchivePath: join(ws.artifactsDir, 'stage-fb', 'archive.tar.gz'),
      fetchImpl: async (url) => {
        const u = String(url);
        if (u.includes('/archive/refs/tags/')) return new Response('Not Found', { status: 404 });
        if (u.includes(`/archive/${COMMIT_SHA}.tar.gz`)) return binResp(outsideSymTar);
        return new Response('Not Found', { status: 404 });
      },
    });
    assert.equal(fallbackOut.channelUsed, 'github-commit-fallback');

    // (b) Inside-pluginRoot symlink HARD-REJECTED
    const insideSymTar = buildTarGzWithSymlinks(baseSubdirFiles, {
      topDir: 'dual-host-1.0.0',
      links: [{ name: 'plugins/my-plug/skills/evil-link', target: '../../../docs/guide.md', type: '2' }],
    });
    assert.throws(
      () => extractTarGzToDir(insideSymTar, join(ws.artifactsDir, 'bad-inside'), { pluginRoot: 'plugins/my-plug' }),
      /ERR_TAR_SYMLINK_FORBIDDEN/,
    );

    // (c) Symlink OUTSIDE pluginRoot whose target traverses INTO pluginRoot HARD-REJECTED
    const traverseIntoTar = buildTarGzWithSymlinks(baseSubdirFiles, {
      topDir: 'dual-host-1.0.0',
      links: [{ name: '.claude/skills/link.md', target: '../../plugins/my-plug/skills/demo/SKILL.md', type: '2' }],
    });
    assert.throws(
      () => extractTarGzToDir(traverseIntoTar, join(ws.artifactsDir, 'bad-traverse'), { pluginRoot: 'plugins/my-plug' }),
      /ERR_TAR_SYMLINK_FORBIDDEN/,
    );

    // (d) Symlink bouncing through pluginRoot and back out HARD-REJECTED
    const bounceThroughTar = buildTarGzWithSymlinks(baseSubdirFiles, {
      topDir: 'dual-host-1.0.0',
      links: [{ name: 'docs/bounce.md', target: '../plugins/my-plug/../README.md', type: '2' }],
    });
    assert.throws(
      () => extractTarGzToDir(bounceThroughTar, join(ws.artifactsDir, 'bad-bounce'), { pluginRoot: 'plugins/my-plug' }),
      /ERR_TAR_SYMLINK_FORBIDDEN/,
    );

    // (e) Hardlink targeting inside pluginRoot (with strippedTopDir prefix) HARD-REJECTED
    const hardlinkIntoTar = buildTarGzWithSymlinks(baseSubdirFiles, {
      topDir: 'dual-host-1.0.0',
      links: [{ name: 'docs/hard.json', target: 'dual-host-1.0.0/plugins/my-plug/plugin.json', type: '1' }],
    });
    assert.throws(
      () => extractTarGzToDir(hardlinkIntoTar, join(ws.artifactsDir, 'bad-hardlink'), { pluginRoot: 'plugins/my-plug' }),
      /ERR_TAR_SYMLINK_FORBIDDEN/,
    );

    // (f) Ancestor symlink enclosing pluginRoot (`plugins` itself is a symlink) HARD-REJECTED
    assert.throws(
      () =>
        assertNoScopedSymlinks(
          [{ path: 'plugins', linkTarget: 'real-plugins', typeFlag: '2' }],
          'plugins/my-plug',
          '',
        ),
      /ERR_TAR_SYMLINK_FORBIDDEN/,
    );

    // (g) Root-plugin (`pluginRoot === '.'`) symlink ANYWHERE in archive HARD-REJECTED
    const rootWithOutsideSymTar = buildTarGzWithSymlinks(
      {
        'plugin.json': JSON.stringify({ name: 'root-plug', version: '1.0.0', description: 'Root plugin' }),
        'docs/guide.md': '# Guide',
      },
      {
        topDir: 'root-plug-1.0.0',
        links: [{ name: '.claude/guide.md', target: '../docs/guide.md', type: '2' }],
      },
    );
    assert.throws(
      () => extractTarGzToDir(rootWithOutsideSymTar, join(ws.artifactsDir, 'bad-root'), { pluginRoot: '.' }),
      /ERR_TAR_SYMLINK_FORBIDDEN/,
    );

    // (h) Full github-url inspect + install succeeds for dual-host subdir repo, blocks inside-subdir & root-plugin symlinks
    const mockFetch = async (url, init = {}) => {
      const u = String(url);
      if (init?.method === 'HEAD' && u === 'https://github.com/alice/dual-host') {
        return new Response(null, { status: 200 });
      }
      if (u === 'https://api.github.com/repos/alice/dual-host') {
        return jsonResp({ id: 90101, full_name: 'alice/dual-host', default_branch: 'main' });
      }
      if (u === 'https://api.github.com/repos/alice/bad-inside') {
        return jsonResp({ id: 90102, full_name: 'alice/bad-inside', default_branch: 'main' });
      }
      if (u === 'https://api.github.com/repos/alice/bad-root') {
        return jsonResp({ id: 90103, full_name: 'alice/bad-root', default_branch: 'main' });
      }
      if (u.includes('/releases/')) return new Response('', { status: 404 });
      if (u.includes('/tags')) return jsonResp([]);
      if (u.includes('alice/dual-host')) return binResp(outsideSymTar);
      if (u.includes('alice/bad-inside')) return binResp(insideSymTar);
      if (u.includes('alice/bad-root')) return binResp(rootWithOutsideSymTar);
      return new Response('Not Found', { status: 404 });
    };

    const okInspect = await inspectGithubPluginUrl({
      url: 'https://github.com/alice/dual-host',
      configDir: ws.configDir,
      dataDir: ws.dataDir,
      fetchImpl: mockFetch,
    });
    assert.equal(okInspect.status, 'READY');
    assert.equal(okInspect.plugin.pluginRoot, 'plugins/my-plug');

    const okInstall = await installGithubPlugin({
      inspectToken: okInspect.inspectToken,
      url: 'https://github.com/alice/dual-host',
      pluginRoot: 'plugins/my-plug',
      installMode: 'native',
      configDir: ws.configDir,
      dataDir: ws.dataDir,
      fetchImpl: mockFetch,
    });
    assert.equal(okInstall.ok, true);
    assert.equal(okInstall.status, 'INSTALLED');
    assert.equal(existsSync(join(ws.pluginsDir, 'my-plug', 'plugin.json')), true);

    const blockedInside = await inspectGithubPluginUrl({
      url: 'https://github.com/alice/bad-inside',
      configDir: ws.configDir,
      dataDir: ws.dataDir,
      fetchImpl: mockFetch,
    });
    assert.equal(blockedInside.status, 'SECURITY_BLOCKED');
    assert.equal(blockedInside.reasonCode, 'ERR_TAR_SYMLINK_FORBIDDEN');

    const blockedRoot = await inspectGithubPluginUrl({
      url: 'https://github.com/alice/bad-root',
      configDir: ws.configDir,
      dataDir: ws.dataDir,
      fetchImpl: mockFetch,
    });
    assert.equal(blockedRoot.status, 'SECURITY_BLOCKED');
    assert.equal(blockedRoot.reasonCode, 'ERR_TAR_SYMLINK_FORBIDDEN');
  } finally {
    ws.cleanup();
  }
});

// ============================================================================
// 2. Lazy Per-Plugin README Loading (`dist/readmes/<id>.json`) + Seamless Fallback
// ============================================================================

test('v1.6.0 lazy README: per-plugin ETag 304 cache, GET /api/plugin/:id/readme, monolithic fallback & npm mirror fallback', async () => {
  const ws = makeTempWorkspace('agy-v16-readmes-');
  try {
    let perPluginCalls = 0;
    let monolithicCalls = 0;
    let sawIfNoneMatch = false;

    const lazyFetch = async (url, init = {}) => {
      const u = String(url);
      if (u.endsWith('/index.json')) {
        return jsonResp({ schemaVersion: 1, track: 'verified', plugins: [] });
      }
      if (u.endsWith('/readmes/alice__lazy-plug.json')) {
        perPluginCalls += 1;
        if (init?.headers?.['If-None-Match'] === '"readme-etag-1"') {
          sawIfNoneMatch = true;
          return new Response(null, { status: 304 });
        }
        return jsonResp(
          {
            id: 'alice__lazy-plug',
            default: '# Lazy Plug\nDefault English docs.',
            zh: '# 懒加载插件\n单文件按需加载中文文档。',
            en: '# Lazy Plug (EN)\nPer-plugin lazy English docs.',
          },
          200,
          { etag: '"readme-etag-1"' },
        );
      }
      if (u.endsWith('/readmes/bob__legacy-plug.json')) {
        return new Response('Not Found', { status: 404 });
      }
      if (u.endsWith('/readmes.json')) {
        monolithicCalls += 1;
        return jsonResp({
          schemaVersion: 1,
          entries: { 'bob__legacy-plug': '# Legacy Fallback\nServed from monolithic readmes.json.' },
          entriesZh: { 'bob__legacy-plug': '# 传统回退文档\n来自 monolithic readmes.json。' },
          entriesEn: {},
        });
      }
      return new Response('Not Found', { status: 404 });
    };

    const srv = await createMarketSidecarServer({
      listen: false,
      configDir: ws.configDir,
      dataDir: ws.dataDir,
      recoveryDelayMs: -1,
      fetchImpl: lazyFetch,
    });

    try {
      // 1. First request to GET /api/plugin/:id/readme fetches per-plugin JSON & writes cache/readmes/<id>.json
      const r1 = await srv.inject({
        method: 'GET',
        url: '/api/plugin/alice__lazy-plug/readme?locale=zh',
      });
      assert.equal(r1.statusCode, 200);
      const j1 = r1.json();
      assert.equal(j1.ok, true);
      assert.equal(j1.isTranslatedOrNativeZh, true);
      assert.match(j1.markdown, /单文件按需加载中文文档/);
      assert.equal(monolithicCalls, 0, 'Lazy per-plugin hit MUST NOT fetch monolithic readmes.json');
      assert.equal(existsSync(join(ws.dataDir, 'cache', 'readmes', 'alice__lazy-plug.json')), true);
      assert.equal(existsSync(join(ws.dataDir, 'cache', 'readmes', 'alice__lazy-plug.meta.json')), true);

      // 2. Second request to GET /api/readme sends If-None-Match & serves 304 cached English variant
      const r2 = await srv.inject({
        method: 'GET',
        url: '/api/readme?id=alice__lazy-plug&locale=en',
      });
      assert.equal(r2.statusCode, 200);
      const j2 = r2.json();
      assert.equal(j2.ok, true);
      assert.equal(sawIfNoneMatch, true, 'Per-plugin ETag If-None-Match must be sent on subsequent requests');
      assert.match(j2.markdown, /Per-plugin lazy English docs/);
      assert.equal(perPluginCalls, 2);
      assert.equal(monolithicCalls, 0);

      // 3. When per-plugin endpoint 404s, seamlessly falls back to monolithic readmes.json
      const rLegacy = await srv.inject({
        method: 'GET',
        url: '/api/readme?id=bob__legacy-plug&locale=zh',
      });
      assert.equal(rLegacy.statusCode, 200);
      assert.match(rLegacy.json().markdown, /来自 monolithic readmes\.json/);
      assert.ok(monolithicCalls >= 1);
    } finally {
      await srv.close();
    }

    // 4. Primary unreachable -> China npm mirror fallback (per-plugin entry inside @agy-market/catalog tarball)
    const wsMirror = makeTempWorkspace('agy-v16-readme-mirror-');
    try {
      const mirrorTgz = createDeterministicTarGz({
        'package/dist/index.json': JSON.stringify({ schemaVersion: 1, track: 'verified', plugins: [] }),
        'package/dist/unverified-index.json': JSON.stringify({ schemaVersion: 1, track: 'unverified', plugins: [] }),
        'package/dist/readmes.json': JSON.stringify({ schemaVersion: 1, entries: {}, entriesZh: {}, entriesEn: {} }),
        'package/dist/readmes/carol__mirror-plug.json': JSON.stringify({
          id: 'carol__mirror-plug',
          default: '# Mirror Default',
          zh: '# 镜像兜底中文文档',
          en: '# Mirror Fallback EN',
        }),
      });
      const tgzPath = join(wsMirror.artifactsDir, 'catalog.tgz');
      writeFileSync(tgzPath, mirrorTgz);

      const res = await fetchPluginReadme({
        id: 'carol__mirror-plug',
        dataDir: wsMirror.dataDir,
        fetchImpl: async (url) => {
          const u = String(url);
          if (u.includes('github.io') || u.includes('raw.githubusercontent.com')) {
            throw new Error('ConnectTimeoutError');
          }
          if (u.includes('registry.npmmirror.com')) {
            return jsonResp({
              name: '@agy-market/catalog',
              version: '2026.1125.1',
              dist: { tarball: pathToFileURL(tgzPath).href },
            });
          }
          return new Response('Not Found', { status: 404 });
        },
      });
      assert.equal(res.ok, true);
      assert.match(res.zh, /镜像兜底中文文档/);
      assert.match(res.channel, /npm-mirror/);
      assert.equal(existsSync(join(wsMirror.dataDir, 'cache', 'readmes', 'carol__mirror-plug.json')), true);

      // 5. Completely offline -> serves persisted per-plugin disk cache
      const offline = await fetchPluginReadme({
        id: 'carol__mirror-plug',
        dataDir: wsMirror.dataDir,
        prefs: { networkMode: 'direct' },
        fetchImpl: async () => {
          throw new Error('Offline');
        },
      });
      assert.equal(offline.ok, true);
      assert.equal(offline.fromCache, true);
      assert.match(offline.zh, /镜像兜底中文文档/);
    } finally {
      wsMirror.cleanup();
    }
  } finally {
    ws.cleanup();
  }
});

// ============================================================================
// 3. Default "Recommended / 综合推荐" Sort + Monorepo Viewport Slot Dampening
// ============================================================================

test('v1.6.0 ranking: Recommended default sort, stars fallback, Monorepo 1/(1+0.15*(k-1)) dampening, and UI pills', () => {
  // Exact dampening formula check
  assert.equal(computeMonorepoDampeningFactor(1), 1);
  assert.ok(Math.abs(computeMonorepoDampeningFactor(2) - 1 / 1.15) < 1e-12);
  assert.ok(Math.abs(computeMonorepoDampeningFactor(3) - 1 / 1.3) < 1e-12);
  assert.ok(Math.abs(computeMonorepoDampeningFactor(4) - 1 / 1.45) < 1e-12);

  // Monorepo (repoId=9001) has 4 entries with score 80; single repos have 75, 65, 60
  // Dampened scores: M1=80, A=75, M2=69.57, B=65, M3=61.54, C=60, M4=55.17
  const mixedRepoPlugins = [
    { id: 'm__1', displayName: 'Mono 1', repository: { repositoryId: 9001, stars: 500 }, ranking: { score: 80 } },
    { id: 'm__2', displayName: 'Mono 2', repository: { repositoryId: 9001, stars: 500 }, ranking: { score: 80 } },
    { id: 'm__3', displayName: 'Mono 3', repository: { repositoryId: 9001, stars: 500 }, ranking: { score: 80 } },
    { id: 'm__4', displayName: 'Mono 4', repository: { repositoryId: 9001, stars: 500 }, ranking: { score: 80 } },
    { id: 's__a', displayName: 'Solo A', repository: { repositoryId: 1001, stars: 80 }, ranking: { score: 75 } },
    { id: 's__b', displayName: 'Solo B', repository: { repositoryId: 1002, stars: 40 }, ranking: { score: 65 } },
    { id: 's__c', displayName: 'Solo C', repository: { repositoryId: 1003, stars: 20 }, ranking: { score: 60 } },
  ];
  const recommendedOrder = sortCatalogPlugins(mixedRepoPlugins, { sortBy: 'recommended' }).map((p) => p.id);
  assert.deepEqual(recommendedOrder, ['m__1', 's__a', 'm__2', 's__b', 'm__3', 's__c', 'm__4']);

  // Legacy/custom catalog without ranking.score -> graceful fallback to stars + dampening
  const unrankedPlugins = [
    { id: 'c__1', displayName: 'Custom Low', repository: { repositoryId: 0, stars: 10 }, updatedAt: '2026-11-20T00:00:00Z' },
    { id: 'c__2', displayName: 'Custom High', repository: { repositoryId: 0, stars: 200 }, updatedAt: '2026-11-22T00:00:00Z' },
    { id: 'c__3', displayName: 'Custom Mid', repository: { repositoryId: 0, stars: 50 }, updatedAt: '2026-11-24T00:00:00Z' },
  ];
  // Entries with repositoryId: 0 must NOT be grouped as one monorepo
  assert.deepEqual(
    sortPluginsRecommendedWithDampening(unrankedPlugins).map((p) => p.id),
    ['c__2', 'c__3', 'c__1'],
  );

  // Other sort options (`stars`, `updated`, `name`) remain intact
  assert.deepEqual(
    sortCatalogPlugins(unrankedPlugins, { sortBy: 'stars' }).map((p) => p.id),
    ['c__2', 'c__3', 'c__1'],
  );
  assert.deepEqual(
    sortCatalogPlugins(unrankedPlugins, { sortBy: 'updated' }).map((p) => p.id),
    ['c__3', 'c__2', 'c__1'],
  );
  assert.deepEqual(
    sortCatalogPlugins(unrankedPlugins, { sortBy: 'name', locale: 'en' }).map((p) => p.id),
    ['c__2', 'c__1', 'c__3'],
  );

  // Verify bundled UI defaults to `recommended` and renders optional STALE / ARCHIVED / Compat pills cleanly
  const bundled = bundleZeroDepEsm(join(REPO_ROOT, 'src', 'ui', 'app.mjs'));
  const bootMarker = 'void loadState(false);\nvoid checkUpdates(false, { silent: true });';
  const instrumented = bundled.replace(
    bootMarker,
    'globalThis.__V16_UI__ = { state, getFilteredPlugins, renderDiscoverView, renderPluginCard, renderGithubUrlModal, renderNominationBanner };',
  );
  const sandbox = {
    window: {
      localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
      addEventListener: () => {},
      location: { search: '', origin: 'http://127.0.0.1:43210' },
      matchMedia: () => ({ matches: false }),
      __SIDECAR_BOOT__: { token: 't' },
      fetch: async () => jsonResp({ ok: true }),
    },
    document: { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [] },
    URL,
    URLSearchParams,
    Headers,
    Response,
    console,
    setTimeout: () => 1,
    clearTimeout: () => {},
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(instrumented, sandbox);

  const ui = sandbox.__V16_UI__;
  assert.equal(ui.state.sortBy, 'recommended');
  ui.state.serverState = {
    plugin: { version: PLUGIN_VERSION },
    prefs: { locale: 'zh', enableExperimentalTrack2: false, favorites: [] },
    catalog: {
      plugins: [
        {
          ...mixedRepoPlugins[0],
          canonicalName: 'mono-1',
          version: '1.0.0',
          capabilities: { badges: ['declarative-only'] },
          ranking: { score: 80, stale: true, compatTier: 'compatible' },
        },
        {
          ...mixedRepoPlugins[4],
          canonicalName: 'solo-a',
          version: '1.0.0',
          capabilities: { badges: ['declarative-only'] },
          ranking: { score: 75, archived: true },
        },
      ],
    },
    installed: [],
    updatesAvailable: [],
    conflictsSummary: { total: 0, critical: 0, warning: 0, info: 0, healthyCount: 0 },
  };

  const discoverHtml = ui.renderDiscoverView();
  assert.match(discoverHtml, /<option value="recommended" selected>综合推荐<\/option>/);
  assert.match(discoverHtml, /meta-status-pill is-stale/);
  assert.match(discoverHtml, /meta-status-pill is-compat/);
  assert.match(discoverHtml, /meta-status-pill is-archived/);

  // Top-level p.status ('ARCHIVED' / 'STALE_WARNING') and r.status ('STALE_WARNING') must also render pills
  const topArchivedCard = ui.renderPluginCard({
    id: 'top__archived',
    canonicalName: 'top-archived',
    displayName: 'Top Archived',
    version: '1.0.0',
    status: 'ARCHIVED',
    capabilities: { badges: ['declarative-only'] },
    ranking: { score: 40 },
  });
  assert.match(topArchivedCard, /meta-status-pill is-archived/);
  assert.doesNotMatch(topArchivedCard, /meta-status-pill is-stale/);

  const topStaleCard = ui.renderPluginCard({
    id: 'top__stale',
    canonicalName: 'top-stale',
    displayName: 'Top Stale',
    version: '1.0.0',
    status: 'STALE_WARNING',
    capabilities: { badges: ['declarative-only'] },
    ranking: { score: 55 },
  });
  assert.match(topStaleCard, /meta-status-pill is-stale/);

  const rankingStaleStatusCard = ui.renderPluginCard({
    id: 'rank__stale',
    canonicalName: 'rank-stale',
    displayName: 'Rank Stale',
    version: '1.0.0',
    capabilities: { badges: ['declarative-only'] },
    ranking: { score: 50, status: 'STALE_WARNING' },
  });
  assert.match(rankingStaleStatusCard, /meta-status-pill is-stale/);
});

// ============================================================================
// 4. Tier-0 Opt-In Public-Repo Nomination Hook (Zero PII)
// ============================================================================

test('v1.6.0 nomination hook: exact zero-PII URL contract, public HEAD probe (no auth!), private/listed suppression & UI banner', async () => {
  // 1. Direct URL contract verification (strictly 5 query params, zero PII)
  const issueUrl = buildPluginNominationUrl({
    owner: 'acme-dev',
    repo: 'cool-plugin',
    pluginRoot: 'plugins/cool',
  });
  const parsed = new URL(issueUrl);
  assert.equal(parsed.origin + parsed.pathname, 'https://github.com/azwosile/agy-market-catalog/issues/new');
  assert.deepEqual([...parsed.searchParams.keys()].sort(), [
    'labels',
    'plugin_root',
    'repo',
    'template',
    'title',
  ]);
  assert.equal(parsed.searchParams.get('template'), 'nominate-plugin.yml');
  assert.equal(parsed.searchParams.get('labels'), 'community-discovery');
  assert.equal(parsed.searchParams.get('repo'), 'acme-dev/cool-plugin');
  assert.equal(parsed.searchParams.get('plugin_root'), 'plugins/cool');
  assert.match(parsed.searchParams.get('title'), /acme-dev\/cool-plugin/);

  // 2. Direct probeIsPublicGithubRepo checks (200 -> true; 404/302/error -> false; NEVER sends Authorization)
  const seenHeadHeaders = [];
  const headFetch = async (url, init = {}) => {
    const u = String(url);
    seenHeadHeaders.push({ url: u, method: init.method, redirect: init.redirect, headers: init.headers });
    if (u === 'https://github.com/pub-org/pub-repo') return new Response(null, { status: 200 });
    if (u === 'https://github.com/priv-org/priv-repo') return new Response(null, { status: 404 });
    if (u === 'https://github.com/priv-org/redirect-login') {
      return new Response(null, { status: 302, headers: { location: 'https://github.com/login' } });
    }
    throw new Error('ECONNRESET');
  };
  assert.equal(await probeIsPublicGithubRepo('pub-org', 'pub-repo', { fetchImpl: headFetch }), true);
  assert.equal(await probeIsPublicGithubRepo('priv-org', 'priv-repo', { fetchImpl: headFetch }), false);
  assert.equal(await probeIsPublicGithubRepo('priv-org', 'redirect-login', { fetchImpl: headFetch }), false);
  assert.equal(await probeIsPublicGithubRepo('err-org', 'unreachable', { fetchImpl: headFetch }), false);
  for (const call of seenHeadHeaders) {
    assert.equal(call.method, 'HEAD');
    assert.equal(call.redirect, 'manual');
    assert.equal(new Headers(call.headers).get('authorization'), null, 'Public probe MUST NEVER send Authorization');
  }

  // 3. End-to-end /api/github/inspect & /api/github/install for public unlisted vs private unlisted vs already-listed
  const ws = makeTempWorkspace('agy-v16-nomination-');
  try {
    const plugTar = buildTarGzWithSymlinks(
      {
        'plugin.json': JSON.stringify({
          name: 'nom-plug',
          displayName: 'Nom Plug',
          version: '1.0.0',
          description: 'Nomination test plugin',
        }),
        'skills/nom/SKILL.md': '---\nname: nom\ndescription: d\n---\n# Nom',
      },
      { topDir: 'nom-plug-main', commitSha: COMMIT_SHA },
    );

    const headCalls = [];
    const SECRET_PAT = 'ghp_SUPER_SECRET_USER_TOKEN_12345';

    const mockFetch = async (url, init = {}) => {
      const u = String(url);
      if (init?.method === 'HEAD' && /^https:\/\/github\.com\/[^/]+\/[^/]+$/i.test(u)) {
        headCalls.push({ url: u, auth: new Headers(init?.headers || {}).get('authorization') });
        if (u === 'https://github.com/pub-org/unlisted-plug') return new Response(null, { status: 200 });
        if (u === 'https://github.com/priv-org/secret-plug') return new Response(null, { status: 404 });
        return new Response(null, { status: 200 });
      }
      if (u.endsWith('/index.json')) {
        return jsonResp({
          schemaVersion: 1,
          track: 'verified',
          plugins: [
            {
              id: 'listed-org__already-listed',
              canonicalName: 'nom-plug',
              scopedName: 'listed-org--nom-plug',
              version: '1.0.0',
              repository: { url: 'https://github.com/listed-org/already-listed', pluginRoot: '.' },
            },
          ],
        });
      }
      if (u.endsWith('/unverified-index.json')) return jsonResp({ schemaVersion: 1, plugins: [] });
      if (u.includes('/releases/')) return new Response('', { status: 404 });
      if (u.includes('/tags')) return jsonResp([]);
      if (u.startsWith('https://api.github.com/repos/')) {
        return jsonResp({ id: 55501, full_name: u.split('/repos/')[1], default_branch: 'main' });
      }
      if (u.includes('tar.gz') || u.includes('/archive/')) return binResp(plugTar);
      return new Response('Not Found', { status: 404 });
    };

    const srv = await createMarketSidecarServer({
      listen: false,
      configDir: ws.configDir,
      dataDir: ws.dataDir,
      recoveryDelayMs: -1,
      fetchImpl: mockFetch,
    });

    try {
      const headers = { 'X-Sidecar-Token': srv.sideToken, Origin: 'http://127.0.0.1:43210' };

      // Configure a user PAT in prefs to prove private-repo probe NEVER leaks it
      await srv.inject({
        method: 'POST',
        url: '/api/prefs',
        headers,
        body: { githubToken: SECRET_PAT },
      });

      // (a) Public unlisted repo -> isPublicRepo: true + nomination.issueUrl with zero PII
      const pubInspect = (
        await srv.inject({
          method: 'POST',
          url: '/api/github/inspect',
          headers,
          body: { url: 'https://github.com/pub-org/unlisted-plug' },
        })
      ).json();
      assert.equal(pubInspect.status, 'READY');
      assert.equal(pubInspect.catalogMatch, null);
      assert.equal(pubInspect.isPublicRepo, true);
      assert.equal(pubInspect.nomination?.eligible, true);
      assert.equal(pubInspect.nomination?.repo, 'pub-org/unlisted-plug');
      assert.equal(pubInspect.nomination?.pluginRoot, '.');
      assert.equal(pubInspect.nomination?.issueUrl.includes(SECRET_PAT), false);
      assert.match(pubInspect.nomination?.issueUrl, /template=nominate-plugin\.yml/);

      const pubInstall = (
        await srv.inject({
          method: 'POST',
          url: '/api/github/install',
          headers,
          body: {
            inspectToken: pubInspect.inspectToken,
            url: 'https://github.com/pub-org/unlisted-plug',
            installMode: 'native',
          },
        })
      ).json();
      assert.equal(pubInstall.status, 'INSTALLED');
      assert.equal(pubInstall.isPublicRepo, true);
      assert.equal(pubInstall.nomination?.repo, 'pub-org/unlisted-plug');

      // (b) Private unlisted repo (404 on unauth HEAD) -> isPublicRepo: false, nomination: null!
      const privInspect = (
        await srv.inject({
          method: 'POST',
          url: '/api/github/inspect',
          headers,
          body: { url: 'https://github.com/priv-org/secret-plug' },
        })
      ).json();
      assert.equal(privInspect.status, 'READY');
      assert.equal(privInspect.catalogMatch, null);
      assert.equal(privInspect.isPublicRepo, false);
      assert.equal(privInspect.nomination, null);

      // (c) Already listed in catalog -> catalogMatch !== null, nomination: null, ZERO HEAD probe!
      const headCountBeforeListed = headCalls.length;
      const listedInspect = (
        await srv.inject({
          method: 'POST',
          url: '/api/github/inspect',
          headers,
          body: { url: 'https://github.com/listed-org/already-listed' },
        })
      ).json();
      assert.equal(listedInspect.status, 'READY');
      assert.ok(listedInspect.catalogMatch);
      assert.equal(listedInspect.isPublicRepo, false);
      assert.equal(listedInspect.nomination, null);
      assert.equal(headCalls.length, headCountBeforeListed, 'Listed repos must not run public HEAD probe');

      // Ensure ZERO Authorization headers were ever sent on any HEAD public-repo probe
      assert.ok(headCalls.length >= 2);
      for (const hc of headCalls) {
        assert.equal(hc.auth, null, `HEAD ${hc.url} MUST NEVER send Authorization header`);
      }

      // (d) Verify UI renders nomination banner ONLY for public unlisted inspect/install and suppresses for private
      const bundled = bundleZeroDepEsm(join(REPO_ROOT, 'src', 'ui', 'app.mjs'));
      const bootMarker = 'void loadState(false);\nvoid checkUpdates(false, { silent: true });';
      const instrumented = bundled.replace(
        bootMarker,
        'globalThis.__V16_NOM_UI__ = { state, renderGithubUrlModal, renderNominationBanner };',
      );
      const sandbox = {
        window: {
          localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
          addEventListener: () => {},
          location: { search: '', origin: 'http://127.0.0.1:43210' },
          matchMedia: () => ({ matches: false }),
          __SIDECAR_BOOT__: { token: 't' },
          fetch: async () => jsonResp({ ok: true }),
        },
        document: { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [] },
        URL,
        URLSearchParams,
        Headers,
        Response,
        console,
        setTimeout: () => 1,
        clearTimeout: () => {},
      };
      sandbox.globalThis = sandbox;
      vm.runInNewContext(instrumented, sandbox);
      const ui = sandbox.__V16_NOM_UI__;
      ui.state.serverState = { prefs: { locale: 'zh' }, catalog: { plugins: [] }, installed: [] };

      ui.state.githubUrlModal = {
        phase: 'preview',
        url: 'https://github.com/pub-org/unlisted-plug',
        inspectToken: pubInspect.inspectToken,
        selectedPluginRoot: '.',
        installMode: 'native',
        confirmEscalation: false,
        inspectResult: pubInspect,
        error: '',
      };
      const pubModalHtml = ui.renderGithubUrlModal();
      assert.match(pubModalHtml, /分享此公开插件到 AGY Market？/);
      assert.match(pubModalHtml, /template=nominate-plugin\.yml/);

      ui.state.githubUrlModal.inspectResult = privInspect;
      const privModalHtml = ui.renderGithubUrlModal();
      assert.doesNotMatch(privModalHtml, /分享此公开插件到 AGY Market？/);
      assert.doesNotMatch(privModalHtml, /nominate-plugin\.yml/);
    } finally {
      await srv.close();
    }
  } finally {
    ws.cleanup();
  }
});
