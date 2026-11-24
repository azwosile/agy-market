// Passive Loopback CDP Sidebar Opener & Native Host Payload Builder (`src/sidecar/open-pane.mjs`).
// Zero external dependencies; read-only discovery (`DevToolsActivePort` / port 9339) with strict 1.5s budget.

import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const DEFAULT_CDP_PORT = 9339;
export const DEFAULT_OPEN_PANE_TIMEOUT_MS = 1500;

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

function isLoopbackHost(hostname) {
  return LOOPBACK_HOSTS.has(String(hostname || '').trim().toLowerCase());
}

/**
 * Normalizes a sibling Sidebar pane request and builds the verified Antigravity host
 * `window.sidecar.ui.toggleAuxPane` payload (`{ tabType: 'sidecarView', uri }`).
 */
export function normalizeOpenPaneRequest(input = {}) {
  const src = input && typeof input === 'object' ? input : {};
  let dir = typeof src.dir === 'string' ? src.dir.trim() : '';
  let sidecarFolder =
    typeof src.sidecarFolder === 'string'
      ? src.sidecarFolder.trim()
      : typeof src.folder === 'string'
        ? src.folder.trim()
        : '';
  const rawViewPath =
    typeof src.viewPath === 'string'
      ? src.viewPath.trim()
      : typeof src.path === 'string'
        ? src.path.trim()
        : '/';
  const normViewPath = rawViewPath ? (rawViewPath.startsWith('/') ? rawViewPath : `/${rawViewPath}`) : '/';
  const viewPathNoLead = normViewPath.replace(/^\/+/, '');
  const rawUri = typeof src.uri === 'string' ? src.uri.trim() : '';

  if ((!dir || !sidecarFolder) && /^sidecar:\/\//i.test(rawUri)) {
    const stripped = rawUri.replace(/^sidecar:\/\//i, '').split('?')[0].split('#')[0];
    const parts = stripped.split('/').filter(Boolean);
    if (!dir && parts[0]) dir = parts[0];
    if (!sidecarFolder && parts.length >= 2) sidecarFolder = parts[1];
  }

  const sidecarId = dir && sidecarFolder ? `${dir}/${sidecarFolder}` : dir || sidecarFolder;
  let uri = '';
  if (/^sidecar:\/\//i.test(rawUri)) {
    const afterScheme = rawUri.replace(/^sidecar:\/\//i, '');
    const qIdx = afterScheme.search(/[?#]/);
    const pathPart = qIdx === -1 ? afterScheme : afterScheme.slice(0, qIdx);
    const suffix = qIdx === -1 ? '' : afterScheme.slice(qIdx);
    const collapsed = pathPart.replace(/\/{2,}/g, '/');
    const segs = collapsed.split('/');
    const normalizedPath = segs.length === 2 && segs[0] && segs[1] ? `${collapsed}/` : collapsed;
    uri = `sidecar://${normalizedPath}${suffix}`;
  } else if (sidecarId) {
    uri = `sidecar://${sidecarId}/${viewPathNoLead}`;
  }
  const title =
    (typeof src.title === 'string' && src.title.trim()) ||
    sidecarFolder ||
    dir ||
    'Sidebar';

  return {
    dir,
    sidecarFolder,
    viewPath: normViewPath,
    title,
    sidecarId,
    uri,
    preloadPayload: {
      tabType: 'sidecarView',
      uri,
    },
  };
}

/** Default read-only candidate locations for Chromium's `DevToolsActivePort` file. */
export function getDefaultDevToolsActivePortFiles() {
  const home = homedir();
  const candidates = [];
  if (process.platform === 'win32') {
    const roaming = process.env.APPDATA || join(home, 'AppData', 'Roaming');
    candidates.push(join(roaming, 'Antigravity', 'DevToolsActivePort'));
  } else if (process.platform === 'darwin') {
    candidates.push(join(home, 'Library', 'Application Support', 'Antigravity', 'DevToolsActivePort'));
  } else {
    const xdg = process.env.XDG_CONFIG_HOME || join(home, '.config');
    candidates.push(join(xdg, 'Antigravity', 'DevToolsActivePort'));
  }
  candidates.push(join(home, '.gemini', 'antigravity', 'DevToolsActivePort'));
  return candidates;
}

/** Read Chromium's `DevToolsActivePort` file read-only if present and valid. */
export function readDevToolsActivePortFile(filePath) {
  if (!filePath) return null;
  try {
    if (!existsSync(filePath)) return null;
    const lines = readFileSync(filePath, 'utf8').split(/\r?\n/);
    const port = Number(String(lines[0] || '').trim());
    if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
    return {
      port,
      browserPath: String(lines[1] || '').trim(),
      file: filePath,
    };
  } catch {
    return null;
  }
}

/** Passively gather candidate loopback CDP ports (active port file first, then fallback 9339). */
export function discoverCandidateCdpPorts(options = {}) {
  const ports = [];
  const pushPort = (p) => {
    const num = Number(p);
    if (Number.isInteger(num) && num > 0 && num <= 65535 && !ports.includes(num)) {
      ports.push(num);
    }
  };

  if (Array.isArray(options.cdpPorts)) {
    for (const p of options.cdpPorts) pushPort(p);
    return ports;
  }

  const files = Array.isArray(options.devToolsActivePortFiles)
    ? options.devToolsActivePortFiles
    : getDefaultDevToolsActivePortFiles();
  for (const file of files) {
    const parsed = readDevToolsActivePortFile(file);
    if (parsed) pushPort(parsed.port);
  }

  if (process.env.ANTIGRAVITY_DEVTOOLS_PORT) {
    pushPort(process.env.ANTIGRAVITY_DEVTOOLS_PORT);
  }

  if (options.includeDefaultPort !== false) {
    pushPort(options.defaultPort ?? DEFAULT_CDP_PORT);
  }
  return ports;
}

/** Score and filter Antigravity Hub top-level page targets (excludes sidecar `plugin://` iframes & splashes). */
export function selectHubTargets(targets = []) {
  const pages = targets.filter((t) => {
    if (!t || t.type !== 'page' || typeof t.webSocketDebuggerUrl !== 'string') return false;
    try {
      const ws = new URL(t.webSocketDebuggerUrl);
      return (ws.protocol === 'ws:' || ws.protocol === 'wss:') && isLoopbackHost(ws.hostname);
    } catch {
      return false;
    }
  });

  const scored = pages
    .map((t) => {
      const url = String(t.url || '');
      const title = String(t.title || '');
      if (/^plugin:\/\//i.test(url) || /^devtools:\/\//i.test(url) || /^data:/i.test(url) || /^about:blank/i.test(url)) {
        return { t, score: -200 };
      }
      let score = 0;
      if (/^https:\/\/127\.0\.0\.1:\d+\//i.test(url)) score += 160;
      else if (/^http:\/\/127\.0\.0\.1:\d+\//i.test(url) && !url.includes('/market_pane')) score += 40;
      if (/monaco-workbench|workbench\.html/i.test(url)) score += 120;
      if (/^vscode-file:\/\//i.test(url)) score += 40;
      if (/antigravity/i.test(title)) score += 50;
      if (/curtain|splash|loading/i.test(title)) score -= 100;
      return { t, score };
    })
    .sort((a, b) => b.score - a.score);

  const high = scored.filter((x) => x.score >= 100).map((x) => x.t);
  if (high.length > 0) return high;
  return scored[0] && scored[0].score > 0 ? [scored[0].t] : [];
}

export function httpGetLoopbackJson(host, port, pathname, timeoutMs) {
  if (!isLoopbackHost(host)) {
    return Promise.reject(new Error(`Refusing non-loopback CDP host: ${host}`));
  }
  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    const req = httpRequest(
      { host, port, path: pathname, method: 'GET', timeout: Math.max(50, timeoutMs) },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          if (settled) return;
          settled = true;
          const text = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode !== 200) {
            rejectPromise(new Error(`HTTP ${res.statusCode}`));
            return;
          }
          try {
            resolvePromise(JSON.parse(text));
          } catch (err) {
            rejectPromise(err);
          }
        });
      },
    );
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      req.destroy(new Error('CDP HTTP timeout'));
      rejectPromise(new Error('CDP HTTP timeout'));
    }, Math.max(50, timeoutMs));
    req.on('timeout', () => {
      req.destroy(new Error('CDP HTTP timeout'));
    });
    req.on('error', (err) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      rejectPromise(err);
    });
    req.on('close', () => clearTimeout(timer));
    req.end();
  });
}

function encodeWsClientTextFrame(text) {
  const payload = Buffer.from(String(text), 'utf8');
  const len = payload.length;
  const mask = randomBytes(4);
  let header;
  if (len < 126) {
    header = Buffer.alloc(6);
    header[0] = 0x81;
    header[1] = 0x80 | len;
    mask.copy(header, 2);
  } else if (len < 65536) {
    header = Buffer.alloc(8);
    header[0] = 0x81;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(len, 2);
    mask.copy(header, 4);
  } else {
    header = Buffer.alloc(14);
    header[0] = 0x81;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(len), 2);
    mask.copy(header, 10);
  }
  const masked = Buffer.allocUnsafe(len);
  for (let i = 0; i < len; i += 1) {
    masked[i] = payload[i] ^ mask[i & 3];
  }
  return Buffer.concat([header, masked]);
}

function encodeWsClientCloseFrame() {
  const mask = randomBytes(4);
  return Buffer.from([0x88, 0x80, mask[0], mask[1], mask[2], mask[3]]);
}

export class EphemeralCdpSession {
  constructor(socket, initialHead = Buffer.alloc(0)) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.closed = false;
    this._rxBuf = initialHead.length > 0 ? Buffer.from(initialHead) : Buffer.alloc(0);
    this._fragChunks = [];

    socket.on('data', (chunk) => {
      this._rxBuf = this._rxBuf.length === 0 ? chunk : Buffer.concat([this._rxBuf, chunk]);
      this._drainFrames();
    });

    const onDone = () => {
      if (this.closed) return;
      this.closed = true;
      for (const { reject } of this.pending.values()) {
        reject(new Error('CDP socket closed'));
      }
      this.pending.clear();
    };
    socket.on('close', onDone);
    socket.on('end', onDone);
    socket.on('error', () => {});
  }

  _drainFrames() {
    while (this._rxBuf.length >= 2) {
      const b0 = this._rxBuf[0];
      const b1 = this._rxBuf[1];
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const isMasked = (b1 & 0x80) !== 0;
      let payloadLen = b1 & 0x7f;
      let offset = 2;

      if (payloadLen === 126) {
        if (this._rxBuf.length < 4) return;
        payloadLen = this._rxBuf.readUInt16BE(2);
        offset = 4;
      } else if (payloadLen === 127) {
        if (this._rxBuf.length < 10) return;
        payloadLen = Number(this._rxBuf.readBigUInt64BE(2));
        offset = 10;
      }

      const maskLen = isMasked ? 4 : 0;
      if (this._rxBuf.length < offset + maskLen + payloadLen) return;

      let body = this._rxBuf.subarray(offset + maskLen, offset + maskLen + payloadLen);
      if (isMasked) {
        const mask = this._rxBuf.subarray(offset, offset + 4);
        const unmasked = Buffer.allocUnsafe(payloadLen);
        for (let i = 0; i < payloadLen; i += 1) unmasked[i] = body[i] ^ mask[i & 3];
        body = unmasked;
      }
      this._rxBuf = this._rxBuf.subarray(offset + maskLen + payloadLen);

      if (opcode === 0x08) {
        this.close();
        return;
      }
      if (opcode === 0x09) {
        const pongMask = randomBytes(4);
        const plen = Math.min(125, body.length);
        const pong = Buffer.alloc(6 + plen);
        pong[0] = 0x8a;
        pong[1] = 0x80 | plen;
        pongMask.copy(pong, 2);
        for (let i = 0; i < plen; i += 1) pong[6 + i] = body[i] ^ pongMask[i & 3];
        try {
          this.socket.write(pong);
        } catch {
          /* ignore */
        }
        continue;
      }
      if (opcode === 0x0a) continue;

      if (opcode === 0x01 || opcode === 0x00) {
        this._fragChunks.push(Buffer.from(body));
        if (!fin) continue;
        const fullText = Buffer.concat(this._fragChunks).toString('utf8');
        this._fragChunks = [];
        this._dispatchMessage(fullText);
      }
    }
  }

  _dispatchMessage(rawText) {
    let msg;
    try {
      msg = JSON.parse(rawText);
    } catch {
      return;
    }
    if (msg.id != null && this.pending.has(msg.id)) {
      const entry = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) entry.reject(new Error(msg.error.message || 'CDP error'));
      else entry.resolve(msg.result);
    }
  }

  static connect(wsUrl, timeoutMs) {
    const u = new URL(wsUrl);
    const host = u.hostname || '127.0.0.1';
    if (!isLoopbackHost(host)) {
      return Promise.reject(new Error(`Refusing non-loopback CDP WebSocket host: ${host}`));
    }
    const port = Number(u.port || 80);
    const pathAndQuery = `${u.pathname || '/'}${u.search || ''}`;
    const wsKey = randomBytes(16).toString('base64');

    return new Promise((resolvePromise, rejectPromise) => {
      let settled = false;
      const req = httpRequest({
        host,
        port,
        path: pathAndQuery,
        method: 'GET',
        headers: {
          Connection: 'Upgrade',
          Upgrade: 'websocket',
          'Sec-WebSocket-Version': '13',
          'Sec-WebSocket-Key': wsKey,
        },
        timeout: Math.max(50, timeoutMs),
      });

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try {
          req.destroy();
        } catch {
          /* ignore */
        }
        rejectPromise(new Error(`CDP WebSocket timeout: ${wsUrl}`));
      }, Math.max(50, timeoutMs));

      req.on('upgrade', (_res, socket, head) => {
        if (settled) {
          try {
            socket.destroy();
          } catch {
            /* ignore */
          }
          return;
        }
        settled = true;
        clearTimeout(timer);
        socket.setNoDelay?.(true);
        resolvePromise(new EphemeralCdpSession(socket, head));
      });

      req.on('response', (res) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        res.resume();
        rejectPromise(new Error(`CDP upgrade rejected (${res.statusCode})`));
      });

      req.on('error', (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        rejectPromise(err);
      });

      req.end();
    });
  }

  send(method, params, timeoutMs) {
    if (this.closed) return Promise.reject(new Error('CDP session closed'));
    const id = this.nextId++;
    return new Promise((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectPromise(new Error(`CDP ${method} timed out`));
      }, Math.max(50, timeoutMs));
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolvePromise(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          rejectPromise(e);
        },
      });
      try {
        this.socket.write(encodeWsClientTextFrame(JSON.stringify({ id, method, params })));
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        rejectPromise(err);
      }
    });
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    try {
      this.socket.write(encodeWsClientCloseFrame());
    } catch {
      /* ignore */
    }
    try {
      this.socket.end();
      setTimeout(() => {
        try {
          this.socket.destroy();
        } catch {
          /* ignore */
        }
      }, 30).unref?.();
    } catch {
      /* ignore */
    }
  }
}

export async function evaluateTargetEphemeral(wsUrl, expression, timeoutMs, wsConnectImpl = EphemeralCdpSession.connect) {
  const startedAt = Date.now();
  const connectBudget = Math.max(80, Math.min(timeoutMs, Math.floor(timeoutMs * 0.5)));
  const session = await wsConnectImpl(wsUrl, connectBudget);
  try {
    const remaining = Math.max(80, timeoutMs - (Date.now() - startedAt));
    const res = await session.send(
      'Runtime.evaluate',
      {
        expression,
        returnByValue: true,
        awaitPromise: true,
        userGesture: true,
      },
      remaining,
    );
    if (res?.exceptionDetails) {
      throw new Error(res.exceptionDetails.exception?.description || res.exceptionDetails.text || 'Evaluate failed');
    }
    return res?.result?.value;
  } finally {
    session.close();
  }
}

/**
 * Builds the Hub-target DOM script that focuses or opens a sibling plugin Sidebar panel:
 *   1. If `[data-testid="sidecar-iframe-slot"][data-sidecar-id="..."][data-visible="true"]` is already visible, focuses it.
 *   2. Triggers Aux Pane `+` (`[data-testid="aux-panel-plus-dropdown-trigger"]`) ->
 *      `Plugins` (`[data-testid="plugins-submenu-trigger"]`) ->
 *      `[data-testid="plugins-submenu-item"][data-sidecar-id="..."]` (or title match).
 *   3. Falls back to clicking any existing rendered `sidecar://` pill link matching the target URI.
 */
export function buildHubOpenPaneExpression({ sidecarId, sidecarFolder, dir, title, uri }) {
  const payloadJson = JSON.stringify({
    sidecarId: String(sidecarId || ''),
    sidecarFolder: String(sidecarFolder || ''),
    dir: String(dir || ''),
    title: String(title || ''),
    uri: String(uri || ''),
  });

  return `(async () => {
    const req = ${payloadJson};
    const norm = (s) => String(s || '').trim().toLowerCase();
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const waitFor = async (fn, maxMs = 320, stepMs = 25) => {
      const deadline = Date.now() + maxMs;
      while (Date.now() <= deadline) {
        const val = fn();
        if (val) return val;
        await sleep(stepMs);
      }
      return fn();
    };
    const firePointerClick = (el) => {
      if (!el) return;
      try { el.focus?.({ preventScroll: true }); } catch {}
      const mouseInit = { bubbles: true, cancelable: true, view: window, button: 0, buttons: 1 };
      if (typeof PointerEvent === 'function') {
        el.dispatchEvent(new PointerEvent('pointerdown', { ...mouseInit, pointerType: 'mouse', isPrimary: true }));
      }
      el.dispatchEvent(new MouseEvent('mousedown', mouseInit));
      if (typeof PointerEvent === 'function') {
        el.dispatchEvent(new PointerEvent('pointerup', { ...mouseInit, buttons: 0, pointerType: 'mouse', isPrimary: true }));
      }
      el.dispatchEvent(new MouseEvent('mouseup', { ...mouseInit, buttons: 0 }));
      el.click();
    };
    const fireHoverOpen = (el) => {
      if (!el) return;
      const init = { bubbles: true, cancelable: true, view: window };
      if (typeof PointerEvent === 'function') {
        el.dispatchEvent(new PointerEvent('pointerenter', { ...init, bubbles: false, pointerType: 'mouse' }));
        el.dispatchEvent(new PointerEvent('pointermove', { ...init, pointerType: 'mouse' }));
      }
      el.dispatchEvent(new MouseEvent('mouseover', init));
      el.dispatchEvent(new MouseEvent('mouseenter', { ...init, bubbles: false }));
      firePointerClick(el);
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
    };

    const matchesSidecarId = (candidate) => {
      const c = norm(candidate);
      if (!c) return false;
      if (req.sidecarId && c === norm(req.sidecarId)) return true;
      if (req.sidecarFolder && c.endsWith('/' + norm(req.sidecarFolder))) return true;
      if (req.dir && (c === norm(req.dir) || c.startsWith(norm(req.dir) + '/'))) return true;
      return false;
    };

    // 1. Already visible in Aux Pane slot
    const slots = Array.from(document.querySelectorAll('[data-testid="sidecar-iframe-slot"]'));
    const visibleSlot = slots.find(
      (el) => el.getAttribute('data-visible') === 'true' && matchesSidecarId(el.getAttribute('data-sidecar-id')),
    );
    if (visibleSlot) {
      const iframe = visibleSlot.querySelector('iframe[data-testid="sidecar-iframe"]');
      try { iframe?.focus?.({ preventScroll: true }); } catch {}
      return { opened: true, detail: 'already-visible', sidecarId: visibleSlot.getAttribute('data-sidecar-id') || req.sidecarId };
    }

    // 2. Aux Pane "+" -> "Plugins" -> matching sidecar menu item
    const findPluginMenuItem = () => {
      const items = Array.from(document.querySelectorAll('[data-testid="plugins-submenu-item"]'));
      const byId = items.find((el) => matchesSidecarId(el.getAttribute('data-sidecar-id')));
      if (byId) return byId;
      const wantTitle = norm(req.title);
      if (!wantTitle) return null;
      return (
        items.find((el) => norm(el.textContent) === wantTitle) ||
        (wantTitle.length >= 3 ? items.find((el) => norm(el.textContent).includes(wantTitle)) : null) ||
        null
      );
    };

    const existingItem = findPluginMenuItem();
    if (existingItem) {
      firePointerClick(existingItem);
      return { opened: true, detail: 'plugins-menu-item', sidecarId: existingItem.getAttribute('data-sidecar-id') || req.sidecarId };
    }

    const plusBtn = document.querySelector('[data-testid="aux-panel-plus-dropdown-trigger"]');
    if (plusBtn) {
      firePointerClick(plusBtn);
      const subOrItem = await waitFor(
        () => findPluginMenuItem() || document.querySelector('[data-testid="plugins-submenu-trigger"]'),
        320,
      );
      if (subOrItem) {
        if (subOrItem.getAttribute('data-testid') === 'plugins-submenu-item') {
          firePointerClick(subOrItem);
          return { opened: true, detail: 'aux-plus-direct-item', sidecarId: subOrItem.getAttribute('data-sidecar-id') || req.sidecarId };
        }
        fireHoverOpen(subOrItem);
        const menuItem = await waitFor(() => findPluginMenuItem(), 340);
        if (menuItem) {
          firePointerClick(menuItem);
          return { opened: true, detail: 'aux-plus-plugins-menu', sidecarId: menuItem.getAttribute('data-sidecar-id') || req.sidecarId };
        }
      }
      // Close dropdown cleanly if target item was not registered in Plugins submenu
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    }

    // 3. Fallback: click an existing rendered sidecar:// pill link in the Hub document if present
    if (req.uri) {
      const wantUri = norm(req.uri).replace(/\\/+$/, '');
      const links = Array.from(document.querySelectorAll('a[href^="sidecar://"]'));
      const matchedLink = links.find((a) => {
        const href = norm(a.getAttribute('href')).replace(/\\/+$/, '');
        return href === wantUri || (req.sidecarId && href.startsWith('sidecar://' + norm(req.sidecarId)));
      });
      if (matchedLink) {
        firePointerClick(matchedLink);
        return { opened: true, detail: 'existing-sidecar-link', sidecarId: req.sidecarId };
      }
    }

    return { opened: false, detail: 'not-found-in-hub-dom' };
  })()`;
}

/**
 * Passively attempts to open/focus a sibling plugin's Sidebar panel via Antigravity's loopback CDP
 * (when available within `timeoutMs = 1500`). Always returns the verified native `preloadPayload`
 * (`{ tabType: 'sidecarView', uri }`) and clean bilingual messages on both success and fallback.
 */
export async function openSiblingSidecarPane(request = {}, options = {}) {
  const norm = normalizeOpenPaneRequest(request);
  const timeoutMs = Math.max(150, Number(options.timeoutMs ?? DEFAULT_OPEN_PANE_TIMEOUT_MS));
  const deadline = Date.now() + timeoutMs;
  const host = options.cdpHost || '127.0.0.1';

  const makeResult = (opened, detail = '') => ({
    ok: true,
    opened: Boolean(opened),
    method: opened ? 'cdp-hub' : 'preload-only',
    preloadPayload: norm.preloadPayload,
    messageZh: opened
      ? `已打开「${norm.title}」侧边栏`
      : `请在右上角「+ → Plugins → ${norm.title}」中打开侧边栏`,
    messageEn: opened
      ? `Opened "${norm.title}" Sidebar panel`
      : `Open "${norm.title}" via "+ → Plugins → ${norm.title}" in the top-right Sidebar`,
    ...(detail ? { detail } : {}),
  });

  if (!norm.uri && !norm.sidecarId) {
    return makeResult(false, 'empty-target');
  }

  const candidatePorts = discoverCandidateCdpPorts(options);
  if (candidatePorts.length === 0) {
    return makeResult(false, 'no-cdp-port');
  }

  const expression = buildHubOpenPaneExpression(norm);
  const httpGetJsonImpl =
    typeof options.httpGetJsonImpl === 'function' ? options.httpGetJsonImpl : httpGetLoopbackJson;
  const wsConnectImpl =
    typeof options.wsConnectImpl === 'function' ? options.wsConnectImpl : EphemeralCdpSession.connect;

  for (const port of candidatePorts) {
    const remainingForList = deadline - Date.now();
    if (remainingForList <= 40) break;

    let targets;
    try {
      const list = await httpGetJsonImpl(host, port, '/json/list', Math.min(remainingForList, 700));
      targets = Array.isArray(list) ? list : [];
    } catch {
      continue;
    }

    const hubTargets = selectHubTargets(targets);
    if (hubTargets.length === 0) continue;

    for (const target of hubTargets) {
      const remainingForEval = deadline - Date.now();
      if (remainingForEval <= 40) break;

      try {
        const evalResult = await evaluateTargetEphemeral(
          target.webSocketDebuggerUrl,
          expression,
          remainingForEval,
          wsConnectImpl,
        );
        if (evalResult && evalResult.opened === true) {
          return makeResult(true, evalResult.detail || 'cdp-hub');
        }
      } catch {
        /* try next target or degrade cleanly */
      }
    }
  }

  return makeResult(false, 'cdp-unavailable-or-unmatched');
}
