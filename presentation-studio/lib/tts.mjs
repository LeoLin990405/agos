import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, extname, join } from 'node:path'

/** Same default as cn-capabilities `speak` and MiniMax's own client. */
export const MINIMAX_DEFAULT_VOICE = 'female-shaonv'
const DEFAULT_HOST = 'https://api.minimaxi.com'
const DEFAULT_MODEL = 'speech-2.8-hd'
const STDOUT_CAP = 4 * 1024 * 1024

const cloneCache = new Map()
const cloneInflight = new Map()

export function minimaxVoiceId(env) {
  const voice = String(env.MINIMAX_VOICE_ID || MINIMAX_DEFAULT_VOICE).trim()
  return voice || MINIMAX_DEFAULT_VOICE
}

export function minimaxHost(env) {
  return String(env.MINIMAX_API_HOST || DEFAULT_HOST).replace(/\/$/, '')
}

export function speechPyPath(env, exists = existsSync) {
  const dir = env.DSH_CN_VISION_DIR || join(homedir(), 'Projects', 'dsh-vision')
  const script = join(dir, 'speech.py')
  return exists(script) ? script : null
}

export function buildT2aBody(text, voiceId, env) {
  return {
    model: env.MINIMAX_TTS_MODEL || DEFAULT_MODEL,
    text,
    stream: true,
    voice_setting: {
      voice_id: voiceId,
      speed: 1,
      vol: 1,
      pitch: 0,
    },
    audio_setting: {
      sample_rate: 32000,
      format: 'pcm',
      channel: 1,
    },
    output_format: 'hex',
    stream_options: { exclude_aggregated_audio: true },
    language_boost: 'auto',
  }
}

export function audioKind(bytes) {
  if (!bytes || bytes.length < 12) return null
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WAVE') return 'wav'
  if (bytes.toString('ascii', 0, 3) === 'ID3') return 'mp3'
  if (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0) return 'mp3'
  return null
}

export function readMinimaxAudio(payload) {
  const status = payload?.base_resp?.status_code
  if (status !== undefined && status !== 0) {
    throw ttsError(payload.base_resp.status_msg || `MiniMax error ${status}`, 502)
  }
  const audio = payload?.data?.audio
  if (typeof audio !== 'string' || !audio) throw ttsError('MiniMax returned no audio', 502)
  const bytes = Buffer.from(audio, 'hex')
  const kind = audioKind(bytes)
  if (!kind) throw ttsError('MiniMax audio was not wav or mp3', 502)
  return bytes
}

export function sanitizeTtsMessage(message) {
  const text = String(message || '').replace(/\s+/g, ' ').trim()
  if (!text) return ''
  if (/bearer\s+\S+/i.test(text) || /api[_-]?key/i.test(text) || /\bsk-[A-Za-z0-9]/.test(text)) return ''
  return text.slice(0, 180)
}

function ttsError(message, status = 502) {
  const safe = sanitizeTtsMessage(message)
  const error = new Error(safe || '英文配音失败')
  error.status = status
  error.publicMessage = safe ? `英文配音失败：${safe}` : '英文配音失败'
  return error
}

function missingKey() {
  const error = new Error('Set MINIMAX_API_KEY. English speech uses MiniMax (voice female-shaonv unless MINIMAX_VOICE_ID is set).')
  error.status = 503
  error.publicMessage = error.message
  return error
}

function isDuplicateVoice(body) {
  const message = String(body?.base_resp?.status_msg || '')
  return /already exist|duplicate|已存在|重复/i.test(message)
}

function readStatus(raw) {
  const base = raw.match(/"base_resp"\s*:\s*\{[^}]*\}/)
  const slice = base ? base[0] : raw
  const code = slice.match(/"status_code"\s*:\s*(-?\d+)/)
  const message = slice.match(/"status_msg"\s*:\s*"([^"]*)"/)
  return {
    code: code ? Number(code[1]) : 0,
    message: message ? message[1] : '',
  }
}

function readFileId(raw) {
  const quoted = raw.match(/"file_id"\s*:\s*"([^"]+)"/)
  if (quoted) return quoted[1]
  const digits = raw.match(/"file_id"\s*:\s*(\d+)/)
  return digits ? digits[1] : ''
}

function cloneAudioFile(sample) {
  const ext = extname(sample).toLowerCase()
  const known = {
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.m4a': 'audio/mp4',
  }
  if (known[ext]) return { name: basename(sample), type: known[ext] }
  const bytes = readFileSync(sample)
  if (bytes.length >= 3 && bytes.toString('ascii', 0, 3) === 'ID3') return { name: 'sample.mp3', type: 'audio/mpeg' }
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF') return { name: 'sample.wav', type: 'audio/wav' }
  if (bytes.length >= 8 && bytes.toString('ascii', 4, 8) === 'ftyp') return { name: 'sample.m4a', type: 'audio/mp4' }
  throw ttsError('MINIMAX_CLONE_AUDIO must be mp3, m4a, or wav', 400)
}

/**
 * English speech.
 * The live path is MiniMax HTTP. speech.py is only used when no API key is set
 * and the script is installed. Its --clone flag is MiMo, so it is never passed.
 */
export async function synthesizeSpeech(text, env, deps = {}) {
  const spoken = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 500)
  if (!spoken) throw ttsError('Nothing to speak', 400)
  if (env.MINIMAX_API_KEY) return synthesizeMinimaxHttp(spoken, env, deps.fetchImpl || globalThis.fetch, deps.signal)
  const script = speechPyPath(env, deps.existsSync)
  if (script) return synthesizeWithSpeechPy(spoken, env, script, deps)
  throw missingKey()
}

export function warmMinimax(env, deps = {}) {
  if (!env.MINIMAX_API_KEY || !env.MINIMAX_CLONE_AUDIO) return Promise.resolve(minimaxVoiceId(env))
  return resolveVoice(env, deps.fetchImpl || globalThis.fetch)
}

export function speechPyArgs(script, text, outPath, env) {
  const voice = minimaxVoiceId(env)
  return [script, 'speak', text, '--out', outPath, '--provider', 'minimax', '--voice', voice]
}

async function synthesizeWithSpeechPy(text, env, script, deps) {
  const spawnImpl = deps.spawnImpl || spawn
  const dir = await mkdtemp(join(tmpdir(), 'studio-minimax-'))
  const outPath = join(dir, 'speech.wav')
  const argv = speechPyArgs(script, text, outPath, env)
  const python = env.PYTHON || 'python3'
  try {
    await new Promise((resolve, reject) => {
      const child = spawnImpl(python, argv, { env: { ...process.env, ...env } })
      let stdout = ''
      let stderr = ''
      const fail = (message) => reject(ttsError(message, 502))
      child.stdout?.on('data', (chunk) => {
        stdout += chunk
        if (stdout.length > STDOUT_CAP) child.kill()
      })
      child.stderr?.on('data', (chunk) => {
        stderr += chunk
        if (stderr.length > STDOUT_CAP) child.kill()
      })
      const onAbort = () => child.kill()
      deps.signal?.addEventListener('abort', onAbort, { once: true })
      child.on('error', () => fail('英文配音失败'))
      child.on('close', (code) => {
        deps.signal?.removeEventListener('abort', onAbort)
        if (deps.signal?.aborted) fail('英文配音失败')
        else if (code !== 0) fail('英文配音失败')
        else resolve()
      })
    })
    const wav = await readFile(outPath)
    if (!audioKind(wav)) throw ttsError('speech.py did not write audio', 502)
    return wav
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

async function synthesizeMinimaxHttp(text, env, fetchImpl, signal) {
  if (!env.MINIMAX_API_KEY) throw missingKey()
  const voiceId = await resolveVoice(env, fetchImpl)
  const response = await fetchImpl(`${minimaxHost(env)}/v1/t2a_v2`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.MINIMAX_API_KEY}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(buildT2aBody(text, voiceId, env)),
    signal,
  })
  const type = response.headers.get('content-type') || ''
  if (type.includes('text/event-stream')) {
    return { format: 'pcm', sampleRate: 32000, stream: readPcmEvents(response) }
  }
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) throw ttsError(payload?.base_resp?.status_msg || `MiniMax HTTP ${response.status}`, 502)
  return readMinimaxAudio(payload)
}

async function* readPcmEvents(response) {
  const reader = response.body?.getReader?.()
  if (!reader) return
  const decoder = new TextDecoder()
  let buffer = ''
  const take = (line) => {
    const trimmed = line.trim()
    if (!trimmed.startsWith('data:')) return null
    const data = trimmed.slice(5).trim()
    if (!data || data === '[DONE]') return null
    const payload = JSON.parse(data)
    const status = payload?.base_resp?.status_code
    if (status !== undefined && status !== 0) {
      throw ttsError(payload.base_resp.status_msg || `MiniMax error ${status}`, 502)
    }
    const hex = payload?.data?.audio
    if (typeof hex !== 'string' || !hex) return null
    return Buffer.from(hex, 'hex')
  }
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      const chunk = take(line)
      if (chunk?.length) yield chunk
    }
  }
  if (buffer.trim()) {
    const chunk = take(buffer)
    if (chunk?.length) yield chunk
  }
}

async function resolveVoice(env, fetchImpl) {
  const sample = env.MINIMAX_CLONE_AUDIO
  if (!sample) return minimaxVoiceId(env)
  const voiceId = String(env.MINIMAX_VOICE_ID || '').trim()
  if (!voiceId || voiceId === MINIMAX_DEFAULT_VOICE) {
    throw ttsError('MINIMAX_CLONE_AUDIO needs your own MINIMAX_VOICE_ID. female-shaonv is a built-in voice, not a clone slot.', 400)
  }
  if (cloneCache.get(voiceId) === sample) return voiceId
  if (cloneInflight.has(voiceId)) return cloneInflight.get(voiceId)
  const job = cloneVoice(env, fetchImpl, voiceId, sample).finally(() => {
    cloneInflight.delete(voiceId)
  })
  cloneInflight.set(voiceId, job)
  return job
}

async function cloneVoice(env, fetchImpl, voiceId, sample) {
  const bytes = readFileSync(sample)
  const file = cloneAudioFile(sample)
  const form = new FormData()
  form.set('purpose', 'voice_clone')
  form.set('file', new Blob([bytes], { type: file.type }), file.name)
  const upload = await fetchImpl(`${minimaxHost(env)}/v1/files/upload`, {
    method: 'POST',
    headers: { authorization: `Bearer ${env.MINIMAX_API_KEY}` },
    body: form,
  })
  const raw = await upload.text()
  if (!upload.ok) {
    const status = readStatus(raw)
    throw ttsError(status.message || `MiniMax upload HTTP ${upload.status}`, 502)
  }
  const status = readStatus(raw)
  if (status.code !== 0) throw ttsError(status.message || 'MiniMax upload failed', 502)
  const fileId = readFileId(raw)
  if (!fileId) throw ttsError('MiniMax upload did not return a file_id', 502)
  const cloned = await fetchImpl(`${minimaxHost(env)}/v1/voice_clone`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.MINIMAX_API_KEY}`,
      'content-type': 'application/json',
    },
    body: cloneRequestBody(fileId, voiceId, env.MINIMAX_TTS_MODEL || DEFAULT_MODEL),
  })
  const cloneRaw = await cloned.text()
  let cloneBody = {}
  try { cloneBody = JSON.parse(cloneRaw) } catch { cloneBody = {} }
  const failed = !cloned.ok || (cloneBody?.base_resp && cloneBody.base_resp.status_code !== 0)
  if (failed && !isDuplicateVoice(cloneBody)) {
    throw ttsError(cloneBody?.base_resp?.status_msg || `MiniMax voice_clone HTTP ${cloned.status}`, 502)
  }
  cloneCache.set(voiceId, sample)
  return voiceId
}

function cloneRequestBody(fileId, voiceId, model) {
  const id = /^\d+$/.test(fileId) ? fileId : JSON.stringify(fileId)
  return `{"file_id":${id},"voice_id":${JSON.stringify(voiceId)},"text":"This is my English voice.","model":${JSON.stringify(model)}}`
}
