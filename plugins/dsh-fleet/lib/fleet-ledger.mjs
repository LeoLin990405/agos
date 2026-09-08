import * as nodeFs from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { scrubSecrets as redactSecrets } from '../../dsh-agos/lib/secrets-gate.js'
import { createFleetLock, lockPathFor } from './fleet-lock.mjs'
import { taskFingerprint } from '../../dsh-agos-router/lib/task-fingerprint.mjs'

export { createFleetLock, lockPathFor, FleetLockError } from './fleet-lock.mjs'

export const DEFAULT_FLEET_LEDGER_PATH = join(homedir(), '.dsh', 'logs', 'fleet', 'runs.jsonl')
export const FLEET_LEDGER_VERSION = 1
export const DEFAULT_LEDGER_RETENTION_MS = 14 * 24 * 60 * 60 * 1000
export const DEFAULT_LEDGER_MIN_EVENTS = 500

const TERMINAL_REATTACH = new Set(['interrupted', 'lost'])

/** Recursively redact values before they reach either disk or an HTTP response. */
export function scrubSecrets(value, seen) {
  return redactSecrets(value, seen)
}

function clip(value, limit) {
  const text = String(value ?? '')
  return text.length > limit ? text.slice(0, limit) : text
}

function eventForDisk(input, now) {
  const source = scrubSecrets(input && typeof input === 'object' ? input : {})
  const event = { ...source, v: FLEET_LEDGER_VERSION, at: Number.isFinite(Number(source.at)) ? Number(source.at) : now }
  if (event.ev === 'dispatch') {
    // Match evidence, never authorization. Compute from full raw input before
    // scrubbing/preview clipping, and never trust a caller-supplied fingerprint.
    event.taskFingerprint = input.itemTruncated === true || input.promptTruncated === true
      ? null : taskFingerprint(input.prompt ?? input.item)
    const fullPrompt = String(source.prompt ?? source.item ?? '')
    event.prompt = clip(fullPrompt, 400)
    event.promptTruncated = source.itemTruncated === true || fullPrompt.length > 400
    delete event.item
  } else if ('prompt' in event) {
    event.prompt = clip(event.prompt, 400)
  }
  if ('error' in event) event.error = clip(event.error, 2000)
  if ('reason' in event) event.reason = clip(event.reason, 2000)
  if ('resultText' in event) event.resultText = clip(event.resultText, 200000)
  return event
}

function isTerminalEvent(event) {
  return event?.ev === 'end' || event?.ev === 'cancel' ||
    (event?.ev === 'reattach' && TERMINAL_REATTACH.has(String(event.state)))
}

function parseLines(text, logger) {
  const events = []
  for (const line of String(text || '').split('\n')) {
    if (!line.trim()) continue
    try {
      const event = JSON.parse(line)
      if (event && typeof event === 'object') events.push(event)
    } catch (error) {
      logger?.warn?.(`[dsh-fleet/ledger] ignored malformed line: ${String(error?.message ?? error)}`)
    }
  }
  return events
}

function activeRunIds(events) {
  const state = new Map()
  for (const event of events) {
    if (!event?.runId) continue
    if (event.ev === 'dispatch' || event.ev === 'start' || event.ev === 'detach' ||
        event.ev === 'queue' || event.ev === 'wake' || event.ev === 'reroute' ||
        (event.ev === 'reattach' && !TERMINAL_REATTACH.has(String(event.state)))) {
      state.set(String(event.runId), true)
    }
    if (isTerminalEvent(event)) state.set(String(event.runId), false)
  }
  return new Set([...state].filter(([, active]) => active).map(([runId]) => runId))
}

export function selectCompactedEvents(events, options = {}) {
  const now = typeof options.now === 'function' ? options.now() : (Number(options.now) || Date.now())
  const retentionMs = Math.max(0, Number.isFinite(Number(options.retentionMs)) ? Number(options.retentionMs) : DEFAULT_LEDGER_RETENTION_MS)
  const minEvents = Math.max(0, Number.isFinite(Number(options.minEvents)) ? Number(options.minEvents) : DEFAULT_LEDGER_MIN_EVENTS)
  const cutoff = now - retentionMs
  const tailStart = Math.max(0, events.length - minEvents)
  const active = activeRunIds(events)
  return events.filter((event, index) => {
    const recent = Number.isFinite(Number(event?.at)) && Number(event.at) >= cutoff
    const inTail = index >= tailStart
    const activeChain = event?.runId && active.has(String(event.runId))
    return recent || inTail || activeChain
  })
}

export class FleetLedger {
  constructor(options = {}) {
    this.path = options.path ?? DEFAULT_FLEET_LEDGER_PATH
    this.fs = options.fs ?? nodeFs
    this.now = typeof options.now === 'function' ? options.now : Date.now
    this.makeId = typeof options.makeId === 'function' ? options.makeId : randomUUID
    this.logger = options.logger
    this.retentionMs = options.retentionMs ?? DEFAULT_LEDGER_RETENTION_MS
    this.minEvents = options.minEvents ?? DEFAULT_LEDGER_MIN_EVENTS
    this.autoCompact = options.autoCompact !== false
    this.lockPath = options.lockPath ?? lockPathFor(this.path)
    this.lock = options.lock ?? createFleetLock({
      path: this.lockPath,
      fs: this.fs,
      timeoutMs: options.lockTimeoutMs,
      logger: this.logger,
    })
    this.writeTail = Promise.resolve()
    this.ready = this._initialize()
  }

  async _mkdir() {
    const directory = dirname(this.path)
    await this.fs.mkdir(directory, { recursive: true, mode: 0o700 })
    try { await this.fs.chmod(directory, 0o700) } catch {}
  }

  async _readUnlocked() {
    try { return parseLines(await this.fs.readFile(this.path, 'utf8'), this.logger) }
    catch (error) {
      if (error?.code === 'ENOENT') return []
      throw error
    }
  }

  async _initialize() {
    await this._mkdir()
    if (this.autoCompact) await this._withLock(() => this._compactUnlocked())
    else {
      try { await this.fs.chmod(this.path, 0o600) } catch (error) { if (error?.code !== 'ENOENT') throw error }
    }
  }

  _enqueue(operation) {
    const result = this.writeTail.then(operation, operation)
    this.writeTail = result.catch(() => {})
    return result
  }

  async _withLock(operation) {
    if (this.lock && typeof this.lock.withLock === 'function') return this.lock.withLock(operation)
    return operation()
  }

  async _appendUnlocked(event) {
    await this._mkdir()
    const handle = await this.fs.open(this.path, 'a', 0o600)
    try {
      await handle.chmod(0o600)
      await handle.writeFile(JSON.stringify(event) + '\n', 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    return event
  }

  async append(input) {
    await this.ready
    const event = eventForDisk(input, this.now())
    return this._enqueue(() => this._withLock(() => this._appendUnlocked(event)))
  }

  /**
   * Append a dispatch set as one atomic file publication. JSONL has no native
   * transaction; a temp+fsync+rename prevents a disk-full error from exposing
   * only the first N runs of one accepted batch.
   */
  async appendMany(inputs) {
    await this.ready
    const events = (Array.isArray(inputs) ? inputs : []).map((input) => eventForDisk(input, this.now()))
    if (!events.length) return []
    return this._enqueue(() => this._withLock(async () => {
      await this._mkdir()
      let existing = ''
      try { existing = await this.fs.readFile(this.path, 'utf8') }
      catch (error) { if (error?.code !== 'ENOENT') throw error }
      if (existing && !existing.endsWith('\n')) existing += '\n'
      const payload = existing + events.map((event) => JSON.stringify(event)).join('\n') + '\n'
      const temporary = join(dirname(this.path), `.runs-append.${this.makeId()}.tmp`)
      let handle
      try {
        handle = await this.fs.open(temporary, 'w', 0o600)
        await handle.chmod(0o600)
        await handle.writeFile(payload, 'utf8')
        await handle.sync()
        await handle.close()
        handle = null
        await this.fs.rename(temporary, this.path)
        await this.fs.chmod(this.path, 0o600)
        await this._syncDirectory()
        return events
      } catch (error) {
        try { await handle?.close() } catch {}
        try { await this.fs.unlink(temporary) } catch {}
        throw error
      }
    }))
  }

  /** A named durability barrier used to make dispatch-before-spawn auditable. */
  async appendDispatchBeforeSpawn(record, spawn) {
    const event = await this.append({ ...record, ev: 'dispatch' })
    return typeof spawn === 'function' ? spawn(event) : event
  }

  async appendDispatchBatchBeforeSpawn(records, spawn) {
    const events = await this.appendMany(records.map((record) => ({ ...record, ev: 'dispatch' })))
    return typeof spawn === 'function' ? spawn(events) : events
  }

  async load() {
    await this.ready
    await this.writeTail
    return this._withLock(() => this._readUnlocked())
  }

  async _syncDirectory() {
    let handle
    try {
      handle = await this.fs.open(dirname(this.path), 'r')
      await handle.sync()
    } catch {
      // Directory fsync is not implemented by every supported filesystem.
    } finally {
      try { await handle?.close() } catch {}
    }
  }

  async _compactUnlocked() {
    await this._mkdir()
    const events = await this._readUnlocked()
    const retained = selectCompactedEvents(events, { now: this.now, retentionMs: this.retentionMs, minEvents: this.minEvents })
    const temporary = join(dirname(this.path), `.runs.${this.makeId()}.tmp`)
    let handle
    try {
      handle = await this.fs.open(temporary, 'w', 0o600)
      await handle.chmod(0o600)
      const payload = retained.length ? retained.map((event) => JSON.stringify(event)).join('\n') + '\n' : ''
      await handle.writeFile(payload, 'utf8')
      await handle.sync()
      await handle.close()
      handle = null
      await this.fs.rename(temporary, this.path)
      await this.fs.chmod(this.path, 0o600)
      await this._syncDirectory()
      return { before: events.length, after: retained.length }
    } catch (error) {
      try { await handle?.close() } catch {}
      try { await this.fs.unlink(temporary) } catch {}
      throw error
    }
  }

  async compact() {
    await this.ready
    return this._enqueue(() => this._withLock(() => this._compactUnlocked()))
  }

  async drain() {
    await this.ready
    await this.writeTail
  }

  async close() { await this.drain() }
}

export function createFleetLedger(options) { return new FleetLedger(options) }
