import type { SkillCatalogEntry } from './skills-model';
import type { TriggerEvalCase } from './skills-studio-model';
import { DESCRIPTION_MAX, validateDescription } from './skills-studio-model';

export const LEXICAL_METHOD = 'lexical-overlap' as const;
export const LEXICAL_THRESHOLD = 0.18;
export const SHORTLIST_K = 8; // 与 allocate-kernel ALLOCATE_SHORTLIST_K 同值
export const RERANK_UNAVAILABLE_COPY = '小模型重排未采集：宿主没有推荐接口';
export const SHORTLIST_METHOD_COPY = '词面短名单，不是模型推荐';
export const LEXICAL_EVAL_COPY = '词面重合，不是模型触发率';

export interface ShortlistHit {
  name: string;
  score: number;
  method: typeof LEXICAL_METHOD;
}

export interface LexicalEvalRow {
  query: string;
  shouldTrigger: boolean;
  score: number;
  predicted: boolean;
  pass: boolean;
}

export interface LexicalEvalReport {
  method: typeof LEXICAL_METHOD;
  threshold: number;
  note: typeof LEXICAL_EVAL_COPY;
  rows: LexicalEvalRow[];
  should: { total: number; passed: number };
  shouldNot: { total: number; passed: number };
}

export function tokenize(text: string): string[] {
  const lower = text.toLocaleLowerCase();
  const tokens = new Set<string>();
  for (const word of lower.match(/[a-z0-9]+/g) ?? []) {
    if (word.length >= 2) tokens.add(word);
  }
  for (const run of lower.match(/[\u3400-\u9fff]{2,}/g) ?? []) {
    tokens.add(run);
    for (let index = 0; index < run.length - 1; index += 1) {
      tokens.add(run.slice(index, index + 2));
    }
  }
  return [...tokens];
}

export function lexicalOverlap(query: string, document: string): number {
  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) return 0;
  const hay = document.toLocaleLowerCase();
  let hit = 0;
  for (const token of queryTokens) {
    if (hay.includes(token)) hit += 1;
  }
  return hit / queryTokens.length;
}

export function skillDocument(entry: Pick<SkillCatalogEntry, 'name' | 'description' | 'whenToUse' | 'category'>): string {
  return [entry.name, entry.description, entry.whenToUse, entry.category].filter(Boolean).join('\n');
}

export function shortlistSkills(
  catalog: readonly SkillCatalogEntry[],
  query: string,
  limit = SHORTLIST_K,
): ShortlistHit[] {
  const needle = query.replace(/\s+/g, ' ').trim();
  if (needle === '') return [];
  return catalog
    .map((entry) => ({
      name: entry.name,
      score: lexicalOverlap(needle, skillDocument(entry)),
      method: LEXICAL_METHOD,
    }))
    .filter((row) => row.score > 0)
    .sort((left, right) => right.score - left.score || left.name.localeCompare(right.name))
    .slice(0, limit);
}

export function runLexicalTriggerEvals(
  description: string,
  cases: readonly TriggerEvalCase[],
): LexicalEvalReport {
  const rows: LexicalEvalRow[] = [];
  for (const item of cases) {
    const query = item.query.replace(/\s+/g, ' ').trim();
    if (query === '') continue;
    const score = lexicalOverlap(query, description);
    const predicted = score >= LEXICAL_THRESHOLD;
    rows.push({
      query,
      shouldTrigger: item.shouldTrigger,
      score,
      predicted,
      pass: predicted === item.shouldTrigger,
    });
  }
  const shouldRows = rows.filter((row) => row.shouldTrigger);
  const shouldNotRows = rows.filter((row) => !row.shouldTrigger);
  return {
    method: LEXICAL_METHOD,
    threshold: LEXICAL_THRESHOLD,
    note: LEXICAL_EVAL_COPY,
    rows,
    should: { total: shouldRows.length, passed: shouldRows.filter((row) => row.pass).length },
    shouldNot: { total: shouldNotRows.length, passed: shouldNotRows.filter((row) => row.pass).length },
  };
}

export function suggestDescription(
  description: string,
  cases: readonly TriggerEvalCase[],
): { next: string; reasons: string[]; changed: boolean } {
  const current = description.replace(/\s+/g, ' ').trim();
  const missing = cases
    .filter((row) => row.shouldTrigger)
    .map((row) => row.query.replace(/\s+/g, ' ').trim())
    .filter((query) => query !== '' && lexicalOverlap(query, current) < LEXICAL_THRESHOLD);
  const unique = [...new Set(missing)];
  if (unique.length === 0) {
    return { next: current, reasons: ['该触发问句已能词面命中 description。'], changed: false };
  }
  const next = `${current} 也在用户说「${unique.join(' / ')}」时使用本技能。`.replace(/\s+/g, ' ').trim();
  if (next.length > DESCRIPTION_MAX) {
    return { next: current, reasons: [`建议会超过 librarian 上限 ${DESCRIPTION_MAX}，未改写。`], changed: false };
  }
  const invalid = validateDescription(next);
  if (invalid) {
    return { next: current, reasons: [invalid], changed: false };
  }
  return {
    next,
    reasons: unique.map((query) => `补进该触发问句：${query}`),
    changed: true,
  };
}

export function rerankStatus(): { available: false; copy: typeof RERANK_UNAVAILABLE_COPY } {
  return { available: false, copy: RERANK_UNAVAILABLE_COPY };
}
