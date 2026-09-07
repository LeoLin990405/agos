import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  INJECT_EMPTY_COPY,
  INJECT_ENABLED_COPY,
  INJECT_OFF_COPY,
  SESSION_MEMORY_KIND,
  bindSessionMemoryInject,
  injectStatusCopy,
  resolveSessionId,
  rewriteDecisionWithSessionMemory,
  sessionMemoryInjectConfig,
  writeSessionMemoryInjectConfig,
} from '../lib/session-memory-inject.js'

const items = [
  { kind: 'constraint', text: '不要改 fold' },
  { kind: 'fact', text: 'web 口在 3091' },
]

test('inject rewrite prepends one reminder and is idempotent', () => {
  const decision = { kind: 'enter', messages: [{ role: 'user', content: '继续' }] }
  const next = rewriteDecisionWithSessionMemory(decision, items, 'session-a')
  assert.notEqual(next, decision)
  assert.equal(next.messages[0].source.kind, SESSION_MEMORY_KIND)
  assert.equal(next.messages[0].source.itemCount, 2)
  assert.match(next.messages[0].content[0].text, /不要改 fold/)
  assert.match(next.messages[0].content[0].text, /why uncollected/)
  assert.equal(rewriteDecisionWithSessionMemory(next, items, 'session-a'), next)
  assert.equal(rewriteDecisionWithSessionMemory(decision, [], 'session-a'), decision)
  assert.equal(rewriteDecisionWithSessionMemory(decision, items, ''), decision)
})

test('session id resolver does not invent an identity', () => {
  assert.equal(resolveSessionId({}), '')
  assert.equal(resolveSessionId({ agent: { id: '  sess-1  ' } }), 'sess-1')
  assert.equal(resolveSessionId({ sessionId: 'sess-2' }), 'sess-2')
  assert.equal(injectStatusCopy(false, 3), INJECT_OFF_COPY)
  assert.equal(injectStatusCopy(true, 0), INJECT_EMPTY_COPY)
  assert.equal(injectStatusCopy(true, 2), INJECT_ENABLED_COPY)
  assert.equal(injectStatusCopy(true, null), '会话记忆读取失败，条目数未采集')
})

test('inject hook is fail-closed and skips empty stores', async () => {
  const home = await mkdtemp(join(tmpdir(), 'agos-inject-'))
  let sawNext = false
  const ctx = { on(_event, handler) { ctx.handler = handler; return () => {} } }
  bindSessionMemoryInject(ctx, {
    home,
    store: { get: async () => ({ items: [] }) },
  })
  const original = { kind: 'enter', messages: [{ role: 'user', content: 'hi' }] }
  const decision = await ctx.handler({ agent: { id: 'session-a' } }, async () => {
    sawNext = true
    return original
  })
  assert.equal(sawNext, true)
  assert.equal(decision, original)
})

test('inject hook prepends when the store has items', async () => {
  const home = await mkdtemp(join(tmpdir(), 'agos-inject-on-'))
  const ctx = { on(_event, handler) { ctx.handler = handler; return () => {} } }
  bindSessionMemoryInject(ctx, {
    home,
    store: { get: async () => ({ items }) },
  })
  const original = { kind: 'enter', messages: [{ role: 'user', content: 'hi' }] }
  const decision = await ctx.handler({ agent: { id: 'session-a' } }, async () => original)
  assert.equal(decision.messages[0].source.kind, SESSION_MEMORY_KIND)
})

test('inject config write is confirm-gated and default is on', async () => {
  const home = await mkdtemp(join(tmpdir(), 'agos-inject-cfg-'))
  assert.equal(sessionMemoryInjectConfig(home).enabled, true)
  const refused = await writeSessionMemoryInjectConfig({ enabled: false }, { home })
  assert.equal(refused.code, 'CONFIRM_REQUIRED')
  const written = await writeSessionMemoryInjectConfig({ enabled: false, confirm: true }, { home })
  assert.equal(written.ok, true)
  assert.equal(sessionMemoryInjectConfig(home).enabled, false)
  const raw = JSON.parse(await readFile(written.path, 'utf8'))
  assert.equal(raw.enabled, false)
})

test('inject hook shortlists by this-turn query and does not dump the store', async () => {
  const { createTurnEvidenceStore } = await import('../lib/turn-evidence.js')
  const home = await mkdtemp(join(tmpdir(), 'agos-inject-rank-'))
  const evidence = createTurnEvidenceStore()
  const ctx = { on(_event, handler) { ctx.handler = handler; return () => {} } }
  bindSessionMemoryInject(ctx, {
    home,
    store: { get: async () => ({ items }) },
    evidence,
  })
  const decision = await ctx.handler({
    agent: { id: 'session-a' },
    messages: [{ role: 'user', content: '不要改 fold' }],
  }, async () => ({ kind: 'enter', messages: [{ role: 'user', content: '不要改 fold' }] }))
  assert.match(decision.messages[0].content[0].text, /不要改 fold/)
  assert.match(decision.messages[0].content[0].text, /lexical\+posterior shortlist/)
  assert.equal(decision.messages[0].content[0].text.includes('3091'), false)
  assert.equal(evidence.get('session-a').memory.method, 'lexical+posterior')
  assert.equal(evidence.get('session-a').memory.prepended, 1)
})

test('inject reminder marks reserved constraints as not more relevant', async () => {
  const ctx = { on(_event, handler) { ctx.handler = handler; return () => {} } }
  bindSessionMemoryInject(ctx, {
    home: await mkdtemp(join(tmpdir(), 'agos-inject-reserve-')),
    store: { get: async () => ({ items }) },
  })
  const decision = await ctx.handler({
    agent: { id: 'session-a' },
    messages: [{ role: 'user', content: '3091' }],
  }, async () => ({ kind: 'enter', messages: [{ role: 'user', content: '3091' }] }))
  assert.match(decision.messages[0].content[0].text, /reserved-constraint, not more relevant/)
  assert.match(decision.messages[0].content[0].text, /lexical\+posterior shortlist/)
})

test('inject hook records prepended 0 when the store is empty', async () => {
  const { createTurnEvidenceStore } = await import('../lib/turn-evidence.js')
  const home = await mkdtemp(join(tmpdir(), 'agos-inject-ev-'))
  const evidence = createTurnEvidenceStore()
  const ctx = { on(_event, handler) { ctx.handler = handler; return () => {} } }
  bindSessionMemoryInject(ctx, {
    home,
    store: { get: async () => ({ items: [] }) },
    evidence,
  })
  await ctx.handler({ agent: { id: 'session-a' } }, async () => ({ kind: 'enter', messages: [] }))
  const row = evidence.get('session-a')
  assert.equal(row.memory.enabled, true)
  assert.equal(row.memory.prepended, 0)
  assert.equal(row.memory.itemCount, 0)
})

test('inject hook records a collected failure instead of swallowing it', async () => {
  const { createTurnEvidenceStore, describeTurnEvidence } = await import('../lib/turn-evidence.js')
  const evidence = createTurnEvidenceStore()
  const ctx = { on(_event, handler) { ctx.handler = handler; return () => {} } }
  bindSessionMemoryInject(ctx, {
    home: await mkdtemp(join(tmpdir(), 'agos-inject-fail-')),
    store: { get: async () => { throw new Error('store-down') } },
    evidence,
  })
  const original = { kind: 'enter', messages: [{ role: 'user', content: 'hi' }] }
  const decision = await ctx.handler({ agent: { id: 'session-a' } }, async () => original)
  assert.equal(decision, original)
  const view = describeTurnEvidence('session-a', evidence, {})
  assert.equal(view.memory.collected, true)
  assert.equal(view.memory.prepended, 0)
  assert.deepEqual(view.memory.impressions, [])
  assert.equal(view.memory.copy, '回注失败，本跳没有 prepend')
})

test('inject failure does not keep the previous turn impressions', async () => {
  const { createTurnEvidenceStore, describeTurnEvidence } = await import('../lib/turn-evidence.js')
  const evidence = createTurnEvidenceStore()
  evidence.record('session-a', {
    memory: {
      enabled: true,
      prepended: 1,
      impressions: [{ id: 'aaaaaaaaaaaaaaaaaaaaaaaa', kind: 'constraint', text: '不要改 fold' }],
    },
  })
  const ctx = { on(_event, handler) { ctx.handler = handler; return () => {} } }
  bindSessionMemoryInject(ctx, {
    home: await mkdtemp(join(tmpdir(), 'agos-inject-bleed-')),
    store: { get: async () => { throw new Error('store-down') } },
    evidence,
  })
  await ctx.handler({ agent: { id: 'session-a' } }, async () => ({ kind: 'enter', messages: [] }))
  const view = describeTurnEvidence('session-a', evidence, {})
  assert.deepEqual(view.memory.impressions, [])
  assert.equal(view.memory.copy, '回注失败，本跳没有 prepend')
})
