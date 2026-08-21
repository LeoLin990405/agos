/** W4 分歧视图对照逻辑测试(纯文本,零模型)。 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  consensusQuorum, countDivergentLines, isComparableLine, markDivergentLines, normalizeAnswerLine,
} from './vision-diff.ts'

test('归一化:去全部空白 + 拉丁小写', () => {
  assert.equal(normalizeAnswerLine('  值班  表  '), '值班表')
  assert.equal(normalizeAnswerLine('Hello  WORLD'), 'helloworld')
})

test('过短行不参与判定', () => {
  assert.equal(isComparableLine('好的'), false)
  assert.equal(isComparableLine('这一行足够长'), true)
})

test('quorum:2-3 家需 2 家共识,4-5 家需 3 家', () => {
  assert.equal(consensusQuorum(2), 2)
  assert.equal(consensusQuorum(3), 2)
  assert.equal(consensusQuorum(4), 3)
  assert.equal(consensusQuorum(5), 3)
})

test('三家对照:独有行标分歧,共享行不标', () => {
  const a = '图上是值班表\n有 5 个人名\n颜色以蓝色为主'
  const b = '图上是值班表\n有 5 个人名\n我以为是日历界面'
  const c = '图上是值班表\n有 5 个人名\n颜色以蓝色为主'
  const marked = markDivergentLines([a, b, c])
  assert.equal(marked[0]?.map((l) => l.divergent).join(','), 'false,false,false')
  assert.equal(marked[1]?.[2]?.divergent, true)
  assert.equal(countDivergentLines(marked), 1)
})

test('少于 2 家有效文本时全部不标(没有对照面)', () => {
  const marked = markDivergentLines(['唯一的一家答案文本很长', undefined, ''])
  assert.equal(countDivergentLines(marked), 0)
})

test('归一化后相同的行算共识(空白差异不制造假分歧)', () => {
  const a = '图上  是值班表没错的\n独有的一家之言在此'
  const b = '图上是值班表没错的'
  const marked = markDivergentLines([a, b])
  assert.equal(marked[0]?.[0]?.divergent, false)
  assert.equal(marked[0]?.[1]?.divergent, true)
})

test('重复行不会因位置串位(每处独立判定)', () => {
  const a = '共同的一句话在此没错\n独有的甲方观点比较长\n共同的一句话在此没错\n独有的乙方观点比较长'
  const b = '共同的一句话在此没错'
  const marked = markDivergentLines([a, b])
  assert.equal(marked[0]?.map((l) => l.divergent).join(','), 'false,true,false,true')
})
