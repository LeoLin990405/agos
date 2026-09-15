import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  HistoryIntegrity,
  historyIntegrityCopy,
  historyIntegrityVisible,
} from './HistoryIntegrity.tsx'

test('complete window renders nothing', () => {
  assert.equal(historyIntegrityVisible({ historyIncomplete: false, retryable: false }), false)
  const html = renderToStaticMarkup(React.createElement(HistoryIntegrity, {
    historyIncomplete: false,
  }))
  assert.equal(html, '')
})

test('incomplete banner offers load-earlier and never claims the window is the full session', () => {
  const copy = historyIntegrityCopy({ retryable: false })
  assert.match(copy.banner, /当前窗口不是完整会话/)
  assert.equal(copy.action, '加载更早的历史')

  let clicked = 0
  const html = renderToStaticMarkup(React.createElement(HistoryIntegrity, {
    historyIncomplete: true,
    hasMore: true,
    onLoadEarlier: () => { clicked += 1 },
  }))
  assert.match(html, /role="status"/)
  assert.match(html, /当前窗口不是完整会话，还有更早的历史/)
  assert.match(html, /加载更早的历史/)
  assert.match(html, /data-history-incomplete="true"/)
  assert.doesNotMatch(html, /完整历史已加载/)
  assert.equal(clicked, 0)
})

test('page failure banner is retryable and keeps the incomplete warning', () => {
  const copy = historyIntegrityCopy({ retryable: true, error: 'gateway 502' })
  assert.match(copy.banner, /更早的历史未能加载：gateway 502/)
  assert.match(copy.banner, /当前窗口不是完整会话/)
  assert.equal(copy.action, '重试')

  const html = renderToStaticMarkup(React.createElement(HistoryIntegrity, {
    historyIncomplete: true,
    retryable: true,
    error: 'gateway 502',
    onRetry: () => undefined,
  }))
  assert.match(html, /role="alert"/)
  assert.match(html, /gateway 502/)
  assert.match(html, />重试</)
  assert.match(html, /data-history-retryable="true"/)
})

test('HistoryIntegrity stays presentational: no router, no ReplayScrubber reconstruction claim', () => {
  const here = dirname(fileURLToPath(import.meta.url))
  const src = readFileSync(join(here, 'HistoryIntegrity.tsx'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^[ \t]*\/\/.*$/gm, ' ')
  assert.doesNotMatch(src, /react-router|createBrowserRouter|useNavigate|useParams/)
  assert.doesNotMatch(src, /conversationStore|openConversation|agos\.call/)
  assert.doesNotMatch(src, /历史重建|重建历史|historical reconstruction/)
})
