import type { SessionMemoryItem, SessionMemoryKind } from './session-memory-model';

/** Graphiti-style episodic / working layer over the frozen session-memory contract. */
export const SESSION_MEMORY_LAYER = '情节层';

export const SESSION_KIND_ORDER: readonly SessionMemoryKind[] = [
  'constraint',
  'preference',
  'fact',
  'rejected',
];

export type SessionMemoryGroup = 'kind' | 'turn';

export interface SessionKindGroup {
  kind: SessionMemoryKind;
  items: readonly SessionMemoryItem[];
}

export interface SessionTurnGroup {
  sourceTurn: number;
  items: readonly SessionMemoryItem[];
}

export const SESSION_KIND_LABELS: Record<SessionMemoryKind, string> = {
  fact: '事实',
  constraint: '约束',
  preference: '偏好',
  rejected: '已排除',
};

export const COMPACT_SESSION_MEMORY_LIMIT = 3;

export function importanceUnit(importance: SessionMemoryItem['importance']): number {
  return importance / 5;
}

export function filterSessionMemoryByQuery(
  items: readonly SessionMemoryItem[],
  query: string,
): SessionMemoryItem[] {
  const needle = query.trim().toLowerCase();
  if (needle === '') return [...items];
  return items.filter((item) => item.text.toLowerCase().includes(needle));
}

export function compactSessionMemoryItems(
  items: readonly SessionMemoryItem[],
  limit = COMPACT_SESSION_MEMORY_LIMIT,
): { items: SessionMemoryItem[]; hidden: number } {
  const visible = items.slice(0, Math.max(0, limit));
  return { items: visible, hidden: Math.max(0, items.length - visible.length) };
}

export function sessionMemoryByKind(
  items: readonly SessionMemoryItem[],
  filter: SessionMemoryKind | 'all' = 'all',
): SessionKindGroup[] {
  const visible = filter === 'all' ? items : items.filter((item) => item.kind === filter);
  return SESSION_KIND_ORDER
    .map((kind) => ({ kind, items: visible.filter((item) => item.kind === kind) }))
    .filter((group) => group.items.length > 0);
}

export function sessionMemoryByTurn(
  items: readonly SessionMemoryItem[],
  filter: SessionMemoryKind | 'all' = 'all',
): SessionTurnGroup[] {
  const visible = filter === 'all' ? items : items.filter((item) => item.kind === filter);
  const grouped = new Map<number, SessionMemoryItem[]>();
  for (const item of visible) {
    const bucket = grouped.get(item.sourceTurn) ?? [];
    bucket.push(item);
    grouped.set(item.sourceTurn, bucket);
  }
  return [...grouped.entries()]
    .sort((left, right) => left[0] - right[0])
    .map(([sourceTurn, groupedItems]) => ({ sourceTurn, items: groupedItems }));
}
