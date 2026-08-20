/**
 * ProgressDock —— 计划进度坞(P0-2,Manus Task progress 叠卡)。
 *
 * 全局汇总所有运行中的 swarm 批次;数据源是 telemetry 的 /api/swarm/progress
 * (经 live.ts 的 swarmProgressStore 派生,零编造)。流内单批次详情由
 * SwarmBatchCard 负责,坞不重复它的职责。无运行中批次时不渲染。
 * 挂载位置:ChatPage 的 CommandDeck 正上方、同宽容器内。
 */
import React, { useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Dot } from '@/components/ui/Dot';
import { swarmProgressStore } from '@/stores/live';
import '@/design-system/progress-dock.css';

export const ProgressDock: React.FC = () => {
  const summary = useSyncExternalStore(swarmProgressStore.subscribe, swarmProgressStore.getSnapshot);
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
  const label = batches.length === 1 && first !== undefined
    ? first.label
    : `${batches.length} 个批次运行中`;

  return (
    <div className="progress-dock" role="status" aria-label="计划进度坞">
      <button
        type="button"
        className="progress-dock__row"
        aria-expanded={expanded}
        onClick={() => setExpanded((v) => !v)}
      >
        <Dot state="running" />
        <span className="progress-dock__label progress-dock__sweep" title={label}>{label}</span>
        <span className="progress-dock__count u-num">{done}/{total}</span>
        <svg
          className={`progress-dock__chevron ${expanded ? 'is-open' : ''}`}
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
          {batches.map((b) => (
            <div key={b.callId} className="progress-dock__item">
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
                  style={{ width: `${b.total > 0 ? Math.min(100, (b.done / b.total) * 100) : 0}%` }}
                />
              </div>
              {b.failed > 0 && (
                <span className="progress-dock__item-failed u-num" title={`${b.failed} 项未成功`}>
                  {b.failed}
                </span>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};
