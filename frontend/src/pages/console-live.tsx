/**
 * console-live —— 控制台概览的真值层。
 * 字段缺席与真实的 0 是两种状态；前者必须诚实显示为「未采集」。
 */
import React, { useMemo, useSyncExternalStore } from 'react';
import { Dot } from '@/components/ui/Dot';
import { Button } from '@/components/ui/Button';
import { AttentionInbox } from '@/components/console/AttentionInbox';
import { SessionMatrix } from '@/components/console/SessionMatrix';
import { useResource, type ResourceFetcher } from '@/lib/useResource';
import type { ResourceFailure, ResourceStatus } from '@/lib/resource';
import { sessionsStore, type SessionSummaryRow, type TelemetryState } from '@/stores/live';

export interface ConsoleDerived {
  running: number | undefined; failed: number | undefined; calls: number | undefined; rows: number | undefined;
  sessionsTotal: number | undefined; plansTotal: number | undefined; plansExecuted: number | undefined;
  skills: number | undefined; skillsWarn: number | undefined; skillsError: number | undefined;
  /** Model-facing roots only — the number that matters for runtime health. */
  skillsServedWarn: number | undefined; skillsServedError: number | undefined;
  skillsConsoleWarn: number | undefined;
  skillsConsistency: string | undefined;
  inbox: { id: string; type: 'error' | 'warning' | 'running'; title: string; description: string; timestamp: string; actionText: string }[];
  matrix: SessionSummaryRow[];
  progressLive: boolean;
  sessionsLive: boolean;
  /** overview 路由拿到过数据 = 真后端在 */
  live: boolean;
}

export interface ConsoleLive extends ConsoleDerived {
  overviewStatus: ResourceStatus;
  overviewAt: number | undefined;
  overviewError: ResourceFailure | undefined;
  progressStatus: ResourceStatus;
  progressAt: number | undefined;
  progressError: ResourceFailure | undefined;
  refreshOverview: () => void;
  refreshProgress: () => void;
}

export interface UseConsoleLiveOptions {
  overviewEnabled?: boolean;
  progressEnabled?: boolean;
  overviewFetcher?: ResourceFetcher<Record<string, unknown>>;
  progressFetcher?: ResourceFetcher<Record<string, unknown>>;
}

export const numAt = (o: Record<string, unknown> | undefined, ...path: string[]): number | undefined => {
  let cur: unknown = o;
  for (const k of path) { if (typeof cur !== 'object' || cur === null) return undefined; cur = (cur as Record<string, unknown>)[k]; }
  return typeof cur === 'number' && Number.isFinite(cur) ? cur : undefined;
};

export function normalizeProgressPayload(payload: Record<string, unknown> | undefined): TelemetryState['progress'] {
  if (payload === undefined) return undefined;
  const source = payload['calls'] ?? payload;
  if (Array.isArray(source)) {
    return { calls: source.filter((value): value is Record<string, unknown> => typeof value === 'object' && value !== null) };
  }
  if (typeof source !== 'object' || source === null) return undefined;
  return {
    calls: Object.entries(source)
      .filter(([, value]) => typeof value === 'object' && value !== null)
      .map(([callId, value]) => ({ callId, ...(value as Record<string, unknown>) })),
  };
}

export function overviewLamp(status: ResourceStatus): 'running' | 'queued' | 'failed' | 'done' {
  if (status === 'ready') return 'done';
  if (status === 'degraded' || status === 'error') return 'failed';
  return 'queued';
}

export function deriveConsole(t: TelemetryState, s: { rows: SessionSummaryRow[]; loadedAt?: number }): ConsoleDerived {
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
    running, failed, calls: numAt(ov, 'lineage', 'calls') ?? (t.progress === undefined ? undefined : calls.length),
    rows: numAt(ov, 'lineage', 'rows'),
    sessionsTotal: numAt(ov, 'sessions', 'total'),
    plansTotal: numAt(ov, 'plans', 'total'), plansExecuted: numAt(ov, 'plans', 'executed'),
    skills: numAt(ov, 'skills', 'skills'), skillsWarn: numAt(ov, 'skills', 'warn'), skillsError: numAt(ov, 'skills', 'error'),
    skillsServedWarn: numAt(ov, 'skills', 'servedToModel', 'warn'),
    skillsServedError: numAt(ov, 'skills', 'servedToModel', 'error'),
    skillsConsoleWarn: numAt(ov, 'skills', 'consoleOnly', 'warn'),
    skillsConsistency: (() => {
      const skills = ov?.['skills'];
      if (typeof skills !== 'object' || skills === null) return undefined;
      const c = (skills as Record<string, unknown>)['consistency'];
      if (typeof c !== 'object' || c === null) return undefined;
      const summary = (c as Record<string, unknown>)['summary'];
      return typeof summary === 'string' ? summary : undefined;
    })(),
    inbox, matrix: s.rows.slice(0, 8),
    progressLive: t.progress !== undefined,
    sessionsLive: typeof s.loadedAt === 'number' && s.loadedAt > 0,
    live: ov !== undefined,
  };
}

export function useConsoleLive({
  overviewEnabled = true,
  progressEnabled = true,
  overviewFetcher,
  progressFetcher,
}: UseConsoleLiveOptions = {}): ConsoleLive {
  const overview = useResource<Record<string, unknown>>({
    url: '/api/agos/overview',
    enabled: overviewEnabled,
    intervalMs: 10_000,
    fetcher: overviewFetcher,
  });
  const progress = useResource<Record<string, unknown>>({
    url: '/api/swarm/progress',
    enabled: progressEnabled,
    intervalMs: 10_000,
    fetcher: progressFetcher,
  });
  const sessions = useSyncExternalStore(sessionsStore.subscribe, sessionsStore.getSnapshot);
  const overviewData = overviewEnabled ? overview.data : undefined;
  const progressData = useMemo(
    () => progressEnabled ? normalizeProgressPayload(progress.data) : undefined,
    [progress.data, progressEnabled],
  );
  const derived = useMemo(() => deriveConsole({
    overview: overviewData,
    progress: progressData,
    at: numAt(overviewData, 'at') ?? overview.at ?? 0,
  }, sessions), [overview.at, overviewData, progressData, sessions]);

  return {
    ...derived,
    overviewStatus: overviewEnabled ? overview.status : 'idle',
    overviewAt: numAt(overviewData, 'at') ?? overview.at,
    overviewError: overviewEnabled ? overview.error : undefined,
    progressStatus: progressEnabled ? progress.status : 'idle',
    progressAt: progress.at,
    progressError: progressEnabled ? progress.error : undefined,
    refreshOverview: () => { overview.refresh(); },
    refreshProgress: () => { progress.refresh(); },
  };
}

export function formatCollectedAt(at: number | undefined): string {
  if (at === undefined || !Number.isFinite(at) || at <= 0) return '时间未采集';
  return new Date(at).toLocaleString('zh-CN', { hour12: false });
}

const ResourceDegradedNotice: React.FC<{
  route: string;
  at: number | undefined;
  error: ResourceFailure;
  onRetry: () => void;
}> = ({ route, at, error, onRetry }) => (
  <div role="status" className="surface-status surface-cluster is-spread">
    <span>
      <code>{route}</code> 暂时无法更新，保留 {formatCollectedAt(at)} 的结果：
      {error.status !== undefined && `HTTP ${error.status} · `}{error.message}
    </span>
    <Button size="sm" onClick={onRetry}>重试</Button>
  </div>
);

const ResourceUnavailableNotice: React.FC<{
  status: ResourceStatus;
  route: string;
  error: ResourceFailure | undefined;
  onRetry: () => void;
}> = ({ status, route, error, onRetry }) => {
  if (status === 'error' && error !== undefined) {
    return (
      <div role="alert" className="surface-status surface-status--fail">
        <p><code>{route}</code> 未响应：{error.status !== undefined && `HTTP ${error.status} · `}{error.message}</p>
        <Button size="sm" onClick={onRetry}>重试</Button>
      </div>
    );
  }
  return <p role="status" className="surface-quiet">正在读取 <code>{route}</code>…</p>;
};

export const RealOverview: React.FC<{
  live: ConsoleLive;
  density?: 'dense' | 'sparse';
  onNavigateChat?: (sessionId?: string) => void;
  onNavigateLineage?: () => void;
  onNavigateStudio?: () => void;
  onNavigateAssemble?: () => void;
}> = ({ live, density = 'dense', onNavigateChat, onNavigateLineage, onNavigateStudio, onNavigateAssemble }) => {
  if (!live.live) {
    if (live.overviewStatus === 'error' && live.overviewError !== undefined) {
      return (
        <div role="alert" className="surface-section surface-alert">
          <p><code>/api/agos/overview</code> 未响应：{live.overviewError.status !== undefined && `HTTP ${live.overviewError.status} · `}{live.overviewError.message}</p>
          <Button size="sm" onClick={live.refreshOverview}>重试</Button>
        </div>
      );
    }
    return <p role="status" className="surface-quiet">正在读取 <code>/api/agos/overview</code>…</p>;
  }

  const metric = (value: number | undefined): number | string => value ?? '未采集';
  const hasLineageDetail = live.calls !== undefined || live.rows !== undefined;
  const mixReady = live.rows !== undefined && live.running !== undefined && live.failed !== undefined;
  const mixRunning = live.running ?? 0;
  const mixFailed = live.failed ?? 0;
  const mixRest = mixReady ? Math.max(0, (live.rows ?? 0) - mixRunning - mixFailed) : 0;
  const tokenMax = Math.max(1, ...live.matrix.map((row) => row.tokens));
  const hasPlans = live.plansTotal !== undefined || live.plansExecuted !== undefined;
  const hasSkills = live.skills !== undefined || live.skillsWarn !== undefined || live.skillsError !== undefined;
  const skillsDetail = [
    live.skillsServedWarn !== undefined ? `模型根 warn ${live.skillsServedWarn}` : undefined,
    live.skillsConsoleWarn !== undefined ? `控制台-only warn ${live.skillsConsoleWarn}` : undefined,
    live.skillsServedWarn === undefined && live.skillsWarn !== undefined ? `warn ${live.skillsWarn}` : undefined,
    live.skillsError === undefined ? undefined : `error ${live.skillsError}`,
  ].filter((value): value is string => value !== undefined).join(' · ');

  return (
  <div className={`surface-page ${density === 'dense' ? 'is-dense' : 'is-sparse'}`} data-density={density}>
    {live.overviewStatus === 'degraded' && live.overviewError !== undefined && (
      <ResourceDegradedNotice route="/api/agos/overview" at={live.overviewAt} error={live.overviewError} onRetry={live.refreshOverview} />
    )}
    {live.overviewStatus === 'loading' && live.overviewAt !== undefined && (
      <p role="status" className="surface-quiet">
        正在更新概览，当前显示 {formatCollectedAt(live.overviewAt)} 的结果。
      </p>
    )}
    <section className="instrument-strip" aria-label="控制台仪表带">
      <div className={`instrument-cell is-lead${live.running !== undefined && live.running > 0 ? ' is-live' : ''}`}>
        <div className="instrument-label">{live.running !== undefined && <Dot state={live.running > 0 ? 'running' : 'queued'} size={6} />}活跃派单</div>
        <div className="instrument-value">{metric(live.running)}{hasLineageDetail && <span className="instrument-unit">{live.calls === undefined ? '批次未采集' : `/ ${live.calls} 批`}{live.rows === undefined ? '' : ` · ${live.rows} 行`}</span>}</div>
        <div className="instrument-sub">{live.running === undefined ? 'lineage.running 未采集' : live.running > 0 ? '编队执行中' : '空闲待命'}</div>
        {mixReady && (mixRunning + mixFailed + mixRest) > 0 && (
          <div className="instrument-mix" aria-hidden="true">
            {mixRunning > 0 && <span className="instrument-mix-seg is-running" style={{ flexGrow: mixRunning, flexBasis: 0 }} />}
            {mixFailed > 0 && <span className="instrument-mix-seg is-failed" style={{ flexGrow: mixFailed, flexBasis: 0 }} />}
            {mixRest > 0 && <span className="instrument-mix-seg is-rest" style={{ flexGrow: mixRest, flexBasis: 0 }} />}
          </div>
        )}
      </div>
      <div className="instrument-cell is-quiet">
        <div className="instrument-label">会话</div>
        <div className="instrument-value">{metric(live.sessionsTotal)}{live.sessionsTotal !== undefined && <span className="instrument-unit">个</span>}</div>
        <div className="instrument-sub">{live.sessionsTotal === undefined ? 'sessions 组未挂载' : live.matrix[0] !== undefined ? `最近:${live.matrix[0].title.slice(0, 14)}` : live.sessionsTotal === 0 ? '总数为 0' : '会话列表尚未采集'}</div>
      </div>
      <div className="instrument-cell is-quiet">
        <div className="instrument-label">计划档案</div>
        <div className="instrument-value">{metric(live.plansTotal)}{hasPlans && <span className="instrument-unit">{live.plansExecuted === undefined ? '已执行未采集' : `/ ${live.plansExecuted} 已执行`}</span>}</div>
        <div className="instrument-sub">{hasPlans ? '~/.dsh/logs/plans' : 'plans 组未挂载'}</div>
      </div>
      <div className="instrument-cell is-quiet">
        <div className="instrument-label">{live.failed !== undefined && <Dot state={live.failed > 0 ? 'failed' : 'done'} size={6} />}失败子任务</div>
        <div className={`instrument-value${live.failed !== undefined && live.failed > 0 ? ' metric-fail' : ''}`}>{metric(live.failed)}{live.failed !== undefined && <span className="instrument-unit">项</span>}</div>
        <div className="instrument-sub">{live.failed === undefined ? 'lineage.failed 未采集' : live.failed > 0 ? '需要关注' : '未发现失败'}</div>
      </div>
      <div className="instrument-cell is-quiet">
        <div className="instrument-label">技能注册表</div>
        <div className="instrument-value">{metric(live.skills)}{hasSkills && <span className="instrument-unit">{skillsDetail || '审计结果未采集'}</span>}</div>
        <div className="instrument-sub">
          {!hasSkills
            ? '进技能页触发 librarian 审计'
            : live.skillsConsistency
              ? live.skillsConsistency
              : '根并集审计 · 区分模型根与控制台-only'}
        </div>
      </div>
    </section>

    <section className="surface-section" aria-label="产品入口">
      <h3 className="surface-h3">工作室与组装</h3>
      <p className="surface-quiet">
        技能工作室只写模型根。路由组装是提案，只定角色不执行。三角色试跑需确认，只出文本、不开子代理。
      </p>
      <div className="surface-cluster">
        <Button size="sm" onClick={onNavigateStudio}>打开工作室</Button>
        <Button size="sm" onClick={onNavigateAssemble}>打开路由组装</Button>
      </div>
    </section>

    {live.progressLive ? (<>
      {live.progressStatus === 'degraded' && live.progressError !== undefined && (
        <ResourceDegradedNotice route="/api/swarm/progress" at={live.progressAt} error={live.progressError} onRetry={live.refreshProgress} />
      )}
      {live.progressStatus === 'loading' && live.progressAt !== undefined && (
        <p role="status" className="surface-quiet">
          正在更新谱系明细，当前显示 {formatCollectedAt(live.progressAt)} 的结果。
        </p>
      )}
      <AttentionInbox items={live.inbox.map((it) => ({ ...it, onAction: onNavigateLineage }))} />
    </>
    ) : (
      <ResourceUnavailableNotice status={live.progressStatus} route="/api/swarm/progress" error={live.progressError} onRetry={live.refreshProgress} />
    )}

    {live.sessionsLive ? <SessionMatrix
      sessions={live.matrix.map((r) => ({
        id: r.sessionId,
        state: r.running ? 'running' as const : r.blank ? 'queued' as const : 'done' as const,
        title: r.title,
        subtitle: r.cwd,
        tokenWatermark: r.tokens > 0 ? `${(r.tokens / 1000).toFixed(1)}k tok` : '未采集',
        tokenRatio: r.tokens > 0 ? r.tokens / tokenMax : undefined,
        updatedAt: r.updatedAt > 0
          ? new Date(r.updatedAt).toLocaleTimeString('zh-CN', { hour12: false })
          : '未采集',
        actionText: '接入',
        onAction: () => onNavigateChat?.(r.sessionId),
      }))}
    /> : <p className="surface-quiet">会话列表尚未采集，session.list 尚未返回数据。</p>}
  </div>
  );
};
