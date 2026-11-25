(function () {
  'use strict';

  const BADGE_LABELS = {
    'declarative-only': '🌿 纯声明式技能',
    'global-rules': '🔵 常驻规则',
    'sidecar-ui': '🟣 Sidebar 侧边栏',
    'mcp-stdio': '🟠 本地 MCP 进程',
    'mcp-remote': '🌐 远程 MCP 服务',
    'lifecycle-hooks': '🔶 生命周期钩子',
    'host-enhancement': '💡 宿主界面增强',
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

  const CATEGORY_ACCENTS = {
    'monitoring-quota': ['#06b6d4', '#3b82f6'],
    'context-cache': ['#14b8a6', '#6366f1'],
    'ui-themes': ['#a855f7', '#ec4899'],
    'agents-reasoning': ['#8b5cf6', '#f43f5e'],
    'developer-tools': ['#6366f1', '#06b6d4'],
    'mcp-integrations': ['#f59e0b', '#f97316'],
    'skills-workflows': ['#10b981', '#34d399'],
    productivity: ['#38bdf8', '#14b8a6'],
    'data-science': ['#3b82f6', '#8b5cf6'],
    'cloud-devops': ['#06b6d4', '#3b82f6'],
    'creative-media': ['#ec4899', '#f97316'],
    'writing-knowledge': ['#8b5cf6', '#38bdf8'],
    automation: ['#eab308', '#10b981'],
    security: ['#f43f5e', '#f59e0b'],
    other: ['#6366f1', '#38bdf8'],
  };

  function syncCategorySelectOptions(list) {
    const select = document.getElementById('site-category');
    if (!select) return;
    const existing = new Set(Array.from(select.options).map((opt) => opt.value));
    for (const p of list) {
      for (const rawCat of p.taxonomy?.categories || []) {
        const catId = String(rawCat || '').trim();
        if (!catId || existing.has(catId)) continue;
        existing.add(catId);
        const opt = document.createElement('option');
        opt.value = catId;
        opt.textContent = CATEGORY_LABELS[catId] || catId;
        select.appendChild(opt);
      }
    }
  }

  let plugins = [];

  function escapeHtml(s) {
    return String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function isSafeUrl(u) {
    return /^https?:\/\/[^\s]+$/i.test(String(u || '').trim());
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

  function renderGrid() {
    const grid = document.getElementById('site-grid');
    const q = (document.getElementById('site-search').value || '').trim().toLowerCase();
    const cat = document.getElementById('site-category').value || 'all';
    const sortEl = document.getElementById('site-sort');
    const sortBy = (sortEl && sortEl.value) || 'recommended';

    const filtered = plugins.filter((p) => {
      if (cat !== 'all' && !(p.taxonomy?.categories || []).includes(cat)) return false;
      if (!q) return true;
      const desc = typeof p.description === 'object' ? `${p.description.zh || ''} ${p.description.en || ''}` : String(p.description || '');
      const catTerms = (p.taxonomy?.categories || [])
        .map((c) => `${c} ${CATEGORY_LABELS[c] || ''}`)
        .join(' ');
      return `${p.displayName || ''} ${p.canonicalName || ''} ${desc} ${catTerms} ${(p.taxonomy?.tags || []).join(' ')} ${(p.capabilities?.badges || []).join(' ')}`.toLowerCase().includes(q);
    });
    const list = sortPluginsList(filtered, sortBy);

    const totalEl = document.getElementById('stat-total');
    if (totalEl) totalEl.textContent = `${plugins.length} 款`;

    if (!list.length) {
      grid.innerHTML = `<div class="empty">目录就绪（当前包含 ${plugins.length} 款已收录插件）。安装 AGY Market 客户端或向 <code>agy-market-catalog</code> 提交 YAML PR 即可在此实时展示。</div>`;
      return;
    }

    grid.innerHTML = list
      .map((p) => {
        const desc = typeof p.description === 'object' ? p.description.zh || p.description.en || '' : String(p.description || '');
        const badges = (p.capabilities?.badges || [])
          .map((b) => `<span class="badge">${escapeHtml(BADGE_LABELS[b] || b)}</span>`)
          .join('');
        const primaryCat = (p.taxonomy?.categories || [])[0] || '';
        const [a1, a2] = CATEGORY_ACCENTS[primaryCat] || ['#6366f1', '#06b6d4'];
        const title = p.displayName || p.canonicalName || p.id;
        const repoUrl = p.repository?.url || '';
        const titleHtml = isSafeUrl(repoUrl)
          ? `<a class="card-name-link" href="${escapeHtml(repoUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(title)} ↗</a>`
          : `<span class="card-name">${escapeHtml(title)}</span>`;
        const discussUrl = isSafeUrl(repoUrl) ? `${repoUrl.replace(/\/+$/, '')}/discussions` : '';

        return `
          <article class="card" style="--card-accent:${a1};--card-accent-2:${a2}">
            <div class="card-top">
              ${titleHtml}
              <span class="card-ver">v${escapeHtml(p.version)} · ★ ${Number(p.repository?.stars || 0)}</span>
            </div>
            <p class="card-desc">${escapeHtml(desc)}</p>
            <div class="badges">${badges}</div>
            <div class="card-dock">
              <span class="dock-slug">${escapeHtml(p.forceScopedInstall ? p.scopedName : p.canonicalName)}</span>
              <div class="dock-links">
                ${discussUrl ? `<a class="dock-link" href="${escapeHtml(discussUrl)}" target="_blank" rel="noopener noreferrer">讨论区</a>` : ''}
                ${isSafeUrl(repoUrl) ? `<a class="dock-link" href="${escapeHtml(repoUrl)}" target="_blank" rel="noopener noreferrer">GitHub ↗</a>` : ''}
              </div>
            </div>
          </article>
        `;
      })
      .join('');
  }

  const DEFAULT_PAGES_FEED_URL = 'https://azwosile.github.io/agy-market-catalog/index.json';
  const RAW_GH_PAGES_FEED_URL = 'https://raw.githubusercontent.com/azwosile/agy-market-catalog/gh-pages/index.json';

  async function fetchCatalog() {
    const url = document.getElementById('site-feed-url').value.trim();
    const candidates = url === DEFAULT_PAGES_FEED_URL ? [url, RAW_GH_PAGES_FEED_URL] : [url];
    const channelEl = document.getElementById('stat-channel');
    let loaded = null;
    let usedChannel = '离线缓存';
    for (const candidate of candidates) {
      try {
        const res = await fetch(candidate, { headers: { Accept: 'application/json' } });
        if (!res.ok) continue;
        const json = await res.json();
        if (Array.isArray(json.plugins)) {
          loaded = json.plugins;
          usedChannel = candidate.includes('raw.githubusercontent.com') ? 'GitHub Raw 镜像' : 'GitHub Pages';
          break;
        }
      } catch {
        /* try next candidate */
      }
    }
    plugins = loaded || [];
    syncCategorySelectOptions(plugins);
    if (channelEl) channelEl.textContent = loaded ? usedChannel : '等待连接';
    renderGrid();
  }

  document.querySelectorAll('.boot-tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.boot-tab').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById('boot-cmd-text').textContent = btn.getAttribute('data-cmd') || '';
    });
  });

  function execCommandCopyFallback(text) {
    const ta = document.createElement('textarea');
    ta.value = String(text || '');
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '-9999px';
    ta.style.left = '-9999px';
    ta.style.opacity = '0';
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

  document.getElementById('copy-boot-btn').addEventListener('click', async () => {
    const text = document.getElementById('boot-cmd-text').textContent || '';
    let copied = false;
    if (navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(text);
        copied = true;
      } catch {
        copied = execCommandCopyFallback(text);
      }
    } else {
      copied = execCommandCopyFallback(text);
    }
    if (copied) {
      const btn = document.getElementById('copy-boot-btn');
      btn.textContent = '已复制 ✓';
      setTimeout(() => {
        btn.textContent = '复制命令';
      }, 1800);
    }
  });

  document.getElementById('site-search').addEventListener('input', renderGrid);
  document.getElementById('site-category').addEventListener('change', renderGrid);
  const siteSortEl = document.getElementById('site-sort');
  if (siteSortEl) siteSortEl.addEventListener('change', renderGrid);
  document.getElementById('site-load-btn').addEventListener('click', fetchCatalog);

  void fetchCatalog();
})();
