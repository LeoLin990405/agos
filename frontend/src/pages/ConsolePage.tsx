import React, { useMemo, useState, useSyncExternalStore } from 'react';
import { AppTopbar } from '@/components/layout/AppTopbar';
import { Chip } from '@/components/ui/Chip';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { KpiCard } from '@/components/ui/KpiCard';
import { AttentionInbox } from '@/components/console/AttentionInbox';
import { SessionMatrix } from '@/components/console/SessionMatrix';
import { FleetRack } from '@/components/console/FleetRack';
import { SparseReadiness } from '@/components/console/SparseReadiness';
import { Dot } from '@/components/ui/Dot';

import { sessionsStore, telemetryStore, type SessionSummaryRow } from '@/stores/live';
import type { TelemetryState } from '@/stores/live';

interface ConsoleDerived {
  running: number; failed: number; calls: number; rows: number;
  sessionsTotal: number; plansTotal: number; plansExecuted: number;
  skills: number; skillsWarn: number;
  inbox: { id: string; type: 'error' | 'warning' | 'running'; title: string; description: string; timestamp: string; actionText: string }[];
  matrix: SessionSummaryRow[];
}

const numAt = (o: Record<string, unknown> | undefined, ...path: string[]): number => {
  let cur: unknown = o;
  for (const k of path) { if (typeof cur !== 'object' || cur === null) return 0; cur = (cur as Record<string, unknown>)[k]; }
  return typeof cur === 'number' ? cur : 0;
};

function deriveConsole(t: TelemetryState, s: { rows: SessionSummaryRow[] }): ConsoleDerived {
  const ov = t.overview;
  const calls = t.progress?.calls ?? [];
  let running = numAt(ov, 'lineage', 'running');
  let failed = numAt(ov, 'lineage', 'failed');
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
  };
}

export const ConsolePage: React.FC<{ onNavigateChat?: () => void; onNavigateLineage?: () => void }> = ({
  onNavigateChat,
  onNavigateLineage,
}) => {
  const [densityMode, setDensityMode] = useState<'dense' | 'sparse'>('dense');
  const telemetry = useSyncExternalStore(telemetryStore.subscribe, telemetryStore.getSnapshot);
  const sessionsSnap = useSyncExternalStore(sessionsStore.subscribe, sessionsStore.getSnapshot);
  const live = useMemo(() => deriveConsole(telemetry, sessionsSnap), [telemetry, sessionsSnap]);

  return (
    <div style={{ display: 'flex', flex: 1, height: '100vh', overflow: 'hidden' }}>
      {/* 内部功能导航 */}
      <nav className="console-nav-rail">
        <div style={{ padding: '4px 8px 10px 8px' }} className="u-microlabel">控制台导航</div>

        <a href="#overview" className="console-nav-item is-active">
          <span>📊 概览遥测</span>
          <Dot state="running" size={6} />
        </a>
        <a href="#fleet" className="console-nav-item">
          <span>🖥️ 机架与节点</span>
          <Chip style={{ height: '16px', padding: '0 4px' }}>4 节点</Chip>
        </a>
        <a href="#sessions" className="console-nav-item">
          <span>💬 会话矩阵</span>
          <span className="u-num" style={{ fontSize: '11px' }}>24</span>
        </a>
        <div className="console-nav-item" style={{ cursor: 'pointer' }} onClick={onNavigateLineage}>
          <span>🧬 智能体谱系</span>
          <Chip variant="purple" style={{ height: '16px', padding: '0 4px' }}>Swarm</Chip>
        </div>
        <a href="#plans" className="console-nav-item">
          <span>📋 计划与目标</span>
          <span className="u-num" style={{ fontSize: '11px' }}>3</span>
        </a>
        <a href="#skills" className="console-nav-item">
          <span>🧩 技能注册表</span>
          <span className="u-num" style={{ fontSize: '11px' }}>14/14</span>
        </a>
      </nav>

      {/* 主展示区 */}
      <main className="app-stage">
        <AppTopbar
          title="AgOS 控制台概览"
          badge={<Chip>CLUSTER: ASIA-EAST-PROD-01</Chip>}
          rightActions={
            <SegmentedControl
              value={densityMode}
              onChange={setDensityMode}
              options={[
                { value: 'dense', label: '⚡ 满载生产模式 (Dense 42 节点)' },
                { value: 'sparse', label: '🌱 初始冷启模式 (Sparse 1 节点)' },
              ]}
            />
          }
        />

        <div className="console-body">
          {densityMode === 'dense' ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '26px' }}>
              {/* 1. Hero KPI 遥测矩阵 */}
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

              {/* 2. 注意力收件箱 */}
              <AttentionInbox
                items={live.inbox.map((it) => ({ ...it, onAction: onNavigateLineage }))}
              />

              {/* 3. 高密度会话矩阵 */}
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

              {/* 4. 机房机架 */}
              <FleetRack
                blades={[
                  { id: '1', name: 'BLADE-01 (Orchestrator)', role: '主中枢', state: 'running', cpu: '42%', memory: '3.2G / 16G', latency: '12ms' },
                  { id: '2', name: 'BLADE-02 (Swarm Worker Alpha)', role: '计算节点', state: 'running', cpu: '78%', memory: '8.4G / 16G', latency: '18ms' },
                  { id: '3', name: 'BLADE-03 (Swarm Worker Beta)', role: '计算节点', state: 'done', cpu: '14% (Idle)', memory: '1.8G / 16G', latency: '8ms' },
                  { id: '4', name: 'BLADE-04 (Sandbox Gateway)', role: '安全网关', state: 'done', cpu: '22%', memory: '2.1G / 16G', latency: '6ms' },
                ]}
              />
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '26px' }}>
              {/* 冷启待机 KPI */}
              <section className="kpi-grid">
                <KpiCard
                  label="集群状态"
                  value="待机就绪"
                  trend="1 节点健康在线"
                  subValue="0 活跃会话"
                  headerRight={<Dot state="running" />}
                />
                <KpiCard
                  label="MCP 技能注册表"
                  value="14"
                  unit="/ 14 启用"
                  trend="工具全域可用"
                  subValue="0 挂起"
                  headerRight={<Chip active style={{ height: '16px' }}>100% 挂载</Chip>}
                />
                <KpiCard
                  label="本月消耗"
                  value="0.12"
                  unit="M Tokens"
                  trend="预算余量 99.8%"
                  subValue="费用极低"
                  headerRight={<Chip>DeepSeek</Chip>}
                />
                <KpiCard
                  label="安全策略模式"
                  value={<span style={{ color: 'var(--state-done)' }}>严格防御</span>}
                  trend="特权写入需人工授权"
                  subValue="0 越界"
                  headerRight={<Chip variant="purple">CivStrip v2</Chip>}
                />
              </section>

              {/* 就绪清单 */}
              <SparseReadiness
                onStartWorkflow={(wf) => {
                  if (wf === 'lineage-pulse') onNavigateLineage?.();
                  else onNavigateChat?.();
                }}
              />
            </div>
          )}
        </div>
      </main>
    </div>
  );
};
