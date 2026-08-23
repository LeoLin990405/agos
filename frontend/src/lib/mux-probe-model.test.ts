import assert from 'node:assert/strict'
import test from 'node:test'
import { createProbeState, MUX_FRAME_TYPES, recordFrame, recordReconnect, snapshot } from './mux-probe-model.ts'

test('按 type 累加;同 rpcId 的 question/requested 重放只计 distinct 1;host/* 不进 mux 统计', () => {
  let s = createProbeState(1000)
  s = recordFrame(s, { type: 'session/event' }, 1001)
  s = recordFrame(s, { type: 'session/event' }, 1002)
  s = recordFrame(s, { type: 'question/requested', rpcId: 'q-1' }, 1003)
  s = recordReconnect(s)
  s = recordFrame(s, { type: 'question/requested', rpcId: 'q-1' }, 1004)   // 重连回放
  s = recordFrame(s, { type: 'question/requested', rpcId: 'q-2' }, 1005)
  s = recordFrame(s, { type: 'approval/requested', rpcId: 'a-1' }, 1006)
  s = recordFrame(s, { type: 'host/status' }, 1007)
  assert.equal(s.byType['session/event'], 2)
  assert.equal(s.byType['question/requested'], 3)
  assert.equal(s.distinct['question/requested'], 2)
  assert.equal(s.distinct['approval/requested'], 1)
  assert.equal(s.reconnects, 1)
  assert.deepEqual(s.other, { 'host/status': 1 })
  assert.equal(s.lastFrameAt, 1007)
  assert.equal(MUX_FRAME_TYPES.length, 10)
})

test('snapshot:10 类全列(没来过的写 0),不带 rpcId 明细', () => {
  let s = createProbeState(1000)
  s = recordFrame(s, { type: 'question/requested', rpcId: 'secret-rpc-id' }, 1003)
  const snap = snapshot(s, 5000)
  assert.equal(Object.keys(snap.byType as object).length, 10)
  assert.equal((snap.byType as Record<string, number>)['stream/error'], 0)
  assert.equal((snap.byType as Record<string, number>)['question/requested'], 1)
  assert.equal(snap.uptimeMs, 4000)
  assert.doesNotMatch(JSON.stringify(snap), /secret-rpc-id|seenRpc/)
})

test('没有 rpcId 的帧不会被误去重', () => {
  let s = createProbeState(0)
  s = recordFrame(s, { type: 'approval/requested' }, 1)
  s = recordFrame(s, { type: 'approval/requested' }, 2)
  assert.equal(s.distinct['approval/requested'], 2)
})
