// Windows File-Lock Safe In-Place Sync & Retired Binary Garbage Collector (`src/installer/sync-dir.mjs`).
//
// Why In-Place Sync:
//   Running MCP Stdio servers and Sidecars on Windows hold open handles on their CWD (`<dir>`)
//   and lock `.exe`/`.dll`/`.node` files. Deleting `<dir>` fails with `EBUSY`/`EPERM`.
//   Instead, we preserve `preservePaths` + `.agy-market-receipt.json`, sync files in-place,
//   rename locked binaries aside (`<file>.old.<timestamp>`), and sweep retired binaries on boot/install.

import {
  copyFileSync,
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
import { basename, dirname, isAbsolute, join, posix, relative, resolve } from 'node:path';
import { PLUGIN_ID } from '../shared/constants.mjs';

const LOCK_ERROR_CODES = new Set(['EBUSY', 'EPERM', 'EACCES']);
const RETIRED_BINARY_RE = /\.old\.\d{10,}$/;
const LOCK_RETRY_DELAYS_MS = [30, 80, 150];
const SLEEP_BUF = new Int32Array(new SharedArrayBuffer(4));

function sleepSync(ms) {
  if (ms > 0) {
    Atomics.wait(SLEEP_BUF, 0, 0, ms);
  }
}

/**
 * Retries a synchronous filesystem operation on transient Windows lock errors (`EBUSY`/`EPERM`/`EACCES`).
 */
export function withLockRetrySync(fn, retryDelays = LOCK_RETRY_DELAYS_MS) {
  let lastErr;
  for (let attempt = 0; attempt <= retryDelays.length; attempt++) {
    try {
      return fn();
    } catch (err) {
      lastErr = err;
      if (!LOCK_ERROR_CODES.has(err?.code) || attempt >= retryDelays.length) {
        throw err;
      }
      sleepSync(retryDelays[attempt]);
    }
  }
  throw lastErr;
}

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

function globToRegExp(globPattern) {
  const norm = String(globPattern || '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\/+/, '');
  let regexStr = '^';
  for (let i = 0; i < norm.length; i++) {
    const ch = norm[i];
    if (ch === '*' && norm[i + 1] === '*') {
      if (norm[i + 2] === '/') {
        regexStr += '(?:.+/)?';
        i += 2;
      } else {
        regexStr += '.*';
        i += 1;
      }
    } else if (ch === '*') {
      regexStr += '[^/]*';
    } else if (ch === '?') {
      regexStr += '[^/]';
    } else if ('+^$?.()|[]{}'.includes(ch)) {
      regexStr += `\\${ch}`;
    } else {
      regexStr += ch;
    }
  }
  regexStr += '$';
  return new RegExp(regexStr);
}

export function createPreserveMatcher(preservePaths = []) {
  const compiled = [
    globToRegExp('.agy-market-receipt.json'),
    ...preservePaths
      .filter((p) => typeof p === 'string' && p.trim() && !p.includes('..'))
      .flatMap((p) => {
        const clean = p.trim().replace(/\\/g, '/').replace(/\/+$/, '');
        return [globToRegExp(clean), globToRegExp(`${clean}/**`)];
      }),
  ];
  return (relPosixPath) => compiled.some((re) => re.test(relPosixPath));
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

function writeRetiredBinariesList(dataDir, pathsList) {
  mkdirSync(dataDir, { recursive: true });
  const listPath = join(dataDir, 'retired-binaries.json');
  writeFileSync(listPath, `${JSON.stringify([...new Set(pathsList)], null, 2)}\n`, 'utf8');
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

  return { removed, remaining: remaining.length, removedDirs };
}

/**
 * Lists all regular files under `rootDir` as POSIX relative paths while safely removing stray symlinks/junctions.
 * When `tolerateLockErrors` is true, retries transient Windows locks on `readdirSync` and skips locked subdirs.
 */
export function listAllRelFiles(rootDir, { tolerateLockErrors = false, onWarning = null } = {}) {
  const out = [];
  if (!existsSync(rootDir)) return out;

  const warnLock = (relPath, err) => {
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
        // Remove any stray symlink/junction inside target without calling recursive opendir
        if (tolerateLockErrors) {
          try {
            removeSymlinkOrJunctionOnly(full);
          } catch (err) {
            warnLock(rel, err);
          }
        } else {
          removeSymlinkOrJunctionOnly(full);
        }
        continue;
      }
      if (lst.isDirectory()) {
        walk(full, rel);
      } else if (lst.isFile()) {
        out.push(rel);
      }
    }
  }
  walk(rootDir, '');
  return out;
}

/**
 * Syncs `stagingBundleDir` into `targetPluginDir` in-place safely on Windows/macOS/Linux.
 * Optional `writeOverride` hook supports deterministic unit-testing of `EBUSY` binary locks.
 */
export function syncDirectoryLockSafe({
  stagingBundleDir,
  targetPluginDir,
  dataDir,
  preservePaths = [],
  previousManagedFiles = null,
  nowMs = Date.now(),
  writeOverride = null,
  onWarning = null,
}) {
  const absSrc = resolve(stagingBundleDir);
  const absDst = resolve(targetPluginDir);

  // If a symlink/junction ever sat at absDst, remove link before creating real directory
  if (existsSync(absDst) && lstatSync(absDst).isSymbolicLink()) {
    removeSymlinkOrJunctionOnly(absDst);
  }
  mkdirSync(absDst, { recursive: true });

  const isPreserved = createPreserveMatcher(preservePaths);
  const incomingFiles = listAllRelFiles(absSrc, { tolerateLockErrors: false });
  const incomingSet = new Set(incomingFiles);
  const existingFiles = listAllRelFiles(absDst, { tolerateLockErrors: true, onWarning });

  const retiredPaths = readRetiredBinariesList(dataDir);
  const newlyRetired = [];

  // 1. Copy/overwrite all incoming files (excluding user-preserved existing files)
  for (const rel of incomingFiles) {
    const srcFile = join(absSrc, rel);
    const dstFile = join(absDst, rel);

    if (existsSync(dstFile) && isPreserved(rel)) {
      continue; // Keep user's customized preserved file intact!
    }

    mkdirSync(dirname(dstFile), { recursive: true });
    try {
      if (writeOverride) {
        writeOverride(srcFile, dstFile, rel);
      } else {
        copyFileSync(srcFile, dstFile);
      }
    } catch (err) {
      if (LOCK_ERROR_CODES.has(err?.code) && existsSync(dstFile)) {
        // Rename locked binary aside in the same directory (`<file>.old.<timestamp>`)
        const retiredFile = `${dstFile}.old.${nowMs}`;
        try {
          renameSync(dstFile, retiredFile);
          copyFileSync(srcFile, dstFile);
          newlyRetired.push(retiredFile);
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
  }

  // 2. Remove stale files no longer present in the new release:
  //    - When `previousManagedFiles` is provided, only delete files that were previously managed by the package.
  //    - When `previousManagedFiles === null` (legacy pre-v1.7.2 receipt):
  //        * if `preservePaths.length === 0`, skip stale deletion to protect user-created files on first upgrade;
  //        * if `preservePaths.length > 0`, preserve legacy preservePaths-based cleanup for compatibility.
  let removedStale = 0;
  const hasPrevManaged = Array.isArray(previousManagedFiles);
  const prevManagedSet = hasPrevManaged
    ? new Set(
        previousManagedFiles
          .filter((f) => typeof f === 'string' && f.trim())
          .map((f) => f.trim().replace(/\\/g, '/')),
      )
    : null;
  const shouldCleanStale = hasPrevManaged || preservePaths.length > 0;

  if (shouldCleanStale) {
    for (const rel of existingFiles) {
      if (hasPrevManaged && !prevManagedSet.has(rel)) continue;
      if (incomingSet.has(rel)) continue;
      if (isPreserved(rel)) continue;
      if (RETIRED_BINARY_RE.test(rel)) continue;

      const staleFile = join(absDst, rel);
      try {
        unlinkSync(staleFile);
        removedStale++;
      } catch (err) {
        if (LOCK_ERROR_CODES.has(err?.code) && existsSync(staleFile)) {
          const retiredFile = `${staleFile}.old.${nowMs}`;
          try {
            renameSync(staleFile, retiredFile);
            newlyRetired.push(retiredFile);
          } catch {
            /* leave for next sweep */
          }
        }
      }
    }
  }

  if (newlyRetired.length > 0) {
    writeRetiredBinariesList(dataDir, [...retiredPaths, ...newlyRetired]);
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
  pruneEmptyDirs(absDst);

  return {
    syncedFiles: incomingFiles.length,
    removedStale,
    retiredBinaries: newlyRetired,
    managedFiles: [...incomingFiles].sort(),
  };
}
