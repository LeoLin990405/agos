import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import {
  createFleetDispatchHandlers,
  registerFleetDispatchRoutes,
} from '../lib/fleet-dispatch.mjs'
import { createFleetRuntime } from '../lib/fleet-runtime.mjs'

const REMOTES = [
  { name: 'up-a', kind: 'remote', tags: ['general', 'linux'], enabled: true },
  { name: 'up-b', kind: 'remote', tags: ['general', 'mac'], enabled: true },
  { name: 'down-c', kind: 'remote', tags: ['general', 'linux'], enabled: true },
  { name: 'local', kind: 'local', tags: ['general'], enabled: true },
]

function fakeRuntime(overrides = {}) {
  const calls = []
  const batches = new Map()
  return {
    calls,
    maxConcurrency: 8,
    activeCount: () => 0,
    async createBatch(batch) {
      calls.push(['create', batch.batchId])
      const copy = structuredClone(batch)
      batches.set(batch.batchId, copy)
      return copy
    },
    async startBatch(batchId, options) { calls.push(['start', batchId, options.hosts.map((host) => host.name)]) },
    async listBatches() { return [...batches.values()] },
    async getBatch(id) { return batches.get(id) },
    async getRun(id) { return [...batches.values()].flatMap((batch) => batch.runs || []).find((run) => run.runId === id) },
    async markQueued(id, patch = {}) {
      const run = await this.getRun(id); if (!run) throw new Error('missing run')
      Object.assign(run, patch, { status: 'queued' }); return structuredClone(run)
    },
    async markEnd(id, outcome = {}) {
      const run = await this.getRun(id); if (!run) throw new Error('missing run')
      Object.assign(run, outcome, { status: outcome.ok === true ? 'completed' : 'failed' }); return structuredClone(run)
    },
    async rerouteRun(id, patch = {}) {
      const run = await this.getRun(id); if (!run) throw new Error('missing run')
      Object.assign(run, patch, { status: 'queued' }); return structuredClone(run)
    },
    async cancelBatch(batchId) { calls.push(['cancelBatch', batchId]); return { cancelled: ['r-1'], skipped: [] } },
    async cancelRun(runId, host) { calls.push(['cancelRun', runId, host]); return { cancelled: [runId], skipped: [] } },
    ...overrides,
  }
}

function fakeWake({ paths = ['down-c'], state = new Map(), result } = {}) {
  const calls = []
  return {
    calls,
    canWake(host) { return paths.includes(host) },
    state(host) { return state.get(host) },
    async request(hosts, context) {
      calls.push({ hosts, context })
      return result || { requested: hosts, alreadyUp: [], noWakePath: [], budgetMs: Object.fromEntries(hosts.map((host) => [host, 120000])) }
    },
  }
}

const probe = async (hosts) => new Map(hosts.map((host) => [host.name, { ok: host.name.startsWith('up-') }]))

function makeHarness(overrides = {}) {
  const deferred = []
  const runtime = overrides.runtime || fakeRuntime()
  const wake = overrides.wake || fakeWake()
  let sequence = 0
  const handlers = createFleetDispatchHandlers({
    runtime,
    hosts: overrides.hosts || (() => REMOTES),
    probe: overrides.probe || probe,
    wake,
    now: overrides.now || (() => 1755700000000),
    uuid: overrides.uuid || (() => `id-${++sequence}`),
    defer: overrides.defer || ((fn) => deferred.push(fn)),
    logger: overrides.logger || { warn() {} },
  })
  return { handlers, runtime, wake, deferred }
}

async function request(handler, { method = 'GET', url = '/', body, contentType = 'application/json' } = {}) {
  const chunks = body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]
  const req = Readable.from(chunks)
  req.method = method
  req.url = url
  req.headers = contentType === null ? {} : { 'content-type': contentType }
  const response = {
    status: null,
    headers: {},
    text: '',
    writeHead(status, headers = {}) { this.status = status; this.headers = headers },
    end(value = '') { this.text += String(value) },
  }
  await handler(req, response)
  return { status: response.status, headers: response.headers, body: JSON.parse(response.text) }
}

test('registers four exact routes, disposes them, and returns Allow on method mismatch', async () => {
  const routes = new Map()
  const webServer = { register(spec) { routes.set(spec.path, spec); return () => routes.delete(spec.path) } }
  const dispose = registerFleetDispatchRoutes(webServer, { runtime: fakeRuntime(), hosts: REMOTES, probe, wake: fakeWake() })
  assert.deepEqual([...routes.keys()].sort(), ['/api/fleet/batch', '/api/fleet/batches', '/api/fleet/cancel', '/api/fleet/dispatch'])
  assert.ok([...routes.values()].every((route) => route.kind === 'exact'))
  const wrong = await request(routes.get('/api/fleet/dispatch').handler, { method: 'GET' })
  assert.equal(wrong.status, 405)
  assert.equal(wrong.headers.allow, 'POST')
  dispose()
  assert.equal(routes.size, 0)
})

test('202 crosses durable barrier before background start and UI runs are remote-only', async () => {
  let release
  const durable = new Promise((resolve) => { release = resolve })
  const runtime = fakeRuntime({
    async createBatch(batch) { this.calls.push(['create-begin']); await durable; this.calls.push(['create-end']); return batch },
  })
  const h = makeHarness({ runtime })
  let settled = false
  const pending = request(h.handlers.dispatch, { method: 'POST', url: '/api/fleet/dispatch', body: { items: ['one', 'two'], hosts: ['up-a'], wake: false, label: 'jobs' } }).then((value) => { settled = true; return value })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(settled, false)
  assert.deepEqual(runtime.calls, [['create-begin']])
  assert.equal(h.deferred.length, 0)
  release()
  const response = await pending
  assert.equal(response.status, 202)
  assert.equal(response.body.origin, 'ui')
  assert.equal(response.body.label, 'jobs')
  assert.deepEqual(response.body.runs.map((run) => [run.index, run.host, run.status, run.item]), [[1, 'up-a', 'queued', '#1'], [2, 'up-a', 'queued', '#2']])
  assert.deepEqual(runtime.calls, [['create-begin'], ['create-end']])
  assert.equal(h.deferred.length, 1)
  h.deferred.shift()()
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(runtime.calls[2], ['start', response.body.batchId, ['up-a']])
})

test('W2 registerDispatch adapter durably records every run before waking its shared pump', async () => {
  const events = []
  const records = []
  const runtime = {
    activeCount: () => 0,
    maxConcurrency: 8,
    async registerDispatch(record) { events.push(`durable:${record.index}`); records.push(record) },
    getBatch(id) {
      return {
        batchId: id, label: records[0]?.label, createdAt: records[0]?.createdAt, origin: 'ui',
        runs: records.map((record) => ({ ...record })),
      }
    },
    wakePump(reason) { events.push(reason) },
  }
  const h = makeHarness({ runtime })
  const response = await request(h.handlers.dispatch, { method: 'POST', body: { items: ['full one', 'full two'], hosts: ['up-a'], timeoutMs: 1234 } })
  assert.equal(response.status, 202)
  assert.deepEqual(events, ['durable:1', 'durable:2'])
  assert.equal(h.deferred.length, 1)
  assert.equal(records[0].item, 'full one')
  assert.equal(records[0].prompt, 'full one')
  assert.equal(records[0].itemTruncated, false)
  assert.equal(records[0].runDir, '~/dsh-workspace/tasks/' + records[0].runId)
  assert.equal(records[0].timeoutMs, 1234)
  h.deferred.shift()()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(events[2], `ui-dispatch:${response.body.batchId}`)
})

test('integrates with the concrete W2 runtime for dispatch, detail, pump and exact cancel', async () => {
  const events = []
  const pumps = []
  const ledger = {
    async load() { return events },
    async append(event) { const stored = { ...structuredClone(event), v: 1, at: event.at ?? 1755700000000 }; events.push(stored); return stored },
    async appendMany(records) {
      const stored = records.map((record) => ({ ...structuredClone(record), ev: 'dispatch', v: 1, at: record.at ?? 1755700000000 }))
      events.push(...stored)
      return stored
    },
    async drain() {},
  }
  const runtime = createFleetRuntime({ ledger, now: () => 1755700000000, onPump: (event) => pumps.push(event) })
  await runtime.hydrate()
  const h = makeHarness({ runtime })
  const accepted = await request(h.handlers.dispatch, { method: 'POST', body: { items: ['the complete current-process item'], hosts: ['up-a'] } })
  assert.equal(accepted.status, 202)
  assert.equal(events[0].ev, 'dispatch')
  const detail = await request(h.handlers.batch, { url: `/api/fleet/batch?id=${accepted.body.batchId}` })
  assert.equal(detail.status, 200)
  assert.equal(detail.body.runs[0].item, 'the complete current-process item')
  assert.equal(detail.body.runs[0].itemTruncated, false)
  assert.equal(detail.body.runs[0].hasTrace, null)
  assert.equal(detail.body.runs[0].traceLines, null)
  assert.equal(detail.body.runs[0].artifactCount, null)
  h.deferred.shift()()
  assert.match(pumps.at(-1).reason, /^ui-dispatch:/)
  const cancelled = await request(h.handlers.cancel, { method: 'POST', body: { runId: accepted.body.runs[0].runId, host: 'up-a' } })
  assert.deepEqual(cancelled.body.cancelled, [accepted.body.runs[0].runId])
  assert.equal(runtime.getRun(accepted.body.runs[0].runId).status, 'cancelled')
  await runtime.shutdown()
})

test('wake side effect starts only after dispatch event is durable', async () => {
  const events = []
  const records = []
  const runtime = {
    activeCount: () => 0,
    async registerDispatch(record) { events.push('dispatch-durable'); records.push(record) },
    getBatch(id) { return { batchId: id, label: 'wake', createdAt: 1, origin: 'ui', runs: records } },
    wakePump() { events.push('pump') },
  }
  const wake = fakeWake()
  wake.request = async (hosts) => {
    events.push('wol-request')
    return { requested: hosts, alreadyUp: [], noWakePath: [], budgetMs: {} }
  }
  const h = makeHarness({ runtime, wake })
  const response = await request(h.handlers.dispatch, { method: 'POST', body: { items: ['x'], hosts: ['down-c'] } })
  assert.equal(response.status, 202)
  assert.deepEqual(events, ['dispatch-durable', 'wol-request'])
})

test('host assignment accounts for existing per-host load and configured capacity', async () => {
  const runtime = fakeRuntime({
    listRuns: () => [
      { runId: 'old-a-1', host: 'up-a', status: 'running' },
      { runId: 'old-a-2', host: 'up-a', status: 'detached' },
      { runId: 'old-b-1', host: 'up-b', status: 'running' },
    ],
  })
  const hosts = REMOTES.map((host) => host.name === 'up-a' ? { ...host, maxConcurrency: 2 } : host.name === 'up-b' ? { ...host, maxConcurrency: 6 } : host)
  const h = makeHarness({ runtime, hosts })
  const response = await request(h.handlers.dispatch, { method: 'POST', body: { items: ['x'], hosts: ['up-a', 'up-b'] } })
  assert.equal(response.status, 202)
  assert.equal(response.body.runs[0].host, 'up-b')
})

test('queued reservations are not hidden by a smaller active-only hostInflight count', async () => {
  const runtime = fakeRuntime({
    hostInflight: (name) => name === 'up-a' ? 0 : 1,
    listRuns: () => [
      { runId: 'queued-a-1', host: 'up-a', status: 'queued' },
      { runId: 'waking-a-2', host: 'up-a', status: 'waking' },
    ],
  })
  const h = makeHarness({ runtime })
  const response = await request(h.handlers.dispatch, { method: 'POST', body: { items: ['x'], hosts: ['up-a', 'up-b'] } })
  assert.equal(response.status, 202)
  assert.equal(response.body.runs[0].host, 'up-b')
})

test('validates content type, JSON, body size, items, label and timeout', async () => {
  const { handlers } = makeHarness()
  assert.equal((await request(handlers.dispatch, { method: 'POST', body: { items: ['x'] }, contentType: 'text/plain' })).status, 415)
  assert.equal((await request(handlers.dispatch, { method: 'POST', body: '{' })).status, 400)
  assert.equal((await request(handlers.dispatch, { method: 'POST', body: ' '.repeat(512 * 1024 + 1) })).status, 413)
  const invalid = [
    {}, { items: [] }, { items: Array(33).fill('x') }, { items: [''] },
    { items: ['x'.repeat(8001)] }, { items: ['x'], timeoutMs: 0 },
    { items: ['x'], timeoutMs: 3_600_001 }, { items: ['x'], wake: 'yes' },
    { items: ['x'], label: 'x'.repeat(121) }, { items: ['x'], hosts: [] },
  ]
  for (const body of invalid) assert.equal((await request(handlers.dispatch, { method: 'POST', body })).status, 400, JSON.stringify(body).slice(0, 80))
})

test('returns 404 for unknown host and rejects local explicitly', async () => {
  const { handlers } = makeHarness()
  const missing = await request(handlers.dispatch, { method: 'POST', body: { items: ['x'], hosts: ['missing'] } })
  assert.equal(missing.status, 404)
  assert.equal(missing.body.code, 'HOST_NOT_FOUND')
  const local = await request(handlers.dispatch, { method: 'POST', body: { items: ['x'], hosts: ['local'] } })
  assert.equal(local.status, 400)
  assert.equal(local.body.code, 'REMOTE_ONLY')
})

test('pinned unreachable matrix: wake disabled/no path/already waking', async () => {
  const disabled = makeHarness()
  let response = await request(disabled.handlers.dispatch, { method: 'POST', body: { items: ['x'], hosts: ['down-c'], wake: false } })
  assert.equal(response.status, 409)
  assert.equal(response.body.code, 'PINNED_HOST_UNREACHABLE')

  const noPath = makeHarness({ wake: fakeWake({ paths: [] }) })
  response = await request(noPath.handlers.dispatch, { method: 'POST', body: { items: ['x'], hosts: ['down-c'] } })
  assert.equal(response.status, 409)
  assert.equal(response.body.code, 'NO_WAKE_PATH')

  const waking = makeHarness({ wake: fakeWake({ state: new Map([['down-c', { state: 'probing', etaMs: 42000 }]]) }) })
  response = await request(waking.handlers.dispatch, { method: 'POST', body: { items: ['x'], hosts: ['down-c'] } })
  assert.equal(response.status, 423)
  assert.equal(response.body.detail.hosts[0].etaMs, 42000)
})

test('Codex remains local-only even if power is misconfigured with a wake path', async () => {
  const wake = fakeWake({ paths: ['codex'] })
  const h = makeHarness({
    hosts: [{ name: 'codex', kind: 'codex', tags: ['codex'], enabled: true }],
    probe: async () => ({ codex: { ok: false } }),
    wake,
  })
  const response = await request(h.handlers.dispatch, {
    method: 'POST', body: { items: ['x'], hosts: ['codex'], wake: true },
  })
  assert.equal(response.status, 409)
  assert.equal(response.body.code, 'NO_WAKE_PATH')
  assert.deepEqual(wake.calls, [])
})

test('returns 429 at global capacity and 503 with no healthy/wakeable remote', async () => {
  const busy = makeHarness({ runtime: fakeRuntime({ activeCount: () => 8 }) })
  assert.equal((await request(busy.handlers.dispatch, { method: 'POST', body: { items: ['x'] } })).status, 429)
  const unavailable = makeHarness({ hosts: [{ name: 'down', kind: 'remote', tags: ['x'] }], probe: async () => ({ down: { ok: false } }), wake: fakeWake({ paths: [] }) })
  const response = await request(unavailable.handlers.dispatch, { method: 'POST', body: { items: ['x'], wake: false } })
  assert.equal(response.status, 503)
  assert.equal(response.body.code, 'NO_HEALTHY_HOST')
})

test('hosts and tag use intersection; selected down host is waking and wake summary is returned', async () => {
  const h = makeHarness()
  const selected = await request(h.handlers.dispatch, { method: 'POST', body: { items: ['secret task'], hosts: ['up-a', 'up-b'], tag: 'linux' } })
  assert.equal(selected.status, 202)
  assert.deepEqual(selected.body.runs.map((run) => run.host), ['up-a'])

  const waking = await request(h.handlers.dispatch, { method: 'POST', body: { items: ['x'], hosts: ['down-c'] } })
  assert.equal(waking.status, 202)
  assert.equal(waking.body.runs[0].status, 'waking')
  assert.deepEqual(waking.body.wake.requested, ['down-c'])
  assert.deepEqual(h.wake.calls.at(-1).hosts, ['down-c'])
})

test('durability failure returns 500 and never schedules background work', async () => {
  const runtime = fakeRuntime({ async createBatch() { throw new Error('disk TOKEN=super-secret-value') } })
  const h = makeHarness({ runtime })
  const response = await request(h.handlers.dispatch, { method: 'POST', body: { items: ['x'], hosts: ['up-a'] } })
  assert.equal(response.status, 500)
  assert.equal(response.body.error, 'fleet dispatch internal error')
  assert.equal(h.deferred.length, 0)
})

test('partial multi-run durability failure terminalizes the durable prefix and never pumps it', async () => {
  const calls = []
  let count = 0
  const runtime = {
    activeCount: () => 0,
    async registerDispatch(record) {
      calls.push(['register', record.runId])
      if (++count === 2) throw new Error('disk full')
    },
    async cancelBatch(batchId, reason) { calls.push(['cancelBatch', batchId, reason]); return { batchId, cancelled: ['prefix'], skipped: [] } },
  }
  const h = makeHarness({ runtime })
  const response = await request(h.handlers.dispatch, { method: 'POST', body: { items: ['one', 'two'], hosts: ['up-a'] } })
  assert.equal(response.status, 500)
  assert.equal(h.deferred.length, 0)
  assert.equal(calls.filter(([kind]) => kind === 'cancelBatch').length, 1)
  assert.equal(calls.at(-1)[2], 'dispatch persistence incomplete')
})

test('concrete W2 atomic batch failure publishes no runtime prefix', async () => {
  const ledger = {
    async load() { return [] },
    async appendMany() { throw new Error('atomic publish failed') },
    async append() { throw new Error('not used') },
    async drain() {},
  }
  const runtime = createFleetRuntime({ ledger })
  await runtime.hydrate()
  const h = makeHarness({ runtime })
  const response = await request(h.handlers.dispatch, { method: 'POST', body: { items: ['one', 'two'], hosts: ['up-a'] } })
  assert.equal(response.status, 500)
  assert.deepEqual(runtime.listRuns(), [])
  assert.deepEqual(runtime.listBatches(), [])
  assert.equal(h.deferred.length, 0)
  await runtime.shutdown()
})

test('failed partial-ledger compensation reports the recoverable batch id instead of hiding it', async () => {
  let count = 0
  const runtime = {
    activeCount: () => 0,
    async registerDispatch() { if (++count === 2) throw new Error('disk full') },
    async cancelBatch() { throw new Error('disk still full') },
  }
  const h = makeHarness({ runtime })
  const response = await request(h.handlers.dispatch, { method: 'POST', body: { items: ['one', 'two'], hosts: ['up-a'] } })
  assert.equal(response.status, 500)
  assert.equal(response.body.code, 'DURABLE_COMPENSATION_FAILED')
  assert.match(response.body.detail.batchId, /^b-/)
  assert.equal(response.body.detail.registeredRunIds.length, 1)
  assert.equal(h.deferred.length, 0)
})

test('wake-start failure compensates the durable batch and does not expose a zombie', async () => {
  const runtime = fakeRuntime({
    async cancelBatch(id, reason) { this.calls.push(['compensate', id, reason]); return { batchId: id, cancelled: [], skipped: [] } },
  })
  const wake = fakeWake()
  wake.request = async () => { throw new Error('gateway spawn failed') }
  const h = makeHarness({ runtime, wake })
  const response = await request(h.handlers.dispatch, { method: 'POST', body: { items: ['x'], hosts: ['down-c'] } })
  assert.equal(response.status, 500)
  assert.equal(h.deferred.length, 0)
  assert.equal(runtime.calls.at(-1)[0], 'compensate')
  assert.equal(runtime.calls.at(-1)[2], 'wake request failed')
})

test('race-time power error preserves its 423 status and compensates durable work', async () => {
  const runtime = fakeRuntime({
    async cancelBatch(id, reason) { this.calls.push(['compensate', id, reason]); return { batchId: id, cancelled: [], skipped: [] } },
  })
  const wake = fakeWake()
  wake.request = async () => { throw Object.assign(new Error('host is already waking'), { statusCode: 423, code: 'HOST_WAKING', etaMs: 9000 }) }
  const h = makeHarness({ runtime, wake })
  const response = await request(h.handlers.dispatch, { method: 'POST', body: { items: ['x'], hosts: ['down-c'] } })
  assert.equal(response.status, 423)
  assert.equal(response.body.code, 'HOST_WAKING')
  assert.equal(response.body.detail.etaMs, 9000)
  assert.equal(runtime.calls.at(-1)[0], 'compensate')
})

test('wake race reporting alreadyUp transitions waking run back to queued before response', async () => {
  const marked = []
  const runtime = fakeRuntime({ async markQueued(id, patch) { marked.push([id, patch]) } })
  const wake = fakeWake({ result: { requested: [], alreadyUp: ['down-c'], noWakePath: [], budgetMs: {} } })
  const h = makeHarness({ runtime, wake })
  const response = await request(h.handlers.dispatch, { method: 'POST', body: { items: ['x'], hosts: ['down-c'] } })
  assert.equal(response.status, 202)
  assert.equal(response.body.runs[0].status, 'queued')
  assert.equal(marked.length, 1)
  assert.deepEqual(marked[0][1], { wakeState: 'ready' })
})

test('pinned noWakePath race fails only affected runs and still pumps healthy siblings', async () => {
  const runtime = fakeRuntime()
  const wake = fakeWake({ result: { requested: [], alreadyUp: [], noWakePath: ['down-c'], budgetMs: {} } })
  const h = makeHarness({ runtime, wake })
  const response = await request(h.handlers.dispatch, { method: 'POST', body: { items: ['healthy', 'down'], hosts: ['up-a', 'down-c'] } })
  assert.equal(response.status, 202)
  assert.deepEqual(response.body.runs.map((run) => run.status), ['queued', 'failed'])
  assert.equal(h.deferred.length, 1)
})

test('unpinned tag noWakePath race reroutes affected run to a healthy sibling', async () => {
  const runtime = fakeRuntime()
  const wake = fakeWake({ result: { requested: [], alreadyUp: [], noWakePath: ['down-c'], budgetMs: {} } })
  const h = makeHarness({ runtime, wake })
  const response = await request(h.handlers.dispatch, { method: 'POST', body: { items: ['a', 'b', 'c'], tag: 'general' } })
  assert.equal(response.status, 202)
  assert.deepEqual(response.body.runs.map((run) => run.status), ['queued', 'queued', 'queued'])
  assert.equal(response.body.runs.some((run) => run.host === 'down-c'), false)
  assert.equal(h.deferred.length, 1)
})

test('noWakePath never reroutes to another host that is merely waking', async () => {
  const hosts = [
    { name: 'down-c', kind: 'remote', tags: ['batch'], maxConcurrency: 1 },
    { name: 'down-d', kind: 'remote', tags: ['batch'], maxConcurrency: 1 },
  ]
  const runtime = fakeRuntime()
  const wake = fakeWake({
    paths: ['down-c', 'down-d'],
    result: { requested: ['down-d'], alreadyUp: [], noWakePath: ['down-c'], budgetMs: { 'down-d': 1000 } },
  })
  const h = makeHarness({ runtime, hosts, wake, probe: async () => ({ 'down-c': { ok: false }, 'down-d': { ok: false } }) })
  const response = await request(h.handlers.dispatch, { method: 'POST', body: { items: ['a', 'b'], tag: 'batch' } })
  assert.equal(response.status, 202)
  assert.deepEqual(response.body.runs.map((run) => [run.host, run.status]), [['down-c', 'failed'], ['down-d', 'waking']])
  assert.equal(h.deferred.length, 1)
})

test('list summary/include runs and detail expose only bounded scrubbed public fields', async () => {
  const token = 'sk-1234567890abcdefghijklmnop'
  const raw = {
    batchId: 'b-1', label: `batch ${token}`, createdAt: 10, origin: 'ui', status: 'completed',
    counts: { total: 999, active: 0, private: token },
    runs: [{
      runId: 'r-1', index: 1, host: 'up-a', item: `full ${token}`, status: 'detached',
      startedAt: 11, error: `Bearer ${token}`, runDir: '~/work/tasks/r-1', hasTrace: true,
      traceLines: 5, artifactCount: 2, itemTruncated: true, resultText: 'r'.repeat(13000),
      privateCredential: token,
    }],
    privateCredential: token,
  }
  const runtime = fakeRuntime({ async listBatches() { return [raw] }, async getBatch(id) { return id === 'b-1' ? raw : undefined } })
  const { handlers } = makeHarness({ runtime })
  const summary = await request(handlers.batches, { url: '/api/fleet/batches' })
  assert.equal(summary.status, 200)
  assert.equal(summary.body.batches[0].runs, undefined)
  assert.equal(JSON.stringify(summary.body).includes(token), false)
  assert.equal(summary.body.batches[0].privateCredential, undefined)

  const included = await request(handlers.batches, { url: '/api/fleet/batches?limit=1&include=runs' })
  assert.equal(included.body.batches[0].runs[0].item, '#1')
  assert.equal(included.body.batches[0].runs[0].status, 'detached')
  assert.equal(included.body.batches[0].runs[0].itemTruncated, true)
  assert.equal(included.body.batches[0].status, 'running', 'detached remains nonterminal even if aggregate status is stale')
  assert.deepEqual(included.body.batches[0].counts, { total: 1, completed: 0, failed: 0, cancelled: 0, active: 1 })

  const detail = await request(handlers.batch, { url: '/api/fleet/batch?id=b-1' })
  assert.match(detail.body.label, /«redacted»/)
  assert.match(detail.body.runs[0].item, /«redacted»/)
  assert.equal(detail.body.runs[0].resultText.length, 12000)
  assert.equal(detail.body.runs[0].privateCredential, undefined)
  assert.equal(JSON.stringify(detail.body).includes(token), false)
  assert.equal((await request(handlers.batch, { url: '/api/fleet/batch?id=missing' })).status, 404)
  assert.equal((await request(handlers.batch, { url: '/api/fleet/batch' })).status, 400)
  assert.equal((await request(handlers.batches, { url: '/api/fleet/batches?limit=0' })).status, 400)
})

test('cancel supports a whole batch or exactly one run and scrubs every response field', async () => {
  const token = 'sk-1234567890abcdefghijklmnop'
  const runtime = fakeRuntime({
    async getBatch(id) { return id === 'b-1' ? { batchId: id, status: 'running', runs: [] } : undefined },
    async getRun(id) { return id === 'r-1' ? { runId: id, host: 'up-a', status: 'running' } : undefined },
    async cancelBatch(id) { return { cancelled: [id], skipped: [{ runId: 'r', reason: token }], [token]: 'key leak' } },
    async cancelRun(id) { return { cancelled: [id], skipped: [] } },
  })
  const { handlers } = makeHarness({ runtime })
  const batch = await request(handlers.cancel, { method: 'POST', body: { batchId: 'b-1' } })
  assert.equal(batch.status, 200)
  assert.equal(JSON.stringify(batch.body).includes(token), false)
  assert.equal(Object.keys(batch.body).some((key) => key.includes(token)), false)
  const run = await request(handlers.cancel, { method: 'POST', body: { runId: 'r-1', host: 'up-a' } })
  assert.deepEqual(run.body.cancelled, ['r-1'])
  assert.equal((await request(handlers.cancel, { method: 'POST', body: {} })).status, 400)
  assert.equal((await request(handlers.cancel, { method: 'POST', body: { batchId: 'b', runId: 'r', host: 'up-a' } })).status, 400)
  assert.equal((await request(handlers.cancel, { method: 'POST', body: { runId: 'r' } })).status, 400)
})

test('W2 cancel adapter checks run host and passes a reason instead of treating host as reason', async () => {
  const calls = []
  const runtime = fakeRuntime({
    async getRun(id) { return id === 'r-1' ? { runId: id, host: 'up-a', status: 'running' } : undefined },
    async cancelRun(id, reason) { calls.push([id, reason]); return { runId: id, host: 'up-a', status: 'cancelled' } },
  })
  const { handlers } = makeHarness({ runtime })
  const wrongHost = await request(handlers.cancel, { method: 'POST', body: { runId: 'r-1', host: 'up-b' } })
  assert.equal(wrongHost.status, 404)
  assert.equal(calls.length, 0)
  const cancelled = await request(handlers.cancel, { method: 'POST', body: { runId: 'r-1', host: 'up-a' } })
  assert.deepEqual(calls, [['r-1', 'ui cancel']])
  assert.deepEqual(cancelled.body, { cancelled: ['r-1'], skipped: [] })
})

test('restored preview is honest and invalid internal status fails closed', async () => {
  const restored = {
    batchId: 'b-restored', label: 'restored', createdAt: 1,
    runs: [{ runId: 'r-restored', index: 1, host: 'up-a', item: 'only the durable 400-char preview', itemTruncated: true, status: 'running' }],
  }
  const runtime = fakeRuntime({ async getBatch() { return restored } })
  const { handlers } = makeHarness({ runtime })
  const response = await request(handlers.batch, { url: '/api/fleet/batch?id=b-restored' })
  assert.equal(response.body.runs[0].itemTruncated, true)
  assert.equal(response.body.runs[0].item, 'only the durable 400-char preview')

  runtime.getBatch = async () => ({ ...restored, runs: [{ ...restored.runs[0], status: 'done-ish' }] })
  const invalid = await request(handlers.batch, { url: '/api/fleet/batch?id=b-restored' })
  assert.equal(invalid.status, 500)
  assert.equal(invalid.body.code, 'INTERNAL_ERROR')
})

test('concrete W2 hydration exposes only durable preview with itemTruncated', async () => {
  const preview = 'p'.repeat(400)
  const ledger = {
    async load() {
      return [{
        v: 1, at: 12, ev: 'dispatch', batchId: 'b-hydrated', runId: 'r-hydrated',
        index: 1, host: 'up-a', runDir: '~/work/tasks/r-hydrated', model: 'm',
        origin: 'ui', label: 'restored', prompt: preview, promptTruncated: true, status: 'detached',
      }]
    },
    async append(event) { return { ...event, v: 1, at: 13 } },
    async drain() {},
  }
  const runtime = createFleetRuntime({ ledger })
  await runtime.hydrate()
  const { handlers } = makeHarness({ runtime })
  const response = await request(handlers.batch, { url: '/api/fleet/batch?id=b-hydrated' })
  assert.equal(response.status, 200)
  assert.equal(response.body.status, 'running')
  assert.equal(response.body.runs[0].item, preview)
  assert.equal(response.body.runs[0].itemTruncated, true)
  await runtime.shutdown()
})
