// C3 — the original task identity is bound to the decision, the trial, the verdict
// and the outcome, and cross-task reuse or replay is refused rather than absorbed.
//
// Every refusal below has its own case, and each asserts the *absence* of a booking,
// not just a non-200: a gate that returns an error while still writing the row is
// worse than no gate, because the ledger then disagrees with the response.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { decide } from '../lib/index.js'
import { appendLine, buildDecisionRecord, buildOutcomeRecord, foldLedger, readLedgerLines } from '../lib/ledger.js'
import { assembleTeam, buildAssembleRecord, allocationStateFromLedger } from '../lib/assemble.js'
import { dispatchTeam } from '../lib/dispatch.js'
import { FEEDBACK_CODES, bindOrdinaryOutcome, checkTaskBinding, decisionTaskRef } from '../lib/feedback-bind.mjs'
import { taskFingerprint } from '../lib/task-fingerprint.mjs'
import { mintAssembleId, mintDecisionId } from '../lib/ids.js'

const TASK_X = '把 orders 表的月度汇总写成一个 SQL 视图，并说明索引选择'
const TASK_Y = '给 README 补一段部署说明，列出三个环境变量'

const decisionFor = (task, overrides = {}) => ({
  id: mintDecisionId(),
  ts: 1788000000000,
  taskType: 'coding',
  role: 'implementer',
  label: 'coding',
  pick: 'qwen3.8-max',
  candidates: ['qwen3.8-max', 'minimax-m3', 'glm-5.2'],
  source: 'selector',
  taskRef: taskFingerprint(task),
  outcome: null,
  ...overrides,
})

const teamFor = (decision) => ({
  id: mintAssembleId(),
  ref: decision.id,
  taskRef: decision.taskRef,
  roles: [
    { role: 'planner', model: 'glm-5.2' },
    { role: 'implementer', model: 'qwen3.8-max' },
    { role: 'reviewer', model: 'minimax-m3' },
  ],
})

const passingReviewer = async ({ role }) => (role === 'reviewer' ? '判定：通过\n实现覆盖了要求。' : `${role} 文本`)

// ─────────────────────────── the chain is actually built ───────────────────────────

test('the original task identity reaches the decision, the proposal, the trial and the outcome', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'agos-taskbind-'))
  const file = join(dir, 'route-outcome.jsonl')
  const expected = taskFingerprint(TASK_X)

  // Decision: hashed from the full task, before any preview clipping, and the raw
  // text never lands in the row.
  const decision = await decide({ task: TASK_X, role: 'implementer', taskType: 'coding', candidates: [{ id: 'qwen3.8-max' }, { id: 'minimax-m3' }] }, { auditFile: file })
  assert.equal(decision.taskRef, expected)
  assert.equal(decision.task, undefined)
  assert.ok(!JSON.stringify(decision).includes('orders 表的月度汇总'))

  // Proposal carries it forward.
  const assemble = buildAssembleRecord(decision, assembleTeam(decision, [], {}))
  assert.equal(assemble.taskRef, expected)

  // Trial and verdict.
  const rows = readLedgerLines(file)
  const appended = []
  const result = await dispatchTeam({ ...assemble, roles: teamFor(decision).roles, ref: decision.id }, { confirm: true, task: TASK_X }, {
    readRows: () => [...rows, ...appended],
    append: (row) => { appended.push(row); appendLine(file, row) },
    streamRole: passingReviewer,
  })
  assert.equal(result.dispatch.taskRef, expected)
  assert.equal(result.dispatch.verdictFed, true)
  assert.equal(result.dispatch.verdictSkip, null)

  const outcome = appended.find((row) => row.kind === 'outcome')
  assert.ok(outcome, 'the accept path must actually book an outcome')
  assert.equal(outcome.taskRef, expected, 'the outcome must record which task was judged')
  assert.equal(outcome.ref, decision.id)
  assert.equal(outcome.source, 'reviewer-verdict')

  // And the whole chain agrees, which is the point: decision, trial and outcome
  // can be re-checked against each other later without trusting anyone's word.
  assert.equal(new Set([decision.taskRef, assemble.taskRef, result.dispatch.taskRef, outcome.taskRef]).size, 1)
  t.diagnostic(`bound taskRef ${expected.slice(0, 16)}…`)
})

// ─────────────────────────── refusal: cross-task verdict ───────────────────────────

test('NEGATIVE: a verdict computed for task Y is refused against a decision for task X', () => {
  const decision = decisionFor(TASK_X)
  const rows = [decision]

  const crossed = bindOrdinaryOutcome({
    authority: 'dispatch',
    body: { ref: decision.id, result: 'ok' },
    rows,
    implementer: 'qwen3.8-max',
    reviewer: 'minimax-m3',
    taskRef: taskFingerprint(TASK_Y),
  })
  assert.equal(crossed.ok, false)
  assert.equal(crossed.code, FEEDBACK_CODES.TASK_MISMATCH)
  assert.equal(crossed.expected, undefined, 'the decision fingerprint must never be echoed back')
  assert.equal(crossed.claimed, taskFingerprint(TASK_Y), 'the caller own claimed value is echoed for debugging')
  assert.equal(crossed.record, undefined, 'a refused verdict must not hand back a bookable row')

  // Same task ⇒ accepted, so the gate discriminates rather than blocking everything.
  const same = bindOrdinaryOutcome({
    authority: 'dispatch',
    body: { ref: decision.id, result: 'ok' },
    rows,
    implementer: 'qwen3.8-max',
    reviewer: 'minimax-m3',
    taskRef: taskFingerprint(TASK_X),
  })
  assert.equal(same.ok, true)
  assert.equal(same.record.taskRef, taskFingerprint(TASK_X))
})

test('NEGATIVE: a reviewer verdict that states no task at all is refused when the decision has one', () => {
  const decision = decisionFor(TASK_X)
  const silent = bindOrdinaryOutcome({
    authority: 'dispatch',
    body: { ref: decision.id, result: 'ok' },
    rows: [decision],
    implementer: 'qwen3.8-max',
    reviewer: 'minimax-m3',
  })
  assert.equal(silent.ok, false)
  assert.equal(silent.code, FEEDBACK_CODES.TASK_MISMATCH)
  assert.equal(silent.claimed, undefined, 'nothing was claimed, and the decision fingerprint is never echoed')

  // An operator pressing "record success" is not judging a task, so the manual path
  // still works — otherwise the gate would silently disable human feedback. The
  // binding is honestly marked unverified ON DISK: the row carries the decision's
  // fingerprint for later correlation plus a taskUnverified marker, instead of
  // being byte-identical to a verified row.
  const manual = bindOrdinaryOutcome({ authority: 'operator', body: { ref: decision.id, result: 'ok' }, rows: [decision] })
  assert.equal(manual.ok, true)
  assert.equal(manual.record.taskRef, taskFingerprint(TASK_X))
  assert.equal(manual.record.taskUnverified, true)
  assert.equal(manual.taskUnverified, true)

  // A client claiming the wrong task is refused on the manual path too.
  const lying = bindOrdinaryOutcome({
    authority: 'operator',
    body: { ref: decision.id, result: 'ok', taskRef: taskFingerprint(TASK_Y) },
    rows: [decision],
  })
  assert.equal(lying.code, FEEDBACK_CODES.TASK_MISMATCH)
})

test('NEGATIVE: a cross-task trial books nothing end to end, and the posterior stays empty', async () => {
  const decision = decisionFor(TASK_X)
  const rows = [decision]
  const appended = []

  // The proposal points at a decision made for TASK_X, but the trial runs TASK_Y.
  const result = await dispatchTeam(teamFor(decision), { confirm: true, task: TASK_Y }, {
    readRows: () => [...rows, ...appended],
    append: (row) => appended.push(row),
    streamRole: passingReviewer,
  })

  assert.equal(result.dispatch.verdict, 'ok', 'the reviewer really did return a verdict')
  assert.equal(result.dispatch.taskRef, taskFingerprint(TASK_Y))
  assert.equal(result.dispatch.verdictFed, false, 'a verdict about another task must not be booked')
  assert.equal(result.dispatch.verdictSkip, FEEDBACK_CODES.TASK_MISMATCH)
  assert.equal(appended.filter((row) => row.kind === 'outcome').length, 0)
  assert.deepEqual(allocationStateFromLedger([...rows, ...appended]), [])
})

test('checkTaskBinding leaves pre-taskRef history bindable and says so', () => {
  const legacy = decisionFor(TASK_X, { taskRef: undefined })
  delete legacy.taskRef
  assert.equal(decisionTaskRef(legacy), null)

  const bound = checkTaskBinding({ decision: legacy, claimed: taskFingerprint(TASK_Y), source: 'reviewer-verdict' })
  assert.equal(bound.ok, true, 'a row that never recorded a task cannot contradict one')
  assert.equal(bound.unverified, true)
  assert.equal(bound.taskRef, null, 'do not invent a fingerprint for a legacy row')

  // Garbage never counts as a match.
  const real = decisionFor(TASK_X)
  assert.equal(checkTaskBinding({ decision: real, claimed: 'not-a-hash', source: 'manual' }).unverified, true)
  assert.equal(checkTaskBinding({ decision: real, claimed: 'A'.repeat(64), source: 'reviewer-verdict' }).ok, false)
})

// ─────────────────────────── refusal: replay ───────────────────────────

test('NEGATIVE: a replayed submission is refused, and a duplicate never double-counts the posterior', () => {
  const decision = decisionFor(TASK_X)
  const body = { ref: decision.id, result: 'ok', nonce: 'trial-abc123', taskRef: taskFingerprint(TASK_X) }

  const first = bindOrdinaryOutcome({ authority: 'operator', body, rows: [decision] })
  assert.equal(first.ok, true)
  assert.equal(first.idempotent, false)
  assert.equal(first.record.nonce, 'trial-abc123')

  // The very same submission arriving again is named as a replay, not absorbed.
  const replay = bindOrdinaryOutcome({ authority: 'operator', body, rows: [decision, first.record] })
  assert.equal(replay.ok, false)
  assert.equal(replay.code, FEEDBACK_CODES.REPLAYED)
  assert.equal(replay.record, undefined)

  // A retry without a nonce is deduplicated rather than refused, and appends nothing.
  const retry = bindOrdinaryOutcome({ authority: 'operator', body: { ref: decision.id, result: 'ok' }, rows: [decision, first.record] })
  assert.equal(retry.ok, true)
  assert.equal(retry.idempotent, true)
  assert.equal(retry.record, first.record)

  // Even if duplicates did reach disk, one decision contributes one observation.
  const doubled = [decision, first.record, { ...first.record }, { ...first.record }]
  assert.deepEqual(allocationStateFromLedger(doubled), [{ taskType: 'coding', agent: 'qwen3.8-max', s: 1, f: 0 }])
})

test('NEGATIVE: replaying a whole trial cannot book a second verdict for the same decision', async () => {
  const decision = decisionFor(TASK_X)
  const team = teamFor(decision)
  const rows = [decision]
  const appended = []
  const deps = {
    readRows: () => [...rows, ...appended],
    append: (row) => appended.push(row),
    streamRole: passingReviewer,
  }

  const first = await dispatchTeam(team, { confirm: true, task: TASK_X }, deps)
  assert.equal(first.dispatch.verdictFed, true)
  assert.equal(appended.filter((row) => row.kind === 'outcome').length, 1)

  // Re-run the identical trial against the identical proposal. The decision already
  // has a result, so the second verdict is displayed but never booked again.
  const second = await dispatchTeam(team, { confirm: true, task: TASK_X }, deps)
  assert.equal(second.dispatch.verdict, 'ok')
  assert.equal(second.dispatch.verdictSkip, 'ALREADY_JUDGED')
  assert.equal(appended.filter((row) => row.kind === 'outcome').length, 1, 'the posterior was fed twice')
  assert.deepEqual(
    allocationStateFromLedger([...rows, ...appended]),
    [{ taskType: 'coding', agent: 'qwen3.8-max', s: 1, f: 0 }],
  )
})

test('the same-model reviewer gate still fires before the task gate is even reachable', async () => {
  // C4 keeps the independent-review requirement. A self-review must be blocked
  // before any provider call, whatever the task binding says.
  const decision = decisionFor(TASK_X, { pick: 'qwen3.8-max' })
  const called = []
  const appended = []
  const result = await dispatchTeam({
    id: mintAssembleId(),
    ref: decision.id,
    roles: [
      { role: 'planner', model: 'glm-5.2' },
      { role: 'implementer', model: 'qwen3.8-max' },
      { role: 'reviewer', model: 'qwen3.8-max' },
    ],
  }, { confirm: true, task: TASK_X }, {
    readRows: () => [decision, ...appended],
    append: (row) => appended.push(row),
    streamRole: async ({ role }) => { called.push(role); return role === 'reviewer' ? '判定：通过' : 'text' },
  })
  assert.deepEqual(called, ['planner', 'implementer'], 'the reviewer provider must never be called')
  assert.equal(result.dispatch.verdictFed, false)
  assert.match(result.dispatch.verdictSkip, /NOT_INDEPENDENT|POOL_TOO_SMALL/)
  assert.equal(appended.some((row) => row.kind === 'outcome'), false)
})

test('an outcome row keeps its task binding through fold and is not forgeable by ref alone', () => {
  const decision = decisionFor(TASK_X)
  const outcome = buildOutcomeRecord({ ref: decision.id, result: 'ok', source: 'reviewer-verdict', taskRef: decision.taskRef })
  assert.equal(outcome.taskRef, decision.taskRef)
  const folded = foldLedger([decision, outcome]).decisions[0]
  assert.equal(folded.outcome, 'ok')
  assert.equal(folded.taskRef, decision.taskRef)

  // A junk fingerprint is dropped rather than stored as if it were real.
  assert.equal('taskRef' in buildOutcomeRecord({ ref: decision.id, result: 'ok', taskRef: 'nope' }), false)

  // Two decisions for two tasks stay distinguishable even with identical everything else.
  const other = buildDecisionRecord({ task: TASK_Y, taskType: 'coding', candidates: [] }, { role: 'implementer', pick: 'qwen3.8-max' }, 'selector')
  assert.notEqual(other.taskRef, decision.taskRef)
})
