> Historical Cursor planning and launch record. Final status is in TASKS.md, REVIEW.md and VERIFICATION.md.

# TASKS — AgOS hardening 2026-09-08

Controller worktree: `/Users/leo/Projects/agos-cursor-hardening-20260908`
Controller branch: `cursor/agos-hardening-20260908`
Started: 2026-09-08 18:49 Asia/Shanghai

## Hot files (controller-only write)

| File | Why serial |
|---|---|
| `plugins/cn-capabilities/lib/index.js` | A/B/I entry |
| `plugins/dsh-fleet/lib/index.js` | C/D/F entry |
| `plugins/dsh-agos/lib/index.js` | H/J/F entry |
| `plugins/dsh-agos-router/lib/index.js` | J entry |
| `frontend/src/stores/live.ts` | E/G |
| `frontend/src/pages/ChatPage.tsx` | E/G |
| `frontend/src/pages/chat-transcript.tsx` | E/G |
| public API types / root package scripts | shared |

`plugins/dsh-agos/lib/secrets-gate.js` is **F-only**. Nobody else copies a second scrubber.

## File owners

| Path | Owner | Status |
|---|---|---|
| `plugins/cn-capabilities/lib/autoresearch-workspace.mjs` | A | claimed new |
| `plugins/cn-capabilities/lib/autoresearch-metrics.mjs` | A | claimed new |
| `plugins/cn-capabilities/test/autoresearch-workspace.test.mjs` | A | claimed new |
| `plugins/cn-capabilities/lib/plan-approval.mjs` | B | claimed new |
| `plugins/cn-capabilities/lib/plan-path.mjs` | B | claimed new |
| `plugins/cn-capabilities/test/plan-approval.test.mjs` | B | claimed new |
| `plugins/cn-capabilities/test/plan-path.test.mjs` | B | claimed new |
| `plugins/cn-capabilities/test/plan-run.fake.test.mjs` | B | existing; B may extend |
| `plugins/dsh-fleet/lib/local-probe.mjs` | C | claimed new |
| `plugins/dsh-fleet/lib/fleet-runtime.mjs` | C | existing; C may edit |
| `plugins/dsh-fleet/test/local-lifecycle.test.mjs` | C | claimed new |
| `plugins/dsh-fleet/test/fleet.fake.test.mjs` | C | existing; C may fix cleanup |
| `plugins/dsh-fleet/lib/fleet-lock.mjs` | D | claimed new |
| `plugins/dsh-fleet/lib/fleet-ledger.mjs` | D | existing; D may edit |
| `plugins/dsh-fleet/test/ledger.test.mjs` | D | existing; D may extend |
| `plugins/dsh-fleet/test/ledger-multiprocess.test.mjs` | D | claimed new |
| `frontend/src/lib/approval-state.ts` | E | claimed new |
| `frontend/src/lib/approval-state.test.ts` | E | claimed new |
| `frontend/src/components/chat/ApprovalPanel.tsx` | E | existing; E may edit |
| `frontend/src/components/chat/ApprovalPanel.test.ts` | E | claimed new |
| `plugins/dsh-agos/lib/secrets-gate.js` | F | exclusive |
| `plugins/dsh-agos/lib/input-limits.js` | F | claimed new |
| `plugins/dsh-agos/test/secrets-gate.test.mjs` | F | claimed new |
| `plugins/dsh-agos/test/secrets-gate-bench.mjs` | F | claimed new |
| `plugins/dsh-agos/test/input-limits.test.mjs` | F | claimed new |
| `frontend/src/lib/session-history.ts` | G | claimed new |
| `frontend/src/lib/session-history.test.ts` | G | claimed new |
| `frontend/src/lib/connection-health.ts` | G | claimed new |
| `frontend/src/lib/connection-health.test.ts` | G | claimed new |
| `frontend/src/components/chat/HistoryIntegrity.tsx` | G | claimed new |
| `frontend/src/components/chat/HistoryIntegrity.test.ts` | G | claimed new |
| `plugins/dsh-agos/lib/skills-evolve.js` | H | existing |
| `plugins/dsh-agos/test/skills-evolve.test.mjs` | H | existing; H may extend |
| `frontend/src/pages/console-live.tsx` | H | existing |
| `frontend/src/pages/console-live.test.ts` | H | existing; H may extend |
| `plugins/dsh-agos/lib/session-memory.mjs` | H | pin-only if H takes it; registered |
| `plugins/cn-capabilities/lib/council-parse.mjs` | I | claimed new |
| `plugins/cn-capabilities/lib/council-record.js` | I | existing; I may edit |
| `plugins/cn-capabilities/test/council-parse.test.mjs` | I | claimed new |
| `plugins/cn-capabilities/test/council-record.test.mjs` | I | existing; I may extend |
| `plugins/dsh-agos/lib/turn-evidence.js` | J | existing |
| `plugins/dsh-agos/test/turn-evidence.test.mjs` | J | existing if present; else new |
| `plugins/dsh-agos-router/lib/feedback-bind.mjs` | J | claimed new |
| `plugins/dsh-agos-router/test/feedback-bind.test.mjs` | J | claimed new |
| `scripts/test-all.sh` | K | existing |
| `scripts/iterate.sh` | K | existing |
| `frontend/scripts/vendor-diff.sh` | K | existing |
| `frontend/scripts/upgrade-dsh.sh` | K | read/fix check only; no pin move |
| `docs/engineering/agos-hardening-20260908/*` | controller | serial |
| `README.md` / `README.zh-CN.md` | K | factual check-scope only |

## Queue

| ID | P | Agent | Status | Reviewer | Depends |
|---|---|---|---|---|---|
| A | P1 | A-autoresearch | launched | L-exec | — |
| B | P1 | B-plan-approval | launched | L-exec | — |
| C | P1 | C-fleet-lifecycle | launched | L-exec | — |
| D | P1 | D-fleet-ledger | launched | L-exec | later C+D joint |
| E | P1 | E-approval-ui | launched | L-ui | — |
| F | P2 | F-secrets | launched | L-exec | callers after wire |
| G | P2 | G-history | launched | L-ui | — |
| H | P2 | H-skills-console | reviewed pass; no index wiring | L-ui pass | — |
| I | P2 | I-council | launched | L-exec | — |
| J | P2 | J-evidence | launched | L-exec | public types first |
| K | P2 | K-verify-scripts | launched | L-exec | — |
| L | gate | L-exec + L-ui | launched | — | rolling |

## Shared contracts (register before depending)

### J public types (controller will apply to router/agos index)

- Server, not client, sets feedback `source`.
- Ordinary outcome must cite an existing decision id.
- Duplicate feedback: same `(ref, result, source)` is idempotent; conflicting result is rejected.
- shadow-link must bind decision + real batch + applicable task; unused suggestion stays unknown.
- Distinct implementer/reviewer is required to learn; otherwise mark not-learnable, do not feed posterior.
- turn-evidence: bind host-provable `sessionId` plus `turn`/`step` when the host event has them; missing stays uncollected. Never invent a sequence.
- Persist result is independent of in-memory observation: `{ observed, persisted, persistError? }`.

### A/B/I CN helpers (controller wires `index.js`)

- A exports: `createIsolatedAutoresearchWorkspace`, `runAutoresearchIteration`, `extractStructuredMetric`, `disposeWorkspace`. Never mutates caller cwd/HEAD.
- B exports: `resolvePlanPath`, `openPlanFile`, `evaluatePlanApproval`, `approvalFingerprint`. Request `approve:true` / `approvedAt` / file existence are not authorization.
- I exports: `parseCouncilVerdict`, `evaluateCouncilStructure`. `{}` / missing fields / too few valid panelists ⇒ `parsedOk=false`, `consensus=false`.

### C/D Fleet

- C: live local runs come from this-process registry/controller; restart orphans are lost, not detached-forever.
- D: lock file beside ledger; owner + timeout + stale recovery; append + appendMany + compact all take the lock. Old JSONL remains readable.

### E/G live store (controller wires)

- Approval phases: `idle | pending | accepted | resolved | error`. Map deleted only after host evidence or proven stale for *this* callId/session.
- History: consume snapshot `header/hasMore/cursor/projections`; `session/page` uses `throughSeq` from snapshot cursor. Merge is seq-deduped; late pages for another session are dropped.

## Wiring queue (controller)

1. empty — waiting on first helper land.
2. After A/B/I helpers: CN index, then `plugins/cn-capabilities` tests.
3. After C/D/F: Fleet index (lifecycle → input limits), then long-run / two-process / cancel / recover.
4. After E/G: `live.ts` + transcript serial.
5. After H/J: agos/router index.

## Agent IDs (actual launches this turn)

Launched 2026-09-08 18:50 Asia/Shanghai. These are real Task IDs, not invented.

| ID | Role | Agent ID |
|---|---|---|
| A | autoresearch isolation | `fba9ba83-2af3-4043-8bae-2aa0e28f9d30` |
| B | plan approval / path | `2bb9b7b8-f9aa-499e-822c-0ff4377fccb4` |
| C | fleet local lifecycle | `3049fd54-3e1a-4aa8-acaa-26fa91bb58e3` |
| D | fleet ledger lock | `9cbdc9de-252b-4dbf-8782-e2f2dc090d83` |
| E | approval UI state | `50ae4857-9aee-4ac3-aedc-90d9135306e5` |
| F | secrets-gate | `0d7bf744-1e94-4bec-bf1d-4bd2c750221a` |
| G | history / health | `ca6e34d8-83fa-463b-87b0-d62f4d48fc41` |
| H | skills / console | `a64e0382-865a-4505-9a6f-b20ad824bb8c` |
| I | council parse | `45c8887e-b644-49aa-bd1c-563a4c4c3175` |
| J | evidence / feedback | `2ddc8069-7eb0-4364-b771-297fe1d8fac0` |
| K | verify scripts | `b7db6280-0ed9-4db1-88d6-8e039557fd35` |
| L-exec | persist review | `c57768ad-72b7-4e9a-9794-6c20955b0ff8` |
| L-ui | frontend/protocol review | `75bb585f-a195-41fe-ae3e-4e1f1e039bbb` |
| Repro | readonly reproduce | `1207e9da-3edb-444d-a8ba-6f735d9e0c36` |

## Rules for every worker

- You do not own the repo. No reset, clean, force-checkout, push, or format-all.
- Edit only owned files. If blocked on a hot file, write helpers/tests and a wiring note.
- Fake host, temp HOME, temp git. No real paid models, MCP writes, wake/sleep.
- Return: 复现/根因, 修改文件, 关键设计, 测试与退出码, 接线要求, 剩余风险.
