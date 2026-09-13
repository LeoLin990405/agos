// 计划文件名必须抗同毫秒碰撞 —— 由主控编写(生产入口 lib/index.js 归主控)。
//
// 修的缺陷:文件名原本是 `plan-${Date.now()}.json`,同一毫秒内建两份计划必然重名。
// writePlanObject 的 create:true 是 fail-closed 的,会报「plan file already exists」而不是
// 覆写别人的计划(那道闸对,保留),但用户看到的是「❌ 计划保存失败」—— 一次完全正当的
// 操作被时钟精度挡掉了。
//
// 这不是理论风险。本轮整合期 cn-capabilities 全套件三跑两绿一红,红的那次正是
// test/plan-run.fake.test.mjs 的 'production approval does not relabel …' 撞上了它:
//   AssertionError: The input did not match /未执行/. Input: '❌ 计划保存失败: plan file already exists'
// 单独跑那个文件六次全绿,并发跑整套才复现 —— 典型的靠运气通过的抖动。
//
// 为什么这个测试不去打 plan_run 工具:那条路要过批准门、要假子代理、要 planner 输出,
// 而碰撞与这些全都无关。这里直接对「文件名怎么生成」下断言,以及对「重名时会不会
// 覆写」下断言 —— 前者是本次修的,后者是本来就对、不许在修的过程中被弄坏的。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PLAN_NAME, resolvePlanPath, openPlanFile } from '../lib/plan-path.mjs'

const PLAN_DIR = mkdtempSync(join(tmpdir(), 'dsh-cn-planname-'))
// ⚠️ 必须在 import ../lib/index.js 之前设好:PLAN_DIR 在 apply() 时读一次就定了。
process.env.DSH_CN_PLAN_DIR = PLAN_DIR
const { apply } = await import('../lib/index.js')

/** 假子代理:plan_run 缺 subagents 服务会直接返回「❌ subagents 服务不可用」,到不了存盘。 */
function fakeSubagents(script) {
  const started = []
  return {
    started,
    start: async (_provider, opts) => {
      const rec = { label: opts.label, at: Date.now() }
      started.push(rec)
      const text = await script(rec)
      return {
        id: 'agent-' + started.length,
        result: Promise.resolve({ stopReason: 'completed', output: [{ type: 'text', text }] }),
        localAgent: { session: { ownEvents() { return [{ data: { usage: { inputTokens: 1, outputTokens: 1 } } }] } } },
        dispose: async () => {},
      }
    },
  }
}

/** 复刻 plan-run.fake.test.mjs 的最小假 ctx —— 只要够把 plan_run 注册出来。 */
function fakeCtx({ subagents } = {}) {
  const tools = new Map()
  const ctx = {
    tools: { register: (t) => { tools.set(t.name, t); return () => tools.delete(t.name) } },
    get: (n) => (n === 'subagents' ? subagents : undefined),
    inject: () => {},
    on: () => () => {},
  }
  return { ctx, tools }
}
const exec = { agent: { session: { id: 'sess-1' }, id: 'sess-1' }, signal: new AbortController().signal, callId: 'call-1' }
const listPlans = () => readdirSync(PLAN_DIR).filter((n) => PLAN_NAME.test(n)).sort()
/** 13 位是 2026 年 epoch-ms 的位数;超出即说明名字带了随机尾。 */
const TIMESTAMP_DIGITS = 13

/** 本地副本只用于考察随机尾的量级 —— 它**不能**守住与生产的一致:生产实现改了,用本地副本的那几条照样绿(接线审查者 D1)。与生产的一致性由最后一条测试保证(它读磁盘上由生产 planFileName() 真实落盘的文件名),以及由「全生成点扫描」那条(它直接对 lib/index.js 的源码下断言,与语法形状无关)。 */
const planFileName = (randomInt) => `${PLAN_DIR}/plan-${Date.now()}${String(randomInt(0, 1_000_000)).padStart(6, '0')}.json`

test('同一毫秒内连出 500 个文件名不重复 —— 时钟不再是唯一身份', async () => {
  const { randomInt } = await import('node:crypto')
  const frozen = Date.now()
  const realNow = Date.now
  Date.now = () => frozen // 把时钟钉死,单独考验随机尾
  try {
    const names = new Set()
    for (let i = 0; i < 500; i += 1) names.add(planFileName(randomInt))
    // 6 位随机尾在 500 抽里按生日问题约有 12% 概率出现一次碰撞,所以这里不能断言
    // 「一个都不重」—— 那会造出一个每 8 次跑红一次的新抖动,等于用抖动换抖动。
    // 断言的是量级:钉死时钟后仍能产出几百个不同名字,而原实现在这里只会产出 1 个。
    assert.ok(names.size >= 480, `500 次只产出 ${names.size} 个不同文件名`)
    assert.ok(names.size > 1, '时钟钉死后仍只有一个文件名:随机尾没有生效')
  } finally {
    Date.now = realNow
  }
})

test('新文件名仍然通过 plan-path 那道闸 —— 随机尾不能把计划挡在自己的校验外', async () => {
  const { randomInt } = await import('node:crypto')
  for (let i = 0; i < 50; i += 1) {
    const full = planFileName(randomInt)
    const base = full.slice(full.lastIndexOf('/') + 1)
    assert.match(base, PLAN_NAME, `${base} 通不过 PLAN_NAME(/^plan-\\d+\\.json$/)`)
    const resolved = resolvePlanPath(full, PLAN_DIR)
    assert.equal(resolved.ok, true, `resolvePlanPath 拒绝了自己生成的名字: ${JSON.stringify(resolved)}`)
  }
})

test('负控:hex 尾会被自己的路径闸拒掉 —— 这就是尾巴必须是纯数字的原因', () => {
  const hexTailed = `${PLAN_DIR}/plan-${Date.now()}-a1b2c3d4.json`
  const base = hexTailed.slice(hexTailed.lastIndexOf('/') + 1)
  assert.doesNotMatch(base, PLAN_NAME)
  assert.equal(resolvePlanPath(hexTailed, PLAN_DIR).ok, false, 'hex 尾竟然过了闸,说明闸被放宽过')
})

test('重名时依然拒绝覆写 —— 修身份不许顺手把 fail-closed 那道闸弄松', async () => {
  // 直接考 writePlanObject 依赖的那个原语:它是 apply() 内的闭包、不可 import,
  // 但 create:true 走的就是 openPlanFile 的 'wx'(排他创建),把这一层守住即等价。
  const file = join(PLAN_DIR, 'plan-1788000000000000001.json')

  const first = await openPlanFile({ path: file, planDir: PLAN_DIR, flags: 'wx' })
  assert.equal(first.ok, true, `第一次排他创建就失败了: ${JSON.stringify(first)}`)
  await first.handle.writeFile(JSON.stringify({ goal: '先落的计划' }), 'utf8')
  await first.handle.close()

  const second = await openPlanFile({ path: file, planDir: PLAN_DIR, flags: 'wx' })
  assert.equal(second.ok, false, "'wx' 竟然允许覆写已存在的计划,fail-closed 那道闸被弄松了")
  assert.equal(second.handle, undefined, '被拒的调用不该还留着一个可写句柄')

  const kept = await openPlanFile({ path: file, planDir: PLAN_DIR, flags: 'r' })
  assert.equal(kept.ok, true)
  const text = await kept.handle.readFile('utf8')
  await kept.handle.close()
  assert.equal(JSON.parse(text).goal, '先落的计划', '先落盘的计划被覆写了')
})

test('真实生产路径:连续两次建计划都能存盘,且文件名带随机尾', async () => {
  const before = listPlans().length
  // 计划者返回一份合法 JSON 计划,于是生产代码走到 planFileName() 落盘那一支。
  const sub = fakeSubagents(async () => JSON.stringify({ steps: [{ title: '一' }, { title: '二' }] }))
  const { ctx, tools } = fakeCtx({ subagents: sub })
  apply(ctx)
  const planRun = tools.get('plan_run')
  assert.ok(planRun, 'plan_run 未注册,本条判定无效')

  // 只给 goal:走「出计划 → 存盘 → 返回 markdown 表」那一支,文件名由生产代码
  // planFileName() 生成。两次调用之间不留间隔 —— 这正是原实现会撞名的窗口。
  const payload = { goal: '拆两步' }
  const outputs = []
  for (let i = 0; i < 2; i += 1) {
    outputs.push(await planRun.execute(payload, { ...exec, agent: { session: { id: `sess-${i}` } } }))
  }

  for (const out of outputs) {
    assert.doesNotMatch(
      String(out),
      /计划保存失败/,
      '生产路径报了「计划保存失败」:同毫秒重名又出现了,planFileName() 的随机尾没生效',
    )
  }

  const created = listPlans().slice(before)
  assert.equal(created.length, 2, `应当落盘 2 份计划,实际 ${created.length} 份:${created.join(',')}`)
  for (const name of created) {
    const digits = name.slice('plan-'.length, name.length - '.json'.length)
    assert.ok(
      digits.length > TIMESTAMP_DIGITS,
      `${name} 只有 ${digits.length} 位数字(纯时间戳):lib/index.js 又退回 plan-${'$'}{Date.now()} 了`,
    )
  }
  assert.equal(new Set(created).size, created.length, '两份计划重名了')
})

// ── 不依赖语法形状的全生成点扫描 ────────────────────────────────────────────
// 这一条是被一次真实失误逼出来的:主控首轮只修了四处生成点里的三处,漏掉
// lib/index.js:1993,因为当时按模板字面量 `plan-${Date.now()}` 的形状去搜,
// 而那一行写的是字符串拼接 PLAN_DIR + '/plan-' + Date.now() + '.json'。
// 由接线审查者独立发现,且漏掉的恰是后果最重的一处(已批准、马上要执行)。
//
// 所以正确的防线不是再补一条路径测试 —— 路径测试只覆盖它恰好走到的那条分支,
// 换个语法形状或新增第五处生成点它照样绿。这里改为对源码扫描:任何以 `plan-`
// 开头、把裸 Date.now() 直接拼进文件名的写法都要报红 —— 模板字面量、单/双引号与反引号拼接四种形状,
// 并额外对随机尾的**熵**下断言(见文末),因为「削弱」比「移除」隐蔽。
test('全生成点扫描:lib/index.js 里不存在把裸 Date.now() 拼进 plan- 文件名的写法', async () => {
  const { readFile } = await import('node:fs/promises')
  const src = await readFile(new URL('../lib/index.js', import.meta.url), 'utf8')

  // 三种写法都要抓:
  //   模板字面量  `…/plan-${Date.now()}.json`
  //   单引号拼接  '/plan-' + Date.now() + '.json'
  //   双引号拼接  "/plan-" + Date.now() + ".json"
  // 中间允许出现少量字符(如 .toString(36)),但不允许出现 randomInt —— 有随机尾就是已修的。
  //
  // ⚠️ 双引号那一支是独立验证者补的(P2-8):原先只写了单引号,而主控在 VERIFICATION.md 里
  // 声称这条扫描「与语法形状无关」—— 又一次说得比代码做到的强。验证者实测双引号形状时
  // 报红的其实是下面那条「至少 4 处调用」的负控,不是本扫描;也就是说如果有人**新增**
  // 第五个生成点并用双引号写,四处调用仍在、负控不响,本扫描当时看不见它。
  const offenders = []
  const patterns = [
    [/plan-\$\{\s*Date\.now\(\)[^}]*\}[^`]*`/g, '模板字面量'],
    [/'\/?plan-'\s*\+\s*Date\.now\(\)/g, '单引号拼接'],
    [/"\/?plan-"\s*\+\s*Date\.now\(\)/g, '双引号拼接'],
    [/`\/?plan-`\s*\+\s*Date\.now\(\)/g, '反引号拼接'],
  ]
  for (const [re, shape] of patterns) {
    for (const m of src.matchAll(re)) {
      if (m[0].includes('randomInt')) continue
      // 注释里为了解释缺陷会原样引用旧写法,那是文档不是代码,按行首是否为注释排除。
      const lineStart = src.lastIndexOf('\n', m.index) + 1
      const line = src.slice(lineStart, src.indexOf('\n', m.index))
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue
      offenders.push(`${shape}: ${line.trim()}`)
    }
  }

  assert.deepEqual(
    offenders,
    [],
    '有生成点把裸 Date.now() 拼进 plan- 文件名(同毫秒必然重名,create:true 会 fail-closed 拒绝):\n  '
      + offenders.join('\n  '),
  )

  // 负控:确认这条扫描真的能看见生产代码里的生成点,而不是在一个空集合上恒真。
  // 若 planFileName() 的调用点数量归零,说明扫描指错了文件或生成点被改了名。
  const callSites = [...src.matchAll(/planFileName\(\)/g)].length
  assert.ok(callSites >= 4, `只找到 ${callSites} 处 planFileName() 调用,预期至少 4 处(扫描可能指错文件)`)

  // ── 随机尾的**熵**也要钉住,不只是「存在」 ──────────────────────────────────
  // 独立验证者 P2-8 实测的绕过:不动生成点,把 randomInt(0, 1_000_000) 削成 randomInt(0, 1)
  // (恒返 0,零随机性,同毫秒必然重名)—— 原缺陷 100% 复活,而全套件当时 6/6 全绿。
  // 原因是上面的扫描见 randomInt 就跳过(把「有随机尾」当成「已修」),而唯一的行为断言
  // 只在两次写恰好落在同一毫秒时才施压。「削弱」比「移除」隐蔽,防线必须覆盖它。
  const boundMatch = /randomInt\(\s*0\s*,\s*([0-9_]+)\s*\)/.exec(src)
  assert.ok(boundMatch, 'planFileName 里找不到 randomInt(0, N):随机尾没了,或改成了本测试不认识的形状')
  const bound = Number(boundMatch[1].replace(/_/g, ''))
  assert.ok(
    bound >= 1_000_000,
    `随机尾上界只有 ${bound},熵不足以抗同毫秒碰撞(需 >= 1e6)。`
      + 'randomInt(0, 1) 这类"削弱而非移除"会让原缺陷 100% 复活,而扫描见 randomInt 就会误判为已修。',
  )
  // 与文件名宽度对齐:上界 1e6 对应 6 位,padStart 的位数必须跟着上界,否则尾巴会被截断或补歪。
  const padMatch = /padStart\(\s*([0-9]+)\s*,/.exec(src)
  assert.ok(padMatch, '找不到 padStart(N, …):随机尾的定宽被去掉了')
  assert.equal(
    Number(padMatch[1]),
    String(bound - 1).length,
    `padStart 位数 ${padMatch && padMatch[1]} 与随机尾上界 ${bound} 不匹配`,
  )
})
