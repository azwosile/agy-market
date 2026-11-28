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
TICKET=""
ATOMIC_TMP=""
cleanup() {
  if [ -n "$ATOMIC_TMP" ]; then rm -f "$ATOMIC_TMP"; fi
  if [ -n "$TICKET" ]; then rm -f "$TICKET"; fi
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM

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
      const p = (j.plugins || []).find((x) => x.id === "azwosile__agy-market");
      if (!p || !p.distribution || !p.distribution.tarballUrl || !p.distribution.sha256) process.exit(1);
      console.log([p.distribution.tarballUrl, String(p.distribution.sha256).toLowerCase(), String((p.repository && p.repository.repositoryId) || 0)].join("\t"));
    ' "$CAT_FILE"
    return $?
  elif command -v python3 >/dev/null 2>&1; then
    python3 -c '
import json, sys
j = json.load(open(sys.argv[1], encoding="utf-8"))
p = next((x for x in j.get("plugins", []) if x.get("id") == "azwosile__agy-market"), None)
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

# Coordinate with the sidecar and CLI for the entire on-disk mutation.
DATA_DIR="${AGY_MARKET_DATA_DIR:-${ANTIGRAVITY_EXECUTABLE_DATA_DIR:-${PLUGIN_DATA:-}}}"
if [ -z "$DATA_DIR" ]; then
  base="$HOME/.gemini"
  if [ -d "$base/antigravity" ]; then base="$base/antigravity"; fi
  DATA_DIR="$base/sidecar_data/agy-market/market_pane/data"
fi
mkdir -p "$DATA_DIR/mutation-locks"
ticket_pid=$$
if [ -f "/proc/$$/winpid" ]; then ticket_pid="$(cat "/proc/$$/winpid")"; fi
TICKET="$(mktemp "$DATA_DIR/mutation-locks/$ticket_pid-XXXXXXXX")"
for other in "$DATA_DIR/mutation-locks/"*; do
  [ -e "$other" ] && [ "$other" != "$TICKET" ] || continue
  pid="${other##*/}"; pid="${pid%%-*}"
  case "$pid" in ''|*[!0-9]*) continue ;; esac
  if [ -f "/proc/$$/winpid" ]; then
    # MSYS process IDs differ from the native process IDs in Node tickets.
    if ! ps -W | awk -v pid="$pid" '$4==pid {found=1} END {exit !found}'; then continue; fi
  elif ! kill -0 "$pid" 2>/dev/null && ! ps -p "$pid" >/dev/null 2>&1; then
    continue
  fi
  echo "ERR_PLUGIN_OPERATION_BUSY: Another plugin operation is active." >&2
  exit 1
done

# Read compact metadata without requiring Python, Node or jq.
json_field() {
  awk -v key="$2" '
    { json=json $0 "\n" }
    END {
      while (match(json, /"([^"\\]|\\.)*"|[][{}]/)) {
        t=substr(json,RSTART,RLENGTH); json=substr(json,RSTART+RLENGTH)
        if (t=="{" || t=="[") {depth++; continue}
        if (t=="}" || t=="]") {depth--; if (nested && depth==1) exit; continue}
        if (depth!=1+nested || t!="\"" key "\"" || !sub(/^[[:space:]]*:[[:space:]]*/, "", json)) continue
        if (key=="repository" && json ~ /^\{/) {key="url"; nested=1; continue}
        if (json ~ /^\[/) {print "array"; exit}
        if (match(json, /^[0-9]+/)) {print substr(json,1,RLENGTH); exit}
        if (json ~ /^true/) {print "true"; exit}
        if (json ~ /^(false|null)/) exit
        if (!match(json,/^"([^"\\]|\\.)*"/)) exit 1
        v=substr(json,2,RLENGTH-2); out=""
        for (i=1;i<=length(v);i++) {
          c=substr(v,i,1)
          if (c=="\\") {c=substr(v,++i,1); if (c!="\\" && c!="\"" && c!="/") exit 1}
          out=out c
        }
        print out; exit
      }
    }' "$1"
}
JOURNAL="$DATA_DIR/pending-journal.json"
superseded=false
if [ -f "$JOURNAL" ]; then
  journal_dir="$(json_field "$JOURNAL" dir)"
  journal_parked="$(json_field "$JOURNAL" parkedByMarket)"
  if [ "$journal_dir" = agy-market ] && [ "$journal_parked" != true ]; then
    journal_root="$(json_field "$JOURNAL" pluginsDir)"
    plugins="$CONFIG_DIR/plugins"
    if [ -z "$journal_root" ] || [ "$journal_root" = "$plugins" ] || [ "$journal_root" -ef "$plugins" ]; then
      superseded=true
      old_stage="$(json_field "$JOURNAL" stagingRootDir)"
      old_backup="$(json_field "$JOURNAL" backupDir)"
    fi
  fi
fi
mkdir -p "$TARGET_DIR"
RECEIPT="$TARGET_DIR/.agy-market-receipt.json"
PENDING="$TARGET_DIR/.agy-market-bootstrap-pending"
MANIFEST="$TARGET_DIR/plugin.json"
if [ -L "$TARGET_DIR" ] || [ -L "$RECEIPT" ] || [ -L "$MANIFEST" ] || [ -L "$PENDING" ]; then
  echo "Linked installation directory or receipt: $TARGET_DIR" >&2
  exit 1
fi
bootstrap_conflict() {
  echo "ERR_BOOTSTRAP_CONFLICT: Cannot establish ownership of $TARGET_DIR" >&2
  exit 1
}
atomic_copy() {
  ATOMIC_TMP="$(mktemp "${2%/*}/.agy-market-bootstrap-write.XXXXXXXX")"
  cp -p "$1" "$ATOMIC_TMP"
  mv -f "$ATOMIC_TMP" "$2"
  ATOMIC_TMP=""
}
for metadata in "$RECEIPT" "$PENDING"; do
  [ ! -e "$metadata" ] || [ -f "$metadata" ] || bootstrap_conflict
done
official=false
official_repo() {
  printf '%s\n' "$1" | grep -Eiq '^((git\+)?(https?|git)://github\.com/|ssh://git@github\.com/|git@github\.com:)azwosile/agy-market(\.git)?/?$'
}
if [ -f "$MANIFEST" ]; then
  [ "$(json_field "$MANIFEST" name)" = agy-market ] || bootstrap_conflict
  repo="$(json_field "$MANIFEST" repository)"
  if [ -n "$repo" ]; then
    official_repo "$repo" || bootstrap_conflict
    official=true
  fi
fi
has_inventory=false
if [ -f "$RECEIPT" ]; then
  [ "$(json_field "$RECEIPT" id)" = azwosile__agy-market ] || bootstrap_conflict
  case "$(json_field "$RECEIPT" repositoryId)" in ''|0|1468650761) ;; *) bootstrap_conflict ;; esac
  case "$(json_field "$RECEIPT" pluginRoot)" in ''|.|./) ;; *) bootstrap_conflict ;; esac
  repo="$(json_field "$RECEIPT" repositoryUrl)"
  [ -z "$repo" ] || official_repo "$repo" || bootstrap_conflict
  if [ "$(json_field "$RECEIPT" managedFiles)" = array ]; then has_inventory=true; fi
elif [ -n "$(ls -A "$TARGET_DIR" | grep -v '^\.agy-market-bootstrap-write\.[[:alnum:]]\{8\}$' || :)" ]; then
  [ "$official" = true ] && [ ! -e "$TARGET_DIR/.git" ] && [ ! -L "$TARGET_DIR/.git" ] || bootstrap_conflict
else
  # Establish identity before publishing any files, even when the first install stops before plugin.json.
  printf '%s\n' '{"schemaVersion":1,"id":"azwosile__agy-market","managedFiles":[]}' > "$TMP_DIR/seed"
  atomic_copy "$TMP_DIR/seed" "$RECEIPT"
  has_inventory=true
fi

# Decode the two path lists from receipts, including compact JSON. Plain POSIX
# installations can read the literal UTF-8 path strings emitted by this script.
receipt_list() {
  [ -f "$RECEIPT" ] || return 0
  if python3 -V >/dev/null 2>&1; then
    python3 -c '
import json, sys
for path in json.load(open(sys.argv[1], encoding="utf-8-sig")).get(sys.argv[2], []):
    if not isinstance(path, str) or any(ord(c) < 32 for c in path): sys.exit("Invalid receipt path")
    sys.stdout.buffer.write(path.encode("utf-8") + b"\n")
' "$RECEIPT" "$1"
  elif command -v node >/dev/null 2>&1; then
    env -u ELECTRON_RUN_AS_NODE node -e '
      const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8").replace(/^\uFEFF/, ""));
      for (const p of r[process.argv[2]] || []) {
        if (typeof p !== "string" || /[\x00-\x1f]/.test(p)) throw Error("Invalid receipt path");
        console.log(p);
      }
    ' "$RECEIPT" "$1"
  else
    awk -v field="$1" '
      { json = json $0 "\n" }
      END {
        while (match(json, /"([^"\\]|\\.)*"|[][{}:,]/)) {
          t = substr(json, RSTART, RLENGTH); json = substr(json, RSTART+RLENGTH)
          if (t == "{" || t == "[") { depth++; if (t == "[" && key == field && depth == 2) list=1; key="" }
          else if (t == "}" || t == "]") { if (depth == 2) list=0; depth-- }
          else if (depth == 1 && t ~ /^"/) key=substr(t,2,length(t)-2)
          else if (list && depth == 2 && t ~ /^"/) {
            p=substr(t,2,length(t)-2); out=""
            for (i=1;i<=length(p);i++) {
              c=substr(p,i,1)
              if (c=="\\") { c=substr(p,++i,1); if (c!="\\" && c!="\"" && c!="/") exit 1 }
              out=out c
            }
            print out
          }
        }
      }' "$RECEIPT"
  fi
}

receipt_list managedFiles > "$TMP_DIR/old"
receipt_list preservePaths > "$TMP_DIR/preserve"
(cd "$BUNDLE_DIR" && find . -type f -exec sh -c '
  for file do
    case "$file" in *[[:cntrl:]]*) exit 1 ;; ./.agy-market-receipt.json) continue ;; esac
    printf "%s\n" "${file#./}"
  done' sh {} +) > "$TMP_DIR/new"

safe_target() {
  case "$1" in .agy-market-receipt.json|.agy-market-bootstrap-pending|.agy-market-bootstrap-write.*|*[[:cntrl:]]*) bootstrap_conflict ;; esac
  case "/$1/" in *'/../'*|*'/./'*|*'//'*|*'\'*) echo "Invalid receipt path: $1" >&2; exit 1 ;; esac
  part="$TARGET_DIR/$1"
  while [ "$part" != "$TARGET_DIR" ]; do
    if [ -L "$part" ]; then echo "Linked installation path: $part" >&2; exit 1; fi
    part="${part%/*}"
  done
}
file_digest() {
  if command -v sha256sum >/dev/null 2>&1; then
    digest="$(sha256sum < "$1")"
  else
    digest="$(shasum -a 256 < "$1")"
  fi
  printf '%s\n' "${digest%% *}"
}
preserved() {
  [ -s "$TMP_DIR/preserve" ] || return 1
  AGY_TEST_PATH="$1" awk -v fold="$fold_paths" '
    BEGIN { path=ENVIRON["AGY_TEST_PATH"]; if (fold) path=tolower(path) }
    {
      g=$0; gsub(/^[[:space:]]+|[[:space:]]+$/, "", g); gsub(/\\/, "/", g)
      sub(/^\.\/+/, "", g); sub(/\/+$/, "", g)
      if (!length(g) || index(g, "..")) next
      if (fold) g=tolower(g)
      re="^"
      for (i=1; i<=length(g); i++) {
        c=substr(g,i,1)
        if (substr(g,i,3)=="**/") { re=re "(.+/)?"; i+=2 }
        else if (substr(g,i,2)=="**") { re=re ".*"; i++ }
        else if (c=="*") re=re "[^/]*"
        else if (c=="?") re=re "[^/]"
        else re=re (index(".^$[](){}|+",c) ? "\\" : "") c
      }
      if (path ~ (re "(/.*)?$")) { matched=1; exit }
    }
    END { exit !matched }' "$TMP_DIR/preserve"
}
fold_paths=0
if [ "$RECEIPT" -ef "$TARGET_DIR/.AGY-MARKET-RECEIPT.JSON" ]; then fold_paths=1; fi
layout_conflict() {
  echo "ERR_PLUGIN_LAYOUT_CONFLICT: Cannot replace local path '$1'" >&2
  if [ "$superseded" = true ]; then
    echo "Complete the interrupted update with its original installer before retrying." >&2
  fi
  exit 1
}

# Pending paths are owned only while their bytes match a hash approved before a previous copy.
: > "$TMP_DIR/ledger"
if [ -f "$PENDING" ]; then
  awk '{sub(/\r$/, ""); if(length($0)<67 || substr($0,1,64) ~ /[^0-9a-f]/ || substr($0,65,2)!="  ") exit 1; print}' "$PENDING" > "$TMP_DIR/ledger"
fi
cut -c67- "$TMP_DIR/ledger" | LC_ALL=C sort -u > "$TMP_DIR/pending-paths"
while IFS= read -r rel; do safe_target "$rel"; done < "$TMP_DIR/pending-paths"
: > "$TMP_DIR/blocking-files"
: > "$TMP_DIR/blocking-dirs"
# Return the recorded spelling. A folded match establishes ownership only
# when both names resolve to the same entry in the destination filesystem.
listed_path() {
  if grep -Fxq -e "$1" "$2"; then printf '%s\n' "$1"; return 0; fi
  [ -e "$TARGET_DIR/$1" ] || return 1
  AGY_REL="$1" awk 'tolower($0)==tolower(ENVIRON["AGY_REL"])' "$2" | (
    while IFS= read -r candidate; do
      if [ "$TARGET_DIR/$1" -ef "$TARGET_DIR/$candidate" ]; then printf '%s\n' "$candidate"; exit 0; fi
    done
    exit 1
  )
}
awk '{p=$0; while (sub(/\/[^/]+$/, "", p)) print p}' "$TMP_DIR/old" "$TMP_DIR/pending-paths" |
  LC_ALL=C sort -u > "$TMP_DIR/owned-dirs"
removable_file() {
  if preserved "$1"; then return 1; fi
  listed_path "$1" "$TMP_DIR/old" >/dev/null || {
    spelling="$(listed_path "$1" "$TMP_DIR/pending-paths")" &&
      grep -Fxq -e "$(file_digest "$TARGET_DIR/$1")  $spelling" "$TMP_DIR/ledger"
  }
}
plan_blocking_file() {
  safe_target "$1"
  removable_file "$1" || layout_conflict "$1"
  printf '%s\n' "$1" >> "$TMP_DIR/blocking-files"
}
plan_blocking_directory() (
  safe_target "$1"
  if preserved "$1"; then layout_conflict "$1"; fi
  for child in "$TARGET_DIR/$1"/* "$TARGET_DIR/$1"/.[!.]* "$TARGET_DIR/$1"/..?*; do
    [ -e "$child" ] || [ -L "$child" ] || continue
    rel_child="$1/${child##*/}"
    if [ -d "$child" ]; then plan_blocking_directory "$rel_child"
    else plan_blocking_file "$rel_child"; fi
  done
  printf '%s\n' "$1" >> "$TMP_DIR/blocking-dirs"
)
cp "$TMP_DIR/ledger" "$TMP_DIR/next-ledger"
while IFS= read -r rel; do
  safe_target "$rel"
  dest="$TARGET_DIR/$rel"
  parent="$rel"
  while [ "${parent%/*}" != "$parent" ]; do
    parent="${parent%/*}"
    if [ -f "$TARGET_DIR/$parent" ]; then plan_blocking_file "$parent"; fi
  done
  if [ -d "$dest" ]; then
    listed_path "$rel" "$TMP_DIR/owned-dirs" >/dev/null || layout_conflict "$rel"
    plan_blocking_directory "$rel"
  elif [ -e "$dest" ] && [ ! -f "$dest" ]; then
    layout_conflict "$rel"
  fi
  if listed_path "$rel" "$TMP_DIR/old" >/dev/null; then continue; fi
  spelling="$rel"
  if [ -f "$dest" ]; then
    if preserved "$rel"; then continue; fi
    if recorded="$(listed_path "$rel" "$TMP_DIR/pending-paths")"; then
      spelling="$recorded"
      hash="$(file_digest "$dest")"
      if ! grep -Fxq -e "$hash  $spelling" "$TMP_DIR/ledger"; then
        layout_conflict "$rel"
      fi
    elif [ "$has_inventory" = true ]; then
      layout_conflict "$rel"
    else
      continue
    fi
  fi
  hash="$(file_digest "$BUNDLE_DIR/$rel")"
  printf '%s  %s\n' "$hash" "$spelling" >> "$TMP_DIR/next-ledger"
done < "$TMP_DIR/new"
LC_ALL=C sort -u "$TMP_DIR/next-ledger" > "$TMP_DIR/approved"
cut -c67- "$TMP_DIR/approved" | LC_ALL=C sort -u > "$TMP_DIR/approved-paths"
atomic_copy "$TMP_DIR/approved" "$PENDING"
LC_ALL=C sort -u "$TMP_DIR/blocking-files" > "$TMP_DIR/remove-files"
while IFS= read -r rel; do
  safe_target "$rel"
  removable_file "$rel" || layout_conflict "$rel"
  rm -f "$TARGET_DIR/$rel"
done < "$TMP_DIR/remove-files"
LC_ALL=C sort -ru "$TMP_DIR/blocking-dirs" > "$TMP_DIR/remove-dirs"
while IFS= read -r rel; do
  safe_target "$rel"
  rmdir "$TARGET_DIR/$rel"
done < "$TMP_DIR/remove-dirs"
publish_payload() {
  dest="$TARGET_DIR/$1"
  safe_target "$1"
  if [ -e "$dest" ] && [ ! -f "$dest" ]; then layout_conflict "$1"; fi
  if [ -f "$dest" ] && preserved "$1"; then return 0; fi
  if [ -f "$dest" ] && spelling="$(listed_path "$1" "$TMP_DIR/approved-paths")"; then
    hash="$(file_digest "$dest")"
    grep -Fxq -e "$hash  $spelling" "$TMP_DIR/approved" || layout_conflict "$1"
  fi
  mkdir -p "${dest%/*}"
  atomic_copy "$BUNDLE_DIR/$1" "$dest"
}
while IFS= read -r rel; do
  if [ "$rel" != plugin.json ]; then publish_payload "$rel"; fi
done < "$TMP_DIR/new"
while IFS= read -r rel; do
  [ -n "$rel" ] || continue
  safe_target "$rel"
  if listed_path "$rel" "$TMP_DIR/new" >/dev/null || preserved "$rel"; then continue; fi
  if [ -f "$TARGET_DIR/$rel" ]; then rm -f "$TARGET_DIR/$rel"; fi
done < "$TMP_DIR/old"
while IFS= read -r rel; do
  dest="$TARGET_DIR/$rel"
  if [ ! -f "$dest" ] || listed_path "$rel" "$TMP_DIR/new" >/dev/null || preserved "$rel"; then continue; fi
  hash="$(file_digest "$dest")"
  if grep -Fxq -e "$hash  $rel" "$TMP_DIR/ledger"; then rm -f "$dest"; fi
done < "$TMP_DIR/pending-paths"
# Publish the discoverable version after payload writes and stale-file cleanup have succeeded.
publish_payload plugin.json

json_paths() {
  awk 'BEGIN {printf "["}
    {printf "%s\"", NR==1 ? "" : ","; for(i=1;i<=length($0);i++) {
      c=substr($0,i,1); if(c=="\\" || c=="\"") printf "\\"; printf "%s",c
    } printf "\""}
    END {print "]"}' "$1"
}

INSTALLED_VER="$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$TARGET_DIR/plugin.json" | head -n 1)"
if [ -z "$INSTALLED_VER" ]; then
  INSTALLED_VER="2.0.0"
fi

NOW_ISO="$(date -u +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || echo "2026-11-23T00:00:00Z")"
cat > "$TMP_DIR/receipt" <<EOF
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
  "managedFiles": $(json_paths "$TMP_DIR/new"),
  "preservePaths": $(json_paths "$TMP_DIR/preserve"),
  "grantedCapabilities": {
    "badges": ["sidecar-ui"],
    "mcpRemoteDomains": [],
    "hookEvents": []
  },
  "installedAt": "$NOW_ISO",
  "updatedAt": "$NOW_ISO"
}
EOF
atomic_copy "$TMP_DIR/receipt" "$RECEIPT"
rm -f "$PENDING"

if [ "$superseded" = true ]; then
  rm -f "$JOURNAL"
  for old in "$old_stage" "$old_backup"; do
    [ -d "$old" ] || continue
    if [ -f "/proc/$$/winpid" ]; then old="$(cygpath -u "$old")"; fi
    parent="$(dirname "$old")"
    name="$(basename "$old")"
    case "$name" in .|..|'') continue ;; esac
    if [ "$parent" -ef "$DATA_DIR/staging" ]; then rm -rf "$parent/$name"; fi
  done
fi

echo "✓ Installed AGY Market (v$INSTALLED_VER) -> $TARGET_DIR"
echo "  Open Market Pane: [AGY Market](sidecar://agy-market/market_pane/)"
echo "  Manage Plugin:    [AGY Market](customization://agy-market)"
