import type { MemoryGraphData as UiGraphData, MemoryNodeData } from '@/components/graph/mock-graph-data';
import type { MemoryNodeType } from '@/design-system/tokens';
import type { MemoryGraphData } from '@/stores/live';

/** Backend memory type to the five UI color families. */
export const TYPE_MAP: Readonly<Record<string, MemoryNodeType>> = {
  user: 'user', profile: 'user',
  feedback: 'feedback', lesson: 'feedback',
  project: 'project', 'project-memory': 'project', decision: 'project',
  reference: 'reference', fact: 'reference',
  incident: 'incident', case: 'incident',
};

export function adaptRealGraph(data: MemoryGraphData | undefined): UiGraphData | undefined {
  if (data === undefined || data.nodes.length === 0) return undefined;
  const outgoing = new Map<string, string[]>();
  for (const edge of data.edges) {
    const links = outgoing.get(edge.from) ?? [];
    links.push(edge.to);
    outgoing.set(edge.from, links);
  }
  const counts = {
    user: 0,
    feedback: 0,
    project: 0,
    reference: 0,
    incident: 0,
  } as Record<MemoryNodeType, number>;
  const nodes = data.nodes.map((node) => {
    const type = TYPE_MAP[node.type] ?? 'reference';
    counts[type] += 1;
    return {
      id: node.id,
      type,
      title: node.id,
      description: node.description,
      bytes: node.bytes,
      mtime: node.mtime,
      outDegree: node.outDegree,
      wikilinks: outgoing.get(node.id) ?? [],
    } satisfies MemoryNodeData;
  });
  return {
    nodes,
    edges: data.edges.map((edge) => ({ from: edge.from, to: edge.to, dangling: edge.dangling })),
    counts,
  };
}
