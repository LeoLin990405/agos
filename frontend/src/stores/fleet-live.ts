import { createFold, type Fold } from '../fold/fold.ts'
import type { FoldedConversation } from '../fold/model.ts'
import {
  isTerminalFleetStatus,
  outcomeOfFleetStatus,
  parseFleetArtifacts,
  parseFleetBatchResponse,
  parseFleetBatchesResponse,
  parseFleetCancelResult,
  parseFleetDispatchResult,
  parseFleetHostsResponse,
  parseFleetPower,
  parseFleetPreflightResult,
  parseFleetSleepResult,
  parseFleetWakeResult,
  type FleetArtifactsManifest,
  type FleetArtifact,
  type FleetBatch,
  type FleetCancelResult,
  type FleetDispatchResult,
  type FleetHost,
  type FleetPowerNode,
  type FleetPreflightResult,
  type FleetRunStatus,
  type FleetSleepResult,
  type FleetWakeResult,
  type FleetWakeSummary,
  type RemoteRunOutcome,
} from './remote-run-model.ts'
import {
  createFileRemoteTraceSource,
  type RemoteTraceBatch,
  type RemoteTraceSource,
  type RemoteTraceSourceFactory,
} from './remote-trace-source.ts'

type Listener = () => void
type TimeoutHandle = ReturnType<typeof setTimeout>

export type FleetResourcePhase = 'idle' | 'loading' | 'ready' | 'degraded' | 'error'

export interface FleetHostsState {
  phase: FleetResourcePhase
  hosts: FleetHost[]
  power: FleetPowerNode[]
  at: number
  error?: string
  attempt: number
}

export interface FleetBatchesState {
  phase: FleetResourcePhase
  batches: FleetBatch[]
  at: number
  error?: string
  attempt: number
}

export interface RemoteRunState {
  host: string
  runId: string
  snapshot: FoldedConversation | undefined
  phase: 'idle' | 'loading' | 'live' | 'ended' | 'error'
  error: string | undefined
  outcome: RemoteRunOutcome | undefined
  runStatus?: FleetRunStatus
  notice?: 'trace-not-created'
}

export interface FleetDispatchRequest {
  items: string[]
  hosts?: string[]
  tag?: string
  wake?: boolean
  label?: string
  timeoutMs?: number
}

export type FleetCancelTarget = { batchId: string } | { runId: string, host: string }

export interface FleetProgressBatch {
  callId: string
  label: string
  done: number
  failed: number
  total: number
}

export interface FleetProgressSummary {
  batches: FleetProgressBatch[]
  done: number
  total: number
}

export class FleetRequestError extends Error {
  readonly status: number
  readonly code?: string
  readonly detail?: unknown

  constructor(status: number, message: string, code?: string, detail?: unknown) {
    super(message)
    this.name = 'FleetRequestError'
    this.status = status
    this.code = code
    this.detail = detail
  }
}

export type FleetFetch = (input: string, init?: RequestInit) => Promise<Response>

export interface FleetLiveEnvironment {
  fetchImpl?: FleetFetch
  now?: () => number
  setTimeoutFn?: (callback: () => void, delay: number) => TimeoutHandle
  clearTimeoutFn?: (handle: TimeoutHandle) => void
  queueMicrotaskFn?: (callback: () => void) => void
  isHidden?: () => boolean
  onVisibilityChange?: (listener: () => void) => () => void
  traceSourceFactory?: RemoteTraceSourceFactory
}

interface Emitter {
  subscribe(listener: Listener): () => void
  emit(): void
}

function createEmitter(): Emitter {
  const listeners = new Set<Listener>()
  return {
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    emit() { for (const listener of listeners) listener() },
  }
}

const errorMessage = (error: unknown): string => {
  if (error instanceof Error && error.message !== '') return error.message
  if (typeof error === 'string' && error !== '') return error
  return 'Fleet 请求失败'
}

const nextBackoff = (attempt: number, cap: number): number => Math.min(cap, 1_000 * (2 ** Math.max(0, attempt)))

function defaultVisibilityListener(listener: () => void): () => void {
  if (typeof document === 'undefined') return () => {}
  document.addEventListener('visibilitychange', listener)
  return () => { document.removeEventListener('visibilitychange', listener) }
}

async function errorFromResponse(response: Response): Promise<FleetRequestError> {
  let payload: Record<string, unknown> | undefined
  try {
    const value = await response.json() as unknown
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) payload = value as Record<string, unknown>
  } catch { /* response may not be JSON */ }
  const message = typeof payload?.['error'] === 'string'
    ? payload['error']
    : `HTTP ${response.status}${response.statusText === '' ? '' : ` ${response.statusText}`}`
  return new FleetRequestError(
    response.status,
    message,
    typeof payload?.['code'] === 'string' ? payload['code'] : undefined,
    payload?.['detail'],
  )
}

async function readJson(fetchImpl: FleetFetch, url: string, init: RequestInit = {}): Promise<unknown> {
  const response = await fetchImpl(url, {
    ...init,
    headers: { accept: 'application/json', ...init.headers },
  })
  if (!response.ok) throw await errorFromResponse(response)
  return response.json() as Promise<unknown>
}

async function postJson(fetchImpl: FleetFetch, url: string, body: unknown, signal?: AbortSignal): Promise<unknown> {
  return readJson(fetchImpl, url, {
    method: 'POST',
    signal,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

interface PollingResource<State> {
  subscribe(listener: Listener): () => void
  getSnapshot(): State
  refresh(): void
  stop(): void
}

function createPollingResource<Data, State>({
  initial,
  load,
  interval,
  loading,
  resolved,
  rejected,
  queueMicrotaskFn,
  setTimeoutFn,
  clearTimeoutFn,
  isHidden,
  onVisibilityChange,
}: {
  initial: State
  load: (signal: AbortSignal, forced: boolean) => Promise<Data>
  interval: (data: Data) => number
  loading: (previous: State) => State
  resolved: (previous: State, data: Data) => State
  rejected: (previous: State, error: unknown) => State
  queueMicrotaskFn: (callback: () => void) => void
  setTimeoutFn: (callback: () => void, delay: number) => TimeoutHandle
  clearTimeoutFn: (handle: TimeoutHandle) => void
  isHidden: () => boolean
  onVisibilityChange: (listener: () => void) => () => void
}): PollingResource<State> {
  const emitter = createEmitter()
  let state = initial
  let subscribers = 0
  let generation = 0
  let timer: TimeoutHandle | undefined
  let controller: AbortController | undefined
  let stopVisibility: (() => void) | undefined
  let failures = 0
  let lastInterval = 15_000

  const clearTimer = (): void => {
    if (timer !== undefined) clearTimeoutFn(timer)
    timer = undefined
  }

  const schedule = (delay: number): void => {
    clearTimer()
    if (subscribers === 0 || isHidden()) return
    timer = setTimeoutFn(() => { void run(false) }, Math.max(0, delay))
  }

  const run = async (forced: boolean): Promise<void> => {
    if (subscribers === 0 && !forced) return
    if (isHidden() && !forced) return
    clearTimer()
    controller?.abort()
    controller = new AbortController()
    const signal = controller.signal
    const requestGeneration = ++generation
    state = loading(state)
    emitter.emit()
    try {
      const data = await load(signal, forced)
      if (signal.aborted || requestGeneration !== generation) return
      failures = 0
      lastInterval = interval(data)
      state = resolved(state, data)
      emitter.emit()
      schedule(lastInterval)
    } catch (error) {
      if (signal.aborted || requestGeneration !== generation) return
      const retry = nextBackoff(failures, Math.max(lastInterval, 30_000))
      failures += 1
      state = rejected(state, error)
      emitter.emit()
      schedule(retry)
    }
  }

  const start = (): void => {
    const expected = ++generation
    stopVisibility = onVisibilityChange(() => {
      if (!isHidden() && subscribers > 0) void run(false)
      else clearTimer()
    })
    queueMicrotaskFn(() => {
      if (subscribers > 0 && expected === generation) void run(false)
    })
  }

  const stop = (): void => {
    generation += 1
    clearTimer()
    controller?.abort()
    controller = undefined
    stopVisibility?.()
    stopVisibility = undefined
  }

  return {
    subscribe(listener) {
      const unsubscribe = emitter.subscribe(listener)
      subscribers += 1
      if (subscribers === 1) start()
      let active = true
      return () => {
        if (!active) return
        active = false
        unsubscribe()
        subscribers = Math.max(0, subscribers - 1)
        if (subscribers === 0) stop()
      }
    },
    getSnapshot: () => state,
    refresh: () => { void run(true) },
    stop,
  }
}

export function deriveFleetProgress(state: FleetBatchesState): FleetProgressSummary | undefined {
  const active = state.batches.filter((batch) => batch.status === 'running')
  if (active.length === 0) return undefined
  const batches = active.map((batch) => ({
    callId: batch.batchId,
    label: batch.label || batch.batchId,
    done: batch.counts.completed,
    failed: batch.counts.failed + batch.counts.cancelled,
    total: batch.counts.total,
  }))
  return {
    batches,
    done: batches.reduce((sum, batch) => sum + batch.done, 0),
    total: batches.reduce((sum, batch) => sum + batch.total, 0),
  }
}

export interface FleetLiveController {
  remoteRunKey(host: string, runId: string): string
  openRemoteRun(host: string, runId: string): void
  closeRemoteRun(host: string, runId: string): void
  remoteRunStore: { subscribe(listener: Listener): () => void, getSnapshot(key: string | undefined): RemoteRunState }
  fleetHostsStore: PollingResource<FleetHostsState>
  fleetBatchesStore: PollingResource<FleetBatchesState>
  fleetProgressStore: { subscribe(listener: Listener): () => void, getSnapshot(): FleetProgressSummary | undefined }
  dispatchFleet(request: FleetDispatchRequest, signal?: AbortSignal): Promise<FleetDispatchResult>
  cancelFleetRun(target: FleetCancelTarget, signal?: AbortSignal): Promise<FleetCancelResult>
  wakeFleetHosts(hosts: string[], signal?: AbortSignal): Promise<FleetWakeResult>
  preflightFleetHosts(hosts: string[], signal?: AbortSignal): Promise<FleetPreflightResult>
  fetchFleetArtifacts(host: string, runId: string, signal?: AbortSignal): Promise<FleetArtifactsManifest>
  fetchFleetBatch(batchId: string, signal?: AbortSignal): Promise<FleetBatch>
  fetchFleetPower(signal?: AbortSignal): Promise<{ at: number, nodes: FleetPowerNode[] }>
  sleepFleetHost(host: string, signal?: AbortSignal): Promise<FleetSleepResult>
  dispose(): void
}

export function createFleetLive(environment: FleetLiveEnvironment = {}): FleetLiveController {
  const fetchImpl = environment.fetchImpl ?? ((input, init) => fetch(input, init))
  const now = environment.now ?? Date.now
  const setTimeoutFn = environment.setTimeoutFn ?? ((callback, delay) => setTimeout(callback, delay))
  const clearTimeoutFn = environment.clearTimeoutFn ?? ((handle) => clearTimeout(handle))
  const queueMicrotaskFn = environment.queueMicrotaskFn ?? queueMicrotask
  const isHidden = environment.isHidden ?? (() => typeof document !== 'undefined' && document.hidden)
  const onVisibilityChange = environment.onVisibilityChange ?? defaultVisibilityListener
  const traceSourceFactory = environment.traceSourceFactory ?? ((host: string, runId: string) => createFileRemoteTraceSource({
    host,
    runId,
    fetchPage: (url, signal) => readJson(fetchImpl, url, { signal }),
  }))

  const hostsResource = createPollingResource<
    { hosts: FleetHost[], power: FleetPowerNode[], at: number },
    FleetHostsState
  >({
    initial: { phase: 'idle', hosts: [], power: [], at: 0, attempt: 0 } satisfies FleetHostsState,
    load: async (signal, forced) => {
      const [hosts, power] = await Promise.all([
        readJson(fetchImpl, `/api/fleet/hosts${forced ? '?refresh=1' : ''}`, { signal }).then(parseFleetHostsResponse),
        readJson(fetchImpl, '/api/fleet/power', { signal }).then(parseFleetPower),
      ])
      return { hosts, power: power.nodes, at: Math.max(power.at, now()) }
    },
    interval: () => 60_000,
    loading: (previous) => ({ ...previous, phase: 'loading' as const, error: undefined }),
    resolved: (_previous, data) => ({ phase: 'ready', hosts: data.hosts, power: data.power, at: data.at, attempt: 0 }),
    rejected: (previous, error) => ({
      ...previous,
      phase: previous.at > 0 ? 'degraded' : 'error',
      error: errorMessage(error),
      attempt: previous.attempt + 1,
    }),
    queueMicrotaskFn, setTimeoutFn, clearTimeoutFn, isHidden, onVisibilityChange,
  })

  const batchesResource = createPollingResource<
    { at: number, batches: FleetBatch[] },
    FleetBatchesState
  >({
    initial: { phase: 'idle', batches: [], at: 0, attempt: 0 } satisfies FleetBatchesState,
    load: (signal) => readJson(fetchImpl, '/api/fleet/batches?limit=100&include=runs', { signal }).then(parseFleetBatchesResponse),
    interval: (data) => data.batches.some((batch) => batch.status === 'running') ? 3_000 : 15_000,
    loading: (previous) => ({ ...previous, phase: 'loading' as const, error: undefined }),
    resolved: (_previous, data) => ({ phase: 'ready', batches: data.batches, at: data.at, attempt: 0 }),
    rejected: (previous, error) => ({
      ...previous,
      phase: previous.at > 0 ? 'degraded' : 'error',
      error: errorMessage(error),
      attempt: previous.attempt + 1,
    }),
    queueMicrotaskFn, setTimeoutFn, clearTimeoutFn, isHidden, onVisibilityChange,
  })

  const remoteEmitter = createEmitter()
  const remoteRunKey = (host: string, runId: string): string => `${host}/${runId}`
  const IDLE_REMOTE: RemoteRunState = {
    host: '', runId: '', snapshot: undefined, phase: 'idle', error: undefined, outcome: undefined,
  }
  interface RemoteEntry {
    source: RemoteTraceSource
    fold: Fold
    caughtUp: boolean
    state: RemoteRunState
    refs: number
    /** Incremented whenever a newly observed durable status is terminal. */
    terminalEpoch: number
    /** A trace request begun at this epoch completed successfully. */
    validatedTerminalEpoch: number
  }
  const remoteEntries = new Map<string, RemoteEntry>()
  const openOrder: string[] = []
  let activeKey: string | undefined
  let remoteGeneration = 0
  let remoteTimer: TimeoutHandle | undefined
  let remoteController: AbortController | undefined
  let stopBatchObservation: (() => void) | undefined
  let remoteFailures = 0

  const clearRemoteTimer = (): void => {
    if (remoteTimer !== undefined) clearTimeoutFn(remoteTimer)
    remoteTimer = undefined
  }

  const stopRemotePolling = (): void => {
    remoteGeneration += 1
    clearRemoteTimer()
    remoteController?.abort()
    remoteController = undefined
    if (activeKey !== undefined) remoteEntries.get(activeKey)?.source.stop()
  }

  const findRunStatus = (host: string, runId: string): FleetRunStatus | undefined => {
    for (const batch of batchesResource.getSnapshot().batches) {
      const run = batch.runs?.find((candidate) => candidate.host === host && candidate.runId === runId)
      if (run !== undefined) return run.status
    }
    return undefined
  }

  // The source owns its cursor. A successful checkpoint establishes whether
  // that source is caught up; the public state never exposes file offsets.
  const caughtUp = (entry: RemoteEntry): boolean => entry.state.snapshot !== undefined && entry.caughtUp

  const publishStatus = (key: string, status: FleetRunStatus): { changed: boolean, revalidate: boolean } => {
    const entry = remoteEntries.get(key)
    if (entry === undefined || entry.state.runStatus === status) return { changed: false, revalidate: false }
    const terminal = isTerminalFleetStatus(status)
    if (terminal) {
      entry.terminalEpoch += 1
      // Even a cached caught-up snapshot predates this terminal observation.
      // It cannot prove that the final remote tail has been consumed.
      entry.validatedTerminalEpoch = 0
    }
    const nextState: RemoteRunState = {
      ...entry.state,
      runStatus: status,
      outcome: outcomeOfFleetStatus(status),
      ...(terminal && entry.state.phase === 'ended' ? { phase: 'live' as const } : {}),
    }
    entry.state = nextState
    return { changed: true, revalidate: terminal && key === activeKey }
  }

  const syncRemoteOutcomes = (): void => {
    let changed = false
    let revalidateActive = false
    for (const [key, entry] of remoteEntries) {
      const status = findRunStatus(entry.state.host, entry.state.runId)
      if (status === undefined) continue
      const result = publishStatus(key, status)
      changed ||= result.changed
      revalidateActive ||= result.revalidate
    }
    if (changed) remoteEmitter.emit()
    if (revalidateActive) {
      // Abort any request which began before the terminal observation. The
      // replacement request captures the new epoch and is the only one allowed
      // to settle the run.
      stopRemotePolling()
      if (activeKey !== undefined) startRemotePolling()
    }
  }

  const scheduleRemote = (delay?: number): void => {
    clearRemoteTimer()
    if (activeKey === undefined) return
    const effective = delay ?? (isHidden() ? 10_000 : 1_500)
    remoteTimer = setTimeoutFn(() => { void pollRemote() }, effective)
  }

  const pollRemote = async (): Promise<void> => {
    const key = activeKey
    if (key === undefined) return
    const entry = remoteEntries.get(key)
    if (entry === undefined || entry.refs < 1) return
    clearRemoteTimer()
    remoteController?.abort()
    remoteController = new AbortController()
    const signal = remoteController.signal
    const requestGeneration = ++remoteGeneration
    const requestTerminalEpoch = entry.terminalEpoch
    if (entry.state.snapshot === undefined) {
      entry.state = { ...entry.state, phase: 'loading', error: undefined }
      remoteEmitter.emit()
    }
    try {
      let resetAwaitingReplay = false
      const checkpoint = await entry.source.start((batch: RemoteTraceBatch) => {
        if (signal.aborted || requestGeneration !== remoteGeneration || key !== activeKey) return
        if (batch.reset) {
          entry.fold = createFold()
          entry.caughtUp = false
          resetAwaitingReplay = true
        }
        for (const event of batch.events) {
          if (event.kind === 'parse-error') entry.fold.noteParseError()
          else entry.fold.apply(event.value)
        }
        if (batch.events.length > 0) resetAwaitingReplay = false
        entry.state = {
          ...entry.state,
          snapshot: resetAwaitingReplay ? undefined : entry.fold.snapshot(),
          phase: resetAwaitingReplay ? 'loading' : 'live',
          error: undefined,
        }
        remoteEmitter.emit()
      }, signal)
      if (signal.aborted || requestGeneration !== remoteGeneration || key !== activeKey) return
      remoteFailures = 0
      entry.caughtUp = checkpoint.caughtUp
      if (resetAwaitingReplay) {
        entry.caughtUp = false
        entry.state = {
          ...entry.state,
          snapshot: undefined,
          phase: 'loading',
          error: undefined,
          notice: checkpoint.notice,
        }
        remoteEmitter.emit()
        scheduleRemote(isHidden() ? 10_000 : 0)
        return
      }
      const status = findRunStatus(entry.state.host, entry.state.runId) ?? entry.state.runStatus
      if (status !== undefined && status !== entry.state.runStatus) publishStatus(key, status)
      if (status !== undefined && isTerminalFleetStatus(status) && requestTerminalEpoch > 0 && requestTerminalEpoch === entry.terminalEpoch) {
        entry.validatedTerminalEpoch = requestTerminalEpoch
      }
      const next: RemoteRunState = {
        ...entry.state,
        snapshot: entry.fold.snapshot(),
        phase: 'live',
        error: undefined,
        notice: checkpoint.notice,
        ...(status === undefined ? {} : { runStatus: status, outcome: outcomeOfFleetStatus(status) }),
      }
      entry.state = next
      if (
        isTerminalFleetStatus(status) &&
        caughtUp(entry) &&
        entry.terminalEpoch > 0 &&
        entry.validatedTerminalEpoch === entry.terminalEpoch
      ) next.phase = 'ended'
      remoteEmitter.emit()
      if (next.phase !== 'ended') scheduleRemote()
    } catch (error) {
      if (signal.aborted || requestGeneration !== remoteGeneration || key !== activeKey) return
      entry.state = { ...entry.state, phase: 'error', error: errorMessage(error) }
      remoteEmitter.emit()
      const retry = nextBackoff(remoteFailures, 30_000)
      remoteFailures += 1
      scheduleRemote(Math.max(isHidden() ? 10_000 : 0, retry))
    }
  }

  const startRemotePolling = (): void => {
    const expected = ++remoteGeneration
    queueMicrotaskFn(() => {
      if (activeKey !== undefined && expected === remoteGeneration) void pollRemote()
    })
  }

  const observeBatches = (): void => {
    if (stopBatchObservation !== undefined) return
    stopBatchObservation = batchesResource.subscribe(syncRemoteOutcomes)
  }

  const stopObservingBatches = (): void => {
    stopBatchObservation?.()
    stopBatchObservation = undefined
  }

  const selectActive = (key: string | undefined): void => {
    if (key === activeKey) return
    stopRemotePolling()
    activeKey = key
    remoteFailures = 0
    if (key !== undefined) startRemotePolling()
  }

  const openRemoteRun = (host: string, runId: string): void => {
    if (host === '' || runId === '') throw new TypeError('host and runId are required')
    const key = remoteRunKey(host, runId)
    let entry = remoteEntries.get(key)
    if (entry === undefined) {
      entry = {
        source: traceSourceFactory(host, runId),
        fold: createFold(),
        caughtUp: false,
        refs: 0,
        terminalEpoch: 0,
        validatedTerminalEpoch: 0,
        state: {
          host, runId, snapshot: undefined, phase: 'idle', error: undefined, outcome: undefined,
        },
      }
      remoteEntries.set(key, entry)
    }
    entry.refs += 1
    const previousIndex = openOrder.indexOf(key)
    if (previousIndex >= 0) openOrder.splice(previousIndex, 1)
    openOrder.push(key)
    observeBatches()
    syncRemoteOutcomes()
    selectActive(key)
    remoteEmitter.emit()
  }

  const closeRemoteRun = (host: string, runId: string): void => {
    const key = remoteRunKey(host, runId)
    const entry = remoteEntries.get(key)
    if (entry === undefined || entry.refs === 0) return
    entry.refs -= 1
    if (entry.refs > 0) return
    const index = openOrder.indexOf(key)
    if (index >= 0) openOrder.splice(index, 1)
    if (activeKey === key) selectActive(openOrder.at(-1))
    // A closed remote run can be reopened from durable trace. Retaining every
    // historical FoldedConversation here would otherwise grow without bound.
    entry.source.stop()
    remoteEntries.delete(key)
    if (![...remoteEntries.values()].some((candidate) => candidate.refs > 0)) stopObservingBatches()
    remoteEmitter.emit()
  }

  let progressSource: FleetBatchesState | undefined
  let progressValue: FleetProgressSummary | undefined
  const fleetProgressStore = {
    subscribe: (listener: Listener): (() => void) => batchesResource.subscribe(listener),
    getSnapshot: (): FleetProgressSummary | undefined => {
      const current = batchesResource.getSnapshot()
      if (current !== progressSource) {
        progressSource = current
        progressValue = deriveFleetProgress(current)
      }
      return progressValue
    },
  }

  const dispatchFleet = async (request: FleetDispatchRequest, signal?: AbortSignal): Promise<FleetDispatchResult> => {
    const result = parseFleetDispatchResult(await postJson(fetchImpl, '/api/fleet/dispatch', request, signal))
    batchesResource.refresh()
    return result
  }

  const cancelFleetRun = async (target: FleetCancelTarget, signal?: AbortSignal): Promise<FleetCancelResult> => {
    const result = parseFleetCancelResult(await postJson(fetchImpl, '/api/fleet/cancel', target, signal))
    batchesResource.refresh()
    return result
  }

  const wakeFleetHosts = async (hosts: string[], signal?: AbortSignal): Promise<FleetWakeResult> => {
    if (hosts.length === 0 || hosts.some((host) => host === '')) throw new TypeError('wake requires at least one host')
    const result = parseFleetWakeResult(await postJson(fetchImpl, '/api/fleet/wake', { hosts }, signal))
    hostsResource.refresh()
    return result
  }

  const preflightFleetHosts = async (hosts: string[], signal?: AbortSignal): Promise<FleetPreflightResult> => {
    if (hosts.length === 0 || hosts.some((host) => host === '')) throw new TypeError('preflight requires at least one host')
    return parseFleetPreflightResult(await postJson(fetchImpl, '/api/fleet/preflight', { hosts }, signal))
  }

  const fetchFleetArtifacts = async (host: string, runId: string, signal?: AbortSignal): Promise<FleetArtifactsManifest> => {
    const query = new URLSearchParams({ host, run: runId })
    return parseFleetArtifacts(await readJson(fetchImpl, `/api/fleet/artifacts?${query.toString()}`, { signal }))
  }

  const fetchFleetBatch = async (batchId: string, signal?: AbortSignal): Promise<FleetBatch> => {
    const query = new URLSearchParams({ id: batchId })
    return parseFleetBatchResponse(await readJson(fetchImpl, `/api/fleet/batch?${query.toString()}`, { signal }))
  }

  const fetchFleetPower = async (signal?: AbortSignal): Promise<{ at: number, nodes: FleetPowerNode[] }> => {
    return parseFleetPower(await readJson(fetchImpl, '/api/fleet/power', { signal }))
  }

  const sleepFleetHost = async (host: string, signal?: AbortSignal): Promise<FleetSleepResult> => {
    const result = parseFleetSleepResult(await postJson(fetchImpl, '/api/fleet/sleep', { host, confirm: 'SLEEP' }, signal))
    hostsResource.refresh()
    return result
  }

  return {
    remoteRunKey,
    openRemoteRun,
    closeRemoteRun,
    remoteRunStore: {
      subscribe: (listener) => remoteEmitter.subscribe(listener),
      getSnapshot: (key) => key === undefined ? IDLE_REMOTE : remoteEntries.get(key)?.state ?? IDLE_REMOTE,
    },
    fleetHostsStore: hostsResource,
    fleetBatchesStore: batchesResource,
    fleetProgressStore,
    dispatchFleet,
    cancelFleetRun,
    wakeFleetHosts,
    preflightFleetHosts,
    fetchFleetArtifacts,
    fetchFleetBatch,
    fetchFleetPower,
    sleepFleetHost,
    dispose() {
      hostsResource.stop()
      batchesResource.stop()
      stopRemotePolling()
      stopObservingBatches()
      activeKey = undefined
    },
  }
}

const fleetLive = createFleetLive()

export const remoteRunKey = fleetLive.remoteRunKey
export const openRemoteRun = fleetLive.openRemoteRun
export const closeRemoteRun = fleetLive.closeRemoteRun
export const remoteRunStore = fleetLive.remoteRunStore
export const fleetHostsStore = fleetLive.fleetHostsStore
export const fleetBatchesStore = fleetLive.fleetBatchesStore
export const fleetProgressStore = fleetLive.fleetProgressStore
export const dispatchFleet = fleetLive.dispatchFleet
export const cancelFleetRun = fleetLive.cancelFleetRun
export const wakeFleetHosts = fleetLive.wakeFleetHosts
export const preflightFleetHosts = fleetLive.preflightFleetHosts
export const fetchFleetArtifacts = fleetLive.fetchFleetArtifacts
export const fetchFleetBatch = fleetLive.fetchFleetBatch
export const fetchFleetPower = fleetLive.fetchFleetPower
export const sleepFleetHost = fleetLive.sleepFleetHost

export type {
  FleetArtifactsManifest,
  FleetArtifact,
  FleetBatch,
  FleetCancelResult,
  FleetDispatchResult,
  FleetHost,
  FleetPowerNode,
  FleetPreflightResult,
  FleetRunStatus,
  FleetSleepResult,
  FleetWakeResult,
  FleetWakeSummary,
}

/** UI-facing name kept explicit: a manifest entry is a downloadable file. */
export type FleetArtifactFile = FleetArtifact
