import assert from 'node:assert/strict'
import test from 'node:test'
import {
  MIN_VALID_PANELISTS,
  countValidPanelists,
  evaluateCouncilStructure,
  parseCouncilVerdict,
} from '../lib/council-parse.mjs'
import { collectedStructureReason } from '../lib/council-record.js'

const twoPanelists = [
  { provider: 'qwen', ok: true, text: 'A' },
  { provider: 'doubao', ok: true, text: 'B' },
]

const validReview = {
  consensus: false,
  disagreements: ['答案1称默认启用', '答案2称已关闭'],
  suspect: [1],
  reason: '两家对默认状态说法相反',
  conclusion: 'GIL 默认仍在',
}

const validReviewAgree = {
  consensus: true,
  disagreements: [],
  suspect: [],
  reason: '三家结论相同',
  conclusion: '默认仍在',
}

const validVision = {
  description: '图上是一张值班表',
  disagreements: [],
  suspect: [],
}

test('empty object is not consensus and not parsedOk', () => {
  const extracted = parseCouncilVerdict('{}')
  assert.equal(extracted.ok, true)
  assert.deepEqual(extracted.parsed, {})
  const ev = evaluateCouncilStructure({ parsed: extracted.parsed, panelists: twoPanelists, kind: 'review' })
  assert.equal(ev.parsedOk, false)
  assert.equal(ev.consensus, false)
  assert.equal(ev.reason, 'missing_fields')
  assert.ok(ev.missing.includes('disagreements'))
})

test('missing required fields / wrong types / parse failure all refuse agree', () => {
  const missing = evaluateCouncilStructure({
    parsed: { consensus: true, conclusion: 'x' },
    panelists: twoPanelists,
    kind: 'review',
  })
  assert.equal(missing.parsedOk, false)
  assert.equal(missing.consensus, false)
  assert.equal(missing.reason, 'missing_fields')

  const wrong = evaluateCouncilStructure({
    parsed: {
      consensus: 'true',
      disagreements: {},
      suspect: '1',
      reason: 1,
      conclusion: ['x'],
    },
    panelists: twoPanelists,
    kind: 'review',
  })
  assert.equal(wrong.parsedOk, false)
  assert.equal(wrong.consensus, false)
  assert.equal(wrong.reason, 'wrong_types')

  const failed = parseCouncilVerdict('not-json 没有对象')
  assert.equal(failed.ok, false)
  assert.equal(failed.parsed, null)
  assert.equal(failed.raw, 'not-json 没有对象')
  assert.equal(failed.reason, 'parse_failure')
  const ev = evaluateCouncilStructure({ parsed: failed.parsed, panelists: twoPanelists, parseReason: failed.reason })
  assert.equal(ev.parsedOk, false)
  assert.equal(ev.consensus, false)
  assert.equal(ev.reason, 'parse_failure')
})

test('empty raw and non-object JSON stay unknown', () => {
  const empty = parseCouncilVerdict('   ')
  assert.equal(empty.ok, false)
  assert.equal(empty.reason, 'empty')
  assert.equal(empty.raw, '   ')
  const ev = evaluateCouncilStructure({ parsed: empty.parsed, panelists: twoPanelists, parseReason: empty.reason })
  assert.equal(ev.parsedOk, false)
  assert.equal(ev.consensus, false)
  assert.equal(ev.reason, 'empty')

  const arr = parseCouncilVerdict('[1,2]')
  assert.equal(arr.ok, false)
  assert.equal(arr.reason, 'parse_failure')
})

test('empty disagreements means agree only inside a complete typed structure', () => {
  const incomplete = evaluateCouncilStructure({
    parsed: { disagreements: [] },
    panelists: twoPanelists,
    kind: 'review',
  })
  assert.equal(incomplete.parsedOk, false)
  assert.equal(incomplete.consensus, false)

  const complete = evaluateCouncilStructure({
    parsed: validReviewAgree,
    panelists: twoPanelists,
    kind: 'review',
  })
  assert.equal(complete.parsedOk, true)
  assert.equal(complete.consensus, true)
  assert.deepEqual(complete.disagreements, [])
  assert.equal(complete.reason, undefined)
})

test('too few valid panelists cannot become consensus or parsedOk', () => {
  assert.equal(MIN_VALID_PANELISTS, 2)
  assert.equal(countValidPanelists([{ ok: true }, { ok: false }]), 1)
  const ev = evaluateCouncilStructure({
    parsed: validReviewAgree,
    panelists: [{ provider: 'qwen', ok: true, text: 'only' }],
    kind: 'review',
  })
  assert.equal(ev.parsedOk, false)
  assert.equal(ev.consensus, false)
  assert.equal(ev.inconclusive, true)
  assert.equal(ev.reason, 'too_few_panelists')
  assert.equal(ev.validPanelistCount, 1)

  const none = evaluateCouncilStructure({ parsed: validReviewAgree, kind: 'review' })
  assert.equal(none.parsedOk, false)
  assert.equal(none.consensus, false)
  assert.equal(none.reason, 'too_few_panelists')
})

test('valid review with disagreements is parsedOk and not consensus', () => {
  const ev = evaluateCouncilStructure({ parsed: validReview, panelists: twoPanelists, kind: 'review' })
  assert.equal(ev.parsedOk, true)
  assert.equal(ev.consensus, false)
  assert.deepEqual(ev.disagreements, ['答案1称默认启用', '答案2称已关闭'])
})

test('self-reported consensus is ignored; disagreements are the source of truth', () => {
  const ev = evaluateCouncilStructure({
    parsed: { ...validReview, consensus: true },
    panelists: twoPanelists,
    kind: 'review',
  })
  assert.equal(ev.parsedOk, true)
  assert.equal(ev.consensus, false)
})

test('vision structure shares the same empty-object refusal', () => {
  const empty = evaluateCouncilStructure({ parsed: {}, panelists: twoPanelists, kind: 'vision' })
  assert.equal(empty.parsedOk, false)
  assert.equal(empty.consensus, false)
  assert.equal(empty.kind, 'vision')
  assert.equal(empty.reason, 'missing_fields')

  const ok = evaluateCouncilStructure({ parsed: validVision, panelists: twoPanelists, kind: 'vision' })
  assert.equal(ok.parsedOk, true)
  assert.equal(ok.consensus, true)

  const disagree = evaluateCouncilStructure({
    parsed: { ...validVision, disagreements: ['第三家把日期写成 8 月'] },
    panelists: twoPanelists,
    kind: 'vision',
  })
  assert.equal(disagree.parsedOk, true)
  assert.equal(disagree.consensus, false)
})

test('fenced JSON and braces inside strings still extract the object', () => {
  const fenced = parseCouncilVerdict('好的\n```json\n{"consensus":true,"disagreements":[],"suspect":[],"reason":"ok","conclusion":"yes"}\n```')
  assert.equal(fenced.ok, true)
  assert.equal(fenced.parsed.conclusion, 'yes')

  const nested = parseCouncilVerdict('前言 {"description":"code has { and } here","disagreements":[],"suspect":[]} 后话')
  assert.equal(nested.ok, true)
  assert.equal(nested.parsed.description, 'code has { and } here')
})

test('raw answer text is preserved on every parse outcome', () => {
  const raw = '模型说了一堆然后 {} 又补了一句'
  const extracted = parseCouncilVerdict(raw)
  assert.equal(extracted.raw, raw)
  assert.deepEqual(extracted.parsed, {})
})

test('historical records missing structureReason stay uncollected', () => {
  assert.equal(collectedStructureReason({ kind: 'review', parsedOk: false }), undefined)
  assert.equal(collectedStructureReason({ structureReason: '' }), undefined)
  assert.equal(collectedStructureReason({ structureReason: 'missing_fields' }), 'missing_fields')
  assert.equal(collectedStructureReason(null), undefined)
})

test('object-array disagreements still count so consensus cannot flip to true', () => {
  const ev = evaluateCouncilStructure({
    parsed: {
      consensus: false,
      disagreements: [{ point: 'A 说 3.13 默认关闭' }, { point: 'B 说仍需运行时开关' }],
      suspect: [],
      reason: '默认状态相反',
      conclusion: 'GIL 默认仍在',
    },
    panelists: twoPanelists,
    kind: 'review',
  })
  assert.equal(ev.disagreements.length, 2)
  assert.equal(ev.parsedOk, true)
  assert.equal(ev.consensus, false)
})
