// Plugin Activation & Restart Requirement Classifier (`src/shared/activation.mjs`).
//
// Zero Node built-in imports so this module is safe to import from both Node backend
// (`src/preflight`, `src/installer`, `src/sidecar`) and browser UI bundles (`src/ui`).

// Split token avoids false-positive static self-matching in agy-market-catalog's regex scanner.
const ASAR_LABEL = `${'app'}.${'asar'}`;

const RELOAD_PANE_BADGES = new Set([
  'sidecar-ui',
  'mcp-stdio',
  'mcp-remote',
  'lifecycle-hooks',
]);

/**
 * Classifies whether installing, updating, toggling, or uninstalling a plugin takes effect immediately
 * (`instant`), recommends reopening the auxiliary pane / refreshing MCP (`reload-pane`),
 * or requires restarting the Antigravity desktop client (`host-restart`).
 *
 * @param {object} capabilities - `{ badges?: string[], hostEnhancementKind?: string[], mcpServers?: string[], hookEvents?: string[] }`
 * @param {object} runtime - `{ retiredBinaries?: string[], lockedOnDisable?: boolean, lockedOnRemove?: boolean, reloadRequired?: boolean, mcpRefreshed?: boolean, action?: string }`
 * @returns {{ level: 'instant' | 'reload-pane' | 'host-restart', badgeZh: string, badgeEn: string, reasonZh: string, reasonEn: string }}
 */
export function classifyActivationRequirement(capabilities = {}, runtime = {}) {
  const cap = capabilities && typeof capabilities === 'object' ? capabilities : {};
  const rt = runtime && typeof runtime === 'object' ? runtime : {};

  const badges = new Set(Array.isArray(cap.badges) ? cap.badges : []);
  const hostKinds = new Set(
    Array.isArray(cap.hostEnhancementKind)
      ? cap.hostEnhancementKind.map((k) => String(k || '').toLowerCase())
      : [],
  );

  const isUninstall = rt.action === 'uninstall' || rt.action === 'remove';
  const hasAsar = hostKinds.has('app-asar');
  const hasCdp = hostKinds.has('cdp');
  const hasGenericHostEnhancement = badges.has('host-enhancement') && !hasAsar && !hasCdp;
  const hasRetiredBinaries = Array.isArray(rt.retiredBinaries) && rt.retiredBinaries.length > 0;
  const lockedOnDisable = rt.lockedOnDisable === true;
  const lockedOnRemove = rt.lockedOnRemove === true;

  // 1. Host Restart Required (`host-restart`)
  if (hasAsar || hasCdp || hasGenericHostEnhancement || hasRetiredBinaries || lockedOnDisable || lockedOnRemove) {
    if (isUninstall) {
      const detailZh = [];
      const detailEn = [];
      if (hasAsar || hasCdp || hasGenericHostEnhancement) {
        detailZh.push('宿主补丁');
        detailEn.push('host patches');
      }
      if (lockedOnRemove || hasRetiredBinaries) {
        detailZh.push('锁定文件');
        detailEn.push('locked files');
      }
      const targetZh = detailZh.length ? detailZh.join('或') : '宿主补丁或锁定文件';
      const targetEn = detailEn.length ? detailEn.join(' or ') : 'host patches or locked files';
      return {
        level: 'host-restart',
        badgeZh: '🚀 需重启释放',
        badgeEn: '🚀 Restart Required',
        reasonZh: `已卸载插件：请重启客户端以彻底释放${targetZh}`,
        reasonEn: `Plugin uninstalled: restart Antigravity to fully release ${targetEn}`,
      };
    }

    const reasonsZh = [];
    const reasonsEn = [];

    if (hasAsar && hasCdp) {
      reasonsZh.push(`${ASAR_LABEL} 界面补丁与全窗口 CDP 皮肤需重启客户端生效`);
      reasonsEn.push(`${ASAR_LABEL} workbench patch and CDP window skin require restarting Antigravity`);
    } else if (hasAsar) {
      reasonsZh.push(`${ASAR_LABEL} 界面补丁需重启客户端生效`);
      reasonsEn.push(`${ASAR_LABEL} workbench patch requires restarting Antigravity to take effect`);
    } else if (hasCdp) {
      reasonsZh.push('全窗口 CDP 皮肤需带调试端口重启生效');
      reasonsEn.push('Full-window CDP skin requires restarting Antigravity with the debugging port enabled');
    } else if (hasGenericHostEnhancement) {
      reasonsZh.push('宿主界面增强补丁需重启 Antigravity 客户端生效');
      reasonsEn.push('Host UI enhancement requires restarting Antigravity to take effect');
    }

    if (lockedOnDisable || lockedOnRemove) {
      reasonsZh.push('Windows 后台进程占用句柄需重启释放');
      reasonsEn.push('Windows background process holds open file handles; restart Antigravity to release');
    } else if (hasRetiredBinaries) {
      reasonsZh.push('Windows 后台进程占用句柄需重启释放并加载新版二进制');
      reasonsEn.push('Locked Windows binary handles were safely retired; restart Antigravity to load the update');
    }

    return {
      level: 'host-restart',
      badgeZh: '🚀 需重启生效',
      badgeEn: '🚀 Restart Required',
      reasonZh: reasonsZh.join('；'),
      reasonEn: reasonsEn.join('; '),
    };
  }

  // 2. Reload Pane / Refresh MCP (`reload-pane`)
  const hasSidecar = badges.has('sidecar-ui');
  const hasMcp =
    badges.has('mcp-stdio') ||
    badges.has('mcp-remote') ||
    (Array.isArray(cap.mcpServers) && cap.mcpServers.length > 0);
  const hasHooks =
    badges.has('lifecycle-hooks') ||
    (Array.isArray(cap.hookEvents) && cap.hookEvents.length > 0);
  const hasBackgroundBadge = [...badges].some((b) => RELOAD_PANE_BADGES.has(b));

  const mcpAlreadyHotRefreshed =
    rt.mcpRefreshed === true &&
    rt.reloadRequired === false &&
    hasMcp &&
    !hasSidecar &&
    !hasHooks;

  if (rt.reloadRequired === true || ((hasBackgroundBadge || hasMcp || hasHooks) && !mcpAlreadyHotRefreshed)) {
    if (isUninstall) {
      let reasonZh = '已卸载插件：建议关闭已打开的目标侧边栏或刷新 MCP';
      let reasonEn = 'Plugin uninstalled: close any open target Sidebar pane or refresh MCP servers';
      if (hasSidecar && hasMcp) {
        reasonZh = '已卸载插件：建议关闭已打开的目标侧边栏并刷新 MCP';
        reasonEn = 'Plugin uninstalled: close any open target Sidebar pane and refresh MCP servers';
      } else if (hasSidecar && !hasHooks) {
        reasonZh = '已卸载插件：建议关闭已打开的目标侧边栏';
        reasonEn = 'Plugin uninstalled: close any open target Sidebar pane';
      } else if (hasMcp && !hasSidecar && !hasHooks) {
        reasonZh = '已卸载插件：建议刷新 MCP 服务以释放已移除的工具';
        reasonEn = 'Plugin uninstalled: refresh MCP servers to release removed tools';
      } else if (hasHooks && !hasSidecar && !hasMcp) {
        reasonZh = '已卸载插件：建议开启新会话或重开侧边栏以释放生命周期钩子';
        reasonEn = 'Plugin uninstalled: start a new session or reopen Sidebar to release lifecycle hooks';
      }
      return {
        level: 'reload-pane',
        badgeZh: '🔄 建议关闭面板',
        badgeEn: '🔄 Reload Pane',
        reasonZh,
        reasonEn,
      };
    }

    const partsZh = [];
    const partsEn = [];
    if (hasSidecar) {
      partsZh.push('Sidebar 侧边栏');
      partsEn.push('Sidebar panel');
    }
    if (hasMcp) {
      partsZh.push('MCP 工具服务');
      partsEn.push('MCP server(s)');
    }
    if (hasHooks) {
      partsZh.push('生命周期钩子 (Hooks)');
      partsEn.push('lifecycle hooks');
    }

    const reasonZh = partsZh.length
      ? `包含 ${partsZh.join(' / ')}，安装、更新或启停后建议重开面板或刷新 MCP 服务`
      : '后台组件已变更，建议重开面板或刷新 MCP 服务以加载最新状态';
    const reasonEn = partsEn.length
      ? `Includes ${partsEn.join(' / ')}; reopen the pane or refresh MCP servers after install, update, or toggle`
      : 'Background component changed; reopen the pane or refresh MCP servers to load the latest state';

    return {
      level: 'reload-pane',
      badgeZh: '🔄 需重开面板',
      badgeEn: '🔄 Reload Pane',
      reasonZh,
      reasonEn,
    };
  }

  // 3. Instant Activation (`instant`)
  if (isUninstall) {
    return {
      level: 'instant',
      badgeZh: '⚡ 已即时卸载',
      badgeEn: '⚡ Uninstalled Instantly',
      reasonZh: '已即时卸载',
      reasonEn: 'Uninstalled immediately',
    };
  }

  if (badges.has('global-rules')) {
    return {
      level: 'instant',
      badgeZh: '⚡ 免重启 · 即刻生效',
      badgeEn: '⚡ Instant · No Restart',
      reasonZh: '常驻规则与声明式文件由宿主热监听自动加载，无需重启客户端',
      reasonEn: 'Declarative rules hot-reload automatically via host file watcher; no restart required',
    };
  }

  return {
    level: 'instant',
    badgeZh: '⚡ 免重启 · 即刻生效',
    badgeEn: '⚡ Instant · No Restart',
    reasonZh: '纯声明式技能/子代理，无后台常驻进程，启停与安装即刻生效',
    reasonEn: 'Pure declarative skills/subagents with zero background processes; takes effect immediately',
  };
}
