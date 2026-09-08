import { createHash, randomUUID } from 'node:crypto'
import { constants as FS_CONSTANTS } from 'node:fs'
import {
  chmod, lstat, mkdir, open, realpath, rename, unlink, writeFile,
} from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { isSensitiveText, SECRET_REFUSE_COPY } from './secrets-gate.js'

const VERSION = 1
const MAX_ITEMS = 30
const MAX_TEXT_CODEPOINTS = 200
const KINDS = new Set(['fact', 'constraint', 'preference', 'rejected'])
const EXTRACT_FAILED_COPY = '抽取失败，显示上次确认内容'

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

function whitespaceNormalized(value) {
  return String(value).replace(/\s+/gu, ' ').trim()
}

function normalizedText(value) {
  return unicodeSlice(whitespaceNormalized(value))
}

function deepFreeze(value, seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return value
  seen.add(value)
  for (const child of Object.values(value)) deepFreeze(child, seen)
  return Object.freeze(value)
}

export function isSensitiveMemoryText(value) {
  return isSensitiveText(value)
}

function splitCandidates(text) {
  return String(text)
    .split(/(?:\r?\n)+|(?<=[。！？!?；;])\s*/u)
    .map((part) => part.trim())
    .filter(Boolean)
}
/** W20 尺专用:把切分器原样暴露给语料挖矿器,保证语料里的「句」与规则看到的「句」同一口径。不改行为。 */
export const splitCandidatesForCorpus = splitCandidates

/**
 * W20(2026-08-23)起的规则。改动前的读数(尺:test/fixtures/session-memory-corpus/baseline.json 的第一版)
 * constraint 精确率 0.24 / 0.26:任何祈使句都被当成持久约束。三处改法:
 *  1) 单轮指令否决:「只回复…」「不要调用工具」「原样呈现」、auto-continue 模板——这些是本轮输出/工具指令,不是规矩;
 *  2) constraint 关键词去掉「需要」(问句与陈述里到处都是),「不能」排除「能不能」;
 *  3) fact 先排除问句 / 表格行 / 代码围栏 / 命令行,再放宽到「带具名实体的 X 是 Y」与「机器:IP」两种陈述。
 * 规则仍然只看文本;说话人来源在 extractSessionMemory 的来源门里判(必须带 rpcId 的浏览器通道)。
 */
// 单轮指令:本轮输出格式 / 工具执行指令。形态要通用(对抗验证 2026-08-23:照语料抄短语不泛化,现网
// 「先用 bash 执行 sleep 20，不要并行做别的」一个都没命中)。两类:
//   a) 输出格式:只回复 / 只输出 / 原样 / 不要解释 …
//   b) 工具执行:(只|先|再|直接)?(用|调用|执行|运行) … (bash|工具|sleep|脚本|命令);不要并行;读完立刻回答
const TURN_ONLY_RE = /(?:只回复|只回答|只输出|只把|只列出|只做这一件事|原样|不要调用|不要使用(?:任何)?工具|禁止调用工具|不要解释|不要重复执行|不要自己|自己不要|不要并行|立刻回答|(?:^|[，,。;；\s])(?:只|先|再|直接)?(?:用|调用|执行|运行)\s*[^，,。;；]{0,12}(?:bash|工具|sleep|脚本|命令))/u
const AUTO_CONTINUE_RE = /^继续\s*[（(]/u
// 问句:句尾问号,或疑问词(含「是不是 / 是什么 / 为什么 / 有没有 / 能否 / 是否」)
const QUESTION_RE = /[？?]\s*$|(?:是不是|是什么|为什么|有没有|能否|是否|哪个|什么|怎么|怎样|如何|能不能|可不可以|吗|呢)(?:[？?，,。]|$)|(?:是不是|是什么|为什么|有没有|能不能)/u
// 表格行 / 代码围栏 / 反引号起头的列表项 / 命令行。markdown 标题(#)不否决:标题里也能写规矩(「## 第一件事:先读记忆,不要瞎猜」)
const MARKUP_LINE_RE = /^(?:[|`]|```|[-*]\s*`)|^(?:ssh|curl|tailscale|cd|ls|cat|node|npm|git)\s/u
// 片段(以冒号收尾的引子)与贴回来的报错,两类都不是话
const FRAGMENT_RE = /[:：]\s*$|^(?:Error|Traceback|Exception)\b/u
// 第三人称转述:别人的话不是用户自己的偏好或事实(标注口径里「引用的别人文字」= null)。
// 只认句首的纯转述动词。「要求 / 强调」故意不在表里:那更可能是用户在转达硬要求,文本上分不开。
const ATTRIBUTION_LEAD_RE = /^[-*#「」“”"'\s]*(?:同事|同学|老板|领导|客户|甲方|对方|群里|群友|别人|某人|他们|她们|他|她|评审|运维|测试)(?:们)?(?:有人|某人)?\s*(?:[也都还就]\s*)?(?:说|表示|提到|认为|反馈|写道|称|建议)/u
// 条件句里的「X 是 Y」是假设,不是事实。只拦 fact 分支:「如果要动 X,就必须 Y」这类把条件
// 当适用范围的规矩仍按 constraint 收(正文原样保留「如果」,读的人看得见条件)。
const CONDITIONAL_LEAD_RE = /^[-*#\s]*(?:如果|假如|倘若|若是|若|要是|万一|一旦)/u
// 过时陈述不是当前事实。系统没有 stale 标记通道,所以只能不收 —— 绝不静默当成现值。
// 只在标记出现在判断词之前时生效:「Gen8 是真源,之前说过」的「之前」在判断词之后,不算过时。
const STALE_MARKER_RE = /以前|之前|原来|原先|旧版|老版|上个月|上周|去年|当时|曾经/u
const DECLARATIVE_COPULA_RE = /是(?!否)|(?<![作以因认成改设调换命定拆称视])为/u

/** 带过时标记的陈述句:标记落在判断词之前(或整句没有判断词)才算。 */
function isStaleDeclarative(text) {
  const marker = STALE_MARKER_RE.exec(text)
  if (marker === null) return false
  const copula = DECLARATIVE_COPULA_RE.exec(text)
  return copula === null || marker.index < copula.index
}

function classifyUserText(text) {
  if (/^(?:已排除|排除|放弃)\s*[:：]?/u.test(text)
    || /(?:试过|尝试过|验证过).{0,40}(?:不行|失败|不可用|行不通)/u.test(text)
    || /\b(?:tried|tested).{0,60}\b(?:failed|did not work|doesn't work)\b/iu.test(text)) {
    return { kind: 'rejected', importance: 5 }
  }
  // 问句 / 表格行 / 代码围栏 / 命令行 / 片段 / 单轮指令:对所有 kind 一律否决(不只 fact)
  if (QUESTION_RE.test(text) || MARKUP_LINE_RE.test(text) || FRAGMENT_RE.test(text)) return undefined
  if (AUTO_CONTINUE_RE.test(text) || TURN_ONLY_RE.test(text)) return undefined
  // 转述别人的话:对 constraint/preference/fact 一律否决。rejected 在上面已经判过 ——
  // 「同事说试过 flock 不行」仍是一条有用的排除记录。
  if (ATTRIBUTION_LEAD_RE.test(text)) return undefined
  if (/(?:必须|务必|禁止|不许|只允许|只能|(?<!能)不能|不要|不得|应当|都要|一律)/u.test(text)
    || /\b(?:must|never|do not|don't|cannot|can't|required)\b/iu.test(text)) {
    return { kind: 'constraint', importance: 5 }
  }
  if (/(?:我|我们)?(?:偏好|更喜欢|喜欢|希望|倾向|习惯)/u.test(text)
    || /\b(?:I|we)\s+(?:prefer|like|want|would rather)\b/iu.test(text)) {
    return { kind: 'preference', importance: 4 }
  }
  // Pure rules cannot determine truth. Keep this gate intentionally narrow (declaratives only).
  // 条件句与过时陈述都不是事实:只拦这一支,上面的 constraint / preference 不受影响。
  if (CONDITIONAL_LEAD_RE.test(text) || isStaleDeclarative(text)) return undefined
  if (/(?:^|[，, ])(?:我(?:的|们)?|本机|当前|目前|项目|仓库|服务|端口|路径|版本).{1,}/u.test(text)
    || /\b(?:my|our|current|project|repository|service|version)\b.{1,}\b(?:is|are|uses?|runs?|lives?)\b/iu.test(text)
    // 「具名实体 是/为 …」:主语里得有 ASCII 字母或数字(Gen8 / M4-Knowledge / NucBoxG3),纯中文指代(这个是…)不算
    // 「把 X 改为/设为/命名为 Y」是祈使句不是陈述;作为/以为/因为/认为/成为 也不是判断词
    // 主语要短(ASCII 实体前 ≤12 字、后 ≤8 字):「这版 prompt 的重点已经把“记忆库是…」这种长主语是叙述不是陈述
    || /^[-*#]*\s*[^，。,]{0,12}[A-Za-z0-9][^，。,]{0,8}(?:是(?!否)|(?<![作以因认成改设调换命定拆称视]|重命名)为)\s*\S/u.test(text)
    // 「机器:IP」行
    || /[：:]\s*`?\d{1,3}(?:\.\d{1,3}){3}/u.test(text)) {
    return { kind: 'fact', importance: 3 }
  }
  return undefined
}

function classifyAssistantRejected(text) {
  // Assistant output is not trusted as fact. Only an explicit rejection label
  // becomes a candidate, and only as kind=rejected.
  // W20 对抗验证后撤回了按语料仅有的 2 条正样本写的「显式结论句」正则(那是记忆不是规则);
  // 助手侧 rejected 在 n=2 上不可评估,召回 0 如实报。
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

const PIN_IMPORTANCE = Object.freeze({
  fact: 3,
  constraint: 5,
  preference: 4,
  rejected: 5,
})

/** Operator pin. Confirm-gated. Does not invent text or loosen extract rules. */
export function pinSessionMemoryItem(input, options = {}) {
  if (!input || input.confirm !== true) {
    return { ok: false, status: 400, code: 'CONFIRM_REQUIRED', error: '收进会话记忆需要 confirm:true' }
  }
  const kind = String(input.kind ?? '')
  if (!KINDS.has(kind)) {
    return { ok: false, status: 400, code: 'INVALID_KIND', error: 'kind 必须是 fact、constraint、preference 或 rejected' }
  }
  const text = whitespaceNormalized(input.text ?? '')
  if (text === '' || [...text].length > MAX_TEXT_CODEPOINTS) {
    return { ok: false, status: 400, code: 'INVALID_TEXT', error: '正文未采集或超过 200 码点' }
  }
  if (isSensitiveMemoryText(text)) {
    return { ok: false, status: 400, code: 'SENSITIVE', error: SECRET_REFUSE_COPY }
  }
  const sourceTurn = Number.isSafeInteger(input.sourceTurn) && input.sourceTurn >= 0 ? input.sourceTurn : 0
  const now = typeof options.now === 'function' ? options.now() : new Date()
  return {
    ok: true,
    item: {
      id: itemId(kind, text),
      kind,
      text,
      importance: PIN_IMPORTANCE[kind],
      sourceTurn,
      createdAt: now.toISOString(),
    },
  }
}

/** W20 来源门(纯函数,可单测)。 */
export function isDirectUserSource(source, header) {
  if (!source || source.kind !== 'user') return false
  if (typeof source.rpcId !== 'string' || source.rpcId === '') return false
  if (header && typeof header === 'object') {
    if (header.origin === 'subagent') return false
    if (Number.isInteger(header.delegationDepth) && header.delegationDepth > 0) return false
  }
  return true
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
      // W20 来源门:只收浏览器 / RPC 通道(source 带 rpcId)的用户文本。裸 {kind:'user'} 是子代理派发 prompt
      // 或 headless 直发探针——归档实测 89% 的产出来自这里,没有一条是 Leo 的规矩。
      // 会话头(options.header)若给了,子代理会话(origin==='subagent' 或 delegationDepth>0)整个不收:
      // 它的 user 文本是父模型写的任务书。两信号都看;都缺席按「不是 Leo 的话」处理。
      if (!isDirectUserSource(event.data.source, options.header)) continue
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
      state = { generation: 0, pending: undefined, scheduled: undefined, running: undefined, deleting: false, lastExtractError: undefined }
      states.set(sessionId, state)
    }
    return state
  }

  const ensurePlainDirectory = async (path, parentReal, create, privateMode = false) => {
    let identity
    try { identity = await lstat(path) } catch (error) {
      if (!(error && error.code === 'ENOENT')) throw error
      if (!create) return undefined
      // 两个会话同时首次落盘会同时 mkdir 同一层:EEXIST 不是错,下面的 lstat 会把它当既有目录重新校验
      // (2026-08-23 W20 的生产链路测试暴露:此前 EEXIST 抛到 drain 被吞,一个会话的抽取结果静默丢失)。
      try {
        await mkdir(path, { recursive: false, mode: 0o700 })
      } catch (mkdirError) {
        if (!(mkdirError && mkdirError.code === 'EEXIST')) throw mkdirError
      }
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

  const processSnapshot = async (sessionId, snapshot, generation, header) => {
    if (disposed || tombstones.has(sessionId) || stateFor(sessionId).generation !== generation) return
    const previous = await readDocument(sessionId)
    const extracted = extractSessionMemory(snapshot, { afterSeq: previous.watermark, now, header })
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
        await processSnapshot(sessionId, pending.snapshot, pending.generation, pending.header)
        state.lastExtractError = undefined
      }
    })()
    state.running = operation
    void operation.catch(() => {
      state.lastExtractError = EXTRACT_FAILED_COPY
    }).finally(() => {
      if (state.running === operation) state.running = undefined
      if (state.pending && !state.scheduled && !disposed && !tombstones.has(sessionId)) {
        state.scheduled = setImmediate(() => drain(sessionId))
      }
    })
  }

  const capture = (agent) => {
    if (disposed || !agent || typeof agent.id !== 'string'
      || typeof agent.session?.snapshotEvents !== 'function') return false
    const events = agent.session.snapshotEvents()
    if (!Array.isArray(events)) return false
    const sessionId = agent.id
    encodeSessionMemorySegment(sessionId)
    if (tombstones.has(sessionId)) return false
    // Session events are JSON values, so structuredClone severs every nested
    // alias synchronously at the idle transition. Deep-freezing the detached
    // copy documents and enforces the background worker's read-only contract.
    const snapshot = deepFreeze(structuredClone(events))
    // W20:会话头随快照走(子代理会话整个不抽);header 不是事件,单独克隆。
    const header = agent.session.header && typeof agent.session.header === 'object' ? deepFreeze(structuredClone(agent.session.header)) : undefined
    const state = stateFor(sessionId)
    state.pending = { snapshot, header, generation: state.generation }
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
    const failed = Boolean(state && state.lastExtractError)
    const status = extracting
      ? 'extracting'
      : failed
        ? 'degraded'
        : (document.updatedAt === null ? 'empty' : 'ready')
    return publicPayload(document, status)
  }

  const pin = async (sessionId, input) => {
    const prepared = pinSessionMemoryItem(input, { now })
    if (!prepared.ok) return prepared
    encodeSessionMemorySegment(sessionId)
    const state = stateFor(sessionId)
    if (tombstones.has(sessionId) || state.deleting) {
      return { ok: false, status: 409, code: 'SESSION_BUSY', error: '会话记忆正在删除' }
    }
    await whenIdle(sessionId)
    if (tombstones.has(sessionId) || state.deleting) {
      return { ok: false, status: 409, code: 'SESSION_BUSY', error: '会话记忆正在删除' }
    }
    const previous = await readDocument(sessionId)
    const next = {
      version: VERSION,
      sessionId,
      generation: previous.generation,
      watermark: previous.watermark,
      items: mergeItems(previous.items, [prepared.item]),
      skippedSensitive: previous.skippedSensitive,
      updatedAt: now().toISOString(),
    }
    await atomicWrite(sessionId, next, () => !disposed && !tombstones.has(sessionId) && !state.deleting)
    return { ok: true, item: prepared.item, itemCount: next.items.length }
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
    pin,
    beginDelete,
    whenIdle,
    dispose,
  }
}

export const SESSION_MEMORY_LIMITS = Object.freeze({ items: MAX_ITEMS, textCodepoints: MAX_TEXT_CODEPOINTS })
