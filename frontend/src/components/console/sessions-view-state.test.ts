import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveSessionsSurface } from './sessions-view-state.ts';

test('sessions surface keeps the first load quiet', () => {
  assert.deepEqual(deriveSessionsSurface({
    rowCount: 0,
    loadedAt: 0,
    error: undefined,
    connection: 'connecting',
  }), { kind: 'loading' });
});

test('a first-load error is explicit and retryable', () => {
  assert.deepEqual(deriveSessionsSurface({
    rowCount: 0,
    loadedAt: 0,
    error: 'session.list unavailable',
    connection: 'offline',
  }), { kind: 'error', canRetry: true });
});

test('empty sessions distinguish connecting, offline and genuinely empty', () => {
  const base = { rowCount: 0, loadedAt: 100, error: undefined };
  assert.deepEqual(deriveSessionsSurface({ ...base, connection: 'connecting' }), { kind: 'empty', reason: 'connecting' });
  assert.deepEqual(deriveSessionsSurface({ ...base, connection: 'offline' }), { kind: 'empty', reason: 'offline' });
  assert.deepEqual(deriveSessionsSurface({ ...base, connection: 'online' }), { kind: 'empty', reason: 'online' });
});

test('stale rows survive refresh and stream failures with an explicit notice', () => {
  assert.deepEqual(deriveSessionsSurface({
    rowCount: 2,
    loadedAt: 100,
    error: 'refresh failed',
    connection: 'online',
  }), { kind: 'rows', notice: 'refresh-error' });
  assert.deepEqual(deriveSessionsSurface({
    rowCount: 2,
    loadedAt: 100,
    error: undefined,
    connection: 'offline',
  }), { kind: 'rows', notice: 'offline' });
});

