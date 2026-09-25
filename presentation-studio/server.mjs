import { createServer } from 'node:http'
import { existsSync, readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'
import { loadEnvFile, publicConfig, resolveTtsProvider, translateText } from './lib/providers.mjs'
import { synthesizeEspeak, synthesizeOpenAI } from './lib/tts.mjs'

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

function envFromDisk() {
  const path = join(ROOT, '.env')
  if (!existsSync(path)) return { ...process.env }
  return loadEnvFile(readFileSync(path, 'utf8'), { ...process.env })
}

function espeakBinExists(env) {
  const bin = env.ESPEAK_BIN || 'espeak-ng'
  if (bin.includes('/')) return existsSync(bin)
  const path = env.PATH || process.env.PATH || ''
  return path.split(':').some((dir) => dir && existsSync(join(dir, bin)))
}

function remember(text, english) {
  cache.set(text, english)
  if (cache.size > 200) cache.delete(cache.keys().next().value)
  return english
}

async function interpret(text, env) {
  const key = text.trim()
  if (cache.has(key)) return cache.get(key)
  const english = await translateText(key, env)
  return remember(key, english)
}

async function speak(text, env) {
  const provider = resolveTtsProvider(env, espeakBinExists(env))
  if (provider === 'espeak') {
    return synthesizeEspeak(text, { bin: env.ESPEAK_BIN || 'espeak-ng', voice: env.ESPEAK_VOICE || 'en-us' })
  }
  if (provider === 'openai') return synthesizeOpenAI(text, env)
  const error = new Error('No server TTS binary or OPENAI_API_KEY. The browser will use speechSynthesis, which is not mixed into the recording.')
  error.status = 503
  throw error
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
        send(res, 200, JSON.stringify(publicConfig(env, espeakBinExists(env))), 'application/json; charset=utf-8')
        return
      }
      if (req.method === 'POST' && url.pathname === '/api/interpret') {
        const payload = JSON.parse(await readBody(req) || '{}')
        const text = typeof payload.text === 'string' ? payload.text.trim() : ''
        if (!text) {
          send(res, 400, 'Missing text')
          return
        }
        if (text.length > 800) {
          send(res, 400, 'Text is too long for one interpretation chunk')
          return
        }
        const english = await interpret(text, env)
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
        const wav = await speak(text, env)
        send(res, 200, wav, 'audio/wav')
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
      const status = error.status || (error instanceof SyntaxError ? 400 : 502)
      send(res, status, error.message || 'Interpretation failed')
    }
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
