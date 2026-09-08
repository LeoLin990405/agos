// 离线集成:用假 ctx / 假子代理 / 假 permissionPresets 把「计划模式合并」三件事跑一遍(不花 token)。
//   A4 plan_run approve=true → 真的 swarm 调度器(dsh-kimicode-swarm.runNormalizedBatch)分波跑步骤
//      → 上游结论注入 → 验收 → 写回计划文件 → XML/presentationMeta 能被前端解析
//   A2 plan/mode 事件 ↔ permissionPresets 联动(进入切 read-only、退出恢复;写操作不能在 append 边界内重入)
//   A3 exit_plan_mode 批准 → dsh-plan 块落盘;拒绝/无块 → 不落盘;plan_run 复用 A3 落的那份不重建
// 目的不是验模型输出质量,是验编排与接线。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, readdirSync, writeFileSync, unlinkSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tmp = mkdtempSync(join(tmpdir(), 'dsh-cn-plan-'))
process.env.DSH_CN_PLAN_DIR = join(tmp, 'plans')
process.env.DSH_CN_COUNCIL_LOG = join(tmp, 'council.jsonl')
const PLAN_DIR = process.env.DSH_CN_PLAN_DIR

// ⚠️ env 必须在 import 之前设好:PLAN_DIR 在 apply() 时读一次
const { apply, ownSessionEvents, snapshotSessionEvents } = await import('../lib/index.js')

// ── 假子代理:swarm 调度器的 spawnOneShot 与本插件的 runPanelist 都走 subagents.start('spawn', {...}) ──
function fakeSubagents(script) {
  const started = []
  return {
    started,
    start: async (_provider, opts) => {
      const prompt = (opts.prompt || []).map((p) => p.text || '').join('\n')
      const rec = { label: opts.label, prompt, agentOptions: opts.agentOptions, at: Date.now() }
      started.push(rec)
      const text = await script(rec)
      const events = [{ data: { usage: { inputTokens: 100, outputTokens: 50 } } }]
      return {
        id: 'agent-' + started.length,
        result: Promise.resolve({ stopReason: 'completed', output: [{ type: 'text', text }] }),
        localAgent: { session: {
          get events() { throw new Error('Session.events is private in DSH 0.1.2') },
          ownEvents() { return events },
        } },
        dispose: async () => {},
      }
    },
  }
}

// ── 假会话 + 假 permissionPresets:append 会**同步**把 session/event 派给已注册的 handler,
//    并且像宿主一样在派发期间禁止重入 append(dsh-session 的 "cannot reenter" 守卫)。
function fakeSession(id, handlers) {
  let events = []
  const s = {
    id,
    appending: false,
    get events() { throw new Error('Session.events is private in DSH 0.1.2') },
    snapshotEvents() { return events },
    ownEvents() { return events },
  }
  s.append = (type, data) => {
    if (s.appending) throw new Error('session append cannot reenter while another append is being published')
    const ev = { type, seq: events.length, time: Date.now(), data }
    events = [...events, ev]
    s.appending = true
    try { for (const h of handlers) h(s, ev) } finally { s.appending = false }
    return ev
  }
  return s
}
function fakePresets(sandboxDefault = 'workspace-write') {
  const setCalls = []
  const names = ['read-only', 'workspace-write', 'yolo-auto', 'danger-full-access']
  const pp = {
    names,
    setCalls,
    current: (session) => {
      const events = session.snapshotEvents()
      for (let i = events.length - 1; i >= 0; i--) if (events[i].type === 'permission/preset') return events[i].data.preset
      return sandboxDefault
    },
    set: (session, name) => {
      if (!names.includes(name)) throw new Error('permission: unknown preset "' + name + '"')
      setCalls.push(name)
      if (pp.current(session) !== name) session.append('permission/preset', { preset: name })
      session.append('sandbox/mode', { mode: name === 'read-only' ? 'read-only' : 'workspace-write' })
    },
  }
  return pp
}

function fakeCtx({ subagents, presets } = {}) {
  const tools = new Map()
  const handlers = []
  const ctx = {
    tools: { register: (t) => { tools.set(t.name, t); return () => tools.delete(t.name) } },
    get: (n) => (n === 'subagents' ? subagents : n === 'permissionPresets' ? presets : undefined),
    inject: () => {},
    on: (name, h) => { if (name === 'session/event') handlers.push(h); return () => {} },
  }
  return { ctx, tools, handlers }
}

const tick = () => new Promise((r) => setTimeout(r, 0))
const exec = { agent: { session: { id: 'sess-1' }, id: 'sess-1' }, signal: new AbortController().signal, callId: 'call-plan-1' }
const listPlans = () => { try { return readdirSync(PLAN_DIR).filter((n) => /^plan-\d+\.json$/.test(n)).sort() } catch { return [] } }
const waitForPlan = async (expectedCount, timeoutMs = 2000) => {
  const deadline = Date.now() + timeoutMs
  let lastError
  do {
    const files = listPlans()
    if (files.length === expectedCount) {
      try {
        const saved = JSON.parse(readFileSync(join(PLAN_DIR, files[files.length - 1]), 'utf8'))
        return { files, saved }
      } catch (error) {
        lastError = error
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 5))
  } while (Date.now() < deadline)
  assert.fail(`等待计划完整落盘超时(expected=${expectedCount}): ${String(lastError || '文件数未达到预期')}`)
}

// 三步计划:1 → 2、1 → 3(两波:[1] 然后 [2,3])
const STEPS = [
  { id: 1, title: '读配置', detail: '读出当前配置并列出关键项', dependsOn: [], type: 'explore' },
  { id: 2, title: '改代码', detail: '按配置改代码', dependsOn: [1], type: 'coder' },
  { id: 3, title: '写文档', detail: '按配置写文档', dependsOn: [1], type: 'docs' },
]
const PLAN_MD = '# 迁移配置系统\n\n步骤见下。\n\n```dsh-plan\n' + JSON.stringify({ steps: STEPS }) + '\n```\n'

test('0.1.2 session helpers use public snapshotEvents/ownEvents only', () => {
  const events = [{ type: 'plan/mode', seq: 0, data: { active: true } }]
  const session = {
    get events() { throw new Error('private') },
    snapshotEvents() { return events },
    ownEvents() { return events.slice(0, 1) },
  }
  assert.equal(snapshotSessionEvents(session), events)
  assert.deepEqual(ownSessionEvents(session), events)
})

test('A2: plan/mode active → read-only(记住原预设);inactive → 恢复;写操作不在 append 边界内重入', async () => {
  const presets = fakePresets()
  const { ctx, handlers } = fakeCtx({ presets })
  apply(ctx)
  assert.equal(handlers.length, 1)
  const session = fakeSession('s-a2', handlers)
  session.append('permission/preset', { preset: 'workspace-write' })

  session.append('plan/mode', { active: true })
  // 同步阶段不能已经写过(否则会撞宿主的重入守卫)
  assert.deepEqual(presets.setCalls, [])
  await tick()
  assert.deepEqual(presets.setCalls, ['read-only'])
  assert.equal(presets.current(session), 'read-only')

  // 已经是 read-only 时再进一次:不重复记、不重复切
  session.append('plan/mode', { active: true })
  await tick()
  assert.deepEqual(presets.setCalls, ['read-only'])

  session.append('plan/mode', { active: false })
  await tick()
  assert.deepEqual(presets.setCalls, ['read-only', 'workspace-write'])
  assert.equal(presets.current(session), 'workspace-write')

  // 人在计划模式里手动改了预设 → 退出时不覆盖人的选择
  session.append('plan/mode', { active: true })
  await tick()
  session.append('permission/preset', { preset: 'yolo-auto' })
  session.append('plan/mode', { active: false })
  await tick()
  assert.equal(presets.current(session), 'yolo-auto')
  assert.deepEqual(presets.setCalls, ['read-only', 'workspace-write', 'read-only'])

  // 进入前就是 custom:退出时不尝试 set('custom')(会抛)
  const s2 = fakeSession('s-a2b', handlers)
  const pp2 = fakePresets('custom')
  ctx.get = (n) => (n === 'permissionPresets' ? pp2 : undefined)
  s2.append('plan/mode', { active: true })
  await tick()
  assert.deepEqual(pp2.setCalls, ['read-only'])
  s2.append('plan/mode', { active: false })
  await tick()
  assert.deepEqual(pp2.setCalls, ['read-only'])
})

test('A2: 没有 permissionPresets 服务时安静跳过', async () => {
  const { ctx, handlers } = fakeCtx({})
  apply(ctx)
  const session = fakeSession('s-a2c', handlers)
  session.append('plan/mode', { active: true })
  await tick()
  session.append('plan/mode', { active: false })
  await tick()
  assert.equal(session.snapshotEvents().filter((e) => e.type === 'permission/preset').length, 0)
})

// tool/call + tool/result 的形状照抄宿主(dsh-agent-loop appendToolCall/appendToolResult + dsh-llm createToolResultMessage)
const toolCall = (callId, name, args) => ({ type: 'tool/call', data: { turn: 1, step: 1, callId, name, arguments: JSON.stringify(args) } })
const toolResult = (callId, text, isError) => ({
  type: 'tool/result',
  data: { turn: 1, step: 1, message: { id: 'm-' + callId, role: 'user', source: { kind: 'tool', callId }, content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text }], isError }] } },
})
const sessionWithApproval = (planMd, sessionId = 'sess-1') => {
  const events = [
    toolCall('c-ok', 'exit_plan_mode', { plan: planMd }),
    toolResult('c-ok', 'Plan approved — plan mode exited; carry out the plan starting with your next step.', false),
  ]
  return {
    id: sessionId,
    snapshotEvents() { return events },
    ownEvents() { return events },
  }
}
const execWithApproval = (planMd, sessionId = 'sess-1') => {
  const session = sessionWithApproval(planMd, sessionId)
  return { agent: { session, id: sessionId }, signal: new AbortController().signal, callId: 'call-plan-1' }
}

test('A3: exit_plan_mode 批准 → dsh-plan 块落盘;拒绝 / 无块 / 重复结果 → 不落盘', async () => {
  const { ctx, handlers } = fakeCtx({})
  apply(ctx)
  const fire = (session, ev) => { for (const h of handlers) h(session, ev) }
  const session = { id: 's-a3', snapshotEvents: () => [] }
  const before = listPlans().length

  // 拒绝(Keep planning → execute 抛错 → isError:true)
  fire(session, toolCall('c-rej', 'exit_plan_mode', { plan: PLAN_MD }))
  fire(session, toolResult('c-rej', 'The user chose to keep planning', true))
  await tick(); await tick()
  assert.equal(listPlans().length, before)

  // 无 dsh-plan 块:与原生行为一致,什么都不写
  fire(session, toolCall('c-noblk', 'exit_plan_mode', { plan: '# 纯计划\n\n1. 做 A\n2. 做 B\n' }))
  fire(session, toolResult('c-noblk', 'Plan approved — plan mode exited', false))
  await tick(); await tick()
  assert.equal(listPlans().length, before)

  // 批准
  fire(session, toolCall('c-ok', 'exit_plan_mode', { plan: PLAN_MD }))
  fire(session, toolResult('c-ok', 'Plan approved — plan mode exited; carry out the plan starting with your next step.', false))
  const { files: after, saved } = await waitForPlan(before + 1)
  assert.equal(saved.goal, '迁移配置系统')
  assert.equal(saved.planner, 'plan-mode')
  assert.equal(saved.source, 'plan-mode')
  assert.equal(saved.sessionId, 's-a3')
  assert.equal(saved.markdown, PLAN_MD)
  assert.equal(saved.steps.length, 3)
  assert.equal(saved.steps[1].type, 'coder')

  // 同一 callId 再来一次结果:不重复落盘
  fire(session, toolResult('c-ok', 'Plan approved', false))
  await tick(); await tick()
  assert.equal(listPlans().length, before + 1)
  // 其他工具的 call/result 不受影响
  fire(session, toolCall('c-x', 'read_file', { path: '/tmp/x' }))
  fire(session, toolResult('c-x', 'ok', false))
  await tick()
  assert.equal(listPlans().length, before + 1)
})

test('A4: plan_run approve=true(plan JSON 直传)→ 复用 A3 落的文件 → 两波执行 → 上游注入 → 验收 → 写回 → XML/presentationMeta', async () => {
  // 上一个 test 已经把同一份 STEPS 落成 plan-*.json 且未执行 → 这里应复用它,不新建
  const filesBefore = listPlans()
  assert.ok(filesBefore.length >= 1)
  const script = async (rec) => {
    if (rec.label.startsWith('council:')) return '验收:目标达成,三步都有产出。'
    if (/:1$/.test(rec.label)) { await new Promise((r) => setTimeout(r, 15)); return '配置里有 A=1、B=2。' }
    if (/:2$/.test(rec.label)) return '代码已按 A=1 修改。'
    if (/:3$/.test(rec.label)) return '文档已写。'
    return '完成。'
  }
  const sub = fakeSubagents(script)
  const { ctx, tools } = fakeCtx({ subagents: sub })
  apply(ctx)
  const t = tools.get('plan_run')
  assert.deepEqual(t.output.schema, { type: 'string' })

  const out = await t.execute({ approve: true, plan: JSON.stringify({ steps: STEPS }) }, execWithApproval(PLAN_MD, 's-a3'))
  assert.equal(typeof out, 'string')
  assert.match(out, /<agent_swarm_result>/)
  assert.equal((out.match(/<subagent /g) || []).length, 3)
  assert.match(out, /<plan [^>]*steps="3"[^>]*waves="2"[^>]*review_ok="1"/)
  assert.match(out, /outcome="completed"/)
  assert.match(out, /验收:目标达成/)

  // 分波:步骤 1 先起,2/3 都在 1 结束后才起(上游注入证明它们拿到了 1 的产出)
  const steps = sub.started.filter((r) => /^plan:plan-\d+\.json:\d+$/.test(r.label))
  assert.equal(steps.length, 3)
  assert.match(steps[0].label, /:1$/)
  assert.deepEqual(steps.slice(1).map((r) => r.label.slice(-1)).sort(), ['2', '3'])
  for (const r of steps.slice(1)) {
    assert.match(r.prompt, /上游结论/)
    assert.match(r.prompt, /配置里有 A=1、B=2/)
    assert.match(r.prompt, /输出你负责部分的结论\(自包含\)/)
  }
  assert.doesNotMatch(steps[0].prompt, /上游结论/)
  // 分派表未启用(swarm 插件的 apply 没跑 → resolveModelForType 返回 undefined)→ 全部回落到 executor 默认模型
  for (const r of steps) assert.deepEqual(r.agentOptions, { provider: 'qwen', model: 'qwen3.8-max' })
  // 验收换一家(避开 executor),且无工具
  const rev = sub.started.find((r) => r.label.startsWith('council:'))
  assert.ok(rev)
  assert.equal(rev.agentOptions.provider, 'minimax-cn')

  // presentationMeta:3 行,description 带目标
  const meta = t.output.presentationMeta({ approve: true, plan: 'x' }, out)
  assert.equal(meta.subagents.length, 3)
  assert.equal(meta.subagents.filter((r) => r.status === 'completed').length, 3)
  assert.equal(meta.subagents[0].item, '#1 读配置')
  assert.equal(meta.subagents[0].modelLabel, 'qwen/qwen3.8-max')
  assert.equal(meta.assessment, null)
  assert.match(meta.description, /^\[plan\] 迁移配置系统/)
  assert.equal(meta.plan.steps, 3)
  assert.equal(meta.plan.waves, 2)
  // 不能有 undefined(宿主 snapshotProjection 会拒)
  assert.equal(JSON.parse(JSON.stringify(meta)).subagents.length, 3)
  for (const row of meta.subagents) for (const [k, v] of Object.entries(row)) assert.notEqual(v, undefined, k)

  // 写回:复用了 A3 那份(没有新文件),结果 + 验收 + executedAt 都在,原有 markdown/steps 保留
  const filesAfter = listPlans()
  assert.deepEqual(filesAfter, filesBefore, '应复用 A3 落的文件,不新建')
  const file = join(PLAN_DIR, filesAfter[filesAfter.length - 1])
  const saved = JSON.parse(readFileSync(file, 'utf8'))
  assert.ok(saved.executedAt)
  assert.equal(saved.executor, 'qwen')
  assert.equal(saved.reviewer, 'minimax-cn')
  assert.equal(saved.source, 'plan-mode')
  assert.equal(saved.markdown, PLAN_MD)
  assert.equal(saved.steps.length, 3)
  assert.equal(saved.results.length, 3)
  assert.ok(saved.results.every((r) => r.ok && r.provider === 'qwen' && typeof r.text === 'string'))
  assert.match(saved.review, /目标达成/)
  assert.match(out, new RegExp('file="' + file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '"'))
})

test('A4: 裸 JSON 即使 approve 也只落盘;planFile 批准后执行并记录依赖校验', async () => {
  const sub = fakeSubagents(async (rec) => (rec.label.startsWith('council:') ? '验收:部分达成。' : '产出 ' + rec.label))
  const { ctx, tools } = fakeCtx({ subagents: sub })
  apply(ctx)
  const t = tools.get('plan_run')
  const before = listPlans()
  const plan = { goal: '环与悬空依赖', steps: [
    { id: 'a', title: '甲', detail: '做甲', dependsOn: ['b'] },
    { id: 'b', title: '乙', detail: '做乙', dependsOn: ['a', 'zzz'] },
    { id: 'c', title: '丙', detail: '做丙', dependsOn: [] },
    { id: 'c', title: '重复', detail: '重复 id', dependsOn: [] },
  ] }
  const staged = await t.execute({ approve: true, plan: JSON.stringify(plan), executor: 'doubao' }, exec)
  const after = listPlans()
  assert.equal(after.length, before.length + 1)
  assert.match(staged, /计划已存盘但\*\*未执行\*\*/)
  assert.match(staged, /approve=true, planFile=/)
  assert.equal(sub.started.length, 0)
  const file = join(PLAN_DIR, after[after.length - 1])
  const cyclicMd = '# 环与悬空依赖\n\n```dsh-plan\n' + JSON.stringify({ steps: plan.steps }) + '\n```\n'
  const approvedExec = execWithApproval(cyclicMd)
  const out = await t.execute({ planFile: file, approve: true, executor: 'doubao' }, approvedExec)
  assert.match(out, /依赖不存在的 zzz/)
  assert.match(out, /重复/)
  assert.match(out, /依赖成环/)
  assert.match(out, /<plan [^>]*steps="3"[^>]*waves="2"[^>]*cyclic="1"/)
  assert.equal((out.match(/<subagent /g) || []).length, 3)
  // 丙无依赖先跑,甲乙成环放最后一波
  const labels = sub.started.filter((r) => r.label.startsWith('plan:')).map((r) => r.label.split(':').pop())
  assert.equal(labels[0], 'c')
  assert.deepEqual(labels.slice(1).sort(), ['a', 'b'])
  // executor=doubao → 默认模型 doubao-seed-evolving;验收避开 doubao
  assert.equal(sub.started[0].agentOptions.provider, 'doubao')
  assert.equal(sub.started[0].agentOptions.model, 'doubao-seed-evolving')
  assert.equal(sub.started.find((r) => r.label.startsWith('council:')).agentOptions.provider, 'minimax-cn')
  const saved = JSON.parse(readFileSync(join(PLAN_DIR, after[after.length - 1]), 'utf8'))
  assert.equal(saved.goal, '环与悬空依赖')
  assert.equal(saved.source, 'plan-mode')
  assert.equal(saved.results.length, 3)

  // 再用 planFile 路径跑一次(approve=false → 只显示,不执行;approve=true → 执行并写回同一文件)
  const shown = await t.execute({ planFile: file }, exec)
  assert.match(shown, /未获批准/)
  assert.doesNotMatch(shown, /<subagent /)
  const meta0 = t.output.presentationMeta({ planFile: file }, shown)
  assert.equal(meta0.subagents.length, 0)
  assert.match(meta0.description, /尚未执行/)
  const n0 = sub.started.length
  const out2 = await t.execute({ planFile: file, approve: true }, approvedExec)
  assert.equal((out2.match(/<subagent /g) || []).length, 3)
  assert.ok(sub.started.length > n0)
  assert.equal(listPlans().length, after.length, 'planFile 路径不新建文件')
})

test('A4 note: approve=true / approvedAt 不是宿主批准(evaluatePlanApproval 保持 UNWIRED/UNAPPROVED)', async () => {
  const { evaluatePlanApproval } = await import('../lib/plan-approval.mjs')
  const plan = { steps: STEPS }
  const noHost = evaluatePlanApproval({ sessionId: 'sess-1', plan })
  assert.equal(noHost.ok, false)
  assert.equal(noHost.code, 'UNWIRED')
  const stamped = evaluatePlanApproval({
    sessionId: 'sess-1',
    plan,
    approvalRecord: { approvedAt: '2026-09-08T10:00:00.000Z', steps: STEPS },
  })
  assert.equal(stamped.ok, false)
  assert.equal(stamped.code, 'UNAPPROVED')
  assert.equal(stamped.reason, 'approvedAt-is-not-authorization')
})

test('plan phase: 无 goal 报错;计划者返回 JSON → 存盘 → 返回 markdown 表(零行)', async () => {
  const sub = fakeSubagents(async () => '{"steps":[{"id":1,"title":"甲","detail":"做甲","dependsOn":[],"type":"fast"},{"id":2,"title":"乙","detail":"做乙","dependsOn":[1]}]}')
  const { ctx, tools } = fakeCtx({ subagents: sub })
  apply(ctx)
  const t = tools.get('plan_run')
  assert.match(await t.execute({}, exec), /必须给 goal/)
  const before = listPlans().length
  const out = await t.execute({ goal: '拆两步' }, exec)
  assert.match(out, /计划已生成/)
  assert.match(out, /\| 1 \| 甲 \| — \| fast \|/)
  assert.match(out, /\| 2 \| 乙 \| 1 \| — \|/)
  assert.match(out, /approve=true, planFile=/)
  assert.doesNotMatch(out, /<subagent /)
  assert.equal(listPlans().length, before + 1)
  const meta = t.output.presentationMeta({ goal: '拆两步' }, out)
  assert.equal(meta.subagents.length, 0)
  assert.equal(meta.description, '[plan] 拆两步 · 尚未执行')
  assert.equal(meta.plan, null)
  // 计划者子代理用的是 planner 默认 deepseek-official
  assert.equal(sub.started[0].agentOptions.provider, 'deepseek-official')
})

test('production approval does not relabel inherited parent events as current-session approval', async () => {
  const sub = fakeSubagents(async () => { throw new Error('must not start') })
  const { ctx, tools } = fakeCtx({ subagents: sub })
  apply(ctx)
  const parent = sessionWithApproval(PLAN_MD, 'parent')
  const child = { id: 'child', snapshotEvents: () => parent.snapshotEvents(), ownEvents: () => [] }
  const output = await tools.get('plan_run').execute({ approve: true, plan: JSON.stringify({ steps: STEPS }) },
    { ...exec, agent: { session: child } })
  assert.match(output, /未执行/)
  assert.equal(sub.started.length, 0)
})

test('production council malformed arbiter structure renders inconclusive rather than a fabricated disagreement', async () => {
  const sub = fakeSubagents(async (rec) => rec.label === 'council:stepfun' ? '{}' : '独立答案')
  const { ctx, tools } = fakeCtx({ subagents: sub })
  apply(ctx)
  const tool = tools.get('council')
  const result = await tool.execute({ question: 'fixture', panel: ['qwen', 'doubao'], arbiter: 'stepfun' }, exec)
  assert.equal(result.consensus, false)
  assert.equal(result.inconclusive, true)
  const rendered = tool.output.render({}, result).map((block) => block.text).join('\n')
  assert.match(rendered, /未能核验/)
  assert.doesNotMatch(rendered, /各家一致|存在分歧/)
  const saved = JSON.parse(readFileSync(process.env.DSH_CN_COUNCIL_LOG, 'utf8').trim().split('\n').at(-1))
  assert.equal(saved.parsedOk, false)
  assert.equal(saved.consensus, false)
})

test('plan execution never writes old results over steps edited during execution', async () => {
  mkdirSync(PLAN_DIR, { recursive: true })
  const file = join(PLAN_DIR, 'plan-9100000000001.json')
  writeFileSync(file, JSON.stringify({ sessionId: 'changed-plan', steps: STEPS }))
  let edited = false
  const sub = fakeSubagents(async (rec) => {
    if (rec.label.startsWith('plan:') && !edited) {
      edited = true
      writeFileSync(file, JSON.stringify({ sessionId: 'changed-plan', steps: [{ ...STEPS[0], detail: 'new unapproved instruction' }] }))
    }
    return 'completed output'
  })
  const { ctx, tools } = fakeCtx({ subagents: sub })
  apply(ctx)
  const output = await tools.get('plan_run').execute({ approve: true, planFile: file }, execWithApproval(PLAN_MD, 'changed-plan'))
  assert.match(output, /persisted="0"/)
  assert.match(output, /结果未持久化/)
  assert.match(output, /completed output/)
  const after = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(after.steps[0].detail, 'new unapproved instruction')
  assert.equal(after.results, undefined)
})

test('missing plan at writeback preserves returned execution results and reports persistence failure', async () => {
  const file = join(PLAN_DIR, 'plan-9100000000002.json')
  writeFileSync(file, JSON.stringify({ sessionId: 'deleted-plan', steps: STEPS }))
  let removed = false
  const sub = fakeSubagents(async (rec) => {
    if (rec.label.startsWith('plan:') && !removed) { removed = true; unlinkSync(file) }
    return 'completed output'
  })
  const { ctx, tools } = fakeCtx({ subagents: sub })
  apply(ctx)
  const output = await tools.get('plan_run').execute({ approve: true, planFile: file }, execWithApproval(PLAN_MD, 'deleted-plan'))
  assert.match(output, /persisted="0"/)
  assert.match(output, /结果未持久化/)
  assert.match(output, /completed output/)
  assert.throws(() => readFileSync(file), /ENOENT/)
})

test.after(() => { try { rmSync(tmp, { recursive: true, force: true }) } catch {} })
