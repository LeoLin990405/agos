import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  coverageGrid,
  deriveCivRows,
  deriveCouncilRows,
  deriveFleetRows,
  deriveOutcomeRows,
  derivePlanRows,
  deriveRouteRows,
  foldAgent,
  OUTCOME_FIELDS,
  OUTCOME_KINDS,
  readOutcomeSources,
} from '../lib/outcomes.js'

// 夹具照搬 2026-08-23 台账真实行(脱敏),不是手造的理想形状。
const ROUTE = [
  { ts: 1787329561900, taskType: 'sql', role: 'coder', pick: 'qwen3.8-max', label: 'sql', outcome: null },          // selector 时代,无 id
  { id: 'dec-1787335545196-2e3d5b33', ts: 1787335545196, taskType: 'implementer', role: 'implementer', pick: 'qwen3.8-max', label: 'implementer', outcome: null },
  { kind: 'outcome', ref: 'dec-1787335545196-2e3d5b33', at: 1787335545197, source: 'manual-w3', result: 'ok' },
  { id: 'dec-1787366398334-afe1a751', ts: 1787366398334, taskType: 'reviewer', role: 'reviewer', pick: 'MiniMax-M3', label: 'reviewer', outcome: null, fallbackReason: 'BAD_OUTPUT' },
  { ev: 'annotate', ref: 'dec-1787366398334-afe1a751', note: 'x', at: 1 },
  { kind: 'assemble', id: 'asm-1', ts: 2, roles: [] },
  { kind: 'dispatch', id: 'dsp-9', ts: 1787419059326, ref: 'asm-1', turns: [
    { role: 'planner', model: 'glm-5.2', ok: true, text: 'x' },
    { role: 'implementer', model: 'qwen3.8-max', ok: false, error: 'NO_TEXT', text: '' },
  ] },
]
const COUNCIL = [
  { time: '2026-08-18T06:16:58.193Z', consensus: false, flagged: ['minimax-cn', 'stepfun'], panelists: [
    { provider: 'minimax-cn', model: 'MiniMax-M3', ok: true, ms: 9301 },
    { provider: 'doubao', model: 'doubao-seed-evolving', ok: true, ms: 254402 },
    { provider: 'stepfun', model: 'step-3.7-flash', ok: true, ms: 435611 },
  ] },
  { kind: 'vision', time: '2026-08-22T10:00:00.000Z', flagged: [], panelists: [{ provider: 'local', model: '(see.py)', ok: true, ms: 10 }] },
  { kind: 'review', time: '2026-08-22T11:00:00.000Z', flagged: [], panelists: [{ provider: 'qwen', model: 'qwen3.8-max', ok: false, ms: 5, error: 'x' }] },
]
const CIV = [{ runId: '20260818T160135-ldfu', endedAt: '2026-08-18T16:07:42.122Z', offices_detail: [
  { id: 'bingbu', type: 'coder', provider: 'qwen', model: 'qwen3.8-max', ok: true, ms: 268543 },
  { id: 'shangshu', type: 'reason', provider: 'stepfun', model: 'step-3.7-flash', ok: null, ms: 0 },   // 没派任务
  { id: 'menxia', type: 'review', provider: 'minimax-cn', model: 'MiniMax-M3', ok: false, ms: 13338 },
] }]
const PLANS = [
  { name: 'plan-1787075402178.json', plan: { executedAt: '2026-08-18T17:50:36.476Z', steps: [{ id: 1, type: 'docs' }, { id: 2 }], results: [
    { id: 1, ok: false, ms: 17645, provider: 'xiaomi-token-plan-sgp', model: 'mimo-v2.5-pro' },
    { id: 2, ok: true, ms: 100, model: 'mimo-v2.5-pro' },
    { id: 3, ok: true, ms: 100, model: 'mimo-v2.5-pro' },      // 没有对应 step
  ] } },
  { name: 'plan-1787012794573.json', plan: { planner: 'deepseek-official', steps: [{ id: 1 }] } },     // 未执行,无 results
]
const FLEET = [
  { ev: 'dispatch', v: 1, at: 1787299684152, runId: 'r-1', batchId: 'b-1', host: 'knowledge-m4', model: 'deepseek-v4-flash', label: 'W1-d 地基冒烟', prompt: 'secret-prompt' },
  { ev: 'start', v: 1, at: 1787299684170, runId: 'r-1', batchId: 'b-1' },
  { ev: 'end', v: 1, at: 1787299689220, runId: 'r-1', batchId: 'b-1', ok: true, exit: 0, ms: 5041, resultText: '收到。' },
  { ev: 'end', v: 1, at: 1787299689999, runId: 'r-orphan', batchId: 'b-1', ok: false, exit: 1, ms: 10 },
]

test('foldAgent:小写折叠;占位符与空值 → null;不碰 provider 名(由调用方保证)', () => {
  assert.equal(foldAgent('MiniMax-M3'), 'minimax-m3')
  assert.equal(foldAgent('  qwen3.8-max '), 'qwen3.8-max')
  assert.equal(foldAgent('(see.py)'), null)
  assert.equal(foldAgent('a'), null)
  assert.equal(foldAgent(''), null)
  assert.equal(foldAgent(undefined), null)
})

test('route:复用 foldLedger;无 id 退化 ts;outcome 行折叠成 result;试跑回合并入 kind route', () => {
  const rows = deriveRouteRows(ROUTE)
  assert.deepEqual(rows.map((r) => r.ref), ['1787329561900', 'dec-1787335545196-2e3d5b33', 'dec-1787366398334-afe1a751', 'dsp-9#planner', 'dsp-9#implementer'])
  assert.deepEqual(rows.map((r) => r.result), [null, 'ok', null, 'ok', 'fail'])
  assert.deepEqual(rows.map((r) => r.taskType), ['sql', 'implementer', 'reviewer', 'planner', 'implementer'])
  assert.equal(rows[2].agent, 'minimax-m3')
  assert.ok(rows.every((r) => r.kind === 'route' && r.ms === null))
})

test('council:flagged 按 provider 名 join → fail;未 flag 且 ok → ok;ok:false → fail;(see.py) 不是 agent;无 kind → taskType null', () => {
  const rows = deriveCouncilRows(COUNCIL)
  assert.equal(rows.length, 5)
  assert.deepEqual(rows.slice(0, 3).map((r) => [r.agent, r.result, r.taskType, r.ms]), [
    ['minimax-m3', 'fail', null, 9301], ['doubao-seed-evolving', 'ok', null, 254402], ['step-3.7-flash', 'fail', null, 435611],
  ])
  assert.deepEqual([rows[3].agent, rows[3].taskType, rows[3].result], [null, 'vision', 'ok'])
  assert.deepEqual([rows[4].agent, rows[4].taskType, rows[4].result], ['qwen3.8-max', 'review', 'fail'])
  assert.equal(rows[0].ref, '2026-08-18T06:16:58.193Z#0')
  assert.equal(rows[0].ts, Date.parse('2026-08-18T06:16:58.193Z'))
})

test('civ:ok:null = 没派任务 → result null 且 ms null;type 内联成 taskType;ref = runId#office', () => {
  const rows = deriveCivRows(CIV)
  assert.deepEqual(rows.map((r) => [r.ref, r.agent, r.taskType, r.result, r.ms]), [
    ['20260818T160135-ldfu#bingbu', 'qwen3.8-max', 'coder', 'ok', 268543],
    ['20260818T160135-ldfu#shangshu', 'step-3.7-flash', 'reason', null, null],
    ['20260818T160135-ldfu#menxia', 'minimax-m3', 'review', 'fail', 13338],
  ])
})

test('plan:results 与 steps 按 id 自连抄 type;缺 step → taskType null;未执行的计划不出行', () => {
  const rows = derivePlanRows(PLANS)
  assert.deepEqual(rows.map((r) => [r.ref, r.taskType, r.result]), [
    ['plan-1787075402178.json#1', 'docs', 'fail'], ['plan-1787075402178.json#2', null, 'ok'], ['plan-1787075402178.json#3', null, 'ok'],
  ])
  assert.ok(rows.every((r) => r.agent === 'mimo-v2.5-pro' && r.ts === Date.parse('2026-08-18T17:50:36.476Z')))
})

test('fleet:end 按 runId 回 join dispatch 的 model;孤儿 end → agent null;taskType 永远 null;prompt 不进结果', () => {
  const rows = deriveFleetRows(FLEET)
  assert.deepEqual(rows.map((r) => [r.ref, r.agent, r.taskType, r.result, r.ms]), [['r-1', 'deepseek-v4-flash', null, 'ok', 5041], ['r-orphan', null, null, 'fail', 10]])
  assert.doesNotMatch(JSON.stringify(rows), /secret-prompt|地基/)
})

test('deriveOutcomeRows:五源合并、按 ts 升序、每行恰七键、kind/result 合法', () => {
  const rows = deriveOutcomeRows({ route: ROUTE, council: COUNCIL, civ: CIV, plans: PLANS, fleet: FLEET })
  assert.equal(rows.length, 5 + 5 + 3 + 3 + 2)
  assert.ok(rows.every((r) => Object.keys(r).length === 7 && OUTCOME_FIELDS.every((f) => f in r)))
  assert.ok(rows.every((r) => OUTCOME_KINDS.includes(r.kind) && ['ok', 'fail', null].includes(r.result)))
  for (let i = 1; i < rows.length; i += 1) assert.ok((rows[i].ts ?? 0) >= (rows[i - 1].ts ?? 0))
  assert.ok(rows.every((r) => r.agent === null || r.agent === r.agent.toLowerCase()))
})

test('coverageGrid:带标签 = taskType&&agent&&result 三者在场;缺失按 taskType>agent>result 只计一次;反事实格子数', () => {
  const rows = deriveOutcomeRows({ route: ROUTE, council: COUNCIL, civ: CIV, plans: PLANS, fleet: FLEET })
  const g = coverageGrid(rows)
  assert.equal(g.total, 18)
  assert.equal(g.labeled + g.unlabeled, 18)
  assert.equal(g.missing.noTaskType + g.missing.noAgent + g.missing.noResult, g.unlabeled)
  // taskType 'review' 有 minimax-m3(civ fail)与 qwen3.8-max(council fail)两个 agent → 1 个可比较的 taskType。
  assert.equal(g.cellsWithCounterfactual, 1)
  const impl = g.cells.find((c) => c.taskType === 'implementer' && c.agent === 'qwen3.8-max')
  assert.deepEqual(impl, { taskType: 'implementer', agent: 'qwen3.8-max', ok: 1, fail: 1 })
  assert.deepEqual(g.byKind, { route: 5, council: 5, civ: 3, plan: 3, fleet: 2 })
})

test('readOutcomeSources:缺任一源不抛、返回空数组;读完 fleet runs.jsonl 字节不变(纯读,不走 FleetLedger)', async () => {
  const home = await mkdtemp(join(tmpdir(), 'agos-outcomes-'))
  const empty = readOutcomeSources({ auditFile: join(home, 'nope.jsonl'), home, env: {} })
  assert.deepEqual(Object.fromEntries(Object.entries(empty).map(([k, v]) => [k, v.length])), { route: 0, council: 0, civ: 0, plans: 0, fleet: 0 })

  await mkdir(join(home, '.dsh', 'logs', 'fleet'), { recursive: true })
  await mkdir(join(home, '.dsh', 'logs', 'civ', 'runs', 'r1'), { recursive: true })
  await mkdir(join(home, '.dsh', 'logs', 'plans'), { recursive: true })
  const fleetFile = join(home, '.dsh', 'logs', 'fleet', 'runs.jsonl')
  const fleetBytes = FLEET.map((e) => JSON.stringify(e)).join('\n') + '\n{broken json\n'
  await writeFile(fleetFile, fleetBytes)
  await writeFile(join(home, '.dsh', 'logs', 'council-record.jsonl'), COUNCIL.map((e) => JSON.stringify(e)).join('\n') + '\n')
  await writeFile(join(home, '.dsh', 'logs', 'civ', 'runs', 'r1', 'manifest.json'), JSON.stringify(CIV[0]))
  await writeFile(join(home, '.dsh', 'logs', 'plans', 'plan-1787075402178.json'), JSON.stringify(PLANS[0].plan))
  await writeFile(join(home, '.dsh', 'logs', 'plans', 'notes.txt'), 'ignored')
  const audit = join(home, 'route-outcome.jsonl')
  await writeFile(audit, ROUTE.map((e) => JSON.stringify(e)).join('\n') + '\n')
  const src = readOutcomeSources({ auditFile: audit, home, env: {} })
  assert.deepEqual(Object.fromEntries(Object.entries(src).map(([k, v]) => [k, v.length])), { route: 7, council: 3, civ: 1, plans: 1, fleet: 4 })
  assert.equal(await readFile(fleetFile, 'utf8'), fleetBytes)
  assert.equal(deriveOutcomeRows(src).length, 5 + 5 + 3 + 3 + 2)
})
