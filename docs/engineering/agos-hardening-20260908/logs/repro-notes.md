> Historical implementation-stage record. Superseded by [final verification](../VERIFICATION.md) and REVIEW.md. Old counts, pending items and script descriptions below are not current acceptance claims. Early raw logs are intentionally not published.

# Repro notes — HEAD 24bc17e — 2026-09-08 18:54 Asia/Shanghai

Worktree: `/Users/leo/Projects/agos-cursor-hardening-20260908`
HEAD: `24bc17e6892839190563defe15ec4ed4b573e934`
Read-only. No npm install, no DSH restart, no real models, no real SSH.

## 1. Farm 100KB isolated — STILL FAILS

Command (stub ssh via PATH prefix; no real SSH/network):

```
cd plugins/dsh-fleet
node --test --test-name-pattern='early ssh exit with a 100KB prompt' test/farm-integration.test.mjs
```

- NODE_TEST_EXIT=**1**
- Duration ~14328 ms / 14379 ms wall
- Assertion: `transport exit 255 was not recorded as detached` at `farm-integration.test.mjs:308` (`waitUntil` default 2000 ms)
- Log: `logs/farm-100kb-isolated.log`

secrets-gate timings (fake strings only) in `logs/scrub-repro.log`:

| Input (100KB) | classifySecret | scrubString | sensitive |
|---|---:|---:|---|
| non-secret `n*` | 5275 ms | 4684 ms | false |
| near-match `password=A*` (fake) | 2.7 ms | 0.14 ms | true (pattern) |
| farm-like `x*` (what the test sends) | 5247 ms | 4643 ms | false |
| unicode-near `密码：键*` (fake) | 0.98 ms | 0.20 ms | true, but **not redacted** |

Scale `classifySecret` on `x*`: 4KB 9ms, 8KB 33ms, 16KB 132ms, 32KB 521ms, 64KB 2209ms, 100KB 5207ms (~n²).

The farm wait budget is 2s; a single classify/scrub of the 100KB prompt is already ~5s. Raising the test timeout only would be fake-green.

## 2. fleet.fake.test.mjs alone — 5/5 pass, no unhandledRejection this run

```
cd plugins/dsh-fleet
node --test test/fleet.fake.test.mjs
```

Three consecutive isolated runs: all **pass 5 / fail 0 / EXIT=0**. No `unhandledRejection` / ENOENT rename in captured output (also none after a 3s post-runner wait on the first attempt).

Log: `logs/fleet-fake-isolated.log`

This matches the analysis isolated result. It does **not** prove the late ledger-rename ENOENT is gone: that showed up in the full `test/*.mjs` suite when the process stayed alive after `test.after` deleted the temp dir. Isolated 5/5 is the unstable/green face of the same race.

## 3. vendor-diff.sh — STILL FAILS (live HEAD vs pin)

```
cd frontend
sh scripts/vendor-diff.sh
```

- VENDOR_DIFF_EXIT=**1**
- Upstream checkout HEAD: `b150a551b8` (`Merge pull request #2908 … release/dsh-0.1.1-rc.2`)
- Pin (`frontend/UPSTREAM.pin`): `a66e470204` (`0.1.2-rc.1`)
- Script diffs `$HOME/Projects/deepseek-harness` current tree, not the pin object
- Log: `logs/vendor-diff.log` (2626 lines)

This is a **baseline mismatch**, not proof the running host is protocol-incompatible. Do not move the pin or overwrite vendor to “make diff green.”

## 4. test-all.sh grep-masking — STILL PRESENT

`scripts/test-all.sh` is zsh with `set -u` only (no `pipefail`). Line 7:

```
(cd "$ROOT/frontend" && npm run verify 2>&1 | /usr/bin/grep -E '^ℹ (pass|fail)|零漂移|漂移' ) || rc=1
```

Minimal proof (one-liner, did not edit the script):

```
zsh -c 'set -u
(echo "ℹ pass 12"; echo "error: build failed"; false) 2>&1 | /usr/bin/grep -E "^ℹ (pass|fail)|零漂移|漂移"
ps=("${pipestatus[@]}")
print -- "PIPELINE_LAST_EXIT=${ps[-1]}"
print -- "PIPESTATUS=${ps[*]}"
'
```

Result: grep prints `ℹ pass 12`; `PIPESTATUS=1 0`; **PIPELINE_LAST_EXIT=0**.

Same wrapper as the script: `rc=0` (failure swallowed). Control with no match: `rc=1`.

Log: `logs/grep-masking-proof.log`

`scripts/iterate.sh:30` has the same `build | grep` pattern.

## Implementer notes

- **F / farm:** Keep the 100KB prompt. Do not skip/shorten/raise-timeout-only. Fix `SECRET_PATTERNS` `\S{3,}` / `highEntropyToken` on long *non-matching* runs (that is the slow path). Classifier vs scrubber disagree on `密码：键*` — classify true, scrub unchanged.
- **C / fleet.fake:** Do not treat isolated 5/5 as a fix. Repro the late ENOENT by keeping the process alive or running the full fleet suite. Do not swallow `unhandledRejection`.
- **K / vendor-diff:** Scope the diff to the pin object, not live `~/Projects/deepseek-harness` HEAD. Do not update the pin this round.
- **K / test-all:** Preserve the failing command’s exit. `pipefail` or capture-then-check (the plugin loop already captures `out`). A grep hit on `ℹ pass` must not yield 0.
