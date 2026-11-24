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

  const CATEGORY_ACCENTS = {
    'ui-themes': ['#a855f7', '#ec4899'],
    'developer-tools': ['#6366f1', '#06b6d4'],
    productivity: ['#38bdf8', '#14b8a6'],
    'mcp-integrations': ['#f59e0b', '#f97316'],
    'skills-workflows': ['#10b981', '#34d399'],
    security: ['#f43f5e', '#f59e0b'],
  };

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

  function renderGrid() {
    const grid = document.getElementById('site-grid');
    const q = (document.getElementById('site-search').value || '').trim().toLowerCase();
    const cat = document.getElementById('site-category').value || 'all';

    const list = plugins.filter((p) => {
      if (cat !== 'all' && !(p.taxonomy?.categories || []).includes(cat)) return false;
      if (!q) return true;
      const desc = typeof p.description === 'object' ? `${p.description.zh || ''} ${p.description.en || ''}` : String(p.description || '');
      return `${p.displayName || ''} ${p.canonicalName || ''} ${desc} ${(p.capabilities?.badges || []).join(' ')}`.toLowerCase().includes(q);
    });

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
  document.getElementById('site-load-btn').addEventListener('click', fetchCatalog);

  void fetchCatalog();
})();
