import React from 'react';
import { Button } from '@/components/ui/Button';
import { Dot } from '@/components/ui/Dot';
import { formatRelative } from '@/lib/time';
import type { FleetBatch, FleetRunStatus } from '@/stores/live';
import { fleetBatchLamp, fleetRunLamp } from '@/components/console/fleet-model';
import './BatchList.css';

type FleetRun = NonNullable<FleetBatch['runs']>[number];

const RUN_LABELS: Record<FleetRunStatus, string> = {
  queued: '等待中',
  waking: '唤醒中',
  running: '运行中',
  detached: '已断连，等待重贴',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
  interrupted: '已中断',
  lost: '工作区丢失',
};

const TERMINAL = new Set<FleetRunStatus>(['completed', 'failed', 'cancelled', 'interrupted', 'lost']);
const BATCH_LABEL: Record<FleetBatch['status'], string> = {
  running: '运行中',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
};

export function formatRunDuration(ms: number | null): string | undefined {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return undefined;
  if (ms < 1_000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(ms < 10_000 ? 1 : 0)} 秒`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.floor((ms % 60_000) / 1_000);
  return seconds > 0 ? `${minutes} 分 ${seconds} 秒` : `${minutes} 分`;
}

export interface BatchListProps {
  batches: FleetBatch[];
  selectedBatchId?: string;
  selectedRunId?: string;
  onSelectBatch: (batchId: string) => void;
  onSelectRun: (run: FleetRun) => void;
  onCancelBatch?: (batchId: string) => void;
  onCancelRun?: (run: FleetRun) => void;
  cancelling?: string;
}

const RunRow: React.FC<{
  run: FleetRun;
  selected: boolean;
  cancelling?: string;
  onSelect: () => void;
  onCancel?: () => void;
}> = ({ run, selected, cancelling, onSelect, onCancel }) => {
  const duration = formatRunDuration(run.ms);
  const active = !TERMINAL.has(run.status);
  return (
    <li className={`batch-list__run${selected ? ' is-selected' : ''}`}>
      <button type="button" className="batch-list__run-main" onClick={onSelect}>
        <span aria-hidden="true"><Dot state={fleetRunLamp(run.status)} size={7} /></span>
        <span className="batch-list__run-copy">
          <span className="batch-list__run-title">
            <strong className="u-num">#{run.index}</strong>
            <span>{RUN_LABELS[run.status]}</span>
            <span>{run.host}</span>
            {duration && <span className="u-num">{duration}</span>}
          </span>
          {run.prompt && <span className="batch-list__prompt">{run.prompt}</span>}
          {run.error && <span className="batch-list__error">{run.error}</span>}
        </span>
      </button>
      {active && onCancel && (
        <Button
          variant="ghost"
          size="sm"
          disabled={cancelling === run.runId}
          onClick={onCancel}
        >
          {cancelling === run.runId ? '取消中…' : '取消'}
        </Button>
      )}
    </li>
  );
};

export const BatchList: React.FC<BatchListProps> = ({
  batches,
  selectedBatchId,
  selectedRunId,
  onSelectBatch,
  onSelectRun,
  onCancelBatch,
  onCancelRun,
  cancelling,
}) => {
  if (batches.length === 0) {
    return <div className="batch-list__empty">暂无 Fleet 批次。派发后会在这里显示真实运行状态。</div>;
  }
  return (
    <div className="batch-list">
      {batches.map((batch) => {
        const selected = batch.batchId === selectedBatchId;
        const running = batch.status === 'running';
        return (
          <article key={batch.batchId} className={`batch-list__batch${selected ? ' is-selected' : ''}`}>
            <div className="batch-list__batch-head">
              <button
                type="button"
                className="batch-list__batch-select"
                aria-expanded={selected}
                onClick={() => onSelectBatch(batch.batchId)}
              >
                <span aria-hidden="true"><Dot state={fleetBatchLamp(batch.status)} size={8} /></span>
                <span className="batch-list__batch-copy">
                  <strong>{batch.label || batch.batchId}</strong>
                  <span>
                    {BATCH_LABEL[batch.status]} · <span className="u-num">{batch.counts.completed}/{batch.counts.total}</span> 完成
                    {batch.counts.failed > 0 && <> · <span>{batch.counts.failed} 失败</span></>}
                    {batch.createdAt !== null && <> · {formatRelative(batch.createdAt)}</>}
                  </span>
                </span>
                <span className="batch-list__chevron" aria-hidden="true">{selected ? '⌄' : '›'}</span>
              </button>
              {running && onCancelBatch && (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={cancelling === batch.batchId}
                  onClick={() => onCancelBatch(batch.batchId)}
                >
                  {cancelling === batch.batchId ? '取消中…' : '取消批次'}
                </Button>
              )}
            </div>
            {selected && (
              Array.isArray(batch.runs) && batch.runs.length > 0 ? (
                <ul className="batch-list__runs">
                  {batch.runs.map((run) => (
                    <RunRow
                      key={run.runId}
                      run={run}
                      selected={run.runId === selectedRunId}
                      cancelling={cancelling}
                      onSelect={() => onSelectRun(run)}
                      onCancel={onCancelRun && !TERMINAL.has(run.status) ? () => onCancelRun(run) : undefined}
                    />
                  ))}
                </ul>
              ) : (
                <div className="batch-list__empty is-inline">此批次尚未返回 run 明细。</div>
              )
            )}
          </article>
        );
      })}
    </div>
  );
};
