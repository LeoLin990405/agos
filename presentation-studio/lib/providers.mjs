/**
 * Translation and speech providers. Keys come from the environment only.
 */

const DEFAULT_DEEPSEEK_BASE = 'https://api.deepseek.com'
const DEFAULT_OPENAI_BASE = 'https://api.openai.com/v1'
const DEFAULT_DEEPSEEK_MODEL = 'deepseek-chat'
const DEFAULT_OPENAI_MODEL = 'gpt-4o-mini'

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
  if (env.DEEPSEEK_API_KEY) return 'deepseek'
  if (env.OPENAI_API_KEY) return 'openai'
  if (env.LIBRETRANSLATE_URL) return 'libretranslate'
  return 'mymemory'
}

export function resolveTtsProvider(env, espeakExists = false) {
  const explicit = (env.TTS_PROVIDER || 'auto').trim().toLowerCase()
  if (explicit !== 'auto') return explicit
  if (espeakExists) return 'espeak'
  if (env.OPENAI_API_KEY) return 'openai'
  return 'browser'
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

export async function translateText(text, env, fetchImpl = globalThis.fetch) {
  const source = text.trim()
  if (!source) return ''
  const provider = resolveTranslationProvider(env)
  if (provider === 'off') {
    throw new Error('Server translation is off. Use Chrome\'s built-in translator or set INTERPRET_PROVIDER.')
  }
  if (provider === 'deepseek' || provider === 'openai') return translateWithChat(source, env, provider, fetchImpl)
  if (provider === 'libretranslate') return translateWithLibre(source, env, fetchImpl)
  if (provider === 'mymemory') return translateWithMyMemory(source, env, fetchImpl)
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

function chatConfig(env, provider) {
  if (provider === 'deepseek') {
    return {
      key: env.DEEPSEEK_API_KEY,
      base: (env.DEEPSEEK_BASE_URL || DEFAULT_DEEPSEEK_BASE).replace(/\/$/, ''),
      model: env.DEEPSEEK_MODEL || DEFAULT_DEEPSEEK_MODEL,
      path: '/chat/completions',
    }
  }
  return {
    key: env.OPENAI_API_KEY,
    base: (env.OPENAI_BASE_URL || DEFAULT_OPENAI_BASE).replace(/\/$/, ''),
    model: env.OPENAI_MODEL || DEFAULT_OPENAI_MODEL,
    path: '/chat/completions',
  }
}

async function translateWithChat(text, env, provider, fetchImpl) {
  const config = chatConfig(env, provider)
  if (!config.key) throw new Error(`${provider} is selected but no API key is set`)
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
        {
          role: 'system',
          content: 'You are a simultaneous interpreter. Translate Mandarin Chinese into natural spoken English. The input may be a partial clause. Translate only what is present, do not invent an ending, and return English only.',
        },
        { role: 'user', content: text },
      ],
    }),
  })
  if (!response.ok) {
    const detail = await response.text()
    throw new Error(`${provider} HTTP ${response.status}: ${detail.slice(0, 240)}`)
  }
  return readChatStream(response)
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

export async function readChatStream(response) {
  const reader = response.body?.getReader?.()
  if (!reader) {
    const payload = await response.json()
    const content = payload.choices?.[0]?.message?.content
    if (typeof content !== 'string' || !content.trim()) throw new Error('Chat model returned no text')
    return content.trim()
  }
  const decoder = new TextDecoder()
  let buffer = ''
  let english = ''
  const consume = (line) => {
    try {
      english += takeSseContent(line)
    } catch {
      // A broken frame is skipped; callers still get any text that parsed.
    }
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
  const cleaned = english.trim()
  if (!cleaned) throw new Error('Chat model returned no text')
  return cleaned
}

export function publicConfig(env, espeakExists) {
  return {
    translationProvider: resolveTranslationProvider(env),
    ttsProvider: resolveTtsProvider(env, espeakExists),
    thirdPartyTranslation: ['mymemory', 'libretranslate', 'deepseek', 'openai'].includes(resolveTranslationProvider(env)),
  }
}
