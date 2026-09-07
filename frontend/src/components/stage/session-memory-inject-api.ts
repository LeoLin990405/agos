export interface SessionMemoryInjectStatus {
  enabled: boolean;
  itemCount: number | null;
  copy: string;
  method: string;
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  try {
    return await response.json() as Record<string, unknown>;
  } catch {
    return {};
  }
}

export function sessionMemoryInjectUrl(sessionId?: string): string {
  const id = sessionId?.trim() ?? '';
  return id === ''
    ? '/api/agos/session-memory/inject'
    : `/api/agos/session-memory/inject?sessionId=${encodeURIComponent(id)}`;
}

export async function fetchSessionMemoryInject(
  sessionId?: string,
  signal?: AbortSignal,
): Promise<SessionMemoryInjectStatus> {
  const response = await fetch(sessionMemoryInjectUrl(sessionId), { signal });
  const payload = await readJson(response);
  if (!response.ok) {
    throw new Error(typeof payload.error === 'string' ? payload.error : `HTTP ${response.status}`);
  }
  return {
    enabled: payload.enabled === true,
    itemCount: Number.isSafeInteger(payload.itemCount) ? Number(payload.itemCount) : null,
    copy: typeof payload.copy === 'string' ? payload.copy : '回注状态未采集',
    method: typeof payload.method === 'string' ? payload.method : '',
  };
}

export async function postSessionMemoryInject(
  enabled: boolean,
  signal?: AbortSignal,
): Promise<{ ok: true; enabled: boolean } | { ok: false; error: string }> {
  const response = await fetch('/api/agos/session-memory/inject', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ enabled, confirm: true }),
    signal,
  });
  const payload = await readJson(response);
  if (!response.ok || payload.ok !== true) {
    return { ok: false, error: typeof payload.error === 'string' ? payload.error : `HTTP ${response.status}` };
  }
  return { ok: true, enabled: payload.enabled === true };
}
