export const VISION_ENDPOINT = '/api/cn/vision';
export const VISION_RECORDS_ENDPOINT = '/api/cn/council-records';

export const DEFAULT_VISION_PANEL = ['qwen', 'doubao', 'stepfun'] as const;

export interface VisionSelection {
  provider: string;
  model: string;
}

/** JSON body accepted by the cn-capabilities /api/cn/vision handler. */
export interface VisionRequestPayload {
  sessionId?: string;
  name: string;
  mime: string;
  data: string;
  question?: string;
}

export interface VisionBlobInput {
  blob: Blob;
  name: string;
  mime?: string;
  sessionId?: string;
  question?: string;
}

export interface VisionPanelEntry {
  provider: string;
  ok: boolean;
  ms: number;
  error?: string;
  /** The compact route omits this; the existing read-only council ledger can enrich it. */
  text?: string;
}

export interface NativeVisionResponse {
  native: true;
  selection: VisionSelection | null;
}

export interface ArbitratedVisionResponse {
  native: false;
  path: string;
  name: string;
  description: string;
  disagreements: string[];
  flagged: string[];
  panel: VisionPanelEntry[];
  arbiter: string;
  parsedOk: boolean;
  inconclusive: boolean;
  ms: number;
}

export type VisionResponse = NativeVisionResponse | ArbitratedVisionResponse;

export interface VisionErrorPayload {
  error: string;
  panel?: VisionPanelEntry[];
  path?: string;
}

export type VisionFetch = typeof globalThis.fetch;

export interface VisionRequestOptions {
  endpoint?: string;
  recordsEndpoint?: string;
  /** Optional ledger enrichment only; the primary vision request keeps the host's own timeout policy. */
  recordsTimeoutMs?: number;
  fetchImpl?: VisionFetch;
  signal?: AbortSignal;
}

export class VisionRequestError extends Error {
  readonly status: number;
  readonly payload: VisionErrorPayload;

  constructor(status: number, payload: VisionErrorPayload) {
    super(payload.error);
    this.name = 'VisionRequestError';
    this.status = status;
    this.payload = payload;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isSelection(value: unknown): value is VisionSelection {
  return isRecord(value) && typeof value.provider === 'string' && typeof value.model === 'string';
}

function isPanelEntry(value: unknown): value is VisionPanelEntry {
  return isRecord(value)
    && typeof value.provider === 'string'
    && typeof value.ok === 'boolean'
    && typeof value.ms === 'number'
    && Number.isFinite(value.ms)
    && (value.error === undefined || typeof value.error === 'string')
    && (value.text === undefined || typeof value.text === 'string');
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

export function isArbitratedVisionResponse(value: unknown): value is ArbitratedVisionResponse {
  return isRecord(value)
    && value.native === false
    && typeof value.path === 'string'
    && typeof value.name === 'string'
    && typeof value.description === 'string'
    && isStringArray(value.disagreements)
    && isStringArray(value.flagged)
    && Array.isArray(value.panel)
    && value.panel.every(isPanelEntry)
    && typeof value.arbiter === 'string'
    && typeof value.parsedOk === 'boolean'
    && typeof value.inconclusive === 'boolean'
    && typeof value.ms === 'number'
    && Number.isFinite(value.ms);
}

function parseVisionResponse(value: unknown): VisionResponse | null {
  if (!isRecord(value)) return null;
  if (value.native === true && (value.selection === null || isSelection(value.selection))) {
    return { native: true, selection: value.selection };
  }
  return isArbitratedVisionResponse(value) ? value : null;
}

function parsePanel(value: unknown): VisionPanelEntry[] | undefined {
  return Array.isArray(value) && value.every(isPanelEntry) ? value : undefined;
}

function parseErrorPayload(value: unknown, fallback: string): VisionErrorPayload {
  if (!isRecord(value)) return { error: fallback };
  return {
    error: typeof value.error === 'string' && value.error.trim() !== '' ? value.error : fallback,
    panel: parsePanel(value.panel),
    path: typeof value.path === 'string' ? value.path : undefined,
  };
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

/** Converts an image Blob to the route's JSON + base64 request shape. */
export async function createVisionRequestPayload(input: VisionBlobInput): Promise<VisionRequestPayload> {
  const data = bytesToBase64(new Uint8Array(await input.blob.arrayBuffer()));
  const question = input.question?.trim();
  return {
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    name: input.name || 'image',
    mime: input.mime || input.blob.type || 'application/octet-stream',
    data,
    ...(question ? { question } : {}),
  };
}

/**
 * Calls /api/cn/vision. Inject fetchImpl in tests or alternate hosts; this
 * function never falls back to another endpoint or invokes a model directly.
 */
export async function requestVisionAnalysis(
  payload: VisionRequestPayload,
  options: VisionRequestOptions = {},
): Promise<VisionResponse> {
  if (!payload.data) throw new TypeError('Vision request data must not be empty');
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new TypeError('fetch is unavailable');

  const response = await fetchImpl(options.endpoint ?? VISION_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    signal: options.signal,
  });

  let decoded: unknown = null;
  try {
    decoded = await response.json();
  } catch {
    // The route promises JSON, but preserve a useful status message if a proxy
    // returns HTML or an empty body.
  }

  if (!response.ok) {
    throw new VisionRequestError(
      response.status,
      parseErrorPayload(decoded, `Vision request failed (${response.status})`),
    );
  }

  const parsed = parseVisionResponse(decoded);
  if (parsed === null) {
    throw new VisionRequestError(response.status, { error: 'Vision response shape is invalid' });
  }
  return parsed;
}

export async function analyzeVisionBlob(
  input: VisionBlobInput,
  options: VisionRequestOptions = {},
): Promise<VisionResponse> {
  return requestVisionAnalysis(await createVisionRequestPayload(input), options);
}

/**
 * The vision route intentionally returns a compact panel. Its already-existing
 * read-only ledger route contains the bounded per-provider texts written before
 * the response is sent; join the matching imagePath without making vision fail
 * when the optional ledger is unavailable.
 */
export async function enrichVisionPanelTexts(
  result: ArbitratedVisionResponse,
  options: VisionRequestOptions = {},
): Promise<ArbitratedVisionResponse> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') return result;
  const timeoutMs = Number.isFinite(options.recordsTimeoutMs)
    ? Math.max(1, Number(options.recordsTimeoutMs))
    : 3000;
  const requestAbort = new AbortController();
  const forwardAbort = () => requestAbort.abort(options.signal?.reason);
  if (options.signal?.aborted) forwardAbort();
  else options.signal?.addEventListener('abort', forwardAbort, { once: true });
  const timeout = globalThis.setTimeout(() => {
    requestAbort.abort(new DOMException('Vision ledger enrichment timed out', 'TimeoutError'));
  }, timeoutMs);
  try {
    const response = await fetchImpl(options.recordsEndpoint ?? VISION_RECORDS_ENDPOINT, {
      method: 'GET',
      signal: requestAbort.signal,
    });
    if (!response.ok) return result;
    const decoded: unknown = await response.json();
    if (!isRecord(decoded) || !Array.isArray(decoded.records)) return result;
    const record = decoded.records.find((candidate) => {
      return isRecord(candidate)
        && candidate.kind === 'vision'
        && candidate.imagePath === result.path
        && Array.isArray(candidate.panelists);
    });
    if (!isRecord(record) || !Array.isArray(record.panelists)) return result;
    const texts = new Map<string, string>();
    for (const panelist of record.panelists) {
      if (!isRecord(panelist) || typeof panelist.provider !== 'string' || typeof panelist.text !== 'string') continue;
      texts.set(panelist.provider, panelist.text);
    }
    if (texts.size === 0) return result;
    return {
      ...result,
      panel: result.panel.map((entry) => {
        const text = texts.get(entry.provider);
        return text === undefined ? entry : { ...entry, text };
      }),
    };
  } catch (error) {
    if (options.signal?.aborted) throw error;
    return result;
  } finally {
    globalThis.clearTimeout(timeout);
    options.signal?.removeEventListener('abort', forwardAbort);
  }
}

export async function requestVisionAnalysisWithPanelTexts(
  payload: VisionRequestPayload,
  options: VisionRequestOptions = {},
): Promise<VisionResponse> {
  const result = await requestVisionAnalysis(payload, options);
  return result.native ? result : enrichVisionPanelTexts(result, options);
}
