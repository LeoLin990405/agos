// Feedback bind: server-owned source, real decision refs, shadow truth, learnability.
// Controller wires these into index/dispatch/shadow. This module does not write the ledger.
import { buildOutcomeRecord, foldLedger, outcomeMatchesDecision } from './ledger.js'
import { buildShadowLinkRecord, SHADOW_MODE, SHADOW_OUTCOME_SOURCE } from './shadow.js'
import { isTaskFingerprint, sameTask } from './task-fingerprint.mjs'

export const OUTCOME_SOURCE_MANUAL = 'manual'
export const OUTCOME_SOURCE_REVIEWER = 'reviewer-verdict'
export const OUTCOME_SOURCE_FLEET = SHADOW_OUTCOME_SOURCE

export const FEEDBACK_CODES = Object.freeze({
  MISSING_REF: 'MISSING_REF',
  DECISION_NOT_FOUND: 'DECISION_NOT_FOUND',
  FORGED_SOURCE: 'FORGED_SOURCE',
  CONFLICTING_RESULT: 'CONFLICTING_RESULT',
  INVALID_RESULT: 'INVALID_RESULT',
  SHADOW_MANUAL_OUTCOME: 'SHADOW_MANUAL_OUTCOME',
  SHADOW_BIND_INVALID: 'SHADOW_BIND_INVALID',
  NOT_INDEPENDENT: 'NOT_INDEPENDENT',
  POOL_TOO_SMALL: 'POOL_TOO_SMALL',
  NOT_LEARNABLE: 'NOT_LEARNABLE',
  TASK_MISMATCH: 'TASK_MISMATCH',
  REPLAYED: 'REPLAYED',
})

export const FEEDBACK_COPY = Object.freeze({
  MISSING_REF: 'outcome 必须引用已有决策',
  DECISION_NOT_FOUND: 'outcome 引用的决策不存在',
  FORGED_SOURCE: '反馈来源由服务端判定，拒绝客户端自称自动评审',
  CONFLICTING_RESULT: '同一决策已有相反结果，拒绝改史',
  INVALID_RESULT: 'outcome result 只能是 ok 或 fail',
  SHADOW_MANUAL_OUTCOME: '影子决策行只接受 fleet 终态回填,不接受手工胜负',
  SHADOW_BIND_INVALID: 'shadow-link 必须绑定真实影子决策、真实批次与适用任务',
  NOT_INDEPENDENT: '评审模型必须和实现模型不同，自评不入后验',
  POOL_TOO_SMALL: '候选不足，不独立评审不能学习',
  NOT_LEARNABLE: '该结果标记为不可学习，不入后验',
  TASK_MISMATCH: '判定针对的任务与决策记录的任务不是同一个，拒绝跨任务入账',
  REPLAYED: '该提交已入账过，拒绝重放',
})

function fail(code, extra = {}) {
  return { ok: false, code, error: FEEDBACK_COPY[code] ?? code, ...extra }
}

export function foldModelId(id) {
  if (typeof id !== 'string') return ''
  return id.trim().toLowerCase()
}

export function resolveOutcomeSource(authority) {
  if (authority === 'reviewer-verdict' || authority === 'dispatch') return OUTCOME_SOURCE_REVIEWER
  if (authority === 'fleet-end' || authority === 'shadow-backfill') return OUTCOME_SOURCE_FLEET
  return OUTCOME_SOURCE_MANUAL
}

/** Client source is a claim. Auto-review / fleet-end can only come from matching server authority. */
export function detectForgedSource(clientSource, authority) {
  const source = resolveOutcomeSource(authority)
  if (typeof clientSource !== 'string' || clientSource.trim() === '') {
    return { forged: false, source }
  }
  const claimed = clientSource.trim()
  if (
    (claimed === OUTCOME_SOURCE_REVIEWER || claimed === OUTCOME_SOURCE_FLEET)
    && claimed !== source
  ) {
    return { forged: true, source, code: FEEDBACK_CODES.FORGED_SOURCE }
  }
  return { forged: false, source }
}

export function findDecision(rows, ref) {
  if (typeof ref !== 'string' || ref.trim() === '') return null
  const id = ref.trim()
  const { decisions } = foldLedger(Array.isArray(rows) ? rows : [])
  return decisions.find((d) => d && String(d.id ?? d.ts ?? '') === id) ?? null
}

export function latestOutcome(rows, ref) {
  if (typeof ref !== 'string' || ref.trim() === '') return null
  const id = ref.trim()
  let found = null
  for (const row of Array.isArray(rows) ? rows : []) {
    if (row && row.kind === 'outcome' && String(row.ref) === id) found = row
  }
  return found
}

/** The task a decision row was made for. Shadow rows keep theirs in shadow.taskFingerprints. */
export function decisionTaskRef(decision) {
  const value = decision && typeof decision === 'object' ? decision.taskRef : undefined
  return isTaskFingerprint(value) ? value : null
}

/**
 * Cross-task gate.
 *
 * A verdict is an opinion about one specific task. Booking it against a decision
 * made for a different task credits or blames a model for work it never saw, and
 * the posterior has no way to tell afterwards. Two rules:
 *   - an explicitly stated task that disagrees with the decision's is always refused;
 *   - a reviewer verdict must state one. The dispatch path always knows which task
 *     it ran, so a missing fingerprint there means the verdict is unattributable.
 * Decisions written before taskRef existed carry no fingerprint and stay bindable —
 * refusing them would make every historical row permanently un-annotatable.
 */
export function checkTaskBinding({ decision, claimed, source }) {
  const expected = decisionTaskRef(decision)
  if (!expected) return { ok: true, taskRef: null, unverified: true }
  if (isTaskFingerprint(claimed)) {
    return sameTask(claimed, expected)
      ? { ok: true, taskRef: expected, unverified: false }
      : { ok: false, code: FEEDBACK_CODES.TASK_MISMATCH, expected, claimed }
  }
  if (source === OUTCOME_SOURCE_REVIEWER) {
    return { ok: false, code: FEEDBACK_CODES.TASK_MISMATCH, expected, claimed: null }
  }
  return { ok: true, taskRef: expected, unverified: true }
}

/**
 * Replay gate. A submission may carry a nonce minted once by whoever produced the
 * verdict; seeing the same nonce twice means the same submission arrived twice
 * (retry storm, replayed request), not that a second judgement was made.
 */
export function seenNonce(rows, nonce) {
  if (typeof nonce !== 'string' || nonce.trim() === '') return false
  const id = nonce.trim()
  return (Array.isArray(rows) ? rows : []).some((row) => row && row.kind === 'outcome' && row.nonce === id)
}

function poolSize(candidates) {
  const ids = new Set()
  for (const item of Array.isArray(candidates) ? candidates : []) {
    const id = typeof item === 'string' ? item : item && item.id
    const folded = foldModelId(id)
    if (folded) ids.add(folded)
  }
  return ids.size
}

function roleModel(roles, role) {
  const row = [...(Array.isArray(roles) ? roles : [])].reverse().find((item) => item && item.role === role)
  return row && typeof row.model === 'string' ? row.model : ''
}

/**
 * Distinct implementer/reviewer is required to learn.
 * Too few candidates ⇒ reject non-independent review and mark not-learnable.
 */
export function evaluateReviewIndependence(input = {}) {
  const implementer = foldModelId(input.implementer)
  const reviewer = foldModelId(input.reviewer)
  let candidates = input.candidates
  if (!Array.isArray(candidates) || candidates.length === 0) {
    const roles = input.assemble && Array.isArray(input.assemble.roles) ? input.assemble.roles : []
    candidates = roles.map((row) => row && row.model).filter(Boolean)
  }
  const size = poolSize(candidates)
  if (size > 0 && size < 2) {
    return {
      independent: false,
      learnable: false,
      skip: FEEDBACK_CODES.POOL_TOO_SMALL,
      rejectReview: true,
    }
  }
  if (!implementer || !reviewer || implementer === reviewer) {
    return {
      independent: false,
      learnable: false,
      skip: FEEDBACK_CODES.NOT_INDEPENDENT,
      rejectReview: true,
    }
  }
  return { independent: true, learnable: true, skip: null, rejectReview: false }
}

/** Dispatch-time gate: self-review / tiny pool never feed posterior. */
export function gateReviewerVerdictFeed(input = {}) {
  const turns = Array.isArray(input.turns) ? input.turns : []
  const assemble = input.assemble && typeof input.assemble === 'object' ? input.assemble : {}
  const implementer = input.implementer
    ?? (roleModel(turns, 'implementer') || roleModel(assemble.roles, 'implementer'))
  const reviewer = input.reviewer
    ?? (roleModel(turns, 'reviewer') || roleModel(assemble.roles, 'reviewer'))
  const independence = evaluateReviewIndependence({
    implementer,
    reviewer,
    candidates: input.candidates,
    assemble,
  })
  return {
    ...independence,
    feed: independence.learnable === true && independence.independent === true,
    verdictSkip: independence.skip,
    implementer,
    reviewer,
  }
}

export function shouldEnterPosterior(row) {
  if (!row || typeof row !== 'object') return false
  if (row.learnable === false) return false
  if (row.mode === SHADOW_MODE) return false
  if (row.source === OUTCOME_SOURCE_REVIEWER && foldModelId(row.judge)
      && foldModelId(row.judge) === foldModelId(row.judged)) return false
  return true
}

/** Mask rejected latest feedback without resurrecting an older result. Display still reads raw rows. */
export function filterLedgerForPosterior(rows) {
  const source = Array.isArray(rows) ? rows : []
  const blocked = new Set()
  const latest = new Map()
  for (const row of source) {
    if (!row || typeof row !== 'object') continue
    if (row.kind === 'outcome') latest.set(String(row.ref), row)
    else if (!shouldEnterPosterior(row)) blocked.add(String(row.id ?? row.ts ?? ''))
  }
  for (const [ref, row] of latest) if (!shouldEnterPosterior(row)) blocked.add(ref)
  return source.filter((row) => !(row?.kind === 'outcome' && blocked.has(String(row.ref))))
    .map((row) => row && blocked.has(String(row.id ?? row.ts ?? '')) ? { ...row, outcome: null } : row)
}

/**
 * Ordinary outcome: cite a real decision; server sets source; (ref,result,source) idempotent;
 * conflicting result rejected. Reviewer-verdict authority also applies the independence gate.
 */
export function bindOrdinaryOutcome(input = {}) {
  const body = input.body && typeof input.body === 'object' ? input.body : {}
  const rows = Array.isArray(input.rows) ? input.rows : []
  const ref = typeof body.ref === 'string' ? body.ref.trim() : ''
  if (ref === '') return fail(FEEDBACK_CODES.MISSING_REF)

  const claimed = detectForgedSource(body.source, input.authority)
  if (claimed.forged) return fail(FEEDBACK_CODES.FORGED_SOURCE, { source: claimed.source })
  const source = claimed.source

  if (body.result !== 'ok' && body.result !== 'fail') return fail(FEEDBACK_CODES.INVALID_RESULT)

  const decision = findDecision(rows, ref)
  if (!decision) return fail(FEEDBACK_CODES.DECISION_NOT_FOUND, { ref })

  if (decision.mode === SHADOW_MODE && source !== OUTCOME_SOURCE_FLEET) {
    return fail(FEEDBACK_CODES.SHADOW_MANUAL_OUTCOME, { ref })
  }

  // Same submission arriving twice is one judgement, not two. Checked before the
  // idempotency branches so a replay is named as such instead of silently absorbed.
  const nonce = typeof body.nonce === 'string' && body.nonce.trim() ? body.nonce.trim() : ''
  if (nonce && seenNonce(rows, nonce)) {
    return fail(FEEDBACK_CODES.REPLAYED, { ref, nonce })
  }

  const binding = checkTaskBinding({
    decision,
    claimed: input.taskRef ?? body.taskRef,
    source,
  })
  if (!binding.ok) {
    // Never echo the decision's own fingerprint: the hash algorithm is public,
    // so returning it would hand out a confirmation oracle for the task text
    // behind this ref. The client's own claimed value is echoed back untouched.
    return fail(FEEDBACK_CODES.TASK_MISMATCH, {
      ref,
      ...(binding.claimed !== undefined && binding.claimed !== null
        ? { claimed: binding.claimed } : {}),
    })
  }

  // The stored prior is evidence only if it actually binds to THIS decision's
  // task. A row fingerprinted for another task (old data, a pre-fix row, a
  // hand-edited ledger) is not "the prior outcome of this decision": it must
  // neither absorb this submission as idempotent nor block it as a conflict.
  const stored = latestOutcome(rows, ref)
  const prior = outcomeMatchesDecision(stored, decision) ? stored : null
  if (!prior && (decision.outcome === 'ok' || decision.outcome === 'fail')) {
    if (decision.outcome !== body.result) {
      return fail(FEEDBACK_CODES.CONFLICTING_RESULT, { ref, existing: decision.outcome })
    }
    return { ok: true, idempotent: true,
      record: { kind: 'outcome', ref, result: decision.outcome, source: decision.outcomeSource ?? 'manual' },
      learnable: decision.learnable !== false, source }
  }
  if (prior && prior.result === body.result && String(prior.source ?? '') === source) {
    return { ok: true, idempotent: true, record: prior, learnable: prior.learnable !== false, source }
  }
  if (prior && prior.result !== body.result) {
    return fail(FEEDBACK_CODES.CONFLICTING_RESULT, { ref, existing: prior.result })
  }
  if (prior && prior.result === body.result) {
    return { ok: true, idempotent: true, record: prior, learnable: prior.learnable !== false, source }
  }

  let independence = { independent: true, learnable: true, skip: null }
  if (source === OUTCOME_SOURCE_REVIEWER) {
    independence = gateReviewerVerdictFeed({
      assemble: input.assemble,
      turns: input.turns,
      implementer: input.implementer ?? body.judged,
      reviewer: input.reviewer ?? body.judge,
      candidates: input.candidates ?? decision.candidates,
    })
  }

  let record
  try {
    record = buildOutcomeRecord({
      ref,
      result: body.result,
      source,
      taskRef: binding.taskRef,
      // Persist the check status: an unverified binding must be visibly
      // unverified on disk, or "verified" and "unverified" rows are byte-identical
      // and no after-the-fact audit can tell them apart.
      taskUnverified: binding.unverified === true,
    })
  } catch (err) {
    const message = err && err.message ? String(err.message) : ''
    if (message.includes('ref')) return fail(FEEDBACK_CODES.MISSING_REF)
    return fail(FEEDBACK_CODES.INVALID_RESULT)
  }
  if (source === OUTCOME_SOURCE_REVIEWER) {
    if (typeof (input.reviewer ?? body.judge) === 'string') record.judge = input.reviewer ?? body.judge
    if (typeof (input.implementer ?? body.judged) === 'string') record.judged = input.implementer ?? body.judged
  }
  if (nonce) record.nonce = nonce
  if (independence.learnable === false) {
    record.learnable = false
    record.verdictSkip = independence.skip
  } else {
    record.learnable = true
  }

  return {
    ok: true,
    idempotent: false,
    record,
    source,
    learnable: record.learnable !== false,
    feed: independence.learnable !== false,
    verdictSkip: independence.skip,
    // true when the decision predates taskRef, so callers can report "not checkable"
    // instead of implying the task binding was verified.
    taskUnverified: binding.unverified === true,
  }
}

/**
 * shadow-link must bind decision + real batch + applicable task.
 * Unused suggestion stays unknown. Never invents a counterfactual win/loss.
 */
export function bindShadowLink(input = {}) {
  const ref = typeof input.ref === 'string' ? input.ref.trim() : ''
  const batchId = typeof input.batchId === 'string' ? input.batchId.trim() : ''
  let record
  try {
    record = buildShadowLinkRecord({ ref, batchId, hosts: input.hosts })
  } catch {
    return fail(FEEDBACK_CODES.SHADOW_BIND_INVALID)
  }

  const decision = Array.isArray(input.decisions)
    ? input.decisions.find((d) => d && d.id === record.ref)
    : findDecision(input.rows, record.ref)
  if (!decision || decision.mode !== SHADOW_MODE) {
    return fail(FEEDBACK_CODES.SHADOW_BIND_INVALID, { reason: 'DECISION' })
  }

  const runs = input.batches instanceof Map ? input.batches.get(record.batchId) : null
  if (!(runs instanceof Map) || runs.size === 0) {
    return fail(FEEDBACK_CODES.SHADOW_BIND_INVALID, { reason: 'BATCH' })
  }
  const expected = decision.shadow?.taskFingerprints
  const actual = [...runs.values()].sort((a, b) => a.index - b.index)
  if (!Array.isArray(expected) || !expected.length || expected.length !== actual.length
      || !Number.isFinite(decision.ts)
      || actual.some((run, index) => run.index !== index + 1
        || !/^[a-f0-9]{64}$/.test(expected[index]) || run.taskFingerprint !== expected[index]
        || !Number.isFinite(run.dispatchedAt) || run.dispatchedAt < decision.ts)) {
    return fail(FEEDBACK_CODES.SHADOW_BIND_INVALID, { reason: 'TASK' })
  }
  const links = (Array.isArray(input.rows) ? input.rows : []).filter((row) => row?.ev === 'shadow-link')
  if (links.some((row) => row.ref === record.ref && row.batchId !== record.batchId)) {
    return fail(FEEDBACK_CODES.SHADOW_BIND_INVALID, { reason: 'REBOUND' })
  }
  if (links.some((row) => row.batchId === record.batchId && row.ref !== record.ref)) {
    return fail(FEEDBACK_CODES.SHADOW_BIND_INVALID, { reason: 'BATCH_LINKED' })
  }
  // Host attribution always comes from dispatch/reroute events, never from the HTTP request.
  record.hosts = [...new Set(actual.map((run) => run.host).filter((host) => typeof host === 'string'))]
  const pick = typeof decision.pick === 'string' ? decision.pick : ''
  const hosts = Array.isArray(record.hosts) ? record.hosts : []
  const adopted = pick ? hosts.includes(pick) : null
  return {
    ok: true,
    idempotent: links.some((row) => row.ref === record.ref && row.batchId === record.batchId),
    record,
    adopted,
    outcome: null,
    unknown: adopted !== true,
  }
}

/** Revalidate durable links before display/backfill; old unbound task records cannot create new results. */
export function validatedShadowLinks(rows, batches) {
  const accepted = []
  const links = new Map()
  const decisions = foldLedger(Array.isArray(rows) ? rows : []).decisions
  for (const row of Array.isArray(rows) ? rows : []) {
    if (row?.ev !== 'shadow-link') continue
    const bound = bindShadowLink({ ref: row.ref, batchId: row.batchId, rows: accepted, decisions, batches })
    if (!bound.ok) continue
    if (!bound.idempotent) accepted.push(bound.record)
    links.set(row.ref, { batchId: row.batchId, hosts: bound.record.hosts })
  }
  return links
}

/** Backfill booking: unused / unfinished stays unknown. No counterfactual result. */
export function bindShadowOutcome(input = {}) {
  const decision = input.decision
  const link = input.link
  if (!decision || decision.mode !== SHADOW_MODE || !link) {
    return { ok: false, code: FEEDBACK_CODES.SHADOW_BIND_INVALID, outcome: null, unknown: true }
  }
  if (decision.outcome === 'ok' || decision.outcome === 'fail') {
    return { ok: true, outcome: null, unknown: false, alreadyJudged: true }
  }
  const pick = typeof decision.pick === 'string' ? decision.pick : ''
  const runs = input.batchRuns
  const mine = !pick || !runs || typeof runs.values !== 'function'
    ? { present: false, ended: false, ok: false }
    : (() => {
      const rows = [...runs.values()].filter((x) => x && x.host === pick)
      if (rows.length === 0) return { present: false, ended: false, ok: false }
      const ended = rows.every((x) => x.ended)
      return { present: true, ended, ok: ended && rows.every((x) => x.ok) }
    })()
  if (!mine.present || !mine.ended) {
    return { ok: true, outcome: null, unknown: true, adopted: mine.present }
  }
  return {
    ok: true,
    outcome: mine.ok ? 'ok' : 'fail',
    unknown: false,
    adopted: true,
    source: OUTCOME_SOURCE_FLEET,
  }
}
