// POST /api/agos/workspace-stat —— 只回答「这条绝对路径现在是不是目录」。
// 不回 realpath、不列目录、不跟到根外探测。session/create 自己不拒不存在的 cwd,
// 创建对话框必须在建会话之前先问这里。
import { statSync } from 'node:fs'
import { isAbsolute } from 'node:path'

export function inspectWorkspacePath(input) {
  if (typeof input !== 'string') {
    return { ok: false, code: 'CWD_INVALID', error: '工作目录必须是字符串' }
  }
  const path = input.trim()
  if (path === '') {
    return { ok: false, code: 'CWD_MISSING', error: '工作目录未填写' }
  }
  if (path.includes('\0')) {
    return { ok: false, code: 'CWD_INVALID', error: '工作目录含非法字符' }
  }
  if (!isAbsolute(path)) {
    return { ok: false, code: 'CWD_NOT_ABSOLUTE', error: '工作目录必须是绝对路径' }
  }
  try {
    const st = statSync(path)
    return { ok: true, exists: true, isDirectory: st.isDirectory() }
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return { ok: true, exists: false, isDirectory: false }
    }
    return { ok: false, code: 'CWD_UNREADABLE', error: '无法核验工作目录' }
  }
}

export function assertUsableWorkspace(result) {
  if (!result || result.ok === false) return result
  if (result.exists !== true) {
    return { ok: false, code: 'CWD_NOT_FOUND', error: '工作目录不存在' }
  }
  if (result.isDirectory !== true) {
    return { ok: false, code: 'CWD_NOT_DIRECTORY', error: '工作目录必须是目录' }
  }
  return { ok: true }
}

export function createWorkspaceStatRoute({ sendJson, readJsonBody }) {
  return ['/api/agos/workspace-stat', async (req, res) => {
    if (req.method !== 'POST') {
      sendJson(res, 405, { error: 'POST only' }, { allow: 'POST' })
      return
    }
    const body = typeof readJsonBody === 'function'
      ? await readJsonBody(req)
      : (req.body && typeof req.body === 'object' ? req.body : {})
    const inspected = inspectWorkspacePath(body && body.path)
    if (inspected.ok === false) {
      sendJson(res, 400, { error: inspected.error, code: inspected.code })
      return
    }
    sendJson(res, 200, { exists: inspected.exists, isDirectory: inspected.isDirectory })
  }]
}
