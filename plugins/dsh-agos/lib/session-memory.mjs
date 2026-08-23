import { createHash, randomUUID } from 'node:crypto'
import { constants as FS_CONSTANTS } from 'node:fs'
import {
  chmod, lstat, mkdir, open, realpath, rename, unlink, writeFile,
} from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'

const VERSION = 1
const MAX_ITEMS = 30
const MAX_TEXT_CODEPOINTS = 200
const KINDS = new Set(['fact', 'constraint', 'preference', 'rejected'])

// Deliberately biased towards false positives: session memory is a convenience
// projection, never the authority, so dropping a whole candidate is safer than
// persisting even a fragment of a credential.
const SECRET_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/i,
  // 分隔符不能只认 : = is 是 为。实测「密码用 Tr0ub4dor&3」「uses password X」
  // 「NAS 登录是 leo / Gen8Nas2026!」全部从这里漏过去,然后被 classifyUserText
  // 的 fact 分支原样收进会话记忆并进响应体(2026-08-21 验收 P0)。
  // 本表按文件顶部声明的口径「宁可误杀整条候选」放宽:关键词后允许任意短分隔。
  /(?:[A-Z0-9_]*(?:API_KEY|ACCESS_KEY|SECRET|TOKEN|PASSWORD|PASSWD|COOKIE|AUTHORIZATION)|api[ -]?key|access[ -]?key|secret|token|password|passwd|cookie|authorization|auth|credential|login|密码|口令|密钥|令牌|凭据|登录|账号)[\s:=/,，、是为用（(]{0,8}\S{3,}/iu,
  // 连接串:口令夹在 :…@ 之间,既没有关键词,: @ 又把 highEntropyToken 的
  // token run 切断,原来两条路都扫不到。
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]*:[^\s@/]{3,}@/iu,
  /\bbearer\s+[A-Za-z0-9._~+/=-]{12,}/iu,
  /\b(?:sk|gh[opusr]|xox[baprs])-?[A-Za-z0-9_-]{16,}\b/u,
  /\bAKIA[0-9A-Z]{16}\b/u,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/u,
]

function isDirectChild(parent, child) {
  const rel = relative(parent, child)
  return rel !== '' && rel !== '..' && !rel.startsWith('..' + sep) && !rel.includes(sep)
}

export function encodeSessionMemorySegment(raw) {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 1024 || raw.includes('\0')
    || raw.includes('/') || raw.includes('\\')) {
    throw new TypeError('invalid sessionId')
  }
  if (raw === '.') return '~002E'
  if (raw === '..') return '~002E~002E'
  let out = ''
  for (let i = 0; i < raw.length; i += 1) {
    const code = raw.charCodeAt(i)
    const ch = String.fromCharCode(code)
    out += ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)
      ? ch : '~' + code.toString(16).toUpperCase().padStart(4, '0')
  }
  return out
}

function unicodeSlice(value, limit = MAX_TEXT_CODEPOINTS) {
  return [...value].slice(0, limit).join('')
}

function normalizedText(value) {
  return unicodeSlice(String(value).replace(/\s+/gu, ' ').trim())
}

function highEntropyToken(value) {
  const tokens = String(value).match(/[A-Za-z0-9+/_=-]{24,}/gu) ?? []
  return tokens.some((token) => {
    const sample = token.replace(/[=_-]+$/u, '')
    if (sample.length < 24) return false
    const classes = [/[a-z]/u, /[A-Z]/u, /[0-9]/u, /[+/_=-]/u]
      .reduce((sum, pattern) => sum + Number(pattern.test(sample)), 0)
    const uniqueRatio = new Set(sample).size / sample.length
    const frequencies = new Map()
    for (const ch of sample) frequencies.set(ch, (frequencies.get(ch) ?? 0) + 1)
    let entropy = 0
    for (const count of frequencies.values()) {
      const probability = count / sample.length
      entropy -= probability * Math.log2(probability)
    }
    return (classes >= 3 && uniqueRatio >= 0.35)
      || (sample.length >= 24 && entropy >= 3.5)
  })
}

function deepFreeze(value, seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return value
  seen.add(value)
  for (const child of Object.values(value)) deepFreeze(child, seen)
  return Object.freeze(value)
}

export function isSensitiveMemoryText(value) {
  const text = String(value)
  return SECRET_PATTERNS.some((pattern) => pattern.test(text)) || highEntropyToken(text)
}

function splitCandidates(text) {
  return String(text)
    .split(/(?:\r?\n)+|(?<=[。！？!?；;])\s*/u)
    .map((part) => part.trim())
    .filter(Boolean)
}

function classifyUserText(text) {
  if (/^(?:已排除|排除|放弃)\s*[:：]?/u.test(text)
    || /(?:试过|尝试过|验证过).{0,40}(?:不行|失败|不可用|行不通)/u.test(text)
    || /\b(?:tried|tested).{0,60}\b(?:failed|did not work|doesn't work)\b/iu.test(text)) {
    return { kind: 'rejected', importance: 5 }
  }
  if (/(?:必须|务必|禁止|不许|只允许|只能|不能|不要|不得|需要|应当)/u.test(text)
    || /\b(?:must|never|do not|don't|only|cannot|can't|required|should)\b/iu.test(text)) {
    return { kind: 'constraint', importance: 5 }
  }
  if (/(?:我|我们)?(?:偏好|更喜欢|喜欢|希望|倾向|习惯)/u.test(text)
    || /\b(?:I|we)\s+(?:prefer|like|want|would rather)\b/iu.test(text)) {
    return { kind: 'preference', importance: 4 }
  }
  // Pure rules cannot determine truth. Keep this gate intentionally narrow:
  // direct-user declaratives with a concrete first-person/project/state cue.
  if (/(?:^|[，, ])(?:我(?:的|们)?|本机|当前|目前|项目|仓库|服务|端口|路径|版本).{1,}/u.test(text)
    || /\b(?:my|our|current|project|repository|service|version)\b.{1,}\b(?:is|are|uses?|runs?|lives?)\b/iu.test(text)) {
    return { kind: 'fact', importance: 3 }
  }
  return undefined
}

function classifyAssistantRejected(text) {
  // Assistant output is not trusted as fact. Only an explicit rejection label
  // becomes a candidate, and only as kind=rejected.
  if (/^(?:\[已排除\]|已排除\s*[:：]|REJECTED\s*[:：])/iu.test(text)) {
    return { kind: 'rejected', importance: 4 }
  }
  return undefined
}

function textParts(content) {
  if (!Array.isArray(content)) return []
  return content
    .filter((part) => part && part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
}

function isoTime(value, now) {
  const date = Number.isFinite(value) && value >= 0 ? new Date(value) : now()
  return Number.isNaN(date.getTime()) ? now().toISOString() : date.toISOString()
}

function itemId(kind, text) {
  return createHash('sha256').update(kind + '\0' + text).digest('hex').slice(0, 24)
}

/** Pure, deterministic extraction. It never calls a model or reads persistence. */
export function extractSessionMemory(events, options = {}) {
  const afterSeq = Number.isSafeInteger(options.afterSeq) ? options.afterSeq : -1
  const now = typeof options.now === 'function' ? options.now : () => new Date()
  const items = []
  let skippedSensitive = 0
  let watermark = afterSeq
  let currentTurn = 0

  for (const event of Array.isArray(events) ? events : []) {
    if (!event || !Number.isSafeInteger(event.seq) || event.seq < 0) continue
    if (event.type === 'turn/start' && Number.isSafeInteger(event.data?.turn)) currentTurn = event.data.turn
    if (event.seq <= afterSeq) continue
    watermark = Math.max(watermark, event.seq)

    let parts = []
    let classify
    let sourceTurn = currentTurn
    if (event.type === 'user/message' && event.data?.source?.kind === 'user') {
      parts = textParts(event.data.content)
      classify = classifyUserText
    } else if (event.type === 'assistant/message' && event.data?.message?.source?.kind === 'model') {
      parts = textParts(event.data.message.content)
      classify = classifyAssistantRejected
      if (Number.isSafeInteger(event.data.turn)) sourceTurn = event.data.turn
    } else {
      continue
    }

    for (const part of parts) {
      for (const raw of splitCandidates(part)) {
        if (isSensitiveMemoryText(raw)) {
          skippedSensitive += 1
          continue
        }
        const text = normalizedText(raw)
        if (text.length === 0) continue
        const category = classify(text)
        if (!category) continue
        items.push({
          id: itemId(category.kind, text),
          kind: category.kind,
          text,
          importance: category.importance,
          sourceTurn: Number.isSafeInteger(sourceTurn) && sourceTurn >= 0 ? sourceTurn : 0,
          createdAt: isoTime(event.time, now),
        })
      }
    }
  }
  return { items, skippedSensitive, watermark }
}

function emptyDocument(sessionId) {
  return {
    version: VERSION,
    sessionId,
    generation: 0,
    watermark: -1,
    items: [],
    skippedSensitive: 0,
    updatedAt: null,
  }
}

function normalizeItem(value) {
  if (!value || typeof value !== 'object' || typeof value.id !== 'string'
    || !KINDS.has(value.kind) || typeof value.text !== 'string'
    || !Number.isInteger(value.importance) || value.importance < 1 || value.importance > 5
    || !Number.isSafeInteger(value.sourceTurn) || value.sourceTurn < 0
    || typeof value.createdAt !== 'string' || Number.isNaN(Date.parse(value.createdAt))
    || [...value.text].length > MAX_TEXT_CODEPOINTS) return undefined
  return {
    id: value.id.slice(0, 128), kind: value.kind, text: value.text,
    importance: value.importance, sourceTurn: value.sourceTurn, createdAt: value.createdAt,
  }
}

function normalizeDocument(value, sessionId) {
  if (!value || typeof value !== 'object' || value.version !== VERSION || value.sessionId !== sessionId) {
    throw new Error('session memory document is invalid')
  }
  const items = Array.isArray(value.items) ? value.items.map(normalizeItem) : []
  if (items.some((item) => item === undefined) || items.length > MAX_ITEMS
    || new Set(items.map((item) => item.id)).size !== items.length) {
    throw new Error('session memory items are invalid')
  }
  return {
    version: VERSION,
    sessionId,
    generation: Number.isSafeInteger(value.generation) && value.generation >= 0 ? value.generation : 0,
    watermark: Number.isSafeInteger(value.watermark) ? value.watermark : -1,
    items,
    skippedSensitive: Number.isSafeInteger(value.skippedSensitive) && value.skippedSensitive >= 0
      ? value.skippedSensitive : 0,
    updatedAt: typeof value.updatedAt === 'string' && !Number.isNaN(Date.parse(value.updatedAt))
      ? value.updatedAt : null,
  }
}

function mergeItems(existing, incoming) {
  const byId = new Map(existing.map((item) => [item.id, item]))
  for (const item of incoming) {
    const previous = byId.get(item.id)
    byId.set(item.id, previous
      ? { ...previous, importance: Math.max(previous.importance, item.importance), sourceTurn: Math.max(previous.sourceTurn, item.sourceTurn) }
      : item)
  }
  return [...byId.values()]
    .sort((a, b) => b.importance - a.importance
      || b.sourceTurn - a.sourceTurn
      || b.createdAt.localeCompare(a.createdAt)
      || a.id.localeCompare(b.id))
    .slice(0, MAX_ITEMS)
}

function publicPayload(document, status) {
  const counts = { total: document.items.length, fact: 0, constraint: 0, preference: 0, rejected: 0 }
  for (const item of document.items) counts[item.kind] += 1
  return {
    version: VERSION,
    sessionId: document.sessionId,
    status,
    items: document.items,
    counts,
    skippedSensitive: document.skippedSensitive,
    updatedAt: document.updatedAt,
  }
}

export function createSessionMemoryStore(options = {}) {
  const dshRoot = resolve(options.dshRoot ?? join(homedir(), '.dsh'))
  const agosRoot = resolve(options.agosRoot ?? join(dshRoot, 'agos'))
  const root = resolve(options.root ?? join(agosRoot, 'session-memory'))
  const now = typeof options.now === 'function' ? options.now : () => new Date()
  const states = new Map()
  const tombstones = new Set()
  let disposed = false

  if (dirname(agosRoot) !== dshRoot || basename(agosRoot) !== 'agos'
    || dirname(root) !== agosRoot || basename(root) !== 'session-memory') {
    throw new TypeError('session memory root must be .dsh/agos/session-memory')
  }

  const stateFor = (sessionId) => {
    let state = states.get(sessionId)
    if (!state) {
      state = { generation: 0, pending: undefined, scheduled: undefined, running: undefined, deleting: false }
      states.set(sessionId, state)
    }
    return state
  }

  const ensurePlainDirectory = async (path, parentReal, create, privateMode = false) => {
    let identity
    try { identity = await lstat(path) } catch (error) {
      if (!(error && error.code === 'ENOENT')) throw error
      if (!create) return undefined
      await mkdir(path, { recursive: false, mode: 0o700 })
      identity = await lstat(path)
    }
    if (!identity.isDirectory() || identity.isSymbolicLink()) throw new Error('session memory directory is unsafe')
    const actual = await realpath(path)
    if (parentReal && !isDirectChild(parentReal, actual)) throw new Error('session memory directory escaped its parent')
    if (privateMode && (identity.mode & 0o077) !== 0) {
      if (!create) throw new Error('session memory directory permissions are unsafe')
      await chmod(actual, 0o700)
    }
    return actual
  }

  const ensureRoot = async (create) => {
    let dshIdentity
    try { dshIdentity = await lstat(dshRoot) } catch (error) {
      if (!(error && error.code === 'ENOENT')) throw error
      if (!create) return undefined
      await mkdir(dshRoot, { recursive: true, mode: 0o700 })
      dshIdentity = await lstat(dshRoot)
    }
    if (!dshIdentity.isDirectory() || dshIdentity.isSymbolicLink()) throw new Error('dsh root is unsafe')
    const dshReal = await realpath(dshRoot)
    const agosReal = await ensurePlainDirectory(agosRoot, dshReal, create)
    if (!agosReal) return undefined
    return ensurePlainDirectory(root, agosReal, create, true)
  }

  const filePath = async (sessionId, create) => {
    const safeRoot = await ensureRoot(create)
    if (!safeRoot) return undefined
    const file = join(safeRoot, encodeSessionMemorySegment(sessionId) + '.json')
    if (!isDirectChild(safeRoot, file)) throw new Error('session memory path escaped root')
    return file
  }

  const readRaw = async (sessionId) => {
    const path = await filePath(sessionId, false)
    if (!path) return undefined
    let identity
    try { identity = await lstat(path) } catch (error) {
      if (error && error.code === 'ENOENT') return undefined
      throw error
    }
    if (!identity.isFile() || identity.isSymbolicLink() || (identity.mode & 0o077) !== 0) {
      throw new Error('session memory file is unsafe')
    }
    if (typeof FS_CONSTANTS.O_NOFOLLOW !== 'number') throw new Error('O_NOFOLLOW is unavailable')
    const handle = await open(path, FS_CONSTANTS.O_RDONLY | FS_CONSTANTS.O_NOFOLLOW)
    try {
      const opened = await handle.stat()
      if (!opened.isFile() || opened.dev !== identity.dev || opened.ino !== identity.ino) {
        throw new Error('session memory file changed while opening')
      }
      return { path, bytes: await handle.readFile(), mode: identity.mode & 0o777 }
    } finally {
      await handle.close()
    }
  }

  const readDocument = async (sessionId) => {
    const raw = await readRaw(sessionId)
    if (!raw) return emptyDocument(sessionId)
    let parsed
    try { parsed = JSON.parse(raw.bytes.toString('utf8')) } catch { throw new Error('session memory document is invalid JSON') }
    return normalizeDocument(parsed, sessionId)
  }

  const atomicWriteBytes = async (sessionId, bytes, mayCommit = () => true) => {
    const path = await filePath(sessionId, true)
    try {
      const identity = await lstat(path)
      if (!identity.isFile() || identity.isSymbolicLink()) throw new Error('session memory file is unsafe')
    } catch (error) {
      if (!(error && error.code === 'ENOENT')) throw error
    }
    const temp = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`)
    try {
      await writeFile(temp, bytes, { flag: 'wx', mode: 0o600 })
      await chmod(temp, 0o600)
      if (!mayCommit()) return
      await rename(temp, path)
    } finally {
      try { await unlink(temp) } catch {}
    }
  }

  const atomicWrite = (sessionId, document, mayCommit = () => true) => atomicWriteBytes(
    sessionId, Buffer.from(JSON.stringify(document, null, 2) + '\n'), mayCommit,
  )

  const processSnapshot = async (sessionId, snapshot, generation) => {
    if (disposed || tombstones.has(sessionId) || stateFor(sessionId).generation !== generation) return
    const previous = await readDocument(sessionId)
    const extracted = extractSessionMemory(snapshot, { afterSeq: previous.watermark, now })
    if (extracted.watermark <= previous.watermark) return
    const next = {
      version: VERSION,
      sessionId,
      generation,
      watermark: extracted.watermark,
      items: mergeItems(previous.items, extracted.items),
      skippedSensitive: previous.skippedSensitive + extracted.skippedSensitive,
      updatedAt: now().toISOString(),
    }
    const state = stateFor(sessionId)
    await atomicWrite(sessionId, next, () => !disposed && !tombstones.has(sessionId) && state.generation === generation)
  }

  const drain = (sessionId) => {
    const state = stateFor(sessionId)
    state.scheduled = undefined
    if (state.running || disposed || tombstones.has(sessionId)) return
    const operation = (async () => {
      while (state.pending && !disposed && !tombstones.has(sessionId)) {
        const pending = state.pending
        state.pending = undefined
        await processSnapshot(sessionId, pending.snapshot, pending.generation)
      }
    })()
    state.running = operation
    void operation.catch(() => undefined).finally(() => {
      if (state.running === operation) state.running = undefined
      if (state.pending && !state.scheduled && !disposed && !tombstones.has(sessionId)) {
        state.scheduled = setImmediate(() => drain(sessionId))
      }
    })
  }

  const capture = (agent) => {
    if (disposed || !agent || typeof agent.id !== 'string' || !Array.isArray(agent.session?.events)) return false
    const sessionId = agent.id
    encodeSessionMemorySegment(sessionId)
    if (tombstones.has(sessionId)) return false
    // Session events are JSON values, so structuredClone severs every nested
    // alias synchronously at the idle transition. Deep-freezing the detached
    // copy documents and enforces the background worker's read-only contract.
    const snapshot = deepFreeze(structuredClone(agent.session.events))
    const state = stateFor(sessionId)
    state.pending = { snapshot, generation: state.generation }
    if (!state.scheduled && !state.running) state.scheduled = setImmediate(() => drain(sessionId))
    return true
  }

  const activate = (sessionId) => {
    encodeSessionMemorySegment(sessionId)
    const state = stateFor(sessionId)
    // A deletion transaction owns this identity until undo/commit. A late
    // agent/created notification must not clear the tombstone or let a queued
    // idle capture resurrect the just-pruned file.
    if (state.deleting) return false
    state.generation += 1
    state.deleting = false
    tombstones.delete(sessionId)
    return true
  }

  const get = async (sessionId) => {
    encodeSessionMemorySegment(sessionId)
    const document = await readDocument(sessionId)
    const state = states.get(sessionId)
    const extracting = Boolean(state && (state.pending || state.scheduled || state.running))
    const status = extracting ? 'extracting' : (document.updatedAt === null ? 'empty' : 'ready')
    return publicPayload(document, status)
  }

  const beginDelete = async (sessionId) => {
    encodeSessionMemorySegment(sessionId)
    const state = stateFor(sessionId)
    if (state.deleting) throw new Error('session memory delete already active')
    state.deleting = true
    state.generation += 1
    const token = state.generation
    tombstones.add(sessionId)
    state.pending = undefined
    if (state.scheduled) { clearImmediate(state.scheduled); state.scheduled = undefined }
    if (state.running) await state.running.catch(() => undefined)
    let snapshot
    try {
      if (!state.deleting || state.generation !== token || !tombstones.has(sessionId)) {
        throw new Error('session memory delete was superseded')
      }
      snapshot = await readRaw(sessionId)
    } catch (error) {
      // 抛出前必须释放本事务持有的 deleting/tombstone。原来 readRaw 一抛
      // (文件被 rsync/Time Machine 恢复成 0644 就会命中 mode & 0o077 检查),
      // 该会话就永久卡死:capture()/activate() 被 deleting 短路、第二次
      // beginDelete 直接抛 'already active',删不掉也不再记忆(2026-08-21 验收 P1)。
      // 只在仍由本事务持有时释放,避免抢走接管者的所有权。
      if (state.deleting && state.generation === token) {
        state.deleting = false
        tombstones.delete(sessionId)
      }
      throw error
    }
    let pruned = false
    let settled = false
    return {
      async prune() {
        if (settled) throw new Error('session memory delete transaction settled')
        if (!state.deleting || state.generation !== token || !tombstones.has(sessionId)) {
          throw new Error('session memory delete was superseded')
        }
        if (!snapshot) return false
        const current = await readRaw(sessionId)
        if (!current) return false
        if (!current.bytes.equals(snapshot.bytes)) throw new Error('session memory changed during delete')
        await unlink(current.path)
        pruned = true
        return true
      },
      async undo() {
        if (settled) return
        if (pruned && snapshot) {
          let occupied = false
          try { await lstat(snapshot.path); occupied = true } catch (error) {
            if (!(error && error.code === 'ENOENT')) throw error
          }
          if (occupied) throw new Error('session memory path occupied during rollback')
          normalizeDocument(JSON.parse(snapshot.bytes.toString('utf8')), sessionId)
          await atomicWriteBytes(sessionId, snapshot.bytes, () => true)
        }
        state.deleting = false
        state.generation += 1
        tombstones.delete(sessionId)
        settled = true
      },
      async commit() {
        if (settled) return
        if (!state.deleting || state.generation !== token || !tombstones.has(sessionId)) {
          throw new Error('session memory delete was superseded')
        }
        state.deleting = false
        state.pending = undefined
        settled = true
      },
    }
  }

  const whenIdle = async (sessionId) => {
    const state = states.get(sessionId)
    if (!state) return
    while (state.scheduled || state.running || state.pending) {
      await new Promise((resolve) => setImmediate(resolve))
    }
  }

  const dispose = () => {
    disposed = true
    for (const [sessionId, state] of states) {
      state.generation += 1
      state.pending = undefined
      tombstones.add(sessionId)
      if (state.scheduled) clearImmediate(state.scheduled)
      state.scheduled = undefined
    }
  }

  return {
    paths: { dshRoot, agosRoot, root },
    capture,
    activate,
    get,
    beginDelete,
    whenIdle,
    dispose,
  }
}

export const SESSION_MEMORY_LIMITS = Object.freeze({ items: MAX_ITEMS, textCodepoints: MAX_TEXT_CODEPOINTS })
