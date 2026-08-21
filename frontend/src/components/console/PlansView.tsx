import React, { useMemo, useState } from 'react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { formatRelative } from '@/lib/time';
import { fetchJsonResource, useResource } from '@/lib/useResource';
import { derivePlanStatus, formatPlanSource, parsePlansPayload, recentPlans, type PlanRecord, type PlansPayload, type PlanStatus } from './plans-model';

export interface PlansViewProps {
  /** Total from /api/agos/overview; omitted when that group was not collected. */
  overviewTotal?: number;
}

const quietText: React.CSSProperties = {
  color: 'var(--text-tertiary)',
  fontSize: '12px',
  lineHeight: 1.6,
};

const statusMeta: Record<PlanStatus, { label: string; lamp: 'done' | 'running' | 'queued' }> = {
  executed: { label: '已执行', lamp: 'done' },
  approved: { label: '已批准', lamp: 'running' },
  edited: { label: '已编辑', lamp: 'queued' },
  pending: { label: '待处理', lamp: 'queued' },
};

const fetchPlans = async (url: string, signal: AbortSignal): Promise<PlansPayload> =>
  parsePlansPayload(await fetchJsonResource<unknown>(url, signal));

function planWhen(plan: PlanRecord): string {
  const raw = plan.executedAt || plan.approvedAt || plan.editedAt;
  if (!raw) return '';
  const value = Date.parse(raw);
  return Number.isFinite(value) ? formatRelative(value) : '';
}

function PlanRow({ plan, open, onToggle }: { plan: PlanRecord; open: boolean; onToggle: () => void }) {
  const status = derivePlanStatus(plan);
  const meta = statusMeta[status];
  const when = planWhen(plan);
  const source = formatPlanSource(plan.source);

  return (
    <article style={{ borderTop: '1px solid var(--border-subtle)' }}>
      <button
        type="button"
        aria-expanded={open}
        onClick={onToggle}
        style={{ width: '100%', border: 0, padding: '14px 0', background: 'transparent', color: 'inherit', cursor: 'pointer', textAlign: 'left', display: 'grid', gridTemplateColumns: '18px minmax(0, 1fr) auto', gap: '10px', alignItems: 'center', font: 'inherit' }}
      >
        <span aria-hidden="true" style={{ color: 'var(--text-tertiary)' }}>{open ? '▾' : '▸'}</span>
        <span style={{ minWidth: 0 }}>
          <strong style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: '13px' }}>{plan.goal || plan.name}</strong>
          <span style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '8px', marginTop: '5px', ...quietText }}>
            <code>{plan.name}</code>
            {source && <span>{source}</span>}
            <span>规划者 {plan.planner || '未采集'}</span>
            <span>{Array.isArray(plan.steps) ? `${plan.steps.length} 步` : '步骤未采集'}</span>
            {when && <span>{when}</span>}
          </span>
        </span>
        <Badge state={meta.lamp}>{meta.label}</Badge>
      </button>

      {open && (
        <div style={{ padding: '0 0 16px 28px' }}>
          <p style={{ color: plan.goal ? 'var(--text-secondary)' : 'var(--text-tertiary)', fontSize: '12px', lineHeight: 1.6, margin: '0 0 10px' }}>
            {plan.goal || '目标未采集。'}
          </p>
          {Array.isArray(plan.steps) && plan.steps.length > 0 ? (
            <ol style={{ listStyle: 'none', padding: 0, margin: 0 }}>
              {plan.steps.map((step, index) => (
                <li key={`${step.id ?? index}:${index}`} style={{ display: 'grid', gridTemplateColumns: '30px minmax(0, 1fr) auto', gap: '10px', padding: '8px 0', borderTop: '1px solid var(--border-dim)', fontSize: '12px' }}>
                  <span className="u-num" style={{ color: 'var(--text-tertiary)' }}>{step.id ?? index + 1}</span>
                  <span style={{ color: 'var(--text-secondary)' }}>{step.title || '未命名步骤'}</span>
                  {step.type && <Badge state="queued">{step.type}</Badge>}
                </li>
              ))}
            </ol>
          ) : (
            <p style={{ ...quietText, margin: 0 }}>这份计划没有步骤。</p>
          )}
          {typeof plan.review === 'string' && plan.review.trim() !== '' && (
            <p style={{ color: 'var(--text-secondary)', fontSize: '12px', lineHeight: 1.6, margin: '10px 0 0' }}>
              <strong>验收：</strong>{plan.review}
            </p>
          )}
        </div>
      )}
    </article>
  );
}

export const PlansView: React.FC<PlansViewProps> = ({ overviewTotal }) => {
  const [openFiles, setOpenFiles] = useState<Set<string>>(() => new Set());
  const resource = useResource<PlansPayload>({
    url: '/api/cn/plans',
    intervalMs: 15_000,
    refreshOnFocus: true,
    fetcher: fetchPlans,
  });
  const payload = resource.data;
  const plans = useMemo(() => payload === undefined ? undefined : recentPlans(payload.plans), [payload]);
  const isBusy = resource.status === 'idle' || resource.status === 'loading';

  const toggle = (file: string) => {
    setOpenFiles((previous) => {
      const next = new Set(previous);
      if (next.has(file)) next.delete(file);
      else next.add(file);
      return next;
    });
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '18px' }}>
      <header style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '16px' }}>
        <div>
          <h2 style={{ fontSize: '16px', fontWeight: 800, margin: 0 }}>计划档案</h2>
          <p style={{ ...quietText, margin: '4px 0 0' }}>只读数据源 <code>/api/cn/plans</code></p>
        </div>
        <Button size="sm" disabled={isBusy} onClick={() => resource.refresh()}>
          {isBusy ? '读取中…' : '刷新'}
        </Button>
      </header>

      {(resource.status === 'idle' || resource.status === 'loading') && payload === undefined && <p aria-live="polite" style={quietText}>正在读取计划档案…</p>}

      {resource.status === 'error' && resource.error && payload === undefined && (
        <div role="alert" style={{ borderTop: '1px solid var(--border-subtle)', padding: '16px 0', color: 'var(--state-failed)', fontSize: '12px' }}>
          <p style={{ margin: '0 0 10px' }}><code>/api/cn/plans</code> 未响应：{resource.error.status !== undefined && `HTTP ${resource.error.status} · `}{resource.error.message}</p>
          <Button size="sm" onClick={() => resource.refresh()}>重试</Button>
        </div>
      )}

      {resource.status === 'degraded' && resource.error && payload !== undefined && (
        <div role="status" style={{ padding: '9px 12px', border: '1px solid var(--state-running-border)', borderRadius: '6px', color: 'var(--text-secondary)', fontSize: '12px' }}>
          暂时无法更新，保留 {resource.at ? new Date(resource.at).toLocaleString() : '上次'} 的结果：
          {resource.error.status !== undefined && `HTTP ${resource.error.status} · `}{resource.error.message}
        </div>
      )}

      {payload?.error && <p role="alert" style={{ color: 'var(--state-failed)', fontSize: '12px' }}>{payload.error}</p>}

      {payload && !payload.error && plans?.length === 0 && (
        <div style={{ borderTop: '1px solid var(--border-subtle)', padding: '16px 0' }}>
          <p style={{ ...quietText, margin: 0 }}>还没有计划文件。此处只显示 <code>/api/cn/plans</code> 返回的计划档案。</p>
        </div>
      )}

      {payload && !payload.error && plans !== undefined && plans.length > 0 && (
        <section aria-label="计划列表">
          {typeof overviewTotal === 'number' && overviewTotal > plans.length && (
            <p style={{ ...quietText, margin: '0 0 8px' }}>显示最近 {plans.length} 条，共 {overviewTotal} 条。</p>
          )}
          {plans.map((plan) => (
            <PlanRow
              key={plan.file}
              plan={plan}
              open={openFiles.has(plan.file)}
              onToggle={() => toggle(plan.file)}
            />
          ))}
        </section>
      )}
    </div>
  );
};
