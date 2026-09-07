import type { SkillCatalogEntry } from './skills-model';
import { SHORTLIST_K, shortlistSkills, type ShortlistHit } from './skills-ranking';

/** Port of FuguNano / agos-router allocation-score. Skills use the same Beta-Bernoulli. */
export const EVOLVE_KAPPA = 4;
export const EVOLVE_UNLISTED_PRIOR = 0.15;
export const POSTERIOR_METHOD_COPY = '经验后验，不是模型推荐';
export const CALL_IS_NOT_VERDICT_COPY = 'skill() 调用不是胜负';
export const CATALOG_TRIM_OFF_COPY = '本跳目录裁剪未启用：宿主仍注入全量 catalog';
export const CATALOG_TRIM_ON_COPY = '本跳目录按短名单替换，失败回退全量';
export const RERANK_FAIL_CLOSED_COPY = '小模型提案失败，已回退词面+后验';
export const RERANK_OPT_IN_COPY = '小模型只提案短名单，不写路由账本';

export type EvolveResult = 'ok' | 'fail';

export interface SkillOutcome {
  label: string;
  skill: string;
  result: EvolveResult;
}

export interface SkillEvidence {
  s: number;
  f: number;
}

export interface EvolvedHit {
  name: string;
  lexical: number;
  posterior: number;
  benchRank: number;
  evidence: SkillEvidence;
  method: 'lexical+posterior';
}

export interface EvolveRerankStatus {
  available: boolean;
  ran?: boolean;
  pick?: string;
  copy: string;
}

export interface ProposeReport {
  query: string;
  label: string;
  method: 'lexical+posterior';
  note: typeof POSTERIOR_METHOD_COPY;
  hits: EvolvedHit[];
  evidenceRows: number;
  matchingLabel: number;
  catalogTrim: { enabled: boolean; copy: string };
  rerank?: EvolveRerankStatus;
}

export function normalizeEvolveLabel(value: string): string {
  const folded = value
    .toLocaleLowerCase()
    .trim()
    .replace(/[^a-z0-9\u3400-\u9fff]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return folded === '' ? 'unlabeled' : folded;
}

export function betaPrior(index: number, listSize: number): number {
  return (listSize - index) / (listSize + 1);
}

export function applySkillOutcome(state: readonly SkillOutcome[], outcome: SkillOutcome): SkillOutcome[] {
  return [...state, outcome];
}

export function evidenceFor(state: readonly SkillOutcome[], label: string, skill: string): SkillEvidence {
  let s = 0;
  let f = 0;
  for (const row of state) {
    if (row.label !== label || row.skill !== skill) continue;
    if (row.result === 'ok') s += 1;
    if (row.result === 'fail') f += 1;
  }
  return { s, f };
}

export function posteriorMean(prior: number, evidence: SkillEvidence, kappa = EVOLVE_KAPPA): number {
  const a0 = kappa * prior + 1;
  const b0 = kappa * (1 - prior) + 1;
  const A = a0 + evidence.s;
  const B = b0 + evidence.f;
  return A / (A + B);
}

export function blendShortlist(
  lexical: readonly ShortlistHit[],
  state: readonly SkillOutcome[],
  label: string,
  options: { kappa?: number; unlistedPrior?: number } = {},
): EvolvedHit[] {
  const kappa = options.kappa ?? EVOLVE_KAPPA;
  const unlistedPrior = options.unlistedPrior ?? EVOLVE_UNLISTED_PRIOR;
  const listSize = lexical.length;
  const matchingLabel = state.filter((row) => row.label === label).length;
  return lexical
    .map((hit, index) => {
      const prior = listSize > 0 ? betaPrior(index, listSize) : unlistedPrior;
      const evidence = evidenceFor(state, label, hit.name);
      return {
        name: hit.name,
        lexical: hit.score,
        posterior: posteriorMean(prior, evidence, kappa),
        benchRank: index + 1,
        evidence,
        method: 'lexical+posterior' as const,
      };
    })
    .sort((left, right) => {
      if (matchingLabel > 0) {
        const posteriorOrder = right.posterior - left.posterior;
        if (posteriorOrder !== 0) return posteriorOrder;
      }
      const lexicalOrder = right.lexical - left.lexical;
      if (lexicalOrder !== 0) return lexicalOrder;
      return left.name.localeCompare(right.name);
    });
}

export function proposeSkillEvolve(
  catalog: readonly SkillCatalogEntry[],
  query: string,
  state: readonly SkillOutcome[],
  rawLabel = '',
  limit = SHORTLIST_K,
): ProposeReport {
  const needle = query.replace(/\s+/g, ' ').trim();
  const label = normalizeEvolveLabel(rawLabel || needle);
  const lexical = shortlistSkills(catalog, needle, limit);
  const hits = blendShortlist(lexical, state, label);
  const matchingLabel = state.filter((row) => row.label === label).length;
  return {
    query: needle,
    label,
    method: 'lexical+posterior',
    note: POSTERIOR_METHOD_COPY,
    hits,
    evidenceRows: state.length,
    matchingLabel,
    catalogTrim: { enabled: false, copy: CATALOG_TRIM_OFF_COPY },
  };
}

export function selectTrimNames(hits: readonly EvolvedHit[], maxEntries = SHORTLIST_K): string[] {
  return hits.slice(0, maxEntries).map((hit) => hit.name);
}

export function trimCatalogEntries<T extends { name: string }>(
  entries: readonly T[],
  names: readonly string[],
): { ok: true; entries: T[] } | { ok: false; reason: 'empty-shortlist' | 'no-overlap' } {
  if (names.length === 0) return { ok: false, reason: 'empty-shortlist' };
  const wanted = new Set(names);
  const next = entries.filter((entry) => wanted.has(entry.name));
  if (next.length === 0) return { ok: false, reason: 'no-overlap' };
  return { ok: true, entries: next };
}

export function parseEvolveReport(value: unknown): ProposeReport {
  if (!value || typeof value !== 'object') {
    throw new Error('技能自进化响应不是对象');
  }
  const record = value as Record<string, unknown>;
  const hits = Array.isArray(record.hits)
    ? record.hits.flatMap((row) => {
      if (!row || typeof row !== 'object') return [];
      const item = row as Record<string, unknown>;
      if (typeof item.name !== 'string' || item.name === '') return [];
      return [{
        name: item.name,
        lexical: Number(item.lexical) || 0,
        posterior: Number(item.posterior) || 0,
        benchRank: Number(item.benchRank) || 0,
        evidence: {
          s: Number((item.evidence as { s?: unknown } | undefined)?.s) || 0,
          f: Number((item.evidence as { f?: unknown } | undefined)?.f) || 0,
        },
        method: 'lexical+posterior' as const,
      }];
    })
    : [];
  const catalogTrim = record.catalogTrim && typeof record.catalogTrim === 'object'
    ? record.catalogTrim as { enabled?: unknown; copy?: unknown }
    : {};
  return {
    query: typeof record.query === 'string' ? record.query : '',
    label: typeof record.label === 'string' ? record.label : 'unlabeled',
    method: 'lexical+posterior',
    note: POSTERIOR_METHOD_COPY,
    hits,
    evidenceRows: Number(record.evidenceRows) || 0,
    matchingLabel: Number(record.matchingLabel) || 0,
    catalogTrim: {
      enabled: catalogTrim.enabled === true,
      copy: typeof catalogTrim.copy === 'string' ? catalogTrim.copy : CATALOG_TRIM_OFF_COPY,
    },
    rerank: record.rerank && typeof record.rerank === 'object'
      ? {
          available: (record.rerank as { available?: unknown }).available === true,
          ran: (record.rerank as { ran?: unknown }).ran === true,
          pick: typeof (record.rerank as { pick?: unknown }).pick === 'string'
            ? (record.rerank as { pick: string }).pick
            : undefined,
          copy: typeof (record.rerank as { copy?: unknown }).copy === 'string'
            ? (record.rerank as { copy: string }).copy
            : RERANK_OPT_IN_COPY,
        }
      : undefined,
  };
}

export function lastUserQuery(messages: readonly unknown[]): string {
  if (!Array.isArray(messages)) return '';
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || typeof message !== 'object') continue;
    const record = message as {
      role?: unknown;
      source?: { kind?: unknown };
      content?: unknown;
    };
    const kind = record.source?.kind;
    if (kind === 'skill-catalog' || kind === 'skill-invocation' || kind === 'session-memory') continue;
    if (record.role !== undefined && record.role !== 'user') continue;
    const text = flattenMessageText(record.content).replace(/\s+/g, ' ').trim();
    if (text !== '') return text;
  }
  return '';
}

function flattenMessageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      if (typeof part === 'string') return part;
      if (part && typeof part === 'object' && 'text' in part && typeof part.text === 'string') return part.text;
      return '';
    })
    .join(' ');
}
