# AGY Market (`agy-market`)

The visual community plugin marketplace inside **Google Antigravity** — browse, search, inspect transparent capability badges, and one-click install language-agnostic Antigravity plugins from a zero-token Sidecar pane.

> **Repository Boundary**: This repository contains the `agy-market` Sidecar plugin, Windows lock-safe tarball installer, `npx agy-market` bootstrap CLI, and static web showcase (`site/`). To submit a plugin to the community catalog, open a Pull Request in **[`azwosile/agy-market-catalog`](https://github.com/azwosile/agy-market-catalog)**.

---

## Quick Start

```powershell
# Build single-file Sidecar UI (sidecars/market_pane/index.html) & static showcase
npm run build

# Copy real plugin bundle into ~/.gemini/config/plugins/agy-market
npm run install:local

# Run installation health diagnostics
node ./bin/agy-market.mjs doctor

# Pack deterministic release tarball (dist/agy-market.tar.gz + .sha256)
npm run pack:release

# Run unit & cross-repository integration tests
npm test
```

### One-Line User Bootstrap

- **Node / npx**: `npx agy-market@latest`
- **Windows PowerShell (Zero npm)**: `irm https://raw.githubusercontent.com/azwosile/agy-market/main/scripts/install.ps1 | iex`
- **macOS / Linux Shell (Zero npm)**: `curl -fsSL https://raw.githubusercontent.com/azwosile/agy-market/main/scripts/install.sh | sh`

Once installed in Antigravity:
- Open Auxiliary Pane: `[AGY Market](sidecar://agy-market/market_pane/)`
- Manage Plugin: `[AGY Market](customization://agy-market)`

---

## Architecture & Engineering Rules

Read **[`AGENTS.md`](./AGENTS.md)** and **[`../AGENTS.md`](../AGENTS.md)** before modifying any module in this repository.
