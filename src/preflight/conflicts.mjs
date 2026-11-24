// Read-Only Local Plugin Conflict Scanner (`src/preflight/conflicts.mjs`).
//
// Zero filesystem mutations — strictly read-only checks covering:
//   1. `duplicate-plugin-name` (critical): workspace > global > builtin duplicate plugin.json.name precedence
//   2. `windows-symlink-ignored` (critical): symlinks / NTFS junctions in global `plugins/` skipped on Windows
//   3. `mcp-collision` (critical/warning): duplicate `<plugin>_<server>`, user `mcp_config.json` collision, generic bare key
//   4. `skill-shadowing` & `agent-shadowing` (warning): overlapping skills/subagents across plugins, user globals & builtins
//   5. `host-enhancement-overlap` (warning/info): >=2 active plugins simultaneously using app-asar or CDP enhancements

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { PLUGIN_ID, toScopedPluginName } from '../shared/constants.mjs';
import { fileUriToLocalPath, resolveAntigravityConfigDir } from '../shared/paths.mjs';
import {
  normalizeRepoUrl,
  parseSkillFrontmatterName,
  scanLocalPluginInventory,
} from './index.mjs';

const ASAR_LABEL = `${'app'}.${'asar'}`;

export const BUILTIN_SKILL_NAMES = new Set([
  'plugin',
  'agy-customizations',
  'antigravity-guide',
  'antigravity_guide',
  'automation',
  'generative_ui',
  'mcp-app-development',
  'migrate-agent-settings',
  'migrate-workflows',
  'native_swarm',
  'permissioned-github',
  'run-workflow',
  'swarm_monitor',
  'swarm_narrator',
  'swarm_pane',
  'ui-plugin-navigation',
]);

export const BUILTIN_AGENT_NAMES = new Set([
  'self',
  'browser',
  'research',
  'deepagent',
  'review-agent',
  'image-generator',
]);

export const GENERIC_MCP_SERVER_KEYS = new Set([
  'search',
  'db',
  'database',
  'filesystem',
  'fs',
  'fetch',
  'http',
  'git',
  'shell',
  'default',
  'server',
  'mcp',
]);

const SCOPE_PRECEDENCE = Object.freeze({
  'workspace-standalone': 5,
  workspace: 4,
  'user-global': 3,
  global: 2,
  builtin: 1,
});

const SEVERITY_RANK = Object.freeze({
  critical: 0,
  warning: 1,
  info: 2,
});

function scopeLabelZh(scope) {
  switch (scope) {
    case 'workspace-standalone':
      return '工作区独立目录';
    case 'workspace':
      return '工作区插件';
    case 'user-global':
      return '用户全局目录';
    case 'global':
      return '全局插件';
    case 'builtin':
      return 'Antigravity 内置';
    default:
      return String(scope || '');
  }
}

function deriveSuggestedScopedDir(plugin, existingDirs) {
  let owner = 'local';
  const recId = String(plugin?.receipt?.id || '');
  if (recId.includes('__')) {
    owner = recId.split('__')[0] || 'local';
  } else if (plugin?.repositoryUrl) {
    const m = /^https:\/\/github\.com\/([^/]+)\/([^/]+)$/i.exec(normalizeRepoUrl(plugin.repositoryUrl));
    if (m && m[1]) owner = m[1];
  }

  const base = toScopedPluginName(owner, plugin.name || plugin.dir || 'plugin');
  if (!existingDirs.has(base) && base !== PLUGIN_ID) return base;

  const altFromDir = toScopedPluginName(owner, plugin.dir || plugin.name || 'plugin');
  if (!existingDirs.has(altFromDir) && altFromDir !== PLUGIN_ID) return altFromDir;

  let seq = 2;
  while (existingDirs.has(`${base}-${seq}`)) seq += 1;
  return `${base}-${seq}`;
}

function scanStandaloneSkillsDir(skillsRoot, scope) {
  const found = [];
  if (!skillsRoot || !existsSync(skillsRoot)) return found;
  try {
    for (const skillDir of readdirSync(skillsRoot).sort()) {
      const skillMd = join(skillsRoot, skillDir, 'SKILL.md');
      if (!existsSync(skillMd)) continue;
      let fmName = null;
      try {
        fmName = parseSkillFrontmatterName(readFileSync(skillMd, 'utf8'));
      } catch {
        fmName = null;
      }
      found.push({
        skillName: fmName || skillDir,
        dir: skillDir,
        name: fmName || skillDir,
        scope,
        path: skillMd,
      });
    }
  } catch {
    /* ignore */
  }
  return found;
}

function scanStandaloneAgentsDir(agentsRoot, scope) {
  const found = [];
  if (!agentsRoot || !existsSync(agentsRoot)) return found;
  try {
    for (const file of readdirSync(agentsRoot).sort()) {
      if (!/\.md$/i.test(file)) continue;
      const full = join(agentsRoot, file);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (!st.isFile()) continue;
      const stem = file.replace(/\.md$/i, '');
      let fmName = null;
      try {
        fmName = parseSkillFrontmatterName(readFileSync(full, 'utf8'));
      } catch {
        fmName = null;
      }
      const agentName = fmName || stem;
      found.push({
        agentName,
        dir: stem,
        name: agentName,
        scope,
        path: full,
      });
    }
  } catch {
    /* ignore */
  }
  return found;
}

function resolveEffectiveHostEnhancementKinds(plugin, catalogByDir, catalogById) {
  const kinds = new Set(Array.isArray(plugin.hostEnhancementKind) ? plugin.hostEnhancementKind : []);
  const cat =
    (plugin.receipt?.id && catalogById.get(plugin.receipt.id)) ||
    catalogByDir.get(plugin.dir) ||
    catalogByDir.get(plugin.name) ||
    null;
  if (Array.isArray(cat?.capabilities?.hostEnhancementKind)) {
    for (const k of cat.capabilities.hostEnhancementKind) {
      if (k === 'cdp' || k === 'app-asar') kinds.add(k);
    }
  }
  return [...kinds].sort();
}

/**
 * Runs a read-only conflict scan over the local Antigravity plugin environment.
 */
export function scanLocalConflicts({
  inventory = null,
  configDir = '',
  dataDir = '',
  workspaceUris = [],
  builtinPluginsDir = '',
  catalogPlugins = [],
  builtinSkills = BUILTIN_SKILL_NAMES,
  builtinAgents = BUILTIN_AGENT_NAMES,
} = {}) {
  const resolvedConfigDir = configDir || inventory?.configDir || resolveAntigravityConfigDir();
  const inv =
    inventory ||
    scanLocalPluginInventory({
      configDir: resolvedConfigDir,
      dataDir,
      workspaceUris,
      builtinPluginsDir,
    });

  const allInstalled = Array.isArray(inv.installed) ? inv.installed : [];
  const activePlugins = allInstalled.filter((p) => p.enabled && !p.parkedByMarket);
  const existingDirs = new Set(allInstalled.map((p) => p.dir));
  const userMcpServerNames = inv.userMcpServerNames instanceof Set ? inv.userMcpServerNames : new Set();

  const catalogById = new Map();
  const catalogByDir = new Map();
  for (const cp of Array.isArray(catalogPlugins) ? catalogPlugins : []) {
    if (cp?.id) catalogById.set(cp.id, cp);
    if (cp?.canonicalName && !cp?.forceScopedInstall) catalogByDir.set(cp.canonicalName, cp);
    if (cp?.scopedName) catalogByDir.set(cp.scopedName, cp);
  }

  const items = [];

  // ------------------------------------------------------------------------
  // Layer 1: `duplicate-plugin-name` (critical)
  // ------------------------------------------------------------------------
  const byPluginName = new Map();
  for (const p of activePlugins) {
    const key = String(p.name || p.dir).trim();
    if (!key) continue;
    if (!byPluginName.has(key)) byPluginName.set(key, []);
    byPluginName.get(key).push(p);
  }

  for (const [pluginName, group] of byPluginName.entries()) {
    if (group.length < 2) continue;
    const sorted = [...group].sort((a, b) => {
      const rankDiff = (SCOPE_PRECEDENCE[b.scope] || 0) - (SCOPE_PRECEDENCE[a.scope] || 0);
      if (rankDiff !== 0) return rankDiff;
      return String(a.dir).localeCompare(String(b.dir));
    });

    const winner = sorted[0];
    const shadowed = sorted.slice(1);
    const fixableTarget = shadowed.find((s) => s.scope === 'global' && s.dir !== PLUGIN_ID) || null;
    const suggestedDir = fixableTarget ? deriveSuggestedScopedDir(fixableTarget, existingDirs) : '';

    items.push({
      id: `duplicate-plugin-name:${pluginName}`,
      type: 'duplicate-plugin-name',
      severity: 'critical',
      titleZh: `同名插件 "${pluginName}" 冲突`,
      titleEn: `Duplicate plugin name "${pluginName}"`,
      summaryZh: `将优先加载 ${winner.dir}（${scopeLabelZh(winner.scope)}），${shadowed.map((s) => `${s.dir}（${scopeLabelZh(s.scope)}）`).join('、')} 将被忽略。`,
      summaryEn: `${winner.dir} (${winner.scope}) takes precedence; ${shadowed.map((s) => `${s.dir} (${s.scope})`).join(', ')} will be ignored by Antigravity.`,
      detailZh:
        'Antigravity 按 workspace > global > builtin 优先级以 plugin.json.name 全局去重，低优先级的同名插件组件不会被加载。',
      detailEn:
        'Antigravity deduplicates plugins globally by plugin.json.name (workspace > global > builtin) and skips lower-precedence duplicates.',
      winner: { dir: winner.dir, name: winner.name, scope: winner.scope, path: winner.path },
      shadowed: shadowed.map((s) => ({ dir: s.dir, name: s.name, scope: s.scope, path: s.path })),
      paths: [winner.path, ...shadowed.map((s) => s.path)],
      fixAction: fixableTarget
        ? {
            type: 'isolate-rename',
            targetDir: fixableTarget.dir,
            suggestedDir,
            labelZh: `隔离重命名为 ${suggestedDir}`,
            labelEn: `Isolate & rename to ${suggestedDir}`,
          }
        : null,
    });
  }

  // ------------------------------------------------------------------------
  // Layer 2: `windows-symlink-ignored` (critical)
  // ------------------------------------------------------------------------
  for (const p of allInstalled) {
    if (p.scope !== 'global' || p.parkedByMarket || !p.isSymlink) continue;
    const targetPaths = [p.path];
    if (p.realPath && p.realPath !== p.path) targetPaths.push(p.realPath);

    items.push({
      id: `windows-symlink-ignored:${p.dir}`,
      type: 'windows-symlink-ignored',
      severity: 'critical',
      titleZh: `符号链接 / Junction 目录 "${p.dir}" 在 Windows 下不会被加载`,
      titleEn: `Symlink / NTFS junction "${p.dir}" is skipped on Windows`,
      summaryZh: `全局插件目录 "${p.dir}" 为符号链接或 NTFS Junction，Windows 下 Antigravity 会忽略此类目录。`,
      summaryEn: `"${p.dir}" in global plugins/ is a symlink or NTFS junction, which Antigravity ignores on Windows.`,
      detailZh: '点击“转为实体目录”可将链接目标复制为实体目录（不会修改原始目录），以便 Antigravity 正常加载。',
      detailEn: 'Click "Materialize to real directory" to copy the target into a real directory (leaving the original untouched) so Antigravity can load it.',
      winner: null,
      shadowed: [{ dir: p.dir, name: p.name, scope: p.scope, path: p.path }],
      paths: targetPaths,
      fixAction: {
        type: 'materialize-symlink',
        targetDir: p.dir,
        labelZh: '转为实体目录',
        labelEn: 'Materialize to real directory',
      },
    });
  }

  // ------------------------------------------------------------------------
  // Layer 3: `mcp-collision` (critical / warning)
  // ------------------------------------------------------------------------
  const mcpByFullName = new Map();
  const userMcpPath = join(resolvedConfigDir, 'mcp_config.json');

  for (const p of activePlugins) {
    const keys = Array.isArray(p.mcpServerKeys) ? p.mcpServerKeys : [];
    const pluginMcpPath = join(p.path, 'mcp_config.json');

    for (const rawKey of keys) {
      const fullName = `${p.name}_${rawKey}`;
      if (!mcpByFullName.has(fullName)) mcpByFullName.set(fullName, []);
      mcpByFullName.get(fullName).push({
        plugin: p,
        rawKey,
        fullName,
        path: pluginMcpPath,
      });

      // 3a. Collision with user global `mcp_config.json`
      if (userMcpServerNames.has(fullName)) {
        items.push({
          id: `mcp-collision:user-exact:${p.dir}:${fullName}`,
          type: 'mcp-collision',
          severity: 'critical',
          titleZh: `MCP 服务名 "${fullName}" 与用户全局 mcp_config.json 冲突`,
          titleEn: `MCP server "${fullName}" collides with user mcp_config.json`,
          summaryZh: `插件 "${p.dir}" 注册的 MCP 服务 "${fullName}" 与用户全局 mcp_config.json 中已有键重名。`,
          summaryEn: `Plugin "${p.dir}" exposes MCP server "${fullName}", which collides with an entry in user mcp_config.json.`,
          detailZh: '重复的 MCP 服务名可能导致工具路由异常或其中一方无法挂载，建议重命名其中一处服务键名。',
          detailEn: 'Duplicate MCP server names may cause ambiguous tool routing or prevent a server from mounting; rename one server key.',
          winner: { dir: 'user-mcp-config', name: fullName, scope: 'user-global', path: userMcpPath },
          shadowed: [{ dir: p.dir, name: fullName, scope: p.scope, path: pluginMcpPath }],
          paths: [userMcpPath, pluginMcpPath],
          fixAction: null,
        });
      } else if (userMcpServerNames.has(rawKey)) {
        items.push({
          id: `mcp-collision:user-bare:${p.dir}:${rawKey}`,
          type: 'mcp-collision',
          severity: 'warning',
          titleZh: `MCP 服务键 "${rawKey}" 与用户全局 mcp_config.json 裸名重叠`,
          titleEn: `MCP server key "${rawKey}" overlaps with user mcp_config.json`,
          summaryZh: `插件 "${p.dir}" 的 MCP 键 "${rawKey}" 与用户全局 mcp_config.json 的同名服务键重叠，可能影响工具识别与选择。`,
          summaryEn: `Plugin "${p.dir}" uses MCP key "${rawKey}", which also exists in user mcp_config.json.`,
          detailZh: '尽管插件服务会带前缀挂载，同名裸键仍可能让模型在相似工具名之间混淆。',
          detailEn: 'Even with plugin prefixing, overlapping bare keys may confuse tool selection.',
          winner: { dir: 'user-mcp-config', name: rawKey, scope: 'user-global', path: userMcpPath },
          shadowed: [{ dir: p.dir, name: fullName, scope: p.scope, path: pluginMcpPath }],
          paths: [userMcpPath, pluginMcpPath],
          fixAction: null,
        });
      }

      // 3b. Generic bare server key warning
      if (GENERIC_MCP_SERVER_KEYS.has(String(rawKey).toLowerCase())) {
        items.push({
          id: `mcp-collision:generic:${p.dir}:${rawKey}`,
          type: 'mcp-collision',
          severity: 'warning',
          titleZh: `插件 "${p.dir}" 使用了通用 MCP 服务键 "${rawKey}"`,
          titleEn: `Plugin "${p.dir}" uses generic MCP server key "${rawKey}"`,
          summaryZh: `"${rawKey}" 属于通用键名（如 search / db / git / fs），建议使用更具体的服务名以减少工具混淆。`,
          summaryEn: `"${rawKey}" is a generic MCP server key (such as search / db / git / fs); consider a more specific name to reduce ambiguity.`,
          detailZh: `当前完整挂载名为 "${fullName}"，改为更具体的服务键名有助于与其他插件区分。`,
          detailEn: `Currently mounted as "${fullName}"; a more specific server key helps distinguish its tools from other plugins.`,
          winner: null,
          shadowed: [{ dir: p.dir, name: rawKey, scope: p.scope, path: pluginMcpPath }],
          paths: [pluginMcpPath],
          fixAction: null,
        });
      }
    }
  }

  // 3c. Duplicate `<plugin>_<server>` across active plugins
  for (const [fullName, entries] of mcpByFullName.entries()) {
    if (entries.length < 2) continue;
    const sorted = [...entries].sort((a, b) => {
      const rankDiff = (SCOPE_PRECEDENCE[b.plugin.scope] || 0) - (SCOPE_PRECEDENCE[a.plugin.scope] || 0);
      if (rankDiff !== 0) return rankDiff;
      return String(a.plugin.dir).localeCompare(String(b.plugin.dir));
    });
    const winner = sorted[0];
    const shadowed = sorted.slice(1);
    items.push({
      id: `mcp-collision:duplicate:${fullName}`,
      type: 'mcp-collision',
      severity: 'critical',
      titleZh: `重复的 MCP 服务名 "${fullName}"`,
      titleEn: `Duplicate MCP server name "${fullName}"`,
      summaryZh: `多个已启用插件同时声明了 MCP 服务 "${fullName}"（${sorted.map((e) => e.plugin.dir).join('、')}）。`,
      summaryEn: `Multiple active plugins register identical MCP server "${fullName}" (${sorted.map((e) => e.plugin.dir).join(', ')}).`,
      detailZh: 'Antigravity 全局按 <plugin>_<server> 路由 MCP 工具，重名可能导致后加载的 MCP 服务被覆盖或无法挂载。',
      detailEn: 'Antigravity mounts plugin MCP servers globally as <plugin>_<server>; duplicates may shadow each other or fail to mount.',
      winner: { dir: winner.plugin.dir, name: fullName, scope: winner.plugin.scope, path: winner.path },
      shadowed: shadowed.map((s) => ({ dir: s.plugin.dir, name: fullName, scope: s.plugin.scope, path: s.path })),
      paths: sorted.map((e) => e.path),
      fixAction: null,
    });
  }

  // ------------------------------------------------------------------------
  // Layer 4: `skill-shadowing` & `agent-shadowing` (warning)
  // ------------------------------------------------------------------------
  const skillOwners = new Map();
  const addSkillClaim = (skillName, claim) => {
    const key = String(skillName || '').trim();
    if (!key) return;
    if (!skillOwners.has(key)) skillOwners.set(key, []);
    skillOwners.get(key).push(claim);
  };

  for (const p of activePlugins) {
    for (const sk of Array.isArray(p.skills) ? p.skills : []) {
      addSkillClaim(sk.name, {
        dir: p.dir,
        name: sk.name,
        scope: p.scope,
        path: sk.path || join(p.path, 'skills', sk.dir, 'SKILL.md'),
      });
    }
  }

  // User global standalone skills (`~/.gemini/config/skills/*/SKILL.md`)
  for (const sk of scanStandaloneSkillsDir(join(resolvedConfigDir, 'skills'), 'user-global')) {
    addSkillClaim(sk.skillName, { dir: sk.dir, name: sk.name, scope: sk.scope, path: sk.path });
  }

  // Workspace standalone skills (`.agents/skills/*/SKILL.md` & `.agent/skills/*/SKILL.md`)
  for (const uri of workspaceUris || []) {
    const wsRoot = typeof uri === 'string' && uri.startsWith('file://') ? fileUriToLocalPath(uri) : uri;
    if (!wsRoot) continue;
    for (const rel of ['.agents/skills', '.agent/skills']) {
      for (const sk of scanStandaloneSkillsDir(join(wsRoot, rel), 'workspace-standalone')) {
        addSkillClaim(sk.skillName, { dir: sk.dir, name: sk.name, scope: sk.scope, path: sk.path });
      }
    }
  }

  // Builtin skill names: add a builtin claim whenever any non-builtin source claims a reserved builtin skill name
  for (const [skillName, claims] of skillOwners.entries()) {
    const hasExplicitBuiltin = claims.some((c) => c.scope === 'builtin');
    if (!hasExplicitBuiltin && builtinSkills.has(skillName)) {
      claims.push({
        dir: 'builtin',
        name: skillName,
        scope: 'builtin',
        path: `builtin://skills/${skillName}`,
      });
    }
  }

  for (const [skillName, claims] of skillOwners.entries()) {
    if (claims.length < 2) continue;
    const sorted = [...claims].sort((a, b) => {
      const rankDiff = (SCOPE_PRECEDENCE[b.scope] || 0) - (SCOPE_PRECEDENCE[a.scope] || 0);
      if (rankDiff !== 0) return rankDiff;
      return String(a.dir).localeCompare(String(b.dir));
    });
    const winner = sorted[0];
    const shadowed = sorted.slice(1);

    items.push({
      id: `skill-shadowing:${skillName}`,
      type: 'skill-shadowing',
      severity: 'warning',
      titleZh: `Skill "${skillName}" 存在重名覆盖`,
      titleEn: `Skill "${skillName}" is shadowed by duplicate definitions`,
      summaryZh: `${winner.dir}（${scopeLabelZh(winner.scope)}）优先生效，将覆盖 ${shadowed.map((s) => `${s.dir}（${scopeLabelZh(s.scope)}）`).join('、')} 的同名 Skill。`,
      summaryEn: `${winner.dir} (${winner.scope}) takes precedence and shadows ${shadowed.map((s) => `${s.dir} (${s.scope})`).join(', ')}.`,
      detailZh: '当多个插件、用户全局技能或内置技能共享相同 Skill 名称时，高优先级来源会覆盖低优先级来源。',
      detailEn: 'When multiple plugins, user skills, or built-in skills share the same name, the higher-precedence source overrides the rest.',
      winner,
      shadowed,
      paths: sorted.map((c) => c.path),
      fixAction: null,
    });
  }

  // Agents (`agents/*.md`)
  const agentOwners = new Map();
  const addAgentClaim = (agentName, claim) => {
    const key = String(agentName || '').trim();
    if (!key) return;
    if (!agentOwners.has(key)) agentOwners.set(key, []);
    agentOwners.get(key).push(claim);
  };

  for (const p of activePlugins) {
    const entries =
      Array.isArray(p.agentEntries) && p.agentEntries.length > 0
        ? p.agentEntries
        : (Array.isArray(p.agents) ? p.agents : []).map((name) => ({
            name,
            file: name,
            path: join(p.path, 'agents', `${name}.md`),
          }));
    for (const ag of entries) {
      addAgentClaim(ag.name, {
        dir: p.dir,
        name: ag.name,
        scope: p.scope,
        path: ag.path,
      });
    }
  }

  // User global standalone agents (`~/.gemini/config/agents/*.md`)
  for (const ag of scanStandaloneAgentsDir(join(resolvedConfigDir, 'agents'), 'user-global')) {
    addAgentClaim(ag.agentName, { dir: ag.dir, name: ag.name, scope: ag.scope, path: ag.path });
  }

  // Workspace standalone agents
  for (const uri of workspaceUris || []) {
    const wsRoot = typeof uri === 'string' && uri.startsWith('file://') ? fileUriToLocalPath(uri) : uri;
    if (!wsRoot) continue;
    for (const rel of ['.agents/agents', '.agent/agents']) {
      for (const ag of scanStandaloneAgentsDir(join(wsRoot, rel), 'workspace-standalone')) {
        addAgentClaim(ag.agentName, { dir: ag.dir, name: ag.name, scope: ag.scope, path: ag.path });
      }
    }
  }

  for (const [agentName, claims] of agentOwners.entries()) {
    const hasExplicitBuiltin = claims.some((c) => c.scope === 'builtin');
    if (!hasExplicitBuiltin && builtinAgents.has(agentName)) {
      claims.push({
        dir: 'builtin',
        name: agentName,
        scope: 'builtin',
        path: `builtin://agents/${agentName}`,
      });
    }
  }

  for (const [agentName, claims] of agentOwners.entries()) {
    if (claims.length < 2) continue;
    const sorted = [...claims].sort((a, b) => {
      const rankDiff = (SCOPE_PRECEDENCE[b.scope] || 0) - (SCOPE_PRECEDENCE[a.scope] || 0);
      if (rankDiff !== 0) return rankDiff;
      return String(a.dir).localeCompare(String(b.dir));
    });
    const winner = sorted[0];
    const shadowed = sorted.slice(1);

    items.push({
      id: `agent-shadowing:${agentName}`,
      type: 'agent-shadowing',
      severity: 'warning',
      titleZh: `Subagent "${agentName}" 存在重名覆盖`,
      titleEn: `Subagent "${agentName}" collides with another agent`,
      summaryZh: `${winner.dir}（${scopeLabelZh(winner.scope)}）将覆盖 ${shadowed.map((s) => `${s.dir}（${scopeLabelZh(s.scope)}）`).join('、')} 的同名 Subagent。`,
      summaryEn: `${winner.dir} (${winner.scope}) shadows ${shadowed.map((s) => `${s.dir} (${s.scope})`).join(', ')} for subagent "${agentName}".`,
      detailZh: '同名 Subagent 会覆盖低优先级来源的定义，建议停用多余插件或重命名。',
      detailEn: 'Duplicate subagent names override lower-precedence definitions; disable one plugin or rename the agent.',
      winner,
      shadowed,
      paths: sorted.map((c) => c.path),
      fixAction: null,
    });
  }

  // ------------------------------------------------------------------------
  // Layer 5: `host-enhancement-overlap` (warning for app-asar, info for cdp)
  // ------------------------------------------------------------------------
  const asarPlugins = [];
  const cdpPlugins = [];
  for (const p of activePlugins) {
    const kinds = resolveEffectiveHostEnhancementKinds(p, catalogByDir, catalogById);
    if (kinds.includes('app-asar')) asarPlugins.push(p);
    if (kinds.includes('cdp')) cdpPlugins.push(p);
  }

  if (asarPlugins.length >= 2) {
    const listStr = asarPlugins.map((p) => p.dir).join('、');
    const listStrEn = asarPlugins.map((p) => p.dir).join(', ');
    items.push({
      id: 'host-enhancement-overlap:app-asar',
      type: 'host-enhancement-overlap',
      severity: 'warning',
      titleZh: `多个已启用插件同时涉及 ${ASAR_LABEL} 修改`,
      titleEn: `Multiple active plugins modify ${ASAR_LABEL}`,
      summaryZh: `检测到 ${asarPlugins.length} 个启用中的插件（${listStr}）均涉及 ${ASAR_LABEL} 修改，可能互相覆盖补丁。`,
      summaryEn: `${asarPlugins.length} active plugins (${listStrEn}) modify ${ASAR_LABEL} and may overwrite each other's patches.`,
      detailZh: '如出现界面异常，建议在「已安装」页仅保留一个同类插件处于启用状态。',
      detailEn: 'If UI issues occur, keep only one of these plugins enabled in the Installed tab.',
      winner: null,
      shadowed: [],
      affectedPlugins: asarPlugins.map((p) => ({
        dir: p.dir,
        name: p.name,
        scope: p.scope,
        path: p.path,
      })),
      paths: asarPlugins.map((p) => p.path),
      fixAction: null,
    });
  }

  if (cdpPlugins.length >= 2) {
    const listStr = cdpPlugins.map((p) => p.dir).join('、');
    const listStrEn = cdpPlugins.map((p) => p.dir).join(', ');
    items.push({
      id: 'host-enhancement-overlap:cdp',
      type: 'host-enhancement-overlap',
      severity: 'info',
      titleZh: '多个已启用插件同时使用 CDP 界面增强',
      titleEn: 'Multiple active plugins use CDP UI enhancements',
      summaryZh: `检测到 ${cdpPlugins.length} 个启用中的 CDP 界面增强插件（${listStr}），可能出现主题样式或挂件叠加。`,
      summaryEn: `${cdpPlugins.length} active plugins (${listStrEn}) use CDP UI enhancements; visual styles or overlays may overlap.`,
      detailZh: '如出现样式重叠，可在「已安装」页停用其中一个插件。',
      detailEn: 'If styles overlap, disable one of them in the Installed tab.',
      winner: null,
      shadowed: [],
      affectedPlugins: cdpPlugins.map((p) => ({
        dir: p.dir,
        name: p.name,
        scope: p.scope,
        path: p.path,
      })),
      paths: cdpPlugins.map((p) => p.path),
      fixAction: null,
    });
  }

  // Deterministic severity-first ordering
  items.sort((a, b) => {
    const sDiff = (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9);
    if (sDiff !== 0) return sDiff;
    return String(a.id).localeCompare(String(b.id));
  });

  const critical = items.filter((i) => i.severity === 'critical').length;
  const warning = items.filter((i) => i.severity === 'warning').length;
  const info = items.filter((i) => i.severity === 'info').length;

  const affectedPluginPaths = new Set();
  for (const item of items) {
    if (item.severity !== 'critical' && item.severity !== 'warning') continue;
    if (item.winner?.path) affectedPluginPaths.add(item.winner.path);
    for (const s of item.shadowed || []) {
      if (s?.path) affectedPluginPaths.add(s.path);
    }
    for (const ap of item.affectedPlugins || []) {
      if (ap?.path) affectedPluginPaths.add(ap.path);
    }
  }

  const healthyCount = allInstalled.filter((p) => {
    if (affectedPluginPaths.has(p.path)) return false;
    // Also mark affected if any sub-file inside `p.path` (mcp_config.json, skills/, agents/) is in a critical/warning item
    const prefix = `${p.path}`;
    for (const ap of affectedPluginPaths) {
      if (ap === prefix || ap.startsWith(`${prefix}/`) || ap.startsWith(`${prefix}\\`)) {
        return false;
      }
    }
    return true;
  }).length;

  return {
    ok: true,
    checkedAt: new Date().toISOString(),
    summary: {
      total: items.length,
      critical,
      warning,
      info,
      healthyCount,
    },
    items,
  };
}
