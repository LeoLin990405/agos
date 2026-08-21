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
    style={{
      padding: '44px 24px',
      textAlign: 'center',
      border: '1px dashed var(--border-subtle)',
      borderRadius: '12px',
      color: 'var(--text-tertiary)',
    }}
  >
    <div style={{ fontSize: '14px', fontWeight: 700, color: 'var(--text-secondary)', marginBottom: '7px' }}>
      {title}
    </div>
    <div style={{ fontSize: '12.5px' }}>{detail}</div>
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
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
      <div style={{ display: 'flex', alignItems: 'end', justifyContent: 'space-between', gap: '16px' }}>
        <div>
          <h2 style={{ fontSize: '16px', fontWeight: 800 }}>会话</h2>
          <p style={{ fontSize: '12px', color: 'var(--text-tertiary)', marginTop: '2px' }}>
            数据源: <code>session.list</code> 与 <code>events.mux</code>
          </p>
        </div>
        <input
          type="search"
          aria-label="过滤会话"
          placeholder="按主题、ID 或工作目录过滤"
          className="form-input"
          style={{ width: '250px', height: '32px', padding: '4px 10px', fontSize: '11.5px' }}
          value={filterQuery}
          onChange={(event) => setFilterQuery(event.target.value)}
        />
      </div>

      {surface.kind === 'loading' && <QuietState title="正在读取会话" detail="等待 session.list 返回。" />}

      {surface.kind === 'error' && (
        <QuietState
          title="会话列表读取失败"
          detail={(
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap', justifyContent: 'center' }}>
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
              style={{
                padding: '9px 12px',
                border: '1px solid var(--accent-amber)',
                borderRadius: '8px',
                color: 'var(--text-secondary)',
                fontSize: '12px',
              }}
            >
              {surface.notice === 'refresh-error'
                ? <>会话刷新失败，保留{loadedRelative !== '' ? `${loadedRelative}读取` : '上次读取'}的数据: {sessions.error}</>
                : <>事件信道未连接；显示{loadedRelative !== '' ? `${loadedRelative}读取` : '上次读取'}的列表，运行状态可能不是最新。</>}
            </div>
          )}
          {surface.notice === 'connecting' && (
            <div role="status" style={{ color: 'var(--text-tertiary)', fontSize: '12px' }}>
              正在连接 <code>events.mux</code>；当前继续显示 session.list 返回的会话。
            </div>
          )}

          {filtered.length > 0 && <div className="telemetry-table-wrap">
            <table className="telemetry-table">
              <thead>
                <tr>
                  <th style={{ width: '54px' }}>状态</th>
                  <th>主题 / 会话 ID / 工作目录</th>
                  <th style={{ width: '150px' }}>Agent preset</th>
                  <th style={{ width: '110px' }}>更新时间</th>
                  <th style={{ width: '90px', textAlign: 'right' }}>操作</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((row) => {
                  const relative = formatRelative(row.updatedAt);
                  return (
                    <tr key={row.sessionId}>
                      <td><Dot state={sessionLamp(row)} /></td>
                      <td>
                        <div style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{row.title}</div>
                        <div style={{ fontFamily: 'var(--font-mono)', fontSize: '10.5px', color: 'var(--text-tertiary)', marginTop: '2px' }}>
                          #{row.sessionId}{row.cwd !== '' ? ` · ${row.cwd}` : ''}
                        </div>
                      </td>
                      <td>{row.agentPreset !== '' ? row.agentPreset : '未采集'}</td>
                      <td>{relative !== '' ? relative : '未采集'}</td>
                      <td style={{ textAlign: 'right' }}>
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
