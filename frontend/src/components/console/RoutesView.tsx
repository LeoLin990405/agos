import React from 'react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { fetchJsonResource, ResourceHttpError, useResource } from '@/lib/useResource';
import {
  formatCoverage,
  outcomeLabel,
  parseRoutesPayload,
  routesTierNote,
  ROUTES_READY_COPY,
  ruleReasonCopy,
  type RouteDecision,
  type RoutesPayload,
} from './routes-model';

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
    <li className="surface-row surface-row--3">
      <div>
        <strong className="surface-strong">{row.pick || '未采集'}</strong>
        <div className="surface-cluster">
          <Badge state={row.source === 'selector' ? 'done' : 'queued'}>{row.source === 'fallback' ? '静态回落' : '选择器'}</Badge>
          <Badge state={row.role ? 'queued' : 'queued'}>{row.role || '角色未采集'}</Badge>
        </div>
      </div>
      <div>
        <p className="surface-body">{row.taskType || '任务类型未采集'}</p>
        <p className="surface-quiet">
          候选 {(row.candidates || []).join(' / ') || '未采集'}
          {row.reason ? ` · ${row.reason}` : ''}
          {ruleReasonCopy(row.rule?.reason) ? ` · ${ruleReasonCopy(row.rule?.reason)}` : ''}
          {row.fallbackReason ? ` · 回落 ${row.fallbackReason}` : ''}
        </p>
        {Array.isArray(row.annotations) && row.annotations.length > 0 && (
          <p className="surface-quiet surface-status--amber">
            {row.annotations.join(' · ')}
          </p>
        )}
      </div>
      <div className="surface-meta">
        <Badge state={pending ? 'queued' : 'done'}>{pending ? '待回填' : '已回填'}</Badge>
        <div className="u-num surface-quiet">
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
    <div className="surface-page">
      <header className="surface-header">
        <div>
          <h2 className="surface-title">路由决策</h2>
          <p className="surface-lede">
            outcome 为 null 时显示待回填，不是成功或失败。
          </p>
        </div>
        <Button size="sm" disabled={isBusy} onClick={() => resource.refresh()}>
          {isBusy ? '加载中…' : '刷新'}
        </Button>
      </header>

      {resource.status === 'degraded' && resource.error && payload !== undefined && (
        <div role="status" className="surface-status">
          暂时无法更新，保留 {capturedAt} 的结果：{errorText(resource.error)}
        </div>
      )}

      {(resource.status === 'idle' || resource.status === 'loading') && payload === undefined && (
        <p aria-live="polite" className="surface-quiet">正在读取路由决策…</p>
      )}

      {resource.status === 'error' && resource.error && payload === undefined && (
        <div role="alert" className="surface-section surface-alert">
          <p><code>/api/agos/routes</code> 未响应：{errorText(resource.error)}</p>
          <Button size="sm" onClick={() => resource.refresh()}>重试</Button>
        </div>
      )}

      {payload && (
        <section className="surface-section" aria-label="路由决策列表">
          <h3 className="success-anchor">{ROUTES_READY_COPY}</h3>
          <p className="surface-body">{formatCoverage(payload.stats)}</p>
          <p className="surface-quiet">
            {routesTierNote(payload.decisions)}
          </p>
          {payload.decisions.length === 0 ? (
            <p className="surface-quiet">还没有决策记录。成功读到空台账时这里仍会显示路由档位。</p>
          ) : (
            <ul className="surface-list">
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
