import React, { useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Chip } from '@/components/ui/Chip';
import { fetchJsonResource, useResource } from '@/lib/useResource';
import { conversationStore, fetchSkillList } from '@/stores/live';
import {
  SKILLS_USAGE_READY_COPY,
  clipDescription,
  filterCatalog,
  mergeRpcCatalog,
  parseSkillsPayload,
  usageDenominatorReady,
  type SkillCatalogEntry,
  type SkillUsageStat,
  type SkillsPayload,
} from '@/components/console/skills-model';
import {
  parseEvolveReport,
  POSTERIOR_METHOD_COPY,
  type ProposeReport,
} from '@/components/console/skills-evolve';
import { postSkillOutcome } from '@/components/console/skills-studio-api';
import {
  RERANK_UNAVAILABLE_COPY,
  SHORTLIST_METHOD_COPY,
  shortlistSkills,
} from '@/components/console/skills-ranking';

const fetchSkills = async (url: string, signal: AbortSignal): Promise<SkillsPayload> =>
  parseSkillsPayload(await fetchJsonResource<unknown>(url, signal));

function failureText(status: number | undefined, message: string | undefined): string {
  return `${status === undefined ? '' : `HTTP ${status} · `}${message ?? '请求失败'}`;
}

export const MemorySkillsDock: React.FC<{
  query: string;
  sessionId?: string;
  selectedName?: string;
  onSelect: (skill: SkillCatalogEntry, usage: SkillUsageStat | undefined) => void;
  onOpenAudit?: () => void;
  onOpenStudio?: () => void;
}> = ({ query, sessionId, selectedName, onSelect, onOpenAudit, onOpenStudio }) => {
  const resource = useResource<SkillsPayload>({
    url: '/api/agos/skills',
    intervalMs: 60_000,
    refreshOnFocus: true,
    fetcher: fetchSkills,
  });
  const payload = resource.data;
  const [rpcOverlay, setRpcOverlay] = useState<Array<{
    name: string;
    description: string;
    whenToUse?: string;
    modelInvocable: boolean;
  }>>([]);
  const [recordConfirm, setRecordConfirm] = useState(false);
  const [recordNotice, setRecordNotice] = useState<string>();

  useEffect(() => {
    const id = sessionId?.trim() || conversationStore.activeSessionId();
    if (!id) {
      setRpcOverlay([]);
      return undefined;
    }
    let cancelled = false;
    void fetchSkillList(id).then((rows) => {
      if (!cancelled) setRpcOverlay(rows);
    });
    return () => { cancelled = true; };
  }, [payload?.at, sessionId]);

  const merged = useMemo(
    () => mergeRpcCatalog(payload?.catalog ?? [], rpcOverlay),
    [payload?.catalog, rpcOverlay],
  );
  const catalog = useMemo(
    () => filterCatalog(merged, query),
    [merged, query],
  );
  const shortlist = useMemo(() => shortlistSkills(merged, query), [merged, query]);
  const evolveResource = useResource<ProposeReport>({
    url: query.trim() === '' ? null : `/api/agos/skills/evolve?query=${encodeURIComponent(query.trim())}`,
    fetcher: async (url, signal) => parseEvolveReport(await fetchJsonResource<unknown>(url, signal)),
  });
  const evolveHits = evolveResource.data?.hits ?? [];
  const usageReady = usageDenominatorReady(payload?.usageMeta);
  const busy = resource.status === 'idle' || resource.status === 'loading';

  return (
    <div className="mem-skills-dock">
      <div className="mem-working-head">
        <span className="mem-layer-title">技能层</span>
        <div className="surface-instrument">
          <Chip>{SHORTLIST_METHOD_COPY}</Chip>
          <Chip>{POSTERIOR_METHOD_COPY}</Chip>
          <Chip>{RERANK_UNAVAILABLE_COPY}</Chip>
          <Chip>
            {evolveResource.data === undefined
              ? '胜负账本未采集'
              : `胜负账本 ${evolveResource.data.evidenceRows} 行`}
          </Chip>
        </div>
        <div className="mem-working-actions">
          <span className="u-num" style={{ fontSize: '11px', color: 'var(--text-tertiary)' }}>
            {payload === undefined ? '目录未采集' : `${catalog.length} / ${payload.catalog?.length ?? 0}`}
          </span>
          {usageReady && <Chip>{SKILLS_USAGE_READY_COPY}</Chip>}
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => resource.refresh('/api/agos/skills?refresh=1')}>
            {busy && payload === undefined ? '读取中…' : '刷新'}
          </Button>
          {onOpenAudit && (
            <Button size="sm" variant="ghost" onClick={onOpenAudit}>打开审计</Button>
          )}
          {onOpenStudio && (
            <Button size="sm" variant="ghost" onClick={onOpenStudio}>打开工作室</Button>
          )}
        </div>
      </div>

      {payload === undefined && (resource.status === 'idle' || resource.status === 'loading') && (
        <p className="agc-empty" aria-live="polite">正在读取技能目录…</p>
      )}
      {payload === undefined && resource.status === 'error' && resource.error && (
        <div className="agc-memory-state is-error" role="alert">
          <p><code>/api/agos/skills</code> 未响应：{failureText(resource.error.status, resource.error.message)}</p>
          <Button size="sm" variant="ghost" onClick={() => resource.refresh()}>重试</Button>
        </div>
      )}
      {payload?.error && (
        <p className="agc-memory-honesty" role="alert">{payload.error}</p>
      )}
      {payload && !payload.error && catalog.length === 0 && (
        <p className="agc-empty">
          {query.trim() === '' ? '技能目录为空。' : '没有命中技能。这里不把技能画成星图节点。'}
        </p>
      )}
      {payload && !payload.error && (evolveHits.length > 0 || shortlist.length > 0) && (
        <div className="mem-skills-shortlist">
          <span className="u-microlabel">
            {evolveResource.data && evolveResource.data.matchingLabel > 0 ? POSTERIOR_METHOD_COPY : SHORTLIST_METHOD_COPY}
          </span>
          <label className="u-microlabel">
            <input
              type="checkbox"
              checked={recordConfirm}
              onChange={(event) => setRecordConfirm(event.target.checked)}
            />
            确认记录人工胜负
          </label>
          {recordNotice !== undefined && <span className="u-microlabel">{recordNotice}</span>}
          <ul className="agc-memory-list">
            {(evolveHits.length > 0 ? evolveHits : shortlist).map((hit) => {
              const row = merged.find((item) => item.name === hit.name);
              if (!row) return null;
              const lexical = 'lexical' in hit ? hit.lexical : hit.score;
              const posterior = 'posterior' in hit ? hit.posterior : undefined;
              return (
                <li key={`short:${row.root ?? ''}:${row.name}`}>
                  <button
                    type="button"
                    className={`mem-skill-row${selectedName === row.name ? ' is-on' : ''}`}
                    aria-pressed={selectedName === row.name}
                    onClick={() => onSelect(row, usageReady ? payload.usage?.[row.name] : undefined)}
                  >
                    <strong>{row.name}</strong>
                    <span>{clipDescription(row.description || '（无 description）')}</span>
                    <span className="u-microlabel">
                      短名单 · 重合 {lexical.toFixed(2)}
                      {posterior !== undefined ? ` · 后验 ${posterior.toFixed(2)}` : ''}
                    </span>
                  </button>
                  {query.trim() !== '' && (
                    <div className="surface-cluster">
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={!recordConfirm}
                        onClick={() => {
                          void postSkillOutcome({
                            label: query.trim(),
                            skill: row.name,
                            result: 'ok',
                          }).then((result) => {
                            setRecordConfirm(false);
                            setRecordNotice('ok' in result ? `已记录 ${row.name} / ok` : result.error);
                            evolveResource.refresh();
                          });
                        }}
                      >
                        记胜
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={!recordConfirm}
                        onClick={() => {
                          void postSkillOutcome({
                            label: query.trim(),
                            skill: row.name,
                            result: 'fail',
                          }).then((result) => {
                            setRecordConfirm(false);
                            setRecordNotice('ok' in result ? `已记录 ${row.name} / fail` : result.error);
                            evolveResource.refresh();
                          });
                        }}
                      >
                        记负
                      </Button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}
      {payload && !payload.error && catalog.length > 0 && (
        <ul className="agc-memory-list">
          {catalog.map((row) => (
            <li key={`${row.root ?? ''}:${row.name}`}>
              <button
                type="button"
                className={`mem-skill-row${selectedName === row.name ? ' is-on' : ''}`}
                aria-pressed={selectedName === row.name}
                onClick={() => onSelect(row, usageReady ? payload.usage?.[row.name] : undefined)}
              >
                <strong>{row.name}</strong>
                <span>{clipDescription(row.description || '（无 description）')}</span>
                <span className="u-microlabel">
                  {row.modelInvocable ? '模型可调' : '仅用户'}
                  {row.servedToModel === false ? ' · 未进模型根' : ''}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};
