import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';
import { inflateSync } from 'node:zlib';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

const { bundleZeroDepEsm } = await import(pathToFileURL(join(REPO_ROOT, 'scripts', 'build.mjs')).href);
const { DEFAULT_PREFS, PLUGIN_VERSION, PRIMARY_CATALOG_BASE_URL } = await import(
  pathToFileURL(join(REPO_ROOT, 'src', 'shared', 'constants.mjs')).href
);
const {
  buildInstallReceipt,
  loadPrefsFromDisk,
  sanitizeIgnoredConflictIds,
  sanitizePrefs,
  savePrefsToDisk,
} = await import(pathToFileURL(join(REPO_ROOT, 'src', 'shared', 'schemas.mjs')).href);
const {
  listAllRelFiles,
  removeSymlinkOrJunctionOnly,
  safeRemoveDirBestEffort,
  syncDirectoryLockSafe,
} = await import(pathToFileURL(join(REPO_ROOT, 'src', 'installer', 'sync-dir.mjs')).href);
const { installOrUpdateCatalogPlugin } = await import(
  pathToFileURL(join(REPO_ROOT, 'src', 'installer', 'index.mjs')).href
);
const { recoverInterruptedJournal, writePendingJournal } = await import(
  pathToFileURL(join(REPO_ROOT, 'src', 'installer', 'journal.mjs')).href
);
const { createDeterministicTarGz } = await import(
  pathToFileURL(join(REPO_ROOT, 'src', 'installer', 'tar-extract.mjs')).href
);
const { createMarketSidecarServer } = await import(
  pathToFileURL(join(REPO_ROOT, 'src', 'sidecar', 'server.mjs')).href
);

const CLEAN_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><rect x="16" y="16" width="96" height="96" rx="20" fill="#6366f1"/></svg>';

function makeTempWorkspace(prefix = 'agy-v172-test-') {
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

function writeTree(baseDir, files) {
  mkdirSync(baseDir, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(baseDir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(
      abs,
      typeof content === 'string' ? content : `${JSON.stringify(content, null, 2)}\n`,
      'utf8',
    );
  }
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

function makeCatalogPlugin({ id, canonicalName, owner = 'acme', version = '1.0.0', tar, preservePaths = [] }) {
  return {
    id,
    canonicalName,
    scopedName: `${owner}--${canonicalName}`,
    forceScopedInstall: false,
    displayName: canonicalName,
    description: { zh: `${canonicalName} 描述`, en: `${canonicalName} description` },
    version,
    gitTag: `v${version}`,
    commitSha: 'a'.repeat(40),
    repository: {
      url: `https://github.com/${owner}/${canonicalName}`,
      repositoryId: 500,
      ownerId: 50,
      stars: 42,
      pluginRoot: '.',
    },
    distribution: {
      tarballUrl: tar.url,
      sha256: tar.sha256,
      sizeBytes: tar.sizeBytes,
      npmMirrorPkg: null,
      preservePaths,
    },
    media: { iconUrl: null, screenshots: [] },
    taxonomy: { categories: ['productivity'], tags: [], platforms: ['win32', 'darwin', 'linux'] },
    capabilities: {
      badges: ['declarative-only'],
      rulesEstimatedTokens: 0,
      mcpServers: [],
      mcpRemoteDomains: [],
      hookEvents: [],
      hostEnhancementKind: [],
    },
    updatedAt: '2026-11-28T00:00:00Z',
  };
}

function denyDirReadWin32(dirPath) {
  execFileSync('icacls', [dirPath, '/deny', '*S-1-1-0:(RD)'], { stdio: 'ignore' });
}

function restoreDirReadWin32(dirPath) {
  try {
    execFileSync('icacls', [dirPath, '/remove:d', '*S-1-1-0'], { stdio: 'ignore' });
  } catch {
    /* best effort */
  }
}

// ==========================================================================
// Req 1: EPERM opendir / Windows Junction / Safe Cleanup / Stage Context
// ==========================================================================

test('Req 1: junction-safe sync/removal and EPERM-tolerant backup/readdir/cleanup allow update to succeed', async () => {
  const ws = makeTempWorkspace('agy-v172-req1-');
  const lockedSubDirs = [];
  try {
    // 1. External target referenced via Windows NTFS junction (must never be deleted!)
    const externalDir = join(ws.root, 'external-shared-data');
    writeTree(externalDir, { 'keep-me.txt': 'EXTERNAL_DATA_INTACT' });

    const targetDir = join(ws.pluginsDir, 'agy-dart-sample');
    const v1Receipt = buildInstallReceipt({
      plugin: makeCatalogPlugin({
        id: 'acme__agy-dart-sample',
        canonicalName: 'agy-dart-sample',
        version: '1.0.0',
        tar: { url: 'https://example.invalid/v1.tgz', sha256: 'c'.repeat(64), sizeBytes: 10 },
      }),
      installedDir: 'agy-dart-sample',
      effectivePluginName: 'agy-dart-sample',
      managedFiles: ['assets/logo.svg', 'bin/tool.js', 'plugin.json'],
    });
    writeTree(targetDir, {
      'plugin.json': { name: 'agy-dart-sample', displayName: 'Dart Sample', version: '1.0.0', logo: 'assets/logo.svg' },
      'assets/logo.svg': CLEAN_SVG,
      'bin/tool.js': 'console.log("v1");\n',
      'locked-runtime/state.db': 'RUNTIME_LOCKED',
      '.agy-market-receipt.json': v1Receipt,
    });

    const nestedJunction = join(targetDir, 'linked-cache');
    const linkType = process.platform === 'win32' ? 'junction' : 'dir';
    symlinkSync(externalDir, nestedJunction, linkType);

    // Also test targetPluginDir itself being a junction in syncDirectoryLockSafe
    const rootJunctionTarget = join(ws.root, 'root-junction-external');
    writeTree(rootJunctionTarget, { 'untouched.txt': 'DO_NOT_DELETE' });
    const rootJunctionPath = join(ws.root, 'junction-as-plugin-dir');
    symlinkSync(rootJunctionTarget, rootJunctionPath, linkType);

    const directStage = join(ws.root, 'direct-stage');
    writeTree(directStage, {
      'plugin.json': { name: 'junction-plug', displayName: 'Junction Plug', version: '1.0.0' },
      'main.js': 'export const ok = true;\n',
    });
    const jSync = syncDirectoryLockSafe({
      stagingBundleDir: directStage,
      targetPluginDir: rootJunctionPath,
      dataDir: ws.dataDir,
    });
    assert.equal(jSync.syncedFiles, 2);
    assert.equal(lstatSync(rootJunctionPath).isSymbolicLink(), false, 'Junction at target root must be replaced with real dir');
    assert.equal(readFileSync(join(rootJunctionTarget, 'untouched.txt'), 'utf8'), 'DO_NOT_DELETE');

    // Lock `locked-runtime` against directory enumeration on Windows to simulate `EPERM: opendir`
    const lockedSub = join(targetDir, 'locked-runtime');
    const lockedTmp = join(ws.root, 'locked-temp-cleanup');
    writeTree(lockedTmp, { 'nested/file.txt': 'locked' });
    if (process.platform === 'win32') {
      denyDirReadWin32(lockedSub);
      denyDirReadWin32(lockedTmp);
      lockedSubDirs.push(lockedSub, lockedTmp);
    }

    // safeRemoveDirBestEffort must never throw even when rmSync hits EPERM
    const rmResult = safeRemoveDirBestEffort(lockedTmp, { retries: 1, delayMs: 10 });
    if (process.platform === 'win32') {
      assert.equal(rmResult, false, 'safeRemoveDirBestEffort should return false without throwing on EPERM');
    } else {
      assert.equal(rmResult, true);
    }

    // removeSymlinkOrJunctionOnly on non-existent throws ENOENT, on valid junction removes only link
    const tmpJunction = join(ws.root, 'tmp-junc');
    symlinkSync(externalDir, tmpJunction, linkType);
    removeSymlinkOrJunctionOnly(tmpJunction);
    assert.equal(existsSync(tmpJunction), false);
    assert.equal(readFileSync(join(externalDir, 'keep-me.txt'), 'utf8'), 'EXTERNAL_DATA_INTACT');

    // Update agy-dart-sample via installOrUpdateCatalogPlugin while locked-runtime & nestedJunction exist
    const v2Tar = buildTarArtifact(ws.artifactsDir, 'agy-dart-sample-2.0.0.tar.gz', {
      'plugin.json': JSON.stringify({
        name: 'agy-dart-sample',
        displayName: 'Dart Sample',
        version: '2.0.0',
        logo: 'assets/logo.svg',
      }),
      'assets/logo.svg': CLEAN_SVG,
      'bin/tool.js': 'console.log("v2");\n',
    });
    const v2Plugin = makeCatalogPlugin({
      id: 'acme__agy-dart-sample',
      canonicalName: 'agy-dart-sample',
      version: '2.0.0',
      tar: v2Tar,
    });

    const updRes = await installOrUpdateCatalogPlugin({
      plugin: v2Plugin,
      configDir: ws.configDir,
      dataDir: ws.dataDir,
    });
    assert.equal(updRes.ok, true, 'Update must succeed even with locked subdirectory & nested junction');
    assert.equal(updRes.version, '2.0.0');
    assert.equal(readFileSync(join(targetDir, 'bin', 'tool.js'), 'utf8'), 'console.log("v2");\n');
    assert.equal(lstatSync(nestedJunction).isSymbolicLink(), true, 'Unmanaged nested junction is preserved without traversal');
    assert.equal(readFileSync(join(externalDir, 'keep-me.txt'), 'utf8'), 'EXTERNAL_DATA_INTACT');

    // Unrecoverable EPERM during sync must surface stage context `[sync]` and relPath
    const failTar = buildTarArtifact(ws.artifactsDir, 'agy-dart-sample-2.1.0.tar.gz', {
      'plugin.json': JSON.stringify({
        name: 'agy-dart-sample',
        displayName: 'Dart Sample',
        version: '2.1.0',
        logo: 'assets/logo.svg',
      }),
      'assets/logo.svg': CLEAN_SVG,
      'bin/new-locked.dll': 'BINARY',
    });
    const failPlugin = makeCatalogPlugin({
      id: 'acme__agy-dart-sample',
      canonicalName: 'agy-dart-sample',
      version: '2.1.0',
      tar: failTar,
    });
    await assert.rejects(
      () =>
        installOrUpdateCatalogPlugin({
          plugin: failPlugin,
          configDir: ws.configDir,
          dataDir: ws.dataDir,
          writeOverride(src, dst, rel) {
            if (rel === 'bin/new-locked.dll') {
              const err = new Error('EPERM: operation not permitted, open bin/new-locked.dll');
              err.code = 'EPERM';
              err.path = dst;
              throw err;
            }
            copyFileSync(src, dst);
          },
        }),
      (err) => err?.code === 'EPERM' && /\[sync\]/.test(err.message) && /bin\/new-locked\.dll/.test(err.message),
    );
  } finally {
    for (const d of lockedSubDirs) {
      restoreDirReadWin32(d);
    }
    ws.cleanup();
  }
});

// ==========================================================================
// Issue #6 Client: managedFiles Diff Cleanup & Journal Recovery
// ==========================================================================

test('Issue #6 client: managedFiles preserves user files on legacy->managed and consecutive upgrades, while deleting removed package files', async () => {
  const ws = makeTempWorkspace('agy-v172-issue6-');
  try {
    // 1. Legacy v1.3.0 install (NO managedFiles, NO preservePaths) + user-created files
    const nekoDir = join(ws.pluginsDir, 'gemini-neko-cockpit');
    const legacyReceipt = buildInstallReceipt({
      plugin: makeCatalogPlugin({
        id: 'yunjuanyunshu114-byte__antigravity-observer',
        canonicalName: 'gemini-neko-cockpit',
        owner: 'yunjuanyunshu114-byte',
        version: '1.3.0',
        tar: { url: 'https://example.invalid/x.tgz', sha256: 'b'.repeat(64), sizeBytes: 10 },
        preservePaths: [],
      }),
      installedDir: 'gemini-neko-cockpit',
      effectivePluginName: 'gemini-neko-cockpit',
      preservePaths: [],
    });
    delete legacyReceipt.managedFiles;

    writeTree(nekoDir, {
      'plugin.json': {
        name: 'gemini-neko-cockpit',
        displayName: 'Neko Cockpit',
        version: '1.3.0',
        logo: 'assets/logo.svg',
      },
      'assets/logo.svg': CLEAN_SVG,
      'index.js': 'console.log("v1.3.0");\n',
      'legacy-pkg-only.js': 'console.log("old pkg");\n',
      'hud_prefs.json': { opacity: 0.85, theme: 'neko-dark' },
      'assets/custom/a.png': 'PNG_USER_AVATAR_BYTES',
      '.agy-market-receipt.json': legacyReceipt,
    });

    // 2. First upgrade to v1.4.0 (preservePaths: []) -> user files MUST stay, managedFiles recorded
    const v14Tar = buildTarArtifact(ws.artifactsDir, 'neko-1.4.0.tar.gz', {
      'plugin.json': JSON.stringify({
        name: 'gemini-neko-cockpit',
        displayName: 'Neko Cockpit',
        version: '1.4.0',
        logo: 'assets/logo.svg',
      }),
      'assets/logo.svg': CLEAN_SVG,
      'index.js': 'console.log("v1.4.0");\n',
      'v14-module.js': 'export const ver = 14;\n',
    });
    const v14Plugin = makeCatalogPlugin({
      id: 'yunjuanyunshu114-byte__antigravity-observer',
      canonicalName: 'gemini-neko-cockpit',
      owner: 'yunjuanyunshu114-byte',
      version: '1.4.0',
      tar: v14Tar,
      preservePaths: [],
    });

    const res14 = await installOrUpdateCatalogPlugin({
      plugin: v14Plugin,
      configDir: ws.configDir,
      dataDir: ws.dataDir,
    });
    assert.equal(res14.ok, true);
    assert.equal(JSON.parse(readFileSync(join(nekoDir, 'hud_prefs.json'), 'utf8')).opacity, 0.85);
    assert.equal(readFileSync(join(nekoDir, 'assets', 'custom', 'a.png'), 'utf8'), 'PNG_USER_AVATAR_BYTES');

    const receipt14 = JSON.parse(readFileSync(join(nekoDir, '.agy-market-receipt.json'), 'utf8'));
    assert.deepEqual(receipt14.managedFiles, ['assets/logo.svg', 'index.js', 'plugin.json', 'v14-module.js']);

    // 3. Consecutive managed upgrade to v1.4.1 (drops v14-module.js, keeps user files)
    const v141Tar = buildTarArtifact(ws.artifactsDir, 'neko-1.4.1.tar.gz', {
      'plugin.json': JSON.stringify({
        name: 'gemini-neko-cockpit',
        displayName: 'Neko Cockpit',
        version: '1.4.1',
        logo: 'assets/logo.svg',
      }),
      'assets/logo.svg': CLEAN_SVG,
      'index.js': 'console.log("v1.4.1");\n',
    });
    const v141Plugin = makeCatalogPlugin({
      id: 'yunjuanyunshu114-byte__antigravity-observer',
      canonicalName: 'gemini-neko-cockpit',
      owner: 'yunjuanyunshu114-byte',
      version: '1.4.1',
      tar: v141Tar,
      preservePaths: [],
    });

    const res141 = await installOrUpdateCatalogPlugin({
      plugin: v141Plugin,
      configDir: ws.configDir,
      dataDir: ws.dataDir,
    });
    assert.equal(res141.ok, true);
    assert.equal(existsSync(join(nekoDir, 'v14-module.js')), false, 'Removed managed package file must be deleted');
    assert.equal(JSON.parse(readFileSync(join(nekoDir, 'hud_prefs.json'), 'utf8')).theme, 'neko-dark');
    assert.equal(readFileSync(join(nekoDir, 'assets', 'custom', 'a.png'), 'utf8'), 'PNG_USER_AVATAR_BYTES');

    const receipt141 = JSON.parse(readFileSync(join(nekoDir, '.agy-market-receipt.json'), 'utf8'));
    assert.deepEqual(receipt141.managedFiles, ['assets/logo.svg', 'index.js', 'plugin.json']);

    // 4. Legacy plugin WITH preservePaths (no managedFiles) keeps files of unknown ownership
    const legacyPreserveDir = join(ws.pluginsDir, 'legacy-preserved');
    writeTree(legacyPreserveDir, {
      'plugin.json': { name: 'legacy-preserved', displayName: 'Legacy', version: '1.0.0', logo: 'assets/logo.svg' },
      'assets/logo.svg': CLEAN_SVG,
      'stale-legacy.txt': 'STALE',
      'user-data/keep.json': { ok: true },
      '.agy-market-receipt.json': {
        schemaVersion: 1,
        id: 'acme__legacy-preserved',
        installedDir: 'legacy-preserved',
        installedVersion: '1.0.0',
        preservePaths: ['user-data/**'],
      },
    });
    const lpTar = buildTarArtifact(ws.artifactsDir, 'lp-2.0.0.tar.gz', {
      'plugin.json': JSON.stringify({ name: 'legacy-preserved', displayName: 'Legacy', version: '2.0.0', logo: 'assets/logo.svg' }),
      'assets/logo.svg': CLEAN_SVG,
    });
    await installOrUpdateCatalogPlugin({
      plugin: makeCatalogPlugin({
        id: 'acme__legacy-preserved',
        canonicalName: 'legacy-preserved',
        version: '2.0.0',
        tar: lpTar,
        preservePaths: ['user-data/**'],
      }),
      configDir: ws.configDir,
      dataDir: ws.dataDir,
    });
    assert.equal(readFileSync(join(legacyPreserveDir, 'stale-legacy.txt'), 'utf8'), 'STALE');
    assert.equal(existsSync(join(legacyPreserveDir, 'user-data', 'keep.json')), true);

    // 5. journal.mjs crash recovery passes previousManagedFiles on completed-forward & cleans dirs safely
    const journalStagingRoot = join(ws.root, 'j-stage-root');
    const journalStagingBundle = join(journalStagingRoot, 'bundle');
    const journalBackup = join(ws.root, 'j-backup');
    writeTree(journalStagingBundle, {
      'plugin.json': { name: 'gemini-neko-cockpit', displayName: 'Neko Cockpit', version: '1.5.0', logo: 'assets/logo.svg' },
      'assets/logo.svg': CLEAN_SVG,
      'index.js': 'console.log("v1.5.0");\n',
    });
    writeTree(journalBackup, { 'plugin.json': { name: 'gemini-neko-cockpit', version: '1.4.1' } });
    writeTree(nekoDir, { 'old-managed.js': 'SHOULD_BE_REMOVED' });

    const jReceipt = { ...receipt141, installedVersion: '1.5.0', managedFiles: ['assets/logo.svg', 'index.js', 'plugin.json'] };
    writePendingJournal(ws.dataDir, {
      op: 'update',
      dir: 'gemini-neko-cockpit',
      parkedByMarket: false,
      stagingRootDir: journalStagingRoot,
      stagingBundleDir: journalStagingBundle,
      backupDir: journalBackup,
      preservePaths: [],
      previousManagedFiles: ['assets/logo.svg', 'index.js', 'old-managed.js', 'plugin.json'],
      receipt: jReceipt,
    });

    const rec = recoverInterruptedJournal({ dataDir: ws.dataDir, pluginsDir: ws.pluginsDir });
    assert.equal(rec.recovered, true);
    assert.equal(rec.action, 'completed-forward');
    assert.equal(existsSync(join(nekoDir, 'old-managed.js')), false, 'Journal recovery must clean removed managed file');
    assert.equal(readFileSync(join(nekoDir, 'assets', 'custom', 'a.png'), 'utf8'), 'PNG_USER_AVATAR_BYTES');
    assert.equal(JSON.parse(readFileSync(join(nekoDir, 'hud_prefs.json'), 'utf8')).opacity, 0.85);
    assert.equal(existsSync(journalStagingRoot), false);
    assert.equal(existsSync(journalBackup), false);
  } finally {
    ws.cleanup();
  }
});

// ==========================================================================
// Req 2: Track 2 Default True Only for New Installs / Missing Key
// ==========================================================================

test('Req 2: Track 2 defaults to true for fresh/missing prefs while preserving explicit false', () => {
  const ws = makeTempWorkspace('agy-v172-req2-');
  try {
    assert.equal(DEFAULT_PREFS.enableExperimentalTrack2, true);
    assert.deepEqual(DEFAULT_PREFS.ignoredConflictIds, []);

    // 1. Fresh empty dataDir -> true
    const freshPrefs = loadPrefsFromDisk(ws.dataDir);
    assert.equal(freshPrefs.enableExperimentalTrack2, true);
    assert.deepEqual(freshPrefs.ignoredConflictIds, []);

    // 2. Existing prefs.json with explicit false -> stays false
    writeFileSync(
      join(ws.dataDir, 'prefs.json'),
      `${JSON.stringify({ schemaVersion: 1, locale: 'en', enableExperimentalTrack2: false }, null, 2)}\n`,
      'utf8',
    );
    const explicitFalsePrefs = loadPrefsFromDisk(ws.dataDir);
    assert.equal(explicitFalsePrefs.enableExperimentalTrack2, false);
    assert.equal(explicitFalsePrefs.locale, 'en');

    // 3. Existing prefs.json missing enableExperimentalTrack2 -> falls back to true
    writeFileSync(
      join(ws.dataDir, 'prefs.json'),
      `${JSON.stringify({ schemaVersion: 1, locale: 'zh' }, null, 2)}\n`,
      'utf8',
    );
    const missingKeyPrefs = loadPrefsFromDisk(ws.dataDir);
    assert.equal(missingKeyPrefs.enableExperimentalTrack2, true);

    // 4. Round-trip savePrefsToDisk preserves explicit false & sanitized ignoredConflictIds
    const saved = savePrefsToDisk(ws.dataDir, {
      enableExperimentalTrack2: false,
      ignoredConflictIds: ['  conflict-a  ', 'conflict-a', '', 123, 'conflict-b'],
    });
    assert.equal(saved.enableExperimentalTrack2, false);
    assert.deepEqual(saved.ignoredConflictIds, ['conflict-a', 'conflict-b']);
    assert.equal(sanitizePrefs({}).enableExperimentalTrack2, true);
    assert.deepEqual(sanitizeIgnoredConflictIds(['a', 'a', '  b  ', 'x'.repeat(201)]), ['a', 'b']);
  } finally {
    ws.cleanup();
  }
});

// ==========================================================================
// Req 4 Backend: POST /api/conflicts/ignore, CSRF, Persistence & Summary
// ==========================================================================

test('Req 4 backend: POST /api/conflicts/ignore enforces CSRF, persists ignoredConflictIds, filters summaries across endpoints, and survives POST /api/prefs', async () => {
  const ws = makeTempWorkspace('agy-v172-req4-be-');
  try {
    // Create 2 conflicts: duplicate plugin name `dup-alpha` + MCP collision on `search`
    writeTree(join(ws.pluginsDir, 'alpha-one'), {
      'plugin.json': { name: 'dup-alpha', displayName: 'Alpha One', version: '1.0.0' },
      'mcp_config.json': { mcpServers: { search: { command: 'node', args: ['a.js'] } } },
    });
    writeTree(join(ws.pluginsDir, 'alpha-two'), {
      'plugin.json': { name: 'dup-alpha', displayName: 'Alpha Two', version: '1.0.0' },
      'mcp_config.json': { mcpServers: { search: { command: 'node', args: ['b.js'] } } },
    });
    writeTree(join(ws.pluginsDir, 'clean-plug'), {
      'plugin.json': { name: 'clean-plug', displayName: 'Clean Plug', version: '1.0.0' },
    });

    const srv = await createMarketSidecarServer({
      listen: false,
      configDir: ws.configDir,
      dataDir: ws.dataDir,
      recoveryDelayMs: -1,
      fetchImpl: async (url) => {
        if (String(url).endsWith('/index.json') || String(url).endsWith('/unverified-index.json')) {
          return new Response(JSON.stringify({ schemaVersion: 1, plugins: [] }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response('{}', { status: 404 });
      },
    });

    try {
      const authHeaders = { 'X-Sidecar-Token': srv.sideToken, Origin: 'http://127.0.0.1:43210' };

      // 1. CSRF checks
      const noTokenRes = await srv.inject({
        method: 'POST',
        url: '/api/conflicts/ignore',
        headers: { Origin: 'http://127.0.0.1:43210' },
        body: { id: 'duplicate-plugin-name:dup-alpha', ignored: true },
      });
      assert.equal(noTokenRes.statusCode, 403);

      const badOriginRes = await srv.inject({
        method: 'POST',
        url: '/api/conflicts/ignore',
        headers: { 'X-Sidecar-Token': srv.sideToken, Origin: 'https://evil.example.com' },
        body: { id: 'duplicate-plugin-name:dup-alpha', ignored: true },
      });
      assert.equal(badOriginRes.statusCode, 403);

      // 2. Validation checks
      const badIdRes = await srv.inject({
        method: 'POST',
        url: '/api/conflicts/ignore',
        headers: authHeaders,
        body: { id: '   ', ignored: true },
      });
      assert.equal(badIdRes.statusCode, 400);
      assert.match(badIdRes.json().error, /ERR_INVALID_CONFLICT_ID/);

      const badFlagRes = await srv.inject({
        method: 'POST',
        url: '/api/conflicts/ignore',
        headers: authHeaders,
        body: { id: 'duplicate-plugin-name:dup-alpha', ignored: 'yes' },
      });
      assert.equal(badFlagRes.statusCode, 400);
      assert.match(badFlagRes.json().error, /ERR_INVALID_IGNORED_FLAG/);

      // 3. Initial GET /api/conflicts
      const c0 = await srv.inject({ method: 'GET', url: '/api/conflicts' });
      assert.equal(c0.statusCode, 200);
      const c0Json = c0.json();
      assert.ok(c0Json.items.length >= 2);
      assert.equal(c0Json.summary.total, c0Json.items.length);
      assert.equal(c0Json.summary.ignoredCount, 0);

      const targetItem = c0Json.items[0];
      const expectedAfterTotal = c0Json.summary.total - 1;

      // 4. Ignore first conflict + also ignore a nonexistent ID (must not inflate ignoredCount!)
      await srv.inject({
        method: 'POST',
        url: '/api/conflicts/ignore',
        headers: authHeaders,
        body: { id: 'stale-nonexistent-conflict', ignored: true },
      });
      const ignRes = await srv.inject({
        method: 'POST',
        url: '/api/conflicts/ignore',
        headers: authHeaders,
        body: { id: targetItem.id, ignored: true },
      });
      assert.equal(ignRes.statusCode, 200);
      const ignJson = ignRes.json();
      assert.equal(ignJson.ok, true);
      assert.deepEqual(ignJson.ignoredConflictIds, ['stale-nonexistent-conflict', targetItem.id]);
      assert.equal(ignJson.conflictsSummary.total, expectedAfterTotal);
      assert.equal(ignJson.conflictsSummary.ignoredCount, 1);
      assert.equal(ignJson.conflicts.items.find((x) => x.id === targetItem.id)?.ignored, true);
      assert.equal(ignJson.state.conflictsSummary.total, expectedAfterTotal);
      assert.equal(ignJson.state.conflictsSummary.ignoredCount, 1);

      // Verify persisted on disk
      const diskPrefs = loadPrefsFromDisk(ws.dataDir);
      assert.deepEqual(diskPrefs.ignoredConflictIds, ['stale-nonexistent-conflict', targetItem.id]);

      // 5. GET /api/state & GET /api/conflicts reflect filtering
      const st1 = await srv.inject({ method: 'GET', url: '/api/state' });
      assert.equal(st1.json().conflictsSummary.total, expectedAfterTotal);
      assert.equal(st1.json().conflictsSummary.ignoredCount, 1);

      const c1 = await srv.inject({ method: 'GET', url: '/api/conflicts' });
      assert.equal(c1.json().summary.total, expectedAfterTotal);
      assert.equal(c1.json().summary.ignoredCount, 1);
      assert.equal(c1.json().items.find((x) => x.id === targetItem.id)?.ignored, true);

      // 6. POST /api/prefs without ignoredConflictIds preserves existing ignoredConflictIds
      const prefRes = await srv.inject({
        method: 'POST',
        url: '/api/prefs',
        headers: authHeaders,
        body: { locale: 'en' },
      });
      assert.equal(prefRes.statusCode, 200);
      assert.deepEqual(prefRes.json().prefs.ignoredConflictIds, ['stale-nonexistent-conflict', targetItem.id]);
      assert.equal(prefRes.json().conflictsSummary.ignoredCount, 1);

      // 7. POST /api/fix-conflict preserves ignored filtering on returned conflicts & state
      const fixRes = await srv.inject({
        method: 'POST',
        url: '/api/fix-conflict',
        headers: authHeaders,
        body: { fix: { type: 'isolate-rename', targetDir: 'nonexistent-dir', suggestedDir: 'other-dir' } },
      });
      assert.equal(fixRes.statusCode, 400);

      // Trigger real fix-conflict on a fixable duplicate plugin or check valid fix flow:
      const dupConflict = c1.json().items.find((x) => x.fix?.type === 'isolate-rename');
      if (dupConflict) {
        const realFix = await srv.inject({
          method: 'POST',
          url: '/api/fix-conflict',
          headers: authHeaders,
          body: { fix: dupConflict.fix },
        });
        assert.equal(realFix.statusCode, 200);
        assert.ok(typeof realFix.json().conflicts.summary.ignoredCount === 'number');
        assert.ok(typeof realFix.json().state.conflictsSummary.ignoredCount === 'number');
      }

      // 8. Unignore restores active summary
      const unignRes = await srv.inject({
        method: 'POST',
        url: '/api/conflicts/ignore',
        headers: authHeaders,
        body: { id: targetItem.id, ignored: false },
      });
      assert.equal(unignRes.statusCode, 200);
      assert.equal(unignRes.json().conflictsSummary.ignoredCount, 0);
      assert.equal(unignRes.json().ignoredConflictIds.includes(targetItem.id), false);
    } finally {
      await srv.close();
    }
  } finally {
    ws.cleanup();
  }
});

// ==========================================================================
// Req 3, 4 UI, 5, 6: Built UI CSS, DOM & Interactive VM Verification
// ==========================================================================

function createV172UiHarness({ withResizeObserver = false, captureTimers = false } = {}) {
  const bundled = bundleZeroDepEsm(join(REPO_ROOT, 'src', 'ui', 'app.mjs'));
  const bootMarker = 'void openMarketPanel();';
  assert.ok(bundled.includes(bootMarker));

  const instrumented = bundled.replace(
    bootMarker,
    [
      'globalThis.__V172_UI__ = {',
      '  state,',
      '  render,',
      '  getConflictsSummary,',
      '  renderConflictsView,',
      '  renderDiscoverView,',
      '  renderInstalledView,',
      '  renderSourcesView,',
      '  syncChipStripOverflow,',
      '  triggerUpdateAll, maybeTriggerRestartBanner,',
      '  getEffectiveUpdateItems,',
      '};',
    ].join('\n'),
  );

  let rootHtml = '';
  const rootListeners = new Map();
  const storageMap = new Map();
  const fetchCalls = [];
  let fetchHandler = async () => new Response(JSON.stringify({ ok: true }), { status: 200 });

  class MockEl {
    constructor(id = '') {
      this.id = id;
      this.classSet = new Set();
      this.listeners = new Map();
      this.scrollWidth = 900;
      this.clientWidth = 300;
      this.scrollLeft = 0;
      this.scrollByCalls = [];
      this.checked = false;
      this.dataset = {};
      this.classList = {
        toggle: (cls, force) => {
          const next = force !== undefined ? Boolean(force) : !this.classSet.has(cls);
          if (next) this.classSet.add(cls);
          else this.classSet.delete(cls);
          return next;
        },
        contains: (cls) => this.classSet.has(cls),
      };
    }
    addEventListener(ev, fn) {
      if (!this.listeners.has(ev)) this.listeners.set(ev, []);
      this.listeners.get(ev).push(fn);
    }
    scrollBy(opts) {
      this.scrollByCalls.push(opts);
      const delta = typeof opts === 'object' ? Number(opts.left || 0) : 0;
      this.scrollLeft = Math.max(0, Math.min(this.scrollWidth - this.clientWidth, this.scrollLeft + delta));
    }
  }

  const chipWrapEl = new MockEl('discover-chip-wrap');
  const chipStripEl = new MockEl('discover-chip-strip');
  const mainScrollEl = new MockEl('main-scroll');
  const toastHostEl = new MockEl('toast-host');
  let showIgnoredCheckboxEl = null;

  const batchHintEl = new MockEl('batch-results-hint');
  batchHintEl.textContent = '';

  const mockRoot = {
    id: 'app',
    parentNode: null,
    get innerHTML() {
      return rootHtml;
    },
    set innerHTML(v) {
      rootHtml = String(v || '');
      showIgnoredCheckboxEl = rootHtml.includes('id="show-ignored-conflicts-checkbox"')
        ? new MockEl('show-ignored-conflicts-checkbox')
        : null;
      if (showIgnoredCheckboxEl) {
        const m = /<input id="show-ignored-conflicts-checkbox"([^>]*)>/.exec(rootHtml);
        showIgnoredCheckboxEl.checked = Boolean(m && /\bchecked\b/.test(m[1]));
      }
    },
    addEventListener(ev, fn) {
      if (!rootListeners.has(ev)) rootListeners.set(ev, []);
      rootListeners.get(ev).push(fn);
    },
    querySelector(sel) {
      if (sel === '.main-scroll') return mainScrollEl;
      if (sel === '#discover-chip-wrap') return rootHtml.includes('id="discover-chip-wrap"') ? chipWrapEl : null;
      if (sel === '#discover-chip-strip') return rootHtml.includes('id="discover-chip-strip"') ? chipStripEl : null;
      if (sel === '#show-ignored-conflicts-checkbox') return showIgnoredCheckboxEl;
      if (sel === '.batch-results-hint') return rootHtml.includes('class="batch-results-hint') ? batchHintEl : null;
      return null;
    },
    querySelectorAll() {
      return [];
    },
  };

  function makeActionEl(attrs) {
    return {
      nodeType: 1,
      parentNode: mockRoot,
      disabled: false,
      hasAttribute: (k) => Object.prototype.hasOwnProperty.call(attrs, k),
      getAttribute: (k) => (Object.prototype.hasOwnProperty.call(attrs, k) ? String(attrs[k]) : null),
    };
  }

  const mockDocument = {
    getElementById(id) {
      if (id === 'app') return mockRoot;
      if (id === 'toast-host') return toastHostEl;
      if (id === 'discover-chip-wrap') return rootHtml.includes('id="discover-chip-wrap"') ? chipWrapEl : null;
      if (id === 'discover-chip-strip') return rootHtml.includes('id="discover-chip-strip"') ? chipStripEl : null;
      if (id === 'show-ignored-conflicts-checkbox') return showIgnoredCheckboxEl;
      return null;
    },
    querySelector: (sel) => mockRoot.querySelector(sel),
    querySelectorAll: () => [],
    documentElement: { setAttribute() {}, classList: { toggle() {} } },
    body: { classList: { toggle() {} } },
    addEventListener() {},
  };

  const mockWindow = {
    localStorage: {
      getItem: (k) => (storageMap.has(k) ? storageMap.get(k) : null),
      setItem: (k, v) => storageMap.set(k, String(v)),
    },
    addEventListener() {},
    location: { reload() {}, origin: 'http://127.0.0.1:43210', search: '' },
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    __SIDECAR_BOOT__: { token: 'v172-ui-tok' },
    fetch: async (url, opts = {}) => {
      fetchCalls.push({ url: String(url), opts });
      return fetchHandler(String(url), opts);
    },
  };

  let nextTimerId = 1;
  const scheduledTimers = new Map();
  const clearedTimerIds = [];

  const sandbox = {
    window: mockWindow,
    document: mockDocument,
    fetch: mockWindow.fetch,
    URL,
    URLSearchParams,
    Headers,
    Response,
    console,
    setTimeout: captureTimers
      ? (cb, delayMs) => {
          const id = nextTimerId++;
          scheduledTimers.set(id, { id, cb, delayMs: Number(delayMs || 0) });
          return id;
        }
      : () => 1,
    clearTimeout: captureTimers
      ? (id) => {
          if (scheduledTimers.delete(id)) {
            clearedTimerIds.push(id);
          }
        }
      : () => {},
    requestAnimationFrame: (cb) => {
      cb();
      return 1;
    },
  };
  if (withResizeObserver) {
    sandbox.ResizeObserver = class {
      observe() {}
      disconnect() {}
    };
  }
  sandbox.globalThis = sandbox;
  sandbox.self = mockWindow;

  vm.runInNewContext(instrumented, sandbox, { filename: 'agy-market-v172-ui.js' });
  const ui = sandbox.__V172_UI__;
  return {
    ui,
    chipWrapEl,
    chipStripEl,
    batchHintEl,
    storageMap,
    fetchCalls,
    scheduledTimers,
    clearedTimerIds,
    makeActionEl,
    getHtml: () => rootHtml,
    setFetchHandler: (fn) => {
      fetchHandler = fn;
    },
    flushTimers(minDelayMs = 0) {
      const due = [...scheduledTimers.values()].filter((t) => t.delayMs >= minDelayMs);
      for (const t of due) {
        scheduledTimers.delete(t.id);
        t.cb();
      }
      return due.length;
    },
    async dispatchRootEvent(evName, target) {
      const fns = rootListeners.get(evName) || [];
      for (const fn of fns) {
        await fn({ target, preventDefault() {}, stopPropagation() {} });
      }
    },
    async dispatchClick(target) {
      const fns = rootListeners.get('click') || [];
      for (const fn of fns) {
        await fn({ target, preventDefault() {}, stopPropagation() {} });
      }
    },
    async dispatchChange(target) {
      const fns = rootListeners.get('change') || [];
      for (const fn of fns) {
        await fn({ target });
      }
    },
    dispatchWheel(target, { deltaY = 0, deltaX = 0 }) {
      let prevented = false;
      const fns = rootListeners.get('wheel') || [];
      for (const fn of fns) {
        fn({
          target,
          deltaY,
          deltaX,
          preventDefault() {
            prevented = true;
          },
        });
      }
      return prevented;
    },
  };
}

test('Req 3, 4 UI, 5, 6: CSS styles, built HTML, Conflicts Ignore UI, Discover Chip Strip scroll & Responsive Settings layout', async () => {
  const stylesCss = readFileSync(join(REPO_ROOT, 'src', 'ui', 'styles.css'), 'utf8');
  const builtHtml = readFileSync(join(REPO_ROOT, 'sidecars', 'market_pane', 'index.html'), 'utf8');

  // Req 3 CSS assertions
  const verTagCss = /\.version-tag\s*\{([^}]*)\}/.exec(stylesCss);
  assert.ok(verTagCss, '.version-tag must exist in styles.css');
  assert.match(verTagCss[1], /font-size:\s*12\.5px/);
  assert.match(verTagCss[1], /font-weight:\s*700/);
  assert.match(verTagCss[1], /padding:\s*3px 9px/);
  assert.match(verTagCss[1], /border-radius:\s*8px/);
  assert.match(verTagCss[1], /color:\s*var\(--m-text-2\)/);
  assert.match(verTagCss[1], /line-height:\s*1\.25/);

  const verDeltaCss = /\.version-delta\s*\{([^}]*)\}/.exec(stylesCss);
  assert.ok(verDeltaCss, '.version-delta must exist in styles.css');
  assert.match(verDeltaCss[1], /font-size:\s*12px/);
  assert.match(verDeltaCss[1], /font-weight:\s*700/);
  assert.match(verDeltaCss[1], /padding:\s*3px 9px/);
  assert.match(verDeltaCss[1], /line-height:\s*1\.25/);

  assert.match(stylesCss, /\.card-title-right \.version-tag,\s*\.card-title-right \.version-delta\s*\{[^}]*overflow:\s*hidden;[^}]*text-overflow:\s*ellipsis;/);

  // Req 6 CSS assertions
  const settingsCss = /\.settings-panel\s*\{([^}]*)\}/.exec(stylesCss);
  assert.ok(settingsCss, '.settings-panel must exist in styles.css');
  assert.match(settingsCss[1], /display:\s*grid/);
  assert.match(settingsCss[1], /width:\s*100%/);
  assert.match(settingsCss[1], /max-width:\s*none/);
  assert.match(stylesCss, /@container market \(min-width:\s*960px\)[\s\S]*\.field-card-wide,\s*\.settings-actions-row[\s\S]*grid-column:\s*1 \/ -1/);
  assert.match(stylesCss, /@container market \(max-width:\s*360px\)[\s\S]*\.telemetry-grid[\s\S]*grid-template-columns:\s*minmax\(0,\s*1fr\)/);

  // Built HTML contains new Wave 2 CSS & UI symbols
  assert.match(builtHtml, /ignored-toggle-pill/);
  assert.match(builtHtml, /discover-chip-wrap/);
  assert.match(builtHtml, /settings-actions-row/);

  // Interactive VM Harness WITHOUT ResizeObserver (verifies safe fallback!)
  const h = createV172UiHarness({ withResizeObserver: false });
  h.ui.state.serverState = {
    plugin: { id: 'agy-market', version: PLUGIN_VERSION },
    prefs: { locale: 'en', favorites: [], enableExperimentalTrack2: true, ignoredConflictIds: ['c-ign'] },
    catalog: {
      channelUsed: 'github-pages',
      catalogVersion: '2026.1128.1',
      warnings: [],
      plugins: [
        {
          id: 'acme__p1',
          canonicalName: 'p1',
          scopedName: 'acme--p1',
          displayName: 'P1',
          description: { en: 'P1', zh: 'P1' },
          version: '1.2.3',
          taxonomy: { categories: ['developer-tools'], tags: [], platforms: ['win32'] },
          capabilities: { badges: ['declarative-only'] },
          repository: { url: 'https://github.com/acme/p1', stars: 10 },
          installStatus: { installed: false, hasUpdate: false },
        },
      ],
    },
    installed: [],
    updatesAvailable: [],
    conflictsSummary: { total: 1, critical: 1, warning: 0, info: 0, ignoredCount: 1, healthyCount: 2 },
  };

  // Req 5: Discover view chip strip scroll controls & Installed view untouched
  h.ui.state.activeTab = 'discover';
  h.ui.render();
  const discoverHtml = h.getHtml();
  assert.match(discoverHtml, /id="discover-chip-wrap"/);
  assert.match(discoverHtml, /id="discover-chip-strip"/);
  assert.match(discoverHtml, /data-action="scroll-chips" data-dir="-1"/);
  assert.match(discoverHtml, /data-action="scroll-chips" data-dir="1"/);
  assert.equal(h.chipWrapEl.classList.contains('can-scroll-right'), true);
  assert.equal(h.chipWrapEl.classList.contains('can-scroll-left'), false);

  // Click scroll-chips right button
  await h.dispatchClick(h.makeActionEl({ 'data-action': 'scroll-chips', 'data-dir': '1' }));
  assert.equal(h.chipStripEl.scrollByCalls.length, 1);
  assert.ok(h.chipStripEl.scrollByCalls[0].left > 0);

  // Wheel event on #discover-chip-strip translates deltaY to scrollLeft
  const prevented = h.dispatchWheel(
    { closest: (sel) => (sel === '#discover-chip-strip' ? h.chipStripEl : null) },
    { deltaY: 120, deltaX: 0 },
  );
  assert.equal(prevented, true);
  assert.ok(h.ui.state.chipStripScrollLeft > 0);

  h.chipStripEl.scrollLeft = h.chipStripEl.scrollWidth - h.chipStripEl.clientWidth;
  h.ui.syncChipStripOverflow();
  assert.equal(h.chipWrapEl.classList.contains('can-scroll-right'), false);
  assert.equal(h.chipWrapEl.classList.contains('can-scroll-left'), true);
  // After widening, the categories can fit in the row even though the old
  // scrollport still excludes the two buttons and their gaps.
  h.chipWrapEl.clientWidth = h.chipStripEl.scrollWidth;
  h.ui.syncChipStripOverflow();
  assert.equal(h.chipWrapEl.classList.contains('has-overflow'), false);
  assert.equal(h.chipWrapEl.classList.contains('can-scroll-left'), false);

  // Installed view keeps plain .chip-strip without #discover-chip-wrap
  const installedHtml = h.ui.renderInstalledView();
  assert.match(installedHtml, /<div class="chip-strip"/);
  assert.doesNotMatch(installedHtml, /id="discover-chip-wrap"/);

  // Req 6: Sources view markup
  const sourcesHtml = h.ui.renderSourcesView();
  assert.match(sourcesHtml, /class="field-card field-card-wide"/);
  assert.match(sourcesHtml, /class="settings-actions-row"/);

  // Req 4 UI: Conflicts view (active + ignored, showIgnoredConflicts toggle, ordering, actions, empty state, nav badge)
  assert.equal(h.ui.getConflictsSummary().ignoredCount, 1);
  h.ui.state.activeTab = 'conflicts';
  h.ui.state.conflicts = {
    loading: false,
    loaded: true,
    error: '',
    data: {
      ok: true,
      checkedAt: new Date().toISOString(),
      summary: { total: 1, critical: 1, warning: 0, info: 0, ignoredCount: 1, healthyCount: 2 },
      items: [
        {
          id: 'c-ign',
          severity: 'warning',
          layer: 'skill',
          titleEn: 'Ignored Skill',
          titleZh: '已忽略技能',
          ignored: true,
        },
        {
          id: 'c-act',
          severity: 'critical',
          layer: 'plugin',
          titleEn: 'Active Dup',
          titleZh: '活跃冲突',
          ignored: false,
        },
      ],
    },
  };
  h.ui.render();
  const confDefaultHtml = h.getHtml();
  assert.match(confDefaultHtml, /class="ignored-toggle-pill\s+has-ignored"/);
  assert.match(confDefaultHtml, /id="show-ignored-conflicts-checkbox"/);
  assert.match(confDefaultHtml, /Show Ignored\s*<span class="ignored-toggle-count">\(1\)<\/span>/);
  assert.match(confDefaultHtml, /data-action="ignore-conflict"\s+data-conflict-id="c-act"/);
  assert.doesNotMatch(confDefaultHtml, /Ignored Skill/, 'Ignored item must be hidden when showIgnoredConflicts is false');

  // Toggle #show-ignored-conflicts-checkbox ON -> active rendered BEFORE ignored, ignored card has .is-ignored & unignore button
  await h.dispatchChange({ id: 'show-ignored-conflicts-checkbox', checked: true });
  assert.equal(h.ui.state.showIgnoredConflicts, true);
  assert.equal(h.storageMap.get('agy-market-show-ignored-conflicts'), '1');
  const confShownHtml = h.getHtml();
  assert.match(confShownHtml, /class="conflict-card sev-warning is-ignored"/);
  assert.match(confShownHtml, /class="ignored-badge">Ignored</);
  assert.match(confShownHtml, /data-action="unignore-conflict"\s+data-conflict-id="c-ign"/);
  assert.ok(
    confShownHtml.indexOf('Active Dup') < confShownHtml.indexOf('Ignored Skill'),
    'Active conflicts must render before ignored conflicts',
  );

  // Clicking ignore-conflict posts to /api/conflicts/ignore and updates state -> all ignored empty state + green nav badge
  h.setFetchHandler(async (url, opts) => {
    assert.equal(url, '/api/conflicts/ignore');
    assert.equal(opts.method, 'POST');
    const body = JSON.parse(opts.body);
    assert.equal(body.id, 'c-act');
    assert.equal(body.ignored, true);
    const updatedSummary = { total: 0, critical: 0, warning: 0, info: 0, ignoredCount: 2, healthyCount: 2 };
    const updatedItems = h.ui.state.conflicts.data.items.map((it) => ({ ...it, ignored: true }));
    return new Response(
      JSON.stringify({
        ok: true,
        ignoredConflictIds: ['c-ign', 'c-act'],
        conflicts: { ok: true, checkedAt: new Date().toISOString(), summary: updatedSummary, items: updatedItems },
        conflictsSummary: updatedSummary,
        state: { ...h.ui.state.serverState, conflictsSummary: updatedSummary },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  });

  await h.dispatchClick(h.makeActionEl({ 'data-action': 'ignore-conflict', 'data-conflict-id': 'c-act' }));
  await new Promise((r) => setImmediate(r));
  assert.equal(h.fetchCalls.length, 1);

  // Turn showIgnoredConflicts back off -> dedicated all-ignored empty state & green nav badge `✓`
  await h.dispatchChange({ id: 'show-ignored-conflicts-checkbox', checked: false });
  const allIgnoredHtml = h.getHtml();
  assert.match(allIgnoredHtml, /All 2 detected conflict\(s\) are ignored/);
  assert.match(allIgnoredHtml, /<span class="nav-conflict-badge is-healthy"[^>]*>✓<\/span>/);

  // Clicking unignore-conflict posts { id: 'c-act', ignored: false }
  h.setFetchHandler(async (url, opts) => {
    assert.equal(url, '/api/conflicts/ignore');
    const body = JSON.parse(opts.body);
    assert.equal(body.id, 'c-act');
    assert.equal(body.ignored, false);
    const updatedSummary = { total: 1, critical: 1, warning: 0, info: 0, ignoredCount: 1, healthyCount: 2 };
    const updatedItems = h.ui.state.conflicts.data.items.map((it) =>
      it.id === 'c-act' ? { ...it, ignored: false } : it,
    );
    return new Response(
      JSON.stringify({
        ok: true,
        ignoredConflictIds: ['c-ign'],
        conflicts: { ok: true, checkedAt: new Date().toISOString(), summary: updatedSummary, items: updatedItems },
        conflictsSummary: updatedSummary,
        state: { ...h.ui.state.serverState, conflictsSummary: updatedSummary },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  });
  await h.dispatchClick(h.makeActionEl({ 'data-action': 'unignore-conflict', 'data-conflict-id': 'c-act' }));
  await new Promise((r) => setImmediate(r));
  assert.equal(h.fetchCalls.length, 2);
  assert.equal(h.ui.getConflictsSummary().total, 1);
  assert.equal(h.ui.getConflictsSummary().ignoredCount, 1);
});

// ==========================================================================
// Req 7: Transparent PNG Logo Assets, Wiring, CSS, Build & Docs Sync
// ==========================================================================

function decodePngRgba(buf) {
  const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.equal(buf.subarray(0, 8).equals(PNG_SIG), true, 'Buffer must start with 8-byte PNG signature');

  let offset = 8;
  let ihdr = null;
  const idatChunks = [];
  while (offset + 12 <= buf.length) {
    const len = buf.readUInt32BE(offset);
    const type = buf.toString('ascii', offset + 4, offset + 8);
    const data = buf.subarray(offset + 8, offset + 8 + len);
    if (type === 'IHDR') {
      ihdr = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        bitDepth: data[8],
        colorType: data[9],
        interlace: data[12],
      };
    } else if (type === 'IDAT') {
      idatChunks.push(data);
    } else if (type === 'IEND') {
      break;
    }
    offset += 12 + len;
  }

  assert.ok(ihdr, 'PNG must contain IHDR chunk');
  assert.equal(ihdr.bitDepth, 8, 'PNG bit depth must be 8');
  assert.equal(ihdr.colorType, 6, 'PNG color type must be 6 (RGBA)');
  assert.equal(ihdr.interlace, 0, 'PNG must be non-interlaced');

  const raw = inflateSync(Buffer.concat(idatChunks));
  const bpp = 4;
  const stride = ihdr.width * bpp;
  const pixels = Buffer.alloc(ihdr.height * stride);
  const paeth = (a, b, c) => {
    const p = a + b - c;
    const pa = Math.abs(p - a);
    const pb = Math.abs(p - b);
    const pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };

  for (let y = 0; y < ihdr.height; y += 1) {
    const rowStart = y * (stride + 1);
    const filter = raw[rowStart];
    const dstRow = y * stride;
    const prevRow = (y - 1) * stride;
    for (let x = 0; x < stride; x += 1) {
      const val = raw[rowStart + 1 + x];
      const a = x >= bpp ? pixels[dstRow + x - bpp] : 0;
      const b = y > 0 ? pixels[prevRow + x] : 0;
      const c = y > 0 && x >= bpp ? pixels[prevRow + x - bpp] : 0;
      let recon = val;
      if (filter === 1) recon = (val + a) & 0xff;
      else if (filter === 2) recon = (val + b) & 0xff;
      else if (filter === 3) recon = (val + ((a + b) >> 1)) & 0xff;
      else if (filter === 4) recon = (val + paeth(a, b, c)) & 0xff;
      pixels[dstRow + x] = recon;
    }
  }

  return { ...ihdr, pixels };
}

test('Req 7: transparent 512x512 RGBA logo.png, manifest allowlist, inline Data URI, sidecar build & docs byte-match', async () => {
  const logoPath = join(REPO_ROOT, 'assets', 'logo.png');
  assert.equal(existsSync(logoPath), true, 'assets/logo.png must exist');
  const logoBuf = readFileSync(logoPath);
  const decoded = decodePngRgba(logoBuf);
  assert.equal(decoded.width, 512);
  assert.equal(decoded.height, 512);

  const cornerAlpha = (x, y) => decoded.pixels[(y * decoded.width + x) * 4 + 3];
  assert.equal(cornerAlpha(0, 0), 0, 'Top-left corner pixel must be transparent');
  assert.equal(cornerAlpha(511, 0), 0, 'Top-right corner pixel must be transparent');
  assert.equal(cornerAlpha(0, 511), 0, 'Bottom-left corner pixel must be transparent');
  assert.equal(cornerAlpha(511, 511), 0, 'Bottom-right corner pixel must be transparent');

  const manifest = JSON.parse(readFileSync(join(REPO_ROOT, 'plugin.json'), 'utf8'));
  assert.equal(manifest.logo, 'assets/logo.png');
  const STRICT_ALLOWLIST = new Set([
    'name',
    'displayName',
    'description',
    'version',
    'logo',
    'author',
    'homepage',
    'repository',
    'license',
    'suggestedPrompts',
  ]);
  for (const key of Object.keys(manifest)) {
    assert.equal(STRICT_ALLOWLIST.has(key), true, `Unexpected plugin.json field "${key}"`);
  }

  const { BRAND_LOGO_SVG } = await import(pathToFileURL(join(REPO_ROOT, 'src', 'ui', 'icons.mjs')).href);
  assert.match(BRAND_LOGO_SVG, /<img class="brand-logo-img"/);
  const dataUriMatch = BRAND_LOGO_SVG.match(/src="(data:image\/png;base64,([A-Za-z0-9+/=]+))"/);
  assert.ok(dataUriMatch, 'BRAND_LOGO_SVG must embed a valid data:image/png;base64 URI');
  const inlinePng = decodePngRgba(Buffer.from(dataUriMatch[2], 'base64'));
  assert.ok(inlinePng.width > 0 && inlinePng.height > 0);

  const css = readFileSync(join(REPO_ROOT, 'src', 'ui', 'styles.css'), 'utf8');
  assert.match(css, /\.brand-mark\s+\.brand-logo-img/);
  assert.match(css, /\.plugin-logo\s+\.brand-logo-img/);
  assert.match(css, /\.fav-mini-logo\s+\.brand-logo-img/);

  const builtHtml = readFileSync(join(REPO_ROOT, 'sidecars', 'market_pane', 'index.html'), 'utf8');
  assert.equal(builtHtml.includes('brand-logo-img'), true, 'Built sidecar HTML must include brand-logo-img');
  assert.equal(builtHtml.includes(dataUriMatch[1]), true, 'Built sidecar HTML must embed inline PNG Data URI');

  const docsLogoPath = join(REPO_ROOT, 'docs', 'logo.png');
  assert.equal(existsSync(docsLogoPath), true, 'docs/logo.png must exist after --site build');
  const docsLogoBuf = readFileSync(docsLogoPath);
  assert.equal(Buffer.compare(docsLogoBuf, logoBuf), 0, 'docs/logo.png must match assets/logo.png byte-for-byte');
});

// ==========================================================================
// Wave 4 UI Polish: Batch Results Auto-Close, Narrow Dock Wrap, Localized Scope
// ==========================================================================

test('Wave 4 UI Polish: batch update results manual + 8s auto-close, narrow card dock anti-overlap CSS, and localized scope labels/tooltips', async () => {
  const stylesCss = readFileSync(join(REPO_ROOT, 'src', 'ui', 'styles.css'), 'utf8');
  const builtHtml = readFileSync(join(REPO_ROOT, 'sidecars', 'market_pane', 'index.html'), 'utf8');

  // 1. CSS anti-overlap rules for narrow card footers (.card-dock, .dock-left, .dock-right, .prism-toggle, .dock-btn)
  const dockRule = /\.card-dock\s*\{([^}]*)\}/.exec(stylesCss);
  assert.ok(dockRule, '.card-dock rule must exist in styles.css');
  assert.match(dockRule[1], /flex-wrap:\s*wrap/);
  assert.match(dockRule[1], /justify-content:\s*space-between/);

  const dockLeftRule = /\.dock-left\s*\{([^}]*)\}/.exec(stylesCss);
  assert.ok(dockLeftRule, '.dock-left rule must exist in styles.css');
  assert.match(dockLeftRule[1], /flex:\s*0 0 auto/);
  assert.match(dockLeftRule[1], /max-width:\s*100%/);

  const dockRightRule = /\.dock-right\s*\{([^}]*)\}/.exec(stylesCss);
  assert.ok(dockRightRule, '.dock-right rule must exist in styles.css');
  assert.match(dockRightRule[1], /flex-wrap:\s*wrap/);
  assert.match(dockRightRule[1], /flex:\s*0 0 auto/);
  assert.match(dockRightRule[1], /max-width:\s*100%/);
  assert.match(dockRightRule[1], /margin-left:\s*auto/);

  const toggleRule = /\.prism-toggle\s*\{([^}]*)\}/.exec(stylesCss);
  assert.ok(toggleRule, '.prism-toggle rule must exist in styles.css');
  assert.match(toggleRule[1], /white-space:\s*nowrap/);
  assert.match(toggleRule[1], /flex-shrink:\s*0/);

  const toggleLabelRule = /\.prism-toggle-label\s*\{([^}]*)\}/.exec(stylesCss);
  assert.ok(toggleLabelRule, '.prism-toggle-label rule must exist in styles.css');
  assert.match(toggleLabelRule[1], /white-space:\s*nowrap/);
  assert.match(toggleLabelRule[1], /flex-shrink:\s*0/);

  const dockBtnRule = /\.dock-btn\s*\{([^}]*)\}/.exec(stylesCss);
  assert.ok(dockBtnRule, '.dock-btn rule must exist in styles.css');
  assert.match(dockBtnRule[1], /white-space:\s*nowrap/);
  assert.match(dockBtnRule[1], /flex-shrink:\s*0/);

  assert.match(stylesCss, /\.batch-close-btn\s*\{/);
  assert.match(stylesCss, /\.batch-results-hint\s*\{/);
  assert.match(builtHtml, /batch-close-btn/);
  assert.match(builtHtml, /prism-toggle-label/);

  // 2. Interactive VM: batch results auto-close (0 failures -> 8000ms), hover/focus pause, failure stays open, manual close
  const h = createV172UiHarness({ captureTimers: true });
  h.ui.state.activeTab = 'installed';
  h.ui.state.serverState = {
    plugin: { version: '1.7.2' },
    prefs: { locale: 'zh', favorites: [], enableExperimentalTrack2: true, ignoredConflictIds: [] },
    catalog: {
      plugins: [
        {
          id: 'acme__context-mode',
          canonicalName: 'context-mode',
          scopedName: 'acme--context-mode',
          displayName: 'Context Mode',
          version: '2.0.1',
          description: { zh: '上下文模式', en: 'Context Mode' },
          repository: { url: 'https://github.com/acme/context-mode', stars: 10 },
          taxonomy: { categories: [], tags: [] },
          capabilities: { badges: [] },
          installStatus: { installed: true, installedDir: 'context-mode', installedVersion: '2.0.0', enabled: true, scope: 'global' },
        },
      ],
    },
    installed: [
      {
        dir: 'context-mode',
        name: 'context-mode',
        displayName: 'Context Mode',
        version: '2.0.0',
        scope: 'global',
        enabled: true,
        canToggle: true,
        canUninstall: true,
        receipt: { id: 'acme__context-mode' },
      },
      {
        dir: 'ws-helper',
        name: 'ws-helper',
        displayName: 'Workspace Helper',
        version: '1.0.0',
        scope: 'workspace',
        enabled: true,
        canToggle: false,
        toggleDisabledReason: 'workspace',
        canUninstall: false,
      },
      {
        dir: 'core-builtin',
        name: 'core-builtin',
        displayName: 'Core Builtin',
        version: '1.0.0',
        scope: 'builtin',
        enabled: true,
        canToggle: false,
        toggleDisabledReason: 'builtin',
        canUninstall: false,
      },
    ],
    updatesAvailable: [
      { id: 'acme__context-mode', installedDir: 'context-mode', installedVersion: '2.0.0', latestVersion: '2.0.1' },
    ],
    conflictsSummary: { total: 0, critical: 0, warning: 0, info: 0, ignoredCount: 0, healthyCount: 3 },
  };
  h.ui.state.updates = {
    loading: false,
    checkedAt: '2026-11-28T08:00:00Z',
    items: [
      {
        id: 'acme__context-mode',
        dir: 'context-mode',
        displayName: 'Context Mode',
        installedVersion: '2.0.0',
        latestVersion: '2.0.1',
        installable: true,
      },
    ],
    selfUpdate: null,
    rateLimited: false,
    warnings: [],
    error: '',
  };

  // 2a. Localized scope labels + tooltips on installed cards (ZH & EN) + bilingual search
  h.ui.render();
  const zhInstalledHtml = h.getHtml();
  assert.doesNotMatch(zhInstalledHtml, /<span>global<\/span>/, 'Raw English "global" span must not be rendered');
  assert.match(
    zhInstalledHtml,
    /<span class="meta-scope" title="全局插件：安装于 ~\/\.gemini\/config\/plugins\/，对所有工作区生效">全局<\/span>/,
  );
  assert.match(
    zhInstalledHtml,
    /<span class="meta-scope" title="工作区插件：安装于当前工作区 \.agents\/plugins\/，仅对当前项目生效">工作区<\/span>/,
  );
  assert.match(
    zhInstalledHtml,
    /<span class="meta-scope" title="内置插件：由 Antigravity 宿主自带并统一维护">内置<\/span>/,
  );
  // Internal loc.scope remains unchanged
  assert.equal(h.ui.state.serverState.installed[0].scope, 'global');
  assert.equal(h.ui.state.serverState.installed[1].scope, 'workspace');
  assert.equal(h.ui.state.serverState.installed[2].scope, 'builtin');

  // Bilingual search: searching "全局" or "global" matches global plugin
  h.ui.state.installedSearch = '全局';
  h.ui.render();
  assert.match(h.getHtml(), /Context Mode/);
  assert.doesNotMatch(h.getHtml(), /Workspace Helper/);
  h.ui.state.installedSearch = 'global';
  h.ui.render();
  assert.match(h.getHtml(), /Context Mode/);
  assert.doesNotMatch(h.getHtml(), /Workspace Helper/);
  h.ui.state.installedSearch = '';

  // EN locale scope labels & tooltips
  h.ui.state.serverState.prefs.locale = 'en';
  h.ui.render();
  const enInstalledHtml = h.getHtml();
  assert.match(
    enInstalledHtml,
    /<span class="meta-scope" title="Global plugin: installed in ~\/\.gemini\/config\/plugins\/ for all workspaces">Global<\/span>/,
  );
  assert.match(
    enInstalledHtml,
    /<span class="meta-scope" title="Workspace plugin: installed in \.agents\/plugins\/ for the current workspace only">Workspace<\/span>/,
  );
  assert.match(
    enInstalledHtml,
    /<span class="meta-scope" title="Built-in plugin: bundled and maintained by Antigravity host">Built-in<\/span>/,
  );
  h.ui.state.serverState.prefs.locale = 'zh';

  // 2b. Batch update succeeds (0 failures) -> schedules 8000ms auto-close, shows hint + explicit close button, refreshes banner count to 0
  h.setFetchHandler(async (url) => {
    if (url === '/api/update-all') {
      const nextInstalled = h.ui.state.serverState.installed.map((it) =>
        it.dir === 'context-mode' ? { ...it, version: '2.0.1' } : it,
      );
      return new Response(
        JSON.stringify({
          ok: true,
          results: [{ id: 'acme__context-mode', installedDir: 'context-mode', displayName: 'Context Mode', ok: true, version: '2.0.1' }],
          state: { ...h.ui.state.serverState, installed: nextInstalled, updatesAvailable: [] },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    if (url.startsWith('/api/updates')) {
      return new Response(
        JSON.stringify({ ok: true, checkedAt: '2026-11-28T08:01:00Z', items: [], selfUpdate: null }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  });

  await h.ui.triggerUpdateAll(['acme__context-mode']);
  const afterOkHtml = h.getHtml();
  assert.equal(h.ui.getEffectiveUpdateItems().length, 0, 'Banner update count must refresh to 0 after batch update completes');
  assert.doesNotMatch(afterOkHtml, /一键更新 \(1\)/);
  assert.match(afterOkHtml, /class="batch-close-btn"[^>]*data-action="clear-batch-results"/);
  assert.doesNotMatch(afterOkHtml, /ghost-link[^>]*data-action="clear-batch-results"[^>]*>收起/);
  assert.match(afterOkHtml, /已全部更新 · 8 秒后自动关闭/);
  const autoCloseTimers = [...h.scheduledTimers.values()].filter((t) => t.delayMs === 8000);
  assert.equal(autoCloseTimers.length, 1, 'Zero-failure batch update must arm one 8000ms auto-close timer');

  // Hovering inside .batch-results pauses/cancels the auto-close timer
  await h.dispatchRootEvent('mouseover', {
    closest: (sel) => (sel === '.batch-results' ? { className: 'batch-results' } : null),
  });
  assert.equal(h.ui.state.batchResultsAutoClose?.paused, true);
  assert.equal(
    [...h.scheduledTimers.values()].filter((t) => t.delayMs === 8000).length,
    0,
    'Hovering inside .batch-results must cancel the active 8000ms auto-close timer',
  );
  assert.equal(h.batchHintEl.textContent, '已暂停自动关闭');
  assert.ok(Array.isArray(h.ui.state.batchResults), 'Paused panel must remain open');

  // Re-run batch update and test automatic dismissal when 8000ms timer fires
  h.ui.state.serverState.installed[0].version = '2.0.0';
  h.ui.state.updates.items = [
    { id: 'acme__context-mode', dir: 'context-mode', displayName: 'Context Mode', installedVersion: '2.0.0', latestVersion: '2.0.1', installable: true },
  ];
  await h.ui.triggerUpdateAll(['acme__context-mode']);
  assert.equal([...h.scheduledTimers.values()].filter((t) => t.delayMs === 8000).length, 1);
  const fired = h.flushTimers(8000);
  assert.equal(fired, 1);
  assert.equal(h.ui.state.batchResults, null, '8000ms timer firing must clear batchResults');
  assert.doesNotMatch(h.getHtml(), /class="batch-results"/);

  // Re-run batch update and test manual close clears active timer immediately
  h.ui.state.serverState.installed[0].version = '2.0.0';
  h.ui.state.updates.items = [
    { id: 'acme__context-mode', dir: 'context-mode', displayName: 'Context Mode', installedVersion: '2.0.0', latestVersion: '2.0.1', installable: true },
  ];
  await h.ui.triggerUpdateAll(['acme__context-mode']);
  const armedId = [...h.scheduledTimers.values()].find((t) => t.delayMs === 8000)?.id;
  assert.ok(armedId);
  await h.dispatchClick(h.makeActionEl({ 'data-action': 'clear-batch-results' }));
  assert.equal(h.ui.state.batchResults, null);
  assert.ok(h.clearedTimerIds.includes(armedId), 'Manual close must clear active 8000ms auto-close timer');

  // 2c. Batch update with a failure -> NEVER arms auto-close timer and keeps panel open
  h.setFetchHandler(async (url) => {
    if (url === '/api/update-all') {
      return new Response(
        JSON.stringify({
          ok: true,
          results: [
            { id: 'acme__context-mode', installedDir: 'context-mode', displayName: 'Context Mode', ok: false, error: 'HTTP 502' },
          ],
          state: h.ui.state.serverState,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    if (url.startsWith('/api/updates')) {
      return new Response(
        JSON.stringify({ ok: true, checkedAt: '2026-11-28T08:02:00Z', items: h.ui.state.updates.items, selfUpdate: null }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  });
  await h.ui.triggerUpdateAll(['acme__context-mode']);
  assert.equal(h.ui.state.batchResultsAutoClose, null, 'Failed batch update must NEVER arm auto-close state');
  assert.doesNotMatch(h.getHtml(), /自动关闭|auto-closes/);
  assert.match(h.getHtml(), /HTTP 502/);
  assert.match(h.getHtml(), /class="batch-close-btn"/);
  // Even after any 8000ms timers (such as the danger toast timer) fire, batchResults must stay visible
  h.flushTimers(8000);
  assert.equal(Array.isArray(h.ui.state.batchResults) && h.ui.state.batchResults.length === 1, true);
  assert.match(h.getHtml(), /HTTP 502/);

  // A retry of one directory must retain unrelated failures until they are resolved.
  h.ui.state.batchResults.push({ id: 'other', dir: 'other', ok: false, error: 'Unavailable' });
  h.setFetchHandler(async (url, options) => {
    if (url !== '/api/update-all') return Response.json({ ok: true, items: [] });
    const [dir] = JSON.parse(options.body).ids;
    return Response.json({ ok: true, results: [{ dir, id: dir, ok: true, version: '2.0.1' }] });
  });
  await h.ui.triggerUpdateAll(['context-mode']);
  assert.equal(h.ui.state.batchResults.length, 2);
  assert.equal(h.ui.state.errorBanner.items.length, 1);
  assert.equal(h.ui.state.errorBanner.items[0].message, 'Unavailable');
  assert.equal(h.ui.state.batchResultsAutoClose, null);
  await h.ui.triggerUpdateAll(['other']);
  assert.equal(h.ui.state.errorBanner, null);
  assert.equal(h.ui.state.batchResultsAutoClose?.active, true);

  h.ui.state.restartBanner = null;
  h.ui.maybeTriggerRestartBanner({ pluginDir: 'prism', requiresPatchScript: true });
  h.ui.maybeTriggerRestartBanner({ pluginDir: 'reader', operation: 'enable', reloadRequired: true });
  assert.equal(h.ui.state.restartBanner.level, 'host-restart');
  assert.equal(h.ui.state.restartBanner.patchTargets[0].dir, 'prism');
  assert.equal(h.ui.state.restartBanner.pending.length, 2);
});
