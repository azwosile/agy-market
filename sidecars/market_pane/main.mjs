#!/usr/bin/env node
// Sidecar Entrypoint (`sidecars/market_pane/main.mjs`) -> Boots 127.0.0.1 HTTP API + serves single-file index.html.

import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createMarketSidecarServer } from '../../src/sidecar/server.mjs';

function isMainEntry() {
  try {
    return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
  } catch {
    return false;
  }
}

if (isMainEntry()) {
  const instance = await createMarketSidecarServer();
  console.log(`[agy-market/market_pane] listening on ${instance.origin} (pid=${process.pid})`);

  let closing = false;
  const shutdown = () => {
    if (closing) return;
    closing = true;
    instance.close().finally(() => process.exit(0));
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}
