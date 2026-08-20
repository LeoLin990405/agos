/**
 * console-live —— 控制台概览的真值层(V2 重设计覆盖了 f5ee71b 的接线,此处嫁接回来)。
 * ConsolePage 在 telemetry/sessions 有真数据时渲染 <RealOverview/>,否则回落 V2 展示 mock。
 */
import React, { useMemo, useSyncExternalStore } from 'react';
import { KpiCard } from '@/components/ui/KpiCard';
import { Chip } from '@/components/ui/Chip';
import { Dot } from '@/components/ui/Dot';
import { AttentionInbox } from '@/components/console/AttentionInbox';
import { SessionMatrix } from '@/components/console/SessionMatrix';
import { sessionsStore, telemetryStore, type SessionSummaryRow, type TelemetryState } from '@/stores/live';

export interface ConsoleDerived {
  running: number; failed: number; calls: number; rows: number;
  sessionsTotal: number; plansTotal: number; plansExecuted: number;
  skills: number; skillsWarn: number;
  inbox: { id: string; type: 'error' | 'warning' | 'running'; title: string; description: string; timestamp: string; actionText: string }[];
  matrix: SessionSummaryRow[];
  /** overview 路由拿到过数据 = 真后端在 */
  live: boolean;
}

const numAt = (o: Record<string, unknown> | undefined, ...path: string[]): number => {
  let cur: unknown = o;
  for (const k of path) { if (typeof cur !== 'object' || cur === null) return 0; cur = (cur as Record<string, unknown>)[k]; }
  return typeof cur === 'number' ? cur : 0;
};

function deriveConsole(t: TelemetryState, s: { rows: SessionSummaryRow[] }): ConsoleDerived {
  const ov = t.overview;
  const calls = t.progress?.calls ?? [];
  const running = numAt(ov, 'lineage', 'running');
  const failed = numAt(ov, 'lineage', 'failed');
  const inbox: ConsoleDerived['inbox'] = [];
  for (const call of calls) {
    const rows = Array.isArray(call['rows']) ? call['rows'] as Record<string, unknown>[] : [];
    const rFail = rows.filter((r) => r['status'] === 'failed');
    const rRun = rows.filter((r) => r['status'] === 'running');
    const label = String(call['description'] ?? call['callId'] ?? '批次');
    for (const fr of rFail.slice(0, 2)) {
      inbox.push({ id: `${String(call['callId'])}:${String(fr['index'])}`, type: 'error',
        title: `子任务未成功:${String(fr['item'] ?? fr['index'])}`,
        description: `${label} · ${String(fr['error'] ?? '见谱系详情')}`.slice(0, 120),
        timestamp: '', actionText: '查看谱系' });
    }
    if (rRun.length > 0) {
      inbox.push({ id: `${String(call['callId'])}:run`, type: 'running',
        title: `批次执行中 (${rows.filter((r) => r['status'] === 'completed').length}/${rows.length} 完成)`,
        description: label.slice(0, 120), timestamp: `${rRun.length} 在跑`, actionText: '查看谱系' });
    }
  }
  return {
    running, failed, calls: calls.length,
    rows: numAt(ov, 'lineage', 'rows'),
    sessionsTotal: numAt(ov, 'sessions', 'total') || s.rows.length,
    plansTotal: numAt(ov, 'plans', 'total'), plansExecuted: numAt(ov, 'plans', 'executed'),
    skills: numAt(ov, 'skills', 'skills'), skillsWarn: numAt(ov, 'skills', 'warn'),
    inbox, matrix: s.rows.slice(0, 8),
    live: ov !== undefined,
  };
}

export function useConsoleLive(): ConsoleDerived {
  const telemetry = useSyncExternalStore(telemetryStore.subscribe, telemetryStore.getSnapshot);
  const sessions = useSyncExternalStore(sessionsStore.subscribe, sessionsStore.getSnapshot);
  return useMemo(() => deriveConsole(telemetry, sessions), [telemetry, sessions]);
}

export const RealOverview: React.FC<{
  live: ConsoleDerived;
  onNavigateChat?: () => void;
  onNavigateLineage?: () => void;
}> = ({ live, onNavigateChat, onNavigateLineage }) => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: '26px' }}>
    <section className="kpi-grid">
      <KpiCard
        label="活跃派单 / 批次"
        value={String(live.running)}
        unit={`/ ${live.calls} 批`}
        trend={`${live.rows} 行子任务`}
        subValue={live.running > 0 ? '编队执行中' : '空闲待命'}
        headerRight={<Dot state={live.running > 0 ? 'running' : 'queued'} />}
      />
      <KpiCard
        label="会话总数"
        value={String(live.sessionsTotal)}
        unit="个"
        trend={live.matrix[0] !== undefined ? `最近:${live.matrix[0].title.slice(0, 12)}` : '—'}
        subValue="含子代理会话"
        headerRight={<Chip active style={{ height: '16px' }}>实时</Chip>}
      />
      <KpiCard
        label="计划档案"
        value={String(live.plansTotal)}
        unit={`/ ${live.plansExecuted} 已执行`}
        subValue="~/.dsh/logs/plans"
        trend="计划模式沉淀"
        trendType="neutral"
        headerRight={<Chip variant="purple" style={{ height: '16px' }}>PLAN</Chip>}
      />
      <KpiCard
        label="失败子任务"
        value={live.failed > 0 ? <span style={{ color: 'var(--state-failed)' }}>{live.failed}</span> : '0'}
        unit="项"
        trend={live.failed > 0 ? '需要关注' : '全部健康'}
        trendType={live.failed > 0 ? 'down' : 'neutral'}
        subValue="来自最近批次"
        headerRight={<Dot state={live.failed > 0 ? 'failed' : 'done'} />}
      />
      <KpiCard
        label="技能注册表"
        value={String(live.skills)}
        unit={live.skillsWarn > 0 ? `warn ${live.skillsWarn}` : '全部通过'}
        trend="skill-librarian 审计"
        subValue="双根扫描"
        headerRight={<Chip style={{ height: '16px' }}>SKILLS</Chip>}
      />
    </section>

    <AttentionInbox
      items={live.inbox.length > 0
        ? live.inbox.map((it) => ({ ...it, onAction: onNavigateLineage }))
        : []}
    />

    <SessionMatrix
      sessions={live.matrix.map((r) => ({
        id: r.sessionId,
        state: r.running ? 'running' as const : r.blank ? 'queued' as const : 'done' as const,
        title: r.title,
        subtitle: r.cwd,
        model: r.running ? 'RUNNING' : 'IDLE',
        tokenWatermark: `${(r.tokens / 1000).toFixed(1)}k tok`,
        latency: `${r.turns} 轮`,
        updatedAt: new Date(r.updatedAt).toLocaleTimeString('zh-CN', { hour12: false }),
        actionText: '接入',
        onAction: onNavigateChat,
      }))}
    />
  </div>
);
