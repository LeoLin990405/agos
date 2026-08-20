/**
 * P0 冒烟:对本机 dsh(:3091)跑通 list → create → prompt → 流式收帧 →
 * history → cancel → respond 全链路。会发一条真消息(默认模型,极短回复)。
 * 用法:npm run smoke  (AGOS_SMOKE_BASE / AGOS_SMOKE_CWD 可覆盖)
 */
import { createAgosClient } from '../src/api-client/index.ts'
import { RpcId } from '../src/contract/api/rpc.ts'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

const BASE = process.env.AGOS_SMOKE_BASE ?? 'http://localhost:3091'
const CWD = process.env.AGOS_SMOKE_CWD ?? '/Users/leo/Documents/kimi/workspace/agos-frontend'
const TURN_TIMEOUT_MS = 90_000

const client = createAgosClient({ baseUrl: BASE })
const results: { name: string; ok: boolean; detail: string }[] = []
const record = (name: string, ok: boolean, detail: string): void => {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  — ${detail}`)
}

// ── 1. session.list ─────────────────────────────────────────────
const listed = await client.call('session.list', {})
if (!listed.result.ok) {
  record('session.list', false, JSON.stringify(listed.result.error))
  process.exit(1)
}
record('session.list', true, `${listed.result.value.items.length} 个会话`)

// ── 2. 两条事件流(mux 收集器 + host 就绪探针)───────────────────
const muxAc = new AbortController()
const frameCounts = new Map<string, number>()
let sawSubscribed = false
let sessionId: SessionId | null = null
let resolveTurnEnd: (ok: boolean) => void = () => {}
const turnEndPromise = new Promise<boolean>((r) => { resolveTurnEnd = r })
const muxDone = (async () => {
  try {
    for await (const { payload } of client.mux(muxAc.signal)) {
      frameCounts.set(payload.type, (frameCounts.get(payload.type) ?? 0) + 1)
      if (payload.type === 'session/subscribed') sawSubscribed = true
      if (payload.type === 'session/event' && sessionId !== null
        && String(payload.sessionId) === String(sessionId)
        && (payload.event as { type?: string }).type === 'turn/end') {
        resolveTurnEnd(true)
      }
    }
  } catch { /* aborted */ }
})()
const hostAc = new AbortController()
let hostOpened = false
const hostDone = (async () => {
  try {
    for await (const _ of client.host(hostAc.signal, () => { hostOpened = true })) { /* 就绪即够 */ }
  } catch { /* aborted */ }
})()
await new Promise((r) => setTimeout(r, 800))
record('events.mux open', sawSubscribed, sawSubscribed ? '收到 session/subscribed' : '未收到 subscribed 帧')
record('events.host open', hostOpened, hostOpened ? 'onOpen 触发' : 'onOpen 未触发')

// ── 3. session.create ───────────────────────────────────────────
const created = await client.call('session.create', { cwd: CWD })
if (!created.result.ok) {
  record('session.create', false, JSON.stringify(created.result.error))
  process.exit(1)
}
sessionId = created.result.value.sessionId
record('session.create', true, `sessionId=${sessionId}`)

// ── 4. session.prompt + 流式收帧直到 turn/end ────────────────────
const turnTimer = setTimeout(() => resolveTurnEnd(false), TURN_TIMEOUT_MS)
const prompted = await client.call('session.prompt', {
  sessionId,
  mode: 'queue',
  content: [{ type: 'text', text: '只回复两个字:收到。不要调用任何工具。' }],
  clientTimeZone: 'Asia/Shanghai',
})
record('session.prompt', prompted.result.ok, prompted.result.ok ? 'accepted' : JSON.stringify(prompted.result.ok ? {} : prompted.result.error))
const gotTurnEnd = await turnEndPromise
clearTimeout(turnTimer)
record('stream frames', gotTurnEnd, `turn/end=${gotTurnEnd};帧分布:${[...frameCounts.entries()].map(([k, v]) => `${k}×${v}`).join(' ') || '无'}`)

// ── 5. session.history(断线全量重建的路径)─────────────────────
const history = await client.call('session.history', { sessionId })
record('session.history', history.result.ok, history.result.ok ? `${history.result.value.events.length} 个事件` : JSON.stringify(history.result.ok ? {} : history.result.error))

// ── 6. session.cancel(回合多半已结束;业务拒绝也算协议通)────────
const cancelled = await client.call('session.cancel', { sessionId })
record('session.cancel', true, cancelled.result.ok ? 'accepted' : `业务拒绝(可接受):${cancelled.result.error.code}`)

// ── 7. respond(陈旧 rpcId → 期望 not-pending)───────────────────
const receipt = await client.respond({
  type: 'client-response',
  rpcId: RpcId(crypto.randomUUID()),
  result: { ok: true, value: null },
})
record('respond', receipt.accepted === false && receipt.reason === 'not-pending', JSON.stringify(receipt))

// ── 收尾 ────────────────────────────────────────────────────────
muxAc.abort(); hostAc.abort()
await Promise.allSettled([muxDone, hostDone])

const failed = results.filter((r) => !r.ok)
console.log(`\n${failed.length === 0 ? '✅ SMOKE ALL PASS' : '❌ SMOKE FAILED'} (${results.length - failed.length}/${results.length})`)
process.exit(failed.length === 0 ? 0 : 1)
