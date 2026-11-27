(function () {
  'use strict';

  const BADGE_LABELS = {
    'declarative-only': '纯声明式技能',
    'global-rules': '常驻规则',
    'sidecar-ui': 'Sidebar 侧边栏',
    'mcp-stdio': '本地 MCP 进程',
    'mcp-remote': '远程 MCP 服务',
    'lifecycle-hooks': '生命周期钩子',
    'host-enhancement': '宿主界面增强',
  };

  const BADGE_ICONS = {
    'declarative-only': 'leaf',
    'global-rules': 'rules',
    'sidecar-ui': 'panel',
    'mcp-stdio': 'chip',
    'mcp-remote': 'globe',
    'lifecycle-hooks': 'hook',
    'host-enhancement': 'spark',
  };

  const CATEGORY_LABELS = {
    'monitoring-quota': '状态与用量监控',
    'context-cache': '上下文与缓存加速',
    'ui-themes': '界面美化与汉化',
    'agents-reasoning': '多代理与思考控制',
    'developer-tools': '开发与版本工具',
    'mcp-integrations': '浏览器与系统 MCP',
    'skills-workflows': '技能包与工程方法',
    productivity: '效率与插件管理',
    'data-science': '数据与科学计算',
    'cloud-devops': '云原生与部署',
    'creative-media': '设计与多媒体',
    'writing-knowledge': '写作与知识库',
    automation: '定时与守护任务',
    security: '安全与审计',
    other: '其他扩展',
  };

  const byId = (id) => document.getElementById(id);
  const workspace = document.querySelector('.workspace');
  const mobile = matchMedia('(max-width: 760px)');
  const sidebar = byId('site-sidebar');
  const sidebarToggle = byId('sidebar-toggle');
  const canvas = document.querySelector('.canvas');
  const grid = byId('site-grid');
  const search = byId('site-search');
  const category = byId('site-category');
  const discovery = byId('site-discovery-toggle');
  const discoveryStatus = byId('discovery-status');
  const sort = byId('site-sort');
  const peek = byId('site-peek');
  const palette = byId('site-palette');
  const paletteInput = byId('palette-input');
  const paletteResults = byId('palette-results');
  const pages = [...document.querySelectorAll('[data-page]')].map((button) => ({
    id: button.dataset.page,
    label: button.lastChild.textContent.trim(),
    button,
  }));
  const copyTimers = new WeakMap();
  const discoveryCache = new Map();
  let verifiedPlugins = [];
  let activeFeedUrl;
  let plugins = [];
  let visiblePlugins = [];
  let paletteItems = [];
  let activeResult = -1;
  let view = 'grid';
  let page = 'catalog';
  let feedRequest;
  let feedStatus = 'loading';

  function escapeHtml(s) {
    return String(s ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function isSafeUrl(u) {
    try {
      return ['http:', 'https:'].includes(new URL(u).protocol);
    } catch {
      return false;
    }
  }

  function getFiniteRankingScore(p) {
    const raw = p && p.ranking ? p.ranking.score : null;
    if (raw === null || raw === undefined || raw === '') return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  }

  function sortPluginsList(items, sortBy) {
    const list = Array.isArray(items) ? items.slice() : [];
    if (sortBy === 'updated') {
      return list.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
    }
    if (sortBy === 'name') {
      return list.sort((a, b) =>
        String(a.displayName || a.canonicalName || a.id || '').localeCompare(
          String(b.displayName || b.canonicalName || b.id || ''),
          'zh',
        ),
      );
    }
    if (sortBy === 'stars') {
      return list.sort((a, b) => Number(b.repository?.stars || 0) - Number(a.repository?.stars || 0));
    }

    // Default: 'recommended' (ranking.score fallback to stars + Monorepo viewport slot dampening 1 / (1 + 0.15 * (k - 1)))
    const hasAnyScore = list.some((p) => getFiniteRankingScore(p) !== null);
    const scored = list.map((p, idx) => {
      const explicit = getFiniteRankingScore(p);
      const stars = Math.max(0, Number(p.repository?.stars || 0));
      const baseKey =
        explicit !== null
          ? explicit
          : !hasAnyScore
            ? stars
            : stars > 0
              ? Math.min(85, (85 * Math.log1p(stars)) / Math.log1p(500))
              : 0;
      const repoId = Number(p.repository?.repositoryId || 0);
      return {
        plugin: p,
        idx,
        baseKey,
        stars,
        repoKey: Number.isFinite(repoId) && repoId > 0 ? String(Math.trunc(repoId)) : '',
      };
    });

    scored.sort((a, b) => {
      if (b.baseKey !== a.baseKey) return b.baseKey - a.baseKey;
      if (b.stars !== a.stars) return b.stars - a.stars;
      return a.idx - b.idx;
    });

    const repoCounts = new Map();
    const dampened = scored.map((entry) => {
      let factor = 1;
      if (entry.repoKey) {
        const k = (repoCounts.get(entry.repoKey) || 0) + 1;
        repoCounts.set(entry.repoKey, k);
        factor = 1 / (1 + 0.15 * (k - 1));
      }
      return { ...entry, dampenedKey: entry.baseKey * factor };
    });

    dampened.sort((a, b) => {
      if (b.dampenedKey !== a.dampenedKey) return b.dampenedKey - a.dampenedKey;
      if (b.baseKey !== a.baseKey) return b.baseKey - a.baseKey;
      if (b.stars !== a.stars) return b.stars - a.stars;
      return a.idx - b.idx;
    });

    return dampened.map((entry) => entry.plugin);
  }

  function titleOf(plugin) {
    return plugin.displayName || plugin.canonicalName || plugin.id || '未命名插件';
  }

  function descriptionOf(plugin, includeBoth = false) {
    const description = plugin.description;
    if (description && typeof description === 'object') {
      return includeBoth ? [description.zh, description.en].filter(Boolean).join(' ') : description.zh || description.en || '';
    }
    return String(description ?? '');
  }

  function categoriesOf(plugin) {
    return Array.isArray(plugin.taxonomy?.categories) ? plugin.taxonomy.categories : [];
  }

  function badgesOf(plugin) {
    return Array.isArray(plugin.capabilities?.badges) ? plugin.capabilities.badges : [];
  }

  function labelForCategory(id) {
    return Object.hasOwn(CATEGORY_LABELS, id) ? CATEGORY_LABELS[id] : id;
  }

  function labelForBadge(id) {
    return Object.hasOwn(BADGE_LABELS, id) ? BADGE_LABELS[id] : id;
  }

  function icon(name, className = '') {
    const size = name === 'empty' ? 64 : 20;
    return `<svg class="icon${className ? ` ${className}` : ''}" viewBox="0 0 ${size} ${size}" aria-hidden="true"><use href="#icon-${name}"/></svg>`;
  }

  function categoryIcon(id) {
    return Object.hasOwn(CATEGORY_LABELS, id) ? id : 'other';
  }

  function badgeIcon(id) {
    return Object.hasOwn(BADGE_ICONS, id) ? BADGE_ICONS[id] : 'layers';
  }

  function matchesPlugin(plugin, query) {
    if (!query) return true;
    const fields = [
      titleOf(plugin), plugin.canonicalName, plugin.id, plugin.scopedName, descriptionOf(plugin, true),
      ...categoriesOf(plugin).flatMap((id) => [id, labelForCategory(id)]),
      ...badgesOf(plugin).flatMap((id) => [id, labelForBadge(id)]),
      ...(Array.isArray(plugin.taxonomy?.tags) ? plugin.taxonomy.tags : []),
    ];
    return fields.join(' ').toLowerCase().includes(query);
  }

  function renderCategories() {
    const counts = new Map();
    for (const plugin of plugins) {
      for (const id of new Set(categoriesOf(plugin))) {
        if (typeof id === 'string' && id && id !== 'all') counts.set(id, (counts.get(id) || 0) + 1);
      }
    }
    const previous = category.value;
    const list = byId('site-category-list');
    const entries = [...counts].sort(([a], [b]) => labelForCategory(a).localeCompare(labelForCategory(b), 'zh'));
    category.replaceChildren(new Option('全部分类', 'all'));
    list.replaceChildren();
    for (const [id, count] of entries) {
      const label = labelForCategory(id);
      category.add(new Option(label, id));
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'sidebar-item sidebar-category';
      button.dataset.category = id;
      button.innerHTML = `${icon(categoryIcon(id))}<span class="category-label">${escapeHtml(label)}</span><span class="category-count">${count}</span>`;
      list.append(button);
    }
    list.closest('nav').hidden = !entries.length;
    category.value = counts.has(previous) ? previous : 'all';
  }

  function renderNavigation() {
    const isCatalog = page === 'catalog';
    const hasCategory = isCatalog && category.value !== 'all';
    byId('site-breadcrumb').textContent = hasCategory ? labelForCategory(category.value) : pages.find((item) => item.id === page).label;
    byId('catalog-title').textContent = hasCategory ? labelForCategory(category.value) : '全部插件';
    document.querySelector('.catalog-actions').hidden = !isCatalog;
    byId('catalog-heading').hidden = !isCatalog;
    byId('site-stats').hidden = !isCatalog;
    document.querySelector('.features-toggle').hidden = !isCatalog;
    byId('catalog-page').hidden = !isCatalog;
    byId('quick-install').hidden = page === 'settings';
    byId('settings-page').hidden = page !== 'settings';
    for (const item of pages) {
      if (item.id === page && !hasCategory) item.button.setAttribute('aria-current', 'page');
      else item.button.removeAttribute('aria-current');
    }
    for (const button of byId('site-category-list').children) {
      button.setAttribute('aria-pressed', String(hasCategory && button.dataset.category === category.value));
    }
  }

  function renderMark(plugin) {
    const primary = categoriesOf(plugin).find((id) => Object.hasOwn(CATEGORY_LABELS, id));
    const capability = badgesOf(plugin).find((id) => Object.hasOwn(BADGE_ICONS, id));
    const mark = primary ? categoryIcon(primary) : capability ? badgeIcon(capability) : 'other';
    return `<span class="plugin-mark" aria-hidden="true">${icon(mark)}</span>`;
  }

  function renderBadges(plugin, limit) {
    const badges = badgesOf(plugin).slice(0, limit ?? Infinity);
    const tags = badges.map((id) => `<span class="badge">${icon(badgeIcon(id))}${escapeHtml(labelForBadge(id))}</span>`);
    if (plugin.isDiscovery) tags.unshift(renderDiscoveryTag());
    return tags.length ? `<span class="badges">${tags.join('')}</span>` : '';
  }

  function renderDiscoveryTag() {
    return `<span class="badge discovery-tag" title="GitHub Topic 自动发现（未审核社区仓库）">${icon('discovery')}社区发现</span>`;
  }

  function renderStars(plugin) {
    const stars = Number(plugin.repository?.stars) || 0;
    return `<span class="star-count" aria-label="${stars} 个星标">${icon('star')}<span>${stars}</span></span>`;
  }

  function categoryLabelFor(plugin) {
    return escapeHtml(categoriesOf(plugin).map(labelForCategory).join(' / ') || '—');
  }

  function renderGrid(animate = false) {
    const query = search.value.trim().toLowerCase();
    const selected = category.value;
    visiblePlugins = sortPluginsList(plugins.filter((plugin) =>
      (selected === 'all' || categoriesOf(plugin).includes(selected)) && matchesPlugin(plugin, query),
    ), sort.value);
    byId('catalog-count').textContent = visiblePlugins.length === plugins.length
      ? `${plugins.length} 款`
      : `${visiblePlugins.length} / ${plugins.length} 款`;
    grid.className = view === 'grid' ? 'grid' : 'table-wrap';

    if (!visiblePlugins.length) {
      if (feedStatus === 'loading') grid.innerHTML = '<p class="empty">正在同步目录…</p>';
      else if (feedStatus === 'error' && !plugins.length) grid.innerHTML = '<p class="empty">无法连接目录。<button type="button" class="settings-link" data-settings>打开目录设置</button></p>';
      else grid.innerHTML = `<p class="empty empty-results" role="status">${icon('empty')}${plugins.length ? '没有匹配的插件。' : '该目录暂无插件。'}</p>`;
      return;
    }

    if (view === 'table') {
      const rows = visiblePlugins.map((plugin, index) => `
        <tr data-plugin="${index}">
          <td><button type="button" class="table-title" aria-haspopup="dialog">${renderMark(plugin)}${escapeHtml(titleOf(plugin))}${plugin.isDiscovery ? renderDiscoveryTag() : ''}${icon('chevron-right', 'card-arrow')}</button></td>
          <td>${categoryLabelFor(plugin)}</td>
          <td class="table-version">${plugin.version ? `v${escapeHtml(plugin.version)}` : '—'}</td>
          <td>${renderStars(plugin)}</td>
        </tr>`).join('');
      grid.innerHTML = `<table class="table" aria-label="插件目录"><thead><tr><th scope="col">插件</th><th scope="col">分类</th><th scope="col">版本</th><th scope="col">星标</th></tr></thead><tbody>${rows}</tbody></table>`;
      return;
    }

    grid.innerHTML = visiblePlugins.map((plugin, index) => `
      <button type="button" class="card${animate && index < 12 ? ' entering' : ''}" data-plugin="${index}" aria-haspopup="dialog"${animate && index < 12 ? ` style="--enter-delay:${Math.min(index, 6) * 25}ms"` : ''}>
        <span class="card-top">${renderMark(plugin)}${icon('chevron-right', 'card-arrow')}</span>
        <span class="card-title">${escapeHtml(titleOf(plugin))}</span>
        <span class="card-description">${escapeHtml(descriptionOf(plugin))}</span>
        ${renderBadges(plugin, 3)}
        <span class="card-bottom"><span>${categoryLabelFor(plugin)}</span>${renderStars(plugin)}</span>
      </button>`).join('');
  }

  const DEFAULT_PAGES_FEED_URL = 'https://azwosile.github.io/agy-market-catalog/index.json';
  const RAW_GH_PAGES_FEED_URL = 'https://raw.githubusercontent.com/azwosile/agy-market-catalog/gh-pages/index.json';

  async function fetchFeed(url, signals = []) {
    if (!isSafeUrl(url)) return;
    const signal = AbortSignal.any([...signals, AbortSignal.timeout(6500)]);
    const response = await fetch(url, { headers: { Accept: 'application/json' }, signal });
    if (!response.ok) return;
    const json = await response.json();
    if (Array.isArray(json?.plugins)) {
      return json.plugins.filter((plugin) => plugin && typeof plugin === 'object' && !Array.isArray(plugin));
    }
  }

  function mergeDiscovery(items) {
    const seenIds = new Set();
    const seenRoots = new Set();
    return [...verifiedPlugins, ...items.map((plugin) => ({ ...plugin, isDiscovery: true }))].filter((plugin) => {
      const repoId = Number(plugin.repository?.repositoryId);
      const root = String(plugin.repository?.pluginRoot || '.')
        .trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+|\/+$/g, '') || '.';
      const key = repoId > 0 ? `${repoId}:${root}` : '';
      if ((plugin.id && seenIds.has(plugin.id)) || (key && seenRoots.has(key))) return false;
      if (plugin.id) seenIds.add(plugin.id);
      if (key) seenRoots.add(key);
      return true;
    });
  }

  function renderCatalog(items, animate = false) {
    plugins = items;
    byId('stat-total').textContent = activeFeedUrl ? `${items.length} 款` : '—';
    renderCategories();
    renderNavigation();
    renderGrid(animate);
    if (palette.open) renderPalette();
  }

  async function fetchDiscovery(url) {
    const feeds = (url === DEFAULT_PAGES_FEED_URL ? [url, RAW_GH_PAGES_FEED_URL] : [url])
      .map((feed) => new URL('unverified-index.json', feed).href);
    for (const feed of feeds) {
      try {
        const items = await fetchFeed(feed);
        if (items) return items;
      } catch {
        // Try the next discovery source.
      }
    }
  }

  async function syncDiscovery(animate = false) {
    discoveryStatus.textContent = '';
    const url = activeFeedUrl;
    if (!discovery.checked || !url) {
      renderCatalog(verifiedPlugins, animate);
      return;
    }

    let pending = discoveryCache.get(url);
    if (!pending) {
      pending = fetchDiscovery(url);
      discoveryCache.set(url, pending);
    }
    discoveryStatus.textContent = '正在同步社区发现…';
    const items = await pending;
    if (!items && discoveryCache.get(url) === pending) discoveryCache.delete(url);
    if (!discovery.checked || url !== activeFeedUrl) return;
    discoveryStatus.textContent = items ? '' : '社区发现同步失败。关闭后重新开启可重试。';
    renderCatalog(items ? mergeDiscovery(items) : verifiedPlugins, animate);
  }

  async function fetchCatalog() {
    feedRequest?.abort();
    const request = new AbortController();
    feedRequest = request;
    const url = byId('site-feed-url').value.trim();
    const candidates = url === DEFAULT_PAGES_FEED_URL
      ? [[url, 'GitHub Pages'], [RAW_GH_PAGES_FEED_URL, 'GitHub Raw 镜像']]
      : [[url, '自定义目录']];
    const channels = [byId('stat-channel'), byId('settings-channel')];
    const loadButton = byId('site-load-btn');
    feedStatus = 'loading';
    loadButton.setAttribute('aria-busy', 'true');
    for (const channel of channels) {
      channel.textContent = '同步中…';
      channel.classList.remove('has-error');
    }
    grid.setAttribute('aria-busy', 'true');
    let loaded;
    let channelName;
    for (const [candidate, name] of candidates) {
      try {
        loaded = await fetchFeed(candidate, [request.signal]);
        if (loaded) {
          channelName = name;
          break;
        }
      } catch {
        if (request.signal.aborted) return;
      }
    }
    if (request.signal.aborted) return;
    feedStatus = loaded ? 'ready' : 'error';
    loadButton.removeAttribute('aria-busy');
    if (loaded) {
      activeFeedUrl = url;
      verifiedPlugins = loaded;
    }
    for (const channel of channels) {
      channel.textContent = loaded ? channelName : activeFeedUrl ? '同步失败，仍显示上次目录' : '连接失败，请检查目录地址';
      channel.classList.toggle('has-error', !loaded);
    }
    grid.setAttribute('aria-busy', 'false');
    renderCatalog(loaded || plugins, Boolean(loaded) && !discovery.checked);
    if (loaded && discovery.checked) void syncDiscovery(true);
  }

  function openPeek(plugin) {
    const repoUrl = String(plugin.repository?.url || '').trim();
    const repo = isSafeUrl(repoUrl) ? new URL(repoUrl) : null;
    const github = repo?.hostname.toLowerCase() === 'github.com' && !repo.username && !repo.password && !repo.port;
    const baseRepo = github && repo.pathname.match(/^\/[a-z0-9_.-]+\/[a-z0-9_.-]+(?=\/|$)/i)?.[0];
    const discussions = baseRepo ? `${repo.origin}${baseRepo.replace(/\.git$/i, '')}/discussions` : '';
    // The command is pasted into a shell. Only include GitHub paths without shell metacharacters.
    const command = baseRepo && /^https?:\/\/github\.com\/[a-z0-9_.\/-]+$/i.test(repoUrl)
      ? `npx --yes github:azwosile/agy-market add ${repoUrl}`
      : '';
    byId('peek-content').innerHTML = `
      ${renderMark(plugin)}
      <h2 id="peek-title">${escapeHtml(titleOf(plugin))}</h2>
      <p class="peek-meta">${plugin.version ? `v${escapeHtml(plugin.version)} · ` : ''}${renderStars(plugin)}</p>
      <p class="peek-desc">${escapeHtml(descriptionOf(plugin) || '暂无简介。')}</p>
      ${renderBadges(plugin)}
      ${repo ? `<div class="peek-links">
        <a href="${escapeHtml(repo.href)}" target="_blank" rel="noopener noreferrer">${icon(github ? 'github' : 'link')}${github ? 'GitHub 仓库' : '源码仓库'}${icon('external', 'peek-link-external')}</a>
        ${discussions ? `<a href="${escapeHtml(discussions)}" target="_blank" rel="noopener noreferrer">${icon('discussion')}讨论区${icon('external', 'peek-link-external')}</a>` : ''}
      </div>` : ''}
      ${command ? `<h3 class="peek-install-heading">添加插件</h3><div class="code-row">
        <code>${escapeHtml(command)}</code>
        <button type="button" class="copy-button"><span class="copy-icon" aria-hidden="true">${icon('copy')}${icon('check')}</span><span class="copy-label">复制命令</span></button>
      </div>` : ''}`;
    peek.showModal();
  }

  function syncSidebar() {
    if (!mobile.matches) workspace.classList.remove('mobile-open');
    const open = mobile.matches ? workspace.classList.contains('mobile-open') : !workspace.classList.contains('collapsed');
    sidebar.inert = !open;
    canvas.inert = mobile.matches && open;
    sidebarToggle.setAttribute('aria-expanded', String(open));
  }

  function closeMobileSidebar(restoreFocus = true) {
    if (!workspace.classList.contains('mobile-open')) return;
    workspace.classList.remove('mobile-open');
    syncSidebar();
    if (restoreFocus) sidebarToggle.focus();
  }

  function showPage(nextPage, nextCategory = 'all') {
    closeMobileSidebar(false);
    page = nextPage;
    if (page === 'catalog') {
      category.value = nextCategory;
      search.value = '';
    }
    renderNavigation();
    if (page === 'catalog') renderGrid();
    if (page === 'catalog' && nextCategory !== 'all') {
      byId('catalog-title').focus({ preventScroll: true });
      byId('catalog-page').scrollIntoView({ block: 'start' });
    } else {
      const heading = { catalog: 'workspace-title', install: 'install-heading', settings: 'settings-heading' }[page];
      byId(heading).focus({ preventScroll: true });
      window.scrollTo(0, 0);
    }
  }

  function setPressed(button, index) {
    for (const sibling of button.parentElement.children) {
      sibling.setAttribute('aria-pressed', String(sibling === button));
    }
    button.parentElement.style.setProperty('--selected', index);
  }

  function setPaletteSelection(index) {
    paletteResults.children[activeResult]?.setAttribute('aria-selected', 'false');
    activeResult = index;
    const option = paletteResults.children[index];
    if (option) {
      option.setAttribute('aria-selected', 'true');
      paletteInput.setAttribute('aria-activedescendant', option.id);
      option.scrollIntoView({ block: 'nearest' });
    } else {
      paletteInput.removeAttribute('aria-activedescendant');
    }
  }

  function renderPalette() {
    const query = paletteInput.value.trim().toLowerCase();
    paletteItems = [
      ...pages.filter((item) => `${item.label} ${item.id}`.includes(query)),
      ...sortPluginsList(plugins.filter((plugin) => matchesPlugin(plugin, query)), sort.value)
        .slice(0, 30).map((plugin) => ({ plugin, label: titleOf(plugin) })),
    ];
    paletteResults.innerHTML = paletteItems.map((item, index) => `
      <div id="palette-option-${index}" class="palette-option" role="option" aria-selected="false" data-option="${index}">
        <span>${escapeHtml(item.label)}</span><small>${item.plugin ? '插件' : '页面'}</small>
      </div>`).join('');
    byId('palette-empty').hidden = Boolean(paletteItems.length);
    paletteInput.setAttribute('aria-expanded', String(Boolean(paletteItems.length)));
    setPaletteSelection(paletteItems.length ? 0 : -1);
  }

  function openPalette() {
    closeMobileSidebar();
    if (palette.open) {
      paletteInput.focus();
      return;
    }
    if (peek.open) peek.close();
    paletteInput.value = '';
    palette.showModal();
    renderPalette();
  }

  function runPaletteItem(index) {
    const item = paletteItems[index];
    if (!item) return;
    palette.close();
    if (item.plugin) openPeek(item.plugin);
    else showPage(item.id);
  }

  function fallbackCopy(text, button) {
    const field = document.createElement('textarea');
    field.value = text;
    field.readOnly = true;
    field.style.cssText = 'position:fixed;inset:0 auto auto 0;opacity:0;pointer-events:none';
    (button.closest('dialog') || document.body).append(field);
    field.select();
    try {
      return document.execCommand('copy');
    } catch {
      return false;
    } finally {
      field.remove();
      button.focus({ preventScroll: true });
    }
  }

  function updateCopyLabel(button, label, copied) {
    button.querySelector('.copy-label').textContent = label;
    button.classList.toggle('is-copied', copied);
  }

  async function copyCommand(button) {
    const code = button.parentElement.querySelector('code');
    const text = code.textContent;
    let copied = false;
    try {
      await navigator.clipboard.writeText(text);
      copied = true;
    } catch {
      copied = fallbackCopy(text, button);
    }
    if (code.textContent !== text) return;
    clearTimeout(copyTimers.get(button));
    updateCopyLabel(button, copied ? '已复制' : '复制失败', copied);
    byId('copy-status').textContent = copied ? '已复制命令' : '复制失败，可手动选中命令';
    copyTimers.set(button, setTimeout(() => updateCopyLabel(button, '复制命令', false), 1600));
  }

  sidebarToggle.addEventListener('click', () => {
    workspace.classList.toggle(mobile.matches ? 'mobile-open' : 'collapsed');
    syncSidebar();
    if (mobile.matches) sidebar.querySelector('.sidebar-close').focus();
  });
  document.querySelector('.sidebar-close').addEventListener('click', () => closeMobileSidebar());
  document.querySelector('.sidebar-scrim').addEventListener('click', () => closeMobileSidebar());
  mobile.addEventListener('change', syncSidebar);
  syncSidebar();

  for (const item of pages) item.button.addEventListener('click', () => showPage(item.id));
  byId('site-category-list').addEventListener('click', (event) => {
    const item = event.target.closest('[data-category]');
    if (item) showPage('catalog', item.dataset.category);
  });
  search.addEventListener('input', () => renderGrid());
  discovery.addEventListener('change', () => void syncDiscovery());
  category.addEventListener('change', () => {
    renderNavigation();
    renderGrid();
  });
  sort.addEventListener('change', () => renderGrid());
  byId('site-feed-form').addEventListener('submit', (event) => {
    event.preventDefault();
    void fetchCatalog();
  });
  grid.addEventListener('click', (event) => {
    const item = event.target.closest('[data-plugin]');
    if (item) {
      const rowButton = item.querySelector('button');
      if (rowButton) rowButton.focus({ preventScroll: true });
      openPeek(visiblePlugins[Number(item.dataset.plugin)]);
    } else if (event.target.closest('[data-settings]')) {
      showPage('settings');
    }
  });
  byId('site-view-switch').querySelectorAll('[data-view]').forEach((button, index) => {
    button.addEventListener('click', () => {
      if (view === button.dataset.view) return;
      view = button.dataset.view;
      setPressed(button, index);
      renderGrid(true);
    });
  });

  const copyBoot = byId('copy-boot-btn');
  document.querySelectorAll('.boot-tab').forEach((button, index) => {
    button.addEventListener('click', () => {
      setPressed(button, index);
      byId('boot-cmd-text').textContent = button.dataset.cmd;
      clearTimeout(copyTimers.get(copyBoot));
      updateCopyLabel(copyBoot, '复制命令', false);
    });
  });
  document.addEventListener('click', (event) => {
    const copyButton = event.target.closest('.copy-button');
    if (copyButton) void copyCommand(copyButton);
    if (event.target.closest('[data-open-palette]')) openPalette();
    event.target.closest('[data-close-dialog]')?.closest('dialog').close();
  });
  for (const dialog of [palette, peek]) {
    dialog.addEventListener('click', (event) => {
      if (event.target !== dialog) return;
      const rect = dialog.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) {
        dialog.close();
      }
    });
  }

  paletteInput.addEventListener('input', renderPalette);
  paletteResults.addEventListener('click', (event) => {
    const option = event.target.closest('[data-option]');
    if (option) runPaletteItem(Number(option.dataset.option));
  });
  paletteInput.addEventListener('keydown', (event) => {
    if (event.isComposing || !paletteItems.length) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      setPaletteSelection((activeResult + step + paletteItems.length) % paletteItems.length);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      runPaletteItem(activeResult);
    }
  });

  document.addEventListener('keydown', (event) => {
    if (event.isComposing || event.defaultPrevented) return;
    if (event.key === 'Escape' && !palette.open && !peek.open) closeMobileSidebar();
    const shortcut = (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k';
    const slash = event.key === '/' && !event.metaKey && !event.ctrlKey && !event.altKey
      && !event.target.closest('input, textarea, select, [contenteditable]');
    if (!shortcut && !slash) return;
    event.preventDefault();
    if (!palette.open) openPalette();
  });

  void fetchCatalog();
})();
