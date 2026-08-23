/** W10 结果行载荷(GET /api/agos/routes/outcomes)。形状以插件 dsh-agos-router/lib/outcomes.js 为准。 */
export const OUTCOME_KINDS = ['route', 'council', 'plan', 'civ', 'fleet'] as const
export type OutcomeKind = typeof OUTCOME_KINDS[number]

export interface OutcomeRow {
  ts: number | null
  kind: OutcomeKind
  ref: string
  agent: string | null
  taskType: string | null
  result: 'ok' | 'fail' | null
  ms: number | null
}

export interface CoverageCell { kind: OutcomeKind; taskType: string; agent: string; ok: number; fail: number }

export interface CoverageGrid {
  total: number
  byKind: Partial<Record<OutcomeKind, number>>
  labeled: number
  unlabeled: number
  missing: { noTaskType: number; noAgent: number; noResult: number }
  cells: CoverageCell[]
  cellsWithCounterfactual: number
}

export interface OutcomesPayload { at?: number; rows: OutcomeRow[]; grid: CoverageGrid }

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : Number.NaN)

export function parseOutcomesPayload(value: unknown): OutcomesPayload {
  if (!isRecord(value) || !Array.isArray(value.rows) || !isRecord(value.grid)) throw new Error('结果行响应缺少 rows 或 grid')
  const g = value.grid
  const missing = isRecord(g.missing) ? g.missing : {}
  const grid: CoverageGrid = {
    total: num(g.total),
    byKind: isRecord(g.byKind) ? (g.byKind as CoverageGrid['byKind']) : {},
    labeled: num(g.labeled),
    unlabeled: num(g.unlabeled),
    missing: { noTaskType: num(missing.noTaskType), noAgent: num(missing.noAgent), noResult: num(missing.noResult) },
    cells: Array.isArray(g.cells) ? g.cells.filter((c): c is CoverageCell => isRecord(c) && typeof c.kind === 'string' && (OUTCOME_KINDS as readonly string[]).includes(c.kind) && typeof c.taskType === 'string' && typeof c.agent === 'string' && typeof c.ok === 'number' && typeof c.fail === 'number') : [],
    cellsWithCounterfactual: num(g.cellsWithCounterfactual),
  }
  if ([grid.total, grid.labeled, grid.unlabeled, grid.cellsWithCounterfactual].some((n) => Number.isNaN(n))) throw new Error('结果行覆盖表字段不完整')
  return { at: typeof value.at === 'number' ? value.at : undefined, rows: value.rows as OutcomeRow[], grid }
}

/**
 * 一句由覆盖表算出来的总结。
 * ⚠️ unlabeled 是「缺标签的行数」,**不是** TASK-013 的「离压过先验还差多少条观测」——那个要按后验需要量
 *(role 键约 161 / taskType 键约 504)减去质量裁决标签算,而且 plan 的 ok、civ 的传输层 ok 都不算质量标签。
 * 「可比较的任务类」= 同一 (kind, taskType) 下有 ≥2 个模型有观测的个数;为 0 时任何排行榜都是零反事实。
 */
export function coverageSummary(grid: CoverageGrid): string {
  const kinds = (Object.entries(grid.byKind) as [string, number][]).map(([k, n]) => `${k} ${n}`).join(' · ')
  const compare = grid.cellsWithCounterfactual === 0
    ? '没有任何（源，任务类）有两个以上模型的观测，今天的排行都是零反事实'
    : `${grid.cellsWithCounterfactual} 个（源，任务类）有两个以上模型的观测，只有这些能同源比较`
  return `共 ${grid.total} 行（${kinds}）· 带完整标签 ${grid.labeled} 条 · 缺标签 ${grid.unlabeled} 条（缺任务类 ${grid.missing.noTaskType}、缺模型 ${grid.missing.noAgent}、缺结果 ${grid.missing.noResult}；这不是 013 的「还差多少观测」）· ${compare}。`
}
