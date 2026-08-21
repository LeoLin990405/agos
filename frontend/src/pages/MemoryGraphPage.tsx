import React, { useEffect, useMemo, useState } from 'react';
import { AppTopbar } from '@/components/layout/AppTopbar';
import { Chip } from '@/components/ui/Chip';
import { Button } from '@/components/ui/Button';
import { CanvasGraph } from '@/components/graph/CanvasGraph';
import { GraphInspector } from '@/components/graph/GraphInspector';
import { GraphControls } from '@/components/graph/GraphControls';
import type { MemoryNodeData } from '@/components/graph/mock-graph-data';
import { useResource } from '@/lib/useResource';
import {
  fetchLinkSuggestionsResource,
  fetchMemoryGraphResource,
  fetchMemorySearchResource,
  type ApiMemoryGraph,
  type LinkSuggestionsResponse,
  type MemorySearchResponse,
} from './memory-graph-api';
import { adaptRealGraph, deriveMemorySearchPresentation } from './memory-graph-model';

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
  <div className="graph-canvas-container" style={{ display: 'grid', placeItems: 'center', padding: '24px' }}>
    <div role="status" style={{ maxWidth: '560px', textAlign: 'center', color: 'var(--text-tertiary)', fontSize: '12.5px', lineHeight: 1.6 }}>
      <strong style={{ display: 'block', color: 'var(--text-secondary)', fontSize: '14px', marginBottom: '6px' }}>{title}</strong>
      <div>{detail}</div>
      {onRetry && <Button size="sm" onClick={onRetry} style={{ marginTop: '12px' }}>重新读取</Button>}
    </div>
  </div>
);

export const MemoryGraphPage: React.FC = () => {
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
  const focusNode = (id: string): void => {
    if (nodeById.has(id)) {
      setTypeFilter('all');
      setSelectedNodeId(id);
    }
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
  const dataSourceColor = graphResource.status === 'error'
    ? 'var(--state-failed)'
    : graphResource.status === 'degraded'
      ? 'var(--accent-amber)'
      : graphData === undefined
        ? 'var(--text-tertiary)'
        : 'var(--state-done)';

  return (
    <div style={{ display: 'flex', flex: 1, height: '100vh', overflow: 'hidden' }}>
      <main className="app-stage">
        <AppTopbar
          title="记忆图谱 (Memory Graph Engineering)"
          badge={graphData && <Chip active>{graphData.nodes.length} 篇记忆 · {graphData.edges.length} 条关系</Chip>}
          rightActions={
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <div className="telemetry-pill">
                <span className="u-microlabel">数据源</span>
                <span className="val" style={{ color: dataSourceColor }}>{dataSourceLabel}</span>
              </div>
              <Button size="sm" disabled={graphResource.status === 'loading'} onClick={() => graphResource.refresh('/api/memory/graph?refresh=1')}>
                {graphResource.status === 'loading' ? '读取中…' : '刷新'}
              </Button>
            </div>
          }
        />

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
                if (selectedNode && nextType !== 'all' && selectedNode.type !== nextType) setSelectedNodeId(undefined);
              }}
              counts={graphData.counts}
              summary={graphData.summary}
              totalNodes={graphData.nodes.length}
              totalEdges={graphData.edges.length}
              isSimulating={isSimulating}
              onToggleSimulation={() => setIsSimulating((value) => !value)}
              suggestionsStatus={suggestionsResource.status}
              suggestions={suggestionsResource.data?.suggestions}
              suggestionsError={suggestionsResource.error
                ? failureText(suggestionsResource.error.status, suggestionsResource.error.message)
                : suggestionsResource.data?.error}
              suggestionsOpen={suggestionsOpen}
              onToggleSuggestions={() => setSuggestionsOpen((value) => !value)}
              onRefreshSuggestions={() => suggestionsResource.refresh()}
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
              nodes={graphData.nodes}
              edges={graphData.edges}
              selectedNodeId={selectedNode?.id}
              searchQuery={activeSearch === undefined ? '' : normalizedQuery}
              matchedNodeIds={matchedNodeIds}
              typeFilter={typeFilter}
              isSimulating={isSimulating}
              onSelectNode={(node: MemoryNodeData | null) => setSelectedNodeId(node?.id)}
              onHoverNode={(node: MemoryNodeData | null) => setHoveredNodeId(node?.id)}
            />
          )}

          {graphData && graphResource.status === 'degraded' && graphResource.error && (
            <div role="status" style={{ position: 'absolute', left: '20px', bottom: '18px', zIndex: 11, padding: '8px 11px', border: '1px solid var(--state-running-border)', borderRadius: '6px', background: 'var(--bg-layer-1)', color: 'var(--text-secondary)', fontSize: '11.5px' }}>
              图谱刷新失败，仍显示上次成功快照：{failureText(graphResource.error.status, graphResource.error.message)}
            </div>
          )}
          {graphData && graphData.nodes.length > 0 && graphResource.status === 'ready' && graphData.error && (
            <div role="status" style={{ position: 'absolute', left: '20px', bottom: '18px', zIndex: 11, padding: '8px 11px', border: '1px solid var(--state-running-border)', borderRadius: '6px', background: 'var(--bg-layer-1)', color: 'var(--text-secondary)', fontSize: '11.5px' }}>
              图谱源返回软错误：{graphData.error}
            </div>
          )}

          <GraphInspector
            node={activeDisplayNode}
            edges={graphData?.edges ?? []}
            onClose={() => setSelectedNodeId(undefined)}
            onNavigateNode={focusNode}
          />
        </div>
      </main>
    </div>
  );
};
