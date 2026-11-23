// Visual AGY Market Sidecar Application (`src/ui/app.mjs`).
// Zero external dependencies; bundled into `sidecars/market_pane/index.html`.

import {
  CAPABILITY_BADGE_SPECS,
  CATEGORY_LABELS,
  formatBadgeLabel,
} from '../shared/constants.mjs';
import { escapeHtml, renderSafeMarkdown } from './markdown.mjs';

const state = {
  loading: true,
  busyId: '',
  activeTab: 'discover', // 'discover' | 'installed' | 'sources'
  search: '',
  category: 'all',
  sortBy: 'stars', // 'stars' | 'updated' | 'name'
  serverState: null,
  workspaceUris: [],
  detailPlugin: null,
  detailReadme: '',
  detailLoading: false,
  conflictModal: null, // { plugin, conflict, scopedFallbackName, choices }
  escalationModal: null, // { plugin, installedVersion, targetVersion, escalation }
  toast: null,
};

function getBootToken() {
  const params = new URLSearchParams(window.location.search);
  return params.get('token') || window.__SIDECAR_BOOT__?.token || '';
}

async function apiFetch(path, { method = 'GET', body = null } = {}) {
  const token = getBootToken();
  const headers = {};
  if (token) headers['X-Sidecar-Token'] = token;
  if (body !== null) headers['Content-Type'] = 'application/json';

  const fn =
    window.sidecar?.__marketFetch ||
    window.sidecar?.fetch?.bind(window.sidecar) ||
    window.fetch.bind(window);

  const res = await fn(path, {
    method,
    headers,
    body: body !== null ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
  if (!res.ok && !data.status) {
    throw new Error(data.error || `HTTP ${res.status}`);
  }
  return data;
}

function t(zh, en) {
  const loc = state.serverState?.prefs?.locale || 'zh';
  return loc === 'en' ? en : zh;
}

function showToast(message, extraUri = '') {
  state.toast = { message, extraUri };
  render();
  setTimeout(() => {
    if (state.toast?.message === message) {
      state.toast = null;
      render();
    }
  }, 6000);
}

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
  } catch (err) {
    showToast(`${t('加载失败', 'Load failed')}: ${err?.message || String(err)}`);
  } finally {
    state.loading = false;
    render();
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
        plugin,
        installedVersion: res.installedVersion,
        targetVersion: res.targetVersion,
        escalation: res.escalation,
      };
      return;
    }

    if (res.ok) {
      state.conflictModal = null;
      state.escalationModal = null;
      const noteSuffix = res.compatibilityNotes?.length ? ` (${res.compatibilityNotes[0]})` : '';
      showToast(
        `${t('已就绪并立即启用', 'Installed & active')}: ${res.installedDir} v${res.version}${noteSuffix}`,
        res.sidecarPane?.uri || res.customizationUri || '',
      );
    } else {
      showToast(res.error || t('安装未完成', 'Install did not complete'));
    }
  } catch (err) {
    showToast(`${t('安装失败', 'Install error')}: ${err?.message || String(err)}`);
  } finally {
    state.busyId = '';
    render();
  }
}

async function openPluginDetail(plugin) {
  state.detailPlugin = plugin;
  state.detailReadme = '';
  state.detailLoading = true;
  render();
  try {
    const res = await apiFetch(`/api/readme?id=${encodeURIComponent(plugin.id)}`);
    state.detailReadme = res.markdown || '';
  } catch {
    state.detailReadme = '';
  } finally {
    state.detailLoading = false;
    render();
  }
}

async function updatePrefs(patch) {
  try {
    state.loading = true;
    render();
    state.serverState = await apiFetch('/api/prefs', {
      method: 'POST',
      body: { ...patch, workspaceUris: state.workspaceUris },
    });
    showToast(t('已保存源与网络加速设置', 'Saved catalog & mirror preferences'));
  } catch (err) {
    showToast(`${t('保存失败', 'Save error')}: ${err?.message || String(err)}`);
  } finally {
    state.loading = false;
    render();
  }
}

function renderBadgesHtml(capabilities = {}) {
  const loc = state.serverState?.prefs?.locale || 'zh';
  const badges = Array.isArray(capabilities.badges) ? capabilities.badges : [];
  return badges
    .map((id) => {
      const spec = CAPABILITY_BADGE_SPECS[id] || { tone: 'subtle', descZh: id, descEn: id };
      const label = formatBadgeLabel(id, capabilities, loc);
      const tip = loc === 'en' ? spec.descEn : spec.descZh;
      return `<span class="cap-badge tone-${escapeHtml(spec.tone)}" title="${escapeHtml(tip)}">${escapeHtml(label)}</span>`;
    })
    .join('');
}

function getFilteredPlugins() {
  const list = state.serverState?.catalog?.plugins || [];
  const loc = state.serverState?.prefs?.locale || 'zh';
  const q = state.search.trim().toLowerCase();

  const filtered = list.filter((p) => {
    if (state.category !== 'all') {
      const cats = p.taxonomy?.categories || [];
      if (!cats.includes(state.category)) return false;
    }
    if (!q) return true;
    const desc = typeof p.description === 'object' ? `${p.description.zh || ''} ${p.description.en || ''}` : String(p.description || '');
    const hay = `${p.displayName || ''} ${p.canonicalName || ''} ${p.scopedName || ''} ${p.id || ''} ${desc} ${(p.taxonomy?.tags || []).join(' ')}`.toLowerCase();
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

function renderPluginCard(p) {
  const loc = state.serverState?.prefs?.locale || 'zh';
  const desc =
    typeof p.description === 'object'
      ? p.description[loc] || p.description.zh || p.description.en || ''
      : String(p.description || '');
  const st = p.installStatus || {};
  const isBusy = state.busyId === p.id;
  const monogram = String(p.displayName || p.canonicalName || 'P').trim().charAt(0).toUpperCase();

  let actionBtn = '';
  if (isBusy) {
    actionBtn = `<button class="btn btn-primary" disabled>${t('处理中…', 'Working…')}</button>`;
  } else if (st.installed && st.hasUpdate) {
    actionBtn = `<button class="btn btn-update" data-action="install" data-id="${escapeHtml(p.id)}">${t(`更新 v${p.version}`, `Update v${p.version}`)}</button>`;
  } else if (st.installed) {
    actionBtn = `<button class="btn" disabled>${t('已安装', 'Installed')} ✓</button>`;
  } else {
    actionBtn = `<button class="btn btn-primary" data-action="install" data-id="${escapeHtml(p.id)}">${t('一键安装', 'Install')}</button>`;
  }

  const effectiveSlug = p.forceScopedInstall ? p.scopedName : p.canonicalName;

  return `
    <article class="plugin-card">
      <div class="card-head" data-action="detail" data-id="${escapeHtml(p.id)}">
        <div class="plugin-logo">
          ${p.media?.iconUrl ? `<img src="${escapeHtml(p.media.iconUrl)}" alt="" loading="lazy" onerror="this.remove()" />` : escapeHtml(monogram)}
        </div>
        <div class="card-title-wrap">
          <div class="card-title-row">
            <span class="card-title">${escapeHtml(p.displayName || p.canonicalName)}</span>
            <span class="version-tag">v${escapeHtml(p.version)}</span>
            ${p.forceScopedInstall ? `<span class="track-tag" title="Track 2 Experimental Topic">${t('实验源·隔离安装', 'Track-2 Scoped')}</span>` : ''}
          </div>
          <div class="card-slug">${escapeHtml(effectiveSlug)} · ★ ${Number(p.repository?.stars || 0)}</div>
        </div>
      </div>

      <p class="card-desc" data-action="detail" data-id="${escapeHtml(p.id)}">${escapeHtml(desc)}</p>

      <div class="badge-row">
        ${renderBadgesHtml(p.capabilities)}
      </div>

      <div class="card-foot">
        <div class="foot-links">
          ${st.sidecarPane?.uri ? `<a class="pill-link" href="${escapeHtml(st.sidecarPane.uri)}">${t('打开面板', 'Open Pane')}</a>` : ''}
          ${st.customizationUri ? `<a class="pill-link" href="${escapeHtml(st.customizationUri)}">${t('管理', 'Manage')}</a>` : ''}
        </div>
        ${actionBtn}
      </div>
    </article>
  `;
}

function renderDiscoverView() {
  const prefs = state.serverState?.prefs || {};
  const loc = prefs.locale || 'zh';
  const plugins = getFilteredPlugins();

  const categoryOpts = Object.entries(CATEGORY_LABELS)
    .map(
      ([key, labels]) =>
        `<option value="${escapeHtml(key)}" ${state.category === key ? 'selected' : ''}>${escapeHtml(labels[loc] || labels.zh)}</option>`,
    )
    .join('');

  return `
    <div class="toolbar">
      <input
        id="market-search-input"
        class="search-input"
        type="search"
        placeholder="${escapeHtml(t('搜索插件名称、功能、MCP 或标签…', 'Search plugins, capabilities, or tags…'))}"
        value="${escapeHtml(state.search)}"
      />
      <select id="market-cat-select" class="select-input">${categoryOpts}</select>
      <select id="market-sort-select" class="select-input">
        <option value="stars" ${state.sortBy === 'stars' ? 'selected' : ''}>${escapeHtml(t('按星标排序', 'Most Stars'))}</option>
        <option value="updated" ${state.sortBy === 'updated' ? 'selected' : ''}>${escapeHtml(t('最近更新', 'Recently Updated'))}</option>
        <option value="name" ${state.sortBy === 'name' ? 'selected' : ''}>${escapeHtml(t('按名称排序', 'Name A-Z'))}</option>
      </select>
      <label class="track2-toggle ${prefs.enableExperimentalTrack2 ? 'enabled' : ''}">
        <input id="track2-checkbox" type="checkbox" ${prefs.enableExperimentalTrack2 ? 'checked' : ''} style="margin:0" />
        <span>${escapeHtml(t('实验性 Topic 自动发现 (Track 2)', 'Experimental Topic Feed (Track 2)'))}</span>
      </label>
    </div>

    <div class="main-scroll">
      ${
        state.loading && !plugins.length
          ? `<div class="empty-state">${escapeHtml(t('正在同步实时插件目录…', 'Syncing live plugin catalog…'))}</div>`
          : plugins.length
            ? `<div class="cards-grid">${plugins.map(renderPluginCard).join('')}</div>`
            : `<div class="empty-state">
                <div style="font-weight:700;margin-bottom:6px">${escapeHtml(t('当前筛选条件下暂无插件', 'No matching plugins in current feed'))}</div>
                <div>${escapeHtml(t('可在「镜像与源设置」配置自定义目录源，或前往 agy-market-catalog 提交首个社区插件 PR。', 'Configure a custom feed in Sources or submit a YAML PR in agy-market-catalog.'))}</div>
              </div>`
      }
    </div>
  `;
}

function renderInstalledView() {
  const installed = state.serverState?.installed || [];
  const updatesMap = new Map((state.serverState?.updatesAvailable || []).map((u) => [u.installedDir, u]));
  const catalogById = new Map((state.serverState?.catalog?.plugins || []).map((p) => [p.id, p]));

  return `
    <div class="main-scroll">
      ${
        installed.length === 0
          ? `<div class="empty-state">${escapeHtml(t('尚未检测到已安装的插件。', 'No local plugins detected yet.'))}</div>`
          : `<div class="cards-grid">
              ${installed
                .map((loc) => {
                  const upd = updatesMap.get(loc.dir);
                  const catEntry = upd ? catalogById.get(upd.id) : loc.receipt ? catalogById.get(loc.receipt.id) : null;
                  return `
                    <article class="plugin-card">
                      <div class="card-head">
                        <div class="plugin-logo">${escapeHtml(loc.displayName.charAt(0).toUpperCase())}</div>
                        <div class="card-title-wrap">
                          <div class="card-title-row">
                            <span class="card-title">${escapeHtml(loc.displayName)}</span>
                            <span class="version-tag">v${escapeHtml(loc.version)}</span>
                            <span class="cap-badge ${loc.enabled ? 'tone-green' : 'tone-subtle'}">${escapeHtml(loc.enabled ? t('已启用', 'Enabled') : t('已停用', 'Disabled'))}</span>
                          </div>
                          <div class="card-slug">${escapeHtml(loc.dir)} · ${escapeHtml(loc.scope)}</div>
                        </div>
                      </div>
                      <p class="card-desc">${escapeHtml(loc.description || '')}</p>
                      ${loc.receipt?.grantedCapabilities ? `<div class="badge-row">${renderBadgesHtml(loc.receipt.grantedCapabilities)}</div>` : ''}
                      <div class="card-foot">
                        <div class="foot-links">
                          ${loc.sidecarPane?.uri ? `<a class="pill-link" href="${escapeHtml(loc.sidecarPane.uri)}">${escapeHtml(t('打开面板', 'Open Pane'))}</a>` : ''}
                          <a class="pill-link" href="${escapeHtml(loc.customizationUri)}">${escapeHtml(t('启用/停用/卸载', 'Manage in Host'))}</a>
                        </div>
                        ${
                          upd && catEntry
                            ? `<button class="btn btn-update" data-action="install" data-id="${escapeHtml(catEntry.id)}">${escapeHtml(t(`升级至 v${upd.latestVersion}`, `Update v${upd.latestVersion}`))}</button>`
                            : ''
                        }
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

  return `
    <div class="main-scroll">
      <form id="sources-form" class="settings-panel">
        <div class="field-card">
          <div class="field-label">${escapeHtml(t('当前目录通道状态', 'Active Catalog Transport'))}</div>
          <p class="field-hint">
            ${escapeHtml(t('通道', 'Channel'))}: <strong>${escapeHtml(cat.channelUsed || 'n/a')}</strong> ·
            ${escapeHtml(t('目录版本', 'Catalog Version'))}: <strong>${escapeHtml(cat.catalogVersion || 'n/a')}</strong>
          </p>
        </div>

        <div class="field-card">
          <label class="field-label" for="net-mode-select">${escapeHtml(t('目录镜像与国内网络模式', 'Catalog Mirror & Network Mode'))}</label>
          <p class="field-hint">${escapeHtml(t('自动模式下优先通过 ETag 304 请求 GitHub Pages，超时 (>3.5s) 自动无缝切换至 npmmirror / 腾讯云 @agy-market/catalog 纯 JSON 镜像包。', 'Auto mode queries GitHub Pages with ETag 304 and falls back to @agy-market/catalog on npmmirror / Tencent mirror on timeout.'))}</p>
          <select id="net-mode-select" class="select-input">
            <option value="auto" ${prefs.networkMode === 'auto' ? 'selected' : ''}>${escapeHtml(t('自动切换 (GitHub Pages -> 国内镜像兜底)', 'Auto (GitHub Pages -> China Mirror Fallback)'))}</option>
            <option value="china-mirror" ${prefs.networkMode === 'china-mirror' ? 'selected' : ''}>${escapeHtml(t('国内镜像优先 (npmmirror / 腾讯云)', 'China Mirror Priority (npmmirror / Tencent)'))}</option>
            <option value="direct" ${prefs.networkMode === 'direct' ? 'selected' : ''}>${escapeHtml(t('仅直连主源 (Direct Only)', 'Direct Primary Only'))}</option>
          </select>
        </div>

        <div class="field-card">
          <label class="field-label" for="mirror-prefix-input">${escapeHtml(t('GitHub Release 下载加速前缀 (SHA-256 强校验防篡改)', 'GitHub Release Download Mirror Prefix (SHA-256 Verified)'))}</label>
          <p class="field-hint">${escapeHtml(t('可选。例如填写加速代理前缀后，下载的 .tar.gz 仍会强制比对权威目录中的 SHA-256 摘要，杜绝任何中间人篡改。', 'Optional mirror prefix for GitHub Release tarballs. Every download is verified against the catalog SHA-256 before unpacking.'))}</p>
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

        <div>
          <button type="submit" class="btn btn-primary">${escapeHtml(t('保存并重新同步目录', 'Save & Revalidate Catalog'))}</button>
        </div>
      </form>
    </div>
  `;
}

function renderModals() {
  let html = '';

  if (state.detailPlugin) {
    const p = state.detailPlugin;
    html += `
      <div class="modal-backdrop" data-action="close-modal">
        <div class="modal-box" onclick="event.stopPropagation()">
          <div class="modal-header">
            <span>${escapeHtml(p.displayName || p.canonicalName)} <span class="version-tag">v${escapeHtml(p.version)}</span></span>
            <button class="btn" data-action="close-modal">✕</button>
          </div>
          <div class="modal-body">
            <div class="badge-row">${renderBadgesHtml(p.capabilities)}</div>
            <div class="meta-kv">
              <span class="muted">ID / Name</span><span>${escapeHtml(p.id)} (${escapeHtml(p.forceScopedInstall ? p.scopedName : p.canonicalName)})</span>
              <span class="muted">Repository</span><span><a class="pill-link" href="${escapeHtml(p.repository?.url || '#')}" target="_blank" rel="noopener noreferrer">${escapeHtml(p.repository?.url || '')}</a></span>
              <span class="muted">Git Tag / SHA</span><span>${escapeHtml(p.gitTag || '')} · ${escapeHtml(String(p.commitSha || '').slice(0, 12))}</span>
              <span class="muted">SHA-256</span><span>${escapeHtml(p.distribution?.sha256 || '')}</span>
            </div>
            <div>
              ${state.detailLoading ? `<p class="muted">${escapeHtml(t('正在加载 README…', 'Loading README…'))}</p>` : renderSafeMarkdown(state.detailReadme)}
            </div>
          </div>
          <div class="modal-footer">
            <button class="btn" data-action="close-modal">${escapeHtml(t('关闭', 'Close'))}</button>
            <button class="btn btn-primary" data-action="install" data-id="${escapeHtml(p.id)}">${escapeHtml(p.installStatus?.installed ? t('重新同步 / 更新', 'Sync / Update') : t('立即安装并启用', 'Install Now'))}</button>
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
            <span>${escapeHtml(t('检测到本地同名插件冲突', 'Local Plugin Name Collision Detected'))}</span>
            <button class="btn" data-action="close-modal">✕</button>
          </div>
          <div class="modal-body">
            <p>${escapeHtml(t(`本地已存在来自其他来源的插件 "${cm.conflict.dir}" (${cm.conflict.scope})。Antigravity 对同名插件会静默丢弃后者，请选择安装方式：`, `A local plugin "${cm.conflict.dir}" (${cm.conflict.scope}) already claims this identifier. Choose how to proceed:`))}</p>
          </div>
          <div class="modal-footer">
            <button class="btn" data-action="close-modal">${escapeHtml(t('取消', 'Cancel'))}</button>
            ${
              cm.choices.includes('replace')
                ? `<button class="btn" data-action="resolve-conflict" data-strategy="replace">${escapeHtml(t('覆盖替换本地同名插件', 'Replace Existing Local Plugin'))}</button>`
                : ''
            }
            <button class="btn btn-primary" data-action="resolve-conflict" data-strategy="isolate">
              ${escapeHtml(t(`隔离安装为 ${cm.scopedFallbackName}`, `Install Isolated as ${cm.scopedFallbackName}`))}
            </button>
          </div>
        </div>
      </div>
    `;
  }

  if (state.escalationModal) {
    const em = state.escalationModal;
    html += `
      <div class="modal-backdrop" data-action="close-modal">
        <div class="modal-box" onclick="event.stopPropagation()">
          <div class="modal-header">
            <span>${escapeHtml(t('版本更新包含新增能力声明', 'Update Adds New Capabilities'))}</span>
            <button class="btn" data-action="close-modal">✕</button>
          </div>
          <div class="modal-body">
            <p>${escapeHtml(t(`插件 "${em.plugin.displayName}" 从 v${em.installedVersion} 升级至 v${em.targetVersion} 新增了以下能力：`, `Updating "${em.plugin.displayName}" from v${em.installedVersion} to v${em.targetVersion} introduces new capabilities:`))}</p>
            <div class="badge-row">${renderBadgesHtml({ badges: em.escalation.addedBadges })}</div>
            ${
              em.escalation.addedRemoteDomains?.length
                ? `<p class="muted">${escapeHtml(t('新增远程 MCP 域名', 'New Remote MCP Domains'))}: ${escapeHtml(em.escalation.addedRemoteDomains.join(', '))}</p>`
                : ''
            }
            ${
              em.escalation.addedHookEvents?.length
                ? `<p class="muted">${escapeHtml(t('新增生命周期钩子', 'New Lifecycle Hooks'))}: ${escapeHtml(em.escalation.addedHookEvents.join(', '))}</p>`
                : ''
            }
          </div>
          <div class="modal-footer">
            <button class="btn" data-action="close-modal">${escapeHtml(t('暂不更新', 'Cancel'))}</button>
            <button class="btn btn-primary" data-action="confirm-escalation">${escapeHtml(t('确认并立即更新', 'Confirm & Update'))}</button>
          </div>
        </div>
      </div>
    `;
  }

  return html;
}

function render() {
  const root = document.getElementById('app');
  if (!root) return;

  const focusId = document.activeElement?.id || '';
  const selStart = document.activeElement?.selectionStart ?? null;
  const selEnd = document.activeElement?.selectionEnd ?? null;

  const catalogCount = state.serverState?.catalog?.plugins?.length || 0;
  const installedCount = state.serverState?.installed?.length || 0;
  const updatesCount = state.serverState?.updatesAvailable?.length || 0;
  const curLocale = state.serverState?.prefs?.locale || 'zh';

  root.innerHTML = `
    <div class="market-shell">
      <header class="topbar">
        <div class="brand">
          <div class="brand-icon">◆</div>
          <div>
            <div class="brand-title">${escapeHtml(t('AGY Market · 反重力插件市场', 'AGY Market · Plugin Marketplace'))}</div>
            <div class="brand-sub">${escapeHtml(state.serverState?.catalog?.channelUsed || t('零 Token 辅助面板', 'Zero-Token Sidecar'))}</div>
          </div>
        </div>
        <div class="top-actions">
          <button class="btn" data-action="toggle-locale">${curLocale === 'en' ? '中文' : 'EN'}</button>
          <button class="btn" data-action="refresh" ${state.loading ? 'disabled' : ''}>↻ ${escapeHtml(t('刷新', 'Refresh'))}</button>
        </div>
      </header>

      <nav class="nav-tabs">
        <button class="tab-btn ${state.activeTab === 'discover' ? 'active' : ''}" data-action="tab" data-tab="discover">
          ${escapeHtml(t('探索市场', 'Discover'))} <span class="count-pill">${catalogCount}</span>
        </button>
        <button class="tab-btn ${state.activeTab === 'installed' ? 'active' : ''}" data-action="tab" data-tab="installed">
          ${escapeHtml(t('已安装 / 更新', 'Installed'))} <span class="count-pill">${updatesCount > 0 ? `${installedCount} · ↑${updatesCount}` : installedCount}</span>
        </button>
        <button class="tab-btn ${state.activeTab === 'sources' ? 'active' : ''}" data-action="tab" data-tab="sources">
          ${escapeHtml(t('镜像与源设置', 'Sources & Mirrors'))}
        </button>
      </nav>

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
          ? `<div class="toast-bar">
              <span>${escapeHtml(state.toast.message)}</span>
              ${state.toast.extraUri ? `<a class="pill-link" href="${escapeHtml(state.toast.extraUri)}">${escapeHtml(t('打开', 'Open'))}</a>` : ''}
            </div>`
          : ''
      }
    </div>
  `;

  bindDomEvents(root);

  if (focusId) {
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

function bindDomEvents(root) {
  const searchEl = root.querySelector('#market-search-input');
  if (searchEl) {
    searchEl.addEventListener('input', (e) => {
      state.search = e.target.value;
      render();
    });
  }

  const catEl = root.querySelector('#market-cat-select');
  if (catEl) {
    catEl.addEventListener('change', (e) => {
      state.category = e.target.value;
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
      void updatePrefs({ networkMode, githubReleaseMirrorPrefix, primaryCatalogUrl, customFeeds });
    });
  }

  root.querySelectorAll('[data-action]').forEach((el) => {
    el.addEventListener('click', (e) => {
      const action = el.getAttribute('data-action');
      if (action === 'tab') {
        state.activeTab = el.getAttribute('data-tab') || 'discover';
        render();
      } else if (action === 'refresh') {
        void loadState(true);
      } else if (action === 'toggle-locale') {
        const nextLocale = (state.serverState?.prefs?.locale || 'zh') === 'en' ? 'zh' : 'en';
        void updatePrefs({ locale: nextLocale });
      } else if (action === 'close-modal') {
        state.detailPlugin = null;
        state.conflictModal = null;
        state.escalationModal = null;
        render();
      } else if (action === 'detail') {
        const id = el.getAttribute('data-id');
        const p = (state.serverState?.catalog?.plugins || []).find((x) => x.id === id);
        if (p) void openPluginDetail(p);
      } else if (action === 'install') {
        e.stopPropagation();
        const id = el.getAttribute('data-id');
        const p = (state.serverState?.catalog?.plugins || []).find((x) => x.id === id) || state.detailPlugin;
        if (p) void triggerInstall(p);
      } else if (action === 'resolve-conflict' && state.conflictModal) {
        const strategy = el.getAttribute('data-strategy') || 'isolate';
        void triggerInstall(state.conflictModal.plugin, { conflictStrategy: strategy });
      } else if (action === 'confirm-escalation' && state.escalationModal) {
        void triggerInstall(state.escalationModal.plugin, { confirmEscalation: true });
      }
    });
  });
}

if (window.sidecar?.onWorkspaceChange) {
  window.sidecar.onWorkspaceChange((uris) => {
    state.workspaceUris = uris;
    void loadState(false);
  });
}

void loadState(false);
