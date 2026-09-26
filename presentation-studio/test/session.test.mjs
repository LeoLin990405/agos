import test from 'node:test'
import assert from 'node:assert/strict'
import {
  commitPartial,
  createSession,
  englishCaption,
  ingest,
  isHold,
  mandarinCaption,
  readRecognitionResults,
  setProvisional,
  splitClauses,
} from '../lib/session.mjs'

test('a finished comma is ready before the utterance ends, a short one is held', () => {
  const state = createSession()
  const early = ingest(state, { partial: '今天我们开始演示同声传译，下一步' })
  assert.deepEqual(early.stable.map((clause) => clause.source), ['今天我们开始演示同声传译，'])
  assert.equal(early.provisionalSource, '下一步')
  assert.equal(mandarinCaption(state), '今天我们开始演示同声传译，下一步')

  const held = createSession()
  const greeting = ingest(held, { partial: '各位好，我是' })
  assert.deepEqual(greeting.stable, [])
  assert.equal(greeting.provisionalSource, '各位好，我是')
})

test('a cumulative hypothesis does not repeat earlier clauses', () => {
  const sample = '各位好，我是林中岳。今天演示同声传译。我说中文，英文会同时出来，然后我们录像。'
  const state = createSession()
  for (let i = 1; i <= sample.length; i += 1) ingest(state, { partial: sample.slice(0, i) })
  commitPartial(state)
  assert.deepEqual(state.clauses.map((clause) => clause.source), [
    '各位好，我是林中岳。',
    '今天演示同声传译。',
    '我说中文，英文会同时出来，',
    '然后我们录像。',
  ])
})

test('final results do not duplicate clauses already taken from interim text', () => {
  const state = createSession()
  ingest(state, { partial: '各位好，我是林中岳。' })
  const again = ingest(state, { finals: ['各位好，我是林中岳。'], partial: '' })
  assert.equal(again.stable.length, 0)
  assert.deepEqual(state.clauses.map((clause) => clause.source), ['各位好，我是林中岳。'])
})

test('a pause commits the unfinished tail and keeps its live translation', () => {
  const state = createSession()
  ingest(state, { partial: '今天天气很好' })
  assert.equal(setProvisional(state, '今天天气很好', 'The weather is lovely today'), true)
  const committed = commitPartial(state)
  assert.equal(committed.length, 1)
  assert.equal(committed[0].english, 'The weather is lovely today')
  assert.equal(englishCaption(state), 'The weather is lovely today')
  assert.equal(state.partial, '')
})

test('stale provisional text is dropped when the hypothesis changes', () => {
  const state = createSession()
  ingest(state, { partial: '今天' })
  setProvisional(state, '今天', 'Today')
  ingest(state, { partial: '今天我们' })
  assert.equal(englishCaption(state), '')
})

test('a pause keeps a finished tail and leaves a dangling copula unspoken', () => {
  const state = createSession()
  ingest(state, { partial: '我是' })
  assert.equal(isHold('我是'), true)
  assert.deepEqual(commitPartial(state), [])
  assert.equal(state.partial, '我是')
})

test('a pause then a longer final revises the unspoken clause', () => {
  const state = createSession()
  ingest(state, { partial: '今天演示同声' })
  const committed = commitPartial(state)
  assert.equal(committed[0].source, '今天演示同声')
  const next = ingest(state, { partial: '今天演示同声传译。' })
  assert.equal(state.clauses.length, 1)
  assert.equal(state.clauses[0].source, '今天演示同声传译。')
  assert.equal(next.stable[0].id, committed[0].id)
})

test('a revised name replaces the unspoken clause instead of speaking the suffix', () => {
  const state = createSession()
  ingest(state, { partial: '我是林中' })
  commitPartial(state)
  ingest(state, { partial: '我是林忠岳。' })
  assert.deepEqual(state.clauses.map((clause) => clause.source), ['我是林忠岳。'])
})

test('ascii thousands separators stay inside one clause', () => {
  const { stable, tail } = splitClauses('我们有1,000个用户，营收3,500万。')
  assert.deepEqual(stable, ['我们有1,000个用户，', '营收3,500万。'])
  assert.equal(tail, '')
})

test('a hold comma stays with the sentence until the full stop', () => {
  const state = createSession()
  const step = ingest(state, { partial: '我是，林中岳。' })
  assert.deepEqual(step.stable.map((clause) => clause.source), ['我是，林中岳。'])
})

test('finalizing the same words keeps the provisional English', () => {
  const state = createSession()
  ingest(state, { partial: '今天天气很好' })
  setProvisional(state, '今天天气很好', 'The weather is nice')
  const next = ingest(state, { finals: ['今天天气很好'], partial: '' })
  assert.equal(next.stable[0].english, 'The weather is nice')
  assert.equal(englishCaption(state), 'The weather is nice')
})

test('a comma after provisional English keeps that English on the clause', () => {
  const state = createSession()
  ingest(state, { partial: '今天天气很好' })
  setProvisional(state, '今天天气很好', 'The weather is nice')
  ingest(state, { partial: '今天天气很好，我们' })
  assert.equal(state.clauses[0].source, '今天天气很好，')
  assert.equal(state.clauses[0].english, 'The weather is nice')
  assert.equal(englishCaption(state), 'The weather is nice')
  assert.equal(state.partial, '我们')
})

test('recognition events keep only new finals plus the current interim', () => {
  const results = [
    { isFinal: true, 0: { transcript: '各位好，' } },
    { isFinal: false, 0: { transcript: '我是林' } },
  ]
  assert.deepEqual(readRecognitionResults(results, 0), {
    finals: ['各位好，'],
    partial: '我是林',
  })
  assert.deepEqual(readRecognitionResults(results, 1), {
    finals: [],
    partial: '我是林',
  })
})
