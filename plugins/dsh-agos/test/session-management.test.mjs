import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, rmdir, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import test from 'node:test'

import {
  apply, createAgosSessionManager, createAgosSessionRouteHandlers, overviewSessions,
  projectionCacheTableFromContext, pruneProjectionCacheFromContext, reconcileProjectionCache,
} from '../lib/index.js'

const FIXED_NOW = new Date(2026, 7, 21, 9, 30, 0)
const PROJECT = '--fixture-project--'

async function exists(path) {
  try { await stat(path); return true } catch (error) {
    if (error && error.code === 'ENOENT') return false
    throw error
  }
}

async function fixture(t, options = {}) {
  const dshRoot = await mkdtemp(join(tmpdir(), 'dsh-agos-session-test-'))
  assert.ok(dshRoot.startsWith(tmpdir()))
  t.after(async () => { await rm(dshRoot, { recursive: true, force: true }) })
  const sessionsRoot = join(dshRoot, 'sessions')
  await mkdir(join(sessionsRoot, PROJECT), { recursive: true })
  const manager = createAgosSessionManager({
    dshRoot,
    now: () => new Date(FIXED_NOW),
    readRunning: options.readRunning ?? (async () => ({ available: true, running: false })),
    readAttached: options.readAttached ?? (async () => ({ available: true, attached: false })),
    readHostArchived: options.readHostArchived,
    pruneProjectionCache: options.pruneProjectionCache,
    beforeDeleteLog: options.beforeDeleteLog,
    beforeFinalDeleteCheck: options.beforeFinalDeleteCheck,
  })
  return { dshRoot, sessionsRoot, manager, routes: new Map(createAgosSessionRouteHandlers(manager)) }
}

async function makeSession(fx, sessionId, project = PROJECT) {
  const dir = join(fx.sessionsRoot, project, sessionId)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'sentinel.txt'), sessionId)
  return dir
}

async function invoke(routes, path, method, body) {
  const handler = routes.get(path)
  assert.equal(typeof handler, 'function', `missing route ${path}`)
  const payload = body === undefined ? [] : [typeof body === 'string' ? body : JSON.stringify(body)]
  const req = Readable.from(payload)
  req.method = method
  req.url = path
  const response = {
    status: undefined,
    headers: undefined,
    body: undefined,
    writeHead(status, headers) { this.status = status; this.headers = headers },
    end(value) { this.body = value === undefined ? '' : String(value) },
  }
  await handler(req, response)
  return { ...response, json: response.body ? JSON.parse(response.body) : undefined }
}

test('session meta routes are method-strict, atomic, idempotent, concurrent-safe, and host archive is live', async (t) => {
  let hostArchived = ['host-a']
  const fx = await fixture(t, { readHostArchived: async () => ({ archivedSessionIds: hostArchived }) })

  const initial = await invoke(fx.routes, '/api/agos/session-meta', 'GET')
  assert.equal(initial.status, 200)
  assert.deepEqual(initial.json, {
    pinned: [], archived: [], hostArchived: ['host-a'], hostArchivedAvailable: true,
  })
  hostArchived = ['host-b']
  assert.deepEqual((await invoke(fx.routes, '/api/agos/session-meta', 'GET')).json.hostArchived, ['host-b'])

  const wrongGet = await invoke(fx.routes, '/api/agos/session-meta', 'POST', {})
  assert.equal(wrongGet.status, 405)
  assert.equal(wrongGet.headers.allow, 'GET')
  const wrongPost = await invoke(fx.routes, '/api/agos/session-meta/pin', 'GET')
  assert.equal(wrongPost.status, 405)
  assert.equal(wrongPost.headers.allow, 'POST')
  for (const path of ['/api/agos/session-meta/archive', '/api/agos/session/delete']) {
    const wrongMethod = await invoke(fx.routes, path, 'GET')
    assert.equal(wrongMethod.status, 405)
    assert.equal(wrongMethod.headers.allow, 'POST')
  }
  assert.equal((await invoke(fx.routes, '/api/agos/session-meta/pin', 'POST', '{bad')).status, 400)

  const [pinA, pinB, archiveA] = await Promise.all([
    invoke(fx.routes, '/api/agos/session-meta/pin', 'POST', { sessionId: 'session-a', pinned: true }),
    invoke(fx.routes, '/api/agos/session-meta/pin', 'POST', { sessionId: 'session-b', pinned: true }),
    invoke(fx.routes, '/api/agos/session-meta/archive', 'POST', { sessionId: 'session-a', archived: true }),
  ])
  assert.equal(pinA.status, 200)
  assert.equal(pinB.status, 200)
  assert.equal(archiveA.status, 200)
  const afterConcurrent = await fx.manager.get()
  assert.deepEqual(afterConcurrent.pinned, ['session-a', 'session-b'])
  assert.deepEqual(afterConcurrent.archived, ['session-a'])

  const duplicate = await invoke(fx.routes, '/api/agos/session-meta/pin', 'POST', { sessionId: 'session-a', pinned: true })
  assert.equal(duplicate.status, 200)
  assert.deepEqual(duplicate.json.pinned, ['session-a', 'session-b'])
  const archiveDuplicate = await invoke(fx.routes, '/api/agos/session-meta/archive', 'POST', {
    sessionId: 'session-a', archived: true,
  })
  assert.deepEqual(archiveDuplicate.json.archived, ['session-a'])
  await invoke(fx.routes, '/api/agos/session-meta/archive', 'POST', { sessionId: 'session-a', archived: false })
  const unarchiveDuplicate = await invoke(fx.routes, '/api/agos/session-meta/archive', 'POST', {
    sessionId: 'session-a', archived: false,
  })
  assert.deepEqual(unarchiveDuplicate.json.archived, [])
  const stored = JSON.parse(await readFile(fx.manager.paths.metaPath, 'utf8'))
  assert.equal(stored.version, 1)
  assert.deepEqual(stored.pinned, ['session-a', 'session-b'])
  assert.deepEqual(stored.archived, [])
  assert.deepEqual((await readdir(fx.manager.paths.agosRoot)).filter((name) => name.endsWith('.tmp')), [])
})

test('GET session meta soft-degrades when host archive is unavailable', async (t) => {
  const fx = await fixture(t, { readHostArchived: async () => { throw new Error('offline') } })
  assert.deepEqual(await fx.manager.get(), {
    pinned: [], archived: [], hostArchived: [], hostArchivedAvailable: false,
  })
})

test('apply disposes every route and starts reconciliation only once across injection reruns', async () => {
  const registrations = []
  let routeDisposals = 0
  let fiberDisposals = 0
  let readinessFiberDisposals = 0
  let agentFiberDisposals = 0
  let persistenceLists = 0
  let signalReady
  const webServer = {
    register(spec) {
      registrations.push(spec)
      let active = true
      return () => {
        assert.equal(active, true, `route ${spec.path} disposed twice`)
        active = false
        routeDisposals += 1
      }
    },
  }
  const child = {
    agents: new Map(),
    workspaceRegistry: { archivedSessionIds: new Set() },
    logger: { info() {}, warn() {} },
    get(service) { return service === 'webServer' ? webServer : undefined },
    inject(dependencies, callback) {
      if (dependencies.length === 1 && dependencies[0] === 'agents') {
        const disposeObserver = callback({ agents: { list: () => [] }, get: () => undefined })
        return () => {
          agentFiberDisposals += 1
          if (typeof disposeObserver === 'function') disposeObserver()
        }
      }
      if (dependencies.length === 1 && dependencies[0] === 'llm') {
        return () => {}
      }
      assert.deepEqual(dependencies, ['sessionPersistence', 'storageDomain'])
      signalReady = callback
      return () => { readinessFiberDisposals += 1 }
    },
  }
  const ready = {
    sessionPersistence: { async list() { persistenceLists += 1; return [] } },
    storageDomain: {
      get(name) {
        assert.equal(name, 'session_projcache')
        return { table: () => ({
          keys: () => [][Symbol.iterator](),
          update: async (_id, transform) => transform(undefined),
          put: async () => undefined,
          delete: async () => false,
        }) }
      },
    },
    logger: { info() {}, warn() {} },
  }
  const ctx = {
    inject(dependencies, callback) {
      assert.deepEqual(dependencies, ['webServer'])
      const disposeFiber = callback(child)
      assert.equal(typeof disposeFiber, 'function')
      let active = true
      return () => {
        if (!active) return
        active = false
        fiberDisposals += 1
        disposeFiber()
      }
    },
  }

  const dispose = apply(ctx)
  assert.equal(typeof dispose, 'function')
  assert.equal(registrations.length, 14)
  assert.equal(persistenceLists, 0)
  // Simulate Cordis satisfying the nested dependency injection after the
  // web routes are already live, then replacing a dependency implementation.
  signalReady(ready)
  signalReady(ready)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(persistenceLists, 1)
  const routePaths = [
    '/agos',
    '/api/agos/skills',
    '/api/agos/skills/draft',
    '/api/agos/skills/studio',
    '/api/agos/skills/description',
    '/api/agos/skills/evolve',
    '/api/agos/overview',
    '/api/agos/session-meta',
    '/api/agos/session-meta/pin',
    '/api/agos/session-meta/archive',
    '/api/agos/session-memory',
    '/api/agos/session/delete',
    '/api/agos/yolo-decisions',
    '/api/agos/session-trash',
  ]
  assert.equal(registrations.length, 14)
  assert.deepEqual(registrations.map((entry) => entry.path), routePaths)
  dispose()
  dispose()
  assert.equal(fiberDisposals, 1)
  assert.equal(readinessFiberDisposals, 1)
  assert.equal(agentFiberDisposals, 1)
  assert.equal(routeDisposals, 14)
})

test('delete normally moves the whole session directory and appends an audit row', async (t) => {
  const fx = await fixture(t)
  const source = await makeSession(fx, 'session-normal')
  const result = await invoke(fx.routes, '/api/agos/session/delete', 'POST', { sessionId: 'session-normal' })
  const expected = join(await realpath(join(fx.dshRoot, 'sessions-trash-20260821', PROJECT)), 'session-normal')
  assert.equal(result.status, 200)
  assert.equal(result.json.trashedTo, expected)
  assert.equal(await exists(source), false)
  assert.equal(await readFile(join(expected, 'sentinel.txt'), 'utf8'), 'session-normal')
  const row = JSON.parse((await readFile(fx.manager.paths.deleteLogPath, 'utf8')).trim())
  assert.equal(row.sessionId, 'session-normal')
  assert.equal(row.trashedTo, expected)
  assert.equal(row.projcachePruned, false)
  assert.equal(row.projcacheReason, 'unavailable')
})

test('delete prunes projcache after move and records success before the audit hook', async (t) => {
  const order = []
  let source
  const fx = await fixture(t, {
    pruneProjectionCache: async (sessionId) => {
      order.push('prune')
      assert.equal(sessionId, 'session-pruned')
      assert.equal(await exists(source), false)
      return { pruned: true }
    },
    beforeDeleteLog: async (record) => {
      order.push('audit')
      assert.equal(record.projcachePruned, true)
      assert.equal('projcacheReason' in record, false)
    },
  })
  source = await makeSession(fx, 'session-pruned')
  const result = await invoke(fx.routes, '/api/agos/session/delete', 'POST', { sessionId: 'session-pruned' })
  assert.equal(result.status, 200)
  assert.deepEqual(order, ['prune', 'audit'])
  const row = JSON.parse((await readFile(fx.manager.paths.deleteLogPath, 'utf8')).trim())
  assert.equal(row.projcachePruned, true)
})

test('delete keeps the successful move when projcache pruning fails and audits the failure', async (t) => {
  const fx = await fixture(t, {
    pruneProjectionCache: async () => { throw new Error('projection offline\nsecret detail omitted') },
  })
  const source = await makeSession(fx, 'session-prune-soft')
  const result = await invoke(fx.routes, '/api/agos/session/delete', 'POST', { sessionId: 'session-prune-soft' })
  assert.equal(result.status, 200)
  assert.equal(await exists(source), false)
  const row = JSON.parse((await readFile(fx.manager.paths.deleteLogPath, 'utf8')).trim())
  assert.equal(row.projcachePruned, false)
  assert.equal(row.projcacheReason, 'projection offline secret detail omitted')
})

test('delete rejects path-shaped ids and never traverses project/session symlinks', async (t) => {
  const fx = await fixture(t)
  const outside = await mkdtemp(join(tmpdir(), 'dsh-agos-outside-'))
  assert.ok(outside.startsWith(tmpdir()))
  t.after(async () => { await rm(outside, { recursive: true, force: true }) })
  await writeFile(join(outside, 'keep.txt'), 'keep')

  const traversal = await invoke(fx.routes, '/api/agos/session/delete', 'POST', { sessionId: '../../outside' })
  assert.equal(traversal.status, 400)
  assert.equal(traversal.json.code, 'INVALID_SESSION_ID')
  assert.equal(await readFile(join(outside, 'keep.txt'), 'utf8'), 'keep')

  const linkedProjectTarget = join(outside, 'linked-project')
  await mkdir(join(linkedProjectTarget, 'session-via-project'), { recursive: true })
  await symlink(linkedProjectTarget, join(fx.sessionsRoot, 'linked-project'))
  const projectLink = await invoke(fx.routes, '/api/agos/session/delete', 'POST', { sessionId: 'session-via-project' })
  assert.equal(projectLink.status, 404)
  assert.equal(await exists(join(linkedProjectTarget, 'session-via-project')), true)

  const sessionLinkTarget = join(outside, 'session-target')
  await mkdir(sessionLinkTarget)
  await symlink(sessionLinkTarget, join(fx.sessionsRoot, PROJECT, 'session-link'))
  const sessionLink = await invoke(fx.routes, '/api/agos/session/delete', 'POST', { sessionId: 'session-link' })
  assert.equal(sessionLink.status, 403)
  assert.equal(sessionLink.json.code, 'SESSION_PATH_ESCAPE')
  assert.equal(await exists(sessionLinkTarget), true)
})

test('delete rejects a sessions root symlink even when it contains a matching directory', async (t) => {
  const dshRoot = await mkdtemp(join(tmpdir(), 'dsh-agos-root-link-test-'))
  const outside = await mkdtemp(join(tmpdir(), 'dsh-agos-root-link-outside-'))
  assert.ok(dshRoot.startsWith(tmpdir()) && outside.startsWith(tmpdir()))
  t.after(async () => {
    await rm(dshRoot, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  })
  const target = join(outside, PROJECT, 'session-root-link')
  await mkdir(target, { recursive: true })
  await symlink(outside, join(dshRoot, 'sessions'))
  const manager = createAgosSessionManager({
    dshRoot,
    now: () => new Date(FIXED_NOW),
    readRunning: async () => ({ available: true, running: false }),
    readAttached: async () => ({ available: true, attached: false }),
  })
  const routes = new Map(createAgosSessionRouteHandlers(manager))

  const result = await invoke(routes, '/api/agos/session/delete', 'POST', { sessionId: 'session-root-link' })
  assert.equal(result.status, 403)
  assert.equal(result.json.code, 'SESSION_ROOT_INVALID')
  assert.equal(await exists(target), true)
})

test('delete rejects trash root and project symlinks without moving the source', async (t) => {
  await t.test('trash root points back into sessions', async (child) => {
    const fx = await fixture(child)
    const source = await makeSession(fx, 'session-trash-root-link')
    await symlink(fx.sessionsRoot, join(fx.dshRoot, 'sessions-trash-20260821'))
    const result = await invoke(fx.routes, '/api/agos/session/delete', 'POST', { sessionId: 'session-trash-root-link' })
    assert.equal(result.status, 403)
    assert.equal(result.json.code, 'TRASH_PATH_INVALID')
    assert.equal(await exists(source), true)
  })

  await t.test('trash root points at another .dsh directory', async (child) => {
    const fx = await fixture(child)
    const source = await makeSession(fx, 'session-trash-other-link')
    const other = join(fx.dshRoot, 'other')
    await mkdir(other)
    await symlink(other, join(fx.dshRoot, 'sessions-trash-20260821'))
    const result = await invoke(fx.routes, '/api/agos/session/delete', 'POST', { sessionId: 'session-trash-other-link' })
    assert.equal(result.status, 403)
    assert.equal(result.json.code, 'TRASH_PATH_INVALID')
    assert.equal(await exists(source), true)
  })

  await t.test('project trash points at a sibling directory', async (child) => {
    const fx = await fixture(child)
    const source = await makeSession(fx, 'session-trash-project-link')
    const trash = join(fx.dshRoot, 'sessions-trash-20260821')
    const other = join(trash, 'other-project')
    await mkdir(other, { recursive: true })
    await symlink(other, join(trash, PROJECT))
    const result = await invoke(fx.routes, '/api/agos/session/delete', 'POST', { sessionId: 'session-trash-project-link' })
    assert.equal(result.status, 403)
    assert.equal(result.json.code, 'TRASH_PROJECT_INVALID')
    assert.equal(await exists(source), true)
  })
})

test('delete rejects a running session and leaves its directory untouched', async (t) => {
  const fx = await fixture(t, {
    readRunning: async (id) => ({ available: true, running: id === 'session-running' }),
  })
  const source = await makeSession(fx, 'session-running')
  const result = await invoke(fx.routes, '/api/agos/session/delete', 'POST', { sessionId: 'session-running' })
  assert.equal(result.status, 409)
  assert.equal(result.json.code, 'SESSION_RUNNING')
  assert.match(result.json.error, /请先中止/)
  assert.equal(await exists(source), true)
})

test('delete fails closed for an attached idle session before projection pruning', async (t) => {
  let pruneCalls = 0
  const fx = await fixture(t, {
    readRunning: async () => ({ available: true, running: false }),
    readAttached: async (id) => ({ available: true, attached: id === 'session-live-idle' }),
    pruneProjectionCache: async () => { pruneCalls += 1; return { pruned: true } },
  })
  const source = await makeSession(fx, 'session-live-idle')
  const result = await invoke(fx.routes, '/api/agos/session/delete', 'POST', { sessionId: 'session-live-idle' })
  assert.equal(result.status, 409)
  assert.equal(result.json.code, 'SESSION_LIVE')
  assert.equal(await exists(source), true)
  assert.equal(pruneCalls, 0)
})

test('delete catches reattach after target preparation with a final check immediately before rename', async (t) => {
  let checks = 0
  let attached = false
  let reservedTarget
  const fx = await fixture(t, {
    readAttached: async () => { checks += 1; return { available: true, attached } },
    beforeFinalDeleteCheck: async () => {
      reservedTarget = join(fx.dshRoot, 'sessions-trash-20260821', PROJECT, 'session-attached-race')
      assert.equal(await exists(reservedTarget), true)
      attached = true
    },
  })
  const source = await makeSession(fx, 'session-attached-race')
  const result = await invoke(fx.routes, '/api/agos/session/delete', 'POST', { sessionId: 'session-attached-race' })
  assert.equal(result.status, 409)
  assert.equal(result.json.code, 'SESSION_LIVE')
  assert.equal(checks, 2)
  assert.equal(await exists(source), true)
  assert.equal(await exists(reservedTarget), false)
})

test('delete rejects a trash target replaced during final live checks and preserves the replacement', async (t) => {
  let reservedTarget
  let replacementInstalled = false
  const fx = await fixture(t, {
    beforeFinalDeleteCheck: async (candidate) => { reservedTarget = candidate },
    readAttached: async () => {
      // The first call is the initial live check. On the final call, replace
      // the reserved empty directory while that async check is in flight.
      if (reservedTarget && !replacementInstalled) {
        await rmdir(reservedTarget)
        await writeFile(reservedTarget, 'external replacement')
        replacementInstalled = true
      }
      return { available: true, attached: false }
    },
  })
  const source = await makeSession(fx, 'session-target-final-race')

  const result = await invoke(fx.routes, '/api/agos/session/delete', 'POST', {
    sessionId: 'session-target-final-race',
  })

  assert.equal(result.status, 409)
  assert.equal(result.json.code, 'TRASH_TARGET_RACED')
  assert.equal(replacementInstalled, true)
  assert.equal(await exists(source), true)
  assert.equal(await readFile(reservedTarget, 'utf8'), 'external replacement')
})

test('delete maps a trash target removed during final live checks to a race conflict', async (t) => {
  let reservedTarget
  let removed = false
  const fx = await fixture(t, {
    beforeFinalDeleteCheck: async (candidate) => { reservedTarget = candidate },
    readAttached: async () => {
      if (reservedTarget && !removed) {
        await rmdir(reservedTarget)
        removed = true
      }
      return { available: true, attached: false }
    },
  })
  const source = await makeSession(fx, 'session-target-final-missing')

  const result = await invoke(fx.routes, '/api/agos/session/delete', 'POST', {
    sessionId: 'session-target-final-missing',
  })

  assert.equal(result.status, 409)
  assert.equal(result.json.code, 'TRASH_TARGET_RACED')
  assert.equal(removed, true)
  assert.equal(await exists(source), true)
  assert.equal(await exists(reservedTarget), false)
})

test('delete fails closed when running status cannot be checked', async (t) => {
  const fx = await fixture(t, { readRunning: async () => ({ available: false, running: false }) })
  const source = await makeSession(fx, 'session-unknown')
  const result = await invoke(fx.routes, '/api/agos/session/delete', 'POST', { sessionId: 'session-unknown' })
  assert.equal(result.status, 503)
  assert.equal(result.json.code, 'RUNNING_STATUS_UNAVAILABLE')
  assert.equal(await exists(source), true)
})

test('delete preserves an existing trash target and chooses the -2 suffix', async (t) => {
  const fx = await fixture(t)
  await makeSession(fx, 'session-duplicate')
  const occupied = join(fx.dshRoot, 'sessions-trash-20260821', PROJECT, 'session-duplicate')
  await mkdir(occupied, { recursive: true })
  await writeFile(join(occupied, 'keep.txt'), 'older')

  const result = await invoke(fx.routes, '/api/agos/session/delete', 'POST', { sessionId: 'session-duplicate' })
  assert.equal(result.status, 200)
  const canonicalOccupied = join(await realpath(join(fx.dshRoot, 'sessions-trash-20260821', PROJECT)), 'session-duplicate')
  assert.equal(result.json.trashedTo, canonicalOccupied + '-2')
  assert.equal(await readFile(join(occupied, 'keep.txt'), 'utf8'), 'older')
  assert.equal(await readFile(join(occupied + '-2', 'sentinel.txt'), 'utf8'), 'session-duplicate')
})

test('delete treats an existing empty trash directory as occupied', async (t) => {
  const fx = await fixture(t)
  await makeSession(fx, 'session-empty-target')
  const occupied = join(fx.dshRoot, 'sessions-trash-20260821', PROJECT, 'session-empty-target')
  await mkdir(occupied, { recursive: true })

  const result = await invoke(fx.routes, '/api/agos/session/delete', 'POST', { sessionId: 'session-empty-target' })
  assert.equal(result.status, 200)
  assert.equal(await exists(occupied), true)
  assert.equal(await readFile(join(occupied + '-2', 'sentinel.txt'), 'utf8'), 'session-empty-target')
})

test('delete removes the id from pinned and archived metadata', async (t) => {
  const fx = await fixture(t)
  await makeSession(fx, 'session-meta')
  await fx.manager.pin('session-meta', true)
  await fx.manager.pin('session-keep', true)
  await fx.manager.archive('session-meta', true)

  const result = await invoke(fx.routes, '/api/agos/session/delete', 'POST', { sessionId: 'session-meta' })
  assert.equal(result.status, 200)
  const meta = await fx.manager.get()
  assert.deepEqual(meta.pinned, ['session-keep'])
  assert.deepEqual(meta.archived, [])
})

test('delete compensates the move and metadata if audit append fails', async (t) => {
  const fx = await fixture(t)
  const source = await makeSession(fx, 'session-rollback')
  await fx.manager.pin('session-rollback', true)
  await mkdir(fx.manager.paths.deleteLogPath)

  const result = await invoke(fx.routes, '/api/agos/session/delete', 'POST', { sessionId: 'session-rollback' })
  assert.equal(result.status, 403)
  assert.equal(await exists(source), true)
  assert.deepEqual((await fx.manager.get()).pinned, ['session-rollback'])
  assert.equal(await exists(join(fx.dshRoot, 'sessions-trash-20260821', PROJECT, 'session-rollback')), false)
})

test('audit failure restores the exact projection row after directory and metadata rollback', async (t) => {
  const projectionRow = { identity: { createdAt: 42 }, rows: { title: { ver: 1, seq: 1, val: 'kept' } } }
  let restored
  const fx = await fixture(t, {
    pruneProjectionCache: async () => ({
      pruned: true,
      restore: async () => { restored = projectionRow },
    }),
  })
  const source = await makeSession(fx, 'session-projection-rollback')
  await fx.manager.pin('session-projection-rollback', true)
  await mkdir(fx.manager.paths.deleteLogPath)

  const result = await invoke(fx.routes, '/api/agos/session/delete', 'POST', {
    sessionId: 'session-projection-rollback',
  })
  assert.equal(result.status, 403)
  assert.equal(await exists(source), true)
  assert.deepEqual((await fx.manager.get()).pinned, ['session-projection-rollback'])
  assert.equal(restored, projectionRow)
})

test('projection restore failure is explicit after directory and metadata compensation', async (t) => {
  const fx = await fixture(t, {
    pruneProjectionCache: async () => ({
      pruned: true,
      restore: async () => { throw new Error('put rejected') },
    }),
  })
  const source = await makeSession(fx, 'session-projection-restore-fails')
  await fx.manager.pin('session-projection-restore-fails', true)
  await mkdir(fx.manager.paths.deleteLogPath)

  const result = await invoke(fx.routes, '/api/agos/session/delete', 'POST', {
    sessionId: 'session-projection-restore-fails',
  })
  assert.equal(result.status, 500)
  assert.match(result.json.error, /投影缓存恢复失败: put rejected/)
  assert.equal(await exists(source), true)
  assert.deepEqual((await fx.manager.get()).pinned, ['session-projection-restore-fails'])
})

test('delete.log symlink is never followed and delete is fully compensated', async (t) => {
  const fx = await fixture(t)
  const source = await makeSession(fx, 'session-log-link')
  await fx.manager.pin('session-log-link', true)
  const external = join(fx.dshRoot, 'external-log.txt')
  await writeFile(external, 'do-not-touch')
  await symlink(external, fx.manager.paths.deleteLogPath)

  const result = await invoke(fx.routes, '/api/agos/session/delete', 'POST', { sessionId: 'session-log-link' })
  assert.equal(result.status, 403)
  assert.equal(result.json.code, 'DELETE_LOG_PATH_INVALID')
  assert.equal(await readFile(external, 'utf8'), 'do-not-touch')
  assert.equal(await exists(source), true)
  assert.deepEqual((await fx.manager.get()).pinned, ['session-log-link'])
})

test('agosRoot symlink is rejected before any session move', async (t) => {
  const dshRoot = await mkdtemp(join(tmpdir(), 'dsh-agos-meta-root-link-'))
  const external = await mkdtemp(join(tmpdir(), 'dsh-agos-meta-root-outside-'))
  assert.ok(dshRoot.startsWith(tmpdir()) && external.startsWith(tmpdir()))
  t.after(async () => {
    await rm(dshRoot, { recursive: true, force: true })
    await rm(external, { recursive: true, force: true })
  })
  const source = join(dshRoot, 'sessions', PROJECT, 'session-agos-link')
  await mkdir(source, { recursive: true })
  await writeFile(join(external, 'keep.txt'), 'keep')
  await symlink(external, join(dshRoot, 'agos'))
  const manager = createAgosSessionManager({
    dshRoot,
    now: () => new Date(FIXED_NOW),
    readRunning: async () => ({ available: true, running: false }),
    readAttached: async () => ({ available: true, attached: false }),
  })
  const routes = new Map(createAgosSessionRouteHandlers(manager))
  const result = await invoke(routes, '/api/agos/session/delete', 'POST', { sessionId: 'session-agos-link' })
  assert.equal(result.status, 403)
  assert.equal(result.json.code, 'AGOS_ROOT_INVALID')
  assert.equal(await exists(source), true)
  assert.equal(await readFile(join(external, 'keep.txt'), 'utf8'), 'keep')
})

test('dshRoot symlink is rejected before creating trash or metadata', async (t) => {
  const parent = await mkdtemp(join(tmpdir(), 'dsh-agos-dsh-root-link-'))
  assert.ok(parent.startsWith(tmpdir()))
  t.after(async () => { await rm(parent, { recursive: true, force: true }) })
  const actualRoot = join(parent, 'actual-dsh')
  const linkedRoot = join(parent, 'linked-dsh')
  const source = join(actualRoot, 'sessions', PROJECT, 'session-dsh-link')
  await mkdir(source, { recursive: true })
  await writeFile(join(source, 'sentinel.txt'), 'keep')
  await symlink(actualRoot, linkedRoot)
  const manager = createAgosSessionManager({
    dshRoot: linkedRoot,
    now: () => new Date(FIXED_NOW),
    readRunning: async () => ({ available: true, running: false }),
    readAttached: async () => ({ available: true, attached: false }),
  })
  const routes = new Map(createAgosSessionRouteHandlers(manager))

  const result = await invoke(routes, '/api/agos/session/delete', 'POST', { sessionId: 'session-dsh-link' })
  assert.equal(result.status, 403)
  assert.equal(result.json.code, 'DSH_ROOT_INVALID')
  assert.equal(await readFile(join(source, 'sentinel.txt'), 'utf8'), 'keep')
  assert.equal(await exists(join(actualRoot, 'sessions-trash-20260821')), false)
  assert.equal(await exists(join(actualRoot, 'agos')), false)
})

test('rollback never overwrites a source path rebuilt after the move', async (t) => {
  let source
  const fx = await fixture(t, {
    beforeDeleteLog: async () => {
      await mkdir(source)
      await writeFile(join(source, 'new.txt'), 'rebuilt')
      throw new Error('injected audit failure')
    },
  })
  source = await makeSession(fx, 'session-rebuilt')
  await fx.manager.pin('session-rebuilt', true)

  const result = await invoke(fx.routes, '/api/agos/session/delete', 'POST', { sessionId: 'session-rebuilt' })
  assert.equal(result.status, 500)
  assert.match(result.json.error, /补偿未完整完成/)
  assert.equal(await readFile(join(source, 'new.txt'), 'utf8'), 'rebuilt')
  const trashed = join(fx.dshRoot, 'sessions-trash-20260821', PROJECT, 'session-rebuilt')
  assert.equal(await readFile(join(trashed, 'sentinel.txt'), 'utf8'), 'session-rebuilt')
  assert.deepEqual((await fx.manager.get()).pinned, [])
})

test('delete supports the host path encoding for unicode and tilde session ids', async (t) => {
  const fx = await fixture(t)
  const sessionId = '会话~一'
  const encoded = '~4F1A~8BDD~007E~4E00'
  const source = await makeSession(fx, encoded)
  const result = await invoke(fx.routes, '/api/agos/session/delete', 'POST', { sessionId })
  assert.equal(result.status, 200)
  assert.equal(await exists(source), false)
  assert.equal(await readFile(join(result.json.trashedTo, 'sentinel.txt'), 'utf8'), encoded)
})

test('delete rejects duplicate exact session directory matches', async (t) => {
  const fx = await fixture(t)
  const first = await makeSession(fx, 'session-duplicate-source')
  const second = await makeSession(fx, 'session-duplicate-source', '--second-project--')
  const result = await invoke(fx.routes, '/api/agos/session/delete', 'POST', { sessionId: 'session-duplicate-source' })
  assert.equal(result.status, 409)
  assert.equal(result.json.code, 'SESSION_DUPLICATE')
  assert.equal(await exists(first), true)
  assert.equal(await exists(second), true)
})

test('overview sessions prefers persistence and labels the projcache fallback', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-agos-overview-test-'))
  assert.ok(root.startsWith(tmpdir()))
  t.after(async () => { await rm(root, { recursive: true, force: true }) })
  const projcachePath = join(root, 'session_projcache.json')
  await writeFile(projcachePath, JSON.stringify({
    tables: { sessions: {
      stale: { identity: { createdAt: 5 } },
      older: { identity: { createdAt: 2 } },
    } },
  }))

  assert.deepEqual(await overviewSessions({
    sessionPersistence: { list: async () => [{ id: 'real-a', createdAt: 10 }, { id: 'real-b', createdAt: 20 }] },
    projcachePath,
  }), { total: 2, latestAt: 20, source: 'persistence' })

  assert.deepEqual(await overviewSessions({
    sessionPersistence: { list: async () => { throw new Error('offline') } },
    projcachePath,
  }), { total: 2, latestAt: 5, source: 'projcache' })
})

test('projection cache resolver uses the already-open diagnostic domain only', () => {
  const table = {
    keys() { return [][Symbol.iterator]() },
    update: async (_id, transform) => transform(undefined),
    put: async () => undefined,
    delete: async () => false,
  }
  let requested
  const ctx = {
    storageDomain: {
      get(name) {
        requested = name
        return { table: (tableName) => tableName === 'sessions' ? table : undefined }
      },
      open() { assert.fail('must not open an already-owned domain') },
    },
  }
  assert.equal(projectionCacheTableFromContext(ctx), table)
  assert.equal(requested, 'session_projcache')
})

test('production projection pruner captures a queued current row, deletes, and restores it exactly', async () => {
  const row = { identity: { createdAt: 7 }, rows: { title: { ver: 1, seq: 2, val: 'same object' } } }
  const records = new Map()
  let chain = Promise.resolve()
  const enqueue = (operation) => {
    const result = chain.then(operation)
    chain = result.then(() => undefined, () => undefined)
    return result
  }
  const table = {
    keys: () => records.keys(),
    get: (id) => records.get(id),
    update(id, transform) {
      return enqueue(() => {
        if (!records.has(id)) throw Object.assign(new Error('missing'), { code: 'missing-key' })
        const value = transform(records.get(id))
        records.set(id, value)
        return value
      })
    },
    delete(id) { return enqueue(() => records.delete(id)) },
    put(id, value) { return enqueue(() => { records.set(id, value) }) },
  }
  const pendingPut = table.put('opaque-id', row)
  // This is the counterexample for the old synchronous get: the durable/in-
  // memory row is still absent while a newer put is already queued.
  assert.equal(table.get('opaque-id'), undefined)
  const result = await pruneProjectionCacheFromContext({
    storageDomain: { get: () => ({ table: () => table }) },
  }, 'opaque-id')
  await pendingPut
  assert.equal(result.pruned, true)
  assert.equal(records.has('opaque-id'), false)
  await result.restore()
  assert.equal(records.get('opaque-id'), row)
})

test('startup reconciliation only prunes non-authoritative cache rows, caps at 200, and logs each attempt', async () => {
  const records = new Set(['keep', ...Array.from({ length: 205 }, (_, index) => `ghost-${index}`)])
  const deleted = []
  const info = []
  const result = await reconcileProjectionCache({
    sessionPersistence: { list: async () => [{ id: 'keep' }] },
    table: {
      keys: () => records.keys(),
      async delete(id) { deleted.push(id); return records.delete(id) },
    },
    logger: { info: (line) => info.push(line), warn() {} },
  })
  assert.equal(deleted.includes('keep'), false)
  assert.equal(deleted.length, 200)
  assert.equal(info.length, 200)
  assert.deepEqual(result, { pruned: 200, failed: 0, considered: 200, remaining: 5 })
})

test('startup reconciliation compares opaque ids exactly', async () => {
  const records = new Set(['foo', 'session-foo'])
  const deleted = []
  const result = await reconcileProjectionCache({
    sessionPersistence: { list: async () => [{ id: 'foo' }] },
    table: {
      keys: () => records.keys(),
      async delete(id) { deleted.push(id); return records.delete(id) },
    },
    logger: { info() {}, warn() {} },
  })
  assert.deepEqual(deleted, ['session-foo'])
  assert.equal(records.has('foo'), true)
  assert.deepEqual(result, { pruned: 1, failed: 0, considered: 1, remaining: 0 })
})

test('startup reconciliation protects a nonempty cache from empty or failed authority', async () => {
  for (const persistence of [
    { list: async () => [] },
    { list: async () => { throw new Error('disk offline') } },
  ]) {
    const deleted = []
    const warnings = []
    const result = await reconcileProjectionCache({
      sessionPersistence: persistence,
      table: {
        keys: () => ['cached'].values(),
        async delete(id) { deleted.push(id); return true },
      },
      logger: { info() {}, warn: (line) => warnings.push(line) },
    })
    assert.deepEqual(deleted, [])
    assert.equal(result.pruned, 0)
    assert.equal(warnings.length, 1)
  }
})
