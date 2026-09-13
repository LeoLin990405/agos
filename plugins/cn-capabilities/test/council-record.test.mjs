import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { evaluateCouncilStructure } from '../lib/council-parse.mjs'
import {
  buildCouncilReviewRecord,
  collectedStructureReason,
  councilReviewVerdict,
  disagreementsFromParsed,
  normalizeDisagreementItems,
  validateCouncilFields,
} from '../lib/council-record.js'

test('council persist always has kind=review and an independent disagreements array', () => {
  const parsed = {
    consensus: false,
    conclusion: 'GIL 默认仍在',
    disagreements: ['答案1称默认启用需运行时关闭', '答案2称 3.13 已默认关闭'],
    reason: '两家对默认状态说法相反',
    suspect: [1],
  }
  const disagreements = disagreementsFromParsed(parsed)
  const verdict = councilReviewVerdict({
    arbOk: true,
    parsed,
    consensus: false,
    flagged: ['qwen'],
  })
  const row = buildCouncilReviewRecord({
    question: '自由线程构建中 GIL 的默认状态',
    hadImages: 0,
    arbiter: 'stepfun',
    arbiterMetered: false,
    consensus: false,
    parsedOk: true,
    panelists: [],
    verdict,
    disagreements,
    flagged: ['qwen'],
    time: '2026-08-22T02:00:00.000Z',
  })
  assert.equal(row.kind, 'review')
  assert.deepEqual(row.disagreements, [
    '答案1称默认启用需运行时关闭',
    '答案2称 3.13 已默认关闭',
  ])
  assert.equal(verdict.includes('存在分歧。'), true)
  assert.equal(verdict.includes('答案1称默认启用'), false)
  assert.equal(verdict.includes(';'), false)
  assert.match(verdict, /结论:GIL 默认仍在/)
})

test('parse failure still writes disagreements:[] so UI cannot say 早于该字段', () => {
  const row = buildCouncilReviewRecord({
    question: 'x',
    hadImages: 0,
    arbiter: 'stepfun',
    arbiterMetered: false,
    consensus: false,
    parsedOk: false,
    panelists: [],
    verdict: councilReviewVerdict({ arbOk: true, arbText: 'not-json', parsed: null, consensus: false, flagged: [] }),
    disagreements: disagreementsFromParsed(null),
    flagged: [],
  })
  assert.equal(row.kind, 'review')
  assert.deepEqual(row.disagreements, [])
  assert.equal(Array.isArray(row.disagreements), true)
})

/**
 * ⚠️ 这条原来断言的是「非字符串项一律丢弃」—— 那正是缺陷本身:018 之后 consensus
 * 由 disagreements.length 派生,丢弃就等于把「存在分歧」改写成「各家一致」
 * (2026-08-22 验收 P1)。现在断言的是「不 String() 成垃圾」+「条数不减少」。
 */
test('non-string disagreement items are made readable, never String()-coerced into garbage', () => {
  assert.deepEqual(
    normalizeDisagreementItems(['  日期不一致  ', null, { x: 1 }, 3, '', '第二家看反了']),
    ['日期不一致', '(仲裁给出一条无法解析的分歧项)', '3', '第二家看反了'],
  )
  assert.deepEqual(
    disagreementsFromParsed({ disagreements: [null, { a: 1 }, 'only'] }),
    ['(仲裁给出一条无法解析的分歧项)', 'only'],
  )
  const src = readFileSync(fileURLToPath(new URL('../lib/index.js', import.meta.url)), 'utf8')
  assert.match(src, /evaluateCouncilStructure/)
  assert.match(src, /parseCouncilVerdict/)
})

test('inconclusive persist has kind and panel status, no invented arbitration', () => {
  const row = buildCouncilReviewRecord({
    question: 'x',
    hadImages: 0,
    arbiter: '(未仲裁)',
    arbiterMetered: false,
    consensus: false,
    inconclusive: true,
    parsedOk: false,
    panelists: [{ provider: 'qwen', ok: false, error: '超时' }],
    verdict: '有效答案不足 0/2,无法交叉核验。失败原因见各行。',
    disagreements: [],
    flagged: [],
  })
  assert.equal(row.kind, 'review')
  assert.equal(row.inconclusive, true)
  assert.deepEqual(row.disagreements, [])
  assert.equal(row.consensus, false)
  assert.match(row.verdict, /有效答案不足/)
  assert.equal(row.verdict.includes('各家一致'), false)
  const src = readFileSync(fileURLToPath(new URL('../lib/index.js', import.meta.url)), 'utf8')
  assert.match(src, /ok\.length < 2/)
  assert.match(src, /inconclusive: true/)
  assert.match(src, /buildCouncilReviewRecord/)
})

test('speak tool definition is back and speech.py is on the execute path', () => {
  const src = readFileSync(fileURLToPath(new URL('../lib/index.js', import.meta.url)), 'utf8')
  assert.match(src, /name: 'speak'/)
  assert.match(src, /speech\.py/)
  assert.match(src, /freshMediaPath\('dsh-speak'/)
  assert.doesNotMatch(src, /name: 'transcribe'/)
  assert.doesNotMatch(src, /name: 'delegate_kimi'/)
})

test('对象数组形态的分歧不再被丢弃，consensus 不会反转成 true (2026-08-22 验收 P1)', () => {
  const parsed = {
    consensus: false,
    disagreements: [{ point: 'A 说 3.13 默认关闭' }, { point: 'B 说仍需运行时开关' }],
    suspect: [],
    reason: '默认状态相反',
    conclusion: 'GIL 默认仍在',
  }
  const disagreements = disagreementsFromParsed(parsed)
  assert.equal(disagreements.length, 2, '对象项被丢了 —— consensus 会被派生成 true')
  assert.deepEqual(disagreements, ['A 说 3.13 默认关闭', 'B 说仍需运行时开关'])
  // ⚠️ 旧公式 `!!parsed && disagreements.length === 0` 把 {} 判成同意,已废。
  // 本条原先只防「对象项被丢光」;补齐必填字段后走 evaluateCouncilStructure。
  const ev = evaluateCouncilStructure({
    parsed,
    panelists: [
      { provider: 'qwen', ok: true },
      { provider: 'doubao', ok: true },
    ],
    kind: 'review',
  })
  assert.equal(ev.consensus, false)
  assert.equal(ev.parsedOk, true)
  assert.match(councilReviewVerdict({ arbOk: true, parsed, consensus: ev.consensus, flagged: [] }), /存在分歧/)
})

test('读不出文本的分歧项留占位，不吐 [object Object]，也不减少条数', () => {
  const out = normalizeDisagreementItems([{}, { foo: 1 }, ['嵌套一条'], 42, true])
  assert.equal(out.length, 5)
  for (const item of out) {
    assert.equal(typeof item, 'string')
    assert.doesNotMatch(item, /\[object Object\]|^null$|^undefined$/)
  }
  assert.equal(out[2], '嵌套一条')
  assert.equal(out[3], '42')
  // 真正空的项才丢：它们不承载任何分歧，留下反而会把「一致」错判成「分歧」。
  assert.deepEqual(normalizeDisagreementItems([null, undefined, '', '   ']), [])
})

/**
 * ⚠️ 这条原来若写成 disagreementsFromParsed({}) === [],再配合
 * consensus = !!parsed && length===0,会把空对象判成「各家一致」
 * (2026-09-08 hardening I,分析 P2)。缺数组现在是 unknown,不是空同意列表。
 */
test('missing disagreements array is unknown, not an empty agree-list (was the empty-JSON bug)', () => {
  assert.equal(disagreementsFromParsed({}), undefined)
  assert.equal(disagreementsFromParsed({ consensus: true }), undefined)
  assert.equal(disagreementsFromParsed(null), undefined)
  assert.deepEqual(disagreementsFromParsed({ disagreements: [] }), [])
  const fields = validateCouncilFields({})
  assert.equal(fields.ok, false)
  assert.equal(fields.reason, 'missing_fields')
})

test('empty / invalid arbiter JSON verdict keeps raw text and does not say 各家一致', () => {
  const verdict = councilReviewVerdict({
    arbOk: true,
    arbText: '{}',
    parsed: {},
    consensus: false,
    flagged: [],
    parsedOk: false,
    structureReason: 'missing_fields',
  })
  assert.match(verdict, /missing_fields/)
  assert.match(verdict, /\{\}/)
  assert.equal(verdict.includes('各家一致'), false)
  assert.equal(verdict.includes('存在分歧'), false)
  assert.match(verdict, /不计入台账判定/)
})

test('structureReason is written only when present; historical absence stays uncollected', () => {
  const fresh = buildCouncilReviewRecord({
    question: 'x',
    hadImages: 0,
    arbiter: 'stepfun',
    arbiterMetered: false,
    consensus: false,
    parsedOk: false,
    panelists: [],
    verdict: '⚠️ 仲裁未按完整 JSON 结构返回(missing_fields),以下为原文',
    disagreements: undefined,
    flagged: [],
    structureReason: 'missing_fields',
    time: '2026-09-08T10:00:00.000Z',
  })
  assert.equal(fresh.structureReason, 'missing_fields')
  assert.deepEqual(fresh.disagreements, [])
  assert.equal(fresh.consensus, false)
  assert.equal(fresh.parsedOk, false)

  const legacy = buildCouncilReviewRecord({
    question: 'x',
    hadImages: 0,
    arbiter: 'stepfun',
    arbiterMetered: false,
    consensus: false,
    parsedOk: false,
    panelists: [],
    verdict: 'old',
    disagreements: [],
    flagged: [],
  })
  assert.equal(Object.hasOwn(legacy, 'structureReason'), false)
  assert.equal(collectedStructureReason(legacy), undefined)
})
