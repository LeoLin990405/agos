/**
 * W22(a):回收站清单(GET /api/agos/session-trash)。只读;服务端不回绝对路径。
 * 数字全部由载荷算出(feedback_onscreen_claims_must_be_derived):日志几条、落点仍在几条、
 * 哪些根下有多少会话不在日志里——不写死「394」。
 */
export interface SessionTrashItem {
  at: string | undefined
  sessionId: string
  trashRoot: string | undefined
  project: string | undefined
  leaf: string | undefined
  kind: 'dir' | 'file' | 'symlink' | 'other' | 'missing' | 'outside' | 'unreadable' | 'unknown' | string
  /** true/false 是服务端 lstat 判过;null = 根外/形状不对,没探测(不是「不在」)。 */
  present: boolean | null
  /** undefined = 该行早于该字段(第一代格式),不是 false。 */
  projcachePruned: boolean | undefined
  projcacheReason: string | undefined
  sessionMemoryPruned: boolean | undefined
}

export interface SessionTrashRoot { root: string; sessionDirs: number; notInLog: number }

export interface SessionTrashPayload {
  version: number
  file: string
  fileExists: boolean
  count: number
  presentCount: number
  items: SessionTrashItem[]
  unloggedRoots: SessionTrashRoot[]
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const optStr = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined)
const optBool = (v: unknown): boolean | undefined => (typeof v === 'boolean' ? v : undefined)

export function parseSessionTrashPayload(value: unknown): SessionTrashPayload {
  if (!isRecord(value) || !Array.isArray(value.items) || !Array.isArray(value.unloggedRoots)) throw new Error('回收站响应缺少 items 或 unloggedRoots')
  const items: SessionTrashItem[] = []
  for (const row of value.items) {
    if (!isRecord(row) || typeof row.sessionId !== 'string') continue
    items.push({
      at: optStr(row.at),
      sessionId: row.sessionId,
      trashRoot: optStr(row.trashRoot),
      project: optStr(row.project),
      leaf: optStr(row.leaf),
      kind: optStr(row.kind) ?? 'unknown',
      present: row.present === true || row.present === false ? row.present : null,
      projcachePruned: optBool(row.projcachePruned),
      projcacheReason: optStr(row.projcacheReason),
      sessionMemoryPruned: optBool(row.sessionMemoryPruned),
    })
  }
  const unloggedRoots: SessionTrashRoot[] = []
  for (const r of value.unloggedRoots) {
    if (!isRecord(r) || typeof r.root !== 'string' || typeof r.sessionDirs !== 'number' || typeof r.notInLog !== 'number') continue
    unloggedRoots.push({ root: r.root, sessionDirs: r.sessionDirs, notInLog: r.notInLog })
  }
  return {
    version: typeof value.version === 'number' ? value.version : 0,
    file: optStr(value.file) ?? 'delete.log',
    fileExists: value.fileExists === true,
    count: typeof value.count === 'number' ? value.count : items.length,
    presentCount: typeof value.presentCount === 'number' ? value.presentCount : items.filter((it) => it.present === true).length,
    items,
    unloggedRoots,
  }
}

/** 摘要句:全部由载荷算出。 */
export function sessionTrashSummary(p: SessionTrashPayload): string {
  const head = p.fileExists ? `删除日志 ${p.count} 条,落点仍在 ${p.presentCount}/${p.count}` : `删除日志 ${p.file} 不存在`
  const unlogged = p.unloggedRoots.reduce((acc, r) => acc + r.notInLog, 0)
  const roots = p.unloggedRoots.filter((r) => r.notInLog > 0).length
  const tail = unlogged > 0 ? `;另有 ${roots} 个回收/备份根共 ${unlogged} 个会话不在日志里(更早的批量清理,日志没有它们)` : ''
  return head + tail
}

export function presentText(it: SessionTrashItem): string {
  if (it.present === true) return it.kind === 'symlink' ? '落点仍在(软链)' : '落点仍在'
  if (it.present === false) return '落点已不在'
  return it.kind === 'outside' ? '落点在 ~/.dsh 之外,未探测' : '落点未探测'
}

export function pruneText(it: SessionTrashItem): string {
  const pc = it.projcachePruned === undefined ? 'projcache 未记录' : it.projcachePruned ? 'projcache 已清' : `projcache 未清${it.projcacheReason !== undefined ? `(${it.projcacheReason})` : ''}`
  const sm = it.sessionMemoryPruned === undefined ? '' : it.sessionMemoryPruned ? ' · 会话记忆已清' : ' · 会话记忆未清'
  return pc + sm
}
