import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { decide } from '../lib/index.js'
import {
  appendLine,
  buildAnnotateRecord,
  buildOutcomeRecord,
  foldLedger,
  listRoutes,
  publicizeDecision,
  readLedgerLines,
} from '../lib/ledger.js'

test('fold overlays outcome without rewriting the decision line', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agos-ledger-'))
  const file = join(dir, 'route-outcome.jsonl')
  const record = await decide(
    {
      task: 'password is SuperSecret123 for NAS login',
      role: 'implementer',
      labeledCandidates: [
        { id: 'qwen', verified: true, label: 'coding' },
      ],
    },
    { auditFile: file },
  )
  assert.notEqual(record.rule.outcome, 'TRUST')
  const before = await readFile(file, 'utf8')
  const decisionLine = before.trim()
  assert.ok(!decisionLine.includes('SuperSecret'))
  const patch = buildOutcomeRecord({ ref: record.id, result: 'ok', source: 'manual', taskRef: record.taskRef, taskUnverified: true })
  appendLine(file, patch)
  const after = await readFile(file, 'utf8')
  assert.equal(after.split('\n')[0], decisionLine)
  const folded = foldLedger(readLedgerLines(file)).decisions
  assert.equal(folded[0].outcome, 'ok')
  const listed = listRoutes(file, 50)
  assert.equal(listed.stats.filled, 1)
  assert.equal(listed.stats.total, 1)
  assert.equal(listed.decisions[0].task, undefined)
  assert.equal(listed.decisions[0].taskRef, undefined, 'the public row must not leak the task fingerprint')
  assert.equal(publicizeDecision({ task: 'raw', taskRef: 'f'.repeat(64), pick: 'x' }).task, undefined)
  assert.equal(publicizeDecision({ task: 'raw', taskRef: 'f'.repeat(64), pick: 'x' }).taskRef, undefined)
})

test('caller-claimed verified:true is not TRUST (TASK-018 W4)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agos-rule-'))
  const file = join(dir, 'route-outcome.jsonl')
  const claimed = await decide(
    { role: 'reviewer', labeledCandidates: [{ id: 'a', verified: true }] },
    { auditFile: file },
  )
  assert.notEqual(claimed.rule.outcome, 'TRUST')
  assert.notEqual(claimed.rule.reason, 'gate-verified')
  assert.equal(claimed.rule.reason, 'no-signal')
})

test('capability descriptions are not clustering labels (TASK-018 W5)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agos-rule-'))
  const file = join(dir, 'route-outcome.jsonl')
  const rec = await decide(
    {
      role: 'planner',
      labeledCandidates: [
        { id: 'a', description: 'CN SQL coder', reason: 'CN SQL coder' },
        { id: 'b', description: 'CN docs', reason: 'CN docs' },
      ],
    },
    { auditFile: file },
  )
  assert.equal(rec.rule.outcome, 'ESCALATE')
  assert.equal(rec.rule.reason, 'no-signal')
})

test('taskCategory on the forced list yields forced-category (TASK-018 W6)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agos-rule-'))
  const file = join(dir, 'route-outcome.jsonl')
  const rec = await decide(
    { role: 'implementer', taskCategory: 'security', labeledCandidates: [{ id: 'a' }, { id: 'b' }] },
    { auditFile: file },
  )
  assert.equal(rec.rule.reason, 'forced-category')
  assert.equal(rec.rule.outcome, 'ESCALATE')
})

test('outcome ref/source go through sanitizePreview', () => {
  const ok = buildOutcomeRecord({ ref: 'dec-1-abcd', result: 'ok', source: 'manual' })
  assert.equal(ok.ref, 'dec-1-abcd')
  assert.equal(ok.source, 'manual')
  assert.throws(
    () => buildOutcomeRecord({ ref: 'API_KEY=abcd1234xyz', result: 'ok' }),
    /outcome ref is required/,
  )
  const long = buildOutcomeRecord({ ref: 'r'.repeat(200), result: 'fail', source: 's'.repeat(200) })
  assert.ok([...long.ref].length <= 80)
  assert.ok([...long.source].length <= 80)
})

test('annotate folds onto the decision without rewriting the history line', () => {
  const decision = { id: 'dec-1787366398334-afe1a751', ts: 1787366398334, pick: 'a', rule: { outcome: 'TRUST', reason: 'gate-verified' } }
  const mark = buildAnnotateRecord({ ref: decision.id, note: '剥 verified 前的探针记录' })
  assert.equal(mark.ev, 'annotate')
  assert.equal(mark.ref, decision.id)
  const { decisions } = foldLedger([decision, mark])
  assert.deepEqual(decisions[0].annotations, ['剥 verified 前的探针记录'])
  assert.equal(decisions[0].rule.reason, 'gate-verified')
  assert.equal(decisions.length, 1)
})

test('annotate 有活的 HTTP 调用方，不是「有实现、有单测、无调用方」的中间态', () => {
  // 2026-09-09:接线补丁落地后 recordAnnotation 为 async + appendLineAsync(异步锁);
  // 补丁前是 sync + appendLine。两种形状都算「有活的落盘路径」,别退回死代码即可。
  const src = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  assert.match(src, /buildAnnotateRecord/, 'index.js 没有引入写入端')
  assert.match(src, /'\/api\/agos\/routes\/annotate'/, 'annotate 没有 HTTP 入口')
  assert.match(src, /(?:async )?function recordAnnotation\(body\)\s*\{[\s\S]{0,300}appendLine(?:Async)?\(/, 'annotate 没有落盘路径')
})
