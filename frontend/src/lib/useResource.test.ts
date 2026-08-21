import assert from 'node:assert/strict';
import test from 'node:test';
import {
  fetchJsonResource,
  ResourceHttpError,
  scheduleResourceStart,
  shouldResumeResource,
} from './useResource';

test('scheduleResourceStart suppresses a StrictMode probe after cleanup', async () => {
  let active = true;
  let requests = 0;
  scheduleResourceStart(() => active, () => { requests += 1; });
  active = false;
  await new Promise<void>((resolve) => queueMicrotask(resolve));
  assert.equal(requests, 0);

  active = true;
  scheduleResourceStart(() => active, () => { requests += 1; });
  await new Promise<void>((resolve) => queueMicrotask(resolve));
  assert.equal(requests, 1);
});

test('visibility recovery preserves fetch-once resources after a success', () => {
  assert.equal(shouldResumeResource(false, 0, 0), true, 'initially hidden resource still needs its first fetch');
  assert.equal(shouldResumeResource(true, 0, 0), false, 'fetch-once resource stays quiet after success');
  assert.equal(shouldResumeResource(true, 1, 0), true, 'a paused failed retry resumes');
  assert.equal(shouldResumeResource(true, 0, 15_000), true, 'polling resource refreshes when visible');
});

test('fetchJsonResource sends an abortable JSON request', async () => {
  const originalFetch = globalThis.fetch;
  const controller = new AbortController();
  let observedSignal: AbortSignal | undefined;
  globalThis.fetch = (async (_input, init) => {
    observedSignal = init?.signal ?? undefined;
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  try {
    assert.deepEqual(await fetchJsonResource<{ ok: boolean }>('/api/test', controller.signal), { ok: true });
    assert.equal(observedSignal, controller.signal);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('fetchJsonResource reports HTTP status without response contents', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response('secret body', { status: 503, statusText: 'Unavailable' })) as typeof fetch;
  try {
    await assert.rejects(
      fetchJsonResource('/api/test', new AbortController().signal),
      (error: unknown) => {
        assert.ok(error instanceof ResourceHttpError);
        assert.equal(error.status, 503);
        assert.equal(error.message, 'HTTP 503 Unavailable');
        assert.equal(error.message.includes('secret'), false);
        return true;
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
