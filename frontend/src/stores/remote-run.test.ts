import assert from 'node:assert/strict'
import test from 'node:test'
import { fleetArtifactDownloadUrl, resolveFleetOrigin } from '../lib/fleet-origin.ts'
import { createFleetLive, deriveFleetProgress, type FleetFetch } from './fleet-live.ts'
import type { RemoteTraceSource } from './remote-trace-source.ts'
import {
  FLEET_RUN_STATUSES,
  isTerminalFleetStatus,
  outcomeOfFleetStatus,
  parseFleetArtifacts,
  parseFleetRun,
  parseFleetTracePage,
} from './remote-run-model.ts'

const run = (status: string, overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  runId: 'r-1',
  index: 1,
  host: 'leo-03',
  item: '#1',
  prompt: 'test',
  status,
  startedAt: null,
  endedAt: null,
  ms: null,
  error: null,
  runDir: null,
  hasTrace: null,
  traceLines: null,
  artifactCount: null,
  itemTruncated: false,
  ...overrides,
})

const batchResponse = (status: string): Record<string, unknown> => ({
  at: 10,
  batches: [{
    batchId: 'b-1',
    label: 'batch',
    createdAt: 1,
    origin: 'ui',
    status: ['completed', 'failed', 'cancelled'].includes(status) ? status : 'running',
    counts: {
      total: 1,
      completed: status === 'completed' ? 1 : 0,
      failed: ['failed', 'interrupted', 'lost'].includes(status) ? 1 : 0,
      cancelled: status === 'cancelled' ? 1 : 0,
      active: ['queued', 'waking', 'running', 'detached'].includes(status) ? 1 : 0,
    },
    runs: [run(status)],
  }],
})

const powerNode = (): Record<string, unknown> => ({
  host: 'leo-03',
  node: 'leo-03',
  reachability: 'reachable',
  reachabilityAt: 4,
  reachabilityError: null,
  reachable: true,
  wakeState: 'awake',
  wakeStartedAt: 0,
  wakeDeadlineAt: 0,
  etaMs: 0,
  wakeError: null,
  smokeState: 'unknown',
  smokeAt: 0,
  smokeError: null,
  sleepState: 'awake',
  sleepError: null,
  wokenByBatchId: null,
  idleSleepEligible: false,
  guarded: false,
})

const hostResponse = (): Record<string, unknown> => ({
  hosts: [{
    name: 'leo-03',
    kind: 'remote',
    model: 'deepseek-v4-flash',
    tags: ['tool-heavy'],
    maxConcurrency: 6,
    enabled: true,
    ok: true,
    at: 4,
    version: '0.1.0',
    inflight: 0,
    currentTask: null,
    runs: [],
  }],
})

const json = (value: unknown, status = 200): Response => new Response(JSON.stringify(value), {
  status,
  headers: { 'content-type': 'application/json' },
})

const settle = async (): Promise<void> => {
  await new Promise<void>((resolve) => setImmediate(resolve))
}

class FakeTimers {
  readonly microtasks: (() => void)[] = []
  readonly timers = new Map<number, { callback: () => void, delay: number }>()
  #next = 1

  queueMicrotask = (callback: () => void): void => { this.microtasks.push(callback) }
  setTimeout = (callback: () => void, delay: number): ReturnType<typeof setTimeout> => {
    const id = this.#next++
    this.timers.set(id, { callback, delay })
    return id as unknown as ReturnType<typeof setTimeout>
  }
  clearTimeout = (handle: ReturnType<typeof setTimeout>): void => {
    this.timers.delete(handle as unknown as number)
  }
  flushMicrotasks(): void {
    while (this.microtasks.length > 0) this.microtasks.shift()?.()
  }
  takeDelay(delay: number): (() => void) | undefined {
    const match = [...this.timers.entries()].find(([, timer]) => timer.delay === delay)
    if (match === undefined) return undefined
    this.timers.delete(match[0])
    return match[1].callback
  }
}

test('all nine durable run states survive parsing and only five are terminal', () => {
  const terminal = new Set(['completed', 'failed', 'cancelled', 'interrupted', 'lost'])
  for (const status of FLEET_RUN_STATUSES) {
    assert.equal(parseFleetRun(run(status)).status, status)
    assert.equal(outcomeOfFleetStatus(status), status)
    assert.equal(isTerminalFleetStatus(status), terminal.has(status))
  }
  assert.equal(isTerminalFleetStatus('detached'), false)
})

test('artifact and trace parsers reject malformed success payloads', () => {
  assert.throws(() => parseFleetTracePage({
    host: 'h', runId: 'r', file: null, from: 1, nextFrom: 1, total: 0,
    truncated: false, lines: ['one line'], runs: [],
  }), /offsets are inconsistent/)
  assert.throws(() => parseFleetArtifacts({
    host: 'h', runId: 'r', runDir: '/run', files: [{ path: 'x', size: -1, mtime: 1, binary: false }],
    totalBytes: 0, count: 1, truncated: false, excluded: [],
  }), /non-negative integer/)
})

test('fleet artifact origin is direct in dev and same-origin in production', () => {
  assert.equal(resolveFleetOrigin({ dev: true }), 'http://127.0.0.1:3091')
  assert.equal(resolveFleetOrigin({ dev: false }), '')
  assert.equal(
    fleetArtifactDownloadUrl('file', 'leo-03', 'r-1', 'reports/a b.md', { dev: true }),
    'http://127.0.0.1:3091/fleet/artifact/file?host=leo-03&run=r-1&path=reports%2Fa+b.md',
  )
  assert.equal(fleetArtifactDownloadUrl('tgz', 'h', 'r', undefined, { dev: false }), '/fleet/artifact/tgz?host=h&run=r')
  assert.throws(() => fleetArtifactDownloadUrl('file', 'h', 'r', undefined, { dev: false }), /require a path/)
})

test('hosts and batches polling are ref-counted, StrictMode-safe, and use 60s/3s/15s cadence', async () => {
  const timers = new FakeTimers()
  let batchStatus = 'running'
  const calls: string[] = []
  const fetchImpl: FleetFetch = async (url) => {
    calls.push(url)
    if (url.startsWith('/api/fleet/hosts')) return json(hostResponse())
    if (url === '/api/fleet/power') return json({ at: 5, nodes: [powerNode()] })
    if (url.startsWith('/api/fleet/batches')) return json(batchResponse(batchStatus))
    throw new Error(`unexpected ${url}`)
  }
  const fleet = createFleetLive({
    fetchImpl,
    queueMicrotaskFn: timers.queueMicrotask,
    setTimeoutFn: timers.setTimeout,
    clearTimeoutFn: timers.clearTimeout,
    isHidden: () => false,
    onVisibilityChange: () => () => {},
  })

  const strictProbe = fleet.fleetHostsStore.subscribe(() => {})
  strictProbe()
  timers.flushMicrotasks()
  await settle()
  assert.equal(calls.length, 0, 'disposed StrictMode probe must not fetch')

  const stopHosts = fleet.fleetHostsStore.subscribe(() => {})
  const stopBatches = fleet.fleetBatchesStore.subscribe(() => {})
  timers.flushMicrotasks()
  await settle()
  assert.equal(fleet.fleetHostsStore.getSnapshot().phase, 'ready')
  assert.equal(fleet.fleetBatchesStore.getSnapshot().phase, 'ready')
  assert.ok(timers.takeDelay(60_000), 'hosts use a 60 second cadence')
  const runningTick = timers.takeDelay(3_000)
  assert.ok(runningTick, 'running batches use a 3 second cadence')

  batchStatus = 'completed'
  runningTick?.()
  await settle()
  assert.ok(timers.takeDelay(15_000), 'settled batches use a 15 second cadence')
  stopHosts()
  stopBatches()
  fleet.dispose()
})

test('failed polls retain old data, back off, and final unsubscribe aborts inflight work', async () => {
  const timers = new FakeTimers()
  let batchesCalls = 0
  let pendingSignal: AbortSignal | undefined
  let mode: 'success' | 'failure' | 'pending' = 'success'
  const fetchImpl: FleetFetch = async (url, init) => {
    if (!url.startsWith('/api/fleet/batches')) throw new Error(`unexpected ${url}`)
    batchesCalls += 1
    if (mode === 'success') return json(batchResponse('running'))
    if (mode === 'failure') return json({ error: 'offline', code: 'UPSTREAM' }, 502)
    pendingSignal = init?.signal ?? undefined
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
    })
  }
  const fleet = createFleetLive({
    fetchImpl,
    queueMicrotaskFn: timers.queueMicrotask,
    setTimeoutFn: timers.setTimeout,
    clearTimeoutFn: timers.clearTimeout,
    isHidden: () => false,
    onVisibilityChange: () => () => {},
  })
  const stop = fleet.fleetBatchesStore.subscribe(() => {})
  timers.flushMicrotasks()
  await settle()
  assert.equal(fleet.fleetBatchesStore.getSnapshot().batches.length, 1)

  mode = 'failure'
  fleet.fleetBatchesStore.refresh()
  await settle()
  assert.equal(fleet.fleetBatchesStore.getSnapshot().phase, 'degraded')
  assert.equal(fleet.fleetBatchesStore.getSnapshot().batches.length, 1, '502 must retain the old batch snapshot')
  assert.ok(timers.takeDelay(1_000), 'first failure backs off for one second')

  mode = 'pending'
  fleet.fleetBatchesStore.refresh()
  await settle()
  assert.equal(batchesCalls >= 3, true)
  stop()
  assert.equal(pendingSignal?.aborted, true)
  fleet.dispose()
})

test('fleet actions use the frozen JSON routes and reject malformed success bodies', async () => {
  const requests: { url: string, init?: RequestInit }[] = []
  const wake = {
    requested: ['leo-03'], alreadyUp: [], noWakePath: [], budgetMs: { 'leo-03': 120_000 },
  }
  const fetchImpl: FleetFetch = async (url, init) => {
    requests.push({ url, init })
    if (url === '/api/fleet/dispatch') return json({
      batchId: 'b-1', label: 'work', createdAt: 1, origin: 'ui', wake,
      runs: [{ index: 1, runId: 'r-1', host: 'leo-03', status: 'waking', item: '#1' }],
    }, 202)
    if (url === '/api/fleet/cancel') return json({ cancelled: ['r-1'], skipped: [] })
    if (url === '/api/fleet/wake') return json({ ...wake, states: [powerNode()] }, 202)
    if (url === '/api/fleet/preflight') return json({
      at: 3,
      hosts: [{
        host: 'leo-03', reachable: true,
        probe: { ok: true, at: 2, version: '0.1.0' },
        smoke: { ok: true, cached: false, code: null, error: null },
      }],
    })
    if (url.startsWith('/api/fleet/artifacts')) return json({
      host: 'leo-03', runId: 'r-1', runDir: '/work/r-1',
      files: [{ path: 'report.md', size: 5, mtime: 2, binary: false }],
      totalBytes: 5, count: 1, truncated: false, excluded: ['pid', 'exit', '.trace/**'],
    })
    if (url === '/api/fleet/power') return json({ at: 2, nodes: [powerNode()] })
    if (url === '/api/fleet/sleep') return json({ ok: true, host: 'leo-03', node: 'leo-03', ledgerPersisted: true })
    if (url.startsWith('/api/fleet/batch?')) return json({
      batchId: 'b-1', label: 'work', createdAt: 1, origin: 'ui', status: 'running',
      counts: { total: 1, completed: 0, failed: 0, cancelled: 0, active: 1 },
      runs: [{ ...run('running'), item: 'full task', resultText: '' }],
    })
    if (url.startsWith('/api/fleet/batches')) return json({ at: 2, batches: [] })
    if (url.startsWith('/api/fleet/hosts')) return json(hostResponse())
    throw new Error(`unexpected ${url}`)
  }
  const fleet = createFleetLive({ fetchImpl, onVisibilityChange: () => () => {}, isHidden: () => false })
  const dispatched = await fleet.dispatchFleet({ items: ['work'], hosts: ['leo-03'], wake: true })
  assert.equal(dispatched.runs[0]?.status, 'waking')
  assert.deepEqual(await fleet.cancelFleetRun({ runId: 'r-1', host: 'leo-03' }), { cancelled: ['r-1'], skipped: [] })
  assert.equal((await fleet.wakeFleetHosts(['leo-03'])).states[0]?.guarded, false)
  assert.equal((await fleet.preflightFleetHosts(['leo-03'])).hosts[0]?.smoke.ok, true)
  assert.equal((await fleet.fetchFleetArtifacts('leo-03', 'r-1')).files[0]?.path, 'report.md')
  assert.equal((await fleet.fetchFleetPower()).nodes[0]?.reachable, true)
  assert.equal((await fleet.sleepFleetHost('leo-03')).ledgerPersisted, true)
  assert.equal((await fleet.fetchFleetBatch('b-1')).runs?.[0]?.item, 'full task')
  await settle()

  const posts = requests.filter((request) => request.init?.method === 'POST')
  assert.equal(posts.length, 5)
  for (const request of posts) {
    assert.equal((request.init?.headers as Record<string, string>)['content-type'], 'application/json')
  }
  assert.deepEqual(JSON.parse(String(posts.find((request) => request.url === '/api/fleet/wake')?.init?.body)), { hosts: ['leo-03'] })
  assert.deepEqual(JSON.parse(String(posts.find((request) => request.url === '/api/fleet/preflight')?.init?.body)), { hosts: ['leo-03'] })
  assert.deepEqual(JSON.parse(String(posts.find((request) => request.url === '/api/fleet/sleep')?.init?.body)), { host: 'leo-03', confirm: 'SLEEP' })

  const malformed = createFleetLive({
    fetchImpl: async () => json({ requested: [], alreadyUp: [], noWakePath: [], budgetMs: {} }, 202),
    onVisibilityChange: () => () => {}, isHidden: () => false,
  })
  await assert.rejects(() => malformed.wakeFleetHosts(['leo-03']), /states must be an array/)
  malformed.dispose()
  const malformedPreflight = createFleetLive({
    fetchImpl: async () => json({ at: 1, hosts: [{ host: 'leo-03', reachable: true, probe: { ok: true } }] }),
    onVisibilityChange: () => () => {}, isHidden: () => false,
  })
  await assert.rejects(() => malformedPreflight.preflightFleetHosts(['leo-03']), /smoke must be an object/)
  malformedPreflight.dispose()
  fleet.dispose()
})

test('remote 502 keeps the last good fold and resumes with exponential retry', async () => {
  const timers = new FakeTimers()
  let failTrace = false
  const fetchImpl: FleetFetch = async (url) => {
    if (url.startsWith('/api/fleet/batches')) return json(batchResponse('running'))
    if (url.startsWith('/api/fleet/trace')) {
      if (failTrace) return json({ error: 'ssh unavailable' }, 502)
      return json({
        host: 'leo-03', runId: 'r-1', file: 'f', from: 1, nextFrom: 2, total: 2, truncated: false,
        lines: [JSON.stringify({ type: 'session', version: 0, id: 'kept' })], runs: [],
      })
    }
    throw new Error(`unexpected ${url}`)
  }
  const fleet = createFleetLive({
    fetchImpl,
    queueMicrotaskFn: timers.queueMicrotask,
    setTimeoutFn: timers.setTimeout,
    clearTimeoutFn: timers.clearTimeout,
    isHidden: () => false,
    onVisibilityChange: () => () => {},
  })
  const key = fleet.remoteRunKey('leo-03', 'r-1')
  fleet.openRemoteRun('leo-03', 'r-1')
  timers.flushMicrotasks()
  await settle()
  const tick = timers.takeDelay(1_500)
  assert.equal(fleet.remoteRunStore.getSnapshot(key).snapshot?.header?.sessionId, 'kept')
  failTrace = true
  tick?.()
  await settle()
  const degraded = fleet.remoteRunStore.getSnapshot(key)
  assert.equal(degraded.phase, 'error')
  assert.equal(degraded.snapshot?.header?.sessionId, 'kept')
  assert.ok(timers.takeDelay(1_000), 'remote errors use exponential retry')
  fleet.closeRemoteRun('leo-03', 'r-1')
  fleet.dispose()
})

test('remote store consumes a replaceable event source without knowing its cursor shape', async () => {
  const timers = new FakeTimers()
  let starts = 0
  let stops = 0
  const source: RemoteTraceSource = {
    async start(onEvents) {
      starts += 1
      onEvents({ reset: false, events: [{ kind: 'event', value: { type: 'session', version: 0, id: 'stream-session' } }] })
      return { cursor: { source: 'test-stream', token: { offset: 'opaque' } }, caughtUp: false }
    },
    stop() { stops += 1 },
  }
  const fetched: string[] = []
  const fleet = createFleetLive({
    fetchImpl: async (url) => {
      fetched.push(url)
      if (url.startsWith('/api/fleet/batches')) return json({ at: 1, batches: [] })
      throw new Error(`unexpected ${url}`)
    },
    traceSourceFactory: () => source,
    queueMicrotaskFn: timers.queueMicrotask,
    setTimeoutFn: timers.setTimeout,
    clearTimeoutFn: timers.clearTimeout,
    isHidden: () => false,
    onVisibilityChange: () => () => {},
  })
  const key = fleet.remoteRunKey('stream-host', 'stream-run')
  fleet.openRemoteRun('stream-host', 'stream-run')
  timers.flushMicrotasks()
  await settle()
  assert.equal(starts, 1)
  assert.equal(fleet.remoteRunStore.getSnapshot(key).snapshot?.header?.sessionId, 'stream-session')
  assert.equal(fetched.some((url) => url.startsWith('/api/fleet/trace')), false)
  fleet.closeRemoteRun('stream-host', 'stream-run')
  assert.equal(stops >= 1, true)
  fleet.dispose()
})

test('an atomic reset batch keeps the replacement session events', async () => {
  const timers = new FakeTimers()
  let starts = 0
  const source: RemoteTraceSource = {
    async start(onEvents) {
      starts += 1
      onEvents({
        reset: true,
        events: [{ kind: 'event', value: { type: 'session', version: 0, id: 'replacement-session' } }],
      })
      return { cursor: { source: 'test-stream', token: starts }, caughtUp: false }
    },
    stop() {},
  }
  const fleet = createFleetLive({
    fetchImpl: async (url) => {
      if (url.startsWith('/api/fleet/batches')) return json({ at: 1, batches: [] })
      throw new Error(`unexpected ${url}`)
    },
    traceSourceFactory: () => source,
    queueMicrotaskFn: timers.queueMicrotask,
    setTimeoutFn: timers.setTimeout,
    clearTimeoutFn: timers.clearTimeout,
    isHidden: () => false,
    onVisibilityChange: () => () => {},
  })
  const key = fleet.remoteRunKey('stream-host', 'stream-run')
  fleet.openRemoteRun('stream-host', 'stream-run')
  timers.flushMicrotasks()
  await settle()
  const state = fleet.remoteRunStore.getSnapshot(key)
  assert.equal(state.phase, 'live')
  assert.equal(state.snapshot?.header?.sessionId, 'replacement-session')
  fleet.closeRemoteRun('stream-host', 'stream-run')
  fleet.dispose()
})

test('a terminal ledger row still fetches trace once before declaring the run ended', async () => {
  const timers = new FakeTimers()
  let traceCalls = 0
  const fleet = createFleetLive({
    fetchImpl: async (url) => {
      if (url.startsWith('/api/fleet/batches')) return json(batchResponse('completed'))
      if (url.startsWith('/api/fleet/trace')) {
        traceCalls += 1
        const from = Number(new URL(url, 'http://local').searchParams.get('from'))
        return from === 1
          ? json({
            host: 'leo-03', runId: 'r-1', file: 'f', from: 1, nextFrom: 2, total: 1, truncated: false,
            lines: [JSON.stringify({ type: 'session', version: 0, id: 'terminal-trace' })], runs: [],
          })
          : json({ host: 'leo-03', runId: 'r-1', file: 'f', from, nextFrom: from, total: 1, truncated: false, lines: [], runs: [] })
      }
      throw new Error(`unexpected ${url}`)
    },
    queueMicrotaskFn: timers.queueMicrotask,
    setTimeoutFn: timers.setTimeout,
    clearTimeoutFn: timers.clearTimeout,
    isHidden: () => false,
    onVisibilityChange: () => () => {},
  })
  const key = fleet.remoteRunKey('leo-03', 'r-1')
  fleet.openRemoteRun('leo-03', 'r-1')
  timers.flushMicrotasks()
  await settle()
  // If the terminal batch response races the first trace request, its epoch
  // deliberately schedules one post-observation revalidation.
  timers.flushMicrotasks()
  await settle()
  assert.equal(traceCalls >= 1, true)
  assert.equal(fleet.remoteRunStore.getSnapshot(key).snapshot?.header?.sessionId, 'terminal-trace')
  assert.equal(fleet.remoteRunStore.getSnapshot(key).phase, 'ended')
  fleet.closeRemoteRun('leo-03', 'r-1')
  fleet.dispose()
})

test('remote polling keeps detached runs live, polls hidden at 10s, and ends only after terminal catch-up', async () => {
  const timers = new FakeTimers()
  let hidden = false
  let status = 'detached'
  let traceCalls = 0
  const fetchImpl: FleetFetch = async (url) => {
    if (url.startsWith('/api/fleet/batches')) return json(batchResponse(status))
    if (url.startsWith('/api/fleet/trace')) {
      traceCalls += 1
      const parsed = new URL(url, 'http://local')
      const from = Number(parsed.searchParams.get('from'))
      if (from === 1) {
        return json({
          host: 'leo-03', runId: 'r-1', file: 'f', from: 1, nextFrom: 2, total: 2, truncated: false,
          lines: [JSON.stringify({ type: 'session', version: 0, id: 's' })], runs: [],
        })
      }
      return from === 2
        ? json({
          host: 'leo-03', runId: 'r-1', file: 'f', from: 2, nextFrom: 3, total: 2, truncated: false,
          lines: [JSON.stringify({ type: 'turn/start', data: { turn: 1 } })], runs: [],
        })
        : json({ host: 'leo-03', runId: 'r-1', file: 'f', from, nextFrom: from, total: 2, truncated: false, lines: [], runs: [] })
    }
    throw new Error(`unexpected ${url}`)
  }
  const fleet = createFleetLive({
    fetchImpl,
    queueMicrotaskFn: timers.queueMicrotask,
    setTimeoutFn: timers.setTimeout,
    clearTimeoutFn: timers.clearTimeout,
    isHidden: () => hidden,
    onVisibilityChange: () => () => {},
  })
  const key = fleet.remoteRunKey('leo-03', 'r-1')
  fleet.openRemoteRun('leo-03', 'r-1')
  timers.flushMicrotasks()
  await settle()
  assert.equal(fleet.remoteRunStore.getSnapshot(key).outcome, 'detached')
  assert.equal(fleet.remoteRunStore.getSnapshot(key).phase, 'live')
  const detachedTick = timers.takeDelay(1_500)
  assert.ok(detachedTick, 'detached continues polling')
  hidden = true
  detachedTick?.()
  await settle()
  assert.ok(timers.takeDelay(10_000), 'hidden remote trace polling slows to ten seconds')

  hidden = false
  status = 'completed'
  fleet.fleetBatchesStore.refresh()
  await settle()
  timers.flushMicrotasks()
  await settle()
  const final = fleet.remoteRunStore.getSnapshot(key)
  assert.equal(final.outcome, 'completed')
  assert.equal(final.phase, 'ended')
  assert.equal(traceCalls >= 2, true)
  fleet.closeRemoteRun('leo-03', 'r-1')
  fleet.dispose()
})

test('running catch-up revalidates the terminal epoch and consumes a newly appended final line', async () => {
  const timers = new FakeTimers()
  let status = 'running'
  let finalTailExists = false
  let traceCalls = 0
  const fleet = createFleetLive({
    fetchImpl: async (url) => {
      if (url.startsWith('/api/fleet/batches')) return json(batchResponse(status))
      if (url.startsWith('/api/fleet/trace')) {
        traceCalls += 1
        const from = Number(new URL(url, 'http://local').searchParams.get('from'))
        if (from === 1) return json({
          host: 'leo-03', runId: 'r-1', file: 'f', from: 1, nextFrom: 2, total: 1, truncated: false,
          lines: [JSON.stringify({ type: 'session', version: 0, id: 's' })], runs: [],
        })
        return json({
          host: 'leo-03', runId: 'r-1', file: 'f', from: 2,
          nextFrom: finalTailExists ? 3 : 2,
          total: finalTailExists ? 2 : 1,
          truncated: false,
          lines: finalTailExists ? [JSON.stringify({ type: 'turn/start', data: { turn: 7 } })] : [],
          runs: [],
        })
      }
      throw new Error(`unexpected ${url}`)
    },
    queueMicrotaskFn: timers.queueMicrotask,
    setTimeoutFn: timers.setTimeout,
    clearTimeoutFn: timers.clearTimeout,
    isHidden: () => false,
    onVisibilityChange: () => () => {},
  })
  const key = fleet.remoteRunKey('leo-03', 'r-1')
  fleet.openRemoteRun('leo-03', 'r-1')
  timers.flushMicrotasks()
  await settle()
  assert.equal(fleet.remoteRunStore.getSnapshot(key).snapshot?.header?.sessionId, 's')
  assert.equal(fleet.remoteRunStore.getSnapshot(key).phase, 'live')

  // This line appears after the cached running snapshot was already caught up,
  // immediately before the durable batch status turns terminal.
  finalTailExists = true
  status = 'completed'
  fleet.fleetBatchesStore.refresh()
  await settle()
  assert.notEqual(fleet.remoteRunStore.getSnapshot(key).phase, 'ended', 'cached catch-up cannot settle a new terminal epoch')
  timers.flushMicrotasks()
  await settle()

  const ended = fleet.remoteRunStore.getSnapshot(key)
  assert.equal(ended.phase, 'ended')
  assert.equal(ended.outcome, 'completed')
  assert.equal(ended.snapshot?.turnsStarted, 1)
  assert.equal(traceCalls >= 2, true)
  fleet.closeRemoteRun('leo-03', 'r-1')
  fleet.dispose()
})

test('last close releases every retained fold and repeated opens remain bounded', async () => {
  const timers = new FakeTimers()
  const fleet = createFleetLive({
    fetchImpl: async (url) => {
      if (url.startsWith('/api/fleet/batches')) return json({ at: 1, batches: [] })
      if (url.startsWith('/api/fleet/trace')) {
        const runId = new URL(url, 'http://local').searchParams.get('run') as string
        return json({
          host: 'leo-03', runId, file: 'f', from: 1, nextFrom: 2, total: 1, truncated: false,
          lines: [JSON.stringify({ type: 'session', version: 0, id: runId })], runs: [],
        })
      }
      throw new Error(`unexpected ${url}`)
    },
    queueMicrotaskFn: timers.queueMicrotask,
    setTimeoutFn: timers.setTimeout,
    clearTimeoutFn: timers.clearTimeout,
    isHidden: () => false,
    onVisibilityChange: () => () => {},
  })
  const stableIdle = fleet.remoteRunStore.getSnapshot(undefined)
  const closedKeys: string[] = []
  for (let index = 0; index < 50; index += 1) {
    const runId = `r-${index}`
    const key = fleet.remoteRunKey('leo-03', runId)
    fleet.openRemoteRun('leo-03', runId)
    timers.flushMicrotasks()
    await settle()
    assert.equal(fleet.remoteRunStore.getSnapshot(key).snapshot?.header?.sessionId, runId)
    fleet.closeRemoteRun('leo-03', runId)
    closedKeys.push(key)
  }
  for (const key of closedKeys) assert.strictEqual(fleet.remoteRunStore.getSnapshot(key), stableIdle)

  // Reopening a released key reconstructs from physical line one.
  fleet.openRemoteRun('leo-03', 'r-0')
  timers.flushMicrotasks()
  await settle()
  assert.equal(fleet.remoteRunStore.getSnapshot(closedKeys[0]).snapshot?.header?.sessionId, 'r-0')
  fleet.closeRemoteRun('leo-03', 'r-0')
  fleet.dispose()
})

test('opening a new run aborts the prior request and drops its late generation', async () => {
  const timers = new FakeTimers()
  const signals: AbortSignal[] = []
  let resolveFirst: ((response: Response) => void) | undefined
  const fetchImpl: FleetFetch = async (url, init) => {
    if (url.startsWith('/api/fleet/batches')) return json({ at: 1, batches: [] })
    if (url.startsWith('/api/fleet/trace')) {
      signals.push(init?.signal as AbortSignal)
      if (signals.length === 1) return new Promise<Response>((resolve) => { resolveFirst = resolve })
      const parsed = new URL(url, 'http://local')
      const runId = parsed.searchParams.get('run') as string
      return json({ host: 'leo-03', runId, file: 'f', from: 1, nextFrom: 2, total: 1, truncated: false,
        lines: [JSON.stringify({ type: 'session', version: 0, id: runId })], runs: [] })
    }
    throw new Error(`unexpected ${url}`)
  }
  const fleet = createFleetLive({
    fetchImpl,
    queueMicrotaskFn: timers.queueMicrotask,
    setTimeoutFn: timers.setTimeout,
    clearTimeoutFn: timers.clearTimeout,
    isHidden: () => false,
    onVisibilityChange: () => () => {},
  })
  fleet.openRemoteRun('leo-03', 'r-old')
  timers.flushMicrotasks()
  await settle()
  fleet.openRemoteRun('leo-03', 'r-new')
  timers.flushMicrotasks()
  await settle()
  assert.equal(signals[0]?.aborted, true)
  assert.equal(fleet.remoteRunStore.getSnapshot(fleet.remoteRunKey('leo-03', 'r-new')).snapshot?.header?.sessionId, 'r-new')

  resolveFirst?.(json({
    host: 'leo-03', runId: 'r-old', file: 'f', from: 1, nextFrom: 2, total: 1, truncated: false,
    lines: [JSON.stringify({ type: 'session', version: 0, id: 'late-old' })], runs: [],
  }))
  await settle()
  assert.equal(fleet.remoteRunStore.getSnapshot(fleet.remoteRunKey('leo-03', 'r-old')).snapshot, undefined)
  fleet.dispose()
})

test('fleet progress includes only running batches and never invents totals', () => {
  const state = {
    phase: 'ready' as const,
    at: 1,
    attempt: 0,
    batches: [
      (batchResponse('running').batches as Record<string, unknown>[])[0] as never,
    ],
  }
  const parsed = deriveFleetProgress({ ...state, batches: [
    {
      batchId: 'b', label: 'live', createdAt: 1, origin: 'ui', status: 'running',
      counts: { total: 3, completed: 1, failed: 1, cancelled: 0, active: 1 }, runs: [],
    },
    {
      batchId: 'done', label: 'done', createdAt: 1, origin: 'ui', status: 'completed',
      counts: { total: 1, completed: 1, failed: 0, cancelled: 0, active: 0 }, runs: [],
    },
  ] })
  assert.deepEqual(parsed, {
    batches: [{ callId: 'b', label: 'live', done: 1, failed: 1, total: 3 }],
    done: 1,
    total: 3,
  })
})

test('parseFleetHostsResponse 对 2026-08-23 现网载荷(含 kind:codex)不再 throw:原样放行,消费者自己按 remote 筛', async () => {
  const { parseFleetHostsResponse } = await import('./remote-run-model.ts')
  // 夹具 = 2026-08-23 22:00 3091 的真实 /api/fleet/hosts 载荷(trace 字段略),不是手写的理想行;IP 已换成 192.0.2.0/24 文档段,形状不变
  const payload = {"hosts": [{"name": "local", "kind": "local", "model": "deepseek-v4-flash", "tags": ["general"], "maxConcurrency": 3, "enabled": true, "ok": true, "at": 1787493847022, "inflight": 0, "currentTask": null, "runs": [], "version": "in-process"}, {"name": "codex", "kind": "codex", "model": "", "tags": ["codex"], "maxConcurrency": 1, "enabled": true, "ok": false, "at": 1787493847031, "inflight": 0, "currentTask": null, "runs": [], "error": "Cannot find package '@openai/codex-sdk' imported from /Users/leo/.dsh/profiles/web/plugins/dsh-fleet/lib/fleet-codex.mjs"}, {"name": "agent-m4", "kind": "remote", "model": "deepseek-v4-flash", "tags": ["general", "tool-heavy", "mac"], "maxConcurrency": 4, "enabled": true, "ok": false, "at": 1787493855034, "inflight": 0, "currentTask": null, "runs": [], "error": "ssh: connect to host 192.0.2.11 port 22: Operation timed out"}, {"name": "leo-01", "kind": "remote", "model": "deepseek-v4-flash", "tags": ["general", "tool-heavy", "linux", "writable"], "maxConcurrency": 6, "enabled": true, "ok": false, "at": 1787493855034, "inflight": 0, "currentTask": null, "runs": [], "error": "ssh: connect to host 192.0.2.12 port 22: Operation timed out"}, {"name": "leo-02", "kind": "remote", "model": "deepseek-v4-flash", "tags": ["general", "tool-heavy", "linux", "writable"], "maxConcurrency": 6, "enabled": true, "ok": false, "at": 1787493855034, "inflight": 0, "currentTask": null, "runs": [], "error": "ssh: connect to host 192.0.2.13 port 22: Operation timed out"}, {"name": "leo-03", "kind": "remote", "model": "deepseek-v4-flash", "tags": ["general", "tool-heavy", "linux", "writable"], "maxConcurrency": 6, "enabled": true, "ok": false, "at": 1787493855039, "inflight": 0, "currentTask": null, "runs": [], "error": "ssh: connect to host 192.0.2.14 port 22: Operation timed out"}, {"name": "knowledge-m4", "kind": "remote", "model": "deepseek-v4-flash", "tags": ["general", "tool-heavy", "mac", "writable", "knowledge"], "maxConcurrency": 2, "enabled": true, "ok": true, "at": 1787493851755, "inflight": 0, "currentTask": null, "runs": [{"runId": "r-62937669-0dfd-4c0b-9b70-9d15e80172cd", "batchId": "b-f785f00d-8463-4369-9a02-4bf6dc7e3024", "index": 1, "host": "knowledge-m4", "kind": "", "runDir": "~/dsh-workspace/tasks/r-62937669-0dfd-4c0b-9b70-9d15e80172cd", "model": "deepseek-v4-flash", "origin": "ui", "label": "W1-d 地基冒烟", "pinned": true, "tag": "", "wake": false, "item": "只回复两个字:收到。不要调用任何工具。", "itemTruncated": false, "prompt": "只回复两个字:收到。不要调用任何工具。", "status": "completed", "createdAt": 1787299684152, "startedAt": 1787299684170, "endedAt": 1787299689220, "timeoutMs": 180000, "resultText": "收到。", "exit": 0, "ms": 5041, "reattached": false, "cancelPending": false, "timeoutPending": false, "recoveryCandidate": false}], "version": "0.1.0-rc.8"}]}
  const hosts = parseFleetHostsResponse(payload)
  assert.ok(hosts.some((h) => h.kind === 'codex'), 'codex 行原样在列表里,不编造也不丢')
  assert.ok(hosts.some((h) => h.kind === 'remote'))
  assert.throws(() => parseFleetHostsResponse({ hosts: [{ ...payload.hosts[0], kind: '' }] }), /kind/, '空种类仍然拒')
})
