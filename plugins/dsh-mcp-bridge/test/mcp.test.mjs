import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createMcpHandler, createMcpRuntime, MCP_PROTOCOL_VERSION } from '../lib/index.js'

async function harness(t, options = {}) {
  const runtime = createMcpRuntime({}, options)
  const handler = createMcpHandler(runtime)
  const server = createServer((req, res) => handler(req, res))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())))
  const origin = `http://127.0.0.1:${server.address().port}`
  const call = async (body, accept = 'application/json') => {
    const response = await fetch(`${origin}/mcp`, {
      method: 'POST', headers: { 'content-type': 'application/json', accept }, body: JSON.stringify(body),
    })
    return { response, text: await response.text() }
  }
  return { call }
}

const request = (id, method, params) => ({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) })

test('initialize is emitted as one MCP SSE protocol frame', async (t) => {
  const { call } = await harness(t, { readSessions: async () => ({ sessions: [] }), prompt: async () => ({}) })
  const { response, text } = await call(request(1, 'initialize', {
    protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'fixture', version: '1' },
  }), 'text/event-stream')
  assert.match(response.headers.get('content-type'), /^text\/event-stream/)
  assert.match(text, /^event: message\ndata: /)
  const frame = JSON.parse(text.split('data: ')[1])
  assert.equal(frame.result.protocolVersion, MCP_PROTOCOL_VERSION)
  assert.equal(frame.result.serverInfo.name, 'dsh-mcp-bridge')
})

test('tools/list exposes the five bounded tools and warns that prompt burns quota', async (t) => {
  const { call } = await harness(t, { readSessions: async () => ({ sessions: [] }), prompt: async () => ({}) })
  const { text } = await call(request(2, 'tools/list'))
  const body = JSON.parse(text)
  assert.deepEqual(body.result.tools.map((tool) => tool.name), [
    'agos_sessions', 'agos_prompt', 'agos_result', 'agos_swarm_status', 'agos_memory_search',
  ])
  assert.match(body.result.tools.find((tool) => tool.name === 'agos_prompt').description, /ONLY.*model.*quota/i)
})

test('tools/call agos_sessions reads a fixture projcache through /mcp', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-mcp-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const file = join(root, 'session_projcache.json')
  await writeFile(file, JSON.stringify({ tables: { sessions: {
    'session-new': { identity: { cwd: '/work/new', createdAt: 20 }, rows: { title: { val: 'New' }, sessionListMetadata: { val: { updatedAt: 30 } } } },
    'session-old': { identity: { cwd: '/work/old', createdAt: 10 }, rows: { title: { val: 'Old' } } },
  } } }))
  const { call } = await harness(t, { projcache: file, prompt: async () => ({}) })
  const { text } = await call(request(3, 'tools/call', { name: 'agos_sessions', arguments: {} }))
  const body = JSON.parse(text)
  const value = JSON.parse(body.result.content[0].text)
  assert.deepEqual(value.sessions.map((session) => session.session_id), ['session-new', 'session-old'])
  assert.deepEqual(value.sessions[0], {
    session_id: 'session-new', title: 'New', cwd: '/work/new', created_at: 20, updated_at: 30,
  })
})

test('prompt is intercepted and memory search goes through /api/memory/search (BM25), stripping non-contract fields', async (t) => {
  const prompts = []
  const internalJson = async (path) => {
    assert.equal(path, '/api/memory/search?q=alpha&limit=50')
    return { at: 1, query: 'alpha', results: [
      { slug: 'project_alpha', description: 'Alpha bridge', score: 0.03, matchedBy: ['bm25'], body: 'NEVER' },
    ] }
  }
  const { call } = await harness(t, {
    readSessions: async () => ({ sessions: [] }),
    prompt: async (args) => { prompts.push(args); return { session_id: 'fake-session', accepted: true, created: true } },
    internalJson,
  })
  const prompted = JSON.parse((await call(request(4, 'tools/call', {
    name: 'agos_prompt', arguments: { cwd: '/tmp/fixture', text: 'offline only' },
  }))).text)
  assert.deepEqual(prompts, [{ cwd: '/tmp/fixture', text: 'offline only' }])
  assert.equal(JSON.parse(prompted.result.content[0].text).session_id, 'fake-session')

  const searched = JSON.parse((await call(request(5, 'tools/call', {
    name: 'agos_memory_search', arguments: { q: 'alpha' },
  }))).text)
  assert.deepEqual(JSON.parse(searched.result.content[0].text).nodes, [
    { id: 'project_alpha', description: 'Alpha bridge', type: '', score: 0.03, matchedBy: ['bm25'] },
  ])
  assert.doesNotMatch(searched.result.content[0].text, /NEVER/)

  // 201 字的查询在桥接里就被拦下,不会打到路由(路由对 >200 返回 400,会变成 throw)。
  const tooLong = JSON.parse((await call(request(6, 'tools/call', {
    name: 'agos_memory_search', arguments: { q: 'x'.repeat(201) },
  }))).text)
  assert.ok(tooLong.error !== undefined || tooLong.result?.isError === true, JSON.stringify(tooLong).slice(0, 200))
})
