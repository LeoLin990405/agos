import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  MEMORY_UNCOLLECTED_COPY,
  PLUGINS_UNCOLLECTED_COPY,
  SKILLS_UNCOLLECTED_COPY,
  TURN_UNCOLLECTED_COPY,
  bindEvidencePatch,
  createTurnEvidenceStore,
  describeTurnEvidence,
  resolveHostTurnBind,
} from '../lib/turn-evidence.js'

test('empty store stays uncollected and does not invent zeros', () => {
  const store = createTurnEvidenceStore()
  const empty = describeTurnEvidence('sess-1', store, {})
  assert.equal(empty.collected, false)
  assert.equal(empty.copy, TURN_UNCOLLECTED_COPY)
  assert.equal(empty.memory.prepended, null)
  assert.equal(empty.memory.copy, MEMORY_UNCOLLECTED_COPY)
  assert.equal(empty.skills.served, null)
  assert.equal(empty.skills.copy, SKILLS_UNCOLLECTED_COPY)
  assert.equal(empty.plugins.profile, null)
  assert.equal(empty.plugins.copy, PLUGINS_UNCOLLECTED_COPY)
})

test('recorded pre-step keeps prepended 0 distinct from uncollected', () => {
  const store = createTurnEvidenceStore()
  store.record('sess-1', {
    memory: { enabled: true, prepended: 0, itemCount: 0 },
    skills: { trimmed: true, query: '整理 inbox', served: ['inbox-triage'] },
  }, new Date('2026-09-07T08:00:00.000Z'))
  const next = describeTurnEvidence('sess-1', store, {
    currentProcess: 'web',
    profiles: [{ name: 'web', plugins: [{ id: 'dsh-agos', kind: 'agos' }] }],
  })
  assert.equal(next.collected, true)
  assert.equal(next.memory.prepended, 0)
  assert.equal(next.memory.copy, '回注已启用，本跳 prepend 0 条')
  assert.deepEqual(next.skills.served, ['inbox-triage'])
  assert.equal(next.plugins.profile, 'web')
  assert.deepEqual(next.plugins.agosLoaded, ['dsh-agos'])
})

test('impressions stay listed and reserved is not relevance', () => {
  const store = createTurnEvidenceStore()
  store.record('sess-2', {
    memory: {
      enabled: true,
      prepended: 1,
      itemCount: 2,
      method: 'lexical+posterior',
      query: '3091',
      reserved: true,
      impressions: [{ id: 'aaaaaaaaaaaaaaaaaaaaaaaa', kind: 'constraint', text: '不要改 fold', method: 'constraint-reserve' }],
      copy: '本跳回注 1/2 · 词面短名单 · 含约束保送',
    },
  }, new Date('2026-09-07T08:01:00.000Z'))
  const reserved = describeTurnEvidence('sess-2', store, { currentProcess: 'web' })
  assert.equal(reserved.memory.reserved, true)
  assert.deepEqual(reserved.memory.impressions, [
    { id: 'aaaaaaaaaaaaaaaaaaaaaaaa', kind: 'constraint', text: '不要改 fold', method: 'constraint-reserve' },
  ])
  assert.equal(reserved.memory.impressions === null, false)
})

test('a later memory lane replaces impressions instead of merging the prior turn', () => {
  const store = createTurnEvidenceStore()
  store.record('sess-3', {
    memory: {
      enabled: true,
      prepended: 1,
      impressions: [{ id: 'aaaaaaaaaaaaaaaaaaaaaaaa', kind: 'constraint', text: '不要改 fold' }],
    },
    skills: { trimmed: true, query: '整理 inbox', served: ['inbox-triage'] },
  })
  store.record('sess-3', {
    memory: { enabled: false, prepended: 0, impressions: [], copy: '回注未启用：本跳没有 prepend' },
  })
  const next = describeTurnEvidence('sess-3', store, {})
  assert.deepEqual(next.memory.impressions, [])
  assert.equal(next.memory.enabled, false)
  assert.deepEqual(next.skills.served, ['inbox-triage'])
})

test('turn evidence ledger reloads the last row and does not invent a turn', async () => {
  const home = await mkdtemp(join(tmpdir(), 'agos-turn-ev-'))
  const first = createTurnEvidenceStore({ home })
  first.record('sess-4', {
    memory: { enabled: true, prepended: 1, query: 'fold', impressions: [{ id: 'aaaaaaaaaaaaaaaaaaaaaaaa', text: '不要改 fold' }] },
  }, new Date('2026-09-08T00:00:00.000Z'))
  first.record('sess-4', {
    memory: { enabled: true, prepended: 0, impressions: [], copy: '回注失败，本跳没有 prepend' },
  }, new Date('2026-09-08T00:01:00.000Z'))
  const reloaded = createTurnEvidenceStore({ home })
  const view = describeTurnEvidence('sess-4', reloaded, {})
  assert.equal(view.memory.prepended, 0)
  assert.deepEqual(view.memory.impressions, [])
  assert.equal(view.memory.copy, '回注失败，本跳没有 prepend')
  assert.equal(describeTurnEvidence('missing', reloaded, {}).collected, false)
})

test('host bind never invents a turn/step sequence', () => {
  const empty = resolveHostTurnBind({ sessionId: 'sess-1' })
  assert.equal(empty.sessionId, 'sess-1')
  assert.equal(empty.turn, null)
  assert.equal(empty.step, null)
  assert.equal(empty.bound, false)
  const store = createTurnEvidenceStore()
  store.record('sess-1', bindEvidencePatch({
    memory: { enabled: true, prepended: 1, itemCount: 1 },
  }, { sessionId: 'sess-1' }))
  const view = describeTurnEvidence('sess-1', store, {})
  assert.equal(view.collected, true)
  assert.equal(view.turn, null)
  assert.equal(view.step, null)
  assert.equal(store.get('sess-1').turn, undefined)
  const host = resolveHostTurnBind({ sessionId: 'sess-2', turn: 0, step: 'pre-step' })
  assert.equal(host.turn, 0)
  assert.equal(host.step, 'pre-step')
  assert.equal(host.bound, true)
})

test('cross-step evidence does not leak into another turn', () => {
  const store = createTurnEvidenceStore()
  store.record('sess-mix', {
    memory: { enabled: true, prepended: 1, itemCount: 1, copy: 'turn-1' },
  }, new Date('2026-09-08T01:00:00.000Z'), { turn: 1, step: 'pre-step' })
  store.record('sess-mix', {
    memory: { enabled: true, prepended: 2, itemCount: 4, copy: 'turn-2' },
  }, new Date('2026-09-08T01:01:00.000Z'), { turn: 2, step: 'pre-step' })
  const first = describeTurnEvidence('sess-mix', store, {}, { turn: 1, step: 'pre-step' })
  const second = describeTurnEvidence('sess-mix', store, {}, { turn: 2, step: 'pre-step' })
  const missing = describeTurnEvidence('sess-mix', store, {}, { turn: 3, step: 'pre-step' })
  assert.equal(first.collected, true)
  assert.equal(first.memory.copy, 'turn-1')
  assert.equal(first.turn, 1)
  assert.equal(second.memory.copy, 'turn-2')
  assert.equal(missing.collected, false)
  assert.equal(missing.observed, false)
  assert.equal(missing.memory.collected, false)
  assert.equal(missing.turn, 3)
  assert.equal(missing.copy, TURN_UNCOLLECTED_COPY)
})

test('persist failure stays observed but not collected or on-disk', async () => {
  const home = await mkdtemp(join(tmpdir(), 'agos-turn-ev-fail-'))
  const blocker = join(home, 'not-a-dir')
  await writeFile(blocker, 'nope')
  const store = createTurnEvidenceStore({ ledgerPath: join(blocker, 'nested', 'turn-evidence.jsonl') })
  const wrote = store.record('sess-fail', {
    memory: { enabled: true, prepended: 3, itemCount: 3 },
  }, new Date('2026-09-08T02:00:00.000Z'))
  assert.equal(wrote.observed, true)
  assert.equal(wrote.persisted, false)
  assert.ok(wrote.persistError)
  const view = describeTurnEvidence('sess-fail', store, {})
  assert.equal(view.observed, true)
  assert.equal(view.collected, false)
  assert.equal(view.persisted, false)
  assert.equal(view.durable, false)
  assert.equal(view.copy, TURN_UNCOLLECTED_COPY)
  assert.equal(view.memory.collected, false)
  assert.ok(view.persistError)
  assert.equal(store.get('sess-fail').memory.prepended, 3)
})

test('old ledger rows without persist/turn fields stay compatible', async () => {
  const home = await mkdtemp(join(tmpdir(), 'agos-turn-ev-old-'))
  const file = join(home, '.dsh', 'agos', 'turn-evidence.jsonl')
  await mkdir(join(home, '.dsh', 'agos'), { recursive: true })
  await writeFile(file, `${JSON.stringify({
    sessionId: 'sess-old',
    at: '2026-08-01T00:00:00.000Z',
    memory: { enabled: true, prepended: 1, itemCount: 2 },
  })}\n`)
  const store = createTurnEvidenceStore({ home })
  const view = describeTurnEvidence('sess-old', store, {})
  assert.equal(view.collected, true)
  assert.equal(view.persisted, true)
  assert.equal(view.durable, true)
  assert.equal(view.turn, null)
  assert.equal(view.step, null)
  assert.equal(view.memory.prepended, 1)
  assert.equal(view.memory.collected, true)
})
