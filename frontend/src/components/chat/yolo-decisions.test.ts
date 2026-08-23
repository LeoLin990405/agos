import assert from 'node:assert/strict'
import test from 'node:test'
import { describeYoloDecision, groupYoloByCallId, parseYoloDecisionsPayload, yoloDecisionsUrl, yoloTargetText, yoloVerdictText } from './yolo-decisions.ts'

const S = 'session-0b4b785c-1e7c-4223-bf0e-371d7f75b690'
// 照台账真实行:第一条是修复前格式(judge+rejected 无 reason)。
const PAYLOAD = { version: 1, sessionId: S, count: 3, items: [
  { time: 1787056815348, callId: 'call_00_f712', toolName: 'bash', origin: 'main', targetMode: 'danger-full-access', currentMode: 'workspace-write', justification: '用户明确要求在工作区外创建', decision: 'judge', outcome: 'rejected' },
  { time: 1787329554869, callId: 'probe', toolName: 'bash', decision: 'deny', outcome: 'rejected', reason: 'permission scope exceeds stated need' },
  { time: 1787056817000, callId: 'call_00_f712', toolName: 'bash', decision: 'judge', outcome: 'allowed-once', reason: 'scope now matches' },
  { time: 1, callId: 'd', decision: 'delegate', outcome: 'delegate', error: 'PRESET_GATE_MISSING' },
  { time: 2, callId: 'e', decision: 'judge', outcome: 'rejected', error: 'BAD_OUTPUT', errorMessage: 'raw provider text' },
  { time: 3, decision: 'judge', outcome: 'rejected' },
  { time: 4, callId: 'f', decision: 'judge', outcome: 'delegate', error: 'NOT_CONFIGURED' },
  { time: 5, callId: 'g', decision: 'allow', outcome: 'allowed-once' },
] }

test('解析:无 callId 的行丢弃;按 callId 分组、同 callId 按 time 升序', () => {
  const p = parseYoloDecisionsPayload(PAYLOAD)
  assert.equal(p.items.length, 7)
  const g = groupYoloByCallId(p.items)
  assert.deepEqual(g.get('call_00_f712')?.map((r) => r.outcome), ['rejected', 'allowed-once'])
  assert.equal(yoloDecisionsUrl(S), `/api/agos/yolo-decisions?sessionId=${S}`)
  assert.throws(() => yoloDecisionsUrl(' '), TypeError)
  assert.throws(() => parseYoloDecisionsPayload({ items: [] }), /缺少/)
})

test('文案由 decision×outcome 算出;理由只认 reason,justification 永远不当理由;无 reason 无 error → 裁判未留理由', () => {
  const p = parseYoloDecisionsPayload(PAYLOAD)
  const [judgedNoReason, denied, judgedOk, policyDelegate, errored, judgeDelegate, policyAllow] = p.items
  assert.equal(yoloVerdictText(judgedNoReason), 'LLM 裁判拒绝（裁判未留理由）')
  assert.doesNotMatch(yoloVerdictText(judgedNoReason), /工作区外/)
  // 静态 deny 写端永远不带 reason:不说「裁判未留理由」(裁判根本没跑);探针行带 reason 时照印。
  assert.equal(yoloVerdictText(denied), '策略直接拒绝：permission scope exceeds stated need')
  assert.equal(yoloVerdictText({ time: 0, callId: 'z', decision: 'deny', outcome: 'rejected' }), '策略直接拒绝')
  assert.equal(yoloVerdictText(judgedOk), 'LLM 裁判放行（一次）：scope now matches')
  // decision:'delegate' 是策略层转人工,裁判没跑;错误码任何 outcome 下都报。
  assert.equal(yoloVerdictText(policyDelegate), '策略转人工审批，裁判未跑（出错回退 PRESET_GATE_MISSING）')
  assert.equal(yoloVerdictText(judgeDelegate), '裁判转人工审批（出错回退 NOT_CONFIGURED）')
  assert.equal(yoloVerdictText(policyAllow), '策略放行（一次）')
  assert.equal(yoloVerdictText(errored), 'LLM 裁判拒绝（出错回退 BAD_OUTPUT）')
  assert.doesNotMatch(yoloVerdictText(errored), /raw provider text/)
  assert.equal(describeYoloDecision(judgedNoReason).who, 'LLM 裁判')
  assert.equal(describeYoloDecision({ time: 0, callId: 'x', decision: 'weird', outcome: 'weird' }).kind, 'unknown')
  // error 只认机器码形状:自由文本不上屏。
  assert.equal(yoloVerdictText({ time: 0, callId: 'x', decision: 'judge', outcome: 'rejected', error: 'Invalid API Key: sk-abc' }), 'LLM 裁判拒绝（裁判未留理由）')
})

test('W18 yoloTargetText: 有 resourcePath 才说;inWorkspace 三态;存量行(无字段)→ undefined', () => {
  const base = { time: 1, callId: 'c', decision: 'judge', outcome: 'rejected' }
  assert.equal(yoloTargetText(base), undefined)
  assert.equal(yoloTargetText({ ...base, resourcePath: '~/.dsh/logs/plans/plan-1.json', inWorkspace: false }), '目标 ~/.dsh/logs/plans/plan-1.json（工作区外）')
  assert.equal(yoloTargetText({ ...base, resourcePath: '~/Projects/x/src/a.ts', inWorkspace: true }), '目标 ~/Projects/x/src/a.ts（工作区内）')
  assert.equal(yoloTargetText({ ...base, resourcePath: 'rel/a', inWorkspace: null }), '目标 rel/a', '未采集不加括注')
  const parsed = parseYoloDecisionsPayload({ sessionId: 's', items: [{ ...base, resourcePath: '~/x', inWorkspace: 'yes', workspaceRoot: '~/w' }, { ...base, callId: 'd' }] })
  assert.equal(parsed.items[0]?.inWorkspace, null, '非布尔一律当未采集')
  assert.equal(parsed.items[0]?.workspaceRoot, '~/w')
  assert.equal(parsed.items[1]?.resourcePath, undefined)
  assert.equal(parsed.items[1]?.inWorkspace, null)
})
