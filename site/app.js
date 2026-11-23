(function () {
  'use strict';

  const BADGE_LABELS = {
    'declarative-only': '🟢 纯声明式 · 0进程',
    'global-rules': '🔵 常驻规则',
    'sidecar-ui': '🟣 Sidecar 面板 · 0 Token',
    'mcp-stdio': '🟠 本地 MCP 进程',
    'mcp-remote': '🌐 远程 MCP 服务',
    'lifecycle-hooks': '🔶 生命周期钩子',
    'host-enhancement': '💡 宿主界面增强',
  };

  let plugins = [];

  function escapeHtml(s) {
    return String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function renderGrid() {
    const grid = document.getElementById('site-grid');
    const q = (document.getElementById('site-search').value || '').trim().toLowerCase();
    const cat = document.getElementById('site-category').value || 'all';

    const list = plugins.filter((p) => {
      if (cat !== 'all' && !(p.taxonomy?.categories || []).includes(cat)) return false;
      if (!q) return true;
      const desc = typeof p.description === 'object' ? `${p.description.zh || ''} ${p.description.en || ''}` : String(p.description || '');
      return `${p.displayName || ''} ${p.canonicalName || ''} ${desc}`.toLowerCase().includes(q);
    });

    if (!list.length) {
      grid.innerHTML = `<div class="empty">目录就绪（当前包含 ${plugins.length} 个已收录插件）。安装 AGY Market 客户端或向 <code>agy-market-catalog</code> 提交 YAML PR 即可在此实时展示。</div>`;
      return;
    }

    grid.innerHTML = list
      .map((p) => {
        const desc = typeof p.description === 'object' ? p.description.zh || p.description.en || '' : String(p.description || '');
        const badges = (p.capabilities?.badges || [])
          .map((b) => `<span class="badge">${escapeHtml(BADGE_LABELS[b] || b)}</span>`)
          .join('');
        return `
          <article class="card">
            <div class="card-top">
              <span class="card-name">${escapeHtml(p.displayName || p.canonicalName)}</span>
              <span class="card-ver">v${escapeHtml(p.version)} · ★ ${Number(p.repository?.stars || 0)}</span>
            </div>
            <p class="card-desc">${escapeHtml(desc)}</p>
            <div class="badges">${badges}</div>
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
    let loaded = null;
    for (const candidate of candidates) {
      try {
        const res = await fetch(candidate, { headers: { Accept: 'application/json' } });
        if (!res.ok) continue;
        const json = await res.json();
        if (Array.isArray(json.plugins)) {
          loaded = json.plugins;
          break;
        }
      } catch {
        /* try next candidate */
      }
    }
    plugins = loaded || [];
    renderGrid();
  }

  document.querySelectorAll('.boot-tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.boot-tab').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById('boot-cmd-text').textContent = btn.getAttribute('data-cmd') || '';
    });
  });

  document.getElementById('copy-boot-btn').addEventListener('click', async () => {
    const text = document.getElementById('boot-cmd-text').textContent || '';
    try {
      await navigator.clipboard.writeText(text);
      const btn = document.getElementById('copy-boot-btn');
      btn.textContent = '已复制 ✓';
      setTimeout(() => {
        btn.textContent = '复制命令';
      }, 1800);
    } catch {
      /* ignore */
    }
  });

  document.getElementById('site-search').addEventListener('input', renderGrid);
  document.getElementById('site-category').addEventListener('change', renderGrid);
  document.getElementById('site-load-btn').addEventListener('click', fetchCatalog);

  void fetchCatalog();
})();
