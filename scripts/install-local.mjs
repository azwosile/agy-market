#!/usr/bin/env node
// Real-Copy Local Installer for `agy-market` (`scripts/install-local.mjs`).
// Copies real files & directories into `~/.gemini/config/plugins/agy-market` (NEVER symlinks or NTFS junctions).

import { createHash } from 'node:crypto';
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMainModule } from '../src/shared/paths.mjs';
import { CUSTOMIZATION_URI, PLUGIN_ID, PLUGIN_VERSION, SIDECAR_URI } from '../src/shared/constants.mjs';
import { resolvePluginsDir } from '../src/shared/paths.mjs';
import { buildMarketSidecarHtml } from './build.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');

function hasNodeModulesSegment(baseRoot, targetPath) {
  const rel = relative(baseRoot, targetPath);
  if (!rel || rel === '.') return false;
  return rel.split(/[\\/]/).includes('node_modules');
}

export async function installLocalAgyMarket({ destPluginsDir = '' } = {}) {
  const indexHtmlPath = join(repoRoot, 'sidecars', 'market_pane', 'index.html');
  if (!existsSync(indexHtmlPath)) {
    await buildMarketSidecarHtml();
  }

  const pluginsDir = destPluginsDir ? resolve(destPluginsDir) : resolvePluginsDir();
  const dstDir = join(pluginsDir, PLUGIN_ID);

  // Replace any legacy symlink/junction with a real folder
  if (existsSync(dstDir) && lstatSync(dstDir).isSymbolicLink()) {
    rmSync(dstDir, { recursive: true, force: true });
  }
  mkdirSync(dstDir, { recursive: true });

  const itemsToCopy = [
    'agy-market.json',
    'package.json',
    'README.md',
    'README.en.md',
    'LICENSE',
    'assets',
    'bin',
    'scripts',
    'sidecars',
    'skills',
    'src',
    'plugin.json',
  ];

  for (const rel of itemsToCopy) {
    const src = join(repoRoot, rel);
    if (!existsSync(src)) continue;
    cpSync(src, join(dstDir, rel), {
      recursive: true,
      force: true,
      dereference: true,
      filter: (p) => !hasNodeModulesSegment(repoRoot, p) && !p.endsWith('.tmp') && !p.endsWith('.gitkeep'),
    });
  }

  const requiredFiles = [
    'plugin.json',
    join('assets', 'logo.png'),
    join('bin', 'agy-market.mjs'),
    join('skills', 'agy-market', 'SKILL.md'),
    join('sidecars', 'market_pane', 'sidecar.json'),
    join('sidecars', 'market_pane', 'main.mjs'),
    join('sidecars', 'market_pane', 'index.html'),
    join('src', 'sidecar', 'server.mjs'),
    join('src', 'installer', 'index.mjs'),
  ];

  for (const reqRel of requiredFiles) {
    if (!existsSync(join(dstDir, reqRel))) {
      throw new Error(`ERR_INSTALL_INCOMPLETE: Missing required file "${reqRel}" in ${dstDir}`);
    }
  }

  if (lstatSync(dstDir).isSymbolicLink()) {
    throw new Error('ERR_SYMLINK_DETECTED: Destination directory must be a real directory, never a symlink/junction');
  }

  // Refresh server.mjs mtime without altering bytes so main.mjs 2.5s hot-reload poll
  // reliably detects updates even when only transitive modules (e.g. github-url.mjs) changed.
  const serverMjsDst = join(dstDir, 'src', 'sidecar', 'server.mjs');
  const touchNow = new Date();
  utimesSync(serverMjsDst, touchNow, touchNow);

  const manifestRaw = readFileSync(join(dstDir, 'plugin.json'));
  const digest = createHash('sha256').update(manifestRaw).digest('hex');
  const receiptPath = join(dstDir, '.agy-market-receipt.json');
  const prevReceipt = existsSync(receiptPath) ? JSON.parse(readFileSync(receiptPath, 'utf8')) : null;
  const nowIso = new Date().toISOString();

  const receipt = {
    schemaVersion: 1,
    id: 'azwosile__agy-market',
    track: 'verified',
    repositoryId: 1468650761,
    installedDir: PLUGIN_ID,
    effectivePluginName: PLUGIN_ID,
    scopedRewriteApplied: false,
    installedVersion: PLUGIN_VERSION,
    gitTag: `v${PLUGIN_VERSION}`,
    sha256: digest,
    preservePaths: [],
    grantedCapabilities: {
      badges: ['sidecar-ui'],
      mcpRemoteDomains: [],
      hookEvents: [],
    },
    installedAt: prevReceipt?.installedAt || nowIso,
    updatedAt: nowIso,
  };
  writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');

  return { dstDir, sidecarUri: SIDECAR_URI, customizationUri: CUSTOMIZATION_URI };
}

if (isMainModule(import.meta.url)) {
  const destIdx = process.argv.indexOf('--dest');
  const destPluginsDir = destIdx !== -1 && process.argv[destIdx + 1] ? process.argv[destIdx + 1] : '';
  const res = await installLocalAgyMarket({ destPluginsDir });
  console.log(`[install:local] Installed agy-market -> ${res.dstDir}`);
  console.log(`  Open Market Pane: [AGY Market](${res.sidecarUri})`);
  console.log(`  Manage Plugin:    [AGY Market](${res.customizationUri})`);
}
