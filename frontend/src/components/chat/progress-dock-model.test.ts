import assert from 'node:assert/strict';
import test from 'node:test';
import { hasControlledProgressSummary } from './progress-dock-model';

test('summary prop presence selects controlled mode even when its value is undefined', () => {
  assert.equal(hasControlledProgressSummary({}), false);
  assert.equal(hasControlledProgressSummary({ summary: undefined }), true);
  assert.equal(hasControlledProgressSummary({ summary: { batches: [], done: 0, total: 0 } }), true);
});
