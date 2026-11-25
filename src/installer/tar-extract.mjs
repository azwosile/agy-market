// Pure-Node POSIX ustar/pax .tar.gz extractor & deterministic archive builder (`src/installer/tar-extract.mjs`).
// Rejects Zip-Slip (`..`, absolute paths, NUL bytes) AND enforces scoped symlink/hardlink rejection:
//   - Hard-throws `ERR_TAR_SYMLINK_FORBIDDEN` whenever ANY symlink/hardlink exists inside `pluginRoot`
//     (including anywhere in the archive when `pluginRoot === '.'` or unscoped), is an ancestor of
//     `pluginRoot`, or has a path/target that traverses into `pluginRoot`.
//   - Allows and skips symlinks strictly outside a subdirectory `pluginRoot` (e.g. dual-host `.claude/`
//     or `docs/` symlinks) without ever creating links on disk, because Antigravity's GetAllPlugins
//     silently skips NTFS junctions/symlinks on Windows.

import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, posix, resolve } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { MAX_TARBALL_BYTES } from '../shared/constants.mjs';

function readCleanString(buf, start, length) {
  const sub = buf.subarray(start, start + length);
  const nul = sub.indexOf(0);
  return (nul === -1 ? sub : sub.subarray(0, nul)).toString('utf8');
}

function parseTarOctal(buf, start, length) {
  if ((buf[start] & 0x80) !== 0) {
    let val = 0n;
    for (let i = start + 1; i < start + length; i++) {
      val = (val << 8n) | BigInt(buf[i]);
    }
    return Number(val);
  }
  const str = readCleanString(buf, start, length).trim();
  if (!str) return 0;
  const parsed = parseInt(str, 8);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`ERR_TAR_CORRUPT: Invalid octal header value "${str}"`);
  }
  return parsed;
}

export function parsePaxRecords(buf) {
  const attrs = {};
  let offset = 0;
  while (offset < buf.length) {
    const sp = buf.indexOf(0x20, offset);
    if (sp === -1) break;
    const len = parseInt(buf.subarray(offset, sp).toString('ascii'), 10);
    if (!Number.isFinite(len) || len <= sp - offset + 1 || offset + len > buf.length) break;
    let end = offset + len;
    if (buf[end - 1] === 0x0a) end -= 1;
    const record = buf.subarray(sp + 1, end).toString('utf8');
    const eq = record.indexOf('=');
    if (eq !== -1) attrs[record.slice(0, eq)] = record.slice(eq + 1);
    offset += len;
  }
  return attrs;
}

export function encodePaxRecord(key, value) {
  const body = `${key}=${value}\n`;
  const bodyBytes = Buffer.byteLength(body, 'utf8');
  let totalLen = String(bodyBytes + 3).length + 1 + bodyBytes;
  while (String(totalLen).length + 1 + bodyBytes !== totalLen) {
    totalLen = String(totalLen).length + 1 + bodyBytes;
  }
  return Buffer.from(`${totalLen} ${body}`, 'utf8');
}

export function validateSafeRelPath(rawPath) {
  if (typeof rawPath !== 'string' || !rawPath.length) {
    throw new Error('ERR_TAR_UNSAFE_PATH: Empty archive path');
  }
  if (rawPath.includes('\0')) {
    throw new Error('ERR_TAR_UNSAFE_PATH: NUL byte in archive path');
  }
  const norm = rawPath.replace(/\\/g, '/');
  if (norm.startsWith('/') || /^[A-Za-z]:/.test(norm)) {
    throw new Error(`ERR_TAR_UNSAFE_PATH: Absolute archive path "${rawPath}" prohibited`);
  }
  const clean = [];
  for (const seg of norm.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') {
      throw new Error(`ERR_TAR_PATH_TRAVERSAL: Parent traversal ".." prohibited ("${rawPath}")`);
    }
    clean.push(seg);
  }
  return clean.join('/');
}

function normalizeTarPluginRoot(rawRoot = '.') {
  const s = String(rawRoot ?? '.')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\/+/, '')
    .replace(/\/+$/, '');
  if (!s || s === '.') return '.';
  return validateSafeRelPath(s) || '.';
}

function doesLinkTargetTraversePluginRoot(linkPath, rawTarget, normRoot, strippedTopDir = '', typeFlag = '2') {
  const target = String(rawTarget || '')
    .replace(/\\/g, '/')
    .trim();
  if (!target) return false;

  const rootPrefix = `${normRoot}/`;
  const entersPluginRoot = (relPath) => {
    const clean = String(relPath || '')
      .replace(/^\/+/, '')
      .replace(/\/+$/, '');
    if (!clean) return false;
    return clean === normRoot || clean.startsWith(rootPrefix);
  };

  const candidates = [target];
  if (strippedTopDir && target.startsWith(`${strippedTopDir}/`)) {
    candidates.push(target.slice(strippedTopDir.length + 1));
  }

  for (const cand of candidates) {
    const isAbs = cand.startsWith('/') || /^[A-Za-z]:/.test(cand);
    const strippedAbs = cand.replace(/^[A-Za-z]:/, '').replace(/^\/+/, '');
    if (entersPluginRoot(strippedAbs)) return true;

    const startSegs =
      isAbs || typeFlag === '1'
        ? []
        : linkPath.includes('/')
          ? linkPath.slice(0, linkPath.lastIndexOf('/')).split('/').filter(Boolean)
          : [];
    const segs = [...startSegs];
    let escapedAboveRoot = false;
    const parts = cand.replace(/^[A-Za-z]:/, '').split('/');
    for (const part of parts) {
      if (!part || part === '.') continue;
      if (part === '..') {
        if (segs.length === 0) {
          escapedAboveRoot = true;
        } else {
          segs.pop();
        }
      } else {
        segs.push(part);
      }
      if (!escapedAboveRoot && segs.length > 0 && entersPluginRoot(segs.join('/'))) {
        return true;
      }
    }
    if (!escapedAboveRoot && segs.length > 0 && entersPluginRoot(segs.join('/'))) {
      return true;
    }
  }
  return false;
}

/**
 * Enforces the strict scoped symlink security invariant:
 * - When `pluginRoot` is `'.'` or unscoped: ANY symlink/hardlink anywhere in the archive throws `ERR_TAR_SYMLINK_FORBIDDEN`.
 * - When `pluginRoot` is a subdirectory: hard-throws `ERR_TAR_SYMLINK_FORBIDDEN` if ANY symlink/hardlink is
 *   inside `pluginRoot`, is an ancestor directory of `pluginRoot`, or has a target traversing into `pluginRoot`.
 */
export function assertNoScopedSymlinks(symlinks = [], pluginRoot = '.', strippedTopDir = '') {
  if (!Array.isArray(symlinks) || symlinks.length === 0) return;

  const normRoot = normalizeTarPluginRoot(pluginRoot);
  if (normRoot === '.') {
    const first = symlinks[0];
    throw new Error(
      `ERR_TAR_SYMLINK_FORBIDDEN: Link entry "${first.path || first.rawName || ''}" (typeflag=${first.typeFlag}) is forbidden`,
    );
  }

  const rootPrefix = `${normRoot}/`;
  for (const link of symlinks) {
    const linkPath = String(link?.path || '').replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
    const typeFlag = String(link?.typeFlag || '2');
    const linkTarget = String(link?.linkTarget || '');

    if (!linkPath || linkPath === normRoot || linkPath.startsWith(rootPrefix)) {
      throw new Error(
        `ERR_TAR_SYMLINK_FORBIDDEN: Link entry "${linkPath || link?.rawName || ''}" (typeflag=${typeFlag}) inside pluginRoot "${normRoot}" is forbidden`,
      );
    }
    if (normRoot.startsWith(`${linkPath}/`)) {
      throw new Error(
        `ERR_TAR_SYMLINK_FORBIDDEN: Ancestor link entry "${linkPath}" (typeflag=${typeFlag}) enclosing pluginRoot "${normRoot}" is forbidden`,
      );
    }
    if (doesLinkTargetTraversePluginRoot(linkPath, linkTarget, normRoot, strippedTopDir, typeFlag)) {
      throw new Error(
        `ERR_TAR_SYMLINK_FORBIDDEN: Link entry "${linkPath}" -> "${linkTarget}" (typeflag=${typeFlag}) traverses into pluginRoot "${normRoot}"`,
      );
    }
  }
}

/**
 * Parses a `.tar.gz` / `.tgz` buffer into `{ files, symlinks, globalPax, strippedTopDir }`.
 * Exposes POSIX PAX global header attributes (e.g. `globalPax.comment` containing 40-hex commitSha
 * from `git archive` / GitHub `codeload`) and the stripped single top-level directory name.
 *
 * Security: By default (`pluginRoot = '.'`, `allowDeferredSymlinkCheck = false`), any symlink/hardlink
 * anywhere in the archive throws `ERR_TAR_SYMLINK_FORBIDDEN`. When scoped to a subdirectory `pluginRoot`,
 * symlinks strictly outside `pluginRoot` (and not traversing into it) are skipped and never placed in `files`.
 */
export function parseTarGzWithMeta(
  compressedBuf,
  {
    maxUncompressedBytes = MAX_TARBALL_BYTES,
    stripSingleTopDir = true,
    pluginRoot = '.',
    allowDeferredSymlinkCheck = false,
  } = {},
) {
  if (!Buffer.isBuffer(compressedBuf) || compressedBuf.length === 0) {
    throw new Error('ERR_TAR_EMPTY: Archive buffer is empty');
  }

  let tarBuf;
  try {
    tarBuf = gunzipSync(compressedBuf, { maxOutputLength: maxUncompressedBytes });
  } catch (err) {
    throw new Error(`ERR_TAR_GUNZIP: ${err?.message || String(err)}`);
  }

  const rawFiles = new Map();
  const rawSymlinks = [];
  let offset = 0;
  let nextPax = {};
  let globalPax = {};
  let nextLongName = '';
  let nextLongLinkName = '';

  while (offset + 512 <= tarBuf.length) {
    const header = tarBuf.subarray(offset, offset + 512);
    offset += 512;

    let allZero = true;
    for (let i = 0; i < 512; i++) {
      if (header[i] !== 0) {
        allZero = false;
        break;
      }
    }
    if (allZero) continue;

    const namePart = readCleanString(header, 0, 100);
    const linkNamePart = readCleanString(header, 157, 100);
    const prefixPart = readCleanString(header, 345, 155);
    const typeFlag = header[156] === 0 ? '0' : String.fromCharCode(header[156]);
    let size = parseTarOctal(header, 124, 12);
    if (nextPax.size !== undefined) size = Number(nextPax.size);

    if (offset + size > tarBuf.length) {
      throw new Error('ERR_TAR_TRUNCATED: Archive truncated mid-entry');
    }

    const payload = tarBuf.subarray(offset, offset + size);
    offset += Math.ceil(size / 512) * 512;

    if (typeFlag === 'x') {
      nextPax = parsePaxRecords(payload);
      continue;
    }
    if (typeFlag === 'g') {
      globalPax = { ...globalPax, ...parsePaxRecords(payload) };
      continue;
    }
    if (typeFlag === 'L') {
      nextLongName = readCleanString(payload, 0, payload.length);
      continue;
    }
    if (typeFlag === 'K') {
      nextLongLinkName = readCleanString(payload, 0, payload.length);
      continue;
    }

    const mergedPax = { ...globalPax, ...nextPax };
    nextPax = {};
    const entryName = nextLongName || mergedPax.path || (prefixPart ? `${prefixPart}/${namePart}` : namePart);
    const linkTarget = nextLongLinkName || mergedPax.linkpath || linkNamePart;
    nextLongName = '';
    nextLongLinkName = '';

    if (typeFlag === '1' || typeFlag === '2') {
      const safeLinkPath = validateSafeRelPath(entryName);
      if (!safeLinkPath) {
        throw new Error(`ERR_TAR_SYMLINK_FORBIDDEN: Link entry "${entryName}" (typeflag=${typeFlag}) is forbidden`);
      }
      rawSymlinks.push({
        path: safeLinkPath,
        rawName: entryName,
        linkTarget,
        typeFlag,
      });
      continue;
    }
    if (typeFlag !== '0' && typeFlag !== '5') {
      throw new Error(`ERR_TAR_UNSUPPORTED_TYPE: Disallowed entry type "${typeFlag}" for "${entryName}"`);
    }

    const safe = validateSafeRelPath(entryName);
    if (!safe || typeFlag === '5' || entryName.endsWith('/')) continue;
    rawFiles.set(safe, Buffer.from(payload));
  }

  let files = rawFiles;
  let symlinks = rawSymlinks;
  let strippedTopDir = '';
  if (stripSingleTopDir && !rawFiles.has('plugin.json') && rawFiles.size > 0) {
    const roots = new Set();
    let allNested = true;
    for (const p of rawFiles.keys()) {
      const idx = p.indexOf('/');
      if (idx === -1) {
        allNested = false;
        break;
      }
      roots.add(p.slice(0, idx));
    }
    if (allNested) {
      for (const s of rawSymlinks) {
        const idx = s.path.indexOf('/');
        if (idx === -1) {
          allNested = false;
          break;
        }
        roots.add(s.path.slice(0, idx));
      }
    }
    if (allNested && roots.size === 1) {
      const [onlyRoot] = roots;
      strippedTopDir = onlyRoot;
      const unwrapped = new Map();
      for (const [p, buf] of rawFiles.entries()) {
        unwrapped.set(p.slice(onlyRoot.length + 1), buf);
      }
      files = unwrapped;
      symlinks = rawSymlinks.map((s) => ({
        ...s,
        path: s.path.slice(onlyRoot.length + 1),
      }));
    }
  }

  if (!allowDeferredSymlinkCheck) {
    assertNoScopedSymlinks(symlinks, pluginRoot, strippedTopDir);
  }

  return { files, symlinks, globalPax, strippedTopDir };
}

/**
 * Parses a `.tar.gz` / `.tgz` buffer into an in-memory `Map<string, Buffer>`.
 */
export function parseTarGzToMap(
  compressedBuf,
  { maxUncompressedBytes = MAX_TARBALL_BYTES, stripSingleTopDir = true, pluginRoot = '.' } = {},
) {
  return parseTarGzWithMeta(compressedBuf, { maxUncompressedBytes, stripSingleTopDir, pluginRoot }).files;
}

/**
 * Extracts a `.tar.gz` file or buffer into `destDir` using real files/directories only,
 * optionally scoping to `pluginRoot` inside the archive.
 */
export function extractTarGzToDir(archiveSource, destDir, { pluginRoot = '.' } = {}) {
  const compressedBuf = Buffer.isBuffer(archiveSource) ? archiveSource : readFileSync(archiveSource);
  const filesMap = parseTarGzToMap(compressedBuf, { stripSingleTopDir: true, pluginRoot });

  const normRoot = normalizeTarPluginRoot(pluginRoot);
  const useSubroot = normRoot && normRoot !== '.';
  const prefix = useSubroot ? `${normRoot}/` : '';

  const absDest = resolve(destDir);
  mkdirSync(absDest, { recursive: true });

  let writtenCount = 0;
  for (const [relPath, buf] of filesMap.entries()) {
    let subRel = relPath;
    if (useSubroot) {
      if (!relPath.startsWith(prefix)) continue;
      subRel = relPath.slice(prefix.length);
    }
    const safeSub = validateSafeRelPath(subRel);
    const fullOut = resolve(absDest, safeSub);
    if (!fullOut.startsWith(absDest)) {
      throw new Error(`ERR_TAR_ESCAPE: Resolved output path escaped destination ("${safeSub}")`);
    }
    mkdirSync(dirname(fullOut), { recursive: true });
    writeFileSync(fullOut, buf);
    writtenCount++;
  }

  if (writtenCount === 0) {
    throw new Error(`ERR_TAR_NO_PLUGIN_FILES: Archive yielded 0 files for pluginRoot="${pluginRoot}"`);
  }

  return { writtenCount };
}

function writeOctal(buf, strVal, offset, length) {
  const oct = strVal.padStart(length - 1, '0');
  buf.write(oct, offset, length - 1, 'ascii');
  buf[offset + length - 1] = 0;
}

function buildUstarHeader(relPath, byteLength, mode = 0o644, typeFlagChar = '0') {
  const header = Buffer.alloc(512, 0);
  const safe = validateSafeRelPath(relPath);
  let name = safe;
  let prefix = '';

  if (Buffer.byteLength(safe, 'utf8') > 100) {
    const slash = safe.lastIndexOf('/');
    if (slash !== -1) {
      prefix = safe.slice(0, slash);
      name = safe.slice(slash + 1);
    }
  }

  // Truncate UTF-8 cleanly at char boundary when an accompanying PAX 'x' header carries the full path
  while (Buffer.byteLength(name, 'utf8') > 100) name = name.slice(0, -1);
  while (Buffer.byteLength(prefix, 'utf8') > 155) prefix = prefix.slice(0, -1);

  header.write(name, 0, Math.min(100, Buffer.byteLength(name)), 'utf8');
  writeOctal(header, mode.toString(8), 100, 8);
  writeOctal(header, '0', 108, 8);
  writeOctal(header, '0', 116, 8);
  writeOctal(header, byteLength.toString(8), 124, 12);
  writeOctal(header, '0', 136, 12); // mtime = 0 for reproducible builds
  header.fill(0x20, 148, 156);
  header.write(typeFlagChar, 156, 1, 'ascii');
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  if (prefix) header.write(prefix, 345, Math.min(155, Buffer.byteLength(prefix)), 'utf8');

  let sum = 0;
  for (let i = 0; i < 512; i++) sum += header[i];
  header.write(sum.toString(8).padStart(6, '0'), 148, 6, 'ascii');
  header[154] = 0;
  header[155] = 0x20;
  return header;
}

export function createDeterministicTarGz(entries, { forcePax = false } = {}) {
  const pairs = entries instanceof Map ? [...entries.entries()] : Object.entries(entries || {});
  const sorted = pairs
    .map(([p, content]) => [
      validateSafeRelPath(p),
      Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8'),
    ])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));

  const chunks = [];
  let paxSeq = 0;
  for (const [relPath, buf] of sorted) {
    const slash = relPath.lastIndexOf('/');
    const baseName = slash === -1 ? relPath : relPath.slice(slash + 1);
    const dirPrefix = slash === -1 ? '' : relPath.slice(0, slash);
    const needsPax =
      forcePax ||
      Buffer.byteLength(baseName, 'utf8') > 100 ||
      Buffer.byteLength(dirPrefix, 'utf8') > 155;

    if (needsPax) {
      const paxPayload = Buffer.concat([
        encodePaxRecord('mtime', '0'),
        encodePaxRecord('path', relPath),
        encodePaxRecord('size', String(buf.length)),
      ]);
      chunks.push(buildUstarHeader(`PaxHeader/entry-${++paxSeq}`, paxPayload.length, 0o644, 'x'));
      chunks.push(paxPayload);
      const paxRem = paxPayload.length % 512;
      if (paxRem !== 0) chunks.push(Buffer.alloc(512 - paxRem, 0));
    }

    const mode = relPath.startsWith('bin/') || relPath.endsWith('.sh') ? 0o755 : 0o644;
    chunks.push(buildUstarHeader(relPath, buf.length, mode, '0'));
    chunks.push(buf);
    const rem = buf.length % 512;
    if (rem !== 0) chunks.push(Buffer.alloc(512 - rem, 0));
  }
  chunks.push(Buffer.alloc(1024, 0));

  const gz = gzipSync(Buffer.concat(chunks), { level: 9 });
  if (gz.length >= 10 && gz[0] === 0x1f && gz[1] === 0x8b) {
    gz[4] = 0;
    gz[5] = 0;
    gz[6] = 0;
    gz[7] = 0;
    gz[9] = 3;
  }
  return gz;
}

export function collectDirectoryFilesMap(rootDir, includePaths = [], { excludeFilter = null } = {}) {
  const map = new Map();
  const absRoot = resolve(rootDir);

  function walk(absCurrent, relPosix) {
    if (excludeFilter && excludeFilter(relPosix, absCurrent)) return;
    const st = statSync(absCurrent);
    if (st.isDirectory()) {
      for (const child of readdirSync(absCurrent).sort()) {
        walk(join(absCurrent, child), relPosix ? posix.join(relPosix, child) : child);
      }
    } else if (st.isFile()) {
      map.set(relPosix, readFileSync(absCurrent));
    }
  }

  for (const item of includePaths) {
    const absItem = resolve(absRoot, item);
    try {
      walk(absItem, item.replace(/\\/g, '/'));
    } catch {
      /* skip absent optional path */
    }
  }
  return map;
}
