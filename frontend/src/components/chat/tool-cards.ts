/**
 * 对话流工具卡族：只按 fold 真字段分流，不改事件词汇。
 * swarm 有进度行才进 Swarm 卡；bash 进终端卡；读写文件进文件卡；其余走通用时间线。
 */

export type ChatToolCardKind = 'swarm' | 'bash' | 'file' | 'generic';

export const FILE_PATH_KEYS = ['file_path', 'filePath', 'notebook_path', 'file'] as const;

export interface ChatToolCardSource {
  readonly name: string;
  readonly argsRaw?: string;
  readonly swarm?: readonly unknown[];
}

function parseArgsObject(argsRaw: string | undefined): Record<string, unknown> | undefined {
  const trimmed = (argsRaw ?? '').trim();
  if (trimmed === '') return undefined;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
    return parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

export function isFileToolName(name: string): boolean {
  const n = name.toLowerCase();
  if (n.includes('todo') || n.includes('search') || n.includes('grep') || n.includes('glob')) return false;
  return n.includes('write') || n.includes('edit') || n.includes('read') || n.includes('create') || n.includes('notebook');
}

export function chatToolCardKind(item: ChatToolCardSource): ChatToolCardKind {
  if (item.swarm !== undefined && item.swarm.length > 0) return 'swarm';
  if (item.name === 'bash') return 'bash';
  if (isFileToolName(item.name)) return 'file';
  return 'generic';
}

/** 文件卡路径：只认参数里的真实路径键，取不到就缺席，不拼。 */
export function fileToolPath(argsRaw: string | undefined): string | undefined {
  const args = parseArgsObject(argsRaw);
  if (args === undefined) return undefined;
  for (const key of FILE_PATH_KEYS) {
    const value = args[key];
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (trimmed !== '') return trimmed;
  }
  return undefined;
}

export function fileToolPathTail(path: string | undefined): string | undefined {
  if (path === undefined || path === '') return undefined;
  const segments = path.split(/[/\\]/).filter((s) => s !== '');
  return segments.length > 0 ? segments[segments.length - 1] : undefined;
}

/**
 * 运行中的会话走 queue（进宿主队列，不打断本轮）；空闲走 steer。
 * session/prompt 没有 swarm 开关，输入区不得假装有。
 */
export function sessionPromptMode(running: boolean): 'queue' | 'steer' {
  return running ? 'queue' : 'steer';
}

export const QUEUE_WHILE_RUNNING_COPY = '会话运行中，新指令将排队，不会打断本轮';
export const QUEUED_COUNT_COPY = (n: number): string => `已排队 ${n} 条，当前回合结束后发送`;
