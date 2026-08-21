import assert from 'node:assert/strict';
import test from 'node:test';
import { clampReplayValue } from './replay-model';

test('clampReplayValue handles empty and lower bounds', () => {
  assert.equal(clampReplayValue(-9, 0), 1);
  assert.equal(clampReplayValue(-9, 8), 1);
  assert.equal(clampReplayValue(0, 8), 1);
});

test('clampReplayValue rounds, caps and treats invalid values as latest', () => {
  assert.equal(clampReplayValue(2.4, 8), 2);
  assert.equal(clampReplayValue(2.6, 8), 3);
  assert.equal(clampReplayValue(99, 8), 8);
  assert.equal(clampReplayValue(Number.NaN, 8), 8);
  assert.equal(clampReplayValue(Number.POSITIVE_INFINITY, 8), 8);
});
