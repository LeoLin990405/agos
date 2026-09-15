#!/bin/zsh
# Self-test for verify-script exit-code honesty and pin-scoped vendor-diff.
# Does not run npm verify, deploy write, or dsh restart.
set -u
setopt PIPE_FAIL
ROOT="${0:A:h:h}"
fail=0

note() { print -- "$*"; }
bad() { print -- "FAIL: $*"; fail=1; }
ok() { print -- "PASS: $*"; }

print "▸ syntax"
if zsh -n "$ROOT/scripts/test-all.sh"; then ok "zsh -n test-all.sh"; else bad "zsh -n test-all.sh"; fi
if zsh -n "$ROOT/scripts/iterate.sh"; then ok "zsh -n iterate.sh"; else bad "zsh -n iterate.sh"; fi
if sh -n "$ROOT/frontend/scripts/vendor-diff.sh"; then ok "sh -n vendor-diff.sh"; else bad "sh -n vendor-diff.sh"; fi
if sh -n "$ROOT/frontend/scripts/upgrade-dsh.sh"; then ok "sh -n upgrade-dsh.sh"; else bad "sh -n upgrade-dsh.sh"; fi

print "▸ extract helpers (no deploy / no verify)"
# shellcheck disable=SC1091
AGOS_TEST_ALL_HELPERS_ONLY=1 source "$ROOT/scripts/test-all.sh"
if typeset -f agos_keep_exit >/dev/null; then ok "test-all helpers sourced"; else bad "test-all helpers not defined"; fi

# Test this definition before iterate.sh replaces it. The two call sites must
# each preserve failure and keep unfiltered failure diagnostics.
first_rc=0
first_out="$(agos_keep_exit 'pass' /bin/zsh -c 'print "pass 1"; print "compiler failed"; exit 7')" || first_rc=$?
if (( first_rc == 7 )) && print -r -- "$first_out" | /usr/bin/grep -q 'compiler failed'; then
	ok "test-all preserves exit 7 and failure diagnostics"
else
	bad "test-all masked failure or discarded diagnostics"
fi
first_success=0
agos_keep_exit 'unmatched' /bin/zsh -c 'print ok; exit 0' >/dev/null || first_success=$?
if (( first_success == 0 )); then ok "test-all unmatched filter preserves success"; else bad "test-all filter failed success"; fi

unset -f agos_keep_exit 2>/dev/null || true
# shellcheck disable=SC1091
AGOS_ITERATE_HELPERS_ONLY=1 source "$ROOT/scripts/iterate.sh"
if typeset -f agos_keep_exit >/dev/null; then ok "iterate helpers sourced"; else bad "iterate helpers not defined"; fi

print "▸ (a) failing producer piped through grep: old green, new red"
old_rc="$(
	set +o pipefail
	unsetopt PIPE_FAIL 2>/dev/null || true
	/bin/zsh -c 'print "built in 3ms"; print "error: compile failed"; exit 7' | /usr/bin/grep -E 'built in|error' >/dev/null
	print -- "$status"
)"
if [[ "$old_rc" == "0" ]]; then
	ok "old pipe+grep masks exit 7 as 0"
else
	bad "old pipe reproduction expected grep status 0, got $old_rc"
fi

new_rc=0
agos_keep_exit 'built in|error' /bin/zsh -c 'print "built in 3ms"; print "error: compile failed"; exit 7' >/dev/null || new_rc=$?
if [[ "$new_rc" == "7" ]]; then
	ok "agos_keep_exit preserves producer exit 7"
else
	bad "agos_keep_exit expected 7, got $new_rc"
fi

# grep finds nothing must not flip a successful command to failure
silent_rc=0
agos_keep_exit 'this-pattern-will-not-match' /bin/zsh -c 'print "ok"; exit 0' >/dev/null || silent_rc=$?
if [[ "$silent_rc" == "0" ]]; then
	ok "empty grep does not fail a successful producer"
else
	bad "empty grep flipped success to $silent_rc"
fi

print "▸ (b) vendor-diff without pin object"
empty="$(mktemp -d "${TMPDIR:-/tmp}/agos-vendor-empty.XXXXXX")"
git -c init.defaultBranch=main init -q "$empty"
print 'empty' >"$empty/README"
git -C "$empty" add README
git -C "$empty" -c user.email=selftest@invalid -c user.name=selftest commit -q -m empty
vd_out="$(DEEPSEEK_HARNESS="$empty" sh "$ROOT/frontend/scripts/vendor-diff.sh" 2>&1)" || vd_rc=$?
vd_rc=${vd_rc:-0}
rm -rf "$empty"
if (( vd_rc == 2 )) && print -r -- "$vd_out" | /usr/bin/grep -q 'environment unsatisfied' && print -r -- "$vd_out" | /usr/bin/grep -q 'a66e470204'; then
	ok "missing pin object → exit 2 + explains pin SHA"
else
	bad "missing pin expected exit 2 with environment unsatisfied + a66e470204; got $vd_rc"
	print -r -- "$vd_out"
fi

missing_dir_rc=0
missing_out="$(DEEPSEEK_HARNESS="/tmp/agos-no-such-harness-$$" sh "$ROOT/frontend/scripts/vendor-diff.sh" 2>&1)" || missing_dir_rc=$?
if (( missing_dir_rc == 2 )) && print -r -- "$missing_out" | /usr/bin/grep -q 'environment unsatisfied'; then
	ok "missing harness dir → exit 2"
else
	bad "missing harness dir expected exit 2; got $missing_dir_rc"
	print -r -- "$missing_out"
fi

print "▸ vendor-diff against real pin object (not live HEAD)"
pin_rc=0
pin_out="$(sh "$ROOT/frontend/scripts/vendor-diff.sh")" || pin_rc=$?
print -r -- "$pin_out"
if (( pin_rc == 0 )) && print -r -- "$pin_out" | /usr/bin/grep -q 'not compared' && print -r -- "$pin_out" | /usr/bin/grep -q 'BYTE_EQUAL'; then
	ok "pin-scoped vendor-diff exit 0"
elif (( pin_rc == 2 )); then
	bad "pin object missing in this environment (exit 2) — not treated as green"
else
	bad "pin-scoped vendor-diff expected 0, got $pin_rc"
fi

print "▸ upgrade-dsh --check (read-only, no pin move)"
chk_rc=0
chk_out="$(cd "$ROOT/frontend" && sh scripts/upgrade-dsh.sh --check)" || chk_rc=$?
print -r -- "$chk_out"
if (( chk_rc == 0 )); then
	ok "upgrade-dsh --check"
else
	note "upgrade-dsh --check exit $chk_rc (host/pin version mismatch is informational here)"
fi

print "▸ adapter mutation must fail even with unchanged wire constants"
adapter_fixture="$(mktemp -d "${TMPDIR:-/tmp}/agos-vendor-mutation.XXXXXX")"
trap 'rm -rf "$adapter_fixture"' EXIT
mkdir -p "$adapter_fixture/scripts" "$adapter_fixture/src/contract"
cp "$ROOT/frontend/scripts/vendor-diff.sh" "$adapter_fixture/scripts/"
cp "$ROOT/frontend/UPSTREAM.pin" "$ROOT/frontend/contract-baseline.sha256" "$adapter_fixture/"
cp -R "$ROOT/frontend/src/contract/api" "$adapter_fixture/src/contract/"
print '\n// synthetic unreviewed schema change' >>"$adapter_fixture/src/contract/api/sessions.schema.ts"
mutation_rc=0
mutation_out="$(sh "$adapter_fixture/scripts/vendor-diff.sh" 2>&1)" || mutation_rc=$?
if (( mutation_rc == 1 )) && print -r -- "$mutation_out" | /usr/bin/grep -q 'adapter content drift'; then
	ok "changed adapter contents fail the gate"
else
	bad "changed adapter incorrectly passed (exit $mutation_rc)"
fi

print "▸ failing rsync must not be reported as zero deployment drift"
mkdir -p "$adapter_fixture/bin"
cat >"$adapter_fixture/bin/rsync" <<'FAKE_RSYNC'
#!/bin/sh
echo 'synthetic rsync failure' >&2
exit 23
FAKE_RSYNC
chmod +x "$adapter_fixture/bin/rsync"
drift_rc=0
drift_out="$(PATH="$adapter_fixture/bin:$PATH" zsh "$ROOT/scripts/deploy-plugins.sh" --check 2>&1)" || drift_rc=$?
if (( drift_rc != 0 )) && ! print -r -- "$drift_out" | /usr/bin/grep -q '零漂移'; then
	ok "rsync failure is a failed check, never zero drift"
else
	bad "deployment check swallowed failed rsync"
fi

if (( fail )); then
	print "▸ selftest FAILED"
	exit 1
fi
print "▸ selftest OK"
exit 0
