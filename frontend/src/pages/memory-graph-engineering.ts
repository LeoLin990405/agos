import type { MemoryEdgeData, MemoryNodeData } from '@/components/graph/mock-graph-data';
import { memoryLexicalScore, tokenizeMemoryQuery } from '@/components/stage/session-memory-rank';

/**
 * Client-side Graph Engineering over the collected document graph.
 *
 * Mapped to open architectures, without claiming capabilities the API does not ship:
 * - Graphiti / Zep: episodic vs semantic vs temporal layers; invalidation via supersedes / validUntil
 * - GraphRAG: local = ego neighborhood; global = connected components (not Leiden reports)
 * - LightRAG: search pins hits onto the atlas; 1-hop is selected spokes only, not a dump
 * - HippoRAG-style activation: Personalized PageRank from BM25/bigram seeds
 *
 * Nodes remain memory documents (slugs). This is not entity extraction.
 */

export type GraphViewMode = 'atlas' | 'local' | 'community' | 'lineage';
export type TemporalStatus = 'current' | 'expired' | 'uncollected';

export interface MemoryDegrees {
  inDegree: number;
  outDegree: number;
  total: number;
}

export interface MemoryComponent {
  id: number;
  memberIds: readonly string[];
  size: number;
  isolate: boolean;
}

export interface MemoryLineage {
  newer: readonly string[];
  older: readonly string[];
  chain: readonly string[];
}

export interface SupersedesChain {
  head: string;
  nodes: readonly string[];
}

export interface GraphEngineering {
  degrees: ReadonlyMap<string, MemoryDegrees>;
  componentByNode: ReadonlyMap<string, number>;
  components: readonly MemoryComponent[];
  isolateCount: number;
  expiredIds: ReadonlySet<string>;
  expiredCount: number;
  uncollectedValidityCount: number;
  wikilinkCount: number;
  supersedesCount: number;
  largestComponentSize: number;
}

export interface LinkedEdge {
  from: string;
  to: string;
  dangling: boolean;
  kind: MemoryEdgeData['kind'];
}

const DEFAULT_PPR_DAMPING = 0.85;
const DEFAULT_PPR_ITERATIONS = 20;

export function temporalStatus(validUntil: string | undefined, now: number): TemporalStatus {
  if (validUntil === undefined) return 'uncollected';
  const expires = Date.parse(validUntil);
  if (!Number.isFinite(expires)) return 'uncollected';
  return expires < now ? 'expired' : 'current';
}

function resolvedPairs(edges: readonly LinkedEdge[]): Array<readonly [string, string]> {
  const pairs: Array<readonly [string, string]> = [];
  for (const edge of edges) {
    if (edge.dangling) continue;
    if (edge.from === edge.to) continue;
    pairs.push([edge.from, edge.to]);
  }
  return pairs;
}

export function deriveDegrees(
  nodeIds: readonly string[],
  edges: readonly LinkedEdge[],
): Map<string, MemoryDegrees> {
  const degrees = new Map<string, MemoryDegrees>();
  for (const id of nodeIds) {
    degrees.set(id, { inDegree: 0, outDegree: 0, total: 0 });
  }
  for (const [from, to] of resolvedPairs(edges)) {
    const source = degrees.get(from);
    const target = degrees.get(to);
    if (source) {
      source.outDegree += 1;
      source.total += 1;
    }
    if (target) {
      target.inDegree += 1;
      target.total += 1;
    }
  }
  return degrees;
}

export function deriveComponents(
  nodeIds: readonly string[],
  edges: readonly LinkedEdge[],
): MemoryComponent[] {
  const parent = new Map<string, string>();
  for (const id of nodeIds) parent.set(id, id);

  const find = (id: string): string => {
    let cursor = id;
    while (parent.get(cursor) !== cursor) {
      const next = parent.get(cursor);
      if (next === undefined) return cursor;
      cursor = next;
    }
    return cursor;
  };
  const union = (left: string, right: string): void => {
    const a = find(left);
    const b = find(right);
    if (a === b) return;
    if (a < b) parent.set(b, a);
    else parent.set(a, b);
  };

  for (const [from, to] of resolvedPairs(edges)) {
    if (parent.has(from) && parent.has(to)) union(from, to);
  }

  const members = new Map<string, string[]>();
  for (const id of nodeIds) {
    const root = find(id);
    const list = members.get(root) ?? [];
    list.push(id);
    members.set(root, list);
  }

  return [...members.values()]
    .map((memberIds) => {
      memberIds.sort((left, right) => left.localeCompare(right));
      return memberIds;
    })
    .sort((left, right) => right.length - left.length || (left[0] ?? '').localeCompare(right[0] ?? ''))
    .map((memberIds, index) => ({
      id: index + 1,
      memberIds,
      size: memberIds.length,
      isolate: memberIds.length === 1,
    }));
}

export function deriveGraphEngineering(
  nodes: readonly MemoryNodeData[],
  edges: readonly LinkedEdge[],
  now = Date.now(),
): GraphEngineering {
  const nodeIds = nodes.map((node) => node.id);
  const degrees = deriveDegrees(nodeIds, edges);
  const components = deriveComponents(nodeIds, edges);
  const componentByNode = new Map<string, number>();
  for (const component of components) {
    for (const id of component.memberIds) componentByNode.set(id, component.id);
  }

  const expiredIds = new Set<string>();
  let uncollectedValidityCount = 0;
  for (const node of nodes) {
    const status = temporalStatus(node.validUntil, now);
    if (status === 'expired') expiredIds.add(node.id);
    if (status === 'uncollected') uncollectedValidityCount += 1;
  }

  let wikilinkCount = 0;
  let supersedesCount = 0;
  for (const edge of edges) {
    if (edge.kind === 'wikilink') wikilinkCount += 1;
    else supersedesCount += 1;
  }

  return {
    degrees,
    componentByNode,
    components,
    isolateCount: components.filter((component) => component.isolate).length,
    expiredIds,
    expiredCount: expiredIds.size,
    uncollectedValidityCount,
    wikilinkCount,
    supersedesCount,
    largestComponentSize: components[0]?.size ?? 0,
  };
}

export function adjacency(
  edges: readonly LinkedEdge[],
  undirected = true,
): Map<string, Set<string>> {
  const graph = new Map<string, Set<string>>();
  const add = (from: string, to: string): void => {
    const next = graph.get(from) ?? new Set<string>();
    next.add(to);
    graph.set(from, next);
  };
  for (const [from, to] of resolvedPairs(edges)) {
    add(from, to);
    if (undirected) add(to, from);
  }
  return graph;
}

export function egoNeighborhood(
  id: string,
  edges: readonly LinkedEdge[],
  hops: number,
): Set<string> {
  const seen = new Set<string>([id]);
  if (hops <= 0) return seen;
  const graph = adjacency(edges);
  let frontier = [id];
  for (let hop = 0; hop < hops; hop += 1) {
    const next: string[] = [];
    for (const node of frontier) {
      for (const neighbor of graph.get(node) ?? []) {
        if (seen.has(neighbor)) continue;
        seen.add(neighbor);
        next.push(neighbor);
      }
    }
    frontier = next;
  }
  return seen;
}

export function expandSearchHits(
  slugs: readonly string[],
  edges: readonly LinkedEdge[],
  hops = 1,
): Set<string> {
  const expanded = new Set<string>();
  for (const slug of slugs) {
    for (const id of egoNeighborhood(slug, edges, hops)) expanded.add(id);
  }
  return expanded;
}

export function shortestPath(
  from: string,
  to: string,
  edges: readonly LinkedEdge[],
): string[] | undefined {
  if (from === to) return [from];
  const graph = adjacency(edges);
  if (!graph.has(from) && from !== to) {
    if (!graph.has(to)) return undefined;
  }
  const queue = [from];
  const prev = new Map<string, string | null>([[from, null]]);
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) break;
    if (current === to) {
      const path = [to];
      let cursor: string | null | undefined = prev.get(to);
      while (cursor) {
        path.push(cursor);
        cursor = prev.get(cursor);
      }
      path.reverse();
      return path;
    }
    for (const neighbor of graph.get(current) ?? []) {
      if (prev.has(neighbor)) continue;
      prev.set(neighbor, current);
      queue.push(neighbor);
    }
  }
  return undefined;
}

export function personalizedPageRank(
  seeds: readonly string[],
  nodeIds: readonly string[],
  edges: readonly LinkedEdge[],
  options?: { damping?: number; iterations?: number },
): Map<string, number> {
  const damping = options?.damping ?? DEFAULT_PPR_DAMPING;
  const iterations = options?.iterations ?? DEFAULT_PPR_ITERATIONS;
  const nodes = [...new Set(nodeIds)];
  const index = new Map(nodes.map((id, offset) => [id, offset]));
  const count = nodes.length;
  const empty = new Map(nodes.map((id) => [id, 0]));
  if (count === 0) return empty;

  const neighbors: number[][] = nodes.map(() => []);
  for (const [from, to] of resolvedPairs(edges)) {
    const i = index.get(from);
    const j = index.get(to);
    if (i === undefined || j === undefined || i === j) continue;
    neighbors[i]?.push(j);
    neighbors[j]?.push(i);
  }

  const seedIndexes = [...new Set(seeds)].flatMap((seed) => {
    const offset = index.get(seed);
    return offset === undefined ? [] : [offset];
  });
  if (seedIndexes.length === 0) return empty;

  const teleport = new Float64Array(count);
  const mass = 1 / seedIndexes.length;
  for (const offset of seedIndexes) teleport[offset] = mass;

  let rank = Float64Array.from(teleport);
  for (let step = 0; step < iterations; step += 1) {
    const next = new Float64Array(count);
    let dangling = 0;
    for (let i = 0; i < count; i += 1) {
      const nbrs = neighbors[i] ?? [];
      const current = rank[i] ?? 0;
      if (nbrs.length === 0) {
        dangling += current;
        continue;
      }
      const share = current / nbrs.length;
      for (const j of nbrs) next[j] += share;
    }
    for (let i = 0; i < count; i += 1) {
      next[i] = damping * ((next[i] ?? 0) + dangling * (teleport[i] ?? 0)) + (1 - damping) * (teleport[i] ?? 0);
    }
    rank = next;
  }

  return new Map(nodes.map((id, offset) => [id, rank[offset] ?? 0]));
}

export function supersedesLineage(id: string, edges: readonly LinkedEdge[]): MemoryLineage {
  const newer: string[] = [];
  const older: string[] = [];
  const incoming = new Map<string, string[]>();
  const outgoing = new Map<string, string[]>();
  for (const edge of edges) {
    if (edge.kind !== 'supersedes' || edge.dangling) continue;
    const fromList = outgoing.get(edge.from) ?? [];
    fromList.push(edge.to);
    outgoing.set(edge.from, fromList);
    const toList = incoming.get(edge.to) ?? [];
    toList.push(edge.from);
    incoming.set(edge.to, toList);
  }

  const walk = (start: string, graph: Map<string, string[]>, bucket: string[]): void => {
    const queue = [...(graph.get(start) ?? [])];
    const seen = new Set<string>([start]);
    while (queue.length > 0) {
      const current = queue.shift();
      if (current === undefined || seen.has(current)) continue;
      seen.add(current);
      bucket.push(current);
      for (const next of graph.get(current) ?? []) queue.push(next);
    }
  };

  walk(id, incoming, newer);
  walk(id, outgoing, older);
  return {
    newer,
    older,
    chain: [...newer, id, ...older],
  };
}

export function listSupersedesChains(edges: readonly LinkedEdge[]): SupersedesChain[] {
  const involved = new Set<string>();
  const outgoing = new Map<string, string[]>();
  const incoming = new Map<string, string[]>();
  for (const edge of edges) {
    if (edge.kind !== 'supersedes' || edge.dangling) continue;
    involved.add(edge.from);
    involved.add(edge.to);
    const fromList = outgoing.get(edge.from) ?? [];
    fromList.push(edge.to);
    outgoing.set(edge.from, fromList);
    const toList = incoming.get(edge.to) ?? [];
    toList.push(edge.from);
    incoming.set(edge.to, toList);
  }

  const roots = [...involved].filter((id) => (incoming.get(id)?.length ?? 0) === 0 && (outgoing.get(id)?.length ?? 0) > 0);
  const walk = (head: string): string[] => {
    const nodes: string[] = [];
    const seen = new Set<string>();
    const stack = [head];
    while (stack.length > 0) {
      const current = stack.shift();
      if (current === undefined || seen.has(current)) continue;
      seen.add(current);
      nodes.push(current);
      for (const next of outgoing.get(current) ?? []) stack.push(next);
    }
    return nodes;
  };

  return roots
    .map((head) => ({ head, nodes: walk(head) }))
    .sort((left, right) => right.nodes.length - left.nodes.length || left.head.localeCompare(right.head));
}

export function hopLists(
  id: string,
  edges: readonly LinkedEdge[],
): { hop1: string[]; hop2: string[] } {
  const hop1 = [...egoNeighborhood(id, edges, 1)].filter((node) => node !== id).sort((left, right) => left.localeCompare(right));
  const hop2 = [...egoNeighborhood(id, edges, 2)]
    .filter((node) => node !== id && !hop1.includes(node))
    .sort((left, right) => left.localeCompare(right));
  return { hop1, hop2 };
}

/** Default atlas draws degree hubs only. Hidden count must stay on-screen. */
export const ATLAS_HUB_CAP = 48;
export const ATLAS_SPOKE_CAP = 12;
export const ATLAS_REVEAL_NODE_CAP = 120;
export const INSPECTOR_NEIGHBOR_CAP = 6;
export const SEARCH_RESULT_CAP = 8;
export const WORKING_SET_CAP = 12;

export type WorkingSetReason = 'selected' | 'search' | 'inspected' | 'lexical';

export const WORKING_SET_REASON_COPY: Record<WorkingSetReason, string> = {
  selected: '当前选中',
  search: '搜索命中',
  inspected: '检查过',
  lexical: '词面重合，不是模型推荐',
};

export function componentHubId(
  memberIds: readonly string[],
  degrees: ReadonlyMap<string, MemoryDegrees>,
): string | undefined {
  return rankNeighborIds(memberIds, degrees, 1).visible[0];
}

export function revealedCap(base: number, reveal = 0, hard = ATLAS_REVEAL_NODE_CAP): number {
  const next = Math.max(0, base) * (1 + Math.max(0, reveal));
  return Math.min(next, hard);
}

export function memoryNodeDocument(node: Pick<MemoryNodeData, 'id' | 'title' | 'description'>): string {
  return [node.id, node.title, node.description].filter(Boolean).join('\n');
}

export function tokenizeWorksetQuery(text: string): string[] {
  return tokenizeMemoryQuery(text);
}

export function scoreWorksetNode(node: MemoryNodeData, query: string): number {
  const needle = query.replace(/\s+/g, ' ').trim();
  if (needle === '') return 0;
  return memoryLexicalScore(needle, memoryNodeDocument(node));
}

export function projectWorkingSet(
  nodes: readonly MemoryNodeData[],
  options: {
    itemTexts?: readonly string[];
    pinIds?: readonly string[];
    inspectedIds?: readonly string[];
    selectedId?: string;
    excludeIds?: Iterable<string>;
    cap?: number;
  } = {},
): { ids: string[]; nodes: MemoryNodeData[]; copy: string; reasons: Record<string, WorkingSetReason> } {
  const cap = options.cap ?? WORKING_SET_CAP;
  const excluded = new Set(options.excludeIds ?? []);
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const seen = new Set<string>();
  const ids: string[] = [];
  const reasons: Record<string, WorkingSetReason> = {};
  const pin = (id: string | undefined, reason: WorkingSetReason): void => {
    if (id === undefined || excluded.has(id) || seen.has(id) || !byId.has(id) || ids.length >= cap) return;
    seen.add(id);
    ids.push(id);
    reasons[id] = reason;
  };
  pin(options.selectedId, 'selected');
  for (const id of options.pinIds ?? []) pin(id, 'search');
  for (const id of options.inspectedIds ?? []) pin(id, 'inspected');
  const query = (options.itemTexts ?? []).join('\n');
  const scored = nodes
    .filter((node) => !seen.has(node.id))
    .map((node) => ({ node, score: scoreWorksetNode(node, query) }))
    .filter((row) => row.score > 0)
    .sort((left, right) => right.score - left.score || left.node.id.localeCompare(right.node.id));
  for (const row of scored) pin(row.node.id, 'lexical');
  return {
    ids,
    nodes: ids.flatMap((id) => {
      const node = byId.get(id);
      return node === undefined ? [] : [node];
    }),
    reasons,
    copy: ids.length === 0 ? '本会话没有可钉的文档' : `本会话工作集 ${ids.length} 篇，其余未画`,
  };
}

export function rankNeighborIds(
  ids: Iterable<string>,
  degrees: ReadonlyMap<string, MemoryDegrees>,
  cap = ATLAS_SPOKE_CAP,
): { visible: string[]; hidden: number } {
  const ranked = [...new Set(ids)].sort((left, right) => {
    const leftDegree = degrees.get(left)?.total ?? 0;
    const rightDegree = degrees.get(right)?.total ?? 0;
    return rightDegree - leftDegree || left.localeCompare(right);
  });
  const limit = Math.max(0, cap);
  return {
    visible: ranked.slice(0, limit),
    hidden: Math.max(0, ranked.length - limit),
  };
}

export function collapseIds(
  ids: readonly string[],
  cap = INSPECTOR_NEIGHBOR_CAP,
): { visible: string[]; hidden: number } {
  const limit = Math.max(0, cap);
  return {
    visible: ids.slice(0, limit),
    hidden: Math.max(0, ids.length - limit),
  };
}

export interface GraphRemainder {
  count: number;
  anchorId: string;
  kind: 'spokes' | 'slice';
  copy: string;
}

export interface GraphProjection {
  nodes: MemoryNodeData[];
  hidden: number;
  spokeHidden: number;
  remainder?: GraphRemainder;
  collapsible: boolean;
  copy?: string;
}

export function graphRemainder(
  count: number,
  anchorId: string,
  kind: 'spokes' | 'slice',
): GraphRemainder | undefined {
  if (count <= 0 || anchorId === '') return undefined;
  return {
    count,
    anchorId,
    kind,
    copy: kind === 'spokes'
      ? `其余 ${count} 个邻域，不是一篇记忆`
      : `其余 ${count} 篇未画，不是一篇记忆`,
  };
}

export function nextGraphSelection(input: {
  currentId: string | undefined;
  nextId: string | undefined;
  viewMode: GraphViewMode;
  spokesCollapsed: boolean;
  collapsible: boolean;
  intent: 'canvas' | 'focus';
}): { selectedId: string | undefined; spokesCollapsed: boolean; resetReveal: boolean } {
  if (input.nextId === undefined) {
    return { selectedId: undefined, spokesCollapsed: false, resetReveal: true };
  }
  if (input.intent === 'focus') {
    return {
      selectedId: input.nextId,
      spokesCollapsed: false,
      resetReveal: input.nextId !== input.currentId,
    };
  }
  if (input.nextId === input.currentId) {
    if (input.viewMode === 'atlas' && input.collapsible) {
      const collapsed = !input.spokesCollapsed;
      return { selectedId: input.currentId, spokesCollapsed: collapsed, resetReveal: collapsed };
    }
    return { selectedId: undefined, spokesCollapsed: false, resetReveal: true };
  }
  return { selectedId: input.nextId, spokesCollapsed: false, resetReveal: true };
}

function sortByDegree(
  left: MemoryNodeData,
  right: MemoryNodeData,
  degrees: ReadonlyMap<string, MemoryDegrees>,
): number {
  const leftDegree = degrees.get(left.id)?.total ?? left.outDegree;
  const rightDegree = degrees.get(right.id)?.total ?? right.outDegree;
  return rightDegree - leftDegree || left.id.localeCompare(right.id);
}

export function projectAtlasNodes(
  nodes: readonly MemoryNodeData[],
  degrees: ReadonlyMap<string, MemoryDegrees>,
  options: {
    selectedId?: string;
    neighborIds?: ReadonlySet<string>;
    pinIds?: readonly string[];
    searchPinIds?: readonly string[];
    pinCap?: number;
    cap?: number;
    spokeCap?: number;
    expandSpokes?: boolean;
    hint?: string;
    excludeIds?: Iterable<string>;
  } = {},
): GraphProjection {
  const cap = options.cap ?? ATLAS_HUB_CAP;
  const spokeCap = options.spokeCap ?? ATLAS_SPOKE_CAP;
  const pinCap = options.pinCap ?? SEARCH_RESULT_CAP;
  const excluded = new Set(options.excludeIds ?? []);
  const byId = new Map(nodes.map((item) => [item.id, item]));
  const ranked = [...nodes]
    .filter((item) => !excluded.has(item.id))
    .sort((left, right) => sortByDegree(left, right, degrees));
  const hubs = ranked.slice(0, Math.min(cap, ranked.length));
  const seen = new Set(hubs.map((item) => item.id));
  const extra: MemoryNodeData[] = [];
  if (options.selectedId && !seen.has(options.selectedId)) {
    const selected = byId.get(options.selectedId);
    if (selected !== undefined) {
      extra.push(selected);
      seen.add(selected.id);
    }
  }
  const hitsInPool = [...new Set(options.pinIds ?? [])].filter((id) => byId.has(id) && !excluded.has(id));
  const pinPool = hitsInPool.filter((id) => !seen.has(id));
  const pins = pinPool.slice(0, pinCap);
  for (const id of pins) {
    const item = byId.get(id);
    if (item === undefined) continue;
    extra.push(item);
    seen.add(id);
  }
  const neighborIds = [...(options.neighborIds ?? [])].filter((id) => id !== options.selectedId && byId.has(id));
  const spokePool = neighborIds.filter((id) => !seen.has(id));
  const expandSpokes = options.expandSpokes !== false;
  const spokes = rankNeighborIds(spokePool, degrees, expandSpokes ? spokeCap : 0);
  const spokeNodes = spokes.visible.flatMap((id) => {
    const item = byId.get(id);
    if (item === undefined) return [];
    seen.add(item.id);
    return [item];
  });
  const visible = [...hubs, ...extra, ...spokeNodes];
  const hidden = Math.max(0, nodes.length - visible.length);
  const visibleNeighbors = neighborIds.filter((id) => seen.has(id)).length;
  const undrawnSpokes = expandSpokes ? spokes.hidden : spokePool.length;
  const parts: string[] = [];
  if (nodes.length > hubs.length) {
    parts.push(`星图默认枢纽 ${hubs.length} / ${nodes.length}，其余未画`);
  }
  const searchIds = options.searchPinIds === undefined
    ? new Set(hitsInPool)
    : new Set(options.searchPinIds.filter((id) => byId.has(id) && !excluded.has(id)));
  const voidedInPool = nodes.filter((item) => excluded.has(item.id)).length;
  const searchHits = hitsInPool.filter((id) => searchIds.has(id));
  const worksetOnly = hitsInPool.filter((id) => !searchIds.has(id));
  const searchVisible = searchHits.filter((id) => seen.has(id)).length;
  const worksetVisible = worksetOnly.filter((id) => seen.has(id)).length;
  if (searchHits.length > 0) {
    parts.push(`搜索钉上 ${searchVisible} / ${searchHits.length} 条命中，未展开一跳邻域`);
  }
  if (worksetOnly.length > 0) {
    parts.push(`工作集词面钉上 ${worksetVisible} 篇，不是搜索命中`);
  }
  if (options.selectedId !== undefined && !expandSpokes && spokePool.length > 0) {
    parts.push('辐条已收起。再点枢纽或其余标记展开');
  } else if (options.selectedId !== undefined && neighborIds.length > 0) {
    parts.push(`选中邻域 ${visibleNeighbors} / ${neighborIds.length}${visibleNeighbors < neighborIds.length ? '，其余未画' : ''}`);
  } else if (hidden > 0 && options.selectedId === undefined && hitsInPool.length === 0) {
    parts.push('点枢纽长出辐条。再点收回');
  }
  if (voidedInPool > 0) parts.push(`甲板作废 ${voidedInPool} 篇未钉上星图`);
  if (options.hint) parts.push(options.hint);
  return {
    nodes: visible,
    hidden,
    spokeHidden: undrawnSpokes,
    remainder: options.selectedId === undefined
      ? undefined
      : graphRemainder(undrawnSpokes, options.selectedId, 'spokes'),
    collapsible: spokePool.length > 0,
    copy: parts.length > 0 ? `${parts.join('。')}。` : undefined,
  };
}

export function projectRankedSlice(
  nodes: readonly MemoryNodeData[],
  degrees: ReadonlyMap<string, MemoryDegrees>,
  memberIds: ReadonlySet<string>,
  options: {
    selectedId?: string;
    cap?: number;
    noun: string;
    empty: string;
    disclaimer?: string;
  },
): GraphProjection {
  const cap = options.cap ?? ATLAS_HUB_CAP;
  const byId = new Map(nodes.map((item) => [item.id, item]));
  const pool = nodes.filter((item) => memberIds.has(item.id));
  if (pool.length === 0) {
    return { nodes: [], hidden: nodes.length, spokeHidden: 0, collapsible: false, copy: options.empty };
  }
  const ranked = [...pool].sort((left, right) => sortByDegree(left, right, degrees));
  const head = ranked.slice(0, Math.min(cap, ranked.length));
  const seen = new Set(head.map((item) => item.id));
  if (options.selectedId && memberIds.has(options.selectedId) && !seen.has(options.selectedId)) {
    const selected = byId.get(options.selectedId);
    if (selected !== undefined) {
      head.push(selected);
      seen.add(selected.id);
    }
  }
  const hidden = Math.max(0, pool.length - head.length);
  const suffix = options.disclaimer === undefined ? '' : options.disclaimer;
  const copy = hidden > 0
    ? `${options.noun} ${head.length} / ${pool.length}，其余未画。${suffix}`
    : `${options.noun} ${head.length} 篇。${suffix}`;
  const anchorId = options.selectedId !== undefined && seen.has(options.selectedId)
    ? options.selectedId
    : head[0]?.id ?? '';
  return {
    nodes: head,
    hidden,
    spokeHidden: 0,
    remainder: graphRemainder(hidden, anchorId, 'slice'),
    collapsible: false,
    copy: copy.trim(),
  };
}

export function projectCommunityNodes(
  nodes: readonly MemoryNodeData[],
  degrees: ReadonlyMap<string, MemoryDegrees>,
  components: readonly MemoryComponent[],
  options: { selectedId?: string; cap?: number } = {},
): GraphProjection {
  const cap = options.cap ?? ATLAS_HUB_CAP;
  const selectedId = options.selectedId;
  if (selectedId) {
    const component = components.find((entry) => entry.memberIds.includes(selectedId));
    if (component === undefined) {
      return { nodes: [], hidden: nodes.length, spokeHidden: 0, collapsible: false, copy: '选中节点不在任何分量里。' };
    }
    return projectRankedSlice(nodes, degrees, new Set(component.memberIds), {
      selectedId,
      cap,
      noun: '分量',
      empty: '该分量没有可画节点。',
      disclaimer: '不是 Leiden 社区。',
    });
  }
  const byId = new Map(nodes.map((item) => [item.id, item]));
  const rankedComponents = [...components].sort((left, right) => right.size - left.size || left.id - right.id);
  const reps: MemoryNodeData[] = [];
  for (const component of rankedComponents) {
    const hubId = rankNeighborIds(component.memberIds, degrees, 1).visible[0];
    const hub = hubId === undefined ? undefined : byId.get(hubId);
    if (hub !== undefined) reps.push(hub);
    if (reps.length >= cap) break;
  }
  return {
    nodes: reps,
    hidden: Math.max(0, nodes.length - reps.length),
    spokeHidden: 0,
    collapsible: false,
    copy: components.length === 0
      ? '没有连通分量可画。'
      : `分量 ${components.length} 个，各取度最高一篇。点开后展开该分量。`,
  };
}

export function projectLineageNodes(
  nodes: readonly MemoryNodeData[],
  degrees: ReadonlyMap<string, MemoryDegrees>,
  chains: readonly SupersedesChain[],
  options: { selectedId?: string; cap?: number } = {},
): GraphProjection {
  const ids = new Set<string>();
  for (const chain of chains) {
    for (const id of chain.nodes) ids.add(id);
  }
  if (ids.size === 0) {
    return { nodes: [], hidden: nodes.length, spokeHidden: 0, collapsible: false, copy: '没有 supersedes 链可画。' };
  }
  return projectRankedSlice(nodes, degrees, ids, {
    selectedId: options.selectedId,
    cap: options.cap ?? ATLAS_HUB_CAP,
    noun: '谱系',
    empty: '谱系节点不在当前类型过滤里。',
    disclaimer: '只含 supersedes 链。',
  });
}

export const GRAPH_VIEW_MODES: readonly { id: GraphViewMode; label: string; hint: string }[] = [
  { id: 'atlas', label: '星图', hint: '默认画度枢纽；点选后长出有上限的辐条，再点收回。其余 N 在画布上，不是一篇记忆。搜索只钉命中' },
  { id: 'local', label: '局部', hint: '选中后画 2 跳邻域，有上限，其余未画' },
  { id: 'community', label: '分量', hint: '先画各分量枢纽；点开后展开该分量，仍有上限。不是 Leiden' },
  { id: 'lineage', label: '谱系', hint: '只画 supersedes 链，不是全图' },
];
