import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  MEMORY_UNCOLLECTED_COPY,
  PLUGINS_UNCOLLECTED_COPY,
  SKILLS_UNCOLLECTED_COPY,
  TURN_UNCOLLECTED_COPY,
  createTurnEvidenceStore,
  describeTurnEvidence,
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
