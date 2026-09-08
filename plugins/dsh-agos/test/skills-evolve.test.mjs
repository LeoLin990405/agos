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
  catalogEntryOrigin,
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
  trimRuntimeCatalogEntries,
} from '../lib/skills-evolve.js'
import { pinSessionMemoryItem } from '../lib/session-memory.mjs'
import { bindRuntimeSkillCatalogTrim } from '../lib/index.js'
import { createTurnEvidenceStore, describeTurnEvidence } from '../lib/turn-evidence.js'

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

test('runtime trim keeps project and origin-unknown when candidates are user-root-only', () => {
  const runtime = [
    { name: 'inbox-triage', description: 'global inbox', source: 'user-dsh' },
    { name: 'playwright', description: 'global browser', source: 'user-agents' },
    { name: 'repo-deploy', description: 'project deploy', source: 'project-dsh' },
    { name: 'workspace-note', description: 'project agents', origin: 'project-agents' },
    { name: 'mystery-skill', description: 'no origin field' },
    { name: 'bundled-helper', description: 'bundled', source: 'bundled' },
  ]
  const candidates = [
    { name: 'inbox-triage', source: 'user-dsh' },
    { name: 'playwright', source: 'user-agents' },
  ]
  assert.equal(catalogEntryOrigin(runtime[0]), 'global')
  assert.equal(catalogEntryOrigin(runtime[2]), 'project')
  assert.equal(catalogEntryOrigin(runtime[4]), 'unknown')
  assert.equal(catalogEntryOrigin(runtime[5]), 'unknown')
  const trimmed = trimRuntimeCatalogEntries(runtime, ['inbox-triage'], candidates)
  assert.equal(trimmed.ok, true)
  assert.deepEqual(trimmed.entries.map((entry) => entry.name), [
    'inbox-triage', 'repo-deploy', 'workspace-note', 'mystery-skill', 'bundled-helper',
  ])
  assert.deepEqual(trimRuntimeCatalogEntries(runtime, [], candidates), { ok: false, reason: 'empty-shortlist' })
  assert.deepEqual(trimRuntimeCatalogEntries(runtime, ['missing-skill'], candidates), { ok: false, reason: 'no-overlap' })
  assert.deepEqual(trimRuntimeCatalogEntries(runtime, ['inbox-triage'], []), { ok: false, reason: 'empty-candidates' })
  assert.deepEqual(trimRuntimeCatalogEntries(runtime, ['inbox-triage'], undefined), { ok: false, reason: 'unknown-format' })
  assert.deepEqual(trimRuntimeCatalogEntries('nope', ['inbox-triage'], candidates), { ok: false, reason: 'unknown-format' })

  const decision = {
    kind: 'enter',
    messages: [{
      id: 'cat',
      source: { kind: 'skill-catalog', entries: runtime },
      content: [{ type: 'text', text: 'full catalog' }],
    }],
  }
  const next = rewriteCatalogDecision(decision, ['inbox-triage'], { candidates })
  assert.notEqual(next, decision)
  assert.deepEqual(next.messages[0].source.entries.map((entry) => entry.name), [
    'inbox-triage', 'repo-deploy', 'workspace-note', 'mystery-skill', 'bundled-helper',
  ])
  assert.equal(rewriteCatalogDecision(decision, ['inbox-triage'], { candidates: [] }), decision)
  assert.equal(rewriteCatalogDecision(decision, [], { candidates }), decision)
})

test('unlabeled runtime name that also appears in the user-root audit is kept', () => {
  const runtime = [
    { name: 'inbox-triage', description: '每当用户要清理收件箱或说 inbox 时使用本技能。', source: 'user-dsh' },
    { name: 'deploy', description: '部署本仓库' },
    { name: 'deploy', description: '项目部署副本', source: 'project-dsh' },
  ]
  const candidates = [
    { name: 'deploy', source: 'user-dsh' },
    { name: 'inbox-triage', source: 'user-dsh' },
  ]
  const trimmed = trimRuntimeCatalogEntries(runtime, ['inbox-triage'], candidates)
  assert.equal(trimmed.ok, true)
  assert.deepEqual(trimmed.entries.map((entry) => entry.name), ['inbox-triage', 'deploy', 'deploy'])
  assert.equal(catalogEntryOrigin(runtime[1]), 'unknown')
  assert.equal(trimmed.entries.some((entry) => entry.name === 'deploy' && entry.source === undefined), true)
  assert.equal(trimmed.entries.some((entry) => entry.source === 'project-dsh'), true)
})

test('trim hook keeps project skills when candidate audit is user-root-only', async () => {
  const runtime = [
    { name: 'inbox-triage', description: '每当用户要清理收件箱或说 inbox 时使用本技能。', source: 'user-dsh' },
    { name: 'repo-deploy', description: '部署本仓库', source: 'project-dsh' },
    { name: 'mystery-skill', description: '来源未采集' },
  ]
  const candidates = [
    { name: 'inbox-triage', description: '每当用户要清理收件箱或说 inbox 时使用本技能。', source: 'user-dsh' },
  ]
  const ctx = { on(_event, handler) { ctx.handler = handler; return () => {} } }
  const home = await mkdtemp(join(tmpdir(), 'agos-trim-runtime-'))
  bindCatalogTrim(ctx, { home, catalog: async () => candidates })
  const original = {
    kind: 'enter',
    messages: [{
      id: 'cat',
      source: { kind: 'skill-catalog', entries: runtime },
      content: [{ type: 'text', text: 'full catalog' }],
    }],
  }
  const decision = await ctx.handler({ messages: [{ role: 'user', content: '整理 inbox' }] }, async () => original)
  assert.equal(decision, original)
  assert.deepEqual(decision.messages[0].source.entries.map((entry) => entry.name), [
    'inbox-triage', 'repo-deploy', 'mystery-skill',
  ])

  const emptyCtx = { on(_event, handler) { emptyCtx.handler = handler; return () => {} } }
  bindCatalogTrim(emptyCtx, { home, catalog: async () => [] })
  const kept = await emptyCtx.handler({ messages: [{ role: 'user', content: '整理 inbox' }] }, async () => original)
  assert.equal(kept, original)

  const badCtx = { on(_event, handler) { badCtx.handler = handler; return () => {} } }
  bindCatalogTrim(badCtx, { home, catalog: async () => ({ catalog: candidates }) })
  const unread = await badCtx.handler({ messages: [{ role: 'user', content: '整理 inbox' }] }, async () => original)
  assert.equal(unread, original)
})

function runtimeSkill(name, description, source, modelInvocable = true) {
  return { name, description, source, provider: 'filesystem', invocation: { modelInvocable, userInvocable: true } }
}

function liveCatalog(entries) {
  return {
    kind: 'enter',
    messages: [{
      id: 'cat', role: 'user', source: { kind: 'skill-catalog', entries },
      content: [{ type: 'text', text: 'full host catalog' }],
    }],
  }
}

function scopedSkillsContext() {
  let disposeReady
  const ctx = {
    on(name, handler) { assert.equal(name, 'agent/pre-step'); ctx.handler = handler; return () => {} },
    // Match Cordis: the root context cannot see a non-injected service.
    get() { throw new Error('root context cannot access skills') },
    inject(dependencies, ready) {
      assert.deepEqual(dependencies, ['skills'])
      ctx.provide = (service) => {
        if (disposeReady) disposeReady()
        disposeReady = ready({ get: (name) => name === 'skills' ? service : undefined })
      }
      ctx.remove = () => { if (disposeReady) disposeReady(); disposeReady = undefined }
      return ctx.remove
    },
  }
  return ctx
}

test('injected runtime snapshot trims unlabeled host entries using current project/global winners', async () => {
  const home = await mkdtemp(join(tmpdir(), 'agos-runtime-winners-'))
  const evidence = createTurnEvidenceStore({ home })
  const ctx = scopedSkillsContext()
  const rankedCatalogs = []
  bindRuntimeSkillCatalogTrim(ctx, {
    home, evidence,
    store: { async propose({ catalog: candidates, query }) {
      rankedCatalogs.push(candidates)
      return proposeSkillEvolve(candidates, query, [])
    } },
    catalog: async () => { throw new Error('user-root audit must not select runtime winners') },
  })
  const inbox = runtimeSkill('inbox-triage', 'inbox cleanup', 'user-dsh')
  const browser = runtimeSkill('playwright', 'browser automation', 'user-agents')
  const project = runtimeSkill('deploy', 'deploy this repository', 'project-dsh')
  const global = runtimeSkill('deploy', 'global deployment', 'user-dsh')
  const hidden = runtimeSkill('hidden-inbox', 'inbox hidden helper', 'user-dsh', false)
  const runtime = runtimeSkill('dynamic-helper', 'dynamic workflow', 'runtime')
  const entries = [inbox, browser, project, runtime].map(({ name, description }) => ({ name, description }))
  entries.push({ name: 'unknown-helper', description: 'unresolved origin' })
  const original = liveCatalog(entries)
  const signal = new AbortController().signal
  const agent = { id: 'snapshot-session', session: { header: { cwd: '/synthetic/project' } } }
  const event = { agent, signal, turn: 10, step: 1, messages: [{ role: 'user', content: 'inbox' }] }
  let currentWinner = project
  ctx.provide({ async snapshot(options) {
    assert.deepEqual(options, { cwd: '/synthetic/project', signal, scope: agent })
    return { complete: true, skills: [inbox, browser, currentWinner, hidden, runtime] }
  } })
  const projectDecision = await ctx.handler(event, async () => original)
  assert.notEqual(projectDecision, original)
  assert.deepEqual(projectDecision.messages[0].source.entries.map((row) => row.name), [
    'inbox-triage', 'deploy', 'dynamic-helper', 'unknown-helper',
  ])
  assert.equal(projectDecision.messages[0].source.entries[1], entries[2])
  assert.equal(projectDecision.messages[0].source.entries[1].source, undefined)
  assert.match(projectDecision.messages[0].content[0].text, /deploy/)
  assert.doesNotMatch(projectDecision.messages[0].content[0].text, /playwright/)
  assert.equal(rankedCatalogs[0].includes(project), true)
  assert.equal(rankedCatalogs[0].includes(hidden), false)
  const first = describeTurnEvidence(agent.id, evidence, {}, { turn: 10, step: 1 })
  assert.equal(first.skills.trimmed, true)
  assert.equal(first.persisted, true)
  assert.deepEqual(first.skills.served, ['inbox-triage', 'deploy', 'dynamic-helper', 'unknown-helper'])

  currentWinner = global
  const globalOriginal = liveCatalog(entries.map((entry) => entry.name === 'deploy'
    ? { name: global.name, description: global.description } : entry))
  const globalDecision = await ctx.handler({ ...event, step: 2 }, async () => globalOriginal)
  assert.deepEqual(globalDecision.messages[0].source.entries.map((row) => row.name), [
    'inbox-triage', 'dynamic-helper', 'unknown-helper',
  ])
  assert.equal(rankedCatalogs[1].includes(global), true)
  const reloaded = createTurnEvidenceStore({ home })
  assert.equal(describeTurnEvidence(agent.id, reloaded, {}, { turn: 10, step: 1 }).skills.served.includes('deploy'), true)
  assert.equal(describeTurnEvidence(agent.id, reloaded, {}, { turn: 10, step: 2 }).skills.served.includes('deploy'), false)

  // The host catalog may have been rendered before the project winner vanished.
  // A later same-name user snapshot must not relabel this earlier project row.
  const racedDecision = await ctx.handler({ ...event, step: 3 }, async () => original)
  assert.equal(racedDecision.messages[0].source.entries.includes(entries[2]), true)
  assert.equal(describeTurnEvidence(agent.id, evidence, {}, { turn: 10, step: 3 }).skills.served.includes('deploy'), true)
})

test('runtime snapshot fallback preserves the host decision and records trimmed false', async () => {
  const home = await mkdtemp(join(tmpdir(), 'agos-runtime-fallback-'))
  const evidence = createTurnEvidenceStore({ home })
  const ctx = scopedSkillsContext()
  bindRuntimeSkillCatalogTrim(ctx, { home, evidence })
  const snapshot = { complete: true, skills: [
    runtimeSkill('inbox-triage', 'inbox cleanup', 'user-dsh'),
    runtimeSkill('playwright', 'browser automation', 'user-agents'),
  ] }
  const original = liveCatalog(snapshot.skills.map(({ name, description }) => ({ name, description })))
  const base = {
    agent: { id: 'fallback-session', session: { header: { cwd: '/synthetic/project' } } },
    messages: [{ role: 'user', content: 'inbox' }], turn: 'turn-a',
  }
  const cases = [
    ['missing-service', null, base],
    ['incomplete', { snapshot: async () => ({ ...snapshot, complete: false }) }, base],
    ['throw', { snapshot: async () => { throw new Error('snapshot failed') } }, base],
    ['bad-format', { snapshot: async () => ({ complete: true, skills: {} }) }, base],
    ['empty', { snapshot: async () => ({ complete: true, skills: [] }) }, base],
    ['missing-agent', { snapshot: async () => { throw new Error('must not call without agent') } }, { ...base, agent: undefined, sessionId: 'fallback-session' }],
    ['missing-cwd', { snapshot: async () => { throw new Error('must not call without cwd') } }, { ...base, agent: { id: 'fallback-session' } }],
  ]
  for (const [step, service, event] of cases) {
    ctx.provide(service)
    assert.equal(await ctx.handler({ ...event, step }, async () => original), original, step)
    const view = describeTurnEvidence('fallback-session', evidence, {}, { turn: 'turn-a', step })
    assert.equal(view.skills.trimmed, false, step)
    assert.equal(view.skills.served, null, step)
    assert.equal(view.persisted, true, step)
  }
  ctx.provide({ snapshot: async () => snapshot })
  ctx.remove()
  assert.equal(await ctx.handler({ ...base, step: 'removed' }, async () => original), original)
  assert.equal(describeTurnEvidence('fallback-session', evidence, {}, { turn: 'turn-a', step: 'removed' }).skills.trimmed, false)
})

test('a successful snapshot without removable globals does not claim a trim', async () => {
  const home = await mkdtemp(join(tmpdir(), 'agos-runtime-no-change-'))
  const evidence = createTurnEvidenceStore({ home })
  const ctx = scopedSkillsContext()
  bindRuntimeSkillCatalogTrim(ctx, { home, evidence })
  const skills = [runtimeSkill('inbox-triage', 'inbox cleanup', 'project-agents')]
  ctx.provide({ snapshot: async () => ({ complete: true, skills }) })
  const original = liveCatalog(skills.map(({ name, description }) => ({ name, description })))
  const decision = await ctx.handler({
    agent: { id: 'no-change', session: { header: { cwd: '/synthetic/project' } } },
    messages: [{ role: 'user', content: 'inbox' }], turn: 0, step: 0,
  }, async () => original)
  assert.equal(decision, original)
  assert.equal(describeTurnEvidence('no-change', evidence, {}, { turn: 0, step: 0 }).skills.trimmed, false)
})

test('operator pin rejects over-limit text instead of silent end-chop', () => {
  const over = pinSessionMemoryItem({ kind: 'constraint', text: '约'.repeat(201), confirm: true })
  assert.equal(over.ok, false)
  assert.equal(over.code, 'INVALID_TEXT')
  const exact = pinSessionMemoryItem({ kind: 'constraint', text: '约'.repeat(200), confirm: true })
  assert.equal(exact.ok, true)
  assert.equal([...exact.item.text].length, 200)
  const padded = pinSessionMemoryItem({ kind: 'constraint', text: `  ${'约'.repeat(200)}  `, confirm: true })
  assert.equal(padded.ok, true)
  assert.equal([...padded.item.text].length, 200)
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
