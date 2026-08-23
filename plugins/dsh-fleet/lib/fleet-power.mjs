import { spawn as nodeSpawn } from 'node:child_process'

export const SMOKE_TTL_MS = 6 * 60 * 60 * 1000

export class FleetPowerError extends Error {
  constructor(code, message, statusCode, detail = {}) {
    super(message)
    this.name = 'FleetPowerError'
    this.code = code
    this.statusCode = statusCode
    Object.assign(this, detail)
  }
}

const delayWithSignal = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) {
    reject(signal.reason ?? new Error('aborted'))
    return
  }
  const timer = setTimeout(resolve, Math.max(0, ms))
  signal?.addEventListener?.('abort', () => {
    clearTimeout(timer)
    reject(signal.reason ?? new Error('aborted'))
  }, { once: true })
})

const initialState = (host, node = null) => ({
  host,
  node,
  reachability: 'unknown',
  reachabilityAt: 0,
  reachabilityError: null,
  wakeState: 'idle',
  wakeStartedAt: 0,
  wakeDeadlineAt: 0,
  wakeCode: null,
  wakeError: null,
  smokeState: 'unknown',
  smokeAt: 0,
  smokeCode: null,
  smokeError: null,
  sleepState: 'awake',
  sleepError: null,
  wokenByBatchId: null,
  idleSleepEligible: false,
})

const errorText = (error) => String(error?.message ?? error ?? 'unknown error').slice(0, 500)
const isDispatchWake = (event) => Boolean(event?.batchId) && !['wake', 'manual', 'independent'].includes(String(event?.source || 'dispatch'))

/**
 * Restore only the durable power facts. Reachability is deliberately not
 * inferred from a power event: only a fresh SSH probe can establish it.
 */
export function reducePowerLedger(events, powerNodes = {}) {
  const states = new Map()
  const stateOf = (host) => {
    if (!states.has(host)) states.set(host, initialState(host, powerNodes[host] ?? null))
    return states.get(host)
  }

  for (const event of Array.isArray(events) ? events : []) {
    const host = typeof event?.host === 'string' ? event.host : ''
    if (!host) continue
    const state = stateOf(host)
    const at = Number(event.at) || 0
    switch (event.ev) {
      case 'wake':
        state.wakeState = 'waking'
        state.wakeStartedAt = at
        state.wakeDeadlineAt = Number(event.deadlineAt) || 0
        state.wakeError = null
        state.wakeCode = null
        state.wokenByBatchId = null
        state.idleSleepEligible = false
        state.sleepState = 'awake'
        break
      case 'wake-ready':
      case 'wake_ok':
        state.wakeState = 'awake'
        state.wakeError = null
        state.wakeCode = null
        if (isDispatchWake(event)) state.wokenByBatchId = event.batchId
        break
      case 'wake-timeout':
        state.wakeState = 'timed-out'
        state.wakeCode = 'WAKE_TIMEOUT'
        state.wakeError = event.error || 'WAKE_TIMEOUT'
        state.idleSleepEligible = false
        break
      case 'wake-failed':
        state.wakeState = 'failed'
        state.wakeCode = event.code || 'WAKE_FAILED'
        state.wakeError = event.error || 'WAKE_FAILED'
        state.idleSleepEligible = false
        break
      case 'smoke':
      case 'smoke-end':
        state.smokeState = event.ok === true ? 'passed' : 'failed'
        state.smokeAt = at
        state.smokeCode = event.ok === true ? null : (event.code || 'SMOKE_FAILED')
        state.smokeError = event.ok === true ? null : (event.error || 'SMOKE_FAILED')
        break
      case 'dispatch':
      case 'start':
        state.idleSleepEligible = false
        if (state.sleepState === 'eligible') state.sleepState = 'awake'
        break
      case 'sleep-eligible':
        if (event.batchId && state.wokenByBatchId && event.batchId === state.wokenByBatchId) {
          state.idleSleepEligible = true
          state.sleepState = 'eligible'
        }
        break
      case 'sleep':
        state.sleepState = 'sleeping'
        state.sleepError = null
        state.idleSleepEligible = false
        break
      case 'sleep-end':
        // A successful command proves only that the request was accepted;
        // reachability remains authoritative for whether the host went down.
        state.sleepState = event.ok === true ? 'sleeping' : 'failed'
        state.sleepError = event.ok === true ? null : (event.error || 'SLEEP_FAILED')
        if (event.ok === true) {
          state.idleSleepEligible = false
          state.wokenByBatchId = null
          state.wakeState = 'idle'
          state.wakeCode = null
        }
        break
      default:
        break
    }
  }
  return states
}

/**
 * Pure, dependency-injected WOL/smoke/sleep coordinator. Calling it performs
 * no I/O; every external action happens only through an explicit method.
 */
export function createFleetPower(options = {}) {
  const {
    powerNodes = {},
    wakeGateway = '',
    wakeCommand = '',
    sleepCommand = '',
    wakeBudgetMs = {},
    wakePollMs = 5000,
    smokeTtlMs = SMOKE_TTL_MS,
    sleepAllowedHosts = [],
    probeHost,
    runSmoke,
    appendLedger = async () => {},
    getInflight = () => 0,
    spawnProcess = nodeSpawn,
    sshBin = 'ssh',
    sshArgs = [],
    now = () => Date.now(),
    delay = delayWithSignal,
    restoredEvents = [],
  } = options

  if (typeof probeHost !== 'function') throw new TypeError('probeHost is required')
  if (typeof appendLedger !== 'function') throw new TypeError('appendLedger must be a function')
  if (typeof getInflight !== 'function') throw new TypeError('getInflight must be a function')

  const allowed = new Set(Array.isArray(sleepAllowedHosts) ? sleepAllowedHosts : [])
  const stateByHost = reducePowerLedger(restoredEvents, powerNodes)
  const wakeFlights = new Map() // power node -> { promise, host, startedAt, deadlineAt }
  const smokeFlights = new Map() // host -> Promise
  const probeFlights = new Map() // host -> Promise
  const hostLocks = new Map() // host -> tail Promise

  const stateOf = (host) => {
    const name = String(host || '')
    if (!stateByHost.has(name)) stateByHost.set(name, initialState(name, powerNodes[name] ?? null))
    const state = stateByHost.get(name)
    state.node = powerNodes[name] ?? null
    // A restored wake without a terminal event cannot stay truthfully
    // "waking" after its wall-clock deadline has passed.
    if (state.wakeState === 'waking' && state.wakeDeadlineAt < now()) {
      state.wakeState = 'timed-out'
      state.wakeCode = 'WAKE_TIMEOUT'
      state.wakeError = 'WAKE_TIMEOUT'
      state.idleSleepEligible = false
    }
    return state
  }

  const snapshot = (host) => {
    const state = stateOf(host)
    return Object.freeze({
      ...state,
      reachable: state.reachability === 'reachable',
      etaMs: state.wakeState === 'waking' ? Math.max(0, state.wakeDeadlineAt - now()) : 0,
      guarded: !allowed.has(String(host)),
    })
  }

  const append = async (event) => {
    await appendLedger({ v: 1, at: now(), ...event })
  }

  const withHostPowerLock = async (host, operation) => {
    if (typeof operation !== 'function') throw new TypeError('operation must be a function')
    const name = String(host || '')
    const previous = hostLocks.get(name) || Promise.resolve()
    let release
    const gate = new Promise((resolve) => { release = resolve })
    const tail = previous.catch(() => {}).then(() => gate)
    hostLocks.set(name, tail)
    await previous.catch(() => {})
    try {
      return await operation()
    } finally {
      release()
      if (hostLocks.get(name) === tail) hostLocks.delete(name)
    }
  }

  const setReachability = (host, result) => {
    const state = stateOf(host)
    state.reachabilityAt = now()
    state.reachability = result?.ok === true ? 'reachable' : 'unreachable'
    state.reachabilityError = result?.ok === true ? null : (result?.error || 'probe failed')
    return result?.ok === true
      ? { ok: true, ...result }
      : { ok: false, error: state.reachabilityError, ...result }
  }

  const recordProbe = async (host, probePromise) => {
    try {
      const result = await probePromise
      return setReachability(host, result)
    } catch (error) {
      return setReachability(host, { ok: false, error: errorText(error) })
    }
  }

  const probe = (host) => {
    const name = String(host || '')
    if (probeFlights.has(name)) return probeFlights.get(name)
    const flight = recordProbe(name, Promise.resolve().then(() => probeHost(name, { refresh: true }))).finally(() => {
      if (probeFlights.get(name) === flight) probeFlights.delete(name)
    })
    probeFlights.set(name, flight)
    return flight
  }

  const runSmokeCheck = async (host, { force = false, signal } = {}) => {
    const name = String(host || '')
    const state = stateOf(name)
    if (typeof runSmoke !== 'function') {
      state.smokeAt = now()
      state.smokeState = 'failed'
      state.smokeCode = 'SMOKE_UNAVAILABLE'
      state.smokeError = 'smoke runner is not configured'
      await append({ ev: 'smoke', host: name, ok: false, code: state.smokeCode, error: state.smokeError })
      return { ok: false, skipped: true, code: state.smokeCode, error: state.smokeError }
    }
    if (!force && state.smokeAt && now() - state.smokeAt < smokeTtlMs && (state.smokeState === 'passed' || state.smokeState === 'failed')) {
      return { ok: state.smokeState === 'passed', cached: true, code: state.smokeCode, error: state.smokeError }
    }
    if (smokeFlights.has(name)) return smokeFlights.get(name)
    state.smokeState = 'running'
    state.smokeError = null
    const flight = (async () => {
      let result
      try {
        result = await runSmoke(name, { signal })
      } catch (error) {
        result = { ok: false, error: errorText(error) }
      }
      state.smokeAt = now()
      state.smokeState = result?.ok === true ? 'passed' : 'failed'
      state.smokeCode = result?.ok === true ? null : (result?.code || 'SMOKE_FAILED')
      state.smokeError = result?.ok === true ? null : (result?.error || 'SMOKE_FAILED')
      await append({ ev: 'smoke', host: name, ok: result?.ok === true, code: state.smokeCode, error: state.smokeError })
      return { ok: result?.ok === true, cached: false, code: state.smokeCode, error: state.smokeError, result }
    })().finally(() => {
      if (smokeFlights.get(name) === flight) smokeFlights.delete(name)
    })
    smokeFlights.set(name, flight)
    return flight
  }

  const spawnWake = (host, node) => {
    if (!wakeGateway || !wakeCommand) {
      throw new FleetPowerError('WAKE_UNAVAILABLE', 'WOL gateway or command is not configured', 503)
    }
    const args = [...sshArgs, wakeGateway, wakeCommand, node]
    const child = spawnProcess(sshBin, args, { stdio: ['ignore', 'ignore', 'ignore'] })
    let commandError = null
    let rejectFailure
    const failure = new Promise((_, reject) => { rejectFailure = reject })
    // A handler is attached immediately, so a later rejection is never an
    // unhandled promise even when the probe wins the race.
    failure.catch(() => {})
    const fail = (error) => {
      if (commandError) return
      commandError = error instanceof Error ? error : new Error(String(error))
      rejectFailure(commandError)
    }
    child.once?.('error', fail)
    child.once?.('close', (code) => {
      if (code !== 0) fail(new Error('WOL gateway exit ' + code))
    })
    return { child, args, failure, getError: () => commandError }
  }

  const wakeSequence = async (host, node, { batchId = null, source = 'wake', signal, skipInitialProbe = false, onStarted = () => {} } = {}) => {
    const state = stateOf(host)
    if (!skipInitialProbe) {
      const firstProbe = await probe(host)
      if (firstProbe.ok) {
        state.wakeState = 'awake'
        state.wakeCode = null
        state.wakeError = null
        onStarted()
        return { ok: true, host, node, alreadyUp: true, smoke: null }
      }
    }

    const budget = Number(wakeBudgetMs[node] ?? wakeBudgetMs._default)
    if (!Number.isFinite(budget) || budget <= 0) {
      throw new FleetPowerError('WAKE_BUDGET_MISSING', 'No positive wake budget for ' + node, 503)
    }
    state.wakeState = 'waking'
    state.wakeStartedAt = now()
    state.wakeDeadlineAt = state.wakeStartedAt + budget
    state.wakeCode = null
    state.wakeError = null
    state.wokenByBatchId = null
    state.idleSleepEligible = false
    state.sleepState = 'awake'
    try {
      await append({ ev: 'wake', host, node, batchId: batchId || undefined, source, deadlineAt: state.wakeDeadlineAt })
    } catch (error) {
      state.wakeState = 'failed'
      state.wakeCode = 'WAKE_LEDGER_FAILED'
      state.wakeError = 'wake ledger unavailable: ' + errorText(error)
      throw new FleetPowerError('WAKE_LEDGER_FAILED', state.wakeError, 503, { host, node })
    }

    let command
    try {
      command = spawnWake(host, node)
      onStarted()
    } catch (error) {
      state.wakeState = 'failed'
      state.wakeCode = error?.code || 'WAKE_UNAVAILABLE'
      state.wakeError = errorText(error)
      await append({ ev: 'wake-failed', host, node, batchId: batchId || undefined, code: state.wakeCode, error: state.wakeError })
      onStarted()
      throw error
    }

    while (now() <= state.wakeDeadlineAt) {
      const remainingMs = state.wakeDeadlineAt - now()
      if (remainingMs < 0) break
      try {
        await Promise.race([delay(Math.max(0, Math.min(Number(wakePollMs) || 1, remainingMs)), signal), command.failure])
      } catch (error) {
        if (signal?.aborted) throw error
        state.wakeState = 'failed'
        state.wakeCode = 'WAKE_GATEWAY_UNREACHABLE'
        state.wakeError = 'WOL gateway unavailable: ' + errorText(error)
        await append({ ev: 'wake-failed', host, node, batchId: batchId || undefined, code: state.wakeCode, error: state.wakeError })
        return { ok: false, host, node, code: 'WAKE_GATEWAY_UNREACHABLE', error: state.wakeError }
      }
      if (command.getError()) {
        state.wakeState = 'failed'
        state.wakeCode = 'WAKE_GATEWAY_UNREACHABLE'
        state.wakeError = 'WOL gateway unavailable: ' + errorText(command.getError())
        await append({ ev: 'wake-failed', host, node, batchId: batchId || undefined, code: state.wakeCode, error: state.wakeError })
        return { ok: false, host, node, code: 'WAKE_GATEWAY_UNREACHABLE', error: state.wakeError }
      }
      const result = await probe(host)
      // A slow SSH handshake may finish after the wake budget. It must not
      // retroactively turn a timed-out wake into success.
      if (now() > state.wakeDeadlineAt) break
      if (!result.ok) {
        if (now() >= state.wakeDeadlineAt) break
        continue
      }
      state.wakeState = 'awake'
      state.wakeCode = null
      state.wakeError = null
      if (isDispatchWake({ batchId, source })) state.wokenByBatchId = batchId
      await append({ ev: 'wake-ready', host, node, batchId: batchId || undefined, source })
      const smoke = await runSmokeCheck(host, { signal })
      if (!smoke.ok) {
        return { ok: false, host, node, code: smoke.code || 'SMOKE_FAILED', error: smoke.error, smoke }
      }
      return { ok: true, host, node, alreadyUp: false, smoke }
    }

    state.wakeState = 'timed-out'
    state.wakeCode = 'WAKE_TIMEOUT'
    state.wakeError = 'WAKE_TIMEOUT'
    try { command.child?.kill?.('SIGTERM') } catch {}
    await append({ ev: 'wake-timeout', host, node, batchId: batchId || undefined, error: state.wakeError })
    return { ok: false, host, node, code: 'WAKE_TIMEOUT', error: state.wakeError }
  }

  const callerWaiter = (promise, signal) => {
    if (!signal) return promise
    if (signal.aborted) return Promise.reject(signal.reason ?? new Error('aborted'))
    return new Promise((resolve, reject) => {
      const onAbort = () => reject(signal.reason ?? new Error('aborted'))
      signal.addEventListener?.('abort', onAbort, { once: true })
      promise.then(
        (value) => { signal.removeEventListener?.('abort', onAbort); resolve(value) },
        (error) => { signal.removeEventListener?.('abort', onAbort); reject(error) },
      )
    })
  }

  const ensureAwake = (host, { batchId = null, source = 'wake', pinned = false, collision = pinned ? 'locked' : 'join', signal, skipInitialProbe = false } = {}) => {
    const name = String(host || '')
    const node = powerNodes[name]
    if (!node) throw new FleetPowerError('NO_WAKE_PATH', 'No WOL path for ' + name, 409, { host: name })
    const existing = wakeFlights.get(node)
    if (existing) {
      if (collision === 'locked') {
        const etaMs = Math.max(0, existing.deadlineAt - now())
        throw new FleetPowerError('WAKE_IN_PROGRESS', name + ' is waking', 423, { host: name, node, etaMs })
      }
      return callerWaiter(existing.promise, signal)
    }
    const restored = stateOf(name)
    if (collision === 'locked' && restored.wakeState === 'waking' && restored.wakeDeadlineAt > now()) {
      throw new FleetPowerError('WAKE_IN_PROGRESS', name + ' is waking', 423, {
        host: name,
        node,
        etaMs: Math.max(0, restored.wakeDeadlineAt - now()),
      })
    }

    const startedAt = now()
    const budget = Number(wakeBudgetMs[node] ?? wakeBudgetMs._default) || 0
    let resolveStarted
    let rejectStarted
    const flight = {
      host: name,
      node,
      startedAt,
      deadlineAt: startedAt + Math.max(0, budget),
      promise: null,
      started: new Promise((resolve, reject) => { resolveStarted = resolve; rejectStarted = reject }),
    }
    flight.started.catch(() => {})
    // The power-node flight is shared infrastructure. A caller cancellation
    // only detaches that caller's waiter; it never aborts WOL or other batches.
    flight.promise = wakeSequence(name, node, { batchId, source, skipInitialProbe, onStarted: resolveStarted }).catch((error) => {
      rejectStarted(error)
      throw error
    }).finally(() => {
      if (wakeFlights.get(node) === flight) wakeFlights.delete(node)
    })
    wakeFlights.set(node, flight)
    return callerWaiter(flight.promise, signal)
  }

  // Explicit wake is idempotent: repeat clicks join the same power-node flight.
  const wakeHost = (host, options = {}) => ensureAwake(host, { ...options, collision: 'join', pinned: false })

  // Dispatch retains the 423 contract for a pinned host already being woken.
  const prepareDispatchHost = (host, options = {}) => ensureAwake(host, {
    ...options,
    collision: options.pinned === true ? 'locked' : 'join',
  })

  const canWake = (host) => Boolean(powerNodes[String(host || '')] && wakeGateway && wakeCommand)

  // Dispatch adapter: after the caller has copied its authoritative probe
  // result through setReachability(), this waits only for the durable `wake`
  // event and process launch. Probe/smoke continue on the flight promise.
  const request = async (hosts, { batchId = null, pinned = false, source = 'dispatch' } = {}) => {
    const names = [...new Set((Array.isArray(hosts) ? hosts : []).map((host) => String(host || '')).filter(Boolean))]
    const summary = { requested: [], alreadyUp: [], noWakePath: [], budgetMs: {} }

    // Validate every pinned collision first, avoiding partial side effects.
    if (pinned) {
      for (const host of names) {
        const node = powerNodes[host]
        const flight = node ? wakeFlights.get(node) : null
        const state = stateOf(host)
        if (flight || (state.wakeState === 'waking' && state.wakeDeadlineAt > now())) {
          const deadlineAt = flight?.deadlineAt ?? state.wakeDeadlineAt
          throw new FleetPowerError('WAKE_IN_PROGRESS', host + ' is waking', 423, {
            host,
            node,
            etaMs: Math.max(0, deadlineAt - now()),
          })
        }
      }
    }

    const barriers = []
    for (const host of names) {
      const node = powerNodes[host]
      if (!canWake(host)) {
        summary.noWakePath.push(host)
        continue
      }
      if (stateOf(host).reachability === 'reachable') {
        stateOf(host).wakeState = 'awake'
        stateOf(host).wakeCode = null
        stateOf(host).wakeError = null
        summary.alreadyUp.push(host)
        continue
      }
      summary.requested.push(host)
      summary.budgetMs[host] = Number(wakeBudgetMs[node] ?? wakeBudgetMs._default) || 0
      const completion = prepareDispatchHost(host, { batchId, pinned, source, skipInitialProbe: true })
      // request intentionally does not await completion; retain a rejection
      // handler until the scheduler calls waitForWake().
      completion.catch(() => {})
      const flight = wakeFlights.get(node)
      if (flight) barriers.push(flight.started)
    }
    await Promise.all(barriers)
    return summary
  }

  const waitForWake = (host, { signal } = {}) => {
    const name = String(host || '')
    const flight = wakeFlights.get(powerNodes[name])
    if (flight) return callerWaiter(flight.promise, signal)
    const state = stateOf(name)
    if (state.smokeState === 'failed') return Promise.resolve({ ok: false, host: name, node: state.node, code: state.smokeCode || 'SMOKE_FAILED', error: state.smokeError })
    if (state.reachability === 'reachable' && state.wakeState === 'awake') return Promise.resolve({ ok: true, host: name, node: state.node, alreadyUp: true })
    return Promise.resolve({ ok: false, host: name, node: state.node, code: state.wakeCode || 'NO_WAKE_FLIGHT', error: state.wakeError || 'No wake flight' })
  }

  const markDispatchStarted = (host) => withHostPowerLock(host, async () => {
    const state = stateOf(host)
    state.idleSleepEligible = false
    if (state.sleepState === 'eligible') state.sleepState = 'awake'
    return snapshot(host)
  })

  const markIdleSleepEligible = (host, { batchId } = {}) => withHostPowerLock(host, async () => {
    const state = stateOf(host)
    if (!batchId || !state.wokenByBatchId || state.wokenByBatchId !== batchId) return false
    if (Number(await getInflight(host)) !== 0) return false
    await append({ ev: 'sleep-eligible', host: String(host), batchId: state.wokenByBatchId })
    state.idleSleepEligible = true
    state.sleepState = 'eligible'
    return true
  })

  const spawnAndWait = (command, args) => new Promise((resolve, reject) => {
    let child
    try {
      child = spawnProcess(command, args, { stdio: ['ignore', 'ignore', 'pipe'] })
    } catch (error) {
      reject(error)
      return
    }
    let err = ''
    child.stderr?.on?.('data', (chunk) => { if (err.length < 1000) err += String(chunk) })
    child.once?.('error', reject)
    child.once?.('close', (code) => {
      if (code === 0) resolve({ ok: true })
      else reject(new Error(err.trim() || ('power command exit ' + code)))
    })
  })

  const sleepHost = async (host, { confirm } = {}) => {
    const name = String(host || '')
    if (confirm !== 'SLEEP') throw new FleetPowerError('CONFIRM_REQUIRED', 'confirm must equal SLEEP', 400, { host: name })
    // Empty or missing allowlist intentionally denies every host.
    if (!allowed.has(name)) throw new FleetPowerError('SLEEP_GUARDED', 'Automatic sleep is not allowed for ' + name, 409, { host: name })
    if (!sleepCommand) throw new FleetPowerError('SLEEP_UNAVAILABLE', 'Sleep command is not configured', 503, { host: name })
    const node = powerNodes[name]
    if (!node) throw new FleetPowerError('NO_POWER_NODE', 'No power node for ' + name, 409, { host: name })

    const preState = stateOf(name)
    if (!preState.wokenByBatchId || !preState.idleSleepEligible) {
      throw new FleetPowerError('NO_WAKE_EVIDENCE', 'Host was not woken by an eligible fleet batch', 409, { host: name })
    }
    if (Number(await getInflight(name)) !== 0) throw new FleetPowerError('HOST_BUSY', name + ' is busy', 409, { host: name })
    if (preState.reachability !== 'reachable') throw new FleetPowerError('HOST_UNREACHABLE', name + ' is not reachable', 409, { host: name })

    return withHostPowerLock(name, async () => {
      // Re-read both evidence and activity under the same lock used by dispatch.
      const state = stateOf(name)
      if (!state.wokenByBatchId || !state.idleSleepEligible) {
        throw new FleetPowerError('NO_WAKE_EVIDENCE', 'Host is no longer sleep eligible', 409, { host: name })
      }
      if (Number(await getInflight(name)) !== 0) throw new FleetPowerError('HOST_BUSY', name + ' became busy', 409, { host: name })
      if (state.reachability !== 'reachable') throw new FleetPowerError('HOST_UNREACHABLE', name + ' is no longer reachable', 409, { host: name })
      const fresh = await probe(name)
      if (!fresh.ok) throw new FleetPowerError('HOST_UNREACHABLE', name + ' failed the locked reachability probe', 409, { host: name })

      const args = ['off', node]
      if (args.some((arg) => arg === '--force' || arg.startsWith('--force='))) {
        throw new FleetPowerError('UNSAFE_SLEEP_ARGV', 'force is forbidden', 500, { host: name })
      }
      state.sleepState = 'sleeping'
      state.sleepError = null
      try {
        await append({ ev: 'sleep', host: name, node, batchId: state.wokenByBatchId })
      } catch (error) {
        state.sleepState = 'eligible'
        state.sleepError = 'sleep ledger unavailable: ' + errorText(error)
        throw new FleetPowerError('SLEEP_LEDGER_FAILED', state.sleepError, 503, { host: name, node })
      }
      state.idleSleepEligible = false
      // There is deliberately no force option in this API or argv.
      try {
        await spawnAndWait(sleepCommand, args)
      } catch (error) {
        state.sleepState = 'failed'
        state.sleepError = errorText(error)
        try {
          await append({ ev: 'sleep-end', host: name, node, ok: false, error: state.sleepError })
          return { ok: false, host: name, node, error: state.sleepError, ledgerPersisted: true }
        } catch (ledgerError) {
          return { ok: false, host: name, node, error: state.sleepError, ledgerPersisted: false, ledgerError: errorText(ledgerError) }
        }
      }

      // The command succeeded. A later ledger failure must never be reported
      // as a command failure (which could provoke an unsafe duplicate retry).
      state.sleepState = 'sleeping'
      state.sleepError = null
      state.wokenByBatchId = null
      state.wakeState = 'idle'
      state.wakeCode = null
      try {
        await append({ ev: 'sleep-end', host: name, node, ok: true })
        return { ok: true, host: name, node, ledgerPersisted: true }
      } catch (ledgerError) {
        return { ok: true, host: name, node, ledgerPersisted: false, ledgerError: errorText(ledgerError) }
      }
    })
  }

  return Object.freeze({
    stateOf: snapshot,
    state: snapshot,
    list: (hosts = Object.keys(powerNodes)) => hosts.map(snapshot),
    canWake,
    setReachability,
    probe,
    wakeHost,
    prepareDispatchHost,
    request,
    waitForWake,
    runSmokeCheck,
    markDispatchStarted,
    markIdleSleepEligible,
    sleepHost,
    withHostPowerLock,
    withDispatchPowerLock: withHostPowerLock,
    wakeInFlight: (host) => {
      const flight = wakeFlights.get(powerNodes[String(host || '')])
      return flight ? { host: flight.host, node: flight.node, etaMs: Math.max(0, flight.deadlineAt - now()) } : null
    },
  })
}
