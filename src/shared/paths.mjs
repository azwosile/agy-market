// Node-only filesystem path helpers for Antigravity host directories (`src/shared/paths.mjs`).

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
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
