/**
 * P0 smoke against a local dsh (:3091), aligned to DSH 0.1.2-rc.1:
 * session/list → $events ready → session/create → session/prompt(requestId) →
 * session/follow frames until turn/end → session/page. Sends one real short
 * prompt (default model). Usage: npm run smoke  (AGOS_SMOKE_BASE / AGOS_SMOKE_CWD).
 */
import { createAgosClient } from '../src/api-client/index.ts'
import { sessionFollowFrameSchema } from '../src/contract/api/sessions.schema.ts'
import type { SessionFollowFrame } from '../src/contract/api/index.ts'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

const BASE = process.env.AGOS_SMOKE_BASE ?? 'http://localhost:3091'
const CWD = process.env.AGOS_SMOKE_CWD ?? `${process.env.HOME ?? ''}/Projects/agos/frontend`
const TURN_TIMEOUT_MS = 90_000

const client = createAgosClient({ baseUrl: BASE })
const results: { name: string; ok: boolean; detail: string }[] = []
const record = (name: string, ok: boolean, detail: string): void => {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  — ${detail}`)
}

// ── 1. session/list ──────────────────────────────────────────────
const listed = await client.call('session/list', {})
if (!listed.result.ok) { record('session/list', false, JSON.stringify(listed.result.error)); process.exit(1) }
record('session/list', true, `${listed.result.value.items.length} 个会话`)

// ── 2. $events ready probe ───────────────────────────────────────
const eventsAc = new AbortController()
let eventsReady = false
const eventsDone = (async () => {
  try {
    for await (const frame of client.events(eventsAc.signal)) { if (frame.type === 'ready') eventsReady = true }
  } catch { /* aborted */ }
})()
await new Promise((r) => setTimeout(r, 1000))
record('$events ready', eventsReady, eventsReady ? '收到 ready 帧(clientId + host.home)' : '未收到 ready 帧')

// ── 3. session/create ────────────────────────────────────────────
const created = await client.call('session/create', { cwd: CWD })
if (!created.result.ok) { record('session/create', false, JSON.stringify(created.result.error)); process.exit(1) }
const sessionId: SessionId = created.result.value.sessionId
record('session/create', true, `sessionId=${sessionId}`)

// ── 4. session/follow collector until turn/end ───────────────────
const followAc = new AbortController()
const frameCounts = new Map<string, number>()
let resolveTurnEnd: (ok: boolean) => void = () => {}
const turnEndPromise = new Promise<boolean>((r) => { resolveTurnEnd = r })
const followDone = (async () => {
  try {
    for await (const value of client.stream('session/follow', { request: { address: { kind: 'session', sessionId } } }, followAc.signal)) {
      const frame = sessionFollowFrameSchema.parse(value) as SessionFollowFrame
      frameCounts.set(frame.type, (frameCounts.get(frame.type) ?? 0) + 1)
      if (frame.type !== 'snapshot' && frame.event.type === 'turn/end') resolveTurnEnd(true)
    }
  } catch { /* aborted */ }
})()

// ── 5. session/prompt(requestId)─────────────────────────────────
const turnTimer = setTimeout(() => resolveTurnEnd(false), TURN_TIMEOUT_MS)
const prompted = await client.call('session/prompt', {
  requestId: crypto.randomUUID() as never,
  sessionId,
  mode: 'queue',
  content: [{ type: 'text', text: '只回复两个字:收到。不要调用任何工具。' }],
  clientTimeZone: 'Asia/Shanghai',
})
record('session/prompt', prompted.result.ok, prompted.result.ok ? 'accepted' : JSON.stringify(prompted.result.ok ? {} : prompted.result.error))
const gotTurnEnd = await turnEndPromise
clearTimeout(turnTimer)
record('follow frames', gotTurnEnd, `turn/end=${gotTurnEnd};帧分布:${[...frameCounts.entries()].map(([k, v]) => `${k}×${v}`).join(' ') || '无'}`)

// ── 6. session/page(backwards history)───────────────────────────
const page = await client.call('session/page', { address: { kind: 'session', sessionId }, throughSeq: -1 })
record('session/page', page.result.ok, page.result.ok ? `${page.result.value.records.length} 条记录` : JSON.stringify(page.result.ok ? {} : page.result.error))

// ── teardown ─────────────────────────────────────────────────────
eventsAc.abort(); followAc.abort()
await Promise.allSettled([eventsDone, followDone])

const failed = results.filter((r) => !r.ok)
console.log(`\n${failed.length === 0 ? '✅ SMOKE ALL PASS' : '❌ SMOKE FAILED'} (${results.length - failed.length}/${results.length})`)
process.exit(failed.length === 0 ? 0 : 1)
