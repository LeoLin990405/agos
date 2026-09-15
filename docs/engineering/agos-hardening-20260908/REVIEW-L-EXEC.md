> Historical Cursor phase review. Later fixes and final acceptance supersede these findings; see REVIEW.md.

# REVIEW-L-EXEC — AgOS hardening 2026-09-08

Reviewer: L-exec (execution / persistence), independent, not an author.
Read HEAD: `24bc17e6892839190563defe15ec4ed4b573e934`
Read date: 2026-09-08 18:51 Asia/Shanghai
Scope: A / B / C / D / F / I / J / K
Method: re-read product code at this SHA. Analysis report and `REVIEW.md` are clues, not evidence.

**Phase-1 verdict: no owned helper has landed. Every task is 尚早. Current HEAD defects below are confirmed by file:line, not by author claim.**

Owned helper paths checked on disk after the phase-1 read (0 hits):

- `plugins/cn-capabilities/lib/autoresearch-workspace.mjs`
- `plugins/cn-capabilities/lib/autoresearch-metrics.mjs`
- `plugins/cn-capabilities/lib/plan-approval.mjs`
- `plugins/cn-capabilities/lib/plan-path.mjs`
- `plugins/dsh-fleet/lib/local-probe.mjs`
- `plugins/dsh-fleet/lib/fleet-lock.mjs`
- `plugins/dsh-agos/lib/input-limits.js`
- `plugins/cn-capabilities/lib/council-parse.mjs`
- `plugins/dsh-agos-router/lib/feedback-bind.mjs`

`plugins/dsh-agos/lib/secrets-gate.js` exists and is the current production scrubber (F-only exclusive). It is the defect, not a fix.

---

## 触发条件与代码位置

### A — autoresearch 回滚范围 / 提交退出码

**Trigger (dirty tree).** `autoresearch.execute` never inspects `git status`. It runs in `args.cwd` or `$HOME/Projects/OpenCLI` (`plugins/cn-capabilities/lib/index.js:2414`). Each iteration does `git add -A && git commit -m "autoresearch iter N" --allow-empty -q` (`:2488`). User-dirty files in that cwd are staged and can be committed as an iteration.

**Trigger (failed commit then rollback).** `runCmd` (`:2425–2441`) returns `{ exit, text }` and never throws. Callers ignore `exit`. If `:2488` fails (not a repo, missing identity, index lock, hook), HEAD is unchanged. The “no improvement” branch still runs `git reset --hard HEAD~1 -q && git clean -fd -q` (`:2497`). That moves the **caller’s last real commit** back one step and deletes untracked files.

**Trigger (failed verify / cancel).** Metric is the first `(-?\d+(?:\.\d+)?)` in combined stdout+stderr (`:2444–2446`). A banner, elapsed-ms, or “exit 1” before the real score flips `improved`. `exec.signal` is passed to spawn (`:2435`) but the rollback command is a separate spawn with the same signal; a cancelled iteration can still hit `:2497` if the commit spawn already finished.

**Failure condition.** Caller cwd and caller HEAD are not byte-identical after a failed/no-improve/cancel path. `scope` (`:2418`) is prompt text only (`:2460–2468`); it is not a git pathspec.

**Existing tests.** None. `plugins/cn-capabilities/test/` has no autoresearch case. Current 29 cn-capabilities tests cannot regress this.

### B — plan approval is a request field, not a host event

**Trigger (`approve:true` + `planFile`).** Stage-2 gate is `args.approve !== true` (`:1898–1901`). The `approvedAt` check is wrapped in `if (!planFromFile)` (`:1906–1917`). `planFromFile` is set whenever `args.planFile` passed `planPathOk` and `readFile` parsed JSON (`:1859–1873`). Therefore:

`{ approve: true, planFile: "<PLAN_DIR>/plan-<digits>.json" }` executes **without** `approvedAt`, session bind, or host approval event.

This is not a hypothetical. `plugins/cn-capabilities/test/plan-run.fake.test.mjs:318–337` first stages a bare JSON plan (correctly refused), then **requires** that the same file execute on `planFile + approve:true`. That test encodes the hole.

**Trigger (invented `approvedAt`).** Bare JSON can still execute if `findMatchingPlanFile` (`:1785–1794`) finds any unread `plan-*.json` whose `stepsSignature` matches and `obj.approvedAt` is truthy (`:1907–1908`). `approvedAt` is a file field written by this plugin / `/api/cn/plans` POST (`:435–437`). Anyone who can write `PLAN_DIR` can mint it. There is no host `permission` / `exit_plan_mode` event check on the execute path.

**Trigger (symlink).** `planPathOk` (`:372–378`) only checks `^plan-\d+\.json$` and string equality with `PLAN_DIR + '/' + base`. No `realpath`, no `O_NOFOLLOW`, no `lstat`. `plan_run` `readFile(planFile)` (`:1871`) and POST `/api/cn/plans` `writeFile(target)` (`:437`) follow a symlink whose basename is legal.

**Failure condition.** A model or HTTP client can start swarm execution without a host-backed approval bound to this session, this plan fingerprint, and this file inode.

### C — live local fleet run marked `lost` on reconcile

**Trigger.** Production probe (`plugins/dsh-fleet/lib/index.js:894–900`):

```
if (host.kind === 'local') return { ok: true, out: 'MISSING' }
```

`parseProbeReply` maps `MISSING` → `{ kind: 'lost' }` (`plugins/dsh-fleet/lib/fleet-runtime.mjs:25`). `_reconcileRun` (`:560–593`) then `_appendAndApply({ ev: 'reattach', state: parsed.kind })` (`:591–592`).

`isLocalExecution` and `hasLiveController` **are** wired (`index.js:933–934`) and used in `cancelRun` (`fleet-runtime.mjs:406–420`). They are **not** consulted in `_reconcileRun`. Codex uses `LIVE_RUNS` in the same probe (`index.js:901`); local does not.

Reconcile runs once at hydrate (`index.js:966`) and then every `DEFAULT_RECONCILE_INTERVAL_MS` (30_000, `fleet-runtime.mjs:8`) via `startReconciler` (`index.js:975`).

**Failure condition.** A local `running` run that is still in this-process `LIVE_RUNS` / still has a controller, after ≥1 reconcile tick (or the boot `reconcileOnce` if the run was already `running`), becomes terminal `lost`. `markEnd` afterwards no-ops (`fleet-runtime.mjs:383`). The in-process subagent keeps working. The slot is released.

Restart orphans becoming `lost` is the intended leftover comment at `index.js:897–899`. The bug is that the same probe is used for **live** local runs.

**Existing tests.** `reattach.test.mjs:58–63` asserts `MISSING → lost` as the general map. `reattach.test.mjs:218–236` covers local **cancel**, not local **reconcile**. No test holds a live local run across a tick.

### D — two Node processes, one ledger, lost update

**Trigger.** Default path is `~/.dsh/logs/fleet/runs.jsonl` (`fleet-ledger.mjs:7`). Serialization is `this.writeTail` (`:99`, `:125–128`) — one instance, one event loop.

`appendMany` (`:155–184`) and `_compactUnlocked` (`:216–238`) do read-whole → write tmp → `rename`. Two processes:

1. P1 `appendMany` reads file A.
2. P2 `append` / `appendMany` publishes event E.
3. P1 `rename` publishes A+batch, dropping E.

`append` itself is O_APPEND (`:131–137`) and is safer alone; it is still overwritten by the other process’s rename. Compact has the same race.

**Failure condition.** After two concurrent writers, `load()` is missing at least one accepted event (dispatch/start/end). Batch atomicity for one process is not a cross-process lock.

**Existing tests.** `ledger.test.mjs` is single-process: in-process `writeTail` chain (`:47`), compact, and `appendMany` ENOSPC rollback (`:99–120`). No second `node` process. No lock file.

### F — long / near-match / unicode scrub blocks the loop

**Trigger 1 (fleet_run tool, no cap).** HTTP dispatch caps items at 8000 chars (`fleet-dispatch.mjs:6, :58–59`). `fleet_run` does not (`index.js:661–664`): `items` are `String(x).trim()` and become `prompt` unchanged. `eventForDisk` calls `scrubSecrets(input)` **before** clipping prompt to 400 (`fleet-ledger.mjs:25–29`). A 100KB item is walked on the ledger path.

**Trigger 2 (quadratic `scrubString`).** `secrets-gate.js:54`:

```
/([A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD)\s*=\s*)(?:"[^"]*"|'[^']*'|\S+)/gi
```

On a long run of `x` (the farm fixture), `[A-Z0-9_]*` eats the suffix, the keyword fails, and `/g` restarts one byte later → ~n². This is the 4K/8K/16K/32K/100KB growth the analysis timed; I did not re-bench, but the regex is still that shape at HEAD.

**Trigger 3 (classifier, unicode near-match).** `SECRET_PATTERNS[1]` (`secrets-gate.js:10`) ends with `{0,8}\S{3,}` after a CJK/ASCII separator class. `classifySecret` / `isSensitiveText` (`:38–47`) run this plus `highEntropyToken` (`:18–35`, every `[A-Za-z0-9+/_=-]{24,}` token). Callers: session-memory persist, router `sanitize.js`. Same shared module fleet imports.

**Trigger 4 (already-failing test).** `farm-integration.test.mjs:263–310` sends `items: ['x'.repeat(100 * 1024)]` and `waitUntil(..., default 2000ms)` (`:10, :308–310`). If scrub occupies the event loop for seconds, detach is not observed in budget. Raising only that timeout is not a fix.

**Failure condition.** Same redaction on 100KB, near-match, and unicode; growth linear-ish; `fleet_run` rejects over-cap input the same way HTTP already does. Event loop must remain able to fire timers / observe detach inside the existing 2s farm budget.

### I — arbiter `{}` / missing fields counted as agree

**Trigger.** `parseVerdict` (`cn-capabilities/lib/index.js:1610–1623`) returns the first balanced `{...}` JSON value. `{}` parses. Then:

- `disagreementsFromParsed` (`council-record.js:61–64`): `!Array.isArray(parsed.disagreements)` → `[]`
- `consensus = !!parsed && disagreements.length === 0` (`index.js:1641`) → **true**
- `parsedOk: !!parsed` (`index.js:1657`) → **true**
- `councilReviewVerdict` (`council-record.js:71–74`) prints `各家一致。结论:`

Missing `disagreements` / `consensus` / `conclusion` is treated as “parsed and no disagreements,” not as parse failure. `{ consensus: true }` with no `disagreements` key is the same. `{ consensus: false }` with no `disagreements` array still yields `consensus=true` because the boolean field is ignored.

`<2` valid panelists is already `inconclusive` + `parsedOk:false` (`index.js:1556–1582`). That branch is fine. The hole is **arbiter JSON that is an object but not a verdict**.

**Existing tests.** `council-record.test.mjs` covers object-array disagreements and parse-null. It does **not** feed `{}` through the production formula in `index.js:1641`.

### J — client `source`, missing ref, persist ≠ observe

**Trigger (client `source`).** `POST /api/agos/routes/outcome` (`dsh-agos-router/lib/index.js:523–530`) → `recordOutcome(body)` (`:301–311`) → `buildOutcomeRecord(body)` (`ledger.js:184–198`). `source` is `sanitizePreview(client string) || 'manual'`. Server does not overwrite. A client can send `source: 'fleet-end'` or `'reviewer-verdict'` on a non-shadow ref. Shadow refs reject manual writes (`index.js:305–308`); ordinary refs do not check that `ref` exists as a decision id.

**Trigger (shadow-link).** `shadowLink` (`index.js:248–251`) appends `buildShadowLinkRecord` (`shadow.js:154–161`). Checks: `dec-…` regex, `b-…` regex, host name regex. No proof the decision exists, that the batch exists, or that the task/hosts apply. `hosts: []` is allowed.

**Trigger (disk fail / no turn bind).** `createTurnEvidenceStore.record` (`turn-evidence.js:41–59`) writes `bySession` first, then `appendFileSync` in `try/catch` that swallows. `describeTurnEvidence` (`:146–162`) sets `collected: row !== undefined`. In-memory-only is reported as collected. No `persisted` / `persistError`. `record()` has no `turn` / `step` argument. Callers (`session-memory-inject.js:156,183,200`, `skills-evolve.js:507–508`) pass `{ memory }` / `{ skills }` only. GET `/api/agos/turn-evidence` (`dsh-agos/lib/index.js:1588–1591`) returns that view. Two lanes merge by `sessionId`; a later record replaces the previous memory object (`turn-evidence.js:45–51`) without a host turn key.

**Failure condition.** Observer can distinguish persist vs memory. Missing host turn/step stays uncollected — never invented. Feedback `source` is server-assigned. Duplicate `(ref, result, source)` is idempotent; conflicting result is rejected. Unused shadow suggestion stays unknown.

**Existing tests.** `turn-evidence.test.mjs:88–103` reloads last row from disk (happy path). No EIO / ENOENT persist flag. `shadow.test.mjs:238` only blocks manual outcome on **shadow** rows.

### K — failing command piped to grep

**Trigger (`test-all.sh`).** `set -u` only (`scripts/test-all.sh:3`). Line 7:

```
(cd "$ROOT/frontend" && npm run verify 2>&1 | /usr/bin/grep -E '^ℹ (pass|fail)|零漂移|漂移' ) || rc=1
```

zsh pipeline status is the last command unless `pipefail`. `frontend` `verify` is `upgrade:dsh:check && typecheck && test && build && vendor:diff` (`frontend/package.json:13`). A late failure (vendor:diff, build) still emits earlier `ℹ pass` lines. grep exits 0 → `rc` stays 0.

Plugin loop (`test-all.sh:10–12`) greps `^ℹ fail 0` from captured output and is stricter. The frontend pipe is the hole.

**Trigger (`iterate.sh`).** Same pattern (`:11` `set -u`; `:30`):

```
(cd "$ROOT/frontend" && npm run build 2>&1 | /usr/bin/grep -E 'built in|error') || { ... exit 1; }
```

A failed build that still prints `error` makes grep succeed. A failed build that only prints `built in` from a previous cached line (or Vite printing both) can also hide the exit.

**Trigger (`vendor-diff.sh`).** Prints `UPSTREAM.pin` (`:7`) then diffs `$HOME/Projects/deepseek-harness` **current checkout** (`:5, :8`), not the pin object. Baseline already recorded this as exit 1 vs pin `a66e470204`.

**Failure condition.** Non-zero child exit is the script exit. grep is display-only. vendor:diff compares vendored contract to the **pin** tree, not an arbitrary checkout HEAD.

---

## 验收矩阵补强

`REVIEW.md` opening row stays. What a worker must prove, and how they will try to fake it:

| ID | Concrete must-prove (not restating the slogan) | Fake-green I will reject |
|---|---|---|
| A | Fixture: dirty tracked + untracked file in a temp git repo used as `cwd`. After failed commit / NaN metric / `signal.abort` / no-improve: `git rev-parse HEAD` and `git status --porcelain` equal the pre-call snapshot. Improve path only mutates an isolated worktree whose baseline SHA was recorded. `extractStructuredMetric` refuses the first loose number when a labeled field exists. `runCmd` / git wrappers throw or return `ok:false` on non-zero; rollback is not reached. | Disable the tool; stub `runCmd` to never call git; assert only that `report` contains “已回滚”; `git reset` against a throwaway clone that started empty; skip dirty-tree case; treat `--allow-empty` commit as “safe”. |
| B | `evaluatePlanApproval` / execute path: `approve:true` alone → refuse. `approvedAt` string in JSON / file → refuse. `planFile` of a file **without** host approval fingerprint → refuse. Happy path needs a host-shaped event (or an explicit `unwired` result that **does not execute**). `openPlanFile` / `resolvePlanPath`: symlink whose basename is `plan-1.json` pointing outside `PLAN_DIR` → reject (ELOOP / EINVAL), no read, no write. Existing `plan-run.fake.test.mjs:337` must be rewritten to expect refuse, not execution. | Keep `:1906` `if (!planFromFile)` skip; helper returns `ok` but `index.js` not wired; delete the fake test instead of flipping it; `lstat` only in tests; treat file existence as approval. |
| C | Test with real interval (or fake clock that advances ≥1 tick): local host, `LIVE_RUNS` / controller present, `status=running` after `reconcileOnce` and after `startReconciler` fire. Slot still counted. After process restart **without** live controller, same durable row becomes `lost` (not `detached` forever). `probeRun` for local must not be the constant `'MISSING'` while `hasLiveController(run)` is true. | `reconcileIntervalMs: 86_400_000`; do not call `reconcileOnce`; stub `probeRun` → `ALIVE` for all local; comment out `startReconciler`; only test cancel; assert “no throw”. |
| D | Two `node` child processes, shared real path, overlapping `append` + `appendMany` + `compact`. Union of events both intended to publish is on disk. Kill -9 holder → stale lock recovered, next writer succeeds, no silent drop. Lock file beside ledger; `append` / `appendMany` / `compact` all take it. Old JSONL still loads. | Two sequential awaits in one process; in-memory mutex only; lock that is `try/finally` without `O_EXCL` / pid / mtime; skip compact vs append; mock `fs.rename` so the second writer never runs; `t.skip` multiprocess on darwin. |
| F | Bench: 100KB `x` repeat, 100KB near-match (`TOKEN` + long `\S`), and CJK separator + unicode. Redaction **equal** to today’s short-string cases (same `«redacted»` sites). Time vs 4KB grows ~linear (reject ≥ n^1.6 over that span, or a hard ms cap well under 2s for 100KB). `fleet_run` rejects the same over-cap item HTTP already rejects. Farm 100KB test still uses **2000ms** `waitUntil` and passes. | Only raise `waitUntil` / test timeout; delete the 100KB test; `SECRET_PATTERNS = []`; `scrubSecrets = (v) => v`; bench 1KB; assert `ok:true` without timing; cap only in HTTP, leave the tool uncapped. |
| I | Table: `{}`, `{reason:"x"}`, `{consensus:true}`, `{consensus:false}`, `{disagreements:null}`, `{disagreements:[]}` with `<2` valid panelists already covered. First four → `parsedOk=false`, `consensus=false`, not “各家一致”. Helper **and** `index.js` execute path. Ledger row must not increment seasoned `okRate` as a successful agree. | Unit-test helper only; `index.js:1641` left as `!!parsed && length===0`; special-case `JSON.stringify(parsed)==='{}'` and leave missing-field objects green; treat empty `disagreements` as agree when `consensus` key is absent. |
| J | Persist fail (readonly dir / injected `appendFileSync` throw): GET/describe shows `observed=true` (or memory view present) **and** `persisted=false` + `persistError`. Host event with `turn`/`step` → stored; host event without → uncollected, **no** `turn:1` default. `POST /outcome` with `source:'fleet-end'` from client → stored source is server `manual` (or rejected). Missing decision id → 4xx. Duplicate same `(ref,result,source)` → 200 idempotent; conflicting result → 409. shadow-link to unknown dec / unknown batch / other task → reject; unused suggestion stays `outcome:null`. | Invent `turn` from `Date.now()` or `events.length`; only test happy-path reload; swallow persist and still `collected:true` with no flag; accept any `source` that matches `/^[a-z-]+$/`; skip conflict test; link-format-only tests (already exist). |
| K | A child script `exit 1` that prints `ℹ pass 1` and `零漂移` → `test-all.sh` exit ≠ 0. A `vite`/`tsc` fake that prints `built in 10ms` then `exit 1` → `iterate.sh --no-test` (build branch) exit ≠ 0. `vendor-diff.sh` against a checkout whose HEAD ≠ pin, while pin tree matches vendored → exit 0. Reverse: pin tree differs → exit 1 even if checkout HEAD matches vendored. | `set -o pipefail` but grep the whole log for `.` ; `\|\| true`; skip vendor:diff when `DEEPSEEK_HARNESS` missing (exit 0); compare to whatever is on `main`; document “known flake”. |

---

## 已落地代码的质疑（如有）

No new owned helpers are on disk. Nothing to approve.

Current production files that look like “already handled” and are not:

1. **B `plan-run.fake.test.mjs:318–337`** — this is a regression **lock-in**, not coverage. An author who “keeps tests green” while leaving `if (!planFromFile)` will stay green. Fail the task until that test expects refuse.
2. **C `isLocalExecution` / `hasLiveController` (`index.js:933–934`)** — cancel-only. Do not accept a helper that “reuses existing hooks” unless `_reconcileRun` (`fleet-runtime.mjs:560`) actually reads them.
3. **C `index.js:897–899` comment** — “orphan → lost” is correct for **restart**. It does not justify constant `MISSING` for live local.
4. **D `writeTail` + `appendMany` atomic comment (`fleet-ledger.mjs:150–153`)** — single-writer disk-full safety. Not a lock. A helper that only wraps `_enqueue` is not D.
5. **I `disagreementsFromParsed` object-array fix (`council-record.js:16–22`)** — stops `{disagreements:[{point:'…'}]}` from collapsing to agree. It does **not** stop `{}` or missing `disagreements` from collapsing to agree. Do not cite TASK-018 as I-done.
6. **J `turn-evidence.test.mjs` “does not invent a turn” (`:88`)** — means “does not invent a session.” There is still no turn/step field in the store.
7. **F `secrets-gate.js` already shared** — good exclusive path. The exclusive file is still quadratic / unbounded. Shipping `input-limits.js` without changing `scrubString` / `SECRET_PATTERNS[1]` / `fleet_run` is not F.
8. **K plugin `fail 0` grep (`test-all.sh:12`)** — do not claim K done because plugins already check `fail 0`. Frontend verify/build pipes remain last-command-wins.

---

## 结论（按任务：通过/打回/尚早）

| ID | 结论 | 理由 |
|---|---|---|
| A | **尚早** | Defect sat at `index.js:2488,2497`. No workspace/metrics helper, no test. Unproven. |
| B | **尚早** | Defect sat at `index.js:1906–1917` + `planPathOk:372–378`. Existing fake test **requires** the bypass. Unproven. |
| C | **尚早** | Defect sat at `index.js:900` + `fleet-runtime.mjs:25,591`. Hooks exist and are unused by reconcile. Unproven. |
| D | **尚早** | Defect sat at `fleet-ledger.mjs:99,159–175`. No lock file, no two-process test. Unproven. |
| F | **尚早** | Defect sat at `secrets-gate.js:10,54` + uncapped `fleet_run:661–664`. Farm 100KB still 2s budget. Unproven. |
| I | **尚早** | Defect sat at `index.js:1641` + `council-record.js:61–64`. `{}` → agree. Helper not on disk. Unproven. |
| J | **尚早** | Defect sat at `turn-evidence.js:52–59`, `ledger.js:197`, `shadow.js:154–161`. No persist flag, no server source, no turn bind. Unproven. |
| K | **尚早** | Defect sat at `test-all.sh:7`, `iterate.sh:30`, `vendor-diff.sh:5–8`. Scripts unchanged. Unproven. |

I do not approve any of A–D / F / I–K. “Author said pass” is not a signal. Re-read landed helpers against the fake-green column before any later 通过.

---

## Phase 2 — helpers on disk (2026-09-08 18:59 Asia/Shanghai)

HEAD still `24bc17e`. Helpers and some owned production files are uncommitted. `plugins/cn-capabilities/lib/index.js` and `plugins/dsh-agos-router/lib/index.js` are **unchanged**. `plugins/dsh-fleet/lib/index.js` still contains the old local `MISSING` line; reconcile no longer uses it for local (see C).

### A — 尚早(未接线)

Helpers `autoresearch-workspace.mjs` / `autoresearch-metrics.mjs` + `test/autoresearch-workspace.test.mjs` exist. Isolated clone, `git add --` allowlist only, `extractStructuredMetric` refuses first-number, `disposeWorkspace` checks `originalIntact`. Tests dirty a caller repo and assert porcelain/HEAD unchanged.

**Production still old.** `cn-capabilities/lib/index.js:2488` is still `git add -A && git commit … --allow-empty`; `:2497` is still `git reset --hard HEAD~1 && git clean -fd`. No import of the helper.

**Trigger that still fires today:** dirty caller cwd + no-improve → caller HEAD~1.

### B — 尚早(未接线)

`plan-approval.mjs` / `plan-path.mjs` + tests are real: `approve:true` / `approvedAt` → `UNAPPROVED`/`UNWIRED`; symlink leaf → `SYMLINK` (`plan-path.test.mjs:67–81`).

**Production still old.** `index.js:1906–1917` still skips `approvedAt` when `planFromFile` is set. `planPathOk:372–378` still used by `plan_run` and `/api/cn/plans`. `plan-run.fake.test.mjs:337` **still requires** `planFile + approve:true` to execute; `:370–386` only documents that the helper is unwired. That is honesty, not a fix.

**Trigger that still fires today:** `{ approve:true, planFile: "<PLAN_DIR>/plan-<n>.json" }` with no host `exit_plan_mode` pair.

### C — 通过

`fleet-runtime.mjs` is a production file. `_reconcileRun` (`:595–601`) uses `_probeReplyFor` **before** injected `probeRun`. Local → `probeLocalRun` + `heldLocalRuns` (added on non-hydrate `start`, `:242–243`; cleared on hydrate `:260`). Injected `MISSING` cannot settle a held local run (`local-lifecycle.test.mjs:135–147`). Two short ticks (`:94–133`); default period still 30s (`:65–68`). Restart orphan → `lost` (`:150–165`). Timeout ends `TIMEOUT` once, not cancel (`:190–221`).

`index.js:900` (`if (host.kind === 'local') return { ok: true, out: 'MISSING' }`) is leftover. It is not the local reconcile path anymore. Fake-green I looked for (lengthen period, skip `reconcileOnce`) is not what these tests do.

**Concrete trigger now closed on the runtime path:** live local `running` + `reconcileOnce` ×2 + injected `MISSING` → still `running`, slot held.

### D — 通过

`createFleetLedger` (used by fleet `index.js`) now constructs `FleetLock` at `<ledger>.lock` (`fleet-ledger.mjs:102–108`). `append` / `appendMany` / `compact` all go `_enqueue` → `_withLock` (`:159–174`, `:256–258`). `ledger-multiprocess.test.mjs` spawns two real `node` workers; asserts every `ref`/`runId`; kill -9 holder then recover; live holder not stolen (`:218–234`).

Residual: untracked `plugins/dsh-fleet/undefined.lock` on disk (lock path of `undefined`). Hygiene, not a missing lock.

**Concrete trigger now closed:** two processes, shared path, `append` vs `appendMany` — union of dispatches present.

### F — 通过 (residual: input cap unwired)

`secrets-gate.js` **is** the exclusive production scrubber (fleet ledger already imports it). Keyword scan is linear (`:119–130`); `scrubString` is `indexOf` walks (`:225–308`); `SECRET_PATTERNS[1]` suffix capped `{3,256}` and is **not** used by `classifySecret` (structural list skips it). Tests: 100KB identity (`secrets-gate.test.mjs:97–104`), near-match (`:59–72`), CJK (`:75–82`), same short-string redaction (`:30–39`). Bench keeps 100KB and `totalMs < 2000` (`secrets-gate-bench.mjs:37–38`).

**Not wired:** `input-limits.js` is unused by `fleet_run` (`index.js:661–664`) and `fleet-dispatch.mjs` still has its own 8000 copy. 100KB tool items are still accepted; they should no longer pin the loop.

Fake-green watch: bench skips the 16K→100KB ratio when mid `< 4ms` (`:42–45`). Hard 2s cap still required; I do not treat the skip as a pass by itself.

**Concrete trigger now closed on the scrub path:** 100KB `x` + `TOKEN`/`密码` near-match — classify/scrub finish inside the farm 2s budget; redaction matches the short cases.

### I — 打回

Helper `council-parse.mjs` is correct: `{}` → `parsedOk=false`, `consensus=false` (`council-parse.test.mjs:38–46`). They also **changed production** `disagreementsFromParsed` (`council-record.js:70–73`) to return `undefined` when the key is missing.

`index.js` is **not** switched to `evaluateCouncilStructure`. Review path is still:

```
1635  disagreements = disagreementsFromParsed(parsed)
1641  consensus = !!parsed && disagreements.length === 0
```

Arbiter `{}` now does `undefined.length` → **TypeError**, not “unknown”. Vision path `:882` still does `parsedOk && disagreements.length === 0` via `normalizeDisagreementItems` (missing → `[]` → agree).

**Concrete trigger:** council arbiter text `{}` with ≥2 valid panelists. Helper says refuse; production either throws (review) or still agrees (vision). Do not land `council-record.js` this way without wiring `index.js`.

### J — 尚早(未接线)

`turn-evidence.js` (imported by agos GET `:1588–1591`) now has `observed`/`persisted`/`persistError` and will not invent turn (`turn-evidence.test.mjs:107–125`, persist fail `:150–169`). That store API is live.

Callers are not: `session-memory-inject.js` still `evidence.record(sessionId, { memory })` — no `bindEvidencePatch`, no host turn. `skills-evolve.js` still `evidence.record(sessionId, { skills })`.

`feedback-bind.mjs` + tests cover forged `source:'fleet-end'`, missing ref, conflict. **Router `index.js` does not import it.** `recordOutcome` (`:301–311`) still `buildOutcomeRecord(body)` with client `source` (`ledger.js:197`). `shadowLink` (`:248–251`) still format-only.

**Concrete trigger that still fires today:** `POST /api/agos/routes/outcome` `{ ref, result:'ok', source:'fleet-end' }` on a non-shadow row — stored source is the client string.

### K — 通过

`test-all.sh:4–5` / `iterate.sh:12` set `PIPE_FAIL`. `agos_keep_exit` (`test-all.sh:9–26`, `iterate.sh:18–35`) captures producer `rc`, greps with `|| true`, returns producer status. `iterate.sh:58` uses it for `npm run build`. Plugin loop uses `node --test` exit (`test-all.sh:40–45`), not grep-as-status.

`vendor-diff.sh` resolves pin SHA from `UPSTREAM.pin`, `cat-file` that object, prints live HEAD as `not compared` (`:144–149`). Missing pin object → exit 2 (`:131–132`). `test-all-selftest.sh:29–48` reproduces old pipe masking exit 7 as 0, then asserts keep_exit returns 7; `:59–73` missing pin → 2, not 0.

**Concrete trigger now closed:** child `exit 7` that still prints `built in` / `error` → script exit 7.

---

## Phase 2 结论

| ID | 结论 | 一条触发 |
|---|---|---|
| A | **尚早(未接线)** | `index.js:2488/2497` still mutate caller git |
| B | **尚早(未接线)** | `planFile+approve:true` still executes (`plan-run.fake.test.mjs:337`) |
| C | **通过** | live local + two reconcile ticks stays `running` (`fleet-runtime.mjs:595–601`) |
| D | **通过** | two Node writers, one ledger, no lost `ref` |
| F | **通过** | 100KB/near-match/unicode scrub is linear in exclusive `secrets-gate.js` (limits helper still unwired) |
| I | **打回** | `{}` + new `disagreementsFromParsed` vs unwired `index.js:1641` → throw or vision agree |
| J | **尚早(未接线)** | client `source:'fleet-end'` still stored; inject does not bind host turn |
| K | **通过** | failing producer + grepped success text keeps non-zero exit |
