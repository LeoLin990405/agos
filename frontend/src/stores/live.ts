/**
 * live stores — SPA real-data layer, aligned to DSH 0.1.2-rc.1.
 *
 * 0.1.2 transport: one WebSocket /api/remote.mux multiplexes logical streams.
 * - conversation: per-session `session/follow` stream. The stream is ordered —
 *   one opening `snapshot` (header + first records + cursor + projections) then
 *   `event` frames — so the fold rebuilds from the snapshot and applies live
 *   events by seq, with none of the old mux+history race.
 * - live connection: the `$events` stream carries the `ready` frame (clientId +
 *   host home, the host.describe replacement), forwarded `emit` notifications,
 *   and `waterfall` asks (approval / user-question) answered via $events/result.
 * - archives: `workspace/follow` baseline replaces the removed workspace.list.
 *
 * The fold is untouched; it is fed the same SessionWireEvent objects. Packed
 * `chunks` history records are applied best-effort (see NOTES: full chunkrow
 * expansion is a later batch).
 */
import { createAgosClient, watchStream } from '../api-client/index.ts'
import type {
  PromptContentPart, RemoteEventDownlinkFrame, SessionFollowFrame, SessionHistoryRecord,
  SessionWireEvent, WorkspaceFollowFrame,
} from '../contract/api/index.ts'
import { sessionFollowFrameSchema } from '../contract/api/sessions.schema.ts'
import { workspaceFollowFrameSchema } from '../contract/api/workspace.schema.ts'
import { createFold, type Fold } from '../fold/fold.ts'
import type { FoldedConversation } from '../fold/model.ts'
import { createRefCountedPoller } from './ref-counted-polling.ts'

export const agos = createAgosClient({})

type Listener = () => void

function createEmitter(): { subscribe(l: Listener): () => void, emit(): void } {
  const listeners = new Set<Listener>()
  return {
    subscribe(l) { listeners.add(l); return () => { listeners.delete(l) } },
    emit() { for (const l of listeners) l() },
  }
}

// ── sessions ────────────────────────────────────────────────────────────────
export interface SessionSummaryRow {
  sessionId: string
  title: string
  cwd: string
  updatedAt: number
  running: boolean
  blank: boolean
  turns: number
  tokens: number
  agentPreset: string
}

interface SessionsState { rows: SessionSummaryRow[], loadedAt: number, error: string | undefined }

const sessionsEmitter = createEmitter()
let sessionsState: SessionsState = { rows: [], loadedAt: 0, error: undefined }
let sessionsTimer: ReturnType<typeof setInterval> | undefined

export async function refreshSessions(): Promise<void> {
  try {
    const res = await agos.call('session/list', {})
    if (!res.result.ok) throw new Error(JSON.stringify(res.result.error))
    const rows = res.result.value.items.map((it) => {
      const item = it as unknown as Record<string, unknown>
      const proj = ((item['projections'] as Record<string, unknown> | undefined)?.['values'] ?? {}) as Record<string, unknown>
      const stats = (proj['sessionStats'] ?? {}) as Record<string, unknown>
      return {
        sessionId: String(item['sessionId'] ?? ''),
        title: typeof proj['title'] === 'string' ? proj['title'] as string : '(未命名会话)',
        cwd: String(item['cwd'] ?? ''),
        updatedAt: Number(item['updatedAt'] ?? 0),
        running: item['running'] === true,
        blank: item['blank'] === true,
        turns: Number(stats['turns'] ?? 0),
        tokens: Number(stats['decodeTokens'] ?? 0),
        agentPreset: String(item['agentPreset'] ?? ''),
      } satisfies SessionSummaryRow
    }).filter((r) => r.sessionId !== '')
    rows.sort((a, b) => b.updatedAt - a.updatedAt)
    sessionsState = { rows, loadedAt: Date.now(), error: undefined }
  } catch (error) {
    sessionsState = { ...sessionsState, error: String((error as Error)?.message ?? error) }
  }
  sessionsEmitter.emit()
}

export const sessionsStore = {
  subscribe(l: Listener): () => void {
    if (sessionsTimer === undefined) {
      void refreshSessions()
      sessionsTimer = setInterval(() => { if (!document.hidden) void refreshSessions() }, 15_000)
    }
    return sessionsEmitter.subscribe(l)
  },
  getSnapshot(): SessionsState { return sessionsState },
}

// ── conversation (session/follow) ─────────────────────────────────────────────
export interface ConversationState {
  snapshot: FoldedConversation | undefined
  phase: 'idle' | 'loading' | 'live' | 'error'
  error: string | undefined
  streamOnline: boolean
}

interface ConvoEntry {
  fold: Fold
  lastSeq: number
  state: ConversationState
  stop: (() => void) | undefined
}

const convoEmitter = createEmitter()
const conversations = new Map<string, ConvoEntry>()
let activeSessionId: string | undefined
let streamOnline = false
export type LiveConnectionPhase = 'idle' | 'connecting' | 'online' | 'offline'
let liveConnectionPhase: LiveConnectionPhase = 'idle'

const IDLE_STATE: ConversationState = { snapshot: undefined, phase: 'idle', error: undefined, streamOnline: false }
function emptyState(): ConversationState { return IDLE_STATE }

function publish(id: string): void {
  const entry = conversations.get(id)
  if (entry !== undefined) {
    entry.state = {
      snapshot: entry.fold.snapshot(),
      phase: entry.state.phase === 'error' ? 'error' : 'live',
      error: entry.state.error,
      streamOnline,
    }
  }
  convoEmitter.emit()
}

/** Apply one history record to the fold; returns the record's seq. */
function applyRecord(fold: Fold, record: SessionHistoryRecord): number {
  const event = record.event as unknown as Record<string, unknown>
  fold.apply(event)
  return Number(event['seq'] ?? Number.NaN)
}

function onFollowValue(id: string, value: unknown): void {
  const entry = conversations.get(id)
  if (entry === undefined) return
  let frame: SessionFollowFrame
  try { frame = sessionFollowFrameSchema.parse(value) as SessionFollowFrame } catch { return }
  if (frame.type === 'snapshot') {
    const fold = createFold()
    let lastSeq = frame.cursor
    for (const record of frame.records) {
      const seq = applyRecord(fold, record)
      if (Number.isFinite(seq)) lastSeq = Math.max(lastSeq, seq)
    }
    entry.fold = fold
    entry.lastSeq = lastSeq
    entry.state = { snapshot: fold.snapshot(), phase: 'live', error: undefined, streamOnline }
    convoEmitter.emit()
    return
  }
  // event frame
  const event = frame.event as unknown as SessionWireEvent
  const seq = Number(event.seq ?? Number.NaN)
  if (Number.isFinite(seq) && seq <= entry.lastSeq) return
  entry.fold.apply(event as unknown as Record<string, unknown>)
  if (Number.isFinite(seq)) entry.lastSeq = seq
  publish(id)
}

function startFollow(id: string): () => void {
  return watchStream(
    // Stream open args are keyed by the Host follow(request) parameter name.
    (signal, onOpen) => agos.stream('session/follow', { request: { address: { kind: 'session', sessionId: id } } }, signal, onOpen),
    (value) => onFollowValue(id, value),
    () => { /* reconnect: the next snapshot rebuilds the fold */ },
  )
}

// ── live connection ($events: ready / emit / waterfall) ───────────────────────
let eventsStarted = false
let stopEvents: (() => void) | undefined
let eventClientId: string | undefined
let hostHome: string | undefined
/** callId → waterfall eventId, for answering approval/request asks. */
const approvalEvents = new Map<string, string>()

function onEventFrame(frame: RemoteEventDownlinkFrame): void {
  switch (frame.type) {
    case 'ready':
      eventClientId = frame.clientId
      hostHome = frame.host.home
      convoEmitter.emit()
      return
    case 'waterfall': {
      if (frame.event !== 'approval/request') return
      const callId = String(frame.request['callId'] ?? '')
      if (callId !== '') approvalEvents.set(callId, frame.eventId)
      return
    }
    case 'cancel':
      // Withdraw a pending waterfall; drop any callId mapping pointing at it.
      for (const [callId, eventId] of approvalEvents) if (eventId === frame.eventId) approvalEvents.delete(callId)
      return
    case 'emit':
      // Forwarded host notifications: refresh the session list on activity/roster changes.
      if (frame.event.startsWith('api-session/')) void refreshSessions()
      return
    default:
      return
  }
}

function ensureEvents(): void {
  if (eventsStarted) return
  eventsStarted = true
  liveConnectionPhase = 'connecting'
  convoEmitter.emit()
  stopEvents = watchStream(
    (signal, onOpen) => agos.events(signal, () => { streamOnline = true; liveConnectionPhase = 'online'; convoEmitter.emit(); onOpen?.() }),
    onEventFrame,
    () => { streamOnline = false; liveConnectionPhase = 'offline'; convoEmitter.emit() },
  )
}

/** Start the shared $events stream even before a first session exists. */
export function ensureLiveConnection(): void { ensureEvents() }

/** Host account home from the $events ready frame (host.describe replacement); undefined until connected. */
export function getHostHome(): string | undefined { return hostHome }

export function openConversation(id: string): void {
  ensureEvents()
  activeSessionId = id
  if (!conversations.has(id)) {
    const entry: ConvoEntry = { fold: createFold(), lastSeq: -1, state: emptyState(), stop: undefined }
    conversations.set(id, entry)
    entry.state = { snapshot: undefined, phase: 'loading', error: undefined, streamOnline }
    entry.stop = startFollow(id)
  }
  convoEmitter.emit()
}

export function closeMux(): void {
  for (const entry of conversations.values()) entry.stop?.()
  conversations.clear()
  stopEvents?.()
  eventsStarted = false
  streamOnline = false
  liveConnectionPhase = 'idle'
  convoEmitter.emit()
}

export const conversationStore = {
  subscribe(l: Listener): () => void { return convoEmitter.subscribe(l) },
  getSnapshot(id: string | undefined): ConversationState {
    if (id === undefined) return IDLE_STATE
    return conversations.get(id)?.state ?? IDLE_STATE
  },
  activeSessionId: () => activeSessionId,
}

export const streamStore = {
  subscribe(l: Listener): () => void { return convoEmitter.subscribe(l) },
  getSnapshot(): boolean { return streamOnline },
}

export const liveConnectionStore = {
  subscribe(l: Listener): () => void { return convoEmitter.subscribe(l) },
  getSnapshot(): LiveConnectionPhase { return liveConnectionPhase },
}

/** Answer a live approval waterfall by the tool callId the ApprovalItem carries. */
export function respondApproval(callId: string | undefined, outcome: 'allowed-once' | 'rejected'): boolean {
  if (callId === undefined || eventClientId === undefined) return false
  const eventId = approvalEvents.get(callId)
  if (eventId === undefined) return false
  void agos.postEventResult({
    clientId: eventClientId as never,
    eventId: eventId as never,
    outcome: { kind: 'result', value: outcome },
  })
  approvalEvents.delete(callId)
  return true
}

/** Whether a live approval waterfall exists for this callId (respond button enable). */
export function hasApprovalWaterfall(callId: string | undefined): boolean {
  return callId !== undefined && eventClientId !== undefined && approvalEvents.has(callId)
}

async function sendContent(sessionId: string, content: PromptContentPart[]): Promise<{ ok: boolean, error?: string }> {
  try {
    const res = await agos.call('session/prompt', {
      requestId: crypto.randomUUID() as never,
      sessionId: sessionId as never,
      mode: 'steer',
      content,
      clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    })
    if (!res.result.ok) return { ok: false, error: JSON.stringify(res.result.error) }
    return { ok: true }
  } catch (error) {
    return { ok: false, error: String((error as Error)?.message ?? error) }
  }
}

export async function sendPrompt(sessionId: string, text: string): Promise<{ ok: boolean, error?: string }> {
  return sendContent(sessionId, [{ type: 'text', text }])
}

/** Send an already-assembled multimodal prompt; identical call semantics to sendPrompt. */
export async function sendPromptParts(sessionId: string, parts: PromptContentPart[]): Promise<{ ok: boolean, error?: string }> {
  return sendContent(sessionId, parts)
}

// ── telemetry (agos overview + swarm progress, plugin routes, same-origin) ────
export interface TelemetryState {
  overview: Record<string, unknown> | undefined
  progress: { calls: Record<string, unknown>[] } | undefined
  at: number
}

const telemetryEmitter = createEmitter()
let telemetryState: TelemetryState = { overview: undefined, progress: undefined, at: 0 }

async function refreshTelemetry(): Promise<void> {
  const next: TelemetryState = { ...telemetryState, at: Date.now() }
  try {
    const r = await fetch('/api/agos/overview')
    if (r.ok) next.overview = await r.json() as Record<string, unknown>
  } catch { /* soft dependency: absent plugin → absent group */ }
  try {
    const r = await fetch('/api/swarm/progress')
    if (r.ok) {
      const d = await r.json() as Record<string, unknown>
      const calls = Object.entries((d['calls'] ?? d) as Record<string, unknown>)
        .filter(([, v]) => typeof v === 'object' && v !== null)
        .map(([callId, v]) => ({ callId, ...(v as Record<string, unknown>) }))
      next.progress = { calls }
    }
  } catch { /* same */ }
  telemetryState = next
  telemetryEmitter.emit()
}

const telemetryPolling = createRefCountedPoller({
  run: () => { void refreshTelemetry() },
  shouldRunScheduled: () => !document.hidden,
  intervalMs: 10_000,
  setIntervalFn: (callback, intervalMs) => setInterval(callback, intervalMs),
  clearIntervalFn: (handle) => clearInterval(handle),
})

export const telemetryStore = {
  subscribe(l: Listener): () => void {
    const unsubscribe = telemetryEmitter.subscribe(l)
    const stopPolling = telemetryPolling.acquire()
    return () => { unsubscribe(); stopPolling() }
  },
  getSnapshot(): TelemetryState { return telemetryState },
}

// ── modes / models / new session / memory graph ───────────────────────────────
export interface PresetInfo { id: string, name: string, description: string, isDefault: boolean }
export async function fetchPresets(): Promise<PresetInfo[]> {
  const res = await agos.call('agentPresets/list', {})
  if (!res.result.ok) return []
  const v = res.result.value as unknown as Record<string, unknown>
  const list = (v['presets'] ?? []) as Record<string, unknown>[]
  return list.map((p) => ({
    id: String(p['id'] ?? ''), name: String(p['name'] ?? p['id'] ?? ''),
    description: String(p['description'] ?? ''), isDefault: p['isDefault'] === true,
  })).filter((p) => p.id !== '')
}

export interface SkillListEntry {
  name: string
  description: string
  whenToUse?: string
  modelInvocable: boolean
}

export async function fetchSkillList(sessionId: string): Promise<SkillListEntry[]> {
  if (!sessionId) return []
  try {
    const res = await agos.call('skills/list', { sessionId: sessionId as never })
    if (!res.result.ok) return []
    const v = res.result.value as unknown as Record<string, unknown>
    const list = (v['skills'] ?? []) as Record<string, unknown>[]
    return list.map((row) => ({
      name: String(row['name'] ?? ''),
      description: String(row['description'] ?? ''),
      whenToUse: row['whenToUse'] !== undefined ? String(row['whenToUse']) : undefined,
      modelInvocable: row['modelInvocable'] !== false,
    })).filter((row) => row.name !== '')
  } catch {
    return []
  }
}

export interface ModelGroup { provider: string, models: { id: string, name: string }[] }
export interface SessionModels { current: { provider: string, model: string } | undefined, groups: ModelGroup[] }
export async function fetchSessionModels(sessionId: string): Promise<SessionModels> {
  const res = await agos.call('session/modelCatalog', { sessionId: sessionId as never })
  if (!res.result.ok) return { current: undefined, groups: [] }
  const v = res.result.value as unknown as Record<string, unknown>
  // rc.1: no per-session `current`; the deployment default stands in until the
  // modelSelection projection is wired (NOTES: later batch surfaces the session's own pick).
  const def = v['default'] as Record<string, unknown> | undefined
  const groups = ((v['groups'] ?? []) as Record<string, unknown>[]).map((g) => ({
    provider: String(g['id'] ?? g['provider'] ?? ''),
    models: ((g['models'] ?? []) as Record<string, unknown>[]).map((m) => ({
      id: String(m['id'] ?? ''), name: String(m['name'] ?? m['id'] ?? ''),
    })),
  })).filter((g) => g.provider !== '' && g.models.length > 0)
  return {
    current: def !== undefined ? { provider: String(def['provider'] ?? ''), model: String(def['model'] ?? '') } : undefined,
    groups,
  }
}
export async function selectSessionModel(sessionId: string, provider: string, model: string): Promise<boolean> {
  const res = await agos.call('session/selectModel', { sessionId: sessionId as never, provider, model })
  return res.result.ok
}

export async function createSession(params: { cwd: string, agentPreset?: string }): Promise<string | undefined> {
  const payload: Record<string, unknown> = { cwd: params.cwd }
  if (params.agentPreset !== undefined) payload['agentPreset'] = params.agentPreset
  const res = await agos.call('session/create', payload as never)
  if (!res.result.ok) return undefined
  const sid = String((res.result.value as unknown as Record<string, unknown>)['sessionId'] ?? '')
  if (sid !== '') { void refreshSessions(); openConversation(sid) }
  return sid !== '' ? sid : undefined
}

// ── ProgressDock derived selector ──────────────────────────────────────────────
export interface SwarmBatchProgress {
  callId: string
  label: string
  done: number
  failed: number
  total: number
}

export interface SwarmProgressSummary {
  batches: SwarmBatchProgress[]
  done: number
  total: number
}

function deriveSwarmProgress(state: TelemetryState): SwarmProgressSummary | undefined {
  const calls = state.progress?.calls
  if (calls === undefined || calls.length === 0) return undefined
  const batches: SwarmBatchProgress[] = []
  for (const call of calls) {
    const rows = Array.isArray(call['rows']) ? call['rows'] as Record<string, unknown>[] : []
    if (rows.length === 0) continue
    const done = rows.filter((r) => r['status'] === 'completed').length
    const failed = rows.filter((r) => r['status'] === 'failed').length
    if (done + failed >= rows.length) continue
    batches.push({
      callId: String(call['callId'] ?? ''),
      label: String(call['description'] ?? call['callId'] ?? '批次'),
      done,
      failed,
      total: rows.length,
    })
  }
  if (batches.length === 0) return undefined
  let doneSum = 0
  let totalSum = 0
  for (const b of batches) { doneSum += b.done; totalSum += b.total }
  return { batches, done: doneSum, total: totalSum }
}

let swarmProgressCacheSrc: TelemetryState | undefined
let swarmProgressCacheValue: SwarmProgressSummary | undefined

export const swarmProgressStore = {
  subscribe(l: Listener): () => void { return telemetryStore.subscribe(l) },
  getSnapshot(): SwarmProgressSummary | undefined {
    if (swarmProgressCacheSrc !== telemetryState) {
      swarmProgressCacheSrc = telemetryState
      swarmProgressCacheValue = deriveSwarmProgress(telemetryState)
    }
    return swarmProgressCacheValue
  },
}

export interface MemoryGraphData {
  nodes: { id: string, type: string, description: string, bytes: number, mtime: number, outDegree: number }[]
  edges: { from: string, to: string, dangling: boolean }[]
  counts: Record<string, unknown>
}
export async function fetchMemoryGraph(): Promise<MemoryGraphData | undefined> {
  try {
    const r = await fetch('/api/memory/graph')
    if (!r.ok) return undefined
    const d = await r.json() as Record<string, unknown>
    return {
      nodes: (d['nodes'] ?? []) as MemoryGraphData['nodes'],
      edges: (d['edges'] ?? []) as MemoryGraphData['edges'],
      counts: (d['counts'] ?? {}) as Record<string, unknown>,
    }
  } catch { return undefined }
}

// ── session sidebar management ─────────────────────────────────────────────────
export interface SessionSearchResult {
  sessionIds: string[]
  hasMore: boolean
}

export async function searchSessions(
  query: string,
  signal?: AbortSignal,
): Promise<SessionSearchResult | undefined> {
  const normalized = query.trim()
  if (normalized === '') return { sessionIds: [], hasMore: false }
  try {
    const response = await agos.call('session/search', { query: normalized }, signal)
    if (!response.result.ok) return undefined
    return {
      sessionIds: response.result.value.items.map((item) => String(item.sessionId)),
      hasMore: response.result.value.hasMore,
    }
  } catch (error) {
    if (signal?.aborted) throw error
    return undefined
  }
}

export async function renameSession(
  sessionId: string,
  title: string,
): Promise<{ ok: true, title: string } | { ok: false, error: string }> {
  try {
    const response = await agos.call('session/rename', { sessionId: sessionId as never, title })
    if (!response.result.ok) return { ok: false, error: JSON.stringify(response.result.error) }
    void refreshSessions()
    return { ok: true, title: response.result.value.title }
  } catch (error) {
    return { ok: false, error: String((error as Error)?.message ?? error) }
  }
}

/** Host-native "reveal in file manager"; only call when canHostOpenPath is true. */
export async function openHostPath(path: string): Promise<{ ok: boolean, error?: string }> {
  try {
    const response = await agos.call('session/openWorkspacePath', { path })
    return response.result.ok ? { ok: true } : { ok: false, error: JSON.stringify(response.result.error) }
  } catch (error) {
    return { ok: false, error: String((error as Error)?.message ?? error) }
  }
}

export async function canHostOpenPath(): Promise<boolean> {
  try {
    const response = await agos.call('session/canOpenWorkspacePath', {})
    return response.result.ok && response.result.value === true
  } catch {
    return false
  }
}

export interface HostArchivedSessionsSnapshot {
  sessionIds: string[]
  available: boolean
  error?: string
}

/**
 * Archived-session observer over the workspace/follow stream: the opening
 * baseline carries the full archived set; `archived` increments replace it.
 */
export function watchHostArchivedSessions(
  listener: (snapshot: HostArchivedSessionsSnapshot) => void,
): () => void {
  return watchStream(
    (signal, onOpen) => agos.stream('workspace/follow', {}, signal, onOpen),
    (value) => {
      let frame: WorkspaceFollowFrame
      try { frame = workspaceFollowFrameSchema.parse(value) as WorkspaceFollowFrame } catch { return }
      if (frame.type === 'baseline') {
        listener({ sessionIds: frame.value.archivedSessionIds.map(String), available: true })
      } else if (frame.type === 'archived') {
        listener({ sessionIds: frame.archivedSessionIds.map(String), available: true })
      }
    },
    () => { /* reconnect: the next baseline reseeds the archived set */ },
  )
}

// Pure selector export for the unified node:test suite.
export { deriveSwarmProgress }

// Homelab fleet live data is isolated from local session/mux state.
export {
  cancelFleetRun,
  closeRemoteRun,
  dispatchFleet,
  fetchFleetArtifacts,
  fetchFleetBatch,
  fetchFleetPower,
  FleetRequestError,
  fleetBatchesStore,
  fleetHostsStore,
  fleetProgressStore,
  openRemoteRun,
  preflightFleetHosts,
  remoteRunKey,
  remoteRunStore,
  sleepFleetHost,
  wakeFleetHosts,
} from './fleet-live.ts'
export type {
  FleetArtifactsManifest,
  FleetArtifactFile,
  FleetBatch,
  FleetBatchesState,
  FleetCancelResult,
  FleetCancelTarget,
  FleetDispatchRequest,
  FleetDispatchResult,
  FleetHost,
  FleetHostsState,
  FleetPowerNode,
  FleetPreflightResult,
  FleetProgressSummary,
  FleetResourcePhase,
  FleetRunStatus,
  FleetSleepResult,
  FleetWakeResult,
  FleetWakeSummary,
  RemoteRunState,
} from './fleet-live.ts'
