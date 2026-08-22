import assert from 'node:assert/strict';
import test from 'node:test';
import type { MemoryNodeData } from '@/components/graph/mock-graph-data';
import {
  deriveGraphEngineering,
  egoNeighborhood,
  expandSearchHits,
  hopLists,
  listSupersedesChains,
  personalizedPageRank,
  shortestPath,
  supersedesLineage,
  temporalStatus,
} from './memory-graph-engineering';

const node = (
  id: string,
  extra: Partial<MemoryNodeData> = {},
): MemoryNodeData => ({
  id,
  type: 'reference',
  sourceType: 'reference',
  title: id,
  description: '',
  bytes: 10,
  mtime: 1,
  outDegree: 0,
  ...extra,
});

const wikilink = (from: string, to: string, dangling = false) => ({
  from,
  to,
  dangling,
  kind: 'wikilink' as const,
  resolution: dangling ? 'dead' as const : 'direct' as const,
});

const supersedes = (from: string, to: string) => ({
  from,
  to,
  dangling: false,
  kind: 'supersedes' as const,
  resolution: 'direct' as const,
});

test('temporalStatus treats missing or invalid expiry as uncollected', () => {
  assert.equal(temporalStatus(undefined, 100), 'uncollected');
  assert.equal(temporalStatus('not-a-date', 100), 'uncollected');
  assert.equal(temporalStatus('2026-08-22T00:00:00.000Z', Date.parse('2026-08-21T00:00:00.000Z')), 'current');
  assert.equal(temporalStatus('2026-08-20T00:00:00.000Z', Date.parse('2026-08-21T00:00:00.000Z')), 'expired');
});

test('deriveGraphEngineering counts components, isolates, temporal holes and edge kinds', () => {
  const engineering = deriveGraphEngineering(
    [
      node('a', { validUntil: '2020-01-01T00:00:00.000Z' }),
      node('b'),
      node('c'),
      node('d'),
    ],
    [wikilink('a', 'b'), wikilink('a', 'missing', true), supersedes('b', 'c')],
    Date.parse('2026-08-22T00:00:00.000Z'),
  );
  assert.equal(engineering.components.length, 2);
  assert.equal(engineering.largestComponentSize, 3);
  assert.equal(engineering.isolateCount, 1);
  assert.equal(engineering.expiredCount, 1);
  assert.equal(engineering.uncollectedValidityCount, 3);
  assert.equal(engineering.wikilinkCount, 2);
  assert.equal(engineering.supersedesCount, 1);
  assert.equal(engineering.degrees.get('b')?.inDegree, 1);
  assert.equal(engineering.degrees.get('b')?.outDegree, 1);
  assert.ok(engineering.expiredIds.has('a'));
  assert.equal(engineering.componentByNode.get('d'), 2);
});

test('egoNeighborhood and search expansion stay on resolved edges', () => {
  const edges = [wikilink('a', 'b'), wikilink('b', 'c'), wikilink('a', 'ghost', true)];
  assert.deepEqual([...egoNeighborhood('a', edges, 1)].sort(), ['a', 'b']);
  assert.deepEqual([...egoNeighborhood('a', edges, 2)].sort(), ['a', 'b', 'c']);
  assert.deepEqual([...expandSearchHits(['a'], edges, 1)].sort(), ['a', 'b']);
});

test('shortestPath walks the undirected resolved graph and reports a miss', () => {
  const edges = [wikilink('a', 'b'), wikilink('b', 'c'), wikilink('d', 'e')];
  assert.deepEqual(shortestPath('a', 'c', edges), ['a', 'b', 'c']);
  assert.deepEqual(shortestPath('a', 'a', edges), ['a']);
  assert.equal(shortestPath('a', 'e', edges), undefined);
});

test('personalizedPageRank keeps seed mass on the hub and leaves isolates at 0', () => {
  const hub = personalizedPageRank(
    ['a'],
    ['a', 'b', 'c', 'z'],
    [wikilink('a', 'b'), wikilink('a', 'c')],
  );
  assert.ok((hub.get('a') ?? 0) > (hub.get('b') ?? 0));
  assert.ok((hub.get('a') ?? 0) > (hub.get('c') ?? 0));
  assert.equal(hub.get('z'), 0);

  const path = personalizedPageRank(
    ['a'],
    ['a', 'b', 'c'],
    [wikilink('a', 'b'), wikilink('b', 'c')],
  );
  assert.ok((path.get('b') ?? 0) > (path.get('c') ?? 0));
  assert.ok((path.get('a') ?? 0) > (path.get('c') ?? 0));
  assert.deepEqual(personalizedPageRank(['missing'], ['a'], []), new Map([['a', 0]]));
});

test('supersedes lineage walks newer and older records without looping', () => {
  const edges = [supersedes('c', 'b'), supersedes('b', 'a'), supersedes('b', 'a')];
  const lineage = supersedesLineage('b', edges);
  assert.deepEqual(lineage.newer, ['c']);
  assert.deepEqual(lineage.older, ['a']);
  assert.deepEqual(lineage.chain, ['c', 'b', 'a']);
  assert.deepEqual(listSupersedesChains(edges), [{ head: 'c', nodes: ['c', 'b', 'a'] }]);
});

test('hopLists splits one-hop from two-hop neighbors', () => {
  const hops = hopLists('a', [wikilink('a', 'b'), wikilink('b', 'c')]);
  assert.deepEqual(hops.hop1, ['b']);
  assert.deepEqual(hops.hop2, ['c']);
});
