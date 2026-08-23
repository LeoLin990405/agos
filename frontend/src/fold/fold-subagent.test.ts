import assert from 'node:assert/strict'
import test from 'node:test'
import { foldJsonl } from './fold.ts'

// 夹具照语料真实形状:session 行 + 扁平 data.label 的 descriptor(version 2, provider spawn)。
const SESSION = '{"type":"session","id":"session-x","cwd":"/tmp","createdAt":1,"origin":"subagent","parentSession":"session-p","delegationDepth":1}'
const desc = (data: Record<string, unknown>): string => JSON.stringify({ type: 'subagent/descriptor', seq: 5, time: 2, data })

test('subagent/descriptor 的 label 进 header.subagentLabel,且不再被计进 ignored', () => {
  const folded = foldJsonl([SESSION, desc({ version: 2, mode: 'one-shot', provider: 'spawn', label: 'council:stepfun' })].join('\n'))
  assert.equal(folded.header?.subagentLabel, 'council:stepfun')
  assert.equal(folded.diagnostics.ignored['subagent/descriptor'], undefined)
  assert.deepEqual(folded.diagnostics.unknown, {})
})

test('没有 descriptor → undefined;one-shot 无 label → undefined(不回落成 mode / provider)', () => {
  assert.equal(foldJsonl(SESSION).header?.subagentLabel, undefined)
  const noLabel = foldJsonl([SESSION, desc({ version: 2, mode: 'one-shot', provider: 'spawn' })].join('\n'))
  assert.equal(noLabel.header?.subagentLabel, undefined)
  assert.deepEqual(noLabel.diagnostics.unknown, {})
})

test('header 序列化不因新字段多出键:undefined 被 JSON 丢掉(金标 G1 逐字不变的依据)', () => {
  const folded = foldJsonl(SESSION)
  assert.equal(JSON.stringify(folded.header).includes('subagentLabel'), false)
})
