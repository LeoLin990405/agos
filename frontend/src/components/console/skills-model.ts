export interface SkillFinding {
  sev?: string;
  check?: string;
  skill?: string;
  msg?: string;
}

export interface SkillAuditRoot {
  root: string;
  skills?: number;
  counts?: {
    warn?: number;
    error?: number;
    info?: number;
  };
  findings?: SkillFinding[];
  error?: string;
  /** DSH skill-filesystem source id when known. */
  source?: string;
  /** True when this root is on the model-facing load chain. */
  servedToModel?: boolean;
  rank?: number | null;
  budget?: SkillBudget;
}

export interface SkillShadowEntry {
  name: string;
  winner: string;
  winnerSource?: string;
  shadowed: Array<{
    root: string;
    source?: string;
    servedToModel?: boolean;
    rank?: number | null;
  }>;
  drifted: boolean;
}

export interface SkillCatalogEntry {
  name: string;
  description: string;
  whenToUse?: string;
  modelInvocable: boolean;
  category: string;
  root?: string;
  source?: string;
  servedToModel?: boolean;
  shadowed?: boolean;
  drifted?: boolean;
  pathsGateCandidate?: boolean;
  descChars?: number;
  descTokensEstimate?: number;
}

export interface SkillUsageStat {
  count: number;
  lastAt: number;
}

export interface SkillBudget {
  indexChars?: number;
  indexTokensEstimate?: number;
  indexBudgetTarget?: number;
  overshootFactor?: number;
  bodyOverTokenBudget?: number;
  topExpensiveDescriptions?: Array<{
    name: string;
    descChars: number;
    descTokensEstimate?: number;
    suggestedCompressPct?: number;
  }>;
  librarian?: SkillBudget;
}

export interface SkillsPayload {
  roots: SkillAuditRoot[];
  librarian?: string;
  at?: number;
  error?: string;
  shadowing?: SkillShadowEntry[];
  consistency?: {
    duplicateNames?: number;
    drifted?: number;
    summary?: string;
  };
  catalog?: SkillCatalogEntry[];
  budget?: SkillBudget;
  usage?: Record<string, SkillUsageStat>;
  usageMeta?: {
    at?: number;
    files?: number;
    events?: number;
    cache?: string;
    note?: string;
  };
}

export type SkillsSort = 'name' | 'recent' | 'never';
export type SkillsTab = 'catalog' | 'audit';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Reject malformed success payloads instead of silently presenting them as empty. */
export function parseSkillsPayload(value: unknown): SkillsPayload {
  if (!isRecord(value) || !Array.isArray(value.roots)) {
    throw new Error('技能审计响应缺少 roots 数组');
  }
  for (const root of value.roots) {
    if (!isRecord(root) || typeof root.root !== 'string') {
      throw new Error('技能审计响应包含无效的 root');
    }
    if (root.error !== undefined && typeof root.error !== 'string') {
      throw new Error(`技能根 ${root.root} 的 error 字段无效`);
    }
    if (root.error === undefined && (!Number.isFinite(root.skills) || !isRecord(root.counts) || !Array.isArray(root.findings))) {
      throw new Error(`技能根 ${root.root} 的审计字段不完整`);
    }
  }
  if (value.error !== undefined && typeof value.error !== 'string') {
    throw new Error('技能审计响应的 error 字段无效');
  }
  return value as unknown as SkillsPayload;
}

export function filterSkillFindings(findings: readonly SkillFinding[], query: string): SkillFinding[] {
  const needle = query.trim().toLocaleLowerCase();
  if (needle === '') return [...findings];
  return findings.filter((finding) => [finding.skill, finding.check, finding.msg, finding.sev]
    .some((value) => String(value ?? '').toLocaleLowerCase().includes(needle)));
}

export function clipDescription(text: string, max = 120): string {
  const one = text.replace(/\s+/g, ' ').trim();
  if (one.length <= max) return one;
  return `${one.slice(0, Math.max(0, max - 1))}…`;
}

export function filterCatalog(
  catalog: readonly SkillCatalogEntry[],
  query: string,
): SkillCatalogEntry[] {
  const needle = query.trim().toLocaleLowerCase();
  if (needle === '') return [...catalog];
  return catalog.filter((row) =>
    [row.name, row.description, row.whenToUse, row.category]
      .some((value) => String(value ?? '').toLocaleLowerCase().includes(needle)));
}

export function sortCatalog(
  catalog: readonly SkillCatalogEntry[],
  sort: SkillsSort,
  usage: Record<string, SkillUsageStat> | undefined,
): SkillCatalogEntry[] {
  const rows = [...catalog];
  if (sort === 'name') {
    rows.sort((a, b) => a.name.localeCompare(b.name));
    return rows;
  }
  const u = usage ?? {};
  if (sort === 'never') {
    rows.sort((a, b) => {
      const au = u[a.name]?.count ?? 0;
      const bu = u[b.name]?.count ?? 0;
      if ((au === 0) !== (bu === 0)) return au === 0 ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    return rows;
  }
  // recent
  rows.sort((a, b) => {
    const au = u[a.name]?.lastAt ?? 0;
    const bu = u[b.name]?.lastAt ?? 0;
    if (au !== bu) return bu - au;
    const ac = u[a.name]?.count ?? 0;
    const bc = u[b.name]?.count ?? 0;
    if (ac !== bc) return bc - ac;
    return a.name.localeCompare(b.name);
  });
  return rows;
}

export function groupCatalogByCategory(catalog: readonly SkillCatalogEntry[]): Array<{ category: string; items: SkillCatalogEntry[] }> {
  const order = [
    'functional / tools / methodology',
    'meta-index',
    'books',
    'concept children',
    'wdkns / up',
    'wdkns / series',
    'wdkns / child',
  ];
  const groups = new Map<string, SkillCatalogEntry[]>();
  for (const row of catalog) {
    const cat = row.category || 'functional / tools / methodology';
    const list = groups.get(cat) ?? [];
    list.push(row);
    groups.set(cat, list);
  }
  const result: Array<{ category: string; items: SkillCatalogEntry[] }> = [];
  for (const cat of order) {
    const items = groups.get(cat);
    if (items && items.length > 0) result.push({ category: cat, items });
    groups.delete(cat);
  }
  for (const [category, items] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    result.push({ category, items });
  }
  return result;
}

export function neverUsedCount(
  catalog: readonly SkillCatalogEntry[],
  usage: Record<string, SkillUsageStat> | undefined,
): number {
  const u = usage ?? {};
  return catalog.filter((row) => (u[row.name]?.count ?? 0) === 0).length;
}

export function mergeRpcCatalog(
  base: readonly SkillCatalogEntry[],
  rpc: readonly { name: string; description: string; whenToUse?: string; modelInvocable: boolean }[],
): SkillCatalogEntry[] {
  if (rpc.length === 0) return [...base];
  const byName = new Map(rpc.map((row) => [row.name, row]));
  return base.map((row) => {
    const hit = byName.get(row.name);
    if (!hit) return row;
    return {
      ...row,
      description: hit.description || row.description,
      whenToUse: hit.whenToUse ?? row.whenToUse,
      modelInvocable: hit.modelInvocable,
    };
  });
}
