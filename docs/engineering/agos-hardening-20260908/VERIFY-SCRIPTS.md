> Historical implementation-stage record. Superseded by [final verification](VERIFICATION.md) and REVIEW.md. Old counts, pending items and script descriptions below are not current acceptance claims. Early raw logs are intentionally not published.

# VERIFY-SCRIPTS — worker K (2026-09-08)

Owner files: `scripts/test-all.sh`, `scripts/iterate.sh`, `frontend/scripts/vendor-diff.sh`.
Self-test: `scripts/test-all-selftest.sh`.
Does not rewrite TASKS/BASELINE. Does not move `frontend/UPSTREAM.pin`. Does not overwrite `frontend/src/contract/`.

## Exit-code rule

`test-all.sh` and `iterate.sh` used `cmd | grep`. Without `pipefail`, the pipeline status was grep's. A failing `npm run verify` / `npm run build` that still printed `ℹ fail` or `error` looked green.

Fix: `agos_keep_exit` captures the producer, filters for display, returns the producer status. Empty grep does not fail a successful command. `setopt PIPE_FAIL` is extra, not the source of truth.

Do not run `iterate.sh` itself in this round (it deploys and may `pkill` 3091). Syntax-check + helper extract only.

## vendor-diff: pin object, not live HEAD

Analysis compared `~/Projects/deepseek-harness` HEAD `b150a551b8` to pin `a66e470204`. That red is a false baseline: live apiproxy uses `/api/events.mux`; pin 0.1.2-rc.1 wire is `/api/remote.mux`.

`vendor-diff.sh` now:

1. Parse SHA + version from `frontend/UPSTREAM.pin`.
2. Require `git cat-file -e <pin>^{commit}` in `$DEEPSEEK_HARNESS` (default `~/Projects/deepseek-harness`). Missing object/repo → **exit 2**, `environment unsatisfied`, names the pin SHA. Read-only `git show` / `git archive`. Never `checkout` the user's harness.
3. Require pin `package.json` version == pin file version (`0.1.2-rc.1`).
4. Print worktree HEAD as **not compared**.

### BYTE_EQUAL vs versioned adapters

Pin `a66e470204` has **no** `packages/host/apiproxy/src/api` (that tree is later). The membrane is not a dump of the live tree.

| Class | Paths | Rule |
|---|---|---|
| BYTE_EQUAL wire | pin `packages/api/gateway/src/stream-protocol.ts` (fallback: pin `packages/host/apiproxy/src/api/rpc.ts`) vs `frontend/src/contract/api/rpc.ts` | These `export const` values must match: `REMOTE_STREAM_MUX_PATH`, `REMOTE_EVENT_STREAM_ENDPOINT`, `REMOTE_EVENT_RESULT_ENDPOINT`, `REMOTE_EVENT_STREAM_PAYLOAD` |
| BYTE_EQUAL tree | pin `packages/host/apiproxy/src/api/*.ts` ∩ vendored, **minus** adapters | Only if that tree exists **at the pin**. `diff -q` must be empty |
| VERSIONED ADAPTERS | the 19 files under `frontend/src/contract/api/` listed in `ADAPTER_FILES` | Lean AgOS membrane. Not byte-equal to pin packages. Frozen allowlist: add/remove fails until the list in `vendor-diff.sh` is updated |
| PIN_ONLY | host apiproxy files the membrane does not ship (`approvals`, `downloads`, `events`, `goals`, `host`, `jobs`, `questions`, `subagents` + schemas) | Only enforced when the pin has apiproxy. A new host file must be listed here or vendored |

Getting green by rewriting vendored files, moving the pin, ignoring extras, or `exit 0` is forbidden. Green means the pin object was found and the rules above held.

## Docs facts (this tree)

- Transport: **`/api/remote.mux`**. README `/api/events.mux` was stale. One route name ≠ one physical socket: the client opens one WebSocket per logical stream.
- Replay: `npm run replay` is fold invariants over `AGOS_CORPUS` (historical default `~/.dsh/sessions-trash-20260820`, 392 sessions). **Not** in `npm run verify` or `test-all.sh`. Missing corpus ≠ pass. UI `ReplayScrubber` only `items.slice` on the folded snapshot; it does not rebuild tool/stream state. Do not copy “392 sessions passed”.
- `cn-capabilities` **registers 19 tools**, not 21 (`lib/index.js` comments still say 21; that file is not K-owned): `see_video`, `read_screenshot_text`, `diagnose_screenshot`, `read_diagram`, `read_chart`, `ui_to_code`, `ui_diff`, `see_image`, `speak`, `generate_image`, `delegate_task`, `council`, `plan_run`, `council_stats`, `opencli_browser`, `opencli_run`, `autoresearch`, `swarm_run`, `codexbar_usage`. `plugin:civ-plan-appendix` is an event name, not a tool.
- External deps (deck consumes, this repo does not ship): host unary + `/api/remote.mux`; swarm `/api/swarm/*`; trace `/api/trace/sessions`; memory `/api/memory/*`; mode-alignment audit JSONL; optional host `memory_submit`; local usage cache.
- Check scope: `frontend` `verify` = `upgrade:dsh:check` + typecheck + tests + build + `vendor:diff`. `test-all.sh` adds five plugin `node --test` suites + `deploy-plugins.sh --check`. Not in that gate: replay, smoke, OpenCLI browser, iterate write/restart. No tracked `.github/workflows`.

## Public-entry wiring

- `frontend/package.json` `vendor:diff` already calls `sh scripts/vendor-diff.sh`. No pin/package.json edit.
- `test-all.sh` / `iterate.sh --test` keep calling the same paths; only exit-code plumbing changed.
- `upgrade-dsh.sh --check` is version-only and was left as-is. `--upgrade` still checkouts the harness and rewrites the pin — out of scope; do not run it.
- Chat UI / `SessionsView` still say `events.mux` (E/G-owned). Transport contract is `remote.mux`.
- `frontend/README.md` still says “286 tests” (actual frontend suite at analysis: 306). Not K-owned.

## How to run K tests

```bash
zsh scripts/test-all-selftest.sh
# do not: scripts/iterate.sh, npm run verify, deploy write, dsh restart
```
