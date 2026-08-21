export interface LineageHistoryRecord {
  event?: unknown;
  at?: unknown;
  callId?: unknown;
  parentSessionId?: unknown;
  rows?: unknown;
}

export interface FoldedLineageCall {
  callId: string;
  parentSessionId: string | undefined;
  startedAt: number | undefined;
  endedAt: number | undefined;
  rows: Record<string, unknown>[];
  state: 'completed' | 'unclosed' | 'orphaned-end';
  durationMs: number | undefined;
}

interface Accumulator {
  start: LineageHistoryRecord | undefined;
  end: LineageHistoryRecord | undefined;
}

function finiteAt(record: LineageHistoryRecord | undefined): number | undefined {
  return typeof record?.at === 'number' && Number.isFinite(record.at) && record.at > 0
    ? record.at
    : undefined;
}

function rowsOf(record: LineageHistoryRecord | undefined): Record<string, unknown>[] {
  return Array.isArray(record?.rows)
    ? record.rows.filter((row): row is Record<string, unknown> => typeof row === 'object' && row !== null)
    : [];
}

function parentOf(record: LineageHistoryRecord | undefined): string | undefined {
  return typeof record?.parentSessionId === 'string' && record.parentSessionId !== ''
    ? record.parentSessionId
    : undefined;
}

/** Fold newest-first (or chronological) start/end records into one truthful row per call. */
export function foldLineageHistory(records: LineageHistoryRecord[]): FoldedLineageCall[] {
  const groups = new Map<string, Accumulator>();

  for (const record of records) {
    const callId = typeof record.callId === 'string' ? record.callId.trim() : '';
    if (callId === '' || (record.event !== 'start' && record.event !== 'end')) continue;
    const group = groups.get(callId) ?? { start: undefined, end: undefined };
    const slot = record.event;
    const current = group[slot];
    const currentAt = finiteAt(current);
    const nextAt = finiteAt(record);

    // A call's canonical boundaries are the earliest start and latest end.
    if (current === undefined
      || (slot === 'start' && nextAt !== undefined && (currentAt === undefined || nextAt < currentAt))
      || (slot === 'end' && nextAt !== undefined && (currentAt === undefined || nextAt > currentAt))) {
      group[slot] = record;
    }
    groups.set(callId, group);
  }

  return [...groups.entries()].map(([callId, group]) => {
    const startedAt = finiteAt(group.start);
    const endedAt = finiteAt(group.end);
    const hasStart = group.start !== undefined;
    const hasEnd = group.end !== undefined;
    return {
      callId,
      parentSessionId: parentOf(group.end) ?? parentOf(group.start),
      startedAt,
      endedAt,
      rows: group.end !== undefined ? rowsOf(group.end) : rowsOf(group.start),
      state: hasStart && !hasEnd ? 'unclosed' : !hasStart && hasEnd ? 'orphaned-end' : 'completed',
      durationMs: startedAt !== undefined && endedAt !== undefined && endedAt >= startedAt
        ? endedAt - startedAt
        : undefined,
    } satisfies FoldedLineageCall;
  }).sort((a, b) => (b.endedAt ?? b.startedAt ?? 0) - (a.endedAt ?? a.startedAt ?? 0));
}
