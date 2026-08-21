/** Shared state machine for read-only HTTP resources. */
export type ResourceStatus = 'idle' | 'loading' | 'ready' | 'degraded' | 'error';

export interface ResourceFailure {
  message: string;
  status?: number;
  at: number;
}

export interface ResourceState<T> {
  status: ResourceStatus;
  data?: T;
  /** Time of the most recent successful response. */
  at?: number;
  error?: ResourceFailure;
  /** Consecutive failures since the last successful response. */
  attempt: number;
}

export type ResourceEvent<T> =
  | { type: 'load' }
  | { type: 'resolve'; data: T; at?: number }
  | { type: 'reject'; error: unknown; status?: number; at?: number }
  | { type: 'reset' };

export const idleResource = <T>(): ResourceState<T> => ({ status: 'idle', attempt: 0 });

/** Exponential retry delay. attempt=0 is the first retry. */
export function nextBackoff(attempt: number, base: number, cap: number): number {
  const safeBase = Number.isFinite(base) ? Math.max(0, base) : 0;
  const safeCap = Number.isFinite(cap) ? Math.max(safeBase, cap) : safeBase;
  const exponent = Number.isFinite(attempt) ? Math.max(0, Math.floor(attempt)) : 0;
  return Math.min(safeCap, safeBase * (2 ** exponent));
}

function messageOf(error: unknown): string {
  if (error instanceof Error && error.message.trim() !== '') return error.message;
  if (typeof error === 'string' && error.trim() !== '') return error;
  return '请求失败';
}

function statusOf(error: unknown, explicit: number | undefined): number | undefined {
  if (explicit !== undefined) return explicit;
  if (typeof error !== 'object' || error === null) return undefined;
  const status = (error as { status?: unknown }).status;
  return typeof status === 'number' && Number.isFinite(status) ? status : undefined;
}

/**
 * Reduces resource lifecycle events without discarding the last good payload.
 * A failed refresh is `degraded`; a failed initial load is `error`.
 */
export function mergeResource<T>(prev: ResourceState<T>, event: ResourceEvent<T>): ResourceState<T> {
  switch (event.type) {
    case 'load':
      return { ...prev, status: 'loading', error: undefined };
    case 'resolve':
      return {
        status: 'ready',
        data: event.data,
        at: event.at ?? Date.now(),
        attempt: 0,
      };
    case 'reject': {
      const at = event.at ?? Date.now();
      return {
        ...prev,
        status: prev.data === undefined ? 'error' : 'degraded',
        error: { message: messageOf(event.error), status: statusOf(event.error, event.status), at },
        attempt: prev.attempt + 1,
      };
    }
    case 'reset':
      return idleResource<T>();
  }
}
