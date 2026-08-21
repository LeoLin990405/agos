import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MemoryApiSchemaError,
  fetchMemorySearchResource,
  parseLinkSuggestions,
  parseMemoryGraph,
  parseMemorySearch,
} from './memory-graph-api';

const graphFixture = {
  at: 1_755_700_000_000,
  nodes: [
    {
      id: 'reference_current',
      type: 'fact',
      description: '当前事实',
      bytes: 123,
      mtime: 1_755,
      outDegree: 2,
      validUntil: '2026-08-21T09:00:00.000Z',
    },
  ],
  edges: [
    { from: 'reference_current', to: 'reference_old', dangling: false, kind: 'supersedes', resolution: 'direct' },
    { from: 'reference_current', to: 'missing', dangling: true, kind: 'wikilink', resolution: 'dead' },
  ],
  counts: {
    nodes: 1,
    edges: 2,
    dangling: 1,
    byType: { fact: 1 },
    linkResolution: { normalized: 0, dead: 1, nonMemory: 0 },
    unknownTypes: { experimental: 1 },
  },
};

test('parseMemoryGraph keeps real edge semantics, validity and resolution counts', () => {
  const parsed = parseMemoryGraph(graphFixture);
  assert.equal(parsed.nodes[0]?.validUntil, '2026-08-21T09:00:00.000Z');
  assert.equal(parsed.edges[0]?.kind, 'supersedes');
  assert.equal(parsed.edges[1]?.resolution, 'dead');
  assert.equal(parsed.counts.dangling, 1);
  assert.deepEqual(parsed.counts.unknownTypes, { experimental: 1 });
});

test('parseMemoryGraph rejects partial or invented-looking payloads', () => {
  assert.throws(
    () => parseMemoryGraph({ ...graphFixture, counts: { nodes: 1 } }),
    MemoryApiSchemaError,
  );
  assert.throws(
    () => parseMemoryGraph({ ...graphFixture, edges: [{ from: 'a', to: 'b', dangling: false }] }),
    /kind/,
  );
  assert.throws(
    () => parseMemoryGraph({ ...graphFixture, nodes: [{ ...graphFixture.nodes[0], validUntil: 'not-a-date' }] }),
    /validUntil/,
  );
});

test('parseMemoryGraph accepts only the frozen safe graph error object', () => {
  const error = { code: 'memory_directory_unavailable', message: 'memory directory unavailable' };
  assert.deepEqual(parseMemoryGraph({ ...graphFixture, error }).error, error);
  assert.throws(() => parseMemoryGraph({ ...graphFixture, error: '/Users/leo/private/path missing' }), /对象/);
  assert.throws(
    () => parseMemoryGraph({ ...graphFixture, error: { ...error, path: '/Users/leo/private/path' } }),
    /仅含 code\/message/,
  );
  assert.throws(
    () => parseMemoryGraph({ ...graphFixture, error: { code: 'Bad Code', message: 'failed' } }),
    /snake_case/,
  );
});

test('parseMemorySearch enforces the echoed query and match vocabulary', () => {
  const response = parseMemorySearch({
    at: 100,
    query: 'memory pipeline',
    results: [{ slug: 'reference_memory_pipeline', description: '写入管线', score: 0.03, matchedBy: ['bm25', 'bigram'] }],
  }, 'memory pipeline');
  assert.deepEqual(response.results[0]?.matchedBy, ['bm25', 'bigram']);
  assert.throws(
    () => parseMemorySearch({ at: 100, query: 'stale', results: [] }, 'current'),
    /请求回显/,
  );
  assert.throws(
    () => parseMemorySearch({ at: 100, query: 'x', results: [{ slug: 'x', description: '', score: 1, matchedBy: ['dense'] }] }),
    /bm25 \| bigram/,
  );
});

test('fetchMemorySearchResource forwards AbortSignal and rejects stale server data', async () => {
  const controller = new AbortController();
  let seenSignal: AbortSignal | undefined;
  const fetchImpl = async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    seenSignal = init?.signal ?? undefined;
    return new Response(JSON.stringify({ at: 1, query: 'old', results: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  await assert.rejects(
    fetchMemorySearchResource('/api/memory/search?q=new&limit=20', controller.signal, fetchImpl),
    /请求回显 "new"/,
  );
  assert.equal(seenSignal, controller.signal);
});

test('parseLinkSuggestions accepts only read-only identifiers and ISO timestamps', () => {
  const parsed = parseLinkSuggestions({
    at: 100,
    suggestions: [{ source: 'reference_new', target: 'reference_old', score: 42, createdAt: '2026-08-21T09:00:00.000Z' }],
  });
  assert.equal(parsed.suggestions[0]?.target, 'reference_old');
  assert.throws(
    () => parseLinkSuggestions({ at: 100, suggestions: [{ source: 'a', target: 'b', score: 1, createdAt: 123 }] }),
    /createdAt/,
  );
});
