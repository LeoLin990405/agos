// W22(a):GET /api/agos/session-trash 只读、不回绝对路径、逐行 lstat、根级统计未入日志的会话。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  readDeleteLogRows, splitTrashedTo, projectLabel, describeTrashEntry, summarizeUnloggedRoots,
  buildSessionTrashPayload, createSessionTrashRoute,
} from '../lib/session-trash.mjs'

function fixture() {
  const dsh = mkdtempSync(join(tmpdir(), 'agos-trash-'))
  const agos = join(dsh, 'agos'); mkdirSync(agos)
  // 三个根:2026-08-21 的 4 条日志落点 + 一个更早的批量清理根(不在日志里)+ 一个备份根
  const r1 = join(dsh, 'sessions-trash-20260821')
  const p1 = join(r1, '--Users-leo-Documents-kimi-workspace-agos-frontend--')
  const p2 = join(r1, '--Users-leo--')
  const sess = (dir) => { mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'session.jsonl.zstd'), '') }
  sess(join(p1, 'session-7bd84231-d7ec-4f45-a0fb-72fba77e6efb'))
  sess(join(p1, 'session-ae769c4c-75a9-4e20-b229-38fe67dd4ae2'))
  // 第三条的落点已不在(模拟被手动清掉)
  sess(join(p2, 'session-beb5a334-bf2a-4709-bc05-4f8356e39de3'))
  const r0 = join(dsh, 'sessions-trash-20260820')
  sess(join(r0, '--Users-leo--', 'session-00000000-aaaa'))
  sess(join(r0, '--Users-leo--', '0c1d2e3f-0000-4000-8000-000000000000')) // 子代理会话:裸 uuid 名,也是会话
  mkdirSync(join(r0, '_no-cwd', 'preset-user-default'), { recursive: true }) // 真实存在的空目录,不是会话
  mkdirSync(join(r0, '--Users-leo--', 'session-00000000-empty'), { recursive: true }) // 有名无文件,不计
  const rb = join(dsh, 'sessions-backup-20260818-swarmfix')
  sess(join(rb, '--Users-leo--', 'session-00000000-cccc'))
  // 日志照抄真实三代格式(路径换成夹具根)
  const rows = [
    { at: '2026-08-21T01:49:14.964Z', sessionId: 'session-7bd84231-d7ec-4f45-a0fb-72fba77e6efb', trashedTo: join(p1, 'session-7bd84231-d7ec-4f45-a0fb-72fba77e6efb') },
    { at: '2026-08-21T01:49:56.751Z', sessionId: 'session-ae769c4c-75a9-4e20-b229-38fe67dd4ae2', trashedTo: join(p1, 'session-ae769c4c-75a9-4e20-b229-38fe67dd4ae2') },
    { at: '2026-08-21T07:56:08.162Z', sessionId: 'session-38afb009-9e52-40ef-b222-d73d9ae1b31b', trashedTo: join(p1, 'session-38afb009-9e52-40ef-b222-d73d9ae1b31b'), projcachePruned: false, projcacheReason: 'unavailable' },
    { at: '2026-08-21T07:58:03.321Z', sessionId: 'session-beb5a334-bf2a-4709-bc05-4f8356e39de3', trashedTo: join(p2, 'session-beb5a334-bf2a-4709-bc05-4f8356e39de3'), projcachePruned: true },
    // 篡改行:指向根外;不得 lstat
    { at: '2026-08-21T08:00:00.000Z', sessionId: 'session-evil', trashedTo: '/etc/passwd' },
    // 篡改行:穿越
    { at: '2026-08-21T08:00:01.000Z', sessionId: 'session-evil2', trashedTo: join(dsh, 'sessions-trash-20260821', '..', '..', 'x', 'session-evil2') },
  ]
  const file = join(agos, 'delete.log')
  writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n{broken\n')
  return { dsh, file, p1, p2 }
}

test('splitTrashedTo / projectLabel:只认 dshRoot 下「根/项目/会话」三段且根名合规;projectKey 只回末段', () => {
  const dsh = '/x/.dsh'
  assert.deepEqual(splitTrashedTo('/x/.dsh/sessions-trash-20260821/--Users-leo--/session-a', dsh), { trashRoot: 'sessions-trash-20260821', projectKey: '--Users-leo--', leaf: 'session-a' })
  assert.equal(splitTrashedTo('/x/.dsh/sessions/--Users-leo--/session-a', dsh), null, '活跃根不是回收站')
  assert.equal(splitTrashedTo('/x/.dsh/sessions-trash-1/a/b/c', dsh), null, '层数不对')
  assert.equal(splitTrashedTo('/etc/passwd', dsh), null)
  assert.equal(splitTrashedTo('/x/.dsh/sessions-trash-1/../../etc/session-a', dsh), null)
  assert.equal(splitTrashedTo('relative/x/y', dsh), null)
  assert.equal(projectLabel('--Users-leo-Documents-kimi-workspace-agos-frontend--', '/Users/leo'), '~-Documents-kimi-workspace-agos-frontend', '末段还原不了(agos-frontend 的 - 与分隔符不可分),只折 home')
  assert.equal(projectLabel('--Users-leo--', '/Users/leo'), '~')
  assert.equal(projectLabel('--Users-leonard-x--', '/Users/leo'), 'Users-leonard-x', '同前缀别的用户不折')
  assert.equal(projectLabel('_no-cwd', '/Users/leo'), '_no-cwd')
})

test('读端:delete.log 为软链 → DELETE_LOG_PATH_INVALID;缺文件 → [];坏行丢弃', () => {
  const { dsh, file } = fixture()
  assert.equal(readDeleteLogRows(file).length, 6)
  assert.deepEqual(readDeleteLogRows(join(dsh, 'nope.log')), [])
  const link = join(dsh, 'agos', 'delete-link.log')
  symlinkSync(file, link)
  assert.throws(() => readDeleteLogRows(link), (e) => e.code === 'DELETE_LOG_PATH_INVALID' && e.status === 403)
  rmSync(dsh, { recursive: true, force: true })
})

test('describeTrashEntry:落点仍在 present:true;缺失 false;根外/穿越 kind outside 且 present null(不探测);软链标 symlink', () => {
  const { dsh, file, p1 } = fixture()
  const rows = readDeleteLogRows(file)
  const items = rows.map((r) => describeTrashEntry(r, dsh, '/Users/leo'))
  assert.equal(items[0].present, true); assert.equal(items[0].kind, 'dir'); assert.equal(items[0].project, '~-Documents-kimi-workspace-agos-frontend')
  assert.equal(items[2].present, false); assert.equal(items[2].kind, 'missing')
  assert.equal(items[2].projcachePruned, false); assert.equal(items[2].projcacheReason, 'unavailable')
  assert.equal(items[0].projcachePruned, undefined, '第一代行缺字段 = 未记录,不是 false')
  assert.equal(items[3].project, '~'); assert.equal(items[3].projcachePruned, true)
  assert.equal(items[4].kind, 'outside'); assert.equal(items[4].present, null); assert.equal(items[4].trashRoot, undefined)
  assert.equal(items[5].kind, 'outside'); assert.equal(items[5].present, null)
  // 软链落点
  symlinkSync(join(p1, 'session-7bd84231-d7ec-4f45-a0fb-72fba77e6efb'), join(p1, 'session-linklink-0000'))
  const sym = describeTrashEntry({ sessionId: 'session-linklink-0000', trashedTo: join(p1, 'session-linklink-0000') }, dsh)
  assert.equal(sym.kind, 'symlink'); assert.equal(sym.present, true)
  // 整个条目不含绝对路径
  for (const it of items) assert.doesNotMatch(JSON.stringify(it), /\/Users\/|\/tmp\/|\/private\/|Users-leo/)
  rmSync(dsh, { recursive: true, force: true })
})

test('summarizeUnloggedRoots:按根统计「含 session.jsonl(.zstd)」的会话目录与未入日志数;空目录/有名无文件不计;裸 uuid 名也计', () => {
  const { dsh, file } = fixture()
  const logged = readDeleteLogRows(file).map((r) => r.trashedTo.split('/').pop())
  const roots = summarizeUnloggedRoots(dsh, logged)
  assert.deepEqual(roots, [
    { root: 'sessions-backup-20260818-swarmfix', sessionDirs: 1, notInLog: 1 },
    { root: 'sessions-trash-20260820', sessionDirs: 2, notInLog: 2 },
    { root: 'sessions-trash-20260821', sessionDirs: 3, notInLog: 0 },
  ])
  rmSync(dsh, { recursive: true, force: true })
})

test('路由:GET 200 形状;POST 405;软链日志 403;响应不含绝对路径', async () => {
  const { dsh, file } = fixture()
  const calls = []
  const sendJson = (res, status, body, headers) => { calls.push({ status, body, headers }) }
  const [path, handler] = createSessionTrashRoute({ file, dshRoot: dsh, sendJson })
  assert.equal(path, '/api/agos/session-trash')
  await handler({ method: 'POST', url: path }, {})
  assert.equal(calls[0].status, 405); assert.equal(calls[0].headers.allow, 'GET')
  await handler({ method: 'GET', url: path }, {})
  const body = calls[1].body
  assert.equal(calls[1].status, 200)
  assert.equal(body.version, 1); assert.equal(body.file, 'delete.log'); assert.equal(body.fileExists, true)
  assert.equal(body.count, 6); assert.equal(body.presentCount, 3)
  assert.equal(body.items.length, 6); assert.equal(body.unloggedRoots.length, 3)
  assert.doesNotMatch(JSON.stringify(body), /\/Users\/|\/tmp\/|\/private\//, '3091 监听 *:3091,不回绝对路径')
  const link = join(dsh, 'agos', 'link.log'); symlinkSync(file, link)
  const [, h2] = createSessionTrashRoute({ file: link, dshRoot: dsh, sendJson })
  await h2({ method: 'GET', url: path }, {})
  assert.equal(calls[2].status, 403); assert.equal(calls[2].body.error, 'DELETE_LOG_PATH_INVALID')
  // 缺文件:fileExists false、count 0,根统计照常
  const [, h3] = createSessionTrashRoute({ file: join(dsh, 'agos', 'none.log'), dshRoot: dsh, sendJson })
  await h3({ method: 'GET', url: path }, {})
  assert.equal(calls[3].body.fileExists, false); assert.equal(calls[3].body.count, 0); assert.equal(calls[3].body.unloggedRoots.length, 3)
  assert.equal(buildSessionTrashPayload({ file, dshRoot: dsh }).count, 6)
  rmSync(dsh, { recursive: true, force: true })
})
