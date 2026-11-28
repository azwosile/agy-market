(function () {
  'use strict';

  const BADGE_LABELS = {
    'declarative-only': '轻量技能包',
    'global-rules': '全局规则',
    'sidecar-ui': '独立面板',
    'mcp-stdio': '本地工具',
    'mcp-remote': '云端连接',
    'lifecycle-hooks': '自动触发',
    'host-enhancement': '外观增强',
  };

  const BADGE_TITLES = {
    'declarative-only': '仅含提示词与工作流，无后台程序',
    'global-rules': '对话时自动生效的规则指令',
    'sidecar-ui': '在右侧边栏提供可视化界面',
    'mcp-stdio': '在本地运行扩展工具供 AI 调用',
    'mcp-remote': '连接远程在线服务或 API',
    'lifecycle-hooks': '在特定操作时自动运行脚本',
    'host-enhancement': '美化或增强编辑器界面',
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

  const CATEGORY_PURPOSES = {
    'monitoring-quota': ['监控与用量', '帮助你查看 AI 的使用情况。'],
    'context-cache': ['缓存与提速', '帮助 AI 管理对话内容，减少重复处理。'],
    'ui-themes': ['界面美化', '调整编辑器的外观或显示方式。'],
    'agents-reasoning': ['AI 协作', '调整 AI 助手处理任务的方式。'],
    'developer-tools': ['代码工具', '辅助日常编写、检查或管理代码。'],
    'mcp-integrations': ['连接外部软件', '让 AI 助手使用编辑器以外的工具。'],
    'skills-workflows': ['效率工作流', '为 AI 提供可重复使用的任务步骤。'],
    productivity: ['常用扩展', '简化编辑器里的日常操作。'],
    'writing-knowledge': ['写作整理', '辅助写作、整理或查找资料。'],
    automation: ['自动任务', '把重复操作交给工具自动完成。'],
    security: ['安全检查', '帮助检查安全风险或管理权限。'],
    'creative-media': ['多媒体设计', '辅助制作或编辑设计和多媒体素材。'],
    'data-science': ['数据分析', '辅助整理、计算或分析数据。'],
    'cloud-devops': ['云端部署', '辅助发布应用或管理运行环境。'],
    other: ['常用扩展', '可在插件仓库查看具体用途。'],
  };

  // Match concrete features before falling back to the broader catalog category.
  const PURPOSE_KEYWORDS = [
    [/KaTeX|LaTeX.*(?:cop|复制)|数学公式/i, '让数学公式显示得更整齐，方便复制公式。'],
    [/documentation lookup|version-specific documentation|最新(?:版本)?文档/i, '让 AI 查阅与你使用的版本相符的文档和代码示例。'],
    [/KV[- ]?Cache.{0,12}(?:保护|protect)|低延迟加速/i, '保护 AI 对话中已处理的内容，减少重复计算，让回复更快。'],
    [/RTL\/BiDi|Arabic.*(?:render|text)|阿拉伯语/i, '修正阿拉伯语和英语混排时的对齐与显示。'],
    [/(?:ollama|deepseek|openai).{0,40}(?:task router|fallback)|外部大模型协同调度/i, '把不同的工作分配给多个 AI 模型处理。'],
    [/model selector|原生模型下拉菜单/i, '把外部 AI 模型加入编辑器的模型列表，方便切换使用。'],
    [/reasoning language|思考与推理语言/i, '切换 AI 思考时使用的语言，例如简体中文或英文。'],
    [/convert designs to React|convert designs? into React/i, '把设计稿转换成可用于网页的 React 组件。'],
    [/generate screens from text|convert code to designs/i, '用文字或代码生成界面设计稿。'],
    [/extract static HTML|generate DESIGN\.md specs/i, '整理设计规范，并导出网页或素材。'],
    [/remove AI writing patterns|AI-isms/i, '找出文字里常见的 AI 写作腔，并帮助改写。'],
    [/skill vault|(?:search|install).{0,25}(?:update|install).{0,25}skills/i, '查找、安装和更新 AI 技能。'],
    [/tabbed browser|built-in browser.*shared/i, '在编辑器侧栏打开网页，并与 AI 共用浏览器。'],
    [/control desktop apps on Windows|Windows desktop apps/i, '让 AI 帮你操作 Windows 桌面软件。'],
    [/animated desktop companion|desktop pet/i, '在桌面显示会动的宠物陪伴。'],
    [/native multi-model fusion|unified orchestration across coding agents/i, '让多个 AI 编程助手一起处理任务。'],
    [/batched search|用更少的回合找代码/i, '让 AI 更快地查找代码、读取和修改文件。'],
    [/context window protection|context-window guard/i, '控制 AI 每次需要读取的内容，避免对话过长。'],
    [/skill usage tracking|技能使用(?:统计|记录)/i, '查看 AI 使用了哪些技能，以及它们消耗了多少用量。'],
    [/quota reset|usage.*reset|配额重置/i, '查看 AI 用了多少额度，以及额度何时恢复。'],
    [/quota (?:view|track|monitor)|usage quotas?|token (?:usage monitor|breakdown|throughput)|配额(?:查询|监控)|用量监控/i, '查看 AI 的用量和剩余额度。'],
    [/context (?:window|usage|estimate)|上下文(?:水位|占用)/i, '查看 AI 对话还剩多少空间可用。'],
    [/wallpaper|壁纸/i, '为编辑器更换壁纸和外观。'],
    [/marketplace sidebar|社区插件市场侧边栏/i, '从编辑器侧栏查找、安装和更新社区插件。'],
    [/Bilateral Category Wheel|双侧分类轮盘/i, '用侧栏快捷切换分类、浏览文件层级并预览内容。'],
    [/全文搜索.*(?:归档|续聊)|full.text search.*(?:session|archive)/i, '搜索、整理已有对话，并在不同项目中继续聊。'],
    [/full.text search|全文(?:搜索|检索)/i, '按内容搜索已经保存的记录或资料。'],
    [/browser automation|desktop and web automation|桌面与网页操控/i, '让 AI 帮你在网页或桌面软件中执行操作。'],
    [/\bOCR\b|text recognition|文字识别/i, '从图片或扫描文件中识别文字。'],
    [/\bschedul(?:e|ed|er|ing)\b|\bcron\b|定时(?:执行|任务)/i, '让指定任务按设定时间自动运行。'],
    [/security audit|vulnerability scan|漏洞扫描/i, '检查项目中可能存在的安全问题。'],
    [/auto.permission|permission classifier|自动授权/i, '帮助判断什么时候允许 AI 使用工具。'],
    [/\blint(?:er|ing)?\b|code review|代码审查/i, '检查代码并指出可以修正的问题。'],
    [/\b(?:git|github)\b.{0,24}\b(?:commit|branch|pull request)|版本管理/i, '辅助提交或管理代码改动。'],
    [/marketing analytics|ad spend|广告投放分析/i, '查看广告花费、转化等投放数据。'],
    [/image generation|generate images|生成图片/i, '帮助你用 AI 生成图片。'],
    [/deploy(?:ment|s|ing)? (?:to |your |an )|部署到/i, '帮助你把应用发布到运行环境。'],
  ];

  const byId = (id) => document.getElementById(id);
  const workspace = document.querySelector('.workspace');
  const mobile = matchMedia('(max-width: 760px)');
  const sidebar = byId('site-sidebar');
  const sidebarToggle = byId('sidebar-toggle');
  const canvas = document.querySelector('.canvas');
  const grid = byId('site-grid');
  const pagination = byId('site-pagination');
  const pageNumbers = byId('site-page-numbers');
  const pageSizeSelect = byId('site-page-size');
  const previousPage = byId('site-page-prev');
  const nextPage = byId('site-page-next');
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
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
  let pagePlugins = [];
  let pageSize = Number(pageSizeSelect.value);
  let currentPage = 1;
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

  function getPlainPurpose(plugin) {
    const id = categoriesOf(plugin).find((key) => Object.hasOwn(CATEGORY_PURPOSES, key) && key !== 'other') || 'other';
    const [label, fallback] = CATEGORY_PURPOSES[id];
    const description = descriptionOf(plugin, true);
    const authored = typeof plugin.description === 'object' && plugin.description
      ? [plugin.description.zh, plugin.description.en]
      : [description];
    const chinese = authored.find((value) => typeof value === 'string' && /\p{Script=Han}{2}/u.test(value));
    // Prefer a specific keyword match for English or technical descriptions.
    const feature = PURPOSE_KEYWORDS.find(([pattern]) => pattern.test(description));
    const simplified = chinese?.trim().replace(/\s+/g, ' ')
      .replace(/^[^：:]{2,30}[：:]\s*/, '')
      .replace(/\bAgent\b/gi, 'AI 助手')
      .replace(/\bSidecar\b/gi, '侧边面板')
      .replace(/\bTokens?\b(?:\s*用量)?/gi, '文字用量')
      .replace(/对话上下文/g, '对话内容')
      .replace(/上下文窗口/g, '对话容量')
      .replace(/大模型/g, 'AI 模型')
      .split(/[。！？；]/, 1)[0].trim().replace(/[.!?]+$/, '');
    const shortChinese = simplified?.length > 64
      ? simplified.slice(0, 65).match(/^.{8,63}(?=[，,、])/u)?.[0]
      : simplified;
    const capability = badgesOf(plugin).find((badge) => Object.hasOwn(BADGE_TITLES, badge));
    const summary = feature?.[1] || (shortChinese && `${shortChinese}。`) ||
      (id === 'other' && capability ? `${BADGE_TITLES[capability]}。` : fallback);
    return { id, label, summary };
  }

  function renderPurpose(purpose) {
    return `<span class="plugin-purpose"><span class="purpose-pill" title="用途">${purpose.label}</span><span class="purpose-summary">${escapeHtml(purpose.summary)}</span></span>`;
  }

  const PURPOSE_SCENES = {
    'monitoring-quota': `
      <rect class="scene-frame" x="15" y="14" width="150" height="42" rx="6"/>
      <path class="scene-guide" d="M24 35h79m9-15v30"/>
      <path class="scene-action" style="--scene-y:-3px" d="M24 36h16l6-7 7 16 10-23 8 14h27"/>
      <g class="scene-action" style="--scene-scale-y:1.3;--scene-origin:bottom"><rect x="123" y="39" width="7" height="9" rx="1"/><rect x="135" y="32" width="7" height="16" rx="1"/><rect x="147" y="27" width="7" height="21" rx="1"/></g>
      <circle class="scene-signal" cx="98" cy="36" r="2"/>`,
    'context-cache': `
      <path class="scene-guide" d="M59 20l27 11m-27 4h27m-27 15 27-11"/>
      <g class="scene-action" style="--scene-x:9px;--scene-scale-y:.68"><rect x="23" y="15" width="32" height="10" rx="2"/><rect x="23" y="30" width="32" height="10" rx="2"/><rect x="23" y="45" width="32" height="10" rx="2"/></g>
      <path d="M87 35h15m-4-4 4 4-4 4"/>
      <rect class="scene-frame" x="110" y="19" width="48" height="32" rx="4"/><path d="M120 29h28m-28 6h28m-28 6h28"/>`,
    'ui-themes': `
      <rect class="scene-frame scene-action" style="--scene-x:5px;--scene-y:-3px" x="60" y="13" width="84" height="37" rx="4"/>
      <rect class="scene-panel" x="36" y="23" width="84" height="35" rx="4"/>
      <path d="M36 33h84m-66 0v25m9-16h32m-32 7h44"/><path class="scene-guide" d="M43 28h2m4 0h2m4 0h2"/>`,
    'agents-reasoning': `
      <path class="scene-guide" d="M41 35h38m20-4 27-11M99 39l27 11"/>
      <circle class="scene-frame" cx="31" cy="35" r="9"/><circle class="scene-frame" cx="138" cy="17" r="9"/><circle class="scene-frame" cx="138" cy="53" r="9"/>
      <circle class="scene-action" style="--scene-scale-x:1.28;--scene-scale-y:1.28" cx="90" cy="35" r="10"/>
      <circle cx="31" cy="35" r="2"/><circle cx="90" cy="35" r="2"/><circle cx="138" cy="17" r="2"/><circle cx="138" cy="53" r="2"/>`,
    'developer-tools': `
      <path d="M32 22v26m0-6c20 0 22-4 22-20"/><circle cx="32" cy="17" r="4"/><circle cx="32" cy="53" r="4"/><circle cx="54" cy="17" r="4"/>
      <rect class="scene-frame" x="77" y="15" width="79" height="40" rx="5"/>
      <path class="scene-action" style="--scene-x:-4px" d="m105 29-7 6 7 6"/><path d="m120 27-7 16"/><path class="scene-action" style="--scene-x:4px" d="m128 29 7 6-7 6"/>`,
    'mcp-integrations': `
      <rect class="scene-frame" x="14" y="22" width="43" height="26" rx="4"/><path d="M23 31h19m-19 8h25m9-4h19"/>
      <rect class="scene-frame" x="122" y="22" width="44" height="26" rx="4"/><path d="M122 30h44m-64 5h20"/>
      <path class="scene-action" style="--scene-x:5px" d="M76 29h8a6 6 0 0 1 0 12h-8zM90 32h8m-8 6h8"/>
      <path d="M102 28v14"/>`,
    'skills-workflows': `
      <path class="scene-guide" d="M55 35h21m28 0h21m-54-4 4 4-4 4m49-8 4 4-4 4"/>
      <rect class="scene-frame" x="28" y="23" width="26" height="24" rx="4"/><rect class="scene-frame scene-action" style="--scene-y:-5px" x="77" y="23" width="26" height="24" rx="4"/><rect class="scene-frame" x="126" y="23" width="26" height="24" rx="4"/>
      <path d="M37 35h8m89 0 4 4 7-8"/><path class="scene-action" style="--scene-y:-5px" d="M86 32h8m-8 6h8"/>`,
    'writing-knowledge': `
      <rect class="scene-frame" x="53" y="11" width="74" height="48" rx="4"/>
      <path d="M63 25h34m-34 8h29m-29 8h50m-50 8h44"/>
      <path class="scene-action" style="--scene-y:5px" d="M105 11v21l6-4 6 4V11"/>`,
    automation: `
      <path d="M55 42a36 22 0 0 1 66-15m-10-1 11 3 2-9m1 8a36 22 0 0 1-66 15m10 1-11-3-2 9"/>
      <circle class="scene-frame" cx="90" cy="35" r="15"/>
      <path d="M90 35V24"/><path class="scene-action" style="--scene-rotation:55deg;--scene-origin:90px 35px" d="M90 35h8"/>`,
    security: `
      <path class="scene-frame" d="M90 11c8 5 17 7 24 8v11c0 13-9 23-24 29-15-6-24-16-24-29V19c7-1 16-3 24-8Z"/>
      <path d="m82 34 6 6 11-12"/><path class="scene-guide scene-action" style="--scene-y:18px" d="M56 25h68"/>`,
    'creative-media': `
      <rect class="scene-frame" x="29" y="15" width="122" height="40" rx="5"/>
      <circle cx="61" cy="27" r="4"/><path class="scene-guide" d="m40 48 26-13 20 13"/>
      <path class="scene-action" style="--scene-y:-4px;--scene-scale-y:1.18" d="M39 44c11 4 20 1 31-2s23-12 34-8 21 12 37 8"/>`,
    'data-science': `
      <path class="scene-guide" d="M31 15v41h118M44 41h99M44 27h99"/>
      <g class="scene-action" style="--scene-scale-y:1.24;--scene-origin:bottom"><rect x="50" y="44" width="12" height="12" rx="1"/><rect x="75" y="38" width="12" height="18" rx="1"/><rect x="100" y="33" width="12" height="23" rx="1"/><rect x="125" y="26" width="12" height="30" rx="1"/></g>`,
    'cloud-devops': `
      <rect class="scene-frame" x="29" y="18" width="70" height="14" rx="3"/><rect class="scene-frame" x="29" y="38" width="70" height="14" rx="3"/>
      <path d="M38 25h3m5 0h3m-11 20h3m5 0h3m56-10h10"/>
      <path class="scene-action" style="--scene-y:-6px" d="M137 46V21m-10 10 10-10 10 10"/>`,
    productivity: `
      <rect class="scene-frame" x="29" y="19" width="122" height="34" rx="6"/>
      <rect x="39" y="26" width="21" height="20" rx="3"/><rect class="scene-panel scene-action" style="--scene-y:-6px" x="79" y="26" width="22" height="20" rx="3"/><rect x="120" y="26" width="21" height="20" rx="3"/>
      <path d="M46 36h7m77-4v8"/><path class="scene-action" style="--scene-y:-6px" d="m91 31-4 6h6l-4 4"/>`,
    other: `
      <path class="scene-guide" d="M53 35h20m34 0h20"/>
      <rect class="scene-frame" x="28" y="22" width="25" height="26" rx="4"/><rect class="scene-frame" x="127" y="22" width="25" height="26" rx="4"/>
      <rect class="scene-frame scene-action" style="--scene-y:-5px;--scene-rotation:9deg" x="77" y="22" width="26" height="26" rx="4"/>
      <path class="scene-action" style="--scene-y:-5px;--scene-rotation:9deg" d="M86 35h8m-4-4v8"/>`,
  };

  let coverManifest;

  function renderCover(id) {
    const entry = coverManifest && Object.hasOwn(coverManifest, id) ? coverManifest[id] : null;
    if (!['cover', 'logo'].includes(entry?.kind) || typeof entry.src !== 'string'
      || !/^\.\/assets\/(?:logo\.png|covers\/[a-z0-9_-]+\.(?:svg|png|jpg|webp|gif|avif))$/i.test(entry.src)) return '';
    return `<img class="scene-cover is-${entry.kind}" src="${escapeHtml(entry.src)}" alt="" loading="lazy">`;
  }

  function renderScene(plugin, purpose, className) {
    const id = String(plugin.id ?? '');
    return `<span class="${className}" data-cover-id="${escapeHtml(id)}"><svg viewBox="0 0 180 70" aria-hidden="true">${PURPOSE_SCENES[purpose.id]}</svg>${renderCover(id)}</span>`;
  }

  async function loadCovers() {
    try {
      const response = await fetch('./assets/covers/manifest.json');
      if (!response.ok) return;
      coverManifest = await response.json();
    } catch {
      return;
    }
    for (const scene of document.querySelectorAll('[data-cover-id]')) {
      scene.insertAdjacentHTML('beforeend', renderCover(scene.dataset.coverId));
    }
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
      ...categoriesOf(plugin).flatMap((id) => [id, labelForCategory(id), Object.hasOwn(CATEGORY_PURPOSES, id) ? CATEGORY_PURPOSES[id][0] : '']),
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
    const tags = badges.map((id) => `<span class="badge"${Object.hasOwn(BADGE_TITLES, id) ? ` title="${BADGE_TITLES[id]}"` : ''}>${icon(badgeIcon(id))}${escapeHtml(labelForBadge(id))}</span>`);
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

  function renderPagination(totalPages) {
    pagination.hidden = !visiblePlugins.length;
    if (pagination.hidden) return;
    previousPage.disabled = currentPage === 1;
    nextPage.disabled = currentPage === totalPages;
    byId('site-page-status').textContent = `第 ${currentPage} / ${totalPages} 页 · 共 ${visiblePlugins.length} 款`;

    const start = Math.max(2, Math.min(currentPage - 1, totalPages - 3));
    const pages = totalPages > 1 ? [1] : [currentPage];
    for (let i = start; i <= Math.min(start + 2, totalPages - 1); i++) pages.push(i);
    if (totalPages > 1) pages.push(totalPages);
    pageNumbers.innerHTML = pages.map((number, index) => `
      ${index && number - pages[index - 1] > 1 ? '<span aria-hidden="true">…</span>' : ''}
      <button type="button" data-page-number="${number}" aria-label="第 ${number} 页"${number === currentPage ? ' aria-current="page"' : ''}>${number}</button>`
    ).join('');
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
    renderResults(animate);
  }

  function renderResults(animate = false) {
    const totalPages = Math.max(1, Math.ceil(visiblePlugins.length / pageSize));
    currentPage = Math.min(currentPage, totalPages);
    const offset = (currentPage - 1) * pageSize;
    pagePlugins = visiblePlugins.slice(offset, offset + pageSize);
    renderPagination(totalPages);
    grid.className = view === 'grid' ? 'grid' : 'table-wrap';

    if (!pagePlugins.length) {
      if (feedStatus === 'loading') grid.innerHTML = '<p class="empty">正在同步目录…</p>';
      else if (feedStatus === 'error' && !plugins.length) grid.innerHTML = '<p class="empty">无法连接目录。<button type="button" class="settings-link" data-settings>打开目录设置</button></p>';
      else grid.innerHTML = `<p class="empty empty-results" role="status">${icon('empty')}${plugins.length ? '没有匹配的插件。' : '该目录暂无插件。'}</p>`;
      return;
    }

    if (view === 'table') {
      const rows = pagePlugins.map((plugin, index) => `
        <tr data-plugin="${index}">
          <td><button type="button" class="table-title" aria-haspopup="dialog">${renderMark(plugin)}${escapeHtml(titleOf(plugin))}${plugin.isDiscovery ? renderDiscoveryTag() : ''}${icon('chevron-right', 'card-arrow')}</button>
            ${renderPurpose(getPlainPurpose(plugin))}</td>
          <td class="table-version">${plugin.version ? `v${escapeHtml(plugin.version)}` : '—'}</td>
          <td>${renderStars(plugin)}</td>
        </tr>`).join('');
      grid.innerHTML = `<table class="table" aria-label="插件目录"><thead><tr><th scope="col">插件</th><th scope="col">版本</th><th scope="col">星标</th></tr></thead><tbody>${rows}</tbody></table>`;
      return;
    }

    grid.innerHTML = pagePlugins.map((plugin, index) => {
      const purpose = getPlainPurpose(plugin);
      return `
      <button type="button" class="card${animate ? ' entering' : ''}" data-plugin="${index}" aria-haspopup="dialog"${animate ? ` style="--enter-delay:${Math.min(index, 7) * 18}ms"` : ''}>
        ${renderScene(plugin, purpose, 'card-scene')}
        <span class="card-top"><span class="card-title">${escapeHtml(titleOf(plugin))}</span>${icon('chevron-right', 'card-arrow')}</span>
        ${renderPurpose(purpose)}
        ${renderBadges(plugin, 3)}
        <span class="card-bottom">${renderStars(plugin)}</span>
      </button>`;
    }).join('');
  }

  function changePage(next) {
    if (next === currentPage || next < 1 || next > Math.ceil(visiblePlugins.length / pageSize)) return;
    currentPage = next;
    renderResults(true);
    byId('catalog-title').focus({ preventScroll: true });
    byId('catalog-page').scrollIntoView({ block: 'start', behavior: reduceMotion.matches ? 'instant' : 'smooth' });
  }

  function resetResults() {
    currentPage = 1;
    renderGrid();
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
    currentPage = 1;
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
    const purpose = getPlainPurpose(plugin);
    const description = descriptionOf(plugin).trim();
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
      ${renderScene(plugin, purpose, 'peek-scene')}
      <h2 id="peek-title">${escapeHtml(titleOf(plugin))}</h2>
      ${renderPurpose(purpose)}
      <p class="peek-meta">${plugin.version ? `v${escapeHtml(plugin.version)} · ` : ''}${renderStars(plugin)}</p>
      ${description && description !== purpose.summary ? `<p class="peek-desc">${escapeHtml(description)}</p>` : ''}
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
    if (page === 'catalog') resetResults();
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
  search.addEventListener('input', resetResults);
  discovery.addEventListener('change', () => {
    resetResults();
    void syncDiscovery(true);
  });
  category.addEventListener('change', () => {
    renderNavigation();
    resetResults();
  });
  sort.addEventListener('change', resetResults);
  pageSizeSelect.addEventListener('change', () => {
    pageSize = Number(pageSizeSelect.value);
    resetResults();
  });
  previousPage.addEventListener('click', () => changePage(currentPage - 1));
  nextPage.addEventListener('click', () => changePage(currentPage + 1));
  pageNumbers.addEventListener('click', (event) => {
    const button = event.target.closest('[data-page-number]');
    if (button) changePage(Number(button.dataset.pageNumber));
  });
  byId('site-feed-form').addEventListener('submit', (event) => {
    event.preventDefault();
    void fetchCatalog();
  });
  grid.addEventListener('click', (event) => {
    const item = event.target.closest('[data-plugin]');
    if (item) {
      const rowButton = item.querySelector('button');
      if (rowButton) rowButton.focus({ preventScroll: true });
      openPeek(pagePlugins[Number(item.dataset.plugin)]);
    } else if (event.target.closest('[data-settings]')) {
      showPage('settings');
    }
  });
  byId('site-view-switch').querySelectorAll('[data-view]').forEach((button, index) => {
    button.addEventListener('click', () => {
      if (view === button.dataset.view) return;
      view = button.dataset.view;
      setPressed(button, index);
      renderResults(true);
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

  document.addEventListener('load', (event) => {
    if (event.target.matches?.('.scene-cover') && event.target.naturalWidth > 0) {
      event.target.parentElement.classList.add('has-cover');
    }
  }, true);
  document.addEventListener('error', (event) => {
    if (!event.target.matches?.('.scene-cover')) return;
    event.target.parentElement.classList.remove('has-cover');
    event.target.remove();
  }, true);

  void loadCovers();
  void fetchCatalog();
})();
