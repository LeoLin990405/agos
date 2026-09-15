# C — Router persistence and feedback integrity

Implementer C. Worktree `/Users/<name>/Projects/agos-round2-20260908`, branch `cursor/agos-round2-20260908`, base `7e7e359`.

> **STATUS: §3 has been applied by the controller** (`lib/index.js` mtime 2026-09-08 23:52,
> all four edits present at lines 9, 253, 277, 331 and 392). I did not make that edit — the
> file is not mine — and the applied version matches §3 structurally, with the comments
> translated to Chinese. **The full suite was re-run after the wiring landed: 116 pass / 0
> fail, exit 0.** §3 is kept below as the record of what was requested and why.

Nothing in C1 protected production until that wiring landed: the lock, its tests and its
falsification all live in files I own, but every read-modify-write call site is in
`index.js`, which I may not touch.

Result up front: **91 → 116 tests, 0 failures, exit 0**, with the `7e7e359` baseline
re-verified at 91/0/0 under the same `node_modules`. Real subprocess and `SIGKILL` evidence
for C1, plus a falsification run showing 3 of 5 multiprocess tests go red when the lock is
removed — and §6 is explicit about the 2 that do not.

---

## 1. Files created / modified

### Created

| Path | Purpose |
|---|---|
| `plugins/dsh-agos-router/lib/ledger-lock.js` | Synchronous cross-process advisory lock (C1) |
| `plugins/dsh-agos-router/lib/ids.js` | Collision-resistant id minting and legacy-tolerant parsing (C2) |
| `plugins/dsh-agos-router/test/ledger-multiprocess.test.mjs` | Real subprocess races + `SIGKILL` (C1) |
| `plugins/dsh-agos-router/test/ids.test.mjs` | Uniqueness, shape, frontend-regex compatibility (C2) |
| `plugins/dsh-agos-router/test/task-binding.test.mjs` | Accept path + every refusal path (C3) |
| `plugins/dsh-agos-router/test/honesty.test.mjs` | Text-only trial never reads as a repo execution (C5) |
| `docs/engineering/agos-round2-20260908/wiring/C-wiring.md` | This file |

### Modified

| Path | Change |
|---|---|
| `lib/ledger.js` | `appendLine` is locked, fsync'd and torn-tail-healing; `scanLedger` rejects non-records; `buildDecisionRecord`/`buildOutcomeRecord` carry `taskRef` and minted ids |
| `lib/dispatch.js` | Minted `dsp-` ids; `taskRef` on the trial; bounded reviewer context; `execution`/`repoModified` honesty fields; injectable `transact` around the verdict booking |
| `lib/assemble.js` | Minted `asm-` ids; `taskRef` carried from the decision |
| `lib/feedback-bind.mjs` | `TASK_MISMATCH` and `REPLAYED` codes; `checkTaskBinding`; `seenNonce`; both gates wired into `bindOrdinaryOutcome` |
| `lib/shadow.js` | Shadow rows drop the inherited `taskRef` (they keep the stronger `shadow.taskFingerprints`) |
| `lib/task-fingerprint.mjs` | **Additive only** — see §4 |
| `test/shadow.test.mjs` | Id assertion widened to the new tail; now asserts entropy rather than a fixed width |
| `test/dispatch.test.mjs` | Reviewer-prompt test updated to the C4 contract; new truncation and transaction tests |

**`lib/index.js` was not edited by me.** It now differs from base because the controller
applied §3; see the status note at the top.

> ### ⚠️ Every file in the "Created" table above is UNTRACKED — `git add` before committing
>
> I am forbidden from running any git write command, so nothing below is staged. **A
> `git commit -am` would silently drop the entire lock implementation and four of the six
> test files**, leaving `lib/ledger.js` and the applied `index.js` wiring importing a module
> that does not exist — a broken commit that passes nobody's review because the code simply
> is not there.
>
> ```
> git add plugins/dsh-agos-router/lib/ids.js \
>         plugins/dsh-agos-router/lib/ledger-lock.js \
>         plugins/dsh-agos-router/test/ids.test.mjs \
>         plugins/dsh-agos-router/test/task-binding.test.mjs \
>         plugins/dsh-agos-router/test/honesty.test.mjs \
>         plugins/dsh-agos-router/test/ledger-multiprocess.test.mjs \
>         docs/engineering/agos-round2-20260908/
> ```
>
> This also means `git diff --stat` understates the change by roughly 6×: it reports ~291
> insertions across tracked files, while the untracked files carry a further 1388 lines
> (`ledger-lock.js` 275, `ledger-multiprocess.test.mjs` 374, `task-binding.test.mjs` 284,
> `ids.test.mjs` 174, `honesty.test.mjs` 161, `ids.js` 120).

---

## 2. Behaviour implemented

### C1 — cross-process append and read-modify-write

`appendLine()` is synchronous and is called from every HTTP handler, so an async
promise-based lock (as `dsh-fleet` uses) could not be dropped in without rewriting
`index.js`. `lib/ledger-lock.js` is therefore the *same protocol executed
synchronously*, so both ledgers agree on what "the owner is dead" means:

- the owner record is written to a private temp file, `fsync`'d, then published to
  `<path>.lock` with `link(2)`. A paused creator never exposes an empty lock file that
  a second process could steal by age.
- owner identity is `{pid, startTime, token, host, identityFormat}`, where `startTime`
  comes from `ps -p <pid> -o lstart=` read under `TZ=UTC LC_ALL=C`. **A live pid whose
  start time matches is never reclaimed, however long it holds** — this is the
  cross-timezone owner-identity semantics from last round, preserved verbatim.
  Legacy records without `identityFormat` carry a locale-dependent string that cannot
  prove PID reuse, so a live legacy pid is also retained.
- reclaiming a dead owner happens under a per-generation recovery lock and re-checks
  `ino`/`dev`/`token` afterwards, so a late reaper cannot unlink a *new* live owner's file.
- blocking uses `Atomics.wait` on a private `SharedArrayBuffer`: parks the thread
  without burning CPU and without an event-loop turn, which a sync API requires.
- the lock is **reentrant** by depth count. This matters: a read-modify-write caller
  wraps several `appendLine()` calls, each of which locks again. Without the counter
  the second acquire would deadlock against its own process.

Three distinct hazards get three distinct mitigations in `appendLine`:

1. *interleaving* — the lock means one writer at a time inside open/write/close, so two
   records can never share a line. Honest caveat: my falsification run shows this one
   also holds **without** the lock, because `O_APPEND` already makes a single `write(2)`
   atomic against other writers. The lock is belt-and-braces here and load-bearing in
   case 2 of §3 and in the read-modify-write paths — see §6;
2. *a torn tail from a writer killed mid-write* — the file is probed for a trailing
   newline and one is prepended if missing, so the fragment stays on its own line
   (where the reader rejects it) instead of swallowing the next record;
3. *loss on power failure* — `fsync` before releasing, so a record `appendLine()` has
   returned for is on disk.

On the read side, `scanLedger()` accepts a row only if the line parses **and** yields a
plain object. Any proper prefix of a JSON object is missing its closing brace and fails
to parse, so a truncated write can never be mistaken for a record.

### C2 — collision-resistant identities

The defect: `asm-${Date.now()}` and `dsp-${Date.now()}` repeat whenever two records are
minted in the same millisecond (two tabs, a retry, a loop, two hosts sharing `~/.dsh`).
A repeated id silently merges two records and nothing downstream can detect it later.
`dec-` had 8 hex nibbles — better, but 32 bits.

Every id now carries a random tail; the leading epoch-ms remains for readability and
continuity but is decoration.

- **`dec-`** is plugin-internal, so it takes a full **128-bit** hex tail. It still
  matches `/^dec-\d+-[a-f0-9]+$/i`, which `shadow.js` (`DEC_ID_RE`) and `sanitize.js`
  (`DECISION_ID`) both pin, so shadow linking and ref sanitising are unaffected.
- **`asm-` / `dsp-`** are a published contract with the console, which validates them
  with `/^asm-\d{1,20}$/` and refuses to send the trial request at all when the id
  fails. They therefore keep an all-digit shape: 13 digits of timestamp + **7 random
  digits**, spending exactly the budget the 20-digit ceiling leaves.

I am stating that second guarantee honestly rather than rounding it up: two `asm`/`dsp`
ids collide only if minted in the same millisecond *and* drawing the same 1-in-10⁷ tail
(~23 bits). That removes the "same millisecond ⇒ same id" **certainty**, which was the
actual bug, but it is weaker than `dec-`. §7 has the frontend diff that would let these
move to a full 128-bit tail; it is not mine to apply.

`parseLedgerId()` reads both shapes and marks pre-C2 rows `legacy: true`. Legacy ids
stay readable and foldable forever — refusing them would orphan the entire existing
ledger — but no caller may mint one.

### C3 — original task identity bound end to end

`taskFingerprint(task)` (SHA256 of the trimmed full text, computed **before** any
preview clipping) is now stamped on the decision (`buildDecisionRecord`), carried to the
proposal (`buildAssembleRecord`), recomputed from the task actually run on the trial
(`buildDispatchRecord`), and recorded on the verdict (`buildOutcomeRecord`). The raw task
never reaches the ledger — only the hash and an 80-char preview.

Two gates in `bindOrdinaryOutcome`:

- **cross-task** (`checkTaskBinding`): an explicitly stated task that disagrees with the
  decision's is always refused. A reviewer verdict *must* state one — the dispatch path
  always knows which task it ran, so a missing fingerprint there means the verdict is
  unattributable. Decisions written before `taskRef` existed carry none and stay
  bindable, flagged `taskUnverified: true` so a caller can report "not checkable"
  instead of implying the binding was verified.
- **replay** (`seenNonce`): a submission may carry a nonce minted once by whoever
  produced the verdict. The dispatch path derives it from the trial id, so replaying a
  trial into the ledger is refused (`REPLAYED`) rather than appending a second identical
  verdict. Checked *before* the idempotency branches, so a replay is named rather than
  silently absorbed.

Both refusals return no `record`, so a refused verdict cannot be booked by a caller that
ignores `ok`.

### C4 — bounded reviewer context

The reviewer used to receive the implementer draft and nothing else, so 「判定：通过」
meant "this text looks fine", not "this answers the task". It now receives the complete
original task as well.

- two **separate** budgets (`REVIEWER_TASK_LIMIT` / `REVIEWER_RESULT_LIMIT`, 4000 code
  points each) rather than one shared one, so a long task cannot crowd out the draft it
  is judging;
- truncation is deterministic head-truncation by code point (not UTF-16 unit, so an
  emoji or a CJK surrogate pair is never split);
- every cut is announced *inside the prompt*: `[已截断：保留前 N 字，省略 M 字]`. A
  reviewer told nothing about a cut will confidently judge a fragment.

**The independent-review gate is unchanged.** `gateReviewerVerdictFeed` still fires
before any provider call, and the planner draft is still withheld
(`REVIEWER_SEES_FINAL_COPY`, 「看不到规划稿」).

### C5 — honesty invariant

`buildDispatchRecord` now writes `execution: 'text-only'` and `repoModified: false` into
the row itself. A trial where all three roles answered successfully is still not a
repository execution, and `outcome` stays `null` regardless. Turn successes stay
`kind: 'route'` with no measured duration and are never promoted to `fleet` rows, so a
text-only trial cannot appear in the outcome grid as real work.

---

## 3. EXACT wiring for `lib/index.js` — **applied**

*Applied by the controller on 2026-09-08 at 23:52; all four edits are present in the working
tree and the suite is green with them in place. Retained below as the rationale of record.*

Five call sites read the ledger, decide from what they read, then append. Each is a
read-modify-write with no transaction, so two processes both observe "no prior outcome"
and both append.

**What this actually costs today** (worth knowing before judging the priority): duplicate
*identical* outcome rows are harmless, because `foldLedger` keys outcomes by ref and the
posterior folds one observation per decision. The real damage is **conflicting** writes —
two processes racing, one booking `ok` and the other `fail`. The `CONFLICTING_RESULT`
gate exists precisely to refuse the second, and a lost read-modify-write defeats it:
last-writer-wins silently rewrites history, which is the 改判不改史 rule broken by a
race rather than by a bug. The same applies to `shadowLink`, where two concurrent links
both pass the `REBOUND` / `BATCH_LINKED` checks and one batch ends up bound to two
decisions.

### 3a. Import

```diff
-import { appendLine, buildAnnotateRecord, buildDecisionRecord, listRoutes as listRoutesFromLedger, readLedgerLines, foldLedger } from './ledger.js'
+import { appendLine, buildAnnotateRecord, buildDecisionRecord, listRoutes as listRoutesFromLedger, readLedgerLines, foldLedger, withLedgerLock } from './ledger.js'
```

### 3b. `shadowLink` — read → validate → append

```diff
   function shadowLink(body) {
     const cfg = effectiveConfig()
-    const rows = readLedgerLines(cfg.auditFile)
-    const bound = bindShadowLink({
-      ref: body && body.ref,
-      batchId: body && body.batchId,
-      hosts: body && body.hosts,
-      rows,
-      decisions: foldLedger(rows).decisions,
-      batches: fleetBatchRuns(readFleetRuns(homedir())),
-    })
-    if (!bound.ok) {
-      const error = new Error(bound.error)
-      error.code = bound.code
-      throw error
-    }
-    if (!bound.idempotent) appendLine(cfg.auditFile, bound.record)
-    return bound.record
+    // One transaction: the REBOUND / BATCH_LINKED checks read the existing links,
+    // so a concurrent linker must not slip between that read and this append.
+    return withLedgerLock(cfg.auditFile, () => {
+      const rows = readLedgerLines(cfg.auditFile)
+      const bound = bindShadowLink({
+        ref: body && body.ref,
+        batchId: body && body.batchId,
+        hosts: body && body.hosts,
+        rows,
+        decisions: foldLedger(rows).decisions,
+        batches: fleetBatchRuns(readFleetRuns(homedir())),
+      })
+      if (!bound.ok) {
+        const error = new Error(bound.error)
+        error.code = bound.code
+        throw error
+      }
+      if (!bound.idempotent) appendLine(cfg.auditFile, bound.record)
+      return bound.record
+    })
   }
```

Throwing from inside is safe: `withLedgerLock` releases in a `finally`.

### 3c. `backfillShadow` — runs on every `GET /routes`

```diff
   function backfillShadow(cfg) {
     try {
-      const rows = readLedgerLines(cfg.auditFile)
-      const batches = fleetBatchRuns(readFleetRuns(homedir()))
-      const links = validatedShadowLinks(rows, batches)
-      if (links.size === 0) return 0
-      const { decisions } = foldLedger(rows)
-      const pending = backfillShadowOutcomes({ decisions, links, batchRuns: batches })
-      for (const rec of pending) appendLine(cfg.auditFile, rec)
-      return pending.length
+      // Two concurrent GETs otherwise compute the same pending set and both write it.
+      return withLedgerLock(cfg.auditFile, () => {
+        const rows = readLedgerLines(cfg.auditFile)
+        const batches = fleetBatchRuns(readFleetRuns(homedir()))
+        const links = validatedShadowLinks(rows, batches)
+        if (links.size === 0) return 0
+        const { decisions } = foldLedger(rows)
+        const pending = backfillShadowOutcomes({ decisions, links, batchRuns: batches })
+        for (const rec of pending) appendLine(cfg.auditFile, rec)
+        return pending.length
+      })
     } catch (err) {
       logger.warn('影子回填失败(不影响列表)', err && err.message ? err.message : err)
```

### 3d. `recordOutcome` — the operator verdict button

```diff
   function recordOutcome(body) {
     const file = effectiveConfig().auditFile
-    const bound = bindOrdinaryOutcome({
-      authority: 'operator',
-      body,
-      rows: readLedgerLines(file),
-    })
-    if (!bound.ok) {
-      const error = new Error(bound.error)
-      error.code = bound.code
-      throw error
-    }
-    if (bound.idempotent) return bound.record
-    appendLine(file, bound.record)
-    return bound.record
+    // One transaction: CONFLICTING_RESULT is decided from this read, so a racing
+    // writer must not land an opposite result between the read and the append.
+    return withLedgerLock(file, () => {
+      const bound = bindOrdinaryOutcome({
+        authority: 'operator',
+        body,
+        rows: readLedgerLines(file),
+      })
+      if (!bound.ok) {
+        const error = new Error(bound.error)
+        error.code = bound.code
+        throw error
+      }
+      if (bound.idempotent) return bound.record
+      appendLine(file, bound.record)
+      return bound.record
+    })
   }
```

No change is needed for C3 on this path: `bindOrdinaryOutcome` already reads
`body.taskRef`, so a client that states the wrong task is refused and one that states
none is accepted as `taskUnverified`.

### 3e. `dispatchLiveRequest` — inject the transaction, do **not** wrap the call

The verdict booking inside `dispatchTeam` is also a read-modify-write, but it sits
behind three model streams at up to 45s each. Wrapping `dispatchTeam()` in
`withLedgerLock` would hold a cross-process lock far past its 30s timeout and make every
other writer fail. `dispatchTeam` therefore accepts a `transact` dep and applies it to
the sync read→check→append tail only. Add one line:

```diff
     }, {
       append: (record) => appendLine(effectiveConfig().auditFile, record),
       readRows: () => readLedgerLines(effectiveConfig().auditFile),
+      // Only the sync read→check→append tail runs under the lock; the model streams
+      // in front of it must not hold a cross-process lock for ~135s.
+      transact: (fn) => withLedgerLock(effectiveConfig().auditFile, fn),
       streamRole: (input) => streamRoleText(input, {
```

Omitting `transact` is safe and preserves today's behaviour exactly (it defaults to a
pass-through), so this line is the only thing standing between the current code and a
transactional verdict booking.

### 3f. `assembleLiveRequest` — deliberately **not** wrapped

`assembleLive` reads rows to compute the posterior and then appends an `assemble` row.
Two concurrent proposals can each rank against slightly stale evidence, but neither
double-counts anything and `foldLedger` takes the last proposal. Wrapping it would mean
holding the lock across `await decide()`, which includes a selector model call. Left
alone on purpose; flagged in §7.

### Nesting is safe

`recordOutcome` → `appendLine` acquires the same lock again, and
`dispatchLiveRequest` → `listRoutes` → `backfillShadow` nests too. The lock is reentrant
by depth count within a process, so these are no-ops rather than self-deadlocks.

### After applying — done, and green

```
cd plugins/dsh-agos-router && node --test test/*.mjs   # 116 pass / 0 fail, exit 0
```

This run was executed **after** the wiring landed, so it is evidence that the applied §3
breaks nothing. It is not evidence that the wiring *works*: none of my tests import
`index.js`, so they cannot exercise it. The wiring is covered only indirectly —
`test/dispatch.test.mjs` pins the `transact` contract §3e relies on, and
`test/ledger-multiprocess.test.mjs` proves the lock §3b–§3d rely on. An end-to-end test
through the HTTP handlers would need to own `index.js`; see §7.

---

## 4. `task-fingerprint.mjs` — additive only, **no Fleet coordination required**

Verified with `rg` that `plugins/dsh-fleet/lib/fleet-ledger.mjs` imports this module and
stamps every dispatch event with it, and that `feedback-bind.mjs` compares those hashes
byte for byte against shadow decision rows already on disk.

`taskFingerprint()` is therefore **unchanged**: same signature, same input normalisation
(`trim`), same algorithm (sha256), same output (lowercase hex, `null` for blank). I added
a comment marking the contract frozen and the reason, plus three read-only helpers over
the same value:

```js
export const TASK_FINGERPRINT_RE = /^[a-f0-9]{64}$/
export function isTaskFingerprint(value) { … }
export function sameTask(a, b) { … }
```

**Implementer E needs to do nothing.** No Fleet-side adaptation, no migration, no
on-disk change. If E later wants the same helpers, they are already exported.

Verified rather than assumed: `plugins/dsh-fleet` → `node --test test/*.mjs` is
**148 pass / 0 fail, exit 0** with my change in place (§5 row 6).

---

## 5. Commands run — real exit codes and counts

All runs are `node --test`. Baseline is a pristine `git archive 7e7e359` extracted to
`/tmp`, symlinked to the worktree's `plugins/node_modules`, so the only variable between
before and after is my code.

| # | Command | Exit | tests | pass | fail | skip |
|---|---|---|---|---|---|---|
| 1 | **before** — `/tmp/c-baseline/plugins/dsh-agos-router` → `node --test test/*.mjs` | **0** | 91 | 91 | 0 | 0 |
| 2 | **after** — `plugins/dsh-agos-router` → `node --test test/*.mjs` | **0** | **116** | **116** | **0** | **0** |
| 3 | `node --test test/dispatch.test.mjs` | 0 | 13 | 13 | 0 | 0 |
| 4 | `node --test test/ledger-multiprocess.test.mjs` | 0 | 5 | 5 | 0 | 0 |
| 5 | **falsification** — same file, `withLedgerLock` neutered in a `/tmp` copy | **1** | 5 | 2 | **3** | 0 |
| 6 | `plugins/dsh-fleet` → `node --test test/*.mjs` (I changed a file it imports) | 0 | 148 | 148 | 0 | 0 |
| 7 | `frontend` → `routes-assemble.runtime.test.ts` | 0 | 7 | 7 | 0 | 0 |
| 8 | `frontend` → `routes-assemble.test.ts` | 0 | 24 | 24 | 0 | 0 |

Row 1 confirms the brief's stated baseline exactly: **91 / 0 / 0 at `7e7e359`**, run against
the same `plugins/node_modules` as row 2, so the only variable is my code. Net **+25 tests,
zero regressions**. The 98 ms → 5153 ms runtime increase is the real process forking in the
new multiprocess suite.

Rows 7–8 were also run against the pristine baseline and produced identical counters, so the
console contract is unaffected by the id change. `assert.match(plan.id, /^asm-\d+$/)` still
passes.

> **Note on the stated baseline.** My *first* run in this worktree showed 90/1, with
> `settings-012.test.mjs` failing on `ERR_MODULE_NOT_FOUND: @deepseek-ai/schemastery`. That
> was environmental — `plugins/node_modules` did not exist in the worktree yet. Once present
> (installed by a concurrent agent, not by me) the suite reproduces 91/0/0, as row 1 shows.
> I installed nothing.

---

## 6. Negative tests — what each one proves

### Real subprocess / race evidence (`test/ledger-multiprocess.test.mjs`)

These spawn actual `node` child processes with `spawnSync`/`spawn` and actually send
`SIGKILL`. They are not in-process simulations.

| Test | Proves | Fails without the lock? |
|---|---|---|
| two Node processes appending concurrently lose no acknowledged record and tear no line | No record is lost, no two records share a line. 256 KB payloads. | **No** — `O_APPEND` gives this. See below. |
| concurrent read-modify-write books one outcome, and the posterior counts it once | 16 racing check-then-append attempts produce exactly one booking. A synchronised start barrier plus an injected think-delay inside the critical section guarantees the workers are genuinely in the window together — without them the race simply does not occur and the test proves nothing. | **Yes** — saw 4 outcome rows |
| a writer `SIGKILL`ed mid-write leaves a fragment that never parses | The partial line is rejected by the reader, and the next writer's record is not absorbed into it. Crash, not graceful shutdown. | **No** — this is the reader's guarantee |
| a stale reaper cannot unlink the lock of the new owner that replaced it | A late reaper cannot delete a *new* live owner's lock file (`ino`/`dev`/`token` recheck). | **Yes** |
| a live lock owner is never stolen; only a dead one is reclaimed | A crashed writer cannot corrupt or steal a new owner's state; cross-timezone owner-identity semantics preserved. | **Yes** — `stole a live lock` |

**Falsification, and which tests actually discriminate.** I re-ran this suite against a
`/tmp` copy of the plugin with `withLedgerLock` replaced by a pass-through. **3 of the 5
fail without the lock** (§5 row 5):

- *read-modify-write books one outcome* → `expected one outcome row, saw 4`
- *a live lock owner is never stolen* → `Error: unreachable: stole a live lock`
- *a stale reaper cannot unlink the new owner's lock* → reaped it

**The other 2 still pass without the lock, and I am not going to claim them as evidence
for it.**

- The plain concurrent-append test passes because `O_APPEND` already makes a single
  `write(2)` atomic against other writers on this platform, at any size — I had enlarged
  the records to 256 KB specifically to defeat that, and it was not enough, because the
  guarantee is not a buffer-size effect. So *plain appends were never the broken part*;
  the lock's real contribution is the read-modify-write and owner-identity cases above.
- The `SIGKILL` test exercises the **reader**: it asserts a torn fragment never parses as
  a record. That is `scanLedger`'s guarantee and the newline-healing in `appendLine`,
  neither of which is the lock. It is still a real subprocess-and-kill test; it just
  proves a different mechanism.

An earlier falsification attempt patched only `lib/ledger.js`, while the workers imported
the real lock directly from `lib/ledger-lock.js`. That run passed and proved nothing;
patching `ledger-lock.js` itself was required.

### In-process assertions

Clearly labelled as such — these check logic and wiring, not concurrency.

| Test | Proves |
|---|---|
| `task-binding`: verdict for task Y against a decision for task X | Refused `TASK_MISMATCH`, and **no `record` is returned**, so a caller ignoring `ok` still cannot book it. The same call with task X is accepted, so the gate discriminates rather than blocking everything. |
| `task-binding`: reviewer verdict stating no task | Refused when the decision has one. The manual/operator path is still accepted, so the gate does not silently disable human feedback. A client claiming the wrong task is refused on that path too. |
| `task-binding`: cross-task **trial**, end to end | The reviewer really returns 「判定：通过」, and still nothing is booked: `verdictFed: false`, `verdictSkip: TASK_MISMATCH`, zero outcome rows, and `allocationStateFromLedger` stays empty. |
| `task-binding`: replay | The same submission twice is named `REPLAYED`, not absorbed. A retry *without* a nonce is deduplicated instead (`idempotent: true`, nothing appended). Even if duplicates did reach disk, one decision contributes one observation. |
| `task-binding`: replayed whole trial | Second identical trial reports `ALREADY_JUDGED`; the posterior still shows `s:1, f:0`. |
| `task-binding`: same-model reviewer | The independence gate fires **before** the task gate and before any provider call — `called` is exactly `['planner','implementer']`. This is the provider-zero-call regression, preserved. |
| `task-binding`: pre-`taskRef` history | Legacy rows stay bindable and are flagged `unverified` rather than being retro-fitted with an invented fingerprint. |
| `ids`: frozen clock | `mintDecisionId`/`mintAssembleId`/`mintDispatchId` still produce unique ids when `Date.now()` cannot change — the exact condition the old code failed. |
| `ids`: frontend regex | Reads `ASSEMBLE_ID_RE` / `DISPATCH_ID_RE` **out of the frontend source file** and asserts freshly minted ids match. If B ever tightens those regexes, this test breaks in my suite rather than the trial button dying silently in production. |
| `ids`: legacy | Old-shape ids still parse, fold and bind. |
| `dispatch`: bounded reviewer context | Truncation is deterministic, marked, and per-section; the planner draft still does not leak. |
| `dispatch`: one transaction | Every ledger read and the outcome append happen inside `deps.transact()`; omitting it preserves prior behaviour. Wiring assertion only — the mutual exclusion it delegates to is proven by the subprocess tests above. |
| `honesty` (C5) | A fully successful text-only trial is recorded `execution: 'text-only'`, `repoModified: false`, `outcome: null`; it does not enter the posterior, does not count as "filled", and its turn successes are never promoted to `fleet` rows. |
| `ledger`: torn line | A partial line is rejected by `scanLedger` rather than parsed; `rejected` is counted, not silently dropped. |

---

## 7. Unresolved risks and what I could not verify

1. **The applied §3 wiring has no direct test coverage.** It is now in the working tree and
   the suite is green with it, but green here only means "nothing else broke" — no test of
   mine imports `index.js`, so nothing asserts that `recordOutcome` actually holds the lock
   in production. Verifying that needs a test that owns the HTTP entry, which I do not.
   The nearest proxies are the `transact` contract test and the multiprocess lock tests.

2. **`asm-`/`dsp-` entropy is ~23 bits, not 128, and the 20-digit budget is exactly
   saturated.** 13 timestamp digits + 7 random digits = 20, the ceiling in
   `frontend/src/components/console/routes-assemble.ts`. `postAssembleDispatch()`
   *refuses to send the request* when an id fails that regex, so widening the tail
   without the frontend change below would kill the trial button **silently** — the
   runtime test's `/^asm-\d+$/` is unbounded and would not catch it. If B wants full
   128-bit tails, the coordinated change is:

   ```diff
   -const ASSEMBLE_ID_RE = /^asm-\d{1,20}$/;
   -const DISPATCH_ID_RE = /^dsp-\d{1,20}$/;
   +const ASSEMBLE_ID_RE = /^asm-\d{1,20}(?:-[a-f0-9]{8,64})?$/;
   +const DISPATCH_ID_RE = /^dsp-\d{1,20}(?:-[a-f0-9]{8,64})?$/;
   ```

   then `mintAssembleId`/`mintDispatchId` switch to the `dec-` encoding. I did not make
   this change: the frontend is B's and a silent dead button is a worse failure than
   23 bits.

3. **C3 changes production behaviour when the dispatch call omits `task`.** If a decision
   has a `taskRef` and the trial runs `DEFAULT_DISPATCH_TASK` instead, the verdict is
   now refused (`verdictSkip: TASK_MISMATCH`) where it previously fed the posterior.
   I checked the console and it does send `task` on `/assemble/dispatch`, so the normal
   flow binds. But **editing the task box between "组装提案" and "试跑" will now stop the
   verdict being booked** — correctly, since the reviewer judged different work, but it
   is a visible change. I deliberately did *not* make the trial inherit the decision's
   `taskRef` when no task is supplied: the reviewer really did judge the filler text, and
   binding it to the original task would be exactly the kind of lie C5 forbids. The
   dispatch row states the reason, so it is visible rather than silent.

4. **`assembleLive` is left non-transactional** (§3f). Concurrent proposals may rank
   against stale evidence. No double-counting, but it is a real if minor staleness
   window, and fixing it needs an async-aware lock.

5. **C4's copy is now split across owners.** The router's reviewer prompt includes the
   original task, but `plugins/dsh-agos/lib/agent-prompts.js` (F) still carries the
   constant describing the old contract, and the frontend (B) has its own mirrored copy.
   I updated only my side and my test. **F and B must update their strings or the frozen
   literal mirror tests will disagree with reality.**

6. **The reviewer bound is 4000 code points per section, chosen not measured.** I did not
   profile real token counts or check it against any provider's context window; no paid
   calls were made. If a task plus a draft both run long, 8000 code points of CJK is a
   substantial prompt. Someone should sanity-check it against the 256-token output cap.

7. **`ps`-based PID-reuse detection is Unix-only** and costs a fork per call. I deferred
   it behind the hold-window check so the common contended path never pays it, but on a
   host without `ps` the lock degrades to liveness-only (`kill(pid, 0)`), which cannot
   detect PID reuse. Not exercised on Windows; not relevant to this project today.

8. **`SIGKILL` proves crash-during-write; it does not prove power loss.** `fsync` is
   called, but I have no way to test actual media failure or a lying disk cache.

9. **Two of the five multiprocess tests do not discriminate** (§6). They are real
   subprocess tests and they pass, but they would also pass with the lock removed, so
   they are evidence for `O_APPEND` and for the reader's torn-line rejection — not for
   the lock. I left them in because both properties are worth pinning; they are just
   labelled honestly rather than counted as lock coverage.

10. **Concurrent worktree edits.** Other implementers are editing this same worktree while
    I work. My "after" run reflects the tree at the moment it ran, which includes their
    in-flight changes to files I do not own. The baseline comparison in §5 controls for
    my plugin only.
