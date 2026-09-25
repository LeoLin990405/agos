import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export function synthesizeEspeak(text, options = {}) {
  const bin = options.bin || 'espeak-ng'
  const voice = options.voice || 'en-us'
  const spawnImpl = options.spawnImpl || spawn
  const spoken = text.replace(/\s+/g, ' ').trim().slice(0, 500)
  if (!spoken) return Promise.reject(new Error('Nothing to speak'))

  return new Promise(async (resolve, reject) => {
    let dir
    try {
      dir = await mkdtemp(join(tmpdir(), 'studio-tts-'))
    } catch (error) {
      reject(error)
      return
    }
    const outPath = join(dir, 'speech.wav')
    const child = spawnImpl(bin, ['-v', voice, '-s', '155', '-w', outPath, spoken])
    let stderr = ''
    child.stderr?.on('data', (chunk) => { stderr += chunk })
    child.on('error', (error) => {
      rm(dir, { recursive: true, force: true }).catch(() => {})
      reject(error)
    })
    child.on('close', async (code) => {
      try {
        if (code !== 0) throw new Error(stderr.trim() || `${bin} exited ${code}`)
        const wav = await readFile(outPath)
        if (wav.length < 44 || wav.subarray(0, 4).toString() !== 'RIFF') {
          throw new Error(`${bin} did not write a wav file`)
        }
        resolve(wav)
      } catch (error) {
        reject(error)
      } finally {
        rm(dir, { recursive: true, force: true }).catch(() => {})
      }
    })
  })
}

export async function synthesizeOpenAI(text, env, fetchImpl = globalThis.fetch) {
  const base = (env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '')
  const response = await fetchImpl(`${base}/audio/speech`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: env.OPENAI_TTS_MODEL || 'tts-1',
      voice: env.OPENAI_TTS_VOICE || 'alloy',
      input: text.slice(0, 500),
      response_format: 'wav',
    }),
  })
  if (!response.ok) {
    const detail = await response.text()
    throw new Error(`OpenAI speech HTTP ${response.status}: ${detail.slice(0, 240)}`)
  }
  const bytes = Buffer.from(await response.arrayBuffer())
  if (bytes.length < 44) throw new Error('OpenAI speech returned an empty file')
  return bytes
}
