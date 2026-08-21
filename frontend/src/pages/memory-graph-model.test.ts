import assert from 'node:assert/strict';
import test from 'node:test';
import type { ApiMemoryGraph } from './memory-graph-api';
import { adaptRealGraph, deriveMemorySearchPresentation, TYPE_MAP } from './memory-graph-model';

const counts: ApiMemoryGraph['counts'] = {
  nodes: 3,
  edges: 2,
  dangling: 1,
  byType: { profile: 1, case: 1, 'new-backend-type': 1 },
  linkResolution: { normalized: 1, dead: 1, nonMemory: 0 },
  unknownTypes: { 'new-backend-type': 1 },
};

test('TYPE_MAP covers the ten observed backend types plus user', () => {
  assert.deepEqual(Object.keys(TYPE_MAP).sort(), [
    'case', 'decision', 'fact', 'feedback', 'incident', 'lesson', 'profile',
    'project', 'project-memory', 'reference', 'user',
  ]);
  assert.equal(TYPE_MAP.profile, 'user');
  assert.equal(TYPE_MAP.lesson, 'feedback');
  assert.equal(TYPE_MAP.decision, 'project');
  assert.equal(TYPE_MAP.fact, 'reference');
  assert.equal(TYPE_MAP.case, 'incident');
});

test('adaptRealGraph keeps raw taxonomy, edge semantics and validity', () => {
  const graph = adaptRealGraph({
    at: 500,
    nodes: [
      { id: 'a', type: 'profile', description: 'A', bytes: 10, mtime: 100, outDegree: 2, validUntil: '2026-08-21T09:00:00.000Z' },
      { id: 'b', type: 'case', description: 'B', bytes: 20, mtime: 200, outDegree: 0 },
      { id: 'c', type: 'new-backend-type', description: 'C', bytes: 30, mtime: 300, outDegree: 0 },
    ],
    edges: [
      { from: 'a', to: 'b', dangling: false, kind: 'supersedes', resolution: 'direct' },
      { from: 'a', to: 'missing', dangling: true, kind: 'wikilink', resolution: 'dead' },
    ],
    counts,
  });
  assert.ok(graph);
  assert.deepEqual(graph.nodes.map(({ id, type, sourceType, validUntil }) => ({ id, type, sourceType, validUntil })), [
    { id: 'a', type: 'user', sourceType: 'profile', validUntil: '2026-08-21T09:00:00.000Z' },
    { id: 'b', type: 'incident', sourceType: 'case', validUntil: undefined },
    { id: 'c', type: 'reference', sourceType: 'new-backend-type', validUntil: undefined },
  ]);
  assert.deepEqual(graph.counts, { user: 1, feedback: 0, project: 0, reference: 1, incident: 1 });
  assert.deepEqual(graph.edges[0], { from: 'a', to: 'b', dangling: false, kind: 'supersedes', resolution: 'direct' });
  assert.deepEqual(graph.summary, {
    dangling: 1,
    linkResolution: { normalized: 1, dead: 1, nonMemory: 0 },
    unknownTypes: { 'new-backend-type': 1 },
  });
});

test('adaptRealGraph preserves a real empty response and its soft error', () => {
  assert.equal(adaptRealGraph(undefined), undefined);
  assert.deepEqual(adaptRealGraph({
    at: 1,
    nodes: [],
    edges: [],
    counts: { nodes: 0, edges: 0, dangling: 0, byType: {}, linkResolution: { normalized: 0, dead: 0, nonMemory: 0 }, unknownTypes: {} },
    error: { code: 'memory_directory_unavailable', message: 'memory directory unavailable' },
  }), {
    at: 1,
    nodes: [],
    edges: [],
    counts: { user: 0, feedback: 0, project: 0, reference: 0, incident: 0 },
    summary: { dangling: 0, linkResolution: { normalized: 0, dead: 0, nonMemory: 0 }, unknownTypes: {} },
    error: 'memory_directory_unavailable: memory directory unavailable',
  });
});

test('search presentation turns query A retained-data failure for B into a visible error', () => {
  const oldResponse = { at: 1, query: 'A', results: [] };
  assert.deepEqual(deriveMemorySearchPresentation('B', 'B', 'degraded', oldResponse), {
    status: 'error',
    pending: false,
  });
  assert.deepEqual(deriveMemorySearchPresentation('B', 'A', 'ready', oldResponse), {
    status: 'loading',
    pending: true,
  });
  assert.deepEqual(deriveMemorySearchPresentation('A', 'A', 'degraded', oldResponse), {
    status: 'degraded',
    pending: false,
    response: oldResponse,
  });
});
