import assert from 'node:assert/strict';
import test from 'node:test';
import { createRefCountedPoller } from './ref-counted-polling.ts';

test('ref-counted polling stops at the last unsubscribe and restarts on resubscribe', async () => {
  const requested: string[] = [];
  const fakeFetch = async (url: string): Promise<void> => { requested.push(url); };
  const timers = new Map<number, () => void>();
  const cleared: number[] = [];
  const microtasks: Array<() => void> = [];
  let nextHandle = 1;
  let visible = true;

  const poller = createRefCountedPoller({
    run: () => { void fakeFetch('/api/telemetry'); },
    shouldRunScheduled: () => visible,
    intervalMs: 10_000,
    setIntervalFn: (callback) => {
      const handle = nextHandle++;
      timers.set(handle, callback);
      return handle;
    },
    clearIntervalFn: (handle) => {
      cleared.push(handle);
      timers.delete(handle);
    },
    scheduleStart: (callback) => { microtasks.push(callback); },
  });

  const stopFirst = poller.acquire();
  const stopSecond = poller.acquire();
  assert.deepEqual(requested, []);
  microtasks.splice(0).forEach((callback) => callback());
  assert.deepEqual(requested, ['/api/telemetry']);
  assert.deepEqual([...timers.keys()], [1]);

  timers.get(1)?.();
  assert.equal(requested.length, 2);
  visible = false;
  timers.get(1)?.();
  assert.equal(requested.length, 2);

  stopFirst();
  assert.deepEqual(cleared, []);
  assert.deepEqual([...timers.keys()], [1]);
  stopSecond();
  stopSecond();
  assert.deepEqual(cleared, [1]);
  assert.equal(timers.size, 0);

  visible = true;
  const stopThird = poller.acquire();
  microtasks.splice(0).forEach((callback) => callback());
  assert.deepEqual(requested, ['/api/telemetry', '/api/telemetry', '/api/telemetry']);
  assert.deepEqual([...timers.keys()], [2]);
  stopThird();
  assert.deepEqual(cleared, [1, 2]);
});

test('StrictMode probe cleanup cancels its start before the real subscription', () => {
  const starts: string[] = [];
  const timers = new Map<number, () => void>();
  const microtasks: Array<() => void> = [];
  let nextHandle = 1;
  const poller = createRefCountedPoller({
    run: () => { starts.push('refresh'); },
    shouldRunScheduled: () => true,
    intervalMs: 10_000,
    setIntervalFn: (callback) => {
      const handle = nextHandle++;
      timers.set(handle, callback);
      return handle;
    },
    clearIntervalFn: (handle) => { timers.delete(handle); },
    scheduleStart: (callback) => { microtasks.push(callback); },
  });

  const stopProbe = poller.acquire();
  stopProbe();
  const stopReal = poller.acquire();
  microtasks.splice(0).forEach((callback) => callback());

  assert.deepEqual(starts, ['refresh']);
  assert.deepEqual([...timers.keys()], [1]);
  stopReal();
  assert.equal(timers.size, 0);
});
