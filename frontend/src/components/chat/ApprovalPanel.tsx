import React, { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Dot } from '@/components/ui/Dot';

export interface ApprovalPanelProps {
  title: string;
  riskLevel: string;
  actionSummary: string;
  diffSnippet: string[];
  onAllow?: () => void;
  onAlwaysAllow?: () => void;
  onReject?: () => void;
}

export const ApprovalPanel: React.FC<ApprovalPanelProps> = ({
  title,
  riskLevel,
  actionSummary,
  diffSnippet,
  onAllow,
  onAlwaysAllow,
  onReject,
}) => {
  const [resolvedState, setResolvedState] = useState<'idle' | 'allowed' | 'rejected'>('idle');

  const handleAllow = () => {
    setResolvedState('allowed');
    onAllow?.();
  };

  const handleAlwaysAllow = () => {
    setResolvedState('allowed');
    onAlwaysAllow?.();
  };

  const handleReject = () => {
    setResolvedState('rejected');
    onReject?.();
  };

  if (resolvedState === 'allowed') {
    return (
      <div className="approval-panel" style={{ borderColor: 'var(--state-done)' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', color: 'var(--state-done)', fontWeight: 600 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Dot state="done" />
            <span>已授权特权执行: 配置变更已生效并记入审计链</span>
          </div>
          <span className="u-num" style={{ fontSize: '11px', color: 'var(--text-tertiary)' }}>刚刚</span>
        </div>
      </div>
    );
  }

  if (resolvedState === 'rejected') {
    return (
      <div className="approval-panel" style={{ borderColor: 'var(--state-failed)' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', color: 'var(--state-failed)', fontWeight: 600 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Dot state="failed" />
            <span>特权执行已被人工否决: 命令已安全中止</span>
          </div>
          <span className="u-num" style={{ fontSize: '11px', color: 'var(--text-tertiary)' }}>刚刚</span>
        </div>
      </div>
    );
  }

  return (
    <div className="approval-panel">
      <div className="approval-header">
        <div className="approval-title-wrap">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" />
            <line x1="12" y1="9" x2="12" y2="13" />
            <line x1="12" y1="17" x2="12.01" y2="17" />
          </svg>
          <span>{title}</span>
        </div>
        <Badge style={{ backgroundColor: 'rgba(245, 158, 11, 0.15)', color: 'var(--accent-amber)', borderColor: 'rgba(245, 158, 11, 0.35)' }}>
          {riskLevel}
        </Badge>
      </div>

      <div className="approval-body">
        <div style={{ color: 'var(--text-secondary)', marginBottom: '4px' }}>$ {actionSummary}</div>
        {diffSnippet.map((line, idx) => (
          <div key={idx} style={{ color: line.startsWith('+') ? 'var(--accent-cyan)' : 'var(--text-tertiary)' }}>
            {line}
          </div>
        ))}
      </div>

      <div className="approval-actions">
        <Button variant="success" size="sm" onClick={handleAllow}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="20 6 9 17 4 12" />
          </svg>
          <span>允许单次执行</span>
        </Button>
        <Button variant="secondary" size="sm" onClick={handleAlwaysAllow}>
          <span>本会话永久信任</span>
        </Button>
        <Button variant="danger" size="sm" onClick={handleReject}>
          <span>拒绝并中止</span>
        </Button>
        <span className="u-num" style={{ marginLeft: 'auto', fontSize: '11px', color: 'var(--text-tertiary)' }}>
          超时自动拒绝: 4m 58s
        </span>
      </div>
    </div>
  );
};
