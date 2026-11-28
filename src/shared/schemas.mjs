// JSONC parser, manifest purity sanitizer, prefs store, receipt schema & capability-escalation diff (`src/shared/schemas.mjs`).

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DEFAULT_PREFS,
  MAX_FAVORITES,
  MAX_IGNORED_CONFLICTS,
  PLUGIN_JSON_ALLOWED_KEYS,
  PRIVILEGE_ESCALATION_BADGES,
} from './constants.mjs';

export function parseJsonc(rawText) {
  const src = String(rawText || '').replace(/^\uFEFF/, '');
  let out = '';
  let inStr = false;
  let escaped = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    const next = src[i + 1];
    if (inLineComment) {
      if (ch === '\n') {
        inLineComment = false;
        out += ch;
      }
      continue;
    }
    if (inBlockComment) {
      if (ch === '*' && next === '/') {
        inBlockComment = false;
        i++;
      }
      continue;
    }
    if (inStr) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') {
      inStr = true;
      out += ch;
      continue;
    }
    if (ch === '/' && next === '/') {
      inLineComment = true;
      i++;
      continue;
    }
    if (ch === '/' && next === '*') {
      inBlockComment = true;
      i++;
      continue;
    }
    out += ch;
  }

  return JSON.parse(out.replace(/,\s*([}\]])/g, '$1'));
}

/**
 * Ensures `plugin.json` contains ONLY Antigravity's 10 allowed keys and never leaks `https://` logos.
 */
export function sanitizeNativePluginManifest(rawManifest) {
  if (!rawManifest || typeof rawManifest !== 'object' || Array.isArray(rawManifest)) {
    throw new Error('ERR_MANIFEST_INVALID: plugin.json must be a JSON object');
  }
  const clean = {};
  for (const [key, val] of Object.entries(rawManifest)) {
    if (!PLUGIN_JSON_ALLOWED_KEYS.has(key)) continue;
    if (val === undefined || val === null) continue;
    if (key === 'logo') {
      if (typeof val !== 'string') continue;
      const normLogo = val.trim().replace(/\\/g, '/').replace(/^\.\/+/, '');
      if (
        !normLogo ||
        /^(?:https?:|data:|file:)/i.test(normLogo) ||
        normLogo.startsWith('/') ||
        normLogo.split('/').includes('..')
      ) {
        continue;
      }
      clean.logo = normLogo;
      continue;
    }
    clean[key] = val;
  }
  if (typeof clean.name !== 'string' || !clean.name.trim()) {
    throw new Error('ERR_MANIFEST_NAME: plugin.json requires a non-empty "name"');
  }
  return clean;
}

function sanitizeStringIdList(rawList, maxItems) {
  if (!Array.isArray(rawList)) return [];
  const seen = new Set();
  const out = [];
  for (const entry of rawList) {
    if (typeof entry !== 'string') continue;
    const key = entry.trim();
    if (!key || key.length > 200 || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
    if (out.length >= maxItems) break;
  }
  return out;
}

export function sanitizeFavorites(rawFavorites) {
  return sanitizeStringIdList(rawFavorites, MAX_FAVORITES);
}

export function sanitizeIgnoredConflictIds(rawIds) {
  return sanitizeStringIdList(rawIds, MAX_IGNORED_CONFLICTS);
}

export function sanitizePrefs(input = {}) {
  const src = input && typeof input === 'object' ? input : {};
  const locale = src.locale === 'en' ? 'en' : 'zh';
  const networkMode = ['auto', 'china-mirror', 'direct'].includes(src.networkMode) ? src.networkMode : 'auto';
  const primaryCatalogUrl =
    typeof src.primaryCatalogUrl === 'string' && /^https?:\/\//i.test(src.primaryCatalogUrl.trim())
      ? src.primaryCatalogUrl.trim().replace(/\/+$/, '')
      : DEFAULT_PREFS.primaryCatalogUrl;
  const githubReleaseMirrorPrefix =
    typeof src.githubReleaseMirrorPrefix === 'string' ? src.githubReleaseMirrorPrefix.trim() : '';
  const githubToken = typeof src.githubToken === 'string' ? src.githubToken.trim() : '';
  const customFeeds = Array.isArray(src.customFeeds)
    ? [...new Set(src.customFeeds.map((u) => String(u || '').trim()).filter((u) => /^https?:\/\/|^file:\/\//i.test(u)))]
    : [];
  const favorites = sanitizeFavorites(src.favorites);
  const ignoredConflictIds = sanitizeIgnoredConflictIds(src.ignoredConflictIds);

  return {
    schemaVersion: 1,
    locale,
    enableExperimentalTrack2:
      typeof src.enableExperimentalTrack2 === 'boolean'
        ? src.enableExperimentalTrack2
        : DEFAULT_PREFS.enableExperimentalTrack2,
    networkMode,
    primaryCatalogUrl,
    githubReleaseMirrorPrefix,
    githubToken,
    customFeeds,
    favorites,
    ignoredConflictIds,
  };
}

/**
 * Produces an HTTP-safe prefs projection that never echoes `githubToken` back over localhost HTTP.
 */
export function toPublicPrefs(prefs = {}) {
  const clean = sanitizePrefs(prefs);
  const { githubToken, ...rest } = clean;
  return {
    ...rest,
    hasGithubToken: Boolean(githubToken),
  };
}

/**
 * Computes T+N update capability escalation against `.agy-market-receipt.json`.
 * Triggers user confirmation dialog when a v1 -> v2 update introduces newly ungranted privilege classes
 * or new remote MCP domains.
 */
export function computeCapabilityEscalation(existingReceipt, incomingPlugin) {
  if (!existingReceipt || !existingReceipt.grantedCapabilities) {
    return {
      escalated: false,
      addedBadges: [],
      addedRemoteDomains: [],
      addedHookEvents: [],
    };
  }

  const prevBadges = new Set(existingReceipt.grantedCapabilities.badges || []);
  const prevDomains = new Set(existingReceipt.grantedCapabilities.mcpRemoteDomains || []);
  const prevHooks = new Set(existingReceipt.grantedCapabilities.hookEvents || []);

  const incomingCap = incomingPlugin?.capabilities || {};
  const addedBadges = (incomingCap.badges || []).filter(
    (b) => PRIVILEGE_ESCALATION_BADGES.has(b) && !prevBadges.has(b),
  );
  const addedRemoteDomains = (incomingCap.mcpRemoteDomains || []).filter((d) => !prevDomains.has(d));
  const addedHookEvents = (incomingCap.hookEvents || []).filter((h) => !prevHooks.has(h));

  return {
    escalated: addedBadges.length > 0 || addedRemoteDomains.length > 0 || addedHookEvents.length > 0,
    addedBadges,
    addedRemoteDomains,
    addedHookEvents,
  };
}

/**
 * Loads user preferences from `${dataDir}/prefs.json` with safe schema defaults.
 */
export function loadPrefsFromDisk(dataDir) {
  const prefsPath = join(dataDir, 'prefs.json');
  if (!existsSync(prefsPath)) return sanitizePrefs(DEFAULT_PREFS);
  try {
    return sanitizePrefs(JSON.parse(readFileSync(prefsPath, 'utf8')));
  } catch {
    return sanitizePrefs(DEFAULT_PREFS);
  }
}

/**
 * Atomically saves sanitized user preferences to `${dataDir}/prefs.json` (mode 0600 when `githubToken` is set).
 */
export function savePrefsToDisk(dataDir, nextPrefs) {
  mkdirSync(dataDir, { recursive: true });
  const clean = sanitizePrefs(nextPrefs);
  const tmpPath = join(dataDir, `prefs.json.${process.pid}.${Date.now()}.tmp`);
  const dstPath = join(dataDir, 'prefs.json');
  const writeOpts = clean.githubToken ? { encoding: 'utf8', mode: 0o600 } : { encoding: 'utf8' };
  const serialized = `${JSON.stringify(clean, null, 2)}\n`;
  writeFileSync(tmpPath, serialized, writeOpts);
  try {
    renameSync(tmpPath, dstPath);
  } catch {
    writeFileSync(dstPath, serialized, writeOpts);
    rmSync(tmpPath, { force: true });
  }
  return clean;
}

export function buildInstallReceipt({
  plugin,
  track = 'verified',
  installedDir,
  effectivePluginName,
  scopedRewriteApplied = false,
  previousInstalledAt = null,
  actualSha256 = '',
  preservePaths = null,
  managedFiles = null,
  nowIso = new Date().toISOString(),
}) {
  const cap = plugin?.capabilities || {};
  const hasExplicitGitTag = Boolean(plugin && Object.prototype.hasOwnProperty.call(plugin, 'gitTag'));
  const rawGitTag = hasExplicitGitTag
    ? plugin.gitTag
    : track === 'github-url'
      ? null
      : plugin?.version
        ? `v${plugin.version}`
        : null;
  const gitTag = typeof rawGitTag === 'string' && rawGitTag.trim() ? rawGitTag.trim() : null;
  const commitSha = typeof plugin?.commitSha === 'string' ? plugin.commitSha.trim() : '';
  const repositoryUrl = typeof plugin?.repository?.url === 'string' ? plugin.repository.url.trim() : '';
  const rawPluginRoot = typeof plugin?.repository?.pluginRoot === 'string' ? plugin.repository.pluginRoot.trim() : '.';
  const pluginRoot = rawPluginRoot.replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/\/+$/, '') || '.';
  const githubSource =
    plugin?.githubSource && typeof plugin.githubSource === 'object' ? { ...plugin.githubSource } : null;
  const cleanActualSha256 = typeof actualSha256 === 'string' ? actualSha256.trim().toLowerCase() : '';
  const resolvedSha256 = /^[0-9a-f]{64}$/.test(cleanActualSha256)
    ? cleanActualSha256
    : plugin.distribution?.sha256 || '';

  return {
    schemaVersion: 1,
    id: plugin.id,
    track,
    repositoryId: Number(plugin.repository?.repositoryId || 0),
    installedDir,
    effectivePluginName,
    scopedRewriteApplied: Boolean(scopedRewriteApplied),
    installedVersion: plugin.version,
    gitTag,
    ...(commitSha ? { commitSha } : {}),
    ...(repositoryUrl ? { repositoryUrl } : {}),
    pluginRoot,
    ...(githubSource ? { githubSource } : {}),
    sha256: resolvedSha256,
    preservePaths: Array.isArray(preservePaths)
      ? [...preservePaths]
      : Array.isArray(plugin.distribution?.preservePaths)
        ? [...plugin.distribution.preservePaths]
        : [],
    ...(Array.isArray(managedFiles)
      ? {
          managedFiles: [
            ...new Set(
              managedFiles
                .filter((f) => typeof f === 'string' && f.trim())
                .map((f) => f.trim().replace(/\\/g, '/')),
            ),
          ].sort(),
        }
      : {}),
    grantedCapabilities: {
      badges: Array.isArray(cap.badges) ? [...cap.badges] : [],
      mcpRemoteDomains: Array.isArray(cap.mcpRemoteDomains) ? [...cap.mcpRemoteDomains] : [],
      hookEvents: Array.isArray(cap.hookEvents) ? [...cap.hookEvents] : [],
      ...(Array.isArray(cap.hostEnhancementKind) && cap.hostEnhancementKind.length > 0
        ? { hostEnhancementKind: [...cap.hostEnhancementKind] }
        : {}),
    },
    installedAt: previousInstalledAt || nowIso,
    updatedAt: nowIso,
  };
}
