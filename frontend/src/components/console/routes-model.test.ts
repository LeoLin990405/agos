import assert from 'node:assert/strict'
import test from 'node:test'
import { formatCoverage, outcomeLabel, parseRoutesPayload, ROUTES_READY_COPY, ruleBadge } from './routes-model.ts'

test('parseRoutesPayload rejects a missing stats block', () => {
  assert.throws(() => parseRoutesPayload({ decisions: [] }), /缺少/)
  const ok = parseRoutesPayload({
    decisions: [{ pick: 'qwen3.8-max', outcome: null }],
    stats: { total: 3, filled: 0, pending: 3, cells: 1, window: 1, limit: 50 },
  })
  assert.equal(ok.stats.pending, 3)
})

test('null outcome is pending, never success or failure', () => {
  assert.equal(outcomeLabel(null), 'pending')
  assert.equal(outcomeLabel(undefined), 'pending')
  assert.equal(outcomeLabel('ok'), 'filled')
  assert.equal(
    formatCoverage({ total: 3, filled: 1, pending: 2, cells: 2, window: 2 }),
    '显示最近 2 条，台账共 3 条 · 已回填结果 1 条 · 覆盖 2 个 (角色, 模型) 格',
  )
})

test('success-only copy is not the error or empty-state string', () => {
  assert.equal(ROUTES_READY_COPY, '路由档位')
  assert.notEqual(ROUTES_READY_COPY, '待回填')
  assert.deepEqual(ruleBadge('TRUST'), { text: 'TRUST', state: 'done' })
  assert.deepEqual(ruleBadge('TRUST_SPOT_CHECK'), { text: '抽检', state: 'running' })
  assert.deepEqual(ruleBadge('ESCALATE'), { text: '升级', state: 'failed' })
})
