# AGY Market Client & Showcase — Engineering Specification (`agy-market/AGENTS.md`)

> **Repository**: `agy-market` (Antigravity visual plugin marketplace client, lock-safe tarball installer, `npx --yes github:azwosile/agy-market` bootstrap CLI, and static web showcase)  
> **Cross-Repo Contracts**: Read [`../AGENTS.md`](../AGENTS.md) for shared JSON schemas (`index.json`, `unverified-index.json`, `agy-market.json`, `.agy-market-receipt.json`) and anti-collision invariants.  
> **Anti-Goal**: This repository is the **client app and showcase**, NOT the catalog registry. Never add plugin listing PRs here and never bundle a static snapshot of catalog entries inside the client package.

---

## 1. Plugin Identity & Runtime Footprint

- **Canonical Plugin Slug (`<dir>` & `plugin.json.name`)**: `"agy-market"`
- **Presentation Title (`plugin.json.displayName`)**: `"AGY Market · 反重力插件市场"`
- **Primary UI Carrier**: **Pure Plugin Sidecar** (`sidecars/market_pane/sidecar.json` with `entrypoint: "SIDECAR_UI_ENTRYPOINT_AUX_PANE"`), paired with **1 Declarative Skill** (`skills/agy-market/SKILL.md`).
  - **Why Pure Sidecar Default**: Consumes **0 Agent Tokens** on idle turns, opens in ~1s inside Antigravity's maximizable right Auxiliary Pane, inherits host theme tokens via `/preload.js`, and runs a local Node backend capable of verifying SHA-256 digests and writing directly to `~/.gemini/config/plugins/`.
  - **No Active MCP Server by Default**: Do NOT ship an active `mcp_config.json` in the root bundle (every enabled MCP tool burns context tokens on every turn, and `global` MCP App views are not consistently rendered across Antigravity 2.x builds).
- **Runtime Engine**: `Node >= 22.0.0` (`"type": "module"`), **zero runtime `npm` dependencies**.
  - HTTP server & network requests: `node:http`, `node:https`, global `fetch`, and zero-dependency proxy-aware fetch (`src/shared/proxy-fetch.mjs` supporting `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY`, `NO_PROXY`, and Windows registry system proxy settings).
  - Hashing & tokens: `node:crypto` (`createHash('sha256')`, `randomBytes(32)`).
  - Tarball decompression & unpacking: `node:zlib` (`createGunzip`) + internal pure-JS POSIX `ustar` / `pax` stream tar parser (`src/installer/tar-extract.mjs`) with strict Zip-Slip (`..`, absolute path, symlink/hardlink) rejection.
  - UI bundling (`scripts/build.mjs`): Compiles `src/ui/*` + `src/shared/*` into a single self-contained `sidecars/market_pane/index.html` (prefers `esbuild` if present locally; automatically falls back to a deterministic zero-dependency ESM-to-IIFE bundler + `node:vm` syntax verification so `node scripts/build.mjs` always works 100% offline).

---

## 2. Repository Directory Layout

```text
agy-market/
├── AGENTS.md                        # Client engineering rules & host boundaries (this file)
├── README.md                        # User & contributor documentation
├── LICENSE                          # MIT License
├── package.json                     # ESM package ("agy-market", bin: {"agy-market": "./bin/agy-market.mjs"})
├── plugin.json                      # Strict 10-field Antigravity native manifest
├── assets/
│   └── logo.svg                     # Square >=128x128 high-contrast SVG with ~10% safe margin
├── bin/
│   └── agy-market.mjs               # `npx --yes github:azwosile/agy-market` bootstrap installer, self-updater & CLI diagnostics
├── scripts/
│   ├── build.mjs                    # Offline-capable single-file HTML bundler + site builder
│   ├── install-local.mjs            # Real-copy dev installer into ~/.gemini/config/plugins/agy-market
│   └── pack-release.mjs             # Produces deterministic agy-market.tar.gz + .sha256 for GitHub Releases
├── sidecars/
│   └── market_pane/
│       ├── sidecar.json             # AUX_PANE declaration (restart_policy: "on-failure")
│       ├── main.mjs                 # Sidecar entry -> boots 127.0.0.1 HTTP API + serves index.html
│       └── index.html               # Built single-file UI artifact (includes <script src="/preload.js">)
├── skills/
│   └── agy-market/
│       └── SKILL.md                 # Conversational search & clickable sidecar:// / customization:// pills
├── src/
│   ├── shared/                      # Constants, schema validators, semver comparator, badge metadata
│   ├── registry/                    # Multi-source catalog loader (ETag 304 + npmmirror @agy-market/catalog fallback)
│   ├── preflight/                   # Read-only collision scanner & <owner>--<slug> scoped rewriter
│   ├── installer/                   # Tarball downloader, SHA-256 check, staging, Windows lock-safe sync & GC
│   ├── sidecar/                     # 127.0.0.1 router, X-Sidecar-Token CSRF guard, state persistence
│   └── ui/                          # Modular browser ESM sources (template.html, styles.css, app.mjs, components)
├── site/                            # Static web showcase source (compiled to docs/ or gh-pages)
└── test/                            # `node --test` unit & integration suites
```

---

## 3. Antigravity Host Redlines & Windows Traps (Mandatory)

1. **NEVER Write `~/.gemini/config/config.json`**:
   - Antigravity's Language Server owns `config.json` (`0600` atomic writes holding `userSettings`, auth, and permission state). Writing to it risks clobbering user settings and misses live LS state updates.
   - **Read-only parsing** of `config.json` (`plugins.<dir>.enabled`) IS allowed and used to show live Enabled/Disabled badges in the Market UI.
2. **NEVER Call Restricted Mutation RPCs**:
   - `InstallCustomization`, `DeletePlugin`, and `JetboxWriteState` are restricted/internal.
   - Native enable/disable toggle and full uninstall cleanup go through Customizations deep links: `[Manage](customization://<dir>)` (emitted via `skills/agy-market/SKILL.md` or copyable/openable handoff; **always keyed on `<dir>`, never `plugin.json.name`**; never emit dead `plugin://` or `plugins://` links).
   - Read-only `GetAllPlugins` (must filter/strip inlined `SKILL.md` bodies!) and `RefreshMcpServers` (`{"serverName":"<plugin>_<server>"}`) may be called **opportunistically** when `ANTIGRAVITY_LS_ADDRESS` and `ANTIGRAVITY_CSRF_TOKEN` are available (e.g., CLI helper invoked from an Agent terminal), with graceful UI fallback when absent inside a cold-booted Sidecar.
3. **NEVER Create Symlinks or NTFS Junctions Under `~/.gemini/config/plugins/`**:
   - On Windows, `GetAllPlugins` **silently skips NTFS junctions and symlinks**. Every install and `install:local` operation MUST perform real directory and file copies, and `tar-extract.mjs` MUST reject archive entries of type `symlink` (`2`) or `link` (`1`).
4. **Scrub `ELECTRON_RUN_AS_NODE` Before Spawning External Processes**:
   - Antigravity runs Sidecars using `Antigravity.exe` with `ELECTRON_RUN_AS_NODE=1`, so `process.execPath` inside `main.mjs` points to `Antigravity.exe`!
   - Because Track-1 & Track-2 plugins install from prebuilt tarballs via pure Node `fs`/`zlib`, normal installs spawn **zero child processes**. If any developer tool or diagnostic command spawns an external binary, scrub `ELECTRON_RUN_AS_NODE` from `env` and never invoke `process.execPath` as a generic GUI/CLI runner without explicit flags, or duplicate `Antigravity.exe` IDE windows will pop up.
5. **Preserve Antigravity's 10-Field `plugin.json` Purity**:
   - Allowed top-level keys in `plugin.json`: `name`, `displayName`, `description`, `version`, `author`, `homepage`, `repository`, `logo`, `suggestedPrompts`, `disabled`.
   - Never write market tracking fields into `plugin.json` (store them in `.agy-market-receipt.json` instead), and never write an `https://` URL into `plugin.json.logo`.

---

## 4. Catalog Resolution, Non-npm Tarballs & China Network Acceleration

### 4.1 Live Catalog Revalidation (Zero Bundled Stale Snapshot)
On every market session open (and manual Refresh), `src/registry/` resolves catalogs without relying on any bundled snapshot:
1. **Custom User/Enterprise Feeds**: Static `https://.../index.json` URLs configured in `${PLUGIN_DATA}/prefs.json` (merged with highest display priority on matching `repositoryId`).
2. **Primary Channel (GitHub Pages CDN)**: Conditional `GET` with `If-None-Match` / `If-Modified-Since` against `index.json` (3.5s timeout) and `unverified-index.json` (20s timeout when Track-2 is enabled, falling back independently to `raw.githubusercontent.com/.../gh-pages` and local `cache/unverified-index.json` with warnings). `304 Not Modified` reuses `${PLUGIN_DATA}/cache/*.json` in <50ms.
3. **Automatic Mainland China Mirror Fallback (`@agy-market/catalog`)**:
   - If GitHub Pages times out or fails (or `networkMode: "china-mirror"`), query `@agy-market/catalog` on `registry.npmmirror.com` / Tencent Cloud mirror; if the npm package returns 404/unavailable, gracefully fall back to GitHub Pages / `raw.githubusercontent.com` and local disk cache with clear warnings.
   - **Crucial Distinction**: `@agy-market/catalog` uses npm **strictly as a high-availability JSON transport CDN**. Individual Antigravity plugins listed inside `index.json` are **NOT** required to be npm packages or JavaScript projects!

### 4.2 SHA-256 Tamper-Proof Tarball Download & Release Mirror Support
When installing or updating a plugin `P`:
1. Determine candidate download URLs for `P.distribution.tarballUrl`:
   - Direct GitHub Release asset URL (`https://github.com/<owner>/<repo>/releases/download/<tag>/<asset>.tar.gz`), OR
   - User-configured GitHub Release acceleration prefix (e.g., `mirrorPrefix + rawGithubReleaseUrl` in China network mode), OR
   - Verified `npmMirrorPkg` tarball **only if** `P.distribution.npmMirrorPkg` is non-null in `index.json` (meaning `agy-market-catalog` already proved bidirectional repo ownership).
2. Stream the archive to `${PLUGIN_DATA}/staging/<uuid>/archive.tar.gz` via streaming SHA-256 staging with no artificial 100 MB archive cap (`MAX_TARBALL_BYTES = 0`, 60s per-chunk inactivity stall timeout, and streaming `extractTarGzStreamToDir`) while computing `crypto.createHash('sha256')`.
3. **Mandatory Digest Gate**: Compare computed hex digest against `P.distribution.sha256`. On any mismatch, immediately delete staging directory and abort with `INTEGRITY_SHA256_MISMATCH`—even a compromised download proxy cannot inject a single modified byte.

---

## 5. One-Click Activation, Gentle Badges & Update Escalation Guard

### 5.1 True One-Click Immediate Activation (Track 1 & Track 2)
- Clicking **Install** in either **Track 1 (Verified)** or **Track 2 (Experimental Topic Discovery, once the user flips on the Track-2 toggle)** installs the plugin **enabled immediately**—do NOT inject `"disabled": true` into `plugin.json`.
- **Transparent Pre-Install Badges**: Every card and detail header displays `capabilities.badges` right next to the **Install** button:
  - `🟢 纯声明式技能` (`declarative-only`, `Declarative Skill`)
  - `🔵 常驻规则 (~N tok)` (`global-rules`)
  - `🟣 Sidebar 侧边栏` (`sidecar-ui`, `Sidebar Panel`)
  - `🟠 本地 MCP 进程` (`mcp-stdio`) / `🌐 远程 MCP 服务` (`mcp-remote`)
  - `🔶 生命周期钩子 (Hooks)` (`lifecycle-hooks`)
  - **`💡 宿主界面增强` (`host-enhancement`)**: Gentle, non-alarmist informational badge for plugins using CDP or `app.asar` enhancements (such as `agy-wallpaper-prism` or `gemini-neko-cockpit`). Never show scary red malware banners for `host-enhancement`.

### 5.2 T+N Update Capability-Escalation Confirmation
Because `config.json` (`plugins.<dir>.enabled: true`) keeps an already-installed plugin active across updates:
- Before applying an update from `installedVersion` to `targetVersion`, compare incoming `P.capabilities` against `.agy-market-receipt.json`'s `grantedCapabilities`.
- If the update **adds** any previously ungranted capability badge (`lifecycle-hooks`, `mcp-stdio`, `mcp-remote`, `sidecar-ui`, `host-enhancement`, `global-rules`) or new `mcpRemoteDomains`:
  - Pause automatic staging to `plugins/<dir>/` and show a concise **Capability Change Confirmation Dialog** listing the newly added capabilities.
  - Once the user clicks **Confirm & Update**, proceed immediately and update `grantedCapabilities` in `.agy-market-receipt.json`.

---

## 6. Preflight Collision Resolver & `<owner>--<slug>` Scoped Fallback

Before writing to `~/.gemini/config/plugins/`, `src/preflight/` runs a pure read-only filesystem audit (no LS credentials required):
1. Scan `~/.gemini/config/plugins/*`, active workspaces `.agents/plugins/*` (obtained from `/preload.js` `window.sidecar.getWorkspaceUris()`), `/builtin/plugins/*`, `~/.gemini/config/plugins.json`, and `~/.gemini/config/mcp_config.json`.
2. **Resolution Rules**:
   - **Reinstall / Update of Same Source**: Existing `.agy-market-receipt.json` has matching `repositoryId` (or matching `repository` URL on a manually installed copy) -> Reuse existing `<dir>` and `effectivePluginName`.
   - **Clean Track-1 Install (No Local Conflict)**: `P.forceScopedInstall === false` and neither `<dir> = P.canonicalName` nor `plugin.json.name = P.canonicalName` exists on disk -> Install natively at `~/.gemini/config/plugins/<P.canonicalName>/` with zero manifest modifications!
   - **Track-2 Install OR Local Name Conflict Detected**:
     - If Track-2 (`P.forceScopedInstall === true`), automatically apply **Scoped Isolation**:
       - Set target `<dir>` = `P.scopedName` (`<owner-lower>--<slug>`, double hyphen `--`).
       - Rewrite `plugin.json`: set `"name": "<owner-lower>--<slug>"`, preserve original title in `"displayName"`.
       - Rewrite `customization://<oldDir>` and `sidecar://<oldDir>/` protocol links in bundled `.md` files to `<owner-lower>--<slug>`.
       - Scan `.js`/`.mjs`/`hooks.json` for hardcoded references to `<oldName>`; if found, display a subtle compatibility note in the install toast.
     - If Track-1 collides with a *different* local/manual plugin, prompt the user with two clear choices: **(A) Install Isolated as `<owner>--<slug>`** or **(B) Replace Existing Local Plugin**.

---

## 7. Windows Lock-Safe Staging, Crash Recovery & Self-Update

1. **Out-of-Tree Staging**: Unpack and prepare all files inside `${PLUGIN_DATA}/staging/<uuid>/bundle/` (where `PLUGIN_DATA` is Antigravity's Sidecar data dir or `~/.gemini/sidecar_data/agy-market/market_pane/data`). Never unpack temp folders directly inside `~/.gemini/config/plugins/`, which would trigger premature Language Server hot-discovery on half-extracted files.
2. **Crash-Recovery Journal (`pending-journal.json`)**:
   - Before syncing into `~/.gemini/config/plugins/<dir>/`, write `{ op, dir, fromVersion, toVersion, stagingPath, backupPath, startedAt }` to `${PLUGIN_DATA}/pending-journal.json`.
   - `8s` after `agy-market` Sidecar startup, run `recoverInterruptedJournal()` to complete or cleanly roll back any operation interrupted by power loss or IDE closure.
3. **Windows File-Lock Safe In-Place Sync (`src/installer/sync-dir.mjs`)**:
   - Running MCP Stdio servers and Sidecars on Windows hold open handles on their CWD (`<dir>`, causing `rm -rf` / `fs.rmSync` on the root directory to fail with `EBUSY`/`EPERM`) and lock `.exe`/`.dll`/`.node` files.
   - Therefore, updates **sync files in-place**:
     1. Snapshot user-preserved globs (`preservePaths` + `.agy-market-receipt.json`).
     2. Overwrite `.js`/`.mjs`/`.json`/`.md`/`.html`/`.svg`/`.png` files atomically or in-place, and remove stale files no longer in the new release (except `preservePaths`).
     3. If overwriting a `.exe`/`.node`/`.dll` throws `EBUSY`/`EPERM`, **rename the locked file aside** inside the same folder (`<file>.old.<timestamp>`), write the fresh binary to `<file>`, and append the `.old.<timestamp>` path to `${PLUGIN_DATA}/retired-binaries.json`.
   - **Retired Binary Garbage Collection**: On every `agy-market` Sidecar boot and before every install/update pass, sweep `retired-binaries.json` and `unlink` any `*.old.<ts>` file whose old process handle has since closed.
   - **Post-Update Reload Handoff**: If read-only `config.json` indicates an updated MCP plugin is enabled, attempt opportunistic `RefreshMcpServers` if LS token is present; otherwise show a one-click **`Reload Required`** pill linking to `customization://<dir>`.
4. **In-Place Self-Update (`dir === "agy-market"`)**:
   - Stages new `agy-market` release in `${PLUGIN_DATA}/staging/`, syncs `agy-market` files in-place without deleting its own CWD, writes `.agy-market-receipt.json`, clears `pending-journal.json`, responds `200 OK` to the UI, and triggers graceful Sidecar process restart (`process.exit(1)` under `restart_policy: "on-failure"` or soft state reload).

---

## 8. Sidecar Security & Bootstrap / Showcase Contracts

- **Local HTTP Loopback & Token Auth**:
  - Bind Sidecar HTTP server strictly to `127.0.0.1` on port `0` (ephemeral OS-assigned port, reported to Antigravity via stdout handshake).
  - Generate a 256-bit random `SIDE_TOKEN` on boot; inject it into the served `index.html` runtime meta/bootstrap and require `X-Sidecar-Token: <SIDE_TOKEN>` (plus `Origin` validation) on every `POST`/`DELETE` endpoint (`/api/install`, `/api/update`, `/api/remove-files`, `/api/sources`, `/api/prefs`).
- **One-Line Bootstrap (`bin/agy-market.mjs`)**:
  - `npx --yes github:azwosile/agy-market` downloads/copies `agy-market` into `~/.gemini/config/plugins/agy-market/` using real files (no symlinks; filtering `node_modules` only relative to `repoRoot` so `_npx` caches work cleanly), writes `.agy-market-receipt.json`, and prints the exact `[Open AGY Market](sidecar://agy-market/market_pane/)` and `[Manage](customization://agy-market)` instructions.
  - Also maintain zero-npm `scripts/install.ps1` and `scripts/install.sh` wrappers (plus `.github/workflows/release.yml`) that pull/publish the latest verified GitHub Release tarball of `agy-market`.
- **Static Web Showcase (`site/`)**:
  - Consumes `index.json` + `readmes.json` at build/runtime to render a fast searchable web catalog with category filters, capability badges, and copyable one-click `npx --yes github:azwosile/agy-market` bootstrap snippets.
