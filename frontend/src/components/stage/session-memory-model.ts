export type SessionMemoryKind = 'fact' | 'constraint' | 'preference' | 'rejected';
export type SessionMemoryStatus = 'empty' | 'extracting' | 'ready';

export interface SessionMemoryItem {
  id: string;
  kind: SessionMemoryKind;
  text: string;
  importance: 1 | 2 | 3 | 4 | 5;
  sourceTurn: number;
  createdAt: string;
}

export interface SessionMemoryCounts {
  total: number;
  fact: number;
  constraint: number;
  preference: number;
  rejected: number;
}

export interface SessionMemoryPayload {
  version: 1;
  sessionId: string;
  status: SessionMemoryStatus;
  items: readonly SessionMemoryItem[];
  counts: SessionMemoryCounts;
  skippedSensitive: number;
  updatedAt: string | null;
}

export type SessionMemoryFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

const PAYLOAD_KEYS = ['version', 'sessionId', 'status', 'items', 'counts', 'skippedSensitive', 'updatedAt'] as const;
const ITEM_KEYS = ['id', 'kind', 'text', 'importance', 'sourceTurn', 'createdAt'] as const;
const COUNT_KEYS = ['total', 'fact', 'constraint', 'preference', 'rejected'] as const;
const KINDS: readonly SessionMemoryKind[] = ['fact', 'constraint', 'preference', 'rejected'];
const STATUSES: readonly SessionMemoryStatus[] = ['empty', 'extracting', 'ready'];

export class SessionMemorySchemaError extends Error {
  constructor() {
    super('会话记忆响应格式不兼容');
    this.name = 'SessionMemorySchemaError';
  }
}

export class SessionMemoryHttpError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(`会话记忆暂不可用 (HTTP ${status})`);
    this.name = 'SessionMemoryHttpError';
    this.status = status;
  }
}

function fail(): never {
  throw new SessionMemorySchemaError();
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail();
  return value as Record<string, unknown>;
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function nonNegativeInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) fail();
  return value as number;
}

function timestamp(value: unknown): string {
  if (typeof value !== 'string' || value === '' || !Number.isFinite(Date.parse(value))) fail();
  return value;
}

function parseItem(value: unknown): SessionMemoryItem {
  const item = record(value);
  if (!hasExactKeys(item, ITEM_KEYS)) fail();
  if (typeof item.id !== 'string' || item.id.trim() === '') fail();
  if (typeof item.kind !== 'string' || !KINDS.includes(item.kind as SessionMemoryKind)) fail();
  if (typeof item.text !== 'string' || item.text.trim() === '' || [...item.text].length > 200) fail();
  if (!Number.isInteger(item.importance) || (item.importance as number) < 1 || (item.importance as number) > 5) fail();

  return {
    id: item.id,
    kind: item.kind as SessionMemoryKind,
    // Deliberately preserve the sentence byte-for-byte instead of trimming it.
    text: item.text,
    importance: item.importance as SessionMemoryItem['importance'],
    sourceTurn: nonNegativeInteger(item.sourceTurn),
    createdAt: timestamp(item.createdAt),
  };
}

function parseCounts(value: unknown): SessionMemoryCounts {
  const counts = record(value);
  if (!hasExactKeys(counts, COUNT_KEYS)) fail();
  return {
    total: nonNegativeInteger(counts.total),
    fact: nonNegativeInteger(counts.fact),
    constraint: nonNegativeInteger(counts.constraint),
    preference: nonNegativeInteger(counts.preference),
    rejected: nonNegativeInteger(counts.rejected),
  };
}

/** Parse only the frozen public contract; unknown fields are rejected and never reach the UI. */
export function parseSessionMemoryPayload(value: unknown, expectedSessionId?: string): SessionMemoryPayload {
  const payload = record(value);
  if (!hasExactKeys(payload, PAYLOAD_KEYS)) fail();
  if (payload.version !== 1) fail();
  if (typeof payload.sessionId !== 'string' || payload.sessionId.trim() === '') fail();
  if (expectedSessionId !== undefined && payload.sessionId !== expectedSessionId) fail();
  if (typeof payload.status !== 'string' || !STATUSES.includes(payload.status as SessionMemoryStatus)) fail();
  if (!Array.isArray(payload.items) || payload.items.length > 30) fail();

  const items = payload.items.map(parseItem);
  if (new Set(items.map((item) => item.id)).size !== items.length) fail();
  const counts = parseCounts(payload.counts);
  const actualCounts = Object.fromEntries(KINDS.map((kind) => [kind, items.filter((item) => item.kind === kind).length]));
  if (
    counts.total !== items.length
    || KINDS.some((kind) => counts[kind] !== actualCounts[kind])
    || counts.fact + counts.constraint + counts.preference + counts.rejected !== counts.total
  ) fail();
  if (payload.status === 'empty' && counts.total !== 0) fail();

  return {
    version: 1,
    sessionId: payload.sessionId,
    status: payload.status as SessionMemoryStatus,
    items,
    counts,
    skippedSensitive: nonNegativeInteger(payload.skippedSensitive),
    updatedAt: payload.updatedAt === null ? null : timestamp(payload.updatedAt),
  };
}

export function sessionMemoryUrl(sessionId: string): string {
  if (sessionId.trim() === '') throw new TypeError('sessionId 不能为空');
  return `/api/agos/session-memory?sessionId=${encodeURIComponent(sessionId)}`;
}

export async function fetchSessionMemory(
  sessionId: string,
  signal: AbortSignal,
  fetchImpl: SessionMemoryFetch = (input, init) => fetch(input, init),
): Promise<SessionMemoryPayload> {
  const response = await fetchImpl(sessionMemoryUrl(sessionId), {
    method: 'GET',
    signal,
    headers: { accept: 'application/json' },
  });
  if (!response.ok) throw new SessionMemoryHttpError(response.status);
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    fail();
  }
  return parseSessionMemoryPayload(body, sessionId);
}

/** Only an in-flight extraction receives periodic reads. Ready/empty are fetch-once. */
export function sessionMemoryPollInterval(payload: SessionMemoryPayload | undefined): number {
  return payload?.status === 'extracting' ? 1_000 : 0;
}

export function sessionMemoryErrorMessage(error: unknown): string {
  if (error instanceof SessionMemoryHttpError || error instanceof SessionMemorySchemaError) return error.message;
  return '会话记忆暂不可用';
}

export function formatSessionMemoryTime(value: string, now = Date.now()): string {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return '时间未知';
  const elapsed = Math.max(0, now - time);
  if (elapsed < 60_000) return '刚刚';
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)} 分钟前`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)} 小时前`;
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(time));
}
