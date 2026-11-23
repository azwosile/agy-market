#!/usr/bin/env node
// Deterministic GitHub Release Tarball Builder (`scripts/pack-release.mjs`).
// Produces `dist/agy-market.tar.gz` + `dist/agy-market.tar.gz.sha256` with 10-field manifest verification.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { collectDirectoryFilesMap, createDeterministicTarGz } from '../src/installer/tar-extract.mjs';
import { PLUGIN_JSON_ALLOWED_KEYS } from '../src/shared/constants.mjs';
import { parseJsonc } from '../src/shared/schemas.mjs';
import { buildMarketSidecarHtml } from './build.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');

export async function packReleaseBundle({ outDir = join(repoRoot, 'dist') } = {}) {
  await buildMarketSidecarHtml();

  const manifest = parseJsonc(readFileSync(join(repoRoot, 'plugin.json'), 'utf8'));
  for (const key of Object.keys(manifest)) {
    if (!PLUGIN_JSON_ALLOWED_KEYS.has(key)) {
      throw new Error(`ERR_MANIFEST_PURITY: Unknown top-level key "${key}" in plugin.json`);
    }
  }

  const filesMap = collectDirectoryFilesMap(
    repoRoot,
    [
      'plugin.json',
      'agy-market.json',
      'package.json',
      'README.md',
      'LICENSE',
      'assets',
      'bin',
      'scripts',
      'sidecars',
      'skills',
      'src',
    ],
    {
      excludeFilter: (rel) => rel.includes('node_modules') || rel.endsWith('.tmp') || rel.endsWith('.gitkeep'),
    },
  );

  if (!filesMap.has('sidecars/market_pane/index.html')) {
    throw new Error('Missing built sidecars/market_pane/index.html in release archive');
  }

  const gzBuf = createDeterministicTarGz(filesMap);
  const sha256 = createHash('sha256').update(gzBuf).digest('hex');

  mkdirSync(outDir, { recursive: true });
  const tarPath = join(outDir, 'agy-market.tar.gz');
  const shaPath = join(outDir, 'agy-market.tar.gz.sha256');
  writeFileSync(tarPath, gzBuf);
  writeFileSync(shaPath, `${sha256}  agy-market.tar.gz\n`, 'utf8');

  return {
    tarPath,
    shaPath,
    sha256,
    sizeBytes: gzBuf.length,
    fileCount: filesMap.size,
    exists: existsSync(tarPath),
  };
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1] || '')).href) {
  const res = await packReleaseBundle();
  console.log(
    `[pack:release] Created ${res.tarPath} (${res.sizeBytes} bytes, ${res.fileCount} files, sha256=${res.sha256})`,
  );
}
