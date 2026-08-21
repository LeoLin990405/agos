import assert from 'node:assert/strict';
import test from 'node:test';
import { adaptRealGraph, TYPE_MAP } from './memory-graph-model';

test('TYPE_MAP covers backend aliases without losing semantic families', () => {
  assert.equal(TYPE_MAP.profile, 'user');
  assert.equal(TYPE_MAP.lesson, 'feedback');
  assert.equal(TYPE_MAP.decision, 'project');
  assert.equal(TYPE_MAP.fact, 'reference');
  assert.equal(TYPE_MAP.case, 'incident');
});

test('adaptRealGraph maps aliases, unknown types and wikilinks truthfully', () => {
  const graph = adaptRealGraph({
    nodes: [
      { id: 'a', type: 'profile', description: 'A', bytes: 10, mtime: 100, outDegree: 2 },
      { id: 'b', type: 'case', description: 'B', bytes: 20, mtime: 200, outDegree: 0 },
      { id: 'c', type: 'new-backend-type', description: 'C', bytes: 30, mtime: 300, outDegree: 0 },
    ],
    edges: [
      { from: 'a', to: 'b', dangling: false },
      { from: 'a', to: 'missing', dangling: true },
    ],
    counts: {},
  });
  assert.ok(graph);
  assert.deepEqual(graph.nodes.map(({ id, type, wikilinks }) => ({ id, type, wikilinks })), [
    { id: 'a', type: 'user', wikilinks: ['b', 'missing'] },
    { id: 'b', type: 'incident', wikilinks: [] },
    { id: 'c', type: 'reference', wikilinks: [] },
  ]);
  assert.deepEqual(graph.counts, { user: 1, feedback: 0, project: 0, reference: 1, incident: 1 });
  assert.deepEqual(graph.edges[1], { from: 'a', to: 'missing', dangling: true });
});

test('adaptRealGraph preserves the honest empty state', () => {
  assert.equal(adaptRealGraph(undefined), undefined);
  assert.equal(adaptRealGraph({ nodes: [], edges: [], counts: {} }), undefined);
});
