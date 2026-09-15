# Package F — Chinese session-memory evaluation corpus, skill provenance, turn-evidence audit

**Branch:** `cursor/agos-round2-20260908` · **Base:** `7e7e359` · **Host:** Darwin 25.5.0 arm64, Node v26.7.0

> **Headline honesty statement.** Everything measured in this package was measured against a
> **synthetic, publishable Chinese corpus written for this round** (59 + 21 + 9 rows). It is not a
> sample of anyone's real sessions, and the readings below are therefore statements about the
> rules' behaviour on *constructed* cases — not an estimate of field accuracy.
> The three rejection gates added to `session-memory.mjs` tighten precision, and their cost in
> **recall is unmeasured**, because the only corpus that could measure it is the private one this
> worktree cannot see. That gap is §4 and it is the risk the controller should carry forward.
> Nothing in this package was made to look better by editing a fixture's `expect`; the eight
> failing samples are all still failing, listed, and explained.

---

## 1. Files created / modified

| Path | Status | Role |
| --- | --- | --- |
| `plugins/dsh-agos/test/fixtures/session-memory-zh/extraction.jsonl` | **created** (59 rows) | Nine Chinese categories, hard negatives, honest ambiguities |
| `plugins/dsh-agos/test/fixtures/session-memory-zh/provenance.jsonl` | **created** (21 rows) | 12 session-source + 9 skill-origin samples |
| `plugins/dsh-agos/test/fixtures/session-memory-zh/retrieval.jsonl` | **created** (9 rows) | Recall / false-recall / fallback-honesty / constraint-reserve |
| `plugins/dsh-agos/test/fixtures/session-memory-zh/README.md` | **created** | Labelling rubric + synthetic-data guarantee |
| `plugins/dsh-agos/test/session-memory-zh-eval.test.mjs` | **created** (9 tests) | Three *separate* reports + `KNOWN_GAPS` guard + corpus self-scan |
| `plugins/dsh-agos/lib/session-memory.mjs` | modified (+23 lines) | Three additive rejection gates (attribution / conditional / stale) |
| `plugins/dsh-agos/test/skills-evolve.test.mjs` | modified (+100 lines, +2 tests) | **R1**: same-name **and** same-description skills with different provenance |
| `plugins/dsh-agos/test/turn-evidence-capacity.test.mjs` | **created** (7 tests) | **R2**: capacity / retention boundary audit |
| `docs/engineering/agos-round2-20260908/wiring/F-wiring.md` | **created** | This document |

`plugins/dsh-agos/lib/index.js` was **not** modified (see §5 — no change is required).
No file outside package F's ownership was touched: `git status --short plugins/dsh-agos/` lists
exactly `lib/session-memory.mjs`, `test/skills-evolve.test.mjs`, and the three new test/fixture
paths above. No fixture was edited after it was written (§3 has the fingerprints).

### Extraction fixture inventory by category

`scored = total − ambiguous`; ambiguous rows are reported but never enter a pass/fail denominator.

| Category | Total | Ambiguous | Scored | Pass | Expected labels |
| --- | --- | --- | --- | --- | --- |
| `question` | 7 | 0 | 7 | 6 | 6×null, 1×constraint (a real rule phrased as a question) |
| `quotation` | 7 | 2 | 5 | 5 | 4×null, 3×constraint |
| `negation` | 6 | 0 | 6 | 5 | 5×constraint, 1×null |
| `conditional` | 8 | 2 | 6 | 6 | 4×null, 3×constraint, 1×fact |
| `oneshot` | 7 | 0 | 7 | 6 | 6×null, 1×constraint |
| `preference` | 6 | 0 | 6 | 5 | 6×preference |
| `correction` | 5 | 0 | 5 | 3 | 4×fact, 1×null |
| `outdated` | 6 | 1 | 5 | 5 | 3×null, 2×constraint, 1×fact |
| `sensitive` | 7 | 1 | 6 | 6 | 5×REFUSE, 2×constraint (sensitive-looking but safe) |
| **Total** | **59** | **6** | **53** | **47** | |

Provenance: 21 rows — 12 `session-source` (3 `user-direct`, 8 `not-user`, 1 `model-rejected`) and
9 `skill-origin` (2 `global`, 3 `project`, **4 `unknown`**). Retrieval: 9 rows, 1 ambiguous,
1 constraint-reserve case, 1 pin refused by design (a sensitive item that must not enter the store).

---

## 2. The three evaluation readings — real numbers, kept separate

Three reports, three gates. A gain in one may not be used to offset a regression in another.
These are copied verbatim from the run in §6 (after-state):

```
[F2-1 抽取] 总 59 · 计分 53 · 通过 47 · 误收 1 · 漏收 5 · 错类 0 · 两难 6(不计分)
[F2-2 来源] 总 21 · 通过 21 · 会话来源 12/12 · 技能来源 9/9
[F2-3 召回] 总 9 · 计分 8 · 通过 6 · 误召回 1 · 漏召回 0 · fallback 口径不符 1 · 两难 1(不计分) · pin 被拒 1
```

| Lane | Total | Scored | Pass | False-accept | False-reject | Wrong-kind | Ambiguous (excluded) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **Extraction** | 59 | 53 | **47** | **1** (`zh-once-07`) | 5 | 0 | 6 |
| **Provenance** | 21 | 21 | **21** | 0 | 0 | 0 | 0 |
| **Retrieval** | 9 | 8 | **6** | **1 false-recall** (`ret-04`) | 0 missed | 1 fallback-label (`ret-08`) | 1 |

Read these as ratios only with the denominators attached: extraction is 47/53 **on this synthetic
corpus**, and the corpus was written to be adversarial — 25 of the 59 rows expect no item at all and
5 more must be refused outright — so the number is not comparable to a field accuracy figure.

The six ambiguous rows (`zh-quote-06`, `zh-quote-07`, `zh-cond-06`, `zh-cond-07`, `zh-out-06`,
`zh-sec-05`) are cases where two competent annotators would disagree. They are printed with the
current output and whether it agrees with one reading; they are never counted as passes. Five of
the six currently agree with one defensible reading, `zh-out-06` with neither — stated, not scored.

`pin 被拒 1` in the retrieval lane is a **pass, not a defect**: the sensitive item in `ret-08`
is refused at `pinSessionMemoryItem`, so it never reaches the store and cannot be recalled.

---

## 3. Every `KNOWN_GAPS` entry

Eight entries. **All eight are `decision: 'reported'`; none is `'fixed'`; none was erased.**

| Lane | Id | Miss kind | Why it was reported instead of fixed |
| --- | --- | --- | --- |
| extraction | `zh-once-07` | **false-accept** | The `fact` branch's `^我…` arm matches any first-person sentence, so a one-shot intent ("我这次想先看看日志。") is taken as a durable fact. Tightening it means adding a veto for first-person intent verbs (想/要/打算/先) to the same arm that carries `fact` recall on the private corpus. Blind-editing it on a machine that cannot run that corpus is the change most likely to cause a silent recall loss. **This is the only false-accept left in the package.** |
| extraction | `zh-q-07` | false-reject | The question veto is substring-based: any "为什么" anywhere vetoes the whole sentence, eating a genuine rule. The only fix is loosening the veto, which raises false-accepts — and that veto is exactly what holds up `constraint` precision on the private corpus. |
| extraction | `zh-neg-05` | false-reject | Colloquial negation "别…" is not in the constraint keyword table. Adding 「别」collides with 别的/别人/区别/特别 at scale; separating them needs POS information a regex cannot have. |
| extraction | `zh-pref-06` | false-reject | A durable preference with no preference verb ("以后写文档默认用中文") is not reachable without widening the preference gate — same precision-for-recall trade, declined for the same reason. |
| extraction | `zh-corr-03` | false-reject | The named-entity `fact` pattern is `^`-anchored, so any leading clause ("说错了，…") blocks it. Removing the anchor loosens the entire `fact` gate. |
| extraction | `zh-corr-05` | false-reject | Same anchor as `zh-corr-03` ("刚才说的 8080 作废，现在是 8443。"). |
| retrieval | `ret-04` | **false-recall** | Session memory has **no supersession mechanism**: `mergeItems` de-duplicates by `kind+text` hash, so a corrected value and the value it corrects are two different ids, both survive, both match lexically, and one turn re-injects the stale value alongside the current one. A real fix needs a supersession relation + on-disk schema + a frontend affordance; schema and frontend are outside package F's ownership. Carried as a risk, not silently dropped. |
| retrieval | `ret-08` | fallback-label | Both load-bearing assertions pass (the sensitive item is refused at pin, so recall is empty and `notRecall` holds). Only the secondary `fallback` field disagrees: the fixture says `null`, the ranker says `no-overlap` — and `no-overlap` is the honest answer, since other items exist and none overlaps 「密码」. In other words the **fixture is narrower than reality**, not a regression. Under this file's discipline the `expect` is *not* edited (editing it is the cover-up); the entry is registered here instead so the mismatch stays visible. |

**How the harness makes erasure impossible.** Each lane asserts
`deepEqual(sortedFailingIds, sortedKnownGapIds)`. Loosening a fixture's `expect` removes the id
from the failing set and the assertion goes red on the *missing* side; introducing a new failure
goes red on the *extra* side; fixing the code for real also goes red until the `KNOWN_GAPS` entry
is deleted. The guard is bidirectional by construction, so "improving the numbers" by relabelling
cannot pass.

**Proof no fixture was touched this session.** The three `.jsonl` files were written at 19:53–19:59;
this session began at 23:34 and never wrote to them. Fingerprints as delivered:

```
83ee8fc80b70157e92c189ea6988bd5bbd34b83e76a34d1de2dafb5e548d7855  extraction.jsonl
12b2db37c164086d23a25e392206621e688d83798dbf48c8c4c6552648988bfa  provenance.jsonl
022f435e72bf4bbc1b2642be3d7b61bc5a51f52d49b79ad4aeaf6b6020da4da8  retrieval.jsonl
```

---

## 4. Unresolved risk — the precision gates' effect on recall is UNMEASURED

`lib/session-memory.mjs` gained three additive rejection gates this round:

| Gate | Rejects | Scope |
| --- | --- | --- |
| `ATTRIBUTION_LEAD_RE` | third-person attribution ("同事说…", "客户反馈…") — someone else's words are not the user's own fact or preference | `constraint` / `preference` / `fact`; `rejected` is judged earlier and still kept, because "同事说试过 flock 不行" is a useful exclusion |
| `CONDITIONAL_LEAD_RE` | conditional openers (如果/假如/要是/一旦…) — a hypothesis is not a fact | **`fact` branch only**; a rule that uses a condition as its scope is still captured as `constraint`, with 「如果」left verbatim in the text |
| `isStaleDeclarative` | a declarative carrying a staleness marker (以前/之前/旧版/上个月…) *before* its copula — an outdated statement is not a current fact | `fact` branch only; the marker must precede the copula, so "Gen8 是真源，之前说过" is unaffected |

**All three can only reject.** On this synthetic corpus they cost nothing measurable (extraction is
47/53 with one false-accept). **But every one of them removes candidates, and their recall cost over
the private corpus is unmeasured, because that corpus is not available in this worktree.** That is
precisely what the two skipped tests cover:

```
﹣ W20 尺:四个块各自可评分,并把指标打印出来(只看不进门)   # 未显式指定完整 SESSION_MEMORY_CORPUS_DIR，跳过私有语料
﹣ W20 acceptEdit 门:语料没动;每条原来通过的样本不得变失败;有提升须显式接受新基线
```

Those two skips are **not passes** and were left as skips. Consequences to state plainly:

1. Nobody has run the private-corpus ruler since the gates were added. The extraction R over that
   corpus (previously measured at R=0.62 for the `fact` branch) is **unknown** post-change.
2. The `acceptEdit` gate — "no previously passing sample may become a failure" — is the check that
   would catch a recall regression from these gates, and it did not run.
3. `zh-once-07` (the remaining false-accept) sits in the same `fact` arm the gates now guard. Fixing
   it and measuring the gates are the *same* task and both need the same corpus.

**Required before these gates can be considered accepted:** run
`SESSION_MEMORY_CORPUS_DIR=<real corpus> node --test test/*.mjs` on a machine that has the private
corpus, with both W20 tests actually executing, and compare per-block metrics against the recorded
baseline. If recall dropped, the honest fix is to narrow the gate that dropped it — not to accept a
new baseline silently.

A second, independent risk from §3: **`ret-04`, the missing supersession mechanism**, means a
corrected fact and the value it replaced can both be re-injected in the same turn. Today that shows
up as one false-recall in a 9-row corpus; in a long-lived real store it grows with every correction.

---

## 5. Exact wiring needed in `plugins/dsh-agos/lib/index.js`

**None. No change to `index.js` is required, and none should be applied for package F.**
This is not a deferral — the behaviour this package covers already reaches the production entry
point. The call chains, verified by reading `index.js` (unmodified):

**R1 — runtime skill provenance.** `apply()` already binds the hook, and the ambiguity rule already
lives in the module the hook calls:

```
index.js:1398  export function apply(ctx, options = {})
index.js:1403    const turnEvidence = createTurnEvidenceStore({ home })
index.js:1406    bindRuntimeSkillCatalogTrim(ctx, { home, store: evolveStore, evidence: turnEvidence })
index.js:1372  bindRuntimeSkillCatalogTrim → bindCatalogTrim(ctx, { ...options, snapshot })
skills-evolve.js:590  ctx.on('agent/pre-step', handler)
skills-evolve.js:570  handler → rewriteCatalogDecision(decision, names, { candidates, snapshot })
skills-evolve.js:275  rewriteCatalogDecision → trimRuntimeCatalogEntries(entries, names, candidates, options)
skills-evolve.js:212  winners.set(name, winners.has(name) ? null : skill)   ← the ambiguity rule R1 covers
```

R1 added **tests only**. It changed no library code, because the required behaviour was already
correct: a duplicate name in the host snapshot sets that name's winner to `null`, `matchesWinner`
cannot hold against `null`, and `catalogEntryOrigin(undefined)` returns `'unknown'`, which the
retention filter (`if (origin !== 'global')`) keeps. The new tests pin that path against the three
regressions that would break it (§6 mutation table).

**Session-memory gates.** The three gates are inside `classifyUserText`, which is inside
`extractSessionMemory`, which the store's capture path calls, and `apply()` already builds that store:

```
index.js:1402   const sessionMemory = createSessionMemoryStore({ dshRoot })
session-memory.mjs:484    const extracted = extractSessionMemory(snapshot, { afterSeq: previous.watermark, now, header })
session-memory.mjs:120/131  ATTRIBUTION_LEAD_RE / CONDITIONAL_LEAD_RE / isStaleDeclarative
```

**R2 — turn-evidence audit.** Audit only; no production behaviour was changed, so nothing to wire.

**Test registration.** Also nothing to wire: `plugins/dsh-agos/package.json` runs
`node --test test/*.test.mjs`, `scripts/test-all.sh` and `scripts/acceptance/run-acceptance.mjs`
both use the `test/*.mjs` glob, and both new files match both globs. They are picked up with no
manifest edit. (`plugins/dsh-agos/package.json` was therefore left untouched as well.)

---

## 6. R2 — turn-evidence capacity and retention: what was audited, and what I did **not** change

Audited `lib/turn-evidence.js`. **Outcome: no cleanup was added.** A safe policy cannot be defined
from inside package F's file ownership, so the boundaries are reported and pinned by
`test/turn-evidence-capacity.test.mjs` (7 tests) instead.

### Measured boundaries (all numbers from synthetic rows in `mkdtemp` dirs)

| # | Boundary | Evidence |
| --- | --- | --- |
| a | **No retention policy at all.** The ledger is append-only: one row per agent pre-step, forever. No cap, no rotation, no dedup, no TTL. | 512 records → 512 lines, first row still byte-intact after 511 later writes, and no `.1`/`.bak` sibling appears. **Measured 276 662 bytes / 512 rows = 540 bytes/row.** |
| b | **A torn tail line silently costs the *next* row too.** The writer never checks whether the file ends in a newline, so after a crash mid-append the following row concatenates onto the fragment and is unparseable on reload — while `record()` still returned `persisted: true` for it. Recovery is automatic from the row after that; the loss is exactly one row. | Test writes a newline-less fragment, then records two more rows: `turn 9002` is unreadable after reload, `turn 9003` reads back fine, and the pre-crash row is untouched. |
| c | **The in-process bind index never evicts.** `byBind` keeps every distinct `(session, turn, step)` for the process's lifetime — resident memory is O(distinct steps seen), not O(live sessions). | 512 distinct binds recorded in a memory-only store; all 512 still individually retrievable. |
| d | **Startup replays the entire file.** The constructor does one `readFileSync` of the whole ledger and indexes every row; startup cost and memory grow with file size, with no windowing. | A 256-row ledger reloads all 256 binds. |
| e | **Reachability contract** (what any future compaction must preserve): the last row per bind, ∪ the last row per session for unbound reads. Everything else is already shadowed for readers — but still on disk. | 4 rows / 3 reachable; the superseded row is proven present on disk *and* unreachable through the API. |
| f | **No deletion path exists.** The store exposes exactly `{ ledgerPath, record, get }`. | Asserted, plus a tripwire over `prune/compact/rotate/clear/clean/delete/trim/evict/vacuum/truncate`, plus a positive proof: reopening the store five times leaves every earlier bind readable. |

### Why no cleanup was added — the three reasons, stated as reasons and not as excuses

1. **No cross-process lock is available inside `plugins/dsh-agos`.** `dsh-agos` is installed into
   both `~/.dsh/profiles/web` and `~/.dsh/profiles/desktop` (that split is modelled in
   `plugins-inventory.js`), and both compute the *same* `<home>/.dsh/agos/turn-evidence.jsonl`.
   Compaction means read-all-then-rewrite, which has a real lost-append window: rows appended by
   the other process between the read and the rewrite are destroyed. The ledger lock added this
   round lives in `plugins/dsh-agos-router/lib/ledger-lock.js` — another package's ownership, and
   not something F may take a cross-plugin dependency on.
2. **There is no product-level retention requirement to implement.** Nothing states how long a
   turn's evidence must stay readable. Inventing a TTL would retroactively turn `本跳已记录` into
   `本跳未采集` for a turn the operator may still have on screen — the one thing this module's
   contract forbids: absence must mean "not collected", never "collected then quietly discarded".
3. **Rotation without compaction is strictly worse than doing nothing.** Because the reachable set
   is "last row per bind" (boundary e), a size-based rotation drops rows that are still the current
   answer for some turn. That is deleting currently-valid evidence — exactly what the audit forbids.
   Mutation `r2a` below demonstrates this failure concretely.

### Boundary (b) is reported, not fixed — deliberately

The one-line shape of a fix is known: before appending, if the file does not end in `\n`, append one.
I did not apply it. It adds a read to a path that runs on **every** pre-step, to recover one row of a
convenience projection after a crash, and package F cannot verify the production wiring of the write
path (`index.js` is controller-owned). It is registered here with its exact cost so the controller can
decide; the current behaviour is pinned by a test, so it cannot change silently either way.

---

## 7. Commands run, real exit codes, counts

Single verification command, run identically before and after. `SESSION_MEMORY_CORPUS_DIR` is
pointed at a **non-existent** directory on purpose, so the private-corpus tests skip instead of
auto-discovering anything:

```
cd plugins/dsh-agos && SESSION_MEMORY_CORPUS_DIR=/tmp/agos-absent-corpus-check node --test test/*.mjs
```

| Run | Exit | tests | pass | fail | skip |
| --- | --- | --- | --- | --- | --- |
| Controller baseline at `7e7e359` (reported) | 0 | 156 | 154 | 0 | 2 |
| **BEFORE** this session (previous agent's work already in tree) | **0** | **165** | **163** | **0** | **2** |
| **AFTER** (R1 + R2 added) | **0** | **174** | **172** | **0** | **2** |

**Net effect of F2: +9 tests (2 for R1, 7 for R2), 0 → 0 failures, exit 0 → exit 0, and the 2 skips
remain skips.** No test was deleted, skipped, weakened, or renamed. The two skips are the same two
W20 private-corpus tests before and after (§4).

Per-file after-state: `skills-evolve.test.mjs` 16 → 18 tests (all pass);
`turn-evidence-capacity.test.mjs` 7 tests (all pass); `session-memory-zh-eval.test.mjs` 9 tests (all pass).

### Negative cases — every new guard proven to fail when its condition is violated

Each mutation was applied to a **copy of the plugin under `/tmp`**; the repository was never mutated.
Anchors were replaced programmatically and the patched line printed back before running.

| Mutation (in `/tmp` copy) | Simulates | Result |
| --- | --- | --- |
| `winners.set(name, has ? winners.get(name) : skill)` | resolving a same-name collision by **first-wins** instead of staying ambiguous | **both new R1 tests red** — provenance becomes order-dependent; with the twins swapped the `deploy` rows are labelled `global` and trimmed away (`actual ['inbox-triage']` vs `expected ['inbox-triage','deploy','deploy']`). 16 pass / 2 fail |
| `if (origin === 'project') next.push(entry)` | treating origin-**unknown** as trimmable, i.e. guessing `global` | **both new R1 tests red**, plus 4 pre-existing origin tests. 12 pass / 6 fail |
| drop `\|\| trimmed.entries.length === current.source.entries.length` | publishing a **no-op as a trim** | new R1 hook test red on the identity assertion, plus the 2 pre-existing no-op tests. 15 pass / 3 fail |
| `r2a`: keep only the last 2 rows on every append | a naive "cleanup" that deletes reachable evidence | **4 R2 tests red**, including the reachability test — a compaction that drops the last row of an older bind is caught. 3 pass / 4 fail |
| `r2b`: add `prune()` to the store | a deletion channel arriving with no policy behind it | R2 tripwire red: adding cleanup forces this audit to be rewritten as a proof of the new policy. 6 pass / 1 fail |
| `r2c`: `join(options.home ?? homedir(), …)` | a default store silently falling back to the **real** home directory | R2 privacy test red **before any write happens** (the path assertion precedes every `record()`), plus the memory-only test. 5 pass / 2 fail |

---

## 8. Privacy statement

**No personal corpus was read, and no personal path was written.**

*Paths written* — only `mkdtemp(tmpdir(), …)` directories, one per test, six prefixes in the R2
audit (`agos-turn-ev-capacity-`, `-supersede-`, `-replay-`, `-torn-`, `-no-prune-`, `-privacy-`) plus
`agos-runtime-collision-` in R1. Every ledger written by these tests lives at
`<mkdtemp>/.dsh/agos/turn-evidence.jsonl` — a `.dsh` **inside the temp dir**, never `$HOME/.dsh`.

*Paths read* — the three fixture `.jsonl` files and `README.md` under
`test/fixtures/session-memory-zh/`, plus `lib/turn-evidence.js` read as text by the audit's own
source self-check. Nothing else.

*Never touched* — `~/.dsh/agos/turn-evidence.jsonl`, `~/.dsh/sessions*`, `~/.dsh/projects`,
`~/.claude/projects/**`, `~/.Codex/**`, `~/fleet-credentials.txt`, and any real `session.jsonl`/`.zstd`.
The real `~/.dsh/agos/` was checked by directory listing only (names and mtimes, no contents) to
confirm no test had written into it: **`turn-evidence.jsonl` does not exist there at all**, and the
directory's other files are untouched, so no run in this session could have written to it.

*Structural guarantees, not just intentions:*

- `createTurnEvidenceStore()` with no options has `ledgerPath === null` and writes nothing anywhere.
  The audit asserts this **and** asserts `lib/turn-evidence.js` contains no `homedir(` call, so a
  future default cannot start writing into a personal directory. Mutation `r2c` proves the assertion
  fires (and fires *before* any write attempt).
- `HOME` and `CODEX_HOME` were not changed by any test or command. No `npm install` was run. No
  network call and no model call was made — the R1 hook tests inject a stub `snapshot()`, and
  `/synthetic/project` is a string that is never opened.
- The eval harness's self-scan covers itself as well as the corpus, and it stays green: no
  credential shapes (`sk-`, `gh*_`, `AKIA`, JWT, `xox*`, PRIVATE KEY), no `/Users/…` path, no
  `homedir(` probe, no session-archive path, no private-corpus env switch inside the corpus. Its
  `// self-scan:pattern-table:begin/end` sentinels are intact and unmodified; both are still
  present and still asserted to exist (a missing sentinel fails the test rather than degrading to a
  whole-file exemption).
- All corpus text is synthetic: the only hostname allowed is the RFC 2606 reserved
  `example.invalid`, enforced by assertion. No real names, credentials, hostnames or IP addresses.
