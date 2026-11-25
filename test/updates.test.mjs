import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

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
        body: { ids: ['alice__esc-plug'], confirmEscalation: true },
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

      // 2. Concurrent POST /api/update, POST /api/update-all, and POST /api/install must ALL receive HTTP 409 ERR_MUTATION_BUSY
      const [dupUpdate, dupBatch, dupInstall] = await Promise.all([
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
