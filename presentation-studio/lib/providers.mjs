/**
 * Translation providers. English speech is MiniMax; see lib/tts.mjs.
 */
import { isFillerOnly, normalizeMandarin } from './session.mjs'
import { minimaxHost, minimaxVoiceId, speechPyPath } from './tts.mjs'

/** Same text model agos routes as `minimax-cn` / MiniMax-M3. */
export const MINIMAX_CHAT_MODEL = 'MiniMax-M3'

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
  if (explicit !== 'auto') return explicit
  if (env.MINIMAX_API_KEY) return 'minimax'
  if (env.LIBRETRANSLATE_URL) return 'libretranslate'
  return 'mymemory'
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

export async function translateText(text, env, fetchImpl = globalThis.fetch, options = {}) {
  const source = normalizeMandarin(text)
  if (!source || isFillerOnly(source)) return ''
  const provider = resolveTranslationProvider(env)
  if (provider === 'off') {
    throw new Error('Server translation is off. Use Chrome\'s built-in translator or set INTERPRET_PROVIDER.')
  }
  if (provider === 'minimax') return translateWithMinimax(source, env, fetchImpl, options)
  if (provider === 'libretranslate') return translateWithLibre(source, env, fetchImpl)
  if (provider === 'mymemory') return translateWithMyMemory(memoryQuery(source, options.context), env, fetchImpl)
  throw new Error(`Unknown INTERPRET_PROVIDER "${provider}"`)
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
  return {
    translationProvider: resolveTranslationProvider(env),
    ttsProvider: resolveTtsProvider(),
    minimaxVoice: minimaxVoiceId(env),
    minimaxClone: Boolean(env.MINIMAX_CLONE_AUDIO),
    minimaxKey: Boolean(env.MINIMAX_API_KEY),
    speechPy: Boolean(speechPyPath(env)),
    chatModel: env.MINIMAX_API_KEY ? (env.MINIMAX_CHAT_MODEL || MINIMAX_CHAT_MODEL) : '',
    thirdPartyTranslation: ['mymemory', 'libretranslate', 'minimax'].includes(resolveTranslationProvider(env)),
  }
}
