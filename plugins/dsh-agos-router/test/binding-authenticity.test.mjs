// 2026-09-09 Luna 核查 P1 — 绑定真实性(binding authenticity)。
//
// 三个原本各自沉默的洞,合起来让「未核验」在磁盘上等于「已核验」:
//   1. checkTaskBinding 的 unverified 只活在内存返回值里,bindOrdinaryOutcome
//      无条件把 taskRef 写进记录 —— 磁盘上两种行字节相同,事后审计无法区分;
//   2. publicizeDecision 剥了 task 没剥 taskRef:从 GET /api/agos/routes 读到
//      指纹再回显,就能把 unverified 翻成 verified(该哈希是截断前全文 sha256,
//      公开它还构成确认预言机);
//   3. foldLedger 按 ref 合并 outcome,重载落盘数据后不再重验:别的任务的
//      outcome 行(同 ref、异指纹)会被当幂等吸收,posterior 计上别家的胜负。
//
// 这里每条都同时断言「行为」与「磁盘字节形状」:只断言返回值等于没修。
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { decide } from '../lib/index.js'
import {
  appendLine,
  buildOutcomeRecord,
  foldLedger,
  listRoutes,
  outcomeMatchesDecision,
  readLedgerLines,
} from '../lib/ledger.js'
import { FEEDBACK_CODES, bindOrdinaryOutcome } from '../lib/feedback-bind.mjs'
import { allocationStateFromLedger } from '../lib/assemble.js'
import { taskFingerprint } from '../lib/task-fingerprint.mjs'

const TASK_X = '把 orders 表的月度汇总写成一个 SQL 视图，并说明索引选择'
const TASK_Y = '给 README 补一段部署说明，列出三个环境变量'
const REF = 'dec-1788000000000-0000001'

const decisionRow = (task = TASK_X) => ({
  id: REF,
  ts: 1788000000000,
  taskType: 'coding',
  role: 'implementer',
  label: 'coding',
  pick: 'qwen3.8-max',
  candidates: ['qwen3.8-max', 'minimax-m3', 'glm-5.2'],
  source: 'selector',
  outcome: null,
  taskRef: taskFingerprint(task),
})

test('unverified binding is visibly unverified ON DISK, byte-distinguishable from verified', () => {
  const decision = decisionRow()

  // Manual path, no claimed fingerprint: accepted but unverified — the marker persists.
  const manual = bindOrdinaryOutcome({ authority: 'operator', body: { ref: REF, result: 'ok' }, rows: [decision] })
  assert.equal(manual.ok, true)
  assert.equal(manual.taskUnverified, true)
  assert.equal(manual.record.taskRef, taskFingerprint(TASK_X), 'carries the decision fingerprint for correlation')
  assert.equal(manual.record.taskUnverified, true, 'unverified marker must be on the row itself')

  // Reviewer path with a correct claim: verified — no marker, same taskRef field.
  const verdict = bindOrdinaryOutcome({
    authority: 'dispatch',
    body: { ref: REF, result: 'ok' },
    rows: [decision],
    implementer: 'qwen3.8-max',
    reviewer: 'minimax-m3',
    taskRef: taskFingerprint(TASK_X),
  })
  assert.equal(verdict.ok, true)
  assert.equal(verdict.taskUnverified, false)
  assert.equal(verdict.record.taskRef, taskFingerprint(TASK_X))
  assert.equal('taskUnverified' in verdict.record, false, 'a verified row must not carry the marker')

  // The whole point: the two disk rows must NOT be byte-identical.
  assert.notEqual(
    JSON.stringify(manual.record),
    JSON.stringify({ ...verdict.record, at: manual.record.at }),
    'unverified and verified rows were indistinguishable on disk',
  )
})

test('legacy decisions (no fingerprint) still bind, honestly marked', () => {
  const legacy = decisionRow()
  delete legacy.taskRef
  const bound = bindOrdinaryOutcome({ authority: 'operator', body: { ref: REF, result: 'fail' }, rows: [legacy] })
  assert.equal(bound.ok, true)
  assert.equal(bound.record.taskUnverified, true)
  assert.equal('taskRef' in bound.record, false, 'do not invent a fingerprint for a legacy row')
  // And a legacy row stays countable — refusing it would make all history permanently un-annotatable.
  assert.deepEqual(
    allocationStateFromLedger([legacy, bound.record]),
    [{ taskType: 'coding', agent: 'qwen3.8-max', s: 0, f: 1 }],
  )
})

test('LUNA counterexample: an outcome fingerprinted for task Y never overlays decision for task X', () => {
  const decision = decisionRow(TASK_X)
  const foreign = buildOutcomeRecord({
    ref: REF,
    result: 'ok',
    source: 'reviewer-verdict',
    taskRef: taskFingerprint(TASK_Y),
  })
  assert.equal(outcomeMatchesDecision(foreign, decision), false)

  const rows = [decision, foreign]
  const folded = foldLedger(rows).decisions[0]
  assert.equal(folded.outcome, null, 'a foreign-task outcome must not credit this decision')
  assert.deepEqual(allocationStateFromLedger(rows), [], 'the posterior must not count another task’s win')
})

test('after reload, a same-result submission with the right fingerprint is NOT absorbed by a foreign-task row', () => {
  const decision = decisionRow(TASK_X)
  // Pre-fix row shapes sitting on disk: same ref, fingerprint of task Y, marked or not.
  const foreignVerified = buildOutcomeRecord({
    ref: REF, result: 'ok', source: 'reviewer-verdict', taskRef: taskFingerprint(TASK_Y),
  })
  const rows = [decision, foreignVerified]

  // The replay: same result, but THIS submission actually states task X.
  const resubmitted = bindOrdinaryOutcome({
    authority: 'dispatch',
    body: { ref: REF, result: 'ok' },
    rows,
    implementer: 'qwen3.8-max',
    reviewer: 'minimax-m3',
    taskRef: taskFingerprint(TASK_X),
  })
  assert.equal(resubmitted.ok, true)
  assert.equal(resubmitted.idempotent, false, 'a foreign-task row must not idempotently absorb a verified submission')
  assert.equal(resubmitted.record.taskRef, taskFingerprint(TASK_X))
  assert.notEqual(resubmitted.record.taskUnverified, true)

  // And after the fresh verified row lands, the decision finally counts — exactly once.
  const reloaded = [...rows, resubmitted.record]
  assert.equal(foldLedger(reloaded).decisions[0].outcome, 'ok')
  assert.deepEqual(allocationStateFromLedger(reloaded), [{ taskType: 'coding', agent: 'qwen3.8-max', s: 1, f: 0 }])
})

test('after reload, an opposite-result verified submission is not blocked by a foreign-task row as "conflict"', () => {
  const decision = decisionRow(TASK_X)
  const foreignOk = buildOutcomeRecord({
    ref: REF, result: 'ok', source: 'manual', taskRef: taskFingerprint(TASK_Y),
  })
  const failing = bindOrdinaryOutcome({
    authority: 'dispatch',
    body: { ref: REF, result: 'fail' },
    rows: [decision, foreignOk],
    implementer: 'qwen3.8-max',
    reviewer: 'minimax-m3',
    taskRef: taskFingerprint(TASK_X),
  })
  assert.equal(failing.ok, true, 'foreign-task "history" is not history for this decision')
  assert.equal(failing.record.result, 'fail')
  // last valid row wins in fold, and only the verified fail counts
  assert.deepEqual(
    allocationStateFromLedger([decision, foreignOk, failing.record]),
    [{ taskType: 'coding', agent: 'qwen3.8-max', s: 0, f: 1 }],
  )
})

test('a verified conflict against a VERIFIED prior is still refused (改判不改史 not weakened)', () => {
  const decision = decisionRow(TASK_X)
  const first = bindOrdinaryOutcome({
    authority: 'dispatch',
    body: { ref: REF, result: 'ok' },
    rows: [decision],
    implementer: 'qwen3.8-max',
    reviewer: 'minimax-m3',
    taskRef: taskFingerprint(TASK_X),
  })
  const clash = bindOrdinaryOutcome({
    authority: 'dispatch',
    body: { ref: REF, result: 'fail' },
    rows: [decision, first.record],
    implementer: 'qwen3.8-max',
    reviewer: 'minimax-m3',
    taskRef: taskFingerprint(TASK_X),
  })
  assert.equal(clash.ok, false)
  assert.equal(clash.code, FEEDBACK_CODES.CONFLICTING_RESULT)
})

test('an unverified row absorbs a same-result verified echo without flipping its disk state', () => {
  const decision = decisionRow(TASK_X)
  const manual = bindOrdinaryOutcome({ authority: 'operator', body: { ref: REF, result: 'ok' }, rows: [decision] })
  const rows = [decision, manual.record]
  assert.equal(foldLedger(rows).decisions[0].outcome, 'ok', 'unverified manual feedback still counts once')

  // The old attack: read the fingerprint somewhere, echo it back. Same result ⇒ absorbed.
  const echoed = bindOrdinaryOutcome({
    authority: 'operator',
    body: { ref: REF, result: 'ok', taskRef: taskFingerprint(TASK_X) },
    rows,
  })
  assert.equal(echoed.ok, true)
  assert.equal(echoed.idempotent, true)
  assert.equal(echoed.record.taskUnverified, true, 'the stored row keeps saying what it was: not verified')
})

test('fold survives malformed rows and unbindable outcome shapes without crashing or miscounting', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agos-bind-auth-'))
  try {
    const file = join(dir, 'route-outcome.jsonl')
    const decision = decisionRow(TASK_X)
    // One malformed line, one foreign fingerprint, one unattributable row with NO
    // taskRef at all (never written by any production build on a fingerprinted
    // decision — the bind layer always carried expected — so fold cannot prove
    // it is about this task and must not credit it).
    await writeFile(file, [
      JSON.stringify(decision),
      '{"kind":"outcome","ref":"dec-1788000000000-0000001","result":"ok",',
      JSON.stringify(buildOutcomeRecord({ ref: REF, result: 'fail', source: 'manual', taskRef: taskFingerprint(TASK_Y) })),
      JSON.stringify({ kind: 'outcome', ref: REF, result: 'ok', at: 1, source: 'manual' }),
    ].join('\n') + '\n')
    const rows = readLedgerLines(file)
    assert.equal(rows.length, 3, 'the torn line is rejected, everything else parses')
    // Last-wins per ref: the no-taskRef row is newest, so ordering alone would
    // credit it — revalidation must still say "unattributable, pending".
    assert.equal(foldLedger(rows).decisions[0].outcome, null)
    assert.deepEqual(allocationStateFromLedger(rows), [])
    // And even with the foreign row newest (ordering winner), the answer is the same.
    const swapped = [rows[0], rows[2], rows[1]]
    assert.equal(foldLedger(swapped).decisions[0].outcome, null,
      'foreign-task row wins ordering but must be revalidated away')
    assert.deepEqual(allocationStateFromLedger(swapped), [])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('public list output never carries the task fingerprint (oracle + echo upgrade closed at the surface)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agos-bind-pub-'))
  try {
    const file = join(dir, 'route-outcome.jsonl')
    const decision = await decide(
      { task: TASK_X, role: 'implementer', taskType: 'coding', candidates: [{ id: 'qwen3.8-max' }, { id: 'minimax-m3' }] },
      { auditFile: file },
    )
    const listed = listRoutes(file, 50)
    assert.equal(listed.decisions[0].task, undefined)
    assert.equal(listed.decisions[0].taskRef, undefined, 'GET /routes must not leak the full-text sha256')
    assert.ok(
      !JSON.stringify(listed).includes(taskFingerprint(TASK_X)),
      'the fingerprint must not appear anywhere in the public payload',
    )
    // sanity: it IS on the raw decision row (needed for binding checks)
    assert.equal(readLedgerLines(file)[0].taskRef, decision.taskRef)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('bindOrdinaryOutcome never echoes the decision fingerprint in a TASK_MISMATCH refusal', () => {
  const decision = decisionRow(TASK_X)
  const refusal = bindOrdinaryOutcome({
    authority: 'dispatch',
    body: { ref: REF, result: 'ok' },
    rows: [decision],
    implementer: 'qwen3.8-max',
    reviewer: 'minimax-m3',
    taskRef: taskFingerprint(TASK_Y),
  })
  assert.equal(refusal.code, FEEDBACK_CODES.TASK_MISMATCH)
  assert.ok(
    !JSON.stringify(refusal).includes(taskFingerprint(TASK_X)),
    'refusing must not confirm which hash the decision carries',
  )
})

test('round-trip through the real ledger file: unverified marker survives reload from disk', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agos-bind-rt-'))
  try {
    const file = join(dir, 'route-outcome.jsonl')
    const decision = await decide(
      { task: TASK_X, role: 'implementer', taskType: 'coding', candidates: [{ id: 'qwen3.8-max' }, { id: 'minimax-m3' }] },
      { auditFile: file },
    )
    const manual = bindOrdinaryOutcome({ authority: 'operator', body: { ref: decision.id, result: 'ok' }, rows: readLedgerLines(file) })
    appendLine(file, manual.record)

    const raw = JSON.parse((await readFile(file, 'utf8')).trim().split('\n')[1])
    assert.equal(raw.taskUnverified, true, 'the marker is on the bytes, not just in memory')
    assert.equal(foldLedger(readLedgerLines(file)).decisions[0].outcome, 'ok')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
