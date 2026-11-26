---
name: agy-market
description: Open the AGY Market visual community plugin marketplace pane, search verified & experimental Antigravity plugins across 15 categories, preflight and install unlisted plugins directly from any GitHub URL, inspect capability badges, run direct in-Sidebar updates or one-click batch updates, uninstall global community plugins safely (in Sidebar or via CLI), and surface one-click sidecar:// and customization:// management pills. Use when the user asks to browse community plugins, open AGY Market, install a plugin from a GitHub repository URL, check or apply plugin updates, uninstall a plugin, or manage community Antigravity plugins.
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
2. **CLI (`npx --yes github:azwosile/agy-market add <github-url>`)**:
   ```bash
   # Preflight and install from any GitHub plugin URL (interactive confirmation)
   npx --yes github:azwosile/agy-market add <github-url>

   # Target a specific Monorepo subdirectory or install non-interactively with scoped isolation
   npx --yes github:azwosile/agy-market add <github-url> --subpath <dir> --isolate --yes
   ```
   - Local installed binary equivalent: `node "<agy-market-plugin-dir>/bin/agy-market.mjs" add <github-url>` (also supports `--replace`, `--dest <plugins-dir>`, `--mirror <prefix>`, `--token <pat>`, and `--json`).
   - If preflight returns `NOT_A_PLUGIN_REPO` or `SECURITY_BLOCKED`, report the exact reason and repository overview to the user instead of bypassing safety checks or manually editing `~/.gemini/config/config.json`.

---

## 3. Updating & Uninstalling Installed Community Plugins

### 3.1 Direct In-Sidebar Updates & One-Click Update All
- Open `[AGY Market](sidecar://agy-market/market_pane/)` and switch to **已安装 (`Installed`)**:
  - **Per-plugin direct update**: Every installed plugin card provides an **Update (`更新`)** button. Both catalog releases and newer GitHub upstream Release/Tag or GitHub URL builds are downloaded, inspected, and synced directly inside the Sidebar without opening external browser download pages, preserving original catalog verification metadata (`track`, `repositoryId`).
  - **One-click batch update**: Click the permanent **一键更新 (`Update All`)** button beside **检查更新 (`Check Updates`)** to check and sequentially update all installed plugins across catalog, GitHub upstream, and GitHub URL channels (scheduling `agy-market` self-update last; native `.git` clones and unversioned external plugins are excluded with read-only status pills).
- **`app.asar` patch plugins**: When installing or updating a plugin with `hostEnhancementKind: ["app-asar"]`, remind the user to run its bundled patch script (e.g., `node setup.cjs` per the plugin README) before restarting Antigravity, and re-run it after market updates to sync injected client code.

### 3.2 Lock-Safe Uninstall (Sidebar & CLI)
- **Sidebar one-click uninstall**: Every global community plugin card (excluding `agy-market`, `workspace`, and `builtin` plugins) and its Detail Drawer provide a **卸载 (`Uninstall`)** button with confirmation dialog (optionally removing the plugin from favorites). It cleans both active (`~/.gemini/config/plugins/<dir>`) and Vault-Parked (`${PLUGIN_DATA}/disabled-plugins/<dir>`) directories, unlinks symlinks without deleting target source folders, and retires Windows `EBUSY`-locked files to `.old.<ts>` while immediately removing `plugin.json`.
- **CLI (`npx --yes github:azwosile/agy-market uninstall <dir>`)**:
  ```bash
  # Uninstall a global community plugin safely (interactive confirmation; alias: remove)
  npx --yes github:azwosile/agy-market uninstall <dir>

  # Non-interactive uninstall with machine-readable JSON output
  npx --yes github:azwosile/agy-market uninstall <dir> --yes --json
  ```

### 3.3 Host Lifecycle Guardrails (`customization://<dir>`)

Follow Antigravity's host lifecycle guardrails strictly:

1. **Always key `customization://<dir>` links on the install directory `<dir>`** (e.g. `customization://agy-wallpaper-prism` or `customization://dev-team--quick-note` for scoped Track-2 installs), **never** on `plugin.json.name` when `<dir>` differs, and **never** emit `plugin://` or `plugins://` links.
2. **Never edit `~/.gemini/config/config.json` or call restricted mutation RPCs** (`JetboxWriteState`, `DeletePlugin`, `InstallCustomization`). Give the user `[<DisplayName>](customization://<dir>)` when they want to open Antigravity's native Customizations page.
3. If an installed plugin also provides an Auxiliary Pane Sidebar view and is enabled, surface its `sidecar://<dir>/<sidecar_folder>/` pill alongside its `customization://<dir>` link.

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
npx --yes github:azwosile/agy-market add <github-url>

# Lock-safe uninstall of an installed global plugin (alias: remove; supports --yes, --dest <plugins-dir>, --json)
npx --yes github:azwosile/agy-market uninstall <dir>
npx --yes github:azwosile/agy-market uninstall <dir> --yes --json

# Inspect local installed plugins, market receipts, and config/data paths (read-only)
node "<agy-market-plugin-dir>/bin/agy-market.mjs" status

# Run installation diagnostics & sweep retired Windows *.old.<ts> binaries and empty shells
node "<agy-market-plugin-dir>/bin/agy-market.mjs" doctor
```
