// W17(TASK-2026-08-22-017 第三档,Leo 2026-08-23 拍板):影子选择器。
//
// 影子 = 只记录、不驱动。DispatchModal 点「检查派发」时,用户勾选的机器与派发行为**一字不改**;
// 这里只把「如果让选择器来选,它会选哪台、为什么」写进路由台账(route-outcome.jsonl),并在派发真的
// 发生后把 batchId 挂到这条决策上,等 fleet 批次终态(runs.jsonl 的 end 行 ok/exit)回填 outcome。
// 台账因此有了「选择器对一次真实派发会怎么选」的记录——它仍然没驱动任何东西,只是第一次有真实任务可对照。
//
// 边界(017「明确不做」第 2/7 条):
//   - 不接进真实派活路径:本模块没有任何返回值会流进 fleet-dispatch 的 assignHosts 或 DispatchModal 的勾选 state;
//   - 不是 bandit:不看后验、不排名,只记一次选择器的判断。
// 预算:每次「检查派发」= 一次 StepFun step-3.7-flash 调用(maxTokens 默认 2048,settings/patch 可覆盖;
//   低于 ~2048 时 thinking 块会吃光预算 → NO_TEXT 回落,2026-08-24 现网实测);
//   候选为空时**不调用**;选择器未配置/失败时记 fallback 行且 pick 为 null——影子没有「静态表回落」,
//   回落的 pick 是编造,界面必须显示「未产出建议」。
//
// 台账行形状:决策行(buildDecisionRecord 白名单)+ mode:'shadow' + shadow:{chosen, agreed, tag, label, hosts}
//   不用 kind/ev 作判别符(foldLedger 拿它们分类,会把影子行从 decisions 里挤掉;
//   见 feedback_record_field_is_not_a_label)。
//   关联行:{ev:'shadow-link', ref:<dec-id>, batchId, at};回填行:{kind:'outcome', ref, result, source:'fleet-end'}。
import { buildDecisionRecord, buildOutcomeRecord } from './ledger.js'
import { sanitizePreview, REASON_LIMIT } from './sanitize.js'

export const SHADOW_MODE = 'shadow'
export const SHADOW_LINK_EV = 'shadow-link'
export const SHADOW_OUTCOME_SOURCE = 'fleet-end'
export const MAX_SHADOW_ITEMS = 32
export const MAX_SHADOW_ITEM_CHARS = 240
export const TASK_TYPE = 'fleet-dispatch'
const BATCH_ID_RE = /^b-[0-9a-f-]{8,64}$/i
const DEC_ID_RE = /^dec-\d+-[a-f0-9]+$/i
const HOST_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i

/** /api/fleet/hosts 的行 → 选择器候选。只收 remote 且 enabled;description 把小模型能用的事实摆出来。 */
export function buildShadowCandidates(hosts) {
  if (!Array.isArray(hosts)) return []
  const out = []
  for (const h of hosts) {
    if (!h || typeof h !== 'object' || typeof h.name !== 'string' || !HOST_NAME_RE.test(h.name)) continue
    if (h.kind !== undefined && h.kind !== 'remote') continue
    if (h.enabled === false) continue
    const tags = Array.isArray(h.tags) ? h.tags.filter((t) => typeof t === 'string').slice(0, 8).join(',') : ''
    const parts = [
      h.model ? `模型 ${String(h.model).slice(0, 40)}` : '模型未采集',
      tags ? `标签 ${tags}` : '无标签',
      Number.isInteger(h.maxConcurrency) ? `并发上限 ${h.maxConcurrency}` : '并发上限未采集',
      Number.isInteger(h.inflight) ? `在途 ${h.inflight}` : '在途未采集',
      h.ok === true ? '可达' : h.ok === false ? '当前不可达(可能需唤醒)' : '可达性未采集',
    ]
    out.push({ id: h.name, role: 'implementer', description: parts.join(' · ') })
  }
  return out
}

/** 任务文本 → 给选择器的 task 摘要:最多前 MAX_SHADOW_ITEMS 项,每项截 MAX_SHADOW_ITEM_CHARS,经敏感过滤。 */
export function summarizeShadowTask(items, extra = {}) {
  const list = Array.isArray(items) ? items.filter((s) => typeof s === 'string' && s.trim()).slice(0, MAX_SHADOW_ITEMS) : []
  const lines = list.map((s, i) => {
    const one = sanitizePreview(s, MAX_SHADOW_ITEM_CHARS)
    return `${i + 1}. ${one ?? '[含敏感内容,已略]'}`
  })
  const head = `Homelab 派发:共 ${list.length} 项任务${extra.label ? `(批次「${sanitizePreview(extra.label, 60) ?? ''}」)` : ''}${extra.tag ? `,要求机器标签 ${sanitizePreview(extra.tag, 30) ?? ''}` : ''}。选一台最合适的执行机器。`
  return [head, ...lines].join('\n')
}

/** 请求体 → 选择器输入。候选为空 / 任务为空 → null(调用方据此**不调模型**,不落盘)。 */
export function buildShadowInput(body) {
  const candidates = buildShadowCandidates(body && body.hosts)
  if (candidates.length === 0) return null
  const items = Array.isArray(body && body.items) ? body.items.filter((s) => typeof s === 'string' && s.trim()) : []
  if (items.length === 0) return null
  return {
    task: summarizeShadowTask(items, { label: body.label, tag: body.tag }),
    role: 'implementer',
    taskType: TASK_TYPE,
    candidates,
    // 用户勾选**不**进 evidence:影子要记录的是选择器独立的判断,不是对用户选择的附和。
  }
}

function chosenOf(body) {
  return Array.isArray(body && body.chosen) ? body.chosen.filter((h) => typeof h === 'string' && HOST_NAME_RE.test(h)).slice(0, 32) : []
}

/**
 * 影子决策行。decision 为 null 表示选择器没给出结果(未配置 / 出错):pick 为 null,不编一个首台。
 */
export function buildShadowRecord(input, decision, meta = {}) {
  const chosen = Array.isArray(meta.chosen) ? meta.chosen : []
  const base = buildDecisionRecord(input, decision ?? { role: 'implementer', pick: null, confidence: null, reason: null, label: TASK_TYPE }, meta.source ?? 'fallback')
  const pick = typeof base.pick === 'string' ? base.pick : null
  const record = {
    ...base,
    pick,
    taskType: TASK_TYPE,
    role: 'implementer',
    label: TASK_TYPE,
    reason: decision && typeof decision.reason === 'string' ? sanitizePreview(decision.reason, REASON_LIMIT) ?? null : null,
    mode: SHADOW_MODE,
    shadow: {
      chosen,
      // agreed:用户勾了机器时才有判;没勾(交给调度器)是 null,不是 false
      agreed: pick !== null && chosen.length > 0 ? chosen.includes(pick) : null,
      tag: typeof meta.tag === 'string' ? meta.tag.slice(0, 30) : '',
      label: typeof meta.label === 'string' ? sanitizePreview(meta.label, 60) ?? '' : '',
      // 选择器实际看到的条数(最多 MAX_SHADOW_ITEMS);itemsTotal 是请求里的原始条数
      items: Math.min(Array.isArray(meta.items) ? meta.items.filter((s) => typeof s === 'string' && s.trim()).length : 0, MAX_SHADOW_ITEMS),
      itemsTotal: Array.isArray(meta.items) ? meta.items.length : 0,
      // 候选与其 ok/inflight/model 是调用方自述(UI 路径 = fleet store 60s 快照),后端不对照 fleet 主机表
      hostsFrom: 'client',
    },
  }
  if (meta.fallbackReason) record.fallbackReason = meta.fallbackReason
  if (meta.fallbackDetail && typeof meta.fallbackDetail === 'object') record.fallbackDetail = meta.fallbackDetail
  return record
}

/**
 * 影子决策。select 是选择器函数(可能 undefined = 未配置);append 落盘。
 * 返回 { skipped:true, reason } 或台账行(已 publicize:不含 task)。
 */
export async function shadowDecide(body, deps = {}) {
  const input = buildShadowInput(body)
  if (input === null) {
    const noItems = !Array.isArray(body && body.items) || body.items.filter((s) => typeof s === 'string' && s.trim()).length === 0
    return noItems
      ? { skipped: true, reason: 'NO_ITEMS', message: '没有任务,未调用选择器' }
      : { skipped: true, reason: 'NO_CANDIDATES', message: '没有可用的远端机器,未调用选择器' }
  }
  const chosen = chosenOf(body)
  const meta = { chosen, tag: body.tag, label: body.label, items: body.items }
  let record
  if (typeof deps.select !== 'function') {
    record = buildShadowRecord(input, null, { ...meta, source: 'fallback', fallbackReason: 'NOT_CONFIGURED' })
  } else {
    try {
      const decision = await deps.select(input)
      record = buildShadowRecord(input, decision, { ...meta, source: 'selector' })
    } catch (err) {
      record = buildShadowRecord(input, null, {
        ...meta,
        source: 'fallback',
        fallbackReason: err && typeof err.code === 'string' && err.code ? err.code : 'UNKNOWN',
        fallbackDetail: err && err.detail && typeof err.detail === 'object' ? err.detail : undefined,
      })
    }
  }
  if (typeof deps.append === 'function') deps.append(record)
  const { task, ...publicRecord } = record
  void task
  return publicRecord
}

/** 派发真的发生后,把 batchId 挂到影子决策上(追加关联行,不改写历史行)。 */
export function buildShadowLinkRecord({ ref, batchId, hosts }) {
  const safeRef = typeof ref === 'string' && DEC_ID_RE.test(ref) ? ref : null
  const safeBatch = typeof batchId === 'string' && BATCH_ID_RE.test(batchId) ? batchId : null
  if (!safeRef) throw new Error('shadow link ref must be a dec-… id')
  if (!safeBatch) throw new Error('shadow link batchId must be a b-… id')
  // 实际落的机器(派发结果 runs[].host 去重):有它才判得出「建议有没有被采用」
  const safeHosts = Array.isArray(hosts) ? [...new Set(hosts.filter((h) => typeof h === 'string' && HOST_NAME_RE.test(h)))].slice(0, 32) : []
  return { ev: SHADOW_LINK_EV, ref: safeRef, batchId: safeBatch, hosts: safeHosts, at: Date.now() }
}

/** foldLedger 之外的关联折叠:返回 Map<decId, {batchId, hosts}>(后写的覆盖)。 */
export function shadowLinks(rows) {
  const map = new Map()
  for (const row of Array.isArray(rows) ? rows : []) {
    if (row && row.ev === SHADOW_LINK_EV && typeof row.ref === 'string' && typeof row.batchId === 'string') {
      map.set(row.ref, { batchId: row.batchId, hosts: Array.isArray(row.hosts) ? row.hosts.filter((h) => typeof h === 'string') : [] })
    }
  }
  return map
}

/**
 * fleet runs.jsonl → 每个批次里每个 run 的最终机器与终态。
 *   host:dispatch 行的 host,被后来的 reroute 行覆盖(唤醒失败会改派);
 *   终态:end(ok = end.ok===true)/ cancel(fail)/ reattach state ∈ {interrupted,lost}(fail)——与 dsh-fleet
 *   fleet-ledger.mjs isTerminalEvent 同口径,否则取消/丢失的批次永远「未终态」。
 * 返回 Map<batchId, {runs: Map<runId,{host, ended, ok}>}>。
 */
const TERMINAL_REATTACH = new Set(['interrupted', 'lost'])
export function fleetBatchRuns(runRows) {
  const byBatch = new Map()
  for (const r of Array.isArray(runRows) ? runRows : []) {
    if (!r || typeof r !== 'object' || typeof r.batchId !== 'string' || typeof r.runId !== 'string') continue
    const b = byBatch.get(r.batchId) ?? new Map()
    const cur = b.get(r.runId) ?? { host: undefined, ended: false, ok: false }
    if (r.ev === 'dispatch') { if (typeof r.host === 'string') cur.host = r.host }
    else if (r.ev === 'reroute') { if (typeof r.host === 'string') cur.host = r.host }
    else if (r.ev === 'end') { cur.ended = true; cur.ok = r.ok === true }
    else if (r.ev === 'cancel') { cur.ended = true; cur.ok = false }
    else if (r.ev === 'reattach' && TERMINAL_REATTACH.has(String(r.state))) { cur.ended = true; cur.ok = false }
    b.set(r.runId, cur)
    byBatch.set(r.batchId, b)
  }
  return byBatch
}

/**
 * 批次级终态(整批)。保留给「实际落的机器」与整批视图;**回填不用它**——回填只看建议那台机器上的 run。
 * 返回 Map<batchId, {ended, ok, runs, endedRuns, hosts}>。
 */
export function fleetBatchStates(runRows) {
  const out = new Map()
  for (const [batchId, runs] of fleetBatchRuns(runRows)) {
    const list = [...runs.values()]
    const endedRuns = list.filter((x) => x.ended).length
    const ended = list.length > 0 && endedRuns === list.length
    out.set(batchId, { ended, ok: ended && list.every((x) => x.ok), runs: list.length, endedRuns, hosts: [...new Set(list.map((x) => x.host).filter(Boolean))] })
  }
  return out
}

/**
 * 建议那台机器上的 run 的终态:{present, ended, ok}。present=false = 批次里没有 run 落在 pick 上(建议未被采用)。
 */
export function hostOutcomeInBatch(batchRuns, pick) {
  if (!batchRuns || typeof pick !== 'string' || !pick) return { present: false, ended: false, ok: false }
  const mine = [...batchRuns.values()].filter((x) => x.host === pick)
  if (mine.length === 0) return { present: false, ended: false, ok: false }
  const ended = mine.every((x) => x.ended)
  return { present: true, ended, ok: ended && mine.every((x) => x.ok) }
}

/**
 * 建议是否被采用:优先按 runs.jsonl 折出的**最终**机器(reroute 后以实际为准);runs 里还没这个批次时
 * 退回关联行里的派发响应快照。没 pick / 两边都没有机器 → null(判不了)。
 */
export function shadowAdopted(pick, link, batchRuns) {
  if (typeof pick !== 'string' || !pick || !link) return null
  if (batchRuns && batchRuns.size > 0) return hostOutcomeInBatch(batchRuns, pick).present
  if (!Array.isArray(link.hosts) || link.hosts.length === 0) return null
  return link.hosts.includes(pick)
}

/**
 * 回填:已挂 batchId、outcome 仍空、**建议那台机器上的 run 都终态**的影子决策 → outcome 行(source 'fleet-end')。
 * 只看落在 pick 那台机器上的 run:同批别的机器成败不归到建议头上;建议没被采用(pick 上没有 run)则 outcome 永远留空——
 * 批次成败说的是用户选的机器,不是建议的对错,两种语义不往一个字段里塞(017「明确不做」第 3 条)。
 * 纯函数:返回要追加的行,不写。decisions 须是 foldLedger 折叠后的(outcome 已合并)。
 */
export function backfillShadowOutcomes({ decisions, links, batchRuns }) {
  const out = []
  for (const d of Array.isArray(decisions) ? decisions : []) {
    if (!d || d.mode !== SHADOW_MODE || typeof d.id !== 'string') continue
    if (d.outcome !== null && d.outcome !== undefined) continue
    const link = links.get(d.id)
    if (!link) continue
    const runs = batchRuns.get(link.batchId)
    const mine = hostOutcomeInBatch(runs, d.pick)
    if (!mine.present || !mine.ended) continue
    out.push(buildOutcomeRecord({ ref: d.id, result: mine.ok ? 'ok' : 'fail', source: SHADOW_OUTCOME_SOURCE }))
  }
  return out
}

/** 把关联折进决策行(只读派生,给 GET 用):batchRef / actualHosts(以 runs.jsonl 最终机器为准)/ adopted。 */
export function attachShadowLinks(decisions, links, batchRuns = new Map()) {
  return decisions.map((d) => {
    if (!d || d.mode !== SHADOW_MODE || !links.has(d.id)) return d
    const link = links.get(d.id)
    const runs = batchRuns.get(link.batchId)
    const actualHosts = runs && runs.size > 0 ? [...new Set([...runs.values()].map((x) => x.host).filter(Boolean))] : link.hosts
    return { ...d, batchRef: link.batchId, actualHosts, adopted: shadowAdopted(d.pick, link, runs) }
  })
}

/** 影子行只接受 fleet-end 回填:手工「记成功/记失败」对影子行是把人工胜负写到建议头上。 */
export function isShadowDecisionRef(rows, ref) {
  return (Array.isArray(rows) ? rows : []).some((r) => r && r.mode === SHADOW_MODE && r.id === ref)
}
