import assert from 'node:assert/strict';
import test from 'node:test';
import { reconcileRemoteReplayLimit, remoteReplayValue } from './remote-run-view-model';

test('live replay follows the latest real item count', () => {
  assert.equal(remoteReplayValue(undefined, 7), 7);
  assert.equal(remoteReplayValue(undefined, 11), 11);
});

test('a user-selected history position is not pushed live by new events', () => {
  assert.equal(remoteReplayValue(7, 10), 7);
  assert.equal(remoteReplayValue(7, 11), 7);
});

test('replay only clamps when the remote trace shrinks or is empty', () => {
  assert.equal(remoteReplayValue(7, 3), 3);
  assert.equal(remoteReplayValue(7, 0), 0);
});

test('a trace rebuild persists the clamped history anchor across later growth', () => {
  let limit = reconcileRemoteReplayLimit(7, 3);
  assert.equal(limit, 3);
  assert.equal(remoteReplayValue(limit, 4), 3);
  assert.equal(remoteReplayValue(limit, 7), 3);
  assert.equal(reconcileRemoteReplayLimit(undefined, 3), undefined);
});
