// 把一次 llm.stream 的结果分成「可用文本」或「一个说得清原因的失败」。
//
// ⚠️ 宿主 @deepseek-ai/dsh-llm 的适配器**不向消费者 throw**:供应商报错(AUTH / QUOTA /
// RATE_LIMIT / INVALID_REQUEST / TRANSPORT …)会变成一个 finish{kind:'error', failure:{code,status}}
// 块,for-await 正常结束、blocks() 为 []。原来 dispatch.js / selector-llm.js 只读 blocks(),
// 于是「供应商 402」「只吐了 reasoning 被 max-tokens 截断」「模型想调工具」全被记成同一个
// BAD_OUTPUT(2026-08-23 审查第 4 问;归档语料里 54 个真实 error finish 全是这条路)。
//
// 判定顺序(先看 finish,再看块):
//   finish.kind === 'error'                  → PROVIDER_ERROR(带 providerCode / providerStatus)
//   finish.kind === 'aborted'                → ABORTED
//   partials 里有 tool-call,或 finish.kind==='tool-calls' → TOOL_CALL
//     (blocks() 在 max-tokens 下会静默滤掉 tool-call;partials 记的是每个块的真实类型)
//   没有文本                                  → NO_TEXT
//   其余                                      → 文本(JSON 是否可解析由调用方判 UNPARSEABLE)
// 每个失败都带 detail = { blockTypes, finish, providerCode?, providerStatus?, usage? },
// 落盘后才能回答「maxTokens:256 为什么 output 1335」这类问题,而不是猜。
// failure.message 是供应商原文(含 JSON、URL、偶有密钥环境变量名),**不落盘**。

export const STREAM_OUTCOME_CODES = Object.freeze(['PROVIDER_ERROR', 'ABORTED', 'TOOL_CALL', 'NO_TEXT', 'UNPARSEABLE'])

const STATUS_LIMIT = 3

function usageOf(assembler) {
  const u = assembler && assembler.usage
  if (!u || typeof u !== 'object') return undefined
  const out = {}
  // 宿主 TokenUsage 的键是 cacheReadTokens / cacheWriteTokens(语料 4472 / 59 次),不是 cacheRead / cacheWrite(0 次)。
  for (const key of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens']) {
    if (typeof u[key] === 'number' && Number.isFinite(u[key])) out[key] = u[key]
  }
  return Object.keys(out).length ? out : undefined
}

/** 从 assembler 取 detail;兼容没有 finish/usage getter 的测试替身。 */
export function streamDetail(assembler) {
  const finish = (assembler && assembler.finish && typeof assembler.finish === 'object') ? assembler.finish : { kind: 'stop' }
  const kind = typeof finish.kind === 'string' ? finish.kind : 'stop'
  const blocks = typeof assembler.blocks === 'function' ? assembler.blocks() : []
  // ⚠️ 宿主 blocks() 在 finish=max-tokens 时静默滤掉 tool-call 块;truthful 的块类型要看 assembler.partials
  // (每个 index 的 blockType),没有 partials 的测试替身退回 blocks()。
  const partialTypes = assembler.partials instanceof Map
    ? [...assembler.partials.values()].map((p) => (p && typeof p.blockType === 'string' ? p.blockType : 'unknown'))
    : null
  const blockTypes = partialTypes ?? blocks.map((b) => (b && typeof b.type === 'string' ? b.type : 'unknown'))
  const detail = { blockTypes, finish: kind }
  const failure = finish.failure
  if (failure && typeof failure === 'object') {
    if (typeof failure.code === 'string' && /^[A-Z_]{2,40}$/.test(failure.code)) detail.providerCode = failure.code
    if (Number.isInteger(failure.status) && String(failure.status).length <= STATUS_LIMIT) detail.providerStatus = failure.status
  }
  const usage = usageOf(assembler)
  if (usage) detail.usage = usage
  return { blocks, detail }
}

/**
 * @returns {{ text: string, detail: object } | { code: string, message: string, detail: object }}
 */
export function classifyStream(assembler) {
  const { blocks, detail } = streamDetail(assembler)
  if (detail.finish === 'error') {
    return { code: 'PROVIDER_ERROR', message: `provider finished with error${detail.providerCode ? ` (${detail.providerCode})` : ''}`, detail }
  }
  if (detail.finish === 'aborted') {
    return { code: 'ABORTED', message: 'stream aborted by adapter', detail }
  }
  // 截断(max-tokens)下 blocks() 看不见 tool-call,但 blockTypes(来自 partials)看得见 —— 模型想调工具就是 TOOL_CALL。
  if (detail.finish === 'tool-calls' || detail.blockTypes.includes('tool-call') || blocks.some((b) => b && b.type === 'tool-call')) {
    return { code: 'TOOL_CALL', message: `model attempted a tool call${detail.finish === 'max-tokens' ? ' (truncated by max-tokens)' : ''}`, detail }
  }
  const text = blocks.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n').trim()
  if (!text) {
    return { code: 'NO_TEXT', message: `no text block (finish=${detail.finish}, blocks=${detail.blockTypes.join(',') || 'none'})`, detail }
  }
  return { text, detail }
}

/** 给 Error 挂上 code 与 detail。 */
export function streamError(code, message, detail) {
  const err = new Error(message)
  err.code = code
  err.detail = detail
  return err
}
