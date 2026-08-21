import React, { useEffect, useReducer, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Chip, type ChipProps } from '@/components/ui/Chip';
import { Dot } from '@/components/ui/Dot';
import {
  fetchSessionMemory,
  formatSessionMemoryTime,
  sessionMemoryErrorMessage,
  sessionMemoryPollInterval,
  sessionMemoryUrl,
  type SessionMemoryFetch,
  type SessionMemoryItem,
  type SessionMemoryKind,
} from './session-memory-model';

const KIND_PRESENTATION: Record<SessionMemoryKind, { label: string; variant: ChipProps['variant'] }> = {
  fact: { label: '事实', variant: 'default' },
  constraint: { label: '约束', variant: 'amber' },
  preference: { label: '偏好', variant: 'purple' },
  rejected: { label: '已排除', variant: 'red' },
};

type PaneState =
  | { key: string | null; phase: 'idle'; data: undefined; error: undefined }
  | { key: string; phase: 'loading'; data: undefined; error: undefined }
  | { key: string; phase: 'ready'; data: Awaited<ReturnType<typeof fetchSessionMemory>>; error: undefined }
  | { key: string; phase: 'degraded'; data: Awaited<ReturnType<typeof fetchSessionMemory>>; error: unknown }
  | { key: string; phase: 'error'; data: undefined; error: unknown };

const isAbort = (error: unknown): boolean =>
  typeof error === 'object'
  && error !== null
  && (error as { name?: unknown }).name === 'AbortError';

const SessionMemoryRow: React.FC<{ item: SessionMemoryItem }> = ({ item }) => {
  const kind = KIND_PRESENTATION[item.kind];
  return (
    <li className="agc-memory-row">
      <div className="agc-memory-row-head">
        <Chip variant={kind.variant}>{kind.label}</Chip>
        <span className="u-num agc-memory-meta">重要度 {item.importance}</span>
      </div>
      <p className="agc-memory-text">{item.text}</p>
      <div className="agc-memory-foot">
        <span className="u-num">{item.sourceTurn === 0 ? '会话开始' : `第 ${item.sourceTurn} 轮`}</span>
        <time dateTime={item.createdAt} title={item.createdAt}>{formatSessionMemoryTime(item.createdAt)}</time>
      </div>
    </li>
  );
};

export const SessionMemoryPane: React.FC<{
  sessionId: string | undefined;
  fetchImpl?: SessionMemoryFetch;
}> = ({ sessionId, fetchImpl }) => {
  const url = sessionId === undefined || sessionId.trim() === '' ? null : sessionMemoryUrl(sessionId);
  const [generation, refresh] = useReducer((value: number) => value + 1, 0);
  const [state, setState] = useState<PaneState>({ key: null, phase: 'idle', data: undefined, error: undefined });

  useEffect(() => {
    if (url === null || sessionId === undefined) {
      setState({ key: null, phase: 'idle', data: undefined, error: undefined });
      return undefined;
    }

    let active = true;
    let latest: Awaited<ReturnType<typeof fetchSessionMemory>> | undefined;
    let controller: AbortController | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setState({ key: url, phase: 'loading', data: undefined, error: undefined });

    const clearTimer = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    };
    const schedule = (delay: number): void => {
      clearTimer();
      if (!active || (typeof document !== 'undefined' && document.hidden)) return;
      timer = setTimeout(() => { void run(); }, delay);
    };
    const run = async (): Promise<void> => {
      if (!active || (typeof document !== 'undefined' && document.hidden)) return;
      clearTimer();
      controller?.abort();
      controller = new AbortController();
      const signal = controller.signal;
      try {
        const data = await fetchSessionMemory(sessionId, signal, fetchImpl);
        if (!active || signal.aborted) return;
        latest = data;
        setState({ key: url, phase: 'ready', data, error: undefined });
        const interval = sessionMemoryPollInterval(data);
        if (interval > 0) schedule(interval);
      } catch (error) {
        if (!active || signal.aborted || isAbort(error)) return;
        setState(latest === undefined
          ? { key: url, phase: 'error', data: undefined, error }
          : { key: url, phase: 'degraded', data: latest, error });
        // A transient read error must not strand an extraction forever. Retry
        // only if the last confirmed server phase was still extracting.
        if (latest?.status === 'extracting') schedule(2_000);
      }
    };
    const onFocus = (): void => { void run(); };
    if (typeof window !== 'undefined') window.addEventListener('focus', onFocus);
    // Avoid issuing the disposable first request in React StrictMode.
    queueMicrotask(() => { if (active) void run(); });

    return () => {
      active = false;
      clearTimer();
      controller?.abort();
      if (typeof window !== 'undefined') window.removeEventListener('focus', onFocus);
    };
  }, [fetchImpl, generation, sessionId, url]);

  const current = state.key === url ? state : { key: url, phase: 'loading' as const, data: undefined, error: undefined };
  const active = current.data;
  const activeError = current.error;
  const isInitialLoading = current.phase === 'loading';

  if (url === null) {
    return <p className="agc-empty">选择一个本机会话后,这里会显示该会话提炼出的短期记忆。</p>;
  }
  if (isInitialLoading) {
    return <p className="agc-empty" aria-live="polite">正在读取会话记忆…</p>;
  }
  if (active === undefined) {
    return (
      <div className="agc-memory-state is-error" role="alert">
        <p>{sessionMemoryErrorMessage(activeError)}</p>
        <Button size="sm" variant="ghost" onClick={refresh}>重试</Button>
      </div>
    );
  }

  const extracting = active.status === 'extracting';
  return (
    <div className="agc-memory">
      <div className="agc-memory-summary">
        <div className="agc-memory-total">
          <strong className="u-num">{active.counts.total}</strong>
          <span>条会话记忆</span>
        </div>
        <Button size="sm" variant="ghost" onClick={refresh}>刷新</Button>
      </div>

      {extracting && (
        <div className="agc-memory-notice" role="status" aria-live="polite">
          <Dot state="running" size={6} />
          <span>正在后台整理最新一轮,当前显示已确认内容。</span>
        </div>
      )}
      {activeError !== undefined && (
        <p className="agc-memory-refresh-error" role="alert">
          刷新未成功,继续显示上次结果。
        </p>
      )}
      {active.skippedSensitive > 0 && (
        <p className="agc-memory-sensitive" role="status">
          有 <span className="u-num">{active.skippedSensitive}</span> 条候选因可能包含敏感信息已跳过。
        </p>
      )}

      {active.items.length === 0 ? (
        <p className="agc-empty">
          {active.status === 'empty'
            ? '本会话还没有已提炼的短期记忆。完成一轮后会在空闲时异步整理。'
            : extracting
              ? '正在整理第一批会话记忆…'
              : '本轮没有形成可保留的事实、约束、偏好或排除项。'}
        </p>
      ) : (
        <ul className="agc-memory-list">
          {active.items.map((item) => <SessionMemoryRow item={item} key={item.id} />)}
        </ul>
      )}
    </div>
  );
};
