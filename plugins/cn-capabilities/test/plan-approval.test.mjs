import assert from 'node:assert/strict'
import test from 'node:test'

import {
  PLAN_APPROVAL_HOST,
  approvalFingerprint,
  evaluatePlanApproval,
  planFingerprint,
} from '../lib/plan-approval.mjs'

const STEPS = [
  { id: 1, title: '读配置', detail: '读出当前配置并列出关键项', dependsOn: [], type: 'explore' },
  { id: 2, title: '改代码', detail: '按配置改代码', dependsOn: [1], type: 'coder' },
]

const PLAN_MD = '# 迁移配置系统\n\n步骤见下。\n\n```dsh-plan\n' + JSON.stringify({ steps: STEPS }) + '\n```\n'

const toolCall = (callId, args) => ({
  type: 'tool/call',
  data: { turn: 1, step: 1, callId, name: 'exit_plan_mode', arguments: JSON.stringify(args) },
})

const toolResult = (callId, text, isError) => ({
  type: 'tool/result',
  data: {
    turn: 1,
    step: 1,
    message: {
      id: 'm-' + callId,
      role: 'user',
      source: { kind: 'tool', callId },
      content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text }], isError }],
    },
  },
})

const approvedHost = (sessionId, callId = 'c-ok') => ({
  sessionId,
  toolCall: toolCall(callId, { plan: PLAN_MD }),
  toolResult: toolResult(callId, 'Plan approved — plan mode exited; carry out the plan starting with your next step.', false),
})

test('a result without a real matching tool-result block, or with host error, is not approval', () => {
  const host = approvedHost('s')
  host.toolResult.data.message.content = []
  assert.equal(evaluatePlanApproval({ sessionId: 's', plan: { steps: STEPS }, hostEvent: host }).ok, false)
  const failed = approvedHost('s')
  failed.toolResult.data.error = 'host execution failed'
  assert.equal(evaluatePlanApproval({ sessionId: 's', plan: { steps: STEPS }, hostEvent: failed }).ok, false)
})

test('PLAN_APPROVAL_HOST documents the in-repo exit_plan_mode pair, not an invented event', () => {
  assert.equal(PLAN_APPROVAL_HOST.kind, 'exit_plan_mode')
  assert.equal(PLAN_APPROVAL_HOST.wired, true)
  assert.ok(PLAN_APPROVAL_HOST.notAuthorization.includes('approve:true'))
  assert.ok(PLAN_APPROVAL_HOST.notAuthorization.includes('approvedAt'))
})

test('planFingerprint is stable for the same steps and changes when a step changes', () => {
  const a = planFingerprint({ steps: STEPS, goal: 'A' })
  const b = planFingerprint({ steps: STEPS, goal: 'B' })
  assert.equal(a, b)
  assert.match(a, /^[0-9a-f]{64}$/)
  const changed = planFingerprint({
    steps: STEPS.map((step, index) => (index === 1 ? { ...step, detail: '改别的' } : step)),
  })
  assert.notEqual(changed, a)
})

test('real exit_plan_mode approval succeeds and binds session + fingerprint + callId', () => {
  const sessionId = 's-a3'
  const plan = { steps: STEPS }
  const result = evaluatePlanApproval({
    sessionId,
    plan,
    approvalRecord: { sessionId, source: 'plan-mode', steps: STEPS },
    hostEvent: approvedHost(sessionId),
  })
  assert.equal(result.ok, true)
  assert.equal(result.code, 'APPROVED')
  assert.equal(result.host, 'exit_plan_mode')
  assert.equal(result.sessionId, sessionId)
  assert.equal(result.callId, 'c-ok')
  assert.equal(result.fingerprint, planFingerprint(plan))
  assert.equal(result.approvalFingerprint, approvalFingerprint({ sessionId, plan, callId: 'c-ok' }))
})

test('events snapshot form also accepts the last successful exit_plan_mode pair', () => {
  const sessionId = 's-snap'
  const result = evaluatePlanApproval({
    sessionId,
    plan: { steps: STEPS },
    hostEvent: {
      sessionId,
      events: [
        { type: 'plan/mode', data: { active: true } },
        toolCall('c-rej', { plan: PLAN_MD }),
        toolResult('c-rej', 'The user chose to keep planning', true),
        toolCall('c-ok', { plan: PLAN_MD }),
        toolResult('c-ok', 'Plan approved', false),
      ],
    },
  })
  assert.equal(result.ok, true)
  assert.equal(result.callId, 'c-ok')
})

test('no host event is UNWIRED — generate/view stay allowed; execute is not closed', () => {
  const result = evaluatePlanApproval({
    sessionId: 's-1',
    plan: { steps: STEPS },
  })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'UNWIRED')
  assert.equal(result.reason, 'no-host-event')
})

test('Keep planning (isError) is UNAPPROVED', () => {
  const sessionId = 's-rej'
  const result = evaluatePlanApproval({
    sessionId,
    plan: { steps: STEPS },
    hostEvent: {
      sessionId,
      toolCall: toolCall('c-rej', { plan: PLAN_MD }),
      toolResult: toolResult('c-rej', 'The user chose to keep planning', true),
    },
  })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'UNAPPROVED')
  assert.equal(result.reason, 'rejected')
})

test('cross-session reuse of a valid host pair fails', () => {
  const result = evaluatePlanApproval({
    sessionId: 's-now',
    plan: { steps: STEPS },
    approvalRecord: { sessionId: 's-old', approvedAt: '2026-01-01T00:00:00.000Z', steps: STEPS },
    hostEvent: approvedHost('s-old'),
  })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'UNAPPROVED')
  assert.equal(result.reason, 'session-mismatch')
})

test('modified plan invalidates the old approval', () => {
  const sessionId = 's-edit'
  const result = evaluatePlanApproval({
    sessionId,
    plan: { steps: [{ id: 1, title: '读配置', detail: '已经被改过', dependsOn: [], type: 'explore' }] },
    approvalRecord: { sessionId, steps: STEPS, approvedAt: '2026-09-08T00:00:00.000Z' },
    hostEvent: approvedHost(sessionId),
  })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'UNAPPROVED')
  assert.equal(result.reason, 'fingerprint-mismatch')
})

test('forged approvedAt / approve:true are not authorization', () => {
  const sessionId = 's-forge'
  const plan = { steps: STEPS }
  const stamped = evaluatePlanApproval({
    sessionId,
    plan,
    approvalRecord: { sessionId, approvedAt: '2026-09-08T10:00:00.000Z', steps: STEPS },
  })
  assert.equal(stamped.ok, false)
  assert.equal(stamped.code, 'UNAPPROVED')
  assert.equal(stamped.reason, 'approvedAt-is-not-authorization')

  const asEvent = evaluatePlanApproval({
    sessionId,
    plan,
    hostEvent: { approvedAt: '2026-09-08T10:00:00.000Z', sessionId },
  })
  assert.equal(asEvent.ok, false)
  assert.equal(asEvent.code, 'UNAPPROVED')
  assert.equal(asEvent.reason, 'approvedAt-is-not-authorization')

  const flag = evaluatePlanApproval({
    sessionId,
    plan,
    hostEvent: { approve: true, sessionId },
  })
  assert.equal(flag.ok, false)
  assert.equal(flag.code, 'UNAPPROVED')
  assert.equal(flag.reason, 'approve-flag-is-not-authorization')
})

test('approval/asked + approval/decided is not a plan-content approval (UNWIRED)', () => {
  const result = evaluatePlanApproval({
    sessionId: 's-perm',
    plan: { steps: STEPS },
    hostEvent: {
      sessionId: 's-perm',
      events: [
        { type: 'approval/asked', data: { id: 'a1', toolName: 'exit_plan_mode', callId: 'c-x', reason: 'plan' } },
        { type: 'approval/decided', data: { id: 'a1', outcome: 'approved' } },
      ],
    },
  })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'UNWIRED')
})

test('file existence / empty host object cannot close the loop', () => {
  const result = evaluatePlanApproval({
    sessionId: 's-file',
    plan: { steps: STEPS },
    approvalRecord: { file: '/tmp/plans/plan-1.json' },
    hostEvent: { sessionId: 's-file' },
  })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'UNWIRED')
})
