import React, { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { Dot } from '@/components/ui/Dot';
import { Button } from '@/components/ui/Button';
import { formatRelative } from '@/lib/time';
import {
  conversationStore,
  ensureLiveConnection,
  liveConnectionStore,
  refreshSessions,
  sessionsStore,
  type SessionSummaryRow,
} from '@/stores/live';
import { deriveSessionsSurface } from './sessions-view-state';
import type { StateLamp } from '@/design-system/tokens';

export interface SessionsViewProps {
  onSelectSession?: (id: string) => void;
}

function sessionLamp(row: SessionSummaryRow): StateLamp {
  if (row.running) return 'running';
  if (row.blank) return 'queued';
  return 'done';
}

const QuietState: React.FC<{ title: string; detail: React.ReactNode }> = ({ title, detail }) => (
  <div
    role="status"
    className="surface-empty"
  >
    <div className="surface-empty-title">
      {title}
    </div>
    <div>{detail}</div>
  </div>
);

/**
 * preset 与 descriptor label 语义不同(112/112 共存会话里全不同),只能「缺席才回落」,不拼接不覆盖。
 * label 可能是整段任务文,同批子代理靠尾缀 `#k (role)` 区分 —— 截断保头保尾,不能只截头(135 个不同 label
 * 从头截 24 字只剩 102 个)。三种「没有」要分得清:preset 与 label 都没有 / 这行没打开过(fold 快照不存在)。
 */
const LABEL_HEAD = 12;
const LABEL_TAIL = 10;
export type LabelState = { opened: false } | { opened: true; label: string | undefined };
export function shortenLabel(label: string): string {
  const chars = Array.from(label);
  if (chars.length <= LABEL_HEAD + LABEL_TAIL + 1) return label;
  return `${chars.slice(0, LABEL_HEAD).join('')}…${chars.slice(-LABEL_TAIL).join('')}`;
}
export function presetCell(agentPreset: string, state: LabelState): React.ReactNode {
  if (agentPreset !== '') return agentPreset;
  if (!state.opened) return <span title="会话没打开过,fold 快照不存在,子代理标签无从读取">未采集（未打开）</span>;
  if (state.label === undefined || state.label === '') return '未采集';
  return (
    <span title={state.label} style={{ whiteSpace: 'nowrap' }}>
      {shortenLabel(state.label)}<span className="surface-quiet" style={{ fontSize: '11px' }}> · 子代理标签</span>
    </span>
  );
}

export const SessionsView: React.FC<SessionsViewProps> = ({ onSelectSession }) => {
  const [filterQuery, setFilterQuery] = useState('');
  const sessions = useSyncExternalStore(sessionsStore.subscribe, sessionsStore.getSnapshot);
  const connection = useSyncExternalStore(liveConnectionStore.subscribe, liveConnectionStore.getSnapshot);
  // W14:Agent preset 缺席时回落到 fold 快照顶层的 subagentLabel。fold 只对打开过的会话存在,没点开的行
  // 显示「未采集（未打开）」——全量回落要读 session.list 行的 projections.values.subagent.label,那在冻结的
  // src/stores/live.ts 里,本档不动。订阅快照只取各行 label 拼成一个串:label 没变就不重渲染整张表。
  const labelKey = useSyncExternalStore(
    conversationStore.subscribe,
    () => sessions.rows.map((r) => { const st = conversationStore.getSnapshot(r.sessionId); return st.snapshot === undefined ? '\u0000' : (st.snapshot.subagentLabel ?? ''); }).join('\u0001'),
  );
  const labelStates = useMemo(() => {
    const parts = labelKey.split('\u0001');
    return new Map(sessions.rows.map((r, i) => [r.sessionId, (parts[i] === '\u0000' ? { opened: false } : { opened: true, label: parts[i] === '' ? undefined : parts[i] }) as LabelState]));
  }, [labelKey, sessions.rows]);
  const labelStateOf = (sessionId: string): LabelState => labelStates.get(sessionId) ?? { opened: false };

  useEffect(() => {
    ensureLiveConnection();
  }, []);

  const filtered = useMemo(() => {
    const query = filterQuery.trim().toLocaleLowerCase();
    if (query === '') return sessions.rows;
    return sessions.rows.filter((row) => [row.title, row.sessionId, row.cwd]
      .some((value) => value.toLocaleLowerCase().includes(query)));
  }, [filterQuery, sessions.rows]);

  const surface = deriveSessionsSurface({
    rowCount: sessions.rows.length,
    loadedAt: sessions.loadedAt,
    error: sessions.error,
    connection,
  });
  const loadedRelative = formatRelative(sessions.loadedAt);

  return (
    <div className="surface-page">
      <div className="surface-header is-baseline">
        <div>
          <h2 className="surface-title">会话</h2>
          <p className="surface-lede">
            数据源: <code>session.list</code> 与 <code>events.mux</code>
          </p>
        </div>
        <input
          type="search"
          aria-label="过滤会话"
          placeholder="按主题、ID 或工作目录过滤"
          className="form-input form-input--filter"
          value={filterQuery}
          onChange={(event) => setFilterQuery(event.target.value)}
        />
      </div>

      {surface.kind === 'loading' && <QuietState title="正在读取会话" detail="等待 session.list 返回。" />}

      {surface.kind === 'error' && (
        <QuietState
          title="会话列表读取失败"
          detail={(
            <span className="surface-cluster">
              <span><code>session.list</code> 未答复: {sessions.error}</span>
              <Button variant="ghost" size="sm" onClick={() => { void refreshSessions(); }}>重试</Button>
            </span>
          )}
        />
      )}

      {surface.kind === 'empty' && surface.reason === 'connecting' && (
        <QuietState
          title="正在连接事件信道"
          detail={<>会话列表已读取，正在等待 <code>events.mux</code>。</>}
        />
      )}

      {surface.kind === 'empty' && surface.reason === 'offline' && (
        <QuietState
          title="事件信道未连接"
          detail={<>当前无法确认实时状态；<code>events.mux</code> 尚未建立连接。</>}
        />
      )}

      {surface.kind === 'empty' && surface.reason === 'online' && (
        <QuietState
          title="暂无会话"
          detail={<>宿主已连接，<code>session.list</code> 返回了空列表。</>}
        />
      )}

      {surface.kind === 'rows' && (
        <>
          {(surface.notice === 'refresh-error' || surface.notice === 'offline') && (
            <div
              role="status"
              className="surface-status surface-status--amber"
            >
              {surface.notice === 'refresh-error'
                ? <>会话刷新失败，保留{loadedRelative !== '' ? `${loadedRelative}读取` : '上次读取'}的数据: {sessions.error}</>
                : <>事件信道未连接；显示{loadedRelative !== '' ? `${loadedRelative}读取` : '上次读取'}的列表，运行状态可能不是最新。</>}
            </div>
          )}
          {surface.notice === 'connecting' && (
            <div role="status" className="surface-quiet">
              正在连接 <code>events.mux</code>；当前继续显示 session.list 返回的会话。
            </div>
          )}

          {filtered.length > 0 && <div className="telemetry-table-wrap">
            <table className="telemetry-table">
              <thead>
                <tr>
                  <th className="table-col-state">状态</th>
                  <th>主题 / 会话 ID / 工作目录</th>
                  <th className="table-col-preset">Agent preset</th>
                  <th className="table-col-time">更新时间</th>
                  <th className="table-col-action">操作</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((row) => {
                  const relative = formatRelative(row.updatedAt);
                  return (
                    <tr key={row.sessionId} className={row.running ? 'is-running' : undefined}>
                      <td><Dot state={sessionLamp(row)} /></td>
                      <td>
                        <div className="table-title">{row.title}</div>
                        <div className="table-id">
                          #{row.sessionId}{row.cwd !== '' ? ` · ${row.cwd}` : ''}
                        </div>
                      </td>
                      <td>{presetCell(row.agentPreset, labelStateOf(row.sessionId))}</td>
                      <td>{relative !== '' ? relative : '未采集'}</td>
                      <td className="table-cell-end">
                        <Button variant="ghost" size="sm" onClick={() => onSelectSession?.(row.sessionId)}>
                          接入
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>}

          {filtered.length === 0 && (
            <QuietState title="没有匹配的会话" detail="调整过滤条件后再试。" />
          )}
        </>
      )}
    </div>
  );
};
