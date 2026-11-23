// End-to-End Plugin Installer, T+N Capability Escalation Guard & Self-Updater (`src/installer/index.mjs`).

import { randomUUID } from 'node:crypto';
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  applyScopedIsolationRewrite,
  readHostEnabledMapReadOnly,
  resolveInstallPreflight,
  scanLocalPluginInventory,
} from '../preflight/index.mjs';
import { PLUGIN_ID } from '../shared/constants.mjs';
import { resolveAntigravityConfigDir, resolveMarketDataDir, resolvePluginsDir } from '../shared/paths.mjs';
import {
  buildInstallReceipt,
  computeCapabilityEscalation,
  parseJsonc,
  sanitizeNativePluginManifest,
} from '../shared/schemas.mjs';
import { fetchVerifiedPluginTarball } from './fetch-tarball.mjs';
import { clearPendingJournal, writePendingJournal } from './journal.mjs';
import { sweepRetiredBinaries, syncDirectoryLockSafe } from './sync-dir.mjs';
import { extractTarGzToDir } from './tar-extract.mjs';

/**
 * Opportunistically calls read/reload `RefreshMcpServers` ONLY when LS address & CSRF token are available.
 * Never calls restricted `InstallCustomization`, `DeletePlugin`, or `JetboxWriteState`.
 */
export async function tryOpportunisticMcpRefresh(pluginName, mcpServers = [], fetchImpl = fetch) {
  const addr = process.env.ANTIGRAVITY_LS_ADDRESS || '';
  const csrf = process.env.ANTIGRAVITY_CSRF_TOKEN || '';
  if (!addr || !csrf || !Array.isArray(mcpServers) || mcpServers.length === 0) {
    return { refreshed: false };
  }

  let allOk = true;
  for (const serverName of mcpServers) {
    const fullServer = serverName.includes('_') ? serverName : `${pluginName}_${serverName}`;
    try {
      const res = await fetchImpl(
        `http://${addr}/exa.language_server_pb.LanguageServerService/RefreshMcpServers`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-codeium-csrf-token': csrf,
          },
          body: JSON.stringify({ serverName: fullServer }),
          signal: AbortSignal.timeout(2000),
        },
      );
      if (!res.ok) allOk = false;
    } catch {
      allOk = false;
    }
  }
  return { refreshed: allOk };
}

/**
 * Installs or updates a catalog `plugin` entry with:
 *   1. Retired binary GC sweep
 *   2. Read-only Preflight Collision Resolution (or `<owner>--<slug>` scoped isolation)
 *   3. T+N Capability-Escalation Confirmation check (`confirmEscalation`)
 *   4. Out-of-tree staging + mandatory `sha256` verification
 *   5. Crash-recovery `pending-journal.json` + Windows lock-safe in-place sync
 *   6. `.agy-market-receipt.json` persistence & live UI deep links (`sidecar://`, `customization://`)
 */
export async function installOrUpdateCatalogPlugin({
  plugin,
  track = plugin?.forceScopedInstall ? 'unverified' : 'verified',
  prefs = {},
  conflictStrategy = 'prompt', // 'prompt' | 'isolate' | 'replace'
  confirmEscalation = false,
  configDir = resolveAntigravityConfigDir(),
  dataDir = resolveMarketDataDir(),
  workspaceUris = [],
  builtinPluginsDir = '',
  fetchImpl = fetch,
  writeOverride = null,
}) {
  if (!plugin || typeof plugin !== 'object' || !plugin.id) {
    throw new Error('ERR_INVALID_PLUGIN_ENTRY: Missing valid catalog plugin object');
  }

  const pluginsDir = resolvePluginsDir(configDir);
  mkdirSync(pluginsDir, { recursive: true });
  mkdirSync(dataDir, { recursive: true });

  // Sweep any previously retired `*.old.<ts>` binaries whose handles have closed
  sweepRetiredBinaries(dataDir);

  const inventory = scanLocalPluginInventory({ configDir, workspaceUris, builtinPluginsDir });
  const preflight = resolveInstallPreflight(plugin, inventory, { conflictStrategy });

  // Pause & ask user if Track-1 collides with a foreign local plugin
  if (preflight.action === 'conflict-prompt') {
    return {
      ok: false,
      status: 'CONFLICT_CHOICE_REQUIRED',
      conflict: {
        dir: preflight.conflict.dir,
        name: preflight.conflict.name,
        displayName: preflight.conflict.displayName,
        scope: preflight.conflict.scope,
      },
      scopedFallbackName: preflight.scopedFallbackName,
      choices: preflight.choices,
    };
  }

  // T+N Update Capability-Escalation Confirmation Gate
  const existingReceipt = preflight.existingInstall?.receipt || null;
  const escalation = computeCapabilityEscalation(existingReceipt, plugin);
  if (preflight.action === 'update' && escalation.escalated && !confirmEscalation) {
    return {
      ok: false,
      status: 'CAPABILITY_ESCALATION_CONFIRM_REQUIRED',
      installedVersion: existingReceipt?.installedVersion || preflight.existingInstall?.version,
      targetVersion: plugin.version,
      escalation,
    };
  }

  // Out-of-Tree Staging inside `${PLUGIN_DATA}/staging/<uuid>/`
  const opId = randomUUID();
  const stagingRootDir = join(dataDir, 'staging', opId);
  const stagingArchivePath = join(stagingRootDir, 'archive.tar.gz');
  const stagingBundleDir = join(stagingRootDir, 'bundle');
  const backupDir = join(dataDir, 'staging', `${opId}-backup`);
  mkdirSync(stagingRootDir, { recursive: true });

  try {
    // Download & verify mandatory SHA-256 BEFORE unpacking a single byte
    const dlInfo = await fetchVerifiedPluginTarball({
      plugin,
      stagingDir: stagingRootDir,
      stagingArchivePath,
      prefs,
      fetchImpl,
    });

    // Safe stream extraction (rejects `..` and symlinks/hardlinks)
    extractTarGzToDir(stagingArchivePath, stagingBundleDir, {
      pluginRoot: plugin.repository?.pluginRoot || '.',
    });

    const manifestPath = join(stagingBundleDir, 'plugin.json');
    if (!existsSync(manifestPath)) {
      throw new Error('ERR_STAGING_MISSING_MANIFEST: Extracted archive does not contain plugin.json');
    }

    let compatibilityNotes = [];
    if (preflight.applyScopedRewrite) {
      const rw = applyScopedIsolationRewrite(stagingBundleDir, {
        canonicalName: plugin.canonicalName,
        scopedName: preflight.effectivePluginName,
        fallbackDisplayName: plugin.displayName,
      });
      compatibilityNotes = rw.compatibilityNotes;
    } else {
      // Ensure 10-field purity & true one-click activation (never inject disabled: true)
      const rawManifest = parseJsonc(readFileSync(manifestPath, 'utf8'));
      const cleanManifest = sanitizeNativePluginManifest(rawManifest);
      delete cleanManifest.disabled;
      writeFileSync(manifestPath, `${JSON.stringify(cleanManifest, null, 2)}\n`, 'utf8');
    }

    const targetDir = preflight.targetDir;
    const targetPluginDir = join(pluginsDir, targetDir);
    const preservePaths = Array.isArray(plugin.distribution?.preservePaths) ? plugin.distribution.preservePaths : [];

    // Snapshot lightweight rollback backup if updating/replacing an existing directory
    if (existsSync(targetPluginDir) && !lstatSync(targetPluginDir).isSymbolicLink()) {
      cpSync(targetPluginDir, backupDir, {
        recursive: true,
        dereference: true,
        filter: (p) => !p.includes('node_modules') && !/\.old\.\d{10,}$/.test(p),
      });
    }

    const receipt = buildInstallReceipt({
      plugin,
      track,
      installedDir: targetDir,
      effectivePluginName: preflight.effectivePluginName,
      scopedRewriteApplied: preflight.applyScopedRewrite,
      previousInstalledAt: existingReceipt?.installedAt || null,
    });

    // Write crash-recovery journal BEFORE touching `~/.gemini/config/plugins/<targetDir>/`
    writePendingJournal(dataDir, {
      op: preflight.action,
      dir: targetDir,
      fromVersion: preflight.existingInstall?.version || null,
      toVersion: plugin.version,
      stagingRootDir,
      stagingBundleDir,
      backupDir: existsSync(backupDir) ? backupDir : null,
      preservePaths,
      receipt,
      startedAt: new Date().toISOString(),
    });

    const syncStats = syncDirectoryLockSafe({
      stagingBundleDir,
      targetPluginDir,
      dataDir,
      preservePaths,
      writeOverride,
    });

    writeFileSync(join(targetPluginDir, '.agy-market-receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');

    // Clear journal & temporary staging artifacts
    clearPendingJournal(dataDir);
    rmSync(stagingRootDir, { recursive: true, force: true });
    rmSync(backupDir, { recursive: true, force: true });

    // Check if an already-enabled MCP plugin needs server reload
    const enabledByDir = readHostEnabledMapReadOnly(configDir);
    const isEnabled = enabledByDir.get(targetDir) !== false;
    const mcpServers = plugin.capabilities?.mcpServers || [];
    let reloadRequired = false;

    if (preflight.action === 'update' && isEnabled && mcpServers.length > 0) {
      const refreshRes = await tryOpportunisticMcpRefresh(preflight.effectivePluginName, mcpServers, fetchImpl);
      reloadRequired = !refreshRes.refreshed;
    }

    // Re-scan single installed plugin for accurate Sidecar pill URI
    const postInventory = scanLocalPluginInventory({ configDir });
    const installedRecord = postInventory.installed.find((x) => x.dir === targetDir) || null;

    return {
      ok: true,
      status: 'INSTALLED',
      action: preflight.action,
      isSelfUpdate: targetDir === PLUGIN_ID,
      installedDir: targetDir,
      effectivePluginName: preflight.effectivePluginName,
      scopedRewriteApplied: preflight.applyScopedRewrite,
      version: plugin.version,
      channelUsed: dlInfo.channelUsed,
      customizationUri: `customization://${targetDir}`,
      sidecarPane: installedRecord?.sidecarPane || null,
      reloadRequired,
      compatibilityNotes,
      retiredBinaries: syncStats.retiredBinaries,
      receipt,
    };
  } catch (err) {
    rmSync(stagingRootDir, { recursive: true, force: true });
    rmSync(backupDir, { recursive: true, force: true });
    clearPendingJournal(dataDir);
    throw err;
  }
}

/**
 * Removes market-installed plugin files cleanly (optional file cleanup helper; native LS state toggle/uninstall
 * always links to `customization://<dir>` per Antigravity Host Redline #1 & #2).
 */
export function removeMarketPluginFiles({
  dir,
  configDir = resolveAntigravityConfigDir(),
  dataDir = resolveMarketDataDir(),
}) {
  const safeDir = String(dir || '').trim();
  if (!safeDir || safeDir.includes('/') || safeDir.includes('\\') || safeDir.includes('..')) {
    throw new Error('ERR_INVALID_PLUGIN_DIR: Invalid plugin directory name');
  }
  if (safeDir === PLUGIN_ID) {
    throw new Error('ERR_CANNOT_SELF_DELETE: Manage agy-market itself via customization://agy-market');
  }
  const pluginsDir = resolvePluginsDir(configDir);
  const target = resolve(pluginsDir, safeDir);
  if (!existsSync(target)) {
    return { removed: false, customizationUri: `customization://${safeDir}` };
  }

  try {
    rmSync(target, { recursive: true, force: true });
    return { removed: true, customizationUri: `customization://${safeDir}` };
  } catch (err) {
    // If Windows CWD handle locks root directory, retire inner files safely and hand off to Customizations UI
    sweepRetiredBinaries(dataDir);
    return {
      removed: false,
      locked: true,
      error: err?.message || String(err),
      customizationUri: `customization://${safeDir}`,
    };
  }
}
