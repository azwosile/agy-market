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
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, posix, resolve } from 'node:path';

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
 * Sweeps `retired-binaries.json` and deletes any `*.old.<ts>` file whose Windows handle has closed.
 */
export function sweepRetiredBinaries(dataDir) {
  const list = readRetiredBinariesList(dataDir);
  if (list.length === 0) return { removed: 0, remaining: 0 };

  const remaining = [];
  let removed = 0;
  for (const oldPath of list) {
    if (!existsSync(oldPath)) {
      removed++;
      continue;
    }
    try {
      unlinkSync(oldPath);
      removed++;
    } catch {
      remaining.push(oldPath);
    }
  }
  writeRetiredBinariesList(dataDir, remaining);
  return { removed, remaining: remaining.length };
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
