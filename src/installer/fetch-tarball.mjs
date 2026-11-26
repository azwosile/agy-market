// Tamper-proof Streaming Tarball Downloader + China Release Mirror Support (`src/installer/fetch-tarball.mjs`).
// Enforces mandatory SHA-256 verification against the catalog index BEFORE extraction.

import { createHash } from 'node:crypto';
import {
  copyFileSync,
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { CHINA_NPM_MIRRORS, MAX_TARBALL_BYTES } from '../shared/constants.mjs';
import { fileUriToLocalPath } from '../shared/paths.mjs';
import { defaultProxyFetch } from '../shared/proxy-fetch.mjs';
import { inspectTarGzStream } from './tar-extract.mjs';

function resolveEffectiveFetch(fetchImpl) {
  return !fetchImpl || fetchImpl === fetch ? defaultProxyFetch : fetchImpl;
}

function hasMaxBytesLimit(maxBytes) {
  return Number.isFinite(maxBytes) && maxBytes > 0;
}

async function writeChunkToStream(stream, buf, getStreamError) {
  const existingErr = getStreamError();
  if (existingErr) throw existingErr;
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
  const afterErr = getStreamError();
  if (afterErr) throw afterErr;
}

function waitStreamClosed(stream) {
  return new Promise((resolveClose) => {
    if (!stream || stream.closed) {
      resolveClose();
      return;
    }
    stream.once('close', () => resolveClose());
  });
}

async function closeWriteStreamSafe(fileStream, getStreamError) {
  const err = getStreamError();
  if (err) throw err;
  const closedPromise = waitStreamClosed(fileStream);
  await new Promise((resolveEnd, rejectEnd) => {
    const onErr = (e) => rejectEnd(e);
    fileStream.once('error', onErr);
    fileStream.end((endErr) => {
      fileStream.off('error', onErr);
      if (endErr) rejectEnd(endErr);
      else resolveEnd();
    });
  });
  await closedPromise;
  const afterErr = getStreamError();
  if (afterErr) throw afterErr;
}

async function streamLocalFileAndHash(
  srcPath,
  destFilePath = null,
  { maxBytes = MAX_TARBALL_BYTES, requireGzipMagic = true, notGzipError = '' } = {},
) {
  const st = statSync(srcPath);
  if (hasMaxBytesLimit(maxBytes) && st.size > maxBytes) {
    throw new Error(`ERR_DOWNLOAD_TOO_LARGE: Archive exceeds ${maxBytes} bytes`);
  }

  const hash = createHash('sha256');
  const magicBytes = [];
  let magicChecked = !requireGzipMagic;
  let totalBytes = 0;
  let fileStream = null;
  let streamError = null;
  const getStreamError = () => streamError;

  if (destFilePath) {
    mkdirSync(dirname(destFilePath), { recursive: true });
  }

  const readStream = createReadStream(srcPath);
  try {
    for await (const rawChunk of readStream) {
      const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
      if (chunk.length === 0) continue;
      totalBytes += chunk.length;
      if (hasMaxBytesLimit(maxBytes) && totalBytes > maxBytes) {
        throw new Error(`ERR_DOWNLOAD_TOO_LARGE: Archive exceeds ${maxBytes} bytes`);
      }

      if (!magicChecked) {
        for (let i = 0; i < chunk.length && magicBytes.length < 2; i += 1) {
          magicBytes.push(chunk[i]);
        }
        if (magicBytes.length >= 2) {
          if (magicBytes[0] !== 0x1f || magicBytes[1] !== 0x8b) {
            throw new Error(notGzipError || `ERR_NOT_GZIP_ARCHIVE: Local file "${srcPath}" is not a valid gzip tarball`);
          }
          magicChecked = true;
        }
      }

      hash.update(chunk);
      if (destFilePath) {
        if (!fileStream) {
          fileStream = createWriteStream(destFilePath);
          fileStream.on('error', (e) => {
            streamError = e;
          });
        }
        await writeChunkToStream(fileStream, chunk, getStreamError);
      }
    }

    if (!magicChecked) {
      throw new Error(notGzipError || `ERR_NOT_GZIP_ARCHIVE: Local file "${srcPath}" is not a valid gzip tarball`);
    }

    if (destFilePath) {
      if (!fileStream) {
        writeFileSync(destFilePath, Buffer.alloc(0));
      } else {
        await closeWriteStreamSafe(fileStream, getStreamError);
      }
    }

    return { sha256: hash.digest('hex'), bytes: totalBytes };
  } catch (err) {
    if (fileStream) {
      const closedPromise = waitStreamClosed(fileStream);
      fileStream.destroy();
      await closedPromise;
      if (destFilePath) rmSync(destFilePath, { force: true });
    }
    throw err;
  } finally {
    readStream.destroy();
  }
}

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

async function resolveOptionalNpmMirrorTarballUrl(npmMirrorPkg, version, fetchImpl = defaultProxyFetch) {
  if (!npmMirrorPkg || !version) return [];
  const activeFetch = resolveEffectiveFetch(fetchImpl);
  const found = [];
  const encoded = npmMirrorPkg.startsWith('@')
    ? `@${encodeURIComponent(npmMirrorPkg.slice(1))}`
    : encodeURIComponent(npmMirrorPkg);
  for (const mirrorBase of CHINA_NPM_MIRRORS) {
    try {
      const res = await activeFetch(`${mirrorBase}/${encoded}/${encodeURIComponent(version)}`, {
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
  options = {},
) {
  const hasExplicitTimeout = options?.timeoutMs !== undefined && options?.timeoutMs !== null;
  const {
    maxBytes = MAX_TARBALL_BYTES,
    fetchImpl = defaultProxyFetch,
    extraHeaders = null,
    requireGzipMagic = true,
    timeoutMs = 60_000,
  } = options || {};
  const activeFetch = resolveEffectiveFetch(fetchImpl);
  const enforceMaxBytes = hasMaxBytesLimit(maxBytes);
  mkdirSync(dirname(destFilePath), { recursive: true });

  // Support `file://` URLs for deterministic offline tests & enterprise local mirrors
  if (url.startsWith('file://')) {
    const localPath = fileUriToLocalPath(url);
    if (!localPath) throw new Error(`Invalid file:// URL: ${url}`);
    const { sha256, bytes } = await streamLocalFileAndHash(localPath, destFilePath, {
      maxBytes,
      requireGzipMagic,
      notGzipError: `ERR_NOT_GZIP_ARCHIVE: Local file "${url}" is not a valid gzip tarball`,
    });
    return {
      sha256,
      bytes,
      contentDisposition: '',
      contentType: 'application/gzip',
      finalUrl: url,
    };
  }

  const headers = sanitizeDownloadHeaders(url, extraHeaders);
  const effectiveTimeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 60_000;
  const controller = new AbortController();
  let abortTimer = null;
  let rejectAbort = null;
  const abortPromise = new Promise((_, reject) => {
    rejectAbort = reject;
  });
  abortPromise.catch(() => {});

  const onAbort = () => {
    const err =
      controller.signal.reason instanceof Error
        ? controller.signal.reason
        : new DOMException(`The operation was aborted due to timeout (${effectiveTimeoutMs}ms)`, 'TimeoutError');
    rejectAbort?.(err);
  };
  controller.signal.addEventListener('abort', onAbort, { once: true });

  const armOrResetTimer = () => {
    if (abortTimer) clearTimeout(abortTimer);
    abortTimer = setTimeout(() => {
      controller.abort(
        new DOMException(
          hasExplicitTimeout
            ? `Download timed out after ${effectiveTimeoutMs}ms`
            : `Download stalled with no data for ${effectiveTimeoutMs}ms`,
          'TimeoutError',
        ),
      );
    }, effectiveTimeoutMs);
    abortTimer.unref?.();
  };

  armOrResetTimer();

  try {
    const res = await Promise.race([
      activeFetch(url, {
        headers,
        signal: controller.signal,
      }),
      abortPromise,
    ]);
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} downloading ${url}`);
    }

    if (!hasExplicitTimeout) {
      armOrResetTimer();
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
      const getStreamError = () => streamError;

      const openFileStream = () => {
        if (fileStream) return fileStream;
        fileStream = createWriteStream(destFilePath);
        fileStream.on('error', (e) => {
          streamError = e;
        });
        return fileStream;
      };

      try {
        while (true) {
          const { done, value } = await Promise.race([reader.read(), abortPromise]);
          if (done) break;
          if (!hasExplicitTimeout) {
            armOrResetTimer();
          }
          const chunk = Buffer.from(value);
          if (chunk.length === 0) continue;
          totalBytes += chunk.length;
          if (enforceMaxBytes && totalBytes > maxBytes) {
            await reader.cancel().catch(() => {});
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
                await reader.cancel().catch(() => {});
                throw new Error(
                  `ERR_NOT_GZIP_ARCHIVE: Response from ${url} is not a valid gzip tarball (content-type: ${contentType || 'unknown'})`,
                );
              }
              magicChecked = true;
              const stream = openFileStream();
              for (const pending of pendingChunks) {
                await writeChunkToStream(stream, pending, getStreamError);
              }
              pendingChunks.length = 0;
            }
            continue;
          }

          const stream = openFileStream();
          await writeChunkToStream(stream, chunk, getStreamError);
        }
        if (!magicChecked) {
          throw new Error(
            `ERR_NOT_GZIP_ARCHIVE: Response from ${url} is empty or truncated (<2 bytes, content-type: ${contentType || 'unknown'})`,
          );
        }
        if (!fileStream) {
          writeFileSync(destFilePath, Buffer.alloc(0));
        } else {
          await closeWriteStreamSafe(fileStream, getStreamError);
        }
      } catch (err) {
        await reader.cancel().catch(() => {});
        if (fileStream) {
          const closedPromise = waitStreamClosed(fileStream);
          fileStream.destroy();
          await closedPromise;
          rmSync(destFilePath, { force: true });
        }
        throw err;
      }
    } else {
      const ab = await Promise.race([res.arrayBuffer(), abortPromise]);
      const buf = Buffer.from(ab);
      totalBytes = buf.length;
      if (enforceMaxBytes && totalBytes > maxBytes) {
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
  } finally {
    if (abortTimer) clearTimeout(abortTimer);
    controller.signal.removeEventListener('abort', onAbort);
  }
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
  fetchImpl = defaultProxyFetch,
  maxBytes = MAX_TARBALL_BYTES,
  preverifiedArchivePath = '',
}) {
  const activeFetch = resolveEffectiveFetch(fetchImpl);
  const expectedSha256 = String(plugin?.distribution?.sha256 || '')
    .trim()
    .toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(expectedSha256)) {
    throw new Error(`ERR_MISSING_EXPECTED_SHA256: Catalog entry "${plugin?.id}" lacks valid 64-hex sha256`);
  }

  // Zero-redownload fast path: reuse pre-staged inspect archive if its streaming SHA-256 matches `expectedSha256`
  if (preverifiedArchivePath && existsSync(preverifiedArchivePath)) {
    try {
      const stagedInfo = await streamLocalFileAndHash(preverifiedArchivePath, null, {
        maxBytes,
        requireGzipMagic: true,
      });
      if (stagedInfo.sha256.toLowerCase() === expectedSha256) {
        mkdirSync(dirname(stagingArchivePath), { recursive: true });
        copyFileSync(preverifiedArchivePath, stagingArchivePath);
        return {
          archivePath: stagingArchivePath,
          sha256: stagedInfo.sha256,
          bytes: stagedInfo.bytes,
          channelUsed: 'staged-inspect',
          urlUsed: preverifiedArchivePath,
        };
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
      activeFetch,
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
        fetchImpl: activeFetch,
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
          fetchImpl: activeFetch,
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
            meta = await inspectTarGzStream(stagingArchivePath, {
              maxUncompressedBytes: maxBytes,
              stripSingleTopDir: true,
              pluginRoot: plugin?.repository?.pluginRoot || '.',
              shouldBufferFile: () => false,
            });
          } catch (parseErr) {
            rmSync(stagingArchivePath, { force: true });
            const parseMsg = parseErr?.message || String(parseErr);
            if (parseMsg.includes('ERR_TAR_SYMLINK_FORBIDDEN')) {
              throw parseErr;
            }
            throw new Error(
              `INTEGRITY_SHA256_MISMATCH: Failed to verify commit-fallback archive PAX header (${parseMsg})`,
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
