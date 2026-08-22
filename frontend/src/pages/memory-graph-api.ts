import { ResourceHttpError } from '@/lib/useResource';

export type MemoryEdgeKind = 'wikilink' | 'supersedes';
export type MemoryEdgeResolution = 'direct' | 'normalized' | 'dead' | 'nonMemory';
export type MemorySearchMatch = 'bm25' | 'bigram';

export interface ApiMemoryNode {
  id: string;
  type: string;
  description: string;
  bytes: number;
  mtime: number;
  outDegree: number;
  validUntil?: string;
}

export interface ApiMemoryEdge {
  from: string;
  to: string;
  dangling: boolean;
  kind: MemoryEdgeKind;
  resolution: MemoryEdgeResolution;
}

export interface ApiMemoryGraphCounts {
  nodes: number;
  edges: number;
  dangling: number;
  byType: Record<string, number>;
  linkResolution: {
    normalized: number;
    dead: number;
    nonMemory: number;
  };
  unknownTypes: Record<string, number>;
}

export interface ApiMemoryGraphError {
  code: string;
  message: string;
}

export interface ApiMemoryGraph {
  at: number;
  nodes: ApiMemoryNode[];
  edges: ApiMemoryEdge[];
  counts: ApiMemoryGraphCounts;
  error?: ApiMemoryGraphError;
}

export interface MemorySearchResult {
  slug: string;
  description: string;
  score: number;
  matchedBy: MemorySearchMatch[];
}

export interface MemorySearchResponse {
  at: number;
  query: string;
  results: MemorySearchResult[];
  error?: string;
}

export interface LinkSuggestion {
  source: string;
  target: string;
  score: number;
  createdAt: string;
  /** Derived vs graph edges. undefined = graph not loaded, not "pending". */
  adopted?: boolean;
}

export interface LinkSuggestionsResponse {
  at: number;
  suggestions: LinkSuggestion[];
  error?: string;
}

export class MemoryApiSchemaError extends Error {
  constructor(path: string, expected: string) {
    super(`${path} 应为 ${expected}`);
    this.name = 'MemoryApiSchemaError';
  }
}

type JsonObject = Record<string, unknown>;
type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function objectAt(value: unknown, path: string): JsonObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new MemoryApiSchemaError(path, '对象');
  }
  return value as JsonObject;
}

function arrayAt(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) throw new MemoryApiSchemaError(path, '数组');
  return value;
}

function stringAt(value: unknown, path: string, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && value.trim() === '')) {
    throw new MemoryApiSchemaError(path, allowEmpty ? '字符串' : '非空字符串');
  }
  return value;
}

function optionalError(value: unknown, path: string): string | undefined {
  if (value === undefined) return undefined;
  return stringAt(value, path);
}

function graphErrorAt(value: unknown, path: string): ApiMemoryGraphError {
  const error = objectAt(value, path);
  const keys = Object.keys(error).sort();
  if (keys.length !== 2 || keys[0] !== 'code' || keys[1] !== 'message') {
    throw new MemoryApiSchemaError(path, '仅含 code/message 的错误对象');
  }
  const code = stringAt(error['code'], `${path}.code`);
  if (!/^[a-z][a-z0-9_]*$/.test(code)) {
    throw new MemoryApiSchemaError(`${path}.code`, '小写 snake_case 错误码');
  }
  return {
    code,
    message: stringAt(error['message'], `${path}.message`),
  };
}

function finiteNumberAt(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new MemoryApiSchemaError(path, '有限数字');
  }
  return value;
}

function countAt(value: unknown, path: string): number {
  const count = finiteNumberAt(value, path);
  if (!Number.isInteger(count) || count < 0) throw new MemoryApiSchemaError(path, '非负整数');
  return count;
}

function timestampAt(value: unknown, path: string): number {
  const at = finiteNumberAt(value, path);
  if (at < 0) throw new MemoryApiSchemaError(path, '非负时间戳');
  return at;
}

function isoAt(value: unknown, path: string): string {
  const raw = stringAt(value, path);
  if (!Number.isFinite(Date.parse(raw))) throw new MemoryApiSchemaError(path, 'ISO 时间字符串');
  return raw;
}

function stringCountMap(value: unknown, path: string): Record<string, number> {
  const raw = objectAt(value, path);
  return Object.fromEntries(Object.entries(raw).map(([key, count]) => {
    if (key.trim() === '') throw new MemoryApiSchemaError(path, '键名非空的计数对象');
    return [key, countAt(count, `${path}.${key}`)];
  }));
}

function enumAt<T extends string>(value: unknown, path: string, values: readonly T[]): T {
  if (typeof value !== 'string' || !values.includes(value as T)) {
    throw new MemoryApiSchemaError(path, values.join(' | '));
  }
  return value as T;
}

export function parseMemoryGraph(value: unknown): ApiMemoryGraph {
  const root = objectAt(value, 'graph');
  const nodes = arrayAt(root['nodes'], 'graph.nodes').map((value, index): ApiMemoryNode => {
    const node = objectAt(value, `graph.nodes[${index}]`);
    const validUntil = node['validUntil'] === undefined
      ? undefined
      : isoAt(node['validUntil'], `graph.nodes[${index}].validUntil`);
    return {
      id: stringAt(node['id'], `graph.nodes[${index}].id`),
      type: stringAt(node['type'], `graph.nodes[${index}].type`),
      description: stringAt(node['description'], `graph.nodes[${index}].description`, true),
      bytes: countAt(node['bytes'], `graph.nodes[${index}].bytes`),
      mtime: timestampAt(node['mtime'], `graph.nodes[${index}].mtime`),
      outDegree: countAt(node['outDegree'], `graph.nodes[${index}].outDegree`),
      ...(validUntil === undefined ? {} : { validUntil }),
    };
  });
  const edges = arrayAt(root['edges'], 'graph.edges').map((value, index): ApiMemoryEdge => {
    const edge = objectAt(value, `graph.edges[${index}]`);
    if (typeof edge['dangling'] !== 'boolean') {
      throw new MemoryApiSchemaError(`graph.edges[${index}].dangling`, '布尔值');
    }
    return {
      from: stringAt(edge['from'], `graph.edges[${index}].from`),
      to: stringAt(edge['to'], `graph.edges[${index}].to`),
      dangling: edge['dangling'],
      kind: enumAt(edge['kind'], `graph.edges[${index}].kind`, ['wikilink', 'supersedes']),
      resolution: enumAt(edge['resolution'], `graph.edges[${index}].resolution`, ['direct', 'normalized', 'dead', 'nonMemory']),
    };
  });
  const countsRaw = objectAt(root['counts'], 'graph.counts');
  const resolutionRaw = objectAt(countsRaw['linkResolution'], 'graph.counts.linkResolution');
  const counts: ApiMemoryGraphCounts = {
    nodes: countAt(countsRaw['nodes'], 'graph.counts.nodes'),
    edges: countAt(countsRaw['edges'], 'graph.counts.edges'),
    dangling: countAt(countsRaw['dangling'], 'graph.counts.dangling'),
    byType: stringCountMap(countsRaw['byType'], 'graph.counts.byType'),
    linkResolution: {
      normalized: countAt(resolutionRaw['normalized'], 'graph.counts.linkResolution.normalized'),
      dead: countAt(resolutionRaw['dead'], 'graph.counts.linkResolution.dead'),
      nonMemory: countAt(resolutionRaw['nonMemory'], 'graph.counts.linkResolution.nonMemory'),
    },
    unknownTypes: stringCountMap(countsRaw['unknownTypes'], 'graph.counts.unknownTypes'),
  };
  return {
    at: timestampAt(root['at'], 'graph.at'),
    nodes,
    edges,
    counts,
    ...(root['error'] === undefined ? {} : { error: graphErrorAt(root['error'], 'graph.error') }),
  };
}

export function parseMemorySearch(value: unknown, expectedQuery?: string): MemorySearchResponse {
  const root = objectAt(value, 'search');
  const query = stringAt(root['query'], 'search.query');
  if (expectedQuery !== undefined && query !== expectedQuery) {
    throw new MemoryApiSchemaError('search.query', `请求回显 ${JSON.stringify(expectedQuery)}`);
  }
  const results = arrayAt(root['results'], 'search.results').map((value, index): MemorySearchResult => {
    const result = objectAt(value, `search.results[${index}]`);
    const matchedBy = arrayAt(result['matchedBy'], `search.results[${index}].matchedBy`).map((match, matchIndex) => (
      enumAt<MemorySearchMatch>(match, `search.results[${index}].matchedBy[${matchIndex}]`, ['bm25', 'bigram'])
    ));
    if (matchedBy.length === 0 || new Set(matchedBy).size !== matchedBy.length) {
      throw new MemoryApiSchemaError(`search.results[${index}].matchedBy`, '非空且不重复的匹配方式数组');
    }
    return {
      slug: stringAt(result['slug'], `search.results[${index}].slug`),
      description: stringAt(result['description'], `search.results[${index}].description`, true),
      score: finiteNumberAt(result['score'], `search.results[${index}].score`),
      matchedBy,
    };
  });
  return {
    at: timestampAt(root['at'], 'search.at'),
    query,
    results,
    ...(root['error'] === undefined ? {} : { error: optionalError(root['error'], 'search.error') }),
  };
}

export function parseLinkSuggestions(value: unknown): LinkSuggestionsResponse {
  const root = objectAt(value, 'linkSuggestions');
  const suggestions = arrayAt(root['suggestions'], 'linkSuggestions.suggestions').map((value, index): LinkSuggestion => {
    const suggestion = objectAt(value, `linkSuggestions.suggestions[${index}]`);
    return {
      source: stringAt(suggestion['source'], `linkSuggestions.suggestions[${index}].source`),
      target: stringAt(suggestion['target'], `linkSuggestions.suggestions[${index}].target`),
      score: finiteNumberAt(suggestion['score'], `linkSuggestions.suggestions[${index}].score`),
      createdAt: isoAt(suggestion['createdAt'], `linkSuggestions.suggestions[${index}].createdAt`),
    };
  });
  return {
    at: timestampAt(root['at'], 'linkSuggestions.at'),
    suggestions,
    ...(root['error'] === undefined ? {} : { error: optionalError(root['error'], 'linkSuggestions.error') }),
  };
}

async function readJson(url: string, signal: AbortSignal, fetchImpl: FetchLike): Promise<unknown> {
  const response = await fetchImpl(url, { signal, headers: { accept: 'application/json' } });
  if (!response.ok) throw new ResourceHttpError(response.status, response.statusText);
  return response.json() as Promise<unknown>;
}

export async function fetchMemoryGraphResource(
  url: string,
  signal: AbortSignal,
  fetchImpl: FetchLike = fetch,
): Promise<ApiMemoryGraph> {
  return parseMemoryGraph(await readJson(url, signal, fetchImpl));
}

export async function fetchMemorySearchResource(
  url: string,
  signal: AbortSignal,
  fetchImpl: FetchLike = fetch,
): Promise<MemorySearchResponse> {
  const parsedUrl = new URL(url, 'http://agos.local');
  const query = parsedUrl.searchParams.get('q')?.trim() ?? '';
  if (query === '') throw new MemoryApiSchemaError('search request q', '非空字符串');
  return parseMemorySearch(await readJson(url, signal, fetchImpl), query);
}

export async function fetchLinkSuggestionsResource(
  url: string,
  signal: AbortSignal,
  fetchImpl: FetchLike = fetch,
): Promise<LinkSuggestionsResponse> {
  return parseLinkSuggestions(await readJson(url, signal, fetchImpl));
}
