import { parseMemoryRelevance, type MemoryRelevance } from './session-memory-rank';

export function memoryRelevanceUrl(sessionId?: string, query?: string): string {
  const id = sessionId?.trim() ?? '';
  const needle = query?.trim() ?? '';
  const params = new URLSearchParams();
  if (id !== '') params.set('sessionId', id);
  if (needle !== '') params.set('query', needle);
  const search = params.toString();
  return search === '' ? '/api/agos/session-memory/relevance' : `/api/agos/session-memory/relevance?${search}`;
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  try {
    return await response.json() as Record<string, unknown>;
  } catch {
    return {};
  }
}

export async function fetchMemoryRelevance(
  sessionId?: string,
  query?: string,
  signal?: AbortSignal,
): Promise<MemoryRelevance> {
  const response = await fetch(memoryRelevanceUrl(sessionId, query), { signal });
  const payload = await readJson(response);
  if (!response.ok) {
    throw new Error(typeof payload.error === 'string' ? payload.error : `HTTP ${response.status}`);
  }
  return parseMemoryRelevance(payload);
}

export async function postMemoryRelevance(input: {
  sessionId: string;
  itemId: string;
  result: 'ok' | 'fail';
  query?: string;
}, signal?: AbortSignal): Promise<{ ok: true } | { ok: false; error: string }> {
  const response = await fetch('/api/agos/session-memory/relevance', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...input, source: 'operator', confirm: true }),
    signal,
  });
  const payload = await readJson(response);
  if (!response.ok || payload.ok !== true) {
    return { ok: false, error: typeof payload.error === 'string' ? payload.error : `HTTP ${response.status}` };
  }
  return { ok: true };
}
