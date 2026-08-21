import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import {
  idleResource,
  mergeResource,
  nextBackoff,
  type ResourceState,
} from '@/lib/resource';

export class ResourceHttpError extends Error {
  readonly status: number;

  constructor(status: number, statusText = '') {
    super(`HTTP ${status}${statusText === '' ? '' : ` ${statusText}`}`);
    this.name = 'ResourceHttpError';
    this.status = status;
  }
}

export type ResourceFetcher<T> = (url: string, signal: AbortSignal) => Promise<T>;

export async function fetchJsonResource<T>(url: string, signal: AbortSignal): Promise<T> {
  const response = await fetch(url, { signal, headers: { accept: 'application/json' } });
  if (!response.ok) throw new ResourceHttpError(response.status, response.statusText);
  return response.json() as Promise<T>;
}

export interface UseResourceOptions<T> {
  url: string | null;
  enabled?: boolean;
  /** Successful requests poll at this interval. Omit or set 0 for fetch-once. */
  intervalMs?: number;
  /** Refresh immediately on window focus while visible. */
  refreshOnFocus?: boolean;
  baseBackoffMs?: number;
  capBackoffMs?: number;
  fetcher?: ResourceFetcher<T>;
}

export interface ResourceController<T> extends ResourceState<T> {
  /** Re-fetch now. An override URL is consumed by this request only. */
  refresh: (urlOverride?: string) => void;
}

const isAbort = (error: unknown): boolean =>
  typeof DOMException !== 'undefined' && error instanceof DOMException
    ? error.name === 'AbortError'
    : typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'AbortError';

const pageVisible = (): boolean => typeof document === 'undefined' || !document.hidden;

/** Defers the initial request so React StrictMode can cancel its probe effect. */
export function scheduleResourceStart(isActive: () => boolean, task: () => void): void {
  queueMicrotask(() => { if (isActive()) task(); });
}

/** Whether visibility recovery should fetch instead of remaining fetch-once. */
export function shouldResumeResource(started: boolean, failures: number, intervalMs: number): boolean {
  return !started || failures > 0 || intervalMs > 0;
}

/**
 * Browser lifecycle shell around the pure resource reducer.
 * Requests are aborted on replacement/unmount; hidden documents pause polling;
 * failures retain prior data and retry with bounded exponential backoff.
 */
export function useResource<T>({
  url,
  enabled = true,
  intervalMs = 0,
  refreshOnFocus = false,
  baseBackoffMs = 1_000,
  capBackoffMs = 30_000,
  fetcher = fetchJsonResource<T>,
}: UseResourceOptions<T>): ResourceController<T> {
  const [state, setState] = useState<ResourceState<T>>(() => idleResource<T>());
  const [generation, bumpGeneration] = useReducer((value: number) => value + 1, 0);
  const overrideUrl = useRef<string | undefined>(undefined);
  const fetcherRef = useRef<ResourceFetcher<T>>(fetcher);
  fetcherRef.current = fetcher;

  const refresh = useCallback((nextUrl?: string) => {
    overrideUrl.current = nextUrl;
    bumpGeneration();
  }, []);

  useEffect(() => {
    if (!enabled || url === null) {
      setState(idleResource<T>());
      return undefined;
    }

    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | undefined;
    let failures = 0;
    let started = false;
    let pendingUrl = overrideUrl.current;
    overrideUrl.current = undefined;

    const clearTimer = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    };

    const schedule = (delay: number): void => {
      clearTimer();
      if (!active || !pageVisible()) return;
      timer = setTimeout(() => { void run(); }, Math.max(0, delay));
    };

    const run = async (requestedUrl?: string): Promise<void> => {
      if (!active || !pageVisible()) return;
      started = true;
      const target = requestedUrl ?? pendingUrl ?? url;
      pendingUrl = undefined;
      clearTimer();
      controller?.abort();
      controller = new AbortController();
      const signal = controller.signal;
      setState((previous) => mergeResource(previous, { type: 'load' }));
      try {
        const data = await fetcherRef.current(target, signal);
        if (!active || signal.aborted) return;
        failures = 0;
        setState((previous) => mergeResource(previous, { type: 'resolve', data }));
        if (intervalMs > 0) schedule(intervalMs);
      } catch (error) {
        if (!active || signal.aborted || isAbort(error)) return;
        const retryAttempt = failures;
        failures += 1;
        setState((previous) => mergeResource(previous, { type: 'reject', error }));
        schedule(nextBackoff(retryAttempt, baseBackoffMs, capBackoffMs));
      }
    };

    const onVisibility = (): void => {
      if (!pageVisible()) {
        clearTimer();
        return;
      }
      if (shouldResumeResource(started, failures, intervalMs)) void run();
    };
    const onFocus = (): void => {
      if (refreshOnFocus && pageVisible()) void run();
    };

    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility);
    if (typeof window !== 'undefined') window.addEventListener('focus', onFocus);
    // StrictMode immediately tears down its probe effect. Deferring prevents that
    // disposable pass from issuing an expensive duplicate GET.
    scheduleResourceStart(() => active, () => { void run(); });

    return () => {
      active = false;
      clearTimer();
      controller?.abort();
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility);
      if (typeof window !== 'undefined') window.removeEventListener('focus', onFocus);
    };
  }, [baseBackoffMs, capBackoffMs, enabled, generation, intervalMs, refreshOnFocus, url]);

  return { ...state, refresh };
}
