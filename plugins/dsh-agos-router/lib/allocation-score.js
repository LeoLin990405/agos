// Port of FuguNano engine/src/domain/allocation-score.ts.
// Bookkeeping / offline ranking only — do not wire into live dispatch this round.
import { UNLISTED_RANK } from './allocation.js'
import { betaPrior, q6 } from '../../dsh-agos/lib/allocate-kernel.js'

export { betaPrior, q6 }

export function betaPseudoCounts(p0, kappa) {
  return { a0: kappa * p0 + 1, b0: kappa * (1 - p0) + 1 }
}

export const applyOutcome = (state, outcome, weight = 1) => {
  // weight:读取期衰减的口径(2^(-age/halfLife));默认 1 = FuguNano 原语义。
  const w = Number.isFinite(weight) && weight > 0 ? weight : 0
  if (w === 0) return state
  let updated = false
  const next = state.map((entry) => {
    if (entry.taskType !== outcome.taskType || entry.agent !== outcome.agent) return entry
    updated = true
    return {
      taskType: entry.taskType,
      agent: entry.agent,
      s: entry.s + (outcome.result === 'ok' ? w : 0),
      f: entry.f + (outcome.result === 'fail' ? w : 0),
    }
  })
  if (updated) return next
  return [
    ...next,
    {
      taskType: outcome.taskType,
      agent: outcome.agent,
      s: outcome.result === 'ok' ? w : 0,
      f: outcome.result === 'fail' ? w : 0,
    },
  ]
}

export const decayState = (state, gamma, taskType) =>
  state.map((entry) => {
    if (taskType !== undefined && entry.taskType !== taskType) return entry
    return { taskType: entry.taskType, agent: entry.agent, s: entry.s * gamma, f: entry.f * gamma }
  })

export const thompsonScore = (A, B, random) => {
  const mean = A / (A + B)
  const variance = (A * B) / ((A + B) * (A + B) * (A + B + 1))
  const sd = Math.sqrt(variance)
  const z = Math.sqrt(-2 * Math.log(random() + 1e-12)) * Math.cos(2 * Math.PI * random())
  const value = mean + z * sd
  return Math.min(1, Math.max(0, value))
}

export const rankAgents = (taskType, bench, state, params, opts) => {
  const listed = bench.get(taskType) ?? []
  const priorByAgent = new Map()
  const rankByAgent = new Map()
  const evidenceByAgent = new Map()
  const candidates = new Set()

  for (const [index, agent] of listed.entries()) {
    priorByAgent.set(agent, betaPrior(index, listed.length))
    rankByAgent.set(agent, index + 1)
    candidates.add(agent)
  }

  for (const entry of state) {
    if (entry.taskType !== taskType) continue
    evidenceByAgent.set(entry.agent, { s: entry.s, f: entry.f })
    candidates.add(entry.agent)
  }

  const ranked = []
  for (const agent of candidates) {
    const p0 = priorByAgent.get(agent) ?? params.unlistedPrior
    const evidence = evidenceByAgent.get(agent) ?? { s: 0, f: 0 }
    const a0 = params.kappa * p0 + 1
    const b0 = params.kappa * (1 - p0) + 1
    const A = a0 + evidence.s
    const B = b0 + evidence.f
    ranked.push({
      agent,
      score: opts.sample ? thompsonScore(A, B, opts.random) : A / (A + B),
      benchRank: rankByAgent.get(agent) ?? UNLISTED_RANK,
    })
  }

  return ranked.sort((left, right) => {
    const scoreOrder = q6(right.score) - q6(left.score)
    if (scoreOrder !== 0) return scoreOrder
    const rankOrder = left.benchRank - right.benchRank
    if (rankOrder !== 0) return rankOrder
    if (left.agent < right.agent) return -1
    if (left.agent > right.agent) return 1
    return 0
  })
}

/** Offline ranking helper: sample is ON so non-head cells can accumulate evidence. */
export const rankAgentsExploring = (taskType, bench, state, params, random = Math.random) =>
  rankAgents(taskType, bench, state, params, { sample: true, random })
