// End-to-End Plugin Installer, Vault-Parking Toggle, Conflict Fixer, T+N Capability Escalation Guard & Self-Updater (`src/installer/index.mjs`).

import { isDeepStrictEqual } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import {
  constants as fsConstants,
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
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
  findCatalogEntryForLocal,
  isDirectorySymlinkOrJunction,
  matchLegacyLocalFavorite,
  localUninstallKey,
  normalizeRepoUrl,
  readHostEnabledMapReadOnly,
  resolveInstallPreflight,
  samePluginName,
  resolveLocalPluginSource,
  scanLocalPluginComponents,
  scanLocalPluginInventory,
} from '../preflight/index.mjs';
import { classifyActivationRequirement } from '../shared/activation.mjs';
import { PLUGIN_ID, SELF_CATALOG_ID, toScopedPluginName } from '../shared/constants.mjs';
import { defaultProxyFetch } from '../shared/proxy-fetch.mjs';
import { compareSemver, parseSemver } from '../shared/semver.mjs';
import {
  assertSafePluginDir,
  isHostPluginsDir,
  resolveAntigravityConfigDir,
  resolveDisabledPluginsDir,
  resolveMarketDataDir,
  resolvePluginsDir,
} from '../shared/paths.mjs';
import {
  buildInstallReceipt,
  computeCapabilityEscalation,
  mergeCapabilityProfiles,
  normalizePluginRoot,
  makeFavoriteSource,
  parseJsonc,
  sanitizeNativePluginManifest,
  updatePrefsOnDisk,
} from '../shared/schemas.mjs';
import { isForeignMarketInstall, isOfficialMarketEntry, parseGithubRepoSlug, safeGithubCacheKey } from '../updates/index.mjs';
import { fetchVerifiedPluginTarball } from './fetch-tarball.mjs';
import {
  acquirePluginMutation, bindPendingJournalRoot, clearPendingJournal, discardPendingPluginUpdate,
  commitJournalReceipt, readJournalTargetIdentity, readPendingPluginUpdate, snapshotDigest, trackRollbackAdditions, writePendingJournal,
} from './journal.mjs';
import {
  createPreserveMatcher,
  hasLockedRemovals,
  isRetiredPluginRemnant,
  listAllRelFiles,
  recordLockedRemoval,
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

export function getReplacementKey(plugin, conflict) {
  if (!conflict?.path || conflict.scope !== 'global' || conflict.unidentified) return '';
  return createHash('sha256').update(JSON.stringify([
    plugin.id, plugin.repository?.url, plugin.repository?.pluginRoot || '.', plugin.distribution?.sha256,
    conflict.dir, conflict.path, conflict.realPath, conflict.parkedByMarket,
    readJournalTargetIdentity(conflict.path),
  ])).digest('hex');
}

export function getUpdateEscalation(plugin, preflight, archiveSha256 = plugin.distribution?.sha256) {
  const installed = preflight.existingInstall;
  const escalation = computeCapabilityEscalation(installed?.receipt, plugin, installed?.capabilities);
  if (!escalation.escalated) return escalation;
  const approvalKey = createHash('sha256').update(JSON.stringify([
    preflight.targetDir, installed?.version, installed?.receipt?.id || '', installed?.receipt?.sha256 || '',
    plugin.id, normalizeRepoUrl(plugin.repository?.url), plugin.repository?.repositoryId || 0, plugin.repository?.pluginRoot || '.',
    plugin.version, plugin.gitTag || '', plugin.commitSha || '', plugin.distribution?.sha256 || '',
    plugin.distribution?.commitFallbackSha256 || '', String(archiveSha256 || '').toLowerCase(),
    ...[escalation.addedBadges, escalation.addedRemoteDomains, escalation.addedHookEvents].map(items => [...items].sort()),
  ])).digest('hex');
  return { ...escalation, approvalKey };
}

const LOCK_ERROR_CODES = new Set(['EBUSY', 'EPERM', 'EACCES']);
const MOVE_FALLBACK_CODES = new Set(['EXDEV', 'EBUSY', 'EPERM', 'EACCES', 'EEXIST', 'ENOTEMPTY']);
const RETIRED_BINARY_RE = /\.old\.\d{10,}$/;

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
 * Inside dependency and Git directories, copy the paths this operation could change.
 * A locked item permits forward update but disqualifies the snapshot for rollback.
 */
function snapshotBackupSafe(srcDir, dstDir, { previousManagedFiles, incomingFiles, preservePaths }) {
  const copied = [];
  const isPreserved = createPreserveMatcher(preservePaths, srcDir);
  let complete = true;
  const affected = new Set();
  for (const file of [...(previousManagedFiles || []), ...incomingFiles]) {
    if (typeof file !== 'string') continue;
    const parts = file.replace(/\\/g, '/').toLowerCase().split('/');
    let path = '';
    for (const part of parts) {
      path = path ? path + '/' + part : part;
      affected.add(path);
    }
  }
  const warn = (relPath, err) => {
    complete = false;
    const msg = `[backup] Skipping locked item "${relPath || '.'}": ${err?.code || ''} ${err?.message || err}`.trim();
    console.warn(msg);
  };

  let rootLst;
  try {
    if (!existsSync(srcDir)) return null;
    rootLst = withLockRetrySync(() => lstatSync(srcDir));
  } catch (err) {
    if (LOCK_ERROR_CODES.has(err?.code) || err?.code === 'ENOENT') {
      warn('.', err);
      return null;
    }
    throw err;
  }
  if (rootLst.isSymbolicLink() || !rootLst.isDirectory()) {
    return null;
  }

  mkdirSync(dstDir, { recursive: true });

  function walk(curSrc, curDst, relPrefix, selective = false) {
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
      const srcItem = join(curSrc, name);
      const dstItem = join(curDst, name);
      const rel = relPrefix ? `${relPrefix}/${name}` : name;

      const filterChildren = selective || name === 'node_modules' || name === '.git';
      if (RETIRED_BINARY_RE.test(name) && !affected.has(rel.toLowerCase())) continue;
      if (filterChildren && !affected.has(rel.toLowerCase())) continue;

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
        if (!isPreserved(rel) && affected.has(rel.toLowerCase())) complete = false;
        continue;
      }

      if (lst.isDirectory()) {
        mkdirSync(dstItem, { recursive: true });
        walk(srcItem, dstItem, rel, filterChildren);
      } else if (lst.isFile()) {
        try {
          mkdirSync(curDst, { recursive: true });
          withLockRetrySync(() => copyFileSync(srcItem, dstItem));
          copied.push(rel);
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
  return complete ? copied : null;
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
          } catch (renameError) {
            if (LOCK_ERROR_CODES.has(renameError?.code)) recordLockedRemoval(dataDir, targetDir, full);
            else if (renameError?.code !== 'ENOENT') throw renameError;
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
function movePluginUnderLock(options, move) {
  const dataDir = options.dataDir || resolveMarketDataDir();
  const pluginsDir = resolvePluginsDir(options.configDir);
  const release = acquirePluginMutation(dataDir);
  try {
    const src = assertSafePluginDir(options.targetDir || options.dir);
    const paths = [join(pluginsDir, src), join(resolveDisabledPluginsDir(dataDir), src)];
    if (readPendingPluginUpdate(dataDir, paths, pluginsDir)) {
      throw new Error('ERR_PENDING_RECOVERY: Recover the interrupted update before moving this plugin.');
    }
    return move(options);
  } finally {
    release();
  }
}

export function toggleInstalledPlugin(options) {
  return movePluginUnderLock(options, toggleUnderLock);
}

function toggleUnderLock({
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
  if (samePluginName(safeDir, PLUGIN_ID)) {
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

    if (lstatSync(parkedPath, { throwIfNoEntry: false })) {
      throw new Error(`ERR_TARGET_DIR_EXISTS: A parked copy of "${safeDir}" already exists`);
    }

    const copyToVault = source => {
      const stagingDir = join(dataDir, 'staging');
      mkdirSync(stagingDir, { recursive: true });
      const staging = mkdtempSync(join(stagingDir, 'parking-'));
      try {
        cpSync(source, staging, { recursive: true, filter: path => {
          if (RETIRED_BINARY_RE.test(path)) return false;
          if (lstatSync(path).isSymbolicLink()) throw new Error('ERR_PLUGIN_LAYOUT_CONFLICT: Cannot park a nested symbolic link by copying: ' + path);
          return true;
        } });
        renameSync(staging, parkedPath);
      } finally {
        safeRemoveDirBestEffort(staging);
      }
    };
    const activeLinkInfo = isDirectorySymlinkOrJunction(pluginsDir, safeDir);
    if (activeLinkInfo.isSymlink) {
      copyToVault(activeLinkInfo.realPath);
      try {
        removeSymlinkOrJunctionOnly(activePath);
      } catch (err) {
        rmSync(parkedPath, { recursive: true, force: true });
        throw err;
      }
    } else {
      try {
        renameFn(activePath, parkedPath);
      } catch (err) {
        if (!MOVE_FALLBACK_CODES.has(err?.code)) {
          throw err;
        }
        copyToVault(activeLinkInfo.realPath);
        // Unload before recursive removal can delete any of the still-active plugin's files.
        try {
          withLockRetrySync(() => unlinkFn(join(activePath, 'plugin.json')));
        } catch (err) {
          rmSync(parkedPath, { recursive: true, force: true });
          throw new Error(`ERR_PLUGIN_DISABLE_FAILED: Cannot unload "${safeDir}". Close the process holding plugin.json and retry.`, { cause: err });
        }
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
        fixConflictUnderLock({ type: 'materialize-symlink', targetDir: safeDir, configDir, dataDir });
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

  function checkRestoreTarget() {
    if (!lstatSync(activePath, { throwIfNoEntry: false })) return false;
    if (!isRetiredPluginRemnant(activePath, dataDir)) {
      throw new Error(`ERR_TARGET_DIR_EXISTS: Cannot enable "${safeDir}" because its active directory is occupied.`);
    }
    return true;
  }

  function copyIntoRemnant() {
    const created = [];
    try {
      const stats = syncDirectoryLockSafe({
        stagingBundleDir: parkedPath, targetPluginDir: activePath, dataDir, nowMs,
        writeOverride(src, dst) {
          copyFileSync(src, dst, fsConstants.COPYFILE_EXCL);
          created.push(dst);
        },
      });
      retiredBinaries = stats.retiredBinaries;
    } catch (err) {
      for (const path of created.reverse()) rmSync(path, { force: true });
      throw err;
    }
  }

  function restoreCopy() {
    if (checkRestoreTarget()) {
      copyIntoRemnant();
    } else if (statSync(parkedPath).dev !== statSync(pluginsDir).dev) {
      mkdirSync(activePath);
      copyIntoRemnant();
    } else {
      // Prepare outside host discovery; publish in one rename on the same volume.
      const stagingDir = join(dataDir, 'staging');
      mkdirSync(stagingDir, { recursive: true });
      const stage = mkdtempSync(join(stagingDir, 'unpark-'));
      try {
        syncDirectoryLockSafe({ stagingBundleDir: parkedPath, targetPluginDir: stage, dataDir });
        if (checkRestoreTarget()) throw new Error(`ERR_TARGET_DIR_EXISTS: Directory "${safeDir}" appeared during restore.`);
        try {
          renameSync(stage, activePath);
        } catch (err) {
          if (err.code !== 'EXDEV') throw err;
          mkdirSync(activePath);
          copyIntoRemnant();
        }
      } finally {
        safeRemoveDirBestEffort(stage);
      }
    }
    if (parkedLinkInfo.isSymlink) removeSymlinkOrJunctionOnly(parkedPath);
    else rmSync(parkedPath, { recursive: true, force: true });
  }

  if (checkRestoreTarget() || parkedLinkInfo.isSymlink) {
    restoreCopy();
  } else {
    try {
      renameFn(parkedPath, activePath);
    } catch (err) {
      if (!MOVE_FALLBACK_CODES.has(err?.code)) throw err;
      restoreCopy();
    }
  }

  // Strip `"disabled": true` if present and guarantee a real non-symlink directory
  stripDisabledFlagFromManifest(activePath);
  const postLinkInfo = isDirectorySymlinkOrJunction(pluginsDir, safeDir);
  if (postLinkInfo.isSymlink) {
    fixConflictUnderLock({ type: 'materialize-symlink', targetDir: safeDir, configDir, dataDir });
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
export function fixLocalConflict(options) {
  return movePluginUnderLock(options, fixConflictUnderLock);
}

function fixConflictUnderLock({
  type,
  targetDir,
  suggestedDir = '',
  configDir = resolveAntigravityConfigDir(),
  dataDir = resolveMarketDataDir(),
  linkInfoOverride = null,
  unlinkLinkOverride = null,
}) {
  const safeTarget = assertSafePluginDir(targetDir);
  if (samePluginName(safeTarget, PLUGIN_ID)) {
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

    if (samePluginName(newDir, PLUGIN_ID)) {
      throw new Error('ERR_INVALID_SUGGESTED_DIR: Suggested directory cannot be agy-market');
    }

    const dstPath = join(pluginsDir, newDir);
    if (readPendingPluginUpdate(dataDir, [dstPath, join(disabledDir, newDir)], pluginsDir)) {
      throw new Error('ERR_PENDING_RECOVERY: The new directory is reserved for an interrupted update.');
    }
    if (existsSync(dstPath) || existsSync(join(disabledDir, newDir))) {
      throw new Error(`ERR_TARGET_DIR_EXISTS: Target plugin directory "${newDir}" already exists`);
    }

    const linkInfo = isDirectorySymlinkOrJunction(pluginsDir, safeTarget);
    let moved = false;
    let copying = false;
    const originals = new Map();
    function writeText(path, text) {
      originals.set(path, readFileSync(path));
      writeFileSync(path, text, 'utf8');
    }

    let rw;
    try {
      if (!linkInfo.isSymlink) {
        try {
          renameSync(srcPath, dstPath);
          moved = true;
        } catch (err) {
          if (!MOVE_FALLBACK_CODES.has(err?.code)) throw err;
        }
      }
      if (!moved) {
        // Keep the source intact until the copy, rewrites and receipt are complete.
        mkdirSync(dstPath);
        copying = true;
        cpSync(linkInfo.realPath || srcPath, dstPath, {
          recursive: true,
          dereference: true,
          filter: path => {
            if (lstatSync(path).isSymbolicLink()) throw new Error('Cannot copy a nested symbolic link: ' + path);
            return true;
          },
        });
      }
      rw = applyScopedIsolationRewrite(dstPath, {
        canonicalName: oldName, scopedName: newDir, fallbackDisplayName: rawManifest?.displayName || oldName, writeText,
      });
      const receiptPath = join(dstPath, '.agy-market-receipt.json');
      const receiptStat = lstatSync(receiptPath, { throwIfNoEntry: false });
      if (receiptStat) {
        if (!receiptStat.isFile()) throw new Error('Expected a regular plugin receipt');
        const rec = JSON.parse(readFileSync(receiptPath, 'utf8'));
        Object.assign(rec, { installedDir: newDir, effectivePluginName: newDir, scopedRewriteApplied: true,
          updatedAt: new Date().toISOString() });
        writeText(receiptPath, `${JSON.stringify(rec, null, 2)}\n`);
      }
    } catch (err) {
      if (moved) {
        try {
          for (const [path, original] of originals) writeFileSync(path, original);
        } finally {
          renameSync(dstPath, srcPath);
        }
      } else if (copying) {
        safeRemoveDirBestEffort(dstPath);
      }
      throw err;
    }
    if (!moved) {
      try {
        if (linkInfo.isSymlink) removeSymlinkOrJunctionOnly(srcPath);
        else rmSync(srcPath, { recursive: true, force: true });
      } catch (err) {
        if (!linkInfo.isSymlink) {
          // A failed recursive removal may have deleted part of the old tree.
          // Keep the complete destination until all original files are back.
          cpSync(dstPath, srcPath, { recursive: true, force: false });
          for (const [path, original] of originals) writeFileSync(join(srcPath, relative(dstPath, path)), original);
        }
        safeRemoveDirBestEffort(dstPath);
        throw err;
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
 *   3. Out-of-tree staging + mandatory `sha256` verification
 *   4. Compare declared and staged capabilities with the installed grants
 *   5. Crash-recovery `pending-journal.json` + Windows lock-safe in-place sync
 *      (if updating a currently parked/disabled plugin, syncs into `${dataDir}/disabled-plugins/<dir>` so it stays disabled!)
 *   6. `.agy-market-receipt.json` persistence, activation classification & live UI metadata
 */
export async function installOrUpdateCatalogPlugin({
  plugin,
  track = plugin?.forceScopedInstall ? 'unverified' : 'verified',
  prefs = {},
  conflictStrategy = 'prompt', // 'prompt' | 'isolate' | 'replace'
  replacementKey = '',
  preferredDir = '',
  requireExistingDir = false,
  allowLegacyRename = true,
  catalogPlugins = [],
  confirmEscalation = false,
  approvalKey = '',
  rejectDowngrade = false,
  resyncVersion = '',
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
  if (plugin.id === SELF_CATALOG_ID && !isOfficialMarketEntry(plugin)) {
    throw new Error('ERR_UPDATE_TARGET_MISMATCH: The marketplace update requires its official repository and root plugin.');
  }

  const pluginsDir = explicitPluginsDir ? resolve(explicitPluginsDir) : resolvePluginsDir(configDir);
  const disabledDir = resolveDisabledPluginsDir(dataDir);
  mkdirSync(pluginsDir, { recursive: true });
  mkdirSync(dataDir, { recursive: true });

  if (hasLockedRemovals(dataDir)) {
    const unlock = acquirePluginMutation(dataDir);
    try { sweepRetiredBinaries(dataDir); } finally { unlock(); }
  }
  const scanOptions = { configDir, pluginsDir, dataDir, workspaceUris, builtinPluginsDir, catalogPlugins };
  const preflightOptions = { conflictStrategy, preferredDir, requireExistingDir, allowLegacyRename };
  const initial = resolveInstallPreflight(plugin, scanLocalPluginInventory(scanOptions), preflightOptions);
  if (conflictStrategy === 'replace' && replacementKey &&
      (initial.action !== 'replace-local' || getReplacementKey(plugin, initial.conflict) !== replacementKey)) {
    throw new Error('ERR_REPLACEMENT_TARGET_CHANGED: The conflicting copy has changed. Review the current conflict before replacing it.');
  }
  if (samePluginName(initial.targetDir, PLUGIN_ID) && isForeignMarketInstall(initial.existingInstall)) {
    throw new Error('ERR_UPDATE_TARGET_MISMATCH: The market directory belongs to a different source.');
  }

  function guardGitCheckout(preflight) {
    if (preflight.existingInstall?.isGitManaged) {
      throw new Error(`ERR_UNMANAGED_GIT_OR_UNVERSIONED: "${preflight.targetDir}" is a Git checkout. Update it with Git.`);
    }
  }
  guardGitCheckout(initial);

  if (initial.action === 'scoped-target-occupied') {
    throw new Error(`ERR_SCOPED_TARGET_OCCUPIED: 隔离目录或名称 "${initial.targetDir}" 已被其他安装占用。`);
  }

  // Pause & ask user if Track-1 collides with a foreign local plugin
  if (initial.action === 'conflict-prompt' || (initial.action === 'replace-local' && !replacementKey)) {
    return {
      ok: false,
      status: 'CONFLICT_CHOICE_REQUIRED',
      conflict: {
        dir: initial.conflict.dir,
        name: initial.conflict.name,
        displayName: initial.conflict.displayName,
        scope: initial.conflict.scope,
      },
      scopedFallbackName: initial.scopedFallbackName || plugin.scopedName,
      choices: initial.choices || ['isolate', 'replace'],
      replacementKey: initial.choices && !initial.choices.includes('replace') ? '' : getReplacementKey(plugin, initial.conflict),
    };
  }

  if (initial.action === 'update' && rejectDowngrade && parseSemver(initial.existingInstall.version) &&
      (!parseSemver(plugin.version) || compareSemver(plugin.version, initial.existingInstall.version) < 0)) {
    throw new Error(`ERR_UPDATE_DOWNGRADE: Target ${plugin.version} is older than or incompatible with installed ${initial.existingInstall.version}.`);
  }
  if (resyncVersion && (compareSemver(plugin.version, resyncVersion) !== 0 ||
      compareSemver(initial.existingInstall?.version, resyncVersion) !== 0)) {
    throw new Error('ERR_UPDATE_TARGET_MISMATCH: The requested release does not match the installed version to resync.');
  }

  // Out-of-Tree Staging inside `${PLUGIN_DATA}/staging/<uuid>/`
  const opId = randomUUID();
  const stagingRootDir = join(dataDir, 'staging', opId);
  const stagingArchivePath = join(stagingRootDir, 'archive.tar.gz');
  const stagingBundleDir = join(stagingRootDir, 'bundle');
  const backupDir = join(dataDir, 'staging', `${opId}-backup`);
  mkdirSync(stagingRootDir, { recursive: true });

  let journalPending = false;
  let releaseMutation;
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

    // Downloading can outlive a toggle, uninstall or another install in a different process.
    // Use the current vault location, but require a fresh request if the approved target changed.
    releaseMutation = acquirePluginMutation(dataDir);
    const inventory = scanLocalPluginInventory({ ...scanOptions, bypassCache: true });
    const preflight = resolveInstallPreflight(plugin, inventory, preflightOptions);
    guardGitCheckout(preflight);
    const existing = preflight.existingInstall;
    const previous = initial.existingInstall;
    if ((preflight.action === 'replace-local' && getReplacementKey(plugin, preflight.conflict) !== replacementKey) ||
        initial.action !== preflight.action || initial.targetDir !== preflight.targetDir ||
        initial.effectivePluginName !== preflight.effectivePluginName ||
        initial.applyScopedRewrite !== preflight.applyScopedRewrite ||
        previous?.name !== existing?.name || previous?.version !== existing?.version ||
        previous?.repositoryUrl !== existing?.repositoryUrl || previous?.repositoryRoot !== existing?.repositoryRoot ||
        !isDeepStrictEqual(previous?.receipt, existing?.receipt) ||
        !isDeepStrictEqual(previous?.capabilities, existing?.capabilities)) {
      throw new Error('ERR_UPDATE_TARGET_MISMATCH: The installed plugin changed during download. Retry the operation.');
    }
    const isUpdatingParked = Boolean(existing?.parkedByMarket);
    const existingReceipt = existing?.receipt || null;
    sweepRetiredBinaries(dataDir);

    let effectivePluginName;
    let compatibilityNotes = [];
    if (preflight.applyScopedRewrite) {
      const rw = applyScopedIsolationRewrite(stagingBundleDir, {
        canonicalName: plugin.canonicalName,
        scopedName: preflight.effectivePluginName,
        fallbackDisplayName: plugin.displayName,
      });
      effectivePluginName = rw.manifest.name;
      compatibilityNotes = rw.compatibilityNotes;
    } else {
      // Ensure 10-field purity & true one-click activation (never inject disabled: true)
      const rawManifest = parseJsonc(readFileSync(manifestPath, 'utf8'));
      const cleanManifest = sanitizeNativePluginManifest(rawManifest);
      delete cleanManifest.disabled;
      effectivePluginName = cleanManifest.name;
      writeFileSync(manifestPath, `${JSON.stringify(cleanManifest, null, 2)}\n`, 'utf8');
    }

    if ((!existing || effectivePluginName !== existing.name) &&
        ((samePluginName(effectivePluginName, PLUGIN_ID) && plugin.id !== SELF_CATALOG_ID) || inventory.installed.some(loc =>
          !(existing && loc.scope === existing.scope && loc.path === existing.path) &&
          (samePluginName(loc.name, effectivePluginName) || samePluginName(loc.dir, effectivePluginName))))) {
      throw new Error(`ERR_UPDATE_TARGET_MISMATCH: Plugin name "${effectivePluginName}" is already in use.`);
    }
    const targetDir = assertSafePluginDir(preflight.targetDir);
    const staged = scanLocalPluginComponents(stagingBundleDir, targetDir, effectivePluginName, null);
    const capabilities = mergeCapabilityProfiles(plugin.capabilities, staged.capabilities);
    const verifiedPlugin = { ...plugin, capabilities };
    const escalation = getUpdateEscalation(verifiedPlugin, preflight, dlInfo.sha256);
    if (confirmEscalation && approvalKey && !escalation.escalated) {
      throw new Error('ERR_UPDATE_APPROVAL_CHANGED: The update changed after the capability confirmation. Refresh and retry.');
    }
    if ((preflight.action === 'update' || approvalKey) && escalation.escalated &&
        (!confirmEscalation || approvalKey !== escalation.approvalKey)) {
      safeRemoveDirBestEffort(stagingRootDir);
      return {
        ok: false,
        status: 'CAPABILITY_ESCALATION_CONFIRM_REQUIRED',
        installedVersion: existing?.version || existing?.receipt?.installedVersion,
        targetVersion: plugin.version,
        escalation,
      };
    }
    if (samePluginName(targetDir, PLUGIN_ID) && plugin.id !== SELF_CATALOG_ID) {
      throw new Error('ERR_UPDATE_TARGET_MISMATCH: The marketplace directory is reserved.');
    }
    const targetRootDir = isUpdatingParked ? disabledDir : pluginsDir;
    const targetPluginDir = join(targetRootDir, targetDir);
    // Recheck after downloading, including directories without a readable manifest and parked copies.
    const candidateTargets = [targetPluginDir];
    if (inventory.disabledPluginsDir) candidateTargets.push(join(inventory.disabledPluginsDir, targetDir));
    if (!existing && candidateTargets.some(path =>
      lstatSync(path, { throwIfNoEntry: false }))) {
      if (preflight.action !== 'install-scoped') throw new Error(`ERR_TARGET_DIR_EXISTS: Directory "${targetDir}" is occupied.`);
      throw new Error(`ERR_SCOPED_TARGET_OCCUPIED: 隔离目录 "${targetDir}" 已存在，请核对已安装的副本。`);
    }
    targetPluginDirForErr = targetPluginDir;
    const preservePaths = [
      ...new Set([
        ...(Array.isArray(existingReceipt?.preservePaths) ? existingReceipt.preservePaths : []),
        ...(Array.isArray(plugin.distribution?.preservePaths) ? plugin.distribution.preservePaths : []),
      ]),
    ];
    const previousManagedFiles = Array.isArray(existingReceipt?.managedFiles) ? existingReceipt.managedFiles : existing ? null : [];

    // Snapshot lightweight lock-safe rollback backup if updating/replacing an existing directory
    installStage = 'backup';
    const incomingManagedFiles = listAllRelFiles(stagingBundleDir, { tolerateLockErrors: false })
      .filter((rel) => rel !== '.agy-market-receipt.json')
      .sort();

    if (preflight.action === 'replace-local' && !existing.isSymlink) {
      const hostEntry = /^(?:mcp_config\.json|hooks\.json|hooks\/hooks\.json|sidecars\.json|sidecars\/[^/]+\/sidecar\.json|skills\/[^/]+\/SKILL\.md|(?:agents|rules)\/[^/]+\.md)$/i;
      const linkedComponent = /^(?:skills|agents|rules|hooks|sidecars)(?:\/[^/]+)?$/i;
      const preserve = createPreserveMatcher(preservePaths, targetPluginDir);
      const links = new Set();
      const existingFiles = listAllRelFiles(targetPluginDir, { deferredLinks: links });
      const managed = new Set(previousManagedFiles || []);
      const incoming = new Set(incomingManagedFiles);
      const leftover = existingFiles.find(rel => hostEntry.test(rel) &&
        (preserve(rel) || (!incoming.has(rel) && !managed.has(rel)))) ||
        [...links].find(rel => (hostEntry.test(rel) || linkedComponent.test(rel)) && (!managed.has(rel) || preserve(rel)));
      if (leftover) {
        throw new Error(`ERR_PLUGIN_LAYOUT_CONFLICT: 替换后会保留原插件的宿主组件 "${leftover}"。请选择隔离安装，或先备份并移走该组件。 Choose isolated install or move this local component before replacing the plugin.`);
      }
    }

    const backupFiles = snapshotBackupSafe(targetPluginDir, backupDir, {
      previousManagedFiles, incomingFiles: incomingManagedFiles, preservePaths,
    });

    const receipt = buildInstallReceipt({
      plugin: verifiedPlugin,
      track,
      installedDir: targetDir,
      effectivePluginName,
      scopedRewriteApplied: preflight.applyScopedRewrite,
      previousInstalledAt: existingReceipt?.installedAt || null,
      actualSha256: dlInfo.sha256,
      preservePaths,
      managedFiles: incomingManagedFiles,
    });

    // Write crash-recovery journal BEFORE touching target plugin directory
    const journal = {
      op: preflight.action,
      dir: targetDir,
      targetIdentity: readJournalTargetIdentity(targetPluginDir, stagingBundleDir),
      pluginsDir: resolve(pluginsDir),
      parkedByMarket: isUpdatingParked,
      fromVersion: preflight.existingInstall?.version || null,
      toVersion: plugin.version,
      stagingRootDir,
      stagingBundleDir,
      backupDir: existsSync(backupDir) ? backupDir : null,
      backupFiles,
      trackAdditions: !existing || Array.isArray(backupFiles),
      snapshotIntegrity: {
        staging: snapshotDigest(stagingBundleDir),
        backup: backupFiles ? snapshotDigest(backupDir, backupFiles) : null,
      },
      preservePaths,
      previousManagedFiles,
      receipt,
      startedAt: new Date().toISOString(),
    };
    // Preflight only permits a changed catalog ID for the same Track 2 repository ID and plugin root.
    if (preflight.action === 'update' && existingReceipt?.id && existingReceipt.id !== receipt.id) {
      journal.favoriteTransfer = { id: existingReceipt.id, repositoryUrl: normalizeRepoUrl(existingReceipt.repositoryUrl) };
    }

    installStage = 'sync';
    const syncStats = syncDirectoryLockSafe({
      stagingBundleDir,
      targetPluginDir,
      dataDir,
      preservePaths,
      previousManagedFiles,
      writeOverride,
      reserveNewFiles: !existing,
      onFileWritten: trackRollbackAdditions(journal),
      beforeWrite() {
        writePendingJournal(dataDir, journal);
        journalPending = true;
      },
      onRootCreated() { bindPendingJournalRoot(dataDir, journal, targetPluginDir); },
    });

    const verifiedManagedFiles = Array.isArray(syncStats.managedFiles)
      ? [...new Set(syncStats.managedFiles.filter((rel) => rel !== '.agy-market-receipt.json'))].sort()
      : incomingManagedFiles;
    if (JSON.stringify(verifiedManagedFiles) !== JSON.stringify(receipt.managedFiles || [])) {
      receipt.managedFiles = verifiedManagedFiles;
    }

    commitJournalReceipt(dataDir, targetPluginDir, journal);

    // Clear journal & temporary staging artifacts (best-effort so brief Windows Defender locks never fail a finished update)
    clearPendingJournal(dataDir);
    journalPending = false;
    safeRemoveDirBestEffort(stagingRootDir);
    safeRemoveDirBestEffort(backupDir);

    releaseMutation();
    releaseMutation = null;

    // Check if an already-enabled MCP plugin needs server reload (skip if parked/disabled)
    const enabledByDir = readHostEnabledMapReadOnly(configDir);
    const isEnabled = !isUpdatingParked && enabledByDir.get(targetDir) !== false;
    const mcpServers = capabilities.mcpServers;
    let reloadRequired = false;
    let mcpRefreshed = false;

    if (preflight.action === 'update' && isEnabled && mcpServers.length > 0) {
      const refreshRes = await tryOpportunisticMcpRefresh(effectivePluginName, mcpServers, activeFetch);
      mcpRefreshed = Boolean(refreshRes.refreshed);
      reloadRequired = !mcpRefreshed;
    }

    // Re-scan single installed plugin for accurate Sidecar pill URI & local capabilities
    const postInventory = scanLocalPluginInventory({ configDir, pluginsDir, dataDir });
    const installedRecord = postInventory.installed.find((x) => x.dir === targetDir) || null;
    const mergedCaps = mergeCapabilityProfiles(installedRecord?.capabilities, capabilities);
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
      isSelfUpdate: samePluginName(targetDir, PLUGIN_ID),
      installedDir: targetDir,
      effectivePluginName,
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
    // Recovery needs the staged bundle when syncing or persisting the receipt failed.
    if (!journalPending) {
      safeRemoveDirBestEffort(stagingRootDir);
      safeRemoveDirBestEffort(backupDir);
    }
    const relPath =
      targetPluginDirForErr && err?.path ? relative(targetPluginDirForErr, String(err.path)) : '';
    throw annotateLockError(err, installStage, relPath);
  } finally {
    releaseMutation?.();
  }
}

function removeMarketPluginFilesInternal(options) {
  const dataDir = options.dataDir || resolveMarketDataDir();
  const release = acquirePluginMutation(dataDir);
  try {
    return removePluginUnderLock({ ...options, dataDir });
  } finally {
    release();
  }
}

function removePluginUnderLock({
  dir,
  configDir = resolveAntigravityConfigDir(),
  pluginsDir: explicitPluginsDir = '',
  dataDir = resolveMarketDataDir(),
  workspaceUris = [],
  builtinPluginsDir = '',
  catalogCapabilities = null,
  expectedInstall = null,
  removeFavorite = false,
  catalogPlugins = [],
  nowMs = Date.now(),
  rmOverride = null,
  unlinkOverride = null,
  renameOverride = null,
  linkInfoOverride = null,
  unlinkLinkOverride = null,
}) {
  const safeDir = assertSafePluginDir(dir);
  if (samePluginName(safeDir, PLUGIN_ID)) {
    throw new Error('ERR_CANNOT_SELF_DELETE: Manage agy-market itself via customization://agy-market');
  }
  const pluginsDir = explicitPluginsDir ? resolve(explicitPluginsDir) : resolvePluginsDir(configDir);
  const disabledDir = resolveDisabledPluginsDir(dataDir);
  // A --dest override selects an active directory. Only the configured host
  // plugin root owns the shared disabled vault and the host's favorite records.
  const hostPluginsDir = resolvePluginsDir(configDir);
  const isHostRoot = isHostPluginsDir(pluginsDir, configDir);
  const activeTarget = resolve(pluginsDir, safeDir);
  const parkedTarget = resolve(disabledDir, safeDir);

  const activeLinkInfo =
    typeof linkInfoOverride === 'function'
      ? linkInfoOverride(pluginsDir, safeDir) || isDirectorySymlinkOrJunction(pluginsDir, safeDir)
      : isDirectorySymlinkOrJunction(pluginsDir, safeDir);
  const parkedLinkInfo = !isHostRoot ? null :
    typeof linkInfoOverride === 'function'
      ? linkInfoOverride(disabledDir, safeDir) || isDirectorySymlinkOrJunction(disabledDir, safeDir)
      : isDirectorySymlinkOrJunction(disabledDir, safeDir);

  const hasActive = Boolean(activeLinkInfo?.lstat) || existsSync(activeTarget);
  const hasParked = isHostRoot && (Boolean(parkedLinkInfo?.lstat) || existsSync(parkedTarget));

  if (!hasActive && !hasParked) {
    if (expectedInstall?.key) throw new Error('ERR_UNINSTALL_TARGET_CHANGED: The selected installation has changed.');
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
    const pending = readPendingPluginUpdate(dataDir, isHostRoot ? [activeTarget, parkedTarget] : [activeTarget], hostPluginsDir);
    if (pending) discardPendingPluginUpdate(dataDir, pending);
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
  // Inventory presents the active manifest first. A parked copy under the same name
  // becomes visible after removing the active one and can be managed separately.
  const activeManifest = hasActive && existsSync(join(activeTarget, 'plugin.json'));
  const parkedManifest = hasParked && existsSync(join(parkedTarget, 'plugin.json'));
  const snapshotDir = activeManifest || (hasActive && !parkedManifest) ? activeTarget : parkedTarget;
  const removeParked = snapshotDir === parkedTarget;
  const removeActive = snapshotDir === activeTarget ||
    (removeParked && lstatSync(activeTarget, { throwIfNoEntry: false })?.isDirectory() && isRetiredPluginRemnant(activeTarget, dataDir));
  const targets = [removeActive && activeTarget, removeParked && parkedTarget].filter(Boolean);
  const pending = readPendingPluginUpdate(dataDir, targets, resolvePluginsDir(configDir));

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

  if (expectedInstall && (expectedInstall.parked !== removeParked || !existsSync(snapshotManifestPath) ||
      (Object.hasOwn(expectedInstall, 'key') &&
        expectedInstall.key !== localUninstallKey(snapshotDir, manifest || { name: safeDir }, receipt)) ||
      expectedInstall.name !== String(manifest?.name || safeDir) || expectedInstall.id !== (receipt?.id || '') ||
      (Object.hasOwn(expectedInstall, 'repositoryUrl') &&
        expectedInstall.repositoryUrl !== resolveLocalPluginSource(snapshotDir, manifest || {}, receipt).repositoryUrl))) {
    throw new Error('ERR_UNINSTALL_TARGET_CHANGED: The selected installation has changed.');
  }
  if (!activeManifest && !parkedManifest && !receipt && !pending && existsSync(snapshotDir) &&
      !(removeParked ? parkedLinkInfo : activeLinkInfo)?.isSymlink && !isRetiredPluginRemnant(snapshotDir, dataDir)) {
    throw new Error('ERR_UNINSTALL_TARGET_CHANGED: Cannot identify the files at the selected path.');
  }

  let components = null;
  try {
    if (existsSync(snapshotDir)) {
      components = scanLocalPluginComponents(snapshotDir, safeDir, String(manifest?.name || safeDir), receipt);
    }
  } catch {
    components = null;
  }

  const installed = isHostRoot
    ? scanLocalPluginInventory({ configDir, pluginsDir, dataDir, workspaceUris, builtinPluginsDir,
        linkInfoOverride, catalogPlugins, bypassCache: true }).installed
    : [];
  const selectedLocal = installed.find(loc => loc.scope === 'global' && loc.dir === safeDir);
  const repository = normalizeRepoUrl(receipt?.repositoryUrl || (!selectedLocal?.inferredRepository && selectedLocal?.repositoryUrl));
  const matchedCatalog = findCatalogEntryForLocal(selectedLocal, catalogPlugins, installed);
  const root = receipt?.pluginRoot || selectedLocal?.repositoryRoot ||
    (matchedCatalog && normalizePluginRoot(matchedCatalog.repository?.pluginRoot));
  const mergedCaps = mergeCapabilityProfiles(components?.capabilities, matchedCatalog?.capabilities || catalogCapabilities);
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

  function matchesFavorite(key, sources) {
    if (!selectedLocal) return false;
    if (key === selectedLocal.favoriteKey) return true;
    const pinned = sources[key];
    if (pinned?.catalogOrigin && (!repository || createHash('sha256').update(repository).digest('hex') !== pinned.catalogOrigin)) return false;
    if (pinned?.repositoryUrl && normalizeRepoUrl(pinned.repositoryUrl) !== repository) return false;
    if (pinned?.pluginRoot && (!root || normalizePluginRoot(root) !== pinned.pluginRoot)) return false;
    if (matchLegacyLocalFavorite(key, installed, pinned) === selectedLocal) return true;
    if (key === matchedCatalog?.id) return true;
    if (key !== safeDir && key !== receipt?.id) return false;
    return !catalogPlugins.some(entry => entry.id === key) &&
      !installed.some(loc => loc !== selectedLocal && (loc.dir === key || loc.receipt?.id === key));
  }
  if (!removeFavorite && selectedLocal) {
    // Preserve the source before deleting its last on-disk manifest and receipt.
    const source = makeFavoriteSource(manifest?.displayName || manifest?.name || safeDir,
      parseGithubRepoSlug(repository)?.url, root,
      receipt?.githubSource?.trackBranch);
    updatePrefsOnDisk(dataDir, current => {
      const favoriteSources = { ...current.favoriteSources };
      const savedKeys = current.favorites.filter(key => matchesFavorite(key, current.favoriteSources));
      if (!savedKeys.length) return null;
      for (const key of savedKeys) {
        const pinned = favoriteSources[key];
        if (!pinned?.repositoryUrl && !pinned?.catalogOrigin) favoriteSources[key] = source;
        else if (source.repositoryUrl && normalizeRepoUrl(pinned.repositoryUrl) === repository) {
          favoriteSources[key] = { ...pinned, pluginRoot: pinned.pluginRoot || source.pluginRoot,
            trackBranch: pinned.trackBranch || source.trackBranch };
        }
      }
      return { favoriteSources };
    });
  }

  const parkedRes = removeParked ? removeOneTarget(parkedTarget, parkedLinkInfo) : null;
  const activeRes = removeActive ? removeOneTarget(activeTarget, activeLinkInfo) : null;

  const retiredBinaries = [...new Set([...(parkedRes?.retired || []), ...(activeRes?.retired || [])])];
  const locked = Boolean(parkedRes?.locked || activeRes?.locked);
  const lastError = activeRes?.error || parkedRes?.error || null;
  const manifestStillPresent =
    targets.some(target => existsSync(join(target, 'plugin.json')));
  const removed =
    !manifestStillPresent &&
    Boolean((parkedRes ? parkedRes.removed : true) && (activeRes ? activeRes.removed : true));

  // Post-removal hygiene: purge stale GitHub cache files for this repoSlug & optional favorite cleanup
  if (removed) {
    if (pending) discardPendingPluginUpdate(dataDir, pending);
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

    if (removeFavorite && selectedLocal) {
      try {
        updatePrefsOnDisk(dataDir, current => {
          const favorites = current.favorites.filter(key => !matchesFavorite(key, current.favoriteSources));
          return favorites.length === current.favorites.length ? null : { favorites };
        });
      } catch {
        /* File removal already succeeded; favorite cleanup remains best effort. */
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
    mcpServers: isHostRoot ? mcpServers : [],
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
