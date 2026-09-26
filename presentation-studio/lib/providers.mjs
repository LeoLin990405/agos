/**
 * Translation providers. English speech is MiniMax; see lib/tts.mjs.
 */
import { isFillerOnly, normalizeMandarin } from './session.mjs'
import { minimaxHost, minimaxVoiceId, speechPyPath } from './tts.mjs'

/** Same text model agos routes as `minimax-cn` / MiniMax-M3. */
export const MINIMAX_CHAT_MODEL = 'MiniMax-M3'
/** agos `qwen` default. Token Plan key `QWEN_TOKEN_PLAN_API_KEY` uses this host unless settings.yaml says otherwise. */
export const QWEN_CHAT_MODEL = 'qwen3.8-max'
export const QWEN_API_HOST_DEFAULT = 'https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1'
/** agos `doubao` default. */
export const DOUBAO_CHAT_MODEL = 'doubao-seed-evolving'
export const DOUBAO_API_HOST_DEFAULT = 'https://ark.cn-beijing.volces.com/api/v3'

const QWEN_TIMEOUT_MS = 8000
const REWRITE_TIMEOUT_MS = 4000
const DOUBAO_TIMEOUT_MS = 4000

export function loadEnvFile(text, into = {}) {
  const env = { ...into }
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    const key = line.slice(0, eq).trim()
    let value = line.slice(eq + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    if (env[key] === undefined || env[key] === '') env[key] = value
  }
  return env
}

export function resolveTranslationProvider(env) {
  const explicit = (env.INTERPRET_PROVIDER || 'auto').trim().toLowerCase()
  return explicit || 'auto'
}

/** The path the page should name. `auto` still falls through inside translateText. */
export function activeTranslationProvider(env) {
  const explicit = resolveTranslationProvider(env)
  if (explicit !== 'auto') return explicit
  if (env.QWEN_TOKEN_PLAN_API_KEY && env.MINIMAX_API_KEY) return 'qwen-minimax'
  if (env.ARK_API_KEY) return 'doubao'
  if (env.MINIMAX_API_KEY) return 'minimax'
  if (env.LIBRETRANSLATE_URL) return 'libretranslate'
  return 'mymemory'
}

export function fillBlankEnv(target, text) {
  if (!text) return target
  const parsed = loadEnvFile(text, {})
  for (const [key, value] of Object.entries(parsed)) {
    if (!value) continue
    if (target[key] === undefined || target[key] === '') target[key] = value
  }
  return target
}

export function providerHostFromSettings(text, apiKeyEnv) {
  const lines = String(text || '').split('\n')
  const keyPattern = new RegExp(`^\\s*apiKeyEnv:\\s*['"]?${apiKeyEnv}['"]?\\s*$`)
  const urlPattern = /^\s*baseURL:\s*['"]?(\S+?)['"]?\s*$/i
  for (let i = 0; i < lines.length; i += 1) {
    if (!keyPattern.test(lines[i])) continue
    const indent = lines[i].match(/^\s*/)[0].length
    const nearby = (start, step) => {
      for (let j = start; j >= 0 && j < lines.length; j += step) {
        const line = lines[j]
        if (!line.trim() || line.trim().startsWith('#')) continue
        if (line.match(/^\s*/)[0].length < indent) return ''
        const found = line.match(urlPattern)
        if (found) return found[1].replace(/\/$/, '')
      }
      return ''
    }
    const host = nearby(i - 1, -1) || nearby(i + 1, 1)
    if (host) return host
  }
  return ''
}

export function assembleEnv({ processEnv = {}, studioText = '', secretsText = '', settingsText = '' } = {}) {
  const env = fillBlankEnv({ ...processEnv }, studioText)
  fillBlankEnv(env, secretsText)
  if (!env.QWEN_API_HOST) {
    const host = providerHostFromSettings(settingsText, 'QWEN_TOKEN_PLAN_API_KEY')
    if (host) env.QWEN_API_HOST = host
  }
  if (!env.DOUBAO_API_HOST) {
    const host = providerHostFromSettings(settingsText, 'ARK_API_KEY')
    if (host) env.DOUBAO_API_HOST = host
  }
  return env
}

export function resolveTtsProvider() {
  return 'minimax'
}

export function decodeEntities(text) {
  return text
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

export function readMyMemory(payload) {
  const status = payload?.responseStatus
  const text = payload?.responseData?.translatedText
  if (status !== 200 || typeof text !== 'string' || !text.trim()) {
    const detail = payload?.responseDetails || 'MyMemory returned no translation'
    throw new Error(detail)
  }
  if (/MYMEMORY WARNING/i.test(text) || /QUERY LENGTH LIMIT/i.test(text)) {
    throw new Error(text)
  }
  return decodeEntities(text).trim()
}

export function stripWrappingQuotes(text) {
  const value = String(text || '').trim()
  if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith('“') && value.endsWith('”')))) {
    return value.slice(1, -1).trim()
  }
  return value
}

export function memoryQuery(text, context) {
  const source = String(text || '').trim()
  if (!context?.source || !context.fragment) return source
  if (context.spoken && !context.fragment) return source
  if (source.startsWith(context.source)) return source
  return `${context.source}${source}`
}

export const INTERPRETER_PROMPT = [
  'You are a simultaneous interpreter. Translate Mandarin Chinese into natural spoken English.',
  'Continue from the previous English when one is given. Do not repeat it.',
  'Write names in pinyin. Read numbers as they were said, such as three point one four or thirty-five percent.',
  'Skip fillers. Never leave a dangling copula. The input may be a partial clause.',
  'Return spoken English only, with no wrapping quotes.',
].join(' ')

export const REWRITE_PROMPT = [
  'You rewrite a draft English interpretation into one sentence a person can say aloud.',
  'Keep the name in pinyin, keep digits as digits (1,000 stays 1,000), and keep the facts.',
  'Do not reverse, soften, or add anything.',
  'Continue from the previous English when one is given. Do not repeat it.',
  'Return the spoken English only, with no wrapping quotes.',
].join(' ')

export async function translateText(text, env, fetchImpl = globalThis.fetch, options = {}) {
  const source = normalizeMandarin(text)
  if (!source || isFillerOnly(source)) return ''
  const provider = resolveTranslationProvider(env)
  if (provider === 'off') {
    throw new Error('Server translation is off. Use Chrome\'s built-in translator or set INTERPRET_PROVIDER.')
  }
  if (provider === 'auto' || provider === 'qwen-minimax') return translateChain(source, env, fetchImpl, options)
  if (provider === 'doubao') return finish(await translateWithDoubao(source, env, fetchImpl, options), options)
  if (provider === 'minimax') return translateWithMinimax(source, env, fetchImpl, options)
  if (provider === 'libretranslate') return finish(await translateWithLibre(source, env, fetchImpl), options)
  if (provider === 'mymemory') return finish(await translateWithMyMemory(memoryQuery(source, options.context), env, fetchImpl), options)
  throw new Error(`Unknown INTERPRET_PROVIDER "${provider}"`)
}

function finish(english, options) {
  if (english) options.onDelta?.(english)
  return english
}

async function translateWithMyMemory(text, env, fetchImpl) {
  const url = new URL('https://api.mymemory.translated.net/get')
  url.searchParams.set('q', text.slice(0, 500))
  url.searchParams.set('langpair', 'zh-CN|en')
  if (env.MYMEMORY_EMAIL) url.searchParams.set('de', env.MYMEMORY_EMAIL)
  const response = await fetchImpl(url, { headers: { accept: 'application/json' } })
  if (!response.ok) throw new Error(`MyMemory HTTP ${response.status}`)
  return readMyMemory(await response.json())
}

async function translateWithLibre(text, env, fetchImpl) {
  const base = String(env.LIBRETRANSLATE_URL || '').replace(/\/$/, '')
  if (!base) throw new Error('LIBRETRANSLATE_URL is empty')
  const response = await fetchImpl(`${base}/translate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      q: text,
      source: 'zh',
      target: 'en',
      format: 'text',
      api_key: env.LIBRETRANSLATE_API_KEY || undefined,
    }),
  })
  if (!response.ok) throw new Error(`LibreTranslate HTTP ${response.status}`)
  const payload = await response.json()
  const translated = payload.translatedText
  if (typeof translated !== 'string' || !translated.trim()) throw new Error('LibreTranslate returned no text')
  return translated.trim()
}

function qwenHost(env) {
  return String(env.QWEN_API_HOST || QWEN_API_HOST_DEFAULT).replace(/\/$/, '')
}

function doubaoHost(env) {
  return String(env.DOUBAO_API_HOST || DOUBAO_API_HOST_DEFAULT).replace(/\/$/, '')
}

function chatConfig(env) {
  return {
    key: env.MINIMAX_API_KEY,
    base: minimaxHost(env),
    model: env.MINIMAX_CHAT_MODEL || MINIMAX_CHAT_MODEL,
    path: '/v1/chat/completions',
  }
}

function chatUserContent(text, context) {
  if (!context?.source) return text
  return [
    `Previous Mandarin: ${context.source}`,
    `Previous English: ${context.english || ''}`,
    `Current Mandarin: ${text}`,
  ].join('\n')
}

async function postChat(url, key, body, fetchImpl, label, signal) {
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${key}`,
    },
    body: JSON.stringify(body),
    signal,
  })
  if (!response.ok) throw new Error(`${label} HTTP ${response.status}`)
  const payload = await response.json()
  const content = payload.choices?.[0]?.message?.content
  if (typeof content !== 'string' || !content.trim()) throw new Error(`${label} returned no text`)
  return stripWrappingQuotes(content)
}

async function translateWithQwen(text, env, fetchImpl, options = {}) {
  const key = env.QWEN_TOKEN_PLAN_API_KEY
  if (!key) throw new Error('qwen is selected but QWEN_TOKEN_PLAN_API_KEY is not set')
  return postChat(`${qwenHost(env)}/chat/completions`, key, {
    model: env.QWEN_CHAT_MODEL || QWEN_CHAT_MODEL,
    temperature: 0,
    max_tokens: 256,
    stream: false,
    enable_thinking: false,
    messages: [
      { role: 'system', content: INTERPRETER_PROMPT },
      { role: 'user', content: chatUserContent(text, options.context) },
    ],
  }, fetchImpl, 'qwen', AbortSignal.timeout(QWEN_TIMEOUT_MS))
}

function rewriteUserContent(mandarin, draft, context) {
  const lines = []
  if (context?.source) {
    lines.push(`Previous Mandarin: ${context.source}`, `Previous English: ${context.english || ''}`)
  }
  lines.push(`Mandarin: ${mandarin}`, `Draft English: ${draft}`)
  return lines.join('\n')
}

async function rewriteWithMinimax(draft, mandarin, env, fetchImpl, options = {}) {
  const config = chatConfig(env)
  if (!config.key) throw new Error('minimax is selected but MINIMAX_API_KEY is not set')
  return postChat(`${config.base}${config.path}`, config.key, {
    model: config.model,
    temperature: 0,
    max_tokens: 256,
    stream: false,
    messages: [
      { role: 'system', content: REWRITE_PROMPT },
      { role: 'user', content: rewriteUserContent(mandarin, draft, options.context) },
    ],
  }, fetchImpl, 'minimax', AbortSignal.timeout(REWRITE_TIMEOUT_MS))
}

async function translateWithDoubao(text, env, fetchImpl, options = {}) {
  const key = env.ARK_API_KEY
  if (!key) throw new Error('doubao is selected but ARK_API_KEY is not set')
  return postChat(`${doubaoHost(env)}/chat/completions`, key, {
    model: env.DOUBAO_CHAT_MODEL || DOUBAO_CHAT_MODEL,
    temperature: 0,
    max_tokens: 256,
    stream: false,
    thinking: { type: 'disabled' },
    messages: [
      { role: 'system', content: INTERPRETER_PROMPT },
      { role: 'user', content: chatUserContent(text, options.context) },
    ],
  }, fetchImpl, 'doubao', AbortSignal.timeout(DOUBAO_TIMEOUT_MS))
}

async function translateChain(text, env, fetchImpl, options = {}) {
  let lastError = null
  if (env.QWEN_TOKEN_PLAN_API_KEY && env.MINIMAX_API_KEY) {
    try {
      const draft = await translateWithQwen(text, env, fetchImpl, options)
      if (draft) {
        const spoken = await rewriteWithMinimax(draft, text, env, fetchImpl, options)
        if (spoken) return finish(spoken, options)
      }
      lastError = new Error('qwen returned no text')
    } catch (error) {
      lastError = error
    }
  }
  if (env.ARK_API_KEY) {
    try {
      const spoken = await translateWithDoubao(text, env, fetchImpl, options)
      if (spoken) return finish(spoken, options)
    } catch (error) {
      lastError = error
    }
  }
  if (env.MINIMAX_API_KEY) return translateWithMinimax(text, env, fetchImpl, options)
  if (env.LIBRETRANSLATE_URL) return finish(await translateWithLibre(text, env, fetchImpl), options)
  if (!env.QWEN_TOKEN_PLAN_API_KEY && !env.ARK_API_KEY && !env.MINIMAX_API_KEY) {
    return finish(await translateWithMyMemory(memoryQuery(text, options.context), env, fetchImpl), options)
  }
  throw lastError || new Error('Translation failed')
}

async function translateWithMinimax(text, env, fetchImpl, options = {}) {
  const config = chatConfig(env)
  if (!config.key) throw new Error('minimax is selected but MINIMAX_API_KEY is not set')
  const response = await fetchImpl(`${config.base}${config.path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${config.key}`,
    },
    body: JSON.stringify({
      model: config.model,
      temperature: 0.2,
      stream: true,
      messages: [
        { role: 'system', content: INTERPRETER_PROMPT },
        { role: 'user', content: chatUserContent(text, options.context) },
      ],
    }),
    signal: AbortSignal.timeout(8000),
  })
  if (!response.ok) {
    throw new Error(`minimax HTTP ${response.status}`)
  }
  return readChatStream(response, options.onDelta)
}

function takeSseContent(line) {
  const trimmed = line.trim()
  if (!trimmed.startsWith('data:')) return ''
  const data = trimmed.slice(5).trim()
  if (!data || data === '[DONE]') return ''
  const payload = JSON.parse(data)
  const delta = payload.choices?.[0]?.delta?.content ?? payload.choices?.[0]?.message?.content ?? ''
  return typeof delta === 'string' ? delta : ''
}

export async function readChatStream(response, onDelta) {
  const reader = response.body?.getReader?.()
  if (!reader) {
    const payload = await response.json()
    const content = payload.choices?.[0]?.message?.content
    if (typeof content !== 'string' || !content.trim()) throw new Error('Chat model returned no text')
    return stripWrappingQuotes(content)
  }
  const decoder = new TextDecoder()
  let buffer = ''
  let english = ''
  const consume = (line) => {
    let piece = ''
    try {
      piece = takeSseContent(line)
    } catch {
      return
    }
    if (!piece) return
    english += piece
    onDelta?.(piece)
  }
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) consume(line)
  }
  if (buffer.trim()) consume(buffer)
  const cleaned = stripWrappingQuotes(english)
  if (!cleaned) throw new Error('Chat model returned no text')
  return cleaned
}

export function publicConfig(env) {
  const translationProvider = activeTranslationProvider(env)
  return {
    translationProvider,
    ttsProvider: resolveTtsProvider(),
    minimaxVoice: minimaxVoiceId(env),
    minimaxClone: Boolean(env.MINIMAX_CLONE_AUDIO),
    minimaxKey: Boolean(env.MINIMAX_API_KEY),
    speechPy: Boolean(speechPyPath(env)),
    qwenModel: env.QWEN_TOKEN_PLAN_API_KEY ? (env.QWEN_CHAT_MODEL || QWEN_CHAT_MODEL) : '',
    doubaoModel: env.ARK_API_KEY ? (env.DOUBAO_CHAT_MODEL || DOUBAO_CHAT_MODEL) : '',
    chatModel: env.MINIMAX_API_KEY ? (env.MINIMAX_CHAT_MODEL || MINIMAX_CHAT_MODEL) : '',
    thirdPartyTranslation: ['mymemory', 'libretranslate', 'minimax', 'doubao', 'qwen-minimax'].includes(translationProvider),
  }
}
