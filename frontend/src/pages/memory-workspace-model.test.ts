import assert from 'node:assert/strict';
import test from 'node:test';
import { consumeMemoryIntent, memoryIntent, resolveWorkingSessionId } from './memory-workspace-model';

test('memoryIntent trims identifiers and treats a bare open as an empty intent', () => {
  assert.deepEqual(memoryIntent(), {});
  assert.deepEqual(memoryIntent({ sessionId: '  s-1  ', nodeId: '  project-agos  ' }), {
    sessionId: 's-1',
    nodeId: 'project-agos',
  });
  assert.deepEqual(memoryIntent({ sessionId: '   ', nodeId: '' }), {});
});

test('consumeMemoryIntent is undefined only when no jump was issued', () => {
  assert.equal(consumeMemoryIntent(undefined), undefined);
  assert.deepEqual(consumeMemoryIntent({ sessionId: ' s ' }), { sessionId: 's' });
});

test('working session prefers an explicit dock pick over the live conversation', () => {
  assert.equal(resolveWorkingSessionId('picked', 'live'), 'picked');
  assert.equal(resolveWorkingSessionId(undefined, 'live'), 'live');
  assert.equal(resolveWorkingSessionId('  ', '  '), undefined);
  assert.equal(resolveWorkingSessionId(undefined, undefined), undefined);
});
