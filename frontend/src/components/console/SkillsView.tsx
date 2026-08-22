import React, { useEffect, useMemo, useState } from 'react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { fetchJsonResource, useResource } from '@/lib/useResource';
import { conversationStore, fetchSkillList } from '@/stores/live';
import {
  clipDescription,
  filterCatalog,
  filterSkillFindings,
  groupCatalogByCategory,
  mergeRpcCatalog,
  neverUsedCount,
  parseSkillsPayload,
  sortCatalog,
  SKILLS_USAGE_READY_COPY,
  usageDenominatorReady,
  vanishedUsageSkills,
  type SkillAuditRoot,
  type SkillCatalogEntry,
  type SkillFinding,
  type SkillsPayload,
  type SkillsSort,
  type SkillsTab,
} from './skills-model';

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
        <Badge state={audit.servedToModel ? 'running' : 'queued'}>
          {audit.servedToModel ? '模型在用' : '控制台-only'}
        </Badge>
        {audit.rank != null && <Badge state="queued">rank {audit.rank}</Badge>}
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

function CatalogRow({
  row,
  usage,
}: {
  row: SkillCatalogEntry;
  usage: { count: number; lastAt: number } | undefined;
}) {
  const count = usage?.count ?? 0;
  const lastAt = usage?.lastAt;
  return (
    <li style={{ display: 'grid', gridTemplateColumns: 'minmax(140px, 220px) 1fr auto', gap: '12px', alignItems: 'start', padding: '10px 0', borderTop: '1px solid var(--border-dim)', fontSize: '12px' }}>
      <div>
        <strong style={{ color: 'var(--text-primary)', overflowWrap: 'anywhere' }}>{row.name}</strong>
        <div style={{ marginTop: '6px', display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
          <Badge state={row.modelInvocable ? 'done' : 'queued'}>{row.modelInvocable ? '模型可调' : '仅用户'}</Badge>
          {row.shadowed && <Badge state={row.drifted ? 'running' : 'queued'}>{row.drifted ? '遮蔽·漂移' : '遮蔽'}</Badge>}
          {row.pathsGateCandidate && <Badge state="queued">paths 候选</Badge>}
          {!row.servedToModel && <Badge state="queued">未进模型根</Badge>}
        </div>
      </div>
      <p style={{ margin: 0, color: 'var(--text-secondary)', lineHeight: 1.55 }}>{clipDescription(row.description || '（无 description）')}</p>
      <div className="u-num" style={{ color: 'var(--text-tertiary)', textAlign: 'right', whiteSpace: 'nowrap' }}>
        {count === 0 ? (
          <span>从未调用</span>
        ) : (
          <>
            <div>×{count}</div>
            {lastAt ? <div>{new Date(lastAt).toLocaleString()}</div> : null}
          </>
        )}
      </div>
    </li>
  );
}

export const SkillsView: React.FC = () => {
  const [query, setQuery] = useState('');
  const [tab, setTab] = useState<SkillsTab>('catalog');
  const [sort, setSort] = useState<SkillsSort>('name');
  const [rpcOverlay, setRpcOverlay] = useState<Array<{ name: string; description: string; whenToUse?: string; modelInvocable: boolean }>>([]);
  const resource = useResource<SkillsPayload>({ url: '/api/agos/skills', fetcher: fetchSkills });
  const payload = resource.data;
  const roots = payload?.roots;
  const isBusy = resource.status === 'idle' || resource.status === 'loading';
  const isRefreshing = resource.status === 'loading' && payload !== undefined;

  useEffect(() => {
    const sessionId = conversationStore.activeSessionId();
    if (!sessionId) {
      setRpcOverlay([]);
      return;
    }
    let cancelled = false;
    void fetchSkillList(sessionId).then((rows) => {
      if (!cancelled) setRpcOverlay(rows);
    });
    return () => { cancelled = true; };
  }, [payload?.at]);

  const catalogBase = payload?.catalog ?? [];
  const catalogMerged = useMemo(
    () => mergeRpcCatalog(catalogBase, rpcOverlay),
    [catalogBase, rpcOverlay],
  );
  const filtered = useMemo(
    () => sortCatalog(filterCatalog(catalogMerged, query), sort, payload?.usage),
    [catalogMerged, query, sort, payload?.usage],
  );
  const groups = useMemo(() => groupCatalogByCategory(filtered), [filtered]);
  const unused = neverUsedCount(catalogMerged, payload?.usage);
  const vanished = useMemo(
    () => vanishedUsageSkills(catalogMerged, payload?.usage),
    [catalogMerged, payload?.usage],
  );
  const [vanishedOpen, setVanishedOpen] = useState(false);
  const consistency = payload?.consistency;
  const budget = payload?.budget;
  const usageReady = usageDenominatorReady(payload?.usageMeta);
  const unreadRoots = payload?.usageMeta?.errors?.length ?? 0;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '18px' }}>
      <header style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '16px', flexWrap: 'wrap' }}>
        <div>
          <h2 style={{ fontSize: '16px', fontWeight: 800, margin: 0 }}>技能库</h2>
          <p style={{ ...quietText, margin: '4px 0 0' }}>
            目录来自根并集审计；会话内 <code>skill.list</code> 可覆盖 modelInvocable
          </p>
        </div>
        <div style={{ display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', gap: '4px' }}>
            <Button size="sm" onClick={() => setTab('catalog')} disabled={tab === 'catalog'}>目录</Button>
            <Button size="sm" onClick={() => setTab('audit')} disabled={tab === 'audit'}>审计</Button>
          </div>
          <label>
            <span className="u-microlabel" style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clipPath: 'inset(50%)' }}>搜索技能</span>
            <input
              type="search"
              placeholder={tab === 'catalog' ? '搜索名称或描述' : '筛选检查、技能或消息'}
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
            {isBusy ? '加载中…' : '重新扫描'}
          </Button>
        </div>
      </header>

      {consistency?.summary && (
        <div
          role="status"
          style={{
            padding: '10px 12px',
            border: '1px solid var(--border-subtle)',
            borderRadius: '6px',
            background: 'var(--bg-elevated, transparent)',
            color: 'var(--text-secondary)',
            fontSize: '12px',
            lineHeight: 1.55,
          }}
        >
          {consistency.summary}
          <span style={{ color: 'var(--text-tertiary)' }}> — 只报告，不自动合并。</span>
        </div>
      )}

      {(resource.status === 'idle' || resource.status === 'loading') && payload === undefined && (
        <p aria-live="polite" style={quietText}>正在读取技能库…</p>
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

      {payload && !payload.error && tab === 'catalog' && (
        <div aria-busy={isRefreshing} style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', alignItems: 'center' }}>
            <Badge state="queued">共 {catalogMerged.length}</Badge>
            {/* 「从未调用」是拿 usageMeta.files/events 这个样本下的判决。样本只有 6 个
                会话 / 0 次调用时,383 全是「从未调用」几乎是必然的 —— 不把分母亮出来,
                读者会当成「这 383 个 skill 确实没人用」(2026-08-21 验收 P1)。*/}
            <Badge state="queued">
              从未调用 {unused}
              {payload?.usageMeta != null && (
                <span style={{ opacity: 0.75 }}>
                  {` · 样本 ${payload.usageMeta.files ?? 0} 会话 / ${payload.usageMeta.events ?? 0} 次调用`}
                </span>
              )}
            </Badge>
            {usageReady && (
              <Badge state="done">{SKILLS_USAGE_READY_COPY}</Badge>
            )}
            {unreadRoots > 0 && (
              <Badge state="running">{unreadRoots} 个根不可读</Badge>
            )}
            {budget?.indexTokensEstimate != null && (
              <Badge state={(budget.indexTokensEstimate ?? 0) > (budget.indexBudgetTarget ?? 1000) ? 'running' : 'done'}>
                索引≈{budget.indexTokensEstimate} tok / 目标 {budget.indexBudgetTarget ?? 1000}
              </Badge>
            )}
            <label style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', color: 'var(--text-secondary)' }}>
              排序
              <select
                className="form-input"
                style={{ height: '28px' }}
                value={sort}
                onChange={(event) => setSort(event.target.value as SkillsSort)}
              >
                <option value="name">名称</option>
                <option value="recent">最近用过</option>
                <option value="never">从未用过优先</option>
              </select>
            </label>
          </div>

          <p style={{ ...quietText, margin: 0 }}>
            「从未用过」是使用率信号，不是删除判决。
            {payload.usageMeta?.note ? ` ${payload.usageMeta.note}` : ''}
            {payload.usageMeta?.roots && payload.usageMeta.roots.length > 0
              ? ` 实扫根: ${payload.usageMeta.roots.join(' · ')}`
              : ''}
          </p>

          {vanished.length > 0 && (
            <div style={panelStyle}>
              <button
                type="button"
                onClick={() => setVanishedOpen((open) => !open)}
                style={{ background: 'none', border: 0, padding: 0, cursor: 'pointer', color: 'var(--text-secondary)', fontSize: '12px' }}
              >
                另有 {vanished.length} 个技能有调用证据但已不在任何根里
              </button>
              {vanishedOpen && (
                <ul style={{ listStyle: 'none', padding: 0, margin: '8px 0 0', fontSize: '12px' }}>
                  {vanished.map((name) => (
                    <li key={name} style={{ padding: '3px 0' }}>
                      <code style={{ color: 'var(--text-primary)' }}>{name}</code>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {budget?.topExpensiveDescriptions && budget.topExpensiveDescriptions.length > 0 && (
            <section style={panelStyle} aria-label="索引预算">
              <h3 style={{ fontSize: '13px', margin: '0 0 8px', fontWeight: 700 }}>索引预算 · Top 描述成本</h3>
              <p style={{ ...quietText, margin: '0 0 8px' }}>
                业界压缩实验：description −48% 后约 86% 表现持平或变好。此处只建议，不改 frontmatter。
              </p>
              <ul style={{ listStyle: 'none', padding: 0, margin: 0, fontSize: '12px' }}>
                {budget.topExpensiveDescriptions.slice(0, 8).map((row) => (
                  <li key={row.name} style={{ padding: '4px 0', color: 'var(--text-secondary)', display: 'flex', gap: '10px' }}>
                    <code style={{ color: 'var(--text-primary)' }}>{row.name}</code>
                    <span className="u-num">{row.descChars} 字符</span>
                    <span style={{ color: 'var(--text-tertiary)' }}>建议压约 {row.suggestedCompressPct ?? 48}%</span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {groups.length === 0 ? (
            <p style={quietText}>没有匹配的技能。</p>
          ) : (
            groups.map((group) => (
              <section key={group.category} style={panelStyle} aria-label={group.category}>
                <h3 style={{ fontSize: '13px', margin: 0, fontWeight: 700 }}>
                  {group.category}
                  <span className="u-num" style={{ ...quietText, marginLeft: '8px' }}>{group.items.length}</span>
                </h3>
                <ul style={{ listStyle: 'none', padding: 0, margin: '8px 0 0' }}>
                  {group.items.map((row) => (
                    <CatalogRow key={row.name} row={row} usage={payload.usage?.[row.name]} />
                  ))}
                </ul>
              </section>
            ))
          )}

          {payload.at && <p className="u-num" style={{ ...quietText, margin: 0 }}>扫描时间 {new Date(payload.at).toLocaleString()}</p>}
        </div>
      )}

      {payload && !payload.error && tab === 'audit' && (
        <div aria-busy={isRefreshing}>
          {roots?.length === 0 ? (
            <div style={panelStyle}>
              <p style={{ ...quietText, margin: 0 }}>没有可审计的技能根。服务端只检查已存在的配置根。</p>
              {payload.librarian && <p style={{ ...quietText, margin: '6px 0 0' }}>审计器：<code>{payload.librarian}</code></p>}
            </div>
          ) : (
            roots?.map((root, index) => <AuditRoot key={`${root.root}:${index}`} audit={root} query={query} />)
          )}
          {payload.at && <p className="u-num" style={{ ...quietText, margin: '8px 0 0' }}>审计时间 {new Date(payload.at).toLocaleString()}</p>}
        </div>
      )}
    </div>
  );
};
