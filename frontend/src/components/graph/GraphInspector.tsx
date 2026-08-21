import React from 'react';
import type { MemoryEdgeData, MemoryNodeData } from './mock-graph-data';
import { Chip } from '@/components/ui/Chip';
import { Button } from '@/components/ui/Button';
import { MEMORY_TYPE_DEFS } from '@/design-system/tokens';

export interface GraphInspectorProps {
  node: MemoryNodeData | null;
  edges: MemoryEdgeData[];
  onClose?: () => void;
  onNavigateNode?: (id: string) => void;
}

type EdgeGroup = {
  title: string;
  empty: string;
  edges: MemoryEdgeData[];
  targetOf: (edge: MemoryEdgeData) => string;
  direction: string;
};

const resolutionLabel: Record<MemoryEdgeData['resolution'], string> = {
  direct: '直接命中',
  normalized: '路径归一',
  dead: '真死链',
  nonMemory: '非记忆目标',
};

function RelationGroup({ group, onNavigateNode }: { group: EdgeGroup; onNavigateNode?: (id: string) => void }) {
  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
      <span className="u-microlabel">{group.title}</span>
      {group.edges.length === 0 ? (
        <span style={{ color: 'var(--text-tertiary)', fontSize: '11.5px' }}>{group.empty}</span>
      ) : group.edges.map((edge, index) => {
        const target = group.targetOf(edge);
        const canNavigate = !edge.dangling;
        return (
          <button
            key={`${edge.from}:${edge.to}:${edge.kind}:${index}`}
            type="button"
            disabled={!canNavigate}
            onClick={() => { if (canNavigate) onNavigateNode?.(target); }}
            style={{
              display: 'grid',
              gridTemplateColumns: 'auto minmax(0, 1fr) auto',
              alignItems: 'center',
              gap: '7px',
              width: '100%',
              padding: '8px 9px',
              backgroundColor: 'var(--bg-layer-2)',
              border: edge.dangling ? '1px dashed var(--accent-amber)' : '1px solid var(--border-dim)',
              borderRadius: '6px',
              cursor: canNavigate ? 'pointer' : 'default',
              color: edge.dangling ? 'var(--accent-amber)' : 'var(--text-primary)',
              textAlign: 'left',
            }}
          >
            <span aria-hidden="true">{edge.kind === 'supersedes' ? group.direction : edge.dangling ? '⚠' : '↗'}</span>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: '11.5px', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {target}
            </span>
            <span className="u-microlabel" style={{ color: 'inherit', whiteSpace: 'nowrap' }}>
              {resolutionLabel[edge.resolution]}
            </span>
          </button>
        );
      })}
    </section>
  );
}

export const GraphInspector: React.FC<GraphInspectorProps> = ({
  node,
  edges,
  onClose,
  onNavigateNode,
}) => {
  if (!node) {
    return (
      <aside className="graph-inspector-drawer">
        <div style={{ padding: '20px 0', textAlign: 'center', color: 'var(--text-tertiary)' }}>
          <div style={{ fontSize: '32px', marginBottom: '8px' }}>🧬</div>
          <div style={{ fontWeight: 600, fontSize: '13px', color: 'var(--text-secondary)' }}>
            选择星图中的记忆节点
          </div>
          <div style={{ fontSize: '11.5px', marginTop: '4px', lineHeight: 1.5 }}>
            点击或悬浮节点可查看真实链接、失效关系与数据质量状态。
          </div>
        </div>
      </aside>
    );
  }

  const typeMeta = MEMORY_TYPE_DEFS[node.type];
  const dateStr = new Date(node.mtime).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
  const validUntil = node.validUntil === undefined ? undefined : new Date(node.validUntil).toLocaleString('zh-CN', { hour12: false });
  const groups: EdgeGroup[] = [
    {
      title: 'Wikilink 出边',
      empty: '没有已解析的出边。',
      edges: edges.filter((edge) => edge.kind === 'wikilink' && edge.from === node.id && !edge.dangling),
      targetOf: (edge) => edge.to,
      direction: '→',
    },
    {
      title: '未解析 Wikilink',
      empty: '没有悬挂链接。',
      edges: edges.filter((edge) => edge.kind === 'wikilink' && edge.from === node.id && edge.dangling),
      targetOf: (edge) => edge.to,
      direction: '→',
    },
    {
      title: '取代的旧记忆',
      empty: '没有 supersedes 出边。',
      edges: edges.filter((edge) => edge.kind === 'supersedes' && edge.from === node.id),
      targetOf: (edge) => edge.to,
      direction: '⇒',
    },
    {
      title: '被新记忆取代',
      empty: '没有指向此节点的 supersedes 边。',
      edges: edges.filter((edge) => edge.kind === 'supersedes' && edge.to === node.id),
      targetOf: (edge) => edge.from,
      direction: '⇐',
    },
  ];

  return (
    <aside className="graph-inspector-drawer">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
        <Chip
          style={{
            backgroundColor: typeMeta.colorBg,
            color: typeMeta.color,
            borderColor: `${typeMeta.color}40`,
            fontWeight: 700,
          }}
        >
          {typeMeta.label}
        </Chip>
        {onClose && <Button variant="ghost" size="sm" onClick={onClose} aria-label="关闭记忆检查器">×</Button>}
      </div>

      <div>
        <h2 style={{ fontSize: '14.5px', fontWeight: 700, color: 'var(--text-primary)', lineHeight: 1.4, margin: 0 }}>
          {node.title}
        </h2>
        <div style={{ fontFamily: 'var(--font-mono)', fontSize: '11px', color: 'var(--text-tertiary)', marginTop: '4px' }}>
          #{node.id}
        </div>
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center', marginTop: '7px', flexWrap: 'wrap' }}>
          <span className="u-microlabel">原始类型 {node.sourceType}</span>
          <span className="u-num" style={{ fontSize: '11px', color: 'var(--text-tertiary)' }}>出度 {node.outDegree}</span>
          {validUntil && <Chip variant="amber">失效于 {validUntil}</Chip>}
        </div>
      </div>

      <div style={{ backgroundColor: 'var(--bg-layer-2)', border: '1px solid var(--border-subtle)', borderRadius: '8px', padding: '12px', fontSize: '12.5px', color: 'var(--text-secondary)', lineHeight: 1.6 }}>
        {node.description || '该记忆没有 description 摘要。'}
      </div>

      {groups.map((group) => (
        <RelationGroup key={group.title} group={group} onNavigateNode={onNavigateNode} />
      ))}

      <div style={{ marginTop: 'auto', borderTop: '1px solid var(--border-dim)', paddingTop: '12px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: '11px', color: 'var(--text-tertiary)' }}>
        <span>大小: <strong className="u-num">{node.bytes} B</strong></span>
        <span>更新: <strong className="u-num">{dateStr}</strong></span>
      </div>
    </aside>
  );
};
