import React from 'react';

export interface TerminalCardProps {
  title: string;
  command: string;
  output: string;
  exitCode?: number;
  duration?: string;
  className?: string;
}

export const TerminalCard: React.FC<TerminalCardProps> = ({
  title,
  command,
  output,
  exitCode = 0,
  duration,
  className = '',
}) => {
  return (
    <div className={`terminal-card ${className}`}>
      <div className="terminal-header">
        <div className="terminal-controls">
          <span className="terminal-dot terminal-dot--red" />
          <span className="terminal-dot terminal-dot--yellow" />
          <span className="terminal-dot terminal-dot--green" />
        </div>
        <div className="terminal-header-title">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="4 17 10 11 4 5" />
            <line x1="12" y1="19" x2="20" y2="19" />
          </svg>
          <span>{title}</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          {duration && <span className="u-num" style={{ color: 'var(--text-tertiary)' }}>{duration}</span>}
          <span className={`u-num ${exitCode === 0 ? 'terminal-badge-ok' : 'text-danger'}`}>
            EXIT {exitCode}
          </span>
        </div>
      </div>
      <div className="terminal-body">
        <div className="terminal-cmd">$ {command}</div>
        <div className="terminal-output">{output}</div>
      </div>
    </div>
  );
};
