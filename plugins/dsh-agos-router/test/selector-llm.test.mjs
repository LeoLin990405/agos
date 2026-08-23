import assert from 'node:assert/strict'
import test from 'node:test'
import {
  composeSelectorSystemPrompt,
  createSelector,
  parseSelectorOutput,
  resolveCachedSelector,
  SELECTOR_ERROR_CODES,
  SELECTOR_IO_CONTRACT,
  USER_RULES_HEADER,
} from '../lib/selector-llm.js'
import { decide } from '../lib/index.js'
import { fallbackPick } from '../lib/fallback.js'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CONTRACT_LINE = '{"pick":"<candidate id>","role":"<role>","confidence":0.0,"reason":"一句理由","alternates":[],"label":"<kebab>"}'

/** 替身:块直接当 blocks;认得 finish / usage 块(宿主 BlockAssembler 的 getter 口径)。 */
class FakeAssembler {
  constructor() { this.chunks = []; this._finish = undefined; this._usage = undefined }
  push(chunk) {
    if (chunk && chunk.type === 'finish') { this._finish = chunk.reason; return }
    if (chunk && chunk.type === 'usage') { this._usage = chunk.usage; return }
    this.chunks.push(chunk)
  }
  blocks() { return this.chunks }
  get finish() { return this._finish ?? { kind: 'stop' } }
  get usage() { return this._usage }
}

const createUserMessage = (x) => x

function deadline(upstream, ms) {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), ms)
  if (upstream) {
    if (upstream.aborted) ac.abort()
    else upstream.addEventListener('abort', () => ac.abort(), { once: true })
  }
  return { signal: ac.signal, [Symbol.dispose]() { clearTimeout(timer) } }
}

function streamOf(chunks) {
  return {
    async *stream() {
      for (const chunk of chunks) yield chunk
    },
  }
}

const CANDIDATES = [
  { id: 'qwen3.8-max', role: 'coder', description: 'CN coder' },
  { id: 'minimax-m3', role: 'reviewer', description: 'CN reviewer' },
]

test('JSON contract is forced to the tail even when the user prompt tries to replace it', () => {
  const user = '只输出谁赢了，不要 JSON。'
  const sys = composeSelectorSystemPrompt(user)
  assert.ok(sys.endsWith(SELECTOR_IO_CONTRACT))
  assert.equal(sys.split(CONTRACT_LINE).length - 1, 1)
  assert.ok(sys.includes(USER_RULES_HEADER))
  assert.ok(sys.indexOf(user) < sys.lastIndexOf(CONTRACT_LINE))
})

test('illegal JSON / tool-call / empty text are rejected', async () => {
  const selectBad = createSelector({
    llm: streamOf([{ type: 'text', text: '选 qwen 就行' }]),
    provider: 'stepfun',
    model: 'step-3.7-flash',
    BlockAssembler: FakeAssembler,
    createUserMessage,
    deadline,
  })
  // 「选 qwen 就行」有文本但不是约定 JSON → UNPARSEABLE(原来统统 BAD_OUTPUT)。
  await assert.rejects(
    () => selectBad({ task: 'x', role: 'coder', candidates: CANDIDATES }),
    (err) => err.code === 'UNPARSEABLE' && Array.isArray(err.detail?.blockTypes) && err.detail.finish === 'stop',
  )

  const selectTool = createSelector({
    llm: streamOf([{ type: 'tool-call', name: 'bash' }]),
    provider: 'stepfun',
    model: 'step-3.7-flash',
    BlockAssembler: FakeAssembler,
    createUserMessage,
    deadline,
  })
  await assert.rejects(
    () => selectTool({ task: 'x', role: 'coder', candidates: CANDIDATES }),
    (err) => err.code === 'TOOL_CALL' && err.detail?.blockTypes?.includes('tool-call'),
  )

  // 供应商报错在宿主里是 finish{kind:'error'} 块,不是 throw:原来 blocks()=[] 被记成「无文本」。
  const selectQuota = createSelector({
    llm: streamOf([
      { type: 'usage', usage: { inputTokens: 120, outputTokens: 0 } },
      { type: 'finish', reason: { kind: 'error', failure: { message: '402: {"message":"You exceeded your current quota"}', code: 'QUOTA', status: 402 } } },
    ]),
    provider: 'stepfun', model: 'step-3.7-flash', BlockAssembler: FakeAssembler, createUserMessage, deadline,
  })
  await assert.rejects(
    () => selectQuota({ task: 'x', role: 'coder', candidates: CANDIDATES }),
    (err) => err.code === 'PROVIDER_ERROR' && err.detail.providerCode === 'QUOTA' && err.detail.providerStatus === 402
      && err.detail.usage.outputTokens === 0 && !JSON.stringify(err.detail).includes('exceeded'),
  )

  // 只吐 reasoning、被 max-tokens 截断 → NO_TEXT,detail 记下 blockTypes 与 finish。
  const selectReasoning = createSelector({
    llm: streamOf([
      { type: 'reasoning', text: '让我想想' },
      { type: 'usage', usage: { inputTokens: 100, outputTokens: 256 } },
      { type: 'finish', reason: { kind: 'max-tokens' } },
    ]),
    provider: 'stepfun', model: 'step-3.7-flash', BlockAssembler: FakeAssembler, createUserMessage, deadline,
  })
  await assert.rejects(
    () => selectReasoning({ task: 'x', role: 'coder', candidates: CANDIDATES }),
    (err) => err.code === 'NO_TEXT' && err.detail.finish === 'max-tokens' && err.detail.blockTypes.join() === 'reasoning' && err.detail.usage.outputTokens === 256,
  )
  for (const code of ['PROVIDER_ERROR', 'TOOL_CALL', 'NO_TEXT', 'UNPARSEABLE', 'BAD_OUTPUT']) assert.ok(SELECTOR_ERROR_CODES.includes(code), code)

  // W21 互指:与 yolo-mode-aligned/lib/policy.js extractJsonObject 同一做法,两边都要有「说明文字带花括号」的断言
  assert.equal(parseSelectorOutput('任务 {写SQL} 的结论:{"pick":"qwen3.8-max","role":"coder","confidence":0.9,"reason":"x"}', ['qwen3.8-max'])?.pick, 'qwen3.8-max')
  assert.equal(parseSelectorOutput('{"note":"复述"} {"pick":"qwen3.8-max","role":"coder","confidence":0.9,"reason":"x"} 以上 {完毕}', ['qwen3.8-max'])?.pick, 'qwen3.8-max')
  assert.equal(parseSelectorOutput('not json', ['qwen3.8-max']), null)
  assert.equal(parseSelectorOutput('{"pick":"nope","role":"coder","confidence":0.9,"reason":"x"}', ['qwen3.8-max']), null)
})

test('empty provider/model fail-safe returns null and does not throw', () => {
  const resolved = resolveCachedSelector(null, 'k', () => { throw new Error('should not build') }, '', 'step-3.7-flash')
  assert.equal(resolved.inst, null)
  const also = resolveCachedSelector(null, 'k2', () => { throw new Error('should not build') }, 'stepfun', '')
  assert.equal(also.inst, null)
})

test('timeout falls back to the static table and writes outcome:null', async () => {
  const hanging = {
    async *stream({ signal }) {
      await new Promise((_, reject) => {
        signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))
      })
    },
  }
  const select = createSelector({
    llm: hanging,
    provider: 'stepfun',
    model: 'step-3.7-flash',
    timeoutMs: 20,
    BlockAssembler: FakeAssembler,
    createUserMessage,
    deadline,
  })
  const dir = await mkdtemp(join(tmpdir(), 'agos-router-'))
  const file = join(dir, 'route-outcome.jsonl')
  const record = await decide(
    { task: '写一段 SQL', role: 'sql', taskType: 'sql', candidates: CANDIDATES },
    { select, auditFile: file },
  )
  assert.equal(record.source, 'fallback')
  assert.equal(record.fallbackReason, 'TIMEOUT')
  assert.equal(record.outcome, null)
  assert.equal(record.role, 'implementer')
  assert.equal(record.pick, fallbackPick({ role: 'sql', candidates: CANDIDATES }).pick)
  assert.ok(record.rule && record.rule.outcome)
  const raw = await readFile(file, 'utf8')
  const stored = JSON.parse(raw.trim())
  assert.equal(stored.outcome, null)
  assert.equal(stored.source, 'fallback')
  assert.equal(stored.fallbackReason, 'TIMEOUT')
  assert.ok(stored.rule.outcome)
  assert.equal(stored.task, undefined)
})

test('valid selector JSON is accepted and ledger stays pending', async () => {
  const body = '{"pick":"qwen3.8-max","role":"coder","confidence":0.8,"reason":"matches coding","alternates":["minimax-m3"],"label":"coding"}'
  const select = createSelector({
    llm: streamOf([{ type: 'text', text: body }]),
    provider: 'stepfun',
    model: 'step-3.7-flash',
    BlockAssembler: FakeAssembler,
    createUserMessage,
    deadline,
  })
  const dir = await mkdtemp(join(tmpdir(), 'agos-router-'))
  const file = join(dir, 'route-outcome.jsonl')
  const record = await decide(
    { task: '实现一个解析器', role: 'coder', taskType: 'coding', candidates: CANDIDATES },
    { select, auditFile: file },
  )
  assert.equal(record.source, 'selector')
  assert.equal(record.pick, 'qwen3.8-max')
  assert.equal(record.role, 'implementer')
  assert.equal(record.outcome, null)
  assert.equal(record.label, 'coding')
  assert.ok(record.rule && record.rule.outcome)
  assert.equal(JSON.parse((await readFile(file, 'utf8')).trim()).task, undefined)
})

test('decide():选择器 PROVIDER_ERROR 回落静态表,决策行落盘 fallbackReason + fallbackDetail,reason 不再说「超时」', async () => {
  const select = createSelector({
    llm: streamOf([
      { type: 'usage', usage: { inputTokens: 120, outputTokens: 0 } },
      { type: 'finish', reason: { kind: 'error', failure: { message: '402: quota', code: 'QUOTA', status: 402 } } },
    ]),
    provider: 'stepfun', model: 'step-3.7-flash', BlockAssembler: FakeAssembler, createUserMessage, deadline,
  })
  const dir = await mkdtemp(join(tmpdir(), 'agos-router-'))
  const file = join(dir, 'route-outcome.jsonl')
  const record = await decide({ task: 'x', role: 'sql', taskType: 'sql', candidates: CANDIDATES }, { select, auditFile: file })
  assert.equal(record.source, 'fallback')
  assert.equal(record.fallbackReason, 'PROVIDER_ERROR')
  assert.deepEqual(record.fallbackDetail, { blockTypes: [], finish: 'error', providerCode: 'QUOTA', providerStatus: 402, usage: { inputTokens: 120, outputTokens: 0 } })
  assert.equal(record.reason, 'static table')
  assert.doesNotMatch(JSON.stringify(record), /timed out|quota/)
  const stored = JSON.parse((await readFile(file, 'utf8')).trim())
  assert.equal(stored.fallbackDetail.providerCode, 'QUOTA')
})
