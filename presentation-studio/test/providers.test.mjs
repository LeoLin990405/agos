import test from 'node:test'
import assert from 'node:assert/strict'
import { ReadableStream } from 'node:stream/web'
import {
  decodeEntities,
  loadEnvFile,
  publicConfig,
  readChatStream,
  readMyMemory,
  resolveTranslationProvider,
  resolveTtsProvider,
  translateText,
} from '../lib/providers.mjs'

test('environment values win over the env file', () => {
  const env = loadEnvFile('DEEPSEEK_API_KEY=from-file\nOPENAI_API_KEY=\nPORT=4173\n', {
    DEEPSEEK_API_KEY: 'from-env',
    OPENAI_API_KEY: '',
  })
  assert.equal(env.DEEPSEEK_API_KEY, 'from-env')
  assert.equal(env.OPENAI_API_KEY, '')
  assert.equal(env.PORT, '4173')
})

test('auto translation prefers a configured key, otherwise public MyMemory', () => {
  assert.equal(resolveTranslationProvider({}), 'mymemory')
  assert.equal(resolveTranslationProvider({ DEEPSEEK_API_KEY: 'x' }), 'deepseek')
  assert.equal(resolveTranslationProvider({ OPENAI_API_KEY: 'x' }), 'openai')
  assert.equal(resolveTranslationProvider({ INTERPRET_PROVIDER: 'off', DEEPSEEK_API_KEY: 'x' }), 'off')
})

test('English speech is MiniMax, not espeak or OpenAI', () => {
  assert.equal(resolveTtsProvider(), 'minimax')
  assert.equal(resolveTtsProvider({ TTS_PROVIDER: 'espeak', OPENAI_API_KEY: 'x' }), 'minimax')
})

test('MyMemory payloads become plain English', () => {
  assert.equal(readMyMemory({
    responseStatus: 200,
    responseData: { translatedText: 'Hello &#39;there&#39;' },
  }), "Hello 'there'")
  assert.equal(decodeEntities('A &amp; B'), 'A & B')
  assert.throws(() => readMyMemory({
    responseStatus: 200,
    responseData: { translatedText: 'MYMEMORY WARNING: YOU USED ALL AVAILABLE FREE TRANSLATIONS' },
  }))
})

test('chat streams are concatenated from SSE deltas', async () => {
  const lines = [
    'data: {"choices":[{"delta":{"content":"Hello"}}]}',
    'data: {"choices":[{"delta":{"content":" everyone"}}]}',
    'data: [DONE]',
  ]
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(lines.join('\n')))
      controller.close()
    },
  })
  assert.equal(await readChatStream({ body }), 'Hello everyone')
})

test('translateText posts Mandarin and does not put the key in the URL', async () => {
  let seen
  const fetchImpl = async (url, options) => {
    seen = { url: String(url), options }
    return new Response(JSON.stringify({
      responseStatus: 200,
      responseData: { translatedText: 'Hello everyone' },
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  const english = await translateText('各位好', { INTERPRET_PROVIDER: 'mymemory' }, fetchImpl)
  assert.equal(english, 'Hello everyone')
  assert.match(seen.url, /langpair=zh-CN%7Cen/)
  assert.equal(seen.options?.headers?.authorization, undefined)
})

test('public config names MiniMax and never echoes secrets', () => {
  const config = publicConfig({
    DEEPSEEK_API_KEY: 'secret-value',
    MINIMAX_API_KEY: 'mm-secret',
    MINIMAX_VOICE_ID: 'LinEnglish01',
  })
  assert.equal(config.translationProvider, 'deepseek')
  assert.equal(config.ttsProvider, 'minimax')
  assert.equal(config.minimaxVoice, 'LinEnglish01')
  assert.equal(config.minimaxKey, true)
  const dumped = JSON.stringify(config)
  assert.equal(dumped.includes('secret-value'), false)
  assert.equal(dumped.includes('mm-secret'), false)
})
