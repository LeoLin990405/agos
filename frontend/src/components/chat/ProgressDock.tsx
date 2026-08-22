/**
 * ProgressDock —— 计划进度坞(P0-2,Manus Task progress 叠卡)。
 *
 * 全局汇总仍未结清、或已结清但仍有失败行的 swarm 批次。
 * 订阅坞自己读 /api/swarm/progress(2s),不改 stores 里 10s telemetry。
 * 流内单批次详情由 SwarmBatchCard 负责。无批次时不渲染。
 */
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Dot } from '@/components/ui/Dot';
import {
  deriveProgressDockFromCalls,
  hasControlledProgressSummary,
  type ProgressDockSummary,
} from '@/components/chat/progress-dock-model';
import '@/design-system/progress-dock.css';

export interface ProgressDockProps {
  /** Presence makes this instance controlled; `undefined` intentionally renders nothing. */
  summary?: ProgressDockSummary;
  onSelectBatch?: (batchId: string) => void;
}

const SWARM_DOCK_POLL_MS = 2_000;

const flattenProgressCalls = (body: Record<string, unknown>): { callId: string; description?: string; rows?: readonly Record<string, unknown>[] }[] => {
  const source = (body['calls'] ?? body) as Record<string, unknown>;
  if (typeof source !== 'object' || source === null) return [];
  return Object.entries(source)
    .filter(([, value]) => typeof value === 'object' && value !== null)
    .map(([callId, value]) => ({ callId, ...(value as Record<string, unknown>) }));
};

const useSwarmProgressDock = (): ProgressDockSummary | undefined => {
  const [summary, setSummary] = useState<ProgressDockSummary | undefined>(undefined);

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | undefined;

    const schedule = (): void => {
      if (!active || (typeof document !== 'undefined' && document.hidden)) return;
      timer = setTimeout(() => { void run(); }, SWARM_DOCK_POLL_MS);
    };

    const run = async (): Promise<void> => {
      if (!active) return;
      controller?.abort();
      controller = new AbortController();
      const signal = controller.signal;
      try {
        const response = await fetch('/api/swarm/progress', { signal });
        if (!response.ok || !active || signal.aborted) {
          if (active && !signal.aborted) schedule();
          return;
        }
        const body = await response.json() as Record<string, unknown>;
        if (!active || signal.aborted) return;
        setSummary(deriveProgressDockFromCalls(flattenProgressCalls(body)));
      } catch (error) {
        if (!active || (error instanceof DOMException && error.name === 'AbortError')) return;
      }
      schedule();
    };

    const onVisible = (): void => {
      if (typeof document !== 'undefined' && !document.hidden) void run();
    };

    void run();
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisible);
    return () => {
      active = false;
      controller?.abort();
      if (timer !== undefined) clearTimeout(timer);
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  return summary;
};

const SubscribedProgressDock: React.FC<Omit<ProgressDockProps, 'summary'>> = (props) => {
  const summary = useSwarmProgressDock();
  return <ProgressDockView {...props} summary={summary} />;
};

const ProgressDockView: React.FC<{
  summary: ProgressDockSummary | undefined;
  onSelectBatch?: (batchId: string) => void;
}> = ({
  summary,
  onSelectBatch,
}) => {
  const [expanded, setExpanded] = useState(false);
  const listRef = useRef<HTMLDivElement | null>(null);
  const [listHeight, setListHeight] = useState(0);

  // 真实高度展开:每次数据/展开态变化后量一次内容高度
  useLayoutEffect(() => {
    if (listRef.current !== null) setListHeight(listRef.current.scrollHeight);
  }, [summary, expanded]);

  if (summary === undefined) return null;

  const { batches, done, total } = summary;
  const first = batches[0];
  const anyOpen = batches.some((batch) => batch.done + batch.failed < batch.total);
  const anyFailed = batches.some((batch) => batch.failed > 0);
  const directSelect = onSelectBatch !== undefined && first !== undefined && batches.length === 1;
  const label = batches.length === 1 && first !== undefined
    ? first.label
    : anyOpen
      ? `${batches.length} 个批次运行中`
      : `${batches.length} 个批次`;

  return (
    <div className="progress-dock" role="status" aria-label="计划进度坞">
      <button
        type="button"
        className="progress-dock__row"
        aria-expanded={directSelect ? undefined : expanded}
        aria-label={directSelect ? `打开批次 ${label}` : undefined}
        onClick={() => {
          if (directSelect) {
            onSelectBatch(first.callId);
            return;
          }
          setExpanded((v) => !v);
        }}
      >
        <Dot state={anyOpen ? 'running' : anyFailed ? 'failed' : 'done'} />
        <span className="progress-dock__label" title={label}>{label}</span>
        <span
          className="progress-dock__summary-bar viz-track"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={total}
          aria-valuenow={done}
          aria-label={`${done}/${total} 完成`}
        >
          <span className="viz-fill" style={{ ['--u-p' as string]: total > 0 ? Math.min(1, done / total) : 0 }} />
        </span>
        <span className="progress-dock__count u-num">{done}/{total}</span>
        <svg
          className={`progress-dock__chevron ${directSelect ? 'is-link' : expanded ? 'is-open' : ''}`}
          width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"
        >
          <path
            d="M2.5 4.5 L6 8 L9.5 4.5"
            fill="none" stroke="currentColor" strokeWidth="1.5"
            strokeLinecap="round" strokeLinejoin="round"
          />
        </svg>
      </button>

      <div
        className="progress-dock__list-clip"
        style={{ height: expanded ? listHeight : 0, opacity: expanded ? 1 : 0 }}
        aria-hidden={!expanded}
      >
        <div ref={listRef} className="progress-dock__list">
          {batches.map((b) => {
            const content = <>
              <span className="progress-dock__item-label" title={b.label}>{b.label}</span>
              <span className="progress-dock__item-count u-num">{b.done}/{b.total}</span>
              <div
                className="progress-dock__bar"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={b.total}
                aria-valuenow={b.done}
                aria-label={`${b.label}:${b.done}/${b.total} 完成`}
              >
                <div
                  className="progress-dock__fill"
                  style={{ ['--u-p' as string]: b.total > 0 ? Math.min(1, b.done / b.total) : 0 }}
                />
              </div>
              {b.failed > 0 && (
                <span className="progress-dock__item-failed u-num" title={`${b.failed} 项未成功`}>
                  {b.failed}
                </span>
              )}
            </>;
            return onSelectBatch === undefined ? (
              <div key={b.callId} className="progress-dock__item">{content}</div>
            ) : (
              <button
                key={b.callId}
                type="button"
                className="progress-dock__item progress-dock__item-button"
                aria-label={`打开批次 ${b.label}`}
                onClick={() => onSelectBatch(b.callId)}
              >
                {content}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
};

/**
 * Omit `summary` to subscribe to local swarm progress. Passing the prop, including
 * `summary={undefined}`, selects controlled mode and never falls back to swarm.
 */
export const ProgressDock: React.FC<ProgressDockProps> = (props) => (
  hasControlledProgressSummary(props)
    ? <ProgressDockView summary={props.summary} onSelectBatch={props.onSelectBatch} />
    : <SubscribedProgressDock onSelectBatch={props.onSelectBatch} />
);
