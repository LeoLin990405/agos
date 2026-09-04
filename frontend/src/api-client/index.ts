/**
 * AgOS api-client — the membrane's consumer side (self-written), aligned to
 * DSH 0.1.2-rc.1.
 *
 * Protocol facts (from packages/client/connection + packages/api/gateway @ rc.1):
 * - unary: POST /api/<ns>/<method>, body = ClientRequest whose payload is
 *   EXACTLY { args: {...} }; response = ServerResponse { rpcId(echo), result }.
 *   Errors are open namespaced {code,message,details}.
 * - streams: ONE WebSocket route /api/remote.mux multiplexes logical streams by
 *   streamId. AgOS opens one logical stream per socket (the simplest valid
 *   subset): send {open,streamId,endpoint,payload:{args}}, consume
 *   {item,streamId,value}/{error}/{end}. Endpoints: session/follow,
 *   workspace/follow, and the internal $events downlink.
 * - Host→Client asks (approval, user-question) ride $events as `waterfall`
 *   frames; the client answers with a normal unary POST to $events/result.
 *
 * Two-level zod: envelope (serverResponseSchema) + per-method value schema.
 */

import type { z } from 'zod'
import type {
  RemoteEventDownlinkFrame, RemoteEventResult, RpcResponse,
} from '../contract/api/index.ts'
import { RpcId, REMOTE_STREAM_MUX_PATH, REMOTE_EVENT_STREAM_ENDPOINT } from '../contract/api/rpc.ts'
import type { RequestPayload, ResponseValue, RpcMethodMap } from '../contract/api/rpc-map.ts'
import type { Wire } from '../contract/api/rpc.schema.ts'
import {
  remoteEventDownlinkFrameSchema, remoteStreamServerMessageSchema, serverResponseSchema,
} from '../contract/api/rpc.schema.ts'
import {
  sessionAttachmentValueSchema, sessionCanOpenWorkspacePathValueSchema, sessionCreateValueSchema,
  sessionListValueSchema, sessionModelCatalogValueSchema, sessionOpenWorkspacePathValueSchema,
  sessionPageValueSchema, sessionPromptValueSchema, sessionRenameValueSchema, sessionSearchValueSchema,
  sessionSelectModelValueSchema,
} from '../contract/api/sessions.schema.ts'
import { agentPresetListValueSchema } from '../contract/api/agent-presets.schema.ts'
import { skillListValueSchema } from '../contract/api/skills.schema.ts'
import { settingsOpenDocumentValueSchema } from '../contract/api/settings.schema.ts'

/** S→C second-parse table: method → response value schema. */
const UNARY_VALUE_SCHEMAS: { [K in keyof RpcMethodMap]: z.ZodType<Wire<ResponseValue<K>>> } = {
  'session/list': sessionListValueSchema,
  'session/search': sessionSearchValueSchema,
  'session/create': sessionCreateValueSchema,
  'session/page': sessionPageValueSchema,
  'session/modelCatalog': sessionModelCatalogValueSchema,
  'session/selectModel': sessionSelectModelValueSchema,
  'session/rename': sessionRenameValueSchema,
  'session/prompt': sessionPromptValueSchema,
  'session/attachment': sessionAttachmentValueSchema,
  'session/canOpenWorkspacePath': sessionCanOpenWorkspacePathValueSchema,
  'session/openWorkspacePath': sessionOpenWorkspacePathValueSchema,
  'agentPresets/list': agentPresetListValueSchema,
  'skills/list': skillListValueSchema,
  'settings/openSettingsDocument': settingsOpenDocumentValueSchema,
}

/**
 * Wire arg key per method: 0.1.2 keys the `args` object by the Host Remote
 * method's parameter name. null = a no-parameter method (args stays `{}`).
 * (session/list's param is `_request`; most are `request`; the catalog and
 * capability probes and the preset roster take none.)
 */
const ARG_KEY: { [K in keyof RpcMethodMap]: string | null } = {
  'session/list': '_request',
  'session/search': 'request',
  'session/create': 'request',
  'session/page': 'request',
  'session/modelCatalog': null,
  'session/selectModel': 'request',
  'session/rename': 'request',
  'session/prompt': 'request',
  'session/attachment': 'request',
  'session/canOpenWorkspacePath': null,
  'session/openWorkspacePath': 'request',
  'agentPresets/list': null,
  'skills/list': 'request',
  'settings/openSettingsDocument': null,
}

const DEFAULT_TIMEOUT_MS = 30_000

export interface AgosClientOptions {
  /** Explicit base (Node/smoke); browsers default to location.origin (same-origin). */
  baseUrl?: string
  /** Transport-health timeout for bounded unary calls (streams are unbounded). */
  timeoutMs?: number
  /** Transport injection point (tests / in-process host). */
  doFetch?: (input: URL, init?: RequestInit) => Promise<Response>
  /** Frame observation tap (diagnostics; throwing is isolated, never breaks a stream). */
  onEventFrame?: (frame: RemoteEventDownlinkFrame) => void
}

export interface AgosClient {
  call<K extends keyof RpcMethodMap>(
    method: K, payload: RequestPayload<K>, signal?: AbortSignal,
  ): Promise<RpcResponse<ResponseValue<K>>>
  /** Open one logical Remote stream over its own /api/remote.mux socket; yields raw item values. */
  stream(endpoint: string, args: object, signal: AbortSignal, onOpen?: () => void): AsyncIterable<unknown>
  /** Convenience over stream('$events'): parsed downlink frames (ready/emit/waterfall/cancel). */
  events(signal: AbortSignal, onOpen?: () => void): AsyncIterable<RemoteEventDownlinkFrame>
  /** Answer one Host→Client waterfall (approval / user-question) via $events/result. */
  postEventResult(result: RemoteEventResult, signal?: AbortSignal): Promise<void>
}

export function createAgosClient(options: AgosClientOptions = {}): AgosClient {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const doFetch = options.doFetch ?? ((input: URL, init?: RequestInit) => fetch(input, init))
  const resolveBase = (): string => {
    if (options.baseUrl) return options.baseUrl
    const loc = (globalThis as { location?: { origin?: string } }).location
    return loc?.origin !== undefined && loc.origin !== 'null' ? loc.origin : 'http://localhost:3091'
  }
  const mintRpcId = (): ReturnType<typeof RpcId> => RpcId(crypto.randomUUID())

  async function postEnvelope(method: string, args: object, signal: AbortSignal | undefined): Promise<unknown> {
    const requestSignal = signal === undefined
      ? AbortSignal.timeout(timeoutMs)
      : AbortSignal.any([AbortSignal.timeout(timeoutMs), signal])
    // `args` is already the wire args object ({} or {<paramName>: value}).
    const message = { type: 'client-request' as const, rpcId: mintRpcId(), method, payload: { args } }
    const response = await doFetch(new URL(`/api/${method}`, resolveBase()), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(message),
      signal: requestSignal,
    })
    if (!response.ok) throw new Error(`transport failure for ${method}: HTTP ${response.status}`)
    const full = serverResponseSchema.parse(await response.json())
    if (full.rpcId !== message.rpcId) {
      throw new Error(`rpcId mismatch for ${method}: sent ${message.rpcId}, got ${full.rpcId}`)
    }
    if (!full.result.ok) throw new AgosRemoteError(full.result.error.code, full.result.error.message, full.result.error.details)
    return full.result.value
  }

  async function call<K extends keyof RpcMethodMap>(
    method: K, payload: RequestPayload<K>, signal?: AbortSignal,
  ): Promise<RpcResponse<ResponseValue<K>>> {
    const rpcId = mintRpcId()
    const key = ARG_KEY[method]
    const args = key === null ? {} : { [key]: payload }
    try {
      const value = await postEnvelope(method, args, signal)
      const parsed = UNARY_VALUE_SCHEMAS[method].parse(value) as ResponseValue<K>
      return { rpcId, result: { ok: true, value: parsed } }
    } catch (error) {
      if (error instanceof AgosRemoteError) {
        return { rpcId, result: { ok: false, error: { code: error.code, message: error.message, details: error.details } } }
      }
      throw error
    }
  }

  /** One logical Remote stream over its own WebSocket; yields each item's raw value. */
  async function* stream(endpoint: string, args: object, signal: AbortSignal, onOpen?: () => void): AsyncGenerator<unknown> {
    const WsImpl = (globalThis as { WebSocket?: typeof WebSocket }).WebSocket
    if (WsImpl === undefined) throw new Error('WebSocket unavailable in this runtime')
    const url = new URL(REMOTE_STREAM_MUX_PATH, resolveBase())
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    const streamId = crypto.randomUUID()
    const ws = new WsImpl(url)
    const queue: (string | null)[] = []
    let wake: (() => void) | undefined
    let failed: unknown = null
    const push = (item: string | null): void => { queue.push(item); wake?.() }
    const take = (): Promise<string | null> => {
      if (queue.length > 0) return Promise.resolve(queue.shift() ?? null)
      return new Promise((resolve) => { wake = () => { wake = undefined; resolve(queue.shift() ?? null) } })
    }
    const onAbort = (): void => { try { ws.close() } catch { /* already closed */ } }
    signal.addEventListener('abort', onAbort, { once: true })
    ws.onmessage = (event) => push(typeof event.data === 'string' ? event.data : String(event.data))
    ws.onerror = (event) => { failed = failed ?? (event as { message?: string }).message ?? 'websocket error' }
    ws.onclose = () => push(null)
    try {
      await new Promise<void>((resolve, reject) => {
        if (ws.readyState === ws.OPEN) { resolve(); return }
        ws.onopen = () => resolve()
        const prevClose = ws.onclose
        ws.onclose = (ev) => {
          if (ws.readyState !== ws.OPEN && queue.length === 0) reject(new Error(`mux connect failed for ${endpoint}: ${String(failed ?? 'closed before open')}`))
          prevClose?.call(ws, ev)
        }
      })
      if (signal.aborted) return
      ws.send(JSON.stringify({ type: 'open', streamId, endpoint, payload: { args } }))
      onOpen?.()
      while (true) {
        const data = await take()
        if (data === null) return
        if (signal.aborted) return
        let msg
        try { msg = remoteStreamServerMessageSchema.parse(JSON.parse(data)) } catch (error) {
          console.error(`[agos-client] dropping malformed mux frame on ${endpoint}:`, error)
          continue
        }
        if (msg.streamId !== streamId) continue
        if (msg.type === 'end') return
        if (msg.type === 'error') throw new AgosRemoteError(msg.error.code, msg.error.message, msg.error.details)
        yield msg.value
      }
    } finally {
      signal.removeEventListener('abort', onAbort)
      try { ws.close() } catch { /* already closed */ }
    }
  }

  async function* events(signal: AbortSignal, onOpen?: () => void): AsyncGenerator<RemoteEventDownlinkFrame> {
    for await (const value of stream(REMOTE_EVENT_STREAM_ENDPOINT, {}, signal, onOpen)) {
      let frame: RemoteEventDownlinkFrame
      try { frame = remoteEventDownlinkFrameSchema.parse(value) } catch (error) {
        console.error('[agos-client] dropping malformed $events frame:', error)
        continue
      }
      try { options.onEventFrame?.(frame) } catch (tapError) { console.error('[agos-client] onEventFrame tap threw (isolated):', tapError) }
      yield frame
    }
  }

  return {
    call,
    stream,
    events,
    async postEventResult(result: RemoteEventResult, signal?: AbortSignal): Promise<void> {
      await postEnvelope('$events/result', result as unknown as object, signal)
    },
  }
}

/** Remote endpoint failure carrying the open namespaced code. */
export class AgosRemoteError extends Error {
  constructor(readonly code: string, message: string, readonly details: object) {
    super(message)
    this.name = 'AgosRemoteError'
  }
}

/**
 * Reconnect helper: reopen a logical stream when it drops (exponential backoff,
 * cap 8s). The caller reseeds state in onReconnect (session/follow reopens with
 * a fresh snapshot, so no since-cursor is needed).
 */
export function watchStream<T>(
  open: (signal: AbortSignal, onOpen?: () => void) => AsyncIterable<T>,
  consume: (frame: T) => void,
  onReconnect?: () => void,
): () => void {
  let stopped = false
  let generation = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  let current: AbortController | undefined
  const run = async (): Promise<void> => {
    const gen = ++generation
    const ac = new AbortController()
    current = ac
    let attempt = 0
    while (!stopped && gen === generation) {
      try {
        for await (const frame of open(ac.signal)) consume(frame)
      } catch (error) {
        if (!stopped && !ac.signal.aborted) console.error('[agos-client] stream dropped, reconnecting:', error)
      }
      if (stopped || gen !== generation) break
      attempt += 1
      const delay = Math.min(8000, 500 * 2 ** Math.min(attempt, 4))
      await new Promise((resolve) => { timer = setTimeout(resolve, delay) })
      if (stopped || gen !== generation) break
      onReconnect?.()
    }
  }
  void run()
  return () => {
    stopped = true
    generation += 1
    if (timer) clearTimeout(timer)
    current?.abort()
  }
}
