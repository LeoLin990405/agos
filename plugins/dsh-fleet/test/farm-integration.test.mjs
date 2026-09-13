import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import test from 'node:test'

import { apply, Config } from '../lib/index.js'

const waitUntil = async (predicate, message, timeoutMs = 2000) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  assert.fail(message)
}

const request = async (handler, { method = 'GET', url = '/', body } = {}) => {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))])
  req.method = method
  req.url = url
  req.headers = body === undefined ? {} : { 'content-type': 'application/json' }
  const res = {
    status: null,
    headers: {},
    text: '',
    writeHead(status, headers = {}) { this.status = status; this.headers = headers },
    end(value = '') { this.text += String(value) },
  }
  await handler(req, res)
  return { status: res.status, headers: res.headers, body: res.text ? JSON.parse(res.text) : null }
}

test('index wires UI/tool through one durable global pump and drains on dispose', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-fleet-farm-integration-'))
  const stub = join(root, 'ssh')
  const starts = join(root, 'starts.log')
  const kills = join(root, 'kills.log')
  const gate = join(root, 'release')
  const ledger = join(root, 'runs.jsonl')
  const oldPath = process.env.PATH
  process.env.PATH = root + ':' + oldPath
  process.env.DSH_FLEET_LEDGER_PATH = ledger
  process.env.DSH_FLEET_SSH_STATE_DIR = join(root, 'ssh-state')
  process.env.DSH_FLEET_TEST_STARTS = starts
  process.env.DSH_FLEET_TEST_GATE = gate
  writeFileSync(stub, `#!/bin/sh
while [ "$#" -gt 0 ]; do
  case "$1" in -o) shift 2 ;; *) host="$1"; shift; break ;; esac
done
cmd="$1"
case "$cmd" in
  *"dsh --version"*) printf 'dsh-test-version\n'; exit 0 ;;
  *"TERM_FAILED"*) printf 'kill\n' >> ${JSON.stringify(kills)}; printf 'KILLED\n'; exit 0 ;;
esac
p=$(cat)
printf '%s\n' "$p" >> "$DSH_FLEET_TEST_STARTS"
while [ ! -f "$DSH_FLEET_TEST_GATE" ]; do sleep 0.01; done
printf 'OK:%s\n' "$p"
`)
  chmodSync(stub, 0o755)

  const routes = new Map()
  const tools = new Map()
  let injectCallback
  let injectedCleanup
  let jobStarts = 0
  const jobs = {
    start(spec) { jobStarts++; this.hooks = spec.run(); return 'job-1' },
    wait() { return Promise.resolve() },
    read() {},
  }
  const webServer = {
    register(spec) {
      const key = `${spec.kind}:${spec.path}`
      routes.set(key, spec.handler)
      return () => routes.delete(key)
    },
  }
  const ctx = {
    tools: { register(tool) { tools.set(tool.name, tool); return () => tools.delete(tool.name) } },
    commands: { register: () => () => {} },
    systemPrompt: { section: () => () => {} },
    subagents: { start: async () => { throw new Error('local subagent is not used') }, registerProvider() {}, list: () => [] },
    get(name) { return name === 'webServer' ? webServer : name === 'jobs' ? jobs : undefined },
    inject(dependencies, callback) {
      assert.deepEqual(dependencies, ['webServer'])
      injectCallback = callback
      injectedCleanup = callback(ctx)
      return () => { injectedCleanup?.(); injectedCleanup = null }
    },
  }
  const dispose = apply(ctx, Config({
    hosts: [{ name: 'worker', kind: 'remote', ssh: 'worker', model: 'fake', tags: ['general'], maxConcurrency: 1, enabled: true, workspace: '~/work' }],
    globalMaxConcurrency: 1,
    powerNodes: {},
  }))
  const startedLines = () => {
    try { return readFileSync(starts, 'utf8').trim().split('\n').filter(Boolean) }
    catch { return [] }
  }
  t.after(async () => {
    await dispose()
    process.env.PATH = oldPath
    delete process.env.DSH_FLEET_LEDGER_PATH
    delete process.env.DSH_FLEET_SSH_STATE_DIR
    delete process.env.DSH_FLEET_TEST_STARTS
    delete process.env.DSH_FLEET_TEST_GATE
    rmSync(root, { recursive: true, force: true })
  })

  for (const path of [
    '/api/fleet/dispatch', '/api/fleet/batches', '/api/fleet/batch', '/api/fleet/cancel',
    '/api/fleet/artifacts', '/api/fleet/power', '/api/fleet/wake', '/api/fleet/preflight', '/api/fleet/sleep',
  ]) assert.equal(typeof routes.get(`exact:${path}`), 'function', path)
  assert.equal(typeof routes.get('prefix:/fleet'), 'function')

  const power = await request(routes.get('exact:/api/fleet/power'), { url: '/api/fleet/power' })
  assert.equal(power.status, 200)
  assert.equal(power.body.nodes[0].host, 'worker')

  const dispatched = await request(routes.get('exact:/api/fleet/dispatch'), {
    method: 'POST', url: '/api/fleet/dispatch', body: { items: ['UI-FIRST'], hosts: ['worker'], wake: false },
  })
  assert.equal(dispatched.status, 202)
  assert.equal(jobStarts, 0, 'UI dispatch must not register a Job Panel job')
  await waitUntil(() => startedLines().length === 1, 'UI run did not start')

  const toolPromise = tools.get('fleet_run').execute(
    { items: ['TOOL-SECOND'] },
    { agent: { id: 'agent-1', session: { id: 'session-1' } }, signal: new AbortController().signal, callId: 'call-1' },
  )
  await new Promise((resolve) => setTimeout(resolve, 75))
  assert.deepEqual(startedLines(), ['UI-FIRST'], 'globalMaxConcurrency must span UI and tool batches')
  writeFileSync(gate, 'go')
  assert.match(await toolPromise, /OK:TOOL-SECOND/)
  assert.equal(jobStarts, 1, 'fleet_run remains the sole Job Panel entry')
  assert.deepEqual(startedLines(), ['UI-FIRST', 'TOOL-SECOND'])

  rmSync(gate, { force: true })
  const live = await request(routes.get('exact:/api/fleet/dispatch'), {
    method: 'POST', url: '/api/fleet/dispatch', body: { items: ['LIVE-CANCEL'], hosts: ['worker'], wake: false },
  })
  await waitUntil(() => startedLines().length === 3, 'live cancellation fixture did not start')
  const cancelled = await request(routes.get('exact:/api/fleet/cancel'), {
    method: 'POST', url: '/api/fleet/cancel', body: { runId: live.body.runs[0].runId, host: 'worker' },
  })
  assert.equal(cancelled.status, 200)
  assert.equal(cancelled.body.skipped[0].reason, 'controller')
  await waitUntil(() => readFileSync(ledger, 'utf8').split('\n').some((line) => line.includes('"ev":"cancel"') && line.includes(live.body.runs[0].runId)), 'live cancel was not confirmed')
  assert.equal(readFileSync(kills, 'utf8').trim().split('\n').length, 1, 'live cancel must issue exactly one kill SSH')

  const events = readFileSync(ledger, 'utf8').trim().split('\n').map(JSON.parse)
  assert.deepEqual([...new Set(events.filter((event) => event.ev === 'dispatch').map((event) => event.origin))].sort(), ['tool', 'ui'])
  assert.ok(events.findIndex((event) => event.ev === 'dispatch' && event.origin === 'ui') < events.findIndex((event) => event.ev === 'start' && event.batchId === dispatched.body.batchId))

  const mountedRouteCount = routes.size
  injectedCleanup()
  injectedCleanup()
  assert.equal(routes.size, 0, 'dependency removal cleanup is idempotent')
  injectedCleanup = injectCallback(ctx)
  assert.equal(routes.size, mountedRouteCount, 'dependency reappearance remounts one route set')

  await dispose()
  assert.equal(routes.size, 0)
  assert.equal(tools.size, 0)
  await dispose()
  assert.equal(routes.size, 0, 'whole-plugin dispose is idempotent after dependency churn')
})

test('rehydrated cancel kills only a proven live pid and queued reservations block sleep', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-fleet-recovered-cancel-'))
  const ledger = join(root, 'runs.jsonl')
  const killLog = join(root, 'kill.log')
  const sleepLog = join(root, 'sleep.log')
  const stubSsh = join(root, 'ssh')
  const stubSleep = join(root, 'sleep')
  const oldPath = process.env.PATH
  process.env.PATH = root + ':' + oldPath
  process.env.DSH_FLEET_LEDGER_PATH = ledger
  process.env.DSH_FLEET_SSH_STATE_DIR = join(root, 'ssh-state')

  const at = Date.now() - 1000
  const events = [
    { v: 1, at, ev: 'dispatch', batchId: 'b-cancel', runId: 'r-alive', index: 1, host: 'worker-cancel', runDir: '~/cancel-work/tasks/r-alive', origin: 'ui', prompt: '#1', status: 'queued', timeoutMs: 900000 },
    { v: 1, at: at + 1, ev: 'start', batchId: 'b-cancel', runId: 'r-alive', startedAt: at + 1, timeoutMs: 900000 },
    { v: 1, at: at + 2, ev: 'dispatch', batchId: 'b-cancel', runId: 'r-offline', index: 2, host: 'worker-cancel', runDir: '~/cancel-work/tasks/r-offline', origin: 'ui', prompt: '#2', status: 'queued', timeoutMs: 900000 },
    { v: 1, at: at + 3, ev: 'start', batchId: 'b-cancel', runId: 'r-offline', startedAt: at + 3, timeoutMs: 900000 },
    { v: 1, at: at + 4, ev: 'dispatch', batchId: 'b-queued', runId: 'r-queued', index: 1, host: 'worker-sleep', runDir: '~/sleep-work/tasks/r-queued', origin: 'ui', prompt: '#1', status: 'queued', timeoutMs: 900000 },
    { v: 1, at: at + 5, ev: 'wake', host: 'worker-sleep', node: 'node-sleep', batchId: 'b-wake', source: 'ui', deadlineAt: at + 60000 },
    { v: 1, at: at + 6, ev: 'wake-ready', host: 'worker-sleep', node: 'node-sleep', batchId: 'b-wake', source: 'ui' },
    { v: 1, at: at + 7, ev: 'sleep-eligible', host: 'worker-sleep', batchId: 'b-wake' },
  ]
  writeFileSync(ledger, events.map((event) => JSON.stringify(event)).join('\n') + '\n')
  writeFileSync(stubSsh, `#!/bin/sh
while [ "$#" -gt 0 ]; do case "$1" in -o) shift 2 ;; *) host="$1"; shift; break ;; esac; done
cmd="$1"
case "$cmd" in
  *"cd "*"r-alive"*) printf 'ALIVE 4242\\n'; exit 0 ;;
  *"cd "*"r-offline"*) printf 'transport down\\n' >&2; exit 255 ;;
  *"TERM_FAILED"*) printf 'kill\\n' >> ${JSON.stringify(killLog)}; printf 'KILLED\\n'; exit 0 ;;
  *"dsh --version"*) printf 'dsh-test-version\\n'; exit 0 ;;
esac
exit 0
`)
  writeFileSync(stubSleep, `#!/bin/sh
printf '%s\\n' "$*" >> ${JSON.stringify(sleepLog)}
exit 0
`)
  chmodSync(stubSsh, 0o755)
  chmodSync(stubSleep, 0o755)

  const routes = new Map()
  const webServer = { register(spec) { routes.set(`${spec.kind}:${spec.path}`, spec.handler); return () => routes.delete(`${spec.kind}:${spec.path}`) } }
  const ctx = {
    tools: { register: () => () => {} }, commands: { register: () => () => {} },
    systemPrompt: { section: () => () => {} }, subagents: { registerProvider() {}, list: () => [] },
    get(name) { return name === 'webServer' ? webServer : undefined },
    inject(_dependencies, callback) { return callback(ctx) },
  }
  const dispose = apply(ctx, Config({
    hosts: [
      { name: 'worker-cancel', kind: 'remote', ssh: 'worker-cancel', enabled: true, maxConcurrency: 2, workspace: '~/cancel-work' },
      { name: 'worker-sleep', kind: 'remote', ssh: 'worker-sleep', enabled: true, maxConcurrency: 1, workspace: '~/sleep-work' },
    ],
    powerNodes: { 'worker-sleep': 'node-sleep' },
    sleepAllowedHosts: ['worker-sleep'],
    sleepCommand: stubSleep,
  }))
  t.after(async () => {
    await dispose()
    process.env.PATH = oldPath
    delete process.env.DSH_FLEET_LEDGER_PATH
    delete process.env.DSH_FLEET_SSH_STATE_DIR
    rmSync(root, { recursive: true, force: true })
  })

  const cancel = routes.get('exact:/api/fleet/cancel')
  const live = await request(cancel, { method: 'POST', url: '/api/fleet/cancel', body: { runId: 'r-alive', host: 'worker-cancel' } })
  assert.equal(live.status, 200)
  assert.deepEqual(live.body.cancelled, ['r-alive'])
  assert.equal(readFileSync(killLog, 'utf8'), 'kill\n')

  const offline = await request(cancel, { method: 'POST', url: '/api/fleet/cancel', body: { runId: 'r-offline', host: 'worker-cancel' } })
  assert.equal(offline.status, 200)
  assert.deepEqual(offline.body.cancelled, [])
  assert.equal(offline.body.skipped[0].reason, 'detached')

  const sleep = await request(routes.get('exact:/api/fleet/sleep'), {
    method: 'POST', url: '/api/fleet/sleep', body: { host: 'worker-sleep', confirm: 'SLEEP' },
  })
  assert.equal(sleep.status, 409)
  assert.equal(sleep.body.code, 'HOST_BUSY')
  assert.throws(() => readFileSync(sleepLog, 'utf8'), /ENOENT/)

  const stored = readFileSync(ledger, 'utf8').trim().split('\n').map(JSON.parse)
  assert.equal(stored.some((event) => event.ev === 'cancel' && event.runId === 'r-alive'), true)
  assert.equal(stored.some((event) => event.ev === 'cancel' && event.runId === 'r-offline'), false)
  assert.equal(stored.filter((event) => event.ev === 'detach' && event.runId === 'r-offline').at(-1).cancelPending, true)
})

test('fleet_run rejects a 100KB item instead of sending it to ssh', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'fleet-reject-large-'))
  const oldLedger = process.env.DSH_FLEET_LEDGER_PATH
  const oldState = process.env.DSH_FLEET_SSH_STATE_DIR
  process.env.DSH_FLEET_LEDGER_PATH = join(root, 'runs.jsonl')
  process.env.DSH_FLEET_SSH_STATE_DIR = join(root, 'ssh-state')
  t.after(() => {
    if (oldLedger === undefined) delete process.env.DSH_FLEET_LEDGER_PATH
    else process.env.DSH_FLEET_LEDGER_PATH = oldLedger
    if (oldState === undefined) delete process.env.DSH_FLEET_SSH_STATE_DIR
    else process.env.DSH_FLEET_SSH_STATE_DIR = oldState
    rmSync(root, { recursive: true, force: true })
  })
  const tools = new Map()
  const ctx = {
    tools: { register(tool) { tools.set(tool.name, tool); return () => tools.delete(tool.name) } },
    commands: { register: () => () => {} }, systemPrompt: { section: () => () => {} },
    subagents: { registerProvider() {}, list: () => [] },
    get() { return undefined }, inject: () => {},
  }
  const dispose = apply(ctx, Config({
    hosts: [{ name: 'worker', kind: 'remote', ssh: 'worker', enabled: true, maxConcurrency: 1, workspace: '~/work' }],
    powerNodes: {},
  }))
  try {
    await assert.rejects(
      () => tools.get('fleet_run').execute(
        { items: ['x'.repeat(100 * 1024)] },
        { agent: { id: 'agent', session: { id: 'session' } }, signal: new AbortController().signal, callId: 'too-big' },
      ),
      /items\[0\] exceeds 8000 characters/,
    )
  } finally {
    await dispose()
  }
})

test('early ssh exit with a max-legal prompt is detached without an unhandled stdin EPIPE', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-fleet-epipe-'))
  const ledger = join(root, 'runs.jsonl')
  const stubSsh = join(root, 'ssh')
  const oldPath = process.env.PATH
  process.env.PATH = root + ':' + oldPath
  process.env.DSH_FLEET_LEDGER_PATH = ledger
  process.env.DSH_FLEET_SSH_STATE_DIR = join(root, 'ssh-state')
  writeFileSync(stubSsh, `#!/bin/sh
while [ "$#" -gt 0 ]; do case "$1" in -o) shift 2 ;; *) host="$1"; shift; break ;; esac; done
cmd="$1"
case "$cmd" in
  *"dsh --version"*) printf 'dsh-test-version\\n'; exit 0 ;;
  *"dsh --profile headless"*) exit 255 ;;
  *"cd "*"/tasks/"*) printf 'MISSING\\n'; exit 0 ;;
esac
exit 0
`)
  chmodSync(stubSsh, 0o755)

  const tools = new Map()
  let hooks
  const jobs = { start(spec) { hooks = spec.run(); return 'epipe-job' }, wait: async () => {}, read() {} }
  const ctx = {
    tools: { register(tool) { tools.set(tool.name, tool); return () => tools.delete(tool.name) } },
    commands: { register: () => () => {} }, systemPrompt: { section: () => () => {} },
    subagents: { registerProvider() {}, list: () => [] },
    get(name) { return name === 'jobs' ? jobs : undefined }, inject: () => {},
  }
  const dispose = apply(ctx, Config({
    hosts: [{ name: 'worker', kind: 'remote', ssh: 'worker', enabled: true, maxConcurrency: 1, workspace: '~/work' }],
    powerNodes: {},
  }))
  // execute() keeps ssh/preflight in flight; delete the stub only after that
  // promise settles. Formal-gate file parallelism can delay the 255→detach
  // ledger write past a 2s poll, and a mid-flight rmSync surfaces as
  // unhandledRejection on the leftover preflight.
  let run = Promise.resolve()
  t.after(async () => {
    try { hooks?.cancel() } catch { /* already settled */ }
    try { await run } catch { /* assertion already observed the outcome */ }
    await dispose()
    process.env.PATH = oldPath
    delete process.env.DSH_FLEET_LEDGER_PATH
    delete process.env.DSH_FLEET_SSH_STATE_DIR
    rmSync(root, { recursive: true, force: true })
  })

  run = tools.get('fleet_run').execute(
    { items: ['x'.repeat(8000)] },
    { agent: { id: 'agent', session: { id: 'session' } }, signal: new AbortController().signal, callId: 'epipe' },
  )
  await waitUntil(() => {
    try { return readFileSync(ledger, 'utf8').includes('"ev":"detach"') } catch { return false }
  }, 'transport exit 255 was not recorded as detached', 10000)
  hooks.cancel()
  assert.match(await run, /outcome="failed"/)
  const stored = readFileSync(ledger, 'utf8').trim().split('\n').map(JSON.parse)
  assert.equal(stored.some((event) => event.ev === 'detach'), true)
  assert.equal(stored.some((event) => event.ev === 'reattach' && event.state === 'lost'), true)
})

test('run timer keeps the durable slot detached when its remote kill transport fails', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-fleet-timeout-kill-'))
  const ledger = join(root, 'runs.jsonl')
  const killLog = join(root, 'kill.log')
  const stubSsh = join(root, 'ssh')
  const oldPath = process.env.PATH
  process.env.PATH = root + ':' + oldPath
  process.env.DSH_FLEET_LEDGER_PATH = ledger
  process.env.DSH_FLEET_SSH_STATE_DIR = join(root, 'ssh-state')
  writeFileSync(stubSsh, `#!/bin/sh
while [ "$#" -gt 0 ]; do case "$1" in -o) shift 2 ;; *) host="$1"; shift; break ;; esac; done
cmd="$1"
case "$cmd" in
  *"dsh --version"*) printf 'dsh-test-version\\n'; exit 0 ;;
  *"TERM_FAILED"*) printf 'kill\\n' >> ${JSON.stringify(killLog)}; exit 255 ;;
  *"dsh --profile headless"*) sleep 2; exit 0 ;;
  *"cd "*"/tasks/"*) printf 'MISSING\\n'; exit 0 ;;
esac
exit 0
`)
  chmodSync(stubSsh, 0o755)

  const tools = new Map()
  let hooks
  const jobs = { start(spec) { hooks = spec.run(); return 'timeout-job' }, wait: async () => {}, read() {} }
  const ctx = {
    tools: { register(tool) { tools.set(tool.name, tool); return () => tools.delete(tool.name) } },
    commands: { register: () => () => {} }, systemPrompt: { section: () => () => {} },
    subagents: { registerProvider() {}, list: () => [] },
    get(name) { return name === 'jobs' ? jobs : undefined }, inject: () => {},
  }
  const dispose = apply(ctx, Config({
    hosts: [{ name: 'worker', kind: 'remote', ssh: 'worker', enabled: true, maxConcurrency: 1, workspace: '~/work' }],
    powerNodes: {}, taskTimeoutMs: 25,
  }))
  let run = Promise.resolve()
  t.after(async () => {
    try { hooks?.cancel() } catch { /* already settled */ }
    try { await run } catch { /* assertion already observed the outcome */ }
    await dispose()
    process.env.PATH = oldPath
    delete process.env.DSH_FLEET_LEDGER_PATH
    delete process.env.DSH_FLEET_SSH_STATE_DIR
    rmSync(root, { recursive: true, force: true })
  })

  run = tools.get('fleet_run').execute(
    { items: ['timeout prompt'] },
    { agent: { id: 'agent', session: { id: 'session' } }, signal: new AbortController().signal, callId: 'timeout' },
  )
  await waitUntil(() => {
    try { return readFileSync(ledger, 'utf8').includes('timeout remote kill failed') } catch { return false }
  }, 'failed timeout kill did not become detached', 10000)
  let stored = readFileSync(ledger, 'utf8').trim().split('\n').map(JSON.parse)
  assert.equal(stored.some((event) => event.ev === 'end' && event.error === 'TIMEOUT'), false)
  assert.equal(readFileSync(killLog, 'utf8').trim().split('\n').length, 1)
  hooks.cancel()
  assert.match(await run, /outcome="failed"/)
  stored = readFileSync(ledger, 'utf8').trim().split('\n').map(JSON.parse)
  assert.equal(stored.some((event) => event.ev === 'reattach' && event.state === 'lost'), true)
})
