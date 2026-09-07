import React, { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { AppTopbar } from '@/components/layout/AppTopbar';
import { Chip } from '@/components/ui/Chip';
import { Button } from '@/components/ui/Button';
import { CanvasGraph } from '@/components/graph/CanvasGraph';
import { GraphInspector } from '@/components/graph/GraphInspector';
import { GraphControls } from '@/components/graph/GraphControls';
import type { MemoryNodeData } from '@/components/graph/mock-graph-data';
import { SessionMemoryPane } from '@/components/stage/SessionMemoryPane';
import { fetchSessionMemory, type SessionMemoryItem } from '@/components/stage/session-memory-model';
import { STORE_UNREAD_COPY } from '@/components/stage/session-memory-rank';
import type { SkillCatalogEntry, SkillUsageStat } from '@/components/console/skills-model';
import { MemorySkillsDock } from '@/components/graph/MemorySkillsDock';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { conversationStore, sessionsStore } from '@/stores/live';
import { useResource } from '@/lib/useResource';
import {
  consumeMemoryIntent,
  resolveWorkingSessionId,
  type MemoryIntent,
} from './memory-workspace-model';
import {
  fetchLinkSuggestionsResource,
  fetchMemoryGraphResource,
  fetchMemorySearchResource,
  type ApiMemoryGraph,
  type LinkSuggestionsResponse,
  type MemorySearchResponse,
} from './memory-graph-api';
import { adaptRealGraph, deriveMemorySearchPresentation } from './memory-graph-model';
import {
  ATLAS_HUB_CAP,
  ATLAS_SPOKE_CAP,
  revealedCap,
  deriveGraphEngineering,
  egoNeighborhood,
  listSupersedesChains,
  nextGraphSelection,
  personalizedPageRank,
  projectAtlasNodes,
  projectCommunityNodes,
  projectLineageNodes,
  projectRankedSlice,
  projectWorkingSet,
  shortestPath,
  WORKING_SET_REASON_COPY,
  type GraphViewMode,
} from './memory-graph-engineering';
import { edgeKeySet, suggestionAdopted } from './memory-slug';
import { deskVoidedSlugSet, fetchMemoryDesk, postMemoryDesk } from '@/components/graph/memory-desk-api';
import { fetchTurnEvidence } from '@/components/chat/turn-evidence-api';

export { adaptRealGraph, TYPE_MAP } from './memory-graph-model';

const SEARCH_DEBOUNCE_MS = 250;

function failureText(status: number | undefined, message: string | undefined): string {
  return `${status === undefined ? '' : `HTTP ${status} · `}${message ?? '请求失败'}`;
}

const QuietGraphState: React.FC<{
  title: string;
  detail: React.ReactNode;
  onRetry?: () => void;
}> = ({ title, detail, onRetry }) => (
  <div className="graph-canvas-container graph-quiet">
    <div role="status" className="graph-quiet-inner">
      <strong className="graph-quiet-title">{title}</strong>
      <div>{detail}</div>
      {onRetry && <Button size="sm" onClick={onRetry}>重新读取</Button>}
    </div>
  </div>
);

export const MemoryGraphPage: React.FC<{
  intent?: MemoryIntent;
  onIntentConsumed?: () => void;
  onNavigateChat?: (sessionId: string) => void;
  onNavigateSkills?: (entry?: { skillsTab?: 'catalog' | 'audit' | 'studio'; skill?: string }) => void;
}> = ({ intent, onIntentConsumed, onNavigateChat, onNavigateSkills }) => {
  const graphResource = useResource<ApiMemoryGraph>({
    url: '/api/memory/graph',
    intervalMs: 60_000,
    refreshOnFocus: true,
    fetcher: fetchMemoryGraphResource,
  });
  const graphData = useMemo(() => adaptRealGraph(graphResource.data), [graphResource.data]);
  const [selectedNodeId, setSelectedNodeId] = useState<string | undefined>();
  const [hoveredNodeId, setHoveredNodeId] = useState<string | undefined>();
  const [searchQuery, setSearchQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [typeFilter, setTypeFilter] = useState('all');
  const [isSimulating, setIsSimulating] = useState(true);
  const [suggestionsOpen, setSuggestionsOpen] = useState(false);
  const [viewMode, setViewMode] = useState<GraphViewMode>('atlas');
  const [spokesCollapsed, setSpokesCollapsed] = useState(false);
  const [spokeReveal, setSpokeReveal] = useState(0);
  const [sliceReveal, setSliceReveal] = useState(0);
  const [previousNodeId, setPreviousNodeId] = useState<string | undefined>();
  const [pickedSessionId, setPickedSessionId] = useState<string | undefined>();
  const [selectedEpisode, setSelectedEpisode] = useState<SessionMemoryItem | null>(null);
  const [selectedSkill, setSelectedSkill] = useState<SkillCatalogEntry | null>(null);
  const [selectedSkillUsage, setSelectedSkillUsage] = useState<SkillUsageStat | undefined>();
  const [dockTab, setDockTab] = useState<'working' | 'skills'>('working');
  const [desk, setDesk] = useState<Awaited<ReturnType<typeof fetchMemoryDesk>>>();
  const [deskError, setDeskError] = useState<string>();
  const [touchedIds, setTouchedIds] = useState<string[]>([]);
  const [sessionItemTexts, setSessionItemTexts] = useState<string[]>([]);
  const [sessionItemsUnread, setSessionItemsUnread] = useState(false);
  const [turnQuery, setTurnQuery] = useState('');
  const sessions = useSyncExternalStore(sessionsStore.subscribe, sessionsStore.getSnapshot);
  const liveActiveSessionId = useSyncExternalStore(
    conversationStore.subscribe,
    () => conversationStore.activeSessionId() ?? '',
  );
  const workingSessionId = resolveWorkingSessionId(pickedSessionId, liveActiveSessionId);
  useEffect(() => {
    if (workingSessionId === undefined) {
      setSessionItemTexts([]);
      setSessionItemsUnread(false);
      return undefined;
    }
    setSessionItemTexts([]);
    setSessionItemsUnread(false);
    let cancelled = false;
    const controller = new AbortController();
    void fetchSessionMemory(workingSessionId, controller.signal).then(
      (payload) => {
        if (cancelled) return;
        setSessionItemTexts(payload.items.map((item) => item.text));
        setSessionItemsUnread(false);
      },
      (error: unknown) => {
        if (cancelled || (error instanceof DOMException && error.name === 'AbortError')) return;
        setSessionItemsUnread(true);
      },
    );
    return () => { cancelled = true; controller.abort(); };
  }, [workingSessionId]);
  useEffect(() => {
    if (workingSessionId === undefined) {
      setTurnQuery('');
      return undefined;
    }
    let cancelled = false;
    const load = (): void => {
      void fetchTurnEvidence(workingSessionId).then(
        (evidence) => {
          if (cancelled) return;
          const query = evidence.memory.collected === true && typeof evidence.memory.query === 'string'
            ? evidence.memory.query.trim()
            : '';
          setTurnQuery(query);
        },
        () => { if (!cancelled) setTurnQuery(''); },
      );
    };
    load();
    const timer = setInterval(load, 8_000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [workingSessionId]);
  useEffect(() => {
    let cancelled = false;
    void fetchMemoryDesk().then(
      (snapshot) => { if (!cancelled) { setDesk(snapshot); setDeskError(undefined); } },
      (error) => { if (!cancelled) setDeskError(error instanceof Error ? error.message : String(error)); },
    );
    return () => { cancelled = true; };
  }, []);
  const voidedSlugs = deskVoidedSlugSet(desk?.voids ?? []);

  const normalizedQuery = searchQuery.trim();
  useEffect(() => {
    if (normalizedQuery === '') {
      setDebouncedQuery('');
      return undefined;
    }
    const timer = setTimeout(() => setDebouncedQuery(normalizedQuery), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [normalizedQuery]);

  const searchUrl = debouncedQuery === ''
    ? null
    : `/api/memory/search?q=${encodeURIComponent(debouncedQuery)}&limit=20`;
  const searchResource = useResource<MemorySearchResponse>({
    url: searchUrl,
    enabled: searchUrl !== null,
    fetcher: fetchMemorySearchResource,
  });
  const suggestionsResource = useResource<LinkSuggestionsResponse>({
    url: '/api/memory/link-suggestions?limit=100',
    intervalMs: 60_000,
    refreshOnFocus: true,
    fetcher: fetchLinkSuggestionsResource,
  });

  const adoptionKeys = useMemo(() => {
    const graph = graphResource.data;
    // 软错误也要当「没拿到图」:dsh-civ 的 errorGraph() 以 **HTTP 200** 返回
    // {nodes:[], edges:[], error:{…}},于是 edges 是 [] 而不是 undefined,
    // 空 Set 会让每条建议都被判成确定的「仍待办」—— 那是拿「图谱这一来源的空」
    // 去填「采纳状态」的确定答案(2026-08-22 验收)。第三态「采纳状态未采集」
    // 就在 GraphControls 同一行里,只差这个条件。
    if (graph === undefined || graph.error !== undefined) return undefined;
    const edges = graph.edges;
    return edges === undefined ? undefined : edgeKeySet(edges);
  }, [graphResource.data]);
  const suggestionsWithAdoption = useMemo(() => {
    const rows = suggestionsResource.data?.suggestions;
    if (rows === undefined || adoptionKeys === undefined) return rows;
    return rows.map((row) => ({ ...row, adopted: suggestionAdopted(row, adoptionKeys) }));
  }, [adoptionKeys, suggestionsResource.data]);

  const searchPresentation = deriveMemorySearchPresentation(
    normalizedQuery,
    debouncedQuery,
    searchResource.status,
    searchResource.data,
  );
  const activeSearch = searchPresentation.response;
  const matchedNodeIds = useMemo(
    () => new Set(activeSearch?.results.map((result) => result.slug) ?? []),
    [activeSearch],
  );
  const nodeById = useMemo(
    () => new Map(graphData?.nodes.map((node) => [node.id, node]) ?? []),
    [graphData?.nodes],
  );
  const selectedNode = selectedNodeId === undefined ? null : nodeById.get(selectedNodeId) ?? null;
  const hoveredNode = hoveredNodeId === undefined ? null : nodeById.get(hoveredNodeId) ?? null;
  const activeDisplayNode = selectedNode ?? hoveredNode;
  const engineering = useMemo(
    () => (graphData === undefined ? undefined : deriveGraphEngineering(graphData.nodes, graphData.edges)),
    [graphData],
  );
  const workingSet = useMemo(() => {
    if (graphData === undefined) return undefined;
    return projectWorkingSet(graphData.nodes, {
      itemTexts: [
        ...sessionItemTexts,
        ...(normalizedQuery !== '' ? [normalizedQuery] : []),
        ...(turnQuery !== '' && normalizedQuery === '' ? [turnQuery] : []),
      ],
      pinIds: activeSearch?.results.map((result) => result.slug),
      inspectedIds: touchedIds,
      selectedId: selectedNodeId,
      excludeIds: voidedSlugs,
    });
  }, [activeSearch, graphData, normalizedQuery, selectedNodeId, sessionItemTexts, touchedIds, turnQuery, voidedSlugs]);
  const lineageChains = useMemo(
    () => (graphData === undefined ? [] : listSupersedesChains(graphData.edges)),
    [graphData],
  );
  const activationBySlug = useMemo(() => {
    if (graphData === undefined || activeSearch === undefined || activeSearch.results.length === 0) return undefined;
    return personalizedPageRank(
      activeSearch.results.map((result) => result.slug),
      graphData.nodes.map((node) => node.id),
      graphData.edges,
    );
  }, [activeSearch, graphData]);
  const localFocusIds = useMemo(() => {
    if (viewMode !== 'local' || selectedNodeId === undefined || graphData === undefined) return undefined;
    return egoNeighborhood(selectedNodeId, graphData.edges, 2);
  }, [graphData, selectedNodeId, viewMode]);
  const communityFocusIds = useMemo(() => {
    if (viewMode !== 'community' || selectedNodeId === undefined || engineering === undefined) return undefined;
    const componentId = engineering.componentByNode.get(selectedNodeId);
    const component = engineering.components.find((entry) => entry.id === componentId);
    return component === undefined ? undefined : new Set(component.memberIds);
  }, [engineering, selectedNodeId, viewMode]);
  const lineageFocusIds = useMemo(() => {
    if (viewMode !== 'lineage' || graphData === undefined) return undefined;
    const ids = new Set<string>();
    for (const chain of lineageChains) {
      for (const id of chain.nodes) ids.add(id);
    }
    return ids.size > 0 ? ids : undefined;
  }, [graphData, lineageChains, viewMode]);
  const searchHitIds = matchedNodeIds.size > 0 ? matchedNodeIds : undefined;
  const focusNodeIds = localFocusIds ?? communityFocusIds ?? lineageFocusIds ?? searchHitIds;
  const atlasProjection = useMemo(() => {
    if (graphData === undefined || engineering === undefined) return undefined;
    const pool = typeFilter === 'all'
      ? graphData.nodes
      : graphData.nodes.filter((item) => item.type === typeFilter);
    const sliceCap = revealedCap(ATLAS_HUB_CAP, sliceReveal);
    const searchPins = activeSearch?.results.map((result) => result.slug) ?? [];
    const worksetPins = workingSet?.ids ?? [];
    if (viewMode === 'community') {
      return projectCommunityNodes(pool, engineering.degrees, engineering.components, {
        selectedId: selectedNodeId,
        cap: sliceCap,
      });
    }
    if (viewMode === 'lineage') {
      return projectLineageNodes(pool, engineering.degrees, lineageChains, {
        selectedId: selectedNodeId,
        cap: sliceCap,
      });
    }
    if (viewMode === 'local') {
      if (selectedNodeId === undefined || localFocusIds === undefined) {
        return projectAtlasNodes(pool, engineering.degrees, {
          hint: '局部：点一篇记忆后画 2 跳邻域',
        });
      }
      return projectRankedSlice(pool, engineering.degrees, localFocusIds, {
        selectedId: selectedNodeId,
        cap: sliceCap,
        noun: '局部 2 跳',
        empty: '局部邻域为空。',
      });
    }
    return projectAtlasNodes(pool, engineering.degrees, {
      selectedId: selectedNodeId,
      neighborIds: selectedNodeId === undefined
        ? undefined
        : egoNeighborhood(selectedNodeId, graphData.edges, 1),
      pinIds: [...searchPins, ...worksetPins],
      searchPinIds: searchPins,
      excludeIds: voidedSlugs,
      expandSpokes: !spokesCollapsed,
      spokeCap: revealedCap(ATLAS_SPOKE_CAP, spokeReveal),
    });
  }, [
    activeSearch,
    engineering,
    graphData,
    lineageChains,
    localFocusIds,
    selectedNodeId,
    sliceReveal,
    spokeReveal,
    spokesCollapsed,
    typeFilter,
    viewMode,
    voidedSlugs,
    workingSet,
  ]);
  const atlasNodeIds = useMemo(
    () => new Set(atlasProjection?.nodes.map((item) => item.id) ?? []),
    [atlasProjection],
  );
  const atlasEdges = useMemo(() => {
    if (graphData === undefined || atlasProjection === undefined) return [];
    return graphData.edges.filter((edge) => atlasNodeIds.has(edge.from) && atlasNodeIds.has(edge.to));
  }, [atlasNodeIds, atlasProjection, graphData]);
  const pathIds = useMemo(() => {
    if (selectedNodeId === undefined || previousNodeId === undefined || graphData === undefined) return undefined;
    return shortestPath(previousNodeId, selectedNodeId, graphData.edges);
  }, [graphData, previousNodeId, selectedNodeId]);
  const applySelection = (nextId: string | undefined, intent: 'canvas' | 'focus'): void => {
    const next = nextGraphSelection({
      currentId: selectedNodeId,
      nextId,
      viewMode,
      spokesCollapsed,
      collapsible: atlasProjection?.collapsible ?? false,
      intent,
    });
    if (next.selectedId !== undefined && selectedNodeId !== undefined && next.selectedId !== selectedNodeId) {
      setPreviousNodeId(selectedNodeId);
    }
    if (next.selectedId === undefined) setPreviousNodeId(undefined);
    setSelectedNodeId(next.selectedId);
    setSpokesCollapsed(next.spokesCollapsed);
    if (next.resetReveal) {
      setSpokeReveal(0);
      setSliceReveal(0);
    }
    if (next.selectedId !== undefined) {
      setTouchedIds((previous) => [next.selectedId as string, ...previous.filter((id) => id !== next.selectedId)].slice(0, 12));
      setSelectedEpisode(null);
      setSelectedSkill(null);
      setSelectedSkillUsage(undefined);
    }
  };
  const selectNode = (id: string | undefined): void => applySelection(id, 'canvas');
  const selectEpisode = (item: SessionMemoryItem): void => {
    setSelectedEpisode(item);
    setSelectedSkill(null);
    setSelectedSkillUsage(undefined);
    setSelectedNodeId(undefined);
    setPreviousNodeId(undefined);
    setSpokesCollapsed(false);
    setSpokeReveal(0);
    setSliceReveal(0);
    setDockTab('working');
  };
  const selectSkill = (skill: SkillCatalogEntry, usage: SkillUsageStat | undefined): void => {
    setSelectedSkill(skill);
    setSelectedSkillUsage(usage);
    setSelectedEpisode(null);
    setSelectedNodeId(undefined);
    setPreviousNodeId(undefined);
    setSpokesCollapsed(false);
    setSpokeReveal(0);
    setSliceReveal(0);
    setDockTab('skills');
  };

  useEffect(() => {
    const next = consumeMemoryIntent(intent);
    if (next === undefined) return;
    if (next.sessionId !== undefined) setPickedSessionId(next.sessionId);
    if (next.nodeId !== undefined) applySelection(next.nodeId, 'focus');
    onIntentConsumed?.();
  }, [intent, onIntentConsumed]);
  const focusNode = (id: string): void => {
    if (nodeById.has(id)) {
      setTypeFilter('all');
      applySelection(id, 'focus');
    }
  };

  useEffect(() => {
    setSpokesCollapsed(false);
    setSpokeReveal(0);
    setSliceReveal(0);
  }, [viewMode]);

  const revealRemainder = (): void => {
    if (viewMode === 'atlas') {
      if (spokesCollapsed) {
        setSpokesCollapsed(false);
        return;
      }
      setSpokeReveal((count) => count + 1);
      return;
    }
    setSliceReveal((count) => count + 1);
  };

  const dataSourceLabel = graphResource.status === 'degraded'
    ? '上次快照 · 更新失败'
    : graphResource.status === 'error'
      ? '接口不可用'
      : graphResource.status === 'loading' && graphData !== undefined
        ? '刷新中'
        : graphData === undefined
          ? '连接中'
          : '/api/memory/graph · 实时';

  return (
    <div className="page-workspace">
      <main className="app-stage">
        <AppTopbar
          title="记忆"
          badge={graphData && <Chip active>{graphData.nodes.length} 篇记忆 · {graphData.edges.length} 条关系</Chip>}
          rightActions={
            <div className="surface-cluster">
              <div className={`graph-source ${
                graphResource.status === 'error' ? 'is-off'
                  : graphResource.status === 'degraded' ? 'is-warn'
                    : graphData === undefined ? 'is-pending'
                      : 'is-ok'
              }`}>
                <span className="u-microlabel">数据源</span>
                <span>{dataSourceLabel}</span>
              </div>
              <Button size="sm" disabled={graphResource.status === 'loading'} onClick={() => graphResource.refresh('/api/memory/graph?refresh=1')}>
                {graphResource.status === 'loading' ? '读取中…' : '刷新'}
              </Button>
            </div>
          }
        />

        <div className="mem-workspace-layers">
          <div className="mem-layer-rail" aria-label="记忆分层">
            <button
              type="button"
              className={`mem-layer is-action${dockTab === 'working' ? ' is-here' : ''}`}
              title="左栏会话提炼。晋升写入甲板账本，不是 Fleet Memory 真源。"
              onClick={() => setDockTab('working')}
            >
              <span className="mem-layer-title">情节层</span>
            </button>
            <div className="mem-layer is-here" title="文档节点与 wikilink。不是实体抽取。">
              <span className="mem-layer-title">语义层</span>
            </div>
            <div className="mem-layer is-here" title="supersedes 与 validUntil。缺失效时间写未采集。">
              <span className="mem-layer-title">时间层</span>
            </div>
            <button
              type="button"
              className={`mem-layer is-action${dockTab === 'skills' ? ' is-here' : ''}`}
              title="程序记忆。目录在左栏，审计在控制台。"
              onClick={() => setDockTab('skills')}
            >
              <span className="mem-layer-title">技能层</span>
            </button>
          </div>
        </div>

        <div className="mem-workspace">
        <aside className="mem-working-dock" aria-label={dockTab === 'skills' ? '技能层' : '情节层'}>
          <div className="mem-working-head">
            <SegmentedControl
              value={dockTab}
              onChange={setDockTab}
              options={[
                { value: 'working', label: '情节' },
                { value: 'skills', label: '技能' },
              ]}
            />
            {dockTab === 'working' && (
              <>
                <label className="u-microlabel" htmlFor="mem-working-session">工作会话</label>
                <select
                  id="mem-working-session"
                  className="mem-working-select"
                  value={workingSessionId ?? ''}
                  onChange={(event) => {
                    const next = event.target.value;
                    setPickedSessionId(next === '' ? undefined : next);
                    setSelectedEpisode(null);
                  }}
                >
                  <option value="">未选择会话</option>
                  {workingSessionId !== undefined && !sessions.rows.some((row) => row.sessionId === workingSessionId) && (
                    <option value={workingSessionId}>{workingSessionId}</option>
                  )}
                  {sessions.rows.map((row) => (
                    <option key={row.sessionId} value={row.sessionId}>
                      {row.title}
                    </option>
                  ))}
                </select>
                <div className="mem-working-actions">
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={workingSessionId === undefined}
                    onClick={() => { if (workingSessionId !== undefined) onNavigateChat?.(workingSessionId); }}
                  >
                    回对话
                  </Button>
                </div>
              </>
            )}
          </div>
          <div className="mem-working-body">
            {dockTab === 'working' ? (
              <>
                <SessionMemoryPane
                  sessionId={workingSessionId}
                  query={normalizedQuery}
                  relevanceQuery={turnQuery}
                  selectedItemId={selectedEpisode?.id}
                  onSelectItem={selectEpisode}
                  onItemsChange={setSessionItemTexts}
                />
                <section className="mem-panel" aria-label="本会话工作集">
                  <h3 className="mem-layer-title">工作集</h3>
                  <p className="u-microlabel">
                    {sessionItemsUnread ? STORE_UNREAD_COPY : (workingSet?.copy ?? '本会话没有可钉的文档')}
                  </p>
                  {sessionItemsUnread && (
                    <p className="u-microlabel">工作集词面未采集，不是空店</p>
                  )}
                  {turnQuery !== '' && normalizedQuery === '' && (
                    <p className="u-microlabel">工作集问句来自本跳回注，不是搜索</p>
                  )}
                  {workingSet && workingSet.nodes.length > 0 && (
                    <div className="mem-panel-list">
                      {workingSet.nodes.map((node) => (
                        <button
                          key={node.id}
                          type="button"
                          className="mem-panel-row"
                          onClick={() => focusNode(node.id)}
                        >
                          <code>{node.id}</code>
                          <span className="u-microlabel">{node.title}</span>
                          <span className="u-microlabel">
                            {workingSet.reasons[node.id] === undefined
                              ? ''
                              : WORKING_SET_REASON_COPY[workingSet.reasons[node.id]]}
                          </span>
                        </button>
                      ))}
                    </div>
                  )}
                </section>
              </>
            ) : (
              <MemorySkillsDock
                query={normalizedQuery}
                sessionId={workingSessionId}
                selectedName={selectedSkill?.name}
                onSelect={selectSkill}
                onOpenAudit={() => onNavigateSkills?.({ skillsTab: 'audit' })}
                onOpenStudio={selectedSkill ? () => onNavigateSkills?.({ skillsTab: 'studio', skill: selectedSkill.name }) : undefined}
              />
            )}
          </div>
        </aside>
        <div className="graph-stage-wrapper">
          {graphData && (
            <GraphControls
              searchQuery={searchQuery}
              onSearchChange={setSearchQuery}
              searchStatus={searchPresentation.status}
              searchPending={searchPresentation.pending}
              searchResults={activeSearch?.results}
              searchError={searchResource.error ? failureText(searchResource.error.status, searchResource.error.message) : activeSearch?.error}
              onRetrySearch={() => { if (searchUrl) searchResource.refresh(searchUrl); }}
              onFocusNode={focusNode}
              typeFilter={typeFilter}
              onTypeFilterChange={(nextType) => {
                setTypeFilter(nextType);
                if (selectedNode && nextType !== 'all' && selectedNode.type !== nextType) selectNode(undefined);
              }}
              counts={graphData.counts}
              summary={graphData.summary}
              totalNodes={graphData.nodes.length}
              totalEdges={graphData.edges.length}
              isSimulating={isSimulating}
              onToggleSimulation={() => setIsSimulating((value) => !value)}
              suggestionsStatus={suggestionsResource.status}
              suggestions={suggestionsWithAdoption}
              suggestionsError={suggestionsResource.error
                ? failureText(suggestionsResource.error.status, suggestionsResource.error.message)
                : suggestionsResource.data?.error}
              suggestionsOpen={suggestionsOpen}
              onToggleSuggestions={() => setSuggestionsOpen((value) => !value)}
              onRefreshSuggestions={() => suggestionsResource.refresh()}
              viewMode={viewMode}
              onViewModeChange={setViewMode}
              atlasCopy={atlasProjection?.copy}
              remainder={atlasProjection?.remainder}
              onRevealRemainder={revealRemainder}
              onCollapseSpokes={
                viewMode === 'atlas' && atlasProjection?.collapsible === true && !spokesCollapsed && selectedNodeId !== undefined
                  ? () => selectNode(selectedNodeId)
                  : undefined
              }
              componentCount={engineering?.components.length ?? 0}
              isolateCount={engineering?.isolateCount ?? 0}
              expiredCount={engineering?.expiredCount ?? 0}
              uncollectedValidityCount={engineering?.uncollectedValidityCount ?? 0}
              supersedesCount={engineering?.supersedesCount ?? 0}
              largestComponentSize={engineering?.largestComponentSize ?? 0}
              components={engineering?.components ?? []}
              degrees={engineering?.degrees}
              lineageChains={lineageChains}
              activationBySlug={activationBySlug}
            />
          )}

          {graphData === undefined && (graphResource.status === 'idle' || graphResource.status === 'loading') && (
            <QuietGraphState title="正在读取长期记忆图谱" detail={<>等待 <code>/api/memory/graph</code> 返回经过校验的数据。</>} />
          )}
          {graphData === undefined && graphResource.status === 'error' && graphResource.error && (
            <QuietGraphState
              title="长期记忆图谱不可用"
              detail={<><code>/api/memory/graph</code> 未响应：{failureText(graphResource.error.status, graphResource.error.message)}</>}
              onRetry={() => graphResource.refresh()}
            />
          )}
          {graphData && graphData.nodes.length === 0 && (
            <QuietGraphState
              title={graphData.error ? '长期记忆目录不可用' : '长期记忆图谱为空'}
              detail={graphData.error ?? '接口返回了零个节点。此处不会展示示例数据。'}
              onRetry={() => graphResource.refresh('/api/memory/graph?refresh=1')}
            />
          )}
          {graphData && graphData.nodes.length > 0 && (
            <CanvasGraph
              nodes={atlasProjection?.nodes ?? graphData.nodes}
              edges={atlasEdges}
              selectedNodeId={selectedNode?.id}
              searchQuery={activeSearch === undefined ? '' : normalizedQuery}
              matchedNodeIds={matchedNodeIds}
              typeFilter={typeFilter}
              isSimulating={isSimulating}
              focusNodeIds={focusNodeIds}
              expiredNodeIds={engineering?.expiredIds}
              pathIds={pathIds}
              remainder={atlasProjection?.remainder}
              onSelectNode={(node: MemoryNodeData | null) => selectNode(node?.id)}
              onHoverNode={(node: MemoryNodeData | null) => setHoveredNodeId(node?.id)}
              onRevealRemainder={revealRemainder}
            />
          )}

          {graphData && graphResource.status === 'degraded' && graphResource.error && (
            <div role="status" className="graph-toast">
              图谱刷新失败，仍显示上次成功快照：{failureText(graphResource.error.status, graphResource.error.message)}
            </div>
          )}
          {graphData && graphData.nodes.length > 0 && graphResource.status === 'ready' && graphData.error && (
            <div role="status" className="graph-toast">
              图谱源返回软错误：{graphData.error}
            </div>
          )}

          <GraphInspector
            node={selectedEpisode || selectedSkill ? null : activeDisplayNode}
            episode={selectedSkill ? null : selectedEpisode}
            skill={selectedSkill}
            skillUsage={selectedSkillUsage}
            edges={graphData?.edges ?? []}
            engineering={engineering}
            pathFromPrevious={pathIds}
            activation={selectedNodeId === undefined ? undefined : activationBySlug?.get(selectedNodeId)}
            onClose={() => {
              selectNode(undefined);
              setSelectedEpisode(null);
              setSelectedSkill(null);
              setSelectedSkillUsage(undefined);
            }}
            onNavigateNode={focusNode}
            onOpenStudio={selectedSkill ? () => onNavigateSkills?.({ skillsTab: 'studio', skill: selectedSkill.name }) : undefined}
            deskCopy={deskError ?? desk?.copy}
            civAvailable={desk?.civAvailable}
            voided={selectedNodeId !== undefined && voidedSlugs.has(selectedNodeId)}
            onPromoteEpisode={async (item) => {
              if (workingSessionId === undefined) return '工作会话未采集，不能晋升。';
              const result = await postMemoryDesk({
                action: 'promote',
                sessionId: workingSessionId,
                itemId: item.id,
                kind: item.kind,
                text: item.text,
              });
              if (result.ok) {
                const next = await fetchMemoryDesk();
                setDesk(next);
                return result.copy;
              }
              return result.error;
            }}
            onSubmitToCiv={async (input) => {
              if (workingSessionId === undefined) return '工作会话未采集，不能送真源。';
              const result = await postMemoryDesk({
                action: 'submit',
                sessionId: workingSessionId,
                itemId: input.itemId,
                slug: input.slug,
                type: input.type,
                description: input.description,
                body: input.body,
              });
              if (result.ok) {
                const next = await fetchMemoryDesk();
                setDesk(next);
                return result.copy;
              }
              return result.error;
            }}
            onVoidNode={async (slug) => {
              const result = await postMemoryDesk({ action: 'void', slug });
              if (result.ok) {
                const next = await fetchMemoryDesk();
                setDesk(next);
                return result.copy;
              }
              return result.error;
            }}
          />
        </div>
        </div>
      </main>
    </div>
  );
};
