/**
 * W22(a):侧栏「回收站」折叠区。展开时只读 GET /api/agos/session-trash 一次(fetch-once),
 * 不提供恢复/删除动作——恢复是文件操作,走终端;这里只说清「删了什么、还在不在、日志没覆盖多少」。
 */
import React, { useState } from 'react';
import { fetchJsonResource, useResource } from '@/lib/useResource';
import { parseSessionTrashPayload, presentText, pruneText, sessionTrashSummary, type SessionTrashPayload } from './session-trash-model';

const fetchTrash = async (url: string, signal: AbortSignal): Promise<SessionTrashPayload> =>
  parseSessionTrashPayload(await fetchJsonResource<unknown>(url, signal));

export const SessionTrashPanel: React.FC = () => {
  const [expanded, setExpanded] = useState(false);
  const res = useResource<SessionTrashPayload>({ url: '/api/agos/session-trash', enabled: expanded, fetcher: fetchTrash });
  const p = res.data;
  return (
    <section className="session-section" aria-labelledby="session-trash-heading">
      <button
        type="button"
        className="session-archive-toggle"
        aria-expanded={expanded}
        aria-controls="session-trash-list"
        onClick={() => setExpanded((v) => !v)}
      >
        <span className="u-microlabel" id="session-trash-heading">回收站{p !== undefined ? ` (${p.count})` : ''}</span>
        <svg className="session-archive-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} aria-hidden="true">
          <path d="m9 18 6-6-6-6" />
        </svg>
      </button>
      {expanded && (
        <div id="session-trash-list" data-session-trash>
          {p === undefined && res.status === 'error' && res.error !== undefined && (
            <div className="session-action-error" role="alert">回收站清单未响应:{res.error.status !== undefined ? `HTTP ${res.error.status} · ` : ''}{res.error.message}</div>
          )}
          {p === undefined && res.status !== 'error' && <div className="session-empty-note">正在读取删除日志…</div>}
          {p !== undefined && (<>
            <div className="session-empty-note">{sessionTrashSummary(p)}</div>
            {p.items.map((it) => (
              <div key={`${it.sessionId}:${it.at ?? ''}`} className="session-empty-note" data-trash-present={String(it.present)}>
                <span className="u-num">{it.at !== undefined ? new Date(it.at).toLocaleString('zh-CN', { hour12: false }) : '时间未记录'}</span>
                {' · '}{it.sessionId.slice(0, 16)}{it.project !== undefined ? ` · ${it.project}` : ''}
                {' · '}{presentText(it)}{' · '}{pruneText(it)}
              </div>
            ))}
          </>)}
        </div>
      )}
    </section>
  );
};
