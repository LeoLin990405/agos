/**
 * AgOS contract-layer barrel, aligned to DSH 0.1.2-rc.1. api/ has zero Node
 * dependencies and is browser-importable. The membrane mirrors only what AgOS
 * consumes: the two-envelope transport, the single-mux stream + $events frames,
 * and the ~14 unary methods the SPA calls.
 */

// ---- Domain interfaces and payload entities ----
export type {
  ModelCatalog, ModelCatalogFailure, ModelCatalogModel, ModelProviderGroup, ModelReasoning,
  ModelReasoningEffort, ModelSelection, PromptContentPart, QueueAction, SessionAddress,
  SessionFollowFrame, SessionHistoryRecord, SessionEventEntry, SessionChunkRun, SessionRequestId,
  SessionListMetadata, SessionProjectionsBlock, SessionProjectionBaseline, SessionSearchItem,
  SessionsApi, SessionSummary, SessionWireEvent, SessionWireHeader,
} from './sessions.ts'
export type { WorkspaceView, WorkspaceId, WorkspaceBaseline, WorkspaceFollowFrame, WorkspaceFollowIncrement } from './workspace.ts'
export type { SkillsApi, SkillEntry } from './skills.ts'
export type { AgentPresetsApi, AgentPresetEntry } from './agent-presets.ts'
export type { SettingsApi, SettingsDescribeValue, SettingsNamespaceView, SettingsPathOpView, SettingsSecretView } from './settings.ts'
export type { CredentialsApi, CredentialInfo } from './credentials.ts'
export type { LlmApi, LlmProviderInfo, LlmConfigurableProvider } from './llm.ts'

// ---- Message layer: narrow forms ----
export type { RpcRequest, RpcResponse } from './rpc.ts'

// ---- Message layer: two wire envelopes ----
export type { ClientRequest, RpcMessage, ServerResponse } from './rpc.ts'

// ---- Stream + $events frames ----
export {
  REMOTE_STREAM_MUX_PATH, REMOTE_EVENT_STREAM_ENDPOINT, REMOTE_EVENT_RESULT_ENDPOINT,
  REMOTE_EVENT_STREAM_PAYLOAD,
} from './rpc.ts'
export type {
  RemoteStreamClientMessage, RemoteStreamServerMessage,
  RemoteEventClientId, RemoteEventId, RemoteEventAgentId,
  RemoteEventDownlinkFrame, RemoteEventReadyFrame, RemoteEventEmitFrame,
  RemoteEventInvocationFrame, RemoteEventCancellationFrame, RemoteEventRejection, RemoteEventResult,
} from './rpc.ts'

// ---- Errors and ids ----
export { RpcId, transportError } from './rpc.ts'
export type { RpcError, RpcResult } from './rpc.ts'
export {
  clientRequestSchema, serverResponseSchema, remoteStreamServerMessageSchema,
  remoteEventDownlinkFrameSchema,
} from './rpc.schema.ts'

// ---- Fixed session-search product bounds ----
export {
  SESSION_SEARCH_RESULT_LIMIT,
  SESSION_SEARCH_SNIPPET_MAX_CODE_POINTS,
} from './session-search.ts'

// ---- Method registry and derived generics ----
export type { RequestPayload, ResponseValue, RpcMethodMap } from './rpc-map.ts'
