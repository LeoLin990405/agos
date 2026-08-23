import assert from 'node:assert/strict'
import test from 'node:test'
import { describeYoloDecision, groupYoloByCallId, parseYoloDecisionsPayload, yoloDecisionsUrl, yoloVerdictText } from './yolo-decisions.ts'

const S = 'session-0b4b785c-1e7c-4223-bf0e-371d7f75b690'
// 照台账真实行:第一条是修复前格式(judge+rejected 无 reason)。
const PAYLOAD = { version: 1, sessionId: S, count: 3, items: [
  { time: 1787056815348, callId: 'call_00_f712', toolName: 'bash', origin: 'main', targetMode: 'danger-full-access', currentMode: 'workspace-write', justification: '用户明确要求在工作区外创建', decision: 'judge', outcome: 'rejected' },
  { time: 1787329554869, callId: 'probe', toolName: 'bash', decision: 'deny', outcome: 'rejected', reason: 'permission scope exceeds stated need' },
  { time: 1787056817000, callId: 'call_00_f712', toolName: 'bash', decision: 'judge', outcome: 'allowed-once', reason: 'scope now matches' },
  { time: 1, callId: 'd', decision: 'judge', outcome: 'delegate' },
  { time: 2, callId: 'e', decision: 'judge', outcome: 'rejected', error: 'BAD_OUTPUT', errorMessage: 'raw provider text' },
  { time: 3, decision: 'judge', outcome: 'rejected' },
] }

test('解析:无 callId 的行丢弃;按 callId 分组、同 callId 按 time 升序', () => {
  const p = parseYoloDecisionsPayload(PAYLOAD)
  assert.equal(p.items.length, 5)
  const g = groupYoloByCallId(p.items)
  assert.deepEqual(g.get('call_00_f712')?.map((r) => r.outcome), ['rejected', 'allowed-once'])
  assert.equal(yoloDecisionsUrl(S), `/api/agos/yolo-decisions?sessionId=${S}`)
  assert.throws(() => yoloDecisionsUrl(' '), TypeError)
  assert.throws(() => parseYoloDecisionsPayload({ items: [] }), /缺少/)
})

test('文案由 decision×outcome 算出;理由只认 reason,justification 永远不当理由;无 reason 无 error → 裁判未留理由', () => {
  const p = parseYoloDecisionsPayload(PAYLOAD)
  const [judgedNoReason, denied, judgedOk, delegated, errored] = p.items
  assert.equal(yoloVerdictText(judgedNoReason), 'LLM 裁判拒绝（裁判未留理由）')
  assert.doesNotMatch(yoloVerdictText(judgedNoReason), /工作区外/)
  assert.equal(yoloVerdictText(denied), '策略直接拒绝：permission scope exceeds stated need')
  assert.equal(yoloVerdictText(judgedOk), 'LLM 裁判放行（一次）：scope now matches')
  assert.equal(yoloVerdictText(delegated), '裁判转人工审批')
  assert.equal(yoloVerdictText(errored), '裁判出错回退拒绝（BAD_OUTPUT）')
  assert.doesNotMatch(yoloVerdictText(errored), /raw provider text/)
  assert.equal(describeYoloDecision(judgedNoReason).who, 'LLM 裁判')
  assert.equal(describeYoloDecision({ time: 0, callId: 'x', decision: 'weird', outcome: 'weird' }).kind, 'unknown')
})
