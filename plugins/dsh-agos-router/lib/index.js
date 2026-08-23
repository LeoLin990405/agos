/**
 * @dsh-local/agos-router — StepFun selector + FuguNano rule ports.
 * Does not touch yolo-mode. Allocation posterior now feeds assemble().
 * Assemble proposes a planner/implementer/reviewer team.
 * Dispatch is a confirm-gated text-only test. It does not switch the live session.
 */
import { composeSelectorSystemPrompt, createSelector, resolveCachedSelector } from './selector-llm.js'
import { fallbackPick } from './fallback.js'
import {
  appendLine,
  buildAnnotateRecord,
  buildDecisionRecord,
  buildOutcomeRecord,
  listRoutes as listRoutesFromLedger,
  readLedgerLines,
} from './ledger.js'
import { ASSEMBLE_COPY as ASM_COPY, ASSEMBLE_EMPTY_COPY, assembleLive, defaultPoolCandidates, LIVE_DISPATCH_OFF_COPY as LIVE_OFF } from './assemble.js'
import { DISPATCH_COPY, DISPATCH_EMPTY_COPY, dispatchTeam, streamRoleText } from './dispatch.js'
import { candidatesForRoute, semanticLabel } from './labels.js'
import { route } from './selector.js'
import { normalizeRole } from './roles.js'
import { REASON_LIMIT, sanitizePreview } from './sanitize.js'
import { normalizeConfig } from './config.js'

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
  if (typeof select === 'function') {
    try {
      decision = await select(input)
      source = 'selector'
    } catch (err) {
      decision = fallbackPick(input)
      source = 'fallback'
      fallbackReason = err && typeof err.code === 'string' && err.code ? err.code : 'UNKNOWN'
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

  function listRoutes(limit) {
    return listRoutesFromLedger(effectiveConfig().auditFile, limit)
  }

  function recordOutcome(body) {
    const rec = buildOutcomeRecord(body)
    appendLine(effectiveConfig().auditFile, rec)
    return rec
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
