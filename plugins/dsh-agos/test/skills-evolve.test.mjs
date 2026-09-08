import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  CALL_IS_NOT_VERDICT_COPY,
  CATALOG_TRIM_OFF_COPY,
  POSTERIOR_METHOD_COPY,
  RERANK_FAIL_CLOSED_COPY,
  RERANK_OPT_IN_COPY,
  RERANK_UNAVAILABLE_COPY,
  applyOptionalRerank,
  bindCatalogTrim,
  blendShortlist,
  catalogTrimConfig,
  createSkillEvolveStore,
  writeCatalogTrimConfig,
  lastUserQuery,
  lexicalOverlap,
  parseSelectorSkillPick,
  proposeSkillEvolve,
  rewriteCatalogDecision,
  shortlistSkills,
  tokenize,
  trimCatalogEntries,
} from '../lib/skills-evolve.js'

const catalog = [
  { name: 'inbox-triage', description: '每当用户要清理收件箱或说 inbox 时使用本技能。' },
  { name: 'playwright', description: '每当用户要浏览器自动化或说 playwright 时使用本技能。' },
  { name: 'book-chaos', description: '每当讨论混沌或复杂度阅读时使用本技能。' },
]

test('skill lexical drops CJK unigrams and scores ASCII substrings', () => {
  const tokens = tokenize('整理 Inbox 收件箱')
  assert.equal(tokens.includes('inbox'), true)
  assert.equal(tokens.includes('收件箱'), true)
  assert.equal(tokens.includes('收件'), true)
  assert.equal(tokens.includes('收'), false)
  assert.ok(lexicalOverlap('fold', 'skill-folding') > 0)
  assert.equal(lexicalOverlap('帮我改这段 React 组件的样式', '每当用户要清理收件箱或说 inbox 时使用本技能。'), 0)
})

test('propose is lexical+posterior and does not invent a model rank', () => {
  const empty = proposeSkillEvolve(catalog, '', [])
  assert.deepEqual(empty.hits, [])
  const report = proposeSkillEvolve(catalog, '帮我整理 inbox 收件箱', [])
  assert.equal(report.hits[0]?.name, 'inbox-triage')
  assert.equal(report.note, POSTERIOR_METHOD_COPY)
  assert.equal(report.catalogTrim.copy, CATALOG_TRIM_OFF_COPY)
  assert.equal(report.rerank.available, false)
  assert.equal(report.callNote, CALL_IS_NOT_VERDICT_COPY)
})

test('same-label outcomes can promote a lower lexical hit', () => {
  const lexical = shortlistSkills(catalog, 'inbox 和 playwright')
  const promoted = blendShortlist(lexical, [
    { label: 'inbox', skill: lexical[1].name, result: 'ok' },
    { label: 'inbox', skill: lexical[1].name, result: 'ok' },
    { label: 'inbox', skill: lexical[0].name, result: 'fail' },
  ], 'inbox')
  assert.equal(promoted[0]?.name, lexical[1].name)
})

test('store refuses unconfirmed or skill-call verdicts and appends operator outcomes', async () => {
  const home = await mkdtemp(join(tmpdir(), 'agos-evolve-'))
  const store = createSkillEvolveStore({ home, now: () => new Date('2026-08-23T00:00:00Z') })
  const refused = await store.recordOutcome({
    label: 'inbox', skill: 'inbox-triage', result: 'ok', source: 'skill-call',
  })
  assert.equal(refused.ok, false)
  assert.equal(refused.code, 'CONFIRM_REQUIRED')
  const badSource = await store.recordOutcome({
    label: 'inbox', skill: 'inbox-triage', result: 'ok', source: 'skill-call', confirm: true,
  })
  assert.equal(badSource.ok, false)
  assert.equal(badSource.code, 'SOURCE_REQUIRED')
  const recorded = await store.recordOutcome({
    label: 'inbox', skill: 'inbox-triage', result: 'ok', source: 'operator', confirm: true,
  })
  assert.equal(recorded.ok, true)
  const line = (await readFile(store.ledgerPath, 'utf8')).trim()
  assert.match(line, /"source":"operator"/)
  const report = await store.propose({ query: '整理 inbox', catalog, label: 'inbox' })
  assert.equal(report.matchingLabel, 1)
  assert.equal(report.hits[0]?.name, 'inbox-triage')
})

test('selector pick must stay inside the shortlist', () => {
  assert.equal(parseSelectorSkillPick('{"pick":"ghost","confidence":0.9,"reason":"x"}', ['inbox-triage']), null)
  assert.equal(parseSelectorSkillPick('说明 {写SQL} 结论:{"pick":"inbox-triage","confidence":0.8,"reason":"收件箱"}', ['inbox-triage'])?.pick, 'inbox-triage')
})

test('optional rerank is fail-closed and does not write a route decision', async () => {
  const report = proposeSkillEvolve(catalog, '整理 inbox', [])
  const unavailable = await applyOptionalRerank(report, null)
  assert.equal(unavailable.rerank.copy, RERANK_UNAVAILABLE_COPY)
  const failed = await applyOptionalRerank(report, async () => { throw new Error('timeout') })
  assert.equal(failed.rerank.copy, RERANK_FAIL_CLOSED_COPY)
  assert.equal(failed.hits[0]?.name, report.hits[0]?.name)
  const ok = await applyOptionalRerank(report, async () => ({
    pick: 'inbox-triage', confidence: 0.7, reason: 'matches inbox', label: 'inbox',
  }))
  assert.equal(ok.rerank.ran, true)
  assert.equal(ok.rerank.copy, RERANK_OPT_IN_COPY)
})

test('catalog rewrite is fail-closed', () => {
  const decision = {
    kind: 'enter',
    messages: [{
      id: 'cat',
      source: { kind: 'skill-catalog', entries: catalog },
      content: [{ type: 'text', text: 'full catalog' }],
    }],
  }
  assert.equal(rewriteCatalogDecision(decision, []), decision)
  assert.equal(rewriteCatalogDecision(decision, ['missing']), decision)
  const next = rewriteCatalogDecision(decision, ['inbox-triage'])
  assert.notEqual(next, decision)
  assert.equal(next.messages[0].source.entries.length, 1)
  assert.equal(next.messages[0].source.trimmed, true)
  assert.match(next.messages[0].content[0].text, /你是 AgOS 的提案器/)
  assert.match(next.messages[0].content[0].text, /Do not write \/api\/agos\/routes\/decide/)
  assert.match(next.messages[0].content[0].text, /impression, not a win or loss/)
  assert.deepEqual(trimCatalogEntries(catalog, []), { ok: false, reason: 'empty-shortlist' })
})

test('catalog trim defaults on and persist is confirm-gated', async () => {
  const home = await mkdtemp(join(tmpdir(), 'agos-trim-cfg-'))
  assert.equal(catalogTrimConfig(home).enabled, true)
  const refused = await writeCatalogTrimConfig({ enabled: false }, { home })
  assert.equal(refused.code, 'CONFIRM_REQUIRED')
  const written = await writeCatalogTrimConfig({ enabled: false, confirm: true }, { home })
  assert.equal(written.ok, true)
  assert.equal(catalogTrimConfig(home).enabled, false)
})

test('trim hook calls next first and leaves the decision when disabled', async () => {
  let sawNext = false
  const ctx = {
    on(_event, handler) {
      ctx.handler = handler
      return () => {}
    },
  }
  const home = await mkdtemp(join(tmpdir(), 'agos-trim-'))
  bindCatalogTrim(ctx, { home, catalog: async () => catalog })
  const original = { kind: 'enter', messages: [] }
  const decision = await ctx.handler({ messages: [{ role: 'user', content: '整理 inbox' }] }, async () => {
    sawNext = true
    return original
  })
  assert.equal(sawNext, true)
  assert.equal(decision, original)
  assert.equal(lastUserQuery([{ role: 'user', source: { kind: 'skill-catalog' }, content: 'x' }]), '')
})
