<div align="center">

<img src="assets/logo.svg" alt="AGY Market Logo" width="84" />

# AGY Market · 反重力插件市场 (`agy-market`)

**Google Antigravity 零 Token 损耗可视化社区插件市场**

极光棱镜（Aurora Prism）液态玻璃界面 · 卡片原生启停滑块 · 5 层插件冲突雷达 · 智能重启提示 · 双通道中国镜像加速 · SHA-256 防篡改校验

**简体中文** · [English](README.en.md) · [提交插件到目录](https://github.com/azwosile/agy-market-catalog) · [架构规范](AGENTS.md)

</div>

---

> **仓库边界说明**：本仓库（[`azwosile/agy-market`](https://github.com/azwosile/agy-market)）包含 **AGY Market** 客户端 Sidecar 面板、Windows 锁安全安装器、`npx agy-market` 一行安装 CLI 与静态展示站（`site/`）。
>
> 如需将你的插件收录至社区插件目录，请向 **[`azwosile/agy-market-catalog`](https://github.com/azwosile/agy-market-catalog)** 提交单文件 YAML Pull Request。

---

## ✨ 核心特性（v1.2.0 极光棱镜大改版）

### 1. 极光棱镜（Aurora Prism）视觉体验
- **零对话 Token 损耗**：采用纯 Antigravity 原生 `AUX_PANE` Sidecar 面板（`sidecars/market_pane/sidecar.json`），空闲时不注入任何常驻 MCP 工具，不消耗模型上下文预算。
- **流光展台与光学折射卡片**：顶部流光星云展台实时展示「已收录插件 / 运行中 / 可更新 / 冲突健康度」；每张卡片按分类赋予自适应色相光晕（`--card-accent`）、`1px` 镜面高光边与鼠标跟随微光（`--mx, --my`），同时完美适配暗色、亮色与半透明壁纸皮肤（如 Wallpaper Prism）。
- **双行优雅标题 + 一键直达 GitHub**：修复单行过早截断问题；点击探索卡片、已安装卡片或详情抽屉的**插件标题**可直接在新窗口打开对应 GitHub 仓库，点击卡片其余区域则展开详情抽屉。
- **开箱优先呈现简体中文文档**：详情抽屉请求 `/api/readme?id=...&locale=zh`，自动优先渲染目录源 `entriesZh` 或本地 `README.zh-CN.md` / `README.zh.md`，并在已安装卡片优先显示中文化简介。
- **告别隔离 iframe 无效死链**：彻底移除会被 Chromium 拦截的裸 `<a href="sidecar://...">` 与 `<a href="customization://...">` 链接；其他 Sidecar 插件的「面板」按钮升级为调用 `/preload.js` `window.sidecar.ui.toggleAuxPane`，并提供一键复制对话药丸兜底提示。

### 2. 卡片底部原生「启用 / 禁用」安全停放仓滑块（Vault Parking）
- **零改写 `config.json` 红线**：Antigravity 语言服务器对 `~/.gemini/config/config.json` 设有写保护。AGY Market 严守只读原则，永不改写 `config.json`，而是通过**安全停放仓（Vault Parking）**实现即时启停控制（`POST /api/toggle-plugin`）：
  - **滑向「禁用（OFF）」**：后端将 `~/.gemini/config/plugins/<dir>` 安全移入 `${PLUGIN_DATA}/disabled-plugins/<dir>`，宿主热监听约 1 秒内卸载对应 Skills / Rules / Hooks。
  - **滑向「启用（ON）」**：后端将目录完整移回 `~/.gemini/config/plugins/<dir>` 并清理可能残留的 `"disabled": true`。
  - **停放态持续可更新**：被禁用的插件仍保留在「已安装」与「探索」卡片中；对其执行版本更新时，会在 `disabled-plugins/<dir>` 内原位同步，绝不意外将其自动重新激活。
  - **防误操作锁定**：`agy-market` 自身滑块保持常亮锁定（避免在市场面板内把自己停用断连）；`workspace`、`builtin` 及宿主手动禁用项显示只读锁定提示。

### 3. 五层插件冲突与健康诊断中心（Conflict Radar）
顶部新增独立 **「冲突与诊断」** 标签页（`GET /api/conflicts`），一键执行零副作用只读体检并提供快速修复（`POST /api/fix-conflict`）：

| 冲突层级 | 严重级别 | 检测内容 | 一键修复能力 |
| :--- | :---: | :--- | :--- |
| `duplicate-plugin-name` | 严重 | 跨 `workspace > global > builtin` 扫描重复 `plugin.json.name`，精确标出生效胜出方与被宿主静默丢弃的插件目录 | 一键双连字符隔离重命名（`<owner>--<slug>`） |
| `windows-symlink-ignored` | 严重 | 检测 Windows 下 `~/.gemini/config/plugins/` 中被 `GetAllPlugins` 静默跳过的 NTFS Junction / 符号链接目录 | 一键实体化转为真实目录 |
| `mcp-collision` | 严重 / 警告 | 检测重复 `<plugin>_<server>`、与用户全局 `mcp_config.json` 重名或裸通用服务名（如 `search`、`db`、`fetch`） | 定位冲突键名与来源文件 |
| `skill-shadowing` / `agent-shadowing` | 警告 | 检测已启用插件之间的 `skills/*/SKILL.md`、`agents/*.md` 与用户全局目录或内置保留名的覆盖链 | 完整展示胜出/被覆盖链路 |
| `host-enhancement-overlap` | 提示 | 检测多个已启用插件同时包含 `app-asar` 或 `cdp` 宿主增强（如旧版壁纸插件与新版皮肤并存） | 提示评估是否停用其一 |

### 4. 智能「免重启 / 需重开面板 / 需重启」生效引擎
安装、更新、批量更新或切换启停滑块后，依据插件能力与实时文件锁状态自动分级提示：
- **`⚡ 免重启 · 即刻生效`（`instant`）**：纯声明式 Skills / Subagents（`declarative-only`）或全局规则（`global-rules`）。
- **`🔄 建议重开面板 / 刷新 MCP`（`reload-pane`）**：含 Sidecar 界面（`sidecar-ui`）、MCP 服务（`mcp-stdio` / `mcp-remote`）或生命周期钩子（`lifecycle-hooks`）。
- **`🚀 需重启 Antigravity 生效`（`host-restart`）**：含 `app.asar` 界面补丁、首次配置 `cdp` 调试端口的宿主增强插件，或 Windows 后台进程占用 `.exe`/`.node`/`.dll` 句柄触发了安全退避重命名（`*.old.<ts>`）。

### 5. 内置 GitHub Discussions 社区讨论
- 插件详情抽屉内置 **「讨论」** 标签页（`GET /api/discussions`），无需登录或 Token 即可自动探测目标仓库是否开启 GitHub Discussions，并提供一键直达讨论区与发帖入口。
- 如在面板设置中可选填入个人 GitHub Token（仅以 `0600` 权限保存在本地 `prefs.json`，绝不写入缓存文件或日志），即可在侧栏直接拉取并浏览该插件最新 10 条社区讨论。

### 6. 双通道中国大陆镜像加速与 SHA-256 防篡改校验
- **三级目录源自动解析（零内置陈旧快照）**：
  1. **自定义团队/个人源**：优先合并 `prefs.json` 中配置的静态 `index.json` 订阅源。
  2. **全球主通道（GitHub Pages + `gh-pages` Raw 回退）**：支持 `ETag`（`If-None-Match`）/ `If-Modified-Since` 条件请求，`304 Not Modified` 毫秒级复用本地缓存。
  3. **中国大陆自动镜像回退**：主源超时（`> 3.5s`）或不可达时，自动切换拉取纯 JSON 数据包 `@agy-market/catalog`（依次尝试 `registry.npmmirror.com` 与 `mirrors.cloud.tencent.com/npm`），在内存流式解包目录索引；完全离线时自动降级为本地磁盘缓存。
- **语言无关 & 防篡改下载**：`@agy-market/catalog` 仅将 npm 用作高可用静态 JSON CDN，被收录的插件**无需是 npm 包或 JS 项目**。支持配置自定义 GitHub Release 镜像加速前缀，所有 `.tar.gz` 安装包在解压前都会强制比对目录源权威 `sha256`，任何字节差异立即触发 `INTEGRITY_SHA256_MISMATCH` 中止安装。

---

## 🚀 一行快速安装

> 运行环境要求：**Node.js >= 22.0.0**（零外部 npm 运行时依赖）；或使用下方免 npm 系统脚本。

### 方式一：Node / `npx`（推荐，全平台通用）
```bash
npx agy-market@latest
```

### 方式二：Windows PowerShell（免 npm，内置 SHA-256 校验与目录回退）
```powershell
irm https://raw.githubusercontent.com/azwosile/agy-market/main/scripts/install.ps1 | iex
```

### 方式三：macOS / Linux Shell（免 npm，内置 SHA-256 校验与目录回退）
```sh
curl -fsSL https://raw.githubusercontent.com/azwosile/agy-market/main/scripts/install.sh | sh
```

### 安装后如何在 Antigravity 中打开？
- 在 Antigravity 对话中发送「打开插件市场」，或点击聊天药丸：`[AGY Market](sidecar://agy-market/market_pane/)`
- 也可直接点击右侧辅助面板顶部 **`+` → `Plugins` → `AGY Market`** 打开。
- 如需在 Antigravity 原生定制页管理本插件，可点击对话药丸：`[AGY Market](customization://agy-market)`

---

## 🏷️ 透明能力徽章与升级安全守卫

所有插件在点击「安装」前都会展示静态扫描生成的透明能力徽章，无隐藏权限：

| 徽章标识 | 默认中文标签 | 含义说明 |
| :--- | :--- | :--- |
| `declarative-only` | `🟢 纯声明式 · 0进程` | 仅包含 `skills/` 或 `agents/` 声明文档，无任何常驻进程或钩子 |
| `global-rules` | `🔵 常驻规则 (~N tok)` | 包含启用期间常驻注入上下文的 `rules/*.md`，清晰标出预估 Token 占用 |
| `sidecar-ui` | `🟣 Sidecar 面板 · 0 Token` | 提供右侧辅助面板独立 Web UI，空闲时不消耗对话 Token |
| `mcp-stdio` | `🟠 本地 MCP 进程` | 通过 `mcp_config.json` 启动本地 Stdio 工具服务进程 |
| `mcp-remote` | `🌐 远程 MCP 服务` | 连接外部 HTTPS MCP 服务端点（展示目标域名） |
| `lifecycle-hooks` | `🔶 生命周期钩子 (Hooks)` | 通过 `hooks.json` 订阅会话或工具调用生命周期事件 |
| `host-enhancement` | `💡 宿主界面增强` | 使用本地 CDP 调试桥或 `app.asar` 工作台界面增强（如毛玻璃皮肤、桌面挂件），社区完全欢迎，仅温和提示 |

- **升级能力增量确认（T+N Escalation Guard）**：当插件从旧版本升级并**新增**之前未授予的能力类别或新的远程 MCP 域名时，自动弹出增量对比确认框，经用户确认后再同步写入并更新 `.agy-market-receipt.json`。
- **双轨插件支持**：默认展示 Track 1 精选验证目录；在设置中可按需开启 **Track 2 实验性 Topic 自动发现**（自动强制 `<owner>--<slug>` 双连字符命名隔离，避免同名冲突）。

---

## 🛠️ CLI 诊断与本地开发命令

### 用户 CLI 命令（`bin/agy-market.mjs`）

```bash
# 安装或更新 AGY Market 到默认插件目录（支持 --dest <plugins-dir> 自定义路径）
npx agy-market install

# 查看当前配置路径、数据目录及所有已安装插件状态（支持 --json 机器可读输出）
npx agy-market status
npx agy-market status --json

# 运行健康体检（校验 Node >= 22、非符号链接实体目录、10 字段清单纯净度、UI 产物）并清理 Windows 残留 *.old.<ts> 文件
npx agy-market doctor
```

### 源码构建与本地开发

```powershell
# 1. 编译离线可用的单文件 Sidecar UI（sidecars/market_pane/index.html）及静态展示站
npm run build

# 2. 以真实文件复制方式安装至 ~/.gemini/config/plugins/agy-market（严禁符号链接 / NTFS Junction）
npm run install:local

# 3. 执行健康诊断
node ./bin/agy-market.mjs doctor

# 4. 打包确定性 GitHub Release 压缩包与校验文件（dist/agy-market.tar.gz + .sha256）
npm run pack:release

# 5. 运行全量单元测试与跨仓集成测试
npm test
```

---

## 🔒 安全与宿主工程红线

- **绝不写入 `~/.gemini/config/config.json`**：仅只读解析插件启停状态，杜绝覆盖用户登录态与设置。
- **绝不创建符号链接 / NTFS Junction**：Windows 下 Antigravity 会静默跳过符号链接插件，所有安装/更新均为实体目录复制，且解包器硬性拦截 `..` 路径穿越与软硬链接。
- **Windows 锁安全原位更新与崩溃恢复**：先在插件外置 `${PLUGIN_DATA}/staging/` 解包并写入 `pending-journal.json`（启动 8 秒自动恢复中断事务），对 Windows 锁定中的二进制采用 `.old.<timestamp>` 改名退避并在下次启动时由 `retired-binaries.json` 自动垃圾回收。
- **严格环回与 CSRF 鉴权**：Sidecar HTTP 服务仅绑定 `127.0.0.1` 随机端口，所有写入/变更接口（`POST` / `DELETE`）强制校验 256-bit 随机 `X-Sidecar-Token` 与 `Origin` 头。

---

## 📚 架构文档与贡献指引

修改本仓库代码前，请先阅读：
- **[`AGENTS.md`](./AGENTS.md)** — 客户端工程规范、宿主红线与锁安全安装器设计
- **[`../AGENTS.md`](../AGENTS.md)** — 跨仓库协议、统一 JSON Schema 与双层防冲突规范
- **[`azwosile/agy-market-catalog`](https://github.com/azwosile/agy-market-catalog)** — 插件目录提交指南与自动化收录管线

## 📄 许可证

[MIT License](./LICENSE)
