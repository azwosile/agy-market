// Visual AGY Market Sidebar Application (`src/ui/app.mjs`).
// Zero external dependencies; bundled into `sidecars/market_pane/index.html` by `scripts/build.mjs`.

import {
  CAPABILITY_BADGE_SPECS,
  CATEGORY_LABELS,
  PLUGIN_VERSION,
  formatBadgeLabel,
} from '../shared/constants.mjs';
import { sortCatalogPlugins } from '../shared/ranking.mjs';
import { compareSemver, isNewerVersion, stripLeadingV } from '../shared/semver.mjs';
import { BRAND_LOGO_SVG, badgeIcon, icon } from './icons.mjs';
import { escapeHtml, renderSafeMarkdown } from './markdown.mjs';

function stripV(raw) {
  return typeof stripLeadingV === 'function'
    ? stripLeadingV(raw)
    : String(raw ?? '').trim().replace(/^v+/i, '');
}

function formatV(ver) {
  const cleaned = stripV(ver);
  if (!cleaned || cleaned === '?') return '?';
  return `v${cleaned}`;
}

const SELF_OFFER_DISMISSED_KEY = 'agy-market-self-offer-dismissed';
const HERO_COLLAPSED_KEY = 'agy-market-hero-collapsed';
const FAVS_SHELF_COLLAPSED_KEY = 'agy-market-favs-shelf-collapsed';
const SUBMIT_PLUGIN_GUIDE_URL =
  'https://github.com/azwosile/agy-market-catalog/blob/main/docs/SUBMISSION_GUIDE.md';
const ASAR_LABEL = ['app', 'asar'].join('.');
const SELF_FALLBACK_DESC = Object.freeze({
  zh: 'Google Antigravity 社区插件市场侧边栏，支持镜像下载校验、本地冲突检查与一键安装更新。',
  en: 'Community plugin marketplace Sidebar panel & CLI for Google Antigravity with SHA-256 archive verification, conflict checks, and one-click updates.',
});
const STALE_SELF_DESC_RE = new RegExp(
  [
    ['\u96f6', '\\s*', 'token'].join(''),
    ['0', '\\s*', 'token'].join(''),
    ['zero', '-', 'token'].join(''),
    '\u9632\u7be1\u6539',
  ].join('|'),
  'i',
);

function readStorage(key, fallback = '') {
  try {
    return window.localStorage?.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

function writeStorage(key, value) {
  try {
    if (value === null || value === undefined || value === '') {
      window.localStorage?.removeItem(key);
    } else {
      window.localStorage?.setItem(key, String(value));
    }
  } catch {
    /* storage unavailable */
  }
}

const CATEGORY_ACCENTS = Object.freeze({
  'monitoring-quota': { a1: '#06b6d4', a2: '#3b82f6' },
  'context-cache': { a1: '#14b8a6', a2: '#6366f1' },
  'ui-themes': { a1: '#a855f7', a2: '#ec4899' },
  'agents-reasoning': { a1: '#8b5cf6', a2: '#f43f5e' },
  'developer-tools': { a1: '#6366f1', a2: '#06b6d4' },
  'mcp-integrations': { a1: '#f59e0b', a2: '#f97316' },
  'skills-workflows': { a1: '#10b981', a2: '#34d399' },
  productivity: { a1: '#38bdf8', a2: '#14b8a6' },
  'data-science': { a1: '#3b82f6', a2: '#8b5cf6' },
  'cloud-devops': { a1: '#06b6d4', a2: '#3b82f6' },
  'creative-media': { a1: '#ec4899', a2: '#f97316' },
  'writing-knowledge': { a1: '#8b5cf6', a2: '#38bdf8' },
  automation: { a1: '#eab308', a2: '#10b981' },
  security: { a1: '#f43f5e', a2: '#f59e0b' },
  other: { a1: '#6366f1', a2: '#38bdf8' },
});

const CONFLICT_LAYER_META = Object.freeze({
  'duplicate-plugin-name': {
    zh: '同名插件冲突',
    en: 'Duplicate Plugin Name',
    descZh: '检测跨作用域相同 plugin.json.name 导致的加载冲突',
    descEn: 'Detects duplicate plugin.json.name across scopes',
  },
  'windows-symlink-ignored': {
    zh: 'Windows 符号链接失效',
    en: 'Windows Symlink Ignored',
    descZh: '检测被 Antigravity 宿主跳过的 Junction / 符号链接目录',
    descEn: 'Detects NTFS symlinks/junctions skipped by Antigravity on Windows',
  },
  'mcp-collision': {
    zh: 'MCP 服务名冲突',
    en: 'MCP Server Collision',
    descZh: '检测插件与全局 mcp_config.json 间重名或通用服务名',
    descEn: 'Detects overlapping or generic bare MCP server keys',
  },
  'skill-shadowing': {
    zh: 'Skill 技能覆盖',
    en: 'Skill Shadowing',
    descZh: '检测多插件或全局 skills/ 中同名 SKILL.md 重名覆盖',
    descEn: 'Detects duplicate SKILL.md names shadowing across plugins',
  },
  'agent-shadowing': {
    zh: 'Subagent 重名覆盖',
    en: 'Subagent Shadowing',
    descZh: '检测自定义 Subagent 与内置或其他插件代理名冲突',
    descEn: 'Detects subagent filename/name collisions across plugins',
  },
  'host-enhancement-overlap': {
    zh: '宿主界面增强叠加',
    en: 'Host Enhancement Overlap',
    descZh: `检测多个启用插件同时使用 ${ASAR_LABEL} 或 CDP 界面增强`,
    descEn: `Detects >=2 active plugins sharing ${ASAR_LABEL} or CDP skins`,
  },
});

const state = {
  loading: false, // loadState(false) sets loading=true synchronously on boot; default false keeps idle VM harnesses unlocked
  busyId: '',
  togglingDir: '',
  fixingKey: '',
  removingDir: '',
  activeTab: 'discover', // 'discover' | 'favorites' | 'installed' | 'conflicts' | 'sources'
  search: '',
  category: 'all',
  sortBy: 'recommended', // 'recommended' | 'stars' | 'updated' | 'name'
  heroCollapsed: readStorage(HERO_COLLAPSED_KEY, '0') === '1',

  // Favorites state (synced with `prefs.favorites` via `POST /api/favorites`)
  favorites: [],
  favoritesShelfCollapsed: readStorage(FAVS_SHELF_COLLAPSED_KEY, '0') === '1',
  favoritesSearch: '',
  favoritesSortBy: 'added', // 'added' | 'stars' | 'name'

  // Installed view live search & status filter
  installedSearch: '',
  installedFilter: 'all', // 'all' | 'enabled' | 'disabled' | 'updatable'

  serverState: null,
  workspaceUris: [],

  // Auto update check state (`GET /api/updates?force=0|1`)
  updates: {
    loading: false,
    checkedAt: '',
    items: [],
    selfUpdate: null,
    rateLimited: false,
    warnings: [],
    error: '',
  },
  verifiedLatestDirs: new Set(),
  dismissedSelfVersion: readStorage(SELF_OFFER_DISMISSED_KEY, ''),
  selfUpdateBusy: false,
  selfChangelogModal: false,
  scrolledStuck: false,

  // Local conflict check state (`GET /api/conflicts`)
  conflicts: {
    loading: false,
    loaded: false,
    data: null, // { ok, checkedAt, summary, items }
    error: '',
  },

  // Dismissible Smart Restart / Reload Banner (shown ONLY after a completed install/update/uninstall/toggle)
  restartBanner: null, // null | { level: 'host-restart'|'reload-pane', operation: 'install'|'update'|'uninstall'|'toggle', plugins: string[], reasons: string[] }

  // Dismissible Tier-0 Opt-In Public-Repo Nomination Banner (zero PII; shown only after unlisted public GitHub URL install)
  nominationBanner: null, // null | { displayName, repo, pluginRoot, issueUrl }

  // Prominent Red Error Alert Banner (shown whenever install / update / update-all / self-update / uninstall fails)
  errorBanner: null, // null | { title, items: [{ pluginName, message }], retryAction }

  // Batch update state (`POST /api/update-all`)
  batchUpdating: false,
  batchTargetIds: [],
  batchResults: null,

  // Reconnect overlay after `POST /api/self-update`
  reconnecting: null,

  // Slide-over detail drawer
  detailPlugin: null,
  detailTab: 'overview', // 'overview' | 'changelog' | 'capabilities' | 'discuss'
  detailReadme: '',
  detailReadmeLoading: false,
  detailReadmeLocale: 'zh',
  detailReadmeIsZh: false,
  discussionsCache: {},

  // Modals
  githubUrlModal: null, // null | { phase, url, inspectToken, selectedPluginRoot, installMode, confirmEscalation, inspectResult, subpathCandidates, error }
  conflictModal: null,
  escalationModal: null,
  removeConfirmModal: null, // null | { dir, displayName, version, isFavorited, removeFavorite }

  // Clean Feedback Toast
  toast: null, // null | { message, subtext?, tone }
  copiedKey: '',
  focusTokenField: false,
  focusGithubUrlInput: false,
};

let toastTimer = null;
let reconnectTimer = null;
let updatesRequestSeq = 0;
let readmeRequestSeq = 0;
let githubInspectSeq = 0;
let lastForcedUpdatesAt = 0;

function isSelfBannerVisible() {
  const su = state.updates.selfUpdate;
  if (!su) return false;
  const selfLoc = getGlobalInstalledByDirMap().get('agy-market') || null;
  const fromV = stripV(selfLoc?.version || state.serverState?.plugin?.version || su.installedVersion || '');
  const toV = stripV(su.latestVersion || '');
  if (!toV || !fromV || toV === '?' || fromV === '?' || !isNewerVersion(toV, fromV)) return false;
  return !state.dismissedSelfVersion || String(state.dismissedSelfVersion) !== String(su.latestVersion || '');
}

function isUpdateCheckBusy() {
  return Boolean(state.updates.loading || state.loading);
}

function isPluginMutationBusy() {
  return Boolean(
    state.busyId ||
      state.batchUpdating ||
      state.selfUpdateBusy ||
      state.removingDir ||
      (state.githubUrlModal && state.githubUrlModal.phase === 'installing'),
  );
}

function isUpdateActionLocked() {
  return isUpdateCheckBusy() || isPluginMutationBusy();
}

function getBootToken() {
  const params = new URLSearchParams(window.location.search);
  return params.get('token') || window.__SIDECAR_BOOT__?.token || '';
}

function getFetchImpl() {
  return (
    window.sidecar?.__marketFetch ||
    window.sidecar?.fetch?.bind(window.sidecar) ||
    window.fetch.bind(window)
  );
}

async function apiFetch(path, { method = 'GET', body = null } = {}) {
  const token = getBootToken();
  const headers = {};
  if (token) headers['X-Sidecar-Token'] = token;
  if (body !== null) headers['Content-Type'] = 'application/json';

  const fn = getFetchImpl();
  const res = await fn(path, {
    method,
    headers,
    body: body !== null ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
  if (!res.ok && !data.status && !Array.isArray(data.results)) {
    throw new Error(data.error || `HTTP ${res.status}`);
  }
  return data;
}

function getLocale() {
  return state.serverState?.prefs?.locale === 'en' ? 'en' : 'zh';
}

function t(zh, en) {
  return getLocale() === 'en' ? en : zh;
}

function hasCjk(str) {
  return /[\u4e00-\u9fff]/.test(String(str || ''));
}

function isSafeHttpUrl(url) {
  const s = String(url || '').trim();
  return /^https?:\/\/[^\s]+$/i.test(s);
}

function showToast(message, { subtext = '', tone = 'info', durationMs = 5000 } = {}) {
  state.toast = { message, subtext, tone };
  render();
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    if (state.toast?.message === message) {
      state.toast = null;
      render();
    }
  }, durationMs);
}

function setErrorBanner({ title = '', items = [], retryAction = null } = {}) {
  const cleanItems = (Array.isArray(items) ? items : [])
    .filter((it) => it && (it.message || it.pluginName))
    .map((it) => ({
      pluginName: String(it.pluginName || '').trim(),
      message: String(it.message || '').trim() || t('未知错误', 'Unknown error'),
    }));
  state.errorBanner = {
    title: title || t('操作未能完成', 'Operation Failed'),
    items: cleanItems,
    retryAction: retryAction || null,
  };
}

function syncFavoritesFromServerState() {
  const favs = state.serverState?.prefs?.favorites;
  if (Array.isArray(favs)) {
    state.favorites = [...new Set(favs.map((x) => String(x || '').trim()).filter(Boolean))];
  }
}

function getLocalFavoriteKey(loc, catEntry = null) {
  if (catEntry?.id) return String(catEntry.id);
  if (loc?.receipt?.id) return String(loc.receipt.id);
  return loc?.dir ? `local:${loc.dir}` : '';
}

function isFavoritedKey(key) {
  return Boolean(key && state.favorites.includes(key));
}

function isPluginDirFavorited(dir, extraFavKey = '') {
  if (extraFavKey && isFavoritedKey(extraFavKey)) return true;
  const cleanDir = String(dir || '').trim();
  if (!cleanDir) return false;
  if (isFavoritedKey(`local:${cleanDir}`) || isFavoritedKey(cleanDir)) return true;
  const loc = getInstalledByDirMap().get(cleanDir) || null;
  const { byId: catById, byDir: catByDir } = getCatalogMaps();
  const catEntry = (loc?.receipt?.id && catById.get(loc.receipt.id)) || catByDir.get(cleanDir) || null;
  if (catEntry?.id && isFavoritedKey(catEntry.id)) return true;
  if (loc?.receipt?.id && isFavoritedKey(loc.receipt.id)) return true;
  return false;
}

function isDirectGithubUpdateItem(upd) {
  if (!upd) return false;
  return (
    upd.updateChannel === 'github-upstream' ||
    upd.updateChannel === 'github-url' ||
    upd.source === 'github-release' ||
    upd.source === 'github-tag' ||
    upd.source === 'github-branch'
  );
}

function formatCategoryLabel(catId, locale = getLocale()) {
  const key = String(catId || '').trim();
  if (!key) return '';
  const entry = CATEGORY_LABELS[key];
  if (entry) return locale === 'en' ? entry.en || entry.zh || key : entry.zh || entry.en || key;
  return key;
}

function renderCategoryTagsHtml(categories = [], { maxCount = 2, clickable = false } = {}) {
  const list = (Array.isArray(categories) ? categories : []).filter(Boolean);
  if (!list.length) return '';
  const shown = maxCount > 0 ? list.slice(0, maxCount) : list;
  return shown
    .map((catId) => {
      const label = formatCategoryLabel(catId);
      const accent = CATEGORY_ACCENTS[catId] || CATEGORY_ACCENTS.other;
      const styleAttr = `style="--cat-dot:${accent.a1}"`;
      if (clickable) {
        return `<button type="button" class="cat-tag-pill is-clickable" ${styleAttr} data-action="category" data-category="${escapeHtml(catId)}" data-stop-card="1" title="${escapeHtml(t(`筛选分类：${label}`, `Filter by ${label}`))}"><span class="cat-tag-dot" aria-hidden="true"></span><span>${escapeHtml(label)}</span></button>`;
      }
      return `<span class="cat-tag-pill" ${styleAttr}><span class="cat-tag-dot" aria-hidden="true"></span><span>${escapeHtml(label)}</span></span>`;
    })
    .join('');
}

function getUiBadgeSpec(badgeId) {
  const base = CAPABILITY_BADGE_SPECS[badgeId] || { tone: 'subtle', descZh: badgeId, descEn: badgeId };
  if (badgeId === 'sidecar-ui') {
    return {
      ...base,
      zh: 'Sidebar 侧边栏',
      en: 'Sidebar Panel',
      descZh: '在右侧 Sidebar 辅助栏提供可视化交互界面。',
      descEn: 'Provides a visual interactive panel in the right Sidebar.',
    };
  }
  if (badgeId === 'declarative-only') {
    return {
      ...base,
      zh: '纯声明式技能',
      en: 'Declarative Skill',
    };
  }
  return base;
}

function formatRelativeTime(isoStr) {
  if (!isoStr) return '';
  const ts = Date.parse(isoStr);
  if (!Number.isFinite(ts)) return '';
  const diffSec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (diffSec < 60) return t('刚刚', 'just now');
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return t(`${diffMin} 分钟前`, `${diffMin}m ago`);
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return t(`${diffHr} 小时前`, `${diffHr}h ago`);
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 30) return t(`${diffDay} 天前`, `${diffDay}d ago`);
  const diffMon = Math.floor(diffDay / 30);
  if (diffMon < 12) return t(`${diffMon} 个月前`, `${diffMon}mo ago`);
  const diffYr = Math.floor(diffMon / 12);
  return t(`${diffYr} 年前`, `${diffYr}y ago`);
}

function cleanBadgeText(badgeId, capabilities = {}) {
  if (badgeId === 'sidecar-ui') return t('Sidebar 侧边栏', 'Sidebar Panel');
  if (badgeId === 'declarative-only') return t('纯声明式技能', 'Declarative Skill');
  const raw = formatBadgeLabel(badgeId, capabilities, getLocale());
  return String(raw || badgeId).replace(/^[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\uFE0F\s]+/u, '').trim();
}

function deriveDiscussionsUrl(repoUrl) {
  const clean = String(repoUrl || '').trim().replace(/\.git$/i, '').replace(/\/+$/, '');
  if (/^https?:\/\/github\.com\/[^/]+\/[^/]+$/i.test(clean)) {
    return `${clean}/discussions`;
  }
  return '';
}

function resolveCardAccent(pluginOrLocal, catEntry = null) {
  const cats = catEntry?.taxonomy?.categories || pluginOrLocal?.taxonomy?.categories || [];
  if (cats.length && CATEGORY_ACCENTS[cats[0]]) {
    return CATEGORY_ACCENTS[cats[0]];
  }
  const badges = catEntry?.capabilities?.badges || pluginOrLocal?.capabilities?.badges || [];
  if (badges.includes('host-enhancement')) return CATEGORY_ACCENTS['ui-themes'];
  if (badges.includes('mcp-stdio') || badges.includes('mcp-remote')) return CATEGORY_ACCENTS['mcp-integrations'];
  if (badges.includes('sidecar-ui')) return CATEGORY_ACCENTS['developer-tools'];
  if (badges.includes('declarative-only')) return CATEGORY_ACCENTS['skills-workflows'];
  return CATEGORY_ACCENTS.other;
}

function resolveActivationInfo(sourceObj, capabilitiesFallback = {}) {
  const act = sourceObj?.activation;
  if (act && typeof act === 'object' && act.level) {
    return act;
  }
  const cap = sourceObj?.capabilities || capabilitiesFallback || {};
  const badges = Array.isArray(cap.badges) ? cap.badges : [];
  const hostKinds = Array.isArray(cap.hostEnhancementKind) ? cap.hostEnhancementKind : [];

  if (hostKinds.includes('app-asar')) {
    return {
      level: 'host-restart',
      reasonZh: `包含 ${ASAR_LABEL} 界面补丁，更新后需重启 Antigravity 客户端生效`,
      reasonEn: `Includes ${ASAR_LABEL} UI patch; restart Antigravity to take effect`,
    };
  }
  if (hostKinds.includes('cdp') || badges.includes('host-enhancement')) {
    return {
      level: 'host-restart',
      reasonZh: '包含 CDP 界面增强，更新后需带调试端口重启 Antigravity 客户端生效',
      reasonEn: 'Uses CDP UI enhancement; restart Antigravity with debug port to apply',
    };
  }
  if (
    badges.includes('sidecar-ui') ||
    badges.includes('mcp-stdio') ||
    badges.includes('mcp-remote') ||
    badges.includes('lifecycle-hooks')
  ) {
    return {
      level: 'reload-pane',
      reasonZh: '包含 Sidebar 侧边栏、MCP 进程或生命周期钩子，更新后建议重开侧边栏或刷新 MCP 连接',
      reasonEn: 'Includes Sidebar panel, MCP server, or hooks; reopen Sidebar or refresh MCP',
    };
  }
  return {
    level: 'instant',
    reasonZh: '纯声明式技能或规则，安装更新后即刻生效',
    reasonEn: 'Pure declarative skills/rules — active immediately after update',
  };
}

function maybeTriggerRestartBanner({
  pluginName = '',
  operation = 'update',
  restartRequired = false,
  reloadRequired = false,
  retiredBinaries = [],
  lockedOnDisable = false,
  lockedOnRemove = false,
  activation = null,
} = {}) {
  const hasRetired = Array.isArray(retiredBinaries) && retiredBinaries.length > 0;
  const isLocked = Boolean(lockedOnDisable || lockedOnRemove || hasRetired);
  const op = operation || 'update';
  let level = '';
  let reason = '';

  if (restartRequired || isLocked || activation?.level === 'host-restart') {
    level = 'host-restart';
    if (isLocked) {
      reason =
        (getLocale() === 'en' ? activation?.reasonEn : activation?.reasonZh) ||
        (op === 'uninstall'
          ? t(
              '插件清单已摘除，部分被后台进程占用的旧文件将在重启 Antigravity 客户端后自动回收清理。',
              'Manifest removed; locked files will be cleaned up automatically after restarting Antigravity.',
            )
          : t(
              'Windows 后台进程句柄占用（已安全退役旧二进制），重启 Antigravity 客户端后即可完全释放生效。',
              'Windows background binary handle lock detected; restart Antigravity to fully release and apply.',
            ));
    } else {
      reason =
        (getLocale() === 'en' ? activation?.reasonEn : activation?.reasonZh) ||
        (op === 'uninstall'
          ? t(
              `已卸载涉及 ${ASAR_LABEL} 界面补丁或 CDP 宿主增强的插件，请重启 Antigravity 客户端以彻底释放残留状态。`,
              `Uninstalled plugin with ${ASAR_LABEL} or CDP host enhancements; restart Antigravity to release remaining state.`,
            )
          : t(
              `该插件涉及 ${ASAR_LABEL} 界面补丁或 CDP 调试端口宿主增强，请重启 Antigravity 客户端生效。`,
              `This plugin modifies ${ASAR_LABEL} or CDP host enhancements; restart Antigravity to apply.`,
            ));
    }
  } else if (reloadRequired || activation?.level === 'reload-pane') {
    level = 'reload-pane';
    reason =
      (getLocale() === 'en' ? activation?.reasonEn : activation?.reasonZh) ||
      (op === 'uninstall'
        ? t(
            '已卸载包含 Sidebar 侧边栏、MCP 服务或钩子的插件，建议关闭对应侧边栏或刷新 MCP 列表。',
            'Uninstalled plugin with Sidebar panel, MCP server, or hooks; close its Sidebar or refresh MCP.',
          )
        : t(
            '该插件包含 Sidebar 侧边栏、MCP 服务或钩子，建议重开对应侧边栏或刷新 MCP 列表。',
            'This plugin includes a Sidebar panel, MCP server, or hooks; reopen Sidebar or refresh MCP.',
          ));
  }

  if (!level) return null;

  const existing = state.restartBanner;
  const sameOp = existing && existing.operation === op;
  const nextLevel =
    (sameOp && existing.level === 'host-restart') || level === 'host-restart' ? 'host-restart' : 'reload-pane';
  const plugins = [...new Set([...(sameOp ? existing.plugins || [] : []), ...(pluginName ? [pluginName] : [])])];
  const reasons = [...new Set([...(sameOp ? existing.reasons || [] : []), ...(reason ? [reason] : [])])];
  state.restartBanner = { level: nextLevel, operation: op, plugins, reasons };
  return { level, reason };
}

function isSelfPluginIdentity(pluginOrCat, loc = null) {
  return Boolean(
    pluginOrCat?.id === 'azwosile__agy-market' ||
      pluginOrCat?.canonicalName === 'agy-market' ||
      pluginOrCat?.installStatus?.installedDir === 'agy-market' ||
      loc?.dir === 'agy-market',
  );
}

function sanitizeSelfDescription(text, locale = getLocale()) {
  const s = String(text || '').trim();
  if (s && STALE_SELF_DESC_RE.test(s)) {
    return locale === 'en' ? SELF_FALLBACK_DESC.en : SELF_FALLBACK_DESC.zh;
  }
  return s;
}

function resolveCatalogDescription(plugin, locale = getLocale()) {
  const rawDesc =
    typeof plugin?.description === 'object'
      ? plugin.description[locale] || plugin.description.zh || plugin.description.en || ''
      : String(plugin?.description || '');
  return isSelfPluginIdentity(plugin) ? sanitizeSelfDescription(rawDesc, locale) : rawDesc;
}

function resolveInstalledDescription(loc, catEntry) {
  const locale = getLocale();
  const catDescObj = catEntry && typeof catEntry.description === 'object' ? catEntry.description : null;
  const catZh = catDescObj ? String(catDescObj.zh || '').trim() : '';
  const catEn = catDescObj
    ? String(catDescObj.en || '').trim()
    : typeof catEntry?.description === 'string'
      ? catEntry.description.trim()
      : '';
  const locDesc = String(loc?.description || '').trim();

  let resolved = '';
  if (locale === 'zh') {
    if (catZh) resolved = catZh;
    else if (locDesc && hasCjk(locDesc)) resolved = locDesc;
    else if (locDesc) resolved = locDesc;
    else resolved = catEn;
  } else {
    resolved = catEn || locDesc || catZh;
  }

  return isSelfPluginIdentity(catEntry, loc) ? sanitizeSelfDescription(resolved, locale) : resolved;
}

function getGlobalInstalledByDirMap() {
  const byDir = new Map();
  for (const loc of state.serverState?.installed || []) {
    if (loc && loc.dir && loc.scope === 'global') {
      byDir.set(loc.dir, loc);
    }
  }
  return byDir;
}

function isUpdateEffectiveForLocal(upd, loc = null) {
  if (!upd) return false;
  if (loc) {
    if (loc.scope && loc.scope !== 'global') return false;
    if (upd.dir && loc.dir && upd.dir !== loc.dir) return false;
  }
  const isCommit = upd.updateKind === 'commit';
  if (isCommit) {
    const instSha = String(upd.installedCommitSha || '').trim().toLowerCase();
    const latestSha = String(upd.latestCommitSha || '').trim().toLowerCase();
    if (
      !instSha ||
      !latestSha ||
      instSha === latestSha ||
      instSha.startsWith(latestSha) ||
      latestSha.startsWith(instSha)
    ) {
      return false;
    }
    const localSha = String(loc?.receipt?.commitSha || '').trim().toLowerCase();
    if (localSha) {
      const targetRef = String(upd.targetRef || '').trim().toLowerCase();
      const targetRefIsSha = /^[0-9a-f]{7,40}$/i.test(targetRef);
      if (
        localSha === latestSha ||
        localSha.startsWith(latestSha) ||
        latestSha.startsWith(localSha) ||
        (targetRefIsSha && (localSha === targetRef || localSha.startsWith(targetRef) || targetRef.startsWith(localSha)))
      ) {
        return false;
      }
    }
    return true;
  }
  const rawCurVer = loc?.version && loc.version !== '?' ? loc.version : upd.installedVersion || '';
  const curVer = stripV(rawCurVer);
  const latestVer = stripV(upd.latestVersion || '');
  if (!latestVer || !curVer || latestVer === '?' || curVer === '?') return false;
  return isNewerVersion(latestVer, curVer);
}

function findUpdateForLocal(loc, updById, updByDir) {
  if (!loc || loc.scope !== 'global') return null;
  const dir = String(loc.dir || '').trim();
  if (dir && state.verifiedLatestDirs.has(dir)) return null;
  const candidates = [];
  if (dir && updByDir?.has(dir)) {
    candidates.push(updByDir.get(dir));
  }
  const receiptId = String(loc.receipt?.id || '').trim();
  if (receiptId && updById?.has(receiptId)) {
    const byIdCand = updById.get(receiptId);
    if (byIdCand && (!byIdCand.dir || byIdCand.dir === dir)) {
      candidates.push(byIdCand);
    }
  }
  if (dir === 'agy-market' && state.updates.selfUpdate) {
    const selfCand = state.updates.selfUpdate;
    if (!selfCand.dir || selfCand.dir === 'agy-market') {
      candidates.push(selfCand);
    }
  }
  for (const cand of candidates) {
    if (cand && (!cand.dir || !dir || cand.dir === dir) && isUpdateEffectiveForLocal(cand, loc)) {
      return cand;
    }
  }
  return null;
}

function hasStaleSafeCatalogUpdate(catEntry, loc = null) {
  if (!catEntry) return false;
  if (state.updates.checkedAt && !state.updates.error) return false;
  const st = catEntry.installStatus || {};
  if (!st.hasUpdate) return false;
  if (loc) {
    if (loc.scope && loc.scope !== 'global') return false;
    if (st.installedDir && loc.dir && st.installedDir !== loc.dir) return false;
  } else if (!st.installed || (st.scope && st.scope !== 'global')) {
    return false;
  }
  const dir = String(loc?.dir || st.installedDir || '').trim();
  if (dir && state.verifiedLatestDirs.has(dir)) return false;
  const curVer = stripV(loc?.version || st.installedVersion || '');
  const catVer = stripV(catEntry.version || '');
  if (!catVer || !curVer || catVer === '?' || curVer === '?') return false;
  return isNewerVersion(catVer, curVer);
}

function reconcileUpdatesWithServerState() {
  const hasServerState = Boolean(state.serverState && Array.isArray(state.serverState.installed));
  const globalByDir = getGlobalInstalledByDirMap();

  if (Array.isArray(state.updates.items) && state.updates.items.length > 0) {
    state.updates.items = state.updates.items.filter((item) => {
      if (!item) return false;
      const itemDir = String(item.dir || '').trim();
      const isSelfItem = Boolean(item.isSelf || itemDir === 'agy-market' || item.id === 'azwosile__agy-market');
      if (itemDir && globalByDir.has(itemDir)) {
        return isUpdateEffectiveForLocal(item, globalByDir.get(itemDir));
      }
      if (hasServerState) {
        if (isSelfItem) {
          const selfVer = stripV(state.serverState?.plugin?.version || item.installedVersion || '');
          const latestVer = stripV(item.latestVersion || '');
          return Boolean(selfVer && latestVer && selfVer !== '?' && latestVer !== '?' && isNewerVersion(latestVer, selfVer));
        }
        if (itemDir) return false;
      }
      return isUpdateEffectiveForLocal(item, null);
    });
  }

  if (state.updates.selfUpdate) {
    const su = state.updates.selfUpdate;
    const selfLoc = globalByDir.get('agy-market') || null;
    const selfVer = stripV(selfLoc?.version || state.serverState?.plugin?.version || su.installedVersion || '');
    const targetVer = stripV(su.latestVersion || '');
    if (!targetVer || !selfVer || targetVer === '?' || selfVer === '?' || !isNewerVersion(targetVer, selfVer)) {
      state.updates.selfUpdate = null;
    }
  }

  if (hasServerState && Array.isArray(state.serverState.updatesAvailable) && state.serverState.updatesAvailable.length > 0) {
    state.serverState.updatesAvailable = state.serverState.updatesAvailable.filter((u) => {
      if (!u) return false;
      const uDir = String(u.installedDir || u.dir || '').trim();
      const loc = uDir ? globalByDir.get(uDir) || null : null;
      if (uDir && !loc) return false;
      const curVer = stripV(loc?.version || u.installedVersion || '');
      const latestVer = stripV(u.latestVersion || '');
      return Boolean(latestVer && curVer && latestVer !== '?' && curVer !== '?' && isNewerVersion(latestVer, curVer));
    });
  }
}

function applyServerState(nextState) {
  state.serverState = nextState;
  syncFavoritesFromServerState();
  syncDetailPluginReference();
  reconcileUpdatesWithServerState();
}

function getEffectiveUpdateItems() {
  const hasServerState = Boolean(state.serverState && Array.isArray(state.serverState.installed));
  const globalByDir = getGlobalInstalledByDirMap();
  let raw;
  if (Array.isArray(state.updates.items) && state.updates.items.length > 0) {
    raw = state.updates.items;
  } else if (state.updates.checkedAt) {
    raw = state.updates.items || [];
  } else {
    raw = (state.serverState?.updatesAvailable || []).map((u) => ({
      id: u.id,
      dir: u.installedDir || u.dir || '',
      displayName: u.displayName || u.id,
      installedVersion: u.installedVersion,
      latestVersion: u.latestVersion,
      source: 'catalog',
      releaseUrl: '',
      changelog: '',
      escalation: u.escalation || null,
      installable: true,
      isSelf: u.installedDir === 'agy-market' || u.id === 'azwosile__agy-market',
    }));
  }

  const base = raw.filter((item) => {
    if (!item) return false;
    const dir = String(item.dir || '').trim();
    if (dir && state.verifiedLatestDirs.has(dir)) return false;
    const isSelfItem = Boolean(item.isSelf || dir === 'agy-market' || item.id === 'azwosile__agy-market');
    if (isSelfItem && state.verifiedLatestDirs.has('agy-market')) {
      return false;
    }
    const loc = dir ? globalByDir.get(dir) || null : null;
    if (hasServerState && dir && !loc && !isSelfItem) {
      return false;
    }
    return isUpdateEffectiveForLocal(item, loc);
  });

  const su = state.updates.selfUpdate;
  const selfLoc = globalByDir.get('agy-market') || null;
  if (
    su &&
    selfLoc &&
    !state.verifiedLatestDirs.has('agy-market') &&
    !base.some((item) => item?.isSelf || item?.dir === 'agy-market' || item?.id === 'azwosile__agy-market')
  ) {
    const normalizedSelf = { ...su, id: su.id || 'azwosile__agy-market', dir: 'agy-market', isSelf: true };
    if (isUpdateEffectiveForLocal(normalizedSelf, selfLoc)) {
      return [...base, normalizedSelf];
    }
  }

  return base;
}

function getUpdateMaps() {
  const byId = new Map();
  const byDir = new Map();
  for (const item of getEffectiveUpdateItems()) {
    if (item.id) byId.set(item.id, item);
    if (item.dir) byDir.set(item.dir, item);
  }
  return { byId, byDir };
}

function getInstallableUpdates() {
  return getEffectiveUpdateItems().filter((item) => item.installable !== false);
}

function isPluginConfirmedLatest(loc, upd) {
  if (upd) return false;
  if (state.updates.loading) return false;
  const dir = String(loc?.dir || loc?.installedDir || '').trim();
  if (!dir) return false;
  const isSelf = dir === 'agy-market';
  if (
    isSelf &&
    state.updates.selfUpdate &&
    isUpdateEffectiveForLocal({ ...state.updates.selfUpdate, dir: 'agy-market' }, loc?.scope ? loc : null)
  ) {
    return false;
  }
  if (state.verifiedLatestDirs.has(dir)) return true;
  return Boolean(state.updates.checkedAt && !state.updates.error);
}

function markPluginVerifiedLatest(dir, id = '') {
  const cleanDir = String(dir || '').trim();
  const cleanId = String(id || '').trim();
  if (cleanDir) {
    state.verifiedLatestDirs.add(cleanDir);
  }
  const isSelf = cleanDir === 'agy-market' || cleanId === 'azwosile__agy-market';
  if (isSelf) {
    state.verifiedLatestDirs.add('agy-market');
    state.updates.selfUpdate = null;
  }
  if (Array.isArray(state.updates.items) && state.updates.items.length > 0) {
    state.updates.items = state.updates.items.filter((item) => {
      if (cleanDir && item.dir === cleanDir) return false;
      if (cleanId && item.id === cleanId) return false;
      if (isSelf && (item.isSelf || item.dir === 'agy-market' || item.id === 'azwosile__agy-market')) return false;
      return true;
    });
  }
  if (Array.isArray(state.serverState?.updatesAvailable) && state.serverState.updatesAvailable.length > 0) {
    state.serverState.updatesAvailable = state.serverState.updatesAvailable.filter((item) => {
      if (cleanDir && (item.installedDir === cleanDir || item.dir === cleanDir)) return false;
      if (cleanId && item.id === cleanId) return false;
      if (isSelf && (item.installedDir === 'agy-market' || item.dir === 'agy-market' || item.id === 'azwosile__agy-market')) {
        return false;
      }
      return true;
    });
  }
}

function getCatalogMaps() {
  const byId = new Map();
  const byDir = new Map();
  for (const p of state.serverState?.catalog?.plugins || []) {
    byId.set(p.id, p);
    if (p.installStatus?.installedDir) byDir.set(p.installStatus.installedDir, p);
    if (p.canonicalName && !byDir.has(p.canonicalName)) byDir.set(p.canonicalName, p);
  }
  return { byId, byDir };
}

function getInstalledByDirMap() {
  const byDir = new Map();
  for (const loc of state.serverState?.installed || []) {
    if (!loc?.dir) continue;
    if (!byDir.has(loc.dir) || loc.scope === 'global') {
      byDir.set(loc.dir, loc);
    }
  }
  return byDir;
}

function getConflictsSummary() {
  const fromScan = state.conflicts.data?.summary;
  const fromState = state.serverState?.conflictsSummary;
  const s = fromScan || fromState;
  const installedCount = state.serverState?.installed?.length || 0;
  if (s && typeof s === 'object') {
    return {
      total: Number(s.total || 0),
      critical: Number(s.critical || 0),
      warning: Number(s.warning || 0),
      info: Number(s.info || 0),
      healthyCount: Number(s.healthyCount ?? Math.max(0, installedCount - Number(s.critical || 0))),
    };
  }
  return { total: 0, critical: 0, warning: 0, info: 0, healthyCount: installedCount };
}

function buildLocalDetailModel(loc, catEntry) {
  if (catEntry) {
    return {
      ...catEntry,
      commitSha: catEntry.commitSha || loc.receipt?.commitSha || '',
      repository: {
        ...(catEntry.repository || {}),
        url: catEntry.repository?.url || loc.repositoryUrl || loc.receipt?.repositoryUrl || '',
        pluginRoot: catEntry.repository?.pluginRoot || loc.receipt?.pluginRoot || '.',
      },
      capabilities: catEntry.capabilities || loc.capabilities || loc.receipt?.grantedCapabilities || { badges: [] },
      activation: catEntry.activation || loc.activation,
      installStatus: {
        ...(catEntry.installStatus || {}),
        installed: true,
        installedDir: loc.dir,
        installedVersion: loc.version,
        enabled: loc.enabled,
        parkedByMarket: Boolean(loc.parkedByMarket),
        hostDisabled: Boolean(loc.hostDisabled),
        canToggle: loc.canToggle ?? (loc.scope === 'global' && loc.dir !== 'agy-market' && !loc.hostDisabled),
        toggleDisabledReason:
          loc.toggleDisabledReason ??
          (loc.dir === 'agy-market' ? 'self' : loc.hostDisabled ? 'host-disabled' : loc.scope !== 'global' ? loc.scope : ''),
        canUninstall: loc.canUninstall ?? (loc.scope === 'global' && loc.dir !== 'agy-market'),
        uninstallDisabledReason:
          loc.uninstallDisabledReason ??
          (loc.dir === 'agy-market' ? 'self' : loc.scope !== 'global' ? loc.scope : ''),
        sidecarPane: loc.sidecarPane || catEntry.installStatus?.sidecarPane || null,
      },
      _track: loc.receipt?.track || catEntry._track || 'verified',
    };
  }
  return {
    id: loc.receipt?.id || loc.dir,
    canonicalName: loc.name || loc.dir,
    scopedName: loc.dir,
    forceScopedInstall: false,
    displayName: loc.displayName || loc.name || loc.dir,
    description: isSelfPluginIdentity(null, loc) ? sanitizeSelfDescription(loc.description || '') : loc.description || '',
    version: loc.version || '0.0.0',
    gitTag: loc.receipt?.gitTag || '',
    commitSha: loc.receipt?.commitSha || '',
    repository: {
      url: loc.repositoryUrl || loc.receipt?.repositoryUrl || '',
      pluginRoot: loc.receipt?.pluginRoot || '.',
      stars: 0,
    },
    distribution: {
      sha256: loc.receipt?.sha256 || '',
    },
    media: {
      iconUrl: '',
    },
    taxonomy: {
      categories: [],
      tags: [],
    },
    capabilities: loc.capabilities || loc.receipt?.grantedCapabilities || { badges: [] },
    activation: loc.activation || null,
    installStatus: {
      installed: true,
      installedDir: loc.dir,
      installedVersion: loc.version,
      scope: loc.scope || 'global',
      enabled: loc.enabled,
      parkedByMarket: Boolean(loc.parkedByMarket),
      hostDisabled: Boolean(loc.hostDisabled),
      canToggle: loc.canToggle ?? (loc.scope === 'global' && loc.dir !== 'agy-market' && !loc.hostDisabled),
      toggleDisabledReason:
        loc.toggleDisabledReason ??
        (loc.dir === 'agy-market' ? 'self' : loc.hostDisabled ? 'host-disabled' : loc.scope !== 'global' ? loc.scope : ''),
      canUninstall: loc.canUninstall ?? (loc.scope === 'global' && loc.dir !== 'agy-market'),
      uninstallDisabledReason:
        loc.uninstallDisabledReason ??
        (loc.dir === 'agy-market' ? 'self' : loc.scope !== 'global' ? loc.scope : ''),
      hasUpdate: false,
      sidecarPane: loc.sidecarPane || null,
    },
    _track: loc.receipt?.track || 'local',
    _localOnly: true,
  };
}

function syncDetailPluginReference() {
  if (!state.detailPlugin) return;
  const fresh = (state.serverState?.catalog?.plugins || []).find((p) => p.id === state.detailPlugin.id);
  if (fresh) {
    state.detailPlugin = fresh;
    return;
  }
  const dir = state.detailPlugin.installStatus?.installedDir;
  if (dir) {
    const loc = (state.serverState?.installed || []).find((x) => x.dir === dir);
    if (loc) {
      state.detailPlugin = buildLocalDetailModel(loc, null);
    } else if (state.detailPlugin._localOnly) {
      state.detailPlugin = null;
    }
  }
}

// ==========================================================================
// Data Fetching & Mutations (Strict X-Sidecar-Token via `apiFetch`)
// ==========================================================================

async function loadState(forceRefresh = false) {
  state.loading = true;
  render();
  try {
    if (window.sidecar?.getWorkspaceUris) {
      state.workspaceUris = await window.sidecar.getWorkspaceUris().catch(() => []);
    }
    if (forceRefresh) {
      applyServerState(
        await apiFetch('/api/catalog/refresh', {
          method: 'POST',
          body: { workspaceUris: state.workspaceUris },
        }),
      );
    } else {
      const qs = state.workspaceUris.length
        ? `?workspaceUris=${encodeURIComponent(state.workspaceUris.join(','))}`
        : '';
      applyServerState(await apiFetch(`/api/state${qs}`));
    }
  } catch (err) {
    showToast(`${t('加载失败', 'Load failed')}: ${err?.message || String(err)}`, { tone: 'danger' });
  } finally {
    state.loading = false;
    render();
  }
}

async function loadConflicts({ silent = true } = {}) {
  state.conflicts.loading = true;
  state.conflicts.error = '';
  render();
  try {
    const qs = state.workspaceUris.length
      ? `?workspaceUris=${encodeURIComponent(state.workspaceUris.join(','))}`
      : '';
    const res = await apiFetch(`/api/conflicts${qs}`);
    if (res && res.ok !== false) {
      state.conflicts = {
        loading: false,
        loaded: true,
        data: res,
        error: '',
      };
      if (state.serverState && res.summary) {
        state.serverState.conflictsSummary = res.summary;
      }
      if (!silent) {
        const total = Number(res.summary?.total || 0);
        showToast(
          total === 0
            ? t('冲突检查完成：未发现插件冲突', 'Conflict check complete: 0 conflicts found')
            : t(`冲突检查完成：发现 ${total} 项警告或提示`, `Conflict check complete: ${total} item(s) found`),
          { tone: total === 0 ? 'ok' : 'warn' },
        );
      }
    } else {
      state.conflicts.loading = false;
      state.conflicts.error = res?.error || t('冲突扫描返回异常', 'Conflict scan returned an error');
    }
  } catch (err) {
    state.conflicts.loading = false;
    state.conflicts.error = err?.message || String(err);
    if (!silent) {
      showToast(`${t('冲突扫描失败', 'Conflict scan failed')}: ${state.conflicts.error}`, { tone: 'error' });
    }
  } finally {
    render();
  }
}

async function triggerFixConflict({ type, targetDir, suggestedDir = '' }) {
  const fixKey = `${type}:${targetDir}`;
  state.fixingKey = fixKey;
  render();
  try {
    const res = await apiFetch('/api/fix-conflict', {
      method: 'POST',
      body: {
        type,
        targetDir,
        ...(suggestedDir ? { suggestedDir } : {}),
        workspaceUris: state.workspaceUris,
      },
    });

    if (res.state) {
      applyServerState(res.state);
    }
    if (res.conflicts) {
      state.conflicts = {
        loading: false,
        loaded: true,
        data: res.conflicts,
        error: '',
      };
    } else {
      void loadConflicts({ silent: true });
    }

    if (res.ok) {
      const msg =
        (getLocale() === 'en' ? res.messageEn : res.messageZh) ||
        t(`已修复冲突：${targetDir}${res.newDir ? ` → ${res.newDir}` : ''}`, `Fixed conflict: ${targetDir}`);
      showToast(msg, { tone: 'ok' });
      if (res.restartRequired || res.reloadRequired) {
        maybeTriggerRestartBanner({
          pluginName: res.newDir || targetDir,
          restartRequired: Boolean(res.restartRequired),
          reloadRequired: Boolean(res.reloadRequired),
          activation: res.activation || null,
        });
      }
    } else {
      showToast(res.error || t('冲突修复失败', 'Conflict fix failed'), { tone: 'danger' });
    }
  } catch (err) {
    showToast(`${t('冲突修复失败', 'Conflict fix failed')}: ${err?.message || String(err)}`, { tone: 'danger' });
  } finally {
    state.fixingKey = '';
    render();
  }
}

async function triggerTogglePlugin(dir, nextEnabled) {
  if (!dir || dir === 'agy-market') return;
  state.togglingDir = dir;
  render();
  try {
    const res = await apiFetch('/api/toggle-plugin', {
      method: 'POST',
      body: {
        dir,
        enabled: Boolean(nextEnabled),
        workspaceUris: state.workspaceUris,
      },
    });

    if (res.state) {
      applyServerState(res.state);
    }
    if (res.conflictsSummary && state.serverState) {
      state.serverState.conflictsSummary = res.conflictsSummary;
    }
    if (state.conflicts.loaded) {
      void loadConflicts({ silent: true });
    }

    if (res.ok) {
      const label = nextEnabled
        ? t(`已启用插件「${dir}」`, `Enabled "${dir}"`)
        : t(`已将「${dir}」移入停放仓并禁用`, `Parked & disabled "${dir}"`);
      const hasLockedOrRetired =
        Boolean(res.lockedOnDisable) ||
        (Array.isArray(res.retiredBinaries) && res.retiredBinaries.length > 0);
      if (hasLockedOrRetired) {
        maybeTriggerRestartBanner({
          pluginName: dir,
          operation: 'toggle',
          restartRequired: true,
          retiredBinaries: res.retiredBinaries || [],
          lockedOnDisable: Boolean(res.lockedOnDisable),
          activation: res.activation || null,
        });
      }
      showToast(label, {
        subtext: hasLockedOrRetired
          ? t('检测到后台进程占用句柄，重启 Antigravity 后即可彻底释放', 'Background handle lock detected; restart Antigravity to release')
          : nextEnabled
            ? t('宿主热监听将在约 1 秒内加载其技能与侧边栏', 'Antigravity hot-watcher will activate skills/Sidebar shortly')
            : t('仍保留在列表中支持版本检测与一键恢复', 'Kept in Installed list for update checks & 1-click re-enable'),
        tone: 'ok',
      });
    } else {
      showToast(res.error || t('启停切换失败', 'Failed to toggle plugin'), { tone: 'danger' });
    }
  } catch (err) {
    showToast(`${t('启停切换失败', 'Toggle failed')}: ${err?.message || String(err)}`, { tone: 'danger' });
  } finally {
    state.togglingDir = '';
    render();
  }
}

async function triggerUninstallPlugin(dir, { removeFavorite = false, displayName = '' } = {}) {
  if (isUpdateActionLocked()) return;
  const cleanDir = String(dir || '').trim();
  if (!cleanDir || cleanDir === 'agy-market') return;
  const label = String(displayName || state.removeConfirmModal?.displayName || cleanDir).trim();
  state.removingDir = cleanDir;
  state.errorBanner = null;
  render();
  try {
    const res = await apiFetch('/api/uninstall', {
      method: 'POST',
      body: {
        dir: cleanDir,
        removeFavorite: Boolean(removeFavorite),
        workspaceUris: state.workspaceUris,
      },
    });
    if (res.state) {
      applyServerState(res.state);
    }
    state.removeConfirmModal = null;

    if (res?.ok === false || res?.removed === false) {
      syncDetailPluginReference();
      if (state.conflicts.loaded) {
        void loadConflicts({ silent: true });
      }
      const isLocked = Boolean(res?.locked);
      const errMsg =
        res?.error ||
        (isLocked
          ? t(
              `插件 "${cleanDir}" 的文件正被后台进程占用，无法立即卸载。请关闭或重启 Antigravity 后重试。`,
              `Files for "${cleanDir}" are locked by a background process and could not be uninstalled. Close or restart Antigravity and try again.`,
            )
          : t('插件未能卸载', 'Failed to uninstall plugin'));
      setErrorBanner({
        title: isLocked ? t('插件卸载受阻', 'Plugin Uninstall Blocked') : t('插件卸载失败', 'Failed to Uninstall Plugin'),
        items: [{ pluginName: label, message: errMsg }],
      });
      showToast(`${t('卸载失败', 'Uninstall failed')}: ${errMsg}`, { tone: 'err', durationMs: 7000 });
      return;
    }

    state.verifiedLatestDirs.delete(cleanDir);
    if (state.detailPlugin?.installStatus?.installedDir === cleanDir) {
      if (state.detailPlugin._localOnly) {
        state.detailPlugin = null;
      } else {
        syncDetailPluginReference();
      }
    }
    if (state.conflicts.loaded) {
      void loadConflicts({ silent: true });
    }

    const isPartiallyLocked = Boolean(res?.locked);
    const restartInfo = maybeTriggerRestartBanner({
      pluginName: label,
      operation: 'uninstall',
      restartRequired: Boolean(res?.restartRequired || isPartiallyLocked),
      reloadRequired: Boolean(res?.reloadRequired),
      retiredBinaries: res?.retiredBinaries || [],
      lockedOnRemove: Boolean(res?.lockedOnRemove || isPartiallyLocked),
      activation: res?.activation || null,
    });

    showToast(t(`已卸载插件：${label}`, `Uninstalled plugin: ${label}`), {
      subtext:
        restartInfo?.reason ||
        (isPartiallyLocked
          ? t(
              '清单已立即摘除，残留的被占用文件将在下次重启 Antigravity 后自动清理',
              'Manifest removed immediately; locked files will be cleaned up after restarting Antigravity',
            )
          : ''),
      tone: 'ok',
      durationMs: restartInfo || isPartiallyLocked ? 6500 : 4000,
    });
    void checkUpdates(false, { silent: true, allowWhileBusy: true });
  } catch (err) {
    const errMsg = err?.message || String(err);
    setErrorBanner({
      title: t('插件卸载失败', 'Failed to Uninstall Plugin'),
      items: [{ pluginName: label, message: errMsg }],
    });
    showToast(`${t('卸载失败', 'Uninstall failed')}: ${errMsg}`, { tone: 'danger', durationMs: 7000 });
  } finally {
    state.removingDir = '';
    render();
  }
}

async function triggerRemovePluginFiles(dir, opts = {}) {
  return triggerUninstallPlugin(dir, opts);
}

async function toggleFavorite(key, displayName = '') {
  const cleanKey = String(key || '').trim();
  if (!cleanKey) return;
  const prev = [...state.favorites];
  const wasFav = prev.includes(cleanKey);
  const next = wasFav ? prev.filter((k) => k !== cleanKey) : [cleanKey, ...prev];

  // Optimistic UI update
  state.favorites = next;
  if (state.serverState?.prefs) {
    state.serverState.prefs.favorites = next;
  }
  render();

  try {
    const res = await apiFetch('/api/favorites', {
      method: 'POST',
      body: { key: cleanKey, favorite: !wasFav },
    });
    if (Array.isArray(res?.favorites)) {
      state.favorites = [...new Set(res.favorites.map((x) => String(x || '').trim()).filter(Boolean))];
      if (state.serverState?.prefs) {
        state.serverState.prefs.favorites = state.favorites;
      }
      render();
    }
    if (displayName) {
      showToast(
        !wasFav
          ? t(`已收藏「${displayName}」`, `Favorited "${displayName}"`)
          : t(`已取消收藏「${displayName}」`, `Removed "${displayName}" from Favorites`),
        { tone: 'ok', durationMs: 2200 },
      );
    }
  } catch (err) {
    // Rollback optimistic update on persistence failure
    state.favorites = prev;
    if (state.serverState?.prefs) {
      state.serverState.prefs.favorites = prev;
    }
    showToast(`${t('收藏状态保存失败', 'Failed to save favorite')}: ${err?.message || String(err)}`, {
      tone: 'danger',
      durationMs: 5000,
    });
  }
}

async function openSiblingSidecarPane({ dir, folder, viewPath, title, uri }) {
  const parsed = parseSidecarPaneTarget(dir, {
    sidecarFolder: folder,
    viewPath,
    title,
    uri,
  });
  const cleanDir = parsed?.dir || String(dir || '').trim();
  const cleanFolder = parsed?.folder || String(folder || 'pane').trim() || 'pane';
  const normPath = parsed?.viewPath || normalizeSidecarViewPath(viewPath);
  const paneUri = parsed?.uri || buildSidecarPaneUri(cleanDir, cleanFolder, normPath);
  const safeTitle = parsed?.title || title || cleanDir;
  const togglePayload = {
    tabType: 'sidecarView',
    uri: paneUri,
  };

  const inHostIframe = Boolean(window.parent && window.parent !== window);
  if (inHostIframe) {
    try {
      if (typeof window.sidecar?.ui?.toggleAuxPane === 'function') {
        await window.sidecar.ui.toggleAuxPane(togglePayload);
      } else {
        window.parent.postMessage({ type: 'toggle-aux-pane', payload: togglePayload }, '*');
      }
    } catch {
      try {
        window.parent.postMessage({ type: 'toggle-aux-pane', payload: togglePayload }, '*');
      } catch {
        /* ignore */
      }
    }
    return;
  }

  // Standalone external browser mode only: ask backend loopback CDP helper to wake host Sidebar.
  try {
    await apiFetch('/api/open-pane', {
      method: 'POST',
      body: {
        dir: cleanDir,
        sidecarFolder: cleanFolder,
        viewPath: normPath,
        title: safeTitle,
        uri: paneUri,
      },
    });
  } catch {
    /* ignore when external CDP hub is unavailable */
  }
}

async function checkUpdates(force = false, { silent = true, allowWhileBusy = false } = {}) {
  if (!allowWhileBusy && (state.updates.loading || isPluginMutationBusy())) return;
  const seq = ++updatesRequestSeq;
  if (force) {
    lastForcedUpdatesAt = Date.now();
  }
  state.updates.loading = true;
  state.updates.error = '';
  render();
  try {
    const qs = force ? '?force=1' : '?force=0';
    const res = await apiFetch(`/api/updates${qs}`);
    if (seq !== updatesRequestSeq) return;
    if (res && res.ok !== false) {
      if (force) {
        state.verifiedLatestDirs.clear();
      }
      const nextItems = Array.isArray(res.items) ? res.items : [];
      const nextSelfUpdate = res.selfUpdate || null;
      state.updates = {
        loading: false,
        checkedAt: res.checkedAt || new Date().toISOString(),
        items: nextItems,
        selfUpdate: nextSelfUpdate,
        rateLimited: Boolean(res.rateLimited),
        warnings: Array.isArray(res.warnings) ? res.warnings : [],
        error: '',
      };
      reconcileUpdatesWithServerState();
      for (const item of state.updates.items) {
        if (item?.dir) state.verifiedLatestDirs.delete(item.dir);
      }
      if (state.updates.selfUpdate) {
        state.verifiedLatestDirs.delete('agy-market');
      }
      if (!silent) {
        const count = getEffectiveUpdateItems().length;
        showToast(
          count > 0
            ? t(`检查完成：发现 ${count} 个插件更新`, `Update check complete: ${count} update(s) found`)
            : t('所有已安装插件均为最新版本', 'All installed plugins are up to date'),
          { tone: 'ok' },
        );
      }
    } else {
      state.updates.loading = false;
      state.updates.error = res?.error || t('更新检查未返回有效数据', 'Update check returned an error');
      reconcileUpdatesWithServerState();
    }
  } catch (err) {
    if (seq !== updatesRequestSeq) return;
    state.updates.loading = false;
    state.updates.error = err?.message || String(err);
    reconcileUpdatesWithServerState();
    if (!silent) {
      showToast(`${t('检查更新失败', 'Update check failed')}: ${state.updates.error}`, { tone: 'error' });
    }
  } finally {
    if (seq === updatesRequestSeq) render();
  }
}

async function triggerInstall(
  plugin,
  { conflictStrategy = 'prompt', confirmEscalation = false, forceResync = false, dir = '', _internalDelegated = false } = {},
) {
  if (!plugin) return;
  if (!_internalDelegated && isUpdateActionLocked()) return;
  const isUpdate = Boolean(plugin.installStatus?.installed);
  const pluginName = plugin.displayName || plugin.canonicalName || plugin.id;
  const targetDir = String(dir || plugin.installStatus?.installedDir || '').trim();
  state.busyId = plugin.id;
  state.errorBanner = null;
  render();
  try {
    const endpoint = isUpdate ? '/api/update' : '/api/install';
    const res = await apiFetch(endpoint, {
      method: 'POST',
      body: {
        id: plugin.id,
        ...(isUpdate ? { dir: targetDir } : {}),
        ...(forceResync ? { forceResync: true } : {}),
        plugin,
        conflictStrategy,
        confirmEscalation,
        workspaceUris: state.workspaceUris,
      },
    });

    if (res.state) {
      applyServerState(res.state);
    }

    if (res.status === 'CONFLICT_CHOICE_REQUIRED') {
      state.conflictModal = {
        plugin,
        conflict: res.conflict,
        scopedFallbackName: res.scopedFallbackName,
        choices: res.choices || ['isolate'],
      };
      return;
    }

    if (res.status === 'CAPABILITY_ESCALATION_CONFIRM_REQUIRED') {
      state.escalationModal = {
        mode: 'single',
        items: [
          {
            plugin,
            id: plugin.id,
            dir: targetDir,
            forceResync: Boolean(forceResync),
            displayName: pluginName,
            installedVersion: res.installedVersion || plugin.installStatus?.installedVersion || '?',
            targetVersion: res.targetVersion || plugin.version || '?',
            escalation: res.escalation || { addedBadges: [], addedRemoteDomains: [], addedHookEvents: [] },
          },
        ],
      };
      return;
    }

    if (res.ok) {
      state.conflictModal = null;
      state.escalationModal = null;
      state.errorBanner = null;
      if (res.isSelfUpdate || res.willRestart) {
        startReconnectPolling(res.version || plugin.version || '');
        return;
      }

      const installedDir = String(
        res.installedDir || targetDir || plugin.installStatus?.installedDir || plugin.canonicalName || '',
      ).trim();
      markPluginVerifiedLatest(installedDir, plugin.id || '');

      if (res.alreadyUpToDate || res.status === 'ALREADY_UP_TO_DATE') {
        const verStr = res.version ? formatV(res.version) : '';
        showToast(
          verStr
            ? t(`「${pluginName}」当前已是最新版本（${verStr}）`, `"${pluginName}" is already up to date (${verStr})`)
            : t(`「${pluginName}」当前已是最新版本`, `"${pluginName}" is already up to date`),
          { tone: 'ok', durationMs: 3500 },
        );
        return;
      }

      const act = res.activation || resolveActivationInfo(plugin);
      const restartInfo = maybeTriggerRestartBanner({
        pluginName: plugin.displayName || installedDir || plugin.canonicalName,
        operation: isUpdate ? 'update' : 'install',
        restartRequired: Boolean(res.restartRequired),
        reloadRequired: Boolean(res.reloadRequired),
        retiredBinaries: res.retiredBinaries || [],
        activation: act,
      });

      const noteSuffix = res.compatibilityNotes?.length ? ` (${res.compatibilityNotes[0]})` : '';
      showToast(
        `${t(isUpdate ? '更新已完成' : '安装已完成', isUpdate ? 'Updated' : 'Installed')}: ${res.installedDir} ${formatV(res.version)}${noteSuffix}`,
        {
          subtext: restartInfo?.reason || '',
          tone: 'ok',
          durationMs: restartInfo ? 6500 : 4500,
        },
      );
      await checkUpdates(false, { silent: true, allowWhileBusy: true });
      if (state.conflicts.loaded) void loadConflicts({ silent: true });
    } else {
      const errMsg = res.error || res.status || t('安装或更新未能完成', 'Install or update did not complete');
      setErrorBanner({
        title: t(isUpdate ? '插件更新失败' : '插件安装失败', isUpdate ? 'Plugin Update Failed' : 'Plugin Install Failed'),
        items: [{ pluginName, message: errMsg }],
        retryAction: { type: 'install', plugin, opts: { conflictStrategy, confirmEscalation, forceResync, dir: targetDir } },
      });
      showToast(
        `${t(isUpdate ? '更新失败' : '安装失败', isUpdate ? 'Update failed' : 'Install failed')} (${pluginName}): ${errMsg}`,
        { tone: 'danger', durationMs: 8000 },
      );
    }
  } catch (err) {
    const errMsg = err?.message || String(err);
    setErrorBanner({
      title: t(isUpdate ? '插件更新失败' : '插件安装失败', isUpdate ? 'Plugin Update Failed' : 'Plugin Install Failed'),
      items: [{ pluginName, message: errMsg }],
      retryAction: { type: 'install', plugin, opts: { conflictStrategy, confirmEscalation, forceResync, dir: targetDir } },
    });
    showToast(
      `${t(isUpdate ? '更新失败' : '安装失败', isUpdate ? 'Update failed' : 'Install failed')} (${pluginName}): ${errMsg}`,
      { tone: 'danger', durationMs: 8000 },
    );
  } finally {
    state.busyId = '';
    render();
  }
}

async function triggerUpdateAll(ids = null, { confirmEscalation = false, _internalDelegated = false } = {}) {
  if (!_internalDelegated && isUpdateActionLocked()) return;
  let targetIds = Array.isArray(ids) && ids.length ? ids : getInstallableUpdates().map((u) => u.id);
  let didLiveCheck = false;

  if (!targetIds.length && (!Array.isArray(ids) || ids.length === 0)) {
    state.batchUpdating = true;
    state.batchTargetIds = [];
    state.errorBanner = null;
    render();
    didLiveCheck = true;
    await checkUpdates(true, { silent: true, allowWhileBusy: true });
    targetIds = getInstallableUpdates().map((u) => u.id);
    if (!targetIds.length) {
      state.batchUpdating = false;
      state.batchTargetIds = [];
      render();
      if (state.updates.error) {
        showToast(`${t('检查更新失败', 'Update check failed')}: ${state.updates.error}`, {
          tone: 'danger',
          durationMs: 7000,
        });
      } else {
        showToast(t('全部已安装插件均已是最新版本', 'All installed plugins are already up to date'), {
          tone: 'ok',
        });
      }
      return;
    }
  }

  if (!targetIds.length) {
    showToast(t('全部已安装插件均已是最新版本', 'All installed plugins are already up to date'), {
      tone: 'ok',
    });
    return;
  }

  state.batchUpdating = true;
  state.batchTargetIds = targetIds;
  state.errorBanner = null;
  render();

  try {
    const res = await apiFetch('/api/update-all', {
      method: 'POST',
      body: {
        ids: targetIds,
        confirmEscalation,
        ...(didLiveCheck ? { forceCheck: true } : {}),
        workspaceUris: state.workspaceUris,
      },
    });

    if (res.state) {
      applyServerState(res.state);
    }

    const results = Array.isArray(res.results) ? res.results : [];
    if (confirmEscalation && Array.isArray(state.batchResults)) {
      const merged = new Map(state.batchResults.map((r) => [r.id, r]));
      for (const r of results) merged.set(r.id, r);
      state.batchResults = [...merged.values()];
    } else {
      state.batchResults = results;
    }

    for (const r of results) {
      if (r.ok) {
        markPluginVerifiedLatest(r.installedDir || r.dir || '', r.id || '');
        if (!r.alreadyUpToDate && r.status !== 'ALREADY_UP_TO_DATE') {
          maybeTriggerRestartBanner({
            pluginName: r.displayName || r.installedDir || r.id,
            operation: 'update',
            restartRequired: Boolean(r.restartRequired),
            reloadRequired: Boolean(r.reloadRequired),
            retiredBinaries: r.retiredBinaries || [],
            activation: r.activation || null,
          });
        }
      }
    }

    const { byId: updById } = getUpdateMaps();
    const { byId: catById } = getCatalogMaps();

    const escalated = results.filter((r) => r.status === 'CAPABILITY_ESCALATION_CONFIRM_REQUIRED');
    if (escalated.length > 0 && !confirmEscalation) {
      state.escalationModal = {
        mode: 'batch',
        items: escalated.map((r) => {
          const upd = updById.get(r.id);
          const cat = catById.get(r.id);
          return {
            id: r.id,
            displayName: r.displayName || upd?.displayName || cat?.displayName || r.id,
            installedVersion: r.installedVersion || upd?.installedVersion || cat?.installStatus?.installedVersion || '?',
            targetVersion: r.targetVersion || upd?.latestVersion || cat?.version || '?',
            updateKind: r.updateKind || upd?.updateKind || '',
            installedCommitSha: r.installedCommitSha || upd?.installedCommitSha || '',
            latestCommitSha: r.latestCommitSha || upd?.latestCommitSha || '',
            escalation: r.escalation || upd?.escalation || { addedBadges: [], addedRemoteDomains: [], addedHookEvents: [] },
          };
        }),
      };
    } else {
      state.escalationModal = null;
    }

    const okCount = results.filter((r) => r.ok).length;
    const failedItems = results.filter((r) => !r.ok && r.status !== 'CAPABILITY_ESCALATION_CONFIRM_REQUIRED');
    const failCount = failedItems.length;
    const selfUpdated = Boolean(
      res.willRestart || results.some((r) => r.ok && (r.isSelfUpdate || r.installedDir === 'agy-market' || r.id === 'azwosile__agy-market')),
    );

    if (failCount > 0) {
      setErrorBanner({
        title: t(
          `批量更新失败：${failCount} 个插件未能完成更新`,
          `Batch update failed: ${failCount} plugin(s) did not complete`,
        ),
        items: failedItems.map((r) => ({
          pluginName: r.displayName || r.installedDir || r.dir || r.id,
          message: r.error || r.status || t('更新失败', 'Update failed'),
        })),
        retryAction: { type: 'update-all', ids: failedItems.map((r) => r.id).filter(Boolean) },
      });
    } else if (res.ok === false && results.length === 0) {
      const errMsg = res.error || t('批量更新请求返回异常', 'Batch update returned an error');
      setErrorBanner({
        title: t('批量更新失败', 'Batch Update Failed'),
        items: [{ pluginName: t('批量更新队列', 'Batch Update Queue'), message: errMsg }],
        retryAction: { type: 'update-all', ids: targetIds },
      });
    }

    if (selfUpdated) {
      const selfItem = results.find((r) => r.isSelfUpdate || r.installedDir === 'agy-market' || r.id === 'azwosile__agy-market');
      startReconnectPolling(selfItem?.version || state.updates.selfUpdate?.latestVersion || '');
      return;
    }

    if (failCount > 0) {
      const firstFail = failedItems[0];
      const firstReason = firstFail.error || firstFail.status || t('更新失败', 'Update failed');
      showToast(
        t(
          `批量更新失败（${okCount} 成功，${failCount} 失败）：${firstFail.displayName || firstFail.id} — ${firstReason}`,
          `Batch update failed (${okCount} ok, ${failCount} failed): ${firstFail.displayName || firstFail.id} — ${firstReason}`,
        ),
        { tone: 'danger', durationMs: 8000 },
      );
    } else if (res.ok === false && results.length === 0) {
      showToast(`${t('批量更新失败', 'Batch update failed')}: ${res.error || t('请求异常', 'Request error')}`, {
        tone: 'danger',
        durationMs: 8000,
      });
    } else if (escalated.length > 0) {
      showToast(
        t(
          `已完成 ${okCount} 个，另有 ${escalated.length} 个插件新增能力需确认`,
          `Updated ${okCount}; ${escalated.length} plugin(s) require capability confirmation`,
        ),
      );
    } else {
      showToast(t(`全部更新完成（共 ${okCount} 个插件）`, `Updated ${okCount} plugin(s) successfully`), { tone: 'ok' });
    }

    await checkUpdates(false, { silent: true, allowWhileBusy: true });
    if (state.conflicts.loaded) void loadConflicts({ silent: true });
  } catch (err) {
    const errMsg = err?.message || String(err);
    setErrorBanner({
      title: t('批量更新失败', 'Batch Update Failed'),
      items: [{ pluginName: t('批量更新队列', 'Batch Update Queue'), message: errMsg }],
      retryAction: { type: 'update-all', ids: targetIds },
    });
    showToast(`${t('批量更新失败', 'Batch update error')}: ${errMsg}`, { tone: 'danger', durationMs: 8000 });
  } finally {
    state.batchUpdating = false;
    state.batchTargetIds = [];
    render();
  }
}

async function triggerSelfUpdate({
  confirmEscalation = false,
  updateChannel = '',
  targetVersion = '',
  latestVersion = '',
  targetRef = '',
  _internalDelegated = false,
} = {}) {
  if (!_internalDelegated && isUpdateActionLocked()) return;
  state.selfUpdateBusy = true;
  state.errorBanner = null;
  render();
  const su = state.updates.selfUpdate || null;
  const resolvedChannel = String(updateChannel || su?.updateChannel || '').trim();
  const resolvedVersion = String(targetVersion || latestVersion || su?.latestVersion || '').trim();
  const resolvedRef = String(targetRef || su?.targetRef || '').trim();
  try {
    const body = {
      workspaceUris: state.workspaceUris,
    };
    if (confirmEscalation) body.confirmEscalation = true;
    if (resolvedChannel) body.updateChannel = resolvedChannel;
    if (resolvedVersion) body.targetVersion = resolvedVersion;
    if (resolvedRef) body.targetRef = resolvedRef;

    const res = await apiFetch('/api/self-update', {
      method: 'POST',
      body,
    });

    if (res.state) {
      applyServerState(res.state);
    }

    if (res.status === 'CAPABILITY_ESCALATION_CONFIRM_REQUIRED') {
      state.escalationModal = {
        mode: 'self',
        items: [
          {
            id: su?.id || 'azwosile__agy-market',
            displayName: 'AGY Market · 反重力插件市场',
            installedVersion: res.installedVersion || su?.installedVersion || state.serverState?.plugin?.version || '?',
            targetVersion: res.targetVersion || resolvedVersion || '?',
            updateChannel: resolvedChannel,
            targetRef: resolvedRef,
            escalation: res.escalation || { addedBadges: [], addedRemoteDomains: [], addedHookEvents: [] },
          },
        ],
      };
      return;
    }

    if (res.ok || res.willRestart) {
      state.escalationModal = null;
      state.selfChangelogModal = false;
      state.errorBanner = null;
      startReconnectPolling(res.version || resolvedVersion || '');
    } else {
      const errMsg = res.error || res.status || t('插件市场自更新未完成', 'Self-update did not complete');
      setErrorBanner({
        title: t('AGY Market 自更新失败', 'AGY Market Self-Update Failed'),
        items: [{ pluginName: 'AGY Market', message: errMsg }],
        retryAction: {
          type: 'self-update',
          updateChannel: resolvedChannel,
          targetVersion: resolvedVersion,
          targetRef: resolvedRef,
        },
      });
      showToast(`${t('市场更新失败', 'Self-update failed')}: ${errMsg}`, { tone: 'danger', durationMs: 8000 });
    }
  } catch (err) {
    const errMsg = err?.message || String(err);
    setErrorBanner({
      title: t('AGY Market 自更新失败', 'AGY Market Self-Update Failed'),
      items: [{ pluginName: 'AGY Market', message: errMsg }],
      retryAction: {
        type: 'self-update',
        updateChannel: resolvedChannel,
        targetVersion: resolvedVersion,
        targetRef: resolvedRef,
      },
    });
    showToast(`${t('市场更新失败', 'Self-update failed')}: ${errMsg}`, { tone: 'danger', durationMs: 8000 });
  } finally {
    state.selfUpdateBusy = false;
    render();
  }
}

function extractGithubPrefillUrl(rawText) {
  const s = String(rawText || '').trim();
  if (!s) return '';
  if (/^https?:\/\/(?:www\.|codeload\.)?github\.com\/[^\s]+/i.test(s)) {
    return s;
  }
  if (/^(?:www\.)?github\.com\/[^\s]+/i.test(s)) {
    return `https://${s}`;
  }
  return '';
}

function formatBytesCompact(bytes) {
  const n = Number(bytes || 0);
  if (!Number.isFinite(n) || n <= 0) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

function normalizeInspectEscalation(esc) {
  if (!esc || typeof esc !== 'object') {
    return { hasEscalation: false, addedBadges: [], addedDomains: [], addedHooks: [] };
  }
  const addedBadges = Array.isArray(esc.addedBadges) ? esc.addedBadges : [];
  const addedDomains = Array.isArray(esc.addedDomains)
    ? esc.addedDomains
    : Array.isArray(esc.addedRemoteDomains)
      ? esc.addedRemoteDomains
      : [];
  const addedHooks = Array.isArray(esc.addedHooks)
    ? esc.addedHooks
    : Array.isArray(esc.addedHookEvents)
      ? esc.addedHookEvents
      : [];
  const hasEscalation = Boolean(
    esc.hasEscalation ??
      esc.escalated ??
      (addedBadges.length > 0 || addedDomains.length > 0 || addedHooks.length > 0),
  );
  return { hasEscalation, addedBadges, addedDomains, addedHooks };
}

function formatInspectWarningItem(item) {
  if (!item) return '';
  if (typeof item === 'string') return item.trim();
  const isEn = getLocale() === 'en';
  const msg = isEn
    ? item.messageEn || item.summaryEn || item.titleEn || item.message || item.messageZh || item.summaryZh || item.titleZh
    : item.messageZh || item.summaryZh || item.titleZh || item.message || item.messageEn || item.summaryEn || item.titleEn;
  return String(msg || item.code || '').trim();
}

function formatInspectChannelLabel(channelUsed) {
  const ch = String(channelUsed || '').trim();
  if (!ch) return '';
  if (ch === 'github-mirror') return t('镜像加速', 'Mirror');
  if (ch === 'codeload' || ch === 'github-codeload' || ch === 'codeload-head') return t('Codeload 直连', 'Codeload');
  if (ch === 'github-release' || ch === 'release-asset') return 'GitHub Release';
  if (ch === 'github-direct') return t('GitHub 直连', 'GitHub Direct');
  if (ch === 'staged-inspect') return t('本地预检缓存', 'Staged Cache');
  return ch;
}

function openGithubUrlModal(prefillUrl = '') {
  state.githubUrlModal = {
    phase: 'input',
    url: String(prefillUrl || '').trim(),
    inspectToken: '',
    selectedPluginRoot: '.',
    installMode: 'native',
    confirmEscalation: false,
    inspectResult: null,
    subpathCandidates: null,
    error: '',
  };
  state.focusGithubUrlInput = true;
  render();
}

async function triggerGithubUrlInspect({ url = '', inspectToken = '', pluginRoot = '' } = {}) {
  if (!state.githubUrlModal) openGithubUrlModal(url);
  const m = state.githubUrlModal;
  const cleanUrl = String(url || m.url || '').trim();
  if (!cleanUrl) {
    m.error = t('请粘贴完整的 GitHub 插件仓库或归档链接。', 'Please enter a valid GitHub repository or archive URL.');
    m.phase = 'input';
    render();
    return;
  }

  const seq = ++githubInspectSeq;
  m.url = cleanUrl;
  m.phase = 'inspecting';
  m.error = '';
  if (!inspectToken) {
    m.subpathCandidates = null;
  }
  render();

  try {
    const body = {
      url: cleanUrl,
      workspaceUris: state.workspaceUris,
    };
    if (inspectToken) body.inspectToken = inspectToken;
    if (pluginRoot) body.pluginRoot = pluginRoot;

    const res = await apiFetch('/api/github/inspect', {
      method: 'POST',
      body,
    });
    if (seq !== githubInspectSeq || !state.githubUrlModal) return;

    const status = String(res?.status || '');
    if (status === 'READY') {
      const pf = res.preflight || {};
      const defaultMode =
        pf.defaultInstallMode && ['native', 'isolate', 'replace'].includes(pf.defaultInstallMode)
          ? pf.defaultInstallMode
          : pf.action === 'conflict-prompt' || pf.action === 'install-scoped' || pf.isForeignSelfCollision
            ? 'isolate'
            : 'native';
      const resolvedRoot =
        res.plugin?.pluginRoot || res.plugin?.repository?.pluginRoot || pluginRoot || '.';
      state.githubUrlModal = {
        ...state.githubUrlModal,
        phase: 'preview',
        url: cleanUrl,
        inspectToken: res.inspectToken || inspectToken || '',
        selectedPluginRoot: resolvedRoot,
        installMode: defaultMode,
        confirmEscalation: false,
        inspectResult: res,
        error: '',
      };
      return;
    }

    if (status === 'SUBPATH_SELECTION_REQUIRED') {
      const candidates = Array.isArray(res.candidates) ? res.candidates : [];
      state.githubUrlModal = {
        ...state.githubUrlModal,
        phase: 'subpaths',
        url: cleanUrl,
        inspectToken: res.inspectToken || inspectToken || '',
        selectedPluginRoot: '.',
        inspectResult: res,
        subpathCandidates: candidates,
        error: '',
      };
      return;
    }

    if (
      status === 'NOT_A_PLUGIN_REPO' ||
      status === 'SECURITY_BLOCKED' ||
      status === 'UNSAFE_ARCHIVE'
    ) {
      state.githubUrlModal = {
        ...state.githubUrlModal,
        phase: 'unsupported',
        url: cleanUrl,
        inspectToken: '',
        inspectResult: res,
        error: '',
      };
      return;
    }

    const errMsg =
      (getLocale() === 'en' ? res?.reasonEn || res?.error || res?.reasonZh : res?.reasonZh || res?.error || res?.reasonEn) ||
      t('无法解析该 GitHub 链接，请检查链接格式与网络连通性。', 'Unable to inspect this GitHub URL. Check the link format and network access.');
    state.githubUrlModal = {
      ...state.githubUrlModal,
      phase: 'input',
      error: errMsg,
    };
  } catch (err) {
    if (seq !== githubInspectSeq || !state.githubUrlModal) return;
    state.githubUrlModal = {
      ...state.githubUrlModal,
      phase: 'input',
      error: err?.message || String(err),
    };
  } finally {
    if (seq === githubInspectSeq) render();
  }
}

async function triggerGithubUrlInstall() {
  if (isUpdateActionLocked()) return;
  const m = state.githubUrlModal;
  if (!m || m.phase !== 'preview') return;

  const pluginInfo = m.inspectResult?.plugin || {};
  const pf = m.inspectResult?.preflight || {};
  const esc = normalizeInspectEscalation(m.inspectResult?.escalation);
  const pluginLabel = pluginInfo.displayName || pluginInfo.canonicalName || pluginInfo.id || 'Plugin';
  const isUpdate = pf.action === 'update';

  if (esc.hasEscalation && !m.confirmEscalation) {
    m.error = t(
      '此次更新包含新增能力声明，请先勾选下方确认框后再继续。',
      'Please check the confirmation box for added capabilities before continuing.',
    );
    render();
    return;
  }

  m.phase = 'installing';
  m.error = '';
  state.errorBanner = null;
  render();

  try {
    const res = await apiFetch('/api/github/install', {
      method: 'POST',
      body: {
        inspectToken: m.inspectToken || '',
        url: m.url,
        pluginRoot: m.selectedPluginRoot || pluginInfo.pluginRoot || '.',
        installMode: m.installMode || 'native',
        confirmEscalation: Boolean(m.confirmEscalation),
        workspaceUris: state.workspaceUris,
      },
    });

    if (res.state) {
      applyServerState(res.state);
    }

    if (res.status === 'CONFLICT_CHOICE_REQUIRED') {
      const nextPf = {
        ...(m.inspectResult?.preflight || {}),
        action: 'conflict-prompt',
        conflictItem: res.conflict || m.inspectResult?.preflight?.conflictItem || null,
        canReplace:
          Array.isArray(res.choices) &&
          res.choices.includes('replace') &&
          res.conflict?.dir !== 'agy-market',
      };
      if (m.inspectResult) {
        m.inspectResult = { ...m.inspectResult, preflight: nextPf };
      }
      m.installMode = 'isolate';
      m.phase = 'preview';
      m.error = t(
        '检测到本地同名插件冲突，请选择隔离安装或覆盖替换后再确认。',
        'Local plugin name collision detected. Choose isolated install or replace and confirm again.',
      );
      return;
    }

    if (res.status === 'CAPABILITY_ESCALATION_CONFIRM_REQUIRED') {
      if (m.inspectResult) {
        m.inspectResult = { ...m.inspectResult, escalation: res.escalation || m.inspectResult.escalation };
      }
      m.confirmEscalation = false;
      m.phase = 'preview';
      m.error = t(
        '检测到新增能力权限，请勾选确认框后再继续安装。',
        'New capabilities detected. Confirm via the checkbox to proceed.',
      );
      return;
    }

    if (res.ok || res.status === 'INSTALLED') {
      state.githubUrlModal = null;
      state.errorBanner = null;
      const installedDir = res.installedDir || pluginInfo.canonicalName || '';
      const installedVer = res.version || pluginInfo.version || '';
      const nom = res.nomination || m.inspectResult?.nomination || null;
      const isPublicUnlisted = Boolean(
        (res.isPublicRepo ?? m.inspectResult?.isPublicRepo) &&
          !(res.catalogMatch ?? m.inspectResult?.catalogMatch) &&
          nom?.issueUrl &&
          isSafeHttpUrl(nom.issueUrl),
      );
      state.nominationBanner = isPublicUnlisted
        ? {
            displayName: pluginInfo.displayName || installedDir || pluginLabel,
            repo: nom.repo || '',
            pluginRoot: nom.pluginRoot || pluginInfo.pluginRoot || '.',
            issueUrl: nom.issueUrl,
          }
        : null;
      markPluginVerifiedLatest(installedDir, res.id || pluginInfo.id || '');
      const act = res.activation || resolveActivationInfo(pluginInfo);
      const restartInfo = maybeTriggerRestartBanner({
        pluginName: pluginInfo.displayName || installedDir || pluginLabel,
        operation: isUpdate ? 'update' : 'install',
        restartRequired: Boolean(res.restartRequired),
        reloadRequired: Boolean(res.reloadRequired),
        retiredBinaries: res.retiredBinaries || [],
        activation: act,
      });

      showToast(
        `${t(isUpdate ? '更新已完成' : '安装已完成', isUpdate ? 'Updated' : 'Installed')}: ${installedDir}${installedVer ? ` ${formatV(installedVer)}` : ''}`,
        {
          subtext: restartInfo?.reason || '',
          tone: 'ok',
          durationMs: restartInfo ? 6500 : 4500,
        },
      );
      state.activeTab = 'installed';
      state.installedSearch = '';
      state.installedFilter = 'all';
      void checkUpdates(false, { silent: true, allowWhileBusy: true });
      if (state.conflicts.loaded) void loadConflicts({ silent: true });
      return;
    }

    const errMsg = res.error || res.status || t('通过 GitHub 链接安装失败', 'Install from GitHub URL failed');
    setErrorBanner({
      title: t('GitHub 链接安装失败', 'GitHub URL Install Failed'),
      items: [{ pluginName: pluginLabel, message: errMsg }],
    });
    showToast(`${t('安装失败', 'Install failed')} (${pluginLabel}): ${errMsg}`, {
      tone: 'danger',
      durationMs: 8000,
    });
    if (state.githubUrlModal) {
      state.githubUrlModal.phase = 'preview';
      state.githubUrlModal.error = errMsg;
    }
  } catch (err) {
    const errMsg = err?.message || String(err);
    setErrorBanner({
      title: t('GitHub 链接安装失败', 'GitHub URL Install Failed'),
      items: [{ pluginName: pluginLabel, message: errMsg }],
    });
    showToast(`${t('安装失败', 'Install failed')} (${pluginLabel}): ${errMsg}`, {
      tone: 'danger',
      durationMs: 8000,
    });
    if (state.githubUrlModal) {
      state.githubUrlModal.phase = 'preview';
      state.githubUrlModal.error = errMsg;
    }
  } finally {
    render();
  }
}

async function triggerDirectPluginUpdate({
  id = '',
  dir = '',
  displayName = '',
  source = '',
  updateChannel = '',
  targetRef = '',
  updateKind = '',
  trackBranch = '',
  repositoryUrl = '',
  preferUpstream = false,
  forceResync = false,
  confirmEscalation = false,
  _internalDelegated = false,
} = {}) {
  if (!_internalDelegated && isUpdateActionLocked()) return;
  const cleanDir = String(dir || '').trim();
  const targetId = String(id || cleanDir).trim();
  if (!targetId && !cleanDir) return;
  const label = String(displayName || cleanDir || targetId).trim();

  if (cleanDir === 'agy-market' || targetId === 'azwosile__agy-market') {
    await triggerSelfUpdate({
      confirmEscalation,
      updateChannel,
      targetRef,
      _internalDelegated: true,
    });
    return;
  }

  state.busyId = targetId || cleanDir;
  state.errorBanner = null;
  render();
  try {
    const body = {
      id: targetId,
      dir: cleanDir,
      confirmEscalation: Boolean(confirmEscalation),
      workspaceUris: state.workspaceUris,
    };
    if (source) body.source = source;
    if (updateChannel) body.updateChannel = updateChannel;
    if (targetRef) body.targetRef = targetRef;
    if (updateKind) body.updateKind = updateKind;
    if (trackBranch) body.trackBranch = trackBranch;
    if (repositoryUrl) body.repositoryUrl = repositoryUrl;
    if (preferUpstream) body.preferUpstream = true;
    if (forceResync) body.forceResync = true;

    const res = await apiFetch('/api/update', {
      method: 'POST',
      body,
    });

    if (res.state) {
      applyServerState(res.state);
    }

    if (res.status === 'CAPABILITY_ESCALATION_CONFIRM_REQUIRED') {
      const normEsc = normalizeInspectEscalation(res.escalation);
      const { byId: updById, byDir: updByDir } = getUpdateMaps();
      const loc = cleanDir ? getGlobalInstalledByDirMap().get(cleanDir) || getInstalledByDirMap().get(cleanDir) || null : null;
      const matchedUpd =
        (loc && findUpdateForLocal(loc, updById, updByDir)) ||
        (cleanDir && updByDir.get(cleanDir)) ||
        (targetId && updById.get(targetId)) ||
        null;
      const escInstalledCommitSha =
        res.installedCommitSha ||
        matchedUpd?.installedCommitSha ||
        String(loc?.receipt?.commitSha || '').slice(0, 7) ||
        '';
      const escLatestCommitSha =
        res.latestCommitSha ||
        matchedUpd?.latestCommitSha ||
        (updateKind === 'commit' && /^[0-9a-f]{7,40}$/i.test(String(targetRef || '').trim())
          ? String(targetRef).trim().slice(0, 7)
          : '');
      state.escalationModal = {
        mode: 'direct-update',
        items: [
          {
            id: targetId,
            dir: cleanDir,
            displayName: label,
            source,
            updateChannel,
            targetRef,
            updateKind,
            trackBranch,
            repositoryUrl,
            preferUpstream,
            forceResync: Boolean(forceResync),
            installedVersion: res.installedVersion || loc?.version || matchedUpd?.installedVersion || '?',
            targetVersion: res.targetVersion || matchedUpd?.latestVersion || '?',
            installedCommitSha: escInstalledCommitSha,
            latestCommitSha: escLatestCommitSha,
            escalation: {
              addedBadges: normEsc.addedBadges,
              addedRemoteDomains: normEsc.addedDomains,
              addedHookEvents: normEsc.addedHooks,
            },
          },
        ],
      };
      return;
    }

    if (res.ok) {
      state.escalationModal = null;
      state.errorBanner = null;
      if (res.isSelfUpdate || res.willRestart) {
        startReconnectPolling(res.version || '');
        return;
      }
      const installedDir = String(res.installedDir || cleanDir).trim();
      markPluginVerifiedLatest(installedDir, targetId);
      if (cleanDir && cleanDir !== installedDir) {
        markPluginVerifiedLatest(cleanDir, targetId);
      }
      if (res.alreadyUpToDate || res.status === 'ALREADY_UP_TO_DATE') {
        const verStr = res.version ? formatV(res.version) : '';
        showToast(
          verStr
            ? t(`「${label}」当前已是最新版本（${verStr}）`, `"${label}" is already up to date (${verStr})`)
            : t(`「${label}」当前已是最新版本`, `"${label}" is already up to date`),
          { tone: 'ok', durationMs: 3500 },
        );
        return;
      }
      const restartInfo = maybeTriggerRestartBanner({
        pluginName: label,
        operation: 'update',
        restartRequired: Boolean(res.restartRequired),
        reloadRequired: Boolean(res.reloadRequired),
        retiredBinaries: res.retiredBinaries || [],
        activation: res.activation || null,
      });
      showToast(
        `${t('更新已完成', 'Updated')}: ${installedDir}${res.version ? ` ${formatV(res.version)}` : ''}`,
        {
          subtext: restartInfo?.reason || '',
          tone: 'ok',
          durationMs: restartInfo ? 6500 : 4500,
        },
      );
      await checkUpdates(false, { silent: true, allowWhileBusy: true });
      if (state.conflicts.loaded) void loadConflicts({ silent: true });
    } else {
      const errMsg = res.error || res.status || t('插件更新未能完成', 'Plugin update did not complete');
      setErrorBanner({
        title: t('插件更新失败', 'Plugin Update Failed'),
        items: [{ pluginName: label, message: errMsg }],
        retryAction: {
          type: 'update-plugin-direct',
          id: targetId,
          dir: cleanDir,
          displayName: label,
          source,
          updateChannel,
          targetRef,
          updateKind,
          trackBranch,
          repositoryUrl,
          preferUpstream,
          forceResync: Boolean(forceResync),
        },
      });
      showToast(`${t('更新失败', 'Update failed')} (${label}): ${errMsg}`, {
        tone: 'danger',
        durationMs: 8000,
      });
    }
  } catch (err) {
    const errMsg = err?.message || String(err);
    setErrorBanner({
      title: t('插件更新失败', 'Plugin Update Failed'),
      items: [{ pluginName: label, message: errMsg }],
      retryAction: {
        type: 'update-plugin-direct',
        id: targetId,
        dir: cleanDir,
        displayName: label,
        source,
        updateChannel,
        targetRef,
        updateKind,
        trackBranch,
        repositoryUrl,
        preferUpstream,
        forceResync: Boolean(forceResync),
      },
    });
    showToast(`${t('更新失败', 'Update failed')} (${label}): ${errMsg}`, {
      tone: 'danger',
      durationMs: 8000,
    });
  } finally {
    state.busyId = '';
    render();
  }
}

async function triggerUpdateLocalGithub(opts = {}) {
  return triggerDirectPluginUpdate(opts);
}

async function triggerSyncInstalledPlugin({ dir = '', id = '', displayName = '' } = {}) {
  if (isUpdateActionLocked()) return;
  const cleanDir = String(dir || '').trim();
  const targetId = String(id || cleanDir).trim();
  if (!cleanDir && !targetId) return;
  const label = String(displayName || cleanDir || targetId).trim();

  if (cleanDir === 'agy-market' || targetId === 'azwosile__agy-market') {
    state.busyId = cleanDir || targetId;
    state.errorBanner = null;
    render();
    try {
      await checkUpdates(true, { silent: true, allowWhileBusy: true });
      if (state.updates.error) {
        state.busyId = '';
        showToast(`${t('检查更新失败', 'Update check failed')}: ${state.updates.error}`, {
          tone: 'danger',
          durationMs: 7000,
        });
        return;
      }
      const su = state.updates.selfUpdate || null;
      if (!su) {
        markPluginVerifiedLatest('agy-market', 'azwosile__agy-market');
        state.busyId = '';
        showToast(t('AGY Market 当前已是最新版本', 'AGY Market is already up to date'), {
          tone: 'ok',
          durationMs: 3500,
        });
        return;
      }
      await triggerSelfUpdate({
        confirmEscalation: false,
        updateChannel: su.updateChannel || '',
        targetVersion: su.latestVersion || '',
        targetRef: su.targetRef || '',
        _internalDelegated: true,
      });
    } finally {
      state.busyId = '';
      render();
    }
    return;
  }

  state.busyId = targetId || cleanDir;
  state.errorBanner = null;
  render();
  let delegated = false;
  try {
    await checkUpdates(true, { silent: true, allowWhileBusy: true });

    if (state.updates.error) {
      state.busyId = '';
      showToast(`${t('检查更新失败', 'Update check failed')}: ${state.updates.error}`, {
        tone: 'danger',
        durationMs: 7000,
      });
      return;
    }

    const { byId: updById, byDir: updByDir } = getUpdateMaps();
    const { byId: catById, byDir: catByDir } = getCatalogMaps();
    const loc = getGlobalInstalledByDirMap().get(cleanDir) || getInstalledByDirMap().get(cleanDir) || null;
    const freshUpd = loc
      ? findUpdateForLocal(loc, updById, updByDir)
      : (() => {
          const cand = (cleanDir && updByDir.get(cleanDir)) || (targetId && updById.get(targetId)) || null;
          if (!cand || (cleanDir && cand.dir && cand.dir !== cleanDir)) return null;
          return isUpdateEffectiveForLocal(cand, null) ? cand : null;
        })();
    const catEntry =
      (freshUpd?.id && catById.get(freshUpd.id)) ||
      (targetId && catById.get(targetId)) ||
      (loc?.receipt?.id && catById.get(loc.receipt.id)) ||
      (cleanDir && catByDir.get(cleanDir)) ||
      null;

    if (!freshUpd) {
      markPluginVerifiedLatest(cleanDir || loc?.dir || '', catEntry?.id || targetId);
      state.busyId = '';
      showToast(t(`「${label}」当前已是最新版本`, `"${label}" is already up to date`), {
        tone: 'ok',
        durationMs: 3500,
      });
      return;
    }

    delegated = true;
    await triggerDirectPluginUpdate({
      id: freshUpd.id || catEntry?.id || targetId,
      dir: freshUpd.dir || cleanDir,
      displayName: label,
      source: freshUpd.source || '',
      updateChannel: freshUpd.updateChannel || '',
      targetRef: freshUpd.targetRef || '',
      updateKind: freshUpd.updateKind || '',
      trackBranch: freshUpd.trackBranch || '',
      repositoryUrl: freshUpd.repositoryUrl || catEntry?.repository?.url || loc?.repositoryUrl || loc?.receipt?.repositoryUrl || '',
      preferUpstream: isDirectGithubUpdateItem(freshUpd),
      _internalDelegated: true,
    });
  } finally {
    if (!delegated) {
      state.busyId = '';
      render();
    }
  }
}

function startReconnectPolling(targetVersion = '') {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  const previousVersion = state.serverState?.plugin?.version || '';
  state.reconnecting = {
    targetVersion,
    previousVersion,
    phase: 'restarting',
    attempts: 0,
    sawDown: false,
    timedOut: false,
  };
  render();

  const maxAttempts = 28;
  const poll = async () => {
    if (!state.reconnecting) return;
    state.reconnecting.attempts += 1;
    state.reconnecting.phase = 'polling';
    render();

    try {
      const fn = getFetchImpl();
      const res = await fn('/healthz', { method: 'GET', cache: 'no-store' });
      if (res.ok) {
        const data = await res.json().catch(() => ({}));
        const versionChanged = Boolean(
          targetVersion && data?.version && String(data.version) === String(targetVersion),
        );
        const recovered =
          state.reconnecting.sawDown ||
          versionChanged ||
          state.reconnecting.attempts >= 3;
        if (recovered) {
          state.reconnecting = null;
          state.dismissedSelfVersion = '';
          writeStorage(SELF_OFFER_DISMISSED_KEY, '');
          render();
          await loadState(false);
          await checkUpdates(false, { silent: true });
          if (!state.updates.selfUpdate && !state.updates.error) {
            state.verifiedLatestDirs.add('agy-market');
          }
          const versionBehind = Boolean(
            targetVersion && data?.version && String(data.version) !== String(targetVersion),
          );
          if (versionBehind) {
            maybeTriggerRestartBanner({
              pluginName: 'AGY Market',
              reloadRequired: true,
              activation: {
                level: 'reload-pane',
                reasonZh: 'AGY Market 已完成自更新，若界面未切换新版本请重开侧边栏。',
                reasonEn: 'AGY Market updated; reopen Sidebar if UI has not switched to the new version.',
              },
            });
          }
          showToast(
            versionBehind
              ? t(
                  `服务已恢复 (${formatV(data.version)})，若界面未切换请重开侧边栏`,
                  `Reconnected (${formatV(data.version)}); reopen Sidebar if UI did not refresh`,
                )
              : t(
                  `AGY Market 已重启并恢复服务${data?.version ? ` (${formatV(data.version)})` : ''}`,
                  `AGY Market reconnected${data?.version ? ` (${formatV(data.version)})` : ''}`,
                ),
            { tone: 'ok' },
          );
          return;
        }
      } else {
        state.reconnecting.sawDown = true;
      }
    } catch {
      if (state.reconnecting) state.reconnecting.sawDown = true;
    }

    if (!state.reconnecting) return;
    if (state.reconnecting.attempts >= maxAttempts) {
      state.reconnecting.timedOut = true;
      render();
      return;
    }
    reconnectTimer = setTimeout(poll, 900);
  };

  reconnectTimer = setTimeout(poll, 700);
}

async function fetchDetailReadme(plugin) {
  if (!plugin) return;
  const seq = ++readmeRequestSeq;
  const locale = getLocale();
  const dir = plugin.installStatus?.installedDir || plugin.canonicalName || '';
  state.detailReadmeLoading = true;
  state.detailReadmeLocale = locale;
  render();
  try {
    const qs = new URLSearchParams();
    if (plugin.id) qs.set('id', plugin.id);
    if (dir) qs.set('dir', dir);
    qs.set('locale', locale);
    const res = await apiFetch(`/api/readme?${qs.toString()}`);
    if (seq !== readmeRequestSeq) return;
    if (state.detailPlugin?.id === plugin.id) {
      state.detailReadme = res.markdown || '';
      state.detailReadmeLocale = res.locale || locale;
      state.detailReadmeIsZh = Boolean(res.isTranslatedOrNativeZh || hasCjk(res.markdown || ''));
    }
  } catch {
    if (seq === readmeRequestSeq && state.detailPlugin?.id === plugin.id) {
      state.detailReadme = '';
      state.detailReadmeIsZh = false;
    }
  } finally {
    if (seq === readmeRequestSeq && state.detailPlugin?.id === plugin.id) {
      state.detailReadmeLoading = false;
      render();
    }
  }
}

async function openPluginDetail(plugin, initialTab = 'overview') {
  state.detailPlugin = plugin;
  state.detailTab = initialTab;
  state.detailReadme = '';
  state.detailReadmeIsZh = false;
  state.detailReadmeLoading = true;
  render();

  if (initialTab === 'discuss') {
    void loadPluginDiscussions(plugin.id, false);
  }
  void fetchDetailReadme(plugin);
}

async function loadPluginDiscussions(pluginId, force = false) {
  if (!pluginId) return;
  const cached = state.discussionsCache[pluginId];
  if (!force && cached && (cached.loading || cached.data)) {
    return;
  }
  state.discussionsCache[pluginId] = { loading: true, data: cached?.data || null, error: '' };
  render();
  try {
    const res = await apiFetch(`/api/discussions?id=${encodeURIComponent(pluginId)}${force ? '&force=1' : ''}`);
    state.discussionsCache[pluginId] = {
      loading: false,
      data: {
        url: res.url || '',
        newDiscussionUrl: res.newDiscussionUrl || '',
        items: Array.isArray(res.items) ? res.items : [],
        disabled: Boolean(res.disabled),
        needsToken: Boolean(res.needsToken),
        rateLimited: Boolean(res.rateLimited),
      },
      error: res.ok === false ? res.error || '' : '',
    };
  } catch (err) {
    state.discussionsCache[pluginId] = {
      loading: false,
      data: null,
      error: err?.message || String(err),
    };
  } finally {
    render();
  }
}

async function updatePrefs(patch, successMsg = '') {
  try {
    state.loading = true;
    render();
    applyServerState(
      await apiFetch('/api/prefs', {
        method: 'POST',
        body: { ...patch, workspaceUris: state.workspaceUris },
      }),
    );
    if ('githubToken' in patch || 'clearGithubToken' in patch) {
      state.discussionsCache = {};
    }
    showToast(successMsg || t('已保存源与网络加速设置', 'Saved catalog & mirror preferences'), { tone: 'ok' });
    if ('locale' in patch && state.detailPlugin) {
      void fetchDetailReadme(state.detailPlugin);
    }
    if ('githubToken' in patch || 'clearGithubToken' in patch || 'primaryCatalogUrl' in patch || 'networkMode' in patch) {
      void checkUpdates(true, { silent: true });
    }
  } catch (err) {
    showToast(`${t('保存失败', 'Save error')}: ${err?.message || String(err)}`, { tone: 'danger' });
  } finally {
    state.loading = false;
    render();
  }
}

function execCommandCopyFallback(text) {
  const ta = document.createElement('textarea');
  ta.value = String(text ?? '');
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.top = '-9999px';
  ta.style.left = '-9999px';
  ta.style.opacity = '0';
  ta.style.pointerEvents = 'none';
  document.body.appendChild(ta);
  ta.focus();
  ta.select();
  try {
    ta.setSelectionRange(0, ta.value.length);
  } catch {
    /* ignore */
  }
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  } finally {
    ta.remove();
  }
  return ok;
}

async function copyText(text, key, toastMsg = '') {
  const str = String(text ?? '');
  let copied = false;
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(str);
      copied = true;
    } catch {
      copied = execCommandCopyFallback(str);
    }
  } else {
    copied = execCommandCopyFallback(str);
  }

  if (copied) {
    state.copiedKey = key;
    if (toastMsg) {
      showToast(toastMsg, { tone: 'ok', durationMs: 2800 });
    } else {
      render();
    }
    setTimeout(() => {
      if (state.copiedKey === key) {
        state.copiedKey = '';
        render();
      }
    }, 1800);
  }
  return copied;
}

// ==========================================================================
// Rendering Helpers (UI Components)
// ==========================================================================

function renderBadgesHtml(capabilities = {}, { maxCount = 0 } = {}) {
  const loc = getLocale();
  const badges = Array.isArray(capabilities?.badges) ? capabilities.badges : [];
  if (!badges.length) return '';

  const visible = maxCount > 0 && badges.length > maxCount ? badges.slice(0, maxCount) : badges;
  const hidden = maxCount > 0 && badges.length > maxCount ? badges.slice(maxCount) : [];

  const html = visible
    .map((id) => {
      const spec = getUiBadgeSpec(id);
      const label = cleanBadgeText(id, capabilities);
      const tip = loc === 'en' ? spec.descEn : spec.descZh;
      return `<span class="cap-badge tone-${escapeHtml(spec.tone)}" title="${escapeHtml(tip)}">${badgeIcon(id, 11)}<span>${escapeHtml(label)}</span></span>`;
    })
    .join('');

  if (hidden.length > 0) {
    const hiddenNames = hidden.map((id) => cleanBadgeText(id, capabilities)).join(' · ');
    return `${html}<span class="cap-badge is-more" title="${escapeHtml(hiddenNames)}">+${hidden.length}</span>`;
  }
  return html;
}

function renderFavoriteButtonHtml({ key, displayName = '', sizeClass = '' }) {
  if (!key) return '';
  const fav = isFavoritedKey(key);
  const icoSize = sizeClass === 'is-mini' ? 11 : sizeClass === 'is-drawer' ? 14 : 13;
  const label = fav
    ? t(`取消收藏「${displayName || key}」`, `Remove "${displayName || key}" from Favorites`)
    : t(`收藏「${displayName || key}」`, `Add "${displayName || key}" to Favorites`);
  return `
    <button
      type="button"
      class="fav-btn ${fav ? 'is-favorited' : ''} ${sizeClass}"
      data-action="toggle-favorite"
      data-fav-key="${escapeHtml(key)}"
      data-fav-name="${escapeHtml(displayName || '')}"
      data-stop-card="1"
      aria-pressed="${fav ? 'true' : 'false'}"
      aria-label="${escapeHtml(label)}"
      title="${escapeHtml(label)}"
    >${icon(fav ? 'starFilled' : 'star', icoSize)}</button>
  `;
}

function renderLogoHtml(iconUrl, name, { sizeClass = '', isSelf = false } = {}) {
  const monogram = String(name || 'P').trim().charAt(0).toUpperCase() || 'P';
  const cls = sizeClass ? `plugin-logo ${sizeClass}` : 'plugin-logo';
  const inner = iconUrl
    ? `<span aria-hidden="true">${escapeHtml(monogram)}</span><img src="${escapeHtml(iconUrl)}" alt="" loading="lazy" onerror="this.style.display='none'" />`
    : isSelf
      ? BRAND_LOGO_SVG
      : `<span aria-hidden="true">${escapeHtml(monogram)}</span>`;
  return `
    <div class="plugin-logo-wrap">
      <div class="${cls}">
        ${inner}
      </div>
    </div>
  `;
}

function renderCardTitleHtml(title, repoUrl) {
  const safeTitle = String(title || '').trim() || 'Plugin';
  if (isSafeHttpUrl(repoUrl)) {
    return `<a class="card-title-link" href="${escapeHtml(repoUrl)}" target="_blank" rel="noopener noreferrer" data-stop-card="1" title="${escapeHtml(t(`打开 GitHub 仓库：${safeTitle}`, `Open GitHub repository: ${safeTitle}`))}">${escapeHtml(safeTitle)}<span class="title-ext-ico" aria-hidden="true">${icon('arrowUpRight', 12)}</span></a>`;
  }
  return `<span class="card-title-text" title="${escapeHtml(safeTitle)}">${escapeHtml(safeTitle)}</span>`;
}

function normalizeSidecarViewPath(rawPath) {
  const s = String(rawPath || '').trim();
  if (!s || s === '/') return '/';
  if (s.startsWith('?') || s.startsWith('#')) return `/${s}`;
  return `/${s.replace(/^\/+/, '')}`;
}

function buildSidecarPaneUri(dir, folder, viewPath) {
  const cleanDir = String(dir || '').trim();
  const cleanFolder = String(folder || 'pane').trim() || 'pane';
  const normPath = normalizeSidecarViewPath(viewPath);
  const relPath = normPath.replace(/^\/+/, '');
  return `sidecar://${cleanDir}/${cleanFolder}/${relPath}`;
}

function parseSidecarPaneTarget(dir, sidecarPane) {
  if (!sidecarPane) return null;
  let targetDir = String(dir || '').trim();
  let folder = String(sidecarPane.sidecarFolder || '').trim();
  let viewPath = sidecarPane.viewPath || sidecarPane.path || '/';
  const rawUri = String(sidecarPane.uri || '').trim();
  const m = /^sidecar:\/\/([^/?#]+)\/([^/?#]+)((?:[/?#].*)?)$/i.exec(rawUri);
  if (m) {
    if (!targetDir && m[1]) targetDir = m[1];
    if (!folder && m[2]) folder = m[2];
    if (m[3]) viewPath = m[3];
  }
  if (!targetDir) return null;
  const finalFolder = folder || 'pane';
  const normPath = normalizeSidecarViewPath(viewPath);
  return {
    dir: targetDir,
    folder: finalFolder,
    viewPath: normPath,
    title: sidecarPane.title || targetDir,
    uri: buildSidecarPaneUri(targetDir, finalFolder, normPath),
  };
}

function renderOpenPaneButtonHtml({ dir, sidecarPane, enabled, btnClass = 'dock-btn is-pane', label = '' }) {
  // Never render redundant Pane button on AGY Market itself or on disabled plugins; NEVER emit raw sidecar:// <a href>!
  if (!dir || dir === 'agy-market' || !enabled || (!sidecarPane?.uri && !sidecarPane?.sidecarFolder)) return '';
  const target = parseSidecarPaneTarget(dir, sidecarPane);
  if (!target) return '';
  return `<button type="button" class="${btnClass}" data-action="open-pane" data-dir="${escapeHtml(target.dir)}" data-folder="${escapeHtml(target.folder)}" data-path="${escapeHtml(target.viewPath)}" data-title="${escapeHtml(target.title)}" data-uri="${escapeHtml(target.uri)}" data-stop-card="1" title="${escapeHtml(t(`打开「${target.title}」Sidebar 侧边栏`, `Open "${target.title}" Sidebar`))}">${icon('panel', 12)} <span>${escapeHtml(label || t('面板', 'Pane'))}</span></button>`;
}

function renderToggleSliderHtml({ dir, enabled, canToggle, toggleDisabledReason }) {
  if (!dir) return '';
  const reason = String(toggleDisabledReason || '');
  const isSelf = dir === 'agy-market' || reason === 'self';
  const isLocked = isSelf || canToggle === false;
  const isBusy = state.togglingDir === dir;
  const isOn = isSelf ? true : Boolean(enabled);

  let tooltip = isOn
    ? t('点击移入停放仓并禁用（免改 config.json）', 'Click to park & disable plugin (no config.json edits)')
    : t('点击从停放仓恢复并立即启用', 'Click to restore & enable plugin');
  let labelText = isBusy
    ? t('切换中…', 'Switching…')
    : isOn
      ? t('启用', 'Enabled')
      : t('已禁用', 'Disabled');

  if (isSelf) {
    tooltip = t('当前面板运行中 · 不可在市场面板内停用自身', 'Active panel running — cannot disable self inside pane');
    labelText = t('当前面板运行中', 'Active Panel');
  } else if (reason === 'host-disabled') {
    tooltip = t('已在 Antigravity 宿主设置中禁用，请通过宿主插件管理启用', 'Disabled by Antigravity host settings');
    labelText = t('宿主已禁用', 'Host Disabled');
  } else if (reason === 'workspace') {
    tooltip = t('工作区级插件（.agents/plugins）由当前仓库管理', 'Workspace plugin managed by current repository');
    labelText = t('工作区', 'Workspace');
  } else if (reason === 'builtin') {
    tooltip = t('Antigravity 内置插件不可停用', 'Built-in Antigravity plugin');
    labelText = t('内置', 'Built-in');
  }

  return `
    <button
      type="button"
      role="switch"
      aria-checked="${isOn ? 'true' : 'false'}"
      class="prism-toggle ${isOn ? 'is-on' : 'is-off'} ${isLocked ? 'is-locked' : ''} ${isBusy ? 'is-busy' : ''}"
      data-action="toggle-plugin"
      data-dir="${escapeHtml(dir)}"
      data-next-enabled="${isOn ? '0' : '1'}"
      data-stop-card="1"
      ${isLocked || isBusy ? 'disabled aria-disabled="true"' : ''}
      title="${escapeHtml(tooltip)}"
    >
      <span class="prism-toggle-track" aria-hidden="true">
        <span class="prism-toggle-thumb">
          ${isBusy ? icon('refresh', 9, 'spin') : '<span class="prism-toggle-thumb-core"></span>'}
        </span>
      </span>
      <span class="prism-toggle-label">
        ${isLocked && !isBusy ? icon('lock', 10) : ''}
        <span>${escapeHtml(labelText)}</span>
      </span>
    </button>
  `;
}

function getFilteredPlugins() {
  const list = state.serverState?.catalog?.plugins || [];
  const loc = getLocale();
  const q = state.search.trim().toLowerCase();

  const filtered = list.filter((p) => {
    if (state.category !== 'all') {
      const cats = p.taxonomy?.categories || [];
      if (!cats.includes(state.category)) return false;
    }
    if (!q) return true;
    const desc = `${resolveCatalogDescription(p, 'zh')} ${resolveCatalogDescription(p, 'en')}`;
    const catTerms = (p.taxonomy?.categories || [])
      .map((c) => `${c} ${CATEGORY_LABELS[c]?.zh || ''} ${CATEGORY_LABELS[c]?.en || ''}`)
      .join(' ');
    const hay = `${p.displayName || ''} ${p.canonicalName || ''} ${p.scopedName || ''} ${p.id || ''} ${desc} ${catTerms} ${(p.taxonomy?.tags || []).join(' ')} ${(p.capabilities?.badges || []).join(' ')}`.toLowerCase();
    return hay.includes(q);
  });

  return sortCatalogPlugins(filtered, { sortBy: state.sortBy, locale: loc });
}

function renderRankingMetaPillsHtml(p) {
  const r = p?.ranking;
  const archived = Boolean(
    r?.archived ||
      p?.archived ||
      p?.repository?.archived ||
      p?.status === 'ARCHIVED' ||
      r?.status === 'ARCHIVED',
  );
  const stale =
    !archived &&
    Boolean(
      r?.stale ||
        p?.stale ||
        p?.status === 'STALE_WARNING' ||
        p?.status === 'STALE' ||
        r?.status === 'STALE_WARNING' ||
        r?.status === 'STALE',
    );
  const compatTier = typeof r?.compatTier === 'string' ? r.compatTier.toLowerCase() : '';
  const parts = [];
  if (archived) {
    parts.push(
      `<span class="meta-status-pill is-archived" title="${escapeHtml(t('上游 GitHub 仓库已归档（只读）', 'Upstream GitHub repository is archived'))}">ARCHIVED</span>`,
    );
  } else if (stale) {
    parts.push(
      `<span class="meta-status-pill is-stale" title="${escapeHtml(t('该插件较长时间未有新提交', 'No recent upstream updates'))}">STALE</span>`,
    );
  }
  if (compatTier === 'compatible') {
    parts.push(
      `<span class="meta-status-pill is-compat" title="${escapeHtml(t('多宿主兼容插件（可运行于 Antigravity）', 'Multi-host compatible plugin'))}">${escapeHtml(t('兼容', 'Compat'))}</span>`,
    );
  }
  return parts.join('');
}

function getCategoryCounts() {
  const plugins = state.serverState?.catalog?.plugins || [];
  const counts = { all: plugins.length };
  for (const p of plugins) {
    for (const c of p.taxonomy?.categories || []) {
      counts[c] = (counts[c] || 0) + 1;
    }
  }
  return counts;
}

function renderSkeletonGrid(count = 4) {
  return `
    <div class="cards-grid" aria-busy="true" aria-label="${escapeHtml(t('正在加载插件…', 'Loading plugins…'))}">
      ${Array.from({ length: count })
        .map(
          () => `
          <div class="skel-card">
            <div class="skel-row">
              <div class="skel skel-avatar"></div>
              <div style="flex:1;display:flex;flex-direction:column;gap:7px">
                <div class="skel skel-line" style="width:68%"></div>
                <div class="skel skel-line" style="width:42%"></div>
              </div>
            </div>
            <div class="skel skel-line" style="width:94%"></div>
            <div class="skel skel-line" style="width:76%"></div>
            <div class="skel-row">
              <div class="skel skel-pill"></div>
              <div class="skel skel-pill" style="width:96px"></div>
            </div>
          </div>
        `,
        )
        .join('')}
    </div>
  `;
}

// ==========================================================================
// Prominent Error Alert Banner, Smart Restart Banner & Overview Hero Strip
// ==========================================================================

function renderErrorAlertBanner() {
  const eb = state.errorBanner;
  if (!eb) return '';
  const items = Array.isArray(eb.items) ? eb.items : [];
  const hasRetry = Boolean(eb.retryAction);
  const updateActionLocked = isUpdateActionLocked();

  return `
    <div class="error-alert-banner" role="alert" aria-live="assertive" data-agy-error-banner="1">
      <div class="error-alert-main">
        <div class="error-alert-icon">${icon('alertTriangle', 14)}</div>
        <div class="error-alert-copy">
          <div class="error-alert-title">
            <span>${escapeHtml(eb.title)}</span>
          </div>
          ${
            items.length
              ? `<div class="error-alert-list">
                  ${items
                    .map(
                      (it) => `
                    <div class="error-alert-item">
                      ${it.pluginName ? `<span class="error-plugin-chip">${escapeHtml(it.pluginName)}</span>` : ''}
                      <span class="error-alert-detail">${escapeHtml(it.message)}</span>
                    </div>
                  `,
                    )
                    .join('')}
                </div>`
              : ''
          }
        </div>
      </div>
      <div class="error-alert-actions">
        ${
          hasRetry
            ? `<button type="button" class="btn btn-danger-solid btn-sm" data-action="retry-error-banner"${updateActionLocked ? ' disabled aria-disabled="true"' : ''}>
                ${icon('refresh', 12)}
                <span>${escapeHtml(t('重试', 'Retry'))}</span>
              </button>`
            : ''
        }
        <button type="button" class="icon-btn is-square" data-action="dismiss-error-banner" title="${escapeHtml(t('关闭错误提示', 'Dismiss alert'))}">${icon('close', 13)}</button>
      </div>
    </div>
  `;
}

function renderRestartBanner() {
  const rn = state.restartBanner;
  if (!rn) return '';
  const isHostRestart = rn.level === 'host-restart';
  const op = rn.operation || 'update';
  let bannerTitle = '';
  if (op === 'uninstall') {
    bannerTitle = isHostRestart
      ? t(
          '插件已卸载：请重启 Antigravity 客户端以彻底释放残留状态',
          'Plugin uninstalled: restart Antigravity to release remaining state',
        )
      : t(
          '插件已卸载：建议关闭目标侧边栏或刷新 MCP',
          'Plugin uninstalled: close target Sidebar or refresh MCP',
        );
  } else if (op === 'install') {
    bannerTitle = isHostRestart
      ? t('安装已完成：请重启 Antigravity 客户端以生效', 'Installed: restart Antigravity to take effect')
      : t('安装已完成：建议重开目标侧边栏或刷新 MCP 生效', 'Installed: reopen Sidebar or refresh MCP');
  } else if (op === 'toggle') {
    bannerTitle = isHostRestart
      ? t('状态已切换：请重启 Antigravity 客户端以彻底释放句柄', 'Status updated: restart Antigravity to release file handles')
      : t('状态已切换：建议重开目标侧边栏或刷新 MCP 生效', 'Status updated: reopen Sidebar or refresh MCP');
  } else {
    bannerTitle = isHostRestart
      ? t('更新已就绪：请重启 Antigravity 客户端以生效', 'Update applied: restart Antigravity to take effect')
      : t('更新已就绪：建议重开目标侧边栏或刷新 MCP 生效', 'Update applied: reopen Sidebar or refresh MCP');
  }
  return `
    <div class="restart-notice-banner ${isHostRestart ? 'is-host-restart' : 'is-reload-pane'}" role="status" aria-live="polite" data-agy-restart-banner="1">
      <div class="restart-notice-main">
        <div class="restart-notice-icon">${icon(isHostRestart ? 'rocket' : 'refresh', 14)}</div>
        <div class="restart-notice-copy">
          <div class="restart-notice-title">
            <span>${escapeHtml(bannerTitle)}</span>
            ${rn.plugins.length ? `<span class="restart-notice-tags">${rn.plugins.map((n) => `<span class="restart-plugin-chip">${escapeHtml(n)}</span>`).join('')}</span>` : ''}
          </div>
          <div class="restart-notice-reason">${escapeHtml(rn.reasons.join(' · '))}</div>
        </div>
      </div>
      <div class="self-update-actions">
        <button type="button" class="icon-btn is-square" data-action="dismiss-restart-banner" title="${escapeHtml(t('知道了，收起提示', 'Dismiss notice'))}">${icon('close', 13)}</button>
      </div>
    </div>
  `;
}

function renderNominationBanner() {
  const nb = state.nominationBanner;
  if (!nb || !isSafeHttpUrl(nb.issueUrl)) return '';
  return `
    <div class="nomination-notice-banner" role="region" aria-label="${escapeHtml(t('分享公开插件到社区目录', 'Share public plugin with AGY Market'))}" data-agy-nomination-banner="1">
      <div class="nomination-notice-main">
        <div class="nomination-notice-icon">${icon('sparkle', 14)}</div>
        <div class="nomination-notice-copy">
          <div class="nomination-notice-title">
            <span>${escapeHtml(t('分享此公开插件到 AGY Market？', 'Share this public plugin with AGY Market?'))}</span>
            ${nb.repo ? `<span class="restart-plugin-chip">${escapeHtml(nb.repo)}${nb.pluginRoot && nb.pluginRoot !== '.' ? ` (${escapeHtml(nb.pluginRoot)})` : ''}</span>` : ''}
          </div>
          <div class="nomination-notice-reason">${escapeHtml(
            t(
              '仅预填公开仓库名与插件子目录至 GitHub 提名表单，不包含任何本机路径、用户名或 Token。',
              'Opens a pre-filled GitHub Issue with only owner/repo and pluginRoot — zero user, machine, or token info.',
            ),
          )}</div>
        </div>
      </div>
      <div class="self-update-actions">
        <a class="btn btn-primary btn-sm" href="${escapeHtml(nb.issueUrl)}" target="_blank" rel="noopener noreferrer">
          ${icon('plus', 12)}
          <span>${escapeHtml(t('去 GitHub 分享', 'Share on GitHub'))}</span>
          ${icon('external', 11)}
        </a>
        <button type="button" class="icon-btn is-square" data-action="dismiss-nomination-banner" title="${escapeHtml(t('关闭提示', 'Dismiss'))}">${icon('close', 13)}</button>
      </div>
    </div>
  `;
}

function renderAuroraHeroStrip() {
  const catalogCount = state.serverState?.catalog?.plugins?.length || 0;
  const installed = state.serverState?.installed || [];
  const activeCount = installed.filter((x) => x.enabled).length;
  const updatesCount = getEffectiveUpdateItems().length;
  const summary = getConflictsSummary();
  const conflictTone = summary.critical > 0 ? 'tone-danger' : summary.total > 0 ? 'tone-warn' : 'tone-emerald';
  const conflictVal =
    summary.total === 0
      ? t('无冲突', '0 conflicts')
      : t(`${summary.total} 项冲突`, `${summary.total} Issue${summary.total > 1 ? 's' : ''}`);

  if (state.heroCollapsed) {
    return `
      <section class="aurora-hero is-collapsed">
        <div class="aurora-hero-inner">
          <div class="aurora-hero-compact-row">
            <div class="aurora-compact-pills">
              <span class="aurora-kicker">${icon('sparkle', 11)} ${escapeHtml(t('概览', 'Overview'))}</span>
              <button type="button" class="compact-stat-chip" data-action="tab" data-tab="discover">${escapeHtml(t(`收录 ${catalogCount}`, `${catalogCount} Catalog`))}</button>
              <button type="button" class="compact-stat-chip" data-action="tab" data-tab="installed">${escapeHtml(t(`运行 ${activeCount}/${installed.length}`, `${activeCount}/${installed.length} Active`))}</button>
              ${updatesCount > 0 ? `<button type="button" class="compact-stat-chip" data-action="tab" data-tab="installed" style="color:var(--m-sky);border-color:var(--m-sky-border)">${escapeHtml(t(`可更新 ${updatesCount}`, `${updatesCount} Updates`))}</button>` : ''}
              <button type="button" class="compact-stat-chip" data-action="tab" data-tab="conflicts" style="color:${summary.critical > 0 ? 'var(--m-danger)' : summary.total > 0 ? 'var(--m-warn)' : 'var(--m-ok)'}">${escapeHtml(conflictVal)}</button>
            </div>
            <button type="button" class="hero-collapse-btn" data-action="toggle-hero" title="${escapeHtml(t('展开概览栏', 'Expand overview'))}">
              ${icon('chevronDown', 12)} <span>${escapeHtml(t('展开', 'Expand'))}</span>
            </button>
          </div>
        </div>
      </section>
    `;
  }

  return `
    <section class="aurora-hero">
      <div class="aurora-hero-inner">
        <div class="aurora-hero-top">
          <div class="aurora-hero-brand">
            <span class="aurora-kicker">${icon('sparkle', 11)} ${escapeHtml(t('AGY MARKET · 社区插件目录', 'AGY MARKET · COMMUNITY PLUGINS'))}</span>
            <h1 class="aurora-hero-title">${escapeHtml(t('浏览、安装与管理 Antigravity 插件', 'Browse, install, and manage Antigravity plugins'))}</h1>
          </div>
          <button type="button" class="hero-collapse-btn" data-action="toggle-hero" title="${escapeHtml(t('收起概览栏', 'Collapse overview'))}">
            ${icon('chevronUp', 12)} <span>${escapeHtml(t('收起', 'Compact'))}</span>
          </button>
        </div>

        <div class="hero-stats-row">
          <button type="button" class="hero-stat-pill tone-indigo" data-action="tab" data-tab="discover">
            <div class="hero-stat-meta">
              <span class="hero-stat-label">${escapeHtml(t('已收录插件', 'Catalog Plugins'))}</span>
              <span class="hero-stat-val">${catalogCount}</span>
            </div>
            <span class="hero-stat-ico">${icon('compass', 15)}</span>
          </button>

          <button type="button" class="hero-stat-pill tone-emerald" data-action="tab" data-tab="installed">
            <div class="hero-stat-meta">
              <span class="hero-stat-label">${escapeHtml(t('运行中', 'Running'))}</span>
              <span class="hero-stat-val">${activeCount} / ${installed.length}</span>
            </div>
            <span class="hero-stat-ico">${icon('package', 15)}</span>
          </button>

          <button type="button" class="hero-stat-pill tone-sky" data-action="tab" data-tab="installed">
            <div class="hero-stat-meta">
              <span class="hero-stat-label">${escapeHtml(t('可更新', 'Updates'))}</span>
              <span class="hero-stat-val">${updatesCount}</span>
            </div>
            <span class="hero-stat-ico">${icon('update', 15)}</span>
          </button>

          <button type="button" class="hero-stat-pill ${conflictTone}" data-action="tab" data-tab="conflicts">
            <div class="hero-stat-meta">
              <span class="hero-stat-label">${escapeHtml(t('本地冲突', 'Conflicts'))}</span>
              <span class="hero-stat-val">${escapeHtml(conflictVal)}</span>
            </div>
            <span class="hero-stat-ico">${icon(summary.total === 0 ? 'shieldCheck' : 'shieldAlert', 15)}</span>
          </button>
        </div>
      </div>
    </section>
  `;
}

// ==========================================================================
// Favorites Resolution, Collapsible Pinned Favorites Shelf & Favorites Tab
// ==========================================================================

function resolveFavoriteEntries() {
  const { byId: catById, byDir: catByDir } = getCatalogMaps();
  const installedByDir = getInstalledByDirMap();
  const resolved = [];
  const seen = new Set();

  for (const rawKey of state.favorites) {
    const key = String(rawKey || '').trim();
    if (!key || seen.has(key)) continue;

    if (catById.has(key)) {
      seen.add(key);
      const plugin = catById.get(key);
      const st = plugin.installStatus || {};
      const localItem = st.installedDir ? installedByDir.get(st.installedDir) || null : null;
      resolved.push({ key, kind: 'catalog', plugin, localItem });
      continue;
    }

    if (key.startsWith('local:')) {
      const dir = key.slice('local:'.length);
      const loc = installedByDir.get(dir);
      if (loc) {
        seen.add(key);
        const catEntry = (loc.receipt?.id && catById.get(loc.receipt.id)) || catByDir.get(loc.dir) || null;
        resolved.push({ key, kind: 'local', loc, catEntry });
      }
      continue;
    }

    const fallbackLoc =
      (state.serverState?.installed || []).find((x) => x.receipt?.id === key || x.dir === key) || null;
    if (fallbackLoc) {
      seen.add(key);
      const catEntry = catById.get(key) || catByDir.get(fallbackLoc.dir) || null;
      if (catEntry) {
        resolved.push({ key, kind: 'catalog', plugin: catEntry, localItem: fallbackLoc });
      } else {
        resolved.push({ key, kind: 'local', loc: fallbackLoc, catEntry: null });
      }
    }
  }

  return resolved;
}

function renderFavoritesShelf() {
  const favEntries = resolveFavoriteEntries();
  if (favEntries.length === 0) return '';

  const { byId: updById, byDir: updByDir } = getUpdateMaps();

  if (state.favoritesShelfCollapsed) {
    return `
      <section class="fav-shelf is-collapsed" aria-label="${escapeHtml(t('我的收藏栏', 'My Favorites'))}">
        <div class="fav-shelf-head">
          <div class="fav-shelf-title-group">
            <span class="fav-shelf-star">${icon('starFilled', 13)}</span>
            <span class="fav-shelf-title">${escapeHtml(t('我的收藏栏', 'My Favorites'))}</span>
            <span class="fav-shelf-count">${favEntries.length}</span>
            <div class="fav-shelf-compact-chips">
              ${favEntries
                .slice(0, 5)
                .map((entry) => {
                  const name =
                    entry.kind === 'catalog'
                      ? entry.plugin.displayName || entry.plugin.canonicalName
                      : entry.loc.displayName || entry.loc.dir;
                  const detailAttr =
                    entry.kind === 'catalog'
                      ? `data-action="detail" data-id="${escapeHtml(entry.plugin.id)}"`
                      : `data-action="detail-local" data-dir="${escapeHtml(entry.loc.dir)}"`;
                  return `<button type="button" class="fav-mini-pill" ${detailAttr} title="${escapeHtml(name)}">${escapeHtml(name)}</button>`;
                })
                .join('')}
            </div>
          </div>
          <div class="fav-shelf-actions">
            <button type="button" class="ghost-link" data-action="tab" data-tab="favorites">${escapeHtml(t('全部收藏 ›', 'All ›'))}</button>
            <button type="button" class="hero-collapse-btn" data-action="toggle-favs-shelf" title="${escapeHtml(t('展开收藏栏', 'Expand favorites shelf'))}">
              ${icon('chevronDown', 12)} <span>${escapeHtml(t('展开', 'Expand'))}</span>
            </button>
          </div>
        </div>
      </section>
    `;
  }

  return `
    <section class="fav-shelf" aria-label="${escapeHtml(t('我的收藏栏', 'My Favorites'))}">
      <div class="fav-shelf-head">
        <div class="fav-shelf-title-group">
          <span class="fav-shelf-star">${icon('starFilled', 13)}</span>
          <span class="fav-shelf-title">${escapeHtml(t('我的收藏栏', 'My Favorites'))}</span>
          <span class="fav-shelf-count">${favEntries.length}</span>
        </div>
        <div class="fav-shelf-actions">
          <button type="button" class="ghost-link" data-action="tab" data-tab="favorites">${escapeHtml(t('管理全部 ›', 'Manage All ›'))}</button>
          <button type="button" class="hero-collapse-btn" data-action="toggle-favs-shelf" title="${escapeHtml(t('收起收藏栏', 'Collapse favorites shelf'))}">
            ${icon('chevronUp', 12)} <span>${escapeHtml(t('收起', 'Compact'))}</span>
          </button>
        </div>
      </div>

      <div class="fav-shelf-grid">
        ${favEntries
          .map((entry) => {
            const isCat = entry.kind === 'catalog';
            const p = isCat ? entry.plugin : entry.catEntry;
            const loc = isCat ? entry.localItem : entry.loc;
            const displayName = (isCat ? p.displayName || p.canonicalName : loc.displayName || loc.dir) || entry.key;
            const version = loc?.version || p?.version || '0.0.0';
            const dir = loc?.dir || p?.installStatus?.installedDir || '';
            const isSelf = dir === 'agy-market' || p?.id === 'azwosile__agy-market';
            const isEnabled = Boolean(loc ? loc.enabled : p?.installStatus?.enabled);
            const sidecarPane = loc?.sidecarPane || p?.installStatus?.sidecarPane || null;
            const upd = loc ? findUpdateForLocal(loc, updById, updByDir) : null;
            const hasUpdate = Boolean(upd || (loc && hasStaleSafeCatalogUpdate(p, loc)));
            const isSelfUpdate = Boolean(upd?.isSelf || isSelf);
            const isDirectGhUpdate = Boolean(upd && isDirectGithubUpdateItem(upd));
            const busyKey = p?.id || upd?.id || loc?.receipt?.id || dir;
            const isBusy = Boolean(
              (busyKey && state.busyId === busyKey) ||
                (dir && state.busyId === dir) ||
                (isSelf && state.selfUpdateBusy) ||
                (state.batchUpdating &&
                  ((busyKey && state.batchTargetIds.includes(busyKey)) || (dir && state.batchTargetIds.includes(dir)))),
            );
            const lockAttr = isUpdateActionLocked() ? ' disabled aria-disabled="true"' : '';
            const repoUrl = p?.repository?.url || loc?.repositoryUrl || loc?.receipt?.repositoryUrl || '';
            const accent = resolveCardAccent(loc || p, p);
            const iconUrl = p?.media?.iconUrl || '';
            const monogram = String(displayName).trim().charAt(0).toUpperCase() || 'P';

            let quickActionHtml = '';
            if (loc && isEnabled && sidecarPane?.uri && !isSelf) {
              quickActionHtml = renderOpenPaneButtonHtml({
                dir,
                sidecarPane,
                enabled: true,
                btnClass: 'dock-btn is-pane',
                label: t('面板', 'Pane'),
              });
            } else if (isBusy) {
              quickActionHtml = `<button type="button" class="btn btn-primary btn-sm" disabled aria-disabled="true" data-stop-card="1">${icon('refresh', 11, 'spin')} ${escapeHtml(t('处理中…', 'Working…'))}</button>`;
            } else if (hasUpdate && isSelfUpdate) {
              quickActionHtml = `<button type="button" class="btn btn-update-outline btn-sm" data-action="self-update" data-update-channel="${escapeHtml(upd?.updateChannel || '')}" data-target-version="${escapeHtml(upd?.latestVersion || p?.version || '')}" data-target-ref="${escapeHtml(upd?.targetRef || '')}" data-stop-card="1"${lockAttr}>${icon('update', 11)} ${escapeHtml(t('更新', 'Update'))}</button>`;
            } else if (hasUpdate && isDirectGhUpdate) {
              const targetId = upd?.id || p?.id || loc?.receipt?.id || dir;
              quickActionHtml = `<button type="button" class="btn btn-update-outline btn-sm" data-action="update-plugin-direct" data-id="${escapeHtml(targetId)}" data-dir="${escapeHtml(upd?.dir || dir)}" data-name="${escapeHtml(displayName)}" data-source="${escapeHtml(upd?.source || '')}" data-update-channel="${escapeHtml(upd?.updateChannel || '')}" data-target-ref="${escapeHtml(upd?.targetRef || '')}" data-update-kind="${escapeHtml(upd?.updateKind || '')}" data-track-branch="${escapeHtml(upd?.trackBranch || '')}" data-repo-url="${escapeHtml(upd?.repositoryUrl || repoUrl)}" data-stop-card="1"${lockAttr}>${icon('update', 11)} ${escapeHtml(t('更新', 'Update'))}</button>`;
            } else if (hasUpdate && p) {
              quickActionHtml = `<button type="button" class="btn btn-update-outline btn-sm" data-action="install" data-id="${escapeHtml(p.id)}" data-stop-card="1"${lockAttr}>${icon('update', 11)} ${escapeHtml(t('更新', 'Update'))}</button>`;
            } else if (hasUpdate && loc) {
              const targetId = upd?.id || loc.receipt?.id || loc.dir;
              quickActionHtml = `<button type="button" class="btn btn-update-outline btn-sm" data-action="update-plugin-direct" data-id="${escapeHtml(targetId)}" data-dir="${escapeHtml(loc.dir)}" data-name="${escapeHtml(displayName)}" data-source="${escapeHtml(upd?.source || '')}" data-update-channel="${escapeHtml(upd?.updateChannel || '')}" data-target-ref="${escapeHtml(upd?.targetRef || '')}" data-update-kind="${escapeHtml(upd?.updateKind || '')}" data-track-branch="${escapeHtml(upd?.trackBranch || '')}" data-repo-url="${escapeHtml(upd?.repositoryUrl || repoUrl)}" data-stop-card="1"${lockAttr}>${icon('update', 11)} ${escapeHtml(t('更新', 'Update'))}</button>`;
            } else if (!loc && p) {
              quickActionHtml = `<button type="button" class="btn btn-primary btn-sm" data-action="install" data-id="${escapeHtml(p.id)}" data-stop-card="1"${lockAttr}>${icon('download', 11)} ${escapeHtml(t('安装', 'Install'))}</button>`;
            }

            const detailAttrs = isCat
              ? `data-action="detail" data-id="${escapeHtml(p.id)}"`
              : `data-action="detail-local" data-dir="${escapeHtml(loc.dir)}"`;

            const updateShortLabel =
              upd?.updateKind === 'commit' && upd?.latestCommitSha
                ? `↑ ${upd.latestCommitSha}`
                : `↑ ${formatV(upd?.latestVersion || p?.version || '')}`;

            return `
              <div class="fav-shelf-item" style="--card-accent:${accent.a1};--card-accent-2:${accent.a2}" ${detailAttrs}>
                <div class="fav-shelf-item-left">
                  <div class="fav-mini-logo">
                    ${
                      iconUrl
                        ? `<span aria-hidden="true">${escapeHtml(monogram)}</span><img src="${escapeHtml(iconUrl)}" alt="" loading="lazy" onerror="this.style.display='none'" />`
                        : isSelf
                          ? BRAND_LOGO_SVG
                          : `<span aria-hidden="true">${escapeHtml(monogram)}</span>`
                    }
                  </div>
                  <div class="fav-shelf-copy">
                    <span class="fav-shelf-name" title="${escapeHtml(displayName)}">${escapeHtml(displayName)}</span>
                    <span class="fav-shelf-meta">
                      <span>${escapeHtml(formatV(version))}</span>
                      ${hasUpdate ? `<span style="color:var(--m-sky);font-weight:700">${escapeHtml(updateShortLabel)}</span>` : loc ? `<span style="color:${isEnabled ? 'var(--m-ok)' : 'var(--m-muted)'}">${escapeHtml(isEnabled ? t('已启用', 'Active') : t('已停用', 'Parked'))}</span>` : ''}
                    </span>
                  </div>
                </div>
                <div class="fav-shelf-item-right">
                  ${quickActionHtml}
                  ${renderFavoriteButtonHtml({ key: entry.key, displayName, sizeClass: 'is-mini' })}
                </div>
              </div>
            `;
          })
          .join('')}
      </div>
    </section>
  `;
}

// ==========================================================================
// Discover Card & Discover View
// ==========================================================================

function renderPluginCard(p, updateById, installedByDir, updateByDir = null) {
  const loc = getLocale();
  const desc = resolveCatalogDescription(p, loc);
  const st = p.installStatus || {};
  const localItem = st.installedDir ? installedByDir.get(st.installedDir) || null : null;
  const isSelf = st.installedDir === 'agy-market' || p.canonicalName === 'agy-market' || p.id === 'azwosile__agy-market';
  const resolvedUpdByDir = updateByDir || getUpdateMaps().byDir;
  const effectiveLoc =
    localItem ||
    (st.installed && !state.serverState && (!st.scope || st.scope === 'global')
      ? {
          dir: st.installedDir || (isSelf ? 'agy-market' : ''),
          scope: st.scope || 'global',
          version: st.installedVersion || '',
          receipt: { id: p.id },
        }
      : null);
  const upd = effectiveLoc ? findUpdateForLocal(effectiveLoc, updateById, resolvedUpdByDir) : null;
  const hasAnyUpdate = Boolean(upd || (st.installed && hasStaleSafeCatalogUpdate(p, effectiveLoc)));
  const isSelfUpdate = Boolean(upd?.isSelf || isSelf);
  const isDirectGhUpdate = Boolean(upd && isDirectGithubUpdateItem(upd));
  const isCommitUpdate = Boolean(upd && upd.updateKind === 'commit' && upd.latestCommitSha);
  const isBusy = Boolean(
    state.busyId === p.id ||
      (st.installedDir && state.busyId === st.installedDir) ||
      (isSelf && state.selfUpdateBusy) ||
      (state.batchUpdating &&
        (state.batchTargetIds.includes(p.id) || (st.installedDir && state.batchTargetIds.includes(st.installedDir)))),
  );
  const effectiveSlug = p.forceScopedInstall ? p.scopedName : p.canonicalName;
  const repoUrl = p.repository?.url || '';
  const discussUrl = deriveDiscussionsUrl(repoUrl);
  const relUpdated = formatRelativeTime(p.updatedAt);
  const accent = resolveCardAccent(p);
  const isEnabled = st.installed ? Boolean(localItem ? localItem.enabled : st.enabled) : false;
  const isParked = Boolean(st.installed && !isEnabled);
  const canToggle = localItem ? localItem.canToggle : st.canToggle;
  const toggleDisabledReason = localItem ? localItem.toggleDisabledReason : st.toggleDisabledReason;
  const favKey = String(p.id || '');
  const displayName = p.displayName || p.canonicalName;

  let versionChip = `<span class="version-tag">${escapeHtml(formatV(p.version))}</span>`;
  if (upd && st.installed) {
    const fromVer = localItem?.version || upd.installedVersion || st.installedVersion || '?';
    versionChip = isCommitUpdate
      ? `<span class="version-delta" title="${escapeHtml(t('发现可用更新', 'Update available'))}">${escapeHtml(formatV(fromVer))} (${escapeHtml(upd.installedCommitSha || String(localItem?.receipt?.commitSha || '').slice(0, 7) || 'HEAD')} → ${escapeHtml(upd.latestCommitSha)})</span>`
      : `<span class="version-delta" title="${escapeHtml(t('发现可用更新', 'Update available'))}">${escapeHtml(formatV(fromVer))} → ${escapeHtml(formatV(upd.latestVersion))}</span>`;
  } else if (hasAnyUpdate && st.installed) {
    const fromVer = localItem?.version || st.installedVersion || '?';
    versionChip = `<span class="version-delta">${escapeHtml(formatV(fromVer))} → ${escapeHtml(formatV(p.version))}</span>`;
  }

  const lockAttr = isUpdateActionLocked() ? ' disabled aria-disabled="true"' : '';
  let actionBtn = '';
  if (isBusy) {
    actionBtn = `<button type="button" class="btn btn-primary btn-sm" disabled aria-disabled="true">${icon('refresh', 12, 'spin')} ${escapeHtml(t('处理中…', 'Working…'))}</button>`;
  } else if (hasAnyUpdate) {
    const targetV = upd?.latestVersion || p.version;
    const updLabel = isCommitUpdate
      ? t(`更新 ${upd.latestCommitSha}`, `Update ${upd.latestCommitSha}`)
      : t(`更新 ${formatV(targetV)}`, `Update ${formatV(targetV)}`);
    if (isSelfUpdate) {
      actionBtn = `<button type="button" class="btn btn-update-outline btn-sm" data-action="self-update" data-update-channel="${escapeHtml(upd?.updateChannel || '')}" data-target-version="${escapeHtml(targetV)}" data-target-ref="${escapeHtml(upd?.targetRef || '')}" data-stop-card="1"${lockAttr}>${icon('update', 12)} ${escapeHtml(updLabel)}</button>`;
    } else if (isDirectGhUpdate) {
      actionBtn = `<button type="button" class="btn btn-update-outline btn-sm" data-action="update-plugin-direct" data-id="${escapeHtml(upd.id || p.id)}" data-dir="${escapeHtml(upd.dir || st.installedDir || p.canonicalName)}" data-name="${escapeHtml(displayName)}" data-source="${escapeHtml(upd.source || '')}" data-update-channel="${escapeHtml(upd.updateChannel || '')}" data-target-ref="${escapeHtml(upd.targetRef || '')}" data-update-kind="${escapeHtml(upd.updateKind || '')}" data-track-branch="${escapeHtml(upd.trackBranch || '')}" data-repo-url="${escapeHtml(upd.repositoryUrl || repoUrl)}" data-stop-card="1"${lockAttr}>${icon('update', 12)} ${escapeHtml(updLabel)}</button>`;
    } else {
      actionBtn = `<button type="button" class="btn btn-update-outline btn-sm" data-action="install" data-id="${escapeHtml(p.id)}" data-stop-card="1"${lockAttr}>${icon('update', 12)} ${escapeHtml(updLabel)}</button>`;
    }
  } else if (st.installed) {
    actionBtn = `<button type="button" class="btn btn-installed btn-sm" data-action="detail" data-id="${escapeHtml(p.id)}">${icon('check', 12)} ${escapeHtml(t('详情', 'Details'))}</button>`;
  } else {
    actionBtn = `<button type="button" class="btn btn-primary btn-sm" data-action="install" data-id="${escapeHtml(p.id)}"${lockAttr}>${icon('download', 12)} ${escapeHtml(t('安装', 'Install'))}</button>`;
  }

  const dockLeftHtml = st.installed
    ? renderToggleSliderHtml({
        dir: st.installedDir || p.canonicalName,
        enabled: isEnabled,
        canToggle,
        toggleDisabledReason: isSelf ? 'self' : toggleDisabledReason,
      })
    : `
      ${discussUrl ? `<a class="dock-btn" href="${escapeHtml(discussUrl)}" target="_blank" rel="noopener noreferrer" data-stop-card="1" title="${escapeHtml(t('打开 GitHub Discussions 社区讨论', 'Open GitHub Discussions'))}">${icon('message', 12)} <span>${escapeHtml(t('讨论', 'Discuss'))}</span></a>` : ''}
      ${repoUrl ? `<a class="dock-btn" href="${escapeHtml(repoUrl)}" target="_blank" rel="noopener noreferrer" data-stop-card="1" title="${escapeHtml(t('查看 GitHub 源码仓库', 'View GitHub Repository'))}">${icon('external', 11)} <span>GitHub</span></a>` : ''}
    `;

  const paneBtnHtml = st.installed
    ? renderOpenPaneButtonHtml({
        dir: st.installedDir || p.canonicalName,
        sidecarPane: localItem?.sidecarPane || st.sidecarPane,
        enabled: isEnabled,
      })
    : '';

  const catTagsHtml = renderCategoryTagsHtml(p.taxonomy?.categories, { maxCount: 2, clickable: true });

  return `
    <article class="plugin-card ${hasAnyUpdate ? 'has-update' : ''} ${isParked ? 'is-parked' : ''}" style="--card-accent:${accent.a1};--card-accent-2:${accent.a2}">
      <div class="card-head" data-action="detail" data-id="${escapeHtml(p.id)}">
        ${renderLogoHtml(p.media?.iconUrl, displayName, { isSelf })}
        <div class="card-title-wrap">
          <div class="card-title-row">
            ${renderCardTitleHtml(displayName, repoUrl)}
            <div class="card-title-right">
              ${versionChip}
              ${renderFavoriteButtonHtml({ key: favKey, displayName })}
            </div>
          </div>
          <div class="card-meta">
            <span class="card-slug" title="${escapeHtml(effectiveSlug)}">${escapeHtml(effectiveSlug)}</span>
            <span class="meta-sep">·</span>
            <span class="meta-star" title="GitHub Stars">${icon('star', 11)} ${Number(p.repository?.stars || 0)}</span>
            ${relUpdated ? `<span class="meta-sep">·</span><span style="white-space:nowrap">${escapeHtml(relUpdated)}</span>` : ''}
            ${upd?.changelog ? `<span class="meta-sep">·</span><button type="button" class="notes-link" data-action="detail" data-id="${escapeHtml(p.id)}" data-detail-tab="changelog">${escapeHtml(t('更新内容 ›', 'Notes ›'))}</button>` : ''}
            ${p.forceScopedInstall ? `<span class="track-tag" title="Track 2 Experimental Topic">Track 2</span>` : ''}
            ${renderRankingMetaPillsHtml(p)}
          </div>
        </div>
      </div>

      <p class="card-desc" data-action="detail" data-id="${escapeHtml(p.id)}">${escapeHtml(desc)}</p>

      <div class="badge-row" data-action="detail" data-id="${escapeHtml(p.id)}" data-detail-tab="capabilities">
        ${catTagsHtml}
        ${renderBadgesHtml(p.capabilities, { maxCount: 3 })}
      </div>

      <div class="card-dock">
        <div class="dock-left">
          ${dockLeftHtml}
        </div>
        <div class="dock-right">
          ${paneBtnHtml}
          ${st.installed && discussUrl ? `<a class="dock-btn" href="${escapeHtml(discussUrl)}" target="_blank" rel="noopener noreferrer" data-stop-card="1" title="GitHub Discussions">${icon('message', 12)}</a>` : ''}
          ${actionBtn}
        </div>
      </div>
    </article>
  `;
}

function renderSelfUpdateBanner() {
  const su = state.updates.selfUpdate;
  if (!su || !isSelfBannerVisible()) return '';
  const selfLoc = getGlobalInstalledByDirMap().get('agy-market') || null;
  const fromV = selfLoc?.version || state.serverState?.plugin?.version || su.installedVersion || '?';
  const toV = su.latestVersion || '?';
  const fromClean = stripV(fromV);
  const toClean = stripV(toV);
  if (!fromClean || !toClean || fromClean === '?' || toClean === '?' || !isNewerVersion(toClean, fromClean)) {
    return '';
  }
  const updateActionLocked = isUpdateActionLocked();

  return `
    <div class="self-update-banner" data-agy-market-self-offer role="region" aria-label="${escapeHtml(t('插件市场更新提示', 'AGY Market Self-Update'))}">
      <div class="self-update-main">
        <div class="self-update-icon">${icon('sparkle', 14)}</div>
        <div class="self-update-text">
          <span class="self-update-title">${escapeHtml(t('AGY Market 有新版本可用', 'AGY Market update available'))}</span>
          <span class="version-delta">${escapeHtml(formatV(fromV))} → ${escapeHtml(formatV(toV))}</span>
        </div>
      </div>
      <div class="self-update-actions">
        ${su.changelog ? `<button type="button" class="btn btn-sm" data-action="open-self-changelog">${icon('history', 12)} ${escapeHtml(t('更新日志', 'Notes'))}</button>` : ''}
        <button type="button" class="btn btn-primary btn-sm" data-action="self-update" data-update-channel="${escapeHtml(su.updateChannel || '')}" data-target-version="${escapeHtml(su.latestVersion || '')}" data-target-ref="${escapeHtml(su.targetRef || '')}"${updateActionLocked ? ' disabled aria-disabled="true"' : ''}>
          ${state.selfUpdateBusy ? icon('refresh', 12, 'spin') : icon('update', 12)}
          ${escapeHtml(state.selfUpdateBusy ? t('正在更新…', 'Updating…') : t('立即更新市场', 'Update Market'))}
        </button>
        <button type="button" class="icon-btn is-square" data-action="dismiss-self-banner" title="${escapeHtml(t('暂时收起', 'Dismiss'))}">${icon('close', 13)}</button>
      </div>
    </div>
  `;
}

function renderDiscoverView() {
  const prefs = state.serverState?.prefs || {};
  const loc = getLocale();
  const plugins = getFilteredPlugins();
  const catCounts = getCategoryCounts();
  const { byId: updById, byDir: updByDir } = getUpdateMaps();
  const installedByDir = getInstalledByDirMap();
  const installableUpds = getInstallableUpdates();
  const updateActionLocked = isUpdateActionLocked();

  const coreOrder = [
    'all',
    'monitoring-quota',
    'context-cache',
    'ui-themes',
    'agents-reasoning',
    'developer-tools',
    'mcp-integrations',
    'skills-workflows',
    'productivity',
  ];
  const allKnownKeys = [...new Set([...Object.keys(CATEGORY_LABELS), ...Object.keys(catCounts)])];
  const chipKeys = allKnownKeys.filter(
    (k) => k === 'all' || k === state.category || (catCounts[k] || 0) > 0 || (plugins.length === 0 && coreOrder.includes(k)),
  );

  return `
    <div class="filter-bar">
      <div class="filter-row-top">
        <div class="search-box">
          ${icon('search', 14, 'search-ico')}
          <input
            id="market-search-input"
            class="search-input"
            type="text"
            autocomplete="off"
            placeholder="${escapeHtml(t('搜索插件名称、能力、MCP 或标签…', 'Search plugins, capabilities, MCP, or tags…'))}"
            value="${escapeHtml(state.search)}"
          />
          ${
            state.search
              ? `<button type="button" class="search-clear" data-action="clear-search" title="${escapeHtml(t('清空搜索', 'Clear search'))}">${icon('close', 11)}</button>`
              : `<span class="search-kbd" aria-hidden="true">/</span>`
          }
        </div>

        <select id="market-sort-select" class="select-input" aria-label="${escapeHtml(t('排序方式', 'Sort by'))}">
          <option value="recommended" ${state.sortBy === 'recommended' ? 'selected' : ''}>${escapeHtml(t('综合推荐', 'Recommended'))}</option>
          <option value="stars" ${state.sortBy === 'stars' ? 'selected' : ''}>${escapeHtml(t('按星标排序', 'Most Stars'))}</option>
          <option value="updated" ${state.sortBy === 'updated' ? 'selected' : ''}>${escapeHtml(t('最近更新', 'Recently Updated'))}</option>
          <option value="name" ${state.sortBy === 'name' ? 'selected' : ''}>${escapeHtml(t('按名称排序', 'Name A–Z'))}</option>
        </select>

        <label class="track2-pill ${prefs.enableExperimentalTrack2 ? 'enabled' : ''}${updateActionLocked ? ' is-disabled' : ''}" title="${escapeHtml(t('开启 GitHub Topic 自动发现 (Track 2)，自动采用 <owner>--<slug> 隔离命名', 'Enable experimental GitHub topic discovery (Track 2) with automatic scoped isolation'))}">
          <input id="track2-checkbox" type="checkbox" ${prefs.enableExperimentalTrack2 ? 'checked' : ''}${updateActionLocked ? ' disabled aria-disabled="true"' : ''} />
          <span class="switch-track" aria-hidden="true"></span>
          ${icon('flask', 12)}
          <span>Track 2</span>
        </label>
      </div>

      <div class="chip-strip" role="tablist" aria-label="${escapeHtml(t('插件分类', 'Categories'))}">
        ${chipKeys
          .map((key) => {
            const label = CATEGORY_LABELS[key]?.[loc] || CATEGORY_LABELS[key]?.zh || key;
            const n = catCounts[key] || 0;
            return `<button type="button" class="cat-chip ${state.category === key ? 'active' : ''}" data-action="category" data-category="${escapeHtml(key)}">${escapeHtml(label)}${n > 0 ? `<span class="cat-chip-n">${n}</span>` : ''}</button>`;
          })
          .join('')}
      </div>
    </div>

    <div class="main-scroll">
      ${renderAuroraHeroStrip()}

      ${
        state.batchUpdating || installableUpds.length > 0
          ? `<div class="quick-update-strip">
              <div class="quick-update-left">
                ${icon('update', 14)}
                <span>${escapeHtml(
                  state.batchUpdating && installableUpds.length === 0
                    ? t('正在批量更新已安装插件…', 'Updating installed plugins…')
                    : t(`有 ${installableUpds.length} 个已安装插件可立即更新`, `${installableUpds.length} installed plugin update(s) ready`),
                )}</span>
              </div>
              <div class="quick-update-actions">
                <button type="button" class="btn btn-sm" data-action="tab" data-tab="installed">${escapeHtml(t('查看详情', 'Review'))}</button>
                <button type="button" class="btn btn-update btn-sm" data-action="update-all"${updateActionLocked ? ' disabled aria-disabled="true"' : ''}>
                  ${state.batchUpdating ? icon('refresh', 12, 'spin') : icon('update', 12)}
                  ${escapeHtml(state.batchUpdating ? t('正在一键更新…', 'Updating All…') : t('一键更新', 'Update All'))}
                </button>
              </div>
            </div>`
          : ''
      }

      ${renderFavoritesShelf()}

      ${
        state.loading && !plugins.length
          ? renderSkeletonGrid(4)
          : plugins.length
            ? `<div class="cards-grid">${plugins.map((p) => renderPluginCard(p, updById, installedByDir, updByDir)).join('')}</div>`
            : (() => {
                const prefillUrl = extractGithubPrefillUrl(state.search);
                const prefillAttr = prefillUrl ? ` data-prefill-url="${escapeHtml(prefillUrl)}"` : '';
                const hasActiveFilter = Boolean(state.search || state.category !== 'all');
                return `<div class="empty-state">
                  <div class="empty-icon">${icon('search', 20)}</div>
                  <div class="empty-title">${escapeHtml(t('当前筛选条件下暂无插件', 'No matching plugins found'))}</div>
                  <div class="empty-sub">${escapeHtml(
                    hasActiveFilter
                      ? t(
                          '尝试更换搜索关键词、重置分类筛选，或直接粘贴 GitHub 仓库链接添加未收录插件。',
                          'Try another query, reset filters, or add an unlisted plugin directly via its GitHub URL.',
                        )
                      : t(
                          '可在「源与设置」配置自定义目录源，或点击右上角「链接添加」直接通过 GitHub 链接安装插件。',
                          'Configure a custom feed in Sources, or click "Add URL" in the top bar to install via GitHub URL.',
                        ),
                  )}</div>
                  <div class="empty-actions">
                    ${
                      hasActiveFilter
                        ? `<button type="button" class="btn btn-sm" data-action="reset-filters">${escapeHtml(t('重置筛选条件', 'Reset Filters'))}</button>`
                        : ''
                    }
                    <button type="button" class="btn btn-primary btn-sm" data-action="open-github-url-modal"${prefillAttr}>
                      ${icon('link', 12)}
                      <span>${escapeHtml(
                        prefillUrl
                          ? t('解析并添加此 GitHub 链接', 'Add This GitHub URL')
                          : t('通过 GitHub 链接添加', 'Add via GitHub URL'),
                      )}</span>
                    </button>
                  </div>
                </div>`;
              })()
      }
    </div>
  `;
}

// ==========================================================================
// Favorites Tab View (`★ 收藏`)
// ==========================================================================

function renderFavoritesView() {
  const loc = getLocale();
  const allFavs = resolveFavoriteEntries();
  const { byId: updById, byDir: updByDir } = getUpdateMaps();
  const { byId: catById, byDir: catByDir } = getCatalogMaps();
  const installedByDir = getInstalledByDirMap();
  const q = state.favoritesSearch.trim().toLowerCase();

  let filtered = allFavs.filter((entry) => {
    if (!q) return true;
    if (entry.kind === 'catalog') {
      const p = entry.plugin;
      const desc = `${resolveCatalogDescription(p, 'zh')} ${resolveCatalogDescription(p, 'en')}`;
      const catTerms = (p.taxonomy?.categories || [])
        .map((c) => `${c} ${CATEGORY_LABELS[c]?.zh || ''} ${CATEGORY_LABELS[c]?.en || ''}`)
        .join(' ');
      const hay = `${p.displayName || ''} ${p.canonicalName || ''} ${p.scopedName || ''} ${p.id || ''} ${desc} ${catTerms} ${(p.taxonomy?.tags || []).join(' ')} ${(p.capabilities?.badges || []).join(' ')}`.toLowerCase();
      return hay.includes(q);
    }
    const l = entry.loc;
    const desc = resolveInstalledDescription(l, entry.catEntry);
    const hay = `${l.displayName || ''} ${l.name || ''} ${l.dir || ''} ${desc} ${l.description || ''}`.toLowerCase();
    return hay.includes(q);
  });

  if (state.favoritesSortBy === 'stars') {
    filtered = [...filtered].sort((a, b) => {
      const sa = Number(a.plugin?.repository?.stars || a.catEntry?.repository?.stars || 0);
      const sb = Number(b.plugin?.repository?.stars || b.catEntry?.repository?.stars || 0);
      return sb - sa;
    });
  } else if (state.favoritesSortBy === 'name') {
    filtered = [...filtered].sort((a, b) => {
      const na = a.kind === 'catalog' ? a.plugin.displayName || a.plugin.canonicalName : a.loc.displayName || a.loc.dir;
      const nb = b.kind === 'catalog' ? b.plugin.displayName || b.plugin.canonicalName : b.loc.displayName || b.loc.dir;
      return String(na).localeCompare(String(nb), loc);
    });
  }

  return `
    <div class="filter-bar">
      <div class="filter-row-top">
        <div class="search-box">
          ${icon('search', 14, 'search-ico')}
          <input
            id="favorites-search-input"
            class="search-input"
            type="text"
            autocomplete="off"
            placeholder="${escapeHtml(t('搜索已收藏插件名称、简介或标签…', 'Search favorited plugins by name, description, or tags…'))}"
            value="${escapeHtml(state.favoritesSearch)}"
          />
          ${
            state.favoritesSearch
              ? `<button type="button" class="search-clear" data-action="clear-favorites-search" title="${escapeHtml(t('清空搜索', 'Clear search'))}">${icon('close', 11)}</button>`
              : `<span class="search-kbd" aria-hidden="true">/</span>`
          }
        </div>

        <select id="favorites-sort-select" class="select-input" aria-label="${escapeHtml(t('排序方式', 'Sort by'))}">
          <option value="added" ${state.favoritesSortBy === 'added' ? 'selected' : ''}>${escapeHtml(t('按收藏顺序', 'Recently Starred'))}</option>
          <option value="stars" ${state.favoritesSortBy === 'stars' ? 'selected' : ''}>${escapeHtml(t('按星标排序', 'Most Stars'))}</option>
          <option value="name" ${state.favoritesSortBy === 'name' ? 'selected' : ''}>${escapeHtml(t('按名称排序', 'Name A–Z'))}</option>
        </select>
      </div>
    </div>

    <div class="main-scroll">
      ${
        allFavs.length === 0
          ? `<div class="empty-state">
              <div class="empty-icon" style="background:var(--m-warn-soft);border-color:var(--m-warn-border);color:var(--m-warn)">${icon('starFilled', 22)}</div>
              <div class="empty-title">${escapeHtml(t('还没有收藏的插件', 'No favorited plugins yet'))}</div>
              <div class="empty-sub">${escapeHtml(t('点击任意插件卡片或详情页右上角的 ☆ 即可收藏，收藏后的插件将同时置顶在「探索」页收藏栏与本页面中。', 'Click ☆ on any plugin card or detail drawer to star it. Favorites also appear pinned on top of Discover.'))}</div>
              <button type="button" class="btn btn-primary btn-sm" data-action="tab" data-tab="discover">${icon('compass', 12)} ${escapeHtml(t('去探索插件市场', 'Browse Discover'))}</button>
            </div>`
          : filtered.length === 0
            ? `<div class="empty-state">
                <div class="empty-icon">${icon('search', 20)}</div>
                <div class="empty-title">${escapeHtml(t('未找到匹配的收藏插件', 'No matching favorites'))}</div>
                <div class="empty-sub">${escapeHtml(t('尝试更换关键词或清空搜索条件。', 'Try a different keyword or clear the search input.'))}</div>
                <button type="button" class="btn btn-sm" data-action="clear-favorites-search">${escapeHtml(t('清空搜索', 'Clear Search'))}</button>
              </div>`
            : `<div class="cards-grid">
                ${filtered
                  .map((entry) =>
                    entry.kind === 'catalog'
                      ? renderPluginCard(entry.plugin, updById, installedByDir, updByDir)
                      : renderInstalledCard(entry.loc, updById, updByDir, catById, catByDir),
                  )
                  .join('')}
              </div>`
      }
    </div>
  `;
}

// ==========================================================================
// Installed View (Localized Descriptions + Tactile Toggle Sliders + Zero Dead Links)
// ==========================================================================

function renderBatchResultsPanel() {
  if (!Array.isArray(state.batchResults) || state.batchResults.length === 0) return '';
  const updateActionLocked = isUpdateActionLocked();
  return `
    <div class="batch-results">
      <div class="batch-results-head">
        <span>${escapeHtml(t('本次批量更新结果', 'Batch Update Results'))}</span>
        <button type="button" class="ghost-link" data-action="clear-batch-results">${escapeHtml(t('收起', 'Dismiss'))}</button>
      </div>
      ${state.batchResults
        .map((r) => {
          const isEscalated = r.status === 'CAPABILITY_ESCALATION_CONFIRM_REQUIRED';
          const toneCls = r.ok ? 'is-ok' : isEscalated ? 'is-warn' : 'is-err';
          const ico = r.ok
            ? `<span style="color:var(--m-ok)">${icon('checkCircle', 14)}</span>`
            : isEscalated
              ? `<span style="color:var(--m-warn)">${icon('shieldAlert', 14)}</span>`
              : `<span style="color:var(--m-danger)">${icon('alertCircle', 14)}</span>`;
          const statusMsg = r.ok
            ? r.alreadyUpToDate || r.status === 'ALREADY_UP_TO_DATE'
              ? t(`已是最新版本 (${formatV(r.version)})`, `Already up to date (${formatV(r.version)})`)
              : t(`已更新至 ${formatV(r.version)}`, `Updated to ${formatV(r.version)}`)
            : isEscalated
              ? t('新增能力权限，等待确认', 'Capability escalation requires confirmation')
              : r.error || r.status || t('更新失败', 'Update failed');

          const dir = r.installedDir || r.dir || '';
          const openPaneBtn =
            r.ok && r.sidecarPane?.uri && dir !== 'agy-market'
              ? renderOpenPaneButtonHtml({
                  dir,
                  sidecarPane: r.sidecarPane,
                  enabled: !r.parkedByMarket,
                  btnClass: 'dock-btn is-pane',
                  label: t('打开面板', 'Open'),
                })
              : '';

          return `
            <div class="batch-row ${toneCls}">
              <div class="batch-row-left">
                ${ico}
                <span class="batch-row-name">${escapeHtml(r.displayName || dir || r.id)}</span>
                <span class="batch-row-msg" title="${escapeHtml(statusMsg)}">${escapeHtml(statusMsg)}</span>
              </div>
              <div class="batch-row-right">
                ${r.ok && r.restartRequired ? `<span class="batch-act-pill is-host-restart">${icon('rocket', 10)} ${escapeHtml(t('请重启客户端', 'Restart App'))}</span>` : r.ok && r.reloadRequired ? `<span class="batch-act-pill is-reload-pane">${icon('refresh', 10)} ${escapeHtml(t('建议重开侧边栏', 'Reopen Sidebar'))}</span>` : ''}
                ${openPaneBtn}
                ${!r.ok && !isEscalated ? `<button type="button" class="btn btn-sm" data-action="retry-batch-one" data-id="${escapeHtml(r.id)}"${updateActionLocked ? ' disabled aria-disabled="true"' : ''}>${escapeHtml(t('重试', 'Retry'))}</button>` : ''}
              </div>
            </div>
          `;
        })
        .join('')}
    </div>
  `;
}

function renderInstalledCard(loc, updById, updByDir, catById, catByDir) {
  const isSelf = loc.dir === 'agy-market';
  const upd = findUpdateForLocal(loc, updById, updByDir);
  const catEntry = (upd && catById.get(upd.id)) || (loc.receipt?.id && catById.get(loc.receipt.id)) || catByDir.get(loc.dir) || null;
  const isGithubUrlTrack = loc.receipt?.track === 'github-url';
  const isSelfUpdate = Boolean(upd?.isSelf || isSelf);
  const isDirectGhUpdate = Boolean(upd && isDirectGithubUpdateItem(upd));
  const isCommitUpdate = Boolean(upd && upd.updateKind === 'commit' && upd.latestCommitSha);
  const busyKey = catEntry?.id || upd?.id || loc.receipt?.id || loc.dir;
  const isBusy = Boolean(
    state.busyId === busyKey ||
      state.busyId === loc.dir ||
      (isSelf && state.selfUpdateBusy) ||
      (state.batchUpdating && (state.batchTargetIds.includes(busyKey) || state.batchTargetIds.includes(loc.dir))),
  );
  const repoUrl = catEntry?.repository?.url || loc.repositoryUrl || loc.receipt?.repositoryUrl || '';
  const discussUrl = deriveDiscussionsUrl(repoUrl);
  const badgesObj = catEntry?.capabilities || loc.capabilities || loc.receipt?.grantedCapabilities || { badges: [] };
  const accent = resolveCardAccent(loc, catEntry);
  const localizedDesc = resolveInstalledDescription(loc, catEntry);
  const isParked = !loc.enabled;
  const displayName = loc.displayName || catEntry?.displayName || loc.dir;
  const favKey = getLocalFavoriteKey(loc, catEntry);

  const canToggle =
    loc.canToggle !== undefined
      ? loc.canToggle
      : loc.scope === 'global' && !isSelf && !loc.hostDisabled;
  const toggleDisabledReason =
    loc.toggleDisabledReason ||
    (isSelf ? 'self' : loc.hostDisabled ? 'host-disabled' : loc.scope !== 'global' ? loc.scope : '');
  const canUninstall = loc.canUninstall !== false && loc.scope === 'global' && loc.dir !== 'agy-market';
  const hasRemoteSource =
    loc.scope === 'global' &&
    (loc.dir === 'agy-market' || Boolean(catEntry) || Boolean(loc.repositoryUrl || loc.receipt?.repositoryUrl));
  const isConfirmedLatest = hasRemoteSource && isPluginConfirmedLatest(loc, upd);

  const updateActionLocked = isUpdateActionLocked();
  const lockAttr = updateActionLocked ? ' disabled aria-disabled="true"' : '';

  let actionHtml = '';
  if (isBusy) {
    const busyLabel = upd || state.batchUpdating ? t('更新中…', 'Updating…') : t('检查中…', 'Checking…');
    actionHtml = `<button type="button" class="btn btn-primary btn-sm" disabled aria-disabled="true">${icon('refresh', 12, 'spin')} ${escapeHtml(busyLabel)}</button>`;
  } else if (upd) {
    const updLabel = isCommitUpdate
      ? t(`更新 ${upd.latestCommitSha}`, `Update ${upd.latestCommitSha}`)
      : t(`更新 ${formatV(upd.latestVersion)}`, `Update ${formatV(upd.latestVersion)}`);
    if (isSelfUpdate) {
      actionHtml = `<button type="button" class="btn btn-update-outline btn-sm" data-action="self-update" data-update-channel="${escapeHtml(upd.updateChannel || '')}" data-target-version="${escapeHtml(upd.latestVersion || '')}" data-target-ref="${escapeHtml(upd.targetRef || '')}" data-stop-card="1"${lockAttr}>${icon('update', 12)} ${escapeHtml(updLabel)}</button>`;
    } else if (isDirectGhUpdate) {
      const updTargetId = upd.id || catEntry?.id || loc.receipt?.id || loc.dir;
      actionHtml = `<button type="button" class="btn btn-update-outline btn-sm" data-action="update-plugin-direct" data-id="${escapeHtml(updTargetId)}" data-dir="${escapeHtml(upd.dir || loc.dir)}" data-name="${escapeHtml(displayName)}" data-source="${escapeHtml(upd.source || '')}" data-update-channel="${escapeHtml(upd.updateChannel || '')}" data-target-ref="${escapeHtml(upd.targetRef || '')}" data-update-kind="${escapeHtml(upd.updateKind || '')}" data-track-branch="${escapeHtml(upd.trackBranch || '')}" data-repo-url="${escapeHtml(upd.repositoryUrl || repoUrl)}" data-stop-card="1"${lockAttr}>${icon('update', 12)} ${escapeHtml(updLabel)}</button>`;
    } else if (catEntry) {
      actionHtml = `<button type="button" class="btn btn-update-outline btn-sm" data-action="install" data-id="${escapeHtml(catEntry.id)}" data-stop-card="1"${lockAttr}>${icon('update', 12)} ${escapeHtml(updLabel)}</button>`;
    } else {
      const updTargetId = upd.id || loc.receipt?.id || loc.dir;
      actionHtml = `<button type="button" class="btn btn-update-outline btn-sm" data-action="update-plugin-direct" data-id="${escapeHtml(updTargetId)}" data-dir="${escapeHtml(upd.dir || loc.dir)}" data-name="${escapeHtml(displayName)}" data-source="${escapeHtml(upd.source || '')}" data-update-channel="${escapeHtml(upd.updateChannel || '')}" data-target-ref="${escapeHtml(upd.targetRef || '')}" data-update-kind="${escapeHtml(upd.updateKind || '')}" data-track-branch="${escapeHtml(upd.trackBranch || '')}" data-repo-url="${escapeHtml(upd.repositoryUrl || repoUrl)}" data-stop-card="1"${lockAttr}>${icon('update', 12)} ${escapeHtml(updLabel)}</button>`;
    }
  } else if (hasRemoteSource && isConfirmedLatest) {
    actionHtml = `<span class="state-pill is-latest" title="${escapeHtml(t('已检查为最新版本', 'Up to date'))}">${icon('check', 11)} <span>${escapeHtml(t('最新', 'Latest'))}</span></span>`;
  } else if (hasRemoteSource && state.updates.loading) {
    actionHtml = `<button type="button" class="dock-btn is-update" data-action="sync-installed-plugin" data-dir="${escapeHtml(loc.dir)}" data-id="${escapeHtml(catEntry?.id || loc.receipt?.id || loc.dir)}" data-name="${escapeHtml(displayName)}" data-stop-card="1" disabled aria-disabled="true" aria-busy="true" title="${escapeHtml(t('正在检测插件更新，请稍候…', 'Checking for plugin updates…'))}">${icon('refresh', 11, 'spin')} <span>${escapeHtml(t('检测中…', 'Checking…'))}</span></button>`;
  } else if (hasRemoteSource) {
    actionHtml = `<button type="button" class="dock-btn is-update" data-action="sync-installed-plugin" data-dir="${escapeHtml(loc.dir)}" data-id="${escapeHtml(catEntry?.id || loc.receipt?.id || loc.dir)}" data-name="${escapeHtml(displayName)}" data-stop-card="1"${lockAttr} title="${escapeHtml(t('检查并从此插件源同步最新版本', 'Check and sync latest build in Sidebar'))}">${icon('update', 12)} <span>${escapeHtml(t('更新', 'Update'))}</span></button>`;
  } else {
    const noSourceTitle =
      loc.scope === 'workspace'
        ? t('工作区级插件由当前仓库管理', 'Workspace plugin managed by current repository')
        : loc.scope === 'builtin'
          ? t('内置插件由 Antigravity 宿主统一维护', 'Built-in plugin managed by Antigravity host')
          : t('纯本地插件，未关联目录或 GitHub 仓库更新源', 'Local-only plugin with no catalog or GitHub repository update source');
    actionHtml = `<span class="state-pill is-local" title="${escapeHtml(noSourceTitle)}">${escapeHtml(loc.scope === 'workspace' ? t('工作区', 'Workspace') : loc.scope === 'builtin' ? t('内置', 'Built-in') : t('本地', 'Local'))}</span>`;
  }

  const uninstallBtnHtml = canUninstall
    ? `<button type="button" class="dock-btn is-danger" data-action="prompt-uninstall" data-dir="${escapeHtml(loc.dir)}" data-name="${escapeHtml(displayName)}" data-version="${escapeHtml(loc.version || '')}" data-fav-key="${escapeHtml(favKey)}" data-stop-card="1"${lockAttr} title="${escapeHtml(t('卸载此插件', 'Uninstall plugin'))}">${icon('trash', 12)} <span>${escapeHtml(t('卸载', 'Uninstall'))}</span></button>`
    : '';

  const paneBtnHtml = renderOpenPaneButtonHtml({
    dir: loc.dir,
    sidecarPane: loc.sidecarPane,
    enabled: loc.enabled,
  });

  const versionBadgeHtml = upd
    ? isCommitUpdate
      ? `<span class="version-delta">${escapeHtml(formatV(loc.version))} (${escapeHtml(upd.installedCommitSha || String(loc.receipt?.commitSha || '').slice(0, 7) || 'HEAD')} → ${escapeHtml(upd.latestCommitSha)})</span>`
      : `<span class="version-delta">${escapeHtml(formatV(loc.version))} → ${escapeHtml(formatV(upd.latestVersion))}</span>`
    : `<span class="version-tag">${escapeHtml(formatV(loc.version))}</span>`;

  return `
    <article class="plugin-card ${upd ? 'has-update' : ''} ${isParked ? 'is-parked' : ''}" style="--card-accent:${accent.a1};--card-accent-2:${accent.a2}">
      <div class="card-head" data-action="detail-local" data-dir="${escapeHtml(loc.dir)}">
        ${renderLogoHtml(catEntry?.media?.iconUrl, displayName, { isSelf })}
        <div class="card-title-wrap">
          <div class="card-title-row">
            ${renderCardTitleHtml(displayName, repoUrl)}
            <div class="card-title-right">
              ${versionBadgeHtml}
              ${renderFavoriteButtonHtml({ key: favKey, displayName })}
            </div>
          </div>
          <div class="card-meta">
            <span class="card-slug" title="${escapeHtml(loc.dir)}">${escapeHtml(loc.dir)}</span>
            <span class="meta-sep">·</span>
            ${
              isSelf
                ? `<span class="self-running-pill">${icon('sparkle', 10)} ${escapeHtml(t('当前面板', 'Active Pane'))}</span>`
                : loc.parkedByMarket
                  ? `<span class="state-pill is-parked-tag">${escapeHtml(t('停放仓待机', 'Parked'))}</span>`
                  : `<span class="state-pill ${loc.enabled ? 'is-enabled' : 'is-disabled'}">${escapeHtml(loc.enabled ? t('已启用', 'Enabled') : t('已停用', 'Disabled'))}</span>`
            }
            ${isGithubUrlTrack ? `<span class="track-tag is-github-url" title="${escapeHtml(t('通过 GitHub 链接安装', 'Installed via GitHub URL'))}">GitHub URL</span>` : ''}
            ${upd?.changelog ? `<span class="meta-sep">·</span><button type="button" class="notes-link" data-action="detail-local" data-dir="${escapeHtml(loc.dir)}" data-detail-tab="changelog">${escapeHtml(t('更新内容 ›', 'Notes ›'))}</button>` : `<span class="meta-sep">·</span><span>${escapeHtml(loc.scope || 'global')}</span>`}
          </div>
        </div>
      </div>

      <p class="card-desc" data-action="detail-local" data-dir="${escapeHtml(loc.dir)}">${escapeHtml(localizedDesc)}</p>

      <div class="badge-row" data-action="detail-local" data-dir="${escapeHtml(loc.dir)}" data-detail-tab="capabilities">
        ${badgesObj?.badges?.length ? renderBadgesHtml(badgesObj, { maxCount: 3 }) : ''}
      </div>

      <div class="card-dock">
        <div class="dock-left">
          ${renderToggleSliderHtml({
            dir: loc.dir,
            enabled: loc.enabled,
            canToggle,
            toggleDisabledReason,
          })}
        </div>
        <div class="dock-right">
          ${paneBtnHtml}
          ${discussUrl ? `<a class="dock-btn" href="${escapeHtml(discussUrl)}" target="_blank" rel="noopener noreferrer" data-stop-card="1" title="GitHub Discussions">${icon('message', 12)} <span>${escapeHtml(t('讨论', 'Discuss'))}</span></a>` : ''}
          ${uninstallBtnHtml}
          ${actionHtml}
        </div>
      </div>
    </article>
  `;
}

function renderInstalledView() {
  const installed = state.serverState?.installed || [];
  const { byId: updById, byDir: updByDir } = getUpdateMaps();
  const { byId: catById, byDir: catByDir } = getCatalogMaps();
  const allUpdates = getEffectiveUpdateItems();
  const installableUpds = getInstallableUpdates();
  const updateActionLocked = isUpdateActionLocked();
  const activeCount = installed.filter((x) => x.enabled).length;
  const disabledCount = installed.filter((x) => !x.enabled).length;
  const updatableCount = installed.filter((loc) => {
    const upd = findUpdateForLocal(loc, updById, updByDir);
    const catEntry = (upd && catById.get(upd.id)) || (loc.receipt?.id && catById.get(loc.receipt.id)) || catByDir.get(loc.dir) || null;
    return Boolean(upd || hasStaleSafeCatalogUpdate(catEntry, loc));
  }).length;

  const checkedLabel = state.updates.checkedAt
    ? t(`上次检查：${formatRelativeTime(state.updates.checkedAt)}`, `Last checked ${formatRelativeTime(state.updates.checkedAt)}`)
    : t('正在自动检查远程更新…', 'Checking remote updates…');

  // 3-tier automatic ordering: enabled -> updatable -> alphabetical
  const sortedInstalled = [...installed].sort((a, b) => {
    const aOn = a.enabled ? 1 : 0;
    const bOn = b.enabled ? 1 : 0;
    if (bOn !== aOn) return bOn - aOn;
    const ua = findUpdateForLocal(a, updById, updByDir);
    const ub = findUpdateForLocal(b, updById, updByDir);
    const sa = ua ? (ua.installable !== false ? 2 : 1) : 0;
    const sb = ub ? (ub.installable !== false ? 2 : 1) : 0;
    if (sb !== sa) return sb - sa;
    return String(a.displayName || a.dir).localeCompare(String(b.displayName || b.dir));
  });

  const q = state.installedSearch.trim().toLowerCase();
  const filteredInstalled = sortedInstalled.filter((loc) => {
    const upd = findUpdateForLocal(loc, updById, updByDir);
    const catEntry = (upd && catById.get(upd.id)) || (loc.receipt?.id && catById.get(loc.receipt.id)) || catByDir.get(loc.dir) || null;
    const hasUpd = Boolean(upd || hasStaleSafeCatalogUpdate(catEntry, loc));

    if (state.installedFilter === 'enabled' && !loc.enabled) return false;
    if (state.installedFilter === 'disabled' && loc.enabled) return false;
    if (state.installedFilter === 'updatable' && !hasUpd) return false;

    if (!q) return true;
    const localizedDesc = resolveInstalledDescription(loc, catEntry);
    const catDescObj = catEntry && typeof catEntry.description === 'object' ? catEntry.description : null;
    const badges = (catEntry?.capabilities?.badges || loc.capabilities?.badges || loc.receipt?.grantedCapabilities?.badges || []).join(' ');
    const trackHint = loc.receipt?.track === 'github-url' ? 'github url' : loc.receipt?.track || '';
    const hay = `${loc.displayName || ''} ${catEntry?.displayName || ''} ${loc.name || ''} ${loc.dir || ''} ${localizedDesc} ${loc.description || ''} ${catDescObj?.zh || ''} ${catDescObj?.en || ''} ${loc.scope || ''} ${trackHint} ${loc.receipt?.pluginRoot || ''} ${badges}`.toLowerCase();
    return hay.includes(q);
  });

  const filterChips = [
    { key: 'all', label: t('全部', 'All'), count: installed.length, extraCls: '' },
    { key: 'enabled', label: t('已启用', 'Enabled'), count: activeCount, extraCls: 'is-enabled-filter' },
    { key: 'disabled', label: t('已禁用', 'Disabled'), count: disabledCount, extraCls: 'is-disabled-filter' },
    { key: 'updatable', label: t('可更新', 'Updatable'), count: updatableCount, extraCls: 'is-updatable-filter' },
  ];

  return `
    <div class="filter-bar">
      <div class="filter-row-top">
        <div class="search-box">
          ${icon('search', 14, 'search-ico')}
          <input
            id="installed-search-input"
            class="search-input"
            type="text"
            autocomplete="off"
            placeholder="${escapeHtml(t('搜索已安装插件名称、目录名或简介…', 'Search installed plugins by name, directory, or description…'))}"
            value="${escapeHtml(state.installedSearch)}"
          />
          ${
            state.installedSearch
              ? `<button type="button" class="search-clear" data-action="clear-installed-search" title="${escapeHtml(t('清空搜索', 'Clear search'))}">${icon('close', 11)}</button>`
              : `<span class="search-kbd" aria-hidden="true">/</span>`
          }
        </div>
      </div>

      <div class="chip-strip" role="tablist" aria-label="${escapeHtml(t('已安装状态筛选', 'Installed status filters'))}">
        ${filterChips
          .map(
            (chip) => `
            <button
              type="button"
              class="status-chip ${chip.extraCls} ${state.installedFilter === chip.key ? 'active' : ''}"
              data-action="installed-filter"
              data-filter="${chip.key}"
            >${escapeHtml(chip.label)}<span class="cat-chip-n">${chip.count}</span></button>
          `,
          )
          .join('')}
      </div>
    </div>

    <div class="main-scroll">
      <section class="updates-command-bar ${allUpdates.length > 0 ? 'has-updates' : ''}">
        <div class="updates-command-top">
          <div class="updates-summary">
            <div class="updates-summary-title">
              ${allUpdates.length > 0 ? `<span style="color:var(--m-sky)">${icon('update', 15)}</span>` : `<span style="color:var(--m-ok)">${icon('checkCircle', 15)}</span>`}
              <span>${escapeHtml(
                state.updates.loading && !state.updates.checkedAt
                  ? t('正在检测插件更新…', 'Checking for plugin updates…')
                  : allUpdates.length > 0
                    ? t(`发现 ${allUpdates.length} 个插件更新`, `${allUpdates.length} plugin update(s) available`)
                    : t(`已安装 ${installed.length} 个插件（${activeCount} 运行中${disabledCount > 0 ? ` · ${disabledCount} 已停用` : ''}）`, `${installed.length} installed (${activeCount} active${disabledCount > 0 ? ` · ${disabledCount} disabled` : ''})`),
              )}</span>
            </div>
            <div class="updates-summary-sub">
              <span>${escapeHtml(checkedLabel)}</span>
            </div>
          </div>

          <div class="updates-command-actions">
            <button type="button" class="btn btn-sm" data-action="check-updates"${updateActionLocked ? ' disabled aria-disabled="true"' : ''}>
              ${icon('refresh', 12, state.updates.loading ? 'spin' : '')}
              ${escapeHtml(t('检查更新', 'Check Now'))}
            </button>
            ${
              state.batchUpdating || installableUpds.length > 0
                ? `<button type="button" class="btn btn-update btn-sm" data-action="update-all"${updateActionLocked ? ' disabled aria-disabled="true"' : ''}>
                    ${state.batchUpdating ? icon('refresh', 12, 'spin') : icon('update', 12)}
                    ${escapeHtml(
                      state.batchUpdating
                        ? state.batchTargetIds.length > 0
                          ? t(`正在一键更新 (${state.batchTargetIds.length})…`, `Updating All (${state.batchTargetIds.length})…`)
                          : t('正在一键更新…', 'Updating All…')
                        : t(`一键更新 (${installableUpds.length})`, `Update All (${installableUpds.length})`),
                    )}
                  </button>`
                : ''
            }
          </div>
        </div>

        ${state.batchUpdating || state.updates.loading ? `<div class="progress-track"><div class="progress-fill"></div></div>` : ''}

        ${
          state.updates.rateLimited
            ? `<div class="notice-strip">
                <span>${icon('alertCircle', 13)} ${escapeHtml(t('GitHub API 匿名请求已限流，可在「源与设置」配置 GitHub Token 解除限额。', 'GitHub API rate limit reached. Add an optional GitHub Token in Sources & Settings.'))}</span>
                <button type="button" class="btn btn-sm" data-action="goto-token">${escapeHtml(t('去配置', 'Configure'))}</button>
              </div>`
            : ''
        }

        ${renderBatchResultsPanel()}
      </section>

      ${
        state.loading && installed.length === 0
          ? renderSkeletonGrid(3)
          : installed.length === 0
            ? `<div class="empty-state">
                <div class="empty-icon">${icon('package', 20)}</div>
                <div class="empty-title">${escapeHtml(t('尚未检测到已安装的插件', 'No local plugins detected yet'))}</div>
                <div class="empty-sub">${escapeHtml(t('前往「探索」标签浏览并一键安装社区插件。', 'Browse the Discover tab to install community plugins with one click.'))}</div>
                <button type="button" class="btn btn-primary btn-sm" data-action="tab" data-tab="discover">${escapeHtml(t('探索插件市场', 'Explore Market'))}</button>
              </div>`
            : filteredInstalled.length === 0
              ? `<div class="empty-state">
                  <div class="empty-icon">${icon('search', 20)}</div>
                  <div class="empty-title">${escapeHtml(t('当前筛选条件下暂无已安装插件', 'No installed plugins match your filter'))}</div>
                  <div class="empty-sub">${escapeHtml(t('尝试更换搜索关键词或切换上方状态筛选胶囊。', 'Try another search query or reset the status filter pill above.'))}</div>
                  <button type="button" class="btn btn-sm" data-action="reset-installed-filters">${escapeHtml(t('重置筛选条件', 'Reset Filters'))}</button>
                </div>`
              : `<div class="cards-grid">
                  ${filteredInstalled.map((loc) => renderInstalledCard(loc, updById, updByDir, catById, catByDir)).join('')}
                </div>`
      }
    </div>
  `;
}

// ==========================================================================
// 4th Top Tab: Conflicts & Diagnostics (`冲突与诊断`)
// ==========================================================================

function renderConflictCard(item) {
  const loc = getLocale();
  const sev = item.severity === 'critical' ? 'critical' : item.severity === 'info' ? 'info' : 'warning';
  const layerMeta = CONFLICT_LAYER_META[item.type] || { zh: item.type || '冲突检测', en: item.type || 'Conflict' };
  const sevLabel =
    sev === 'critical'
      ? t('严重', 'Critical')
      : sev === 'warning'
        ? t('警告', 'Warning')
        : t('提示', 'Notice');

  const title = (loc === 'en' ? item.titleEn : item.titleZh) || item.titleZh || item.titleEn || layerMeta[loc];
  const summary = (loc === 'en' ? item.summaryEn : item.summaryZh) || item.summaryZh || item.summaryEn || '';
  const detail = (loc === 'en' ? item.detailEn : item.detailZh) || '';

  const shadowed = Array.isArray(item.shadowed) ? item.shadowed : [];
  const affectedPlugins = Array.isArray(item.affectedPlugins) ? item.affectedPlugins : [];
  const extraPaths = Array.isArray(item.paths) ? item.paths : [];
  const fix = item.fixAction || null;
  const fixKey = fix ? `${fix.type}:${fix.targetDir}` : '';
  const isFixing = fixKey && state.fixingKey === fixKey;

  const defaultFixLabel =
    fix?.type === 'materialize-symlink'
      ? t('转为实体目录', 'Materialize Directory')
      : t('隔离重命名修复', 'Isolate & Rename');
  const fixLabel = (loc === 'en' ? fix?.labelEn : fix?.labelZh) || defaultFixLabel;

  return `
    <article class="conflict-card sev-${sev}">
      <div class="conflict-card-head">
        <div class="conflict-card-title-group">
          <div class="conflict-card-badges">
            <span class="sev-pill sev-${sev}">
              ${icon(sev === 'critical' ? 'shieldAlert' : sev === 'warning' ? 'alertCircle' : 'info', 11)}
              <span>${escapeHtml(sevLabel)}</span>
            </span>
            <span class="layer-tag">${escapeHtml(loc === 'en' ? layerMeta.en : layerMeta.zh)}</span>
          </div>
          <h3 class="conflict-card-title">${escapeHtml(title)}</h3>
        </div>
        ${
          fix
            ? `<button
                type="button"
                class="btn btn-fix btn-sm"
                data-action="fix-conflict"
                data-fix-type="${escapeHtml(fix.type)}"
                data-target-dir="${escapeHtml(fix.targetDir || '')}"
                data-suggested-dir="${escapeHtml(fix.suggestedDir || '')}"
                ${isFixing ? 'disabled' : ''}
              >
                ${icon(isFixing ? 'refresh' : 'wrench', 12, isFixing ? 'spin' : '')}
                <span>${escapeHtml(isFixing ? t('修复中…', 'Fixing…') : fixLabel)}</span>
              </button>`
            : ''
        }
      </div>

      ${summary ? `<p class="conflict-card-desc">${escapeHtml(summary)}</p>` : ''}
      ${detail ? `<p class="conflict-card-desc muted" style="font-size:11.4px">${escapeHtml(detail)}</p>` : ''}

      ${
        item.winner || shadowed.length > 0 || affectedPlugins.length > 0 || extraPaths.length > 0
          ? `<div class="conflict-compare">
              ${
                item.winner
                  ? `<div class="conflict-path-box is-winner">
                      <span class="conflict-box-label">${icon('checkCircle', 12)} ${escapeHtml(t('优先加载', 'Active'))}</span>
                      <div class="conflict-path-line">
                        <strong>${escapeHtml(item.winner.dir || item.winner.name || '')}</strong>
                        ${item.winner.scope ? `<span class="scope-chip">${escapeHtml(item.winner.scope)}</span>` : ''}
                      </div>
                      ${item.winner.path ? `<div class="conflict-path-line muted">${escapeHtml(item.winner.path)}</div>` : ''}
                    </div>`
                  : ''
              }
              ${
                shadowed.length > 0
                  ? `<div class="conflict-path-box ${sev === 'critical' ? 'is-shadowed' : 'is-warn-box'}">
                      <span class="conflict-box-label">${icon('alertCircle', 12)} ${escapeHtml(t('被忽略或受影响', 'Ignored / Affected'))}</span>
                      ${shadowed
                        .map(
                          (s) => `
                          <div class="conflict-path-line">
                            <strong>${escapeHtml(s.dir || s.name || '')}</strong>
                            ${s.scope ? `<span class="scope-chip">${escapeHtml(s.scope)}</span>` : ''}
                            ${s.path ? `<span class="muted">${escapeHtml(s.path)}</span>` : ''}
                          </div>
                        `,
                        )
                        .join('')}
                    </div>`
                  : ''
              }
              ${
                affectedPlugins.length > 0
                  ? `<div class="conflict-path-box conflict-affected-box ${sev === 'critical' ? 'is-shadowed' : sev === 'warning' ? 'is-warn-box' : 'is-info-box'}">
                      <span class="conflict-box-label">${icon('layers', 12)} ${escapeHtml(t('涉及插件', 'Affected Plugins'))}</span>
                      ${affectedPlugins
                        .map(
                          (ap) => `
                          <div class="conflict-path-line">
                            <strong>${escapeHtml(ap.dir || ap.name || '')}</strong>
                            ${ap.scope ? `<span class="scope-chip">${escapeHtml(ap.scope)}</span>` : ''}
                            ${ap.path ? `<span class="muted">${escapeHtml(ap.path)}</span>` : ''}
                          </div>
                        `,
                        )
                        .join('')}
                    </div>`
                  : ''
              }
              ${
                extraPaths.length > 0 && !item.winner && shadowed.length === 0 && affectedPlugins.length === 0
                  ? `<div class="conflict-path-box ${sev === 'critical' ? 'is-shadowed' : 'is-warn-box'}">
                      <span class="conflict-box-label">${icon('folder', 12)} ${escapeHtml(t('涉及路径', 'Affected Paths'))}</span>
                      ${extraPaths.map((p) => `<div class="conflict-path-line">${escapeHtml(p)}</div>`).join('')}
                    </div>`
                  : ''
              }
            </div>`
          : ''
      }
    </article>
  `;
}

function renderConflictsView() {
  const report = state.conflicts.data;
  const items = Array.isArray(report?.items) ? report.items : [];
  const summary = getConflictsSummary();
  const heroToneCls = summary.critical > 0 ? 'has-critical' : summary.total > 0 ? 'has-warnings' : '';
  const checkedText = report?.checkedAt
    ? t(`上次扫描：${formatRelativeTime(report.checkedAt)}`, `Scanned ${formatRelativeTime(report.checkedAt)}`)
    : t('尚未扫描', 'Not scanned yet');

  return `
    <div class="main-scroll">
      <section class="conflict-hero ${heroToneCls}">
        <div class="conflict-hero-copy">
          <h2 class="conflict-hero-title">
            ${
              summary.total === 0
                ? `${icon('shieldCheck', 16)} ${escapeHtml(t('未检测到插件冲突', 'No plugin conflicts detected'))}`
                : summary.critical > 0
                  ? `${icon('shieldAlert', 16)} ${escapeHtml(t(`发现 ${summary.critical} 项严重冲突，可能影响插件或 MCP 加载`, `${summary.critical} critical conflict(s) may affect plugin or MCP loading`))}`
                  : `${icon('alertCircle', 16)} ${escapeHtml(t(`发现 ${summary.total} 项警告或提示`, `${summary.total} warning(s) or notice(s) found`))}`
            }
          </h2>
          <div class="conflict-kpi-row">
            <span class="conflict-kpi-pill ${summary.critical > 0 ? 'is-critical' : ''}">${escapeHtml(t(`严重 ${summary.critical}`, `Critical ${summary.critical}`))}</span>
            <span class="conflict-kpi-pill ${summary.warning > 0 ? 'is-warning' : ''}">${escapeHtml(t(`警告 ${summary.warning}`, `Warnings ${summary.warning}`))}</span>
            <span class="conflict-kpi-pill ${summary.info > 0 ? 'is-info' : ''}">${escapeHtml(t(`提示 ${summary.info}`, `Info ${summary.info}`))}</span>
            <span class="conflict-kpi-pill is-ok">${escapeHtml(t(`正常 ${summary.healthyCount}`, `OK ${summary.healthyCount}`))}</span>
          </div>
        </div>

        <div class="conflict-hero-actions">
          <button type="button" class="btn btn-primary btn-sm" data-action="refresh-conflicts" ${state.conflicts.loading ? 'disabled' : ''}>
            ${icon('refresh', 12, state.conflicts.loading ? 'spin' : '')}
            <span>${escapeHtml(state.conflicts.loading ? t('扫描中…', 'Scanning…') : t('重新扫描', 'Rescan'))}</span>
          </button>
          <span class="muted" style="font-size:11px">${escapeHtml(checkedText)}</span>
        </div>
      </section>

      ${
        state.conflicts.loading && !state.conflicts.loaded
          ? renderSkeletonGrid(2)
          : state.conflicts.error
            ? `<div class="notice-strip">
                <span>${icon('alertCircle', 13)} ${escapeHtml(state.conflicts.error)}</span>
                <button type="button" class="btn btn-sm" data-action="refresh-conflicts">${escapeHtml(t('重试', 'Retry'))}</button>
              </div>`
            : items.length > 0
              ? `<div class="conflict-list">${items.map((it) => renderConflictCard(it)).join('')}</div>`
              : `<div class="empty-state" style="border-color:var(--m-ok-border)">
                   <div class="empty-icon" style="background:var(--m-ok-soft);border-color:var(--m-ok-border);color:var(--m-ok)">${icon('shieldCheck', 22)}</div>
                   <div class="empty-title">${escapeHtml(t('未检测到插件冲突', 'No plugin conflicts detected'))}</div>
                   <div class="empty-sub">${escapeHtml(t('当前未发现同名插件、符号链接、MCP 服务名或技能重名冲突。', 'No duplicate plugin names, symlinks, MCP collisions, or duplicate skills found.'))}</div>
                 </div>`
      }
    </div>
  `;
}

// ==========================================================================
// Sources & Settings View
// ==========================================================================

function renderSourcesView() {
  const prefs = state.serverState?.prefs || {};
  const cat = state.serverState?.catalog || {};
  const customLines = (prefs.customFeeds || []).join('\n');
  const hasToken = Boolean(prefs.hasGithubToken);
  const updateActionLocked = isUpdateActionLocked();
  const lockAttr = updateActionLocked ? ' disabled aria-disabled="true"' : '';

  return `
    <div class="main-scroll">
      <form id="sources-form" class="settings-panel">
        <div class="field-card">
          <div class="field-head">
            <div class="field-label">${icon('globe', 14)} ${escapeHtml(t('目录源与同步状态', 'Catalog Source & Sync Status'))}</div>
            <button type="button" class="btn btn-sm" data-action="refresh"${lockAttr}>
              ${icon('refresh', 12, state.loading || state.updates.loading ? 'spin' : '')}
              ${escapeHtml(t('立即同步', 'Sync Now'))}
            </button>
          </div>
          <div class="telemetry-grid">
            <div class="telemetry-cell">
              <span class="telemetry-k">${escapeHtml(t('当前通道', 'Transport'))}</span>
              <span class="telemetry-v" title="${escapeHtml(cat.channelUsed || 'n/a')}">${escapeHtml(cat.channelUsed || 'n/a')}</span>
            </div>
            <div class="telemetry-cell">
              <span class="telemetry-k">${escapeHtml(t('目录版本', 'Catalog Version'))}</span>
              <span class="telemetry-v">${escapeHtml(cat.catalogVersion || 'n/a')}</span>
            </div>
            <div class="telemetry-cell">
              <span class="telemetry-k">${escapeHtml(t('客户端版本', 'Client Version'))}</span>
              <span class="telemetry-v">${escapeHtml(formatV(state.serverState?.plugin?.version || PLUGIN_VERSION))}</span>
            </div>
            <div class="telemetry-cell">
              <span class="telemetry-k">${escapeHtml(t('更新检查', 'Update Check'))}</span>
              <span class="telemetry-v">${escapeHtml(state.updates.checkedAt ? formatRelativeTime(state.updates.checkedAt) : t('等待中', 'Pending'))}</span>
            </div>
          </div>
        </div>

        <div class="field-card">
          <div class="field-head">
            <label class="field-label" for="github-token-input">${icon('key', 14)} ${escapeHtml(t('GitHub Personal Access Token（可选）', 'GitHub Personal Access Token (Optional)'))}</label>
            <span class="state-pill ${hasToken ? 'is-enabled' : 'is-disabled'}">
              ${hasToken ? icon('lock', 10) : ''} ${escapeHtml(hasToken ? t('已安全保存', 'Saved Locally') : t('未配置', 'Not Set'))}
            </span>
          </div>
          <p class="field-hint">${escapeHtml(t('仅保存在本机插件数据目录中，绝不回显或打印日志。配置后可解锁插件详情内联 GitHub Discussions 列表，并将更新检测额度从每小时 60 次提升至 5,000 次。', 'Stored locally only and never echoed or logged. Unlocks inline GitHub Discussions threads in plugin details and raises update-check rate limits from 60/hr to 5,000/hr.'))}</p>
          <div class="token-row">
            <input
              id="github-token-input"
              class="text-input"
              type="password"
              autocomplete="off"
              placeholder="${escapeHtml(hasToken ? t('已保存 Token（留空则保持不变，输入新值可替换）', 'Token saved (leave blank to keep, or enter new token)') : 'ghp_... / github_pat_...')}"
            />
            ${
              hasToken
                ? `<button type="button" class="btn btn-danger-ghost btn-sm" data-action="clear-github-token"${lockAttr}>${escapeHtml(t('清除 Token', 'Clear'))}</button>`
                : ''
            }
          </div>
        </div>

        <div class="field-card">
          <label class="field-label" for="net-mode-select">${icon('layers', 14)} ${escapeHtml(t('目录镜像与国内网络模式', 'Catalog Mirror & Network Mode'))}</label>
          <p class="field-hint">${escapeHtml(t('自动模式下优先通过 ETag 304 请求 GitHub Pages，超时 (>3.5s) 自动回退至 npmmirror / 腾讯云 @agy-market/catalog 纯 JSON 镜像包。', 'Auto mode queries GitHub Pages with ETag 304 and falls back to @agy-market/catalog on npmmirror / Tencent mirror on timeout.'))}</p>
          <select id="net-mode-select" class="select-input">
            <option value="auto" ${prefs.networkMode === 'auto' ? 'selected' : ''}>${escapeHtml(t('自动切换 (GitHub Pages -> 国内镜像兜底)', 'Auto (GitHub Pages -> China Mirror Fallback)'))}</option>
            <option value="china-mirror" ${prefs.networkMode === 'china-mirror' ? 'selected' : ''}>${escapeHtml(t('国内镜像优先 (npmmirror / 腾讯云)', 'China Mirror Priority (npmmirror / Tencent)'))}</option>
            <option value="direct" ${prefs.networkMode === 'direct' ? 'selected' : ''}>${escapeHtml(t('仅直连主源 (Direct Only)', 'Direct Primary Only'))}</option>
          </select>
        </div>

        <div class="field-card">
          <label class="field-label" for="mirror-prefix-input">${icon('shield', 14)} ${escapeHtml(t('GitHub Release 下载加速前缀 (SHA-256 校验)', 'GitHub Release Download Mirror Prefix (SHA-256 Verified)'))}</label>
          <p class="field-hint">${escapeHtml(t('可选。填写下载代理前缀后，所有 .tar.gz 解压前仍会校验目录中的 SHA-256 摘要。', 'Optional download proxy prefix. Every archive is still verified against catalog SHA-256 before extraction.'))}</p>
          <input id="mirror-prefix-input" class="text-input" type="text" placeholder="https://mirror.example.com/" value="${escapeHtml(prefs.githubReleaseMirrorPrefix || '')}" />
        </div>

        <div class="field-card">
          <label class="field-label" for="primary-url-input">${escapeHtml(t('主目录源地址 (Primary Catalog Base URL)', 'Primary Catalog Base URL'))}</label>
          <input id="primary-url-input" class="text-input" type="url" value="${escapeHtml(prefs.primaryCatalogUrl || '')}" />
        </div>

        <div class="field-card">
          <label class="field-label" for="custom-feeds-textarea">${escapeHtml(t('自定义 / 团队私有静态源 (每行一个 index.json URL)', 'Custom / Team Static Feeds (one index.json URL per line)'))}</label>
          <textarea id="custom-feeds-textarea" class="text-input" rows="3" placeholder="https://plugins.internal.example/index.json">${escapeHtml(customLines)}</textarea>
        </div>

        <div style="display:flex;align-items:center;gap:8px">
          <button type="submit" class="btn btn-primary"${lockAttr}>${icon('check', 13)} ${escapeHtml(t('保存并重新同步目录', 'Save & Revalidate Catalog'))}</button>
        </div>
      </form>
    </div>
  `;
}

// ==========================================================================
// Slide-Over Detail Drawer (Clickable GitHub Title + Live Toggle + Remove Files + Localized README)
// ==========================================================================

function renderDiscussTabContent(plugin) {
  const entry = state.discussionsCache[plugin.id];
  const fallbackUrl = deriveDiscussionsUrl(plugin.repository?.url);
  const data = entry?.data;
  const openUrl = data?.url || fallbackUrl;
  const newUrl = data?.newDiscussionUrl || (openUrl ? `${openUrl}/new/choose` : '');

  const topActions = `
    <div class="discuss-header">
      <div style="display:flex;align-items:center;gap:6px;font-weight:700;font-size:12.5px">
        ${icon('message', 14)}
        <span>GitHub Discussions</span>
      </div>
      <div style="display:flex;align-items:center;gap:6px">
        <button type="button" class="btn btn-sm" data-action="refresh-discussions" data-id="${escapeHtml(plugin.id)}" ${entry?.loading ? 'disabled' : ''}>
          ${icon('refresh', 12, entry?.loading ? 'spin' : '')}
        </button>
        ${openUrl && !data?.disabled ? `<a class="btn btn-sm" href="${escapeHtml(openUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(t('打开 GitHub', 'Open GitHub'))} ${icon('external', 11)}</a>` : ''}
        ${newUrl && !data?.disabled ? `<a class="btn btn-primary btn-sm" href="${escapeHtml(newUrl)}" target="_blank" rel="noopener noreferrer">${icon('plus', 12)} ${escapeHtml(t('发起讨论', 'New Discussion'))}</a>` : ''}
      </div>
    </div>
  `;

  if (!entry || entry.loading) {
    return `
      ${topActions}
      <div class="discuss-list">
        ${Array.from({ length: 3 })
          .map(
            () => `<div class="skel-card" style="padding:11px 12px;gap:8px">
              <div class="skel skel-line" style="width:72%"></div>
              <div class="skel skel-line" style="width:44%"></div>
            </div>`,
          )
          .join('')}
      </div>
    `;
  }

  if (entry.error && !data) {
    return `
      ${topActions}
      <div class="discuss-info-box">
        <div style="font-weight:650;color:var(--m-danger)">${escapeHtml(t('讨论加载失败', 'Failed to load discussions'))}</div>
        <div class="muted" style="font-size:11.8px">${escapeHtml(entry.error)}</div>
      </div>
    `;
  }

  if (data?.disabled) {
    return `
      ${topActions}
      <div class="discuss-info-box">
        <div style="font-weight:650">${escapeHtml(t('该仓库暂未启用 GitHub Discussions', 'GitHub Discussions is disabled for this repository'))}</div>
        <div class="muted" style="font-size:11.8px">${escapeHtml(t('你可以前往仓库主页或 Issues 提交反馈与建议。', 'You can visit the repository homepage or Issues to report bugs and share feedback.'))}</div>
        ${plugin.repository?.url ? `<div><a class="btn btn-sm" href="${escapeHtml(plugin.repository.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(t('访问仓库主页', 'Open Repository'))} ${icon('external', 11)}</a></div>` : ''}
      </div>
    `;
  }

  const items = data?.items || [];
  if (items.length > 0) {
    return `
      ${topActions}
      ${
        data?.rateLimited
          ? `<div class="notice-strip"><span>${icon('alertCircle', 13)} ${escapeHtml(t('GitHub API 当前限流，以下为缓存内容。', 'GitHub API rate-limited; showing cached results.'))}</span></div>`
          : ''
      }
      <div class="discuss-list">
        ${items
          .map(
            (item) => `
            <a class="discuss-item" href="${escapeHtml(item.url || openUrl || '#')}" target="_blank" rel="noopener noreferrer">
              <div class="discuss-item-title">
                <span>${escapeHtml(item.title || t('无标题讨论', 'Untitled discussion'))}</span>
                ${icon('arrowUpRight', 13)}
              </div>
              <div class="discuss-item-meta">
                ${item.category ? `<span class="discuss-cat-pill">${escapeHtml(item.category)}</span>` : ''}
                ${item.author ? `<span>@${escapeHtml(item.author)}</span>` : ''}
                <span>${icon('message', 11)} ${Number(item.comments || 0)}</span>
                ${item.updatedAt ? `<span>· ${escapeHtml(formatRelativeTime(item.updatedAt))}</span>` : ''}
              </div>
            </a>
          `,
          )
          .join('')}
      </div>
    `;
  }

  if (data?.needsToken) {
    return `
      ${topActions}
      <div class="discuss-info-box">
        <div style="font-weight:650">${escapeHtml(t('在面板内预览讨论需要配置 GitHub Token', 'Add a GitHub Token to preview discussions inline'))}</div>
        <div class="muted" style="font-size:11.8px;line-height:1.55">${escapeHtml(t('GitHub Discussions 列表接口仅通过 GraphQL 开放且要求鉴权。你仍可直接点击上方按钮前往 GitHub 浏览与发帖，或在「源与设置」填写只读 Token 解锁内联列表。', 'GitHub Discussions queries require an authenticated GraphQL request. You can open GitHub directly above, or configure an optional read-only token in Sources & Settings.'))}</div>
        <div style="display:flex;flex-wrap:wrap;gap:7px">
          <button type="button" class="btn btn-primary btn-sm" data-action="goto-token">${icon('key', 12)} ${escapeHtml(t('前往配置 Token', 'Configure Token'))}</button>
          ${openUrl ? `<a class="btn btn-sm" href="${escapeHtml(openUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(t('在 GitHub 浏览讨论', 'Browse on GitHub'))} ${icon('external', 11)}</a>` : ''}
        </div>
      </div>
    `;
  }

  return `
    ${topActions}
    <div class="discuss-info-box">
      <div style="font-weight:650">${escapeHtml(t('暂无社区讨论话题', 'No discussions yet'))}</div>
      <div class="muted" style="font-size:11.8px">${escapeHtml(t('成为第一个围绕此插件分享使用心得或提出建议的开发者吧。', 'Be the first to start a conversation, share tips, or ask a question about this plugin.'))}</div>
      ${newUrl ? `<div><a class="btn btn-primary btn-sm" href="${escapeHtml(newUrl)}" target="_blank" rel="noopener noreferrer">${icon('plus', 12)} ${escapeHtml(t('发起新讨论', 'Start a Discussion'))}</a></div>` : ''}
    </div>
  `;
}

function renderDetailDrawer() {
  const p = state.detailPlugin;
  if (!p) return '';
  const { byId: updById, byDir: updByDir } = getUpdateMaps();
  const installedByDir = getInstalledByDirMap();
  const st = p.installStatus || {};
  const localItem = st.installedDir ? installedByDir.get(st.installedDir) || null : null;
  const installedDir = st.installedDir || localItem?.dir || '';
  const isSelf = installedDir === 'agy-market' || p.canonicalName === 'agy-market' || p.id === 'azwosile__agy-market';
  const effectiveLoc =
    localItem ||
    (st.installed && !state.serverState && (!st.scope || st.scope === 'global')
      ? {
          dir: installedDir || (isSelf ? 'agy-market' : ''),
          scope: st.scope || 'global',
          version: st.installedVersion || '',
          receipt: { id: p.id },
        }
      : null);
  const upd = effectiveLoc ? findUpdateForLocal(effectiveLoc, updById, updByDir) : null;
  const hasAnyUpdate = Boolean(upd || (st.installed && hasStaleSafeCatalogUpdate(p, effectiveLoc)));
  const isSelfUpdate = Boolean(upd?.isSelf || isSelf);
  const isDirectGhUpdate = Boolean(upd && isDirectGithubUpdateItem(upd));
  const isGithubUrlLocal = Boolean(
    p._localOnly && (localItem?.receipt?.track === 'github-url' || p._track === 'github-url'),
  );
  const directTargetId = upd?.id || localItem?.receipt?.id || p.id || installedDir;
  const isCommitUpdate = Boolean(upd && upd.updateKind === 'commit' && upd.latestCommitSha);
  const isBusy = Boolean(
    state.busyId === p.id ||
      (installedDir && state.busyId === installedDir) ||
      (directTargetId && state.busyId === directTargetId) ||
      (isSelf && state.selfUpdateBusy) ||
      (state.batchUpdating &&
        ((p.id && state.batchTargetIds.includes(p.id)) ||
          (installedDir && state.batchTargetIds.includes(installedDir)) ||
          (directTargetId && state.batchTargetIds.includes(directTargetId)))),
  );
  const updateActionLocked = isUpdateActionLocked();
  const lockAttr = updateActionLocked ? ' disabled aria-disabled="true"' : '';
  const repoUrl = p.repository?.url || localItem?.repositoryUrl || localItem?.receipt?.repositoryUrl || '';
  const pluginRoot = p.repository?.pluginRoot || localItem?.receipt?.pluginRoot || '.';
  const discussUrl = deriveDiscussionsUrl(repoUrl);
  const loc = getLocale();
  const accent = resolveCardAccent(p);
  const isEnabled = st.installed ? Boolean(localItem ? localItem.enabled : st.enabled) : false;
  const localScope = localItem?.scope || st.scope || 'global';
  const canUninstall = Boolean(
    st.installed &&
      installedDir &&
      !isSelf &&
      localScope === 'global' &&
      localItem?.canUninstall !== false &&
      st.canUninstall !== false,
  );
  const hasRemoteSource = localScope === 'global' && (isSelf || !p._localOnly || Boolean(repoUrl));
  const isConfirmedLatest = Boolean(
    st.installed &&
      !hasAnyUpdate &&
      hasRemoteSource &&
      isPluginConfirmedLatest(
        localItem || { dir: installedDir || (isSelf ? 'agy-market' : ''), scope: localScope, version: st.installedVersion || '' },
        upd,
      ),
  );
  const displayName = p.displayName || p.canonicalName;
  const favKey = p._localOnly ? getLocalFavoriteKey(localItem || { dir: installedDir, receipt: { id: p.id } }, null) : String(p.id || '');

  let primaryBtn = '';
  if (isBusy) {
    primaryBtn = `<button type="button" class="btn btn-primary btn-sm" disabled aria-disabled="true">${icon('refresh', 12, 'spin')} ${escapeHtml(t('处理中…', 'Working…'))}</button>`;
  } else if (hasAnyUpdate) {
    const targetV = upd?.latestVersion || p.version;
    const updLabel = isCommitUpdate
      ? t(`更新至 ${upd.latestCommitSha}`, `Update to ${upd.latestCommitSha}`)
      : t(`更新至 ${formatV(targetV)}`, `Update to ${formatV(targetV)}`);
    if (isSelfUpdate) {
      primaryBtn = `<button type="button" class="btn btn-update btn-sm" data-action="self-update" data-update-channel="${escapeHtml(upd?.updateChannel || '')}" data-target-version="${escapeHtml(targetV)}" data-target-ref="${escapeHtml(upd?.targetRef || '')}"${lockAttr}>${icon('update', 12)} ${escapeHtml(updLabel)}</button>`;
    } else if (isDirectGhUpdate || p._localOnly) {
      primaryBtn = `<button type="button" class="btn btn-update btn-sm" data-action="update-plugin-direct" data-id="${escapeHtml(directTargetId)}" data-dir="${escapeHtml(upd?.dir || installedDir)}" data-name="${escapeHtml(displayName)}" data-source="${escapeHtml(upd?.source || '')}" data-update-channel="${escapeHtml(upd?.updateChannel || '')}" data-target-ref="${escapeHtml(upd?.targetRef || '')}" data-update-kind="${escapeHtml(upd?.updateKind || '')}" data-track-branch="${escapeHtml(upd?.trackBranch || '')}" data-repo-url="${escapeHtml(upd?.repositoryUrl || repoUrl)}"${lockAttr}>${icon('update', 12)} ${escapeHtml(updLabel)}</button>`;
    } else {
      primaryBtn = `<button type="button" class="btn btn-update btn-sm" data-action="install" data-id="${escapeHtml(p.id)}" data-dir="${escapeHtml(installedDir)}"${lockAttr}>${icon('update', 12)} ${escapeHtml(updLabel)}</button>`;
    }
  } else if (st.installed) {
    if (isConfirmedLatest) {
      const latestPillHtml = `<span class="state-pill is-latest" title="${escapeHtml(t('已检查为最新版本', 'Up to date'))}">${icon('check', 12)} ${escapeHtml(t('已是最新版本', 'Up to Date'))}</span>`;
      if (isSelf) {
        primaryBtn = latestPillHtml;
      } else if (p._localOnly) {
        primaryBtn = `${latestPillHtml}<button type="button" class="btn btn-sm" data-action="update-plugin-direct" data-id="${escapeHtml(directTargetId)}" data-dir="${escapeHtml(installedDir)}" data-name="${escapeHtml(displayName)}" data-repo-url="${escapeHtml(repoUrl)}" data-force-resync="1"${lockAttr} title="${escapeHtml(t('重新拉取并覆盖同步插件文件', 'Re-sync plugin files from GitHub'))}">${icon('refresh', 12)} ${escapeHtml(t('重新同步', 'Re-sync'))}</button>`;
      } else {
        primaryBtn = `${latestPillHtml}<button type="button" class="btn btn-sm" data-action="install" data-id="${escapeHtml(p.id)}" data-dir="${escapeHtml(installedDir)}" data-force-resync="1"${lockAttr} title="${escapeHtml(t('重新拉取并覆盖同步插件文件', 'Re-sync plugin files'))}">${icon('refresh', 12)} ${escapeHtml(t('重新同步', 'Re-sync'))}</button>`;
      }
    } else if (hasRemoteSource && state.updates.loading) {
      primaryBtn = `<button type="button" class="btn btn-sm" data-action="sync-installed-plugin" data-dir="${escapeHtml(installedDir || (isSelf ? 'agy-market' : ''))}" data-id="${escapeHtml(directTargetId)}" data-name="${escapeHtml(displayName)}" disabled aria-disabled="true" aria-busy="true" title="${escapeHtml(t('正在检测插件更新，请稍候…', 'Checking for plugin updates…'))}">${icon('refresh', 12, 'spin')} ${escapeHtml(t('检测中…', 'Checking…'))}</button>`;
    } else if (hasRemoteSource) {
      primaryBtn = `<button type="button" class="btn btn-sm" data-action="sync-installed-plugin" data-dir="${escapeHtml(installedDir || (isSelf ? 'agy-market' : ''))}" data-id="${escapeHtml(directTargetId)}" data-name="${escapeHtml(displayName)}"${lockAttr}>${icon('update', 12)} ${escapeHtml(t('检查更新', 'Check Update'))}</button>`;
    } else {
      const noSourceLabel =
        localScope === 'workspace'
          ? t('工作区', 'Workspace')
          : localScope === 'builtin'
            ? t('内置', 'Built-in')
            : t('本地', 'Local');
      primaryBtn = `<span class="state-pill is-local">${escapeHtml(noSourceLabel)}</span>`;
    }
  } else {
    primaryBtn = `<button type="button" class="btn btn-primary btn-sm" data-action="install" data-id="${escapeHtml(p.id)}"${lockAttr}>${icon('download', 12)} ${escapeHtml(t('立即安装并启用', 'Install Now'))}</button>`;
  }

  const drawerPaneBtn = st.installed
    ? renderOpenPaneButtonHtml({
        dir: installedDir,
        sidecarPane: localItem?.sidecarPane || st.sidecarPane,
        enabled: isEnabled,
        btnClass: 'btn btn-sm',
        label: t('打开面板', 'Open Pane'),
      })
    : '';

  const drawerToggleHtml = st.installed
    ? `<div class="drawer-toggle-box">${renderToggleSliderHtml({
        dir: installedDir,
        enabled: isEnabled,
        canToggle: localItem ? localItem.canToggle : st.canToggle,
        toggleDisabledReason: isSelf ? 'self' : localItem ? localItem.toggleDisabledReason : st.toggleDisabledReason,
      })}</div>`
    : '';

  const drawerTitleHtml = isSafeHttpUrl(repoUrl)
    ? `<a class="drawer-title-link" href="${escapeHtml(repoUrl)}" target="_blank" rel="noopener noreferrer" title="${escapeHtml(t('在新窗口打开 GitHub 仓库', 'Open GitHub repository'))}"><span>${escapeHtml(p.displayName || p.canonicalName)}</span>${icon('arrowUpRight', 14)}</a>`
    : escapeHtml(p.displayName || p.canonicalName);

  let bodyHtml = '';
  if (state.detailTab === 'overview') {
    const langTag =
      state.detailReadme && !state.detailReadmeLoading
        ? `<div class="readme-lang-bar">
            <span class="readme-lang-pill">${icon('book', 12)} ${escapeHtml(
              state.detailReadmeIsZh
                ? t('简体中文说明文档', 'Simplified Chinese README')
                : t('English 原文文档', 'English README'),
            )}</span>
            <span>${escapeHtml(loc === 'zh' ? 'README.zh-CN.md / README.md' : 'README.en.md / README.md')}</span>
          </div>`
        : '';

    const drawerCatTagsHtml = renderCategoryTagsHtml(p.taxonomy?.categories, { maxCount: 0, clickable: false });
    bodyHtml = `
      <div class="badge-row">
        ${drawerCatTagsHtml}
        ${renderBadgesHtml(p.capabilities)}
      </div>
      ${langTag}
      <div class="md-body">
        ${
          state.detailReadmeLoading
            ? `<div class="skel-card" style="gap:9px">
                <div class="skel skel-line" style="width:45%;height:14px"></div>
                <div class="skel skel-line" style="width:92%"></div>
                <div class="skel skel-line" style="width:86%"></div>
                <div class="skel skel-line" style="width:68%"></div>
              </div>`
            : renderSafeMarkdown(state.detailReadme, t('暂无 README 文档。', 'No README provided.'))
        }
      </div>
      <div class="meta-kv">
        <span class="muted">ID / Slug</span>
        <span class="mono">${escapeHtml(p.id)} (${escapeHtml(p.forceScopedInstall ? p.scopedName : p.canonicalName)})</span>
        ${
          Array.isArray(p.taxonomy?.categories) && p.taxonomy.categories.length > 0
            ? `<span class="muted">${escapeHtml(t('分类', 'Categories'))}</span>
               <span>${escapeHtml(p.taxonomy.categories.map((c) => formatCategoryLabel(c, loc)).join(' · '))}</span>`
            : ''
        }
        ${
          repoUrl
            ? `<span class="muted">Repository</span>
               <span><a class="md-link" href="${escapeHtml(repoUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(repoUrl)}</a></span>`
            : ''
        }
        ${
          pluginRoot && pluginRoot !== '.'
            ? `<span class="muted">${escapeHtml(t('子目录', 'Subpath'))}</span>
               <span class="mono">${escapeHtml(pluginRoot)}</span>`
            : ''
        }
        ${
          p.gitTag || p.commitSha
            ? `<span class="muted">Tag / Commit</span>
               <span class="mono">${escapeHtml(p.gitTag || (p.commitSha ? 'commit' : 'n/a'))}${p.commitSha ? ` · ${escapeHtml(String(p.commitSha).slice(0, 12))}` : ''}</span>`
            : ''
        }
        ${
          p.distribution?.sha256
            ? `<span class="muted">SHA-256</span>
               <span class="meta-kv-val">
                 <span class="mono" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(p.distribution.sha256)}</span>
                 <button type="button" class="icon-btn btn-sm" data-action="copy-text" data-copy-key="sha-${escapeHtml(p.id)}" data-copy-val="${escapeHtml(p.distribution.sha256)}" title="${escapeHtml(t('复制完整 SHA-256', 'Copy SHA-256'))}">
                   ${icon(state.copiedKey === `sha-${p.id}` ? 'check' : 'copy', 11)}
                 </button>
               </span>`
            : ''
        }
      </div>
    `;
  } else if (state.detailTab === 'changelog') {
    const changelogFromVer = localItem?.version || upd?.installedVersion || st.installedVersion || '?';
    const changelogTitle = upd
      ? isCommitUpdate
        ? `${formatV(changelogFromVer)} (${upd.installedCommitSha || String(localItem?.receipt?.commitSha || p.commitSha || '').slice(0, 7) || 'HEAD'} → ${upd.latestCommitSha})`
        : `${formatV(changelogFromVer)} → ${formatV(upd.latestVersion)}`
      : '';
    bodyHtml = upd
      ? `
        <div class="changelog-banner">
          <div style="display:flex;flex-direction:column;gap:3px">
            <div style="font-weight:700;font-size:12.5px">${escapeHtml(changelogTitle)}</div>
            <div class="muted" style="font-size:11.2px">${escapeHtml(
              upd.updateChannel === 'github-upstream'
                ? t('来源：GitHub 上游直连更新（Sidebar 内拉取并校验 SHA-256）', 'Source: GitHub upstream direct update (fetched & SHA-256 verified in Sidebar)')
                : upd.updateChannel === 'github-url' || isGithubUrlLocal
                  ? t('来源：GitHub 仓库直连更新（本地 SHA-256 校验）', 'Source: GitHub repository direct update (local SHA-256 verified)')
                  : t('来源：已验证目录（SHA-256 已校验）', 'Source: Verified Catalog (SHA-256 verified)'),
            )}</div>
          </div>
          ${upd.releaseUrl ? `<a class="btn btn-sm" href="${escapeHtml(upd.releaseUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(isCommitUpdate ? t('查看对比', 'Compare') : 'Release')} ${icon('external', 11)}</a>` : ''}
        </div>
        <div class="md-body">
          ${renderSafeMarkdown(upd.changelog, t('上游未附带详细的更新日志说明。', 'No release notes were provided for this version.'))}
        </div>
      `
      : `<div class="empty-state">
          <div class="empty-icon">${icon('history', 20)}</div>
          <div class="empty-title">${escapeHtml(t('当前已是最新版本', 'Currently up to date'))}</div>
          <div class="empty-sub">${escapeHtml(t(`当前版本 ${formatV(localItem?.version || st.installedVersion || p.version)}，暂无待安装的更新日志。`, `Running ${formatV(localItem?.version || st.installedVersion || p.version)} with no pending update changelog.`))}</div>
          ${repoUrl ? `<a class="btn btn-sm" href="${escapeHtml(repoUrl)}/releases" target="_blank" rel="noopener noreferrer">${escapeHtml(t('查看 GitHub Releases', 'View GitHub Releases'))} ${icon('external', 11)}</a>` : ''}
        </div>`;
  } else if (state.detailTab === 'capabilities') {
    const cap = p.capabilities || {};
    const badges = Array.isArray(cap.badges) ? cap.badges : [];
    bodyHtml = `
      <div class="cap-detail-list">
        ${
          badges.length
            ? badges
                .map((id) => {
                  const spec = getUiBadgeSpec(id);
                  const label = cleanBadgeText(id, cap);
                  const desc = loc === 'en' ? spec.descEn : spec.descZh;
                  return `
                    <div class="cap-detail-card">
                      <div><span class="cap-badge tone-${escapeHtml(spec.tone)}">${badgeIcon(id, 11)}<span>${escapeHtml(label)}</span></span></div>
                      <p class="cap-detail-desc">${escapeHtml(desc)}</p>
                    </div>
                  `;
                })
                .join('')
            : `<p class="muted">${escapeHtml(t('暂无静态能力声明数据。', 'No static capability metadata available.'))}</p>`
        }
      </div>
      <div class="meta-kv">
        <span class="muted">${escapeHtml(t('常驻规则估算', 'Global Rules'))}</span>
        <span class="mono">~${Number(cap.rulesEstimatedTokens || 0)} tokens</span>
        <span class="muted">MCP Servers</span>
        <span class="mono">${escapeHtml((cap.mcpServers || []).join(', ') || '—')}</span>
        <span class="muted">Remote Domains</span>
        <span class="mono">${escapeHtml((cap.mcpRemoteDomains || []).join(', ') || '—')}</span>
        <span class="muted">Hook Events</span>
        <span class="mono">${escapeHtml((cap.hookEvents || []).join(', ') || '—')}</span>
        <span class="muted">Host Enhance</span>
        <span class="mono">${escapeHtml((cap.hostEnhancementKind || []).join(', ') || '—')}</span>
      </div>
    `;
  } else if (state.detailTab === 'discuss') {
    bodyHtml = renderDiscussTabContent(p);
  }

  return `
    <div class="drawer-backdrop" data-action="close-modal">
      <aside class="drawer-panel" style="--card-accent:${accent.a1};--card-accent-2:${accent.a2}" role="dialog" aria-modal="true" aria-label="${escapeHtml(p.displayName || p.canonicalName)}" onclick="event.stopPropagation()">
        <div class="drawer-hero">
          <div class="drawer-hero-top">
            ${renderLogoHtml(p.media?.iconUrl, p.displayName || p.canonicalName, { sizeClass: 'is-lg', isSelf })}
            <div class="drawer-hero-info">
              <h2 class="drawer-title">${drawerTitleHtml}</h2>
              <div class="drawer-subtitle">
                <span class="mono">${escapeHtml(p.forceScopedInstall ? p.scopedName : p.canonicalName)}</span>
                ${
                  upd
                    ? (() => {
                        const drawerFromVer = localItem?.version || upd.installedVersion || st.installedVersion || '?';
                        return isCommitUpdate
                          ? `<span class="version-delta">${escapeHtml(formatV(drawerFromVer))} (${escapeHtml(upd.installedCommitSha || String(localItem?.receipt?.commitSha || p.commitSha || '').slice(0, 7) || 'HEAD')} → ${escapeHtml(upd.latestCommitSha)})</span>`
                          : `<span class="version-delta">${escapeHtml(formatV(drawerFromVer))} → ${escapeHtml(formatV(upd.latestVersion))}</span>`;
                      })()
                    : hasAnyUpdate && st.installed
                      ? `<span class="version-delta">${escapeHtml(formatV(localItem?.version || st.installedVersion || '?'))} → ${escapeHtml(formatV(p.version))}</span>`
                      : `<span class="version-tag">${escapeHtml(formatV(localItem?.version || p.version))}</span>`
                }
                ${isGithubUrlLocal ? `<span class="track-tag is-github-url">GitHub URL</span>` : ''}
                ${Number(p.repository?.stars || 0) > 0 ? `<span class="meta-star">${icon('star', 11)} ${Number(p.repository.stars)}</span>` : ''}
              </div>
            </div>
            <div class="drawer-header-actions">
              ${renderFavoriteButtonHtml({ key: favKey, displayName, sizeClass: 'is-drawer' })}
              <button type="button" class="icon-btn is-square" data-action="close-modal" title="${escapeHtml(t('关闭 (Esc)', 'Close (Esc)'))}">${icon('close', 14)}</button>
            </div>
          </div>

          <div class="drawer-cta-bar">
            ${drawerToggleHtml}
            ${primaryBtn}
            ${drawerPaneBtn}
            ${repoUrl ? `<a class="btn btn-sm" href="${escapeHtml(repoUrl)}" target="_blank" rel="noopener noreferrer">GitHub ${icon('external', 11)}</a>` : ''}
            ${discussUrl ? `<a class="btn btn-sm" href="${escapeHtml(discussUrl)}" target="_blank" rel="noopener noreferrer">${icon('message', 12)} ${escapeHtml(t('讨论区', 'Discussions'))}</a>` : ''}
            ${
              canUninstall
                ? `<button type="button" class="btn btn-danger-ghost btn-sm" data-action="prompt-uninstall" data-dir="${escapeHtml(installedDir)}" data-name="${escapeHtml(p.displayName || installedDir)}" data-version="${escapeHtml(st.installedVersion || p.version || '')}" data-fav-key="${escapeHtml(favKey)}"${lockAttr}>
                    ${icon('trash', 12)} ${escapeHtml(t('卸载插件', 'Uninstall'))}
                  </button>`
                : ''
            }
          </div>
        </div>

        <nav class="drawer-tabs" role="tablist">
          <button type="button" class="drawer-tab ${state.detailTab === 'overview' ? 'active' : ''}" data-action="detail-tab" data-tab="overview">
            ${icon('book', 12)} ${escapeHtml(t('概览', 'Overview'))}
          </button>
          <button type="button" class="drawer-tab ${state.detailTab === 'changelog' ? 'active' : ''}" data-action="detail-tab" data-tab="changelog">
            ${icon('history', 12)} ${escapeHtml(t('更新日志', 'Changelog'))}
            ${upd ? '<span class="status-dot is-pulse"></span>' : ''}
          </button>
          <button type="button" class="drawer-tab ${state.detailTab === 'capabilities' ? 'active' : ''}" data-action="detail-tab" data-tab="capabilities">
            ${icon('shield', 12)} ${escapeHtml(t('能力声明', 'Capabilities'))}
          </button>
          <button type="button" class="drawer-tab ${state.detailTab === 'discuss' ? 'active' : ''}" data-action="detail-tab" data-tab="discuss">
            ${icon('message', 12)} ${escapeHtml(t('讨论', 'Discuss'))}
          </button>
        </nav>

        <div class="drawer-body" id="market-drawer-body">
          ${bodyHtml}
        </div>
      </aside>
    </div>
  `;
}

// ==========================================================================
// Modals & Reconnect Overlay
// ==========================================================================

function renderGithubUrlModal() {
  const m = state.githubUrlModal;
  if (!m) return '';
  const isBusyPhase = m.phase === 'inspecting' || m.phase === 'installing';
  const loc = getLocale();

  let bodyHtml = '';
  let footerHtml = '';

  if (m.phase === 'input') {
    bodyHtml = `
      <p class="muted" style="margin:0;line-height:1.55">${escapeHtml(
        t(
          '粘贴公开 GitHub 插件仓库、子目录或归档链接，系统将先下载并计算 SHA-256、执行本地静态预检，确认后再安装。',
          'Paste a public GitHub repository, subpath, or tarball URL. AGY Market will download the archive, verify SHA-256, and run local static checks before installing.',
        ),
      )}</p>
      <div class="gh-url-input-row">
        <input
          id="github-url-input"
          class="text-input gh-url-input"
          type="text"
          inputmode="url"
          autocomplete="off"
          spellcheck="false"
          placeholder="https://github.com/owner/repo"
          value="${escapeHtml(m.url || '')}"
        />
      </div>
      ${
        m.error
          ? `<div class="gh-inline-error" role="alert">${icon('alertTriangle', 14)}<span>${escapeHtml(m.error)}</span></div>`
          : ''
      }
      <div class="gh-url-formats">
        <div class="gh-url-formats-title">${escapeHtml(t('支持的链接格式', 'Supported URL formats'))}</div>
        <div class="gh-url-format-row">
          <span>${escapeHtml(t('仓库主页', 'Repository'))}:</span>
          <code>https://github.com/&lt;owner&gt;/&lt;repo&gt;</code>
        </div>
        <div class="gh-url-format-row">
          <span>${escapeHtml(t('分支或 Monorepo 子目录', 'Branch / Monorepo Subpath'))}:</span>
          <code>.../tree/&lt;branch&gt;/&lt;subpath&gt;</code>
        </div>
        <div class="gh-url-format-row">
          <span>${escapeHtml(t('指定 Release 标签', 'Release Tag'))}:</span>
          <code>.../releases/tag/&lt;tag&gt;</code>
        </div>
        <div class="gh-url-format-row">
          <span>${escapeHtml(t('归档直链', 'Tarball URL'))}:</span>
          <code>.../releases/download/&lt;tag&gt;/&lt;file&gt;.tar.gz</code>
        </div>
      </div>
    `;
    footerHtml = `
      <button type="button" class="btn btn-sm" data-action="close-modal">${escapeHtml(t('取消', 'Cancel'))}</button>
      <button type="button" id="gh-inspect-submit-btn" class="btn btn-primary btn-sm" data-action="inspect-github-url" ${!String(m.url || '').trim() ? 'disabled' : ''}>
        ${icon('search', 12)}
        <span>${escapeHtml(t('解析预检', 'Inspect'))}</span>
      </button>
    `;
  } else if (m.phase === 'inspecting') {
    bodyHtml = `
      <div class="gh-progress-box">
        <div class="reconnect-orb">${icon('refresh', 20, 'spin')}</div>
        <div class="gh-progress-title">${escapeHtml(t('正在获取归档并执行本地静态检查…', 'Fetching archive and running local static checks…'))}</div>
        <div class="gh-progress-url" title="${escapeHtml(m.url || '')}">${escapeHtml(m.url || '')}</div>
        <div class="progress-track"><div class="progress-fill"></div></div>
        <div class="muted" style="font-size:11.4px;line-height:1.5">${escapeHtml(
          t(
            '正在下载压缩包、计算 SHA-256 摘要并扫描 plugin.json 与能力声明，请稍候。',
            'Downloading tarball, computing SHA-256 digest, and inspecting plugin.json & capabilities…',
          ),
        )}</div>
      </div>
    `;
    footerHtml = `
      <span class="muted" style="font-size:11.2px;margin-right:auto">${escapeHtml(t('预检完成后将展示详情供确认', 'Preview will appear once inspection finishes'))}</span>
    `;
  } else if (m.phase === 'subpaths') {
    const res = m.inspectResult || {};
    const candidates = Array.isArray(m.subpathCandidates)
      ? m.subpathCandidates
      : Array.isArray(res.candidates)
        ? res.candidates
        : [];
    const repoUrl = res.repoUrl || (isSafeHttpUrl(m.url) ? m.url : '');
    const subpathIntro =
      (loc === 'en' ? res.reasonEn || res.reasonZh : res.reasonZh || res.reasonEn) ||
      t(
        `该仓库包含 ${candidates.length} 个插件子目录，请选择需要预检和安装的插件：`,
        `Found ${candidates.length} plugin subpaths in this repository. Select one to inspect and install:`,
      );
    bodyHtml = `
      <p class="muted" style="margin:0;line-height:1.5">${escapeHtml(subpathIntro)}</p>
      ${
        isSafeHttpUrl(repoUrl)
          ? `<div style="font-size:11.4px"><a class="md-link" href="${escapeHtml(repoUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(repoUrl)} ${icon('external', 11)}</a></div>`
          : ''
      }
      <div class="gh-subpath-list">
        ${candidates
          .map((cand) => {
            const cName = cand.displayName || cand.name || cand.pluginRoot;
            const cDesc =
              typeof cand.description === 'object'
                ? cand.description[loc] || cand.description.zh || cand.description.en || ''
                : String(cand.description || '');
            return `
              <button type="button" class="gh-subpath-item" data-action="select-github-subpath" data-plugin-root="${escapeHtml(cand.pluginRoot || '.')}">
                <div class="gh-subpath-copy">
                  <div class="gh-subpath-head">
                    <span class="gh-subpath-name">${escapeHtml(cName)}</span>
                    ${cand.version ? `<span class="version-tag">${escapeHtml(formatV(cand.version))}</span>` : ''}
                    <span class="gh-subpath-path">${icon('folder', 11)} ${escapeHtml(cand.pluginRoot || '.')}</span>
                  </div>
                  ${cDesc ? `<div class="gh-subpath-desc">${escapeHtml(cDesc)}</div>` : ''}
                </div>
                <span class="muted">${icon('chevronRight', 14)}</span>
              </button>
            `;
          })
          .join('')}
      </div>
    `;
    footerHtml = `
      <button type="button" class="btn btn-sm" data-action="reset-github-url-modal">${escapeHtml(t('返回修改链接', 'Edit URL'))}</button>
      <button type="button" class="btn btn-sm" data-action="close-modal">${escapeHtml(t('取消', 'Cancel'))}</button>
    `;
  } else if (m.phase === 'preview' || m.phase === 'installing') {
    const isInstalling = m.phase === 'installing';
    const res = m.inspectResult || {};
    const plugin = res.plugin || {};
    const pf = res.preflight || {};
    const esc = normalizeInspectEscalation(res.escalation);
    const catalogMatch = res.catalogMatch || null;
    const allWarnings = [
      ...(Array.isArray(res.warnings) ? res.warnings : []),
      ...(Array.isArray(res.componentWarnings) ? res.componentWarnings : []),
    ]
      .map(formatInspectWarningItem)
      .filter(Boolean);

    const displayName = plugin.displayName || plugin.canonicalName || plugin.id || 'Plugin';
    const canonicalName = plugin.canonicalName || plugin.id || '';
    const scopedName = plugin.scopedName || canonicalName;
    const version = plugin.version || '0.0.0';
    const pluginRoot = plugin.pluginRoot || plugin.repository?.pluginRoot || m.selectedPluginRoot || '.';
    const sha256 = plugin.sha256 || plugin.distribution?.sha256 || '';
    const commitSha = plugin.commitSha || '';
    const gitTag = plugin.gitTag || '';
    const sizeLabel = formatBytesCompact(plugin.sizeBytes);
    const channelLabel = formatInspectChannelLabel(plugin.channelUsed);
    const repoUrl = plugin.repoUrl || plugin.repository?.url || res.repoUrl || '';
    const descText =
      typeof plugin.description === 'object'
        ? plugin.description[loc] || plugin.description.zh || plugin.description.en || ''
        : String(plugin.description || '');
    const capabilities = plugin.capabilities || { badges: [] };
    const rulesTokens = Number(capabilities.rulesEstimatedTokens || 0);

    const isUpdate = pf.action === 'update';
    const conflictItem = pf.conflictItem || pf.conflict || null;
    const hasConflict = pf.action === 'conflict-prompt' || Boolean(conflictItem);
    const isForcedScoped = (pf.action === 'install-scoped' || Boolean(pf.isForeignSelfCollision)) && !hasConflict;
    const canReplace = Boolean(
      pf.canReplace ??
        (Array.isArray(pf.choices) && pf.choices.includes('replace') && conflictItem?.dir !== 'agy-market'),
    );

    const tagCommitLabel =
      gitTag && commitSha
        ? `${gitTag} · ${String(commitSha).slice(0, 12)}`
        : gitTag
          ? gitTag
          : commitSha
            ? `commit · ${String(commitSha).slice(0, 12)}`
            : '';

    let modeSectionHtml = '';
    if (isUpdate) {
      const targetDir = pf.targetDir || pf.existingInstall?.dir || canonicalName;
      const isParked = Boolean(pf.existingInstall?.parkedByMarket || pf.existingInstall?.currentlyParked);
      modeSectionHtml = `
        <div class="gh-notice-box is-info">
          <div class="gh-notice-head">${icon('refresh', 13)} <span>${escapeHtml(t('同源插件原地更新', 'Same-Source Update'))}</span></div>
          <div>${escapeHtml(
            t(
              `本地目录 "${targetDir}" 已安装同源插件${pf.existingInstall?.version ? ` (${formatV(pf.existingInstall.version)})` : ''}，确认后将更新至 ${formatV(version)}${isParked ? '（更新后仍保持停放禁用状态）' : ''}。`,
              `Existing install found in "${targetDir}"${pf.existingInstall?.version ? ` (${formatV(pf.existingInstall.version)})` : ''}. Will update in place to ${formatV(version)}${isParked ? ' (remains parked/disabled)' : ''}.`,
            ),
          )}</div>
        </div>
      `;
    } else if (hasConflict) {
      const conflictDir = conflictItem?.dir || canonicalName;
      const conflictScope = conflictItem?.scope || 'global';
      modeSectionHtml = `
        <div class="gh-notice-box is-warn">
          <div class="gh-notice-head">${icon('alertCircle', 13)} <span>${escapeHtml(t('检测到本地同名插件冲突', 'Local Plugin Name Collision'))}</span></div>
          <div>${escapeHtml(
            t(
              `本机已存在同名插件 "${conflictDir}" (${conflictScope})，默认推荐使用隔离命名共存安装。`,
              `A local plugin "${conflictDir}" (${conflictScope}) already uses this name. Scoped isolation is selected by default.`,
            ),
          )}</div>
        </div>
        <div class="gh-mode-section">
          <div class="gh-mode-label">${escapeHtml(t('安装方式', 'Install Mode'))}</div>
          <div class="gh-mode-list">
            <button type="button" class="gh-mode-option ${m.installMode === 'isolate' ? 'is-selected' : ''}" data-action="select-github-install-mode" data-mode="isolate" ${isInstalling ? 'disabled' : ''}>
              <span class="gh-mode-radio" aria-hidden="true"></span>
              <span class="gh-mode-copy">
                <span class="gh-mode-title">
                  <span>${escapeHtml(t('隔离安装（推荐）', 'Isolated Install (Recommended)'))}</span>
                  <span class="version-tag">${escapeHtml(scopedName)}</span>
                </span>
                <span class="gh-mode-sub">${escapeHtml(t('写入独立目录并重命名清单标识，与现有本地插件安全共存。', 'Installs into a scoped directory so it coexists with the existing local plugin.'))}</span>
              </span>
            </button>
            ${
              canReplace
                ? `<button type="button" class="gh-mode-option ${m.installMode === 'replace' ? 'is-selected' : ''}" data-action="select-github-install-mode" data-mode="replace" ${isInstalling ? 'disabled' : ''}>
                    <span class="gh-mode-radio" aria-hidden="true"></span>
                    <span class="gh-mode-copy">
                      <span class="gh-mode-title">
                        <span>${escapeHtml(t('覆盖替换本地同名插件', 'Replace Existing Local Plugin'))}</span>
                        <span class="version-tag">${escapeHtml(conflictDir)}</span>
                      </span>
                      <span class="gh-mode-sub">${escapeHtml(t('用此仓库内容替换现有全局目录中的插件文件。', 'Replaces the files inside the existing global plugin directory.'))}</span>
                    </span>
                  </button>`
                : ''
            }
          </div>
        </div>
      `;
    } else if (isForcedScoped) {
      modeSectionHtml = `
        <div class="gh-mode-section">
          <div class="gh-mode-label">${escapeHtml(t('安装方式', 'Install Mode'))}</div>
          <div class="gh-mode-list">
            <button type="button" class="gh-mode-option is-selected" data-action="select-github-install-mode" data-mode="isolate" ${isInstalling ? 'disabled' : ''}>
              <span class="gh-mode-radio" aria-hidden="true"></span>
              <span class="gh-mode-copy">
                <span class="gh-mode-title">
                  <span>${escapeHtml(t('隔离安装', 'Isolated Install'))}</span>
                  <span class="version-tag">${escapeHtml(scopedName)}</span>
                </span>
                <span class="gh-mode-sub">${escapeHtml(t('该插件将采用命名空间隔离目录安装，避免与内置或核心插件冲突。', 'Installs into a scoped directory to avoid naming collisions.'))}</span>
              </span>
            </button>
          </div>
        </div>
      `;
    } else {
      modeSectionHtml = `
        <div class="gh-mode-section">
          <div class="gh-mode-label">${escapeHtml(t('安装方式', 'Install Mode'))}</div>
          <div class="gh-mode-list">
            <button type="button" class="gh-mode-option ${m.installMode === 'native' ? 'is-selected' : ''}" data-action="select-github-install-mode" data-mode="native" ${isInstalling ? 'disabled' : ''}>
              <span class="gh-mode-radio" aria-hidden="true"></span>
              <span class="gh-mode-copy">
                <span class="gh-mode-title">
                  <span>${escapeHtml(t('原生安装', 'Native Install'))}</span>
                  <span class="version-tag">${escapeHtml(canonicalName)}</span>
                </span>
                <span class="gh-mode-sub">${escapeHtml(t('未检测到本地同名冲突，按插件原生名称安装。', 'No local collision found. Installs under the plugin canonical name.'))}</span>
              </span>
            </button>
            <button type="button" class="gh-mode-option ${m.installMode === 'isolate' ? 'is-selected' : ''}" data-action="select-github-install-mode" data-mode="isolate" ${isInstalling ? 'disabled' : ''}>
              <span class="gh-mode-radio" aria-hidden="true"></span>
              <span class="gh-mode-copy">
                <span class="gh-mode-title">
                  <span>${escapeHtml(t('隔离安装', 'Isolated Install'))}</span>
                  <span class="version-tag">${escapeHtml(scopedName)}</span>
                </span>
                <span class="gh-mode-sub">${escapeHtml(t('使用 <owner>--<slug> 命名空间目录安装，便于与其他源区分。', 'Installs into an <owner>--<slug> scoped directory.'))}</span>
              </span>
            </button>
          </div>
        </div>
      `;
    }

    const escalationHtml = esc.hasEscalation
      ? `
        <div class="escalation-item">
          <div class="escalation-item-head">
            <span style="display:inline-flex;align-items:center;gap:6px;color:var(--m-warn)">${icon('shieldAlert', 14)} ${escapeHtml(t('本次更新包含新增能力声明', 'Update Adds New Capabilities'))}</span>
          </div>
          ${esc.addedBadges.length ? `<div class="badge-row">${renderBadgesHtml({ badges: esc.addedBadges })}</div>` : ''}
          ${
            esc.addedDomains.length
              ? `<div class="muted" style="font-size:11.2px">${escapeHtml(t('新增远程 MCP 域名', 'New Remote MCP Domains'))}: <span class="mono">${escapeHtml(esc.addedDomains.join(', '))}</span></div>`
              : ''
          }
          ${
            esc.addedHooks.length
              ? `<div class="muted" style="font-size:11.2px">${escapeHtml(t('新增生命周期钩子', 'New Lifecycle Hooks'))}: <span class="mono">${escapeHtml(esc.addedHooks.join(', '))}</span></div>`
              : ''
          }
          <label class="gh-escalate-check">
            <input id="gh-confirm-escalation" type="checkbox" ${m.confirmEscalation ? 'checked' : ''} ${isInstalling ? 'disabled' : ''} />
            <span>${escapeHtml(t('我已了解上述新增能力并确认继续更新', 'I have reviewed the added capabilities and confirm the update'))}</span>
          </label>
        </div>
      `
      : '';

    bodyHtml = `
      <div class="gh-preview-card">
        <div class="gh-preview-head">
          <div class="gh-preview-title-row">
            <span class="gh-preview-name">${escapeHtml(displayName)}</span>
            <span class="version-tag">${escapeHtml(formatV(version))}</span>
          </div>
          <div class="gh-meta-pills">
            ${
              pluginRoot && pluginRoot !== '.'
                ? `<span class="gh-meta-pill">${icon('folder', 11)} ${escapeHtml(
                    plugin.autoDetectedSubpath
                      ? t(`已自动定位子目录: ${pluginRoot}`, `Auto-detected subpath: ${pluginRoot}`)
                      : t(`子目录: ${pluginRoot}`, `Subpath: ${pluginRoot}`),
                  )}</span>`
                : ''
            }
            ${channelLabel ? `<span class="gh-meta-pill is-subtle">${escapeHtml(channelLabel)}</span>` : ''}
            ${plugin.rateLimitedFallback ? `<span class="gh-meta-pill is-subtle">${escapeHtml(t('免 API 限流直拉', 'Zero-API Fallback'))}</span>` : ''}
            ${sizeLabel ? `<span class="gh-meta-pill is-subtle">${escapeHtml(sizeLabel)}</span>` : ''}
          </div>
        </div>

        ${descText ? `<p class="gh-preview-desc">${escapeHtml(descText)}</p>` : ''}

        ${capabilities.badges?.length ? `<div class="badge-row">${renderBadgesHtml(capabilities)}</div>` : ''}

        <div class="gh-meta-grid">
          <span class="muted">ID / Slug</span>
          <span class="mono" style="word-break:break-all">${escapeHtml(plugin.id || canonicalName)}${canonicalName && canonicalName !== plugin.id ? ` (${escapeHtml(canonicalName)})` : ''}</span>
          ${
            tagCommitLabel
              ? `<span class="muted">Ref / Commit</span>
                 <span class="mono">${escapeHtml(tagCommitLabel)}</span>`
              : ''
          }
          ${
            sha256
              ? `<span class="muted">SHA-256</span>
                 <span class="gh-meta-val">
                   <span class="mono" title="${escapeHtml(sha256)}">${escapeHtml(String(sha256).slice(0, 16))}…</span>
                   <button type="button" class="icon-btn btn-sm" data-action="copy-text" data-copy-key="gh-sha" data-copy-val="${escapeHtml(sha256)}" title="${escapeHtml(t('复制完整 SHA-256', 'Copy full SHA-256'))}">
                     ${icon(state.copiedKey === 'gh-sha' ? 'check' : 'copy', 11)}
                   </button>
                 </span>`
              : ''
          }
          ${
            rulesTokens > 0
              ? `<span class="muted">${escapeHtml(t('常驻规则', 'Rules'))}</span>
                 <span class="mono">~${rulesTokens} tokens</span>`
              : ''
          }
          ${
            isSafeHttpUrl(repoUrl)
              ? `<span class="muted">GitHub</span>
                 <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap"><a class="md-link" href="${escapeHtml(repoUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(repoUrl)}</a></span>`
              : ''
          }
        </div>
      </div>

      ${
        catalogMatch
          ? `<div class="gh-notice-box is-info">
              <div class="gh-notice-head">${icon('info', 13)} <span>${escapeHtml(t('该插件已收录于市场目录', 'Listed in Market Catalog'))}</span></div>
              <div>${escapeHtml(
                t(
                  `目录中已存在 ${catalogMatch.id || displayName}${catalogMatch.version ? ` (${formatV(catalogMatch.version)})` : ''}，你可以继续通过当前链接安装，或在探索页使用目录版本。`,
                  `Found ${catalogMatch.id || displayName}${catalogMatch.version ? ` (${formatV(catalogMatch.version)})` : ''} in the catalog. You can still continue installing from this URL or install from Discover.`,
                ),
              )}</div>
            </div>`
          : res.isPublicRepo && res.nomination?.issueUrl && isSafeHttpUrl(res.nomination.issueUrl)
            ? `<div class="gh-notice-box is-nomination" data-agy-nomination-banner="1">
                <div class="gh-notice-head">${icon('sparkle', 13)} <span>${escapeHtml(t('分享此公开插件到 AGY Market？', 'Share this public plugin with AGY Market?'))}</span></div>
                <div>${escapeHtml(
                  t(
                    '该公开插件尚未收录于社区目录。点击下方按钮将打开 GitHub 提名表单（仅预填 owner/repo 与插件子目录，不含任何本机或账号信息）。',
                    'This public plugin is not yet listed in the community catalog. Opens a pre-filled GitHub Issue with only owner/repo and pluginRoot (zero local or account data).',
                  ),
                )}</div>
                <div class="gh-nomination-actions">
                  <a class="btn btn-sm gh-nominate-btn" href="${escapeHtml(res.nomination.issueUrl)}" target="_blank" rel="noopener noreferrer">
                    ${icon('plus', 12)}
                    <span>${escapeHtml(t('分享到社区目录', 'Share to AGY Market'))}</span>
                    ${icon('external', 11)}
                  </a>
                </div>
              </div>`
            : ''
      }

      ${
        allWarnings.length > 0
          ? `<div class="gh-notice-box is-warn">
              <div class="gh-notice-head">${icon('alertCircle', 13)} <span>${escapeHtml(t('静态预检提示', 'Preflight Notes'))}</span></div>
              <ul class="gh-notice-list">
                ${allWarnings.map((w) => `<li>${escapeHtml(w)}</li>`).join('')}
              </ul>
            </div>`
          : ''
      }

      ${modeSectionHtml}
      ${escalationHtml}

      ${
        m.error
          ? `<div class="gh-inline-error" role="alert">${icon('alertTriangle', 14)}<span>${escapeHtml(m.error)}</span></div>`
          : ''
      }

      ${isInstalling ? `<div class="progress-track"><div class="progress-fill"></div></div>` : ''}
    `;

    const hasSubpathList = Array.isArray(m.subpathCandidates) && m.subpathCandidates.length > 1;
    const submitDisabled = isInstalling || isUpdateActionLocked() || (esc.hasEscalation && !m.confirmEscalation);
    footerHtml = `
      ${
        hasSubpathList
          ? `<button type="button" class="btn btn-sm" data-action="back-github-subpaths" ${isInstalling ? 'disabled' : ''}>${icon('folder', 12)} ${escapeHtml(t('切换子目录', 'Subpaths'))}</button>`
          : ''
      }
      <button type="button" class="btn btn-sm" data-action="reset-github-url-modal" ${isInstalling ? 'disabled' : ''}>${escapeHtml(t('返回修改链接', 'Edit URL'))}</button>
      <button type="button" class="btn btn-primary btn-sm" data-action="install-github-url"${submitDisabled ? ' disabled aria-disabled="true"' : ''}>
        ${icon(isInstalling ? 'refresh' : isUpdate ? 'update' : 'download', 12, isInstalling ? 'spin' : '')}
        <span>${escapeHtml(
          isInstalling
            ? t(isUpdate ? '更新中…' : '安装中…', isUpdate ? 'Updating…' : 'Installing…')
            : isUpdate
              ? t('确认更新', 'Confirm Update')
              : t('确认安装', 'Confirm Install'),
        )}</span>
      </button>
    `;
  } else if (m.phase === 'unsupported') {
    const res = m.inspectResult || {};
    const isSecurity = res.status === 'SECURITY_BLOCKED' || res.status === 'UNSAFE_ARCHIVE';
    const reason =
      (loc === 'en' ? res.reasonEn || res.reasonZh : res.reasonZh || res.reasonEn) ||
      res.error ||
      t(
        '该仓库未包含有效的 Antigravity plugin.json 清单或未通过本地安全检查，无法直接安装。',
        'This repository does not contain a valid Antigravity plugin.json or failed local safety checks.',
      );
    const rawHints = loc === 'en' ? res.hintsEn ?? res.hintsZh : res.hintsZh ?? res.hintsEn;
    const hints = Array.isArray(rawHints) ? rawHints.filter(Boolean) : rawHints ? [String(rawHints)] : [];
    const fileOverview = Array.isArray(res.fileOverview) ? res.fileOverview.filter(Boolean) : [];
    const repoUrl = res.repoUrl || (isSafeHttpUrl(m.url) ? m.url : '');

    bodyHtml = `
      <div class="gh-unsupported-box ${isSecurity ? 'is-security' : ''}">
        <div class="gh-unsupported-head">
          ${icon(isSecurity ? 'shieldAlert' : 'alertTriangle', 15)}
          <span>${escapeHtml(
            isSecurity
              ? t('本地安全检查未通过，已拦截安装', 'Blocked by Local Safety Check')
              : t('暂不支持作为原生插件直接安装', 'Cannot Install as Native Plugin'),
          )}</span>
          ${res.reasonCode ? `<span class="gh-reason-code">${escapeHtml(res.reasonCode)}</span>` : ''}
        </div>
        <p class="gh-unsupported-reason">${escapeHtml(reason)}</p>
        ${
          hints.length > 0
            ? `<ul class="gh-hints-list">${hints.map((h) => `<li>${escapeHtml(h)}</li>`).join('')}</ul>`
            : ''
        }
        ${
          fileOverview.length > 0
            ? `<div class="gh-file-chips-wrap">
                <div class="gh-file-chips-label">${escapeHtml(t('仓库顶层文件概览', 'Repository File Overview'))}</div>
                <div class="gh-file-chips">
                  ${fileOverview.map((f) => `<span class="gh-file-chip">${escapeHtml(f)}</span>`).join('')}
                </div>
              </div>`
            : ''
        }
      </div>
    `;
    footerHtml = `
      ${
        isSafeHttpUrl(repoUrl)
          ? `<a class="btn btn-sm" href="${escapeHtml(repoUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(t('在 GitHub 查看仓库', 'View on GitHub'))} ${icon('arrowUpRight', 12)}</a>`
          : ''
      }
      <button type="button" class="btn btn-primary btn-sm" data-action="reset-github-url-modal">${escapeHtml(t('换一个链接', 'Try Another URL'))}</button>
      <button type="button" class="btn btn-sm" data-action="close-modal">${escapeHtml(t('关闭', 'Close'))}</button>
    `;
  }

  return `
    <div class="modal-backdrop" ${isBusyPhase ? '' : 'data-action="close-modal"'}>
      <div class="modal-box gh-url-modal" role="dialog" aria-modal="true" aria-label="${escapeHtml(t('通过 GitHub 链接添加插件', 'Add Plugin via GitHub URL'))}" onclick="event.stopPropagation()">
        <div class="modal-header">
          <div class="modal-title-wrap">
            ${icon('link', 15)}
            <span>${escapeHtml(t('通过 GitHub 链接添加插件', 'Add Plugin via GitHub URL'))}</span>
          </div>
          <button type="button" class="icon-btn is-square" data-action="close-modal" ${isBusyPhase ? 'disabled' : ''} title="${escapeHtml(t('关闭 (Esc)', 'Close (Esc)'))}">${icon('close', 14)}</button>
        </div>
        <div class="modal-body">
          ${bodyHtml}
        </div>
        <div class="modal-footer">
          ${footerHtml}
        </div>
      </div>
    </div>
  `;
}

function renderModals() {
  let html = '';
  const updateActionLocked = isUpdateActionLocked();
  const lockAttr = updateActionLocked ? ' disabled aria-disabled="true"' : '';

  if (state.detailPlugin) {
    html += renderDetailDrawer();
  }

  if (state.removeConfirmModal) {
    const rm = state.removeConfirmModal;
    const isRemoving = Boolean(state.removingDir && state.removingDir === rm.dir);
    const uninstallLocked =
      isRemoving ||
      isUpdateCheckBusy() ||
      Boolean(
        state.busyId ||
          state.batchUpdating ||
          state.selfUpdateBusy ||
          state.removingDir ||
          (state.githubUrlModal && state.githubUrlModal.phase === 'installing'),
      );
    html += `
      <div class="modal-backdrop" ${isRemoving ? '' : 'data-action="close-modal"'}>
        <div class="modal-box" role="dialog" aria-modal="true" aria-label="${escapeHtml(t('确认卸载插件', 'Confirm Uninstall Plugin'))}" onclick="event.stopPropagation()">
          <div class="modal-header">
            <div class="modal-title-wrap">
              <span style="color:var(--m-danger)">${icon('trash', 15)}</span>
              <span>${escapeHtml(t('确认卸载插件', 'Confirm Uninstall Plugin'))}</span>
            </div>
            <button type="button" class="icon-btn is-square" data-action="close-modal" ${isRemoving ? 'disabled' : ''}>${icon('close', 14)}</button>
          </div>
          <div class="modal-body">
            <p style="margin:0;line-height:1.58">${escapeHtml(
              t(
                `即将永久卸载本地插件目录 "${rm.dir}"（${rm.displayName}${rm.version ? ` ${formatV(rm.version)}` : ''}）及其停放仓文件。若仅需暂时关闭，建议直接使用卡片底部的「启用 / 禁用」停放仓滑块。`,
                `This permanently uninstalls "${rm.dir}" (${rm.displayName}${rm.version ? ` ${formatV(rm.version)}` : ''}) from local plugins and parked storage. To temporarily pause a plugin without uninstalling it, use the Enable/Disable toggle slider instead.`,
              ),
            )}</p>
            ${
              rm.isFavorited
                ? `<label class="uninstall-fav-check">
                    <input id="uninstall-remove-favorite" type="checkbox" ${rm.removeFavorite ? 'checked' : ''} ${isRemoving ? 'disabled' : ''} />
                    <span>${escapeHtml(t('同时从收藏夹移除', 'Also remove from Favorites'))}</span>
                  </label>`
                : ''
            }
          </div>
          <div class="modal-footer">
            <button type="button" class="btn btn-sm" data-action="close-modal" ${isRemoving ? 'disabled' : ''}>${escapeHtml(t('取消', 'Cancel'))}</button>
            <button type="button" class="btn btn-danger-solid btn-sm" data-action="confirm-uninstall" data-dir="${escapeHtml(rm.dir)}"${uninstallLocked ? ' disabled aria-disabled="true"' : ''}>
              ${icon(isRemoving ? 'refresh' : 'trash', 12, isRemoving ? 'spin' : '')}
              ${escapeHtml(isRemoving ? t('卸载中…', 'Uninstalling…') : t('确认卸载', 'Uninstall'))}
            </button>
          </div>
        </div>
      </div>
    `;
  }

  if (state.selfChangelogModal && state.updates.selfUpdate) {
    const su = state.updates.selfUpdate;
    const selfLoc = getGlobalInstalledByDirMap().get('agy-market') || null;
    const selfFromV = selfLoc?.version || state.serverState?.plugin?.version || su.installedVersion || '?';
    const selfToV = su.latestVersion || '?';
    const selfFromClean = stripV(selfFromV);
    const selfToClean = stripV(selfToV);
    if (
      selfFromClean &&
      selfToClean &&
      selfFromClean !== '?' &&
      selfToClean !== '?' &&
      isNewerVersion(selfToClean, selfFromClean)
    ) {
      html += `
      <div class="modal-backdrop" data-action="close-modal">
        <div class="modal-box" onclick="event.stopPropagation()">
          <div class="modal-header">
            <div class="modal-title-wrap">
              ${icon('sparkle', 15)}
              <span>${escapeHtml(t('AGY Market 新版本更新日志', 'AGY Market Release Notes'))}</span>
              <span class="version-delta">${escapeHtml(formatV(selfFromV))} → ${escapeHtml(formatV(selfToV))}</span>
            </div>
            <button type="button" class="icon-btn is-square" data-action="close-modal">${icon('close', 14)}</button>
          </div>
          <div class="modal-body md-body">
            ${renderSafeMarkdown(su.changelog, t('暂无更新日志详情。', 'No changelog provided.'))}
          </div>
          <div class="modal-footer">
            ${su.releaseUrl ? `<a class="btn btn-sm" href="${escapeHtml(su.releaseUrl)}" target="_blank" rel="noopener noreferrer">GitHub Release ${icon('external', 11)}</a>` : ''}
            <button type="button" class="btn btn-sm" data-action="close-modal">${escapeHtml(t('关闭', 'Close'))}</button>
            <button type="button" class="btn btn-primary btn-sm" data-action="self-update" data-update-channel="${escapeHtml(su.updateChannel || '')}" data-target-version="${escapeHtml(su.latestVersion || '')}" data-target-ref="${escapeHtml(su.targetRef || '')}"${lockAttr}>${icon(state.selfUpdateBusy ? 'refresh' : 'update', 12, state.selfUpdateBusy ? 'spin' : '')} ${escapeHtml(state.selfUpdateBusy ? t('正在更新…', 'Updating…') : t('立即更新市场', 'Update Market'))}</button>
          </div>
        </div>
      </div>
    `;
    }
  }

  if (state.githubUrlModal) {
    html += renderGithubUrlModal();
  }

  if (state.conflictModal) {
    const cm = state.conflictModal;
    html += `
      <div class="modal-backdrop" data-action="close-modal">
        <div class="modal-box" onclick="event.stopPropagation()">
          <div class="modal-header">
            <div class="modal-title-wrap">
              <span style="color:var(--m-warn)">${icon('alertCircle', 16)}</span>
              <span>${escapeHtml(t('检测到本地同名插件冲突', 'Local Plugin Name Collision Detected'))}</span>
            </div>
            <button type="button" class="icon-btn is-square" data-action="close-modal">${icon('close', 14)}</button>
          </div>
          <div class="modal-body">
            <p style="margin:0">${escapeHtml(t(`本地已存在来自其他来源的插件 "${cm.conflict.dir}" (${cm.conflict.scope})。Antigravity 对同名插件会忽略后者，请选择安装方式：`, `A local plugin "${cm.conflict.dir}" (${cm.conflict.scope}) already claims this identifier. Choose how to proceed:`))}</p>
          </div>
          <div class="modal-footer">
            <button type="button" class="btn btn-sm" data-action="close-modal">${escapeHtml(t('取消', 'Cancel'))}</button>
            ${
              cm.choices.includes('replace')
                ? `<button type="button" class="btn btn-sm" data-action="resolve-conflict" data-strategy="replace"${lockAttr}>${escapeHtml(t('覆盖替换本地同名插件', 'Replace Existing'))}</button>`
                : ''
            }
            <button type="button" class="btn btn-primary btn-sm" data-action="resolve-conflict" data-strategy="isolate"${lockAttr}>
              ${escapeHtml(t(`隔离安装为 ${cm.scopedFallbackName}`, `Install Isolated as ${cm.scopedFallbackName}`))}
            </button>
          </div>
        </div>
      </div>
    `;
  }

  if (state.escalationModal) {
    const em = state.escalationModal;
    const isBatch = em.mode === 'batch' && em.items.length > 1;
    html += `
      <div class="modal-backdrop" data-action="close-modal">
        <div class="modal-box" onclick="event.stopPropagation()">
          <div class="modal-header">
            <div class="modal-title-wrap">
              <span style="color:var(--m-warn)">${icon('shieldAlert', 16)}</span>
              <span>${escapeHtml(isBatch ? t(`以下 ${em.items.length} 个插件更新包含新增能力`, `${em.items.length} Updates Add New Capabilities`) : t('版本更新包含新增能力声明', 'Update Adds New Capabilities'))}</span>
            </div>
            <button type="button" class="icon-btn is-square" data-action="close-modal">${icon('close', 14)}</button>
          </div>
          <div class="modal-body">
            <p class="muted" style="margin:0">${escapeHtml(t('确认授权后将立即继续安装并更新本地能力凭证：', 'Confirm to proceed with installation and record the newly granted capabilities:'))}</p>
            ${em.items
              .map((item) => {
                const isCommitEscalation = Boolean(item.updateKind === 'commit' && item.latestCommitSha);
                const versionDeltaText = isCommitEscalation
                  ? `${formatV(item.installedVersion)} (${item.installedCommitSha || 'HEAD'} → ${item.latestCommitSha})`
                  : `${formatV(item.installedVersion)} → ${formatV(item.targetVersion)}`;
                return `
                <div class="escalation-item">
                  <div class="escalation-item-head">
                    <span>${escapeHtml(item.displayName)}</span>
                    <span class="version-delta">${escapeHtml(versionDeltaText)}</span>
                  </div>
                  ${item.escalation?.addedBadges?.length ? `<div class="badge-row">${renderBadgesHtml({ badges: item.escalation.addedBadges })}</div>` : ''}
                  ${
                    item.escalation?.addedRemoteDomains?.length
                      ? `<div class="muted" style="font-size:11.2px">${escapeHtml(t('新增远程 MCP 域名', 'New Remote MCP Domains'))}: <span class="mono">${escapeHtml(item.escalation.addedRemoteDomains.join(', '))}</span></div>`
                      : ''
                  }
                  ${
                    item.escalation?.addedHookEvents?.length
                      ? `<div class="muted" style="font-size:11.2px">${escapeHtml(t('新增生命周期钩子', 'New Lifecycle Hooks'))}: <span class="mono">${escapeHtml(item.escalation.addedHookEvents.join(', '))}</span></div>`
                      : ''
                  }
                </div>
              `;
              })
              .join('')}
          </div>
          <div class="modal-footer">
            <button type="button" class="btn btn-sm" data-action="close-modal">${escapeHtml(t('暂不更新', 'Cancel'))}</button>
            <button type="button" class="btn btn-primary btn-sm" data-action="confirm-escalation"${lockAttr}>
              ${icon('check', 12)} ${escapeHtml(isBatch ? t('全部确认并继续更新', 'Confirm & Update All') : t('确认并立即更新', 'Confirm & Update'))}
            </button>
          </div>
        </div>
      </div>
    `;
  }

  if (state.reconnecting) {
    const rc = state.reconnecting;
    html += `
      <div class="modal-backdrop">
        <div class="modal-box reconnect-card">
          <div class="reconnect-orb">${icon('refresh', 22, rc.timedOut ? '' : 'spin')}</div>
          <div style="font-weight:700;font-size:14.5px">${escapeHtml(
            rc.timedOut
              ? t('等待服务恢复超时', 'Reconnect timed out')
              : t('正在重启 AGY Market 服务…', 'Restarting AGY Market…'),
          )}</div>
          <div class="muted" style="font-size:12px;line-height:1.5">${escapeHtml(
            rc.timedOut
              ? t('新版本文件已同步，你可以手动重试连接或刷新面板。', 'Files were synced. Retry health check or reload this pane.')
              : t(
                  `正在应用${rc.targetVersion ? ` ${formatV(rc.targetVersion)}` : '新版本'}并轮询 /healthz（第 ${rc.attempts} 次探测）…`,
                  `Applying${rc.targetVersion ? ` ${formatV(rc.targetVersion)}` : ' update'} and polling /healthz (attempt ${rc.attempts})…`,
                ),
          )}</div>
          ${!rc.timedOut ? `<div class="progress-track"><div class="progress-fill"></div></div>` : ''}
          ${
            rc.timedOut
              ? `<div style="display:flex;gap:8px;margin-top:4px">
                  <button type="button" class="btn btn-primary btn-sm" data-action="retry-reconnect">${icon('refresh', 12)} ${escapeHtml(t('重试连接', 'Retry'))}</button>
                  <button type="button" class="btn btn-sm" data-action="reload-page">${escapeHtml(t('刷新面板', 'Reload Pane'))}</button>
                </div>`
              : ''
          }
        </div>
      </div>
    `;
  }

  return html;
}

// ==========================================================================
// Main Render Loop (Preserves Focus & Scroll Offsets)
// ==========================================================================

function render() {
  const root = document.getElementById('app');
  if (!root) return;

  const focusId = document.activeElement?.id || '';
  const selStart = document.activeElement?.selectionStart ?? null;
  const selEnd = document.activeElement?.selectionEnd ?? null;
  const prevMainScroll = root.querySelector('.main-scroll')?.scrollTop ?? 0;
  const prevDrawerScroll = root.querySelector('#market-drawer-body')?.scrollTop ?? 0;

  const catalogCount = state.serverState?.catalog?.plugins?.length || 0;
  const favCount = resolveFavoriteEntries().length;
  const installedCount = state.serverState?.installed?.length || 0;
  const updatesCount = getEffectiveUpdateItems().length;
  const conflictSummary = getConflictsSummary();
  const curLocale = getLocale();
  const channelLabel = state.serverState?.catalog?.channelUsed || '';
  const clientVer = state.serverState?.plugin?.version || PLUGIN_VERSION;
  const showSelfOffer = isSelfBannerVisible();
  const hasDismissedSelfUpdate = Boolean(
    state.updates.selfUpdate &&
      !showSelfOffer &&
      (() => {
        const selfLoc = getGlobalInstalledByDirMap().get('agy-market') || null;
        const fromV = stripV(selfLoc?.version || state.serverState?.plugin?.version || state.updates.selfUpdate.installedVersion || '');
        const toV = stripV(state.updates.selfUpdate.latestVersion || '');
        return Boolean(fromV && toV && fromV !== '?' && toV !== '?' && isNewerVersion(toV, fromV));
      })(),
  );
  const showInstalledDot = updatesCount > 0 || showSelfOffer;

  const conflictBadgeHtml =
    conflictSummary.total > 0
      ? `<span class="nav-conflict-badge ${conflictSummary.critical > 0 ? 'is-critical' : 'is-warn'}" title="${escapeHtml(t(`发现 ${conflictSummary.total} 项冲突或建议`, `${conflictSummary.total} conflict(s) detected`))}">${conflictSummary.total}</span>`
      : `<span class="nav-conflict-badge is-healthy" title="${escapeHtml(t('无冲突', '0 conflicts'))}">✓</span>`;

  let viewHtml = '';
  if (state.activeTab === 'discover') viewHtml = renderDiscoverView();
  else if (state.activeTab === 'favorites') viewHtml = renderFavoritesView();
  else if (state.activeTab === 'installed') viewHtml = renderInstalledView();
  else if (state.activeTab === 'conflicts') viewHtml = renderConflictsView();
  else viewHtml = renderSourcesView();

  const toastTone = state.toast?.tone || 'info';
  const isToastErr = toastTone === 'danger' || toastTone === 'error' || toastTone === 'err';
  const toastIco = isToastErr
    ? icon('alertTriangle', 14, 'toast-lead-ico')
    : toastTone === 'ok'
      ? icon('checkCircle', 14, 'toast-lead-ico')
      : toastTone === 'warn'
        ? icon('alertCircle', 14, 'toast-lead-ico')
        : icon('info', 14, 'toast-lead-ico');

  root.innerHTML = `
    <div class="market-shell" data-stuck="${state.scrolledStuck ? 'true' : 'false'}">
      <header class="app-header">
        <div class="brand-group">
          <div class="brand-mark">${BRAND_LOGO_SVG}</div>
          <div class="brand-copy">
            <span class="brand-title">AGY Market</span>
            <span class="brand-meta-pill" title="${escapeHtml(channelLabel ? `${t('目录通道', 'Channel')}: ${channelLabel}` : t('Sidebar 侧边栏', 'Sidebar Panel'))}">
              <span class="status-dot ${state.updates.rateLimited ? 'is-warn' : state.updates.loading ? 'is-pulse' : ''}"></span>
              <span>${escapeHtml(formatV(clientVer))}</span>
            </span>
          </div>
        </div>

        <nav class="segmented-nav" role="tablist" aria-label="${escapeHtml(t('主导航', 'Main navigation'))}">
          <button type="button" class="nav-pill ${state.activeTab === 'discover' ? 'active' : ''}" data-action="tab" data-tab="discover" role="tab" aria-selected="${state.activeTab === 'discover'}">
            ${icon('compass', 13)}
            <span>${escapeHtml(t('探索', 'Discover'))}</span>
            <span class="nav-count">${catalogCount}</span>
          </button>
          <button type="button" class="nav-pill ${state.activeTab === 'favorites' ? 'active' : ''}" data-action="tab" data-tab="favorites" role="tab" aria-selected="${state.activeTab === 'favorites'}">
            ${icon(favCount > 0 ? 'starFilled' : 'star', 13, favCount > 0 ? 'fav-nav-ico' : '')}
            <span>${escapeHtml(t('收藏', 'Favorites'))}</span>
            <span class="nav-count ${favCount > 0 ? 'is-fav' : ''}">${favCount}</span>
          </button>
          <button type="button" class="nav-pill ${state.activeTab === 'installed' ? 'active' : ''}" data-action="tab" data-tab="installed" role="tab" aria-selected="${state.activeTab === 'installed'}">
            ${icon('package', 13)}
            <span>${escapeHtml(t('已安装', 'Installed'))}</span>
            <span class="nav-count">${installedCount}</span>
            ${updatesCount > 0 ? `<span class="nav-update-badge" title="${escapeHtml(t(`${updatesCount} 个可用更新`, `${updatesCount} updates available`))}">↑${updatesCount}</span>` : ''}
            ${showInstalledDot ? '<span class="tab-red-dot" aria-hidden="true"></span>' : ''}
          </button>
          <button type="button" class="nav-pill ${state.activeTab === 'conflicts' ? 'active' : ''}" data-action="tab" data-tab="conflicts" role="tab" aria-selected="${state.activeTab === 'conflicts'}">
            ${icon(conflictSummary.total > 0 ? 'shieldAlert' : 'shieldCheck', 13)}
            <span>${escapeHtml(t('冲突与诊断', 'Conflicts'))}</span>
            ${conflictBadgeHtml}
          </button>
          <button type="button" class="nav-pill ${state.activeTab === 'sources' ? 'active' : ''}" data-action="tab" data-tab="sources" role="tab" aria-selected="${state.activeTab === 'sources'}">
            ${icon('sliders', 13)}
            <span>${escapeHtml(t('源与设置', 'Sources'))}</span>
          </button>
        </nav>

        <div class="header-actions">
          <button
            type="button"
            class="add-url-btn"
            data-action="open-github-url-modal"
            title="${escapeHtml(t('粘贴任意 GitHub 插件仓库链接进行预检与安装', 'Inspect and install a plugin from any GitHub URL'))}"
          >
            ${icon('link', 12)}
            <span>${escapeHtml(t('链接添加', 'Add URL'))}</span>
          </button>
          <a
            class="submit-plugin-btn"
            href="${escapeHtml(SUBMIT_PLUGIN_GUIDE_URL)}"
            target="_blank"
            rel="noopener noreferrer"
            title="${escapeHtml(t('查看社区插件投稿与自动收录指南', 'Read the plugin submission & auto-listing guide'))}"
          >
            ${icon('plus', 12)}
            <span>${escapeHtml(t('申请收录插件', 'Submit Plugin'))}</span>
          </a>
          ${
            hasDismissedSelfUpdate
              ? `<button type="button" class="icon-btn has-alert" data-action="restore-self-banner" title="${escapeHtml(t('AGY Market 有新版本可用', 'AGY Market update available'))}">${icon('sparkle', 13)} <span>${escapeHtml(formatV(state.updates.selfUpdate.latestVersion))}</span></button>`
              : ''
          }
          <button type="button" class="icon-btn" data-action="toggle-locale" title="${escapeHtml(t('切换界面语言与中文文档', 'Switch Language'))}">${curLocale === 'en' ? '中' : 'EN'}</button>
          <button type="button" class="icon-btn is-square" data-action="refresh"${isUpdateActionLocked() ? ' disabled aria-disabled="true"' : ''} title="${escapeHtml(t('刷新目录、更新与冲突检查', 'Refresh catalog, updates & conflicts'))}">
            ${icon('refresh', 13, state.loading || state.updates.loading ? 'spin' : '')}
          </button>
        </div>
      </header>

      ${renderErrorAlertBanner()}
      ${renderSelfUpdateBanner()}
      ${renderRestartBanner()}
      ${renderNominationBanner()}

      ${viewHtml}

      ${renderModals()}

      ${
        state.toast
          ? `<div class="toast-bar tone-${escapeHtml(toastTone)}" role="${isToastErr ? 'alert' : 'status'}">
              <div class="toast-copy">
                <span class="toast-lead-row">${toastIco}<span>${escapeHtml(state.toast.message)}</span></span>
                ${state.toast.subtext ? `<span class="toast-sub">${escapeHtml(state.toast.subtext)}</span>` : ''}
              </div>
              <div class="toast-actions">
                <button type="button" class="icon-btn is-square" data-action="dismiss-toast" title="${escapeHtml(t('关闭', 'Dismiss'))}">${icon('close', 12)}</button>
              </div>
            </div>`
          : ''
      }
    </div>
  `;

  bindDomEvents(root);

  const mainScrollEl = root.querySelector('.main-scroll');
  if (mainScrollEl) {
    if (prevMainScroll > 0) mainScrollEl.scrollTop = prevMainScroll;
    mainScrollEl.addEventListener(
      'scroll',
      () => {
        const stuck = mainScrollEl.scrollTop > 4;
        if (stuck !== state.scrolledStuck) {
          state.scrolledStuck = stuck;
          const shell = root.querySelector('.market-shell');
          if (shell) shell.setAttribute('data-stuck', stuck ? 'true' : 'false');
        }
      },
      { passive: true },
    );
  }
  const drawerScrollEl = root.querySelector('#market-drawer-body');
  if (drawerScrollEl && prevDrawerScroll > 0) drawerScrollEl.scrollTop = prevDrawerScroll;

  if (state.focusGithubUrlInput) {
    state.focusGithubUrlInput = false;
    const urlEl = document.getElementById('github-url-input');
    if (urlEl) {
      urlEl.focus();
      if (urlEl.value && typeof urlEl.select === 'function') {
        try {
          urlEl.select();
        } catch {
          /* ignore */
        }
      }
    }
  } else if (state.focusTokenField) {
    state.focusTokenField = false;
    const tokEl = document.getElementById('github-token-input');
    if (tokEl) tokEl.focus();
  } else if (focusId) {
    const el = document.getElementById(focusId);
    if (el) {
      el.focus();
      if (selStart !== null && typeof el.setSelectionRange === 'function') {
        try {
          el.setSelectionRange(selStart, selEnd);
        } catch {
          /* ignore */
        }
      }
    }
  }
}

// ==========================================================================
// Event Binding & Pointer-Tracking Spotlight
// ==========================================================================

function bindDomEvents(root) {
  // Pointer-tracking optical spotlight on plugin cards (zero DOM re-renders!)
  const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
  if (!reducedMotion) {
    root.querySelectorAll('.cards-grid').forEach((grid) => {
      grid.addEventListener(
        'pointermove',
        (e) => {
          const card = e.target?.closest?.('.plugin-card');
          if (!card) return;
          const rect = card.getBoundingClientRect();
          card.style.setProperty('--mx', `${Math.round(e.clientX - rect.left)}px`);
          card.style.setProperty('--my', `${Math.round(e.clientY - rect.top)}px`);
        },
        { passive: true },
      );
    });
  }

  // Stop propagation on direct external title links & dock controls inside clickable card headers
  root.querySelectorAll('[data-stop-card]').forEach((el) => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
    });
  });

  const searchEl = root.querySelector('#market-search-input');
  if (searchEl) {
    searchEl.addEventListener('input', (e) => {
      state.search = e.target.value;
      render();
    });
  }

  const ghUrlEl = root.querySelector('#github-url-input');
  if (ghUrlEl) {
    ghUrlEl.addEventListener('input', (e) => {
      if (!state.githubUrlModal) return;
      const val = e.target.value;
      const hadError = Boolean(state.githubUrlModal.error);
      state.githubUrlModal.url = val;
      if (hadError) {
        state.githubUrlModal.error = '';
        render();
        return;
      }
      const submitBtn = root.querySelector('#gh-inspect-submit-btn');
      if (submitBtn) {
        submitBtn.disabled = !String(val || '').trim();
      }
    });
    ghUrlEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        if (state.githubUrlModal?.phase === 'input') {
          void triggerGithubUrlInspect({ url: e.target.value });
        }
      }
    });
  }

  const ghEscCheckEl = root.querySelector('#gh-confirm-escalation');
  if (ghEscCheckEl) {
    ghEscCheckEl.addEventListener('change', (e) => {
      if (!state.githubUrlModal) return;
      state.githubUrlModal.confirmEscalation = Boolean(e.target.checked);
      if (state.githubUrlModal.confirmEscalation) {
        state.githubUrlModal.error = '';
      }
      render();
    });
  }

  const uninstallFavCheckEl = root.querySelector('#uninstall-remove-favorite');
  if (uninstallFavCheckEl) {
    uninstallFavCheckEl.addEventListener('change', (e) => {
      if (!state.removeConfirmModal) return;
      state.removeConfirmModal.removeFavorite = Boolean(e.target.checked);
    });
  }

  const favSearchEl = root.querySelector('#favorites-search-input');
  if (favSearchEl) {
    favSearchEl.addEventListener('input', (e) => {
      state.favoritesSearch = e.target.value;
      render();
    });
  }

  const favSortEl = root.querySelector('#favorites-sort-select');
  if (favSortEl) {
    favSortEl.addEventListener('change', (e) => {
      state.favoritesSortBy = e.target.value;
      render();
    });
  }

  const instSearchEl = root.querySelector('#installed-search-input');
  if (instSearchEl) {
    instSearchEl.addEventListener('input', (e) => {
      state.installedSearch = e.target.value;
      render();
    });
  }

  const sortEl = root.querySelector('#market-sort-select');
  if (sortEl) {
    sortEl.addEventListener('change', (e) => {
      state.sortBy = e.target.value;
      render();
    });
  }

  const track2El = root.querySelector('#track2-checkbox');
  if (track2El) {
    track2El.addEventListener('change', (e) => {
      if (isUpdateActionLocked()) {
        e.target.checked = Boolean(state.serverState?.prefs?.enableExperimentalTrack2);
        return;
      }
      void updatePrefs({ enableExperimentalTrack2: Boolean(e.target.checked) });
    });
  }

  const sourcesForm = root.querySelector('#sources-form');
  if (sourcesForm) {
    sourcesForm.addEventListener('submit', (e) => {
      e.preventDefault();
      if (isUpdateActionLocked()) return;
      const networkMode = root.querySelector('#net-mode-select')?.value || 'auto';
      const githubReleaseMirrorPrefix = root.querySelector('#mirror-prefix-input')?.value?.trim() || '';
      const primaryCatalogUrl = root.querySelector('#primary-url-input')?.value?.trim() || '';
      const rawCustom = root.querySelector('#custom-feeds-textarea')?.value || '';
      const customFeeds = rawCustom
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean);
      const patch = { networkMode, githubReleaseMirrorPrefix, primaryCatalogUrl, customFeeds };
      const tokenVal = root.querySelector('#github-token-input')?.value?.trim() || '';
      if (tokenVal) {
        patch.githubToken = tokenVal;
      }
      void updatePrefs(patch);
    });
  }

  root.querySelectorAll('[data-action]').forEach((el) => {
    el.addEventListener('click', (e) => {
      if (el.disabled || el.getAttribute('aria-disabled') === 'true') return;
      const action = el.getAttribute('data-action');

      if (action === 'tab') {
        const nextTab = el.getAttribute('data-tab') || 'discover';
        const changed = nextTab !== state.activeTab;
        state.activeTab = nextTab;
        if (changed) state.scrolledStuck = false;
        render();
        if (nextTab === 'installed' && Date.now() - lastForcedUpdatesAt > 10_000 && !isUpdateActionLocked()) {
          void checkUpdates(true, { silent: true });
        } else if (nextTab === 'conflicts' && !state.conflicts.loading) {
          void loadConflicts({ silent: true });
        }
      } else if (action === 'toggle-hero') {
        state.heroCollapsed = !state.heroCollapsed;
        writeStorage(HERO_COLLAPSED_KEY, state.heroCollapsed ? '1' : '0');
        render();
      } else if (action === 'toggle-favs-shelf') {
        state.favoritesShelfCollapsed = !state.favoritesShelfCollapsed;
        writeStorage(FAVS_SHELF_COLLAPSED_KEY, state.favoritesShelfCollapsed ? '1' : '0');
        render();
      } else if (action === 'toggle-favorite') {
        e.stopPropagation();
        const key = el.getAttribute('data-fav-key') || '';
        const name = el.getAttribute('data-fav-name') || '';
        if (key) void toggleFavorite(key, name);
      } else if (action === 'clear-favorites-search') {
        state.favoritesSearch = '';
        render();
      } else if (action === 'installed-filter') {
        state.installedFilter = el.getAttribute('data-filter') || 'all';
        render();
      } else if (action === 'clear-installed-search') {
        state.installedSearch = '';
        render();
      } else if (action === 'reset-installed-filters') {
        state.installedSearch = '';
        state.installedFilter = 'all';
        render();
      } else if (action === 'category') {
        e.stopPropagation();
        state.category = el.getAttribute('data-category') || 'all';
        if (state.activeTab !== 'discover') {
          state.activeTab = 'discover';
        }
        render();
      } else if (action === 'clear-search') {
        state.search = '';
        render();
      } else if (action === 'reset-filters') {
        state.search = '';
        state.category = 'all';
        render();
      } else if (action === 'refresh') {
        if (isUpdateActionLocked()) return;
        void Promise.all([
          loadState(true),
          checkUpdates(true, { silent: false }),
          state.activeTab === 'conflicts' || state.conflicts.loaded ? loadConflicts({ silent: true }) : Promise.resolve(),
        ]);
      } else if (action === 'refresh-conflicts') {
        void loadConflicts({ silent: false });
      } else if (action === 'fix-conflict') {
        e.stopPropagation();
        const type = el.getAttribute('data-fix-type') || '';
        const targetDir = el.getAttribute('data-target-dir') || '';
        const suggestedDir = el.getAttribute('data-suggested-dir') || '';
        if (type && targetDir) {
          void triggerFixConflict({ type, targetDir, suggestedDir });
        }
      } else if (action === 'toggle-plugin') {
        e.stopPropagation();
        const dir = el.getAttribute('data-dir') || '';
        const nextEnabled = el.getAttribute('data-next-enabled') === '1';
        if (dir && !el.disabled) {
          void triggerTogglePlugin(dir, nextEnabled);
        }
      } else if (action === 'open-pane') {
        e.stopPropagation();
        const dir = el.getAttribute('data-dir') || '';
        const folder = el.getAttribute('data-folder') || '';
        const viewPath = el.getAttribute('data-path') || '/';
        const title = el.getAttribute('data-title') || dir;
        const uri = el.getAttribute('data-uri') || '';
        if (dir) {
          void openSiblingSidecarPane({ dir, folder, viewPath, title, uri });
        }
      } else if (action === 'open-uri-pane') {
        e.stopPropagation();
        const uri = el.getAttribute('data-uri') || '';
        const label = el.getAttribute('data-label') || uri;
        const m = /^sidecar:\/\/([^/?#]+)\/([^/?#]+)((?:[/?#].*)?)$/i.exec(uri);
        if (m) {
          const normPath = normalizeSidecarViewPath(m[3] || '/');
          void openSiblingSidecarPane({
            dir: m[1],
            folder: m[2],
            viewPath: normPath,
            title: label,
            uri: buildSidecarPaneUri(m[1], m[2], normPath),
          });
        }
      } else if (action === 'prompt-uninstall' || action === 'prompt-remove-files') {
        e.stopPropagation();
        if (isUpdateActionLocked()) return;
        const dir = el.getAttribute('data-dir') || '';
        const displayName = el.getAttribute('data-name') || dir;
        const version = el.getAttribute('data-version') || '';
        const favKey = el.getAttribute('data-fav-key') || '';
        if (dir && dir !== 'agy-market') {
          state.removeConfirmModal = {
            dir,
            displayName,
            version,
            isFavorited: isPluginDirFavorited(dir, favKey),
            removeFavorite: false,
          };
          render();
        }
      } else if (action === 'confirm-uninstall' || action === 'confirm-remove-files') {
        if (isUpdateActionLocked()) return;
        const dir = el.getAttribute('data-dir') || state.removeConfirmModal?.dir || '';
        const removeFavorite = Boolean(state.removeConfirmModal?.removeFavorite);
        const displayName = state.removeConfirmModal?.displayName || dir;
        if (dir) void triggerUninstallPlugin(dir, { removeFavorite, displayName });
      } else if (action === 'dismiss-restart-banner') {
        state.restartBanner = null;
        render();
      } else if (action === 'dismiss-nomination-banner') {
        state.nominationBanner = null;
        render();
      } else if (action === 'dismiss-error-banner') {
        state.errorBanner = null;
        render();
      } else if (action === 'retry-error-banner') {
        if (isUpdateActionLocked()) return;
        const retry = state.errorBanner?.retryAction;
        state.errorBanner = null;
        render();
        if (retry?.type === 'install' && retry.plugin) {
          void triggerInstall(retry.plugin, retry.opts || {});
        } else if (retry?.type === 'update-plugin-direct' || retry?.type === 'update-local-github') {
          void triggerDirectPluginUpdate({
            id: retry.id || '',
            dir: retry.dir || '',
            displayName: retry.displayName || '',
            source: retry.source || '',
            updateChannel: retry.updateChannel || '',
            targetRef: retry.targetRef || '',
            updateKind: retry.updateKind || '',
            trackBranch: retry.trackBranch || '',
            repositoryUrl: retry.repositoryUrl || '',
            preferUpstream: Boolean(retry.preferUpstream),
            forceResync: Boolean(retry.forceResync),
            confirmEscalation: false,
          });
        } else if (retry?.type === 'update-all') {
          void triggerUpdateAll(retry.ids || null, { confirmEscalation: false });
        } else if (retry?.type === 'self-update') {
          void triggerSelfUpdate({
            confirmEscalation: false,
            updateChannel: retry.updateChannel || '',
            targetVersion: retry.targetVersion || '',
            targetRef: retry.targetRef || '',
          });
        }
      } else if (action === 'check-updates') {
        if (isUpdateActionLocked()) return;
        void checkUpdates(true, { silent: false });
      } else if (action === 'toggle-locale') {
        const nextLocale = getLocale() === 'en' ? 'zh' : 'en';
        void updatePrefs({ locale: nextLocale }, nextLocale === 'en' ? 'Switched to English' : '已切换为简体中文');
      } else if (action === 'close-modal') {
        if (state.removeConfirmModal) {
          if (state.removingDir) return;
          state.removeConfirmModal = null;
        } else if (state.escalationModal) {
          state.escalationModal = null;
        } else if (state.conflictModal) {
          state.conflictModal = null;
        } else if (state.githubUrlModal) {
          if (state.githubUrlModal.phase === 'inspecting' || state.githubUrlModal.phase === 'installing') {
            return;
          }
          state.githubUrlModal = null;
        } else if (state.selfChangelogModal) {
          state.selfChangelogModal = false;
        } else {
          state.detailPlugin = null;
        }
        render();
      } else if (action === 'open-github-url-modal') {
        e.stopPropagation();
        const prefill = el.getAttribute('data-prefill-url') || '';
        openGithubUrlModal(prefill);
      } else if (action === 'inspect-github-url') {
        if (state.githubUrlModal) {
          const inputVal = root.querySelector('#github-url-input')?.value ?? state.githubUrlModal.url;
          void triggerGithubUrlInspect({ url: inputVal });
        }
      } else if (action === 'select-github-subpath') {
        if (state.githubUrlModal) {
          const pluginRoot = el.getAttribute('data-plugin-root') || '.';
          void triggerGithubUrlInspect({
            url: state.githubUrlModal.url,
            inspectToken: state.githubUrlModal.inspectToken,
            pluginRoot,
          });
        }
      } else if (action === 'back-github-subpaths') {
        if (state.githubUrlModal && Array.isArray(state.githubUrlModal.subpathCandidates)) {
          state.githubUrlModal.phase = 'subpaths';
          state.githubUrlModal.error = '';
          render();
        }
      } else if (action === 'select-github-install-mode') {
        if (state.githubUrlModal && state.githubUrlModal.phase === 'preview') {
          const mode = el.getAttribute('data-mode') || 'native';
          state.githubUrlModal.installMode = mode;
          state.githubUrlModal.error = '';
          render();
        }
      } else if (action === 'install-github-url') {
        if (isUpdateActionLocked()) return;
        void triggerGithubUrlInstall();
      } else if (action === 'reset-github-url-modal') {
        if (state.githubUrlModal) {
          githubInspectSeq += 1;
          state.githubUrlModal = {
            phase: 'input',
            url: state.githubUrlModal.url || '',
            inspectToken: '',
            selectedPluginRoot: '.',
            installMode: 'native',
            confirmEscalation: false,
            inspectResult: null,
            subpathCandidates: null,
            error: '',
          };
          state.focusGithubUrlInput = true;
          render();
        }
      } else if (action === 'update-plugin-direct' || action === 'update-local-github') {
        e.stopPropagation();
        if (isUpdateActionLocked()) return;
        const id = el.getAttribute('data-id') || '';
        const dir = el.getAttribute('data-dir') || '';
        const displayName = el.getAttribute('data-name') || dir || id;
        const source = el.getAttribute('data-source') || '';
        const updateChannel = el.getAttribute('data-update-channel') || '';
        const targetRef = el.getAttribute('data-target-ref') || '';
        const updateKind = el.getAttribute('data-update-kind') || '';
        const trackBranch = el.getAttribute('data-track-branch') || '';
        const repositoryUrl = el.getAttribute('data-repo-url') || '';
        const forceResync = el.getAttribute('data-force-resync') === '1';
        if (id || dir) {
          void triggerDirectPluginUpdate({
            id,
            dir,
            displayName,
            source,
            updateChannel,
            targetRef,
            updateKind,
            trackBranch,
            repositoryUrl,
            forceResync,
            confirmEscalation: false,
          });
        }
      } else if (action === 'sync-installed-plugin') {
        e.stopPropagation();
        if (isUpdateActionLocked()) return;
        const dir = el.getAttribute('data-dir') || '';
        const id = el.getAttribute('data-id') || '';
        const displayName = el.getAttribute('data-name') || dir || id;
        if (dir || id) {
          void triggerSyncInstalledPlugin({ dir, id, displayName });
        }
      } else if (action === 'detail') {
        e.stopPropagation();
        const id = el.getAttribute('data-id');
        const initialTab = el.getAttribute('data-detail-tab') || 'overview';
        const p = (state.serverState?.catalog?.plugins || []).find((x) => x.id === id);
        if (p) void openPluginDetail(p, initialTab);
      } else if (action === 'detail-local') {
        e.stopPropagation();
        const dir = el.getAttribute('data-dir');
        const initialTab = el.getAttribute('data-detail-tab') || 'overview';
        const loc = (state.serverState?.installed || []).find((x) => x.dir === dir);
        if (loc) {
          const { byId: catById, byDir: catByDir } = getCatalogMaps();
          const catEntry = (loc.receipt?.id && catById.get(loc.receipt.id)) || catByDir.get(loc.dir) || null;
          void openPluginDetail(buildLocalDetailModel(loc, catEntry), initialTab);
        }
      } else if (action === 'detail-tab') {
        const tab = el.getAttribute('data-tab') || 'overview';
        state.detailTab = tab;
        render();
        if (tab === 'discuss' && state.detailPlugin) {
          void loadPluginDiscussions(state.detailPlugin.id, false);
        }
      } else if (action === 'refresh-discussions') {
        const id = el.getAttribute('data-id');
        if (id) void loadPluginDiscussions(id, true);
      } else if (action === 'install') {
        e.stopPropagation();
        if (isUpdateActionLocked()) return;
        const id = el.getAttribute('data-id');
        const dir = el.getAttribute('data-dir') || '';
        const forceResync = el.getAttribute('data-force-resync') === '1';
        const p = (state.serverState?.catalog?.plugins || []).find((x) => x.id === id) || state.detailPlugin;
        if (p) void triggerInstall(p, { ...(dir ? { dir } : {}), ...(forceResync ? { forceResync: true } : {}) });
      } else if (action === 'update-all') {
        e.stopPropagation();
        if (isUpdateActionLocked()) return;
        void triggerUpdateAll(null, { confirmEscalation: false });
      } else if (action === 'retry-batch-one') {
        if (isUpdateActionLocked()) return;
        const id = el.getAttribute('data-id');
        if (id) void triggerUpdateAll([id], { confirmEscalation: false });
      } else if (action === 'clear-batch-results') {
        state.batchResults = null;
        render();
      } else if (action === 'self-update') {
        e.stopPropagation();
        if (isUpdateActionLocked()) return;
        const updateChannel = el.getAttribute('data-update-channel') || '';
        const targetVersion = el.getAttribute('data-target-version') || '';
        const targetRef = el.getAttribute('data-target-ref') || '';
        void triggerSelfUpdate({
          confirmEscalation: false,
          updateChannel,
          targetVersion,
          targetRef,
        });
      } else if (action === 'open-self-changelog') {
        state.selfChangelogModal = true;
        render();
      } else if (action === 'dismiss-self-banner') {
        const ver = state.updates.selfUpdate?.latestVersion || '__dismissed__';
        state.dismissedSelfVersion = ver;
        writeStorage(SELF_OFFER_DISMISSED_KEY, ver);
        render();
      } else if (action === 'restore-self-banner') {
        state.dismissedSelfVersion = '';
        writeStorage(SELF_OFFER_DISMISSED_KEY, '');
        render();
      } else if (action === 'resolve-conflict' && state.conflictModal) {
        if (isUpdateActionLocked()) return;
        const strategy = el.getAttribute('data-strategy') || 'isolate';
        void triggerInstall(state.conflictModal.plugin, { conflictStrategy: strategy });
      } else if (action === 'confirm-escalation' && state.escalationModal) {
        if (isUpdateActionLocked()) return;
        const em = state.escalationModal;
        state.escalationModal = null;
        if (em.mode === 'single' && em.items[0]?.plugin) {
          const item = em.items[0];
          void triggerInstall(item.plugin, {
            confirmEscalation: true,
            ...(item.dir ? { dir: item.dir } : {}),
            ...(item.forceResync ? { forceResync: true } : {}),
          });
        } else if ((em.mode === 'direct-update' || em.mode === 'local-github') && em.items[0]) {
          const item = em.items[0];
          void triggerDirectPluginUpdate({
            id: item.id || '',
            dir: item.dir || '',
            displayName: item.displayName || '',
            source: item.source || '',
            updateChannel: item.updateChannel || '',
            targetRef: item.targetRef || '',
            updateKind: item.updateKind || '',
            trackBranch: item.trackBranch || '',
            repositoryUrl: item.repositoryUrl || '',
            preferUpstream: Boolean(item.preferUpstream),
            forceResync: Boolean(item.forceResync),
            confirmEscalation: true,
          });
        } else if (em.mode === 'self') {
          const item = em.items[0] || {};
          void triggerSelfUpdate({
            confirmEscalation: true,
            updateChannel: item.updateChannel || '',
            targetVersion: item.targetVersion && item.targetVersion !== '?' ? item.targetVersion : '',
            targetRef: item.targetRef || '',
          });
        } else {
          const escalatedIds = em.items.map((x) => x.id).filter(Boolean);
          void triggerUpdateAll(escalatedIds, { confirmEscalation: true });
        }
      } else if (action === 'goto-token') {
        state.detailPlugin = null;
        state.activeTab = 'sources';
        state.focusTokenField = true;
        render();
      } else if (action === 'clear-github-token') {
        if (isUpdateActionLocked()) return;
        void updatePrefs({ githubToken: '', clearGithubToken: true }, t('已清除本地 GitHub Token', 'Cleared local GitHub Token'));
      } else if (action === 'copy-text') {
        e.stopPropagation();
        const val = el.getAttribute('data-copy-val') || '';
        const key = el.getAttribute('data-copy-key') || 'copy';
        if (val) void copyText(val, key);
      } else if (action === 'dismiss-toast') {
        state.toast = null;
        render();
      } else if (action === 'retry-reconnect') {
        startReconnectPolling(state.reconnecting?.targetVersion || '');
      } else if (action === 'reload-page') {
        window.location.reload();
      }
    });
  });
}

// Global keyboard shortcuts (Esc to close modals/drawer, `/` to focus search)
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (state.reconnecting) return;
    if (state.removeConfirmModal) {
      if (state.removingDir) return;
      state.removeConfirmModal = null;
      render();
    } else if (state.escalationModal) {
      state.escalationModal = null;
      render();
    } else if (state.conflictModal) {
      state.conflictModal = null;
      render();
    } else if (state.githubUrlModal) {
      if (state.githubUrlModal.phase === 'inspecting' || state.githubUrlModal.phase === 'installing') {
        return;
      }
      state.githubUrlModal = null;
      render();
    } else if (state.selfChangelogModal) {
      state.selfChangelogModal = false;
      render();
    } else if (state.detailPlugin) {
      state.detailPlugin = null;
      render();
    }
  } else if (e.key === '/' && !e.ctrlKey && !e.metaKey && !e.altKey) {
    if (state.githubUrlModal || state.conflictModal || state.escalationModal || state.removeConfirmModal) return;
    const tag = (document.activeElement?.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
    const searchEl =
      document.getElementById('market-search-input') ||
      document.getElementById('favorites-search-input') ||
      document.getElementById('installed-search-input');
    if (searchEl) {
      e.preventDefault();
      searchEl.focus();
    }
  }
});

if (window.sidecar?.onWorkspaceChange) {
  window.sidecar.onWorkspaceChange((uris) => {
    state.workspaceUris = uris;
    void loadState(false);
  });
}

// Automatically load state AND check updates (`GET /api/updates?force=0`) on pane open!
void loadState(false);
void checkUpdates(false, { silent: true });
