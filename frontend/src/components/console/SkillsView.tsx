import React, { useState } from 'react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { fetchJsonResource, useResource } from '@/lib/useResource';
import { filterSkillFindings, parseSkillsPayload, type SkillAuditRoot, type SkillFinding, type SkillsPayload } from './skills-model';

const panelStyle: React.CSSProperties = {
  borderTop: '1px solid var(--border-subtle)',
  padding: '16px 0',
};

const quietText: React.CSSProperties = {
  color: 'var(--text-tertiary)',
  fontSize: '12px',
  lineHeight: 1.6,
};

const fetchSkills = async (url: string, signal: AbortSignal): Promise<SkillsPayload> =>
  parseSkillsPayload(await fetchJsonResource<unknown>(url, signal));

function failureText(status: number | undefined, message: string): string {
  return `${status === undefined ? '' : `HTTP ${status} · `}${message}`;
}

function FindingRow({ finding }: { finding: SkillFinding }) {
  const state = finding.sev === 'error' ? 'failed' : finding.sev === 'warn' ? 'running' : 'queued';
  return (
    <li style={{ display: 'grid', gridTemplateColumns: '88px minmax(120px, 180px) 1fr', gap: '12px', alignItems: 'start', padding: '8px 0', borderTop: '1px solid var(--border-dim)', fontSize: '12px' }}>
      <Badge state={state}>{finding.sev || '未分级'}</Badge>
      <span className="u-num" style={{ color: 'var(--text-secondary)', overflowWrap: 'anywhere' }}>{finding.check || '未采集'}</span>
      <span style={{ minWidth: 0 }}>
        {finding.skill && <strong style={{ display: 'block', color: 'var(--text-primary)', overflowWrap: 'anywhere' }}>{finding.skill}</strong>}
        {finding.msg && <span style={{ color: 'var(--text-secondary)', lineHeight: 1.5 }}>{finding.msg}</span>}
      </span>
    </li>
  );
}

function AuditRoot({ audit, query }: { audit: SkillAuditRoot; query: string }) {
  if (audit.error) {
    return (
      <section style={panelStyle} aria-label={audit.root}>
        <code style={{ color: 'var(--text-primary)', overflowWrap: 'anywhere' }}>{audit.root}</code>
        <p role="alert" style={{ ...quietText, color: 'var(--state-failed)', margin: '8px 0 0' }}>{audit.error}</p>
      </section>
    );
  }

  const findings = Array.isArray(audit.findings) ? audit.findings : undefined;
  const visible = findings === undefined ? undefined : filterSkillFindings(findings, query);
  const skills = typeof audit.skills === 'number' ? audit.skills : undefined;
  const errors = typeof audit.counts?.error === 'number' ? audit.counts.error : undefined;
  const warnings = typeof audit.counts?.warn === 'number' ? audit.counts.warn : undefined;

  return (
    <section style={panelStyle} aria-label={audit.root}>
      <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '8px' }}>
        <code style={{ color: 'var(--text-primary)', overflowWrap: 'anywhere', marginRight: 'auto' }}>{audit.root}</code>
        <Badge state="queued">技能 {skills ?? '未采集'}</Badge>
        <Badge state={errors === undefined ? 'queued' : errors > 0 ? 'failed' : 'done'}>错误 {errors ?? '未采集'}</Badge>
        <Badge state={warnings === undefined ? 'queued' : warnings > 0 ? 'running' : 'done'}>警告 {warnings ?? '未采集'}</Badge>
      </div>

      {visible === undefined ? (
        <p style={{ ...quietText, margin: '10px 0 0' }}>审计未返回检查明细。</p>
      ) : visible.length === 0 ? (
        <p style={{ ...quietText, margin: '10px 0 0' }}>
          {query.trim() === '' ? '当前根没有发现问题。' : '当前筛选没有匹配项。'}
        </p>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0, margin: '12px 0 0' }}>
          {visible.map((finding, index) => <FindingRow key={`${finding.skill ?? ''}:${finding.check ?? ''}:${index}`} finding={finding} />)}
        </ul>
      )}
    </section>
  );
}

export const SkillsView: React.FC = () => {
  const [query, setQuery] = useState('');
  const resource = useResource<SkillsPayload>({ url: '/api/agos/skills', fetcher: fetchSkills });
  const payload = resource.data;
  const roots = payload?.roots;
  const isBusy = resource.status === 'idle' || resource.status === 'loading';
  const isRefreshing = resource.status === 'loading' && payload !== undefined;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '18px' }}>
      <header style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '16px', flexWrap: 'wrap' }}>
        <div>
          <h2 style={{ fontSize: '16px', fontWeight: 800, margin: 0 }}>技能审计</h2>
          <p style={{ ...quietText, margin: '4px 0 0' }}>只读数据源 <code>/api/agos/skills</code></p>
        </div>
        <div style={{ display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap' }}>
          <label>
            <span className="u-microlabel" style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clipPath: 'inset(50%)' }}>筛选审计结果</span>
            <input
              type="search"
              placeholder="筛选检查、技能或消息"
              className="form-input"
              style={{ width: '220px', height: '32px' }}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          <Button
            size="sm"
            disabled={isBusy}
            onClick={() => resource.refresh('/api/agos/skills?refresh=1')}
          >
            {isBusy ? '审计中…' : '重新审计'}
          </Button>
        </div>
      </header>

      {(resource.status === 'idle' || resource.status === 'loading') && payload === undefined && (
        <p aria-live="polite" style={quietText}>正在读取技能审计结果…</p>
      )}

      {resource.status === 'error' && resource.error && payload === undefined && (
        <div role="alert" style={{ ...panelStyle, color: 'var(--state-failed)', fontSize: '12px' }}>
          <p style={{ margin: '0 0 10px' }}><code>/api/agos/skills</code> 未响应：{failureText(resource.error.status, resource.error.message)}</p>
          <Button size="sm" onClick={() => resource.refresh()}>重试</Button>
        </div>
      )}

      {resource.status === 'degraded' && resource.error && payload !== undefined && (
        <div role="status" style={{ padding: '9px 12px', border: '1px solid var(--state-running-border)', borderRadius: '6px', color: 'var(--text-secondary)', fontSize: '12px' }}>
          暂时无法更新，保留 {resource.at ? new Date(resource.at).toLocaleString() : '上次'} 的结果：{failureText(resource.error.status, resource.error.message)}
        </div>
      )}

      {payload?.error && (
        <div role="alert" style={{ ...panelStyle, color: 'var(--state-failed)', fontSize: '12px', lineHeight: 1.6 }}>
          {payload.error}
          {payload.librarian && <div style={{ color: 'var(--text-tertiary)', marginTop: '4px' }}><code>{payload.librarian}</code></div>}
        </div>
      )}

      {payload && !payload.error && roots?.length === 0 && (
        <div style={panelStyle}>
          <p style={{ ...quietText, margin: 0 }}>没有可审计的技能根。服务端只检查已存在的配置根。</p>
          {payload.librarian && <p style={{ ...quietText, margin: '6px 0 0' }}>审计器：<code>{payload.librarian}</code></p>}
        </div>
      )}

      {payload && !payload.error && roots !== undefined && roots.length > 0 && (
        <div aria-busy={isRefreshing}>
          {roots.map((root, index) => <AuditRoot key={`${root.root}:${index}`} audit={root} query={query} />)}
          {payload.at && <p className="u-num" style={{ ...quietText, margin: '8px 0 0' }}>审计时间 {new Date(payload.at).toLocaleString()}</p>}
        </div>
      )}
    </div>
  );
};
