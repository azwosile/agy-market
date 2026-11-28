// Zero-Dependency HTTP/HTTPS & Windows System Proxy-Aware Fetch (`src/shared/proxy-fetch.mjs`).
//
// Supports:
//   - Environment variables: `HTTPS_PROXY`/`https_proxy`, `HTTP_PROXY`/`http_proxy`, `ALL_PROXY`/`all_proxy`, `NO_PROXY`/`no_proxy`
//   - Windows System Proxy (`HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings`:
//     `ProxyEnable`, `ProxyServer`, `ProxyOverride`) cached for 30s when no env proxy is set
//   - Mandatory bypass for loopback (`127.0.0.1`, `localhost`, `::1`), `file:`, and `NO_PROXY` / `<local>`
//   - HTTPS over HTTP/HTTPS proxy via `CONNECT` tunnel + `tls.connect` (SNI) + `https.request`
//   - HTTP over forward proxy, streaming Web `Response` (`Readable.toWeb`), up to 10 redirects (stripping
//     `Authorization` across origins), and full `AbortSignal` propagation.

import { execFile } from 'node:child_process';
import http from 'node:http';
import https from 'node:https';
import { Readable } from 'node:stream';
import tls from 'node:tls';
import { scrubChildProcessEnv } from './constants.mjs';

const WIN_PROXY_REG_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
const WIN_PROXY_CACHE_TTL_MS = 30_000;
const WIN_PROXY_REG_TIMEOUT_MS = 1500;
const MAX_REDIRECTS = 10;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const NULL_BODY_STATUSES = new Set([204, 205, 304]);

function isLoopbackHost(rawHost) {
  const host = String(rawHost || '')
    .trim()
    .replace(/^\[|\]$/g, '')
    .replace(/\.+$/, '')
    .toLowerCase();
  if (!host) return false;
  if (
    host === 'localhost' ||
    host === 'localhost.localdomain' ||
    host.endsWith('.localhost') ||
    host === '::1' ||
    host === '0:0:0:0:0:0:0:1' ||
    host === '0.0.0.0'
  ) {
    return true;
  }
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

function splitHostAndPort(token) {
  const s = String(token || '').trim();
  if (!s) return { host: '', port: '' };
  if (s.startsWith('[')) {
    const closeIdx = s.indexOf(']');
    if (closeIdx !== -1) {
      const host = s.slice(1, closeIdx).toLowerCase();
      const rest = s.slice(closeIdx + 1);
      const port = rest.startsWith(':') ? rest.slice(1) : '';
      return { host, port };
    }
  }
  const firstColon = s.indexOf(':');
  const lastColon = s.lastIndexOf(':');
  if (firstColon !== -1 && firstColon === lastColon) {
    const maybePort = s.slice(lastColon + 1);
    if (/^\d+$/.test(maybePort)) {
      return { host: s.slice(0, lastColon).toLowerCase(), port: maybePort };
    }
  }
  return { host: s.toLowerCase(), port: '' };
}

/**
 * Parses `NO_PROXY` / Windows `ProxyOverride` into normalized matcher objects.
 */
export function parseNoProxy(rawNoProxy = '') {
  const raw = String(rawNoProxy || '').trim();
  if (!raw) return [];
  const entries = [];
  for (const part of raw.split(/[,;]/)) {
    const token = part.trim();
    if (!token) continue;
    if (token === '*') {
      entries.push({ raw: token, wildcardAll: true, localOnly: false, host: '*', port: '' });
      continue;
    }
    if (token.toLowerCase() === '<local>') {
      entries.push({ raw: token, wildcardAll: false, localOnly: true, host: '<local>', port: '' });
      continue;
    }
    const { host, port } = splitHostAndPort(token);
    if (!host) continue;
    entries.push({ raw: token, wildcardAll: false, localOnly: false, host, port });
  }
  return entries;
}

function matchesNoProxy(urlObj, noProxyEntries) {
  if (!Array.isArray(noProxyEntries) || noProxyEntries.length === 0) return false;
  const host = String(urlObj.hostname || '')
    .replace(/^\[|\]$/g, '')
    .toLowerCase();
  const port = urlObj.port || (urlObj.protocol === 'https:' ? '443' : '80');

  for (const entry of noProxyEntries) {
    if (entry.wildcardAll) return true;
    if (entry.localOnly) {
      if (!host.includes('.') || isLoopbackHost(host)) return true;
      continue;
    }
    if (entry.port && entry.port !== port) continue;

    let pat = entry.host;
    if (pat.startsWith('*.')) {
      pat = pat.slice(1); // treat `*.example.com` as suffix `.example.com`
    }
    if (pat.includes('*')) {
      const escaped = pat.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
      if (new RegExp(`^${escaped}$`, 'i').test(host)) return true;
      continue;
    }
    const base = pat.startsWith('.') ? pat.slice(1) : pat;
    if (!base) continue;
    if (host === base || host.endsWith(`.${base}`)) return true;
  }
  return false;
}

function normalizeHttpProxyUrl(rawProxy) {
  let s = String(rawProxy || '').trim();
  if (!s) return null;
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(s)) {
    s = `http://${s}`;
  }
  try {
    const parsed = new URL(s);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null;
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

/**
 * Parses Windows `ProxyServer` registry value (single host:port or `http=...;https=...`).
 */
export function parseWindowsProxyServer(rawProxyServer, targetProtocol = 'https:') {
  const raw = String(rawProxyServer || '').trim();
  if (!raw) return null;

  if (!raw.includes('=')) {
    return normalizeHttpProxyUrl(raw);
  }

  const byProto = new Map();
  for (const part of raw.split(';')) {
    const item = part.trim();
    const eqIdx = item.indexOf('=');
    if (eqIdx <= 0) continue;
    const scheme = item.slice(0, eqIdx).trim().toLowerCase();
    const addr = item.slice(eqIdx + 1).trim();
    if (addr && !byProto.has(scheme)) {
      byProto.set(scheme, addr);
    }
  }

  const desired = targetProtocol === 'https:' ? 'https' : 'http';
  const picked = byProto.get(desired) || (desired === 'https' ? byProto.get('http') : '') || '';
  return picked ? normalizeHttpProxyUrl(picked) : null;
}

/**
 * Parses `reg.exe query "HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings"` stdout.
 */
export function parseWindowsInternetSettingsOutput(stdout = '') {
  const text = String(stdout || '');
  const enableMatch = /^\s*ProxyEnable\s+REG_DWORD\s+(0x[0-9a-f]+|\d+)/im.exec(text);
  const serverMatch = /^\s*ProxyServer\s+REG_(?:SZ|EXPAND_SZ)\s+(.+)$/im.exec(text);
  const overrideMatch = /^\s*ProxyOverride\s+REG_(?:SZ|EXPAND_SZ)\s+(.+)$/im.exec(text);

  const enabledVal = enableMatch ? Number(enableMatch[1]) : 0;
  const proxyServer = serverMatch ? serverMatch[1].trim() : '';
  const proxyOverride = overrideMatch ? overrideMatch[1].trim() : '';

  return {
    enabled: enabledVal === 1 && Boolean(proxyServer),
    proxyServer,
    proxyOverride,
  };
}

function envProxyForProtocol(protocol, env) {
  const perProtocol = protocol === 'https:' ? env.HTTPS_PROXY || env.https_proxy : env.HTTP_PROXY || env.http_proxy;
  return normalizeHttpProxyUrl(perProtocol) || normalizeHttpProxyUrl(env.ALL_PROXY || env.all_proxy);
}

/**
 * Resolves the effective HTTP/HTTPS proxy URL for `targetUrl`, or `null` when direct connection should be used.
 */
export function resolveProxyUrlForTarget(targetUrl, { env = process.env, winProxyConfig = null } = {}) {
  let urlObj;
  try {
    urlObj = targetUrl instanceof URL ? targetUrl : new URL(String(targetUrl || ''));
  } catch {
    return null;
  }

  if (urlObj.protocol !== 'http:' && urlObj.protocol !== 'https:') {
    return null;
  }
  if (isLoopbackHost(urlObj.hostname)) {
    return null;
  }

  const envObj = env && typeof env === 'object' ? env : {};
  const envProxy = envProxyForProtocol(urlObj.protocol, envObj);
  const rawEnvNoProxy = String(envObj.NO_PROXY || envObj.no_proxy || '').trim();
  const rawWinNoProxy = !envProxy && winProxyConfig?.enabled ? String(winProxyConfig.proxyOverride || '').trim() : '';
  const combinedNoProxy = [rawEnvNoProxy, rawWinNoProxy].filter(Boolean).join(',');

  if (combinedNoProxy && matchesNoProxy(urlObj, parseNoProxy(combinedNoProxy))) {
    return null;
  }

  if (envProxy) return envProxy;

  if (winProxyConfig?.enabled && winProxyConfig.proxyServer) {
    return parseWindowsProxyServer(winProxyConfig.proxyServer, urlObj.protocol);
  }

  return null;
}

function createAbortError(signal) {
  if (signal?.reason instanceof Error) return signal.reason;
  if (typeof signal?.reason === 'string' && signal.reason) {
    const err = new Error(signal.reason);
    err.name = 'AbortError';
    return err;
  }
  return new DOMException('The operation was aborted.', 'AbortError');
}

function toRawHeadersRecord(headersObj) {
  const out = {};
  for (const [k, v] of headersObj.entries()) {
    out[k] = v;
  }
  return out;
}

function toBodyBuffer(body) {
  if (body === undefined || body === null) return null;
  if (Buffer.isBuffer(body)) return body;
  if (typeof body === 'string') return Buffer.from(body, 'utf8');
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  if (ArrayBuffer.isView(body)) return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  return Buffer.from(String(body), 'utf8');
}

function buildProxyAuthHeader(proxyUrlObj) {
  if (!proxyUrlObj.username && !proxyUrlObj.password) return '';
  const user = decodeURIComponent(proxyUrlObj.username || '');
  const pass = decodeURIComponent(proxyUrlObj.password || '');
  return `Basic ${Buffer.from(`${user}:${pass}`, 'utf8').toString('base64')}`;
}

function nodeHeadersToWebHeaders(nodeHeaders = {}) {
  const headers = new Headers();
  for (const [key, val] of Object.entries(nodeHeaders)) {
    if (val === undefined) continue;
    if (Array.isArray(val)) {
      for (const item of val) headers.append(key, String(item));
    } else {
      headers.set(key, String(val));
    }
  }
  return headers;
}

function openConnectTunnel(proxyUrlObj, targetUrlObj, signal) {
  return new Promise((resolveTunnel, rejectTunnel) => {
    if (signal?.aborted) {
      rejectTunnel(createAbortError(signal));
      return;
    }

    const proxyIsHttps = proxyUrlObj.protocol === 'https:';
    const proxyHost = proxyUrlObj.hostname.replace(/^\[|\]$/g, '');
    const proxyPort = Number(proxyUrlObj.port || (proxyIsHttps ? 443 : 80));
    const targetRawHost = targetUrlObj.hostname.replace(/^\[|\]$/g, '');
    const targetAuthorityHost = targetRawHost.includes(':') ? `[${targetRawHost}]` : targetRawHost;
    const targetPort = Number(targetUrlObj.port || 443);
    const authority = `${targetAuthorityHost}:${targetPort}`;

    const headers = { Host: authority };
    const proxyAuth = buildProxyAuthHeader(proxyUrlObj);
    if (proxyAuth) headers['Proxy-Authorization'] = proxyAuth;

    const transport = proxyIsHttps ? https : http;
    let settled = false;
    let connectReq = null;
    let tlsSocket = null;
    let rawSocket = null;

    const cleanupAbort = () => {
      if (signal && onAbort) signal.removeEventListener('abort', onAbort);
    };

    const fail = (err) => {
      if (settled) return;
      settled = true;
      cleanupAbort();
      try {
        tlsSocket?.destroy();
      } catch {
        /* ignore */
      }
      try {
        rawSocket?.destroy();
      } catch {
        /* ignore */
      }
      try {
        connectReq?.destroy();
      } catch {
        /* ignore */
      }
      rejectTunnel(err);
    };

    const onAbort = () => fail(createAbortError(signal));
    if (signal) signal.addEventListener('abort', onAbort, { once: true });

    connectReq = transport.request({
      host: proxyHost,
      port: proxyPort,
      method: 'CONNECT',
      path: authority,
      headers,
      agent: false,
    });

    connectReq.once('error', fail);
    connectReq.once('connect', (connectRes, socket, head) => {
      rawSocket = socket;
      if (settled) {
        socket.destroy();
        return;
      }
      if (connectRes.statusCode !== 200) {
        connectRes.resume?.();
        fail(new Error(`Proxy CONNECT to ${authority} failed with HTTP ${connectRes.statusCode}`));
        return;
      }
      if (head && head.length > 0) {
        socket.unshift(head);
      }

      tlsSocket = tls.connect({
        socket,
        servername: targetRawHost,
      });

      tlsSocket.once('error', fail);
      tlsSocket.once('secureConnect', () => {
        if (settled) {
          tlsSocket.destroy();
          return;
        }
        settled = true;
        cleanupAbort();
        tlsSocket.removeListener('error', fail);
        resolveTunnel(tlsSocket);
      });
    });

    connectReq.end();
  });
}

async function sendSingleProxiedHttpRequest(targetUrlObj, proxyUrlStr, { method, headers, bodyBuf, signal }) {
  if (signal?.aborted) {
    throw createAbortError(signal);
  }

  const proxyUrlObj = new URL(proxyUrlStr);
  const reqHeaders = { ...headers };
  if (bodyBuf && reqHeaders['content-length'] === undefined) {
    reqHeaders['content-length'] = String(bodyBuf.length);
  }

  if (targetUrlObj.protocol === 'https:') {
    const tlsSocket = await openConnectTunnel(proxyUrlObj, targetUrlObj, signal);
    const rawHost = targetUrlObj.hostname.replace(/^\[|\]$/g, '');
    const targetPort = Number(targetUrlObj.port || 443);
    const path = `${targetUrlObj.pathname || '/'}${targetUrlObj.search || ''}`;

    return new Promise((resolveRes, rejectRes) => {
      if (signal?.aborted) {
        tlsSocket.destroy();
        rejectRes(createAbortError(signal));
        return;
      }

      let settled = false;
      const tunnelAgent = new https.Agent({ keepAlive: false });
      tunnelAgent.createConnection = () => tlsSocket;
      const req = https.request({
        hostname: rawHost,
        port: targetPort,
        path,
        method,
        headers: reqHeaders,
        agent: tunnelAgent,
        createConnection: () => tlsSocket,
      });

      const cleanupAbort = () => {
        if (signal && onAbort) signal.removeEventListener('abort', onAbort);
      };
      const fail = (err) => {
        if (settled) return;
        settled = true;
        cleanupAbort();
        try {
          req.destroy();
        } catch {
          /* ignore */
        }
        try {
          tlsSocket.destroy();
        } catch {
          /* ignore */
        }
        rejectRes(err);
      };
      const onAbort = () => fail(createAbortError(signal));
      if (signal) signal.addEventListener('abort', onAbort, { once: true });

      req.once('error', fail);
      req.once('response', (nodeRes) => {
        if (settled) {
          nodeRes.destroy();
          return;
        }
        settled = true;
        cleanupAbort();
        resolveRes({ nodeRes, req });
      });

      if (bodyBuf && bodyBuf.length > 0) req.write(bodyBuf);
      req.end();
    });
  }

  // Forward proxy for `http:` targets
  const proxyIsHttps = proxyUrlObj.protocol === 'https:';
  const proxyHost = proxyUrlObj.hostname.replace(/^\[|\]$/g, '');
  const proxyPort = Number(proxyUrlObj.port || (proxyIsHttps ? 443 : 80));
  const proxyAuth = buildProxyAuthHeader(proxyUrlObj);
  if (proxyAuth) {
    reqHeaders['proxy-authorization'] = proxyAuth;
  }
  if (!reqHeaders.host) {
    reqHeaders.host = targetUrlObj.host;
  }
  const transport = proxyIsHttps ? https : http;

  return new Promise((resolveRes, rejectRes) => {
    if (signal?.aborted) {
      rejectRes(createAbortError(signal));
      return;
    }
    let settled = false;
    const req = transport.request({
      host: proxyHost,
      port: proxyPort,
      path: targetUrlObj.toString(),
      method,
      headers: reqHeaders,
      agent: false,
    });

    const cleanupAbort = () => {
      if (signal && onAbort) signal.removeEventListener('abort', onAbort);
    };
    const fail = (err) => {
      if (settled) return;
      settled = true;
      cleanupAbort();
      try {
        req.destroy();
      } catch {
        /* ignore */
      }
      rejectRes(err);
    };
    const onAbort = () => fail(createAbortError(signal));
    if (signal) signal.addEventListener('abort', onAbort, { once: true });

    req.once('error', fail);
    req.once('response', (nodeRes) => {
      if (settled) {
        nodeRes.destroy();
        return;
      }
      settled = true;
      cleanupAbort();
      resolveRes({ nodeRes, req });
    });

    if (bodyBuf && bodyBuf.length > 0) req.write(bodyBuf);
    req.end();
  });
}

function buildWebResponseFromNodeRes(nodeRes, req, { finalUrl, method, redirected, signal }) {
  const status = nodeRes.statusCode || 200;
  const statusText = nodeRes.statusMessage || '';
  const headers = nodeHeadersToWebHeaders(nodeRes.headers);

  let body = null;
  if (NULL_BODY_STATUSES.has(status) || method === 'HEAD') {
    nodeRes.resume();
  } else {
    if (signal) {
      const onAbort = () => {
        const abortErr = createAbortError(signal);
        try {
          nodeRes.destroy(abortErr);
        } catch {
          /* ignore */
        }
        try {
          req?.destroy(abortErr);
        } catch {
          /* ignore */
        }
      };
      if (signal.aborted) {
        onAbort();
      } else {
        signal.addEventListener('abort', onAbort, { once: true });
        const cleanup = () => signal.removeEventListener('abort', onAbort);
        nodeRes.once('end', cleanup);
        nodeRes.once('close', cleanup);
        nodeRes.once('error', cleanup);
      }
    }
    body = Readable.toWeb(nodeRes);
  }

  const webRes = new Response(body, { status, statusText, headers });
  Object.defineProperty(webRes, 'url', { value: finalUrl, configurable: true });
  Object.defineProperty(webRes, 'redirected', { value: Boolean(redirected), configurable: true });
  return webRes;
}

/**
 * Creates a zero-dependency Web `fetch`-compatible function that honors HTTP/HTTPS/ALL proxy env vars
 * and cached Windows system proxy settings while bypassing loopback (`127.0.0.1`, `localhost`, `::1`),
 * `file:`, and `NO_PROXY` targets.
 */
export function createProxyAwareFetch({
  baseFetch = null,
  env = process.env,
  readWinSystemProxy = true,
  platform = process.platform,
  execFileImpl = execFile,
  nowFn = () => Date.now(),
} = {}) {
  const fallbackFetch = typeof baseFetch === 'function' ? baseFetch : (...args) => globalThis.fetch(...args);

  let winProxyCache = null; // { expiresAtMs, config }
  let winProxyInFlight = null;

  async function getWinProxyConfig(target) {
    if (!readWinSystemProxy || platform !== 'win32') return null;
    let url;
    try { url = new URL(target); } catch { return null; }
    if (!['https:', 'http:'].includes(url.protocol) || isLoopbackHost(url.hostname) || envProxyForProtocol(url.protocol, env)) return null;

    const now = nowFn();
    if (winProxyCache && now < winProxyCache.expiresAtMs) {
      return winProxyCache.config;
    }
    if (winProxyInFlight) return winProxyInFlight;

    winProxyInFlight = new Promise((resolveCfg) => {
      try {
        execFileImpl(
          'reg.exe',
          ['query', WIN_PROXY_REG_KEY],
          {
            env: scrubChildProcessEnv(env),
            timeout: WIN_PROXY_REG_TIMEOUT_MS,
            windowsHide: true,
          },
          (err, stdout) => {
            const cfg = err ? { enabled: false, proxyServer: '', proxyOverride: '' } : parseWindowsInternetSettingsOutput(stdout);
            winProxyCache = {
              expiresAtMs: nowFn() + WIN_PROXY_CACHE_TTL_MS,
              config: cfg,
            };
            resolveCfg(cfg);
          },
        );
      } catch {
        const cfg = { enabled: false, proxyServer: '', proxyOverride: '' };
        winProxyCache = { expiresAtMs: nowFn() + WIN_PROXY_CACHE_TTL_MS, config: cfg };
        resolveCfg(cfg);
      }
    }).finally(() => {
      winProxyInFlight = null;
    });

    return winProxyInFlight;
  }

  return async function proxyAwareFetch(input, init = undefined) {
    const isRequestObj = typeof Request !== 'undefined' && input instanceof Request;
    const rawUrl = isRequestObj ? input.url : String(input instanceof URL ? input.toString() : input || '');
    const winProxyCfg = await getWinProxyConfig(rawUrl);
    const initialProxy = resolveProxyUrlForTarget(rawUrl, { env, winProxyConfig: winProxyCfg });

    if (!initialProxy) {
      return fallbackFetch(input, init);
    }

    const reqHeaders = new Headers(init?.headers || (isRequestObj ? input.headers : undefined));
    let method = String(init?.method || (isRequestObj ? input.method : 'GET') || 'GET').toUpperCase();
    const redirectMode = String(init?.redirect || (isRequestObj ? input.redirect : 'follow') || 'follow').toLowerCase();
    const signal = init?.signal ?? (isRequestObj ? input.signal : undefined);

    let bodyInput = init?.body;
    if (bodyInput === undefined && isRequestObj && input.body) {
      bodyInput = await input.arrayBuffer();
    }
    let bodyBuf = method === 'GET' || method === 'HEAD' ? null : toBodyBuffer(bodyInput);

    let currentUrl = new URL(rawUrl);
    let currentHeaders = toRawHeadersRecord(reqHeaders);
    let currentProxy = initialProxy;
    let redirectCount = 0;

    while (true) {
      if (signal?.aborted) {
        throw createAbortError(signal);
      }

      if (!currentProxy) {
        const directRes = await fallbackFetch(currentUrl.toString(), {
          method,
          headers: currentHeaders,
          ...(bodyBuf ? { body: bodyBuf } : {}),
          redirect: 'manual',
          ...(signal ? { signal } : {}),
        });
        const status = directRes.status;
        const loc = directRes.headers?.get?.('location');
        if (REDIRECT_STATUSES.has(status) && loc) {
          if (redirectMode === 'manual') return directRes;
          if (redirectMode === 'error') throw new TypeError(`Unexpected redirect (status ${status}) in error mode`);
          if (redirectCount >= MAX_REDIRECTS) throw new TypeError(`Too many redirects (${MAX_REDIRECTS})`);

          await directRes.body?.cancel?.().catch(() => {});
          redirectCount += 1;
          const nextUrl = new URL(loc, currentUrl);
          if (nextUrl.origin !== currentUrl.origin) {
            delete currentHeaders.authorization;
            delete currentHeaders.cookie;
          }
          if (status === 303 || ((status === 301 || status === 302) && method === 'POST')) {
            method = 'GET';
            bodyBuf = null;
            delete currentHeaders['content-length'];
            delete currentHeaders['content-type'];
          }
          currentUrl = nextUrl;
          const cfg = await getWinProxyConfig(currentUrl);
          currentProxy = resolveProxyUrlForTarget(currentUrl, { env, winProxyConfig: cfg });
          continue;
        }
        return directRes;
      }

      const { nodeRes, req } = await sendSingleProxiedHttpRequest(currentUrl, currentProxy, {
        method,
        headers: currentHeaders,
        bodyBuf,
        signal,
      });

      const status = nodeRes.statusCode || 200;
      const location = typeof nodeRes.headers?.location === 'string' ? nodeRes.headers.location : '';

      if (REDIRECT_STATUSES.has(status) && location) {
        if (redirectMode === 'manual') {
          return buildWebResponseFromNodeRes(nodeRes, req, {
            finalUrl: currentUrl.toString(),
            method,
            redirected: redirectCount > 0,
            signal,
          });
        }
        nodeRes.resume();
        if (redirectMode === 'error') {
          throw new TypeError(`Unexpected redirect (status ${status}) in error mode`);
        }
        if (redirectCount >= MAX_REDIRECTS) {
          throw new TypeError(`Too many redirects (${MAX_REDIRECTS})`);
        }

        redirectCount += 1;
        const nextUrl = new URL(location, currentUrl);
        if (nextUrl.origin !== currentUrl.origin) {
          delete currentHeaders.authorization;
          delete currentHeaders.cookie;
        }
        if (status === 303 || ((status === 301 || status === 302) && method === 'POST')) {
          method = 'GET';
          bodyBuf = null;
          delete currentHeaders['content-length'];
          delete currentHeaders['content-type'];
        }
        currentUrl = nextUrl;
        const cfg = await getWinProxyConfig(currentUrl);
        currentProxy = resolveProxyUrlForTarget(currentUrl, { env, winProxyConfig: cfg });
        continue;
      }

      return buildWebResponseFromNodeRes(nodeRes, req, {
        finalUrl: currentUrl.toString(),
        method,
        redirected: redirectCount > 0,
        signal,
      });
    }
  };
}

export const defaultProxyFetch = createProxyAwareFetch();
