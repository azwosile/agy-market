// End-to-End Plugin Installer, Vault-Parking Toggle, Conflict Fixer, T+N Capability Escalation Guard & Self-Updater (`src/installer/index.mjs`).

import { randomUUID } from 'node:crypto';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import {
  applyScopedIsolationRewrite,
  isDirectorySymlinkOrJunction,
  readHostEnabledMapReadOnly,
  resolveInstallPreflight,
  scanLocalPluginInventory,
} from '../preflight/index.mjs';
import { classifyActivationRequirement } from '../shared/activation.mjs';
import { PLUGIN_ID, toScopedPluginName } from '../shared/constants.mjs';
import {
  resolveAntigravityConfigDir,
  resolveDisabledPluginsDir,
  resolveMarketDataDir,
  resolvePluginsDir,
} from '../shared/paths.mjs';
import {
  buildInstallReceipt,
  computeCapabilityEscalation,
  parseJsonc,
  sanitizeNativePluginManifest,
} from '../shared/schemas.mjs';
import { fetchVerifiedPluginTarball } from './fetch-tarball.mjs';
import { clearPendingJournal, writePendingJournal } from './journal.mjs';
import { recordRetiredBinaries, sweepRetiredBinaries, syncDirectoryLockSafe } from './sync-dir.mjs';
import { extractTarGzToDir } from './tar-extract.mjs';

const LOCK_ERROR_CODES = new Set(['EBUSY', 'EPERM', 'EACCES']);
const MOVE_FALLBACK_CODES = new Set(['EXDEV', 'EBUSY', 'EPERM', 'EACCES', 'EEXIST', 'ENOTEMPTY']);
const RETIRED_BINARY_RE = /\.old\.\d{10,}$/;

function assertSafePluginDir(rawDir, errPrefix = 'ERR_INVALID_PLUGIN_DIR') {
  const safeDir = String(rawDir || '').trim();
  if (
    !safeDir ||
    safeDir === '.' ||
    safeDir === '..' ||
    safeDir.includes('/') ||
    safeDir.includes('\\') ||
    safeDir.includes('..') ||
    /[\x00-\x1f<>:"|?*]/.test(safeDir)
  ) {
    throw new Error(`${errPrefix}: Invalid plugin directory name "${rawDir}"`);
  }
  return safeDir;
}

function mergeCapabilityProfiles(a = {}, b = {}) {
  const capA = a && typeof a === 'object' ? a : {};
  const capB = b && typeof b === 'object' ? b : {};
  const badges = [...new Set([...(capA.badges || []), ...(capB.badges || [])])];
  const hostEnhancementKind = [
    ...new Set([...(capA.hostEnhancementKind || []), ...(capB.hostEnhancementKind || [])]),
  ].sort();
  if (hostEnhancementKind.length > 0 && !badges.includes('host-enhancement')) {
    badges.push('host-enhancement');
  }
  return {
    badges,
    rulesEstimatedTokens: Math.max(Number(capA.rulesEstimatedTokens || 0), Number(capB.rulesEstimatedTokens || 0)),
    mcpServers: [...new Set([...(capA.mcpServers || []), ...(capB.mcpServers || [])])].sort(),
    mcpRemoteDomains: [...new Set([...(capA.mcpRemoteDomains || []), ...(capB.mcpRemoteDomains || [])])].sort(),
    hookEvents: [...new Set([...(capA.hookEvents || []), ...(capB.hookEvents || [])])].sort(),
    hostEnhancementKind,
  };
}

function stripDisabledFlagFromManifest(pluginDir) {
  const manifestPath = join(pluginDir, 'plugin.json');
  if (!existsSync(manifestPath)) return false;
  try {
    const raw = parseJsonc(readFileSync(manifestPath, 'utf8'));
    if (raw && typeof raw === 'object' && Object.prototype.hasOwnProperty.call(raw, 'disabled')) {
      const clean = sanitizeNativePluginManifest(raw);
      delete clean.disabled;
      writeFileSync(manifestPath, `${JSON.stringify(clean, null, 2)}\n`, 'utf8');
      return true;
    }
  } catch {
    /* ignore malformed manifest */
  }
  return false;
}

function removeSymlinkOrJunctionOnly(linkPath) {
  try {
    unlinkSync(linkPath);
  } catch (err) {
    if (err?.code === 'EPERM' || err?.code === 'EISDIR') {
      rmdirSync(linkPath);
    } else {
      throw err;
    }
  }
}

/**
 * Lock-safe fallback cleanup when `rmSync(activeDir)` fails on Windows due to a running process
 * holding open handles on binaries or the plugin's CWD. Removes `plugin.json` first so the host
 * unloads the plugin, retires locked files to `*.old.<ts>`, and records them for boot GC.
 */
function cleanupLockedPluginDir({
  targetDir,
  dataDir,
  nowMs = Date.now(),
  unlinkFn = unlinkSync,
  renameFn = renameSync,
}) {
  const retired = [];
  if (!existsSync(targetDir)) return retired;

  // Priority unload: remove manifest & entry configs first so host immediately drops the plugin
  for (const priorityRel of ['plugin.json', 'hooks.json', 'mcp_config.json']) {
    const p = join(targetDir, priorityRel);
    if (!existsSync(p)) continue;
    try {
      unlinkFn(p);
    } catch (err) {
      if (LOCK_ERROR_CODES.has(err?.code)) {
        const retiredPath = `${p}.old.${nowMs}`;
        try {
          renameFn(p, retiredPath);
          retired.push(retiredPath);
        } catch {
          /* leave for next sweep */
        }
      }
    }
  }

  function walkAndSweep(curDir) {
    let entries;
    try {
      entries = readdirSync(curDir);
    } catch {
      return;
    }
    for (const name of entries) {
      const full = join(curDir, name);
      let lst;
      try {
        lst = lstatSync(full);
      } catch {
        continue;
      }
      if (lst.isSymbolicLink()) {
        try {
          removeSymlinkOrJunctionOnly(full);
        } catch {
          /* ignore */
        }
        continue;
      }
      if (lst.isDirectory()) {
        walkAndSweep(full);
        try {
          if (readdirSync(full).length === 0) {
            rmSync(full, { recursive: true, force: true });
          }
        } catch {
          /* directory handle still held */
        }
        continue;
      }
      if (RETIRED_BINARY_RE.test(name)) continue;
      try {
        unlinkFn(full);
      } catch (err) {
        if (LOCK_ERROR_CODES.has(err?.code) && existsSync(full)) {
          const retiredPath = `${full}.old.${nowMs}`;
          try {
            renameFn(full, retiredPath);
            retired.push(retiredPath);
          } catch {
            /* leave locked file until restart */
          }
        }
      }
    }
  }

  walkAndSweep(targetDir);
  if (retired.length > 0) {
    recordRetiredBinaries(dataDir, retired);
  }
  try {
    if (existsSync(targetDir) && readdirSync(targetDir).length === 0) {
      rmSync(targetDir, { recursive: true, force: true });
    }
  } catch {
    /* root CWD handle held until client restart */
  }
  return retired;
}

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
 * Enables or disables an installed global plugin via Vault Parking (`${dataDir}/disabled-plugins/<dir>`),
 * NEVER writing `~/.gemini/config/config.json`.
 */
export function toggleInstalledPlugin({
  dir,
  enabled,
  configDir = resolveAntigravityConfigDir(),
  dataDir = resolveMarketDataDir(),
  catalogCapabilities = null,
  nowMs = Date.now(),
  renameOverride = null,
  rmOverride = null,
  unlinkOverride = null,
}) {
  const safeDir = assertSafePluginDir(dir);
  if (safeDir === PLUGIN_ID) {
    throw new Error('ERR_CANNOT_DISABLE_SELF: Cannot disable or park agy-market from inside its own pane');
  }
  if (typeof enabled !== 'boolean') {
    throw new Error('ERR_INVALID_ENABLED_FLAG: "enabled" must be a boolean');
  }

  const hostEnabled = readHostEnabledMapReadOnly(configDir).get(safeDir);
  if (hostEnabled === false) {
    throw new Error(
      `ERR_HOST_DISABLED: Plugin "${safeDir}" is disabled in Antigravity config.json; re-enable it in Antigravity Settings`,
    );
  }

  const pluginsDir = resolvePluginsDir(configDir);
  const disabledDir = resolveDisabledPluginsDir(dataDir);
  mkdirSync(pluginsDir, { recursive: true });
  mkdirSync(disabledDir, { recursive: true });

  sweepRetiredBinaries(dataDir);

  const activePath = join(pluginsDir, safeDir);
  const parkedPath = join(disabledDir, safeDir);
  const renameFn = typeof renameOverride === 'function' ? renameOverride : renameSync;
  const rmFn = typeof rmOverride === 'function' ? rmOverride : rmSync;
  const unlinkFn = typeof unlinkOverride === 'function' ? unlinkOverride : unlinkSync;

  const preInv = scanLocalPluginInventory({ configDir, dataDir });
  const preRecord = preInv.installed.find((x) => x.scope === 'global' && x.dir === safeDir) || null;
  const baseCaps = mergeCapabilityProfiles(preRecord?.capabilities || {}, catalogCapabilities || {});

  // ------------------------------------------------------------------------
  // Disable -> Park `${pluginsDir}/${dir}` into `${dataDir}/disabled-plugins/${dir}`
  // ------------------------------------------------------------------------
  if (!enabled) {
    if (!existsSync(join(activePath, 'plugin.json'))) {
      if (existsSync(join(parkedPath, 'plugin.json'))) {
        const activation = classifyActivationRequirement(baseCaps, { action: 'disable' });
        return {
          ok: true,
          dir: safeDir,
          enabled: false,
          parkedByMarket: true,
          lockedOnDisable: false,
          retiredBinaries: [],
          restartRequired: activation.level === 'host-restart',
          reloadRequired: activation.level === 'reload-pane',
          activation,
        };
      }
      throw new Error(`ERR_PLUGIN_NOT_FOUND: Plugin "${safeDir}" not found in global plugins directory`);
    }

    let lockedOnDisable = false;
    let retiredBinaries = [];

    if (existsSync(parkedPath)) {
      rmSync(parkedPath, { recursive: true, force: true });
    }

    const activeLinkInfo = isDirectorySymlinkOrJunction(pluginsDir, safeDir);
    if (activeLinkInfo.isSymlink) {
      cpSync(activePath, parkedPath, {
        recursive: true,
        dereference: true,
        filter: (p) => !RETIRED_BINARY_RE.test(p),
      });
      removeSymlinkOrJunctionOnly(activePath);
    } else {
      try {
        renameFn(activePath, parkedPath);
      } catch (err) {
        if (!MOVE_FALLBACK_CODES.has(err?.code)) {
          throw err;
        }
        cpSync(activePath, parkedPath, {
          recursive: true,
          dereference: true,
          filter: (p) => !RETIRED_BINARY_RE.test(p),
        });
        try {
          rmFn(activePath, { recursive: true, force: true });
        } catch (rmErr) {
          if (!LOCK_ERROR_CODES.has(rmErr?.code)) {
            throw rmErr;
          }
          lockedOnDisable = true;
          retiredBinaries = cleanupLockedPluginDir({
            targetDir: activePath,
            dataDir,
            nowMs,
            unlinkFn,
            renameFn: renameSync,
          });
        }
      }
    }

    const activation = classifyActivationRequirement(baseCaps, {
      lockedOnDisable,
      retiredBinaries,
      action: 'disable',
    });
    const restartRequired = activation.level === 'host-restart' || lockedOnDisable || retiredBinaries.length > 0;
    const reloadRequired = activation.level === 'reload-pane';

    return {
      ok: true,
      dir: safeDir,
      enabled: false,
      parkedByMarket: true,
      lockedOnDisable,
      retiredBinaries,
      restartRequired,
      reloadRequired,
      activation,
    };
  }

  // ------------------------------------------------------------------------
  // Enable -> Unpark `${dataDir}/disabled-plugins/${dir}` -> `${pluginsDir}/${dir}`
  // ------------------------------------------------------------------------
  if (!existsSync(join(parkedPath, 'plugin.json'))) {
    if (existsSync(join(activePath, 'plugin.json'))) {
      // Ensure real non-symlink dir & clean manifest even if already active
      const activeLinkInfo = isDirectorySymlinkOrJunction(pluginsDir, safeDir);
      if (activeLinkInfo.isSymlink) {
        fixLocalConflict({ type: 'materialize-symlink', targetDir: safeDir, configDir, dataDir });
      }
      stripDisabledFlagFromManifest(activePath);
      const activation = classifyActivationRequirement(baseCaps, { action: 'enable' });
      return {
        ok: true,
        dir: safeDir,
        enabled: true,
        parkedByMarket: false,
        lockedOnDisable: false,
        retiredBinaries: [],
        restartRequired: activation.level === 'host-restart',
        reloadRequired: activation.level === 'reload-pane',
        activation,
      };
    }
    throw new Error(`ERR_PLUGIN_NOT_FOUND: Parked plugin "${safeDir}" not found in disabled-plugins vault`);
  }

  let retiredBinaries = [];
  const parkedLinkInfo = isDirectorySymlinkOrJunction(disabledDir, safeDir);

  if (existsSync(activePath)) {
    // Active path still exists (e.g., leftover locked empty/retired folder from earlier Windows EBUSY disable)
    const syncStats = syncDirectoryLockSafe({
      stagingBundleDir: parkedPath,
      targetPluginDir: activePath,
      dataDir,
      nowMs,
    });
    retiredBinaries = syncStats.retiredBinaries;
    if (parkedLinkInfo.isSymlink) {
      removeSymlinkOrJunctionOnly(parkedPath);
    } else {
      rmSync(parkedPath, { recursive: true, force: true });
    }
  } else if (parkedLinkInfo.isSymlink) {
    cpSync(parkedPath, activePath, { recursive: true, dereference: true });
    removeSymlinkOrJunctionOnly(parkedPath);
  } else {
    try {
      renameFn(parkedPath, activePath);
    } catch (err) {
      if (!MOVE_FALLBACK_CODES.has(err?.code)) {
        throw err;
      }
      const syncStats = syncDirectoryLockSafe({
        stagingBundleDir: parkedPath,
        targetPluginDir: activePath,
        dataDir,
        nowMs,
      });
      retiredBinaries = syncStats.retiredBinaries;
      rmSync(parkedPath, { recursive: true, force: true });
    }
  }

  // Strip `"disabled": true` if present and guarantee a real non-symlink directory
  stripDisabledFlagFromManifest(activePath);
  const postLinkInfo = isDirectorySymlinkOrJunction(pluginsDir, safeDir);
  if (postLinkInfo.isSymlink) {
    fixLocalConflict({ type: 'materialize-symlink', targetDir: safeDir, configDir, dataDir });
  }

  const postInv = scanLocalPluginInventory({ configDir, dataDir });
  const postRecord = postInv.installed.find((x) => x.scope === 'global' && x.dir === safeDir) || null;
  const mergedCaps = mergeCapabilityProfiles(postRecord?.capabilities || baseCaps, catalogCapabilities || {});
  const activation = classifyActivationRequirement(mergedCaps, {
    retiredBinaries,
    action: 'enable',
  });
  const restartRequired = activation.level === 'host-restart' || retiredBinaries.length > 0;
  const reloadRequired = activation.level === 'reload-pane';

  return {
    ok: true,
    dir: safeDir,
    enabled: true,
    parkedByMarket: false,
    lockedOnDisable: false,
    retiredBinaries,
    restartRequired,
    reloadRequired,
    activation,
  };
}

/**
 * Applies a 1-click automated conflict remediation (`isolate-rename` or `materialize-symlink`)
 * strictly inside global `~/.gemini/config/plugins/`.
 */
export function fixLocalConflict({
  type,
  targetDir,
  suggestedDir = '',
  configDir = resolveAntigravityConfigDir(),
  dataDir = resolveMarketDataDir(),
  linkInfoOverride = null,
  unlinkLinkOverride = null,
}) {
  const safeTarget = assertSafePluginDir(targetDir);
  if (safeTarget === PLUGIN_ID) {
    throw new Error('ERR_CANNOT_MODIFY_SELF: Cannot apply conflict rewrite to agy-market itself');
  }

  const pluginsDir = resolvePluginsDir(configDir);
  const disabledDir = resolveDisabledPluginsDir(dataDir);
  const srcPath = join(pluginsDir, safeTarget);

  if (type === 'isolate-rename') {
    if (!existsSync(join(srcPath, 'plugin.json'))) {
      throw new Error(`ERR_PLUGIN_NOT_FOUND: Global plugin "${safeTarget}" not found`);
    }
    const rawManifest = parseJsonc(readFileSync(join(srcPath, 'plugin.json'), 'utf8'));
    const oldName = String(rawManifest?.name || safeTarget).trim();
    const newDir = suggestedDir
      ? assertSafePluginDir(suggestedDir, 'ERR_INVALID_SUGGESTED_DIR')
      : toScopedPluginName('local', oldName || safeTarget);

    if (newDir === PLUGIN_ID) {
      throw new Error('ERR_INVALID_SUGGESTED_DIR: Suggested directory cannot be agy-market');
    }

    const dstPath = join(pluginsDir, newDir);
    if (existsSync(dstPath) || existsSync(join(disabledDir, newDir))) {
      throw new Error(`ERR_TARGET_DIR_EXISTS: Target plugin directory "${newDir}" already exists`);
    }

    const linkInfo = isDirectorySymlinkOrJunction(pluginsDir, safeTarget);
    if (linkInfo.isSymlink) {
      cpSync(srcPath, dstPath, { recursive: true, dereference: true });
      removeSymlinkOrJunctionOnly(srcPath);
    } else {
      try {
        renameSync(srcPath, dstPath);
      } catch (err) {
        if (!MOVE_FALLBACK_CODES.has(err?.code)) throw err;
        cpSync(srcPath, dstPath, { recursive: true, dereference: true });
        rmSync(srcPath, { recursive: true, force: true });
      }
    }

    const rw = applyScopedIsolationRewrite(dstPath, {
      canonicalName: oldName,
      scopedName: newDir,
      fallbackDisplayName: rawManifest?.displayName || oldName,
    });

    const receiptPath = join(dstPath, '.agy-market-receipt.json');
    if (existsSync(receiptPath)) {
      try {
        const rec = JSON.parse(readFileSync(receiptPath, 'utf8'));
        rec.installedDir = newDir;
        rec.effectivePluginName = newDir;
        rec.scopedRewriteApplied = true;
        rec.updatedAt = new Date().toISOString();
        writeFileSync(receiptPath, `${JSON.stringify(rec, null, 2)}\n`, 'utf8');
      } catch {
        /* non-fatal */
      }
    }

    return {
      ok: true,
      type: 'isolate-rename',
      targetDir: safeTarget,
      newDir,
      compatibilityNotes: rw.compatibilityNotes,
      messageZh: `已将冲突插件 "${safeTarget}" 隔离重命名为 "${newDir}" 并同步重写内部协议链接。`,
      messageEn: `Isolated and renamed "${safeTarget}" to "${newDir}" with internal protocol links updated.`,
    };
  }

  if (type === 'materialize-symlink') {
    const customLinkInfo = typeof linkInfoOverride === 'function' ? linkInfoOverride(pluginsDir, safeTarget) : null;
    const linkInfo = customLinkInfo || isDirectorySymlinkOrJunction(pluginsDir, safeTarget);
    if (!linkInfo.lstat) {
      throw new Error(`ERR_PLUGIN_NOT_FOUND: Global plugin "${safeTarget}" not found`);
    }
    if (!linkInfo.isSymlink) {
      return {
        ok: true,
        type: 'materialize-symlink',
        targetDir: safeTarget,
        newDir: safeTarget,
        materialized: false,
        compatibilityNotes: [],
        messageZh: `"${safeTarget}" 已经是实体目录，无需转换。`,
        messageEn: `"${safeTarget}" is already a real directory.`,
      };
    }

    mkdirSync(join(dataDir, 'staging'), { recursive: true });
    const tmpStage = join(dataDir, 'staging', `materialize-${randomUUID()}`);
    try {
      const copySource = customLinkInfo && linkInfo.realPath ? linkInfo.realPath : srcPath;
      cpSync(copySource, tmpStage, { recursive: true, dereference: true });
      if (typeof unlinkLinkOverride === 'function') {
        unlinkLinkOverride(srcPath);
      } else {
        removeSymlinkOrJunctionOnly(srcPath);
      }
      try {
        renameSync(tmpStage, srcPath);
      } catch (err) {
        if (!MOVE_FALLBACK_CODES.has(err?.code)) throw err;
        cpSync(tmpStage, srcPath, { recursive: true, dereference: true });
        rmSync(tmpStage, { recursive: true, force: true });
      }
    } catch (err) {
      rmSync(tmpStage, { recursive: true, force: true });
      throw err;
    }

    return {
      ok: true,
      type: 'materialize-symlink',
      targetDir: safeTarget,
      newDir: safeTarget,
      materialized: true,
      compatibilityNotes: [],
      messageZh: `已将符号链接/联接目录 "${safeTarget}" 转为实体目录，宿主现在可正常发现该插件。`,
      messageEn: `Materialized symlink/junction "${safeTarget}" into a real directory for Antigravity discovery.`,
    };
  }

  throw new Error(`ERR_UNSUPPORTED_FIX_TYPE: Unsupported conflict fix type "${type}"`);
}

/**
 * Installs or updates a catalog `plugin` entry with:
 *   1. Retired binary GC sweep
 *   2. Read-only Preflight Collision Resolution (or `<owner>--<slug>` scoped isolation)
 *   3. T+N Capability-Escalation Confirmation check (`confirmEscalation`)
 *   4. Out-of-tree staging + mandatory `sha256` verification
 *   5. Crash-recovery `pending-journal.json` + Windows lock-safe in-place sync
 *      (if updating a currently parked/disabled plugin, syncs into `${dataDir}/disabled-plugins/<dir>` so it stays disabled!)
 *   6. `.agy-market-receipt.json` persistence, activation classification & live UI metadata
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
  const disabledDir = resolveDisabledPluginsDir(dataDir);
  mkdirSync(pluginsDir, { recursive: true });
  mkdirSync(dataDir, { recursive: true });

  // Sweep any previously retired `*.old.<ts>` binaries whose handles have closed
  sweepRetiredBinaries(dataDir);

  const inventory = scanLocalPluginInventory({ configDir, dataDir, workspaceUris, builtinPluginsDir });
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

  // Keep parked plugins parked when updating in-place!
  const isUpdatingParked = Boolean(
    preflight.existingInstall?.parkedByMarket || preflight.existingInstall?.currentlyParked,
  );
  if (isUpdatingParked) {
    mkdirSync(disabledDir, { recursive: true });
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
    const targetRootDir = isUpdatingParked ? disabledDir : pluginsDir;
    const targetPluginDir = join(targetRootDir, targetDir);
    const preservePaths = Array.isArray(plugin.distribution?.preservePaths) ? plugin.distribution.preservePaths : [];

    // Snapshot lightweight rollback backup if updating/replacing an existing directory
    if (existsSync(targetPluginDir) && !lstatSync(targetPluginDir).isSymbolicLink()) {
      cpSync(targetPluginDir, backupDir, {
        recursive: true,
        dereference: true,
        filter: (p) => !p.includes('node_modules') && !RETIRED_BINARY_RE.test(p),
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

    // Write crash-recovery journal BEFORE touching target plugin directory
    writePendingJournal(dataDir, {
      op: preflight.action,
      dir: targetDir,
      parkedByMarket: isUpdatingParked,
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

    // Check if an already-enabled MCP plugin needs server reload (skip if parked/disabled)
    const enabledByDir = readHostEnabledMapReadOnly(configDir);
    const isEnabled = !isUpdatingParked && enabledByDir.get(targetDir) !== false;
    const mcpServers = plugin.capabilities?.mcpServers || [];
    let reloadRequired = false;
    let mcpRefreshed = false;

    if (preflight.action === 'update' && isEnabled && mcpServers.length > 0) {
      const refreshRes = await tryOpportunisticMcpRefresh(preflight.effectivePluginName, mcpServers, fetchImpl);
      mcpRefreshed = Boolean(refreshRes.refreshed);
      reloadRequired = !mcpRefreshed;
    }

    // Re-scan single installed plugin for accurate Sidecar pill URI & local capabilities
    const postInventory = scanLocalPluginInventory({ configDir, dataDir });
    const installedRecord = postInventory.installed.find((x) => x.dir === targetDir) || null;
    const mergedCaps = mergeCapabilityProfiles(installedRecord?.capabilities || {}, plugin.capabilities || {});
    const activation = classifyActivationRequirement(mergedCaps, {
      retiredBinaries: syncStats.retiredBinaries,
      reloadRequired,
      mcpRefreshed,
      action: preflight.action,
    });
    const restartRequired = activation.level === 'host-restart' || syncStats.retiredBinaries.length > 0;

    return {
      ok: true,
      status: 'INSTALLED',
      action: preflight.action,
      isSelfUpdate: targetDir === PLUGIN_ID,
      installedDir: targetDir,
      effectivePluginName: preflight.effectivePluginName,
      scopedRewriteApplied: preflight.applyScopedRewrite,
      parkedByMarket: isUpdatingParked,
      version: plugin.version,
      channelUsed: dlInfo.channelUsed,
      customizationUri: `customization://${targetDir}`,
      sidecarPane: installedRecord?.sidecarPane || null,
      reloadRequired,
      restartRequired,
      activation,
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
 * Removes market-installed plugin files cleanly from active `plugins/<dir>` and/or parked `disabled-plugins/<dir>`.
 */
export function removeMarketPluginFiles({
  dir,
  configDir = resolveAntigravityConfigDir(),
  dataDir = resolveMarketDataDir(),
}) {
  const safeDir = assertSafePluginDir(dir);
  if (safeDir === PLUGIN_ID) {
    throw new Error('ERR_CANNOT_SELF_DELETE: Manage agy-market itself via customization://agy-market');
  }
  const pluginsDir = resolvePluginsDir(configDir);
  const disabledDir = resolveDisabledPluginsDir(dataDir);
  const activeTarget = resolve(pluginsDir, safeDir);
  const parkedTarget = resolve(disabledDir, safeDir);

  const hasActive = existsSync(activeTarget);
  const hasParked = existsSync(parkedTarget);
  if (!hasActive && !hasParked) {
    return { removed: false, customizationUri: `customization://${safeDir}` };
  }

  let removedAny = false;
  let lockedError = null;

  if (hasParked) {
    try {
      rmSync(parkedTarget, { recursive: true, force: true });
      removedAny = true;
    } catch (err) {
      lockedError = err;
    }
  }

  if (hasActive) {
    try {
      const linkInfo = isDirectorySymlinkOrJunction(pluginsDir, safeDir);
      if (linkInfo.isSymlink) {
        removeSymlinkOrJunctionOnly(activeTarget);
      } else {
        rmSync(activeTarget, { recursive: true, force: true });
      }
      removedAny = true;
    } catch (err) {
      lockedError = err;
    }
  }

  if (lockedError) {
    sweepRetiredBinaries(dataDir);
    return {
      removed: removedAny,
      locked: true,
      error: lockedError?.message || String(lockedError),
      customizationUri: `customization://${safeDir}`,
    };
  }

  return { removed: removedAny, customizationUri: `customization://${safeDir}` };
}
