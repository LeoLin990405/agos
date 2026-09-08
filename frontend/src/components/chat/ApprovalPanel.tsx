import React, { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Dot } from '@/components/ui/Dot';
import {
  displayCopyForView,
  localPhaseAfterClick,
  type ApprovalDecision,
  type ApprovalPhase,
} from '@/lib/approval-state';
import '@/design-system/permission-chip.css';

export interface ApprovalPanelProps {
  title: string;
  riskLevel: string;
  actionSummary: string;
  diffSnippet: string[];
  onAllow?: () => void;
  /** 「本会话永久信任」。⚠️ 只在调用方**真的能兑现**时才传:宿主契约的 respond
   *  只接受 'allowed-once' | 'rejected'(见 contract/api/approvals.ts),没有 always
   *  语义,也没有别的授权 RPC。不传则该按钮不渲染 —— 界面不承诺后端做不到的事。 */
  onAlwaysAllow?: () => void;
  onReject?: () => void;
  /** 远端 transcript 没有 approval respond 通道。保留请求内容，但真实禁用所有决策。 */
  readOnly?: boolean;
  /** Controlled phase from approval-state. Unset: local click only goes pending. */
  status?: ApprovalPhase;
  /** Controlled failure copy. Overrides the default error sentence. */
  error?: string;
  /** Extra lock from the controller (in-flight POST, non-retryable). */
  busy?: boolean;
  /** Host-evident decision. Required before the panel may say 已放行 / 已拒绝. */
  decision?: ApprovalDecision;
  /** When status is error, false keeps the buttons locked (cancel / already-handled). */
  canRetry?: boolean;
}

export const ApprovalPanel: React.FC<ApprovalPanelProps> = ({
  title,
  riskLevel,
  actionSummary,
  diffSnippet,
  onAllow,
  onAlwaysAllow,
  onReject,
  readOnly = false,
  status,
  error,
  busy = false,
  decision,
  canRetry = true,
}) => {
  const [localPhase, setLocalPhase] = useState<ApprovalPhase>('idle');
  const phase = status ?? localPhase;
  const blocked = readOnly
    || busy
    || phase === 'pending'
    || phase === 'accepted'
    || phase === 'resolved'
    || (phase === 'error' && !canRetry);
  const statusText = phase === 'error' && error !== undefined && error.trim() !== ''
    ? error
    : displayCopyForView({ phase, decision, error });

  const beginSubmit = (action?: () => void) => {
    if (blocked) return;
    if (status === undefined) setLocalPhase(localPhaseAfterClick(localPhase, blocked));
    action?.();
  };

  if (phase === 'resolved' && decision !== undefined) {
    const allowed = decision === 'allowed-once';
    return (
      <div
        className={`pc-approval-resolved ${allowed ? 'is-allowed' : 'is-rejected'}`}
        role="status"
        data-approval-phase="resolved"
        data-approval-decision={decision}
      >
        <Dot state={allowed ? 'done' : 'failed'} size={6} />
        <span>{statusText}</span>
      </div>
    );
  }

  return (
    <div className="approval-panel" data-approval-phase={phase} data-approval-busy={blocked ? 'true' : 'false'}>
      <div className="approval-header">
        <div className="approval-title-wrap">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
            <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" />
            <line x1="12" y1="9" x2="12" y2="13" />
            <line x1="12" y1="17" x2="12.01" y2="17" />
          </svg>
          <span>{title}</span>
        </div>
        <Badge className="pc-approval-risk">{riskLevel}</Badge>
      </div>

      <div className="approval-body">
        <span className="pc-approval-caption">待批动作</span>
        {/* 真实字段可能是 reason,也可能是 callId,不再套 shell 提示符伪装成命令。 */}
        <span className="pc-approval-summary">{actionSummary}</span>
        {diffSnippet.map((line, idx) => (
          <div key={idx} className={line.startsWith('+') ? 'pc-approval-diff-add' : 'pc-approval-diff-ctx'}>
            {line}
          </div>
        ))}
      </div>

      <div className="approval-actions">
        <Button variant="success" size="sm" onClick={() => beginSubmit(onAllow)} disabled={blocked}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
            <polyline points="20 6 9 17 4 12" />
          </svg>
          <span>允许单次执行</span>
        </Button>
        {onAlwaysAllow !== undefined && (
          <Button variant="secondary" size="sm" onClick={() => beginSubmit(onAlwaysAllow)} disabled={blocked}>
            <span>本会话永久信任</span>
          </Button>
        )}
        <Button variant="danger" size="sm" onClick={() => beginSubmit(onReject)} disabled={blocked}>
          <span>拒绝并中止</span>
        </Button>
      </div>
      {readOnly && (
        <p className="pc-approval-caption" role="status">
          远端审批暂不可答；请在远端控制通道处理。
        </p>
      )}
      {!readOnly && statusText !== '' && (
        <p className="pc-approval-caption" role={phase === 'error' ? 'alert' : 'status'}>
          {statusText}
        </p>
      )}
    </div>
  );
};
