import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, Config } from '../lib/index.js'

const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }

for (const action of ['cancel', 'plugin-dispose', 'cleanup-failure']) {
  test(`local ${action} retains its slot until result and cleanup have settled`, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'fleet-local-cleanup-'))
    const prior = { ledger: process.env.DSH_FLEET_LEDGER_PATH, state: process.env.DSH_FLEET_SSH_STATE_DIR }
    process.env.DSH_FLEET_LEDGER_PATH = join(directory, 'runs.jsonl')
    process.env.DSH_FLEET_SSH_STATE_DIR = join(directory, 'ssh')
    const toolMap = new Map(), started = deferred(), result = deferred(), cleanupStarted = deferred(), cleanup = deferred(), aborted = deferred()
    let calls = 0
    const ctx = {
      tools: { register(tool) { toolMap.set(tool.name, tool); return () => {} } },
      commands: { register: () => () => {} }, systemPrompt: { section: () => () => {} },
      subagents: { registerProvider() {}, list: () => [], async start(_name, options) {
        calls++
        if (calls > 1) return { result: Promise.resolve({ output: [{ type: 'text', text: 'second' }] }), async dispose() {} }
        options.signal.addEventListener('abort', () => aborted.resolve(), { once: true })
        started.resolve()
        return { result: result.promise, async dispose() { cleanupStarted.resolve(); await cleanup.promise } }
      } },
      get() { return undefined }, inject() {},
    }
    const dispose = apply(ctx, Config({ hosts: [{ name: 'local', kind: 'local', maxConcurrency: 1 }], globalMaxConcurrency: 1, powerNodes: {} }))
    let disposing
    t.after(async () => {
      result.resolve({ output: [{ type: 'text', text: 'late result' }] }); cleanup.resolve()
      await (disposing ?? dispose())
      if (prior.ledger === undefined) delete process.env.DSH_FLEET_LEDGER_PATH; else process.env.DSH_FLEET_LEDGER_PATH = prior.ledger
      if (prior.state === undefined) delete process.env.DSH_FLEET_SSH_STATE_DIR; else process.env.DSH_FLEET_SSH_STATE_DIR = prior.state
      await rm(directory, { recursive: true, force: true })
    })
    const controller = new AbortController()
    let returned = false
    const running = toolMap.get('fleet_run').execute({ items: ['first', 'second'], include_local: true }, {
      agent: { id: 'local-owner', session: { id: 'local-session' } }, signal: controller.signal, callId: 'local-test',
    }).then((value) => { returned = true; return value })
    await started.promise
    let disposed = false
    if (action === 'plugin-dispose') disposing = dispose().then(() => { disposed = true })
    else controller.abort('user cancel')
    await aborted.promise
    const events = async () => (await readFile(join(directory, 'runs.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse)
    const firstId = (await events()).find((event) => event.ev === 'start').runId
    const firstTerminal = async () => (await events()).filter((event) => event.runId === firstId && ['end', 'cancel'].includes(event.ev))
    assert.equal(returned, false)
    assert.equal(disposed, false)
    assert.equal(calls, 1, 'no new subagent may start while cancellation is pending')
    assert.deepEqual(await firstTerminal(), [])
    result.resolve({ output: [{ type: 'text', text: 'late result' }] })
    await cleanupStarted.promise
    assert.equal(returned, false, 'result settlement alone must not release the runner')
    assert.deepEqual(await firstTerminal(), [])
    if (action === 'cleanup-failure') cleanup.reject(new Error('fixture cleanup failed'))
    else cleanup.resolve()
    const output = await running
    if (disposing) await disposing
    const terminal = await firstTerminal()
    assert.equal(terminal.length, 1)
    if (action === 'cleanup-failure') {
      assert.equal(terminal[0].ev, 'end')
      assert.equal(terminal[0].ok, false)
      assert.match(terminal[0].error, /cleanup failed/)
      assert.match(output, /cleanup failed/)
    } else assert.equal(terminal[0].ev, 'cancel')
    assert.equal(calls, 1)
  })
}

test('dispose drains a tool cancelled between durable start and subagent spawn', async (t) => {
  const { FleetRuntime } = await import('../lib/fleet-runtime.mjs')
  const directory = await mkdtemp(join(tmpdir(), 'fleet-local-start-barrier-'))
  const prior = { ledger: process.env.DSH_FLEET_LEDGER_PATH, state: process.env.DSH_FLEET_SSH_STATE_DIR }
  process.env.DSH_FLEET_LEDGER_PATH = join(directory, 'runs.jsonl')
  process.env.DSH_FLEET_SSH_STATE_DIR = join(directory, 'ssh')
  const savedStart = FleetRuntime.prototype.markStart, started = deferred(), releaseStart = deferred(), cancelled = deferred()
  const savedCancel = FleetRuntime.prototype.cancelRun
  FleetRuntime.prototype.markStart = async function (...args) {
    const value = await savedStart.apply(this, args)
    started.resolve()
    await releaseStart.promise
    return value
  }
  FleetRuntime.prototype.cancelRun = async function (...args) {
    const value = await savedCancel.apply(this, args)
    cancelled.resolve()
    return value
  }
  const tools = new Map()
  let spawned = 0
  const ctx = {
    tools: { register(tool) { tools.set(tool.name, tool); return () => {} } },
    commands: { register: () => () => {} }, systemPrompt: { section: () => () => {} },
    subagents: { list: () => [], registerProvider() {}, async start() { spawned++; throw new Error('must not spawn') } },
    get() {}, inject() {},
  }
  const dispose = apply(ctx, Config({ hosts: [{ name: 'local', kind: 'local', maxConcurrency: 1 }], powerNodes: {} }))
  let disposing
  t.after(async () => {
    releaseStart.resolve()
    await (disposing ?? dispose())
    FleetRuntime.prototype.markStart = savedStart
    FleetRuntime.prototype.cancelRun = savedCancel
    if (prior.ledger === undefined) delete process.env.DSH_FLEET_LEDGER_PATH; else process.env.DSH_FLEET_LEDGER_PATH = prior.ledger
    if (prior.state === undefined) delete process.env.DSH_FLEET_SSH_STATE_DIR; else process.env.DSH_FLEET_SSH_STATE_DIR = prior.state
    await rm(directory, { recursive: true, force: true })
  })
  let returned = false
  const running = tools.get('fleet_run').execute({ items: ['pending start'], include_local: true }, {
    agent: { id: 'owner', session: { id: 'session' } }, signal: new AbortController().signal, callId: 'barrier',
  }).then((value) => { returned = true; return value })
  await started.promise
  disposing = dispose()
  await cancelled.promise
  // Let dispose finish its first sweep before the delayed start continuation.
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(returned, false)
  releaseStart.resolve()
  await disposing
  const output = await running
  assert.equal(spawned, 0)
  assert.match(output, /outcome="failed"/)
})
