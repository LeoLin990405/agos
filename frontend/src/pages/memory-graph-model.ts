import type { MemoryGraphData as UiGraphData, MemoryNodeData } from '@/components/graph/mock-graph-data';
import type { MemoryNodeType } from '@/design-system/tokens';
import type { ResourceStatus } from '@/lib/resource';
import type { ApiMemoryGraph, MemorySearchResponse } from './memory-graph-api';

/** Backend taxonomy to the existing five visual color families. */
export const TYPE_MAP: Readonly<Record<string, MemoryNodeType>> = {
  user: 'user', profile: 'user',
  feedback: 'feedback', lesson: 'feedback',
  project: 'project', 'project-memory': 'project', decision: 'project',
  reference: 'reference', fact: 'reference',
  incident: 'incident', case: 'incident',
};

export function typeFamily(sourceType: string): MemoryNodeType {
  return TYPE_MAP[sourceType] ?? 'reference';
}

export interface MemorySearchPresentation {
  status: ResourceStatus;
  pending: boolean;
  response?: MemorySearchResponse;
}

/** Prevents retained data or failures for query A from masquerading as query B. */
export function deriveMemorySearchPresentation(
  currentQuery: string,
  debouncedQuery: string,
  status: ResourceStatus,
  data: MemorySearchResponse | undefined,
): MemorySearchPresentation {
  if (currentQuery === '') return { status: 'idle', pending: false };
  if (debouncedQuery !== currentQuery) return { status: 'loading', pending: true };
  const response = data?.query === currentQuery ? data : undefined;
  if (status === 'idle' || status === 'loading') return { status, pending: true, ...(response ? { response } : {}) };
  if (response === undefined && status === 'degraded') return { status: 'error', pending: false };
  if (response === undefined && status === 'ready') return { status: 'loading', pending: true };
  return { status, pending: false, ...(response ? { response } : {}) };
}

/**
 * Converts a validated backend response to the canvas projection.
 * An empty graph remains a real empty graph; it is never replaced by sample data.
 */
export function adaptRealGraph(data: ApiMemoryGraph | undefined): UiGraphData | undefined {
  if (data === undefined) return undefined;
  const counts: Record<MemoryNodeType, number> = {
    user: 0,
    feedback: 0,
    project: 0,
    reference: 0,
    incident: 0,
  };
  const nodes = data.nodes.map((node) => {
    const type = typeFamily(node.type);
    counts[type] += 1;
    return {
      id: node.id,
      type,
      sourceType: node.type,
      title: node.id,
      description: node.description,
      bytes: node.bytes,
      mtime: node.mtime,
      outDegree: node.outDegree,
      ...(node.validUntil === undefined ? {} : { validUntil: node.validUntil }),
    } satisfies MemoryNodeData;
  });
  return {
    at: data.at,
    nodes,
    edges: data.edges.map((edge) => ({ ...edge })),
    counts,
    summary: {
      dangling: data.counts.dangling,
      linkResolution: { ...data.counts.linkResolution },
      unknownTypes: { ...data.counts.unknownTypes },
    },
    ...(data.error === undefined ? {} : { error: `${data.error.code}: ${data.error.message}` }),
  };
}
