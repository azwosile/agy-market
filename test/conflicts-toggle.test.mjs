import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
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

const { classifyActivationRequirement } = await import(
  pathToFileURL(join(REPO_ROOT, 'src', 'shared', 'activation.mjs')).href
);
const { resolveInstallPreflight, scanLocalPluginInventory } = await import(
  pathToFileURL(join(REPO_ROOT, 'src', 'preflight', 'index.mjs')).href
);
const { scanLocalConflicts } = await import(
  pathToFileURL(join(REPO_ROOT, 'src', 'preflight', 'conflicts.mjs')).href
);
const { fixLocalConflict, installOrUpdateCatalogPlugin, toggleInstalledPlugin } = await import(
  pathToFileURL(join(REPO_ROOT, 'src', 'installer', 'index.mjs')).href
);
const { sweepRetiredBinaries } = await import(
  pathToFileURL(join(REPO_ROOT, 'src', 'installer', 'sync-dir.mjs')).href
);
const { createDeterministicTarGz } = await import(
  pathToFileURL(join(REPO_ROOT, 'src', 'installer', 'tar-extract.mjs')).href
);
const { createMarketSidecarServer } = await import(
  pathToFileURL(join(REPO_ROOT, 'src', 'sidecar', 'server.mjs')).href
);

const CLEAN_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><rect x="16" y="16" width="96" height="96" rx="20" fill="#6366f1"/></svg>';
const ASAR_TOKEN = `${'app'}.${'asar'}`;
const CDP_FLAG = `${'--remote-'}debugging-port=9339`;

function makeTempWorkspace(prefix = 'agy-v12-test-') {
  const baseTmp = process.env.AGY_MARKET_TEST_TMPDIR || tmpdir();
  mkdirSync(baseTmp, { recursive: true });
  const root = mkdtempSync(join(baseTmp, prefix));
  const configDir = join(root, 'config');
  const pluginsDir = join(configDir, 'plugins');
  const dataDir = join(root, 'sidecar_data');
  const artifactsDir = join(root, 'artifacts');
  const workspaceDir = join(root, 'workspace');
  mkdirSync(pluginsDir, { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(artifactsDir, { recursive: true });
  mkdirSync(workspaceDir, { recursive: true });
  return {
    root,
    configDir,
    pluginsDir,
    dataDir,
    artifactsDir,
    workspaceDir,
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
  };
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
  hostEnhancementKind = [],
  mcpServers = [],
  hookEvents = [],
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
      stars: 88,
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
      mcpServers,
      mcpRemoteDomains: [],
      hookEvents,
      hostEnhancementKind,
    },
    updatedAt: '2026-11-24T00:00:00Z',
  };
}

test('classifyActivationRequirement maps instant, reload-pane, and host-restart with specific zh/en reasons', () => {
  // 1. Declarative-only & global-rules -> instant
  const decl = classifyActivationRequirement({ badges: ['declarative-only'] });
  assert.equal(decl.level, 'instant');
  assert.equal(decl.badgeZh, '⚡ 免重启 · 即刻生效');
  assert.ok(decl.reasonZh.length > 0 && decl.reasonEn.length > 0);

  const rules = classifyActivationRequirement({ badges: ['global-rules'] });
  assert.equal(rules.level, 'instant');
  assert.equal(rules.badgeZh, '⚡ 免重启 · 即刻生效');

  // 2. sidecar-ui / mcp-stdio / mcp-remote / lifecycle-hooks -> reload-pane
  for (const badge of ['sidecar-ui', 'mcp-stdio', 'mcp-remote', 'lifecycle-hooks']) {
    const res = classifyActivationRequirement({ badges: [badge] });
    assert.equal(res.level, 'reload-pane', `Badge ${badge} should classify as reload-pane`);
    assert.ok(res.badgeZh.includes('重开面板'));
  }

  // 3. app-asar -> host-restart with specific reason
  const asar = classifyActivationRequirement({ badges: ['host-enhancement'], hostEnhancementKind: ['app-asar'] });
  assert.equal(asar.level, 'host-restart');
  assert.match(asar.reasonZh, new RegExp(ASAR_TOKEN.replace('.', '\\.')));
  assert.match(asar.reasonEn, new RegExp(ASAR_TOKEN.replace('.', '\\.')));

  const disabledPatch = classifyActivationRequirement({ hostEnhancementKind: ['app-asar'] }, { action: 'disable' });
  assert.equal(disabledPatch.level, 'host-restart');
  assert.equal(Boolean(disabledPatch.requiresPatchScript), false);
  assert.match(disabledPatch.reasonEn, /undo the patch/);

  // 4. cdp -> host-restart with specific reason
  const cdp = classifyActivationRequirement({ badges: ['host-enhancement'], hostEnhancementKind: ['cdp'] });
  assert.equal(cdp.level, 'host-restart');
  assert.match(cdp.reasonZh, /CDP/);
  assert.match(cdp.reasonEn, /CDP/);

  // 5. lockedOnDisable / retiredBinaries -> host-restart
  const locked = classifyActivationRequirement({ badges: ['declarative-only'] }, { lockedOnDisable: true });
  assert.equal(locked.level, 'host-restart');
  assert.match(locked.reasonZh, /句柄/);

  const retired = classifyActivationRequirement(
    { badges: ['sidecar-ui'] },
    { retiredBinaries: ['C:\\plugins\\foo\\bin\\tool.exe.old.1700000000000'] },
  );
  assert.equal(retired.level, 'host-restart');
  assert.match(retired.reasonZh, /重启/);
});

test('POST /api/toggle-plugin parks/unparks safely without touching config.json, locks self & host-disabled, and keeps parked plugins updated in place', async () => {
  const ws = makeTempWorkspace('agy-toggle-park-');
  try {
    const v1Tar = buildTarArtifact(ws.artifactsDir, 'demo-1.0.0.tar.gz', {
      'plugin.json': JSON.stringify({
        name: 'demo-plug',
        displayName: 'Demo Plug',
        description: 'Demo plugin v1',
        version: '1.0.0',
        logo: 'assets/logo.svg',
      }),
      'assets/logo.svg': CLEAN_SVG,
      'skills/demo-skill/SKILL.md': '---\nname: demo-skill\n---\nHello v1',
    });

    const v2Tar = buildTarArtifact(ws.artifactsDir, 'demo-2.0.0.tar.gz', {
      'plugin.json': JSON.stringify({
        name: 'demo-plug',
        displayName: 'Demo Plug',
        description: 'Demo plugin v2',
        version: '2.0.0',
        logo: 'assets/logo.svg',
      }),
      'assets/logo.svg': CLEAN_SVG,
      'skills/demo-skill/SKILL.md': '---\nname: demo-skill\n---\nHello v2',
    });

    // Install agy-market (self), host-disabled plugin, workspace plugin, and CDP plugin
    writePluginTree(ws.pluginsDir, 'agy-market', {
      'plugin.json': { name: 'agy-market', displayName: 'AGY Market', version: '1.2.0' },
      'sidecars/market_pane/sidecar.json': {
        command: 'node',
        args: ['main.mjs'],
        has_web_ui: true,
        ui_config: { views: [{ path: '/', entrypoint: 'SIDECAR_UI_ENTRYPOINT_AUX_PANE', title: 'AGY Market' }] },
      },
    });
    writePluginTree(ws.pluginsDir, 'host-off-plug', {
      'plugin.json': { name: 'host-off-plug', displayName: 'Host Off Plug', version: '1.0.0' },
    });
    writePluginTree(ws.pluginsDir, 'prism-cdp', {
      'plugin.json': { name: 'prism-cdp', displayName: 'Prism CDP', version: '1.0.0' },
      'host/bridge.mjs': `export const flag = '${CDP_FLAG}';\n`,
    });
    writePluginTree(join(ws.workspaceDir, '.agents', 'plugins'), 'ws-only-plug', {
      'plugin.json': { name: 'ws-only-plug', displayName: 'Workspace Plug', version: '1.0.0' },
    });

    // Host config.json marks host-off-plug disabled (read-only redline!)
    const cfgPath = join(ws.configDir, 'config.json');
    const initialCfgContent = JSON.stringify({ plugins: { 'host-off-plug': { enabled: false } } }, null, 2);
    writeFileSync(cfgPath, initialCfgContent, 'utf8');

    let catalogVersionToServe = '1.0.0';
    const makeCatalog = () => ({
      schemaVersion: 1,
      track: 'verified',
      catalogVersion: '2026.1124.1',
      plugins: [
        makeCatalogPlugin({
          id: 'alice__demo-plug',
          canonicalName: 'demo-plug',
          owner: 'alice',
          repo: 'demo-plug',
          displayName: 'Demo Plug',
          version: catalogVersionToServe,
          repoId: 701,
          tarballUrl: catalogVersionToServe === '2.0.0' ? v2Tar.url : v1Tar.url,
          sha256: catalogVersionToServe === '2.0.0' ? v2Tar.sha256 : v1Tar.sha256,
        }),
      ],
    });

    // Install demo-plug v1.0.0 first
    const initInstall = await installOrUpdateCatalogPlugin({
      plugin: makeCatalog().plugins[0],
      configDir: ws.configDir,
      dataDir: ws.dataDir,
    });
    assert.equal(initInstall.ok, true);
    assert.equal(initInstall.activation.level, 'instant');
    assert.equal(initInstall.restartRequired, false);

    const srv = await createMarketSidecarServer({
      listen: false,
      configDir: ws.configDir,
      dataDir: ws.dataDir,
      recoveryDelayMs: -1,
      fetchImpl: async (url) => {
        if (String(url).endsWith('/index.json')) {
          return new Response(JSON.stringify(makeCatalog()), { status: 200 });
        }
        return new Response('{}', { status: 404 });
      },
    });

    try {
      const wsUri = pathToFileURL(ws.workspaceDir).href;
      const st1 = (await srv.inject({ method: 'GET', url: `/api/state?workspaceUris=${encodeURIComponent(wsUri)}` })).json();
      assert.ok(st1.conflictsSummary && typeof st1.conflictsSummary.total === 'number');

      const byDir = new Map(st1.installed.map((x) => [x.dir, x]));
      assert.equal(byDir.get('agy-market').canToggle, false);
      assert.equal(byDir.get('agy-market').toggleDisabledReason, 'self');
      assert.equal(byDir.get('host-off-plug').canToggle, false);
      assert.equal(byDir.get('host-off-plug').hostDisabled, true);
      assert.equal(byDir.get('host-off-plug').toggleDisabledReason, 'host-disabled');
      assert.equal(byDir.get('ws-only-plug').canToggle, false);
      assert.equal(byDir.get('ws-only-plug').toggleDisabledReason, 'workspace');
      assert.equal(byDir.get('demo-plug').canToggle, true);
      assert.equal(byDir.get('demo-plug').toggleDisabledReason, '');
      assert.equal(byDir.get('demo-plug').activation.level, 'instant');
      assert.equal(byDir.get('prism-cdp').activation.level, 'host-restart');

      // CSRF guard on POST /api/toggle-plugin
      const noTok = await srv.inject({
        method: 'POST',
        url: '/api/toggle-plugin',
        body: { dir: 'demo-plug', enabled: false },
      });
      assert.equal(noTok.statusCode, 403);
      assert.match(noTok.json().error, /ERR_CSRF_TOKEN/);

      // Self disable blocked
      const selfToggle = await srv.inject({
        method: 'POST',
        url: '/api/toggle-plugin',
        headers: { 'X-Sidecar-Token': srv.sideToken, Origin: 'http://127.0.0.1:43210' },
        body: { dir: 'agy-market', enabled: false },
      });
      assert.equal(selfToggle.statusCode, 400);
      assert.match(selfToggle.json().error, /ERR_CANNOT_DISABLE_SELF/);

      // Host-disabled toggle blocked
      const hostOffToggle = await srv.inject({
        method: 'POST',
        url: '/api/toggle-plugin',
        headers: { 'X-Sidecar-Token': srv.sideToken, Origin: 'http://127.0.0.1:43210' },
        body: { dir: 'host-off-plug', enabled: true },
      });
      assert.equal(hostOffToggle.statusCode, 400);
      assert.match(hostOffToggle.json().error, /ERR_HOST_DISABLED/);

      // Disable (park) demo-plug -> moves to disabled-plugins/demo-plug
      const parkRes = await srv.inject({
        method: 'POST',
        url: '/api/toggle-plugin',
        headers: { 'X-Sidecar-Token': srv.sideToken, Origin: 'http://127.0.0.1:43210' },
        body: { dir: 'demo-plug', enabled: false },
      });
      assert.equal(parkRes.statusCode, 200);
      const parkJson = parkRes.json();
      assert.equal(parkJson.ok, true);
      assert.equal(parkJson.enabled, false);
      assert.equal(parkJson.parkedByMarket, true);
      assert.equal(parkJson.restartRequired, false);
      assert.equal(existsSync(join(ws.pluginsDir, 'demo-plug')), false);
      assert.equal(existsSync(join(ws.dataDir, 'disabled-plugins', 'demo-plug', 'plugin.json')), true);

      const demoInState = parkJson.state.installed.find((x) => x.dir === 'demo-plug');
      assert.equal(demoInState.enabled, false);
      assert.equal(demoInState.parkedByMarket, true);
      assert.equal(demoInState.canToggle, true);
      const demoCat = parkJson.state.catalog.plugins.find((p) => p.id === 'alice__demo-plug');
      assert.equal(demoCat.installStatus.installed, true);
      assert.equal(demoCat.installStatus.enabled, false);
      assert.equal(demoCat.installStatus.parkedByMarket, true);
      assert.equal(demoCat.installStatus.canToggle, true);

      // Disable CDP plugin -> restartRequired === true & host-restart
      const cdpPark = await srv.inject({
        method: 'POST',
        url: '/api/toggle-plugin',
        headers: { 'X-Sidecar-Token': srv.sideToken, Origin: 'http://127.0.0.1:43210' },
        body: { dir: 'prism-cdp', enabled: false },
      });
      assert.equal(cdpPark.statusCode, 200);
      assert.equal(cdpPark.json().restartRequired, true);
      assert.equal(cdpPark.json().activation.level, 'host-restart');

      // Update demo-plug from v1.0.0 -> v2.0.0 WHILE PARKED!
      catalogVersionToServe = '2.0.0';
      await srv.inject({
        method: 'POST',
        url: '/api/catalog/refresh',
        headers: { 'X-Sidecar-Token': srv.sideToken, Origin: 'http://127.0.0.1:43210' },
        body: {},
      });

      // Preflight must recognize parked plugin with currentlyParked: true
      const invParked = scanLocalPluginInventory({ configDir: ws.configDir, dataDir: ws.dataDir });
      const pf = resolveInstallPreflight(makeCatalog().plugins[0], invParked);
      assert.equal(pf.action, 'update');
      assert.equal(pf.existingInstall.currentlyParked, true);

      // /api/updates must still detect updates for parked plugins!
      const updRes = await srv.inject({ method: 'GET', url: '/api/updates?force=1' });
      assert.equal(updRes.statusCode, 200);
      const demoUpd = updRes.json().items.find((x) => x.id === 'alice__demo-plug');
      assert.ok(demoUpd);
      assert.equal(demoUpd.latestVersion, '2.0.0');

      // Run POST /api/update while parked -> stays parked in disabled-plugins/demo-plug at v2.0.0!
      const updWhileParked = await srv.inject({
        method: 'POST',
        url: '/api/update',
        headers: { 'X-Sidecar-Token': srv.sideToken, Origin: 'http://127.0.0.1:43210' },
        body: { id: 'alice__demo-plug' },
      });
      assert.equal(updWhileParked.statusCode, 200);
      const uJson = updWhileParked.json();
      assert.equal(uJson.ok, true);
      assert.equal(uJson.version, '2.0.0');
      assert.equal(uJson.parkedByMarket, true);
      assert.equal(existsSync(join(ws.pluginsDir, 'demo-plug')), false, 'Updating a parked plugin must NOT activate it');
      const parkedManifest = JSON.parse(
        readFileSync(join(ws.dataDir, 'disabled-plugins', 'demo-plug', 'plugin.json'), 'utf8'),
      );
      assert.equal(parkedManifest.version, '2.0.0');

      // Inject `"disabled": true` into parked plugin.json, then unpark -> must strip disabled: true!
      parkedManifest.disabled = true;
      writeFileSync(
        join(ws.dataDir, 'disabled-plugins', 'demo-plug', 'plugin.json'),
        JSON.stringify(parkedManifest, null, 2),
      );

      const unparkRes = await srv.inject({
        method: 'POST',
        url: '/api/toggle-plugin',
        headers: { 'X-Sidecar-Token': srv.sideToken, Origin: 'http://127.0.0.1:43210' },
        body: { dir: 'demo-plug', enabled: true },
      });
      assert.equal(unparkRes.statusCode, 200);
      assert.equal(unparkRes.json().enabled, true);
      assert.equal(unparkRes.json().parkedByMarket, false);
      assert.equal(existsSync(join(ws.dataDir, 'disabled-plugins', 'demo-plug')), false);
      assert.equal(existsSync(join(ws.pluginsDir, 'demo-plug', 'plugin.json')), true);
      assert.equal(lstatSync(join(ws.pluginsDir, 'demo-plug')).isSymbolicLink(), false);
      const activeManifest = JSON.parse(readFileSync(join(ws.pluginsDir, 'demo-plug', 'plugin.json'), 'utf8'));
      assert.equal(activeManifest.version, '2.0.0');
      assert.equal('disabled' in activeManifest, false, 'Unparking must strip disabled:true from plugin.json');

      // config.json MUST remain byte-identical (never modified!)
      assert.equal(readFileSync(cfgPath, 'utf8'), initialCfgContent);
    } finally {
      await srv.close();
    }
  } finally {
    ws.cleanup();
  }
});

test('failed cross-volume unpark leaves the vault intact and can be retried', () => {
  const ws = makeTempWorkspace('agy-cross-volume-enable-');
  // In the Linux test VM the checkout and the temporary workspace are distinct mounts.
  const secondVolume = lstatSync(ws.root).dev !== lstatSync(REPO_ROOT).dev
    ? mkdtempSync(join(REPO_ROOT, '.unpark-test-')) : null;
  try {
    const dataDir = secondVolume || ws.dataDir;
    const options = { dir: 'reader', configDir: ws.configDir, dataDir };
    writePluginTree(ws.pluginsDir, 'reader', { 'plugin.json': { name: 'reader', version: '1.0.0' }, 'notes.txt': 'original' });
    toggleInstalledPlugin({ ...options, enabled: false });
    const parked = join(dataDir, 'disabled-plugins', 'reader');
    const active = join(ws.pluginsDir, 'reader');
    const link = join(parked, 'local-workspace');
    symlinkSync(ws.pluginsDir, link, 'junction');
    const restore = () => toggleInstalledPlugin({ ...options, enabled: true,
      renameOverride() { throw Object.assign(new Error('separate volumes'), { code: 'EXDEV' }); },
    });
    assert.throws(restore, /ERR_PLUGIN_LAYOUT_CONFLICT/);
    assert.equal(existsSync(join(active, 'plugin.json')), false);
    assert.equal(readFileSync(join(parked, 'notes.txt'), 'utf8'), 'original');
    unlinkSync(link);
    assert.equal(restore().enabled, true);
    assert.equal(readFileSync(join(active, 'notes.txt'), 'utf8'), 'original');
    assert.equal(existsSync(parked), false);
  } finally {
    if (secondVolume) rmSync(secondVolume, { recursive: true, force: true });
    ws.cleanup();
  }
});

test('Windows EBUSY lock on disable falls back to copy + lock-safe cleanup, marks restartRequired, and re-enables cleanly', () => {
  const ws = makeTempWorkspace('agy-ebusy-disable-');
  try {
    writePluginTree(ws.pluginsDir, 'busy-mcp', {
      'plugin.json': { name: 'busy-mcp', displayName: 'Busy MCP', version: '1.0.0' },
      'mcp_config.json': { mcpServers: { worker: { command: 'bin/worker.exe' } } },
      'bin/worker.exe': Buffer.from('MZ_LOCKED_BINARY'),
    });

    const lockedBinPath = join(ws.pluginsDir, 'busy-mcp', 'bin', 'worker.exe');

    const linked = join(ws.pluginsDir, 'busy-mcp', 'user-files');
    symlinkSync(ws.dataDir, linked, 'junction');
    assert.throws(() => toggleInstalledPlugin({
      dir: 'busy-mcp', enabled: false, configDir: ws.configDir, dataDir: ws.dataDir,
      renameOverride() { throw Object.assign(new Error('locked'), { code: 'EBUSY' }); },
    }), /ERR_PLUGIN_LAYOUT_CONFLICT/);
    assert.ok(lstatSync(linked).isSymbolicLink());
    assert.equal(existsSync(join(ws.dataDir, 'disabled-plugins', 'busy-mcp')), false);
    assert.deepEqual(readdirSync(join(ws.dataDir, 'staging')), []);
    unlinkSync(linked);

    const disableRes = toggleInstalledPlugin({
      dir: 'busy-mcp',
      enabled: false,
      configDir: ws.configDir,
      dataDir: ws.dataDir,
      nowMs: 1732400000000,
      renameOverride() {
        const err = new Error('EBUSY: resource busy or locked');
        err.code = 'EBUSY';
        throw err;
      },
      rmOverride() {
        const err = new Error('EBUSY: directory handle held');
        err.code = 'EBUSY';
        throw err;
      },
      unlinkOverride(targetPath) {
        if (resolve(targetPath) === resolve(lockedBinPath)) {
          const err = new Error('EBUSY: binary file locked');
          err.code = 'EBUSY';
          throw err;
        }
        unlinkSync(targetPath);
      },
    });

    assert.equal(disableRes.ok, true);
    assert.equal(disableRes.enabled, false);
    assert.equal(disableRes.parkedByMarket, true);
    assert.equal(disableRes.lockedOnDisable, true);
    assert.equal(disableRes.restartRequired, true);
    assert.equal(disableRes.activation.level, 'host-restart');
    assert.match(disableRes.activation.reasonZh, /句柄/);
    assert.equal(disableRes.retiredBinaries.length, 1);

    // Parked copy must be complete and intact
    assert.equal(existsSync(join(ws.dataDir, 'disabled-plugins', 'busy-mcp', 'plugin.json')), true);
    assert.equal(existsSync(join(ws.dataDir, 'disabled-plugins', 'busy-mcp', 'bin', 'worker.exe')), true);
    // Active dir must have plugin.json removed so host unloads it, while locked binary was retired to .old.<ts>
    assert.equal(existsSync(join(ws.pluginsDir, 'busy-mcp', 'plugin.json')), false);
    assert.equal(existsSync(`${lockedBinPath}.old.1732400000000`), true);

    // Inventory must show ONLY the parked entry (not duplicated!)
    const inv = scanLocalPluginInventory({ configDir: ws.configDir, dataDir: ws.dataDir });
    const matches = inv.installed.filter((x) => x.dir === 'busy-mcp');
    assert.equal(matches.length, 1);
    assert.equal(matches[0].parkedByMarket, true);
    assert.equal(matches[0].enabled, false);

    // Re-enabling while leftover locked active dir still exists must sync back cleanly!
    const enableRes = toggleInstalledPlugin({
      dir: 'busy-mcp',
      enabled: true,
      configDir: ws.configDir,
      dataDir: ws.dataDir,
    });
    assert.equal(enableRes.ok, true);
    assert.equal(enableRes.enabled, true);
    assert.equal(enableRes.parkedByMarket, false);
    assert.equal(existsSync(join(ws.pluginsDir, 'busy-mcp', 'plugin.json')), true);
    assert.equal(existsSync(join(ws.pluginsDir, 'busy-mcp', 'bin', 'worker.exe')), true);

    // Sweeping retired binaries cleans up the .old.<ts> artifact once handle releases
    const gc = sweepRetiredBinaries(ws.dataDir);
    assert.equal(gc.remaining, 0);
    assert.equal(existsSync(`${lockedBinPath}.old.1732400000000`), false);
  } finally {
    ws.cleanup();
  }
});

test('a manifest lock rejects disable before deleting files and permits retry after release', () => {
  const ws = makeTempWorkspace('agy-manifest-lock-');
  try {
    writePluginTree(ws.pluginsDir, 'worker', {
      'plugin.json': { name: 'worker', version: '1.0.0' },
      'notes.md': 'local work',
    });
    const options = { dir: 'worker', enabled: false, configDir: ws.configDir, dataDir: ws.dataDir };
    const busy = () => { throw Object.assign(new Error('deny delete'), { code: 'EBUSY' }); };
    assert.throws(() => toggleInstalledPlugin({ ...options, renameOverride: busy, unlinkOverride: busy }),
      /ERR_PLUGIN_DISABLE_FAILED/);
    const active = join(ws.pluginsDir, 'worker');
    assert.ok(existsSync(join(active, 'plugin.json')));
    assert.equal(readFileSync(join(active, 'notes.md'), 'utf8'), 'local work');
    const parked = join(ws.dataDir, 'disabled-plugins', 'worker');
    assert.equal(existsSync(parked), false);
    assert.ok(toggleInstalledPlugin(options).parkedByMarket);
    assert.equal(existsSync(active), false);
    assert.equal(readFileSync(join(parked, 'notes.md'), 'utf8'), 'local work');
  } finally { ws.cleanup(); }
});

test('5-layer GET /api/conflicts detects all conflict classes and POST /api/fix-conflict remediates isolate-rename & materialize-symlink', async () => {
  const ws = makeTempWorkspace('agy-conflicts-');
  try {
    // Layer 1: duplicate-plugin-name (`shared-tool` in both workspace and global)
    writePluginTree(join(ws.workspaceDir, '.agents', 'plugins'), 'shared-tool', {
      'plugin.json': { name: 'shared-tool', displayName: 'Shared Tool (WS)', version: '1.0.0' },
    });
    writePluginTree(ws.pluginsDir, 'shared-tool', {
      'plugin.json': {
        name: 'shared-tool',
        displayName: 'Shared Tool (Global)',
        version: '1.0.0',
        repository: 'https://github.com/alice/shared-tool',
      },
      'skills/shared-helper/SKILL.md':
        '---\nname: shared-helper\n---\nOpen [Manage](customization://shared-tool) and [Pane](sidecar://shared-tool/main/)',
    });

    // Layer 2: windows-symlink-ignored (real NTFS junction on win32 / dir symlink on POSIX;
    // falls back to deterministic linkInfoOverride when running inside a symlink-restricted Windows sandbox)
    const externalSource = writePluginTree(ws.artifactsDir, 'external-dev-plugin', {
      'plugin.json': { name: 'linked-plug', displayName: 'Linked Plug', version: '0.5.0' },
      'skills/linked-skill/SKILL.md': '---\nname: linked-skill\n---\nReal content stays intact',
    });
    const symlinkTargetPath = join(ws.pluginsDir, 'linked-plug');
    let simulatedJunctionActive = false;
    try {
      symlinkSync(externalSource, symlinkTargetPath, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (err) {
      if (err?.code === 'EPERM' || err?.code === 'EACCES') {
        simulatedJunctionActive = true;
        writePluginTree(ws.pluginsDir, 'linked-plug', {
          'plugin.json': { name: 'linked-plug', displayName: 'Linked Plug', version: '0.5.0' },
        });
      } else {
        throw err;
      }
    }

    // Layer 3: mcp-collision (user exact collision + generic bare key + duplicate <plugin>_<server>)
    writeFileSync(
      join(ws.configDir, 'mcp_config.json'),
      JSON.stringify({ mcpServers: { 'mcp-plug-a_search': { command: 'node' } } }, null, 2),
      'utf8',
    );
    writePluginTree(ws.pluginsDir, 'mcp-plug-a', {
      'plugin.json': { name: 'mcp-plug-a', displayName: 'MCP A', version: '1.0.0' },
      'mcp_config.json': { mcpServers: { search: { command: 'node', args: ['a.mjs'] } } },
    });
    writePluginTree(ws.pluginsDir, 'mcp-plug-b', {
      'plugin.json': { name: 'mcp-plug-a', displayName: 'MCP B Dup', version: '1.0.0' },
      'mcp_config.json': { mcpServers: { search: { command: 'node', args: ['b.mjs'] } } },
    });

    // Layer 4: skill-shadowing (against user global skill + builtin skill) & agent-shadowing (against builtin `research`)
    mkdirSync(join(ws.configDir, 'skills', 'dup-skill'), { recursive: true });
    writeFileSync(
      join(ws.configDir, 'skills', 'dup-skill', 'SKILL.md'),
      '---\nname: dup-skill\n---\nUser global skill',
      'utf8',
    );
    writePluginTree(ws.pluginsDir, 'shadow-pack', {
      'plugin.json': { name: 'shadow-pack', displayName: 'Shadow Pack', version: '1.0.0' },
      'skills/dup-skill/SKILL.md': '---\nname: dup-skill\n---\nPlugin skill',
      'skills/plugin/SKILL.md': '---\nname: plugin\n---\nOverrides builtin plugin skill',
      'agents/research.md': '---\nname: research\n---\nOverrides builtin research agent',
    });

    // Layer 5: host-enhancement-overlap (2 CDP plugins + 2 app-asar plugins)
    writePluginTree(ws.pluginsDir, 'agy-plugin-wallpaper-engine', {
      'plugin.json': { name: 'agy-plugin-wallpaper-engine', displayName: 'Legacy Wallpaper', version: '0.9.0' },
      'cdp.mjs': `const arg = '${CDP_FLAG}';\n`,
    });
    writePluginTree(ws.pluginsDir, 'agy-wallpaper-prism', {
      'plugin.json': { name: 'agy-wallpaper-prism', displayName: 'Wallpaper Prism', version: '2.0.0' },
      'bridge.mjs': `const arg = '${CDP_FLAG}';\n`,
    });
    writePluginTree(ws.pluginsDir, 'asar-patcher-one', {
      'plugin.json': { name: 'asar-patcher-one', displayName: 'Asar One', version: '1.0.0' },
      'patch.mjs': `const target = '${ASAR_TOKEN}';\n`,
    });
    writePluginTree(ws.pluginsDir, 'asar-patcher-two', {
      'plugin.json': { name: 'asar-patcher-two', displayName: 'Asar Two', version: '1.0.0' },
      'patch.mjs': `const target = '${ASAR_TOKEN}';\n`,
    });

    // Healthy clean plugin
    writePluginTree(ws.pluginsDir, 'pure-clean-plug', {
      'plugin.json': { name: 'pure-clean-plug', displayName: 'Pure Clean', version: '1.0.0' },
      'skills/unique-clean/SKILL.md': '---\nname: unique-clean\n---\nZero conflicts',
    });

    const srv = await createMarketSidecarServer({
      listen: false,
      configDir: ws.configDir,
      dataDir: ws.dataDir,
      recoveryDelayMs: -1,
      ...(simulatedJunctionActive
        ? {
            linkInfoOverride(parentDir, dirName) {
              if (resolve(parentDir) === resolve(ws.pluginsDir) && dirName === 'linked-plug' && simulatedJunctionActive) {
                return { isSymlink: true, realPath: externalSource, lstat: lstatSync(symlinkTargetPath) };
              }
              return null;
            },
            unlinkLinkOverride(linkPath) {
              if (resolve(linkPath) === resolve(symlinkTargetPath)) {
                simulatedJunctionActive = false;
                rmSync(linkPath, { recursive: true, force: true });
              }
            },
          }
        : {}),
      fetchImpl: async () => new Response(JSON.stringify({ schemaVersion: 1, plugins: [] }), { status: 200 }),
    });

    try {
      const wsUri = pathToFileURL(ws.workspaceDir).href;
      const confRes = await srv.inject({
        method: 'GET',
        url: `/api/conflicts?workspaceUris=${encodeURIComponent(wsUri)}`,
      });
      assert.equal(confRes.statusCode, 200);
      const report = confRes.json();
      assert.equal(report.ok, true);
      assert.ok(report.summary.critical >= (process.platform === 'win32' ? 3 : 2));
      assert.ok(report.summary.warning >= 4);
      assert.ok(report.summary.info >= 1);
      assert.equal(report.summary.total, report.items.length);
      assert.ok(report.summary.healthyCount >= 1);

      // Verify all 5 layers present
      const dupShared = report.items.find((i) => i.id === 'duplicate-plugin-name:shared-tool');
      assert.ok(dupShared);
      assert.equal(dupShared.severity, 'critical');
      assert.equal(dupShared.winner.scope, 'workspace');
      assert.equal(dupShared.shadowed[0].scope, 'global');
      assert.equal(dupShared.fixAction.type, 'isolate-rename');
      assert.equal(dupShared.fixAction.targetDir, 'shared-tool');
      assert.equal(dupShared.fixAction.suggestedDir, 'alice--shared-tool');

      const symlinkItem = report.items.find((i) => i.id === 'windows-symlink-ignored:linked-plug');
      if (process.platform === 'win32') {
        assert.ok(symlinkItem);
        assert.equal(symlinkItem.severity, 'critical');
        assert.equal(symlinkItem.fixAction.type, 'materialize-symlink');
        assert.equal(symlinkItem.fixAction.targetDir, 'linked-plug');
      } else assert.equal(symlinkItem, undefined);

      assert.ok(report.items.some((i) => i.type === 'mcp-collision' && i.severity === 'critical'));
      assert.ok(report.items.some((i) => i.type === 'mcp-collision' && i.severity === 'warning'));
      assert.ok(report.items.some((i) => i.id === 'skill-shadowing:dup-skill' && i.severity === 'warning'));
      assert.ok(report.items.some((i) => i.id === 'skill-shadowing:plugin' && i.severity === 'warning'));
      assert.ok(report.items.some((i) => i.id === 'agent-shadowing:research' && i.severity === 'warning'));
      assert.ok(report.items.some((i) => i.id === 'host-enhancement-overlap:app-asar' && i.severity === 'warning'));
      assert.ok(report.items.some((i) => i.id === 'host-enhancement-overlap:cdp' && i.severity === 'info'));

      // CSRF guard on POST /api/fix-conflict
      const unauthFix = await srv.inject({
        method: 'POST',
        url: '/api/fix-conflict',
        body: { type: 'materialize-symlink', targetDir: 'linked-plug' },
      });
      assert.equal(unauthFix.statusCode, 403);

      // 1-click fix #1: isolate-rename on `shared-tool`
      const fixIso = await srv.inject({
        method: 'POST',
        url: '/api/fix-conflict',
        headers: { 'X-Sidecar-Token': srv.sideToken, Origin: 'http://127.0.0.1:43210' },
        body: {
          type: 'isolate-rename',
          targetDir: 'shared-tool',
          suggestedDir: dupShared.fixAction.suggestedDir,
          workspaceUris: [wsUri],
        },
      });
      assert.equal(fixIso.statusCode, 200);
      const fixIsoJson = fixIso.json();
      assert.equal(fixIsoJson.ok, true);
      assert.equal(fixIsoJson.newDir, 'alice--shared-tool');
      assert.equal(existsSync(join(ws.pluginsDir, 'shared-tool')), false);
      assert.equal(existsSync(join(ws.pluginsDir, 'alice--shared-tool', 'plugin.json')), true);
      const rewrittenManifest = JSON.parse(
        readFileSync(join(ws.pluginsDir, 'alice--shared-tool', 'plugin.json'), 'utf8'),
      );
      assert.equal(rewrittenManifest.name, 'alice--shared-tool');
      const rewrittenSkill = readFileSync(
        join(ws.pluginsDir, 'alice--shared-tool', 'skills', 'shared-helper', 'SKILL.md'),
        'utf8',
      );
      assert.ok(rewrittenSkill.includes('customization://alice--shared-tool'));
      assert.ok(rewrittenSkill.includes('sidecar://alice--shared-tool/main/'));
      assert.equal(
        fixIsoJson.conflicts.items.some((i) => i.id === 'duplicate-plugin-name:shared-tool'),
        false,
        'duplicate-plugin-name:shared-tool must disappear after isolate-rename',
      );

      // 1-click fix #2: materialize-symlink on `linked-plug`
      const fixSym = await srv.inject({
        method: 'POST',
        url: '/api/fix-conflict',
        headers: { 'X-Sidecar-Token': srv.sideToken, Origin: 'http://127.0.0.1:43210' },
        body: {
          type: 'materialize-symlink',
          targetDir: 'linked-plug',
          workspaceUris: [wsUri],
        },
      });
      assert.equal(fixSym.statusCode, 200);
      const fixSymJson = fixSym.json();
      assert.equal(fixSymJson.ok, true);
      assert.equal(lstatSync(symlinkTargetPath).isSymbolicLink(), false, 'Must now be a real non-symlink dir');
      assert.equal(existsSync(join(symlinkTargetPath, 'plugin.json')), true);
      // Verify materialized real directory now contains dereferenced skill file from externalSource!
      assert.equal(existsSync(join(symlinkTargetPath, 'skills', 'linked-skill', 'SKILL.md')), true);
      // Original external target folder must remain 100% untouched!
      assert.equal(existsSync(join(externalSource, 'plugin.json')), true);
      assert.equal(existsSync(join(externalSource, 'skills', 'linked-skill', 'SKILL.md')), true);
      assert.equal(
        fixSymJson.conflicts.items.some((i) => i.id === 'windows-symlink-ignored:linked-plug'),
        false,
      );

      // Parking legacy CDP plugin must clear host-enhancement-overlap:cdp!
      await srv.inject({
        method: 'POST',
        url: '/api/toggle-plugin',
        headers: { 'X-Sidecar-Token': srv.sideToken, Origin: 'http://127.0.0.1:43210' },
        body: { dir: 'agy-plugin-wallpaper-engine', enabled: false },
      });
      const postConf = (
        await srv.inject({ method: 'GET', url: `/api/conflicts?workspaceUris=${encodeURIComponent(wsUri)}` })
      ).json();
      assert.equal(
        postConf.items.some((i) => i.id === 'host-enhancement-overlap:cdp'),
        false,
        'Parking legacy CDP plugin must clear CDP overlap warning',
      );
    } finally {
      await srv.close();
    }
  } finally {
    ws.cleanup();
  }
});

test('Localized GET /api/readme prefers entriesZh -> local README.zh-CN.md -> fallback README.md and handles locale=en', async () => {
  const ws = makeTempWorkspace('agy-readme-zh-');
  try {
    // Local installed plugin with README.zh-CN.md (no catalog entriesZh)
    const repository = 'https://github.com/alice/local-bilingual';
    writePluginTree(ws.pluginsDir, 'local-bilingual', {
      'plugin.json': { name: 'local-bilingual', displayName: 'Local Bilingual', version: '1.0.0', repository },
      'README.md': '# Local Bilingual\nEnglish default documentation.',
      'README.zh-CN.md': '# 本地双语插件\n这是本地简体中文说明文档。',
      'README.en.md': '# Local Bilingual (EN)\nExplicit English readme.',
    });

    // Local-only plugin (not in catalog at all) with README.zh.md
    writePluginTree(ws.pluginsDir, 'local-only-zh', {
      'plugin.json': { name: 'local-only-zh', displayName: 'Local Only ZH', version: '1.0.0' },
      'README.zh.md': '# 纯本地中文插件\n离线详情抽屉测试。',
    });

    const readmesPayload = {
      schemaVersion: 1,
      entries: {
        'alice__catalog-zh': '# Catalog Plugin\nEnglish fallback README.',
        'alice__local-bilingual': '# Catalog Fallback\nEnglish catalog README.',
        'bob__en-only': '# English Only\nNo Chinese translation yet.',
      },
      entriesZh: {
        'alice__catalog-zh': '# 目录插件中文文档\n由 readmes.json entriesZh 提供。',
      },
      entriesEn: {
        'alice__catalog-zh': '# Catalog Plugin (EN)\nProvided by entriesEn.',
      },
    };

    const srv = await createMarketSidecarServer({
      listen: false,
      configDir: ws.configDir,
      dataDir: ws.dataDir,
      recoveryDelayMs: -1,
      fetchImpl: async (url) => {
        const u = String(url);
        if (u.endsWith('/index.json')) {
          return Response.json({ plugins: [{ id: 'alice__local-bilingual', canonicalName: 'local-bilingual',
            version: '1.0.0', repository: { url: repository } }] });
        }
        if (u.endsWith('/readmes.json')) {
          return new Response(JSON.stringify(readmesPayload), { status: 200 });
        }
        return new Response('{}', { status: 404 });
      },
    });

    try {
      // 1. locale=zh prefers catalog entriesZh[id]
      const r1 = (await srv.inject({ method: 'GET', url: '/api/readme?id=alice__catalog-zh&locale=zh' })).json();
      assert.equal(r1.ok, true);
      assert.equal(r1.locale, 'zh');
      assert.equal(r1.isTranslatedOrNativeZh, true);
      assert.match(r1.markdown, /目录插件中文文档/);

      // 2. locale=en prefers catalog entriesEn[id]
      const r1En = (await srv.inject({ method: 'GET', url: '/api/readme?id=alice__catalog-zh&locale=en' })).json();
      assert.equal(r1En.ok, true);
      assert.equal(r1En.locale, 'en');
      assert.equal(r1En.isTranslatedOrNativeZh, false);
      assert.match(r1En.markdown, /Provided by entriesEn/);

      // 3. No entriesZh -> locale=zh prefers local README.zh-CN.md over English catalog entries[id]!
      const r2 = (
        await srv.inject({ method: 'GET', url: '/api/readme?id=alice__local-bilingual&dir=local-bilingual&locale=zh' })
      ).json();
      assert.equal(r2.ok, true);
      assert.equal(r2.isTranslatedOrNativeZh, true);
      assert.match(r2.markdown, /本地简体中文说明文档/);

      // 4. English-only catalog plugin -> falls back to English with isTranslatedOrNativeZh: false
      const r3 = (await srv.inject({ method: 'GET', url: '/api/readme?id=bob__en-only&locale=zh' })).json();
      assert.equal(r3.ok, true);
      assert.equal(r3.isTranslatedOrNativeZh, false);
      assert.match(r3.markdown, /No Chinese translation yet/);

      // 5. Local-only plugin queried by dir only (no id)
      const r4 = (await srv.inject({ method: 'GET', url: '/api/readme?dir=local-only-zh&locale=zh' })).json();
      assert.equal(r4.ok, true);
      assert.equal(r4.isTranslatedOrNativeZh, true);
      assert.match(r4.markdown, /离线详情抽屉测试/);
    } finally {
      await srv.close();
    }
  } finally {
    ws.cleanup();
  }
});

test('GET /preload.js provides window.sidecar.ui.toggleAuxPane fallback without clobbering host implementation', async () => {
  const ws = makeTempWorkspace('agy-preload-');
  try {
    const srv = await createMarketSidecarServer({
      listen: false,
      configDir: ws.configDir,
      dataDir: ws.dataDir,
      recoveryDelayMs: -1,
      fetchImpl: async () => new Response(JSON.stringify({ schemaVersion: 1, plugins: [] }), { status: 200 }),
    });

    try {
      const preloadRes = await srv.inject({ method: 'GET', url: '/preload.js' });
      assert.equal(preloadRes.statusCode, 200);
      const code = preloadRes.text;
      assert.match(code, /toggleAuxPane/);

      const makeSandbox = (existingSidecar = undefined) => {
        const posted = [];
        const win = {
          location: { search: '?token=testtok' },
          __SIDECAR_BOOT__: {},
          addEventListener() {},
          dispatchEvent() {},
          fetch: async () => ({ ok: true }),
          parent: {
            postMessage(msg, targetOrigin) {
              posted.push({ msg, targetOrigin });
            },
          },
          sidecar: existingSidecar,
        };
        const sandbox = {
          window: win,
          document: { documentElement: { style: { setProperty() {} }, setAttribute() {} } },
          URLSearchParams,
          Headers,
          CustomEvent: class CustomEvent {
            constructor(type, init) {
              this.type = type;
              this.detail = init?.detail;
            }
          },
          Set,
          Promise,
        };
        vm.runInNewContext(code, sandbox);
        return { win, posted };
      };

      // Case 1: !window.sidecar -> attaches ui.toggleAuxPane fallback (synchronous undefined return matching host preload)
      const s1 = makeSandbox(undefined);
      assert.equal(typeof s1.win.sidecar.ui?.toggleAuxPane, 'function');
      const r1 = s1.win.sidecar.ui.toggleAuxPane({ tabType: 'sidecarView', uri: 'sidecar://foo/bar/' });
      assert.equal(r1, undefined);
      assert.equal(s1.posted.length, 1);
      assert.deepEqual(structuredClone(s1.posted[0].msg), {
        type: 'toggle-aux-pane',
        payload: { tabType: 'sidecarView', uri: 'sidecar://foo/bar/' },
      });
      assert.equal(s1.posted[0].targetOrigin, '*');

      // Case 2: window.sidecar exists without .ui -> attaches ui.toggleAuxPane fallback
      const s2 = makeSandbox({ fetch: async () => ({ ok: true }) });
      assert.equal(typeof s2.win.sidecar.ui?.toggleAuxPane, 'function');
      const r2 = s2.win.sidecar.ui.toggleAuxPane({ tabType: 'sidecarView', uri: 'sidecar://a/b/' });
      assert.equal(r2, undefined);
      assert.equal(s2.posted.length, 1);
      assert.deepEqual(structuredClone(s2.posted[0].msg), {
        type: 'toggle-aux-pane',
        payload: { tabType: 'sidecarView', uri: 'sidecar://a/b/' },
      });

      // Case 3: host already provides window.sidecar.ui.toggleAuxPane -> MUST NOT clobber!
      const hostToggle = async (payload) => ({ ok: true, hostHandled: true, payload });
      const s3 = makeSandbox({ fetch: async () => ({ ok: true }), ui: { toggleAuxPane: hostToggle } });
      assert.equal(s3.win.sidecar.ui.toggleAuxPane, hostToggle);
      const r3 = await s3.win.sidecar.ui.toggleAuxPane({ tabType: 'sidecarView', uri: 'sidecar://native/pane/' });
      assert.equal(r3.hostHandled, true);
      assert.equal(s3.posted.length, 0);
    } finally {
      await srv.close();
    }
  } finally {
    ws.cleanup();
  }
});

test('Comment stripping avoids app-asar false positive on CDP plugins and real app-asar overlap has winner=null, shadowed=[], affectedPlugins[2]', () => {
  const ws = makeTempWorkspace('agy-asar-comment-');
  try {
    // Simulated agy-wallpaper-prism: only mentions app-asar inside comments, uses real CDP flag in code
    writePluginTree(ws.pluginsDir, 'agy-wallpaper-prism', {
      'plugin.json': { name: 'agy-wallpaper-prism', displayName: 'Wallpaper Prism', version: '2.0.0' },
      'bridge.mjs': [
        `// Zero writes (never touches ${ASAR_TOKEN})`,
        `/* Documentation block: does not modify ${ASAR_TOKEN} */`,
        `const arg = '${CDP_FLAG}';`,
        `export const kind = 'cdp';`,
      ].join('\n'),
      'launch.ps1': `# Never writes to ${ASAR_TOKEN}\nWrite-Output "cdp"\n`,
    });

    // One real app-asar modifier plugin
    writePluginTree(ws.pluginsDir, 'real-asar-one', {
      'plugin.json': { name: 'real-asar-one', displayName: 'Real Asar One', version: '1.0.0' },
      'patch.mjs': `const target = '${ASAR_TOKEN}';\nexport default target;\n`,
    });

    const inv1 = scanLocalPluginInventory({ configDir: ws.configDir, dataDir: ws.dataDir });
    const prismInv = inv1.installed.find((p) => p.dir === 'agy-wallpaper-prism');
    const asarOneInv = inv1.installed.find((p) => p.dir === 'real-asar-one');
    assert.ok(prismInv);
    assert.ok(asarOneInv);
    assert.deepEqual(prismInv.hostEnhancementKind, ['cdp']);
    assert.deepEqual(asarOneInv.hostEnhancementKind, ['app-asar']);

    const conf1 = scanLocalConflicts({
      inventory: inv1,
      configDir: ws.configDir,
      dataDir: ws.dataDir,
    });
    assert.equal(
      conf1.items.some((i) => i.id === 'host-enhancement-overlap:app-asar'),
      false,
      'Comment-only app-asar mention in CDP plugin must not trigger host-enhancement-overlap:app-asar',
    );

    // Add a second real app-asar modifier plugin -> overlap warning must report winner=null, shadowed=[], affectedPlugins.length=2
    writePluginTree(ws.pluginsDir, 'real-asar-two', {
      'plugin.json': { name: 'real-asar-two', displayName: 'Real Asar Two', version: '1.0.0' },
      'patch.mjs': `const target = '${ASAR_TOKEN}';\nexport default target;\n`,
    });

    const inv2 = scanLocalPluginInventory({ configDir: ws.configDir, dataDir: ws.dataDir });
    const conf2 = scanLocalConflicts({
      inventory: inv2,
      configDir: ws.configDir,
      dataDir: ws.dataDir,
    });
    const asarOverlap = conf2.items.find((i) => i.id === 'host-enhancement-overlap:app-asar');
    assert.ok(asarOverlap, 'Two real app-asar plugins must emit host-enhancement-overlap:app-asar');
    assert.equal(asarOverlap.severity, 'warning');
    assert.equal(asarOverlap.winner, null);
    assert.deepEqual(asarOverlap.shadowed, []);
    assert.equal(asarOverlap.affectedPlugins.length, 2);
    assert.deepEqual(
      asarOverlap.affectedPlugins.map((p) => p.dir).sort(),
      ['real-asar-one', 'real-asar-two'],
    );
  } finally {
    ws.cleanup();
  }
});
