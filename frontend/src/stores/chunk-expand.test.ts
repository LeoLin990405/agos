import assert from 'node:assert/strict'
import test from 'node:test'
import { expandChunkRun } from './chunk-expand.ts'

test('text-chunks row expands to consecutive assistant/chunk text deltas with seq+time reconstruction', () => {
  const events = expandChunkRun({
    type: 'chunkrow/text-chunks', seq: 10, time: 1000,
    data: { turn: 1, step: 2, index: 0, dt: [5, 7], texts: ['你', '好', '。'] },
  })
  assert.equal(events.length, 3)
  assert.deepEqual(events.map((e) => [e.seq, e.time]), [[10, 1000], [11, 1005], [12, 1012]])
  assert.deepEqual(events.map((e) => (e.data.chunk as { text: string }).text), ['你', '好', '。'])
  assert.ok(events.every((e) => e.type === 'assistant/chunk' && e.data.turn === 1 && e.data.step === 2))
  assert.ok(events.every((e) => e.data.chunk.type === 'text-delta'))
})

test('tool-call-chunks row carries the run-constant id/name and per-member argument fragments', () => {
  const events = expandChunkRun({
    type: 'chunkrow/tool-call-chunks', seq: 3, time: 500,
    data: { turn: 0, step: 0, index: 1, dt: [2], id: 'call_1', name: 'bash', args: ['{"cmd":"', 'ls"}'] },
  })
  assert.equal(events.length, 2)
  const chunk0 = events[0]?.data.chunk as { type: string; id: string; name?: string; argumentsDelta: string }
  assert.equal(chunk0.type, 'tool-call-delta')
  assert.equal(chunk0.id, 'call_1')
  assert.equal(chunk0.name, 'bash')
  assert.equal(chunk0.argumentsDelta, '{"cmd":"')
  assert.equal((events[1]?.data.chunk as { argumentsDelta: string }).argumentsDelta, 'ls"}')
})

test('malformed or unknown chunkrow shapes drop to [] rather than throwing', () => {
  assert.deepEqual(expandChunkRun(null), [])
  assert.deepEqual(expandChunkRun({ type: 'chunkrow/unknown', seq: 1, time: 1, data: {} }), [])
  assert.deepEqual(expandChunkRun({ type: 'chunkrow/text-chunks', seq: 'x', time: 1, data: { texts: ['a'] } }), [])
  assert.deepEqual(expandChunkRun({ type: 'event', seq: 1, time: 1, data: {} }), [])
})
