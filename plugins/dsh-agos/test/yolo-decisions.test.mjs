import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { createYoloDecisionsRoute, readYoloRows, selectYoloDecisions } from '../lib/yolo-decisions.mjs'

// 夹具照 ~/.dsh/logs/yolo-judge.jsonl 真实行(脱敏):前两行是 2026-08-20 修复前格式,judge+rejected 却无 reason。
const S = 'session-0b4b785c-1e7c-4223-bf0e-371d7f75b690'
const ROWS = [
  { time: 1787056815348, sessionId: S, origin: 'main', toolName: 'bash', callId: 'call_00_f712', targetMode: 'danger-full-access', currentMode: 'workspace-write', justification: '用户明确要求在工作区外创建…', decision: 'judge', outcome: 'rejected' },
  { time: 1787056815000, sessionId: S, origin: 'main', toolName: 'write', callId: 'call_00_euku', targetMode: 'danger-full-access', currentMode: 'workspace-write', justification: 'x', decision: 'delegate', outcome: 'delegate' },
  { time: 1787329554869, sessionId: 'agos-upgrade-w3', origin: 'probe', toolName: 'bash', callId: 'probe-w3-yolo', targetMode: 'workspace-write', currentMode: 'read-only', justification: 'W3 probe', decision: 'deny', reason: 'permission scope exceeds stated need', outcome: 'rejected' },
  { time: 1787056816000, sessionId: S, origin: 'main', toolName: 'bash', targetMode: 'x', currentMode: 'y', justification: 'no callId', decision: 'judge', outcome: 'rejected' },
  { time: 1787056817000, sessionId: S, origin: 'main', toolName: 'bash', callId: 'call_00_f712', targetMode: 'x', currentMode: 'y', justification: 'retry', decision: 'judge', outcome: 'allowed-once', reason: 'scope now matches', secret: 'should-not-leak' },
]

test('selectYoloDecisions:只取该会话且有 callId 的行,按 time 升序,只透传白名单字段,justification 截短', () => {
  const items = selectYoloDecisions([...ROWS, { time: 1, sessionId: S, callId: 'c', decision: 'judge', outcome: 'rejected', justification: 'J'.repeat(1000) }], S)
  assert.deepEqual(items.map((r) => [r.callId, r.decision, r.outcome]), [['c', 'judge', 'rejected'], ['call_00_euku', 'delegate', 'delegate'], ['call_00_f712', 'judge', 'rejected'], ['call_00_f712', 'judge', 'allowed-once']])
  assert.equal('reason' in items[2], false)            // 修复前格式:裁判未留理由,不发明
  assert.equal(items[3].reason, 'scope now matches')
  assert.equal('secret' in items[3], false)
  assert.equal('sessionId' in items[0], false)
  assert.equal(items[0].justification.length, 300)
  assert.deepEqual(selectYoloDecisions(ROWS, 'nope'), [])
  assert.equal(selectYoloDecisions(ROWS, S, 1).length, 1)
})

test('readYoloRows:缺文件 → [];半行/坏行丢弃', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'yolo-'))
  assert.deepEqual(readYoloRows(join(dir, 'missing.jsonl')), [])
  const file = join(dir, 'yolo-judge.jsonl')
  await writeFile(file, ROWS.map((r) => JSON.stringify(r)).join('\n') + '\n{"time":1,"sessionId":"' + S + '","callId":"half"')
  assert.equal(readYoloRows(file).length, ROWS.length)
})

test('路由:GET only;sessionId 经 validateSessionId;200 形状 {version, sessionId, file, count, items}', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'yolo-'))
  const file = join(dir, 'yolo-judge.jsonl')
  await writeFile(file, ROWS.map((r) => JSON.stringify(r)).join('\n') + '\n')
  const sent = []
  const sendJson = (res, status, body) => { sent.push({ status, body }) }
  const validateSessionId = (v) => { if (typeof v !== 'string' || !v || v.includes('/')) { const e = new Error('bad'); e.status = 400; throw e } }
  const [path, handler] = createYoloDecisionsRoute({ file, validateSessionId, sendJson })
  assert.equal(path, '/api/agos/yolo-decisions')
  const req = (method, url) => Object.assign(Readable.from([]), { method, url, headers: {} })
  await handler(req('POST', '/api/agos/yolo-decisions?sessionId=' + S), {})
  assert.equal(sent.at(-1).status, 405)
  await assert.rejects(() => handler(req('GET', '/api/agos/yolo-decisions?sessionId=a/b'), {}))
  await handler(req('GET', `/api/agos/yolo-decisions?sessionId=${S}&limit=2`), {})
  const ok = sent.at(-1)
  assert.equal(ok.status, 200)
  assert.deepEqual(Object.keys(ok.body), ['version', 'sessionId', 'file', 'count', 'items'])
  assert.equal(ok.body.count, 2)
  assert.equal(ok.body.file, file)
})
