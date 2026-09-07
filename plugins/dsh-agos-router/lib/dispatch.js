// One-shot assemble 三角色试跑. Text-only role turns via llm.stream.
// 词汇:这一侧叫「试跑」。「派活」只指 swarm 子代理批次(会动仓库),这里明令不碰仓库
// (2026-08-23 审查 P1-3:同一个词横跨两个危险方向相反的轴)。端点名 /assemble/dispatch、
// kind:'dispatch'、dsp- 前缀是英文标识符,不改:改了会让历史行 dsp-1787419059326 失联。
// Does not switch the live session model, does not spawn tools.
// RSI(FuguNano 评审飞轮):评审若给出结构化判定,且过三重门(实现终稿在场·判定可解析·该决策尚无胜负),
// 则追加一条 source:'reviewer-verdict' 的 outcome 行喂后验——除此之外仍不写任何 outcome。
// 「调用成功≠好答案」:turns 的 ok 只是流成功,永不直接喂后验;喂的只有评审的判定。
import {
  IMPLEMENTER_RETRY_COPY,
  IMPLEMENTER_RETRY_SYSTEM,
  REVIEWER_SEES_FINAL_COPY,
  composeAssembleRolePrompt,
} from '../../dsh-agos/lib/agent-prompts.js'
import { ASSEMBLE_EMPTY_COPY, LIVE_DISPATCH_OFF_COPY } from './assemble.js'
import { sanitizePreview } from './sanitize.js'
import { classifyStream, streamError } from './stream-outcome.js'
import { foldLedger as foldLedgerRows } from './ledger.js'

export const DISPATCH_COPY = '本次是三角色试跑，未换本跳会话模型'
export const DISPATCH_NO_TOOLS_COPY = '三角色只出文本，不改仓库'
export const DISPATCH_CONFIRM_COPY = '三角色试跑需要 confirm:true'
export const ASSEMBLE_MISMATCH_COPY = '请求指定的提案不是台账最新一条，拒绝试跑'
export const MODEL_UNRESOLVED_COPY = '宿主未配置该模型'
export { IMPLEMENTER_RETRY_COPY, REVIEWER_SEES_FINAL_COPY }
export const DISPATCH_EMPTY_COPY = '还没有试跑记录'
export const DEFAULT_DISPATCH_TASK = '三角色试跑。各角色只回不超过 80 字中文。planner：列出三步、每步一个文件名。implementer：只写将改的文件和一句话做法，不要补丁。reviewer：首行只写「判定：通过」或「判定：驳回」，第二行一句理由。禁止改仓库，禁止声称已经接入会话或开了子代理。'

export const TURN_TEXT_LIMIT = 400
export const DISPATCH_TIMEOUT_MS = 45000
export const DISPATCH_MAX_TOKENS = 256

export const MODEL_ROUTES = Object.freeze({
  'glm-5.2': { provider: 'zhipu', model: 'glm-5.2' },
  'qwen3.8-max': { provider: 'qwen', model: 'qwen3.8-max' },
  'minimax-m3': { provider: 'minimax-cn', model: 'MiniMax-M3' },
  'MiniMax-M3': { provider: 'minimax-cn', model: 'MiniMax-M3' },
  'step-3.7-flash': { provider: 'stepfun', model: 'step-3.7-flash' },
})

export function resolveModelRoute(id) {
  if (typeof id !== 'string' || !id) return null
  return MODEL_ROUTES[id] || null
}

export function roleSystemPrompt(role) {
  return composeAssembleRolePrompt(role)
}

export function roleUserPrompt(role, task, turns) {
  const job = typeof task === 'string' && task.trim() ? task.trim() : DEFAULT_DISPATCH_TASK
  if (role === 'planner') {
    return `任务：${job}`
  }
  if (role === 'implementer') {
    const plan = lastTurnText(turns, 'planner')
    return `任务：${job}\n规划：${plan || '规划未采集'}`
  }
  const finalText = lastTurnText(turns, 'implementer')
  return `实现终稿：${finalText || '实现未采集'}`
}

/**
 * 严格解析评审判定(FuguNano review-packet 的确定性纪律):
 * 只认整行「判定：通过|驳回」(全角/半角冒号均可,行内不许有别的字)。
 * 返回 'ok'|'fail'|'ambiguous'(两种整行判定同现)|null(没有可解析判定)——
 * 三种「没有判定」成因不同,台账要分开记,前端文案不许把一种说成另一种(对抗审查 P3)。
 */
export function parseReviewerVerdict(text) {
  if (typeof text !== 'string' || !text.trim()) return null
  let seen = null
  for (const line of text.split(/\r?\n/u)) {
    const m = /^\s*判定[：:]\s*(通过|驳回)\s*$/u.exec(line)
    if (!m) continue
    const v = m[1] === '通过' ? 'ok' : 'fail'
    if (seen !== null && seen !== v) return 'ambiguous'
    seen = v
  }
  return seen
}

function lastTurnText(turns, role) {
  const row = [...(Array.isArray(turns) ? turns : [])].reverse().find((item) => item && item.role === role)
  if (!row || row.ok !== true || typeof row.text !== 'string' || !row.text.trim()) return ''
  return row.text
}

function failedRoleTurn(role, model, route, err, extra = {}) {
  const detail = err && err.detail && typeof err.detail === 'object' ? err.detail : undefined
  return {
    role,
    model,
    provider: route.provider,
    hostModel: route.model,
    ok: false,
    error: err && typeof err.code === 'string' && err.code ? err.code : 'STREAM_ERROR',
    text: '',
    ...extra,
    ...(detail ? {
      finish: detail.finish,
      blockTypes: detail.blockTypes,
      ...(detail.providerCode ? { providerCode: detail.providerCode } : {}),
      ...(detail.providerStatus !== undefined ? { providerStatus: detail.providerStatus } : {}),
      ...(detail.usage ? { usage: detail.usage } : {}),
    } : {}),
  }
}

export function buildDispatchRecord(assemble, turns, task) {
  return {
    kind: 'dispatch',
    id: `dsp-${Date.now()}`,
    ref: assemble && assemble.id,
    decisionRef: assemble && assemble.ref,
    ts: Date.now(),
    dispatched: true,
    sessionSwitched: false,
    outcome: null,
    note: DISPATCH_COPY,
    live: LIVE_DISPATCH_OFF_COPY,
    tools: DISPATCH_NO_TOOLS_COPY,
    task: sanitizePreview(typeof task === 'string' ? task : DEFAULT_DISPATCH_TASK, 80),
    roles: Array.isArray(assemble && assemble.roles) ? assemble.roles : [],
    turns,
  }
}

export async function streamRoleText(input, deps) {
  const { llm, BlockAssembler, createUserMessage, deadline } = deps
  if (!llm || typeof llm.stream !== 'function') {
    const err = new Error('llm service missing or lacks stream()')
    err.code = 'NO_ADAPTER'
    throw err
  }
  const timeoutMs = Number.isInteger(deps.timeoutMs) && deps.timeoutMs > 0 ? deps.timeoutMs : DISPATCH_TIMEOUT_MS
  const handle = deadline(deps.signal, timeoutMs, 'AGOS_DISPATCH_TIMEOUT')
  try {
    const assembler = new BlockAssembler()
    for await (const chunk of llm.stream({
      provider: input.provider,
      model: input.model,
      messages: [
        createUserMessage({
          content: [{ type: 'text', text: input.user }],
          source: { kind: 'plugin', plugin: 'dsh-agos-router' },
        }),
      ],
      system: input.system,
      maxTokens: DISPATCH_MAX_TOKENS,
      signal: handle.signal,
    })) {
      if (handle.signal.aborted) {
        const err = new Error('dispatch timed out')
        err.code = 'TIMEOUT'
        throw err
      }
      assembler.push(chunk)
    }
    // 先看 finish 再看块:供应商报错是 finish 块不是 throw(见 stream-outcome.js)。
    const outcome = classifyStream(assembler)
    if ('code' in outcome) throw streamError(outcome.code, `dispatch: ${outcome.message}`, outcome.detail)
    return outcome
  } finally {
    handle[Symbol.dispose]()
  }
}

export async function dispatchTeam(assemble, input, deps = {}) {
  if (!input || input.confirm !== true) {
    const error = new Error(DISPATCH_CONFIRM_COPY)
    error.code = 'CONFIRM_REQUIRED'
    throw error
  }
  if (!assemble || !Array.isArray(assemble.roles) || assemble.roles.length === 0) {
    const error = new Error(ASSEMBLE_EMPTY_COPY)
    error.code = 'ASSEMBLE_REQUIRED'
    throw error
  }
  // 前端按屏上那条提案开闸,后端只跑台账最新一条;带 ref 就核对,不一致即拒绝,
  // 免得试跑挂到另一条提案底下(2026-08-23 第二轮对抗验证 [45])。
  if (typeof input.ref === 'string' && input.ref && input.ref !== assemble.id) {
    const error = new Error(ASSEMBLE_MISMATCH_COPY)
    error.code = 'ASSEMBLE_MISMATCH'
    throw error
  }
  const task = typeof input.task === 'string' && input.task.trim() ? input.task.trim() : DEFAULT_DISPATCH_TASK
  const turns = []
  // 判定必须从评审「原文」解析:sanitizePreview 会把换行压成空格,整行判定在净文里已不可辨。
  let reviewerRawText = ''
  for (const row of assemble.roles) {
    const role = row && row.role
    const model = row && row.model
    const route = resolveModelRoute(model)
    if (!route) {
      turns.push({
        role,
        model,
        ok: false,
        error: 'UNRESOLVED',
        note: MODEL_UNRESOLVED_COPY,
        text: '',
      })
      continue
    }
    if (typeof deps.streamRole !== 'function') {
      turns.push({
        role,
        model,
        provider: route.provider,
        hostModel: route.model,
        ok: false,
        error: 'NO_ADAPTER',
        text: '',
      })
      continue
    }
    const user = roleUserPrompt(role, task, turns)
    let streamed
    let retried = false
    try {
      streamed = await deps.streamRole({
        role,
        provider: route.provider,
        model: route.model,
        system: roleSystemPrompt(role),
        user,
      })
    } catch (err) {
      if (role === 'implementer' && err && err.code === 'TOOL_CALL') {
        retried = true
        try {
          streamed = await deps.streamRole({
            role,
            provider: route.provider,
            model: route.model,
            system: IMPLEMENTER_RETRY_SYSTEM,
            user,
          })
        } catch (retryErr) {
          turns.push(failedRoleTurn(role, model, route, retryErr, { retried: true, note: IMPLEMENTER_RETRY_COPY }))
          continue
        }
      } else {
        turns.push(failedRoleTurn(role, model, route, err))
        continue
      }
    }
    // streamRole 可返回裸字符串(测试替身)或 {text, detail}(streamRoleText)。
    const text = typeof streamed === 'string' ? streamed : streamed && typeof streamed.text === 'string' ? streamed.text : ''
    const detail = streamed && typeof streamed === 'object' && streamed.detail ? streamed.detail : undefined
    if (role === 'reviewer') reviewerRawText = text
    turns.push({
      role,
      model,
      provider: route.provider,
      hostModel: route.model,
      ok: true,
      text: sanitizePreview(text, TURN_TEXT_LIMIT) || '',
      // 成功行也记 finish/usage:回答「256 的上限为什么 output 334」要靠它。不带 error(前端契约:ok 行无 error)。
      ...(retried ? { retried: true, note: IMPLEMENTER_RETRY_COPY } : {}),
      ...(detail ? { finish: detail.finish, blockTypes: detail.blockTypes, ...(detail.usage ? { usage: detail.usage } : {}) } : {}),
    })
  }
  const record = buildDispatchRecord(assemble, turns, task)
  // RSI 评审飞轮:判定与入账与否都如实记在 dispatch 行上,门没过也要写明是哪道门。
  const reviewerTurn = turns.find((t) => t && t.role === 'reviewer')
  const implementerTurn = turns.find((t) => t && t.role === 'implementer')
  const implementerFinal = lastTurnText(turns, 'implementer')
  const parsed = reviewerTurn && reviewerTurn.ok === true ? parseReviewerVerdict(reviewerRawText) : null
  const verdict = parsed === 'ok' || parsed === 'fail' ? parsed : null
  record.verdict = verdict
  // null 的三种成因分开记:评审角色没产出 / 文本里没有整行判定 / 两行相反判定同现。
  record.verdictNull = verdict !== null ? null
    : !(reviewerTurn && reviewerTurn.ok === true) ? 'REVIEWER_ABSENT'
    : parsed === 'ambiguous' ? 'AMBIGUOUS'
    : 'UNPARSEABLE'
  record.verdictFed = false
  record.verdictSkip = null
  if (verdict !== null) {
    if (!implementerFinal) {
      // 评审判的是「实现未采集」——判决属实但对象缺席,不喂(今天现网就发生过这种判)。
      record.verdictSkip = 'IMPLEMENTER_ABSENT'
    } else if (!implementerTurn || typeof implementerTurn.model !== 'string' || !implementerTurn.model) {
      record.verdictSkip = 'IMPLEMENTER_ABSENT'
    } else if (typeof (assemble && assemble.ref) !== 'string' || !assemble.ref) {
      record.verdictSkip = 'NO_DECISION_REF'
    } else if (typeof deps.readRows !== 'function') {
      record.verdictSkip = 'NO_LEDGER'
    } else {
      const { decisions } = foldLedgerRows(deps.readRows())
      const target = decisions.find((d) => d && d.id === assemble.ref)
      if (!target) {
        record.verdictSkip = 'DECISION_NOT_FOUND'
      } else if (target.outcome === 'ok' || target.outcome === 'fail') {
        // 改判不改史:已有胜负(手工或回填)的决策,评审判定只展示不入账。
        record.verdictSkip = 'ALREADY_JUDGED'
      } else if (typeof target.pick !== 'string' || target.pick.trim().toLowerCase() !== implementerTurn.model.trim().toLowerCase()) {
        // 归因门(对抗审查 P1):后验按 (label, decision.pick) 记账,而评审只判了 implementer 的产出。
        // 两者不是同一个模型时喂进去就是替人挨打/领功——归因有歧义就不喂,一分都不喂。
        record.verdictSkip = 'PICK_NOT_IMPLEMENTER'
      } else if (typeof deps.append === 'function') {
        deps.append({
          kind: 'outcome',
          ref: assemble.ref,
          result: verdict,
          at: Date.now(),
          source: 'reviewer-verdict',
          judge: reviewerTurn.model,
          judged: implementerTurn.model,
        })
        record.verdictFed = true
      } else {
        record.verdictSkip = 'NO_LEDGER'
      }
    }
  }
  if (typeof deps.append === 'function') deps.append(record)
  return {
    dispatch: record,
    assemble,
    dispatched: true,
    sessionSwitched: false,
    outcome: null,
    note: DISPATCH_COPY,
    live: LIVE_DISPATCH_OFF_COPY,
  }
}
