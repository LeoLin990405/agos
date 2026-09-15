import assert from 'node:assert/strict'
import test from 'node:test'

import { allocationStateFromLedger } from '../lib/assemble.js'
import { taskFingerprint } from '../lib/task-fingerprint.mjs'
import {
  FEEDBACK_CODES,
  OUTCOME_SOURCE_FLEET,
  OUTCOME_SOURCE_MANUAL,
  OUTCOME_SOURCE_REVIEWER,
  bindOrdinaryOutcome,
  bindShadowLink,
  bindShadowOutcome,
  detectForgedSource,
  evaluateReviewIndependence,
  filterLedgerForPosterior,
  gateReviewerVerdictFeed,
  resolveOutcomeSource,
  shouldEnterPosterior,
} from '../lib/feedback-bind.mjs'

const DEC = 'dec-1787000000000-abcdef12'
const DEC2 = 'dec-1787000000001-abcdef34'
const BATCH = 'b-f785f00d-8463-4369-9a02-4bf6dc7e3024'
const SHADOW = {
  id: DEC,
  ts: 1,
  mode: 'shadow',
  role: 'implementer',
  pick: 'leo-01',
  taskType: 'fleet-dispatch',
  label: 'fleet-dispatch',
  source: 'selector',
  outcome: null,
  shadow: { taskFingerprints: [taskFingerprint('write docs')] },
}
const batchEvidence = (host = 'leo-01', task = 'write docs') => new Map([[BATCH,
  new Map([['r-1', { host, index: 1, dispatchedAt: 2, taskFingerprint: taskFingerprint(task) }]])]])
const ORDINARY = {
  id: DEC2,
  ts: 2,
  taskType: 'coding',
  role: 'implementer',
  pick: 'qwen3.8-max',
  candidates: ['qwen3.8-max', 'minimax-m3', 'glm-5.2'],
  outcome: null,
}

test('server, not client, sets outcome source; client auto-review is forged', () => {
  assert.equal(resolveOutcomeSource('operator'), OUTCOME_SOURCE_MANUAL)
  assert.equal(resolveOutcomeSource('dispatch'), OUTCOME_SOURCE_REVIEWER)
  assert.equal(resolveOutcomeSource('shadow-backfill'), OUTCOME_SOURCE_FLEET)
  const forged = detectForgedSource('reviewer-verdict', 'operator')
  assert.equal(forged.forged, true)
  assert.equal(forged.source, OUTCOME_SOURCE_MANUAL)
  const fleetClaim = detectForgedSource('fleet-end', 'http')
  assert.equal(fleetClaim.forged, true)
  const honest = detectForgedSource('manual', 'operator')
  assert.equal(honest.forged, false)
  assert.equal(honest.source, OUTCOME_SOURCE_MANUAL)
  const dispatch = detectForgedSource('reviewer-verdict', 'dispatch')
  assert.equal(dispatch.forged, false)
  assert.equal(dispatch.source, OUTCOME_SOURCE_REVIEWER)
})

test('ordinary outcome rejects missing ref and unknown decision', () => {
  const missing = bindOrdinaryOutcome({
    body: { result: 'ok', source: 'manual' },
    rows: [ORDINARY],
    authority: 'operator',
  })
  assert.equal(missing.ok, false)
  assert.equal(missing.code, FEEDBACK_CODES.MISSING_REF)

  const blank = bindOrdinaryOutcome({
    body: { ref: '   ', result: 'ok' },
    rows: [ORDINARY],
    authority: 'operator',
  })
  assert.equal(blank.code, FEEDBACK_CODES.MISSING_REF)

  const unknown = bindOrdinaryOutcome({
    body: { ref: 'dec-1787999999999-deadbeef', result: 'ok' },
    rows: [ORDINARY],
    authority: 'operator',
  })
  assert.equal(unknown.ok, false)
  assert.equal(unknown.code, FEEDBACK_CODES.DECISION_NOT_FOUND)
})

test('forged client source pretending to be auto-review is rejected', () => {
  const forged = bindOrdinaryOutcome({
    body: { ref: DEC2, result: 'ok', source: 'reviewer-verdict' },
    rows: [ORDINARY],
    authority: 'operator',
  })
  assert.equal(forged.ok, false)
  assert.equal(forged.code, FEEDBACK_CODES.FORGED_SOURCE)
  assert.equal(forged.source, OUTCOME_SOURCE_MANUAL)
})

test('duplicate (ref,result,source) is idempotent; conflicting result is rejected', () => {
  const first = bindOrdinaryOutcome({
    body: { ref: DEC2, result: 'ok' },
    rows: [ORDINARY],
    authority: 'operator',
  })
  assert.equal(first.ok, true)
  assert.equal(first.idempotent, false)
  assert.equal(first.record.source, OUTCOME_SOURCE_MANUAL)
  assert.equal(first.record.result, 'ok')
  assert.equal(first.record.learnable, true)

  const rows = [ORDINARY, first.record]
  const again = bindOrdinaryOutcome({
    body: { ref: DEC2, result: 'ok', source: 'manual' },
    rows,
    authority: 'operator',
  })
  assert.equal(again.ok, true)
  assert.equal(again.idempotent, true)
  assert.equal(again.record, first.record)

  const clash = bindOrdinaryOutcome({
    body: { ref: DEC2, result: 'fail' },
    rows,
    authority: 'operator',
  })
  assert.equal(clash.ok, false)
  assert.equal(clash.code, FEEDBACK_CODES.CONFLICTING_RESULT)
})

test('wrong shadow bind is rejected; unused suggestion stays unknown', () => {
  const missingDecision = bindShadowLink({
    ref: DEC,
    batchId: BATCH,
    hosts: ['leo-01'],
    decisions: [ORDINARY],
    batches: [{ batchId: BATCH, taskType: 'fleet-dispatch' }],
  })
  assert.equal(missingDecision.ok, false)
  assert.equal(missingDecision.code, FEEDBACK_CODES.SHADOW_BIND_INVALID)

  const missingBatch = bindShadowLink({
    ref: DEC,
    batchId: BATCH,
    hosts: ['leo-01'],
    decisions: [SHADOW],
    batches: [],
  })
  assert.equal(missingBatch.ok, false)
  assert.equal(missingBatch.reason, 'BATCH')

  const wrongTask = bindShadowLink({
    ref: DEC,
    batchId: BATCH,
    hosts: ['leo-01'],
    decisions: [SHADOW],
    batches: batchEvidence('leo-01', 'wrong task'),
    task: 'coding',
  })
  assert.equal(wrongTask.ok, false)
  assert.equal(wrongTask.reason, 'TASK')

  const unused = bindShadowLink({
    ref: DEC,
    batchId: BATCH,
    hosts: ['knowledge-m4'],
    decisions: [SHADOW],
    batches: batchEvidence('knowledge-m4'),
  })
  assert.equal(unused.ok, true)
  assert.equal(unused.adopted, false)
  assert.equal(unused.outcome, null)
  assert.equal(unused.unknown, true)

  const backfill = bindShadowOutcome({
    decision: SHADOW,
    link: unused.record,
    batchRuns: new Map([['r-1', { host: 'knowledge-m4', ended: true, ok: true }]]),
  })
  assert.equal(backfill.outcome, null)
  assert.equal(backfill.unknown, true)
  assert.equal(backfill.adopted, false)
})

test('adopted shadow batch can resolve; counterfactual unused never becomes a win', () => {
  const linked = bindShadowLink({
    ref: DEC,
    batchId: BATCH,
    hosts: ['leo-01'],
    decisions: [SHADOW],
    batches: batchEvidence(),
  })
  assert.equal(linked.ok, true)
  assert.equal(linked.adopted, true)
  assert.equal(linked.outcome, null)

  const won = bindShadowOutcome({
    decision: SHADOW,
    link: linked.record,
    batchRuns: new Map([['r-1', { host: 'leo-01', ended: true, ok: true }]]),
  })
  assert.equal(won.outcome, 'ok')
  assert.equal(won.source, OUTCOME_SOURCE_FLEET)

  const operator = bindOrdinaryOutcome({
    body: { ref: DEC, result: 'ok' },
    rows: [SHADOW],
    authority: 'operator',
  })
  assert.equal(operator.code, FEEDBACK_CODES.SHADOW_MANUAL_OUTCOME)
})

test('self-review and tiny pool are not-learnable and must not enter posterior', () => {
  const self = evaluateReviewIndependence({
    implementer: 'qwen3.8-max',
    reviewer: 'Qwen3.8-Max',
    candidates: ['qwen3.8-max', 'glm-5.2'],
  })
  assert.equal(self.independent, false)
  assert.equal(self.learnable, false)
  assert.equal(self.skip, FEEDBACK_CODES.NOT_INDEPENDENT)

  const tiny = evaluateReviewIndependence({
    implementer: 'qwen3.8-max',
    reviewer: 'qwen3.8-max',
    candidates: ['qwen3.8-max'],
  })
  assert.equal(tiny.skip, FEEDBACK_CODES.POOL_TOO_SMALL)
  assert.equal(tiny.rejectReview, true)

  const ok = gateReviewerVerdictFeed({
    assemble: {
      roles: [
        { role: 'planner', model: 'glm-5.2' },
        { role: 'implementer', model: 'qwen3.8-max' },
        { role: 'reviewer', model: 'minimax-m3' },
      ],
    },
    turns: [
      { role: 'implementer', model: 'qwen3.8-max', ok: true },
      { role: 'reviewer', model: 'minimax-m3', ok: true },
    ],
    candidates: ['glm-5.2', 'qwen3.8-max', 'minimax-m3'],
  })
  assert.equal(ok.feed, true)
  assert.equal(ok.learnable, true)

  const booked = bindOrdinaryOutcome({
    body: { ref: DEC2, result: 'ok', judge: 'qwen3.8-max', judged: 'qwen3.8-max' },
    rows: [ORDINARY],
    authority: 'dispatch',
    implementer: 'qwen3.8-max',
    reviewer: 'qwen3.8-max',
    candidates: ['qwen3.8-max'],
  })
  assert.equal(booked.ok, true)
  assert.equal(booked.record.source, OUTCOME_SOURCE_REVIEWER)
  assert.equal(booked.record.learnable, false)
  assert.equal(booked.feed, false)
  assert.equal(shouldEnterPosterior(booked.record), false)

  const ledger = [
    ORDINARY,
    booked.record,
    { id: 'dec-1787000000002-abcdef56', ts: 3, taskType: 'coding', role: 'implementer', pick: 'minimax-m3', outcome: null },
    { kind: 'outcome', ref: 'dec-1787000000002-abcdef56', result: 'ok', source: 'manual', learnable: true },
  ]
  const raw = allocationStateFromLedger(ledger)
  assert.equal(raw.some((cell) => cell.agent === 'qwen3.8-max'), false, 'production allocation entry filters self-review itself')
  const filtered = allocationStateFromLedger(filterLedgerForPosterior(ledger))
  assert.equal(filtered.some((cell) => cell.agent === 'qwen3.8-max'), false)
  assert.deepEqual(filtered, [{ taskType: 'coding', agent: 'minimax-m3', s: 1, f: 0 }])
})
