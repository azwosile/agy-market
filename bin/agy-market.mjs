#!/usr/bin/env node
// One-Line Bootstrap CLI (`npx agy-market`) & Local Diagnostics (`bin/agy-market.mjs`).

import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { installLocalAgyMarket } from '../scripts/install-local.mjs';
import { sweepRetiredBinaries } from '../src/installer/sync-dir.mjs';
import { scanLocalPluginInventory } from '../src/preflight/index.mjs';
import {
  CUSTOMIZATION_URI,
  PLUGIN_DISPLAY_NAME,
  PLUGIN_ID,
  PLUGIN_JSON_ALLOWED_KEYS,
  PLUGIN_VERSION,
  SIDECAR_URI,
} from '../src/shared/constants.mjs';
import { resolveAntigravityConfigDir, resolveMarketDataDir, resolvePluginsDir } from '../src/shared/paths.mjs';
import { parseJsonc } from '../src/shared/schemas.mjs';

function printHelp() {
  console.log(`${PLUGIN_DISPLAY_NAME} v${PLUGIN_VERSION}

Usage:
  npx agy-market [install] [--dest <plugins-dir>]   Install or update AGY Market into Antigravity
  npx agy-market status [--json]                    List installed plugins & AGY Market status
  npx agy-market doctor                             Verify installation health & sweep retired binaries
  npx agy-market --help                             Show this help message
`);
}

export async function runCli(argv = process.argv.slice(2)) {
  const args = [...argv];
  if (args.includes('-h') || args.includes('--help') || args[0] === 'help') {
    printHelp();
    return { code: 0 };
  }

  const destIdx = args.indexOf('--dest');
  const destPluginsDir = destIdx !== -1 && args[destIdx + 1] ? args[destIdx + 1] : '';
  const asJson = args.includes('--json');
  const sub = args[0] && !args[0].startsWith('--') ? args[0] : 'install';

  if (sub === 'install' || sub === 'bootstrap') {
    const out = await installLocalAgyMarket({ destPluginsDir });
    if (asJson) {
      console.log(JSON.stringify({ ok: true, ...out }, null, 2));
    } else {
      console.log(`✓ Installed ${PLUGIN_DISPLAY_NAME} (v${PLUGIN_VERSION})`);
      console.log(`  Location:     ${out.dstDir}`);
      console.log(`  Open Market:  [AGY Market](${out.sidecarUri})`);
      console.log(`  Manage:       [AGY Market](${out.customizationUri})`);
    }
    return { code: 0 };
  }

  if (sub === 'status') {
    const configDir = resolveAntigravityConfigDir();
    const dataDir = resolveMarketDataDir();
    const inv = scanLocalPluginInventory({ configDir });
    const summary = {
      ok: true,
      version: PLUGIN_VERSION,
      configDir,
      dataDir,
      installedCount: inv.installed.length,
      plugins: inv.installed.map((p) => ({
        dir: p.dir,
        name: p.name,
        version: p.version,
        enabled: p.enabled,
        managedByMarket: Boolean(p.receipt),
        customizationUri: p.customizationUri,
        sidecarUri: p.sidecarPane?.uri || null,
      })),
    };
    if (asJson) {
      console.log(JSON.stringify(summary, null, 2));
    } else {
      console.log(`${PLUGIN_DISPLAY_NAME} Status`);
      console.log(`  Config Dir: ${configDir}`);
      console.log(`  Data Dir:   ${dataDir}`);
      console.log(`  Installed Plugins (${inv.installed.length}):`);
      for (const p of summary.plugins) {
        console.log(
          `    - ${p.dir} (v${p.version}) [${p.enabled ? 'enabled' : 'disabled'}]${p.managedByMarket ? ' [agy-market]' : ''}`,
        );
      }
    }
    return { code: 0 };
  }

  if (sub === 'doctor') {
    const pluginsDir = destPluginsDir ? resolve(destPluginsDir) : resolvePluginsDir();
    const dataDir = resolveMarketDataDir();
    const selfDir = join(pluginsDir, PLUGIN_ID);
    const swept = sweepRetiredBinaries(dataDir);
    const checks = [];

    const nodeMajor = parseInt(process.versions.node.split('.')[0], 10);
    checks.push({ check: 'node>=22', ok: nodeMajor >= 22, detail: process.version });

    const installedExists = existsSync(selfDir);
    const notSymlink = installedExists ? !lstatSync(selfDir).isSymbolicLink() : true;
    checks.push({ check: 'real-directory-no-symlink', ok: notSymlink, detail: selfDir });

    if (installedExists && existsSync(join(selfDir, 'plugin.json'))) {
      const m = parseJsonc(readFileSync(join(selfDir, 'plugin.json'), 'utf8'));
      const unknownKeys = Object.keys(m).filter((k) => !PLUGIN_JSON_ALLOWED_KEYS.has(k));
      checks.push({ check: 'manifest-10-field-purity', ok: unknownKeys.length === 0, detail: unknownKeys.join(',') || 'clean' });
      checks.push({
        check: 'sidecar-ui-built',
        ok: existsSync(join(selfDir, 'sidecars', 'market_pane', 'index.html')),
        detail: 'sidecars/market_pane/index.html',
      });
    }

    const allOk = checks.every((c) => c.ok);
    const report = { ok: allOk, checks, sweptRetiredBinaries: swept };
    if (asJson) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      for (const c of checks) {
        console.log(`${c.ok ? '✓' : '✗'} ${c.check}: ${c.detail}`);
      }
      console.log(`✓ Retired binary GC: removed=${swept.removed}, remaining=${swept.remaining}`);
    }
    return { code: allOk ? 0 : 1 };
  }

  throw new Error(`Unknown subcommand "${sub}". Run "npx agy-market --help".`);
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1] || '')).href) {
  const { code } = await runCli();
  process.exitCode = code;
}
