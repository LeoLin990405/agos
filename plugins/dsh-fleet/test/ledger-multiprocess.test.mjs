import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createFleetLedger, createFleetLock } from '../lib/fleet-ledger.mjs'

const self = fileURLToPath(import.meta.url)
const workerMode = process.argv[2] === '--fleet-test-worker' ? process.argv[3] : null

function expectedIds(id, count) {
  return Array.from({ length: count }, (_, index) => ({
    runId: `${id}-run-${index}`,
    ref: `${id}-ref-${index}`,
  }))
}

function assertEveryDispatchPresent(events, workers) {
  const refs = new Set(events.map((event) => event.ref))
  const runs = new Set(events.map((event) => event.runId))
  const dispatches = events.filter((event) => event.ev === 'dispatch')
  const missing = []
  for (const worker of workers) {
    for (const item of expectedIds(worker.id, worker.count)) {
      if (!refs.has(item.ref)) missing.push(item.ref)
      if (!runs.has(item.runId)) missing.push(item.runId)
    }
  }
  assert.equal(missing.join(','), '', `silent loss: ${missing.join(',')}`)
  const expected = workers.reduce((sum, worker) => sum + worker.count, 0)
  assert.equal(dispatches.length, expected)
  assert.equal(new Set(dispatches.map((event) => event.ref)).size, expected)
}

function spawnWorker(env) {
  const child = spawn(process.execPath, [self, '--fleet-test-worker', env.FLEET_WORKER_MODE], {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdoutBuf = ''
  child.stderrBuf = ''
  child.stdout.on('data', (chunk) => { child.stdoutBuf += chunk })
  child.stderr.on('data', (chunk) => { child.stderrBuf += chunk })
  return child
}

function waitExit(child, timeoutMs = 20_000) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve({ code: child.exitCode, signal: child.signalCode })
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`worker timeout stdout=${child.stdoutBuf} stderr=${child.stderrBuf}`))
    }, timeoutMs)
    child.once('exit', (code, signal) => {
      clearTimeout(timer)
      resolve({ code, signal })
    })
    child.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
  })
}

function waitForOutput(child, pattern, timeoutMs = 8_000) {
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

async function runWorker(mode) {
  const path = process.env.FLEET_LEDGER_PATH
  if (!path || !path.startsWith(tmpdir() + '/')) throw new Error('worker requires a temporary FLEET_LEDGER_PATH')
  const id = process.env.FLEET_WORKER_ID || 'W'
  const count = Number(process.env.FLEET_WORKER_COUNT || 20)
  const batchSize = Number(process.env.FLEET_BATCH_SIZE || 5)
  const lockTimeoutMs = Number(process.env.FLEET_LOCK_TIMEOUT_MS || 15_000)

  if (mode === 'hold' || mode === 'exit-without-release') {
    const lock = createFleetLock({ path: `${path}.lock`, timeoutMs: lockTimeoutMs })
    const held = await lock.acquire()
    process.stdout.write(`LOCKED ${held.owner.token}\n`)
    if (mode === 'exit-without-release') process.exit(2)
    // Keep the event loop alive without an unsettled top-level await
    // (Node 22+ exits that with code 13, which looks like a crash).
    setInterval(() => {}, 60_000)
    return
  }

  const ledger = createFleetLedger({ path, autoCompact: false, lockTimeoutMs })
  const record = (index, batchId) => ({
    ev: 'dispatch',
    runId: `${id}-run-${index}`,
    ref: `${id}-ref-${index}`,
    batchId,
    prompt: `${id}-${index}`,
  })

  if (mode === 'append') {
    for (let index = 0; index < count; index++) await ledger.append(record(index, `${id}-one`))
  } else if (mode === 'appendMany') {
    for (let index = 0; index < count; index += batchSize) {
      const chunk = []
      for (let inner = index; inner < Math.min(count, index + batchSize); inner++) {
        chunk.push(record(inner, `${id}-many-${index}`))
      }
      await ledger.appendMany(chunk)
    }
  } else if (mode === 'interleave') {
    for (let index = 0; index < count; index++) {
      if (index % 3 === 0) {
        const chunk = [record(index, `${id}-mix-${index}`)]
        if (index + 1 < count) chunk.push(record(index + 1, `${id}-mix-${index}`))
        await ledger.appendMany(chunk)
        index += chunk.length - 1
      } else {
        await ledger.append(record(index, `${id}-mix`))
      }
    }
  } else {
    throw new Error(`unknown worker mode ${mode}`)
  }
  await ledger.close()
}

if (workerMode) {
  await runWorker(workerMode)
} else {
  test('a live owner started in a different timezone cannot have its lock stolen', async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'fleet-lock-timezone-'))
    const path = join(directory, 'runs.jsonl')
    const owner = spawnWorker({ FLEET_WORKER_MODE: 'hold', FLEET_LEDGER_PATH: path, TZ: 'Pacific/Honolulu', LC_ALL: 'C' })
    t.after(async () => {
      if (owner.exitCode === null && owner.signalCode === null) owner.kill('SIGKILL')
      await waitExit(owner)
      await rm(directory, { recursive: true, force: true })
    })
    await waitForOutput(owner, /LOCKED /)
    const before = await readFile(path + '.lock', 'utf8')
    const waiter = createFleetLock({ path: path + '.lock', timeoutMs: 150, retryMs: 10 })
    await assert.rejects(waiter.acquire(), { code: 'FLEET_LOCK_TIMEOUT' })
    assert.equal(await readFile(path + '.lock', 'utf8'), before)
    assert.equal(owner.exitCode, null)
  })

  test('two Node processes keep every dispatch/run/ref on one ledger', async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'fleet-mp-append-'))
    t.after(() => rm(directory, { recursive: true, force: true }))
    const path = join(directory, 'runs.jsonl')
    const workers = [
      { id: 'A', count: 24, mode: 'append' },
      { id: 'B', count: 24, mode: 'append' },
    ]
    const children = workers.map((worker) => spawnWorker({
      FLEET_WORKER_MODE: worker.mode,
      FLEET_LEDGER_PATH: path,
      FLEET_WORKER_ID: worker.id,
      FLEET_WORKER_COUNT: String(worker.count),
    }))
    const exits = await Promise.all(children.map((child) => waitExit(child)))
    for (const [index, exit] of exits.entries()) {
      assert.equal(exit.code, 0, `worker ${workers[index].id} code=${exit.code} ${children[index].stderrBuf}`)
    }
    const ledger = createFleetLedger({ path, autoCompact: false })
    assertEveryDispatchPresent(await ledger.load(), workers)
    await ledger.close()
  })

  test('appendMany from one process interleaves with append from another without loss', async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'fleet-mp-many-'))
    t.after(() => rm(directory, { recursive: true, force: true }))
    const path = join(directory, 'runs.jsonl')
    const workers = [
      { id: 'M', count: 30, mode: 'appendMany' },
      { id: 'S', count: 25, mode: 'append' },
    ]
    const children = workers.map((worker) => spawnWorker({
      FLEET_WORKER_MODE: worker.mode,
      FLEET_LEDGER_PATH: path,
      FLEET_WORKER_ID: worker.id,
      FLEET_WORKER_COUNT: String(worker.count),
      FLEET_BATCH_SIZE: '5',
    }))
    const exits = await Promise.all(children.map((child) => waitExit(child)))
    for (const [index, exit] of exits.entries()) {
      assert.equal(exit.code, 0, `worker ${workers[index].id} code=${exit.code} ${children[index].stderrBuf}`)
    }
    const ledger = createFleetLedger({ path, autoCompact: false })
    assertEveryDispatchPresent(await ledger.load(), workers)
    await ledger.close()
  })

  test('two processes interleave appendMany with other writes and keep every ref', async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'fleet-mp-mix-'))
    t.after(() => rm(directory, { recursive: true, force: true }))
    const path = join(directory, 'runs.jsonl')
    const workers = [
      { id: 'X', count: 21, mode: 'interleave' },
      { id: 'Y', count: 21, mode: 'interleave' },
    ]
    const children = workers.map((worker) => spawnWorker({
      FLEET_WORKER_MODE: worker.mode,
      FLEET_LEDGER_PATH: path,
      FLEET_WORKER_ID: worker.id,
      FLEET_WORKER_COUNT: String(worker.count),
    }))
    const exits = await Promise.all(children.map((child) => waitExit(child)))
    for (const [index, exit] of exits.entries()) {
      assert.equal(exit.code, 0, `worker ${workers[index].id} code=${exit.code} ${children[index].stderrBuf}`)
    }
    const ledger = createFleetLedger({ path, autoCompact: false })
    assertEveryDispatchPresent(await ledger.load(), workers)
    await ledger.close()
  })

  test('interrupt of a lock holder recovers; a live holder is not stolen', async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'fleet-mp-recover-'))
    t.after(() => rm(directory, { recursive: true, force: true }))
    const path = join(directory, 'runs.jsonl')
    const lockPath = `${path}.lock`

    const live = spawnWorker({
      FLEET_WORKER_MODE: 'hold',
      FLEET_LEDGER_PATH: path,
    })
    t.after(() => { try { live.kill('SIGKILL') } catch {} })
    await waitForOutput(live, /LOCKED /)
    assert.equal(live.exitCode, null, `holder exited early: ${live.stderrBuf}`)
    const before = await readFile(lockPath, 'utf8')
    const thief = createFleetLock({ path: lockPath, timeoutMs: 200, retryMs: 20 })
    await assert.rejects(() => thief.acquire(), (error) => error.code === 'FLEET_LOCK_TIMEOUT')
    assert.equal(await readFile(lockPath, 'utf8'), before)

    live.kill('SIGKILL')
    const killed = await waitExit(live, 5_000)
    assert.equal(killed.signal, 'SIGKILL')

    const survivor = spawnWorker({
      FLEET_WORKER_MODE: 'append',
      FLEET_LEDGER_PATH: path,
      FLEET_WORKER_ID: 'R',
      FLEET_WORKER_COUNT: '6',
    })
    const recovered = await waitExit(survivor)
    assert.equal(recovered.code, 0, survivor.stderrBuf)

    const abandoned = spawnWorker({
      FLEET_WORKER_MODE: 'exit-without-release',
      FLEET_LEDGER_PATH: path,
    })
    await waitForOutput(abandoned, /LOCKED /)
    const crash = await waitExit(abandoned)
    assert.equal(crash.code, 2)

    const afterCrash = spawnWorker({
      FLEET_WORKER_MODE: 'appendMany',
      FLEET_LEDGER_PATH: path,
      FLEET_WORKER_ID: 'C',
      FLEET_WORKER_COUNT: '6',
      FLEET_BATCH_SIZE: '3',
    })
    const afterCrashExit = await waitExit(afterCrash)
    assert.equal(afterCrashExit.code, 0, afterCrash.stderrBuf)

    const ledger = createFleetLedger({ path, autoCompact: false })
    assertEveryDispatchPresent(await ledger.load(), [
      { id: 'R', count: 6 },
      { id: 'C', count: 6 },
    ])
    await ledger.close()
  })
}
