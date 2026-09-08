// C2 — identities must not repeat, and historical rows must keep working.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { readFileSync } from 'node:fs'
import {
  entropyBitsOf,
  hasEntropyTail,
  isLedgerId,
  mintAssembleId,
  mintDecisionId,
  mintDispatchId,
  parseLedgerId,
} from '../lib/ids.js'
import { appendLine, buildDecisionRecord, buildOutcomeRecord, foldLedger, readLedgerLines, listRoutes } from '../lib/ledger.js'
import { buildAssembleRecord } from '../lib/assemble.js'
import { buildDispatchRecord } from '../lib/dispatch.js'
import { bindOrdinaryOutcome } from '../lib/feedback-bind.mjs'
import { deriveRouteRows } from '../lib/outcomes.js'
import { sanitizeOutcomeRef } from '../lib/sanitize.js'
import { buildShadowLinkRecord } from '../lib/shadow.js'

test('no id repeats when the clock does not move', () => {
  // The timestamp is decoration. Freezing it removes the only thing the old
  // `dsp-${Date.now()}` scheme relied on for uniqueness, so a duplicate here is a
  // duplicate in production. `dec-` draws from 2^128, so 50k draws must be unique.
  const frozen = 1788000000000
  const decisions = new Set()
  for (let index = 0; index < 50_000; index++) decisions.add(mintDecisionId(frozen))
  assert.equal(decisions.size, 50_000, 'mintDecisionId repeated inside one millisecond')

  // asm-/dsp- draw a 7-digit tail (10^7 values), because the console pins these to
  // digits — see lib/ids.js. State the real guarantee rather than a rounded one:
  // 2,000 same-millisecond draws collide with probability ≈ 1 - e^(-2000²/2·10⁷) ≈ 18%,
  // so assert the distribution is right, not that duplicates are impossible.
  for (const mint of [mintAssembleId, mintDispatchId]) {
    const ids = new Set()
    const draws = 2_000
    for (let index = 0; index < draws; index++) ids.add(mint(frozen))
    assert.ok(ids.size > draws * 0.7, `${mint.name} tail is not random (${ids.size}/${draws} unique)`)
    // The old scheme would have produced exactly one id here. Anything above that
    // proves uniqueness no longer depends on the clock.
    assert.ok(ids.size > 1_000, `${mint.name} still behaves like a bare timestamp`)
    assert.ok([...ids].every(hasEntropyTail))
  }
})

test('entropy is reported honestly per prefix, and the shapes other modules pin still hold', () => {
  const decision = mintDecisionId()
  const assemble = mintAssembleId()
  const dispatch = mintDispatchId()

  assert.equal(parseLedgerId(decision).entropy.length, 32)
  assert.equal(entropyBitsOf(decision), 128)
  assert.equal(parseLedgerId(decision).prefix, 'dec')

  // floor(log2(10^7)) = 23. Weaker than dec-, and the code says so rather than
  // presenting a digit count as if it were bits.
  assert.equal(entropyBitsOf(assemble), 23)
  assert.equal(entropyBitsOf(dispatch), 23)
  assert.equal(parseLedgerId(assemble).prefix, 'asm')
  assert.equal(parseLedgerId(dispatch).prefix, 'dsp')

  // shadow.js DEC_ID_RE and sanitize.js DECISION_ID both pin /^dec-\d+-[a-f0-9]+$/i.
  // A minted id must still satisfy them or every shadow link breaks.
  assert.match(decision, /^dec-\d+-[a-f0-9]+$/i)
  assert.equal(sanitizeOutcomeRef(decision), decision, 'a real id must survive the ref sanitizer')
  assert.equal(buildShadowLinkRecord({
    ref: decision, batchId: 'b-f785f00d-8463-4369-9a02-4bf6dc7e3024', hosts: ['host-a'],
  }).ref, decision)
  assert.ok(decision.length <= 80, 'must fit the 80-char outcome ref limit')
})

test('minted asm-/dsp- ids still satisfy the console contract they are published under', () => {
  // frontend/src/components/console/routes-assemble.ts validates these two shapes,
  // and postAssembleDispatch() refuses to send a trial at all when the proposal id
  // fails. Read the real regexes out of that file so this breaks loudly if either
  // side drifts, instead of the trial button quietly going dead in the console.
  const source = readFileSync(new URL('../../../frontend/src/components/console/routes-assemble.ts', import.meta.url), 'utf8')
  const literal = (name) => {
    const match = new RegExp(`const ${name} = /(.+?)/;`).exec(source)
    assert.ok(match, `${name} not found in routes-assemble.ts`)
    return new RegExp(match[1])
  }
  const assembleRe = literal('ASSEMBLE_ID_RE')
  const dispatchRe = literal('DISPATCH_ID_RE')

  for (let index = 0; index < 200; index++) {
    const asm = mintAssembleId()
    const dsp = mintDispatchId()
    assert.ok(assembleRe.test(asm), `console would reject proposal id ${asm}`)
    assert.ok(dispatchRe.test(dsp), `console would reject trial id ${dsp}`)
  }
  // Historical ids stay acceptable to the same validators.
  assert.ok(assembleRe.test('asm-1787419059326'))
  assert.ok(dispatchRe.test('dsp-1787419059326'))
})

test('historical rows still parse, fold and bind', () => {
  // Real ids taken from the shipped ledger and from outcomes.test.mjs.
  const legacyDecision = 'dec-1787366398334-afe1a751'
  const legacyDispatch = 'dsp-1787419059326'
  const legacyAssemble = 'asm-1787419000000'

  for (const [id, prefix] of [[legacyDecision, 'dec'], [legacyDispatch, 'dsp'], [legacyAssemble, 'asm']]) {
    const parsed = parseLedgerId(id)
    assert.ok(parsed, `${id} no longer parses`)
    assert.equal(parsed.prefix, prefix)
    assert.equal(isLedgerId(id, prefix), true)
  }
  // The old 8-nibble dec- tail is real entropy, just less of it; bare timestamps have none.
  assert.equal(entropyBitsOf(legacyDecision), 32)
  assert.equal(hasEntropyTail(legacyDispatch), false)
  assert.equal(hasEntropyTail(legacyAssemble), false)
  assert.equal(parseLedgerId(legacyDispatch).legacy, true)
  assert.equal(parseLedgerId(legacyDecision).legacy, false)
  // Short ids used by fixtures and by the first two selector-era rows still parse.
  assert.equal(parseLedgerId('asm-1').legacy, true)
  assert.equal(parseLedgerId('dsp-9').prefix, 'dsp')

  // A pre-taskRef decision row still folds and still accepts an outcome.
  const old = {
    id: legacyDecision, ts: 1787366398334, taskType: 'coding', role: 'implementer',
    label: 'coding', pick: 'qwen3.8-max', candidates: ['qwen3.8-max', 'glm-5.2'],
    source: 'selector', outcome: null,
  }
  const bound = bindOrdinaryOutcome({ authority: 'operator', body: { ref: legacyDecision, result: 'ok' }, rows: [old] })
  assert.equal(bound.ok, true, 'a historical decision became un-annotatable')
  assert.equal(bound.taskUnverified, true, 'legacy rows must be reported as unverifiable, not as verified')
  assert.equal('taskRef' in bound.record, false, 'never invent a fingerprint for a row that has none')
  assert.equal(foldLedger([old, bound.record]).decisions[0].outcome, 'ok')

  // A legacy dispatch row still derives its per-role result rows.
  const derived = deriveRouteRows([{ kind: 'dispatch', id: legacyDispatch, ts: 1787419059326, ref: 'asm-1', turns: [{ role: 'planner', model: 'glm-5.2', ok: true }] }])
  assert.equal(derived.at(-1).ref, `${legacyDispatch}#planner`)

  assert.equal(parseLedgerId('not-an-id'), null)
  assert.equal(parseLedgerId('dec-'), null)
  assert.equal(isLedgerId(legacyDecision, 'dsp'), false)
})

test('records mint their own ids, and two records built in the same tick differ', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agos-ids-'))
  const file = join(dir, 'route-outcome.jsonl')
  const input = { task: 'write docs', taskType: 'coding', candidates: [{ id: 'qwen3.8-max' }] }
  const decision = { role: 'implementer', pick: 'qwen3.8-max', confidence: 0.7, reason: 'r', label: 'coding' }

  const a = buildDecisionRecord(input, decision, 'selector')
  const b = buildDecisionRecord(input, decision, 'selector')
  assert.notEqual(a.id, b.id)

  const team = { label: 'coding', ranking: 'mean', decay: null, source: 'selector', pick: 'qwen3.8-max', roles: [], notes: [], distinct: true, allocation: [] }
  assert.notEqual(buildAssembleRecord(a, team).id, buildAssembleRecord(a, team).id)

  const assemble = { id: mintAssembleId(), ref: a.id, roles: [] }
  const d1 = buildDispatchRecord(assemble, [], 'task text')
  const d2 = buildDispatchRecord(assemble, [], 'task text')
  assert.notEqual(d1.id, d2.id, 'two trials in the same millisecond would have merged')

  // Two same-millisecond trials stay two rows in the ledger, not one overwritten row.
  appendLine(file, a)
  appendLine(file, d1)
  appendLine(file, d2)
  const rows = readLedgerLines(file)
  assert.equal(new Set(rows.filter((row) => row.kind === 'dispatch').map((row) => row.id)).size, 2)
  assert.equal(listRoutes(file, 50).stats.total, 1)

  // buildOutcomeRecord still accepts both id generations as refs.
  assert.equal(buildOutcomeRecord({ ref: a.id, result: 'ok' }).ref, a.id)
  assert.equal(buildOutcomeRecord({ ref: 'dec-1787366398334-afe1a751', result: 'ok' }).ref, 'dec-1787366398334-afe1a751')
})
