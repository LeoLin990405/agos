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
    roots?: string[];
    cache?: string;
    note?: string;
    error?: string;
    errors?: Array<{ root?: string; error?: string }>;
  };
}

export const SKILLS_USAGE_READY_COPY = '使用率分母已采集';
export const SKILL_USAGE_UNCOLLECTED_COPY = '使用次数未采集';
export const SKILL_USAGE_NEVER_COPY = '从未调用';
export const USAGE_SCAN_FAILED_COPY = '使用率扫描失败，不是 0 次调用';
export const AUDIT_FINDINGS_UNCOLLECTED_COPY = '审计未返回检查明细。';
export const AUDIT_FINDINGS_CLEAR_COPY = '当前根没有发现问题。';
export const AUDIT_FINDINGS_NO_MATCH_COPY = '当前筛选没有匹配项。';
export const SKILLS_CATALOG_EMPTY_COPY = '技能目录为空。';
export const SKILLS_CATALOG_NO_MATCH_COPY = '没有匹配的技能。';

export type SkillUsageKind = 'uncollected' | 'never' | 'used';

/** Missing row in an unready sample is 未采集, not 0 / 从未调用. */
export function skillUsageKind(
  usage: SkillUsageStat | undefined,
  sampleReady: boolean,
): SkillUsageKind {
  if (usage !== undefined) return usage.count === 0 ? 'never' : 'used';
  return sampleReady ? 'never' : 'uncollected';
}

export function skillUsageHonesty(usage: SkillUsageStat | undefined, sampleReady = false): string {
  const kind = skillUsageKind(usage, sampleReady);
  if (kind === 'uncollected') return '使用次数未采集。';
  if (kind === 'never') return '当前样本下从未调用，不是删除判决。';
  return `当前样本调用 ${usage?.count ?? 0} 次。`;
}

/** 分母锚点只在扫描成功态出现。error 或缺 files/roots = 失败,不能绿。 */
export function usageDenominatorReady(meta: SkillsPayload['usageMeta'] | undefined): boolean {
  if (meta === undefined) return false;
  if (typeof meta.error === 'string' && meta.error !== '') return false;
  if (!Number.isFinite(meta.files)) return false;
  if (!Array.isArray(meta.roots)) return false;
  return true;
}

/** Failed / partial meta must not print 样本 0 会话 / 0 次调用. */
export function usageSampleCopy(meta: SkillsPayload['usageMeta'] | undefined): string | undefined {
  if (meta === undefined) return undefined;
  if (typeof meta.error === 'string' && meta.error !== '') return USAGE_SCAN_FAILED_COPY;
  const files = Number.isFinite(meta.files) ? String(meta.files) : '未采集';
  const events = Number.isFinite(meta.events) ? String(meta.events) : '未采集';
  return `样本 ${files} 会话 / ${events} 次调用`;
}

/** Never-used count is only a number after the usage sample actually loaded. */
export function collectedNeverUsedCount(
  catalog: readonly SkillCatalogEntry[],
  usage: Record<string, SkillUsageStat> | undefined,
  meta: SkillsPayload['usageMeta'] | undefined,
): number | undefined {
  if (!usageDenominatorReady(meta)) return undefined;
  return neverUsedCount(catalog, usage ?? {});
}

export function auditFindingsEmptyCopy(
  findings: readonly SkillFinding[] | undefined,
  query: string,
): string | undefined {
  if (findings === undefined) return AUDIT_FINDINGS_UNCOLLECTED_COPY;
  if (findings.length > 0) return undefined;
  return query.trim() === '' ? AUDIT_FINDINGS_CLEAR_COPY : AUDIT_FINDINGS_NO_MATCH_COPY;
}

export function skillsCatalogEmptyCopy(query: string): string {
  return query.trim() === '' ? SKILLS_CATALOG_EMPTY_COPY : SKILLS_CATALOG_NO_MATCH_COPY;
}

export function vanishedUsageSkills(
  catalog: readonly SkillCatalogEntry[],
  usage: Record<string, SkillUsageStat> | undefined,
): string[] {
  const names = new Set(catalog.map((row) => row.name));
  return Object.entries(usage ?? {})
    .filter(([name, stat]) => (stat.count ?? 0) > 0 && !names.has(name))
    .map(([name]) => name)
    .sort((a, b) => a.localeCompare(b));
}

export type SkillsSort = 'name' | 'recent' | 'never';
export type SkillsTab = 'catalog' | 'audit' | 'studio';

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
  if (value.error === undefined && !Array.isArray(value.catalog)) {
    throw new Error('技能审计响应缺少 catalog 数组');
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
