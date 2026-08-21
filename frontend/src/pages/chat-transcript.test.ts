import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

// Production components import design-system CSS. The test exercises their JS
// contract only, so resolve styles to an inert ESM module without adding jsdom.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.endsWith('.css')) {
      return { shortCircuit: true, url: 'data:text/javascript,export%20{}' };
    }
    return nextResolve(specifier, context);
  },
});

const { hasSnapshotOverride } = await import('./chat-transcript');
const { ApprovalPanel } = await import('@/components/chat/ApprovalPanel');

test('snapshot override distinguishes omitted, own undefined, and inherited values', () => {
  assert.equal(hasSnapshotOverride({ sessionId: 'local' }), false);
  assert.equal(hasSnapshotOverride({ sessionId: 'remote', snapshotOverride: undefined }), true);

  const inherited = Object.create({ snapshotOverride: undefined }) as { sessionId: string };
  inherited.sessionId = 'inherited';
  assert.equal(hasSnapshotOverride(inherited), false);
});

test('read-only approval exposes no actionable browser control and explains why', () => {
  const html = renderToStaticMarkup(React.createElement(ApprovalPanel, {
    title: '远端审批',
    riskLevel: '需人工决策',
    actionSummary: 'fixture',
    diffSnippet: [],
    readOnly: true,
    onAllow: () => assert.fail('read-only allow must not run'),
    onReject: () => assert.fail('read-only reject must not run'),
  }));

  assert.equal((html.match(/disabled=""/g) ?? []).length, 2);
  assert.match(html, /远端审批暂不可答/);
});
