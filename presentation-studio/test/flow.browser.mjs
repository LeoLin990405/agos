import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { startServer } from '../server.mjs'

const require = createRequire(new URL('../package.json', import.meta.url))

function toneWav() {
  const rate = 8000
  const count = rate
  const data = Buffer.alloc(count * 2)
  for (let i = 0; i < count; i += 1) {
    data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 12000), i * 2)
  }
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + data.length, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(rate, 24)
  header.writeUInt32LE(rate * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(data.length, 40)
  return Buffer.concat([header, data])
}

function startMinimax() {
  const requests = []
  const wav = toneWav()
  const server = createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const raw = Buffer.concat(chunks).toString('utf8')
    requests.push({
      url: req.url,
      authorization: req.headers.authorization,
      body: raw ? JSON.parse(raw) : {},
    })
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ base_resp: { status_code: 0 }, data: { audio: wav.toString('hex') } }))
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      resolve({
        url: `http://127.0.0.1:${port}`,
        requests,
        close: () => new Promise((done, fail) => server.close((error) => error ? fail(error) : done())),
      })
    })
  })
}

test('speaking, live English, and a captioned recording', async () => {
  const { chromium } = require('playwright-core')
  const minimax = await startMinimax()
  const running = await startServer({
    env: {
      ...process.env,
      INTERPRET_PROVIDER: 'mymemory',
      MINIMAX_API_KEY: 'mm-browser-test',
      MINIMAX_API_HOST: minimax.url,
      MINIMAX_VOICE_ID: '',
      MINIMAX_CLONE_AUDIO: '',
      DSH_CN_VISION_DIR: '/no/such/vision',
      HOST: '127.0.0.1',
    },
    host: '127.0.0.1',
    port: 0,
  })
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome',
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      '--autoplay-policy=no-user-gesture-required',
      '--no-sandbox',
      '--disable-gpu',
    ],
  })
  const dir = await mkdtemp(join(tmpdir(), 'studio-take-'))
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
    const pageErrors = []
    page.on('pageerror', (error) => pageErrors.push(String(error)))
    await page.goto(running.url, { waitUntil: 'domcontentloaded' })
    await page.waitForFunction(() => {
      const text = document.querySelector('#providers')?.textContent || ''
      return text.includes('MyMemory') && text.includes('MiniMax') && text.includes('female-shaonv')
    })

    await page.click('#record')
    await page.click('#record-anyway')
    await page.waitForFunction(() => document.querySelector('#record-flag') && !document.querySelector('#record-flag').hidden)
    await page.click('#rehearse')

    await page.waitForFunction(() => {
      const trace = window.__trace || []
      const started = trace.find((item) => item.kind === 'interpret-start')
      const done = trace.find((item) => item.kind === 'rehearsal-done')
      return started && done && started.t < done.t && started.revealed < window.__studio.sample.length
    }, null, { timeout: 20000 })

    await page.waitForFunction(() => /[A-Za-z]{3,}/.test(document.querySelector('#english').textContent || ''), null, { timeout: 20000 })
    const englishDuring = await page.locator('#english').innerText()
    const mandarinDuring = await page.locator('#mandarin').innerText()
    assert.match(englishDuring, /[A-Za-z]{3,}/)
    assert.equal((mandarinDuring.match(/各位好/g) || []).length, 1)
    assert.ok((englishDuring.match(/Lin Zhongyue/g) || []).length <= 1)

    await page.waitForFunction(() => (window.__trace || []).some((item) => item.kind === 'spoken'), null, { timeout: 20000 })
    await page.waitForTimeout(1600)
    await page.click('#record')
    await page.waitForFunction(() => window.__lastRecording && window.__lastRecording.size > 1000, null, { timeout: 20000 })
    await page.waitForFunction(() => {
      const after = document.querySelector('#after')
      return after && !after.hidden && document.querySelector('#saved-title')?.textContent === '录像好了'
    })

    const bytes = await page.evaluate(async () => {
      const raw = new Uint8Array(await window.__lastRecording.arrayBuffer())
      let binary = ''
      const step = 0x8000
      for (let i = 0; i < raw.length; i += step) {
        binary += String.fromCharCode(...raw.subarray(i, i + step))
      }
      return btoa(binary)
    })
    const webmPath = join(dir, 'take.webm')
    const framePath = join(dir, 'frame.ppm')
    await writeFile(webmPath, Buffer.from(bytes, 'base64'))
    const probe = await run('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', webmPath])
    assert.match(probe.stdout, /video/)
    assert.match(probe.stdout, /audio/)

    await run('ffmpeg', ['-y', '-ss', '0.4', '-i', webmPath, '-frames:v', '1', framePath])
    const ppm = await readFile(framePath)
    const bright = brightFraction(ppm)
    assert.ok(bright > 0.01, `expected light caption pixels, saw ${bright}`)

    const volume = await run('ffmpeg', ['-i', webmPath, '-af', 'volumedetect', '-f', 'null', '-'])
    const mean = volume.stderr.match(/mean_volume:\s*(-?\d+(?:\.\d+)?)\s*dB/)
    assert.ok(mean, volume.stderr)
    assert.ok(Number(mean[1]) > -45, `recording audio was silent (${mean[1]} dB)`)

    const spoken = minimax.requests.filter((request) => request.url === '/v1/t2a_v2')
    assert.ok(spoken.length > 0)
    assert.equal(spoken[0].authorization, 'Bearer mm-browser-test')
    assert.equal(spoken[0].body.voice_setting.voice_id, 'female-shaonv')
    assert.deepEqual(pageErrors, [])
  } finally {
    await browser.close()
    await running.close()
    await minimax.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('speech before recording is dubbed, and a reset drops in-flight audio', async () => {
  const { chromium } = require('playwright-core')
  const minimax = await startMinimax()
  const running = await startServer({
    env: {
      ...process.env,
      INTERPRET_PROVIDER: 'mymemory',
      MINIMAX_API_KEY: 'mm-browser-test',
      MINIMAX_API_HOST: minimax.url,
      MINIMAX_VOICE_ID: '',
      MINIMAX_CLONE_AUDIO: '',
      DSH_CN_VISION_DIR: '/no/such/vision',
      HOST: '127.0.0.1',
    },
    host: '127.0.0.1',
    port: 0,
  })
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome',
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      '--autoplay-policy=no-user-gesture-required',
      '--no-sandbox',
      '--disable-gpu',
    ],
  })
  const dir = await mkdtemp(join(tmpdir(), 'studio-order-'))
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
    await page.goto(running.url, { waitUntil: 'domcontentloaded' })
    await page.waitForFunction(() => (document.querySelector('#providers')?.textContent || '').includes('MiniMax'))
    await page.click('#rehearse')
    await page.waitForFunction(() => (window.__trace || []).some((item) => item.kind === 'spoken'), null, { timeout: 20000 })
    await page.click('#record')
    await page.waitForFunction(() => document.querySelector('#record-flag') && !document.querySelector('#record-flag').hidden)
    await page.waitForTimeout(2200)
    await page.click('#record')
    await page.waitForFunction(() => window.__lastRecording && window.__lastRecording.size > 1000, null, { timeout: 20000 })
    const bytes = await page.evaluate(async () => {
      const raw = new Uint8Array(await window.__lastRecording.arrayBuffer())
      let binary = ''
      const step = 0x8000
      for (let i = 0; i < raw.length; i += step) binary += String.fromCharCode(...raw.subarray(i, i + step))
      return btoa(binary)
    })
    const webmPath = join(dir, 'after.webm')
    await writeFile(webmPath, Buffer.from(bytes, 'base64'))
    const volume = await run('ffmpeg', ['-i', webmPath, '-af', 'volumedetect', '-f', 'null', '-'])
    const mean = volume.stderr.match(/mean_volume:\s*(-?\d+(?:\.\d+)?)\s*dB/)
    assert.ok(mean, volume.stderr)
    assert.ok(Number(mean[1]) > -45, `pre-roll audio was silent (${mean?.[1]} dB)`)

    const delayed = await browser.newPage({ viewport: { width: 1280, height: 900 } })
    await delayed.route('**/api/tts', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 4000))
      await route.continue()
    })
    await delayed.goto(running.url, { waitUntil: 'domcontentloaded' })
    await delayed.waitForFunction(() => (document.querySelector('#providers')?.textContent || '').includes('MiniMax'))
    await delayed.click('#rehearse')
    await delayed.waitForFunction(() => (window.__trace || []).some((item) => item.kind === 'rehearsal-done'), null, { timeout: 20000 })
    const previous = await delayed.evaluate(() => window.__studio.generation())
    const markCount = await delayed.evaluate(() => (window.__trace || []).length)
    await delayed.click('#rehearse')
    await delayed.waitForTimeout(5000)
    const stale = await delayed.evaluate(({ gen, start }) => (
      (window.__trace || []).slice(start).some((item) => item.kind === 'spoken' && item.gen === gen)
    ), { gen: previous, start: markCount })
    assert.equal(stale, false)

    const takes = await browser.newPage({ viewport: { width: 1280, height: 900 } })
    await takes.goto(running.url, { waitUntil: 'domcontentloaded' })
    await takes.waitForFunction(() => (document.querySelector('#providers')?.textContent || '').includes('MiniMax'))
    await takes.click('#record')
    await takes.click('#record-anyway')
    await takes.waitForFunction(() => document.querySelector('#record-flag') && !document.querySelector('#record-flag').hidden)
    await takes.waitForTimeout(500)
    await takes.click('#record')
    await takes.click('#record')
    await takes.click('#record-anyway')
    await takes.waitForTimeout(300)
    await takes.click('#record')
    await takes.waitForFunction(() => (window.__takes || []).length >= 2, null, { timeout: 15000 })
    const sizes = await takes.evaluate(() => window.__takes.map((blob) => blob.size))
    assert.ok(sizes[0] > 100 && sizes[1] > 100, `takes did not both survive (${sizes.join(',')})`)
  } finally {
    await browser.close()
    await running.close()
    await minimax.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('a missing key uses the browser voice, a MiniMax error does not', async () => {
  const { chromium } = require('playwright-core')
  const failing = await startMinimaxError()
  const keyed = await startServer({
    env: {
      ...process.env,
      INTERPRET_PROVIDER: 'mymemory',
      MINIMAX_API_KEY: 'mm-browser-test',
      MINIMAX_API_HOST: failing.url,
      MINIMAX_VOICE_ID: '',
      MINIMAX_CLONE_AUDIO: '',
      DSH_CN_VISION_DIR: '/no/such/vision',
      HOST: '127.0.0.1',
    },
    host: '127.0.0.1',
    port: 0,
  })
  const missing = await startServer({
    env: {
      ...process.env,
      INTERPRET_PROVIDER: 'mymemory',
      MINIMAX_API_KEY: '',
      MINIMAX_CLONE_AUDIO: '',
      DSH_CN_VISION_DIR: '/no/such/vision',
      HOST: '127.0.0.1',
    },
    host: '127.0.0.1',
    port: 0,
  })
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome',
    args: ['--autoplay-policy=no-user-gesture-required', '--no-sandbox', '--disable-gpu'],
  })
  try {
    const bad = await browser.newPage()
    await bad.goto(keyed.url, { waitUntil: 'domcontentloaded' })
    await bad.click('#rehearse')
    await bad.waitForFunction(() => /[A-Za-z]{3,}/.test(document.querySelector('#english').textContent || ''), null, { timeout: 20000 })
    await bad.waitForFunction(() => (document.querySelector('#status')?.textContent || '').includes('英文配音失败'), null, { timeout: 20000 })
    const badStatus = await bad.locator('#status').innerText()
    assert.equal(badStatus.includes('MINIMAX_API_KEY'), false)
    const spoken = await bad.evaluate(() => (window.__trace || []).some((item) => item.kind === 'spoken' || item.kind === 'spoken-browser'))
    assert.equal(spoken, false)

    const open = await browser.newPage()
    await open.goto(missing.url, { waitUntil: 'domcontentloaded' })
    await open.click('#rehearse')
    await open.waitForFunction(() => /[A-Za-z]{3,}/.test(document.querySelector('#english').textContent || ''), null, { timeout: 20000 })
    await open.waitForFunction(() => (window.__trace || []).some((item) => item.kind === 'spoken-browser'), null, { timeout: 20000 })
    const status = await open.locator('#status').innerText()
    assert.match(status, /MINIMAX_API_KEY/)
  } finally {
    await browser.close()
    await keyed.close()
    await missing.close()
    await failing.close()
  }
})

function startMinimaxError() {
  const server = createServer(async (req, res) => {
    for await (const _chunk of req) { /* drain */ }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ base_resp: { status_code: 1008, status_msg: 'quota exceeded' } }))
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((done, fail) => server.close((error) => error ? fail(error) : done())),
      })
    })
  })
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args)
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code !== 0 && command !== 'ffmpeg') {
        reject(new Error(`${command} exited ${code}\n${stderr}`))
        return
      }
      resolve({ code, stdout, stderr })
    })
  })
}

function brightFraction(ppm) {
  const headerEnd = ppm.indexOf(0x0a, ppm.indexOf(0x0a) + 1)
  // P6\nWIDTH HEIGHT\n255\n
  const header = ppm.subarray(0, headerEnd).toString()
  const match = header.match(/(\d+)\s+(\d+)/)
  if (!match) throw new Error(`bad ppm header ${header}`)
  const width = Number(match[1])
  const height = Number(match[2])
  const dataStart = ppm.indexOf(0x0a, headerEnd + 1) + 1
  const pixels = ppm.subarray(dataStart)
  const y0 = Math.floor(height * 0.82)
  let bright = 0
  let total = 0
  for (let y = y0; y < height; y += 2) {
    for (let x = 0; x < width; x += 4) {
      const i = (y * width + x) * 3
      const luma = pixels[i] * 0.2126 + pixels[i + 1] * 0.7152 + pixels[i + 2] * 0.0722
      total += 1
      if (luma > 180) bright += 1
    }
  }
  return total ? bright / total : 0
}
