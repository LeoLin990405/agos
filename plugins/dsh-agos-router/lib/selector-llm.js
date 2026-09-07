/**
 * StepFun selector wrapper — same four engineering rules as yolo-mode judge:
 *   1. inject llm later; this module only consumes llm.stream
 *   2. BlockAssembler, reject tool-call / empty text / illegal JSON
 *   3. caller caches by config key; empty provider/model → null (not throw)
 *   4. system prompt = default + user appendix; JSON contract forced to the tail
 */
import { classifyStream } from './stream-outcome.js'

// BAD_OUTPUT 保留在表里只为认得台账历史行(2026-08-22 的三条决策行与一条试跑行);新代码不再抛它。
// 2026-08-23 拆成 PROVIDER_ERROR / TOOL_CALL / NO_TEXT / UNPARSEABLE(见 stream-outcome.js)。
export const SELECTOR_ERROR_CODES = Object.freeze([
  'NO_ADAPTER', 'TIMEOUT', 'ABORTED', 'BAD_OUTPUT', 'STREAM_ERROR', 'OVERLOAD',
  'PROVIDER_ERROR', 'TOOL_CALL', 'NO_TEXT', 'UNPARSEABLE',
])

export class SelectorError extends Error {
  constructor(code, message, options) {
    super(message ?? `agos-router selector failed: ${code}`, options)
    this.name = 'SelectorError'
    this.code = code
    if (options && options.detail) this.detail = options.detail
  }
}

const TIMEOUT_CODE = 'AGOS_SELECTOR_TIMEOUT'

function isPositiveInt(v) {
  return Number.isInteger(v) && v > 0
}

import {
  composeSelectorSystemPrompt,
  DEFAULT_SYSTEM_PROMPT,
  SELECTOR_IO_CONTRACT,
  USER_RULES_HEADER,
} from '../../dsh-agos/lib/agent-prompts.js'

export {
  composeSelectorSystemPrompt,
  DEFAULT_SYSTEM_PROMPT,
  SELECTOR_IO_CONTRACT,
  USER_RULES_HEADER,
}

/**
 * 平衡括号扫描:带字符串态与转义态,取**第一个**配平的 {...}。
 * 与模板 yolo-mode-aligned/lib/policy.js:268 同一做法。
 *
 * ⚠️ 原实现是「取第一个代码围栏 + 首 { 到末 }」,而系统提示词自己写明输出
 * 「可包在 ``` 围栏中,也可带少量前后说明文本」—— 于是三种符合提示词的输出全解析失败:
 *   ① 「任务 {写SQL} 的结论:{...json...}」 —— 首 { 落在说明文字的花括号上
 *   ② 「{...json...}  以上 {完毕}」        —— 末 } 落在结尾的花括号上
 *   ③ 先吐一个说明围栏、再吐 json 围栏      —— 只取了第一个围栏
 * 失败后 parseSelectorOutput 返 null → BAD_OUTPUT → 回落静态表并记 source:'fallback'。
 * 后果不是崩,是**静默降级**:选择器看着在跑,产出的却是手写表,而这条落盘线
 * 是本任务最重要的产物(标签产线)。(2026-08-22 验收 P1)
 */
function extractFirstBalancedObject(text) {
  const start = text.indexOf('{')
  if (start === -1) return null
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i]
    if (inString) {
      if (escaped) { escaped = false; continue }
      if (ch === '\\') { escaped = true; continue }
      if (ch === '"') inString = false
      continue
    }
    if (ch === '"') { inString = true; continue }
    if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) return text.slice(start, i + 1)
    }
  }
  return null
}

function extractJsonObject(text) {
  // 2026-08-23(TASK-017 W21)已以 patch 形式搬进 yolo-mode-aligned/lib/policy.js extractJsonObject(text, requiredField),
  // 那边目标字段是 decision、这边是 pick;两边各自留副本不抽公共包(yolo 有独立上游)。改一边记得看另一边。
  // 差异:yolo 侧取**最后一个**合法对象(裁判会回显输入/契约模板,都在真裁决之前);这边取第一个,pick 还要 ∈ allowedIds。
  // 剥掉**全部**围栏标记(不是只取第一个围栏的内容),再逐个候选试配平对象。
  const stripped = String(text).replace(/```(?:json)?/gi, '')
  let rest = stripped
  for (let guard = 0; guard < 8; guard += 1) {
    const candidate = extractFirstBalancedObject(rest)
    if (candidate === null) return null
    try {
      const parsed = JSON.parse(candidate)
      // 说明文字里的 {写SQL} 会先被扫到,但它没有 pick 字段 —— 跳过继续找。
      if (parsed && typeof parsed === 'object' && typeof parsed.pick === 'string') return parsed
    } catch { /* 不是合法 JSON,继续往后找 */ }
    const at = rest.indexOf(candidate)
    rest = rest.slice(at + candidate.length)
  }
  return null
}

export function parseSelectorOutput(text, allowedIds) {
  if (typeof text !== 'string' || text.trim() === '') return null
  const obj = extractJsonObject(text)
  if (!obj || typeof obj !== 'object') return null
  if (typeof obj.pick !== 'string' || obj.pick.trim() === '') return null
  if (typeof obj.role !== 'string') return null
  const confidence = Number(obj.confidence)
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) return null
  if (obj.reason !== undefined && typeof obj.reason !== 'string') return null
  const alternates = Array.isArray(obj.alternates)
    ? obj.alternates.filter((x) => typeof x === 'string')
    : []
  const pick = obj.pick.trim()
  if (allowedIds && allowedIds.length > 0 && !allowedIds.includes(pick)) return null
  return {
    pick,
    role: obj.role.trim(),
    confidence,
    reason: typeof obj.reason === 'string' ? obj.reason : '',
    alternates,
    label: typeof obj.label === 'string' ? obj.label.trim() : undefined,
  }
}

// parseSelectorOutput stays structural. Closed role / semantic label / reason cap
// are applied in decide() so a prompt-injected role cannot become a ledger cell.

function throwAbort(signal, upstream) {
  if (!signal.aborted) return
  if (upstream && upstream.aborted) {
    throw new SelectorError('ABORTED', 'agos-router selector aborted by caller')
  }
  throw new SelectorError('TIMEOUT', `agos-router selector deadline (${TIMEOUT_CODE}) elapsed`)
}

/**
 * Empty provider/model → return null (fail-safe). Never throws for missing route.
 */
export function resolveCachedSelector(cache, key, factory, provider, model) {
  if (cache && cache.key === key) return cache.inst
  const inst = provider && model ? factory() : null
  return { key, inst }
}

export function createSelector({
  llm,
  provider,
  model,
  systemPrompt,
  timeoutMs,
  maxTokens,
  concurrency,
  signal,
  BlockAssembler,
  createUserMessage,
  deadline,
}) {
  const sys = typeof systemPrompt === 'string' && systemPrompt.trim() !== '' ? systemPrompt : DEFAULT_SYSTEM_PROMPT
  const ms = isPositiveInt(timeoutMs) ? timeoutMs : 20000
  // 回落值与 config.js DEFAULTS 同步:thinking 块与正文共用预算,过小会 NO_TEXT(见 config.js 注)。
  const mt = isPositiveInt(maxTokens) ? maxTokens : 2048
  const cap = isPositiveInt(concurrency) ? concurrency : 2
  let active = 0

  return async function select(input) {
    if (!llm || typeof llm.stream !== 'function') {
      throw new SelectorError('NO_ADAPTER', 'llm service missing or lacks stream()')
    }
    if (active >= cap) {
      throw new SelectorError('OVERLOAD', `agos-router selector at concurrency limit ${cap}`)
    }
    active++
    const upstream = (input && input.signal) || signal
    const handle = deadline(upstream, ms, TIMEOUT_CODE)
    try {
      const streamSignal = handle.signal
      throwAbort(streamSignal, upstream)
      const facts = {
        task: input.task,
        role: input.role,
        candidates: input.candidates,
        evidence: input.evidence,
      }
      const messages = [
        createUserMessage({
          content: [{ type: 'text', text: JSON.stringify(facts, null, 2) }],
          source: { kind: 'plugin', plugin: 'dsh-agos-router' },
        }),
      ]
      const assembler = new BlockAssembler()
      try {
        for await (const chunk of llm.stream({
          provider,
          model,
          messages,
          system: sys,
          maxTokens: mt,
          signal: streamSignal,
        })) {
          throwAbort(streamSignal, upstream)
          assembler.push(chunk)
        }
        throwAbort(streamSignal, upstream)
      } catch (err) {
        throwAbort(streamSignal, upstream)
        if (err instanceof SelectorError) throw err
        throw new SelectorError('STREAM_ERROR', `agos-router selector stream threw: ${err && err.message ? err.message : String(err)}`, { cause: err })
      }
      // 先看 finish 再看块:供应商报错是 finish 块不是 throw(见 stream-outcome.js)。
      const outcome = classifyStream(assembler)
      if ('code' in outcome) {
        throw new SelectorError(outcome.code, `agos-router selector: ${outcome.message}`, { detail: outcome.detail })
      }
      const allowed = Array.isArray(input.candidates) ? input.candidates.map((c) => c.id).filter(Boolean) : []
      const parsed = parseSelectorOutput(outcome.text, allowed)
      if (parsed === null) {
        throw new SelectorError('UNPARSEABLE', 'agos-router selector produced unparseable output', { detail: outcome.detail })
      }
      return parsed
    } finally {
      handle[Symbol.dispose]()
      active--
    }
  }
}
