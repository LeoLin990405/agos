import assert from 'node:assert/strict'
import test from 'node:test'
import { failures, isGo, mergeGates, warnings } from '../lib/gate.js'

test('isGo is true unless a check failed', () => {
  assert.equal(isGo({ checks: [{ name: 'a', severity: 'ok' }] }), true)
  assert.equal(isGo({ checks: [{ name: 'a', severity: 'warn' }] }), true)
  assert.equal(isGo({ checks: [{ name: 'a', severity: 'fail' }] }), false)
})

test('mergeGates concatenates checks', () => {
  const merged = mergeGates(
    { checks: [{ name: 'a', severity: 'ok' }] },
    { checks: [{ name: 'b', severity: 'warn' }, { name: 'c', severity: 'fail' }] },
  )
  assert.equal(merged.checks.length, 3)
  assert.equal(failures(merged).length, 1)
  assert.equal(warnings(merged).length, 1)
})
