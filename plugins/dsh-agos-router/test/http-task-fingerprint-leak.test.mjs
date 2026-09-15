// 写路径的响应体不得回显任务原文或其指纹。
//
// 由来:Kimi 本轮把 GET 视图的指纹剥干净了(publicizeDecision 删 task + taskRef),
// 其独立复核员随即指出 `POST /api/agos/routes/decide` 与 `POST …/assemble`
// 仍直接返回原始台账行 —— 那两个 handler 在 lib/index.js 里,属主控所有权,
// 所以留成了「低危残留」。这份测试把它变成不变量。
//
// 为什么要剥:taskRef 是任务全文的 sha256。一旦客户端能拿到它,
//   · GET /routes 就成了确认预言机(拿 hash 反复试探任务内容);
//   · 更糟的是,客户端能把这个 hash 原样回灌,把一条 unverified 的手工绑定
//     说成 verified —— 绑定判定必须只在服务端做,公开行两样都不该有。
// 前端从不读 taskRef(全仓零匹配),也从不 POST decide(routes-assemble.ts:534
// 有全仓扫描留下的说明),所以剥掉不影响任何生产消费方。
//
// 全部走真实 HTTP handler + 临时台账文件,不碰真实台账、不调真实模型。

import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { apply } from '../lib/index.js'

const TASK = '把这段任务原文写进台账，它的 sha256 绝不能出现在任何响应体里'

function fakeCtx() {
  const routes = new Map()
  const ctx = {
    logger: () => ({ warn() {}, info() {} }),
    inject(names, cb) {
      if (names.includes('webServer')) {
        cb({ get: (n) => (n === 'webServer'
          ? { register: (r) => { routes.set(r.path, r.handler); return () => routes.delete(r.path) } }
          : undefined) })
      }
    },
  }
  return { ctx, routes }
}

async function call(handler, method, url, payload) {
  let status
  let body
  const res = { statusCode: 0, setHeader() {}, writeHead(s) { status = s }, end(b) { body = b } }
  const req = {
    method,
    url,
    headers: payload === undefined ? {} : { 'content-type': 'application/json' },
    on(event, cb) {
      if (payload === undefined) { if (event === 'end') cb(); return }
      if (event === 'data') cb(Buffer.from(JSON.stringify(payload)))
      if (event === 'end') cb()
    },
  }
  await handler(req, res)
  return { status, raw: body, body: body ? JSON.parse(body) : undefined }
}

async function boot(t) {
  const dir = await mkdtemp(join(tmpdir(), 'agos-router-leak-'))
  assert.ok(dir.startsWith(tmpdir()), '只用临时台账,不碰真实台账')
  t.after(async () => { await rm(dir, { recursive: true, force: true }) })
  const audit = join(dir, 'audit.jsonl')
  const { ctx, routes } = fakeCtx()
  apply(ctx, { auditFile: audit, provider: '', model: '' })
  await new Promise((resolve) => setTimeout(resolve, 20))
  return { routes, audit }
}

/** 递归找出对象里任何位置的 task / taskRef 键。 */
function findForbiddenKeys(value, path = '$', hits = []) {
  if (Array.isArray(value)) {
    value.forEach((item, i) => findForbiddenKeys(item, `${path}[${i}]`, hits))
    return hits
  }
  if (value === null || typeof value !== 'object') return hits
  for (const [key, inner] of Object.entries(value)) {
    if (key === 'task' || key === 'taskRef') hits.push(`${path}.${key}`)
    findForbiddenKeys(inner, `${path}.${key}`, hits)
  }
  return hits
}

test('POST /routes/decide 的响应体不含 task 原文,也不含 taskRef 指纹', async (t) => {
  const { routes, audit } = await boot(t)
  const handler = routes.get('/api/agos/routes/decide')
  assert.equal(typeof handler, 'function', '缺 decide 路由')

  const res = await call(handler, 'POST', '/api/agos/routes/decide', {
    task: TASK, taskType: 'coding', role: 'implementer',
  })
  assert.equal(res.status, 200, `decide 应成功，实际 ${res.status}: ${res.raw}`)

  assert.deepEqual(findForbiddenKeys(res.body), [], 'decide 响应里出现了 task / taskRef')
  assert.doesNotMatch(res.raw, /taskRef/, '连键名都不该出现')
  assert.doesNotMatch(res.raw, new RegExp(TASK.slice(0, 12)), '任务原文片段不该出现在响应里')

  // 落盘的台账**仍要**有指纹 —— 剥的是响应,不是服务端判定依据。
  const ledger = await readFile(audit, 'utf8')
  assert.match(ledger, /"taskRef":/, '台账必须仍记指纹,否则绑定判定就没了依据')
})

test('POST /routes/assemble 与 /routes/shadow 同样不回显指纹', async (t) => {
  const { routes } = await boot(t)
  const cases = [
    ['/api/agos/routes/assemble', { task: TASK, confirm: true }],
    ['/api/agos/routes/shadow', { task: TASK, taskType: 'coding', role: 'implementer' }],
  ]
  for (const [path, payload] of cases) {
    const handler = routes.get(path)
    assert.equal(typeof handler, 'function', `缺路由 ${path}`)
    const res = await call(handler, 'POST', path, payload)
    // 这些端点在无选择器时可能以 4xx 拒绝 —— 无论成败,都不许回显指纹。
    assert.deepEqual(findForbiddenKeys(res.body), [], `${path} 响应里出现了 task / taskRef`)
    assert.doesNotMatch(res.raw ?? '', /taskRef/, `${path} 连键名都不该出现`)
  }
})

test('GET 视图早已不回显(回归钉:Kimi 本轮的成果不许被后来的改动吃掉)', async (t) => {
  const { routes } = await boot(t)
  const decide = routes.get('/api/agos/routes/decide')
  await call(decide, 'POST', '/api/agos/routes/decide', {
    task: TASK, taskType: 'coding', role: 'implementer',
  })

  const list = routes.get('/api/agos/routes')
  const res = await call(list, 'GET', '/api/agos/routes?limit=50')
  assert.equal(res.status, 200)
  assert.deepEqual(findForbiddenKeys(res.body), [], 'GET /routes 已被剥过,不许回归')
  assert.doesNotMatch(res.raw, /taskRef/)
})

test('剥字段没把有用信息一起剥掉(否则就是用功能换安全)', async (t) => {
  const { routes } = await boot(t)
  const res = await call(routes.get('/api/agos/routes/decide'), 'POST', '/api/agos/routes/decide', {
    task: TASK, taskType: 'coding', role: 'implementer',
  })
  // 决策行的可用字段必须还在:调用方要靠它们知道选了谁、凭什么、记在哪一行。
  for (const key of ['id', 'pick', 'role']) {
    assert.ok(res.body[key] !== undefined, `响应缺少必要字段 ${key},剥得过头了`)
  }
})
