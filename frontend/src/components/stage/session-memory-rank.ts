export const MEMORY_LEXICAL_COPY = '词面短名单，不是模型推荐';
export const MEMORY_POSTERIOR_COPY = '经验后验，不是模型推荐';
export const INJECT_IS_NOT_VERDICT_COPY = '回注曝光不是胜负';
export const RELEVANCE_UNCOLLECTED_COPY = '相关账本未采集';
export const RELEVANCE_CONFIRM_COPY = '确认记录本跳有用或误召回';
export const RELEVANCE_QUERY_UNCOLLECTED_COPY = '问句未采集，不能记相关';
export const RELEVANCE_READ_FAILED_COPY = '相关账本读取失败，不是未采集';
export const STORE_UNREAD_COPY = '会话记忆读取失败，不是空 store';
export const MEMORY_ITEM_ID_RE = /^[a-f0-9]{24}$/;

export function tokenizeMemoryQuery(text: string): string[] {
  const lower = text.toLocaleLowerCase();
  const tokens = new Set<string>();
  for (const word of lower.match(/[a-z0-9]+/g) ?? []) {
    if (word.length >= 2) tokens.add(word);
  }
  for (const run of lower.match(/[\u3400-\u9fff]{2,}/g) ?? []) tokens.add(run);
  return [...tokens];
}

export function memoryLexicalScore(query: string, document: string): number {
  const tokens = tokenizeMemoryQuery(query);
  if (tokens.length === 0) return 0;
  const hay = document.toLocaleLowerCase();
  let hit = 0;
  for (const token of tokens) {
    if (hay.includes(token)) hit += 1;
  }
  return hit / tokens.length;
}

export interface MemoryRelevanceHit {
  id: string;
  kind?: string;
  text?: string;
  lexical: number;
  posterior: number | null;
  benchRank: number;
  evidence: { s: number; f: number };
  method: 'lexical+posterior' | 'importance-recency' | 'constraint-reserve';
}

export interface MemoryRelevance {
  sessionId: string;
  collected: boolean;
  copy: string;
  evidenceRows: number | null;
  queryCollected: boolean;
  method: string | null;
  note: string;
  hits: MemoryRelevanceHit[];
  callNote: string;
}

function hit(value: unknown): MemoryRelevanceHit | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const row = value as Record<string, unknown>;
  if (typeof row.id !== 'string' || row.id.trim() === '') return undefined;
  const evidence = row.evidence && typeof row.evidence === 'object'
    ? row.evidence as { s?: unknown; f?: unknown }
    : {};
  return {
    id: row.id,
    kind: typeof row.kind === 'string' ? row.kind : undefined,
    text: typeof row.text === 'string' ? row.text : undefined,
    lexical: typeof row.lexical === 'number' && Number.isFinite(row.lexical) ? row.lexical : 0,
    posterior: typeof row.posterior === 'number' && Number.isFinite(row.posterior) ? row.posterior : null,
    benchRank: Number.isSafeInteger(row.benchRank) ? Number(row.benchRank) : 0,
    evidence: {
      s: Number.isSafeInteger(evidence.s) ? Number(evidence.s) : 0,
      f: Number.isSafeInteger(evidence.f) ? Number(evidence.f) : 0,
    },
    method: row.method === 'importance-recency' || row.method === 'constraint-reserve'
      ? row.method
      : 'lexical+posterior',
  };
}

export function parseMemoryRelevance(value: unknown): MemoryRelevance {
  if (!value || typeof value !== 'object') {
    throw new Error('相关账本响应不是对象');
  }
  const row = value as Record<string, unknown>;
  return {
    sessionId: typeof row.sessionId === 'string' ? row.sessionId : '',
    collected: row.collected === true,
    copy: typeof row.copy === 'string' && row.copy.trim() !== '' ? row.copy : RELEVANCE_UNCOLLECTED_COPY,
    evidenceRows: Number.isSafeInteger(row.evidenceRows) ? Number(row.evidenceRows) : null,
    queryCollected: row.queryCollected === true,
    method: typeof row.method === 'string' ? row.method : null,
    note: typeof row.note === 'string' && row.note.trim() !== '' ? row.note : RELEVANCE_UNCOLLECTED_COPY,
    hits: Array.isArray(row.hits) ? row.hits.flatMap((item) => {
      const parsed = hit(item);
      return parsed === undefined ? [] : [parsed];
    }) : [],
    callNote: typeof row.callNote === 'string' ? row.callNote : INJECT_IS_NOT_VERDICT_COPY,
  };
}

export function relevanceLedgerCopy(report: MemoryRelevance): string {
  if (!report.collected) {
    return report.copy.trim() !== '' ? report.copy : RELEVANCE_UNCOLLECTED_COPY;
  }
  if (report.evidenceRows === 0) return '相关账本 0 行';
  if (report.evidenceRows === null) return RELEVANCE_UNCOLLECTED_COPY;
  return report.copy;
}

export function hitByItemId(
  hits: readonly MemoryRelevanceHit[],
  itemId: string,
): MemoryRelevanceHit | undefined {
  return hits.find((row) => row.id === itemId);
}

export function canRecordRelevance(hit: { id: string } | undefined): boolean {
  return hit !== undefined && MEMORY_ITEM_ID_RE.test(hit.id);
}
