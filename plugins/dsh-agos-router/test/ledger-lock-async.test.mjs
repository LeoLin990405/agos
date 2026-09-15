// 2026-09-09 Luna 核查 P1 — 异步锁等待(async lock wait)。
//
// acquireLedgerLock 的等待走 Atomics.wait:它 park 的是**整个单线程 host**。
// HTTP 路径上等锁 5s = 全站冻结 5s。这里钉死异步变体的契约:
//   1. 等待期间事件循环照常运转(无关定时器、无关工作都按时触发);
//   2. 超时语义与同步版一致(fail-closed,AGOS_LEDGER_LOCK_TIMEOUT);
//   3. AbortSignal 取消:拒绝且**绝不**取得锁(fail-closed);
//   4. 跨进程互斥语义不变:异步等待者拿不到被占的锁,持有者释放后才进入临界区;
//   5. withLedgerLockAsync 的回调可以是 async,锁在 promise 落定后才释放 ——
//      读→判→写的临界区覆盖整个异步回调(这正是 sync withLedgerLock 明令禁止的形状,
//      两者分工:同步回调用 sync 版防 thenable 静默放锁;宿主 HTTP 层用 async 版)。
//
// 真正的 SIGKILL/多进程崩溃语义仍由 test/ledger-multiprocess.test.mjs(同步原语,
// 同一协议)覆盖;本文件聚焦异步等待的行为差异。
import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  acquireLedgerLock,
  acquireLedgerLockAsync,
  lockPathFor,
  releaseLedgerLock,
  withLedgerLock,
  withLedgerLockAsync,
} from '../lib/ledger-lock.js'
import { appendLineAsync, readLedgerLines } from '../lib/ledger.js'

const self = fileURLToPath(import.meta.url)

// ── 被 spawn 的持锁子进程(同步原语持锁 —— 它就是"外部持锁者") ────────────────
if (process.argv[2] === '--agos-async-hold-lock') {
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
  const child = spawn(process.execPath, [self, '--agos-async-hold-lock', target, String(holdMs)], {
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

test('async wait never parks the event loop: timers and unrelated work fire on schedule', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agos-lock-async-loop-'))
  try {
    const target = join(dir, 'ledger.jsonl')
    await writeFile(target, '')
    const holder = await holdLockElsewhere(target, 900)

    // 25ms 间隔的定时器是"宿主其余部分"的替身:park 的世界里它会被整体推迟。
    let ticks = 0
    const interval = setInterval(() => { ticks += 1 }, 25)

    const acquired = acquireLedgerLockAsync(lockPathFor(target), { timeoutMs: 5_000, retryMs: 5 })
    // 无关工作也必须在等待期间完成(它在另一个微任务/事件循环回合里)。
    const unrelated = new Promise((resolve) => setTimeout(() => resolve('unrelated-ok'), 120))

    const held = await acquired
    const duringWaitTicks = ticks
    await unrelated
    clearInterval(interval)
    releaseLedgerLock(held)
    await holder.done

    assert.ok(duringWaitTicks >= 10, `等锁期间定时器只走了 ${duringWaitTicks}  tick:事件循环被 park 了`)
    assert.equal(await unrelated, 'unrelated-ok')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('async acquire resolves only after the external holder releases (mutual exclusion kept)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agos-lock-async-mx-'))
  try {
    const target = join(dir, 'ledger.jsonl')
    await writeFile(target, '')
    const holder = await holdLockElsewhere(target, 500)

    const started = Date.now()
    const held = await acquireLedgerLockAsync(lockPathFor(target), { timeoutMs: 5_000, retryMs: 5 })
    const waited = Date.now() - started
    releaseLedgerLock(held)
    await holder.done

    assert.ok(waited >= 400, `只等了 ${waited}ms:异步版没有真正等持有者释放就拿到了锁`)
    assert.ok(waited < 4_000, `等了 ${waited}ms:拿到锁的时序异常`)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('async wait times out fail-closed with the same code as the sync version', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agos-lock-async-to-'))
  try {
    const target = join(dir, 'ledger.jsonl')
    await writeFile(target, '')
    const holder = await holdLockElsewhere(target, 5_000)
    try {
      await assert.rejects(
        () => acquireLedgerLockAsync(lockPathFor(target), { timeoutMs: 300, retryMs: 10 }),
        (error) => error.code === 'AGOS_LEDGER_LOCK_TIMEOUT',
      )
    } finally {
      await holder.done.catch(() => {})
      if (holder.child.exitCode === null) holder.child.kill('SIGKILL')
      await holder.done
    }
    // 超时绝不残留持有:同进程立刻同步取锁应当成功。
    const held = acquireLedgerLock(lockPathFor(target), { timeoutMs: 1_000, retryMs: 5 })
    releaseLedgerLock(held)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('abort signal cancels the wait, rejects fail-closed, and never acquires', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agos-lock-async-abort-'))
  try {
    const target = join(dir, 'ledger.jsonl')
    await writeFile(target, '')
    const holder = await holdLockElsewhere(target, 5_000)
    const ac = new AbortController()
    try {
      const pending = acquireLedgerLockAsync(lockPathFor(target), {
        timeoutMs: 10_000,
        retryMs: 10,
        signal: ac.signal,
      })
      setTimeout(() => ac.abort(), 150)
      await assert.rejects(
        () => pending,
        (error) => error.code === 'AGOS_LEDGER_LOCK_ABORTED',
      )
    } finally {
      if (holder.child.exitCode === null) holder.child.kill('SIGKILL')
      await holder.done
    }
    // fail-closed proof: the cancelled waiter must NOT hold the lock.
    const held = acquireLedgerLock(lockPathFor(target), { timeoutMs: 1_000, retryMs: 5 })
    releaseLedgerLock(held)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('abort already fired before the call → immediate rejection, no attempt', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agos-lock-async-preabort-'))
  try {
    const target = join(dir, 'ledger.jsonl')
    await writeFile(target, '')
    const ac = new AbortController()
    ac.abort()
    await assert.rejects(
      () => acquireLedgerLockAsync(lockPathFor(target), { timeoutMs: 1_000, signal: ac.signal }),
      (error) => error.code === 'AGOS_LEDGER_LOCK_ABORTED',
    )
    // and the lock file must not exist: we never attempted to publish
    const { existsSync } = await import('node:fs')
    assert.equal(existsSync(lockPathFor(target)), false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('withLedgerLockAsync awaits an async callback and only then releases; the sync guard still fires on its own', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agos-lock-async-cb-'))
  try {
    const target = join(dir, 'ledger.jsonl')
    await writeFile(target, '')
    const events = []
    const result = await withLedgerLockAsync(target, async () => {
      events.push('entered')
      await new Promise((resolve) => setTimeout(resolve, 50))
      events.push('after-await')
      return 42
    })
    assert.equal(result, 42)
    assert.deepEqual(events, ['entered', 'after-await'])
    // lock released only after the callback settled: a second acquisition is instant
    const again = acquireLedgerLock(lockPathFor(target), { timeoutMs: 1_000, retryMs: 5 })
    releaseLedgerLock(again)

    // sync variant keeps refusing thenables (its thenable guard is untouched)
    assert.throws(
      () => withLedgerLock(target, async () => 1),
      /thenable/,
    )
    const held = acquireLedgerLock(lockPathFor(target), { timeoutMs: 1_000, retryMs: 5 })
    releaseLedgerLock(held)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('appendLineAsync appends durably through the async lock and re-reads whole', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agos-lock-async-append-'))
  try {
    const target = join(dir, 'ledger.jsonl')
    await writeFile(target, '')
    const holder = await holdLockElsewhere(target, 400)
    await appendLineAsync(target, { id: 'a1', kind: 'decision' })
    await appendLineAsync(target, { id: 'a2', kind: 'decision' })
    await holder.done
    const rows = readLedgerLines(target)
    assert.deepEqual(rows.map((row) => row.id), ['a1', 'a2'], 'no torn or lost record through the async path')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('reentrancy is shared between sync and async acquires in one process', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agos-lock-async-reentrant-'))
  try {
    const target = join(dir, 'ledger.jsonl')
    await writeFile(target, '')
    const outer = await acquireLedgerLockAsync(lockPathFor(target), { timeoutMs: 1_000 })
    // same process, same path, sync acquire inside an async hold: depth counter, no deadlock
    const inner = acquireLedgerLock(lockPathFor(target), { timeoutMs: 1_000 })
    releaseLedgerLock(inner)
    releaseLedgerLock(outer)
    const held = acquireLedgerLock(lockPathFor(target), { timeoutMs: 1_000 })
    releaseLedgerLock(held)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
