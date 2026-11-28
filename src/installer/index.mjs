// End-to-End Plugin Installer, Vault-Parking Toggle, Conflict Fixer, T+N Capability Escalation Guard & Self-Updater (`src/installer/index.mjs`).

import { randomUUID } from 'node:crypto';
import {
  copyFileSync,
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
import { join, relative, resolve } from 'node:path';
import {
  applyScopedIsolationRewrite,
  isDirectorySymlinkOrJunction,
  normalizeRepoUrl,
  readHostEnabledMapReadOnly,
  resolveInstallPreflight,
  scanLocalPluginComponents,
  scanLocalPluginInventory,
} from '../preflight/index.mjs';
import { classifyActivationRequirement } from '../shared/activation.mjs';
import { PLUGIN_ID, toScopedPluginName } from '../shared/constants.mjs';
import { defaultProxyFetch } from '../shared/proxy-fetch.mjs';
import {
  resolveAntigravityConfigDir,
  resolveDisabledPluginsDir,
  resolveMarketDataDir,
  resolvePluginsDir,
} from '../shared/paths.mjs';
import {
  buildInstallReceipt,
  computeCapabilityEscalation,
  loadPrefsFromDisk,
  parseJsonc,
  sanitizeNativePluginManifest,
  savePrefsToDisk,
} from '../shared/schemas.mjs';
import { parseGithubRepoSlug, safeGithubCacheKey } from '../updates/index.mjs';
import { fetchVerifiedPluginTarball } from './fetch-tarball.mjs';
import { clearPendingJournal, writePendingJournal } from './journal.mjs';
import {
  listAllRelFiles,
  recordRetiredBinaries,
  removeSymlinkOrJunctionOnly,
  safeRemoveDirBestEffort,
  sweepRetiredBinaries,
  syncDirectoryLockSafe,
  withLockRetrySync,
} from './sync-dir.mjs';
import { extractTarGzStreamToDir } from './tar-extract.mjs';

function resolveEffectiveFetch(fetchImpl) {
  return !fetchImpl || fetchImpl === fetch ? defaultProxyFetch : fetchImpl;
}

function hasNodeModulesSegment(baseRoot, targetPath) {
  const rel = relative(baseRoot, targetPath);
  if (!rel || rel === '.') return false;
  return rel.split(/[\\/]/).includes('node_modules');
}

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

function annotateLockError(err, stage, relPath = '') {
  if (!err || !LOCK_ERROR_CODES.has(err.code)) return err;
  const tag = `[${stage}]`;
  const msg = String(err.message || err);
  if (msg.includes(tag)) return err;
  const cleanRel = relPath ? String(relPath).replace(/\\/g, '/') : '';
  const prefix = cleanRel && !cleanRel.startsWith('..') ? `${tag} (${cleanRel}) ` : `${tag} `;
  try {
    err.message = `${prefix}${msg}`;
    return err;
  } catch {
    const wrapped = new Error(`${prefix}${msg}`);
    wrapped.code = err.code;
    wrapped.errno = err.errno;
    wrapped.syscall = err.syscall;
    wrapped.path = err.path;
    wrapped.cause = err;
    return wrapped;
  }
}

/**
 * Safely snapshots an existing plugin directory to `dstDir` without dereferencing symlinks/junctions.
 * Skips `node_modules`, `.git`, and retired `*.old.<ts>` binaries, retries transient lock errors 3x,
 * and skips persistently locked entries with a warning so updates are never blocked.
 */
function snapshotBackupSafe(srcDir, dstDir, { onWarning = null } = {}) {
  const warn = (relPath, err) => {
    const msg = `[backup] Skipping locked item "${relPath || '.'}": ${err?.code || ''} ${err?.message || err}`.trim();
    if (typeof onWarning === 'function') {
      onWarning(msg);
    } else {
      console.warn(msg);
    }
  };

  let rootLst;
  try {
    if (!existsSync(srcDir)) return false;
    rootLst = withLockRetrySync(() => lstatSync(srcDir));
  } catch (err) {
    if (LOCK_ERROR_CODES.has(err?.code) || err?.code === 'ENOENT') {
      warn('.', err);
      return false;
    }
    throw err;
  }
  if (rootLst.isSymbolicLink() || !rootLst.isDirectory()) {
    return false;
  }

  mkdirSync(dstDir, { recursive: true });

  function walk(curSrc, curDst, relPrefix) {
    let entries;
    try {
      entries = withLockRetrySync(() => readdirSync(curSrc));
    } catch (err) {
      if (LOCK_ERROR_CODES.has(err?.code) || err?.code === 'ENOENT') {
        warn(relPrefix, err);
        return;
      }
      throw err;
    }

    for (const name of entries) {
      if (name === 'node_modules' || name === '.git' || RETIRED_BINARY_RE.test(name)) {
        continue;
      }
      const srcItem = join(curSrc, name);
      const dstItem = join(curDst, name);
      const rel = relPrefix ? `${relPrefix}/${name}` : name;

      let lst;
      try {
        lst = withLockRetrySync(() => lstatSync(srcItem));
      } catch (err) {
        if (LOCK_ERROR_CODES.has(err?.code) || err?.code === 'ENOENT') {
          warn(rel, err);
          continue;
        }
        throw err;
      }

      if (lst.isSymbolicLink()) {
        continue;
      }

      if (lst.isDirectory()) {
        mkdirSync(dstItem, { recursive: true });
        walk(srcItem, dstItem, rel);
      } else if (lst.isFile()) {
        try {
          mkdirSync(curDst, { recursive: true });
          withLockRetrySync(() => copyFileSync(srcItem, dstItem));
        } catch (err) {
          if (LOCK_ERROR_CODES.has(err?.code) || err?.code === 'ENOENT') {
            warn(rel, err);
            continue;
          }
          throw err;
        }
      }
    }
  }

  walk(srcDir, dstDir, '');
  return true;
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
export async function tryOpportunisticMcpRefresh(pluginName, mcpServers = [], fetchImpl = defaultProxyFetch) {
  const activeFetch = resolveEffectiveFetch(fetchImpl);
  const addr = process.env.ANTIGRAVITY_LS_ADDRESS || '';
  const csrf = process.env.ANTIGRAVITY_CSRF_TOKEN || '';
  if (!addr || !csrf || !Array.isArray(mcpServers) || mcpServers.length === 0) {
    return { refreshed: false };
  }

  let allOk = true;
  for (const serverName of mcpServers) {
    const fullServer = serverName.includes('_') ? serverName : `${pluginName}_${serverName}`;
    try {
      const res = await activeFetch(
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
        safeRemoveDirBestEffort(tmpStage);
      }
    } catch (err) {
      safeRemoveDirBestEffort(tmpStage);
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
  preferredDir = '',
  confirmEscalation = false,
  configDir = resolveAntigravityConfigDir(),
  pluginsDir: explicitPluginsDir = '',
  dataDir = resolveMarketDataDir(),
  workspaceUris = [],
  builtinPluginsDir = '',
  fetchImpl = defaultProxyFetch,
  preverifiedArchivePath = '',
  writeOverride = null,
}) {
  const activeFetch = resolveEffectiveFetch(fetchImpl);
  if (!plugin || typeof plugin !== 'object' || !plugin.id) {
    throw new Error('ERR_INVALID_PLUGIN_ENTRY: Missing valid catalog plugin object');
  }

  const pluginsDir = explicitPluginsDir ? resolve(explicitPluginsDir) : resolvePluginsDir(configDir);
  const disabledDir = resolveDisabledPluginsDir(dataDir);
  mkdirSync(pluginsDir, { recursive: true });
  mkdirSync(dataDir, { recursive: true });

  // Sweep any previously retired `*.old.<ts>` binaries whose handles have closed
  sweepRetiredBinaries(dataDir);

  const inventory = scanLocalPluginInventory({
    configDir,
    pluginsDir,
    dataDir,
    workspaceUris,
    builtinPluginsDir,
  });
  const preflight = resolveInstallPreflight(plugin, inventory, { conflictStrategy, preferredDir });

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

  let installStage = 'staging';
  let targetPluginDirForErr = '';

  try {
    // Download & verify mandatory SHA-256 BEFORE unpacking a single byte
    const dlInfo = await fetchVerifiedPluginTarball({
      plugin,
      stagingDir: stagingRootDir,
      stagingArchivePath,
      prefs,
      fetchImpl: activeFetch,
      preverifiedArchivePath,
    });

    // Safe stream extraction (rejects `..` and symlinks/hardlinks) with O(MB) RAM
    await extractTarGzStreamToDir(stagingArchivePath, stagingBundleDir, {
      pluginRoot: plugin.repository?.pluginRoot || '.',
    });

    const manifestPath = join(stagingBundleDir, 'plugin.json');
    const dotManifestPath = join(stagingBundleDir, '.antigravity-plugin', 'plugin.json');
    if (!existsSync(manifestPath)) {
      if (existsSync(dotManifestPath)) {
        // Support `.antigravity-plugin/plugin.json` layout while preserving root mcp_config.json / assets / skills
        const rawDotManifest = parseJsonc(readFileSync(dotManifestPath, 'utf8'));
        const cleanDotManifest = sanitizeNativePluginManifest(rawDotManifest);
        delete cleanDotManifest.disabled;
        writeFileSync(manifestPath, `${JSON.stringify(cleanDotManifest, null, 2)}\n`, 'utf8');
      } else {
        throw new Error('ERR_STAGING_MISSING_MANIFEST: Extracted archive does not contain plugin.json');
      }
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
    targetPluginDirForErr = targetPluginDir;
    const preservePaths = [
      ...new Set([
        ...(Array.isArray(existingReceipt?.preservePaths) ? existingReceipt.preservePaths : []),
        ...(Array.isArray(plugin.distribution?.preservePaths) ? plugin.distribution.preservePaths : []),
      ]),
    ];
    const previousManagedFiles = Array.isArray(existingReceipt?.managedFiles) ? existingReceipt.managedFiles : null;

    // Snapshot lightweight lock-safe rollback backup if updating/replacing an existing directory
    installStage = 'backup';
    snapshotBackupSafe(targetPluginDir, backupDir);

    const incomingManagedFiles = listAllRelFiles(stagingBundleDir, { tolerateLockErrors: false })
      .filter((rel) => rel !== '.agy-market-receipt.json')
      .sort();

    const receipt = buildInstallReceipt({
      plugin,
      track,
      installedDir: targetDir,
      effectivePluginName: preflight.effectivePluginName,
      scopedRewriteApplied: preflight.applyScopedRewrite,
      previousInstalledAt: existingReceipt?.installedAt || null,
      actualSha256: dlInfo.sha256,
      preservePaths,
      managedFiles: incomingManagedFiles,
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
      previousManagedFiles,
      receipt,
      startedAt: new Date().toISOString(),
    });

    installStage = 'sync';
    const syncStats = syncDirectoryLockSafe({
      stagingBundleDir,
      targetPluginDir,
      dataDir,
      preservePaths,
      previousManagedFiles,
      writeOverride,
    });

    const verifiedManagedFiles = Array.isArray(syncStats.managedFiles)
      ? [...new Set(syncStats.managedFiles.filter((rel) => rel !== '.agy-market-receipt.json'))].sort()
      : incomingManagedFiles;
    if (JSON.stringify(verifiedManagedFiles) !== JSON.stringify(receipt.managedFiles || [])) {
      receipt.managedFiles = verifiedManagedFiles;
    }

    writeFileSync(join(targetPluginDir, '.agy-market-receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');

    // Clear journal & temporary staging artifacts (best-effort so brief Windows Defender locks never fail a finished update)
    clearPendingJournal(dataDir);
    safeRemoveDirBestEffort(stagingRootDir);
    safeRemoveDirBestEffort(backupDir);

    // Check if an already-enabled MCP plugin needs server reload (skip if parked/disabled)
    const enabledByDir = readHostEnabledMapReadOnly(configDir);
    const isEnabled = !isUpdatingParked && enabledByDir.get(targetDir) !== false;
    const mcpServers = plugin.capabilities?.mcpServers || [];
    let reloadRequired = false;
    let mcpRefreshed = false;

    if (preflight.action === 'update' && isEnabled && mcpServers.length > 0) {
      const refreshRes = await tryOpportunisticMcpRefresh(preflight.effectivePluginName, mcpServers, activeFetch);
      mcpRefreshed = Boolean(refreshRes.refreshed);
      reloadRequired = !mcpRefreshed;
    }

    // Re-scan single installed plugin for accurate Sidecar pill URI & local capabilities
    const postInventory = scanLocalPluginInventory({ configDir, pluginsDir, dataDir });
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
    safeRemoveDirBestEffort(stagingRootDir);
    safeRemoveDirBestEffort(backupDir);
    try {
      clearPendingJournal(dataDir);
    } catch {
      /* never mask original error */
    }
    const relPath =
      targetPluginDirForErr && err?.path ? relative(targetPluginDirForErr, String(err.path)) : '';
    throw annotateLockError(err, installStage, relPath);
  }
}

function removeMarketPluginFilesInternal({
  dir,
  configDir = resolveAntigravityConfigDir(),
  pluginsDir: explicitPluginsDir = '',
  dataDir = resolveMarketDataDir(),
  workspaceUris = [],
  builtinPluginsDir = '',
  catalogCapabilities = null,
  removeFavorite = false,
  extraFavoriteKeys = [],
  nowMs = Date.now(),
  rmOverride = null,
  unlinkOverride = null,
  renameOverride = null,
  linkInfoOverride = null,
  unlinkLinkOverride = null,
}) {
  const safeDir = assertSafePluginDir(dir);
  if (safeDir === PLUGIN_ID) {
    throw new Error('ERR_CANNOT_SELF_DELETE: Manage agy-market itself via customization://agy-market');
  }
  const pluginsDir = explicitPluginsDir ? resolve(explicitPluginsDir) : resolvePluginsDir(configDir);
  const disabledDir = resolveDisabledPluginsDir(dataDir);
  const activeTarget = resolve(pluginsDir, safeDir);
  const parkedTarget = resolve(disabledDir, safeDir);

  const activeLinkInfo =
    typeof linkInfoOverride === 'function'
      ? linkInfoOverride(pluginsDir, safeDir) || isDirectorySymlinkOrJunction(pluginsDir, safeDir)
      : isDirectorySymlinkOrJunction(pluginsDir, safeDir);
  const parkedLinkInfo =
    typeof linkInfoOverride === 'function'
      ? linkInfoOverride(disabledDir, safeDir) || isDirectorySymlinkOrJunction(disabledDir, safeDir)
      : isDirectorySymlinkOrJunction(disabledDir, safeDir);

  const hasActive = Boolean(activeLinkInfo?.lstat) || existsSync(activeTarget);
  const hasParked = Boolean(parkedLinkInfo?.lstat) || existsSync(parkedTarget);

  if (!hasActive && !hasParked) {
    if ((Array.isArray(workspaceUris) && workspaceUris.length > 0) || builtinPluginsDir) {
      const inv = scanLocalPluginInventory({
        configDir,
        pluginsDir,
        dataDir,
        workspaceUris,
        builtinPluginsDir,
        linkInfoOverride,
      });
      const wsMatch = inv.installed.find(
        (item) => item.scope === 'workspace' && (item.dir === safeDir || item.name === safeDir),
      );
      if (wsMatch) {
        throw new Error(
          `ERR_CANNOT_UNINSTALL_WORKSPACE: Plugin "${safeDir}" is a workspace-scoped plugin and cannot be uninstalled from global plugins`,
        );
      }
      const builtinMatch = inv.installed.find(
        (item) => item.scope === 'builtin' && (item.dir === safeDir || item.name === safeDir),
      );
      if (builtinMatch) {
        throw new Error(
          `ERR_CANNOT_UNINSTALL_BUILTIN: Plugin "${safeDir}" is a built-in plugin and cannot be uninstalled`,
        );
      }
    }
    const activation = classifyActivationRequirement({}, { action: 'uninstall' });
    return {
      publicResult: {
        removed: false,
        locked: false,
        retiredBinaries: [],
        hadMcp: false,
        restartRequired: false,
        activation,
        customizationUri: `customization://${safeDir}`,
      },
      mcpServers: [],
      effectivePluginName: safeDir,
      mergedCaps: {},
    };
  }

  // Sweep any previously retired binaries before uninstalling the target plugin
  sweepRetiredBinaries(dataDir);

  // Snapshot manifest, receipt, capabilities, MCP state, and repoSlug BEFORE removing files
  const snapshotDir =
    hasActive && existsSync(join(activeTarget, 'plugin.json'))
      ? activeTarget
      : hasParked && existsSync(join(parkedTarget, 'plugin.json'))
        ? parkedTarget
        : hasActive
          ? activeTarget
          : parkedTarget;

  let manifest = null;
  const snapshotManifestPath = join(snapshotDir, 'plugin.json');
  if (existsSync(snapshotManifestPath)) {
    try {
      manifest = parseJsonc(readFileSync(snapshotManifestPath, 'utf8'));
    } catch {
      manifest = null;
    }
  }

  let receipt = null;
  const snapshotReceiptPath = join(snapshotDir, '.agy-market-receipt.json');
  if (existsSync(snapshotReceiptPath)) {
    try {
      receipt = JSON.parse(readFileSync(snapshotReceiptPath, 'utf8'));
    } catch {
      receipt = null;
    }
  }

  let components = null;
  try {
    if (existsSync(snapshotDir)) {
      components = scanLocalPluginComponents(snapshotDir, safeDir, String(manifest?.name || safeDir), receipt);
    }
  } catch {
    components = null;
  }

  const mergedCaps = mergeCapabilityProfiles(components?.capabilities || {}, catalogCapabilities || {});
  const mcpServers = [...new Set([...(components?.mcpServerKeys || []), ...(mergedCaps.mcpServers || [])])];
  const hadMcp = Boolean(
    components?.hasMcp ||
      mcpServers.length > 0 ||
      mergedCaps.badges.includes('mcp-stdio') ||
      mergedCaps.badges.includes('mcp-remote'),
  );
  const effectivePluginName = String(receipt?.effectivePluginName || manifest?.name || safeDir);

  let repoSlug =
    parseGithubRepoSlug(receipt?.repositoryUrl) ||
    parseGithubRepoSlug(manifest?.repository) ||
    parseGithubRepoSlug(manifest?.homepage) ||
    null;
  if (!repoSlug && existsSync(join(snapshotDir, 'package.json'))) {
    try {
      const pkg = parseJsonc(readFileSync(join(snapshotDir, 'package.json'), 'utf8'));
      repoSlug = parseGithubRepoSlug(pkg?.repository) || parseGithubRepoSlug(pkg?.homepage) || null;
    } catch {
      /* ignore */
    }
  }
  if (!repoSlug && receipt?.id) {
    const idMatch = /^([A-Za-z0-9-]+)__([A-Za-z0-9_.-]+?)(?:--.*)?$/.exec(String(receipt.id).trim());
    if (idMatch) {
      repoSlug = parseGithubRepoSlug(normalizeRepoUrl(`https://github.com/${idMatch[1]}/${idMatch[2]}`));
    }
  }

  const rmFn = typeof rmOverride === 'function' ? rmOverride : rmSync;
  const unlinkFn = typeof unlinkOverride === 'function' ? unlinkOverride : unlinkSync;
  const renameFn = typeof renameOverride === 'function' ? renameOverride : renameSync;
  const unlinkLinkFn =
    typeof unlinkLinkOverride === 'function' ? unlinkLinkOverride : removeSymlinkOrJunctionOnly;

  function removeOneTarget(targetPath, linkInfo) {
    if (linkInfo?.isSymlink) {
      try {
        unlinkLinkFn(targetPath);
        return { removed: true, locked: false, retired: [], error: null };
      } catch (err) {
        if (LOCK_ERROR_CODES.has(err?.code)) {
          const stillThere = existsSync(join(targetPath, 'plugin.json')) || existsSync(targetPath);
          return { removed: !stillThere, locked: true, retired: [], error: stillThere ? err : null };
        }
        throw err;
      }
    }

    try {
      rmFn(targetPath, { recursive: true, force: true });
      return { removed: true, locked: false, retired: [], error: null };
    } catch (err) {
      if (!LOCK_ERROR_CODES.has(err?.code)) {
        throw err;
      }
      const retired = cleanupLockedPluginDir({
        targetDir: targetPath,
        dataDir,
        nowMs,
        unlinkFn,
        renameFn,
      });
      const manifestGone = !existsSync(join(targetPath, 'plugin.json'));
      return {
        removed: manifestGone,
        locked: true,
        retired,
        error: manifestGone ? null : err,
      };
    }
  }

  const parkedRes = hasParked ? removeOneTarget(parkedTarget, parkedLinkInfo) : null;
  const activeRes = hasActive ? removeOneTarget(activeTarget, activeLinkInfo) : null;

  const retiredBinaries = [...new Set([...(parkedRes?.retired || []), ...(activeRes?.retired || [])])];
  const locked = Boolean(parkedRes?.locked || activeRes?.locked);
  const lastError = activeRes?.error || parkedRes?.error || null;
  const manifestStillPresent =
    (hasActive && existsSync(join(activeTarget, 'plugin.json'))) ||
    (hasParked && existsSync(join(parkedTarget, 'plugin.json')));
  const removed =
    !manifestStillPresent &&
    Boolean((parkedRes ? parkedRes.removed : true) && (activeRes ? activeRes.removed : true));

  // Post-removal hygiene: purge stale GitHub cache files for this repoSlug & optional favorite cleanup
  if (removed) {
    if (repoSlug) {
      const ghCacheDir = join(dataDir, 'cache', 'github');
      if (existsSync(ghCacheDir)) {
        const cacheKey = safeGithubCacheKey(repoSlug.owner, repoSlug.repo);
        const exactFiles = new Set([
          `updates-${cacheKey}.json`,
          `repo-meta-${cacheKey}.json`,
          `discussions-gql-${cacheKey}.json`,
        ]);
        const branchPrefix = `branch-${cacheKey}-`;
        try {
          for (const fname of readdirSync(ghCacheDir)) {
            if (exactFiles.has(fname) || (fname.startsWith(branchPrefix) && fname.endsWith('.json'))) {
              try {
                rmSync(join(ghCacheDir, fname), { force: true });
              } catch {
                /* non-fatal */
              }
            }
          }
        } catch {
          /* non-fatal */
        }
      }
    }

    if (removeFavorite) {
      try {
        const diskPrefs = loadPrefsFromDisk(dataDir);
        const dropSet = new Set(
          [
            safeDir,
            `local:${safeDir}`,
            receipt?.id,
            manifest?.name,
            manifest?.name ? `local:${manifest.name}` : '',
            ...(Array.isArray(extraFavoriteKeys) ? extraFavoriteKeys : []),
          ]
            .map((v) => String(v || '').trim())
            .filter(Boolean),
        );
        const prevFavs = Array.isArray(diskPrefs.favorites) ? diskPrefs.favorites : [];
        const nextFavs = prevFavs.filter((item) => !dropSet.has(item));
        if (nextFavs.length !== prevFavs.length) {
          savePrefsToDisk(dataDir, { ...diskPrefs, favorites: nextFavs });
        }
      } catch {
        /* non-fatal */
      }
    }
  }

  const activation = classifyActivationRequirement(mergedCaps, {
    retiredBinaries,
    lockedOnRemove: locked,
    action: 'uninstall',
  });

  const publicResult = {
    removed,
    locked,
    retiredBinaries,
    hadMcp,
    restartRequired: activation.level !== 'instant',
    activation,
    customizationUri: `customization://${safeDir}`,
    ...(!removed && lastError ? { error: lastError?.message || String(lastError) } : {}),
  };

  return {
    publicResult,
    mcpServers,
    effectivePluginName,
    mergedCaps,
  };
}

/**
 * Removes installed global plugin files cleanly (lock-safe on Windows, symlink-safe on all OSes)
 * from active `plugins/<dir>` and/or parked `disabled-plugins/<dir>` without ever touching `config.json`.
 */
export function removeMarketPluginFiles(options = {}) {
  return removeMarketPluginFilesInternal(options).publicResult;
}

/**
 * Async uninstall wrapper around `removeMarketPluginFiles` that additionally performs
 * opportunistic `RefreshMcpServers` reload when an MCP plugin was removed.
 */
export async function uninstallPlugin(options = {}) {
  const { fetchImpl = defaultProxyFetch, ...rest } = options || {};
  const activeFetch = resolveEffectiveFetch(fetchImpl);
  const { publicResult, mcpServers, effectivePluginName, mergedCaps } = removeMarketPluginFilesInternal(rest);

  if (publicResult.removed && publicResult.hadMcp && mcpServers.length > 0) {
    const refreshRes = await tryOpportunisticMcpRefresh(effectivePluginName, mcpServers, activeFetch);
    if (refreshRes.refreshed) {
      const activation = classifyActivationRequirement(mergedCaps, {
        retiredBinaries: publicResult.retiredBinaries,
        lockedOnRemove: publicResult.locked,
        reloadRequired: false,
        mcpRefreshed: true,
        action: 'uninstall',
      });
      return {
        ...publicResult,
        mcpRefreshed: true,
        restartRequired: activation.level !== 'instant',
        activation,
      };
    }
  }

  return {
    ...publicResult,
    mcpRefreshed: false,
  };
}
