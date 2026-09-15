import assert from 'node:assert/strict'
import test from 'node:test'

import { classifySecret, scrubString } from '../lib/secrets-gate.js'

const SCALES = [4096, 8192, 16384, 32768, 102400, 204800]
const SCENARIOS = {
  contiguous: (chars) => 'x'.repeat(chars),
  'keyword-near-match': (chars) => 'token '.repeat(Math.ceil(chars / 6)).slice(0, chars),
  'jwt-near-match': (chars) => 'x-eyJaaaaaaaaaaaaaaaaaaaa'.repeat(Math.ceil(chars / 25)).slice(0, chars),
}

function timeMs(fn) {
  const start = performance.now()
  fn()
  return performance.now() - start
}

function median(samples) {
  return samples.sort((a, b) => a - b)[Math.floor(samples.length / 2)]
}

function benchScale(chars, makeText) {
  const text = makeText(chars)
  scrubString(text)
  classifySecret(text)
  const scrubMs = median(Array.from({ length: 5 }, () => timeMs(() => { scrubString(text) })))
  const classifyMs = median(Array.from({ length: 5 }, () => timeMs(() => { classifySecret(text) })))
  return { chars, scrubMs, classifyMs, totalMs: scrubMs + classifyMs }
}

for (const [scenario, makeText] of Object.entries(SCENARIOS)) {
test(`multi-scale ${scenario} bench: original 100KB retained, no input cap`, () => {
  const samples = SCALES.map((chars) => benchScale(chars, makeText))
  for (const sample of samples) {
    console.log(JSON.stringify({
      scenario,
      chars: sample.chars,
      scrubMs: +sample.scrubMs.toFixed(2),
      classifyMs: +sample.classifyMs.toFixed(2),
    }))
  }

  const full = samples.find((sample) => sample.chars === 102400)
  const mid = samples.find((sample) => sample.chars === 16384)
  assert.equal(full.chars, 100 * 1024)

  // Generous event-loop budget: analysis baseline was ~5.25s for one 100KB scrub.
  assert.ok(full.totalMs < 2000, `100KB classify+scrub still blocking: ${full.totalMs.toFixed(1)}ms`)

  // Only judge growth when the mid sample is large enough to be measurable.
  // Quadratic 16K→100KB is ~(100/16)^2 ≈ 39×; linear is ~6×.
  if (mid.totalMs >= 4) {
    const ratio = full.totalMs / mid.totalMs
    assert.ok(ratio < 25, `100KB/16KB=${ratio.toFixed(1)} still looks quadratic`)
  }
})
}
