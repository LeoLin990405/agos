// Sakana Fugu / FuguNano poor-man's conductor:
// small classifier (StepFun or static table) + Beta-Bernoulli posterior
// → planner / implementer / reviewer team. Does not switch the live session model.
import { DEFAULT_ALLOCATION_PARAMS } from './allocation.js'
import { applyOutcome, rankAgents } from './allocation-score.js'
import { STATIC_FALLBACK } from './fallback.js'
import { foldLedger } from './ledger.js'
import { normalizeRole } from './roles.js'
import { filterLedgerForPosterior } from './feedback-bind.mjs'
import { mintAssembleId } from './ids.js'
import { isTaskFingerprint } from './task-fingerprint.mjs'

// 冻结文案与同仓 frontend/src/components/console/routes-assemble.ts 逐字镜像;
// 两边各自用单测钉住字面量。类别句(这东西是什么),不是时态句 —— 「尚未试跑」那种
// 要由前端按同屏数据算(2026-08-23 第二轮对抗验证 [2][20][42])。
export const ASSEMBLE_COPY = '组装提案，只定角色不执行'
export const ASSEMBLE_EMPTY_COPY = '还没有组装提案'
export const LIVE_DISPATCH_OFF_COPY = '未接入本跳会话换模'
export const GENERATION_NEQ_REVIEW_COPY = 'generation≠review：评审模型必须和实现模型不同'
export const POOL_TOO_SMALL_COPY = '候选池不够，未能做到 generation≠review'

export const DEFAULT_POOL = Object.freeze([
  { id: 'glm-5.2', role: 'planner' },
  { id: 'qwen3.8-max', role: 'implementer' },
  { id: 'minimax-m3', role: 'reviewer' },
  { id: 'step-3.7-flash', role: 'fixer' },
])

const ROLE_BENCH = Object.freeze({
  planner: ['glm-5.2', 'qwen3.8-max', 'minimax-m3', 'step-3.7-flash'],
  implementer: ['qwen3.8-max', 'glm-5.2', 'step-3.7-flash', 'minimax-m3'],
  reviewer: ['minimax-m3', 'glm-5.2', 'qwen3.8-max', 'step-3.7-flash'],
  fixer: ['qwen3.8-max', 'glm-5.2', 'minimax-m3', 'step-3.7-flash'],
  coding: ['qwen3.8-max', 'glm-5.2', 'minimax-m3', 'step-3.7-flash'],
  docs: ['glm-5.2', 'minimax-m3', 'qwen3.8-max', 'step-3.7-flash'],
  sql: ['qwen3.8-max', 'glm-5.2', 'minimax-m3'],
  planning: ['glm-5.2', 'qwen3.8-max', 'minimax-m3'],
  'code-review': ['minimax-m3', 'glm-5.2', 'qwen3.8-max'],
  research: ['glm-5.2', 'minimax-m3', 'qwen3.8-max'],
})

export function defaultPoolCandidates() {
  return DEFAULT_POOL.map((row) => ({ id: row.id }))
}

export function allocationBench() {
  return new Map(Object.entries(ROLE_BENCH))
}

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * RSI:读取期半衰期(FuguNano 只有手动 decay --gamma 且无时间戳;台账有 outcomeAt,补上时间维)。
 * 衰减是读的口径,不是改史:台账一字节不动,权重 = 2^(-age/halfLife)。
 * opts.halfLifeDays<=0 = 关(权重恒 1,与 FuguNano 原语义逐位一致);
 * 时间取 outcomeAt(胜负落账时刻),缺了退回决策 ts;两个都缺(不该发生)按权重 1 计,不编年龄。
 */
export function allocationStateFromLedger(rows, opts = {}) {
  const { decisions } = foldLedger(filterLedgerForPosterior(rows))
  const halfLife = Number.isFinite(opts.halfLifeDays) && opts.halfLifeDays > 0 ? opts.halfLifeDays : 0
  const now = Number.isFinite(opts.now) ? opts.now : Date.now()
  let state = []
  for (const row of decisions) {
    if (row.outcome !== 'ok' && row.outcome !== 'fail') continue
    // W17:影子行的 pick 是机器,不进模型的 Beta 后验
    if (row.mode === 'shadow') continue
    const taskType = row.label || row.taskType || row.role
    // 小写折叠:bench 键全小写,MiniMax-M3 若从 candidates 原样进来会和 minimax-m3 裂成两格。
    const agent = typeof row.pick === 'string' ? row.pick.trim().toLowerCase() : ''
    if (!taskType || !agent) continue
    let weight = 1
    if (halfLife > 0) {
      const at = Number.isFinite(row.outcomeAt) ? row.outcomeAt : (Number.isFinite(row.ts) ? row.ts : undefined)
      if (at !== undefined) {
        const ageDays = Math.max(0, (now - at) / DAY_MS)
        weight = Math.pow(2, -ageDays / halfLife)
      }
    }
    state = applyOutcome(state, { taskType, agent, result: row.outcome }, weight)
  }
  return state
}

/**
 * 衰减后的有效证据量(Σ s+f,保留两位)。带 taskType 时只算该任务类的格——
 * asm 行上这个数说的是「这次排序用了多少证据」,别的任务类的证据不许算进来(对抗审查 P3×3)。
 */
export function effectiveObservations(state, taskType) {
  let sum = 0
  for (const entry of Array.isArray(state) ? state : []) {
    if (taskType !== undefined && entry.taskType !== taskType) continue
    sum += (entry.s || 0) + (entry.f || 0)
  }
  return Math.round(sum * 100) / 100
}

function poolIds(candidates) {
  const ids = []
  for (const row of Array.isArray(candidates) ? candidates : []) {
    const id = typeof row === 'string' ? row : row && row.id
    if (typeof id === 'string' && id && !ids.includes(id)) ids.push(id)
  }
  return ids
}

function takeUnused(preferred, rankedIds, available, used) {
  for (const id of [preferred, ...rankedIds, ...available]) {
    if (typeof id === 'string' && id && available.includes(id) && !used.has(id)) {
      used.add(id)
      return id
    }
  }
  return undefined
}

export function assignRoles(decision, ranked, candidates) {
  const available = poolIds(candidates)
  const rankedIds = ranked.map((row) => row.agent)
  const used = new Set()
  const role = normalizeRole(decision && decision.role)
  const pick = decision && typeof decision.pick === 'string' ? decision.pick : undefined
  const planner = takeUnused(
    role === 'planner' ? pick : STATIC_FALLBACK.planner.pick,
    rankedIds,
    available,
    used,
  )
  const implementer = takeUnused(
    role === 'implementer' ? pick : STATIC_FALLBACK.implementer.pick,
    rankedIds,
    available,
    used,
  )
  let reviewer = takeUnused(
    role === 'reviewer' ? pick : STATIC_FALLBACK.reviewer.pick,
    rankedIds,
    available,
    used,
  )
  const notes = [GENERATION_NEQ_REVIEW_COPY]
  if (!reviewer || reviewer === implementer) {
    reviewer = takeUnused(undefined, rankedIds, available, used) || reviewer || implementer
    if (reviewer === implementer) notes.push(POOL_TOO_SMALL_COPY)
  }
  return {
    roles: [
      { role: 'planner', model: planner || STATIC_FALLBACK.planner.pick },
      { role: 'implementer', model: implementer || STATIC_FALLBACK.implementer.pick },
      { role: 'reviewer', model: reviewer || STATIC_FALLBACK.reviewer.pick },
    ],
    notes,
    distinct: Boolean(implementer && reviewer && implementer !== reviewer),
  }
}

export function assembleTeam(decision, state, options = {}) {
  const candidates = options.candidates && options.candidates.length > 0
    ? options.candidates
    : defaultPoolCandidates()
  const label = (decision && (decision.label || decision.role)) || 'implementer'
  const bench = options.bench ?? allocationBench()
  // RSI:'thompson' = 一次采样探索(FuguNano --sample);分数是抽样值不是均值,asm 行必须如实标 ranking。
  const sampling = options.sampling === 'thompson' ? 'thompson' : 'mean'
  const ranked = rankAgents(label, bench, state ?? [], options.params ?? DEFAULT_ALLOCATION_PARAMS, {
    sample: sampling === 'thompson',
    random: typeof options.random === 'function' ? options.random : Math.random,
  })
  const assigned = assignRoles(decision || {}, ranked, candidates)
  const halfLife = Number.isFinite(options.halfLifeDays) && options.halfLifeDays > 0 ? options.halfLifeDays : 0
  return {
    kind: 'assemble',
    label,
    ranking: sampling,
    // decay=null 表示「没开衰减」;开了就记口径与有效证据量——读的口径要能被读出来。
    decay: halfLife > 0 ? { halfLifeDays: halfLife, effectiveObservations: effectiveObservations(state, label) } : null,
    source: (decision && decision.source) || 'fallback',
    pick: decision && decision.pick,
    dispatched: false,
    note: ASSEMBLE_COPY,
    live: LIVE_DISPATCH_OFF_COPY,
    roles: assigned.roles,
    notes: assigned.notes,
    distinct: assigned.distinct,
    allocation: ranked.slice(0, 6).map((row) => ({
      model: row.agent,
      score: row.score,
      benchRank: row.benchRank,
    })),
  }
}

export function buildAssembleRecord(decision, team) {
  return {
    kind: 'assemble',
    id: mintAssembleId(),
    ref: decision && decision.id,
    // The task this proposal is for, carried from the decision so the trial that
    // follows can prove it ran the same task instead of only the same proposal id.
    ...(isTaskFingerprint(decision && decision.taskRef) ? { taskRef: decision.taskRef } : {}),
    ts: Date.now(),
    label: team.label,
    ranking: team.ranking === 'thompson' ? 'thompson' : 'mean',
    decay: team.decay && typeof team.decay === 'object' ? team.decay : null,
    source: team.source,
    pick: team.pick,
    dispatched: false,
    note: team.note,
    live: team.live,
    roles: team.roles,
    notes: team.notes,
    distinct: team.distinct,
    // 审查 P2-5:后验证据原来算完就丢,台账里看不出「这三角色是后验排的还是静态表排的」。
    allocation: Array.isArray(team.allocation) ? team.allocation : [],
  }
}

export async function assembleLive(input, deps = {}) {
  const { decide } = deps
  if (typeof decide !== 'function') {
    throw new Error('assembleLive requires decide()')
  }
  const candidates = Array.isArray(input && input.candidates) && input.candidates.length > 0
    ? input.candidates
    : defaultPoolCandidates()
  const decision = await decide({
    ...input,
    candidates,
  })
  const rows = typeof deps.readRows === 'function' ? deps.readRows() : []
  const halfLifeDays = Number.isFinite(deps.halfLifeDays) && deps.halfLifeDays > 0 ? deps.halfLifeDays : 0
  const state = allocationStateFromLedger(rows, { halfLifeDays, now: Number.isFinite(deps.now) ? deps.now : Date.now() })
  const team = assembleTeam(decision, state, {
    candidates,
    sampling: deps.sampling === 'thompson' ? 'thompson' : 'mean',
    random: typeof deps.random === 'function' ? deps.random : Math.random,
    halfLifeDays,
  })
  const record = buildAssembleRecord(decision, team)
  if (typeof deps.append === 'function') deps.append(record)
  return { decision, assemble: record, dispatched: false }
}
