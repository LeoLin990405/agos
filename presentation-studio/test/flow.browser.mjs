import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { startServer } from '../server.mjs'

const require = createRequire(new URL('../package.json', import.meta.url))

test('speaking, live English, and a captioned recording', async () => {
  const { chromium } = require('playwright-core')
  const running = await startServer({
    env: {
      ...process.env,
      INTERPRET_PROVIDER: 'mymemory',
      TTS_PROVIDER: 'espeak',
      ESPEAK_BIN: 'espeak-ng',
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
    await page.waitForFunction(() => document.querySelector('#providers')?.textContent?.includes('MyMemory'))

    await page.click('#record')
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
    assert.match(englishDuring, /[A-Za-z]{3,}/)
    assert.equal(/[\u4e00-\u9fff]/.test(englishDuring) && !/[A-Za-z]/.test(englishDuring), false)

    await page.waitForFunction(() => (window.__trace || []).some((item) => item.kind === 'spoken'), null, { timeout: 20000 })
    await page.waitForTimeout(1600)
    await page.click('#record')
    await page.waitForFunction(() => window.__lastRecording && window.__lastRecording.size > 1000, null, { timeout: 10000 })

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

    assert.deepEqual(pageErrors, [])
  } finally {
    await browser.close()
    await running.close()
    await rm(dir, { recursive: true, force: true })
  }
})

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
