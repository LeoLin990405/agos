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
  /** LLM 裁判判了但没留理由(修复前格式)。只对 decision:'judge' 成立;策略直判本来就没有理由。 */
  unreasoned: boolean
  kind: 'judge' | 'deny' | 'delegate' | 'allow' | 'unknown'
}

const ERROR_CODE_RE = /^[A-Z_]{2,40}$/

/**
 * 文案由 decision × outcome 算出;理由只认 reason;error 只报码不报原文,**任何 outcome 下都报**。
 * 写端(yolo-mode-aligned/lib/index.js)的组合:
 *   decision 'delegate'(策略直转 / 闸门出错回退)→ outcome 'delegate':裁判**没跑**,是策略把决定交给人。
 *   decision 'deny' → 'rejected':静态策略,写端永远不带 reason。
 *   decision 'allow' → 'allowed-once':静态策略放行。
 *   decision 'judge' → 'rejected' | 'allowed-once' | 'delegate'(裁判失败回退也可能转人工):只有这条有 reason。
 */
export function describeYoloDecision(row: YoloDecision): YoloDescription {
  const reason = row.reason
  const err = typeof row.error === 'string' && ERROR_CODE_RE.test(row.error) ? row.error : undefined
  const errSuffix = err ? `（出错回退 ${err}）` : ''
  if (row.decision === 'delegate') {
    return { who: '策略', label: `策略转人工审批，裁判未跑${errSuffix}`, reason, unreasoned: false, kind: 'delegate' }
  }
  if (row.decision === 'deny') {
    return { who: '策略', label: `策略直接拒绝${errSuffix}`, reason, unreasoned: false, kind: 'deny' }
  }
  if (row.decision === 'allow') {
    return { who: '策略', label: `策略放行（一次）${errSuffix}`, reason, unreasoned: false, kind: 'allow' }
  }
  if (row.decision === 'judge') {
    if (row.outcome === 'delegate') return { who: '人工', label: `裁判转人工审批${errSuffix}`, reason, unreasoned: false, kind: 'judge' }
    if (row.outcome === 'rejected') return { who: 'LLM 裁判', label: `LLM 裁判拒绝${errSuffix}`, reason, unreasoned: reason === undefined && err === undefined, kind: 'judge' }
    if (row.outcome === 'allowed-once') return { who: 'LLM 裁判', label: `LLM 裁判放行（一次）${errSuffix}`, reason, unreasoned: false, kind: 'judge' }
  }
  return { who: '未识别', label: `裁决结果未识别${errSuffix}`, reason, unreasoned: false, kind: 'unknown' }
}

/** 裁决注解的一句话:谁、怎么判、理由或「裁判未留理由」。它是**注解**,审批行自己的人工结果要保留在它前面。 */
export function yoloVerdictText(row: YoloDecision): string {
  const d = describeYoloDecision(row)
  if (d.reason !== undefined) return `${d.label}：${d.reason}`
  if (d.unreasoned) return `${d.label}（裁判未留理由）`
  return d.label
}
