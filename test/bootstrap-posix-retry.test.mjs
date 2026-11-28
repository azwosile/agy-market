import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createDeterministicTarGz } from '../src/installer/tar-extract.mjs';

const shell = process.platform === 'win32' ? join(process.env.ProgramFiles || 'C:/Program Files', 'Git/bin/bash.exe') : '/bin/sh';
const wrapper = fileURLToPath(new URL('../scripts/install.sh', import.meta.url)).replaceAll('\\', '/');
const digest = data => createHash('sha256').update(data).digest('hex');

function fixture(t, powershell = false) {
  const root = mkdtempSync(join(tmpdir(), 'agy-posix-retry-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const target = join(root, 'config/plugins/agy-market');
  for (const dir of ['release', 'bin', 'config/plugins/agy-market']) mkdirSync(join(root, dir), { recursive: true });
  const shim = (name, body) => writeFileSync(join(root, 'bin', name), '#!/bin/sh\n' + body, { mode: 0o755 });
  shim('curl', 'exec /bin/cp "$2" "$4"\n');
  shim('mv', `if [ -f "$PWD/stop-receipt" ] && [ "$(basename "$3")" = '.agy-market-receipt.json' ] && grep -q '"installedVersion"' "$2"; then
  exit 77
fi
exec /bin/mv "$@"
`);
  shim('cp', `if [ -f "$PWD/stop-copy" ] && [ "$(basename "$2")" = 'payload.txt' ]; then
  printf partial > "$3"
  exit 78
fi
exec /bin/cp "$@"
`);
  const stage = (version, files) => {
    const manifest = { name: 'agy-market', version, repository: 'https://github.com/azwosile/agy-market' };
    const tar = createDeterministicTarGz({ 'plugin.json': JSON.stringify(manifest), ...files });
    const path = join(root, 'release/agy-market.tar.gz');
    writeFileSync(path, tar);
    writeFileSync(path + '.sha256', digest(tar) + '\n');
  };
  const run = powershell ? () => spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass',
    '-File', fileURLToPath(new URL('../scripts/install.ps1', import.meta.url)),
    '-ReleaseBaseUrl', pathToFileURL(join(root, 'release')).href], {
    env: { ...process.env, ANTIGRAVITY_CONFIG_DIR: join(root, 'config'), AGY_MARKET_DATA_DIR: join(root, 'data') },
    encoding: 'utf8', windowsHide: true,
  }) : () => spawnSync(shell, ['-c', `
    PATH="$PWD/bin:/usr/bin:/bin:$PATH"
    export AGY_MARKET_RELEASE_URL="$PWD/release" AGY_MARKET_MIRROR_PREFIX=""
    export ANTIGRAVITY_CONFIG_DIR="$PWD/config" AGY_MARKET_DATA_DIR="$PWD/data"
    exec sh "$1"
  `, 'sh', wrapper], { cwd: root, encoding: 'utf8', windowsHide: true });
  const text = rel => readFileSync(join(target, rel), 'utf8');
  const receipt = () => JSON.parse(text('.agy-market-receipt.json'));
  const setStop = (name, on) => on ? writeFileSync(join(root, name), '') : rmSync(join(root, name));
  return { target, stage, run, text, receipt, setStop };
}

for (const [name, available] of [['PowerShell', process.platform === 'win32'], ['POSIX', existsSync(shell)]]) {
  test(name + ' bootstrap preserves recursive globs and handles managed layout changes', { skip: !available }, t => {
    const { target, stage, run, text, receipt } = fixture(t, name === 'PowerShell');
    const settings = ['settings/prefs.json', 'settings/nested/prefs.json'];
    const defaults = Object.fromEntries(settings.map(path => [path, 'default']));
    const first = { ...defaults, module: 'file', 'old/sub/entry': 'old' };
    const second = { ...defaults, 'module/sub/entry': 'new', old: 'single' };
    stage('1.0.0', first);
    const start = run();
    assert.equal(start.status, 0, start.stderr);
    for (const path of settings) writeFileSync(join(target, path), 'my setting');
    const receiptPath = join(target, '.agy-market-receipt.json');
    const savePatterns = patterns => writeFileSync(receiptPath, JSON.stringify({ ...receipt(), preservePaths: patterns }));
    savePatterns(['settings/**/prefs.*', 'module']);
    stage('2.0.0', second);
    assert.notEqual(run().status, 0);
    assert.equal(text('module'), 'file');
    savePatterns(['settings/**/prefs.*']);
    writeFileSync(join(target, 'old/sub/notes'), 'private');
    assert.notEqual(run().status, 0);
    assert.equal(text('old/sub/notes'), 'private');
    assert.equal(text('module'), 'file');
    rmSync(join(target, 'old/sub/notes'));
    const updated = run();
    assert.equal(updated.status, 0, updated.stderr);
    for (const path of settings) assert.equal(text(path), 'my setting');
    assert.equal(text('module/sub/entry'), 'new');
    assert.equal(text('old'), 'single');
    assert.equal(receipt().installedVersion, '2.0.0');
  });
}

test('POSIX wrapper updates case-renamed managed and interrupted files without claiming a distinct local path', { skip: !existsSync(shell) }, t => {
  const { target, stage, run, text, receipt, setStop } = fixture(t);
  stage('1.0.0', { 'Readme.md': 'one' });
  let result = run();
  assert.equal(result.status, 0, result.stderr);
  const insensitive = existsSync(join(target, 'README.md'));
  if (!insensitive) {
    writeFileSync(join(target, 'README.md'), 'personal');
    stage('2.0.0', { 'README.md': 'two' });
    assert.match(run().stderr, /ERR_PLUGIN_LAYOUT_CONFLICT/);
    assert.equal(text('README.md'), 'personal');
    rmSync(join(target, 'README.md'));
  }
  stage('2.0.0', { 'README.md': 'two', 'Lib/Helper.txt': 'two' });
  setStop('stop-receipt', true);
  result = run();
  assert.equal(result.status, 77, result.stderr);
  stage('3.0.0', { 'README.md': 'three', 'lib/helper.txt': 'three' });
  setStop('stop-receipt', false);
  result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(text('README.md'), 'three');
  assert.equal(text('lib/helper.txt'), 'three');
  assert.ok(receipt().managedFiles.includes('lib/helper.txt'));
  if (!insensitive) {
    assert.equal(existsSync(join(target, 'Readme.md')), false);
    assert.equal(existsSync(join(target, 'Lib/Helper.txt')), false);
  }
});

test('POSIX wrapper resumes interrupted releases across versions and publishes the receipt atomically', { skip: !existsSync(shell) }, t => {
  const { target, stage, run, text, receipt, setStop } = fixture(t);
  const ledger = '.agy-market-bootstrap-pending';
  const path = 'folder/new file.txt';
  stage('1.0.0', { [path]: 'first', 'retired.txt': 'retired', 'edited-retired.txt': 'original' });
  setStop('stop-receipt', true);
  assert.equal(run().status, 77);
  assert.deepEqual(receipt().managedFiles, []);
  assert.ok(text(ledger).includes(digest('first') + '  ' + path));
  writeFileSync(join(target, 'edited-retired.txt'), 'my notes');

  stage('2.0.0', { [path]: 'second', 'payload.txt': 'payload v2' });
  assert.equal(run().status, 77);
  assert.deepEqual(receipt().managedFiles, []);
  for (const bytes of ['first', 'second']) assert.ok(text(ledger).includes(digest(bytes) + '  ' + path));
  assert.equal(existsSync(join(target, 'retired.txt')), false);
  assert.equal(text('edited-retired.txt'), 'my notes');
  writeFileSync(join(target, path), 'first');
  setStop('stop-receipt', false);
  const done = run();
  assert.equal(done.status, 0, done.stderr);
  assert.equal(receipt().installedVersion, '2.0.0');
  assert.equal(text(path), 'second');
  assert.equal(existsSync(join(target, ledger)), false);

  stage('3.0.0', { [path]: 'third', 'payload.txt': 'payload v3' });
  setStop('stop-copy', true);
  assert.equal(run().status, 78);
  assert.equal(receipt().installedVersion, '2.0.0');
  assert.equal(JSON.parse(text('plugin.json')).version, '2.0.0');
  assert.equal(text('payload.txt'), 'payload v2');
  setStop('stop-copy', false);
  const retry = run();
  assert.equal(retry.status, 0, retry.stderr);
  assert.equal(receipt().installedVersion, '3.0.0');
  assert.equal(text('payload.txt'), 'payload v3');
});

for (const hasReceipt of [true, false]) {
  test(`POSIX wrapper protects a user-edited pending file on a legacy install (receipt=${hasReceipt})`, { skip: !existsSync(shell) }, t => {
    const { target, stage, run, text, setStop } = fixture(t);
    writeFileSync(join(target, 'plugin.json'), JSON.stringify({
      name: 'agy-market', version: '0.1.0', repository: 'https://github.com/azwosile/agy-market',
    }));
    const oldReceipt = JSON.stringify({ id: 'azwosile__agy-market', installedVersion: '0.1.0' });
    const receiptPath = join(target, '.agy-market-receipt.json');
    if (hasReceipt) writeFileSync(receiptPath, oldReceipt);
    stage('1.0.0', { 'new.txt': 'release' });
    setStop('stop-receipt', true);
    assert.equal(run().status, 77);
    assert.equal(existsSync(receiptPath), hasReceipt);
    writeFileSync(join(target, 'new.txt'), 'local changes');
    setStop('stop-receipt', false);
    const retry = run();
    assert.notEqual(retry.status, 0);
    assert.match(retry.stderr, /ERR_PLUGIN_LAYOUT_CONFLICT/);
    assert.equal(text('new.txt'), 'local changes');
    assert.equal(existsSync(receiptPath), hasReceipt);
    if (hasReceipt) assert.equal(text('.agy-market-receipt.json'), oldReceipt);
  });
}
