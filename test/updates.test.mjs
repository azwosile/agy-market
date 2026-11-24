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
