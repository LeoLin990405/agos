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
  civStats?: {
    passed: string;
    vetoed: number;
    gateState: string;
  };
}

export const SwarmBatchCard: React.FC<SwarmBatchCardProps> = ({
  batchId,
  title,
  completedCount,
  totalCount,
  isRunning = true,
  rows,
  civStats,
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
          <span className="u-num" style={{ fontWeight: 800, color: 'var(--state-running)', fontSize: '13px' }}>
            {completedCount} / {totalCount}
          </span>{' '}
          <span style={{ color: 'var(--text-tertiary)' }}>完成 ({percentage}%)</span>
        </div>
      </div>

      {/* 分段刻度进度条 */}
      <div className="u-swarm-bar-wrap">
        <div className="u-swarm-bar">
          <div
            className="u-swarm-fill"
            style={{ ['--u-p' as string]: ratio }}
          />
        </div>
      </div>

      {/* 子代理列表 */}
      <div className="u-swarm-list">
        {rows.map((row) => (
          <div
            key={row.idx}
            className="u-swarm-row"
            style={
              row.state === 'running'
                ? { backgroundColor: 'var(--state-running-bg)' }
                : row.state === 'failed'
                ? { backgroundColor: 'var(--state-failed-bg)' }
                : undefined
            }
          >
            <span className="u-swarm-idx u-num">{row.idx}</span>
            <Dot state={row.state} />
            <span
              className="u-swarm-name"
              style={
                row.state === 'running'
                  ? { color: 'var(--state-running)', fontWeight: 700 }
                  : row.state === 'failed'
                  ? { color: 'var(--state-failed)', fontWeight: 700 }
                  : undefined
              }
            >
              {row.name}
            </span>
            <Chip active={row.state === 'running'}>{row.role}</Chip>
            <Chip active={row.state === 'running'}>{row.provider}</Chip>
            <span
              className="u-swarm-time u-num"
              style={
                row.state === 'running'
                  ? { color: 'var(--state-running)', fontWeight: 600 }
                  : row.state === 'failed'
                  ? { color: 'var(--state-failed)', fontWeight: 600 }
                  : undefined
              }
            >
              {row.time}
            </span>
            <span className={`u-swarm-state-text state--${row.state}`}>
              {row.stateLabel}
            </span>
          </div>
        ))}
      </div>

      {/* CivStrip 治理统计底条 */}
      {civStats && (
        <div className="u-civstrip">
          <div className="u-civ-metric is-pass">
            <span className="u-microlabel">安全巡检通过:</span>
            <span className="val u-num">{civStats.passed}</span>
          </div>
          <div className={`u-civ-metric ${civStats.vetoed > 0 ? 'is-veto' : 'is-zero'}`}>
            <span className="u-microlabel">策略否决:</span>
            <span className="val u-num">{civStats.vetoed}</span>
          </div>
          <div className="u-civ-metric" style={{ color: 'var(--accent-amber)' }}>
            <span className="u-microlabel">晋升门:</span>
            <span className="val">{civStats.gateState}</span>
          </div>
        </div>
      )}
    </div>
  );
};
