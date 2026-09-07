import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import test from 'node:test'

import {
  bindSessionMemoryObserver, createAgosSessionManager, createAgosSessionRouteHandlers,
} from '../lib/index.js'
import {
  SESSION_MEMORY_LIMITS,
  createSessionMemoryStore,
  encodeSessionMemorySegment,
  extractSessionMemory,
  isDirectUserSource,
  pinSessionMemoryItem,
} from '../lib/session-memory.mjs'

const FIXED = new Date('2026-08-21T08:00:00.000Z')

// W20(2026-08-23)起 user 事件默认带 rpcId(浏览器 / RPC 通道):裸 {kind:'user'} 现在过不了来源门
// (它是子代理派发 prompt / headless 探针的形状,归档实测 89% 的误报来自这里),见 'W20 来源门' 一测。
function user(seq, turn, text, source = { kind: 'user', rpcId: 'fixture' }, content) {
  return {
    type: 'user/message', seq, time: FIXED.getTime() + seq,
    data: { source, content: content ?? [{ type: 'text', text }] },
    _turn: turn,
  }
}

function assistant(seq, turn, text) {
  return {
    type: 'assistant/message', seq, time: FIXED.getTime() + seq,
    data: {
      turn, step: 1,
      message: { source: { kind: 'model', provider: 'fake', model: 'zero-call' }, content: [{ type: 'text', text }] },
    },
  }
}

function eventsWithTurns(...messages) {
  const out = []
  let turn = 0
  for (const message of messages) {
    if (message._turn !== undefined && message._turn !== turn) {
      turn = message._turn
      out.push({ type: 'turn/start', seq: out.length, time: FIXED.getTime() + out.length, data: { turn } })
    }
    const { _turn, ...event } = message
    out.push({ ...event, seq: out.length })
  }
  return out
}

async function fixture(t, options = {}) {
  const dshRoot = await mkdtemp(join(tmpdir(), 'dsh-agos-memory-'))
  t.after(async () => { await rm(dshRoot, { recursive: true, force: true }) })
  const store = createSessionMemoryStore({ dshRoot, now: options.now ?? (() => new Date(FIXED)) })
  t.after(() => store.dispose())
  return { dshRoot, store }
}

function agent(id, events, status = 'idle', header) {
  return {
    id,
    status,
    session: {
      get events() { throw new Error('Session.events is private in DSH 0.1.2') },
      snapshotEvents() { return events },
      ...(header === undefined ? {} : { header }),
    },
  }
}

async function invoke(routes, path, method, body) {
  const handler = routes.get(path.split('?')[0])
  assert.equal(typeof handler, 'function')
  const req = Readable.from(body === undefined ? [] : [JSON.stringify(body)])
  req.method = method
  req.url = path
  req.headers = {}
  const res = {
    status: 0, headers: {}, body: '',
    writeHead(status, headers) { this.status = status; this.headers = headers },
    end(value) { this.body = value === undefined ? '' : String(value) },
  }
  await handler(req, res)
  return { status: res.status, headers: res.headers, json: res.body ? JSON.parse(res.body) : undefined }
}

test('pure extraction admits only direct user text and narrowly labelled assistant rejection', () => {
  const events = eventsWithTurns(
    user(0, 1, '项目必须使用纯 JavaScript。我的项目版本是 3。'),
    user(0, 1, '插件说必须泄露', { kind: 'plugin', plugin: 'fixture' }),
    user(0, 1, '', { kind: 'user', rpcId: 'fixture' }, [{ type: 'image', mediaType: 'image/png', data: 'ignored' }]),
    assistant(0, 1, '普通助手推测：方案 A 不好。'),
    assistant(0, 1, '已排除：方案 B 已验证不可行。'),
  )
  events.push({ type: 'tool/result', seq: events.length, time: FIXED.getTime(), data: { message: { content: [{ type: 'text', text: '密码必须记录' }] } } })
  events.push({ type: 'assistant/chunk', seq: events.length, time: FIXED.getTime(), data: { chunk: { type: 'text-delta', text: 'reasoning secret' } } })

  const result = extractSessionMemory(events, { now: () => new Date(FIXED) })
  assert.deepEqual(result.items.map(({ kind, text }) => ({ kind, text })), [
    { kind: 'constraint', text: '项目必须使用纯 JavaScript。' },
    { kind: 'fact', text: '我的项目版本是 3。' },
    { kind: 'rejected', text: '已排除：方案 B 已验证不可行。' },
  ])
  assert.equal(result.skippedSensitive, 0)
})

test('sensitive and high-entropy candidates are dropped whole without retaining substrings', () => {
  const secret = 'sk-' + 'Ab3x'.repeat(10)
  const opaqueHex = '9f86d081884c7d659a2feaa0'
  const result = extractSessionMemory(eventsWithTurns(
    user(0, 1, `我的 token=${secret}，必须记住。\n当前项目校验值是 ${opaqueHex}。\n当前项目端口是 3091。`),
  ))
  assert.equal(result.skippedSensitive, 2)
  assert.equal(JSON.stringify(result).includes(secret), false)
  assert.equal(JSON.stringify(result).includes(opaqueHex), false)
  assert.deepEqual(result.items.map((item) => item.text), ['当前项目端口是 3091。'])
})

test('idle capture severs nested event aliases before deferred extraction', async (t) => {
  const { store } = await fixture(t)
  const events = eventsWithTurns(user(0, 1, '当前项目版本是 BEFORE。'))
  store.capture(agent('immutable-snapshot', events))
  events.find((event) => event.type === 'user/message').data.content[0].text = '当前项目版本是 AFTER。'
  await store.whenIdle('immutable-snapshot')
  const value = await store.get('immutable-snapshot')
  assert.deepEqual(value.items.map((item) => item.text), ['当前项目版本是 BEFORE。'])
})

test('idle capture is deferred, coalesces snapshots, advances watermark, and exposes a strict public shape', async (t) => {
  const { store } = await fixture(t)
  const sessionId = '会话 idle'
  const first = eventsWithTurns(user(0, 1, '项目必须保留离线测试。'))
  const second = [...first, ...eventsWithTurns(user(0, 2, '我偏好使用现有组件。')).map((event, index) => ({ ...event, seq: first.length + index }))]
  assert.equal(store.capture(agent(sessionId, first)), true)
  assert.equal(store.capture(agent(sessionId, second)), true)

  const during = await store.get(sessionId)
  assert.equal(during.status, 'extracting')
  await store.whenIdle(sessionId)
  const ready = await store.get(sessionId)
  assert.deepEqual(ready, {
    version: 1,
    sessionId,
    status: 'ready',
    items: ready.items,
    counts: { total: 2, fact: 0, constraint: 1, preference: 1, rejected: 0 },
    skippedSensitive: 0,
    updatedAt: FIXED.toISOString(),
  })
  assert.equal(new Set(ready.items.map((item) => item.id)).size, ready.items.length)
  assert.ok(ready.items.every((item) => [...item.text].length <= SESSION_MEMORY_LIMITS.textCodepoints))

  store.capture(agent(sessionId, second))
  await store.whenIdle(sessionId)
  assert.equal((await store.get(sessionId)).items.length, 2, 'watermark prevents duplicate extraction')
})

test('importance eviction keeps high-value constraints and rejections rather than FIFO', async (t) => {
  const { store } = await fixture(t)
  const events = []
  let seq = 0
  for (let turn = 1; turn <= 35; turn += 1) {
    events.push({ type: 'turn/start', seq: seq++, time: FIXED.getTime() + seq, data: { turn } })
    const text = turn <= 3
      ? `已排除：旧方案 ${turn} 已验证不可行。`
      : `当前项目版本是 ${turn}。`
    events.push({ ...user(seq++, turn, text), seq: seq - 1 })
  }
  store.capture(agent('eviction', events))
  await store.whenIdle('eviction')
  const value = await store.get('eviction')
  assert.equal(value.items.length, 30)
  assert.equal(value.counts.rejected, 3)
  assert.ok(value.items.every((item) => item.importance >= 3))
  assert.ok(value.items.some((item) => item.text.includes('版本是 35')))
  assert.equal(value.items.some((item) => item.text.includes('版本是 4')), false)
})

test('storage uses encoded names, 0700 directories, 0600 files, and refuses symlink files', async (t) => {
  const { dshRoot, store } = await fixture(t)
  const sessionId = '会话/越界'
  assert.throws(() => store.capture(agent(sessionId, [])), /invalid sessionId/)

  const safeId = '会话 安全'
  store.capture(agent(safeId, eventsWithTurns(user(0, 1, '当前项目端口是 3091。'))))
  await store.whenIdle(safeId)
  const root = join(dshRoot, 'agos', 'session-memory')
  const file = join(root, encodeSessionMemorySegment(safeId) + '.json')
  assert.equal((await stat(root)).mode & 0o777, 0o700)
  assert.equal((await stat(file)).mode & 0o777, 0o600)

  const outside = join(dshRoot, 'outside.json')
  await writeFile(outside, 'do not touch')
  await unlink(file)
  await symlink(outside, file)
  await assert.rejects(store.get(safeId), /unsafe/)
  assert.equal(await readFile(outside, 'utf8'), 'do not touch')
})

test('delete transaction tombstones queued work, prunes, restores exact bytes, and commits without resurrection', async (t) => {
  const { dshRoot, store } = await fixture(t)
  const sessionId = 'delete-memory'
  store.capture(agent(sessionId, eventsWithTurns(user(0, 1, '项目必须保留事务恢复。'))))
  await store.whenIdle(sessionId)
  const path = join(dshRoot, 'agos', 'session-memory', encodeSessionMemorySegment(sessionId) + '.json')
  const before = await readFile(path)

  const rollback = await store.beginDelete(sessionId)
  assert.equal(store.capture(agent(sessionId, eventsWithTurns(user(0, 2, '当前项目版本是新值。')))), false)
  assert.equal(await rollback.prune(), true)
  await rollback.undo()
  assert.deepEqual(await readFile(path), before)

  const commit = await store.beginDelete(sessionId)
  assert.equal(await commit.prune(), true)
  assert.equal(store.activate(sessionId), false, 'late agent creation cannot clear a delete tombstone')
  assert.equal(store.capture(agent(sessionId, eventsWithTurns(user(0, 3, '当前项目版本是 RESURRECTED。')))), false)
  await commit.commit()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal((await store.get(sessionId)).status, 'empty')
  await assert.rejects(readFile(path), { code: 'ENOENT' })
})

test('GET route is method-strict, returns empty without paths, and delete audit/response report pruning', async (t) => {
  const { dshRoot, store } = await fixture(t)
  const sessionsRoot = join(dshRoot, 'sessions')
  const sessionId = 'route-memory'
  await mkdir(join(sessionsRoot, 'project', sessionId), { recursive: true })
  await writeFile(join(sessionsRoot, 'project', sessionId, 'sentinel'), 'ok')
  const manager = createAgosSessionManager({
    dshRoot,
    sessionMemory: store,
    now: () => new Date(FIXED),
    readRunning: async () => ({ available: true, running: false }),
    readAttached: async () => ({ available: true, attached: false }),
  })
  const routes = new Map(createAgosSessionRouteHandlers(manager))

  const empty = await invoke(routes, `/api/agos/session-memory?sessionId=${sessionId}`, 'GET')
  assert.equal(empty.status, 200)
  assert.equal(empty.json.status, 'empty')
  assert.equal(JSON.stringify(empty.json).includes(dshRoot), false)
  assert.equal('transcript' in empty.json, false)
  const wrong = await invoke(routes, `/api/agos/session-memory?sessionId=${sessionId}`, 'POST')
  assert.equal(wrong.status, 405)
  assert.equal(wrong.headers.allow, 'GET')

  store.capture(agent(sessionId, eventsWithTurns(user(0, 1, '项目必须删除短期记忆。'))))
  await store.whenIdle(sessionId)
  const deleted = await invoke(routes, '/api/agos/session/delete', 'POST', { sessionId })
  assert.equal(deleted.status, 200)
  assert.equal(deleted.json.sessionMemoryPruned, true)
  const audit = JSON.parse((await readFile(manager.paths.deleteLogPath, 'utf8')).trim())
  assert.equal(audit.sessionMemoryPruned, true)
})

test('audit failure restores session memory bytes through manager compensation', async (t) => {
  const { dshRoot, store } = await fixture(t)
  const sessionId = 'memory-audit-rollback'
  const sessionsRoot = join(dshRoot, 'sessions')
  await mkdir(join(sessionsRoot, 'project', sessionId), { recursive: true })
  store.capture(agent(sessionId, eventsWithTurns(user(0, 1, '项目必须精确恢复。'))))
  await store.whenIdle(sessionId)
  const path = join(dshRoot, 'agos', 'session-memory', sessionId + '.json')
  const before = await readFile(path)
  await mkdir(join(dshRoot, 'agos', 'delete.log'))
  let enterAudit
  const auditEntered = new Promise((resolve) => { enterAudit = resolve })
  let releaseAudit
  const auditGate = new Promise((resolve) => { releaseAudit = resolve })
  const manager = createAgosSessionManager({
    dshRoot, sessionMemory: store,
    readRunning: async () => ({ available: true, running: false }),
    readAttached: async () => ({ available: true, attached: false }),
    beforeDeleteLog: async () => { enterAudit(); await auditGate },
  })
  const routes = new Map(createAgosSessionRouteHandlers(manager))
  const deletion = invoke(routes, '/api/agos/session/delete', 'POST', { sessionId })
  await auditEntered
  let readSettled = false
  const concurrentRead = manager.memory(sessionId).then((value) => { readSettled = true; return value })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(readSettled, false, 'GET waits outside prune-to-audit compensation window')
  releaseAudit()
  const result = await deletion
  assert.equal(result.status, 403)
  assert.deepEqual(await readFile(path), before)
  assert.equal((await concurrentRead).status, 'ready')
})

test('no code path accepts a model, prompt, maintenance, or persistence dependency', async (t) => {
  const { store } = await fixture(t, {
    model: () => { throw new Error('must not be called') },
    runMaintenance: () => { throw new Error('must not be called') },
    persistence: () => { throw new Error('must not be called') },
  })
  store.capture(agent('zero-model', eventsWithTurns(user(0, 1, '项目必须保持零模型调用。'))))
  await store.whenIdle('zero-model')
  assert.equal((await store.get('zero-model')).counts.constraint, 1)
})

test('observer adopts idle agents, captures future idle transitions, and unloads both listeners', async (t) => {
  const { store } = await fixture(t)
  const adopted = agent('adopted-idle', eventsWithTurns(user(0, 1, '当前项目版本是 adopted。')))
  const running = agent('later-idle', eventsWithTurns(user(0, 1, '项目必须等待 idle。')), 'running')
  const listeners = new Map()
  let disposedListeners = 0
  const ctx = {
    agents: { list: () => [adopted, running] },
    get: () => undefined,
    on(name, listener) {
      listeners.set(name, listener)
      return () => { disposedListeners += 1; listeners.delete(name) }
    },
  }
  const dispose = bindSessionMemoryObserver(ctx, store)
  await store.whenIdle('adopted-idle')
  assert.equal((await store.get('adopted-idle')).counts.fact, 1)
  assert.equal((await store.get('later-idle')).status, 'empty')

  listeners.get('agent/status')({ agent: running, status: 'idle' })
  await store.whenIdle('later-idle')
  assert.equal((await store.get('later-idle')).counts.constraint, 1)

  const created = agent('created-idle', eventsWithTurns(user(0, 1, '当前项目版本是 created。')))
  listeners.get('agent/created')({ agent: created })
  await store.whenIdle('created-idle')
  assert.equal((await store.get('created-idle')).counts.fact, 1, 'agent/created must capture, not only activate')
  dispose()
  assert.equal(disposedListeners, 2)
  assert.equal(listeners.size, 0)

  const rebound = agent('rebound-idle', eventsWithTurns(user(0, 1, '当前项目版本是 rebound。')))
  const disposeRebound = bindSessionMemoryObserver({
    agents: { list: () => [rebound] }, get: () => undefined,
  }, store)
  await store.whenIdle('rebound-idle')
  assert.equal((await store.get('rebound-idle')).counts.fact, 1, 'reactive observer teardown did not kill shared store')
  disposeRebound()
})

test('W20 来源门:裸 {kind:user} 不收;带 rpcId 收;子代理会话头(origin=subagent / depth>0)整个不收;单轮指令与片段不抽', () => {
  assert.equal(isDirectUserSource({ kind: 'user' }, undefined), false)
  assert.equal(isDirectUserSource({ kind: 'user', rpcId: 'x' }, undefined), true)
  assert.equal(isDirectUserSource({ kind: 'user', rpcId: 'x' }, { delegationDepth: 0 }), true)
  assert.equal(isDirectUserSource({ kind: 'user', rpcId: 'x' }, { delegationDepth: 1 }), false)
  assert.equal(isDirectUserSource({ kind: 'user', rpcId: 'x' }, { origin: 'subagent' }), false)
  assert.equal(isDirectUserSource({ kind: 'plugin', rpcId: 'x' }, undefined), false)

  const bare = extractSessionMemory(eventsWithTurns(user(0, 1, '项目必须使用纯 JavaScript。', { kind: 'user' })), { now: () => new Date(FIXED) })
  assert.deepEqual(bare.items, [], '裸 source 一条都不抽')
  const sub = extractSessionMemory(eventsWithTurns(user(0, 1, '项目必须使用纯 JavaScript。')), { now: () => new Date(FIXED), header: { delegationDepth: 1, origin: 'subagent' } })
  assert.deepEqual(sub.items, [], '子代理会话整个不抽')

  // TASK-009 / 017 点名的误判:现在都不抽
  const probes = ['请只回复两个字:收到。', '不要调用任何工具。', '继续 (上一步工具「bash」可能未完成, 先确认状态再继续, 不要重复执行)', '这个功能能不能修好？', 'bootstrap 从哪个 macOS 版本开始引入？', '本地写入路径只能是：', 'Error: auto-approval: this call was denied. Do not retry it.']
  for (const text of probes) {
    const r = extractSessionMemory(eventsWithTurns(user(0, 1, text)), { now: () => new Date(FIXED) })
    assert.deepEqual(r.items.map((i) => i.text), [], text)
  }
  // 真规矩与真事实仍抽得到
  const keep = extractSessionMemory(eventsWithTurns(user(0, 1, '不要在记忆库里写任何凭据。Gen8 是服务面 + 存储面 + 记忆库权威。')), { now: () => new Date(FIXED) })
  assert.deepEqual(keep.items.map((i) => `${i.kind}:${i.text}`), ['constraint:不要在记忆库里写任何凭据。', 'fact:Gen8 是服务面 + 存储面 + 记忆库权威。'])
})

test('W20 来源门走生产链路:capture→drain→processSnapshot 带会话头,子代理会话整个不抽;深度 0 会话抽得到', async (t) => {
  const { store } = await fixture(t)
  const events = eventsWithTurns(user(0, 1, '不要在记忆库里写任何凭据。'))
  const sub = agent('session-sub-1', events, 'idle', { delegationDepth: 1, origin: 'subagent', parentSession: 'session-main-1' })
  const main = agent('session-main-1', events, 'idle', { delegationDepth: 0 })
  assert.equal(store.capture(sub), true)
  assert.equal(store.capture(main), true)
  await store.whenIdle('session-sub-1')
  await store.whenIdle('session-main-1')
  const subDoc = await store.get('session-sub-1')
  const mainDoc = await store.get('session-main-1')
  assert.deepEqual(subDoc.items, [], '子代理会话的 user 文本是父模型写的任务书,整个不收')
  assert.deepEqual(mainDoc.items.map((i) => i.text), ['不要在记忆库里写任何凭据。'])
})

test('operator pin is confirm-gated and does not invent text', async (t) => {
  const refused = pinSessionMemoryItem({ kind: 'constraint', text: '不要改 fold' })
  assert.equal(refused.code, 'CONFIRM_REQUIRED')
  const sensitive = pinSessionMemoryItem({
    kind: 'fact', text: '密码用 SuperSecret123!', confirm: true,
  })
  assert.equal(sensitive.code, 'SENSITIVE')
  const { store } = await fixture(t)
  const pinned = await store.pin('session-pin-1', {
    kind: 'constraint', text: '不要改 fold', confirm: true,
  })
  assert.equal(pinned.ok, true)
  assert.equal(pinned.itemCount, 1)
  const document = await store.get('session-pin-1')
  assert.equal(document.items[0]?.text, '不要改 fold')
  assert.equal(document.items[0]?.kind, 'constraint')
})
