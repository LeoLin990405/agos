/**
 * 读图 / 评审台账模型(/api/cn/council-records)。
 * 服务端 slice(-30) 全类型返回。kind 缺席 = 「类型未采集」,不猜测。
 * disagreements 缺席(老记录)不得回退到逐行 diff。
 */

export interface CouncilPanelist {
  provider: string;
  model: string | undefined;
  ok: boolean;
  ms: number | undefined;
  error: string | undefined;
  text: string | undefined;
}

export interface CouncilRecord {
  kind: string | undefined;
  time: string | undefined;
  question: string | undefined;
  arbiter: string | undefined;
  parsedOk: boolean | undefined;
  consensus: boolean | undefined;
  inconclusive: boolean | undefined;
  verdict: string | undefined;
  /** undefined = 本条早于该字段,不是空数组。 */
  disagreements: string[] | undefined;
  flagged: string[];
  imagePath: string | undefined;
  panelists: CouncilPanelist[];
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);
const bool = (v: unknown): boolean | undefined => (typeof v === 'boolean' ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

function parsePanelist(v: unknown): CouncilPanelist | undefined {
  if (!isRecord(v) || typeof v.provider !== 'string' || v.provider === '') return undefined;
  return {
    provider: v.provider,
    model: str(v.model),
    ok: v.ok === true,
    ms: num(v.ms),
    error: str(v.error),
    text: str(v.text),
  };
}

function parseRecord(v: unknown): CouncilRecord | undefined {
  if (!isRecord(v)) return undefined;
  const panelists = Array.isArray(v.panelists)
    ? v.panelists.map(parsePanelist).filter((p): p is CouncilPanelist => p !== undefined)
    : [];
  return {
    kind: str(v.kind),
    time: str(v.time),
    question: str(v.question),
    arbiter: str(v.arbiter),
    parsedOk: bool(v.parsedOk),
    consensus: bool(v.consensus),
    inconclusive: bool(v.inconclusive),
    verdict: str(v.verdict),
    disagreements: Array.isArray(v.disagreements)
      ? v.disagreements.filter((item): item is string => typeof item === 'string' && item !== '')
      : undefined,
    flagged: Array.isArray(v.flagged) ? v.flagged.filter((f): f is string => typeof f === 'string') : [],
    imagePath: str(v.imagePath),
    panelists,
  };
}

/** 路由响应 → 全类型记录。坏行丢弃。不再按 kind===vision 过滤。 */
export function parseVisionLedger(input: unknown): CouncilRecord[] {
  if (!isRecord(input) || !Array.isArray(input.records)) return [];
  return input.records
    .map(parseRecord)
    .filter((r): r is CouncilRecord => r !== undefined);
}

export function kindChip(kind: string | undefined): string {
  // kind 缺席 ≠ 「评审」。台账里实测有一条 kind 缺席却 hadImages:1 的记录 ——
  // 把缺席猜成「评审」与同条记录自身的字段直接矛盾(2026-08-22 验收 P1)。
  // 缺席就说缺席,这是「数据零编造」的字面要求。
  return kind === undefined ? '类型未采集' : kind;
}

export function collectedDisagreements(record: CouncilRecord): {
  status: 'absent' | 'empty' | 'present';
  items: string[];
} {
  if (record.disagreements === undefined) return { status: 'absent', items: [] };
  if (record.disagreements.length === 0) return { status: 'empty', items: [] };
  return { status: 'present', items: record.disagreements };
}

/** 老格式记录不得产生任何分歧标记。永远空数组。 */
export function lineDivergenceMarks(_record: CouncilRecord): readonly [] {
  return [];
}

export function panelOkCount(record: CouncilRecord): { ok: number; total: number } {
  return {
    ok: record.panelists.filter((p) => p.ok).length,
    total: record.panelists.length,
  };
}

export const INCONCLUSIVE_COPY = '本次评审有效答案不足,未产出仲裁'

export function inconclusiveBanner(record: CouncilRecord): string | undefined {
  if (record.inconclusive !== true) return undefined
  return INCONCLUSIVE_COPY
}
