import { createServer } from 'node:http'
import { existsSync, readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'
import { activeTranslationProvider, assembleEnv, publicConfig, translateText } from './lib/providers.mjs'
import { audioKind, synthesizeSpeech, warmMinimax } from './lib/tts.mjs'

const ROOT = dirname(fileURLToPath(import.meta.url))
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.wav': 'audio/wav',
  '.json': 'application/json; charset=utf-8',
}

const cache = new Map()

function readIfPresent(path) {
  if (!path || !existsSync(path)) return ''
  return readFileSync(path, 'utf8')
}

function envFromDisk() {
  const secretsPath = process.env.CC_MODEL_SECRETS || join(homedir(), '.config', 'cc-model-secrets.env')
  const settingsPath = process.env.DSH_SETTINGS || join(homedir(), '.dsh', 'settings.yaml')
  return assembleEnv({
    processEnv: process.env,
    studioText: readIfPresent(join(ROOT, '.env')),
    secretsText: readIfPresent(secretsPath),
    settingsText: readIfPresent(settingsPath),
  })
}

function remember(text, english) {
  cache.set(text, english)
  if (cache.size > 200) cache.delete(cache.keys().next().value)
  return english
}

function cacheKey(text, env, context) {
  const provider = activeTranslationProvider(env)
  const previous = context?.source ? `${context.source}\n${context.english || ''}\n${context.fragment ? 1 : 0}` : ''
  return `${provider}\n${previous}\n${text.trim()}`
}

async function interpret(text, env, context, onDelta) {
  const key = cacheKey(text, env, context)
  if (cache.has(key)) return cache.get(key)
  const english = await translateText(text, env, globalThis.fetch, { context, onDelta })
  if (!english) return ''
  return remember(key, english)
}

function send(res, status, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' })
  res.end(body)
}

function readBody(req, limit = 100_000) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(Object.assign(new Error('Body too large'), { status: 413 }))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function staticPath(urlPath) {
  const requested = urlPath === '/' ? '/web/index.html' : urlPath
  const clean = normalize(requested).replace(/^(\.\.[/\\])+/, '')
  if (clean.includes('..')) return null
  const allowed = clean.startsWith('/web/') || clean.startsWith('/lib/') || clean === '/web/index.html'
  if (!allowed) return null
  const file = join(ROOT, clean)
  if (!file.startsWith(ROOT)) return null
  return file
}

export function startServer({ env = envFromDisk(), host = env.HOST || '127.0.0.1', port = Number(env.PORT || 4173) } = {}) {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://127.0.0.1')
      if (req.method === 'GET' && url.pathname === '/api/config') {
        send(res, 200, JSON.stringify(publicConfig(env)), 'application/json; charset=utf-8')
        return
      }
      if (req.method === 'POST' && url.pathname === '/api/interpret') {
        const payload = JSON.parse(await readBody(req) || '{}')
        const text = typeof payload.text === 'string' ? payload.text.trim() : ''
        if (!text) {
          send(res, 400, 'Missing text')
          return
        }
        if (text.length > 500) {
          send(res, 400, 'Text is too long for one interpretation chunk')
          return
        }
        const context = payload.previous && typeof payload.previous.source === 'string' ? payload.previous : null
        let started = false
        const english = await interpret(text, env, context, (piece) => {
          if (!started) {
            res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
            started = true
          }
          res.write(piece)
        })
        if (started) {
          res.end()
          return
        }
        send(res, 200, english)
        return
      }
      if (req.method === 'POST' && url.pathname === '/api/tts') {
        const payload = JSON.parse(await readBody(req) || '{}')
        const text = typeof payload.text === 'string' ? payload.text.trim() : ''
        if (!text) {
          send(res, 400, 'Missing text')
          return
        }
        const ac = new AbortController()
        req.on('close', () => {
          if (!res.writableEnded) ac.abort()
        })
        const audio = await synthesizeSpeech(text, env, { signal: ac.signal })
        if (audio && typeof audio === 'object' && audio.format === 'pcm') {
          res.writeHead(200, {
            'content-type': 'application/octet-stream',
            'x-audio-format': 'pcm',
            'x-sample-rate': String(audio.sampleRate || 32000),
            'cache-control': 'no-store',
          })
          for await (const chunk of audio.stream) {
            if (ac.signal.aborted) break
            res.write(chunk)
          }
          res.end()
          return
        }
        const kind = audioKind(audio)
        const type = kind === 'mp3' ? 'audio/mpeg' : 'audio/wav'
        send(res, 200, audio, type)
        return
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        send(res, 405, 'Method not allowed')
        return
      }
      const file = staticPath(url.pathname)
      if (!file) {
        send(res, 404, 'Not found')
        return
      }
      const body = await readFile(file)
      const type = TYPES[extname(file)] || 'application/octet-stream'
      send(res, 200, req.method === 'HEAD' ? undefined : body, type)
    } catch (error) {
      if (res.headersSent) {
        res.destroy()
        return
      }
      const status = error.status || (error instanceof SyntaxError ? 400 : 502)
      const tts = (req.url || '').startsWith('/api/tts')
      const body = tts
        ? (error.publicMessage || '英文配音失败')
        : (error.publicMessage || error.message || 'Interpretation failed')
      send(res, status, body)
    }
  })

  void warmMinimax(env).catch((error) => {
    console.error(error.publicMessage || 'MiniMax clone failed')
  })

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => {
      const address = server.address()
      const bound = typeof address === 'object' && address ? address.port : port
      resolve({
        server,
        host,
        port: bound,
        url: `http://${host}:${bound}/`,
        close: () => new Promise((done, fail) => server.close((error) => error ? fail(error) : done())),
      })
    })
  })
}

const invokedPath = process.argv[1] ? fileURLToPath(import.meta.url) === process.argv[1] : false
if (invokedPath) {
  const running = await startServer()
  console.log(`Presentation studio at ${running.url}`)
}
