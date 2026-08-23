import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  FleetPowerError,
  SMOKE_TTL_MS,
  createFleetPower,
  reducePowerLedger,
} from '../lib/fleet-power.mjs'

const tick = () => new Promise((resolve) => setImmediate(resolve))

function closingChild(code = 0, stderr = '') {
  const child = new EventEmitter()
  child.stderr = new EventEmitter()
  queueMicrotask(() => {
    if (stderr) child.stderr.emit('data', stderr)
    child.emit('close', code)
  })
  return child
}

function baseOptions(overrides = {}) {
  return {
    powerNodes: { worker: 'node-a', guarded: 'node-g' },
    wakeGateway: 'root@gateway.invalid',
    wakeCommand: '/opt/fleet-wake',
    sleepCommand: '/opt/fleetpower',
    wakeBudgetMs: { 'node-a': 20_000, 'node-g': 20_000, _default: 30_000 },
    wakePollMs: 5000,
    sleepAllowedHosts: ['worker'],
    runSmoke: async () => ({ ok: true }),
    probeHost: async () => ({ ok: false, error: 'offline' }),
    appendLedger: async () => {},
    getInflight: () => 0,
    spawnProcess: () => closingChild(0),
    ...overrides,
  }
}

test('power state keeps reachability, wake, smoke, and sleep orthogonal', async () => {
  let clock = 1000
  const events = []
  const manager = createFleetPower(baseOptions({
    now: () => clock,
    delay: async (ms) => { clock += ms },
    spawnProcess: () => closingChild(255),
    appendLedger: async (event) => { events.push(event) },
  }))

  const result = await manager.wakeHost('worker', { batchId: 'batch-1' })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'WAKE_GATEWAY_UNREACHABLE')
  assert.deepEqual(manager.stateOf('worker'), {
    host: 'worker', node: 'node-a',
    reachability: 'unreachable', reachabilityAt: 1000, reachabilityError: 'offline',
    wakeState: 'failed', wakeStartedAt: 1000, wakeDeadlineAt: 21000, wakeCode: 'WAKE_GATEWAY_UNREACHABLE',
    wakeError: 'WOL gateway unavailable: WOL gateway exit 255',
    smokeState: 'unknown', smokeAt: 0, smokeCode: null, smokeError: null,
    sleepState: 'awake', sleepError: null,
    wokenByBatchId: null, idleSleepEligible: false,
    reachable: false, etaMs: 0, guarded: false,
  })
  assert.deepEqual(events.map((event) => event.ev), ['wake', 'wake-failed'])
  assert.equal((await manager.waitForWake('worker')).code, 'WAKE_GATEWAY_UNREACHABLE')
})

test('independent wake joins one power-node flight; pinned dispatch gets 423 with ETA', async () => {
  let probes = 0
  let spawnCount = 0
  let releasePoll
  const manager = createFleetPower(baseOptions({
    probeHost: async () => ({ ok: ++probes > 1 }),
    delay: () => new Promise((resolve) => { releasePoll = resolve }),
    spawnProcess: () => { spawnCount++; return closingChild(0) },
  }))

  const first = manager.wakeHost('worker', { batchId: 'b1' })
  await tick()
  const duplicate = manager.wakeHost('worker', { batchId: 'b2' })
  assert.strictEqual(duplicate, first)
  assert.equal(spawnCount, 1)
  assert.throws(
    () => manager.prepareDispatchHost('worker', { pinned: true, batchId: 'b3' }),
    (error) => error instanceof FleetPowerError && error.statusCode === 423 && error.code === 'WAKE_IN_PROGRESS' && error.etaMs >= 0,
  )

  releasePoll()
  assert.equal((await first).ok, true)
  assert.equal(spawnCount, 1)
})

test('a power node without a wake path fails before any process is spawned', () => {
  let spawned = false
  const manager = createFleetPower(baseOptions({ spawnProcess: () => { spawned = true; return closingChild(0) } }))
  assert.throws(
    () => manager.wakeHost('unknown'),
    (error) => error.code === 'NO_WAKE_PATH' && error.statusCode === 409,
  )
  assert.equal(spawned, false)
})

test('one cancelled waiter does not cancel the shared power-node wake', async () => {
  let releasePoll
  let spawnCount = 0
  const aborter = new AbortController()
  const manager = createFleetPower(baseOptions({
    probeHost: async () => ({ ok: true }),
    delay: () => new Promise((resolve) => { releasePoll = resolve }),
    spawnProcess: () => { spawnCount++; return closingChild(0) },
  }))
  manager.setReachability('worker', { ok: false, error: 'offline' })
  const cancelledWaiter = manager.prepareDispatchHost('worker', {
    batchId: 'b1', source: 'ui', signal: aborter.signal, skipInitialProbe: true,
  })
  await tick()
  const survivingWaiter = manager.wakeHost('worker')
  aborter.abort(new Error('batch cancelled'))
  await assert.rejects(cancelledWaiter, /batch cancelled/)
  releasePoll()
  assert.equal((await survivingWaiter).ok, true)
  assert.equal(spawnCount, 1)
})

test('concurrent reachability checks are singleflight per host', async () => {
  let calls = 0
  let release
  const manager = createFleetPower(baseOptions({
    probeHost: () => new Promise((resolve) => { calls++; release = resolve }),
  }))
  const first = manager.probe('worker')
  const second = manager.probe('worker')
  assert.strictEqual(first, second)
  await tick()
  release({ ok: true })
  assert.equal((await first).ok, true)
  assert.equal(calls, 1)
})

test('dispatch adapter returns after durable launch and leaves probe/smoke on the flight', async () => {
  const events = []
  const calls = []
  let releasePoll
  const manager = createFleetPower(baseOptions({
    probeHost: async () => ({ ok: true }),
    appendLedger: async (event) => { events.push(event) },
    delay: () => new Promise((resolve) => { releasePoll = resolve }),
    spawnProcess: (command, args) => { calls.push({ command, args }); return closingChild(0) },
  }))
  manager.setReachability('worker', { ok: false, error: 'offline' })
  manager.setReachability('guarded', { ok: true })

  const summary = await manager.request(['worker', 'guarded', 'missing'], { batchId: 'b1', pinned: true, source: 'ui' })
  assert.deepEqual(summary, {
    requested: ['worker'],
    alreadyUp: ['guarded'],
    noWakePath: ['missing'],
    budgetMs: { worker: 20_000 },
  })
  assert.equal(calls.length, 1)
  assert.deepEqual(events.map((event) => event.ev), ['wake'])
  assert.equal(events[0].source, 'ui')
  assert.equal(manager.state('worker').wakeState, 'waking')
  assert.equal(manager.canWake('worker'), true)
  assert.equal(manager.canWake('missing'), false)

  const completion = manager.waitForWake('worker')
  releasePoll()
  assert.equal((await completion).ok, true)
})

test('dispatch request does not acknowledge before the wake ledger barrier', async () => {
  let releaseLedger
  let spawned = 0
  const manager = createFleetPower(baseOptions({
    appendLedger: () => new Promise((resolve) => { releaseLedger = resolve }),
    delay: () => new Promise(() => {}),
    spawnProcess: () => { spawned++; return closingChild(0) },
  }))
  manager.setReachability('worker', { ok: false, error: 'offline' })
  let acknowledged = false
  const request = manager.request(['worker'], { batchId: 'b1', pinned: true, source: 'ui' }).then((value) => {
    acknowledged = true
    return value
  })
  await tick()
  assert.equal(acknowledged, false)
  assert.equal(spawned, 0)
  releaseLedger()
  assert.deepEqual((await request).requested, ['worker'])
  assert.equal(spawned, 1)
})

test('wake fails closed before spawn when its durable ledger is unavailable', async () => {
  let spawned = 0
  const manager = createFleetPower(baseOptions({
    appendLedger: async () => { throw new Error('disk full') },
    spawnProcess: () => { spawned++; return closingChild(0) },
  }))
  await assert.rejects(manager.wakeHost('worker'), (error) => error.code === 'WAKE_LEDGER_FAILED' && error.statusCode === 503)
  assert.equal(spawned, 0)
  assert.equal(manager.state('worker').wakeState, 'failed')
})

test('a probe that reports ready after the wake deadline is still a timeout', async () => {
  let clock = 0
  let killed = 0
  const manager = createFleetPower(baseOptions({
    wakeBudgetMs: { 'node-a': 5, _default: 5 },
    wakePollMs: 1,
    now: () => clock,
    delay: async (ms) => { clock += ms },
    probeHost: async () => { clock += 10; return { ok: true } },
    spawnProcess: () => { const child = closingChild(0); child.kill = () => { killed++ }; return child },
  }))
  manager.setReachability('worker', { ok: false, error: 'offline' })
  await manager.request(['worker'], { batchId: 'b1', source: 'ui' })
  const result = await manager.waitForWake('worker')
  assert.equal(result.ok, false)
  assert.equal(result.code, 'WAKE_TIMEOUT')
  assert.equal(killed, 1)
})

test('missing smoke runner fails closed instead of silently skipping the gate', async () => {
  const manager = createFleetPower(baseOptions({ runSmoke: undefined }))
  const result = await manager.runSmokeCheck('worker')
  assert.equal(result.ok, false)
  assert.equal(result.code, 'SMOKE_UNAVAILABLE')
  assert.equal(manager.state('worker').smokeState, 'failed')
})

test('smoke result is singleflight and cached for six hours', async () => {
  let clock = 10_000
  let calls = 0
  let release
  const manager = createFleetPower(baseOptions({
    now: () => clock,
    runSmoke: () => new Promise((resolve) => { calls++; release = resolve }),
  }))

  const first = manager.runSmokeCheck('worker')
  const joined = manager.runSmokeCheck('worker')
  release({ ok: true })
  const [firstResult, joinedResult] = await Promise.all([first, joined])
  assert.equal(firstResult.ok, true)
  assert.equal(joinedResult.ok, true)
  assert.equal((await manager.runSmokeCheck('worker')).cached, true)
  assert.equal(calls, 1)
  clock += SMOKE_TTL_MS + 1
  const expired = manager.runSmokeCheck('worker')
  release({ ok: true })
  assert.equal((await expired).cached, false)
  assert.equal(calls, 2)
})

test('ledger replay restores wake ownership and sleep eligibility without inventing reachability', () => {
  const states = reducePowerLedger([
    { ev: 'wake', at: 10, host: 'worker', node: 'node-a', batchId: 'b1', deadlineAt: 50 },
    { ev: 'wake-ready', at: 20, host: 'worker', batchId: 'b1' },
    { ev: 'smoke', at: 21, host: 'worker', ok: true },
    { ev: 'sleep-eligible', at: 30, host: 'worker', batchId: 'b1' },
  ], { worker: 'node-a' })
  const state = states.get('worker')
  assert.equal(state.reachability, 'unknown')
  assert.equal(state.wakeState, 'awake')
  assert.equal(state.smokeState, 'passed')
  assert.equal(state.sleepState, 'eligible')
  assert.equal(state.wokenByBatchId, 'b1')
  assert.equal(state.idleSleepEligible, true)
})

test('an expired restored wake normalizes to timeout instead of permanent waking', () => {
  const manager = createFleetPower(baseOptions({
    now: () => 100,
    restoredEvents: [{ ev: 'wake', at: 10, host: 'worker', batchId: 'b1', deadlineAt: 50 }],
  }))
  const state = manager.state('worker')
  assert.equal(state.wakeState, 'timed-out')
  assert.equal(state.wakeError, 'WAKE_TIMEOUT')
  assert.equal(state.etaMs, 0)
  assert.equal(manager.wakeInFlight('worker'), null)
})

test('sleep eligibility is committed in memory only after its ledger event', async () => {
  const manager = createFleetPower(baseOptions({
    restoredEvents: [
      { ev: 'wake', at: 10, host: 'worker', batchId: 'b1', source: 'ui' },
      { ev: 'wake-ready', at: 20, host: 'worker', batchId: 'b1', source: 'ui' },
    ],
    appendLedger: async () => { throw new Error('disk full') },
  }))
  await assert.rejects(manager.markIdleSleepEligible('worker', { batchId: 'b1' }), /disk full/)
  assert.equal(manager.state('worker').idleSleepEligible, false)
  assert.equal(manager.state('worker').sleepState, 'awake')
})

test('sleep is fail-closed for confirmation, allowlist, activity, and wake evidence', async () => {
  const restoredEvents = [
    { ev: 'wake', at: 10, host: 'worker', batchId: 'b1' },
    { ev: 'wake-ready', at: 20, host: 'worker', batchId: 'b1' },
    { ev: 'sleep-eligible', at: 30, host: 'worker', batchId: 'b1' },
  ]
  const manager = createFleetPower(baseOptions({ restoredEvents, getInflight: () => 1 }))
  await assert.rejects(manager.sleepHost('worker', {}), (error) => error.code === 'CONFIRM_REQUIRED' && error.statusCode === 400)
  await assert.rejects(manager.sleepHost('guarded', { confirm: 'SLEEP' }), (error) => error.code === 'SLEEP_GUARDED' && error.statusCode === 409)
  await assert.rejects(manager.sleepHost('worker', { confirm: 'SLEEP' }), (error) => error.code === 'HOST_BUSY' && error.statusCode === 409)

  const noEvidence = createFleetPower(baseOptions())
  await assert.rejects(noEvidence.sleepHost('worker', { confirm: 'SLEEP' }), (error) => error.code === 'NO_WAKE_EVIDENCE')

  const emptyAllowlist = createFleetPower(baseOptions({ sleepAllowedHosts: undefined, restoredEvents }))
  await assert.rejects(emptyAllowlist.sleepHost('worker', { confirm: 'SLEEP' }), (error) => error.code === 'SLEEP_GUARDED')
})

test('sleep rechecks busy state inside the host power lock', async () => {
  let checks = 0
  let spawnCount = 0
  const manager = createFleetPower(baseOptions({
    restoredEvents: [
      { ev: 'wake', at: 10, host: 'worker', batchId: 'b1' },
      { ev: 'wake-ready', at: 20, host: 'worker', batchId: 'b1' },
      { ev: 'sleep-eligible', at: 30, host: 'worker', batchId: 'b1' },
    ],
    getInflight: () => ++checks === 1 ? 0 : 1,
    spawnProcess: () => { spawnCount++; return closingChild(0) },
  }))
  manager.setReachability('worker', { ok: true })

  await assert.rejects(manager.sleepHost('worker', { confirm: 'SLEEP' }), (error) => error.code === 'HOST_BUSY')
  assert.equal(spawnCount, 0)
  assert.equal(manager.stateOf('worker').sleepState, 'eligible')
})

test('sleep re-probes reachability while holding the power lock', async () => {
  let spawned = 0
  const manager = createFleetPower(baseOptions({
    restoredEvents: [
      { ev: 'wake', at: 10, host: 'worker', batchId: 'b1', source: 'ui' },
      { ev: 'wake-ready', at: 20, host: 'worker', batchId: 'b1', source: 'ui' },
      { ev: 'sleep-eligible', at: 30, host: 'worker', batchId: 'b1' },
    ],
    probeHost: async () => ({ ok: false, error: 'stale cache' }),
    spawnProcess: () => { spawned++; return closingChild(0) },
  }))
  manager.setReachability('worker', { ok: true })
  await assert.rejects(manager.sleepHost('worker', { confirm: 'SLEEP' }), (error) => error.code === 'HOST_UNREACHABLE')
  assert.equal(spawned, 0)
  assert.equal(manager.state('worker').reachability, 'unreachable')
})

test('eligible host sleeps with fixed argv and never exposes force', async () => {
  const calls = []
  const events = []
  const manager = createFleetPower(baseOptions({
    restoredEvents: [
      { ev: 'wake', at: 10, host: 'worker', batchId: 'b1' },
      { ev: 'wake-ready', at: 20, host: 'worker', batchId: 'b1' },
      { ev: 'sleep-eligible', at: 30, host: 'worker', batchId: 'b1' },
    ],
    sshArgs: ['-o', 'BatchMode=yes'],
    probeHost: async () => ({ ok: true }),
    appendLedger: async (event) => { events.push(event) },
    spawnProcess: (command, args, options) => {
      calls.push({ command, args, options })
      return closingChild(0)
    },
  }))
  manager.setReachability('worker', { ok: true })

  assert.deepEqual(await manager.sleepHost('worker', { confirm: 'SLEEP' }), { ok: true, host: 'worker', node: 'node-a', ledgerPersisted: true })
  assert.equal(calls[0].command, '/opt/fleetpower')
  assert.deepEqual(calls[0].args, ['off', 'node-a'])
  assert.equal(calls[0].args.includes('--force'), false)
  assert.deepEqual(events.map((event) => event.ev), ['sleep', 'sleep-end'])
  assert.equal(manager.stateOf('worker').sleepState, 'sleeping')
  assert.equal(manager.stateOf('worker').wokenByBatchId, null)
})

test('successful sleep command stays successful when only the terminal ledger write fails', async () => {
  let appends = 0
  let spawned = 0
  const manager = createFleetPower(baseOptions({
    restoredEvents: [
      { ev: 'wake', at: 10, host: 'worker', batchId: 'b1', source: 'ui' },
      { ev: 'wake-ready', at: 20, host: 'worker', batchId: 'b1', source: 'ui' },
      { ev: 'sleep-eligible', at: 30, host: 'worker', batchId: 'b1' },
    ],
    probeHost: async () => ({ ok: true }),
    appendLedger: async () => { if (++appends === 2) throw new Error('disk full') },
    spawnProcess: () => { spawned++; return closingChild(0) },
  }))
  manager.setReachability('worker', { ok: true })
  const result = await manager.sleepHost('worker', { confirm: 'SLEEP' })
  assert.equal(result.ok, true)
  assert.equal(result.ledgerPersisted, false)
  assert.match(result.ledgerError, /disk full/)
  assert.equal(spawned, 1)
  assert.equal(manager.state('worker').sleepState, 'sleeping')
})

test('dispatch and sleep callers share a per-host FIFO power lock', async () => {
  const manager = createFleetPower(baseOptions())
  const order = []
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const first = manager.withDispatchPowerLock('worker', async () => {
    order.push('dispatch-start')
    await gate
    order.push('dispatch-end')
  })
  const second = manager.withHostPowerLock('worker', async () => { order.push('sleep') })
  await tick()
  assert.deepEqual(order, ['dispatch-start'])
  release()
  await Promise.all([first, second])
  assert.deepEqual(order, ['dispatch-start', 'dispatch-end', 'sleep'])
})

test('wake polling is an awaited loop, never an interval', () => {
  const source = readFileSync(new URL('../lib/fleet-power.mjs', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /setInterval\s*\(/)
})
