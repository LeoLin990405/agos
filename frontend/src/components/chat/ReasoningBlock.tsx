import React, { useState } from 'react';

export interface ReasoningBlockProps {
  duration?: string;
  tokens?: string;
  title?: string;
  children: React.ReactNode;
  defaultExpanded?: boolean;
}

export const ReasoningBlock: React.FC<ReasoningBlockProps> = ({
  duration = '3.4s',
  tokens = '1,420 tokens',
  title = '思考过程: 深度安全契约与拓扑分析',
  children,
  defaultExpanded = true,
}) => {
  const [expanded, setExpanded] = useState(defaultExpanded);

  return (
    <div className="cot-block">
      <div className="cot-header" onClick={() => setExpanded(!expanded)}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span className="cot-toggle-icon">{expanded ? '▾' : '▸'}</span>
          <span>{title} {duration && `(耗时 ${duration})`}</span>
        </div>
        {tokens && <span className="u-num" style={{ fontSize: '11px', color: 'var(--text-tertiary)' }}>{tokens}</span>}
      </div>
      {expanded && <div className="cot-content">{children}</div>}
    </div>
  );
};
