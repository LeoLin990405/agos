export const DESK_COPY = '只写入 AgOS 甲板账本，未写入 Fleet Memory 真源';

export const CIV_UNAVAILABLE_COPY = '宿主 civ memory_submit 未接线，未写入 Fleet Memory';

export interface MemoryDeskRecord {
  kind: 'promote' | 'void' | 'submit';
  at: string;
  slug?: string;
  sessionId?: string;
  itemId?: string;
  text?: string;
  fleetMemory?: boolean;
}

export interface MemoryDeskSnapshot {
  writtenTo: 'agos-desk';
  fleetMemory: false;
  copy: string;
  civAvailable?: boolean;
  promotes: MemoryDeskRecord[];
  voids: MemoryDeskRecord[];
  submits: MemoryDeskRecord[];
  promoteCount: number;
  voidCount: number;
  submitCount: number;
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  try {
    return await response.json() as Record<string, unknown>;
  } catch {
    return {};
  }
}

function recordsOf(value: unknown): MemoryDeskRecord[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((row) => {
    if (!row || typeof row !== 'object') return [];
    const item = row as Record<string, unknown>;
    if (item.kind !== 'promote' && item.kind !== 'void' && item.kind !== 'submit') return [];
    return [{
      kind: item.kind,
      at: typeof item.at === 'string' ? item.at : '',
      slug: typeof item.slug === 'string' ? item.slug : undefined,
      sessionId: typeof item.sessionId === 'string' ? item.sessionId : undefined,
      itemId: typeof item.itemId === 'string' ? item.itemId : undefined,
      text: typeof item.text === 'string' ? item.text : undefined,
      fleetMemory: item.fleetMemory === true ? true : item.fleetMemory === false ? false : undefined,
    }];
  });
}

export async function fetchMemoryDesk(signal?: AbortSignal): Promise<MemoryDeskSnapshot> {
  const response = await fetch('/api/agos/memory/desk', { signal });
  const payload = await readJson(response);
  if (!response.ok) {
    throw new Error(typeof payload.error === 'string' ? payload.error : `HTTP ${response.status}`);
  }
  return {
    writtenTo: 'agos-desk',
    fleetMemory: false,
    copy: typeof payload.copy === 'string' ? payload.copy : DESK_COPY,
    civAvailable: payload.civAvailable === true || payload.civAvailable === false
      ? payload.civAvailable
      : undefined,
    promotes: recordsOf(payload.promotes),
    voids: recordsOf(payload.voids),
    submits: recordsOf(payload.submits),
    promoteCount: Number(payload.promoteCount) || 0,
    voidCount: Number(payload.voidCount) || 0,
    submitCount: Number(payload.submitCount) || 0,
  };
}

export async function postMemoryDesk(
  input:
    | { action: 'promote'; sessionId: string; itemId: string; kind: string; text: string }
    | { action: 'void'; slug: string }
    | { action: 'submit'; slug: string; type: string; description: string; body: string; sessionId?: string; itemId?: string },
  signal?: AbortSignal,
): Promise<{ ok: true; copy: string } | { ok: false; error: string }> {
  const response = await fetch('/api/agos/memory/desk', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...input, confirm: true }),
    signal,
  });
  const payload = await readJson(response);
  if (!response.ok || payload.ok !== true) {
    return { ok: false, error: typeof payload.error === 'string' ? payload.error : `HTTP ${response.status}` };
  }
  return { ok: true, copy: typeof payload.copy === 'string' ? payload.copy : DESK_COPY };
}

export function deskVoidedSlugSet(voids: readonly MemoryDeskRecord[]): Set<string> {
  return new Set(voids.map((row) => row.slug).filter((slug): slug is string => typeof slug === 'string'));
}
