/**
 * W12 mux 帧计数探针的纯 reducer(TASK-2026-08-22-017 第二档)。
 *
 * 背景:src/stores/live.ts:152 一行 `if (type !== 'session/event') return` 把契约里 10 类 MuxFrame
 * 砍到 2 类。QuestionPanel.tsx 113 行全仓零 import —— 「宿主是否真推 question/requested 帧」今天只有
 * 契约声明,没有观测。先只计数,跑一天,再决定接哪几个 UI。
 *
 * 两个坑由数据逼出来:
 * - mux 开连/重连会**回放**全部 pending 的 question/requested 与 approval/requested(apiproxy mux 开连基线),
 *   rpcId 原样复用 → 裸计数会重复。所以同时记原始计数与按 rpcId 去重的 distinct 数。
 * - createAgosClient 的 host 流(host/*)与 mux 流共用一个 client;host 帧不是 mux 的第 11 类,按前缀分开记。
 */
export const MUX_FRAME_TYPES = [
  'session/event', 'session/subscribed', 'approval/requested', 'approval/resolved',
  'question/requested', 'question/resolved', 'session/queue', 'session/jobs', 'session/projection', 'stream/error',
] as const
export type MuxFrameType = typeof MUX_FRAME_TYPES[number]

/** 这两类会被 mux 开连回放;按 rpcId 去重才是真实发问/审批次数。 */
const DEDUP_BY_RPC: ReadonlySet<string> = new Set(['question/requested', 'approval/requested'])

export interface ProbeState {
  startedAt: number
  lastFrameAt: number | null
  reconnects: number
  /** 每次 mux 开连的时刻;开连后 REPLAY_WINDOW_MS 内到达的帧算「开连回放」,另计不混进 byType。 */
  opens: number[]
  replayOnOpen: Record<string, number>
  /** 原始计数(含重连回放)。 */
  byType: Record<string, number>
  /** 按 rpcId 去重后的 distinct 数,只对 DEDUP_BY_RPC 两类。 */
  distinct: Record<string, number>
  /** 非 mux 的帧(host/* 等),不混进 byType。 */
  other: Record<string, number>
  /** 内部:见过的 rpcId。导出 JSON 时只写 size。 */
  seenRpc: Record<string, string[]>
}

/**
 * 宿主 mux 开连时会回放:pending 的 question/requested、approval/requested(rpcId 原样复用),以及 attached 会话的
 * session/subscribed、当前 session/queue、session/jobs 基线(fresh rpcId)。后三类靠 rpcId 去不了重,
 * 只能按「开连后一小段时间内到达」另计。实测一次开连的基线帧在 100ms 内到齐;窗口取 1s。
 */
export const REPLAY_WINDOW_MS = 1000

export function createProbeState(startedAt: number): ProbeState {
  return { startedAt, lastFrameAt: null, reconnects: 0, opens: [], replayOnOpen: {}, byType: {}, distinct: {}, other: {}, seenRpc: {} }
}

export function recordOpen(state: ProbeState, at: number): ProbeState {
  return { ...state, opens: [...state.opens, at] }
}

export function recordFrame(state: ProbeState, frame: { type: string; rpcId?: string }, at: number): ProbeState {
  const type = frame.type
  if (!(MUX_FRAME_TYPES as readonly string[]).includes(type)) {
    return { ...state, lastFrameAt: at, other: { ...state.other, [type]: (state.other[type] ?? 0) + 1 } }
  }
  const lastOpen = state.opens.at(-1)
  if (lastOpen !== undefined && at - lastOpen <= REPLAY_WINDOW_MS) {
    return { ...state, lastFrameAt: at, replayOnOpen: { ...state.replayOnOpen, [type]: (state.replayOnOpen[type] ?? 0) + 1 } }
  }
  const next: ProbeState = { ...state, lastFrameAt: at, byType: { ...state.byType, [type]: (state.byType[type] ?? 0) + 1 } }
  if (DEDUP_BY_RPC.has(type)) {
    const seen = state.seenRpc[type] ?? []
    const id = typeof frame.rpcId === 'string' && frame.rpcId ? frame.rpcId : `(no-rpcId)#${(state.byType[type] ?? 0) + 1}`
    if (!seen.includes(id)) {
      next.seenRpc = { ...state.seenRpc, [type]: [...seen, id] }
      next.distinct = { ...state.distinct, [type]: (state.distinct[type] ?? 0) + 1 }
    }
  }
  return next
}

export function recordReconnect(state: ProbeState): ProbeState {
  return { ...state, reconnects: state.reconnects + 1 }
}

/** 落盘形状:不带 seenRpc 的明细(rpcId 不该留在日志里),带 10 类全列(没来过的写 0,免得读的人分不清「没来」与「没统计」)。 */
export function snapshot(state: ProbeState, now: number): Record<string, unknown> {
  const byType: Record<string, number> = {}
  for (const t of MUX_FRAME_TYPES) byType[t] = state.byType[t] ?? 0
  return {
    startedAt: new Date(state.startedAt).toISOString(),
    snapshotAt: new Date(now).toISOString(),
    uptimeMs: now - state.startedAt,
    lastFrameAt: state.lastFrameAt === null ? null : new Date(state.lastFrameAt).toISOString(),
    reconnects: state.reconnects,
    opens: state.opens.length,
    /** 开连 1s 内到达的帧(宿主回放的基线):不算实推。 */
    replayOnOpen: state.replayOnOpen,
    /** 开连窗口之外到达的帧:这才是「宿主真的在推」。 */
    byType,
    distinct: { 'question/requested': state.distinct['question/requested'] ?? 0, 'approval/requested': state.distinct['approval/requested'] ?? 0 },
    /** 非 10 类的帧;注意契约外的 type 在 api-client 的 schema 就被丢了,不会到这里。 */
    other: state.other,
  }
}
