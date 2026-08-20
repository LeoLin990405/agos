import React from 'react';
import { MemoryNodeData } from './mock-graph-data';
import { Chip } from '@/components/ui/Chip';
import { Button } from '@/components/ui/Button';
import { MEMORY_TYPE_DEFS } from '@/design-system/tokens';

export interface GraphInspectorProps {
  node: MemoryNodeData | null;
  onClose?: () => void;
  onNavigateNode?: (id: string) => void;
}

export const GraphInspector: React.FC<GraphInspectorProps> = ({
  node,
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
            点击或悬浮节点可查看其双链拓扑关系、内容摘要与出度指标。
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

  return (
    <aside className="graph-inspector-drawer">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
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
        <span className="u-num" style={{ fontSize: '11px', color: 'var(--text-tertiary)' }}>
          出度 {node.outDegree}
        </span>
      </div>

      <div>
        <h2 style={{ fontSize: '14.5px', fontWeight: 700, color: 'var(--text-primary)', lineHeight: 1.4 }}>
          {node.title}
        </h2>
        <div style={{ fontFamily: 'var(--font-mono)', fontSize: '11px', color: 'var(--text-tertiary)', marginTop: '4px' }}>
          #{node.id}
        </div>
      </div>

      <div style={{ backgroundColor: 'var(--bg-layer-2)', border: '1px solid var(--border-subtle)', borderRadius: '8px', padding: '12px', fontSize: '12.5px', color: 'var(--text-secondary)', lineHeight: 1.6 }}>
        {node.description}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
        <span className="u-microlabel">出边双链引申 (Outbound Links)</span>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
          {node.wikilinks.map((link, idx) => {
            const isDangling = link.startsWith('dangling-');
            return (
              <div
                key={idx}
                onClick={() => !isDangling && onNavigateNode?.(link)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: '8px 10px',
                  backgroundColor: 'var(--bg-layer-2)',
                  border: isDangling ? '1px dashed var(--accent-amber)' : '1px solid var(--border-dim)',
                  borderRadius: '6px',
                  cursor: isDangling ? 'default' : 'pointer',
                  fontSize: '11.5px',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <span style={{ color: isDangling ? 'var(--accent-amber)' : 'var(--state-running)' }}>
                    {isDangling ? '⚠' : '[[Link]]'}
                  </span>
                  <span style={{ fontFamily: 'var(--font-mono)', color: isDangling ? 'var(--accent-amber)' : 'var(--text-primary)' }}>
                    {link}
                  </span>
                </div>
                {isDangling && (
                  <span className="u-microlabel" style={{ color: 'var(--accent-amber)' }}>待写钩子</span>
                )}
              </div>
            );
          })}
        </div>
      </div>

      <div style={{ marginTop: 'auto', borderTop: '1px solid var(--border-dim)', paddingTop: '12px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: '11px', color: 'var(--text-tertiary)' }}>
        <span>大小: <strong className="u-num">{node.bytes} B</strong></span>
        <span>更新: <strong className="u-num">{dateStr}</strong></span>
      </div>
    </aside>
  );
};
