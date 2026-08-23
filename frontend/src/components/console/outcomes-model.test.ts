import assert from 'node:assert/strict'
import test from 'node:test'
import { coverageSummary, parseOutcomesPayload } from './outcomes-model.ts'

const GRID = {
  total: 62, byKind: { council: 20, civ: 24, plan: 6, fleet: 1, route: 11 }, labeled: 28, unlabeled: 34,
  missing: { noTaskType: 16, noAgent: 3, noResult: 15 }, cellsWithCounterfactual: 1,
  cells: [{ taskType: 'review', agent: 'minimax-m3', ok: 3, fail: 0 }, { taskType: 'review', agent: 'qwen3.8-max', ok: 1, fail: 0 }],
}

test('parseOutcomesPayload:rows 与 grid 都要在;覆盖表字段不完整即拒绝;坏格子丢弃', () => {
  assert.throws(() => parseOutcomesPayload({ rows: [] }), /缺少/)
  assert.throws(() => parseOutcomesPayload({ rows: [], grid: { total: 1 } }), /不完整/)
  const p = parseOutcomesPayload({ at: 1, rows: [], grid: { ...GRID, cells: [...GRID.cells, { taskType: 1 }] } })
  assert.equal(p.grid.cells.length, 2)
  assert.equal(p.grid.missing.noAgent, 3)
})

test('coverageSummary 由覆盖表算出:总数、分母、缺哪样、有无反事实', () => {
  const s = coverageSummary(GRID)
  assert.match(s, /共 62 行/)
  assert.match(s, /带完整标签 28 条 · 还差 34 条（缺任务类 16、缺模型 3、缺结果 15）/)
  assert.match(s, /1 个任务类有两个以上模型的观测，只有这些能比较/)
  assert.match(coverageSummary({ ...GRID, cellsWithCounterfactual: 0 }), /零反事实/)
})
