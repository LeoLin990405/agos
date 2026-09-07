import { parseTurnEvidence, type TurnEvidence } from './turn-evidence';

export function turnEvidenceUrl(sessionId?: string): string {
  const id = sessionId?.trim() ?? '';
  return id === ''
    ? '/api/agos/turn-evidence'
    : `/api/agos/turn-evidence?sessionId=${encodeURIComponent(id)}`;
}

export async function fetchTurnEvidence(
  sessionId?: string,
  signal?: AbortSignal,
): Promise<TurnEvidence> {
  const response = await fetch(turnEvidenceUrl(sessionId), { signal });
  let payload: unknown = {};
  try {
    payload = await response.json();
  } catch {
    payload = {};
  }
  if (!response.ok) {
    const error = payload && typeof payload === 'object' && 'error' in payload
      && typeof payload.error === 'string'
      ? payload.error
      : `HTTP ${response.status}`;
    throw new Error(error);
  }
  return parseTurnEvidence(payload);
}
