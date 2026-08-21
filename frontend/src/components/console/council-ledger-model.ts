/**
 * 读图台账模型(/api/cn/council-records → 结构化记录,纯函数,可测)。
 *
 * 台账是服务端有意设计的结构化账本(cn-capabilities 落盘,最近 30 条倒序)——
 * 前端不从会话轨迹反解(轨迹里的工具结果是渲染后的 markdown,换个 render 就断)。
 * 本视图只取 kind==='vision' 的交叉读图记录;评审(kind 缺省)记录另有其主。
 * 宽进严出:坏行丢弃,缺字段给 undefined,绝不编造。
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
    flagged: Array.isArray(v.flagged) ? v.flagged.filter((f): f is string => typeof f === 'string') : [],
    imagePath: str(v.imagePath),
    panelists,
  };
}

/** 路由响应 → 读图记录(只要 kind==='vision';坏行丢弃)。 */
export function parseVisionLedger(input: unknown): CouncilRecord[] {
  if (!isRecord(input) || !Array.isArray(input.records)) return [];
  return input.records
    .map(parseRecord)
    .filter((r): r is CouncilRecord => r !== undefined && r.kind === 'vision');
}

/** 一行摘要数字:ok 家数 / 总家数。 */
export function panelOkCount(record: CouncilRecord): { ok: number; total: number } {
  return {
    ok: record.panelists.filter((p) => p.ok).length,
    total: record.panelists.length,
  };
}
