// 负控固件:全部 skip。skip 必须报成 skip,绝不并入 pass。
import test from 'node:test'
test('skipped one', { skip: 'negative control: intentionally skipped' }, () => {})
test('skipped two', { skip: 'negative control: intentionally skipped' }, () => {})
