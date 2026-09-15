import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, stat, writeFile, rm } from 'node:fs/promises'
import * as realFs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  createFleetLedger,
  createFleetLock,
  FleetLockError,
  lockPathFor,
  scrubSecrets,
  selectCompactedEvents,
} from '../lib/fleet-ledger.mjs'

const DAY = 24 * 60 * 60 * 1000

test('scrubSecrets redacts supported credentials recursively without hiding an env path', () => {
  const value = scrubSecrets({
    prompt: 'use sk-abcdefghijklmnopQRST then Bearer opaque-token-value',
    nested: ['API_KEY=very-secret', 'SESSION_TOKEN="quoted-secret"', 'see ~/.config/cc-model-secrets.env'],
  })
  assert.equal(value.prompt, 'use «redacted» then Bearer «redacted»')
  assert.deepEqual(value.nested, [
    'API_KEY=«redacted»',
    'SESSION_TOKEN=«redacted»',
    'see ~/.config/cc-model-secrets.env',
  ])
})

test('ledger appends through a durable single-writer chain and dispatch is on disk before spawn', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'fleet-ledger-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const path = join(directory, 'nested', 'runs.jsonl')
  let clock = 1000
  const ledger = createFleetLedger({ path, now: () => ++clock, autoCompact: false })

  const seen = await ledger.appendDispatchBeforeSpawn({
    batchId: 'b1', runId: 'r1', index: 1, host: 'worker', runDir: '~/tasks/r1',
    prompt: `Bearer a-secret ${'x'.repeat(450)}`,
  }, async (event) => {
    const onDisk = await readFile(path, 'utf8')
    assert.match(onDisk, /"ev":"dispatch"/)
    assert.doesNotMatch(onDisk, /a-secret/)
    return event.runId
  })
  assert.equal(seen, 'r1')

  await Promise.all(Array.from({ length: 20 }, (_, index) => ledger.append({ ev: 'start', runId: `q${index}`, order: index })))
  const events = await ledger.load()
  assert.deepEqual(events.slice(1).map((event) => event.order), Array.from({ length: 20 }, (_, index) => index))
  assert.equal(events[0].prompt.length, 400)
  assert.equal(events[0].promptTruncated, true)
  assert.equal((await stat(path)).mode & 0o777, 0o600)
  await ledger.close()
})

test('compaction keeps the wider recent-or-tail union plus every event in an unfinished run chain', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'fleet-compact-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const path = join(directory, 'runs.jsonl')
  const now = 30 * DAY
  const old = now - 20 * DAY
  const recent = now - DAY
  const input = [
    { v: 1, at: old, ev: 'dispatch', runId: 'active', batchId: 'ba', prompt: 'a' },
    { v: 1, at: old + 1, ev: 'start', runId: 'active' },
    { v: 1, at: old + 2, ev: 'dispatch', runId: 'settled-old', batchId: 'bo', prompt: 'o' },
    { v: 1, at: old + 3, ev: 'end', runId: 'settled-old', ok: true },
    { v: 1, at: recent, ev: 'dispatch', runId: 'recent', batchId: 'br', prompt: 'r' },
    { v: 1, at: recent + 1, ev: 'end', runId: 'recent', ok: true },
  ]
  await writeFile(path, input.map(JSON.stringify).join('\n') + '\n', { mode: 0o644 })
  assert.deepEqual(
    selectCompactedEvents(input, { now, retentionMs: 14 * DAY, minEvents: 2 }).map((event) => event.runId),
    ['active', 'active', 'recent', 'recent'],
  )

  const ledger = createFleetLedger({ path, now: () => now, retentionMs: 14 * DAY, minEvents: 2 })
  await ledger.ready
  assert.deepEqual((await ledger.load()).map((event) => event.runId), ['active', 'active', 'recent', 'recent'])
  assert.equal((await stat(path)).mode & 0o777, 0o600)
  assert.equal((await readdir(directory)).some((name) => name.endsWith('.tmp')), false)
})

test('cancel and terminal reattach events make old chains eligible for removal', () => {
  const events = [
    { at: 1, ev: 'dispatch', runId: 'cancelled' },
    { at: 2, ev: 'cancel', runId: 'cancelled' },
    { at: 3, ev: 'dispatch', runId: 'lost' },
    { at: 4, ev: 'reattach', runId: 'lost', state: 'lost' },
    { at: 5, ev: 'dispatch', runId: 'detached' },
    { at: 6, ev: 'detach', runId: 'detached' },
  ]
  assert.deepEqual(
    selectCompactedEvents(events, { now: 1000, retentionMs: 0, minEvents: 0 }).map((event) => event.runId),
    ['detached', 'detached'],
  )
})

test('appendMany publishes all dispatches or leaves the previous ledger intact', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'fleet-batch-ledger-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const path = join(directory, 'runs.jsonl')
  let rejectPublication = false
  const fs = {
    ...realFs,
    rename: async (source, target) => {
      if (rejectPublication && source.includes('.runs-append.')) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' })
      return realFs.rename(source, target)
    },
  }
  const ledger = createFleetLedger({ path, fs, autoCompact: false, now: () => 10 })
  await ledger.append({ ev: 'dispatch', batchId: 'old', runId: 'old', prompt: 'old' })
  const before = await readFile(path, 'utf8')
  rejectPublication = true
  await assert.rejects(ledger.appendMany([
    { ev: 'dispatch', batchId: 'new', runId: 'r1', prompt: 'one' },
    { ev: 'dispatch', batchId: 'new', runId: 'r2', prompt: 'two' },
  ]), /disk full/)
  assert.equal(await readFile(path, 'utf8'), before)
  assert.equal((await readdir(directory)).some((name) => name.startsWith('.runs-append.')), false)
})

test('exclusive lockfile recovers a dead owner and refuses to steal a live one', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'fleet-lock-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const path = lockPathFor(join(directory, 'runs.jsonl'))

  const stale = createFleetLock({
    path,
    timeoutMs: 500,
    pid: 1,
    startTime: 'old-start',
    isAlive: () => false,
    readStartTime: () => null,
  })
  const held = await stale.acquire()
  await stale.release(held)

  await writeFile(path, `${JSON.stringify({
    pid: 1, startTime: 'old-start', token: 'dead', acquiredAt: 1, timeoutMs: 500,
  })}\n`, { mode: 0o600 })
  const recovered = createFleetLock({
    path,
    timeoutMs: 1000,
    pid: process.pid,
    startTime: 'self',
    isAlive: (pid) => pid === process.pid,
    readStartTime: (pid) => (pid === process.pid ? 'self' : 'old-start'),
  })
  const next = await recovered.acquire()
  assert.equal(next.owner.pid, process.pid)
  await recovered.release(next)

  const live = createFleetLock({
    path,
    timeoutMs: 800,
    pid: 4242,
    startTime: 'live-start',
    isAlive: (pid) => pid === 4242,
    readStartTime: (pid) => (pid === 4242 ? 'live-start' : null),
  })
  const liveHeld = await live.acquire()
  const token = liveHeld.owner.token
  const thief = createFleetLock({
    path,
    timeoutMs: 120,
    retryMs: 15,
    pid: process.pid,
    startTime: 'thief',
    isAlive: (pid) => pid === 4242 || pid === process.pid,
    readStartTime: (pid) => (pid === 4242 ? 'live-start' : 'thief'),
  })
  await assert.rejects(() => thief.acquire(), (error) => {
    assert.ok(error instanceof FleetLockError)
    assert.equal(error.code, 'FLEET_LOCK_TIMEOUT')
    return true
  })
  assert.equal(JSON.parse(await readFile(path, 'utf8')).token, token)
  await live.release(liveHeld)

  await writeFile(path, `${JSON.stringify({
    pid: 7, startTime: 'reused-old', token: 'old', acquiredAt: 1, timeoutMs: 500, identityFormat: 'ps-lstart-utc-c-v1',
  })}\n`)
  const reuse = createFleetLock({
    path,
    timeoutMs: 500,
    isAlive: () => true,
    readStartTime: () => 'reused-new',
  })
  const reused = await reuse.acquire()
  assert.notEqual(reused.owner.token, 'old')
  await reuse.release(reused)
})

test('two in-process ledgers keep every dispatch/run/ref across appendMany plus append', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'fleet-two-ledger-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const path = join(directory, 'runs.jsonl')
  const left = createFleetLedger({ path, autoCompact: false, lockTimeoutMs: 5000 })
  const right = createFleetLedger({ path, autoCompact: false, lockTimeoutMs: 5000 })
  const leftInputs = Array.from({ length: 8 }, (_, index) => ({
    ev: 'dispatch', runId: `L-run-${index}`, ref: `L-ref-${index}`, batchId: 'L', prompt: `L${index}`,
  }))
  await Promise.all([
    left.appendMany(leftInputs),
    ...Array.from({ length: 8 }, (_, index) => right.append({
      ev: 'dispatch', runId: `R-run-${index}`, ref: `R-ref-${index}`, batchId: 'R', prompt: `R${index}`,
    })),
  ])
  const events = await left.load()
  const refs = new Set(events.map((event) => event.ref))
  const runs = new Set(events.map((event) => event.runId))
  for (let index = 0; index < 8; index++) {
    assert.ok(refs.has(`L-ref-${index}`), `missing L-ref-${index}`)
    assert.ok(refs.has(`R-ref-${index}`), `missing R-ref-${index}`)
    assert.ok(runs.has(`L-run-${index}`), `missing L-run-${index}`)
    assert.ok(runs.has(`R-run-${index}`), `missing R-run-${index}`)
  }
  await Promise.all([left.close(), right.close()])
})

test('dispatch fingerprint uses complete raw input and cannot be supplied for a preview', async (t) => {
  const { taskFingerprint } = await import('../../dsh-agos-router/lib/task-fingerprint.mjs')
  const directory = await mkdtemp(join(tmpdir(), 'fleet-fingerprint-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const ledger = createFleetLedger({ path: join(directory, 'runs.jsonl'), autoCompact: false })
  const prompt = '  ' + 'x'.repeat(450) + ' actual task tail  '
  const stored = await ledger.append({ ev: 'dispatch', runId: 'raw', prompt, taskFingerprint: 'forged' })
  assert.equal(stored.prompt.length, 400)
  assert.equal(stored.taskFingerprint, taskFingerprint(prompt))
  assert.notEqual(stored.taskFingerprint, taskFingerprint(stored.prompt))
  const [other] = await ledger.appendMany([{ ev: 'dispatch', runId: 'other', prompt: prompt + 'different' }])
  assert.notEqual(stored.taskFingerprint, other.taskFingerprint)
  const preview = await ledger.append({ ev: 'dispatch', runId: 'preview', prompt: stored.prompt, promptTruncated: true, taskFingerprint: stored.taskFingerprint })
  assert.equal(preview.taskFingerprint, null)
  await ledger.close()
})

test('stale reapers cannot remove a replacement live lock, including after reaper death', async (t) => {
  const fs = await import('node:fs/promises')
  const directory = await mkdtemp(join(tmpdir(), 'fleet-reaper-race-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const path = join(directory, 'runs.lock')
  const dead = { pid: 7, startTime: 'dead', token: 'dead-owner' }
  await writeFile(path, JSON.stringify(dead))
  await writeFile(path + '.recover-dead-owner', JSON.stringify({ ...dead, token: 'dead-reaper' }))
  let unblock, reached
  const waiting = new Promise((resolve) => { reached = resolve })
  const gate = new Promise((resolve) => { unblock = resolve })
  let deletes = 0
  const guardedFs = { ...fs, async unlink(candidate) {
    if (candidate === path && deletes++ === 0) { reached(); await gate }
    return fs.unlink(candidate)
  } }
  const options = { path, fs: guardedFs, timeoutMs: 3000, isAlive: (pid) => pid !== 7, readStartTime: () => null }
  const left = createFleetLock(options), right = createFleetLock(options)
  let active = 0, entries = 0
  const critical = async () => {
    assert.equal(active++, 0, 'two owners must never enter together')
    entries++
    await new Promise((resolve) => setTimeout(resolve, 30))
    active--
  }
  const first = left.withLock(critical)
  await waiting
  const second = right.withLock(critical)
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(deletes, 1, 'second stale reaper must wait before target unlink')
  unblock()
  await Promise.all([first, second])
  assert.equal(entries, 2)
  assert.deepEqual(await readdir(directory), [], 'owned lock and recovery files must be released')
})

test('a malformed lock and an unverifiable live start time fail closed', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'fleet-invalid-owner-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const path = join(directory, 'runs.lock')
  await writeFile(path, '')
  const options = { path, timeoutMs: 40, retryMs: 5, ownerWriteGraceMs: 0, isAlive: () => true, readStartTime: () => 'observed-start' }
  await assert.rejects(createFleetLock(options).acquire(), { code: 'FLEET_LOCK_TIMEOUT' })
  const owner = JSON.stringify({ pid: 7, token: 'live', startTime: 'pid:7' })
  await writeFile(path, owner)
  await assert.rejects(createFleetLock(options).acquire(), { code: 'FLEET_LOCK_TIMEOUT' })
  assert.equal(await readFile(path, 'utf8'), owner)
})
