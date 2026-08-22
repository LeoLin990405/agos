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
        <div className="batch-group-title">
          <Dot state={isRunningBranch ? 'running' : 'done'} />
          <span className="batch-group-name">
            批次 #{batchId}: {title}
          </span>
          <Chip variant="amber">{categoryTag}</Chip>
        </div>
        <div className="batch-group-meta">
          <span className={`u-num batch-group-summary${isRunningBranch ? ' is-live' : ' is-done'}`}>
            {completedSummary}
          </span>
          <span className="u-num surface-quiet">
            耗时 {duration}
          </span>
        </div>
      </div>

      {jobs.length > 0 && (
        <div className="viz-segs" role="img" aria-label={completedSummary}>
          {jobs.map((job) => (
            <span key={job.id} className={`viz-seg is-${job.state}`} title={`${job.name} ${job.badgeText}`} />
          ))}
        </div>
      )}

      <div className={`tree-node-circuit ${isRunningBranch ? 'is-running-branch' : ''}`}>
        {jobs.map((job) => {
          const isOpen = !!openIds[job.id];
          return (
            <div key={job.id} className="job-card-wrap">
              <div
                className={`lineage-job-card is-${job.state}${isOpen ? ' is-open' : ''}`}
                onClick={() => toggleJob(job.id)}
              >
                <div className="lineage-card-header">
                  <div className="lineage-card-lead">
                    <span className={`job-expand-icon${isOpen ? ' is-open' : ''}`} aria-hidden="true" />
                    <Dot state={job.state} />
                    <span className="lineage-job-name">{job.name}</span>
                    <Chip active={job.state === 'running'}>{job.role}</Chip>
                    <Chip>{job.model}</Chip>
                  </div>
                  <div className="lineage-card-end">
                    <span className="u-num lineage-job-dur">{job.duration}</span>
                    <Badge state={job.state}>{job.badgeText}</Badge>
                  </div>
                </div>

                {isOpen && (
                  <div className="job-cascade-detail is-open">
                    <div className="lineage-job-metrics">
                      {job.metrics.map((m, i) => (
                        <div key={i}>
                          <span className="u-microlabel">{m.label}:</span> <span className="u-num">{m.value}</span>
                        </div>
                      ))}
                    </div>

                    <div className="lineage-job-target">
                      <div className="u-microlabel">委派任务目标:</div>
                      {job.targetPrompt}
                    </div>

                    {job.logs.length > 0 && (
                      <div className="lineage-job-logs">
                        {job.logs.map((l, i) => (
                          <div
                            key={i}
                            className={
                              l.includes('SUCCESS')
                                ? 'is-ok'
                                : l.includes('FORBIDDEN') || l.includes('DENIED')
                                  ? 'is-bad'
                                  : undefined
                            }
                          >
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
