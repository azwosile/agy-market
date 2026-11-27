import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { isMainEntry } from '../sidecars/market_pane/main.mjs';
import { isMainModule } from '../src/shared/paths.mjs';

const __testDir = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__testDir, '..');

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
  const realWinPath = '/D:/Antigravity/.gemini/config/plugins/agy-market/sidecars/market_pane/main.mjs';
  const junctionWinPath = '/C:/Users/longyi/.gemini/config/plugins/agy-market/sidecars/market_pane/main.mjs';
  const realWinUrl = pathToFileURL(realWinPath).href;
  const fakeRealpath = (p) => (p.includes('Users/longyi') ? realWinPath : p);
  fakeRealpath.native = fakeRealpath;

  assert.equal(
    isMainModule(realWinUrl, junctionWinPath, { realpathFn: fakeRealpath, platform: 'win32' }),
    true,
  );

  // 4. Simulated Windows case-insensitive drive letter / folder casing difference
  const lowerCaseRealpath = (p) => p.replace('/D:/Antigravity/', '/d:/antigravity/');
  lowerCaseRealpath.native = lowerCaseRealpath;
  assert.equal(
    isMainModule(realWinUrl, realWinPath.replace('/D:/Antigravity/', '/d:/antigravity/'), {
      realpathFn: lowerCaseRealpath,
      platform: 'win32',
    }),
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
    symlinkSync(realTargetGemini, linkedGemini, 'dir');
    // Link repo into real D:\Antigravity\.gemini\config\plugins\agy-market
    symlinkSync(REPO_ROOT, join(realPluginsDir, 'agy-market'), 'dir');

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
