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
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {
  PromptContentPart, RemoteEventDownlinkFrame, SessionFollowFrame, SessionHistoryRecord,
  SessionWireEvent, WorkspaceFollowFrame,
} from '../contract/api/index.ts'
import { sessionFollowFrameSchema } from '../contract/api/sessions.schema.ts'
import { workspaceFollowFrameSchema } from '../contract/api/workspace.schema.ts'
import { expandChunkRun } from './chunk-expand.ts'
import { createFold, type Fold } from '../fold/fold.ts'
import type { FoldedConversation } from '../fold/model.ts'
import { createRefCountedPoller } from './ref-counted-polling.ts'
import {
  applyOpeningSnapshot,
  applyPageFailure,
  applyPageSuccess,
  beginEarlierPage,
  cancelHistory,
  idleHistory,
  isStaleHistoryResponse,
  noteLiveEvent,
  type SessionHistoryState,
} from '../lib/session-history.ts'
import {
  applyCancel,
  applyHostResult,
  applySubmit,
  applyTransportError,
  canRetry as approvalCanRetry,
  createApprovalRequest,
  isBusy as approvalIsBusy,
  shouldDropMapping,
  sameApprovalToken,
  type ApprovalDecision,
  type ApprovalState,
} from '../lib/approval-state.ts'

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
  historyIncomplete: boolean
  historyRetryable: boolean
  historyError: string | undefined
  historyLoading: boolean
  approvalTick: number
  /** Latest host step identity; cleared by a subsequent user message / turn start. */
  currentStep?: { turn: number; step: number }
}

interface ConvoEntry {
  fold: Fold
  lastSeq: number
  history: SessionHistoryState
  state: ConversationState
  stop: (() => void) | undefined
}

const convoEmitter = createEmitter()
const conversations = new Map<string, ConvoEntry>()
let activeSessionId: string | undefined
let streamOnline = false
export type LiveConnectionPhase = 'idle' | 'connecting' | 'online' | 'offline'
let liveConnectionPhase: LiveConnectionPhase = 'idle'

const IDLE_STATE: ConversationState = {
  snapshot: undefined, phase: 'idle', error: undefined, streamOnline: false,
  historyIncomplete: false, historyRetryable: false, historyError: undefined, historyLoading: false, approvalTick: 0,
}
function emptyState(): ConversationState { return { ...IDLE_STATE } }
let approvalTick = 0
const approvalStates = new Map<string, ApprovalState>()

function publish(id: string): void {
  const entry = conversations.get(id)
  if (entry !== undefined) {
    entry.state = {
      snapshot: entry.history.address === undefined ? undefined : conversationSnapshot(entry),
      phase: entry.state.phase,
      error: entry.state.error,
      streamOnline,
      historyIncomplete: entry.history.historyIncomplete,
      historyRetryable: entry.history.retryable,
      historyError: entry.history.pageError,
      historyLoading: entry.history.pending !== undefined,
      approvalTick,
      currentStep: currentHistoryStep(entry.history),
    }
  }
  convoEmitter.emit()
}

function currentHistoryStep(history: SessionHistoryState): { turn: number; step: number } | undefined {
  let lastSeq = -1
  let position: { turn: number; step: number } | undefined
  for (const record of [...history.heldRecords, ...history.liveTail]) {
    const event = record.event
    const op = (event as SessionWireEvent).surfaceOp
    if (typeof op === 'object' && op.op === 'replace') continue
    if (event.seq <= lastSeq) continue
    if (event.type === 'user/message' || event.type === 'turn/start') {
      lastSeq = event.seq
      position = undefined
    } else if (['step/start', 'assistant/message', 'assistant/chunk', 'tool/call'].includes(event.type)) {
      const data = event.data as { turn?: unknown; step?: unknown } | null
      if (typeof data?.turn === 'number' && Number.isSafeInteger(data.turn)
        && typeof data.step === 'number' && Number.isSafeInteger(data.step)) {
        lastSeq = event.seq
        position = { turn: data.turn, step: data.step }
      }
    }
  }
  return position
}

/** Baseline projections describe the snapshot cut; later events supersede them. */
function conversationSnapshot(entry: ConvoEntry): FoldedConversation {
  const snapshot = entry.fold.snapshot()
  const values = entry.history.projections?.values as Record<string, unknown> | undefined
  if (values === undefined) return snapshot
  const changed = (type: string): boolean => entry.history.liveTail.some((record) => record.event.type === type)
  if (!changed('session/title') && Object.hasOwn(values, 'title')) {
    snapshot.title = typeof values['title'] === 'string' ? values['title'] : undefined
  }
  if (!changed('todo/write') && Object.hasOwn(values, 'todos')) {
    const todos = values['todos']
    if (todos === null) snapshot.todos = []
    else if (Array.isArray(todos)) snapshot.todos = todos.flatMap((todo) => {
      if (todo === null || typeof todo !== 'object' || typeof todo.content !== 'string' || typeof todo.status !== 'string') return []
      return [{ content: todo.content, status: todo.status }]
    })
  }
  const latest = (type: string): Record<string, unknown> | undefined => {
    const event = [...entry.history.liveTail].reverse().find((record) => record.event.type === type)?.event
    return event?.data !== null && typeof event?.data === 'object' ? event.data as Record<string, unknown> : undefined
  }
  const plan = latest('plan/mode') ?? values['plan']
  if (plan !== null && typeof plan === 'object' && typeof (plan as { active?: unknown }).active === 'boolean') {
    snapshot.planMode = (plan as { active: boolean }).active
  }
  if (!changed('subagent/descriptor') && Object.hasOwn(values, 'subagent')) {
    const subagent = values['subagent'] as { label?: unknown } | null
    snapshot.subagentLabel = typeof subagent?.label === 'string' ? subagent.label : undefined
  }
  const selectedPreset = latest('agent-preset/selected')
  if (snapshot.header !== undefined && (selectedPreset !== undefined || Object.hasOwn(values, 'agentPreset'))) {
    const preset = selectedPreset?.['agentPreset'] ?? values['agentPreset']
    snapshot.header = { ...snapshot.header, agentPreset: typeof preset === 'string' ? preset : undefined }
  }
  return snapshot
}

function publishApprovalChange(): void {
  approvalTick += 1
  for (const entry of conversations.values()) entry.state = { ...entry.state, approvalTick }
  convoEmitter.emit()
}

function publishConnection(): void {
  for (const entry of conversations.values()) entry.state = { ...entry.state, streamOnline }
  convoEmitter.emit()
}

/** Apply one history record to the fold; returns the highest seq applied. */
function applyRecord(fold: Fold, record: SessionHistoryRecord): number {
  if (record.type === 'chunks') {
    // Packed assistant delta run: expand into the same assistant/chunk events
    // the live stream emits so the fold renders it without any fold change.
    const expanded = expandChunkRun(record.event)
    let last = Number.NaN
    for (const ev of expanded) { fold.apply(ev as unknown as Record<string, unknown>); last = ev.seq }
    return last
  }
  const event = record.event as unknown as Record<string, unknown>
  // The host keeps replacement copies for the model surface, not the human transcript.
  if (!(typeof event['surfaceOp'] === 'object' && event['surfaceOp'] !== null
    && (event['surfaceOp'] as { op?: string }).op === 'replace')) fold.apply(event)
  return Number(event['seq'] ?? Number.NaN)
}

function onFollowValue(id: string, value: unknown): void {
  const entry = conversations.get(id)
  if (entry === undefined) return
  let frame: SessionFollowFrame
  frame = sessionFollowFrameSchema.parse(value) as SessionFollowFrame
  if (frame.type === 'snapshot') {
    if (frame.header.id !== id || frame.projections.asOfSeq !== frame.cursor) throw new Error('会话快照身份或投影游标不匹配')
    const address = { kind: 'session' as const, sessionId: id as SessionId }
    entry.history = applyOpeningSnapshot(entry.history, address, {
      header: frame.header,
      cursor: frame.cursor,
      records: frame.records,
      hasMore: frame.hasMore === true,
      projections: frame.projections,
    })
    const fold = createFold()
    fold.apply({ ...frame.header, type: 'session' })
    let lastSeq = frame.cursor
    for (const record of entry.history.recordsToApply) {
      const seq = applyRecord(fold, record)
      if (Number.isFinite(seq)) lastSeq = Math.max(lastSeq, seq)
    }
    entry.fold = fold
    entry.lastSeq = lastSeq
    entry.state = {
      snapshot: conversationSnapshot(entry), phase: 'live', error: undefined, streamOnline,
      historyIncomplete: entry.history.historyIncomplete,
      historyRetryable: entry.history.retryable,
      historyError: entry.history.pageError,
      historyLoading: false,
      approvalTick,
      currentStep: currentHistoryStep(entry.history),
    }
    settleApprovalsFromSnapshot(id, entry.state.snapshot)
    convoEmitter.emit()
    return
  }
  // event frame
  if (entry.history.address === undefined) throw new Error('会话事件先于 opening snapshot 到达')
  const event = frame.event as unknown as SessionWireEvent
  const seq = Number(event.seq ?? Number.NaN)
  if (Number.isFinite(seq) && seq <= entry.lastSeq) return
  applyRecord(entry.fold, { type: 'event', event })
  if (Number.isFinite(seq)) entry.lastSeq = seq
  entry.history = noteLiveEvent(entry.history, event)
  settleApprovalFromEvent(id, event)
  publish(id)
}

function startFollow(id: string): () => void {
  return watchStream(
    async function* (signal) {
      const entry = conversations.get(id)
      if (entry === undefined) return
      try {
        yield* agos.stream('session/follow', { request: { address: { kind: 'session', sessionId: id } } }, signal)
        if (!signal.aborted) throw new Error('本会话事件订阅已断开，正在重新连接')
      } catch (error) {
        if (!signal.aborted && conversations.get(id) === entry) {
          entry.state = { ...entry.state, phase: 'error', error: String((error as Error)?.message ?? error) }
          publish(id)
        }
        throw error
      }
    },
    (value) => {
      try { onFollowValue(id, value) } catch (error) {
        const entry = conversations.get(id)
        if (entry !== undefined) {
          entry.state = { ...entry.state, phase: 'error', error: String((error as Error)?.message ?? error) }
          publish(id)
        }
        throw error
      }
    },
    () => { /* reconnect: the next snapshot rebuilds the fold */ },
  )
}

// ── live connection ($events: ready / emit / waterfall) ───────────────────────
let eventsStarted = false
let stopEvents: (() => void) | undefined
let eventClientId: string | undefined
let hostHome: string | undefined
/** Agent/session identity is part of the delivery address, not just callId. */
const approvalKey = (sessionId: string, callId: string): string => JSON.stringify([sessionId, callId])
const approvalEvents = new Map<string, string>()

function onEventFrame(frame: RemoteEventDownlinkFrame): void {
  switch (frame.type) {
    case 'ready':
      eventClientId = frame.clientId
      hostHome = frame.host.home
      streamOnline = true
      liveConnectionPhase = 'online'
      publishConnection()
      return
    case 'waterfall': {
      if (frame.event !== 'approval/request') return
      const callId = String(frame.request['callId'] ?? '')
      if (callId !== '') {
        const key = approvalKey(frame.agentId, callId)
        approvalEvents.set(key, frame.eventId)
        const current = approvalStates.get(key)
        if (current !== undefined && current.token.eventId !== frame.eventId) {
          approvalStates.set(key, createApprovalRequest({ ...current.token, eventId: frame.eventId }))
        }
        publishApprovalChange()
      }
      return
    }
    case 'cancel':
      // Withdraw a pending waterfall; drop any callId mapping pointing at it.
      for (const [key, eventId] of approvalEvents) {
        if (eventId !== frame.eventId) continue
        const [sessionId, callId] = JSON.parse(key) as [string, string]
        const current = approvalStates.get(key) ?? createApprovalRequest({ sessionId, callId, eventId })
        approvalStates.set(key, applyCancel(current, current.token))
        approvalEvents.delete(key)
      }
      publishApprovalChange()
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
    async function* (signal) {
      try {
        yield* agos.events(signal, () => {
          eventClientId = undefined
          hostHome = undefined
          streamOnline = false
          liveConnectionPhase = 'connecting'
          publishConnection()
        })
      } finally {
        if (!signal.aborted) {
          eventClientId = undefined
          hostHome = undefined
          streamOnline = false
          liveConnectionPhase = 'offline'
          approvalEvents.clear()
          for (const [key, state] of approvalStates) {
            if (state.retainMapping && approvalIsBusy(state)) {
              approvalStates.set(key, applyTransportError(state, state.token, { kind: 'disconnect' }))
            }
          }
          publishApprovalChange()
          publishConnection()
        }
      }
    },
    onEventFrame,
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
    const entry: ConvoEntry = { fold: createFold(), lastSeq: -1, history: idleHistory(), state: emptyState(), stop: undefined }
    conversations.set(id, entry)
    entry.state = { ...emptyState(), phase: 'loading', streamOnline }
    entry.stop = startFollow(id)
  }
  convoEmitter.emit()
}

export function closeMux(): void {
  for (const entry of conversations.values()) {
    entry.history = cancelHistory(entry.history)
    entry.stop?.()
  }
  conversations.clear()
  approvalStates.clear()
  approvalEvents.clear()
  stopEvents?.()
  eventsStarted = false
  streamOnline = false
  eventClientId = undefined
  hostHome = undefined
  activeSessionId = undefined
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

function settleApprovalFromEvent(sessionId: string, event: SessionWireEvent): void {
  // Installed host emits decided {id,outcome}; the asked record owns callId.
  if (event.type !== 'approval/decided') return
  const entry = conversations.get(sessionId)
  if (entry !== undefined) settleApprovalsFromSnapshot(sessionId, entry.fold.snapshot())
}

function settleApprovalsFromSnapshot(sessionId: string, snapshot: FoldedConversation | undefined): void {
  for (const item of snapshot?.items ?? []) {
    if (item.kind !== 'approval' || item.outcome === undefined) continue
    const callId = item.callId ?? item.id
    const key = approvalKey(sessionId, callId)
    const current = approvalStates.get(key)
    if (current === undefined || current.token.sessionId !== sessionId) continue
    const next = applyHostResult(current, current.token,
      item.outcome === 'allowed-once' || item.outcome === 'rejected'
        ? { kind: 'resolved', decision: item.outcome }
        : { kind: 'already-handled' })
    if (next === current) continue
    approvalStates.set(key, next)
    if (shouldDropMapping(next) && approvalEvents.get(key) === current.token.eventId) approvalEvents.delete(key)
    publishApprovalChange()
  }
}

export function approvalView(callId: string | undefined, sessionId = activeSessionId): {
  status: ApprovalState['phase'] | undefined
  error: string | undefined
  busy: boolean
  decision: ApprovalDecision | undefined
  canRetry: boolean
} {
  if (callId === undefined) return { status: undefined, error: undefined, busy: false, decision: undefined, canRetry: true }
  const state = approvalStates.get(approvalKey(sessionId ?? '', callId))
  if (state === undefined || (sessionId !== undefined && state.token.sessionId !== sessionId)) {
    return { status: 'idle', error: undefined, busy: false, decision: undefined, canRetry: true }
  }
  return {
    status: state.phase,
    error: state.failure?.message,
    busy: approvalIsBusy(state),
    decision: state.decision,
    canRetry: approvalCanRetry(state),
  }
}

/** Answer a live approval waterfall. POST accepted is not host authorization. */
export async function respondApproval(
  callId: string | undefined,
  outcome: ApprovalDecision,
  sessionId?: string,
): Promise<boolean> {
  if (callId === undefined) return false
  const targetSession = sessionId ?? activeSessionId ?? ''
  const key = approvalKey(targetSession, callId)
  const eventId = approvalEvents.get(key)
  const token = {
    callId,
    eventId: eventId ?? '',
    sessionId: targetSession,
  }
  const previous = approvalStates.get(key)
  if (previous !== undefined && !previous.retainMapping && eventId === undefined) return false
  const initial = previous !== undefined && sameApprovalToken(previous.token, token) ? previous : createApprovalRequest(token)
  const requested = conversations.get(targetSession)?.fold.snapshot().items.find((item) => item.kind === 'approval' && (item.callId ?? item.id) === callId)
  if (requested?.kind !== 'approval' || requested.outcome !== undefined) return false
  if (eventClientId === undefined || eventId === undefined) {
    approvalStates.set(key, applyTransportError(initial, token, { kind: eventClientId === undefined ? 'disconnect' : 'missing-map' }))
    publishApprovalChange()
    return false
  }
  const state = applySubmit(initial, outcome)
  if (state === initial) return false // A duplicate click cannot issue a second POST.
  approvalStates.set(key, state)
  publishApprovalChange()
  const clientId = eventClientId
  const applyResponse = (response: { ok: true } | { ok: false; error: unknown }): void => {
    const current = approvalStates.get(key)
    // A changed request, a host decision, cancellation or disposal beats a late POST.
    if (current === undefined || !sameApprovalToken(current.token, token) || current.attempt !== state.attempt
      || !current.retainMapping || current.phase === 'resolved') return
    const next = response.ok
      ? applyHostResult(current, token, { kind: 'accepted' })
      : applyTransportError(current, token, {
        kind: 'network',
        message: `审批提交未获确认，可重试：${String((response.error as Error)?.message ?? response.error)}`,
      })
    approvalStates.set(key, next)
    publishApprovalChange()
  }
  try {
    await agos.postEventResult({
      clientId: clientId as never,
      eventId: eventId as never,
      outcome: { kind: 'result', value: outcome },
    })
    applyResponse({ ok: true })
    return true
  } catch (error) {
    applyResponse({ ok: false, error })
    return false
  }
}

/** Whether a live approval waterfall exists for this callId (respond button enable). */
export function hasApprovalWaterfall(callId: string | undefined, sessionId = activeSessionId): boolean {
  return callId !== undefined && eventClientId !== undefined && approvalEvents.has(approvalKey(sessionId ?? '', callId))
}

export async function loadEarlierHistory(sessionId: string): Promise<void> {
  const entry = conversations.get(sessionId)
  if (entry === undefined) return
  const started = beginEarlierPage(entry.history)
  entry.history = started.state
  publish(sessionId)
  if (started.action === undefined) return
  try {
    const res = await agos.call('session/page', {
      address: started.action.address,
      throughSeq: started.action.throughSeq,
      ...(started.action.beforeSeq !== undefined ? { beforeSeq: started.action.beforeSeq } : {}),
      ...(started.action.maxMessages !== undefined ? { maxMessages: started.action.maxMessages } : {}),
    })
    if (!res.result.ok) throw new Error(JSON.stringify(res.result.error))
    if (conversations.get(sessionId) !== entry || isStaleHistoryResponse(entry.history, started.action)) return
    entry.history = applyPageSuccess(entry.history, {
      address: started.action.address,
      generation: started.action.generation,
      records: res.result.value.records,
      hasMore: res.result.value.hasMore === true,
    })
    if (entry.history.rebuildRequired) {
      const fold = createFold()
      if (entry.history.header !== undefined) fold.apply({ ...entry.history.header, type: 'session' })
      let lastSeq = entry.history.throughSeq
      for (const record of entry.history.recordsToApply) {
        const seq = applyRecord(fold, record)
        if (Number.isFinite(seq)) lastSeq = Math.max(lastSeq, seq)
      }
      entry.fold = fold
      entry.lastSeq = lastSeq
      settleApprovalsFromSnapshot(sessionId, fold.snapshot())
    }
  } catch (error) {
    entry.history = applyPageFailure(entry.history, {
      address: started.action.address,
      generation: started.action.generation,
      error,
    })
  }
  publish(sessionId)
}

export function getEventClientId(): string | undefined { return eventClientId }

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
