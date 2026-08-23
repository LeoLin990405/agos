// W10 结果行派生器(TASK-2026-08-22-017 第二档):把五家台账里躺着的「某个模型跑了一次任务」
// 归一成七字段行 {ts, kind, ref, agent, taskType, result, ms}。**纯读**,不做语义合并。
//
//   kind     route | council | plan | civ | fleet(不合并:各家 taskType 词表互不对齐,合并就是编造)
//   ref      可寻址回源行的主键(route: dec-id 或退化 ts;council: time#i;civ: runId#office;plan: 文件名#id;fleet: runId)
//   agent    小写折叠后的 model id;占位符('(see.py)')、空串 → null。只从 model 字段取,
//            **不碰** arbiter / planner / executor(那些是 provider 名)
//   taskType 缺席就是 null,不猜
//   result   只三态 'ok' | 'fail' | null
//
// 各源的特殊规则(每条都是数据逼出来的,不是设计偏好):
// - route:复用 foldLedger;前两行(selector 时代)没有 id,ref 退化成 String(ts)。
//   试跑(kind:'dispatch')的 turns[] 也是模型级结果,并入 kind:'route',ref = dsp-id#role,taskType = role。
// - council:panelists[].ok 全是 true(20/20),唯一「答错了」的信号是 flagged —— 它装的是 **provider 名**
//   (cn-capabilities/lib/index.js:1538 `ok[n-1].provider`),按 panelists[].provider join。
//   ⚠️ 语义决定:被 flag = 仲裁判它「疑似编造」,这里记成 'fail'。七字段只有三态,第四态「答了但被疑」装不下;
//   选 fail 而不是 ok,是因为 council 是全系统唯一带「答错」信号的源,丢了就等于没有。
// - civ:offices_detail[].ok 为 null 表示「没派任务」(24 条里 8 条),result 必须是 null 而不是 fail,
//   否则会把 step-3.7-flash / qwen 的后验凭空压低。
// - plan:results[].id 与 steps[].id 同文件自连抄 type;⚠️ results[].ok 的语义是「子代理跑完」不是「目标达成」
//   (plan-1787075497754 三条 ok:true 而 review 明说未达成)。不做语义合并就接受这一点,覆盖表里标出来。
// - fleet:end 行没有 model/host,按 runId 回 join 同文件的 dispatch 行。**禁止 new FleetLedger()** —— 它构造即
//   autoCompact 重写 runs.jsonl(fleet-ledger.mjs:137),「纯读」会变成写。这里裸 readFile 逐行 parse。
//
// 大小写折叠真正要处理的只有一组:MiniMax-M3(council / civ / turns.hostModel)↔ minimax-m3(route)。
// 归档语料 394 会话内部零碰撞(实测)。
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { foldLedger, readLedgerLines } from './ledger.js'

export const OUTCOME_KINDS = Object.freeze(['route', 'council', 'plan', 'civ', 'fleet'])
export const OUTCOME_FIELDS = Object.freeze(['ts', 'kind', 'ref', 'agent', 'taskType', 'result', 'ms'])

const PLACEHOLDER_AGENTS = new Set(['(see.py)', 'a', 'b'])

/** 模型 id 小写折叠;占位符与空值 → null。 */
export function foldAgent(id) {
  if (typeof id !== 'string') return null
  const t = id.trim()
  if (!t || PLACEHOLDER_AGENTS.has(t)) return null
  return t.toLowerCase()
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const tsOf = (v) => {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string') { const t = Date.parse(v); return Number.isFinite(t) ? t : null }
  return null
}
const tri = (ok) => (ok === true ? 'ok' : ok === false ? 'fail' : null)
const row = (ts, kind, ref, agent, taskType, result, ms) => ({ ts, kind, ref, agent, taskType, result, ms })

export function deriveRouteRows(rawRows) {
  const { decisions, dispatch } = foldLedger(Array.isArray(rawRows) ? rawRows : [])
  const out = decisions.map((d) => row(
    tsOf(d.ts),
    'route',
    String(d.id ?? d.ts ?? ''),
    foldAgent(d.pick),
    typeof d.label === 'string' && d.label ? d.label : typeof d.taskType === 'string' && d.taskType ? d.taskType : null,
    d.outcome === 'ok' || d.outcome === 'fail' ? d.outcome : null,
    null,
  ))
  // 台账只保留最近一次试跑(foldLedger 单例);它的三个回合是模型级结果。
  if (dispatch && Array.isArray(dispatch.turns)) {
    for (const t of dispatch.turns) {
      if (!t || typeof t !== 'object') continue
      out.push(row(tsOf(dispatch.ts), 'route', `${dispatch.id ?? dispatch.ts}#${t.role ?? '?'}`, foldAgent(t.model), typeof t.role === 'string' ? t.role : null, tri(t.ok), null))
    }
  }
  return out.filter((r) => r.ref !== '' && r.ref !== 'undefined')
}

export function deriveCouncilRows(records) {
  const out = []
  for (const rec of Array.isArray(records) ? records : []) {
    if (!rec || typeof rec !== 'object' || !Array.isArray(rec.panelists)) continue
    const ts = tsOf(rec.time)
    const flagged = new Set(Array.isArray(rec.flagged) ? rec.flagged.filter((x) => typeof x === 'string') : [])
    rec.panelists.forEach((p, i) => {
      if (!p || typeof p !== 'object') return
      const result = p.ok !== true ? tri(p.ok) : flagged.has(p.provider) ? 'fail' : 'ok'
      out.push(row(ts, 'council', `${rec.time ?? '?'}#${i}`, foldAgent(p.model), typeof rec.kind === 'string' ? rec.kind : null, result, num(p.ms)))
    })
  }
  return out
}

export function deriveCivRows(manifests) {
  const out = []
  for (const m of Array.isArray(manifests) ? manifests : []) {
    if (!m || typeof m !== 'object' || !Array.isArray(m.offices_detail)) continue
    const ts = tsOf(m.endedAt) ?? tsOf(m.startedAt)
    for (const o of m.offices_detail) {
      if (!o || typeof o !== 'object') continue
      out.push(row(ts, 'civ', `${m.runId ?? '?'}#${o.id ?? '?'}`, foldAgent(o.model), typeof o.type === 'string' ? o.type : null, tri(o.ok), o.ok === null || o.ok === undefined ? null : num(o.ms)))
    }
  }
  return out
}

export function derivePlanRows(plans) {
  const out = []
  for (const { name, plan } of Array.isArray(plans) ? plans : []) {
    if (!plan || typeof plan !== 'object' || !Array.isArray(plan.results)) continue
    const steps = new Map((Array.isArray(plan.steps) ? plan.steps : []).map((s) => [s && s.id, s]))
    const ts = tsOf(plan.executedAt)
    for (const r of plan.results) {
      if (!r || typeof r !== 'object') continue
      const step = steps.get(r.id)
      out.push(row(ts, 'plan', `${name}#${r.id}`, foldAgent(r.model), step && typeof step.type === 'string' ? step.type : null, tri(r.ok), num(r.ms)))
    }
  }
  return out
}

export function deriveFleetRows(events) {
  const dispatchByRun = new Map()
  for (const e of Array.isArray(events) ? events : []) {
    if (e && e.ev === 'dispatch' && typeof e.runId === 'string') dispatchByRun.set(e.runId, e)
  }
  const out = []
  for (const e of Array.isArray(events) ? events : []) {
    if (!e || e.ev !== 'end' || typeof e.runId !== 'string') continue
    const d = dispatchByRun.get(e.runId)
    out.push(row(tsOf(e.at), 'fleet', e.runId, foldAgent(d && d.model), null, tri(e.ok), num(e.ms)))
  }
  return out
}

export function deriveOutcomeRows({ route, council, civ, plans, fleet }) {
  return [
    ...deriveRouteRows(route),
    ...deriveCouncilRows(council),
    ...deriveCivRows(civ),
    ...derivePlanRows(plans),
    ...deriveFleetRows(fleet),
  ].sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0))
}

/**
 * (taskType, agent) 格子覆盖表 + 「还差多少条带标签数据」。
 * 带标签 = taskType && agent && result 三者都在;缺哪个就计到哪一栏,一行只计一次(按缺失优先级 taskType > agent > result)。
 */
export function coverageGrid(rows) {
  const cells = new Map()
  const byKind = {}
  const missing = { noTaskType: 0, noAgent: 0, noResult: 0 }
  let labeled = 0
  for (const r of rows) {
    byKind[r.kind] = (byKind[r.kind] ?? 0) + 1
    if (!r.taskType) { missing.noTaskType += 1; continue }
    if (!r.agent) { missing.noAgent += 1; continue }
    if (r.result !== 'ok' && r.result !== 'fail') { missing.noResult += 1; continue }
    labeled += 1
    const key = `${r.taskType}\t${r.agent}`
    const cell = cells.get(key) ?? { taskType: r.taskType, agent: r.agent, ok: 0, fail: 0 }
    cell[r.result] += 1
    cells.set(key, cell)
  }
  const list = [...cells.values()].sort((a, b) => (a.taskType + a.agent).localeCompare(b.taskType + b.agent))
  return {
    total: rows.length,
    byKind,
    labeled,
    unlabeled: rows.length - labeled,
    missing,
    cells: list,
    // 每个 (taskType, agent) 格子里只有一个模型跑过的那种「零反事实」格,今天的真相就是这个数。
    cellsWithCounterfactual: countCounterfactualCells(list),
  }
}

/** 同一 taskType 下有 ≥2 个 agent 有观测,才谈得上比较。 */
function countCounterfactualCells(cells) {
  const agentsByTask = new Map()
  for (const c of cells) agentsByTask.set(c.taskType, (agentsByTask.get(c.taskType) ?? 0) + 1)
  return [...agentsByTask.values()].filter((n) => n >= 2).length
}

const readJsonLines = (file) => {
  if (!existsSync(file)) return []
  const out = []
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue
    try { out.push(JSON.parse(line)) } catch { /* 坏行丢弃,不发明 */ }
  }
  return out
}
const readJson = (file) => { try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return null } }

/**
 * 读五个源。任何一个源缺席/坏掉 → 该源空数组,不抛。全部同步 node:fs,不 import dsh-civ / dsh-fleet。
 * 路径与各插件一致:civ 认 DSH_CIV_HISTORY_DIR,plans 认 DSH_CN_PLAN_DIR。
 */
export function readOutcomeSources({ auditFile, home, env = process.env }) {
  const logs = join(home, '.dsh', 'logs')
  const civDir = env.DSH_CIV_HISTORY_DIR || join(logs, 'civ')
  const planDir = env.DSH_CN_PLAN_DIR || join(logs, 'plans')
  const civ = []
  const runsDir = join(civDir, 'runs')
  if (existsSync(runsDir)) {
    for (const name of readdirSync(runsDir)) {
      const m = readJson(join(runsDir, name, 'manifest.json'))
      if (m) civ.push(m)
    }
  }
  const plans = []
  if (existsSync(planDir)) {
    for (const name of readdirSync(planDir)) {
      if (!/^plan-\d+\.json$/.test(name)) continue
      const plan = readJson(join(planDir, name))
      if (plan) plans.push({ name, plan })
    }
  }
  return {
    route: auditFile ? readLedgerLines(auditFile) : [],
    council: readJsonLines(join(logs, 'council-record.jsonl')),
    civ,
    plans,
    fleet: readJsonLines(join(logs, 'fleet', 'runs.jsonl')),
  }
}
