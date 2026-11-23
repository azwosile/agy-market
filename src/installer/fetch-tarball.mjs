// Tamper-proof Streaming Tarball Downloader + China Release Mirror Support (`src/installer/fetch-tarball.mjs`).
// Enforces mandatory SHA-256 verification against the catalog index BEFORE extraction.

import { createHash } from 'node:crypto';
import { createWriteStream, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { CHINA_NPM_MIRRORS, MAX_TARBALL_BYTES } from '../shared/constants.mjs';
import { fileUriToLocalPath } from '../shared/paths.mjs';

export function buildCandidateDownloadUrls(plugin, prefs = {}) {
  const dist = plugin?.distribution || {};
  const rawUrl = String(dist.tarballUrl || '').trim();
  if (!rawUrl) {
    throw new Error(`ERR_NO_TARBALL_URL: Plugin "${plugin?.id}" has no distribution.tarballUrl`);
  }

  const urls = [];
  const mirrorPrefix = String(prefs.githubReleaseMirrorPrefix || '').trim();

  if (mirrorPrefix && /^https:\/\/github\.com\//i.test(rawUrl)) {
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

async function streamUrlToFileAndHash(url, destFilePath, { maxBytes = MAX_TARBALL_BYTES, fetchImpl = fetch } = {}) {
  mkdirSync(dirname(destFilePath), { recursive: true });

  // Support `file://` URLs for deterministic offline tests & enterprise local mirrors
  if (url.startsWith('file://')) {
    const localPath = fileUriToLocalPath(url);
    if (!localPath) throw new Error(`Invalid file:// URL: ${url}`);
    const buf = readFileSync(localPath);
    if (buf.length > maxBytes) {
      throw new Error(`ERR_DOWNLOAD_TOO_LARGE: Archive exceeds ${maxBytes} bytes`);
    }
    const sha256 = createHash('sha256').update(buf).digest('hex');
    writeFileSync(destFilePath, buf);
    return { sha256, bytes: buf.length };
  }

  const res = await fetchImpl(url, {
    headers: { 'User-Agent': 'agy-market-installer/1.0' },
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} downloading ${url}`);
  }

  const hash = createHash('sha256');
  let totalBytes = 0;

  if (res.body && typeof res.body.getReader === 'function') {
    const fileStream = createWriteStream(destFilePath);
    const reader = res.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = Buffer.from(value);
        totalBytes += chunk.length;
        if (totalBytes > maxBytes) {
          await reader.cancel();
          throw new Error(`ERR_DOWNLOAD_TOO_LARGE: Archive exceeds ${maxBytes} bytes`);
        }
        hash.update(chunk);
        if (!fileStream.write(chunk)) {
          await new Promise((r) => fileStream.once('drain', r));
        }
      }
      await new Promise((resolvePromise, rejectPromise) => {
        fileStream.end((err) => (err ? rejectPromise(err) : resolvePromise()));
      });
    } catch (err) {
      fileStream.destroy();
      rmSync(destFilePath, { force: true });
      throw err;
    }
  } else {
    const buf = Buffer.from(await res.arrayBuffer());
    totalBytes = buf.length;
    if (totalBytes > maxBytes) {
      throw new Error(`ERR_DOWNLOAD_TOO_LARGE: Archive exceeds ${maxBytes} bytes`);
    }
    hash.update(buf);
    writeFileSync(destFilePath, buf);
  }

  return { sha256: hash.digest('hex'), bytes: totalBytes };
}

/**
 * Downloads `plugin` tarball to `stagingArchivePath` and strictly enforces `plugin.distribution.sha256`.
 * Deletes staging directory immediately on any digest mismatch (`INTEGRITY_SHA256_MISMATCH`).
 */
export async function fetchVerifiedPluginTarball({
  plugin,
  stagingDir,
  stagingArchivePath,
  prefs = {},
  fetchImpl = fetch,
  maxBytes = MAX_TARBALL_BYTES,
}) {
  const expectedSha256 = String(plugin?.distribution?.sha256 || '')
    .trim()
    .toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(expectedSha256)) {
    throw new Error(`ERR_MISSING_EXPECTED_SHA256: Catalog entry "${plugin?.id}" lacks valid 64-hex sha256`);
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

  const errors = [];
  for (const cand of candidates) {
    try {
      const { sha256, bytes } = await streamUrlToFileAndHash(cand.url, stagingArchivePath, {
        maxBytes,
        fetchImpl,
      });

      if (sha256.toLowerCase() !== expectedSha256) {
        rmSync(stagingArchivePath, { force: true });
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
      errors.push(`${cand.channel} (${cand.url}): ${err?.message || String(err)}`);
    }
  }

  rmSync(stagingDir, { recursive: true, force: true });
  const joined = errors.join(' | ');
  if (joined.includes('INTEGRITY_SHA256_MISMATCH')) {
    throw new Error(joined);
  }
  throw new Error(`ERR_TARBALL_DOWNLOAD_FAILED: ${joined}`);
}
