import type { MemoryEdgeData, MemoryNodeData } from '@/components/graph/mock-graph-data';

/**
 * Client-side Graph Engineering over the collected document graph.
 *
 * Mapped to open architectures, without claiming capabilities the API does not ship:
 * - Graphiti / Zep: episodic vs semantic vs temporal layers; invalidation via supersedes / validUntil
 * - GraphRAG: local = ego neighborhood; global = connected components (not Leiden reports)
 * - LightRAG: search hits + 1-hop expansion
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

export const GRAPH_VIEW_MODES: readonly { id: GraphViewMode; label: string; hint: string }[] = [
  { id: 'atlas', label: '星图', hint: '全图力导向，对应 GraphRAG 全局浏览' },
  { id: 'local', label: '局部', hint: '选中节点的 2 跳邻域，对应 GraphRAG local / LightRAG 低层' },
  { id: 'community', label: '分量', hint: '连通分量，不是 Leiden 社区报告' },
  { id: 'lineage', label: '谱系', hint: 'supersedes 失效链，对应 Graphiti 时间层' },
];
