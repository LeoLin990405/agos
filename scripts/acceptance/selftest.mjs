#!/usr/bin/env node
// A4:负控自检 —— 证明验收器**没法**谎报成功。
//
// 每条控制都真的把 run-acceptance.mjs 当子进程跑一遍,同时断言
//   (1) 进程退出码  (2) 落盘 JSON 里的判定
// 两处都不许说谎。
//
// 跑法:node --test scripts/acceptance/selftest.mjs
// 正式门也会跑它(run-acceptance.mjs 的默认计划里有 selftest 闸),防递归靠哨兵
// AGOS_ACCEPTANCE_SELFTEST=1 —— 见 runnerEnv() 与 NC16。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, cpSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { REPO_ROOT, verdictOf, parseNodeTestCounts } from './lib/exec.mjs'

const HERE = dirname(new URL(import.meta.url).pathname)
// 可指向被故意改坏的验收器副本:用来证明这些负控**不是空转**(见 mutation-check.sh)。
const RUNNER = process.env.AGOS_SELFTEST_RUNNER ? resolve(process.env.AGOS_SELFTEST_RUNNER) : join(HERE, 'run-acceptance.mjs')
const FIXTURES = 'scripts/acceptance/selftest-fixtures'
const SELFTEST_SENTINEL = 'AGOS_ACCEPTANCE_SELFTEST'

/**
 * spawn 验收器用的环境。两件事都是必须做的:
 *
 * 1. **剔除 node --test 的上下文变量**。本自检自己是 `node --test` 跑的,它 spawn 的验收器
 *    又会 spawn `node --test`。NODE_TEST_CONTEXT 一路传下去时,最里层的 `node --test`
 *    会打印 "node:test run() is being called recursively ... skipping running files",
 *    **一个文件都不跑、连摘要都不打、退出码 0**(v26.7.0 实测)。
 *    验收器自己的 neutralEnv 也剔这两个变量,这里是同一件事在上一跳再做一遍:
 *    别让验收器进程本身带着测试运行器的上下文。JSON 里的 environment.nodeTestContext
 *    把「验收器收到了什么」记下来,NC17 据此钉住这条清理真的发生了。
 *
 * 2. **置防递归哨兵**。正式门的默认计划里含本自检;本自检的每条负控又都 spawn 验收器。
 *    子验收器要是再把自检放进默认计划,就是无限递归。哨兵让它不放。NC16 双向验证。
 */
import { surfaceInputsDigest } from './lib/surface-inputs.mjs'

/** 当前 HEAD —— 合成依赖面要能声称"我量的就是这棵树",否则永远被判陈旧。 */
function currentRepoHead() {
	const res = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' })
	return res.status === 0 ? String(res.stdout).trim() : 'unknown'
}

function runnerEnv(extra = {}) {
	const env = { ...process.env }
	for (const k of ['NODE_TEST_CONTEXT', 'NODE_OPTIONS']) delete env[k]
	env[SELFTEST_SENTINEL] = '1'
	for (const [k, v] of Object.entries(extra)) {
		if (v === undefined) delete env[k]
		else env[k] = String(v)
	}
	return env
}

/**
 * 合成计数下限基线。
 *
 * ⚠️ 为什么必须给(本轮修的回归,外部核查者 Luna 实测):验收器对「--floors 指向的文件不存在」
 * 是 fail-closed 的(退 78)。上一轮这里传的是一个**不存在**的路径,于是 14 项里 13 项
 * 在到达自己的目标断言前就被 fail-closed 拦死(实测 exit 1 / pass 1 / fail 13)。
 *
 * 正确修法是给**真实的合成基线**(内容与本次合成计划一一对应),
 * **不是**让验收器在缺基线时恢复静默通过 —— 生产路径缺基线必须继续 fail-closed,
 * 那条行为由 NC10 系列单独钉住(显式传不存在/空/坏 JSON 的路径,断言退 78)。
 */
function synthesizeFloors({ plan, requiredPlugins }) {
	const floors = {}
	for (const g of plan?.codeGates ?? []) {
		if (g.kind && g.kind !== 'node-test') continue
		floors[g.id] = { minTests: Math.max(1, g.minTests ?? 1), minPass: Math.max(1, g.minPass ?? 1) }
	}
	for (const p of requiredPlugins ?? []) floors[p] ??= { minTests: 1, minPass: 1 }
	// 基线不许是空对象(验收器 fail-closed 会拒),给一条与本次计划无关的占位。
	if (Object.keys(floors).length === 0) floors['__selftest-placeholder__'] = { minTests: 1, minPass: 1 }
	return {
		schema: 'agos-acceptance/expected-counts@1',
		note: '自检合成基线:与本次合成计划一一对应,不是真实实测基线。',
		floors,
	}
}

/**
 * 跑一次验收器,回真实退出码 + 落盘 JSON。
 *
 * plan 省略 → 走验收器**真实的 defaultPlan 代码路径**(配 --required-plugins/--plugins-root
 * 指向合成套件树)。结构性负控(整包缺失/空目录/缺基线条目)必须走这条路:
 * 自定义 --plan 压根不经过 defaultPlan,用它证明不了 defaultPlan 的行为。
 */
function runRunner({
	plan = null, surface = null,
	floors = null, floorsRaw = null, floorsMissing = false, floorsDisabled = false,
	requiredPlugins = null, pluginsRoot = null, selftestFile = null,
	hostIntegrations = undefined,
	extraArgs = [], env = {},
}) {
	const work = mkdtempSync(join(tmpdir(), 'agos-selftest-'))
	const jsonPath = join(work, 'results.json')
	const argv = [RUNNER, `--json=${jsonPath}`, `--logdir=${join(work, 'logs')}`]
	if (plan) {
		const planPath = join(work, 'plan.json')
		writeFileSync(planPath, JSON.stringify(plan, null, 2))
		argv.push(`--plan=${planPath}`)
	} else {
		argv.push('--no-advisory')   // 默认计划含部署漂移;合成运行不需要真去跑部署脚本
	}
	if (surface) { const sp = join(work, 'surface.json'); writeFileSync(sp, JSON.stringify(surface, null, 2)); argv.push(`--surface=${sp}`) }
	else argv.push(`--surface=${join(work, 'no-such-surface.json')}`)   // 默认不让负控依赖真实实测文件
	// 宿主集成清单同理:默认注入一份**空**清单,让负控在"没有任何豁免"的基准上判定。
	// 不指向仓里那份真清单 —— 否则负控的结论会随真清单增删而漂。
	if (hostIntegrations !== undefined) {
		const hp = join(work, 'host-integrations.json')
		writeFileSync(hp, typeof hostIntegrations === 'string' ? hostIntegrations : JSON.stringify(hostIntegrations, null, 2))
		argv.push(`--host-integrations=${hp}`)
	} else {
		const hp = join(work, 'host-integrations-empty.json')
		writeFileSync(hp, JSON.stringify({ schema: 'agos-acceptance/host-integrations@1', integrations: [] }, null, 2))
		argv.push(`--host-integrations=${hp}`)
	}
	if (floorsDisabled) argv.push('--floors=none')
	else if (floorsMissing) argv.push(`--floors=${join(work, 'no-such-floors.json')}`)
	else {
		const fp = join(work, 'floors.json')
		writeFileSync(fp, floorsRaw !== null ? floorsRaw : JSON.stringify(floors ?? synthesizeFloors({ plan, requiredPlugins }), null, 2) + '\n')
		argv.push(`--floors=${fp}`)
	}
	if (requiredPlugins) argv.push(`--required-plugins=${requiredPlugins.join(',')}`)
	if (pluginsRoot) argv.push(`--plugins-root=${pluginsRoot}`)
	if (selftestFile) argv.push(`--selftest-file=${selftestFile}`)
	argv.push(...extraArgs)
	const res = spawnSync(process.execPath, argv, { cwd: REPO_ROOT, encoding: 'utf8', timeout: 300000, env: runnerEnv(env) })
	const json = existsSync(jsonPath) ? JSON.parse(readFileSync(jsonPath, 'utf8')) : null
	return { exitCode: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '', json, work, argv }
}

/**
 * 造一棵合成套件树,让结构性负控走真实的 defaultPlan。
 * kind:'no-test-dir' 整个 test/ 不存在 | 'empty-test-dir' 目录存在但空 | 'no-mjs' 有文件但没 .mjs
 *      其余值当作 selftest-fixtures/<kind>/test 的固件名(passing / failing / skipped / mixed / zero)
 */
function makePluginRoot(specs) {
	const root = mkdtempSync(join(tmpdir(), 'agos-selftest-plugins-'))
	for (const [name, kind] of Object.entries(specs)) {
		if (kind === 'no-test-dir') continue
		const testDir = join(root, name, 'test')
		mkdirSync(testDir, { recursive: true })
		if (kind === 'empty-test-dir') continue
		if (kind === 'no-mjs') { writeFileSync(join(testDir, 'NOTES.txt'), '这里一个 .mjs 都没有\n'); continue }
		cpSync(join(REPO_ROOT, FIXTURES, kind, 'test'), testDir, { recursive: true })
	}
	return root
}

/** spawnSync 不过 shell,glob 不会展开;而且 Node v26 的 `--test test/`(目录参数)会直接失败。
 *  所以这里自己列文件,和 run-acceptance.mjs 的默认计划同一个做法。 */
function fixtureFiles(dir) {
	return readdirSync(join(REPO_ROOT, FIXTURES, dir, 'test')).filter((f) => f.endsWith('.mjs')).sort().map((f) => `test/${f}`)
}
const nodeTestGate = (id, dir, extra = {}) => ({ id, cwd: `${FIXTURES}/${dir}`, argv: ['node', '--test', ...fixtureFiles(dir)], kind: 'node-test', required: true, ...extra })
const suiteOf = (json, id) => json.codeGate.suites.find((s) => s.id === id)

// ─────────────────────────────────────────────────────────────────────────────
// 元控制:先证明验收器**能**报绿。否则一个"永远报红"的验收器会白拿下面全部负控分。
// ─────────────────────────────────────────────────────────────────────────────
test('META: 真的能过的套件 → 退出 0、verdict pass、代码闸绿', () => {
	const r = runRunner({ plan: { codeGates: [nodeTestGate('ctl-passing', 'passing')], advisory: [] } })
	assert.equal(r.exitCode, 0, '真绿的运行必须退出 0')
	assert.equal(r.json.codeGate.green, true)
	assert.equal(suiteOf(r.json, 'ctl-passing').verdict, 'pass')
	assert.equal(r.json.codeGate.totals.pass, 1)
})

// ─────────────────────────────────────────────────────────────────────────────
// 控制 1:失败的套件必须**保持**失败 —— JSON 里是 fail,进程退出码非零。
// ─────────────────────────────────────────────────────────────────────────────
test('NC1: 失败的套件在 JSON 和退出码里都保持失败', () => {
	const r = runRunner({ plan: { codeGates: [nodeTestGate('ctl-failing', 'failing')], advisory: [] } })
	assert.notEqual(r.exitCode, 0, '失败的套件绝不能让验收器退出 0')
	assert.equal(r.exitCode, 1)
	const s = suiteOf(r.json, 'ctl-failing')
	assert.equal(s.verdict, 'fail')
	assert.equal(s.exitCode, 1, '生产者的真实退出码必须原样保留')
	assert.equal(r.json.codeGate.green, false)
	assert.equal(r.json.codeGate.totals.fail, 1, '失败数必须真实计入')
	assert.ok(r.json.codeGate.failedGates.some((g) => g.id === 'ctl-failing'))
	// 同一次运行里有 1 个通过 1 个失败:通过的那个不许把失败洗白
	assert.equal(r.json.codeGate.totals.pass, 1)
})

// ─────────────────────────────────────────────────────────────────────────────
// 控制 2:报了 0 个测试的套件绝不算通过(哪怕退出码是 0)。
// ─────────────────────────────────────────────────────────────────────────────
test('NC2: 0 个测试 + 退出 0 → verdict empty,不算通过,闸变红', () => {
	const r = runRunner({
		plan: { codeGates: [{ id: 'ctl-zero', cwd: FIXTURES, argv: ['./zero-tests-producer.sh'], kind: 'node-test', required: true }], advisory: [] },
	})
	const s = suiteOf(r.json, 'ctl-zero')
	assert.equal(s.exitCode, 0, '生产者确实退出 0(这正是陷阱所在)')
	assert.equal(s.verdict, 'empty', '0 测试必须判 empty')
	assert.notEqual(s.verdict, 'pass')
	assert.equal(r.json.codeGate.green, false, '0 测试绝不能让闸变绿')
	assert.notEqual(r.exitCode, 0, '0 测试必须让进程退出非零')
	assert.equal(r.json.codeGate.totals.pass, 0)
})

// 纯逻辑再钉一遍(不依赖固件能不能造出 tests 0)
test('NC2b: verdictOf 对 counts.tests=0 直接判 empty', () => {
	const v = verdictOf({ exitCode: 0, counts: { tests: 0, suites: 0, pass: 0, fail: 0, cancelled: 0, skipped: 0, todo: 0 } })
	assert.equal(v.verdict, 'empty')
	// 压根没有摘要(测试进程崩在加载阶段)也不许算过
	assert.equal(verdictOf({ exitCode: 0, counts: null }).verdict, 'fail')
	assert.equal(parseNodeTestCounts('random output with no summary'), null)
})

// ─────────────────────────────────────────────────────────────────────────────
// 控制 3:部署漂移退出 1 不能把代码闸弄红;反向,漂移全绿也救不了红的代码闸。
// ─────────────────────────────────────────────────────────────────────────────
test('NC3a: 漂移退出 1 + 代码闸全过 → 进程退出 0,漂移真实退出码仍在 JSON 里(没被吞)', () => {
	const r = runRunner({
		plan: {
			codeGates: [nodeTestGate('ctl-passing', 'passing')],
			advisory: [{ id: 'ctl-drift', cwd: FIXTURES, argv: ['./drift-stub.sh'], kind: 'drift', note: 'synthetic drift' }],
		},
	})
	assert.equal(r.exitCode, 0, '漂移非零绝不能让代码闸失败')
	assert.equal(r.json.codeGate.green, true)
	const adv = r.json.advisory.results.find((a) => a.id === 'ctl-drift')
	assert.ok(adv, '漂移结果必须在 JSON 里(不许静默丢弃)')
	assert.equal(adv.exitCode, 1, '漂移的真实退出码 1 必须原样保留')
	assert.equal(adv.channel, 'advisory')
	assert.equal(adv.verdict, 'fail', '漂移自身的判定仍是 fail,只是不参与退出码')
	// 漂移不许混进代码闸的套件列表
	assert.equal(r.json.codeGate.suites.some((s) => s.id === 'ctl-drift'), false)
	assert.ok(/ADVISORY/.test(r.stdout), '终端摘要必须显式标出 ADVISORY,不能悄悄不提')
})

test('NC3b: 漂移零漂移(退出 0)救不了失败的代码闸', () => {
	const r = runRunner({
		plan: {
			codeGates: [nodeTestGate('ctl-failing', 'failing')],
			advisory: [{ id: 'ctl-drift-clean', cwd: FIXTURES, argv: ['./drift-stub-clean.sh'], kind: 'drift' }],
		},
	})
	assert.notEqual(r.exitCode, 0, 'advisory 全绿不许把红闸洗成绿')
	assert.equal(r.json.codeGate.green, false)
	assert.equal(r.json.advisory.results.find((a) => a.id === 'ctl-drift-clean').exitCode, 0)
})

// ─────────────────────────────────────────────────────────────────────────────
// 控制 4:缺必需宿主包 → 带诊断的非零失败,绝不是 skip-as-pass。
// ─────────────────────────────────────────────────────────────────────────────
test('NC4: 缺必需宿主包 → verdict fail + missing-host-modules 诊断,不是 skip、不是 pass', () => {
	const fakeSurface = {
		schema: 'agos-acceptance/dependency-surface@1',
		generatedAt: new Date().toISOString(),
		// 指纹必须是当前的:本条测的是「缺包 → 失败」,不是「陈旧 → 降级」。
		// 少了它,产物会被判陈旧、预检不再拦人,这条就测不到自己要测的东西了(NC20g 专管那条路)。
		inputsDigest: surfaceInputsDigest(REPO_ROOT),
		summary: {
			externalToSuites: { '@agos-selftest/definitely-not-a-real-package': ['dsh-agos/agent-kernel.test.mjs'] },
			suitesRequiringHostPaths: [],
		},
	}
	const r = runRunner({
		plan: { codeGates: [{ id: 'dsh-agos', cwd: 'plugins/dsh-agos', argv: ['node', '--test', 'test/agent-kernel.test.mjs'], kind: 'node-test', required: true }], advisory: [] },
		surface: fakeSurface,
	})
	const s = suiteOf(r.json, 'dsh-agos')
	assert.equal(s.verdict, 'fail', '缺包必须是失败')
	assert.notEqual(s.verdict, 'skipped', '绝不能降级成跳过')
	assert.notEqual(s.verdict, 'pass')
	assert.match(s.reason, /missing-host-modules/, '必须指名道姓说缺什么')
	assert.ok(s.missingModules.includes('@agos-selftest/definitely-not-a-real-package'), '诊断必须点出具体包名')
	assert.notEqual(s.exitCode, 0)
	assert.notEqual(r.exitCode, 0, '缺包必须让进程退出非零')
	assert.equal(r.json.codeGate.green, false)
})

// ─────────────────────────────────────────────────────────────────────────────
// 控制 5:skip 必须报成 skip,永不并入 pass。
// ─────────────────────────────────────────────────────────────────────────────
test('NC5a: 全 skip 的套件 → verdict skipped,pass 计数为 0,闸不绿', () => {
	const r = runRunner({ plan: { codeGates: [nodeTestGate('ctl-skipped', 'skipped')], advisory: [] } })
	const s = suiteOf(r.json, 'ctl-skipped')
	assert.equal(s.exitCode, 0, 'node --test 对全 skip 是退出 0(陷阱所在)')
	assert.equal(s.verdict, 'skipped')
	assert.notEqual(s.verdict, 'pass')
	assert.equal(r.json.codeGate.totals.skipped, 2, 'skip 必须如实计入 skip 列')
	assert.equal(r.json.codeGate.totals.pass, 0, 'skip 绝不能并入 pass')
	assert.equal(r.json.codeGate.green, false, '一条都没真过的套件不算绿')
})

test('NC5b: pass+skip 混合 → 两个数各归各位,skip 不加进 pass', () => {
	const r = runRunner({ plan: { codeGates: [nodeTestGate('ctl-mixed', 'mixed')], advisory: [] } })
	const s = suiteOf(r.json, 'ctl-mixed')
	assert.equal(s.verdict, 'pass')
	assert.equal(s.counts.pass, 2)
	assert.equal(s.counts.skipped, 1)
	assert.equal(r.json.codeGate.totals.pass, 2, 'pass 就是 2,不是 3')
	assert.equal(r.json.codeGate.totals.skipped, 1)
	assert.equal(r.json.codeGate.totals.pass + r.json.codeGate.totals.skipped, s.counts.tests)
})

// ─────────────────────────────────────────────────────────────────────────────
// 控制 6:计数下限闸 —— 删测试/清空测试文件弄不绿。
// (这条是真威胁:Node v26 把"没注册任何测试的文件"算成 1 个**通过**的测试。)
// ─────────────────────────────────────────────────────────────────────────────
test('NC6: 测试数低于基线下限 → fail(删测试骗不过闸)', () => {
	const r = runRunner({
		plan: { codeGates: [nodeTestGate('ctl-passing', 'passing', { minTests: 50, minPass: 50 })], advisory: [] },
	})
	const s = suiteOf(r.json, 'ctl-passing')
	assert.equal(s.verdict, 'fail')
	assert.match(s.reason, /count-regression/)
	assert.notEqual(r.exitCode, 0)
})

test('NC6b: 被清空的测试文件本身会被 node 算成 1 个通过 —— 只有下限闸抓得到', () => {
	// 先记录这个 Node 行为(它就是为什么必须有下限闸)
	const bare = runRunner({ plan: { codeGates: [nodeTestGate('ctl-zero-file', 'zero')], advisory: [] } })
	const s1 = suiteOf(bare.json, 'ctl-zero-file')
	assert.equal(s1.counts.tests, 1, 'Node 把空测试文件算成 1 个测试')
	assert.equal(s1.counts.pass, 1, '而且算成通过 —— 光看 pass>0 抓不到')
	assert.equal(s1.verdict, 'pass', '没有下限时确实会判过(这是记录下来的局限,不是主张)')
	// 加上下限就抓到了
	const guarded = runRunner({ plan: { codeGates: [nodeTestGate('ctl-zero-file', 'zero', { minTests: 5, minPass: 5 })], advisory: [] } })
	assert.equal(suiteOf(guarded.json, 'ctl-zero-file').verdict, 'fail')
	assert.notEqual(guarded.exitCode, 0)
})

// ─────────────────────────────────────────────────────────────────────────────
// 控制 7:默认环境不读私有语料、不带供应商密钥。
// ─────────────────────────────────────────────────────────────────────────────
test('NC7: 默认把语料目录指到一个不存在的临时路径,并剔除供应商密钥', () => {
	const r = runRunner({ plan: { codeGates: [nodeTestGate('ctl-passing', 'passing')], advisory: [] } })
	assert.equal(r.json.environment.corpusDirExists, false, '语料目录必须是不存在的路径')
	assert.match(r.json.environment.corpusDir, /agos-acceptance-absent-corpus/)
	for (const k of ['Z_AI_API_KEY', 'GLM_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY']) {
		assert.ok(r.json.environment.providerKeysCleared.includes(k), `${k} 必须被剔除`)
	}
})

// ─────────────────────────────────────────────────────────────────────────────
// 控制 8:朴素的 `cmd | grep` 会把非零退出码吃掉 —— 这就是为什么闸不能那样写。
// ─────────────────────────────────────────────────────────────────────────────
test('NC8: 朴素 pipe+grep 会把失败洗成 0;验收器不这么干', () => {
	const dir = join(REPO_ROOT, FIXTURES, 'failing')
	// 这两条都要在**干净环境**里跑:本自检自己跑在 node --test 里,
	// NODE_TEST_CONTEXT 若传下去,子进程的 node --test 会一个文件都不跑就退出 0。
	const clean = { ...process.env }
	delete clean.NODE_TEST_CONTEXT
	delete clean.NODE_OPTIONS
	const sh = (cmd) => spawnSync('/bin/sh', ['-c', cmd], { cwd: dir, encoding: 'utf8', timeout: 120000, env: clean })
	const naive = sh('node --test test/*.mjs 2>&1 | cat >/dev/null')
	assert.equal(naive.status, 0, '记录事实:管道后的退出码是最后一环的,生产者的失败被吃掉了')
	const honest = sh('node --test test/*.mjs >/dev/null 2>&1')
	assert.equal(honest.status, 1, '生产者本身是失败的')
	// 而验收器保留的是生产者的码
	const r = runRunner({ plan: { codeGates: [nodeTestGate('ctl-failing', 'failing')], advisory: [] } })
	assert.equal(suiteOf(r.json, 'ctl-failing').exitCode, 1)
})

// ─────────────────────────────────────────────────────────────────────────────
// 控制 9:--write-floors 不许从红的运行固化基线。
// ─────────────────────────────────────────────────────────────────────────────
test('NC9: --write-floors 拒绝把红状态写成基线', () => {
	const work = mkdtempSync(join(tmpdir(), 'agos-selftest-floors-'))
	const target = join(work, 'floors.json')
	const r = runRunner({
		plan: { codeGates: [nodeTestGate('ctl-failing', 'failing')], advisory: [] },
		extraArgs: [`--write-floors=${target}`],
	})
	assert.notEqual(r.exitCode, 0)
	assert.equal(existsSync(target), false, '红的运行绝不能写出基线文件')
	assert.match(r.stderr + r.stdout, /拒绝执行|refus/i)
})

// ─────────────────────────────────────────────────────────────────────────────
// 控制 10:计数下限基线本身不可用 → **拒绝运行**(退 78),绝不静默变成"没有下限"。
//
// 这一组是上面 runRunner 合成基线的**对照面**:合成基线让 13 条负控恢复可达,
// 而"缺基线必须 fail-closed"这条生产行为在这里被单独钉死。两者不许互相取消。
// 覆盖:文件不存在 / 空文件 / 坏 JSON / 缺 floors 字段 / 空 floors / 下限值为 0。
// ─────────────────────────────────────────────────────────────────────────────
const okPlan = () => ({ codeGates: [nodeTestGate('ctl-passing', 'passing')], advisory: [] })

/** 每条都断言:退 78、stderr 有 fail-closed 文案与 reason code、且**没有**落盘 JSON(压根没跑)。 */
function assertFloorsRefused(r, reasonCode) {
	assert.equal(r.exitCode, 78, `基线不可用必须退 78,实际 ${r.exitCode}`)
	assert.match(r.stderr, /拒绝运行\(fail-closed\)/, '必须打印 fail-closed 文案')
	assert.match(r.stderr, new RegExp(reasonCode), `必须给出 reason code ${reasonCode}`)
	assert.equal(r.json, null, '拒绝运行意味着一个闸都没跑,不该有结果 JSON')
}

test('NC10: 基线文件不存在 → 退 78 fail-closed(生产路径绝不静默通过)', () => {
	const r = runRunner({ plan: okPlan(), floorsMissing: true })
	assertFloorsRefused(r, 'floors-missing-file')
	// 反面对照:同一个计划配上真实合成基线时是能过的 —— 证明 78 是基线缺席造成的,不是计划本身坏
	assert.equal(runRunner({ plan: okPlan() }).exitCode, 0, '同一计划配真实基线必须能过')
})

test('NC10b: 基线文件是空的 → 退 78(以前会 JSON.parse 抛未捕获异常)', () => {
	assertFloorsRefused(runRunner({ plan: okPlan(), floorsRaw: '' }), 'floors-empty-file')
	assertFloorsRefused(runRunner({ plan: okPlan(), floorsRaw: '   \n\t\n' }), 'floors-empty-file')
})

test('NC10c: 基线 JSON 格式错误 → 退 78 带解析诊断', () => {
	assertFloorsRefused(runRunner({ plan: okPlan(), floorsRaw: '{"floors": {' }), 'floors-invalid-json')
})

test('NC10d: 基线缺 floors 字段 → 退 78(以前 `?? {}` 静默变成没有任何下限)', () => {
	assertFloorsRefused(runRunner({ plan: okPlan(), floorsRaw: '{"schema":"x"}' }), 'floors-missing-field')
	assertFloorsRefused(runRunner({ plan: okPlan(), floorsRaw: '{"floors": []}' }), 'floors-missing-field')
	assertFloorsRefused(runRunner({ plan: okPlan(), floorsRaw: '[]' }), 'floors-not-an-object')
})

test('NC10e: floors 是空对象 / 下限值为 0 或非整数 → 退 78(都与"没有下限"等价)', () => {
	assertFloorsRefused(runRunner({ plan: okPlan(), floorsRaw: '{"floors":{}}' }), 'floors-empty-object')
	assertFloorsRefused(runRunner({ plan: okPlan(), floorsRaw: '{"floors":{"a":{"minTests":0,"minPass":0}}}' }), 'floors-invalid-entry')
	assertFloorsRefused(runRunner({ plan: okPlan(), floorsRaw: '{"floors":{"a":{"minTests":"7","minPass":7}}}' }), 'floors-invalid-entry')
	assertFloorsRefused(runRunner({ plan: okPlan(), floorsRaw: '{"floors":{"a":{"minPass":7}}}' }), 'floors-invalid-entry')
	assertFloorsRefused(runRunner({ plan: okPlan(), floorsRaw: '{"floors":{"a":null}}' }), 'floors-invalid-entry')
})

test('NC10f: --floors=none 是显式逃生阀 —— 能跑,但"不设下限"这个事实必须醒目', () => {
	const r = runRunner({ plan: okPlan(), floorsDisabled: true })
	assert.equal(r.exitCode, 0, '显式关闭下限时允许运行(首次引导基线需要)')
	assert.match(r.stdout, /已用 --floors=none 显式关闭/, '必须在终端醒目声明本次不设下限')
})

// ─────────────────────────────────────────────────────────────────────────────
// 控制 11:必需套件**整包缺失/空目录**必须让正式门失败。
//
// ⚠️ 这是外部核查者 Luna 实测出来的假绿:defaultPlan 原来对「test/ 目录不存在」和
// 「目录里没有 .mjs」都是 `continue` —— 整个套件消失变成"计划里没这一项",于是闸没有
// 任何东西可抓。Luna 在临时副本上实测:全部插件 test/ 不存在时 tests=0 / green=true / exit 0。
//
// 这一组走验收器**真实的 defaultPlan**(--plugins-root 指向合成套件树),
// 不用自定义 --plan —— 自定义计划压根不经过 defaultPlan,证明不了它的行为。
// ─────────────────────────────────────────────────────────────────────────────
test('NC11: 必需插件的 test/ 整个不存在 → 计划里必须留下显式失败条目,闸退非零', () => {
	const root = makePluginRoot({ 'plug-ok': 'passing', 'plug-gone': 'no-test-dir' })
	const r = runRunner({ requiredPlugins: ['plug-ok', 'plug-gone'], pluginsRoot: root })
	assert.notEqual(r.exitCode, 0, '必需套件缺失必须让进程退非零')
	assert.equal(r.json.codeGate.green, false)
	const gone = suiteOf(r.json, 'plug-gone')
	assert.ok(gone, '缺失的必需套件绝不能从计划/结果里消失 —— 消失了就没东西可抓')
	assert.equal(gone.verdict, 'fail')
	assert.equal(gone.structural, true)
	assert.match(gone.reason, /missing-test-suite/)
	assert.ok(r.json.codeGate.failedGates.some((g) => g.id === 'plug-gone'))
	// 同一次运行里健在的那个套件确实过了 → 证明这条红不是"什么都红"的假象
	assert.equal(suiteOf(r.json, 'plug-ok').verdict, 'pass')
})

test('NC11b: test/ 存在但为空 / 有文件却没有 .mjs → 同样是显式失败', () => {
	for (const kind of ['empty-test-dir', 'no-mjs']) {
		const root = makePluginRoot({ 'plug-ok': 'passing', 'plug-empty': kind })
		const r = runRunner({ requiredPlugins: ['plug-ok', 'plug-empty'], pluginsRoot: root })
		assert.notEqual(r.exitCode, 0, `${kind}:必须退非零`)
		const s = suiteOf(r.json, 'plug-empty')
		assert.ok(s, `${kind}:空套件不能从结果里消失`)
		assert.equal(s.verdict, 'fail')
		assert.match(s.reason, /empty-test-suite/)
		assert.equal(r.json.codeGate.green, false)
	}
})

test('NC11c: Luna 的原始复现 —— **全部**必需套件都不存在,绝不能 tests=0/green=true/exit 0', () => {
	const root = makePluginRoot({})   // 一个套件目录都没有
	const required = ['dsh-agos', 'dsh-agos-router', 'dsh-mcp-bridge', 'cn-capabilities', 'dsh-fleet']
	const r = runRunner({ requiredPlugins: required, pluginsRoot: root })
	assert.notEqual(r.exitCode, 0, '整包全缺时退 0 就是假绿 —— 这正是被抓到的缺陷')
	assert.equal(r.json.codeGate.green, false, 'green 绝不能是 true')
	assert.equal(r.json.codeGate.totals.tests, 0, '确实一个测试都没跑(陷阱所在)')
	assert.equal(r.json.codeGate.suites.length, required.length, '五个必需套件都得留下条目')
	for (const id of required) {
		assert.equal(suiteOf(r.json, id).verdict, 'fail', `${id} 必须是显式失败`)
	}
	assert.equal(r.json.codeGate.failedGates.length, required.length)
})

// ─────────────────────────────────────────────────────────────────────────────
// 控制 12:基线里**缺某个必需套件的条目** → 那个套件没有下限保护,必须判失败。
// (比删掉整个基线文件隐蔽得多:文件在、格式对、只是少一行。)
// ─────────────────────────────────────────────────────────────────────────────
test('NC12: 基线缺某必需套件的条目 → 该套件显式失败,闸退非零', () => {
	const root = makePluginRoot({ 'plug-a': 'passing', 'plug-b': 'passing' })
	const r = runRunner({
		requiredPlugins: ['plug-a', 'plug-b'],
		pluginsRoot: root,
		floors: { schema: 'agos-acceptance/expected-counts@1', floors: { 'plug-a': { minTests: 1, minPass: 1 } } },
	})
	assert.notEqual(r.exitCode, 0)
	const b = suiteOf(r.json, 'plug-b')
	assert.ok(b, '没有下限的必需套件不能从结果里消失')
	assert.equal(b.verdict, 'fail')
	assert.match(b.reason, /missing-floor-entry/)
	assert.equal(suiteOf(r.json, 'plug-a').verdict, 'pass', '有条目的那个照常跑')
})

// ─────────────────────────────────────────────────────────────────────────────
// 控制 13/14:默认计划下,全 skip 与计数低于下限同样必须红。
// (NC5a/NC6 已经用自定义 --plan 证过判定层;这两条证明**默认计划真的把下限接上了**。)
// ─────────────────────────────────────────────────────────────────────────────
test('NC13: 默认计划下某必需套件全 skip(tests>0、pass=0)→ 闸退非零', () => {
	const root = makePluginRoot({ 'plug-skip': 'skipped' })
	const r = runRunner({ requiredPlugins: ['plug-skip'], pluginsRoot: root })
	const s = suiteOf(r.json, 'plug-skip')
	assert.equal(s.exitCode, 0, 'node --test 对全 skip 是退 0(陷阱所在)')
	assert.ok(s.counts.tests > 0, '确实有测试')
	assert.equal(s.counts.pass, 0, '但一条都没真过')
	assert.equal(s.verdict, 'skipped')
	assert.equal(r.json.codeGate.totals.pass, 0, 'skip 绝不能并入 pass')
	assert.notEqual(r.exitCode, 0)
	assert.equal(r.json.codeGate.green, false)
})

test('NC14: 默认计划下测试计数低于基线下限 → 闸退非零(证明 defaultPlan 真的接了下限)', () => {
	const root = makePluginRoot({ 'plug-shrunk': 'passing' })   // 固件只有 1 个测试
	const r = runRunner({
		requiredPlugins: ['plug-shrunk'],
		pluginsRoot: root,
		floors: { schema: 'agos-acceptance/expected-counts@1', floors: { 'plug-shrunk': { minTests: 42, minPass: 42 } } },
	})
	const s = suiteOf(r.json, 'plug-shrunk')
	assert.equal(s.minTests ?? 42, 42)
	assert.equal(s.verdict, 'fail')
	assert.match(s.reason, /count-regression/)
	assert.notEqual(r.exitCode, 0)
})

// ─────────────────────────────────────────────────────────────────────────────
// 控制 15:「让计划变空」是最省事的假绿手段 —— 必须拒绝运行。
// ─────────────────────────────────────────────────────────────────────────────
test('NC15: 0 个代码闸的计划 → 退 78 拒绝运行(不是"全过")', () => {
	const r = runRunner({ plan: { codeGates: [], advisory: [] } })
	assert.equal(r.exitCode, 78)
	assert.match(r.stderr, /empty-code-gates/)
	assert.equal(r.json, null)
})

test('NC15b: 必需套件清单被清空(--required-plugins=)→ 退 78 拒绝运行', () => {
	const r = runRunner({ requiredPlugins: [], pluginsRoot: makePluginRoot({}) })
	assert.equal(r.exitCode, 78)
	assert.match(r.stderr, /empty-required-plugins/)
})

// ─────────────────────────────────────────────────────────────────────────────
// 控制 16:正式门接了自检,并且防递归真的挡住了递归。
//
// 「计划里没有 selftest 这一项」证明不了递归会不会发生,所以这里用真实分层 spawn 数层数:
// 探针(见 selftest-fixtures/recursion-probe.test.mjs)每层记一行深度,自身带硬上限 3。
// ─────────────────────────────────────────────────────────────────────────────
const PROBE = join(REPO_ROOT, FIXTURES, 'recursion-probe.test.mjs')

/** 直接起第 1 层探针(不经过验收器),让探针自己决定 spawn 验收器时带不带哨兵。 */
function runRecursionProbe({ sentinel }) {
	const work = mkdtempSync(join(tmpdir(), 'agos-selftest-recursion-'))
	const logFile = join(work, 'depths.txt')
	writeFileSync(logFile, '')
	const root = makePluginRoot({ 'probe-plug': 'passing' })
	const floorsFile = join(work, 'floors.json')
	writeFileSync(floorsFile, JSON.stringify({
		schema: 'agos-acceptance/expected-counts@1',
		floors: { 'probe-plug': { minTests: 1, minPass: 1 }, selftest: { minTests: 1, minPass: 1 } },
	}, null, 2))
	// 探针每层用这套参数去跑验收器:默认计划(所以会走"要不要放自检进计划"那段) + 合成套件树
	const runnerArgv = [
		'--no-advisory',
		`--surface=${join(work, 'no-such-surface.json')}`,
		`--floors=${floorsFile}`,
		'--required-plugins=probe-plug',
		`--plugins-root=${root}`,
		`--selftest-file=${PROBE}`,
		`--logdir=${join(work, 'logs')}`,
	]
	const env = {
		...process.env,
		AGOS_RECURSION_PROBE_LOG: logFile,
		AGOS_RECURSION_PROBE_MAX: '3',
		AGOS_RECURSION_PROBE_SENTINEL: sentinel ? '1' : '0',
		AGOS_RECURSION_PROBE_RUNNER: RUNNER,
		AGOS_RECURSION_PROBE_ARGV: JSON.stringify(runnerArgv),
		AGOS_RECURSION_PROBE_CWD: REPO_ROOT,
		AGOS_RECURSION_PROBE_DEPTH: '0',
	}
	delete env.NODE_TEST_CONTEXT
	delete env.NODE_OPTIONS
	delete env[SELFTEST_SENTINEL]   // 第 1 层探针是"自检"的角色,它自己不该带哨兵
	const res = spawnSync(process.execPath, ['--test', PROBE], { cwd: REPO_ROOT, encoding: 'utf8', timeout: 300000, env })
	const depths = readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean)
	return { depths, exitCode: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' }
}

test('NC16: 哨兵缺失时**真的会递归**(实测层数增长)', () => {
	const r = runRecursionProbe({ sentinel: false })
	assert.ok(r.depths.length >= 3,
		`不带哨兵时验收器会把自检放回计划 → 层层相套。实测层数 ${r.depths.length},期望 ≥3(探针硬上限)。实际记录: ${r.depths.join(',')}`)
	assert.deepEqual(r.depths.slice(0, 3), ['depth=1', 'depth=2', 'depth=3'], '层数必须是逐层递增的真实嵌套')
})

test('NC16b: 哨兵存在时递归停在第 1 层,且"自检被排除"这件事不静默', () => {
	const r = runRecursionProbe({ sentinel: true })
	assert.deepEqual(r.depths, ['depth=1'], `带哨兵时必须停在第 1 层,实际: ${r.depths.join(',')}`)
	// 排除不许静默:JSON 与终端都得留痕
	const j = runRunner({ requiredPlugins: ['plug-ok'], pluginsRoot: makePluginRoot({ 'plug-ok': 'passing' }) })
	assert.equal(j.json.recursionGuard.active, true, '子验收器必须承认哨兵生效了')
	assert.equal(j.json.recursionGuard.selftestGateIncluded, false, '哨兵在时自检不该在计划里')
	assert.equal(j.json.recursionGuard.sentinel, SELFTEST_SENTINEL)
	assert.match(j.stdout, /防递归哨兵/, '终端必须说明自检为什么被排除')
})

test('NC16c: 正式默认计划确实接了自检 + 依赖树校验(--print-plan 实测,且它自己退 78)', () => {
	// --print-plan 一个闸都没跑,所以它**必须**退非零:任何 `--print-plan && echo 通过` 都要失败
	const res = spawnSync(process.execPath, [RUNNER, '--print-plan', '--no-advisory'], {
		cwd: REPO_ROOT, encoding: 'utf8', timeout: 120000,
		env: runnerEnv({ [SELFTEST_SENTINEL]: undefined }),   // 哨兵不在 → 自检应当在计划里
	})
	assert.equal(res.status, 78, '--print-plan 绝不能退 0(否则会被当成通过)')
	const printed = JSON.parse(res.stdout)
	assert.equal(printed.syntheticSeams, false, '这一条问的是**真实**默认计划,不能有任何合成接缝')
	const plan = printed.plan
	const ids = plan.codeGates.map((g) => g.id)
	for (const id of ['dsh-agos', 'dsh-agos-router', 'dsh-mcp-bridge', 'cn-capabilities', 'dsh-fleet']) {
		assert.ok(ids.includes(id), `正式门必须含必需套件 ${id}`)
	}
	assert.ok(ids.includes('selftest'), '正式门必须接自检(缺陷 3)')
	assert.ok(ids.includes('host-tree'), '正式门必须接宿主依赖树内容校验')
	assert.ok(ids.includes('host-modules-check'), '正式门必须接宿主依赖体检')
	const selftestGate = plan.codeGates.find((g) => g.id === 'selftest')
	assert.equal(selftestGate.required, true, '自检必须是必需闸,不是可选')
	// 自检闸也必须有计数下限:否则"删掉几条负控"不会被抓到
	assert.ok(selftestGate.kind !== 'structural', `自检闸不该是结构性失败(现在是 ${selftestGate.reason ?? ''})`)
	assert.ok(Number.isInteger(selftestGate.minTests) && selftestGate.minTests >= 1, '自检闸必须有 minTests 下限')
	assert.ok(Number.isInteger(selftestGate.minPass) && selftestGate.minPass >= 1, '自检闸必须有 minPass 下限')
})

// ─────────────────────────────────────────────────────────────────────────────
// 控制 17:嵌套 node --test 的环境传播 —— 最危险的假绿。
//
// NODE_TEST_CONTEXT 传给子进程时,子进程的 `node --test` 会打印
// "run() is being called recursively ... skipping running files",**一个文件都不跑、
// 连摘要都不打、退出码 0**(v26.7.0 实测)。本自检自己就跑在 node --test 里,
// 而它 spawn 的验收器又要 spawn node --test,所以这条链必须在每一跳被斩断。
// ─────────────────────────────────────────────────────────────────────────────
test('NC17: 自检 spawn 验收器时已清掉 NODE_TEST_CONTEXT/NODE_OPTIONS', () => {
	const r = runRunner({ plan: okPlan() })
	assert.equal(r.json.environment.nodeTestContext, null,
		'验收器进程不该带着 node --test 的上下文(自检自己就跑在 node --test 里)')
	assert.equal(r.json.environment.nodeOptions, null)
	assert.equal(r.exitCode, 0)
})

test('NC17b: 就算污染硬塞给验收器,它也必须为孙子进程斩断(闸照常跑出真实计数)', () => {
	const r = runRunner({
		plan: { codeGates: [nodeTestGate('ctl-env', 'env-hygiene')], advisory: [] },
		env: { NODE_TEST_CONTEXT: 'child-v8', NODE_OPTIONS: '--no-warnings' },
	})
	assert.equal(r.json.environment.nodeTestContext, 'child-v8', '收到了什么就如实记什么')
	assert.equal(r.json.environment.nodeOptions, '--no-warnings')
	const s = suiteOf(r.json, 'ctl-env')
	assert.equal(s.verdict, 'pass', '污染必须在验收器这一跳被斩断,否则子进程一个测试都不跑')
	assert.equal(s.counts.tests, 3, '固件里的三条测试必须真的跑了')
	assert.equal(s.counts.pass, 3)
	assert.equal(r.exitCode, 0)
})

// ─────────────────────────────────────────────────────────────────────────────
// 控制 19:可测性接缝本身不许变成绕过通道。
// (为了让结构性负控能走真实的 defaultPlan,验收器加了 --required-plugins/--plugins-root/
//  --selftest-file/--surface。这些开关必须:① 把本次运行标成不权威;② 不能用来写基线。)
// ─────────────────────────────────────────────────────────────────────────────
test('NC19: 用了合成接缝的运行必须自报 authoritative=false', () => {
	const r = runRunner({ requiredPlugins: ['plug-ok'], pluginsRoot: makePluginRoot({ 'plug-ok': 'passing' }) })
	assert.equal(r.exitCode, 0, '合成运行本身是能过的(否则下面这条断言没意义)')
	assert.equal(r.json.authoritative, false, '合成运行绝不能自称权威')
	assert.ok(r.json.syntheticSeams, '用了哪些接缝必须落到 JSON 里')
	assert.match(r.stdout, /合成运行/, '终端也必须说明这不是真实仓库状态')
})

test('NC19b: --write-floors 拒绝从合成运行写基线(否则假套件树能洗掉真基线)', () => {
	const work = mkdtempSync(join(tmpdir(), 'agos-selftest-synthfloors-'))
	const target = join(work, 'floors.json')
	const r = runRunner({
		requiredPlugins: ['plug-ok'], pluginsRoot: makePluginRoot({ 'plug-ok': 'passing' }),
		extraArgs: [`--write-floors=${target}`],
	})
	assert.equal(r.exitCode, 78, '合成运行想写基线必须被拒')
	assert.equal(existsSync(target), false, '一个字节都不许写出去')
	assert.match(r.stderr, /拒绝执行/)
})

test('NC19c: 裸 --write-floors(无 =路径)必须立刻退 78,不许被静默忽略', () => {
	// 起因是实操事故,不是想象:opt() 只认 `--name=value`,裸标志落回 null,
	// 写基线那段直接不执行且**输出与没加时逐字相同**。2026-09-09 主控据此
	// 以为下限已随新增测试上调,实际文件一字未动 —— 过期下限不会让门变红,
	// 只会让它不再拦人,这正是本轮在追的假绿。
	const r = spawnSync(process.execPath, [RUNNER, '--write-floors'], {
		cwd: REPO_ROOT, encoding: 'utf8', env: runnerEnv(), timeout: 60_000,
	})
	assert.equal(r.status, 78, `裸标志必须退 78,实际 ${r.status}`)
	assert.match(r.stderr, /需要显式路径/, '必须说清正确写法')
	// 必须在跑任何套件**之前**就拒:否则会先打完"退出码 = 0"再补一句报错,
	// 读者容易只看见前一句 —— 那和静默忽略的危害是同一种。
	assert.ok(!/PASS|FAIL|代码闸/.test(r.stdout),
		`应在执行任何闸之前退出,实际 stdout 里已有闸结果:${r.stdout.slice(0, 200)}`)
})

test('NC19e: --write-floors= 空路径必须和裸标志一样早退 78', () => {
	const r = spawnSync(process.execPath, [RUNNER, '--write-floors='], {
		cwd: REPO_ROOT, encoding: 'utf8', env: runnerEnv(), timeout: 60_000,
	})
	assert.equal(r.status, 78, `空路径必须退 78,实际 ${r.status}`)
	assert.match(r.stderr, /需要显式路径/)
	assert.ok(!/PASS|FAIL|代码闸/.test(r.stdout), '空路径应在执行任何闸之前拒绝')
})

test('NC19d: 自定义 --plan 也必须标成不权威且不能写正式基线', () => {
	const work = mkdtempSync(join(tmpdir(), 'agos-selftest-planfloors-'))
	const planPath = join(work, 'plan.json')
	writeFileSync(planPath, JSON.stringify({ codeGates: [nodeTestGate('ctl-passing', 'passing')], advisory: [] }))
	const target = join(work, 'floors.json')
	const jsonPath = join(work, 'probe.json')
	const isolatedEnv = { ...process.env }
	delete isolatedEnv[SELFTEST_SENTINEL]
	delete isolatedEnv.NODE_TEST_CONTEXT
	delete isolatedEnv.NODE_OPTIONS
	const probe = spawnSync(process.execPath, [RUNNER, `--plan=${planPath}`, '--floors=none', '--no-advisory', `--json=${jsonPath}`, `--logdir=${join(work, 'probe-logs')}`], {
		cwd: REPO_ROOT, encoding: 'utf8', env: isolatedEnv, timeout: 60_000,
	})
	assert.equal(probe.status, 0)
	assert.equal(JSON.parse(readFileSync(jsonPath, 'utf8')).authoritative, false, '绕过 defaultPlan 的自定义计划绝不能自称权威')

	const r = runRunner({
		plan: { codeGates: [nodeTestGate('ctl-passing', 'passing')], advisory: [] },
		extraArgs: [`--write-floors=${target}`],
	})
	assert.equal(r.exitCode, 78, '自定义计划即使全绿也不能写正式基线')
	assert.equal(existsSync(target), false, '自定义计划不许写出 floors')
	assert.match(r.stderr, /自定义计划/, '拒绝原因必须指出自定义计划')
})

// ─────────────────────────────────────────────────────────────────────────────
// 控制 18:超时必须**看得出来是超时**,不能长得像一次普通断言失败。
// (实测起因:dsh-fleet 跑满 900s 被 SIGTERM 砍掉,node --test 接住信号自己退 1,
//  于是 reason 只写 nonzero-exit:1 —— 判定没错,但诊断把"被砍了"说成了"断言失败"。)
// ─────────────────────────────────────────────────────────────────────────────
test('NC18: 跑满超时的套件 → 判 fail 且诊断点明 timeout,不冒充普通失败', () => {
	const r = runRunner({
		plan: {
			codeGates: [{
				id: 'ctl-timeout', cwd: FIXTURES, argv: ['/bin/sh', '-c', 'sleep 30'],
				kind: 'node-test', required: true, timeoutMs: 700,
			}],
			advisory: [],
		},
	})
	const s = suiteOf(r.json, 'ctl-timeout')
	assert.equal(s.timedOut, true, '跑满超时必须被标出来')
	assert.equal(s.timeoutMs, 700, '本次用的超时值必须留痕(便于发现有人偷偷调高)')
	assert.equal(s.verdict, 'fail', '超时就是失败')
	assert.match(s.reason, /timeout-after:700ms/, '诊断必须说这是超时,而不是 nonzero-exit')
	assert.notEqual(r.exitCode, 0)
	// 反面对照:正常快速套件不许被误标成超时
	const ok = runRunner({ plan: okPlan() })
	assert.equal(suiteOf(ok.json, 'ctl-passing').timedOut, false, '正常套件绝不能被误判成超时')
})

test('NC17c: 污染真的会让 node --test 一个测试都不跑 —— 而验收器判它 fail,不是 pass', () => {
	// 先记录 Node 的行为本身(这就是为什么必须斩断这条链)
	const dir = join(REPO_ROOT, FIXTURES, 'passing')
	const clean = { ...process.env }
	delete clean.NODE_TEST_CONTEXT
	delete clean.NODE_OPTIONS
	const polluted = spawnSync('/bin/sh', ['-c', 'NODE_TEST_CONTEXT=child-v8 node --test test/pass.test.mjs 2>&1'],
		{ cwd: dir, encoding: 'utf8', timeout: 120000, env: clean })
	assert.equal(polluted.status, 0, '记录事实:被污染的 node --test 退出码是 0')
	assert.match(polluted.stdout, /skipping running files/, '它压根不跑文件')
	assert.equal(parseNodeTestCounts(polluted.stdout), null, '连摘要都没有 → 无法解析出计数')
	// 而验收器碰到这种输出必须判 fail(no-test-summary),绝不能因为"退出码 0"就算过
	const r = runRunner({
		plan: { codeGates: [{ id: 'ctl-polluted', cwd: `${FIXTURES}/passing`, argv: ['/bin/sh', '-c', 'NODE_TEST_CONTEXT=child-v8 node --test test/pass.test.mjs'], kind: 'node-test', required: true }], advisory: [] },
	})
	const s = suiteOf(r.json, 'ctl-polluted')
	assert.equal(s.exitCode, 0, '生产者确实退 0(陷阱所在)')
	assert.equal(s.verdict, 'fail')
	assert.match(s.reason, /no-test-summary/)
	assert.notEqual(r.exitCode, 0, '没有摘要绝不能算过')
})

// ─────────────────────────────────────────────────────────────────────────────
// 控制 20:依赖面预检的两个口子。两个都是本轮实测踩出来的,不是设想的。
//
//   a. 预检不认宿主集成清单 → 把「按设计优雅降级、实跑 exit 0」的套件判成缺依赖失败(假红);
//   b. 预检不看产物新旧 → 一份 2026-09-08 测的快照(比 swarm 解耦还早、通篇没有 swarm)
//      让预检报了「无缺失」,描述的是一棵已经不存在的树(假绿)。
//
// 两条的方向相反,所以要分别钉:豁免不能宽到"什么都放行",陈旧不能松到"什么都不管"。
// ─────────────────────────────────────────────────────────────────────────────
const SURFACE_NEEDING = (pkg) => ({
	schema: 'agos-acceptance/dependency-surface@1',
	generatedAt: new Date().toISOString(),
	gitHead: currentRepoHead(),
	// 新鲜 = 输入指纹与当前一致。**不是**「gitHead 与当前 HEAD 一致」——
	// 那种判法在产物被提交后必然永远陈旧,等于把这层预检永久关掉(NC20f 钉这一点)。
	inputsDigest: surfaceInputsDigest(REPO_ROOT),
	summary: { externalToSuites: { [pkg]: ['dsh-agos/agent-kernel.test.mjs'] }, suitesRequiringHostPaths: [] },
})
const ONE_GATE = {
	codeGates: [{ id: 'dsh-agos', cwd: 'plugins/dsh-agos', argv: ['node', '--test', 'test/agent-kernel.test.mjs'], kind: 'node-test', required: true }],
	advisory: [],
}
const MANIFEST_WITH = (specifier) => ({
	schema: 'agos-acceptance/host-integrations@1',
	integrations: [{
		specifier,
		why: '自检合成条目',
		degradation: { file: 'plugins/dsh-agos/lib/swarm-host-integration.mjs', export: 'resolveSwarmModule' },
		consumers: ['plugins/dsh-agos/lib/index.js'],
		degradedBehaviour: '自检合成条目',
	}],
})

test('NC20a: 说明符**不在**清单里 → 解析不到照旧判 missing-host-modules 失败(豁免不是"什么都放行")', () => {
	const pkg = '@agos-selftest/not-a-real-package-nc18'
	const r = runRunner({ plan: ONE_GATE, surface: SURFACE_NEEDING(pkg) })   // 默认注入空清单
	const s = suiteOf(r.json, 'dsh-agos')
	assert.equal(s.verdict, 'fail', '没声明的说明符缺了就必须失败')
	assert.match(s.reason, /missing-host-modules/)
	assert.ok(s.missingModules.includes(pkg), '必须点名具体包')
	assert.notEqual(r.exitCode, 0)
})

test('NC20b: 说明符在清单里声明为宿主集成 → 不判失败,但必须**按名字**出现在输出里(豁免不许是静默的)', () => {
	const pkg = '@agos-selftest/not-a-real-package-nc18'
	const r = runRunner({ plan: ONE_GATE, surface: SURFACE_NEEDING(pkg), hostIntegrations: MANIFEST_WITH(pkg) })
	const s = suiteOf(r.json, 'dsh-agos')
	assert.notEqual(s.verdict, 'fail', '已声明的宿主集成不该把套件判失败')
	assert.ok(!/missing-host-modules/.test(s.reason ?? ''), '不该报缺依赖')
	assert.match(r.stdout, /宿主环境集成/, '豁免这件事必须出现在输出里')
	assert.ok(r.stdout.includes(pkg), `被豁免的说明符必须按名字打出来,实际输出未见 ${pkg}`)
})

test('NC20c: 清单本身坏掉 → 不豁免任何东西(坏清单不得变成万能放行证)', () => {
	const pkg = '@agos-selftest/not-a-real-package-nc18'
	const r = runRunner({ plan: ONE_GATE, surface: SURFACE_NEEDING(pkg), hostIntegrations: '{ 这不是 JSON' })
	const s = suiteOf(r.json, 'dsh-agos')
	assert.equal(s.verdict, 'fail', '清单坏了要更严,不是更松')
	assert.match(s.reason, /missing-host-modules/)
	assert.match(r.stdout, /宿主集成清单不可用/, '清单坏掉这件事必须说出来,不能静默')
})

test('NC20d: 输入指纹对不上(产物测的是另一棵树)→ 降级为参考,不据此判失败,且"未据此判定"必须醒目', () => {
	const pkg = '@agos-selftest/not-a-real-package-nc18'
	const stale = { ...SURFACE_NEEDING(pkg), inputsDigest: 'f'.repeat(64) }
	const r = runRunner({ plan: ONE_GATE, surface: stale })   // 空清单:没有任何豁免
	const s = suiteOf(r.json, 'dsh-agos')
	assert.notEqual(s.verdict, 'fail', '陈旧快照描述的可能是另一棵树,不能据它判失败')
	assert.match(r.stdout, /依赖面产物已陈旧/, '陈旧这件事必须说出来')
	assert.match(r.stdout, /输入指纹 ffffffffffff/, '必须点出是哪个指纹对不上')
	assert.match(r.stdout, /不据此判任何套件失败/, '"这次没据它判定"必须醒目')
	assert.ok(r.stdout.includes(pkg) || /会被判缺依赖的是/.test(r.stdout),
		'陈旧快照下"本来会被判缺依赖的是谁"要留痕,不能一句不提就放过')
	assert.match(r.stdout, /host-modules-check/, '必须指明权威判定在哪一闸,否则等于取消了这层检查')
})

test('NC20e: 输入指纹一致时不降级 —— 上一条的负控,证明降级不是"永远降级"', () => {
	const pkg = '@agos-selftest/not-a-real-package-nc18'
	const r = runRunner({ plan: ONE_GATE, surface: SURFACE_NEEDING(pkg) })
	assert.ok(!/依赖面产物已陈旧/.test(r.stdout), '内容没变就不该被判陈旧')
	assert.equal(suiteOf(r.json, 'dsh-agos').verdict, 'fail', '不降级时缺包照旧是失败')
})

test('NC20f: 判新旧只看内容,不看 gitHead —— 否则产物一被提交就永远陈旧,这层预检等于被永久关掉', () => {
	const pkg = '@agos-selftest/not-a-real-package-nc18'
	// gitHead 指向一个绝不等于当前 HEAD 的值,但内容指纹是对的:必须仍判"新鲜"。
	const committed = { ...SURFACE_NEEDING(pkg), gitHead: '0'.repeat(40) }
	const r = runRunner({ plan: ONE_GATE, surface: committed })
	assert.ok(!/依赖面产物已陈旧/.test(r.stdout),
		'内容一致就该算数;按 gitHead 判会让每次提交后的产物都失效')
	assert.equal(suiteOf(r.json, 'dsh-agos').verdict, 'fail', '仍然新鲜,所以缺包照旧判失败')
})

test('NC20g: 旧格式产物(没有输入指纹)→ 一律按陈旧处理,不许靠"缺字段"绕过判断', () => {
	const pkg = '@agos-selftest/not-a-real-package-nc18'
	const legacy = { ...SURFACE_NEEDING(pkg) }
	delete legacy.inputsDigest
	const r = runRunner({ plan: ONE_GATE, surface: legacy })
	assert.match(r.stdout, /依赖面产物已陈旧/, '没有指纹就无法自证新鲜,必须按陈旧处理')
	assert.notEqual(suiteOf(r.json, 'dsh-agos').verdict, 'fail', '既然判了陈旧,就不能据它判失败')
})
