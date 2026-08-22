import React from 'react';
import { Dot } from '@/components/ui/Dot';
import { Chip } from '@/components/ui/Chip';
import { StateLamp } from '@/design-system/tokens';

export interface SubagentRowData {
  idx: string;
  name: string;
  role: string;
  provider: string;
  time: string;
  state: StateLamp;
  stateLabel: string;
}

export interface SwarmBatchCardProps {
  batchId: string;
  title: string;
  completedCount: number;
  totalCount: number;
  isRunning?: boolean;
  rows: SubagentRowData[];
}

export const SwarmBatchCard: React.FC<SwarmBatchCardProps> = ({
  batchId,
  title,
  completedCount,
  totalCount,
  isRunning = true,
  rows,
}) => {
  const ratio = Math.min(1, Math.max(0, completedCount / totalCount));
  const percentage = (ratio * 100).toFixed(1);

  return (
    <div className={`u-swarm-card ${isRunning ? 'is-running' : ''}`}>
      <div className="u-swarm-header">
        <div className="u-swarm-title-wrap">
          <Dot state={isRunning ? 'running' : 'done'} />
          <span className="u-swarm-title">
            Swarm 批次任务 #{batchId}: {title}
          </span>
        </div>
        <div className="u-swarm-stats">
          <span className="u-num u-swarm-stats-num">
            {completedCount} / {totalCount}
          </span>{' '}
          <span className="u-swarm-time">完成 ({percentage}%)</span>
        </div>
      </div>

      <div className="u-swarm-bar-wrap">
        {rows.length > 0 ? (
          <div
            className="viz-segs u-swarm-segs"
            role="img"
            aria-label={`${completedCount} / ${totalCount} 完成`}
          >
            {rows.map((row) => (
              <span
                key={row.idx}
                className={`viz-seg is-${row.state}`}
                title={`${row.name} ${row.stateLabel}`}
              />
            ))}
          </div>
        ) : (
          <div className="u-swarm-bar">
            <div
              className="u-swarm-fill"
              style={{ ['--u-p' as string]: ratio }}
            />
          </div>
        )}
      </div>

      {/* 子代理列表 */}
      <div className="u-swarm-list">
        {rows.map((row) => (
          <div
            key={row.idx}
            className={`u-swarm-row${row.state === 'running' ? ' is-running' : row.state === 'failed' ? ' is-failed' : ''}`}
          >
            <span className="u-swarm-idx u-num">{row.idx}</span>
            <Dot state={row.state} />
            <span className="u-swarm-name">{row.name}</span>
            <Chip active={row.state === 'running'}>{row.role}</Chip>
            <Chip active={row.state === 'running'}>{row.provider}</Chip>
            <span className="u-swarm-time u-num">
              {row.time}
            </span>
            <span className={`u-swarm-state-text state--${row.state}`}>
              {row.stateLabel}
            </span>
          </div>
        ))}
      </div>

    </div>
  );
};
