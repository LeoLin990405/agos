import * as nodeFs from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'
import { dirname } from 'node:path'

/**
 * Cross-process ledger lock for a local single-user deploy.
 *
 * Chosen primitive: an atomically published hard link to a complete owner file
 * at `<ledgerPath>.lock`, with owner `{ pid, startTime, token, acquiredAt, timeoutMs }`.
 *
 * Why not flock(): Node `fs/promises` has no portable `flock()`, and macOS
 * does not ship Linux `flock(1)`. Exclusive create is atomic on local POSIX
 * filesystems and needs no native addon.
 *
 * Stale / crash recovery: a lock is reclaimable only when the owner pid is
 * dead, or alive with a different `ps -p <pid> -o lstart=` (PID reuse).
 * A live owner with a matching startTime is never stolen, even after
 * `timeoutMs`. Waiters give up with FleetLockError after `timeoutMs`.
 *
 * File append is not a transaction: callers still hold this lock across
 * read-modify-rename (`appendMany` / `compact`) and fsync-before-publish.
 */

export const DEFAULT_LOCK_TIMEOUT_MS = 30_000
export const DEFAULT_LOCK_RETRY_MS = 20
export const DEFAULT_OWNER_WRITE_GRACE_MS = 2_000

export function lockPathFor(targetPath) {
  return `${targetPath}.lock`
}

export class FleetLockError extends Error {
  constructor(message, extra = {}) {
    super(message)
    this.name = 'FleetLockError'
    this.code = extra.code ?? 'FLEET_LOCK'
    if (extra.owner) this.owner = extra.owner
    if (extra.path) this.path = extra.path
  }
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

export function processStartTime(pid) {
  try {
    const stdout = execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], {
      encoding: 'utf8',
      timeout: 2000,
      env: { ...process.env, TZ: 'UTC', LC_ALL: 'C', LANG: 'C' },
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    const text = String(stdout).trim()
    return text || null
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export class FleetLock {
  constructor(options = {}) {
    if (!options.path) throw new FleetLockError('fleet lock path is required', { code: 'FLEET_LOCK_PATH' })
    this.path = options.path
    this.fs = options.fs ?? nodeFs
    this.timeoutMs = Math.max(1, Number(options.timeoutMs) || DEFAULT_LOCK_TIMEOUT_MS)
    this.retryMs = Math.max(1, Number(options.retryMs) || DEFAULT_LOCK_RETRY_MS)
    this.ownerWriteGraceMs = Math.max(0, Number.isFinite(Number(options.ownerWriteGraceMs))
      ? Number(options.ownerWriteGraceMs)
      : DEFAULT_OWNER_WRITE_GRACE_MS)
    this.logger = options.logger
    this.makeToken = typeof options.makeToken === 'function' ? options.makeToken : randomUUID
    this.pid = Number.isInteger(options.pid) ? options.pid : process.pid
    this.startTime = options.startTime ?? currentProcessStartTime()
    this.isAlive = typeof options.isAlive === 'function' ? options.isAlive : processIsAlive
    this.readStartTime = typeof options.readStartTime === 'function' ? options.readStartTime : processStartTime
    this.host = options.host ?? hostname()
    this.recoveryOptions = options
  }

  async withLock(operation) {
    const held = await this.acquire()
    try {
      return await operation(held)
    } finally {
      await this.release(held)
    }
  }

  async acquire() {
    const deadline = Date.now() + this.timeoutMs
    let delay = this.retryMs
    while (true) {
      try {
        return await this._tryAcquire()
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error
      }
      const snapshot = await this._snapshot()
      if (this._isStale(snapshot.owner, snapshot.stat)) {
        await this._recoverStale(snapshot)
        if (Date.now() < deadline) continue
      }
      if (Date.now() >= deadline) {
        throw new FleetLockError(`fleet lock timed out: ${this.path}`, {
          code: 'FLEET_LOCK_TIMEOUT',
          owner: snapshot.owner,
          path: this.path,
        })
      }
      await sleep(delay)
      delay = Math.min(Math.ceil(delay * 1.5), 100)
    }
  }

  async release(held) {
    if (!held?.handle || held.released) return
    held.released = true
    try {
      if (await this._stillOwns(held)) {
        try { await this.fs.unlink(this.path) } catch (error) {
          if (error?.code !== 'ENOENT') throw error
        }
      }
    } finally {
      try { await held.handle.close() } catch {}
    }
  }

  async _mkdir() {
    const directory = dirname(this.path)
    await this.fs.mkdir(directory, { recursive: true, mode: 0o700 })
  }

  async _tryAcquire() {
    await this._mkdir()
    const owner = {
      pid: this.pid, startTime: this.startTime, token: this.makeToken(),
      identityFormat: 'ps-lstart-utc-c-v1',
      acquiredAt: Date.now(), timeoutMs: this.timeoutMs, host: this.host,
    }
    const temporary = `${this.path}.owner-${owner.token}`
    const handle = await this.fs.open(temporary, 'wx', 0o600)
    let published = false
    try {
      await handle.chmod(0o600)
      await handle.writeFile(`${JSON.stringify(owner)}\n`, 'utf8')
      await handle.sync()
      // link publishes a complete owner record exclusively; a paused creator
      // never exposes an empty lock that another process may steal by age.
      await this.fs.link(temporary, this.path)
      published = true
      return { handle, owner, path: this.path }
    } finally {
      if (!published) await handle.close().catch(() => {})
      await this.fs.unlink(temporary).catch(() => {})
    }
  }

  async _snapshot() {
    let handle
    try {
      handle = await this.fs.open(this.path, 'r')
      const stat = await handle.stat()
      const contents = await handle.readFile('utf8')
      let owner = null
      try { owner = JSON.parse(contents) } catch {}
      return { stat, owner }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
      return { stat: null, owner: null }
    } finally {
      await handle?.close().catch(() => {})
    }
  }

  async _readOwner() {
    try {
      const text = await this.fs.readFile(this.path, 'utf8')
      const line = String(text).split('\n').find((entry) => entry.trim())
      if (!line) return null
      const owner = JSON.parse(line)
      return owner && typeof owner === 'object' ? owner : null
    } catch (error) {
      if (error?.code === 'ENOENT') return null
      return null
    }
  }

  _isStale(owner, stat) {
    if (!stat) return true
    // Malformed legacy records cannot prove that their owner is dead.
    if (!owner || !Number.isInteger(Number(owner.pid)) || Number(owner.pid) <= 0 ||
        typeof owner.token !== 'string' || !/^[A-Za-z0-9_-]+$/.test(owner.token)) return false
    if (owner.host && owner.host !== this.host) return false
    const pid = Number(owner.pid)
    if (!this.isAlive(pid)) return true
    // Old records used the caller's locale/timezone. Their text cannot safely
    // prove PID reuse under this canonical format; a live legacy PID is retained.
    if (owner.identityFormat !== 'ps-lstart-utc-c-v1') return false
    const currentStart = this.readStartTime(pid)
    if (currentStart == null || !owner.startTime || owner.startTime === `pid:${pid}`) return false
    return currentStart !== owner.startTime
  }

  async _recoverStale(expected) {
    if (!expected.stat || !expected.owner?.token) return
    // Serialize reapers of this owner generation. After acquiring the recovery
    // lock, re-read identity: a late reaper must not unlink a new live owner.
    // Crashed recovery owners are handled recursively by the same protocol.
    const recovery = new FleetLock({
      ...this.recoveryOptions,
      path: `${this.path}.recover-${expected.owner.token}`,
      fs: this.fs,
    })
    await recovery.withLock(async () => {
      const current = await this._snapshot()
      if (current.stat?.ino !== expected.stat.ino || current.stat?.dev !== expected.stat.dev ||
          current.owner?.token !== expected.owner.token || !this._isStale(current.owner, current.stat)) return
      try { await this.fs.unlink(this.path) } catch (error) {
        if (error?.code !== 'ENOENT') throw error
      }
    })
  }

  async _stillOwns(held) {
    try {
      const fdStat = await held.handle.stat()
      const pathStat = await this.fs.stat(this.path)
      if (fdStat.ino !== pathStat.ino || fdStat.dev !== pathStat.dev) return false
      const owner = await this._readOwner()
      return owner?.token === held.owner.token
    } catch (error) {
      if (error?.code === 'ENOENT') return false
      this.logger?.warn?.(`[dsh-fleet/lock] release check failed: ${String(error?.message ?? error)}`)
      return false
    }
  }
}

export function createFleetLock(options) {
  return new FleetLock(options)
}
