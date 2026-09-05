/**
 * sessions domain contract — AgOS membrane, aligned to DSH 0.1.2-rc.1.
 *
 * 0.1.2 folded the former host.* unary calls onto the session owner and split
 * live reads into one WebSocket stream (session/follow) plus a backwards pager
 * (session/page); the rc.2 session.history unary is gone. Method signatures are
 * the source of truth; rpc-map derives RequestPayload/ResponseValue from them.
 */

import type { AttachmentIdType, ImageAttachmentLimits, ImageAttachmentRef, ImageMediaType } from '@deepseek-ai/dsh-attachment'
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { ContentBlock } from '@deepseek-ai/dsh-llm/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionProjectionMap } from '@deepseek-ai/dsh-session-projection/types'
import type { RpcId, RpcRequest, RpcResponse } from './rpc.ts'

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    sessionListMetadata: SessionListMetadata
    imageLimits: null
  }
  interface SessionProjectionMap {
    /** Persisted list hints; `blank:false` is monotonic, `lastPromptAt` is the latest human prompt time. */
    sessionListMetadata: SessionListMetadata
    /** Deployment image-intake limits enforced at prompt admission; key absence means no attachment service. */
    imageLimits: ImageAttachmentLimits
  }
}

/** Persisted hints used to summarize a cold Session without reading a large log. */
export interface SessionListMetadata {
  blank: boolean
  lastPromptAt: number | null
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** Browser prompt correlation (requestId) plus the optional Host-validated time zone. */
    'user-rpc': { kind: 'user'; rpcId: RpcId; clientTimeZone?: string }
  }
}

/** Client-minted prompt identity used to reconcile the optimistic echo with the durable message. */
export type SessionRequestId = Branded<'session-request-id'>

/** Whole current value per registered projection key, at an exact log cut. */
export interface SessionProjectionsBlock {
  /** Seq of the last event the values reflect; -1 for an empty log. */
  asOfSeq: number
  values: Partial<SessionProjectionMap>
}

/** Browser-submitted prompt content; the host promotes image bytes to durable references. */
export type PromptContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; mediaType: ImageMediaType; data: string; name?: string }

/** Complete model selection for one session. */
export interface ModelSelection {
  provider: string
  model: string
  reasoningEffort?: string
}

/** One adapter-owned reasoning effort displayed for an exact model route. */
export interface ModelReasoningEffort {
  id: string
  name: string
  description?: string
}

/** Selectable reasoning metadata for one exact model route. */
export interface ModelReasoning {
  efforts: ModelReasoningEffort[]
  defaultEffort?: string
}

/** One model displayed inside its provider group. */
export interface ModelCatalogModel {
  id: string
  name: string
  description?: string
  reasoning?: ModelReasoning
}

/** One provider and the models it advertised successfully. */
export interface ModelProviderGroup {
  id: string
  name: string
  models: ModelCatalogModel[]
}

/** A provider whose catalog lookup failed. */
export interface ModelCatalogFailure {
  id: string
  name: string
  message: string
}

/**
 * Host-generation model catalog (session/modelCatalog). rc.1 replaced the rc.2
 * SessionModels.current/routable pair: the default is the deployment default,
 * and the session's own selection lives in the modelSelection projection.
 */
export interface ModelCatalog {
  default: ModelSelection
  /** Provider routes currently able to serve a request, including empty catalogs. */
  routableProviders: string[]
  groups: ModelProviderGroup[]
  failures: ModelCatalogFailure[]
}

/** A client-requested mutation of one still-pending queue item. */
export type QueueAction =
  | { kind: 'edit'; content: ContentBlock[] }
  | { kind: 'remove' }
  | { kind: 'steer' }

/** One Session list entry. */
export interface SessionSummary {
  sessionId: SessionId
  updatedAt: number
  running: boolean
  blank: boolean
  parentSessionId?: SessionId
  origin?: 'subagent'
  cwd?: string
  projections?: SessionProjectionsBlock
}

/** One session-content search result. */
export interface SessionSearchItem {
  sessionId: SessionId
  snippet: string
}

/** v0-compatible Session metadata carried on the browser wire (session/follow snapshot header). */
export interface SessionWireHeader {
  version: number
  id: SessionId
  createdAt: number
  cwd?: string
  parentSession?: SessionId
  seedLength?: number
  origin?: 'subagent'
  delegationDepth?: number
  agentPreset?: string
}

/** Browser wire form of one Session surface operation. */
export type SessionWireSurfaceOp =
  | 'append'
  | { op: 'replace'; start: number; end: number }

/** Session event wire form; durable readers own recognition of merge-extensible event names. */
export interface SessionWireEvent {
  type: string
  seq: number
  time: number
  data: unknown
  ignorable?: true
  sourceEventSeqs?: number[]
  surfaceOp?: SessionWireSurfaceOp
}

/** One raw Session event in the Remote journal. */
export interface SessionEventEntry {
  type: 'event'
  event: SessionWireEvent
}

/** One lossless run of consecutive Assistant delta events in a history page. */
export interface SessionChunkRun {
  type: 'chunks'
  event: { type: string; seq: number; time: number; data: unknown }
}

/** One history-page record: a raw event or a packed Assistant delta run. */
export type SessionHistoryRecord = SessionEventEntry | SessionChunkRun

/** Durable identity selecting an ordinary Session or one direct subagent child. */
export type SessionAddress =
  | { kind: 'session'; sessionId: SessionId }
  | { kind: 'subagent'; parentSessionId: SessionId; childSessionId: SessionId; mode: 'one-shot' | 'continuable' }

/** Complete projection values at an exact Session event cursor. */
export interface SessionProjectionBaseline {
  asOfSeq: number
  values: Partial<SessionProjectionMap>
}

/** session/follow opening window followed by ordered events appended after its cursor. */
export type SessionFollowFrame =
  | {
    type: 'snapshot'
    header: SessionWireHeader
    cursor: number
    records: SessionHistoryRecord[]
    hasMore: boolean
    projections: SessionProjectionBaseline
  }
  | SessionEventEntry

/** Session-domain unary methods (map keys session/* of RpcMethodMap). */
export interface SessionsApi {
  /** Lists persisted sessions (updatedAt descending). Cold-safe; cursor reserved. */
  list(request: RpcRequest<{ cursor?: string }>): Promise<RpcResponse<{ items: SessionSummary[] }>>

  /** Searches visible sessions' message surface; at most 20 results, `hasMore` asks to refine. */
  search(request: RpcRequest<{ query: string }>, signal: AbortSignal):
  Promise<RpcResponse<{ items: SessionSearchItem[]; hasMore: boolean }>>

  /** Creates a real session and its idle agent; preallocated id retries same-cwd are idempotent. */
  create(request: RpcRequest<{ cwd?: string; sessionId?: SessionId; agentPreset?: string }>):
  Promise<RpcResponse<{ sessionId: SessionId; agentPreset?: string }>>

  /**
   * Reads one message-aligned backwards page (session/page). `throughSeq` is the
   * inclusive cut from the corresponding follow snapshot cursor (-1 = empty).
   */
  page(request: RpcRequest<{ address: SessionAddress; throughSeq: number; beforeSeq?: number; maxMessages?: number }>):
  Promise<RpcResponse<{ records: SessionHistoryRecord[]; hasMore: boolean }>>

  /** Reads the Host-generation model catalog for an ordinary session (session/modelCatalog). */
  modelCatalog(request: RpcRequest<{ sessionId: SessionId }>): Promise<RpcResponse<ModelCatalog>>

  /** Selects the complete model selection for this session; catalog membership stays advisory. */
  selectModel(request: RpcRequest<{ sessionId: SessionId; provider: string; model: string; reasoningEffort?: string }>):
  Promise<RpcResponse<{ selected: ModelSelection }>>

  /** Renames a session; returns the normalized title and the committing event seq. */
  rename(request: RpcRequest<{ sessionId: SessionId; title: string }>):
  Promise<RpcResponse<{ title: string; seq: number }>>

  /**
   * Sends text and temporary image bytes to an ordinary session Agent.
   * requestId is client-minted and persisted on the accepted user message.
   */
  prompt(request: RpcRequest<{
    requestId: SessionRequestId
    sessionId: SessionId
    mode: 'queue' | 'steer'
    content: PromptContentPart[]
    clientTimeZone?: string
  }>):
  Promise<RpcResponse<{ accepted: true }>>

  /** Reads one durable image after proving this session's log references its id. */
  attachment(request: RpcRequest<{ sessionId: SessionId; attachmentId: AttachmentIdType }>):
  Promise<RpcResponse<{ attachment: ImageAttachmentRef; data: string }>>

  /** Whether the Host can open a workspace path in its native file manager (session/canOpenWorkspacePath). */
  canOpenWorkspacePath(request: RpcRequest<Record<string, never>>): Promise<RpcResponse<boolean>>

  /** Opens a Session-resolved workspace path on the Host desktop (session/openWorkspacePath, was host.openPath). */
  openWorkspacePath(request: RpcRequest<{ path: string }>): Promise<RpcResponse<{ opened: true }>>
}
