/** 读图/评审台账模型测试(纯解析,零网络零模型)。 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  collectedDisagreements,
  inconclusiveBanner,
  INCONCLUSIVE_COPY,
  kindChip,
  lineDivergenceMarks,
  panelOkCount,
  parseVisionLedger,
} from './council-ledger-model.ts'

test('全类型保留,kind 缺省渲染「类型未采集」不猜', () => {
  const records = parseVisionLedger({
    records: [
      {
        kind: 'vision', time: '2026-08-21T10:00:00Z', question: '[图] a.png',
        arbiter: 'mimo', parsedOk: true, verdict: '图上是值班表',
        disagreements: ['第三家把日期写成 8 月'],
        flagged: ['doubao'],
        panelists: [
          { provider: 'qwen', ok: true, ms: 1200, text: '值班表' },
          { provider: 'doubao', ok: false, ms: 900, error: '超时' },
        ],
      },
      { time: '2026-08-21T09:00:00Z', question: '文字评审', panelists: [] },
    ],
  })
  assert.equal(records.length, 2)
  assert.equal(records[0]?.arbiter, 'mimo')
  assert.equal(kindChip(records[0]?.kind), 'vision')
  // 2026-08-22 验收改判:原断言是 '评审',那把一个猜测写成了预期。台账里实测有
  // 一条 kind 缺席却 hadImages:1 的记录 —— 猜成「评审」与同条记录自身的字段
  // 直接矛盾。缺席就说缺席(数据零编造)。
  assert.equal(kindChip(records[1]?.kind), '类型未采集')
  assert.deepEqual(panelOkCount(records[0]!), { ok: 1, total: 2 })
  assert.equal(collectedDisagreements(records[0]!).status, 'present')
})

test('坏行丢弃,非对象输入给空数组', () => {
  assert.deepEqual(parseVisionLedger(undefined), [])
  assert.deepEqual(parseVisionLedger({ records: 'oops' }), [])
  assert.deepEqual(parseVisionLedger({ records: [{ kind: 'vision' }, null, 42] }).length, 1)
})

test('缺字段给 undefined,不编造', () => {
  const [r] = parseVisionLedger({ records: [{ kind: 'vision' }] })
  assert.equal(r?.question, undefined)
  assert.equal(r?.verdict, undefined)
  assert.equal(r?.disagreements, undefined)
  assert.deepEqual(r?.flagged, [])
  assert.deepEqual(r?.panelists, [])
})

test('老格式记录不得产生任何分歧标记,不从 verdict 回填', () => {
  const [r] = parseVisionLedger({
    records: [{
      kind: 'vision',
      verdict: '描述\n\n分歧:第一家说 A;第二家说 B',
      panelists: [
        { provider: 'a', ok: true, text: 'line1\nline2' },
        { provider: 'b', ok: true, text: 'line1\nlineX' },
      ],
    }],
  })
  assert.ok(r)
  assert.equal(r.disagreements, undefined)
  assert.equal(collectedDisagreements(r).status, 'absent')
  assert.deepEqual(collectedDisagreements(r).items, [])
  assert.deepEqual(lineDivergenceMarks(r), [])
  const here = dirname(fileURLToPath(import.meta.url))
  const ledgerSrc = readFileSync(join(here, 'council-ledger-model.ts'), 'utf8')
  const cardSrc = readFileSync(join(here, '../chat/VisionArbiterCard.tsx'), 'utf8')
  assert.equal(ledgerSrc.includes('markDivergentLines'), false)
  assert.equal(cardSrc.includes('markDivergentLines'), false)
})

test('inconclusive records show the insufficient-answers banner, not an invented verdict', () => {
  const [r] = parseVisionLedger({
    records: [{
      kind: 'review',
      inconclusive: true,
      consensus: false,
      disagreements: [],
      verdict: '有效答案不足 0/2,无法交叉核验。失败原因见各行。',
      panelists: [{ provider: 'qwen', ok: false, error: '超时' }],
    }],
  })
  assert.ok(r)
  assert.equal(r.inconclusive, true)
  assert.equal(inconclusiveBanner(r), INCONCLUSIVE_COPY)
  assert.equal(inconclusiveBanner({ ...r, inconclusive: false }), undefined)
})
