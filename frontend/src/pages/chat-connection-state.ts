export type ChatConnectionState = 'connecting' | 'disconnected' | 'empty' | 'ready';

export interface ChatConnectionSnapshot {
  sessionsLoadedAt: number;
  sessionsError: string | undefined;
  sessionCount: number;
  muxPhase: 'idle' | 'connecting' | 'online' | 'offline';
}

/**
 * Derive the chat surface state without treating an empty session list as
 * conversation content. Only actual mux lifecycle events conclude online/offline;
 * elapsed wall-clock time is deliberately not part of this state machine.
 */
export function deriveChatConnectionState(snapshot: ChatConnectionSnapshot): ChatConnectionState {
  if (snapshot.sessionsError !== undefined) return 'disconnected';
  if (snapshot.sessionsLoadedAt <= 0 || snapshot.muxPhase === 'idle' || snapshot.muxPhase === 'connecting') return 'connecting';
  if (snapshot.muxPhase === 'offline') return 'disconnected';
  return snapshot.sessionCount === 0 ? 'empty' : 'ready';
}
