import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { LIVE_DISPATCH_OFF_COPY } from '../lib/assemble.js'
import {
  DISPATCH_EMPTY_COPY,
  ASSEMBLE_MISMATCH_COPY,
  DISPATCH_CONFIRM_COPY,
  DISPATCH_COPY,
  DISPATCH_NO_TOOLS_COPY,
  IMPLEMENTER_RETRY_COPY,
  MODEL_UNRESOLVED_COPY,
  REVIEWER_SEES_FINAL_COPY,
  REVIEWER_TASK_LIMIT,
  REVIEWER_RESULT_LIMIT,
  RESULT_ABSENT_COPY,
  boundedSection,
  dispatchTeam,
  resolveModelRoute,
  roleSystemPrompt,
  roleUserPrompt,
  truncationNotice,
} from '../lib/dispatch.js'
import { appendLine, foldLedger, listRoutes } from '../lib/ledger.js'

const TEAM = {
  id: 'asm-1',
  ref: 'dec-1',
  roles: [
    { role: 'planner', model: 'glm-5.2' },
    { role: 'implementer', model: 'qwen3.8-max' },
    { role: 'reviewer', model: 'minimax-m3' },
  ],
}

test('known assemble labels resolve to host provider/model pairs', () => {
  assert.deepEqual(resolveModelRoute('glm-5.2'), { provider: 'zhipu', model: 'glm-5.2' })
  assert.deepEqual(resolveModelRoute('qwen3.8-max'), { provider: 'qwen', model: 'qwen3.8-max' })
  assert.deepEqual(resolveModelRoute('minimax-m3'), { provider: 'minimax-cn', model: 'MiniMax-M3' })
  assert.equal(resolveModelRoute('ghost-model'), null)
})

// C4 (2026-09-08) — deliberate contract change. Before this round the reviewer saw
// only the implementer draft, so a verdict could not mean "this answers the task";
// it could only mean "this text reads well". The reviewer now also gets the complete
// original task. The planner draft stays hidden: that is the invariant this test
// was really protecting, and it is unchanged.
test('reviewer prompt sees the original task and the implementer final, never the plan', () => {
  const turns = [
    { role: 'planner', ok: true, text: 'PLAN-SECRET' },
    { role: 'implementer', ok: true, text: 'FINAL-DRAFT' },
  ]
  const user = roleUserPrompt('reviewer', '整理 SQL', turns)
  assert.match(user, /FINAL-DRAFT/)
  assert.doesNotMatch(user, /PLAN-SECRET/)
  assert.match(user, /整理 SQL/, '评审必须看到原始任务，否则判定只是「文本好不好」')
  assert.match(roleSystemPrompt('reviewer'), new RegExp(REVIEWER_SEES_FINAL_COPY))
})

test('reviewer context is bounded per section, truncated deterministically, and never silently', () => {
  const task = 'T'.repeat(REVIEWER_TASK_LIMIT + 500)
  const draft = 'D'.repeat(REVIEWER_RESULT_LIMIT + 250)
  const turns = [{ role: 'implementer', ok: true, text: draft }]
  const user = roleUserPrompt('reviewer', task, turns)

  // Announced, with the exact amount dropped — a reviewer judging a fragment is told so.
  assert.match(user, new RegExp(escapeRe(truncationNotice(REVIEWER_TASK_LIMIT, 500))))
  assert.match(user, new RegExp(escapeRe(truncationNotice(REVIEWER_RESULT_LIMIT, 250))))
  // Each section keeps its own budget: a huge task cannot crowd out the draft.
  assert.equal((user.match(/T/g) ?? []).length, REVIEWER_TASK_LIMIT)
  assert.equal((user.match(/D/g) ?? []).length, REVIEWER_RESULT_LIMIT)
  // Deterministic: same input, byte-identical prompt.
  assert.equal(user, roleUserPrompt('reviewer', task, turns))

  // Code points, not UTF-16 units: an emoji is one 字, and is never split in half.
  const wide = boundedSection('🙂'.repeat(10), 4)
  assert.equal(wide.dropped, 6)
  assert.ok(wide.text.startsWith('🙂🙂🙂🙂\n'))
  assert.equal([...wide.text.split('\n')[0]].length, 4)

  // Absence is reported as absence, not as an empty success.
  assert.match(roleUserPrompt('reviewer', '任务', []), new RegExp(RESULT_ABSENT_COPY))
  assert.equal(boundedSection('short', 4000).truncated, false)
})

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

test('dispatchTeam requires confirm and does not invent outcome', async () => {
  await assert.rejects(() => dispatchTeam(TEAM, { task: 'x' }), (err) => {
    assert.equal(err.code, 'CONFIRM_REQUIRED')
    assert.equal(err.message, DISPATCH_CONFIRM_COPY)
    return true
  })
  const calls = []
  const result = await dispatchTeam(TEAM, { confirm: true, task: '三角色试跑' }, {
    streamRole: async (input) => {
      calls.push(input)
      return `${input.role}-ok`
    },
  })
  assert.equal(result.dispatched, true)
  assert.equal(result.sessionSwitched, false)
  assert.equal(result.outcome, null)
  assert.equal(result.dispatch.outcome, null)
  assert.equal(result.dispatch.note, DISPATCH_COPY)
  assert.equal(result.dispatch.live, LIVE_DISPATCH_OFF_COPY)
  assert.equal(result.dispatch.tools, DISPATCH_NO_TOOLS_COPY)
  assert.equal(result.dispatch.turns.length, 3)
  assert.equal(calls[2].user.includes('implementer-ok'), true)
  assert.equal(calls[2].user.includes('planner-ok'), false)
})

test('unresolved models fail closed and later roles still run', async () => {
  const result = await dispatchTeam({
    id: 'asm-2',
    roles: [
      { role: 'planner', model: 'missing-model' },
      { role: 'implementer', model: 'qwen3.8-max' },
    ],
  }, { confirm: true }, {
    streamRole: async () => 'impl-ok',
  })
  assert.equal(result.dispatch.turns[0].ok, false)
  assert.equal(result.dispatch.turns[0].error, 'UNRESOLVED')
  assert.equal(result.dispatch.turns[0].note, MODEL_UNRESOLVED_COPY)
  assert.equal(result.dispatch.turns[1].ok, true)
})

test('dispatch rows do not become route decisions or outcomes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agos-dispatch-'))
  const file = join(dir, 'route-outcome.jsonl')
  appendLine(file, { id: 'dec-1', pick: 'qwen3.8-max', role: 'implementer' })
  const result = await dispatchTeam(TEAM, { confirm: true }, {
    append: (record) => appendLine(file, record),
    streamRole: async (input) => input.role,
  })
  const listed = listRoutes(file, 50)
  assert.equal(listed.stats.total, 1)
  assert.equal(listed.dispatch.id, result.dispatch.id)
  assert.equal(foldLedger([{ kind: 'dispatch', id: 'dsp-1' }, { id: 'dec-9', pick: 'x' }]).decisions.length, 1)
})

test('带 ref 的试跑请求指向的不是台账最新提案 → ASSEMBLE_MISMATCH，不跑任何角色', async () => {
  const calls = []
  await assert.rejects(
    () => dispatchTeam({ ...TEAM, id: 'asm-new' }, { confirm: true, ref: 'asm-old', task: 'x' }, {
      streamRole: async (input) => { calls.push(input); return 'ok' },
    }),
    (err) => { assert.equal(err.code, 'ASSEMBLE_MISMATCH'); return true },
  )
  assert.equal(calls.length, 0)
  const ok = await dispatchTeam({ ...TEAM, id: 'asm-new' }, { confirm: true, ref: 'asm-new', task: 'x' }, {
    streamRole: async () => 'ok',
  })
  assert.equal(ok.dispatch.ref, 'asm-new')
})

test('冻结文案字面量钉死：与 agos-frontend routes-assemble.ts 逐字镜像', () => {
  assert.equal(DISPATCH_COPY, '本次是三角色试跑，未换本跳会话模型')
  assert.equal(DISPATCH_NO_TOOLS_COPY, '三角色只出文本，不改仓库')
  assert.equal(MODEL_UNRESOLVED_COPY, '宿主未配置该模型')
  assert.equal(DISPATCH_EMPTY_COPY, '还没有试跑记录')
  assert.equal(ASSEMBLE_MISMATCH_COPY, '请求指定的提案不是台账最新一条，拒绝试跑')
})

// ── 2026-08-23 BAD_OUTPUT 拆码:用宿主真 BlockAssembler 喂块序列,直接打 streamRoleText ──
//
// 路径为什么是「相对路径钻进 node_modules」而不是裸包名:@deepseek-ai/dsh-llm 的 exports
// 映射没有导出 ./lib/types/assembler.js,裸 import 会 ERR_PACKAGE_PATH_NOT_EXPORTED。
// 这是故意绕开导出映射去拿宿主内部类型 —— 别把它「整理」成裸包名,会直接加载失败。
//
// 2026-09-09 主控改:原本写的是 '/Users/<name>/.dsh/profiles/desktop/node_modules/...' 绝对
// 路径。那有两个问题,第二个更重要:
//   1. 模块级静态 import 指向个人 live profile,换任何一台机器整个测试文件都加载不了
//      (A 包的依赖面测量与主控各自独立报到同一处)。
//   2. desktop profile 那份是软链进 DSH Desktop.app 的 rc.6 时代副本,与本树 pin 的
//      0.1.2-rc.1 **内容不同**(assembler.js sha256 cfe654a0… vs 3257b31b…)。也就是说
//      这条「用宿主真 BlockAssembler」的契约镜像,镜的是 pin 之外的另一条版本线。
// 改成仓库相对路径后对着 pin 的 0.1.2-rc.1 复跑,13/13 仍通过,所以断言在两条线上都成立;
// 现在它至少断言的是 UPSTREAM.pin 真正声明的那一条。
import { BlockAssembler as HostAssembler } from '../../node_modules/@deepseek-ai/dsh-llm/lib/types/assembler.js'
import { streamRoleText } from '../lib/dispatch.js'

const fakeDeadline = (upstream, ms) => {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), ms)
  return { signal: ac.signal, [Symbol.dispose]() { clearTimeout(timer) } }
}
const llmOf = (chunks) => ({ async *stream() { for (const c of chunks) yield c } })
const roleInput = { role: 'planner', provider: 'zhipu', model: 'glm-5.2', system: 's', user: 'u' }
const streamWith = (chunks) => streamRoleText(roleInput, { llm: llmOf(chunks), BlockAssembler: HostAssembler, createUserMessage: (x) => x, deadline: fakeDeadline })

test('streamRoleText:供应商报错(finish error 块)→ PROVIDER_ERROR,带 providerCode/status/usage,不落 message', async () => {
  await assert.rejects(
    () => streamWith([
      { type: 'usage', usage: { inputTokens: 120, outputTokens: 0 } },
      { type: 'finish', reason: { kind: 'error', failure: { message: '401: {"message":"Invalid API Key","code":"401"}', code: 'AUTH' } } },
    ]),
    (err) => {
      assert.equal(err.code, 'PROVIDER_ERROR')
      assert.deepEqual(err.detail, { blockTypes: [], finish: 'error', providerCode: 'AUTH', usage: { inputTokens: 120, outputTokens: 0 } })
      return true
    },
  )
})

test('streamRoleText:只有 reasoning 被 max-tokens 截断 → NO_TEXT;工具调用 → TOOL_CALL(含 max-tokens 下被 blocks() 滤掉的)', async () => {
  await assert.rejects(
    () => streamWith([
      { type: 'reasoning-delta', index: 0, text: '让我想想' },
      { type: 'usage', usage: { inputTokens: 100, outputTokens: 256 } },
      { type: 'finish', reason: { kind: 'max-tokens' } },
    ]),
    (err) => { assert.equal(err.code, 'NO_TEXT'); assert.deepEqual(err.detail.blockTypes, ['reasoning']); assert.equal(err.detail.finish, 'max-tokens'); assert.equal(err.detail.usage.outputTokens, 256); return true },
  )
  await assert.rejects(
    () => streamWith([{ type: 'tool-call-delta', index: 0, id: 'c1', name: 'bash', argumentsDelta: '{}' }, { type: 'finish', reason: { kind: 'tool-calls' } }]),
    (err) => { assert.equal(err.code, 'TOOL_CALL'); assert.deepEqual(err.detail.blockTypes, ['tool-call']); return true },
  )
  // 宿主 blocks() 在 max-tokens 下静默滤掉 tool-call;blockTypes 来自 partials 仍看得见 → 必须是 TOOL_CALL,不许退成 NO_TEXT。
  await assert.rejects(
    () => streamWith([{ type: 'tool-call-delta', index: 0, id: 'c1', name: 'bash', argumentsDelta: '{"cmd":"ls' }, { type: 'usage', usage: { inputTokens: 1, outputTokens: 256 } }, { type: 'finish', reason: { kind: 'max-tokens' } }]),
    (err) => { assert.equal(err.code, 'TOOL_CALL'); assert.deepEqual(err.detail.blockTypes, ['tool-call']); assert.equal(err.detail.finish, 'max-tokens'); return true },
  )
  // 文本 + 被截断的工具调用:也是 TOOL_CALL(模型的意图是调工具),不是成功行。
  await assert.rejects(
    () => streamWith([{ type: 'text-delta', index: 0, text: '我来看一下' }, { type: 'tool-call-delta', index: 1, id: 'c1', name: 'bash', argumentsDelta: '{' }, { type: 'finish', reason: { kind: 'max-tokens' } }]),
    (err) => err.code === 'TOOL_CALL' && err.detail.blockTypes.join() === 'text,tool-call',
  )
  // 适配器自身中止 → ABORTED(不是供应商报错)。
  await assert.rejects(
    () => streamWith([{ type: 'finish', reason: { kind: 'aborted', failure: { code: 'ABORTED', message: 'x' } } }]),
    (err) => err.code === 'ABORTED' && err.detail.finish === 'aborted',
  )
  // usage 键名是宿主的 cacheReadTokens / cacheWriteTokens。
  const cached = await streamWith([{ type: 'text-delta', index: 0, text: 'ok' }, { type: 'usage', usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 900, cacheWriteTokens: 30, reasoningTokens: 3 } }])
  assert.deepEqual(cached.detail.usage, { inputTokens: 10, outputTokens: 5, cacheReadTokens: 900, cacheWriteTokens: 30, reasoningTokens: 3 })
  const ok = await streamWith([{ type: 'text-delta', index: 0, text: '三步' }, { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } }])
  assert.equal(ok.text, '三步')
  assert.deepEqual(ok.detail, { blockTypes: ['text'], finish: 'stop', usage: { inputTokens: 10, outputTokens: 5 } })
})

test('dispatchTeam:失败行平铺 finish/blockTypes/providerCode/usage,成功行带 finish/usage 但不带 error', async () => {
  const result = await dispatchTeam(TEAM, { confirm: true, task: 'x' }, {
    streamRole: async (input) => {
      if (input.role === 'implementer') {
        const e = new Error('x'); e.code = 'PROVIDER_ERROR'
        e.detail = { blockTypes: [], finish: 'error', providerCode: 'QUOTA', providerStatus: 402, usage: { inputTokens: 1, outputTokens: 0 } }
        throw e
      }
      return { text: `${input.role} 文本`, detail: { blockTypes: ['text'], finish: 'stop', usage: { inputTokens: 10, outputTokens: 7 } } }
    },
  })
  const [planner, implementer, reviewer] = result.dispatch.turns
  assert.equal(planner.ok, true); assert.equal(planner.finish, 'stop'); assert.equal(planner.usage.outputTokens, 7); assert.equal('error' in planner, false)
  assert.equal(implementer.ok, false); assert.equal(implementer.error, 'PROVIDER_ERROR'); assert.equal(implementer.providerCode, 'QUOTA'); assert.equal(implementer.providerStatus, 402); assert.equal(implementer.finish, 'error')
  assert.equal(reviewer.ok, true)
  // 旧替身返回裸字符串仍可用。
  const plain = await dispatchTeam(TEAM, { confirm: true, task: 'x' }, { streamRole: async () => 'ok' })
  assert.equal(plain.dispatch.turns[0].text, 'ok'); assert.equal('finish' in plain.dispatch.turns[0], false)
})

test('implementer TOOL_CALL retries once without tools and does not invent a final draft on second failure', async () => {
  const systems = []
  const result = await dispatchTeam(TEAM, { confirm: true, task: 'x' }, {
    streamRole: async (input) => {
      systems.push({ role: input.role, system: input.system })
      if (input.role === 'implementer' && !input.system.includes('上一跳被工具块挡下')) {
        const err = new Error('tool')
        err.code = 'TOOL_CALL'
        err.detail = { blockTypes: ['tool-call'], finish: 'tool-calls' }
        throw err
      }
      return `${input.role}-ok`
    },
  })
  const implementer = result.dispatch.turns.find((row) => row.role === 'implementer')
  assert.equal(implementer.ok, true)
  assert.equal(implementer.retried, true)
  assert.equal(implementer.note, IMPLEMENTER_RETRY_COPY)
  assert.equal(implementer.text, 'implementer-ok')
  assert.equal(systems.filter((row) => row.role === 'implementer').length, 2)

  const failed = await dispatchTeam(TEAM, { confirm: true, task: 'x' }, {
    streamRole: async (input) => {
      if (input.role === 'implementer') {
        const err = new Error('tool')
        err.code = 'TOOL_CALL'
        throw err
      }
      return `${input.role}-ok`
    },
  })
  const retryFail = failed.dispatch.turns.find((row) => row.role === 'implementer')
  assert.equal(retryFail.ok, false)
  assert.equal(retryFail.error, 'TOOL_CALL')
  assert.equal(retryFail.retried, true)
  assert.equal(retryFail.text, '')
  assert.equal(failed.dispatch.turns.find((row) => row.role === 'reviewer').ok, true)
})

// C1 — the verdict booking is a read-modify-write, so it has to be one transaction.
// This asserts the *wiring* in-process: that every ledger read and the append all
// happen inside deps.transact(). The mutual exclusion that transact() delegates to
// is proven separately against real child processes in ledger-multiprocess.test.mjs.
test('the verdict booking reads and appends strictly inside one transaction', async () => {
  const decision = { id: 'dec-tx-1', ts: 1, label: 'coding', pick: 'qwen3.8-max', candidates: ['qwen3.8-max', 'minimax-m3'], outcome: null }
  const events = []
  let depth = 0

  const result = await dispatchTeam({ ...TEAM, ref: decision.id }, { confirm: true, task: 'x' }, {
    transact: (fn) => {
      depth += 1
      events.push('enter')
      try {
        return fn()
      } finally {
        events.push('exit')
        depth -= 1
      }
    },
    readRows: () => {
      events.push(depth > 0 ? 'read-inside' : 'read-OUTSIDE')
      return [decision]
    },
    append: (row) => {
      if (row.kind === 'outcome') events.push(depth > 0 ? 'append-inside' : 'append-OUTSIDE')
      return row
    },
    streamRole: async ({ role }) => (role === 'reviewer' ? '判定：通过' : `${role}-ok`),
  })

  assert.equal(result.dispatch.verdictFed, true, 'the accept path must still book')
  assert.equal(events.filter((e) => e === 'enter').length, 1, 'exactly one transaction')

  const enterAt = events.indexOf('enter')
  const exitAt = events.indexOf('exit')
  assert.ok(enterAt >= 0 && exitAt > enterAt, events.join(' → '))

  // One read precedes the transaction: the independence pre-check, which decides
  // whether to call the reviewer model at all. It is read-only, feeds no append, and
  // runs before three model streams — holding the lock across it is what we are
  // specifically avoiding. What matters is that it appends nothing.
  assert.deepEqual(events.slice(0, enterAt).filter((e) => e.startsWith('append')), [])

  // The booking itself — the "already judged?" read and the append it decides — is
  // one critical section, so a second process cannot slip between them.
  const critical = events.slice(enterAt + 1, exitAt)
  assert.ok(critical.includes('read-inside'), events.join(' → '))
  assert.ok(critical.includes('append-inside'), events.join(' → '))
  assert.equal(events.slice(enterAt).some((e) => e.endsWith('OUTSIDE')), false, events.join(' → '))

  // Omitting transact keeps the previous behaviour for every in-process caller.
  const plain = await dispatchTeam({ ...TEAM, ref: decision.id }, { confirm: true, task: 'x' }, {
    readRows: () => [decision],
    append: () => {},
    streamRole: async ({ role }) => (role === 'reviewer' ? '判定：通过' : `${role}-ok`),
  })
  assert.equal(plain.dispatch.verdictFed, true)
})
