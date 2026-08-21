import assert from 'node:assert/strict'
import test from 'node:test'
import { fitMenuToViewport } from './session-menu-position.ts'

test('context menu stays at pointer when it fits', () => {
  assert.deepEqual(
    fitMenuToViewport({ x: 30, y: 40 }, { width: 180, height: 220 }, { width: 800, height: 600 }),
    { x: 30, y: 40 },
  )
})

test('context menu flips left/up and keeps a viewport margin', () => {
  assert.deepEqual(
    fitMenuToViewport({ x: 790, y: 590 }, { width: 180, height: 220 }, { width: 800, height: 600 }),
    { x: 610, y: 370 },
  )
  assert.deepEqual(
    fitMenuToViewport({ x: 4, y: 4 }, { width: 180, height: 220 }, { width: 800, height: 600 }),
    { x: 8, y: 8 },
  )
})
