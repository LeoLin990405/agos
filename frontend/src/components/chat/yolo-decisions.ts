/**
 * W11 权限裁决台账(GET /api/agos/yolo-decisions?sessionId=)→ 对话流工具卡片的注解。
 * 只读;按 callId 挂到已有的工具/审批条目上,**不生成第三条 item**(fold 已把 approval/asked→ApprovalItem,
 * 工具卡本身也已 status:'failed';裁决信息是注解,不是新事件)。
 *
 * 今天的歧义:tool/result 文本写「the user rejected」,而 decision:'judge' 表示是 LLM 裁判拒的。
 * 事件流里没有裁判理由,只在台账里。
 *
 * 诚实规则(由台账真实行逼出来):
 * - `reason` 是裁判的理由;2026-08-20 修复前的真实 rejected 行既无 reason 也无 error → 「裁判未留理由」,不发明。
 * - `justification` 是申请方的理由,**绝不**当裁决理由用。
 * - 同一 callId 可多行(重试 / 探针),按 time 升序,主显示取最新。
 */
export interface YoloDecision {
  time: number
  callId: string
  toolName?: string
  origin?: string
  targetMode?: string
  currentMode?: string
  justification?: string
  decision: 'allow' | 'deny' | 'delegate' | 'judge' | string
  outcome: 'allowed-once' | 'rejected' | 'delegate' | string
  reason?: string
  error?: string
  errorMessage?: string
}

export interface YoloDecisionsPayload { version: number; sessionId: string; file?: string; count: number; items: YoloDecision[] }

export const EMPTY_YOLO: ReadonlyMap<string, YoloDecision[]> = new Map()

export function yoloDecisionsUrl(sessionId: string): string {
  if (sessionId.trim() === '') throw new TypeError('sessionId 不能为空')
  return `/api/agos/yolo-decisions?sessionId=${encodeURIComponent(sessionId)}`
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const optStr = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined)

export function parseYoloDecisionsPayload(value: unknown): YoloDecisionsPayload {
  if (!isRecord(value) || typeof value.sessionId !== 'string' || !Array.isArray(value.items)) throw new Error('裁决响应缺少 sessionId 或 items')
  const items: YoloDecision[] = []
  for (const row of value.items) {
    if (!isRecord(row) || typeof row.callId !== 'string' || typeof row.decision !== 'string' || typeof row.outcome !== 'string') continue
    items.push({
      time: typeof row.time === 'number' && Number.isFinite(row.time) ? row.time : 0,
      callId: row.callId,
      toolName: optStr(row.toolName),
      origin: optStr(row.origin),
      targetMode: optStr(row.targetMode),
      currentMode: optStr(row.currentMode),
      justification: optStr(row.justification),
      decision: row.decision,
      outcome: row.outcome,
      reason: optStr(row.reason),
      error: optStr(row.error),
      errorMessage: optStr(row.errorMessage),
    })
  }
  return { version: typeof value.version === 'number' ? value.version : 0, sessionId: value.sessionId, file: optStr(value.file), count: typeof value.count === 'number' ? value.count : items.length, items }
}

export function groupYoloByCallId(items: readonly YoloDecision[]): ReadonlyMap<string, YoloDecision[]> {
  const map = new Map<string, YoloDecision[]>()
  for (const it of [...items].sort((a, b) => a.time - b.time)) {
    const list = map.get(it.callId) ?? []
    list.push(it)
    map.set(it.callId, list)
  }
  return map
}

export interface YoloDescription {
  who: 'LLM 裁判' | '策略' | '人工' | '未识别'
  label: string
  reason: string | undefined
  /** 裁判判了但没留理由(修复前格式或出错回退)。 */
  unreasoned: boolean
  kind: 'judge' | 'deny' | 'delegate' | 'allow' | 'unknown'
}

/** 文案由 decision × outcome 算出;理由只认 reason;error 只报码不报原文。 */
export function describeYoloDecision(row: YoloDecision): YoloDescription {
  const reason = row.reason
  if (row.outcome === 'delegate' || row.decision === 'delegate') {
    return { who: '人工', label: '裁判转人工审批', reason, unreasoned: false, kind: 'delegate' }
  }
  if (row.decision === 'deny') {
    return { who: '策略', label: '策略直接拒绝', reason, unreasoned: reason === undefined && row.error === undefined, kind: 'deny' }
  }
  if (row.decision === 'judge' || row.decision === 'allow') {
    const kind = row.decision === 'allow' ? 'allow' : 'judge'
    if (row.outcome === 'rejected') {
      const errored = row.error !== undefined
      return { who: 'LLM 裁判', label: errored ? `裁判出错回退拒绝（${row.error}）` : 'LLM 裁判拒绝', reason, unreasoned: reason === undefined && !errored, kind }
    }
    if (row.outcome === 'allowed-once') {
      return { who: row.decision === 'allow' ? '策略' : 'LLM 裁判', label: row.decision === 'allow' ? '策略放行（一次）' : 'LLM 裁判放行（一次）', reason, unreasoned: false, kind }
    }
  }
  return { who: '未识别', label: '裁决结果未识别', reason, unreasoned: reason === undefined, kind: 'unknown' }
}

/** 审批行的一句话:谁、怎么判、理由或「裁判未留理由」。 */
export function yoloVerdictText(row: YoloDecision): string {
  const d = describeYoloDecision(row)
  if (d.reason !== undefined) return `${d.label}：${d.reason}`
  if (d.unreasoned) return `${d.label}（裁判未留理由）`
  return d.label
}
