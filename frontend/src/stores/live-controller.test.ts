import assert from 'node:assert/strict'
import { afterEach, beforeEach, test } from 'node:test'
import {
  agos, approvalView, closeMux, conversationStore, getEventClientId,
  hasApprovalWaterfall, liveConnectionStore, loadEarlierHistory, openConversation, respondApproval,
} from './live.ts'

type Delivery = { value: unknown } | { error: Error } | { end: true }
class FakeStream {
  pending: Delivery[] = []
  wake: (() => void) | undefined
  push(value: unknown): void { this.pending.push({ value }); this.wake?.() }
  fail(message: string): void { this.pending.push({ error: new Error(message) }); this.wake?.() }
  async *read(signal: AbortSignal, onOpen?: () => void): AsyncGenerator<unknown> {
    const abort = (): void => { this.pending.push({ end: true }); this.wake?.() }
    signal.addEventListener('abort', abort, { once: true })
    onOpen?.()
    try {
      while (!signal.aborted) {
        if (this.pending.length === 0) await new Promise<void>((resolve) => { this.wake = resolve })
        this.wake = undefined
        const next = this.pending.shift()
        if (next === undefined || 'end' in next) return
        if ('error' in next) throw next.error
        yield next.value
      }
    } finally { signal.removeEventListener('abort', abort) }
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))
const original = { stream: agos.stream, events: agos.events, call: agos.call, postEventResult: agos.postEventResult }
let events: FakeStream
let sessions: Map<string, FakeStream>
let posts: Array<{ body: unknown; response: ReturnType<typeof deferred<void>> }>
let pages: Array<{ body: unknown; response: ReturnType<typeof deferred<unknown>> }>

beforeEach(() => {
  closeMux()
  events = new FakeStream()
  sessions = new Map()
  posts = []
  pages = []
  agos.events = ((signal: AbortSignal, onOpen?: () => void) => events.read(signal, onOpen)) as typeof agos.events
  agos.stream = (endpoint, args, signal, onOpen) => {
    assert.equal(endpoint, 'session/follow')
    const id = (args as { request: { address: { sessionId: string } } }).request.address.sessionId
    const stream = new FakeStream()
    sessions.set(id, stream)
    return stream.read(signal, onOpen)
  }
  agos.postEventResult = (body) => {
    const response = deferred<void>()
    posts.push({ body, response })
    return response.promise
  }
  agos.call = ((method: string, body: unknown) => {
    assert.equal(method, 'session/page', 'fixture must never access real sessions')
    const response = deferred<unknown>()
    pages.push({ body, response })
    return response.promise
  }) as typeof agos.call
})
afterEach(() => { closeMux(); Object.assign(agos, original) })

function record(seq: number, type: string, data: unknown, extra = {}) {
  return { type: 'event' as const, event: { seq, type, data, time: seq, ...extra } }
}
const user = (seq: number, text: string) => record(seq, 'user/message', { content: [{ type: 'text', text }], source: { kind: 'user' } })
function snapshot(id: string, cursor: number, records: unknown[], hasMore = false, values = {}) {
  return { type: 'snapshot', header: { version: 1, id, createdAt: 1, cwd: '/synthetic' }, cursor, records, hasMore, projections: { asOfSeq: cursor, values } }
}
async function open(id = 'a', records: unknown[] = [], cursor = 10, hasMore = false, values = {}) {
  openConversation(id)
  events.push({ type: 'ready', clientId: 'client-fixture', host: { home: '/synthetic' } })
  sessions.get(id)!.push(snapshot(id, cursor, records, hasMore, values))
  await flush()
}
async function approval(id = 'a', callId = 'call', eventId = 'event') {
  await open(id, [record(1, 'approval/asked', { id: `approval-${id}`, callId, toolName: 'bash' })])
  events.push({ type: 'waterfall', event: 'approval/request', eventId, agentId: id, request: { callId } })
  await flush()
}

test('real store waits for ready, and follow failure does not inherit events health', async () => {
  openConversation('a')
  await flush()
  assert.equal(liveConnectionStore.getSnapshot(), 'connecting')
  assert.equal(getEventClientId(), undefined)
  events.push({ type: 'ready', clientId: 'client-fixture', host: { home: '/synthetic' } })
  sessions.get('a')!.push(snapshot('a', 1, [user(1, 'kept')]))
  await flush()
  sessions.get('a')!.fail('follow unavailable')
  await flush()
  assert.equal(liveConnectionStore.getSnapshot(), 'online')
  assert.equal(conversationStore.getSnapshot('a').phase, 'error')
  assert.match(conversationStore.getSnapshot('a').error!, /follow unavailable/)
  events.fail('events unavailable')
  await flush()
  assert.equal(liveConnectionStore.getSnapshot(), 'offline')
  assert.equal(getEventClientId(), undefined)
})

test('approval POST acceptance waits for host decided id; late success cannot undo the decision', async () => {
  await approval()
  const sent = respondApproval('call', 'allowed-once', 'a')
  assert.equal(approvalView('call', 'a').status, 'pending')
  assert.equal(await respondApproval('call', 'allowed-once', 'a'), false)
  assert.equal(posts.length, 1)
  sessions.get('a')!.push(record(11, 'approval/decided', { id: 'approval-a', outcome: 'allowed-once' }))
  await flush()
  assert.equal(approvalView('call', 'a').status, 'resolved')
  posts[0]!.response.resolve()
  await sent
  assert.equal(approvalView('call', 'a').status, 'resolved')
  assert.equal(hasApprovalWaterfall('call'), false)
})

test('HTTP success alone is accepted; failed submit keeps channel and retries', async () => {
  await approval()
  const first = respondApproval('call', 'allowed-once', 'a')
  posts[0]!.response.reject(new Error('fixture network loss'))
  assert.equal(await first, false)
  assert.equal(approvalView('call', 'a').canRetry, true)
  assert.equal(hasApprovalWaterfall('call'), true)
  const second = respondApproval('call', 'rejected', 'a')
  posts[1]!.response.resolve()
  assert.equal(await second, true)
  assert.equal(approvalView('call', 'a').status, 'accepted')
  assert.equal(approvalView('call', 'a').decision, undefined)
})

test('cancel publishes a new subscribed snapshot and beats a late failed POST', async () => {
  await approval()
  const sent = respondApproval('call', 'allowed-once', 'a')
  const before = conversationStore.getSnapshot('a')
  events.push({ type: 'cancel', eventId: 'event' })
  await flush()
  assert.notEqual(conversationStore.getSnapshot('a'), before)
  posts[0]!.response.reject(new Error('late failure'))
  await sent
  assert.equal(approvalView('call', 'a').canRetry, false)
  assert.match(approvalView('call', 'a').error!, /撤回/)
})

test('missing channel produces recoverable UI state; later waterfall enables submission', async () => {
  await open('a', [record(1, 'approval/asked', { id: 'approval-a', callId: 'call' })])
  assert.equal(await respondApproval('call', 'allowed-once', 'a'), false)
  assert.equal(approvalView('call', 'a').status, 'error')
  assert.equal(approvalView('call', 'a').canRetry, true)
  events.push({ type: 'waterfall', event: 'approval/request', eventId: 'event', agentId: 'a', request: { callId: 'call' } })
  await flush()
  const sent = respondApproval('call', 'allowed-once', 'a')
  assert.equal(posts.length, 1)
  posts[0]!.response.resolve()
  await sent
})

test('late response from another session/request cannot overwrite current approval', async () => {
  await approval('a', 'call', 'event-a')
  const first = respondApproval('call', 'allowed-once', 'a')
  await approval('b', 'call', 'event-b')
  const second = respondApproval('call', 'rejected', 'b')
  posts[0]!.response.resolve()
  await first
  assert.equal(approvalView('call', 'b').status, 'pending')
  assert.equal(approvalView('call', 'a').decision, undefined)
  posts[1]!.response.resolve()
  await second
  assert.equal(approvalView('call', 'b').status, 'accepted')
})

test('same callId in two sessions sends each decision to its own agent waterfall', async () => {
  await approval('a', 'same-call', 'event-a')
  await approval('b', 'same-call', 'event-b')
  const a = respondApproval('same-call', 'allowed-once', 'a')
  const b = respondApproval('same-call', 'rejected', 'b')
  assert.equal((posts[0]!.body as { eventId: string }).eventId, 'event-a')
  assert.equal((posts[1]!.body as { eventId: string }).eventId, 'event-b')
  posts[0]!.response.resolve()
  posts[1]!.response.resolve()
  await Promise.all([a, b])
})

test('a withdrawal before clicking stays non-retryable and sends no result', async () => {
  await approval()
  events.push({ type: 'cancel', eventId: 'event' })
  await flush()
  assert.equal(approvalView('call', 'a').canRetry, false)
  assert.match(approvalView('call', 'a').error!, /撤回/)
  assert.equal(posts.length, 0)
})

test('plan exit and preset selection override their opening projection baseline', async () => {
  await open('a', [], 10, false, { plan: { active: true }, agentPreset: 'before' })
  sessions.get('a')!.push(record(11, 'plan/mode', { active: false }))
  sessions.get('a')!.push(record(12, 'agent-preset/selected', { agentPreset: 'after' }))
  await flush()
  const state = conversationStore.getSnapshot('a')
  assert.equal(state.snapshot!.planMode, false)
  assert.equal(state.snapshot!.header!.agentPreset, 'after')
})

test('page is issued at fixed snapshot cut, rebuilds older history and preserves live tail and projections', async () => {
  await open('a', [user(10, 'recent')], 10, true, { todos: [{ content: 'baseline', status: 'pending' }], title: 'baseline title' })
  const loading = loadEarlierHistory('a')
  assert.deepEqual(pages[0]!.body, { address: { kind: 'session', sessionId: 'a' }, throughSeq: 10, beforeSeq: 10 })
  sessions.get('a')!.push(record(11, 'todo/write', { todos: [{ content: 'live', status: 'completed' }] }))
  sessions.get('a')!.push(user(12, 'live text'))
  await flush()
  pages[0]!.response.resolve({ result: { ok: true, value: { records: [user(1, 'old'), record(2, 'todo/write', { todos: [] })], hasMore: false } } })
  await loading
  const state = conversationStore.getSnapshot('a')
  assert.equal(state.historyIncomplete, false)
  assert.deepEqual(state.snapshot!.items.filter((item) => item.kind === 'user').map((item) => item.text), ['old', 'recent', 'live text'])
  assert.equal(state.snapshot!.header!.cwd, '/synthetic')
  assert.equal(state.snapshot!.title, 'baseline title')
  assert.deepEqual(state.snapshot!.todos, [{ content: 'live', status: 'completed' }])
})

test('obsolete page after replacement snapshot cannot discard new live events', async () => {
  await open('a', [user(10, 'A')], 10, true)
  const oldPage = loadEarlierHistory('a')
  sessions.get('a')!.push(snapshot('a', 20, [user(20, 'B')], true))
  sessions.get('a')!.push(user(21, 'B tail'))
  await flush()
  pages[0]!.response.resolve({ result: { ok: true, value: { records: [user(1, 'obsolete')], hasMore: false } } })
  await oldPage
  const state = conversationStore.getSnapshot('a')
  assert.equal(state.historyIncomplete, true)
  assert.deepEqual(state.snapshot!.items.filter((item) => item.kind === 'user').map((item) => item.text), ['B', 'B tail'])
  const newer = loadEarlierHistory('a')
  assert.deepEqual(pages[1]!.body, { address: { kind: 'session', sessionId: 'a' }, throughSeq: 20, beforeSeq: 20 })
  pages[1]!.response.reject(new Error('synthetic failure'))
  await newer
  assert.equal(conversationStore.getSnapshot('a').historyRetryable, true)
})

test('replacement copies stay out of human transcript and new turn clears evidence identity', async () => {
  await open('a', [user(1, 'original'), record(2, 'step/start', { turn: 1, step: 1 })], 2)
  assert.deepEqual(conversationStore.getSnapshot('a').currentStep, { turn: 1, step: 1 })
  sessions.get('a')!.push(record(3, 'user/message', { content: [{ type: 'text', text: 'model replacement' }] }, { surfaceOp: { op: 'replace', start: 1, end: 1 } }))
  await flush()
  assert.deepEqual(conversationStore.getSnapshot('a').currentStep, { turn: 1, step: 1 })
  sessions.get('a')!.push(record(4, 'turn/start', { turn: 2 }))
  await flush()
  assert.equal(conversationStore.getSnapshot('a').snapshot!.items.length, 1)
  assert.equal(conversationStore.getSnapshot('a').currentStep, undefined)
})
