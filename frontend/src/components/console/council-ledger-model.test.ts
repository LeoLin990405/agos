/** 读图台账模型测试(纯解析,零网络零模型)。 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { panelOkCount, parseVisionLedger } from './council-ledger-model.ts'

test('只收 kind=vision 的记录,评审记录(无 kind)剔除', () => {
  const records = parseVisionLedger({
    records: [
      {
        kind: 'vision', time: '2026-08-21T10:00:00Z', question: '[图] a.png',
        arbiter: 'mimo', parsedOk: true, verdict: '图上是值班表',
        flagged: ['doubao'],
        panelists: [
          { provider: 'qwen', ok: true, ms: 1200, text: '值班表' },
          { provider: 'doubao', ok: false, ms: 900, error: '超时' },
        ],
      },
      { time: '2026-08-21T09:00:00Z', question: '文字评审', panelists: [] },
    ],
  })
  assert.equal(records.length, 1)
  assert.equal(records[0]?.arbiter, 'mimo')
  assert.equal(records[0]?.flagged[0], 'doubao')
  assert.deepEqual(panelOkCount(records[0]!), { ok: 1, total: 2 })
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
  assert.deepEqual(r?.flagged, [])
  assert.deepEqual(r?.panelists, [])
})
