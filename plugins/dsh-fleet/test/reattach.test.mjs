import test from 'node:test'
import assert from 'node:assert/strict'

import { createFleetRuntime, RUN_STATUSES } from '../lib/fleet-runtime.mjs'

class MemoryLedger {
  constructor(events = []) { this.events = events.map((event) => structuredClone(event)); this.pending = new Set() }
  async load() { return this.events.map((event) => structuredClone(event)) }
  async append(event) {
    const stored = { v: 1, at: event.at ?? 1000 + this.events.length, ...structuredClone(event) }
    this.events.push(stored)
    return structuredClone(stored)
  }
  async appendMany(events) {
    const stored = []
    for (const event of events) stored.push(await this.append(event))
    return stored
  }
  async drain() { await Promise.allSettled([...this.pending]) }
}

const dispatch = (runId, extra = {}) => ({
  v: 1, at: 100, ev: 'dispatch', batchId: 'b1', runId, index: 1,
  host: 'worker', runDir: `~/dsh-workspace/tasks/${runId}`, prompt: `item ${runId}`,
  timeoutMs: 900000, ...extra,
})
const started = (runId, extra = {}) => ({ v: 1, at: 200, ev: 'start', batchId: 'b1', runId, ...extra })

test('runtime publishes exactly the nine specified run states', () => {
  assert.deepEqual(RUN_STATUSES, [
    'waking', 'queued', 'running', 'detached',
    'completed', 'failed', 'cancelled', 'interrupted', 'lost',
  ])
})

test('hydrate restores full batch topology while persisted dispatch uses its preview', async () => {
  const runtime = createFleetRuntime({ ledger: new MemoryLedger([dispatch('r1', { prompt: 'preview', promptTruncated: true })]) })
  await runtime.hydrate()
  assert.equal(runtime.getRun('r1').item, 'preview')
  assert.equal(runtime.getRun('r1').itemTruncated, true)
  assert.equal(runtime.getBatch('b1').runs[0].status, 'queued')

  const live = createFleetRuntime({ ledger: new MemoryLedger() })
  const item = 'complete item '.repeat(80)
  const registered = await live.registerDispatch({ ...dispatch('r2'), item, status: 'waking' })
  assert.equal(registered.item, item)
  assert.equal(live.getBatch('b1').runs[0].item, item)
  assert.equal(live.ledger.events[0].item, item) // MemoryLedger is intentionally raw; disk ledger owns clipping.
  assert.equal(registered.status, 'waking')
  assert.equal((await live.markQueued('r2', { host: 'worker-2' })).status, 'queued')
  assert.equal(live.getRun('r2').host, 'worker-2')
  const rerouted = await live.rerouteRun('r2', { host: 'worker-3', runDir: '~/tasks/r2-new', model: 'm2' })
  assert.equal(rerouted.status, 'queued')
  assert.equal(rerouted.host, 'worker-3')
  assert.equal(rerouted.runDir, '~/tasks/r2-new')
})

test('reconciler maps SETTLED/ALIVE/DEAD/MISSING and SETTLED retrieves out.txt', async () => {
  const cases = [
    { reply: 'SETTLED 0', expected: 'completed' },
    { reply: 'ALIVE 123', expected: 'running' },
    { reply: 'DEAD', expected: 'interrupted' },
    { reply: 'MISSING', expected: 'lost' },
  ]
  for (const [index, row] of cases.entries()) {
    const runId = `r${index}`
    const ledger = new MemoryLedger([dispatch(runId), started(runId), { v: 1, at: 300, ev: 'detach', batchId: 'b1', runId, reason: 'ssh exit 255' }])
    const reads = []
    const runtime = createFleetRuntime({
      ledger, now: () => 500,
      probeRun: async () => ({ ok: true, out: row.reply }),
      readOutput: async (_run, max) => { reads.push(max); return { ok: true, out: 'final Bearer hidden-token' } },
    })
    await runtime.hydrate()
    assert.equal(runtime.getRun(runId).status, 'detached', 'detached remains non-terminal before reconcile')
    await runtime.reconcileOnce()
    const run = runtime.getRun(runId)
    assert.equal(run.status, row.expected, row.reply)
    if (row.expected === 'completed') {
      assert.deepEqual(reads, [200000])
      assert.equal(run.resultText, 'final Bearer «redacted»')
      assert.ok(ledger.events.some((event) => event.ev === 'end' && event.runId === runId))
    }
    if (row.reply.startsWith('ALIVE')) {
      assert.equal(run.pid, '123'); assert.equal(run.reattached, true)
    }
  }
})

test('an overdue run is probed alive before timeout handling and releases the global slot', async () => {
  const order = [], pumps = []
  const ledger = new MemoryLedger([dispatch('late', { timeoutMs: 100 }), started('late', { at: 200, timeoutMs: 100 })])
  const runtime = createFleetRuntime({
    ledger, now: () => 1000,
    probeRun: async () => { order.push('probe'); return 'ALIVE 9' },
    onTimeout: async () => { order.push('timeout'); return { exit: 143 } },
    onPump: (event) => pumps.push(event.reason),
  })
  await runtime.hydrate()
  assert.equal(runtime.activeCount(), 1)
  await runtime.reconcileOnce()
  assert.deepEqual(order, ['probe', 'timeout'])
  assert.equal(runtime.getRun('late').status, 'failed')
  assert.equal(runtime.getRun('late').error, 'TIMEOUT')
  assert.equal(runtime.activeCount(), 0)
  assert.ok(pumps.includes('slot-released'))
})

test('timeout kill failure remains detached with timeoutPending instead of settling', async () => {
  const ledger = new MemoryLedger([dispatch('late-fail', { timeoutMs: 100 }), started('late-fail', { at: 200, timeoutMs: 100 })])
  const runtime = createFleetRuntime({
    ledger, now: () => 1000,
    probeRun: async () => 'ALIVE 10',
    onTimeout: async () => ({ settled: false, reason: 'timeout remote kill failed' }),
  })
  await runtime.hydrate()
  await runtime.reconcileOnce()
  const run = runtime.getRun('late-fail')
  assert.equal(run.status, 'detached')
  assert.equal(run.timeoutPending, true)
  assert.equal(run.error, 'timeout remote kill failed')
  assert.equal(ledger.events.some((event) => event.ev === 'end'), false)
})

test('three consecutive ssh failures clear stale control sockets and keep the run detached', async () => {
  let clears = 0
  const ledger = new MemoryLedger([dispatch('r1'), started('r1')])
  const runtime = createFleetRuntime({
    ledger,
    probeRun: async () => ({ ok: false, code: 255, err: 'Connection timed out' }),
    clearControlSockets: async (host) => { assert.equal(host, 'worker'); clears++ },
  })
  await runtime.hydrate()
  await runtime.reconcileOnce(); await runtime.reconcileOnce(); await runtime.reconcileOnce()
  assert.equal(runtime.getRun('r1').status, 'detached')
  assert.equal(clears, 1)
})

test('hydrated detached cancel probes ALIVE then invokes the injected remote kill before cancelled', async () => {
  const order = []
  const ledger = new MemoryLedger([
    dispatch('reattached'), started('reattached'),
    { v: 1, at: 300, ev: 'detach', batchId: 'b1', runId: 'reattached', reason: 'ssh exit 255' },
  ])
  const runtime = createFleetRuntime({
    ledger,
    probeRun: async (run) => { order.push(`probe:${run.status}`); return 'ALIVE 7788' },
    cancelRemote: async (run, context) => {
      order.push(`kill:${context.pid}:${context.reason}`)
      assert.equal(run.runDir, '~/dsh-workspace/tasks/reattached')
      assert.equal(context.probe.kind, 'alive')
      return { ok: true }
    },
  })
  await runtime.hydrate()
  const signal = runtime.controllerForRun('reattached').signal
  const result = await runtime.cancelRun('reattached', 'ui cancel')
  assert.deepEqual(order, ['probe:detached', 'kill:7788:ui cancel'])
  assert.equal(result.cancelled, true)
  assert.equal(result.run.status, 'cancelled')
  assert.equal(signal.aborted, true)
  assert.equal(ledger.events.at(-1).ev, 'cancel')
})

test('unreachable cancel stays detached and pending, then reconciler retries the real kill', async () => {
  let reachable = false, kills = 0, retriedReason
  const ledger = new MemoryLedger([
    dispatch('offline', { timeoutMs: 100 }), started('offline', { at: 200, timeoutMs: 100 }),
    { v: 1, at: 300, ev: 'detach', batchId: 'b1', runId: 'offline', reason: 'connection reset' },
  ])
  const runtime = createFleetRuntime({
    ledger, now: () => 1000,
    probeRun: async () => reachable ? 'ALIVE 44' : { ok: false, code: 255, err: 'Connection timed out' },
    cancelRemote: async (_run, context) => { kills++; retriedReason = context.reason; return { ok: true } },
  })
  await runtime.hydrate()
  const signal = runtime.controllerForRun('offline').signal
  const first = await runtime.cancelRun('offline', 'ui cancel')
  assert.equal(first.cancelled, false)
  assert.equal(first.pending, true)
  assert.equal(first.run.status, 'detached')
  assert.equal(first.run.cancelPending, true)
  assert.equal(first.run.timeoutPending, true)
  assert.equal(signal.aborted, false)
  assert.equal(kills, 0)
  assert.equal(ledger.events.some((event) => event.ev === 'cancel'), false)

  reachable = true
  await runtime.reconcileOnce()
  assert.equal(kills, 1)
  assert.equal(retriedReason, 'ui cancel')
  assert.equal(runtime.getRun('offline').status, 'cancelled')
  assert.equal(signal.aborted, true)
})

test('cancel observes SETTLED and recovers output instead of killing or lying cancelled', async () => {
  let kills = 0
  const ledger = new MemoryLedger([
    dispatch('done'), started('done'),
    { v: 1, at: 300, ev: 'detach', batchId: 'b1', runId: 'done', reason: 'connection closed' },
  ])
  const runtime = createFleetRuntime({
    ledger,
    probeRun: async () => 'SETTLED 0',
    readOutput: async () => ({ ok: true, out: 'already complete' }),
    cancelRemote: async () => { kills++; return { ok: true } },
  })
  await runtime.hydrate()
  const result = await runtime.cancelRun('done', 'ui cancel')
  assert.equal(result.cancelled, false)
  assert.equal(result.reason, 'settled')
  assert.equal(result.run.status, 'completed')
  assert.equal(result.run.resultText, 'already complete')
  assert.equal(kills, 0)
  assert.equal(ledger.events.some((event) => event.ev === 'cancel'), false)
})

test('active local run cancellation uses its live controller without remote probe or kill', async () => {
  let probes = 0, kills = 0, observedAbort = false
  const ledger = new MemoryLedger()
  const runtime = createFleetRuntime({
    ledger,
    isLocalRun: (run) => run.host === 'local',
    probeRun: async () => { probes++; return 'MISSING' },
    cancelRemote: async () => { kills++; return { ok: true } },
  })
  await runtime.registerDispatch({ ...dispatch('local-run', { host: 'local', runDir: '' }), item: 'local item' })
  await runtime.markStart('local-run', { startedAt: 200 })
  runtime.controllerForRun('local-run').signal.addEventListener('abort', () => { observedAbort = true }, { once: true })
  const result = await runtime.cancelRun('local-run', 'ui cancel')
  assert.equal(result.cancelled, false)
  assert.equal(result.pending, true)
  assert.equal(result.run.status, 'detached')
  assert.equal(runtime.activeCount(), 1)
  assert.equal(observedAbort, true)
  assert.equal(probes, 0)
  assert.equal(kills, 0)
  await runtime.reconcileOnce()
  assert.equal(kills, 0, 'pending local cleanup must never invoke a remote kill')
  await runtime.confirmRemoteCancelled('local-run', 'ui cancel')
  assert.equal(runtime.activeCount(), 0)
})

test('markStart-to-spawn barrier can route cancellation through the owned controller', async () => {
  let probes = 0, kills = 0, observedAbort = false
  const ledger = new MemoryLedger()
  const runtime = createFleetRuntime({
    ledger,
    isLocalExecution: (run) => run.runId === 'starting-remote',
    probeRun: async () => { probes++; return 'MISSING' },
    cancelRemote: async () => { kills++; return { ok: true } },
  })
  await runtime.registerDispatch({ ...dispatch('starting-remote'), item: 'remote item' })
  await runtime.markStart('starting-remote', { startedAt: 200 })
  runtime.controllerForRun('starting-remote').signal.addEventListener('abort', () => { observedAbort = true }, { once: true })
  const result = await runtime.cancelRun('starting-remote', 'cancel before spawn')
  assert.equal(result.run.status, 'cancelled')
  assert.equal(observedAbort, true)
  assert.equal(probes, 0)
  assert.equal(kills, 0)
})

test('active remote cancellation delegates exactly one kill to its live runner', async () => {
  let runnerKills = 0, runtimeKills = 0
  const ledger = new MemoryLedger()
  const runtime = createFleetRuntime({
    ledger,
    hasLiveController: (run) => run.runId === 'live-remote',
    probeRun: async () => 'ALIVE 77',
    cancelRemote: async () => { runtimeKills++; return { ok: true } },
  })
  await runtime.registerDispatch({ ...dispatch('live-remote'), item: 'remote item' })
  await runtime.markStart('live-remote', { startedAt: 200 })
  runtime.controllerForRun('live-remote').signal.addEventListener('abort', () => { runnerKills++ }, { once: true })
  const requested = await runtime.cancelRun('live-remote', 'ui cancel')
  assert.equal(requested.cancelled, false)
  assert.equal(requested.pending, true)
  assert.equal(requested.reason, 'controller')
  assert.equal(requested.run.status, 'detached')
  assert.equal(requested.run.cancelPending, true)
  assert.equal(runnerKills, 1)
  assert.equal(runtimeKills, 0, 'runtime must not race the live runner with a second remoteKill')
  assert.equal(ledger.events.some((event) => event.ev === 'cancel'), false)

  const confirmed = await runtime.confirmRemoteCancelled('live-remote', 'ui cancel')
  assert.equal(confirmed.cancelled, true)
  assert.equal(confirmed.run.status, 'cancelled')
  assert.equal(runnerKills, 1)
  assert.equal(runtimeKills, 0)
})

test('RUN_LOCK serializes terminal races; run and batch controllers cancel truthfully', async () => {
  const ledger = new MemoryLedger()
  const runtime = createFleetRuntime({ ledger })
  await runtime.registerDispatch({ ...dispatch('r1'), item: 'one' })
  await runtime.registerDispatch({ ...dispatch('r2', { index: 2 }), item: 'two' })
  const signal = runtime.controllerForRun('r1').signal
  const [cancelled, ended] = await Promise.all([
    runtime.cancelRun('r1', 'ui cancel'),
    runtime.markEnd('r1', { ok: true, resultText: 'too late' }),
  ])
  assert.equal(cancelled.cancelled, true)
  assert.equal(signal.aborted, true)
  assert.equal(runtime.controllerForRun('r1').signal.aborted, true, 'a cancelled controller is never silently replaced')
  assert.equal(ended.status, 'cancelled')
  const batchCancel = await runtime.cancelBatch('b1', 'batch cancel')
  assert.deepEqual(batchCancel.cancelled, ['r2'])
  assert.deepEqual(batchCancel.skipped, [{ runId: 'r1', reason: 'terminal' }])
  assert.equal(runtime.getBatch('b1').status, 'cancelled')
})

test('registerDispatchBatch applies all runtime records only after one ledger barrier', async () => {
  const ledger = new MemoryLedger()
  let fail = true
  ledger.appendMany = async (events) => {
    if (fail) throw new Error('disk full')
    return Promise.all(events.map((event) => ledger.append(event)))
  }
  const runtime = createFleetRuntime({ ledger })
  const records = [
    { ...dispatch('r1'), item: 'full one' },
    { ...dispatch('r2', { index: 2 }), item: 'full two' },
  ]
  await assert.rejects(runtime.registerDispatchBatch(records), /disk full/)
  assert.deepEqual(runtime.listRuns(), [])
  fail = false
  const runs = await runtime.registerDispatchBatch(records)
  assert.deepEqual(runs.map((run) => run.item), ['full one', 'full two'])
  assert.equal(runtime.getBatch('b1').runs.length, 2)
})

test('reconciler timer is injectable and shutdown drains without aborting remote controllers', async () => {
  let callback, cleared = false, drained = false
  const ledger = new MemoryLedger()
  ledger.drain = async () => { drained = true }
  const runtime = createFleetRuntime({
    ledger,
    setInterval: (fn, ms) => { callback = fn; assert.equal(ms, 30000); return { unref() {} } },
    clearInterval: () => { cleared = true },
  })
  await runtime.registerDispatch({ ...dispatch('r1'), item: 'one' })
  const signal = runtime.controllerForRun('r1').signal
  runtime.startReconciler()
  assert.equal(typeof callback, 'function')
  await runtime.shutdown()
  assert.equal(cleared, true)
  assert.equal(drained, true)
  assert.equal(signal.aborted, false, 'shutdown detaches; it must not kill remote work')
})
