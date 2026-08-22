#!/bin/sh
# Align the AgOS contract membrane to the DSH host that is actually installed.
# Usage:
#   sh scripts/upgrade-dsh.sh --check   # pin version vs `dsh --version` only
#   sh scripts/upgrade-dsh.sh --upgrade # fetch matching harness tag, vendor, typecheck, then check
#   sh scripts/upgrade-dsh.sh --help
set -eu

ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
HARNESS="${DEEPSEEK_HARNESS:-$HOME/Projects/deepseek-harness}"
PIN="$ROOT/UPSTREAM.pin"

usage() {
  cat <<'EOF'
upgrade-dsh.sh — keep the AgOS contract membrane on the same version as the running host.

  --check     compare UPSTREAM.pin version with `dsh --version` (no writes)
  --upgrade   fetch the exact harness tag for the host version, vendor, typecheck, then --check
  --help      this text

Any other argument exits 2. A bare invocation is not an upgrade.
EOF
}

host_version() {
  dsh --version 2>/dev/null | tr -d ' \n'
}

pin_version() {
  sed -n 's/.*(\([^)]*\)).*/\1/p' "$PIN" | head -1 | tr -d ' \n'
}

check_versions() {
  HOST="$(host_version)"
  PINVER="$(pin_version)"
  if [ -z "$HOST" ] || [ -z "$PINVER" ]; then
    echo "upgrade-dsh: cannot read versions" >&2
    echo "  dsh --version: ${HOST:-<empty>}" >&2
    echo "  UPSTREAM.pin:  ${PINVER:-<empty>}" >&2
    return 2
  fi
  if [ "$HOST" != "$PINVER" ]; then
    echo "upgrade-dsh: membrane/host mismatch" >&2
    echo "  dsh --version: $HOST" >&2
    echo "  UPSTREAM.pin:  $PINVER" >&2
    return 1
  fi
  echo "upgrade-dsh: pin $PINVER matches host $HOST"
  return 0
}

MODE=""
case "${1:-}" in
  --check) MODE="check" ;;
  --upgrade) MODE="upgrade" ;;
  --help|-h) usage; exit 0 ;;
  "")
    echo "upgrade-dsh: missing argument (need --check, --upgrade, or --help)" >&2
    usage >&2
    exit 2
    ;;
  *)
    echo "upgrade-dsh: unknown argument: $1" >&2
    usage >&2
    exit 2
    ;;
esac

if [ "$MODE" = "check" ]; then
  check_versions
  exit $?
fi

HOST="$(host_version)"
if [ -z "$HOST" ]; then
  echo "upgrade-dsh: dsh --version produced no output" >&2
  exit 2
fi
if [ ! -d "$HARNESS/.git" ]; then
  echo "upgrade-dsh: harness clone not found at $HARNESS" >&2
  exit 2
fi

SRC="$HARNESS/packages/host/apiproxy/src/api"
if [ ! -d "$SRC" ]; then
  echo "upgrade-dsh: contract source missing: $SRC" >&2
  exit 2
fi

git -C "$HARNESS" fetch origin

EXACT=""
for candidate in "dsh-v${HOST}" "v${HOST}" "${HOST}"; do
  if git -C "$HARNESS" rev-parse -q --verify "refs/tags/${candidate}" >/dev/null; then
    EXACT="$candidate"
    break
  fi
done
if [ -z "$EXACT" ]; then
  echo "upgrade-dsh: no exact tag for host version $HOST (tried dsh-v${HOST}, v${HOST}, ${HOST})" >&2
  exit 2
fi

git -C "$HARNESS" checkout --detach "$EXACT"
HARNESS_VER="$(node -p "require('$HARNESS/package.json').version")"
if [ "$HARNESS_VER" != "$HOST" ]; then
  echo "upgrade-dsh: tag $EXACT has package.json version $HARNESS_VER, expected $HOST" >&2
  exit 2
fi
SHA="$(git -C "$HARNESS" rev-parse --short=10 HEAD)"
DATE="$(TZ='Asia/Shanghai' date '+%Y-%m-%d')"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/agos-contract.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT
cp -R "$SRC/." "$TMP/"
if [ ! -f "$TMP/sessions.ts" ]; then
  echo "upgrade-dsh: copied contract is missing sessions.ts; leaving src/contract/api untouched" >&2
  exit 2
fi

DEST="$ROOT/src/contract/api"
DEST_OLD="${DEST}.prev.$$"
if [ -d "$DEST" ]; then
  mv "$DEST" "$DEST_OLD"
fi
mv "$TMP" "$DEST"
trap - EXIT
rm -rf "$DEST_OLD"

printf 'deepseek-harness @ %s (%s) — vendored %s\n' "$SHA" "$HOST" "$DATE" > "$PIN"

cd "$ROOT"
sh scripts/vendor-diff.sh
npx --no-install tsc --noEmit
check_versions
