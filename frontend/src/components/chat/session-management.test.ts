import assert from 'node:assert/strict'
import test from 'node:test'
import {
  basenameOfPath,
  fetchSessionMeta,
  formatSessionRelativeTime,
  mergeArchivedSnapshot,
  mergePinnedSnapshot,
  partitionSessions,
  pickFirstVisibleSession,
  setSessionArchived,
  setSessionPinned,
  trashSession,
  type SessionManagementFetch,
} from './session-management.ts'

const jsonResponse = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json' },
})

test('session-meta fetch helpers use the real routes and parse sets defensively', async () => {
  const calls: { path: string, body?: unknown }[] = []
  const fakeFetch: SessionManagementFetch = async (path, init) => {
    calls.push({ path, body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined })
    if (path.endsWith('/delete')) return jsonResponse({ trashedTo: '/fixture/trash/s-1' })
    return jsonResponse({
      pinned: ['s-1', 's-1', 3],
      archived: ['s-2'],
      hostArchived: ['s-host'],
      hostArchivedAvailable: true,
    })
  }

  assert.deepEqual(await fetchSessionMeta(fakeFetch), {
    pinned: ['s-1'], archived: ['s-2'], hostArchived: ['s-host'], hostArchivedAvailable: true,
  })
  await setSessionPinned('s-1', true, fakeFetch)
  await setSessionArchived('s-2', false, fakeFetch)
  assert.deepEqual(await trashSession('s-1', fakeFetch), { trashedTo: '/fixture/trash/s-1' })
  assert.deepEqual(calls, [
    { path: '/api/agos/session-meta', body: undefined },
    { path: '/api/agos/session-meta/pin', body: { sessionId: 's-1', pinned: true } },
    { path: '/api/agos/session-meta/archive', body: { sessionId: 's-2', archived: false } },
    { path: '/api/agos/session/delete', body: { sessionId: 's-1' } },
  ])
})

test('session-meta errors surface backend reason without a real request', async () => {
  await assert.rejects(
    () => trashSession('running', async () => jsonResponse({ error: 'SESSION_RUNNING', message: '运行中，请先中止' }, 409)),
    /运行中，请先中止/,
  )
})

test('session grouping keeps host/own archives hidden and recent sorted', () => {
  const rows = [
    { id: 'recent-old', updatedAt: 10 },
    { id: 'pin-b', updatedAt: 40 },
    { id: 'archive', updatedAt: 50 },
    { id: 'pin-a', updatedAt: 20 },
    { id: 'recent-new', updatedAt: 30 },
  ]
  assert.deepEqual(partitionSessions(rows, ['pin-a', 'pin-b'], new Set(['archive'])), {
    pinned: [rows[3], rows[1]],
    recent: [rows[4], rows[0]],
    archived: [rows[2]],
  })
  assert.equal(basenameOfPath('/Users/leo/project/'), 'project')
  assert.equal(basenameOfPath('C:\\work\\repo'), 'repo')
  assert.equal(formatSessionRelativeTime(1_000, 31_000), '刚刚')
  assert.equal(formatSessionRelativeTime(1_000, 121_000), '2分钟前')
})

test('deleted and archived sessions are never selected as the safe fallback', () => {
  const rows = [{ id: 'deleted' }, { id: 'archived' }, { id: 'visible' }]
  assert.equal(
    pickFirstVisibleSession(rows, new Set(['deleted']), new Set(['archived']))?.id,
    'visible',
  )
  assert.equal(
    pickFirstVisibleSession(rows.slice(0, 2), new Set(['deleted']), new Set(['archived'])),
    undefined,
  )
})

test('pin and archive snapshots merge by field without cross-operation loss', () => {
  const initial = {
    pinned: ['pin-old'],
    archived: ['archive-old'],
    hostArchived: ['host'],
    hostArchivedAvailable: true,
  }
  const afterPin = mergePinnedSnapshot(initial, { pinned: ['pin-new'] })
  const afterArchive = mergeArchivedSnapshot(afterPin, { archived: ['archive-new'] })
  assert.deepEqual(afterArchive, {
    pinned: ['pin-new'],
    archived: ['archive-new'],
    hostArchived: ['host'],
    hostArchivedAvailable: true,
  })
})
