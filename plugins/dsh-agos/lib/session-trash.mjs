// W22(a)(TASK-2026-08-22-017 第三档):删除审计的可恢复清单。**只读** ~/.dsh/agos/delete.log
// (写端 index.js appendDeleteAudit:lstat 拒软链 + O_NOFOLLOW),这里不写它、不动回收站。
//
// 行格式三代并存(2026-08-21 实测 4 行):
//   {at, sessionId, trashedTo}                                   ← 第一代
//   {…, projcachePruned:false, projcacheReason:'unavailable'}    ← 第二代
//   {…, projcachePruned:true}                                    ← 第三代
// 可选字段缺席 = 「未记录」,不是 false;读端原样保留 undefined。
//
// 隐私与安全:
// - 3091 监听 *:3091,响应**不回绝对路径**:trashedTo 只拆成 {trashRoot, projectKey, leaf}(相对 dshRoot 的三段);
//   projectKey 是编码过的 cwd(`--Users-leo-Documents-…--`),仍含用户名,对外把 home 前缀折成 `~`(末段还原不了,见 projectLabel)。
// - 逐行 lstat 校验落点「仍在」:先 isAbsolute + relative(dshRoot) 不含 '..' 才 lstat;日志若被篡改指向根外,
//   标 kind:'outside' 且不探测(不把日志内容当路径探针)。lstat 不跟软链;落点是软链也标出来。
// - delete.log 自身若是软链 → 拒读(与写端对称)。
//
// 诚实:sessions-trash-20260820(393 个二级目录,392 个带 session.jsonl.zstd)等更早的批量清理**不在日志里**;unloggedRoots 按根级统计
// 「该根下有多少会话目录、其中多少不在日志里」,数字由接口实算,界面不写死 394。
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'

export const TRASH_FIELDS = Object.freeze(['at', 'sessionId', 'trashedTo', 'projcachePruned', 'projcacheReason', 'sessionMemoryPruned'])
/** 会话目录的判据是「里面有 session.jsonl(.zstd)」:回收站里 session-<uuid> 与裸 <uuid>(子代理)两种名字并存,按名字会漏掉 256/393。 */
const SESSION_FILES = ['session.jsonl.zstd', 'session.jsonl']
const ROOT_RE = /^sessions-(trash|backup)-/

export function defaultDeleteLogFile(env = process.env) {
  return env.DSH_AGOS_DELETE_LOG || join(homedir(), '.dsh', 'agos', 'delete.log')
}

export function defaultDshRoot(env = process.env) {
  return env.DSH_HOME || join(homedir(), '.dsh')
}

/** 读 delete.log:软链/非实体 → 抛 {code:'DELETE_LOG_PATH_INVALID'};缺文件 → [];坏行丢弃不发明。 */
export function readDeleteLogRows(file) {
  if (!file || !existsSync(file)) return []
  const st = lstatSync(file)
  if (st.isSymbolicLink() || !st.isFile()) {
    const err = new Error('delete.log 必须是实体文件')
    err.code = 'DELETE_LOG_PATH_INVALID'
    err.status = 403
    throw err
  }
  const rows = []
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue
    try {
      const row = JSON.parse(line)
      if (row && typeof row === 'object' && typeof row.sessionId === 'string' && typeof row.trashedTo === 'string') rows.push(row)
    } catch { /* 半行/坏行丢弃 */ }
  }
  return rows
}

/** trashedTo 相对 dshRoot 的三段;根外或形状不对 → null。 */
export function splitTrashedTo(trashedTo, dshRoot) {
  if (typeof trashedTo !== 'string' || !isAbsolute(trashedTo)) return null
  const rel = relative(resolve(dshRoot), resolve(trashedTo))
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return null
  const parts = rel.split(sep)
  if (parts.length !== 3) return null
  const [trashRoot, projectKey, leaf] = parts
  if (!ROOT_RE.test(trashRoot)) return null
  return { trashRoot, projectKey, leaf }
}

/**
 * projectKey 是 cwd 把 `/` 换成 `-` 的编码(`--Users-leo-Documents-kimi-workspace-agos-frontend--`),
 * 目录名里自带的 `-` 与分隔符不可区分,**还原不了**末段(`agos-frontend` 会被切成 `frontend`)。
 * 所以只做一件确定的事:把 home 前缀折成 `~`,其余原样——`~-Documents-kimi-workspace-agos-frontend`。
 * 用户名不出响应;可读性交给前端(把 `-` 当分隔展示即可)。
 */
export function projectLabel(projectKey, home = homedir()) {
  if (typeof projectKey !== 'string') return undefined
  const inner = projectKey.replace(/^-+|-+$/g, '')
  if (inner === '') return undefined
  const homeKey = resolve(home).split(sep).filter(Boolean).join('-')
  if (inner === homeKey) return '~'
  if (inner.startsWith(homeKey + '-')) return '~-' + inner.slice(homeKey.length + 1)
  return inner
}

/**
 * 一行审计 → 对外条目。present 三态:true/false 是 lstat 判过;null = 根外/形状不对,没探测。
 */
export function describeTrashEntry(row, dshRoot, home = homedir()) {
  const split = splitTrashedTo(row.trashedTo, dshRoot)
  const out = {
    at: typeof row.at === 'string' ? row.at : undefined,
    sessionId: row.sessionId,
    trashRoot: split ? split.trashRoot : undefined,
    project: split ? projectLabel(split.projectKey, home) : undefined,
    leaf: split ? split.leaf : undefined,
    kind: 'unknown',
    present: null,
    projcachePruned: typeof row.projcachePruned === 'boolean' ? row.projcachePruned : undefined,
    projcacheReason: typeof row.projcacheReason === 'string' ? row.projcacheReason : undefined,
    sessionMemoryPruned: typeof row.sessionMemoryPruned === 'boolean' ? row.sessionMemoryPruned : undefined,
  }
  if (!split) {
    out.kind = 'outside'
    return out
  }
  const target = join(resolve(dshRoot), split.trashRoot, split.projectKey, split.leaf)
  try {
    const st = lstatSync(target)
    out.present = true
    out.kind = st.isSymbolicLink() ? 'symlink' : st.isDirectory() ? 'dir' : st.isFile() ? 'file' : 'other'
  } catch (err) {
    if (err && err.code === 'ENOENT') { out.present = false; out.kind = 'missing' }
    else { out.present = null; out.kind = 'unreadable' }
  }
  return out
}

/**
 * 回收/备份根的根级统计:每根下的二级会话目录数,以及其中不在日志里的数。
 * readdir 三层(根/项目/会话/文件);空目录(`_no-cwd/preset-user-default/` 真实存在,无会话文件)不计。
 */
export function summarizeUnloggedRoots(dshRoot, loggedIds) {
  const logged = new Set(loggedIds)
  const out = []
  let names = []
  try { names = readdirSync(resolve(dshRoot)) } catch { return out }
  for (const name of names.sort()) {
    if (!ROOT_RE.test(name)) continue
    const root = join(resolve(dshRoot), name)
    let sessionDirs = 0
    let notInLog = 0
    let projects = []
    try { projects = readdirSync(root, { withFileTypes: true }) } catch { continue }
    for (const p of projects) {
      if (!p.isDirectory()) continue
      let leaves = []
      try { leaves = readdirSync(join(root, p.name), { withFileTypes: true }) } catch { continue }
      for (const l of leaves) {
        if (!l.isDirectory()) continue
        let inner = []
        try { inner = readdirSync(join(root, p.name, l.name)) } catch { continue }
        if (!inner.some((n) => SESSION_FILES.includes(n))) continue
        sessionDirs += 1
        if (!logged.has(l.name)) notInLog += 1
      }
    }
    out.push({ root: name, sessionDirs, notInLog })
  }
  return out
}

export function buildSessionTrashPayload({ file, dshRoot }) {
  const rows = readDeleteLogRows(file)
  const items = rows.map((row) => describeTrashEntry(row, dshRoot))
  const unloggedRoots = summarizeUnloggedRoots(dshRoot, rows.map((r) => basename(String(r.trashedTo))))
  return {
    version: 1,
    file: basename(file),
    fileExists: existsSync(file),
    count: items.length,
    presentCount: items.filter((it) => it.present === true).length,
    items,
    unloggedRoots,
  }
}

export function createSessionTrashRoute({ file, dshRoot, sendJson }) {
  return ['/api/agos/session-trash', async (req, res) => {
    if (req.method !== 'GET') { sendJson(res, 405, { error: 'GET only' }, { allow: 'GET' }); return }
    try {
      sendJson(res, 200, buildSessionTrashPayload({ file, dshRoot }))
    } catch (err) {
      if (err && err.code === 'DELETE_LOG_PATH_INVALID') { sendJson(res, 403, { error: err.code, message: err.message }); return }
      throw err
    }
  }]
}
