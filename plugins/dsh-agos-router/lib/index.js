/**
 * @dsh-local/agos-router — StepFun selector + FuguNano rule ports.
 * Does not touch yolo-mode. Allocation posterior now feeds assemble().
 * Assemble proposes a planner/implementer/reviewer team.
 * Dispatch is a confirm-gated text-only test. It does not switch the live session.
 */
import { composeSelectorSystemPrompt, createSelector, resolveCachedSelector } from './selector-llm.js'
import { fallbackPick } from './fallback.js'
import { appendLine, buildAnnotateRecord, buildDecisionRecord, listRoutes as listRoutesFromLedger, readLedgerLines, foldLedger, withLedgerLock } from './ledger.js'
import { shadowDecide, fleetBatchRuns, backfillShadowOutcomes, attachShadowLinks } from './shadow.js'
import { ASSEMBLE_COPY as ASM_COPY, ASSEMBLE_EMPTY_COPY, allocationStateFromLedger, assembleLive, defaultPoolCandidates, LIVE_DISPATCH_OFF_COPY as LIVE_OFF } from './assemble.js'
import { DISPATCH_COPY, DISPATCH_EMPTY_COPY, dispatchTeam, streamRoleText } from './dispatch.js'
import { candidatesForRoute, semanticLabel } from './labels.js'
import { route } from './selector.js'
import { normalizeRole } from './roles.js'
import { REASON_LIMIT, sanitizePreview } from './sanitize.js'
import { normalizeConfig } from './config.js'
import { homedir } from 'node:os'
import { coverageGrid, deriveOutcomeRows, readOutcomeSources, readFleetRuns } from './outcomes.js'
import { bindOrdinaryOutcome, bindShadowLink, validatedShadowLinks } from './feedback-bind.mjs'

export const name = '@dsh-local/agos-router'
export const inject = ['llm', 'settings']

export {
  composeSelectorSystemPrompt,
  createSelector,
  parseSelectorOutput,
  SELECTOR_IO_CONTRACT,
} from './selector-llm.js'
export { route, DEFAULT_SELECTOR_CONFIG } from './selector.js'
export { fallbackPick } from './fallback.js'
export { semanticLabel, candidatesForRoute } from './labels.js'
export { rankAgentsExploring, applyOutcome } from './allocation-score.js'
export { normalizeConfig } from './config.js'
export { normalizeRole, CLOSED_ROLES } from './roles.js'
export { buildAnnotateRecord } from './ledger.js'
export { coverageGrid, deriveOutcomeRows, readOutcomeSources, foldAgent, OUTCOME_KINDS, OUTCOME_FIELDS } from './outcomes.js'
export {
  ASSEMBLE_COPY,
  LIVE_DISPATCH_OFF_COPY,
  allocationStateFromLedger,
  assembleLive,
  assembleTeam,
  defaultPoolCandidates,
} from './assemble.js'
export {
  DISPATCH_COPY,
  DISPATCH_NO_TOOLS_COPY,
  dispatchTeam,
  resolveModelRoute,
} from './dispatch.js'

function sendJson(res, status, body, extraHeaders) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    ...extraHeaders,
  })
  res.end(payload)
}

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let n = 0
    req.on('data', (c) => {
      n += c.length
      if (n > limit) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      if (chunks.length === 0) {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'))
      } catch (err) {
        reject(err)
      }
    })
    req.on('error', reject)
  })
}

export function selectorCacheKey(cfg) {
  const sys = composeSelectorSystemPrompt(cfg.systemPrompt)
  return [cfg.provider, cfg.model, sys, cfg.timeoutMs, cfg.maxTokens, cfg.concurrency].join('|')
}

/**
 * 请求体上的 verified / 能力简介不是判断。
 * 抄进来会让无鉴权端口上的调用方自称 TRUST,或用「CN SQL coder」这类
 * 描述把聚类打成恒 ESCALATE / 假共识(TASK-018 W4/W5)。
 * 选择器只给整次任务一个 label —— 把它抄到所有候选上会凭空造出全体一致。
 */
function untrustedCandidate(c) {
  if (typeof c === 'string') return { id: c, agent: c }
  return {
    id: c.id,
    agent: c.id || c.agent,
  }
}

export function labeledCandidatesFor(input, decision) {
  if (Array.isArray(input.labeledCandidates) && input.labeledCandidates.length > 0) {
    return input.labeledCandidates.map(untrustedCandidate)
  }
  const rows = Array.isArray(input.candidates) ? input.candidates : []
  if (rows.length === 0) {
    return decision.pick ? [{ id: decision.pick, agent: decision.pick }] : []
  }
  return rows.map(untrustedCandidate)
}

export function taskCategoryOf(input) {
  if (typeof input.taskCategory === 'string' && input.taskCategory) return input.taskCategory
  if (typeof input.category === 'string' && input.category) return input.category
  return undefined
}

/**
 * Run one routing decision. Selector errors / missing instance → static table.
 * Always writes outcome:null. Never invents a result label.
 * rule is computed before append so the ledger and UI can see TRUST / spot-check / escalate.
 */
export async function decide(input, deps = {}) {
  const select = deps.select
  const ledgerFile = deps.auditFile
  let decision
  let source = 'fallback'
  let fallbackReason
  let fallbackDetail
  if (typeof select === 'function') {
    try {
      decision = await select(input)
      source = 'selector'
    } catch (err) {
      decision = fallbackPick(input)
      source = 'fallback'
      fallbackReason = err && typeof err.code === 'string' && err.code ? err.code : 'UNKNOWN'
      if (err && err.detail && typeof err.detail === 'object') fallbackDetail = err.detail
    }
  } else {
    decision = fallbackPick(input)
    fallbackReason = 'NOT_CONFIGURED'
  }
  const role = normalizeRole(decision.role) || normalizeRole(input.role) || normalizeRole(input.taskType)
  const label = semanticLabel({ label: decision.label, reason: decision.reason })
  const reason = sanitizePreview(decision.reason, REASON_LIMIT)
  const labeled = { ...decision, role, label, reason }
  // taskType 是角色/任务种,不是 forced-escalate 的 category(security/correctness/impossible)。
  const rule = route(candidatesForRoute(labeledCandidatesFor(input, labeled)), undefined, taskCategoryOf(input))
  const record = buildDecisionRecord(input, labeled, source)
  record.rule = {
    outcome: rule.outcome,
    reason: rule.reason,
    pick: rule.pick,
    confidence: rule.confidence,
    agreementShare: rule.agreementShare,
  }
  if (fallbackReason) record.fallbackReason = fallbackReason
  // 选择器失败的真相(blockTypes / finish / providerCode / usage)落盘;不改 buildDecisionRecord。
  if (fallbackDetail) record.fallbackDetail = fallbackDetail
  if (ledgerFile) appendLine(ledgerFile, record)
  return record
}

export function apply(ctx, rawConfig) {
  const rowCfg = normalizeConfig(rawConfig)
  const logger = ctx.logger ? ctx.logger('agos-router') : { warn() {}, info() {} }

  let sourceThunk = () => rowCfg
  import('./settings.js')
    .then(({ installRouterSettings, validateRouterSettings }) => {
      installRouterSettings(ctx, rowCfg, {
        setSource: (thunk) => {
          sourceThunk = thunk
        },
        onChange: () => {},
        validate: validateRouterSettings,
      })
    })
    .catch((err) => {
      logger.warn('agos-router settings 分区未挂上，继续用插件行配置', err && err.message ? err.message : err)
    })

  let cache = null
  let unconfiguredWarned = false

  function effectiveConfig() {
    return normalizeConfig(sourceThunk ? sourceThunk() : rowCfg)
  }

  async function getSelector() {
    const cfg = effectiveConfig()
    const key = selectorCacheKey(cfg)
    const sys = composeSelectorSystemPrompt(cfg.systemPrompt)
    if (cache && cache.key === key) return cache.inst
    const resolved = resolveCachedSelector(cache, key, () => null, cfg.provider, cfg.model)
    if (!resolved.inst && (!cfg.provider || !cfg.model)) {
      cache = resolved
      if (!unconfiguredWarned) {
        unconfiguredWarned = true
        logger.warn('选择器未配置（provider 或 model 为空）；将回落静态表，不阻断路由。')
      }
      return null
    }
    const [{ BlockAssembler, createUserMessage }, { deadline }] = await Promise.all([
      import('@deepseek-ai/dsh-llm'),
      import('@deepseek-ai/dsh-timeout'),
    ])
    const inst = createSelector({
      llm: ctx.llm,
      provider: cfg.provider,
      model: cfg.model,
      systemPrompt: sys,
      timeoutMs: cfg.timeoutMs,
      maxTokens: cfg.maxTokens,
      concurrency: cfg.concurrency,
      BlockAssembler,
      createUserMessage,
      deadline,
    })
    cache = { key, inst }
    return inst
  }

  async function decideLive(input) {
    const cfg = effectiveConfig()
    return decide(input, { select: await getSelector(), auditFile: cfg.auditFile })
  }

  /** W17 影子:一次「检查派发」= 至多一次选择器调用;候选为空不调。 */
  async function shadowLive(body) {
    const cfg = effectiveConfig()
    const select = await getSelector()
    return shadowDecide(body ?? {}, {
      select: select ?? undefined,
      append: (record) => appendLine(cfg.auditFile, record),
    })
  }

  // HTTP 处理器持锁的超时上限。ledger-lock.js 的默认值是 30s,那是给批处理写者定的;
  // 用在这里会变成一条故障:acquireLedgerLock 等锁走 Atomics.wait,它 park 的是**整个
  // 单线程 host**,不是当前这一个请求。所以一个卡死的对端会让控制台全站冻住 30 秒。
  //
  // 而且这道风险是接线放大的:接线前 appendLine 只在「追加」那一瞬取锁,接线后临界区
  // 变成「读 → 判定 → 追加」整段(这是事务性的代价,不能退回去)。实测读+fold 在一万行
  // 台账上是 5.3ms、千行 0.6ms,所以 5s 已是临界区的约一千倍余量;同时它必须大于
  // recoverStale 内部那把恢复锁的 2s,否则一次正当的陈锁回收就会吃掉整个预算。
  //
  // 缩短超时不会让别人抢走我正持有的锁:isStale 对「活着且 start time 匹配」的 owner
  // 一律返回 false,timeoutMs 只决定何时启用昂贵的 PID 复用检查(见 ledger-lock.js
  // 的窗口注释)。超时是 fail-closed 的 —— 抛 AGOS_LEDGER_LOCK_TIMEOUT,不写盘。
  const HTTP_LOCK = { timeoutMs: 5_000 }
  // 读路径(GET /routes 的影子回填)单独一个短得多的预算,理由是不对称的:
  //   · 写路径等不到锁 = 一次用户可见的拒绝,值得容忍 5s;
  //   · 回填是**幂等**的 —— 跳过这一轮,下一次 GET 会重算同一份 pending 集合,
  //     而列表本来就把未回填的行诚实显示为 pending。
  // 也就是说读路径花 5s 冻住整个 host,换来的是下一次轮询免费就能拿到的东西;
  // 而控制台在轮询 GET /routes,一个持续持锁的对端会让宿主每轮冻 5s。
  // 接线还额外放大了这条:接线前 links.size === 0 时先返回、一次锁都不取,
  // 接线后取锁被提到最外层,于是「没有任何影子链接」这个常见情形也要取一次锁。
  // 由接线审查者指出。
  const BACKFILL_LOCK = { timeoutMs: 250 }

  function shadowLink(body) {
    const cfg = effectiveConfig()
    // 一次事务:REBOUND / BATCH_LINKED 两道检查读的是已有链接,并发的 linker 不能挤在
    // 这次读与下面的追加之间 —— 否则两条链接都过检查,一个批次绑到两个决策上。
    return withLedgerLock(cfg.auditFile, () => {
      const rows = readLedgerLines(cfg.auditFile)
      const bound = bindShadowLink({
        ref: body && body.ref,
        batchId: body && body.batchId,
        hosts: body && body.hosts,
        rows,
        decisions: foldLedger(rows).decisions,
        batches: fleetBatchRuns(readFleetRuns(homedir())),
      })
      if (!bound.ok) {
        const error = new Error(bound.error)
        error.code = bound.code
        throw error
      }
      if (!bound.idempotent) appendLine(cfg.auditFile, bound.record)
      return bound.record
    }, HTTP_LOCK)
  }

  /** W17:GET 时回填影子决策的批次终态(只对 已挂 batchId + outcome 空 + fleet 批次已终态 的行追加 outcome 行)。 */
  function backfillShadow(cfg) {
    try {
      // 否则两个并发 GET 会算出同一份 pending 集合,然后各写一遍。
      return withLedgerLock(cfg.auditFile, () => {
        const rows = readLedgerLines(cfg.auditFile)
        const batches = fleetBatchRuns(readFleetRuns(homedir()))
        const links = validatedShadowLinks(rows, batches)
        if (links.size === 0) return 0
        const { decisions } = foldLedger(rows)
        const pending = backfillShadowOutcomes({ decisions, links, batchRuns: batches })
        for (const rec of pending) appendLine(cfg.auditFile, rec)
        return pending.length
      }, BACKFILL_LOCK)
    } catch (err) {
      // 锁超时与「真的出错了」必须分开说。原文案对两者都说「不影响列表」——列表本身确实
      // 仍然诚实(未回填的行照旧显示为 pending,没有编造终态),但一次数秒的宿主冻结加一次
      // 回填缺失,对外只表现为一条说「不影响」的 warn,把最重的后果说成无关紧要。
      // 5s→250ms 之后超时会更常发生而不是更少,所以这条分流是配套的,不是可选的。
      const timedOut = err && err.code === 'AGOS_LEDGER_LOCK_TIMEOUT'
      logger.warn(
        timedOut ? '影子回填本次跳过:台账锁被其他写者持有,下次 GET 会重算' : '影子回填失败(不影响列表)',
        err && err.message ? err.message : err,
      )
      if (process.env.SHADOW_DEBUG) console.error(err)
      return 0
    }
  }

  function listRoutes(limit) {
    const cfg = effectiveConfig()
    backfillShadow(cfg)
    const listed = listRoutesFromLedger(cfg.auditFile, limit)
    const batches = fleetBatchRuns(readFleetRuns(homedir()))
    const links = validatedShadowLinks(readLedgerLines(cfg.auditFile), batches)
    listed.decisions = attachShadowLinks(listed.decisions, links, batches)
    // 后验的分母写进载荷:真实观测条数与格子数,由台账算出。前端不得自称「后验再填三角色」而不给数(审查 P2-5)。
    const state = allocationStateFromLedger(
      readLedgerLines(cfg.auditFile),
      { halfLifeDays: cfg.posteriorHalfLifeDays },
    )
    listed.stats.posterior = {
      // 衰减开着时这是有效证据量(可为小数),关着时就是行数——口径由 halfLifeDays 一并携带。
      // 正数不许被凑成 0:0 意味着「暂无观测」,与同载荷 cells>0 会互相打脸(对抗审查 P3)。
      observations: (() => {
        const sum = state.reduce((n, e) => n + e.s + e.f, 0)
        const rounded = Math.round(sum * 100) / 100
        return rounded === 0 && sum > 0 ? Number(sum.toPrecision(2)) : rounded
      })(),
      cells: state.length,
      ...(cfg.posteriorHalfLifeDays > 0 ? { halfLifeDays: cfg.posteriorHalfLifeDays } : {}),
    }
    return listed
  }

  /** W10:五家台账 → 七字段结果行 + 覆盖表。纯读。 */
  function listOutcomes(kind) {
    const rows = deriveOutcomeRows(readOutcomeSources({ auditFile: effectiveConfig().auditFile, home: homedir() }))
    const filtered = kind ? rows.filter((r) => r.kind === kind) : rows
    return { at: Date.now(), rows: filtered, grid: coverageGrid(filtered) }
  }

  function recordOutcome(body) {
    const file = effectiveConfig().auditFile
    // 一次事务:CONFLICTING_RESULT 是由这次读判定的,并发写者不能在读与追加之间落一个
    // 相反结果 —— 那等于让「改判不改史」被竞争击穿,而不是被 bug 击穿。
    return withLedgerLock(file, () => {
      const bound = bindOrdinaryOutcome({
        authority: 'operator',
        body,
        rows: readLedgerLines(file),
      })
      if (!bound.ok) {
        const error = new Error(bound.error)
        error.code = bound.code
        throw error
      }
      if (bound.idempotent) return bound.record
      appendLine(file, bound.record)
      return bound.record
    }, HTTP_LOCK)
  }

  async function assembleLiveRequest(body) {
    if (!body || body.confirm !== true) {
      const error = new Error('组装提案需要 confirm:true')
      error.code = 'CONFIRM_REQUIRED'
      throw error
    }
    const cfg = effectiveConfig()
    return assembleLive({
      task: typeof body.task === 'string' ? body.task : '',
      role: body.role,
      taskType: body.taskType || body.role,
      candidates: Array.isArray(body.candidates) && body.candidates.length > 0
        ? body.candidates
        : defaultPoolCandidates(),
    }, {
      decide: decideLive,
      readRows: () => readLedgerLines(cfg.auditFile),
      append: (record) => appendLine(cfg.auditFile, record),
      // RSI:采样与半衰期由配置进,默认 mean/关——asm 行会如实记 ranking/decay。
      sampling: cfg.assembleSampling,
      halfLifeDays: cfg.posteriorHalfLifeDays,
    })
  }

  async function dispatchLiveRequest(body) {
    const listed = listRoutes(50)
    if (!listed.assemble) {
      const error = new Error(ASSEMBLE_EMPTY_COPY)
      error.code = 'ASSEMBLE_REQUIRED'
      throw error
    }
    const [{ BlockAssembler, createUserMessage }, { deadline }] = await Promise.all([
      import('@deepseek-ai/dsh-llm'),
      import('@deepseek-ai/dsh-timeout'),
    ])
    return dispatchTeam(listed.assemble, {
      confirm: body && body.confirm,
      ref: body && typeof body.ref === 'string' ? body.ref : '',
      task: typeof body.task === 'string' ? body.task : '',
    }, {
      append: (record) => appendLine(effectiveConfig().auditFile, record),
      readRows: () => readLedgerLines(effectiveConfig().auditFile),
      // 只有同步的 读→检查→追加 尾段在锁内跑。前面三条模型流各自最长 45s,
      // 把它们一起圈进跨进程锁会持锁约 135s、远超锁的 30s 超时,使其他写者全部失败。
      transact: (fn) => withLedgerLock(effectiveConfig().auditFile, fn, HTTP_LOCK),
      streamRole: (input) => streamRoleText(input, {
        llm: ctx.llm,
        BlockAssembler,
        createUserMessage,
        deadline,
      }),
    })
  }

  /**
   * 给历史决策行挂时间界线标注,不改写那一行。
   * ⚠️ 台账里 11:31:23 那两条 annotate 是一次性脚本追加的,buildAnnotateRecord
   * 当时「有实现、有单测、无调用方」—— W7 明文禁止的形状(2026-08-22 验收 P2)。
   * 这里就是它的调用方;删掉写入端会红掉这条路由,不再是无声的死代码。
   */
  function recordAnnotation(body) {
    const rec = buildAnnotateRecord(body)
    appendLine(effectiveConfig().auditFile, rec)
    return rec
  }

  try {
    ctx.inject(['webServer'], (c) => {
      const ws = c.get('webServer')
      if (!ws || typeof ws.register !== 'function') return
      const disposers = []
      disposers.push(ws.register({
        kind: 'exact',
        path: '/api/agos/routes',
        handler: async (req, res) => {
          if (req.method !== 'GET') {
            sendJson(res, 405, { error: 'GET only' }, { allow: 'GET' })
            return
          }
          const url = new URL(req.url, 'http://x')
          const limit = Number(url.searchParams.get('limit') || 50)
          sendJson(res, 200, listRoutes(Number.isFinite(limit) ? limit : 50))
        },
      }))
      disposers.push(ws.register({
        kind: 'exact',
        path: '/api/agos/routes/decide',
        handler: async (req, res) => {
          if (req.method !== 'POST') {
            sendJson(res, 405, { error: 'POST only' }, { allow: 'POST' })
            return
          }
          try {
            const body = await readBody(req)
            sendJson(res, 200, await decideLive(body))
          } catch (err) {
            sendJson(res, 400, { error: String(err && err.message ? err.message : err).slice(0, 200) })
          }
        },
      }))
      disposers.push(ws.register({
        kind: 'exact',
        path: '/api/agos/routes/outcomes',
        handler: async (req, res) => {
          if (req.method !== 'GET') {
            sendJson(res, 405, { error: 'GET only' }, { allow: 'GET' })
            return
          }
          const url = new URL(req.url, 'http://x')
          const kind = url.searchParams.get('kind') || ''
          sendJson(res, 200, listOutcomes(/^[a-z]+$/.test(kind) ? kind : ''))
        },
      }))
      // W17:影子选择器。POST 一次 = 至多一次模型调用;响应是台账行(publicize 后),pick 为 null 表示未产出建议。
      disposers.push(ws.register({
        kind: 'exact',
        path: '/api/agos/routes/shadow',
        handler: async (req, res) => {
          if (req.method !== 'POST') {
            sendJson(res, 405, { error: 'POST only' }, { allow: 'POST' })
            return
          }
          try {
            sendJson(res, 200, await shadowLive(await readBody(req)))
          } catch (err) {
            sendJson(res, 400, { error: String(err && err.message ? err.message : err).slice(0, 200) })
          }
        },
      }))
      disposers.push(ws.register({
        kind: 'exact',
        path: '/api/agos/routes/shadow/link',
        handler: async (req, res) => {
          if (req.method !== 'POST') {
            sendJson(res, 405, { error: 'POST only' }, { allow: 'POST' })
            return
          }
          try {
            sendJson(res, 200, shadowLink(await readBody(req)))
          } catch (err) {
            sendJson(res, 400, { error: String(err && err.message ? err.message : err).slice(0, 200) })
          }
        },
      }))
      disposers.push(ws.register({
        kind: 'exact',
        path: '/api/agos/routes/annotate',
        handler: async (req, res) => {
          if (req.method !== 'POST') {
            sendJson(res, 405, { error: 'POST only' }, { allow: 'POST' })
            return
          }
          try {
            sendJson(res, 200, recordAnnotation(await readBody(req)))
          } catch (err) {
            sendJson(res, 400, { error: String(err && err.message ? err.message : err).slice(0, 200) })
          }
        },
      }))
      disposers.push(ws.register({
        kind: 'exact',
        path: '/api/agos/routes/assemble',
        handler: async (req, res) => {
          if (req.method === 'GET') {
            const listed = listRoutes(50)
            sendJson(res, 200, {
              assemble: listed.assemble,
              dispatch: listed.dispatch,
              note: listed.assemble ? ASM_COPY : ASSEMBLE_EMPTY_COPY,
              live: LIVE_OFF,
            })
            return
          }
          if (req.method !== 'POST') {
            sendJson(res, 405, { error: 'GET or POST' }, { allow: 'GET, POST' })
            return
          }
          try {
            sendJson(res, 200, await assembleLiveRequest(await readBody(req)))
          } catch (err) {
            const status = err && err.code === 'CONFIRM_REQUIRED' ? 400 : 400
            sendJson(res, status, { error: String(err && err.message ? err.message : err).slice(0, 200), code: err && err.code })
          }
        },
      }))
      disposers.push(ws.register({
        kind: 'exact',
        path: '/api/agos/routes/assemble/dispatch',
        handler: async (req, res) => {
          if (req.method === 'GET') {
            const listed = listRoutes(50)
            sendJson(res, 200, {
              dispatch: listed.dispatch,
              note: listed.dispatch ? DISPATCH_COPY : DISPATCH_EMPTY_COPY,
              live: LIVE_OFF,
            })
            return
          }
          if (req.method !== 'POST') {
            sendJson(res, 405, { error: 'GET or POST' }, { allow: 'GET, POST' })
            return
          }
          try {
            sendJson(res, 200, await dispatchLiveRequest(await readBody(req)))
          } catch (err) {
            const status = err && err.code === 'ASSEMBLE_MISMATCH' ? 409 : 400
            sendJson(res, status, { error: String(err && err.message ? err.message : err).slice(0, 200), code: err && err.code })
          }
        },
      }))
      disposers.push(ws.register({
        kind: 'exact',
        path: '/api/agos/routes/outcome',
        handler: async (req, res) => {
          if (req.method !== 'POST') {
            sendJson(res, 405, { error: 'POST only' }, { allow: 'POST' })
            return
          }
          try {
            sendJson(res, 200, recordOutcome(await readBody(req)))
          } catch (err) {
            sendJson(res, 400, { error: String(err && err.message ? err.message : err).slice(0, 200) })
          }
        },
      }))
      return () => {
        for (const d of disposers) if (typeof d === 'function') d()
      }
    })
  } catch {
    // Host without webServer: selector still usable in-process.
  }
}
