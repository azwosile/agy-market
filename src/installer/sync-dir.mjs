// Windows File-Lock Safe In-Place Sync & Retired Binary Garbage Collector (`src/installer/sync-dir.mjs`).
//
// Why In-Place Sync:
//   Running MCP Stdio servers and Sidecars on Windows hold open handles on their CWD (`<dir>`)
//   and lock `.exe`/`.dll`/`.node` files. Deleting `<dir>` fails with `EBUSY`/`EPERM`.
//   Instead, we preserve `preservePaths` + `.agy-market-receipt.json`, sync files in-place,
//   rename locked binaries aside (`<file>.old.<timestamp>`), and sweep retired binaries on boot/install.

import { randomUUID } from 'node:crypto';
import {
  closeSync,
  constants as fsConstants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, posix, relative, resolve } from 'node:path';
import { PLUGIN_ID } from '../shared/constants.mjs';
import { withLockRetrySync } from '../shared/fs-lock.mjs';

export { withLockRetrySync };

const LOCK_ERROR_CODES = new Set(['EBUSY', 'EPERM', 'EACCES']);
const RETIRED_BINARY_RE = /\.old\.\d{10,}$/;
/**
 * Removes a symlink or NTFS junction without traversing into its target directory.
 */
export function removeSymlinkOrJunctionOnly(linkPath) {
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
 * Best-effort recursive directory removal that retries transient Windows locks and never throws.
 */
export function safeRemoveDirBestEffort(dirPath, { retries = 3, delayMs = 80 } = {}) {
  if (!dirPath) return false;
  try {
    if (existsSync(dirPath)) {
      const lst = lstatSync(dirPath);
      if (lst.isSymbolicLink()) {
        removeSymlinkOrJunctionOnly(dirPath);
        return true;
      }
    }
    rmSync(dirPath, {
      recursive: true,
      force: true,
      maxRetries: retries,
      retryDelay: delayMs,
    });
    return true;
  } catch {
    return false;
  }
}

function compilePreserveGlob(globPattern) {
  const norm = String(globPattern || '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\/+/, '');
  const wildcards = { '**/': '((?:.+/)?)', '**': '(.*)', '*': '([^/]*)', '?': '([^/])' };
  const parts = norm.split(/(\*\*\/|\*\*|\*|\?)/);
  const source = '^' + parts.map((part, i) => i % 2 ? wildcards[part] :
    part.replace(/[.+^${}()|[\]\\]/g, '\\$&')).join('') + '$';
  return { parts, exact: new RegExp(source), folded: new RegExp(source, 'i') };
}

export function createPreserveMatcher(preservePaths = [], rootDir = '') {
  const compiled = [
    compilePreserveGlob('.agy-market-receipt.json'),
    ...preservePaths
      .filter((p) => typeof p === 'string' && p.trim() && !p.includes('..'))
      .flatMap((p) => {
        const clean = p.trim().replace(/\\/g, '/').replace(/\/+$/, '');
        return [compilePreserveGlob(clean), compilePreserveGlob(`${clean}/**`)];
      }),
  ];
  return rel => compiled.some(({ parts, exact, folded }) => {
    if (exact.test(rel)) return true;
    const match = rootDir && folded.exec(rel);
    if (!match) return false;
    // Rebuild the literal spelling from the glob, retaining the matched
    // wildcard portions. Only the actual filesystem can resolve a case alias.
    const spelling = parts.map((part, i) => i % 2 ? match[(i + 1) / 2] : part).join('');
    const options = { bigint: true, throwIfNoEntry: false };
    const actual = lstatSync(join(rootDir, rel), options);
    const alias = lstatSync(join(rootDir, spelling), options);
    return Boolean(actual && alias && actual.ino === alias.ino && actual.dev === alias.dev);
  });
}

function readRetiredBinariesList(dataDir) {
  const listPath = join(dataDir, 'retired-binaries.json');
  if (!existsSync(listPath)) return [];
  try {
    const parsed = JSON.parse(readFileSync(listPath, 'utf8'));
    return Array.isArray(parsed) ? parsed.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function writeRetiredBinariesList(dataDir, pathsList, name = 'retired-binaries.json') {
  mkdirSync(dataDir, { recursive: true });
  const listPath = join(dataDir, name);
  const tempPath = listPath + '.' + randomUUID() + '.tmp';
  try {
    writeFileSync(tempPath, `${JSON.stringify([...new Set(pathsList)], null, 2)}\n`, 'utf8');
    withLockRetrySync(() => renameSync(tempPath, listPath));
  } finally {
    rmSync(tempPath, { force: true });
  }
}

// Both interrupted rollbacks and delayed Windows deletes must distinguish the
// original published file from a user's later replacement or edit at that path.
export function regularFileStamp(path) {
  const st = lstatSync(path, { bigint: true, throwIfNoEntry: false });
  return st?.isFile() ? [st.dev, st.ino, st.birthtimeNs, st.ctimeNs, st.mtimeNs, st.size].join(':') : null;
}

const LOCKED_REMOVALS = 'locked-removals.json';
export function hasLockedRemovals(dataDir) {
  return existsSync(join(dataDir, LOCKED_REMOVALS));
}

export function recordLockedRemoval(dataDir, root, path) {
  const stamp = regularFileStamp(path);
  if (!stamp) return;
  const dir = lstatSync(root, { bigint: true });
  const ledger = join(dataDir, LOCKED_REMOVALS);
  const records = existsSync(ledger) ? JSON.parse(readFileSync(ledger, 'utf8')) : [];
  const record = { root, path, stamp, rootId: `${dir.dev}:${dir.ino}` };
  writeRetiredBinariesList(dataDir, [...records.filter(item => item.path !== path), record], LOCKED_REMOVALS);
}

function sameRemovalRoot({ root, rootId, path }) {
  if (!isAbsolute(root) || !isStrictlyInsideDir(root, path)) return false;
  const dir = lstatSync(root, { bigint: true, throwIfNoEntry: false });
  if (!dir?.isDirectory() || `${dir.dev}:${dir.ino}` !== rootId) return false;
  for (let parent = dirname(resolve(path)); relative(root, parent); parent = dirname(parent)) {
    const st = lstatSync(parent, { throwIfNoEntry: false });
    if (st && !st.isDirectory()) return false;
  }
  return true;
}

/**
 * Appends retired `*.old.<ts>` binary paths to `${dataDir}/retired-binaries.json` for later GC.
 */
export function recordRetiredBinaries(dataDir, newPaths = []) {
  const additions = Array.isArray(newPaths) ? newPaths.filter((p) => typeof p === 'string' && p.trim()) : [];
  if (additions.length === 0) return readRetiredBinariesList(dataDir);
  const merged = [...new Set([...readRetiredBinariesList(dataDir), ...additions])];
  writeRetiredBinariesList(dataDir, merged);
  return merged;
}

function isStrictlyInsideDir(parentDir, childPath) {
  if (!parentDir || !childPath) return false;
  const rel = relative(parentDir, childPath);
  return Boolean(rel && !rel.startsWith('..') && !isAbsolute(rel));
}

function resolveRetiredCleanupBounds(absOldPath, { absPluginsDir = '', absDisabledDir = '' } = {}) {
  for (const containerDir of [absPluginsDir, absDisabledDir]) {
    if (containerDir && isStrictlyInsideDir(containerDir, absOldPath)) {
      const rel = relative(containerDir, absOldPath);
      const topDirName = rel.split(/[\\/]/)[0];
      if (topDirName) {
        return { containerDir, pluginRootDir: join(containerDir, topDirName), topDirName };
      }
    }
  }

  let cur = dirname(absOldPath);
  for (let depth = 0; depth < 8; depth++) {
    const base = basename(cur).toLowerCase();
    if (base === 'plugins' || base === 'disabled-plugins') {
      const rel = relative(cur, absOldPath);
      const topDirName = rel.split(/[\\/]/)[0];
      if (topDirName && !topDirName.startsWith('..')) {
        return { containerDir: cur, pluginRootDir: join(cur, topDirName), topDirName };
      }
      return null;
    }
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return null;
}

function pruneEmptyRetiredParentDirs(absOldPath, bounds) {
  if (!bounds || !bounds.topDirName || bounds.topDirName === PLUGIN_ID) return 0;
  if (existsSync(join(bounds.pluginRootDir, 'plugin.json'))) return 0;

  let removedDirs = 0;
  let cur = dirname(absOldPath);
  while (cur === bounds.pluginRootDir || isStrictlyInsideDir(bounds.pluginRootDir, cur)) {
    if (existsSync(join(bounds.pluginRootDir, 'plugin.json'))) break;
    if (existsSync(cur)) {
      try {
        const lst = lstatSync(cur);
        if (!lst.isDirectory() || lst.isSymbolicLink()) break;
        if (readdirSync(cur).length > 0) break;
        rmdirSync(cur);
        removedDirs++;
      } catch {
        break;
      }
    }
    if (cur === bounds.pluginRootDir) break;
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return removedDirs;
}

// A failed Windows removal can leave empty directories and registered retired files.
export function isRetiredPluginRemnant(rootDir, dataDir) {
  const retired = new Set(readRetiredBinariesList(dataDir).map(p => resolve(p)));
  function isRemnant(path) {
    const st = lstatSync(path);
    if (st.isDirectory()) return readdirSync(path).every(name => isRemnant(join(path, name)));
    return st.isFile() && RETIRED_BINARY_RE.test(path) && retired.has(resolve(path));
  }
  return lstatSync(rootDir).isDirectory() && isRemnant(rootDir);
}

function isCompletelyEmptyDirTree(dirPath) {
  let lst;
  try {
    lst = lstatSync(dirPath);
  } catch {
    return false;
  }
  if (!lst.isDirectory() || lst.isSymbolicLink()) return false;
  let entries;
  try {
    entries = readdirSync(dirPath);
  } catch {
    return false;
  }
  for (const name of entries) {
    const sub = join(dirPath, name);
    let subLst;
    try {
      subLst = lstatSync(sub);
    } catch {
      return false;
    }
    if (!subLst.isDirectory() || subLst.isSymbolicLink()) return false;
    if (!isCompletelyEmptyDirTree(sub)) return false;
  }
  return true;
}

function removeEmptyDirTreeBottomUp(dirPath) {
  let count = 0;
  for (const name of readdirSync(dirPath)) {
    count += removeEmptyDirTreeBottomUp(join(dirPath, name));
  }
  rmdirSync(dirPath);
  return count + 1;
}

/**
 * Sweeps `retired-binaries.json`, deletes any `*.old.<ts>` file whose Windows handle has closed,
 * and safely prunes empty leftover plugin directories (strictly skipping `agy-market`, directories
 * that still contain `plugin.json`, symlinks, and any directory with remaining files).
 */
export function sweepRetiredBinaries(dataDir, { pluginsDir = '' } = {}) {
  const absPluginsDir = pluginsDir ? resolve(pluginsDir) : '';
  const absDisabledDir = dataDir ? resolve(dataDir, 'disabled-plugins') : '';
  const list = readRetiredBinariesList(dataDir);

  const remaining = [];
  let removed = 0;
  let removedDirs = 0;
  let stillLocked = 0;
  if (hasLockedRemovals(dataDir)) {
    const ledger = join(dataDir, LOCKED_REMOVALS);
    const records = JSON.parse(readFileSync(ledger, 'utf8'));
    const retry = [];
    for (const entry of records) {
      const { root, path } = entry;
      try {
        if (!sameRemovalRoot(entry)) continue;
        const stamp = regularFileStamp(path);
        if (stamp && stamp !== entry.stamp) continue;
        if (stamp) {
          unlinkSync(path);
          removed++;
        }
        removedDirs += pruneEmptyRetiredParentDirs(path, { pluginRootDir: root, topDirName: basename(root) });
      } catch (err) {
        if (err.code !== 'ENOENT') retry.push(entry);
      }
    }
    stillLocked = retry.length;
    if (stillLocked) writeRetiredBinariesList(dataDir, retry, LOCKED_REMOVALS);
    else rmSync(ledger, { force: true });
  }

  if (list.length > 0) {
    for (const oldPath of list) {
      const absOld = resolve(oldPath);
      if (!existsSync(absOld)) {
        removed++;
        removedDirs += pruneEmptyRetiredParentDirs(
          absOld,
          resolveRetiredCleanupBounds(absOld, { absPluginsDir, absDisabledDir }),
        );
        continue;
      }
      try {
        unlinkSync(absOld);
        removed++;
        removedDirs += pruneEmptyRetiredParentDirs(
          absOld,
          resolveRetiredCleanupBounds(absOld, { absPluginsDir, absDisabledDir }),
        );
      } catch {
        remaining.push(oldPath);
      }
    }
    writeRetiredBinariesList(dataDir, remaining);
  }

  if (absPluginsDir && existsSync(absPluginsDir)) {
    try {
      for (const entry of readdirSync(absPluginsDir)) {
        if (entry === PLUGIN_ID) continue;
        const cand = join(absPluginsDir, entry);
        try {
          const lst = lstatSync(cand);
          if (!lst.isDirectory() || lst.isSymbolicLink()) continue;
          if (existsSync(join(cand, 'plugin.json'))) continue;
          if (isCompletelyEmptyDirTree(cand)) {
            removedDirs += removeEmptyDirTreeBottomUp(cand);
          }
        } catch {
          /* ignore locked or inaccessible directory */
        }
      }
    } catch {
      /* ignore unreadable pluginsDir */
    }
  }

  return { removed, remaining: remaining.length + stillLocked, removedDirs };
}

/**
 * Lists all regular files under `rootDir` as POSIX relative paths without following or modifying symlinks/junctions.
 * When `tolerateLockErrors` is true, retries transient Windows locks on `readdirSync` and skips locked subdirs.
 */
export function listAllRelFiles(rootDir, { tolerateLockErrors = false, onWarning = null, deferredLinks, directories, unreadable } = {}) {
  const out = [];
  if (!existsSync(rootDir)) return out;

  const warnLock = (relPath, err) => {
    if (LOCK_ERROR_CODES.has(err.code)) unreadable?.set(relPath, err);
    const msg = `[sync-dir] Skipping locked path "${relPath || '.'}": ${err?.code || ''} ${err?.message || err}`.trim();
    if (typeof onWarning === 'function') {
      onWarning(msg);
    } else {
      console.warn(msg);
    }
  };

  function walk(curAbs, relPrefix) {
    let entries;
    if (tolerateLockErrors) {
      try {
        entries = withLockRetrySync(() => readdirSync(curAbs));
      } catch (err) {
        if (LOCK_ERROR_CODES.has(err?.code) || err?.code === 'ENOENT') {
          warnLock(relPrefix, err);
          return;
        }
        throw err;
      }
    } else {
      entries = readdirSync(curAbs);
    }

    for (const name of entries) {
      const full = join(curAbs, name);
      const rel = relPrefix ? posix.join(relPrefix, name) : name;
      let lst;
      if (tolerateLockErrors) {
        try {
          lst = withLockRetrySync(() => lstatSync(full));
        } catch (err) {
          if (LOCK_ERROR_CODES.has(err?.code) || err?.code === 'ENOENT') {
            warnLock(rel, err);
            continue;
          }
          throw err;
        }
      } else {
        lst = lstatSync(full);
      }

      if (lst.isSymbolicLink()) {
        if (!deferredLinks) throw new Error('ERR_PLUGIN_LAYOUT_CONFLICT: Unexpected symbolic link in source: ' + rel);
        deferredLinks.add(rel);
        continue;
      }
      if (lst.isDirectory()) {
        directories?.add(rel);
        walk(full, rel);
      } else if (lst.isFile()) {
        out.push(rel);
      }
    }
  }
  walk(rootDir, '');
  return out;
}

// Stamped entries may be interrupted copies. An unstamped legacy first install
// can only reuse a file whose complete contents already match the release.
function matchesRecoveryCopy(file, source, stamps, rel, requireComplete) {
  if (stamps) {
    const expected = stamps.get(rel);
    const live = regularFileStamp(file);
    if (!expected || !live || (live !== expected && !live.startsWith(expected + ':'))) return false;
  }
  const size = statSync(file).size;
  const sourceSize = statSync(source).size;
  if (requireComplete ? size !== sourceSize : size > sourceSize) return false;
  const actual = Buffer.allocUnsafe(65536);
  const expected = Buffer.allocUnsafe(actual.length);
  const live = openSync(file, 'r');
  try {
    const staged = openSync(source, 'r');
    try {
      for (let offset = 0; offset < size;) {
        const length = Math.min(actual.length, size - offset);
        const n = readSync(live, actual, 0, length, offset);
        if (!n || readSync(staged, expected, 0, n, offset) !== n ||
            !actual.subarray(0, n).equals(expected.subarray(0, n))) return false;
        offset += n;
      }
      return true;
    } finally { closeSync(staged); }
  } finally { closeSync(live); }
}

/**
 * Syncs a staged bundle into the installation in place.
 * The writeOverride hook supports deterministic testing of Windows file locks.
 */
export function syncDirectoryLockSafe({
  stagingBundleDir,
  targetPluginDir,
  dataDir,
  preservePaths = [],
  previousManagedFiles = null,
  nowMs = Date.now(),
  writeOverride = null,
  beforeWrite = null,
  onRootCreated = null,
  onFileWritten = null,
  includeSourceFile = null,
  recovering = false,
  recoveryStamps = null,
  reuseIdenticalFiles = false,
  reserveNewFiles = false,
  onWarning = null,
}) {
  const absSrc = resolve(stagingBundleDir);
  const absDst = resolve(targetPluginDir);

  const targetStat = lstatSync(absDst, { throwIfNoEntry: false });
  const rootLink = targetStat?.isSymbolicLink();
  const isPreserved = createPreserveMatcher(preservePaths, absDst);
  const sourceFiles = listAllRelFiles(absSrc, { tolerateLockErrors: false });
  const incomingFiles = includeSourceFile ? sourceFiles.filter(includeSourceFile) : sourceFiles;
  const incomingSet = new Set(incomingFiles);
  const deferredLinks = new Set();
  const directories = new Set();
  const unreadable = new Map();
  const existingFiles = rootLink ? [] : listAllRelFiles(absDst, {
    tolerateLockErrors: true, onWarning, deferredLinks, directories, unreadable,
  });

  const newlyRetired = [];
  function retireLockedFile(file) {
    let stamp = nowMs;
    while (existsSync(`${file}.old.${stamp}`)) stamp++;
    const retired = `${file}.old.${stamp}`;
    // Register before the rename so an interrupted sync cannot strand a locked binary.
    // GC drops a missing path if the rename itself fails.
    recordRetiredBinaries(dataDir, [retired]);
    renameSync(file, retired);
    newlyRetired.push(retired);
  }

  const hasPrevManaged = Array.isArray(previousManagedFiles);
  const prevManagedSet = hasPrevManaged
    ? new Set(
        previousManagedFiles
          .filter((f) => typeof f === 'string' && f.trim())
          .map((f) => f.trim().replace(/\\/g, '/')),
      )
    : null;

  // Enumeration may skip locked runtime data, but cannot prove that an owned
  // obsolete entry disappeared or that a destination is clear below that path.
  for (const [dir, error] of unreadable) {
    const prefix = dir.toLowerCase();
    const overlaps = rel => !prefix || rel.toLowerCase() === prefix || rel.toLowerCase().startsWith(prefix + '/');
    if (incomingFiles.some(overlaps) || [...(prevManagedSet || [])].some(rel => overlaps(rel) && !isPreserved(rel))) {
      throw error;
    }
  }

  // Match alternate spellings only if the filesystem resolves them to the same
  // existing entry. Case-sensitive volumes can legitimately contain both.
  const existingSet = new Set(existingFiles);
  const byFoldedPath = new Map();
  for (const rel of [...existingFiles, ...directories, ...deferredLinks]) {
    const key = rel.toLowerCase();
    if (!byFoldedPath.has(key)) byFoldedPath.set(key, []);
    byFoldedPath.get(key).push(rel);
  }
  function diskSpelling(rel) {
    if (existingSet.has(rel) || directories.has(rel) || deferredLinks.has(rel)) return rel;
    const candidates = byFoldedPath.get(rel.toLowerCase());
    if (!candidates) return rel;
    const stat = lstatSync(join(absDst, rel), { bigint: true, throwIfNoEntry: false });
    if (!stat) return rel;
    return candidates.find(candidate => {
      const other = lstatSync(join(absDst, candidate), { bigint: true });
      return other.dev === stat.dev && other.ino === stat.ino;
    }) || rel;
  }
  for (const rel of [...(prevManagedSet || [])]) prevManagedSet.add(diskSpelling(rel));
  const caseRenames = new Map();
  const skipCopy = new Set();

  // Check the entire layout before replacing any prior managed file. A directory
  // may only be collapsed if every file below it belongs to the old package.
  const filesToRemove = new Set();
  const dirsToRemove = new Set();
  const createExclusive = new Set();
  function requireManaged(rel) {
    if (!prevManagedSet?.has(rel) || isPreserved(rel)) {
      throw new Error(`ERR_PLUGIN_LAYOUT_CONFLICT: Cannot replace local path "${rel}"`);
    }
    filesToRemove.add(rel);
  }
  function planDirectoryRemoval(rel) {
    if (isPreserved(rel)) throw new Error(`ERR_PLUGIN_LAYOUT_CONFLICT: Preserved directory "${rel}"`);
    for (const entry of readdirSync(join(absDst, rel), { withFileTypes: true })) {
      const child = posix.join(rel, entry.name);
      if (entry.isDirectory() && !entry.isSymbolicLink()) planDirectoryRemoval(child);
      else requireManaged(child);
    }
    dirsToRemove.add(rel);
  }
  for (const rel of incomingFiles) {
    // Check each ancestor before inspecting descendants of a local link.
    let prefix = '';
    for (const part of rel.split('/')) {
      prefix = prefix ? posix.join(prefix, part) : part;
      const actual = diskSpelling(prefix);
      if (!deferredLinks.has(actual)) continue;
      if (isPreserved(actual) || isPreserved(prefix)) skipCopy.add(rel);
      else requireManaged(actual);
      break;
    }
    if (skipCopy.has(rel)) continue;
    for (let path = rel; path !== '.'; path = posix.dirname(path)) {
      const actual = diskSpelling(path);
      if (!reuseIdenticalFiles && actual !== path && posix.basename(path) !== posix.basename(actual)) {
        caseRenames.set(actual, posix.basename(path));
      }
      if (path === rel) {
        if (directories.has(actual)) planDirectoryRemoval(actual);
        if (prevManagedSet && !prevManagedSet.has(actual) && !existingSet.has(actual)) createExclusive.add(rel);
        if (prevManagedSet && existingSet.has(actual) && !prevManagedSet.has(actual) && !isPreserved(actual) && !isPreserved(rel)) {
          if (!recovering || !matchesRecoveryCopy(join(absDst, actual), join(absSrc, rel), recoveryStamps, rel, reuseIdenticalFiles)) {
            throw new Error(`ERR_PLUGIN_LAYOUT_CONFLICT: Cannot overwrite local file "${actual}"`);
          }
          if (reuseIdenticalFiles) skipCopy.add(rel);
        }
        incomingSet.add(actual);
        if (actual !== rel && isPreserved(actual)) skipCopy.add(rel);
      } else if (existingSet.has(actual)) {
        requireManaged(actual);
      }
    }
  }
  if (deferredLinks.has(diskSpelling('.agy-market-receipt.json'))) {
    throw new Error('ERR_PLUGIN_LAYOUT_CONFLICT: Expected a regular plugin receipt');
  }
  beforeWrite?.();
  if (rootLink) removeSymlinkOrJunctionOnly(absDst);
  mkdirSync(absDst, { recursive: true });
  if (!targetStat || rootLink) onRootCreated?.();
  for (const rel of deferredLinks) {
    if (filesToRemove.has(rel) || (prevManagedSet?.has(rel) && !isPreserved(rel))) {
      removeSymlinkOrJunctionOnly(join(absDst, rel));
    }
  }
  for (const rel of filesToRemove) {
    if (!deferredLinks.has(rel)) unlinkSync(join(absDst, rel));
  }
  for (const rel of dirsToRemove) rmdirSync(join(absDst, rel));

  // Rename children before their parents, while their original paths still exist.
  for (const [oldPath, newName] of [...caseRenames].sort(([a], [b]) => b.length - a.length)) {
    if (!filesToRemove.has(oldPath) && !dirsToRemove.has(oldPath)) {
      renameSync(join(absDst, oldPath), join(absDst, posix.dirname(oldPath), newName));
    }
  }

  // 1. Copy/overwrite all incoming files (excluding user-preserved existing files)
  for (const rel of incomingFiles) {
    const srcFile = join(absSrc, rel);
    const dstFile = join(absDst, rel);

    if (skipCopy.has(rel) || (isPreserved(rel) && existsSync(dstFile))) {
      continue; // Keep user's customized preserved file intact!
    }

    mkdirSync(dirname(dstFile), { recursive: true });
    try {
      if (writeOverride) {
        writeOverride(srcFile, dstFile, rel);
      } else if (reserveNewFiles && createExclusive.has(rel)) {
        // Bind the exclusive directory entry before copying. If the process
        // stops mid-copy, matching bytes alone cannot identify a user file.
        closeSync(openSync(dstFile, 'wx', statSync(srcFile).mode & 0o777));
        onFileWritten(rel, dstFile, true);
        copyFileSync(srcFile, dstFile);
      } else {
        copyFileSync(srcFile, dstFile, createExclusive.has(rel) ? fsConstants.COPYFILE_EXCL : 0);
      }
    } catch (err) {
      if (createExclusive.has(rel)) {
        if (err.code === 'EEXIST') throw new Error(`ERR_PLUGIN_LAYOUT_CONFLICT: Local file appeared at "${rel}".`, { cause: err });
        throw err;
      }
      if (LOCK_ERROR_CODES.has(err?.code) && existsSync(dstFile)) {
        // Rename locked binary aside in the same directory (`<file>.old.<timestamp>`)
        try {
          retireLockedFile(dstFile);
          copyFileSync(srcFile, dstFile);
        } catch (retryErr) {
          if (LOCK_ERROR_CODES.has(retryErr?.code) && retryErr?.message && !String(retryErr.message).includes('[sync]')) {
            try {
              retryErr.message = `[sync] (${rel}) ${retryErr.message}`;
            } catch {
              /* read-only message */
            }
          }
          throw retryErr;
        }
      } else {
        if (LOCK_ERROR_CODES.has(err?.code) && err?.message && !String(err.message).includes('[sync]')) {
          try {
            err.message = `[sync] (${rel}) ${err.message}`;
          } catch {
            /* read-only message */
          }
        }
        throw err;
      }
    }
    onFileWritten?.(rel, dstFile);
  }

  // Only a previous package inventory establishes ownership of omitted files.
  let removedStale = 0;
  if (prevManagedSet) {
    for (const rel of existingFiles) {
      if (!prevManagedSet.has(rel)) continue;
      if (incomingSet.has(rel) || filesToRemove.has(rel)) continue;
      if (isPreserved(rel)) continue;
      if (RETIRED_BINARY_RE.test(rel)) continue;

      const staleFile = join(absDst, rel);
      try {
        unlinkSync(staleFile);
        removedStale++;
      } catch (err) {
        if (err.code === 'ENOENT') continue;
        if (!LOCK_ERROR_CODES.has(err.code)) throw err;
        retireLockedFile(staleFile);
      }
    }
  }

  // Clean up empty non-root subdirectories inside absDst without traversing junctions
  function pruneEmptyDirs(curDir) {
    if (!existsSync(curDir)) return;
    let entries;
    try {
      entries = readdirSync(curDir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const sub = join(curDir, entry);
      try {
        const lst = lstatSync(sub);
        if (!lst.isSymbolicLink() && lst.isDirectory()) {
          pruneEmptyDirs(sub);
          if (readdirSync(sub).length === 0) {
            rmdirSync(sub);
          }
        }
      } catch {
        /* ignore */
      }
    }
  }
  if (prevManagedSet) pruneEmptyDirs(absDst);

  return {
    syncedFiles: incomingFiles.length,
    removedStale,
    retiredBinaries: newlyRetired,
    managedFiles: [...incomingFiles].sort(),
  };
}
