import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { LIVE_DISPATCH_OFF_COPY } from '../lib/assemble.js'
import {
  DISPATCH_EMPTY_COPY,
  ASSEMBLE_MISMATCH_COPY,
  DISPATCH_CONFIRM_COPY,
  DISPATCH_COPY,
  DISPATCH_NO_TOOLS_COPY,
  MODEL_UNRESOLVED_COPY,
  REVIEWER_SEES_FINAL_COPY,
  dispatchTeam,
  resolveModelRoute,
  roleSystemPrompt,
  roleUserPrompt,
} from '../lib/dispatch.js'
import { appendLine, foldLedger, listRoutes } from '../lib/ledger.js'

const TEAM = {
  id: 'asm-1',
  ref: 'dec-1',
  roles: [
    { role: 'planner', model: 'glm-5.2' },
    { role: 'implementer', model: 'qwen3.8-max' },
    { role: 'reviewer', model: 'minimax-m3' },
  ],
}

test('known assemble labels resolve to host provider/model pairs', () => {
  assert.deepEqual(resolveModelRoute('glm-5.2'), { provider: 'zhipu', model: 'glm-5.2' })
  assert.deepEqual(resolveModelRoute('qwen3.8-max'), { provider: 'qwen', model: 'qwen3.8-max' })
  assert.deepEqual(resolveModelRoute('minimax-m3'), { provider: 'minimax-cn', model: 'MiniMax-M3' })
  assert.equal(resolveModelRoute('ghost-model'), null)
})

test('reviewer prompt sees implementer final only', () => {
  const turns = [
    { role: 'planner', ok: true, text: 'PLAN-SECRET' },
    { role: 'implementer', ok: true, text: 'FINAL-DRAFT' },
  ]
  const user = roleUserPrompt('reviewer', '整理 SQL', turns)
  assert.match(user, /FINAL-DRAFT/)
  assert.doesNotMatch(user, /PLAN-SECRET/)
  assert.doesNotMatch(user, /整理 SQL/)
  assert.match(roleSystemPrompt('reviewer'), new RegExp(REVIEWER_SEES_FINAL_COPY))
})

test('dispatchTeam requires confirm and does not invent outcome', async () => {
  await assert.rejects(() => dispatchTeam(TEAM, { task: 'x' }), (err) => {
    assert.equal(err.code, 'CONFIRM_REQUIRED')
    assert.equal(err.message, DISPATCH_CONFIRM_COPY)
    return true
  })
  const calls = []
  const result = await dispatchTeam(TEAM, { confirm: true, task: '三角色试跑' }, {
    streamRole: async (input) => {
      calls.push(input)
      return `${input.role}-ok`
    },
  })
  assert.equal(result.dispatched, true)
  assert.equal(result.sessionSwitched, false)
  assert.equal(result.outcome, null)
  assert.equal(result.dispatch.outcome, null)
  assert.equal(result.dispatch.note, DISPATCH_COPY)
  assert.equal(result.dispatch.live, LIVE_DISPATCH_OFF_COPY)
  assert.equal(result.dispatch.tools, DISPATCH_NO_TOOLS_COPY)
  assert.equal(result.dispatch.turns.length, 3)
  assert.equal(calls[2].user.includes('implementer-ok'), true)
  assert.equal(calls[2].user.includes('planner-ok'), false)
})

test('unresolved models fail closed and later roles still run', async () => {
  const result = await dispatchTeam({
    id: 'asm-2',
    roles: [
      { role: 'planner', model: 'missing-model' },
      { role: 'implementer', model: 'qwen3.8-max' },
    ],
  }, { confirm: true }, {
    streamRole: async () => 'impl-ok',
  })
  assert.equal(result.dispatch.turns[0].ok, false)
  assert.equal(result.dispatch.turns[0].error, 'UNRESOLVED')
  assert.equal(result.dispatch.turns[0].note, MODEL_UNRESOLVED_COPY)
  assert.equal(result.dispatch.turns[1].ok, true)
})

test('dispatch rows do not become route decisions or outcomes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agos-dispatch-'))
  const file = join(dir, 'route-outcome.jsonl')
  appendLine(file, { id: 'dec-1', pick: 'qwen3.8-max', role: 'implementer' })
  const result = await dispatchTeam(TEAM, { confirm: true }, {
    append: (record) => appendLine(file, record),
    streamRole: async (input) => input.role,
  })
  const listed = listRoutes(file, 50)
  assert.equal(listed.stats.total, 1)
  assert.equal(listed.dispatch.id, result.dispatch.id)
  assert.equal(foldLedger([{ kind: 'dispatch', id: 'dsp-1' }, { id: 'dec-9', pick: 'x' }]).decisions.length, 1)
})

test('带 ref 的试跑请求指向的不是台账最新提案 → ASSEMBLE_MISMATCH，不跑任何角色', async () => {
  const calls = []
  await assert.rejects(
    () => dispatchTeam({ ...TEAM, id: 'asm-new' }, { confirm: true, ref: 'asm-old', task: 'x' }, {
      streamRole: async (input) => { calls.push(input); return 'ok' },
    }),
    (err) => { assert.equal(err.code, 'ASSEMBLE_MISMATCH'); return true },
  )
  assert.equal(calls.length, 0)
  const ok = await dispatchTeam({ ...TEAM, id: 'asm-new' }, { confirm: true, ref: 'asm-new', task: 'x' }, {
    streamRole: async () => 'ok',
  })
  assert.equal(ok.dispatch.ref, 'asm-new')
})

test('冻结文案字面量钉死：与 agos-frontend routes-assemble.ts 逐字镜像', () => {
  assert.equal(DISPATCH_COPY, '本次是三角色试跑，未换本跳会话模型')
  assert.equal(DISPATCH_NO_TOOLS_COPY, '三角色只出文本，不改仓库')
  assert.equal(MODEL_UNRESOLVED_COPY, '宿主未配置该模型')
  assert.equal(DISPATCH_EMPTY_COPY, '还没有试跑记录')
  assert.equal(ASSEMBLE_MISMATCH_COPY, '请求指定的提案不是台账最新一条，拒绝试跑')
})
