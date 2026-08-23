import assert from 'node:assert/strict'
import test from 'node:test'
import { DEFAULT_ALLOCATION_PARAMS, UNLISTED_RANK } from '../lib/allocation.js'
import {
  applyOutcome,
  betaPrior,
  betaPseudoCounts,
  q6,
  rankAgents,
  rankAgentsExploring,
} from '../lib/allocation-score.js'

test('Beta-Bernoulli constants and prior formula stay pinned', () => {
  assert.equal(DEFAULT_ALLOCATION_PARAMS.kappa, 4)
  assert.equal(DEFAULT_ALLOCATION_PARAMS.unlistedPrior, 0.15)
  assert.equal(betaPrior(0, 3), 3 / 4)
  assert.equal(betaPrior(2, 3), 1 / 4)
  const { a0, b0 } = betaPseudoCounts(0.75, 4)
  assert.equal(a0, 4)
  assert.equal(b0, 2)
  const unlisted = betaPseudoCounts(0.15, 4)
  assert.equal(unlisted.a0, 1.6)
  assert.equal(unlisted.b0, 4.4)
})

test('q6 six-decimal quantization and codepoint tie-break', () => {
  assert.equal(q6(0.5), q6(0.5 + 4e-7))
  assert.notEqual(q6(0.5), q6(0.5 + 6e-7))
  const bench = new Map([['coding', []]])
  const state = [
    { taskType: 'coding', agent: 'zz', s: 0, f: 0 },
    { taskType: 'coding', agent: 'aa', s: 0, f: 0 },
  ]
  const ranked = rankAgents('coding', bench, state, DEFAULT_ALLOCATION_PARAMS, {
    sample: false,
    random: () => 0.5,
  })
  assert.equal(ranked[0].agent, 'aa')
  assert.equal(ranked[1].agent, 'zz')
  assert.equal(ranked[0].benchRank, UNLISTED_RANK)
})

test('greedy mean uses a0+s / (a0+b0+s+f) with the +1 prior', () => {
  const bench = new Map([['coding', ['alpha', 'beta']]])
  const greedy = rankAgents('coding', bench, [], DEFAULT_ALLOCATION_PARAMS, {
    sample: false,
    random: () => 0.5,
  })
  const p0 = betaPrior(0, 2)
  const { a0, b0 } = betaPseudoCounts(p0, 4)
  assert.equal(greedy[0].agent, 'alpha')
  assert.equal(greedy[0].score, a0 / (a0 + b0))
})

test('sampling with opposite z flips greedy order', () => {
  const bench = new Map([['coding', ['alpha', 'beta']]])
  const greedy = rankAgents('coding', bench, [], DEFAULT_ALLOCATION_PARAMS, {
    sample: false,
    random: () => 0.5,
  })
  assert.equal(greedy[0].agent, 'alpha')
  // Each agent consumes two random() calls: u1, u2 for Box-Muller z.
  // Small u1 + u2=0.5 → large negative z; small u1 + u2=0 → large positive z.
  const seq = [1e-6, 0.5, 1e-6, 0]
  let i = 0
  const exploring = rankAgentsExploring('coding', bench, [], DEFAULT_ALLOCATION_PARAMS, () => seq[i++ % seq.length])
  assert.equal(exploring[0].agent, 'beta')
  assert.notEqual(exploring[0].agent, greedy[0].agent)
})
