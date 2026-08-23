import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { sanitizeOutcomeRef, sanitizePreview } from './sanitize.js'

export function defaultLedgerPath(home) {
  return `${home}/.dsh/logs/route-outcome.jsonl`
}

export function appendLine(file, record) {
  mkdirSync(dirname(file), { recursive: true })
  appendFileSync(file, JSON.stringify(record) + '\n', 'utf8')
  return record
}

/** @deprecated use appendLine */
export const appendOutcome = appendLine

export function readLedgerLines(file) {
  if (!existsSync(file)) return []
  const rows = []
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue
    try {
      rows.push(JSON.parse(line))
    } catch {
      // skip corrupt line; do not invent a record
    }
  }
  return rows
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

export function summarizeOutcomes(rows) {
  const cells = new Set()
  let filled = 0
  for (const row of rows) {
    if (row.outcome !== null && row.outcome !== undefined) filled += 1
    const role = row.role || ''
    const model = row.pick || ''
    if (role && model) cells.add(`${role}\t${model}`)
  }
  return {
    total: rows.length,
    filled,
    pending: rows.length - filled,
    cells: cells.size,
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
    },
  }
}

export function buildDecisionRecord(input, decision, source) {
  const ts = Date.now()
  return {
    id: `dec-${ts}-${randomUUID().slice(0, 8)}`,
    ts,
    taskType: input.taskType || decision.role || '',
    role: decision.role,
    candidates: Array.isArray(input.candidates) ? input.candidates.map((c) => c.id) : [],
    pick: decision.pick,
    confidence: decision.confidence,
    reason: decision.reason,
    label: decision.label,
    source,
    outcome: null,
  }
}

export function buildOutcomeRecord({ ref, result, source }) {
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
  }
}
