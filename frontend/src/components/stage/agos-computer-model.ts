import type { FoldedConversation, ToolItem } from '@/fold/model';
import type { SwarmProgressSummary } from '@/stores/live';

const COMMAND_KEYS = ['command', 'cmd', 'script'] as const;
const PATH_KEYS = ['file_path', 'filePath', 'notebook_path', 'file', 'path'] as const;
const DETAIL_KEYS = ['command', 'cmd', 'file_path', 'filePath', 'file', 'pattern', 'query', 'url', 'description', 'path'] as const;

const DETAIL_MAX_CHARS = 28;
const OUTPUT_MAX_CHARS = 6000;
const COMMAND_MAX_CHARS = 2000;

function clampChars(text: string, max: number): string {
  const chars = Array.from(text);
  if (chars.length <= max) return text;
  return `${chars.slice(0, max - 1).join('')}…`;
}

function parseArgsObject(argsRaw: string): Record<string, unknown> | undefined {
  const trimmed = argsRaw.trim();
  if (trimmed === '') return undefined;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
    return parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function readStringKey(args: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = args[key];
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (trimmed !== '') return trimmed;
  }
  return undefined;
}

export function pathTail(value: string): string {
  const segments = value.split(/[/\\]/).filter((segment) => segment !== '');
  const last = segments[segments.length - 1];
  return last === undefined || last === '' ? value : last;
}

export type AgosToolClass = 'terminal' | 'file' | 'swarm' | 'other';

export function classifyTool(name: string): AgosToolClass {
  const normalized = name.toLowerCase();
  if (
    normalized.includes('swarm')
    || normalized.includes('subagent')
    || normalized.includes('fanout')
    || normalized.includes('delegate')
  ) return 'swarm';
  if (normalized.includes('bash') || normalized.includes('terminal') || normalized.includes('shell') || normalized.includes('exec')) return 'terminal';
  if (normalized.includes('write') || normalized.includes('edit') || normalized.includes('read') || normalized.includes('create') || normalized.includes('notebook')) return 'file';
  return 'other';
}

function toolItems(snapshot: FoldedConversation | undefined): ToolItem[] {
  const out: ToolItem[] = [];
  for (const item of snapshot?.items ?? []) {
    if (item.kind === 'tool') out.push(item);
  }
  return out;
}

export interface AgosActivity {
  toolName: string;
  detail: string | undefined;
}

export function selectCurrentActivity(snapshot: FoldedConversation | undefined): AgosActivity | undefined {
  const tools = toolItems(snapshot);
  for (let index = tools.length - 1; index >= 0; index -= 1) {
    const tool = tools[index];
    if (tool === undefined || tool.status !== 'running') continue;
    const name = tool.name.trim();
    if (name === '') continue;
    const args = parseArgsObject(tool.argsRaw);
    const raw = args === undefined ? undefined : readStringKey(args, DETAIL_KEYS);
    let detail: string | undefined;
    if (raw !== undefined) {
      const firstLine = raw.split('\n')[0] ?? raw;
      const looksLikePath = firstLine.includes('/') && !firstLine.includes(' ');
      detail = clampChars(looksLikePath ? pathTail(firstLine) : firstLine, DETAIL_MAX_CHARS);
    }
    return { toolName: name, detail };
  }
  return undefined;
}

export function activityLabel(activity: AgosActivity | undefined): string {
  if (activity === undefined) return '空闲';
  return activity.detail === undefined
    ? `正在用 ${activity.toolName}`
    : `正在用 ${activity.toolName} · ${activity.detail}`;
}

export interface AgosTerminalEntry {
  callId: string;
  command: string;
  output: string;
  truncated: boolean;
  status: ToolItem['status'];
  startAt: number;
  durationMs: number | undefined;
}

export function selectTerminalEntries(snapshot: FoldedConversation | undefined): AgosTerminalEntry[] {
  const out: AgosTerminalEntry[] = [];
  for (const tool of toolItems(snapshot)) {
    if (classifyTool(tool.name) !== 'terminal') continue;
    const args = parseArgsObject(tool.argsRaw);
    const parsed = args === undefined ? undefined : readStringKey(args, COMMAND_KEYS);
    const command = parsed !== undefined
      ? clampChars(parsed, COMMAND_MAX_CHARS)
      : clampChars(tool.argsRaw.trim(), COMMAND_MAX_CHARS);
    const full = tool.resultText ?? '';
    out.push({
      callId: tool.callId,
      command,
      output: full.slice(0, OUTPUT_MAX_CHARS),
      truncated: full.length > OUTPUT_MAX_CHARS,
      status: tool.status,
      startAt: tool.startAt,
      durationMs: tool.endAt === undefined ? undefined : tool.endAt - tool.startAt,
    });
  }
  return out;
}

export interface AgosFileEntry {
  path: string;
  tail: string;
  count: number;
  lastAt: number;
  tools: string[];
}

export function selectFileEntries(snapshot: FoldedConversation | undefined): AgosFileEntry[] {
  const map = new Map<string, AgosFileEntry>();
  for (const tool of toolItems(snapshot)) {
    if (classifyTool(tool.name) !== 'file') continue;
    const args = parseArgsObject(tool.argsRaw);
    if (args === undefined) continue;
    const path = readStringKey(args, PATH_KEYS);
    if (path === undefined) continue;
    const prev = map.get(path);
    if (prev === undefined) {
      map.set(path, { path, tail: pathTail(path), count: 1, lastAt: tool.startAt, tools: [tool.name] });
      continue;
    }
    prev.count += 1;
    prev.lastAt = Math.max(prev.lastAt, tool.startAt);
    if (!prev.tools.includes(tool.name)) prev.tools.push(tool.name);
  }
  return [...map.values()].sort((left, right) => right.lastAt - left.lastAt);
}

export interface AgosSubagentBatch {
  callId: string;
  label: string;
  done: number;
  failed: number;
  total: number;
  running: boolean;
}

/** One `/api/swarm/progress` call, already flattened to `{ callId, ...body }`. */
export interface SubagentProgressCall {
  callId: string;
  parentSessionId?: string;
  description?: string;
  rows?: readonly Record<string, unknown>[];
}

export interface SubagentOwnedProgress {
  sessionId?: string;
  progressCalls?: readonly SubagentProgressCall[];
}

function tallyProgressRows(rows: readonly Record<string, unknown>[]): {
  done: number;
  failed: number;
  total: number;
  running: boolean;
} {
  let done = 0;
  let failed = 0;
  for (const row of rows) {
    const status = String(row['status'] ?? '');
    if (status === 'completed') done += 1;
    else if (status === 'failed') failed += 1;
  }
  return { done, failed, total: rows.length, running: done + failed < rows.length };
}

function progressCallOwnedBySession(call: SubagentProgressCall, sessionId: string): boolean {
  if (sessionId === '') return false;
  if (call.parentSessionId === sessionId) return true;
  if (call.callId === sessionId) return true;
  if (call.callId === `host:${sessionId}`) return true;
  return false;
}

export function selectSubagentBatches(
  snapshot: FoldedConversation | undefined,
  live: SwarmProgressSummary | undefined,
  owned?: SubagentOwnedProgress,
): AgosSubagentBatch[] {
  const order: string[] = [];
  const map = new Map<string, AgosSubagentBatch>();
  const sessionCallIds = new Set<string>();

  for (const tool of toolItems(snapshot)) {
    sessionCallIds.add(tool.callId);
    const rows = tool.swarm;
    if (rows === undefined || rows.length === 0) continue;
    let done = 0;
    let failed = 0;
    for (const row of rows) {
      if (row.status === 'completed') done += 1;
      else if (row.status === 'failed') failed += 1;
    }
    if (!map.has(tool.callId)) order.push(tool.callId);
    map.set(tool.callId, {
      callId: tool.callId,
      label: tool.name.trim() === '' ? tool.callId : tool.name,
      done,
      failed,
      total: rows.length,
      running: tool.status === 'running',
    });
  }

  for (const batch of live?.batches ?? []) {
    if (!sessionCallIds.has(batch.callId)) continue;
    const prev = map.get(batch.callId);
    if (prev === undefined) order.push(batch.callId);
    map.set(batch.callId, {
      callId: batch.callId,
      label: prev?.label ?? batch.label,
      done: batch.done,
      failed: batch.failed,
      total: batch.total,
      running: true,
    });
  }

  const sessionId = owned?.sessionId?.trim() ?? '';
  if (sessionId !== '' && owned?.progressCalls !== undefined) {
    for (const call of owned.progressCalls) {
      if (!progressCallOwnedBySession(call, sessionId)) continue;
      const rows = Array.isArray(call.rows) ? call.rows : [];
      if (rows.length === 0) continue;
      const tally = tallyProgressRows(rows);
      const prev = map.get(call.callId);
      if (prev === undefined) order.push(call.callId);
      const fromDescription = typeof call.description === 'string' ? call.description.trim() : '';
      map.set(call.callId, {
        callId: call.callId,
        label: prev?.label ?? (fromDescription !== '' ? fromDescription : call.callId),
        done: tally.done,
        failed: tally.failed,
        total: tally.total,
        running: tally.running,
      });
    }
  }

  if (map.size === 0) {
    for (const tool of toolItems(snapshot)) {
      if (classifyTool(tool.name) !== 'swarm') continue;
      if (!map.has(tool.callId)) order.push(tool.callId);
      map.set(tool.callId, {
        callId: tool.callId,
        label: tool.name.trim() === '' ? tool.callId : tool.name,
        done: tool.status === 'done' ? 1 : 0,
        failed: tool.status === 'failed' ? 1 : 0,
        total: 1,
        running: tool.status === 'running',
      });
    }
  }

  return order
    .map((id) => map.get(id))
    .filter((batch): batch is AgosSubagentBatch => batch !== undefined);
}
