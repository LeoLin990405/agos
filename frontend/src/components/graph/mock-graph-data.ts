import type { MemoryNodeType } from '@/design-system/tokens';
import type { MemoryEdgeKind, MemoryEdgeResolution } from '@/pages/memory-graph-api';

/** Canvas-facing projection of one real memory node. */
export interface MemoryNodeData {
  id: string;
  /** Five-color visual family. */
  type: MemoryNodeType;
  /** Unmodified metadata.type returned by the backend. */
  sourceType: string;
  title: string;
  description: string;
  bytes: number;
  mtime: number;
  outDegree: number;
  validUntil?: string;
}

export interface MemoryEdgeData {
  from: string;
  to: string;
  dangling: boolean;
  kind: MemoryEdgeKind;
  resolution: MemoryEdgeResolution;
}

export interface MemoryGraphSummary {
  dangling: number;
  linkResolution: {
    normalized: number;
    dead: number;
    nonMemory: number;
  };
  unknownTypes: Record<string, number>;
}

export interface MemoryGraphData {
  nodes: MemoryNodeData[];
  edges: MemoryEdgeData[];
  counts: Record<MemoryNodeType, number>;
  summary: MemoryGraphSummary;
  at: number;
  error?: string;
}
