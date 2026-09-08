import { closeSync, existsSync, fstatSync, fsyncSync, mkdirSync, openSync, readFileSync, readSync, writeSync } from 'node:fs'
import { dirname } from 'node:path'
import { sanitizeOutcomeRef, sanitizePreview } from './sanitize.js'
import { mintDecisionId } from './ids.js'
import { withLedgerLock } from './ledger-lock.js'
import { taskFingerprint } from './task-fingerprint.mjs'

export { withLedgerLock, acquireLedgerLock, releaseLedgerLock, lockPathFor, LedgerLockError } from './ledger-lock.js'

export function defaultLedgerPath(home) {
  return `${home}/.dsh/logs/route-outcome.jsonl`
}

/**
 * Append one record as one line, atomically with respect to other processes.
 *
 * Three separate hazards, three separate mitigations:
 *   1. interleaving — the cross-process lock means only one writer is inside the
 *      open/write/close window at a time, so two records can never share a line;
 *   2. a torn tail from a writer killed mid-write — the previous line is closed
 *      with a newline before this record is written, so the fragment stays on its
 *      own line (where the reader rejects it) instead of swallowing this record;
 *   3. loss on power failure — fsync before releasing the lock, so a record that
 *      appendLine() has returned for is on disk.
 * The payload is emitted in a single write(2) with its trailing newline included.
 */
export function appendLine(file, record) {
  mkdirSync(dirname(file), { recursive: true })
  const payload = JSON.stringify(record) + '\n'
  withLedgerLock(file, () => {
    const fd = openSync(file, 'a+', 0o600)
    try {
      writeSync(fd, healingPrefix(fd) + payload, null, 'utf8')
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
  })
  return record
}

/** '\n' when the file ends mid-line, so a crashed writer's fragment cannot absorb this record. */
function healingPrefix(fd) {
  const { size } = fstatSync(fd)
  if (size === 0) return ''
  const tail = Buffer.alloc(1)
  readSync(fd, tail, 0, 1, size - 1)
  return tail[0] === 0x0a ? '' : '\n'
}

/** @deprecated use appendLine */
export const appendOutcome = appendLine

/**
 * A record is a complete line that parses to a plain object.
 *
 * A truncated write is never accepted: any proper prefix of a JSON object is
 * missing its closing brace and fails to parse, and a non-object line (bare
 * number, string, array, null) is not a record no matter how well it parses.
 */
export function scanLedger(file) {
  if (!existsSync(file)) return { rows: [], rejected: 0 }
  const rows = []
  let rejected = 0
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue
    let parsed
    try {
      parsed = JSON.parse(line)
    } catch {
      rejected += 1 // corrupt or torn line; do not invent a record
      continue
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      rejected += 1
      continue
    }
    rows.push(parsed)
  }
  return { rows, rejected }
}

export function readLedgerLines(file) {
  return scanLedger(file).rows
}

export function foldLedger(rows) {
  const outcomesByRef = new Map()
  const notesByRef = new Map()
  const decisions = []
  let assemble
  let dispatch
  for (const row of rows) {
    if (row && row.kind === 'outcome') {
      outcomesByRef.set(String(row.ref), row)
      continue
    }
    if (row && row.kind === 'assemble') {
      assemble = row
      continue
    }
    if (row && row.kind === 'dispatch') {
      dispatch = row
      continue
    }
    if (row && row.ev === 'annotate') {
      const ref = String(row.ref ?? '')
      if (!ref || typeof row.note !== 'string' || !row.note) continue
      const list = notesByRef.get(ref) || []
      list.push(row.note)
      notesByRef.set(ref, list)
      continue
    }
    // W17:影子决策 ↔ fleet 批次的关联行(shadow.js 折叠),不是决策
    if (row && row.ev === 'shadow-link') continue
    // 任何别的 ev 行也不是决策(以后再加事件类型时别又掉进 decisions)
    if (row && typeof row.ev === 'string') continue
    if (row && typeof row === 'object') decisions.push(row)
  }
  const folded = decisions.map((d) => {
    const ref = String(d.id ?? d.ts ?? '')
    const patch = outcomesByRef.get(ref)
    const annotations = notesByRef.get(ref)
    const base = annotations ? { ...d, annotations } : { ...d }
    if (!patch) return { ...base, outcome: d.outcome === undefined ? null : d.outcome }
    return {
      ...base,
      outcome: patch.result,
      outcomeAt: patch.at,
      outcomeSource: patch.source,
    }
  })
  return { decisions: folded, ledgerTotal: decisions.length, assemble: assemble || null, dispatch: dispatch || null }
}

/** 追加标注,不改写历史决策行。 */
export function buildAnnotateRecord({ ref, note }) {
  const safeRef = sanitizeOutcomeRef(String(ref ?? ''), 80)
  if (!safeRef) {
    throw new Error('annotate ref is required')
  }
  const safeNote = sanitizePreview(typeof note === 'string' ? note : '', 160)
  if (!safeNote) {
    throw new Error('annotate note is required')
  }
  return {
    ev: 'annotate',
    ref: safeRef,
    note: safeNote,
    at: Date.now(),
  }
}

export function publicizeDecision(row) {
  const out = { ...row }
  delete out.task
  return out
}

/**
 * 台账汇总。W17 起影子行(mode:'shadow',pick 是机器名)**单列** shadow:{total, filled, pending, suggested, agreed}:
 * 它们的 pick 不是模型,混进 cells 会把「(角色, 模型) 格」的口径搅坏;filled/pending 只算模型路由行;
 * stats.total 仍含影子行(台账真有那么多行)。
 */
export function summarizeOutcomes(rows) {
  const cells = new Set()
  let filled = 0
  const shadow = { total: 0, filled: 0, pending: 0, suggested: 0, agreed: 0, filledOk: 0 }
  let routed = 0
  for (const row of rows) {
    const done = row.outcome !== null && row.outcome !== undefined
    if (row.mode === 'shadow') {
      // 影子行的「待回填」与模型路由的「待回填」不是一回事(建议没被采用就永远不回填),只进 shadow 小计
      shadow.total += 1
      if (done) shadow.filled += 1
      // filledOk 只认 fleet 终态回填出的 'ok'(影子行拒收手工胜负,这里天然只有 fleet-end 来源)
      if (row.outcome === 'ok') shadow.filledOk += 1
      if (typeof row.pick === 'string' && row.pick) shadow.suggested += 1
      if (row.shadow && row.shadow.agreed === true) shadow.agreed += 1
      continue
    }
    routed += 1
    if (done) filled += 1
    const role = row.role || ''
    const model = row.pick || ''
    if (role && model) cells.add(`${role}\t${model}`)
  }
  shadow.pending = shadow.total - shadow.filled
  return {
    total: rows.length,
    filled,
    pending: routed - filled,
    cells: cells.size,
    shadow,
  }
}

export function listRoutes(file, limit = 50) {
  const raw = readLedgerLines(file)
  const { decisions, ledgerTotal, assemble, dispatch } = foldLedger(raw)
  const windowSize = Math.max(1, Number(limit) || 50)
  const window = decisions.slice(-windowSize)
  const all = summarizeOutcomes(decisions)
  return {
    at: Date.now(),
    decisions: window.map(publicizeDecision),
    assemble: assemble ? publicizeDecision(assemble) : null,
    dispatch: dispatch ? publicizeDecision(dispatch) : null,
    stats: {
      total: ledgerTotal,
      window: window.length,
      limit: windowSize,
      filled: all.filled,
      pending: all.pending,
      cells: all.cells,
      shadow: all.shadow,
    },
  }
}

export function buildDecisionRecord(input, decision, source) {
  const ts = Date.now()
  // The identity of the task this decision was made for, hashed from the full
  // text before any preview clipping. The raw task never reaches the ledger.
  const taskRef = taskFingerprint(typeof input.task === 'string' ? input.task : '')
  return {
    id: mintDecisionId(ts),
    ts,
    taskType: input.taskType || decision.role || '',
    role: decision.role,
    candidates: Array.isArray(input.candidates) ? input.candidates.map((c) => c.id) : [],
    pick: decision.pick,
    confidence: decision.confidence,
    reason: decision.reason,
    label: decision.label,
    source,
    ...(taskRef ? { taskRef } : {}),
    outcome: null,
  }
}

export function buildOutcomeRecord({ ref, result, source, taskRef }) {
  if (result !== 'ok' && result !== 'fail') {
    throw new Error('outcome result must be ok or fail')
  }
  const safeRef = sanitizeOutcomeRef(String(ref ?? ''), 80)
  if (!safeRef) {
    throw new Error('outcome ref is required')
  }
  return {
    kind: 'outcome',
    ref: safeRef,
    result,
    at: Date.now(),
    source: sanitizePreview(typeof source === 'string' ? source : 'manual', 80) || 'manual',
    // Carried so a stored verdict stays checkable against its decision after the fact.
    ...(/^[a-f0-9]{64}$/.test(String(taskRef ?? '')) ? { taskRef } : {}),
  }
}
