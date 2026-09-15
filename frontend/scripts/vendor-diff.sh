#!/bin/sh
# Compare the AgOS contract membrane to the UPSTREAM.pin git object — never to
# another checkout's live HEAD. Read-only: git show/archive only; no checkout.
#
# Explicit compare rules (no vague "diff the harness"):
#   BYTE_EQUAL wire: export const values in pin stream-protocol (or pin
#     apiproxy rpc.ts) must match frontend/src/contract/api/rpc.ts.
#   BYTE_EQUAL tree: if pin has packages/host/apiproxy/src/api, files that
#     exist on both sides and are NOT in ADAPTER_FILES must be identical.
#   ADAPTER_FILES: the lean AgOS membrane (listed below). Not byte-equal to
#     pin packages. Both names and content are frozen by a reviewed baseline.
#     This is a regression check, not proof of full host type compatibility.
#   PIN_ONLY: pin apiproxy files absent from the membrane must be listed in
#     PIN_ONLY_FILES or the check fails (host surface grew; acknowledge it).
#   Live worktree HEAD is printed as "not compared". It is never a source.
#
# Missing pin object or missing pin wire file → exit 2 (environment unsatisfied).
# Content mismatch → exit 1. Do not rewrite vendored files or the pin.
set -eu

ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
PIN_FILE="$ROOT/UPSTREAM.pin"
VENDORED="$ROOT/src/contract/api"
ADAPTER_BASELINE="$ROOT/contract-baseline.sha256"
HARNESS="${DEEPSEEK_HARNESS:-$HOME/Projects/deepseek-harness}"

# Versioned adapters: AgOS-owned membrane, aligned to the pin, not a dump.
# Keep in sync with the files that actually live under src/contract/api/.
ADAPTER_FILES="
agent-presets.schema.ts
agent-presets.ts
credentials.schema.ts
credentials.ts
index.ts
llm.schema.ts
llm.ts
rpc-map.ts
rpc.schema.ts
rpc.ts
session-search.ts
sessions.schema.ts
sessions.ts
settings.schema.ts
settings.ts
skills.schema.ts
skills.ts
workspace.schema.ts
workspace.ts
"

# Host-only apiproxy files the membrane intentionally does not vendor.
# Used only when the pin commit actually contains packages/host/apiproxy/src/api.
PIN_ONLY_FILES="
approvals.schema.ts
approvals.ts
downloads.schema.ts
downloads.ts
events.schema.ts
events.ts
goals.schema.ts
goals.ts
host.schema.ts
host.ts
jobs.schema.ts
jobs.ts
questions.schema.ts
questions.ts
subagents.schema.ts
subagents.ts
"

WIRE_CONSTS="
REMOTE_STREAM_MUX_PATH
REMOTE_EVENT_STREAM_ENDPOINT
REMOTE_EVENT_RESULT_ENDPOINT
REMOTE_EVENT_STREAM_PAYLOAD
"

APIPROXY_REL="packages/host/apiproxy/src/api"
WIRE_CANDIDATES="
packages/api/gateway/src/stream-protocol.ts
packages/host/apiproxy/src/api/rpc.ts
"

die() {
	echo "vendor-diff: $*" >&2
	exit 1
}

unsatisfied() {
	echo "vendor-diff: environment unsatisfied: $*" >&2
	exit 2
}

listed() {
	# $1 name, $2 list
	printf '%s\n' "$2" | grep -qx "$1"
}

extract_const() {
	# $1 file, $2 const name → value including quotes / `as const`
	awk -v name="$2" '
		$1 == "export" && $2 == "const" && $3 == name && $4 == "=" {
			out = $5
			for (i = 6; i <= NF; i++) out = out " " $i
			gsub(/\r$/, "", out)
			print out
			exit
		}
	' "$1"
}

if [ ! -f "$PIN_FILE" ]; then
	unsatisfied "UPSTREAM.pin missing at $PIN_FILE"
fi
if [ ! -d "$VENDORED" ]; then
	unsatisfied "vendored contract missing at $VENDORED"
fi

PIN_SHA="$(sed -n '1s/.*@ \([0-9a-fA-F]\{7,\}\).*/\1/p' "$PIN_FILE" | head -1)"
PIN_VER="$(sed -n '1s/.*(\([^)]*\)).*/\1/p' "$PIN_FILE" | head -1 | tr -d ' \n')"
if [ -z "$PIN_SHA" ] || [ -z "$PIN_VER" ]; then
	unsatisfied "cannot parse pin SHA/version from $PIN_FILE"
fi

if [ ! -d "$HARNESS" ]; then
	unsatisfied "harness repo not found at $HARNESS (set DEEPSEEK_HARNESS); cannot load pin $PIN_SHA"
fi
if [ ! -d "$HARNESS/.git" ] && [ ! -f "$HARNESS/.git" ]; then
	unsatisfied "not a git repo: $HARNESS; pin object $PIN_SHA is unreachable"
fi

if ! git -C "$HARNESS" cat-file -e "${PIN_SHA}^{commit}" 2>/dev/null; then
	unsatisfied "pin object $PIN_SHA not found in $HARNESS (do not compare live HEAD; fetch the pin commit or point DEEPSEEK_HARNESS at a clone that has it)"
fi

PIN_FULL="$(git -C "$HARNESS" rev-parse --verify "${PIN_SHA}^{commit}")"
PIN_PKG_VER="$(git -C "$HARNESS" show "${PIN_FULL}:package.json" | sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)"
if [ -z "$PIN_PKG_VER" ]; then
	unsatisfied "pin $PIN_SHA has no package.json version"
fi
if [ "$PIN_PKG_VER" != "$PIN_VER" ]; then
	die "UPSTREAM.pin version $PIN_VER != pin object package.json version $PIN_PKG_VER ($PIN_FULL)"
fi

HEAD_SHORT="$(git -C "$HARNESS" rev-parse --short=10 HEAD 2>/dev/null || echo unknown)"

echo "== pin:           $PIN_SHA ($PIN_VER) → $PIN_FULL"
echo "== harness repo:  $HARNESS"
echo "== pin object:    verified (read-only git show/archive)"
echo "== not compared:  $HARNESS worktree HEAD $HEAD_SHORT (live checkout is not the pin)"
echo "== vendored:      $VENDORED"

# --- adapter allowlist: frozen set, no silent extras ---
rc=0
actual="$( (CDPATH= cd -- "$VENDORED" && find . -type f -name '*.ts' | sed 's@^\./@@') )"
expected="$(printf '%s\n' "$ADAPTER_FILES" | sed '/^$/d' | sort)"
actual_sorted="$(printf '%s\n' "$actual" | sort)"
if [ "$actual_sorted" != "$expected" ]; then
	echo "== adapter set drift (VERSIONED ADAPTERS, frozen list in vendor-diff.sh):" >&2
	printf '%s\n' "$expected" >"${TMPDIR:-/tmp}/agos-vendor-expected.$$"
	printf '%s\n' "$actual_sorted" >"${TMPDIR:-/tmp}/agos-vendor-actual.$$"
	diff -u "${TMPDIR:-/tmp}/agos-vendor-expected.$$" "${TMPDIR:-/tmp}/agos-vendor-actual.$$" >&2 || true
	rm -f "${TMPDIR:-/tmp}/agos-vendor-expected.$$" "${TMPDIR:-/tmp}/agos-vendor-actual.$$"
	echo "vendor-diff: adapter allowlist mismatch — update the explicit ADAPTER_FILES rule, do not ignore extras" >&2
	rc=1
else
	echo "== adapters:      ${expected}" | tr '\n' ' '
	echo
	echo "== adapter rule:  reviewed local baseline; names and content must match"
fi

# Every adapter was already present at the reviewed 24bc17e baseline. An
# allowlist alone would let changed schemas silently pass with unchanged wire
# constants. Verify all bytes too; do not regenerate this manifest just to
# make a changed contract pass. New adapters need source review and fixtures.
if [ ! -f "$ADAPTER_BASELINE" ]; then
	unsatisfied "contract-baseline.sha256 missing"
fi
baseline_names="$(awk '!/^#/ && NF { print $2 }' "$ADAPTER_BASELINE" | sed 's@^src/contract/api/@@' | sort)"
if [ "$baseline_names" != "$expected" ]; then
	die "adapter content baseline does not cover the exact adapter set"
fi
if (cd "$ROOT" && shasum -a 256 -c "$ADAPTER_BASELINE"); then
	echo "== adapter content: reviewed baseline unchanged (not a full host compatibility proof)"
else
	echo "vendor-diff: adapter content drift — review contract changes and fixtures before updating the baseline" >&2
	rc=1
fi

# --- BYTE_EQUAL wire constants from the pin object ---
WIRE_REL=""
for cand in $WIRE_CANDIDATES; do
	if git -C "$HARNESS" cat-file -e "${PIN_FULL}:${cand}" 2>/dev/null; then
		WIRE_REL="$cand"
		break
	fi
done
if [ -z "$WIRE_REL" ]; then
	unsatisfied "pin $PIN_SHA has none of the wire sources ($(echo $WIRE_CANDIDATES | tr '\n' ' '))"
fi

TMP="$(mktemp -d "${TMPDIR:-/tmp}/agos-vendor-diff.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT
git -C "$HARNESS" show "${PIN_FULL}:${WIRE_REL}" >"$TMP/pin-wire.ts"
echo "== wire source:   git show $PIN_SHA:$WIRE_REL"

for name in $WIRE_CONSTS; do
	[ -n "$name" ] || continue
	pin_val="$(extract_const "$TMP/pin-wire.ts" "$name")"
	mem_val="$(extract_const "$VENDORED/rpc.ts" "$name")"
	if [ -z "$pin_val" ]; then
		die "pin $WIRE_REL missing export const $name"
	fi
	if [ -z "$mem_val" ]; then
		die "vendored rpc.ts missing export const $name"
	fi
	if [ "$pin_val" != "$mem_val" ]; then
		echo "vendor-diff: BYTE_EQUAL wire mismatch: $name" >&2
		echo "  pin $WIRE_REL: $pin_val" >&2
		echo "  membrane rpc.ts: $mem_val" >&2
		rc=1
	else
		echo "== BYTE_EQUAL:    $name = $pin_val"
	fi
done

# --- optional wholesale tree when the pin actually has apiproxy/src/api ---
if git -C "$HARNESS" cat-file -e "${PIN_FULL}:${APIPROXY_REL}" 2>/dev/null; then
	echo "== pin tree:      $APIPROXY_REL (present at pin; byte-equal for non-adapters)"
	mkdir -p "$TMP/pin-api"
	git -C "$HARNESS" archive "$PIN_FULL" "$APIPROXY_REL" | tar -x -C "$TMP"
	PIN_API="$TMP/$APIPROXY_REL"
	pin_names="$( (CDPATH= cd -- "$PIN_API" && ls -1 *.ts) )"
	for f in $pin_names; do
		if listed "$f" "$ADAPTER_FILES"; then
			echo "== adapter skip:  $f (versioned membrane, not byte-equal)"
			continue
		fi
		if [ -f "$VENDORED/$f" ]; then
			if ! diff -q "$PIN_API/$f" "$VENDORED/$f" >/dev/null; then
				echo "vendor-diff: BYTE_EQUAL tree mismatch: $f (pin $APIPROXY_REL vs membrane)" >&2
				diff -u "$PIN_API/$f" "$VENDORED/$f" >&2 || true
				rc=1
			else
				echo "== BYTE_EQUAL:    $f"
			fi
			continue
		fi
		if listed "$f" "$PIN_ONLY_FILES"; then
			echo "== pin-only:      $f (host surface, not in membrane)"
			continue
		fi
		echo "vendor-diff: pin has $APIPROXY_REL/$f which is neither BYTE_EQUAL, ADAPTER, nor PIN_ONLY — acknowledge it in the rule list" >&2
		rc=1
	done
	for f in $actual; do
		if [ -f "$PIN_API/$f" ]; then
			continue
		fi
		if listed "$f" "$ADAPTER_FILES"; then
			continue
		fi
		echo "vendor-diff: vendored $f has no pin counterpart and is not in ADAPTER_FILES" >&2
		rc=1
	done
else
	echo "== pin tree:      $APIPROXY_REL absent at $PIN_SHA (0.1.2-rc.1 layout) — no wholesale dump; adapters + wire BYTE_EQUAL only"
fi

if [ "$rc" -eq 0 ]; then
	echo "== pin wire constants + reviewed adapter baseline verified: $PIN_SHA ($PIN_VER) =="
fi
exit "$rc"
