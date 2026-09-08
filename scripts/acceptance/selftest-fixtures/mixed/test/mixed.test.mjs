// 负控固件:pass + skip 混合。断言 skip 不被算进 pass。
import test from 'node:test'
import assert from 'node:assert/strict'
test('real pass', () => { assert.ok(true) })
test('real skip', { skip: 'negative control' }, () => {})
test('another real pass', () => { assert.ok(true) })
