#!/usr/bin/env node
// A4:负控自检 —— 证明验收器**没法**谎报成功。
//
// 每条控制都真的把 run-acceptance.mjs 当子进程跑一遍,同时断言
//   (1) 进程退出码  (2) 落盘 JSON 里的判定
// 两处都不许说谎。
//
// 跑法:node --test scripts/acceptance/selftest.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { REPO_ROOT, verdictOf, parseNodeTestCounts } from './lib/exec.mjs'

const HERE = dirname(new URL(import.meta.url).pathname)
// 可指向被故意改坏的验收器副本:用来证明这些负控**不是空转**(见 mutation-check.sh)。
const RUNNER = process.env.AGOS_SELFTEST_RUNNER ? resolve(process.env.AGOS_SELFTEST_RUNNER) : join(HERE, 'run-acceptance.mjs')
const FIXTURES = 'scripts/acceptance/selftest-fixtures'

/** 跑一次验收器,回真实退出码 + 落盘 JSON。 */
function runRunner({ plan, surface = null, floors = null, extraArgs = [] }) {
	const work = mkdtempSync(join(tmpdir(), 'agos-selftest-'))
	const planPath = join(work, 'plan.json')
	writeFileSync(planPath, JSON.stringify(plan, null, 2))
	const jsonPath = join(work, 'results.json')
	const argv = [RUNNER, `--plan=${planPath}`, `--json=${jsonPath}`, `--logdir=${join(work, 'logs')}`, ...extraArgs]
	if (surface) { const sp = join(work, 'surface.json'); writeFileSync(sp, JSON.stringify(surface, null, 2)); argv.push(`--surface=${sp}`) }
	else argv.push(`--surface=${join(work, 'no-such-surface.json')}`)   // 默认不让负控依赖真实实测文件
	if (floors) { const fp = join(work, 'floors.json'); writeFileSync(fp, JSON.stringify(floors, null, 2)); argv.push(`--floors=${fp}`) }
	else argv.push(`--floors=${join(work, 'no-such-floors.json')}`)
	const res = spawnSync(process.execPath, argv, { cwd: REPO_ROOT, encoding: 'utf8', timeout: 300000 })
	const json = existsSync(jsonPath) ? JSON.parse(readFileSync(jsonPath, 'utf8')) : null
	return { exitCode: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '', json, work }
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
