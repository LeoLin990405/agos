import assert from 'node:assert/strict'
import { appendFile, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  INJECT_IS_NOT_VERDICT_COPY,
  MEMORY_FALLBACK_METHOD,
  MEMORY_FALLBACK_OVERLAP_COPY,
  MEMORY_FALLBACK_QUERY_COPY,
  MEMORY_LEXICAL_METHOD,
  SESSION_UNCOLLECTED_COPY,
  STORE_UNREAD_COPY,
  blendMemoryShortlist,
  createSessionMemoryRelevanceStore,
  describeSessionMemoryRelevance,
  describeUnreadSessionMemory,
  memoryLexicalScore,
  proposeSessionMemory,
  rankByImportance,
  shortlistMemoryItems,
} from '../lib/session-memory-rank.js'

const fold = {
  id: 'aaaaaaaaaaaaaaaaaaaaaaaa',
  kind: 'constraint',
  text: '不要改 fold',
  importance: 5,
  createdAt: '2026-09-07T00:00:00.000Z',
}
const port = {
  id: 'bbbbbbbbbbbbbbbbbbbbbbbb',
  kind: 'fact',
  text: 'web 口在 3091',
  importance: 3,
  createdAt: '2026-09-07T01:00:00.000Z',
}
const pref = {
  id: 'cccccccccccccccccccccccc',
  kind: 'preference',
  text: '用中文写记忆',
  importance: 4,
  createdAt: '2026-09-07T02:00:00.000Z',
}

test('empty query does not invent a lexical shortlist', () => {
  assert.deepEqual(shortlistMemoryItems([fold, port], ''), [])
  const report = proposeSessionMemory([fold, port, pref], '', [])
  assert.equal(report.queryCollected, false)
  assert.equal(report.fallback, 'empty-query')
  assert.equal(report.method, MEMORY_FALLBACK_METHOD)
  assert.match(report.copy, new RegExp(MEMORY_FALLBACK_QUERY_COPY))
  assert.equal(report.hits[0]?.id, fold.id)
  assert.equal(report.hits[0]?.posterior, null)
  assert.equal(report.callNote, INJECT_IS_NOT_VERDICT_COPY)
})

test('no overlap falls back to importance and says so', () => {
  const report = proposeSessionMemory([fold, port], 'inbox triage', [])
  assert.equal(report.fallback, 'no-overlap')
  assert.match(report.copy, new RegExp(MEMORY_FALLBACK_OVERLAP_COPY))
  assert.equal(report.method, MEMORY_FALLBACK_METHOD)
  assert.deepEqual(report.items.map((item) => item.id), [fold.id, port.id])
})

test('constraint reserve keeps lexical siblings when items have no id', () => {
  const report = proposeSessionMemory([
    { kind: 'constraint', text: '不要改 fold' },
    { kind: 'fact', text: 'web 口在 3091' },
  ], '3091', [])
  assert.equal(report.reserved, true)
  assert.deepEqual(report.items.map((item) => item.text), ['不要改 fold', 'web 口在 3091'])
  assert.equal(report.hits[0]?.method, 'constraint-reserve')
  assert.equal(report.hits[1]?.method, 'lexical+posterior')
})

test('lexical miss still reserves a constraint and does not call it more relevant', () => {
  const report = proposeSessionMemory([fold, port, pref], '3091', [])
  assert.equal(report.fallback, null)
  assert.equal(report.reserved, true)
  assert.deepEqual(report.items.map((item) => item.id), [fold.id, port.id])
  assert.equal(report.hits[0]?.method, 'constraint-reserve')
  assert.equal(report.hits[0]?.lexical, 0)
  assert.match(report.copy, /含约束保送/)
  assert.equal(report.impressions[0]?.text, '不要改 fold')
  assert.equal(report.impressions[0]?.method, 'constraint-reserve')
})

test('memory lexical uses whole CJK runs and slug substrings, not unigrams', () => {
  assert.equal(memoryLexicalScore('不要改 fold', '不要改 fold'), 1)
  assert.ok(memoryLexicalScore('fold', 'project_csdiy_math_material_folding') > 0)
  assert.equal(memoryLexicalScore('不要改 fold', '不要这样'), 0)
  assert.ok(memoryLexicalScore('记忆库', '写入记忆库') > 0)
  const hits = shortlistMemoryItems([
    fold,
    { id: 'dddddddddddddddddddddddd', kind: 'fact', text: '不要这样', importance: 2, createdAt: '2026-09-08T00:00:00.000Z' },
  ], '不要改 fold')
  assert.deepEqual(hits.map((row) => row.id), [fold.id])
})

test('lexical shortlist does not dump the whole store', () => {
  const report = proposeSessionMemory([fold, port, pref], '不要改 fold', [])
  assert.equal(report.fallback, null)
  assert.equal(report.method, MEMORY_LEXICAL_METHOD)
  assert.match(report.copy, /本跳回注 1\/3/)
  assert.deepEqual(report.items.map((item) => item.id), [fold.id])
  assert.equal(report.itemCount, 3)
})

test('posterior from the same label can promote a lower lexical hit', () => {
  const lexical = shortlistMemoryItems([fold, pref], '记忆 fold')
  assert.ok(lexical.length >= 2)
  const label = proposeSessionMemory([fold, pref], '记忆 fold', []).label
  const promoted = blendMemoryShortlist(lexical, [
    { label, itemId: lexical[1].id, result: 'ok' },
    { label, itemId: lexical[1].id, result: 'ok' },
    { label, itemId: lexical[0].id, result: 'fail' },
  ], label)
  assert.equal(promoted[0]?.id, lexical[1].id)
})

test('importance rank is collected order, not slug invention', () => {
  assert.deepEqual(rankByImportance([port, pref, fold]).map((item) => item.id), [fold.id, pref.id, port.id])
})

test('relevance ledger is confirm-gated and session-scoped', async () => {
  const home = await mkdtemp(join(tmpdir(), 'agos-mem-rel-'))
  const store = createSessionMemoryRelevanceStore({ home, now: () => new Date('2026-09-07T08:00:00.000Z') })
  const refused = await store.recordOutcome({
    sessionId: 'agos-loop-verify',
    itemId: fold.id,
    result: 'ok',
    source: 'operator',
  })
  assert.equal(refused.code, 'CONFIRM_REQUIRED')
  const written = await store.recordOutcome({
    sessionId: 'agos-loop-verify',
    itemId: fold.id,
    result: 'ok',
    query: '不要改 fold',
    source: 'operator',
    confirm: true,
  })
  assert.equal(written.ok, true)
  const raw = await readFile(store.ledgerPath, 'utf8')
  assert.match(raw, /"itemId":"aaaaaaaaaaaaaaaaaaaaaaaa"/)
  const other = await store.propose({ sessionId: 'other', items: [fold], query: '不要改 fold' })
  assert.equal(other.matchingLabel, 0)
  const same = await store.propose({ sessionId: 'agos-loop-verify', items: [fold], query: '不要改 fold' })
  assert.equal(same.matchingLabel, 1)
  assert.equal(same.hits[0]?.evidence.s, 1)
})

test('describe keeps missing session uncollected, zero rows as true zero', () => {
  const missing = describeSessionMemoryRelevance('', proposeSessionMemory([], '', []))
  assert.equal(missing.collected, false)
  assert.equal(missing.evidenceRows, null)
  assert.equal(missing.copy, SESSION_UNCOLLECTED_COPY)
  const zero = describeSessionMemoryRelevance('s1', proposeSessionMemory([fold], 'fold', []))
  assert.equal(zero.collected, true)
  assert.equal(zero.evidenceRows, 0)
  assert.equal(zero.copy, '相关账本 0 行')
  const unread = describeUnreadSessionMemory('s1')
  assert.equal(unread.collected, false)
  assert.equal(unread.itemsCollected, false)
  assert.equal(unread.itemCount, null)
  assert.equal(unread.evidenceRows, null)
  assert.equal(unread.copy, STORE_UNREAD_COPY)
})

test('relevance ledger indexes by session and ingests a tail append', async () => {
  const home = await mkdtemp(join(tmpdir(), 'agos-mem-rel-idx-'))
  const store = createSessionMemoryRelevanceStore({ home, now: () => new Date('2026-09-07T09:00:00.000Z') })
  const first = await store.recordOutcome({
    sessionId: 'sess-a',
    itemId: fold.id,
    result: 'ok',
    query: 'fold',
    source: 'operator',
    confirm: true,
  })
  assert.equal(first.ok, true)
  await store.recordOutcome({
    sessionId: 'sess-b',
    itemId: port.id,
    result: 'fail',
    query: '3091',
    source: 'operator',
    confirm: true,
  })
  assert.equal((await store.readState('sess-a')).length, 1)
  assert.equal((await store.readState('sess-b')).length, 1)
  await appendFile(store.ledgerPath, `${JSON.stringify({
    kind: 'outcome',
    sessionId: 'sess-a',
    itemId: fold.id,
    label: 'fold',
    result: 'fail',
    source: 'operator',
  })}\n`)
  assert.equal((await store.readState('sess-a')).length, 2)
  await writeFile(store.ledgerPath, `${JSON.stringify({
    kind: 'outcome',
    sessionId: 'sess-a',
    itemId: fold.id,
    label: 'fold',
    result: 'ok',
    source: 'operator',
  })}\n`)
  assert.equal((await store.readState('sess-a')).length, 1)
  assert.equal((await store.readState('sess-b')).length, 0)
})
