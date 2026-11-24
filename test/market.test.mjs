import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';

import { compileCatalogArtifacts } from '../../agy-market-catalog/scripts/build-catalog.mjs';
import { evaluateSubmission } from '../../agy-market-catalog/scripts/check-submission.mjs';
import { buildTrack2PluginRecord } from '../../agy-market-catalog/scripts/crawl-topics.mjs';
import { validateSingleEntryFile } from '../../agy-market-catalog/scripts/validate-entries.mjs';
import { validatePluginTarball } from '../../agy-market-catalog/scripts/validate-plugin-tarball.mjs';

import { runCli } from '../bin/agy-market.mjs';
import { packReleaseBundle } from '../scripts/pack-release.mjs';
import { fetchVerifiedPluginTarball, resolveMutableTagCommitFallbackUrl } from '../src/installer/fetch-tarball.mjs';
import { installOrUpdateCatalogPlugin } from '../src/installer/index.mjs';
import { recoverInterruptedJournal, writePendingJournal } from '../src/installer/journal.mjs';
import { sweepRetiredBinaries } from '../src/installer/sync-dir.mjs';
import {
  createDeterministicTarGz,
  encodePaxRecord,
  extractTarGzToDir,
  parsePaxRecords,
  parseTarGzToMap,
} from '../src/installer/tar-extract.mjs';
import { resolveInstallPreflight, scanLocalPluginInventory } from '../src/preflight/index.mjs';
import { resolveMarketCatalog } from '../src/registry/index.mjs';
import { scrubChildProcessEnv } from '../src/shared/constants.mjs';
import { buildInstallReceipt, sanitizeNativePluginManifest } from '../src/shared/schemas.mjs';
import { createMarketSidecarServer } from '../src/sidecar/server.mjs';

const CLEAN_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><rect x="16" y="16" width="96" height="96" rx="20" fill="#6366f1"/></svg>`;
const COMMIT_1 = '1111111111111111111111111111111111111111';
const COMMIT_2 = '2222222222222222222222222222222222222222';

function makeTempWorkspace(prefix = 'agy-market-test-') {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const configDir = join(root, 'config');
  const pluginsDir = join(configDir, 'plugins');
  const dataDir = join(root, 'sidecar_data');
  const artifactsDir = join(root, 'artifacts');
  mkdirSync(pluginsDir, { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(artifactsDir, { recursive: true });
  return {
    root,
    configDir,
    pluginsDir,
    dataDir,
    artifactsDir,
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function makeCommits() {
  return [
    { sha: 'a'.repeat(40), commit: { tree: { sha: 'tree_alpha_1' } } },
    { sha: 'b'.repeat(40), commit: { tree: { sha: 'tree_alpha_2' } } },
    { sha: 'c'.repeat(40), commit: { tree: { sha: 'tree_alpha_3' } } },
  ];
}

test('Cross-repo dogfooding: packed agy-market.tar.gz passes agy-market-catalog 10-field & 4-layer gate', async () => {
  const packed = await packReleaseBundle();
  assert.equal(packed.exists, true);
  const tarBuf = readFileSync(packed.tarPath);
  const validated = validatePluginTarball(tarBuf, { pluginRoot: '.', allowScopedName: false });

  assert.equal(validated.manifest.name, 'agy-market');
  assert.equal(validated.sha256, packed.sha256);
  assert.ok(validated.capabilities.badges.includes('sidecar-ui'));
  assert.ok(!validated.capabilities.badges.includes('mcp-stdio'), 'Pure Sidecar default must ship 0 active MCP servers');
});

test('Dual-channel registry: ETag 304 cache hit + automatic @agy-market/catalog China npm mirror fallback', async () => {
  const ws = makeTempWorkspace();
  try {
    // Prepare compiled catalog artifacts + mock @agy-market/catalog .tgz
    const sampleTar = createDeterministicTarGz({
      'plugin.json': JSON.stringify({
        name: 'prism-skin',
        displayName: 'Prism Skin',
        description: 'Glass theme via CDP.',
        version: '1.0.0',
        logo: 'assets/logo.svg',
      }),
      'assets/logo.svg': CLEAN_SVG,
      'sidecars/studio/sidecar.json': JSON.stringify({ command: 'node', args: ['main.mjs'], has_web_ui: true }),
      'sidecars/studio/main.mjs': `const x = '--remote-debugging-port=9339';`,
    });

    const entry = validateSingleEntryFile(
      'alice__prism-skin.yml',
      `url: https://github.com/alice/prism-skin\ncategory: ui-themes\ndescription:\n  zh: 棱镜毛玻璃皮肤\n  en: Prism glass skin.\n`,
    );
    const approved = evaluateSubmission({
      entry,
      repoMeta: { id: 301, owner: { id: 31, login: 'alice' }, full_name: 'alice/prism-skin', created_at: '2026-10-01T00:00:00Z', stargazers_count: 150 },
      commits: makeCommits(),
      releaseInfo: { tagName: 'v1.0.0', commitSha: COMMIT_1, tarballUrl: 'https://example.com/prism-skin.tar.gz' },
      tarballBuffer: sampleTar,
      ledger: { schemaVersion: 1, entries: {} },
      versionsLock: { schemaVersion: 1, locks: {} },
      nowMs: Date.parse('2026-11-23T12:00:00Z'),
    });

    const compiled = compileCatalogArtifacts({
      entries: [entry],
      ledger: approved.ledger,
      versionsLock: approved.versionsLock,
    });

    // 1. Test ETag 304 revalidation on primary channel
    let etagSawIfNoneMatch = false;
    const primaryFetchMock = async (url, init = {}) => {
      if (String(url).endsWith('/index.json')) {
        if (init.headers?.['If-None-Match'] === '"v1-etag"') {
          etagSawIfNoneMatch = true;
          return new Response(null, { status: 304 });
        }
        return new Response(JSON.stringify(compiled.indexJson), {
          status: 200,
          headers: { etag: '"v1-etag"', 'content-type': 'application/json' },
        });
      }
      return new Response('{}', { status: 404 });
    };

    const firstLoad = await resolveMarketCatalog({ dataDir: ws.dataDir, fetchImpl: primaryFetchMock });
    assert.equal(firstLoad.channelUsed, 'github-pages');
    assert.equal(firstLoad.plugins.length, 1);

    const secondLoad = await resolveMarketCatalog({ dataDir: ws.dataDir, fetchImpl: primaryFetchMock });
    assert.equal(etagSawIfNoneMatch, true);
    assert.equal(secondLoad.channelUsed, 'github-pages-304');
    assert.equal(secondLoad.plugins.length, 1);

    // 1b. Test GitHub Pages 404 -> automatic raw.githubusercontent.com/.../gh-pages fallback before npm mirrors
    const wsRawFallback = makeTempWorkspace('agy-raw-gh-pages-');
    try {
      const rawFallbackMock = async (url) => {
        const u = String(url);
        if (u.startsWith('https://azwosile.github.io/agy-market-catalog')) {
          return new Response('Not Found', { status: 404 });
        }
        if (u === 'https://raw.githubusercontent.com/azwosile/agy-market-catalog/gh-pages/index.json') {
          return new Response(JSON.stringify(compiled.indexJson), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        throw new Error(`Unexpected URL during raw gh-pages fallback: ${u}`);
      };

      const rawLoad = await resolveMarketCatalog({
        dataDir: wsRawFallback.dataDir,
        fetchImpl: rawFallbackMock,
      });
      assert.equal(rawLoad.channelUsed, 'github-raw-gh-pages');
      assert.equal(rawLoad.plugins.length, 1);
      assert.equal(rawLoad.warnings.length, 0);
    } finally {
      wsRawFallback.cleanup();
    }

    // 2. Test primary timeout/failure -> China @agy-market/catalog npm mirror .tgz fallback!
    const wsChina = makeTempWorkspace('agy-china-');
    try {
      const mirrorTgz = createDeterministicTarGz({
        'package/dist/index.json': JSON.stringify(compiled.indexJson),
        'package/dist/unverified-index.json': JSON.stringify(compiled.unverifiedIndexJson),
        'package/dist/readmes.json': JSON.stringify(compiled.readmesJson),
      });
      const tgzFile = join(wsChina.artifactsDir, 'catalog.tgz');
      writeFileSync(tgzFile, mirrorTgz);

      const mirrorFetchMock = async (url) => {
        const u = String(url);
        if (
          u.startsWith('https://azwosile.github.io/agy-market-catalog') ||
          u.startsWith('https://raw.githubusercontent.com/azwosile/agy-market-catalog/gh-pages')
        ) {
          throw new Error('ConnectTimeoutError: GitHub Pages unreachable');
        }
        if (u.includes('registry.npmmirror.com')) {
          return new Response(
            JSON.stringify({
              name: '@agy-market/catalog',
              version: '2026.1123.1',
              dist: { tarball: pathToFileURL(tgzFile).href },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        throw new Error(`Unexpected URL: ${u}`);
      };

      const fallbackLoad = await resolveMarketCatalog({
        dataDir: wsChina.dataDir,
        includeReadmes: true,
        fetchImpl: mirrorFetchMock,
      });
      assert.match(fallbackLoad.channelUsed, /^npm-mirror/);
      assert.equal(fallbackLoad.plugins[0].canonicalName, 'prism-skin');
      assert.ok(fallbackLoad.plugins[0].capabilities.badges.includes('host-enhancement'));
    } finally {
      wsChina.cleanup();
    }
  } finally {
    ws.cleanup();
  }
});


test('Installer enforces SHA-256 tamper protection, Track-2 <owner>--<slug> rewrite, local collision modal, escalation guard & Windows EBUSY lock-safe sync', async () => {
  const ws = makeTempWorkspace();
  try {
    // Build v1.0.0 tarball with preservePaths + binary helper.exe
    const v1Tar = createDeterministicTarGz({
      'plugin.json': JSON.stringify({
        name: 'code-lens',
        displayName: 'Code Lens',
        description: 'Fast code insights.',
        version: '1.0.0',
        logo: 'assets/logo.svg',
      }),
      'assets/logo.svg': CLEAN_SVG,
      'user-prefs.json': JSON.stringify({ theme: 'default' }),
      'bin/helper.exe': Buffer.from('MZ_V1_BINARY'),
      'stale-v1.txt': 'remove me on v2',
      'skills/code-lens/SKILL.md': '---\nname: code-lens\n---\nOpen [Manage](customization://code-lens) or [Pane](sidecar://code-lens/view/)',
    });
    const v1TarPath = join(ws.artifactsDir, 'code-lens-1.0.0.tar.gz');
    writeFileSync(v1TarPath, v1Tar);
    const v1Sha = createHash('sha256').update(v1Tar).digest('hex');

    const v1Plugin = {
      id: 'alice__code-lens',
      canonicalName: 'code-lens',
      scopedName: 'alice--code-lens',
      forceScopedInstall: false,
      displayName: 'Code Lens',
      description: { zh: '代码洞察', en: 'Code insights' },
      version: '1.0.0',
      gitTag: 'v1.0.0',
      commitSha: COMMIT_1,
      repository: { url: 'https://github.com/alice/code-lens', repositoryId: 501, ownerId: 51, stars: 20, pluginRoot: '.' },
      distribution: {
        tarballUrl: pathToFileURL(v1TarPath).href,
        sha256: v1Sha,
        sizeBytes: v1Tar.length,
        preservePaths: ['user-prefs.json'],
      },
      capabilities: {
        badges: ['declarative-only'],
        rulesEstimatedTokens: 0,
        mcpServers: [],
        mcpRemoteDomains: [],
        hookEvents: [],
        hostEnhancementKind: [],
      },
    };

    // 1. Tampered SHA-256 must hard-abort with INTEGRITY_SHA256_MISMATCH
    await assert.rejects(
      () =>
        installOrUpdateCatalogPlugin({
          plugin: {
            ...v1Plugin,
            distribution: { ...v1Plugin.distribution, sha256: 'f'.repeat(64) },
          },
          configDir: ws.configDir,
          dataDir: ws.dataDir,
        }),
      /INTEGRITY_SHA256_MISMATCH/,
    );
    assert.equal(existsSync(join(ws.pluginsDir, 'code-lens')), false);

    // 2. Clean Track-1 native install -> active immediately at `<pluginsDir>/code-lens`
    const resV1 = await installOrUpdateCatalogPlugin({
      plugin: v1Plugin,
      configDir: ws.configDir,
      dataDir: ws.dataDir,
    });
    assert.equal(resV1.ok, true);
    assert.equal(resV1.installedDir, 'code-lens');
    assert.equal(resV1.scopedRewriteApplied, false);

    // Simulate user customizing preserved file `user-prefs.json`
    writeFileSync(join(ws.pluginsDir, 'code-lens', 'user-prefs.json'), JSON.stringify({ theme: 'obsidian-custom' }));

    // 3. Build v2.0.0 tarball that adds `hooks.json` + `mcp-remote` (capability escalation!) and updates `bin/helper.exe`
    const v2Tar = createDeterministicTarGz({
      'plugin.json': JSON.stringify({
        name: 'code-lens',
        displayName: 'Code Lens',
        description: 'Fast code insights v2.',
        version: '2.0.0',
        logo: 'assets/logo.svg',
      }),
      'assets/logo.svg': CLEAN_SVG,
      'user-prefs.json': JSON.stringify({ theme: 'factory-reset-attempt' }),
      'bin/helper.exe': Buffer.from('MZ_V2_BINARY_NEW'),
      'hooks.json': JSON.stringify({ hooks: { SessionStart: [] } }),
      'mcp_config.json': JSON.stringify({ mcpServers: { cloud: { url: 'https://mcp.codelens.dev/sse' } } }),
    });
    const v2TarPath = join(ws.artifactsDir, 'code-lens-2.0.0.tar.gz');
    writeFileSync(v2TarPath, v2Tar);
    const v2Sha = createHash('sha256').update(v2Tar).digest('hex');

    const v2Plugin = {
      ...v1Plugin,
      version: '2.0.0',
      gitTag: 'v2.0.0',
      commitSha: COMMIT_2,
      distribution: {
        ...v1Plugin.distribution,
        tarballUrl: pathToFileURL(v2TarPath).href,
        sha256: v2Sha,
        sizeBytes: v2Tar.length,
      },
      capabilities: {
        badges: ['mcp-remote', 'lifecycle-hooks'],
        rulesEstimatedTokens: 0,
        mcpServers: ['code-lens_cloud'],
        mcpRemoteDomains: ['mcp.codelens.dev'],
        hookEvents: ['SessionStart'],
        hostEnhancementKind: [],
      },
    };

    // Without confirmEscalation -> must pause and return CAPABILITY_ESCALATION_CONFIRM_REQUIRED
    const paused = await installOrUpdateCatalogPlugin({
      plugin: v2Plugin,
      configDir: ws.configDir,
      dataDir: ws.dataDir,
      confirmEscalation: false,
    });
    assert.equal(paused.ok, false);
    assert.equal(paused.status, 'CAPABILITY_ESCALATION_CONFIRM_REQUIRED');
    assert.deepEqual(paused.escalation.addedBadges, ['mcp-remote', 'lifecycle-hooks']);
    assert.deepEqual(paused.escalation.addedRemoteDomains, ['mcp.codelens.dev']);

    // Confirm escalation + simulate Windows EBUSY lock on `bin/helper.exe`!
    let simulatedLockHit = false;
    const resV2 = await installOrUpdateCatalogPlugin({
      plugin: v2Plugin,
      configDir: ws.configDir,
      dataDir: ws.dataDir,
      confirmEscalation: true,
      writeOverride(src, dst, rel) {
        if (rel === 'bin/helper.exe' && !simulatedLockHit) {
          simulatedLockHit = true;
          const err = new Error('EBUSY: resource busy or locked');
          err.code = 'EBUSY';
          throw err;
        }
        copyFileSync(src, dst);
      },
    });

    assert.equal(resV2.ok, true);
    assert.equal(simulatedLockHit, true);
    assert.equal(resV2.retiredBinaries.length, 1);
    assert.equal(readFileSync(join(ws.pluginsDir, 'code-lens', 'bin', 'helper.exe'), 'utf8'), 'MZ_V2_BINARY_NEW');
    assert.equal(
      JSON.parse(readFileSync(join(ws.pluginsDir, 'code-lens', 'user-prefs.json'), 'utf8')).theme,
      'obsidian-custom',
      'preservePaths must retain user-prefs.json across updates',
    );
    assert.equal(existsSync(join(ws.pluginsDir, 'code-lens', 'stale-v1.txt')), false, 'stale v1 files must be removed');

    // Sweep retired `*.old.<ts>` binary once handle is closed
    const gc = sweepRetiredBinaries(ws.dataDir);
    assert.equal(gc.removed, 1);
    assert.equal(gc.remaining, 0);

    // 4. Foreign local collision on `code-lens` by a DIFFERENT author -> CONFLICT_CHOICE_REQUIRED, then isolated install!
    const rivalPlugin = {
      ...v1Plugin,
      id: 'bob__code-lens',
      scopedName: 'bob--code-lens',
      repository: { url: 'https://github.com/bob/code-lens', repositoryId: 999, ownerId: 99, stars: 5, pluginRoot: '.' },
    };
    const conflictCheck = await installOrUpdateCatalogPlugin({
      plugin: rivalPlugin,
      configDir: ws.configDir,
      dataDir: ws.dataDir,
      conflictStrategy: 'prompt',
    });
    assert.equal(conflictCheck.status, 'CONFLICT_CHOICE_REQUIRED');
    assert.equal(conflictCheck.scopedFallbackName, 'bob--code-lens');

    const isolatedInstall = await installOrUpdateCatalogPlugin({
      plugin: rivalPlugin,
      configDir: ws.configDir,
      dataDir: ws.dataDir,
      conflictStrategy: 'isolate',
    });
    assert.equal(isolatedInstall.ok, true);
    assert.equal(isolatedInstall.installedDir, 'bob--code-lens');
    const scopedManifest = JSON.parse(readFileSync(join(ws.pluginsDir, 'bob--code-lens', 'plugin.json'), 'utf8'));
    assert.equal(scopedManifest.name, 'bob--code-lens');
    assert.equal(scopedManifest.displayName, 'Code Lens');
    const scopedSkill = readFileSync(join(ws.pluginsDir, 'bob--code-lens', 'skills', 'code-lens', 'SKILL.md'), 'utf8');
    assert.ok(scopedSkill.includes('customization://bob--code-lens'));
    assert.ok(scopedSkill.includes('sidecar://bob--code-lens/view/'));

    // 5. Track-2 Experimental plugin -> automatically scoped without prompting!
    const track2Rec = buildTrack2PluginRecord({
      repoMeta: {
        id: 808,
        name: 'code-lens',
        full_name: 'Exp-Lab/code-lens',
        html_url: 'https://github.com/Exp-Lab/code-lens',
        owner: { id: 88, login: 'Exp-Lab' },
      },
      releaseInfo: {
        tagName: 'v1.0.0',
        commitSha: COMMIT_1,
        tarballUrl: pathToFileURL(v1TarPath).href,
      },
      tarballBuffer: v1Tar,
    });
    const t2Res = await installOrUpdateCatalogPlugin({
      plugin: track2Rec.pluginEntry,
      configDir: ws.configDir,
      dataDir: ws.dataDir,
    });
    assert.equal(t2Res.installedDir, 'exp-lab--code-lens');
    assert.equal(t2Res.scopedRewriteApplied, true);

    // 6. Crash-recovery journal completes interrupted forward staging on boot
    const interruptedStaging = join(ws.dataDir, 'staging', 'crash-test', 'bundle');
    mkdirSync(interruptedStaging, { recursive: true });
    writeFileSync(
      join(interruptedStaging, 'plugin.json'),
      JSON.stringify({ name: 'recovered-plug', description: 'Recovered after crash' }),
    );
    writePendingJournal(ws.dataDir, {
      op: 'install-native',
      dir: 'recovered-plug',
      stagingRootDir: join(ws.dataDir, 'staging', 'crash-test'),
      stagingBundleDir: interruptedStaging,
      preservePaths: [],
      receipt: { schemaVersion: 1, id: 'x__recovered-plug', installedDir: 'recovered-plug', installedVersion: '1.0.0' },
    });
    const recOut = recoverInterruptedJournal({ dataDir: ws.dataDir, pluginsDir: ws.pluginsDir });
    assert.equal(recOut.recovered, true);
    assert.equal(recOut.action, 'completed-forward');
    assert.equal(existsSync(join(ws.pluginsDir, 'recovered-plug', 'plugin.json')), true);
  } finally {
    ws.cleanup();
  }
});


test('Sidecar HTTP server enforces X-Sidecar-Token & Origin CSRF guards and CLI bootstrap passes doctor', async () => {
  const ws = makeTempWorkspace();
  try {
    const feedPath = join(ws.artifactsDir, 'custom-index.json');
    writeFileSync(
      feedPath,
      JSON.stringify({
        schemaVersion: 1,
        track: 'verified',
        catalogVersion: '2026.1123.9',
        plugins: [],
      }),
    );

    const srv = await createMarketSidecarServer({
      listen: false,
      configDir: ws.configDir,
      dataDir: ws.dataDir,
      recoveryDelayMs: -1,
      fetchImpl: async () => new Response(JSON.stringify({ schemaVersion: 1, plugins: [] }), { status: 200 }),
    });

    try {
      const health = await srv.inject({ method: 'GET', url: '/healthz' });
      assert.equal(health.statusCode, 200);
      assert.equal(health.json().plugin, 'agy-market');

      // Missing X-Sidecar-Token -> 403 Forbidden
      const noToken = await srv.inject({
        method: 'POST',
        url: '/api/prefs',
        body: { locale: 'en' },
      });
      assert.equal(noToken.statusCode, 403);
      assert.match(noToken.json().error, /ERR_CSRF_TOKEN/);

      // Evil external Origin header -> 403 Forbidden even with token!
      const badOrigin = await srv.inject({
        method: 'POST',
        url: '/api/prefs',
        headers: {
          'X-Sidecar-Token': srv.sideToken,
          Origin: 'https://evil-attacker.example',
        },
        body: { locale: 'en' },
      });
      assert.equal(badOrigin.statusCode, 403);
      assert.match(badOrigin.json().error, /ERR_CSRF_ORIGIN/);

      // Valid X-Sidecar-Token + loopback Origin -> 200 OK
      const okPrefs = await srv.inject({
        method: 'POST',
        url: '/api/prefs',
        headers: {
          'X-Sidecar-Token': srv.sideToken,
          Origin: 'http://127.0.0.1:54321',
        },
        body: {
          locale: 'en',
          customFeeds: [pathToFileURL(feedPath).href],
        },
      });
      assert.equal(okPrefs.statusCode, 200);
      assert.equal(okPrefs.json().prefs.locale, 'en');

      // Ensure config.json was NEVER created or modified by AGY Market
      assert.equal(existsSync(join(ws.configDir, 'config.json')), false);
    } finally {
      await srv.close();
    }

    // CLI install + doctor check into isolated pluginsDir
    const cliInstall = await runCli(['install', '--dest', ws.pluginsDir, '--json']);
    assert.equal(cliInstall.code, 0);
    const cliDoctor = await runCli(['doctor', '--dest', ws.pluginsDir, '--json']);
    assert.equal(cliDoctor.code, 0);
  } finally {
    ws.cleanup();
  }
});


test('Real-world plugin manifest compatibility: author string/object, repo {type,url}/README fallback, PNG logo & custom sidecar path', () => {
  const ws = makeTempWorkspace('agy-real-compat-');
  try {
    // 1. agy-dart shape: repository { type, url } + author { name, url }
    const dartDir = join(ws.pluginsDir, 'agy-dart');
    mkdirSync(join(dartDir, 'sidecars', 'dashboard'), { recursive: true });
    writeFileSync(
      join(dartDir, 'plugin.json'),
      JSON.stringify({
        name: 'agy-dart',
        displayName: 'agy-dart',
        version: '1.6.0',
        logo: 'assets/logo.svg',
        author: { name: 'zou172866', url: 'https://github.com/zou172866' },
        repository: { type: 'git', url: 'https://github.com/zou172866/agy-dart.git' },
      }),
    );
    writeFileSync(
      join(dartDir, 'sidecars', 'dashboard', 'sidecar.json'),
      JSON.stringify({
        command: 'node',
        args: ['server.mjs'],
        has_web_ui: true,
        ui_config: { views: [{ path: '/', entrypoint: 'SIDECAR_UI_ENTRYPOINT_AUX_PANE', title: 'agy-dart Context' }] },
      }),
    );

    // 2. agy-wallpaper-prism shape: author as plain string + repository as string
    const prismDir = join(ws.pluginsDir, 'agy-wallpaper-prism');
    mkdirSync(prismDir, { recursive: true });
    writeFileSync(
      join(prismDir, 'plugin.json'),
      JSON.stringify({
        name: 'agy-wallpaper-prism',
        displayName: 'Wallpaper Prism',
        version: '2.0.3',
        logo: 'assets/logo.svg',
        author: 'Antigravity Prism Contributors',
        repository: 'https://github.com/azwosile/agy-wallpaper-prism',
      }),
    );

    // 3. gemini-neko-cockpit shape: no author/repository in plugin.json, ./assets/logo.png, README badge URL, /ui.html sidecar view
    const nekoDir = join(ws.pluginsDir, 'gemini-neko-cockpit');
    mkdirSync(join(nekoDir, 'sidecars', 'neko-cockpit'), { recursive: true });
    const rawNekoManifest = {
      name: 'gemini-neko-cockpit',
      displayName: 'Gemini 猫娘观察台 · Antigravity Observer',
      version: '1.2.0',
      logo: './assets/logo.png',
    };
    const sanitizedNeko = sanitizeNativePluginManifest(rawNekoManifest);
    assert.equal(sanitizedNeko.logo, 'assets/logo.png');
    writeFileSync(join(nekoDir, 'plugin.json'), JSON.stringify(rawNekoManifest));
    writeFileSync(
      join(nekoDir, 'README.md'),
      '# Antigravity Observer\n[![version](https://img.shields.io/badge/v1.2.0-blue)](https://github.com/yunjuanyunshu114-byte/antigravity-observer/releases)\n',
    );
    writeFileSync(
      join(nekoDir, 'sidecars', 'neko-cockpit', 'sidecar.json'),
      JSON.stringify({
        command: 'node',
        args: ['server.cjs'],
        has_web_ui: true,
        ui_config: {
          views: [{ path: '/ui.html', entrypoint: 'SIDECAR_UI_ENTRYPOINT_AUX_PANE', title: '上下文与额度观察' }],
        },
      }),
    );

    const inv = scanLocalPluginInventory({ configDir: ws.configDir });
    const byDir = new Map(inv.installed.map((x) => [x.dir, x]));

    assert.equal(byDir.get('agy-dart').repositoryUrl, 'https://github.com/zou172866/agy-dart');
    assert.equal(byDir.get('agy-dart').author, 'zou172866');
    assert.equal(byDir.get('agy-dart').sidecarPane.uri, 'sidecar://agy-dart/dashboard/');

    assert.equal(byDir.get('agy-wallpaper-prism').repositoryUrl, 'https://github.com/azwosile/agy-wallpaper-prism');
    assert.equal(byDir.get('agy-wallpaper-prism').author, 'Antigravity Prism Contributors');

    assert.equal(
      byDir.get('gemini-neko-cockpit').repositoryUrl,
      'https://github.com/yunjuanyunshu114-byte/antigravity-observer',
    );
    assert.equal(byDir.get('gemini-neko-cockpit').logo, 'assets/logo.png');
    assert.equal(
      byDir.get('gemini-neko-cockpit').sidecarPane.uri,
      'sidecar://gemini-neko-cockpit/neko-cockpit/ui.html',
    );

    const preflightNeko = resolveInstallPreflight(
      {
        id: 'yunjuanyunshu114-byte__antigravity-observer',
        canonicalName: 'gemini-neko-cockpit',
        scopedName: 'yunjuanyunshu114-byte--gemini-neko-cockpit',
        forceScopedInstall: false,
        repository: {
          url: 'https://github.com/yunjuanyunshu114-byte/antigravity-observer',
          repositoryId: 777,
        },
      },
      inv,
    );
    assert.equal(preflightNeko.action, 'update');
    assert.equal(preflightNeko.targetDir, 'gemini-neko-cockpit');
  } finally {
    ws.cleanup();
  }
});


test('POSIX PAX multi-record UTF-8 byte-length parser & Windows NTFS extraction + install.ps1 catalog fallback', () => {
  const ws = makeTempWorkspace('agy-pax-boot-');
  try {
    // 1. Direct multi-record UTF-8 PAX buffer verification (Chinese + emoji + subsequent numeric records)
    const utf8RelPath =
      'assets/猫娘挂件_超长多字节路径测试目录_反重力观察台/双击安装观察窗补丁_表情差分立绘_idle_eat_grin_xd_测试文件.txt';
    const rawPaxBlock = Buffer.concat([
      encodePaxRecord('comment', '反重力插件市场 UTF-8 PAX 扩展头测试 🚀'),
      encodePaxRecord('path', utf8RelPath),
      encodePaxRecord('mtime', '1732363200'),
      encodePaxRecord('size', '21'),
    ]);
    const parsedPax = parsePaxRecords(rawPaxBlock);
    assert.equal(parsedPax.comment, '反重力插件市场 UTF-8 PAX 扩展头测试 🚀');
    assert.equal(parsedPax.path, utf8RelPath);
    assert.equal(parsedPax.mtime, '1732363200');
    assert.equal(parsedPax.size, '21');

    // 2. Full PAX .tar.gz archive creation, map parsing, and real NTFS disk extraction (verifies zero trailing \n EINVAL)
    const paxArchive = createDeterministicTarGz(
      {
        'plugin.json': JSON.stringify({ name: 'pax-utf8-plugin', version: '1.0.1' }),
        [utf8RelPath]: 'UTF8_PAX_PAYLOAD_OK',
        '双击安装观察窗补丁.bat': '@echo off\r\necho ok\r\n',
      },
      { forcePax: true },
    );
    const paxMap = parseTarGzToMap(paxArchive);
    assert.equal(paxMap.has(utf8RelPath), true);
    assert.equal(paxMap.get(utf8RelPath).toString('utf8'), 'UTF8_PAX_PAYLOAD_OK');

    const extractedDir = join(ws.artifactsDir, 'pax-extracted');
    extractTarGzToDir(paxArchive, extractedDir);
    assert.equal(readFileSync(join(extractedDir, utf8RelPath), 'utf8'), 'UTF8_PAX_PAYLOAD_OK');
    assert.equal(existsSync(join(extractedDir, '双击安装观察窗补丁.bat')), true);

    // 3. Test scripts/install.ps1 404 release fallback -> catalog index.json -> nested top-dir tarball unwrap & SHA-256 verification
    if (process.platform === 'win32') {
      const nestedTagTar = createDeterministicTarGz({
        'agy-market-1.0.1/plugin.json': JSON.stringify({
          name: 'agy-market',
          displayName: 'AGY Market · 反重力插件市场',
          version: '1.0.1',
        }),
        'agy-market-1.0.1/sidecars/market_pane/index.html': '<!doctype html><title>AGY Market</title>',
      });
      const nestedTarPath = join(ws.artifactsDir, 'agy-market-tag-v1.0.1.tar.gz');
      writeFileSync(nestedTarPath, nestedTagTar);
      const nestedSha = createHash('sha256').update(nestedTagTar).digest('hex');

      const mockCatalogPath = join(ws.artifactsDir, 'mock-catalog-index.json');
      writeFileSync(
        mockCatalogPath,
        JSON.stringify({
          schemaVersion: 1,
          track: 'verified',
          plugins: [
            {
              id: 'azwosile__agy-market',
              canonicalName: 'agy-market',
              version: '1.0.1',
              repository: { repositoryId: 1468650761 },
              distribution: {
                tarballUrl: pathToFileURL(nestedTarPath).href,
                sha256: nestedSha,
              },
            },
          ],
        }),
      );

      const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
      const ps1Script = join(repoRoot, 'scripts', 'install.ps1');
      const ps1Bytes = readFileSync(ps1Script);
      assert.equal(
        ps1Bytes.length >= 3 && ps1Bytes[0] === 0xef && ps1Bytes[1] === 0xbb && ps1Bytes[2] === 0xbf,
        false,
        'scripts/install.ps1 must not have a UTF-8 BOM (breaks irm ... | iex with param block)',
      );
      execFileSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-Command',
          '[scriptblock]::Create([System.Text.Encoding]::UTF8.GetString([System.IO.File]::ReadAllBytes($env:AGY_PS1_PATH))) | Out-Null',
        ],
        {
          env: { ...scrubChildProcessEnv(process.env), AGY_PS1_PATH: ps1Script },
          stdio: 'pipe',
        },
      );
      const missingReleaseBase = pathToFileURL(join(ws.artifactsDir, 'missing-release-404')).href;

      execFileSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          ps1Script,
          '-ReleaseBaseUrl',
          missingReleaseBase,
          '-CatalogUrls',
          pathToFileURL(mockCatalogPath).href,
        ],
        {
          env: { ...scrubChildProcessEnv(process.env), ANTIGRAVITY_CONFIG_DIR: ws.configDir },
          stdio: 'pipe',
        },
      );

      const installedTarget = join(ws.pluginsDir, 'agy-market');
      assert.equal(existsSync(join(installedTarget, 'plugin.json')), true);
      assert.equal(existsSync(join(installedTarget, 'sidecars', 'market_pane', 'index.html')), true);
      const bootReceipt = JSON.parse(readFileSync(join(installedTarget, '.agy-market-receipt.json'), 'utf8'));
      assert.equal(bootReceipt.id, 'azwosile__agy-market');
      assert.equal(bootReceipt.installedVersion, '1.0.1');
      assert.equal(bootReceipt.repositoryId, 1468650761);
      assert.equal(bootReceipt.sha256, nestedSha);
    }
  } finally {
    ws.cleanup();
  }
});

function buildTarGzWithGlobalPax(entries, { globalPaxComment = '' } = {}) {
  const chunks = [];
  const makeHeader = (name, size, typeFlag = '0') => {
    const h = Buffer.alloc(512, 0);
    h.write(name, 0, Math.min(100, Buffer.byteLength(name)), 'utf8');
    h.write('0000644\0', 100, 8, 'ascii');
    h.write('0000000\0', 108, 8, 'ascii');
    h.write('0000000\0', 116, 8, 'ascii');
    h.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 12, 'ascii');
    h.write('00000000000\0', 136, 12, 'ascii');
    h.fill(0x20, 148, 156);
    h.write(typeFlag, 156, 1, 'ascii');
    h.write('ustar\0', 257, 6, 'ascii');
    h.write('00', 263, 2, 'ascii');
    let sum = 0;
    for (let i = 0; i < 512; i += 1) sum += h[i];
    h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
    return h;
  };
  const pushPadded = (buf) => {
    chunks.push(buf);
    const rem = buf.length % 512;
    if (rem !== 0) chunks.push(Buffer.alloc(512 - rem, 0));
  };
  if (globalPaxComment) {
    const paxPayload = encodePaxRecord('comment', globalPaxComment);
    chunks.push(makeHeader('pax_global_header', paxPayload.length, 'g'));
    pushPadded(paxPayload);
  }
  for (const [relPath, content] of Object.entries(entries)) {
    const buf = Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8');
    chunks.push(makeHeader(relPath, buf.length, '0'));
    pushPadded(buf);
  }
  chunks.push(Buffer.alloc(1024, 0));
  return gzipSync(Buffer.concat(chunks), { level: 6 });
}

test('fetchVerifiedPluginTarball hardens commit-pinned GitHub archive fallback with PAX commitSha & digest verification', async () => {
  const commitSha = 'eb55259f0e17ec75794e7a3fad411a177eb94bb7';
  const otherCommitSha = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

  // Strict URL validation & lowercase commitSha normalization
  assert.equal(
    resolveMutableTagCommitFallbackUrl({
      commitSha: commitSha.toUpperCase(),
      distribution: { tarballUrl: 'https://github.com/zou172866/agy-dart/archive/refs/tags/v1.7.0.tar.gz' },
    }),
    `https://github.com/zou172866/agy-dart/archive/${commitSha}.tar.gz`,
  );
  assert.equal(
    resolveMutableTagCommitFallbackUrl({
      commitSha,
      distribution: { tarballUrl: 'https://github.com/zou172866/agy-dart/releases/download/v1.7.0/agy-dart.tar.gz' },
    }),
    null,
  );
  assert.equal(
    resolveMutableTagCommitFallbackUrl({
      commitSha: 'not-a-sha',
      distribution: { tarballUrl: 'https://github.com/zou172866/agy-dart/archive/refs/tags/v1.7.0.tar.gz' },
    }),
    null,
  );
  for (const badUrl of [
    'https://github.com/evil/repo?x=1/archive/refs/tags/v1.0.0.tar.gz',
    'https://github.com/evil/repo#frag/archive/refs/tags/v1.0.0.tar.gz',
    'https://github.com/../repo/archive/refs/tags/v1.0.0.tar.gz',
    'https://github.com/evil/../archive/refs/tags/v1.0.0.tar.gz',
    'https://github.com/evil/./archive/refs/tags/v1.0.0.tar.gz',
    'https://github.com/-bad/repo/archive/refs/tags/v1.0.0.tar.gz',
  ]) {
    assert.equal(
      resolveMutableTagCommitFallbackUrl({ commitSha, distribution: { tarballUrl: badUrl } }),
      null,
      `Must reject malformed fallback source URL: ${badUrl}`,
    );
  }

  const stageRoot = mkdtempSync(join(tmpdir(), 'agy-commit-fb-'));
  try {
    const manifestJson = JSON.stringify({ name: 'agy-dart', version: '1.7.0' });
    const expectedOldPayload = createDeterministicTarGz({
      'agy-dart-1.7.0/plugin.json': manifestJson,
      'agy-dart-1.7.0/README.md': '# original tag archive',
    });
    const driftedTagPayload = createDeterministicTarGz({
      'agy-dart-1.7.0/plugin.json': manifestJson,
      'agy-dart-1.7.0/README.md': '# drifted tag archive',
    });
    const validCommitPayload = buildTarGzWithGlobalPax(
      {
        [`agy-dart-${commitSha}/plugin.json`]: manifestJson,
        [`agy-dart-${commitSha}/README.md`]: '# immutable commit archive',
      },
      { globalPaxComment: commitSha },
    );
    const forgedNoPaxPayload = createDeterministicTarGz({
      [`agy-dart-${commitSha}/plugin.json`]: manifestJson,
      [`agy-dart-${commitSha}/README.md`]: '# forged archive missing PAX comment',
    });
    const forgedWrongPaxPayload = buildTarGzWithGlobalPax(
      {
        [`agy-dart-${commitSha}/plugin.json`]: manifestJson,
        [`agy-dart-${commitSha}/README.md`]: '# forged archive wrong PAX comment',
      },
      { globalPaxComment: otherCommitSha },
    );

    const expectedSha = createHash('sha256').update(expectedOldPayload).digest('hex');
    const validCommitSha256 = createHash('sha256').update(validCommitPayload).digest('hex');

    // 1. Tag drift (INTEGRITY_SHA256_MISMATCH on direct github.com) -> valid PAX commit fallback succeeds & forwards auth header
    const requestedUrls = [];
    const seenAuthHeaders = {};
    const mockFetchDrift = async (url, init = {}) => {
      const sUrl = String(url);
      requestedUrls.push(sUrl);
      seenAuthHeaders[sUrl] = init?.headers?.Authorization || '';
      if (sUrl.includes('/archive/refs/tags/')) {
        return new Response(driftedTagPayload, { status: 200 });
      }
      if (sUrl.includes(`/archive/${commitSha}.tar.gz`)) {
        return new Response(validCommitPayload, { status: 200 });
      }
      return new Response('not found', { status: 404 });
    };

    const driftResult = await fetchVerifiedPluginTarball({
      plugin: {
        id: 'zou172866__agy-dart',
        version: '1.7.0',
        commitSha,
        distribution: {
          tarballUrl: 'https://github.com/zou172866/agy-dart/archive/refs/tags/v1.7.0.tar.gz',
          sha256: expectedSha,
        },
      },
      stagingDir: join(stageRoot, 'stage-1'),
      stagingArchivePath: join(stageRoot, 'stage-1', 'archive.tar.gz'),
      prefs: { githubToken: 'mock-fallback-auth-token' },
      fetchImpl: mockFetchDrift,
    });

    assert.equal(driftResult.channelUsed, 'github-commit-fallback');
    assert.equal(driftResult.urlUsed, `https://github.com/zou172866/agy-dart/archive/${commitSha}.tar.gz`);
    assert.equal(driftResult.sha256, validCommitSha256);
    assert.deepEqual(requestedUrls, [
      'https://github.com/zou172866/agy-dart/archive/refs/tags/v1.7.0.tar.gz',
      `https://github.com/zou172866/agy-dart/archive/${commitSha}.tar.gz`,
    ]);
    assert.equal(
      seenAuthHeaders[`https://github.com/zou172866/agy-dart/archive/${commitSha}.tar.gz`],
      'Bearer mock-fallback-auth-token',
    );

    // 2. Tag deleted (HTTP 404 on direct github.com) -> valid PAX commit fallback succeeds & returns real sha256
    const notFoundResult = await fetchVerifiedPluginTarball({
      plugin: {
        id: 'zou172866__agy-dart',
        version: '1.7.0',
        commitSha,
        distribution: {
          tarballUrl: 'https://github.com/zou172866/agy-dart/archive/refs/tags/v1.7.0.tar.gz',
          sha256: expectedSha,
        },
      },
      stagingDir: join(stageRoot, 'stage-404'),
      stagingArchivePath: join(stageRoot, 'stage-404', 'archive.tar.gz'),
      fetchImpl: async (url) => {
        if (String(url).includes('/archive/refs/tags/')) {
          return new Response('Not Found', { status: 404 });
        }
        if (String(url).includes(`/archive/${commitSha}.tar.gz`)) {
          return new Response(validCommitPayload, { status: 200 });
        }
        return new Response('Not Found', { status: 404 });
      },
    });
    assert.equal(notFoundResult.channelUsed, 'github-commit-fallback');
    assert.equal(notFoundResult.sha256, validCommitSha256);

    // 3. Forged fallback archive WITHOUT PAX comment MUST be rejected & staging archive deleted
    const forgedStageNoPax = join(stageRoot, 'stage-forged-no-pax');
    const forgedArchiveNoPax = join(forgedStageNoPax, 'archive.tar.gz');
    await assert.rejects(
      fetchVerifiedPluginTarball({
        plugin: {
          id: 'zou172866__agy-dart',
          version: '1.7.0',
          commitSha,
          distribution: {
            tarballUrl: 'https://github.com/zou172866/agy-dart/archive/refs/tags/v1.7.0.tar.gz',
            sha256: expectedSha,
          },
        },
        stagingDir: forgedStageNoPax,
        stagingArchivePath: forgedArchiveNoPax,
        fetchImpl: async (url) => {
          if (String(url).includes('/archive/refs/tags/')) {
            return new Response('Not Found', { status: 404 });
          }
          return new Response(forgedNoPaxPayload, { status: 200 });
        },
      }),
      /INTEGRITY_SHA256_MISMATCH/,
    );
    assert.equal(existsSync(forgedArchiveNoPax), false, 'Forged archive without PAX comment must be deleted');
    assert.equal(existsSync(forgedStageNoPax), false, 'Staging dir must be cleaned up on rejection');

    // 4. Forged fallback archive WITH WRONG PAX comment MUST be rejected & staging archive deleted
    const forgedStageWrongPax = join(stageRoot, 'stage-forged-wrong-pax');
    const forgedArchiveWrongPax = join(forgedStageWrongPax, 'archive.tar.gz');
    await assert.rejects(
      fetchVerifiedPluginTarball({
        plugin: {
          id: 'zou172866__agy-dart',
          version: '1.7.0',
          commitSha,
          distribution: {
            tarballUrl: 'https://github.com/zou172866/agy-dart/archive/refs/tags/v1.7.0.tar.gz',
            sha256: expectedSha,
          },
        },
        stagingDir: forgedStageWrongPax,
        stagingArchivePath: forgedArchiveWrongPax,
        fetchImpl: async (url) => {
          if (String(url).includes('/archive/refs/tags/')) {
            return new Response(driftedTagPayload, { status: 200 });
          }
          return new Response(forgedWrongPaxPayload, { status: 200 });
        },
      }),
      /INTEGRITY_SHA256_MISMATCH/,
    );
    assert.equal(existsSync(forgedArchiveWrongPax), false, 'Forged archive with wrong PAX comment must be deleted');

    // 5. Explicit commitFallbackSha256 lock: matching digest succeeds, mismatched digest fails & cleans up
    const pinnedRes = await fetchVerifiedPluginTarball({
      plugin: {
        id: 'zou172866__agy-dart',
        version: '1.7.0',
        commitSha,
        distribution: {
          tarballUrl: 'https://github.com/zou172866/agy-dart/archive/refs/tags/v1.7.0.tar.gz',
          sha256: expectedSha,
          commitFallbackSha256: validCommitSha256,
        },
      },
      stagingDir: join(stageRoot, 'stage-pinned-ok'),
      stagingArchivePath: join(stageRoot, 'stage-pinned-ok', 'archive.tar.gz'),
      fetchImpl: mockFetchDrift,
    });
    assert.equal(pinnedRes.channelUsed, 'github-commit-fallback');
    assert.equal(pinnedRes.sha256, validCommitSha256);

    const pinnedFailArchive = join(stageRoot, 'stage-pinned-fail', 'archive.tar.gz');
    await assert.rejects(
      fetchVerifiedPluginTarball({
        plugin: {
          id: 'zou172866__agy-dart',
          version: '1.7.0',
          commitSha,
          distribution: {
            tarballUrl: 'https://github.com/zou172866/agy-dart/archive/refs/tags/v1.7.0.tar.gz',
            sha256: expectedSha,
            commitFallbackSha256: 'f'.repeat(64),
          },
        },
        stagingDir: join(stageRoot, 'stage-pinned-fail'),
        stagingArchivePath: pinnedFailArchive,
        fetchImpl: mockFetchDrift,
      }),
      /INTEGRITY_SHA256_MISMATCH/,
    );
    assert.equal(existsSync(pinnedFailArchive), false);

    // 6. Third-party mirror mismatch + direct 500 must NOT trigger commit fallback
    const mirrorOnlyUrls = [];
    await assert.rejects(
      fetchVerifiedPluginTarball({
        plugin: {
          id: 'zou172866__agy-dart',
          version: '1.7.0',
          commitSha,
          distribution: {
            tarballUrl: 'https://github.com/zou172866/agy-dart/archive/refs/tags/v1.7.0.tar.gz',
            sha256: expectedSha,
          },
        },
        stagingDir: join(stageRoot, 'stage-mirror-only'),
        stagingArchivePath: join(stageRoot, 'stage-mirror-only', 'archive.tar.gz'),
        prefs: { githubReleaseMirrorPrefix: 'https://mirror.example.invalid' },
        fetchImpl: async (url) => {
          const sUrl = String(url);
          mirrorOnlyUrls.push(sUrl);
          if (sUrl.startsWith('https://mirror.example.invalid/')) {
            return new Response(driftedTagPayload, { status: 200 });
          }
          return new Response('Upstream error', { status: 500 });
        },
      }),
      /INTEGRITY_SHA256_MISMATCH/,
    );
    assert.equal(
      mirrorOnlyUrls.some((u) => u.includes(`/archive/${commitSha}.tar.gz`)),
      false,
      'Mirror-only mismatch must never trigger commit fallback when direct github.com did not report drift/404',
    );

    // 7. Release assets must STILL strictly fail on SHA-256 mismatch (never fall back)
    await assert.rejects(
      fetchVerifiedPluginTarball({
        plugin: {
          id: 'zou172866__agy-dart',
          version: '1.7.0',
          commitSha,
          distribution: {
            tarballUrl: 'https://github.com/zou172866/agy-dart/releases/download/v1.7.0/agy-dart.tar.gz',
            sha256: expectedSha,
          },
        },
        stagingDir: join(stageRoot, 'stage-2'),
        stagingArchivePath: join(stageRoot, 'stage-2', 'archive.tar.gz'),
        fetchImpl: async () => new Response(driftedTagPayload, { status: 200 }),
      }),
      /INTEGRITY_SHA256_MISMATCH/,
    );

    // 8. Receipt fidelity: buildInstallReceipt & installOrUpdateCatalogPlugin record actual fallback sha256
    const fallbackReceipt = buildInstallReceipt({
      plugin: {
        id: 'zou172866__agy-dart',
        version: '1.7.0',
        commitSha,
        distribution: { sha256: expectedSha },
      },
      installedDir: 'agy-dart',
      effectivePluginName: 'agy-dart',
      actualSha256: validCommitSha256,
    });
    assert.equal(fallbackReceipt.sha256, validCommitSha256);

    const wsInstall = makeTempWorkspace('agy-fallback-receipt-');
    try {
      const installRes = await installOrUpdateCatalogPlugin({
        plugin: {
          id: 'zou172866__agy-dart',
          canonicalName: 'agy-dart',
          displayName: 'AGY Dart',
          version: '1.7.0',
          commitSha,
          repository: { repositoryId: 987654321, url: 'https://github.com/zou172866/agy-dart', pluginRoot: '.' },
          distribution: {
            tarballUrl: 'https://github.com/zou172866/agy-dart/archive/refs/tags/v1.7.0.tar.gz',
            sha256: expectedSha,
          },
          capabilities: { badges: [], mcpRemoteDomains: [], hookEvents: [] },
        },
        configDir: wsInstall.configDir,
        dataDir: wsInstall.dataDir,
        fetchImpl: mockFetchDrift,
      });
      assert.equal(installRes.ok, true);
      assert.equal(installRes.channelUsed, 'github-commit-fallback');
      assert.equal(installRes.receipt.sha256, validCommitSha256);
      const writtenReceipt = JSON.parse(
        readFileSync(join(wsInstall.pluginsDir, 'agy-dart', '.agy-market-receipt.json'), 'utf8'),
      );
      assert.equal(writtenReceipt.sha256, validCommitSha256);
    } finally {
      wsInstall.cleanup();
    }
  } finally {
    rmSync(stageRoot, { recursive: true, force: true });
  }
});
