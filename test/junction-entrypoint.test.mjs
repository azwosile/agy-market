import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { isMainEntry } from '../sidecars/market_pane/main.mjs';
import { isMainModule } from '../src/shared/paths.mjs';
import { installLocalAgyMarket } from '../scripts/install-local.mjs';

const __testDir = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__testDir, '..');

test('bootstrap materializes a legacy official junction and preserves its Git worktree', async t => {
  const root = mkdtempSync(join(tmpdir(), 'agy-bootstrap-link-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const checkout = join(root, 'development', 'agy-market');
  const dataDir = join(root, 'data');
  mkdirSync(join(checkout, '.git'), { recursive: true });
  const manifest = JSON.stringify({ name: 'agy-market', repository: 'https://github.com/azwosile/agy-market' });
  writeFileSync(join(checkout, 'plugin.json'), manifest);
  writeFileSync(join(checkout, 'notes.txt'), 'draft');
  await assert.rejects(installLocalAgyMarket({ destPluginsDir: dirname(checkout), dataDir }), /ERR_BOOTSTRAP_CONFLICT/);
  const plugins = join(root, 'plugins');
  mkdirSync(plugins);
  symlinkSync(checkout, join(plugins, 'agy-market'), process.platform === 'win32' ? 'junction' : 'dir');
  await installLocalAgyMarket({ destPluginsDir: plugins, dataDir });
  assert.equal(lstatSync(join(plugins, 'agy-market')).isSymbolicLink(), false);
  assert.ok(existsSync(join(plugins, 'agy-market', '.agy-market-receipt.json')));
  assert.equal(existsSync(join(checkout, '.agy-market-receipt.json')), false);
  assert.equal(readFileSync(join(checkout, 'notes.txt'), 'utf8'), 'draft');
  assert.equal(readFileSync(join(checkout, 'plugin.json'), 'utf8'), manifest);
});

test('isMainModule handles direct paths, Windows NTFS cross-drive junctions, drive casing, and non-matching scripts', () => {
  const realMain = join(REPO_ROOT, 'sidecars', 'market_pane', 'main.mjs');
  const realUrl = pathToFileURL(realMain).href;

  // 1. Direct match
  assert.equal(isMainModule(realUrl, realMain), true);

  // 2. Imported as a library (different argv[1]) -> must stay false
  assert.equal(isMainModule(realUrl, join(REPO_ROOT, 'bin', 'agy-market.mjs')), false);
  assert.equal(isMainModule(realUrl, ''), false);
  assert.equal(isMainEntry(join(REPO_ROOT, 'bin', 'agy-market.mjs')), false);

  // 3. Simulated Windows NTFS cross-drive directory junction (C:\Users\longyi\.gemini -> D:\Antigravity\.gemini)
  const drivePrefix = process.platform === 'win32' ? '' : '/';
  const realWinPath = resolve(drivePrefix + 'D:/Antigravity/.gemini/config/plugins/agy-market/sidecars/market_pane/main.mjs');
  const junctionWinPath = resolve(drivePrefix + 'C:/Users/longyi/.gemini/config/plugins/agy-market/sidecars/market_pane/main.mjs');
  const realWinUrl = pathToFileURL(realWinPath).href;
  const fakeRealpath = (p) => (p === junctionWinPath ? realWinPath : p);
  fakeRealpath.native = fakeRealpath;

  assert.equal(
    isMainModule(realWinUrl, junctionWinPath, { realpathFn: fakeRealpath, platform: 'win32' }),
    true,
  );

  // 4. Simulated Windows case-insensitive drive letter / folder casing difference
  assert.equal(
    isMainModule(realWinUrl, realWinPath.toLowerCase(), { realpathFn: fakeRealpath, platform: 'win32' }),
    true,
  );
});

test('sidecars/market_pane/main.mjs and bin/agy-market.mjs boot properly when launched through a symlinked ancestor directory', async () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'agy-junction-boot-'));
  try {
    const fakeHome = join(sandbox, 'fake-home');
    const linkedGemini = join(fakeHome, '.gemini');
    const realTargetGemini = join(sandbox, 'drive-d', 'Antigravity', '.gemini');
    const realPluginsDir = join(realTargetGemini, 'config', 'plugins');
    const dataDir = join(sandbox, 'data');

    mkdirSync(fakeHome, { recursive: true });
    mkdirSync(realPluginsDir, { recursive: true });
    mkdirSync(dataDir, { recursive: true });

    // Simulate C:\Users\<user>\.gemini -> D:\Antigravity\.gemini directory junction
    const linkType = process.platform === 'win32' ? 'junction' : 'dir';
    symlinkSync(realTargetGemini, linkedGemini, linkType);
    // Link repo into real D:\Antigravity\.gemini\config\plugins\agy-market
    symlinkSync(REPO_ROOT, join(realPluginsDir, 'agy-market'), linkType);

    const linkedMain = join(linkedGemini, 'config', 'plugins', 'agy-market', 'sidecars', 'market_pane', 'main.mjs');
    const linkedCli = join(linkedGemini, 'config', 'plugins', 'agy-market', 'bin', 'agy-market.mjs');

    // A. CLI launched through symlinked ancestor must execute runCli() instead of silently exiting
    const cliRun = spawnSync(process.execPath, [linkedCli, '--help'], {
      encoding: 'utf8',
      timeout: 10_000,
    });
    assert.equal(cliRun.status, 0, `CLI exited with ${cliRun.status}: ${cliRun.stderr}`);
    assert.match(cliRun.stdout, /agy-market/i);

    // B. Sidecar launched through symlinked ancestor must boot HTTP server instead of exiting prematurely
    const child = spawn(process.execPath, [linkedMain], {
      env: {
        ...process.env,
        ANTIGRAVITY_CONFIG_DIR: join(linkedGemini, 'config'),
        AGY_MARKET_DATA_DIR: dataDir,
        PORT: '0',
        SIDECAR_PORT: '0',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    const listenUrl = await new Promise((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        rejectPromise(new Error(`Sidecar did not become ready in time. stdout=${stdout} stderr=${stderr}`));
      }, 10_000);

      child.stdout.on('data', (chunk) => {
        stdout += chunk.toString('utf8');
        const m = /listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(stdout);
        if (m) {
          clearTimeout(timer);
          resolvePromise(m[1]);
        }
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString('utf8');
      });
      child.once('exit', (code, signal) => {
        clearTimeout(timer);
        rejectPromise(
          new Error(`Sidecar exited prematurely (code=${code}, signal=${signal}). stdout=${stdout} stderr=${stderr}`),
        );
      });
    });

    try {
      const res = await fetch(`${listenUrl}/`);
      assert.equal(res.status, 200);
    } finally {
      child.kill('SIGTERM');
      await new Promise((r) => child.once('exit', r));
    }
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});
