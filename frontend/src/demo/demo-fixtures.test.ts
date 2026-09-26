import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sessionFollowFrameSchema, sessionListValueSchema } from '../contract/api/sessions.schema.ts'
import { parseMemoryGraph } from '../pages/memory-graph-api.ts'
import { DEMO_SESSIONS, DEMO_TAG, demoFollowSnapshot, demoSessionList } from './demo-fixtures.ts'
import { demoMemoryGraph } from './demo-rest.ts'
import { demoFetchHandler } from './demo-transport.ts'

test('demo session list parses through the frozen session/list schema', () => {
  assert.doesNotThrow(() => sessionListValueSchema.parse(demoSessionList()))
})

test('every demo snapshot and live event parses through session/follow schema', () => {
  for (const s of DEMO_SESSIONS) {
    assert.doesNotThrow(() => sessionFollowFrameSchema.parse(demoFollowSnapshot(s)))
    for (const event of s.live) assert.doesNotThrow(() => sessionFollowFrameSchema.parse({ type: 'event', event }))
  }
})

test('every demo session is visibly labelled as sample data', () => {
  for (const s of DEMO_SESSIONS) {
    assert.ok(s.sessionId.startsWith('demo-'))
    assert.ok(s.title.startsWith(DEMO_TAG))
  }
})

test('demo memory graph passes the strict memory graph parser', () => {
  const g = parseMemoryGraph(demoMemoryGraph())
  assert.ok(g.nodes.every((n) => n.description.startsWith(DEMO_TAG)))
})

test('demo transport is read-only and never invents un-fixtured data', async () => {
  const write = demoFetchHandler(new URL('http://x/api/fleet/dispatch'), 'POST', '{}')
  assert.equal(write?.status, 403)
  const missing = demoFetchHandler(new URL('http://x/api/usage/providers'), 'GET', undefined)
  assert.equal(missing?.status, 503)
  const rpc = demoFetchHandler(new URL('http://x/api/session/create'), 'POST', JSON.stringify({ type: 'client-request', rpcId: 'r', method: 'session/create', payload: { args: {} } }))
  const body = await rpc?.json() as { result: { ok: boolean, error: { code: string } } }
  assert.equal(body.result.ok, false)
  assert.equal(body.result.error.code, 'DEMO_NOT_COLLECTED')
})
