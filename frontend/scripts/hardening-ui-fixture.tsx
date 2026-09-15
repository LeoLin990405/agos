// Synthetic component fixture only: never connects to a running DSH host.
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ApprovalPanel } from '../src/components/chat/ApprovalPanel';
import { HistoryIntegrity } from '../src/components/chat/HistoryIntegrity';
import type { ApprovalPhase } from '../src/lib/approval-state';

function Fixture() {
  const [phase, setPhase] = useState<ApprovalPhase>('idle');
  const [readOnly, setReadOnly] = useState(false);
  const [history, setHistory] = useState({ incomplete: true, retryable: false, loading: false });
  const api = (window as any).__hardening ??= { approvals: 0, pages: 0 };
  api.setPhase = setPhase;
  api.setReadOnly = setReadOnly;
  api.setHistory = setHistory;
  function submit() { api.approvals++; setPhase('pending'); }
  function earlier() { api.pages++; setHistory(s => ({ ...s, loading: true })); }
  return <main style={{ maxWidth: 800, padding: 24, fontFamily: 'sans-serif' }}>
    <h1>AgOS offline acceptance fixture</h1>
    <ApprovalPanel title="合成审批请求" riskLevel="测试" actionSummary="fixture only"
      diffSnippet={[]} status={phase} decision={phase === 'resolved' ? 'allowed-once' : undefined}
      error={phase === 'error' ? '合成网络失败，请重试' : undefined} canRetry readOnly={readOnly}
      onAllow={submit} onReject={submit} />
    <HistoryIntegrity historyIncomplete={history.incomplete} retryable={history.retryable}
      loading={history.loading} hasMore error={history.retryable ? '合成分页失败' : undefined}
      onLoadEarlier={earlier} onRetry={earlier} />
  </main>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
