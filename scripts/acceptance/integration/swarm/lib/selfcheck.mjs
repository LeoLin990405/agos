/**
 * **入口自检** —— 证明这个入口有区分力,而不是一台"永远输出 pass"的打印机。
 *
 * ⚠️ 自检结果**不是**真实集成结果。它跑的是桩,不是真 swarm。
 * 入口把两者写在结果 JSON 的不同字段里(`selfCheck` vs `counts`/`checks`),
 * 自检永远不进 `counts` —— 否则"入口自检 5 项通过"会被上层读成"集成 5 项通过",
 * 而那正是任务书点名禁止的冒充。
 *
 * 自检覆盖两件事:
 *   A. **判定逻辑**:各种"模块状态 × 检查结果"组合下,verdict 是不是该有的那个。
 *      这类组合在真实运行里造不出来(你没法让真模块缺一个导出给你看),
 *      所以只能拿桩喂纯函数。
 *   B. **检查集合真的会执行模块**:拿一个"导出齐全、类型都对、但行为是错的"桩,
 *      跑**同一套**真实检查集合,必须变红。这条最关键 —— 它排除了
 *      "检查其实只看了导出表、没真跑过"这种最容易发生的假绿。
 */
import assert from 'node:assert/strict'

import { classify } from './verdict.mjs'
import { buildChecks, runChecks } from './checks.mjs'
import { inspectSwarmExports } from '../../../../../plugins/dsh-agos/lib/swarm-host-integration.mjs'

/** 形状齐全的桩:导出名与类型都对。用来证明"形状闸门"不会误杀合格模块。 */
function shapeOnlyStub() {
	return {
		runNormalizedBatch: async () => '',
		SwarmScheduler: class {},
		publishProgress: () => {},
		PROGRESS: new Map(),
		STOPPED: new Set(),
		escapeXml: (v) => String(v),
		unescapeXml: (v) => String(v ?? ''),
		textOf: (r) => r.output.join(''),
		parseResultsXml: () => [],
	}
}

const AVAILABLE = { available: true, reason: null }
const UNAVAILABLE = { available: false, reason: "Cannot find package 'dsh-kimicode-swarm'" }

export async function runSelfCheck() {
	const cases = []
	const it = (id, title, fn) => cases.push({ id, title, fn })

	// ── A. 判定逻辑 ──────────────────────────────────────────────────────
	it('SC1', '可用桩 + 全通过 → pass(形状闸门不误杀合格模块)', async () => {
		const shape = inspectSwarmExports(shapeOnlyStub())
		assert.equal(shape.ok, true, `形状齐全的桩被闸门判为不合格:${JSON.stringify(shape)}`)
		const out = classify({ moduleState: AVAILABLE, exports: shape, results: [{ id: 'x', status: 'pass' }, { id: 'y', status: 'pass' }] })
		assert.equal(out.verdict, 'pass')
		assert.deepEqual(out.counts, { pass: 2, fail: 0, skip: 0, blocked: 0 })
		assert.equal(out.blockedReason, null)
	})

	it('SC2', '损坏桩(缺 runNormalizedBatch)→ blocked,原因点名缺了哪个导出', async () => {
		const broken = shapeOnlyStub()
		delete broken.runNormalizedBatch
		const shape = inspectSwarmExports(broken)
		assert.deepEqual(shape.missing, ['runNormalizedBatch'])
		const out = classify({ moduleState: AVAILABLE, exports: shape, results: [] })
		assert.equal(out.verdict, 'blocked', '缺导出被判成了别的东西')
		assert.match(out.blockedReason, /runNormalizedBatch/, 'blockedReason 没有点名缺失的导出')
		assert.doesNotMatch(out.blockedReason, /Cannot find package/, '"缺导出"与"没装包"的原因串混同了')
		assert.ok(out.recoveryCommand?.length > 0, 'blocked 必须给可复制的恢复命令')
		assert.equal(out.counts.blocked, 1)
	})

	it('SC3', '损坏桩(类型不对:PROGRESS 是函数)→ blocked,原因写明期望/实际类型', async () => {
		const broken = { ...shapeOnlyStub(), PROGRESS: () => {} }
		const shape = inspectSwarmExports(broken)
		assert.deepEqual(shape.wrongType, [{ name: 'PROGRESS', want: 'object', got: 'function' }])
		const out = classify({ moduleState: AVAILABLE, exports: shape, results: [] })
		assert.equal(out.verdict, 'blocked')
		assert.match(out.blockedReason, /PROGRESS\(期望 object,实际 function\)/)
	})

	it('SC4', '模块不可用 → blocked 且带底层原因;绝不报 fail(那会把环境缺失说成代码坏了)', async () => {
		const out = classify({ moduleState: UNAVAILABLE, exports: null, results: [] })
		assert.equal(out.verdict, 'blocked')
		assert.match(out.blockedReason, /Cannot find package/)
		assert.ok(out.blockedReason.length >= 16, 'blockedReason 太短,消费端会判 blocked-reason-too-vague')
	})

	it('SC5', '判定诚实性:有 fail 不许 pass;零检查不许 pass;blocked 不并进 pass', async () => {
		const shape = inspectSwarmExports(shapeOnlyStub())
		const withFail = classify({ moduleState: AVAILABLE, exports: shape, results: [{ id: 'a', status: 'pass' }, { id: 'b', status: 'fail' }] })
		assert.equal(withFail.verdict, 'fail', '有失败却没判 fail')
		assert.equal(withFail.counts.fail, 1)

		const empty = classify({ moduleState: AVAILABLE, exports: shape, results: [] })
		assert.equal(empty.verdict, 'blocked', '零检查被判成了 pass —— 空集合的零失败是最廉价的假绿')

		// 模块在场时,跑红就得认 fail,不许退回 blocked 装成"环境问题"
		assert.notEqual(withFail.verdict, 'blocked')
	})

	it('SC9', '自检自己红了,整层判定必须跟着变红 —— 不能只改退出码', async () => {
		// 这条是削弱反证补出来的。原先自检失败只让进程 exit=1,落盘 JSON 里
		// 照旧写 verdict=pass;而契约里下游读的是 JSON,不是退出码。于是
		// "判定逻辑坏掉"这件事会被原样写进证据,还顶着通过的名头。
		const shape = inspectSwarmExports(shapeOnlyStub())
		const red = { ok: false, pass: 6, total: 8, cases: [] }

		const allGreen = classify({
			moduleState: AVAILABLE, exports: shape, selfCheck: red,
			results: [{ id: 'a', status: 'pass' }, { id: 'b', status: 'pass' }],
		})
		assert.equal(allGreen.verdict, 'fail', '真实检查全绿也不行:自检红说明这些"绿"没有区分力背书')
		assert.match(allGreen.selfCheckFailure ?? '', /6\/8/, '否决理由没说清自检红在哪')

		// 一票否决要盖过 blocked:自检坏了,"这台机器没法验"同样是不可信的断言
		const noModule = classify({ moduleState: { available: false, reason: 'x' }, exports: null, results: [], selfCheck: red })
		assert.equal(noModule.verdict, 'fail', '自检红时 blocked 也不许出口')

		// 反向:自检绿时判定不受影响,别把一票否决写成永远 fail
		const green = { ok: true, pass: 8, total: 8, cases: [] }
		assert.equal(classify({ moduleState: AVAILABLE, exports: shape, selfCheck: green, results: [{ id: 'a', status: 'pass' }] }).verdict, 'pass')
		assert.equal(classify({ moduleState: { available: false, reason: 'x' }, exports: null, results: [], selfCheck: green }).verdict, 'blocked')
	})

	// ── B. 检查集合真的会执行模块 ─────────────────────────────────────────
	it('SC6', '行为错误的桩(导出齐全、类型全对)必须被真实检查集合打红', async () => {
		// 这条排除的是最容易发生的假绿:检查其实只看了导出表,根本没跑过模块。
		// 桩的导出表与形状闸门全都合格,只有**行为**是错的 —— 只有真跑过才抓得到。
		const stub = shapeOnlyStub()
		const shape = inspectSwarmExports(stub)
		assert.equal(shape.ok, true, '这个桩本该通过形状闸门,否则 SC6 证明不了"跑过"')

		// 短等待预算:坏桩从不启动子代理,每个同步点都会走满超时。用生产预算的话
		// 自检要跑近一分钟,而它本该是入口每次都跑的快速前置。
		// 自检必须快速失败；真实 runner 在独立进程里另有 1s 单项 deadline。
		const results = await runChecks(buildChecks(stub, { waitTimeoutMs: 25 }), { checkTimeoutMs: 50 })
		const failed = results.filter((r) => r.status === 'fail')
		assert.ok(failed.length > 0, '行为错误的桩竟然全绿 —— 检查集合根本没有执行模块')

		// 点名:批次入口、XML 差分这两组都必须红,只红一组说明另一组是空跑
		const failedIds = new Set(failed.map((r) => r.id))
		assert.ok([...failedIds].some((id) => id.startsWith('B')), `批次入口组没红(红的是 ${[...failedIds].join(',')})`)
		assert.ok(failedIds.has('X1'), 'XML 差分组没红')

		const out = classify({ moduleState: AVAILABLE, exports: shape, results })
		assert.equal(out.verdict, 'fail', '桩把检查跑红了,整层却没判 fail')
		return { checksRun: results.length, checksFailed: failed.length }
	})

	it('SC8', '来源判定有区分力:同样的探测在"干净 registry 解包"与"被覆盖过的目录"上给不同结论', async () => {
		// provenance 是本层唯一一个**没有断言能兜住**的输出:它写什么就是什么,
		// 判错了(比如把本地构建产物记成 registry)不会让任何检查变红,而报告会因此撒谎。
		// 这条用两份磁盘 fixture 把它钉住 —— 判定逻辑退化成常量时必然有一边对不上。
		const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs')
		const { join } = await import('node:path')
		const { tmpdir } = await import('node:os')
		const { describeSwarmProvenance } = await import('../../../../../plugins/dsh-agos/lib/swarm-host-integration.mjs')

		const root = mkdtempSync(join(tmpdir(), 'agos-prov-fixture-'))
		try {
			const make = (name, { extraDir }) => {
				const dir = join(root, name)
				mkdirSync(join(dir, 'lib'), { recursive: true })
				writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'fixture-swarm', version: '9.9.9', files: ['lib'] }))
				// 干净那份保留 registry 三版都有的 dsh-settings 导入,且导出面只有 6 个
				writeFileSync(join(dir, 'lib/index.js'),
					'import { installSettingsSection } from "@deepseek-ai/dsh-settings"\n'
					+ 'export { a, b, c, d, e, f }\n')
				if (extraDir) mkdirSync(join(dir, extraDir), { recursive: true })
				return join(dir, 'lib/index.js')
			}
			const cleanEntry = make('clean', {})
			const overwrittenEntry = make('overwritten', { extraDir: 'test' })

			const clean = await describeSwarmProvenance({ env: { AGOS_SWARM_MODULE: cleanEntry } })
			const overwritten = await describeSwarmProvenance({ env: { AGOS_SWARM_MODULE: overwrittenEntry } })

			assert.equal(clean.origin, 'registry', `干净解包被判成 ${clean.origin}:${clean.originNote}`)
			assert.deepEqual(clean.evidence, [], '干净解包不该产生任何"被改过"的证据')
			assert.equal(overwritten.origin, 'local-build', `白名单外多出 test/ 的目录被判成 ${overwritten.origin}`)
			assert.ok(overwritten.evidence.some((e) => e.kind === 'filesAllowlistViolation'), '没有给出 files 白名单违例证据')
			assert.notEqual(clean.origin, overwritten.origin, '来源判定退化成常量了 —— 两份不同的目录得到同一个结论')

			// sha256 必须是真算的:两份内容相同的 lib/index.js 应当同哈希,且不是占位串
			assert.equal(clean.sha256, overwritten.sha256)
			assert.match(clean.sha256, /^[0-9a-f]{64}$/)
			assert.equal(clean.version, '9.9.9', 'version 没有从 package.json 真读')
		} finally {
			rmSync(root, { recursive: true, force: true })
		}
	})

	it('SC7', '加载即抛的模块:解析层如实报硬错误,不伪装成"本机没装"', async () => {
		const { resolveSwarmModule, SWARM_OPT_IN_ENV } = await import('../../../../../plugins/dsh-agos/lib/swarm-host-integration.mjs')
		const throwing = 'data:text/javascript,' + encodeURIComponent('throw new Error("stub blew up on load")')
		const resolution = await resolveSwarmModule({ env: { [SWARM_OPT_IN_ENV]: throwing } })
		assert.equal(resolution.available, false)
		assert.match(resolution.reason, /stub blew up on load/, '加载期错误没有透传')
		assert.match(resolution.reason, new RegExp(SWARM_OPT_IN_ENV), '没点名是 opt-in 配置的问题')
		assert.doesNotMatch(resolution.reason, /未解析到同级/, '配错路径被伪装成了"没装同级插件"')

		const out = classify({ moduleState: resolution, exports: null, results: [] })
		assert.equal(out.verdict, 'blocked')
	})

	it('SC10', 'opt-in 指向包目录时翻成 package.json 入口;错路径仍硬失败,不回落同级', async () => {
		const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs')
		const { join } = await import('node:path')
		const { tmpdir } = await import('node:os')
		const { resolveSwarmModule, locateSwarmModule, SWARM_OPT_IN_ENV } = await import('../../../../../plugins/dsh-agos/lib/swarm-host-integration.mjs')
		const root = mkdtempSync(join(tmpdir(), 'agos-swarm-pkgdir-'))
		try {
			mkdirSync(join(root, 'lib'), { recursive: true })
			writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'fixture-swarm', version: '0.0.0', main: 'lib/index.js' }))
			writeFileSync(join(root, 'lib', 'index.js'), 'export const ok = 1\n')
			const seen = []
			const resolution = await resolveSwarmModule({
				env: { [SWARM_OPT_IN_ENV]: root },
				importer: async (spec) => { seen.push(spec); return { ok: 1 } },
			})
			assert.equal(resolution.available, true, `目录 opt-in 应当可加载: ${resolution.reason}`)
			assert.equal(seen[0], join(root, 'lib/index.js'), `应当翻成入口文件,实际喂给 import 的是 ${seen[0]}`)
			const located = await locateSwarmModule({ env: { [SWARM_OPT_IN_ENV]: root } })
			assert.ok(String(located.path).endsWith('lib/index.js'), `locate 也必须归一,实际 ${located.path}`)
			const missing = await resolveSwarmModule({ env: { [SWARM_OPT_IN_ENV]: join(root, 'no-such-file.mjs') } })
			assert.equal(missing.available, false)
			assert.match(missing.reason, new RegExp(SWARM_OPT_IN_ENV))
			assert.doesNotMatch(missing.reason, /未解析到同级/, '错路径被伪装成了没装同级插件')
		} finally {
			rmSync(root, { recursive: true, force: true })
		}
	})

	const results = []
	for (const { id, title, fn } of cases) {
		try {
			const extra = await fn()
			results.push({ id, title, status: 'pass', ...(extra ?? {}) })
		} catch (error) {
			results.push({ id, title, status: 'fail', error: `${error?.constructor?.name ?? 'Error'}: ${error?.message ?? error}` })
		}
	}
	const failed = results.filter((r) => r.status === 'fail').length
	return {
		note: '入口自检:跑的是桩,不是真 swarm。这里的 pass 不构成任何真实集成证据,故不计入 counts。',
		total: results.length,
		pass: results.length - failed,
		fail: failed,
		ok: failed === 0,
		cases: results,
	}
}
