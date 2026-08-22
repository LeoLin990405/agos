import React, { useMemo, useState, useSyncExternalStore } from 'react';
import { SymMonitor } from '@/components/lineage/SymMonitor';
import { LineageJobTree } from '@/components/lineage/LineageJobTree';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { Chip } from '@/components/ui/Chip';
import { Button } from '@/components/ui/Button';
import { telemetryStore } from '@/stores/live';
import { useResource } from '@/lib/useResource';
import {
  foldLineageHistory,
  type FoldedLineageCall,
  type LineageHistoryRecord,
} from './lineage-history';
import type { LineageJobItem } from '@/components/lineage/LineageJobTree';
import type { StateLamp } from '@/design-system/tokens';

const LAMP: Record<string, { lamp: StateLamp; label: string }> = {
  queued: { lamp: 'queued', label: '等待中' },
  running: { lamp: 'running', label: '处理中' },
  completed: { lamp: 'done', label: '已完成' },
  failed: { lamp: 'failed', label: '未成功' },
  aborted: { lamp: 'failed', label: '已中止' },
};

interface RealBatch {
  callId: string;
  parentSessionId: string | undefined;
  rows: Record<string, unknown>[];
}

interface LineageHistoryResponse {
  day: string;
  records: LineageHistoryRecord[];
  truncated: boolean;
  error?: string;
}

function fmtDur(ms: unknown): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '未采集';
  if (ms < 1_000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1_000);
  return `${minutes}m ${seconds}s`;
}

function formatDay(value: Date = new Date()): string {
  const part = (n: number): string => String(n).padStart(2, '0');
  return `${value.getFullYear()}${part(value.getMonth() + 1)}${part(value.getDate())}`;
}

function dayForInput(day: string): string {
  return `${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6, 8)}`;
}

function dayFromInput(day: string): string {
  return day.replaceAll('-', '');
}

function shiftDay(day: string, offset: number): string {
  const year = Number(day.slice(0, 4));
  const month = Number(day.slice(4, 6));
  const date = Number(day.slice(6, 8));
  const value = new Date(year, month - 1, date, 12);
  value.setDate(value.getDate() + offset);
  return formatDay(value);
}

function formatAt(at: number | undefined): string {
  if (at === undefined) return '未采集';
  return new Date(at).toLocaleString('zh-CN', { hour12: false });
}

function toJob(row: Record<string, unknown>): LineageJobItem {
  const status = String(row['status'] ?? '');
  const lamp = LAMP[status] ?? { lamp: 'queued' as const, label: '未采集' };
  const roleBits = [
    row['role'] != null ? String(row['role']) : '',
    row['forked'] != null && row['forked'] !== '' ? `fork ${String(row['forked'])}` : '',
    typeof row['depth'] === 'number' && row['depth'] > 1 ? `depth ${String(row['depth'])}` : '',
  ].filter(Boolean).join(' ');
  const metrics: { label: string; value: string }[] = [];
  if (typeof row['queuePosition'] === 'number') metrics.push({ label: '队列位次', value: `#${row['queuePosition']}` });
  if (row['host'] != null) metrics.push({ label: '主机', value: String(row['host']) });
  if (row['provider'] != null) metrics.push({ label: 'Provider', value: String(row['provider']) });
  const index = row['index'] != null ? String(row['index']) : '';
  return {
    id: String(row['agentId'] ?? index),
    name: String(row['item'] ?? row['type'] ?? (index !== '' ? `#${index}` : '未采集')).slice(0, 80),
    role: roleBits !== '' ? roleBits : String(row['type'] ?? '未采集'),
    model: String(row['model'] ?? '未采集'),
    duration: fmtDur(row['elapsedMs']),
    state: lamp.lamp,
    badgeText: lamp.label,
    metrics,
    targetPrompt: String(row['item'] ?? '未采集'),
    logs: row['error'] != null ? [String(row['error'])] : [],
    defaultOpen: status === 'failed',
  };
}

const QuietState: React.FC<{ title: string; detail: React.ReactNode }> = ({ title, detail }) => (
  <div
    role="status"
    className="surface-empty"
  >
    <div className="surface-empty-title">{title}</div>
    <div>{detail}</div>
  </div>
);

function terminalSummary(rows: Record<string, unknown>[]): string {
  const terminal = rows.filter((row) => ['completed', 'failed', 'aborted'].includes(String(row['status'] ?? ''))).length;
  return `${terminal}/${rows.length} 已结束`;
}

const HistoryCall: React.FC<{ call: FoldedLineageCall }> = ({ call }) => {
  const statusLabel = call.state === 'unclosed'
    ? '未收尾'
    : call.state === 'orphaned-end'
      ? '起始记录缺席'
      : '已结束';
  return (
    <details
      className="history-call"
    >
      <summary>
        <span className="surface-cluster">
          <strong className="u-num">{call.callId}</strong>
          <Chip variant={call.state === 'unclosed' ? 'amber' : 'default'}>{statusLabel}</Chip>
          <span className="u-num surface-quiet">
            {terminalSummary(call.rows)}
          </span>
        </span>
      </summary>
      <div className="history-call-body">
        <div className="surface-cluster surface-body">
          <span>开始: <span className="u-num">{formatAt(call.startedAt)}</span></span>
          <span>结束: <span className="u-num">{formatAt(call.endedAt)}</span></span>
          <span>耗时: <span className="u-num">{call.state === 'unclosed' ? '未收尾' : fmtDur(call.durationMs)}</span></span>
          <span>父会话: <span className="u-num">{call.parentSessionId ?? '未采集'}</span></span>
        </div>
        {call.rows.length === 0 ? (
          <div className="surface-quiet">该快照没有子任务行。</div>
        ) : (
          <div className="telemetry-table-wrap">
            <table className="telemetry-table">
              <thead>
                <tr><th>子任务</th><th>状态</th><th>模型</th><th>主机</th></tr>
              </thead>
              <tbody>
                {call.rows.map((row, index) => (
                  <tr key={`${String(row['agentId'] ?? row['index'] ?? index)}:${index}`}>
                    <td>{String(row['item'] ?? row['type'] ?? row['agentId'] ?? row['index'] ?? '未采集').slice(0, 100)}</td>
                    <td>{LAMP[String(row['status'] ?? '')]?.label ?? '未采集'}</td>
                    <td>{String(row['model'] ?? '未采集')}</td>
                    <td>{String(row['host'] ?? '未采集')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </details>
  );
};

export const LineageView: React.FC = () => {
  const [tab, setTab] = useState<'live' | 'history'>('live');
  const [day, setDay] = useState(() => formatDay());
  const telemetry = useSyncExternalStore(telemetryStore.subscribe, telemetryStore.getSnapshot);
  const history = useResource<LineageHistoryResponse>({
    url: tab === 'history' ? `/api/swarm/history?day=${day}&limit=200` : null,
    enabled: tab === 'history',
  });

  const realBatches = useMemo<RealBatch[]>(() => (telemetry.progress?.calls ?? []).map((call) => ({
    callId: String(call['callId'] ?? ''),
    parentSessionId: typeof call['parentSessionId'] === 'string' ? call['parentSessionId'] : undefined,
    rows: Array.isArray(call['rows']) ? call['rows'] as Record<string, unknown>[] : [],
  })).filter((batch) => batch.callId !== ''), [telemetry.progress]);
  const currentHistory = history.data?.day === day ? history.data : undefined;
  const foldedHistory = useMemo(
    () => foldLineageHistory(currentHistory?.records ?? []),
    [currentHistory?.records],
  );
  const runningCount = realBatches.reduce(
    (count, batch) => count + batch.rows.filter((row) => row['status'] === 'running').length,
    0,
  );
  const today = formatDay();

  return (
    <div className="surface-page">
      <div className="surface-header is-center">
        <div>
          <h2 className="surface-title">智能体任务谱系与血缘拓扑</h2>
          <p className="surface-lede">
            数据源: <code>{tab === 'live' ? '/api/swarm/progress' : '/api/swarm/history'}</code>
          </p>
        </div>
        <SegmentedControl value={tab} onChange={setTab} options={[
          { value: 'live', label: telemetry.progress === undefined ? '实时谱系' : `实时谱系 (${realBatches.length})` },
          { value: 'history', label: currentHistory === undefined ? '历史档案' : `历史档案 (${foldedHistory.length})` },
        ]} />
      </div>

      {tab === 'live' && (
        <div className="surface-page">
          {telemetry.at === 0 && (
            <QuietState title="实时谱系尚未采集" detail={<>正在等待 <code>/api/swarm/progress</code>。</>} />
          )}
          {telemetry.at > 0 && telemetry.progress === undefined && (
            <QuietState title="实时谱系不可用" detail={<><code>/api/swarm/progress</code> 尚未返回可用数据。</>} />
          )}
          {telemetry.progress !== undefined && (
            <>
              {runningCount > 0 && <SymMonitor runningCount={runningCount} />}
              {realBatches.length === 0 && (
                <QuietState title="谱系待机" detail="接口返回空调用集；当前没有可展示的 swarm 派单。" />
              )}
              {realBatches.map((batch) => {
                const completed = batch.rows.filter((row) => row['status'] === 'completed').length;
                const percent = batch.rows.length > 0 ? Math.round((completed / batch.rows.length) * 100) : 0;
                return (
                  <LineageJobTree
                    key={batch.callId}
                    batchId={batch.callId.startsWith('host:') ? batch.callId.slice(5) : batch.callId}
                    title={batch.parentSessionId !== undefined ? `父会话 ${batch.parentSessionId}` : batch.callId}
                    categoryTag={batch.callId.startsWith('host:') ? '宿主委派' : '未采集'}
                    completedSummary={`${completed}/${batch.rows.length} 完成 (${percent}%)`}
                    duration="未采集"
                    isRunningBranch={batch.rows.some((row) => row['status'] === 'running')}
                    jobs={batch.rows.map(toJob)}
                  />
                );
              })}
            </>
          )}
        </div>
      )}

      {tab === 'history' && (
        <div className="surface-stack">
          <div className="surface-cluster">
            <Button variant="ghost" size="sm" onClick={() => setDay((value) => shiftDay(value, -1))}>前一天</Button>
            <input
              type="date"
              aria-label="谱系历史日期"
              className="form-input"
              max={dayForInput(today)}
              value={dayForInput(day)}
              onChange={(event) => {
                const next = dayFromInput(event.target.value);
                if (/^\d{8}$/.test(next) && next <= today) setDay(next);
              }}
            />
            <Button variant="ghost" size="sm" disabled={day >= today} onClick={() => setDay((value) => shiftDay(value, 1))}>后一天</Button>
            <Button variant="ghost" size="sm" onClick={() => history.refresh()}>重新读取</Button>
          </div>

          {currentHistory === undefined && history.status !== 'error' && history.status !== 'degraded' && (
            <QuietState title="正在读取谱系历史" detail={`日期: ${dayForInput(day)}`} />
          )}
          {currentHistory === undefined && (history.status === 'error' || history.status === 'degraded') && (
            <QuietState
              title="谱系历史读取失败"
              detail={<><code>/api/swarm/history</code> 未答复{history.error?.status !== undefined ? ` (HTTP ${history.error.status})` : ''}: {history.error?.message ?? '请求失败'}</>}
            />
          )}

          {currentHistory !== undefined && (
            <>
              {(history.status === 'degraded' || currentHistory.error !== undefined) && (
                <div role="status" className="surface-status surface-status--amber">
                  {currentHistory.error !== undefined
                    ? <>日志读取错误: {currentHistory.error}</>
                    : <>刷新失败，保留 {formatAt(history.at)} 的数据{history.error?.status !== undefined ? ` (HTTP ${history.error.status})` : ''}: {history.error?.message}</>}
                </div>
              )}
              {currentHistory.truncated && (
                <div role="status" className="surface-status surface-status--amber">
                  当日日志已达上限，更早的记录未写入。
                </div>
              )}
              {history.status === 'loading' && (
                <div role="status" className="surface-quiet">正在刷新，当前继续显示上次结果。</div>
              )}
              {currentHistory.error === undefined && foldedHistory.length === 0 && (
                <QuietState
                  title="当日没有谱系记录"
                  detail={<><code>~/.dsh/logs/swarm/lineage-{day}.jsonl</code> 不存在或为空。运行一次 swarm 工具后会产生真实记录。</>}
                />
              )}
              {foldedHistory.map((call) => <HistoryCall key={call.callId} call={call} />)}
            </>
          )}
        </div>
      )}
    </div>
  );
};
