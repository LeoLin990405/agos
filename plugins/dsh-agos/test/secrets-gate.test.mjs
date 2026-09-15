import assert from 'node:assert/strict'
import test from 'node:test'

import {
  classifySecret,
  highEntropyToken,
  isSensitiveText,
  REDACTED,
  scrubSecrets,
  scrubString,
  SECRET_REDACT_COPY,
  SECRET_REFUSE_COPY,
} from '../lib/secrets-gate.js'

const LONG_NON_SECRET = 'x'.repeat(100 * 1024)
const FAKE_SK = 'sk-abcdefghijklmnopQRST'
const FAKE_HEX = '9f86d081884c7d659a2feaa0'
const FAKE_JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJmaXh0dXJlIn0.fakefakefakefakefake'
const FAKE_AKIA = 'AKIAIOSFODNN7EXAMPLE'
const FAKE_PEM = '-----BEGIN RSA PRIVATE KEY-----'

test('one classifier, two dispositions: refuse persist vs redact ledger', () => {
  assert.equal(isSensitiveText('密码用 SuperSecret123!'), true)
  assert.equal(SECRET_REFUSE_COPY.includes('拒绝落盘'), true)
  assert.equal(SECRET_REDACT_COPY.includes('擦除'), true)
  assert.deepEqual(classifySecret('plain port 3091').reasons, [])
  assert.equal(isSensitiveText('写一条按月汇总 GMV 的 SQL'), false)
})

test('synthetic KEY / TOKEN / PASSWORD classify and redact without keeping the fragment', () => {
  assert.equal(isSensitiveText('API_KEY=fake-test-value-001'), true)
  assert.equal(isSensitiveText('SESSION_TOKEN=fake-session-token'), true)
  assert.equal(isSensitiveText('password is SuperSecret123 for NAS'), true)
  assert.equal(isSensitiveText(`use ${FAKE_SK} then Bearer opaque-token-value`), true)
  assert.equal(scrubString(`use ${FAKE_SK} then Bearer opaque-token-value`), `use ${REDACTED} then Bearer ${REDACTED}`)
  assert.equal(scrubString('API_KEY=very-secret'), `API_KEY=${REDACTED}`)
  assert.equal(scrubString('SESSION_TOKEN="quoted-secret"'), `SESSION_TOKEN=${REDACTED}`)
  assert.equal(scrubString("PASSWORD='quoted-secret'"), `PASSWORD=${REDACTED}`)
  assert.equal(scrubString('see ~/.config/cc-model-secrets.env'), 'see ~/.config/cc-model-secrets.env')
})

test('structural shapes: PEM, URL password, vendor token, AKIA, JWT', () => {
  assert.equal(isSensitiveText(FAKE_PEM), true)
  assert.equal(isSensitiveText('https://user:fakepass@example.test/path'), true)
  assert.equal(isSensitiveText('ghp-abcdefghijklmnopqrstuvwxyz0123'), true)
  assert.equal(isSensitiveText(FAKE_AKIA), true)
  assert.equal(isSensitiveText(FAKE_JWT), true)
  assert.equal(classifySecret(FAKE_JWT).reasons.includes('pattern'), true)
})

test('high-entropy token is refused; low-entropy long run is not', () => {
  assert.equal(highEntropyToken(FAKE_HEX), true)
  assert.equal(isSensitiveText(`当前项目校验值是 ${FAKE_HEX}`), true)
  assert.equal(highEntropyToken(LONG_NON_SECRET), false)
  assert.equal(isSensitiveText(LONG_NON_SECRET), false)
  assert.deepEqual(classifySecret('plain port 3091').reasons, [])
})

test('near-matches on long contiguous runs are not secrets', () => {
  const near = [
    'TOKE' + 'x'.repeat(4096),
    'SECRE' + 'x'.repeat(4096),
    'passwor' + 'x'.repeat(4096),
    'AP_KEY' + 'x'.repeat(1024),
    'sk-short',
    'Bearer',
    'eyJonlyone.segmenthere',
  ]
  for (const value of near) {
    assert.equal(isSensitiveText(value), false, value.slice(0, 24))
    assert.equal(scrubString(value), value, value.slice(0, 24))
  }
})

test('Unicode keywords, fullwidth punctuation, and newlines still classify', () => {
  assert.equal(isSensitiveText('密码用 SuperSecret123!'), true)
  assert.equal(isSensitiveText('口令是 fake-pass-001'), true)
  assert.equal(isSensitiveText('密钥为 fake-key-001'), true)
  assert.equal(isSensitiveText('令牌：abc-fake-token'), true)
  assert.equal(isSensitiveText('TOKEN=\nfake-value-ok'), true)
  assert.equal(isSensitiveText('password\n\nSuperSecret123'), true)
  assert.equal(scrubString('API_KEY=\nfake-value-ok'), `API_KEY=\n${REDACTED}`)
})

test('recursive objects redact leaves and drop cycles; paths stay visible', () => {
  const cycle = { prompt: `use ${FAKE_SK}`, nested: ['API_KEY=very-secret', 'see ~/.config/cc-model-secrets.env'] }
  cycle.self = cycle
  const value = scrubSecrets(cycle)
  assert.equal(value.prompt, `use ${REDACTED}`)
  assert.deepEqual(value.nested, [`API_KEY=${REDACTED}`, 'see ~/.config/cc-model-secrets.env'])
  assert.equal(value.self, undefined)
  assert.equal(scrubSecrets(null), null)
  assert.equal(scrubSecrets(12), 12)
  assert.deepEqual(scrubSecrets(['Bearer opaque-token-value']), [`Bearer ${REDACTED}`])
})

test('original 100KB contiguous scenario stays a non-secret identity scrub', () => {
  assert.equal(LONG_NON_SECRET.length, 100 * 1024)
  const classified = classifySecret(LONG_NON_SECRET)
  assert.equal(classified.sensitive, false)
  assert.deepEqual(classified.reasons, [])
  assert.equal(scrubString(LONG_NON_SECRET), LONG_NON_SECRET)
  assert.equal(scrubSecrets(LONG_NON_SECRET), LONG_NON_SECRET)
})

test('100KB pad still finds an embedded fake assignment and redacts only that value', () => {
  const pad = 'x'.repeat(50 * 1024)
  const text = `${pad}\nAPI_KEY=fake-embedded-value\n${pad}`
  assert.equal(isSensitiveText(text), true)
  const scrubbed = scrubString(text)
  assert.equal(scrubbed.includes('fake-embedded-value'), false)
  assert.equal(scrubbed.includes(`API_KEY=${REDACTED}`), true)
  assert.equal(scrubbed.startsWith(pad), true)
  assert.equal(scrubbed.endsWith(pad), true)
})

test('repeated keyword near-matches preserve text and still scrub the final credential', () => {
  const repeated = 'token '.repeat(Math.ceil(102400 / 6)).slice(0, 102400)
  assert.equal(scrubString(repeated), repeated)
  assert.equal(scrubString(`${repeated}\nAPI_KEY=fake-tail-value`), `${repeated}\nAPI_KEY=${REDACTED}`)
  const jwtNear = 'x-eyJaaaaaaaaaaaaaaaaaaaa'.repeat(4096)
  assert.equal(isSensitiveText(jwtNear), false)
  assert.equal(scrubString(jwtNear), jwtNear)
})

test('classifier preserves historical compact keywords and short-value separator splits', () => {
  for (const value of ['APIKEY=aaaa', 'ACCESSKEY=aaaa', 'TOKEN=ab', '密码用ab',
    'paſſword=aaaa', 'ſecret=aaaa', 'apiKey=aaaa', 'accesſkey=aaaa',
    'ſcheme://user:aaaa@example.test']) {
    assert.equal(classifySecret(value).reasons.includes('pattern'), true, value)
  }
})

test('known credential structures remain recognized above former regex caps', () => {
  const lowEntropy = 'a'.repeat(4096)
  const samples = [
    `https://user:${lowEntropy}@example.test/path`,
    `${'h'.repeat(256)}://user:aaaa@example.test`,
    `ghp-${lowEntropy}`,
    `sk-${lowEntropy}`,
    `eyJ${lowEntropy}.${lowEntropy}.${lowEntropy}`,
    `-----BEGIN ${'A '.repeat(64)}PRIVATE KEY-----`,
  ]
  for (const value of samples) {
    assert.equal(highEntropyToken(value), false, value.slice(0, 32))
    assert.equal(classifySecret(value).reasons.includes('pattern'), true, value.slice(0, 32))
  }
})

test('quoted assignments discard escaped and unterminated credential fragments', () => {
  const closed = String.raw`PASSWORD="fake\"secret remainder" path=/safe`
  assert.equal(scrubString(closed), `PASSWORD=${REDACTED} path=/safe`)
  const slash = String.raw`PASSWORD="fake\\" path=/safe`
  assert.equal(scrubString(slash), `PASSWORD=${REDACTED} path=/safe`)
  assert.equal(scrubString('PASSWORD="fake secret remainder'), `PASSWORD=${REDACTED}`)
})
