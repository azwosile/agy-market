#!/usr/bin/env node
// Offline-capable bundler for `agy-market` (`scripts/build.mjs`).
// Compiles `src/ui/{template.html,styles.css,app.mjs}` (+ imported `src/shared/*.mjs` modules)
// into a single self-contained `sidecars/market_pane/index.html`, and optionally copies `site/` -> `docs/`.

import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');

const uiDir = join(repoRoot, 'src', 'ui');
const appEntry = join(uiDir, 'app.mjs');
const cssEntry = join(uiDir, 'styles.css');
const templateEntry = join(uiDir, 'template.html');
const outHtmlPath = join(repoRoot, 'sidecars', 'market_pane', 'index.html');

async function tryLoadEsbuild() {
  const candidates = [
    join(repoRoot, 'node_modules', 'esbuild', 'lib', 'main.js'),
    join(repoRoot, '..', '..', 'agy-plugin-wallpaper-engine', 'node_modules', 'esbuild', 'lib', 'main.js'),
  ];
  for (const c of candidates) {
    if (existsSync(c)) {
      try {
        return await import(pathToFileURL(c).href);
      } catch {
        /* try next */
      }
    }
  }
  return null;
}

/**
 * Deterministic zero-dependency ESM-to-IIFE topological bundler for browser relative `.mjs`/`.js` graphs.
 */
export function bundleZeroDepEsm(entryFile) {
  const visited = new Set();
  const ordered = [];
  let modSeq = 0;
  const nsMap = new Map();

  function resolveImport(fromFile, spec) {
    const base = resolve(dirname(fromFile), spec);
    for (const candidate of [base, `${base}.mjs`, `${base}.js`]) {
      if (existsSync(candidate)) return candidate;
    }
    throw new Error(`Cannot resolve relative import "${spec}" from ${fromFile}`);
  }

  function visit(filePath) {
    const abs = resolve(filePath);
    if (visited.has(abs)) return nsMap.get(abs);
    visited.add(abs);

    let code = readFileSync(abs, 'utf8').replace(/^\uFEFF/, '');
    const nsVar = `__market_mod_${++modSeq}`;
    const exportedNames = new Set();
    const importBindings = [];

    const importRe = /^\s*import\s+([\s\S]*?)\s+from\s+['"]([^'"]+)['"]\s*;?/gm;
    code = code.replace(importRe, (_full, clause, spec) => {
      if (!spec.startsWith('.')) {
        throw new Error(`Non-relative browser import "${spec}" prohibited in zero-dep UI bundle`);
      }
      const depAbs = resolveImport(abs, spec);
      const depInfo = visit(depAbs);
      const trimmed = clause.trim();
      if (trimmed.startsWith('*')) {
        const m = /\*\s+as\s+([A-Za-z_$][\w$]*)/.exec(trimmed);
        if (m) importBindings.push(`const ${m[1]} = ${depInfo.nsVar};`);
      } else if (trimmed.startsWith('{')) {
        const inner = trimmed.slice(1, trimmed.lastIndexOf('}')).trim();
        for (const part of inner.split(',')) {
          const p = part.trim();
          if (!p) continue;
          const asMatch = /^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/.exec(p);
          if (asMatch) {
            importBindings.push(`const ${asMatch[2]} = ${depInfo.nsVar}.${asMatch[1]};`);
          } else {
            importBindings.push(`const ${p} = ${depInfo.nsVar}.${p};`);
          }
        }
      } else {
        importBindings.push(`const ${trimmed} = ${depInfo.nsVar}.default;`);
      }
      return '';
    });

    code = code.replace(/^\s*import\s+['"]([^'"]+)['"]\s*;?/gm, (_full, spec) => {
      const depAbs = resolveImport(abs, spec);
      visit(depAbs);
      return '';
    });

    code = code.replace(/^\s*export\s+(async\s+function|function|class)\s+([A-Za-z_$][\w$]*)/gm, (_m, kw, id) => {
      exportedNames.add(id);
      return `${kw} ${id}`;
    });

    code = code.replace(/^\s*export\s+(const|let|var)\s+([A-Za-z_$][\w$]*)/gm, (_m, kw, id) => {
      exportedNames.add(id);
      return `${kw} ${id}`;
    });

    let hasDefault = false;
    code = code.replace(/^\s*export\s+default\s+/gm, () => {
      hasDefault = true;
      return 'const __market_default__ = ';
    });

    const aliasPairs = [];
    code = code.replace(/^\s*export\s*\{([^}]*)\}\s*;?/gm, (_m, inner) => {
      for (const part of inner.split(',')) {
        const p = part.trim();
        if (!p) continue;
        const asMatch = /^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/.exec(p);
        if (asMatch) aliasPairs.push(`${asMatch[2]}: ${asMatch[1]}`);
        else exportedNames.add(p);
      }
      return '';
    });

    const props = [
      ...[...exportedNames].map((n) => `${n}: ${n}`),
      ...aliasPairs,
      ...(hasDefault ? ['default: __market_default__'] : []),
    ];

    const wrapped = [
      `const ${nsVar} = (function() {`,
      ...importBindings,
      code,
      `return { ${props.join(', ')} };`,
      `})();`,
    ].join('\n');

    const info = { nsVar, exports: exportedNames };
    nsMap.set(abs, info);
    ordered.push(wrapped);
    return info;
  }

  visit(entryFile);
  return `(function(){\n'use strict';\n${ordered.join('\n\n')}\n})();`;
}

export async function buildMarketSidecarHtml({ buildSiteDocs = false } = {}) {
  if (!existsSync(appEntry)) {
    throw new Error(`Missing UI entrypoint: ${appEntry}`);
  }

  const rawCss = existsSync(cssEntry) ? readFileSync(cssEntry, 'utf8') : '';
  const safeCss = rawCss.replace(/<\/style>/gi, '<\\/style>');

  let jsBundle = '';
  let bundlerUsed = 'zero-dep-inline';

  const esbuild = await tryLoadEsbuild();
  if (esbuild) {
    try {
      const res = await esbuild.build({
        entryPoints: [appEntry],
        bundle: true,
        format: 'iife',
        target: 'es2022',
        minify: false,
        write: false,
      });
      jsBundle = res.outputFiles[0].text;
      bundlerUsed = 'esbuild';
    } catch {
      jsBundle = bundleZeroDepEsm(appEntry);
      bundlerUsed = 'zero-dep-inline';
    }
  } else {
    jsBundle = bundleZeroDepEsm(appEntry);
  }

  // Verify compiled JavaScript syntax in V8 VM before writing
  new vm.Script(jsBundle, { filename: 'agy-market-ui-bundle.js' });
  const safeJs = jsBundle.replace(/<\/script>/gi, '<\\/script>');

  let html = readFileSync(templateEntry, 'utf8');
  if (!html.includes('/preload.js')) {
    html = html.replace('</head>', '  <script src="/preload.js"></script>\n</head>');
  }

  const styleBlock = `<style id="agy-market-styles">\n${safeCss}\n</style>`;
  const scriptBlock = `<script id="agy-market-bundle">\n${safeJs}\n</script>`;

  html = html.includes('<!-- MARKET_INLINE_STYLE -->')
    ? html.replace('<!-- MARKET_INLINE_STYLE -->', () => styleBlock)
    : html.replace('</head>', () => `${styleBlock}\n</head>`);

  html = html.includes('<!-- MARKET_INLINE_SCRIPT -->')
    ? html.replace('<!-- MARKET_INLINE_SCRIPT -->', () => scriptBlock)
    : html.replace('</body>', () => `${scriptBlock}\n</body>`);

  mkdirSync(dirname(outHtmlPath), { recursive: true });
  writeFileSync(outHtmlPath, html, 'utf8');

  let siteCopied = false;
  const siteDir = join(repoRoot, 'site');
  if (buildSiteDocs && existsSync(siteDir)) {
    const docsDir = join(repoRoot, 'docs');
    mkdirSync(docsDir, { recursive: true });
    cpSync(siteDir, docsDir, { recursive: true, force: true });
    const logoSrc = join(repoRoot, 'assets', 'logo.svg');
    if (existsSync(logoSrc)) {
      cpSync(logoSrc, join(docsDir, 'logo.svg'), { force: true });
    }
    siteCopied = true;
  }

  return {
    outHtmlPath,
    bytes: Buffer.byteLength(html, 'utf8'),
    bundlerUsed,
    siteCopied,
  };
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1] || '')).href) {
  const buildSiteDocs = process.argv.includes('--site');
  const out = await buildMarketSidecarHtml({ buildSiteDocs });
  console.log(
    `[build] Built ${out.outHtmlPath} (${out.bytes} bytes, bundler=${out.bundlerUsed}${out.siteCopied ? ', site->docs/' : ''})`,
  );
}
