#!/usr/bin/env node
// One-Line Bootstrap CLI (`npx agy-market`), GitHub URL Installer (`add`) & Local Diagnostics (`bin/agy-market.mjs`).

import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { installLocalAgyMarket } from '../scripts/install-local.mjs';
import { inspectGithubPluginUrl, installGithubPlugin } from '../src/installer/github-url.mjs';
import { uninstallPlugin } from '../src/installer/index.mjs';
import { sweepRetiredBinaries } from '../src/installer/sync-dir.mjs';
import { scanLocalPluginInventory } from '../src/preflight/index.mjs';
import {
  CUSTOMIZATION_URI,
  PLUGIN_DISPLAY_NAME,
  PLUGIN_ID,
  PLUGIN_JSON_ALLOWED_KEYS,
  PLUGIN_VERSION,
  SIDECAR_URI,
} from '../src/shared/constants.mjs';
import { resolveAntigravityConfigDir, resolveMarketDataDir, resolvePluginsDir } from '../src/shared/paths.mjs';
import { loadPrefsFromDisk, parseJsonc } from '../src/shared/schemas.mjs';
import { redactSecret } from '../src/updates/index.mjs';

function printHelp() {
  console.log(`${PLUGIN_DISPLAY_NAME} v${PLUGIN_VERSION}

Usage:
  npx agy-market [install] [--dest <plugins-dir>]   Install or update AGY Market into Antigravity
  npx agy-market add <github-url> [--subpath <dir>] [--isolate|--replace] [--yes] [--dest <plugins-dir>] [--mirror <prefix>] [--token <pat>] [--json]
                                                    Inspect and install a plugin directly from a GitHub URL
  npx agy-market uninstall <dir> [--yes] [--dest <plugins-dir>] [--json]
                                                    Uninstall a globally installed plugin safely (alias: remove)
  npx agy-market status [--json]                    List installed plugins & AGY Market status
  npx agy-market doctor                             Verify installation health & sweep retired binaries
  npx agy-market --help                             Show this help message
`);
}

function getFlagValue(args, names) {
  for (const flag of names) {
    const idx = args.indexOf(flag);
    if (idx !== -1 && args[idx + 1] && !args[idx + 1].startsWith('--')) {
      return args[idx + 1];
    }
    const eqPrefix = `${flag}=`;
    const eqArg = args.find((a) => a.startsWith(eqPrefix));
    if (eqArg) return eqArg.slice(eqPrefix.length);
  }
  return '';
}

function findFirstPositionalAfterSubcommand(args) {
  const valueFlags = new Set(['--dest', '--subpath', '--root', '--mirror', '--token']);
  for (let i = 1; i < args.length; i += 1) {
    const cur = args[i];
    if (valueFlags.has(cur)) {
      i += 1;
      continue;
    }
    if (cur.startsWith('-')) continue;
    return cur.trim();
  }
  return '';
}

export async function runCli(argv = process.argv.slice(2), runtimeOpts = {}) {
  const args = [...argv];
  if (args.includes('-h') || args.includes('--help') || args[0] === 'help') {
    printHelp();
    return { code: 0 };
  }

  const destPluginsDir = getFlagValue(args, ['--dest']);
  const asJson = args.includes('--json');
  const sub = args[0] && !args[0].startsWith('--') ? args[0] : 'install';

  if (sub === 'install' || sub === 'bootstrap') {
    const out = await installLocalAgyMarket({ destPluginsDir });
    if (asJson) {
      console.log(JSON.stringify({ ok: true, ...out }, null, 2));
    } else {
      console.log(`✓ Installed ${PLUGIN_DISPLAY_NAME} (v${PLUGIN_VERSION})`);
      console.log(`  Location:     ${out.dstDir}`);
      console.log(`  Open Market:  [AGY Market](${out.sidecarUri})`);
      console.log(`  Manage:       [AGY Market](${out.customizationUri})`);
    }
    return { code: 0 };
  }

  if (sub === 'add') {
    const rawUrl = findFirstPositionalAfterSubcommand(args);
    if (!rawUrl) {
      const msg = 'Usage: npx agy-market add <github-url> [--subpath <dir>] [--isolate|--replace] [--yes] [--dest <plugins-dir>] [--mirror <prefix>] [--token <pat>] [--json]';
      if (asJson) {
        console.log(JSON.stringify({ ok: false, status: 'INVALID_USAGE', error: msg }, null, 2));
      } else {
        console.error(`✗ ${msg}`);
      }
      return { code: 1 };
    }

    const subpath = getFlagValue(args, ['--subpath', '--root']);
    const useIsolate = args.includes('--isolate');
    const useReplace = args.includes('--replace');
    if (useIsolate && useReplace) {
      const msg = 'ERR_CONFLICTING_FLAGS: Cannot pass both --isolate and --replace together';
      if (asJson) {
        console.log(JSON.stringify({ ok: false, status: 'INVALID_USAGE', error: msg }, null, 2));
      } else {
        console.error(`✗ ${msg}`);
      }
      return { code: 1 };
    }
    const confirmEscalation = args.includes('--yes') || args.includes('-y');
    const mirrorOverride = getFlagValue(args, ['--mirror']);
    const tokenOverride = getFlagValue(args, ['--token']);

    const resolvedDest = destPluginsDir ? resolve(destPluginsDir) : '';
    const configDir =
      runtimeOpts.configDir ||
      (resolvedDest && basename(resolvedDest).toLowerCase() === 'plugins'
        ? dirname(resolvedDest)
        : resolveAntigravityConfigDir());
    const pluginsDir = runtimeOpts.pluginsDir || resolvedDest || '';
    const dataDir = runtimeOpts.dataDir || resolveMarketDataDir();
    const fetchImpl = runtimeOpts.fetchImpl || fetch;
    const githubApiBaseUrl = runtimeOpts.githubApiBaseUrl || undefined;
    const nowMs = runtimeOpts.nowMs ?? Date.now();

    const diskPrefs = loadPrefsFromDisk(dataDir);
    const effectiveToken = tokenOverride || diskPrefs.githubToken || process.env.GITHUB_TOKEN || '';
    const prefs = {
      ...diskPrefs,
      ...(mirrorOverride ? { githubReleaseMirrorPrefix: mirrorOverride } : {}),
      githubToken: effectiveToken,
    };
    const installMode = useIsolate ? 'isolate' : useReplace ? 'replace' : 'native';

    try {
      const rawInspect = await inspectGithubPluginUrl({
        url: rawUrl,
        pluginRoot: subpath,
        prefs,
        configDir,
        pluginsDir,
        dataDir,
        fetchImpl,
        ...(githubApiBaseUrl ? { githubApiBaseUrl } : {}),
        nowMs,
      });
      const { _internal: _ignoreInspect, ...inspectRes } = rawInspect;

      if (inspectRes.status === 'SUBPATH_SELECTION_REQUIRED') {
        if (asJson) {
          console.log(JSON.stringify(inspectRes, null, 2));
        } else {
          console.log(`! Multiple plugins found in ${inspectRes.repoUrl}. Specify --subpath:`);
          for (const c of inspectRes.candidates || []) {
            console.log(`  - ${c.pluginRoot}  (${c.displayName} v${c.version})`);
            console.log(`      npx agy-market add ${rawUrl} --subpath ${c.pluginRoot}`);
          }
        }
        return { code: 2, result: inspectRes };
      }

      if (inspectRes.status === 'NOT_A_PLUGIN_REPO' || inspectRes.status === 'SECURITY_BLOCKED' || inspectRes.status === 'UNSAFE_ARCHIVE') {
        if (asJson) {
          console.log(JSON.stringify(inspectRes, null, 2));
        } else {
          console.error(`✗ [${inspectRes.status}] ${inspectRes.reasonZh || inspectRes.reasonEn}`);
          if (inspectRes.reasonEn && inspectRes.reasonEn !== inspectRes.reasonZh) {
            console.error(`  ${inspectRes.reasonEn}`);
          }
          if (Array.isArray(inspectRes.fileOverview) && inspectRes.fileOverview.length > 0) {
            console.error(`  Top-level files: ${inspectRes.fileOverview.join(', ')}`);
          }
        }
        return { code: 1, result: inspectRes };
      }

      const rawInstall = await installGithubPlugin({
        inspectToken: inspectRes.inspectToken,
        url: rawUrl,
        pluginRoot: inspectRes.plugin.pluginRoot,
        installMode,
        confirmEscalation,
        prefs,
        configDir,
        pluginsDir,
        dataDir,
        fetchImpl,
        ...(githubApiBaseUrl ? { githubApiBaseUrl } : {}),
        nowMs,
      });
      const { _internal: _ignoreInstall, ...installRes } = rawInstall;

      if (installRes.status === 'CONFLICT_CHOICE_REQUIRED') {
        if (asJson) {
          console.log(JSON.stringify(installRes, null, 2));
        } else {
          console.log(
            `! Local plugin conflict with "${installRes.conflict?.dir}" (${installRes.conflict?.scope}).`,
          );
          console.log(`  Run with --isolate to install as "${installRes.scopedFallbackName}"`);
          if (Array.isArray(installRes.choices) && installRes.choices.includes('replace')) {
            console.log('  Or run with --replace to overwrite the existing global plugin');
          }
        }
        return { code: 2, result: installRes };
      }

      if (installRes.status === 'CAPABILITY_ESCALATION_CONFIRM_REQUIRED') {
        if (asJson) {
          console.log(JSON.stringify(installRes, null, 2));
        } else {
          const esc = installRes.escalation || {};
          console.log(
            `! Update ${installRes.installedVersion} -> ${installRes.targetVersion} requests new capabilities:`,
          );
          if (esc.addedBadges?.length) console.log(`  Added badges: ${esc.addedBadges.join(', ')}`);
          if (esc.addedRemoteDomains?.length) console.log(`  Added remote domains: ${esc.addedRemoteDomains.join(', ')}`);
          if (esc.addedHookEvents?.length) console.log(`  Added hook events: ${esc.addedHookEvents.join(', ')}`);
          console.log('  Re-run with --yes to confirm and apply update.');
        }
        return { code: 2, result: installRes };
      }

      if (installRes.ok && installRes.status === 'INSTALLED') {
        const finalPluginsDir = pluginsDir || resolvePluginsDir(configDir);
        const installedPath = join(finalPluginsDir, installRes.installedDir);
        const outputPayload = {
          ...installRes,
          installedPath,
          capabilities: inspectRes.plugin.capabilities,
        };
        if (asJson) {
          console.log(JSON.stringify(outputPayload, null, 2));
        } else {
          console.log(`✓ Installed ${inspectRes.plugin.displayName} (v${installRes.version})`);
          console.log(`  Location:     ${installedPath}`);
          if (inspectRes.plugin.pluginRoot && inspectRes.plugin.pluginRoot !== '.') {
            console.log(`  Subpath:      ${inspectRes.plugin.pluginRoot}`);
          }
          console.log(`  SHA-256:      ${installRes.sha256}`);
          if (installRes.commitSha) console.log(`  Commit:       ${installRes.commitSha.slice(0, 12)}`);
          const badges = inspectRes.plugin.capabilities?.badges || [];
          if (badges.length > 0) console.log(`  Capabilities: ${badges.join(', ')}`);
          if (installRes.sidecarPane?.uri) {
            console.log(`  Open Panel:   [Open](${installRes.sidecarPane.uri})`);
          }
          console.log(`  Manage:       [Manage](${installRes.customizationUri})`);
        }
        return { code: 0, result: outputPayload };
      }

      const failMsg = redactSecret(installRes.error || `Install did not complete (${installRes.status})`, effectiveToken);
      if (asJson) {
        console.log(JSON.stringify({ ok: false, ...installRes, error: failMsg }, null, 2));
      } else {
        console.error(`✗ ${failMsg}`);
      }
      return { code: 1, result: installRes };
    } catch (err) {
      const safeErr = redactSecret(err?.message || String(err), effectiveToken);
      if (asJson) {
        console.log(JSON.stringify({ ok: false, status: 'ERROR', error: safeErr }, null, 2));
      } else {
        console.error(`✗ ${safeErr}`);
      }
      return { code: 1, error: safeErr };
    }
  }

  if (sub === 'uninstall' || sub === 'remove') {
    const targetDir = findFirstPositionalAfterSubcommand(args);
    if (!targetDir) {
      const msg = 'Usage: npx agy-market uninstall <dir> [--yes] [--dest <plugins-dir>] [--json]';
      if (asJson) {
        console.log(JSON.stringify({ ok: false, status: 'INVALID_USAGE', error: msg }, null, 2));
      } else {
        console.error(`✗ ${msg}`);
      }
      return { code: 1 };
    }

    const confirmed = args.includes('--yes') || args.includes('-y');
    const removeFavorite = args.includes('--remove-favorite');
    const resolvedDest = destPluginsDir ? resolve(destPluginsDir) : '';
    const configDir =
      runtimeOpts.configDir ||
      (resolvedDest && basename(resolvedDest).toLowerCase() === 'plugins'
        ? dirname(resolvedDest)
        : resolveAntigravityConfigDir());
    const pluginsDir = runtimeOpts.pluginsDir || resolvedDest || '';
    const dataDir = runtimeOpts.dataDir || resolveMarketDataDir();
    const fetchImpl = runtimeOpts.fetchImpl || fetch;
    const nowMs = runtimeOpts.nowMs ?? Date.now();

    if (targetDir === PLUGIN_ID) {
      const msg = 'ERR_CANNOT_SELF_DELETE: Manage agy-market itself via customization://agy-market';
      if (asJson) {
        console.log(JSON.stringify({ ok: false, status: 'ERROR', error: msg }, null, 2));
      } else {
        console.error(`✗ ${msg}`);
      }
      return { code: 1, error: msg };
    }

    if (!confirmed) {
      const payload = {
        ok: false,
        status: 'CONFIRM_REQUIRED',
        dir: targetDir,
        error: `Re-run with --yes to confirm permanently uninstalling "${targetDir}"`,
      };
      if (asJson) {
        console.log(JSON.stringify(payload, null, 2));
      } else {
        console.log(`! About to permanently uninstall plugin "${targetDir}".`);
        console.log(`  Re-run with --yes to confirm: npx agy-market uninstall ${targetDir} --yes`);
      }
      return { code: 2, result: payload };
    }

    try {
      const res = await uninstallPlugin({
        dir: targetDir,
        configDir,
        pluginsDir,
        dataDir,
        workspaceUris: runtimeOpts.workspaceUris || [],
        builtinPluginsDir: runtimeOpts.builtinPluginsDir || '',
        removeFavorite,
        fetchImpl,
        nowMs,
        rmOverride: runtimeOpts.rmOverride || null,
        unlinkOverride: runtimeOpts.unlinkOverride || null,
        renameOverride: runtimeOpts.renameOverride || null,
        linkInfoOverride: runtimeOpts.linkInfoOverride || null,
      });

      if (res.removed) {
        const payload = {
          ok: true,
          status: res.locked ? 'UNINSTALLED_LOCKED' : 'UNINSTALLED',
          dir: targetDir,
          ...res,
        };
        if (asJson) {
          console.log(JSON.stringify(payload, null, 2));
        } else {
          console.log(`✓ Uninstalled plugin "${targetDir}"`);
          if (res.activation?.reasonEn) {
            console.log(`  Note:         ${res.activation.reasonEn}`);
          }
          if (res.locked && res.retiredBinaries?.length) {
            console.log(`  Retired:      ${res.retiredBinaries.length} locked file(s) scheduled for next-restart cleanup`);
          }
        }
        return { code: 0, result: payload };
      }

      const failErr = res.error || `Plugin "${targetDir}" was not found in global plugins or disabled vault`;
      const payload = {
        ok: false,
        status: res.locked ? 'LOCKED' : 'NOT_FOUND',
        dir: targetDir,
        error: failErr,
        ...res,
      };
      if (asJson) {
        console.log(JSON.stringify(payload, null, 2));
      } else {
        console.error(`✗ ${failErr}`);
      }
      return { code: 1, result: payload };
    } catch (err) {
      const errMsg = err?.message || String(err);
      if (asJson) {
        console.log(JSON.stringify({ ok: false, status: 'ERROR', error: errMsg }, null, 2));
      } else {
        console.error(`✗ ${errMsg}`);
      }
      return { code: 1, error: errMsg };
    }
  }

  if (sub === 'status') {
    const configDir = resolveAntigravityConfigDir();
    const dataDir = resolveMarketDataDir();
    const inv = scanLocalPluginInventory({ configDir, dataDir });
    const summary = {
      ok: true,
      version: PLUGIN_VERSION,
      configDir,
      dataDir,
      installedCount: inv.installed.length,
      plugins: inv.installed.map((p) => ({
        dir: p.dir,
        name: p.name,
        version: p.version,
        enabled: p.enabled,
        managedByMarket: Boolean(p.receipt),
        customizationUri: p.customizationUri,
        sidecarUri: p.sidecarPane?.uri || null,
      })),
    };
    if (asJson) {
      console.log(JSON.stringify(summary, null, 2));
    } else {
      console.log(`${PLUGIN_DISPLAY_NAME} Status`);
      console.log(`  Config Dir: ${configDir}`);
      console.log(`  Data Dir:   ${dataDir}`);
      console.log(`  Installed Plugins (${inv.installed.length}):`);
      for (const p of summary.plugins) {
        console.log(
          `    - ${p.dir} (v${p.version}) [${p.enabled ? 'enabled' : 'disabled'}]${p.managedByMarket ? ' [agy-market]' : ''}`,
        );
      }
    }
    return { code: 0 };
  }

  if (sub === 'doctor') {
    const pluginsDir = destPluginsDir ? resolve(destPluginsDir) : resolvePluginsDir();
    const dataDir = resolveMarketDataDir();
    const selfDir = join(pluginsDir, PLUGIN_ID);
    const swept = sweepRetiredBinaries(dataDir, { pluginsDir });
    const checks = [];

    const nodeMajor = parseInt(process.versions.node.split('.')[0], 10);
    checks.push({ check: 'node>=22', ok: nodeMajor >= 22, detail: process.version });

    const installedExists = existsSync(selfDir);
    const notSymlink = installedExists ? !lstatSync(selfDir).isSymbolicLink() : true;
    checks.push({ check: 'real-directory-no-symlink', ok: notSymlink, detail: selfDir });

    if (installedExists && existsSync(join(selfDir, 'plugin.json'))) {
      const m = parseJsonc(readFileSync(join(selfDir, 'plugin.json'), 'utf8'));
      const unknownKeys = Object.keys(m).filter((k) => !PLUGIN_JSON_ALLOWED_KEYS.has(k));
      checks.push({ check: 'manifest-10-field-purity', ok: unknownKeys.length === 0, detail: unknownKeys.join(',') || 'clean' });
      checks.push({
        check: 'sidecar-ui-built',
        ok: existsSync(join(selfDir, 'sidecars', 'market_pane', 'index.html')),
        detail: 'sidecars/market_pane/index.html',
      });
    }

    const allOk = checks.every((c) => c.ok);
    const report = { ok: allOk, checks, sweptRetiredBinaries: swept };
    if (asJson) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      for (const c of checks) {
        console.log(`${c.ok ? '✓' : '✗'} ${c.check}: ${c.detail}`);
      }
      console.log(`✓ Retired binary GC: removed=${swept.removed}, remaining=${swept.remaining}`);
    }
    return { code: allOk ? 0 : 1 };
  }

  throw new Error(`Unknown subcommand "${sub}". Run "npx agy-market --help".`);
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1] || '')).href) {
  const { code } = await runCli();
  process.exitCode = code;
}
