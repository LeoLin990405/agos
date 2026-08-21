import assert from 'node:assert/strict';
import test from 'node:test';
import { idleResource, mergeResource, nextBackoff, type ResourceState } from './resource';

test('nextBackoff doubles from base and respects the cap', () => {
  assert.equal(nextBackoff(0, 1_000, 30_000), 1_000);
  assert.equal(nextBackoff(1, 1_000, 30_000), 2_000);
  assert.equal(nextBackoff(5, 1_000, 30_000), 30_000);
  assert.equal(nextBackoff(99, 1_000, 30_000), 30_000);
});

test('nextBackoff normalizes unsafe inputs', () => {
  assert.equal(nextBackoff(-2, 500, 4_000), 500);
  assert.equal(nextBackoff(Number.NaN, 500, 4_000), 500);
  assert.equal(nextBackoff(2, -1, 4_000), 0);
  assert.equal(nextBackoff(2, 2_000, 1_000), 2_000);
});

test('mergeResource covers idle, loading and first-load error', () => {
  const idle = idleResource<{ value: number }>();
  assert.deepEqual(idle, { status: 'idle', attempt: 0 });
  const loading = mergeResource(idle, { type: 'load' });
  assert.equal(loading.status, 'loading');
  const failed = mergeResource(loading, { type: 'reject', error: 'offline', status: 503, at: 12 });
  assert.deepEqual(failed, {
    status: 'error',
    attempt: 1,
    error: { message: 'offline', status: 503, at: 12 },
  });
});

test('mergeResource preserves good data when a refresh degrades', () => {
  const ready = mergeResource(idleResource<{ value: number }>(), {
    type: 'resolve', data: { value: 7 }, at: 100,
  });
  const loading = mergeResource(ready, { type: 'load' });
  assert.deepEqual(loading.data, { value: 7 });
  const degraded = mergeResource(loading, {
    type: 'reject', error: Object.assign(new Error('gateway'), { status: 502 }), at: 200,
  });
  assert.equal(degraded.status, 'degraded');
  assert.deepEqual(degraded.data, { value: 7 });
  assert.equal(degraded.at, 100);
  assert.deepEqual(degraded.error, { message: 'gateway', status: 502, at: 200 });
  assert.equal(degraded.attempt, 1);
});

test('a successful retry clears error and attempt; reset discards payload', () => {
  const degraded: ResourceState<number> = {
    status: 'degraded', data: 1, at: 10, attempt: 3,
    error: { message: 'old', at: 20 },
  };
  const ready = mergeResource(degraded, { type: 'resolve', data: 2, at: 30 });
  assert.deepEqual(ready, { status: 'ready', data: 2, at: 30, attempt: 0 });
  assert.deepEqual(mergeResource(ready, { type: 'reset' }), { status: 'idle', attempt: 0 });
});
