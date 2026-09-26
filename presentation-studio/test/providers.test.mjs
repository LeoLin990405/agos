import test from 'node:test'
import assert from 'node:assert/strict'
import { ReadableStream } from 'node:stream/web'
import {
  activeTranslationProvider,
  assembleEnv,
  decodeEntities,
  DOUBAO_CHAT_MODEL,
  INTERPRETER_PROMPT,
  MINIMAX_CHAT_MODEL,
  QWEN_CHAT_MODEL,
  REWRITE_PROMPT,
  loadEnvFile,
  memoryQuery,
  providerHostFromSettings,
  publicConfig,
  readChatStream,
  readMyMemory,
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

test('auto translation names Qwen plus MiniMax, then Doubao, then MiniMax alone', () => {
  assert.equal(activeTranslationProvider({}), 'mymemory')
  assert.equal(activeTranslationProvider({
    QWEN_TOKEN_PLAN_API_KEY: 'q',
    MINIMAX_API_KEY: 'm',
  }), 'qwen-minimax')
  assert.equal(activeTranslationProvider({ ARK_API_KEY: 'a', MINIMAX_API_KEY: 'm' }), 'doubao')
  assert.equal(activeTranslationProvider({ MINIMAX_API_KEY: 'x' }), 'minimax')
  assert.equal(activeTranslationProvider({ LIBRETRANSLATE_URL: 'http://127.0.0.1:5000' }), 'libretranslate')
  assert.equal(activeTranslationProvider({ INTERPRET_PROVIDER: 'off', MINIMAX_API_KEY: 'x' }), 'off')
})

test('secrets fill blank keys and a settings host, without replacing the process environment', () => {
  const env = assembleEnv({
    processEnv: { MINIMAX_API_KEY: 'from-env', QWEN_API_HOST: '' },
    studioText: 'MINIMAX_API_KEY=\nPORT=4173\n',
    secretsText: 'MINIMAX_API_KEY=from-secrets\nQWEN_TOKEN_PLAN_API_KEY=qwen-secret\nARK_API_KEY=ark-secret\n',
    settingsText: [
      'llm-pi-ai:',
      '  providers:',
      '    qwen:',
      '      baseURL: https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
      '      apiKeyEnv: QWEN_TOKEN_PLAN_API_KEY',
      '    doubao:',
      '      apiKeyEnv: ARK_API_KEY',
      '      baseURL: https://ark.cn-beijing.volces.com/api/v3',
    ].join('\n'),
  })
  assert.equal(env.MINIMAX_API_KEY, 'from-env')
  assert.equal(env.QWEN_TOKEN_PLAN_API_KEY, 'qwen-secret')
  assert.equal(env.ARK_API_KEY, 'ark-secret')
  assert.equal(env.PORT, '4173')
  assert.equal(env.QWEN_API_HOST, 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1')
  assert.equal(env.DOUBAO_API_HOST, 'https://ark.cn-beijing.volces.com/api/v3')
  assert.equal(providerHostFromSettings('apiKeyEnv: OTHER\nbaseURL: https://example.invalid\n', 'QWEN_TOKEN_PLAN_API_KEY'), '')
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

function chatResponse(text) {
  return new Response(JSON.stringify({ choices: [{ message: { content: text } }] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

test('auto asks Qwen to translate, then MiniMax-M3 to rewrite that English', async () => {
  const seen = []
  const fetchImpl = async (url, options) => {
    seen.push({ url: String(url), body: JSON.parse(options.body), authorization: options.headers.authorization })
    const model = seen.at(-1).body.model
    if (model === QWEN_CHAT_MODEL) return chatResponse('Hi everyone, I am Lin Zhongyue — 1,000 users.')
    if (model === MINIMAX_CHAT_MODEL) return chatResponse('Hi everyone, I am Lin Zhongyue, and I will focus on our 1,000 users.')
    return new Response('nope', { status: 404 })
  }
  const english = await translateText('大家好，我是林中越。', {
    QWEN_TOKEN_PLAN_API_KEY: 'qwen-secret',
    MINIMAX_API_KEY: 'mm-secret',
    ARK_API_KEY: 'ark-secret',
  }, fetchImpl)
  assert.equal(english, 'Hi everyone, I am Lin Zhongyue, and I will focus on our 1,000 users.')
  assert.equal(seen.length, 2)
  assert.equal(seen[0].url, 'https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1/chat/completions')
  assert.equal(seen[0].authorization, 'Bearer qwen-secret')
  assert.equal(seen[0].body.model, QWEN_CHAT_MODEL)
  assert.equal(seen[0].body.enable_thinking, false)
  assert.equal(seen[0].body.messages[0].content, INTERPRETER_PROMPT)
  assert.equal(seen[1].url, 'https://api.minimaxi.com/v1/chat/completions')
  assert.equal(seen[1].authorization, 'Bearer mm-secret')
  assert.equal(seen[1].body.model, MINIMAX_CHAT_MODEL)
  assert.equal(seen[1].body.messages[0].content, REWRITE_PROMPT)
  assert.match(seen[1].body.messages[1].content, /1,000 users/)
  assert.match(seen[1].body.messages[1].content, /大家好/)
  assert.equal(JSON.stringify(seen).includes('qwen-secret'), true)
  assert.equal(english.includes('qwen-secret'), false)
})

test('a failed Qwen call falls through to Doubao, then MiniMax alone', async () => {
  const models = []
  const fetchImpl = async (url, options) => {
    const body = JSON.parse(options.body)
    models.push(body.model)
    if (body.model === QWEN_CHAT_MODEL) return new Response('nope', { status: 500 })
    if (body.model === DOUBAO_CHAT_MODEL && models.filter((model) => model === DOUBAO_CHAT_MODEL).length === 1) {
      return new Response('nope', { status: 503 })
    }
    if (body.model === DOUBAO_CHAT_MODEL) return chatResponse('Doubao line.')
    return new Response('data: {"choices":[{"delta":{"content":"MiniMax line."}}]}\n', { status: 200 })
  }
  const env = {
    QWEN_TOKEN_PLAN_API_KEY: 'qwen-secret',
    ARK_API_KEY: 'ark-secret',
    MINIMAX_API_KEY: 'mm-secret',
  }
  const first = await translateText('大家好。', env, fetchImpl)
  assert.equal(first, 'MiniMax line.')
  assert.deepEqual(models, [QWEN_CHAT_MODEL, DOUBAO_CHAT_MODEL, MINIMAX_CHAT_MODEL])
  models.length = 0
  const secondFetch = async (url, options) => {
    const body = JSON.parse(options.body)
    models.push({ model: body.model, thinking: body.thinking })
    if (body.model === QWEN_CHAT_MODEL) return new Response(JSON.stringify({ choices: [{ message: { content: '' } }] }), { status: 200 })
    if (body.model === DOUBAO_CHAT_MODEL) return chatResponse('Hi everyone, I am Lin Zhongyue.')
    throw new Error('minimax should not run')
  }
  const second = await translateText('大家好。', env, secondFetch)
  assert.equal(second, 'Hi everyone, I am Lin Zhongyue.')
  assert.equal(models[1].model, DOUBAO_CHAT_MODEL)
  assert.deepEqual(models[1].thinking, { type: 'disabled' })
  assert.equal(models.some((item) => item.model === MINIMAX_CHAT_MODEL), false)
})
