---
name: agy-market
description: Open the AGY Market visual community plugin marketplace pane, search verified & experimental Antigravity plugins, inspect capability badges, check updates, and surface one-click sidecar:// and customization:// management pills. Use when the user asks to browse community plugins, open AGY Market, check plugin updates, or install/manage community Antigravity plugins.
---

# AGY Market · 反重力社区插件市场 (`agy-market`)

`agy-market` provides a zero-token visual Sidecar marketplace pane inside Google Antigravity for discovering, inspecting, and one-click installing language-agnostic community plugins (`skills/`, `rules/`, `agents/`, Sidecar UIs, and Python/Rust/Go/Node MCP bundles).

---

## 1. Opening the Visual Marketplace Pane

Whenever the user wants to browse, search, install, or update community plugins visually, emit the clickable `sidecar://` pill so they can open **AGY Market** in the right Auxiliary Pane with one click:

- [AGY Market](sidecar://agy-market/market_pane/)

To manage `agy-market` itself on Antigravity's native Customizations page, emit:

- [AGY Market](customization://agy-market)

---

## 2. Managing Installed Community Plugins (`customization://<dir>`)

Follow Antigravity's host lifecycle guardrails strictly:

1. **Always key `customization://<dir>` links on the install directory `<dir>`** (e.g. `customization://agy-wallpaper-prism` or `customization://dev-team--quick-note` for scoped Track-2 installs), **never** on `plugin.json.name` when `<dir>` differs, and **never** emit `plugin://` or `plugins://` links.
2. **Never edit `~/.gemini/config/config.json` or call restricted mutation RPCs** (`JetboxWriteState`, `DeletePlugin`, `InstallCustomization`). Give the user `[<DisplayName>](customization://<dir>)` to toggle Enable/Disable live or uninstall cleanly.
3. If an installed plugin also provides an Auxiliary Pane Sidecar view and is enabled, surface its `sidecar://<dir>/<sidecar_folder>/` pill alongside its `customization://<dir>` link.

---

## 3. Capability Badge Reference

When summarizing plugins from the AGY Market catalog, present capability badges transparently and non-alarmingly:

- `🟢 纯声明式 · 0进程` (`declarative-only`): Pure `SKILL.md` / subagent markdown; zero background processes.
- `🔵 常驻规则 (~N tok)` (`global-rules`): Contains `rules/*.md` loaded while enabled.
- `🟣 Sidecar 面板 · 0 Token` (`sidecar-ui`): Visual Sidecar panel with zero idle LLM token cost.
- `🟠 本地 MCP 进程` (`mcp-stdio`) / `🌐 远程 MCP 服务` (`mcp-remote`): Provides MCP tools via `mcp_config.json`.
- `🔶 生命周期钩子 (Hooks)` (`lifecycle-hooks`): Subscribes to lifecycle events via `hooks.json`.
- `💡 宿主界面增强` (`host-enhancement`): Uses CDP or `app.asar` workbench enhancements (e.g. acrylic skins or companion widgets). Fully welcomed in Track 1; describe neutrally as a UI enhancement.

---

## 4. Safe CLI Diagnostics (`bin/agy-market.mjs`)

```powershell
# Inspect local installed plugins, market receipts, and config/data paths (read-only)
node "<agy-market-plugin-dir>/bin/agy-market.mjs" status

# Run health diagnostics & sweep retired Windows *.old.<ts> binaries
node "<agy-market-plugin-dir>/bin/agy-market.mjs" doctor
```
