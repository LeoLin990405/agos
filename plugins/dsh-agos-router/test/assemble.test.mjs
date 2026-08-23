import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  ASSEMBLE_COPY,
  ASSEMBLE_EMPTY_COPY,
  GENERATION_NEQ_REVIEW_COPY,
  LIVE_DISPATCH_OFF_COPY,
  POOL_TOO_SMALL_COPY,
  allocationStateFromLedger,
  assembleLive,
  assembleTeam,
  assignRoles,
  defaultPoolCandidates,
} from '../lib/assemble.js'
import { decide } from '../lib/index.js'
import { appendLine, foldLedger, listRoutes, readLedgerLines } from '../lib/ledger.js'

test('assemble assigns three roles and keeps generation≠review when the pool is large enough', () => {
  const team = assembleTeam({
    pick: 'qwen3.8-max',
    role: 'implementer',
    label: 'coding',
    source: 'fallback',
  }, [], { candidates: defaultPoolCandidates() })
  assert.equal(team.dispatched, false)
  assert.equal(team.note, ASSEMBLE_COPY)
  assert.equal(team.live, LIVE_DISPATCH_OFF_COPY)
  const byRole = Object.fromEntries(team.roles.map((row) => [row.role, row.model]))
  assert.equal(byRole.implementer, 'qwen3.8-max')
  assert.notEqual(byRole.reviewer, byRole.implementer)
  assert.equal(team.distinct, true)
})

test('a two-model pool cannot invent a third reviewer', () => {
  const assigned = assignRoles(
    { pick: 'qwen3.8-max', role: 'implementer' },
    [{ agent: 'qwen3.8-max' }, { agent: 'glm-5.2' }],
    [{ id: 'qwen3.8-max' }, { id: 'glm-5.2' }],
  )
  assert.equal(assigned.roles.filter((row) => row.model).length, 3)
  assert.equal(assigned.notes.includes(POOL_TOO_SMALL_COPY), true)
})

test('ledger outcomes feed the posterior without treating pending rows as wins', () => {
  const state = allocationStateFromLedger([
    { id: 'dec-1', label: 'coding', pick: 'minimax-m3' },
    { kind: 'outcome', ref: 'dec-1', result: 'ok' },
    { id: 'dec-3', label: 'coding', pick: 'minimax-m3' },
    { kind: 'outcome', ref: 'dec-3', result: 'ok' },
    { id: 'dec-4', label: 'coding', pick: 'minimax-m3' },
    { kind: 'outcome', ref: 'dec-4', result: 'ok' },
    { id: 'dec-2', label: 'coding', pick: 'qwen3.8-max' },
    { kind: 'outcome', ref: 'dec-2', result: 'fail' },
    { kind: 'assemble', roles: [{ role: 'planner', model: 'ghost' }] },
  ])
  assert.deepEqual(state, [
    { taskType: 'coding', agent: 'minimax-m3', s: 3, f: 0 },
    { taskType: 'coding', agent: 'qwen3.8-max', s: 0, f: 1 },
  ])
  const team = assembleTeam({ role: 'implementer', label: 'coding', pick: 'qwen3.8-max' }, state)
  assert.equal(team.allocation[0]?.model, 'minimax-m3')
})

test('assemble rows do not become route decisions', () => {
  const { decisions, assemble } = foldLedger([
    { id: 'dec-1', pick: 'qwen3.8-max', role: 'implementer' },
    { kind: 'assemble', id: 'asm-1', pick: 'qwen3.8-max', roles: [] },
    { kind: 'dispatch', id: 'dsp-1', dispatched: true },
  ])
  assert.equal(decisions.length, 1)
  assert.equal(assemble.id, 'asm-1')
})

test('assembleLive writes a proposal and never marks it dispatched', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agos-assemble-'))
  const file = join(dir, 'route-outcome.jsonl')
  const rows = []
  const result = await assembleLive(
    { task: '整理一段 SQL', role: 'implementer' },
    {
      decide: (input) => decide(input, { auditFile: file }),
      readRows: () => {
        rows.splice(0, rows.length, ...readLedgerLines(file))
        return rows
      },
      append: (record) => appendLine(file, record),
    },
  )
  assert.equal(result.dispatched, false)
  assert.equal(result.assemble.dispatched, false)
  assert.equal(result.assemble.roles.length, 3)
  const listed = listRoutes(file, 50)
  assert.equal(listed.stats.total, 1)
  assert.equal(listed.assemble.note, ASSEMBLE_COPY)
  // 审查 P2-5:后验证据落盘,台账里能看出三角色是怎么排的。
  assert.ok(Array.isArray(listed.assemble.allocation) && listed.assemble.allocation.length > 0)
  assert.ok(listed.assemble.allocation.every((a) => typeof a.model === 'string' && typeof a.score === 'number'))
  assert.equal(listed.decisions[0].task, undefined)
})

test('冻结文案字面量钉死：与 agos-frontend routes-assemble.ts 逐字镜像', () => {
  // 改这里必须同步改前端 RETIRED_* 退役表,否则线上每条新提案都会被前端判契约违约。
  assert.equal(ASSEMBLE_COPY, '组装提案，只定角色不执行')
  assert.equal(LIVE_DISPATCH_OFF_COPY, '未接入本跳会话换模')
  assert.equal(ASSEMBLE_EMPTY_COPY, '还没有组装提案')
  assert.equal(GENERATION_NEQ_REVIEW_COPY, 'generation≠review：评审模型必须和实现模型不同')
  assert.equal(POOL_TOO_SMALL_COPY, '候选池不够，未能做到 generation≠review')
})

test('allocationStateFromLedger:pick 小写折叠,MiniMax-M3 与 minimax-m3 进同一格', () => {
  const rows = [
    { id: 'dec-1', ts: 1, label: 'reviewer', pick: 'MiniMax-M3', outcome: null },
    { kind: 'outcome', ref: 'dec-1', result: 'ok', at: 2 },
    { id: 'dec-2', ts: 3, label: 'reviewer', pick: 'minimax-m3', outcome: null },
    { kind: 'outcome', ref: 'dec-2', result: 'fail', at: 4 },
  ]
  assert.deepEqual(allocationStateFromLedger(rows), [{ taskType: 'reviewer', agent: 'minimax-m3', s: 1, f: 1 }])
})
