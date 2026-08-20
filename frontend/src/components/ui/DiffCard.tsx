import React from 'react';

export interface DiffLine {
  type: 'add' | 'del' | 'ctx';
  lineNo: number | string;
  content: string;
}

export interface DiffCardProps {
  filePath: string;
  action?: string;
  stats?: string;
  lines: DiffLine[];
  className?: string;
}

export const DiffCard: React.FC<DiffCardProps> = ({
  filePath,
  action = 'replace_file_content',
  stats,
  lines,
  className = '',
}) => {
  return (
    <div className={`diff-card ${className}`}>
      <div className="diff-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontWeight: 600, color: 'var(--text-secondary)' }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <polyline points="14 2 14 8 20 8" />
          </svg>
          <span>{action}: {filePath}</span>
        </div>
        {stats && <span className="u-num" style={{ color: 'var(--text-tertiary)', fontSize: '11px' }}>{stats}</span>}
      </div>
      <div className="diff-lines">
        {lines.map((line, idx) => (
          <div
            key={idx}
            className={`diff-line ${
              line.type === 'add' ? 'diff-line--add' : line.type === 'del' ? 'diff-line--del' : 'diff-line--ctx'
            }`}
          >
            <span style={{ minWidth: '28px', textAlign: 'right', opacity: 0.6 }}>{line.lineNo}</span>
            <span>{line.type === 'add' ? '+' : line.type === 'del' ? '-' : ' '} {line.content}</span>
          </div>
        ))}
      </div>
    </div>
  );
};
