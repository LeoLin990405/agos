// 负例套件:依赖准备脚本的写入路径安全(P1 缺陷 1)。
//
// 全部用**真实子进程**跑真实脚本(不是静态源码断言、不是 import 后调函数),
// 因为被修的缺陷正是"脚本在退出之前已经写了东西"——只有真的 spawn 才能观察到副作用。
//
// ⚠️ 绝不碰真实 ~/.dsh:每条测试自己在 mkdtemp 里造一份**假 profile**
//    (<tmp>/fake-home/.dsh/profiles/web/node_modules),攻击面完全在临时目录内。
//    断言"零写入"的方式是快照假 profile 的**完整文件列表**,跑完再比一次。
//
// 跑法:node --test scripts/acceptance/test/write-guard.test.mjs

import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, readdirSync, statSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { join, dirname, relative, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { makeFixtureRepo } from './fixture-repo.mjs'
import { HOST_INTEGRATIONS_SCHEMA } from '../lib/host-integrations.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const SCRIPT = resolve(HERE, '..', 'prepare-host-modules.mjs')

/** 合成 layers.json:层 id 固定 foo,要一个必然装不上的包 —— 只为触发写入路径。 */
const SYNTHETIC_LAYERS = {
	schema: 'agos-acceptance/host-dep-layers@1',
	pinnedHarness: 'test-fixture',
	layers: [{
		id: 'foo',
		target: 'plugins',
		servesSuites: 'fixture',
		packages: { 'definitely-not-a-real-package-agos-probe': '1.0.0' },
		why: 'fixture',
	}],
}

const made = []
function sandbox(name) {
	const dir = mkdtempSync(join(tmpdir(), `agos-wg-${name}-`))
	made.push(dir)
	// 假的 live profile —— 攻击目标。带一个预置文件,便于证明"内容一字未动"。
	const profile = join(dir, 'fake-home', '.dsh', 'profiles', 'web', 'node_modules')
	mkdirSync(profile, { recursive: true })
	writeFileSync(join(profile, '.preexisting-marker.json'), '{"marker":"live-profile"}\n')
	mkdirSync(join(dir, 'sandbox'), { recursive: true })
	writeFileSync(join(dir, 'layers.json'), JSON.stringify(SYNTHETIC_LAYERS, null, 2))
	return { dir, profile, layers: join(dir, 'layers.json'), sandboxDir: join(dir, 'sandbox') }
}

process.on('exit', () => {
	for (const d of made) { try { rmSync(d, { recursive: true, force: true }) } catch {} }
})

/** 递归列出某目录下所有条目(含空目录),排序 —— "零写入"断言的比较基准。 */
function snapshot(root) {
	const out = []
	const walk = (d) => {
		for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
			const full = join(d, e.name)
			if (e.isDirectory()) { out.push(`dir  ${relative(root, full)}`); walk(full) }
			else if (e.isSymbolicLink()) out.push(`link ${relative(root, full)}`)
			else out.push(`file ${relative(root, full)} ${statSync(full).size}`)
		}
	}
	if (existsSync(root)) walk(root)
	return out.join('\n')
}

function run(args, extraEnv = {}) {
	const res = spawnSync(process.execPath, [SCRIPT, ...args], {
		encoding: 'utf8',
		timeout: 120000,
		env: { ...process.env, ...extraEnv },
	})
	return { code: res.status, out: (res.stdout ?? '') + (res.stderr ?? ''), signal: res.signal }
}

test('NC-W1: 祖先是指向假 live profile 的软链 → 拒绝(退出 2)且**零写入**', () => {
	const s = sandbox('ancestor')
	// <sandbox>/via 是软链 → 假 profile 的 node_modules。
	// 声明的 --prefix 是 <sandbox>/via/host-deps:词法上完全在 sandbox 里,
	// 真实位置却在 .dsh profile 里。这就是原缺陷被利用的形状。
	symlinkSync(s.profile, join(s.sandboxDir, 'via'))
	const before = snapshot(s.profile)

	const r = run(['--offline', `--layers=${s.layers}`, '--surface=/nonexistent/none.json',
		`--prefix=${join(s.sandboxDir, 'via', 'host-deps')}`])

	assert.equal(r.code, 2, `必须以退出码 2 拒绝,实际 ${r.code}\n${r.out}`)
	assert.match(r.out, /拒绝/, '必须明说拒绝')
	assert.match(r.out, /\.dsh|允许的写入根/, '必须点明越界原因')
	// 硬断言:假 profile 一个字节都没变(原缺陷会写出 host-deps/foo/package.json)
	assert.equal(snapshot(s.profile), before, '假 profile 内容必须一字未动(零写入)')
	assert.ok(!existsSync(join(s.profile, 'host-deps')), '绝不能创建 host-deps 目录')
	assert.ok(!existsSync(join(s.profile, 'host-deps', 'foo', 'package.json')),
		'原缺陷写出的正是这个文件,必须不存在')
})

test('NC-W2: 真实路径不在允许根内 → 拒绝(与 .dsh 命名无关,证明包含性检查独立成立)', () => {
	const s = sandbox('contain')
	// 诱饵 profile **不含** .dsh 路径段,所以"禁止路径段"那条规则打不到它;
	// 只有"真实路径必须落在允许的写入根内"这条能拦下来。两条规则各自独立可证。
	const decoy = join(s.dir, 'fake-home', 'dsh-live', 'profiles', 'web', 'node_modules')
	mkdirSync(decoy, { recursive: true })
	writeFileSync(join(decoy, '.preexisting-marker.json'), '{"marker":"decoy"}\n')
	symlinkSync(decoy, join(s.sandboxDir, 'via'))
	const before = snapshot(decoy)

	const r = run(['--offline', `--layers=${s.layers}`, '--surface=/nonexistent/none.json',
		`--prefix=${join(s.sandboxDir, 'via', 'host-deps')}`,
		`--allow-write-root=${s.sandboxDir}`])

	assert.equal(r.code, 2, `必须以退出码 2 拒绝,实际 ${r.code}\n${r.out}`)
	assert.match(r.out, /不在任何允许的写入根内/, '必须指出真实位置越出允许根')
	assert.doesNotMatch(r.out, /含受保护路径段/, '本例不该靠 .dsh 命名命中 —— 否则证明不了包含性检查本身')
	assert.equal(snapshot(decoy), before, '诱饵 profile 必须一字未动(零写入)')
})

test('NC-W3: --prefix 本身就是软链 → 拒绝且零写入', () => {
	const s = sandbox('leaf')
	symlinkSync(s.profile, join(s.sandboxDir, 'host-deps'))
	const before = snapshot(s.profile)

	const r = run(['--offline', `--layers=${s.layers}`, '--surface=/nonexistent/none.json',
		`--prefix=${join(s.sandboxDir, 'host-deps')}`])

	assert.equal(r.code, 2, `必须以退出码 2 拒绝,实际 ${r.code}\n${r.out}`)
	assert.equal(snapshot(s.profile), before, '假 profile 必须一字未动')
	assert.ok(!existsSync(join(s.profile, 'foo')), '原缺陷会在这里建 foo/,必须不存在')
})

test('NC-W4: 悬空软链当 --prefix → 拒绝(不能当成"待创建"就放过)', () => {
	const s = sandbox('dangling')
	symlinkSync(join(s.dir, 'nowhere-at-all'), join(s.sandboxDir, 'host-deps'))

	const r = run(['--offline', `--layers=${s.layers}`, '--surface=/nonexistent/none.json',
		`--prefix=${join(s.sandboxDir, 'host-deps')}`])

	assert.equal(r.code, 2, `必须拒绝,实际 ${r.code}\n${r.out}`)
	assert.match(r.out, /悬空软链|无法 realpath/, '必须点明是悬空软链')
})

test('NC-W5: 层内 package.json 是指向 profile 的软链 → O_NOFOLLOW 拒写,profile 零写入', () => {
	const s = sandbox('nofollow')
	// 目录检查全过(prefix 是干净的真实目录),但最后一段被换成软链。
	// 普通 writeFileSync 会顺着软链把内容写进 profile;O_NOFOLLOW 必须让它失败。
	const prefix = join(s.sandboxDir, 'host-deps')
	mkdirSync(join(prefix, 'foo'), { recursive: true })
	const victim = join(s.profile, 'stolen-package.json')
	symlinkSync(victim, join(prefix, 'foo', 'package.json'))
	const before = snapshot(s.profile)

	// 必须在合成仓上跑:不给 --repo-root 会去扫**真实仓**,那边所有说明符都已解析,
	// 层里无事可做 → 直接退 0,压根走不到写 package.json 这一步,断言等于没测。
	const repo = makeFixtureRepo('wg-nofollow', {
		plugins: {
			alpha: { files: { 'lib/index.js': "import x from 'definitely-not-a-real-package-agos-probe'\nexport default x\n" } },
		},
	})
	const r = run(['--offline', `--layers=${s.layers}`, '--surface=/nonexistent/none.json',
		`--repo-root=${repo}`, `--prefix=${prefix}`, `--allow-write-root=${s.sandboxDir}`])

	assert.notEqual(r.code, 0, `不能成功,实际 ${r.code}\n${r.out}`)
	assert.ok(!existsSync(victim), `绝不能穿过软链写出 ${victim}`)
	assert.equal(snapshot(s.profile), before, '假 profile 必须一字未动')
})

test('POS-W6: 干净的临时 --prefix → 守卫放行(不是无脑全拒),层目录建在沙箱内', () => {
	const s = sandbox('positive')
	const prefix = join(s.sandboxDir, 'host-deps')
	// 合成插件仓:真的导入那个探针包,这样层里才有活要干(写出 foo/package.json)。
	const repo = makeFixtureRepo('wg-positive', {
		plugins: {
			alpha: { files: { 'lib/index.js': "import x from 'definitely-not-a-real-package-agos-probe'\nexport default x\n" } },
		},
	})

	const before = snapshot(s.profile)
	const r = run(['--offline', `--layers=${s.layers}`, '--surface=/nonexistent/none.json',
		`--repo-root=${repo}`, `--prefix=${prefix}`, `--allow-write-root=${s.sandboxDir}`])

	// offline 且包装不上 → 退出 1(不就绪),但**不是** 2(守卫拒绝)。
	assert.equal(r.code, 1, `合法路径必须放行后按"不就绪"退 1,实际 ${r.code}\n${r.out}`)
	assert.doesNotMatch(r.out, /未通过真实路径守卫/, '合法路径不该被守卫拒绝')
	assert.ok(existsSync(join(prefix, 'foo', 'package.json')), '应当在沙箱内正常写出层 package.json')
	assert.equal(snapshot(s.profile), before, '假 profile 仍旧只有预置文件')
})

test('NC-W7: 守卫在 --check 模式下同样生效(不变量不因模式打折)', () => {
	const s = sandbox('checkmode')
	symlinkSync(s.profile, join(s.sandboxDir, 'via'))
	const before = snapshot(s.profile)

	const r = run(['--check', `--layers=${s.layers}`, '--surface=/nonexistent/none.json',
		`--prefix=${join(s.sandboxDir, 'via', 'host-deps')}`])

	assert.equal(r.code, 2, `--check 也必须拒绝,实际 ${r.code}\n${r.out}`)
	assert.equal(snapshot(s.profile), before, '零写入')
})

// 这三条是补上来的:宿主集成清单的 fail-closed 此前**零覆盖**,而它恰好在本轮
// 咬掉了 12 项测试(夹具没造清单 → 全部停在退出 2,断言到的不是各自要测的东西)。
// 一条能让十几项测试集体失效的行为,必须自己有负例守着。
test('NC-W9: 宿主集成清单缺失 → fail-closed 退出 2,并明说「缺失 ≠ 没有集成」', () => {
	const s = sandbox('manifest-missing')
	// hostIntegrations: null = 显式不写清单(默认是写一份空的)
	const repo = makeFixtureRepo('wg-no-manifest', {
		plugins: { alpha: { files: { 'lib/index.js': "export default 1\n" } } },
		hostIntegrations: null,
	})
	const r = run(['--check', `--layers=${s.layers}`, '--surface=/nonexistent/none.json',
		`--repo-root=${repo}`, `--prefix=${join(s.sandboxDir, 'host-deps')}`])

	assert.equal(r.code, 2, `清单缺失必须 fail-closed 退 2,实际 ${r.code}\n${r.out}`)
	assert.match(r.out, /宿主集成清单不存在/, '必须点名缺的是哪份清单')
	assert.match(r.out, /不等于|≠/, '必须说清「缺失 ≠ 没有集成」,否则下个人会以为空清单可省')
	assert.match(r.out, /integrations 为空数组/, '必须给出「确实没有集成」时的正确写法')
})

test('NC-W10: 清单 JSON 语法错 / schema 不认识 → 同样 fail-closed,不当成空清单', () => {
	const s = sandbox('manifest-bad')
	const cases = [
		['JSON 语法错', '{ not json at all', /JSON 解析失败/],
		['schema 不认识', JSON.stringify({ schema: 'wrong@9', integrations: [] }), /schema 不认识/],
		['缺 integrations 数组', JSON.stringify({ schema: HOST_INTEGRATIONS_SCHEMA }), /缺 integrations 数组/],
	]
	for (const [label, body, pattern] of cases) {
		const repo = makeFixtureRepo(`wg-bad-${label.length}`, {
			plugins: { alpha: { files: { 'lib/index.js': "export default 1\n" } } },
			hostIntegrations: body,
		})
		const r = run(['--check', `--layers=${s.layers}`, '--surface=/nonexistent/none.json',
			`--repo-root=${repo}`, `--prefix=${join(s.sandboxDir, 'host-deps')}`])
		assert.equal(r.code, 2, `${label}:必须 fail-closed 退 2,实际 ${r.code}\n${r.out}`)
		assert.match(r.out, pattern, `${label}:理由要点到具体毛病`)
	}
})

test('POS-W11: 空 integrations 清单 → 放行(证明 fail-closed 不是无脑全拒)', () => {
	const s = sandbox('manifest-empty')
	const repo = makeFixtureRepo('wg-empty-manifest', {
		plugins: { alpha: { files: { 'lib/index.js': "export default 1\n" } } },
		hostIntegrations: { schema: HOST_INTEGRATIONS_SCHEMA, integrations: [] },
	})
	const r = run(['--check', `--layers=${s.layers}`, '--surface=/nonexistent/none.json',
		`--repo-root=${repo}`, `--prefix=${join(s.sandboxDir, 'host-deps')}`])

	// 没有裸说明符、清单显式为空 → 就绪,退 0
	assert.equal(r.code, 0, `空清单 + 无缺包应退 0,实际 ${r.code}\n${r.out}`)
	assert.doesNotMatch(r.out, /宿主集成清单不可用/, '显式空清单不该报不可用')
})

test('NC-W8: 报告里必须诚实写明 TOCTOU 残留窗口(不许声称完备)', () => {
	const s = sandbox('toctou')
	const prefix = join(s.sandboxDir, 'host-deps')
	const jsonPath = join(s.dir, 'report.json')

	run(['--check', `--layers=${s.layers}`, '--surface=/nonexistent/none.json',
		`--prefix=${prefix}`, `--json=${jsonPath}`])

	assert.ok(existsSync(jsonPath), '应写出 json 报告')
	const report = JSON.parse(readFileSync(jsonPath, 'utf8'))
	assert.ok(report.writeTargetGuard, '报告必须含 writeTargetGuard')
	assert.match(report.writeTargetGuard.toctouCaveat, /TOCTOU|check-then-write/,
		'必须如实声明 check-then-write 的残留窗口')
	assert.match(report.writeTargetGuard.toctouCaveat, /不保证|不声称|残留/,
		'不得把守卫说成完备防御')
})
