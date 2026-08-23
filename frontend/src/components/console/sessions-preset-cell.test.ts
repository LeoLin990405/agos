import assert from 'node:assert/strict'
import test from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { presetCell } from './SessionsView.tsx'

test('presetCell:preset 在场就用 preset;缺席才回落 descriptor label;两者都缺 → 未采集;长 label 截断并保留 title', () => {
  assert.equal(presetCell('cordis', 'council:stepfun'), 'cordis')
  assert.equal(presetCell('', undefined), '未采集')
  assert.equal(presetCell('', ''), '未采集')
  const html = renderToStaticMarkup(React.createElement(React.Fragment, null, presetCell('', 'council:stepfun')))
  assert.match(html, /title="council:stepfun"/)
  assert.match(html, /council:stepfun.*子代理标签/)
  const long = '两个并行小任务：hostname 与幂等性解释 #2 (reason) 再加一段很长的说明文字'
  const h2 = renderToStaticMarkup(React.createElement(React.Fragment, null, presetCell('', long)))
  assert.ok(h2.includes(`title="${long}"`))
  assert.match(h2, /…/)
})
