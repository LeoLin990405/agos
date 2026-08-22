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
import { SkillsStudio } from './SkillsStudio';
import {
  CALL_IS_NOT_VERDICT_COPY,
  CATALOG_TRIM_OFF_COPY,
  parseEvolveReport,
  POSTERIOR_METHOD_COPY,
  type ProposeReport,
} from './skills-evolve';
import { RERANK_UNAVAILABLE_COPY, SHORTLIST_METHOD_COPY, shortlistSkills } from './skills-ranking';

const fetchSkills = async (url: string, signal: AbortSignal): Promise<SkillsPayload> =>
  parseSkillsPayload(await fetchJsonResource<unknown>(url, signal));

function failureText(status: number | undefined, message: string): string {
  return `${status === undefined ? '' : `HTTP ${status} · `}${message}`;
}

function FindingRow({ finding }: { finding: SkillFinding }) {
  const state = finding.sev === 'error' ? 'failed' : finding.sev === 'warn' ? 'running' : 'queued';
  return (
    <li className="surface-row surface-row--finding">
      <Badge state={state}>{finding.sev || '未分级'}</Badge>
      <span className="u-num surface-body">{finding.check || '未采集'}</span>
      <span>
        {finding.skill && <strong className="surface-strong">{finding.skill}</strong>}
        {finding.msg && <span className="surface-body">{finding.msg}</span>}
      </span>
    </li>
  );
}

function AuditRoot({ audit, query }: { audit: SkillAuditRoot; query: string }) {
  if (audit.error) {
    return (
      <section className="surface-section" aria-label={audit.root}>
        <code className="surface-code">{audit.root}</code>
        <p role="alert" className="surface-quiet surface-alert">{audit.error}</p>
      </section>
    );
  }

  const findings = Array.isArray(audit.findings) ? audit.findings : undefined;
  const visible = findings === undefined ? undefined : filterSkillFindings(findings, query);
  const skills = typeof audit.skills === 'number' ? audit.skills : undefined;
  const errors = typeof audit.counts?.error === 'number' ? audit.counts.error : undefined;
  const warnings = typeof audit.counts?.warn === 'number' ? audit.counts.warn : undefined;

  return (
    <section className="surface-section" aria-label={audit.root}>
      <div className="surface-cluster">
        <code className="surface-code">{audit.root}</code>
        <Badge state={audit.servedToModel ? 'running' : 'queued'}>
          {audit.servedToModel ? '模型在用' : '控制台-only'}
        </Badge>
        {audit.rank != null && <Badge state="queued">rank {audit.rank}</Badge>}
        <Badge state="queued">技能 {skills ?? '未采集'}</Badge>
        <Badge state={errors === undefined ? 'queued' : errors > 0 ? 'failed' : 'done'}>错误 {errors ?? '未采集'}</Badge>
        <Badge state={warnings === undefined ? 'queued' : warnings > 0 ? 'running' : 'done'}>警告 {warnings ?? '未采集'}</Badge>
      </div>

      {visible === undefined ? (
        <p className="surface-quiet">审计未返回检查明细。</p>
      ) : visible.length === 0 ? (
        <p className="surface-quiet">
          {query.trim() === '' ? '当前根没有发现问题。' : '当前筛选没有匹配项。'}
        </p>
      ) : (
        <ul className="surface-list">
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
    <li className="surface-row surface-row--3">
      <div>
        <strong className="surface-strong">{row.name}</strong>
        <div className="surface-cluster">
          <Badge state={row.modelInvocable ? 'done' : 'queued'}>{row.modelInvocable ? '模型可调' : '仅用户'}</Badge>
          {row.shadowed && <Badge state={row.drifted ? 'running' : 'queued'}>{row.drifted ? '遮蔽·漂移' : '遮蔽'}</Badge>}
          {row.pathsGateCandidate && <Badge state="queued">paths 候选</Badge>}
          {!row.servedToModel && <Badge state="queued">未进模型根</Badge>}
        </div>
      </div>
      <p className="surface-body">{clipDescription(row.description || '（无 description）')}</p>
      <div className="u-num surface-meta">
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

export const SkillsView: React.FC<{
  initialTab?: SkillsTab;
  initialSkill?: string;
}> = ({ initialTab = 'catalog', initialSkill }) => {
  const [query, setQuery] = useState('');
  const [tab, setTab] = useState<SkillsTab>(initialTab);
  const [studioName, setStudioName] = useState(initialSkill ?? '');
  const [sort, setSort] = useState<SkillsSort>('name');
  const [rpcOverlay, setRpcOverlay] = useState<Array<{ name: string; description: string; whenToUse?: string; modelInvocable: boolean }>>([]);
  const resource = useResource<SkillsPayload>({ url: '/api/agos/skills', fetcher: fetchSkills });
  const payload = resource.data;
  const roots = payload?.roots;
  const isBusy = resource.status === 'idle' || resource.status === 'loading';
  const isRefreshing = resource.status === 'loading' && payload !== undefined;

  useEffect(() => {
    setTab(initialTab);
  }, [initialTab]);

  useEffect(() => {
    if (!initialSkill) return;
    setStudioName(initialSkill);
    setTab('studio');
  }, [initialSkill]);

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
  const shortlist = useMemo(() => shortlistSkills(catalogMerged, query), [catalogMerged, query]);
  const evolveResource = useResource<ProposeReport>({
    url: tab === 'catalog' && query.trim() !== ''
      ? `/api/agos/skills/evolve?query=${encodeURIComponent(query.trim())}`
      : null,
    fetcher: async (url, signal) => parseEvolveReport(await fetchJsonResource<unknown>(url, signal)),
  });
  const evolveHits = evolveResource.data?.hits ?? [];
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
    <div className="surface-page">
      <header className="surface-header">
        <div>
          <h2 className="surface-title">技能库</h2>
          <p className="surface-lede">
            目录来自根并集审计；会话内 <code>skill.list</code> 可覆盖 modelInvocable。工作室只写模型根，审计台不动。
            {SHORTLIST_METHOD_COPY}。{POSTERIOR_METHOD_COPY}。{CALL_IS_NOT_VERDICT_COPY}。{RERANK_UNAVAILABLE_COPY}。
          </p>
        </div>
        <div className="surface-toolbar">
          <div className="surface-cluster">
            <Button size="sm" onClick={() => setTab('catalog')} disabled={tab === 'catalog'}>目录</Button>
            <Button size="sm" onClick={() => setTab('audit')} disabled={tab === 'audit'}>审计</Button>
            <Button size="sm" onClick={() => setTab('studio')} disabled={tab === 'studio'}>工作室</Button>
          </div>
          {tab !== 'studio' && (
          <label>
            <span className="u-sr-only">搜索技能</span>
            <input
              type="search"
              placeholder={tab === 'catalog' ? '搜索名称或描述' : '筛选检查、技能或消息'}
              className="form-input form-input--search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          )}
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
          className="surface-status"
        >
          {consistency.summary}
          <span className="surface-quiet"> — 只报告，不自动合并。</span>
        </div>
      )}

      {(resource.status === 'idle' || resource.status === 'loading') && payload === undefined && (
        <p aria-live="polite" className="surface-quiet">正在读取技能库…</p>
      )}

      {resource.status === 'error' && resource.error && payload === undefined && (
        <div role="alert" className="surface-section surface-alert">
          <p><code>/api/agos/skills</code> 未响应：{failureText(resource.error.status, resource.error.message)}</p>
          <Button size="sm" onClick={() => resource.refresh()}>重试</Button>
        </div>
      )}

      {resource.status === 'degraded' && resource.error && payload !== undefined && (
        <div role="status" className="surface-status">
          暂时无法更新，保留 {resource.at ? new Date(resource.at).toLocaleString() : '上次'} 的结果：{failureText(resource.error.status, resource.error.message)}
        </div>
      )}

      {payload?.error && (
        <div role="alert" className="surface-section surface-alert">
          {payload.error}
          {payload.librarian && <div className="surface-quiet"><code>{payload.librarian}</code></div>}
        </div>
      )}

      {payload && !payload.error && tab === 'catalog' && (
        <div aria-busy={isRefreshing} className="surface-stack">
          <div className="surface-cluster">
            <Badge state="queued">共 {catalogMerged.length}</Badge>
            {/* 「从未调用」是拿 usageMeta.files/events 这个样本下的判决。样本只有 6 个
                会话 / 0 次调用时,383 全是「从未调用」几乎是必然的 —— 不把分母亮出来,
                读者会当成「这 383 个 skill 确实没人用」(2026-08-21 验收 P1)。*/}
            <Badge state="queued">
              从未调用 {unused}
              {payload?.usageMeta != null && (
                <span>
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
              <>
                <Badge state={(budget.indexTokensEstimate ?? 0) > (budget.indexBudgetTarget ?? 1000) ? 'running' : 'done'}>
                  索引≈{budget.indexTokensEstimate} tok / 目标 {budget.indexBudgetTarget ?? 1000}
                </Badge>
                <span className="viz-track skills-budget-track" aria-hidden="true">
                  <span
                    className={`viz-fill${(budget.indexTokensEstimate ?? 0) > (budget.indexBudgetTarget ?? 1000) ? ' is-hot' : ' is-done'}`}
                    style={{
                      ['--u-p' as string]: Math.min(1, (budget.indexTokensEstimate ?? 0) / Math.max(1, budget.indexBudgetTarget ?? 1000)),
                    }}
                  />
                </span>
              </>
            )}
            <label className="surface-sort">
              排序
              <select
                className="form-input form-input--sm"
                value={sort}
                onChange={(event) => setSort(event.target.value as SkillsSort)}
              >
                <option value="name">名称</option>
                <option value="recent">最近用过</option>
                <option value="never">从未用过优先</option>
              </select>
            </label>
          </div>

          <p className="surface-quiet">
            「从未用过」是使用率信号，不是删除判决。
            {payload.usageMeta?.note ? ` ${payload.usageMeta.note}` : ''}
            {payload.usageMeta?.roots && payload.usageMeta.roots.length > 0
              ? ` 实扫根: ${payload.usageMeta.roots.join(' · ')}`
              : ''}
          </p>

          {vanished.length > 0 && (
            <div className="surface-section">
              <button
                type="button"
                onClick={() => setVanishedOpen((open) => !open)}
                className="surface-linkish"
              >
                另有 {vanished.length} 个技能有调用证据但已不在任何根里
              </button>
              {vanishedOpen && (
                <ul className="surface-list">
                  {vanished.map((name) => (
                    <li key={name}>
                      <code className="surface-code">{name}</code>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {budget?.topExpensiveDescriptions && budget.topExpensiveDescriptions.length > 0 && (
            <section className="surface-section" aria-label="索引预算">
              <h3 className="surface-h3">索引预算 · Top 描述成本</h3>
              <p className="surface-quiet">
                业界压缩实验：description −48% 后约 86% 表现持平或变好。此处只建议，不改 frontmatter。
              </p>
              <ul className="surface-list">
                {(() => {
                  const top = budget.topExpensiveDescriptions.slice(0, 8);
                  const costMax = Math.max(1, ...top.map((item) => item.descChars));
                  return top.map((row) => (
                  <li key={row.name} className="surface-row surface-row--inline">
                    <code className="surface-code">{row.name}</code>
                    <span className="u-num">{row.descChars} 字符</span>
                    <span className="viz-track skills-cost-track" aria-hidden="true">
                      <span className="viz-fill" style={{ ['--u-p' as string]: row.descChars / costMax }} />
                    </span>
                    <span className="surface-quiet">建议压约 {row.suggestedCompressPct ?? 48}%</span>
                  </li>
                  ));
                })()}
              </ul>
            </section>
          )}

          {(evolveHits.length > 0 || shortlist.length > 0) && (
            <section className="surface-section" aria-label="词面短名单">
              <h3 className="surface-h3">
                {evolveResource.data && evolveResource.data.matchingLabel > 0 ? POSTERIOR_METHOD_COPY : SHORTLIST_METHOD_COPY}
              </h3>
              <p className="surface-quiet">
                {evolveResource.data?.catalogTrim.copy ?? CATALOG_TRIM_OFF_COPY}
                {' '}
                {evolveResource.data?.rerank?.copy ?? RERANK_UNAVAILABLE_COPY}
              </p>
              <ul className="surface-list">
                {(evolveHits.length > 0 ? evolveHits : shortlist).map((hit) => {
                  const name = hit.name;
                  const row = catalogMerged.find((item) => item.name === name);
                  if (!row) return null;
                  const lexical = 'lexical' in hit ? hit.lexical : hit.score;
                  const posterior = 'posterior' in hit ? hit.posterior : undefined;
                  const evidence = 'evidence' in hit ? hit.evidence : undefined;
                  return (
                    <li key={`short:${row.name}`} className="surface-row surface-row--3">
                      <div>
                        <strong className="surface-strong">{row.name}</strong>
                        <div className="surface-cluster">
                          <Badge state="queued">重合 {lexical.toFixed(2)}</Badge>
                          {posterior !== undefined && <Badge state="queued">后验 {posterior.toFixed(2)}</Badge>}
                          {evidence && (evidence.s + evidence.f) > 0 && (
                            <Badge state="done">胜负 {evidence.s}/{evidence.s + evidence.f}</Badge>
                          )}
                        </div>
                      </div>
                      <p className="surface-body">{clipDescription(row.description || '（无 description）')}</p>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          setStudioName(row.name);
                          setTab('studio');
                        }}
                      >
                        在工作室打开
                      </Button>
                    </li>
                  );
                })}
              </ul>
            </section>
          )}

          {groups.length === 0 ? (
            <p className="surface-quiet">没有匹配的技能。</p>
          ) : (
            groups.map((group) => (
              <section key={group.category} className="surface-section" aria-label={group.category}>
                <h3 className="surface-h3">
                  {group.category}
                  <span className="u-num surface-quiet">{group.items.length}</span>
                </h3>
                <ul className="surface-list">
                  {group.items.map((row) => (
                    <CatalogRow key={row.name} row={row} usage={payload.usage?.[row.name]} />
                  ))}
                </ul>
              </section>
            ))
          )}

          {payload.at && <p className="u-num surface-quiet">扫描时间 {new Date(payload.at).toLocaleString()}</p>}
        </div>
      )}

      {payload && !payload.error && tab === 'audit' && (
        <div aria-busy={isRefreshing}>
          {roots?.length === 0 ? (
            <div className="surface-section">
              <p className="surface-quiet">没有可审计的技能根。服务端只检查已存在的配置根。</p>
              {payload.librarian && <p className="surface-quiet">审计器：<code>{payload.librarian}</code></p>}
            </div>
          ) : (
            roots?.map((root, index) => <AuditRoot key={`${root.root}:${index}`} audit={root} query={query} />)
          )}
          {payload.at && <p className="u-num surface-quiet">审计时间 {new Date(payload.at).toLocaleString()}</p>}
        </div>
      )}

      {tab === 'studio' && (
        <SkillsStudio
          catalogNames={catalogMerged.map((row) => row.name)}
          initialName={studioName}
          onCreated={() => resource.refresh('/api/agos/skills?refresh=1')}
        />
      )}
    </div>
  );
};
