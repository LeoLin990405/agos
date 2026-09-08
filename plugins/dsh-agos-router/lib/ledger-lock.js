// Cross-process lock for route-outcome.jsonl.
//
// The router ledger is appended by every HTTP handler in lib/index.js through the
// *synchronous* appendLine(). dsh-fleet solves the same problem asynchronously
// (fleet-lock.mjs), but a promise-based lock cannot be dropped into a sync call
// site without rewriting every caller — including lib/index.js, which this package
// may not touch. So this is the same protocol, executed synchronously.
//
// Protocol (identical semantics to dsh-fleet/lib/fleet-lock.mjs so both ledgers
// agree on what "the owner is dead" means):
//   - the owner record is written to a private temp file, fsync'd, and published
//     to <path>.lock with link(2). A paused creator therefore never exposes an
//     empty lock file that a second process could steal by age.
//   - owner identity is { pid, startTime, token, host, identityFormat }, where
//     startTime is `ps -p <pid> -o lstart=` read under TZ=UTC/LC_ALL=C. A live pid
//     with a matching startTime is NEVER reclaimed, no matter how long it holds.
//     Locale-dependent legacy records (no identityFormat) cannot prove PID reuse,
//     so a live legacy pid is also retained.
//   - reclaiming a dead owner happens under a per-generation recovery lock, and
//     re-checks ino/dev/token after acquiring it. A late reaper therefore cannot
//     unlink the lock of a *new* live owner that took over in the meantime.
//
// Blocking is done with Atomics.wait on a private SharedArrayBuffer: it parks the
// thread without burning CPU and without an event-loop turn, which a sync API needs.
import {
  closeSync,
  fstatSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'
import { dirname, resolve } from 'node:path'

export const DEFAULT_LOCK_TIMEOUT_MS = 30_000
export const DEFAULT_LOCK_RETRY_MS = 5
export const OWNER_IDENTITY_FORMAT = 'ps-lstart-utc-c-v1'

export class LedgerLockError extends Error {
  constructor(message, extra = {}) {
    super(message)
    this.name = 'LedgerLockError'
    this.code = extra.code ?? 'AGOS_LEDGER_LOCK'
    if (extra.owner) this.owner = extra.owner
    if (extra.path) this.path = extra.path
  }
}

export function lockPathFor(targetPath) {
  return `${targetPath}.lock`
}

/** Park this thread without spinning. setTimeout is unusable inside a sync call. */
function sleepSync(ms) {
  if (!(ms > 0)) return
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

export function processIsAlive(pid) {
  const numeric = Number(pid)
  if (!Number.isInteger(numeric) || numeric <= 0) return false
  try {
    process.kill(numeric, 0)
    return true
  } catch (error) {
    return error?.code !== 'ESRCH'
  }
}

/** Canonical, locale-independent process start time; matches dsh-fleet exactly. */
export function processStartTime(pid) {
  try {
    const stdout = execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], {
      encoding: 'utf8',
      timeout: 2000,
      env: { ...process.env, TZ: 'UTC', LC_ALL: 'C', LANG: 'C' },
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    return String(stdout).trim() || null
  } catch {
    return null
  }
}

let cachedSelfStartTime
export function currentProcessStartTime() {
  if (cachedSelfStartTime) return cachedSelfStartTime
  cachedSelfStartTime = processStartTime(process.pid) ?? `pid:${process.pid}`
  return cachedSelfStartTime
}

/**
 * Same-thread reentrancy. appendLine() locks, and a read-modify-write caller wraps
 * several appendLine() calls in withLedgerLock(); without a depth counter the
 * second acquire would deadlock against this very process.
 */
const heldLocks = new Map()

function readOwner(path) {
  try {
    const text = readFileSync(path, 'utf8')
    const line = String(text).split('\n').find((entry) => entry.trim())
    if (!line) return null
    const owner = JSON.parse(line)
    return owner && typeof owner === 'object' ? owner : null
  } catch {
    return null
  }
}

function snapshot(path) {
  try {
    return { stat: statSync(path), owner: readOwner(path) }
  } catch (error) {
    if (error?.code === 'ENOENT') return { stat: null, owner: null }
    throw error
  }
}

function isStale(owner, stat, host) {
  if (!stat) return true
  // A malformed record cannot prove that its owner is dead; leave it alone.
  if (!owner || !Number.isInteger(Number(owner.pid)) || Number(owner.pid) <= 0
      || typeof owner.token !== 'string' || !/^[A-Za-z0-9_-]+$/.test(owner.token)) return false
  if (owner.host && owner.host !== host) return false
  const pid = Number(owner.pid)
  if (!processIsAlive(pid)) return true
  // A live pid still inside its declared hold window is the overwhelmingly common
  // case under contention. `ps` costs a fork per call, and the answer cannot change
  // the outcome here: a live owner with a matching start time is never reclaimed
  // either way. Defer the PID-reuse check until the hold window has actually lapsed.
  const held = Date.now() - Number(owner.acquiredAt ?? 0)
  const window = Number(owner.timeoutMs)
  if (Number.isFinite(window) && held >= 0 && held < window) return false
  // Legacy records carry a locale/timezone-dependent start time. Their text cannot
  // safely prove PID reuse under this canonical format, so a live pid is retained.
  if (owner.identityFormat !== OWNER_IDENTITY_FORMAT) return false
  const current = processStartTime(pid)
  if (current == null || !owner.startTime || owner.startTime === `pid:${pid}`) return false
  return current !== owner.startTime
}

function tryPublish(path, host, timeoutMs) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const owner = {
    pid: process.pid,
    startTime: currentProcessStartTime(),
    token: randomUUID(),
    identityFormat: OWNER_IDENTITY_FORMAT,
    acquiredAt: Date.now(),
    timeoutMs,
    host,
  }
  const temporary = `${path}.owner-${owner.token}`
  const fd = openSync(temporary, 'wx', 0o600)
  let published = false
  try {
    writeSync(fd, `${JSON.stringify(owner)}\n`, null, 'utf8')
    fsyncSync(fd)
    // link() publishes a *complete* record atomically.
    linkSync(temporary, path)
    published = true
    return { fd, owner, path }
  } finally {
    if (!published) { try { closeSync(fd) } catch {} }
    try { unlinkSync(temporary) } catch {}
  }
}

/**
 * Reclaim one dead owner generation. Serialized by its own lock and re-verified
 * afterwards, so a slow reaper cannot delete a new live owner's file.
 */
function recoverStale(path, expected, host, depth) {
  if (!expected.stat || !expected.owner?.token || depth > 4) return
  const recoveryPath = `${path}.recover-${expected.owner.token}`
  let recovery
  try {
    recovery = acquireLedgerLock(recoveryPath, { timeoutMs: 2_000, retryMs: 5, _depth: depth + 1 })
  } catch {
    return
  }
  try {
    const current = snapshot(path)
    if (current.stat?.ino !== expected.stat.ino || current.stat?.dev !== expected.stat.dev
        || current.owner?.token !== expected.owner.token
        || !isStale(current.owner, current.stat, host)) return
    try { unlinkSync(path) } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
  } finally {
    releaseLedgerLock(recovery)
  }
}

export function acquireLedgerLock(lockPath, options = {}) {
  const path = resolve(lockPath)
  const existing = heldLocks.get(path)
  if (existing) {
    existing.depth += 1
    return { path, reentrant: true }
  }
  const timeoutMs = Math.max(1, Number(options.timeoutMs) || DEFAULT_LOCK_TIMEOUT_MS)
  const retryMs = Math.max(1, Number(options.retryMs) || DEFAULT_LOCK_RETRY_MS)
  const host = options.host ?? hostname()
  const depth = Number.isInteger(options._depth) ? options._depth : 0
  const deadline = Date.now() + timeoutMs
  let delay = retryMs
  for (;;) {
    try {
      const held = tryPublish(path, host, timeoutMs)
      heldLocks.set(path, { ...held, depth: 1 })
      return { path, reentrant: false }
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
    }
    const current = snapshot(path)
    if (isStale(current.owner, current.stat, host)) {
      recoverStale(path, current, host, depth)
      if (Date.now() < deadline) continue
    }
    if (Date.now() >= deadline) {
      throw new LedgerLockError(`agos ledger lock timed out: ${path}`, {
        code: 'AGOS_LEDGER_LOCK_TIMEOUT',
        owner: current.owner,
        path,
      })
    }
    sleepSync(delay)
    delay = Math.min(Math.ceil(delay * 1.5), 50)
  }
}

/** Only unlink the lock if this process still owns that exact file (ino/dev + token). */
export function releaseLedgerLock(held) {
  if (!held) return
  const state = heldLocks.get(held.path)
  if (!state) return
  state.depth -= 1
  if (state.depth > 0) return
  heldLocks.delete(held.path)
  try {
    const fdStat = fstatSync(state.fd)
    const pathStat = statSync(held.path)
    if (fdStat.ino === pathStat.ino && fdStat.dev === pathStat.dev
        && readOwner(held.path)?.token === state.owner.token) {
      unlinkSync(held.path)
    }
  } catch {
    // ENOENT (already reaped) or a racing owner: never unlink someone else's lock.
  } finally {
    try { closeSync(state.fd) } catch {}
  }
}

/**
 * Run fn() while holding the ledger lock. Read-modify-write callers must wrap the
 * whole read → decide → append sequence, otherwise two processes both observe
 * "no prior outcome" and both append one.
 */
export function withLedgerLock(targetFile, fn, options = {}) {
  const held = acquireLedgerLock(lockPathFor(targetFile), options)
  try {
    const result = fn()
    // 取锁与放锁都是同步的,所以 fn 也必须是同步的:传 async 回调时 finally 会在
    // promise **创建**的那一刻就放锁,临界区静默失效 —— 而且现有测试一条都不会红。
    // 今天四个调用点的回调都是同步的,但 lib/index.js 把本函数作为 `transact` 注入出去,
    // 对调用方的承诺是「在锁内跑这个」;注入点迟早会拿到别人写的回调。
    // 因此把「只能同步」从注释变成可执行约束。由接线审查者指出(A3)。
    if (result && typeof result.then === 'function') {
      throw new TypeError(
        'withLedgerLock 的回调返回了 thenable:锁会在 promise 创建时就释放,临界区不成立。'
          + '请把 await 之前的读改写序列收敛成同步回调,或在锁外完成异步部分。',
      )
    }
    return result
  } finally {
    releaseLedgerLock(held)
  }
}
