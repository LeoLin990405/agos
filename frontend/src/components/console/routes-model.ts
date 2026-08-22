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
}

export interface RoutesPayload {
  at?: number
  decisions: RouteDecision[]
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

export function formatCoverage(stats: RoutesPayload['stats']): string {
  const window = stats.window ?? stats.total
  return `显示最近 ${window} 条，台账共 ${stats.total} 条 · 已回填结果 ${stats.filled} 条 · 覆盖 ${stats.cells} 个 (角色, 模型) 格`
}

export function ruleBadge(outcome: string | undefined): { text: string; state: 'done' | 'running' | 'failed' | 'queued' } {
  if (outcome === 'TRUST') return { text: 'TRUST', state: 'done' }
  if (outcome === 'TRUST_SPOT_CHECK') return { text: '抽检', state: 'running' }
  if (outcome === 'ESCALATE') return { text: '升级', state: 'failed' }
  return { text: '档位未采集', state: 'queued' }
}
