import React from 'react';
import { Dot } from '@/components/ui/Dot';
import { Chip } from '@/components/ui/Chip';

export interface RootNodeCardProps {
  name: string;
  model: string;
  sessionRole: string;
  description: string;
  duration: string;
  spawnedCount: number;
}

export const RootNodeCard: React.FC<RootNodeCardProps> = ({
  name,
  model,
  sessionRole,
  description,
  duration,
  spawnedCount,
}) => {
  return (
    <div className="root-agent-card">
      <div style={{ display: 'flex', alignItems: 'center', gap: '14px' }}>
        <Dot state="running" size={12} />
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <span style={{ fontWeight: 700, fontSize: '14.5px', color: 'var(--text-primary)' }}>
              {name}
            </span>
            <Chip variant="purple">{model}</Chip>
            <Chip active>{sessionRole}</Chip>
          </div>
          <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginTop: '4px' }}>
            {description}
          </div>
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: '20px' }}>
        <div style={{ textAlign: 'right' }}>
          <span className="u-microlabel">总耗时</span>
          <div className="u-num" style={{ fontWeight: 700, fontSize: '14px' }}>
            {duration}
          </div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <span className="u-microlabel">已派生节点</span>
          <div className="u-num" style={{ fontWeight: 700, fontSize: '14px', color: 'var(--state-running)' }}>
            {spawnedCount} Nodes
          </div>
        </div>
      </div>
    </div>
  );
};
