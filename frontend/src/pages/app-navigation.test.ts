import assert from 'node:assert/strict';
import test from 'node:test';
import { fleetConsoleEntry } from './app-navigation';

test('fleet dock navigation preserves the selected batch deep link', () => {
  assert.deepEqual(fleetConsoleEntry('b-real-007'), {
    tab: 'fleet',
    fleetBatchId: 'b-real-007',
  });
  assert.deepEqual(fleetConsoleEntry(), { tab: 'fleet' });
});
