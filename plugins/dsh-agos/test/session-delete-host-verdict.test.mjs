// 会话删除的**生产接线**判据测试。
//
// 为什么单独一份:上一轮 test/session-management.test.mjs 只测注入版判据
// (readRunning/readAttached 由测试直接给),真实接线
//   readRunning:  (id) => runningFromContext(c, id)
//   readAttached: (id) => attachedFromContext(c, id)
// 一行都没被执行过。于是 attachedFromContext 里那句 host.describe 内调
// 在 0.1.2 把该方法删掉之后仍然「绿着」整整一轮 —— 测试测的是替身,不是货。
// 这份文件专测那两个函数本身,以及内调用的固定协议方法名。
//
// 不碰真实宿主:origin 与 fetch 全部注入,不发真实网络请求,不读个人会话。

import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import {
  ATTACHED_UNAVAILABLE_REASON,
  attachedFromContext,
  createAgosSessionManager,
  createAgosSessionRouteHandlers,
  runningFromContext,
  runningFromRpc,
} from '../lib/index.js'

const LIB = fileURLToPath(new URL('../lib/index.js', import.meta.url))

/** session/list 的成功信封,形状照抄固定宿主 e2e(apps/web/tests/preview-boot.e2e.ts)。 */
const listEnvelope = (items) => ({
  ok: true,
  status: 200,
  json: async () => ({ type: 'server-response', result: { ok: true, value: { items } } }),
})

/**
 * 会**校验信封形状**的假 gateway —— 上面那个 listEnvelope 不看请求,给什么都回成功。
 *
 * 为什么必须有这个:契约研究员复核时发现生产代码发的是 `payload: {}`,缺整个 args 层,
 * 在固定宿主上会被 gateway 拒掉 → 运行态永久 unavailable → 删除永久 503。而我原有的
 * 13 项测试全绿 —— 因为它们的假 fetch 只被断言了 url 和 method,请求体的其余部分
 * 根本没人看。测试对准了「方法名」一个维度,真实失败面还有「信封形状」这一维。
 *
 * 这里逐字实现固定宿主的两条谓词:
 *   · gateway/src/index.ts:950-953 —— payload 必须含**恰好一个** plain-object args 字段;
 *   · gateway/src/index.ts:1112-1137 assertExactArguments —— args 的键必须与 descriptor
 *     逐一对上,多了报 unexpected,少了报 missing。
 * 拒绝时的返回照抄宿主行为:HTTP **200** + `{ok:false, error:{code}}`(不是 4xx ——
 * gateway 捕获异常后仍走正常信封,这一点本身也值得钉住)。
 */
const gatewayFetch = (items, seen) => async (url, init) => {
  const body = JSON.parse(init.body)
  if (seen !== undefined) seen.push({ url: String(url), body })
  const bad = (code, message) => ({
    ok: true,
    status: 200,
    json: async () => ({ type: 'server-response', result: { ok: false, error: { code, message } } }),
  })
  const { payload } = body
  const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
  if (!isPlain(payload) || !Object.hasOwn(payload, 'args') || !isPlain(payload.args)
    || Reflect.ownKeys(payload).length !== 1) {
    return bad('gateway/invocation-unavailable',
      'Remote payload must contain exactly one plain-object args field')
  }
  const expected = new Set(['_request'])
  const actual = Reflect.ownKeys(payload.args)
  const extra = actual.filter((k) => typeof k !== 'string' || !expected.has(k))
  if (extra.length > 0) {
    return bad('gateway/arguments-invalid',
      `args fields do not match the descriptor: unexpected ${extra.map(String).join(', ')}`)
  }
  return listEnvelope(items)
}

// ── 挂载态:三态 + 权威谓词 ────────────────────────────────────────────────

test('挂载态用宿主同款谓词 ctx.sessions.get(id)!==undefined:在场即 attached', async () => {
  const ctx = { sessions: { get: (id) => (id === 'live-1' ? { id: 'live-1' } : undefined) } }
  assert.deepEqual(await attachedFromContext(ctx, 'live-1'), {
    available: true, attached: true, reason: null,
  })
  assert.deepEqual(await attachedFromContext(ctx, 'cold-1'), {
    available: true, attached: false, reason: null,
  })
  // ctx.get 路径应与直挂属性等价。
  assert.deepEqual(await attachedFromContext({ get: (k) => (k === 'sessions' ? ctx.sessions : undefined) }, 'live-1'), {
    available: true, attached: true, reason: null,
  })
})

test('ctx 不公开 sessions 时挂载态是 unavailable(不是「已分离」),并带上可诊断理由', async () => {
  for (const ctx of [{}, { get: () => undefined }, { sessions: {} }, { sessions: { get: 1 } }]) {
    const status = await attachedFromContext(ctx, 'any')
    assert.equal(status.available, false, JSON.stringify(ctx))
    assert.equal(status.attached, false)
    assert.equal(status.reason, ATTACHED_UNAVAILABLE_REASON)
  }
  // 理由必须点明「没有一元 RPC 能替代」,否则下一个人会再去发明一个假信号。
  assert.match(ATTACHED_UNAVAILABLE_REASON, /host\.describe 已删除/)
  assert.match(ATTACHED_UNAVAILABLE_REASON, /running 无法区分/)
})

test('ctx.sessions 取值抛错也算 unavailable,不被当成「已分离」', async () => {
  const ctx = { get() { throw new Error('service not ready') } }
  const status = await attachedFromContext(ctx, 'any')
  assert.equal(status.available, false)
  assert.equal(status.attached, false)
  assert.match(status.reason, /ctx\.sessions 抛错.*service not ready/)
})

// ── 运行态:ctx.agents 优先,session/list 兜底 ──────────────────────────────

test('运行态优先用宿主同款谓词 ctx.agents.get(id)?.status==="running"', async () => {
  const agents = new Map([['run-1', { status: 'running' }], ['idle-1', { status: 'idle' }]])
  const ctx = { agents: { get: (id) => agents.get(id) } }
  assert.equal((await runningFromContext(ctx, 'run-1')).running, true)
  assert.equal((await runningFromContext(ctx, 'idle-1')).running, false)
  assert.equal((await runningFromContext(ctx, 'absent')).running, false)
  assert.equal((await runningFromContext(ctx, 'run-1')).available, true)
})

test('取不到 ctx.agents 时落到 session/list 内调,并用固定协议的斜杠命名', async () => {
  const calls = []
  const status = await runningFromContext({}, 'run-1', {
    selfOrigin: 'http://127.0.0.1:7000',
    fetch: async (url, init) => {
      calls.push({ url: String(url), body: JSON.parse(init.body) })
      return listEnvelope([{ sessionId: 'run-1', running: true }])
    },
  })
  assert.deepEqual(status, { available: true, running: true, reason: null })
  assert.equal(calls.length, 1)
  // 回归钉:0.1.2 把点号换成斜杠。写回 session.list 会静默拿不到结果 → 删除永久 503。
  assert.equal(calls[0].url, 'http://127.0.0.1:7000/api/session/list')
  assert.equal(calls[0].body.method, 'session/list')
  assert.equal(calls[0].body.type, 'client-request')
  assert.ok(typeof calls[0].body.rpcId === 'string' && calls[0].body.rpcId.length > 0)
})

test('内调的信封形状按固定宿主 gateway 谓词校验:payload 必须是 {args:{_request:{}}}', async () => {
  // 这条走**会校验形状**的假 gateway。名字对、形状错的话它会像真宿主那样
  // 回 200 + ok:false,于是判定落到 unavailable —— 删除又变成永久 503。
  const seen = []
  const status = await runningFromRpc('run-1', {
    selfOrigin: 'http://127.0.0.1:7000',
    fetch: gatewayFetch([{ sessionId: 'run-1', running: true }], seen),
  })
  assert.deepEqual(status, { available: true, running: true, reason: null },
    `信封被固定宿主的谓词拒了:${status.reason ?? ''}`)
  // 直接钉形状,而不只是钉「结果对」——否则将来假 gateway 放松了就没人守。
  assert.deepEqual(seen[0].body.payload, { args: { _request: {} } })
  assert.equal(Reflect.ownKeys(seen[0].body.payload).length, 1, 'payload 只能有 args 一个字段')
})

test('负控:假 gateway 真的会拒错形状 —— 证明上一条不是摆设', async () => {
  // 不改生产代码,直接把三种错形状喂给同一个假 gateway,断言它们都被判 unavailable。
  // 这条是上一条的元证明:如果假 gateway 其实什么都放行,上一条永远绿,等于没测。
  for (const [label, payload] of [
    ['缺 args 层(生产代码原先就是这个)', {}],
    ['args 不是对象', { args: 'nope' }],
    ['args 键名错(request 而非 _request)', { args: { request: {} } }],
    ['payload 多带字段', { args: { _request: {} }, extra: 1 }],
  ]) {
    const status = await runningFromRpc('run-1', {
      selfOrigin: 'http://127.0.0.1:7000',
      fetch: async (url, init) => {
        const body = JSON.parse(init.body)
        body.payload = payload            // 覆盖成错形状,其余照原样
        return gatewayFetch([{ sessionId: 'run-1', running: true }])(
          url, { ...init, body: JSON.stringify(body) },
        )
      },
    })
    assert.equal(status.available, false, `${label}:应被拒,实际却判可用`)
    assert.equal(status.running, false, `${label}:拒绝时不得报 running:true`)
    assert.match(status.reason, /session\/list 返回错误/, `${label}:理由要点明是 RPC 报错`)
  }
})

test('内调拿到权威列表但目标不在其中 → available 且 running:false,不退回 503', async () => {
  const status = await runningFromRpc('absent', {
    selfOrigin: 'http://127.0.0.1:7000',
    fetch: async () => listEnvelope([{ sessionId: 'other', running: true }]),
  })
  assert.deepEqual(status, { available: true, running: false, reason: null })
})

test('内调失败的每一种都是 unavailable 且理由各不相同', async () => {
  const origin = 'http://127.0.0.1:7000'
  const cases = [
    ['无 origin', { selfOrigin: '', fetch: async () => { throw new Error('unreachable') } }, /origin/],
    ['HTTP 404(旧方法名/方法已删的表现)', {
      selfOrigin: origin, fetch: async () => ({ ok: false, status: 404 }),
    }, /HTTP 404/],
    ['RPC 业务错误', {
      selfOrigin: origin,
      fetch: async () => ({
        ok: true, status: 200,
        json: async () => ({ result: { ok: false, error: { code: 'METHOD_NOT_FOUND' } } }),
      }),
    }, /METHOD_NOT_FOUND/],
    ['响应缺 items', {
      selfOrigin: origin,
      fetch: async () => ({ ok: true, status: 200, json: async () => ({ result: { ok: true, value: {} } }) }),
    }, /缺少 items/],
    ['fetch 抛错', {
      selfOrigin: origin, fetch: async () => { throw new Error('ECONNREFUSED') },
    }, /ECONNREFUSED/],
    ['json 解析失败', {
      selfOrigin: origin,
      fetch: async () => ({ ok: true, status: 200, json: async () => { throw new Error('bad json') } }),
    }, /bad json/],
  ]
  const reasons = new Set()
  for (const [label, deps, pattern] of cases) {
    const status = await runningFromRpc('x', deps)
    assert.equal(status.available, false, label)
    assert.equal(status.running, false, label)
    assert.match(status.reason, pattern, label)
    reasons.add(status.reason)
  }
  assert.equal(reasons.size, cases.length, '每种失败要有可区分的理由')
})

test('ctx.agents 读取失败时落到内调 —— 内调对运行态是等价权威,不该白白放弃', async () => {
  // 三种「读不出 ctx.agents」:形状异常、get 抛错、服务未注册。
  for (const ctx of [{}, { get() { throw new Error('agents down') } }, { get: () => undefined }]) {
    const status = await runningFromContext(ctx, 'run-1', {
      selfOrigin: 'http://127.0.0.1:7000',
      fetch: async () => listEnvelope([{ sessionId: 'run-1', running: true }]),
    })
    assert.deepEqual(status, { available: true, running: true, reason: null }, JSON.stringify(Object.keys(ctx)))
  }
})

test('ctx 与内调都拿不到运行态 → unavailable,删除必须拒绝而不是当「未运行」放行', async () => {
  const status = await runningFromContext({}, 'x', {
    selfOrigin: 'http://127.0.0.1:7000',
    fetch: async () => ({ ok: false, status: 503 }),
  })
  assert.equal(status.available, false)
  assert.equal(status.running, false)
  assert.match(status.reason, /HTTP 503/)
})

// ── 语义缺口:running 永远不能替代挂载判据 ────────────────────────────────

test('running 不能当挂载判据:宿主对「挂载但空闲」和「冷会话」都给 running:false', async () => {
  // 照抄宿主 packages/api/session-controller/src/list.ts 的两条产出路径:
  //   :125 已挂载 → running = ctx.agents.get(id)?.status === 'running'
  //   :178 冷会话 → running = false(无条件)
  const attachedIdle = { sessionId: 'attached-idle', running: false }
  const coldOnDisk = { sessionId: 'cold-on-disk', running: false }
  const fetchList = async () => listEnvelope([attachedIdle, coldOnDisk])

  const a = await runningFromRpc('attached-idle', { selfOrigin: 'http://127.0.0.1:7000', fetch: fetchList })
  const b = await runningFromRpc('cold-on-disk', { selfOrigin: 'http://127.0.0.1:7000', fetch: fetchList })
  // 两者的运行态回答完全一样 —— 所以它区分不了挂载,只能由 ctx.sessions 回答。
  assert.deepEqual(a, b)

  // 而挂载态判据能把它们分开:
  const ctx = { sessions: { get: (id) => (id === 'attached-idle' ? { id } : undefined) } }
  assert.equal((await attachedFromContext(ctx, 'attached-idle')).attached, true)
  assert.equal((await attachedFromContext(ctx, 'cold-on-disk')).attached, false)
})

// ── 端到端:未知挂载态必须拒绝删除(此前完全没有测试) ──────────────────────

/**
 * 真实临时会话 + 真实 HTTP 删除路由。
 * 守卫在会话解析之后才跑,所以根必须真实存在,否则先抛 404 就测不到守卫。
 */
async function sessionFixture(t, readAttached) {
  const dshRoot = await mkdtemp(join(tmpdir(), 'dsh-agos-verdict-'))
  assert.ok(dshRoot.startsWith(tmpdir()), '只在临时目录里造会话,不碰真实 DSH_HOME')
  t.after(async () => { await rm(dshRoot, { recursive: true, force: true }) })
  const dir = join(dshRoot, 'sessions', '--verdict-project--', 'sess-1')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'sentinel.txt'), 'sess-1', 'utf8')
  const manager = createAgosSessionManager({
    dshRoot,
    readRunning: async () => ({ available: true, running: false }),
    readAttached,
  })
  return { dir, routes: new Map(createAgosSessionRouteHandlers(manager)) }
}

/** 走真实路由 handler,拿真实响应 —— 不直接调 manager 内部方法。 */
async function callDelete(routes, sessionId) {
  const path = '/api/agos/session/delete'
  const handler = routes.get(path)
  assert.equal(typeof handler, 'function', `missing route ${path}`)
  const req = Readable.from([JSON.stringify({ sessionId })])
  req.method = 'POST'
  req.url = path
  const response = {
    status: undefined,
    body: undefined,
    writeHead(status) { this.status = status },
    end(value) { this.body = value === undefined ? '' : String(value) },
  }
  await handler(req, response)
  return { status: response.status, json: response.body ? JSON.parse(response.body) : undefined }
}

const onDisk = async (dir) => {
  try { await stat(dir); return true } catch { return false }
}

test('挂载态未知 → 删除 503 LIVE_STATUS_UNAVAILABLE,理由透出,且会话仍在盘上', async (t) => {
  // 真实生产接线:ctx 不公开 sessions 时 attachedFromContext 就是这个返回。
  const fx = await sessionFixture(t, (id) => attachedFromContext({ get: () => undefined }, id))

  const result = await callDelete(fx.routes, 'sess-1')
  assert.equal(result.status, 503)
  assert.equal(result.json.code, 'LIVE_STATUS_UNAVAILABLE')
  assert.match(result.json.error, /无法确认会话是否仍挂载/)
  assert.match(result.json.error, /host\.describe 已删除/, '理由要透出到响应,否则运维只看到裸 503')
  assert.equal(await onDisk(fx.dir), true, '未知状态下不得删除')
})

test('挂载中 → 409 SESSION_LIVE;已分离 → 放行(两侧都走真实 attachedFromContext)', async (t) => {
  const live = await sessionFixture(t, (id) => attachedFromContext(
    { sessions: { get: (x) => (x === 'sess-1' ? { id: x } : undefined) } }, id,
  ))
  const blocked = await callDelete(live.routes, 'sess-1')
  assert.equal(blocked.status, 409)
  assert.equal(blocked.json.code, 'SESSION_LIVE')
  assert.equal(await onDisk(live.dir), true, '挂载中不得删除')

  const detached = await sessionFixture(t, (id) => attachedFromContext(
    { sessions: { get: () => undefined } }, id,
  ))
  const allowed = await callDelete(detached.routes, 'sess-1')
  assert.equal(allowed.status, 200, `已分离应放行,实际 ${allowed.status}: ${detached.routes && allowed.json?.error}`)
  assert.equal(await onDisk(detached.dir), false, '已分离会话应被移走')
})

// ── 静态回归钉:死方法不许回到源码 ────────────────────────────────────────

test('lib/index.js 里不得再有 host.describe 内调,也不得再用点号方法名', async () => {
  const source = await readFile(LIB, 'utf8')

  // 允许注释里留历史说明,但不许出现在 fetch/method 位置。
  const live = source
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n')

  assert.doesNotMatch(live, /['"`]\/api\/host\.describe['"`]/, 'host.describe 路由已在 0.1.2 删除')
  assert.doesNotMatch(live, /method:\s*['"`]host\.describe['"`]/, 'host.describe 方法已在 0.1.2 删除')
  assert.doesNotMatch(live, /['"`]\/api\/session\.list['"`]/, '0.1.2 用斜杠:/api/session/list')
  assert.doesNotMatch(live, /method:\s*['"`]session\.list['"`]/, '0.1.2 用斜杠:session/list')
  assert.doesNotMatch(live, /attachedSessions/, 'host.describe 的字段,已无来源')

  // 正控:确实用了斜杠命名。
  assert.match(live, /['"`]\/api\/session\/list['"`]/)
  assert.match(live, /['"`]session\/list['"`]/)
})
