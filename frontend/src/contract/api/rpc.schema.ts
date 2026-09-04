/**
 * Runtime validation for Connection RPC envelopes and mux frames — aligned to
 * DSH 0.1.2-rc.1. Two envelopes (client-request/server-response), open-string
 * error {code,message,details}, plus the logical-stream and $events frame
 * parsers used by the single /api/remote.mux WebSocket.
 *
 * Two-level parse discipline: the envelope schemas keep the value/payload slot
 * wide (unknown); each endpoint's own value schema runs the second parse.
 * Brand cast point: rpcIdSchema, and only there.
 */

import { z } from 'zod'
import type {
  ClientRequest, RemoteEventDownlinkFrame, RemoteStreamServerMessage,
  RpcError, RpcId, RpcMessage, ServerResponse,
} from './rpc.ts'

/**
 * Wire widening of a contract type: widens every property (deeply) to
 * `original | undefined`. The repo enables exactOptionalPropertyTypes while zod
 * `.optional()` outputs `T | undefined`, so anchoring is written
 * `satisfies z.ZodType<Wire<ContractType>>`. Absent and undefined serialize
 * identically on the JSON wire, so the widening loses no validation semantics.
 */
export type Wire<T> = T extends readonly (infer E)[] ? Wire<E>[]
  : T extends object ? { [K in keyof T]: Wire<T[K]> | undefined }
    : T

/**
 * RpcId: one brand cast after schema validation (the only cast point). No
 * min-length: the id is an opaque echo token; rejecting values here would only
 * turn a correlatable report into a client-side parse failure.
 */
export const rpcIdSchema = z.string() as unknown as z.ZodType<RpcId>

/** Open namespaced endpoint failure: {code, message, details}. */
export const rpcErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  details: z.record(z.string(), z.unknown()),
}) as unknown as z.ZodType<RpcError>

/**
 * Business success/failure result schema (generic, reusable).
 * @param value - schema for the business value.
 * @returns schema for RpcResult<T>.
 */
export function rpcResultSchema<T>(value: z.ZodType<T>): z.ZodUnion<readonly [z.ZodType, z.ZodType]> {
  return z.union([
    z.object({ ok: z.literal(true), value }),
    z.object({ ok: z.literal(false), error: rpcErrorSchema }),
  ])
}

/** ClientRequest envelope (payload stays wide — the business layer runs the second parse). */
export const clientRequestSchema = z.object({
  type: z.literal('client-request'),
  rpcId: rpcIdSchema,
  method: z.string(),
  payload: z.unknown(),
}) as unknown as z.ZodType<ClientRequest>

/** ServerResponse envelope (result.value stays wide; a void result omits value). */
export const serverResponseSchema = z.object({
  type: z.literal('server-response'),
  rpcId: rpcIdSchema,
  result: rpcResultSchema(z.unknown().optional()),
}) as unknown as z.ZodType<ServerResponse>

/** Wire envelope union (discriminated by type). */
export const rpcMessageSchema = z.discriminatedUnion('type', [
  clientRequestSchema as unknown as z.ZodObject<z.ZodRawShape>,
  serverResponseSchema as unknown as z.ZodObject<z.ZodRawShape>,
]) as unknown as z.ZodType<RpcMessage>

// ---- Logical stream frames over /api/remote.mux ----

/** Host→Client logical-stream frame: item (with wide value) | error | end. */
export const remoteStreamServerMessageSchema = z.union([
  z.object({ type: z.literal('item'), streamId: z.string(), value: z.unknown().optional() }),
  z.object({ type: z.literal('error'), streamId: z.string(), error: rpcErrorSchema }),
  z.object({ type: z.literal('end'), streamId: z.string() }),
]) as unknown as z.ZodType<RemoteStreamServerMessage>

// ---- $events downlink frames ----

/** Forwarded-event stream frame: ready | emit | waterfall | cancel (payloads stay wide). */
export const remoteEventDownlinkFrameSchema = z.union([
  z.object({ type: z.literal('ready'), clientId: z.string(), host: z.object({ home: z.string() }) }),
  z.object({ type: z.literal('emit'), event: z.string(), args: z.array(z.unknown()) }),
  z.object({
    type: z.literal('waterfall'),
    event: z.string(),
    eventId: z.string(),
    agentId: z.string(),
    request: z.record(z.string(), z.unknown()),
  }),
  z.object({ type: z.literal('cancel'), eventId: z.string() }),
]) as unknown as z.ZodType<RemoteEventDownlinkFrame>
