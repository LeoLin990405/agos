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
}

export interface SkillsPayload {
  roots: SkillAuditRoot[];
  librarian?: string;
  at?: number;
  error?: string;
}

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
