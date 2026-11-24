<div align="center">

<img src="assets/logo.svg" alt="AGY Market Logo" width="84" />

# AGY Market (`agy-market`)

**Community Plugin Marketplace for Google Antigravity**

Sidebar Panel UI · GitHub URL Preflight Installer · ⭐ Pinned Favorites Shelf & Tab · Live Installed Search & Filters · One-Click Sidebar Launcher · Native Vault-Parking Toggle Sliders · Local Conflict Checks · Dual-Mirror China Acceleration · SHA-256 Verified Installs

[简体中文](./README.md) · **English** · **[📖 Submit a Plugin Guide](https://github.com/azwosile/agy-market-catalog/blob/main/docs/SUBMISSION_GUIDE.md)** · [Plugin Catalog](https://github.com/azwosile/agy-market-catalog) · [Architecture Spec](./AGENTS.md)

</div>

---

> **Repository Boundary**: This repository ([`azwosile/agy-market`](https://github.com/azwosile/agy-market)) houses the **AGY Market** Sidebar client plugin, Windows lock-safe tarball installer, `npx agy-market` bootstrap CLI, and static web showcase (`site/`).
>
> To list your plugin in the community catalog, click **`+ Submit Plugin`** (`+ 申请收录插件`) in AGY Market or follow the step-by-step **[📖 Plugin Submission Guide (`docs/SUBMISSION_GUIDE.md`)](https://github.com/azwosile/agy-market-catalog/blob/main/docs/SUBMISSION_GUIDE.md)** to open a single-YAML Pull Request in **[`azwosile/agy-market-catalog`](https://github.com/azwosile/agy-market-catalog)**.

---

## ✨ Highlights (v1.4.0)

### 1. Sidebar Panel UI & Navigation
- **Native Right Sidebar Panel**: Runs inside Antigravity's native `AUX_PANE` extension view (`sidecars/market_pane/sidecar.json`) with no bundled MCP servers, keeping the panel lightweight and responsive.
- **Overview Strip & Plugin Cards**: Collapsible top overview strip displays catalog stats (*Indexed / Active / Updates / Local Conflicts*) alongside quick **`Add URL`** (`链接添加`) and **`+ Submit Plugin`** actions. Card styles adapt across Dark, Light, and translucent wallpaper skins (such as Wallpaper Prism).
- **2-Line Titles + Clickable GitHub Links**: Clicking any **plugin title** in cards or the Detail Drawer opens its GitHub repository directly in a new window, while clicking the card body opens the Detail Drawer.
- **Multilingual README Drawer**: Queries `/api/readme?id=...&locale=zh|en`, preferring localized `entriesZh` / `entriesEn` from the catalog (or local `README.zh-CN.md` / `README.zh.md` for installed plugins) and rendering localized descriptions on installed cards.
- **Direct One-Click Sidebar Launcher**: Replaces raw `<a href="sidecar://...">` links blocked inside isolated iframes. Inside the host panel, clicking a sibling plugin's **Panel** button invokes host `window.sidecar.ui.toggleAuxPane` (`tabType: "sidecarView"`) directly to open or focus its Sidebar panel—no manual copy prompts.

### 2. ⭐ Favorites Shelf & Tab, Installed Search/Filters & Update Error Alerts
- **⭐ Pinned Favorites Shelf & Dedicated Favorites Tab**:
  - Every plugin card (Discover, Favorites, Installed) and the Detail Drawer header feature a tactile star button (`☆` / glowing amber `★`) backed by `POST /api/favorites` persisted atomically in `prefs.json`.
  - When 1 or more plugins are starred, a collapsible **Pinned Favorites Shelf (`★ Favorites`)** appears above the Discover grid, complemented by a dedicated **`★ Favorites`** top navigation tab (`Discover · Favorites · Installed · Conflicts & Diagnostics · Sources & Settings`).
- **Live Search & Status Filters in `Installed` View**:
  - The **Installed** view includes a live search bar (matching display name, directory name, or description) and quick status filter pills (**All / Enabled / Disabled / Updatable**) for fast management at scale.
- **High-Visibility Update Error Alert Banner (Zero Silent Failures)**:
  - Whenever an install/update, batch **Update All**, or self-update fails due to network errors, SHA-256 mismatch, or permissions, a dismissible red error banner and error toast surface the affected plugin, exact failure reason, and a one-click **Retry** button.

### 3. Native Card-Footer Enable / Disable Slider (Vault Parking)
- **Zero Writes to `config.json`**: Antigravity's Language Server write-protects `~/.gemini/config/config.json`. AGY Market reads `config.json` strictly read-only and powers live toggling via **Vault Parking** (`POST /api/toggle-plugin`):
  - **Toggle OFF (Disable)**: Moves `~/.gemini/config/plugins/<dir>` cleanly into `${PLUGIN_DATA}/disabled-plugins/<dir>`. Host hot-watch unloads its Skills / Rules / Hooks within ~1 second.
  - **Toggle ON (Enable)**: Moves the folder back into `~/.gemini/config/plugins/<dir>` and removes any stale `"disabled": true` flag.
  - **Update While Parked**: Disabled plugins remain visible in *Installed* and *Discover* tabs and update in-place inside `disabled-plugins/<dir>` without accidentally reactivating them.
  - **Safe Locking**: `agy-market` itself stays locked ON to prevent disconnecting its own panel; `workspace`, `builtin`, and host-disabled plugins show clear read-only lock states.

### 4. Local Plugin Conflict Checks & Fixes
Dedicated **Conflicts & Diagnostics** tab (`GET /api/conflicts`) with read-only static conflict checks and one-click fixes (`POST /api/fix-conflict`):

| Check | Severity | What It Detects | Quick Action |
| :--- | :---: | :--- | :--- |
| `duplicate-plugin-name` | Critical | Duplicate `plugin.json.name` across `workspace > global > builtin` precedence, pinpointing the winner and silently dropped victim directories | 1-click `<owner>--<slug>` scoped isolation rename |
| `windows-symlink-ignored` | Critical | Symlinks or NTFS junctions inside `~/.gemini/config/plugins/` that Windows `GetAllPlugins` silently skips | 1-click materialize to real directory |
| `mcp-collision` | Critical / Warning | Duplicate `<plugin>_<server>` keys, collisions with global `mcp_config.json`, or bare generic server names (`search`, `db`, `fetch`, etc.) | Pinpoints colliding keys & sources |
| `skill-shadowing` / `agent-shadowing` | Warning | Overlapping `skills/*/SKILL.md` or `agents/*.md` across active plugins, `~/.gemini/config/skills/*`, and built-in reserved names | Shows full override chain |
| `host-enhancement-overlap` | Warning / Info | Two or more active plugins modifying `app.asar` (**Warning**, patch overlap risk) or using `cdp` UI enhancements (**Info**, generally compatible) | Advisory to review or disable duplicate |

### 5. Action-Triggered Restart & Reload Prompts
Cards and the Detail Drawer stay clutter-free without static restart chips. Activation prompts appear **only after an install, update, batch update succeeds** (or when a Windows disable retires a locked binary):
- **Declarative Skills / Global Rules (`instant`)**: Hot-reloads immediately with no restart required.
- **Sidebar Panel / MCP / Hooks (`reload-pane`)**: Prompts to reopen the Sidebar panel or refresh MCP after update/install completes.
- **`app.asar` / First-Time `cdp` / Retired Locked Binaries (`host-restart`)**: Displays a clear banner reminding you to restart Antigravity for changes to take full effect.

### 6. Built-In GitHub Discussions Integration
- Every plugin Detail Drawer includes a **Discussions** tab (`GET /api/discussions`) that detects whether Discussions are enabled on the repository without needing a token and provides direct links to browse or start a thread.
- Optionally configuring a personal GitHub Token in Settings (stored locally in `prefs.json` with `0600` permissions; never logged or persisted in caches) loads the latest 10 repository discussions directly inside the Sidebar panel.

### 7. Dual-Mirror China Acceleration & SHA-256 Verified Installs
- **Three-Tier Live Catalog Resolution (No Stale Bundled Snapshot)**:
  1. **Custom Feeds**: User/team static `index.json` URLs configured in `prefs.json` take highest priority.
  2. **Primary Channel (GitHub Pages + `gh-pages` Raw Fallback)**: Conditional `ETag` (`If-None-Match`) / `If-Modified-Since` requests achieve `<50ms` `304 Not Modified` cache hits.
  3. **Automatic Mainland China Mirror Fallback**: If GitHub Pages times out (`> 3.5s`) or fails, streams the pure-JSON `@agy-market/catalog` transport package from `registry.npmmirror.com` or `mirrors.cloud.tencent.com/npm` in memory; falls back to disk cache when offline.
- **Language-Agnostic & SHA-256 Verified**: npm is used **strictly** as a JSON mirror CDN for catalog metadata—listed plugins do **not** need to be npm or JavaScript projects. Optional GitHub Release mirror prefixes are supported safely because every tarball is streamed and verified against the catalog `sha256` digest before extraction (`INTEGRITY_SHA256_MISMATCH` aborts immediately on any mismatch).

---

## 🚀 One-Line Bootstrap Install

> Requires **Node.js >= 22.0.0** (zero runtime npm dependencies), or use the zero-npm OS installers below.

- **Node / `npx` (Cross-Platform, Recommended)**:
  ```bash
  npx agy-market@latest
  ```
- **Windows PowerShell (Zero npm, SHA-256 Verified + Catalog Fallback)**:
  ```powershell
  irm https://raw.githubusercontent.com/azwosile/agy-market/main/scripts/install.ps1 | iex
  ```
- **macOS / Linux Shell (Zero npm, SHA-256 Verified + Catalog Fallback)**:
  ```sh
  curl -fsSL https://raw.githubusercontent.com/azwosile/agy-market/main/scripts/install.sh | sh
  ```

Once installed in Antigravity:
- Open the Sidebar Panel: click `[AGY Market](sidecar://agy-market/market_pane/)` in chat, or open **Sidebar (`+`) → `Plugins` → `AGY Market`**.
- Manage on Native Customizations Page: `[AGY Market](customization://agy-market)`

---

## 🔗 Adding Plugins from Any GitHub URL

Starting with v1.4.0, you can preflight and install any community plugin directly from a full GitHub URL without waiting for catalog indexing — including single-subdirectory layouts, Monorepos, and repositories without Release tags.

### Option 1: Sidebar Top Bar `Add URL` (`链接添加`) Button (Two-Step Preflight)
1. Open the AGY Market Sidebar panel and click **`Add URL`** (`链接添加`) in the top bar (or click **Add via GitHub URL** when a Discover search returns no matches).
2. Paste any full GitHub URL and click **Inspect**:
   - Repository homepage: `https://github.com/<owner>/<repo>` (resolves latest Release → Git Tag → default branch commit automatically)
   - Branch or subdirectory: `https://github.com/<owner>/<repo>/tree/<branch>/<subpath>`
   - Manifest blob URL: `https://github.com/<owner>/<repo>/blob/<ref>/[<subpath>/]plugin.json`
   - Release / tag / archive URLs: `/releases/tag/<tag>`, `/releases/latest`, `/releases/download/<tag>/<asset>.tar.gz`, `/archive/...tar.gz`
3. AGY Market downloads the archive into an external staging directory and runs local static checks before installing:
   - **Multi-layout detection**: Supports root `plugin.json`, `.antigravity-plugin/plugin.json`, automatic unique-subdirectory detection (e.g. `agy-capsule/plugin.json`), and interactive subpath selection for Monorepo repositories (`plugins/*`, `.agents/plugins/*`, etc.).
   - **Preflight & safety checks**: Displays version or short `commitSha`, SHA-256 digest, capability badges, and install mode (native directory vs. `<owner>--<slug>` scoped isolation). Repositories missing a valid `plugin.json` or failing traversal/symlink/rule-smuggling checks are rejected with clear diagnostics and zero leftover files.
   - **Installed tracking & updates**: Installed items display a `GitHub URL` source badge in *Installed*, work with the Vault-Parking toggle slider, and check for updates via Release Tag or branch commit SHA.

### Option 2: CLI `npx agy-market add <github-url>`
```bash
# Inspect and interactively install any GitHub plugin repository (supports subpaths & branch commits)
npx agy-market add https://github.com/<owner>/<repo>

# Target a specific Monorepo subdirectory with <owner>--<slug> scoped isolation and non-interactive confirmation
npx agy-market add https://github.com/<owner>/<repo> --subpath plugins/<name> --isolate --yes

# Optional flags: --replace, --dest <plugins-dir>, --mirror <prefix>, --token <pat>, --json
npx agy-market add https://github.com/<owner>/<repo>/tree/main/<subpath> --yes --json
```

---

## 🏷️ Capability Badges & Update Escalation Confirmation

Every plugin surfaces static capability badges beside the Install button before installation:

| Badge ID | Default Label | Description |
| :--- | :--- | :--- |
| `declarative-only` | `🟢 Declarative Skill` | Pure `skills/` or `agents/` markdown; zero background processes or hooks |
| `global-rules` | `🔵 Global Rules (~N tok)` | Includes `rules/*.md` active in prompt context while enabled, with token estimate |
| `sidecar-ui` | `🟣 Sidebar Panel` | Provides a visual interactive panel in the right Sidebar |
| `mcp-stdio` | `🟠 Local MCP Process` | Spawns a local stdio MCP server defined in `mcp_config.json` |
| `mcp-remote` | `🌐 Remote MCP Service` | Connects to an external HTTPS MCP endpoint (domains listed transparently) |
| `lifecycle-hooks` | `🔶 Lifecycle Hooks` | Registers session/tool lifecycle hooks via `hooks.json` |
| `host-enhancement` | `💡 Host UI Enhancement` | Uses local CDP bridge or `app.asar` workbench enhancements (glass skins, companion widgets); fully permitted, gentle notice only |

- **Capability-Escalation Confirmation**: Updating a plugin that adds newly introduced privilege badges or remote MCP domains pauses for explicit user approval before syncing and updating `.agy-market-receipt.json`.
- **Dual-Track Discovery**: Track 1 verified plugins appear by default; opting into **Track 2 Experimental Topic Discovery** automatically enforces `<owner>--<slug>` double-hyphen isolation.

---

## 🛠️ CLI Commands & Local Development

### CLI (`bin/agy-market.mjs`)

```bash
# Install or update AGY Market (optional --dest <plugins-dir>)
npx agy-market install

# Preflight and install a plugin from any GitHub URL (--subpath, --isolate, --replace, --yes, --dest, --mirror, --token, --json)
npx agy-market add <github-url>

# List local installed plugins, config/data paths & market receipts (--json supported)
npx agy-market status
npx agy-market status --json

# Run local installation checks (Node >= 22, real directory check, 10-field manifest purity, built UI) & sweep retired Windows binaries
npx agy-market doctor
```

### Build & Test From Source

```powershell
# Build single-file offline-capable Sidebar UI (sidecars/market_pane/index.html) & static showcase
npm run build

# Copy real plugin bundle into ~/.gemini/config/plugins/agy-market (never symlinks/junctions)
npm run install:local

# Verify local installation
node ./bin/agy-market.mjs doctor

# Pack deterministic release tarball (dist/agy-market.tar.gz + .sha256)
npm run pack:release

# Run unit & integration tests
npm test
```

---

## 🔒 Security & Host Redlines

- **Never Writes `~/.gemini/config/config.json`**: Read-only inspection only; Vault Parking handles enable/disable cleanly.
- **Never Creates Symlinks / NTFS Junctions**: Every install performs real directory/file copies and rejects archive traversal (`..`) and symlink/hardlink tar entries.
- **Windows Lock-Safe Sync & Crash Recovery**: Stages outside `~/.gemini/config/plugins/` in `${PLUGIN_DATA}/staging/`, journals transitions via `pending-journal.json` (auto-recovered 8s after boot), renames locked binaries to `*.old.<ts>`, and sweeps them via `retired-binaries.json`.
- **Loopback-Only Local Server & CSRF Guard**: Listens strictly on `127.0.0.1` (ephemeral port) and enforces a 256-bit random `X-Sidecar-Token` + `Origin` check on all `POST`/`DELETE` routes.

---

## 📚 Guides, Architecture & Contributing

- **[📖 Plugin Submission Guide (`docs/SUBMISSION_GUIDE.md`)](https://github.com/azwosile/agy-market-catalog/blob/main/docs/SUBMISSION_GUIDE.md)** — Full Track-1 single-YAML & Track-2 auto-discovery submission tutorial
- Read **[`AGENTS.md`](./AGENTS.md)** and **[`../AGENTS.md`](../AGENTS.md)** before modifying any module in this repository. To submit plugins, visit **[`azwosile/agy-market-catalog`](https://github.com/azwosile/agy-market-catalog)**.

## 📄 License

[MIT License](./LICENSE)
