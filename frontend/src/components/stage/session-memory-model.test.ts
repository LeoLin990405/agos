import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SessionMemorySchemaError,
  fetchSessionMemory,
  formatSessionMemoryTime,
  parseSessionMemoryPayload,
  sessionMemoryPollInterval,
  sessionMemoryUrl,
  type SessionMemoryFetch,
} from './session-memory-model.ts';

const payload = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  version: 1,
  sessionId: 'session / 中文',
  status: 'ready',
  items: [{
    id: 'memory-1',
    kind: 'rejected',
    text: '不要改 fold,这个方案试过不行。',
    importance: 5,
    sourceTurn: 3,
    createdAt: '2026-08-21T08:00:00.000Z',
  }],
  counts: { total: 1, fact: 0, constraint: 0, preference: 0, rejected: 1 },
  skippedSensitive: 2,
  updatedAt: '2026-08-21T08:01:00.000Z',
  ...overrides,
});

test('strict parser accepts the frozen contract and preserves the original sentence', () => {
  const parsed = parseSessionMemoryPayload(payload(), 'session / 中文');
  assert.equal(parsed.items[0]?.text, '不要改 fold,这个方案试过不行。');
  assert.equal(parsed.items[0]?.kind, 'rejected');
  assert.equal(parsed.items[0]?.importance, 5);
  assert.equal(parsed.skippedSensitive, 2);
});

test('strict parser rejects unknown fields, mismatched counts, oversized text and wrong session', () => {
  assert.throws(
    () => parseSessionMemoryPayload({ ...payload(), transcriptPath: '/private/session.jsonl' }),
    SessionMemorySchemaError,
  );
  assert.throws(
    () => parseSessionMemoryPayload(payload({ counts: { total: 9, fact: 0, constraint: 0, preference: 0, rejected: 9 } })),
    SessionMemorySchemaError,
  );
  assert.throws(
    () => parseSessionMemoryPayload(payload({ items: [{
      id: 'too-long', kind: 'fact', text: '界'.repeat(201), importance: 1, sourceTurn: 0, createdAt: '2026-08-21T08:00:00Z',
    }], counts: { total: 1, fact: 1, constraint: 0, preference: 0, rejected: 0 } })),
    SessionMemorySchemaError,
  );
  assert.throws(() => parseSessionMemoryPayload(payload(), 'another-session'), SessionMemorySchemaError);
});

test('request is encoded, GET-only, abort-aware and uses only the injected fetch', async () => {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fetchImpl: SessionMemoryFetch = async (input, init) => {
    calls.push({ url: String(input), init });
    return new Response(JSON.stringify(payload()), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  const controller = new AbortController();
  const result = await fetchSessionMemory('session / 中文', controller.signal, fetchImpl);

  assert.equal(sessionMemoryUrl('session / 中文'), '/api/agos/session-memory?sessionId=session%20%2F%20%E4%B8%AD%E6%96%87');
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, sessionMemoryUrl('session / 中文'));
  assert.equal(calls[0]?.init?.method, 'GET');
  assert.equal(calls[0]?.init?.signal, controller.signal);
  assert.equal(result.status, 'ready');
});

test('request propagates cancellation to the injected fetch', async () => {
  const controller = new AbortController();
  const fetchImpl: SessionMemoryFetch = async (_input, init) => new Promise<Response>((_resolve, reject) => {
    const signal = init?.signal;
    assert.equal(signal, controller.signal);
    signal?.addEventListener('abort', () => reject(new DOMException('cancelled', 'AbortError')), { once: true });
  });

  const pending = fetchSessionMemory('session / 中文', controller.signal, fetchImpl);
  controller.abort();
  await assert.rejects(pending, (error: unknown) => (
    error instanceof DOMException && error.name === 'AbortError'
  ));
});

test('polling is enabled only while extracting and time labels stay deterministic', () => {
  const extracting = parseSessionMemoryPayload(payload({ status: 'extracting' }));
  const ready = parseSessionMemoryPayload(payload());
  const empty = parseSessionMemoryPayload(payload({
    status: 'empty', items: [], counts: { total: 0, fact: 0, constraint: 0, preference: 0, rejected: 0 }, updatedAt: null,
  }));

  assert.equal(sessionMemoryPollInterval(extracting), 1_000);
  assert.equal(sessionMemoryPollInterval(ready), 0);
  assert.equal(sessionMemoryPollInterval(empty), 0);
  assert.equal(formatSessionMemoryTime('2026-08-21T08:00:00.000Z', Date.parse('2026-08-21T08:00:40.000Z')), '刚刚');
  assert.equal(formatSessionMemoryTime('2026-08-21T08:00:00.000Z', Date.parse('2026-08-21T08:08:00.000Z')), '8 分钟前');
});
