export type SessionCreateFetch = (
  input: string,
  init?: RequestInit,
) => Promise<Response>

export interface CreateNamedSessionParams {
  cwd: string
  title?: string
  agentPreset?: string
}

export interface CreateNamedSessionOk {
  ok: true
  sessionId: string
  title?: string
}

export interface CreateNamedSessionErr {
  ok: false
  error: string
}

export type CreateNamedSessionResult = CreateNamedSessionOk | CreateNamedSessionErr

export interface CreateNamedSessionDeps {
  statWorkspace?: (cwd: string) => Promise<{ exists: boolean, isDirectory: boolean } | { error: string }>
  createSession: (params: { cwd: string, agentPreset?: string }) => Promise<string | undefined>
  renameSession: (
    sessionId: string,
    title: string,
  ) => Promise<{ ok: true, title: string } | { ok: false, error: string }>
}

const TITLE_MAX = 200

export function normalizeSessionTitle(title: string | undefined): string | undefined {
  if (typeof title !== 'string') return undefined
  const trimmed = title.trim()
  if (trimmed === '') return undefined
  return trimmed.length > TITLE_MAX ? trimmed.slice(0, TITLE_MAX) : trimmed
}

export function validateSessionCwdShape(cwd: string): { ok: true, cwd: string } | { ok: false, error: string } {
  const dir = cwd.trim()
  if (dir === '') return { ok: false, error: '工作目录未采集:宿主未返回 home,请手输绝对路径' }
  if (dir.includes('\0')) return { ok: false, error: '工作目录含非法字符' }
  if (!dir.startsWith('/')) return { ok: false, error: '工作目录必须是绝对路径' }
  return { ok: true, cwd: dir }
}

export async function statWorkspacePath(
  cwd: string,
  fetchImpl: SessionCreateFetch = (input, init) => fetch(input, init),
): Promise<{ exists: boolean, isDirectory: boolean } | { error: string }> {
  try {
    const response = await fetchImpl('/api/agos/workspace-stat', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ path: cwd }),
    })
    let body: unknown
    try {
      body = await response.json()
    } catch {
      body = undefined
    }
    const record = body !== null && typeof body === 'object' && !Array.isArray(body)
      ? body as Record<string, unknown>
      : undefined
    if (!response.ok) {
      const message = typeof record?.['error'] === 'string' ? record['error'] : `无法核验工作目录（HTTP ${response.status}）`
      return { error: message }
    }
    if (typeof record?.['exists'] !== 'boolean' || typeof record['isDirectory'] !== 'boolean') {
      return { error: '工作目录核验返回了无效响应' }
    }
    return { exists: record['exists'], isDirectory: record['isDirectory'] }
  } catch (error) {
    return { error: String((error as Error)?.message ?? error) }
  }
}

export function workspaceStatError(
  stat: { exists: boolean, isDirectory: boolean } | { error: string },
): string | undefined {
  if ('error' in stat) return stat.error
  if (!stat.exists) return '工作目录不存在'
  if (!stat.isDirectory) return '工作目录必须是目录'
  return undefined
}

export async function createNamedSession(
  params: CreateNamedSessionParams,
  deps: CreateNamedSessionDeps,
): Promise<CreateNamedSessionResult> {
  const shaped = validateSessionCwdShape(params.cwd)
  if (!shaped.ok) return shaped
  const stat = await (deps.statWorkspace ?? ((cwd: string) => statWorkspacePath(cwd)))(shaped.cwd)
  const statError = workspaceStatError(stat)
  if (statError !== undefined) return { ok: false, error: statError }

  const sessionId = await deps.createSession({
    cwd: shaped.cwd,
    ...(params.agentPreset !== undefined ? { agentPreset: params.agentPreset } : {}),
  })
  if (sessionId === undefined || sessionId === '') {
    return { ok: false, error: '创建失败:宿主拒绝了这次会话创建' }
  }

  const title = normalizeSessionTitle(params.title)
  if (title === undefined) return { ok: true, sessionId }

  const renamed = await deps.renameSession(sessionId, title)
  return { ok: true, sessionId, title: renamed.ok ? renamed.title : title }
}
