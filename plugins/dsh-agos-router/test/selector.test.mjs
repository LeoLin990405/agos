import assert from 'node:assert/strict'
import test from 'node:test'
import { DEFAULT_SELECTOR_CONFIG, escalationPriority, route, smoothed } from '../lib/selector.js'

const labeled = (agent, label) => ({ agent, label })
const cfg = (overrides = {}) => ({ ...DEFAULT_SELECTOR_CONFIG, ...overrides })

test('priority 1: verified candidate is the only clean TRUST', () => {
  const d = route([
    { agent: 'mimo', verified: false },
    { agent: 'doubao', verified: true },
    { agent: 'stepfun', verified: false },
  ])
  assert.equal(d.outcome, 'TRUST')
  assert.equal(d.pick, 'doubao')
  assert.equal(d.reason, 'gate-verified')
  assert.equal(d.confidence, 1)
})

test('priority 1: gate ran and nobody passed → ESCALATE', () => {
  const d = route([
    { agent: 'a', verified: false },
    { agent: 'b', verified: false },
  ])
  assert.equal(d.outcome, 'ESCALATE')
  assert.equal(d.reason, 'gate-failed')
})

test('priority order: verified still TRUST even on a forced-escalate category', () => {
  const d = route(
    [
      { agent: 'a', verified: true, label: 'X' },
      { agent: 'b', verified: false, label: 'X' },
    ],
    cfg(),
    'security',
  )
  assert.equal(d.outcome, 'TRUST')
  assert.equal(d.reason, 'gate-verified')
  assert.equal(DEFAULT_SELECTOR_CONFIG.trustThreshold, 0.7)
})

test('priority 2: forced-escalate category skips consensus', () => {
  const d = route(
    ['mimo', 'stepfun', 'doubao'].map((a) => labeled(a, 'same')),
    cfg(),
    'security',
  )
  assert.equal(d.outcome, 'ESCALATE')
  assert.equal(d.reason, 'forced-category')
})

test('priority 3: unanimous labels are TRUST_SPOT_CHECK not TRUST', () => {
  const d = route(['a', 'b', 'c', 'd', 'e'].map((a) => labeled(a, 'A')))
  assert.equal(d.outcome, 'TRUST_SPOT_CHECK')
  assert.equal(d.reason, 'quorum')
  assert.equal(d.confidence, 6 / 7)
})

test('Laplace boundary: 4/5 passes 0.7, 3/5 escalates', () => {
  const four = [...['a', 'b', 'c', 'd'].map((x) => labeled(x, 'A')), labeled('e', 'B')]
  const three = [
    ...['a', 'b', 'c'].map((x) => labeled(x, 'A')),
    labeled('d', 'B'),
    labeled('e', 'C'),
  ]
  const pass = route(four)
  assert.equal(pass.outcome, 'TRUST_SPOT_CHECK')
  assert.equal(pass.confidence, 5 / 7)
  const fail = route(three)
  assert.equal(fail.outcome, 'ESCALATE')
  assert.equal(fail.reason, 'split')
  assert.equal(fail.confidence, 4 / 7)
  assert.equal(smoothed(5, 5), 6 / 7)
  assert.equal(DEFAULT_SELECTOR_CONFIG.trustThreshold, 0.7)
  assert.equal(route(four, cfg({ trustThreshold: 0.8 })).outcome, 'ESCALATE')
  assert.equal(route(three, cfg({ trustThreshold: 0.5 })).outcome, 'TRUST_SPOT_CHECK')
})

test('empty / singleton / unlabeled no-signal vs labeled split', () => {
  assert.equal(route([]).reason, 'empty')
  assert.equal(route([labeled('a', 'A')]).reason, 'singleton')
  const noSignal = route([{ agent: 'a' }, { agent: 'b' }])
  assert.equal(noSignal.reason, 'no-signal')
  assert.equal(noSignal.outcome, 'ESCALATE')
  const split = route([
    labeled('a', 'A'),
    labeled('b', 'A'),
    labeled('c', 'B'),
    labeled('d', 'C'),
    labeled('e', 'D'),
  ])
  assert.equal(split.reason, 'split')
  assert.equal(split.outcome, 'ESCALATE')
  assert.notEqual(noSignal.reason, split.reason)
})

test('escalationPriority spends lowest confidence first', () => {
  const decisions = [
    route([]),
    route(['a', 'b', 'c'].map((x) => labeled(x, 'A'))),
    route([{ agent: 'x', verified: false }]),
  ]
  // Equal confidence: gate-failed ranks ahead of empty.
  assert.deepEqual(escalationPriority(decisions), [2, 0])
  const byConfidence = [
    { outcome: 'ESCALATE', reason: 'split', confidence: 0.4, agreementShare: 0.4 },
    { outcome: 'ESCALATE', reason: 'split', confidence: 0.1, agreementShare: 0.1 },
    { outcome: 'TRUST_SPOT_CHECK', reason: 'quorum', confidence: 0.8, agreementShare: 0.8 },
  ]
  assert.deepEqual(escalationPriority(byConfidence), [1, 0])
})
