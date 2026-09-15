import test from 'node:test'
import assert from 'node:assert/strict'

import { createFleetRuntime, DEFAULT_RECONCILE_INTERVAL_MS, TERMINAL_RUN_STATUSES } from '../lib/fleet-runtime.mjs'
import { probeLocalRun } from '../lib/local-probe.mjs'

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

const dispatchLocal = (runId, extra = {}) => ({
  v: 1, at: 100, ev: 'dispatch', batchId: 'b1', runId, index: 1,
  host: 'local', kind: 'local', runDir: '', prompt: `item ${runId}`,
  timeoutMs: 900000, ...extra,
})
const started = (runId, extra = {}) => ({ v: 1, at: 200, ev: 'start', batchId: 'b1', runId, ...extra })

const terminalEvents = (ledger) => ledger.events.filter((event) =>
  event.ev === 'end' || event.ev === 'cancel' ||
  (event.ev === 'reattach' && (event.state === 'lost' || event.state === 'interrupted')))

async function waitSettled(runtime) {
  if (runtime.reconcilePromise) await runtime.reconcilePromise.catch(() => {})
  await Promise.allSettled([...runtime.runLocks.values()])
  await runtime.ledger.drain?.()
}

function createLocalRuntime(options = {}) {
  const liveSet = options.liveSet ?? new Set()
  const ledger = options.ledger ?? new MemoryLedger()
  let now = options.now ?? 1_000
  const runtime = createFleetRuntime({
    ledger,
    now: () => now,
    reconcileIntervalMs: options.reconcileIntervalMs ?? 5,
    isLocalRun: (run) => run.host === 'local' || run.kind === 'local' || !run.runDir,
    hasLiveController: (run) => liveSet.has(run.runId),
    probeRun: options.probeRun ?? (async (run) => probeLocalRun({ run, liveSet })),
    onTimeout: options.onTimeout,
    setInterval: options.setInterval,
    clearInterval: options.clearInterval,
    ...options.runtime,
  })
  return {
    runtime,
    ledger,
    liveSet,
    now: () => now,
    setNow: (value) => { now = value },
  }
}

test('default reconcile period stays 30s; tests must not hide the bug by lengthening it', () => {
  assert.equal(DEFAULT_RECONCILE_INTERVAL_MS, 30_000)
  const runtime = createFleetRuntime({ ledger: new MemoryLedger() })
  assert.equal(runtime.reconcileIntervalMs, 30_000)
})

test('probeLocalRun distinguishes this-process live local from post-restart orphans', () => {
  const liveSet = new Set(['live-1'])
  assert.deepEqual(probeLocalRun({ run: { runId: 'live-1' }, liveSet }), { ok: true, out: 'ALIVE' })
  assert.deepEqual(probeLocalRun({ run: { runId: 'hist-1' }, liveSet }), { ok: true, out: 'MISSING' })
  assert.deepEqual(probeLocalRun({ run: { runId: 'hist-1' }, liveSet, afterRestart: true }), { ok: true, out: 'MISSING' })
  assert.deepEqual(probeLocalRun({
    run: { runId: 'reconstructed' },
    controllerLookup: () => true,
    afterRestart: true,
  }), { ok: true, out: 'MISSING' })
  assert.deepEqual(probeLocalRun({
    run: { runId: 'reconstructed' },
    controllerLookup: () => true,
  }), { ok: true, out: 'ALIVE' })
  assert.deepEqual(probeLocalRun({
    run: { runId: 'live-1' },
    liveSet,
    controllerLookup: () => false,
    afterRestart: true,
  }), { ok: true, out: 'ALIVE' })
  assert.deepEqual(probeLocalRun({ run: {} }), { ok: true, out: 'MISSING' })
})

test('slow local task stays running and occupies concurrency across two reconcile periods', async () => {
  let intervalMs
  let tick = () => {}
  const { runtime, liveSet, ledger } = createLocalRuntime({
    reconcileIntervalMs: 5,
    probeRun: async () => ({ ok: true, out: 'MISSING' }),
    setInterval: (fn, ms) => {
      intervalMs = ms
      tick = fn
      return { unref() {} }
    },
    clearInterval: () => {},
  })
  await runtime.registerDispatch({ ...dispatchLocal('slow-local'), item: 'slow work' })
  await runtime.markStart('slow-local', { startedAt: 1000 })
  liveSet.add('slow-local')
  assert.equal(runtime.getRun('slow-local').status, 'running')
  assert.equal(runtime.activeCount(), 1)
  assert.equal(runtime.heldLocalRuns.has('slow-local'), true)

  runtime.startReconciler()
  assert.equal(intervalMs, 5, 'period must stay short; lengthening it would hide the bug')
  tick()
  await waitSettled(runtime)
  assert.equal(runtime.getRun('slow-local').status, 'running', 'still running after first reconcile period')
  assert.equal(runtime.activeCount(), 1)
  tick()
  await waitSettled(runtime)
  assert.equal(runtime.getRun('slow-local').status, 'running', 'still running after second reconcile period')
  assert.equal(runtime.activeCount(), 1)
  assert.equal(terminalEvents(ledger).length, 0)

  await runtime.markEnd('slow-local', { ok: true, resultText: 'done' })
  liveSet.delete('slow-local')
  await waitSettled(runtime)
  assert.equal(runtime.getRun('slow-local').status, 'completed')
  assert.equal(runtime.activeCount(), 0)
  assert.equal(runtime.heldLocalRuns.has('slow-local'), false)
  await runtime.shutdown()
})

test('hardcoded MISSING probe cannot settle a local run this process still holds', async () => {
  const { runtime, liveSet } = createLocalRuntime({
    probeRun: async () => ({ ok: true, out: 'MISSING' }),
  })
  await runtime.registerDispatch({ ...dispatchLocal('held'), item: 'held' })
  await runtime.markStart('held', { startedAt: 1000 })
  liveSet.add('held')
  await runtime.reconcileOnce()
  await runtime.reconcileOnce()
  await waitSettled(runtime)
  assert.equal(runtime.getRun('held').status, 'running')
  assert.equal(runtime.activeCount(), 1)
  await runtime.shutdown()
})

test('hydrated historical local run is lost after restart, not reserved forever', async () => {
  const ledger = new MemoryLedger([dispatchLocal('hist'), started('hist')])
  const { runtime } = createLocalRuntime({
    ledger,
    liveSet: new Set(),
    probeRun: async (run) => probeLocalRun({ run, liveSet: new Set(), afterRestart: true }),
  })
  await runtime.hydrate()
  assert.equal(runtime.getRun('hist').status, 'running')
  assert.equal(runtime.heldLocalRuns.has('hist'), false)
  assert.equal(runtime.activeCount(), 1)
  await runtime.reconcileOnce()
  await waitSettled(runtime)
  assert.equal(runtime.getRun('hist').status, 'lost')
  assert.equal(runtime.activeCount(), 0)
  await runtime.shutdown()
})

test('cancel of a live local run keeps its slot until cleanup confirms cancellation', async () => {
  const { runtime, liveSet, ledger } = createLocalRuntime()
  await runtime.registerDispatch({ ...dispatchLocal('c1'), item: 'cancel me' })
  await runtime.markStart('c1', { startedAt: 1000 })
  liveSet.add('c1')
  let aborted = false
  runtime.controllerForRun('c1').signal.addEventListener('abort', () => { aborted = true }, { once: true })
  const result = await runtime.cancelRun('c1', 'ui cancel')
  await waitSettled(runtime)
  assert.equal(result.cancelled, false)
  assert.equal(result.pending, true)
  assert.equal(result.run.status, 'detached')
  assert.equal(aborted, true)
  assert.equal(runtime.activeCount(), 1)
  await runtime.reconcileOnce()
  assert.equal(terminalEvents(ledger).length, 0)
  liveSet.delete('c1')
  await runtime.confirmRemoteCancelled('c1', 'ui cancel')
  assert.equal(runtime.activeCount(), 0)
  await runtime.reconcileOnce()
  await waitSettled(runtime)
  assert.equal(runtime.getRun('c1').status, 'cancelled')
  assert.equal(terminalEvents(ledger).length, 1)
  assert.equal(ledger.events.filter((event) => event.ev === 'cancel').length, 1)
  await runtime.shutdown()
})

test('local timeout aborts once and retains the slot until runner cleanup settles TIMEOUT', async () => {
  let now = 200
  const ledger = new MemoryLedger()
  const liveSet = new Set()
  const runtime = createFleetRuntime({
    ledger,
    now: () => now,
    reconcileIntervalMs: 5,
    isLocalRun: (run) => run.host === 'local',
    hasLiveController: (run) => liveSet.has(run.runId),
    probeRun: async () => ({ ok: true, out: 'MISSING' }),
  })
  await runtime.registerDispatch({ ...dispatchLocal('late', { timeoutMs: 50 }), item: 'late' })
  await runtime.markStart('late', { startedAt: 200, timeoutMs: 50 })
  liveSet.add('late')
  now = 300
  let aborted = false
  runtime.controllerForRun('late').signal.addEventListener('abort', () => { aborted = true }, { once: true })
  await runtime.reconcileOnce()
  await waitSettled(runtime)
  const run = runtime.getRun('late')
  assert.equal(run.status, 'detached')
  assert.equal(run.timeoutPending, true)
  assert.equal(aborted, true)
  assert.equal(runtime.activeCount(), 1)
  assert.equal(TERMINAL_RUN_STATUSES.has(run.status), false)
  await runtime.reconcileOnce()
  assert.equal(terminalEvents(ledger).length, 0)
  liveSet.delete('late')
  await runtime.markEnd('late', { ok: false, error: 'TIMEOUT' })
  assert.equal(runtime.activeCount(), 0)
  await runtime.reconcileOnce()
  await waitSettled(runtime)
  assert.equal(runtime.getRun('late').status, 'failed')
  assert.equal(ledger.events.filter((event) => event.ev === 'end').length, 1)
  assert.equal(ledger.events.some((event) => event.ev === 'cancel'), false)
  await runtime.shutdown()
})

test('normal complete and reconcile do not double-settle or leak a slot', async () => {
  const { runtime, liveSet, ledger } = createLocalRuntime()
  await runtime.registerDispatch({ ...dispatchLocal('done'), item: 'done' })
  await runtime.markStart('done', { startedAt: 1000 })
  liveSet.add('done')
  const [ended] = await Promise.all([
    runtime.markEnd('done', { ok: true, resultText: 'ok' }),
    runtime.reconcileOnce(),
  ])
  liveSet.delete('done')
  await waitSettled(runtime)
  assert.equal(ended.status, 'completed')
  assert.equal(runtime.getRun('done').status, 'completed')
  assert.equal(runtime.activeCount(), 0)
  assert.equal(ledger.events.filter((event) => event.ev === 'end').length, 1)
  assert.equal(terminalEvents(ledger).length, 1)
  await runtime.shutdown()
})

test('bare runtime shutdown models process loss; plugin must separately drain its local runners', async () => {
  const ledger = new MemoryLedger()
  const liveSet = new Set()
  const first = createFleetRuntime({
    ledger,
    now: () => 1000,
    isLocalRun: (run) => run.host === 'local',
    hasLiveController: (run) => liveSet.has(run.runId),
    probeRun: async () => ({ ok: true, out: 'MISSING' }),
  })
  await first.registerDispatch({ ...dispatchLocal('orphan'), item: 'orphan' })
  await first.markStart('orphan', { startedAt: 1000 })
  liveSet.add('orphan')
  const signal = first.controllerForRun('orphan').signal
  await first.shutdown()
  await waitSettled(first)
  assert.equal(signal.aborted, false, 'dispose must not mark a still-running local task cancelled')
  assert.equal(first.getRun('orphan').status, 'running')
  assert.equal(ledger.events.some((event) => event.ev === 'cancel'), false)

  liveSet.clear()
  const restored = createFleetRuntime({
    ledger,
    now: () => 2000,
    isLocalRun: (run) => run.host === 'local',
    hasLiveController: () => false,
    probeRun: async (run) => probeLocalRun({ run, liveSet: new Set(), afterRestart: true }),
  })
  await restored.hydrate()
  await restored.reconcileOnce()
  await waitSettled(restored)
  assert.equal(restored.getRun('orphan').status, 'lost')
  assert.equal(restored.activeCount(), 0)
  assert.equal(ledger.events.filter((event) => event.ev === 'cancel').length, 0)
  assert.equal(ledger.events.filter((event) => event.ev === 'reattach' && event.state === 'lost').length, 1)
  await restored.shutdown()
})
