/**
 * Connection RPC primitives — AgOS membrane, aligned to DSH 0.1.2-rc.1.
 *
 * 0.1.2 collapsed the four-quadrant envelope model to two:
 *  - unary: POST /api/<ns>/<method>, body = ClientRequest, response = ServerResponse.
 *  - streams: ONE WebSocket /api/remote.mux multiplexes every logical Remote
 *    stream (session/follow, session/control, workspace/follow, $events) via
 *    {open,streamId,endpoint,payload}/{cancel} up and {item,error,end} down.
 *  - Host→Client asks (approval, user-question) ride the $events stream as
 *    `waterfall` frames and are answered by a normal unary POST to $events/result.
 *
 * The old server-request/client-response envelopes and the carrier RpcReceipt
 * are gone (envelope forms 4→2). Errors are now open namespaced strings
 * {code,message,details} — no closed union — so newer Host codes still surface.
 *
 * api/ contract layer: zero Node dependencies, importable from the browser.
 */

import type { Branded } from '@deepseek-ai/dsh-brand'

/**
 * Transport correlation id: the caller mints it per unary call and the
 * Connection response echoes it. Pure transport — business idempotency moved
 * into explicit request fields (session/prompt.requestId).
 */
export type RpcId = Branded<'rpc-id'>

/**
 * Brand a validated string as a Connection correlation id.
 * @param id - raw id string (the client mints UUIDs; tests may pass fixtures).
 * @returns the same string, branded (compile-time cast, zero runtime cost).
 */
export function RpcId(id: string): RpcId {
  return id as RpcId
}

/**
 * Carrier-neutral endpoint failure. 0.1.2 codes are open namespaced strings
 * (gateway/*, session/*, settings/*, credential/*, workspace/*, agent-preset/*,
 * subagent/*, directory-picker/*, llm/*); details is an arbitrary JSON object.
 */
export interface RpcError {
  readonly code: string
  readonly message: string
  readonly details: object
}

/** Business success/failure result: the result slot of a unary response. */
export type RpcResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: RpcError }

/**
 * Fold a transport exception into the RpcResult error branch (unified error
 * API; gateway/internal as the catch-all code, matching the Host vocabulary).
 * @param error - the thrown value from the carrier.
 * @returns the error branch of an RpcResult.
 */
export function transportError<T>(error: unknown): RpcResult<T> {
  return {
    ok: false,
    error: { code: 'gateway/internal', message: error instanceof Error ? error.message : String(error), details: {} },
  }
}

/** Signature-layer narrow request form: rpcId explicit, never mixed into payload. */
export interface RpcRequest<P> {
  readonly rpcId: RpcId
  readonly payload: P
}

/** Signature-layer narrow response form: rpcId always echoes the matching request. */
export interface RpcResponse<T> {
  readonly rpcId: RpcId
  readonly result: RpcResult<T>
}

// ---- Wire envelopes: two named members (discriminant = the two `type` literals) ----

/**
 * Call initiated by the client (wire carrier: POST /api/<ns>/<method> body).
 * For Typert endpoints `payload` MUST be exactly `{ args: {...plain object} }`
 * — one key, plain objects only; the Gateway rejects anything else.
 */
export interface ClientRequest {
  readonly type: 'client-request'
  readonly rpcId: RpcId
  readonly method: string
  readonly payload: unknown
}

/** Response to a ClientRequest (wire carrier: that POST's HTTP response body); rpcId echoed. */
export interface ServerResponse {
  readonly type: 'server-response'
  readonly rpcId: RpcId
  readonly result: RpcResult<unknown>
}

/** Authoritative wire envelope union; narrow via `switch (message.type)`. */
export type RpcMessage = ClientRequest | ServerResponse

// ---- Logical stream multiplexing over the single /api/remote.mux WebSocket ----

/** Exact WebSocket route carrying every Typert Remote stream. */
export const REMOTE_STREAM_MUX_PATH = '/api/remote.mux'

/** One logical stream request sent from the browser over the mux. */
export type RemoteStreamClientMessage =
  | { readonly type: 'open'; readonly streamId: string; readonly endpoint: string; readonly payload: unknown }
  | { readonly type: 'cancel'; readonly streamId: string }

/** One logical stream frame sent from the Host over the mux. */
export type RemoteStreamServerMessage =
  | { readonly type: 'item'; readonly streamId: string; readonly value?: unknown }
  | { readonly type: 'error'; readonly streamId: string; readonly error: RpcError }
  | { readonly type: 'end'; readonly streamId: string }

// ---- $events stream: forwarded Host events + Host→Client waterfall asks ----

/** Gateway-internal logical stream carrying application-selected Cordis events. */
export const REMOTE_EVENT_STREAM_ENDPOINT = '$events'

/** Gateway-internal unary endpoint returning one Client Remote Event outcome. */
export const REMOTE_EVENT_RESULT_ENDPOINT = '$events/result'

/** Empty standard Remote payload used to open the forwarded-event stream. */
export const REMOTE_EVENT_STREAM_PAYLOAD = { args: {} } as const

/** Opaque identity for one active Client Remote Event generation. */
export type RemoteEventClientId = Branded<'RemoteEventClientId'>

/** Opaque correlation id for one pending Host-to-Client Remote Event. */
export type RemoteEventId = Branded<'RemoteEventId'>

/** Opaque Agent identity carried by one scoped Remote Event. */
export type RemoteEventAgentId = Branded<'RemoteEventAgentId'>

/** Opening item that binds later HTTP results to this active event stream; also the host.describe replacement. */
export interface RemoteEventReadyFrame {
  readonly type: 'ready'
  readonly clientId: RemoteEventClientId
  readonly host: { readonly home: string }
}

/** One Host notification delivered to a Client generation. */
export interface RemoteEventEmitFrame {
  readonly type: 'emit'
  readonly event: string
  readonly args: readonly unknown[]
}

/** One pending Agent-scoped waterfall (approval/request, user-questions/request). */
export interface RemoteEventInvocationFrame {
  readonly type: 'waterfall'
  readonly event: string
  readonly eventId: RemoteEventId
  readonly agentId: RemoteEventAgentId
  readonly request: Readonly<Record<string, unknown>>
}

/** Cancellation of a pending waterfall previously delivered under the same id. */
export interface RemoteEventCancellationFrame {
  readonly type: 'cancel'
  readonly eventId: RemoteEventId
}

/** Every item carried by the Gateway-internal forwarded-event stream. */
export type RemoteEventDownlinkFrame =
  | RemoteEventReadyFrame
  | RemoteEventEmitFrame
  | RemoteEventInvocationFrame
  | RemoteEventCancellationFrame

/** JSON-safe error fields retained when a Client listener rejects a Host waterfall. */
export interface RemoteEventRejection {
  readonly name: string
  readonly message: string
  readonly code?: string
  readonly details?: unknown
}

/** Client response to one scoped Remote Event delivery, posted to $events/result. */
export interface RemoteEventResult {
  readonly clientId: RemoteEventClientId
  readonly eventId: RemoteEventId
  readonly outcome:
    | { readonly kind: 'next' }
    | { readonly kind: 'result'; readonly value?: unknown }
    | { readonly kind: 'rejected'; readonly error: RemoteEventRejection }
}
