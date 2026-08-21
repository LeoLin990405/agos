import assert from 'node:assert/strict';
import test from 'node:test';
import { deriveSwarmProgress, type TelemetryState } from './live';

const telemetry = (calls: Record<string, unknown>[] | undefined): TelemetryState => ({
  overview: undefined,
  progress: calls === undefined ? undefined : { calls },
  at: 0,
});

test('deriveSwarmProgress is absent when no batch is running', () => {
  assert.equal(deriveSwarmProgress(telemetry(undefined)), undefined);
  assert.equal(deriveSwarmProgress(telemetry([])), undefined);
  assert.equal(deriveSwarmProgress(telemetry([
    {
      callId: 'settled',
      rows: [{ status: 'completed' }, { status: 'failed' }],
    },
  ])), undefined);
});

test('deriveSwarmProgress folds only unsettled rows and preserves failures', () => {
  assert.deepEqual(deriveSwarmProgress(telemetry([
    {
      callId: 'active-a',
      description: 'A batch',
      rows: [{ status: 'completed' }, { status: 'failed' }, { status: 'running' }],
    },
    {
      callId: 'active-b',
      rows: [{ status: 'completed' }, { status: 'queued' }],
    },
    { callId: 'empty', rows: [] },
  ])), {
    batches: [
      { callId: 'active-a', label: 'A batch', done: 1, failed: 1, total: 3 },
      { callId: 'active-b', label: 'active-b', done: 1, failed: 0, total: 2 },
    ],
    done: 2,
    total: 5,
  });
});

test('deriveSwarmProgress tolerates malformed row containers', () => {
  assert.equal(deriveSwarmProgress(telemetry([
    { callId: 'missing' },
    { callId: 'wrong', rows: {} },
  ])), undefined);
});
