// Sakana Fugu / FuguNano poor-man's conductor:
// small classifier (StepFun or static table) + Beta-Bernoulli posterior
// → planner / implementer / reviewer team. Does not switch the live session model.
import { DEFAULT_ALLOCATION_PARAMS } from './allocation.js'
import { applyOutcome, rankAgents } from './allocation-score.js'
import { STATIC_FALLBACK } from './fallback.js'
import { foldLedger } from './ledger.js'
import { normalizeRole } from './roles.js'

// 冻结文案与 ~/Projects/agos-frontend/src/components/console/routes-assemble.ts 逐字镜像;
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

export function allocationStateFromLedger(rows) {
  const { decisions } = foldLedger(Array.isArray(rows) ? rows : [])
  let state = []
  for (const row of decisions) {
    if (row.outcome !== 'ok' && row.outcome !== 'fail') continue
    const taskType = row.label || row.taskType || row.role
    const agent = row.pick
    if (!taskType || !agent) continue
    state = applyOutcome(state, { taskType, agent, result: row.outcome })
  }
  return state
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
  const ranked = rankAgents(label, bench, state ?? [], options.params ?? DEFAULT_ALLOCATION_PARAMS, {
    sample: false,
  })
  const assigned = assignRoles(decision || {}, ranked, candidates)
  return {
    kind: 'assemble',
    label,
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
    id: `asm-${Date.now()}`,
    ref: decision && decision.id,
    ts: Date.now(),
    label: team.label,
    source: team.source,
    pick: team.pick,
    dispatched: false,
    note: team.note,
    live: team.live,
    roles: team.roles,
    notes: team.notes,
    distinct: team.distinct,
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
  const team = assembleTeam(decision, allocationStateFromLedger(rows), { candidates })
  const record = buildAssembleRecord(decision, team)
  if (typeof deps.append === 'function') deps.append(record)
  return { decision, assemble: record, dispatched: false }
}
