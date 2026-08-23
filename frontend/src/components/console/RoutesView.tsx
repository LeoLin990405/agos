import React, { useState } from 'react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { fetchJsonResource, ResourceHttpError, useResource } from '@/lib/useResource';
import {
  ASSEMBLE_CONFIRM_COPY,
  ASSEMBLE_COPY,
  ASSEMBLE_EMPTY_COPY,
  ASSEMBLE_HOW_COPY,
  deriveAssembleView,
  DISPATCH_BUTTON_COPY,
  DISPATCH_CONFIRM_CHECK_COPY,
  DISPATCH_COPY,
  DISPATCH_EMPTY_COPY,
  DISPATCH_NO_TOOLS_COPY,
  formatViolations,
  LIVE_DISPATCH_OFF_COPY,
  OUTCOME_CONFIRM_COPY,
  postAssembleDispatch,
  postAssembleProposal,
  postRouteOutcome,
  sourceCopy,
  TURN_TEXT_PREFIX,
  TURN_TEXT_REDACTED_COPY,
  TURN_TRUNCATED_COPY,
  type AssemblePlan,
  type DispatchRun,
} from './routes-assemble';
import {
  formatCoverage,
  outcomeLabel,
  outcomeValueCopy,
  decisionReasonCopy,
  fallbackReasonCopy,
  parseRoutesPayload,
  posteriorCopy,
  routesTierNote,
  ROUTES_READY_COPY,
  ruleReasonCopy,
  type RouteDecision,
  type RoutesPayload,
} from './routes-model';

// 路由面唯一的 GET;写端点全部在 routes-assemble.ts,本文件不发请求(见那边的锁法说明)。
const fetchRoutes = async (url: string, signal: AbortSignal): Promise<RoutesPayload> =>
  parseRoutesPayload(await fetchJsonResource<unknown>(url, signal));

function errorText(error: { status?: number; message?: string } | undefined): string {
  if (!error) return '未采集'
  if (error instanceof ResourceHttpError || typeof error.status === 'number') {
    return `HTTP ${error.status}${error.message ? ` · ${error.message}` : ''}`
  }
  return error.message || '未采集'
}

/** 操作反馈:失败走 alert,成功走 status。违约也是失败。 */
type Note = { tone: 'ok' | 'error'; text: string };
const NoteLine: React.FC<{ note: Note | undefined }> = ({ note }) => {
  if (!note) return null;
  return (
    <p role={note.tone === 'error' ? 'alert' : 'status'} className={`surface-quiet${note.tone === 'error' ? ' surface-status--amber' : ''}`}>
      {note.text}
    </p>
  );
};

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
          <Badge state={row.source === 'selector' ? 'done' : 'queued'}>{sourceCopy(row.source)}</Badge>
          <Badge state="queued">{row.role || '角色未采集'}</Badge>
        </div>
      </div>
      <div>
        <p className="surface-body">{row.taskType || '任务类型未采集'}</p>
        <p className="surface-quiet">
          候选 {(row.candidates || []).join(' / ') || '未采集'}
          {decisionReasonCopy(row) ? ` · ${decisionReasonCopy(row)}` : ''}
          {ruleReasonCopy(row.rule?.reason) ? ` · ${ruleReasonCopy(row.rule?.reason)}` : ''}
          {fallbackReasonCopy(row.fallbackReason) ? ` · 回落：${fallbackReasonCopy(row.fallbackReason)}` : row.fallbackReason ? ' · 回落：原因未识别' : ''}
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
  const [task, setTask] = useState('');
  const [confirmAssemble, setConfirmAssemble] = useState(false);
  const [confirmDispatch, setConfirmDispatch] = useState(false);
  const [confirmOutcome, setConfirmOutcome] = useState(false);
  const [proposed, setProposed] = useState<AssemblePlan | null>(null);
  const [localRun, setLocalRun] = useState<DispatchRun | null>(null);
  const [assembleNote, setAssembleNote] = useState<Note | undefined>();
  const [dispatchNote, setDispatchNote] = useState<Note | undefined>();
  const [outcomeNote, setOutcomeNote] = useState<Note | undefined>();
  // 组装段落的一切判断都在这里算出来;下面的 JSX 只渲染,不自己判断。
  const view = deriveAssembleView({ payload, proposed, localRun });

  const proposeAssemble = async (): Promise<void> => {
    if (!confirmAssemble) return;
    setAssembleNote(undefined);
    try {
      const posted = await postAssembleProposal({ task, confirm: true });
      if (!posted.ok) {
        setAssembleNote({ tone: 'error', text: posted.error });
        // 后端是先落盘再返回的:失败也要重读台账,否则屏上由旧载荷算出的句子会和 alert 打架。
        resource.refresh();
        return;
      }
      setProposed(posted.plan);
      setLocalRun(null);
      // 文案是冻结常量,不从载荷搬运:载荷里的 note 已经校验过等于它(或退役值)。
      setAssembleNote({ tone: 'ok', text: `${ASSEMBLE_COPY}。${LIVE_DISPATCH_OFF_COPY}。` });
      resource.refresh();
    } catch (caught) {
      setAssembleNote({ tone: 'error', text: caught instanceof Error ? caught.message : '组装请求失败' });
    }
  };

  const runDispatch = async (): Promise<void> => {
    if (!confirmDispatch || view.assemble === null) return;
    setDispatchNote(undefined);
    try {
      const posted = await postAssembleDispatch({ task, ref: view.assemble.id ?? '', confirm: true });
      if (!posted.ok) {
        setDispatchNote({ tone: 'error', text: posted.error });
        // 失败(含 409 不是台账最新提案)就放掉本地提案、重读台账;否则旧提案永远压着台账,每次都 409。
        setProposed(null);
        setLocalRun(null);
        resource.refresh();
        return;
      }
      setLocalRun(posted.dispatch);
      setDispatchNote({ tone: 'ok', text: `${DISPATCH_COPY}。${DISPATCH_NO_TOOLS_COPY}。` });
      resource.refresh();
    } catch (caught) {
      setDispatchNote({ tone: 'error', text: caught instanceof Error ? caught.message : '试跑请求失败' });
    }
  };

  const recordOutcome = async (ref: string, result: 'ok' | 'fail'): Promise<void> => {
    setOutcomeNote(undefined);
    try {
      const recorded = await postRouteOutcome({ ref, result, confirm: confirmOutcome });
      if (!recorded.ok) {
        setOutcomeNote({ tone: 'error', text: recorded.error });
        return;
      }
      setOutcomeNote({ tone: 'ok', text: `已回填 ${ref} = ${result === 'ok' ? '成功' : '失败'}。` });
      resource.refresh();
    } catch (caught) {
      setOutcomeNote({ tone: 'error', text: caught instanceof Error ? caught.message : '回填请求失败' });
    }
  };

  return (
    <div className="surface-page">
      <header className="surface-header">
        <div>
          <h2 className="surface-title">路由决策</h2>
          <p className="surface-lede">
            outcome 为 null 时显示待回填，不是成功或失败。只报告。
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
        <h3 className="surface-h3">组装提案</h3>
        <p className="surface-quiet">{ASSEMBLE_HOW_COPY}{payload ? ` ${posteriorCopy(payload.stats)}。` : ''}</p>
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
          {ASSEMBLE_CONFIRM_COPY}
        </label>
        <div className="surface-cluster">
          <Button size="sm" disabled={!confirmAssemble || isBusy} onClick={() => void proposeAssemble()}>
            组装提案
          </Button>
        </div>
        {view.assembleViolations.length > 0 && (
          <p role="alert" className="surface-quiet surface-status--amber">
            {formatViolations('组装', view.assembleViolations)}
          </p>
        )}
        {view.showAssembleEmpty && (
          <p className="surface-quiet">{ASSEMBLE_EMPTY_COPY}。确认后生成三角色，不换本跳会话模型。</p>
        )}
        {view.assemble && (
          <>
            {/* 整行由 deriveAssembleView 给:类别句 + 保证句(台账试跑没自报相反证据时)+ 时态句。 */}
            <p className="surface-quiet">{view.assembleLine}</p>
            <p className="surface-quiet">
              {view.assemble.label ? `任务类 ${view.assemble.label}` : '任务类未采集'}
              {view.assemble.pick ? ` · 首选 ${view.assemble.pick}` : ' · 首选未采集'}
              {` · ${sourceCopy(view.assemble.source)}`}
              {view.assemble.distinct ? ' · 评审≠实现' : ' · 评审与实现同一模型'}
            </p>
            <ul className="surface-list">
              {view.assemble.roles.map((row) => (
                <li key={row.role} className="surface-row surface-row--inline">
                  <strong className="surface-strong">{row.role}</strong>
                  <code className="surface-code">{row.model}</code>
                </li>
              ))}
            </ul>
            {(view.assemble.notes.length > 0 || view.assemble.unknownNotes > 0) && (
              <p className="surface-quiet">
                {view.assemble.notes.join(' · ')}
                {view.assemble.unknownNotes > 0 ? `${view.assemble.notes.length > 0 ? ' · ' : ''}另有 ${view.assemble.unknownNotes} 条说明与同屏角色表不一致或未识别，未显示` : ''}
              </p>
            )}
          </>
        )}
        <NoteLine note={assembleNote} />
        <label className="skills-studio-check">
          <input
            type="checkbox"
            checked={confirmDispatch}
            onChange={(event) => setConfirmDispatch(event.target.checked)}
          />
          {DISPATCH_CONFIRM_CHECK_COPY}
        </label>
        <div className="surface-cluster">
          <Button size="sm" disabled={!confirmDispatch || !view.assemble || isBusy} onClick={() => void runDispatch()}>
            {DISPATCH_BUTTON_COPY}
          </Button>
        </div>
        {view.dispatchViolations.length > 0 && (
          <p role="alert" className="surface-quiet surface-status--amber">
            {formatViolations('试跑', view.dispatchViolations)}
          </p>
        )}
        {view.showDispatchEmpty && (
          <p className="surface-quiet">{DISPATCH_EMPTY_COPY}。{DISPATCH_NO_TOOLS_COPY}。</p>
        )}
        {view.dispatchOfThis && (
          <>
            <p className="surface-quiet">{view.dispatchHeader}。{DISPATCH_NO_TOOLS_COPY}。</p>
            <ul className="surface-list">
              {view.dispatchOfThis.turns.map((row) => (
                <li key={`${row.role}:${row.model}`} className="surface-row surface-row--inline">
                  <strong className="surface-strong">{row.role}</strong>
                  <code className="surface-code">{row.model}</code>
                  <span className="surface-quiet">
                    {row.ok ? (row.redacted ? TURN_TEXT_REDACTED_COPY : `${TURN_TEXT_PREFIX}${row.text ?? ''}${row.truncated ? TURN_TRUNCATED_COPY : ''}`) : row.failure}
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}
        <NoteLine note={dispatchNote} />
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
          <NoteLine note={outcomeNote} />
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
