import assert from 'node:assert/strict'
import test from 'node:test'
import { parseSessionTrashPayload, presentText, pruneText, sessionTrashSummary } from './session-trash-model.ts'

// 照 2026-08-23 实测 GET /api/agos/session-trash 形状(项目段为 home 折叠形)
const live = {
  version: 1, file: 'delete.log', fileExists: true, count: 4, presentCount: 4,
  items: [
    { at: '2026-08-21T01:49:14.964Z', sessionId: 'session-7bd84231-d7ec-4f45-a0fb-72fba77e6efb', trashRoot: 'sessions-trash-20260821', project: '~-Documents-kimi-workspace-agos-frontend', leaf: 'session-7bd84231-d7ec-4f45-a0fb-72fba77e6efb', kind: 'dir', present: true },
    { at: '2026-08-21T07:56:08.162Z', sessionId: 'session-38afb009', trashRoot: 'sessions-trash-20260821', project: '~-Documents-kimi-workspace-agos-frontend', leaf: 'session-38afb009', kind: 'dir', present: true, projcachePruned: false, projcacheReason: 'unavailable' },
    { at: '2026-08-21T07:58:03.321Z', sessionId: 'session-beb5a334', trashRoot: 'sessions-trash-20260821', project: '~', leaf: 'session-beb5a334', kind: 'dir', present: true, projcachePruned: true },
    { at: '2026-08-21T08:00:00.000Z', sessionId: 'session-evil', kind: 'outside', present: null },
  ],
  unloggedRoots: [
    { root: 'sessions-backup-20260818-swarmfix', sessionDirs: 20, notInLog: 20 },
    { root: 'sessions-trash-20260820', sessionDirs: 393, notInLog: 393 },
    { root: 'sessions-trash-20260821', sessionDirs: 4, notInLog: 0 },
    { root: 'sessions-trash-20260821-085347', sessionDirs: 7, notInLog: 3 },
  ],
}

test('W22 回收站:解析保留三态与「未记录」;摘要全部由载荷算出', () => {
  const p = parseSessionTrashPayload(live)
  assert.equal(p.items.length, 4)
  assert.equal(p.items[0]?.projcachePruned, undefined)
  assert.equal(p.items[3]?.present, null)
  assert.equal(sessionTrashSummary(p), '删除日志 4 条,落点仍在 4/4;另有 3 个回收/备份根共 416 个会话不在日志里(更早的批量清理,日志没有它们)')
  assert.equal(presentText(p.items[0]!), '落点仍在')
  assert.equal(presentText(p.items[3]!), '落点在 ~/.dsh 之外,未探测')
  assert.equal(presentText({ ...p.items[0]!, present: false, kind: 'missing' }), '落点已不在')
  assert.equal(pruneText(p.items[0]!), 'projcache 未记录')
  assert.equal(pruneText(p.items[1]!), 'projcache 未清(unavailable)')
  assert.equal(pruneText(p.items[2]!), 'projcache 已清')
  assert.equal(sessionTrashSummary(parseSessionTrashPayload({ ...live, fileExists: false, count: 0, presentCount: 0, items: [], unloggedRoots: [] })), '删除日志 delete.log 不存在')
  assert.throws(() => parseSessionTrashPayload({ items: [] }), /unloggedRoots/)
  assert.doesNotMatch(JSON.stringify(p), /\/Users\//)
})
