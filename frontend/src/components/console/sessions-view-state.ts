export type SessionConnectionPhase = 'idle' | 'connecting' | 'online' | 'offline';

export interface SessionsSurfaceInput {
  rowCount: number;
  loadedAt: number;
  error: string | undefined;
  connection: SessionConnectionPhase;
}

export type SessionsSurfaceState =
  | { kind: 'loading' }
  | { kind: 'error'; canRetry: true }
  | { kind: 'empty'; reason: 'connecting' | 'offline' | 'online' }
  | { kind: 'rows'; notice: 'refresh-error' | 'offline' | 'connecting' | undefined };

/** Derive the honest session surface without depending on React or network calls. */
export function deriveSessionsSurface(input: SessionsSurfaceInput): SessionsSurfaceState {
  if (input.loadedAt === 0 && input.error === undefined) return { kind: 'loading' };
  if (input.rowCount === 0 && input.error !== undefined) return { kind: 'error', canRetry: true };
  if (input.rowCount === 0) {
    if (input.connection === 'online') return { kind: 'empty', reason: 'online' };
    if (input.connection === 'offline') return { kind: 'empty', reason: 'offline' };
    return { kind: 'empty', reason: 'connecting' };
  }
  if (input.error !== undefined) return { kind: 'rows', notice: 'refresh-error' };
  if (input.connection === 'offline') return { kind: 'rows', notice: 'offline' };
  if (input.connection === 'idle' || input.connection === 'connecting') {
    return { kind: 'rows', notice: 'connecting' };
  }
  return { kind: 'rows', notice: undefined };
}

