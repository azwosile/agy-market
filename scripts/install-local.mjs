#!/usr/bin/env node
// Real-Copy Local Installer for `agy-market` (`scripts/install-local.mjs`).
// Copies real files & directories into `~/.gemini/config/plugins/agy-market` (NEVER symlinks or NTFS junctions).

import { createHash } from 'node:crypto';
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, utimesSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { acquirePluginMutation, bindPendingJournalRoot, clearPendingJournal, discardPendingPluginUpdate, readJournalTargetIdentity, readPendingPluginUpdate, recoverInterruptedJournal, snapshotDigest, writeInstallReceipt, writePendingJournal } from '../src/installer/journal.mjs';
import { createPreserveMatcher, listAllRelFiles, safeRemoveDirBestEffort, syncDirectoryLockSafe } from '../src/installer/sync-dir.mjs';
import { fileURLToPath } from 'node:url';
import { isMainModule } from '../src/shared/paths.mjs';
import { CUSTOMIZATION_URI, PLUGIN_ID, PLUGIN_VERSION, SELF_CATALOG_ID, SELF_REPO_URL, SIDECAR_URI } from '../src/shared/constants.mjs';
import { normalizeRepoUrl } from '../src/preflight/index.mjs';
import { parseJsonc } from '../src/shared/schemas.mjs';
import { resolveMarketDataDir, resolvePluginsDir } from '../src/shared/paths.mjs';
import { buildMarketSidecarHtml } from './build.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');

function hasNodeModulesSegment(baseRoot, targetPath) {
  const rel = relative(baseRoot, targetPath);
  if (!rel || rel === '.') return false;
  return rel.split(/[\\/]/).includes('node_modules');
}

function readPreviousMarket(target) {
  if (!existsSync(target) || readdirSync(target).length === 0) return null;
  function readMetadata(name) {
    const path = join(target, name);
    const stat = lstatSync(path, { throwIfNoEntry: false });
    if (!stat) return null;
    if (!stat.isFile()) throw new Error(`ERR_BOOTSTRAP_CONFLICT: Invalid ${path}`);
    try {
      return parseJsonc(readFileSync(path, 'utf8'));
    } catch (err) {
      if (!(err instanceof SyntaxError)) throw err;
      return null;
    }
  }
  const receipt = readMetadata('.agy-market-receipt.json');
  const manifest = readMetadata('plugin.json');
  const repository = normalizeRepoUrl(manifest?.repository);
  // A legacy junction is detached by sync. Its Git checkout remains untouched.
  const replacingLink = lstatSync(target).isSymbolicLink();
  const owned = receipt
    ? receipt.id === SELF_CATALOG_ID && [0, 1468650761].includes(Number(receipt.repositoryId ?? 0)) &&
      (!receipt.repositoryUrl || normalizeRepoUrl(receipt.repositoryUrl) === SELF_REPO_URL) &&
      (!receipt.pluginRoot || ['.', './'].includes(receipt.pluginRoot))
    : repository === SELF_REPO_URL && (replacingLink || !lstatSync(join(target, '.git'), { throwIfNoEntry: false }));
  if (!owned || (manifest && manifest.name !== PLUGIN_ID) || (repository && repository !== SELF_REPO_URL)) {
    throw new Error(`ERR_BOOTSTRAP_CONFLICT: ${target} contains another installation or a Git worktree.`);
  }
  return receipt;
}

export async function installLocalAgyMarket({ destPluginsDir = '', dataDir = resolveMarketDataDir() } = {}) {
  const indexHtmlPath = join(repoRoot, 'sidecars', 'market_pane', 'index.html');
  if (!existsSync(indexHtmlPath)) {
    await buildMarketSidecarHtml();
  }

  const pluginsDir = destPluginsDir ? resolve(destPluginsDir) : resolvePluginsDir();
  const dstDir = join(pluginsDir, PLUGIN_ID);

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

  const staging = join(dataDir, 'staging');
  mkdirSync(staging, { recursive: true });
  const stage = mkdtempSync(join(staging, 'bootstrap-'));
  let keepStage = false;
  let release;
  try {
    for (const rel of itemsToCopy) {
      const src = join(repoRoot, rel);
      if (!existsSync(src)) continue;
      cpSync(src, join(stage, rel), {
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
      if (!existsSync(join(stage, reqRel))) {
        throw new Error(`ERR_INSTALL_INCOMPLETE: Missing required file "${reqRel}" in ${stage}`);
      }
    }

    const managedFiles = listAllRelFiles(stage).sort();
    const stagedDigest = snapshotDigest(stage, managedFiles);
    release = acquirePluginMutation(dataDir);
    mkdirSync(pluginsDir, { recursive: true });
    const targetKey = createHash('sha256').update(realpathSync.native(pluginsDir)).digest('hex');
    // A failed bootstrap must leave an existing sidecar self-update journal
    // intact. Isolate bootstrap retries by physical installation root.
    const journalDir = join(dataDir, 'bootstrap-journals', targetKey);
    const recovered = recoverInterruptedJournal({ dataDir: journalDir, pluginsDir, syncDataDir: dataDir,
      replacementBundle: { path: stage, digest: stagedDigest } });
    if (recovered.error || recovered.action === 'busy') {
      throw new Error(recovered.error || 'Another bootstrap recovery is active.');
    }
    const pending = readPendingPluginUpdate(dataDir, [dstDir], resolvePluginsDir());
    // A prior release may have left a junction here. The shared sync replaces the link itself.
    const prevReceipt = readPreviousMarket(dstDir);
    const preservePaths = Array.isArray(prevReceipt?.preservePaths) ? prevReceipt.preservePaths : [];
    const initialStat = lstatSync(dstDir, { throwIfNoEntry: false });
    const fresh = !initialStat || initialStat.isSymbolicLink() || !readdirSync(dstDir).length;
    let previousManagedFiles = prevReceipt?.managedFiles;
    if (!Array.isArray(previousManagedFiles)) {
      // A legacy official installation has no inventory. Remember existing
      // overlaps before writing, so a retry cannot claim a later user file.
      const existing = fresh ? [] : listAllRelFiles(dstDir, { tolerateLockErrors: true, deferredLinks: new Set() });
      const folded = new Set(existing.map(rel => rel.toLowerCase()));
      previousManagedFiles = managedFiles.filter(rel => folded.has(rel.toLowerCase()) &&
        lstatSync(join(dstDir, rel), { throwIfNoEntry: false })?.isFile());
    }
    const isPreserved = createPreserveMatcher(preservePaths, dstDir);
    const preservedManifest = !fresh && isPreserved('plugin.json') && existsSync(join(dstDir, 'plugin.json'));
    const manifestRaw = readFileSync(join(preservedManifest ? dstDir : stage, 'plugin.json'));
    const digest = createHash('sha256').update(manifestRaw).digest('hex');
    const nowIso = new Date().toISOString();

    const receipt = {
      schemaVersion: 1,
      id: SELF_CATALOG_ID,
      track: 'verified',
      repositoryId: 1468650761,
      installedDir: PLUGIN_ID,
      effectivePluginName: PLUGIN_ID,
      scopedRewriteApplied: false,
      installedVersion: PLUGIN_VERSION,
      gitTag: `v${PLUGIN_VERSION}`,
      sha256: digest,
      preservePaths,
      managedFiles,
      grantedCapabilities: {
        badges: ['sidecar-ui'],
        mcpRemoteDomains: [],
        hookEvents: [],
      },
      installedAt: prevReceipt?.installedAt || nowIso,
      updatedAt: nowIso,
    };
    const journal = {
      op: 'bootstrap', dir: PLUGIN_ID, pluginsDir: resolve(pluginsDir),
      stagingRootDir: stage, stagingBundleDir: stage, preservePaths, previousManagedFiles, receipt,
      targetIdentity: readJournalTargetIdentity(dstDir, stage),
      snapshotIntegrity: { staging: stagedDigest },
    };
    syncDirectoryLockSafe({
      stagingBundleDir: stage, targetPluginDir: dstDir, dataDir, previousManagedFiles, preservePaths,
      beforeWrite() {
        writePendingJournal(journalDir, journal);
        keepStage = true;
      },
      onRootCreated() { bindPendingJournalRoot(journalDir, journal, dstDir); },
    });
    // Wake the live sidecar when only a transitive module was updated.
    if (!isPreserved('src/sidecar/server.mjs')) {
      const touchNow = new Date();
      utimesSync(join(dstDir, 'src', 'sidecar', 'server.mjs'), touchNow, touchNow);
    }
    writeInstallReceipt(dstDir, receipt);

    if (pending) discardPendingPluginUpdate(dataDir, pending);
    clearPendingJournal(journalDir);
    keepStage = false;
  } finally {
    release?.();
    if (!keepStage) safeRemoveDirBestEffort(stage);
  }

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
