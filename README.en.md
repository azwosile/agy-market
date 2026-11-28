<div align="center">

<img src="assets/logo.png" alt="AGY Market Logo" width="84" />

# AGY Market (`agy-market`)

**Community Plugin Marketplace for Google Antigravity**

Sidebar Panel UI · Lock-Safe One-Click Uninstall · Direct In-Sidebar Upstream & Batch Updates · 15 Precision Categories · GitHub URL Preflight Installer · ⭐ Pinned Favorites Shelf & Tab · Live Installed Search & Filters · One-Click Sidebar Launcher · Native Vault-Parking Toggle Sliders · Local Conflict Checks · Dual-Mirror China Acceleration · SHA-256 Verified Installs

[简体中文](./README.md) · **English** · **[📖 Submit a Plugin Guide](https://github.com/azwosile/agy-market-catalog/blob/main/docs/SUBMISSION_GUIDE.md)** · [Plugin Catalog](https://github.com/azwosile/agy-market-catalog) · [Architecture Spec](./AGENTS.md)

</div>

---

> **Repository Boundary**: This repository ([`azwosile/agy-market`](https://github.com/azwosile/agy-market)) houses the **AGY Market** Sidebar client plugin, Windows lock-safe tarball installer, `npx --yes github:azwosile/agy-market` bootstrap CLI, and static web showcase (`site/`).
>
> To list your plugin in the community catalog, click **`+ Submit Plugin`** (`+ 申请收录插件`) in AGY Market or follow the step-by-step **[📖 Plugin Submission Guide (`docs/SUBMISSION_GUIDE.md`)](https://github.com/azwosile/agy-market-catalog/blob/main/docs/SUBMISSION_GUIDE.md)** to open a single-YAML Pull Request in **[`azwosile/agy-market-catalog`](https://github.com/azwosile/agy-market-catalog)**.

---

## ✨ Highlights (v1.7.1)

### 0. What's New in v1.7.1
- **Faster, Smoother Track 2 Rendering at Scale**: Discover now renders incrementally in pages of 48 cards (`IntersectionObserver` sentinel auto-append plus a visible Load More button), pairs `.plugin-card` with CSS `content-visibility: auto`, removes per-card `backdrop-filter` / `filter: blur` layers in favor of clean semi-opaque surfaces, uses root event delegation, 150ms debounced search across Discover/Favorites/Installed, and `requestAnimationFrame`-throttled card spotlight tracking.
- **Responsive Track 2 Toggle & Concurrency Guards**: Decouples `#track2-checkbox` from background update-check locks (disabling only during its own in-flight save with a visible `Switching…` spinner), applies optimistic preference updates with error rollback, moves toasts to a dedicated `#toast-host` node so toast updates/dismissal never rebuild the grid, and adds `stateRequestSeq` / `prefsRequestSeq` guards alongside reliable `unverified-index.json` fetch & cache fallback.

<details>
<summary>Previous v1.7.0 Highlights (System Proxy Auto-Detect / Unlimited Streaming Installs / Monorepo Update Accuracy / Release Automation)</summary>

- **Zero-Dependency HTTP/HTTPS & Windows System Proxy Support**: Adds `src/shared/proxy-fetch.mjs` respecting `HTTPS_PROXY` / `HTTP_PROXY` / `ALL_PROXY` (with `NO_PROXY` and automatic bypass for `127.0.0.1` / `localhost`) plus Windows registry system proxy settings (`HKCU\...\Internet Settings`), preventing GitHub archive timeouts when using local proxies without TUN mode.
- **Unlimited >100 MB Streaming Plugin Installs & Extraction**: Removes the artificial `100 MB` `MAX_TARBALL_BYTES` archive cap (`0 = unlimited`), switching to streaming gunzip + POSIX/PAX tar disk extraction (`extractTarGzStreamToDir`, O(MB) RAM), 60s per-chunk stall timeouts instead of fixed 60s total download ceilings, `server.requestTimeout = 0`, and `GB` size formatting in the UI.
- **Monorepo, Native `.git` & Unversioned Plugin Update Accuracy**: Verifies raw `<tag>/<pluginRoot>/plugin.json` existence, plugin name, and version for unreceipted/unlisted Monorepo plugins (e.g., `upstash/context7`) to prevent false-positive `github-upstream` upgrades; detects native `.git` clones (`conductor`, `sepia`, etc.) and unversioned external plugins, excluding them from auto/batch updates with read-only **Git Native / Unversioned** status pills.
- **`app.asar` Patch Script Guidance & `preservePaths` Merge**: Guides users in toast notices, the restart banner, and the installed Detail Drawer to run bundled patch scripts (e.g., `node setup.cjs` per plugin docs) before restarting Antigravity and to re-run them after AGY Market updates, with one-click **Copy Plugin Folder** and **Patch Docs** actions; merges `existingReceipt.preservePaths` with `distribution.preservePaths` on catalog updates to keep user configs intact.
- **`npx` GitHub Bootstrap Fix & Automated GitHub Releases**: Replaces the unpublished npm `npx` bootstrap command with `npx --yes github:azwosile/agy-market`, fixes `scripts/install-local.mjs` relative-path `node_modules` filtering inside `_npx` caches, and adds `.github/workflows/release.yml` to automatically pack and publish `agy-market.tar.gz` + `.sha256` assets on `v*` tag pushes.

</details>

<details>
<summary>Previous v1.6.0 Highlights (Recommended Sort / Lazy README Cache / Scoped Symlinks / Zero-PII Nomination)</summary>

- **Default "Recommended" Sort + Monorepo Viewport Slot Dampening**: Sorts Discover by catalog quality score (`ranking.score`, gracefully falling back to `stars` for custom feeds or older catalogs) with `1 / (1 + 0.15 * (k - 1))` dampening across entries sharing `repository.repositoryId`, while keeping `stars`, `updated`, and `name` sort options intact.
- **Lazy Per-Plugin README Loading & ETag Cache**: `GET /api/readme` and `GET /api/plugin/:id/readme` fetch `dist/readmes/<id>.json` on demand with per-plugin ETag caching under `${PLUGIN_DATA}/cache/readmes/<id>.json`, seamlessly falling back to monolithic `readmes.json`, China npm mirrors, or local installed READMEs.
- **Security-Preserving Scoped Symlink Support**: Tarballs containing symlinks strictly outside a selected subdirectory `pluginRoot` (such as dual-host `.claude/` or `docs/` links) are skipped cleanly instead of failing installation, while any symlink inside `pluginRoot`, enclosing `pluginRoot`, targeting into `pluginRoot`, or anywhere in a root plugin (`pluginRoot === '.'`) still hard-throws `ERR_TAR_SYMLINK_FORBIDDEN`.
- **Opt-In Zero-PII Public Plugin Nomination**: When Add-URL inspects or installs an unlisted public GitHub repository (verified via unauthenticated `HEAD` with 3s timeout; private/404/unreachable repos are never prompted), surfaces a non-blocking prompt opening a pre-filled GitHub Issue carrying only `owner/repo` and `plugin_root`.

</details>

### 1. Sidebar Panel UI, 15 Precision Categories & Navigation
- **Native Right Sidebar Panel**: Runs inside Antigravity's native `AUX_PANE` extension view (`sidecars/market_pane/sidecar.json`) with no bundled MCP servers, keeping the panel lightweight and responsive.
- **15 Precision Plugin Categories (16 Keys Including `all`)**: Adds **`monitoring-quota`** (*Telemetry & Quota*), **`context-cache`** (*Context & Cache Boost*), and **`agents-reasoning`** (*Agents & Reasoning*) alongside the existing 12 taxonomy buckets. Discover dynamically renders filter pills for all active categories, indexes localized category names in search, and displays category tags on cards and Detail Drawers.
- **Overview Strip & Plugin Cards**: Collapsible top overview strip displays catalog stats (*Indexed / Active / Updates / Local Conflicts*) alongside quick **`Add URL`** (`链接添加`) and **`+ Submit Plugin`** actions. Card styles adapt across Dark, Light, and translucent wallpaper skins (such as Wallpaper Prism).
- **2-Line Titles + Clickable GitHub Links**: Clicking any **plugin title** in cards or the Detail Drawer opens its GitHub repository directly in a new window, while clicking the card body opens the Detail Drawer.
- **Multilingual README Drawer**: Queries `/api/readme?id=...&locale=zh|en`, preferring localized `entriesZh` / `entriesEn` from the catalog (or local `README.zh-CN.md` / `README.zh.md` for installed plugins) and rendering localized descriptions on installed cards.
- **Direct One-Click Sidebar Launcher**: Replaces raw `<a href="sidecar://...">` links blocked inside isolated iframes. Inside the host panel, clicking a sibling plugin's **Panel** button invokes host `window.sidecar.ui.toggleAuxPane` (`tabType: "sidecarView"`) directly to open or focus its Sidebar panel—no manual copy prompts.

### 2. Lock-Safe Uninstall, Direct In-Sidebar Updates & On-Demand Update All
- **Zero Same-Version No-Op Updates (v1.5.4)**: Shared SemVer reconciliation across backend and UI plus server-authoritative catalog resolution eliminate stale-snapshot `vX.Y.Z → vX.Y.Z` ghost updates and stale payload downgrades; standard updates matching the installed version or Git tag/commit short-circuit cleanly with `ALREADY_UP_TO_DATE` (zero downloads), while the Detail Drawer preserves explicit **Re-sync** (`forceResync: true`) on demand.
- **Lock-Safe Plugin Uninstall (Sidebar Card/Drawer + `npx --yes github:azwosile/agy-market uninstall <dir>`)**:
  - Every removable global plugin card and Detail Drawer exposes an **Uninstall** (`卸载`) button backed by `POST /api/uninstall` (with `POST /api/remove-files` compatibility) and a confirmation modal with an optional *Also remove from favorites* checkbox.
  - Handles both active (`~/.gemini/config/plugins/<dir>`) and Vault-Parked (`${PLUGIN_DATA}/disabled-plugins/<dir>`) directories; never writes `config.json` or calls restricted RPCs; unlinks symlinks/NTFS junctions without touching target source directories; retires Windows `EBUSY`-locked binaries to `.old.<ts>` while immediately deleting `plugin.json` (with `sweepRetiredBinaries` later removing empty orphan shells); strictly blocks self-deletion of `agy-market` (`ERR_CANNOT_SELF_DELETE`) as well as `workspace` and `builtin` plugins.
- **Direct In-Sidebar Updates Across All Channels (Zero External Download Redirects)**:
  - Whenever an upstream GitHub Release/Tag leads the catalog or comes from a GitHub URL install, `GET /api/updates` returns `installable: true` (`updateChannel: 'catalog' | 'github-upstream' | 'github-url'`), eliminating external browser download redirects.
  - Upgrading a verified catalog plugin directly from GitHub upstream preserves its original `receipt.track` (`'verified'`) and `repositoryId` while still enforcing capability-escalation confirmation.
- **Per-Card Smart `Update` / `Latest` Status Pill & On-Demand Top-Bar `Update All`**:
  - Every installed plugin card with a catalog or GitHub source renders a clickable **Update vX.Y.Z** button when a newer version is available and automatically transitions into a non-clickable **✓ Latest** status pill once updated or confirmed up to date (before an initial check, clicking **Update** verifies first without re-downloading if already current; pure local plugins display a non-clickable `Local` / `Workspace` / `Built-in` status pill and return `ERR_NO_UPDATE_SOURCE` on API calls; native `.git` clones without a receipt and unversioned external plugins display read-only **Git Native / Unversioned** pills and are excluded from auto/batch updates).
  - The **Installed** tab header displays **Update All (N)** beside **Check Updates** on demand: it appears when installable updates are detected (or while a batch update is running) to sequentially upgrade `catalog`, `github-upstream`, and `github-url` plugins (always scheduling `agy-market` self-update last to trigger clean restart), and automatically hides when all plugins are up to date to keep the header uncluttered.

### 3. ⭐ Favorites Shelf & Tab, Installed Search/Filters & Update Error Alerts
- **⭐ Pinned Favorites Shelf & Dedicated Favorites Tab**:
  - Every plugin card (Discover, Favorites, Installed) and the Detail Drawer header feature a tactile star button (`☆` / glowing amber `★`) backed by `POST /api/favorites` persisted atomically in `prefs.json`.
  - When 1 or more plugins are starred, a collapsible **Pinned Favorites Shelf (`★ Favorites`)** appears above the Discover grid, complemented by a dedicated **`★ Favorites`** top navigation tab (`Discover · Favorites · Installed · Conflicts & Diagnostics · Sources & Settings`).
- **Live Search & Status Filters in `Installed` View**:
  - The **Installed** view includes a live search bar (matching display name, directory name, or description) and quick status filter pills (**All / Enabled / Disabled / Updatable**) for fast management at scale.
- **High-Visibility Update Error Alert Banner (Zero Silent Failures)**:
  - Whenever an install/update, batch **Update All**, or self-update fails due to network errors, SHA-256 mismatch, or permissions, a dismissible red error banner and error toast surface the affected plugin, exact failure reason, and a one-click **Retry** button.

### 4. Native Card-Footer Enable / Disable Slider (Vault Parking)
- **Zero Writes to `config.json`**: Antigravity's Language Server write-protects `~/.gemini/config/config.json`. AGY Market reads `config.json` strictly read-only and powers live toggling via **Vault Parking** (`POST /api/toggle-plugin`):
  - **Toggle OFF (Disable)**: Moves `~/.gemini/config/plugins/<dir>` cleanly into `${PLUGIN_DATA}/disabled-plugins/<dir>`. Host hot-watch unloads its Skills / Rules / Hooks within ~1 second.
  - **Toggle ON (Enable)**: Moves the folder back into `~/.gemini/config/plugins/<dir>` and removes any stale `"disabled": true` flag.
  - **Update While Parked**: Disabled plugins remain visible in *Installed* and *Discover* tabs and update in-place inside `disabled-plugins/<dir>` without accidentally reactivating them.
  - **Safe Locking**: `agy-market` itself stays locked ON to prevent disconnecting its own panel; `workspace`, `builtin`, and host-disabled plugins show clear read-only lock states.

### 5. Local Plugin Conflict Checks & Fixes
Dedicated **Conflicts & Diagnostics** tab (`GET /api/conflicts`) with read-only static conflict checks and one-click fixes (`POST /api/fix-conflict`):

| Check | Severity | What It Detects | Quick Action |
| :--- | :---: | :--- | :--- |
| `duplicate-plugin-name` | Critical | Duplicate `plugin.json.name` across `workspace > global > builtin` precedence, pinpointing the winner and silently dropped victim directories | 1-click `<owner>--<slug>` scoped isolation rename |
| `windows-symlink-ignored` | Critical | Symlinks or NTFS junctions inside `~/.gemini/config/plugins/` that Windows `GetAllPlugins` silently skips | 1-click materialize to real directory |
| `mcp-collision` | Critical / Warning | Duplicate `<plugin>_<server>` keys, collisions with global `mcp_config.json`, or bare generic server names (`search`, `db`, `fetch`, etc.) | Pinpoints colliding keys & sources |
| `skill-shadowing` / `agent-shadowing` | Warning | Overlapping `skills/*/SKILL.md` or `agents/*.md` across active plugins, `~/.gemini/config/skills/*`, and built-in reserved names | Shows full override chain |
| `host-enhancement-overlap` | Warning / Info | Two or more active plugins modifying `app.asar` (**Warning**, patch overlap risk) or using `cdp` UI enhancements (**Info**, generally compatible) | Advisory to review or disable duplicate |

### 6. Action-Triggered Restart & Reload Prompts
Cards and the Detail Drawer stay clutter-free without static restart chips. Activation prompts appear **only after an install, update, batch update, or uninstall completes** (or when a Windows disable/uninstall retires a locked binary):
- **Declarative Skills / Global Rules (`instant`)**: Hot-reloads immediately with no restart required.
- **Sidebar Panel / MCP / Hooks (`reload-pane`)**: Prompts to reopen the Sidebar panel or refresh MCP after update/install completes.
- **`app.asar` / First-Time `cdp` / Retired Locked Binaries (`host-restart`)**: Displays a clear banner reminding you to restart Antigravity for changes to take full effect. For `app.asar` patch plugins, both the banner and Detail Drawer clearly instruct you to run the plugin's bundled patch script (e.g., `node setup.cjs` per plugin docs) before restarting and re-run it after every AGY Market update, with one-click **Copy Plugin Folder** and **Patch Docs** helpers.

### 7. Built-In GitHub Discussions Integration
- Every plugin Detail Drawer includes a **Discussions** tab (`GET /api/discussions`) that detects whether Discussions are enabled on the repository without needing a token and provides direct links to browse or start a thread.
- Optionally configuring a personal GitHub Token in Settings (stored locally in `prefs.json` with `0600` permissions; never logged or persisted in caches) loads the latest 10 repository discussions directly inside the Sidebar panel.

### 8. Dual-Mirror China Acceleration & SHA-256 Verified Installs
- **Three-Tier Live Catalog Resolution (No Stale Bundled Snapshot)**:
  1. **Custom Feeds**: User/team static `index.json` URLs configured in `prefs.json` take highest priority.
  2. **Primary Channel (GitHub Pages + `gh-pages` Raw Fallback)**: Conditional `ETag` (`If-None-Match`) / `If-Modified-Since` requests achieve `<50ms` `304 Not Modified` cache hits.
  3. **Automatic Mainland China Mirror Fallback**: If GitHub Pages times out (`> 3.5s`) or fails, streams the pure-JSON `@agy-market/catalog` transport package from `registry.npmmirror.com` or `mirrors.cloud.tencent.com/npm` in memory; falls back to disk cache when offline.
- **Language-Agnostic & SHA-256 Verified**: npm is used **strictly** as a JSON mirror CDN for catalog metadata—listed plugins do **not** need to be npm or JavaScript projects. Optional GitHub Release mirror prefixes are supported safely because every tarball is streamed and verified against the catalog `sha256` digest before extraction (`INTEGRITY_SHA256_MISMATCH` aborts immediately on any mismatch).

---

## 🚀 One-Line Bootstrap Install

> Requires **Node.js >= 22.0.0** (zero runtime npm dependencies), or use the zero-npm OS installers below.

- **Node / `npx` (Cross-Platform, Recommended — runs directly from GitHub)**:
  ```bash
  npx --yes github:azwosile/agy-market
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

### Option 2: CLI `npx --yes github:azwosile/agy-market add <github-url>`
```bash
# Inspect and interactively install any GitHub plugin repository (supports subpaths & branch commits)
npx --yes github:azwosile/agy-market add https://github.com/<owner>/<repo>

# Target a specific Monorepo subdirectory with <owner>--<slug> scoped isolation and non-interactive confirmation
npx --yes github:azwosile/agy-market add https://github.com/<owner>/<repo> --subpath plugins/<name> --isolate --yes

# Optional flags: --replace, --dest <plugins-dir>, --mirror <prefix>, --token <pat>, --json
npx --yes github:azwosile/agy-market add https://github.com/<owner>/<repo>/tree/main/<subpath> --yes --json
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
npx --yes github:azwosile/agy-market install

# Preflight and install a plugin from any GitHub URL (--subpath, --isolate, --replace, --yes, --dest, --mirror, --token, --json)
npx --yes github:azwosile/agy-market add <github-url>

# Lock-safe uninstall of an installed global plugin (alias: remove; supports --yes, --dest <plugins-dir>, --json)
npx --yes github:azwosile/agy-market uninstall <dir>
npx --yes github:azwosile/agy-market uninstall <dir> --yes --json

# List local installed plugins, config/data paths & market receipts (--json supported)
npx --yes github:azwosile/agy-market status
npx --yes github:azwosile/agy-market status --json

# Run local installation checks (Node >= 22, real directory check, 10-field manifest purity, built UI) & sweep retired Windows binaries
npx --yes github:azwosile/agy-market doctor
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
