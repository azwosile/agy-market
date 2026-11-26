// Shared constants, capability badge metadata, host path resolvers & process hygiene (`src/shared/constants.mjs`).

export const PLUGIN_ID = 'agy-market';
export const SELF_CATALOG_ID = 'azwosile__agy-market';
export const SELF_REPO_URL = 'https://github.com/azwosile/agy-market';
export const SUBMIT_PLUGIN_GUIDE_URL =
  'https://github.com/azwosile/agy-market-catalog/blob/main/docs/SUBMISSION_GUIDE.md';
export const NOMINATE_PLUGIN_ISSUE_BASE_URL =
  'https://github.com/azwosile/agy-market-catalog/issues/new';
export const PLUGIN_DISPLAY_NAME = 'AGY Market · 反重力插件市场';
export const PLUGIN_VERSION = '1.7.1';
export const SIDECAR_ID = 'market_pane';
export const SIDECAR_URI = 'sidecar://agy-market/market_pane/';
export const CUSTOMIZATION_URI = 'customization://agy-market';

export const MAX_TARBALL_BYTES = 0; // 0 = unlimited
export const MAX_FAVORITES = 500;
export const PRIMARY_CATALOG_BASE_URL = 'https://azwosile.github.io/agy-market-catalog';
export const RAW_GH_PAGES_CATALOG_BASE_URL = 'https://raw.githubusercontent.com/azwosile/agy-market-catalog/gh-pages';
export const PRIMARY_FETCH_TIMEOUT_MS = 3500;
// `unverified-index.json` is ~2 MB: it needs a much longer budget than the tiny `index.json`.
export const UNVERIFIED_FETCH_TIMEOUT_MS = 20000;
export const LOCAL_INVENTORY_CACHE_TTL_MS = 30 * 1000;
export const GZIP_MIN_BYTES = 64 * 1024;
export const GITHUB_API_BASE_URL = 'https://api.github.com';
export const UPDATE_CHECK_CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes
export const DISCUSSIONS_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

export const CHINA_NPM_MIRRORS = Object.freeze([
  'https://registry.npmmirror.com',
  'https://mirrors.cloud.tencent.com/npm',
]);

export const CATALOG_NPM_PACKAGE = '@agy-market/catalog';

export const PLUGIN_JSON_ALLOWED_KEYS = new Set([
  'name',
  'displayName',
  'description',
  'version',
  'logo',
  'author',
  'homepage',
  'repository',
  'suggestedPrompts',
  'disabled',
]);

export const PRIVILEGE_ESCALATION_BADGES = new Set([
  'lifecycle-hooks',
  'mcp-stdio',
  'mcp-remote',
  'sidecar-ui',
  'host-enhancement',
  'global-rules',
]);

export const CAPABILITY_BADGE_SPECS = Object.freeze({
  'declarative-only': {
    id: 'declarative-only',
    tone: 'green',
    icon: '🟢',
    zh: '纯声明式技能',
    en: 'Declarative Skill',
    descZh: '仅包含声明式 SKILL.md 或 Subagent，无后台常驻进程或钩子。',
    descEn: 'Pure declarative skills/subagents with zero background processes or hooks.',
  },
  'global-rules': {
    id: 'global-rules',
    tone: 'blue',
    icon: '🔵',
    zh: '常驻规则 (~{tokens} tok)',
    en: 'Global Rules (~{tokens} tok)',
    descZh: '包含启用期间常驻注入上下文的 rules/*.md 规则文件。',
    descEn: 'Includes rules/*.md active in prompt context while enabled.',
  },
  'sidecar-ui': {
    id: 'sidecar-ui',
    tone: 'purple',
    icon: '🟣',
    zh: 'Sidebar 侧边栏',
    en: 'Sidebar Panel',
    descZh: '在右侧 Sidebar 辅助栏提供可视化交互界面。',
    descEn: 'Provides a visual interactive panel in the right Sidebar.',
  },
  'mcp-stdio': {
    id: 'mcp-stdio',
    tone: 'amber',
    icon: '🟠',
    zh: '本地 MCP 进程',
    en: 'Local MCP Process',
    descZh: '通过 mcp_config.json 启动本地 Stdio 工具服务进程。',
    descEn: 'Spawns a local stdio MCP server process defined in mcp_config.json.',
  },
  'mcp-remote': {
    id: 'mcp-remote',
    tone: 'cyan',
    icon: '🌐',
    zh: '远程 MCP 服务',
    en: 'Remote MCP Service',
    descZh: '连接外部 HTTPS MCP 服务端点。',
    descEn: 'Connects to an external HTTPS MCP server endpoint.',
  },
  'lifecycle-hooks': {
    id: 'lifecycle-hooks',
    tone: 'orange',
    icon: '🔶',
    zh: '生命周期钩子 (Hooks)',
    en: 'Lifecycle Hooks',
    descZh: '注册了 hooks.json 会话或工具生命周期拦截脚本。',
    descEn: 'Registers lifecycle event hooks via hooks.json.',
  },
  'host-enhancement': {
    id: 'host-enhancement',
    tone: 'subtle',
    icon: '💡',
    zh: '💡 宿主界面增强',
    en: '💡 Host UI Enhancement',
    descZh: '使用本地 CDP 调试桥或工作台界面增强机制（如毛玻璃主题、挂件），社区完全允许，温和提示。',
    descEn: 'Uses local CDP bridge or workbench UI enhancements (e.g. glass skins, companion widgets). Fully permitted.',
  },
});

export const CATEGORY_LABELS = Object.freeze({
  all: { zh: '全部插件', en: 'All Plugins' },
  'monitoring-quota': { zh: '状态与用量监控', en: 'Telemetry & Quota' },
  'context-cache': { zh: '上下文与缓存加速', en: 'Context & Cache Boost' },
  'ui-themes': { zh: '界面美化与汉化', en: 'UI, Themes & i18n' },
  'agents-reasoning': { zh: '多代理与思考控制', en: 'Agents & Reasoning' },
  'developer-tools': { zh: '开发与版本工具', en: 'Git & DevTools' },
  'mcp-integrations': { zh: '浏览器与系统 MCP', en: 'Browser & System MCP' },
  'skills-workflows': { zh: '技能包与工程方法', en: 'Skills & Frameworks' },
  productivity: { zh: '效率与插件管理', en: 'Workspace & Market' },
  'data-science': { zh: '数据与科学计算', en: 'Data & Science' },
  'cloud-devops': { zh: '云原生与部署', en: 'Cloud & DevOps' },
  'creative-media': { zh: '设计与多媒体', en: 'Creative & Media' },
  'writing-knowledge': { zh: '写作与知识库', en: 'Writing & Knowledge' },
  automation: { zh: '定时与守护任务', en: 'Automation' },
  security: { zh: '安全与审计', en: 'Security' },
  other: { zh: '其他扩展', en: 'Other' },
});

export const DEFAULT_PREFS = Object.freeze({
  schemaVersion: 1,
  locale: 'zh',
  enableExperimentalTrack2: false,
  networkMode: 'auto', // 'auto' | 'china-mirror' | 'direct'
  primaryCatalogUrl: PRIMARY_CATALOG_BASE_URL,
  githubReleaseMirrorPrefix: '',
  githubToken: '',
  customFeeds: [],
  favorites: [],
});

export function formatBadgeLabel(badgeId, capabilities = {}, locale = 'zh') {
  const spec = CAPABILITY_BADGE_SPECS[badgeId];
  if (!spec) return badgeId;
  const tpl = locale === 'en' ? spec.en : spec.zh;
  const tokens = Number(capabilities?.rulesEstimatedTokens || 0);
  return tpl.replace('{tokens}', tokens > 0 ? String(tokens) : '0');
}

export function toScopedPluginName(owner, slug) {
  const cleanOwner = String(owner || '')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');
  const cleanSlug = String(slug || '')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');
  return `${cleanOwner}--${cleanSlug}`;
}

/**
 * Scrubs `ELECTRON_RUN_AS_NODE` so any optional child tool never spawns duplicate Antigravity IDE windows.
 */
export function scrubChildProcessEnv(baseEnv = process.env) {
  const clean = { ...baseEnv };
  delete clean.ELECTRON_RUN_AS_NODE;
  return clean;
}
