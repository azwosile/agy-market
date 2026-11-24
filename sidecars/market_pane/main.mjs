#!/usr/bin/env node
// Sidecar Entrypoint (`sidecars/market_pane/main.mjs`) -> Boots 127.0.0.1 HTTP API + serves single-file index.html.

import { readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createMarketSidecarServer } from '../../src/sidecar/server.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_JSON_PATH = resolve(__dirname, '..', '..', 'plugin.json');
const SERVER_ENTRY_PATH = resolve(__dirname, '..', '..', 'src', 'sidecar', 'server.mjs');
const UPDATE_POLL_INTERVAL_MS = 2500;

function readDiskPluginVersion(filePath) {
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
    return typeof parsed?.version === 'string' ? parsed.version.trim() : '';
  } catch {
    return '';
  }
}

function readDiskMtimeMs(filePath) {
  try {
    return statSync(filePath).mtimeMs;
  } catch {
    return 0;
  }
}

function isMainEntry() {
  try {
    return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
  } catch {
    return false;
  }
}

if (isMainEntry()) {
  const instance = await createMarketSidecarServer();
  const bootPluginVersion = readDiskPluginVersion(PLUGIN_JSON_PATH);
  const bootServerMtimeMs = readDiskMtimeMs(SERVER_ENTRY_PATH);
  console.log(`[agy-market/market_pane] listening on ${instance.origin} (pid=${process.pid})`);

  let closing = false;
  let watchTimer = null;
  const shutdown = (exitCode = 0) => {
    if (closing) return;
    closing = true;
    if (watchTimer) {
      clearInterval(watchTimer);
      watchTimer = null;
    }
    instance.close().finally(() => process.exit(exitCode));
  };

  watchTimer = setInterval(() => {
    if (closing) return;
    const currentVersion = readDiskPluginVersion(PLUGIN_JSON_PATH);
    const currentMtimeMs = readDiskMtimeMs(SERVER_ENTRY_PATH);
    const versionChanged = Boolean(bootPluginVersion && currentVersion && currentVersion !== bootPluginVersion);
    const serverChanged = Boolean(bootServerMtimeMs > 0 && currentMtimeMs > 0 && currentMtimeMs !== bootServerMtimeMs);
    if (versionChanged || serverChanged) {
      console.log(
        `[agy-market/market_pane] detected on-disk update (version: ${bootPluginVersion || 'unknown'} -> ${currentVersion || 'unknown'}); exiting to let host restart_policy reload`,
      );
      if (watchTimer) {
        clearInterval(watchTimer);
        watchTimer = null;
      }
      setTimeout(() => shutdown(1), 250).unref?.();
    }
  }, UPDATE_POLL_INTERVAL_MS);
  watchTimer.unref?.();

  process.once('SIGINT', () => shutdown(0));
  process.once('SIGTERM', () => shutdown(0));
}
