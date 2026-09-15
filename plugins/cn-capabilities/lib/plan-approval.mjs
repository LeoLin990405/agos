// Bind plan_run execute to a host-backed approval. Request fields and disk
// timestamps are not authorization.
//
// ## Host interface (in-repo, not invented)
//
// The host's only plan-content approval is dsh-plan-mode `exit_plan_mode`
// (`node_modules/@deepseek-ai/dsh-plan-mode/lib/index.js`):
//   1. Model calls exit_plan_mode({ plan: markdown }).
//   2. Host asks via userQuestions.ask — waterfall `user-questions/request`,
//      question id `plan-review`, intent { kind:'plan-review', approve:'Approve' }.
//      That waterfall is live-only; it is NOT a session event we can replay.
//   3. Approve → execute returns { approved:true } → agent-loop appends
//      tool/result with isError !== true.
//      Keep planning / dismiss → execute throws → tool/result isError:true.
//
// Persisted, host-written evidence (dsh-agent-loop appendToolCall/Result):
//   tool/call   data = { turn, step, callId, name:'exit_plan_mode', arguments }
//               arguments is the model JSON **string** `{ "plan": "<markdown>" }`
//   tool/result data = { turn, step, message, error?, meta? }
//               message.content[] = { type:'tool-result', toolCallId, content, isError }
//               批准 = matching callId AND isError !== true
//
// `hostEvent` accepted by evaluatePlanApproval (either form):
//   {
//     sessionId: string,                    // session.id that emitted the pair
//     toolCall:  { type:'tool/call',   data:{ callId, name:'exit_plan_mode', arguments } },
//     toolResult:{ type:'tool/result', data:{ message:{ content:[{ type:'tool-result', toolCallId, isError }] } } },
//   }
//   or
//   { sessionId, events: SessionEvent[] }   // snapshotEvents(); we pick the last pair
//
// NOT authorization (UNWIRED / UNAPPROVED):
//   - request approve:true
//   - any approvedAt / file existence / A3 disk record alone
//   - permissionPresets / plan/mode (sandbox only)
//   - approval/asked + approval/decided, $events waterfall approval/request
//     (tool-permission escalate, no plan fingerprint)
//   - inventing a new event type
//
// plan_run generate / view does not need this helper. Execute without the
// host pair above is UNWIRED — a later legitimate path is a real
// exit_plan_mode approval in the **current** session whose dsh-plan steps
// still fingerprint-match.

import { createHash } from 'node:crypto'

export const PLAN_APPROVAL_HOST = Object.freeze({
  kind: 'exit_plan_mode',
  wired: true,
  source: 'node_modules/@deepseek-ai/dsh-plan-mode/lib/index.js + dsh-agent-loop appendToolCall/Result',
  waterfall: 'user-questions/request (live only; not a session event)',
  sessionEvents: Object.freeze(['tool/call', 'tool/result']),
  notAuthorization: Object.freeze([
    'approve:true',
    'approvedAt',
    'file existence',
    'permissionPresets',
    'plan/mode',
    'approval/asked',
    'approval/decided',
    'approval/request waterfall',
  ]),
})

const fail = (code, reason, extra = {}) => ({
  ok: false,
  code,
  reason,
  host: extra.host ?? null,
  ...extra,
})

const canonicalSteps = (steps) => (Array.isArray(steps) ? steps : []).map((step) => [
  String((step && step.id) ?? ''),
  String((step && step.title) ?? ''),
  String((step && step.detail) ?? ''),
  (step && Array.isArray(step.dependsOn) ? step.dependsOn : []).map(String),
  step && step.type ? String(step.type) : '',
])

/** Content fingerprint of executable plan steps. Goal is metadata; steps bind execute. */
export function planFingerprint(planObj) {
  const payload = JSON.stringify({ v: 1, steps: canonicalSteps(planObj && planObj.steps) })
  return createHash('sha256').update(payload).digest('hex')
}

/** Session + call + plan content. Plan change or other session ⇒ different value. */
export function approvalFingerprint({ sessionId, plan, callId } = {}) {
  return createHash('sha256')
    .update('agos-plan-approval-v1\n')
    .update(String(sessionId ?? ''))
    .update('\n')
    .update(String(callId ?? ''))
    .update('\n')
    .update(planFingerprint(plan))
    .digest('hex')
}

const parseExitArgs = (raw) => {
  let value = raw
  if (typeof value === 'string') {
    try { value = JSON.parse(value) } catch { return null }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return typeof value.plan === 'string' ? value.plan : null
}

const extractDshPlan = (markdown) => {
  const match = /```dsh-plan\s*\n([\s\S]*?)```/.exec(String(markdown || ''))
  if (!match) return null
  try {
    const obj = JSON.parse(match[1])
    if (obj && Array.isArray(obj.steps) && obj.steps.length) return obj
  } catch {}
  return null
}

const toolResultBlock = (event) => {
  const message = event && event.data && event.data.message
  const content = message && Array.isArray(message.content) ? message.content : []
  const blocks = content.filter((item) => item && item.type === 'tool-result')
  const block = blocks.length === 1 ? blocks[0] : null
  const callId = block && typeof block.toolCallId === 'string' ? block.toolCallId : ''
  return { block, callId, isError: !!(block && block.isError === true) || !!event?.data?.error }
}

const asToolCall = (event) => {
  if (!event || event.type !== 'tool/call') return null
  const data = event.data || {}
  if (data.name !== 'exit_plan_mode' || !data.callId) return null
  const markdown = parseExitArgs(data.arguments)
  if (typeof markdown !== 'string') return null
  return { callId: String(data.callId), markdown, event }
}

const asToolResult = (event, callId) => {
  if (!event || event.type !== 'tool/result') return null
  const parsed = toolResultBlock(event)
  if (!parsed.callId || parsed.callId !== callId) return null
  return parsed
}

const pairFromParts = (hostEvent) => {
  const call = asToolCall(hostEvent.toolCall)
  if (!call) return null
  const result = asToolResult(hostEvent.toolResult, call.callId)
  if (!result) return null
  return { callId: call.callId, markdown: call.markdown, isError: result.isError }
}

const pairFromEvents = (events) => {
  if (!Array.isArray(events)) return null
  const pending = new Map()
  let last = null
  for (const event of events) {
    if (!event) continue
    if (event.type === 'tool/call') {
      const call = asToolCall(event)
      if (call) pending.set(call.callId, call)
      continue
    }
    if (event.type === 'tool/result') {
      const parsed = toolResultBlock(event)
      if (!parsed.callId || !pending.has(parsed.callId)) continue
      const call = pending.get(parsed.callId)
      pending.delete(parsed.callId)
      last = { callId: call.callId, markdown: call.markdown, isError: parsed.isError }
    }
  }
  return last
}

const looksLikeForgedAuth = (hostEvent) => {
  if (!hostEvent || typeof hostEvent !== 'object') return null
  if (hostEvent.approve === true && !hostEvent.toolCall && !hostEvent.toolResult && !hostEvent.events) {
    return 'approve-flag-is-not-authorization'
  }
  if (hostEvent.approvedAt != null && !hostEvent.toolCall && !hostEvent.toolResult && !hostEvent.events) {
    return 'approvedAt-is-not-authorization'
  }
  return null
}

/**
 * @param {{ sessionId: string, plan: object, approvalRecord?: object, hostEvent?: object }} input
 * @returns {{ ok:boolean, code:'APPROVED'|'UNWIRED'|'UNAPPROVED', reason?:string, fingerprint?:string, approvalFingerprint?:string, sessionId?:string, callId?:string, host?:string|null }}
 */
export function evaluatePlanApproval({ sessionId, plan, approvalRecord, hostEvent } = {}) {
  const fingerprint = planFingerprint(plan)
  const sid = sessionId == null ? '' : String(sessionId)
  if (!sid) return fail('UNAPPROVED', 'session-required', { fingerprint })

  const forged = looksLikeForgedAuth(hostEvent)
  if (forged) return fail('UNAPPROVED', forged, { fingerprint, sessionId: sid })

  if (approvalRecord && typeof approvalRecord === 'object') {
    if (approvalRecord.sessionId != null && String(approvalRecord.sessionId) !== sid) {
      return fail('UNAPPROVED', 'session-mismatch', { fingerprint, sessionId: sid, host: PLAN_APPROVAL_HOST.kind })
    }
    if (Array.isArray(approvalRecord.steps) && approvalRecord.steps.length) {
      if (planFingerprint(approvalRecord) !== fingerprint) {
        return fail('UNAPPROVED', 'fingerprint-mismatch', { fingerprint, sessionId: sid, host: PLAN_APPROVAL_HOST.kind })
      }
    }
  }

  if (hostEvent == null) {
    if (approvalRecord && approvalRecord.approvedAt != null) {
      return fail('UNAPPROVED', 'approvedAt-is-not-authorization', { fingerprint, sessionId: sid })
    }
    return fail('UNWIRED', 'no-host-event', { fingerprint, sessionId: sid })
  }

  if (typeof hostEvent !== 'object' || Array.isArray(hostEvent)) {
    return fail('UNWIRED', 'unrecognized-host-event', { fingerprint, sessionId: sid })
  }

  const eventSession = hostEvent.sessionId == null ? '' : String(hostEvent.sessionId)
  if (!eventSession) return fail('UNWIRED', 'unrecognized-host-event', { fingerprint, sessionId: sid })
  if (eventSession !== sid) {
    return fail('UNAPPROVED', 'session-mismatch', { fingerprint, sessionId: sid, host: PLAN_APPROVAL_HOST.kind })
  }

  let pair = null
  if (hostEvent.toolCall || hostEvent.toolResult) {
    pair = pairFromParts(hostEvent)
    if (!pair) return fail('UNWIRED', 'unrecognized-host-event', { fingerprint, sessionId: sid })
  } else if (hostEvent.events) {
    pair = pairFromEvents(hostEvent.events)
    if (!pair) return fail('UNWIRED', 'no-exit-plan-mode-pair', { fingerprint, sessionId: sid })
  } else {
    return fail('UNWIRED', 'unrecognized-host-event', { fingerprint, sessionId: sid })
  }

  if (pair.isError) {
    return fail('UNAPPROVED', 'rejected', {
      fingerprint, sessionId: sid, callId: pair.callId, host: PLAN_APPROVAL_HOST.kind,
    })
  }

  const approvedPlan = extractDshPlan(pair.markdown)
  if (!approvedPlan) {
    return fail('UNAPPROVED', 'no-dsh-plan-block', {
      fingerprint, sessionId: sid, callId: pair.callId, host: PLAN_APPROVAL_HOST.kind,
    })
  }
  const approvedFp = planFingerprint(approvedPlan)
  if (approvedFp !== fingerprint) {
    return fail('UNAPPROVED', 'fingerprint-mismatch', {
      fingerprint, sessionId: sid, callId: pair.callId, host: PLAN_APPROVAL_HOST.kind,
    })
  }

  const binding = approvalFingerprint({ sessionId: sid, plan, callId: pair.callId })
  if (approvalRecord && approvalRecord.approvalFingerprint
    && String(approvalRecord.approvalFingerprint) !== binding) {
    return fail('UNAPPROVED', 'fingerprint-mismatch', {
      fingerprint, sessionId: sid, callId: pair.callId, host: PLAN_APPROVAL_HOST.kind,
    })
  }

  return {
    ok: true,
    code: 'APPROVED',
    reason: 'exit_plan_mode',
    fingerprint,
    approvalFingerprint: binding,
    sessionId: sid,
    callId: pair.callId,
    host: PLAN_APPROVAL_HOST.kind,
  }
}
