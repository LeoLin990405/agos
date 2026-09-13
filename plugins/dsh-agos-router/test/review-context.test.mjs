// 2026-09-09 Luna 核查 P1 — 评审上下文截断(review context truncation)。
//
// 旧形状:实现结果的 turn 行被 sanitizePreview 截到 400 字且无任何提示,
// 而评审提示词从这行(以及 80 字任务预览)取材 —— 头部注释却宣称 4000 字窗口。
// 评审实际看到的是碎片,verdictFed 仍为 true:局部的「通过」被当成完整审阅喂进后验。
//
// 修复后的契约(这里逐条钉死):
//   1. turn 行 = 台账/展示预览:400 字上限,截断时带显式 truncationNotice;
//   2. 评审材料 = 原始流式文本,独立预算(REVIEWER_TASK_LIMIT / REVIEWER_RESULT_LIMIT),
//      截断时提示词内显式声明;
//   3. 诚实门:任一评审窗口被截断,判定照常展示,但 verdictSkip 写明
//      REVIEW_TASK_TRUNCATED / REVIEW_RESULT_TRUNCATED,verdictFed=false,不入后验。
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  REVIEWER_RESULT_LIMIT,
  REVIEWER_TASK_LIMIT,
  REVIEW_RESULT_TRUNCATED,
  REVIEW_TASK_TRUNCATED,
  TURN_TEXT_LIMIT,
  boundedSection,
  dispatchTeam,
  previewTurnText,
  roleUserPrompt,
  truncationNotice,
} from '../lib/dispatch.js'
import { allocationStateFromLedger } from '../lib/assemble.js'

const TEAM = {
  id: 'asm-ctx',
  ref: 'dec-ctx-1',
  roles: [
    { role: 'planner', model: 'glm-5.2' },
    { role: 'implementer', model: 'qwen3.8-max' },
    { role: 'reviewer', model: 'minimax-m3' },
  ],
}
const DECISION = {
  id: 'dec-ctx-1', ts: 1, taskType: 'coding', role: 'implementer', label: 'coding',
  pick: 'qwen3.8-max', candidates: ['qwen3.8-max', 'minimax-m3', 'glm-5.2'], outcome: null,
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

test('turn row is a bounded preview with an explicit notice; review material is the raw text', async () => {
  const longResult = `R${'实现终稿第若干段 '.repeat(60)}TAIL-MARKER`
  assert.ok([...longResult].length > TURN_TEXT_LIMIT)
  const calls = []

  const result = await dispatchTeam(TEAM, { confirm: true, task: '整理 SQL' }, {
    readRows: () => [DECISION],
    append: () => {},
    streamRole: async (input) => {
      calls.push(input)
      if (input.role === 'reviewer') return '判定：通过\n完整看到了实现终稿。'
      return longResult
    },
  })

  const implementer = result.dispatch.turns.find((row) => row.role === 'implementer')
  // Row: clipped to the preview budget AND honest about it.
  assert.equal([...implementer.text.split('\n')[0]].length, TURN_TEXT_LIMIT)
  assert.match(implementer.text, new RegExp(escapeRe(truncationNotice(TURN_TEXT_LIMIT, [...longResult].length - TURN_TEXT_LIMIT))))
  assert.ok(!implementer.text.includes('TAIL-MARKER'), 'the row must not silently contain a fragment end it cannot show')

  // The ACTUAL reviewer prompt (not a recomposed one): full text, marker preserved,
  // budget is the reviewer's — not the 400-char row preview's. (The prompt necessarily
  // SHARES a prefix with the row preview — the preview is a prefix of the raw text —
  // so the discriminator is the tail and the absence of the row-preview notice.)
  const reviewerPrompt = calls.find((call) => call.role === 'reviewer').user
  assert.ok(reviewerPrompt.includes('TAIL-MARKER'), 'the reviewer must see the end of a sub-limit result')
  assert.ok(
    !reviewerPrompt.includes(truncationNotice(TURN_TEXT_LIMIT, [...longResult].length - TURN_TEXT_LIMIT)),
    'the row-preview truncation notice must not leak into review material',
  )
  assert.equal(reviewerPrompt.includes(truncationNotice(TURN_TEXT_LIMIT, 1)), false)
})

test('previewTurnText keeps short text untouched and never drops the flatten/secret gates', () => {
  assert.equal(previewTurnText('短文本'), '短文本')
  assert.equal(previewTurnText('多  行\n文本\t合并'), '多 行 文本 合并')
  assert.equal(previewTurnText('   '), '')
  const clipped = previewTurnText('字'.repeat(TURN_TEXT_LIMIT + 7))
  assert.match(clipped, new RegExp(escapeRe(truncationNotice(TURN_TEXT_LIMIT, 7))))
})

test('HONESTY GATE: a verdict over a truncated implementer result is displayed but never fed', async () => {
  const longResult = '段'.repeat(REVIEWER_RESULT_LIMIT + 100)
  const appended = []
  const result = await dispatchTeam(TEAM, { confirm: true, task: '整理 SQL' }, {
    readRows: () => [DECISION],
    append: (row) => appended.push(row),
    streamRole: async ({ role }) => {
      if (role === 'reviewer') return '判定：通过\n碎片看起来没问题。'
      return longResult
    },
  })

  assert.equal(result.dispatch.verdict, 'ok', 'the reviewer really did pass judgement')
  assert.equal(result.dispatch.verdictFed, false, 'a fragment pass must not feed the posterior as a full review')
  assert.equal(result.dispatch.verdictSkip, REVIEW_RESULT_TRUNCATED)
  assert.equal(appended.filter((row) => row.kind === 'outcome').length, 0)
  assert.deepEqual(allocationStateFromLedger([DECISION, ...appended]), [])
})

test('HONESTY GATE: a verdict over a truncated task text is displayed but never fed', async () => {
  const longTask = '任务'.repeat(Math.ceil((REVIEWER_TASK_LIMIT + 50) / 2))
  const appended = []
  const result = await dispatchTeam(TEAM, { confirm: true, task: longTask }, {
    readRows: () => [DECISION],
    append: (row) => appended.push(row),
    streamRole: async ({ role }) => (role === 'reviewer' ? '判定：通过\n就这段而言没问题。' : '实现终稿'),
  })

  assert.equal(result.dispatch.verdict, 'ok')
  assert.equal(result.dispatch.verdictFed, false)
  assert.equal(result.dispatch.verdictSkip, REVIEW_TASK_TRUNCATED)
  assert.equal(appended.filter((row) => row.kind === 'outcome').length, 0)
})

test('negative control: sub-limit material still feeds normally (the gate discriminates)', async () => {
  const appended = []
  const result = await dispatchTeam(TEAM, { confirm: true, task: '整理 SQL' }, {
    readRows: () => [DECISION],
    append: (row) => appended.push(row),
    streamRole: async ({ role }) => {
      if (role === 'reviewer') return '判定：通过\n实现覆盖了要求。'
      return '实现终稿,长度远小于窗口。'
    },
  })
  assert.equal(result.dispatch.verdictFed, true)
  assert.equal(result.dispatch.verdictSkip, null)
  assert.equal(appended.filter((row) => row.kind === 'outcome').length, 1)
})

test('the reviewer prompt announces the exact truncation amount at review budgets, deterministically', () => {
  const longResult = 'D'.repeat(REVIEWER_RESULT_LIMIT + 250)
  const turns = [{ role: 'implementer', ok: true, text: 'ROW-PREVIEW' }]
  const user = roleUserPrompt('reviewer', '任务', turns, { implementer: longResult })
  assert.match(user, new RegExp(escapeRe(truncationNotice(REVIEWER_RESULT_LIMIT, 250))))
  assert.ok(user.includes('D'.repeat(REVIEWER_RESULT_LIMIT)))
  assert.equal(user, roleUserPrompt('reviewer', '任务', turns, { implementer: longResult }), 'deterministic')
  // Without the raw override the prompt still works (legacy callers / in-process tests).
  assert.match(roleUserPrompt('reviewer', '任务', turns), /ROW-PREVIEW/)
})

test('boundedSection contract is unchanged: code points, marker line, absence for short text', () => {
  const wide = boundedSection('🙂'.repeat(10), 4)
  assert.equal(wide.dropped, 6)
  assert.equal([...wide.text.split('\n')[0]].length, 4)
  assert.equal(boundedSection('short', 4000).truncated, false)
})
