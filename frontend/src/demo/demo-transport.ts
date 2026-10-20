/**
 * Demo transport — replaces window.fetch (only for /api/*) and window.WebSocket
 * (only for /api/remote.mux) so the frozen api-client / stores run unchanged
 * against in-memory sample data. Loaded only when isDemoMode() is true.
 *
 * Read-only by construction: every write (unary mutations, REST POST/PUT/…)
 * answers a DEMO_READ_ONLY failure; nothing is persisted anywhere.
 */
import { DEMO_NOT_COLLECTED, DEMO_NOT_COLLECTED_MESSAGE } from './demo-mode.ts'
import { DEMO_HOME, demoFollowSnapshot, demoSessionById, demoSessionList } from './demo-fixtures.ts'
import { demoRestFixture } from './demo-rest.ts'

const LIVE_INTERVAL_MS = 900

const READ_RPC: Record<string, (args: Record<string, unknown>) => unknown> = {
  'session/list': () => demoSessionList(),
  'session/search': () => ({ items: [], hasMore: false }),
  'session/page': () => ({ records: [], hasMore: false }),
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'x-agos-demo': '1' },
  })
}

function rpcFailure(rpcId: unknown, code: string, message: string): Response {
  return json(200, { type: 'server-response', rpcId, result: { ok: false, error: { code, message, details: { demo: true } } } })
}

export function demoFetchHandler(url: URL, method: string, bodyText: string | undefined): Response | undefined {
  if (!url.pathname.startsWith('/api/')) return undefined
  const rest = url.pathname.slice('/api/'.length)
  // Unary RPC envelope: POST /api/<ns>/<method> with {type:'client-request'}.
  if (method === 'POST' && bodyText !== undefined && bodyText.includes('"client-request"')) {
    let msg: { rpcId?: unknown, method?: string, payload?: { args?: Record<string, unknown> } }
    try { msg = JSON.parse(bodyText) } catch { return json(400, { error: 'demo: bad envelope' }) }
    const handler = READ_RPC[msg.method ?? rest]
    if (handler === undefined) return rpcFailure(msg.rpcId, DEMO_NOT_COLLECTED, DEMO_NOT_COLLECTED_MESSAGE)
    return json(200, { type: 'server-response', rpcId: msg.rpcId, result: { ok: true, value: handler(msg.payload?.args ?? {}) } })
  }
  if (method !== 'GET') {
    return json(403, { error: { code: 'DEMO_READ_ONLY', message: '演示模式只读：没有写入任何数据' } })
  }
  const fixture = demoRestFixture(url)
  if (fixture !== undefined) return json(200, fixture)
  return json(503, { error: { code: DEMO_NOT_COLLECTED, message: DEMO_NOT_COLLECTED_MESSAGE } })
}

type Listener = ((ev: { data?: unknown }) => void) | null

/** Minimal WebSocket stand-in speaking the remote.mux logical-stream protocol. */
class DemoMuxSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3
  readonly CONNECTING = 0
  readonly OPEN = 1
  readonly CLOSING = 2
  readonly CLOSED = 3
  readonly url: string
  readyState = 0
  binaryType = 'blob'
  protocol = ''
  extensions = ''
  bufferedAmount = 0
  onopen: Listener = null
  onmessage: Listener = null
  onerror: Listener = null
  onclose: Listener = null
  private timers: ReturnType<typeof setTimeout>[] = []

  constructor(url: string | URL) {
    this.url = String(url)
    this.later(0, () => { this.readyState = 1; this.onopen?.({}) })
  }

  private later(ms: number, fn: () => void): void {
    this.timers.push(setTimeout(() => { if (this.readyState !== 3) fn() }, ms))
  }

  private item(streamId: string, value: unknown): void {
    this.onmessage?.({ data: JSON.stringify({ type: 'item', streamId, value }) })
  }

  send(raw: string): void {
    let msg: { type?: string, streamId?: string, endpoint?: string, payload?: { args?: Record<string, unknown> } }
    try { msg = JSON.parse(raw) } catch { return }
    if (msg.type !== 'open' || msg.streamId === undefined) return
    const streamId = msg.streamId
    const args = msg.payload?.args ?? {}
    switch (msg.endpoint) {
      case '$events':
        this.later(10, () => this.item(streamId, { type: 'ready', clientId: 'demo-client', host: { home: DEMO_HOME } }))
        return
      case 'workspace/follow':
        this.later(10, () => this.item(streamId, { type: 'baseline', value: { items: [], archivedSessionIds: [] } }))
        return
      case 'session/follow': {
        const address = ((args['request'] as Record<string, unknown> | undefined)?.['address'] ?? {}) as Record<string, unknown>
        const session = demoSessionById(String(address['sessionId'] ?? ''))
        if (session === undefined) {
          this.later(10, () => this.onmessage?.({ data: JSON.stringify({ type: 'error', streamId, error: { code: DEMO_NOT_COLLECTED, message: DEMO_NOT_COLLECTED_MESSAGE, details: {} } }) }))
          return
        }
        this.later(10, () => this.item(streamId, demoFollowSnapshot(session)))
        session.live.forEach((event, i) => {
          this.later(600 + i * LIVE_INTERVAL_MS, () => this.item(streamId, { type: 'event', event }))
        })
        return
      }
      default:
        this.later(10, () => this.onmessage?.({ data: JSON.stringify({ type: 'error', streamId, error: { code: DEMO_NOT_COLLECTED, message: DEMO_NOT_COLLECTED_MESSAGE, details: {} } }) }))
    }
  }

  close(): void {
    if (this.readyState === 3) return
    for (const t of this.timers) clearTimeout(t)
    this.timers = []
    this.readyState = 3
    this.onclose?.({})
  }

  addEventListener(): void { /* api-client uses on* handlers only */ }
  removeEventListener(): void { /* no-op */ }
}

export function installDemoTransport(): void {
  const realFetch = window.fetch.bind(window)
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const url = new URL(raw, window.location.origin)
    if (url.origin === window.location.origin) {
      const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase()
      const body = typeof init?.body === 'string' ? init.body : undefined
      const res = demoFetchHandler(url, method, body)
      if (res !== undefined) return res
    }
    return realFetch(input, init)
  }
  const RealWebSocket = window.WebSocket
  const Patched = function (this: unknown, url: string | URL, protocols?: string | string[]) {
    if (new URL(String(url), window.location.href).pathname.endsWith('/api/remote.mux')) {
      return new DemoMuxSocket(url) as unknown as WebSocket
    }
    return new RealWebSocket(url, protocols)
  } as unknown as typeof WebSocket
  Object.assign(Patched, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 })
  window.WebSocket = Patched
}
