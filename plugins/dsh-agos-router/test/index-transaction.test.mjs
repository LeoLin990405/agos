// 生产入口是否真的在事务里读改写 —— 由主控编写,验证主控自己做的接线。
//
// 为什么必须单独有这个文件:`test/ledger-multiprocess.test.mjs` 把锁原语测得很足,
// 但它测的是 lib/ledger-lock.js。锁存在、能用、抗崩溃,都不等于 index.js 里那五个
// 读改写调用点真的用了它。主控实测过这个缺口:把 index.js 里的 withLedgerLock 换成
// 直通 `(_f, fn) => fn()`,dsh-agos-router 全套件仍然 116/116、exit 0 —— 也就是说
// 在本文件之前,漏接线或事后被人删掉接线,没有任何测试会变红。
//
// 判据用「外部进程持锁期间生产路由是否被挡住」,而不是往临界区注入延迟去赌竞争窗口:
// 一个真实的跨进程文件锁被别的进程持着时,接了线的调用必须等到锁释放才能返回。
// 于是「等到了」就是接线存在的运行时证据,不靠读源码断言,也不靠时序运气。
//
// ⚠️ 本文件覆盖四个接线点中的三个:shadowLink、backfillShadow、recordOutcome。
// 第四个 —— dispatchLiveRequest 注入给 dispatchTeam 的 `transact` 依赖 —— **没有覆盖**。
// 实测:单独删掉 index.js 里那一行,dsh-agos-router 全套件仍然 120/120、exit 0。
// test/dispatch.test.mjs 证明的是「dispatchTeam 会用注入进来的 transact」,不是
// 「index.js 真的注入了它」。要覆盖它得先跑通 dispatchLiveRequest 的三条模型流
// (需要真实 ctx.llm),不在本文件的合成范围内。缺口已登记在本轮 REVIEW.md,
// 不要因为本文件全绿就以为四个点都被守住了。
import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { apply } from '../lib/index.js'

const self = fileURLToPath(import.meta.url)
/** 持锁时长。要显著大于无锁调用的耗时,又不至于拖慢套件。 */
const HOLD_MS = 500
/** 判定下限留出调度余量:阻塞过的调用至少要花掉大半个持锁窗口。 */
const BLOCKED_FLOOR_MS = 300
/**
 * 读路径的下限单独一个值:GET /routes 的回填用 BACKFILL_LOCK(250ms),撞锁时是「等满预算就放弃」,
 * 不是「等到对方释放」,所以它花的是 ~250ms 而不是整个 500ms 持锁窗口。
 * 取 150ms:接线后实测 ~250-280ms,未接线时该路径不取锁(见测试内注释)、约 0ms,两侧都留足余量。
 */
const BACKFILL_FLOOR_MS = 150

// ── 被 spawn 的持锁子进程 ────────────────────────────────────────────────────
// 第二个参数 writeRef 非空时,子进程会在持锁期间往台账追加一条 outcome 行再释放。
// 这是区分「读也在锁内」和「只有写在锁内」的关键手段,理由见 recordOutcome 那条测试。
if (process.argv[2] === '--agos-hold-lock') {
  const target = process.argv[3]
  const writeRef = process.argv[4] ?? ''
  const { acquireLedgerLock, releaseLedgerLock, lockPathFor } = await import('../lib/ledger-lock.js')
  const { appendFileSync } = await import('node:fs')
  const held = acquireLedgerLock(lockPathFor(target), { timeoutMs: 5_000, retryMs: 5 })
  // 只有真拿到锁才报 ready,否则主进程会把「根本没人持锁」误当成「接线缺失」。
  process.stdout.write('ready\n')
  await new Promise((resolve) => setTimeout(resolve, HOLD_MS))
  if (writeRef) {
    // 绕过 appendLine 直接写:appendLine 会再取一次锁,而本进程已经持着它。
    appendFileSync(target, JSON.stringify({
      kind: 'outcome', ref: writeRef, result: 'ok', at: 1788000000001, source: 'concurrent-writer',
    }) + '\n')
  }
  releaseLedgerLock(held)
  process.stdout.write('released\n')
  process.exit(0)
}

/** 起一个子进程持锁,等它确认拿到锁后再返回。writeRef 见上。 */
async function holdLockElsewhere(target, writeRef = '') {
  const child = spawn(process.execPath, [self, '--agos-hold-lock', target, writeRef], { stdio: ['ignore', 'pipe', 'inherit'] })
  let out = ''
  const ready = new Promise((resolve, reject) => {
    child.stdout.on('data', (chunk) => {
      out += String(chunk)
      if (out.includes('ready')) resolve()
    })
    child.on('exit', (code) => reject(new Error(`持锁子进程未就绪即退出(code=${code}),本次判定无效`)))
  })
  await ready
  return { child, done: new Promise((resolve) => child.on('exit', resolve)) }
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

/** 一条已落盘、还没有 outcome 的决策,供 recordOutcome 记结果。 */
async function seedLedger(dir) {
  const audit = join(dir, 'route-outcome.jsonl')
  await writeFile(audit, JSON.stringify({
    id: 'dec-1788000000000-0000001',
    ts: 1788000000000,
    taskType: 'reviewer',
    role: 'reviewer',
    pick: 'MiniMax-M3',
    label: 'reviewer',
    outcome: null,
    source: 'fallback',
  }) + '\n')
  return audit
}

async function bootRoutes(audit) {
  const { ctx, routes } = fakeCtx()
  apply(ctx, { auditFile: audit, provider: '', model: '' })
  await new Promise((resolve) => setTimeout(resolve, 20))
  return routes
}

test('POST /routes/outcome 的读也在锁内 —— 并发写者先落的结果不会被覆写成第二条冲突行', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agos-wire-outcome-'))
  const audit = await seedLedger(dir)
  const routes = await bootRoutes(audit)

  // 这一条为什么不能用「是否被挡住 500ms」来判:ledger.js 的 appendLine 自己就会取锁,
  // 所以即便 index.js 完全没接线,recordOutcome 也照样会在追加那一刻被挡住 500ms ——
  // 那个计时量到的是 appendLine 的锁,不是事务边界,接不接线都通过。主控实测踩到过。
  //
  // 真正的差别在「读」的位置:接了线,读在锁内,必然看到并发写者已落的 ok;没接线,
  // 读在锁外、先于对方落盘,于是看不到它,再把 fail 记上去 —— 台账里就有了两条互相
  // 矛盾的 outcome,「改判不改史」被竞争击穿。
  const holder = await holdLockElsewhere(audit, 'dec-1788000000000-0000001')
  const response = await call(routes.get('/api/agos/routes/outcome'), 'POST', '/api/agos/routes/outcome', {
    confirm: true,
    ref: 'dec-1788000000000-0000001',
    result: 'fail',
  })
  await holder.done

  const rows = (await readFile(audit, 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line))
  const outcomes = rows.filter((row) => row.kind === 'outcome' && row.ref === 'dec-1788000000000-0000001')

  assert.equal(
    outcomes.length,
    1,
    `台账里出现了 ${outcomes.length} 条 outcome:读发生在锁外,recordOutcome 没有走 withLedgerLock`
      + `(${JSON.stringify(outcomes.map((o) => o.result))})`,
  )
  assert.equal(outcomes[0].result, 'ok', '先落盘的结果被覆写了')
  assert.notEqual(response.status, 200, `冲突结果本应被拒,实际 ${response.status}: ${JSON.stringify(response.body)}`)
})

test('POST /routes/shadow/link 在外部进程持锁期间被挡住 —— shadowLink 确实在事务内', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agos-wire-link-'))
  const audit = await seedLedger(dir)
  const routes = await bootRoutes(audit)

  const seededRowCount = (await readFile(audit, 'utf8')).trimEnd().split('\n').length
  const holder = await holdLockElsewhere(audit)
  const startedAt = Date.now()
  // 这里不关心业务上能不能绑成功:REBOUND / BATCH_LINKED 的判定读的是台账,
  // 因此无论最终接受还是拒绝,读的那一刻都必须已经在锁内。
  //
  // 区分力的来源:batchId 指向一个不存在的批次,请求在 appendLine **之前**就被拒。
  // 所以这次调用的等待只可能来自接线那一层的取锁,不可能是 appendLine 自己的锁。
  // 这一点原先只是载荷选择带来的性质、没被钉住(接线审查者 B4),下面用行数断言钉住:
  // 有人为了「更真实」给 seedLedger 补上 shadow-link 行,这条会红而不是静默退化。
  await call(routes.get('/api/agos/routes/shadow/link'), 'POST', '/api/agos/routes/shadow/link', {
    confirm: true,
    ref: 'dec-1788000000000-0000001',
    batchId: 'batch-does-not-exist',
    hosts: [],
  }).catch(() => undefined)
  const waited = Date.now() - startedAt
  await holder.done

  assert.equal(
    (await readFile(audit, 'utf8')).trimEnd().split('\n').length,
    seededRowCount,
    '本次调用写了台账行:请求没有在 appendLine 之前被拒,这条测试量到的可能是 appendLine 自己的锁',
  )
  assert.ok(
    waited >= BLOCKED_FLOOR_MS,
    `只等了 ${waited}ms(< ${BLOCKED_FLOOR_MS}ms):shadowLink 没有走 withLedgerLock`,
  )
})

test('GET /routes 在外部进程持锁期间被挡住 —— backfillShadow 确实在事务内', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agos-wire-backfill-'))
  const audit = await seedLedger(dir)
  const routes = await bootRoutes(audit)

  const seededRowCount = (await readFile(audit, 'utf8')).trimEnd().split('\n').length
  const holder = await holdLockElsewhere(audit)
  const startedAt = Date.now()
  const listed = await call(routes.get('/api/agos/routes'), 'GET', '/api/agos/routes?limit=10')
  const waited = Date.now() - startedAt
  await holder.done

  // backfillShadow 自带 try/catch 且失败不影响列表,所以列表必须照常返回 200 ——
  // 「被挡住」不等于「降级」。
  // ⚠️ 原先这里还写了「这一条同时守住那个 catch 不会把锁等待吞成静默失败」——不成立,已删:
  // 本条持锁 500ms 而当时预算 30s,catch 一次都没进过。那件事现在由
  // index-lock-timeout.test.mjs 的读路径那条真正覆盖(持锁 6s > 250ms 预算,确实走进 catch)。
  // 由接线审查者指出。
  assert.equal(listed.status, 200, `列表应当照常返回,实际 ${listed.status}`)
  // 区分力的来源(接线审查者 B4 指出这一点原先没被钉住,而主控随后改预算时正好把它踩了):
  // 本条 seed 的台账没有 shadow-link 行,links.size === 0 → **不会**走到 appendLine。
  // 所以未接线时这次调用是 ~0ms(锁只在 appendLine 里取,而这里根本不取);
  // 接线后取锁被提到最外层,撞上外部持锁就会等满 BACKFILL_LOCK 的 250ms 预算再放弃。
  // 判据因此是「等了约一个回填预算」,而不是「等到对方释放」——后者在 250ms 预算下已不成立。
  assert.ok(
    waited >= BACKFILL_FLOOR_MS,
    `只等了 ${waited}ms(< ${BACKFILL_FLOOR_MS}ms):backfillShadow 没有走 withLedgerLock`,
  )
  assert.ok(
    waited < 2_000,
    `等了 ${waited}ms:回填不该吃写路径的 5s 预算,应当在 BACKFILL_LOCK(250ms)就放弃`,
  )
  // 把「为什么这条有区分力」也钉成可执行的:这次调用确实没有写台账。
  // 有人为了「更真实」给 seedLedger 补上 shadow-link 行,这条会红,提醒他判据已经变了。
  assert.equal(
    (await readFile(audit, 'utf8')).trimEnd().split('\n').length,
    seededRowCount,
    '本次 GET 写了台账行:seed 数据变了,这条测试的区分力来源(links.size === 0 → 不走 appendLine)已不成立',
  )
})

test('负控:无人持锁时端点立刻返回 —— 上面三条的等待确实来自外部持锁,不是端点本身慢', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agos-wire-reentrant-'))
  const audit = await seedLedger(dir)
  const routes = await bootRoutes(audit)

  // ⚠️ 这条原先的标题与注释说它是「重入负控」,并称「listRoutes → backfillShadow 两层
  // 都在同一进程内取同一把锁」—— 事实错误,已改正。listRoutes 自己**不取锁**,全路径
  // 只有 backfillShadow 取一次;而本条 seed 的台账没有 shadow-link 行,links.size === 0,
  // backfillShadow 在 appendLine 之前就 return 了,深度始终是 1。也就是说本文件四条
  // 测试没有一条进入重入分支。由接线审查者指出(B2)。
  //
  // 这不是覆盖空洞:重入由 C 的 test/ledger-multiprocess.test.mjs 真实覆盖
  // (withLedgerLock 内再调 appendLine,后者会再取同一把锁),深度计数坏了那边会红。
  //
  // 本条实际证明的是:没有持锁者时端点立刻返回 —— 这是上面三条的负控,
  // 证明它们的等待来自外部持锁,而不是这些端点本身就慢。
  const startedAt = Date.now()
  const listed = await call(routes.get('/api/agos/routes'), 'GET', '/api/agos/routes?limit=10')
  const waited = Date.now() - startedAt

  assert.equal(listed.status, 200)
  assert.ok(waited < BLOCKED_FLOOR_MS, `无人持锁时却花了 ${waited}ms:端点本身就慢,上面三条的计时判据不成立`)
})
