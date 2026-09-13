import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createNamedSession,
  normalizeSessionTitle,
  statWorkspacePath,
  validateSessionCwdShape,
  workspaceStatError,
} from './session-create.ts'

test('normalizeSessionTitle: 空白丢弃,过长截断', () => {
  assert.equal(normalizeSessionTitle(''), undefined)
  assert.equal(normalizeSessionTitle('   '), undefined)
  assert.equal(normalizeSessionTitle(' 验收会话A '), '验收会话A')
  assert.equal(normalizeSessionTitle('x'.repeat(201))?.length, 200)
})

test('validateSessionCwdShape: 只收绝对路径', () => {
  assert.deepEqual(validateSessionCwdShape('/Users/leo/Projects/agos'), { ok: true, cwd: '/Users/leo/Projects/agos' })
  assert.equal(validateSessionCwdShape('').ok, false)
  assert.equal(validateSessionCwdShape('Projects/agos').ok, false)
  assert.equal(validateSessionCwdShape('foo\0bar').ok, false)
})

test('workspaceStatError: 缺失或文件都拒绝', () => {
  assert.equal(workspaceStatError({ exists: true, isDirectory: true }), undefined)
  assert.equal(workspaceStatError({ exists: false, isDirectory: false }), '工作目录不存在')
  assert.equal(workspaceStatError({ exists: true, isDirectory: false }), '工作目录必须是目录')
  assert.equal(workspaceStatError({ error: '无法核验工作目录' }), '无法核验工作目录')
})

test('statWorkspacePath: 走真实路由并解析布尔字段', async () => {
  const calls: { path: string, body?: unknown }[] = []
  const result = await statWorkspacePath('/tmp/agos', async (path, init) => {
    calls.push({ path, body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined })
    return new Response(JSON.stringify({ exists: false, isDirectory: false }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  })
  assert.deepEqual(calls, [{ path: '/api/agos/workspace-stat', body: { path: '/tmp/agos' } }])
  assert.deepEqual(result, { exists: false, isDirectory: false })
})

test('createNamedSession: 非法 cwd 不调用 create', async () => {
  let created = 0
  const result = await createNamedSession(
    { cwd: '/no/such/agos-cwd', title: '验收会话A-无效目录' },
    {
      statWorkspace: async () => ({ exists: false, isDirectory: false }),
      createSession: async () => { created += 1; return 'session-x' },
      renameSession: async () => ({ ok: true, title: '验收会话A-无效目录' }),
    },
  )
  assert.deepEqual(result, { ok: false, error: '工作目录不存在' })
  assert.equal(created, 0)
})

test('createNamedSession: 主题经 rename 写入,create 信封不带 title', async () => {
  const creates: unknown[] = []
  const renames: unknown[] = []
  const result = await createNamedSession(
    { cwd: '/Users/leo/Projects/agos', title: '验收会话A', agentPreset: 'cordis' },
    {
      statWorkspace: async () => ({ exists: true, isDirectory: true }),
      createSession: async (params) => { creates.push(params); return 'session-new' },
      renameSession: async (sessionId, title) => {
        renames.push({ sessionId, title })
        return { ok: true, title }
      },
    },
  )
  assert.deepEqual(result, { ok: true, sessionId: 'session-new', title: '验收会话A' })
  assert.deepEqual(creates, [{ cwd: '/Users/leo/Projects/agos', agentPreset: 'cordis' }])
  assert.deepEqual(renames, [{ sessionId: 'session-new', title: '验收会话A' }])
})

test('createNamedSession: rename 失败仍交回主题,供侧栏覆盖', async () => {
  const result = await createNamedSession(
    { cwd: '/Users/leo/Projects/agos', title: '验收会话B' },
    {
      statWorkspace: async () => ({ exists: true, isDirectory: true }),
      createSession: async () => 'session-b',
      renameSession: async () => ({ ok: false, error: 'busy' }),
    },
  )
  assert.deepEqual(result, { ok: true, sessionId: 'session-b', title: '验收会话B' })
})
