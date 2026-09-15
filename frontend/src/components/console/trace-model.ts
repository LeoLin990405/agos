/**
 * 轨迹页只认 /api/trace/sessions 真载荷。
 * 缺插件 / HTTP 失败是「未采集」，不是「暂无会话」的健康空页。
 */

export interface TraceRow {
  /**
   * 权威会话 id(带 `session-` 前缀)。载荷里本来就有,此前被解析丢弃。
   * 依据是磁盘名册:~/.dsh/sessions/--Users-leo--/ 下的目录就叫 `session-<uuid>`,
   * session.list 也按这个形态发号。
   */
  rawId: string;
  id: string;
  title: string;
  createdAt: number;
  cwd: string;
  model: string;
  turns: number;
  steps: number;
  llmMs: number;
  toolMs: number;
}

export const TRACE_LOADING_COPY = '正在读取会话轨迹…';
export const TRACE_EMPTY_COPY = '暂无会话轨迹。';

export function parseTraceSessions(value: unknown): TraceRow[] {
  if (value === null || typeof value !== 'object') {
    throw new Error('/api/trace/sessions 返回不是对象或数组');
  }
  const list = Array.isArray(value)
    ? value
    : (value as { sessions?: unknown }).sessions;
  if (!Array.isArray(list)) {
    throw new Error('/api/trace/sessions 返回缺少 sessions 数组');
  }
  return list.map((it) => {
    const row = (it !== null && typeof it === 'object') ? it as Record<string, unknown> : {};
    const stats = (row['stats'] !== null && typeof row['stats'] === 'object')
      ? row['stats'] as Record<string, unknown>
      : {};
    return {
      rawId: String(row['rawId'] ?? ''),
      id: String(row['id'] ?? ''),
      title: String(row['title'] ?? '(未命名)'),
      createdAt: Number(row['createdAt'] ?? 0),
      cwd: String(row['cwd'] ?? ''),
      model: String(row['model'] ?? ''),
      turns: Number(stats['turns'] ?? 0),
      steps: Number(stats['steps'] ?? 0),
      llmMs: Number(stats['llmMs'] ?? 0),
      toolMs: Number(stats['toolMs'] ?? 0),
    };
  }).filter((x) => x.id !== '');
}

/** Plans/Skills 同口径：带 HTTP 状态，缺席写未采集。 */
export function traceFailureText(status: number | undefined, message: string | undefined): string {
  const http = status === undefined ? '' : `HTTP ${status} · `;
  const detail = (message ?? '').trim();
  return `${http}${detail === '' ? '未采集' : detail}`;
}

export function traceUncollectedCopy(status: number | undefined, message: string | undefined): string {
  return `/api/trace/sessions 未采集：${traceFailureText(status, message)}`;
}
