import assert from 'node:assert/strict'
import test from 'node:test'

import {
  assertHttpBodyBytes,
  InputLimitError,
  MAX_BODY_BYTES,
  MAX_ITEM_CHARS,
  MAX_ITEMS,
  MAX_LABEL_CHARS,
  MAX_TAG_CHARS,
  MAX_TIMEOUT_MS,
  validateFleetItems,
  validateHttpDispatchBody,
} from '../lib/input-limits.js'

function throwsCode(fn, code, status = 400) {
  assert.throws(fn, (error) => {
    assert.equal(error instanceof InputLimitError, true)
    assert.equal(error.code, code)
    assert.equal(error.status, status)
    return true
  })
}

test('shared constants match HTTP dispatch: 512KiB / 32 items / 8000 chars', () => {
  assert.equal(MAX_BODY_BYTES, 512 * 1024)
  assert.equal(MAX_ITEMS, 32)
  assert.equal(MAX_ITEM_CHARS, 8000)
  assert.equal(MAX_TIMEOUT_MS, 3_600_000)
  assert.equal(MAX_LABEL_CHARS, 120)
  assert.equal(MAX_TAG_CHARS, 64)
})

test('validateFleetItems accepts the inclusive bounds and returns the original strings', () => {
  const one = validateFleetItems(['ok'])
  assert.deepEqual(one, ['ok'])
  const padded = ' keep '
  assert.equal(validateFleetItems([padded])[0], padded)
  const full = 'x'.repeat(MAX_ITEM_CHARS)
  const many = Array.from({ length: MAX_ITEMS }, () => full)
  assert.equal(validateFleetItems(many).length, MAX_ITEMS)
  assert.equal(validateFleetItems(many)[0].length, MAX_ITEM_CHARS)
})

test('validateFleetItems rejects count/type/empty/oversize and does not truncate', () => {
  throwsCode(() => validateFleetItems(undefined), 'INVALID_ITEMS')
  throwsCode(() => validateFleetItems([]), 'INVALID_ITEMS')
  throwsCode(() => validateFleetItems(Array.from({ length: MAX_ITEMS + 1 }, () => 'x')), 'INVALID_ITEMS')
  throwsCode(() => validateFleetItems(['']), 'INVALID_ITEM')
  throwsCode(() => validateFleetItems(['   ']), 'INVALID_ITEM')
  throwsCode(() => validateFleetItems([12]), 'INVALID_ITEM')
  const tooLong = 'x'.repeat(MAX_ITEM_CHARS + 1)
  try {
    validateFleetItems([tooLong])
    assert.fail('expected ITEM_TOO_LONG')
  } catch (error) {
    assert.equal(error.code, 'ITEM_TOO_LONG')
    assert.equal(tooLong.length, MAX_ITEM_CHARS + 1)
    assert.equal(error.message.includes(String(MAX_ITEM_CHARS)), true)
  }
})

test('validateHttpDispatchBody shares item limits and rejects extra field errors', () => {
  const ok = validateHttpDispatchBody({ items: ['build'], hosts: ['worker', 'worker'], tag: 'nightly', label: 'batch', timeoutMs: 30 })
  assert.deepEqual(ok.items, ['build'])
  assert.deepEqual(ok.hosts, ['worker'])
  assert.equal(ok.tag, 'nightly')
  assert.equal(ok.wake, true)
  assert.equal(ok.label, 'batch')
  assert.equal(ok.timeoutMs, 30)
  assert.equal(ok.pinned, true)

  const wakeOff = validateHttpDispatchBody({ items: ['x'], wake: false })
  assert.equal(wakeOff.wake, false)
  assert.equal(wakeOff.pinned, false)

  throwsCode(() => validateHttpDispatchBody(null), 'INVALID_BODY')
  throwsCode(() => validateHttpDispatchBody([]), 'INVALID_BODY')
  throwsCode(() => validateHttpDispatchBody({}), 'INVALID_ITEMS')
  throwsCode(() => validateHttpDispatchBody({ items: ['x'.repeat(MAX_ITEM_CHARS + 1)] }), 'ITEM_TOO_LONG')
  throwsCode(() => validateHttpDispatchBody({ items: ['x'], hosts: [] }), 'INVALID_HOSTS')
  throwsCode(() => validateHttpDispatchBody({ items: ['x'], tag: '' }), 'INVALID_TAG')
  throwsCode(() => validateHttpDispatchBody({ items: ['x'], wake: 'yes' }), 'INVALID_WAKE')
  throwsCode(() => validateHttpDispatchBody({ items: ['x'], label: 'x'.repeat(MAX_LABEL_CHARS + 1) }), 'INVALID_LABEL')
  throwsCode(() => validateHttpDispatchBody({ items: ['x'], timeoutMs: 0 }), 'INVALID_TIMEOUT')
  throwsCode(() => validateHttpDispatchBody({ items: ['x'], timeoutMs: MAX_TIMEOUT_MS + 1 }), 'INVALID_TIMEOUT')
})

test('HTTP body byte cap rejects instead of clipping', () => {
  assert.equal(assertHttpBodyBytes(0), 0)
  assert.equal(assertHttpBodyBytes(MAX_BODY_BYTES), MAX_BODY_BYTES)
  throwsCode(() => assertHttpBodyBytes(MAX_BODY_BYTES + 1), 'BODY_TOO_LARGE', 413)
  throwsCode(() => assertHttpBodyBytes(-1), 'INVALID_BODY')
})
