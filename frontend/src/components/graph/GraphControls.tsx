import React from 'react';
import { Button } from '@/components/ui/Button';
import type { MemoryNodeType } from '@/design-system/tokens';
import type { ResourceStatus } from '@/lib/resource';
import type { LinkSuggestion, MemorySearchResult } from '@/pages/memory-graph-api';
import type { MemoryGraphSummary } from './mock-graph-data';
import { clipDescription } from '@/components/console/skills-model';
import {
  collapseIds,
  componentHubId,
  GRAPH_VIEW_MODES,
  SEARCH_RESULT_CAP,
  type GraphRemainder,
  type GraphViewMode,
  type MemoryComponent,
  type MemoryDegrees,
  type SupersedesChain,
} from '@/pages/memory-graph-engineering';

export interface GraphControlsProps {
  searchQuery: string;
  onSearchChange: (q: string) => void;
  searchStatus: ResourceStatus;
  searchPending: boolean;
  searchResults?: MemorySearchResult[];
  searchError?: string;
  onRetrySearch: () => void;
  onFocusNode: (id: string) => void;
  typeFilter: string;
  onTypeFilterChange: (t: string) => void;
  counts: Record<MemoryNodeType, number>;
  summary: MemoryGraphSummary;
  totalNodes: number;
  totalEdges: number;
  isSimulating: boolean;
  onToggleSimulation: () => void;
  onResetZoom?: () => void;
  suggestionsStatus: ResourceStatus;
  suggestions?: LinkSuggestion[];
  suggestionsError?: string;
  suggestionsOpen: boolean;
  onToggleSuggestions: () => void;
  onRefreshSuggestions: () => void;
  viewMode: GraphViewMode;
  onViewModeChange: (mode: GraphViewMode) => void;
  componentCount: number;
  isolateCount: number;
  expiredCount: number;
  uncollectedValidityCount: number;
  supersedesCount: number;
  largestComponentSize: number;
  components: readonly MemoryComponent[];
  degrees?: ReadonlyMap<string, MemoryDegrees>;
  lineageChains: readonly SupersedesChain[];
  activationBySlug?: ReadonlyMap<string, number>;
  atlasCopy?: string;
  remainder?: GraphRemainder;
  onRevealRemainder?: () => void;
  onCollapseSpokes?: () => void;
}

const panelStyle: React.CSSProperties = {
  backgroundColor: 'var(--bg-layer-1)',
  border: '1px solid var(--border-subtle)',
  borderRadius: '8px',
  boxShadow: 'var(--shadow-panel)',
};

const quietText: React.CSSProperties = {
  color: 'var(--text-tertiary)',
  fontSize: '11.5px',
  lineHeight: 1.5,
};

function SearchHitList({
  results,
  activationBySlug,
  onFocusNode,
}: {
  results: MemorySearchResult[];
  activationBySlug?: ReadonlyMap<string, number>;
  onFocusNode: (id: string) => void;
}) {
  const [open, setOpen] = React.useState(false);
  const folded = collapseIds(results.map((result) => result.slug), SEARCH_RESULT_CAP);
  const shown = results.slice(0, folded.visible.length);
  return (
    <div className="mem-search-list">
      {shown.map((result) => (
        <button key={result.slug} type="button" className="mem-search-hit" onClick={() => onFocusNode(result.slug)}>
          <span className="mem-search-hit-head">
            <code>{result.slug}</code>
            <span className="u-num">{result.score.toFixed(4)}</span>
          </span>
          {result.description && <span className="mem-search-hit-copy">{clipDescription(result.description, 72)}</span>}
          <span className="u-microlabel">
            {result.matchedBy.join(' + ')}
            {activationBySlug?.has(result.slug)
              ? ` · 种子激活 ${activationBySlug.get(result.slug)?.toFixed(4)}`
              : ''}
          </span>
        </button>
      ))}
      {folded.hidden > 0 && (
        <button type="button" className="mem-inspector-more-btn" onClick={() => setOpen((value) => !value)}>
          {open ? '收起其余命中' : `其余 ${folded.hidden} 条命中`}
        </button>
      )}
      {open && results.slice(shown.length).map((result) => (
        <button key={`more:${result.slug}`} type="button" className="mem-search-hit" onClick={() => onFocusNode(result.slug)}>
          <span className="mem-search-hit-head">
            <code>{result.slug}</code>
            <span className="u-num">{result.score.toFixed(4)}</span>
          </span>
          {result.description && <span className="mem-search-hit-copy">{clipDescription(result.description, 72)}</span>}
        </button>
      ))}
    </div>
  );
}

function SearchResults({
  status,
  pending,
  results,
  error,
  onRetry,
  onFocusNode,
  activationBySlug,
}: {
  status: ResourceStatus;
  pending: boolean;
  results?: MemorySearchResult[];
  error?: string;
  onRetry: () => void;
  onFocusNode: (id: string) => void;
  activationBySlug?: ReadonlyMap<string, number>;
}) {
  const loading = pending || status === 'idle' || status === 'loading';
  return (
    <section aria-label="记忆搜索结果" style={{ ...panelStyle, width: '390px', maxHeight: '310px', overflowY: 'auto', padding: '10px' }}>
      {loading && results === undefined && <div aria-live="polite" style={quietText}>正在运行 BM25 + bigram 混合检索…</div>}
      {loading && results !== undefined && (
        <div role="status" style={{ color: 'var(--text-tertiary)', fontSize: '11.5px', marginBottom: '8px' }}>
          正在刷新，暂时保留本查询的上次结果。
        </div>
      )}
      {!pending && status === 'error' && results === undefined && (
        <div role="alert" style={{ color: 'var(--state-failed)', fontSize: '11.5px' }}>
          <div style={{ marginBottom: '8px' }}>{error ?? '检索接口未返回可用数据。'}</div>
          <Button size="sm" onClick={onRetry}>重试检索</Button>
        </div>
      )}
      {!pending && status === 'degraded' && results !== undefined && (
        <div role="status" style={{ color: 'var(--accent-amber)', fontSize: '11.5px', marginBottom: '8px' }}>
          刷新失败，保留上次同查询结果。{error ? ` ${error}` : ''}
        </div>
      )}
      {!pending && status === 'ready' && error && (
        <div role="status" style={{ color: 'var(--accent-amber)', fontSize: '11.5px', marginBottom: '8px' }}>
          检索源返回软错误：{error}
        </div>
      )}
      {!loading && status !== 'error' && results?.length === 0 && (
        <div style={quietText}>没有命中节点。图谱不会生成替代结果。</div>
      )}
      {results && results.length > 0 && (
        <SearchHitList results={results} activationBySlug={activationBySlug} onFocusNode={onFocusNode} />
      )}
    </section>
  );
}

function SuggestionList({
  status,
  suggestions,
  error,
  onRefresh,
  onFocusNode,
}: {
  status: ResourceStatus;
  suggestions?: LinkSuggestion[];
  error?: string;
  onRefresh: () => void;
  onFocusNode: (id: string) => void;
}) {
  return (
    <section aria-label="补链建议" style={{ ...panelStyle, width: '390px', maxHeight: '290px', overflowY: 'auto', padding: '10px' }}>
      {(status === 'idle' || status === 'loading') && suggestions === undefined && <div aria-live="polite" style={quietText}>正在读取补链建议…</div>}
      {status === 'loading' && suggestions !== undefined && (
        <div role="status" style={{ color: 'var(--text-tertiary)', fontSize: '11.5px', marginBottom: '8px' }}>
          正在刷新，暂时保留上次建议。
        </div>
      )}
      {status === 'error' && suggestions === undefined && (
        <div role="alert" style={{ color: 'var(--state-failed)', fontSize: '11.5px' }}>
          <div style={{ marginBottom: '8px' }}>{error ?? '补链建议接口未返回可用数据。'}</div>
          <Button size="sm" onClick={onRefresh}>重试</Button>
        </div>
      )}
      {status === 'degraded' && suggestions !== undefined && (
        <div role="status" style={{ color: 'var(--accent-amber)', fontSize: '11.5px', marginBottom: '8px' }}>
          刷新失败，保留上次建议。{error ? ` ${error}` : ''}
        </div>
      )}
      {status === 'ready' && error && (
        <div role="status" style={{ color: 'var(--accent-amber)', fontSize: '11.5px', marginBottom: '8px' }}>
          建议源返回软错误：{error}
        </div>
      )}
      {suggestions !== undefined && <h3 style={{ fontSize: '12px', fontWeight: 700, margin: '0 0 8px' }}>补链对照已采集</h3>}
      {suggestions?.length === 0 && <div style={quietText}>当前没有补链建议。</div>}
      {suggestions && suggestions.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
          {suggestions.map((suggestion, index) => (
            <button
              key={`${suggestion.source}:${suggestion.target}:${suggestion.createdAt}:${index}`}
              type="button"
              onClick={() => onFocusNode(suggestion.source)}
              title="定位建议来源节点"
              style={{
                display: 'grid',
                gridTemplateColumns: 'minmax(0, 1fr) auto minmax(0, 1fr)',
                gap: '7px',
                alignItems: 'center',
                width: '100%',
                border: '1px solid var(--border-dim)',
                borderRadius: '6px',
                background: 'var(--bg-layer-2)',
                color: 'var(--text-primary)',
                padding: '8px 9px',
                textAlign: 'left',
                cursor: 'pointer',
              }}
            >
              <code style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{suggestion.source}</code>
              <span aria-hidden="true" style={{ color: 'var(--state-running)' }}>→</span>
              <code style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{suggestion.target}</code>
              <span className="u-microlabel" style={{ gridColumn: '1 / 4' }}>
                分数 {suggestion.score} · {new Date(suggestion.createdAt).toLocaleString('zh-CN', { hour12: false })}
                {' · '}
                {suggestion.adopted === true ? '已采纳' : suggestion.adopted === false ? '仍待办' : '采纳状态未采集'}
              </span>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

export const GraphControls: React.FC<GraphControlsProps> = ({
  searchQuery,
  onSearchChange,
  searchStatus,
  searchPending,
  searchResults,
  searchError,
  onRetrySearch,
  onFocusNode,
  typeFilter,
  onTypeFilterChange,
  counts,
  summary,
  totalNodes,
  totalEdges,
  isSimulating,
  onToggleSimulation,
  onResetZoom,
  suggestionsStatus,
  suggestions,
  suggestionsError,
  suggestionsOpen,
  onToggleSuggestions,
  onRefreshSuggestions,
  viewMode,
  onViewModeChange,
  componentCount,
  isolateCount,
  expiredCount,
  uncollectedValidityCount,
  supersedesCount,
  largestComponentSize,
  components,
  degrees,
  lineageChains,
  activationBySlug,
  atlasCopy,
  remainder,
  onRevealRemainder,
  onCollapseSpokes,
}) => {
  const hasQuery = searchQuery.trim() !== '';
  const unknownEntries = Object.entries(summary.unknownTypes).sort(([left], [right]) => left.localeCompare(right));
  const unknownCount = unknownEntries.reduce((sum, [, count]) => sum + count, 0);
  const suggestionLabel = suggestions === undefined
    ? suggestionsStatus === 'error' ? '补链建议不可用' : '补链建议读取中'
    : `补链建议 ${suggestions.length} 条${suggestionsError ? ' · 源异常' : ''}`;

  return (
    <div className="graph-controls-floating">
      <div style={{ ...panelStyle, display: 'flex', alignItems: 'center', gap: '10px', padding: '8px 14px' }}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ color: 'var(--text-tertiary)' }}>
          <circle cx="11" cy="11" r="8" />
          <path d="m21 21-4.3-4.3" />
        </svg>
        <input
          type="search"
          aria-label="搜索长期记忆"
          placeholder={`搜索 ${totalNodes} 篇长期记忆`}
          style={{ background: 'transparent', border: 'none', outline: 'none', fontSize: '12.5px', color: 'var(--text-primary)', width: '240px' }}
          value={searchQuery}
          onChange={(event) => onSearchChange(event.target.value)}
        />
        <div style={{ width: '1px', height: '16px', backgroundColor: 'var(--border-dim)' }} />
        <span className="u-num" style={{ fontSize: '11px', color: 'var(--text-tertiary)' }}>
          {totalNodes > 0 ? '星图已采集 · ' : ''}{totalNodes} 节点 · {totalEdges} 边
        </span>
        {atlasCopy !== undefined && (
          <span className="u-num" style={{ fontSize: '11px', color: 'var(--text-tertiary)' }}>{atlasCopy}</span>
        )}
        {remainder !== undefined && onRevealRemainder !== undefined && (
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            title={remainder.copy}
            onClick={onRevealRemainder}
          >
            +{remainder.count} 其余
          </button>
        )}
        {onCollapseSpokes !== undefined && (
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            title="收回多出来的辐条，枢纽仍在"
            onClick={onCollapseSpokes}
          >
            收起辐条
          </button>
        )}
      </div>

      {hasQuery && (
        <SearchResults
          status={searchStatus}
          pending={searchPending}
          results={searchResults}
          error={searchError}
          onRetry={onRetrySearch}
          onFocusNode={onFocusNode}
          activationBySlug={activationBySlug}
        />
      )}

      <div style={{ ...panelStyle, display: 'flex', alignItems: 'center', gap: '6px', padding: '6px 10px', flexWrap: 'wrap', maxWidth: '720px' }} className="mem-view-row">
        {GRAPH_VIEW_MODES.map((mode) => (
          <button
            key={mode.id}
            type="button"
            className={`btn btn-sm ${viewMode === mode.id ? 'btn-primary' : 'btn-ghost'}`}
            title={mode.hint}
            onClick={() => onViewModeChange(mode.id)}
          >
            {mode.label}
          </button>
        ))}
      </div>

      <div style={{ ...panelStyle, display: 'flex', alignItems: 'center', gap: '6px', padding: '6px 10px', flexWrap: 'wrap', maxWidth: '720px' }}>
        <button type="button" className={`btn btn-sm ${typeFilter === 'all' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => onTypeFilterChange('all')}>
          全部 ({totalNodes})
        </button>
        {([
          ['user', 'User', 'var(--mem-user)'],
          ['feedback', 'Feedback', 'var(--mem-feedback)'],
          ['project', 'Project', 'var(--mem-project)'],
          ['reference', 'Ref', 'var(--mem-reference)'],
          ['incident', 'Incident', 'var(--mem-incident)'],
        ] as const).map(([type, label, color]) => (
          <button
            key={type}
            type="button"
            className={`btn btn-sm ${typeFilter === type ? 'btn-primary' : 'btn-ghost'}`}
            onClick={() => onTypeFilterChange(type)}
            style={{ color }}
          >
            ● {label} ({counts[type]})
          </button>
        ))}
        <div style={{ marginLeft: 'auto', display: 'flex', gap: '4px' }}>
          <Button variant="ghost" size="sm" onClick={onToggleSimulation} title="暂停或恢复物理仿真">
            {isSimulating ? '⏸ 冻结' : '▶ 演进'}
          </Button>
          {onResetZoom && <Button variant="ghost" size="sm" onClick={onResetZoom} title="重置星图镜头">⊙ 居中</Button>}
        </div>
      </div>

      <div style={{ ...panelStyle, display: 'flex', gap: '12px', alignItems: 'center', flexWrap: 'wrap', padding: '7px 10px', width: 'fit-content', maxWidth: '720px', ...quietText }}>
        {/* 两种口径:悬挂按去重后的 canonical 边计,后三项按原始 wikilink 引用计
            (后端 memory-graph.mjs 两处注释已写明)。并排且无单位时读者会按同一分母
            去核对——实测「路径归一」比图上 resolution==='normalized' 的边多出的
            正是重复引用(2026-08-21 验收 P2)。故在此显式标注口径。*/}
        <span title="按去重后的关系计">悬挂 {summary.dangling} 条关系</span>
        <span style={{ opacity: 0.55 }}>·</span>
        <span title="以下三项按原始 wikilink 引用计;同一关系被多次引用会重复计数">
          引用解析:路径归一 {summary.linkResolution.normalized}
          {' / '}真死链 {summary.linkResolution.dead}
          {' / '}非记忆目标 {summary.linkResolution.nonMemory}
        </span>
        {unknownCount > 0 && (
          <span style={{ color: 'var(--accent-amber)', maxWidth: '300px' }}>
            未知类型 {unknownEntries.map(([type, count]) => `${type}(${count})`).join('、')}
          </span>
        )}
        <span title="客户端连通分量，不是 Leiden 社区报告">
          连通分量 {componentCount} · 最大 {largestComponentSize} · 孤立 {isolateCount}
        </span>
        <span>
          已失效 {expiredCount} · 失效时间未采集 {uncollectedValidityCount} · supersedes {supersedesCount}
        </span>
        {suggestions !== undefined && <span>补链对照已采集</span>}
        <Button variant="ghost" size="sm" onClick={onToggleSuggestions} aria-expanded={suggestionsOpen}>
          {suggestionLabel} {suggestionsOpen ? '▴' : '▾'}
        </Button>
      </div>

      {viewMode === 'community' && (
        <section className="mem-panel" aria-label="连通分量">
          <h3 style={{ fontSize: '12px', fontWeight: 700, margin: '0 0 8px' }}>连通分量</h3>
          <p style={quietText}>按已解析边计算。未选中时各取度最高一篇；点开后展开该分量，有上限。不是 GraphRAG 的 Leiden 社区摘要。</p>
          {components.filter((component) => !component.isolate).length === 0 ? (
            <p style={{ ...quietText, marginTop: '8px' }}>没有大于 1 的分量。</p>
          ) : (
            <div className="mem-panel-list" style={{ marginTop: '8px' }}>
              {components.filter((component) => !component.isolate).slice(0, 12).map((component) => (
                <button
                  key={component.id}
                  type="button"
                  className="mem-panel-row"
                  onClick={() => {
                    const seed = degrees === undefined
                      ? undefined
                      : componentHubId(component.memberIds, degrees);
                    if (seed) onFocusNode(seed);
                  }}
                >
                  <span className="u-num">#{component.id}</span>
                  <code>{
                    degrees === undefined
                      ? '度最高篇未采集'
                      : (componentHubId(component.memberIds, degrees) ?? '度最高篇未采集')
                  }</code>
                  <span className="u-microlabel">{component.size} 篇</span>
                </button>
              ))}
            </div>
          )}
          {isolateCount > 0 && (
            <p style={{ ...quietText, marginTop: '8px' }}>另有 {isolateCount} 篇孤立文档。</p>
          )}
        </section>
      )}

      {viewMode === 'lineage' && (
        <section className="mem-panel" aria-label="时间谱系">
          <h3 style={{ fontSize: '12px', fontWeight: 700, margin: '0 0 8px' }}>supersedes 谱系</h3>
          <p style={quietText}>新记录指向被取代的旧记录。没有链就不编造。</p>
          {lineageChains.length === 0 ? (
            <p style={{ ...quietText, marginTop: '8px' }}>当前图没有已解析的 supersedes 链。</p>
          ) : (
            <div className="mem-panel-list" style={{ marginTop: '8px' }}>
              {lineageChains.slice(0, 12).map((chain) => (
                <button
                  key={chain.head}
                  type="button"
                  className="mem-panel-row"
                  onClick={() => onFocusNode(chain.head)}
                >
                  <span aria-hidden="true">⇒</span>
                  <code>{chain.nodes.join(' ⇒ ')}</code>
                  <span className="u-microlabel">{chain.nodes.length} 步</span>
                </button>
              ))}
            </div>
          )}
        </section>
      )}

      {viewMode === 'local' && (
        <section className="mem-panel" aria-label="局部检索">
          <p style={quietText}>选择一个节点后，星图画它的 2 跳邻域，有上限，其余未画。这是 GraphRAG local / LightRAG 低层，不是全文生成。</p>
        </section>
      )}

      {suggestionsOpen && (
        <SuggestionList
          status={suggestionsStatus}
          suggestions={suggestions}
          error={suggestionsError}
          onRefresh={onRefreshSuggestions}
          onFocusNode={onFocusNode}
        />
      )}
    </div>
  );
};
