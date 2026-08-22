import React from 'react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { fetchJsonResource, ResourceHttpError, useResource } from '@/lib/useResource';
import {
  formatCoverage,
  outcomeLabel,
  parseRoutesPayload,
  ROUTES_READY_COPY,
  type RouteDecision,
  type RoutesPayload,
} from './routes-model';

const panelStyle: React.CSSProperties = {
  borderTop: '1px solid var(--border-subtle)',
  padding: '16px 0',
};

const quietText: React.CSSProperties = {
  color: 'var(--text-tertiary)',
  fontSize: '12px',
  lineHeight: 1.6,
};

const fetchRoutes = async (url: string, signal: AbortSignal): Promise<RoutesPayload> =>
  parseRoutesPayload(await fetchJsonResource<unknown>(url, signal));

function errorText(error: { status?: number; message?: string } | undefined): string {
  if (!error) return '未采集'
  if (error instanceof ResourceHttpError || typeof error.status === 'number') {
    return `HTTP ${error.status}${error.message ? ` · ${error.message}` : ''}`
  }
  return error.message || '未采集'
}

function DecisionRow({ row }: { row: RouteDecision }) {
  const pending = outcomeLabel(row.outcome) === 'pending';
  return (
    <li style={{ display: 'grid', gridTemplateColumns: 'minmax(120px, 180px) 1fr auto', gap: '12px', alignItems: 'start', padding: '10px 0', borderTop: '1px solid var(--border-dim)', fontSize: '12px' }}>
      <div>
        <strong style={{ color: 'var(--text-primary)', overflowWrap: 'anywhere' }}>{row.pick || '未采集'}</strong>
        <div style={{ marginTop: '6px', display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
          <Badge state={row.source === 'selector' ? 'done' : 'queued'}>{row.source === 'fallback' ? '静态回落' : '选择器'}</Badge>
          <Badge state={row.role ? 'queued' : 'queued'}>{row.role || '角色未采集'}</Badge>
        </div>
      </div>
      <div>
        <p style={{ margin: 0, color: 'var(--text-secondary)', lineHeight: 1.55 }}>{row.taskType || '任务类型未采集'}</p>
        <p style={{ ...quietText, margin: '6px 0 0' }}>
          候选 {(row.candidates || []).join(' / ') || '未采集'}
          {row.reason ? ` · ${row.reason}` : ''}
          {row.fallbackReason ? ` · 回落 ${row.fallbackReason}` : ''}
        </p>
      </div>
      <div style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
        <Badge state={pending ? 'queued' : 'done'}>{pending ? '待回填' : '已回填'}</Badge>
        <div className="u-num" style={{ ...quietText, marginTop: '6px' }}>
          {typeof row.confidence === 'number' ? `置信 ${row.confidence}` : '置信未采集'}
        </div>
      </div>
    </li>
  );
}

export const RoutesView: React.FC = () => {
  const resource = useResource<RoutesPayload>({ url: '/api/agos/routes', fetcher: fetchRoutes });
  const payload = resource.data;
  const isBusy = resource.status === 'idle' || resource.status === 'loading';
  const capturedAt = resource.at ? new Date(resource.at).toLocaleString('zh-CN', { hour12: false }) : '未采集';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '18px' }}>
      <header style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '16px', flexWrap: 'wrap' }}>
        <div>
          <h2 style={{ fontSize: '16px', fontWeight: 800, margin: 0 }}>路由决策</h2>
          <p style={{ ...quietText, margin: '4px 0 0' }}>
            outcome 为 null 时显示待回填，不是成功或失败。
          </p>
        </div>
        <Button size="sm" disabled={isBusy} onClick={() => resource.refresh()}>
          {isBusy ? '加载中…' : '刷新'}
        </Button>
      </header>

      {resource.status === 'degraded' && resource.error && payload !== undefined && (
        <div role="status" style={{ padding: '9px 12px', border: '1px solid var(--state-running-border)', borderRadius: '6px', color: 'var(--text-secondary)', fontSize: '12px' }}>
          暂时无法更新，保留 {capturedAt} 的结果：{errorText(resource.error)}
        </div>
      )}

      {(resource.status === 'idle' || resource.status === 'loading') && payload === undefined && (
        <p aria-live="polite" style={quietText}>正在读取路由决策…</p>
      )}

      {resource.status === 'error' && resource.error && payload === undefined && (
        <div role="alert" style={{ ...panelStyle, color: 'var(--state-failed)', fontSize: '12px' }}>
          <p style={{ margin: '0 0 10px' }}><code>/api/agos/routes</code> 未响应：{errorText(resource.error)}</p>
          <Button size="sm" onClick={() => resource.refresh()}>重试</Button>
        </div>
      )}

      {payload && (
        <section style={panelStyle} aria-label="路由决策列表">
          <h3 style={{ fontSize: '13px', fontWeight: 700, margin: '0 0 8px' }}>{ROUTES_READY_COPY}</h3>
          <p style={{ margin: '0 0 12px', color: 'var(--text-secondary)', fontSize: '12px' }}>{formatCoverage(payload.stats)}</p>
          <p style={{ ...quietText, margin: '0 0 12px' }}>
            三档阶梯已收起：真实路径没有逐候选判断可聚,不会显示一个永远只有「升级」的阶梯。
          </p>
          {payload.decisions.length === 0 ? (
            <p style={{ ...quietText, margin: 0 }}>还没有决策记录。成功读到空台账时这里仍会显示路由档位。</p>
          ) : (
            <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
              {[...payload.decisions].reverse().map((row, index) => (
                <DecisionRow key={`${row.id ?? row.ts ?? 't'}:${row.pick ?? ''}:${index}`} row={row} />
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  );
};
