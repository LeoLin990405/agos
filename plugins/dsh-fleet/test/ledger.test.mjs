import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, stat, writeFile, rm } from 'node:fs/promises'
import * as realFs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  createFleetLedger,
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
