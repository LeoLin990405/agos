import assert from 'node:assert/strict'
import test from 'node:test'
import {
  consumeNewSessionRequest,
  NEW_SESSION_EVENT,
  requestNewSession,
} from './new-session-intent.ts'

test('requestNewSession 留下待消费标记,consume 只读一次', () => {
  assert.equal(consumeNewSessionRequest(), false)
  requestNewSession()
  assert.equal(consumeNewSessionRequest(), true)
  assert.equal(consumeNewSessionRequest(), false)
})

test('rail / 顶栏 / ChatPage 共用同一事件名', () => {
  assert.equal(NEW_SESSION_EVENT, 'agos:new-session')
})
