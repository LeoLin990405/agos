import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchTurnEvidence, turnEvidenceUrl } from './turn-evidence-api';

test('bound evidence query carries exact session, turn and step, including zero', () => {
  const url = new URL(turnEvidenceUrl('session & a', { turn: 7, step: 0 }), 'http://fixture');
  assert.deepEqual([...url.searchParams], [['sessionId', 'session & a'], ['turn', '7'], ['step', '0']]);
  assert.equal(turnEvidenceUrl('s1'), '/api/agos/turn-evidence?sessionId=s1', 'the memory workspace may explicitly read session-latest');
  assert.throws(() => turnEvidenceUrl('', { turn: 1, step: 0 }), /编号未采集/);
  assert.throws(() => turnEvidenceUrl('s1', { turn: '', step: 0 }), /编号未采集/);
  assert.throws(() => turnEvidenceUrl('s1', { turn: 1, step: Number.NaN }), /编号未采集/);
});

test('a bound read rejects latest evidence from another session, turn or step', async (t) => {
  const signal = new AbortController().signal;
  let response: Record<string, unknown> = { sessionId: 's1', turn: 7, step: 0, observed: true, collected: true };
  const calls: URL[] = [];
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    calls.push(new URL(String(input), 'http://fixture'));
    assert.equal(init?.signal, signal);
    return new Response(JSON.stringify(response), { status: 200 });
  });
  const read = () => fetchTurnEvidence('s1', signal, { turn: 7, step: 0 });
  const matching = await read();
  assert.equal(matching.turn, '7');
  assert.equal(matching.step, '0');
  for (const mismatch of [
    { sessionId: 's2', turn: 7, step: 0 },
    { sessionId: 's1', turn: 8, step: 0 },
    { sessionId: 's1', turn: 7, step: 1 },
    { sessionId: 's1', turn: 7 },
    { sessionId: 's1' },
  ]) {
    response = { ...mismatch, observed: true, collected: true };
    await assert.rejects(read, /不匹配/);
  }
  for (const url of calls) assert.equal(url.search, '?sessionId=s1&turn=7&step=0');
});

test('missing exact evidence stays absent even when the server echoes the requested tuple', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({
    sessionId: 's1', turn: '7', step: '0', observed: false, collected: false, persisted: false,
    memory: { collected: false }, skills: { collected: false },
  }), { status: 200 }));
  const result = await fetchTurnEvidence('s1', undefined, { turn: 7, step: 0 });
  assert.equal(result.observed, false);
  assert.equal(result.collected, false);
  assert.equal(result.memory.collected, false);
  assert.equal(result.skills.collected, false);
});

test('invalid binding fails before any fallback request can be sent', async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => {
    assert.fail('must not read session-latest for an incomplete binding');
  });
  await assert.rejects(fetchTurnEvidence('s1', undefined, { turn: 7, step: '' }), /编号未采集/);
  assert.equal(fetch.mock.callCount(), 0);
});
