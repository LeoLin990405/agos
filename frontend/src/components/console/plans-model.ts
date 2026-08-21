export type PlanStatus = 'executed' | 'approved' | 'edited' | 'pending';

export interface PlanStep {
  id?: number | string;
  title?: string;
  detail?: string;
  type?: string;
  dependsOn?: number[];
}

export interface PlanRecord {
  file: string;
  name: string;
  goal: string;
  planner?: string;
  steps: PlanStep[];
  source?: string;
  approvedAt?: string;
  editedAt?: string;
  executedAt?: string;
  executor?: string;
  reviewer?: string;
  review?: unknown;
}

export interface PlansPayload {
  plans: PlanRecord[];
  error?: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Reject malformed success payloads instead of silently presenting them as empty. */
export function parsePlansPayload(value: unknown): PlansPayload {
  if (!isRecord(value) || !Array.isArray(value.plans)) {
    throw new Error('计划响应缺少 plans 数组');
  }
  for (const plan of value.plans) {
    if (!isRecord(plan)
      || typeof plan.file !== 'string'
      || typeof plan.name !== 'string'
      || typeof plan.goal !== 'string'
      || !Array.isArray(plan.steps)) {
      throw new Error('计划响应包含无效的计划条目');
    }
  }
  if (value.error !== undefined && typeof value.error !== 'string') {
    throw new Error('计划响应的 error 字段无效');
  }
  return value as unknown as PlansPayload;
}

/**
 * Plan state is evidence-derived. Keep this deliberately independent from
 * step counts: the route does not expose per-step execution state.
 */
export function derivePlanStatus(plan: Pick<PlanRecord, 'executedAt' | 'approvedAt' | 'editedAt'>): PlanStatus {
  if (plan.executedAt) return 'executed';
  if (plan.approvedAt) return 'approved';
  if (plan.editedAt) return 'edited';
  return 'pending';
}

/** Missing provenance stays missing; never infer it from planner. */
export function formatPlanSource(source: string | undefined): string | undefined {
  if (source === undefined || source === '') return undefined;
  return source === 'plan-mode' ? '计划模式' : source;
}

/** The server already applies this rule; the client repeats it defensively. */
export function recentPlans(plans: readonly PlanRecord[], limit: number = 20): PlanRecord[] {
  return [...plans]
    .sort((left, right) => right.name.localeCompare(left.name))
    .slice(0, Math.max(0, limit));
}
