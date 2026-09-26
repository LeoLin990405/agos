import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

/** Same default as cn-capabilities `speak` and MiniMax's own client. */
export const MINIMAX_DEFAULT_VOICE = 'female-shaonv'
const DEFAULT_HOST = 'https://api.minimaxi.com'
const DEFAULT_MODEL = 'speech-2.8-hd'

const cloneCache = new Map()

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
    stream: false,
    voice_setting: {
      voice_id: voiceId,
      speed: 1,
      vol: 1,
      pitch: 0,
    },
    audio_setting: {
      sample_rate: 32000,
      bitrate: 128000,
      format: 'wav',
      channel: 1,
    },
    language_boost: 'auto',
  }
}

export function readMinimaxAudio(payload) {
  const status = payload?.base_resp?.status_code
  if (status !== undefined && status !== 0) {
    throw new Error(payload.base_resp.status_msg || `MiniMax error ${status}`)
  }
  const audio = payload?.data?.audio
  if (typeof audio !== 'string' || !audio) throw new Error('MiniMax returned no audio')
  const bytes = Buffer.from(audio, 'hex')
  if (bytes.length < 44) throw new Error('MiniMax audio was empty')
  return bytes
}

function missingKey() {
  const error = new Error('Set MINIMAX_API_KEY. English speech uses MiniMax (voice female-shaonv unless MINIMAX_VOICE_ID is set).')
  error.status = 503
  return error
}

/**
 * English speech.
 * Prefer the agos `speak` script (`speech.py speak --provider minimax`) when
 * dsh-vision is installed. Otherwise call the same MiniMax T2A endpoint that
 * script uses: POST /v1/t2a_v2 with MINIMAX_API_KEY.
 */
export async function synthesizeSpeech(text, env, deps = {}) {
  const spoken = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 500)
  if (!spoken) throw new Error('Nothing to speak')
  const script = speechPyPath(env, deps.existsSync)
  if (script) return synthesizeWithSpeechPy(spoken, env, script, deps)
  return synthesizeMinimaxHttp(spoken, env, deps.fetchImpl || globalThis.fetch)
}

async function synthesizeWithSpeechPy(text, env, script, deps) {
  const spawnImpl = deps.spawnImpl || spawn
  const voice = minimaxVoiceId(env)
  const dir = await mkdtemp(join(tmpdir(), 'studio-minimax-'))
  const outPath = join(dir, 'speech.wav')
  const argv = [script, 'speak', text, '--out', outPath, '--provider', 'minimax', '--voice', voice]
  if (env.MINIMAX_CLONE_AUDIO) argv.push('--clone', env.MINIMAX_CLONE_AUDIO)
  const python = env.PYTHON || 'python3'
  try {
    await new Promise((resolve, reject) => {
      const child = spawnImpl(python, argv, { env: { ...process.env, ...env } })
      let stderr = ''
      child.stderr?.on('data', (chunk) => { stderr += chunk })
      child.on('error', reject)
      child.on('close', (code) => {
        if (code !== 0) reject(new Error(stderr.trim() || `speech.py exited ${code}`))
        else resolve()
      })
    })
    const wav = await readFile(outPath)
    if (wav.length < 44) throw new Error('speech.py did not write audio')
    return wav
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

async function synthesizeMinimaxHttp(text, env, fetchImpl) {
  if (!env.MINIMAX_API_KEY) throw missingKey()
  const voiceId = await resolveVoice(env, fetchImpl)
  const response = await fetchImpl(`${minimaxHost(env)}/v1/t2a_v2`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.MINIMAX_API_KEY}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(buildT2aBody(text, voiceId, env)),
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw new Error(payload?.base_resp?.status_msg || `MiniMax HTTP ${response.status}`)
  }
  return readMinimaxAudio(payload)
}

async function resolveVoice(env, fetchImpl) {
  const sample = env.MINIMAX_CLONE_AUDIO
  if (!sample) return minimaxVoiceId(env)
  const voiceId = String(env.MINIMAX_VOICE_ID || '').trim()
  if (!voiceId || voiceId === MINIMAX_DEFAULT_VOICE) {
    throw new Error('MINIMAX_CLONE_AUDIO needs your own MINIMAX_VOICE_ID. female-shaonv is a built-in voice, not a clone slot.')
  }
  const cached = cloneCache.get(voiceId)
  if (cached === sample) return voiceId
  const bytes = readFileSync(sample)
  const form = new FormData()
  form.set('purpose', 'voice_clone')
  form.set('file', new Blob([bytes]), 'sample.wav')
  const upload = await fetchImpl(`${minimaxHost(env)}/v1/files/upload`, {
    method: 'POST',
    headers: { authorization: `Bearer ${env.MINIMAX_API_KEY}` },
    body: form,
  })
  const uploaded = await upload.json().catch(() => ({}))
  if (!upload.ok) throw new Error(uploaded?.base_resp?.status_msg || `MiniMax upload HTTP ${upload.status}`)
  const fileId = uploaded?.file?.file_id
  if (!fileId) throw new Error('MiniMax upload did not return a file_id')
  const cloned = await fetchImpl(`${minimaxHost(env)}/v1/voice_clone`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.MINIMAX_API_KEY}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      file_id: fileId,
      voice_id: voiceId,
      text: 'This is my English voice.',
      model: env.MINIMAX_TTS_MODEL || DEFAULT_MODEL,
    }),
  })
  const cloneBody = await cloned.json().catch(() => ({}))
  if (!cloned.ok || (cloneBody?.base_resp && cloneBody.base_resp.status_code !== 0)) {
    throw new Error(cloneBody?.base_resp?.status_msg || `MiniMax voice_clone HTTP ${cloned.status}`)
  }
  cloneCache.set(voiceId, sample)
  return voiceId
}
