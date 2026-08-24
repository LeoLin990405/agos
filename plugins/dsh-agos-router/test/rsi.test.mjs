// RSI(FuguNano 路线)三件套的尺:读取期衰减 / Thompson 标注 / 评审判定飞轮。
// 纪律同全仓:新行为必须有自己的测试;喂后验的每一道门都要有不喂的反例。
import test from 'node:test'
import assert from 'node:assert/strict'
import { applyOutcome } from '../lib/allocation-score.js'
import { allocationStateFromLedger, assembleTeam, effectiveObservations } from '../lib/assemble.js'
import { parseReviewerVerdict, dispatchTeam } from '../lib/dispatch.js'

// mulberry32:确定性 RNG(FuguNano 用同款做 FUGUE_ALLOCATE_SEED)
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const DAY = 24 * 60 * 60 * 1000

test('applyOutcome 权重:默认 1 与 FuguNano 原语义逐位一致;分数权重累加;非法权重不动状态', () => {
  const s1 = applyOutcome([], { taskType: 'coding', agent: 'a', result: 'ok' })
  assert.deepEqual(s1, [{ taskType: 'coding', agent: 'a', s: 1, f: 0 }])
  const s2 = applyOutcome(s1, { taskType: 'coding', agent: 'a', result: 'fail' }, 0.25)
  assert.deepEqual(s2, [{ taskType: 'coding', agent: 'a', s: 1, f: 0.25 }])
  assert.equal(applyOutcome(s2, { taskType: 'coding', agent: 'a', result: 'ok' }, 0), s2)
  assert.equal(applyOutcome(s2, { taskType: 'coding', agent: 'a', result: 'ok' }, Number.NaN), s2)
})

test('读取期衰减:halfLife 关=整数计数;开=按 outcomeAt 折半;缺 outcomeAt 退 ts;台账行原样不动', () => {
  const now = 1_800_000_000_000
  const rows = [
    { id: 'dec-a', ts: now - 10 * DAY, taskType: 'coding', role: 'coder', label: 'coding', pick: 'qwen3.8-max', candidates: [], outcome: null },
    { kind: 'outcome', ref: 'dec-a', result: 'ok', at: now - 10 * DAY, source: 'manual' },
    { id: 'dec-b', ts: now - 20 * DAY, taskType: 'coding', role: 'coder', label: 'coding', pick: 'qwen3.8-max', candidates: [], outcome: null },
    { kind: 'outcome', ref: 'dec-b', result: 'fail', at: now, source: 'manual' }, // 胜负今天才落账:按 outcomeAt 不衰减
  ]
  const off = allocationStateFromLedger(rows, { now })
  assert.deepEqual(off, [{ taskType: 'coding', agent: 'qwen3.8-max', s: 1, f: 1 }])
  const on = allocationStateFromLedger(rows, { halfLifeDays: 10, now })
  assert.equal(on.length, 1)
  assert.ok(Math.abs(on[0].s - 0.5) < 1e-9, '10 天前的 ok 半衰期 10 天 → 权重 0.5')
  assert.ok(Math.abs(on[0].f - 1) < 1e-9, 'outcomeAt=now 的 fail 不衰减(不是按决策 ts 衰减)')
  assert.equal(effectiveObservations(on), 1.5)
  assert.equal(effectiveObservations([...on, { taskType: 'docs', agent: 'x', s: 5, f: 5 }], 'coding'), 1.5, '别的任务类的证据不算进来')
})

test('assembleTeam:默认 mean/无 decay 零行为变化;thompson 用注入 RNG 可复现且 ranking 如实标注', () => {
  const state = [{ taskType: 'implementer', agent: 'qwen3.8-max', s: 3, f: 1 }]
  const mean = assembleTeam({ role: 'implementer', pick: 'qwen3.8-max', source: 'selector' }, state, {})
  assert.equal(mean.ranking, 'mean')
  assert.equal(mean.decay, null)
  const t1 = assembleTeam({ role: 'implementer', pick: 'qwen3.8-max', source: 'selector' }, state, {
    sampling: 'thompson', random: mulberry32(42), halfLifeDays: 7,
  })
  const t2 = assembleTeam({ role: 'implementer', pick: 'qwen3.8-max', source: 'selector' }, state, {
    sampling: 'thompson', random: mulberry32(42), halfLifeDays: 7,
  })
  assert.equal(t1.ranking, 'thompson')
  assert.deepEqual(t1.allocation, t2.allocation, '同种子同样本:采样可复现')
  assert.deepEqual(t1.decay, { halfLifeDays: 7, effectiveObservations: 4 })
  // 采样分数是抽样值:与均值排名的分数不应逐位相同(同状态下均值是确定的)
  assert.notDeepEqual(t1.allocation.map((r) => r.score), mean.allocation.map((r) => r.score))
})

test('parseReviewerVerdict:只认整行判定;歧义与嵌入文本都算未采集', () => {
  assert.equal(parseReviewerVerdict('判定：通过\n实现覆盖了要求。'), 'ok')
  assert.equal(parseReviewerVerdict('  判定: 驳回 \n没有测试。'), 'fail')
  assert.equal(parseReviewerVerdict('我的判定：通过,理由如下'), null, '行内还有别的字 → 不算')
  assert.equal(parseReviewerVerdict('判定：通过\n但也可以说判定：驳回'), 'ok', '第二行非整行,不构成歧义')
  assert.equal(parseReviewerVerdict('判定：通过\n判定：驳回'), 'ambiguous', '两个整行判定同现 = 歧义,成因单列')
  assert.equal(parseReviewerVerdict('实现不错,通过。'), null)
  assert.equal(parseReviewerVerdict(''), null)
  assert.equal(parseReviewerVerdict(undefined), null)
})

function fakeStream(texts) {
  return async ({ role }) => {
    const t = texts[role]
    if (t instanceof Error) throw t
    return t
  }
}

const ASM = { kind: 'assemble', id: 'asm-1', ref: 'dec-rsi-1', roles: [
  { role: 'planner', model: 'glm-5.2' },
  { role: 'implementer', model: 'qwen3.8-max' },
  { role: 'reviewer', model: 'minimax-m3' },
] }
const DECISION_ROWS = [
  { id: 'dec-rsi-1', ts: 1, taskType: 'coding', role: 'implementer', label: 'coding', pick: 'qwen3.8-max', candidates: [], outcome: null },
]

test('评审飞轮:三门全过 → 追加 source:reviewer-verdict 的 outcome 行,dispatch 行如实记 verdictFed', async () => {
  const appended = []
  const out = await dispatchTeam(ASM, { confirm: true }, {
    append: (r) => appended.push(r),
    readRows: () => DECISION_ROWS,
    streamRole: fakeStream({ planner: '三步。', implementer: '改 a.js 一处。', reviewer: '判定：通过\n实现聚焦。' }),
  })
  assert.equal(out.dispatch.verdict, 'ok')
  assert.equal(out.dispatch.verdictFed, true)
  assert.equal(out.dispatch.verdictSkip, null)
  const fed = appended.find((r) => r.kind === 'outcome')
  assert.ok(fed, '必须真的追加了 outcome 行')
  assert.equal(fed.ref, 'dec-rsi-1')
  assert.equal(fed.result, 'ok')
  assert.equal(fed.source, 'reviewer-verdict')
  assert.equal(fed.judge, 'minimax-m3')
})

test('评审飞轮反例矩阵:每道门单独挡得住,且 dispatch 行写明是哪道门', async () => {
  // 门一:实现缺席——评审判的是「实现未采集」,判决属实但对象缺席,不喂
  const a1 = []
  const r1 = await dispatchTeam(ASM, { confirm: true }, {
    append: (r) => a1.push(r),
    readRows: () => DECISION_ROWS,
    streamRole: async ({ role }) => {
      if (role === 'implementer') { const e = new Error('x'); e.code = 'NO_TEXT'; throw e }
      return role === 'reviewer' ? '判定：驳回\n没有实现。' : '三步。'
    },
  })
  assert.equal(r1.dispatch.verdict, 'fail')
  assert.equal(r1.dispatch.verdictFed, false)
  assert.equal(r1.dispatch.verdictSkip, 'IMPLEMENTER_ABSENT')
  assert.equal(a1.filter((r) => r.kind === 'outcome').length, 0)
  // 门二:决策已有胜负——改判不改史,只展示不入账
  const a2 = []
  const r2 = await dispatchTeam(ASM, { confirm: true }, {
    append: (r) => a2.push(r),
    readRows: () => [
      DECISION_ROWS[0],
      { kind: 'outcome', ref: 'dec-rsi-1', result: 'fail', at: 2, source: 'manual' },
    ],
    streamRole: fakeStream({ planner: 'p', implementer: 'i', reviewer: '判定：通过\n好。' }),
  })
  assert.equal(r2.dispatch.verdictSkip, 'ALREADY_JUDGED')
  assert.equal(a2.filter((r) => r.kind === 'outcome').length, 0)
  // 门三:没有台账读取端 → fail-closed
  const a3 = []
  const r3 = await dispatchTeam(ASM, { confirm: true }, {
    append: (r) => a3.push(r),
    streamRole: fakeStream({ planner: 'p', implementer: 'i', reviewer: '判定：通过\n好。' }),
  })
  assert.equal(r3.dispatch.verdictSkip, 'NO_LEDGER')
  assert.equal(a3.filter((r) => r.kind === 'outcome').length, 0)
  // 判定本身未采集:不喂、skip 为 null(没有判定就没有「被挡」一说)
  const a4 = []
  const r4 = await dispatchTeam(ASM, { confirm: true }, {
    append: (r) => a4.push(r),
    readRows: () => DECISION_ROWS,
    streamRole: fakeStream({ planner: 'p', implementer: 'i', reviewer: '实现不错,通过。' }),
  })
  assert.equal(r4.dispatch.verdict, null)
  assert.equal(r4.dispatch.verdictFed, false)
  assert.equal(r4.dispatch.verdictSkip, null)
  assert.equal(a4.filter((r) => r.kind === 'outcome').length, 0)
})


test('归因门:被判的模型不是决策的 pick 时判定不入账(planner 偷 pick / role 非 implementer 两种真实形态)', async () => {
  // 决策 pick=glm-5.2,但组装时 planner 槽拿走了它,implementer 实际是 qwen——评审判的是 qwen 的产出
  const asmStolen = { kind: 'assemble', id: 'asm-2', ref: 'dec-rsi-2', roles: [
    { role: 'planner', model: 'glm-5.2' },
    { role: 'implementer', model: 'qwen3.8-max' },
    { role: 'reviewer', model: 'minimax-m3' },
  ] }
  const rows = [{ id: 'dec-rsi-2', ts: 1, taskType: 'coding', role: 'implementer', label: 'coding', pick: 'glm-5.2', candidates: [], outcome: null }]
  const a = []
  const r = await dispatchTeam(asmStolen, { confirm: true }, {
    append: (x) => a.push(x),
    readRows: () => rows,
    streamRole: fakeStream({ planner: 'p', implementer: 'i', reviewer: '判定：驳回\n空转。' }),
  })
  assert.equal(r.dispatch.verdict, 'fail')
  assert.equal(r.dispatch.verdictFed, false)
  assert.equal(r.dispatch.verdictSkip, 'PICK_NOT_IMPLEMENTER', 'glm 不该替 qwen 挨打')
  assert.equal(a.filter((x) => x.kind === 'outcome').length, 0)
  // 大小写折叠:pick 记 MiniMax-M3、implementer 槽是 minimax-m3 → 视为同一模型,照喂
  const asmCase = { kind: 'assemble', id: 'asm-3', ref: 'dec-rsi-3', roles: [
    { role: 'planner', model: 'glm-5.2' },
    { role: 'implementer', model: 'minimax-m3' },
    { role: 'reviewer', model: 'qwen3.8-max' },
  ] }
  const rows3 = [{ id: 'dec-rsi-3', ts: 1, taskType: 'coding', role: 'implementer', label: 'coding', pick: 'MiniMax-M3', candidates: [], outcome: null }]
  const b = []
  const r3 = await dispatchTeam(asmCase, { confirm: true }, {
    append: (x) => b.push(x),
    readRows: () => rows3,
    streamRole: fakeStream({ planner: 'p', implementer: 'i', reviewer: '判定：通过\n好。' }),
  })
  assert.equal(r3.dispatch.verdictFed, true)
  const fed = b.find((x) => x.kind === 'outcome')
  assert.equal(fed.judged, 'minimax-m3', 'outcome 行自证「判的是谁」')
})

test('verdictNull 三态:评审缺席 / 无整行判定 / 歧义,各记各的成因', async () => {
  const mk = async (reviewerBehavior) => {
    const a = []
    const r = await dispatchTeam(ASM, { confirm: true }, {
      append: (x) => a.push(x),
      readRows: () => DECISION_ROWS,
      streamRole: async ({ role }) => {
        if (role === 'reviewer') {
          if (reviewerBehavior instanceof Error) throw reviewerBehavior
          return reviewerBehavior
        }
        return role === 'implementer' ? 'i' : 'p'
      },
    })
    return { r, fed: a.filter((x) => x.kind === 'outcome').length }
  }
  const dead = new Error('x'); dead.code = 'PROVIDER_ERROR'
  const c1 = await mk(dead)
  assert.equal(c1.r.dispatch.verdict, null); assert.equal(c1.r.dispatch.verdictNull, 'REVIEWER_ABSENT'); assert.equal(c1.fed, 0)
  const c2 = await mk('实现不错,通过。')
  assert.equal(c2.r.dispatch.verdictNull, 'UNPARSEABLE'); assert.equal(c2.fed, 0)
  const c3 = await mk('判定：通过\n判定：驳回')
  assert.equal(c3.r.dispatch.verdict, null); assert.equal(c3.r.dispatch.verdictNull, 'AMBIGUOUS'); assert.equal(c3.fed, 0)
  // 判定在场且入账时 verdictNull 必须为 null
  const ok = await mk('判定：通过\n好。')
  assert.equal(ok.r.dispatch.verdictNull, null); assert.equal(ok.fed, 1)
})
