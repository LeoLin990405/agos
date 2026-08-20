/**
 * live stores —— SPA 的真实数据层(P1 stores)。
 *
 * 三个 store,全部 useSyncExternalStore 风格(subscribe + getSnapshot):
 * - sessions:session.list 轮询(15s)+ 手动 refresh。
 * - conversation:每会话一个 fold。顺序纪律(修正 P0 时记下的空窗问题):
 *   **流先行**——mux 常开(watchStream 自动重连);会话打开或流重开(onOpen)时,
 *   先进入 buffering(live 帧入缓冲),再拉 session.history 重建 fold,
 *   然后按 seq 排掉重叠(仅 apply seq > lastSeq 的缓冲帧)转 live。
 * - telemetry:/api/agos/overview + /api/swarm/progress 轮询(10s,页面可见才轮)。
 *
 * 审批 respond 需要 mux 帧的 rpcId:approvalRpc 表记录 approval/requested 的
 * (approvalId → rpcId),ChatPage 的审批按钮据此回 POST /api/respond。
 */
import { createAgosClient, watchStream } from '../api-client/index.ts'
import type { MuxFrame } from '../contract/api/index.ts'
import type { PromptContentPart, RpcRequest } from '../contract/api/index.ts'
import { createFold, type Fold } from '../fold/fold.ts'
import type { FoldedConversation } from '../fold/model.ts'

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
    const res = await agos.call('session.list', {})
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

// ── conversation ────────────────────────────────────────────────────────────
export interface ConversationState {
  snapshot: FoldedConversation | undefined
  phase: 'idle' | 'loading' | 'live' | 'error'
  error: string | undefined
  streamOnline: boolean
}

interface ConvoEntry {
  fold: Fold
  lastSeq: number
  buffering: boolean
  buffer: { seq: number, event: Record<string, unknown> }[]
  state: ConversationState
}

const convoEmitter = createEmitter()
const conversations = new Map<string, ConvoEntry>()
let activeSessionId: string | undefined
let streamOnline = false
let muxStarted = false
let stopMux: (() => void) | undefined
/** approvalId → 该 approval/requested 帧的 rpcId(respond 用)。 */
export const approvalRpc = new Map<string, string>()

const IDLE_STATE: ConversationState = { snapshot: undefined, phase: 'idle', error: undefined, streamOnline: false }
function emptyState(): ConversationState { return IDLE_STATE } // 稳定引用:useSyncExternalStore 需要

function publish(id: string): void {
  const entry = conversations.get(id)
  if (entry !== undefined) {
    entry.state = {
      snapshot: entry.fold.snapshot(),
      phase: entry.buffering ? 'loading' : 'live',
      error: undefined,
      streamOnline,
    }
  }
  convoEmitter.emit()
}

function applyLive(entry: ConvoEntry, id: string, seq: number, event: Record<string, unknown>): void {
  if (entry.buffering) { entry.buffer.push({ seq, event }); return }
  if (seq <= entry.lastSeq) return
  entry.fold.apply(event)
  entry.lastSeq = seq
  publish(id)
}

function onMuxFrame(frame: RpcRequest<MuxFrame>): void {
  const payload = frame.payload as unknown as Record<string, unknown>
  const type = String(payload['type'] ?? '')
  if (type === 'approval/requested') {
    const inner = (payload['payload'] ?? payload) as Record<string, unknown>
    const approvalId = String(inner['id'] ?? (inner['data'] as Record<string, unknown> | undefined)?.['id'] ?? '')
    if (approvalId !== '') approvalRpc.set(approvalId, String(frame.rpcId))
    return
  }
  if (type !== 'session/event') return
  const sessionId = String(payload['sessionId'] ?? '')
  const entry = conversations.get(sessionId)
  if (entry === undefined) return
  const event = payload['event'] as Record<string, unknown> | undefined
  if (event === undefined) return
  const seq = Number(event['seq'] ?? Number.NaN)
  applyLive(entry, sessionId, Number.isFinite(seq) ? seq : entry.lastSeq + 1, event)
}

async function rebuildFromHistory(id: string): Promise<void> {
  const entry = conversations.get(id)
  if (entry === undefined) return
  entry.buffering = true
  entry.buffer = []
  try {
    const res = await agos.call('session.history', { sessionId: id as never })
    if (!res.result.ok) throw new Error(JSON.stringify(res.result.error))
    const value = res.result.value as unknown as Record<string, unknown>
    const entries = (value['events'] ?? []) as Record<string, unknown>[]
    const fold = createFold()
    let lastSeq = -1
    for (const wrapper of entries) {
      // history 条目形状 {event: SessionEvent, …}(实测);容忍裸事件形态
      const event = (wrapper['event'] ?? wrapper) as Record<string, unknown>
      fold.apply(event)
      const seq = Number(event['seq'] ?? Number.NaN)
      if (Number.isFinite(seq)) lastSeq = Math.max(lastSeq, seq)
    }
    entry.fold = fold
    entry.lastSeq = lastSeq
    const drained = entry.buffer
    entry.buffer = []
    entry.buffering = false
    for (const { seq, event } of drained) {
      if (seq > entry.lastSeq) { entry.fold.apply(event); entry.lastSeq = seq }
    }
    publish(id)
  } catch (error) {
    entry.buffering = false
    entry.state = { snapshot: entry.state.snapshot, phase: 'error', error: String((error as Error)?.message ?? error), streamOnline }
    convoEmitter.emit()
  }
}

function ensureMux(): void {
  if (muxStarted) return
  muxStarted = true
  stopMux = watchStream(
    (signal) => agos.mux(signal, () => {
      // 流开通(首连或重连):流先行已就绪,现在才安全重拉 history。
      streamOnline = true
      for (const id of conversations.keys()) void rebuildFromHistory(id)
      convoEmitter.emit()
    }),
    onMuxFrame,
    () => { streamOnline = false; convoEmitter.emit() },
  )
}

export function openConversation(id: string): void {
  ensureMux()
  activeSessionId = id
  if (!conversations.has(id)) {
    conversations.set(id, { fold: createFold(), lastSeq: -1, buffering: true, buffer: [], state: emptyState() })
    void rebuildFromHistory(id)
  }
  convoEmitter.emit()
}

export function closeMux(): void { stopMux?.(); muxStarted = false; streamOnline = false }

export const conversationStore = {
  subscribe(l: Listener): () => void { return convoEmitter.subscribe(l) },
  getSnapshot(id: string | undefined): ConversationState {
    if (id === undefined) return IDLE_STATE
    return conversations.get(id)?.state ?? IDLE_STATE
  },
  activeSessionId: () => activeSessionId,
}

/** 流在线状态(布尔快照,给 topbar 的 RPC 徽章)。 */
export const streamStore = {
  subscribe(l: Listener): () => void { return convoEmitter.subscribe(l) },
  getSnapshot(): boolean { return streamOnline },
}

export async function sendPrompt(sessionId: string, text: string): Promise<{ ok: boolean, error?: string }> {
  try {
    const res = await agos.call('session.prompt', {
      sessionId: sessionId as never,
      mode: 'steer',
      content: [{ type: 'text', text }],
      clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    })
    if (!res.result.ok) return { ok: false, error: JSON.stringify(res.result.error) }
    return { ok: true }
  } catch (error) {
    return { ok: false, error: String((error as Error)?.message ?? error) }
  }
}

/** 发送已经组装好的多模态 prompt；调用语义与 sendPrompt 完全一致。 */
export async function sendPromptParts(sessionId: string, parts: PromptContentPart[]): Promise<{ ok: boolean, error?: string }> {
  try {
    const res = await agos.call('session.prompt', {
      sessionId: sessionId as never,
      mode: 'steer',
      content: parts,
      clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    })
    if (!res.result.ok) return { ok: false, error: JSON.stringify(res.result.error) }
    return { ok: true }
  } catch (error) {
    return { ok: false, error: String((error as Error)?.message ?? error) }
  }
}

// ── telemetry(agos overview + swarm progress,插件路由,同源直 fetch)──────
export interface TelemetryState {
  overview: Record<string, unknown> | undefined
  progress: { calls: Record<string, unknown>[] } | undefined
  at: number
}

const telemetryEmitter = createEmitter()
let telemetryState: TelemetryState = { overview: undefined, progress: undefined, at: 0 }
let telemetryTimer: ReturnType<typeof setInterval> | undefined

async function refreshTelemetry(): Promise<void> {
  const next: TelemetryState = { ...telemetryState, at: Date.now() }
  try {
    const r = await fetch('/api/agos/overview')
    if (r.ok) next.overview = await r.json() as Record<string, unknown>
  } catch { /* 软依赖:插件缺席则该组缺席 */ }
  try {
    const r = await fetch('/api/swarm/progress')
    if (r.ok) {
      const d = await r.json() as Record<string, unknown>
      const calls = Object.entries((d['calls'] ?? d) as Record<string, unknown>)
        .filter(([, v]) => typeof v === 'object' && v !== null)
        .map(([callId, v]) => ({ callId, ...(v as Record<string, unknown>) }))
      next.progress = { calls }
    }
  } catch { /* 同上 */ }
  telemetryState = next
  telemetryEmitter.emit()
}

export const telemetryStore = {
  subscribe(l: Listener): () => void {
    if (telemetryTimer === undefined) {
      void refreshTelemetry()
      telemetryTimer = setInterval(() => { if (!document.hidden) void refreshTelemetry() }, 10_000)
    }
    return telemetryEmitter.subscribe(l)
  },
  getSnapshot(): TelemetryState { return telemetryState },
}


// ── 模式 / 模型 / 建会话 / 记忆图谱(V5 接线)────────────────────────────
export interface PresetInfo { id: string, name: string, description: string, isDefault: boolean }
export async function fetchPresets(): Promise<PresetInfo[]> {
  const res = await agos.call('agentPreset.list', {})
  if (!res.result.ok) return []
  const v = res.result.value as unknown as Record<string, unknown>
  const list = (v['presets'] ?? []) as Record<string, unknown>[]
  return list.map((p) => ({
    id: String(p['id'] ?? ''), name: String(p['name'] ?? p['id'] ?? ''),
    description: String(p['description'] ?? ''), isDefault: p['isDefault'] === true,
  })).filter((p) => p.id !== '')
}

export interface ModelGroup { provider: string, models: { id: string, name: string }[] }
export interface SessionModels { current: { provider: string, model: string } | undefined, groups: ModelGroup[] }
export async function fetchSessionModels(sessionId: string): Promise<SessionModels> {
  const res = await agos.call('session.models', { sessionId: sessionId as never })
  if (!res.result.ok) return { current: undefined, groups: [] }
  const v = res.result.value as unknown as Record<string, unknown>
  const cur = v['current'] as Record<string, unknown> | undefined
  const groups = ((v['groups'] ?? []) as Record<string, unknown>[]).map((g) => ({
    provider: String(g['provider'] ?? g['id'] ?? ''),
    models: ((g['models'] ?? []) as Record<string, unknown>[]).map((m) => ({
      id: String(m['id'] ?? ''), name: String(m['name'] ?? m['id'] ?? ''),
    })),
  })).filter((g) => g.provider !== '' && g.models.length > 0)
  return {
    current: cur !== undefined ? { provider: String(cur['provider'] ?? ''), model: String(cur['model'] ?? '') } : undefined,
    groups,
  }
}
export async function selectSessionModel(sessionId: string, provider: string, model: string): Promise<boolean> {
  const res = await agos.call('session.selectModel', { sessionId: sessionId as never, provider, model })
  return res.result.ok
}

export async function createSession(params: { cwd: string, agentPreset?: string }): Promise<string | undefined> {
  const payload: Record<string, unknown> = { cwd: params.cwd }
  if (params.agentPreset !== undefined) payload['agentPreset'] = params.agentPreset
  const res = await agos.call('session.create', payload as never)
  if (!res.result.ok) return undefined
  const sid = String((res.result.value as unknown as Record<string, unknown>)['sessionId'] ?? '')
  if (sid !== '') { void refreshSessions(); openConversation(sid) }
  return sid !== '' ? sid : undefined
}

// ── P0-2 ProgressDock 派生 selector(仅新增导出,不改任何既有函数与字段)──
/** 单个 swarm 批次的进度汇总(来自 /api/swarm/progress 的 calls[n].rows)。 */
export interface SwarmBatchProgress {
  callId: string
  label: string
  done: number
  failed: number
  total: number
}

/** 全局运行中批次汇总;无运行中批次时 selector 返回 undefined。 */
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
    // 已结清(完成+失败=全部)的批次不算运行中,不进坞
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

/**
 * ProgressDock 专用 store 视图:复用 telemetryStore 的订阅(含 10s 轮询启动),
 * 快照按 telemetryState 引用缓存,保证 useSyncExternalStore 引用稳定不空转。
 */
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
