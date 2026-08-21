import assert from 'node:assert/strict'
import test from 'node:test'
import { modalFocusDestination } from './modal-focus.ts'

test('modal focus wraps only at the two Tab boundaries', () => {
  assert.equal(modalFocusDestination(0, 3, true), 2)
  assert.equal(modalFocusDestination(2, 3, false), 0)
  assert.equal(modalFocusDestination(1, 3, false), undefined)
  assert.equal(modalFocusDestination(-1, 0, false), undefined)
})
