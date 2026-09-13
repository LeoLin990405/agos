import {
  parseTurnEvidence,
  turnEvidenceId,
  turnEvidenceMatches,
  type TurnEvidence,
  type TurnEvidenceBinding,
} from './turn-evidence';

export function turnEvidenceUrl(sessionId?: string, binding?: TurnEvidenceBinding): string {
  const id = sessionId?.trim() ?? '';
  const params = new URLSearchParams();
  if (id !== '') params.set('sessionId', id);
  if (binding !== undefined) {
    const turn = turnEvidenceId(binding.turn);
    const step = turnEvidenceId(binding.step);
    if (id === '' || turn === null || step === null) throw new Error('本跳编号未采集');
    params.set('turn', turn);
    params.set('step', step);
  }
  const search = params.toString();
  return `/api/agos/turn-evidence${search === '' ? '' : `?${search}`}`;
}

export async function fetchTurnEvidence(
  sessionId?: string,
  signal?: AbortSignal,
  binding?: TurnEvidenceBinding,
): Promise<TurnEvidence> {
  const response = await fetch(turnEvidenceUrl(sessionId, binding), { signal });
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
  const evidence = parseTurnEvidence(payload);
  if (binding !== undefined && !turnEvidenceMatches(evidence, sessionId ?? '', binding)) {
    throw new Error('返回证据与当前会话、轮次或步骤不匹配');
  }
  return evidence;
}
