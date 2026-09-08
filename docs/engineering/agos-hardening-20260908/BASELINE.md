# BASELINE — AgOS hardening 2026-09-08

Recorded: 2026-09-08 18:49 Asia/Shanghai
Worktree: `/Users/leo/Projects/agos-cursor-hardening-20260908`
Branch: `cursor/agos-hardening-20260908`
Original checkout (read-only): `/Users/leo/Projects/agos` @ `main`

## SHA

- Worktree HEAD: `24bc17e6892839190563defe15ec4ed4b573e934`
- Original checkout HEAD: `24bc17e6892839190563defe15ec4ed4b573e934`
- Analysis baseline: `24bc17e6892839190563defe15ec4ed4b573e934`
- Attribution: current HEAD **is** the analysis SHA. Line numbers in the source report are clues, not instructions.

## Host / toolchain

- Node: `v26.7.0`
- npm: `11.19.0`
- Machine: darwin arm64
- Root `node_modules`: symlink → `/Users/leo/.dsh/profiles/node_modules` (read-only use)
- `frontend/node_modules`: symlink → `/Users/leo/Projects/agos/frontend/node_modules` (read-only use)
- Plugin packages have no local `node_modules`; they resolve through the DSH profile tree.

## Original verification (analysis dir)

Source: `/Users/leo/Projects/agos-analysis/2026-09-08/verification-results.json`

| Check | Exit | Notes |
|---|---:|---|
| frontend-typecheck | 0 | `tsc --noEmit` |
| frontend-tests | 0 | 306 pass |
| host-version | 0 | pin and installed both `0.1.2-rc.1` |
| vendor-diff | 1 | compared live `~/Projects/deepseek-harness` HEAD `b150a551b8` vs pin `a66e470204` |
| deploy-drift | 0 | ten copies, zero content drift (pre-fix) |
| dsh-agos | 0 | 122 pass |
| dsh-agos-router | 0 | 78 pass |
| dsh-mcp-bridge | 0 | 4 pass |
| cn-capabilities | 0 | 29 pass |
| dsh-fleet | 1 | 112 pass / 2 fail (farm 100KB + fleet.fake unhandledRejection) |

## Confirmed-still-present at start of this worktree

Verified by reading current files at HEAD, not by re-running the original product services:

- Autoresearch still `git add -A && git commit` then `reset --hard HEAD~1 && git clean -fd`; metric is first number (`cn-capabilities/lib/index.js`).
- `planPathOk` only checks basename regex; `plan_run` treats `planFile` + `approve:true` as enough.
- Local Fleet `probeRun` still returns `{ ok: true, out: 'MISSING' }` for `kind === 'local'`.
- Ledger `appendMany` is in-process `writeTail` + read-modify-rename, no cross-process lock.
- `ApprovalPanel` sets resolved before `respondApproval`; `respondApproval` voids the POST and deletes the map immediately.
- `SECRET_PATTERNS` still has unbounded `\S{3,}` after a 0–8 char separator; `highEntropyToken` scans every 24+ token.
- `live.ts` snapshot ignores `header/hasMore/projections`; no `session/page` client.
- `bindCatalogTrim` ranks `catalogOf(event)` then `rewriteCatalogDecision` keeps only shortlist names; project entries vanish if they were never candidates.
- `consensus = !!parsed && disagreements.length === 0` — `{}` yields consensus true.
- `turn-evidence.record` writes memory first, swallows disk errors, no durable flag, no turn/step bind.
- `test-all.sh` and `iterate.sh` pipe build/verify through grep without `pipefail`.
- `vendor-diff.sh` diffs `$HOME/Projects/deepseek-harness` current checkout, not the pin object.

## Out of scope this round

Whole-architecture rewrite, UI redesign, automatic learning expansion, production deploy, iterate/deploy write mode, restarting user DSH/Cursor, real paid models, real MCP writes, machine wake/sleep.
