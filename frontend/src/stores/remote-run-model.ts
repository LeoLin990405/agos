export const FLEET_RUN_STATUSES = [
  'queued',
  'waking',
  'running',
  'detached',
  'completed',
  'failed',
  'cancelled',
  'interrupted',
  'lost',
] as const

export type FleetRunStatus = typeof FLEET_RUN_STATUSES[number]
export type FleetBatchStatus = 'running' | 'completed' | 'failed' | 'cancelled'
/** Remote outcome deliberately preserves every durable runtime state. */
export type RemoteRunOutcome = FleetRunStatus

export interface FleetRun {
  runId: string
  index: number
  host: string
  item: string
  prompt: string
  status: FleetRunStatus
  startedAt: number | null
  endedAt: number | null
  ms: number | null
  error: string | null
  runDir: string | null
  hasTrace: boolean | null
  traceLines: number | null
  artifactCount: number | null
  itemTruncated: boolean
  resultText?: string
}

export interface FleetBatchCounts {
  total: number
  completed: number
  failed: number
  cancelled: number
  active: number
}

export interface FleetBatch {
  batchId: string
  label: string
  createdAt: number | null
  origin: string
  status: FleetBatchStatus
  counts: FleetBatchCounts
  runs?: FleetRun[]
}

export interface FleetHostRun {
  runId: string
  batchId: string
  index: number
  prompt: string
  status: FleetRunStatus
  startedAt?: number
  endedAt?: number
  error?: string
}

export interface FleetHost {
  name: string
  /**
   * 2026-08-23(Leo 拍板,冻结层唯一改动):宿主自 08-21 起会吐 kind:'codex' 等新种类,这里原来对
   * local/remote 之外直接 throw,整个机器列表跟着挂(FleetView「暂不可用」、派发弹窗零候选)。
   * 现在原样放行任意非空种类,由各消费者按 === 'remote' 自己筛(DispatchModal/FleetView 已如此)。
   */
  kind: 'local' | 'remote' | (string & {})
  model: string
  tags: string[]
  maxConcurrency: number
  enabled: boolean
  ok: boolean
  probedAt: number
  version?: string
  error?: string
  inflight: number
  currentTask: string | null
  runs: FleetHostRun[]
  workspaceDir?: string
  wsFiles?: number | null
}

export interface FleetPowerNode {
  host: string
  node: string | null
  reachability: string
  reachabilityAt: number
  reachabilityError: string | null
  reachable: boolean
  wakeState: string
  wakeStartedAt: number
  wakeDeadlineAt: number
  etaMs: number
  wakeError: string | null
  smokeState: string
  smokeAt: number
  smokeError: string | null
  sleepState: string
  sleepError: string | null
  wokenByBatchId: string | null
  idleSleepEligible: boolean
  guarded: boolean
}

export interface FleetTraceRun {
  runId: string
  mtime: number
  file: string
}

export interface FleetTracePage {
  host: string
  runId: string | null
  file: string | null
  from: number
  nextFrom: number
  total: number
  truncated: boolean
  lines: string[]
  runs: FleetTraceRun[]
  notice?: 'trace-not-created'
}

export interface FleetArtifact {
  path: string
  size: number
  mtime: number
  binary: boolean
}

export interface FleetArtifactsManifest {
  host: string
  runId: string
  runDir: string
  files: FleetArtifact[]
  totalBytes: number
  count: number
  truncated: boolean
  excluded: string[]
}

export interface FleetWakeResult {
  requested: string[]
  alreadyUp: string[]
  noWakePath: string[]
  budgetMs: Record<string, number>
  states: FleetPowerNode[]
}

export type FleetWakeSummary = Omit<FleetWakeResult, 'states'>

export interface FleetCancelResult {
  cancelled: string[]
  skipped: { runId: string, reason: string }[]
}

export interface FleetSleepResult {
  ok: boolean
  host: string
  node: string
  ledgerPersisted?: boolean
  ledgerError?: string
  error?: string
}

export interface FleetPreflightProbe {
  ok: boolean
  at?: number
  version?: string
  error?: string
}

export interface FleetPreflightSmoke {
  ok: boolean
  skipped?: boolean
  cached?: boolean
  code?: string | null
  error?: string | null
}

export interface FleetPreflightHost {
  host: string
  reachable: boolean
  probe: FleetPreflightProbe
  smoke: FleetPreflightSmoke
}

export interface FleetPreflightResult {
  at: number
  hosts: FleetPreflightHost[]
}

export interface FleetDispatchResult {
  batchId: string
  label: string
  createdAt: number
  origin: string
  wake: FleetWakeSummary
  runs: { index: number, runId: string, host: string, status: FleetRunStatus, item: string }[]
}

type JsonObject = Record<string, unknown>

function object(value: unknown, label: string): JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`)
  }
  return value as JsonObject
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`)
  return value
}

function string(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new TypeError(`${label} must be a string`)
  return value
}

function nonEmptyString(value: unknown, label: string): string {
  const result = string(value, label)
  if (result === '') throw new TypeError(`${label} must not be empty`)
  return result
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new TypeError(`${label} must be boolean`)
  return value
}

function finiteNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new TypeError(`${label} must be a finite number`)
  return value
}

function nonNegativeInteger(value: unknown, label: string): number {
  const result = finiteNumber(value, label)
  if (!Number.isSafeInteger(result) || result < 0) throw new TypeError(`${label} must be a non-negative integer`)
  return result
}

function nullableNumber(value: unknown, label: string): number | null {
  return value === null ? null : finiteNumber(value, label)
}

function nullableString(value: unknown, label: string): string | null {
  return value === null ? null : string(value, label)
}

function nullableBoolean(value: unknown, label: string): boolean | null {
  return value === null ? null : boolean(value, label)
}

function stringArray(value: unknown, label: string): string[] {
  return array(value, label).map((entry, index) => string(entry, `${label}[${index}]`))
}

function optionalString(value: unknown, label: string): string | undefined {
  return value === undefined ? undefined : string(value, label)
}

function optionalNumber(value: unknown, label: string): number | undefined {
  return value === undefined ? undefined : finiteNumber(value, label)
}

function runStatus(value: unknown, label: string): FleetRunStatus {
  const status = string(value, label)
  if (!(FLEET_RUN_STATUSES as readonly string[]).includes(status)) throw new TypeError(`${label} is not a fleet run status`)
  return status as FleetRunStatus
}

function batchStatus(value: unknown, label: string): FleetBatchStatus {
  const status = string(value, label)
  if (!['running', 'completed', 'failed', 'cancelled'].includes(status)) throw new TypeError(`${label} is not a fleet batch status`)
  return status as FleetBatchStatus
}

export function parseFleetRun(value: unknown, detail = false): FleetRun {
  const row = object(value, 'run')
  const result: FleetRun = {
    runId: nonEmptyString(row['runId'], 'run.runId'),
    index: nonNegativeInteger(row['index'], 'run.index'),
    host: nonEmptyString(row['host'], 'run.host'),
    item: string(row['item'], 'run.item'),
    prompt: string(row['prompt'], 'run.prompt'),
    status: runStatus(row['status'], 'run.status'),
    startedAt: nullableNumber(row['startedAt'], 'run.startedAt'),
    endedAt: nullableNumber(row['endedAt'], 'run.endedAt'),
    ms: nullableNumber(row['ms'], 'run.ms'),
    error: nullableString(row['error'], 'run.error'),
    runDir: nullableString(row['runDir'], 'run.runDir'),
    hasTrace: nullableBoolean(row['hasTrace'], 'run.hasTrace'),
    traceLines: row['traceLines'] === null ? null : nonNegativeInteger(row['traceLines'], 'run.traceLines'),
    artifactCount: row['artifactCount'] === null ? null : nonNegativeInteger(row['artifactCount'], 'run.artifactCount'),
    itemTruncated: boolean(row['itemTruncated'], 'run.itemTruncated'),
  }
  if (detail) result.resultText = string(row['resultText'], 'run.resultText')
  return result
}

export function parseFleetBatch(value: unknown, detail = false): FleetBatch {
  const row = object(value, 'batch')
  const rawCounts = object(row['counts'], 'batch.counts')
  const result: FleetBatch = {
    batchId: nonEmptyString(row['batchId'], 'batch.batchId'),
    label: string(row['label'], 'batch.label'),
    createdAt: nullableNumber(row['createdAt'], 'batch.createdAt'),
    origin: string(row['origin'], 'batch.origin'),
    status: batchStatus(row['status'], 'batch.status'),
    counts: {
      total: nonNegativeInteger(rawCounts['total'], 'batch.counts.total'),
      completed: nonNegativeInteger(rawCounts['completed'], 'batch.counts.completed'),
      failed: nonNegativeInteger(rawCounts['failed'], 'batch.counts.failed'),
      cancelled: nonNegativeInteger(rawCounts['cancelled'], 'batch.counts.cancelled'),
      active: nonNegativeInteger(rawCounts['active'], 'batch.counts.active'),
    },
  }
  if (row['runs'] !== undefined) result.runs = array(row['runs'], 'batch.runs').map((entry) => parseFleetRun(entry, detail))
  return result
}

export function parseFleetBatchesResponse(value: unknown): { at: number, batches: FleetBatch[] } {
  const root = object(value, 'fleet batches response')
  return {
    at: finiteNumber(root['at'], 'fleet batches response.at'),
    batches: array(root['batches'], 'fleet batches response.batches').map((entry) => parseFleetBatch(entry)),
  }
}

export function parseFleetBatchResponse(value: unknown): FleetBatch {
  return parseFleetBatch(value, true)
}

function parseHostRun(value: unknown, label: string): FleetHostRun {
  const row = object(value, label)
  return {
    runId: nonEmptyString(row['runId'], `${label}.runId`),
    batchId: nonEmptyString(row['batchId'], `${label}.batchId`),
    index: nonNegativeInteger(row['index'], `${label}.index`),
    prompt: string(row['prompt'], `${label}.prompt`),
    status: runStatus(row['status'], `${label}.status`),
    startedAt: optionalNumber(row['startedAt'], `${label}.startedAt`),
    endedAt: optionalNumber(row['endedAt'], `${label}.endedAt`),
    error: optionalString(row['error'], `${label}.error`),
  }
}

export function parseFleetHostsResponse(value: unknown): FleetHost[] {
  const root = object(value, 'fleet hosts response')
  return array(root['hosts'], 'fleet hosts response.hosts').map((entry, index) => {
    const label = `fleet hosts response.hosts[${index}]`
    const row = object(entry, label)
    const kind = nonEmptyString(row['kind'], `${label}.kind`)
    return {
      name: nonEmptyString(row['name'], `${label}.name`),
      kind,
      model: string(row['model'], `${label}.model`),
      tags: stringArray(row['tags'], `${label}.tags`),
      maxConcurrency: nonNegativeInteger(row['maxConcurrency'], `${label}.maxConcurrency`),
      enabled: boolean(row['enabled'], `${label}.enabled`),
      ok: boolean(row['ok'], `${label}.ok`),
      probedAt: finiteNumber(row['at'], `${label}.at`),
      version: optionalString(row['version'], `${label}.version`),
      error: optionalString(row['error'], `${label}.error`),
      inflight: nonNegativeInteger(row['inflight'], `${label}.inflight`),
      currentTask: nullableString(row['currentTask'], `${label}.currentTask`),
      runs: array(row['runs'], `${label}.runs`).map((run, runIndex) => parseHostRun(run, `${label}.runs[${runIndex}]`)),
      workspaceDir: optionalString(row['workspaceDir'], `${label}.workspaceDir`),
      wsFiles: row['wsFiles'] === undefined ? undefined : (row['wsFiles'] === null ? null : nonNegativeInteger(row['wsFiles'], `${label}.wsFiles`)),
    }
  })
}

export function parseFleetTracePage(value: unknown): FleetTracePage {
  const root = object(value, 'fleet trace response')
  const from = nonNegativeInteger(root['from'], 'fleet trace response.from')
  const nextFrom = nonNegativeInteger(root['nextFrom'], 'fleet trace response.nextFrom')
  const lines = stringArray(root['lines'], 'fleet trace response.lines')
  if (from < 1 || nextFrom !== from + lines.length) throw new TypeError('fleet trace response physical line offsets are inconsistent')
  const notice = optionalString(root['notice'], 'fleet trace response.notice')
  if (notice !== undefined && notice !== 'trace-not-created') throw new TypeError('fleet trace response.notice is unknown')
  return {
    host: nonEmptyString(root['host'], 'fleet trace response.host'),
    runId: nullableString(root['runId'], 'fleet trace response.runId'),
    file: nullableString(root['file'], 'fleet trace response.file'),
    from,
    nextFrom,
    total: nonNegativeInteger(root['total'], 'fleet trace response.total'),
    truncated: boolean(root['truncated'], 'fleet trace response.truncated'),
    lines,
    runs: array(root['runs'], 'fleet trace response.runs').map((entry, index) => {
      const row = object(entry, `fleet trace response.runs[${index}]`)
      return {
        runId: nonEmptyString(row['runId'], `fleet trace response.runs[${index}].runId`),
        mtime: finiteNumber(row['mtime'], `fleet trace response.runs[${index}].mtime`),
        file: nonEmptyString(row['file'], `fleet trace response.runs[${index}].file`),
      }
    }),
    ...(notice === undefined ? {} : { notice }),
  }
}

export function parseFleetArtifacts(value: unknown): FleetArtifactsManifest {
  const root = object(value, 'fleet artifacts response')
  return {
    host: nonEmptyString(root['host'], 'fleet artifacts response.host'),
    runId: nonEmptyString(root['runId'], 'fleet artifacts response.runId'),
    runDir: nonEmptyString(root['runDir'], 'fleet artifacts response.runDir'),
    files: array(root['files'], 'fleet artifacts response.files').map((entry, index) => {
      const row = object(entry, `fleet artifacts response.files[${index}]`)
      return {
        path: nonEmptyString(row['path'], `fleet artifacts response.files[${index}].path`),
        size: nonNegativeInteger(row['size'], `fleet artifacts response.files[${index}].size`),
        mtime: finiteNumber(row['mtime'], `fleet artifacts response.files[${index}].mtime`),
        binary: boolean(row['binary'], `fleet artifacts response.files[${index}].binary`),
      }
    }),
    totalBytes: nonNegativeInteger(root['totalBytes'], 'fleet artifacts response.totalBytes'),
    count: nonNegativeInteger(root['count'], 'fleet artifacts response.count'),
    truncated: boolean(root['truncated'], 'fleet artifacts response.truncated'),
    excluded: stringArray(root['excluded'], 'fleet artifacts response.excluded'),
  }
}

function parseWakeSummary(value: unknown): FleetWakeSummary {
  const root = object(value, 'fleet wake response')
  const rawBudget = object(root['budgetMs'], 'fleet wake response.budgetMs')
  const budgetMs: Record<string, number> = {}
  for (const [host, budget] of Object.entries(rawBudget)) budgetMs[host] = nonNegativeInteger(budget, `fleet wake response.budgetMs.${host}`)
  return {
    requested: stringArray(root['requested'], 'fleet wake response.requested'),
    alreadyUp: stringArray(root['alreadyUp'], 'fleet wake response.alreadyUp'),
    noWakePath: stringArray(root['noWakePath'], 'fleet wake response.noWakePath'),
    budgetMs,
  }
}

export function parseFleetWakeResult(value: unknown): FleetWakeResult {
  const root = object(value, 'fleet wake response')
  return {
    ...parseWakeSummary(root),
    states: array(root['states'], 'fleet wake response.states').map((entry, index) => parsePowerNode(entry, `fleet wake response.states[${index}]`)),
  }
}

export function parseFleetCancelResult(value: unknown): FleetCancelResult {
  const root = object(value, 'fleet cancel response')
  return {
    cancelled: stringArray(root['cancelled'], 'fleet cancel response.cancelled'),
    skipped: array(root['skipped'], 'fleet cancel response.skipped').map((entry, index) => {
      const row = object(entry, `fleet cancel response.skipped[${index}]`)
      return {
        runId: nonEmptyString(row['runId'], `fleet cancel response.skipped[${index}].runId`),
        reason: nonEmptyString(row['reason'], `fleet cancel response.skipped[${index}].reason`),
      }
    }),
  }
}

export function parseFleetSleepResult(value: unknown): FleetSleepResult {
  const root = object(value, 'fleet sleep response')
  return {
    ok: boolean(root['ok'], 'fleet sleep response.ok'),
    host: nonEmptyString(root['host'], 'fleet sleep response.host'),
    node: nonEmptyString(root['node'], 'fleet sleep response.node'),
    ...(root['ledgerPersisted'] === undefined ? {} : { ledgerPersisted: boolean(root['ledgerPersisted'], 'fleet sleep response.ledgerPersisted') }),
    ledgerError: optionalString(root['ledgerError'], 'fleet sleep response.ledgerError'),
    error: optionalString(root['error'], 'fleet sleep response.error'),
  }
}

export function parseFleetPreflightResult(value: unknown): FleetPreflightResult {
  const root = object(value, 'fleet preflight response')
  return {
    at: finiteNumber(root['at'], 'fleet preflight response.at'),
    hosts: array(root['hosts'], 'fleet preflight response.hosts').map((entry, index) => {
      const label = `fleet preflight response.hosts[${index}]`
      const row = object(entry, label)
      const rawProbe = object(row['probe'], `${label}.probe`)
      const rawSmoke = object(row['smoke'], `${label}.smoke`)
      return {
        host: nonEmptyString(row['host'], `${label}.host`),
        reachable: boolean(row['reachable'], `${label}.reachable`),
        probe: {
          ok: boolean(rawProbe['ok'], `${label}.probe.ok`),
          at: optionalNumber(rawProbe['at'], `${label}.probe.at`),
          version: optionalString(rawProbe['version'], `${label}.probe.version`),
          error: optionalString(rawProbe['error'], `${label}.probe.error`),
        },
        smoke: {
          ok: boolean(rawSmoke['ok'], `${label}.smoke.ok`),
          ...(rawSmoke['skipped'] === undefined ? {} : { skipped: boolean(rawSmoke['skipped'], `${label}.smoke.skipped`) }),
          ...(rawSmoke['cached'] === undefined ? {} : { cached: boolean(rawSmoke['cached'], `${label}.smoke.cached`) }),
          ...(rawSmoke['code'] === undefined ? {} : { code: nullableString(rawSmoke['code'], `${label}.smoke.code`) }),
          ...(rawSmoke['error'] === undefined ? {} : { error: nullableString(rawSmoke['error'], `${label}.smoke.error`) }),
        },
      }
    }),
  }
}

export function parseFleetDispatchResult(value: unknown): FleetDispatchResult {
  const root = object(value, 'fleet dispatch response')
  return {
    batchId: nonEmptyString(root['batchId'], 'fleet dispatch response.batchId'),
    label: string(root['label'], 'fleet dispatch response.label'),
    createdAt: finiteNumber(root['createdAt'], 'fleet dispatch response.createdAt'),
    origin: string(root['origin'], 'fleet dispatch response.origin'),
    wake: parseWakeSummary(root['wake']),
    runs: array(root['runs'], 'fleet dispatch response.runs').map((entry, index) => {
      const row = object(entry, `fleet dispatch response.runs[${index}]`)
      return {
        index: nonNegativeInteger(row['index'], `fleet dispatch response.runs[${index}].index`),
        runId: nonEmptyString(row['runId'], `fleet dispatch response.runs[${index}].runId`),
        host: nonEmptyString(row['host'], `fleet dispatch response.runs[${index}].host`),
        status: runStatus(row['status'], `fleet dispatch response.runs[${index}].status`),
        item: string(row['item'], `fleet dispatch response.runs[${index}].item`),
      }
    }),
  }
}

function parsePowerNode(value: unknown, label: string): FleetPowerNode {
  const row = object(value, label)
  return {
    host: nonEmptyString(row['host'], `${label}.host`),
    node: nullableString(row['node'], `${label}.node`),
    reachability: string(row['reachability'], `${label}.reachability`),
    reachabilityAt: finiteNumber(row['reachabilityAt'], `${label}.reachabilityAt`),
    reachabilityError: nullableString(row['reachabilityError'], `${label}.reachabilityError`),
    reachable: boolean(row['reachable'], `${label}.reachable`),
    wakeState: string(row['wakeState'], `${label}.wakeState`),
    wakeStartedAt: finiteNumber(row['wakeStartedAt'], `${label}.wakeStartedAt`),
    wakeDeadlineAt: finiteNumber(row['wakeDeadlineAt'], `${label}.wakeDeadlineAt`),
    etaMs: nonNegativeInteger(row['etaMs'], `${label}.etaMs`),
    wakeError: nullableString(row['wakeError'], `${label}.wakeError`),
    smokeState: string(row['smokeState'], `${label}.smokeState`),
    smokeAt: finiteNumber(row['smokeAt'], `${label}.smokeAt`),
    smokeError: nullableString(row['smokeError'], `${label}.smokeError`),
    sleepState: string(row['sleepState'], `${label}.sleepState`),
    sleepError: nullableString(row['sleepError'], `${label}.sleepError`),
    wokenByBatchId: nullableString(row['wokenByBatchId'], `${label}.wokenByBatchId`),
    idleSleepEligible: boolean(row['idleSleepEligible'], `${label}.idleSleepEligible`),
    guarded: boolean(row['guarded'], `${label}.guarded`),
  }
}

export function parseFleetPower(value: unknown): { at: number, nodes: FleetPowerNode[] } {
  const root = object(value, 'fleet power response')
  return {
    at: finiteNumber(root['at'], 'fleet power response.at'),
    nodes: array(root['nodes'], 'fleet power response.nodes').map((entry, index) => parsePowerNode(entry, `fleet power response.nodes[${index}]`)),
  }
}

export function outcomeOfFleetStatus(status: FleetRunStatus): RemoteRunOutcome {
  return status
}

export function isTerminalFleetStatus(status: FleetRunStatus | undefined): boolean {
  return status !== undefined && ['completed', 'failed', 'cancelled', 'interrupted', 'lost'].includes(status)
}
