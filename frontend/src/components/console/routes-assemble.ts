export const ASSEMBLE_COPY = '组装提案，不是已派活';
export const LIVE_DISPATCH_OFF_COPY = '未接入本跳会话换模';
export const ASSEMBLE_EMPTY_COPY = '还没有组装提案';
export const OUTCOME_CONFIRM_COPY = '确认回填人工胜负，不换当前会话模型';

export interface AssembleRole {
  role: string;
  model: string;
}

export interface AssemblePlan {
  id?: string;
  label?: string;
  source?: string;
  pick?: string;
  dispatched: false;
  note: string;
  live: string;
  roles: AssembleRole[];
  notes?: string[];
  distinct?: boolean;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export function parseAssemblePlan(value: unknown): AssemblePlan | null {
  if (!isRecord(value)) return null;
  const root = isRecord(value.assemble) ? value.assemble : value;
  if (!Array.isArray(root.roles)) return null;
  const roles = root.roles.flatMap((row) => {
    if (!isRecord(row) || typeof row.role !== 'string' || typeof row.model !== 'string') return [];
    return [{ role: row.role, model: row.model }];
  });
  if (roles.length === 0) return null;
  return {
    id: typeof root.id === 'string' ? root.id : undefined,
    label: typeof root.label === 'string' ? root.label : undefined,
    source: typeof root.source === 'string' ? root.source : undefined,
    pick: typeof root.pick === 'string' ? root.pick : undefined,
    dispatched: false,
    note: typeof root.note === 'string' ? root.note : ASSEMBLE_COPY,
    live: typeof root.live === 'string' ? root.live : LIVE_DISPATCH_OFF_COPY,
    roles,
    notes: Array.isArray(root.notes) ? root.notes.filter((item): item is string => typeof item === 'string') : undefined,
    distinct: root.distinct === true,
  };
}

export async function postRouteOutcome(
  input: { ref: string; result: 'ok' | 'fail'; confirm: boolean },
  signal?: AbortSignal,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (input.confirm !== true) {
    return { ok: false, error: '回填胜负需要确认' };
  }
  const ref = input.ref.trim();
  if (ref === '') {
    return { ok: false, error: '决策编号未采集' };
  }
  const response = await fetch('/api/agos/routes/outcome', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ref, result: input.result, source: 'operator' }),
    signal,
  });
  const payload = await response.json() as { error?: unknown };
  if (!response.ok) {
    return {
      ok: false,
      error: typeof payload.error === 'string' ? payload.error : `HTTP ${response.status}`,
    };
  }
  return { ok: true };
}
