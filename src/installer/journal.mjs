// Crash-Recovery Journal (`pending-journal.json`) for 8s Boot Recovery (`src/installer/journal.mjs`).

import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, closeSync, copyFileSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { assertSafePluginDir, resolveDisabledPluginsDir } from '../shared/paths.mjs';
import { acquireTicketLock } from '../shared/fs-lock.mjs';
import { normalizeRepoUrl } from '../preflight/index.mjs';
import { parseJsonc, updatePrefsOnDisk } from '../shared/schemas.mjs';
import { listAllRelFiles, regularFileStamp, safeRemoveDirBestEffort, sweepRetiredBinaries, syncDirectoryLockSafe } from './sync-dir.mjs';

export function acquirePluginMutation(dataDir) {
  return acquireTicketLock(join(resolve(dataDir), 'mutation-locks'), 'ERR_PLUGIN_OPERATION_BUSY', 'Another plugin operation is active');
}

export function trySweepRetiredBinaries(dataDir, options) {
  let release;
  try {
    release = acquirePluginMutation(dataDir);
    // An empty target can be the new, identity-bound root of an interrupted install.
    if (existsSync(getJournalPath(dataDir))) return { deferred: 'pending-recovery' };
    return sweepRetiredBinaries(dataDir, options);
  } catch (err) {
    if (err.code === 'ERR_PLUGIN_OPERATION_BUSY') return { deferred: 'busy' };
    throw err;
  } finally { release?.(); }
}

function journalTarget(journal, dataDir, pluginsDir) {
  if (journal.pluginsDir !== undefined && (typeof journal.pluginsDir !== 'string' || !isAbsolute(journal.pluginsDir))) {
    throw new Error('Invalid plugin root in pending journal');
  }
  if (typeof journal.dir !== 'string' || journal.dir !== journal.dir.trim()) {
    throw new Error('Invalid plugin directory in pending journal');
  }
  assertSafePluginDir(journal.dir);
  return resolve(journal.parkedByMarket ? resolveDisabledPluginsDir(dataDir) : journal.pluginsDir || pluginsDir, journal.dir);
}

// Read under the mutation lock. Older journals used the host's default plugin root.
export function readPendingPluginUpdate(dataDir, targetPaths, legacyPluginsDir) {
  const path = getJournalPath(dataDir);
  if (!existsSync(path)) return null;
  const journal = JSON.parse(readFileSync(path, 'utf8'));
  const target = journalTarget(journal, dataDir, legacyPluginsDir);
  return targetPaths.some(p => relative(p, target) === '') ? journal : null;
}

export function cancelPendingPluginUpdate(dataDir, pluginsDir, dir, legacyPluginsDir) {
  const journal = readPendingPluginUpdate(dataDir, [
    resolve(pluginsDir, dir), resolve(resolveDisabledPluginsDir(dataDir), dir),
  ], legacyPluginsDir);
  if (journal) discardPendingPluginUpdate(dataDir, journal);
}

export function discardPendingPluginUpdate(dataDir, journal) {
  clearPendingJournal(dataDir);
  for (const path of [journal.stagingRootDir, journal.backupDir]) {
    if (!path) continue;
    const rel = relative(resolve(dataDir, 'staging'), resolve(path));
    if (rel && !rel.startsWith('..') && !isAbsolute(rel)) safeRemoveDirBestEffort(path);
  }
}

export function getJournalPath(dataDir) {
  return join(dataDir, 'pending-journal.json');
}

export function writePendingJournal(dataDir, record) {
  mkdirSync(dataDir, { recursive: true });
  try {
    writeFileSync(getJournalPath(dataDir), `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx', flush: true });
  } catch (err) {
    if (err.code === 'EEXIST') throw new Error('ERR_PENDING_RECOVERY: A previous installation needs recovery', { cause: err });
    throw err;
  }
}

export function clearPendingJournal(dataDir) {
  rmSync(getJournalPath(dataDir), { force: true });
}

const MANIFEST = 'plugin.json';
const RECEIPT = '.agy-market-receipt.json';

export function writeInstallReceipt(target, receipt) {
  const path = join(target, RECEIPT);
  const temp = path + '.' + randomUUID() + '.tmp';
  try {
    writeFileSync(temp, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx', flush: true });
    renameSync(temp, path);
  } finally { rmSync(temp, { force: true }); }
}

// Replayable after an interruption between the receipt write and the preferences write.
export function commitJournalReceipt(dataDir, target, { receipt, favoriteTransfer }) {
  writeInstallReceipt(target, receipt);
  if (!favoriteTransfer?.repositoryUrl) return;
  updatePrefsOnDisk(dataDir, current => {
    const favoriteSources = { ...current.favoriteSources };
    let changed = false;
    for (const key of current.favorites) {
      const pinned = favoriteSources[key];
      if ((pinned?.catalogId || key) !== favoriteTransfer.id || !pinned?.repositoryUrl ||
          normalizeRepoUrl(pinned.repositoryUrl) !== favoriteTransfer.repositoryUrl || pinned.pluginRoot !== receipt.pluginRoot) continue;
      favoriteSources[key] = { ...pinned, catalogId: receipt.id, repositoryUrl: normalizeRepoUrl(receipt.repositoryUrl) };
      changed = true;
    }
    return changed ? { favoriteSources } : null;
  });
}

function rootIdentity(path) {
  const st = lstatSync(path, { bigint: true, throwIfNoEntry: false });
  return st ? `${st.dev}:${st.ino}` : null;
}

function metadataFile(dir, name) {
  if (!dir) return null;
  const path = join(dir, name);
  const st = lstatSync(path, { throwIfNoEntry: false });
  if (!st) return null;
  if (!st.isFile()) throw new Error(`ERR_PLUGIN_LAYOUT_CONFLICT: Expected regular metadata file "${name}".`);
  return readFileSync(path);
}

function fingerprint(bytes) {
  return bytes && createHash('sha256').update(bytes).digest('hex');
}

// Include paths, executable permissions and bytes of the final tree (after
// manifest rewriting). File-size framing keeps the digest independent of reads.
export function snapshotDigest(root, paths = listAllRelFiles(root)) {
  const hash = createHash('sha256');
  const chunk = Buffer.allocUnsafe(64 * 1024);
  for (const rel of [...paths].sort()) {
    const fd = openSync(join(root, rel), 'r');
    try {
      const stat = fstatSync(fd);
      hash.update(JSON.stringify([rel, stat.mode & 0o111, stat.size]) + '\n');
      let count;
      while ((count = readSync(fd, chunk, 0, chunk.length)) > 0) hash.update(chunk.subarray(0, count));
    } finally {
      closeSync(fd);
    }
  }
  return hash.digest('hex');
}

export function readJournalTargetIdentity(target, stagedBundle) {
  return {
    root: rootIdentity(target),
    replacingLink: lstatSync(target, { throwIfNoEntry: false })?.isSymbolicLink() || false,
    manifest: fingerprint(metadataFile(target, MANIFEST)),
    receipt: fingerprint(metadataFile(target, RECEIPT)),
    stagedManifest: fingerprint(metadataFile(stagedBundle, MANIFEST)),
  };
}

// A planned addition might still be absent when sync is interrupted. Only a
// completed write to a previously absent path can be owned by this rollback.
export function trackRollbackAdditions(journal) {
  if (!journal.trackAdditions) return null;
  const prior = new Set(journal.backupFiles || []);
  const path = join(journal.stagingRootDir, 'rollback-additions.jsonl');
  return (rel, livePath, reserved = false) => {
    if (prior.has(rel)) return;
    const stamp = regularFileStamp(livePath);
    if (stamp) appendFileSync(path, JSON.stringify([rel, reserved ? stamp.split(':').slice(0, 3).join(':') : stamp]) + '\n');
  };
}

function readTrackedAdditions(journal) {
  const path = join(journal.stagingRootDir, 'rollback-additions.jsonl');
  const records = existsSync(path) ? readFileSync(path, 'utf8').split('\n') : [];
  // A partially appended final line is not proof of ownership.
  records.pop();
  return new Map(records.filter(Boolean).map(line => JSON.parse(line)));
}

function rollbackOwnership(journal, target, backupFiles) {
  const incoming = new Set(journal.receipt?.managedFiles || []);
  const owned = new Set(journal.previousManagedFiles || []);
  for (const rel of backupFiles) if (incoming.has(rel)) owned.add(rel);
  if (journal.trackAdditions) {
    const stamps = readTrackedAdditions(journal);
    const liveFiles = listAllRelFiles(target, { deferredLinks: new Set(), tolerateLockErrors: true });
    for (const rel of liveFiles) {
      if (incoming.has(rel) && stamps.has(rel) && regularFileStamp(join(target, rel)) === stamps.get(rel)) owned.add(rel);
    }
  }
  return owned;
}

// Bind the newly created real directory before writing any payload. Publish the
// revised record atomically so a crash retains either the empty or bound state.
export function bindPendingJournalRoot(dataDir, journal, target) {
  const path = getJournalPath(dataDir);
  const tmp = path + '.' + randomUUID() + '.tmp';
  journal.targetIdentity.root = rootIdentity(target);
  journal.targetIdentity.replacingLink = false;
  try {
    writeFileSync(tmp, JSON.stringify(journal), { flag: 'wx', flush: true });
    renameSync(tmp, path);
  } finally { rmSync(tmp, { force: true }); }
}

function verifyRecoveryTarget(dataDir, journal, target, stagedBundleDir) {
  function changed() {
    throw Object.assign(new Error(`ERR_RECOVERY_TARGET_CHANGED: The installation at "${target}" changed after the journal was written.`),
      { code: 'ERR_RECOVERY_TARGET_CHANGED' });
  }
  const currentRoot = rootIdentity(target);
  const before = journal.targetIdentity;
  if (before && before.root !== currentRoot) {
    // A crash can fall between mkdir and recording its identity, before any payload.
    if (before.root !== null && !before.replacingLink) changed();
    if (currentRoot && (!lstatSync(target).isDirectory() || readdirSync(target).length)) changed();
    if (currentRoot) bindPendingJournalRoot(dataDir, journal, target);
  }
  if (!currentRoot) {
    if (!before && (journal.fromVersion || journal.backupDir)) changed();
    return;
  }

  const nextReceipt = journal.receipt && Buffer.from(JSON.stringify(journal.receipt, null, 2) + '\n');
  const currentManifest = metadataFile(target, MANIFEST);
  const currentReceipt = metadataFile(target, RECEIPT);
  const stagedManifest = metadataFile(stagedBundleDir, MANIFEST);
  if (before) {
    for (const [live, oldDigest, newDigest, incoming] of [
      [currentManifest, before.manifest, before.stagedManifest,
        fingerprint(stagedManifest) === before.stagedManifest ? stagedManifest : null],
      [currentReceipt, before.receipt, fingerprint(nextReceipt), nextReceipt],
    ]) {
      // An interrupted copy can leave a missing file or an exact prefix of the new bytes.
      if (!live) continue;
      const digest = fingerprint(live);
      if (digest !== oldDigest && digest !== newDigest && !incoming?.subarray(0, live.length).equals(live)) changed();
    }
    return;
  }

  // Older journals have no directory identity. Require surviving metadata to
  // identify either the backed-up installation or the staged one before replay.
  if (!currentManifest && !currentReceipt && readdirSync(target).length) changed();
  if (currentManifest) {
    const manifest = parseJsonc(currentManifest.toString('utf8'));
    const candidates = [metadataFile(journal.backupDir, MANIFEST), stagedManifest].filter(Boolean);
    if (!candidates.some(bytes => {
      const expected = parseJsonc(bytes.toString('utf8'));
      return manifest.name === expected.name && manifest.version === expected.version &&
        JSON.stringify(manifest.repository) === JSON.stringify(expected.repository);
    })) changed();
  }
  if (currentReceipt) {
    const receipt = JSON.parse(currentReceipt);
    const backup = metadataFile(journal.backupDir, RECEIPT);
    const candidates = [journal.receipt, backup && JSON.parse(backup)];
    const sameSource = candidates.some(rec => rec?.id && rec.id === receipt.id &&
      (!rec.repositoryId || !receipt.repositoryId || Number(rec.repositoryId) === Number(receipt.repositoryId)) &&
      (!rec.pluginRoot || !receipt.pluginRoot || rec.pluginRoot === receipt.pluginRoot));
    if (!sameSource) changed();
  }
}

/**
 * Invoked 8s after Sidecar boot to complete or roll back any install/update interrupted by power loss or IDE exit.
 */
export function recoverInterruptedJournal({ dataDir, pluginsDir, syncDataDir = dataDir, replacementBundle = null }) {
  const journalPath = getJournalPath(dataDir);
  if (!existsSync(journalPath)) {
    return { recovered: false, action: 'none' };
  }

  let release;
  try {
    release = acquirePluginMutation(dataDir);
    return recoverUnderLock(dataDir, pluginsDir, journalPath, syncDataDir, replacementBundle);
  } catch (err) {
    if (err.code === 'ERR_PLUGIN_OPERATION_BUSY') return { recovered: false, action: 'busy' };
    return { recovered: false, action: 'error', error: err.message };
  } finally {
    release?.();
  }
}

function recoverUnderLock(dataDir, pluginsDir, journalPath, syncDataDir, replacementBundle) {
  if (!existsSync(journalPath)) return { recovered: false, action: 'none' };
  let journal;
  try {
    journal = JSON.parse(readFileSync(journalPath, 'utf8'));
  } catch {
    clearPendingJournal(dataDir);
    return { recovered: false, action: 'corrupt-cleared' };
  }

  const targetPluginDir = journalTarget(journal, dataDir, pluginsDir);
  try {
    // A new bootstrap invocation may supply fresh bytes of the interrupted
    // release. Verify their full digest below before using them for any write.
    const bundle = replacementBundle?.path && typeof replacementBundle.digest === 'string' &&
      replacementBundle.digest === journal.snapshotIntegrity?.staging
      ? replacementBundle.path : journal.stagingBundleDir;
    verifyRecoveryTarget(dataDir, journal, targetPluginDir, bundle);
    const stagedFiles = new Set(bundle ? listAllRelFiles(bundle) : []);
    const managed = journal.receipt?.managedFiles;
    // Journals written before snapshot digests retain their original inventory
    // checks. A new journal must verify the entire snapshot before replay.
    const verified = (dir, files, role) => !Object.hasOwn(journal, 'snapshotIntegrity') ||
      snapshotDigest(dir, files) === journal.snapshotIntegrity?.[role];
    const previousStagedDigest = journal.targetIdentity?.stagedManifest;
    const complete = stagedFiles.has('plugin.json') &&
      (!Array.isArray(managed) || managed.every(rel => stagedFiles.has(rel))) &&
      (!previousStagedDigest || fingerprint(metadataFile(bundle, MANIFEST)) === previousStagedDigest) &&
      verified(bundle, stagedFiles, 'staging');
    if (complete) {
      const firstInstall = journal.op === 'install-native' || journal.op === 'install-scoped';
      const trackedFirstInstall = firstInstall && journal.trackAdditions;
      const legacyFirstInstall = firstInstall && !journal.trackAdditions && !journal.fromVersion && !journal.backupDir;
      const legacyReceipt = legacyFirstInstall && journal.receipt ? Buffer.from(JSON.stringify(journal.receipt, null, 2) + '\n') : null;
      const liveReceipt = legacyReceipt && metadataFile(targetPluginDir, RECEIPT);
      if (liveReceipt && !liveReceipt.equals(legacyReceipt)) {
        throw new Error(`ERR_PLUGIN_LAYOUT_CONFLICT: Cannot overwrite local file "${RECEIPT}"`);
      }
      syncDirectoryLockSafe({
        stagingBundleDir: bundle,
        targetPluginDir,
        dataDir: syncDataDir,
        preservePaths: journal.preservePaths || [],
        previousManagedFiles: journal.previousManagedFiles ?? (firstInstall ? [] : null),
        recovering: true,
        recoveryStamps: trackedFirstInstall ? readTrackedAdditions(journal) : null,
        reuseIdenticalFiles: legacyFirstInstall,
        includeSourceFile: legacyReceipt ? rel => rel !== RECEIPT : null,
        reserveNewFiles: trackedFirstInstall,
        onFileWritten: trackRollbackAdditions(journal),
        onRootCreated: journal.targetIdentity ? () => bindPendingJournalRoot(dataDir, journal, targetPluginDir) : null,
      });
      if (legacyReceipt) {
        if (!liveReceipt) writeFileSync(join(targetPluginDir, RECEIPT), legacyReceipt, { flag: 'wx', flush: true });
      } else if (journal.receipt) commitJournalReceipt(dataDir, targetPluginDir, journal);
      clearPendingJournal(dataDir);
      if (journal.stagingRootDir) {
        safeRemoveDirBestEffort(journal.stagingRootDir);
      }
      if (journal.backupDir) {
        safeRemoveDirBestEffort(journal.backupDir);
      }
      return { recovered: true, action: 'completed-forward', dir: journal.dir };
    }

    if (journal.backupDir || journal.fromVersion) {
      const actualFiles = new Set(journal.backupDir ? listAllRelFiles(journal.backupDir) : []);
      const expectedFiles = journal.backupFiles === undefined ? journal.previousManagedFiles || [] : journal.backupFiles;
      if (!actualFiles.has('plugin.json') || !Array.isArray(expectedFiles) || expectedFiles.some(rel => !actualFiles.has(rel)) ||
          !verified(journal.backupDir, actualFiles, 'backup')) {
        throw new Error('ERR_INCOMPLETE_BACKUP: Cannot restore every file in the previous plugin snapshot.');
      }
      const owned = rollbackOwnership(journal, targetPluginDir, actualFiles);
      syncDirectoryLockSafe({
        stagingBundleDir: journal.backupDir,
        targetPluginDir,
        dataDir: syncDataDir,
        preservePaths: journal.preservePaths || [],
        previousManagedFiles: [...owned],
        // A backup may include user data the update never touched.
        includeSourceFile: journal.trackAdditions ? rel => owned.has(rel) || rel === MANIFEST || rel === RECEIPT : null,
        recovering: true,
      });
      const oldReceipt = join(journal.backupDir, '.agy-market-receipt.json');
      const liveReceipt = join(targetPluginDir, '.agy-market-receipt.json');
      if (existsSync(oldReceipt)) copyFileSync(oldReceipt, liveReceipt);
      else rmSync(liveReceipt, { force: true });
      clearPendingJournal(dataDir);
      safeRemoveDirBestEffort(journal.backupDir);
      if (journal.stagingRootDir) safeRemoveDirBestEffort(journal.stagingRootDir);
      return { recovered: true, action: 'rolled-back', dir: journal.dir };
    }
    if (Array.isArray(managed)) {
      throw new Error('ERR_INCOMPLETE_STAGING: The staged package is incomplete and a rollback snapshot is unavailable.');
    }
  } catch (err) {
    if (err.code === 'ERR_RECOVERY_TARGET_CHANGED') {
      // Preserve the evidence and both snapshots without blocking unrelated installations.
      const archives = join(dataDir, 'recovery-conflicts');
      mkdirSync(archives, { recursive: true });
      const archivedJournal = join(archives, randomUUID() + '.json');
      renameSync(journalPath, archivedJournal);
      return { recovered: false, action: 'target-changed', error: err.message, journalPath: archivedJournal };
    }
    return { recovered: false, action: 'error', error: err?.message || String(err) };
  }

  clearPendingJournal(dataDir);
  return { recovered: false, action: 'stale-cleared' };
}
