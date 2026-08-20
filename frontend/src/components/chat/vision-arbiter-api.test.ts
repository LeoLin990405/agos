import assert from 'node:assert/strict';
import {
  VISION_ENDPOINT,
  VisionRequestError,
  createVisionRequestPayload,
  requestVisionAnalysis,
  requestVisionAnalysisWithPanelTexts,
  type VisionFetch,
} from './vision-arbiter-api.ts';

function jsonResponse(value: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(value), {
    ...init,
    headers: { 'content-type': 'application/json', ...init.headers },
  });
}

const payload = await createVisionRequestPayload({
  blob: new Blob(['hello'], { type: 'image/png' }),
  name: 'screen shot.png',
  sessionId: 'session-7',
  question: '  报错是什么？  ',
});
assert.deepEqual(payload, {
  sessionId: 'session-7',
  name: 'screen shot.png',
  mime: 'image/png',
  data: 'aGVsbG8=',
  question: '报错是什么？',
});

const controller = new AbortController();
let capturedInput: RequestInfo | URL | undefined;
let capturedInit: RequestInit | undefined;
const arbitratedFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  capturedInput = input;
  capturedInit = init;
  return jsonResponse({
    native: false,
    path: '/tmp/screen.png',
    name: 'screen.png',
    description: '设置页显示连接成功。',
    disagreements: ['版本号是否为 5.2'],
    flagged: ['doubao'],
    panel: [
      { provider: 'qwen', ok: true, ms: 421 },
      { provider: 'doubao', ok: false, ms: 510, error: 'timeout' },
    ],
    arbiter: 'mimo',
    parsedOk: true,
    inconclusive: false,
    ms: 924,
  });
}) as VisionFetch;

const result = await requestVisionAnalysis(payload, { fetchImpl: arbitratedFetch, signal: controller.signal });
assert.equal(capturedInput, VISION_ENDPOINT);
assert.equal(capturedInit?.method, 'POST');
assert.equal(capturedInit?.signal, controller.signal);
assert.deepEqual(JSON.parse(String(capturedInit?.body)), payload);
assert.equal(result.native, false);
if (!result.native) {
  assert.equal(result.arbiter, 'mimo');
  assert.equal(result.panel[1]?.error, 'timeout');
}

let enrichedCalls = 0;
const enrichedFetch = (async (input: RequestInfo | URL) => {
  enrichedCalls += 1;
  if (String(input) === VISION_ENDPOINT) {
    return jsonResponse({
      native: false,
      path: '/tmp/enrich.png',
      name: 'enrich.png',
      description: '合并结论',
      disagreements: [],
      flagged: [],
      panel: [
        { provider: 'qwen', ok: true, ms: 80 },
        { provider: 'doubao', ok: false, ms: 90, error: 'timeout' },
      ],
      arbiter: 'mimo',
      parsedOk: true,
      inconclusive: false,
      ms: 200,
    });
  }
  return jsonResponse({ records: [
    { kind: 'vision', imagePath: '/tmp/older.png', panelists: [{ provider: 'qwen', text: '旧图' }] },
    {
      kind: 'vision',
      imagePath: '/tmp/enrich.png',
      panelists: [
        { provider: 'qwen', text: '看见一块蓝色状态面板。' },
        { provider: 'doubao', text: '' },
      ],
    },
  ] });
}) as VisionFetch;
const enriched = await requestVisionAnalysisWithPanelTexts(payload, { fetchImpl: enrichedFetch });
assert.equal(enrichedCalls, 2);
assert.equal(enriched.native, false);
if (!enriched.native) {
  assert.equal(enriched.panel[0]?.text, '看见一块蓝色状态面板。');
  assert.equal(enriched.panel[1]?.error, 'timeout');
}

let fallbackCalls = 0;
const fallbackFetch = (async (input: RequestInfo | URL) => {
  fallbackCalls += 1;
  if (String(input) === VISION_ENDPOINT) return jsonResponse(result);
  return jsonResponse({ error: 'ledger unavailable' }, { status: 503 });
}) as VisionFetch;
const compactFallback = await requestVisionAnalysisWithPanelTexts(payload, { fetchImpl: fallbackFetch });
assert.equal(fallbackCalls, 2);
assert.deepEqual(compactFallback, result);

let timeoutCalls = 0;
const timeoutFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  timeoutCalls += 1;
  if (String(input) === VISION_ENDPOINT) return jsonResponse(result);
  return new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => {
      reject(init.signal?.reason ?? new DOMException('aborted', 'AbortError'));
    }, { once: true });
  });
}) as VisionFetch;
const timeoutFallback = await requestVisionAnalysisWithPanelTexts(payload, {
  fetchImpl: timeoutFetch,
  recordsTimeoutMs: 5,
});
assert.equal(timeoutCalls, 2);
assert.deepEqual(timeoutFallback, result);

let abortCalls = 0;
let markEnrichmentStarted: (() => void) | undefined;
const enrichmentStarted = new Promise<void>((resolve) => {
  markEnrichmentStarted = resolve;
});
const externalAbortFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  abortCalls += 1;
  if (String(input) === VISION_ENDPOINT) return jsonResponse(result);
  markEnrichmentStarted?.();
  if (init?.signal?.aborted) {
    throw init.signal.reason ?? new DOMException('aborted', 'AbortError');
  }
  return new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => {
      reject(init.signal?.reason ?? new DOMException('aborted', 'AbortError'));
    }, { once: true });
  });
}) as VisionFetch;
const externalAbort = new AbortController();
const abortedRequest = requestVisionAnalysisWithPanelTexts(payload, {
  fetchImpl: externalAbortFetch,
  recordsTimeoutMs: 1000,
  signal: externalAbort.signal,
});
await enrichmentStarted;
externalAbort.abort(new DOMException('user stopped', 'AbortError'));
await assert.rejects(abortedRequest, /user stopped/);
assert.equal(abortCalls, 2);

const nativeFetch = (async () => jsonResponse({
  native: true,
  selection: { provider: 'openai', model: 'gpt-5-vision' },
})) as VisionFetch;
const native = await requestVisionAnalysis(payload, {
  endpoint: '/alternate/vision',
  fetchImpl: nativeFetch,
});
assert.equal(native.native, true);
if (native.native) assert.equal(native.selection?.model, 'gpt-5-vision');

const failedFetch = (async () => jsonResponse({
  error: '所有视觉后端都失败',
  path: '/tmp/screen.png',
  panel: [{ provider: 'qwen', ok: false, ms: 150000, error: '超时' }],
}, { status: 502 })) as VisionFetch;
await assert.rejects(
  requestVisionAnalysis(payload, { fetchImpl: failedFetch }),
  (error: unknown) => {
    assert.ok(error instanceof VisionRequestError);
    assert.equal(error.status, 502);
    assert.equal(error.payload.panel?.[0]?.provider, 'qwen');
    assert.equal(error.payload.path, '/tmp/screen.png');
    return true;
  },
);

const invalidFetch = (async () => jsonResponse({ native: false, description: 'missing fields' })) as VisionFetch;
await assert.rejects(
  requestVisionAnalysis(payload, { fetchImpl: invalidFetch }),
  /Vision response shape is invalid/,
);

console.log('PASS vision-arbiter-api: payload, native, arbitrated, ledger enrichment/fallback/timeout/abort, error, and invalid-shape paths');
