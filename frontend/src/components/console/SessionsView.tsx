import React, { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { Dot } from '@/components/ui/Dot';
import { Button } from '@/components/ui/Button';
import { formatRelative } from '@/lib/time';
import {
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

export const SessionsView: React.FC<SessionsViewProps> = ({ onSelectSession }) => {
  const [filterQuery, setFilterQuery] = useState('');
  const sessions = useSyncExternalStore(sessionsStore.subscribe, sessionsStore.getSnapshot);
  const connection = useSyncExternalStore(liveConnectionStore.subscribe, liveConnectionStore.getSnapshot);

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
                      <td>{row.agentPreset !== '' ? row.agentPreset : '未采集'}</td>
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
