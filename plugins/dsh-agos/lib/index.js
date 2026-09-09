// @dsh-local/agos host 半区:AgOS 控制台的服务端。
// v2.2 技能面(2026-08-21):根并集 + servedToModel 标注 + 跨根遮蔽 + 使用率缓存。
//   GET  /api/agos/skills       —— skill-librarian 多根审计(5min 缓存,?refresh=1)
//   POST /api/agos/skills/draft       —— 工作室新建到 ~/.dsh/skills；插件 stub 只写 ~/.dsh/agos/plugin-stubs
//   GET  /api/agos/skills/studio      —— 只读模型根技能 + 评测集
//   POST /api/agos/skills/description —— 只改模型根 description，需 confirm
//   GET  /api/agos/skills/evolve      —— 词面短名单 + 经验后验（不跑小模型）
//   POST /api/agos/skills/evolve      —— record 胜负 / propose+可选小模型（失败回退）
//   GET/POST /api/agos/session-memory/relevance —— 词面短名单 + 操作员有用/误召回（不跑模型）
//   GET /api/agos/overview  —— 控制台仪表盘一次取数:会话/计划/技能/活跃派单 四组 KPI。
//     全部**软依赖**:某个源不可用就缺那一组字段,绝不 500(仪表盘按有无渲染)。
//     - sessions:优先 sessionPersistence 权威列表,仅在服务不可用时回落 projcache
//     - plans:扫 ~/.dsh/logs/plans/*.json(与 cn-capabilities 同目录)
//     - skills:只回内存缓存(冷缓存不触发审计——审计由技能 section 自己拉);含 servedToModel 分桶
//     - lineage:软 import swarm 插件的 PROGRESS 表(swarm 不在就缺席)
import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { constants as FS_CONSTANTS, existsSync, readFileSync, readdirSync } from 'node:fs'
import {
  lstat, mkdir, open, readFile, readdir, realpath, rename, rmdir, stat, unlink, writeFile,
} from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import {
  analyzeShadowing,
  annotateRootAudit,
  defaultSkillRootDefs,
  estimateIndexBudget,
  loadSkillUsageCached,
} from './skills-console.js'
import { createSessionMemoryStore } from './session-memory.mjs'
import { resolveSwarmModule } from './swarm-host-integration.mjs'
import {
  bindSessionMemoryInject,
  describeSessionMemoryInject,
  writeSessionMemoryInjectConfig,
} from './session-memory-inject.js'
import { createYoloDecisionsRoute, defaultYoloAuditFile } from './yolo-decisions.mjs'
import { createSessionTrashRoute, defaultDeleteLogFile, defaultDshRoot } from './session-trash.mjs'
import { createSkillDraft, patchSkillDescription, readStudioSkill } from './skills-studio.js'
import {
  applyOptionalRerank,
  bindCatalogTrim,
  catalogTrimConfig,
  CATALOG_TRIM_OFF_COPY,
  CATALOG_TRIM_ON_COPY,
  createSkillEvolveStore,
  writeCatalogTrimConfig,
  SKILL_RERANK_SYSTEM,
} from './skills-evolve.js'
import { listMemoryDesk, resolveMemorySubmitInvoker, writeMemoryDesk } from './memory-desk.js'
import { buildPluginsInventory } from './plugins-inventory.js'
import { createTurnEvidenceStore, describeTurnEvidence } from './turn-evidence.js'
import {
  createSessionMemoryRelevanceStore,
  describeSessionMemoryRelevance,
  describeUnreadSessionMemory,
} from './session-memory-rank.js'

export {
  analyzeShadowing,
  annotateRootAudit,
  defaultSkillRootDefs,
  estimateIndexBudget,
  loadSkillUsageCached,
  skillNamesFromEvent,
  categoryOf,
} from './skills-console.js'
export { isSensitiveText, classifySecret, scrubSecrets } from './secrets-gate.js'
export { betaPrior, posteriorMean, ALLOCATE_KAPPA } from './allocate-kernel.js'
export { AGENT_HONESTY_PREAMBLE, composeSelectorSystemPrompt } from './agent-prompts.js'
export { createSessionMemoryStore, extractSessionMemory, pinSessionMemoryItem } from './session-memory.mjs'
export { bindSessionMemoryInject, describeSessionMemoryInject } from './session-memory-inject.js'
export { createYoloDecisionsRoute, selectYoloDecisions, readYoloRows, defaultYoloAuditFile } from './yolo-decisions.mjs'
export { createSessionTrashRoute, buildSessionTrashPayload, describeTrashEntry, splitTrashedTo, summarizeUnloggedRoots, readDeleteLogRows } from './session-trash.mjs'
export {
  applyOptionalRerank,
  bindCatalogTrim,
  catalogTrimConfig,
  createSkillEvolveStore,
  proposeSkillEvolve,
  writeCatalogTrimConfig,
} from './skills-evolve.js'
export { listMemoryDesk, writeMemoryDesk, submitDeskToCiv, resolveMemorySubmitInvoker } from './memory-desk.js'
export { buildPluginsInventory, detectCurrentProfile } from './plugins-inventory.js'
export { createTurnEvidenceStore, describeTurnEvidence } from './turn-evidence.js'
export {
  createSessionMemoryRelevanceStore,
  describeSessionMemoryRelevance,
  proposeSessionMemory,
} from './session-memory-rank.js'

export const name = '@dsh-local/agos'

// ── skill-librarian 审计 ──────────────────────────────────────────────────
// 根列表 = 控制台历史根 ∪ DSH skill-filesystem 用户根;每个根标 servedToModel。
const LIBRARIAN_DIR = join(homedir(), 'Projects', 'skill-librarian')
const LIBRARIAN = join(LIBRARIAN_DIR, 'skills_lint.py')
const PYTHON = existsSync(join(LIBRARIAN_DIR, '.venv', 'bin', 'python'))
  ? join(LIBRARIAN_DIR, '.venv', 'bin', 'python') : 'python3'
const CACHE_TTL_MS = 5 * 60 * 1000
let SKILLS_CACHE = null // { at, data }

function auditRoot(root) {
  return new Promise((resolve) => {
    execFile(PYTHON, [LIBRARIAN, '--json', '--root', root],
      { timeout: 120000, maxBuffer: 64 * 1024 * 1024 },
      (err, stdout, stderr) => {
        try {
          const d = JSON.parse(String(stdout))
          resolve({
            root,
            skills: d.skills ?? 0,
            counts: d.counts ?? {},
            findings: Array.isArray(d.findings) ? d.findings : [],
            budget: d.budget,
          })
        } catch {
          resolve({ root, error: String((stderr || (err && err.message) || 'librarian produced no JSON')).slice(0, 300) })
        }
      })
  })
}

async function skillsPayload(force) {
  if (!existsSync(LIBRARIAN)) {
    return { roots: [], librarian: LIBRARIAN, error: 'skill-librarian 不在 ' + LIBRARIAN_DIR + '(clone github.com/LeoLin990405/skill-librarian 到 ~/Projects/)' }
  }
  if (!force && SKILLS_CACHE && Date.now() - SKILLS_CACHE.at < CACHE_TTL_MS) return SKILLS_CACHE.data

  const rootDefs = defaultSkillRootDefs().filter((d) => existsSync(d.path))
  const audited = await Promise.all(rootDefs.map(async (def) => annotateRootAudit(await auditRoot(def.path), def)))
  const { shadowing, catalog, consistency } = analyzeShadowing(rootDefs)
  const budget = estimateIndexBudget(catalog)
  // Prefer librarian budget from the largest servedToModel root when present.
  const servedBudgets = audited.filter((r) => r.servedToModel && r.budget).map((r) => r.budget)
  const librarianBudget = servedBudgets.sort((a, b) => (b.indexTokensEstimate || 0) - (a.indexTokensEstimate || 0))[0]
  let usagePayload
  try {
    usagePayload = await loadSkillUsageCached({ force })
  } catch (e) {
    usagePayload = { usage: {}, error: String(e && e.message || e).slice(0, 200), at: Date.now() }
  }

  const data = {
    roots: audited,
    shadowing,
    consistency,
    catalog,
    budget: librarianBudget ? { ...budget, librarian: librarianBudget } : budget,
    usage: usagePayload.usage || {},
    usageMeta: {
      at: usagePayload.at,
      files: usagePayload.files,
      events: usagePayload.events,
      roots: usagePayload.roots,
      cache: usagePayload.cache,
      note: usagePayload.note || usagePayload.error,
      error: usagePayload.error,
      errors: usagePayload.errors,
    },
    librarian: LIBRARIAN,
    at: Date.now(),
  }
  SKILLS_CACHE = { at: Date.now(), data }
  return data
}

// ── overview 各源(每个都 try/catch,失败即缺席)─────────────────────────
const PROJCACHE_VERSIONS = new Set([3, 4, 5])

function projectionCacheOverview(path = join(homedir(), '.dsh', 'storages', 'session_projcache', 'sessions')) {
  try {
    const files = readdirSync(path).filter((name) => name.endsWith('.json'))
    let total = 0
    let latestAt = 0
    for (const name of files) {
      try {
        const document = JSON.parse(readFileSync(join(path, name), 'utf8'))
        if (!document || !PROJCACHE_VERSIONS.has(document.version)
          || !document.record || typeof document.record !== 'object') continue
        total += 1
        const at = Number(document.record.identity && document.record.identity.createdAt) || 0
        if (at > latestAt) latestAt = at
      } catch {}
    }
    return { total, latestAt, source: 'projcache' }
  } catch { return undefined }
}

/** Prefer durable session headers; projcache remains a fail-soft counting fallback. */
export async function overviewSessions(options = {}) {
  const persistence = options.sessionPersistence
  if (persistence && typeof persistence.list === 'function') {
    try {
      const headers = await persistence.list()
      if (!Array.isArray(headers)) throw new Error('sessionPersistence.list() did not return an array')
      let latestAt = 0
      for (const header of headers) {
        const at = Number(header && header.createdAt) || 0
        if (at > latestAt) latestAt = at
      }
      return { total: headers.length, latestAt, source: 'persistence' }
    } catch {}
  }
  return projectionCacheOverview(options.projcachePath)
}
function overviewPlans() {
  try {
    const dir = join(homedir(), '.dsh', 'logs', 'plans')
    const files = readdirSync(dir).filter((n) => /^plan-\d+\.json$/.test(n))
    let executed = 0
    for (const n of files) {
      try { if (JSON.parse(readFileSync(join(dir, n), 'utf8')).executedAt) executed += 1 } catch {}
    }
    return { total: files.length, executed }
  } catch { return undefined }
}
function overviewSkills() {
  // 只回热缓存:overview 必须廉价,冷缓存别触发审计。
  // 同时给出「模型实际在用」与「控制台-only」两套数字,避免仪表盘撒谎。
  if (!SKILLS_CACHE) return undefined
  const roots = SKILLS_CACHE.data.roots || []
  let skills = 0, warn = 0, error = 0
  let servedSkills = 0, servedWarn = 0, servedError = 0
  let consoleSkills = 0, consoleWarn = 0, consoleError = 0
  for (const r of roots) {
    const s = r.skills || 0
    const w = (r.counts && r.counts.warn) || 0
    const e = (r.counts && r.counts.error) || 0
    skills += s; warn += w; error += e
    if (r.servedToModel) { servedSkills += s; servedWarn += w; servedError += e }
    else { consoleSkills += s; consoleWarn += w; consoleError += e }
  }
  const consistency = SKILLS_CACHE.data.consistency
  return {
    skills, warn, error, at: SKILLS_CACHE.at,
    servedToModel: { skills: servedSkills, warn: servedWarn, error: servedError },
    consoleOnly: { skills: consoleSkills, warn: consoleWarn, error: consoleError },
    consistency,
  }
}
async function overviewLineage() {
  // 软读 swarm 的 PROGRESS(civ/fleet/plan_run 也发布到它);swarm 不在 → 缺席。
  // 2026-09-09:解析改走统一策略(swarm-host-integration.mjs) —— swarm 已从包依赖
  // 重新定性为宿主环境集成,三个消费点(这里、fleet、cn-capabilities)共用同一份
  // 解析与 opt-in 语义,不再各写一次 import。缺席仍是**返回 undefined**(概览里这一
  // 节缺失),不是伪造零值:0 calls 与"没有这张表"在界面上意思完全不同。
  try {
    const resolution = await resolveSwarmModule()
    if (!resolution.available) return undefined
    const P = resolution.module.PROGRESS
    if (!P || typeof P.entries !== 'function') return undefined
    let calls = 0, running = 0, rows = 0, failed = 0
    for (const [, v] of P) {
      calls += 1
      const rs = Array.isArray(v.rows) ? v.rows : []
      rows += rs.length
      running += rs.filter((r) => r.status === 'running').length
      failed += rs.filter((r) => r.status === 'failed').length
    }
    return { calls, rows, running, failed }
  } catch { return undefined }
}

// ── 会话侧栏元数据 + 可回收删除 ────────────────────────────────────────
const SESSION_META_VERSION = 1
const JSON_BODY_LIMIT = 64 * 1024
const DELETE_LOCK_STALE_MS = 5 * 60 * 1000

class HttpRouteError extends Error {
  constructor(status, code, message) {
    super(message)
    this.status = status
    this.code = code
  }
}

function uniqueStrings(value) {
  if (!Array.isArray(value)) return []
  return [...new Set(value.filter((item) => typeof item === 'string' && item.length > 0))]
}

function normalizeSessionMeta(value) {
  return {
    version: SESSION_META_VERSION,
    pinned: uniqueStrings(value && value.pinned),
    archived: uniqueStrings(value && value.archived),
    updatedAt: typeof (value && value.updatedAt) === 'string' ? value.updatedAt : null,
  }
}

function publicSessionMeta(meta) {
  return { pinned: [...meta.pinned], archived: [...meta.archived] }
}

// 与宿主 dsh-session-persistence-jsonl 的 encodeSegment 完全同形。原始 id
// 永远不会直接参与 join；这里只产生单个、可逆且无路径分隔符的目录名。
function encodeSessionSegment(raw) {
  if (raw.length === 0) throw new HttpRouteError(400, 'INVALID_SESSION_ID', 'sessionId 不能为空')
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

function validateSessionId(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 1024 || value.includes('\0')) {
    throw new HttpRouteError(400, 'INVALID_SESSION_ID', 'sessionId 必须是非空字符串')
  }
  // 浏览器路由不接受路径形输入；合法但含非 ASCII 字符的宿主 id 仍由
  // encodeSessionSegment 支持。
  if (value.includes('/') || value.includes('\\')) {
    throw new HttpRouteError(400, 'INVALID_SESSION_ID', 'sessionId 不能包含路径分隔符')
  }
  return value
}

function isDirectChild(parent, child) {
  const rel = relative(parent, child)
  return rel !== '' && rel !== '..' && !rel.startsWith('..' + sep) && !rel.includes(sep)
}

function isWithin(parent, child) {
  const rel = relative(parent, child)
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel))
}

function localDateStamp(date) {
  const pad = (value) => String(value).padStart(2, '0')
  return String(date.getFullYear()) + pad(date.getMonth() + 1) + pad(date.getDate())
}

function parseHostArchived(value) {
  const candidates = [
    value,
    value && value.value,
    value && value.result && value.result.ok === true ? value.result.value : undefined,
  ]
  for (const candidate of candidates) {
    if (candidate && Array.isArray(candidate.archivedSessionIds)) {
      return { hostArchived: uniqueStrings(candidate.archivedSessionIds), hostArchivedAvailable: true }
    }
  }
  return undefined
}

async function hostArchivedFromContext(ctx) {
  // 某些宿主组合会公开 workspace API；优先真的调用 list。当前 desktop
  // 组合的同一权威则是 workspaceRegistry.archivedSessionIds。
  for (const key of ['workspace', 'workspaceApi']) {
    try {
      const service = ctx[key] ?? ctx.get(key)
      if (service && typeof service.list === 'function') {
        const parsed = parseHostArchived(await service.list({}))
        if (parsed) return parsed
      }
    } catch {}
  }
  try {
    const registry = ctx.workspaceRegistry ?? ctx.get('workspaceRegistry')
    const parsed = parseHostArchived(registry)
    if (parsed) return parsed
  } catch {}
  return { hostArchived: [], hostArchivedAvailable: false }
}

/**
 * 本插件自身的 origin。webServer 不把监听地址交给插件,但每个进来的请求都带
 * Host 头 —— 用它做内调基址(与 dsh-mcp-bridge 的 env.origin 同一手法)。
 */
let selfOrigin

/**
 * 固定协议的会话列表方法名。
 *
 * ⚠️ 2026-09-09 校正:原来写的是 `/api/session.list` + method `session.list`(点号形式),
 * 那是 **0.1.2 之前**的命名。frontend/UPSTREAM.pin 明确记着 0.1.2 传输层把点号改成了
 * 斜杠(`session.history→session/page+follow`、`session.models→session/modelCatalog`),
 * 本仓 vendored membrane 的权威映射也在 `frontend/src/contract/api/rpc-map.ts:18`:
 * `'session/list': SessionsApi['list']`,响应 schema 在
 * `frontend/src/contract/api/sessions.schema.ts:46`(SessionSummary 行)。
 * 旧名字在固定宿主上得不到结果,于是运行态永远 unavailable → 删除永久 503。
 */
const SESSION_LIST_ROUTE = '/api/session/list'
const SESSION_LIST_METHOD = 'session/list'

/**
 * `session/list` 的形参名 —— 信封里的 args 必须按它 keyed。
 *
 * ⚠️ 2026-09-09 二次校正:上面那次只改对了**名字**(点号→斜杠),payload 还是 `{}`,
 * 于是照样永久失败,只是换了个失败理由。固定宿主的 gateway 在
 * `packages/api/gateway/src/index.ts:950-953` 要求 payload 含**恰好一个 plain-object
 * `args` 字段**,否则抛 'Remote payload must contain exactly one plain-object args field';
 * 随后 `assertExactArguments`(:1112-1137)要求 args 的键与 descriptor 逐一对上。
 * `session/list` 的形参是 `_request`(本仓 api-client 的权威映射
 * `frontend/src/api-client/index.ts:71`,信封构造见同文件 :131 `payload: { args }`;
 * 宿主 e2e `apps/web/tests/smoke-real.e2e.ts` 也是 `'session/list', { _request: {} }`)。
 *
 * 这条是**契约研究员独立复核时抓出来的**,不是我自己发现的:我的 13 项测试注入的假 fetch
 * 不校验 payload 形状,所以名字改对了就全绿 —— 测试对准了「方法名」这一个维度,
 * 而真实失败面还有「信封形状」。现在假 fetch 实现宿主那两条谓词(见
 * test/session-delete-host-verdict.test.mjs 的 gatewayFetch),形状退回 `{}` 会变红。
 */
const SESSION_LIST_ARG_KEY = '_request'

/**
 * 运行态的 RPC 兜底。web profile 里 ctx 不公开 agents 服务(desktop 才有),
 * 而 `running` 的权威定义就是「attached agent 的状态」,由 session/list 暴露:
 * SessionSummary 行里恰有 `running: boolean`(见上面 schema 位置)。
 * 内调走本机 loopback,同源无 Origin 头 → 宿主信任栅栏放行(已实测)。
 */
export async function runningFromRpc(sessionId, deps = {}) {
  // deps 只为测试注入 origin/fetch:这条内调此前零覆盖,host.describe 才能腐烂一整轮没人发现。
  const origin = deps.selfOrigin !== undefined ? deps.selfOrigin : selfOrigin
  const doFetch = typeof deps.fetch === 'function' ? deps.fetch : fetch
  if (!origin) {
    return { available: false, running: false, reason: '插件未取到自身 origin，无法内调 session/list' }
  }
  try {
    const response = await doFetch(new URL(SESSION_LIST_ROUTE, origin), {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        type: 'client-request',
        rpcId: `agos-running-${Date.now().toString(36)}`,
        method: SESSION_LIST_METHOD,
        payload: { args: { [SESSION_LIST_ARG_KEY]: {} } },
      }),
    })
    if (!response.ok) {
      return {
        available: false,
        running: false,
        reason: `${SESSION_LIST_ROUTE} 返回 HTTP ${response.status}`,
      }
    }
    const envelope = await response.json()
    const result = envelope && envelope.result
    if (!result || result.ok !== true) {
      const code = result && result.error && result.error.code
      return {
        available: false,
        running: false,
        reason: `${SESSION_LIST_METHOD} 返回错误${code ? `：${code}` : ''}`,
      }
    }
    const items = result.value && Array.isArray(result.value.items) ? result.value.items : undefined
    if (items === undefined) {
      return { available: false, running: false, reason: `${SESSION_LIST_METHOD} 响应缺少 items 数组` }
    }
    const hit = items.find((item) => item && item.sessionId === sessionId)
    // 列表里没有该 id:会话已不在宿主视野(冷会话/已移走),按「未运行」处理 ——
    // 这是 available 的,因为我们确实拿到了权威列表,不该再退回 503。
    return { available: true, running: hit ? hit.running === true : false, reason: null }
  } catch (error) {
    return {
      available: false,
      running: false,
      reason: `内调 ${SESSION_LIST_ROUTE} 失败：${(error && error.message) || error}`,
    }
  }
}

/**
 * 运行态判据。ctx.agents 优先,失败一律落到 session/list 内调。
 *
 * 这里读 ctx 出错**可以**继续走内调,而挂载态那边不行 —— 区别在于内调对运行态是
 * **等价权威**:宿主 list.ts:125 的 `running` 就是同一个 `ctx.agents.get(id)?.status`
 * 算出来的,只是在宿主进程里算。挂载态则没有任何一元 RPC 能回答(见
 * ATTACHED_UNAVAILABLE_REASON),所以那边读不到就只能 fail-closed。
 */
export async function runningFromContext(ctx, sessionId, deps = {}) {
  try {
    const agents = ctx.agents ?? ctx.get('agents')
    if (agents && typeof agents.get === 'function') {
      // 宿主同款谓词(list.ts:125)。
      return { available: true, running: agents.get(sessionId)?.status === 'running', reason: null }
    }
  } catch {
    // ctx 读不出来(服务未注册/ctx 形状异常)→ 交给等价权威的内调,不在这里下结论。
  }
  return runningFromRpc(sessionId, deps)
}

/**
 * 挂载态**没有**一元 RPC 兜底 —— 这是查过固定宿主源码后的结论,不是省事。
 *
 * ⚠️ 2026-09-09 校正。原来这里调 `host.describe` 拿 `attachedSessions` 计数。
 * 该方法在 0.1.2 已删除:
 *  - `frontend/UPSTREAM.pin` 的 vendoring 记录原文:「host.describe removed
 *    (home via $events ready)」;
 *  - 在固定提交 a66e470204 全仓 grep `host.describe` **零匹配**。
 * 那次内调必然 404 → available:false → 删除永久 503。这就是 Luna 报的病根。
 *
 * 也**没有**别的一元方法能替代:固定协议(frontend/src/contract/api/rpc-map.ts)
 * 与会话挂载有关的只有 `session/list`,其行类型 SessionSummary =
 * {sessionId,updatedAt,running,blank,parentSessionId?,origin?,cwd?,projections?},没有 attached。
 * (同名的 `session/attachment` 是取提示词里的**图片附件**,与挂载无关。)
 *
 * 更要紧的是 `running` **不能**当挂载判据。宿主自己的实现
 * packages/api/session-controller/src/list.ts 分两条路产出该字段:
 *    已挂载(在 ctx.sessions 里):running = ctx.agents.get(id)?.status === 'running'   (:125)
 *    冷会话(不在 ctx.sessions 里):running = false                     无条件         (:178)
 * 于是「已挂载但空闲」与「磁盘冷会话」都得 running:false,二者不可区分。
 * 拿 running:false 放行删除,等于把挂载着的空闲会话当已分离删掉 —— 正是要防的事。
 *
 * 挂载的**权威**谓词就是宿主用的那一个:`ctx.sessions.get(id) !== undefined`
 * (同文件 list.ts:172 `const raced = this.ctx.sessions.get(header.id)`)。
 * 拿不到它时唯一诚实的回答是 available:false → fail-closed 拒绝删除。
 */
export const ATTACHED_UNAVAILABLE_REASON =
  'ctx 未公开 sessions 服务;固定协议(0.1.2-rc.1)没有任何一元 RPC 暴露挂载态'
  + '(host.describe 已删除;session/list 的 running 无法区分「挂载但空闲」与「冷会话」)'

/**
 * 判定会话是否仍挂载在宿主中,谓词与宿主 list.ts 逐字一致。
 *
 * `sessions` 由 core 包 packages/core/session 提供,`agents` 由 packages/core/agent 提供;
 * 服务 `session/list` 的 session-controller 声明了 `static inject = ['agents','sessions',…]`,
 * cordis 里 inject 未满足则该插件不加载 —— 所以宿主只要能应答 session/list,
 * 这两个服务就在同一 context 树里可见(第二轮记的「web profile 没有 sessions」不成立)。
 * 这里仍用可选取值而不声明 inject:声明了会让整个 AgOS 在极简 profile 上直接不加载,
 * 代价过大;取不到时只让删除这一条路 fail-closed,其余功能照常。
 */
export async function attachedFromContext(ctx, sessionId) {
  let sessions
  try {
    // 先看直挂属性,再看 ctx.get —— 但只在它真是函数时调,免得把「没有 get 的 ctx」
    // 报成一句 TypeError 文本,那对运维没有诊断价值。
    sessions = ctx?.sessions
    if (sessions === undefined && typeof ctx?.get === 'function') sessions = ctx.get('sessions')
  } catch (error) {
    return {
      available: false,
      attached: false,
      reason: `读取 ctx.sessions 抛错：${(error && error.message) || error}`,
    }
  }
  if (!sessions || typeof sessions.get !== 'function') {
    return { available: false, attached: false, reason: ATTACHED_UNAVAILABLE_REASON }
  }
  try {
    // 宿主同款谓词(list.ts:172)。
    return { available: true, attached: sessions.get(sessionId) !== undefined, reason: null }
  } catch (error) {
    return {
      available: false,
      attached: false,
      reason: `sessions.get 抛错：${(error && error.message) || error}`,
    }
  }
}

function normalizeRunningStatus(value) {
  if (typeof value === 'boolean') return { available: true, running: value, reason: null }
  return {
    available: value && value.available === true,
    running: value && value.running === true,
    reason: (value && typeof value.reason === 'string' && value.reason) || null,
  }
}

function normalizeAttachedStatus(value) {
  if (typeof value === 'boolean') return { available: true, attached: value, reason: null }
  return {
    available: value && value.available === true,
    attached: value && value.attached === true,
    reason: (value && typeof value.reason === 'string' && value.reason) || null,
  }
}

function memorySubmitInvokerFromCtx(ctx) {
  return resolveMemorySubmitInvoker(contextService(ctx, 'tools'))
}

function contextService(ctx, key) {
  try {
    return ctx?.[key] ?? (typeof ctx?.get === 'function' ? ctx.get(key) : undefined)
  } catch {
    return undefined
  }
}

function contextLogger(ctx) {
  try {
    if (ctx?.logger && typeof ctx.logger.info === 'function' && typeof ctx.logger.warn === 'function') {
      return ctx.logger
    }
    if (typeof ctx?.logger === 'function') {
      const logger = ctx.logger('@dsh-local/agos')
      if (logger) return logger
    }
  } catch {}
  return { info() {}, warn() {} }
}

function conciseReason(error) {
  return String((error && error.message) || error || 'unknown')
    .replace(/[\r\n]+/g, ' ')
    .slice(0, 300)
}

/** Resolve the already-open projection domain. Never calls storageDomain.open(). */
export function projectionCacheTableFromContext(ctx) {
  try {
    const facility = contextService(ctx, 'storageDomain')
    if (!facility || typeof facility.get !== 'function') return undefined
    const domain = facility.get('session_projcache')
    if (!domain || typeof domain.table !== 'function') return undefined
    const table = domain.table('sessions')
    if (!table || typeof table.delete !== 'function' || typeof table.keys !== 'function'
      || typeof table.update !== 'function' || typeof table.put !== 'function') return undefined
    return table
  } catch {
    return undefined
  }
}

export async function pruneProjectionCacheFromContext(ctx, sessionId) {
  try {
    const table = projectionCacheTableFromContext(ctx)
    if (!table) return { pruned: false, reason: 'unavailable' }
    let snapshot
    let captured = false
    // Queue the no-op update and delete back-to-back before awaiting either.
    // This is an atomic queue barrier: pre-existing puts (including the
    // session/disposed listener's synchronous table.put prefix) land before
    // capture; later puts land after delete, with no enqueue window between
    // the pair. Deletion separately rejects every still-attached session, so
    // no new turn/end or interval work can be initiated through a live session.
    const capture = table.update(sessionId, (current) => {
      snapshot = current
      captured = true
      return current
    })
    const deletion = table.delete(sessionId)
    const [captureResult, deletionResult] = await Promise.allSettled([capture, deletion])
    if (deletionResult.status === 'rejected') throw deletionResult.reason
    const deleted = deletionResult.value
    if (deleted !== true && captureResult.status === 'rejected'
      && captureResult.reason?.code !== 'missing-key') {
      throw captureResult.reason
    }
    return deleted === true
      ? {
          pruned: true,
          restore: async () => {
            if (!captured) throw new Error('projection snapshot unavailable for rollback')
            await table.put(sessionId, snapshot)
          },
        }
      : { pruned: false, reason: 'not-found' }
  } catch (error) {
    return { pruned: false, reason: conciseReason(error) }
  }
}

/**
 * Reconcile the projection shortcut against durable session headers once at startup.
 * The empty-authority guard deliberately prefers stale cache rows over a destructive
 * false zero from a broken persistence backend.
 */
export async function reconcileProjectionCache(options = {}) {
  const persistence = options.sessionPersistence
  const table = options.table
  const logger = options.logger ?? { info() {}, warn() {} }
  if (!persistence || typeof persistence.list !== 'function' || !table
    || typeof table.keys !== 'function' || typeof table.delete !== 'function') {
    return { pruned: 0, failed: 0, reason: 'unavailable' }
  }

  let cacheIds
  try {
    cacheIds = [...table.keys()].filter((id) => typeof id === 'string')
  } catch (error) {
    logger.warn(`[agos] projcache reconciliation skipped: ${conciseReason(error)}`)
    return { pruned: 0, failed: 0, reason: 'cache-unavailable' }
  }

  let headers
  try {
    headers = await persistence.list()
    if (!Array.isArray(headers)) throw new Error('sessionPersistence.list() did not return an array')
  } catch (error) {
    logger.warn(`[agos] projcache reconciliation skipped: ${conciseReason(error)}`)
    return { pruned: 0, failed: 0, reason: 'authority-unavailable' }
  }

  const authoritative = new Set(headers
    .map((header) => header && header.id)
    .filter((id) => typeof id === 'string' && id.length > 0))
  if (cacheIds.length > 0 && authoritative.size === 0) {
    logger.warn(`[agos] projcache reconciliation refused empty authority for ${cacheIds.length} cached sessions`)
    return { pruned: 0, failed: 0, reason: 'empty-authority-guard' }
  }

  const limit = Math.min(200, Math.max(0, Number.isSafeInteger(options.limit) ? options.limit : 200))
  const allGhosts = cacheIds.filter((id) => !authoritative.has(id))
  const ghosts = allGhosts.slice(0, limit)
  let pruned = 0
  let failed = 0
  for (const id of ghosts) {
    try {
      const deleted = await table.delete(id)
      if (deleted === true) pruned += 1
      logger.info(`[agos] projcache reconciliation ${id}: ${deleted === true ? 'pruned' : 'already absent'}`)
    } catch (error) {
      failed += 1
      logger.warn(`[agos] projcache reconciliation ${id}: ${conciseReason(error)}`)
    }
  }
  return { pruned, failed, considered: ghosts.length, remaining: allGhosts.length - ghosts.length }
}

/**
 * 可注入的会话管理内核。测试传入临时 dshRoot/时钟/宿主读取器，生产默认
 * 只落到 ~/.dsh；所有 read-modify-write 和删除共用一条串行队列。
 */
export function createAgosSessionManager(options = {}) {
  const dshRoot = resolve(options.dshRoot ?? join(homedir(), '.dsh'))
  const sessionsRoot = resolve(options.sessionsRoot ?? join(dshRoot, 'sessions'))
  const agosRoot = resolve(options.agosRoot ?? join(dshRoot, 'agos'))
  const metaPath = join(agosRoot, 'session-meta.json')
  const deleteLogPath = join(agosRoot, 'delete.log')
  const now = typeof options.now === 'function' ? options.now : () => new Date()
  const readHostArchived = typeof options.readHostArchived === 'function'
    ? options.readHostArchived : async () => ({ hostArchived: [], hostArchivedAvailable: false })
  // 未注入判据时默认 unavailable(不是「未运行/已分离」)—— 删除因此 fail-closed。
  const readRunning = typeof options.readRunning === 'function'
    ? options.readRunning
    : async () => ({ available: false, running: false, reason: '未注入运行态判据(readRunning)' })
  const readAttached = typeof options.readAttached === 'function'
    ? options.readAttached
    : async () => ({ available: false, attached: false, reason: '未注入挂载态判据(readAttached)' })
  const pruneProjectionCache = typeof options.pruneProjectionCache === 'function'
    ? options.pruneProjectionCache : async () => ({ pruned: false, reason: 'unavailable' })
  const sessionMemory = options.sessionMemory
  const beginSessionMemoryDelete = sessionMemory && typeof sessionMemory.beginDelete === 'function'
    ? (sessionId) => sessionMemory.beginDelete(sessionId)
    : async () => ({ prune: async () => false, undo: async () => undefined, commit: async () => undefined })
  const readSessionMemory = sessionMemory && typeof sessionMemory.get === 'function'
    ? (sessionId) => sessionMemory.get(sessionId)
    : async (sessionId) => ({
        version: 1, sessionId, status: 'empty', items: [],
        counts: { total: 0, fact: 0, constraint: 0, preference: 0, rejected: 0 },
        skippedSensitive: 0, updatedAt: null,
      })
  let mutationTail = Promise.resolve()

  const enqueueMutation = (operation) => {
    const result = mutationTail.then(operation)
    mutationTail = result.then(() => undefined, () => undefined)
    return result
  }

  const ensureDshRoot = async () => {
    try {
      const identity = await lstat(dshRoot)
      if (!identity.isDirectory() || identity.isSymbolicLink()) {
        throw new HttpRouteError(403, 'DSH_ROOT_INVALID', '.dsh 根路径必须是实体目录')
      }
    } catch (error) {
      if (!(error && error.code === 'ENOENT')) throw error
      await mkdir(dshRoot, { recursive: true, mode: 0o700 })
    }
    const rootReal = await realpath(dshRoot)
    if (!(await stat(rootReal)).isDirectory()) throw new HttpRouteError(403, 'DSH_ROOT_INVALID', '.dsh 根路径不是目录')
    return rootReal
  }

  const ensureAgosRoot = async (create) => {
    if (dirname(agosRoot) !== dshRoot || basename(agosRoot) !== 'agos') {
      throw new HttpRouteError(403, 'AGOS_ROOT_INVALID', 'agosRoot 必须是 .dsh/agos')
    }
    const dshReal = await ensureDshRoot()
    let identity
    try {
      identity = await lstat(agosRoot)
    } catch (error) {
      if (!(error && error.code === 'ENOENT')) throw error
      if (!create) return undefined
      await mkdir(agosRoot, { recursive: false, mode: 0o700 })
      identity = await lstat(agosRoot)
    }
    if (!identity.isDirectory() || identity.isSymbolicLink()) {
      throw new HttpRouteError(403, 'AGOS_ROOT_INVALID', 'agosRoot 不能是符号链接')
    }
    const agosReal = await realpath(agosRoot)
    if (!isDirectChild(dshReal, agosReal) || basename(agosReal) !== 'agos') {
      throw new HttpRouteError(403, 'AGOS_ROOT_ESCAPE', 'agosRoot 越出 .dsh 根路径')
    }
    const after = await lstat(agosReal)
    if (!after.isDirectory() || after.isSymbolicLink()) {
      throw new HttpRouteError(403, 'AGOS_ROOT_INVALID', 'agosRoot 不是实体目录')
    }
    return agosReal
  }

  const readMeta = async () => {
    const safeRoot = await ensureAgosRoot(false)
    if (safeRoot === undefined) return normalizeSessionMeta(undefined)
    const safeMetaPath = join(safeRoot, 'session-meta.json')
    try {
      const identity = await lstat(safeMetaPath)
      if (!identity.isFile() || identity.isSymbolicLink()) {
        throw new HttpRouteError(403, 'SESSION_META_PATH_INVALID', 'session-meta.json 必须是实体文件')
      }
      if (typeof FS_CONSTANTS.O_NOFOLLOW !== 'number') {
        throw new HttpRouteError(500, 'NOFOLLOW_UNAVAILABLE', '当前平台缺少安全文件打开能力')
      }
      const handle = await open(safeMetaPath, FS_CONSTANTS.O_RDONLY | FS_CONSTANTS.O_NOFOLLOW)
      try {
        return normalizeSessionMeta(JSON.parse(await handle.readFile({ encoding: 'utf8' })))
      } finally {
        await handle.close()
      }
    } catch (error) {
      if (error instanceof HttpRouteError) throw error
      if (error && error.code === 'ENOENT') return normalizeSessionMeta(undefined)
      if (error instanceof SyntaxError) {
        throw new HttpRouteError(500, 'SESSION_META_CORRUPT', 'session-meta.json 不是合法 JSON')
      }
      throw error
    }
  }

  const writeMeta = async (meta) => {
    const safeRoot = await ensureAgosRoot(true)
    const safeMetaPath = join(safeRoot, 'session-meta.json')
    try {
      const identity = await lstat(safeMetaPath)
      if (!identity.isFile() || identity.isSymbolicLink()) {
        throw new HttpRouteError(403, 'SESSION_META_PATH_INVALID', 'session-meta.json 必须是实体文件')
      }
    } catch (error) {
      if (error instanceof HttpRouteError) throw error
      if (!(error && error.code === 'ENOENT')) throw error
    }
    const temp = join(safeRoot, `.session-meta.${process.pid}.${randomUUID()}.tmp`)
    try {
      await writeFile(temp, JSON.stringify(meta, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
      await rename(temp, safeMetaPath)
    } catch (error) {
      try { await unlink(temp) } catch {}
      throw error
    }
  }

  const appendDeleteAudit = async (record) => {
    const safeRoot = await ensureAgosRoot(true)
    const safeLogPath = join(safeRoot, 'delete.log')
    try {
      const identity = await lstat(safeLogPath)
      if (!identity.isFile() || identity.isSymbolicLink()) {
        throw new HttpRouteError(403, 'DELETE_LOG_PATH_INVALID', 'delete.log 必须是实体文件')
      }
    } catch (error) {
      if (error instanceof HttpRouteError) throw error
      if (!(error && error.code === 'ENOENT')) throw error
    }
    if (typeof FS_CONSTANTS.O_NOFOLLOW !== 'number') {
      throw new HttpRouteError(500, 'NOFOLLOW_UNAVAILABLE', '当前平台缺少安全文件打开能力')
    }
    const flags = FS_CONSTANTS.O_APPEND | FS_CONSTANTS.O_CREAT | FS_CONSTANTS.O_WRONLY | FS_CONSTANTS.O_NOFOLLOW
    const handle = await open(safeLogPath, flags, 0o600)
    try {
      await handle.writeFile(JSON.stringify(record) + '\n')
      await handle.sync()
    } finally {
      await handle.close()
    }
  }

  const mutateFlag = (field, sessionId, enabled) => enqueueMutation(async () => {
    validateSessionId(sessionId)
    if (typeof enabled !== 'boolean') {
      throw new HttpRouteError(400, 'INVALID_BOOLEAN', `${field === 'pinned' ? 'pinned' : 'archived'} 必须是 boolean`)
    }
    const meta = await readMeta()
    const before = meta[field]
    const set = new Set(before)
    if (enabled) set.add(sessionId)
    else set.delete(sessionId)
    const nextValues = [...set]
    if (nextValues.length === before.length && nextValues.every((value, index) => value === before[index])) {
      return publicSessionMeta(meta)
    }
    const next = { ...meta, [field]: nextValues, updatedAt: now().toISOString() }
    await writeMeta(next)
    return publicSessionMeta(next)
  })

  const findSessionDirectory = async (sessionId) => {
    const encoded = encodeSessionSegment(sessionId)
    let rootReal
    try {
      const rootIdentity = await lstat(sessionsRoot)
      if (!rootIdentity.isDirectory() || rootIdentity.isSymbolicLink()) {
        throw new HttpRouteError(403, 'SESSION_ROOT_INVALID', 'sessions 根路径不能是符号链接')
      }
      rootReal = await realpath(sessionsRoot)
    } catch (error) {
      if (error instanceof HttpRouteError) throw error
      if (error && error.code === 'ENOENT') {
        throw new HttpRouteError(404, 'SESSION_NOT_FOUND', `未找到会话 ${sessionId}`)
      }
      throw error
    }
    if (!(await stat(rootReal)).isDirectory()) {
      throw new HttpRouteError(409, 'SESSION_ROOT_INVALID', '会话根路径不是目录')
    }

    const matches = new Map()
    for (const projectEntry of await readdir(rootReal, { withFileTypes: true })) {
      if (!projectEntry.isDirectory()) continue
      const projectLexical = join(rootReal, projectEntry.name)
      const projectIdentity = await lstat(projectLexical)
      if (!projectIdentity.isDirectory() || projectIdentity.isSymbolicLink()) continue
      let projectReal
      try { projectReal = await realpath(projectLexical) } catch { continue }
      // 不读取指向根外的项目目录；合法 projectKey 必须是 sessions 的直接子项。
      if (!isWithin(rootReal, projectReal) || !isDirectChild(rootReal, projectReal)) continue
      let entries
      try { entries = await readdir(projectReal, { withFileTypes: true }) } catch { continue }
      const entry = entries.find((candidate) => candidate.name === encoded)
      if (!entry) continue
      const candidateLexical = join(projectReal, entry.name)
      let candidateReal
      try { candidateReal = await realpath(candidateLexical) } catch { continue }
      if (!isWithin(rootReal, candidateReal)
        || !isDirectChild(projectReal, candidateReal)
        || !isDirectChild(rootReal, projectReal)) {
        throw new HttpRouteError(403, 'SESSION_PATH_ESCAPE', '会话目录越出 sessions 根路径')
      }
      const identity = await lstat(candidateLexical)
      if (!identity.isDirectory() || identity.isSymbolicLink()) {
        throw new HttpRouteError(403, 'SESSION_PATH_INVALID', '会话目录不能是符号链接')
      }
      matches.set(candidateReal, { source: candidateReal, projectKey: basename(projectReal), sessionDir: entry.name })
    }
    if (matches.size === 0) throw new HttpRouteError(404, 'SESSION_NOT_FOUND', `未找到会话 ${sessionId}`)
    if (matches.size > 1) throw new HttpRouteError(409, 'SESSION_DUPLICATE', `会话 ${sessionId} 出现在多个项目目录`)
    return [...matches.values()][0]
  }

  const assertNotRunning = async (sessionId) => {
    const status = normalizeRunningStatus(await readRunning(sessionId))
    if (!status.available) {
      // 未知 ≠ 未运行:拿不到权威状态就拒绝,不放行。
      throw new HttpRouteError(
        503,
        'RUNNING_STATUS_UNAVAILABLE',
        `暂时无法确认会话运行状态，未执行删除${status.reason ? `（${status.reason}）` : ''}`,
      )
    }
    if (status.running) {
      throw new HttpRouteError(409, 'SESSION_RUNNING', '会话正在运行，请先中止')
    }
  }

  const assertDetached = async (sessionId) => {
    const status = normalizeAttachedStatus(await readAttached(sessionId))
    if (!status.available) {
      // 未知 ≠ 已分离。理由带进响应,否则运维只看到裸 503 无从下手。
      throw new HttpRouteError(
        503,
        'LIVE_STATUS_UNAVAILABLE',
        `暂时无法确认会话是否仍挂载，未执行删除${status.reason ? `（${status.reason}）` : ''}`,
      )
    }
    if (status.attached) {
      throw new HttpRouteError(409, 'SESSION_LIVE', '会话仍挂载在宿主中，请先关闭会话再删除')
    }
  }

  const ensurePlainChildDirectory = async (parentReal, lexicalPath, code, message) => {
    let identity
    try {
      identity = await lstat(lexicalPath)
    } catch (error) {
      if (!(error && error.code === 'ENOENT')) throw error
      await mkdir(lexicalPath, { recursive: false, mode: 0o700 })
      identity = await lstat(lexicalPath)
    }
    if (!identity.isDirectory() || identity.isSymbolicLink()) {
      throw new HttpRouteError(403, code, message)
    }
    const actual = await realpath(lexicalPath)
    if (!isDirectChild(parentReal, actual)) throw new HttpRouteError(403, code, message)
    const after = await lstat(actual)
    if (!after.isDirectory() || after.isSymbolicLink()) throw new HttpRouteError(403, code, message)
    return actual
  }

  const prepareTrashProject = async ({ projectKey }, date) => {
    const dshReal = await ensureDshRoot()
    const trashLexical = join(dshRoot, `sessions-trash-${localDateStamp(date)}`)
    if (dirname(trashLexical) !== dshRoot) throw new HttpRouteError(500, 'TRASH_PATH_INVALID', '回收站根路径无效')
    const trashReal = await ensurePlainChildDirectory(
      dshReal, trashLexical, 'TRASH_PATH_INVALID', '回收站根路径必须是 .dsh 下的实体目录',
    )
    const projectTrash = join(trashReal, projectKey)
    return ensurePlainChildDirectory(
      trashReal, projectTrash, 'TRASH_PROJECT_INVALID', '回收站项目路径必须是实体目录',
    )
  }

  const readDeleteLock = async (path) => {
    const identity = await lstat(path)
    if (!identity.isFile() || identity.isSymbolicLink()) {
      throw new HttpRouteError(403, 'DELETE_LOCK_INVALID', '删除锁路径不是实体文件')
    }
    if (typeof FS_CONSTANTS.O_NOFOLLOW !== 'number') {
      throw new HttpRouteError(500, 'NOFOLLOW_UNAVAILABLE', '当前平台缺少安全文件打开能力')
    }
    const handle = await open(path, FS_CONSTANTS.O_RDONLY | FS_CONSTANTS.O_NOFOLLOW)
    try {
      let value
      try { value = JSON.parse(await handle.readFile({ encoding: 'utf8' })) } catch { value = {} }
      return { identity, value }
    } finally {
      await handle.close()
    }
  }

  const ownerAlive = (pid) => {
    if (!Number.isSafeInteger(pid) || pid <= 0) return false
    try { process.kill(pid, 0); return true } catch (error) { return error && error.code === 'EPERM' }
  }

  const reclaimStaleLock = async (lockPath) => {
    let observed
    try { observed = await readDeleteLock(lockPath) } catch (error) {
      if (error && error.code === 'ENOENT') return true
      throw error
    }
    if (Date.now() - observed.identity.mtimeMs <= DELETE_LOCK_STALE_MS || ownerAlive(observed.value.pid)) return false
    const quarantine = lockPath + `.stale.${randomUUID()}`
    try {
      await rename(lockPath, quarantine)
    } catch (error) {
      if (error && error.code === 'ENOENT') return true
      throw error
    }
    try {
      const moved = await readDeleteLock(quarantine)
      if (observed.value.token !== undefined && moved.value.token !== observed.value.token) {
        try { await rename(quarantine, lockPath) } catch {}
        return false
      }
      await unlink(quarantine)
      return true
    } catch (error) {
      try { await rename(quarantine, lockPath) } catch {}
      throw error
    }
  }

  const acquireDeleteLock = async (projectTrashReal, projectKey, sessionDir) => {
    if (typeof FS_CONSTANTS.O_NOFOLLOW !== 'number') {
      throw new HttpRouteError(500, 'NOFOLLOW_UNAVAILABLE', '当前平台缺少安全文件打开能力')
    }
    const digest = createHash('sha256').update(projectKey + '\0' + sessionDir).digest('hex')
    const lockPath = join(projectTrashReal, `.agos-delete-${digest}.lock`)
    const token = randomUUID()
    const flags = FS_CONSTANTS.O_CREAT | FS_CONSTANTS.O_EXCL | FS_CONSTANTS.O_WRONLY | FS_CONSTANTS.O_NOFOLLOW
    for (let attempt = 0; attempt < 3; attempt += 1) {
      let handle
      let openedIdentity
      try {
        handle = await open(lockPath, flags, 0o600)
        openedIdentity = await handle.stat()
        await handle.writeFile(JSON.stringify({ token, pid: process.pid, createdAt: new Date().toISOString() }) + '\n')
        await handle.sync()
        await handle.close()
        handle = undefined
        return async () => {
          try {
            const current = await readDeleteLock(lockPath)
            if (current.value.token === token) await unlink(lockPath)
          } catch (error) {
            if (!(error && error.code === 'ENOENT')) throw error
          }
        }
      } catch (error) {
        if (handle) {
          try { await handle.close() } catch {}
          // 只清理由本次 O_EXCL open 创建、且仍是同一 inode 的锁，绝不
          // 因失败清理而 unlink 一个在窗口内被替换的外部文件。
          if (openedIdentity) {
            try {
              const current = await lstat(lockPath)
              if (current.dev === openedIdentity.dev && current.ino === openedIdentity.ino) await unlink(lockPath)
            } catch {}
          }
        }
        if (!(error && error.code === 'EEXIST')) throw error
        if (await reclaimStaleLock(lockPath)) continue
        throw new HttpRouteError(409, 'DELETE_BUSY', '另一个进程正在处理该会话')
      }
    }
    throw new HttpRouteError(409, 'DELETE_BUSY', '无法取得会话删除锁')
  }

  const moveToAvailableDestination = async (source, projectTrashReal, sessionDir, commitRename) => {
    for (let suffix = 1; suffix < 10000; suffix += 1) {
      const name = suffix === 1 ? sessionDir : `${sessionDir}-${suffix}`
      const candidate = join(projectTrashReal, name)
      let reservation
      try {
        // mkdir 是候选名的原子预留；现有路径只会触发 EEXIST 并选择后缀。
        // O_EXCL owner-token 锁同时覆盖选择与 rename，保护插件跨进程/热重载。
        // Node 无跨平台 rename-noreplace；外部恶意进程仍可能在两个 syscall
        // 之间替换空占位，故 rename 前复核 inode，失败清理也只碰自己的占位。
        await mkdir(candidate, { recursive: false, mode: 0o700 })
        reservation = await lstat(candidate)
        if (!reservation.isDirectory() || reservation.isSymbolicLink()) {
          throw new HttpRouteError(409, 'TRASH_TARGET_RACED', '回收目标在预留期间被替换')
        }
        const beforeMove = await lstat(candidate)
        if (beforeMove.dev !== reservation.dev || beforeMove.ino !== reservation.ino) {
          throw new HttpRouteError(409, 'TRASH_TARGET_RACED', '回收目标在预留期间被替换')
        }
        if (typeof commitRename === 'function') await commitRename(candidate, reservation)
        else await rename(source, candidate)
        return candidate
      } catch (error) {
        if (reservation) {
          try {
            const current = await lstat(candidate)
            if (current.dev === reservation.dev && current.ino === reservation.ino) await rmdir(candidate)
          } catch {}
        }
        if (error && error.code === 'EEXIST') continue
        throw error
      }
    }
    throw new HttpRouteError(409, 'TRASH_NAME_EXHAUSTED', '回收站同名目录过多')
  }

  const trash = (rawSessionId) => enqueueMutation(async () => {
    const sessionId = validateSessionId(rawSessionId)
    await assertNotRunning(sessionId)
    await assertDetached(sessionId)
    const located = await findSessionDirectory(sessionId)
    const at = now()
    const projectTrashReal = await prepareTrashProject(located, at)
    const releaseLock = await acquireDeleteLock(projectTrashReal, located.projectKey, located.sessionDir)
    let memoryDelete
    let memorySettled = false
    try {
      // Establish the tombstone before any await that can commit deletion. An
      // already-queued idle extraction either drains before this snapshot or
      // observes the new generation and cannot resurrect the file afterwards.
      memoryDelete = await beginSessionMemoryDelete(sessionId)
      const meta = await readMeta()
      const metaChanged = meta.pinned.includes(sessionId) || meta.archived.includes(sessionId)
      const next = {
        ...meta,
        pinned: meta.pinned.filter((id) => id !== sessionId),
        archived: meta.archived.filter((id) => id !== sessionId),
        updatedAt: at.toISOString(),
      }
      const destination = await moveToAvailableDestination(
        located.source,
        projectTrashReal,
        located.sessionDir,
        async (candidate, reservation) => {
          if (typeof options.beforeFinalDeleteCheck === 'function') await options.beforeFinalDeleteCheck(candidate)
          // Target reservation and metadata reads are complete. These checks
          // sit directly beside rename; attached is last because a newly
          // running agent necessarily owns an attached session.
          await assertNotRunning(sessionId)
          await assertDetached(sessionId)
          // Revalidate the exact reservation after the async registry checks;
          // an external process may have replaced it while those were pending.
          let finalTarget
          try {
            finalTarget = await lstat(candidate)
          } catch {
            throw new HttpRouteError(409, 'TRASH_TARGET_RACED', '回收目标在最终检查期间缺失或无法验证')
          }
          if (!finalTarget.isDirectory() || finalTarget.isSymbolicLink()
            || finalTarget.dev !== reservation.dev || finalTarget.ino !== reservation.ino) {
            throw new HttpRouteError(409, 'TRASH_TARGET_RACED', '回收目标在最终检查期间被替换')
          }
          // No await between the final inode comparison and invoking rename.
          // The host exposes no registry lock spanning the syscall, so an
          // external attach in this remaining synchronous window is irreducible.
          await rename(located.source, candidate)
        },
      )
      let metaCommitted = false
      let projectionResult = { pruned: false, reason: 'not-attempted', restore: undefined }
      let sessionMemoryPruned = false
      try {
        if (metaChanged) {
          await writeMeta(next)
          metaCommitted = true
        }
        try {
          const value = await pruneProjectionCache(sessionId)
          projectionResult = value && typeof value === 'object'
            ? {
                pruned: value.pruned === true,
                reason: value.reason ?? (value.pruned === true ? undefined : 'unspecified'),
                restore: typeof value.restore === 'function' ? value.restore : undefined,
              }
            : { pruned: false, reason: 'invalid-result', restore: undefined }
        } catch (error) {
          // The session directory move is the user-visible commit. Projection
          // pruning is a shortcut cleanup and must never roll that move back.
          projectionResult = { pruned: false, reason: conciseReason(error), restore: undefined }
        }
        sessionMemoryPruned = await memoryDelete.prune()
        const record = {
          at: at.toISOString(), sessionId, trashedTo: destination,
          projcachePruned: projectionResult.pruned,
          sessionMemoryPruned,
          ...(projectionResult.pruned || !projectionResult.reason
            ? {} : { projcacheReason: conciseReason(projectionResult.reason) }),
        }
        if (typeof options.beforeDeleteLog === 'function') await options.beforeDeleteLog(record)
        await appendDeleteAudit(record)
        await memoryDelete.commit()
        memorySettled = true
      } catch (error) {
        const rollbackErrors = []
        let sourceOccupied = false
        let directoryRestored = false
        try { await lstat(located.source); sourceOccupied = true } catch (checkError) {
          if (!(checkError && checkError.code === 'ENOENT')) rollbackErrors.push(checkError)
        }
        if (sourceOccupied) {
          rollbackErrors.push(new Error('源会话路径已被重建；为避免覆盖，保留回收站副本'))
        } else if (rollbackErrors.length === 0) {
          try {
            await rename(destination, located.source)
            directoryRestored = true
          } catch (rollbackError) { rollbackErrors.push(rollbackError) }
        }
        // 只有目录确实恢复后才恢复旧元数据，避免 pin/archive 指向被删除的路径。
        if (metaCommitted && directoryRestored) {
          try { await writeMeta(meta) } catch (rollbackError) { rollbackErrors.push(rollbackError) }
        }
        // Projection pruning is reversible for the same reason as metadata:
        // an audit failure that restores the durable session must restore its
        // exact cached enrichment row. A failed restore is never hidden.
        if (projectionResult.pruned && directoryRestored) {
          if (typeof projectionResult.restore !== 'function') {
            rollbackErrors.push(new Error('投影缓存已剪枝但缺少恢复句柄'))
          } else {
            try { await projectionResult.restore() } catch (rollbackError) {
              rollbackErrors.push(new Error(`投影缓存恢复失败: ${conciseReason(rollbackError)}`))
            }
          }
        }
        // Session memory participates in the same commit. Restore its exact
        // pre-delete bytes only when the durable session directory was also
        // restored; if a new source appeared, retaining old memory would bind
        // stale facts to a different session incarnation.
        if (directoryRestored) {
          try {
            await memoryDelete.undo()
            memorySettled = true
          } catch (rollbackError) {
            rollbackErrors.push(new Error(`会话记忆恢复失败: ${conciseReason(rollbackError)}`))
          }
        } else {
          try {
            await memoryDelete.commit()
            memorySettled = true
          } catch (rollbackError) {
            rollbackErrors.push(new Error(`会话记忆提交失败: ${conciseReason(rollbackError)}`))
          }
        }
        if (rollbackErrors.length > 0) {
          throw new AggregateError(
            [error, ...rollbackErrors],
            `删除提交失败，且补偿未完整完成: ${rollbackErrors.map(conciseReason).join('; ')}`,
          )
        }
        throw error
      }
      return { trashedTo: destination, sessionMemoryPruned }
    } catch (error) {
      // Failures before the directory move (target race, final liveness check,
      // metadata read) still have to release the tombstone.
      if (memoryDelete && !memorySettled) {
        try {
          await memoryDelete.undo()
          memorySettled = true
        } catch (rollbackError) {
          throw new AggregateError(
            [error, rollbackError],
            `删除提交失败，且会话记忆补偿失败: ${conciseReason(rollbackError)}`,
          )
        }
      }
      throw error
    } finally {
      try { await releaseLock() } catch {}
    }
  })

  return {
    paths: { dshRoot, sessionsRoot, agosRoot, metaPath, deleteLogPath },
    async get() {
      // 避免 GET 撞上 delete 的 move→meta→log 提交窗口而观察到半状态。
      await mutationTail
      const meta = await readMeta()
      let host
      try {
        const value = await readHostArchived()
        host = parseHostArchived(value) ?? (value && Array.isArray(value.hostArchived)
          ? { hostArchived: uniqueStrings(value.hostArchived), hostArchivedAvailable: value.hostArchivedAvailable === true }
          : undefined)
      } catch {}
      return {
        ...publicSessionMeta(meta),
        hostArchived: host?.hostArchived ?? [],
        hostArchivedAvailable: host?.hostArchivedAvailable === true,
      }
    },
    pin(sessionId, pinned) { return mutateFlag('pinned', sessionId, pinned) },
    archive(sessionId, archived) { return mutateFlag('archived', sessionId, archived) },
    async memory(rawSessionId) {
      const sessionId = validateSessionId(rawSessionId)
      // Hide the prune→audit→undo transaction window. A failed delete must
      // never make concurrent readers observe a transient missing projection.
      await mutationTail
      return readSessionMemory(sessionId)
    },
    trash,
  }
}

async function readJsonBody(req) {
  const chunks = []
  let bytes = 0
  for await (const chunk of req) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    bytes += value.length
    if (bytes > JSON_BODY_LIMIT) throw new HttpRouteError(413, 'BODY_TOO_LARGE', '请求体过大')
    chunks.push(value)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
  } catch {
    throw new HttpRouteError(400, 'INVALID_JSON', '请求体不是合法 JSON')
  }
}

function sendJson(res, status, value, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers })
  res.end(JSON.stringify(value))
}

function sendRouteError(res, error) {
  if (error instanceof HttpRouteError) {
    sendJson(res, error.status, { error: error.message, code: error.code })
    return
  }
  sendJson(res, 500, { error: String((error && error.message) || error), code: 'INTERNAL' })
}

/** Build the four exact HTTP handlers around an injected manager. */
export function createAgosSessionRouteHandlers(manager) {
  const route = (path, method, operation) => [path, async (req, res) => {
    // 顺带记下自身 origin,供 runningFromRpc 内调(见该函数注释)
    if (!selfOrigin && req.headers && req.headers.host) selfOrigin = `http://${req.headers.host}`
    if (req.method !== method) {
      sendJson(res, 405, { error: `${method} only` }, { allow: method })
      return
    }
    try {
      const body = method === 'POST' ? await readJsonBody(req) : undefined
      sendJson(res, 200, await operation(body, req))
    } catch (error) {
      sendRouteError(res, error)
    }
  }]
  return [
    route('/api/agos/session-meta', 'GET', () => manager.get()),
    route('/api/agos/session-meta/pin', 'POST', (body) => manager.pin(body && body.sessionId, body && body.pinned)),
    route('/api/agos/session-meta/archive', 'POST', (body) => manager.archive(body && body.sessionId, body && body.archived)),
    route('/api/agos/session-memory', 'GET', (_body, req) => {
      const sessionId = new URL(req.url, 'http://x').searchParams.get('sessionId')
      return manager.memory(sessionId)
    }),
    route('/api/agos/session/delete', 'POST', (body) => manager.trash(body && body.sessionId)),
  ]
}

// ── AgOS SPA 静态面(P4-lite:与原 web UI 并存)────────────────────────────
// 自有前端(agos-frontend,vite base=/agos/)由本插件直接 serve:
// 同源 → /api 与两条 WS 全部直连,零代理零 Origin 问题。
// dist 路径可用 DSH_AGOS_DIST 覆盖(仓库将来搬家只改 env)。
const SPA_DIST = process.env.DSH_AGOS_DIST
  // 2026-08-21 迁出 ~/Documents:那是 macOS TCC 保护目录,未授权的进程读它会
  // 静默失败(静态路由挂起而 /api/* 照常 200),本会话真实踩中两次。~/Projects 不受 TCC 管辖。
  // 2026-08-24 AgOS 合成产品仓 ~/Projects/agos:前端在 frontend/;旧路径 ~/Projects/agos-frontend 留软链,
  // 这里直接指新路径,软链只为旧进程/脚本兜底。
  ?? join(homedir(), 'Projects', 'agos', 'frontend', 'dist')
const SPA_MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.map': 'application/json',
  '.svg': 'image/svg+xml', '.json': 'application/json',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.png': 'image/png', '.ico': 'image/x-icon',
}

async function serveSpa(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'content-type': 'text/plain' }); res.end('GET only'); return
  }
  const url = new URL(req.url, 'http://x')
  let rel = decodeURIComponent(url.pathname.replace(/^\/agos\/?/, ''))
  if (rel === '' ) rel = 'index.html'
  let file = resolve(SPA_DIST, rel)
  // 越界防护 + SPA 回退(无扩展名的前端路由一律回 index.html)
  if (!file.startsWith(resolve(SPA_DIST) + sep) && file !== resolve(SPA_DIST, 'index.html')) {
    res.writeHead(403, { 'content-type': 'text/plain' }); res.end('forbidden'); return
  }
  if (!existsSync(file) || extname(file) === '') file = join(SPA_DIST, 'index.html')
  if (!existsSync(file)) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('AgOS SPA dist 不存在:' + SPA_DIST + '(先 npm run build,或设 DSH_AGOS_DIST)')
    return
  }
  const body = await readFile(file)
  res.writeHead(200, {
    'content-type': SPA_MIME[extname(file)] ?? 'application/octet-stream',
    'cache-control': extname(file) === '.html' ? 'no-cache' : 'public, max-age=604800, immutable',
  })
  res.end(req.method === 'HEAD' ? undefined : body)
}

// ── 装配:路由表 + 统一 disposers ─────────────────────────────────────────
let startupReconciliationStarted = false

export function bindSessionMemoryObserver(ctx, sessionMemory) {
  if (!sessionMemory || typeof sessionMemory.capture !== 'function') return () => {}
  const disposers = []
  try {
    if (typeof ctx?.on === 'function') {
      const created = ctx.on('agent/created', ({ agent }) => {
        try {
          sessionMemory.activate(agent.id)
          sessionMemory.capture(agent)
        } catch {}
      })
      const status = ctx.on('agent/status', ({ agent, status: next }) => {
        if (next !== 'idle') return
        try { sessionMemory.capture(agent) } catch {}
      })
      if (typeof created === 'function') disposers.push(created)
      if (typeof status === 'function') disposers.push(status)
    }
    // Hot-load adoption: an already-idle agent will not emit another status
    // transition until it runs, so capture the current immutable view once.
    const agents = contextService(ctx, 'agents')
    if (agents && typeof agents.list === 'function') {
      for (const agent of agents.list()) {
        if (!agent || agent.status !== 'idle') continue
        try {
          sessionMemory.activate(agent.id)
          sessionMemory.capture(agent)
        } catch {}
      }
    }
  } catch {}
  return () => {
    for (const dispose of disposers.splice(0)) { try { dispose() } catch {} }
  }
}

/** Skills is visible only inside its Cordis injection fiber. */
export function bindRuntimeSkillCatalogTrim(ctx, options = {}) {
  let skills = null
  let disposeSkills
  if (typeof ctx?.inject === 'function') {
    disposeSkills = ctx.inject(['skills'], (ready) => {
      const service = contextService(ready, 'skills')
      skills = service
      return () => { if (skills === service) skills = null }
    })
  }
  const disposeTrim = bindCatalogTrim(ctx, {
    ...options,
    snapshot: async (event) => {
      const agent = event?.agent
      const cwd = agent?.session?.header?.cwd
      if (!agent || typeof cwd !== 'string' || cwd.trim() === '' || typeof skills?.snapshot !== 'function') return null
      return skills.snapshot({ cwd, signal: event.signal, scope: agent })
    },
  })
  return () => {
    disposeTrim()
    if (typeof disposeSkills === 'function') disposeSkills()
    skills = null
  }
}

export function apply(ctx, options = {}) {
  const home = options.home ?? homedir()
  const dshRoot = join(home, '.dsh')
  const evolveStore = createSkillEvolveStore({ home })
  const sessionMemory = createSessionMemoryStore({ dshRoot })
  const turnEvidence = createTurnEvidenceStore({ home })
  const memoryRelevance = createSessionMemoryRelevanceStore({ home })
  if (typeof ctx.on === 'function') {
    bindRuntimeSkillCatalogTrim(ctx, {
      home,
      store: evolveStore,
      evidence: turnEvidence,
    })
    bindSessionMemoryInject(ctx, { home, store: sessionMemory, rank: memoryRelevance, evidence: turnEvidence })
  }
  return ctx.inject(['webServer'], (c) => {
    const disposers = []
    const ws = c.get('webServer')
    if (ws === undefined || typeof ws.register !== 'function') return
    let evolveRerank = null
    // cordis 的 inject 语义是「没注入就看不见」:本 fiber 只注入了 webServer,
    // 所以 c.get('storageDomain') 恒 undefined —— 删除时的剪枝会静默失败
    // (2026-08-21 验收实测:磁盘 4→3 而 projcache 停在 4)。
    // 下面那个 inject(['sessionPersistence','storageDomain']) 的 ctx 才看得见它,
    // 把它捕获下来给剪枝闭包用。
    let domainCtx
    const sessionManager = createAgosSessionManager({
      dshRoot,
      readHostArchived: () => hostArchivedFromContext(c),
      readRunning: (sessionId) => runningFromContext(c, sessionId),
      readAttached: (sessionId) => attachedFromContext(c, sessionId),
      pruneProjectionCache: (sessionId) => pruneProjectionCacheFromContext(domainCtx ?? c, sessionId),
      sessionMemory,
    })
    const routes = [
      ['/api/agos/skills', async (req, res) => {
        if (req.method !== 'GET') { sendJson(res, 405, { error: 'GET only' }, { allow: 'GET' }); return }
        const force = new URL(req.url, 'http://x').searchParams.get('refresh') === '1'
        sendJson(res, 200, await skillsPayload(force))
      }],
      ['/api/agos/skills/draft', async (req, res) => {
        if (req.method !== 'POST') { sendJson(res, 405, { error: 'POST only' }, { allow: 'POST' }); return }
        const result = await createSkillDraft(await readJsonBody(req), { home })
        if (!result.ok) {
          sendJson(res, result.status, { created: false, error: result.error, code: result.code })
          return
        }
        SKILLS_CACHE = null
        sendJson(res, 201, {
          created: true,
          name: result.name,
          path: result.path,
          evalsPath: result.evalsPath,
          pluginStub: result.pluginStub,
          pluginInstalled: false,
          root: result.root,
        })
      }],
      ['/api/agos/skills/studio', async (req, res) => {
        if (req.method !== 'GET') { sendJson(res, 405, { error: 'GET only' }, { allow: 'GET' }); return }
        const name = new URL(req.url, 'http://x').searchParams.get('name') ?? ''
        const result = await readStudioSkill(name, { home })
        if (!result.ok) {
          sendJson(res, result.status, { error: result.error, code: result.code })
          return
        }
        sendJson(res, 200, result)
      }],
      ['/api/agos/skills/description', async (req, res) => {
        if (req.method !== 'POST') { sendJson(res, 405, { error: 'POST only' }, { allow: 'POST' }); return }
        const result = await patchSkillDescription(await readJsonBody(req), { home })
        if (!result.ok) {
          sendJson(res, result.status, { error: result.error, code: result.code })
          return
        }
        SKILLS_CACHE = null
        sendJson(res, 200, result)
      }],
      ['/api/agos/skills/evolve', async (req, res) => {
        const liveCatalog = async () => {
          const data = await skillsPayload(false)
          return (data.catalog ?? []).filter((row) => row.servedToModel !== false)
        }
        if (req.method === 'GET') {
          const url = new URL(req.url, 'http://x')
          sendJson(res, 200, await evolveStore.propose({
            query: url.searchParams.get('query') ?? '',
            label: url.searchParams.get('label') ?? '',
            catalog: await liveCatalog(),
          }))
          return
        }
        if (req.method !== 'POST') {
          sendJson(res, 405, { error: 'GET or POST' }, { allow: 'GET, POST' })
          return
        }
        const body = await readJsonBody(req)
        if (body && body.action === 'propose') {
          if (body.rerank === true && body.confirm !== true) {
            sendJson(res, 400, { error: '小模型提案需要 confirm:true', code: 'CONFIRM_REQUIRED' })
            return
          }
          const report = await evolveStore.propose({
            query: body.query ?? '',
            label: body.label ?? '',
            catalog: await liveCatalog(),
          })
          sendJson(res, 200, body.rerank === true
            ? await applyOptionalRerank(report, evolveRerank)
            : report)
          return
        }
        const recorded = await evolveStore.recordOutcome(body)
        sendJson(res, recorded.ok ? 200 : recorded.status, recorded)
      }],
      ['/api/agos/skills/trim', async (req, res) => {
        if (req.method === 'GET') {
          const trim = catalogTrimConfig(home)
          sendJson(res, 200, {
            enabled: trim.enabled,
            maxEntries: trim.maxEntries,
            copy: trim.enabled ? CATALOG_TRIM_ON_COPY : CATALOG_TRIM_OFF_COPY,
          })
          return
        }
        if (req.method !== 'POST') {
          sendJson(res, 405, { error: 'GET or POST' }, { allow: 'GET, POST' })
          return
        }
        const result = await writeCatalogTrimConfig(await readJsonBody(req), { home })
        sendJson(res, result.ok ? 200 : result.status, result)
      }],
      ['/api/agos/session-memory/relevance', async (req, res) => {
        if (req.method === 'GET') {
          const url = new URL(req.url, 'http://x')
          const sessionId = url.searchParams.get('sessionId') ?? ''
          let items = []
          if (sessionId !== '') {
            try {
              const document = await sessionMemory.get(sessionId)
              items = Array.isArray(document?.items) ? document.items : []
            } catch {
              sendJson(res, 200, describeUnreadSessionMemory(sessionId))
              return
            }
          }
          const report = await memoryRelevance.propose({
            sessionId,
            items,
            query: url.searchParams.get('query') ?? '',
            label: url.searchParams.get('label') ?? '',
          })
          sendJson(res, 200, describeSessionMemoryRelevance(sessionId, report))
          return
        }
        if (req.method !== 'POST') {
          sendJson(res, 405, { error: 'GET or POST' }, { allow: 'GET, POST' })
          return
        }
        const recorded = await memoryRelevance.recordOutcome(await readJsonBody(req))
        sendJson(res, recorded.ok ? 200 : recorded.status, recorded)
      }],
      ['/api/agos/session-memory/pin', async (req, res) => {
        if (req.method !== 'POST') {
          sendJson(res, 405, { error: 'POST only' }, { allow: 'POST' })
          return
        }
        const body = await readJsonBody(req)
        const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : ''
        if (sessionId === '') {
          sendJson(res, 400, { ok: false, code: 'INVALID_SESSION', error: 'sessionId 未采集' })
          return
        }
        const result = await sessionMemory.pin(sessionId, body)
        sendJson(res, result.ok ? 200 : result.status, result)
      }],
      ['/api/agos/session-memory/inject', async (req, res) => {
        if (req.method === 'GET') {
          const sessionId = new URL(req.url, 'http://x').searchParams.get('sessionId') ?? ''
          let itemCount = 0
          if (sessionId !== '') {
            try {
              const document = await sessionMemory.get(sessionId)
              itemCount = Array.isArray(document?.items) ? document.items.length : 0
            } catch { itemCount = null }
          }
          sendJson(res, 200, describeSessionMemoryInject(home, itemCount))
          return
        }
        if (req.method !== 'POST') {
          sendJson(res, 405, { error: 'GET or POST' }, { allow: 'GET, POST' })
          return
        }
        const result = await writeSessionMemoryInjectConfig(await readJsonBody(req), { home })
        sendJson(res, result.ok ? 200 : result.status, result)
      }],
      ['/api/agos/memory/desk', async (req, res) => {
        const invokeMemorySubmit = memorySubmitInvokerFromCtx(ctx)
        if (req.method === 'GET') {
          sendJson(res, 200, await listMemoryDesk({ home, civAvailable: typeof invokeMemorySubmit === 'function' }))
          return
        }
        if (req.method !== 'POST') {
          sendJson(res, 405, { error: 'GET or POST' }, { allow: 'GET, POST' })
          return
        }
        const result = await writeMemoryDesk(await readJsonBody(req), {
          home,
          invokeMemorySubmit,
        })
        sendJson(res, result.ok ? 200 : result.status, result)
      }],
      ['/api/agos/plugins', async (req, res) => {
        if (req.method !== 'GET') { sendJson(res, 405, { error: 'GET only' }, { allow: 'GET' }); return }
        sendJson(res, 200, buildPluginsInventory({ home }))
      }],
      ['/api/agos/turn-evidence', async (req, res) => {
        if (req.method !== 'GET') { sendJson(res, 405, { error: 'GET only' }, { allow: 'GET' }); return }
        const url = new URL(req.url, 'http://x')
        const sessionId = url.searchParams.get('sessionId') ?? ''
        sendJson(res, 200, describeTurnEvidence(sessionId, turnEvidence, buildPluginsInventory({ home }), {
          turn: url.searchParams.get('turn'),
          step: url.searchParams.get('step'),
        }))
      }],
      ['/api/agos/overview', async (req, res) => {
        if (req.method !== 'GET') { sendJson(res, 405, { error: 'GET only' }, { allow: 'GET' }); return }
        const [lineage] = await Promise.all([overviewLineage()])
        const out = { at: Date.now() }
        // 与剪枝同因:`c` 只注入了 webServer,看不见 sessionPersistence,
        // 会静默落回 projcache 计数(实测:磁盘 6 而 overview 报 2)。用 domainCtx。
        const sessions = await overviewSessions({
          sessionPersistence: contextService(domainCtx ?? c, 'sessionPersistence'),
        })
        if (sessions) out.sessions = sessions
        const plans = overviewPlans(); if (plans) out.plans = plans
        const skills = overviewSkills(); if (skills) out.skills = skills
        if (lineage) out.lineage = lineage
        sendJson(res, 200, out)
      }],
      ...createAgosSessionRouteHandlers(sessionManager),
      // W11:权限裁决台账只读 GET(yolo-judge.jsonl 由 yolo-mode-aligned 写,这里不碰)。
      createYoloDecisionsRoute({ file: defaultYoloAuditFile(), validateSessionId, sendJson }),
      // W22(a):删除审计的可恢复清单只读 GET(delete.log 由本插件 appendDeleteAudit 写,这里只读、逐行 lstat)。
      createSessionTrashRoute({ file: defaultDeleteLogFile(), dshRoot: defaultDshRoot(), sendJson }),
    ]
    disposers.push(ws.register({ kind: 'prefix', path: '/agos', handler: async (req, res) => {
      try { await serveSpa(req, res) } catch (e) { sendRouteError(res, e) }
    } }))
    for (const [path, handler] of routes) {
      disposers.push(ws.register({ kind: 'exact', path, handler: async (req, res) => {
        try { await handler(req, res) } catch (e) { sendRouteError(res, e) }
      } }))
    }
    // Snapshot on the synchronous idle transition. The store defers its pure
    // rule extraction and file IO with setImmediate; it never enters agent
    // maintenance, prompt assembly, persistence reads, or any model API.
    try {
      const llmFiber = c.inject(['llm'], (llmCtx) => {
        const llm = contextService(llmCtx, 'llm')
        if (process.env.DSH_AGOS_SKILL_RERANK === '1' && llm && typeof llm.stream === 'function') {
          void import('@deepseek-ai/dsh-llm').then(({ BlockAssembler, createUserMessage }) => {
            evolveRerank = async (input) => {
              const assembler = new BlockAssembler()
              for await (const chunk of llm.stream({
                provider: process.env.DSH_AGOS_SKILL_RERANK_PROVIDER || 'stepfun',
                model: process.env.DSH_AGOS_SKILL_RERANK_MODEL || 'step-3.7-flash',
                messages: [createUserMessage({
                  content: [{ type: 'text', text: JSON.stringify({
                    task: input.query,
                    label: input.label,
                    candidates: input.candidates,
                  }) }],
                  source: { kind: 'plugin', plugin: 'dsh-agos' },
                })],
                system: SKILL_RERANK_SYSTEM,
                maxTokens: 256,
              })) {
                assembler.push(chunk)
              }
              const blocks = assembler.blocks()
              if (blocks.some((block) => block.type === 'tool-call')) return ''
              return blocks.filter((block) => block.type === 'text').map((block) => block.text).join('\n')
            }
          }).catch(() => { evolveRerank = null })
        }
        return () => { evolveRerank = null }
      })
      if (typeof llmFiber === 'function') disposers.push(llmFiber)
    } catch {}
    try {
      const memoryFiber = c.inject(['agents'], (agentCtx) => bindSessionMemoryObserver(agentCtx, sessionMemory))
      if (typeof memoryFiber === 'function') disposers.push(memoryFiber)
    } catch {
      // Older/minimal hosts may not expose injectable AgentRegistry. Routes
      // remain available and empty; direct event support is used when present.
      disposers.push(bindSessionMemoryObserver(c, sessionMemory))
    }
    // The store belongs to the webServer fiber, not the reactive AgentRegistry
    // binding. A service teardown/rebind may dispose and recreate only the
    // observer while queued work and routes keep using this same live store.
    disposers.push(() => sessionMemory.dispose())
    // One fail-soft startup pass after the HTTP surface is fully mounted. No
    // timer: delete now prunes inline, while rare out-of-band moves heal on restart.
    // The routes stay mounted even when persistence is late. A nested fiber
    // reacts when both dependencies become available and is disposed with the
    // webServer fiber; the process-wide guard prevents a second startup pass.
    disposers.push(c.inject(['sessionPersistence', 'storageDomain'], (ready) => {
      domainCtx = ready          // 供删除路径的剪枝闭包使用(见上方说明)
      const logger = contextLogger(ready)
      // storageDomain.get(name) 的契约是「**未打开时返回 undefined**」,而
      // session_projcache 由投影缓存服务在首次触碰会话时才打开 —— 插件 apply
      // 的这一刻它多半还没开。所以不能只试一次(试一次的结果是:什么都没发生,
      // 而且是静默的,这正是 2026-08-21 验收时踩到的)。改成有界重试,
      // 且无论落地还是放弃都留日志。
      let attempts = 0
      const MAX_ATTEMPTS = 15          // 15 × 2s = 30s 预算
      const RETRY_MS = 2000
      let timer
      const tryOnce = () => {
        if (startupReconciliationStarted) return
        attempts += 1
        const persistence = contextService(ready, 'sessionPersistence')
        const table = projectionCacheTableFromContext(ready)
        if (persistence && typeof persistence.list === 'function' && table) {
          startupReconciliationStarted = true
          if (timer !== undefined) { clearInterval(timer); timer = undefined }
          logger.info(`[agos] projcache reconciliation starting (attempt ${attempts})`)
          void reconcileProjectionCache({ sessionPersistence: persistence, table, logger })
            .catch((error) => logger.warn(`[agos] projcache reconciliation failed: ${conciseReason(error)}`))
          return
        }
        if (attempts >= MAX_ATTEMPTS) {
          if (timer !== undefined) { clearInterval(timer); timer = undefined }
          logger.warn('[agos] projcache reconciliation skipped: '
            + `sessionPersistence=${persistence ? 'ok' : 'missing'} `
            + `projcacheTable=${table ? 'ok' : 'not-open'} (gave up after ${attempts} attempts)`)
        }
      }
      tryOnce()
      if (!startupReconciliationStarted) {
        timer = setInterval(tryOnce, RETRY_MS)
        if (typeof timer.unref === 'function') timer.unref()
        disposers.push(() => { if (timer !== undefined) clearInterval(timer) })
      }
    }))
    return () => { for (const d of disposers.splice(0)) { try { d() } catch {} } }
  })
}
