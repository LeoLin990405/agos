import React, { useMemo, useState, useSyncExternalStore } from 'react';
import { AppTopbar } from '@/components/layout/AppTopbar';
import { Chip } from '@/components/ui/Chip';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { SymMonitor } from '@/components/lineage/SymMonitor';
import { LineageJobTree, type LineageJobItem } from '@/components/lineage/LineageJobTree';
import type { StateLamp } from '@/design-system/tokens';
import { telemetryStore } from '@/stores/live';

const LAMP: Record<string, { lamp: StateLamp, label: string }> = {
  queued: { lamp: 'queued', label: '等待中' },
  running: { lamp: 'running', label: '处理中' },
  completed: { lamp: 'done', label: '已完成' },
  failed: { lamp: 'failed', label: '未成功' },
  aborted: { lamp: 'failed', label: '已中止' },
};

const fmtDur = (ms: unknown): string =>
  typeof ms !== 'number' ? '--' : ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;

interface Batch { callId: string, description: string, kind: string, at: number, rows: Record<string, unknown>[] }

export const LineagePage: React.FC = () => {
  const [filterState, setFilterState] = useState<string>('all');
  const telemetry = useSyncExternalStore(telemetryStore.subscribe, telemetryStore.getSnapshot);

  const batches: Batch[] = useMemo(() => {
    const calls = telemetry.progress?.calls ?? [];
    return calls
      .map((c) => ({
        callId: String(c['callId'] ?? ''),
        description: String(c['description'] ?? '批次'),
        kind: String(c['kind'] ?? 'swarm'),
        at: Number(c['at'] ?? 0),
        rows: Array.isArray(c['rows']) ? c['rows'] as Record<string, unknown>[] : [],
      }))
      .sort((a, b) => b.at - a.at);
  }, [telemetry.progress]);

  const allRows = batches.flatMap((b) => b.rows);
  const count = (st: string): number => allRows.filter((r) => r['status'] === st).length;
  const runningCount = count('running');

  const toJob = (r: Record<string, unknown>): LineageJobItem => {
    const st = LAMP[String(r['status'] ?? 'queued')] ?? LAMP['queued'];
    const roleBits = [
      r['role'] !== undefined && r['role'] !== null ? `🎭 ${String(r['role'])}` : '',
      r['forked'] !== undefined && r['forked'] !== null && r['forked'] !== '' ? `⤴ ${String(r['forked'])}` : '',
      typeof r['depth'] === 'number' && (r['depth'] as number) > 1 ? `⛓ ${String(r['depth'])}` : '',
    ].filter((x) => x !== '').join(' ');
    const metrics: { label: string, value: string }[] = [];
    if (typeof r['queuePosition'] === 'number') metrics.push({ label: '队列位次', value: `#${String(r['queuePosition'])}` });
    if (r['host'] !== undefined && r['host'] !== null) metrics.push({ label: '主机', value: String(r['host']) });
    if (r['provider'] !== undefined && r['provider'] !== null) metrics.push({ label: 'Provider', value: String(r['provider']) });
    return {
      id: String(r['agentId'] ?? r['index'] ?? Math.random()),
      name: String(r['item'] ?? r['type'] ?? `#${String(r['index'])}`).slice(0, 80),
      role: roleBits !== '' ? roleBits : String(r['type'] ?? ''),
      model: String(r['model'] ?? ''),
      duration: fmtDur(r['elapsedMs']),
      state: st.lamp,
      badgeText: st.label,
      metrics,
      targetPrompt: String(r['item'] ?? ''),
      logs: r['error'] !== undefined && r['error'] !== null ? [String(r['error'])] : [],
      defaultOpen: r['status'] === 'failed',
    };
  };

  const visible = (b: Batch): LineageJobItem[] =>
    b.rows.filter((r) => filterState === 'all' || String(r['status'] ?? '') === filterState).map(toJob);

  return (
    <div style={{ display: 'flex', flex: 1, height: '100vh', overflow: 'hidden' }}>
      <main className="app-stage">
        <AppTopbar
          title="智能体任务谱系与血缘拓扑"
          badge={<Chip active>{runningCount > 0 ? '共息锁相中 (25 BPM)' : '全员静默'}</Chip>}
          rightActions={
            <SegmentedControl
              value={filterState}
              onChange={setFilterState}
              options={[
                { value: 'all', label: `全部 (${allRows.length})` },
                { value: 'running', label: <span style={{ color: 'var(--state-running)', fontWeight: 600 }}>处理中 ({runningCount})</span> },
                { value: 'queued', label: `等待中 (${count('queued')})` },
                { value: 'completed', label: <span style={{ color: 'var(--state-done)' }}>已完成 ({count('completed')})</span> },
                { value: 'failed', label: <span style={{ color: 'var(--state-failed)' }}>未成功 ({count('failed') + count('aborted')})</span> },
              ]}
            />
          }
        />

        <div className="lineage-wrapper">
          {runningCount > 0 && <SymMonitor bpm={25.0} periodMs={2400} driftMs={0.1} />}

          {batches.length === 0 && (
            <div style={{ padding: '48px 24px', textAlign: 'center', border: '1px dashed var(--border-subtle)', borderRadius: '12px', color: 'var(--text-tertiary)' }}>
              <div style={{ fontSize: '22px', fontWeight: 650, color: 'var(--text-secondary)', marginBottom: '8px' }}>谱系待机</div>
              <div style={{ fontSize: '12.5px' }}>最近 10 分钟没有 swarm / civ / fleet / delegate 派单。发起一个批次,血缘拓扑会在这里生长。</div>
            </div>
          )}

          {batches.map((b) => {
            const jobs = visible(b);
            if (jobs.length === 0 && filterState !== 'all') return null;
            const done = b.rows.filter((r) => r['status'] === 'completed').length;
            const pct = b.rows.length > 0 ? Math.round((done / b.rows.length) * 100) : 0;
            return (
              <LineageJobTree
                key={b.callId}
                batchId={b.callId.startsWith('host:') ? 'HOST 派单' : b.callId.slice(-8)}
                title={b.description.slice(0, 80)}
                categoryTag={b.kind}
                completedSummary={`${done}/${b.rows.length} 完成 (${pct}%)`}
                duration=""
                isRunningBranch={b.rows.some((r) => r['status'] === 'running')}
                jobs={jobs}
              />
            );
          })}
        </div>
      </main>
    </div>
  );
};
