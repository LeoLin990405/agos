import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildTranscriptMeta,
  estimateAsrRequestBytes,
  transcribeAudioBlob,
  type VoiceInputFetch,
} from './VoiceInput';

test('transcribeAudioBlob sends the host JSON contract and trims text', async () => {
  let calls = 0;
  const fetchImpl: VoiceInputFetch = async (input, init) => {
    calls += 1;
    assert.equal(input, '/api/cn/asr');
    assert.equal(init?.method, 'POST');
    assert.deepEqual(init?.headers, { 'content-type': 'application/json' });
    assert.deepEqual(JSON.parse(String(init?.body)), {
      audio: 'aGk=',
      mime: 'audio/webm',
    });
    return new Response(JSON.stringify({ text: '  测试转写  ' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  const text = await transcribeAudioBlob(new Blob(['hi'], { type: 'audio/webm' }), { fetchImpl });
  assert.equal(text, '测试转写');
  assert.equal(calls, 1);
});

test('transcribeAudioBlob surfaces an ASR error even on a 200 response', async () => {
  const fetchImpl: VoiceInputFetch = async () => new Response(
    JSON.stringify({ error: '识别服务不可用' }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );

  await assert.rejects(
    transcribeAudioBlob(new Blob(['hi']), { fetchImpl }),
    /识别服务不可用/,
  );
});

test('request size guard accounts for base64 expansion without fetching', async () => {
  let called = false;
  const fetchImpl: VoiceInputFetch = async () => {
    called = true;
    throw new Error('must not be called');
  };
  const blob = new Blob(['123456'], { type: 'audio/wav' });
  const envelopeBytes = estimateAsrRequestBytes(blob.size, blob.type);

  await assert.rejects(
    transcribeAudioBlob(blob, { fetchImpl, maxRequestBytes: envelopeBytes - 1 }),
    /音频文件过大/,
  );
  assert.equal(called, false);
});

test('W22(b) buildTranscriptMeta: mic 带录音时长,file 没有(undefined 不是 0);bytes/mime 来自 blob;asrMs 取整不为负', () => {
  const blob = new Blob([new Uint8Array(1234)], { type: 'audio/webm' });
  assert.deepEqual(buildTranscriptMeta({ entry: 'mic', blob, ms: 2500.6, asrMs: 810.2 }), { source: 'asr', entry: 'mic', bytes: 1234, ms: 2501, asrMs: 810, mime: 'audio/webm' });
  assert.deepEqual(buildTranscriptMeta({ entry: 'file', blob: new Blob(['x']), asrMs: -3 }), { source: 'asr', entry: 'file', bytes: 1, ms: undefined, asrMs: 0, mime: '' });
});
