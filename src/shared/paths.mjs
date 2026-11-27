// Node-only filesystem path helpers for Antigravity host directories (`src/shared/paths.mjs`).

import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PLUGIN_ID, SIDECAR_ID } from './constants.mjs';

export function resolveAntigravityConfigDir(explicitConfigDir = '') {
  if (explicitConfigDir) return resolve(explicitConfigDir);
  if (process.env.ANTIGRAVITY_CONFIG_DIR) return resolve(process.env.ANTIGRAVITY_CONFIG_DIR);
  return join(homedir(), '.gemini', 'config');
}

export function resolvePluginsDir(explicitConfigDir = '') {
  return join(resolveAntigravityConfigDir(explicitConfigDir), 'plugins');
}

export function resolveMarketDataDir(explicitDataDir = '') {
  if (explicitDataDir) return resolve(explicitDataDir);
  if (process.env.AGY_MARKET_DATA_DIR) return resolve(process.env.AGY_MARKET_DATA_DIR);
  if (process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR) return resolve(process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR);
  if (process.env.PLUGIN_DATA) return resolve(process.env.PLUGIN_DATA);
  const home = homedir();
  const antigravityRoot = join(home, '.gemini', 'antigravity');
  const hostSidecarDataDir = join(antigravityRoot, 'sidecar_data', PLUGIN_ID, SIDECAR_ID, 'data');
  if (existsSync(hostSidecarDataDir) || existsSync(antigravityRoot)) {
    return hostSidecarDataDir;
  }
  return join(home, '.gemini', 'sidecar_data', PLUGIN_ID, SIDECAR_ID, 'data');
}

export function resolveDisabledPluginsDir(explicitDataDir = '') {
  return join(resolveMarketDataDir(explicitDataDir), 'disabled-plugins');
}

export function fileUriToLocalPath(uri) {
  if (typeof uri !== 'string' || !uri.startsWith('file://')) return null;
  try {
    return fileURLToPath(uri);
  } catch {
    return null;
  }
}

/**
 * Symlink / Windows NTFS Junction-safe ESM main-module check.
 * Node.js resolves `import.meta.url` to the canonical realpath (e.g. `file:///D:/Antigravity/.gemini/...`),
 * whereas `path.resolve(process.argv[1])` preserves the junction/symlink path (`C:\Users\...\.gemini\...`).
 * Comparing canonicalized realpaths (with case-insensitive fallback on Windows) prevents false negatives
 * that would cause the sidecar or CLI entrypoint to exit prematurely before starting.
 */
export function isMainModule(
  metaUrl,
  argv1 = process.argv[1],
  { realpathFn = realpathSync, platform = process.platform } = {},
) {
  if (!metaUrl || !argv1) return false;
  try {
    const resolvedArgv = resolve(argv1);
    if (metaUrl === pathToFileURL(resolvedArgv).href) return true;

    const metaPath = fileURLToPath(metaUrl);
    const norm = (inputPath) => {
      const r = resolve(inputPath);
      return platform === 'win32' ? r.toLowerCase() : r;
    };

    if (norm(metaPath) === norm(resolvedArgv)) return true;

    const toReal = (inputPath) => {
      try {
        return typeof realpathFn.native === 'function' ? realpathFn.native(inputPath) : realpathFn(inputPath);
      } catch {
        return inputPath;
      }
    };

    const realArgv = toReal(resolvedArgv);
    if (metaUrl === pathToFileURL(realArgv).href) return true;

    const realMeta = toReal(metaPath);
    return norm(realMeta) === norm(realArgv);
  } catch {
    return false;
  }
}
