/**
 * sessions domain zod schemas — AgOS membrane, aligned to DSH 0.1.2-rc.1.
 * Two-level parse: envelope stays wide, these value schemas run the second parse.
 * SessionId brand cast point: sessionIdSchema, and only there.
 */

import { z } from 'zod'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { RequestPayload, ResponseValue } from './rpc-map.ts'
import type { Wire } from './rpc.schema.ts'
import type {
  ModelCatalog, ModelCatalogFailure, ModelCatalogModel, ModelProviderGroup, ModelReasoning,
  ModelReasoningEffort, ModelSelection, SessionAddress, SessionFollowFrame, SessionHistoryRecord,
  SessionSearchItem, SessionSummary, SessionWireEvent,
} from './sessions.ts'
import type { AttachmentIdType, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import {
  SESSION_SEARCH_RESULT_LIMIT,
  SESSION_SEARCH_SNIPPET_MAX_CODE_POINTS,
  truncateUnicodeCodePoints,
} from './session-search.ts'

/** SessionId: one brand cast after schema validation (the only cast point in this domain). */
export const sessionIdSchema = z.string().min(1) as unknown as z.ZodType<SessionId>

/** Client-minted prompt request id (opaque; the client mints a UUID). */
export const sessionRequestIdSchema = z.string().min(1)

/** SessionWireEvent passthrough: strict envelope (type/seq/time), wide data. */
export const sessionWireEventSchema = z.object({
  type: z.string(),
  seq: z.number().int().nonnegative(),
  time: z.number(),
  data: z.unknown(),
  ignorable: z.literal(true).optional(),
  sourceEventSeqs: z.array(z.number()).optional(),
  surfaceOp: z.unknown().optional(),
}) as unknown as z.ZodType<Wire<SessionWireEvent>>

/** One history-page record: raw event or packed Assistant delta run. */
export const sessionHistoryRecordSchema = z.union([
  z.object({ type: z.literal('event'), event: sessionWireEventSchema }),
  z.object({ type: z.literal('chunks'), event: z.object({ type: z.string(), seq: z.number(), time: z.number(), data: z.unknown() }) }),
]) as unknown as z.ZodType<Wire<SessionHistoryRecord>>

/** SessionSummary row of session/list. */
export const sessionSummarySchema = z.object({
  sessionId: sessionIdSchema,
  updatedAt: z.number(),
  running: z.boolean(),
  blank: z.boolean(),
  parentSessionId: sessionIdSchema.optional(),
  origin: z.literal('subagent').optional(),
  cwd: z.string().optional(),
  projections: z.object({ asOfSeq: z.number().int().min(-1), values: z.record(z.string(), z.unknown()) }).optional(),
}) as unknown as z.ZodType<Wire<SessionSummary>>

/** session/list request payload (cursor reserved). */
export const sessionListRequestSchema = z.object({
  cursor: z.string().optional(),
}) satisfies z.ZodType<Wire<RequestPayload<'session/list'>>>

/** session/list response value. */
export const sessionListValueSchema: z.ZodType<Wire<ResponseValue<'session/list'>>> = z.object({
  items: z.array(sessionSummarySchema),
})

/** Fixed wire bound for one interactive sidebar query. */
const SESSION_SEARCH_QUERY_MAX_CHARS = 500

/** session/search request payload. */
export const sessionSearchRequestSchema = z.object({
  query: z.string().trim().min(1).max(SESSION_SEARCH_QUERY_MAX_CHARS)
    .refine(query => !query.includes('\0'), { message: 'search query must not contain NUL' }),
}) satisfies z.ZodType<Wire<RequestPayload<'session/search'>>>

/** One session/search result. */
export const sessionSearchItemSchema = z.object({
  sessionId: sessionIdSchema,
  snippet: z.string().refine(
    snippet => truncateUnicodeCodePoints(snippet, SESSION_SEARCH_SNIPPET_MAX_CODE_POINTS) === snippet,
    { message: `search snippet must contain at most ${SESSION_SEARCH_SNIPPET_MAX_CODE_POINTS} Unicode code points` },
  ),
}) satisfies z.ZodType<Wire<SessionSearchItem>>

/** session/search response value. */
export const sessionSearchValueSchema = z.object({
  items: z.array(sessionSearchItemSchema).max(SESSION_SEARCH_RESULT_LIMIT),
  hasMore: z.boolean(),
}) satisfies z.ZodType<Wire<ResponseValue<'session/search'>>>

/** session/create request payload. */
export const sessionCreateRequestSchema = z.object({
  cwd: z.string().optional(),
  sessionId: sessionIdSchema.optional(),
  agentPreset: z.string().optional(),
}) satisfies z.ZodType<Wire<RequestPayload<'session/create'>>>

/** session/create response value. */
export const sessionCreateValueSchema = z.object({
  sessionId: sessionIdSchema,
  agentPreset: z.string().optional(),
}) satisfies z.ZodType<Wire<ResponseValue<'session/create'>>>

/** Durable address selecting an ordinary session or one direct subagent child. */
export const sessionAddressSchema = z.union([
  z.object({ kind: z.literal('session'), sessionId: sessionIdSchema }),
  z.object({
    kind: z.literal('subagent'),
    parentSessionId: sessionIdSchema,
    childSessionId: sessionIdSchema,
    mode: z.union([z.literal('one-shot'), z.literal('continuable')]),
  }),
]) as unknown as z.ZodType<Wire<SessionAddress>>

/** session/page request payload (throughSeq is the inclusive cut from the follow snapshot cursor). */
export const sessionPageRequestSchema = z.object({
  address: sessionAddressSchema,
  throughSeq: z.number().int().min(-1),
  beforeSeq: z.number().int().nonnegative().optional(),
  maxMessages: z.number().int().positive().optional(),
}) as unknown as z.ZodType<Wire<RequestPayload<'session/page'>>>

/** session/page response value. */
export const sessionPageValueSchema: z.ZodType<Wire<ResponseValue<'session/page'>>> = z.object({
  records: z.array(sessionHistoryRecordSchema),
  hasMore: z.boolean(),
})

/** session/follow stream item: opening snapshot then per-event frames. */
export const sessionFollowFrameSchema = z.union([
  z.object({
    type: z.literal('snapshot'),
    header: z.looseObject({ version: z.number(), id: sessionIdSchema, createdAt: z.number() }),
    cursor: z.number().int().min(-1),
    records: z.array(sessionHistoryRecordSchema),
    hasMore: z.boolean(),
    projections: z.object({ asOfSeq: z.number().int().min(-1), values: z.record(z.string(), z.unknown()) }),
  }),
  z.object({ type: z.literal('event'), event: sessionWireEventSchema }),
]) as unknown as z.ZodType<Wire<SessionFollowFrame>>

/** session/rename request payload. */
export const sessionRenameRequestSchema = z.object({
  sessionId: sessionIdSchema,
  title: z.string(),
}) satisfies z.ZodType<Wire<RequestPayload<'session/rename'>>>

/** session/rename response value. */
export const sessionRenameValueSchema = z.object({
  title: z.string().min(1),
  seq: z.number().int().nonnegative(),
}) satisfies z.ZodType<Wire<ResponseValue<'session/rename'>>>

/** Complete provider/model selection. */
export const modelSelectionSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
  reasoningEffort: z.string().min(1).optional(),
}) satisfies z.ZodType<Wire<ModelSelection>>

/** One adapter-owned reasoning effort. */
export const modelReasoningEffortSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
}) satisfies z.ZodType<Wire<ModelReasoningEffort>>

/** Exact-model reasoning metadata. */
export const modelReasoningSchema = z.object({
  efforts: z.array(modelReasoningEffortSchema).min(1),
  defaultEffort: z.string().min(1).optional(),
}) satisfies z.ZodType<Wire<ModelReasoning>>

/** One advisory model entry inside a provider group. */
export const modelCatalogModelSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
  reasoning: modelReasoningSchema.optional(),
}) satisfies z.ZodType<Wire<ModelCatalogModel>>

/** One successfully loaded provider group. */
export const modelProviderGroupSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  models: z.array(modelCatalogModelSchema),
}) satisfies z.ZodType<Wire<ModelProviderGroup>>

/** One provider-local catalog failure. */
export const modelCatalogFailureSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  message: z.string(),
}) satisfies z.ZodType<Wire<ModelCatalogFailure>>

/** session/modelCatalog request payload. */
export const sessionModelCatalogRequestSchema = z.object({
  sessionId: sessionIdSchema,
}) satisfies z.ZodType<Wire<RequestPayload<'session/modelCatalog'>>>

/** session/modelCatalog response value. */
export const sessionModelCatalogValueSchema = z.object({
  default: modelSelectionSchema,
  routableProviders: z.array(z.string()),
  groups: z.array(modelProviderGroupSchema),
  failures: z.array(modelCatalogFailureSchema),
}) satisfies z.ZodType<Wire<ModelCatalog>>

/** session/selectModel request payload. */
export const sessionSelectModelRequestSchema = z.object({
  sessionId: sessionIdSchema,
  provider: z.string().min(1),
  model: z.string().min(1),
  reasoningEffort: z.string().min(1).optional(),
}) satisfies z.ZodType<Wire<RequestPayload<'session/selectModel'>>>

/** session/selectModel response value. */
export const sessionSelectModelValueSchema = z.object({
  selected: modelSelectionSchema,
}) satisfies z.ZodType<Wire<ResponseValue<'session/selectModel'>>>

/** Raster image media types accepted by the browser wire. */
export const imageMediaTypeSchema = z.union([
  z.literal('image/png'),
  z.literal('image/jpeg'),
  z.literal('image/webp'),
  z.literal('image/gif'),
])

/** Prompt wire content is intentionally narrower than merge-extensible durable core content. */
export const promptContentPartSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({ type: z.literal('image'), mediaType: imageMediaTypeSchema, data: z.string(), name: z.string().optional() }),
])

/** session/prompt request payload (requestId is client-minted and persisted on the accepted message). */
export const sessionPromptRequestSchema = z.object({
  requestId: sessionRequestIdSchema,
  sessionId: sessionIdSchema,
  mode: z.union([z.literal('queue'), z.literal('steer')]),
  content: z.array(promptContentPartSchema),
  clientTimeZone: z.string().optional(),
}) as unknown as z.ZodType<RequestPayload<'session/prompt'>>

/** session/prompt response value. */
export const sessionPromptValueSchema = z.object({
  accepted: z.literal(true),
}) satisfies z.ZodType<Wire<ResponseValue<'session/prompt'>>>

/** Opaque attachment id after string-shape validation. */
export const attachmentIdSchema = z.string().min(1) as unknown as z.ZodType<AttachmentIdType>

/** Durable image reference returned from the authenticated session lookup. */
export const imageAttachmentRefSchema = z.object({
  attachmentId: attachmentIdSchema,
  mediaType: imageMediaTypeSchema,
  bytes: z.number().int().positive(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  name: z.string().optional(),
}) as unknown as z.ZodType<ImageAttachmentRef>

/** session/attachment request payload. */
export const sessionAttachmentRequestSchema = z.object({
  sessionId: sessionIdSchema,
  attachmentId: attachmentIdSchema,
}) satisfies z.ZodType<Wire<RequestPayload<'session/attachment'>>>

/** session/attachment response value. */
export const sessionAttachmentValueSchema = z.object({
  attachment: imageAttachmentRefSchema,
  data: z.string(),
}) satisfies z.ZodType<Wire<ResponseValue<'session/attachment'>>>

/** session/canOpenWorkspacePath request payload (empty args). */
export const sessionCanOpenWorkspacePathRequestSchema = z.object({}) as unknown as z.ZodType<Wire<RequestPayload<'session/canOpenWorkspacePath'>>>

/** session/canOpenWorkspacePath response value (bare boolean). */
export const sessionCanOpenWorkspacePathValueSchema: z.ZodType<Wire<ResponseValue<'session/canOpenWorkspacePath'>>> = z.boolean()

/** session/openWorkspacePath request payload. */
export const sessionOpenWorkspacePathRequestSchema = z.object({
  path: z.string(),
}) satisfies z.ZodType<Wire<RequestPayload<'session/openWorkspacePath'>>>

/** session/openWorkspacePath response value. */
export const sessionOpenWorkspacePathValueSchema = z.object({
  opened: z.literal(true),
}) satisfies z.ZodType<Wire<ResponseValue<'session/openWorkspacePath'>>>
