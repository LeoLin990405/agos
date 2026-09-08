import { randomUUID } from 'node:crypto'
import { scrubString } from '../../dsh-agos/lib/secrets-gate.js'

const MAX_BODY_BYTES = 512 * 1024
const MAX_ITEMS = 32
const MAX_ITEM_CHARS = 8000
const MAX_TIMEOUT_MS = 3_600_000
const MAX_LABEL_CHARS = 120
const DEFAULT_LIMIT = 30
const MAX_LIMIT = 100

const RUN_STATUSES = new Set([
  'queued', 'waking', 'running', 'detached',
  'completed', 'failed', 'cancelled', 'interrupted', 'lost',
])
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled', 'interrupted', 'lost'])

class FleetHttpError extends Error {
  constructor(status, code, message, detail = undefined) {
    super(message)
    this.name = 'FleetHttpError'
    this.status = status
    this.code = code
    this.detail = detail
  }
}

const plainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const clip = (value, max) => {
  const text = String(value ?? '')
  return text.length > max ? text.slice(0, max) : text
}

function defaultScrubSecrets(value) {
  return scrubString(value)
}

function scrubTree(value, scrubSecrets = defaultScrubSecrets, seen = new WeakSet()) {
  if (typeof value === 'string') return scrubSecrets(value)
  if (value === null || typeof value !== 'object') return value
  if (seen.has(value)) return undefined
  seen.add(value)
  if (Array.isArray(value)) return value.map((entry) => scrubTree(entry, scrubSecrets, seen))
  const clean = {}
  for (const [key, entry] of Object.entries(value)) clean[scrubSecrets(key)] = scrubTree(entry, scrubSecrets, seen)
  return clean
}

function validateDispatchBody(body) {
  if (!plainObject(body)) throw new FleetHttpError(400, 'INVALID_BODY', 'body must be a JSON object')
  if (!Array.isArray(body.items) || body.items.length < 1 || body.items.length > MAX_ITEMS) {
    throw new FleetHttpError(400, 'INVALID_ITEMS', `items must contain 1..${MAX_ITEMS} strings`)
  }
  const items = body.items.map((item, index) => {
    if (typeof item !== 'string' || item.trim().length === 0) {
      throw new FleetHttpError(400, 'INVALID_ITEM', `items[${index}] must be a non-empty string`)
    }
    if (item.length > MAX_ITEM_CHARS) {
      throw new FleetHttpError(400, 'ITEM_TOO_LONG', `items[${index}] exceeds ${MAX_ITEM_CHARS} characters`)
    }
    return item
  })

  let hosts
  if (body.hosts !== undefined) {
    if (!Array.isArray(body.hosts) || body.hosts.length === 0 || body.hosts.some((host) => typeof host !== 'string' || !host.trim())) {
      throw new FleetHttpError(400, 'INVALID_HOSTS', 'hosts must be a non-empty array of names')
    }
    hosts = [...new Set(body.hosts.map((host) => host.trim()))]
  }
  let tag
  if (body.tag !== undefined) {
    if (typeof body.tag !== 'string' || !body.tag.trim() || body.tag.length > 64) {
      throw new FleetHttpError(400, 'INVALID_TAG', 'tag must be a non-empty string of at most 64 characters')
    }
    tag = body.tag.trim()
  }
  if (body.wake !== undefined && typeof body.wake !== 'boolean') {
    throw new FleetHttpError(400, 'INVALID_WAKE', 'wake must be boolean')
  }
  let label
  if (body.label !== undefined) {
    if (typeof body.label !== 'string' || !body.label.trim() || body.label.length > MAX_LABEL_CHARS) {
      throw new FleetHttpError(400, 'INVALID_LABEL', `label must be a non-empty string of at most ${MAX_LABEL_CHARS} characters`)
    }
    label = body.label.trim()
  }
  let timeoutMs
  if (body.timeoutMs !== undefined) {
    if (!Number.isSafeInteger(body.timeoutMs) || body.timeoutMs < 1 || body.timeoutMs > MAX_TIMEOUT_MS) {
      throw new FleetHttpError(400, 'INVALID_TIMEOUT', `timeoutMs must be an integer from 1 to ${MAX_TIMEOUT_MS}`)
    }
    timeoutMs = body.timeoutMs
  }
  return { items, hosts, tag, wake: body.wake !== false, label, timeoutMs, pinned: hosts !== undefined }
}

function normalizeHosts(hosts) {
  const value = typeof hosts === 'function' ? hosts() : hosts
  return Array.isArray(value) ? value.filter((host) => host && host.enabled !== false) : []
}

function healthMap(value, candidates) {
  if (value instanceof Map) return value
  const map = new Map()
  const rows = Array.isArray(value) ? value : Array.isArray(value?.hosts) ? value.hosts : null
  if (rows) {
    for (const row of rows) if (row && (row.name || row.host)) map.set(String(row.name || row.host), row)
    return map
  }
  if (plainObject(value)) {
    for (const [name, row] of Object.entries(value)) map.set(name, row)
    return map
  }
  for (const host of candidates) map.set(host.name, { ok: host.ok === true })
  return map
}

function wakeStateOf(wake, host) {
  if (!wake) return undefined
  const name = typeof host === 'string' ? host : host?.name
  if (typeof wake.state === 'function') return wake.state(name)
  if (typeof wake.getState === 'function') return wake.getState(name)
  return undefined
}

function canWake(wake, host) {
  if (!wake) return false
  const name = typeof host === 'string' ? host : host?.name
  if (typeof wake.canWake === 'function') return wake.canWake(name) === true
  return false
}

async function requestWake(wake, hosts, context) {
  if (!hosts.length) return { requested: [], alreadyUp: [], noWakePath: [], budgetMs: {} }
  const request = typeof wake === 'function' ? wake : wake?.request
  if (typeof request !== 'function') return { requested: [], alreadyUp: [], noWakePath: hosts.map((host) => host.name), budgetMs: {} }
  const names = hosts.map((host) => typeof host === 'string' ? host : host.name)
  const result = await request.call(wake, names, context)
  return plainObject(result) ? result : { requested: hosts.map((host) => host.name), alreadyUp: [], noWakePath: [], budgetMs: {} }
}

function activeCount(runtime) {
  if (typeof runtime.activeCount === 'function') return Number(runtime.activeCount()) || 0
  if (typeof runtime.inflightCount === 'function') return Number(runtime.inflightCount()) || 0
  return Number(runtime.activeCount ?? runtime.inflight ?? 0) || 0
}

function maxConcurrency(runtime) {
  if (typeof runtime.maxConcurrency === 'function') return Number(runtime.maxConcurrency()) || 8
  return Number(runtime.maxConcurrency ?? runtime.globalMaxConcurrency ?? 8) || 8
}

async function assignHosts(runtime, hosts, count) {
  let liveRuns = []
  if (typeof runtime.listRuns === 'function') {
    const listed = await runtime.listRuns()
    liveRuns = Array.isArray(listed) ? listed : Array.isArray(listed?.runs) ? listed.runs : []
  }
  const load = new Map(hosts.map((host) => {
    const fromRuntime = typeof runtime.hostInflight === 'function' ? Number(runtime.hostInflight(host.name)) : NaN
    const observed = liveRuns.filter((run) => run.host === host.name && !TERMINAL_STATUSES.has(run.status)).length
    // hostInflight is normally active-only; listRuns also includes queued/waking
    // reservations. Use the larger truth so neither source can hide load.
    return [host.name, Number.isFinite(fromRuntime) ? Math.max(fromRuntime, observed) : observed]
  }))
  const assigned = []
  for (let index = 0; index < count; index++) {
    // Same least-inflight policy as scheduleAcross. Incrementing the virtual load
    // reserves this batch's queued assignments without pretending they are active.
    const host = [...hosts].sort((left, right) => {
      const leftRatio = (load.get(left.name) || 0) / Math.max(1, Number(left.maxConcurrency) || 3)
      const rightRatio = (load.get(right.name) || 0) / Math.max(1, Number(right.maxConcurrency) || 3)
      const ratioDelta = leftRatio - rightRatio
      if (ratioDelta) return ratioDelta
      return (load.get(left.name) || 0) - (load.get(right.name) || 0)
    })[0]
    assigned.push(host)
    load.set(host.name, (load.get(host.name) || 0) + 1)
  }
  return assigned
}

async function compensateDurableBatch(runtime, batchId, reason, detail = {}) {
  if (typeof runtime.cancelBatch !== 'function') {
    throw new FleetHttpError(500, 'DURABLE_COMPENSATION_UNAVAILABLE', 'durable batch could not be terminalized', { batchId, ...detail })
  }
  try {
    return await runtime.cancelBatch(batchId, reason)
  } catch {
    throw new FleetHttpError(500, 'DURABLE_COMPENSATION_FAILED', 'durable batch could not be terminalized', { batchId, ...detail })
  }
}

async function persistBatch(runtime, draft, { runDirOf }) {
  const records = draft.runs.map((run) => {
    const host = draft.hostRecords.find((candidate) => candidate.name === run.host)
    return {
      batchId: draft.batchId,
      runId: run.runId,
      index: run.index,
      host: run.host,
      kind: String(host?.kind || 'remote'),
      runDir: runDirOf(host, run.runId),
      model: String(host?.model || ''),
      origin: draft.origin,
      label: draft.label,
      // Runtime keeps item in memory, while its ledger adapter persists only scrubbed
      // prompt preview. Hydration restores that preview with itemTruncated:true.
      item: run.item,
      prompt: run.item,
      itemTruncated: false,
      status: run.status,
      pinned: draft.pinned,
      tag: draft.tag,
      wake: draft.wakeEnabled,
      at: draft.createdAt,
      createdAt: draft.createdAt,
      timeoutMs: draft.timeoutMs,
    }
  })
  if (typeof runtime.registerDispatchBatch === 'function') {
    // Concrete W2 path: the ledger publishes all dispatch lines with one
    // temp+fsync+rename barrier and mutates runtime state only after success.
    await runtime.registerDispatchBatch(records)
    return await runtime.getBatch?.(draft.batchId) || draft
  }
  if (typeof runtime.registerDispatch === 'function') {
    const registered = []
    try {
      for (const record of records) {
        await runtime.registerDispatch(record)
        registered.push(record.runId)
      }
    } catch (error) {
      // JSONL has no multi-event transaction. Terminalize any durable prefix so a
      // failed HTTP request cannot leave invisible queued work after restart.
      if (registered.length) await compensateDurableBatch(runtime, draft.batchId, 'dispatch persistence incomplete', { registeredRunIds: registered })
      throw error
    }
    return await runtime.getBatch?.(draft.batchId) || draft
  }
  if (typeof runtime.createBatch === 'function') return await runtime.createBatch(draft) || draft
  throw new Error('runtime.registerDispatch or runtime.createBatch is required')
}

function normalizeCancelResult(result, id, wasTerminal = false) {
  if (plainObject(result) && Array.isArray(result.cancelled) && Array.isArray(result.skipped)) return result
  if (result === false || result === undefined || result === null) return null
  if (plainObject(result) && typeof result.cancelled === 'boolean') {
    const runId = result.run?.runId || id
    return result.cancelled
      ? { cancelled: [runId], skipped: [] }
      : { cancelled: [], skipped: [{ runId, reason: String(result.reason || `already ${result.run?.status || 'settled'}`) }] }
  }
  if (wasTerminal) {
    return { cancelled: [], skipped: [{ runId: result.runId || id, reason: `already ${result.status}` }] }
  }
  return { cancelled: [plainObject(result) ? (result.runId || result.batchId || id) : id], skipped: [] }
}

function assertRunStatus(status) {
  if (!RUN_STATUSES.has(status)) throw new Error(`invalid fleet run status: ${String(status)}`)
  return status
}

function publicRun(run, { detail = false, scrubSecrets = defaultScrubSecrets } = {}) {
  const index = Number(run?.index) || 0
  const status = assertRunStatus(String(run?.status || 'queued'))
  const rawItem = run?.item ?? run?.prompt ?? ''
  const itemTruncated = run?.itemTruncated === true
  const result = {
    runId: String(run?.runId || ''),
    index,
    host: String(run?.host || ''),
    kind: String(run?.kind || ''),
    item: detail ? String(rawItem) : `#${index}`,
    prompt: clip(rawItem, 140),
    status,
    startedAt: run?.startedAt ?? null,
    endedAt: run?.endedAt ?? null,
    ms: run?.ms ?? null,
    error: run?.error ? String(run.error) : null,
    runDir: run?.runDir ? String(run.runDir) : null,
    hasTrace: typeof run?.hasTrace === 'boolean' ? run.hasTrace : null,
    traceLines: Number.isFinite(Number(run?.traceLines)) && run?.traceLines !== null && run?.traceLines !== undefined ? Number(run.traceLines) : null,
    artifactCount: Number.isFinite(Number(run?.artifactCount)) && run?.artifactCount !== null && run?.artifactCount !== undefined ? Number(run.artifactCount) : null,
    itemTruncated,
  }
  if (detail) result.resultText = clip(run?.resultText ?? run?.result ?? '', 12_000)
  return scrubTree(result, scrubSecrets)
}

function deriveBatchStatus(batch) {
  const statuses = (batch?.runs || []).map((run) => String(run.status || 'queued'))
  if (!statuses.length && ['running', 'completed', 'failed', 'cancelled'].includes(batch?.status)) return batch.status
  if (statuses.some((status) => !TERMINAL_STATUSES.has(status))) return 'running'
  if (statuses.length && statuses.every((status) => status === 'completed')) return 'completed'
  if (statuses.some((status) => ['failed', 'interrupted', 'lost'].includes(status))) return 'failed'
  if (statuses.some((status) => status === 'cancelled')) return 'cancelled'
  return 'running'
}

function publicBatch(batch, { includeRuns = false, detail = false, scrubSecrets = defaultScrubSecrets } = {}) {
  const runs = Array.isArray(batch?.runs) ? batch.runs : []
  const result = {
    batchId: String(batch?.batchId || ''),
    label: String(batch?.label || ''),
    createdAt: batch?.createdAt ?? null,
    origin: String(batch?.origin || 'ui'),
    status: deriveBatchStatus(batch),
    counts: {
      total: runs.length,
      completed: runs.filter((run) => run.status === 'completed').length,
      failed: runs.filter((run) => ['failed', 'interrupted', 'lost'].includes(run.status)).length,
      cancelled: runs.filter((run) => run.status === 'cancelled').length,
      active: runs.filter((run) => !TERMINAL_STATUSES.has(run.status)).length,
    },
  }
  if (includeRuns || detail) result.runs = runs.map((run) => publicRun(run, { detail, scrubSecrets }))
  return scrubTree(result, scrubSecrets)
}

async function readJsonBody(req) {
  const contentType = String(req.headers?.['content-type'] || '').split(';', 1)[0].trim().toLowerCase()
  if (contentType !== 'application/json') throw new FleetHttpError(415, 'UNSUPPORTED_MEDIA_TYPE', 'content-type must be application/json')
  const chunks = []
  let bytes = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    bytes += buffer.length
    if (bytes > MAX_BODY_BYTES) throw new FleetHttpError(413, 'BODY_TOO_LARGE', `body exceeds ${MAX_BODY_BYTES} bytes`)
    chunks.push(buffer)
  }
  if (!bytes) throw new FleetHttpError(400, 'EMPTY_BODY', 'body must not be empty')
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new FleetHttpError(400, 'INVALID_JSON', 'body must be valid JSON')
  }
}

function createFleetDispatchHandlers(options) {
  const {
    runtime,
    hosts,
    probe,
    wake,
    scrubSecrets = defaultScrubSecrets,
    now = Date.now,
    uuid = randomUUID,
    defer = queueMicrotask,
    logger = { warn() {} },
    runDirOf = (host, runId) => `${String(host?.workspace || '~/dsh-workspace').replace(/\/$/, '')}/tasks/${runId}`,
  } = options || {}
  if (!runtime) throw new TypeError('runtime is required')

  const send = (res, status, value, headers = {}) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers })
    res.end(JSON.stringify(scrubTree(value, scrubSecrets)))
  }
  const fail = (res, error) => {
    const known = error instanceof FleetHttpError
    send(res, known ? error.status : 500, {
      error: known ? error.message : 'fleet dispatch internal error',
      code: known ? error.code : 'INTERNAL_ERROR',
      ...(known && error.detail !== undefined ? { detail: error.detail } : {}),
    })
  }
  const method = (req, res, allowed) => {
    if (req.method === allowed) return true
    send(res, 405, { error: `${allowed} only`, code: 'METHOD_NOT_ALLOWED' }, { allow: allowed })
    return false
  }

  const dispatch = async (req, res) => {
    if (!method(req, res, 'POST')) return
    try {
      const input = validateDispatchBody(await readJsonBody(req))
      const configured = normalizeHosts(hosts)
      const byName = new Map(configured.map((host) => [String(host.name), host]))
      if (input.hosts) {
        const unknown = input.hosts.filter((name) => !byName.has(name))
        if (unknown.length) throw new FleetHttpError(404, 'HOST_NOT_FOUND', 'one or more hosts do not exist', { hosts: unknown })
        const local = input.hosts.filter((name) => byName.get(name)?.kind === 'local')
        if (local.length) throw new FleetHttpError(400, 'REMOTE_ONLY', 'UI dispatch only accepts remote or codex hosts', { hosts: local })
      }
      const explicitlyNamed = new Set(input.hosts || [])
      const codexOptIn = input.tag === 'codex'
      let candidates = (input.hosts ? input.hosts.map((name) => byName.get(name)) : configured)
        .filter((host) => host && (host.kind === 'remote' ||
          (host.kind === 'codex' && (codexOptIn || explicitlyNamed.has(String(host.name))))))
      if (input.tag) candidates = candidates.filter((host) => Array.isArray(host.tags) && host.tags.includes(input.tag))
      if (!candidates.length) throw new FleetHttpError(503, 'NO_CANDIDATE_HOST', 'no fleet host matches the selection')
      if (activeCount(runtime) >= maxConcurrency(runtime)) {
        throw new FleetHttpError(429, 'FLEET_BUSY', 'fleet global concurrency limit reached')
      }

      const probed = healthMap(typeof probe === 'function' ? await probe(candidates, { refresh: true }) : undefined, candidates)
      const healthy = candidates.filter((host) => probed.get(host.name)?.ok === true)
      const down = candidates.filter((host) => probed.get(host.name)?.ok !== true)
      const waking = down.filter((host) => host.kind === 'remote' && ['requested', 'probing', 'waking'].includes(String(wakeStateOf(wake, host)?.state || wakeStateOf(wake, host)?.wakeState || '')))
      if (input.pinned && waking.length) {
        const states = waking.map((host) => ({ host: host.name, etaMs: Number(wakeStateOf(wake, host)?.etaMs) || 0 }))
        throw new FleetHttpError(423, 'HOST_WAKING', 'one or more pinned hosts are already waking', { hosts: states })
      }
      if (input.pinned && down.length && !input.wake) {
        throw new FleetHttpError(409, 'PINNED_HOST_UNREACHABLE', 'a pinned host is unreachable and wake is disabled', { hosts: down.map((host) => host.name) })
      }
      const noWakePath = down.filter((host) => host.kind !== 'remote' || !canWake(wake, host))
      if (input.pinned && noWakePath.length) {
        throw new FleetHttpError(409, 'NO_WAKE_PATH', 'a pinned host has no wake path', { hosts: noWakePath.map((host) => host.name) })
      }

      const wakeable = input.wake ? down.filter((host) => host.kind === 'remote' && canWake(wake, host)) : []
      // Without an explicit host/tag selection, do not wake every configured machine merely
      // because it is offline. Healthy workers are sufficient; wake is for selected targets.
      const selectedWake = input.pinned || input.tag ? wakeable : (healthy.length ? [] : wakeable)
      if (!healthy.length && !selectedWake.length) throw new FleetHttpError(503, 'NO_HEALTHY_HOST', 'no healthy fleet host is available')

      const batchId = `b-${uuid()}`
      const createdAt = now()
      const requested = new Set(selectedWake.map((host) => host.name))
      const dispatchHosts = [...healthy, ...selectedWake]
      if (!dispatchHosts.length) throw new FleetHttpError(503, 'NO_HEALTHY_HOST', 'no healthy or waking fleet host is available')
      const assignments = await assignHosts(runtime, dispatchHosts, input.items.length)
      const plannedWake = {
        requested: selectedWake.map((host) => host.name),
        alreadyUp: healthy.map((host) => host.name),
        noWakePath: [],
        budgetMs: {},
      }
      const draft = {
        batchId,
        label: input.label || `Fleet ×${input.items.length}`,
        createdAt,
        origin: 'ui',
        wake: plannedWake,
        wakeEnabled: input.wake,
        timeoutMs: input.timeoutMs,
        pinned: input.pinned,
        tag: input.tag,
        hosts: dispatchHosts.map((host) => host.name),
        hostRecords: dispatchHosts,
        runs: input.items.map((item, index) => {
          const host = assignments[index]
          return {
            runId: `r-${uuid()}`,
            index: index + 1,
            host: host.name,
            kind: host.kind,
            item,
            status: requested.has(host.name) && probed.get(host.name)?.ok !== true ? 'waking' : 'queued',
            itemTruncated: false,
          }
        }),
      }
      // registerDispatch/createBatch is the durability barrier: all dispatch events
      // are appended/fsynced before WOL or any scheduler callback is started.
      const batch = await persistBatch(runtime, draft, { runDirOf })
      let wakeSummary
      try {
        const actualWake = await requestWake(wake, selectedWake, { batchId, pinned: input.pinned, source: 'dispatch' })
        wakeSummary = {
          requested: [...new Set(Array.isArray(actualWake.requested) ? actualWake.requested : [])],
          alreadyUp: [...new Set([...healthy.map((host) => host.name), ...(Array.isArray(actualWake.alreadyUp) ? actualWake.alreadyUp : [])])],
          noWakePath: [...new Set(Array.isArray(actualWake.noWakePath) ? actualWake.noWakePath : [])],
          budgetMs: plainObject(actualWake.budgetMs) ? actualWake.budgetMs : {},
        }
      } catch (error) {
        await compensateDurableBatch(runtime, batchId, 'wake request failed')
        const status = Number(error?.statusCode || error?.status)
        if ([400, 404, 409, 423, 429, 503].includes(status)) {
          throw new FleetHttpError(status, String(error?.code || 'WAKE_REQUEST_FAILED'), String(error?.message || 'wake request failed'), { batchId, ...(error?.etaMs !== undefined ? { etaMs: error.etaMs } : {}) })
        }
        throw error
      }
      const becameReady = new Set(Array.isArray(wakeSummary.alreadyUp) ? wakeSummary.alreadyUp : [])
      if (becameReady.size && typeof runtime.markQueued === 'function') {
        try {
          await Promise.all((batch.runs || draft.runs)
            .filter((run) => becameReady.has(run.host) && run.status === 'waking')
            .map((run) => runtime.markQueued(run.runId, { wakeState: 'ready' })))
        } catch {
          await compensateDurableBatch(runtime, batchId, 'wake-ready transition failed')
          throw new FleetHttpError(500, 'WAKE_TRANSITION_FAILED', 'wake state could not be persisted', { batchId })
        }
      }
      const reportedNoPath = new Set(Array.isArray(wakeSummary.noWakePath) ? wakeSummary.noWakePath : [])
      if (reportedNoPath.size) {
        const affected = (batch.runs || draft.runs).filter((run) => reportedNoPath.has(run.host))
        const readyNames = new Set([...healthy.map((host) => host.name), ...becameReady])
        // Immediate reroute is safe only to a host already known reachable. A
        // merely requested wake must retain `waking`, not be rewritten queued.
        const alternatives = dispatchHosts.filter((host) => readyNames.has(host.name) && !reportedNoPath.has(host.name))
        try {
          if (!input.pinned && alternatives.length && typeof runtime.rerouteRun === 'function') {
            const replacements = await assignHosts(runtime, alternatives, affected.length)
            await Promise.all(affected.map((run, index) => {
              const host = replacements[index]
              return runtime.rerouteRun(run.runId, {
                host: host.name,
                kind: host.kind,
                runDir: runDirOf(host, run.runId),
                model: String(host.model || ''),
              })
            }))
          } else {
            if (typeof runtime.markEnd !== 'function') throw new Error('runtime.markEnd is required for wake degradation')
            await Promise.all(affected.map((run) => runtime.markEnd(run.runId, { ok: false, error: 'NO_WAKE_PATH', endedAt: now() })))
          }
        } catch {
          await compensateDurableBatch(runtime, batchId, 'wake degradation transition failed')
          throw new FleetHttpError(500, 'WAKE_DEGRADATION_FAILED', 'wake degradation could not be persisted', { batchId })
        }
      }
      const responseBatch = await runtime.getBatch?.(batchId) || batch
      send(res, 202, {
        batchId: responseBatch.batchId,
        label: responseBatch.label,
        createdAt: responseBatch.createdAt,
        origin: 'ui',
        wake: wakeSummary,
        runs: (responseBatch.runs || draft.runs).map((run) => ({
          index: run.index,
          runId: run.runId,
          host: run.host,
          kind: run.kind || byName.get(run.host)?.kind || '',
          status: assertRunStatus(becameReady.has(run.host) && run.status === 'waking' ? 'queued' : (run.status || 'queued')),
          item: `#${run.index}`,
        })),
      })
      defer(() => {
        if (typeof runtime.wakePump === 'function') {
          Promise.resolve(runtime.wakePump(`ui-dispatch:${responseBatch.batchId}`)).catch((error) => {
            logger.warn?.(`fleet batch ${responseBatch.batchId} pump wake failed: ${defaultScrubSecrets(error?.message ?? error)}`)
          })
          return
        }
        const start = runtime.startBatch || runtime.dispatchBatch
        if (typeof start !== 'function') return
        Promise.resolve(start.call(runtime, responseBatch.batchId, { hosts: dispatchHosts, batch: responseBatch }))
          .catch((error) => {
            logger.warn?.(`fleet batch ${responseBatch.batchId} background start failed: ${defaultScrubSecrets(error?.message ?? error)}`)
            return runtime.failBatchStart?.(responseBatch.batchId, defaultScrubSecrets(error?.message ?? error))
          })
          .catch?.(() => {})
      })
    } catch (error) {
      fail(res, error)
    }
  }

  const batches = async (req, res) => {
    if (!method(req, res, 'GET')) return
    try {
      const url = new URL(req.url, 'http://fleet.local')
      const rawLimit = url.searchParams.get('limit')
      const limit = rawLimit === null ? DEFAULT_LIMIT : Number(rawLimit)
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
        throw new FleetHttpError(400, 'INVALID_LIMIT', `limit must be an integer from 1 to ${MAX_LIMIT}`)
      }
      const includeRuns = url.searchParams.get('include') === 'runs'
      if (typeof runtime.listBatches !== 'function') throw new Error('runtime.listBatches is required')
      const listed = await runtime.listBatches({ limit, includeRuns })
      const rows = Array.isArray(listed) ? listed : Array.isArray(listed?.batches) ? listed.batches : []
      send(res, 200, { at: now(), batches: rows.slice(0, limit).map((batch) => publicBatch(batch, { includeRuns, scrubSecrets })) })
    } catch (error) { fail(res, error) }
  }

  const batch = async (req, res) => {
    if (!method(req, res, 'GET')) return
    try {
      const id = new URL(req.url, 'http://fleet.local').searchParams.get('id')
      if (!id) throw new FleetHttpError(400, 'MISSING_BATCH_ID', 'id is required')
      if (typeof runtime.getBatch !== 'function') throw new Error('runtime.getBatch is required')
      const found = await runtime.getBatch(id)
      if (!found) throw new FleetHttpError(404, 'BATCH_NOT_FOUND', 'batch not found')
      send(res, 200, publicBatch(found, { detail: true, scrubSecrets }))
    } catch (error) { fail(res, error) }
  }

  const cancel = async (req, res) => {
    if (!method(req, res, 'POST')) return
    try {
      const body = await readJsonBody(req)
      if (!plainObject(body)) throw new FleetHttpError(400, 'INVALID_BODY', 'body must be a JSON object')
      const hasBatch = typeof body.batchId === 'string' && body.batchId.length > 0
      const hasRun = typeof body.runId === 'string' && body.runId.length > 0
      if (hasBatch === hasRun || (hasRun && (typeof body.host !== 'string' || !body.host))) {
        throw new FleetHttpError(400, 'INVALID_CANCEL_TARGET', 'provide either batchId or runId with host')
      }
      let result
      if (hasBatch) {
        if (typeof runtime.cancelBatch !== 'function') throw new Error('runtime.cancelBatch is required')
        if (typeof runtime.getBatch !== 'function') throw new Error('runtime.getBatch is required for safe batch cancellation')
        const before = await runtime.getBatch(body.batchId)
        if (!before) {
          throw new FleetHttpError(404, 'CANCEL_TARGET_NOT_FOUND', 'cancel target not found')
        }
        result = normalizeCancelResult(await runtime.cancelBatch(body.batchId, 'ui cancel'), body.batchId,
          before ? ['completed', 'failed', 'cancelled'].includes(deriveBatchStatus(before)) : false)
      } else {
        if (typeof runtime.cancelRun !== 'function') throw new Error('runtime.cancelRun is required')
        if (typeof runtime.getRun !== 'function') throw new Error('runtime.getRun is required for host-safe run cancellation')
        const before = await runtime.getRun(body.runId)
        if (!before || before.host !== body.host) throw new FleetHttpError(404, 'CANCEL_TARGET_NOT_FOUND', 'cancel target not found')
        result = normalizeCancelResult(await runtime.cancelRun(body.runId, 'ui cancel'), body.runId, before ? TERMINAL_STATUSES.has(before.status) : false)
      }
      if (result === undefined || result === null) throw new FleetHttpError(404, 'CANCEL_TARGET_NOT_FOUND', 'cancel target not found')
      send(res, 200, plainObject(result) ? result : { cancelled: [], skipped: [] })
    } catch (error) { fail(res, error) }
  }

  return { dispatch, batches, batch, cancel }
}

function registerFleetDispatchRoutes(webServer, options) {
  if (!webServer || typeof webServer.register !== 'function') return () => {}
  const handlers = createFleetDispatchHandlers(options)
  const routes = [
    ['/api/fleet/dispatch', handlers.dispatch],
    ['/api/fleet/batches', handlers.batches],
    ['/api/fleet/batch', handlers.batch],
    ['/api/fleet/cancel', handlers.cancel],
  ]
  const disposers = routes.map(([path, handler]) => webServer.register({ kind: 'exact', path, handler }))
  return () => {
    for (const dispose of disposers.reverse()) {
      try { dispose?.() } catch {}
    }
  }
}

export {
  FleetHttpError,
  RUN_STATUSES,
  TERMINAL_STATUSES,
  createFleetDispatchHandlers,
  defaultScrubSecrets,
  publicBatch,
  publicRun,
  registerFleetDispatchRoutes,
  scrubTree,
  validateDispatchBody,
}
