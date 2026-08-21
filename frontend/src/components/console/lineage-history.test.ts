import test from 'node:test';
import assert from 'node:assert/strict';
import { foldLineageHistory, type LineageHistoryRecord } from './lineage-history.ts';

test('foldLineageHistory joins start and end snapshots by callId', () => {
  const folded = foldLineageHistory([
    { event: 'end', callId: 'call-1', at: 250, parentSessionId: 'parent', rows: [{ status: 'completed' }] },
    { event: 'start', callId: 'call-1', at: 100, parentSessionId: 'parent', rows: [{ status: 'running' }] },
  ]);

  assert.deepEqual(folded, [{
    callId: 'call-1',
    parentSessionId: 'parent',
    startedAt: 100,
    endedAt: 250,
    rows: [{ status: 'completed' }],
    state: 'completed',
    durationMs: 150,
  }]);
});

test('foldLineageHistory marks a start without an end as unclosed and never guesses duration', () => {
  const [call] = foldLineageHistory([
    { event: 'start', callId: 'call-open', at: 100, rows: [{ status: 'running' }] },
  ]);

  assert.equal(call?.state, 'unclosed');
  assert.equal(call?.durationMs, undefined);
  assert.deepEqual(call?.rows, [{ status: 'running' }]);
});

test('foldLineageHistory preserves an end whose start was truncated from the response', () => {
  const [call] = foldLineageHistory([
    { event: 'end', callId: 'call-old', at: 300, rows: [{ status: 'failed' }] },
  ]);

  assert.equal(call?.state, 'orphaned-end');
  assert.equal(call?.startedAt, undefined);
  assert.equal(call?.durationMs, undefined);
});

test('foldLineageHistory ignores malformed records and sorts calls by latest known event', () => {
  const records: LineageHistoryRecord[] = [
    { event: 'start', callId: 'older', at: 10 },
    { event: 'other', callId: 'ignored', at: 999 },
    { event: 'start', callId: '', at: 500 },
    { event: 'start', callId: 'newer', at: 20 },
  ];

  assert.deepEqual(foldLineageHistory(records).map((call) => call.callId), ['newer', 'older']);
});

test('a truncated response can truthfully expose an end whose start fell outside the result', () => {
  const response = {
    truncated: true,
    records: [{ event: 'end', callId: 'partial', at: 10, rows: [{ status: 'completed' }] }],
  } satisfies { truncated: boolean; records: LineageHistoryRecord[] };

  const [call] = foldLineageHistory(response.records);
  assert.equal(response.truncated, true);
  assert.equal(call?.state, 'orphaned-end');
  assert.deepEqual(call?.rows, [{ status: 'completed' }]);
});
