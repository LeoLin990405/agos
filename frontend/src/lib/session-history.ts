/**
 * Session history window + backwards pager (session/page).
 *
 * Does not own or rewrite fold. ReplayScrubber is a render-window seeker over
 * the current fold items; it is not historical reconstruction. Completeness
 * lives here (`historyIncomplete`).
 *
 * ── Apply API for live.ts (keep applyRecord identical) ──────────────────────
 *
 * live.ts already applies one record like this — copy, do not reinvent:
 *
 *   function applyRecord(fold: Fold, record: SessionHistoryRecord): number {
 *     if (record.type === 'chunks') {
 *       const expanded = expandChunkRun(record.event)
 *       let last = Number.NaN
 *       for (const ev of expanded) { fold.apply(ev); last = ev.seq }
 *       return last
 *     }
 *     fold.apply(record.event)
 *     return Number(record.event.seq ?? Number.NaN)
 *   }
 *
 * Opening snapshot / follow reconnect (`applyMode === 'snapshot-host-order'`):
 *   fold = createFold()
 *   for (const record of state.recordsToApply) applyRecord(fold, record)
 *   recordsToApply is snapshot.records in host array order — the same loop
 *   onFollowValue uses today. Do not sort.
 *
 * After an older page merges (`applyMode === 'union-seq-order'`):
 *   fold = createFold()
 *   for (const record of state.recordsToApply) applyRecord(fold, record)
 *   union of held records, seq-ascending. Fold cannot prepend; rebuild is
 *   required. Still the same applyRecord, not a fold change.
 *
 * Live `event` frames after the opening snapshot stay on live.ts's incremental
 * path (skip if seq <= lastSeq). Call `noteLiveEvent` so a later page rebuild
 * can replay the tail (`seq > throughSeq`). `throughSeq` stays the snapshot
 * cursor, never the live tip.
 *
 * Page failure sets historyIncomplete + retryable and leaves the current
 * window in place. Never treat that window as the full session.
 */

import type {
  SessionAddress,
  SessionHistoryRecord,
  SessionProjectionBaseline,
  SessionWireEvent,
  SessionWireHeader,
} from '../contract/api/sessions.ts'

/** Host opening snapshot fields this helper consumes (follow `type:'snapshot'`). */
export interface FollowSnapshotInput {
  header: SessionWireHeader
  cursor: number
  records: SessionHistoryRecord[]
  hasMore: boolean
  projections: SessionProjectionBaseline
}

/**
 * Explicit controller action for `agos.call('session/page', …)`.
 * `throughSeq` is the inclusive cut from the corresponding follow snapshot
 * cursor (-1 = empty). `beforeSeq` is the oldest seq currently held.
 */
export interface LoadEarlierHistoryAction {
  type: 'load-earlier-history'
  method: 'session/page'
  address: SessionAddress
  throughSeq: number
  beforeSeq?: number
  maxMessages?: number
  generation: number
}

export type HistoryApplyMode = 'idle' | 'snapshot-host-order' | 'union-seq-order'

export interface SessionHistoryState {
  address: SessionAddress | undefined
  /** Inclusive cut from the follow snapshot cursor. -1 = empty log. */
  throughSeq: number
  oldestSeq: number | undefined
  newestSeq: number | undefined
  header: SessionWireHeader | undefined
  projections: SessionProjectionBaseline | undefined
  hasMore: boolean
  /** True when the current window is not the full session. */
  historyIncomplete: boolean
  /** Last page failed; the same load-earlier action may be retried. */
  retryable: boolean
  pageError: string | undefined
  /** Bumped on snapshot, cancel, and address replacement. Late pages drop. */
  generation: number
  pending: LoadEarlierHistoryAction | undefined
  heldRecords: SessionHistoryRecord[]
  /** Live frames after the snapshot cursor; replayed on page rebuild only. */
  liveTail: SessionHistoryRecord[]
  /** Feed these to applyRecord after createFold() when rebuildRequired. */
  recordsToApply: SessionHistoryRecord[]
  rebuildRequired: boolean
  applyMode: HistoryApplyMode
}

export function idleHistory(): SessionHistoryState {
  return {
    address: undefined,
    throughSeq: -1,
    oldestSeq: undefined,
    newestSeq: undefined,
    header: undefined,
    projections: undefined,
    hasMore: false,
    historyIncomplete: false,
    retryable: false,
    pageError: undefined,
    generation: 0,
    pending: undefined,
    heldRecords: [],
    liveTail: [],
    recordsToApply: [],
    rebuildRequired: false,
    applyMode: 'idle',
  }
}

export function sameAddress(a: SessionAddress | undefined, b: SessionAddress | undefined): boolean {
  if (a === undefined || b === undefined) return false
  if (a.kind !== b.kind) return false
  if (a.kind === 'session' && b.kind === 'session') return a.sessionId === b.sessionId
  if (a.kind === 'subagent' && b.kind === 'subagent') {
    return a.parentSessionId === b.parentSessionId
      && a.childSessionId === b.childSessionId
      && a.mode === b.mode
  }
  return false
}

export function historyRecordSeq(record: SessionHistoryRecord): number {
  return Number(record.event.seq)
}

export function isStaleHistoryResponse(
  state: SessionHistoryState,
  response: { address: SessionAddress; generation: number },
): boolean {
  return response.generation !== state.generation || !sameAddress(state.address, response.address)
}

/** Opening follow snapshot: store header/cursor/hasMore/projections; host record order. */
export function applyOpeningSnapshot(
  state: SessionHistoryState,
  address: SessionAddress,
  snapshot: FollowSnapshotInput,
): SessionHistoryState {
  const records = snapshot.records.slice()
  const edges = windowEdges(records)
  const hasMore = snapshot.hasMore === true
  return {
    address,
    throughSeq: snapshot.cursor,
    oldestSeq: edges.oldestSeq,
    newestSeq: edges.newestSeq,
    header: snapshot.header,
    projections: snapshot.projections,
    hasMore,
    historyIncomplete: hasMore,
    retryable: false,
    pageError: undefined,
    generation: state.generation + 1,
    pending: undefined,
    heldRecords: records,
    liveTail: [],
    recordsToApply: records.slice(),
    rebuildRequired: true,
    applyMode: 'snapshot-host-order',
  }
}

/**
 * Remember a post-snapshot live frame without changing applyMode.
 * live.ts still applies the event incrementally; this only protects the tail
 * when an older page later forces a fold rebuild.
 */
export function noteLiveEvent(
  state: SessionHistoryState,
  event: SessionWireEvent | SessionHistoryRecord,
): SessionHistoryState {
  if (state.address === undefined) return state
  const record: SessionHistoryRecord = isHistoryRecord(event) ? event : { type: 'event', event }
  const seq = historyRecordSeq(record)
  if (!Number.isFinite(seq) || seq <= state.throughSeq) return state
  if (hasSeq(state.heldRecords, seq) || hasSeq(state.liveTail, seq)) return state
  const liveTail = [...state.liveTail, record]
  const newestSeq = state.newestSeq === undefined ? seq : Math.max(state.newestSeq, seq)
  return { ...state, liveTail, newestSeq }
}

export function loadEarlierHistoryAction(
  state: SessionHistoryState,
  options?: { maxMessages?: number },
): LoadEarlierHistoryAction | undefined {
  if (state.address === undefined) return undefined
  if (state.pending !== undefined) return undefined
  if (!state.hasMore && !state.retryable && !state.historyIncomplete) return undefined
  if (state.throughSeq < 0 && !state.hasMore && !state.retryable) return undefined
  const action: LoadEarlierHistoryAction = {
    type: 'load-earlier-history',
    method: 'session/page',
    address: state.address,
    throughSeq: state.throughSeq,
    generation: state.generation,
  }
  if (state.oldestSeq !== undefined) action.beforeSeq = state.oldestSeq
  if (options?.maxMessages !== undefined) action.maxMessages = options.maxMessages
  return action
}

/** Marks an in-flight page so a second request is not issued. */
export function beginEarlierPage(
  state: SessionHistoryState,
  options?: { maxMessages?: number },
): { state: SessionHistoryState; action: LoadEarlierHistoryAction | undefined } {
  const action = loadEarlierHistoryAction(state, options)
  if (action === undefined) return { state, action: undefined }
  return { state: { ...state, pending: action, pageError: undefined }, action }
}

export function applyPageSuccess(
  state: SessionHistoryState,
  response: { address: SessionAddress; generation: number; records: SessionHistoryRecord[]; hasMore: boolean },
): SessionHistoryState {
  if (isStaleHistoryResponse(state, response)) return state
  const held = mergeRecords(state.heldRecords, response.records)
  const edges = windowEdges(held)
  const hasMore = response.hasMore === true
  const recordsToApply = mergeRecords(held, state.liveTail).slice().sort(compareRecords)
  const newestSeq = windowEdges(recordsToApply).newestSeq
  return {
    ...state,
    oldestSeq: edges.oldestSeq,
    newestSeq,
    hasMore,
    historyIncomplete: hasMore,
    retryable: false,
    pageError: undefined,
    pending: undefined,
    heldRecords: held,
    recordsToApply,
    rebuildRequired: true,
    applyMode: 'union-seq-order',
  }
}

/**
 * Page failure: keep the current window, mark incomplete + retryable.
 * Never flip hasMore to false — we did not learn the session is fully loaded.
 */
export function applyPageFailure(
  state: SessionHistoryState,
  failure: { address: SessionAddress; generation: number; error?: unknown },
): SessionHistoryState {
  if (isStaleHistoryResponse(state, failure)) return state
  return {
    ...state,
    historyIncomplete: true,
    retryable: true,
    pageError: messageOf(failure.error),
    pending: undefined,
    rebuildRequired: false,
  }
}

/** Session switch / dispose. Late pages for the previous generation are dropped. */
export function cancelHistory(state: SessionHistoryState): SessionHistoryState {
  return { ...idleHistory(), generation: state.generation + 1 }
}

function windowEdges(records: SessionHistoryRecord[]): { oldestSeq: number | undefined; newestSeq: number | undefined } {
  let oldest: number | undefined
  let newest: number | undefined
  for (const record of records) {
    const seq = historyRecordSeq(record)
    if (!Number.isFinite(seq)) continue
    oldest = oldest === undefined ? seq : Math.min(oldest, seq)
    newest = newest === undefined ? seq : Math.max(newest, seq)
  }
  return { oldestSeq: oldest, newestSeq: newest }
}

function mergeRecords(held: SessionHistoryRecord[], incoming: SessionHistoryRecord[]): SessionHistoryRecord[] {
  const seen = new Set<number>()
  const out: SessionHistoryRecord[] = []
  for (const record of [...held, ...incoming]) {
    const seq = historyRecordSeq(record)
    if (Number.isFinite(seq)) {
      if (seen.has(seq)) continue
      seen.add(seq)
    }
    out.push(record)
  }
  return out
}

function compareRecords(a: SessionHistoryRecord, b: SessionHistoryRecord): number {
  const aSeq = historyRecordSeq(a)
  const bSeq = historyRecordSeq(b)
  const aOk = Number.isFinite(aSeq)
  const bOk = Number.isFinite(bSeq)
  if (!aOk && !bOk) return 0
  if (!aOk) return 1
  if (!bOk) return -1
  return aSeq - bSeq
}

function messageOf(error: unknown): string {
  if (error instanceof Error && error.message.trim() !== '') return error.message
  if (typeof error === 'string' && error.trim() !== '') return error
  return 'session/page 失败'
}

function isHistoryRecord(value: SessionWireEvent | SessionHistoryRecord): value is SessionHistoryRecord {
  return value.type === 'event' || value.type === 'chunks'
    ? 'event' in value && typeof value.event === 'object' && value.event !== null
    : false
}

function hasSeq(records: SessionHistoryRecord[], seq: number): boolean {
  return records.some((record) => historyRecordSeq(record) === seq)
}
