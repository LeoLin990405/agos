/**
 * B1 evidence probe: prove (or disprove) that a REAL pinned dsh host can be
 * started in isolation, with a fake provider and fake tool, and that its real
 * 0.1.2 transport answers — unary POST /api/<ns>/<method> plus the single
 * /api/remote.mux WebSocket carrying $events and session/follow.
 *
 * No browser here; this is the transport-level proof the browser suite builds on.
 * Run: node scripts/host-integration/probe-host.mjs
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  ARTIFACT_DIR, claimPorts, redact,
} from './host-env.mjs';
import { createRunRoot, disposeRunRoot } from './run-registry.mjs';
import { startHost } from './start-host.mjs';

const findings = []
/** Record one probe result line. */
const note = (ok, label, detail = '') => {
  findings.push({ ok, label, detail: redact(detail) })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${redact(detail)}` : ''}`)
}

/**
 * One unary call on the real 0.1.2 wire.
 * @param base - host origin.
 * @param method - `<ns>/<method>`.
 * @param args - already-keyed wire args object.
 * @returns the parsed ServerResponse.
 */
async function unary(host, method, args) {
  const rpcId = crypto.randomUUID()
  const response = await fetch(new URL(`/api/${method}`, host.base), {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: host.cookieHeader },
    body: JSON.stringify({ type: 'client-request', rpcId, method, payload: { args } }),
  })
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${method}`)
  const body = await response.json()
  if (body.rpcId !== rpcId) throw new Error(`rpcId echo mismatch for ${method}`)
  return body
}

/** Open one logical stream over its own /api/remote.mux socket. */
function openStream(host, endpoint, args) {
  const url = new URL('/api/remote.mux', host.base)
  url.protocol = 'ws:'
  const streamId = crypto.randomUUID()
  const ws = new WebSocket(url, { headers: { cookie: host.cookieHeader } })
  const items = []
  const waiters = []
  const deliver = (value) => {
    items.push(value)
    for (const waiter of waiters.splice(0)) waiter()
  }
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data))
    if (msg.streamId !== streamId) return
    deliver(msg)
  })
  const opened = new Promise((resolve, reject) => {
    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({ type: 'open', streamId, endpoint, payload: { args } }))
      resolve()
    })
    ws.addEventListener('error', () => reject(new Error(`mux connect failed for ${endpoint}`)))
  })
  return {
    opened,
    ws,
    /** Wait for the first frame matching `predicate`. */
    async next(predicate, timeoutMs = 20_000) {
      const deadline = Date.now() + timeoutMs
      let cursor = 0
      while (Date.now() < deadline) {
        while (cursor < items.length) {
          const item = items[cursor += 1, cursor - 1]
          if (predicate(item)) return item
        }
        await Promise.race([
          new Promise((resolve) => waiters.push(resolve)),
          new Promise((resolve) => setTimeout(resolve, 200)),
        ])
      }
      throw new Error(`timed out waiting on ${endpoint} (${items.length} frames seen)`)
    },
    all: () => items.slice(),
    close: () => { try { ws.close() } catch { /* already closed */ } },
  }
}

// One owned run root: its manifest is what lets `cleanup.mjs` tell an orphan
// left by a crashed probe from a suite that is still running.
const roots = await createRunRoot()
const [hostPort, uiPort] = await claimPorts(2)
const controlFile = path.join(roots.dshHome, 'fake-control.json')
await writeFile(controlFile, JSON.stringify({ toolLabel: 'probe-action' }) + '\n')
await mkdir(ARTIFACT_DIR, { recursive: true })
const logPath = path.join(ARTIFACT_DIR, 'probe-host.log')

let host
let exitCode = 1
try {
  host = await startHost({
    dshHome: roots.dshHome,
    workspace: roots.workspace,
    hostPort,
    uiPort,
    controlFile,
    logPath,
    runDir: roots.runDir,
    runId: roots.runId,
    ownerToken: roots.ownerToken,
  })
  note(true, 'real pinned host booted on an isolated DSH_HOME', `${host.command} (cwd=${roots.workspace})`)

  const list = await unary(host, 'session/list', { _request: {} })
  note(list.result.ok === true, 'unary session/list over the real wire', `items=${list.result.value?.items?.length ?? 'n/a'}`)

  const created = await unary(host, 'session/create', { request: { cwd: roots.workspace } })
  const sessionId = created.result.value?.sessionId
  note(typeof sessionId === 'string' && sessionId.length > 0, 'unary session/create', `sessionId present=${Boolean(sessionId)}`)

  const catalog = await unary(host, 'session/modelCatalog', {})
  const groups = catalog.result.value?.groups ?? []
  const providers = groups.map((group) => group.id ?? group.provider)
  note(providers.includes('agos-fake') && !providers.includes('deepseek-official'),
    'ONLY the fake provider is registered (no paid route exists)', `providers=${JSON.stringify(providers)}`)

  const events = openStream(host, '$events', {})
  await events.opened
  const ready = await events.next((frame) => frame.type === 'item' && frame.value?.type === 'ready')
  note(Boolean(ready), 'real /api/remote.mux $events stream delivered the ready frame',
    `clientId present=${Boolean(ready.value.clientId)} home present=${Boolean(ready.value.host?.home)}`)

  const follow = openStream(host, 'session/follow', { request: { address: { kind: 'session', sessionId } } })
  await follow.opened
  const snapshot = await follow.next((frame) => frame.type === 'item' && frame.value?.type === 'snapshot')
  note(Boolean(snapshot), 'real session/follow opening snapshot', `cursor=${snapshot.value.cursor} hasMore=${snapshot.value.hasMore}`)

  const prompted = await unary(host, 'session/prompt', {
    request: {
      requestId: crypto.randomUUID(),
      sessionId,
      mode: 'steer',
      content: [{ type: 'text', text: '触发一次合成特权动作' }],
      clientTimeZone: 'Asia/Shanghai',
    },
  })
  note(prompted.result.ok === true, 'unary session/prompt accepted by the real agent loop')

  const waterfall = await events.next(
    (frame) => frame.type === 'item' && frame.value?.type === 'waterfall' && frame.value?.event === 'approval/request',
    45_000,
  )
  note(Boolean(waterfall), 'REAL approval/request waterfall reached the client over $events',
    `agentId present=${Boolean(waterfall.value.agentId)} callId present=${Boolean(waterfall.value.request?.callId)}`)

  const answered = await unary(host, '$events/result', {
    clientId: ready.value.clientId,
    eventId: waterfall.value.eventId,
    outcome: { kind: 'result', value: 'allowed-once' },
  })
  note(answered.result.ok === true, 'unary $events/result answered the real waterfall')

  const decided = await follow.next(
    (frame) => frame.type === 'item' && frame.value?.type === 'event'
      && frame.value?.event?.type === 'approval/decided',
    45_000,
  )
  note(Boolean(decided), 'host decision arrived on the real session/follow stream',
    `event=${decided.value.event.type}`)

  const toolDone = await follow.next(
    (frame) => frame.type === 'item' && frame.value?.type === 'event'
      && frame.value?.event?.type === 'tool/result',
    45_000,
  )
  note(Boolean(toolDone), 'fake tool executed after the real approval was granted')

  events.close()
  follow.close()
  exitCode = findings.every((finding) => finding.ok) ? 0 : 1
} catch (error) {
  note(false, 'probe aborted', String(error?.message ?? error))
} finally {
  const stopped = await host?.stop()
  if (stopped !== undefined) console.log(`host stopped: code=${stopped.code} signal=${stopped.signal}`)
  await writeFile(
    path.join(ARTIFACT_DIR, 'probe-host-findings.json'),
    JSON.stringify({ findings, hostPort, uiPort, at: new Date().toISOString() }, undefined, 2) + '\n',
  )
  await disposeRunRoot(roots)
}

console.log(`\n${findings.filter((f) => f.ok).length}/${findings.length} probe checks passed`)
process.exit(exitCode)
