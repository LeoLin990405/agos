import assert from 'node:assert/strict'
import test from 'node:test'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionAddress, SessionHistoryRecord, SessionWireHeader } from '../contract/api/sessions.ts'
import {
  applyOpeningSnapshot,
  applyPageFailure,
  applyPageSuccess,
  beginEarlierPage,
  cancelHistory,
  historyRecordSeq,
  idleHistory,
  isStaleHistoryResponse,
  loadEarlierHistoryAction,
  noteLiveEvent,
  sameAddress,
  type FollowSnapshotInput,
  type SessionHistoryState,
} from './session-history.ts'

function sid(id: string): SessionId {
  return id as SessionId
}

function address(id: string): SessionAddress {
  return { kind: 'session', sessionId: sid(id) }
}

function header(id: string): SessionWireHeader {
  return { version: 1, id: sid(id), createdAt: 1_700_000_000_000 }
}

function ev(seq: number, type = 'message'): SessionHistoryRecord {
  return { type: 'event', event: { type, seq, time: seq * 10, data: { n: seq } } }
}

function chunk(seq: number): SessionHistoryRecord {
  return {
    type: 'chunks',
    event: { type: 'chunkrow/text-chunks', seq, time: seq * 10, data: { turn: 1, step: 1, index: 0, dt: [], texts: ['x'] } },
  }
}

function snapshot(id: string, extra: Partial<FollowSnapshotInput> = {}): FollowSnapshotInput {
  return {
    header: header(id),
    cursor: 10,
    records: [ev(8), ev(9), ev(10)],
    hasMore: true,
    projections: { asOfSeq: 10, values: {} },
    ...extra,
  }
}

function applySeqs(state: SessionHistoryState): number[] {
  return state.recordsToApply.map(historyRecordSeq)
}

test('opening snapshot stores header, cursor, hasMore, projections and keeps host record order', () => {
  const opened = applyOpeningSnapshot(idleHistory(), address('s1'), snapshot('s1', {
    records: [ev(10), ev(8), ev(9)],
    projections: { asOfSeq: 10, values: { title: 'kept' } as FollowSnapshotInput['projections']['values'] },
  }))

  assert.equal(opened.throughSeq, 10)
  assert.deepEqual(opened.header, header('s1'))
  assert.deepEqual(opened.projections, { asOfSeq: 10, values: { title: 'kept' } })
  assert.equal(opened.hasMore, true)
  assert.equal(opened.historyIncomplete, true)
  assert.equal(opened.retryable, false)
  assert.equal(opened.applyMode, 'snapshot-host-order')
  assert.equal(opened.rebuildRequired, true)
  assert.deepEqual(applySeqs(opened), [10, 8, 9], 'must not sort snapshot records — same as live.ts onFollowValue')
  assert.equal(opened.oldestSeq, 8)
  assert.equal(opened.newestSeq, 10)
  assert.equal(opened.generation, 1)
})

test('empty snapshot cursor -1 is a complete empty session, not a truncated window', () => {
  const opened = applyOpeningSnapshot(idleHistory(), address('empty'), snapshot('empty', {
    cursor: -1,
    records: [],
    hasMore: false,
    projections: { asOfSeq: -1, values: {} },
  }))

  assert.equal(opened.throughSeq, -1)
  assert.equal(opened.hasMore, false)
  assert.equal(opened.historyIncomplete, false)
  assert.equal(loadEarlierHistoryAction(opened), undefined)
})

test('hasMore snapshot never treats the current window as the full session', () => {
  const opened = applyOpeningSnapshot(idleHistory(), address('s1'), snapshot('s1'))
  const action = loadEarlierHistoryAction(opened, { maxMessages: 40 })

  assert.equal(opened.historyIncomplete, true)
  assert.ok(action)
  assert.equal(action.type, 'load-earlier-history')
  assert.equal(action.method, 'session/page')
  assert.equal(action.throughSeq, 10)
  assert.equal(action.beforeSeq, 8)
  assert.equal(action.maxMessages, 40)
  assert.equal(action.generation, opened.generation)
  assert.deepEqual(action.address, address('s1'))
})

test('page merge dedupes by seq, tolerates out-of-order, and rebuilds in seq order', () => {
  const opened = applyOpeningSnapshot(idleHistory(), address('s1'), snapshot('s1', {
    records: [ev(8), ev(9), ev(10)],
  }))
  const { state: pending, action } = beginEarlierPage(opened)
  assert.ok(action)
  const merged = applyPageSuccess(pending, {
    address: action.address,
    generation: action.generation,
    records: [ev(6), ev(8), ev(4), ev(7), chunk(5)],
    hasMore: false,
  })

  assert.equal(merged.hasMore, false)
  assert.equal(merged.historyIncomplete, false)
  assert.equal(merged.retryable, false)
  assert.equal(merged.applyMode, 'union-seq-order')
  assert.equal(merged.rebuildRequired, true)
  assert.deepEqual(applySeqs(merged), [4, 5, 6, 7, 8, 9, 10])
  assert.equal(merged.oldestSeq, 4)
  assert.equal(merged.heldRecords.filter((r) => historyRecordSeq(r) === 8).length, 1)
})

test('page failure keeps the window, sets historyIncomplete + retryable, and never claims completeness', () => {
  const opened = applyOpeningSnapshot(idleHistory(), address('s1'), snapshot('s1'))
  const { state: pending, action } = beginEarlierPage(opened)
  assert.ok(action)
  const failed = applyPageFailure(pending, {
    address: action.address,
    generation: action.generation,
    error: new Error('gateway 502'),
  })

  assert.equal(failed.historyIncomplete, true)
  assert.equal(failed.retryable, true)
  assert.equal(failed.hasMore, true, 'failure must not flip hasMore to false')
  assert.equal(failed.pageError, 'gateway 502')
  assert.equal(failed.rebuildRequired, false)
  assert.deepEqual(applySeqs(failed), [8, 9, 10])
  const retry = loadEarlierHistoryAction(failed)
  assert.ok(retry)
  assert.equal(retry.throughSeq, 10)
  assert.equal(retry.beforeSeq, 8)
})

test('late page for a previous generation is dropped', () => {
  const opened = applyOpeningSnapshot(idleHistory(), address('s1'), snapshot('s1'))
  const { state: pending, action } = beginEarlierPage(opened)
  assert.ok(action)
  const reconnected = applyOpeningSnapshot(pending, address('s1'), snapshot('s1', {
    cursor: 12,
    records: [ev(11), ev(12)],
    hasMore: true,
  }))
  assert.equal(reconnected.generation, opened.generation + 1)
  assert.equal(reconnected.pending, undefined)
  assert.equal(isStaleHistoryResponse(reconnected, action), true)

  const late = applyPageSuccess(reconnected, {
    address: action.address,
    generation: action.generation,
    records: [ev(1)],
    hasMore: false,
  })
  assert.deepEqual(applySeqs(late), [11, 12])
  assert.equal(late.historyIncomplete, true)
  assert.equal(late.hasMore, true)
})

test('session switch cancel drops late pages for the previous address', () => {
  const opened = applyOpeningSnapshot(idleHistory(), address('s1'), snapshot('s1'))
  const { state: pending, action } = beginEarlierPage(opened)
  assert.ok(action)
  const cancelled = cancelHistory(pending)
  assert.equal(cancelled.address, undefined)
  assert.equal(cancelled.generation, opened.generation + 1)

  const late = applyPageSuccess(cancelled, {
    address: action.address,
    generation: action.generation,
    records: [ev(1)],
    hasMore: false,
  })
  assert.deepEqual(late.heldRecords, [])
  assert.equal(late.historyIncomplete, false)

  const switched = applyOpeningSnapshot(cancelled, address('s2'), snapshot('s2', { cursor: 3, records: [ev(3)], hasMore: false }))
  const lateAfterSwitch = applyPageFailure(switched, {
    address: action.address,
    generation: action.generation,
    error: 'gone',
  })
  assert.equal(lateAfterSwitch.retryable, false)
  assert.equal(lateAfterSwitch.historyIncomplete, false)
  assert.deepEqual(applySeqs(lateAfterSwitch), [3])
})

test('window edge without held records still pages with throughSeq only', () => {
  const opened = applyOpeningSnapshot(idleHistory(), address('s1'), snapshot('s1', {
    cursor: 40,
    records: [],
    hasMore: true,
  }))
  const action = loadEarlierHistoryAction(opened)
  assert.ok(action)
  assert.equal(action.throughSeq, 40)
  assert.equal(action.beforeSeq, undefined)
})

test('in-flight page suppresses a second load-earlier action', () => {
  const opened = applyOpeningSnapshot(idleHistory(), address('s1'), snapshot('s1'))
  const first = beginEarlierPage(opened)
  const second = beginEarlierPage(first.state)
  assert.ok(first.action)
  assert.equal(second.action, undefined)
  assert.equal(first.state.pending?.generation, first.action.generation)
})

test('page rebuild replays the live tail and keeps throughSeq at the snapshot cursor', () => {
  const opened = applyOpeningSnapshot(idleHistory(), address('s1'), snapshot('s1'))
  const withLive = noteLiveEvent(noteLiveEvent(opened, ev(11).event), ev(12).event)
  assert.equal(withLive.throughSeq, 10)
  assert.equal(withLive.applyMode, 'snapshot-host-order')
  assert.deepEqual(withLive.liveTail.map(historyRecordSeq), [11, 12])
  assert.equal(noteLiveEvent(withLive, ev(10).event), withLive, 'seq inside the snapshot window is not a live tail')

  const { state: pending, action } = beginEarlierPage(withLive)
  assert.ok(action)
  assert.equal(action.throughSeq, 10, 'page still cuts at the snapshot cursor, not the live tip')
  const merged = applyPageSuccess(pending, {
    address: action.address,
    generation: action.generation,
    records: [ev(6), ev(7)],
    hasMore: false,
  })
  assert.deepEqual(applySeqs(merged), [6, 7, 8, 9, 10, 11, 12])
  assert.equal(merged.throughSeq, 10)
  assert.equal(merged.newestSeq, 12)
})

test('sameAddress distinguishes session and subagent children', () => {
  assert.equal(sameAddress(address('a'), address('a')), true)
  assert.equal(sameAddress(address('a'), address('b')), false)
  assert.equal(sameAddress(
    { kind: 'subagent', parentSessionId: sid('p'), childSessionId: sid('c'), mode: 'one-shot' },
    { kind: 'subagent', parentSessionId: sid('p'), childSessionId: sid('c'), mode: 'one-shot' },
  ), true)
  assert.equal(sameAddress(
    { kind: 'subagent', parentSessionId: sid('p'), childSessionId: sid('c'), mode: 'one-shot' },
    { kind: 'subagent', parentSessionId: sid('p'), childSessionId: sid('c'), mode: 'continuable' },
  ), false)
})
