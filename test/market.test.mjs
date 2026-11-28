import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { copyFileSync, existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';

import { compileCatalogArtifacts } from '../../agy-market-catalog/scripts/build-catalog.mjs';
import { evaluateSubmission } from '../../agy-market-catalog/scripts/check-submission.mjs';
import { buildTrack2PluginRecord } from '../../agy-market-catalog/scripts/crawl-topics.mjs';
import { validateSingleEntryFile } from '../../agy-market-catalog/scripts/validate-entries.mjs';
import { validatePluginTarball } from '../../agy-market-catalog/scripts/validate-plugin-tarball.mjs';

import { runCli } from '../bin/agy-market.mjs';
import { packReleaseBundle } from '../scripts/pack-release.mjs';
import { fetchVerifiedPluginTarball, isOfficialGithubTokenHost, resolveMutableTagCommitFallbackUrl } from '../src/installer/fetch-tarball.mjs';
import { inspectGithubPluginUrl, installGithubPlugin } from '../src/installer/github-url.mjs';
import { fixLocalConflict, installOrUpdateCatalogPlugin, removeMarketPluginFiles, toggleInstalledPlugin } from '../src/installer/index.mjs';
import { acquirePluginMutation, recoverInterruptedJournal, writePendingJournal } from '../src/installer/journal.mjs';
import { sweepRetiredBinaries, syncDirectoryLockSafe } from '../src/installer/sync-dir.mjs';
import {
  createDeterministicTarGz,
  encodePaxRecord,
  extractTarGzStreamToDir,
  extractTarGzToDir,
  parsePaxRecords,
  parseTarGzToMap,
} from '../src/installer/tar-extract.mjs';
import { resolveInstallPreflight, scanLocalPluginInventory } from '../src/preflight/index.mjs';
import { fetchPluginReadme, resolveMarketCatalog } from '../src/registry/index.mjs';
import { scrubChildProcessEnv } from '../src/shared/constants.mjs';
import { buildInstallReceipt, parseJsonc, sanitizeNativePluginManifest } from '../src/shared/schemas.mjs';
import { renderSafeMarkdown } from '../src/ui/markdown.mjs';
import { createMarketSidecarServer } from '../src/sidecar/server.mjs';

const CLEAN_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><rect x="16" y="16" width="96" height="96" rx="20" fill="#6366f1"/></svg>`;
const COMMIT_1 = '1111111111111111111111111111111111111111';
const COMMIT_2 = '2222222222222222222222222222222222222222';

function makeTempWorkspace(prefix = 'agy-market-test-') {
  const root = mkdtempSync(join(tmpdir(), prefix));
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

function makeCommits() {
  return [
    { sha: 'a'.repeat(40), commit: { tree: { sha: 'tree_alpha_1' } } },
    { sha: 'b'.repeat(40), commit: { tree: { sha: 'tree_alpha_2' } } },
    { sha: 'c'.repeat(40), commit: { tree: { sha: 'tree_alpha_3' } } },
  ];
}

function stagedRelease(ws, name, version, files = {}) {
  const owner = name === 'agy-market' ? 'azwosile' : 'example';
  const url = `https://github.com/${owner}/${name}`;
  const manifest = { name, version, repository: url };
  const archive = createDeterministicTarGz({ 'plugin.json': JSON.stringify(manifest), ...files });
  const path = join(ws.artifactsDir, name + '-' + version + '.tgz');
  writeFileSync(path, archive);
  return {
    id: owner + '__' + name, canonicalName: name, version, repository: { url, pluginRoot: '.' },
    distribution: { tarballUrl: pathToFileURL(path).href, sha256: createHash('sha256').update(archive).digest('hex') },
  };
}

test('a live sidecar resumes an interrupted update before installing another plugin', async t => {
  const ws = makeTempWorkspace();
  t.after(ws.cleanup);
  const one = stagedRelease(ws, 'reader', '1.0.0');
  const two = stagedRelease(ws, 'reader', '2.0.0');
  const other = stagedRelease(ws, 'writer', '1.0.0');
  const server = await createMarketSidecarServer({ ...ws, listen: false, recoveryDelayMs: -1,
    fetchImpl: async () => Response.json({ plugins: [two, other] }) });
  t.after(() => server.close());
  await installOrUpdateCatalogPlugin({ ...ws, plugin: one });
  await assert.rejects(installOrUpdateCatalogPlugin({ ...ws, plugin: two,
    writeOverride() { throw new Error('temporary I/O failure'); } }), /temporary I\/O failure/);
  assert.ok(existsSync(join(ws.dataDir, 'pending-journal.json')));
  const response = await server.inject({ method: 'POST', url: '/api/install',
    headers: { 'x-sidecar-token': server.sideToken }, body: { id: other.id } });
  assert.equal(response.json().ok, true, response.body);
  assert.equal(JSON.parse(readFileSync(join(ws.pluginsDir, 'reader/.agy-market-receipt.json'))).installedVersion, '2.0.0');
  assert.ok(existsSync(join(ws.pluginsDir, 'writer/plugin.json')));
  assert.equal(existsSync(join(ws.dataDir, 'pending-journal.json')), false);
});

test('startup collection keeps an empty installation root reserved for recovery', async t => {
  const ws = makeTempWorkspace();
  t.after(ws.cleanup);
  const plugin = stagedRelease(ws, 'reader', '1.0.0');
  await assert.rejects(installOrUpdateCatalogPlugin({ ...ws, plugin,
    writeOverride() { throw new Error('before first copy'); } }), /before first copy/);
  const target = join(ws.pluginsDir, 'reader');
  assert.deepEqual(fs.readdirSync(target), []);
  const server = await createMarketSidecarServer({ ...ws, listen: false, recoveryDelayMs: -1 });
  try {
    assert.ok(existsSync(target));
    assert.equal(recoverInterruptedJournal(ws).action, 'completed-forward');
    assert.equal(JSON.parse(readFileSync(join(target, 'plugin.json'))).name, 'reader');
  } finally { await server.close(); }
});

test('first-install recovery distinguishes published, partial and user-created files', async t => {
  const ws = makeTempWorkspace();
  t.after(ws.cleanup);
  const dir = join(ws.pluginsDir, 'reader');
  const partial = join(dir, 'b-partial.txt');
  const later = join(dir, 'z-settings.txt');
  const release = stagedRelease(ws, 'reader', '1.0.0', {
    'a-published.txt': 'complete', 'b-partial.txt': 'long content', 'z-settings.txt': 'release defaults',
  });
  const copy = fs.copyFileSync;
  t.mock.method(fs, 'copyFileSync', (src, dst, ...args) => {
    if (dst === partial) { writeFileSync(dst, 'long'); throw new Error('interrupted copy'); }
    return copy(src, dst, ...args);
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(installOrUpdateCatalogPlugin({ ...ws, plugin: release }), /interrupted copy/);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
  assert.equal(readFileSync(join(dir, 'a-published.txt'), 'utf8'), 'complete');
  assert.equal(readFileSync(partial, 'utf8'), 'long');
  assert.equal(existsSync(later), false);
  for (const userContent of ['private notes', 'release', 'release defaults', '']) {
    writeFileSync(later, userContent);
    const result = recoverInterruptedJournal(ws);
    assert.match(result.error, /ERR_PLUGIN_LAYOUT_CONFLICT.*z-settings/);
    assert.equal(readFileSync(later, 'utf8'), userContent);
    assert.equal(existsSync(join(dir, '.agy-market-receipt.json')), false);
  }
  rmSync(later);
  assert.equal(recoverInterruptedJournal(ws).action, 'completed-forward');
  assert.equal(readFileSync(partial, 'utf8'), 'long content');
  assert.equal(readFileSync(later, 'utf8'), 'release defaults');
});

test('legacy first-install recovery leaves shorter local files intact and reuses identical files without writing', async t => {
  for (const op of ['install-native', 'install-scoped']) {
    await t.test(op, t => {
      const ws = makeTempWorkspace();
      t.after(ws.cleanup);
      const dir = op === 'install-native' ? 'reader' : 'example--reader';
      const target = join(ws.pluginsDir, dir);
      const stage = join(ws.dataDir, 'staging', 'legacy', 'bundle');
      mkdirSync(stage, { recursive: true });
      mkdirSync(target);
      const manifest = JSON.stringify({ name: dir, version: '1.0.0' });
      const files = { 'plugin.json': manifest, 'a-new.txt': 'new entry', 'settings.txt': 'release defaults' };
      for (const [path, content] of Object.entries(files)) writeFileSync(join(stage, path), content);
      writeFileSync(join(target, 'plugin.json'), manifest);
      const receipt = { id: 'example__reader', managedFiles: Object.keys(files) };
      writePendingJournal(ws.dataDir, { op, dir, stagingRootDir: join(stage, '..'), stagingBundleDir: stage,
        previousManagedFiles: null, fromVersion: null, backupDir: null, receipt });
      const local = join(target, 'settings.txt');
      for (const content of ['release', '', 'release defaultX']) {
        writeFileSync(local, content);
        assert.match(recoverInterruptedJournal(ws).error || '', /ERR_PLUGIN_LAYOUT_CONFLICT.*settings/);
        assert.equal(readFileSync(local, 'utf8'), content);
        assert.equal(existsSync(join(target, 'a-new.txt')), false);
        assert.ok(existsSync(join(ws.dataDir, 'pending-journal.json')));
      }
      writeFileSync(local, files['settings.txt']);
      const receiptPath = join(target, '.agy-market-receipt.json');
      if (op === 'install-scoped') {
        const editedReceipt = JSON.stringify({ ...receipt, userNotes: 'keep' });
        writeFileSync(receiptPath, editedReceipt);
        assert.match(recoverInterruptedJournal(ws).error || '', /ERR_PLUGIN_LAYOUT_CONFLICT.*receipt/);
        assert.equal(readFileSync(receiptPath, 'utf8'), editedReceipt);
        assert.equal(existsSync(join(target, 'a-new.txt')), false);
        writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + '\n');
        fs.utimesSync(receiptPath, 100, 100);
      }
      fs.utimesSync(local, 100, 100);
      const prior = statSync(local, { bigint: true });
      assert.equal(recoverInterruptedJournal(ws).action, 'completed-forward');
      assert.equal(statSync(local, { bigint: true }).mtimeNs, prior.mtimeNs);
      assert.equal(readFileSync(join(target, 'a-new.txt'), 'utf8'), 'new entry');
      assert.deepEqual(JSON.parse(readFileSync(receiptPath)), receipt);
      if (op === 'install-scoped') assert.equal(statSync(receiptPath, { bigint: true }).mtimeNs, prior.mtimeNs);
    });
  }
});

test('catalog updates confirm capabilities observed in the verified archive before changing the installation', async t => {
  const ws = makeTempWorkspace();
  t.after(ws.cleanup);
  const first = stagedRelease(ws, 'reader', '1.0.0');
  await installOrUpdateCatalogPlugin({ ...ws, plugin: first });
  const plugin = stagedRelease(ws, 'reader', '2.0.0', { 'rules/format.md': 'Prefer short paragraphs.' });
  const primary = readFileSync(fileURLToPath(plugin.distribution.tarballUrl));
  const fallback = createDeterministicTarGz({
    'plugin.json': JSON.stringify({ name: 'reader', version: '2.0.0', repository: plugin.repository.url }),
    'rules/format.md': 'Prefer short paragraphs and clear headings.',
  });
  plugin.commitSha = COMMIT_1;
  plugin.distribution.tarballUrl = plugin.repository.url + '/archive/refs/tags/v2.0.0.tar.gz';
  plugin.distribution.commitFallbackSha256 = createHash('sha256').update(fallback).digest('hex');
  let tagAvailable = true;
  const fetchImpl = async url => String(url) === plugin.distribution.tarballUrl
    ? (tagAvailable ? new Response(primary) : new Response('', { status: 404 }))
    : new Response(fallback);
  const updated = opts => installOrUpdateCatalogPlugin({ ...ws, plugin, fetchImpl, ...opts });
  const pending = await updated({});
  assert.equal(pending.status, 'CAPABILITY_ESCALATION_CONFIRM_REQUIRED');
  assert.deepEqual(pending.escalation.addedBadges, ['global-rules']);
  assert.equal(existsSync(join(ws.pluginsDir, 'reader/rules/format.md')), false);
  assert.equal(existsSync(join(ws.dataDir, 'pending-journal.json')), false);
  tagAvailable = false;
  const changed = await updated({ confirmEscalation: true, approvalKey: pending.escalation.approvalKey });
  assert.equal(changed.status, 'CAPABILITY_ESCALATION_CONFIRM_REQUIRED');
  assert.notEqual(changed.escalation.approvalKey, pending.escalation.approvalKey);
  assert.equal(existsSync(join(ws.pluginsDir, 'reader/rules/format.md')), false);
  const installed = await updated({ confirmEscalation: true, approvalKey: changed.escalation.approvalKey });
  assert.equal(installed.status, 'INSTALLED');
  assert.equal(installed.receipt.sha256, plugin.distribution.commitFallbackSha256);
  assert.ok(installed.receipt.grantedCapabilities.badges.includes('global-rules'));
});

test('an update cannot claim a regular file created by the user after the previous install', async () => {
  const ws = makeTempWorkspace();
  try {
    const dir = join(ws.pluginsDir, 'reader');
    const install = (version, files) => installOrUpdateCatalogPlugin({ ...ws, plugin: stagedRelease(ws, 'reader', version, files) });
    await install('1.0.0', { 'entry.js': 'original' });
    writeFileSync(join(dir, 'notes.md'), 'private draft');
    const receipt = readFileSync(join(dir, '.agy-market-receipt.json'));
    await assert.rejects(install('2.0.0', { 'entry.js': 'updated', 'notes.md': 'example notes' }), /ERR_PLUGIN_LAYOUT_CONFLICT.*notes\.md/);
    assert.equal(readFileSync(join(dir, 'notes.md'), 'utf8'), 'private draft');
    assert.equal(readFileSync(join(dir, 'entry.js'), 'utf8'), 'original');
    assert.deepEqual(readFileSync(join(dir, '.agy-market-receipt.json')), receipt);
    assert.equal(existsSync(join(ws.dataDir, 'pending-journal.json')), false);
  } finally { ws.cleanup(); }
});

test('recovery verifies staged and backup file contents before replacing live files', async () => {
  for (const corruptBackup of [false, true]) {
    const ws = makeTempWorkspace();
    try {
      const install = (version, writeOverride) => installOrUpdateCatalogPlugin({ ...ws,
        plugin: stagedRelease(ws, 'reader', version, { 'entry.js': version }), writeOverride });
      await install('1.0.0');
      await assert.rejects(install('2.0.0', () => { throw new Error('interrupted'); }), /interrupted/);
      const pendingPath = join(ws.dataDir, 'pending-journal.json');
      const journal = JSON.parse(readFileSync(pendingPath));
      writeFileSync(join(journal.stagingBundleDir, 'entry.js'), '');
      if (corruptBackup) writeFileSync(join(journal.backupDir, 'entry.js'), 'x.y.z');
      const recovered = recoverInterruptedJournal(ws);
      assert.equal(recovered.action, corruptBackup ? 'error' : 'rolled-back');
      assert.equal(existsSync(pendingPath), corruptBackup);
      assert.equal(readFileSync(join(ws.pluginsDir, 'reader', 'entry.js'), 'utf8'), '1.0.0');
      assert.equal(JSON.parse(readFileSync(join(ws.pluginsDir, 'reader', '.agy-market-receipt.json'))).installedVersion, '1.0.0');
    } finally { ws.cleanup(); }
  }
});

test('rollback removes completed additions and keeps new, edited and unrelated user files', async t => {
  const ws = makeTempWorkspace();
  t.after(ws.cleanup);
  const active = join(ws.pluginsDir, 'reader');
  const install = (version, files, options) => installOrUpdateCatalogPlugin({
    ...ws, plugin: stagedRelease(ws, 'reader', version, files), ...options });
  await install('1.0.0', {});
  writeFileSync(join(active, 'local.txt'), 'before');
  const additions = { 'a-new.txt': 'package', 'b-edited.txt': 'original', 'z-notes.txt': 'template' };
  await assert.rejects(install('2.0.0', additions, { writeOverride(src, dst, rel) {
    if (rel === 'z-notes.txt') throw new Error('interrupted');
    copyFileSync(src, dst);
  } }), /interrupted/);
  const journal = JSON.parse(readFileSync(join(ws.dataDir, 'pending-journal.json')));
  rmSync(join(journal.stagingBundleDir, 'z-notes.txt'));
  writeFileSync(join(active, 'z-notes.txt'), 'template'); // identical bytes, but the update never wrote this file
  writeFileSync(join(active, 'b-edited.txt'), 'changed while market was closed');
  writeFileSync(join(active, 'local.txt'), 'after');
  assert.equal(recoverInterruptedJournal(ws).action, 'rolled-back');
  assert.equal(existsSync(join(active, 'a-new.txt')), false);
  assert.equal(readFileSync(join(active, 'z-notes.txt'), 'utf8'), 'template');
  assert.equal(readFileSync(join(active, 'b-edited.txt'), 'utf8'), 'changed while market was closed');
  assert.equal(readFileSync(join(active, 'local.txt'), 'utf8'), 'after');
});

test('manual replacement protects host entries that would survive from the old plugin', async t => {
  const ws = makeTempWorkspace();
  t.after(ws.cleanup);
  const active = join(ws.pluginsDir, 'reader');
  mkdirSync(join(active, 'rules'), { recursive: true });
  writeFileSync(join(active, 'plugin.json'), JSON.stringify({ name: 'reader', version: '1.0.0' }));
  const oldRule = join(active, 'rules', 'format.md');
  writeFileSync(oldRule, 'Original formatting preferences');
  const plugin = stagedRelease(ws, 'reader', '2.0.0', { 'skills/read/SKILL.md': '# Read' });
  const install = opts => installOrUpdateCatalogPlugin({ ...ws, plugin, ...opts });
  const prompt = await install({});
  await assert.rejects(install({ conflictStrategy: 'replace', replacementKey: prompt.replacementKey }),
    /ERR_PLUGIN_LAYOUT_CONFLICT.*rules\/format.md/);
  assert.equal(readFileSync(oldRule, 'utf8'), 'Original formatting preferences');
  assert.equal(JSON.parse(readFileSync(join(active, 'plugin.json'))).version, '1.0.0');
  const isolated = await install({ conflictStrategy: 'isolate' });
  assert.equal(isolated.status, 'INSTALLED');
  assert.equal(existsSync(join(ws.pluginsDir, isolated.installedDir, 'rules', 'format.md')), false);
});

test('Windows retries original-path deletes after unlocking and preserves subsequently replaced files',
  { skip: process.platform !== 'win32', timeout: 30000 }, async t => {
  for (const operation of ['disable', 'uninstall', 'replacement']) {
    const ws = makeTempWorkspace();
    t.after(ws.cleanup);
    const args = { ...ws, dir: 'reader' };
    const plugin = stagedRelease(ws, 'reader', '1.0.0', { 'runtime.txt': 'running' });
    await installOrUpdateCatalogPlugin({ ...ws, plugin });
    const file = join(ws.pluginsDir, 'reader', 'runtime.txt');
    const hold = spawn('powershell.exe', ['-NoProfile', '-Command',
      "$f=[IO.File]::OpenRead($env:AGY_TEST_LOCK); try { [Console]::WriteLine('ready'); [Console]::ReadLine() | Out-Null } finally { $f.Dispose() }"],
    { env: { ...scrubChildProcessEnv(process.env), AGY_TEST_LOCK: file }, stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true });
    const exited = once(hold, 'exit');
    try {
      await Promise.race([once(hold.stdout, 'data'), exited.then(() => { throw Error('File-lock helper exited early'); })]);
      if (operation === 'disable') assert.equal(toggleInstalledPlugin({ ...args, enabled: false }).parkedByMarket, true);
      else assert.equal(removeMarketPluginFiles(args).removed, true);
      assert.equal(existsSync(file), true);
    } finally {
      hold.stdin.end('\n');
      await exited;
    }
    if (operation === 'disable') {
      assert.equal(toggleInstalledPlugin({ ...args, enabled: true }).enabled, true);
    } else if (operation === 'uninstall') {
      assert.equal((await installOrUpdateCatalogPlugin({ ...ws, plugin })).status, 'INSTALLED');
    } else {
      rmSync(file);
      writeFileSync(file, 'created after uninstall');
      sweepRetiredBinaries(ws.dataDir, { pluginsDir: ws.pluginsDir });
      assert.equal(readFileSync(file, 'utf8'), 'created after uninstall');
    }
  }
});

test('preserved settings survive case-only renames and later releases on case-insensitive volumes', async t => {
  const ws = makeTempWorkspace();
  try {
    const path = join(ws.pluginsDir, 'reader', 'Config', 'PREFS.json');
    const install = async (version, settingsPath) => {
      const plugin = stagedRelease(ws, 'reader', version, { [settingsPath]: 'vendor defaults' });
      plugin.distribution.preservePaths = ['config/**/prefs.*'];
      assert.equal((await installOrUpdateCatalogPlugin({ ...ws, plugin })).ok, true);
    };
    await install('1.0.0', 'config/prefs.json');
    if (!existsSync(path)) return t.skip('Case-sensitive filesystem');
    writeFileSync(path, 'user settings');
    await install('2.0.0', 'Config/PREFS.json');
    await install('3.0.0', 'Config/PREFS.json');
    await install('4.0.0', 'other.json');
    assert.equal(readFileSync(path, 'utf8'), 'user settings');
  } finally { ws.cleanup(); }
});

test('a locked retired entry keeps the old receipt and journal until recovery removes it', async t => {
  const ws = makeTempWorkspace();
  try {
    const path = join(ws.pluginsDir, 'reader', 'old.txt');
    const install = (version, files) => installOrUpdateCatalogPlugin({ ...ws, plugin: stagedRelease(ws, 'reader', version, files) });
    await install('1.0.0', { 'old.txt': 'old' });
    for (const method of ['unlinkSync', 'renameSync']) {
      const original = fs[method];
      t.mock.method(fs, method, (file, ...args) => {
        if (file === path) throw Object.assign(new Error('file in use'), { code: 'EBUSY' });
        return original(file, ...args);
      });
    }
    syncBuiltinESMExports();
    try {
      await assert.rejects(install('2.0.0', {}), /file in use/);
      assert.equal(recoverInterruptedJournal(ws).action, 'error');
      assert.equal(JSON.parse(readFileSync(join(ws.pluginsDir, 'reader', '.agy-market-receipt.json'))).installedVersion, '1.0.0');
    } finally {
      t.mock.restoreAll();
      syncBuiltinESMExports();
    }
    assert.equal(recoverInterruptedJournal(ws).action, 'completed-forward');
    assert.equal(existsSync(path), false);
    assert.equal(existsSync(join(ws.dataDir, 'pending-journal.json')), false);
  } finally { ws.cleanup(); }
});

test('GitHub URL installation and an official catalog self-update respect unmanaged Git checkouts', async () => {
  const ws = makeTempWorkspace();
  try {
    for (const name of ['reader', 'agy-market']) {
      const plugin = stagedRelease(ws, name, '2.0.0', { 'work.md': 'published content' });
      const dir = join(ws.pluginsDir, name);
      mkdirSync(dir);
      // A linked Git worktree uses a .git file, an ordinary checkout a directory.
      if (name === 'reader') mkdirSync(join(dir, '.git'));
      else writeFileSync(join(dir, '.git'), 'gitdir: ../worktrees/market');
      writeFileSync(join(dir, 'plugin.json'), JSON.stringify({ name, version: '1.0.0', repository: plugin.repository.url }));
      writeFileSync(join(dir, 'work.md'), 'uncommitted edits');
      if (name === 'reader') {
        const fetchImpl = async url => String(url).includes('api.github.com') ? Response.json({}, { status: 404 }) :
          new Response(readFileSync(fileURLToPath(plugin.distribution.tarballUrl)));
        const preview = await inspectGithubPluginUrl({ ...ws, url: plugin.repository.url + '/tree/main', fetchImpl });
        await assert.rejects(installGithubPlugin({ ...ws, inspectToken: preview.inspectToken, fetchImpl }), /ERR_UNMANAGED_GIT_OR_UNVERSIONED/);
      } else {
        await assert.rejects(installOrUpdateCatalogPlugin({ ...ws, plugin }), /ERR_UNMANAGED_GIT_OR_UNVERSIONED/);
      }
      assert.equal(readFileSync(join(dir, 'work.md'), 'utf8'), 'uncommitted edits');
      assert.equal(existsSync(join(dir, '.agy-market-receipt.json')), false);
    }
  } finally { ws.cleanup(); }
});

test('forward recovery and rollback leave replacement plugin directories untouched', async () => {
  for (const mode of ['forward', 'rollback', 'first-install', 'recreated-directory', 'legacy-journal']) {
    const ws = makeTempWorkspace();
    try {
      const dir = join(ws.pluginsDir, 'reader');
      if (mode !== 'first-install') await installOrUpdateCatalogPlugin({ ...ws, plugin: stagedRelease(ws, 'reader', '1.0.0') });
      await assert.rejects(installOrUpdateCatalogPlugin({ ...ws, plugin: stagedRelease(ws, 'reader', '2.0.0', { 'code.js': 'upstream' }),
        writeOverride() { throw new Error('interrupted'); } }), /interrupted/);
      const journalPath = join(ws.dataDir, 'pending-journal.json');
      const record = JSON.parse(readFileSync(journalPath));
      if (mode === 'rollback') rmSync(join(record.stagingBundleDir, 'code.js'));
      if (mode === 'legacy-journal') {
        delete record.targetIdentity;
        writeFileSync(journalPath, JSON.stringify(record));
      }
      if (mode === 'recreated-directory') {
        const old = join(ws.root, 'other-installation');
        renameSync(dir, old);
        mkdirSync(dir);
        copyFileSync(join(old, 'plugin.json'), join(dir, 'plugin.json'));
      } else {
        // External tools can replace metadata while retaining the original directory.
        writeFileSync(join(dir, 'plugin.json'), JSON.stringify({ name: 'other', repository: 'https://github.com/other/project' }));
      }
      writeFileSync(join(dir, 'code.js'), 'local work');
      const before = readFileSync(join(dir, 'plugin.json'));
      const recovery = recoverInterruptedJournal(ws);
      assert.match(recovery.error, /ERR_RECOVERY_TARGET_CHANGED/);
      assert.deepEqual(readFileSync(join(dir, 'plugin.json')), before);
      assert.equal(readFileSync(join(dir, 'code.js'), 'utf8'), 'local work');
      assert.equal(recovery.action, 'target-changed');
      assert.equal(existsSync(journalPath), false);
      assert.ok(existsSync(recovery.journalPath));
      assert.ok(existsSync(record.stagingBundleDir));
      const unrelated = await installOrUpdateCatalogPlugin({ ...ws, plugin: stagedRelease(ws, 'unrelated', '1.0.0') });
      assert.ok(unrelated.ok);
    } finally { ws.cleanup(); }
  }
});

test('Cross-repo dogfooding: packed agy-market.tar.gz passes agy-market-catalog 10-field & 4-layer gate', async () => {
  const packed = await packReleaseBundle();
  assert.equal(packed.exists, true);
  const tarBuf = readFileSync(packed.tarPath);
  const validated = validatePluginTarball(tarBuf, { pluginRoot: '.', allowScopedName: false });

  assert.equal(validated.manifest.name, 'agy-market');
  assert.equal(validated.sha256, packed.sha256);
  assert.ok(validated.capabilities.badges.includes('sidecar-ui'));
  assert.ok(!validated.capabilities.badges.includes('mcp-stdio'), 'Pure Sidecar default must ship 0 active MCP servers');
});

test('Dual-channel registry: ETag 304 cache hit + automatic @agy-market/catalog China npm mirror fallback', async () => {
  const ws = makeTempWorkspace();
  try {
    // Prepare compiled catalog artifacts + mock @agy-market/catalog .tgz
    const sampleTar = createDeterministicTarGz({
      'plugin.json': JSON.stringify({
        name: 'prism-skin',
        displayName: 'Prism Skin',
        description: 'Glass theme via CDP.',
        version: '1.0.0',
        logo: 'assets/logo.svg',
      }),
      'assets/logo.svg': CLEAN_SVG,
      'sidecars/studio/sidecar.json': JSON.stringify({ command: 'node', args: ['main.mjs'], has_web_ui: true }),
      'sidecars/studio/main.mjs': `const x = '--remote-debugging-port=9339';`,
    });

    const entry = validateSingleEntryFile(
      'alice__prism-skin.yml',
      `url: https://github.com/alice/prism-skin\ncategory: ui-themes\ndescription:\n  zh: 棱镜毛玻璃皮肤\n  en: Prism glass skin.\n`,
    );
    const approved = evaluateSubmission({
      entry,
      repoMeta: { id: 301, owner: { id: 31, login: 'alice' }, full_name: 'alice/prism-skin', created_at: '2026-10-01T00:00:00Z', stargazers_count: 150 },
      commits: makeCommits(),
      releaseInfo: { tagName: 'v1.0.0', commitSha: COMMIT_1, tarballUrl: 'https://example.com/prism-skin.tar.gz' },
      tarballBuffer: sampleTar,
      ledger: { schemaVersion: 1, entries: {} },
      versionsLock: { schemaVersion: 1, locks: {} },
      nowMs: Date.parse('2026-11-23T12:00:00Z'),
    });

    const compiled = compileCatalogArtifacts({
      entries: [entry],
      ledger: approved.ledger,
      versionsLock: approved.versionsLock,
    });

    // 1. Test ETag 304 revalidation on primary channel
    let etagSawIfNoneMatch = false;
    const primaryFetchMock = async (url, init = {}) => {
      if (String(url).endsWith('/index.json')) {
        if (init.headers?.['If-None-Match'] === '"v1-etag"') {
          etagSawIfNoneMatch = true;
          return new Response(null, { status: 304 });
        }
        return new Response(JSON.stringify(compiled.indexJson), {
          status: 200,
          headers: { etag: '"v1-etag"', 'content-type': 'application/json' },
        });
      }
      return new Response('{}', { status: 404 });
    };

    const firstLoad = await resolveMarketCatalog({
      dataDir: ws.dataDir,
      prefs: { enableExperimentalTrack2: false },
      fetchImpl: primaryFetchMock,
    });
    assert.equal(firstLoad.channelUsed, 'github-pages');
    assert.equal(firstLoad.plugins.length, 1);

    const secondLoad = await resolveMarketCatalog({
      dataDir: ws.dataDir,
      prefs: { enableExperimentalTrack2: false },
      fetchImpl: primaryFetchMock,
    });
    assert.equal(etagSawIfNoneMatch, true);
    assert.equal(secondLoad.channelUsed, 'github-pages-304');
    assert.equal(secondLoad.plugins.length, 1);

    // 1b. Test GitHub Pages 404 -> automatic raw.githubusercontent.com/.../gh-pages fallback before npm mirrors
    const wsRawFallback = makeTempWorkspace('agy-raw-gh-pages-');
    try {
      const rawFallbackMock = async (url) => {
        const u = String(url);
        if (u.startsWith('https://azwosile.github.io/agy-market-catalog')) {
          return new Response('Not Found', { status: 404 });
        }
        if (u === 'https://raw.githubusercontent.com/azwosile/agy-market-catalog/gh-pages/index.json') {
          return new Response(JSON.stringify(compiled.indexJson), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        throw new Error(`Unexpected URL during raw gh-pages fallback: ${u}`);
      };

      const rawLoad = await resolveMarketCatalog({
        dataDir: wsRawFallback.dataDir,
        prefs: { enableExperimentalTrack2: false },
        fetchImpl: rawFallbackMock,
      });
      assert.equal(rawLoad.channelUsed, 'github-raw-gh-pages');
      assert.equal(rawLoad.plugins.length, 1);
      assert.equal(rawLoad.warnings.length, 0);
    } finally {
      wsRawFallback.cleanup();
    }

    // 2. Test primary timeout/failure -> China @agy-market/catalog npm mirror .tgz fallback!
    const wsChina = makeTempWorkspace('agy-china-');
    try {
      const mirrorTgz = createDeterministicTarGz({
        'package/dist/index.json': JSON.stringify(compiled.indexJson),
        'package/dist/unverified-index.json': JSON.stringify(compiled.unverifiedIndexJson),
        'package/dist/readmes.json': JSON.stringify(compiled.readmesJson),
      });
      const tgzFile = join(wsChina.artifactsDir, 'catalog.tgz');
      writeFileSync(tgzFile, mirrorTgz);

      const mirrorFetchMock = async (url) => {
        const u = String(url);
        if (
          u.startsWith('https://azwosile.github.io/agy-market-catalog') ||
          u.startsWith('https://raw.githubusercontent.com/azwosile/agy-market-catalog/gh-pages')
        ) {
          throw new Error('ConnectTimeoutError: GitHub Pages unreachable');
        }
        if (u.includes('registry.npmmirror.com')) {
          return new Response(
            JSON.stringify({
              name: '@agy-market/catalog',
              version: '2026.1123.1',
              dist: { tarball: pathToFileURL(tgzFile).href },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        throw new Error(`Unexpected URL: ${u}`);
      };

      const fallbackLoad = await resolveMarketCatalog({
        dataDir: wsChina.dataDir,
        includeReadmes: true,
        fetchImpl: mirrorFetchMock,
      });
      assert.match(fallbackLoad.channelUsed, /^npm-mirror/);
      assert.equal(fallbackLoad.plugins[0].canonicalName, 'prism-skin');
      assert.ok(fallbackLoad.plugins[0].capabilities.badges.includes('host-enhancement'));
    } finally {
      wsChina.cleanup();
    }
  } finally {
    ws.cleanup();
  }
});


test('Installer enforces SHA-256 tamper protection, Track-2 <owner>--<slug> rewrite, local collision modal, escalation guard & Windows EBUSY lock-safe sync', async () => {
  const ws = makeTempWorkspace();
  try {
    // Build v1.0.0 tarball with preservePaths + binary helper.exe
    const v1Tar = createDeterministicTarGz({
      'plugin.json': JSON.stringify({
        name: 'code-lens',
        displayName: 'Code Lens',
        description: 'Fast code insights.',
        version: '1.0.0',
        logo: 'assets/logo.svg',
      }),
      'assets/logo.svg': CLEAN_SVG,
      'user-prefs.json': JSON.stringify({ theme: 'default' }),
      'bin/helper.exe': Buffer.from('MZ_V1_BINARY'),
      'stale-v1.txt': 'remove me on v2',
      'skills/code-lens/SKILL.md': '---\nname: code-lens\n---\nOpen [Manage](customization://code-lens) or [Pane](sidecar://code-lens/view/)',
    });
    const v1TarPath = join(ws.artifactsDir, 'code-lens-1.0.0.tar.gz');
    writeFileSync(v1TarPath, v1Tar);
    const v1Sha = createHash('sha256').update(v1Tar).digest('hex');

    const v1Plugin = {
      id: 'alice__code-lens',
      canonicalName: 'code-lens',
      scopedName: 'alice--code-lens',
      forceScopedInstall: false,
      displayName: 'Code Lens',
      description: { zh: '代码洞察', en: 'Code insights' },
      version: '1.0.0',
      gitTag: 'v1.0.0',
      commitSha: COMMIT_1,
      repository: { url: 'https://github.com/alice/code-lens', repositoryId: 501, ownerId: 51, stars: 20, pluginRoot: '.' },
      distribution: {
        tarballUrl: pathToFileURL(v1TarPath).href,
        sha256: v1Sha,
        sizeBytes: v1Tar.length,
        preservePaths: ['user-prefs.json'],
      },
      capabilities: {
        badges: ['declarative-only'],
        rulesEstimatedTokens: 0,
        mcpServers: [],
        mcpRemoteDomains: [],
        hookEvents: [],
        hostEnhancementKind: [],
      },
    };

    const occupied = join(ws.pluginsDir, 'other-directory');
    mkdirSync(occupied);
    writeFileSync(join(occupied, 'plugin.json'), JSON.stringify({ name: 'code-lens', version: '0.1.0' }));
    await assert.rejects(installOrUpdateCatalogPlugin({
      plugin: { ...v1Plugin, canonicalName: 'catalog-label' }, configDir: ws.configDir, dataDir: ws.dataDir,
    }), /ERR_UPDATE_TARGET_MISMATCH/);
    assert.equal(existsSync(join(ws.pluginsDir, 'catalog-label')), false);
    assert.equal(JSON.parse(readFileSync(join(occupied, 'plugin.json'))).version, '0.1.0');
    rmSync(occupied, { recursive: true });

    // 1. Tampered SHA-256 must hard-abort with INTEGRITY_SHA256_MISMATCH
    await assert.rejects(
      () =>
        installOrUpdateCatalogPlugin({
          plugin: {
            ...v1Plugin,
            distribution: { ...v1Plugin.distribution, sha256: 'f'.repeat(64) },
          },
          configDir: ws.configDir,
          dataDir: ws.dataDir,
        }),
      /INTEGRITY_SHA256_MISMATCH/,
    );
    assert.equal(existsSync(join(ws.pluginsDir, 'code-lens')), false);

    // 2. Clean Track-1 native install -> active immediately at `<pluginsDir>/code-lens`
    const resV1 = await installOrUpdateCatalogPlugin({
      plugin: v1Plugin,
      configDir: ws.configDir,
      dataDir: ws.dataDir,
    });
    assert.equal(resV1.ok, true);
    assert.equal(resV1.installedDir, 'code-lens');
    assert.equal(resV1.scopedRewriteApplied, false);

    // Simulate user customizing preserved file `user-prefs.json`
    writeFileSync(join(ws.pluginsDir, 'code-lens', 'user-prefs.json'), JSON.stringify({ theme: 'obsidian-custom' }));

    // 3. Build v2.0.0 tarball that adds `hooks.json` + `mcp-remote` (capability escalation!) and updates `bin/helper.exe`
    const v2Tar = createDeterministicTarGz({
      'plugin.json': JSON.stringify({
        name: 'code-lens',
        displayName: 'Code Lens',
        description: 'Fast code insights v2.',
        version: '2.0.0',
        logo: 'assets/logo.svg',
      }),
      'assets/logo.svg': CLEAN_SVG,
      'user-prefs.json': JSON.stringify({ theme: 'factory-reset-attempt' }),
      'bin/helper.exe': Buffer.from('MZ_V2_BINARY_NEW'),
      'hooks.json': JSON.stringify({ hooks: { SessionStart: [] } }),
      'mcp_config.json': JSON.stringify({ mcpServers: { cloud: { url: 'https://mcp.codelens.dev/sse' } } }),
    });
    const v2TarPath = join(ws.artifactsDir, 'code-lens-2.0.0.tar.gz');
    writeFileSync(v2TarPath, v2Tar);
    const v2Sha = createHash('sha256').update(v2Tar).digest('hex');

    const v2Plugin = {
      ...v1Plugin,
      version: '2.0.0',
      gitTag: 'v2.0.0',
      commitSha: COMMIT_2,
      distribution: {
        ...v1Plugin.distribution,
        tarballUrl: pathToFileURL(v2TarPath).href,
        sha256: v2Sha,
        sizeBytes: v2Tar.length,
      },
      capabilities: {
        badges: ['mcp-remote', 'lifecycle-hooks'],
        rulesEstimatedTokens: 0,
        mcpServers: ['code-lens_cloud'],
        mcpRemoteDomains: ['mcp.codelens.dev'],
        hookEvents: ['SessionStart'],
        hostEnhancementKind: [],
      },
    };

    // Without confirmEscalation -> must pause and return CAPABILITY_ESCALATION_CONFIRM_REQUIRED
    const paused = await installOrUpdateCatalogPlugin({
      plugin: v2Plugin,
      configDir: ws.configDir,
      dataDir: ws.dataDir,
      confirmEscalation: false,
    });
    assert.equal(paused.ok, false);
    assert.equal(paused.status, 'CAPABILITY_ESCALATION_CONFIRM_REQUIRED');
    assert.deepEqual(paused.escalation.addedBadges, ['mcp-remote', 'lifecycle-hooks']);
    assert.deepEqual(paused.escalation.addedRemoteDomains, ['mcp.codelens.dev']);

    // Confirm escalation + simulate Windows EBUSY lock on `bin/helper.exe`!
    let simulatedLockHit = false;
    const resV2 = await installOrUpdateCatalogPlugin({
      plugin: v2Plugin,
      configDir: ws.configDir,
      dataDir: ws.dataDir,
      confirmEscalation: true, approvalKey: paused.escalation.approvalKey,
      writeOverride(src, dst, rel) {
        if (rel === 'bin/helper.exe' && !simulatedLockHit) {
          simulatedLockHit = true;
          const err = new Error('EBUSY: resource busy or locked');
          err.code = 'EBUSY';
          throw err;
        }
        copyFileSync(src, dst);
      },
    });

    assert.equal(resV2.ok, true);
    assert.equal(simulatedLockHit, true);
    assert.equal(resV2.retiredBinaries.length, 1);
    assert.equal(readFileSync(join(ws.pluginsDir, 'code-lens', 'bin', 'helper.exe'), 'utf8'), 'MZ_V2_BINARY_NEW');
    assert.equal(
      JSON.parse(readFileSync(join(ws.pluginsDir, 'code-lens', 'user-prefs.json'), 'utf8')).theme,
      'obsidian-custom',
      'preservePaths must retain user-prefs.json across updates',
    );
    assert.equal(existsSync(join(ws.pluginsDir, 'code-lens', 'stale-v1.txt')), false, 'stale v1 files must be removed');

    // Sweep retired `*.old.<ts>` binary once handle is closed
    const gc = sweepRetiredBinaries(ws.dataDir);
    assert.equal(gc.removed, 1);
    assert.equal(gc.remaining, 0);

    // 4. Foreign local collision on `code-lens` by a DIFFERENT author -> CONFLICT_CHOICE_REQUIRED, then isolated install!
    const rivalPlugin = {
      ...v1Plugin,
      id: 'bob__code-lens',
      scopedName: 'bob--code-lens',
      repository: { url: 'https://github.com/bob/code-lens', repositoryId: 999, ownerId: 99, stars: 5, pluginRoot: '.' },
    };
    const conflictCheck = await installOrUpdateCatalogPlugin({
      plugin: rivalPlugin,
      configDir: ws.configDir,
      dataDir: ws.dataDir,
      conflictStrategy: 'prompt',
    });
    assert.equal(conflictCheck.status, 'CONFLICT_CHOICE_REQUIRED');
    assert.equal(conflictCheck.scopedFallbackName, 'bob--code-lens');

    const isolatedInstall = await installOrUpdateCatalogPlugin({
      plugin: rivalPlugin,
      configDir: ws.configDir,
      dataDir: ws.dataDir,
      conflictStrategy: 'isolate',
    });
    assert.equal(isolatedInstall.ok, true);
    assert.equal(isolatedInstall.installedDir, 'bob--code-lens');
    const scopedManifest = JSON.parse(readFileSync(join(ws.pluginsDir, 'bob--code-lens', 'plugin.json'), 'utf8'));
    assert.equal(scopedManifest.name, 'bob--code-lens');
    assert.equal(scopedManifest.displayName, 'Code Lens');
    const scopedSkill = readFileSync(join(ws.pluginsDir, 'bob--code-lens', 'skills', 'code-lens', 'SKILL.md'), 'utf8');
    assert.ok(scopedSkill.includes('customization://bob--code-lens'));
    assert.ok(scopedSkill.includes('sidecar://bob--code-lens/view/'));

    // 5. Track-2 Experimental plugin -> automatically scoped without prompting!
    const track2Rec = buildTrack2PluginRecord({
      repoMeta: {
        id: 808,
        name: 'code-lens',
        full_name: 'Exp-Lab/code-lens',
        html_url: 'https://github.com/Exp-Lab/code-lens',
        owner: { id: 88, login: 'Exp-Lab' },
      },
      releaseInfo: {
        tagName: 'v1.0.0',
        commitSha: COMMIT_1,
        tarballUrl: pathToFileURL(v1TarPath).href,
      },
      tarballBuffer: v1Tar,
    });
    const t2Res = await installOrUpdateCatalogPlugin({
      plugin: track2Rec.pluginEntry,
      configDir: ws.configDir,
      dataDir: ws.dataDir,
    });
    assert.equal(t2Res.installedDir, 'exp-lab--code-lens');
    assert.equal(t2Res.scopedRewriteApplied, true);

    // 6. Crash-recovery journal completes interrupted forward staging on boot
    const interruptedStaging = join(ws.dataDir, 'staging', 'crash-test', 'bundle');
    mkdirSync(interruptedStaging, { recursive: true });
    writeFileSync(
      join(interruptedStaging, 'plugin.json'),
      JSON.stringify({ name: 'recovered-plug', description: 'Recovered after crash' }),
    );
    writePendingJournal(ws.dataDir, {
      op: 'install-native',
      dir: 'recovered-plug',
      stagingRootDir: join(ws.dataDir, 'staging', 'crash-test'),
      stagingBundleDir: interruptedStaging,
      preservePaths: [],
      receipt: { schemaVersion: 1, id: 'x__recovered-plug', installedDir: 'recovered-plug', installedVersion: '1.0.0' },
    });
    const recOut = recoverInterruptedJournal({ dataDir: ws.dataDir, pluginsDir: ws.pluginsDir });
    assert.equal(recOut.recovered, true);
    assert.equal(recOut.action, 'completed-forward');
    assert.equal(existsSync(join(ws.pluginsDir, 'recovered-plug', 'plugin.json')), true);
  } finally {
    ws.cleanup();
  }
});


test('Sidecar HTTP server enforces X-Sidecar-Token & Origin CSRF guards and CLI bootstrap passes doctor', async () => {
  const ws = makeTempWorkspace();
  try {
    const feedPath = join(ws.artifactsDir, 'custom-index.json');
    writeFileSync(
      feedPath,
      JSON.stringify({
        schemaVersion: 1,
        track: 'verified',
        catalogVersion: '2026.1123.9',
        plugins: [],
      }),
    );

    const srv = await createMarketSidecarServer({
      listen: false,
      configDir: ws.configDir,
      dataDir: ws.dataDir,
      recoveryDelayMs: -1,
      fetchImpl: async () => new Response(JSON.stringify({ schemaVersion: 1, plugins: [] }), { status: 200 }),
    });

    try {
      const health = await srv.inject({ method: 'GET', url: '/healthz' });
      assert.equal(health.statusCode, 200);
      assert.equal(health.json().plugin, 'agy-market');

      const wrongHost = await srv.inject({ url: '/', headers: { Host: 'catalog.example' } });
      assert.equal(wrongHost.statusCode, 403);
      assert.equal(wrongHost.text.includes(srv.sideToken), false);
      const opaque = await srv.inject({ method: 'POST', url: '/api/prefs',
        headers: { Origin: 'null', 'X-Sidecar-Token': srv.sideToken }, body: { locale: 'en' } });
      assert.equal(opaque.statusCode, 403);

      // Missing X-Sidecar-Token -> 403 Forbidden
      const noToken = await srv.inject({
        method: 'POST',
        url: '/api/prefs',
        body: { locale: 'en' },
      });
      assert.equal(noToken.statusCode, 403);
      assert.match(noToken.json().error, /ERR_CSRF_TOKEN/);

      // Evil external Origin header -> 403 Forbidden even with token!
      const badOrigin = await srv.inject({
        method: 'POST',
        url: '/api/prefs',
        headers: {
          'X-Sidecar-Token': srv.sideToken,
          Origin: 'https://evil-attacker.example',
        },
        body: { locale: 'en' },
      });
      assert.equal(badOrigin.statusCode, 403);
      assert.match(badOrigin.json().error, /ERR_CSRF_ORIGIN/);

      // Valid X-Sidecar-Token + loopback Origin -> 200 OK
      const okPrefs = await srv.inject({
        method: 'POST',
        url: '/api/prefs',
        headers: {
          'X-Sidecar-Token': srv.sideToken,
          Origin: 'http://127.0.0.1:54321',
        },
        body: {
          locale: 'en',
          customFeeds: [pathToFileURL(feedPath).href],
        },
      });
      assert.equal(okPrefs.statusCode, 200);
      assert.equal(okPrefs.json().prefs.locale, 'en');

      // Ensure config.json was NEVER created or modified by AGY Market
      assert.equal(existsSync(join(ws.configDir, 'config.json')), false);
    } finally {
      await srv.close();
    }

    const doctor = () => runCli(['doctor', '--dest', ws.pluginsDir, '--json'], { dataDir: ws.dataDir });
    assert.equal((await doctor()).code, 1);
    const emptyDir = join(ws.pluginsDir, 'agy-market');
    mkdirSync(emptyDir);
    assert.equal((await doctor()).code, 1);
    writeFileSync(join(emptyDir, 'plugin.json'), '{broken');
    assert.equal((await doctor()).code, 1);
    const unknown = await runCli(['typo', '--json']);
    assert.equal(unknown.code, 1);
    await assert.rejects(runCli(['install', '--dest', ws.pluginsDir], { dataDir: ws.dataDir }), /ERR_BOOTSTRAP_CONFLICT/);
    assert.equal(readFileSync(join(emptyDir, 'plugin.json'), 'utf8'), '{broken');
    rmSync(join(emptyDir, 'plugin.json'));
    // CLI install + doctor check into isolated pluginsDir
    const cliInstall = await runCli(['install', '--dest', ws.pluginsDir, '--json'], { dataDir: ws.dataDir });
    assert.equal(cliInstall.code, 0);
    const selfDir = join(ws.pluginsDir, 'agy-market');
    writeFileSync(join(selfDir, '.agy-market-receipt.json'), '{');
    writeFileSync(join(selfDir, 'user-notes.txt'), 'keep');
    assert.equal((await runCli(['install', '--dest', ws.pluginsDir, '--json'], { dataDir: ws.dataDir })).code, 0);
    assert.equal(readFileSync(join(selfDir, 'user-notes.txt'), 'utf8'), 'keep');
    assert.ok(Array.isArray(JSON.parse(readFileSync(join(selfDir, '.agy-market-receipt.json'))).managedFiles));
    const cliDoctor = await doctor();
    assert.equal(cliDoctor.code, 0);
  } finally {
    ws.cleanup();
  }
});


test('Real-world plugin manifest compatibility: author string/object, repo {type,url}/README fallback, PNG logo & custom sidecar path', async () => {
  const ws = makeTempWorkspace('agy-real-compat-');
  try {
    // 1. agy-dart shape: repository { type, url } + author { name, url }
    const dartDir = join(ws.pluginsDir, 'agy-dart');
    mkdirSync(join(dartDir, 'sidecars', 'dashboard'), { recursive: true });
    writeFileSync(
      join(dartDir, 'plugin.json'),
      JSON.stringify({
        name: 'agy-dart',
        displayName: 'agy-dart',
        version: '1.6.0',
        logo: 'assets/logo.svg',
        author: { name: 'zou172866', url: 'https://github.com/zou172866' },
        repository: { type: 'git', url: 'https://github.com/zou172866/agy-dart.git' },
      }),
    );
    writeFileSync(
      join(dartDir, 'sidecars', 'dashboard', 'sidecar.json'),
      JSON.stringify({
        command: 'node',
        args: ['server.mjs'],
        has_web_ui: true,
        ui_config: { views: [{ path: '/', entrypoint: 'SIDECAR_UI_ENTRYPOINT_AUX_PANE', title: 'agy-dart Context' }] },
      }),
    );

    // 2. agy-wallpaper-prism shape: author as plain string + repository as string
    const prismDir = join(ws.pluginsDir, 'agy-wallpaper-prism');
    mkdirSync(prismDir, { recursive: true });
    writeFileSync(
      join(prismDir, 'plugin.json'),
      JSON.stringify({
        name: 'agy-wallpaper-prism',
        displayName: 'Wallpaper Prism',
        version: '2.0.3',
        logo: 'assets/logo.svg',
        author: 'Antigravity Prism Contributors',
        repository: 'https://github.com/azwosile/agy-wallpaper-prism',
      }),
    );

    // 3. gemini-neko-cockpit shape: no author/repository in plugin.json, ./assets/logo.png, README badge URL, /ui.html sidecar view
    const nekoDir = join(ws.pluginsDir, 'gemini-neko-cockpit');
    mkdirSync(join(nekoDir, 'sidecars', 'neko-cockpit'), { recursive: true });
    const rawNekoManifest = {
      name: 'gemini-neko-cockpit',
      displayName: 'Gemini 猫娘观察台 · Antigravity Observer',
      version: '1.2.0',
      logo: './assets/logo.png',
    };
    const sanitizedNeko = sanitizeNativePluginManifest(rawNekoManifest);
    assert.equal(sanitizedNeko.logo, 'assets/logo.png');
    writeFileSync(join(nekoDir, 'plugin.json'), JSON.stringify(rawNekoManifest));
    writeFileSync(
      join(nekoDir, 'README.md'),
      '# Antigravity Observer\n[![version](https://img.shields.io/badge/v1.2.0-blue)](https://github.com/yunjuanyunshu114-byte/antigravity-observer/releases)\n',
    );
    writeFileSync(
      join(nekoDir, 'sidecars', 'neko-cockpit', 'sidecar.json'),
      JSON.stringify({
        command: 'node',
        args: ['server.cjs'],
        has_web_ui: true,
        ui_config: {
          views: [{ path: '/ui.html', entrypoint: 'SIDECAR_UI_ENTRYPOINT_AUX_PANE', title: '上下文与额度观察' }],
        },
      }),
    );

    const inv = scanLocalPluginInventory({ configDir: ws.configDir });
    const byDir = new Map(inv.installed.map((x) => [x.dir, x]));

    assert.equal(byDir.get('agy-dart').repositoryUrl, 'https://github.com/zou172866/agy-dart');
    assert.equal(byDir.get('agy-dart').author, 'zou172866');
    assert.equal(byDir.get('agy-dart').sidecarPane.uri, 'sidecar://agy-dart/dashboard/');

    assert.equal(byDir.get('agy-wallpaper-prism').repositoryUrl, 'https://github.com/azwosile/agy-wallpaper-prism');
    assert.equal(byDir.get('agy-wallpaper-prism').author, 'Antigravity Prism Contributors');

    assert.equal(
      byDir.get('gemini-neko-cockpit').repositoryUrl,
      'https://github.com/yunjuanyunshu114-byte/antigravity-observer',
    );
    assert.equal(byDir.get('gemini-neko-cockpit').logo, 'assets/logo.png');
    assert.equal(
      byDir.get('gemini-neko-cockpit').sidecarPane.uri,
      'sidecar://gemini-neko-cockpit/neko-cockpit/ui.html',
    );

    const preflightNeko = resolveInstallPreflight(
      {
        id: 'yunjuanyunshu114-byte__antigravity-observer',
        canonicalName: 'gemini-neko-cockpit',
        scopedName: 'yunjuanyunshu114-byte--gemini-neko-cockpit',
        forceScopedInstall: false,
        repository: {
          url: 'https://github.com/yunjuanyunshu114-byte/antigravity-observer',
          repositoryId: 777,
        },
      },
      inv,
    );
    assert.equal(preflightNeko.action, 'conflict-prompt');
    assert.equal(preflightNeko.conflict.dir, 'gemini-neko-cockpit');
    const broken = join(ws.pluginsDir, 'unrelated');
    mkdirSync(broken);
    writeFileSync(join(broken, 'plugin.json'), 'null');
    const fresh = scanLocalPluginInventory({ configDir: ws.configDir, bypassCache: true });
    assert.ok(fresh.installed.some(loc => loc.dir === 'agy-dart'));
    assert.ok(!fresh.installed.some(loc => loc.dir === 'unrelated'));
    const reader = join(ws.pluginsDir, 'reader');
    mkdirSync(reader);
    writeFileSync(join(reader, 'plugin.json'), JSON.stringify({ name: 'reader', version: '1.0.0' }));
    writeFileSync(join(reader, 'README.md'), 'Credits: https://github.com/example/reader');
    writeFileSync(join(reader, 'entry.mjs'), 'local work');
    const offer = await installOrUpdateCatalogPlugin({ ...ws,
      plugin: stagedRelease(ws, 'reader', '2.0.0', { 'entry.mjs': 'upstream code' }) });
    assert.equal(offer.status, 'CONFLICT_CHOICE_REQUIRED');
    assert.equal(readFileSync(join(reader, 'entry.mjs'), 'utf8'), 'local work');
  } finally {
    ws.cleanup();
  }
});


test('POSIX PAX multi-record UTF-8 byte-length parser & Windows NTFS extraction + install.ps1 catalog fallback', () => {
  const ws = makeTempWorkspace('agy-pax-boot-');
  try {
    // 1. Direct multi-record UTF-8 PAX buffer verification (Chinese + emoji + subsequent numeric records)
    const utf8RelPath =
      'assets/猫娘挂件_超长多字节路径测试目录_反重力观察台/双击安装观察窗补丁_表情差分立绘_idle_eat_grin_xd_测试文件.txt';
    const rawPaxBlock = Buffer.concat([
      encodePaxRecord('comment', '反重力插件市场 UTF-8 PAX 扩展头测试 🚀'),
      encodePaxRecord('path', utf8RelPath),
      encodePaxRecord('mtime', '1732363200'),
      encodePaxRecord('size', '21'),
    ]);
    const parsedPax = parsePaxRecords(rawPaxBlock);
    assert.equal(parsedPax.comment, '反重力插件市场 UTF-8 PAX 扩展头测试 🚀');
    assert.equal(parsedPax.path, utf8RelPath);
    assert.equal(parsedPax.mtime, '1732363200');
    assert.equal(parsedPax.size, '21');

    // 2. Full PAX .tar.gz archive creation, map parsing, and real NTFS disk extraction (verifies zero trailing \n EINVAL)
    const paxArchive = createDeterministicTarGz(
      {
        'plugin.json': JSON.stringify({ name: 'pax-utf8-plugin', version: '1.0.1' }),
        [utf8RelPath]: 'UTF8_PAX_PAYLOAD_OK',
        '双击安装观察窗补丁.bat': '@echo off\r\necho ok\r\n',
      },
      { forcePax: true },
    );
    const paxMap = parseTarGzToMap(paxArchive);
    assert.equal(paxMap.has(utf8RelPath), true);
    assert.equal(paxMap.get(utf8RelPath).toString('utf8'), 'UTF8_PAX_PAYLOAD_OK');

    const extractedDir = join(ws.artifactsDir, 'pax-extracted');
    extractTarGzToDir(paxArchive, extractedDir);
    assert.equal(readFileSync(join(extractedDir, utf8RelPath), 'utf8'), 'UTF8_PAX_PAYLOAD_OK');
    assert.equal(existsSync(join(extractedDir, '双击安装观察窗补丁.bat')), true);

    // 3. Test scripts/install.ps1 404 release fallback -> catalog index.json -> nested top-dir tarball unwrap & SHA-256 verification
    if (process.platform === 'win32') {
      const nestedTagTar = createDeterministicTarGz({
        'agy-market-1.0.1/plugin.json': JSON.stringify({
          name: 'agy-market',
          displayName: 'AGY Market · 反重力插件市场',
          version: '1.0.1',
        }),
        'agy-market-1.0.1/sidecars/market_pane/index.html': '<!doctype html><title>AGY Market</title>',
      });
      const nestedTarPath = join(ws.artifactsDir, 'agy-market-tag-v1.0.1.tar.gz');
      writeFileSync(nestedTarPath, nestedTagTar);
      const nestedSha = createHash('sha256').update(nestedTagTar).digest('hex');

      const mockCatalogPath = join(ws.artifactsDir, 'mock-catalog-index.json');
      writeFileSync(
        mockCatalogPath,
        JSON.stringify({
          schemaVersion: 1,
          track: 'verified',
          plugins: [
            {
              id: 'azwosile__agy-market',
              canonicalName: 'agy-market',
              version: '1.0.1',
              repository: { repositoryId: 1468650761 },
              distribution: {
                tarballUrl: pathToFileURL(nestedTarPath).href,
                sha256: nestedSha,
              },
            },
          ],
        }),
      );

      const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
      const ps1Script = join(repoRoot, 'scripts', 'install.ps1');
      const ps1Bytes = readFileSync(ps1Script);
      assert.equal(
        ps1Bytes.length >= 3 && ps1Bytes[0] === 0xef && ps1Bytes[1] === 0xbb && ps1Bytes[2] === 0xbf,
        false,
        'scripts/install.ps1 must not have a UTF-8 BOM (breaks irm ... | iex with param block)',
      );
      execFileSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-Command',
          '[scriptblock]::Create([System.Text.Encoding]::UTF8.GetString([System.IO.File]::ReadAllBytes($env:AGY_PS1_PATH))) | Out-Null',
        ],
        {
          env: { ...scrubChildProcessEnv(process.env), AGY_PS1_PATH: ps1Script },
          stdio: 'pipe',
        },
      );
      const missingReleaseBase = pathToFileURL(join(ws.artifactsDir, 'missing-release-404')).href;

      execFileSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          ps1Script,
          '-ReleaseBaseUrl',
          missingReleaseBase,
          '-CatalogUrls',
          pathToFileURL(mockCatalogPath).href,
        ],
        {
          env: { ...scrubChildProcessEnv(process.env), ANTIGRAVITY_CONFIG_DIR: ws.configDir },
          stdio: 'pipe',
        },
      );

      const installedTarget = join(ws.pluginsDir, 'agy-market');
      assert.equal(existsSync(join(installedTarget, 'plugin.json')), true);
      assert.equal(existsSync(join(installedTarget, 'sidecars', 'market_pane', 'index.html')), true);
      const bootReceipt = JSON.parse(readFileSync(join(installedTarget, '.agy-market-receipt.json'), 'utf8'));
      assert.equal(bootReceipt.id, 'azwosile__agy-market');
      assert.equal(bootReceipt.installedVersion, '1.0.1');
      assert.equal(bootReceipt.repositoryId, 1468650761);
      assert.equal(bootReceipt.sha256, nestedSha);
    }
  } finally {
    ws.cleanup();
  }
});

function buildTarGzWithGlobalPax(entries, { globalPaxComment = '' } = {}) {
  const chunks = [];
  const makeHeader = (name, size, typeFlag = '0') => {
    const h = Buffer.alloc(512, 0);
    h.write(name, 0, Math.min(100, Buffer.byteLength(name)), 'utf8');
    h.write('0000644\0', 100, 8, 'ascii');
    h.write('0000000\0', 108, 8, 'ascii');
    h.write('0000000\0', 116, 8, 'ascii');
    h.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 12, 'ascii');
    h.write('00000000000\0', 136, 12, 'ascii');
    h.fill(0x20, 148, 156);
    h.write(typeFlag, 156, 1, 'ascii');
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
  if (globalPaxComment) {
    const paxPayload = encodePaxRecord('comment', globalPaxComment);
    chunks.push(makeHeader('pax_global_header', paxPayload.length, 'g'));
    pushPadded(paxPayload);
  }
  for (const [relPath, content] of Object.entries(entries)) {
    const buf = Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8');
    chunks.push(makeHeader(relPath, buf.length, '0'));
    pushPadded(buf);
  }
  chunks.push(Buffer.alloc(1024, 0));
  return gzipSync(Buffer.concat(chunks), { level: 6 });
}

test('fetchVerifiedPluginTarball hardens commit-pinned GitHub archive fallback with catalog-pinned archive digests', async () => {
  const commitSha = 'eb55259f0e17ec75794e7a3fad411a177eb94bb7';
  const otherCommitSha = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

  // Strict URL validation & lowercase commitSha normalization
  assert.equal(
    resolveMutableTagCommitFallbackUrl({
      commitSha: commitSha.toUpperCase(),
      distribution: { tarballUrl: 'https://github.com/zou172866/agy-dart/archive/refs/tags/v1.7.0.tar.gz' },
    }),
    `https://github.com/zou172866/agy-dart/archive/${commitSha}.tar.gz`,
  );
  assert.equal(
    resolveMutableTagCommitFallbackUrl({
      commitSha,
      distribution: { tarballUrl: 'https://github.com/zou172866/agy-dart/releases/download/v1.7.0/agy-dart.tar.gz' },
    }),
    null,
  );
  assert.equal(
    resolveMutableTagCommitFallbackUrl({
      commitSha: 'not-a-sha',
      distribution: { tarballUrl: 'https://github.com/zou172866/agy-dart/archive/refs/tags/v1.7.0.tar.gz' },
    }),
    null,
  );
  for (const badUrl of [
    'https://github.com/evil/repo?x=1/archive/refs/tags/v1.0.0.tar.gz',
    'https://github.com/evil/repo#frag/archive/refs/tags/v1.0.0.tar.gz',
    'https://github.com/../repo/archive/refs/tags/v1.0.0.tar.gz',
    'https://github.com/evil/../archive/refs/tags/v1.0.0.tar.gz',
    'https://github.com/evil/./archive/refs/tags/v1.0.0.tar.gz',
    'https://github.com/-bad/repo/archive/refs/tags/v1.0.0.tar.gz',
  ]) {
    assert.equal(
      resolveMutableTagCommitFallbackUrl({ commitSha, distribution: { tarballUrl: badUrl } }),
      null,
      `Must reject malformed fallback source URL: ${badUrl}`,
    );
  }

  const stageRoot = mkdtempSync(join(tmpdir(), 'agy-commit-fb-'));
  try {
    const manifestJson = JSON.stringify({ name: 'agy-dart', version: '1.7.0' });
    const expectedOldPayload = createDeterministicTarGz({
      'agy-dart-1.7.0/plugin.json': manifestJson,
      'agy-dart-1.7.0/README.md': '# original tag archive',
    });
    const driftedTagPayload = createDeterministicTarGz({
      'agy-dart-1.7.0/plugin.json': manifestJson,
      'agy-dart-1.7.0/README.md': '# drifted tag archive',
    });
    const validCommitPayload = buildTarGzWithGlobalPax(
      {
        [`agy-dart-${commitSha}/plugin.json`]: manifestJson,
        [`agy-dart-${commitSha}/README.md`]: '# immutable commit archive',
      },
      { globalPaxComment: commitSha },
    );
    const forgedNoPaxPayload = createDeterministicTarGz({
      [`agy-dart-${commitSha}/plugin.json`]: manifestJson,
      [`agy-dart-${commitSha}/README.md`]: '# forged archive missing PAX comment',
    });
    const forgedWrongPaxPayload = buildTarGzWithGlobalPax(
      {
        [`agy-dart-${commitSha}/plugin.json`]: manifestJson,
        [`agy-dart-${commitSha}/README.md`]: '# forged archive wrong PAX comment',
      },
      { globalPaxComment: otherCommitSha },
    );

    const expectedSha = createHash('sha256').update(expectedOldPayload).digest('hex');
    const validCommitSha256 = createHash('sha256').update(validCommitPayload).digest('hex');

    // 1. Tag drift (INTEGRITY_SHA256_MISMATCH on direct github.com) -> digest-pinned commit fallback succeeds & forwards auth header
    const requestedUrls = [];
    const seenAuthHeaders = {};
    const mockFetchDrift = async (url, init = {}) => {
      const sUrl = String(url);
      requestedUrls.push(sUrl);
      seenAuthHeaders[sUrl] = init?.headers?.Authorization || '';
      if (sUrl.includes('/archive/refs/tags/')) {
        return new Response(driftedTagPayload, { status: 200 });
      }
      if (sUrl.includes(`/archive/${commitSha}.tar.gz`)) {
        return new Response(validCommitPayload, { status: 200 });
      }
      return new Response('not found', { status: 404 });
    };

    const driftResult = await fetchVerifiedPluginTarball({
      plugin: {
        id: 'zou172866__agy-dart',
        version: '1.7.0',
        commitSha,
        distribution: {
          tarballUrl: 'https://github.com/zou172866/agy-dart/archive/refs/tags/v1.7.0.tar.gz',
          sha256: expectedSha,
          commitFallbackSha256: validCommitSha256,
        },
      },
      stagingDir: join(stageRoot, 'stage-1'),
      stagingArchivePath: join(stageRoot, 'stage-1', 'archive.tar.gz'),
      prefs: { githubToken: 'mock-fallback-auth-token' },
      fetchImpl: mockFetchDrift,
    });

    assert.equal(driftResult.channelUsed, 'github-commit-fallback');
    assert.equal(driftResult.urlUsed, `https://github.com/zou172866/agy-dart/archive/${commitSha}.tar.gz`);
    assert.equal(driftResult.sha256, validCommitSha256);
    assert.deepEqual(requestedUrls, [
      'https://github.com/zou172866/agy-dart/archive/refs/tags/v1.7.0.tar.gz',
      `https://github.com/zou172866/agy-dart/archive/${commitSha}.tar.gz`,
    ]);
    assert.equal(
      seenAuthHeaders[`https://github.com/zou172866/agy-dart/archive/${commitSha}.tar.gz`],
      'Bearer mock-fallback-auth-token',
    );

    // 2. Tag deleted (HTTP 404 on direct github.com) -> digest-pinned commit fallback succeeds & returns real sha256
    const notFoundResult = await fetchVerifiedPluginTarball({
      plugin: {
        id: 'zou172866__agy-dart',
        version: '1.7.0',
        commitSha,
        distribution: {
          tarballUrl: 'https://github.com/zou172866/agy-dart/archive/refs/tags/v1.7.0.tar.gz',
          sha256: expectedSha,
          commitFallbackSha256: validCommitSha256,
        },
      },
      stagingDir: join(stageRoot, 'stage-404'),
      stagingArchivePath: join(stageRoot, 'stage-404', 'archive.tar.gz'),
      fetchImpl: async (url) => {
        if (String(url).includes('/archive/refs/tags/')) {
          return new Response('Not Found', { status: 404 });
        }
        if (String(url).includes(`/archive/${commitSha}.tar.gz`)) {
          return new Response(validCommitPayload, { status: 200 });
        }
        return new Response('Not Found', { status: 404 });
      },
    });
    assert.equal(notFoundResult.channelUsed, 'github-commit-fallback');
    assert.equal(notFoundResult.sha256, validCommitSha256);

    const noFallbackPin = join(stageRoot, 'stage-no-fallback-pin');
    await assert.rejects(fetchVerifiedPluginTarball({
      plugin: {
        id: 'zou172866__agy-dart', version: '1.7.0', commitSha,
        distribution: { tarballUrl: requestedUrls[0], sha256: expectedSha },
      },
      stagingDir: noFallbackPin,
      stagingArchivePath: join(noFallbackPin, 'archive.tar.gz'),
      fetchImpl: mockFetchDrift,
    }), /INTEGRITY_SHA256_MISMATCH/);
    assert.equal(existsSync(noFallbackPin), false);

    // 3. Forged fallback archive WITHOUT PAX comment MUST be rejected & staging archive deleted
    const forgedStageNoPax = join(stageRoot, 'stage-forged-no-pax');
    const forgedArchiveNoPax = join(forgedStageNoPax, 'archive.tar.gz');
    await assert.rejects(
      fetchVerifiedPluginTarball({
        plugin: {
          id: 'zou172866__agy-dart',
          version: '1.7.0',
          commitSha,
          distribution: {
            tarballUrl: 'https://github.com/zou172866/agy-dart/archive/refs/tags/v1.7.0.tar.gz',
            sha256: expectedSha,
          },
        },
        stagingDir: forgedStageNoPax,
        stagingArchivePath: forgedArchiveNoPax,
        fetchImpl: async (url) => {
          if (String(url).includes('/archive/refs/tags/')) {
            return new Response('Not Found', { status: 404 });
          }
          return new Response(forgedNoPaxPayload, { status: 200 });
        },
      }),
      /INTEGRITY_SHA256_MISMATCH/,
    );
    assert.equal(existsSync(forgedArchiveNoPax), false, 'Forged archive without PAX comment must be deleted');
    assert.equal(existsSync(forgedStageNoPax), false, 'Staging dir must be cleaned up on rejection');

    // 4. Forged fallback archive WITH WRONG PAX comment MUST be rejected & staging archive deleted
    const forgedStageWrongPax = join(stageRoot, 'stage-forged-wrong-pax');
    const forgedArchiveWrongPax = join(forgedStageWrongPax, 'archive.tar.gz');
    await assert.rejects(
      fetchVerifiedPluginTarball({
        plugin: {
          id: 'zou172866__agy-dart',
          version: '1.7.0',
          commitSha,
          distribution: {
            tarballUrl: 'https://github.com/zou172866/agy-dart/archive/refs/tags/v1.7.0.tar.gz',
            sha256: expectedSha,
          },
        },
        stagingDir: forgedStageWrongPax,
        stagingArchivePath: forgedArchiveWrongPax,
        fetchImpl: async (url) => {
          if (String(url).includes('/archive/refs/tags/')) {
            return new Response(driftedTagPayload, { status: 200 });
          }
          return new Response(forgedWrongPaxPayload, { status: 200 });
        },
      }),
      /INTEGRITY_SHA256_MISMATCH/,
    );
    assert.equal(existsSync(forgedArchiveWrongPax), false, 'Forged archive with wrong PAX comment must be deleted');

    // 5. Explicit commitFallbackSha256 lock: matching digest succeeds, mismatched digest fails & cleans up
    const pinnedRes = await fetchVerifiedPluginTarball({
      plugin: {
        id: 'zou172866__agy-dart',
        version: '1.7.0',
        commitSha,
        distribution: {
          tarballUrl: 'https://github.com/zou172866/agy-dart/archive/refs/tags/v1.7.0.tar.gz',
          sha256: expectedSha,
          commitFallbackSha256: validCommitSha256,
        },
      },
      stagingDir: join(stageRoot, 'stage-pinned-ok'),
      stagingArchivePath: join(stageRoot, 'stage-pinned-ok', 'archive.tar.gz'),
      fetchImpl: mockFetchDrift,
    });
    assert.equal(pinnedRes.channelUsed, 'github-commit-fallback');
    assert.equal(pinnedRes.sha256, validCommitSha256);

    const pinnedFailArchive = join(stageRoot, 'stage-pinned-fail', 'archive.tar.gz');
    await assert.rejects(
      fetchVerifiedPluginTarball({
        plugin: {
          id: 'zou172866__agy-dart',
          version: '1.7.0',
          commitSha,
          distribution: {
            tarballUrl: 'https://github.com/zou172866/agy-dart/archive/refs/tags/v1.7.0.tar.gz',
            sha256: expectedSha,
            commitFallbackSha256: 'f'.repeat(64),
          },
        },
        stagingDir: join(stageRoot, 'stage-pinned-fail'),
        stagingArchivePath: pinnedFailArchive,
        fetchImpl: mockFetchDrift,
      }),
      /INTEGRITY_SHA256_MISMATCH/,
    );
    assert.equal(existsSync(pinnedFailArchive), false);

    // 6. Third-party mirror mismatch + direct 500 must NOT trigger commit fallback
    const mirrorOnlyUrls = [];
    await assert.rejects(
      fetchVerifiedPluginTarball({
        plugin: {
          id: 'zou172866__agy-dart',
          version: '1.7.0',
          commitSha,
          distribution: {
            tarballUrl: 'https://github.com/zou172866/agy-dart/archive/refs/tags/v1.7.0.tar.gz',
            sha256: expectedSha,
          },
        },
        stagingDir: join(stageRoot, 'stage-mirror-only'),
        stagingArchivePath: join(stageRoot, 'stage-mirror-only', 'archive.tar.gz'),
        prefs: { githubReleaseMirrorPrefix: 'https://mirror.example.invalid' },
        fetchImpl: async (url) => {
          const sUrl = String(url);
          mirrorOnlyUrls.push(sUrl);
          if (sUrl.startsWith('https://mirror.example.invalid/')) {
            return new Response(driftedTagPayload, { status: 200 });
          }
          return new Response('Upstream error', { status: 500 });
        },
      }),
      /INTEGRITY_SHA256_MISMATCH/,
    );
    assert.equal(
      mirrorOnlyUrls.some((u) => u.includes(`/archive/${commitSha}.tar.gz`)),
      false,
      'Mirror-only mismatch must never trigger commit fallback when direct github.com did not report drift/404',
    );

    // 7. Release assets must STILL strictly fail on SHA-256 mismatch (never fall back)
    await assert.rejects(
      fetchVerifiedPluginTarball({
        plugin: {
          id: 'zou172866__agy-dart',
          version: '1.7.0',
          commitSha,
          distribution: {
            tarballUrl: 'https://github.com/zou172866/agy-dart/releases/download/v1.7.0/agy-dart.tar.gz',
            sha256: expectedSha,
          },
        },
        stagingDir: join(stageRoot, 'stage-2'),
        stagingArchivePath: join(stageRoot, 'stage-2', 'archive.tar.gz'),
        fetchImpl: async () => new Response(driftedTagPayload, { status: 200 }),
      }),
      /INTEGRITY_SHA256_MISMATCH/,
    );

    // 8. Receipt fidelity: buildInstallReceipt & installOrUpdateCatalogPlugin record actual fallback sha256
    const fallbackReceipt = buildInstallReceipt({
      plugin: {
        id: 'zou172866__agy-dart',
        version: '1.7.0',
        commitSha,
        distribution: { sha256: expectedSha },
      },
      installedDir: 'agy-dart',
      effectivePluginName: 'agy-dart',
      actualSha256: validCommitSha256,
    });
    assert.equal(fallbackReceipt.sha256, validCommitSha256);

    const wsInstall = makeTempWorkspace('agy-fallback-receipt-');
    try {
      const installRes = await installOrUpdateCatalogPlugin({
        plugin: {
          id: 'zou172866__agy-dart',
          canonicalName: 'agy-dart',
          displayName: 'AGY Dart',
          version: '1.7.0',
          commitSha,
          repository: { repositoryId: 987654321, url: 'https://github.com/zou172866/agy-dart', pluginRoot: '.' },
          distribution: {
            tarballUrl: 'https://github.com/zou172866/agy-dart/archive/refs/tags/v1.7.0.tar.gz',
            sha256: expectedSha,
            commitFallbackSha256: validCommitSha256,
          },
          capabilities: { badges: [], mcpRemoteDomains: [], hookEvents: [] },
        },
        configDir: wsInstall.configDir,
        dataDir: wsInstall.dataDir,
        fetchImpl: mockFetchDrift,
      });
      assert.equal(installRes.ok, true);
      assert.equal(installRes.channelUsed, 'github-commit-fallback');
      assert.equal(installRes.receipt.sha256, validCommitSha256);
      const writtenReceipt = JSON.parse(
        readFileSync(join(wsInstall.pluginsDir, 'agy-dart', '.agy-market-receipt.json'), 'utf8'),
      );
      assert.equal(writtenReceipt.sha256, validCommitSha256);
    } finally {
      wsInstall.cleanup();
    }
  } finally {
    rmSync(stageRoot, { recursive: true, force: true });
  }
});

test('file extraction retains executable and non-executable modes on POSIX', { skip: process.platform === 'win32' }, async () => {
  const ws = makeTempWorkspace();
  try {
    const archive = join(ws.artifactsDir, 'modes.tar.gz');
    writeFileSync(archive, createDeterministicTarGz({ 'bin/run': 'example', 'bin/empty': '', 'plugin.json': '{}' }));
    for (const [name, extract] of [['stream', extractTarGzStreamToDir], ['buffer', extractTarGzToDir]]) {
      const out = join(ws.root, name);
      await extract(archive, out);
      const expectedExec = 0o111 & ~process.umask();
      for (const file of ['bin/run', 'bin/empty']) assert.equal(statSync(join(out, file)).mode & 0o111, expectedExec);
      assert.equal(statSync(join(out, 'plugin.json')).mode & 0o111, 0);
    }
  } finally { ws.cleanup(); }
});

test('invalid catalog responses use another source and preserve the last usable offline index', async () => {
  const ws = makeTempWorkspace();
  try {
    const options = { dataDir: ws.dataDir, prefs: { networkMode: 'direct', enableExperimentalTrack2: false } };
    const valid = { plugins: [{ id: 'demo__reader', canonicalName: 'demo__reader', version: '1.0.0' }] };
    const resolved = await resolveMarketCatalog({ ...options, fetchImpl: async url =>
      Response.json(String(url).includes('raw.githubusercontent.com') ? valid : { message: 'outage' }) });
    assert.equal(resolved.channelUsed, 'github-raw-gh-pages');
    const offline = await resolveMarketCatalog({ ...options, fetchImpl: async () => Response.json({ plugins: [null] }) });
    assert.equal(offline.channelUsed, 'disk-cache-offline');
    assert.deepEqual(offline.plugins.map(p => p.id), ['demo__reader']);
    const empty = await resolveMarketCatalog({ ...options, fetchImpl: async () => Response.json({ plugins: [] }) });
    assert.equal(empty.channelUsed, 'github-pages');
    assert.deepEqual(empty.plugins, []);
  } finally { ws.cleanup(); }
});

test('a withdrawn custom feed stays withdrawn offline until it publishes a new index', async t => {
  const ws = makeTempWorkspace();
  t.after(ws.cleanup);
  const feed = 'https://company.example/reader/index.json';
  const other = 'https://company.example/tools/index.json';
  const plugin = id => ({ id, canonicalName: id, version: '1.0.0' });
  let status = 200;
  let version = 'old-reader';
  const fetchImpl = async (url, init) => {
    if (url === feed) {
      if (status === 0) throw new Error('offline');
      if (status === 410) return new Response(null, { status });
      if (version === 'new-reader') assert.equal(init.headers['If-None-Match'], undefined);
      return Response.json({ plugins: [plugin(version)] }, { headers: { etag: '"reader"' } });
    }
    return Response.json({ plugins: url === other ? [plugin('tools')] : [] });
  };
  const load = async () => (await resolveMarketCatalog({ dataDir: ws.dataDir,
    prefs: { customFeeds: [feed, other] }, fetchImpl })).plugins.map(p => p.id);
  assert.deepEqual(await load(), ['old-reader', 'tools']);
  // Older versions cached a second copy by position.
  const cache = join(ws.dataDir, 'cache', 'custom-feed-0');
  writeFileSync(cache + '.json', JSON.stringify({ plugins: [plugin('legacy-reader')] }));
  writeFileSync(cache + '.meta.json', JSON.stringify({ url: feed }));
  status = 410;
  assert.deepEqual(await load(), ['tools']);
  status = 0;
  assert.deepEqual(await load(), ['tools']);
  status = 200;
  version = 'new-reader';
  assert.deepEqual(await load(), ['new-reader', 'tools']);
  status = 0;
  assert.deepEqual(await load(), ['new-reader', 'tools']);
});

test('offline primary catalogs, discovery and README data follow the selected feed', async () => {
  const ws = makeTempWorkspace();
  const a = 'https://a.example/catalog';
  const b = 'https://b.example/catalog';
  const offline = async () => { throw new Error('offline'); };
  const options = primaryCatalogUrl => ({ dataDir: ws.dataDir,
    prefs: { primaryCatalogUrl, networkMode: 'direct', enableExperimentalTrack2: true } });
  const load = (url, fetchImpl) => resolveMarketCatalog({ ...options(url), fetchImpl, includeReadmes: true });
  try {
    const fetchSource = async url => {
      const host = new URL(url).hostname[0];
      if (url.includes('/readmes/')) return Response.json({ id: 'common', default: host });
      if (url.endsWith('/readmes.json')) return Response.json({ entries: { common: host } });
      const id = host + (url.endsWith('/unverified-index.json') ? '-experimental' : '-verified');
      return Response.json({ plugins: [{ id, canonicalName: id, version: '1.0.0' }] });
    };
    await load(a, fetchSource);
    await fetchPluginReadme({ ...options(a), id: 'common', fetchImpl: fetchSource });
    const firstB = await load(b, offline);
    assert.deepEqual(firstB.plugins, []);
    assert.equal((await fetchPluginReadme({ ...options(b), id: 'common', fetchImpl: offline })).ok, false);
    await load(b, fetchSource);
    const againA = await load(a, offline);
    assert.deepEqual(againA.plugins.map(p => p.id).sort(), ['a-experimental', 'a-verified']);
    assert.equal((await fetchPluginReadme({ ...options(a), id: 'common', fetchImpl: offline })).default, 'a');
  } finally { ws.cleanup(); }
});

test('PowerShell bootstrap recognizes its interrupted additions and preserves later user edits', { skip: process.platform !== 'win32' }, t => {
  const ws = makeTempWorkspace();
  t.after(ws.cleanup);
  const target = join(ws.pluginsDir, 'agy-market');
  const script = fileURLToPath(new URL('../scripts/install.ps1', import.meta.url));
  const archive = join(ws.artifactsDir, 'agy-market.tar.gz');
  const receiptPath = join(target, '.agy-market-receipt.json');
  function publish(version, files) {
    const tar = createDeterministicTarGz({
      'plugin.json': JSON.stringify({ name: 'agy-market', version, repository: 'https://github.com/azwosile/agy-market' }),
      'z-runtime.mjs': version,
      ...files,
    });
    writeFileSync(archive, tar);
    writeFileSync(archive + '.sha256', createHash('sha256').update(tar).digest('hex'));
  }
  const env = { ...scrubChildProcessEnv(process.env), ANTIGRAVITY_CONFIG_DIR: ws.configDir,
    AGY_MARKET_DATA_DIR: ws.dataDir, BOOT_SCRIPT: script, BOOT_URL: pathToFileURL(ws.artifactsDir).href,
    BOOT_LOCK: join(target, 'z-runtime.mjs') };
  const invoke = '& $env:BOOT_SCRIPT -ReleaseBaseUrl $env:BOOT_URL';
  const run = cmd => execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', cmd], { env, stdio: 'pipe' });
  publish('1.0.0', {});
  run(invoke);
  const previous = readFileSync(receiptPath, 'utf8');
  publish('2.0.0', { 'a-helper.mjs': 'helper', 'b-notes.txt': 'draft' });
  assert.throws(() => run("$ErrorActionPreference = 'Stop'; $lock = [IO.File]::OpenRead($env:BOOT_LOCK); try { " + invoke + ' } finally { $lock.Dispose() }'));
  assert.equal(readFileSync(receiptPath, 'utf8'), previous);
  assert.equal(JSON.parse(readFileSync(join(target, 'plugin.json'))).version, '1.0.0');
  assert.equal(readFileSync(join(target, 'a-helper.mjs'), 'utf8'), 'helper');
  writeFileSync(join(target, 'b-notes.txt'), 'my notes');
  assert.throws(() => run(invoke), /ERR_PLUGIN_LAYOUT_CONFLICT/);
  assert.equal(readFileSync(receiptPath, 'utf8'), previous);
  publish('3.0.0', { 'a-helper.mjs': 'revised helper' });
  run(invoke);
  assert.equal(JSON.parse(readFileSync(receiptPath)).installedVersion, '3.0.0');
  assert.equal(readFileSync(join(target, 'a-helper.mjs'), 'utf8'), 'revised helper');
  assert.equal(readFileSync(join(target, 'b-notes.txt'), 'utf8'), 'my notes');
  assert.equal(existsSync(join(target, '.agy-market-bootstrap-pending')), false);
});

test('OS bootstrap removes only retired managed files and preserves the next inventory', () => {
  const ws = makeTempWorkspace();
  const target = join(ws.pluginsDir, 'agy-market');
  const script = fileURLToPath(new URL(process.platform === 'win32' ? '../scripts/install.ps1' : '../scripts/install.sh', import.meta.url));
  try {
    const tar = createDeterministicTarGz({
      'plugin.json': JSON.stringify({ name: 'agy-market', version: '1.7.3' }),
      'skills/current/SKILL.md': 'current', 'settings.txt': 'default',
    });
    const tarPath = join(ws.artifactsDir, 'agy-market.tar.gz');
    writeFileSync(tarPath, tar);
    writeFileSync(tarPath + '.sha256', createHash('sha256').update(tar).digest('hex') + '  agy-market.tar.gz\n');
    mkdirSync(join(target, 'skills/old'), { recursive: true });
    writeFileSync(join(target, 'skills/old/SKILL.md'), 'retired');
    writeFileSync(join(target, 'settings.txt'), 'my settings');
    writeFileSync(join(target, 'notes.txt'), 'my notes');
    writeFileSync(join(target, '.agy-market-receipt.json'), JSON.stringify({
      id: 'azwosile__agy-market', managedFiles: ['skills/old/SKILL.md', 'settings.txt'], preservePaths: ['settings.txt'],
    }));
    const stage = join(ws.dataDir, 'staging', 'self-update');
    mkdirSync(stage, { recursive: true });
    writeFileSync(join(stage, 'plugin.json'), JSON.stringify({ name: 'agy-market', version: '1.7.2' }));
    writePendingJournal(ws.dataDir, { dir: 'agy-market', pluginsDir: ws.pluginsDir, stagingRootDir: stage, stagingBundleDir: stage });
    const env = { ...scrubChildProcessEnv(process.env), ANTIGRAVITY_CONFIG_DIR: ws.configDir, AGY_MARKET_DATA_DIR: ws.dataDir };
    let runBootstrap;
    if (process.platform === 'win32') {
      runBootstrap = () => execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script,
        '-ReleaseBaseUrl', pathToFileURL(ws.artifactsDir).href], { env, stdio: 'pipe' });
    } else {
      // Provide local release bytes in the same CLI shape as curl; keep the test offline.
      const bin = join(ws.root, 'bin');
      mkdirSync(bin);
      writeFileSync(join(bin, 'curl'), '#!/bin/sh\ncp "$2" "$4"\n', { mode: 0o755 });
      runBootstrap = () => execFileSync('sh', [script], { env: { ...env, PATH: bin + ':' + env.PATH, AGY_MARKET_RELEASE_URL: ws.artifactsDir }, stdio: 'pipe' });
    }

    const unlock = acquirePluginMutation(ws.dataDir);
    try { assert.throws(runBootstrap, /ERR_PLUGIN_OPERATION_BUSY/); }
    finally { unlock(); }
    assert.ok(existsSync(join(stage, 'plugin.json')));
    assert.equal(existsSync(join(target, 'plugin.json')), false);
    runBootstrap();
    assert.equal(recoverInterruptedJournal(ws).action, 'none');
    assert.equal(existsSync(stage), false);
    assert.equal(JSON.parse(readFileSync(join(target, 'plugin.json'))).version, '1.7.3');
    assert.equal(existsSync(join(target, 'skills/old/SKILL.md')), false);
    assert.equal(readFileSync(join(target, 'settings.txt'), 'utf8'), 'my settings');
    assert.equal(readFileSync(join(target, 'notes.txt'), 'utf8'), 'my notes');
    const receipt = JSON.parse(readFileSync(join(target, '.agy-market-receipt.json'), 'utf8'));
    assert.deepEqual(receipt.managedFiles.sort(), ['plugin.json', 'settings.txt', 'skills/current/SKILL.md']);
    assert.deepEqual(receipt.preservePaths, ['settings.txt']);
    const receiptPath = join(target, '.agy-market-receipt.json');
    const manifestPath = join(target, 'plugin.json');
    const officialManifest = readFileSync(manifestPath, 'utf8');
    const conflictingReceipt = { ...receipt, id: 'internal__market', managedFiles: ['notes.txt'] };
    writeFileSync(receiptPath, JSON.stringify(conflictingReceipt));
    assert.throws(runBootstrap, /ERR_BOOTSTRAP_CONFLICT/);
    assert.equal(readFileSync(join(target, 'notes.txt'), 'utf8'), 'my notes');
    assert.deepEqual(JSON.parse(readFileSync(receiptPath)), conflictingReceipt);
    writeFileSync(receiptPath, JSON.stringify({ ...receipt, managedFiles: ['settings.txt', 'plugin.json'] }));
    assert.throws(runBootstrap, /ERR_PLUGIN_LAYOUT_CONFLICT/);
    assert.equal(readFileSync(manifestPath, 'utf8'), officialManifest);
    writeFileSync(receiptPath, JSON.stringify(receipt));
    // A bootstrap only supersedes an active self-update at this exact plugins root.
    writePendingJournal(ws.dataDir, { dir: 'agy-market', pluginsDir: join(ws.root, 'other-plugins'), stagingRootDir: stage });
    runBootstrap();
    assert.equal(JSON.parse(readFileSync(join(ws.dataDir, 'pending-journal.json'))).pluginsDir, join(ws.root, 'other-plugins'));
  } finally { ws.cleanup(); }
});

test('saving sources distinguishes invalid addresses, saved unavailable feeds and a recovered feed', async () => {
  const ws = makeTempWorkspace();
  const feed = 'https://team.example/index.json';
  let fail = true;
  const srv = await createMarketSidecarServer({ ...ws, listen: false, recoveryDelayMs: -1, fetchImpl: async url =>
    String(url) === feed && fail ? new Response('', { status: 503 }) : Response.json({ plugins: [] }) });
  const save = customFeeds => srv.inject({ method: 'POST', url: '/api/sources',
    headers: { 'x-sidecar-token': srv.sideToken }, body: { customFeeds } });
  try {
    const saved = (await save([feed])).json();
    assert.deepEqual(saved.prefs.customFeeds, [feed]);
    assert.deepEqual(saved.catalog.failedCustomFeeds, [{ url: feed, status: '503' }]);
    const invalid = await save([feed, 'team.example/catalog']);
    assert.equal(invalid.statusCode, 400);
    assert.match(invalid.json().error, /Feed 2/);
    assert.deepEqual(JSON.parse(readFileSync(join(ws.dataDir, 'prefs.json'))).customFeeds, [feed]);
    fail = false;
    assert.deepEqual((await save([feed])).json().catalog.failedCustomFeeds, []);
  } finally { await srv.close(); ws.cleanup(); }
});

test('native conflicts and reserved market names follow platform casing', () => {
  const existing = { scope: 'global', dir: 'MyPlugin', name: 'OtherManifest', repositoryUrl: 'https://github.com/another/tool' };
  const plugin = { id: 'demo__myplugin', canonicalName: 'myplugin', repository: { url: 'https://github.com/demo/tool' } };
  const plan = resolveInstallPreflight(plugin, { installed: [existing] });
  assert.equal(plan.action, process.platform === 'win32' ? 'conflict-prompt' : 'install-native');
  if (process.platform === 'win32') {
    assert.equal(resolveInstallPreflight({ ...plugin, canonicalName: 'othermanifest' }, { installed: [existing] }).action, 'conflict-prompt');
    const replaced = resolveInstallPreflight(plugin, { installed: [existing] }, { conflictStrategy: 'replace' });
    assert.equal(replaced.targetDir, 'MyPlugin');
    assert.throws(() => resolveInstallPreflight({ ...plugin, canonicalName: 'AGY-MARKET' },
      { installed: [{ ...existing, dir: 'agy-market' }] }, { conflictStrategy: 'replace' }), /CANNOT_REPLACE_SELF/);
  }
});

test('interrupted sync leaves previously retired binaries available for collection', () => {
  const ws = makeTempWorkspace();
  const dst = join(ws.pluginsDir, 'worker');
  const stage = join(ws.dataDir, 'bundle');
  try {
    for (const dir of [dst, stage]) mkdirSync(dir);
    writeFileSync(join(stage, 'a.exe'), 'new');
    writeFileSync(join(stage, 'z.txt'), 'after binary');
    writeFileSync(join(dst, 'a.exe'), 'old');
    assert.throws(() => syncDirectoryLockSafe({ stagingBundleDir: stage, targetPluginDir: dst, dataDir: ws.dataDir,
      writeOverride(src, dest, rel) {
        if (rel === 'a.exe') throw Object.assign(new Error('busy'), { code: 'EBUSY' });
        throw new Error('disk interrupted');
      } }), /disk interrupted/);
    const [retired] = JSON.parse(readFileSync(join(ws.dataDir, 'retired-binaries.json')));
    assert.equal(readFileSync(retired, 'utf8'), 'old');
    assert.equal(readFileSync(join(dst, 'a.exe'), 'utf8'), 'new');
    sweepRetiredBinaries(ws.dataDir);
    assert.equal(existsSync(retired), false);
  } finally { ws.cleanup(); }
});

test('recovery rejects empty and malformed plugin directory names before writing', () => {
  const ws = makeTempWorkspace();
  const stage = join(ws.dataDir, 'staging', 'bundle');
  try {
    mkdirSync(stage, { recursive: true });
    writeFileSync(join(stage, 'plugin.json'), '{}');
    for (const dir of ['', ' ', '..', 'bad:name']) {
      writeFileSync(join(ws.dataDir, 'pending-journal.json'), JSON.stringify({ dir, stagingBundleDir: stage }));
      assert.equal(recoverInterruptedJournal(ws).action, 'error');
      assert.equal(existsSync(join(ws.pluginsDir, 'plugin.json')), false);
      assert.equal(existsSync(join(stage, 'plugin.json')), true);
    }
  } finally { ws.cleanup(); }
});

test('README inline markup keeps images as alt text and linked badges clickable', () => {
  const image = '![Build](https://img.example/badge.svg)';
  const html = renderSafeMarkdown(image + ' [' + image + '](https://example.com/build) ' + '`' + image + '`');
  assert.match(html, /<span class="md-img-alt">\[Build\]<\/span>/);
  assert.match(html, /<a href="https:\/\/example\.com\/build"[^>]*>Build<\/a>/);
  assert.match(html, /<code class="md-code">!\[Build\]/);
  assert.doesNotMatch(html, /<img|href="https:\/\/img\.example/);
});

test('README lookup distinguishes a failed server from genuinely absent documentation', async () => {
  const ws = makeTempWorkspace();
  try {
    const lookup = status => fetchPluginReadme({ id: 'demo__tool', dataDir: ws.dataDir,
      primaryBaseUrl: 'https://team.example', fetchImpl: async () => new Response(null, { status }) });
    assert.equal((await lookup(503)).channel, 'unavailable');
    assert.equal((await lookup(404)).channel, 'not-found');
  } finally { ws.cleanup(); }
});

test('JSONC preserves punctuation in string values while removing trailing commas after comments', () => {
  const pattern = '[0-9]{1,},]';
  assert.deepEqual(parseJsonc('{"match":' + JSON.stringify(pattern) + ',"list":["a, }", /* note */ ],}'),
    { match: pattern, list: ['a, }'] });
});

test('isolate-rename preserves vendor docs and restores originals if rewriting the receipt fails', () => {
  const ws = makeTempWorkspace();
  const src = join(ws.pluginsDir, 'reader');
  const dst = join(ws.pluginsDir, 'local--reader');
  try {
    mkdirSync(join(src, 'node_modules', 'other'), { recursive: true });
    mkdirSync(join(src, '.git'));
    const manifest = JSON.stringify({ name: 'reader', description: '[0-9]{1,}' });
    const md = 'Open sidecar://reader/pane/';
    writeFileSync(join(src, 'plugin.json'), manifest);
    for (const path of ['README.md', '.git/doc.md', 'node_modules/other/doc.md']) writeFileSync(join(src, path), md);
    const dangling = join(src, 'broken-link');
    symlinkSync(join(ws.root, 'absent'), dangling, process.platform === 'win32' ? 'junction' : 'dir');
    const fix = () => fixLocalConflict({ ...ws, type: 'isolate-rename', targetDir: 'reader', suggestedDir: 'local--reader' });
    writeFileSync(join(src, '.agy-market-receipt.json'), '{bad');
    assert.throws(fix);
    assert.equal(existsSync(dst), false);
    assert.equal(readFileSync(join(src, 'plugin.json'), 'utf8'), manifest);
    assert.equal(readFileSync(join(src, 'README.md'), 'utf8'), md);
    writeFileSync(join(src, '.agy-market-receipt.json'), '{}');
    assert.equal(fix().ok, true);
    assert.equal(JSON.parse(readFileSync(join(dst, 'plugin.json'))).description, '[0-9]{1,}');
    assert.match(readFileSync(join(dst, 'README.md'), 'utf8'), /local--reader/);
    assert.equal(JSON.parse(readFileSync(join(dst, '.agy-market-receipt.json'))).installedDir, 'local--reader');
    for (const file of ['.git/doc.md', 'node_modules/other/doc.md']) assert.equal(readFileSync(join(dst, file), 'utf8'), md);
  } finally { ws.cleanup(); }
});

test('reading a monolithic README before the first state request leaves catalog preflight usable', async () => {
  const ws = makeTempWorkspace();
  const id = 'demo__reader';
  const plugin = { id, canonicalName: 'reader', version: '1.0.0', repository: { url: 'https://github.com/demo/reader' } };
  const srv = await createMarketSidecarServer({ ...ws, listen: false, recoveryDelayMs: -1, fetchImpl: async url => {
    if (url.endsWith('/readmes.json')) return Response.json({ entries: { [id]: 'The reader' } });
    if (url.endsWith('/index.json')) return Response.json({ plugins: [plugin] });
    return new Response(null, { status: 404 });
  } });
  try {
    assert.equal((await srv.inject({ url: '/api/readme?id=' + id })).json().markdown, 'The reader');
    const plan = await srv.inject({ method: 'POST', url: '/api/preflight', headers: { 'X-Sidecar-Token': srv.sideToken }, body: { id } });
    assert.equal(plan.json().preflight?.action, 'install-native', plan.text);
  } finally { await srv.close(); ws.cleanup(); }
});

test('scoped detail reads the selected workspace README and discussion repository', async () => {
  const ws = makeTempWorkspace();
  const root = join(ws.root, 'project');
  const workspace = join(root, '.agents', 'plugins', 'reader');
  const global = join(ws.pluginsDir, 'reader');
  const srv = await createMarketSidecarServer({ ...ws, listen: false, recoveryDelayMs: -1,
    fetchImpl: async () => Response.json({ has_discussions: true }) });
  try {
    for (const [folder, owner] of [[global, 'global'], [workspace, 'project']]) {
      mkdirSync(folder, { recursive: true });
      writeFileSync(join(folder, 'plugin.json'), JSON.stringify({ name: 'reader', repository: 'https://github.com/' + owner + '/reader' }));
      writeFileSync(join(folder, 'README.md'), owner + ' documentation');
    }
    const qs = new URLSearchParams({ dir: 'reader', id: 'reader', scope: 'workspace', localPath: workspace,
      workspace: pathToFileURL(root).href });
    assert.equal((await srv.inject({ url: '/api/readme?' + qs })).json().markdown, 'project documentation');
    assert.equal((await srv.inject({ url: '/api/discussions?' + qs })).json().repo, 'project/reader');
    qs.set('localPath', global);
    assert.equal((await srv.inject({ url: '/api/readme?' + qs })).statusCode, 404);
  } finally { await srv.close(); ws.cleanup(); }
});


test('sync preserves local links, checks incoming overlaps before writing, and retires only owned links', () => {
  const ws = makeTempWorkspace();
  try {
    const src = join(ws.artifactsDir, 'bundle');
    const dst = join(ws.pluginsDir, 'reader');
    const external = join(ws.root, 'documents');
    for (const path of [src, dst, external]) mkdirSync(path);
    writeFileSync(join(external, 'notes.txt'), 'my notes');
    for (const name of ['notes', 'workspace', 'old-tool']) symlinkSync(external, join(dst, name), 'junction');
    for (const name of ['notes', 'workspace']) {
      mkdirSync(join(src, name));
      writeFileSync(join(src, name, 'notes.txt'), 'default');
    }
    const options = { stagingBundleDir: src, targetPluginDir: dst, dataDir: ws.dataDir,
      previousManagedFiles: ['old-tool'], preservePaths: ['notes'] };
    assert.throws(() => syncDirectoryLockSafe(options), /ERR_PLUGIN_LAYOUT_CONFLICT/);
    assert.ok(lstatSync(join(dst, 'old-tool')).isSymbolicLink());
    rmSync(join(src, 'workspace'), { recursive: true });
    syncDirectoryLockSafe(options);
    assert.ok(lstatSync(join(dst, 'notes')).isSymbolicLink());
    assert.ok(lstatSync(join(dst, 'workspace')).isSymbolicLink());
    assert.equal(existsSync(join(dst, 'old-tool')), false);
    assert.equal(readFileSync(join(external, 'notes.txt'), 'utf8'), 'my notes');
  } finally { ws.cleanup(); }
});

test('one failed discovery channel can use a second mirror without replacing the verified catalog cache', async () => {
  const ws = makeTempWorkspace();
  try {
    const mirrors = ['https://one.example', 'https://two.example'];
    const prefs = { enableExperimentalTrack2: true };
    const primary = { plugins: [{ id: 'verified-current', canonicalName: 'verified-current', version: '1.0.0' }] };
    const discovery = { plugins: [{ id: 'from-mirror', canonicalName: 'from-mirror', version: '1.0.0' }] };
    const archives = mirrors.map((_, i) => {
      const path = join(ws.artifactsDir, i + '.tgz');
      writeFileSync(path, createDeterministicTarGz({
        'package/dist/index.json': JSON.stringify({ plugins: [{ id: 'verified-old', canonicalName: 'verified-old', version: '1.0.0' }] }),
        ...(i ? { 'package/dist/unverified-index.json': JSON.stringify(discovery) } : {}),
      }));
      return pathToFileURL(path).href;
    });
    const fetchImpl = async url => {
      const mirror = mirrors.findIndex(base => String(url).startsWith(base + '/'));
      if (mirror >= 0) return Response.json({ version: '1', dist: { tarball: archives[mirror] } });
      if (String(url).endsWith('/index.json')) return Response.json(primary);
      return new Response(null, { status: 404 });
    };
    const result = await resolveMarketCatalog({ dataDir: ws.dataDir, prefs, mirrors, fetchImpl });
    assert.equal(result.channelUsed, 'github-pages');
    assert.deepEqual(result.plugins.map(p => p.id).sort(), ['from-mirror', 'verified-current']);
    const offline = await resolveMarketCatalog({ dataDir: ws.dataDir, prefs, mirrors, fetchImpl: async () => { throw Error('offline'); } });
    assert.deepEqual(offline.plugins.map(p => p.id).sort(), ['from-mirror', 'verified-current']);
    const readme = await fetchPluginReadme({ id: 'reader', dataDir: ws.dataDir, prefs: { networkMode: 'china-mirror' }, mirrors,
      fetchImpl: async url => {
        if (String(url).endsWith('/readmes/reader.json')) return Response.json({ id: 'reader', default: 'Reader documentation' });
        throw Error('offline');
      } });
    assert.equal(readme.default, 'Reader documentation');
  } finally { ws.cleanup(); }
});

test('reading mirror documentation preserves both primary catalog caches and their ETags', async () => {
  const ws = makeTempWorkspace();
  try {
    const opts = { dataDir: ws.dataDir, prefs: { enableExperimentalTrack2: true }, mirrors: ['https://mirror.example'] };
    const expected = ['latest-experimental', 'latest-verified'];
    const primary = await resolveMarketCatalog({ ...opts, fetchImpl: async url => {
      const id = url.endsWith('/unverified-index.json') ? expected[0] : expected[1];
      return Response.json({ plugins: [{ id, canonicalName: id, version: '1.0.0' }] }, { headers: { etag: id } });
    } });
    assert.deepEqual(primary.plugins.map(p => p.id).sort(), expected);
    const tar = join(ws.artifactsDir, 'mirror.tgz');
    writeFileSync(tar, createDeterministicTarGz({
      'package/dist/index.json': JSON.stringify({ plugins: [{ id: 'old-verified', canonicalName: 'old-verified', version: '1.0.0' }] }),
      'package/dist/unverified-index.json': JSON.stringify({ plugins: [{ id: 'old-experimental', canonicalName: 'old-experimental', version: '1.0.0' }] }),
      'package/dist/readmes.json': JSON.stringify({ entries: { reader: 'Mirror documentation' } }),
    }));
    const readme = await fetchPluginReadme({ ...opts, id: 'reader', fetchImpl: async url => {
      if (url.startsWith(opts.mirrors[0])) return Response.json({ dist: { tarball: pathToFileURL(tar).href } });
      throw Error('offline');
    } });
    assert.equal(readme.default, 'Mirror documentation');
    const tags = [];
    const refreshed = await resolveMarketCatalog({ ...opts, fetchImpl: async (_, request) => {
      tags.push(request.headers['If-None-Match']);
      return new Response(null, { status: 304 });
    } });
    assert.deepEqual(tags.sort(), expected);
    assert.deepEqual(refreshed.plugins.map(p => p.id).sort(), expected);
    const offline = await resolveMarketCatalog({ ...opts, fetchImpl: async () => { throw Error('offline'); } });
    assert.deepEqual(offline.plugins.map(p => p.id).sort(), expected);
  } finally { ws.cleanup(); }
});

test('only HTTPS GitHub downloads qualify for authentication and sidecar labels keep inline code in button text', () => {
  assert.equal(isOfficialGithubTokenHost('http://github.com'), false);
  assert.equal(isOfficialGithubTokenHost('https://github.com'), true);
  assert.equal(isOfficialGithubTokenHost('https://example.com'), false);
  const html = renderSafeMarkdown('[Open `pane`](sidecar://reader/pane/)');
  assert.match(html, /data-label="Open `pane`"/);
  assert.match(html, /Open <code class="md-code">pane<\/code><\/button>/);
});

test('an incomplete interrupted first install keeps its journal until staging is usable', () => {
  const ws = makeTempWorkspace();
  try {
    const stage = join(ws.dataDir, 'staging', 'first', 'bundle');
    mkdirSync(stage, { recursive: true });
    writeFileSync(join(stage, 'plugin.json'), JSON.stringify({ name: 'reader', version: '1.0.0' }));
    writePendingJournal(ws.dataDir, { dir: 'reader', stagingRootDir: join(stage, '..'), stagingBundleDir: stage,
      receipt: { id: 'demo__reader', managedFiles: ['plugin.json', 'entry.js'] } });
    assert.match(recoverInterruptedJournal(ws).error, /ERR_INCOMPLETE_STAGING/);
    assert.equal(existsSync(join(ws.pluginsDir, 'reader')), false);
    assert.ok(existsSync(join(ws.dataDir, 'pending-journal.json')));
    writeFileSync(join(stage, 'entry.js'), 'export default 1');
    assert.equal(recoverInterruptedJournal(ws).action, 'completed-forward');
    assert.equal(readFileSync(join(ws.pluginsDir, 'reader', 'entry.js'), 'utf8'), 'export default 1');
  } finally { ws.cleanup(); }
});
