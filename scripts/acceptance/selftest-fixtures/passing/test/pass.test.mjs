// 元控制:证明验收器**能**报绿。否则一个永远报红的验收器会白拿全部负控分。
import test from 'node:test'
import assert from 'node:assert/strict'
test('genuinely passing control', () => { assert.equal(2 + 2, 4) })
