#!/usr/bin/env bash
# Copies the PUBLIC launch data named by a city.json into a directory that the
# container mounts at /data, and writes a container city.json pointing at it.
#
#   deploy/export-data.sh <city.json> <out-dir> [--relayer-keypair <container path> | --no-relayer]
#
# Copied per launch (whichever exist): <name>.public.json, <name>.settlement.json,
# <name>.viewkey.txt, <name>.audit.json, and the launch dir's audit-wallet/
# (a watch-only zcash-devtool wallet built from the published viewing key).
#
# Never copied, and the run aborts if one would be: *.secret*, identity.age,
# a keys.toml holding a mnemonic/seed, and any launch wallet/ dir (those hold
# spending keys). The tip wallet in the container config is a copy of one of
# the audit wallets (watch-only; it still follows the chain tip).
#
# --relayer-keypair sets where the container expects the Solana devnet relayer
# keypair (default /run/secrets/relayer-keypair.json; mount it there read-only).
# --no-relayer leaves it out: the server then answers claims with 503.
set -euo pipefail

die() { echo "export-data: $*" >&2; exit 1; }

[ $# -ge 2 ] || die "usage: $0 <city.json> <out-dir> [--relayer-keypair <path> | --no-relayer]"
CITY=$1; OUT=$2; shift 2
RELAYER=/run/secrets/relayer-keypair.json
while [ $# -gt 0 ]; do
  case $1 in
    --relayer-keypair) RELAYER=${2:?}; shift 2 ;;
    --no-relayer) RELAYER=; shift ;;
    *) die "unknown option $1" ;;
  esac
done

[ -f "$CITY" ] || die "no such file: $CITY"
command -v node >/dev/null || die "node is required to read city.json"
if [ -e "$OUT" ] && [ -n "$(ls -A "$OUT" 2>/dev/null)" ]; then die "$OUT exists and is not empty"; fi
mkdir -p "$OUT/launches"
# A refused or failed run leaves nothing half-copied behind.
trap 'rc=$?; [ $rc -eq 0 ] || rm -rf "$OUT"' EXIT

# Launch paths from city.json, resolved like serve.ts does (relative to the
# config file), with ~ expanded.
LAUNCHES=$(node -e '
  const { readFileSync } = require("node:fs"); const { resolve, dirname } = require("node:path");
  const cfgPath = resolve(process.argv[1]); const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
  const home = require("node:os").homedir();
  for (const p of cfg.launches) console.log(resolve(dirname(cfgPath), p.replace(/^~(?=\/)/, home)));
' "$CITY")
[ -n "$LAUNCHES" ] || die "city.json lists no launches"

# Refuses names that hold or unlock spending keys.
forbidden_name() {
  case $(basename "$1") in
    *.secret*|*_secret*|identity.age) return 0 ;;
  esac
  return 1
}

# Copies one public file, refusing anything forbidden or inside a wallet/ dir.
copy_public() {
  local src=$1 dst=$2
  forbidden_name "$src" && die "refusing to copy secret file $src"
  case /$src/ in */wallet/*) die "refusing to copy from a spending wallet dir: $src" ;; esac
  cp -p "$src" "$dst"
}

# An audit wallet is copied only if it is plainly watch-only: no age identity,
# no secret files, and no mnemonic or seed in keys.toml.
copy_audit_wallet() {
  local src=$1 dst=$2 f
  while IFS= read -r -d '' f; do
    forbidden_name "$f" && die "refusing $src: it contains $(basename "$f")"
    if [ "$(basename "$f")" = keys.toml ] && grep -qiE '^[[:space:]]*(mnemonic|seed)' "$f"; then
      die "refusing $src: $f holds a mnemonic/seed (spending wallet, not watch-only)"
    fi
  done < <(find "$src" -type f -print0)
  cp -Rp "$src" "$dst"
}

CONTAINER_LAUNCHES=()
TIP_SRC=
declare -a SEEN_DIRS=() SEEN_NAMES=()
while IFS= read -r PUB; do
  [ -f "$PUB" ] || die "launch file not found: $PUB"
  case $PUB in *.public.json) ;; *) die "launch entries must be <name>.public.json: $PUB" ;; esac
  DIR=$(dirname "$PUB"); BASE=$(basename "$PUB" .public.json)

  # One output dir per source launch dir (auditor.ts keeps one audit-wallet per dir).
  NAME=
  for i in "${!SEEN_DIRS[@]}"; do [ "${SEEN_DIRS[$i]}" = "$DIR" ] && NAME=${SEEN_NAMES[$i]}; done
  if [ -z "$NAME" ]; then
    NAME=$(basename "$DIR"); n=2
    while [ -e "$OUT/launches/$NAME" ]; do NAME=$(basename "$DIR")-$n; n=$((n + 1)); done
    SEEN_DIRS+=("$DIR"); SEEN_NAMES+=("$NAME")
    mkdir -p "$OUT/launches/$NAME"
    if [ -d "$DIR/audit-wallet" ]; then
      copy_audit_wallet "$DIR/audit-wallet" "$OUT/launches/$NAME/audit-wallet"
      [ -n "$TIP_SRC" ] || TIP_SRC="$DIR/audit-wallet"
    fi
  fi

  for ext in public.json settlement.json viewkey.txt audit.json; do
    [ -f "$DIR/$BASE.$ext" ] && copy_public "$DIR/$BASE.$ext" "$OUT/launches/$NAME/$BASE.$ext"
  done
  CONTAINER_LAUNCHES+=("/data/launches/$NAME/$BASE.public.json")
  echo "  $BASE: $(cd "$OUT/launches/$NAME" && ls -d "$BASE".* audit-wallet 2>/dev/null | tr '\n' ' ')"
done <<< "$LAUNCHES"

[ -n "$TIP_SRC" ] || die "no launch has an audit-wallet/; the server needs one watch-only wallet for the chain tip"
# A separate copy, so the 30 s tip sync and a launch audit never sync the same sqlite at once.
copy_audit_wallet "$TIP_SRC" "$OUT/tip-wallet"

node -e '
  const [out, relayer, ...launches] = process.argv.slice(1);
  const cfg = { port: 5174, host: "0.0.0.0", web: "/app/web", devtool: "/usr/local/bin/zcash-devtool",
                tipWallet: "/data/tip-wallet", launches };
  if (relayer) cfg.relayerKeypair = relayer;
  require("node:fs").writeFileSync(out + "/city.json", JSON.stringify(cfg, null, 2) + "\n");
' "$OUT" "$RELAYER" "${CONTAINER_LAUNCHES[@]}"

# Last check over everything written.
BAD=$(find "$OUT" \( -name '*.secret*' -o -name '*_secret*' -o -name identity.age -o -type d -name wallet \) -print)
[ -z "$BAD" ] || { rm -rf "$OUT"; die "secret material found in output, removed $OUT: $BAD"; }
if grep -rlqiE '^[[:space:]]*(mnemonic|seed)' --include=keys.toml "$OUT"; then rm -rf "$OUT"; die "a keys.toml in the output holds a mnemonic/seed, removed $OUT"; fi

# The container runs as uid 1000 and writes audit reports and wallet syncs here.
chmod -R u+rwX,go+rwX "$OUT"
echo "wrote $OUT/city.json (${#CONTAINER_LAUNCHES[@]} launches, tip wallet from $TIP_SRC)"
