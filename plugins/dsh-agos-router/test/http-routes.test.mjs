// 只读端点经 apply() 注册后用假 req/res 直接打。零网络、零模型调用。
// 这条测试存在的理由:index.js 里 `export { x } from` 不等于 import,闭包里用到的名字只有真跑到才知道缺不缺。
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../lib/index.js'

function fakeCtx() {
  const routes = new Map()
  const ctx = {
    logger: () => ({ warn() {}, info() {} }),
    llm: undefined,
    inject(names, cb) {
      if (names.includes('webServer')) {
        cb({ get: (n) => (n === 'webServer' ? { register: (r) => { routes.set(r.path, r.handler); return () => routes.delete(r.path) } } : undefined) })
      }
    },
  }
  return { ctx, routes }
}
async function call(handler, method, url) {
  let status; let body
  const res = { statusCode: 0, setHeader() {}, writeHead(s) { status = s }, end(b) { body = b } }
  await handler({ method, url, headers: {}, on() {} }, res)
  return { status, body: body ? JSON.parse(body) : undefined }
}

test('apply() 注册的 GET /api/agos/routes 与 /routes/outcomes 真跑一遍:posterior 分母、七字段行、覆盖表', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agos-http-'))
  const audit = join(dir, 'route-outcome.jsonl')
  await writeFile(audit, [
    { id: 'dec-1', ts: 1, taskType: 'reviewer', role: 'reviewer', pick: 'MiniMax-M3', label: 'reviewer', outcome: null, source: 'fallback' },
    { kind: 'outcome', ref: 'dec-1', result: 'ok', at: 2, source: 'test' },
    { id: 'dec-2', ts: 3, taskType: 'planner', role: 'planner', pick: 'glm-5.2', label: 'planner', outcome: null, source: 'fallback' },
  ].map((r) => JSON.stringify(r)).join('\n') + '\n')
  const { ctx, routes } = fakeCtx()
  apply(ctx, { auditFile: audit, provider: '', model: '' })
  await new Promise((r) => setTimeout(r, 20))
  assert.ok(routes.has('/api/agos/routes'), '路由未注册: ' + [...routes.keys()].join(','))
  assert.ok(routes.has('/api/agos/routes/outcomes'))

  const listed = await call(routes.get('/api/agos/routes'), 'GET', '/api/agos/routes?limit=10')
  assert.equal(listed.status, 200)
  assert.equal(listed.body.stats.total, 2)
  assert.deepEqual(listed.body.stats.posterior, { observations: 1, cells: 1 })

  const outcomes = await call(routes.get('/api/agos/routes/outcomes'), 'GET', '/api/agos/routes/outcomes')
  assert.equal(outcomes.status, 200)
  assert.ok(Array.isArray(outcomes.body.rows))
  const route = outcomes.body.rows.filter((r) => r.kind === 'route')
  assert.equal(route.length, 2)
  assert.deepEqual(route.map((r) => [r.ref, r.agent, r.result]), [['dec-1', 'minimax-m3', 'ok'], ['dec-2', 'glm-5.2', null]])
  assert.equal(outcomes.body.grid.byKind.route, 2)
  const onlyCiv = await call(routes.get('/api/agos/routes/outcomes'), 'GET', '/api/agos/routes/outcomes?kind=civ')
  assert.ok(onlyCiv.body.rows.every((r) => r.kind === 'civ'))
  const bad = await call(routes.get('/api/agos/routes/outcomes'), 'POST', '/api/agos/routes/outcomes')
  assert.equal(bad.status, 405)
})
