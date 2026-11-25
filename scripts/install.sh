#!/usr/bin/env sh
# Zero-npm POSIX Shell Bootstrap Installer for AGY Market (`scripts/install.sh`)
# Verifies SHA-256 digest before extracting real files into ~/.gemini/config/plugins/agy-market
# Automatically falls back to the authoritative AGY Market catalog index when binary release assets are absent.
set -eu

RELEASE_BASE_URL="${AGY_MARKET_RELEASE_URL:-https://github.com/azwosile/agy-market/releases/latest/download}"
MIRROR_PREFIX="${AGY_MARKET_MIRROR_PREFIX:-}"
CATALOG_URLS="${AGY_MARKET_CATALOG_URLS:-https://azwosile.github.io/agy-market-catalog/index.json https://raw.githubusercontent.com/azwosile/agy-market-catalog/gh-pages/index.json}"
CONFIG_DIR="${ANTIGRAVITY_CONFIG_DIR:-$HOME/.gemini/config}"
TARGET_DIR="$CONFIG_DIR/plugins/agy-market"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

TAR_URL="$RELEASE_BASE_URL/agy-market.tar.gz"
SHA_URL="$RELEASE_BASE_URL/agy-market.tar.gz.sha256"
if [ -n "$MIRROR_PREFIX" ]; then
  PREFIX="${MIRROR_PREFIX%/}"
  TAR_URL="$PREFIX/$TAR_URL"
  SHA_URL="$PREFIX/$SHA_URL"
fi

EXPECTED_SHA=""
RESOLVED_REPO_ID="0"

parse_catalog_entry() {
  CAT_FILE="$1"
  if command -v node >/dev/null 2>&1; then
    env -u ELECTRON_RUN_AS_NODE node -e '
      const fs = require("node:fs");
      const j = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      const p = (j.plugins || []).find((x) => x.id === "azwosile__agy-market" || x.canonicalName === "agy-market");
      if (!p || !p.distribution || !p.distribution.tarballUrl || !p.distribution.sha256) process.exit(1);
      console.log([p.distribution.tarballUrl, String(p.distribution.sha256).toLowerCase(), String((p.repository && p.repository.repositoryId) || 0)].join("\t"));
    ' "$CAT_FILE"
    return $?
  elif command -v python3 >/dev/null 2>&1; then
    python3 -c '
import json, sys
j = json.load(open(sys.argv[1], encoding="utf-8"))
p = next((x for x in j.get("plugins", []) if x.get("id") == "azwosile__agy-market" or x.get("canonicalName") == "agy-market"), None)
if not p or not p.get("distribution", {}).get("tarballUrl") or not p.get("distribution", {}).get("sha256"):
    sys.exit(1)
print("\t".join([p["distribution"]["tarballUrl"], p["distribution"]["sha256"].lower(), str(p.get("repository", {}).get("repositoryId", 0))]))
    ' "$CAT_FILE"
    return $?
  fi
  return 1
}

echo "[AGY Market] Downloading release archive & SHA-256 checksum..."
if curl -fsSL "$TAR_URL" -o "$TMP_DIR/agy-market.tar.gz" 2>/dev/null && curl -fsSL "$SHA_URL" -o "$TMP_DIR/agy-market.tar.gz.sha256" 2>/dev/null; then
  EXPECTED_SHA="$(awk '{print tolower($1)}' "$TMP_DIR/agy-market.tar.gz.sha256")"
else
  echo "[AGY Market] Direct release asset unavailable; resolving verified bundle from AGY Market catalog..."
  PARSED_LINE=""
  for CAT_URL in $CATALOG_URLS; do
    if curl -fsSL "$CAT_URL" -o "$TMP_DIR/catalog-index.json" 2>/dev/null; then
      if PARSED_LINE="$(parse_catalog_entry "$TMP_DIR/catalog-index.json" 2>/dev/null)" && [ -n "$PARSED_LINE" ]; then
        break
      fi
    fi
  done

  if [ -z "$PARSED_LINE" ]; then
    echo "ERR_BOOTSTRAP_CATALOG_FALLBACK: Could not resolve azwosile__agy-market from catalog feeds." >&2
    exit 1
  fi

  FALLBACK_TAR_URL="$(printf '%s' "$PARSED_LINE" | awk -F '\t' '{print $1}')"
  EXPECTED_SHA="$(printf '%s' "$PARSED_LINE" | awk -F '\t' '{print tolower($2)}')"
  RESOLVED_REPO_ID="$(printf '%s' "$PARSED_LINE" | awk -F '\t' '{print $3}')"

  if [ -n "$MIRROR_PREFIX" ] && printf '%s' "$FALLBACK_TAR_URL" | grep -q '^https://github\.com/'; then
    FALLBACK_TAR_URL="${MIRROR_PREFIX%/}/$FALLBACK_TAR_URL"
  fi
  curl -fsSL "$FALLBACK_TAR_URL" -o "$TMP_DIR/agy-market.tar.gz"
fi

if command -v sha256sum >/dev/null 2>&1; then
  ACTUAL_SHA="$(sha256sum "$TMP_DIR/agy-market.tar.gz" | awk '{print tolower($1)}')"
else
  ACTUAL_SHA="$(shasum -a 256 "$TMP_DIR/agy-market.tar.gz" | awk '{print tolower($1)}')"
fi

if [ "$EXPECTED_SHA" != "$ACTUAL_SHA" ]; then
  echo "INTEGRITY_SHA256_MISMATCH: Expected $EXPECTED_SHA, got $ACTUAL_SHA" >&2
  exit 1
fi

UNPACK_DIR="$TMP_DIR/unpacked"
mkdir -p "$UNPACK_DIR"
tar -xzf "$TMP_DIR/agy-market.tar.gz" -C "$UNPACK_DIR"

BUNDLE_DIR="$UNPACK_DIR"
if [ ! -f "$BUNDLE_DIR/plugin.json" ]; then
  for SUB in "$UNPACK_DIR"/*; do
    if [ -d "$SUB" ] && [ -f "$SUB/plugin.json" ]; then
      BUNDLE_DIR="$SUB"
      break
    fi
  done
fi

if [ ! -f "$BUNDLE_DIR/plugin.json" ]; then
  echo "ERR_BOOTSTRAP_MISSING_MANIFEST: Unpacked archive does not contain plugin.json" >&2
  exit 1
fi

mkdir -p "$TARGET_DIR"
cp -R "$BUNDLE_DIR/." "$TARGET_DIR/"

INSTALLED_VER="$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$TARGET_DIR/plugin.json" | head -n 1)"
if [ -z "$INSTALLED_VER" ]; then
  INSTALLED_VER="1.6.0"
fi

NOW_ISO="$(date -u +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || echo "2026-11-23T00:00:00Z")"
cat > "$TARGET_DIR/.agy-market-receipt.json" <<EOF
{
  "schemaVersion": 1,
  "id": "azwosile__agy-market",
  "track": "verified",
  "repositoryId": ${RESOLVED_REPO_ID:-0},
  "installedDir": "agy-market",
  "effectivePluginName": "agy-market",
  "scopedRewriteApplied": false,
  "installedVersion": "$INSTALLED_VER",
  "gitTag": "v$INSTALLED_VER",
  "sha256": "$ACTUAL_SHA",
  "preservePaths": [],
  "grantedCapabilities": {
    "badges": ["sidecar-ui"],
    "mcpRemoteDomains": [],
    "hookEvents": []
  },
  "installedAt": "$NOW_ISO",
  "updatedAt": "$NOW_ISO"
}
EOF

echo "✓ Installed AGY Market (v$INSTALLED_VER) -> $TARGET_DIR"
echo "  Open Market Pane: [AGY Market](sidecar://agy-market/market_pane/)"
echo "  Manage Plugin:    [AGY Market](customization://agy-market)"
