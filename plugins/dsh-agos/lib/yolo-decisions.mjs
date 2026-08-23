// W11(TASK-2026-08-22-017 第二档):权限裁决台账 → 对话流。**只读** yolo-mode-aligned 写的
// ~/.dsh/logs/yolo-judge.jsonl,不改它、不写它。
//
// 行格式(yolo-mode-aligned README:119):{time, sessionId, origin, toolName, callId?, targetMode, currentMode,
// justification, workspaceRoot?, resourcePath?, inWorkspace?, argumentsSummary?, decision, outcome, reason?, error?, errorMessage?}。
// 2026-08-23 W18 起新行多 workspaceRoot/resourcePath/inWorkspace(已脱敏);argumentsSummary 不透传(给裁判看的实参摘要,前端不需要)。存量 5 行没有这些字段。
// - decision 是策略层怎么走:allow / deny 静态直判,delegate 转人工,judge 进 LLM 裁判;outcome 是最终结果。
// - reason 是**裁判**的理由,只在裁判真判了才有;2026-08-20 修复前的两条真实 rejected 行既无 reason 也无 error。
//   justification 是**申请方**的理由,绝不能当裁决理由用。
// - 同一 callId 可能多行(重试 / 探针),sessionId 与 callId 在写端都可能缺席(index.js:314-321)。
// - 写端 fs.promises.appendFile 无锁,读端可能读到半行:逐行 try/parse,坏行丢弃不发明。
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'

export const YOLO_FIELDS = Object.freeze(['time', 'origin', 'toolName', 'callId', 'targetMode', 'currentMode', 'justification', 'workspaceRoot', 'resourcePath', 'inWorkspace', 'decision', 'outcome', 'reason', 'error', 'errorMessage'])
const DEFAULT_LIMIT = 200
const JUSTIFICATION_LIMIT = 300

export function defaultYoloAuditFile(env = process.env) {
  return env.DSH_YOLO_AUDIT_FILE || join(homedir(), '.dsh', 'logs', 'yolo-judge.jsonl')
}

export function readYoloRows(file) {
  if (!file || !existsSync(file)) return []
  const rows = []
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue
    try { rows.push(JSON.parse(line)) } catch { /* 半行/坏行丢弃 */ }
  }
  return rows
}

/** 只透传白名单字段;justification 截短;按 time 升序;只要有 callId 的行(没有 callId 就挂不到任何工具卡)。 */
export function selectYoloDecisions(rows, sessionId, limit = DEFAULT_LIMIT) {
  const items = []
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || typeof row !== 'object' || row.sessionId !== sessionId || typeof row.callId !== 'string' || !row.callId) continue
    const out = {}
    for (const key of YOLO_FIELDS) {
      const v = row[key]
      if (v === undefined || v === null) continue
      if (key === 'time') { if (typeof v === 'number' && Number.isFinite(v)) out.time = v; continue }
      if (typeof v !== 'string') continue
      out[key] = key === 'justification' ? v.slice(0, JUSTIFICATION_LIMIT) : v
    }
    if (typeof out.decision !== 'string' || typeof out.outcome !== 'string') continue
    items.push(out)
  }
  items.sort((a, b) => (a.time ?? 0) - (b.time ?? 0))
  const max = Number.isInteger(limit) && limit > 0 ? limit : DEFAULT_LIMIT
  return items.slice(-max)
}

export function createYoloDecisionsRoute({ file, validateSessionId, sendJson }) {
  return ['/api/agos/yolo-decisions', async (req, res) => {
    if (req.method !== 'GET') { sendJson(res, 405, { error: 'GET only' }, { allow: 'GET' }); return }
    const url = new URL(req.url, 'http://x')
    const sessionId = url.searchParams.get('sessionId')
    validateSessionId(sessionId)
    const limit = Number(url.searchParams.get('limit') || DEFAULT_LIMIT)
    const items = selectYoloDecisions(readYoloRows(file), sessionId, Number.isFinite(limit) ? limit : DEFAULT_LIMIT)
    // 不回绝对路径(3091 监听 *:3091);只说读的是哪个文件名、存不存在。
    sendJson(res, 200, { version: 1, sessionId, file: basename(file), fileExists: existsSync(file), count: items.length, items })
  }]
}
