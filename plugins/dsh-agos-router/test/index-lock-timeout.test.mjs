// HTTP 处理器持锁的超时上限是否真的生效。
//
// 为什么需要单独一个文件钉这件事:ledger-lock.js 的等锁走 Atomics.wait,它 park 的是
// **整个单线程 host**,不是当前这一个请求。默认 30s 用在 HTTP 路径上就是一条故障 ——
// 一个卡死的对端能让控制台全站冻住半分钟。而这道风险是本轮接线放大的:接线前
// appendLine 只在追加那一瞬取锁,接线后临界区是「读 → 判定 → 追加」整段。
//
// 这里必须两侧都钉:
//   · 只钉上界(超时够短) → 有人把 timeoutMs 设成 1 也能过,正当的并发全被误拒;
//   · 只钉下界(能等住)   → 退回 30s 默认值也能过,冻站故障回来了。
// 所以下面第二条是第一条的负控,反之亦然。删掉任何一条,另一条都会被绕过。

import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { apply } from '../lib/index.js'

const self = fileURLToPath(import.meta.url)

/** lib/index.js 里 HTTP_LOCK 的值。这里写死是故意的:改了生产值就要来改这条测试。 */
const HTTP_LOCK_MS = 5_000
/** ledger-lock.js 的默认值。超时若退回它,下面的上界断言必须红。 */
const DEFAULT_LOCK_MS = 30_000
/** 上界判定线。取两者中点:5s 预算过得去,30s 默认值过不去。 */
const CEILING_MS = (HTTP_LOCK_MS + DEFAULT_LOCK_MS) / 2

// ── 被 spawn 的持锁子进程 ────────────────────────────────────────────────────
if (process.argv[2] === '--agos-hold-lock-for') {
  const target = process.argv[3]
  const holdMs = Number(process.argv[4])
  const { acquireLedgerLock, releaseLedgerLock, lockPathFor } = await import('../lib/ledger-lock.js')
  // 自己取锁时给足预算,免得本进程反被别的测试挤掉而误报「接线缺失」。
  const held = acquireLedgerLock(lockPathFor(target), { timeoutMs: 20_000, retryMs: 5 })
  process.stdout.write('ready\n')
  await new Promise((resolve) => setTimeout(resolve, holdMs))
  releaseLedgerLock(held)
  process.stdout.write('released\n')
  process.exit(0)
}

async function holdLockFor(target, holdMs) {
  const child = spawn(process.execPath, [self, '--agos-hold-lock-for', target, String(holdMs)], {
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  await new Promise((resolve, reject) => {
    let out = ''
    child.stdout.on('data', (chunk) => {
      out += String(chunk)
      if (out.includes('ready')) resolve()
    })
    child.on('exit', (code) => reject(new Error(`持锁子进程未就绪即退出(code=${code}),本次判定无效`)))
  })
  return {
    child,
    kill: () => new Promise((resolve) => {
      if (child.exitCode !== null) { resolve(); return }
      child.on('exit', resolve)
      child.kill('SIGKILL')
    }),
  }
}

function fakeCtx() {
  const routes = new Map()
  const ctx = {
    logger: () => ({ warn() {}, info() {} }),
    llm: undefined,
    inject(names, cb) {
      if (names.includes('webServer')) {
        cb({
          get: (n) => (n === 'webServer'
            ? { register: (r) => { routes.set(r.path, r.handler); return () => routes.delete(r.path) } }
            : undefined),
        })
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
  return { status, body: body ? JSON.parse(body) : undefined }
}

const REF = 'dec-1788000000000-0000001'

async function bootWithLedger() {
  const dir = await mkdtemp(join(tmpdir(), 'agos-lock-timeout-'))
  const audit = join(dir, 'route-outcome.jsonl')
  await writeFile(audit, `${JSON.stringify({
    id: REF,
    ts: 1788000000000,
    taskType: 'reviewer',
    role: 'reviewer',
    pick: 'MiniMax-M3',
    label: 'reviewer',
    outcome: null,
    source: 'fallback',
  })}\n`)
  const { ctx, routes } = fakeCtx()
  apply(ctx, { auditFile: audit, provider: '', model: '' })
  await new Promise((resolve) => setTimeout(resolve, 20))
  return { audit, routes }
}

async function outcomeRows(audit) {
  const text = await readFile(audit, 'utf8')
  return text.split('\n').filter(Boolean).map((line) => JSON.parse(line)).filter((row) => row.kind === 'outcome')
}

test('上界:锁被长期占用时,HTTP 路径在 5s 预算内放弃,而不是拖到 30s 默认值', async () => {
  const { audit, routes } = await bootWithLedger()
  // 持锁时长要长过 30s 默认值,这样「没接超时」与「接了超时」的耗时差异无法被巧合抹平。
  const holder = await holdLockFor(audit, DEFAULT_LOCK_MS + 5_000)
  try {
    const started = Date.now()
    const response = await call(routes.get('/api/agos/routes/outcome'), 'POST', '/api/agos/routes/outcome', {
      confirm: true,
      ref: REF,
      result: 'ok',
    })
    const elapsed = Date.now() - started

    assert.ok(
      elapsed < CEILING_MS,
      `等锁耗时 ${elapsed}ms,超过判定线 ${CEILING_MS}ms:lib/index.js 的 HTTP_LOCK 没传到 withLedgerLock,`
        + `退回了 ledger-lock.js 的 ${DEFAULT_LOCK_MS}ms 默认值 —— 这段时间里整个 host 都被 Atomics.wait park 住`,
    )
    // fail-closed:超时必须是「拒绝」,不能是「绕过锁写进去」。
    assert.notEqual(response.status, 200, `超时却返回了 200:${JSON.stringify(response.body)}`)
    assert.deepEqual(await outcomeRows(audit), [], '超时后仍写入了 outcome 行:锁超时被当成了可以无锁继续')
  } finally {
    await holder.kill()
  }
})

test('下界(上一条的负控):锁只被短暂占用时,请求要等住并成功,不能被超时误拒', async () => {
  const { audit, routes } = await bootWithLedger()
  // 500ms 是正常的并发争用,远小于 5s 预算。这条会红的唯一原因是超时被调得过小 ——
  // 也就是有人用「把 timeoutMs 改成 1」的办法去让上一条测试变快。
  const holder = await holdLockFor(audit, 500)
  try {
    const response = await call(routes.get('/api/agos/routes/outcome'), 'POST', '/api/agos/routes/outcome', {
      confirm: true,
      ref: REF,
      result: 'ok',
    })
    assert.equal(
      response.status,
      200,
      `一次 500ms 的正当争用被拒了(${response.status}):HTTP_LOCK 的预算被调得过小,正常并发会被误判成锁超时`
        + `(${JSON.stringify(response.body)})`,
    )
    assert.equal((await outcomeRows(audit)).length, 1, '结果没有落盘')
  } finally {
    await holder.kill()
  }
})

// ── 读路径的预算远小于写路径 ────────────────────────────────────────────────
// 回填是幂等的(跳过这轮,下一次 GET 重算同一份 pending),所以不值得为它 park 住整个 host
// 5 秒。这一条同时补上接线审查者指出的一处空洞:主控原先在 index-transaction.test.mjs 里
// 写了「这一条同时守住那个 catch 不会把锁等待吞成静默失败」,但那条测试持锁 500ms、预算 30s,
// catch 一次都没进过 —— 声明比测试强。250ms 预算之后这件事才真的可测。
test('读路径:锁被长期占用时,GET /routes 快速放弃回填并照常返回列表,不吃写路径的 5s 预算', async () => {
  const { audit, routes } = await bootWithLedger()
  const holder = await holdLockFor(audit, 6_000)
  try {
    const started = Date.now()
    const response = await call(routes.get('/api/agos/routes'), 'GET', '/api/agos/routes')
    const elapsed = Date.now() - started

    // 上界取 2s:250ms 预算过得去,5s 的写路径预算过不去。也就是说这条能区分
    // 「回填用了 BACKFILL_LOCK」与「回填仍在用 HTTP_LOCK」。
    assert.ok(
      elapsed < 2_000,
      `GET /routes 等锁 ${elapsed}ms:回填还在用写路径的 5s 预算(BACKFILL_LOCK 没接上),`
        + '一个持续持锁的对端会让控制台每轮轮询都冻住整个 host',
    )
    // 关键:回填失败不能把列表一起拖下水,列表必须照常返回。
    assert.equal(response.status, 200, `列表被回填失败拖红了(${response.status}):${JSON.stringify(response.body)}`)
    // 且列表要诚实 —— 未回填的行照旧是 pending,不许编造终态。
    assert.ok(response.body, '列表返回了空 body')
  } finally {
    await holder.kill()
  }
})

// ── transact 是注入点,「只能同步」必须可执行 ──────────────────────────────────
// withLedgerLock 同步取锁、同步 finally 放锁。传 async 回调时锁会在 promise 创建的
// 那一刻就释放,临界区静默失效,而现有测试一条都不会红 —— 这正是接线审查者(A3)
// 指出的潜在缺陷:今天四个调用点都是同步的,但 lib/index.js 把它作为 transact 注入出去,
// 注入点迟早会拿到别人写的回调。
test('注入点约束:withLedgerLock 收到 async 回调时直接抛错,而不是静默放掉锁', async () => {
  const { withLedgerLock } = await import('../lib/ledger-lock.js')
  const dir = await mkdtemp(join(tmpdir(), 'agos-lock-async-'))
  const audit = join(dir, 'audit.jsonl')
  await writeFile(audit, '')

  assert.throws(
    () => withLedgerLock(audit, async () => { await Promise.resolve(); return 1 }),
    /thenable/,
    'async 回调被静默接受:锁在 promise 创建时就放了,临界区不成立',
  )

  // 负控:同步回调必须照常工作,不能因为这道闸把正常用法一起挡掉。
  assert.equal(withLedgerLock(audit, () => 42), 42, '同步回调被误拒')
  // 且抛错之后锁要已经释放 —— 否则这道闸自己会造成死锁。
  assert.equal(withLedgerLock(audit, () => 'ok'), 'ok', '上一次抛错后锁没有释放')
})
