import test from 'node:test'
import assert from 'node:assert/strict'
import { ReadableStream } from 'node:stream/web'
import {
  decodeEntities,
  INTERPRETER_PROMPT,
  MINIMAX_CHAT_MODEL,
  loadEnvFile,
  memoryQuery,
  publicConfig,
  readChatStream,
  readMyMemory,
  resolveTranslationProvider,
  resolveTtsProvider,
  translateText,
} from '../lib/providers.mjs'

test('environment values win over the env file', () => {
  const env = loadEnvFile('MINIMAX_API_KEY=from-file\nLIBRETRANSLATE_URL=\nPORT=4173\n', {
    MINIMAX_API_KEY: 'from-env',
    LIBRETRANSLATE_URL: '',
  })
  assert.equal(env.MINIMAX_API_KEY, 'from-env')
  assert.equal(env.LIBRETRANSLATE_URL, '')
  assert.equal(env.PORT, '4173')
})

test('auto translation uses MiniMax when the key is set, otherwise public MyMemory', () => {
  assert.equal(resolveTranslationProvider({}), 'mymemory')
  assert.equal(resolveTranslationProvider({ MINIMAX_API_KEY: 'x' }), 'minimax')
  assert.equal(resolveTranslationProvider({ LIBRETRANSLATE_URL: 'http://127.0.0.1:5000' }), 'libretranslate')
  assert.equal(resolveTranslationProvider({ INTERPRET_PROVIDER: 'off', MINIMAX_API_KEY: 'x' }), 'off')
})

test('English speech stays on MiniMax', () => {
  assert.equal(resolveTtsProvider(), 'minimax')
  assert.equal(resolveTtsProvider({ TTS_PROVIDER: 'espeak' }), 'minimax')
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

test('filler-only text is not sent to MyMemory', async () => {
  let called = false
  const english = await translateText('嗯，', { INTERPRET_PROVIDER: 'mymemory' }, () => {
    called = true
    throw new Error('should not fetch')
  })
  assert.equal(english, '')
  assert.equal(called, false)
})

test('a fragment is translated together with the unfinished clause', async () => {
  let seen = ''
  const fetchImpl = async (url) => {
    seen = String(url)
    return new Response(JSON.stringify({
      responseStatus: 200,
      responseData: { translatedText: '35 percent' },
    }), { status: 200 })
  }
  const english = await translateText('三十五。', { INTERPRET_PROVIDER: 'mymemory' }, fetchImpl, {
    context: { source: '准确率达到百分之', fragment: true, spoken: false },
  })
  assert.equal(english, '35 percent')
  assert.match(decodeURIComponent(seen), /准确率达到百分之三十五/)
})

test('chat translation uses MiniMax-M3 on the speech key and does not return the upstream body', async () => {
  let seen
  const fetchImpl = async (url, options) => {
    seen = { url: String(url), body: JSON.parse(options.body), authorization: options.headers.authorization }
    return new Response('nope', { status: 500 })
  }
  await assert.rejects(
    () => translateText('三十五', {
      MINIMAX_API_KEY: 'mm-secret',
      MINIMAX_API_HOST: 'https://api.minimaxi.com',
    }, fetchImpl, {
      context: { source: '准确率达到百分之', english: 'The accuracy reached', fragment: true },
    }),
    (error) => error.message === 'minimax HTTP 500' && !/mm-secret/.test(error.message),
  )
  assert.equal(seen.url, 'https://api.minimaxi.com/v1/chat/completions')
  assert.equal(seen.authorization, 'Bearer mm-secret')
  assert.equal(seen.body.model, MINIMAX_CHAT_MODEL)
  assert.match(seen.body.messages[0].content, /pinyin/)
  assert.equal(seen.body.messages[0].content, INTERPRETER_PROMPT)
  assert.match(seen.body.messages[1].content, /The accuracy reached/)
  assert.match(seen.body.messages[1].content, /三十五/)
})

test('memory query stays on the fragment when the previous clause was already spoken as a full line', () => {
  assert.equal(memoryQuery('我们继续。', { source: '大家好', fragment: false, spoken: true }), '我们继续。')
})

test('public config names MiniMax and never echoes secrets', () => {
  const config = publicConfig({
    MINIMAX_API_KEY: 'mm-secret',
    MINIMAX_VOICE_ID: 'LinEnglish01',
  })
  assert.equal(config.translationProvider, 'minimax')
  assert.equal(config.chatModel, 'MiniMax-M3')
  assert.equal(config.ttsProvider, 'minimax')
  assert.equal(config.minimaxVoice, 'LinEnglish01')
  assert.equal(config.minimaxKey, true)
  const dumped = JSON.stringify(config)
  assert.equal(dumped.includes('secret-value'), false)
  assert.equal(dumped.includes('mm-secret'), false)
})
