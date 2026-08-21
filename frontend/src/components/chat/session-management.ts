export interface SessionMetaSnapshot {
  pinned: string[]
  archived: string[]
  hostArchived: string[]
  hostArchivedAvailable: boolean
}

export interface SessionDeleteResult {
  trashedTo: string
}

export type SessionManagementFetch = (
  input: string,
  init?: RequestInit,
) => Promise<Response>

const uniqueStrings = (value: unknown): string[] => {
  if (!Array.isArray(value)) return []
  return [...new Set(value.filter((item): item is string => typeof item === 'string' && item !== ''))]
}

const readJsonObject = async (response: Response): Promise<Record<string, unknown>> => {
  let body: unknown
  try {
    body = await response.json()
  } catch {
    body = undefined
  }
  if (!response.ok) {
    const bodyRecord = body as Record<string, unknown> | undefined
    const message = typeof bodyRecord?.['message'] === 'string'
      ? String(bodyRecord['message'])
      : typeof bodyRecord?.['error'] === 'string'
        ? String(bodyRecord['error'])
        : `请求失败（HTTP ${response.status}）`
    throw new Error(message)
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new Error('会话管理服务返回了无效响应')
  }
  return body as Record<string, unknown>
}

export function parseSessionMeta(body: Record<string, unknown>): SessionMetaSnapshot {
  return {
    pinned: uniqueStrings(body['pinned']),
    archived: uniqueStrings(body['archived']),
    hostArchived: uniqueStrings(body['hostArchived']),
    hostArchivedAvailable: body['hostArchivedAvailable'] !== false,
  }
}

/** Field-scoped merges keep independent pin/archive responses from erasing each other. */
export function mergePinnedSnapshot(
  current: SessionMetaSnapshot,
  snapshot: Pick<SessionMetaSnapshot, 'pinned'>,
): SessionMetaSnapshot {
  return { ...current, pinned: snapshot.pinned }
}

export function mergeArchivedSnapshot(
  current: SessionMetaSnapshot,
  snapshot: Pick<SessionMetaSnapshot, 'archived'>,
): SessionMetaSnapshot {
  return { ...current, archived: snapshot.archived }
}

export async function fetchSessionMeta(
  fetchImpl: SessionManagementFetch = (input, init) => fetch(input, init),
): Promise<SessionMetaSnapshot> {
  const response = await fetchImpl('/api/agos/session-meta', {
    method: 'GET',
    headers: { accept: 'application/json' },
  })
  return parseSessionMeta(await readJsonObject(response))
}

export async function setSessionPinned(
  sessionId: string,
  pinned: boolean,
  fetchImpl: SessionManagementFetch = (input, init) => fetch(input, init),
): Promise<SessionMetaSnapshot> {
  const response = await fetchImpl('/api/agos/session-meta/pin', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId, pinned }),
  })
  return parseSessionMeta(await readJsonObject(response))
}

export async function setSessionArchived(
  sessionId: string,
  archived: boolean,
  fetchImpl: SessionManagementFetch = (input, init) => fetch(input, init),
): Promise<SessionMetaSnapshot> {
  const response = await fetchImpl('/api/agos/session-meta/archive', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId, archived }),
  })
  return parseSessionMeta(await readJsonObject(response))
}

export async function trashSession(
  sessionId: string,
  fetchImpl: SessionManagementFetch = (input, init) => fetch(input, init),
): Promise<SessionDeleteResult> {
  const response = await fetchImpl('/api/agos/session/delete', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId }),
  })
  const body = await readJsonObject(response)
  if (typeof body['trashedTo'] !== 'string' || body['trashedTo'] === '') {
    throw new Error('会话管理服务未返回回收站位置')
  }
  return { trashedTo: body['trashedTo'] }
}

export function basenameOfPath(path: string): string {
  const normalized = path.replace(/[\\/]+$/, '')
  const parts = normalized.split(/[\\/]/)
  return parts.at(-1) || path || '未指定目录'
}

export function formatSessionRelativeTime(updatedAt: number, now = Date.now()): string {
  if (!Number.isFinite(updatedAt) || updatedAt <= 0) return '未知时间'
  const elapsed = Math.max(0, now - updatedAt)
  if (elapsed < 60_000) return '刚刚'
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}分钟前`
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}小时前`
  if (elapsed < 604_800_000) return `${Math.floor(elapsed / 86_400_000)}天前`
  return new Date(updatedAt).toLocaleDateString()
}

export interface PartitionableSession {
  id: string
  updatedAt: number
}

export function partitionSessions<T extends PartitionableSession>(
  sessions: T[],
  pinnedIds: readonly string[],
  archivedIds: ReadonlySet<string>,
): { pinned: T[], recent: T[], archived: T[] } {
  const pinnedOrder = new Map(pinnedIds.map((id, index) => [id, index]))
  const pinned: T[] = []
  const recent: T[] = []
  const archived: T[] = []
  for (const session of sessions) {
    if (archivedIds.has(session.id)) archived.push(session)
    else if (pinnedOrder.has(session.id)) pinned.push(session)
    else recent.push(session)
  }
  pinned.sort((a, b) => (pinnedOrder.get(a.id) ?? 0) - (pinnedOrder.get(b.id) ?? 0))
  recent.sort((a, b) => b.updatedAt - a.updatedAt)
  archived.sort((a, b) => b.updatedAt - a.updatedAt)
  return { pinned, recent, archived }
}

export function pickFirstVisibleSession<T extends { id: string }>(
  sessions: T[],
  excludedIds: ReadonlySet<string>,
  archivedIds: ReadonlySet<string>,
): T | undefined {
  return sessions.find((session) => !excludedIds.has(session.id) && !archivedIds.has(session.id))
}
