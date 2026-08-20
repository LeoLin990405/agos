import React from 'react';
import { Chip } from '@/components/ui/Chip';
import { Button } from '@/components/ui/Button';

export interface MemorySubmitProps {
  memoryId: string;
  category: 'user' | 'feedback' | 'project' | 'reference' | 'incident';
  title: string;
  description: string;
  wikilinks: string[];
  bytes: number;
  onOpenGraph?: (nodeId: string) => void;
}

export const MemoryCard: React.FC<MemorySubmitProps> = ({
  memoryId,
  category,
  title,
  description,
  wikilinks,
  bytes,
  onOpenGraph,
}) => {
  const categoryVariant =
    category === 'project'
      ? 'purple'
      : category === 'reference'
      ? 'amber'
      : undefined;

  return (
    <div className="memory-submit-card">
      <div className="memory-submit-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span style={{ fontSize: '14px' }}>✨</span>
          <span style={{ fontWeight: 700, fontSize: '13px', color: 'var(--text-primary)' }}>
            记忆已固化沉淀: {title}
          </span>
          <Chip variant={categoryVariant}>{category.toUpperCase()}</Chip>
        </div>
        <span className="u-num" style={{ fontSize: '11px', color: 'var(--text-tertiary)' }}>
          {bytes} B · #{memoryId}
        </span>
      </div>

      <div className="memory-node-preview">
        {/* 动态生长的新节点动画 */}
        <div className="memory-growing-node" title="新节点已生长入记忆星图">
          <span style={{ fontSize: '11px', color: '#ffffff', fontWeight: 800 }}>M</span>
        </div>

        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: '12px', color: 'var(--text-secondary)', lineHeight: 1.5 }}>
            {description}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginTop: '6px', flexWrap: 'wrap' }}>
            <span className="u-microlabel">关联双链:</span>
            {wikilinks.map((link, i) => (
              <Chip key={i} style={{ height: '18px', padding: '0 5px', fontSize: '10px' }}>
                [[{link}]]
              </Chip>
            ))}
          </div>
        </div>

        <Button
          variant="primary"
          size="sm"
          onClick={() => onOpenGraph?.(memoryId)}
          style={{ alignSelf: 'center', flexShrink: 0 }}
        >
          <span>在图谱中定位 →</span>
        </Button>
      </div>
    </div>
  );
};
