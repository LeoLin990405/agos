// One-shot assemble 三角色试跑. Text-only role turns via llm.stream.
// 词汇:这一侧叫「试跑」。「派活」只指 swarm 子代理批次(会动仓库),这里明令不碰仓库
// (2026-08-23 审查 P1-3:同一个词横跨两个危险方向相反的轴)。端点名 /assemble/dispatch、
// kind:'dispatch'、dsp- 前缀是英文标识符,不改:改了会让历史行 dsp-1787419059326 失联。
// Does not switch the live session model, does not spawn tools, does not write outcome.
import { ASSEMBLE_EMPTY_COPY, LIVE_DISPATCH_OFF_COPY } from './assemble.js'
import { sanitizePreview } from './sanitize.js'

export const DISPATCH_COPY = '本次是三角色试跑，未换本跳会话模型'
export const DISPATCH_NO_TOOLS_COPY = '三角色只出文本，不改仓库'
export const DISPATCH_CONFIRM_COPY = '三角色试跑需要 confirm:true'
export const ASSEMBLE_MISMATCH_COPY = '请求指定的提案不是台账最新一条，拒绝试跑'
export const MODEL_UNRESOLVED_COPY = '宿主未配置该模型'
export const REVIEWER_SEES_FINAL_COPY = '评审只看实现终稿'
export const DISPATCH_EMPTY_COPY = '还没有试跑记录'
export const DEFAULT_DISPATCH_TASK = '三角色试跑。各角色只回不超过 80 字中文。planner：列出三步、每步一个文件名。implementer：只写将改的文件和一句话做法，不要补丁。reviewer：只根据实现终稿判断是否空转，答通过或驳回一句。禁止改仓库，禁止声称已经接入会话或开了子代理。'

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
  if (role === 'planner') {
    return '你是规划角色。只出计划，不要实现，不要评审。不要调用工具。'
  }
  if (role === 'implementer') {
    return '你是实现角色。只出终稿说明，不要补丁，不要改仓库，不要调用工具。'
  }
  if (role === 'reviewer') {
    return `${REVIEWER_SEES_FINAL_COPY}。看不到规划稿。不要调用工具。`
  }
  return '只出一段短文本。不要调用工具。'
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

function lastTurnText(turns, role) {
  const row = [...(Array.isArray(turns) ? turns : [])].reverse().find((item) => item && item.role === role)
  if (!row || row.ok !== true || typeof row.text !== 'string' || !row.text.trim()) return ''
  return row.text
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
    const blocks = assembler.blocks()
    if (blocks.some((block) => block.type === 'tool-call')) {
      const err = new Error('dispatch output contained a tool-call block')
      err.code = 'BAD_OUTPUT'
      throw err
    }
    const text = blocks.filter((block) => block.type === 'text').map((block) => block.text).join('\n').trim()
    if (!text) {
      const err = new Error('dispatch produced no text')
      err.code = 'BAD_OUTPUT'
      throw err
    }
    return text
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
    try {
      const text = await deps.streamRole({
        role,
        provider: route.provider,
        model: route.model,
        system: roleSystemPrompt(role),
        user: roleUserPrompt(role, task, turns),
      })
      turns.push({
        role,
        model,
        provider: route.provider,
        hostModel: route.model,
        ok: true,
        text: sanitizePreview(text, TURN_TEXT_LIMIT) || '',
      })
    } catch (err) {
      turns.push({
        role,
        model,
        provider: route.provider,
        hostModel: route.model,
        ok: false,
        error: err && typeof err.code === 'string' && err.code ? err.code : 'STREAM_ERROR',
        text: '',
      })
    }
  }
  const record = buildDispatchRecord(assemble, turns, task)
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
