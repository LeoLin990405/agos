import React, { useState } from 'react';
import { Dot } from '@/components/ui/Dot';
import { Chip } from '@/components/ui/Chip';
import { Badge } from '@/components/ui/Badge';
import { StateLamp } from '@/design-system/tokens';

export interface LineageJobItem {
  id: string;
  name: string;
  role: string;
  model: string;
  duration: string;
  state: StateLamp;
  badgeText: string;
  metrics: { label: string; value: string }[];
  targetPrompt: string;
  logs: string[];
  defaultOpen?: boolean;
}

export interface LineageBatchTreeProps {
  batchId: string;
  title: string;
  categoryTag: string;
  completedSummary: string;
  duration: string;
  jobs: LineageJobItem[];
  isRunningBranch?: boolean;
}

export const LineageJobTree: React.FC<LineageBatchTreeProps> = ({
  batchId,
  title,
  categoryTag,
  completedSummary,
  duration,
  jobs,
  isRunningBranch = false,
}) => {
  const [openIds, setOpenIds] = useState<Record<string, boolean>>(() => {
    const init: Record<string, boolean> = {};
    jobs.forEach((j) => {
      if (j.defaultOpen) init[j.id] = true;
    });
    return init;
  });

  const toggleJob = (id: string) => {
    setOpenIds((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  return (
    <div className="batch-tree-group">
      <div className="batch-group-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <Dot state={isRunningBranch ? 'running' : 'done'} />
          <span style={{ fontWeight: 700, fontSize: '13px' }}>
            批次 #{batchId}: {title}
          </span>
          <Chip variant="amber">{categoryTag}</Chip>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', fontSize: '11.5px' }}>
          <span
            className="u-num"
            style={isRunningBranch ? { color: 'var(--state-running)', fontWeight: 700 } : { color: 'var(--state-done)', fontWeight: 700 }}
          >
            {completedSummary}
          </span>
          <span className="u-num" style={{ color: 'var(--text-tertiary)' }}>
            耗时 {duration}
          </span>
        </div>
      </div>

      <div className={`tree-node-circuit ${isRunningBranch ? 'is-running-branch' : ''}`}>
        {jobs.map((job) => {
          const isOpen = !!openIds[job.id];
          return (
            <div key={job.id} className="job-card-wrap">
              <div
                className="lineage-job-card"
                style={
                  job.state === 'running'
                    ? { borderColor: 'var(--state-running-border)' }
                    : job.state === 'failed'
                    ? { borderColor: 'var(--state-failed-border)' }
                    : undefined
                }
                onClick={() => toggleJob(job.id)}
              >
                <div className="lineage-card-header">
                  <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                    <span className="job-expand-icon" style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-tertiary)' }}>
                      {isOpen ? '▾' : '▸'}
                    </span>
                    <Dot state={job.state} />
                    <span
                      style={{
                        fontWeight: 600,
                        fontFamily: 'var(--font-mono)',
                        color: job.state === 'running' ? 'var(--state-running)' : job.state === 'failed' ? 'var(--state-failed)' : 'inherit',
                      }}
                    >
                      {job.name}
                    </span>
                    <Chip active={job.state === 'running'}>{job.role}</Chip>
                    <Chip>{job.model}</Chip>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                    <span
                      className="u-num"
                      style={job.state === 'running' ? { color: 'var(--state-running)', fontWeight: 700 } : job.state === 'failed' ? { color: 'var(--state-failed)', fontWeight: 700 } : { color: 'var(--text-tertiary)' }}
                    >
                      {job.duration}
                    </span>
                    <Badge state={job.state}>{job.badgeText}</Badge>
                  </div>
                </div>

                {/* 3段级联展开详情 */}
                {isOpen && (
                  <div className="job-cascade-detail is-open">
                    {/* 段 1: 指标 */}
                    <div style={{ display: 'flex', gap: '20px', fontSize: '12px', color: 'var(--text-secondary)' }}>
                      {job.metrics.map((m, i) => (
                        <div key={i}>
                          <span className="u-microlabel">{m.label}:</span> <span className="u-num">{m.value}</span>
                        </div>
                      ))}
                    </div>

                    {/* 段 2: 委派任务目标 */}
                    <div style={{ backgroundColor: 'var(--bg-layer-1)', borderRadius: '6px', padding: '10px 14px', fontSize: '12px', color: 'var(--text-secondary)', border: '1px solid var(--border-dim)' }}>
                      <div className="u-microlabel" style={{ marginBottom: '4px' }}>委派任务目标:</div>
                      {job.targetPrompt}
                    </div>

                    {/* 段 3: 产物与日志 */}
                    {job.logs.length > 0 && (
                      <div style={{ fontFamily: 'var(--font-mono)', fontSize: '11.5px', color: 'var(--text-tertiary)', backgroundColor: 'var(--code-bg)', padding: '10px 14px', borderRadius: '6px' }}>
                        {job.logs.map((l, i) => (
                          <div key={i} style={{ color: l.includes('SUCCESS') ? '#34d399' : l.includes('FORBIDDEN') || l.includes('DENIED') ? '#fb7185' : 'inherit' }}>
                            {l}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};
