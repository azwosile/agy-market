// Tamper-proof Streaming Tarball Downloader + China Release Mirror Support (`src/installer/fetch-tarball.mjs`).
// Enforces mandatory SHA-256 verification against the catalog index BEFORE extraction.

import { createHash } from 'node:crypto';
import { copyFileSync, createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { CHINA_NPM_MIRRORS, MAX_TARBALL_BYTES } from '../shared/constants.mjs';
import { fileUriToLocalPath } from '../shared/paths.mjs';
import { parseTarGzWithMeta } from './tar-extract.mjs';

const OFFICIAL_GITHUB_TOKEN_HOSTS = new Set([
  'github.com',
  'www.github.com',
  'codeload.github.com',
  'api.github.com',
]);

const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO_RE = /^[A-Za-z0-9._-]+$/;
const FULL_COMMIT_SHA_RE = /^[0-9a-f]{40}$/i;
const FULL_SHA256_RE = /^[0-9a-f]{64}$/i;

export function isOfficialGithubTokenHost(rawUrl) {
  try {
    const u = new URL(String(rawUrl || ''));
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
    return OFFICIAL_GITHUB_TOKEN_HOSTS.has(u.hostname.toLowerCase());
  } catch {
    return false;
  }
}

export function resolveMutableTagCommitFallbackUrl(plugin) {
  const rawUrl = String(plugin?.distribution?.tarballUrl || '').trim();
  const m = /^https:\/\/github\.com\/([^/?#]+)\/([^/?#]+)\/archive\/refs\/tags\/[^/?#]+\.tar\.gz$/i.exec(rawUrl);
  if (!m) return null;
  const owner = m[1];
  const repo = m[2];
  if (!OWNER_RE.test(owner)) return null;
  if (!repo || repo === '.' || repo === '..' || !REPO_RE.test(repo)) return null;
  const commitSha = String(plugin?.commitSha || '').trim();
  if (!FULL_COMMIT_SHA_RE.test(commitSha)) return null;
  return `https://github.com/${owner}/${repo}/archive/${commitSha.toLowerCase()}.tar.gz`;
}

export function buildCandidateDownloadUrls(plugin, prefs = {}) {
  const dist = plugin?.distribution || {};
  const rawUrl = String(dist.tarballUrl || '').trim();
  if (!rawUrl) {
    throw new Error(`ERR_NO_TARBALL_URL: Plugin "${plugin?.id}" has no distribution.tarballUrl`);
  }

  const urls = [];
  const mirrorPrefix = String(prefs.githubReleaseMirrorPrefix || '').trim();

  if (mirrorPrefix && /^https:\/\/(?:github\.com|codeload\.github\.com)\//i.test(rawUrl)) {
    const normalizedPrefix = mirrorPrefix.endsWith('/') ? mirrorPrefix : `${mirrorPrefix}/`;
    const mirrored = `${normalizedPrefix}${rawUrl}`;
    urls.push({ url: mirrored, channel: 'github-mirror' });
  }

  urls.push({ url: rawUrl, channel: 'direct' });

  return urls;
}

async function resolveOptionalNpmMirrorTarballUrl(npmMirrorPkg, version, fetchImpl = fetch) {
  if (!npmMirrorPkg || !version) return [];
  const found = [];
  const encoded = npmMirrorPkg.startsWith('@')
    ? `@${encodeURIComponent(npmMirrorPkg.slice(1))}`
    : encodeURIComponent(npmMirrorPkg);
  for (const mirrorBase of CHINA_NPM_MIRRORS) {
    try {
      const res = await fetchImpl(`${mirrorBase}/${encoded}/${encodeURIComponent(version)}`, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(4000),
      });
      if (!res.ok) continue;
      const meta = await res.json();
      if (meta?.dist?.tarball) {
        found.push({ url: meta.dist.tarball, channel: 'npm-mirror' });
      }
    } catch {
      /* try next mirror */
    }
  }
  return found;
}

function sanitizeDownloadHeaders(url, extraHeaders = null) {
  const headers = { 'User-Agent': 'agy-market-installer/1.0' };
  const allowAuth = isOfficialGithubTokenHost(url);
  if (extraHeaders && typeof extraHeaders === 'object') {
    for (const [k, v] of Object.entries(extraHeaders)) {
      if (v === undefined || v === null || v === '') continue;
      if (k.toLowerCase() === 'authorization' && !allowAuth) {
        // Never leak Authorization tokens to third-party mirror proxies or non-GitHub hosts
        continue;
      }
      headers[k] = String(v);
    }
  }
  return headers;
}

export async function streamUrlToFileAndHash(
  url,
  destFilePath,
  { maxBytes = MAX_TARBALL_BYTES, fetchImpl = fetch, extraHeaders = null, requireGzipMagic = true, timeoutMs = 60_000 } = {},
) {
  mkdirSync(dirname(destFilePath), { recursive: true });

  // Support `file://` URLs for deterministic offline tests & enterprise local mirrors
  if (url.startsWith('file://')) {
    const localPath = fileUriToLocalPath(url);
    if (!localPath) throw new Error(`Invalid file:// URL: ${url}`);
    const buf = readFileSync(localPath);
    if (buf.length > maxBytes) {
      throw new Error(`ERR_DOWNLOAD_TOO_LARGE: Archive exceeds ${maxBytes} bytes`);
    }
    if (requireGzipMagic && (buf.length < 2 || buf[0] !== 0x1f || buf[1] !== 0x8b)) {
      throw new Error(`ERR_NOT_GZIP_ARCHIVE: Local file "${url}" is not a valid gzip tarball`);
    }
    const sha256 = createHash('sha256').update(buf).digest('hex');
    writeFileSync(destFilePath, buf);
    return {
      sha256,
      bytes: buf.length,
      contentDisposition: '',
      contentType: 'application/gzip',
      finalUrl: url,
    };
  }

  const headers = sanitizeDownloadHeaders(url, extraHeaders);
  const res = await fetchImpl(url, {
    headers,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} downloading ${url}`);
  }

  const contentDisposition = String(res.headers?.get?.('content-disposition') || '');
  const contentType = String(res.headers?.get?.('content-type') || '');
  const finalUrl = String(res.url || url);

  const hash = createHash('sha256');
  let totalBytes = 0;

  if (res.body && typeof res.body.getReader === 'function') {
    const reader = res.body.getReader();
    const magicBytes = [];
    const pendingChunks = [];
    let magicChecked = !requireGzipMagic;
    let fileStream = null;
    let streamError = null;

    const waitStreamClosed = (stream) =>
      new Promise((resolveClose) => {
        if (!stream || stream.closed) {
          resolveClose();
          return;
        }
        stream.once('close', () => resolveClose());
      });

    const openFileStream = () => {
      if (fileStream) return fileStream;
      fileStream = createWriteStream(destFilePath);
      fileStream.on('error', (e) => {
        streamError = e;
      });
      return fileStream;
    };

    const writeChunk = async (stream, buf) => {
      if (streamError) throw streamError;
      if (!stream.write(buf)) {
        await new Promise((resolveDrain, rejectDrain) => {
          const onDrain = () => {
            stream.off('error', onErr);
            resolveDrain();
          };
          const onErr = (e) => {
            stream.off('drain', onDrain);
            rejectDrain(e);
          };
          stream.once('drain', onDrain);
          stream.once('error', onErr);
        });
      }
      if (streamError) throw streamError;
    };

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = Buffer.from(value);
        if (chunk.length === 0) continue;
        totalBytes += chunk.length;
        if (totalBytes > maxBytes) {
          await reader.cancel();
          throw new Error(`ERR_DOWNLOAD_TOO_LARGE: Archive exceeds ${maxBytes} bytes`);
        }
        hash.update(chunk);

        if (!magicChecked) {
          pendingChunks.push(chunk);
          for (let i = 0; i < chunk.length && magicBytes.length < 2; i += 1) {
            magicBytes.push(chunk[i]);
          }
          if (magicBytes.length >= 2) {
            if (magicBytes[0] !== 0x1f || magicBytes[1] !== 0x8b) {
              await reader.cancel();
              throw new Error(
                `ERR_NOT_GZIP_ARCHIVE: Response from ${url} is not a valid gzip tarball (content-type: ${contentType || 'unknown'})`,
              );
            }
            magicChecked = true;
            const stream = openFileStream();
            for (const pending of pendingChunks) {
              await writeChunk(stream, pending);
            }
            pendingChunks.length = 0;
          }
          continue;
        }

        const stream = openFileStream();
        await writeChunk(stream, chunk);
      }
      if (!magicChecked) {
        throw new Error(
          `ERR_NOT_GZIP_ARCHIVE: Response from ${url} is empty or truncated (<2 bytes, content-type: ${contentType || 'unknown'})`,
        );
      }
      if (!fileStream) {
        writeFileSync(destFilePath, Buffer.alloc(0));
      } else {
        if (streamError) throw streamError;
        const closedPromise = waitStreamClosed(fileStream);
        await new Promise((resolveEnd, rejectEnd) => {
          const onErr = (e) => rejectEnd(e);
          fileStream.once('error', onErr);
          fileStream.end((err) => {
            fileStream.off('error', onErr);
            if (err) rejectEnd(err);
            else resolveEnd();
          });
        });
        await closedPromise;
        if (streamError) throw streamError;
      }
    } catch (err) {
      if (fileStream) {
        const closedPromise = waitStreamClosed(fileStream);
        fileStream.destroy();
        await closedPromise;
        rmSync(destFilePath, { force: true });
      }
      throw err;
    }
  } else {
    const buf = Buffer.from(await res.arrayBuffer());
    totalBytes = buf.length;
    if (totalBytes > maxBytes) {
      throw new Error(`ERR_DOWNLOAD_TOO_LARGE: Archive exceeds ${maxBytes} bytes`);
    }
    if (requireGzipMagic && (buf.length < 2 || buf[0] !== 0x1f || buf[1] !== 0x8b)) {
      throw new Error(
        `ERR_NOT_GZIP_ARCHIVE: Response from ${url} is not a valid gzip tarball (content-type: ${contentType || 'unknown'})`,
      );
    }
    hash.update(buf);
    writeFileSync(destFilePath, buf);
  }

  return {
    sha256: hash.digest('hex'),
    bytes: totalBytes,
    contentDisposition,
    contentType,
    finalUrl,
  };
}

/**
 * Downloads `plugin` tarball to `stagingArchivePath` and strictly enforces `plugin.distribution.sha256`.
 * When `preverifiedArchivePath` exists and matches `expectedSha256`, copies locally (`channelUsed: 'staged-inspect'`)
 * with zero redundant network downloads.
 * Deletes staging directory immediately on any digest mismatch (`INTEGRITY_SHA256_MISMATCH`).
 */
export async function fetchVerifiedPluginTarball({
  plugin,
  stagingDir,
  stagingArchivePath,
  prefs = {},
  fetchImpl = fetch,
  maxBytes = MAX_TARBALL_BYTES,
  preverifiedArchivePath = '',
}) {
  const expectedSha256 = String(plugin?.distribution?.sha256 || '')
    .trim()
    .toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(expectedSha256)) {
    throw new Error(`ERR_MISSING_EXPECTED_SHA256: Catalog entry "${plugin?.id}" lacks valid 64-hex sha256`);
  }

  // Zero-redownload fast path: reuse pre-staged inspect archive if its SHA-256 matches `expectedSha256`
  if (preverifiedArchivePath && existsSync(preverifiedArchivePath)) {
    try {
      const stagedBuf = readFileSync(preverifiedArchivePath);
      if (
        stagedBuf.length >= 2 &&
        stagedBuf.length <= maxBytes &&
        stagedBuf[0] === 0x1f &&
        stagedBuf[1] === 0x8b
      ) {
        const stagedSha = createHash('sha256').update(stagedBuf).digest('hex');
        if (stagedSha.toLowerCase() === expectedSha256) {
          mkdirSync(dirname(stagingArchivePath), { recursive: true });
          copyFileSync(preverifiedArchivePath, stagingArchivePath);
          return {
            archivePath: stagingArchivePath,
            sha256: stagedSha,
            bytes: stagedBuf.length,
            channelUsed: 'staged-inspect',
            urlUsed: preverifiedArchivePath,
          };
        }
      }
    } catch {
      /* fall back to network candidates */
    }
  }

  const candidates = buildCandidateDownloadUrls(plugin, prefs);
  if (plugin?.distribution?.npmMirrorPkg) {
    const npmCandidates = await resolveOptionalNpmMirrorTarballUrl(
      plugin.distribution.npmMirrorPkg,
      plugin.version,
      fetchImpl,
    );
    candidates.push(...npmCandidates);
  }

  const githubToken = typeof prefs?.githubToken === 'string' ? prefs.githubToken.trim() : '';
  const errors = [];
  let directOfficialDriftOrMissing = false;
  for (const cand of candidates) {
    const isDirectOfficialGithub = cand.channel === 'direct' && /^https:\/\/github\.com\//i.test(cand.url);
    try {
      const extraHeaders =
        githubToken && cand.channel !== 'github-mirror' && isOfficialGithubTokenHost(cand.url)
          ? { Authorization: `Bearer ${githubToken}` }
          : null;
      const { sha256, bytes } = await streamUrlToFileAndHash(cand.url, stagingArchivePath, {
        maxBytes,
        fetchImpl,
        extraHeaders,
      });

      if (sha256.toLowerCase() !== expectedSha256) {
        rmSync(stagingArchivePath, { force: true });
        if (isDirectOfficialGithub) {
          directOfficialDriftOrMissing = true;
        }
        const msg = `INTEGRITY_SHA256_MISMATCH: Expected ${expectedSha256}, got ${sha256} from ${cand.channel} (${cand.url})`;
        errors.push(msg);
        // Try next candidate channel (e.g., if a user-configured mirror returned a captive-portal HTML page or tampered payload!)
        continue;
      }

      return {
        archivePath: stagingArchivePath,
        sha256,
        bytes,
        channelUsed: cand.channel,
        urlUsed: cand.url,
      };
    } catch (err) {
      rmSync(stagingArchivePath, { force: true });
      const errMsg = err?.message || String(err);
      if (isDirectOfficialGithub && /\bHTTP 404\b/.test(errMsg)) {
        directOfficialDriftOrMissing = true;
      }
      errors.push(`${cand.channel} (${cand.url}): ${errMsg}`);
    }
  }

  if (directOfficialDriftOrMissing) {
    const commitFallbackUrl = resolveMutableTagCommitFallbackUrl(plugin);
    if (commitFallbackUrl) {
      try {
        const fallbackHeaders =
          githubToken && isOfficialGithubTokenHost(commitFallbackUrl)
            ? { Authorization: `Bearer ${githubToken}` }
            : null;
        const { sha256, bytes } = await streamUrlToFileAndHash(commitFallbackUrl, stagingArchivePath, {
          maxBytes,
          fetchImpl,
          extraHeaders: fallbackHeaders,
        });

        const rawExpectedCommitFallbackSha = String(plugin?.distribution?.commitFallbackSha256 || '')
          .trim()
          .toLowerCase();
        if (rawExpectedCommitFallbackSha) {
          if (
            !FULL_SHA256_RE.test(rawExpectedCommitFallbackSha) ||
            sha256.toLowerCase() !== rawExpectedCommitFallbackSha
          ) {
            rmSync(stagingArchivePath, { force: true });
            throw new Error(
              `INTEGRITY_SHA256_MISMATCH: Expected commitFallbackSha256 ${rawExpectedCommitFallbackSha}, got ${sha256} from github-commit-fallback (${commitFallbackUrl})`,
            );
          }
        } else {
          const expectedCommitSha = String(plugin?.commitSha || '').trim().toLowerCase();
          let meta;
          try {
            meta = parseTarGzWithMeta(readFileSync(stagingArchivePath), {
              maxUncompressedBytes: maxBytes,
              stripSingleTopDir: false,
            });
          } catch (parseErr) {
            rmSync(stagingArchivePath, { force: true });
            throw new Error(
              `INTEGRITY_SHA256_MISMATCH: Failed to verify commit-fallback archive PAX header (${parseErr?.message || String(parseErr)})`,
            );
          }
          const paxComment = String(meta?.globalPax?.comment || '').trim().toLowerCase();
          if (!FULL_COMMIT_SHA_RE.test(paxComment) || paxComment !== expectedCommitSha) {
            rmSync(stagingArchivePath, { force: true });
            throw new Error(
              `INTEGRITY_SHA256_MISMATCH: Commit fallback archive PAX comment "${paxComment || 'missing'}" does not match locked commitSha ${expectedCommitSha}`,
            );
          }
        }

        return {
          archivePath: stagingArchivePath,
          sha256,
          bytes,
          channelUsed: 'github-commit-fallback',
          urlUsed: commitFallbackUrl,
        };
      } catch (err) {
        rmSync(stagingArchivePath, { force: true });
        errors.push(`github-commit-fallback (${commitFallbackUrl}): ${err?.message || String(err)}`);
      }
    }
  }

  const joined = errors.join(' | ');
  rmSync(stagingDir, { recursive: true, force: true });
  if (joined.includes('INTEGRITY_SHA256_MISMATCH')) {
    throw new Error(joined);
  }
  throw new Error(`ERR_TARBALL_DOWNLOAD_FAILED: ${joined}`);
}
