import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  CIV_SUBMITTED_COPY,
  CIV_UNAVAILABLE_COPY,
  DESK_COPY,
  deskVoidedSlugs,
  listMemoryDesk,
  normalizeDeskSlug,
  resolveMemorySubmitInvoker,
  writeMemoryDesk,
} from '../lib/memory-desk.js'

test('desk writes are confirm-gated and never claim Fleet Memory', async () => {
  const home = await mkdtemp(join(tmpdir(), 'agos-desk-'))
  const refused = await writeMemoryDesk({
    action: 'promote', sessionId: 's1', itemId: 'i1', kind: 'fact', text: 'web 口在 3091',
  }, { home })
  assert.equal(refused.code, 'CONFIRM_REQUIRED')
  const promoted = await writeMemoryDesk({
    action: 'promote', sessionId: 's1', itemId: 'i1', kind: 'fact', text: 'web 口在 3091', confirm: true,
  }, { home, now: () => new Date('2026-09-07T06:00:00.000Z') })
  assert.equal(promoted.ok, true)
  assert.equal(promoted.recorded.fleetMemory, false)
  assert.equal(promoted.copy, DESK_COPY)
  const voided = await writeMemoryDesk({
    action: 'void', slug: 'Project Memory Graph', confirm: true,
  }, { home, now: () => new Date('2026-09-07T06:01:00.000Z') })
  assert.equal(voided.recorded.slug, 'project-memory-graph')
  const listed = await listMemoryDesk({ home })
  assert.equal(listed.fleetMemory, false)
  assert.equal(listed.promoteCount, 1)
  assert.equal(listed.voidCount, 1)
  assert.deepEqual([...deskVoidedSlugs(listed.voids)], ['project-memory-graph'])
})

test('desk rejects unsafe slugs and unknown kinds', async () => {
  const home = await mkdtemp(join(tmpdir(), 'agos-desk-bad-'))
  const badSlug = await writeMemoryDesk({ action: 'void', slug: '../etc/passwd', confirm: true }, { home })
  assert.equal(badSlug.code, 'INVALID_SLUG')
  const badKind = await writeMemoryDesk({
    action: 'promote', sessionId: 's', itemId: 'i', kind: 'secret', text: 'x', confirm: true,
  }, { home })
  assert.equal(badKind.code, 'INVALID_KIND')
  assert.equal(normalizeDeskSlug('  Foo_Bar  '), 'foo-bar')
})

test('submit stays fail-closed without civ and only marks fleetMemory after accept', async () => {
  const home = await mkdtemp(join(tmpdir(), 'agos-desk-civ-'))
  const unavailable = await writeMemoryDesk({
    action: 'submit',
    slug: 'project_agos_loop',
    type: 'project',
    description: 'AgOS 五档闭环',
    body: '本跳证据条合环。',
    confirm: true,
  }, { home })
  assert.equal(unavailable.code, 'CIV_UNAVAILABLE')
  assert.equal(unavailable.fleetMemory, false)
  assert.equal(unavailable.copy, CIV_UNAVAILABLE_COPY)
  const rejected = await writeMemoryDesk({
    action: 'submit',
    slug: 'project_agos_loop',
    type: 'project',
    description: 'AgOS 五档闭环',
    body: '本跳证据条合环。',
    confirm: true,
  }, { home, invokeMemorySubmit: async () => ({ ok: false, conflict: 'exact' }) })
  assert.equal(rejected.code, 'CIV_REJECTED')
  assert.equal(rejected.fleetMemory, false)
  const accepted = await writeMemoryDesk({
    action: 'submit',
    slug: 'project_agos_loop',
    type: 'project',
    description: 'AgOS 五档闭环',
    body: '本跳证据条合环。',
    sessionId: 's1',
    itemId: 'i1',
    confirm: true,
  }, {
    home,
    now: () => new Date('2026-09-07T08:00:00.000Z'),
    invokeMemorySubmit: async () => ({ ok: true, path: '/tmp/project_agos_loop.md' }),
  })
  assert.equal(accepted.ok, true)
  assert.equal(accepted.fleetMemory, true)
  assert.equal(accepted.copy, CIV_SUBMITTED_COPY)
  const listed = await listMemoryDesk({ home, civAvailable: true })
  assert.equal(listed.fleetMemory, false)
  assert.equal(listed.civAvailable, true)
  assert.equal(listed.submitCount, 1)
  assert.equal(listed.submits[0]?.fleetMemory, true)
})

test('civ invoker stays absent unless memory_submit is actually present', () => {
  assert.equal(resolveMemorySubmitInvoker(undefined), undefined)
  assert.equal(resolveMemorySubmitInvoker({ invoke: async () => ({ ok: true }) }), undefined)
  assert.equal(resolveMemorySubmitInvoker({
    get: () => undefined,
    invoke: async () => ({ ok: true }),
  }), undefined)
  const viaGet = resolveMemorySubmitInvoker({
    get: (name) => name === 'memory_submit' ? { execute: async (args) => args } : undefined,
  })
  assert.equal(typeof viaGet, 'function')
  const viaHas = resolveMemorySubmitInvoker({
    has: (name) => name === 'memory_submit',
    invoke: async (name, args) => ({ name, args }),
  })
  assert.equal(typeof viaHas, 'function')
  const viaList = resolveMemorySubmitInvoker({
    list: () => [{ name: 'memory_submit' }],
    invoke: async (name, args) => ({ name, args }),
  })
  assert.equal(typeof viaList, 'function')
  const viaGetMissThenList = resolveMemorySubmitInvoker({
    get: () => undefined,
    list: () => [{ name: 'memory_submit' }],
    invoke: async (name, args) => ({ name, args }),
  })
  assert.equal(typeof viaGetMissThenList, 'function')
})
