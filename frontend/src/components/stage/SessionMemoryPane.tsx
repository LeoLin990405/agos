import React, { useEffect, useReducer, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Chip, type ChipProps } from '@/components/ui/Chip';
import { Dot } from '@/components/ui/Dot';
import {
  fetchSessionMemory,
  formatSessionMemoryTime,
  sessionMemoryErrorMessage,
  sessionMemoryPollInterval,
  sessionMemoryUrl,
  type SessionMemoryFetch,
  type SessionMemoryItem,
  type SessionMemoryKind,
} from './session-memory-model';
import {
  PIN_EMPTY_COPY,
  PIN_METHOD_COPY,
  SESSION_KIND_LABELS,
  SESSION_MEMORY_LAYER,
  compactSessionMemoryItems,
  filterSessionMemoryByQuery,
  importanceUnit,
  sessionMemoryByKind,
  sessionMemoryByTurn,
  sessionMemoryInjectCopy,
  type SessionMemoryGroup,
} from './session-memory-presentation';
import { fetchSessionMemoryInject, postSessionMemoryInject } from './session-memory-inject-api';
import { postSessionMemoryPin } from './session-memory-pin-api';
import { fetchMemoryRelevance, postMemoryRelevance } from './session-memory-relevance-api';
import {
  INJECT_IS_NOT_VERDICT_COPY,
  RELEVANCE_CONFIRM_COPY,
  RELEVANCE_QUERY_UNCOLLECTED_COPY,
  RELEVANCE_READ_FAILED_COPY,
  canRecordRelevance,
  hitByItemId,
  relevanceLedgerCopy,
  type MemoryRelevance,
  type MemoryRelevanceHit,
} from './session-memory-rank';

const KIND_PRESENTATION: Record<SessionMemoryKind, { label: string; variant: ChipProps['variant'] }> = {
  fact: { label: '事实', variant: 'default' },
  constraint: { label: '约束', variant: 'amber' },
  preference: { label: '偏好', variant: 'purple' },
  rejected: { label: '已排除', variant: 'red' },
};

type PaneState =
  | { key: string | null; phase: 'idle'; data: undefined; error: undefined }
  | { key: string; phase: 'loading'; data: undefined; error: undefined }
  | { key: string; phase: 'ready'; data: Awaited<ReturnType<typeof fetchSessionMemory>>; error: undefined }
  | { key: string; phase: 'degraded'; data: Awaited<ReturnType<typeof fetchSessionMemory>>; error: unknown }
  | { key: string; phase: 'error'; data: undefined; error: unknown };

const isAbort = (error: unknown): boolean =>
  typeof error === 'object'
  && error !== null
  && (error as { name?: unknown }).name === 'AbortError';

const SessionMemoryRow: React.FC<{
  item: SessionMemoryItem;
  selected?: boolean;
  onSelect?: (item: SessionMemoryItem) => void;
  hit?: MemoryRelevanceHit;
  relevanceConfirm?: boolean;
  onRelevance?: (item: SessionMemoryItem, result: 'ok' | 'fail') => void;
}> = ({ item, selected = false, onSelect, hit, relevanceConfirm = false, onRelevance }) => {
  const kind = KIND_PRESENTATION[item.kind];
  const body = (
    <div className="agc-memory-row">
      <div className="agc-memory-row-head">
        <Chip variant={kind.variant}>{kind.label}</Chip>
        <span className="u-num agc-memory-meta">重要度 {item.importance}</span>
        <span
          className="viz-track agc-memory-importance"
          style={{ ['--u-p' as string]: String(importanceUnit(item.importance)) }}
          aria-hidden="true"
        >
          <span className="viz-fill is-done" />
        </span>
      </div>
      <p className="agc-memory-text">{item.text}</p>
      <div className="agc-memory-foot">
        <span className="u-num">{item.sourceTurn === 0 ? '会话开始' : `第 ${item.sourceTurn} 轮`}</span>
        <time dateTime={item.createdAt} title={item.createdAt}>{formatSessionMemoryTime(item.createdAt)}</time>
      </div>
      {hit !== undefined && (
        <span className="u-microlabel">
          {hit.method === 'lexical+posterior'
            ? `短名单 · 重合 ${hit.lexical.toFixed(2)}${hit.posterior !== null ? ` · 后验 ${hit.posterior.toFixed(2)}` : ''}`
            : hit.method === 'constraint-reserve'
              ? '约束保送，不是相关性'
              : '按重要度候补，不是相关性'}
        </span>
      )}
    </div>
  );
  const actions = onRelevance !== undefined && (
    <div className="surface-cluster">
      <Button size="sm" variant="ghost" disabled={!relevanceConfirm} onClick={() => onRelevance(item, 'ok')}>
        记有用
      </Button>
      <Button size="sm" variant="ghost" disabled={!relevanceConfirm} onClick={() => onRelevance(item, 'fail')}>
        记误召回
      </Button>
    </div>
  );
  if (onSelect === undefined) {
    return <li>{body}{actions}</li>;
  }
  return (
    <li>
      <button
        type="button"
        className={`mem-episode-row${selected ? ' is-on' : ''}`}
        aria-pressed={selected}
        onClick={() => onSelect(item)}
      >
        {body}
      </button>
      {actions}
    </li>
  );
};

export const SessionMemoryPane: React.FC<{
  sessionId: string | undefined;
  fetchImpl?: SessionMemoryFetch;
  variant?: 'workspace' | 'compact';
  query?: string;
  relevanceQuery?: string;
  selectedItemId?: string;
  onSelectItem?: (item: SessionMemoryItem) => void;
  onOpenWorkspace?: () => void;
  onItemsChange?: (texts: string[]) => void;
}> = ({
  sessionId,
  fetchImpl,
  variant = 'workspace',
  query = '',
  relevanceQuery,
  selectedItemId,
  onSelectItem,
  onOpenWorkspace,
  onItemsChange,
}) => {
  const url = sessionId === undefined || sessionId.trim() === '' ? null : sessionMemoryUrl(sessionId);
  const [generation, refresh] = useReducer((value: number) => value + 1, 0);
  const [state, setState] = useState<PaneState>({ key: null, phase: 'idle', data: undefined, error: undefined });
  const [kindFilter, setKindFilter] = useState<SessionMemoryKind | 'all'>('all');
  const [groupBy, setGroupBy] = useState<SessionMemoryGroup>('kind');
  const [injectEnabled, setInjectEnabled] = useState<boolean | undefined>();
  const [injectBusy, setInjectBusy] = useState(false);
  const [injectError, setInjectError] = useState<string>();
  const [injectConfirm, setInjectConfirm] = useState(false);
  const [pinKind, setPinKind] = useState<SessionMemoryKind>('constraint');
  const [pinText, setPinText] = useState('');
  const [pinConfirm, setPinConfirm] = useState(false);
  const [pinBusy, setPinBusy] = useState(false);
  const [relevance, setRelevance] = useState<MemoryRelevance>();
  const [relevanceError, setRelevanceError] = useState<string>();
  const [relevanceConfirm, setRelevanceConfirm] = useState(false);
  const [relevanceNotice, setRelevanceNotice] = useState<string>();
  const judgeQuery = relevanceQuery !== undefined ? relevanceQuery : query;
  const judgeBlocked = relevanceQuery !== undefined && relevanceQuery.trim() === '';
  const [pinError, setPinError] = useState<string>();

  useEffect(() => {
    setKindFilter('all');
    setGroupBy('kind');
  }, [sessionId]);

  useEffect(() => {
    if (url === null || sessionId === undefined) {
      setState({ key: null, phase: 'idle', data: undefined, error: undefined });
      return undefined;
    }

    let active = true;
    let latest: Awaited<ReturnType<typeof fetchSessionMemory>> | undefined;
    let controller: AbortController | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setState({ key: url, phase: 'loading', data: undefined, error: undefined });

    const clearTimer = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    };
    const schedule = (delay: number): void => {
      clearTimer();
      if (!active || (typeof document !== 'undefined' && document.hidden)) return;
      timer = setTimeout(() => { void run(); }, delay);
    };
    const run = async (): Promise<void> => {
      // First load / focus retry must ignore document.hidden — otherwise a
      // background tab (or CDP session that never fires visibilitychange)
      // stays forever on「正在读取会话记忆…」with no request in flight.
      if (!active) return;
      clearTimer();
      controller?.abort();
      controller = new AbortController();
      const signal = controller.signal;
      try {
        const data = await fetchSessionMemory(sessionId, signal, fetchImpl);
        if (!active || signal.aborted) return;
        latest = data;
        setState({ key: url, phase: 'ready', data, error: undefined });
        const interval = sessionMemoryPollInterval(data);
        if (interval > 0) schedule(interval);
      } catch (error) {
        if (!active || signal.aborted || isAbort(error)) return;
        setState(latest === undefined
          ? { key: url, phase: 'error', data: undefined, error }
          : { key: url, phase: 'degraded', data: latest, error });
        // A transient read error must not strand an extraction forever. Retry
        // only if the last confirmed server phase was still extracting.
        if (latest?.status === 'extracting') schedule(2_000);
      }
    };
    const onFocus = (): void => { void run(); };
    const onVisible = (): void => {
      if (typeof document !== 'undefined' && !document.hidden) void run();
    };
    if (typeof window !== 'undefined') window.addEventListener('focus', onFocus);
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisible);
    // Avoid issuing the disposable first request in React StrictMode.
    queueMicrotask(() => { if (active) void run(); });

    return () => {
      active = false;
      clearTimer();
      controller?.abort();
      if (typeof window !== 'undefined') window.removeEventListener('focus', onFocus);
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisible);
    };
  }, [fetchImpl, generation, sessionId, url]);

  useEffect(() => {
    let cancelled = false;
    void fetchSessionMemoryInject(sessionId).then(
      (status) => { if (!cancelled) { setInjectEnabled(status.enabled); setInjectError(undefined); } },
      (error) => { if (!cancelled) setInjectError(error instanceof Error ? error.message : String(error)); },
    );
    return () => { cancelled = true; };
  }, [generation, sessionId]);

  useEffect(() => {
    let cancelled = false;
    if (sessionId === undefined || sessionId.trim() === '') {
      setRelevance(undefined);
      return () => { cancelled = true; };
    }
    if (judgeBlocked) {
      setRelevance(undefined);
      setRelevanceError(undefined);
      return () => { cancelled = true; };
    }
    void fetchMemoryRelevance(sessionId, judgeQuery).then(
      (next) => { if (!cancelled) { setRelevance(next); setRelevanceError(undefined); } },
      () => { if (!cancelled) setRelevanceError(RELEVANCE_READ_FAILED_COPY); },
    );
    return () => { cancelled = true; };
  }, [generation, judgeBlocked, judgeQuery, sessionId]);

  useEffect(() => {
    if (state.phase !== 'ready' && state.phase !== 'degraded') return;
    onItemsChange?.(state.data.items.map((item) => item.text));
  }, [onItemsChange, state]);

  const current = state.key === url ? state : { key: url, phase: 'loading' as const, data: undefined, error: undefined };
  const active = current.data;
  const activeError = current.error;
  const isInitialLoading = current.phase === 'loading';

  if (url === null) {
    return <p className="agc-empty">选择一个本机会话后,这里会显示该会话提炼出的短期记忆。</p>;
  }
  if (isInitialLoading) {
    return <p className="agc-empty" aria-live="polite">正在读取会话记忆…</p>;
  }
  if (active === undefined) {
    return (
      <div className="agc-memory-state is-error" role="alert">
        <p>{sessionMemoryErrorMessage(activeError)}</p>
        <Button size="sm" variant="ghost" onClick={refresh}>重试</Button>
      </div>
    );
  }

  const extracting = active.status === 'extracting';
  const queried = filterSessionMemoryByQuery(active.items, query);
  const recordRelevance = (row: SessionMemoryItem, result: 'ok' | 'fail'): void => {
    if (sessionId === undefined || judgeBlocked) return;
    void postMemoryRelevance({
      sessionId,
      itemId: row.id,
      result,
      query: judgeQuery,
    }).then((posted) => {
      setRelevanceConfirm(false);
      setRelevanceNotice(posted.ok ? `已记录 ${row.id.slice(0, 8)} / ${result}` : posted.error);
      refresh();
    });
  };
  const compact = compactSessionMemoryItems(queried);
  const canJudgeVisible = !judgeBlocked && relevanceError === undefined
    && queried.some((item) => canRecordRelevance(hitByItemId(relevance?.hits ?? [], item.id)));
  const kindGroups = sessionMemoryByKind(queried, kindFilter);
  const turnGroups = sessionMemoryByTurn(queried, kindFilter);
  const compactMode = variant === 'compact';
  return (
    <div className="agc-memory">
      <div className="agc-memory-summary">
        <div className="agc-memory-layer">
          <span className="agc-memory-layer-name">{SESSION_MEMORY_LAYER}</span>
          <div className="agc-memory-total">
            <strong className="u-num">{active.counts.total}</strong>
            <span>条会话记忆</span>
          </div>
        </div>
        {compactMode && onOpenWorkspace !== undefined ? (
          <Button size="sm" variant="ghost" onClick={onOpenWorkspace}>在记忆台打开</Button>
        ) : (
          <Button size="sm" variant="ghost" onClick={refresh}>刷新</Button>
        )}
      </div>
      <div className="agc-memory-instrument">
        <span className="agc-memory-honesty-chip">{sessionMemoryInjectCopy(injectEnabled, active.counts.total)}</span>
        {!compactMode && (
          <span className="agc-memory-honesty-chip">
            {relevanceError
              ?? (judgeBlocked
                ? RELEVANCE_QUERY_UNCOLLECTED_COPY
                : relevance === undefined ? '相关账本未采集' : relevanceLedgerCopy(relevance))}
          </span>
        )}
        <span className="u-microlabel" title="工作层只反映本会话已提炼内容。晋升长期记忆走甲板账本，不是 Fleet Memory 真源。">便利投影</span>
        {injectError !== undefined && (
          <span className="surface-alert" role="alert">回注开关未采集：{injectError}</span>
        )}
        <label>
          <input
            type="checkbox"
            checked={injectConfirm}
            onChange={(event) => setInjectConfirm(event.target.checked)}
          />
          确认改回注
        </label>
        <Button
          size="sm"
          variant="ghost"
          disabled={injectBusy || !injectConfirm || injectEnabled === undefined}
          onClick={() => {
            if (injectEnabled === undefined) return;
            setInjectBusy(true);
            void postSessionMemoryInject(!injectEnabled).then((result) => {
              setInjectBusy(false);
              setInjectConfirm(false);
              if (result.ok) setInjectEnabled(result.enabled);
              else setInjectError(result.error);
            });
          }}
        >
          {injectEnabled === true ? '停用回注' : '启用回注'}
        </Button>
      </div>

      {active.status === 'degraded' && (
        <div className="agc-memory-notice" role="status" aria-live="polite">
          <Dot state="failed" size={6} />
          <span>抽取失败，显示上次确认内容。</span>
        </div>
      )}
      {extracting && (
        <div className="agc-memory-notice" role="status" aria-live="polite">
          <Dot state="running" size={6} />
          <span>正在后台整理最新一轮,当前显示已确认内容。</span>
        </div>
      )}
      {activeError !== undefined && (
        <p className="agc-memory-refresh-error" role="alert">
          刷新未成功,继续显示上次结果。
        </p>
      )}
      {active.skippedSensitive > 0 && (
        <p className="agc-memory-sensitive" role="status">
          有 <span className="u-num">{active.skippedSensitive}</span> 条候选因可能包含敏感信息已跳过。
        </p>
      )}

      {active.items.length === 0 ? (
        <p className="agc-empty">
          {active.status === 'empty'
            ? PIN_EMPTY_COPY
            : extracting
              ? '正在整理第一批会话记忆…'
              : '本轮没有形成可保留的事实、约束、偏好或排除项。也可确认后收进一条真实条目。'}
        </p>
      ) : queried.length === 0 ? (
        <p className="agc-empty">没有命中情节条目。星图检索不会在这里编造对应文档。</p>
      ) : compactMode ? (
        <>
          <ul className="agc-memory-list">
            {compact.items.map((item) => (
              <SessionMemoryRow item={item} key={item.id} />
            ))}
          </ul>
          {compact.hidden > 0 && (
            <p className="agc-memory-honesty">还有 {compact.hidden} 条在记忆台。</p>
          )}
        </>
      ) : (
        <>
          <div className="agc-memory-filters">
            <button type="button" className={`btn btn-sm ${kindFilter === 'all' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setKindFilter('all')}>
              全部 ({queried.length})
            </button>
            {([
              ['constraint', '约束', active.counts.constraint],
              ['preference', '偏好', active.counts.preference],
              ['fact', '事实', active.counts.fact],
              ['rejected', '已排除', active.counts.rejected],
            ] as const).map(([kind, label, count]) => (
              <button
                key={kind}
                type="button"
                className={`btn btn-sm ${kindFilter === kind ? 'btn-primary' : 'btn-ghost'}`}
                onClick={() => setKindFilter(kind)}
              >
                {label} ({count})
              </button>
            ))}
            <button type="button" className={`btn btn-sm ${groupBy === 'kind' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setGroupBy('kind')}>
              按种类
            </button>
            <button type="button" className={`btn btn-sm ${groupBy === 'turn' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setGroupBy('turn')}>
              按轮次
            </button>
          </div>
          <div className="mem-skills-shortlist">
            <span className="u-microlabel">{relevance?.note ?? INJECT_IS_NOT_VERDICT_COPY}</span>
            {canJudgeVisible && (
              <label className="u-microlabel">
                <input
                  type="checkbox"
                  checked={relevanceConfirm}
                  onChange={(event) => setRelevanceConfirm(event.target.checked)}
                />
                {RELEVANCE_CONFIRM_COPY}
              </label>
            )}
            {judgeBlocked && (
              <span className="u-microlabel">{RELEVANCE_QUERY_UNCOLLECTED_COPY}</span>
            )}
            {relevance?.collected === true && !canJudgeVisible && !judgeBlocked && queried.length > 0 && (
              <span className="u-microlabel">本跳短名单没有可记的曝光，不能记相关</span>
            )}
            {relevanceNotice !== undefined && <span className="u-microlabel">{relevanceNotice}</span>}
          </div>
          {groupBy === 'kind'
            ? kindGroups.map((group) => (
              <div key={group.kind}>
                <div className="agc-memory-group-head">
                  <span>{SESSION_KIND_LABELS[group.kind]}</span>
                  <span className="u-num">{group.items.length}</span>
                </div>
                <ul className="agc-memory-list">
                  {group.items.map((item) => {
                    const hit = hitByItemId(relevance?.hits ?? [], item.id);
                    return (
                    <SessionMemoryRow
                      item={item}
                      key={item.id}
                      selected={selectedItemId === item.id}
                      onSelect={onSelectItem}
                      hit={hit}
                      relevanceConfirm={relevanceConfirm}
                      onRelevance={canRecordRelevance(hit) ? recordRelevance : undefined}
                    />
                    );
                  })}
                </ul>
              </div>
            ))
            : turnGroups.map((group) => (
              <div key={group.sourceTurn}>
                <div className="agc-memory-group-head">
                  <span>{group.sourceTurn === 0 ? '会话开始' : `第 ${group.sourceTurn} 轮`}</span>
                  <span className="u-num">{group.items.length}</span>
                </div>
                <ul className="agc-memory-list">
                  {group.items.map((item) => {
                    const hit = hitByItemId(relevance?.hits ?? [], item.id);
                    return (
                    <SessionMemoryRow
                      item={item}
                      key={item.id}
                      selected={selectedItemId === item.id}
                      onSelect={onSelectItem}
                      hit={hit}
                      relevanceConfirm={relevanceConfirm}
                      onRelevance={canRecordRelevance(hit) ? recordRelevance : undefined}
                    />
                    );
                  })}
                </ul>
              </div>
            ))}
        </>
      )}
      {!compactMode && (
        <div className="desk-gate">
          <span className="u-microlabel">{PIN_METHOD_COPY}</span>
          <select
            className="mem-working-select"
            value={pinKind}
            onChange={(event) => setPinKind(event.target.value as SessionMemoryKind)}
          >
            <option value="constraint">约束</option>
            <option value="preference">偏好</option>
            <option value="fact">事实</option>
            <option value="rejected">已排除</option>
          </select>
          <input
            className="mem-working-select"
            value={pinText}
            placeholder="一条真实约束或偏好，不要例句"
            onChange={(event) => setPinText(event.target.value)}
          />
          <label>
            <input
              type="checkbox"
              checked={pinConfirm}
              onChange={(event) => setPinConfirm(event.target.checked)}
            />
            确认收进本会话
          </label>
          <Button
            size="sm"
            variant="ghost"
            disabled={pinBusy || !pinConfirm || pinText.trim() === '' || sessionId === undefined}
            onClick={() => {
              if (sessionId === undefined) return;
              setPinBusy(true);
              void postSessionMemoryPin({
                sessionId,
                kind: pinKind,
                text: pinText.trim(),
              }).then((result) => {
                setPinBusy(false);
                setPinConfirm(false);
                if (result.ok) {
                  setPinText('');
                  setPinError(undefined);
                  refresh();
                } else {
                  setPinError(result.error);
                }
              });
            }}
          >
            收进会话记忆
          </Button>
          {pinError !== undefined && (
            <span className="surface-alert" role="alert">{pinError}</span>
          )}
        </div>
      )}
    </div>
  );
};
