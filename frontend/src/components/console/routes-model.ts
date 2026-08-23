export const ROUTES_READY_COPY = '路由档位'

export interface RouteRule {
  outcome?: 'TRUST' | 'TRUST_SPOT_CHECK' | 'ESCALATE' | string
  reason?: string
  pick?: string
  confidence?: number
  agreementShare?: number
}

export interface RouteDecision {
  id?: string
  ts?: number
  taskType?: string
  role?: string
  candidates?: string[]
  pick?: string
  confidence?: number
  reason?: string
  label?: string
  source?: 'selector' | 'fallback' | string
  fallbackReason?: string
  outcome?: string | null
  rule?: RouteRule
  /** W17:影子决策行(只记不驱动);pick 是机器名不是模型。 */
  mode?: 'shadow' | string
  shadow?: { chosen?: string[]; agreed?: boolean | null; items?: number }
  /** W17:派发真的发生后挂上的批次、实际落的机器、建议是否被采用(null = 判不了)。 */
  batchRef?: string
  actualHosts?: string[]
  adopted?: boolean | null
  annotations?: string[]
}

export interface RoutesPayload {
  at?: number
  decisions: RouteDecision[]
  assemble?: unknown
  dispatch?: unknown
  stats: {
    total: number
    filled: number
    pending: number
    cells: number
    window?: number
    limit?: number
    /** 后验分母:真实观测条数(outcome∈{ok,fail} 的决策)与 (角色,模型) 格数。老载荷没有。 */
    posterior?: { observations: number; cells: number }
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export function parseRoutesPayload(value: unknown): RoutesPayload {
  if (!isRecord(value) || !Array.isArray(value.decisions) || !isRecord(value.stats)) {
    throw new Error('路由决策响应缺少 decisions 或 stats')
  }
  const stats = value.stats
  if (![stats.total, stats.filled, stats.pending, stats.cells].every((n) => Number.isFinite(n))) {
    throw new Error('路由决策响应的 stats 字段不完整')
  }
  return value as unknown as RoutesPayload
}

export function outcomeLabel(outcome: string | null | undefined): 'pending' | 'filled' {
  return outcome === null || outcome === undefined ? 'pending' : 'filled'
}

export function outcomeValueCopy(outcome: string | null | undefined): string {
  if (outcome === null || outcome === undefined) return '待回填'
  if (outcome === 'ok') return '成功'
  if (outcome === 'fail') return '失败'
  return '已回填'
}

export function formatCoverage(stats: RoutesPayload['stats']): string {
  const window = stats.window ?? stats.total
  return `显示最近 ${window} 条，台账共 ${stats.total} 条 · 已回填结果 ${stats.filled} 条 · 覆盖 ${stats.cells} 个 (角色, 模型) 格`
}

/**
 * selector.js:88-96 的 reasonRank 列了全部 8 个 reason 值。原来只译了 split /
 * no-signal，其余 6 个走兜底 `return reason`，把 `gate-verified`、`quorum` 这类
 * 机器 token 直接当中文文案上屏，夹在「候选 未采集」中间(2026-08-22 验收 P2)。
 * 现在全译；认不出的 reason 一律不渲染，宁可少一句也不吐生词。
 */
const RULE_REASON_COPY: Record<string, string> = {
  'gate-verified': '闸门已验',
  'gate-failed': '闸门未过',
  'forced-category': '类别强制',
  empty: '无候选',
  singleton: '仅一个候选',
  quorum: '多数一致',
  split: '聚类分裂',
  'no-signal': '没有可聚的判断',
}

export function ruleReasonCopy(reason: string | undefined): string | undefined {
  if (!reason) return undefined
  return RULE_REASON_COPY[reason]
}

/** 「聚了」才谈得上一致或分裂；其余 5 个 reason 是聚类之前就短路了。 */
const CLUSTERED_REASONS = ['quorum', 'split', 'no-signal'] as const

/**
 * 页头这句必须由**同屏这批 decisions** 算出来。
 * ⚠️ 原来是一句无条件的绝对断言:「真实路径没有可聚的判断(no-signal)，不是一场分歧。」
 * 实测台账 7 条里 no-signal 出现 0 次，而 split 有 1 条 —— 页头点名的值一行都没有，
 * 页头否认的那件事下面第 3 行就写着「聚类分裂」。上面下断言、下面列反例，
 * 与 W1 清的「本条记录早于该字段」是同一个失败模式(2026-08-22 验收 P1)。
 */
export function routesTierNote(decisions: RouteDecision[]): string {
  const counts = new Map<string, number>()
  for (const d of decisions) {
    const reason = d.rule?.reason
    if (reason && (CLUSTERED_REASONS as readonly string[]).includes(reason)) {
      counts.set(reason, (counts.get(reason) ?? 0) + 1)
    }
  }
  if (counts.size === 0) {
    return '三档阶梯未接回界面：这批决策里没有一条走到聚类。'
  }
  const parts = CLUSTERED_REASONS
    .filter((r) => counts.has(r))
    .map((r) => `${ruleReasonCopy(r)} ${counts.get(r)} 条`)
  return `三档阶梯未接回界面：这批决策里走到聚类的有 ${parts.join(' · ')}，历史行按原样保留、不改写。`
}

/**
 * 决策行 fallbackReason(选择器为什么回落静态表)→ 中文。与 ruleReasonCopy 同口径:认不出不渲染。
 * 原来 RoutesView 把原码直接上屏(「回落 BAD_OUTPUT」),2026-08-23 插件拆码后会出现 PROVIDER_ERROR 等新码。
 */
const FALLBACK_REASON_COPY: Record<string, string> = {
  NOT_CONFIGURED: '选择器未配置',
  UNKNOWN: '选择器失败，原因未记录',
  NO_ADAPTER: '宿主缺少 llm 适配器',
  TIMEOUT: '选择器超时',
  ABORTED: '选择器已中止',
  STREAM_ERROR: '选择器流式调用出错',
  OVERLOAD: '选择器过载',
  BAD_OUTPUT: '选择器输出不可用（旧码，原因未拆分）',
  NO_TEXT: '选择器没有产出文本块',
  TOOL_CALL: '选择器试图调用工具',
  UNPARSEABLE: '选择器输出不是约定的 JSON',
  PROVIDER_ERROR: '选择器供应商报错',
}

export function fallbackReasonCopy(reason: string | undefined): string | undefined {
  if (!reason) return undefined
  return FALLBACK_REASON_COPY[reason]
}

/**
 * 「后验再填三角色」这句原来是常量;后验今天到底有几条真实观测,得由载荷说(审查 P2-5:当时只有 1 条,
 * 且指向本来就排第一的模型,输出与静态基准表不可区分)。分母缺席就说未采集。
 */
export function posteriorCopy(stats: RoutesPayload['stats']): string {
  const p = stats.posterior
  if (!p || !Number.isFinite(p.observations) || !Number.isFinite(p.cells)) return '后验分母未采集'
  if (p.observations === 0) return '后验暂无真实观测，三角色来自静态基准表'
  return `后验真实观测 ${p.observations} 条，落在 ${p.cells} 个已有胜负的（角色，模型）格（与上面「覆盖 N 个格」不是一个口径：那个数所有决策都算，这个只算有胜负的）`
}

/**
 * 决策行 reason:回落行是后端字面量(新「static table」;退役「selector unavailable or timed out; static table」——
 * 那句把每种失败都说成超时,历史行仍带着),译成中文;选择器行是模型原话,带「选择器原话 ·」前缀上屏。
 */
const FALLBACK_REASON_LITERALS: Record<string, string> = {
  'static table': '静态表',
  'selector unavailable or timed out; static table': '静态表（旧文案，当时把所有失败写成超时；真因看「回落」）',
}
export function decisionReasonCopy(row: { reason?: string; source?: string }): string | undefined {
  if (!row.reason) return undefined
  const literal = FALLBACK_REASON_LITERALS[row.reason]
  if (literal !== undefined) return literal
  if (row.source === 'fallback') return '静态表（回落理由未识别）'
  return `选择器原话 · ${row.reason}`
}

/** W17:影子行在路由页的一句话补充——全由行里的字段算出。 */
export function shadowRowCopy(row: RouteDecision): string | undefined {
  if (row.mode !== 'shadow') return undefined
  const parts: string[] = []
  const chosen = row.shadow?.chosen ?? []
  parts.push(chosen.length > 0 ? `用户勾选 ${chosen.join(' / ')}` : '用户未勾选机器（交给调度器）')
  if (row.shadow?.agreed === true) parts.push('建议与勾选一致')
  else if (row.shadow?.agreed === false) parts.push('建议与勾选不一致')
  if (row.batchRef !== undefined) {
    parts.push(`批次 ${row.batchRef.slice(0, 10)}…`)
    if (Array.isArray(row.actualHosts) && row.actualHosts.length > 0) parts.push(`实际落在 ${row.actualHosts.join(' / ')}`)
    if (row.adopted === true) parts.push('建议被采用，批次终态会回填到本行')
    else if (row.adopted === false) parts.push('建议未被采用，批次成败不回填到本行（那是勾选机器的结果）')
    else parts.push('是否采用判不了（无建议或未记实际机器）')
  } else {
    parts.push('尚未派发或未关联批次')
  }
  return parts.join(' · ')
}
