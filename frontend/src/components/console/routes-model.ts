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
