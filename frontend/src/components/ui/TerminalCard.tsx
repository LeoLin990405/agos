import React from 'react';
import { Dot } from '@/components/ui/Dot';

export interface TerminalCardProps {
  title: string;
  command: string;
  output: string;
  /** Omit while the command is still running — never invent EXIT 0. */
  exitCode?: number;
  duration?: string;
  running?: boolean;
  className?: string;
}

export const TerminalCard: React.FC<TerminalCardProps> = ({
  title,
  command,
  output,
  exitCode,
  duration,
  running = false,
  className = '',
}) => {
  return (
    <div className={`terminal-card${running ? ' is-running' : ''}${className !== '' ? ` ${className}` : ''}`}>
      <div className="terminal-header">
        <div className="terminal-controls">
          <span className="terminal-dot terminal-dot--red" />
          <span className="terminal-dot terminal-dot--yellow" />
          <span className="terminal-dot terminal-dot--green" />
        </div>
        <div className="terminal-header-title">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <polyline points="4 17 10 11 4 5" />
            <line x1="12" y1="19" x2="20" y2="19" />
          </svg>
          <span>{title}</span>
        </div>
        <div className="terminal-header-meta">
          {duration !== undefined && duration !== '' && (
            <span className="u-num terminal-dur">{duration}</span>
          )}
          {running ? (
            <span className="u-num terminal-running">
              <Dot state="running" size={6} />
              运行中
            </span>
          ) : exitCode !== undefined ? (
            <span className={`u-num ${exitCode === 0 ? 'terminal-badge-ok' : 'text-danger'}`}>
              EXIT {exitCode}
            </span>
          ) : null}
        </div>
      </div>
      <div className="terminal-body">
        <div className="terminal-cmd">$ {command}</div>
        <div className="terminal-output">{output}</div>
      </div>
    </div>
  );
};
