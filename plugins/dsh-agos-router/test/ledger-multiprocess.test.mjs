// C1 — real cross-process behaviour of route-outcome.jsonl.
//
// Everything here spawns actual `node` child processes against a real file in a
// real temp dir and, where stated, actually SIGKILLs them. Nothing in this file
// simulates concurrency in-process: an in-process test cannot observe the two
// failures that matter (two open file descriptors interleaving inside one line,
// and a lock owner that dies without ever running a finally block).
//
// Modelled on plugins/dsh-fleet/test/ledger-multiprocess.test.mjs.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { appendFileSync, readFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { appendLine, scanLedger, readLedgerLines, foldLedger } from '../lib/ledger.js'
import { acquireLedgerLock, lockPathFor, withLedgerLock } from '../lib/ledger-lock.js'
import { allocationStateFromLedger } from '../lib/assemble.js'
import { bindOrdinaryOutcome } from '../lib/feedback-bind.mjs'

const self = fileURLToPath(import.meta.url)
const workerMode = process.argv[2] === '--agos-ledger-worker' ? process.argv[3] : null

function spawnWorker(env) {
  const child = spawn(process.execPath, [self, '--agos-ledger-worker', env.AGOS_WORKER_MODE], {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdoutBuf = ''
  child.stderrBuf = ''
  child.stdout.on('data', (chunk) => { child.stdoutBuf += chunk })
  child.stderr.on('data', (chunk) => { child.stderrBuf += chunk })
  return child
}

function waitExit(child, timeoutMs = 30_000) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode })
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`worker timeout stdout=${child.stdoutBuf} stderr=${child.stderrBuf}`))
    }, timeoutMs)
    child.once('exit', (code, signal) => { clearTimeout(timer); resolve({ code, signal }) })
    child.once('error', (error) => { clearTimeout(timer); reject(error) })
  })
}

function waitForOutput(child, pattern, timeoutMs = 15_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`timeout waiting ${pattern}: stdout=${child.stdoutBuf} stderr=${child.stderrBuf}`))
    }, timeoutMs)
    const check = () => {
      if (pattern.test(child.stdoutBuf)) {
        clearTimeout(timer)
        child.stdout.off('data', onData)
        resolve(child.stdoutBuf)
      }
    }
    const onData = () => check()
    child.stdout.on('data', onData)
    child.once('exit', (code, signal) => {
      if (!pattern.test(child.stdoutBuf)) {
        clearTimeout(timer)
        reject(new Error(`exited code=${code} signal=${signal} before ${pattern}: ${child.stdoutBuf} ${child.stderrBuf}`))
      }
    })
    check()
  })
}

/** Big enough that one record spans many pages, maximising any interleaving window. */
const FILLER_BYTES = 256 * 1024

const decisionRecord = (id, index) => ({
  id: `dec-1788000000000-${id}${String(index).padStart(4, '0')}`,
  ts: 1788000000000 + index,
  taskType: 'coding',
  role: 'implementer',
  label: 'coding',
  pick: 'qwen3.8-max',
  candidates: ['qwen3.8-max', 'glm-5.2'],
  source: 'selector',
  filler: String(id).repeat(FILLER_BYTES),
  outcome: null,
})

function sleepSync(ms) {
  if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/** Release every worker at the same wall-clock instant so they collide for real. */
function waitForBarrier() {
  const startAt = Number(process.env.AGOS_START_AT || 0)
  if (!Number.isFinite(startAt) || startAt <= 0) return
  const remaining = startAt - Date.now()
  if (remaining > 0) sleepSync(remaining)
}

// ─────────────────────────── worker side ───────────────────────────
async function runWorker(mode) {
  const path = process.env.AGOS_LEDGER_PATH
  if (!path || !path.startsWith(tmpdir())) throw new Error('worker requires a temporary AGOS_LEDGER_PATH')
  const id = process.env.AGOS_WORKER_ID || 'W'
  const count = Number(process.env.AGOS_WORKER_COUNT || 20)

  if (mode === 'hold' || mode === 'exit-without-release') {
    const held = acquireLedgerLock(lockPathFor(path), { timeoutMs: 20_000 })
    process.stdout.write(`LOCKED ${held.path}\n`)
    if (mode === 'exit-without-release') process.exit(2)
    setInterval(() => {}, 60_000)
    return
  }

  if (mode === 'crash-midwrite') {
    // Hold the lock, publish a deliberately incomplete line, then die hard. This is
    // what a `kill -9` during appendLine leaves behind: a torn tail plus an
    // abandoned lock whose owner will never run a release path.
    acquireLedgerLock(lockPathFor(path), { timeoutMs: 20_000 })
    appendFileSync(path, '{"id":"dec-1788000000000-torn0001","kind":"decision","nested":{"a":1}', 'utf8')
    process.stdout.write('WROTE-PARTIAL\n')
    process.kill(process.pid, 'SIGKILL')
    setInterval(() => {}, 60_000)
    return
  }

  if (mode === 'append') {
    waitForBarrier()
    for (let index = 0; index < count; index++) appendLine(path, decisionRecord(id, index))
    process.stdout.write(`DONE ${count}\n`)
    return
  }

  if (mode === 'outcome-race') {
    // Read-modify-write: read the ledger, decide whether an outcome already exists,
    // append only if not. The delay stands in for the real cost of the decide step
    // (readLedgerLines + foldLedger over a grown ledger is milliseconds, not
    // microseconds). A transaction has to hold across that window; without one,
    // every racer reads "no prior outcome" and books its own.
    const ref = process.env.AGOS_TARGET_REF
    const think = Number(process.env.AGOS_RMW_THINK_MS || 0)
    waitForBarrier()
    for (let index = 0; index < count; index++) {
      withLedgerLock(path, () => {
        const bound = bindOrdinaryOutcome({
          authority: 'operator',
          body: { ref, result: 'ok' },
          rows: readLedgerLines(path),
        })
        sleepSync(think)
        if (bound.ok && !bound.idempotent) appendLine(path, bound.record)
      })
    }
    process.stdout.write('DONE\n')
    return
  }

  throw new Error(`unknown worker mode ${mode}`)
}

// ─────────────────────────── assertions ───────────────────────────

/** Every stored line is exactly one whole record: no interleaving, no swallowed record. */
function assertNoTornOrInterleavedLines(path, expectedRejects = 0) {
  const text = readFileSync(path, 'utf8')
  const lines = text.split('\n').filter((line) => line.trim())
  const { rows, rejected } = scanLedger(path)
  assert.equal(rejected, expectedRejects, `unexpected unparseable lines (${rejected})`)
  assert.equal(rows.length + rejected, lines.length, 'a line held something other than one record')
  for (const line of lines) {
    // Two records sharing a line is the classic interleaving signature.
    assert.equal(line.indexOf('}{'), -1, `interleaved line: ${line.slice(0, 120)}`)
    assert.ok(!line.includes('\u0000'), 'NUL byte in ledger line')
  }
  assert.ok(text.endsWith('\n'), 'ledger must end on a record boundary')
  return rows
}

if (workerMode) {
  await runWorker(workerMode)
} else {
  test('two Node processes appending concurrently lose no acknowledged record and tear no line', async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'agos-mp-append-'))
    t.after(() => rm(directory, { recursive: true, force: true }))
    const path = join(directory, 'route-outcome.jsonl')
    const workers = [{ id: 'a', count: 12 }, { id: 'b', count: 12 }, { id: 'c', count: 12 }, { id: 'd', count: 12 }]
    const startAt = Date.now() + 1200

    const children = workers.map((worker) => spawnWorker({
      AGOS_WORKER_MODE: 'append',
      AGOS_LEDGER_PATH: path,
      AGOS_LEDGER_PATH_UNUSED: '',
      AGOS_START_AT: String(startAt),
      AGOS_WORKER_ID: worker.id,
      AGOS_WORKER_COUNT: String(worker.count),
    }))
    const exits = await Promise.all(children.map((child) => waitExit(child)))
    exits.forEach((exit, index) => {
      assert.equal(exit.code, 0, `worker ${workers[index].id} code=${exit.code} ${children[index].stderrBuf}`)
    })

    const rows = assertNoTornOrInterleavedLines(path)
    const ids = new Set(rows.map((row) => row.id))
    const missing = []
    for (const worker of workers) {
      for (let index = 0; index < worker.count; index++) {
        const expected = decisionRecord(worker.id, index).id
        if (!ids.has(expected)) missing.push(expected)
      }
    }
    const total = workers.reduce((sum, worker) => sum + worker.count, 0)
    assert.equal(missing.join(','), '', 'silent loss')
    assert.equal(rows.length, total)
    assert.equal(ids.size, total, 'duplicate ids: a record was written twice')
    // Payloads survived whole, not just their first bytes, and no record picked up
    // another writer's filler (each worker uses its own repeated character).
    for (const row of rows) {
      assert.equal(row.filler.length, FILLER_BYTES, `truncated payload in ${row.id}`)
      assert.equal(new Set(row.filler).size, 1, `payload of ${row.id} mixes two writers`)
      assert.equal(row.pick, 'qwen3.8-max')
    }
  })

  test('concurrent read-modify-write across processes books one outcome, and the posterior counts it once', async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'agos-mp-rmw-'))
    t.after(() => rm(directory, { recursive: true, force: true }))
    const path = join(directory, 'route-outcome.jsonl')
    const ref = 'dec-1788000000000-abcdef0123456789abcdef0123456789'
    await writeFile(path, JSON.stringify({
      id: ref, ts: 1788000000000, taskType: 'coding', role: 'implementer', label: 'coding',
      pick: 'qwen3.8-max', candidates: ['qwen3.8-max', 'glm-5.2'], source: 'selector', outcome: null,
    }) + '\n')

    const startAt = Date.now() + 1200
    const children = ['p', 'q', 'r', 's'].map((id) => spawnWorker({
      AGOS_WORKER_MODE: 'outcome-race',
      AGOS_LEDGER_PATH: path,
      AGOS_WORKER_ID: id,
      AGOS_WORKER_COUNT: '4',
      AGOS_TARGET_REF: ref,
      AGOS_START_AT: String(startAt),
      AGOS_RMW_THINK_MS: '25',
    }))
    const exits = await Promise.all(children.map((child) => waitExit(child)))
    exits.forEach((exit, index) => assert.equal(exit.code, 0, children[index].stderrBuf))

    const rows = assertNoTornOrInterleavedLines(path)
    const outcomes = rows.filter((row) => row.kind === 'outcome' && row.ref === ref)
    // 16 racing check-then-append attempts, one booking. Without a transaction that
    // spans read→decide→append, each process reads "no prior outcome" and books one.
    assert.equal(outcomes.length, 1, `expected one outcome row, saw ${outcomes.length}`)
    const state = allocationStateFromLedger(rows)
    assert.deepEqual(state, [{ taskType: 'coding', agent: 'qwen3.8-max', s: 1, f: 0 }])
  })

  test('a writer SIGKILLed mid-write leaves a fragment that never parses, and loses nothing already acknowledged', async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'agos-mp-crash-'))
    t.after(() => rm(directory, { recursive: true, force: true }))
    const path = join(directory, 'route-outcome.jsonl')

    const before = decisionRecord('s', 1)
    appendLine(path, before)

    const crasher = spawnWorker({ AGOS_WORKER_MODE: 'crash-midwrite', AGOS_LEDGER_PATH: path })
    await waitForOutput(crasher, /WROTE-PARTIAL/)
    const died = await waitExit(crasher, 10_000)
    assert.equal(died.signal, 'SIGKILL', 'the writer must really have been killed, not have exited')

    // The fragment is a proper prefix of a JSON object — including one that ends on a
    // nested closing brace — so it cannot parse, and is never mistaken for a record.
    const torn = scanLedger(path)
    assert.equal(torn.rejected, 1)
    assert.equal(torn.rows.length, 1)
    assert.equal(torn.rows[0].id, before.id)
    assert.ok(!torn.rows.some((row) => String(row.id ?? '').includes('torn')))

    // A new process takes over the abandoned lock and appends. The fragment must not
    // swallow the new record, and the pre-crash record must still be there.
    const survivor = spawnWorker({
      AGOS_WORKER_MODE: 'append', AGOS_LEDGER_PATH: path, AGOS_WORKER_ID: 'z', AGOS_WORKER_COUNT: '5',
    })
    const recovered = await waitExit(survivor)
    assert.equal(recovered.code, 0, survivor.stderrBuf)

    const rows = assertNoTornOrInterleavedLines(path, 1)
    assert.ok(rows.some((row) => row.id === before.id), 'pre-crash record lost')
    for (let index = 0; index < 5; index++) {
      const expected = decisionRecord('z', index).id
      assert.ok(rows.some((row) => row.id === expected), `post-crash record ${expected} lost`)
    }
    assert.equal(rows.length, 6)
    assert.ok(rows.every((row) => row.filler.length === FILLER_BYTES), 'a record was merged into the fragment')
  })

  test('a live lock owner is never stolen; only a dead one is reclaimed, and not from a new owner', async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'agos-mp-lock-'))
    t.after(() => rm(directory, { recursive: true, force: true }))
    const path = join(directory, 'route-outcome.jsonl')
    const lockPath = lockPathFor(path)

    const live = spawnWorker({ AGOS_WORKER_MODE: 'hold', AGOS_LEDGER_PATH: path })
    t.after(() => { try { live.kill('SIGKILL') } catch {} })
    await waitForOutput(live, /LOCKED /)
    assert.equal(live.exitCode, null, `holder exited early: ${live.stderrBuf}`)

    // A second process must block, then give up — never take the lock from a living owner.
    const owner = readFileSync(lockPath, 'utf8')
    assert.throws(
      () => withLedgerLock(path, () => { throw new Error('unreachable: stole a live lock') }, { timeoutMs: 300, retryMs: 20 }),
      (error) => error.code === 'AGOS_LEDGER_LOCK_TIMEOUT',
    )
    assert.equal(readFileSync(lockPath, 'utf8'), owner, 'live owner record was modified')
    assert.equal(live.exitCode, null)

    live.kill('SIGKILL')
    assert.equal((await waitExit(live, 10_000)).signal, 'SIGKILL')

    // Dead owner: reclaimed, and the write goes through.
    appendLine(path, decisionRecord('k', 1))
    assert.equal(readLedgerLines(path).length, 1)

    // An owner that exits without releasing leaves the same abandoned lock. The next
    // writer reclaims it under the recovery protocol rather than blocking forever.
    const abandoned = spawnWorker({ AGOS_WORKER_MODE: 'exit-without-release', AGOS_LEDGER_PATH: path })
    await waitForOutput(abandoned, /LOCKED /)
    assert.equal((await waitExit(abandoned)).code, 2)

    const after = spawnWorker({
      AGOS_WORKER_MODE: 'append', AGOS_LEDGER_PATH: path, AGOS_WORKER_ID: 'm', AGOS_WORKER_COUNT: '4',
    })
    assert.equal((await waitExit(after)).code, 0, after.stderrBuf)
    assert.equal(assertNoTornOrInterleavedLines(path).length, 5)
  })

  test('a stale reaper cannot unlink the lock of the new owner that replaced it', async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'agos-mp-reap-'))
    t.after(() => rm(directory, { recursive: true, force: true }))
    const path = join(directory, 'route-outcome.jsonl')
    const lockPath = lockPathFor(path)

    // A dead owner's record, left behind by a process that no longer exists.
    const dead = spawnWorker({ AGOS_WORKER_MODE: 'exit-without-release', AGOS_LEDGER_PATH: path })
    await waitForOutput(dead, /LOCKED /)
    assert.equal((await waitExit(dead)).code, 2)
    const abandonedOwner = JSON.parse(readFileSync(lockPath, 'utf8'))

    // This process reclaims it and becomes the live owner.
    const held = acquireLedgerLock(lockPath, { timeoutMs: 5_000 })
    const liveOwner = JSON.parse(readFileSync(lockPath, 'utf8'))
    assert.notEqual(liveOwner.token, abandonedOwner.token)
    assert.equal(liveOwner.pid, process.pid)

    // A late reaper still holding the dead generation's snapshot arrives now. Its
    // token no longer matches, so it must leave the live owner's lock alone.
    const child = spawnWorker({
      AGOS_WORKER_MODE: 'append', AGOS_LEDGER_PATH: path, AGOS_WORKER_ID: 'n', AGOS_WORKER_COUNT: '2',
    })
    await new Promise((resolve) => setTimeout(resolve, 400))
    assert.equal(child.exitCode, null, 'a live owner was stolen from')
    assert.equal(JSON.parse(readFileSync(lockPath, 'utf8')).token, liveOwner.token)

    // Release, and the waiter proceeds normally.
    const { releaseLedgerLock } = await import('../lib/ledger-lock.js')
    releaseLedgerLock(held)
    assert.equal((await waitExit(child)).code, 0, child.stderrBuf)
    assert.equal(assertNoTornOrInterleavedLines(path).length, 2)
    assert.equal(foldLedger(readLedgerLines(path)).decisions.length, 2)
  })
}
