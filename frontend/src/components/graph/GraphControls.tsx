import React from 'react';
import { Button } from '@/components/ui/Button';
import { MemoryNodeType } from '@/design-system/tokens';

export interface GraphControlsProps {
  searchQuery: string;
  onSearchChange: (q: string) => void;
  typeFilter: string;
  onTypeFilterChange: (t: string) => void;
  counts: Record<MemoryNodeType, number>;
  totalNodes: number;
  totalEdges: number;
  isSimulating: boolean;
  onToggleSimulation: () => void;
  onResetZoom?: () => void;
}

export const GraphControls: React.FC<GraphControlsProps> = ({
  searchQuery,
  onSearchChange,
  typeFilter,
  onTypeFilterChange,
  counts,
  totalNodes,
  totalEdges,
  isSimulating,
  onToggleSimulation,
  onResetZoom,
}) => {
  return (
    <div className="graph-controls-floating">
      {/* 搜索与统计 */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '10px',
          backgroundColor: 'var(--bg-layer-1)',
          border: '1px solid var(--border-subtle)',
          borderRadius: '8px',
          padding: '8px 14px',
          boxShadow: 'var(--shadow-panel)',
        }}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style={{ color: 'var(--text-tertiary)' }}>
          <circle cx="11" cy="11" r="8" />
          <path d="m21 21-4.3-4.3" />
        </svg>
        <input
          type="text"
          placeholder="搜索 124 篇记忆节点 / 关键词..."
          style={{
            background: 'transparent',
            border: 'none',
            outline: 'none',
            fontSize: '12.5px',
            color: 'var(--text-primary)',
            width: '240px',
          }}
          value={searchQuery}
          onChange={(e) => onSearchChange(e.target.value)}
        />
        <div style={{ width: '1px', height: '16px', backgroundColor: 'var(--border-dim)' }} />
        <span className="u-num" style={{ fontSize: '11px', color: 'var(--text-tertiary)' }}>
          {totalNodes} 节点 · {totalEdges} 边
        </span>
      </div>

      {/* 类型筛选器 */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '6px',
          backgroundColor: 'var(--bg-layer-1)',
          border: '1px solid var(--border-subtle)',
          borderRadius: '8px',
          padding: '6px 10px',
          boxShadow: 'var(--shadow-panel)',
          flexWrap: 'wrap',
        }}
      >
        <button
          type="button"
          className={`btn btn-sm ${typeFilter === 'all' ? 'btn-primary' : 'btn-ghost'}`}
          onClick={() => onTypeFilterChange('all')}
        >
          全部 ({totalNodes})
        </button>
        <button
          type="button"
          className={`btn btn-sm ${typeFilter === 'user' ? 'btn-primary' : 'btn-ghost'}`}
          onClick={() => onTypeFilterChange('user')}
          style={{ color: 'var(--mem-user)' }}
        >
          ● User ({counts.user})
        </button>
        <button
          type="button"
          className={`btn btn-sm ${typeFilter === 'feedback' ? 'btn-primary' : 'btn-ghost'}`}
          onClick={() => onTypeFilterChange('feedback')}
          style={{ color: 'var(--mem-feedback)' }}
        >
          ● Feedback ({counts.feedback})
        </button>
        <button
          type="button"
          className={`btn btn-sm ${typeFilter === 'project' ? 'btn-primary' : 'btn-ghost'}`}
          onClick={() => onTypeFilterChange('project')}
          style={{ color: 'var(--mem-project)' }}
        >
          ● Project ({counts.project})
        </button>
        <button
          type="button"
          className={`btn btn-sm ${typeFilter === 'reference' ? 'btn-primary' : 'btn-ghost'}`}
          onClick={() => onTypeFilterChange('reference')}
          style={{ color: 'var(--mem-reference)' }}
        >
          ● Ref ({counts.reference})
        </button>
        <button
          type="button"
          className={`btn btn-sm ${typeFilter === 'incident' ? 'btn-primary' : 'btn-ghost'}`}
          onClick={() => onTypeFilterChange('incident')}
          style={{ color: 'var(--mem-incident)' }}
        >
          ● Incident ({counts.incident})
        </button>

        <div style={{ marginLeft: 'auto', display: 'flex', gap: '4px' }}>
          <Button variant="ghost" size="sm" onClick={onToggleSimulation} title="暂停/恢复物理仿真">
            {isSimulating ? '⏸ 冻结' : '▶ 演进'}
          </Button>
          <Button variant="ghost" size="sm" onClick={onResetZoom} title="重置星图镜头">
            ⊙ 居中
          </Button>
        </div>
      </div>
    </div>
  );
};
