// 2026-09-09 Luna 核查 P1/P2 — 生产入口接线语义(async lock wiring + auditFile pinning)。
//
// ⚠️ 本文件的测试依赖 lib/index.js 的接线补丁(withLedgerLockAsync / appendLineAsync /
// pinDispatchConfig 接到 HTTP 路径)。index.js 归主控(Cursor)所有,补丁见本轮报告;
// 补丁落地时把本文件从 test-wiring/ 移入 test/。在打了补丁的树上必须全绿;
// 在镜像树里删除对应接线后,相应测试必须变红(负控证据见报告)。
//
// 覆盖:
//   1. 外部进程持锁期间,host 的事件循环不被 park:无关 HTTP 端点照常响应、定时器照常走;
//   2. dispatch 中途配置改变(auditFile 被改向),trial 的行仍写进 dispatch 开始时的台账;
//   3. 既有上界(5s 预算内放弃)/下界(500ms 正当争用等住)语义不回归 ——
//      由 test/index-lock-timeout.test.mjs 继续钉,本文件不重复。
import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { apply } from '../lib/index.js'

const self = fileURLToPath(import.meta.url)

// ── 被 spawn 的持锁子进程 ────────────────────────────────────────────────────
if (process.argv[2] === '--agos-wiring-hold-lock') {
  const target = process.argv[3]
  const holdMs = Number(process.argv[4])
  const { acquireLedgerLock, releaseLedgerLock, lockPathFor } = await import('../lib/ledger-lock.js')
  const held = acquireLedgerLock(lockPathFor(target), { timeoutMs: 20_000, retryMs: 5 })
  process.stdout.write('ready\n')
  await new Promise((resolve) => setTimeout(resolve, holdMs))
  releaseLedgerLock(held)
  process.stdout.write('released\n')
  process.exit(0)
}

async function holdLockElsewhere(target, holdMs) {
  const child = spawn(process.execPath, [self, '--agos-wiring-hold-lock', target, String(holdMs)], {
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
  return { child, done: new Promise((resolve) => child.on('exit', resolve)) }
}

function fakeCtx(extra = {}) {
  const routes = new Map()
  const ctx = {
    logger: () => ({ warn() {}, info() {} }),
    llm: extra.llm,
    inject(names, cb) {
      if (names.includes('webServer')) {
        cb({ get: (n) => (n === 'webServer'
          ? { register: (r) => { routes.set(r.path, r.handler); return () => routes.delete(r.path) } }
          : undefined) })
      }
      if (names.includes('settings') && extra.settings) cb(extra.settings)
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

const DECISION = {
  id: 'dec-wiring-1',
  ts: 1788000000000,
  taskType: 'coding',
  role: 'implementer',
  label: 'coding',
  pick: 'qwen3.8-max',
  candidates: ['qwen3.8-max', 'minimax-m3', 'glm-5.2'],
  source: 'fallback',
  outcome: null,
}
const ASSEMBLE = {
  kind: 'assemble',
  id: 'asm-wiring-1',
  ref: DECISION.id,
  roles: [
    { role: 'planner', model: 'glm-5.2' },
    { role: 'implementer', model: 'qwen3.8-max' },
    { role: 'reviewer', model: 'minimax-m3' },
  ],
}

async function boot(audit, extra = {}) {
  const { ctx, routes } = fakeCtx(extra)
  apply(ctx, { auditFile: audit, provider: '', model: '' })
  await new Promise((resolve) => setTimeout(resolve, 20))
  return routes
}

test('WIRING: 外部持锁期间 host 不被 park —— 无关 HTTP 端点照常响应,定时器照常走,POST /outcome 等住后成功', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agos-wiring-liveness-'))
  try {
    const audit = join(dir, 'route-outcome.jsonl')
    await writeFile(audit, JSON.stringify(DECISION) + '\n')
    const routes = await boot(audit)

    // 持锁 2s(>500ms 正当争用、<5s 写路径预算):POST /outcome 必须等住并最终成功,
    // 而等待期间整个 host 必须保持响应。
    const holder = await holdLockElsewhere(audit, 2_000)
    let ticks = 0
    const interval = setInterval(() => { ticks += 1 }, 25)

    const postPromise = call(routes.get('/api/agos/routes/outcome'), 'POST', '/api/agos/routes/outcome', {
      ref: DECISION.id, result: 'ok',
    })

    // 无关端点(纯读,不取锁)必须在持锁期间照常返回。
    const started = Date.now()
    const outcomes = await call(routes.get('/api/agos/routes/outcomes'), 'GET', '/api/agos/routes/outcomes')
    const outcomesElapsed = Date.now() - started

    assert.equal(outcomes.status, 200, `持锁期间无关端点被拖死(${outcomes.status})`)
    assert.ok(outcomesElapsed < 800, `无关端点花了 ${outcomesElapsed}ms:事件循环被 park`)

    // 再等 ~350ms(仍在外部持锁窗口内)采样定时器:park 的世界里这段时间
    // 一个 tick 都不会走;异步等锁的世界里应当走了十几个。
    await new Promise((resolve) => setTimeout(resolve, 350))
    const ticksDuringHold = ticks
    assert.ok(ticksDuringHold >= 10, `持锁期间定时器只走了 ${ticksDuringHold} tick:事件循环被 park`)

    let post
    try {
      post = await postPromise
    } finally {
      clearInterval(interval)
      await holder.done
    }

    assert.equal(post.status, 200, `等锁释放后应成功,实际 ${post.status}: ${JSON.stringify(post.body)}`)
    const rows = (await readFile(audit, 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line))
    assert.equal(rows.filter((row) => row.kind === 'outcome' && row.ref === DECISION.id).length, 1)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('WIRING: dispatch 中途配置改变仍写原 auditFile —— pin 在 dispatch 开始时就钉住', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agos-wiring-pin-'))
  try {
    const auditA = join(dir, 'ledger-a.jsonl')
    const auditB = join(dir, 'ledger-b.jsonl')
    await writeFile(auditA, [DECISION, ASSEMBLE].map((row) => JSON.stringify(row)).join('\n') + '\n')

    // 可翻转的 settings 源:installSection 后 effectiveConfig() 读的是 live.value。
    const live = { value: { auditFile: auditA, provider: '', model: '' } }
    const settings = {
      settings: {
        installSection: (c, ns, schema, entry, hooks) => {
          hooks.setSource(() => live.value)
        },
      },
    }
    // llm 替身:第一条流开始时把配置翻向 auditB —— 这正是模型流期间的配置漂移。
    const llm = {
      async *stream() {
        live.value = { auditFile: auditB, provider: '', model: '' }
        yield { type: 'text-delta', index: 0, text: 'x' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    }
    const routes = await boot(auditA, { settings, llm })

    const response = await call(routes.get('/api/agos/routes/assemble/dispatch'), 'POST', '/api/agos/routes/assemble/dispatch', {
      confirm: true,
    })
    assert.equal(response.status, 200, `dispatch 失败: ${JSON.stringify(response.body)}`)

    const rowsA = existsSync(auditA)
      ? (await readFile(auditA, 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line))
      : []
    const rowsB = existsSync(auditB)
      ? (await readFile(auditB, 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line))
      : []
    assert.equal(
      rowsA.filter((row) => row.kind === 'dispatch').length,
      1,
      'trial 的 dispatch 行必须写进 dispatch 开始时的台账,哪怕中途配置已改向',
    )
    assert.equal(rowsB.length, 0, `中途改向的台账收到了 ${rowsB.length} 行:auditFile 没有被钉住`)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
