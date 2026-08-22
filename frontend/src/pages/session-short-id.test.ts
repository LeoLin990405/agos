import assert from 'node:assert/strict'
import test from 'node:test'
import { shortSessionRef } from './session-short-id.ts'

test('shortSessionRef skips the session- prefix so 62 parents stay distinct', () => {
  const parents = Array.from({ length: 62 }, (_, i) => {
    const hex = i.toString(16).padStart(8, '0')
    return `session-${hex}-1111-2222-3333-444444444444`
  })
  const shorts = parents.map(shortSessionRef)
  assert.equal(new Set(shorts).size, 62)
  assert.equal(shorts[0], '00000000')
  assert.equal(shorts[61], '0000003d')
  assert.ok(shorts.every((s) => s !== 'session-'))
})

test('the old slice(0, 8) collapse is the bug this helper exists to stop', () => {
  const a = 'session-aaaaaaaa-1111-2222-3333-444444444444'
  const b = 'session-bbbbbbbb-1111-2222-3333-444444444444'
  assert.equal(a.slice(0, 8), 'session-')
  assert.equal(b.slice(0, 8), 'session-')
  assert.equal(shortSessionRef(a), 'aaaaaaaa')
  assert.equal(shortSessionRef(b), 'bbbbbbbb')
  assert.notEqual(shortSessionRef(a), shortSessionRef(b))
})

test('bare uuid and session-prefixed uuid share the same discriminant', () => {
  const uuid = 'ec978a30-1234-5678-9abc-def012345678'
  assert.equal(shortSessionRef(uuid), 'ec978a30')
  assert.equal(shortSessionRef(`session-${uuid}`), 'ec978a30')
})
