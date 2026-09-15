import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { APPROVAL_COPY } from '@/lib/approval-state';

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.endsWith('.css')) {
      return { shortCircuit: true, url: 'data:text/javascript,export%20{}' };
    }
    return nextResolve(specifier, context);
  },
});

const { ApprovalPanel } = await import('./ApprovalPanel');

const base = {
  title: '特权操作审批请求:bash',
  riskLevel: '需人工决策',
  actionSummary: 'escalate sandbox',
  diffSnippet: [] as string[],
};

function render(props: Record<string, unknown> = {}): string {
  return renderToStaticMarkup(React.createElement(ApprovalPanel, { ...base, ...props }));
}

test('idle panel does not claim 已放行 and keeps allow/reject', () => {
  const html = render({ onAllow: () => undefined, onReject: () => undefined });
  assert.match(html, /data-approval-phase="idle"/);
  assert.match(html, /允许单次执行/);
  assert.match(html, /拒绝并中止/);
  assert.doesNotMatch(html, /已放行/);
  assert.doesNotMatch(html, /已拒绝:本次特权执行已中止/);
  assert.doesNotMatch(html, /本会话永久信任/);
});

test('pending and accepted wait for host evidence and lock the buttons', () => {
  const pending = render({ status: 'pending', onAllow: () => undefined, onReject: () => undefined });
  assert.match(pending, /data-approval-phase="pending"/);
  assert.match(pending, /data-approval-busy="true"/);
  assert.match(pending, new RegExp(APPROVAL_COPY.pending));
  assert.equal((pending.match(/disabled=""/g) ?? []).length, 2);
  assert.doesNotMatch(pending, /已放行/);

  const accepted = render({ status: 'accepted', onAllow: () => undefined, onReject: () => undefined });
  assert.match(accepted, /data-approval-phase="accepted"/);
  assert.match(accepted, new RegExp(APPROVAL_COPY.accepted));
  assert.doesNotMatch(accepted, /已放行/);
  assert.equal((accepted.match(/disabled=""/g) ?? []).length, 2);
});

test('resolved capsule appears only with host-evident decision', () => {
  const allowed = render({ status: 'resolved', decision: 'allowed-once' });
  assert.match(allowed, /data-approval-phase="resolved"/);
  assert.match(allowed, /已放行:本次特权执行已授权/);
  assert.doesNotMatch(allowed, /允许单次执行/);

  const rejected = render({ status: 'resolved', decision: 'rejected' });
  assert.match(rejected, /已拒绝:本次特权执行已中止/);
  assert.match(rejected, /data-approval-decision="rejected"/);
});

test('error copy is recoverable unless canRetry is false', () => {
  const retryable = render({
    status: 'error',
    error: APPROVAL_COPY.network,
    onAllow: () => undefined,
    onReject: () => undefined,
  });
  assert.match(retryable, /role="alert"/);
  assert.match(retryable, new RegExp(APPROVAL_COPY.network));
  assert.equal((retryable.match(/disabled=""/g) ?? []).length, 0);

  const locked = render({
    status: 'error',
    error: APPROVAL_COPY.cancelled,
    canRetry: false,
    onAllow: () => undefined,
    onReject: () => undefined,
  });
  assert.equal((locked.match(/disabled=""/g) ?? []).length, 2);
});

test('busy and read-only keep remote semantics and do not invent always-allow', () => {
  const busy = render({
    busy: true,
    onAllow: () => undefined,
    onReject: () => undefined,
    onAlwaysAllow: () => undefined,
  });
  assert.match(busy, /本会话永久信任/);
  assert.equal((busy.match(/disabled=""/g) ?? []).length, 3);

  const remote = render({
    readOnly: true,
    onAllow: () => assert.fail('read-only allow must not run'),
    onReject: () => assert.fail('read-only reject must not run'),
  });
  assert.match(remote, /远端审批暂不可答/);
  assert.equal((remote.match(/disabled=""/g) ?? []).length, 2);
  assert.doesNotMatch(remote, /本会话永久信任/);
});
