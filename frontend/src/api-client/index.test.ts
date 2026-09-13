import assert from 'node:assert/strict'
import test from 'node:test'
import { createAgosClient } from './index.ts'

type Captured = { url: string, body: Record<string, unknown> }

function okResponse(rpcId: unknown, value: unknown): Response {
  return new Response(JSON.stringify({
    type: 'server-response',
    rpcId,
    result: { ok: true, value },
  }), { status: 200, headers: { 'content-type': 'application/json' } })
}

function clientCapturing(onPost: (captured: Captured) => Response) {
  return createAgosClient({
    baseUrl: 'http://agos.test',
    doFetch: async (input, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      return onPost({ url: String(input), body })
    },
  })
}

function argsOf(body: Record<string, unknown>): Record<string, unknown> {
  const payload = body.payload
  assert.ok(payload !== null && typeof payload === 'object' && !Array.isArray(payload))
  const args = (payload as { args?: unknown }).args
  assert.ok(args !== null && typeof args === 'object' && !Array.isArray(args))
  return args as Record<string, unknown>
}

test('settings/mutate 把 ns/ops/expectedRevision 铺在 args 上,不包 request', async () => {
  const payload = {
    ns: 'permission',
    ops: [{ op: 'set' as const, path: ['defaultPreset'], value: 'workspace-write' }],
    expectedRevision: 4,
  }
  const view = {
    ns: 'permission',
    schema: {},
    value: { defaultPreset: 'workspace-write' },
    applies: 'live' as const,
    secrets: [],
    revision: 5,
  }
  let captured: Captured | undefined
  const client = clientCapturing((post) => {
    captured = post
    return okResponse(post.body.rpcId, view)
  })

  const response = await client.call('settings/mutate', payload)
  assert.equal(response.result.ok, true)
  assert.ok(captured)
  assert.match(captured.url, /\/api\/settings\/mutate$/)
  const args = argsOf(captured.body)
  assert.deepEqual(args, payload)
  assert.equal(Object.hasOwn(args, 'request'), false)
})

test('session/create 仍按单参数 request 包装', async () => {
  let captured: Captured | undefined
  const client = clientCapturing((post) => {
    captured = post
    return okResponse(post.body.rpcId, { sessionId: 'sess-1' })
  })

  const response = await client.call('session/create', { cwd: '/tmp/agos' })
  assert.equal(response.result.ok, true)
  assert.ok(captured)
  assert.deepEqual(argsOf(captured.body), { request: { cwd: '/tmp/agos' } })
})

test('settings/describe 零参数方法的 args 仍是空对象', async () => {
  let captured: Captured | undefined
  const client = clientCapturing((post) => {
    captured = post
    return okResponse(post.body.rpcId, { writable: true, hasDocument: false, namespaces: [] })
  })

  const response = await client.call('settings/describe', {})
  assert.equal(response.result.ok, true)
  assert.ok(captured)
  assert.deepEqual(argsOf(captured.body), {})
})
