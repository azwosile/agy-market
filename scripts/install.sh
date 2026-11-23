#!/usr/bin/env sh
# Zero-npm POSIX Shell Bootstrap Installer for AGY Market (`scripts/install.sh`)
set -eu

RELEASE_BASE_URL="${AGY_MARKET_RELEASE_URL:-https://github.com/azwosile/agy-market/releases/latest/download}"
MIRROR_PREFIX="${AGY_MARKET_MIRROR_PREFIX:-}"
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

echo "[AGY Market] Downloading release archive & SHA-256 checksum..."
curl -fsSL "$TAR_URL" -o "$TMP_DIR/agy-market.tar.gz"
curl -fsSL "$SHA_URL" -o "$TMP_DIR/agy-market.tar.gz.sha256"

EXPECTED_SHA="$(awk '{print tolower($1)}' "$TMP_DIR/agy-market.tar.gz.sha256")"
if command -v sha256sum >/dev/null 2>&1; then
  ACTUAL_SHA="$(sha256sum "$TMP_DIR/agy-market.tar.gz" | awk '{print tolower($1)}')"
else
  ACTUAL_SHA="$(shasum -a 256 "$TMP_DIR/agy-market.tar.gz" | awk '{print tolower($1)}')"
fi

if [ "$EXPECTED_SHA" != "$ACTUAL_SHA" ]; then
  echo "INTEGRITY_SHA256_MISMATCH: Expected $EXPECTED_SHA, got $ACTUAL_SHA" >&2
  exit 1
fi

mkdir -p "$TARGET_DIR"
tar -xzf "$TMP_DIR/agy-market.tar.gz" -C "$TARGET_DIR"

NOW_ISO="$(date -u +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || echo "2026-11-23T00:00:00Z")"
cat > "$TARGET_DIR/.agy-market-receipt.json" <<EOF
{
  "schemaVersion": 1,
  "id": "azwosile__agy-market",
  "track": "verified",
  "repositoryId": 0,
  "installedDir": "agy-market",
  "effectivePluginName": "agy-market",
  "scopedRewriteApplied": false,
  "installedVersion": "1.0.0",
  "gitTag": "v1.0.0",
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

echo "✓ Installed AGY Market -> $TARGET_DIR"
echo "  Open Market Pane: [AGY Market](sidecar://agy-market/market_pane/)"
echo "  Manage Plugin:    [AGY Market](customization://agy-market)"
