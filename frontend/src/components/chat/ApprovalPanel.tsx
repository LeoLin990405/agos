import React, { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Dot } from '@/components/ui/Dot';
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
}) => {
  const [resolvedState, setResolvedState] = useState<'idle' | 'allowed' | 'rejected'>('idle');

  const handleAllow = () => {
    if (readOnly) return;
    setResolvedState('allowed');
    onAllow?.();
  };

  const handleAlwaysAllow = () => {
    if (readOnly) return;
    setResolvedState('allowed');
    onAlwaysAllow?.();
  };

  const handleReject = () => {
    if (readOnly) return;
    setResolvedState('rejected');
    onReject?.();
  };

  // 结果态收敛成一行状态胶囊(与 composer 权限胶囊同语汇):6px 灯 + 状态底色。
  // 原先的「刚刚」是伪时间戳,页面停留久了就是假话,这里去掉。
  if (resolvedState === 'allowed') {
    return (
      <div className="pc-approval-resolved is-allowed" role="status">
        <Dot state="done" size={6} />
        <span>已放行:本次特权执行已授权</span>
      </div>
    );
  }

  if (resolvedState === 'rejected') {
    return (
      <div className="pc-approval-resolved is-rejected" role="status">
        <Dot state="failed" size={6} />
        <span>已拒绝:本次特权执行已中止</span>
      </div>
    );
  }

  return (
    <div className="approval-panel">
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
        <Button variant="success" size="sm" onClick={handleAllow} disabled={readOnly}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
            <polyline points="20 6 9 17 4 12" />
          </svg>
          <span>允许单次执行</span>
        </Button>
        {onAlwaysAllow !== undefined && (
          <Button variant="secondary" size="sm" onClick={handleAlwaysAllow} disabled={readOnly}>
            <span>本会话永久信任</span>
          </Button>
        )}
        <Button variant="danger" size="sm" onClick={handleReject} disabled={readOnly}>
          <span>拒绝并中止</span>
        </Button>
      </div>
      {readOnly && (
        <p className="pc-approval-caption" role="status">
          远端审批暂不可答；请在远端控制通道处理。
        </p>
      )}
    </div>
  );
};
