import assert from 'node:assert/strict'
import test from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { presetCell, shortenLabel } from './SessionsView.tsx'

test('presetCell:preset 在场就用 preset;打开过才回落 label;三种「没有」分得清;截断保头保尾', () => {
  assert.equal(presetCell('cordis', { opened: true, label: 'council:stepfun' }), 'cordis')
  assert.equal(presetCell('', { opened: true, label: undefined }), '未采集')
  assert.equal(presetCell('', { opened: true, label: '' }), '未采集')
  const unopened = renderToStaticMarkup(React.createElement(React.Fragment, null, presetCell('', { opened: false })))
  assert.match(unopened, /未采集（未打开）/)
  const html = renderToStaticMarkup(React.createElement(React.Fragment, null, presetCell('', { opened: true, label: 'council:stepfun' })))
  assert.match(html, /title="council:stepfun"/)
  assert.match(html, /council:stepfun.*子代理标签/)
  // 同批子代理靠尾缀区分:保头保尾,两个只差尾缀的 label 截断后仍不同。
  const a = '两个并行小任务：hostname 与幂等性解释 #1 (coder)'
  const b = '两个并行小任务：hostname 与幂等性解释 #2 (reason)'
  assert.notEqual(shortenLabel(a), shortenLabel(b))
  assert.match(shortenLabel(a), /…/)
  assert.match(shortenLabel(a), /#1 \(coder\)$/)
  assert.equal(shortenLabel('短'), '短')
})
