import { createFleetLedger, scrubSecrets } from './fleet-ledger.mjs'

export const RUN_STATUSES = Object.freeze([
  'waking', 'queued', 'running', 'detached',
  'completed', 'failed', 'cancelled', 'interrupted', 'lost',
])
export const TERMINAL_RUN_STATUSES = new Set(['completed', 'failed', 'cancelled', 'interrupted', 'lost'])
export const DEFAULT_RECONCILE_INTERVAL_MS = 30_000

const ACTIVE_STATUSES = new Set(['running', 'detached'])
const VALID_STATUS = new Set(RUN_STATUSES)
const clone = (value) => value === undefined ? undefined : structuredClone(value)
const text = (value) => typeof value === 'string' ? value : String(value ?? '')

function parseProbeReply(reply) {
  if (reply && typeof reply === 'object' && reply.ok === false) {
    return { kind: 'error', error: text(reply.err || reply.error || `ssh exit ${reply.code ?? '?'}`), code: reply.code }
  }
  const output = text(reply && typeof reply === 'object' ? (reply.out ?? reply.stdout) : reply).trim()
  let match = /^SETTLED\s+(-?\d+)\s*$/.exec(output)
  if (match) return { kind: 'settled', exit: Number(match[1]) }
  match = /^ALIVE(?:\s+(\S+))?\s*$/.exec(output)
  if (match) return { kind: 'alive', pid: match[1] || undefined }
  if (/^DEAD\s*$/.test(output)) return { kind: 'interrupted' }
  if (/^MISSING\s*$/.test(output)) return { kind: 'lost' }
  return { kind: 'error', error: output ? `unexpected reconcile reply: ${output.slice(0, 500)}` : 'empty reconcile reply' }
}

function batchStatus(runs) {
  if (!runs.length) return 'queued'
  if (runs.some((run) => run.status === 'running')) return 'running'
  if (runs.some((run) => run.status === 'detached')) return 'detached'
  if (runs.some((run) => run.status === 'waking')) return 'waking'
  if (runs.some((run) => run.status === 'queued')) return 'queued'
  if (runs.every((run) => run.status === 'completed')) return 'completed'
  if (runs.every((run) => run.status === 'cancelled')) return 'cancelled'
  return 'failed'
}

export class FleetRuntime {
  constructor(options = {}) {
    this.ledger = options.ledger ?? createFleetLedger(options.ledgerOptions)
    this.probeRun = options.probeRun
    this.readOutput = options.readOutput
    this.onTimeout = options.onTimeout
    this.cancelRemote = options.cancelRemote ?? options.killRemote
    const localRun = typeof options.isLocalRun === 'function' ? options.isLocalRun : (run) => !run?.runDir
    this.isLocalRun = localRun
    this.isLocalExecution = typeof options.isLocalExecution === 'function' ? options.isLocalExecution : localRun
    this.hasLiveController = typeof options.hasLiveController === 'function' ? options.hasLiveController : () => false
    this.clearControlSockets = options.clearControlSockets
    this.now = typeof options.now === 'function' ? options.now : Date.now
    this.setIntervalFn = options.setInterval ?? setInterval
    this.clearIntervalFn = options.clearInterval ?? clearInterval
    this.reconcileIntervalMs = Math.max(1, Number(options.reconcileIntervalMs) || DEFAULT_RECONCILE_INTERVAL_MS)
    this.runs = new Map()
    this.batches = new Map()
    this.runLocks = new Map()
    this.runControllers = new Map()
    this.batchControllers = new Map()
    this.hostFailures = new Map()
    this.activityListeners = new Set()
    this.pumpListeners = new Set()
    if (typeof options.onActivity === 'function') this.activityListeners.add(options.onActivity)
    if (typeof options.onPump === 'function') this.pumpListeners.add(options.onPump)
    this.timer = null
    this.reconcilePromise = null
    this.shutdownPromise = null
    this.closed = false
  }

  _ensureOpen() {
    if (this.closed) throw new Error('fleet runtime is shut down')
  }

  _batch(batchId, event = {}) {
    const id = text(batchId)
    let batch = this.batches.get(id)
    if (!batch) {
      batch = { batchId: id, label: text(event.label), createdAt: Number(event.at) || this.now(), origin: text(event.origin) || 'tool', runIds: [] }
      this.batches.set(id, batch)
    } else {
      if (event.label && !batch.label) batch.label = text(event.label)
      if (event.origin && !batch.origin) batch.origin = text(event.origin)
    }
    return batch
  }

  _controller(map, id) {
    let controller = map.get(id)
    if (!controller) {
      controller = new AbortController()
      map.set(id, controller)
    }
    return controller
  }

  controllerForRun(runId) { return this._controller(this.runControllers, text(runId)) }
  controllerForBatch(batchId) { return this._controller(this.batchControllers, text(batchId)) }

  createBatch(record = {}) {
    this._ensureOpen()
    const batchId = text(record.batchId)
    if (!batchId) throw new Error('batchId is required')
    const batch = this._batch(batchId, { ...record, at: record.createdAt ?? record.at })
    this.controllerForBatch(batchId)
    return this.getBatch(batch.batchId)
  }

  _applyEvent(raw, runtime = {}) {
    const event = scrubSecrets(raw)
    const runId = text(event.runId)
    if (!runId) return
    const previous = this.runs.get(runId)
    const previousActive = previous ? ACTIVE_STATUSES.has(previous.status) : false
    const base = previous ?? {
      runId,
      batchId: text(event.batchId),
      index: Number(event.index) || 0,
      host: text(event.host),
      kind: text(event.kind),
      runDir: text(event.runDir),
      model: text(event.model),
      origin: text(event.origin) || 'tool',
      label: text(event.label),
      pinned: event.pinned === true,
      tag: text(event.tag),
      wake: event.wake !== false,
      item: text(event.prompt),
      itemTruncated: event.promptTruncated === true,
      prompt: text(event.prompt),
      status: 'queued',
      createdAt: Number(event.at) || this.now(),
      startedAt: undefined,
      endedAt: undefined,
      timeoutMs: Number(event.timeoutMs) || undefined,
      resultText: undefined,
      error: undefined,
      exit: undefined,
      ms: undefined,
      reattached: false,
      pid: undefined,
      cancelPending: false,
      cancelReason: undefined,
      timeoutPending: false,
      recoveryCandidate: runtime.hydrating === true,
    }
    if (event.ev === 'dispatch') {
      Object.assign(base, {
        batchId: text(event.batchId), index: Number(event.index) || base.index,
        host: text(event.host), kind: text(event.kind) || base.kind, runDir: text(event.runDir), model: text(event.model),
        origin: text(event.origin) || base.origin, label: text(event.label),
        pinned: event.pinned === true, tag: text(event.tag), wake: event.wake !== false,
        prompt: text(event.prompt), timeoutMs: Number(event.timeoutMs) || base.timeoutMs,
        status: VALID_STATUS.has(event.status) ? event.status : 'queued',
      })
      if (runtime.item !== undefined) {
        base.item = text(scrubSecrets(runtime.item))
        base.itemTruncated = runtime.itemTruncated === true
      } else {
        base.item = text(event.prompt)
        base.itemTruncated = event.promptTruncated === true
      }
      base.recoveryCandidate = runtime.hydrating === true
    } else if (event.ev === 'wake') {
      base.status = 'waking'
    } else if (event.ev === 'queue') {
      Object.assign(base, event.patch && typeof event.patch === 'object' ? event.patch : {})
      base.status = 'queued'
      base.cancelPending = false
      base.cancelReason = undefined
      base.timeoutPending = false
      base.recoveryCandidate = runtime.hydrating === true
    } else if (event.ev === 'reroute') {
      base.host = text(event.host)
      base.kind = text(event.kind) || base.kind
      base.runDir = text(event.runDir)
      base.model = text(event.model)
      base.status = 'queued'
      base.error = undefined
      base.cancelPending = false
      base.cancelReason = undefined
      base.timeoutPending = false
      base.recoveryCandidate = runtime.hydrating === true
    } else if (event.ev === 'start') {
      base.status = 'running'
      base.startedAt = Number(event.startedAt) || Number(event.at) || this.now()
      if (Number(event.timeoutMs) > 0) base.timeoutMs = Number(event.timeoutMs)
      base.error = undefined
      base.cancelPending = false
      base.cancelReason = undefined
      base.timeoutPending = false
      base.recoveryCandidate = true
    } else if (event.ev === 'detach') {
      base.status = 'detached'
      base.detachedAt = Number(event.at) || this.now()
      base.error = text(event.reason || event.error)
      if (event.cancelPending !== undefined) base.cancelPending = event.cancelPending === true
      if (event.cancelReason !== undefined) base.cancelReason = text(event.cancelReason)
      if (event.timeoutPending !== undefined) base.timeoutPending = event.timeoutPending === true
      base.recoveryCandidate = true
    } else if (event.ev === 'reattach') {
      if (event.state === 'alive') {
        base.status = 'running'; base.reattached = true; base.pid = event.pid
        base.recoveryCandidate = true; base.error = undefined
      } else if (event.state === 'interrupted') {
        base.status = 'interrupted'; base.endedAt = Number(event.at) || this.now()
        base.error = text(event.error || 'remote process disappeared without exit file')
        base.recoveryCandidate = false
        base.cancelPending = false; base.cancelReason = undefined; base.timeoutPending = false
      } else if (event.state === 'lost') {
        base.status = 'lost'; base.endedAt = Number(event.at) || this.now()
        base.error = text(event.error || 'remote run directory is missing')
        base.recoveryCandidate = false
        base.cancelPending = false; base.cancelReason = undefined; base.timeoutPending = false
      }
    } else if (event.ev === 'end') {
      base.status = event.ok === true ? 'completed' : 'failed'
      base.endedAt = Number(event.endedAt) || Number(event.at) || this.now()
      base.exit = Number.isFinite(Number(event.exit)) ? Number(event.exit) : undefined
      base.ms = Number.isFinite(Number(event.ms)) ? Number(event.ms) : (base.startedAt ? base.endedAt - base.startedAt : undefined)
      base.resultText = text(event.resultText)
      base.error = event.ok === true ? undefined : text(event.error || `exit ${event.exit ?? '?'}`)
      base.recoveryCandidate = false
      base.cancelPending = false
      base.cancelReason = undefined
      base.timeoutPending = false
    } else if (event.ev === 'cancel') {
      base.status = 'cancelled'; base.endedAt = Number(event.at) || this.now()
      base.error = text(event.reason || 'cancelled')
      base.recoveryCandidate = false
      base.cancelPending = false
      base.cancelReason = undefined
      base.timeoutPending = false
    }
    Object.assign(base, runtime.patch && typeof runtime.patch === 'object' ? scrubSecrets(runtime.patch) : {})
    this.runs.set(runId, base)
    const batch = this._batch(base.batchId, event)
    if (!batch.runIds.includes(runId)) batch.runIds.push(runId)
    if (!TERMINAL_RUN_STATUSES.has(base.status)) {
      this.controllerForRun(runId); this.controllerForBatch(base.batchId)
    }
    const nextActive = ACTIVE_STATUSES.has(base.status)
    if (previousActive !== nextActive) {
      const snapshot = { activeCount: this.activeCount(), run: clone(base) }
      for (const listener of this.activityListeners) { try { listener(snapshot) } catch {} }
      if (previousActive && !nextActive) this.wakePump('slot-released')
    }
  }

  async hydrate() {
    this._ensureOpen()
    const events = await this.ledger.load()
    this.runs.clear(); this.batches.clear(); this.runControllers.clear(); this.batchControllers.clear()
    const dispatched = new Set()
    for (const event of events) {
      const runId = text(event?.runId)
      if (event?.ev === 'dispatch' && runId) dispatched.add(runId)
      // Compaction is event based. A retained terminal tail without its old
      // dispatch lacks runDir/host and is not recoverable; do not invent it.
      if (dispatched.has(runId)) this._applyEvent(event, { hydrating: true })
    }
    return { runs: this.listRuns(), batches: this.listBatches() }
  }

  _withRunLock(runId, operation) {
    const id = text(runId)
    const previous = this.runLocks.get(id) ?? Promise.resolve()
    const result = previous.catch(() => {}).then(operation)
    const tail = result.catch(() => {})
    this.runLocks.set(id, tail)
    tail.finally(() => { if (this.runLocks.get(id) === tail) this.runLocks.delete(id) })
    return result
  }

  _withRunLocks(runIds, operation) {
    const ids = [...new Set(runIds.map(text))].sort()
    let locked = operation
    for (let index = ids.length - 1; index >= 0; index--) {
      const inner = locked, runId = ids[index]
      locked = () => this._withRunLock(runId, inner)
    }
    return locked()
  }

  async _appendAndApply(event, runtime) {
    const stored = await this.ledger.append(event)
    this._applyEvent(stored, runtime)
    return this.getRun(stored.runId)
  }

  async registerDispatch(record) {
    this._ensureOpen()
    const runId = text(record?.runId), batchId = text(record?.batchId)
    if (!runId || !batchId) throw new Error('registerDispatch requires runId and batchId')
    return this._withRunLock(runId, async () => {
      if (this.runs.has(runId)) throw new Error(`run already exists: ${runId}`)
      const item = text(record.item ?? record.prompt)
      return this._appendAndApply({ ...record, prompt: record.prompt ?? item, ev: 'dispatch' }, {
        item, itemTruncated: record.itemTruncated === true,
        patch: { status: VALID_STATUS.has(record.status) ? record.status : 'queued' },
      })
    })
  }

  async registerDispatchBatch(records) {
    this._ensureOpen()
    if (!Array.isArray(records) || !records.length) return []
    const normalized = records.map((record) => {
      const runId = text(record?.runId), batchId = text(record?.batchId)
      if (!runId || !batchId) throw new Error('registerDispatchBatch requires runId and batchId')
      return { record, runId, batchId, item: text(record.item ?? record.prompt) }
    })
    const ids = normalized.map(({ runId }) => runId)
    if (new Set(ids).size !== ids.length) throw new Error('registerDispatchBatch contains duplicate runId')
    return this._withRunLocks(ids, async () => {
      if (ids.some((runId) => this.runs.has(runId))) throw new Error(`run already exists: ${ids.find((runId) => this.runs.has(runId))}`)
      // The ledger publishes the whole set atomically. Do not mutate runtime state
      // until that durability barrier succeeds.
      const diskRecords = normalized.map(({ record, item }) => ({ ...record, prompt: record.prompt ?? item, ev: 'dispatch' }))
      const appendBatch = typeof this.ledger.appendMany === 'function'
        ? () => this.ledger.appendMany(diskRecords)
        : typeof this.ledger.appendDispatchBatchBeforeSpawn === 'function'
          ? () => this.ledger.appendDispatchBatchBeforeSpawn(diskRecords)
          : null
      if (!appendBatch) throw new Error('ledger atomic batch append is required for dispatch')
      const stored = await appendBatch()
      if (!Array.isArray(stored) || stored.length !== normalized.length || stored.some((event, index) => text(event?.runId) !== normalized[index].runId)) {
        throw new Error('ledger.appendMany returned an incomplete dispatch set')
      }
      for (let index = 0; index < stored.length; index++) {
        const { record, item } = normalized[index]
        this._applyEvent(stored[index], {
          item, itemTruncated: record.itemTruncated === true,
          patch: { status: VALID_STATUS.has(record.status) ? record.status : 'queued' },
        })
      }
      return normalized.map(({ runId }) => this.getRun(runId))
    })
  }

  async prepareDispatch(records) {
    return this.registerDispatchBatch(records)
  }

  async markQueued(runId, patch = {}) {
    return this._withRunLock(runId, async () => {
      const run = this.runs.get(text(runId))
      if (!run) throw new Error(`unknown run: ${runId}`)
      if (TERMINAL_RUN_STATUSES.has(run.status)) return clone(run)
      return this._appendAndApply({ ev: 'queue', runId: run.runId, batchId: run.batchId, patch })
    })
  }

  async rerouteRun(runId, target = {}) {
    return this._withRunLock(runId, async () => {
      const run = this.runs.get(text(runId))
      if (!run) throw new Error(`unknown run: ${runId}`)
      if (TERMINAL_RUN_STATUSES.has(run.status)) return clone(run)
      if (run.status === 'running' || run.status === 'detached') throw new Error(`cannot reroute active run: ${runId}`)
      const host = text(target.host), runDir = text(target.runDir)
      if (!host || !runDir) throw new Error('rerouteRun requires host and runDir')
      return this._appendAndApply({
        ev: 'reroute', runId: run.runId, batchId: run.batchId,
        host, kind: text(target.kind), runDir, model: text(target.model),
      })
    })
  }

  async markStart(runId, patch = {}) {
    return this._withRunLock(runId, async () => {
      const run = this.runs.get(text(runId))
      if (!run) throw new Error(`unknown run: ${runId}`)
      if (TERMINAL_RUN_STATUSES.has(run.status)) return clone(run)
      return this._appendAndApply({ ...patch, ev: 'start', runId: run.runId, batchId: run.batchId, startedAt: patch.startedAt, timeoutMs: patch.timeoutMs }, { patch })
    })
  }

  async markEnd(runId, outcome = {}) {
    return this._withRunLock(runId, async () => {
      const run = this.runs.get(text(runId))
      if (!run) throw new Error(`unknown run: ${runId}`)
      if (TERMINAL_RUN_STATUSES.has(run.status)) return clone(run)
      return this._appendAndApply({ ...outcome, ev: 'end', runId: run.runId, batchId: run.batchId })
    })
  }

  async markDetached(runId, reason) {
    return this._withRunLock(runId, async () => {
      const run = this.runs.get(text(runId))
      if (!run) throw new Error(`unknown run: ${runId}`)
      if (TERMINAL_RUN_STATUSES.has(run.status)) return clone(run)
      if (run.status === 'detached' && text(reason) === run.error) return clone(run)
      return this._appendAndApply({ ev: 'detach', runId: run.runId, batchId: run.batchId, reason })
    })
  }

  async cancelRun(runId, reason = 'cancelled') {
    return this._withRunLock(runId, async () => {
      let run = this.runs.get(text(runId))
      if (!run) return { cancelled: false, reason: 'not-found' }
      if (TERMINAL_RUN_STATUSES.has(run.status)) return { cancelled: false, reason: 'terminal', run: clone(run) }
      // A queued/waking run has no process; an empty runDir denotes the local
      // in-process provider, whose controller is the real cancellation handle.
      let controllerOnly = false
      try { controllerOnly = this.isLocalExecution(clone(run)) === true } catch {}
      if (controllerOnly || (run.status !== 'running' && run.status !== 'detached')) {
        try { this.runControllers.get(run.runId)?.abort(reason) } catch {}
        const next = await this._appendAndApply({ ev: 'cancel', runId: run.runId, batchId: run.batchId, reason })
        return { cancelled: true, run: next }
      }
      let liveController = false
      try { liveController = this.hasLiveController(clone(run)) === true } catch {}
      if (liveController) {
        // The live runner owns the one real remoteKill call. Persist intent
        // before aborting; confirmRemoteCancelled() records the terminal event
        // only after the runner reports that kill succeeded.
        const pending = await this._markCancelPendingLocked(run, reason, 'cancellation delegated to live runner')
        try { this.runControllers.get(run.runId)?.abort(reason) } catch {}
        return { cancelled: false, reason: 'controller', pending: true, run: pending }
      }
      // Rehydrated controllers have no runRemote abort listener. Probe under the
      // same run lock, then kill explicitly; never claim cancellation merely
      // because a new local AbortController changed state.
      if (typeof this.probeRun !== 'function') {
        const pending = await this._markCancelPendingLocked(run, reason, 'cancel probe is unavailable')
        return { cancelled: false, reason: 'detached', pending: true, run: pending }
      }
      let reply
      try { reply = await this.probeRun(clone(run)) }
      catch (error) { reply = { ok: false, error: text(error?.message ?? error) } }
      const parsed = parseProbeReply(reply)
      if (parsed.kind === 'error') {
        const pending = await this._markCancelPendingLocked(run, reason, parsed.error)
        return { cancelled: false, reason: 'detached', pending: true, run: pending }
      }
      this.hostFailures.set(run.host, 0)
      if (parsed.kind === 'settled') {
        const settled = await this._settleLocked(run, parsed)
        return { cancelled: false, reason: TERMINAL_RUN_STATUSES.has(settled.status) ? 'settled' : 'detached', run: settled }
      }
      if (parsed.kind === 'interrupted' || parsed.kind === 'lost') {
        const terminal = await this._appendAndApply({ ev: 'reattach', runId: run.runId, batchId: run.batchId, state: parsed.kind })
        return { cancelled: false, reason: parsed.kind, run: terminal }
      }
      const killed = await this._killAliveLocked(run, parsed, reason)
      if (!killed.ok) return { cancelled: false, reason: 'detached', pending: true, run: killed.run }
      try { this.runControllers.get(run.runId)?.abort(reason) } catch {}
      const next = await this._appendAndApply({ ev: 'cancel', runId: run.runId, batchId: run.batchId, reason })
      return { cancelled: true, run: next }
    })
  }

  async cancelBatch(batchId, reason = 'cancelled') {
    const batch = this.batches.get(text(batchId))
    if (!batch) return { batchId: text(batchId), cancelled: [], skipped: [] }
    try { this.batchControllers.get(batch.batchId)?.abort(reason) } catch {}
    const cancelled = [], skipped = []
    for (const runId of batch.runIds) {
      const result = await this.cancelRun(runId, reason)
      if (result.cancelled) cancelled.push(runId)
      else skipped.push({ runId, reason: result.reason })
    }
    return { batchId: batch.batchId, cancelled, skipped }
  }

  async confirmRemoteCancelled(runId, reason = 'cancelled') {
    return this._withRunLock(runId, async () => {
      const run = this.runs.get(text(runId))
      if (!run) return { cancelled: false, reason: 'not-found' }
      if (TERMINAL_RUN_STATUSES.has(run.status)) return { cancelled: run.status === 'cancelled', reason: 'terminal', run: clone(run) }
      const next = await this._appendAndApply({ ev: 'cancel', runId: run.runId, batchId: run.batchId, reason })
      return { cancelled: true, run: next }
    })
  }

  getRun(runId) { return clone(this.runs.get(text(runId))) }

  listRuns(options = {}) {
    let runs = [...this.runs.values()]
    if (options.batchId) runs = runs.filter((run) => run.batchId === text(options.batchId))
    if (options.active === true) runs = runs.filter((run) => !TERMINAL_RUN_STATUSES.has(run.status))
    return runs.sort((a, b) => (b.createdAt - a.createdAt) || (a.index - b.index)).map(clone)
  }

  getBatch(batchId) {
    const batch = this.batches.get(text(batchId))
    if (!batch) return undefined
    const runs = batch.runIds.map((runId) => this.runs.get(runId)).filter(Boolean).sort((a, b) => a.index - b.index).map(clone)
    return { batchId: batch.batchId, label: batch.label, createdAt: batch.createdAt, origin: batch.origin, status: batchStatus(runs), runs }
  }

  listBatches(options = {}) {
    let batches = [...this.batches.values()].map((batch) => this.getBatch(batch.batchId))
      .sort((a, b) => b.createdAt - a.createdAt)
    if (Number(options.limit) > 0) batches = batches.slice(0, Number(options.limit))
    return batches
  }

  activeCount() { return [...this.runs.values()].filter((run) => ACTIVE_STATUSES.has(run.status)).length }
  subscribeActivity(listener) { this.activityListeners.add(listener); return () => this.activityListeners.delete(listener) }
  subscribePump(listener) { this.pumpListeners.add(listener); return () => this.pumpListeners.delete(listener) }

  wakePump(reason = 'manual') {
    const event = { reason, at: this.now(), activeCount: this.activeCount() }
    for (const listener of this.pumpListeners) {
      try { Promise.resolve(listener(event)).catch(() => {}) } catch {}
    }
    return event
  }

  async _readSettledOutput(run) {
    if (typeof this.readOutput !== 'function') return { ok: false, error: 'readOutput is unavailable' }
    try {
      const value = await this.readOutput(clone(run), 200000)
      if (typeof value === 'string') return { ok: true, out: value }
      if (value?.ok === false) return { ok: false, error: text(value.err || value.error || 'failed to read out.txt') }
      return { ok: true, out: text(value?.out ?? value?.stdout), err: text(value?.err) }
    } catch (error) { return { ok: false, error: text(error?.message ?? error) } }
  }

  async _markCancelPendingLocked(run, reason, error) {
    const overdue = Boolean(run.startedAt && run.timeoutMs && this.now() - run.startedAt > run.timeoutMs)
    return this._appendAndApply({
      ev: 'detach', runId: run.runId, batchId: run.batchId,
      reason: text(error || reason), cancelPending: true,
      cancelReason: text(reason || 'cancelled'),
      timeoutPending: run.timeoutPending === true || overdue,
    })
  }

  async _killAliveLocked(run, parsed, reason) {
    if (typeof this.cancelRemote !== 'function') {
      return { ok: false, run: await this._markCancelPendingLocked(run, reason, 'remote cancel is unavailable') }
    }
    try {
      const result = await this.cancelRemote(clone(run), { reason, pid: parsed.pid, probe: parsed })
      if (result === false || result?.ok === false) {
        return { ok: false, run: await this._markCancelPendingLocked(run, reason, result?.error || 'remote cancel failed') }
      }
      return { ok: true }
    } catch (error) {
      return { ok: false, run: await this._markCancelPendingLocked(run, reason, text(error?.message ?? error)) }
    }
  }

  async _settleLocked(run, parsed) {
    await this._appendAndApply({ ev: 'reattach', runId: run.runId, batchId: run.batchId, state: 'settled', exit: parsed.exit })
    const output = await this._readSettledOutput(run)
    if (!output.ok) {
      return this._appendAndApply({ ev: 'detach', runId: run.runId, batchId: run.batchId, reason: output.error })
    }
    return this._appendAndApply({
      ev: 'end', runId: run.runId, batchId: run.batchId, ok: parsed.exit === 0, exit: parsed.exit,
      ms: run.startedAt ? Math.max(0, this.now() - run.startedAt) : undefined,
      resultText: output.out, error: parsed.exit === 0 ? undefined : (output.err || `exit ${parsed.exit}`),
    })
  }

  async _reconcileRun(runId) {
    return this._withRunLock(runId, async () => {
      let run = this.runs.get(runId)
      if (!run || TERMINAL_RUN_STATUSES.has(run.status)) return this.getRun(runId)
      if (run.status !== 'running' && run.status !== 'detached' && run.recoveryCandidate !== true) return clone(run)
      if (typeof this.probeRun !== 'function') return clone(run)
      let reply
      try { reply = await this.probeRun(clone(run)) }
      catch (error) { reply = { ok: false, error: text(error?.message ?? error) } }
      const parsed = parseProbeReply(reply)
      if (parsed.kind === 'error') {
        const failures = (this.hostFailures.get(run.host) || 0) + 1
        this.hostFailures.set(run.host, failures)
        if (failures >= 3) {
          try { await this.clearControlSockets?.(run.host) } catch {}
          this.hostFailures.set(run.host, 0)
        }
        const overdue = Boolean(run.startedAt && run.timeoutMs && this.now() - run.startedAt > run.timeoutMs)
        if (run.status !== 'detached' || (overdue && run.timeoutPending !== true)) {
          await this._appendAndApply({
            ev: 'detach', runId, batchId: run.batchId, reason: parsed.error,
            cancelPending: run.cancelPending === true,
            timeoutPending: run.timeoutPending === true || overdue,
          })
        }
        return this.getRun(runId)
      }
      this.hostFailures.set(run.host, 0)
      if (parsed.kind === 'settled') {
        return this._settleLocked(run, parsed)
      }
      if (parsed.kind === 'interrupted' || parsed.kind === 'lost') {
        return this._appendAndApply({ ev: 'reattach', runId, batchId: run.batchId, state: parsed.kind })
      }
      if (parsed.kind === 'alive') {
        if (run.status === 'detached' || run.reattached !== true || run.pid !== parsed.pid) {
          await this._appendAndApply({ ev: 'reattach', runId, batchId: run.batchId, state: 'alive', pid: parsed.pid })
          run = this.runs.get(runId)
        }
        if (run.cancelPending === true) {
          const pendingReason = run.cancelReason || 'cancelled'
          const killed = await this._killAliveLocked(run, parsed, pendingReason)
          if (killed.ok) {
            try { this.runControllers.get(run.runId)?.abort(pendingReason) } catch {}
            return this._appendAndApply({ ev: 'cancel', runId, batchId: run.batchId, reason: pendingReason })
          }
          return killed.run
        }
        const overdue = run.startedAt && run.timeoutMs && this.now() - run.startedAt > run.timeoutMs
        if (overdue && typeof this.onTimeout === 'function') {
          try {
            const result = await this.onTimeout(clone(run), { probe: parsed })
            if (result !== false && result?.settled !== false) {
              return this._appendAndApply({ ev: 'end', runId, batchId: run.batchId, ok: false, error: 'TIMEOUT', exit: result?.exit })
            }
            return this._appendAndApply({
              ev: 'detach', runId, batchId: run.batchId,
              reason: text(result?.reason || result?.error || 'timeout remote kill failed'),
              timeoutPending: true, cancelPending: run.cancelPending === true,
            })
          } catch (error) {
            await this._appendAndApply({
              ev: 'detach', runId, batchId: run.batchId, reason: text(error?.message ?? error),
              timeoutPending: true, cancelPending: run.cancelPending === true,
            })
          }
        } else if (overdue) {
          await this._appendAndApply({
            ev: 'detach', runId, batchId: run.batchId, reason: 'timeout cancellation is unavailable',
            timeoutPending: true, cancelPending: run.cancelPending === true,
          })
        }
      }
      return this.getRun(runId)
    })
  }

  async reconcileOnce() {
    this._ensureOpen()
    if (this.reconcilePromise) return this.reconcilePromise
    this.reconcilePromise = (async () => {
      const ids = [...this.runs.values()]
        .filter((run) => !TERMINAL_RUN_STATUSES.has(run.status))
        .map((run) => run.runId)
      const results = []
      for (const runId of ids) results.push(await this._reconcileRun(runId))
      return results
    })().finally(() => { this.reconcilePromise = null })
    return this.reconcilePromise
  }

  startReconciler(intervalMs = this.reconcileIntervalMs) {
    this._ensureOpen()
    if (this.timer !== null) return this.timer
    this.timer = this.setIntervalFn(() => {
      this.reconcileOnce().catch(() => {})
    }, Math.max(1, Number(intervalMs) || this.reconcileIntervalMs))
    this.timer?.unref?.()
    return this.timer
  }

  stopReconciler() {
    if (this.timer === null) return
    this.clearIntervalFn(this.timer)
    this.timer = null
  }

  async shutdown() {
    if (this.shutdownPromise) return this.shutdownPromise
    this.closed = true
    this.shutdownPromise = (async () => {
      this.stopReconciler()
      if (this.reconcilePromise) await this.reconcilePromise.catch(() => {})
      await Promise.allSettled([...this.runLocks.values()])
      await this.ledger.drain?.()
      // Deliberately do not abort run controllers: plugin shutdown must detach, not kill remote work.
      this.runControllers.clear(); this.batchControllers.clear()
      this.activityListeners.clear(); this.pumpListeners.clear()
    })()
    return this.shutdownPromise
  }
}

export function createFleetRuntime(options) { return new FleetRuntime(options) }
export { parseProbeReply }
