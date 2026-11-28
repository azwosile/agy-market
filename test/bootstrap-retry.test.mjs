import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { scrubChildProcessEnv } from '../src/shared/constants.mjs';

const cli = fileURLToPath(new URL('../bin/agy-market.mjs', import.meta.url));
const currentVersion = JSON.parse(readFileSync(new URL('../plugin.json', import.meta.url))).version;
const owner = 'https://github.com/azwosile/agy-market';

test('npx bootstrap resumes interrupted first installs and updates without claiming user files', () => {
  for (const scenario of ['first-install', 'upgrade', 'legacy', 'receipt-write']) {
    const root = mkdtempSync(join(tmpdir(), 'agy-bootstrap-retry-'));
    try {
      const plugins = join(root, 'plugins');
      const target = join(plugins, 'agy-market');
      const receiptFile = join(target, '.agy-market-receipt.json');
      const oldReceipt = JSON.stringify({ id: 'azwosile__agy-market', repositoryUrl: owner, installedVersion: '1.0.0',
        installedAt: '2020-01-01', managedFiles: ['plugin.json', 'retired.txt'] });
      if (scenario !== 'first-install') {
        mkdirSync(target, { recursive: true });
        writeFileSync(join(target, 'plugin.json'), JSON.stringify({ name: 'agy-market', repository: owner, version: '1.0.0' }));
        writeFileSync(join(target, 'retired.txt'), 'old package');
        if (scenario !== 'legacy') writeFileSync(receiptFile, oldReceipt);
      }
      // Exit after the first payload copy, or fail at the receipt rename. Using a
      // child also exercises reclaiming a dead process's mutation ticket.
      const hook = join(root, 'interrupt.cjs');
      writeFileSync(hook, `
        const fs = require('node:fs'), path = require('node:path');
        const target = process.env.BOOTSTRAP_TEST_TARGET;
        const copy = fs.copyFileSync, rename = fs.renameSync;
        fs.copyFileSync = function(src, dst, ...args) {
          const result = copy(src, dst, ...args);
          if (process.env.BOOTSTRAP_TEST_SCENARIO !== 'receipt-write' && String(dst).startsWith(target + path.sep)) process.exit(47);
          return result;
        };
        fs.renameSync = function(src, dst) {
          if (process.env.BOOTSTRAP_TEST_SCENARIO === 'receipt-write' && dst === path.join(target, '.agy-market-receipt.json'))
            throw Object.assign(new Error('simulated receipt I/O failure'), { code: 'EIO' });
          return rename(src, dst);
        };
        require('node:module').syncBuiltinESMExports();
      `);
      const env = { ...scrubChildProcessEnv(), AGY_MARKET_DATA_DIR: join(root, 'data'), ANTIGRAVITY_CONFIG_DIR: join(root, 'config'),
        BOOTSTRAP_TEST_TARGET: target, BOOTSTRAP_TEST_SCENARIO: scenario };
      function bootstrap(interrupt = false) {
        return spawnSync(process.execPath, [...(interrupt ? ['--require', hook] : []), cli, 'install', '--dest', plugins],
          { env, encoding: 'utf8', windowsHide: true });
      }
      const stopped = bootstrap(true);
      if (scenario === 'receipt-write') assert.match(stopped.stderr, /simulated receipt I\/O failure/);
      else assert.equal(stopped.status, 47, stopped.stderr);
      if (scenario === 'upgrade' || scenario === 'receipt-write') assert.equal(readFileSync(receiptFile, 'utf8'), oldReceipt);
      else assert.equal(existsSync(receiptFile), false);
      if (scenario === 'first-install') {
        const staging = join(root, 'data', 'staging');
        const interrupted = readdirSync(staging).find(name => name.startsWith('bootstrap-'));
        writeFileSync(join(staging, interrupted, 'sidecars', 'market_pane', 'main.mjs'), '');
      }
      const notes = join(target, 'user-notes.txt');
      writeFileSync(notes, 'my notes');
      if (scenario !== 'receipt-write') {
        const collision = join(target, 'src', 'sidecar', 'server.mjs');
        assert.equal(existsSync(collision), false);
        mkdirSync(dirname(collision), { recursive: true });
        writeFileSync(collision, 'locally created after interruption');
        const blocked = bootstrap();
        assert.match(blocked.stderr, /ERR_PLUGIN_LAYOUT_CONFLICT/);
        assert.equal(readFileSync(collision, 'utf8'), 'locally created after interruption');
        rmSync(collision);
      }
      const retry = bootstrap();
      assert.equal(retry.status, 0, retry.stderr);
      assert.equal(readFileSync(notes, 'utf8'), 'my notes');
      assert.equal(existsSync(join(target, 'retired.txt')), scenario === 'legacy');
      const receipt = JSON.parse(readFileSync(receiptFile));
      assert.ok(receipt.managedFiles.includes('src/sidecar/server.mjs'));
      assert.ok(!receipt.managedFiles.includes('user-notes.txt'));
      assert.equal(receipt.installedVersion, currentVersion);
      if (scenario === 'upgrade' || scenario === 'receipt-write') assert.equal(receipt.installedAt, '2020-01-01');
      assert.deepEqual(readFileSync(join(target, 'sidecars', 'market_pane', 'main.mjs')),
        readFileSync(new URL('../sidecars/market_pane/main.mjs', import.meta.url)));
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});
