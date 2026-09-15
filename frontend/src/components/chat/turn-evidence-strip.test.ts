import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.endsWith('.css')) return { shortCircuit: true, url: 'data:text/javascript,export%20{}' };
    return nextResolve(specifier, context);
  },
});

const { TurnEvidenceStrip } = await import('./TurnEvidenceStrip');

test('unknown turn or step exposes no evidence feedback controls', () => {
  for (const props of [
    { sessionId: 's1' },
    { sessionId: 's1', turn: 3 },
    { sessionId: 's1', step: 0 },
    { sessionId: 's1', turn: 3, step: null },
    { sessionId: '', turn: 3, step: 0 },
  ]) {
    const html = renderToStaticMarkup(React.createElement(TurnEvidenceStrip, props));
    assert.match(html, /本跳编号未采集/);
    assert.doesNotMatch(html, /checkbox|记有用|记误召回|本跳回注/);
  }
});

test('a bound strip labels the requested step while evidence is not yet collected', () => {
  const html = renderToStaticMarkup(React.createElement(TurnEvidenceStrip, { sessionId: 's1', turn: 3, step: 0 }));
  assert.match(html, /轮次 3 · 步骤 0/);
  assert.match(html, /本跳证据未采集/);
  assert.doesNotMatch(html, /checkbox|记有用|记误召回/);
});
