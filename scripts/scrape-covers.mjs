#!/usr/bin/env node
import { mkdir, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMainModule } from '../src/shared/paths.mjs';

const pagesFeed = 'https://azwosile.github.io/agy-market-catalog/index.json';
const rawFeed = 'https://raw.githubusercontent.com/azwosile/agy-market-catalog/gh-pages/index.json';
const coversDir = fileURLToPath(new URL('../site/assets/covers/', import.meta.url));
const maxImageBytes = 3 * 1024 * 1024;
const imageExtensions = {
  'image/svg+xml': 'svg', 'image/png': 'png', 'image/jpeg': 'jpg',
  'image/webp': 'webp', 'image/gif': 'gif', 'image/avif': 'avif',
};
const coverFilename = /^[a-z0-9_-]+\.(?:svg|png|jpg|webp|gif|avif)$/i;

async function request(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (response.status === 200) return response;
    await response.body?.cancel();
  } catch {
    // A missing or unreachable candidate leaves the next source available.
  }
}

async function getCatalog() {
  for (const url of [pagesFeed, rawFeed]) {
    try {
      const catalog = await (await request(url))?.json();
      if (Array.isArray(catalog?.plugins)) return catalog.plugins;
    } catch {
      // Retry an invalid Pages response via GitHub Raw.
    }
  }
  throw new Error('Unable to load the AGY Market catalog from Pages or GitHub Raw.');
}

function attribute(tag, name) {
  const match = tag.match(new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'));
  return match?.[1] ?? match?.[2] ?? match?.[3] ?? '';
}

function readmeImages(markdown) {
  const references = new Map([...markdown.matchAll(/^ {0,3}\[([^\]\n]+)\]:\s*(?:<([^>\n]+)>|(\S+))/gm)]
    .map(([, key, bracketed, bare]) => [key.toLowerCase(), bracketed || bare]));
  return [
    ...[...markdown.matchAll(/!\[([^\]]*)\]\(\s*(?:<([^>\n]+)>|((?:[^\s()]|\([^\s()]*\))+))/g)]
      .map(([, label, bracketed, bare]) => [bracketed || bare, label]),
    ...[...markdown.matchAll(/!\[([^\]]*)\]\[([^\]]*)\]/g)]
      .map(([, label, key]) => [references.get((key || label).toLowerCase()), label]),
    ...[...markdown.matchAll(/<img\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi)].map(([tag]) => {
      const dimensions = ['width', 'height'].map((name) => attribute(tag, name));
      if (dimensions.some((value) => /^\d+(?:px)?$/i.test(value) && parseInt(value, 10) <= 48)) return [];
      return [attribute(tag, 'src'), attribute(tag, 'alt')];
    }),
  ];
}

function imageCandidate(source, label, base, isLogo) {
  if (!source) return;
  let url;
  try {
    url = new URL(source.replaceAll('&amp;', '&'), base);
  } catch {
    return;
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return;
  if (url.hostname === 'github.com') {
    const blob = url.pathname.match(/^\/([^/]+\/[^/]+)\/blob\/(.+)$/);
    if (blob) url = new URL(`https://raw.githubusercontent.com/${blob[1]}/${blob[2]}`);
  }
  url.hash = '';
  const hint = `${url.hostname}${url.pathname.replaceAll('%20', ' ')} ${label}`;
  const logo = isLogo || /(?:^|[\W_])logo(?:[\W_]|$)/i.test(hint);
  if (/shields\.io|badgen\.net|img\.badge|star[-_ ]?history|badges?\b|favicon|\b(?:license|ci status|build status)\b/i.test(hint)
    || (!logo && /(?:^|[\W_])icons?(?:[\W_]|$)/i.test(hint))) return;
  const score = logo ? 0 : /dark|screenshot|demo|mockup|截图|演示/i.test(hint) ? 4 : /hero[-_ ]light/i.test(hint) ? 2 : /hero|banner|preview/i.test(hint) ? 3 : 1;
  return { url: url.href, score, kind: logo ? 'logo' : 'cover' };
}

async function getText(url) {
  try {
    return await (await request(url))?.text() || '';
  } catch {
    return '';
  }
}

async function scanBranch(base) {
  const [readmeZh, readme, manifest] = await Promise.all([
    getText(new URL('README.zh-CN.md', base)),
    getText(new URL('README.md', base)),
    getText(new URL('plugin.json', base)),
  ]);
  const candidates = [
    ...readmeImages(readmeZh),
    ...readmeImages(readme),
    ['assets/readme/hero-dark.svg', 'hero-dark'],
    ['assets/readme/hero-light.svg', 'hero-light'],
  ];
  try {
    const { logo } = JSON.parse(manifest);
    if (typeof logo === 'string') candidates.push([logo, 'logo', true]);
  } catch {
    // README and conventional paths work without a repository manifest.
  }
  return candidates.map(([source, label, logo]) => imageCandidate(source, label, base, logo)).filter(Boolean);
}

function svgDimensions(data) {
  const svg = data.toString('utf8');
  const root = svg.match(/^\s*(?:<\?xml\s+[^?]*\?>\s*)?(?:<!--[\s\S]*?-->\s*)*(<svg\b[^>]*>)/i)?.[1];
  // SVG assets are served from the showcase's origin. Reject active content and
  // XML entities, and allow references only to fragments or embedded raster images.
  if (!root || /<!\s*(?:DOCTYPE|ENTITY)|<\?(?!xml\s)|<(?:[\w.-]+:)?(?:script|foreignObject|iframe|object|embed|a|animate\w*|set|discard|link|handler|listener)\b|\s(?:src|on[\w:-]+)\s*=|@import|\\/i.test(svg)) return;
  if ([...svg.matchAll(/\b(?:href|url)\s*(?:=\s*["']|\(\s*["']?)([^"'\s)]+)/gi)]
    .some(([, value]) => !/^(?:#|data:image\/(?:png|jpeg|gif|webp);base64,)/i.test(value))) return;
  const viewBox = attribute(root, 'viewBox').trim().split(/[ ,]+/).map(Number);
  const width = Number(attribute(root, 'width').replace(/px$/i, '')) || viewBox[2];
  const height = Number(attribute(root, 'height').replace(/px$/i, '')) || viewBox[3];
  return [width, height];
}

function rasterDimensions(data, ext) {
  if (ext === 'png' && data.length >= 24 && data.subarray(0, 8).toString('hex') === '89504e470d0a1a0a') {
    return [data.readUInt32BE(16), data.readUInt32BE(20)];
  }
  if (ext === 'gif' && data.length >= 10 && /^GIF8[79]a$/.test(data.toString('ascii', 0, 6))) {
    return [data.readUInt16LE(6), data.readUInt16LE(8)];
  }
  if (ext === 'jpg' && data.readUInt16BE(0) === 0xffd8) {
    for (let i = 2; i + 8 < data.length && data[i] === 0xff;) {
      const marker = data[i + 1];
      if ([0xc0, 0xc1, 0xc2, 0xc3].includes(marker)) {
        return [data.readUInt16BE(i + 7), data.readUInt16BE(i + 5)];
      }
      const length = data.readUInt16BE(i + 2);
      if (length < 2 || marker === 0xda) break;
      i += 2 + length;
    }
  }
  if (ext === 'webp' && data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP') {
    const chunk = data.toString('ascii', 12, 16);
    if (chunk === 'VP8X' && data.length >= 30) return [1 + data.readUIntLE(24, 3), 1 + data.readUIntLE(27, 3)];
    if (chunk === 'VP8L' && data.length >= 25 && data[20] === 0x2f) {
      const bits = data.readUInt32LE(21);
      return [1 + (bits & 0x3fff), 1 + ((bits >>> 14) & 0x3fff)];
    }
    if (chunk === 'VP8 ' && data.length >= 30) return [data.readUInt16LE(26) & 0x3fff, data.readUInt16LE(28) & 0x3fff];
  }
  if (ext === 'avif' && data.toString('ascii', 4, 12) === 'ftypavif') {
    const properties = data.indexOf('ispe', 12);
    if (properties > 0 && properties + 16 <= data.length) return [data.readUInt32BE(properties + 8), data.readUInt32BE(properties + 12)];
  }
}

async function downloadImage(candidate) {
  const response = await request(candidate.url);
  if (!response?.body) return;
  const type = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
  let ext = Object.hasOwn(imageExtensions, type) ? imageExtensions[type] : undefined;
  if (!ext && (!type || type === 'text/plain' || type === 'application/octet-stream')) {
    // GitHub Raw sometimes serves repository images as generic binary or text.
    ext = new URL(candidate.url).pathname.match(/\.(svg|png|jpe?g|webp|gif|avif)$/i)?.[1].toLowerCase().replace('jpeg', 'jpg');
  }
  if (!ext || Number(response.headers.get('content-length')) > maxImageBytes) {
    await response.body.cancel();
    return;
  }
  const chunks = [];
  let length = 0;
  for await (const chunk of response.body) {
    length += chunk.length;
    if (length > maxImageBytes) return;
    chunks.push(chunk);
  }
  const data = Buffer.concat(chunks, length);
  if (data.length < 12) return;
  const dimensions = ext === 'svg' ? svgDimensions(data) : rasterDimensions(data, ext);
  if (!dimensions) return;
  const [width, height] = dimensions;
  if ((Number.isFinite(width) && width <= 48) || (Number.isFinite(height) && height <= 48)) return;
  const kind = (Number.isFinite(width) && width === height) || candidate.kind === 'logo' ? 'logo' : 'cover';
  return { ext, kind, data };
}

export async function scrapePlugin(plugin) {
  const repository = plugin.repository;
  if (typeof repository?.url !== 'string') return;
  const repo = repository.url.match(/^https?:\/\/github\.com\/([a-z0-9_.-]+)\/([a-z0-9_.-]+)(?:\/|$)/i);
  if (!repo) return;
  const roots = [repository.pluginRoot, repository.subpath, plugin.pluginRoot, plugin.subpath];
  const root = roots.find((value) => typeof value === 'string' && value.trim() && value.trim() !== '.') || '';
  const subpath = root.trim().split(/[\\/]+/).filter((part) => part && part !== '.');
  if (subpath.includes('..')) return;
  const rawRepo = `https://raw.githubusercontent.com/${repo[1]}/${repo[2].replace(/\.git$/i, '')}`;
  const branchCandidates = await Promise.all(['main', 'master'].map((branch) => (
    scanBranch(`${rawRepo}/${branch}/${subpath.length ? subpath.map(encodeURIComponent).join('/') + '/' : ''}`)
  )));
  const candidates = branchCandidates.flat().sort((a, b) => b.score - a.score);
  const seen = new Set();
  for (const candidate of candidates) {
    if (seen.has(candidate.url)) continue;
    seen.add(candidate.url);
    const image = await downloadImage(candidate).catch(() => undefined);
    if (image) return image;
  }
}

async function main() {
  const plugins = await getCatalog();
  await mkdir(coversDir, { recursive: true });
  const entries = [];
  for (let offset = 0; offset < plugins.length; offset += 4) {
    const batch = await Promise.all(plugins.slice(offset, offset + 4).map(async (plugin) => {
      const id = plugin?.id;
      if (typeof id !== 'string' || !/^[a-z0-9_-]+$/i.test(id)) return;
      if (id === 'azwosile__agy-market') return [id, { src: './assets/logo.png', kind: 'logo' }];
      const image = await scrapePlugin(plugin);
      if (!image) {
        console.log(`[covers] ${id}: SVG scene fallback`);
        return;
      }
      const file = `${id}.${image.ext}`;
      await writeFile(join(coversDir, file + '.tmp'), image.data);
      await rename(join(coversDir, file + '.tmp'), join(coversDir, file));
      console.log(`[covers] ${id}: ${image.kind} (${file})`);
      return [id, { src: `./assets/covers/${file}`, kind: image.kind }];
    }));
    entries.push(...batch.filter(Boolean));
  }
  await writeFile(join(coversDir, 'manifest.json.tmp'), JSON.stringify(Object.fromEntries(entries), null, 2) + '\n');
  await rename(join(coversDir, 'manifest.json.tmp'), join(coversDir, 'manifest.json'));

  const currentFiles = new Set(entries.map(([, { src }]) => src.slice('./assets/covers/'.length)));
  for (const file of await readdir(coversDir)) {
    if (coverFilename.test(file) && !currentFiles.has(file)) await unlink(join(coversDir, file));
  }
  console.log(`[covers] ${entries.length}/${plugins.length} catalog entries have images.`);
}

if (isMainModule(import.meta.url)) await main();
