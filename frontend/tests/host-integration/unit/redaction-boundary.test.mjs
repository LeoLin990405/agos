/**
 * Defect 3 regression: a secret split across chunk boundaries must not be
 * reconstructible from the log file.
 *
 * The old path detected secrets against a growing accumulator but wrote each
 * chunk as it arrived, so the leading half of a token landed on disk before any
 * complete token existed to match. Concatenating two consecutive log writes
 * handed the value back.
 *
 * These tests feed synthetic secrets through the REAL writer into REAL files on
 * disk and then read the bytes back. The decisive assertion is not "the token
 * string is absent" — a leak of the first 20 of 24 characters would pass that
 * while being a total compromise. It is "the longest prefix of the token that
 * appears anywhere in the file is shorter than N", which is what
 * "unreconstructible" actually means.
 *
 * Every value here is synthetic. No real credential is involved.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createWriteStream } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRedactingWriter, holdPoint, MAX_HOLD } from '../../../scripts/host-integration/redact-stream.mjs';
import { redact, registerSecret } from '../../../scripts/host-integration/host-env.mjs';

/**
 * Longest prefix of `secret` that occurs anywhere in `text`.
 * @param text - the file contents.
 * @param secret - the value that must not be recoverable.
 * @returns the length of the longest prefix found.
 */
function longestRecoverablePrefix(text, secret) {
  let best = 0
  for (let length = 1; length <= secret.length; length += 1) {
    if (!text.includes(secret.slice(0, length))) break
    best = length
  }
  return best
}

/**
 * Longest CONTIGUOUS RUN of the secret — from anywhere in it — that occurs in
 * the text. This is the reconstruction attack itself, run as an assertion.
 *
 * ⚠️ A prefix-only measure is not enough, and this function exists because a
 * counter-proof proved it: reverting the redaction ORDER leaks the token's
 * TAIL (`?token=[REDACTED]a7b8c9d0e1f2`), which every prefix check happily
 * reports as zero recovered characters. Any long run of a credential is a leak,
 * wherever in the value it comes from.
 * @param text - the file contents.
 * @param secret - the value that must not be recoverable.
 * @returns the length of the longest run found.
 */
function longestRecoverableRun(text, secret) {
  let best = 0
  for (let start = 0; start < secret.length; start += 1) {
    for (let end = secret.length; end > start + best; end -= 1) {
      if (text.includes(secret.slice(start, end))) { best = end - start; break }
    }
  }
  return best
}

/**
 * Drive the writer with a chosen chunking and return what reached the file.
 * @param feed - the text to stream.
 * @param chunker - splits the text into the chunks the writer will receive.
 * @returns the file contents.
 */
async function streamToFile(feed, chunker) {
  const dir = await mkdtemp(path.join(tmpdir(), 'agos-redaction-'))
  const file = path.join(dir, 'host.log')
  const stream = createWriteStream(file)
  const writer = createRedactingWriter({
    redact,
    write: (text) => stream.write(text),
  })
  for (const chunk of chunker(feed)) writer.write(chunk)
  writer.flush()
  await new Promise((resolve) => stream.end(resolve))
  const contents = await readFile(file, 'utf8')
  await rm(dir, { recursive: true, force: true })
  return contents
}

/** The worst possible split: one byte per chunk. */
const byByte = (text) => Array.from(Buffer.from(text, 'utf8'), (byte) => Buffer.from([byte]))
/** Two chunks, cut through the middle of the secret. */
const inHalf = (text) => [text.slice(0, Math.floor(text.length / 2)), text.slice(Math.floor(text.length / 2))]

describe('redaction across chunk boundaries', () => {
  // Every synthetic secret below is deliberately word-free. A value containing
  // "cookie" or "token" would show up as a 5-6 character "recovered run" purely
  // because the surrounding log says `set-cookie` — which makes the assertion
  // measure English rather than leakage.
  it('never writes a recoverable prefix of a registered secret fed one byte at a time', async () => {
    const secret = 'QZX7kM3pR8vT2nB5wY9jL4dH6sF0gC1x'
    registerSecret(secret)
    const feed = `dsh listening\nopen http://127.0.0.1:39411/?token=${secret}\nready\n`

    const contents = await streamToFile(feed, (text) => byByte(text))

    assert.equal(contents.includes(secret), false, 'the whole secret must never appear')
    const recovered = longestRecoverablePrefix(contents, secret)
    assert.ok(recovered < 4, `no usable prefix may survive, recovered ${recovered} chars: ${contents}`)
    const run = longestRecoverableRun(contents, secret)
    assert.ok(run < 6, `no usable run of the secret may survive, recovered ${run} chars: ${contents}`)
    assert.match(contents, /\[REDACTED\]/, 'the value should be replaced, not silently dropped')
    // The non-secret text around it is preserved: this is redaction, not truncation.
    assert.match(contents, /dsh listening/)
    assert.match(contents, /ready/)
  })

  it('never writes a recoverable prefix when the secret is cut exactly in half', async () => {
    const secret = 'HxV4mQ8zR2tN7bW5yK1jP9dG3sL6fC0a'
    registerSecret(secret)
    const feed = `set-cookie dsh-auth-x=${secret}; Path=/\n`

    const contents = await streamToFile(feed, inHalf)

    assert.equal(contents.includes(secret), false)
    assert.ok(longestRecoverablePrefix(contents, secret) < 4, contents)
    assert.ok(longestRecoverableRun(contents, secret) < 6, contents)
  })

  it('protects shape-only secrets that were never registered', async () => {
    // Nothing calls registerSecret for these: only the shape rules can catch
    // them, and the shape is not complete until the last byte arrives.
    const cases = [
      { label: 'api key', feed: 'provider key sk-Zp7Kq2Mv9Xn4Bt6Wr1Yl8Dh3Gs5Fc end\n', secret: 'sk-Zp7Kq2Mv9Xn4Bt6Wr1Yl8Dh3Gs5Fc' },
      { label: 'query token', feed: 'GET /?token=Vt3Nq8Zm2Xp7Br5Wk1Yd9Lh4Gc6Fs HTTP/1.1\n', secret: 'Vt3Nq8Zm2Xp7Br5Wk1Yd9Lh4Gc6Fs' },
      { label: 'bearer', feed: 'authorization: Bearer Rq2Vn8Zt5Xm7Bp1Wy4Kd9Lg3Hc6 done\n', secret: 'Rq2Vn8Zt5Xm7Bp1Wy4Kd9Lg3Hc6' },
      { label: 'auth cookie', feed: 'cookie: dsh-auth-live=Mv7Zq3Xn9Bt2Wr6Yk1Pd8Lh5Gs4; other=1\n', secret: 'Mv7Zq3Xn9Bt2Wr6Yk1Pd8Lh5Gs4' },
    ]
    for (const testCase of cases) {
      const contents = await streamToFile(testCase.feed, (text) => byByte(text))
      assert.equal(contents.includes(testCase.secret), false, `${testCase.label}: whole secret leaked → ${contents}`)
      const recovered = longestRecoverablePrefix(contents, testCase.secret)
      assert.ok(recovered < 6, `${testCase.label}: recovered ${recovered} chars from ${JSON.stringify(contents)}`)
      const run = longestRecoverableRun(contents, testCase.secret)
      assert.ok(run < 8, `${testCase.label}: recovered a ${run}-char run from ${JSON.stringify(contents)}`)
    }
  })

  it('a registered secret that is only a PREFIX of a longer value does not leak the rest', async () => {
    // The dangerous case for redaction ORDER. If the registered literal is
    // substituted before the shape rules run, `?token=<prefix><rest>` becomes
    // `?token=[REDACTED]<rest>` — which no longer matches the `?token=…` shape,
    // so the tail survives. Letting the greedy shape rule consume the whole run
    // first makes a partial registration harmless.
    const whole = 'Zr8Kq4Mv7Xn2Bt9Wp5Yd1Lh6Gc3Fs0Ja'
    registerSecret(whole.slice(0, 16))
    const contents = await streamToFile(`open http://127.0.0.1:39411/?token=${whole}\n`, (text) => byByte(text))

    assert.equal(contents.includes(whole), false)
    const run = longestRecoverableRun(contents, whole)
    assert.ok(run < 8, `a ${run}-character run of the value survived: ${contents}`)
    assert.match(contents, /token=\[REDACTED\]\n/)
  })

  it('the bearer scheme keyword does not let its token slip out across the space', async () => {
    // `Bearer` and the token are separated by whitespace, so the naive
    // "hold the trailing non-whitespace run" rule would emit `Bearer ` and then
    // treat the token as an ordinary word.
    const contents = await streamToFile('h: Bearer Kq9Vt2Zn7Xm4Bp6Wr1Yd8Lh3Gc5\n', (text) => byByte(text))
    assert.equal(contents.includes('Kq9Vt2Zn7Xm4Bp6Wr1Yd8Lh3Gc5'), false, contents)
    assert.match(contents, /Bearer \[REDACTED\]/)
  })

  it('still writes ordinary output, and writes it exactly once', async () => {
    const feed = 'line one\nline two\nline three\n'
    const contents = await streamToFile(feed, (text) => byByte(text))
    assert.equal(contents, feed)
  })

  it('reassembles multi-byte characters split across chunk boundaries', async () => {
    // A UTF-8 split used to produce mojibake because each chunk was decoded on
    // its own; the host logs Chinese, so this is a real stream shape.
    const feed = '宿主已就绪:合成中文日志行\n'
    const bytes = Buffer.from(feed, 'utf8')
    const contents = await streamToFile(feed, () => byByte(feed))
    assert.equal(contents, feed)
  })

  it('flushes the held tail when the stream ends without a trailing newline', async () => {
    const contents = await streamToFile('no trailing newline', (text) => [text])
    assert.equal(contents, 'no trailing newline')
  })

  it('bounds how much it withholds, so a pathological stream cannot pin memory', async () => {
    const run = 'x'.repeat(MAX_HOLD * 2)
    assert.equal(holdPoint(run), run.length - MAX_HOLD)
    const contents = await streamToFile(run, (text) => [text])
    assert.equal(contents, run)
  })

  it('holds the trailing token run and releases it on whitespace', () => {
    assert.equal(holdPoint('abc def'), 4)
    assert.equal(holdPoint('abc def '), 8)
    assert.equal(holdPoint('sk-abc'), 0)
    assert.equal(holdPoint('x Bearer '), 2)
    assert.equal(holdPoint('x Bearer abc'), 2)
    assert.equal(holdPoint('x Bearer abc\n'), 13)
  })
})
