import test from 'node:test'
import assert from 'node:assert/strict'
import {
  commitPartial,
  createSession,
  englishCaption,
  ingest,
  mandarinCaption,
  readRecognitionResults,
  setProvisional,
} from '../lib/session.mjs'

test('a clause is ready for interpretation before the utterance finishes', () => {
  const state = createSession()
  const early = ingest(state, { partial: '各位好，我是' })
  assert.deepEqual(early.stable.map((clause) => clause.source), ['各位好，'])
  assert.equal(early.provisionalSource, '我是')
  assert.equal(mandarinCaption(state), '各位好，我是')

  const later = ingest(state, { partial: '各位好，我是林中岳。今天演示' })
  assert.deepEqual(later.stable.map((clause) => clause.source), ['我是林中岳。'])
  assert.equal(later.provisionalSource, '今天演示')
  assert.equal(state.clauses.length, 2)
})

test('a cumulative hypothesis does not repeat earlier clauses', () => {
  const sample = '各位好，我是林中岳。今天演示同声传译。我说中文，英文会同时出来，然后我们录像。'
  const state = createSession()
  for (let i = 1; i <= sample.length; i += 1) ingest(state, { partial: sample.slice(0, i) })
  commitPartial(state)
  assert.deepEqual(state.clauses.map((clause) => clause.source), [
    '各位好，',
    '我是林中岳。',
    '今天演示同声传译。',
    '我说中文，',
    '英文会同时出来，',
    '然后我们录像。',
  ])
})

test('final results do not duplicate clauses already taken from interim text', () => {
  const state = createSession()
  ingest(state, { partial: '各位好，我是林中岳。' })
  const again = ingest(state, { finals: ['各位好，我是林中岳。'], partial: '' })
  assert.equal(again.stable.length, 0)
  assert.deepEqual(state.clauses.map((clause) => clause.source), ['各位好，', '我是林中岳。'])
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
