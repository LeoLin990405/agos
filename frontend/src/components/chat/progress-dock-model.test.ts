import assert from 'node:assert/strict';
import test from 'node:test';
import { deriveProgressDockFromCalls, hasControlledProgressSummary } from './progress-dock-model';

test('summary prop presence selects controlled mode even when its value is undefined', () => {
  assert.equal(hasControlledProgressSummary({}), false);
  assert.equal(hasControlledProgressSummary({ summary: undefined }), true);
  assert.equal(hasControlledProgressSummary({ summary: { batches: [], done: 0, total: 0 } }), true);
});

test('deriveProgressDockFromCalls keeps in-flight and failed-settled batches', () => {
  assert.equal(deriveProgressDockFromCalls(undefined), undefined);
  assert.equal(deriveProgressDockFromCalls([]), undefined);
  assert.equal(deriveProgressDockFromCalls([
    { callId: 'ok', rows: [{ status: 'completed' }, { status: 'completed' }] },
  ]), undefined);

  const mixed = deriveProgressDockFromCalls([
    { callId: 'host:session-a', description: 'host delegation', rows: [
      { status: 'failed' },
      { status: 'completed' },
    ] },
    { callId: 'running', rows: [{ status: 'running' }, { status: 'completed' }] },
    { callId: 'clean', rows: [{ status: 'completed' }] },
  ]);
  assert.deepEqual(mixed, {
    batches: [
      { callId: 'host:session-a', label: 'host delegation', done: 1, failed: 1, total: 2 },
      { callId: 'running', label: 'running', done: 1, failed: 0, total: 2 },
    ],
    done: 2,
    total: 4,
  });
});
