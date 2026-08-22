import React, { useState } from 'react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { fetchJsonResource, ResourceHttpError, useResource } from '@/lib/useResource';
import {
  ASSEMBLE_COPY,
  ASSEMBLE_EMPTY_COPY,
  LIVE_DISPATCH_OFF_COPY,
  OUTCOME_CONFIRM_COPY,
  parseAssemblePlan,
  postRouteOutcome,
  type AssemblePlan,
} from './routes-assemble';
import {
  formatCoverage,
  outcomeLabel,
  outcomeValueCopy,
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

function DecisionRow({
  row,
  canRecord,
  busy,
  onRecord,
}: {
  row: RouteDecision;
  canRecord: boolean;
  busy: boolean;
  onRecord: (ref: string, result: 'ok' | 'fail') => void;
}) {
  const pending = outcomeLabel(row.outcome) === 'pending';
  const ref = typeof row.id === 'string' ? row.id : '';
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
        <Badge state={pending ? 'queued' : row.outcome === 'fail' ? 'failed' : 'done'}>
          {outcomeValueCopy(row.outcome)}
        </Badge>
        <div className="u-num surface-quiet">
          {typeof row.confidence === 'number' ? `置信 ${row.confidence}` : '置信未采集'}
        </div>
        {pending && ref !== '' && (
          <div className="surface-cluster">
            <Button size="sm" disabled={!canRecord || busy} onClick={() => onRecord(ref, 'ok')}>记成功</Button>
            <Button size="sm" disabled={!canRecord || busy} onClick={() => onRecord(ref, 'fail')}>记失败</Button>
          </div>
        )}
      </div>
    </li>
  );
}

export const RoutesView: React.FC = () => {
  const resource = useResource<RoutesPayload>({ url: '/api/agos/routes', fetcher: fetchRoutes });
  const payload = resource.data;
  const isBusy = resource.status === 'idle' || resource.status === 'loading';
  const capturedAt = resource.at ? new Date(resource.at).toLocaleString('zh-CN', { hour12: false }) : '未采集';
  const listedAssemble = parseAssemblePlan(payload?.assemble ?? null);
  const [task, setTask] = useState('');
  const [confirmAssemble, setConfirmAssemble] = useState(false);
  const [confirmOutcome, setConfirmOutcome] = useState(false);
  const [proposed, setProposed] = useState<AssemblePlan | null>(null);
  const [assembleNote, setAssembleNote] = useState<string | undefined>();
  const [outcomeNote, setOutcomeNote] = useState<string | undefined>();
  const assemble = proposed ?? listedAssemble;

  const proposeAssemble = async (): Promise<void> => {
    if (!confirmAssemble) return;
    setAssembleNote(undefined);
    try {
      const response = await fetch('/api/agos/routes/assemble', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ task, confirm: true }),
      });
      const payload = await response.json() as unknown;
      if (!response.ok) {
        const error = payload && typeof payload === 'object' && 'error' in payload && typeof payload.error === 'string'
          ? payload.error
          : `HTTP ${response.status}`;
        setAssembleNote(error);
        return;
      }
      const plan = parseAssemblePlan(payload);
      if (!plan) {
        setAssembleNote('组装响应缺少角色名单。');
        return;
      }
      setProposed(plan);
      setAssembleNote(`${plan.note}。${plan.live}。`);
      resource.refresh();
    } catch (caught) {
      setAssembleNote(caught instanceof Error ? caught.message : '组装失败');
    }
  };

  const recordOutcome = async (ref: string, result: 'ok' | 'fail'): Promise<void> => {
    setOutcomeNote(undefined);
    const recorded = await postRouteOutcome({ ref, result, confirm: confirmOutcome });
    if (!recorded.ok) {
      setOutcomeNote(recorded.error);
      return;
    }
    setOutcomeNote(`已回填 ${ref} = ${result === 'ok' ? '成功' : '失败'}。`);
    resource.refresh();
  };

  return (
    <div className="surface-page">
      <header className="surface-header">
        <div>
          <h2 className="surface-title">路由决策</h2>
          <p className="surface-lede">
            outcome 为 null 时显示待回填，不是成功或失败。只报告。{ASSEMBLE_COPY}。{LIVE_DISPATCH_OFF_COPY}。
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

      <section className="surface-section" aria-label="组装提案">
        <h3 className="surface-h3">{ASSEMBLE_COPY}</h3>
        <p className="surface-quiet">{LIVE_DISPATCH_OFF_COPY}。小模型只给任务类和首选模型，后验再填三角色。不调用路由 decide 接口。</p>
        <label className="skills-studio-field">
          <span className="u-microlabel">任务描述</span>
          <textarea
            className="form-input"
            rows={3}
            value={task}
            onChange={(event) => setTask(event.target.value)}
            placeholder="例如：给这段 SQL 做一次规划、实现和独立评审"
          />
        </label>
        <label className="skills-studio-check">
          <input
            type="checkbox"
            checked={confirmAssemble}
            onChange={(event) => setConfirmAssemble(event.target.checked)}
          />
          确认只生成组装提案，不换当前会话模型
        </label>
        <div className="surface-cluster">
          <Button size="sm" disabled={!confirmAssemble || isBusy} onClick={() => void proposeAssemble()}>
            组装提案
          </Button>
        </div>
        {!assemble && (
          <p className="surface-quiet">{ASSEMBLE_EMPTY_COPY}。确认后生成三角色，不换当前会话模型。</p>
        )}
        {assemble && (
          <>
            <p className="surface-quiet">
              {assemble.label ? `任务类 ${assemble.label}` : '任务类未采集'}
              {assemble.pick ? ` · 首选 ${assemble.pick}` : ''}
              {assemble.source ? ` · ${assemble.source === 'fallback' ? '静态回落' : '选择器'}` : ''}
              {assemble.distinct === true ? ' · 评审≠实现' : ''}
            </p>
            <ul className="surface-list">
              {assemble.roles.map((row) => (
                <li key={row.role} className="surface-row surface-row--inline">
                  <strong className="surface-strong">{row.role}</strong>
                  <code className="surface-code">{row.model}</code>
                </li>
              ))}
            </ul>
            {assemble.notes && assemble.notes.length > 0 && (
              <p className="surface-quiet">{assemble.notes.join(' · ')}</p>
            )}
          </>
        )}
        {assembleNote && <p role="status" className="surface-quiet">{assembleNote}</p>}
      </section>

      {payload && (
        <section className="surface-section" aria-label="路由决策列表">
          <h3 className="success-anchor">{ROUTES_READY_COPY}</h3>
          <p className="surface-body">{formatCoverage(payload.stats)}</p>
          <p className="surface-quiet">
            {routesTierNote(payload.decisions)}
          </p>
          <label className="skills-studio-check">
            <input
              type="checkbox"
              checked={confirmOutcome}
              onChange={(event) => setConfirmOutcome(event.target.checked)}
            />
            {OUTCOME_CONFIRM_COPY}
          </label>
          {outcomeNote && <p role="status" className="surface-quiet">{outcomeNote}</p>}
          {payload.decisions.length === 0 ? (
            <p className="surface-quiet">还没有决策记录。成功读到空台账时这里仍会显示路由档位。</p>
          ) : (
            <ul className="surface-list">
              {[...payload.decisions].reverse().map((row, index) => (
                <DecisionRow
                  key={`${row.id ?? row.ts ?? 't'}:${row.pick ?? ''}:${index}`}
                  row={row}
                  canRecord={confirmOutcome}
                  busy={isBusy}
                  onRecord={(ref, result) => void recordOutcome(ref, result)}
                />
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  );
};
