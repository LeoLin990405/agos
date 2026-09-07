import type { SessionMemoryItem, SessionMemoryKind } from './session-memory-model';

/** Graphiti-style episodic / working layer over the frozen session-memory contract. */
export const SESSION_MEMORY_LAYER = '情节层';
export const INJECT_ENABLED_COPY = '下一跳会回注本会话已提炼条目';
export const INJECT_EMPTY_COPY = '回注已启用，本会话没有可回注条目';
export const INJECT_OFF_COPY = '回注未启用：仅观察，不进下一跳';
export const INJECT_METHOD_COPY = '会话记忆回注是便利投影，不是权威记忆';
export const PIN_EMPTY_COPY = '本会话还没有已提炼的短期记忆。完成一轮后会在空闲时异步整理。也可确认后把一条真实约束或偏好收进本会话。';
export const PIN_METHOD_COPY = '收进本会话是操作员确认写入，不是抽取例句，也不是 Fleet Memory。';

export function sessionMemoryInjectCopy(enabled: boolean | undefined, itemCount: number): string {
  if (enabled === undefined) return '回注状态未采集';
  if (!enabled) return INJECT_OFF_COPY;
  return itemCount > 0 ? INJECT_ENABLED_COPY : INJECT_EMPTY_COPY;
}

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
