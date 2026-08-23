import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ledgerRoot = mkdtempSync(join(tmpdir(), 'dsh-fleet-fake-jobs-'))
process.env.DSH_FLEET_SSH_STATE_DIR = join(ledgerRoot, 'ssh-state')
let harnessSequence = 0

const { apply, Config } = await import('../lib/index.js')

const LOCAL_HOST = {
  name: 'local', kind: 'local', model: 'fake-model', tags: ['general'],
  maxConcurrency: 1, enabled: true,
}

function makeJobs({ throwOnStart = false } = {}) {
  const calls = { starts: [], waits: [], reads: [] }
  let hooks = null
  const service = {
    start(spec) {
      calls.starts.push(spec)
      if (throwOnStart) throw new Error('fake jobs.start failure')
      hooks = spec.run()
      return 'job-fleet-1'
    },
    wait(id, timeout, owner) {
      calls.waits.push({ id, timeout, owner })
      return Promise.resolve()
    },
    read(id, owner) {
      calls.reads.push({ id, owner })
    },
  }
  return { service, calls, get hooks() { return hooks } }
}

function makeHarness({ jobs, getThrows = false, hosts = [LOCAL_HOST] } = {}) {
  process.env.DSH_FLEET_LEDGER_PATH = join(ledgerRoot, `runs-${++harnessSequence}.jsonl`)
  const tools = new Map()
  const started = []
  const ctx = {
    tools: { register: (tool) => { tools.set(tool.name, tool); return () => tools.delete(tool.name) } },
    commands: { register: () => () => {} },
    systemPrompt: { section: () => () => {} },
    subagents: {
      async start(_provider, options) {
        const prompt = options.prompt[0].text
        started.push({ prompt, signal: options.signal })
        let result
        if (prompt.includes('BLOCK')) {
          result = new Promise((_, reject) => {
            const fail = () => reject(new Error('fake child aborted'))
            if (options.signal?.aborted) fail()
            else options.signal?.addEventListener('abort', fail, { once: true })
          })
        } else if (prompt.includes('FAIL')) {
          result = Promise.reject(new Error('fake child failed'))
        } else {
          result = Promise.resolve({
            stopReason: 'completed',
            output: [{ type: 'text', text: 'OK:' + prompt }],
          })
        }
        return { id: 'child-' + started.length, result, async dispose() {} }
      },
    },
    get(name) {
      if (getThrows && name === 'jobs') throw new Error('fake ctx.get failure')
      return name === 'jobs' ? jobs?.service : undefined
    },
    inject: () => {},
  }
  apply(ctx, Config({ hosts, globalMaxConcurrency: 1 }))
  return { tools, started }
}

test.after(() => {
  delete process.env.DSH_FLEET_LEDGER_PATH
  delete process.env.DSH_FLEET_SSH_STATE_DIR
  rmSync(ledgerRoot, { recursive: true, force: true })
})

const makeExec = () => ({
  agent: { session: { id: 'parent-session' }, id: 'parent-session' },
  signal: new AbortController().signal,
  callId: 'fleet-call',
})

const runFleet = (harness, items) => harness.tools.get('fleet_run').execute(
  { items, include_local: true }, makeExec(),
)

async function waitUntil(predicate, message) {
  const deadline = Date.now() + 2000
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
  assert.fail(message)
}

async function allowDeferredRead() {
  await new Promise((resolve) => setTimeout(resolve, 10))
}

test('fleet_run registers a sliced fleet label and settles completed via wait/read', async () => {
  const jobs = makeJobs()
  const harness = makeHarness({ jobs })
  const long = '很长的任务描述'.repeat(30)
  const output = await runFleet(harness, [long, '第二项'])
  const settled = await jobs.hooks.done
  await allowDeferredRead()

  assert.match(output, /<agent_swarm_result>/)
  assert.equal(jobs.calls.starts.length, 1)
  assert.ok(jobs.calls.starts[0].label.startsWith('fleet ×2 · '))
  assert.equal(jobs.calls.starts[0].label.length, 120)
  assert.equal(settled.status, 'completed')
  assert.equal(settled.detail, '2/2 完成')
  assert.equal(jobs.calls.waits.length, 1)
  assert.equal(jobs.calls.waits[0].id, 'job-fleet-1')
  assert.equal(jobs.calls.reads.length, 1)
  assert.equal(jobs.calls.reads[0].id, 'job-fleet-1')
})

test('fleet_run settles failed when any child fails', async () => {
  const jobs = makeJobs()
  const harness = makeHarness({ jobs })
  await runFleet(harness, ['成功项', 'FAIL 项'])
  const settled = await jobs.hooks.done
  await allowDeferredRead()

  assert.equal(settled.status, 'failed')
  assert.equal(settled.detail, '1/2 完成 · 1 失败')
  assert.equal(jobs.calls.waits.length, 1)
  assert.equal(jobs.calls.reads.length, 1)
})

test('preflight failure counts every unsettled item and still executes wait/read', async () => {
  const jobs = makeJobs()
  const harness = makeHarness({ jobs, hosts: [{ ...LOCAL_HOST, enabled: false }] })

  await assert.rejects(runFleet(harness, ['预检一', '预检二']), /没有可用的机/)
  const settled = await jobs.hooks.done
  await allowDeferredRead()

  assert.equal(settled.status, 'failed')
  assert.equal(settled.detail, '0/2 完成 · 2 失败')
  assert.equal(jobs.calls.waits.length, 1)
  assert.equal(jobs.calls.reads.length, 1)
})

test('job cancel aborts the active child, never launches pending items, and settles killed', async () => {
  const jobs = makeJobs()
  const harness = makeHarness({ jobs })
  const running = runFleet(harness, ['BLOCK 第一项', '不应启动二', '不应启动三'])
  await waitUntil(() => jobs.hooks && harness.started.length === 1, 'first fleet child did not start')

  jobs.hooks.cancel()
  const output = await running
  const settled = await jobs.hooks.done
  await allowDeferredRead()

  assert.match(output, /fleet: 0\/3 done/)
  assert.equal(harness.started.length, 1, 'cancel 后不应继续派 pending 项')
  assert.equal(harness.started[0].signal.aborted, true, '在飞 child 必须收到 abort')
  assert.equal(settled.status, 'killed')
  assert.equal(settled.detail, '0/3 完成 · 3 失败')
  assert.equal(jobs.calls.waits.length, 1)
  assert.equal(jobs.calls.reads.length, 1)
})

test('missing jobs service is a soft downgrade with unchanged fleet output', async () => {
  const harness = makeHarness()
  const output = await runFleet(harness, ['无 jobs 也要完成'])

  assert.match(output, /fleet: 1\/1 done/)
  assert.equal(harness.started.length, 1)
})

test('ctx.get/jobs.start exceptions are soft downgrades', async () => {
  const getFailure = makeHarness({ getThrows: true })
  assert.match(await runFleet(getFailure, ['get failure']), /fleet: 1\/1 done/)

  const jobs = makeJobs({ throwOnStart: true })
  const startFailure = makeHarness({ jobs })
  assert.match(await runFleet(startFailure, ['start failure']), /fleet: 1\/1 done/)
})
