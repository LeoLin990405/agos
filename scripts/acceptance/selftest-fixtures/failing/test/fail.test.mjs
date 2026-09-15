// 负控固件:故意失败。验收器必须让它保持失败(JSON 里 verdict=fail,进程退出码非零)。
import test from 'node:test'
import assert from 'node:assert/strict'
test('deliberately failing control', () => { assert.equal(1, 2, 'this control MUST fail') })
test('passing sibling', () => { assert.equal(1, 1) })
