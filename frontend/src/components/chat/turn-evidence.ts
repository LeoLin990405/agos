import { MEMORY_ITEM_ID_RE } from '@/components/stage/session-memory-rank';

export const TURN_UNCOLLECTED_COPY = '本跳未采集';
export const MEMORY_UNCOLLECTED_COPY = '本跳回注未采集';
export const SKILLS_UNCOLLECTED_COPY = '本跳技能目录未采集';
export const PLUGINS_UNCOLLECTED_COPY = '当前进程未采集';

export type TurnEvidenceImpressionMethod =
  | 'lexical+posterior'
  | 'importance-recency'
  | 'constraint-reserve';

export interface TurnEvidenceImpression {
  id: string;
  kind: string;
  text: string;
  method?: TurnEvidenceImpressionMethod;
}

export const IMPRESSION_WHY_COPY: Record<TurnEvidenceImpressionMethod, string> = {
  'lexical+posterior': '词面',
  'importance-recency': '重要度候补，不是相关性',
  'constraint-reserve': '约束保送，不是更相关',
};

export interface TurnEvidenceLane {
  collected: boolean;
  copy: string;
  enabled?: boolean | null;
  prepended?: number | null;
  itemCount?: number | null;
  trimmed?: boolean | null;
  served?: string[] | null;
  impressions?: TurnEvidenceImpression[] | null;
  reserved?: boolean | null;
  query?: string | null;
  method?: string | null;
  profile?: 'web' | 'desktop' | null;
  agosLoaded?: string[] | null;
}

export interface TurnEvidence {
  sessionId: string;
  at: string | null;
  collected: boolean;
  copy: string;
  memory: TurnEvidenceLane;
  skills: TurnEvidenceLane;
  plugins: TurnEvidenceLane;
}

function lane(value: unknown, fallback: string): TurnEvidenceLane {
  if (!value || typeof value !== 'object') {
    return { collected: false, copy: fallback };
  }
  const row = value as Record<string, unknown>;
  return {
    collected: row.collected === true,
    copy: typeof row.copy === 'string' && row.copy.trim() !== '' ? row.copy : fallback,
    enabled: row.enabled === true || row.enabled === false ? row.enabled : null,
    prepended: Number.isSafeInteger(row.prepended) ? Number(row.prepended) : null,
    itemCount: Number.isSafeInteger(row.itemCount) ? Number(row.itemCount) : null,
    trimmed: row.trimmed === true || row.trimmed === false ? row.trimmed : null,
    served: Array.isArray(row.served)
      ? row.served.filter((name): name is string => typeof name === 'string' && name.trim() !== '')
      : null,
    impressions: Array.isArray(row.impressions)
      ? row.impressions.flatMap((item) => {
        if (!item || typeof item !== 'object') return [];
        const impression = item as { id?: unknown; kind?: unknown; text?: unknown; method?: unknown };
        const text = typeof impression.text === 'string' ? impression.text.trim() : '';
        if (text === '') return [];
        const method = impression.method === 'lexical+posterior'
          || impression.method === 'importance-recency'
          || impression.method === 'constraint-reserve'
          ? impression.method
          : undefined;
        return [{
          id: typeof impression.id === 'string' ? impression.id : '',
          kind: typeof impression.kind === 'string' ? impression.kind : '',
          text,
          ...(method === undefined ? {} : { method }),
        }];
      })
      : null,
    reserved: row.reserved === true || row.reserved === false ? row.reserved : null,
    query: typeof row.query === 'string' ? row.query : null,
    method: typeof row.method === 'string' ? row.method : null,
    profile: row.profile === 'web' || row.profile === 'desktop' ? row.profile : null,
    agosLoaded: Array.isArray(row.agosLoaded)
      ? row.agosLoaded.filter((name): name is string => typeof name === 'string')
      : null,
  };
}

export function parseTurnEvidence(value: unknown): TurnEvidence {
  if (!value || typeof value !== 'object') {
    throw new Error('本跳证据响应不是对象');
  }
  const row = value as Record<string, unknown>;
  return {
    sessionId: typeof row.sessionId === 'string' ? row.sessionId : '',
    at: typeof row.at === 'string' ? row.at : null,
    collected: row.collected === true,
    copy: typeof row.copy === 'string' && row.copy.trim() !== '' ? row.copy : TURN_UNCOLLECTED_COPY,
    memory: lane(row.memory, MEMORY_UNCOLLECTED_COPY),
    skills: lane(row.skills, SKILLS_UNCOLLECTED_COPY),
    plugins: lane(row.plugins, PLUGINS_UNCOLLECTED_COPY),
  };
}

export function turnEvidenceChips(evidence: TurnEvidence): string[] {
  return [evidence.memory.copy, evidence.skills.copy, evidence.plugins.copy];
}

export function turnEvidenceImpressionLabels(evidence: TurnEvidence): string[] {
  const impressions = evidence.memory.impressions;
  if (!evidence.memory.collected || impressions === undefined || impressions === null) return [];
  return impressions.flatMap((row) => {
    if (row.text === '') return [];
    const why = row.method === undefined ? '' : IMPRESSION_WHY_COPY[row.method];
    return [why === '' ? row.text : `${row.text}（${why}）`];
  });
}

export function turnEvidenceFeedbackTargets(evidence: TurnEvidence): TurnEvidenceImpression[] {
  if (!evidence.memory.collected) return [];
  const impressions = evidence.memory.impressions;
  if (impressions === undefined || impressions === null) return [];
  return impressions.filter((row) => MEMORY_ITEM_ID_RE.test(row.id));
}

export function turnEvidenceUnrecordableCopy(evidence: TurnEvidence): string | undefined {
  if (!evidence.memory.collected) return undefined;
  const impressions = evidence.memory.impressions;
  if (impressions === undefined || impressions === null || impressions.length === 0) return undefined;
  const missing = impressions.filter((row) => !MEMORY_ITEM_ID_RE.test(row.id)).length;
  if (missing === 0) return undefined;
  return missing === impressions.length
    ? '曝光条目没有 id，不能记相关'
    : `${missing} 条曝光没有 id，不能记相关`;
}
