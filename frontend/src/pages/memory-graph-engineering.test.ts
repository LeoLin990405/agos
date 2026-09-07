import assert from 'node:assert/strict';
import test from 'node:test';
import type { MemoryNodeData } from '@/components/graph/mock-graph-data';
import {
  deriveGraphEngineering,
  egoNeighborhood,
  expandSearchHits,
  collapseIds,
  hopLists,
  listSupersedesChains,
  graphRemainder,
  nextGraphSelection,
  WORKING_SET_REASON_COPY,
  ATLAS_HUB_CAP,
  ATLAS_REVEAL_NODE_CAP,
  componentHubId,
  revealedCap,
  projectAtlasNodes,
  projectCommunityNodes,
  projectLineageNodes,
  projectRankedSlice,
  projectWorkingSet,
  rankNeighborIds,
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

test('projectAtlasNodes keeps hub cap honest and caps selected spokes', () => {
  const nodes = Array.from({ length: 8 }, (_, index) => node(`n${index}`, { outDegree: 8 - index }));
  const degrees = new Map(nodes.map((item) => [item.id, { inDegree: 0, outDegree: item.outDegree, total: item.outDegree }]));
  const atlas = projectAtlasNodes(nodes, degrees, { cap: 3 });
  assert.deepEqual(atlas.nodes.map((item) => item.id), ['n0', 'n1', 'n2']);
  assert.equal(atlas.hidden, 5);
  assert.equal(atlas.spokeHidden, 0);
  assert.match(atlas.copy ?? '', /枢纽 3 \/ 8/);
  assert.match(atlas.copy ?? '', /点枢纽长出辐条/);

  const expanded = projectAtlasNodes(nodes, degrees, {
    cap: 3,
    spokeCap: 2,
    selectedId: 'n7',
    neighborIds: new Set(['n3', 'n4', 'n5', 'n6']),
  });
  assert.ok(expanded.nodes.some((item) => item.id === 'n7'));
  assert.deepEqual(expanded.nodes.filter((item) => ['n3', 'n4', 'n5', 'n6'].includes(item.id)).map((item) => item.id), ['n3', 'n4']);
  assert.equal(expanded.spokeHidden, 2);
  assert.equal(expanded.collapsible, true);
  assert.equal(expanded.remainder?.count, 2);
  assert.equal(expanded.remainder?.anchorId, 'n7');
  assert.match(expanded.remainder?.copy ?? '', /不是一篇记忆/);
  assert.match(expanded.copy ?? '', /邻域 2 \/ 4/);

  const collapsed = projectAtlasNodes(nodes, degrees, {
    cap: 3,
    spokeCap: 2,
    selectedId: 'n7',
    neighborIds: new Set(['n3', 'n4', 'n5', 'n6']),
    expandSpokes: false,
  });
  assert.equal(collapsed.nodes.some((item) => item.id === 'n3'), false);
  assert.equal(collapsed.spokeHidden, 4);
  assert.equal(collapsed.remainder?.count, 4);
  assert.match(collapsed.copy ?? '', /辐条已收起/);
  assert.equal(rankNeighborIds(['n6', 'n5', 'n4'], degrees, 2).visible.join(','), 'n4,n5');

  const pinned = projectAtlasNodes(nodes, degrees, {
    cap: 3,
    pinIds: ['n7', 'n6', 'n5', 'n4'],
    pinCap: 2,
  });
  assert.deepEqual(pinned.nodes.map((item) => item.id), ['n0', 'n1', 'n2', 'n7', 'n6']);
  assert.match(pinned.copy ?? '', /搜索钉上 2 \/ 4/);
  assert.match(pinned.copy ?? '', /未展开一跳邻域/);
  assert.equal(pinned.nodes.some((item) => item.id === 'n4'), false);
});

test('projectRankedSlice and community keep giant components honest', () => {
  const nodes = Array.from({ length: 6 }, (_, index) => node(`n${index}`, { outDegree: 6 - index }));
  const degrees = new Map(nodes.map((item) => [item.id, { inDegree: 0, outDegree: item.outDegree, total: item.outDegree }]));
  const slice = projectRankedSlice(nodes, degrees, new Set(['n0', 'n1', 'n2', 'n3', 'n4']), {
    cap: 2,
    noun: '分量',
    empty: 'empty',
    disclaimer: '不是 Leiden 社区。',
  });
  assert.deepEqual(slice.nodes.map((item) => item.id), ['n0', 'n1']);
  assert.equal(slice.hidden, 3);
  assert.match(slice.copy ?? '', /分量 2 \/ 5/);

  const components = [
    { id: 0, memberIds: ['n0', 'n1', 'n2', 'n3'], size: 4, isolate: false },
    { id: 1, memberIds: ['n4'], size: 1, isolate: true },
    { id: 2, memberIds: ['n5'], size: 1, isolate: true },
  ];
  const overview = projectCommunityNodes(nodes, degrees, components);
  assert.deepEqual(overview.nodes.map((item) => item.id), ['n0', 'n4', 'n5']);
  assert.match(overview.copy ?? '', /分量 3 个/);

  const opened = projectCommunityNodes(nodes, degrees, components, { selectedId: 'n3', cap: 2 });
  assert.deepEqual(opened.nodes.map((item) => item.id), ['n0', 'n1', 'n3']);
  assert.equal(opened.nodes.some((item) => item.id === 'n4'), false);
  assert.match(opened.copy ?? '', /分量 3 \/ 4/);
  assert.equal(opened.remainder?.count, 1);
  assert.equal(overview.remainder, undefined);
});

test('projectLineageNodes draws supersedes chains only', () => {
  const nodes = [node('a'), node('b'), node('c'), node('d')];
  const degrees = new Map(nodes.map((item) => [item.id, { inDegree: 0, outDegree: 0, total: 0 }]));
  const empty = projectLineageNodes(nodes, degrees, []);
  assert.equal(empty.nodes.length, 0);
  assert.match(empty.copy ?? '', /没有 supersedes 链可画/);

  const drawn = projectLineageNodes(nodes, degrees, [{ head: 'c', nodes: ['c', 'b'] }]);
  assert.deepEqual(drawn.nodes.map((item) => item.id).sort(), ['b', 'c']);
  assert.equal(drawn.nodes.some((item) => item.id === 'd'), false);
  assert.match(drawn.copy ?? '', /只含 supersedes 链/);
});

test('collapseIds reports the hidden remainder without inventing slugs', () => {
  assert.deepEqual(collapseIds(['a', 'b', 'c', 'd'], 2), { visible: ['a', 'b'], hidden: 2 });
  assert.deepEqual(collapseIds(['a'], 6), { visible: ['a'], hidden: 0 });
  assert.equal(graphRemainder(0, 'n0', 'spokes'), undefined);
  assert.match(graphRemainder(3, 'n0', 'slice')?.copy ?? '', /其余 3 篇未画/);
});

test('nextGraphSelection toggles atlas spokes and collapses other modes', () => {
  const atlasToggle = nextGraphSelection({
    currentId: 'hub',
    nextId: 'hub',
    viewMode: 'atlas',
    spokesCollapsed: false,
    collapsible: true,
    intent: 'canvas',
  });
  assert.deepEqual(atlasToggle, { selectedId: 'hub', spokesCollapsed: true, resetReveal: true });

  const atlasNoSpokes = nextGraphSelection({
    currentId: 'hub',
    nextId: 'hub',
    viewMode: 'atlas',
    spokesCollapsed: false,
    collapsible: false,
    intent: 'canvas',
  });
  assert.deepEqual(atlasNoSpokes, { selectedId: undefined, spokesCollapsed: false, resetReveal: true });

  const community = nextGraphSelection({
    currentId: 'hub',
    nextId: 'hub',
    viewMode: 'community',
    spokesCollapsed: false,
    collapsible: false,
    intent: 'canvas',
  });
  assert.deepEqual(community, { selectedId: undefined, spokesCollapsed: false, resetReveal: true });

  const fromList = nextGraphSelection({
    currentId: 'hub',
    nextId: 'hub',
    viewMode: 'atlas',
    spokesCollapsed: true,
    collapsible: true,
    intent: 'focus',
  });
  assert.deepEqual(fromList, { selectedId: 'hub', spokesCollapsed: false, resetReveal: false });
});

test('component hub is degree-highest, not slug order', () => {
  const degrees = deriveGraphEngineering(
    [node('aaa'), node('mmm'), node('zzz')],
    [wikilink('zzz', 'aaa'), wikilink('zzz', 'mmm')],
  ).degrees;
  assert.equal(componentHubId(['aaa', 'mmm', 'zzz'], degrees), 'zzz');
});

test('working set pins inspected docs and lexical overlap without inventing slugs', () => {
  const nodes = [
    node('project_agos_monorepo', { title: 'AgOS monorepo', description: 'frontend plugin' }),
    node('reference_unrelated', { title: 'other' }),
  ];
  const empty = projectWorkingSet(nodes, { itemTexts: ['???'] });
  assert.deepEqual(empty.ids, []);
  assert.equal(empty.copy, '本会话没有可钉的文档');
  const pinned = projectWorkingSet(nodes, {
    itemTexts: ['agos frontend 不要改 fold'],
    inspectedIds: ['reference_unrelated'],
  });
  assert.deepEqual(pinned.ids, ['reference_unrelated', 'project_agos_monorepo']);
  assert.equal(pinned.reasons.reference_unrelated, 'inspected');
  assert.equal(pinned.reasons.project_agos_monorepo, 'lexical');
  assert.equal(WORKING_SET_REASON_COPY.lexical, '词面重合，不是模型推荐');
  assert.match(pinned.copy, /工作集 2 篇/);
  const queried = projectWorkingSet(nodes, { itemTexts: ['agos frontend'] });
  assert.deepEqual(queried.ids, ['project_agos_monorepo']);
  assert.equal(queried.reasons.project_agos_monorepo, 'lexical');
  const pinnedByOperator = projectWorkingSet(nodes, {
    selectedId: 'project_agos_monorepo',
    pinIds: ['reference_unrelated'],
  });
  assert.equal(pinnedByOperator.reasons.project_agos_monorepo, 'selected');
  assert.equal(pinnedByOperator.reasons.reference_unrelated, 'search');
  const foldOnly = projectWorkingSet([
    node('project_csdiy_math_material_folding', { title: 'CS DIY' }),
    node('reference_unrelated', { title: '不要这样' }),
  ], { itemTexts: ['不要改 fold'] });
  assert.deepEqual(foldOnly.ids, ['project_csdiy_math_material_folding']);
  assert.equal(foldOnly.reasons.project_csdiy_math_material_folding, 'lexical');
  const voided = projectWorkingSet([
    node('project_csdiy_math_material_folding', { title: 'CS DIY' }),
    node('reference_keep', { title: 'keep' }),
  ], { itemTexts: ['不要改 fold'], selectedId: 'project_csdiy_math_material_folding', excludeIds: ['project_csdiy_math_material_folding'] });
  assert.deepEqual(voided.ids, []);
});

test('atlas pins union search hits with working-set lexical and does not relabel them as search', () => {
  const nodes = [
    node('n0', { outDegree: 9 }),
    node('n1', { outDegree: 8 }),
    node('project_agos_monorepo', { outDegree: 1, title: 'AgOS monorepo' }),
  ];
  const degrees = new Map(nodes.map((item) => [item.id, { inDegree: 0, outDegree: item.outDegree, total: item.outDegree }]));
  const worksetOnly = projectAtlasNodes(nodes, degrees, {
    cap: 2,
    pinIds: ['project_agos_monorepo'],
    searchPinIds: [],
  });
  assert.equal(worksetOnly.nodes.some((item) => item.id === 'project_agos_monorepo'), true);
  assert.match(worksetOnly.copy ?? '', /工作集词面钉上 1 篇，不是搜索命中/);
  assert.equal(/搜索钉上/.test(worksetOnly.copy ?? ''), false);
  const mixed = projectAtlasNodes(nodes, degrees, {
    cap: 2,
    pinIds: ['n1', 'project_agos_monorepo'],
    searchPinIds: ['n1'],
  });
  assert.match(mixed.copy ?? '', /搜索钉上/);
  assert.match(mixed.copy ?? '', /工作集词面钉上/);
  assert.equal(revealedCap(ATLAS_HUB_CAP, 99), ATLAS_REVEAL_NODE_CAP);
  assert.equal(revealedCap(12, 0), 12);
  const voidedPin = projectAtlasNodes(nodes, degrees, {
    cap: 2,
    pinIds: ['project_agos_monorepo'],
    searchPinIds: ['project_agos_monorepo'],
    excludeIds: ['project_agos_monorepo'],
  });
  assert.equal(voidedPin.nodes.some((item) => item.id === 'project_agos_monorepo'), false);
  assert.match(voidedPin.copy ?? '', /甲板作废 1 篇未钉上星图/);
  assert.equal(/搜索钉上/.test(voidedPin.copy ?? ''), false);
});
