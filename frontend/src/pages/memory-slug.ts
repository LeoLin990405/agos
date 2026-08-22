/** Shared graph / suggestion slug fold. Do not reimplement at call sites. */
export function normalizeMemorySlug(value: string): string {
  return String(value).trim().toLowerCase().replace(/_/g, '-');
}

export function suggestionEdgeKey(from: string, to: string): string {
  return `${normalizeMemorySlug(from)}\0${normalizeMemorySlug(to)}`;
}

export function edgeKeySet(edges: readonly { from: string; to: string }[]): Set<string> {
  return new Set(edges.map((edge) => suggestionEdgeKey(edge.from, edge.to)));
}

export function suggestionAdopted(
  suggestion: { source: string; target: string },
  keys: Set<string>,
): boolean {
  return keys.has(suggestionEdgeKey(suggestion.source, suggestion.target));
}
