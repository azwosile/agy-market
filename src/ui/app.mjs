// Visual AGY Market Sidecar Application (`src/ui/app.mjs`).
// Zero external dependencies; bundled into `sidecars/market_pane/index.html` by `scripts/build.mjs`.

import {
  CAPABILITY_BADGE_SPECS,
  CATEGORY_LABELS,
  formatBadgeLabel,
} from '../shared/constants.mjs';
import { BRAND_LOGO_SVG, badgeIcon, icon } from './icons.mjs';
import { escapeHtml, renderSafeMarkdown } from './markdown.mjs';

const SELF_OFFER_DISMISSED_KEY = 'agy-market-self-offer-dismissed';

function readDismissedSelfVersion() {
  try {
    return window.localStorage?.getItem(SELF_OFFER_DISMISSED_KEY) || '';
  } catch {
    return '';
  }
}

function writeDismissedSelfVersion(version) {
  try {
    if (version) window.localStorage?.setItem(SELF_OFFER_DISMISSED_KEY, String(version));
    else window.localStorage?.removeItem(SELF_OFFER_DISMISSED_KEY);
  } catch {
    /* storage unavailable */
  }
}

const state = {
  loading: true,
  busyId: '',
  activeTab: 'discover', // 'discover' | 'installed' | 'sources'
  search: '',
  category: 'all',
  sortBy: 'stars', // 'stars' | 'updated' | 'name'
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
  dismissedSelfVersion: readDismissedSelfVersion(),
  selfUpdateBusy: false,
  selfChangelogModal: false,
  scrolledStuck: false,

  // Batch update state (`POST /api/update-all`)
  batchUpdating: false,
  batchTargetIds: [],
  batchResults: null, // null | Array<UpdateAllResult>

  // Reconnect overlay after `POST /api/self-update` or self-update inside `update-all`
  reconnecting: null, // null | { targetVersion, phase, attempts, timedOut }

  // Slide-over detail drawer
  detailPlugin: null, // enriched catalog plugin OR synthesized local plugin view model
  detailTab: 'overview', // 'overview' | 'changelog' | 'capabilities' | 'discuss'
  detailReadme: '',
  detailReadmeLoading: false,
  discussionsCache: {}, // pluginId -> { loading, data, error }

  // Modals
  conflictModal: null, // { plugin, conflict, scopedFallbackName, choices }
  escalationModal: null, // { mode: 'single' | 'batch' | 'self', items: [{ plugin?, id, displayName, installedVersion, targetVersion, escalation }] }

  // Feedback toast
  toast: null, // { message, extraUri, tone }
  copiedKey: '',
  focusTokenField: false,
};

let toastTimer = null;
let reconnectTimer = null;
let updatesRequestSeq = 0;
let lastForcedUpdatesAt = 0;

function isSelfBannerVisible() {
  const su = state.updates.selfUpdate;
  if (!su) return false;
  return !state.dismissedSelfVersion || String(state.dismissedSelfVersion) !== String(su.latestVersion || '');
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

function showToast(message, { extraUri = '', tone = 'info' } = {}) {
  state.toast = { message, extraUri, tone };
  render();
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    if (state.toast?.message === message) {
      state.toast = null;
      render();
    }
  }, 6000);
}

function formatRelativeTime(isoStr) {
  if (!isoStr) return '';
  const ts = Date.parse(isoStr);
  if (!Number.isFinite(ts)) return '';
  const diffSec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (diffSec < 45) return t('刚刚', 'just now');
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

function getEffectiveUpdateItems() {
  if (Array.isArray(state.updates.items) && state.updates.items.length > 0) {
    return state.updates.items;
  }
  if (state.updates.checkedAt) {
    return state.updates.items || [];
  }
  // Fallback before initial `/api/updates` response arrives
  return (state.serverState?.updatesAvailable || []).map((u) => ({
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

function buildLocalDetailModel(loc, catEntry) {
  if (catEntry) return catEntry;
  return {
    id: loc.receipt?.id || loc.dir,
    canonicalName: loc.name || loc.dir,
    scopedName: loc.dir,
    forceScopedInstall: false,
    displayName: loc.displayName || loc.name || loc.dir,
    description: loc.description || '',
    version: loc.version || '0.0.0',
    gitTag: loc.receipt?.gitTag || '',
    commitSha: '',
    repository: {
      url: loc.repositoryUrl || '',
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
    capabilities: loc.receipt?.grantedCapabilities || { badges: [] },
    installStatus: {
      installed: true,
      installedDir: loc.dir,
      installedVersion: loc.version,
      enabled: loc.enabled,
      hasUpdate: false,
      customizationUri: loc.customizationUri,
      sidecarPane: loc.sidecarPane,
    },
    _localOnly: true,
  };
}

function syncDetailPluginReference() {
  if (!state.detailPlugin) return;
  const fresh = (state.serverState?.catalog?.plugins || []).find((p) => p.id === state.detailPlugin.id);
  if (fresh) state.detailPlugin = fresh;
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
      state.serverState = await apiFetch('/api/catalog/refresh', {
        method: 'POST',
        body: { workspaceUris: state.workspaceUris },
      });
    } else {
      const qs = state.workspaceUris.length
        ? `?workspaceUris=${encodeURIComponent(state.workspaceUris.join(','))}`
        : '';
      state.serverState = await apiFetch(`/api/state${qs}`);
    }
    syncDetailPluginReference();
  } catch (err) {
    showToast(`${t('加载失败', 'Load failed')}: ${err?.message || String(err)}`, { tone: 'error' });
  } finally {
    state.loading = false;
    render();
  }
}

async function checkUpdates(force = false, { silent = true } = {}) {
  const seq = ++updatesRequestSeq;
  if (force) lastForcedUpdatesAt = Date.now();
  state.updates.loading = true;
  state.updates.error = '';
  render();
  try {
    const qs = force ? '?force=1' : '?force=0';
    const res = await apiFetch(`/api/updates${qs}`);
    if (seq !== updatesRequestSeq) return; // Ignore stale response superseded by newer check
    if (res && res.ok !== false) {
      state.updates = {
        loading: false,
        checkedAt: res.checkedAt || new Date().toISOString(),
        items: Array.isArray(res.items) ? res.items : [],
        selfUpdate: res.selfUpdate || null,
        rateLimited: Boolean(res.rateLimited),
        warnings: Array.isArray(res.warnings) ? res.warnings : [],
        error: '',
      };
      if (!silent) {
        const count = state.updates.items.length;
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
    }
  } catch (err) {
    if (seq !== updatesRequestSeq) return;
    state.updates.loading = false;
    state.updates.error = err?.message || String(err);
    if (!silent) {
      showToast(`${t('检查更新失败', 'Update check failed')}: ${state.updates.error}`, { tone: 'error' });
    }
  } finally {
    if (seq === updatesRequestSeq) render();
  }
}

async function triggerInstall(plugin, { conflictStrategy = 'prompt', confirmEscalation = false } = {}) {
  state.busyId = plugin.id;
  render();
  try {
    const endpoint = plugin.installStatus?.installed ? '/api/update' : '/api/install';
    const res = await apiFetch(endpoint, {
      method: 'POST',
      body: {
        id: plugin.id,
        plugin,
        conflictStrategy,
        confirmEscalation,
        workspaceUris: state.workspaceUris,
      },
    });

    if (res.state) {
      state.serverState = res.state;
      syncDetailPluginReference();
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
            displayName: plugin.displayName || plugin.canonicalName || plugin.id,
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
      if (res.isSelfUpdate || res.willRestart) {
        startReconnectPolling(res.version || plugin.version || '');
        return;
      }
      const noteSuffix = res.compatibilityNotes?.length ? ` (${res.compatibilityNotes[0]})` : '';
      showToast(
        `${t('已就绪并立即启用', 'Installed & active')}: ${res.installedDir} v${res.version}${noteSuffix}`,
        { extraUri: res.sidecarPane?.uri || res.customizationUri || '', tone: 'ok' },
      );
      void checkUpdates(false, { silent: true });
    } else {
      showToast(res.error || t('安装未完成', 'Install did not complete'), { tone: 'error' });
    }
  } catch (err) {
    showToast(`${t('安装失败', 'Install error')}: ${err?.message || String(err)}`, { tone: 'error' });
  } finally {
    state.busyId = '';
    render();
  }
}

async function triggerUpdateAll(ids = null, { confirmEscalation = false } = {}) {
  const installable = getInstallableUpdates();
  const targetIds = Array.isArray(ids) && ids.length ? ids : installable.map((u) => u.id);
  if (!targetIds.length) {
    showToast(t('当前没有可通过目录直接安装的更新', 'No catalog-installable updates available'));
    return;
  }

  state.batchUpdating = true;
  state.batchTargetIds = targetIds;
  render();

  try {
    const res = await apiFetch('/api/update-all', {
      method: 'POST',
      body: {
        ids: targetIds,
        confirmEscalation,
        workspaceUris: state.workspaceUris,
      },
    });

    if (res.state) {
      state.serverState = res.state;
      syncDetailPluginReference();
    }

    const results = Array.isArray(res.results) ? res.results : [];
    if (confirmEscalation && Array.isArray(state.batchResults)) {
      const merged = new Map(state.batchResults.map((r) => [r.id, r]));
      for (const r of results) merged.set(r.id, r);
      state.batchResults = [...merged.values()];
    } else {
      state.batchResults = results;
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
            escalation: r.escalation || upd?.escalation || { addedBadges: [], addedRemoteDomains: [], addedHookEvents: [] },
          };
        }),
      };
    } else {
      state.escalationModal = null;
    }

    const okCount = results.filter((r) => r.ok).length;
    const failCount = results.filter((r) => !r.ok && r.status !== 'CAPABILITY_ESCALATION_CONFIRM_REQUIRED').length;
    const selfUpdated = Boolean(
      res.willRestart || results.some((r) => r.ok && (r.isSelfUpdate || r.installedDir === 'agy-market' || r.id === 'azwosile__agy-market')),
    );

    if (selfUpdated) {
      const selfItem = results.find((r) => r.isSelfUpdate || r.installedDir === 'agy-market' || r.id === 'azwosile__agy-market');
      startReconnectPolling(selfItem?.version || state.updates.selfUpdate?.latestVersion || '');
      return;
    }

    if (failCount === 0 && escalated.length === 0) {
      showToast(t(`全部更新完成（共 ${okCount} 个插件）`, `Updated ${okCount} plugin(s) successfully`), { tone: 'ok' });
    } else if (escalated.length > 0) {
      showToast(
        t(
          `已完成 ${okCount} 个，另有 ${escalated.length} 个插件新增能力需确认`,
          `Updated ${okCount}; ${escalated.length} plugin(s) require capability confirmation`,
        ),
      );
    } else {
      showToast(
        t(`批量更新结束：${okCount} 成功，${failCount} 失败`, `Batch update finished: ${okCount} succeeded, ${failCount} failed`),
        { tone: 'error' },
      );
    }

    void checkUpdates(false, { silent: true });
  } catch (err) {
    showToast(`${t('批量更新失败', 'Batch update error')}: ${err?.message || String(err)}`, { tone: 'error' });
  } finally {
    state.batchUpdating = false;
    state.batchTargetIds = [];
    render();
  }
}

async function triggerSelfUpdate({ confirmEscalation = false } = {}) {
  state.selfUpdateBusy = true;
  render();
  try {
    const body = confirmEscalation ? { confirmEscalation: true } : {};
    const res = await apiFetch('/api/self-update', {
      method: 'POST',
      body,
    });

    if (res.state) {
      state.serverState = res.state;
    }

    if (res.status === 'CAPABILITY_ESCALATION_CONFIRM_REQUIRED') {
      const su = state.updates.selfUpdate;
      state.escalationModal = {
        mode: 'self',
        items: [
          {
            id: su?.id || 'azwosile__agy-market',
            displayName: 'AGY Market · 反重力插件市场',
            installedVersion: res.installedVersion || su?.installedVersion || state.serverState?.plugin?.version || '?',
            targetVersion: res.targetVersion || su?.latestVersion || '?',
            escalation: res.escalation || { addedBadges: [], addedRemoteDomains: [], addedHookEvents: [] },
          },
        ],
      };
      return;
    }

    if (res.ok || res.willRestart) {
      state.escalationModal = null;
      state.selfChangelogModal = false;
      startReconnectPolling(res.version || state.updates.selfUpdate?.latestVersion || '');
    } else {
      showToast(res.error || t('插件市场自更新未完成', 'Self-update did not complete'), { tone: 'error' });
    }
  } catch (err) {
    showToast(`${t('市场更新失败', 'Self-update failed')}: ${err?.message || String(err)}`, { tone: 'error' });
  } finally {
    state.selfUpdateBusy = false;
    render();
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
          writeDismissedSelfVersion('');
          render();
          await loadState(false);
          await checkUpdates(false, { silent: true });
          const versionBehind = Boolean(
            targetVersion && data?.version && String(data.version) !== String(targetVersion),
          );
          showToast(
            versionBehind
              ? t(
                  `服务已恢复 (v${data.version})，若界面未切换请刷新面板`,
                  `Reconnected (v${data.version}); reload pane if UI did not refresh`,
                )
              : t(
                  `AGY Market 已重启并恢复服务${data?.version ? ` (v${data.version})` : ''}`,
                  `AGY Market reconnected${data?.version ? ` (v${data.version})` : ''}`,
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

async function openPluginDetail(plugin, initialTab = 'overview') {
  state.detailPlugin = plugin;
  state.detailTab = initialTab;
  state.detailReadme = '';
  state.detailReadmeLoading = !plugin._localOnly;
  render();

  if (initialTab === 'discuss') {
    void loadPluginDiscussions(plugin.id, false);
  }

  if (!plugin._localOnly) {
    try {
      const res = await apiFetch(`/api/readme?id=${encodeURIComponent(plugin.id)}`);
      if (state.detailPlugin?.id === plugin.id) {
        state.detailReadme = res.markdown || '';
      }
    } catch {
      if (state.detailPlugin?.id === plugin.id) {
        state.detailReadme = '';
      }
    } finally {
      if (state.detailPlugin?.id === plugin.id) {
        state.detailReadmeLoading = false;
        render();
      }
    }
  }
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
    state.serverState = await apiFetch('/api/prefs', {
      method: 'POST',
      body: { ...patch, workspaceUris: state.workspaceUris },
    });
    syncDetailPluginReference();
    // Clear discussions cache if token changed so user sees newly unlocked threads immediately
    if ('githubToken' in patch || 'clearGithubToken' in patch) {
      state.discussionsCache = {};
    }
    showToast(successMsg || t('已保存源与网络加速设置', 'Saved catalog & mirror preferences'), { tone: 'ok' });
    if ('githubToken' in patch || 'clearGithubToken' in patch || 'primaryCatalogUrl' in patch || 'networkMode' in patch) {
      void checkUpdates(true, { silent: true });
    }
  } catch (err) {
    showToast(`${t('保存失败', 'Save error')}: ${err?.message || String(err)}`, { tone: 'error' });
  } finally {
    state.loading = false;
    render();
  }
}

async function copyText(text, key) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
    } else {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    state.copiedKey = key;
    render();
    setTimeout(() => {
      if (state.copiedKey === key) {
        state.copiedKey = '';
        render();
      }
    }, 1600);
  } catch {
    showToast(t('复制失败，请手动选中复制', 'Copy failed'), { tone: 'error' });
  }
}

// ==========================================================================
// Rendering Helpers
// ==========================================================================

function renderBadgesHtml(capabilities = {}, { maxCount = 0 } = {}) {
  const loc = getLocale();
  const badges = Array.isArray(capabilities?.badges) ? capabilities.badges : [];
  if (!badges.length) return '';

  const visible = maxCount > 0 && badges.length > maxCount ? badges.slice(0, maxCount) : badges;
  const hidden = maxCount > 0 && badges.length > maxCount ? badges.slice(maxCount) : [];

  const html = visible
    .map((id) => {
      const spec = CAPABILITY_BADGE_SPECS[id] || { tone: 'subtle', descZh: id, descEn: id };
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

function renderLogoHtml(iconUrl, name, sizeClass = '') {
  const monogram = String(name || 'P').trim().charAt(0).toUpperCase() || 'P';
  const cls = sizeClass ? `plugin-logo ${sizeClass}` : 'plugin-logo';
  return `
    <div class="${cls}">
      <span aria-hidden="true">${escapeHtml(monogram)}</span>
      ${iconUrl ? `<img src="${escapeHtml(iconUrl)}" alt="" loading="lazy" onerror="this.style.display='none'" />` : ''}
    </div>
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
    const desc =
      typeof p.description === 'object'
        ? `${p.description.zh || ''} ${p.description.en || ''}`
        : String(p.description || '');
    const hay = `${p.displayName || ''} ${p.canonicalName || ''} ${p.scopedName || ''} ${p.id || ''} ${desc} ${(p.taxonomy?.tags || []).join(' ')} ${(p.capabilities?.badges || []).join(' ')}`.toLowerCase();
    return hay.includes(q);
  });

  filtered.sort((a, b) => {
    if (state.sortBy === 'updated') {
      return String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''));
    }
    if (state.sortBy === 'name') {
      return String(a.displayName || a.canonicalName).localeCompare(String(b.displayName || b.canonicalName), loc);
    }
    return Number(b.repository?.stars || 0) - Number(a.repository?.stars || 0);
  });

  return filtered;
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
                <div class="skel skel-line" style="width:62%"></div>
                <div class="skel skel-line" style="width:38%"></div>
              </div>
            </div>
            <div class="skel skel-line" style="width:94%"></div>
            <div class="skel skel-line" style="width:74%"></div>
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

function renderPluginCard(p, updateById) {
  const loc = getLocale();
  const desc =
    typeof p.description === 'object'
      ? p.description[loc] || p.description.zh || p.description.en || ''
      : String(p.description || '');
  const st = p.installStatus || {};
  const upd = updateById.get(p.id) || null;
  const hasCatalogUpdate = Boolean((upd && upd.installable !== false) || (!upd && st.installed && st.hasUpdate));
  const hasUpstreamOnly = Boolean(upd && upd.installable === false);
  const isBusy = state.busyId === p.id || (state.batchUpdating && state.batchTargetIds.includes(p.id));
  const effectiveSlug = p.forceScopedInstall ? p.scopedName : p.canonicalName;
  const discussUrl = deriveDiscussionsUrl(p.repository?.url);
  const relUpdated = formatRelativeTime(p.updatedAt);

  let versionChip = `<span class="version-tag">v${escapeHtml(p.version)}</span>`;
  if (upd && st.installed) {
    versionChip = `<span class="version-delta ${hasUpstreamOnly ? 'is-upstream' : ''}" title="${escapeHtml(
      hasUpstreamOnly
        ? t('上游 GitHub 有新版，等待目录同步与 SHA-256 校验', 'Newer upstream release awaiting catalog sync')
        : t('发现可用更新', 'Update available'),
    )}">v${escapeHtml(upd.installedVersion || st.installedVersion || p.version)} → v${escapeHtml(upd.latestVersion)}</span>`;
  } else if (st.installed && st.hasUpdate) {
    versionChip = `<span class="version-delta">v${escapeHtml(st.installedVersion || '?')} → v${escapeHtml(p.version)}</span>`;
  }

  let actionBtn = '';
  if (isBusy) {
    actionBtn = `<button class="btn btn-primary btn-sm" disabled>${icon('refresh', 12, 'spin')} ${escapeHtml(t('处理中…', 'Working…'))}</button>`;
  } else if (hasCatalogUpdate) {
    const targetV = upd?.latestVersion || p.version;
    actionBtn = `<button class="btn btn-update-outline btn-sm" data-action="install" data-id="${escapeHtml(p.id)}">${icon('update', 12)} ${escapeHtml(t(`更新 v${targetV}`, `Update v${targetV}`))}</button>`;
  } else if (hasUpstreamOnly) {
    actionBtn = upd.releaseUrl
      ? `<a class="btn btn-upstream btn-sm" href="${escapeHtml(upd.releaseUrl)}" target="_blank" rel="noopener noreferrer" title="${escapeHtml(t('上游有新版，等待目录同步', 'Available upstream, awaiting catalog sync'))}">${escapeHtml(t(`上游 v${upd.latestVersion}`, `Upstream v${upd.latestVersion}`))} ${icon('arrowUpRight', 12)}</a>`
      : `<span class="version-delta is-upstream">${escapeHtml(t('待目录同步', 'Awaiting Sync'))}</span>`;
  } else if (st.installed) {
    actionBtn = `<button class="btn btn-installed btn-sm" data-action="detail" data-id="${escapeHtml(p.id)}">${icon('check', 12)} ${escapeHtml(t('已安装', 'Installed'))}</button>`;
  } else {
    actionBtn = `<button class="btn btn-primary btn-sm" data-action="install" data-id="${escapeHtml(p.id)}">${icon('download', 12)} ${escapeHtml(t('安装', 'Install'))}</button>`;
  }

  return `
    <article class="plugin-card ${hasCatalogUpdate ? 'has-update' : ''}">
      <div class="card-head" data-action="detail" data-id="${escapeHtml(p.id)}">
        ${renderLogoHtml(p.media?.iconUrl, p.displayName || p.canonicalName)}
        <div class="card-title-wrap">
          <div class="card-title-row">
            <span class="card-title" title="${escapeHtml(p.displayName || p.canonicalName)}">${escapeHtml(p.displayName || p.canonicalName)}</span>
            ${versionChip}
          </div>
          <div class="card-meta">
            <span class="card-slug" title="${escapeHtml(effectiveSlug)}">${escapeHtml(effectiveSlug)}</span>
            <span class="meta-sep">·</span>
            <span class="meta-star" title="GitHub Stars">${icon('star', 11)} ${Number(p.repository?.stars || 0)}</span>
            ${relUpdated ? `<span class="meta-sep">·</span><span style="white-space:nowrap">${escapeHtml(relUpdated)}</span>` : ''}
            ${upd?.changelog ? `<span class="meta-sep">·</span><button type="button" class="notes-link" data-action="detail" data-id="${escapeHtml(p.id)}" data-detail-tab="changelog">${escapeHtml(t('更新内容 ›', 'Notes ›'))}</button>` : ''}
            ${p.forceScopedInstall ? `<span class="track-tag" title="Track 2 Experimental Topic">Track 2</span>` : ''}
          </div>
        </div>
      </div>

      <p class="card-desc" data-action="detail" data-id="${escapeHtml(p.id)}">${escapeHtml(desc)}</p>

      <div class="badge-row" data-action="detail" data-id="${escapeHtml(p.id)}" data-detail-tab="capabilities">
        ${renderBadgesHtml(p.capabilities, { maxCount: 3 })}
      </div>

      <div class="card-foot">
        <div class="foot-links">
          ${st.sidecarPane?.uri ? `<a class="ghost-link is-accent" href="${escapeHtml(st.sidecarPane.uri)}" title="${escapeHtml(t('打开插件 Sidecar 面板', 'Open Sidecar Pane'))}">${icon('panel', 12)} ${escapeHtml(t('面板', 'Pane'))}</a>` : ''}
          ${st.customizationUri ? `<a class="ghost-link" href="${escapeHtml(st.customizationUri)}" title="${escapeHtml(t('在宿主中管理启用/停用/卸载', 'Manage in Host'))}">${icon('sliders', 12)} ${escapeHtml(t('管理', 'Manage'))}</a>` : ''}
          ${discussUrl ? `<a class="ghost-link" href="${escapeHtml(discussUrl)}" target="_blank" rel="noopener noreferrer" title="${escapeHtml(t('打开 GitHub Discussions 社区讨论', 'Open GitHub Discussions'))}">${icon('message', 12)} ${escapeHtml(t('讨论', 'Discuss'))}</a>` : ''}
        </div>
        ${actionBtn}
      </div>
    </article>
  `;
}

function renderSelfUpdateBanner() {
  const su = state.updates.selfUpdate;
  if (!su || !isSelfBannerVisible()) return '';
  const canInstall = su.installable !== false;
  const fromV = su.installedVersion || state.serverState?.plugin?.version || '?';
  const toV = su.latestVersion || '?';

  return `
    <div class="self-update-banner" data-agy-market-self-offer role="region" aria-label="${escapeHtml(t('插件市场更新提示', 'AGY Market Self-Update'))}">
      <div class="self-update-main">
        <div class="self-update-icon">${icon('sparkle', 14)}</div>
        <div class="self-update-text">
          <span class="self-update-title">${escapeHtml(t('AGY Market 有新版本可用', 'AGY Market update available'))}</span>
          <span class="version-delta ${canInstall ? '' : 'is-upstream'}">v${escapeHtml(fromV)} → v${escapeHtml(toV)}</span>
          ${!canInstall ? `<span class="muted" style="font-size:11px">${escapeHtml(t('上游已发布，等待目录同步', 'Upstream release awaiting catalog sync'))}</span>` : ''}
        </div>
      </div>
      <div class="self-update-actions">
        ${su.changelog ? `<button class="btn btn-sm" data-action="open-self-changelog">${icon('history', 12)} ${escapeHtml(t('更新日志', 'Notes'))}</button>` : ''}
        ${
          canInstall
            ? `<button class="btn btn-primary btn-sm" data-action="self-update" ${state.selfUpdateBusy ? 'disabled' : ''}>
                ${state.selfUpdateBusy ? icon('refresh', 12, 'spin') : icon('update', 12)}
                ${escapeHtml(state.selfUpdateBusy ? t('正在更新…', 'Updating…') : t('立即更新市场', 'Update Market'))}
              </button>`
            : su.releaseUrl
              ? `<a class="btn btn-upstream btn-sm" href="${escapeHtml(su.releaseUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(t('查看发布', 'Release'))} ${icon('arrowUpRight', 12)}</a>`
              : ''
        }
        <button class="icon-btn is-square" data-action="dismiss-self-banner" title="${escapeHtml(t('暂时收起', 'Dismiss'))}">${icon('close', 13)}</button>
      </div>
    </div>
  `;
}

function renderDiscoverView() {
  const prefs = state.serverState?.prefs || {};
  const loc = getLocale();
  const plugins = getFilteredPlugins();
  const catCounts = getCategoryCounts();
  const { byId: updById } = getUpdateMaps();
  const installableUpds = getInstallableUpdates();

  // Show "all", active selected category, and categories that have >= 1 plugin (plus top 4 core categories if catalog empty)
  const coreOrder = ['all', 'productivity', 'ui-themes', 'developer-tools', 'mcp-integrations', 'skills-workflows'];
  const chipKeys = Object.keys(CATEGORY_LABELS).filter(
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
              ? `<button class="search-clear" data-action="clear-search" title="${escapeHtml(t('清空搜索', 'Clear search'))}">${icon('close', 11)}</button>`
              : `<span class="search-kbd" aria-hidden="true">/</span>`
          }
        </div>

        <select id="market-sort-select" class="select-input" aria-label="${escapeHtml(t('排序方式', 'Sort by'))}">
          <option value="stars" ${state.sortBy === 'stars' ? 'selected' : ''}>${escapeHtml(t('按星标排序', 'Most Stars'))}</option>
          <option value="updated" ${state.sortBy === 'updated' ? 'selected' : ''}>${escapeHtml(t('最近更新', 'Recently Updated'))}</option>
          <option value="name" ${state.sortBy === 'name' ? 'selected' : ''}>${escapeHtml(t('按名称排序', 'Name A–Z'))}</option>
        </select>

        <label class="track2-pill ${prefs.enableExperimentalTrack2 ? 'enabled' : ''}" title="${escapeHtml(t('开启 GitHub Topic 自动发现 (Track 2)，自动采用 <owner>--<slug> 隔离命名', 'Enable experimental GitHub topic discovery (Track 2) with automatic scoped isolation'))}">
          <input id="track2-checkbox" type="checkbox" ${prefs.enableExperimentalTrack2 ? 'checked' : ''} />
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
            return `<button class="cat-chip ${state.category === key ? 'active' : ''}" data-action="category" data-category="${escapeHtml(key)}">${escapeHtml(label)}${n > 0 ? `<span class="cat-chip-n">${n}</span>` : ''}</button>`;
          })
          .join('')}
      </div>
    </div>

    <div class="main-scroll">
      ${
        installableUpds.length > 0
          ? `<div class="quick-update-strip">
              <div class="quick-update-left">
                ${icon('update', 14)}
                <span>${escapeHtml(t(`有 ${installableUpds.length} 个已安装插件可立即更新`, `${installableUpds.length} installed plugin update(s) ready`))}</span>
              </div>
              <div class="quick-update-actions">
                <button class="btn btn-sm" data-action="tab" data-tab="installed">${escapeHtml(t('查看详情', 'Review'))}</button>
                <button class="btn btn-update btn-sm" data-action="update-all" ${state.batchUpdating ? 'disabled' : ''}>
                  ${state.batchUpdating ? icon('refresh', 12, 'spin') : icon('update', 12)}
                  ${escapeHtml(state.batchUpdating ? t('更新中…', 'Updating…') : t('全部更新', 'Update All'))}
                </button>
              </div>
            </div>`
          : ''
      }

      ${
        state.loading && !plugins.length
          ? renderSkeletonGrid(4)
          : plugins.length
            ? `<div class="cards-grid">${plugins.map((p) => renderPluginCard(p, updById)).join('')}</div>`
            : `<div class="empty-state">
                <div class="empty-icon">${icon('search', 20)}</div>
                <div class="empty-title">${escapeHtml(t('当前筛选条件下暂无插件', 'No matching plugins found'))}</div>
                <div class="empty-sub">${escapeHtml(
                  state.search || state.category !== 'all'
                    ? t('尝试更换搜索关键词或重置分类筛选。', 'Try another search query or reset your category filter.')
                    : t('可在「源与设置」配置自定义目录源，或前往 agy-market-catalog 提交社区插件 PR。', 'Configure a custom feed in Sources or submit a YAML PR in agy-market-catalog.'),
                )}</div>
                ${
                  state.search || state.category !== 'all'
                    ? `<button class="btn btn-sm" data-action="reset-filters">${escapeHtml(t('重置筛选条件', 'Reset Filters'))}</button>`
                    : ''
                }
              </div>`
      }
    </div>
  `;
}

function renderBatchResultsPanel() {
  if (!Array.isArray(state.batchResults) || state.batchResults.length === 0) return '';
  return `
    <div class="batch-results">
      <div class="batch-results-head">
        <span>${escapeHtml(t('本次批量更新结果', 'Batch Update Results'))}</span>
        <button class="ghost-link" data-action="clear-batch-results">${escapeHtml(t('收起', 'Dismiss'))}</button>
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
            ? t(`已更新至 v${r.version || '?'}`, `Updated to v${r.version || '?'}`)
            : isEscalated
              ? t('新增能力权限，等待确认', 'Capability escalation requires confirmation')
              : r.error || r.status || t('更新失败', 'Update failed');

          return `
            <div class="batch-row ${toneCls}">
              <div class="batch-row-left">
                ${ico}
                <span class="batch-row-name">${escapeHtml(r.displayName || r.installedDir || r.id)}</span>
                <span class="batch-row-msg" title="${escapeHtml(statusMsg)}">${escapeHtml(statusMsg)}</span>
              </div>
              <div class="batch-row-right">
                ${r.reloadRequired && r.customizationUri ? `<a class="pill-link" href="${escapeHtml(r.customizationUri)}">${escapeHtml(t('需重载', 'Reload'))}</a>` : ''}
                ${r.ok && r.sidecarPane?.uri ? `<a class="ghost-link is-accent" href="${escapeHtml(r.sidecarPane.uri)}">${escapeHtml(t('打开面板', 'Open'))}</a>` : ''}
                ${!r.ok && !isEscalated ? `<button class="btn btn-sm" data-action="retry-batch-one" data-id="${escapeHtml(r.id)}">${escapeHtml(t('重试', 'Retry'))}</button>` : ''}
              </div>
            </div>
          `;
        })
        .join('')}
    </div>
  `;
}

function renderInstalledView() {
  const installed = state.serverState?.installed || [];
  const { byId: updById, byDir: updByDir } = getUpdateMaps();
  const { byId: catById, byDir: catByDir } = getCatalogMaps();
  const allUpdates = getEffectiveUpdateItems();
  const installableUpds = getInstallableUpdates();
  const upstreamOnlyCount = allUpdates.length - installableUpds.length;
  const checkedLabel = state.updates.checkedAt
    ? t(`上次检查：${formatRelativeTime(state.updates.checkedAt)}`, `Last checked ${formatRelativeTime(state.updates.checkedAt)}`)
    : t('正在自动检查远程更新…', 'Checking remote updates…');

  // 3-tier automatic ordering (DSH-market pattern): enabled -> updatable -> alphabetical
  const sortedInstalled = [...installed].sort((a, b) => {
    const aOn = a.enabled ? 1 : 0;
    const bOn = b.enabled ? 1 : 0;
    if (bOn !== aOn) return bOn - aOn;
    const ua = updByDir.get(a.dir) || (a.receipt?.id ? updById.get(a.receipt.id) : null);
    const ub = updByDir.get(b.dir) || (b.receipt?.id ? updById.get(b.receipt.id) : null);
    const sa = ua ? (ua.installable !== false ? 2 : 1) : 0;
    const sb = ub ? (ub.installable !== false ? 2 : 1) : 0;
    if (sb !== sa) return sb - sa;
    return String(a.displayName || a.dir).localeCompare(String(b.displayName || b.dir));
  });

  return `
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
                    : t(`已安装 ${installed.length} 个插件，全部为最新`, `${installed.length} installed — all up to date`),
              )}</span>
            </div>
            <div class="updates-summary-sub">
              <span>${escapeHtml(checkedLabel)}</span>
              ${upstreamOnlyCount > 0 ? `<span>· ${escapeHtml(t(`${upstreamOnlyCount} 个上游新版待目录同步`, `${upstreamOnlyCount} upstream awaiting sync`))}</span>` : ''}
            </div>
          </div>

          <div class="updates-command-actions">
            <button class="btn btn-sm" data-action="check-updates" ${state.updates.loading ? 'disabled' : ''}>
              ${icon('refresh', 12, state.updates.loading ? 'spin' : '')}
              ${escapeHtml(t('检查更新', 'Check Now'))}
            </button>
            ${
              installableUpds.length > 0
                ? `<button class="btn btn-update btn-sm" data-action="update-all" ${state.batchUpdating ? 'disabled' : ''}>
                    ${state.batchUpdating ? icon('refresh', 12, 'spin') : icon('update', 12)}
                    ${escapeHtml(
                      state.batchUpdating
                        ? t(`正在更新 (${state.batchTargetIds.length})…`, `Updating (${state.batchTargetIds.length})…`)
                        : t(`全部更新 (${installableUpds.length})`, `Update All (${installableUpds.length})`),
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
                <button class="btn btn-sm" data-action="goto-token">${escapeHtml(t('去配置', 'Configure'))}</button>
              </div>`
            : ''
        }

        ${renderBatchResultsPanel()}
      </section>

      ${
        state.loading && installed.length === 0
          ? renderSkeletonGrid(3)
          : sortedInstalled.length === 0
            ? `<div class="empty-state">
                <div class="empty-icon">${icon('package', 20)}</div>
                <div class="empty-title">${escapeHtml(t('尚未检测到已安装的插件', 'No local plugins detected yet'))}</div>
                <div class="empty-sub">${escapeHtml(t('前往「探索」标签浏览并一键安装社区插件。', 'Browse the Discover tab to install community plugins with one click.'))}</div>
                <button class="btn btn-primary btn-sm" data-action="tab" data-tab="discover">${escapeHtml(t('探索插件市场', 'Explore Market'))}</button>
              </div>`
            : `<div class="cards-grid">
                ${sortedInstalled
                  .map((loc) => {
                    const upd = updByDir.get(loc.dir) || (loc.receipt?.id ? updById.get(loc.receipt.id) : null);
                    const catEntry = (upd && catById.get(upd.id)) || (loc.receipt?.id && catById.get(loc.receipt.id)) || catByDir.get(loc.dir) || null;
                    const canCatalogUpdate = Boolean(upd && upd.installable !== false && catEntry);
                    const isUpstreamOnly = Boolean(upd && upd.installable === false);
                    const isBusy = Boolean(
                      catEntry && (state.busyId === catEntry.id || (state.batchUpdating && state.batchTargetIds.includes(catEntry.id))),
                    );
                    const discussUrl = deriveDiscussionsUrl(catEntry?.repository?.url || loc.repositoryUrl);
                    const badgesObj = catEntry?.capabilities || loc.receipt?.grantedCapabilities || { badges: [] };

                    let actionHtml = '';
                    if (isBusy) {
                      actionHtml = `<button class="btn btn-primary btn-sm" disabled>${icon('refresh', 12, 'spin')} ${escapeHtml(t('更新中…', 'Updating…'))}</button>`;
                    } else if (canCatalogUpdate) {
                      actionHtml = `<button class="btn btn-update-outline btn-sm" data-action="install" data-id="${escapeHtml(catEntry.id)}">${icon('update', 12)} ${escapeHtml(t(`更新 v${upd.latestVersion}`, `Update v${upd.latestVersion}`))}</button>`;
                    } else if (isUpstreamOnly && upd.releaseUrl) {
                      actionHtml = `<a class="btn btn-upstream btn-sm" href="${escapeHtml(upd.releaseUrl)}" target="_blank" rel="noopener noreferrer" title="${escapeHtml(t('上游 GitHub 有新版，等待目录同步', 'Available upstream, awaiting catalog sync'))}">${escapeHtml(t(`上游 v${upd.latestVersion}`, `Upstream v${upd.latestVersion}`))} ${icon('arrowUpRight', 12)}</a>`;
                    } else {
                      actionHtml = `<span class="state-pill is-enabled">${icon('check', 11)} ${escapeHtml(t('最新', 'Latest'))}</span>`;
                    }

                    return `
                      <article class="plugin-card ${canCatalogUpdate ? 'has-update' : ''}">
                        <div class="card-head" data-action="detail-local" data-dir="${escapeHtml(loc.dir)}">
                          ${renderLogoHtml(catEntry?.media?.iconUrl, loc.displayName)}
                          <div class="card-title-wrap">
                            <div class="card-title-row">
                              <span class="card-title" title="${escapeHtml(loc.displayName)}">${escapeHtml(loc.displayName)}</span>
                              ${
                                upd
                                  ? `<span class="version-delta ${isUpstreamOnly ? 'is-upstream' : ''}">v${escapeHtml(loc.version)} → v${escapeHtml(upd.latestVersion)}</span>`
                                  : `<span class="version-tag">v${escapeHtml(loc.version)}</span>`
                              }
                            </div>
                            <div class="card-meta">
                              <span class="card-slug">${escapeHtml(loc.dir)}</span>
                              <span class="meta-sep">·</span>
                              <span class="state-pill ${loc.enabled ? 'is-enabled' : 'is-disabled'}">${escapeHtml(loc.enabled ? t('已启用', 'Enabled') : t('已停用', 'Disabled'))}</span>
                              ${upd?.changelog ? `<span class="meta-sep">·</span><button type="button" class="notes-link" data-action="detail-local" data-dir="${escapeHtml(loc.dir)}" data-detail-tab="changelog">${escapeHtml(t('更新内容 ›', 'Notes ›'))}</button>` : `<span class="meta-sep">·</span><span>${escapeHtml(loc.scope)}</span>`}
                            </div>
                          </div>
                        </div>

                        <p class="card-desc" data-action="detail-local" data-dir="${escapeHtml(loc.dir)}">${escapeHtml(
                          loc.description ||
                            (typeof catEntry?.description === 'object'
                              ? catEntry.description[getLocale()] || catEntry.description.zh || ''
                              : catEntry?.description || ''),
                        )}</p>

                        ${badgesObj?.badges?.length ? `<div class="badge-row">${renderBadgesHtml(badgesObj, { maxCount: 3 })}</div>` : ''}

                        <div class="card-foot">
                          <div class="foot-links">
                            ${loc.sidecarPane?.uri ? `<a class="ghost-link is-accent" href="${escapeHtml(loc.sidecarPane.uri)}">${icon('panel', 12)} ${escapeHtml(t('面板', 'Pane'))}</a>` : ''}
                            <a class="ghost-link" href="${escapeHtml(loc.customizationUri)}">${icon('sliders', 12)} ${escapeHtml(t('管理', 'Manage'))}</a>
                            ${discussUrl ? `<a class="ghost-link" href="${escapeHtml(discussUrl)}" target="_blank" rel="noopener noreferrer" title="GitHub Discussions">${icon('message', 12)} ${escapeHtml(t('讨论', 'Discuss'))}</a>` : ''}
                          </div>
                          ${actionHtml}
                        </div>
                      </article>
                    `;
                  })
                  .join('')}
              </div>`
      }
    </div>
  `;
}

function renderSourcesView() {
  const prefs = state.serverState?.prefs || {};
  const cat = state.serverState?.catalog || {};
  const customLines = (prefs.customFeeds || []).join('\n');
  const hasToken = Boolean(prefs.hasGithubToken);

  return `
    <div class="main-scroll">
      <form id="sources-form" class="settings-panel">
        <div class="field-card">
          <div class="field-head">
            <div class="field-label">${icon('globe', 14)} ${escapeHtml(t('目录通道与实时遥测', 'Active Catalog Telemetry'))}</div>
            <button type="button" class="btn btn-sm" data-action="refresh" ${state.loading ? 'disabled' : ''}>
              ${icon('refresh', 12, state.loading ? 'spin' : '')}
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
              <span class="telemetry-v">v${escapeHtml(state.serverState?.plugin?.version || '1.1.0')}</span>
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
          <p class="field-hint">${escapeHtml(t('仅保存在本机 Sidecar 数据目录中，绝不回显或打印日志。配置后可解锁插件详情内联 GitHub Discussions 列表，并将更新检测额度从每小时 60 次提升至 5,000 次。', 'Stored locally only and never echoed or logged. Unlocks inline GitHub Discussions threads in plugin details and raises update-check rate limits from 60/hr to 5,000/hr.'))}</p>
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
                ? `<button type="button" class="btn btn-danger-ghost btn-sm" data-action="clear-github-token">${escapeHtml(t('清除 Token', 'Clear'))}</button>`
                : ''
            }
          </div>
        </div>

        <div class="field-card">
          <label class="field-label" for="net-mode-select">${icon('layers', 14)} ${escapeHtml(t('目录镜像与国内网络模式', 'Catalog Mirror & Network Mode'))}</label>
          <p class="field-hint">${escapeHtml(t('自动模式下优先通过 ETag 304 请求 GitHub Pages，超时 (>3.5s) 自动无缝切换至 npmmirror / 腾讯云 @agy-market/catalog 纯 JSON 镜像包。', 'Auto mode queries GitHub Pages with ETag 304 and falls back to @agy-market/catalog on npmmirror / Tencent mirror on timeout.'))}</p>
          <select id="net-mode-select" class="select-input">
            <option value="auto" ${prefs.networkMode === 'auto' ? 'selected' : ''}>${escapeHtml(t('自动切换 (GitHub Pages -> 国内镜像兜底)', 'Auto (GitHub Pages -> China Mirror Fallback)'))}</option>
            <option value="china-mirror" ${prefs.networkMode === 'china-mirror' ? 'selected' : ''}>${escapeHtml(t('国内镜像优先 (npmmirror / 腾讯云)', 'China Mirror Priority (npmmirror / Tencent)'))}</option>
            <option value="direct" ${prefs.networkMode === 'direct' ? 'selected' : ''}>${escapeHtml(t('仅直连主源 (Direct Only)', 'Direct Primary Only'))}</option>
          </select>
        </div>

        <div class="field-card">
          <label class="field-label" for="mirror-prefix-input">${icon('shield', 14)} ${escapeHtml(t('GitHub Release 下载加速前缀 (SHA-256 强校验)', 'GitHub Release Download Mirror Prefix (SHA-256 Verified)'))}</label>
          <p class="field-hint">${escapeHtml(t('可选。填写下载代理前缀后，所有 .tar.gz 解压前仍会强制比对目录 SHA-256 摘要，杜绝任何中间人篡改。', 'Optional download proxy prefix. Every archive is still verified against catalog SHA-256 before extraction.'))}</p>
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
          <button type="submit" class="btn btn-primary">${icon('check', 13)} ${escapeHtml(t('保存并重新同步目录', 'Save & Revalidate Catalog'))}</button>
        </div>
      </form>
    </div>
  `;
}

// ==========================================================================
// Slide-Over Detail Drawer
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
        <button class="btn btn-sm" data-action="refresh-discussions" data-id="${escapeHtml(plugin.id)}" ${entry?.loading ? 'disabled' : ''}>
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
          <button class="btn btn-primary btn-sm" data-action="goto-token">${icon('key', 12)} ${escapeHtml(t('前往配置 Token', 'Configure Token'))}</button>
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
  const upd = updById.get(p.id) || (p.installStatus?.installedDir ? updByDir.get(p.installStatus.installedDir) : null);
  const st = p.installStatus || {};
  const hasCatalogUpdate = Boolean((upd && upd.installable !== false) || (!upd && st.installed && st.hasUpdate));
  const hasUpstreamOnly = Boolean(upd && upd.installable === false);
  const isBusy = state.busyId === p.id;
  const discussUrl = deriveDiscussionsUrl(p.repository?.url);
  const loc = getLocale();

  let primaryBtn = '';
  if (p._localOnly) {
    primaryBtn = `<a class="btn btn-sm" href="${escapeHtml(st.customizationUri || '#')}">${icon('sliders', 12)} ${escapeHtml(t('在宿主中管理', 'Manage in Host'))}</a>`;
  } else if (isBusy) {
    primaryBtn = `<button class="btn btn-primary btn-sm" disabled>${icon('refresh', 12, 'spin')} ${escapeHtml(t('处理中…', 'Working…'))}</button>`;
  } else if (hasCatalogUpdate) {
    primaryBtn = `<button class="btn btn-update btn-sm" data-action="install" data-id="${escapeHtml(p.id)}">${icon('update', 12)} ${escapeHtml(t(`更新至 v${upd?.latestVersion || p.version}`, `Update to v${upd?.latestVersion || p.version}`))}</button>`;
  } else if (hasUpstreamOnly && upd.releaseUrl) {
    primaryBtn = `<a class="btn btn-upstream btn-sm" href="${escapeHtml(upd.releaseUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(t(`查看上游 v${upd.latestVersion}`, `Upstream v${upd.latestVersion}`))} ${icon('arrowUpRight', 12)}</a>`;
  } else if (st.installed) {
    primaryBtn = `<button class="btn btn-sm" data-action="install" data-id="${escapeHtml(p.id)}">${icon('refresh', 12)} ${escapeHtml(t('重新同步', 'Re-sync'))}</button>`;
  } else {
    primaryBtn = `<button class="btn btn-primary btn-sm" data-action="install" data-id="${escapeHtml(p.id)}">${icon('download', 12)} ${escapeHtml(t('立即安装并启用', 'Install Now'))}</button>`;
  }

  let bodyHtml = '';
  if (state.detailTab === 'overview') {
    bodyHtml = `
      <div class="badge-row">${renderBadgesHtml(p.capabilities)}</div>
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
          p.repository?.url
            ? `<span class="muted">Repository</span>
               <span><a class="md-link" href="${escapeHtml(p.repository.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(p.repository.url)}</a></span>`
            : ''
        }
        ${
          p.gitTag || p.commitSha
            ? `<span class="muted">Tag / Commit</span>
               <span class="mono">${escapeHtml(p.gitTag || 'n/a')}${p.commitSha ? ` · ${escapeHtml(String(p.commitSha).slice(0, 12))}` : ''}</span>`
            : ''
        }
        ${
          p.distribution?.sha256
            ? `<span class="muted">SHA-256</span>
               <span class="meta-kv-val">
                 <span class="mono" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(p.distribution.sha256)}</span>
                 <button class="icon-btn btn-sm" data-action="copy-text" data-copy-key="sha-${escapeHtml(p.id)}" data-copy-val="${escapeHtml(p.distribution.sha256)}" title="${escapeHtml(t('复制完整 SHA-256', 'Copy SHA-256'))}">
                   ${icon(state.copiedKey === `sha-${p.id}` ? 'check' : 'copy', 11)}
                 </button>
               </span>`
            : ''
        }
      </div>
    `;
  } else if (state.detailTab === 'changelog') {
    bodyHtml = upd
      ? `
        <div class="changelog-banner ${hasUpstreamOnly ? 'is-upstream' : ''}">
          <div style="display:flex;flex-direction:column;gap:3px">
            <div style="font-weight:700;font-size:12.5px">v${escapeHtml(upd.installedVersion || st.installedVersion || p.version)} → v${escapeHtml(upd.latestVersion)}</div>
            <div class="muted" style="font-size:11.2px">${escapeHtml(
              hasUpstreamOnly
                ? t('来源：GitHub 上游发布（等待目录同步与 SHA-256 锁定）', 'Source: GitHub upstream (awaiting catalog SHA-256 sync)')
                : t('来源：权威目录（已通过 SHA-256 完整性校验）', 'Source: Verified Catalog (SHA-256 attested)'),
            )}</div>
          </div>
          ${upd.releaseUrl ? `<a class="btn btn-sm" href="${escapeHtml(upd.releaseUrl)}" target="_blank" rel="noopener noreferrer">Release ${icon('external', 11)}</a>` : ''}
        </div>
        <div class="md-body">
          ${renderSafeMarkdown(upd.changelog, t('上游未附带详细的更新日志说明。', 'No release notes were provided for this version.'))}
        </div>
      `
      : `<div class="empty-state">
          <div class="empty-icon">${icon('history', 20)}</div>
          <div class="empty-title">${escapeHtml(t('当前已是最新版本', 'Currently up to date'))}</div>
          <div class="empty-sub">${escapeHtml(t(`当前版本 v${p.version}，暂无待安装的更新日志。`, `Running v${p.version} with no pending update changelog.`))}</div>
          ${p.repository?.url ? `<a class="btn btn-sm" href="${escapeHtml(p.repository.url)}/releases" target="_blank" rel="noopener noreferrer">${escapeHtml(t('查看 GitHub Releases', 'View GitHub Releases'))} ${icon('external', 11)}</a>` : ''}
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
                  const spec = CAPABILITY_BADGE_SPECS[id] || { tone: 'subtle', descZh: id, descEn: id };
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
            : `<p class="muted">${escapeHtml(t('暂无静态能力画像数据。', 'No static capability metadata available.'))}</p>`
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
      <aside class="drawer-panel" role="dialog" aria-modal="true" aria-label="${escapeHtml(p.displayName || p.canonicalName)}" onclick="event.stopPropagation()">
        <div class="drawer-hero">
          <div class="drawer-hero-top">
            ${renderLogoHtml(p.media?.iconUrl, p.displayName || p.canonicalName, 'is-lg')}
            <div class="drawer-hero-info">
              <h2 class="drawer-title">${escapeHtml(p.displayName || p.canonicalName)}</h2>
              <div class="drawer-subtitle">
                <span class="mono">${escapeHtml(p.forceScopedInstall ? p.scopedName : p.canonicalName)}</span>
                ${
                  upd
                    ? `<span class="version-delta ${hasUpstreamOnly ? 'is-upstream' : ''}">v${escapeHtml(upd.installedVersion || st.installedVersion || p.version)} → v${escapeHtml(upd.latestVersion)}</span>`
                    : `<span class="version-tag">v${escapeHtml(p.version)}</span>`
                }
                ${Number(p.repository?.stars || 0) > 0 ? `<span class="meta-star">${icon('star', 11)} ${Number(p.repository.stars)}</span>` : ''}
              </div>
            </div>
            <button class="icon-btn is-square" data-action="close-modal" title="${escapeHtml(t('关闭 (Esc)', 'Close (Esc)'))}">${icon('close', 14)}</button>
          </div>

          <div class="drawer-cta-bar">
            ${primaryBtn}
            ${st.sidecarPane?.uri ? `<a class="btn btn-sm" href="${escapeHtml(st.sidecarPane.uri)}">${icon('panel', 12)} ${escapeHtml(t('打开面板', 'Open Pane'))}</a>` : ''}
            ${st.customizationUri ? `<a class="btn btn-sm" href="${escapeHtml(st.customizationUri)}">${icon('sliders', 12)} ${escapeHtml(t('管理', 'Manage'))}</a>` : ''}
            ${p.repository?.url ? `<a class="btn btn-sm" href="${escapeHtml(p.repository.url)}" target="_blank" rel="noopener noreferrer">GitHub ${icon('external', 11)}</a>` : ''}
            ${discussUrl ? `<a class="btn btn-sm" href="${escapeHtml(discussUrl)}" target="_blank" rel="noopener noreferrer">${icon('message', 12)} ${escapeHtml(t('讨论区', 'Discussions'))}</a>` : ''}
          </div>
        </div>

        <nav class="drawer-tabs" role="tablist">
          <button class="drawer-tab ${state.detailTab === 'overview' ? 'active' : ''}" data-action="detail-tab" data-tab="overview">
            ${icon('book', 12)} ${escapeHtml(t('概览', 'Overview'))}
          </button>
          <button class="drawer-tab ${state.detailTab === 'changelog' ? 'active' : ''}" data-action="detail-tab" data-tab="changelog">
            ${icon('history', 12)} ${escapeHtml(t('更新日志', 'Changelog'))}
            ${upd ? '<span class="status-dot is-pulse"></span>' : ''}
          </button>
          <button class="drawer-tab ${state.detailTab === 'capabilities' ? 'active' : ''}" data-action="detail-tab" data-tab="capabilities">
            ${icon('shield', 12)} ${escapeHtml(t('能力与安全', 'Capabilities'))}
          </button>
          <button class="drawer-tab ${state.detailTab === 'discuss' ? 'active' : ''}" data-action="detail-tab" data-tab="discuss">
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

function renderModals() {
  let html = '';

  if (state.detailPlugin) {
    html += renderDetailDrawer();
  }

  if (state.selfChangelogModal && state.updates.selfUpdate) {
    const su = state.updates.selfUpdate;
    const canInstall = su.installable !== false;
    html += `
      <div class="modal-backdrop" data-action="close-modal">
        <div class="modal-box" onclick="event.stopPropagation()">
          <div class="modal-header">
            <div class="modal-title-wrap">
              ${icon('sparkle', 15)}
              <span>${escapeHtml(t('AGY Market 新版本更新日志', 'AGY Market Release Notes'))}</span>
              <span class="version-delta ${canInstall ? '' : 'is-upstream'}">v${escapeHtml(su.installedVersion || '?')} → v${escapeHtml(su.latestVersion || '?')}</span>
            </div>
            <button class="icon-btn is-square" data-action="close-modal">${icon('close', 14)}</button>
          </div>
          <div class="modal-body md-body">
            ${renderSafeMarkdown(su.changelog, t('暂无更新日志详情。', 'No changelog provided.'))}
          </div>
          <div class="modal-footer">
            ${su.releaseUrl ? `<a class="btn btn-sm" href="${escapeHtml(su.releaseUrl)}" target="_blank" rel="noopener noreferrer">GitHub Release ${icon('external', 11)}</a>` : ''}
            <button class="btn btn-sm" data-action="close-modal">${escapeHtml(t('关闭', 'Close'))}</button>
            ${
              canInstall
                ? `<button class="btn btn-primary btn-sm" data-action="self-update" ${state.selfUpdateBusy ? 'disabled' : ''}>${icon('update', 12)} ${escapeHtml(t('立即更新市场', 'Update Market'))}</button>`
                : ''
            }
          </div>
        </div>
      </div>
    `;
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
            <button class="icon-btn is-square" data-action="close-modal">${icon('close', 14)}</button>
          </div>
          <div class="modal-body">
            <p style="margin:0">${escapeHtml(t(`本地已存在来自其他来源的插件 "${cm.conflict.dir}" (${cm.conflict.scope})。Antigravity 对同名插件会静默丢弃后者，请选择安装方式：`, `A local plugin "${cm.conflict.dir}" (${cm.conflict.scope}) already claims this identifier. Choose how to proceed:`))}</p>
          </div>
          <div class="modal-footer">
            <button class="btn btn-sm" data-action="close-modal">${escapeHtml(t('取消', 'Cancel'))}</button>
            ${
              cm.choices.includes('replace')
                ? `<button class="btn btn-sm" data-action="resolve-conflict" data-strategy="replace">${escapeHtml(t('覆盖替换本地同名插件', 'Replace Existing'))}</button>`
                : ''
            }
            <button class="btn btn-primary btn-sm" data-action="resolve-conflict" data-strategy="isolate">
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
            <button class="icon-btn is-square" data-action="close-modal">${icon('close', 14)}</button>
          </div>
          <div class="modal-body">
            <p class="muted" style="margin:0">${escapeHtml(t('确认授权后将立即继续安装并更新本地能力凭证：', 'Confirm to proceed with installation and record the newly granted capabilities:'))}</p>
            ${em.items
              .map(
                (item) => `
                <div class="escalation-item">
                  <div class="escalation-item-head">
                    <span>${escapeHtml(item.displayName)}</span>
                    <span class="version-delta">v${escapeHtml(item.installedVersion)} → v${escapeHtml(item.targetVersion)}</span>
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
              `,
              )
              .join('')}
          </div>
          <div class="modal-footer">
            <button class="btn btn-sm" data-action="close-modal">${escapeHtml(t('暂不更新', 'Cancel'))}</button>
            <button class="btn btn-primary btn-sm" data-action="confirm-escalation">
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
                  `正在应用${rc.targetVersion ? ` v${rc.targetVersion}` : '新版本'}并轮询 /healthz（第 ${rc.attempts} 次探测）…`,
                  `Applying${rc.targetVersion ? ` v${rc.targetVersion}` : ' update'} and polling /healthz (attempt ${rc.attempts})…`,
                ),
          )}</div>
          ${!rc.timedOut ? `<div class="progress-track"><div class="progress-fill"></div></div>` : ''}
          ${
            rc.timedOut
              ? `<div style="display:flex;gap:8px;margin-top:4px">
                  <button class="btn btn-primary btn-sm" data-action="retry-reconnect">${icon('refresh', 12)} ${escapeHtml(t('重试连接', 'Retry'))}</button>
                  <button class="btn btn-sm" data-action="reload-page">${escapeHtml(t('刷新面板', 'Reload Pane'))}</button>
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
  const installedCount = state.serverState?.installed?.length || 0;
  const updatesCount = getEffectiveUpdateItems().length;
  const curLocale = getLocale();
  const channelLabel = state.serverState?.catalog?.channelUsed || '';
  const clientVer = state.serverState?.plugin?.version || '1.1.0';
  const showSelfOffer = isSelfBannerVisible();
  const hasDismissedSelfUpdate = Boolean(state.updates.selfUpdate && !showSelfOffer);
  const showInstalledDot = updatesCount > 0 || showSelfOffer;

  root.innerHTML = `
    <div class="market-shell" data-stuck="${state.scrolledStuck ? 'true' : 'false'}">
      <header class="app-header">
        <div class="brand-group">
          <div class="brand-mark">${BRAND_LOGO_SVG}</div>
          <div class="brand-copy">
            <span class="brand-title">${escapeHtml(t('AGY Market', 'AGY Market'))}</span>
            <span class="brand-meta-pill" title="${escapeHtml(channelLabel ? `${t('目录通道', 'Channel')}: ${channelLabel}` : t('零 Token 辅助面板', 'Zero-Token Sidecar'))}">
              <span class="status-dot ${state.updates.rateLimited ? 'is-warn' : state.updates.loading ? 'is-pulse' : ''}"></span>
              <span>v${escapeHtml(clientVer)}</span>
            </span>
          </div>
        </div>

        <nav class="segmented-nav" role="tablist" aria-label="${escapeHtml(t('主导航', 'Main navigation'))}">
          <button class="nav-pill ${state.activeTab === 'discover' ? 'active' : ''}" data-action="tab" data-tab="discover" role="tab" aria-selected="${state.activeTab === 'discover'}">
            ${icon('compass', 13)}
            <span>${escapeHtml(t('探索', 'Discover'))}</span>
            <span class="nav-count">${catalogCount}</span>
          </button>
          <button class="nav-pill ${state.activeTab === 'installed' ? 'active' : ''}" data-action="tab" data-tab="installed" role="tab" aria-selected="${state.activeTab === 'installed'}">
            ${icon('package', 13)}
            <span>${escapeHtml(t('已安装', 'Installed'))}</span>
            <span class="nav-count">${installedCount}</span>
            ${updatesCount > 0 ? `<span class="nav-update-badge" title="${escapeHtml(t(`${updatesCount} 个可用更新`, `${updatesCount} updates available`))}">↑${updatesCount}</span>` : ''}
            ${showInstalledDot ? '<span class="tab-red-dot" aria-hidden="true"></span>' : ''}
          </button>
          <button class="nav-pill ${state.activeTab === 'sources' ? 'active' : ''}" data-action="tab" data-tab="sources" role="tab" aria-selected="${state.activeTab === 'sources'}">
            ${icon('sliders', 13)}
            <span>${escapeHtml(t('源与设置', 'Sources'))}</span>
          </button>
        </nav>

        <div class="header-actions">
          ${
            hasDismissedSelfUpdate
              ? `<button class="icon-btn has-alert" data-action="restore-self-banner" title="${escapeHtml(t('AGY Market 有新版本可用', 'AGY Market update available'))}">${icon('sparkle', 13)} <span>v${escapeHtml(state.updates.selfUpdate.latestVersion)}</span></button>`
              : ''
          }
          <button class="icon-btn" data-action="toggle-locale" title="${escapeHtml(t('切换语言', 'Switch Language'))}">${curLocale === 'en' ? '中' : 'EN'}</button>
          <button class="icon-btn is-square" data-action="refresh" ${state.loading || state.updates.loading ? 'disabled' : ''} title="${escapeHtml(t('刷新目录并检查更新', 'Refresh catalog & check updates'))}">
            ${icon('refresh', 13, state.loading || state.updates.loading ? 'spin' : '')}
          </button>
        </div>
      </header>

      ${renderSelfUpdateBanner()}

      ${
        state.activeTab === 'discover'
          ? renderDiscoverView()
          : state.activeTab === 'installed'
            ? renderInstalledView()
            : renderSourcesView()
      }

      ${renderModals()}

      ${
        state.toast
          ? `<div class="toast-bar tone-${escapeHtml(state.toast.tone || 'info')}" role="status">
              <span>${escapeHtml(state.toast.message)}</span>
              <div class="toast-actions">
                ${state.toast.extraUri ? `<a class="pill-link" href="${escapeHtml(state.toast.extraUri)}">${escapeHtml(t('打开', 'Open'))}</a>` : ''}
                <button class="icon-btn is-square" data-action="dismiss-toast" title="${escapeHtml(t('关闭', 'Dismiss'))}">${icon('close', 12)}</button>
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

  if (state.focusTokenField) {
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
// Event Binding
// ==========================================================================

function bindDomEvents(root) {
  const searchEl = root.querySelector('#market-search-input');
  if (searchEl) {
    searchEl.addEventListener('input', (e) => {
      state.search = e.target.value;
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
      void updatePrefs({ enableExperimentalTrack2: Boolean(e.target.checked) });
    });
  }

  const sourcesForm = root.querySelector('#sources-form');
  if (sourcesForm) {
    sourcesForm.addEventListener('submit', (e) => {
      e.preventDefault();
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
      const action = el.getAttribute('data-action');

      if (action === 'tab') {
        const nextTab = el.getAttribute('data-tab') || 'discover';
        const changed = nextTab !== state.activeTab;
        state.activeTab = nextTab;
        if (changed) state.scrolledStuck = false;
        render();
        if (nextTab === 'installed' && Date.now() - lastForcedUpdatesAt > 10_000 && !state.updates.loading) {
          void checkUpdates(true, { silent: true });
        }
      } else if (action === 'category') {
        state.category = el.getAttribute('data-category') || 'all';
        render();
      } else if (action === 'clear-search') {
        state.search = '';
        render();
      } else if (action === 'reset-filters') {
        state.search = '';
        state.category = 'all';
        render();
      } else if (action === 'refresh') {
        void Promise.all([loadState(true), checkUpdates(true, { silent: false })]);
      } else if (action === 'check-updates') {
        void checkUpdates(true, { silent: false });
      } else if (action === 'toggle-locale') {
        const nextLocale = getLocale() === 'en' ? 'zh' : 'en';
        void updatePrefs({ locale: nextLocale }, nextLocale === 'en' ? 'Switched to English' : '已切换为中文');
      } else if (action === 'close-modal') {
        if (state.escalationModal) {
          state.escalationModal = null;
        } else if (state.conflictModal) {
          state.conflictModal = null;
        } else if (state.selfChangelogModal) {
          state.selfChangelogModal = false;
        } else {
          state.detailPlugin = null;
        }
        render();
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
        const id = el.getAttribute('data-id');
        const p = (state.serverState?.catalog?.plugins || []).find((x) => x.id === id) || state.detailPlugin;
        if (p) void triggerInstall(p);
      } else if (action === 'update-all') {
        e.stopPropagation();
        void triggerUpdateAll(null, { confirmEscalation: false });
      } else if (action === 'retry-batch-one') {
        const id = el.getAttribute('data-id');
        if (id) void triggerUpdateAll([id], { confirmEscalation: false });
      } else if (action === 'clear-batch-results') {
        state.batchResults = null;
        render();
      } else if (action === 'self-update') {
        void triggerSelfUpdate({ confirmEscalation: false });
      } else if (action === 'open-self-changelog') {
        state.selfChangelogModal = true;
        render();
      } else if (action === 'dismiss-self-banner') {
        const ver = state.updates.selfUpdate?.latestVersion || '__dismissed__';
        state.dismissedSelfVersion = ver;
        writeDismissedSelfVersion(ver);
        render();
      } else if (action === 'restore-self-banner') {
        state.dismissedSelfVersion = '';
        writeDismissedSelfVersion('');
        render();
      } else if (action === 'resolve-conflict' && state.conflictModal) {
        const strategy = el.getAttribute('data-strategy') || 'isolate';
        void triggerInstall(state.conflictModal.plugin, { conflictStrategy: strategy });
      } else if (action === 'confirm-escalation' && state.escalationModal) {
        const em = state.escalationModal;
        state.escalationModal = null;
        if (em.mode === 'single' && em.items[0]?.plugin) {
          void triggerInstall(em.items[0].plugin, { confirmEscalation: true });
        } else if (em.mode === 'self') {
          void triggerSelfUpdate({ confirmEscalation: true });
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
        void updatePrefs({ githubToken: '', clearGithubToken: true }, t('已清除本地 GitHub Token', 'Cleared local GitHub Token'));
      } else if (action === 'copy-text') {
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

// Global keyboard shortcuts (Esc to close drawer/modals, `/` to focus search)
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (state.reconnecting) return;
    if (state.escalationModal) {
      state.escalationModal = null;
      render();
    } else if (state.conflictModal) {
      state.conflictModal = null;
      render();
    } else if (state.selfChangelogModal) {
      state.selfChangelogModal = false;
      render();
    } else if (state.detailPlugin) {
      state.detailPlugin = null;
      render();
    }
  } else if (e.key === '/' && !e.ctrlKey && !e.metaKey && !e.altKey) {
    const tag = (document.activeElement?.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
    const searchEl = document.getElementById('market-search-input');
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
