import React from 'react';
import { Button } from '@/components/ui/Button';
import type { MemoryNodeType } from '@/design-system/tokens';
import type { ResourceStatus } from '@/lib/resource';
import type { LinkSuggestion, MemorySearchResult } from '@/pages/memory-graph-api';
import type { MemoryGraphSummary } from './mock-graph-data';

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

function SearchResults({
  status,
  pending,
  results,
  error,
  onRetry,
  onFocusNode,
}: {
  status: ResourceStatus;
  pending: boolean;
  results?: MemorySearchResult[];
  error?: string;
  onRetry: () => void;
  onFocusNode: (id: string) => void;
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
        <div style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
          {results.map((result) => (
            <button
              key={result.slug}
              type="button"
              onClick={() => onFocusNode(result.slug)}
              style={{
                border: '1px solid var(--border-dim)',
                borderRadius: '6px',
                background: 'var(--bg-layer-2)',
                color: 'var(--text-primary)',
                padding: '8px 9px',
                textAlign: 'left',
                cursor: 'pointer',
              }}
            >
              <span style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '10px' }}>
                <code style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{result.slug}</code>
                <span className="u-num" style={{ ...quietText, whiteSpace: 'nowrap' }}>{result.score.toFixed(4)}</span>
              </span>
              {result.description && <span style={{ display: 'block', ...quietText, marginTop: '4px' }}>{result.description}</span>}
              <span className="u-microlabel" style={{ display: 'block', marginTop: '5px' }}>
                {result.matchedBy.join(' + ')}
              </span>
            </button>
          ))}
        </div>
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
                分数 {suggestion.score} · {new Date(suggestion.createdAt).toLocaleString('zh-CN', { hour12: false })} · 只读建议
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
          {totalNodes} 节点 · {totalEdges} 边
        </span>
      </div>

      {hasQuery && (
        <SearchResults
          status={searchStatus}
          pending={searchPending}
          results={searchResults}
          error={searchError}
          onRetry={onRetrySearch}
          onFocusNode={onFocusNode}
        />
      )}

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
        <Button variant="ghost" size="sm" onClick={onToggleSuggestions} aria-expanded={suggestionsOpen}>
          {suggestionLabel} {suggestionsOpen ? '▴' : '▾'}
        </Button>
      </div>

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
