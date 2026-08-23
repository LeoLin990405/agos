import assert from 'node:assert/strict'
import test from 'node:test'
import {
  composeSelectorSystemPrompt,
  createSelector,
  parseSelectorOutput,
  resolveCachedSelector,
  SELECTOR_IO_CONTRACT,
  USER_RULES_HEADER,
} from '../lib/selector-llm.js'
import { decide } from '../lib/index.js'
import { fallbackPick } from '../lib/fallback.js'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CONTRACT_LINE = '{"pick":"<candidate id>","role":"<role>","confidence":0.0,"reason":"一句理由","alternates":[],"label":"<kebab>"}'

class FakeAssembler {
  constructor() { this.chunks = [] }
  push(chunk) { this.chunks.push(chunk) }
  blocks() { return this.chunks }
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
  await assert.rejects(
    () => selectBad({ task: 'x', role: 'coder', candidates: CANDIDATES }),
    (err) => err.code === 'BAD_OUTPUT',
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
    (err) => err.code === 'BAD_OUTPUT',
  )

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
