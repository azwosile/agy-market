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

function listAllRelFiles(rootDir) {
  const out = [];
  if (!existsSync(rootDir)) return out;

  function walk(curAbs, relPrefix) {
    for (const name of readdirSync(curAbs)) {
      const full = join(curAbs, name);
      const rel = relPrefix ? posix.join(relPrefix, name) : name;
      const lst = lstatSync(full);
      if (lst.isSymbolicLink()) {
        // Remove any stray symlink inside target
        rmSync(full, { recursive: true, force: true });
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
  nowMs = Date.now(),
  writeOverride = null,
}) {
  const absSrc = resolve(stagingBundleDir);
  const absDst = resolve(targetPluginDir);

  // If a symlink/junction ever sat at absDst, remove link before creating real directory
  if (existsSync(absDst) && lstatSync(absDst).isSymbolicLink()) {
    rmSync(absDst, { recursive: true, force: true });
  }
  mkdirSync(absDst, { recursive: true });

  const isPreserved = createPreserveMatcher(preservePaths);
  const incomingFiles = listAllRelFiles(absSrc);
  const incomingSet = new Set(incomingFiles);
  const existingFiles = listAllRelFiles(absDst);

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
        renameSync(dstFile, retiredFile);
        copyFileSync(srcFile, dstFile);
        newlyRetired.push(retiredFile);
      } else {
        throw err;
      }
    }
  }

  // 2. Remove stale files no longer present in the new release (except preserved globs & retired `*.old.<ts>`)
  let removedStale = 0;
  for (const rel of existingFiles) {
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

  if (newlyRetired.length > 0) {
    writeRetiredBinariesList(dataDir, [...retiredPaths, ...newlyRetired]);
  }

  // Clean up empty non-root subdirectories inside absDst
  function pruneEmptyDirs(curDir) {
    if (!existsSync(curDir)) return;
    for (const entry of readdirSync(curDir)) {
      const sub = join(curDir, entry);
      try {
        if (statSync(sub).isDirectory()) {
          pruneEmptyDirs(sub);
          if (readdirSync(sub).length === 0) {
            rmSync(sub, { recursive: true, force: true });
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
  };
}
