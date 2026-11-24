---
name: agy-market
description: Open the AGY Market visual community plugin marketplace pane, search verified & experimental Antigravity plugins, preflight and install unlisted plugins directly from any GitHub URL, inspect capability badges, check updates, and surface one-click sidecar:// and customization:// management pills. Use when the user asks to browse community plugins, open AGY Market, install a plugin from a GitHub repository URL, check plugin updates, or install/manage community Antigravity plugins.
---

# AGY Market · 反重力社区插件市场 (`agy-market`)

`agy-market` provides a Sidebar marketplace panel inside Google Antigravity for discovering, inspecting, and installing language-agnostic community plugins (`skills/`, `rules/`, `agents/`, Sidebar UIs, and Python/Rust/Go/Node MCP bundles), including direct preflight installation from any GitHub plugin URL.

---

## 1. Opening the Visual Marketplace Pane

Whenever the user wants to browse, search, install, or update community plugins visually, emit the clickable `sidecar://` pill so they can open **AGY Market** in the right Auxiliary Pane with one click:

- [AGY Market](sidecar://agy-market/market_pane/)

To manage `agy-market` itself on Antigravity's native Customizations page, emit:

- [AGY Market](customization://agy-market)

---

## 2. Installing Unlisted Plugins from Any GitHub URL

When the user provides any GitHub repository URL that is not yet indexed in the catalog (repository homepage, `/tree/<branch>/<subpath>`, `/blob/<ref>/[<subpath>/]plugin.json`, `/releases/tag/<tag>`, or `.tar.gz` archive link — including single-subdirectory plugins, Monorepos, and repositories without Release tags), you can preflight and install it directly in two ways:

1. **Sidebar Panel Top Bar (`链接添加` / `Add URL`)**:
   - Emit `[AGY Market](sidecar://agy-market/market_pane/)` and guide the user to click the top-bar **「链接添加」** (`Add URL`) button, paste the full GitHub URL, and run preflight inspection.
   - Preflight automatically detects root `plugin.json`, `.antigravity-plugin/plugin.json`, unique named subdirectories (e.g. `agy-capsule/plugin.json`), or lets the user pick a plugin directory in a Monorepo, then displays capability badges, SHA-256 digest, short commit SHA, and native vs. `<owner>--<slug>` scoped install options before writing files.
2. **CLI (`npx agy-market add <github-url>`)**:
   ```bash
   # Preflight and install from any GitHub plugin URL (interactive confirmation)
   npx agy-market add <github-url>

   # Target a specific Monorepo subdirectory or install non-interactively with scoped isolation
   npx agy-market add <github-url> --subpath <dir> --isolate --yes
   ```
   - Local installed binary equivalent: `node "<agy-market-plugin-dir>/bin/agy-market.mjs" add <github-url>` (also supports `--replace`, `--dest <plugins-dir>`, `--mirror <prefix>`, `--token <pat>`, and `--json`).
   - If preflight returns `NOT_A_PLUGIN_REPO` or `SECURITY_BLOCKED`, report the exact reason and repository overview to the user instead of bypassing safety checks or manually editing `~/.gemini/config/config.json`.

---

## 3. Managing Installed Community Plugins (`customization://<dir>`)

Follow Antigravity's host lifecycle guardrails strictly:

1. **Always key `customization://<dir>` links on the install directory `<dir>`** (e.g. `customization://agy-wallpaper-prism` or `customization://dev-team--quick-note` for scoped Track-2 installs), **never** on `plugin.json.name` when `<dir>` differs, and **never** emit `plugin://` or `plugins://` links.
2. **Never edit `~/.gemini/config/config.json` or call restricted mutation RPCs** (`JetboxWriteState`, `DeletePlugin`, `InstallCustomization`). Give the user `[<DisplayName>](customization://<dir>)` to toggle Enable/Disable live or uninstall cleanly.
3. If an installed plugin also provides an Auxiliary Pane Sidecar view and is enabled, surface its `sidecar://<dir>/<sidecar_folder>/` pill alongside its `customization://<dir>` link.

---

## 4. Capability Badge Reference

When summarizing plugins from the AGY Market catalog, present capability badges transparently and non-alarmingly:

- `🟢 纯声明式技能` (`declarative-only`, `Declarative Skill`): Pure `SKILL.md` / subagent markdown; no background processes or hooks.
- `🔵 常驻规则 (~N tok)` (`global-rules`): Contains `rules/*.md` loaded while enabled.
- `🟣 Sidebar 侧边栏` (`sidecar-ui`, `Sidebar Panel`): Provides a visual interactive panel in the right Sidebar.
- `🟠 本地 MCP 进程` (`mcp-stdio`) / `🌐 远程 MCP 服务` (`mcp-remote`): Provides MCP tools via `mcp_config.json`.
- `🔶 生命周期钩子 (Hooks)` (`lifecycle-hooks`): Subscribes to lifecycle events via `hooks.json`.
- `💡 宿主界面增强` (`host-enhancement`): Uses CDP or `app.asar` workbench enhancements (e.g. acrylic skins or companion widgets). Fully welcomed in Track 1; describe neutrally as a UI enhancement.

---

## 5. Safe CLI Commands (`bin/agy-market.mjs`)

```powershell
# Preflight and install an unlisted plugin directly from a GitHub URL
npx agy-market add <github-url>

# Inspect local installed plugins, market receipts, and config/data paths (read-only)
node "<agy-market-plugin-dir>/bin/agy-market.mjs" status

# Run installation diagnostics & sweep retired Windows *.old.<ts> binaries
node "<agy-market-plugin-dir>/bin/agy-market.mjs" doctor
```
