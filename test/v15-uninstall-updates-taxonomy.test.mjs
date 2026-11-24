import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

const { bundleZeroDepEsm } = await import(pathToFileURL(join(REPO_ROOT, 'scripts', 'build.mjs')).href);

const { CATEGORY_LABELS, PLUGIN_ID, PLUGIN_JSON_ALLOWED_KEYS, PLUGIN_VERSION, scrubChildProcessEnv } = await import(
  pathToFileURL(join(REPO_ROOT, 'src', 'shared', 'constants.mjs')).href
);
const { classifyActivationRequirement } = await import(
  pathToFileURL(join(REPO_ROOT, 'src', 'shared', 'activation.mjs')).href
);
const { createDeterministicTarGz } = await import(
  pathToFileURL(join(REPO_ROOT, 'src', 'installer', 'tar-extract.mjs')).href
);
const { sweepRetiredBinaries } = await import(
  pathToFileURL(join(REPO_ROOT, 'src', 'installer', 'sync-dir.mjs')).href
);
const { createMarketSidecarServer } = await import(
  pathToFileURL(join(REPO_ROOT, 'src', 'sidecar', 'server.mjs')).href
);
const { runCli } = await import(pathToFileURL(join(REPO_ROOT, 'bin', 'agy-market.mjs')).href);

const CLEAN_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><rect x="16" y="16" width="96" height="96" rx="20" fill="#6366f1"/></svg>';

function makeTempWorkspace(prefix = 'agy-v15-test-') {
  const baseTmp = process.env.AGY_MARKET_TEST_TMPDIR || tmpdir();
  mkdirSync(baseTmp, { recursive: true });
  const root = mkdtempSync(join(baseTmp, prefix));
  const configDir = join(root, 'config');
  const pluginsDir = join(configDir, 'plugins');
  const dataDir = join(root, 'sidecar_data');
  const artifactsDir = join(root, 'artifacts');
  const workspaceDir = join(root, 'workspace');
  const builtinDir = join(root, 'builtin_plugins');
  mkdirSync(pluginsDir, { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(artifactsDir, { recursive: true });
  mkdirSync(workspaceDir, { recursive: true });
  mkdirSync(builtinDir, { recursive: true });
  return {
    root,
    configDir,
    pluginsDir,
    dataDir,
    artifactsDir,
    workspaceDir,
    builtinDir,
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
    buffer: buf,
  };
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
      preservePaths: [],
    },
    media: { iconUrl: null, screenshots: [] },
    taxonomy: { categories: ['monitoring-quota'], tags: [], platforms: ['win32', 'darwin', 'linux'] },
    capabilities: {
      badges,
      rulesEstimatedTokens: 0,
      mcpServers: [],
      mcpRemoteDomains,
      hookEvents,
      hostEnhancementKind: [],
    },
    updatedAt: '2026-11-24T00:00:00Z',
  };
}

function makeEmptyCatalogFetch() {
  return async (url) => {
    const u = String(url);
    if (u.endsWith('/index.json') || u.endsWith('/unverified-index.json')) {
      return new Response(
        JSON.stringify({
          schemaVersion: 1,
          track: 'verified',
          catalogVersion: '1.5.0-test',
          plugins: [],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    if (u.endsWith('/readmes.json')) {
      return new Response(JSON.stringify({ entries: {} }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ message: 'Not Found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  };
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

test('v1.5 uninstall: active, parked (/api/remove-files compat), host-disabled (read-only config.json), favorite/cache cleanup, and self/workspace/builtin guards', async () => {
  const ws = makeTempWorkspace('agy-v15-uninstall-');
  try {
    // Active global plugin with receipt, GitHub cache, and favorites
    writePluginTree(ws.pluginsDir, 'alpha-skill', {
      'plugin.json': {
        name: 'alpha-skill',
        displayName: 'Alpha Skill',
        version: '1.0.0',
        repository: 'https://github.com/alice/alpha-skill',
      },
      '.agy-market-receipt.json': {
        schemaVersion: 1,
        id: 'alice__alpha-skill',
        track: 'verified',
        repositoryId: 5001,
        installedDir: 'alpha-skill',
        installedVersion: '1.0.0',
        grantedCapabilities: { badges: ['declarative-only'], mcpRemoteDomains: [], hookEvents: [] },
      },
      'skills/alpha/SKILL.md': '---\nname: alpha\ndescription: x\n---\n# Alpha',
    });

    // Parked global plugin in disabled-plugins/<dir> with MCP server
    writePluginTree(join(ws.dataDir, 'disabled-plugins'), 'beta-parked', {
      'plugin.json': {
        name: 'beta-parked',
        displayName: 'Beta Parked MCP',
        version: '1.1.0',
      },
      'mcp_config.json': {
        mcpServers: {
          beta_srv: { command: 'node', args: ['srv.mjs'] },
        },
      },
    });

    // Host-disabled global plugin (config.json MUST remain byte-identical)
    writePluginTree(ws.pluginsDir, 'host-off-plug', {
      'plugin.json': { name: 'host-off-plug', displayName: 'Host Off Plug', version: '1.0.0' },
    });
    const cfgPath = join(ws.configDir, 'config.json');
    const originalCfg = JSON.stringify({ plugins: { 'host-off-plug': { enabled: false } } }, null, 2);
    writeFileSync(cfgPath, originalCfg, 'utf8');

    // Protected targets: agy-market (self), workspace plugin, builtin plugin
    writePluginTree(ws.pluginsDir, 'agy-market', {
      'plugin.json': { name: 'agy-market', displayName: 'AGY Market', version: PLUGIN_VERSION },
    });
    writePluginTree(join(ws.workspaceDir, '.agents', 'plugins'), 'ws-guarded', {
      'plugin.json': { name: 'ws-guarded', displayName: 'WS Guarded', version: '0.1.0' },
    });
    writePluginTree(ws.builtinDir, 'builtin-guarded', {
      'plugin.json': { name: 'builtin-guarded', displayName: 'Builtin Guarded', version: '0.1.0' },
    });

    // Seed GitHub cache file and prefs favorites
    const ghCacheDir = join(ws.dataDir, 'cache', 'github');
    mkdirSync(ghCacheDir, { recursive: true });
    const cacheFile = join(ghCacheDir, 'updates-alice__alpha-skill.json');
    writeFileSync(cacheFile, '{"cached":true}\n', 'utf8');
    writeFileSync(
      join(ws.dataDir, 'prefs.json'),
      JSON.stringify(
        {
          schemaVersion: 1,
          locale: 'zh',
          favorites: ['alice__alpha-skill', 'local:alpha-skill', 'keep__other'],
        },
        null,
        2,
      ),
      'utf8',
    );

    const wsUri = pathToFileURL(ws.workspaceDir).href;
    const srv = await createMarketSidecarServer({
      listen: false,
      configDir: ws.configDir,
      dataDir: ws.dataDir,
      builtinPluginsDir: ws.builtinDir,
      recoveryDelayMs: -1,
      fetchImpl: makeEmptyCatalogFetch(),
    });

    try {
      const authHeaders = { 'X-Sidecar-Token': srv.sideToken, Origin: 'http://127.0.0.1:43210' };

      // 1. State exposes accurate canUninstall & uninstallDisabledReason across all scopes
      const stRes = await srv.inject({
        method: 'GET',
        url: `/api/state?workspaceUris=${encodeURIComponent(wsUri)}`,
      });
      assert.equal(stRes.statusCode, 200);
      const installed = stRes.json().installed;
      const byDir = new Map(installed.map((x) => [x.dir, x]));
      assert.equal(byDir.get('alpha-skill').canUninstall, true);
      assert.equal(byDir.get('alpha-skill').uninstallDisabledReason, '');
      assert.equal(byDir.get('beta-parked').canUninstall, true);
      assert.equal(byDir.get('beta-parked').parkedByMarket, true);
      assert.equal(byDir.get('host-off-plug').canUninstall, true);
      assert.equal(byDir.get('agy-market').canUninstall, false);
      assert.equal(byDir.get('agy-market').uninstallDisabledReason, 'self');
      assert.equal(byDir.get('ws-guarded').canUninstall, false);
      assert.equal(byDir.get('ws-guarded').uninstallDisabledReason, 'workspace');
      assert.equal(byDir.get('builtin-guarded').canUninstall, false);
      assert.equal(byDir.get('builtin-guarded').uninstallDisabledReason, 'builtin');

      // 2. CSRF protection on POST /api/uninstall
      const unauth = await srv.inject({
        method: 'POST',
        url: '/api/uninstall',
        body: { dir: 'alpha-skill' },
      });
      assert.equal(unauth.statusCode, 403);
      assert.match(unauth.json().error, /ERR_CSRF_TOKEN/);

      // 3. Uninstall active plugin with removeFavorite: true -> deletes dir, cache, and favorite keys
      const delActive = await srv.inject({
        method: 'POST',
        url: '/api/uninstall',
        headers: authHeaders,
        body: { dir: 'alpha-skill', removeFavorite: true, workspaceUris: [wsUri] },
      });
      assert.equal(delActive.statusCode, 200);
      const delActiveJson = delActive.json();
      assert.equal(delActiveJson.ok, true);
      assert.equal(delActiveJson.removed, true);
      assert.equal(delActiveJson.locked, false);
      assert.equal(delActiveJson.activation.level, 'instant');
      assert.equal(delActiveJson.restartRequired, false);
      assert.equal(delActiveJson.customizationUri, 'customization://alpha-skill');
      assert.equal(existsSync(join(ws.pluginsDir, 'alpha-skill')), false);
      assert.equal(existsSync(cacheFile), false, 'Matching GitHub cache file must be purged');
      assert.deepEqual(delActiveJson.state.prefs.favorites, ['keep__other']);
      const diskPrefs = JSON.parse(readFileSync(join(ws.dataDir, 'prefs.json'), 'utf8'));
      assert.deepEqual(diskPrefs.favorites, ['keep__other']);

      // 4. Uninstall parked plugin via legacy /api/remove-files compatibility alias
      const delParked = await srv.inject({
        method: 'POST',
        url: '/api/remove-files',
        headers: authHeaders,
        body: { dir: 'beta-parked', workspaceUris: [wsUri] },
      });
      assert.equal(delParked.statusCode, 200);
      const delParkedJson = delParked.json();
      assert.equal(delParkedJson.ok, true);
      assert.equal(delParkedJson.removed, true);
      assert.equal(delParkedJson.hadMcp, true);
      assert.equal(delParkedJson.activation.level, 'reload-pane');
      assert.equal(delParkedJson.restartRequired, true);
      assert.equal(existsSync(join(ws.dataDir, 'disabled-plugins', 'beta-parked')), false);

      // 5. Uninstall host-disabled global plugin NEVER writes config.json
      const delHostOff = await srv.inject({
        method: 'POST',
        url: '/api/uninstall',
        headers: authHeaders,
        body: { dir: 'host-off-plug', workspaceUris: [wsUri] },
      });
      assert.equal(delHostOff.statusCode, 200);
      assert.equal(delHostOff.json().removed, true);
      assert.equal(existsSync(join(ws.pluginsDir, 'host-off-plug')), false);
      assert.equal(readFileSync(cfgPath, 'utf8'), originalCfg, 'config.json MUST remain byte-identical');

      // 6. Hard guards: self-delete, workspace plugin, builtin plugin
      const selfDel = await srv.inject({
        method: 'POST',
        url: '/api/uninstall',
        headers: authHeaders,
        body: { dir: 'agy-market', workspaceUris: [wsUri] },
      });
      assert.notEqual(selfDel.statusCode, 200);
      assert.match(selfDel.json().error, /ERR_CANNOT_SELF_DELETE/);
      assert.equal(existsSync(join(ws.pluginsDir, 'agy-market', 'plugin.json')), true);

      const wsDel = await srv.inject({
        method: 'POST',
        url: '/api/uninstall',
        headers: authHeaders,
        body: { dir: 'ws-guarded', workspaceUris: [wsUri] },
      });
      assert.notEqual(wsDel.statusCode, 200);
      assert.match(wsDel.json().error, /ERR_CANNOT_UNINSTALL_WORKSPACE/);
      assert.equal(existsSync(join(ws.workspaceDir, '.agents', 'plugins', 'ws-guarded', 'plugin.json')), true);

      const builtinDel = await srv.inject({
        method: 'POST',
        url: '/api/uninstall',
        headers: authHeaders,
        body: { dir: 'builtin-guarded', workspaceUris: [wsUri] },
      });
      assert.notEqual(builtinDel.statusCode, 200);
      assert.match(builtinDel.json().error, /ERR_CANNOT_UNINSTALL_BUILTIN/);
      assert.equal(existsSync(join(ws.builtinDir, 'builtin-guarded', 'plugin.json')), true);
    } finally {
      await srv.close();
    }
  } finally {
    ws.cleanup();
  }
});

test('v1.5 uninstall: symlink/NTFS junction unlinks link ONLY without deleting source directory', async () => {
  const ws = makeTempWorkspace('agy-v15-symlink-');
  try {
    const externalSrc = writePluginTree(join(ws.root, 'external-repos'), 'real-source-repo', {
      'plugin.json': { name: 'linked-plug', displayName: 'Linked Plug', version: '1.0.0' },
      'precious.txt': 'DO NOT DELETE SOURCE DATA\n',
    });

    const linkPath = join(ws.pluginsDir, 'linked-plug');
    let simulatedSymlink = false;
    try {
      symlinkSync(externalSrc, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
      assert.equal(lstatSync(linkPath).isSymbolicLink(), true);
    } catch (err) {
      if (err?.code === 'EPERM' || err?.code === 'EACCES') {
        simulatedSymlink = true;
        // Under restricted Windows sandboxes where NTFS junction creation returns EPERM,
        // verify the exact symlink-only uninstall branch via linkInfoOverride & unlinkLinkOverride.
        writePluginTree(ws.pluginsDir, 'linked-plug', {
          'plugin.json': { name: 'linked-plug', displayName: 'Linked Plug', version: '1.0.0' },
        });
      } else {
        throw err;
      }
    }

    const unlinkedLinkTargets = [];
    let recursiveRmCalled = false;
    const srv = await createMarketSidecarServer({
      listen: false,
      configDir: ws.configDir,
      dataDir: ws.dataDir,
      recoveryDelayMs: -1,
      fetchImpl: makeEmptyCatalogFetch(),
      ...(simulatedSymlink
        ? {
            linkInfoOverride: (parentDir, dirName) => {
              if (resolve(parentDir) === resolve(ws.pluginsDir) && dirName === 'linked-plug') {
                return {
                  isSymlink: true,
                  targetPath: externalSrc,
                  lstat: { isSymbolicLink: () => true, isDirectory: () => false },
                };
              }
              return null;
            },
            unlinkLinkOverride: (targetPath) => {
              unlinkedLinkTargets.push(resolve(targetPath));
              rmSync(targetPath, { recursive: true, force: true });
            },
            rmOverride: () => {
              recursiveRmCalled = true;
              throw new Error('rmOverride MUST NOT be called when uninstalling a symlink/junction');
            },
          }
        : {}),
    });

    try {
      const res = await srv.inject({
        method: 'POST',
        url: '/api/uninstall',
        headers: { 'X-Sidecar-Token': srv.sideToken, Origin: 'http://127.0.0.1:43210' },
        body: { dir: 'linked-plug' },
      });
      assert.equal(res.statusCode, 200);
      const data = res.json();
      assert.equal(data.ok, true);
      assert.equal(data.removed, true);
      assert.equal(data.locked, false);

      if (simulatedSymlink) {
        assert.deepEqual(unlinkedLinkTargets, [resolve(linkPath)]);
        assert.equal(recursiveRmCalled, false, 'Symlink uninstall must never invoke recursive rm');
      }
      assert.equal(existsSync(linkPath), false, 'Symlink/junction entry itself must be removed');
      assert.equal(existsSync(join(externalSrc, 'precious.txt')), true, 'Source directory contents MUST survive');
      assert.equal(readFileSync(join(externalSrc, 'precious.txt'), 'utf8'), 'DO NOT DELETE SOURCE DATA\n');
    } finally {
      await srv.close();
    }
  } finally {
    ws.cleanup();
  }
});

test('v1.5 uninstall: Windows EBUSY file lock retires to .old.<ts>, immediately removes plugin.json, and sweepRetiredBinaries prunes empty parent & orphan dirs', async () => {
  const ws = makeTempWorkspace('agy-v15-ebusy-');
  try {
    const lockedRoot = writePluginTree(ws.pluginsDir, 'locked-plug', {
      'plugin.json': { name: 'locked-plug', displayName: 'Locked Plug', version: '1.0.0' },
      'bin/native.node': Buffer.from('FAKE_LOCKED_BINARY_PAYLOAD'),
      'skills/demo/SKILL.md': '---\nname: demo\ndescription: d\n---\n# Demo',
    });
    // Keep agy-market intact and seed an orphan empty shell dir
    writePluginTree(ws.pluginsDir, 'agy-market', {
      'plugin.json': { name: 'agy-market', displayName: 'AGY Market', version: PLUGIN_VERSION },
    });
    const orphanShell = join(ws.pluginsDir, 'orphan-empty-shell', 'sidecars', 'panel');
    mkdirSync(orphanShell, { recursive: true });

    const lockedBinPath = resolve(lockedRoot, 'bin', 'native.node');
    const fixedNow = 1764000000000;

    // Simulate Windows EBUSY on recursive rmSync and on direct unlink of bin/native.node
    const srv = await createMarketSidecarServer({
      listen: false,
      configDir: ws.configDir,
      dataDir: ws.dataDir,
      recoveryDelayMs: -1,
      nowFn: () => fixedNow,
      fetchImpl: makeEmptyCatalogFetch(),
      rmOverride: () => {
        const err = new Error('EBUSY: resource busy or locked');
        err.code = 'EBUSY';
        throw err;
      },
      unlinkOverride: (p) => {
        if (resolve(p) === lockedBinPath) {
          const err = new Error('EBUSY: resource busy or locked');
          err.code = 'EBUSY';
          throw err;
        }
        unlinkSync(p);
      },
    });

    let retiredPath = '';
    try {
      const res = await srv.inject({
        method: 'POST',
        url: '/api/uninstall',
        headers: { 'X-Sidecar-Token': srv.sideToken, Origin: 'http://127.0.0.1:43210' },
        body: { dir: 'locked-plug' },
      });
      assert.equal(res.statusCode, 200);
      const data = res.json();
      assert.equal(data.ok, true);
      assert.equal(data.removed, true, 'Must report removed=true once plugin.json is deleted');
      assert.equal(data.locked, true);
      assert.equal(data.restartRequired, true);
      assert.equal(data.activation.level, 'host-restart');
      assert.match(data.activation.reasonZh, /已卸载插件/);
      assert.match(data.activation.reasonZh, /锁定文件/);

      // plugin.json MUST already be gone so host stops loading it immediately
      assert.equal(existsSync(join(lockedRoot, 'plugin.json')), false);
      assert.equal(existsSync(join(lockedRoot, 'skills', 'demo', 'SKILL.md')), false);

      // Locked binary was renamed aside to .old.<ts> and recorded in retired-binaries.json
      assert.equal(data.retiredBinaries.length, 1);
      retiredPath = data.retiredBinaries[0];
      assert.match(retiredPath, /native\.node\.old\.1764000000000$/);
      assert.equal(existsSync(retiredPath), true);

      const retiredList = JSON.parse(readFileSync(join(ws.dataDir, 'retired-binaries.json'), 'utf8'));
      assert.ok(retiredList.includes(retiredPath));

      // State no longer lists locked-plug as installed
      assert.equal(
        data.state.installed.some((x) => x.dir === 'locked-plug'),
        false,
      );
    } finally {
      await srv.close();
    }

    // Verify classifyActivationRequirement uninstall contract directly as well
    const uninstallInstant = classifyActivationRequirement({ badges: ['declarative-only'] }, { action: 'uninstall' });
    assert.equal(uninstallInstant.level, 'instant');
    assert.match(uninstallInstant.reasonZh, /卸载/);

    // Next boot: sweepRetiredBinaries unlinks .old.<ts> AND prunes remaining empty parent + orphan shell dirs
    const swept = sweepRetiredBinaries(ws.dataDir, { pluginsDir: ws.pluginsDir });
    assert.equal(swept.removed, 1);
    assert.equal(swept.remaining, 0);
    assert.ok(swept.removedDirs >= 2, `Expected empty parent & orphan dirs pruned, got ${swept.removedDirs}`);
    assert.equal(existsSync(retiredPath), false);
    assert.equal(existsSync(lockedRoot), false, 'Empty locked-plug parent directory must be completely removed');
    assert.equal(
      existsSync(join(ws.pluginsDir, 'orphan-empty-shell')),
      false,
      'Orphan empty shell directory without plugin.json must be pruned',
    );
    assert.equal(
      existsSync(join(ws.pluginsDir, 'agy-market', 'plugin.json')),
      true,
      'agy-market must NEVER be touched by sweepRetiredBinaries',
    );
  } finally {
    ws.cleanup();
  }
});

test('v1.5 CLI: bin/agy-market.mjs uninstall <dir> --yes --json (confirmation gate, self-delete block, remove alias, subprocess JSON)', async () => {
  const ws = makeTempWorkspace('agy-v15-cli-uninstall-');
  try {
    writePluginTree(ws.pluginsDir, 'agy-market', {
      'plugin.json': { name: 'agy-market', displayName: 'AGY Market', version: PLUGIN_VERSION },
    });
    writePluginTree(ws.pluginsDir, 'cli-plug', {
      'plugin.json': { name: 'cli-plug', displayName: 'CLI Plug', version: '1.0.0' },
    });
    writePluginTree(join(ws.dataDir, 'disabled-plugins'), 'cli-parked', {
      'plugin.json': { name: 'cli-parked', displayName: 'CLI Parked', version: '1.0.0' },
    });
    writePluginTree(ws.pluginsDir, 'subproc-plug', {
      'plugin.json': { name: 'subproc-plug', displayName: 'Subproc Plug', version: '1.0.0' },
    });

    // 1. Without --yes -> exit code 2 CONFIRM_REQUIRED, directory stays untouched
    const noYes = await runCli(['uninstall', 'cli-plug', '--dest', ws.pluginsDir, '--json'], {
      configDir: ws.configDir,
      dataDir: ws.dataDir,
    });
    assert.equal(noYes.code, 2);
    assert.equal(noYes.result.status, 'CONFIRM_REQUIRED');
    assert.equal(existsSync(join(ws.pluginsDir, 'cli-plug', 'plugin.json')), true);

    // 2. Self-delete blocked -> exit code 1 ERR_CANNOT_SELF_DELETE
    const selfRes = await runCli(['uninstall', 'agy-market', '--yes', '--dest', ws.pluginsDir, '--json'], {
      configDir: ws.configDir,
      dataDir: ws.dataDir,
    });
    assert.equal(selfRes.code, 1);
    assert.match(selfRes.error, /ERR_CANNOT_SELF_DELETE/);
    assert.equal(existsSync(join(ws.pluginsDir, 'agy-market', 'plugin.json')), true);

    // 3. Confirmed uninstall -> exit code 0 UNINSTALLED
    const okRes = await runCli(['uninstall', 'cli-plug', '--yes', '--dest', ws.pluginsDir, '--json'], {
      configDir: ws.configDir,
      dataDir: ws.dataDir,
    });
    assert.equal(okRes.code, 0);
    assert.equal(okRes.result.ok, true);
    assert.equal(okRes.result.removed, true);
    assert.equal(okRes.result.status, 'UNINSTALLED');
    assert.equal(existsSync(join(ws.pluginsDir, 'cli-plug')), false);

    // 4. Alias `remove` cleans parked plugin in disabled-plugins/<dir>
    const aliasRes = await runCli(['remove', 'cli-parked', '--yes', '--dest', ws.pluginsDir, '--json'], {
      configDir: ws.configDir,
      dataDir: ws.dataDir,
    });
    assert.equal(aliasRes.code, 0);
    assert.equal(aliasRes.result.ok, true);
    assert.equal(aliasRes.result.removed, true);
    assert.equal(existsSync(join(ws.dataDir, 'disabled-plugins', 'cli-parked')), false);

    // 5. Real CLI binary invocation via node bin/agy-market.mjs uninstall <dir> --yes --json
    const stdout = execFileSync(
      process.execPath,
      [join(REPO_ROOT, 'bin', 'agy-market.mjs'), 'uninstall', 'subproc-plug', '--yes', '--dest', ws.pluginsDir, '--json'],
      {
        env: {
          ...scrubChildProcessEnv(process.env),
          ANTIGRAVITY_CONFIG_DIR: ws.configDir,
          AGY_MARKET_DATA_DIR: ws.dataDir,
        },
        encoding: 'utf8',
      },
    );
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.status, 'UNINSTALLED');
    assert.equal(parsed.dir, 'subproc-plug');
    assert.equal(parsed.removed, true);
    assert.equal(existsSync(join(ws.pluginsDir, 'subproc-plug')), false);
  } finally {
    ws.cleanup();
  }
});

test('v1.5 Sidebar direct updates: GitHub upstream ahead of catalog returns installable=true (0 non-installable), POST /api/update preserves receipt track=verified & repositoryId, handles escalation, unreceipted GitHub repo, and ERR_NO_UPDATE_SOURCE', async () => {
  const ws = makeTempWorkspace('agy-v15-direct-upd-');
  try {
    // Seed 4 local plugins:
    // 1. clean-verified (v1.0.0, verified receipt, catalog at 1.0.0, GitHub upstream tag v2.1.0, same capabilities)
    writePluginTree(ws.pluginsDir, 'clean-verified', {
      'plugin.json': {
        name: 'clean-verified',
        displayName: 'Clean Verified',
        version: '1.0.0',
        repository: 'https://github.com/alice/clean-verified',
      },
      '.agy-market-receipt.json': {
        schemaVersion: 1,
        id: 'alice__clean-verified',
        track: 'verified',
        repositoryId: 777002,
        installedDir: 'clean-verified',
        effectivePluginName: 'clean-verified',
        scopedRewriteApplied: false,
        installedVersion: '1.0.0',
        gitTag: 'v1.0.0',
        grantedCapabilities: { badges: ['declarative-only'], mcpRemoteDomains: [], hookEvents: [] },
      },
      'skills/clean/SKILL.md': '---\nname: clean\ndescription: v1\n---\n# Clean v1',
    });

    // 2. esc-verified (v1.0.0, verified receipt, catalog at 1.0.0, GitHub upstream v1.4.0 adds lifecycle-hooks)
    writePluginTree(ws.pluginsDir, 'esc-verified', {
      'plugin.json': {
        name: 'esc-verified',
        displayName: 'Escalation Verified',
        version: '1.0.0',
        repository: 'https://github.com/alice/esc-verified',
      },
      '.agy-market-receipt.json': {
        schemaVersion: 1,
        id: 'alice__esc-verified',
        track: 'verified',
        repositoryId: 777001,
        installedDir: 'esc-verified',
        effectivePluginName: 'esc-verified',
        scopedRewriteApplied: false,
        installedVersion: '1.0.0',
        gitTag: 'v1.0.0',
        grantedCapabilities: { badges: ['declarative-only'], mcpRemoteDomains: [], hookEvents: [] },
      },
      'skills/esc/SKILL.md': '---\nname: esc\ndescription: v1\n---\n# Esc v1',
    });

    // 3. unreceipted-gh (v0.8.0, NO receipt, has plugin.json.repository -> GitHub tag v1.2.0)
    writePluginTree(ws.pluginsDir, 'unreceipted-gh', {
      'plugin.json': {
        name: 'unreceipted-gh',
        displayName: 'Unreceipted GH',
        version: '0.8.0',
        repository: 'https://github.com/carol/unreceipted-gh',
      },
      'skills/unr/SKILL.md': '---\nname: unr\ndescription: v0\n---\n# v0',
    });

    // 4. pure-local (v0.5.0, NO receipt, NO repository, NOT in catalog -> ERR_NO_UPDATE_SOURCE)
    writePluginTree(ws.pluginsDir, 'pure-local', {
      'plugin.json': {
        name: 'pure-local',
        displayName: 'Pure Local',
        version: '0.5.0',
      },
      'skills/local/SKILL.md': '---\nname: local\ndescription: local\n---\n# Local',
    });

    const staleCatTar1 = buildTarArtifact(ws.artifactsDir, 'clean-1.0.0.tar.gz', {
      'plugin.json': JSON.stringify({ name: 'clean-verified', displayName: 'Clean Verified', version: '1.0.0' }),
    });
    const staleCatTar2 = buildTarArtifact(ws.artifactsDir, 'esc-1.0.0.tar.gz', {
      'plugin.json': JSON.stringify({ name: 'esc-verified', displayName: 'Escalation Verified', version: '1.0.0' }),
    });

    const cleanV21Tar = buildGithubArchiveBuffer(
      {
        'plugin.json': JSON.stringify({
          name: 'clean-verified',
          displayName: 'Clean Verified',
          version: '2.1.0',
          description: 'Upgraded via GitHub upstream',
          repository: 'https://github.com/alice/clean-verified',
          logo: 'assets/logo.svg',
        }),
        'assets/logo.svg': CLEAN_SVG,
        'skills/clean/SKILL.md': '---\nname: clean\ndescription: v2.1\n---\n# Clean v2.1',
      },
      'clean-verified-2.1.0',
    );

    const escV14Tar = buildGithubArchiveBuffer(
      {
        'plugin.json': JSON.stringify({
          name: 'esc-verified',
          displayName: 'Escalation Verified',
          version: '1.4.0',
          description: 'Adds SessionStart hook',
          repository: 'https://github.com/alice/esc-verified',
          logo: 'assets/logo.svg',
        }),
        'assets/logo.svg': CLEAN_SVG,
        'skills/esc/SKILL.md': '---\nname: esc\ndescription: v1.4\n---\n# Esc v1.4',
        'hooks.json': JSON.stringify({
          SessionStart: [{ matcher: '', hooks: [{ type: 'command', command: 'echo hi' }] }],
        }),
      },
      'esc-verified-1.4.0',
    );

    const unreceiptedV12Tar = buildGithubArchiveBuffer(
      {
        'plugin.json': JSON.stringify({
          name: 'unreceipted-gh',
          displayName: 'Unreceipted GH',
          version: '1.2.0',
          description: 'Direct tag upgrade',
          repository: 'https://github.com/carol/unreceipted-gh',
          logo: 'assets/logo.svg',
        }),
        'assets/logo.svg': CLEAN_SVG,
        'skills/unr/SKILL.md': '---\nname: unr\ndescription: v1.2\n---\n# v1.2',
      },
      'unreceipted-gh-1.2.0',
    );

    const catalogIndex = {
      schemaVersion: 1,
      track: 'verified',
      catalogVersion: '1.5.0-test',
      plugins: [
        makeCatalogPlugin({
          id: 'alice__clean-verified',
          canonicalName: 'clean-verified',
          owner: 'alice',
          repo: 'clean-verified',
          displayName: 'Clean Verified',
          version: '1.0.0',
          repoId: 777002,
          tarballUrl: staleCatTar1.url,
          sha256: staleCatTar1.sha256,
        }),
        makeCatalogPlugin({
          id: 'alice__esc-verified',
          canonicalName: 'esc-verified',
          owner: 'alice',
          repo: 'esc-verified',
          displayName: 'Escalation Verified',
          version: '1.0.0',
          repoId: 777001,
          tarballUrl: staleCatTar2.url,
          sha256: staleCatTar2.sha256,
        }),
      ],
    };

    const mockFetch = async (url) => {
      const u = String(url);
      if (u.endsWith('/index.json')) return jsonResp(catalogIndex);
      if (u.endsWith('/unverified-index.json')) return jsonResp({ schemaVersion: 1, track: 'unverified', plugins: [] });
      if (u.endsWith('/readmes.json')) return jsonResp({ entries: {} });

      // alice/clean-verified -> tag v2.1.0 ahead of catalog v1.0.0
      if (u === 'https://api.github.com/repos/alice/clean-verified') {
        return jsonResp({ id: 777002, full_name: 'alice/clean-verified', default_branch: 'main' });
      }
      if (
        u === 'https://api.github.com/repos/alice/clean-verified/releases/latest' ||
        u === 'https://api.github.com/repos/alice/clean-verified/releases/tags/v2.1.0'
      ) {
        return jsonResp({
          tag_name: 'v2.1.0',
          html_url: 'https://github.com/alice/clean-verified/releases/tag/v2.1.0',
          body: 'Upstream v2.1.0 notes',
          assets: [],
        });
      }
      if (u.startsWith('https://api.github.com/repos/alice/clean-verified/tags')) {
        return jsonResp([{ name: 'v2.1.0', commit: { sha: 'b'.repeat(40) } }]);
      }
      if (u.includes('alice/clean-verified') && (u.includes('tar.gz') || u.includes('/archive/'))) {
        return binResp(cleanV21Tar);
      }

      // alice/esc-verified -> release v1.4.0 adding hooks
      if (u === 'https://api.github.com/repos/alice/esc-verified') {
        return jsonResp({ id: 777001, full_name: 'alice/esc-verified', default_branch: 'main' });
      }
      if (
        u === 'https://api.github.com/repos/alice/esc-verified/releases/latest' ||
        u === 'https://api.github.com/repos/alice/esc-verified/releases/tags/v1.4.0'
      ) {
        return jsonResp({
          tag_name: 'v1.4.0',
          html_url: 'https://github.com/alice/esc-verified/releases/tag/v1.4.0',
          body: 'Adds lifecycle hooks',
          assets: [],
        });
      }
      if (u.startsWith('https://api.github.com/repos/alice/esc-verified/tags')) {
        return jsonResp([{ name: 'v1.4.0', commit: { sha: 'c'.repeat(40) } }]);
      }
      if (u.includes('alice/esc-verified') && (u.includes('tar.gz') || u.includes('/archive/'))) {
        return binResp(escV14Tar);
      }

      // carol/unreceipted-gh -> tags-only v1.2.0
      if (u === 'https://api.github.com/repos/carol/unreceipted-gh') {
        return jsonResp({ id: 888001, full_name: 'carol/unreceipted-gh', default_branch: 'main' });
      }
      if (u.startsWith('https://api.github.com/repos/carol/unreceipted-gh/releases/')) {
        return jsonResp({ message: 'Not Found' }, 404);
      }
      if (u.startsWith('https://api.github.com/repos/carol/unreceipted-gh/tags')) {
        return jsonResp([{ name: 'v1.2.0', commit: { sha: 'd'.repeat(40) } }]);
      }
      if (u.includes('carol/unreceipted-gh') && (u.includes('tar.gz') || u.includes('/archive/'))) {
        return binResp(unreceiptedV12Tar);
      }

      return jsonResp({ message: 'Not Found' }, 404);
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

      // 1. GET /api/updates -> ZERO installable:false upstream items!
      const updRes = await srv.inject({ method: 'GET', url: '/api/updates?force=1' });
      assert.equal(updRes.statusCode, 200);
      const updJson = updRes.json();
      assert.equal(updJson.ok, true);
      assert.equal(
        updJson.items.filter((x) => !x.installable).length,
        0,
        'v1.5.0 must return ZERO installable:false upstream update items',
      );

      const byDir = new Map(updJson.items.map((x) => [x.dir, x]));
      const cleanUpd = byDir.get('clean-verified');
      assert.ok(cleanUpd);
      assert.equal(cleanUpd.installable, true);
      assert.equal(cleanUpd.updateChannel, 'github-upstream');
      assert.equal(cleanUpd.latestVersion, '2.1.0');
      assert.equal(cleanUpd.targetRef, 'v2.1.0');

      const escUpd = byDir.get('esc-verified');
      assert.ok(escUpd);
      assert.equal(escUpd.installable, true);
      assert.equal(escUpd.updateChannel, 'github-upstream');
      assert.equal(escUpd.latestVersion, '1.4.0');

      const unrUpd = byDir.get('unreceipted-gh');
      assert.ok(unrUpd);
      assert.equal(unrUpd.installable, true);
      assert.equal(unrUpd.updateChannel, 'github-upstream');
      assert.equal(unrUpd.latestVersion, '1.2.0');

      // 2. POST /api/update for clean-verified directly from mock GitHub -> preserves track='verified' & repositoryId!
      const u1 = await srv.inject({
        method: 'POST',
        url: '/api/update',
        headers: authHeaders,
        body: {
          id: cleanUpd.id,
          dir: 'clean-verified',
          updateChannel: cleanUpd.updateChannel,
          targetRef: cleanUpd.targetRef,
          updateKind: cleanUpd.updateKind,
        },
      });
      assert.equal(u1.statusCode, 200);
      assert.equal(u1.json().ok, true);
      assert.equal(u1.json().version, '2.1.0');

      const cleanManifest = JSON.parse(readFileSync(join(ws.pluginsDir, 'clean-verified', 'plugin.json'), 'utf8'));
      const cleanReceipt = JSON.parse(
        readFileSync(join(ws.pluginsDir, 'clean-verified', '.agy-market-receipt.json'), 'utf8'),
      );
      assert.equal(cleanManifest.version, '2.1.0');
      assert.equal(cleanReceipt.track, 'verified', 'Catalog verified track MUST be preserved on upstream update');
      assert.equal(cleanReceipt.id, 'alice__clean-verified');
      assert.equal(cleanReceipt.repositoryId, 777002, 'Catalog numeric repositoryId MUST be preserved');

      // 3. POST /api/update for esc-verified -> pauses for CAPABILITY_ESCALATION_CONFIRM_REQUIRED, then preserves track='verified'
      const uEsc1 = await srv.inject({
        method: 'POST',
        url: '/api/update',
        headers: authHeaders,
        body: {
          id: escUpd.id,
          dir: 'esc-verified',
          updateChannel: 'github-upstream',
          targetRef: 'v1.4.0',
        },
      });
      assert.equal(uEsc1.statusCode, 200);
      assert.equal(uEsc1.json().ok, false);
      assert.equal(uEsc1.json().status, 'CAPABILITY_ESCALATION_CONFIRM_REQUIRED');
      assert.ok(uEsc1.json().escalation.addedBadges.includes('lifecycle-hooks'));

      const uEsc2 = await srv.inject({
        method: 'POST',
        url: '/api/update',
        headers: authHeaders,
        body: {
          id: escUpd.id,
          dir: 'esc-verified',
          updateChannel: 'github-upstream',
          targetRef: 'v1.4.0',
          confirmEscalation: true,
        },
      });
      assert.equal(uEsc2.statusCode, 200);
      assert.equal(uEsc2.json().ok, true);
      const escReceipt = JSON.parse(
        readFileSync(join(ws.pluginsDir, 'esc-verified', '.agy-market-receipt.json'), 'utf8'),
      );
      assert.equal(escReceipt.track, 'verified');
      assert.equal(escReceipt.id, 'alice__esc-verified');
      assert.equal(escReceipt.repositoryId, 777001);
      assert.ok(escReceipt.grantedCapabilities.badges.includes('lifecycle-hooks'));

      // 4. Unreceipted local plugin with GitHub repository updates directly in Sidebar
      const uUnr = await srv.inject({
        method: 'POST',
        url: '/api/update',
        headers: authHeaders,
        body: {
          dir: 'unreceipted-gh',
          updateChannel: 'github-upstream',
          targetRef: 'v1.2.0',
        },
      });
      assert.equal(uUnr.statusCode, 200);
      assert.equal(uUnr.json().ok, true);
      const unrManifest = JSON.parse(readFileSync(join(ws.pluginsDir, 'unreceipted-gh', 'plugin.json'), 'utf8'));
      assert.equal(unrManifest.version, '1.2.0');

      // 5. Pure local plugin without catalog or GitHub repository returns HTTP 400 ERR_NO_UPDATE_SOURCE
      const uLocal = await srv.inject({
        method: 'POST',
        url: '/api/update',
        headers: authHeaders,
        body: { dir: 'pure-local' },
      });
      assert.equal(uLocal.statusCode, 400);
      assert.equal(uLocal.json().ok, false);
      assert.equal(uLocal.json().status, 'NO_UPDATE_SOURCE');
      assert.match(uLocal.json().error, /ERR_NO_UPDATE_SOURCE/);
    } finally {
      await srv.close();
    }
  } finally {
    ws.cleanup();
  }
});

test('v1.5 batch update-all: updates catalog + github-upstream + github-url together and schedules agy-market self-update last triggering onSelfRestart', async () => {
  const ws = makeTempWorkspace('agy-v15-update-all-');
  try {
    // Seed agy-market FIRST on disk to guarantee ordering invariant puts self LAST
    writePluginTree(ws.pluginsDir, 'agy-market', {
      'plugin.json': {
        name: 'agy-market',
        displayName: 'AGY Market',
        version: '1.4.0',
        repository: 'https://github.com/azwosile/agy-market',
      },
      '.agy-market-receipt.json': {
        schemaVersion: 1,
        id: 'azwosile__agy-market',
        track: 'verified',
        repositoryId: 1468650761,
        installedDir: 'agy-market',
        installedVersion: '1.4.0',
        grantedCapabilities: { badges: ['sidecar-ui'], mcpRemoteDomains: [], hookEvents: [] },
      },
    });

    // 1. catalog channel plugin (v1.0.0 -> catalog v1.1.0)
    writePluginTree(ws.pluginsDir, 'cat-plug', {
      'plugin.json': {
        name: 'cat-plug',
        displayName: 'Cat Plug',
        version: '1.0.0',
        repository: 'https://github.com/alice/cat-plug',
      },
      '.agy-market-receipt.json': {
        schemaVersion: 1,
        id: 'alice__cat-plug',
        track: 'verified',
        repositoryId: 3001,
        installedDir: 'cat-plug',
        installedVersion: '1.0.0',
        grantedCapabilities: { badges: ['declarative-only'], mcpRemoteDomains: [], hookEvents: [] },
      },
    });

    // 2. github-upstream channel plugin (v1.0.0, catalog stuck at 1.0.0, GitHub upstream v1.3.0)
    writePluginTree(ws.pluginsDir, 'up-plug', {
      'plugin.json': {
        name: 'up-plug',
        displayName: 'Up Plug',
        version: '1.0.0',
        repository: 'https://github.com/bob/up-plug',
      },
      '.agy-market-receipt.json': {
        schemaVersion: 1,
        id: 'bob__up-plug',
        track: 'verified',
        repositoryId: 8881,
        installedDir: 'up-plug',
        installedVersion: '1.0.0',
        grantedCapabilities: { badges: ['declarative-only'], mcpRemoteDomains: [], hookEvents: [] },
      },
    });

    // 3. github-url channel plugin (v1.0.0, track='github-url', GitHub release v1.2.0)
    writePluginTree(ws.pluginsDir, 'url-plug', {
      'plugin.json': {
        name: 'url-plug',
        displayName: 'URL Plug',
        version: '1.0.0',
        repository: 'https://github.com/dave/url-plug',
      },
      '.agy-market-receipt.json': {
        schemaVersion: 1,
        id: 'github:dave/url-plug',
        track: 'github-url',
        repositoryId: 9991,
        repositoryUrl: 'https://github.com/dave/url-plug',
        installedDir: 'url-plug',
        installedVersion: '1.0.0',
        grantedCapabilities: { badges: ['declarative-only'], mcpRemoteDomains: [], hookEvents: [] },
      },
    });

    const catV11Tar = buildTarArtifact(ws.artifactsDir, 'cat-1.1.0.tar.gz', {
      'plugin.json': JSON.stringify({ name: 'cat-plug', displayName: 'Cat Plug', version: '1.1.0', logo: 'assets/logo.svg' }),
      'assets/logo.svg': CLEAN_SVG,
    });
    const upStaleTar = buildTarArtifact(ws.artifactsDir, 'up-1.0.0.tar.gz', {
      'plugin.json': JSON.stringify({ name: 'up-plug', displayName: 'Up Plug', version: '1.0.0' }),
    });
    const selfStaleTar = buildTarArtifact(ws.artifactsDir, 'self-1.4.0.tar.gz', {
      'plugin.json': JSON.stringify({ name: 'agy-market', displayName: 'AGY Market', version: '1.4.0' }),
    });

    const upV13Buf = buildGithubArchiveBuffer(
      {
        'plugin.json': JSON.stringify({
          name: 'up-plug',
          displayName: 'Up Plug',
          version: '1.3.0',
          repository: 'https://github.com/bob/up-plug',
          logo: 'assets/logo.svg',
        }),
        'assets/logo.svg': CLEAN_SVG,
        'skills/up/SKILL.md': '---\nname: up\ndescription: v1.3\n---\n# Up v1.3',
      },
      'up-plug-1.3.0',
    );

    const urlV12Buf = buildGithubArchiveBuffer(
      {
        'plugin.json': JSON.stringify({
          name: 'url-plug',
          displayName: 'URL Plug',
          version: '1.2.0',
          repository: 'https://github.com/dave/url-plug',
          logo: 'assets/logo.svg',
        }),
        'assets/logo.svg': CLEAN_SVG,
        'skills/url/SKILL.md': '---\nname: url\ndescription: v1.2\n---\n# URL v1.2',
      },
      'url-plug-1.2.0',
    );

    const selfV15Buf = buildGithubArchiveBuffer(
      {
        'plugin.json': JSON.stringify({
          name: 'agy-market',
          displayName: 'AGY Market',
          version: '1.5.0',
          repository: 'https://github.com/azwosile/agy-market',
          logo: 'assets/logo.svg',
        }),
        'assets/logo.svg': CLEAN_SVG,
        'sidecars/market_pane/sidecar.json': JSON.stringify({ command: 'node', args: ['main.mjs'], has_web_ui: true }),
      },
      'agy-market-1.5.0',
    );

    const selfV151Buf = buildGithubArchiveBuffer(
      {
        'plugin.json': JSON.stringify({
          name: 'agy-market',
          displayName: 'AGY Market',
          version: '1.5.1',
          repository: 'https://github.com/azwosile/agy-market',
          logo: 'assets/logo.svg',
        }),
        'assets/logo.svg': CLEAN_SVG,
        'sidecars/market_pane/sidecar.json': JSON.stringify({ command: 'node', args: ['main.mjs'], has_web_ui: true }),
      },
      'agy-market-1.5.1',
    );

    const catalogIndex = {
      schemaVersion: 1,
      track: 'verified',
      catalogVersion: '1.5.0-test',
      plugins: [
        // Deliberately list agy-market FIRST in catalog too
        makeCatalogPlugin({
          id: 'azwosile__agy-market',
          canonicalName: 'agy-market',
          owner: 'azwosile',
          repo: 'agy-market',
          displayName: 'AGY Market',
          version: '1.4.0',
          repoId: 1468650761,
          tarballUrl: selfStaleTar.url,
          sha256: selfStaleTar.sha256,
          badges: ['sidecar-ui'],
        }),
        makeCatalogPlugin({
          id: 'alice__cat-plug',
          canonicalName: 'cat-plug',
          owner: 'alice',
          repo: 'cat-plug',
          displayName: 'Cat Plug',
          version: '1.1.0',
          repoId: 3001,
          tarballUrl: catV11Tar.url,
          sha256: catV11Tar.sha256,
        }),
        makeCatalogPlugin({
          id: 'bob__up-plug',
          canonicalName: 'up-plug',
          owner: 'bob',
          repo: 'up-plug',
          displayName: 'Up Plug',
          version: '1.0.0',
          repoId: 8881,
          tarballUrl: upStaleTar.url,
          sha256: upStaleTar.sha256,
        }),
      ],
    };

    const mockFetch = async (url) => {
      const u = String(url);
      if (u.endsWith('/index.json')) return jsonResp(catalogIndex);
      if (u.endsWith('/unverified-index.json')) return jsonResp({ schemaVersion: 1, track: 'unverified', plugins: [] });
      if (u.endsWith('/readmes.json')) return jsonResp({ entries: {} });

      // alice/cat-plug matches catalog v1.1.0
      if (u === 'https://api.github.com/repos/alice/cat-plug/releases/latest') {
        return jsonResp({ tag_name: 'v1.1.0', html_url: 'https://github.com/alice/cat-plug/releases/tag/v1.1.0' });
      }
      if (u.startsWith('https://api.github.com/repos/alice/cat-plug/tags')) {
        return jsonResp([{ name: 'v1.1.0' }]);
      }

      // bob/up-plug upstream v1.3.0
      if (u === 'https://api.github.com/repos/bob/up-plug') {
        return jsonResp({ id: 8881, full_name: 'bob/up-plug', default_branch: 'main' });
      }
      if (
        u === 'https://api.github.com/repos/bob/up-plug/releases/latest' ||
        u === 'https://api.github.com/repos/bob/up-plug/releases/tags/v1.3.0'
      ) {
        return jsonResp({ tag_name: 'v1.3.0', html_url: 'https://github.com/bob/up-plug/releases/tag/v1.3.0', assets: [] });
      }
      if (u.startsWith('https://api.github.com/repos/bob/up-plug/tags')) {
        return jsonResp([{ name: 'v1.3.0', commit: { sha: '1'.repeat(40) } }]);
      }
      if (u.includes('bob/up-plug') && (u.includes('tar.gz') || u.includes('/archive/'))) {
        return binResp(upV13Buf);
      }

      // dave/url-plug github-url v1.2.0
      if (u === 'https://api.github.com/repos/dave/url-plug') {
        return jsonResp({ id: 9991, full_name: 'dave/url-plug', default_branch: 'main' });
      }
      if (
        u === 'https://api.github.com/repos/dave/url-plug/releases/latest' ||
        u === 'https://api.github.com/repos/dave/url-plug/releases/tags/v1.2.0'
      ) {
        return jsonResp({ tag_name: 'v1.2.0', html_url: 'https://github.com/dave/url-plug/releases/tag/v1.2.0', assets: [] });
      }
      if (u.startsWith('https://api.github.com/repos/dave/url-plug/tags')) {
        return jsonResp([{ name: 'v1.2.0', commit: { sha: '2'.repeat(40) } }]);
      }
      if (u.includes('dave/url-plug') && (u.includes('tar.gz') || u.includes('/archive/'))) {
        return binResp(urlV12Buf);
      }

      // azwosile/agy-market upstream v1.5.0 (and explicit v1.5.1 for self-update fallback check)
      if (u === 'https://api.github.com/repos/azwosile/agy-market') {
        return jsonResp({ id: 1468650761, full_name: 'azwosile/agy-market', default_branch: 'main' });
      }
      if (u === 'https://api.github.com/repos/azwosile/agy-market/releases/tags/v1.5.1') {
        return jsonResp({ tag_name: 'v1.5.1', html_url: 'https://github.com/azwosile/agy-market/releases/tag/v1.5.1', assets: [] });
      }
      if (
        u === 'https://api.github.com/repos/azwosile/agy-market/releases/latest' ||
        u === 'https://api.github.com/repos/azwosile/agy-market/releases/tags/v1.5.0'
      ) {
        return jsonResp({ tag_name: 'v1.5.0', html_url: 'https://github.com/azwosile/agy-market/releases/tag/v1.5.0', assets: [] });
      }
      if (u.startsWith('https://api.github.com/repos/azwosile/agy-market/tags')) {
        return jsonResp([{ name: 'v1.5.0', commit: { sha: '3'.repeat(40) } }]);
      }
      if (u.includes('azwosile/agy-market') && u.includes('v1.5.1')) {
        return binResp(selfV151Buf);
      }
      if (u.includes('azwosile/agy-market') && (u.includes('tar.gz') || u.includes('/archive/'))) {
        return binResp(selfV15Buf);
      }

      return jsonResp({ message: 'Not Found' }, 404);
    };

    let restartCount = 0;
    const srv = await createMarketSidecarServer({
      listen: false,
      configDir: ws.configDir,
      dataDir: ws.dataDir,
      currentSelfVersion: '1.4.0',
      recoveryDelayMs: -1,
      onSelfRestart: () => {
        restartCount += 1;
      },
      fetchImpl: mockFetch,
    });

    try {
      const authHeaders = { 'X-Sidecar-Token': srv.sideToken, Origin: 'http://127.0.0.1:43210' };

      const batchRes = await srv.inject({
        method: 'POST',
        url: '/api/update-all',
        headers: authHeaders,
        body: { forceCheck: true },
      });
      assert.equal(batchRes.statusCode, 200);
      const batch = batchRes.json();
      assert.equal(batch.ok, true);
      assert.equal(batch.willRestart, true);
      assert.equal(restartCount, 1, 'onSelfRestart must trigger exactly once after flush');
      assert.equal(batch.results.length, 4);

      // Strict ordering: agy-market self-update MUST be LAST
      const last = batch.results[batch.results.length - 1];
      assert.equal(last.dir, 'agy-market');
      assert.equal(last.isSelfUpdate, true);
      assert.equal(last.version, '1.5.0');

      const resByDir = new Map(batch.results.map((r) => [r.dir, r]));
      assert.equal(resByDir.get('cat-plug').version, '1.1.0');
      assert.equal(resByDir.get('up-plug').version, '1.3.0');
      assert.equal(resByDir.get('url-plug').version, '1.2.0');

      // Verify receipt fidelity on disk
      const upReceipt = JSON.parse(readFileSync(join(ws.pluginsDir, 'up-plug', '.agy-market-receipt.json'), 'utf8'));
      assert.equal(upReceipt.track, 'verified');
      assert.equal(upReceipt.repositoryId, 8881);

      const urlReceipt = JSON.parse(readFileSync(join(ws.pluginsDir, 'url-plug', '.agy-market-receipt.json'), 'utf8'));
      assert.equal(urlReceipt.track, 'github-url');

      const selfReceipt = JSON.parse(
        readFileSync(join(ws.pluginsDir, 'agy-market', '.agy-market-receipt.json'), 'utf8'),
      );
      assert.equal(selfReceipt.track, 'verified');
      assert.equal(selfReceipt.id, 'azwosile__agy-market');
      assert.equal(
        JSON.parse(readFileSync(join(ws.pluginsDir, 'agy-market', 'plugin.json'), 'utf8')).version,
        '1.5.0',
      );

      // Standalone POST /api/self-update with github-upstream fallback when catalog is behind
      const selfUpd = await srv.inject({
        method: 'POST',
        url: '/api/self-update',
        headers: authHeaders,
        body: { updateChannel: 'github-upstream', targetVersion: '1.5.1', targetRef: 'v1.5.1' },
      });
      assert.equal(selfUpd.statusCode, 200);
      assert.equal(selfUpd.json().ok, true);
      assert.equal(selfUpd.json().willRestart, true);
      assert.equal(selfUpd.json().version, '1.5.1');
      assert.equal(restartCount, 2);
      assert.equal(
        JSON.parse(readFileSync(join(ws.pluginsDir, 'agy-market', 'plugin.json'), 'utf8')).version,
        '1.5.1',
      );
    } finally {
      await srv.close();
    }
  } finally {
    ws.cleanup();
  }
});

test('v1.5.1 UI, taxonomy, version anchors & pure LF byte-purity assertions', () => {
  // 1. Built sidecars/market_pane/index.html MUST contain ZERO \r bytes (0 CRLF, 0 bare CR), 0 UTF-8 BOM, and inline PLUGIN_VERSION = '1.5.1'
  const builtHtmlPath = join(REPO_ROOT, 'sidecars', 'market_pane', 'index.html');
  const htmlBuf = readFileSync(builtHtmlPath);
  let crCount = 0;
  for (let i = 0; i < htmlBuf.length; i += 1) {
    if (htmlBuf[i] === 0x0d) crCount += 1;
  }
  assert.equal(crCount, 0, `Built sidecars/market_pane/index.html must contain 0 \\r bytes, found ${crCount}`);
  assert.equal(
    htmlBuf.length >= 3 && htmlBuf[0] === 0xef && htmlBuf[1] === 0xbb && htmlBuf[2] === 0xbf,
    false,
    'Built sidecars/market_pane/index.html must not contain UTF-8 BOM',
  );
  const builtHtmlText = htmlBuf.toString('utf8');
  assert.doesNotMatch(builtHtmlText, /btn-upstream/, 'Built index.html must contain 0 btn-upstream external buttons');
  assert.match(
    builtHtmlText,
    /const\s+PLUGIN_VERSION\s*=\s*'1\.5\.1'/,
    'Built sidecars/market_pane/index.html must inline PLUGIN_VERSION = \'1.5.1\'',
  );
  assert.match(builtHtmlText, /function\s+isPluginConfirmedLatest\s*\(/, 'Built index.html must include isPluginConfirmedLatest');
  assert.match(builtHtmlText, /state-pill is-latest/, 'Built index.html must include state-pill is-latest markup');
  assert.match(builtHtmlText, /\.state-pill\.is-latest\b/, 'Built index.html must include .state-pill.is-latest style');

  // 2. Static scan src/ui/app.mjs & src/ui/styles.css for v1.5.1 UI controls and zero btn-upstream
  const appSrc = readFileSync(join(REPO_ROOT, 'src', 'ui', 'app.mjs'), 'utf8');
  const cssSrc = readFileSync(join(REPO_ROOT, 'src', 'ui', 'styles.css'), 'utf8');

  assert.match(appSrc, /data-action="prompt-uninstall"/, 'Installed card/drawer must render prompt-uninstall button');
  assert.match(
    appSrc,
    /data-action="sync-installed-plugin"/,
    'Installed card must render per-plugin sync-installed-plugin update button before check completes',
  );
  assert.match(appSrc, /function\s+isPluginConfirmedLatest\s*\(/, 'src/ui/app.mjs must define isPluginConfirmedLatest');
  assert.match(appSrc, /state-pill is-latest/, 'src/ui/app.mjs must render state-pill is-latest when up to date');
  assert.match(cssSrc, /\.state-pill\.is-latest\b/, 'src/ui/styles.css must style .state-pill.is-latest');
  assert.match(appSrc, /data-action="update-all"/, 'Installed header must render permanent update-all button');
  assert.match(appSrc, /一键更新/, 'Installed header must display 一键更新 label');
  assert.doesNotMatch(appSrc, /btn-upstream/, 'src/ui/app.mjs must render 0 btn-upstream external link buttons');
  assert.doesNotMatch(cssSrc, /\.btn-upstream\b/, 'src/ui/styles.css must contain 0 .btn-upstream rules');
  assert.doesNotMatch(appSrc, /个上游新版待目录同步/, 'Stale upstream-awaiting-catalog copy must be removed');

  // 3. CATEGORY_LABELS must contain 15 categories + 'all' = 16 keys, including 3 new v1.5 categories
  const catKeys = Object.keys(CATEGORY_LABELS);
  assert.equal(catKeys.length, 16, `CATEGORY_LABELS must have 16 keys (all + 15 categories), got ${catKeys.length}`);
  const expectedKeys = [
    'all',
    'monitoring-quota',
    'context-cache',
    'ui-themes',
    'agents-reasoning',
    'developer-tools',
    'mcp-integrations',
    'skills-workflows',
    'productivity',
    'data-science',
    'cloud-devops',
    'creative-media',
    'writing-knowledge',
    'automation',
    'security',
    'other',
  ];
  for (const key of expectedKeys) {
    assert.ok(key in CATEGORY_LABELS, `Missing category key "${key}" in CATEGORY_LABELS`);
    assert.ok(CATEGORY_LABELS[key].zh && CATEGORY_LABELS[key].en, `Category "${key}" must define zh and en labels`);
  }

  // 4. Version 1.5.1 anchors, pure LF / 0 BOM bootstrap scripts, & 10-field plugin.json purity
  const pkgJson = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));
  const pluginJson = JSON.parse(readFileSync(join(REPO_ROOT, 'plugin.json'), 'utf8'));
  assert.equal(PLUGIN_VERSION, '1.5.1');
  assert.equal(pkgJson.version, '1.5.1');
  assert.equal(pluginJson.version, '1.5.1');
  assert.equal(pluginJson.name, PLUGIN_ID);
  for (const key of Object.keys(pluginJson)) {
    assert.ok(PLUGIN_JSON_ALLOWED_KEYS.has(key), `Disallowed key "${key}" in plugin.json`);
  }

  const ps1Buf = readFileSync(join(REPO_ROOT, 'scripts', 'install.ps1'));
  const shBuf = readFileSync(join(REPO_ROOT, 'scripts', 'install.sh'));
  assert.equal(ps1Buf[0] === 0xef && ps1Buf[1] === 0xbb && ps1Buf[2] === 0xbf, false, 'install.ps1 must have 0 UTF-8 BOM');
  assert.equal(ps1Buf.includes(0x0d), false, 'install.ps1 must be pure LF (0 CR)');
  assert.equal(shBuf.includes(0x0d), false, 'install.sh must be pure LF (0 CR)');
  assert.match(ps1Buf.toString('utf8'), /else\s*\{\s*"1\.5\.1"\s*\}/);
  assert.match(shBuf.toString('utf8'), /INSTALLED_VER="1\.5\.1"/);

  const siteHtml = readFileSync(join(REPO_ROOT, 'site', 'index.html'), 'utf8');
  assert.match(siteHtml, /v1\.5\.1/);
  const docsIndexPath = join(REPO_ROOT, 'docs', 'index.html');
  if (existsSync(docsIndexPath)) {
    const docsBuf = readFileSync(docsIndexPath);
    assert.equal(docsBuf.includes(0x0d), false, 'docs/index.html must be pure LF (0 CR)');
    assert.match(docsBuf.toString('utf8'), /v1\.5\.1/);
  }
});

test('v1.5.1 UI state machine: isPluginConfirmedLatest & .state-pill.is-latest transitions (pre-check, up-to-date, direct update, single-sync no-reinstall, error handling, force re-check)', async () => {
  const bundled = bundleZeroDepEsm(join(REPO_ROOT, 'src', 'ui', 'app.mjs'));
  const bootMarker = 'void loadState(false);\nvoid checkUpdates(false, { silent: true });';
  assert.ok(bundled.includes(bootMarker), 'Bundled app.mjs must contain auto-boot marker');

  const instrumented = bundled.replace(
    bootMarker,
    [
      'globalThis.__V151_UI__ = {',
      '  state,',
      '  isPluginConfirmedLatest,',
      '  markPluginVerifiedLatest,',
      '  checkUpdates,',
      '  triggerDirectPluginUpdate,',
      '  triggerSyncInstalledPlugin,',
      '  triggerInstall,',
      '  renderInstalledCard,',
      '  renderDetailDrawer,',
      '  getUpdateMaps,',
      '  getCatalogMaps,',
      '};',
    ].join('\n'),
  );

  const fetchCalls = [];
  let mockFetchHandler = async () => jsonResp({ ok: true });
  const mockFetchFn = async (url, opts = {}) => {
    fetchCalls.push({ url: String(url), method: String(opts.method || 'GET'), body: opts.body || null });
    return mockFetchHandler(String(url), opts);
  };

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
    __SIDECAR_BOOT__: { token: 'test-token-v151' },
    sidecar: null,
    fetch: mockFetchFn,
  };
  const mockDocument = {
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    activeElement: null,
    documentElement: { setAttribute: () => {}, classList: { toggle: () => {} } },
    body: { classList: { toggle: () => {} } },
    addEventListener: () => {},
  };

  const sandbox = {
    window: mockWindow,
    document: mockDocument,
    fetch: mockFetchFn,
    URL,
    URLSearchParams,
    Headers,
    Response,
    console,
    setTimeout: () => 1,
    clearTimeout: () => {},
    requestAnimationFrame: (cb) => {
      cb();
      return 1;
    },
  };
  sandbox.globalThis = sandbox;
  sandbox.self = mockWindow;

  vm.runInNewContext(instrumented, sandbox, { filename: 'agy-market-v151-ui-test.js' });
  const ui = sandbox.__V151_UI__;
  assert.ok(ui, 'Instrumented UI test harness must expose __V151_UI__');

  const alphaCat = {
    id: 'alice__alpha-plug',
    canonicalName: 'alpha-plug',
    displayName: 'Alpha Plug',
    version: '1.0.0',
    description: { zh: 'Alpha 插件', en: 'Alpha plugin' },
    repository: { url: 'https://github.com/alice/alpha-plug', stars: 10 },
    capabilities: { badges: ['declarative-only'] },
    taxonomy: { categories: ['developer-tools'], tags: [] },
    installStatus: { installed: true, installedDir: 'alpha-plug', enabled: true, scope: 'global', canUninstall: true },
  };
  const alphaLoc = {
    dir: 'alpha-plug',
    name: 'alpha-plug',
    displayName: 'Alpha Plug',
    version: '1.0.0',
    scope: 'global',
    enabled: true,
    canUninstall: true,
    repositoryUrl: 'https://github.com/alice/alpha-plug',
    receipt: { id: 'alice__alpha-plug', track: 'verified', repositoryUrl: 'https://github.com/alice/alpha-plug' },
    capabilities: { badges: ['declarative-only'] },
  };
  const selfLoc = {
    dir: 'agy-market',
    name: 'agy-market',
    displayName: 'AGY Market',
    version: '1.5.1',
    scope: 'global',
    enabled: true,
    canUninstall: false,
    uninstallDisabledReason: 'self',
    repositoryUrl: 'https://github.com/azwosile/agy-market',
    receipt: { id: 'azwosile__agy-market', track: 'verified', repositoryUrl: 'https://github.com/azwosile/agy-market' },
    capabilities: { badges: ['sidecar-ui'] },
  };
  const selfCat = {
    id: 'azwosile__agy-market',
    canonicalName: 'agy-market',
    displayName: 'AGY Market',
    version: '1.5.1',
    description: { zh: '市场插件', en: 'Market plugin' },
    repository: { url: 'https://github.com/azwosile/agy-market', stars: 99 },
    capabilities: { badges: ['sidecar-ui'] },
    taxonomy: { categories: ['productivity'], tags: [] },
    installStatus: { installed: true, installedDir: 'agy-market', enabled: true, scope: 'global', canUninstall: false },
  };
  const localOnlyLoc = {
    dir: 'pure-local',
    name: 'pure-local',
    displayName: 'Pure Local',
    version: '0.1.0',
    scope: 'global',
    enabled: true,
    canUninstall: true,
    capabilities: { badges: ['declarative-only'] },
  };
  const wsLoc = {
    dir: 'ws-plug',
    name: 'ws-plug',
    displayName: 'Workspace Plug',
    version: '0.2.0',
    scope: 'workspace',
    enabled: true,
    canUninstall: false,
    capabilities: { badges: ['declarative-only'] },
  };

  const makeServerState = (locale = 'zh', alphaVersion = '1.0.0') => ({
    plugin: { id: 'agy-market', version: '1.5.1' },
    prefs: { locale, favorites: [], enableExperimentalTrack2: false },
    catalog: { plugins: [{ ...alphaCat, version: alphaVersion }, selfCat], channelUsed: 'primary' },
    installed: [{ ...alphaLoc, version: alphaVersion }, selfLoc, localOnlyLoc, wsLoc],
    updatesAvailable: [],
    conflictsSummary: { total: 0, critical: 0, warning: 0, info: 0 },
  });

  const renderCard = (loc) => {
    const { byId: updById, byDir: updByDir } = ui.getUpdateMaps();
    const { byId: catById, byDir: catByDir } = ui.getCatalogMaps();
    return ui.renderInstalledCard(loc, updById, updByDir, catById, catByDir);
  };

  // Scenario 1: Before any update check completes -> remote plugins expose clickable sync-installed-plugin; local/workspace render .state-pill.is-local
  ui.state.serverState = makeServerState('zh', '1.0.0');
  ui.state.updates = { loading: false, checkedAt: '', items: [], selfUpdate: null, rateLimited: false, warnings: [], error: '' };
  ui.state.verifiedLatestDirs.clear();

  assert.equal(ui.isPluginConfirmedLatest(alphaLoc, null), false);
  assert.equal(ui.isPluginConfirmedLatest(selfLoc, null), false);
  const preAlphaHtml = renderCard(alphaLoc);
  assert.match(preAlphaHtml, /data-action="sync-installed-plugin"/, 'Unchecked remote plugin must allow single-click update check');
  assert.doesNotMatch(preAlphaHtml, /state-pill is-latest/, 'Unchecked plugin must not claim Latest before check');
  const preLocalHtml = renderCard(localOnlyLoc);
  assert.match(preLocalHtml, /<span class="state-pill is-local"[^>]*>本地<\/span>/);
  assert.doesNotMatch(preLocalHtml, /data-action="sync-installed-plugin"/);
  const preWsHtml = renderCard(wsLoc);
  assert.match(preWsHtml, /<span class="state-pill is-local"[^>]*>工作区<\/span>/);

  // Scenario 1b: Global check completes cleanly with NO updates (verifiedLatestDirs still empty) -> checkedAt non-empty alone transitions cards to .state-pill.is-latest
  ui.state.updates = {
    loading: false,
    checkedAt: '2026-11-24T14:25:00Z',
    items: [],
    selfUpdate: null,
    rateLimited: false,
    warnings: [],
    error: '',
  };
  ui.state.verifiedLatestDirs.clear();
  assert.equal(ui.isPluginConfirmedLatest(alphaLoc, null), true);
  assert.equal(ui.isPluginConfirmedLatest(selfLoc, null), true);
  const globalLatestAlphaHtml = renderCard(alphaLoc);
  assert.match(globalLatestAlphaHtml, /<span class="state-pill is-latest"[^>]*>[\s\S]*?<span>最新<\/span><\/span>/);
  assert.doesNotMatch(globalLatestAlphaHtml, /data-action="sync-installed-plugin"/);
  const globalLatestSelfHtml = renderCard(selfLoc);
  assert.match(globalLatestSelfHtml, /<span class="state-pill is-latest"[^>]*>[\s\S]*?<span>最新<\/span><\/span>/);
  assert.doesNotMatch(globalLatestSelfHtml, /data-action="self-update"/);

  // Scenario 2: Single-plugin sync when already up to date -> MUST NOT re-download/re-install, transitions immediately to .state-pill.is-latest
  ui.state.updates = { loading: false, checkedAt: '', items: [], selfUpdate: null, rateLimited: false, warnings: [], error: '' };
  ui.state.verifiedLatestDirs.clear();
  fetchCalls.length = 0;
  mockFetchHandler = async (url) => {
    if (url.startsWith('/api/updates')) {
      return jsonResp({ ok: true, checkedAt: '2026-11-24T14:30:00Z', items: [], selfUpdate: null, rateLimited: false });
    }
    throw new Error(`Unexpected API call when already latest: ${url}`);
  };
  await ui.triggerSyncInstalledPlugin({ dir: 'alpha-plug', id: 'alice__alpha-plug', displayName: 'Alpha Plug' });
  assert.equal(
    fetchCalls.filter((c) => c.url.startsWith('/api/update') && !c.url.startsWith('/api/updates')).length,
    0,
    'Normal plugin single-sync must NOT call /api/update or /api/install when already latest',
  );
  assert.equal(ui.state.verifiedLatestDirs.has('alpha-plug'), true);
  assert.match(ui.state.toast?.message || '', /当前已是最新版本/);
  const afterSyncAlphaHtml = renderCard(alphaLoc);
  assert.match(afterSyncAlphaHtml, /<span class="state-pill is-latest"[^>]*>[\s\S]*?<span>最新<\/span><\/span>/);
  assert.doesNotMatch(afterSyncAlphaHtml, /data-action="sync-installed-plugin"/);
  assert.doesNotMatch(afterSyncAlphaHtml, /data-action="update-plugin-direct"/);

  // Scenario 3: Self single-sync when already up to date -> 0 calls to /api/self-update (no pointless restart), shows Latest pill
  fetchCalls.length = 0;
  ui.state.updates.checkedAt = '';
  ui.state.verifiedLatestDirs.clear();
  await ui.triggerSyncInstalledPlugin({ dir: 'agy-market', id: 'azwosile__agy-market', displayName: 'AGY Market' });
  assert.equal(
    fetchCalls.filter((c) => c.url.startsWith('/api/self-update')).length,
    0,
    'agy-market single-sync must NEVER call /api/self-update when already latest',
  );
  assert.equal(ui.state.verifiedLatestDirs.has('agy-market'), true);
  assert.equal(ui.state.toast?.message, 'AGY Market 当前已是最新版本');
  const afterSyncSelfHtml = renderCard(selfLoc);
  assert.match(afterSyncSelfHtml, /<span class="state-pill is-latest"[^>]*>[\s\S]*?<span>最新<\/span><\/span>/);
  assert.doesNotMatch(afterSyncSelfHtml, /data-action="self-update"/);

  // Also verify English locale renders "Latest" pill and Detail Drawer renders .state-pill.is-latest (self has no Re-sync/self-update; normal has Re-sync)
  ui.state.serverState = makeServerState('en', '1.0.0');
  const enLatestCard = renderCard(alphaLoc);
  assert.match(enLatestCard, /<span class="state-pill is-latest"[^>]*>[\s\S]*?<span>Latest<\/span><\/span>/);

  ui.state.serverState = makeServerState('zh', '1.0.0');
  ui.state.detailPlugin = selfCat;
  const selfDrawerHtml = ui.renderDetailDrawer();
  assert.match(selfDrawerHtml, /<span class="state-pill is-latest"[^>]*>[\s\S]*?已是最新版本<\/span>/);
  assert.doesNotMatch(selfDrawerHtml, /data-action="self-update"/);
  assert.doesNotMatch(selfDrawerHtml, /重新同步/);

  ui.state.detailPlugin = alphaCat;
  const alphaDrawerHtml = ui.renderDetailDrawer();
  assert.match(alphaDrawerHtml, /<span class="state-pill is-latest"[^>]*>[\s\S]*?已是最新版本<\/span>/);
  assert.match(alphaDrawerHtml, /重新同步/);
  ui.state.detailPlugin = null;

  // Scenario 4: Update check error MUST NOT mark verifiedLatestDirs; keeps clickable sync button for retry
  ui.state.updates = { loading: false, checkedAt: '', items: [], selfUpdate: null, rateLimited: false, warnings: [], error: '' };
  ui.state.verifiedLatestDirs.clear();
  mockFetchHandler = async (url) => {
    if (url.startsWith('/api/updates')) {
      return jsonResp({ ok: false, error: 'NETWORK_OFFLINE' }, 503);
    }
    throw new Error(`Unexpected call during error scenario: ${url}`);
  };
  await ui.triggerSyncInstalledPlugin({ dir: 'alpha-plug', id: 'alice__alpha-plug', displayName: 'Alpha Plug' });
  assert.equal(ui.state.verifiedLatestDirs.has('alpha-plug'), false);
  assert.equal(ui.isPluginConfirmedLatest(alphaLoc, null), false);
  assert.equal(ui.state.toast?.tone, 'danger');
  assert.match(renderCard(alphaLoc), /data-action="sync-installed-plugin"/);

  // Scenario 5: When a newer version IS available -> clickable direct update button renders; after updating to latest, transitions immediately to .state-pill.is-latest
  const alphaV12Upd = {
    id: 'alice__alpha-plug',
    dir: 'alpha-plug',
    installedVersion: '1.0.0',
    latestVersion: '1.2.0',
    installable: true,
    source: 'github-release',
    updateChannel: 'github-upstream',
    targetRef: 'v1.2.0',
    repositoryUrl: 'https://github.com/alice/alpha-plug',
  };
  ui.state.updates = {
    loading: false,
    checkedAt: '2026-11-24T14:35:00Z',
    items: [alphaV12Upd],
    selfUpdate: null,
    rateLimited: false,
    warnings: [],
    error: '',
  };
  ui.state.verifiedLatestDirs.clear();
  assert.equal(ui.isPluginConfirmedLatest(alphaLoc, alphaV12Upd), false);
  const availHtml = renderCard(alphaLoc);
  assert.match(availHtml, /data-action="update-plugin-direct"/);
  assert.match(availHtml, /更新 v1\.2\.0/);
  assert.doesNotMatch(availHtml, /state-pill is-latest/);

  fetchCalls.length = 0;
  mockFetchHandler = async (url) => {
    if (url === '/api/update') {
      return jsonResp({
        ok: true,
        installedDir: 'alpha-plug',
        version: '1.2.0',
        restartRequired: false,
        state: makeServerState('zh', '1.2.0'),
      });
    }
    if (url.startsWith('/api/updates')) {
      return jsonResp({ ok: true, checkedAt: '2026-11-24T14:36:00Z', items: [], selfUpdate: null, rateLimited: false });
    }
    return jsonResp({ ok: true });
  };
  await ui.triggerDirectPluginUpdate({
    id: 'alice__alpha-plug',
    dir: 'alpha-plug',
    displayName: 'Alpha Plug',
    source: 'github-release',
    updateChannel: 'github-upstream',
    targetRef: 'v1.2.0',
    repositoryUrl: 'https://github.com/alice/alpha-plug',
    preferUpstream: true,
  });
  assert.equal(fetchCalls.filter((c) => c.url === '/api/update' && c.method === 'POST').length, 1);
  assert.equal(ui.state.verifiedLatestDirs.has('alpha-plug'), true);
  assert.equal(ui.state.updates.items.length, 0);
  const postUpdHtml = renderCard({ ...alphaLoc, version: '1.2.0' });
  assert.match(postUpdHtml, /<span class="state-pill is-latest"[^>]*>[\s\S]*?<span>最新<\/span><\/span>/);
  assert.doesNotMatch(postUpdHtml, /data-action="update-plugin-direct"/);
  assert.doesNotMatch(postUpdHtml, /data-action="sync-installed-plugin"/);

  // Scenario 6: Manual top-bar force checkUpdates(true) clears verifiedLatestDirs and restores clickable button if a newer version v2.0.0 is published
  mockFetchHandler = async (url) => {
    if (url.startsWith('/api/updates?force=1')) {
      return jsonResp({
        ok: true,
        checkedAt: '2026-11-24T14:40:00Z',
        items: [
          {
            id: 'alice__alpha-plug',
            dir: 'alpha-plug',
            installedVersion: '1.2.0',
            latestVersion: '2.0.0',
            installable: true,
            source: 'github-release',
            updateChannel: 'github-upstream',
            targetRef: 'v2.0.0',
            repositoryUrl: 'https://github.com/alice/alpha-plug',
          },
        ],
        selfUpdate: null,
        rateLimited: false,
      });
    }
    return jsonResp({ ok: true });
  };
  await ui.checkUpdates(true, { silent: true });
  assert.equal(ui.state.verifiedLatestDirs.has('alpha-plug'), false);
  const recheckHtml = renderCard({ ...alphaLoc, version: '1.2.0' });
  assert.match(recheckHtml, /data-action="update-plugin-direct"/);
  assert.match(recheckHtml, /更新 v2\.0\.0/);
  assert.doesNotMatch(recheckHtml, /state-pill is-latest/);

  // Scenario 7: Single-plugin sync when a newer version v2.1.0 IS found -> delegates to POST /api/update and immediately transitions to .state-pill.is-latest
  ui.state.updates = { loading: false, checkedAt: '', items: [], selfUpdate: null, rateLimited: false, warnings: [], error: '' };
  ui.state.verifiedLatestDirs.clear();
  fetchCalls.length = 0;
  let syncUpdated = false;
  mockFetchHandler = async (url) => {
    if (url.startsWith('/api/updates')) {
      return jsonResp({
        ok: true,
        checkedAt: '2026-11-24T14:45:00Z',
        items: syncUpdated
          ? []
          : [
              {
                id: 'alice__alpha-plug',
                dir: 'alpha-plug',
                installedVersion: '1.2.0',
                latestVersion: '2.1.0',
                installable: true,
                source: 'github-release',
                updateChannel: 'github-upstream',
                targetRef: 'v2.1.0',
                repositoryUrl: 'https://github.com/alice/alpha-plug',
              },
            ],
        selfUpdate: null,
        rateLimited: false,
      });
    }
    if (url === '/api/update') {
      syncUpdated = true;
      return jsonResp({
        ok: true,
        installedDir: 'alpha-plug',
        version: '2.1.0',
        restartRequired: false,
        state: makeServerState('zh', '2.1.0'),
      });
    }
    return jsonResp({ ok: true });
  };
  await ui.triggerSyncInstalledPlugin({ dir: 'alpha-plug', id: 'alice__alpha-plug', displayName: 'Alpha Plug' });
  assert.equal(fetchCalls.filter((c) => c.url === '/api/update' && c.method === 'POST').length, 1);
  assert.equal(ui.state.verifiedLatestDirs.has('alpha-plug'), true);
  const afterSyncUpdHtml = renderCard({ ...alphaLoc, version: '2.1.0' });
  assert.match(afterSyncUpdHtml, /<span class="state-pill is-latest"[^>]*>[\s\S]*?<span>最新<\/span><\/span>/);
  assert.doesNotMatch(afterSyncUpdHtml, /data-action="update-plugin-direct"/);
  assert.doesNotMatch(afterSyncUpdHtml, /data-action="sync-installed-plugin"/);
});
