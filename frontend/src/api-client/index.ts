/**
 * AgOS api-client —— 对齐膜的消费侧(自写,非 vendor)。
 *
 * 协议事实(实证自上游 packages/host/apiproxy/src/fetch/client.ts):
 * - unary:POST /api/<method>,body = ClientRequest 全形式
 *   { type:'client-request', rpcId, method, payload };响应 = ServerResponse
 *   { type:'server-response', rpcId, result:{ ok, value|error } },rpcId 必须回显。
 * - 两条事件流是 **流式 fetch 上的 SSE 帧**(`\n\n` 分帧、`data: ` 行),
 *   不是 WebSocket:GET /api/events.mux / /api/events.host;
 *   帧 = ServerRequest 信封 { type:'server-request', rpcId, method, payload },
 *   payload 再过 muxFrameSchema / hostFrameSchema。
 * - respond:POST /api/respond,body = ClientResponse { type:'client-response',
 *   rpcId(回显 server-request 的 id),result }。
 * - 断线重连 = 重开两条流 + 全量重拉 session.history(since 游标未实现)。
 *
 * 两级 zod 校验:信封(serverResponseSchema/serverRequestSchema)+ 业务值
 * (每方法的 value schema,表在本文件,与上游 fetch/client.ts 同构)。
 */
import type { z } from 'zod'
import type {
  ClientResponse, HostFrame, MuxFrame, RpcReceipt, RpcRequest, RpcResponse,
} from '../contract/api/index.ts'
import { RpcId } from '../contract/api/rpc.ts'
import type { RequestPayload, ResponseValue, RpcMethodMap } from '../contract/api/rpc-map.ts'
import type { Wire } from '../contract/api/rpc.schema.ts'
import {
  rpcReceiptSchema, serverRequestSchema, serverResponseSchema,
} from '../contract/api/rpc.schema.ts'
import { hostFrameSchema, muxFrameSchema } from '../contract/api/events.schema.ts'
import {
  hostCreateDirectoryValueSchema, hostDescribeValueSchema,
  hostListDirectoryValueSchema, hostOpenPathValueSchema, hostPickDirectoryValueSchema,
} from '../contract/api/host.schema.ts'
import {
  sessionAttachmentValueSchema, sessionCancelValueSchema, sessionCreateValueSchema,
  sessionForkValueSchema, sessionHistoryValueSchema, sessionListValueSchema,
  sessionModelsValueSchema, sessionPromptValueSchema, sessionRenameValueSchema,
  sessionSearchValueSchema, sessionSelectModelValueSchema, sessionUpdateQueueValueSchema,
} from '../contract/api/sessions.schema.ts'
import {
  workspaceArchiveSessionValueSchema, workspaceCreateValueSchema, workspaceDeleteValueSchema,
  workspaceInsertBeforeValueSchema, workspaceInsertSessionBeforeValueSchema,
  workspaceListValueSchema, workspaceRenameValueSchema,
} from '../contract/api/workspace.schema.ts'
import { skillListValueSchema } from '../contract/api/skills.schema.ts'
import {
  agentPresetCopyValueSchema, agentPresetListValueSchema, agentPresetOpenDocumentValueSchema,
  agentPresetReadValueSchema, agentPresetRemoveValueSchema, agentPresetSelectValueSchema,
} from '../contract/api/agent-presets.schema.ts'
import {
  goalClearValueSchema, goalCompleteValueSchema, goalCreateValueSchema,
  goalEditValueSchema, goalPauseValueSchema, goalResumeValueSchema,
} from '../contract/api/goals.schema.ts'
import {
  settingsDescribeValueSchema, settingsMutateValueSchema, settingsOpenDocumentValueSchema,
  settingsReplaceValueSchema, settingsUpdateValueSchema,
} from '../contract/api/settings.schema.ts'
import {
  credentialsDescribeValueSchema, credentialsSetValueSchema, credentialsUnsetValueSchema,
} from '../contract/api/credentials.schema.ts'
import {
  llmDiscoverModelsValueSchema, llmModelsValueSchema, llmProvidersValueSchema,
} from '../contract/api/llm.schema.ts'
import {
  subagentHistoryValueSchema, subagentInterruptValueSchema,
  subagentListValueSchema, subagentPromptValueSchema,
} from '../contract/api/subagents.schema.ts'

/** S→C 二级解析表:方法 → 响应 value schema(与上游 fetch/carrier 同构)。 */
const UNARY_VALUE_SCHEMAS: { [K in keyof RpcMethodMap]: z.ZodType<Wire<ResponseValue<K>>> } = {
  'session.list': sessionListValueSchema,
  'session.search': sessionSearchValueSchema,
  'session.create': sessionCreateValueSchema,
  'session.history': sessionHistoryValueSchema,
  'session.models': sessionModelsValueSchema,
  'session.selectModel': sessionSelectModelValueSchema,
  'session.rename': sessionRenameValueSchema,
  'session.fork': sessionForkValueSchema,
  'session.prompt': sessionPromptValueSchema,
  'session.attachment': sessionAttachmentValueSchema,
  'session.updateQueue': sessionUpdateQueueValueSchema,
  'session.cancel': sessionCancelValueSchema,
  'subagent.list': subagentListValueSchema,
  'subagent.history': subagentHistoryValueSchema,
  'subagent.prompt': subagentPromptValueSchema,
  'subagent.interrupt': subagentInterruptValueSchema,
  'host.describe': hostDescribeValueSchema,
  'host.pickDirectory': hostPickDirectoryValueSchema,
  'host.listDirectory': hostListDirectoryValueSchema,
  'host.createDirectory': hostCreateDirectoryValueSchema,
  'host.openPath': hostOpenPathValueSchema,
  'workspace.list': workspaceListValueSchema,
  'workspace.create': workspaceCreateValueSchema,
  'workspace.rename': workspaceRenameValueSchema,
  'workspace.delete': workspaceDeleteValueSchema,
  'workspace.insertBefore': workspaceInsertBeforeValueSchema,
  'workspace.insertSessionBefore': workspaceInsertSessionBeforeValueSchema,
  'workspace.archiveSession': workspaceArchiveSessionValueSchema,
  'skill.list': skillListValueSchema,
  'agentPreset.list': agentPresetListValueSchema,
  'agentPreset.select': agentPresetSelectValueSchema,
  'agentPreset.read': agentPresetReadValueSchema,
  'agentPreset.copy': agentPresetCopyValueSchema,
  'agentPreset.openDocument': agentPresetOpenDocumentValueSchema,
  'agentPreset.remove': agentPresetRemoveValueSchema,
  'goal.create': goalCreateValueSchema,
  'goal.edit': goalEditValueSchema,
  'goal.pause': goalPauseValueSchema,
  'goal.resume': goalResumeValueSchema,
  'goal.complete': goalCompleteValueSchema,
  'goal.clear': goalClearValueSchema,
  'settings.describe': settingsDescribeValueSchema,
  'settings.openDocument': settingsOpenDocumentValueSchema,
  'settings.update': settingsUpdateValueSchema,
  'settings.replace': settingsReplaceValueSchema,
  'settings.mutate': settingsMutateValueSchema,
  'credentials.describe': credentialsDescribeValueSchema,
  'credentials.set': credentialsSetValueSchema,
  'credentials.unset': credentialsUnsetValueSchema,
  'llm.providers': llmProvidersValueSchema,
  'llm.models': llmModelsValueSchema,
  'llm.discoverModels': llmDiscoverModelsValueSchema,
}

const DEFAULT_TIMEOUT_MS = 30_000

export interface AgosClientOptions {
  /** 显式 base(Node/冒烟脚本用);浏览器默认同源 location.origin。 */
  baseUrl?: string
  /** 有界 unary 的传输健康超时(用户节奏的调用与流不受其管)。 */
  timeoutMs?: number
  /** 传输注入点(测试/宿主内进程)。 */
  doFetch?: (input: URL, init?: RequestInit) => Promise<Response>
  /** 帧观察 tap(诊断;抛错被隔离,绝不断流)。 */
  onFrame?: (frame: MuxFrame | HostFrame) => void
  /**
   * 事件流物理通道。上游 apiproxy→gateway 迁移期两种都在:'sse'(老,pin 克隆的
   * fetch carrier 面)/ 'ws'(新,rc 部署面对 GET 回 426 upgrade: websocket)。
   * 默认 'auto':有 WebSocket 用 WS,否则 SSE。
   */
  streamTransport?: 'ws' | 'sse' | 'auto'
}

export interface AgosClient {
  call<K extends keyof RpcMethodMap>(
    method: K, payload: RequestPayload<K>, signal?: AbortSignal,
  ): Promise<RpcResponse<ResponseValue<K>>>
  respond(message: ClientResponse, signal?: AbortSignal): Promise<RpcReceipt>
  /** mux 流;onOpen 在响应头到达、首帧之前触发(连接就绪握手)。 */
  mux(signal: AbortSignal, onOpen?: () => void): AsyncIterable<RpcRequest<MuxFrame>>
  host(signal: AbortSignal, onOpen?: () => void): AsyncIterable<RpcRequest<HostFrame>>
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

  async function postJson(path: string, body: unknown, signal: AbortSignal | undefined, bounded: boolean): Promise<Response> {
    const requestSignal = bounded
      ? signal === undefined
        ? AbortSignal.timeout(timeoutMs)
        : AbortSignal.any([AbortSignal.timeout(timeoutMs), signal])
      : signal
    const response = await doFetch(new URL(path, resolveBase()), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      ...(requestSignal === undefined ? {} : { signal: requestSignal }),
    })
    if (!response.ok) throw new Error(`transport failure for ${path}: HTTP ${response.status}`)
    return response
  }

  async function call<K extends keyof RpcMethodMap>(
    method: K, payload: RequestPayload<K>, signal?: AbortSignal,
  ): Promise<RpcResponse<ResponseValue<K>>> {
    const message = { type: 'client-request' as const, rpcId: mintRpcId(), method, payload }
    const response = await postJson(`/api/${method}`, message, signal, true)
    const full = serverResponseSchema.parse(await response.json())
    if (full.rpcId !== message.rpcId) {
      throw new Error(`rpcId mismatch for ${method}: sent ${message.rpcId}, got ${full.rpcId}`)
    }
    if (!full.result.ok) return { rpcId: full.rpcId, result: full.result }
    const value = UNARY_VALUE_SCHEMAS[method].parse(full.result.value) as ResponseValue<K>
    return { rpcId: full.rpcId, result: { ok: true, value } }
  }

  /** SSE 协议路径:流式 fetch(非 EventSource),'\n\n' 分帧;坏帧报掉跳过,不断流。 */
  async function* readSse<F extends MuxFrame | HostFrame>(
    path: string, signal: AbortSignal, frameSchema: z.ZodType<F>, onOpen?: () => void,
  ): AsyncGenerator<RpcRequest<F>> {
    const response = await doFetch(new URL(path, resolveBase()), { signal })
    if (!response.ok || response.body === null) {
      throw new Error(`transport failure for ${path}: HTTP ${response.status}`)
    }
    onOpen?.()
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) return
        buffer += decoder.decode(value, { stream: true })
        let boundary: number
        while ((boundary = buffer.indexOf('\n\n')) !== -1) {
          const chunk = buffer.slice(0, boundary)
          buffer = buffer.slice(boundary + 2)
          const data = chunk.split('\n')
            .filter((line) => line.startsWith('data: '))
            .map((line) => line.slice(6))
            .join('')
          if (data === '') continue
          let full
          let frame: F
          try {
            full = serverRequestSchema.parse(JSON.parse(data))
            frame = frameSchema.parse(full.payload)
          } catch (error) {
            console.error(`[agos-client] dropping malformed SSE frame on ${path}:`, error)
            continue
          }
          options.onFrame?.(frame)
          yield { rpcId: full.rpcId, payload: frame }
        }
      }
    } finally {
      await reader.cancel().catch(() => undefined)
    }
  }

  /** WS 协议路径(rc 部署面):同一 ServerRequest 信封,JSON 文本帧,开连即推。 */
  async function* readWs<F extends MuxFrame | HostFrame>(
    path: string, signal: AbortSignal, frameSchema: z.ZodType<F>, onOpen?: () => void,
  ): AsyncGenerator<RpcRequest<F>> {
    const WsImpl = (globalThis as { WebSocket?: typeof WebSocket }).WebSocket
    if (WsImpl === undefined) throw new Error('WebSocket unavailable in this runtime')
    const url = new URL(path, resolveBase())
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    const ws = new WsImpl(url)
    // 队列化异步迭代:消息先入队,消费者按序取;close/error 终结迭代。
    const queue: (string | null)[] = []
    let wake: (() => void) | undefined
    let failed: unknown = null
    const push = (item: string | null): void => { queue.push(item); wake?.() }
    const take = (): Promise<string | null> => {
      if (queue.length > 0) return Promise.resolve(queue.shift() ?? null)
      return new Promise((resolve) => {
        wake = () => { wake = undefined; resolve(queue.shift() ?? null) }
      })
    }
    const onAbort = (): void => { try { ws.close() } catch { /* 已关 */ } }
    signal.addEventListener('abort', onAbort, { once: true })
    ws.onmessage = (event) => push(typeof event.data === 'string' ? event.data : String(event.data))
    ws.onerror = (event) => { failed = failed ?? (event as { message?: string }).message ?? 'websocket error' }
    ws.onclose = () => push(null)
    try {
      // 等开连(或失败)
      await new Promise<void>((resolve, reject) => {
        const bad = (): void => reject(new Error(`websocket connect failed for ${path}: ${String(failed ?? 'closed before open')}`))
        if (ws.readyState === ws.OPEN) { resolve(); return }
        ws.onopen = () => resolve()
        const prevClose = ws.onclose
        ws.onclose = (ev) => { if (ws.readyState !== ws.OPEN && queue.length === 0) bad(); prevClose?.call(ws, ev) }
      })
      if (signal.aborted) return
      onOpen?.()
      while (true) {
        const data = await take()
        if (data === null) return
        if (signal.aborted) return
        let full
        let frame: F
        try {
          full = serverRequestSchema.parse(JSON.parse(data))
          frame = frameSchema.parse(full.payload)
        } catch (error) {
          console.error(`[agos-client] dropping malformed WS frame on ${path}:`, error)
          continue
        }
        options.onFrame?.(frame)
        yield { rpcId: full.rpcId, payload: frame }
      }
    } finally {
      signal.removeEventListener('abort', onAbort)
      try { ws.close() } catch { /* 已关 */ }
    }
  }

  const useWs = options.streamTransport !== 'sse'
    && (options.streamTransport === 'ws'
      || (globalThis as { WebSocket?: unknown }).WebSocket !== undefined)

  return {
    call,
    async respond(message: ClientResponse, signal?: AbortSignal): Promise<RpcReceipt> {
      const response = await postJson('/api/respond', message, signal, true)
      return rpcReceiptSchema.parse(await response.json())
    },
    mux: (signal, onOpen) => useWs
      ? readWs('/api/events.mux', signal, muxFrameSchema, onOpen)
      : readSse('/api/events.mux', signal, muxFrameSchema, onOpen),
    host: (signal, onOpen) => useWs
      ? readWs('/api/events.host', signal, hostFrameSchema, onOpen)
      : readSse('/api/events.host', signal, hostFrameSchema, onOpen),
  }
}

/**
 * 断线重连助手:流死了就重开(指数退避,上限 8s);调用方负责在 onReconnect
 * 里全量重拉 session.history(since 游标上游未实现)。
 */
export function watchStream<F extends MuxFrame | HostFrame>(
  open: (signal: AbortSignal, onOpen?: () => void) => AsyncIterable<RpcRequest<F>>,
  consume: (frame: RpcRequest<F>) => void,
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
        if (!stopped && !ac.signal.aborted) {
          console.error('[agos-client] stream dropped, reconnecting:', error)
        }
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
