import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../lib/index.js'
import { readLedgerLines, appendLine } from '../lib/ledger.js'
import { allocationStateFromLedger, assembleTeam } from '../lib/assemble.js'
import { dispatchTeam } from '../lib/dispatch.js'
import { taskFingerprint } from '../lib/task-fingerprint.mjs'
import { FleetLedger } from '../../dsh-fleet/lib/fleet-ledger.mjs'

const DEC = 'dec-1787000000000-abcdef12'
const BATCH = 'b-f785f00d-8463-4369-9a02-4bf6dc7e3024'
const OTHER_BATCH = 'b-f785f00d-8463-4369-9a02-4bf6dc7e3025'
const decision = (id = DEC) => ({ id, ts: 1, role: 'implementer', label: 'implementer',
  taskType: 'implementer', pick: 'qwen3.8-max', source: 'selector', outcome: null,
  candidates: ['glm-5.2', 'qwen3.8-max', 'minimax-m3'] })

async function fixture(t, initial = [], config = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'agos-feedback-routes-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const auditFile = join(dir, 'route-outcome.jsonl')
  const runsFile = join(dir, 'runs.jsonl')
  const originalFleetFile = process.env.DSH_FLEET_RUNS_FILE
  process.env.DSH_FLEET_RUNS_FILE = runsFile
  t.after(() => {
    if (originalFleetFile === undefined) delete process.env.DSH_FLEET_RUNS_FILE
    else process.env.DSH_FLEET_RUNS_FILE = originalFleetFile
  })
  await writeFile(auditFile, initial.map((row) => JSON.stringify(row)).join('\n') + '\n')
  const handlers = new Map()
  apply({ logger: () => ({ warn() {}, info() {} }), llm: undefined,
    inject(names, cb) {
      if (names.includes('webServer')) cb({ get: () => ({ register(route) { handlers.set(route.path, route.handler) } }) })
    },
  }, { provider: '', model: '', auditFile, ...config })
  async function call(path, body, method = 'POST') {
    const listeners = {}
    let status, result
    const req = { method, url: path, headers: {}, destroy() {}, on(name, fn) { listeners[name] = fn; return this } }
    const pending = handlers.get(path)(req, { writeHead(value) { status = value }, end(value) { result = JSON.parse(value) } })
    if (body !== undefined) listeners.data?.(Buffer.from(JSON.stringify(body)))
    listeners.end?.()
    await pending
    return { status, body: result }
  }
  return { call, auditFile, runsFile }
}

test('real outcome route owns source, requires a decision, and makes retries idempotent without rewriting results', async (t) => {
  const f = await fixture(t, [decision(), { ...decision('dec-2'), outcome: 'fail' }])
  const post = (body) => f.call('/api/agos/routes/outcome', body)
  for (const body of [
    { ref: 'missing', result: 'ok' },
    { ref: DEC, result: 'ok', source: 'reviewer-verdict' },
    { ref: DEC, result: 'ok', source: 'fleet-end' },
    { ref: 'dec-2', result: 'ok' },
  ]) assert.equal((await post(body)).status, 400)
  assert.equal(readLedgerLines(f.auditFile).length, 2)
  const first = await post({ ref: DEC, result: 'ok', source: 'client-custom', learnable: false })
  assert.equal(first.status, 200)
  assert.equal(first.body.source, 'manual')
  assert.equal(first.body.learnable, true)
  assert.equal((await post({ ref: DEC, result: 'ok' })).status, 200)
  assert.equal((await post({ ref: DEC, result: 'fail' })).status, 400)
  assert.equal((await post({ ref: 'dec-2', result: 'fail' })).status, 200)
  assert.equal(readLedgerLines(f.auditFile).filter((row) => row.kind === 'outcome').length, 1)
})

test('actual GET statistics and POST assemble exclude rejected feedback, including old overlaid and inline results', async (t) => {
  const rows = [decision(),
    { kind: 'outcome', ref: DEC, result: 'ok', at: 1 },
    { kind: 'outcome', ref: DEC, result: 'fail', at: 2, learnable: false },
    { ...decision('dec-2'), outcome: 'ok', learnable: false },
    decision('dec-3'),
    { kind: 'outcome', ref: 'dec-3', result: 'ok', source: 'reviewer-verdict', judge: 'Qwen3.8-Max', judged: 'qwen3.8-max' },
  ]
  const f = await fixture(t, rows, { posteriorHalfLifeDays: 7 })
  assert.deepEqual(allocationStateFromLedger(rows), [])
  const before = await f.call('/api/agos/routes', undefined, 'GET')
  assert.equal(before.body.stats.posterior.observations, 0)
  const made = await f.call('/api/agos/routes/assemble', { confirm: true, role: 'implementer', task: 'write docs' })
  assert.equal(made.status, 200)
  assert.equal(made.body.assemble.decay.effectiveObservations, 0)
  const expected = assembleTeam(made.body.decision, []).allocation
  assert.deepEqual(made.body.assemble.allocation, expected)
})

test('dispatch blocks same-model reviewer before a provider call and never books self-review', async () => {
  const model = 'qwen3.8-max'
  for (const candidates of [[model], ['glm-5.2', model]]) {
    const target = { ...decision(), candidates }
    const team = { id: 'asm-1', ref: DEC, roles: [
      { role: 'planner', model: 'glm-5.2' }, { role: 'implementer', model }, { role: 'reviewer', model },
    ] }
    const rows = [target]
    const called = []
    const result = await dispatchTeam(team, { confirm: true }, {
      readRows: () => rows,
      append: (row) => rows.push(row),
      streamRole: async ({ role }) => { called.push(role); return role === 'reviewer' ? '判定：通过' : 'text' },
    })
    assert.deepEqual(called, ['planner', 'implementer'])
    assert.equal(result.dispatch.verdictFed, false)
    assert.equal(result.dispatch.learnable, false)
    assert.match(result.dispatch.verdictSkip, /NOT_INDEPENDENT|POOL_TOO_SMALL/)
    assert.equal(rows.some((row) => row.kind === 'outcome'), false)
  }
})

test('real shadow-link validates full task identity, server hosts, time, cardinality and immutable one-to-one binding', async (t) => {
  const f = await fixture(t)
  const task = `${'same prefix '.repeat(80)} full task A`
  const hosts = [{ name: 'host-a', kind: 'remote', enabled: true }]
  const made = await f.call('/api/agos/routes/shadow', {
    items: [task], hosts, taskFingerprints: [taskFingerprint('forged')],
  })
  assert.equal(made.status, 200)
  assert.deepEqual(made.body.shadow.taskFingerprints, [taskFingerprint(task)])
  const ref = made.body.id
  const run = { ev: 'dispatch', batchId: BATCH, runId: 'r-1', index: 1,
    host: 'host-a', at: made.body.ts + 1, taskFingerprint: taskFingerprint(task) }
  const writeRuns = (rows) => writeFile(f.runsFile, rows.map((row) => JSON.stringify(row)).join('\n') + '\n')
  const link = (batchId = BATCH) => f.call('/api/agos/routes/shadow/link', {
    ref, batchId, hosts: ['forged-host'], task: 'fleet-dispatch', taskFingerprint: taskFingerprint(task),
  })
  for (const invalid of [
    [{ ...run, taskFingerprint: undefined }],
    [{ ...run, taskFingerprint: taskFingerprint(task.replace('task A', 'task B')) }],
    [{ ...run, at: made.body.ts - 1 }],
    [{ ...run, index: 2 }],
    [run, { ...run, runId: 'r-2', index: 2 }],
    [{ ev: 'end', batchId: BATCH, runId: 'r-1', ok: true }],
  ]) {
    await writeRuns(invalid)
    assert.equal((await link()).status, 400)
  }
  await writeRuns([run, { ...run, batchId: OTHER_BATCH, runId: 'r-2' }])
  const good = await link()
  assert.equal(good.status, 200)
  assert.deepEqual(good.body.hosts, ['host-a'])
  assert.equal((await link()).status, 200)
  assert.equal((await link(OTHER_BATCH)).status, 400)
  const second = { ...made.body, id: 'dec-1787000000001-abcdef34' }
  appendLine(f.auditFile, second)
  assert.equal((await f.call('/api/agos/routes/shadow/link', { ref: second.id, batchId: BATCH })).status, 400)
  assert.equal(readLedgerLines(f.auditFile).filter((row) => row.ev === 'shadow-link').length, 1)
})

test('GET never backfills a legacy shadow link that lacks task evidence', async (t) => {
  const shadow = { ...decision(), mode: 'shadow', pick: 'host-a' }
  const f = await fixture(t, [shadow, { ev: 'shadow-link', ref: DEC, batchId: BATCH, hosts: ['host-a'] }])
  await writeFile(f.runsFile, [
    { ev: 'dispatch', batchId: BATCH, runId: 'r-1', host: 'host-a', index: 1, at: 2, taskFingerprint: taskFingerprint('task') },
    { ev: 'end', batchId: BATCH, runId: 'r-1', ok: true, at: 3 },
  ].map((row) => JSON.stringify(row)).join('\n') + '\n')
  const listed = await f.call('/api/agos/routes', undefined, 'GET')
  assert.equal(listed.body.decisions[0].outcome, null)
  assert.equal(readLedgerLines(f.auditFile).some((row) => row.kind === 'outcome'), false)
})

test('shadow HTTP binds actual FleetLedger full-task hashes after preview clipping', async (t) => {
  const f = await fixture(t)
  const task = ` ${'work item '.repeat(90)} final tail `
  const made = await f.call('/api/agos/routes/shadow', {
    items: [task], hosts: [{ name: 'host-a', kind: 'remote', enabled: true }],
  })
  const fleet = new FleetLedger({ path: f.runsFile, autoCompact: false })
  const persisted = await fleet.append({ ev: 'dispatch', batchId: BATCH, runId: 'r-1', index: 1,
    host: 'host-a', prompt: task, at: made.body.ts + 1, taskFingerprint: taskFingerprint('forged') })
  assert.equal(persisted.prompt.length, 400)
  assert.equal(persisted.promptTruncated, true)
  assert.equal(persisted.taskFingerprint, taskFingerprint(task))
  const linked = await f.call('/api/agos/routes/shadow/link', { ref: made.body.id, batchId: BATCH, hosts: ['fake'] })
  assert.equal(linked.status, 200)
  assert.deepEqual(linked.body.hosts, ['host-a'])
})
