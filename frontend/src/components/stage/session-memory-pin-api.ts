export const PIN_CONFIRM_COPY = '收进会话记忆需要确认。写的是本会话便利投影，不是 Fleet Memory。';

async function readJson(response: Response): Promise<Record<string, unknown>> {
  try {
    return await response.json() as Record<string, unknown>;
  } catch {
    return {};
  }
}

export async function postSessionMemoryPin(
  input: { sessionId: string; kind: string; text: string; sourceTurn?: number },
  signal?: AbortSignal,
): Promise<{ ok: true; itemCount: number } | { ok: false; error: string }> {
  const response = await fetch('/api/agos/session-memory/pin', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...input, confirm: true }),
    signal,
  });
  const payload = await readJson(response);
  if (!response.ok || payload.ok !== true) {
    return { ok: false, error: typeof payload.error === 'string' ? payload.error : `HTTP ${response.status}` };
  }
  return {
    ok: true,
    itemCount: Number.isSafeInteger(payload.itemCount) ? Number(payload.itemCount) : 0,
  };
}
