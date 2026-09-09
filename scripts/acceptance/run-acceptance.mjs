#!/usr/bin/env node
// A3:代码闸 与 部署漂移 彻底分开跑、分开报,各自保留生产者真实退出码。
//
// 三条不混的通道:
//   codeGates —— 决定进程退出码。任何 fail/empty/skipped(必需套件)都让它非零。
//   advisory  —— 部署漂移这类"环境事实"。**永不**influence 退出码,但也**永不**被吞:
//                真实退出码原样进 JSON 和终端摘要,带 ADVISORY 标签。
//   preflight —— 依赖面体检。实测需要的包缺了 → 相关套件直接判 missing-host-modules 失败
//                (非零、带诊断),绝不降级成 skip、绝不算通过。
//
// 诚实判定(lib/exec.mjs verdictOf):退出非零 / 报了 fail / 压根没摘要 → fail;
// 退出 0 但 0 个测试 → empty(不算过);全 skip 一条没真过 → skipped(不算过);
// skip 数单独统计,永不并入 pass。
//
// 默认不读私有语料、不带任何供应商密钥(lib/exec.mjs neutralEnv:语料变量指向不存在的临时路径)。
//
// 用法:
//   node scripts/acceptance/run-acceptance.mjs                       # 插件代码闸 + 自检 + 依赖树校验 + 漂移(advisory)
//   node scripts/acceptance/run-acceptance.mjs --with-frontend       # 加上 frontend npm run verify
//   node scripts/acceptance/run-acceptance.mjs --plan=<file.json>    # 自定义计划(A4 自检用)
//   node scripts/acceptance/run-acceptance.mjs --no-advisory         # 不跑漂移检查
//   node scripts/acceptance/run-acceptance.mjs --print-plan          # 只打印计划(**退 78**,永远不能被当成通过)
//   node scripts/acceptance/run-acceptance.mjs --json=<out> --logdir=<dir>
//
// 可测性接缝(仅自检用;一旦使用,本次运行就被标记 authoritative:false 并大声打印):
//   --required-plugins=<csv>   覆盖必需套件清单
//   --plugins-root=<dir>       覆盖套件根目录(默认 <repo>/plugins)
//   --selftest-file=<path>     覆盖自检文件(防递归探针用)
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, relative, resolve, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { REPO_ROOT, runCommand, parseNodeTestCounts, detectMissingModules, neutralEnv, verdictOf, isGreen, sha256 } from './lib/exec.mjs'
import { loadHostIntegrations } from './lib/host-integrations.mjs'
import { surfaceInputsDigest } from './lib/surface-inputs.mjs'

const HERE = dirname(new URL(import.meta.url).pathname)
/** 必需套件清单。少一个都不许从计划里消失(见 defaultPlan 的结构性失败)。 */
const REQUIRED_PLUGINS = ['dsh-agos', 'dsh-agos-router', 'dsh-mcp-bridge', 'cn-capabilities', 'dsh-fleet']

const args = process.argv.slice(2)
const flag = (n) => args.includes(`--${n}`)
const opt = (n, d) => { const h = args.find((a) => a.startsWith(`--${n}=`)); return h ? h.slice(n.length + 3) : d }
const planPath = opt('plan', null)
const withFrontend = flag('with-frontend')
const noAdvisory = flag('no-advisory')
const printPlanOnly = flag('print-plan')
const logDir = resolve(opt('logdir', join(tmpdir(), 'agos-acceptance-logs')))
const jsonOut = opt('json', null)
const surfaceOverride = opt('surface', null)   // A4 自检注入合成依赖面用
// 同族:让负控能注入合成的宿主集成清单,而不必去动仓里那份真清单。
// 与 --surface 一样计入 SYNTHETIC —— 用了它的运行不许写基线。
const hostIntegrationsOverride = opt('host-integrations', null)
const floorsPath = opt('floors', join(HERE, 'expected-counts.json'))

// 裸 `--write-floors`(不带 =路径)必须**在跑任何东西之前**报错,不能静默忽略。
//
// `opt()` 只认 `--name=value`,所以裸标志会落回默认值 null,写基线那一段直接不执行 ——
// 而且**一声不响**:输出与不加这个标志的一次运行逐字相同。2026-09-09 我自己踩了这一脚:
// 跑完 `--write-floors` 看到全绿,以为下限已随新增测试上调,实际文件一字未动,
// 差点带着过期下限交付。下限过期不会让门变红,只会让它**不再拦人** ——
// 正是本轮在追的那类假绿,所以必须吵。
//
// 位置在参数解析处而不是写盘处:放在后面会先把整套门跑完、打完"退出码 = 0",
// 再补一句报错,读者容易只看见前一句。
if (args.includes('--write-floors')) {
	console.error('❌ --write-floors 需要显式路径:--write-floors=scripts/acceptance/expected-counts.json')
	console.error('   裸标志会被静默忽略(输出与没加时一模一样),于是「我已重算下限」变成一个没人验证的错觉。')
	process.exit(78)
}

// ---- 可测性接缝 ----
// 自检要验证 defaultPlan 的结构性判定(整包缺失/空目录/缺基线条目),就必须能把默认计划
// 指向合成的套件树 —— 否则那些负控只能靠"静态读源码"证明,而那不算证明运行行为。
// 代价是这三个开关本身是绕过手段,所以:用了就把整次运行标成 authoritative:false、
// 大声打印、并写进 JSON;宿主依赖体检也一并跳过(合成运行本来就不代表真实环境)。
const pluginsOverride = opt('required-plugins', null)
const pluginsRootOverride = opt('plugins-root', null)
const selftestFileOverride = opt('selftest-file', null)
// --surface 也算:注入合成依赖面等于关掉包级预检,这件事同样不该静默。
const SYNTHETIC = pluginsOverride !== null || pluginsRootOverride !== null || selftestFileOverride !== null || surfaceOverride !== null || hostIntegrationsOverride !== null
const PLUGINS = pluginsOverride === null
	? REQUIRED_PLUGINS
	: pluginsOverride.split(',').map((s) => s.trim()).filter(Boolean)
const PLUGINS_ROOT = resolve(pluginsRootOverride ?? join(REPO_ROOT, 'plugins'))
const SELFTEST_FILE = resolve(selftestFileOverride ?? join(HERE, 'selftest.mjs'))

/**
 * 防递归哨兵。正式门的默认计划里含自检(见 defaultPlan),而自检的每条负控都会把验收器
 * 当子进程再跑一遍 —— 如果子进程的默认计划又含自检,就是无限递归。
 * 约定:自检 spawn 验收器时置 AGOS_ACCEPTANCE_SELFTEST=1,验收器见到它就不把自检放进计划。
 * 排除这件事**不静默**:终端打印 + JSON 里的 recursionGuard 都记下来。
 */
const SELFTEST_SENTINEL = 'AGOS_ACCEPTANCE_SELFTEST'
const selftestSuppressed = process.env[SELFTEST_SENTINEL] === '1'
/**
 * 计数下限基线:抓"删测试把闸弄绿"。
 *
 * ⚠️ 2026-09-09 改为 **fail-closed**(独立验证者 N1/P2-7 实测)。原来缺文件只打一行告警、
 * 闸照常退 0 —— 于是「挪走 expected-counts.json 再清空测试文件」能让被清空的套件判 PASS、
 * 整个闸退出码 0。这道门的全部职责就是抓「删测试把闸弄绿」,而删掉它自己的基线就能解除它,
 * 等于没有这道门。
 *
 * 同一份代码对缺依赖的处理是明确 fail-closed 的(missing-host-modules 判失败、退 78、
 * 绝不降级成 skip),设计意图本就是「不确定就报红」,唯独这一路走了相反姿态,属实现疏漏。
 *
 * 现在:缺文件直接拒绝运行并给出重建命令。`--floors=none` 是**显式**的逃生阀
 * (首次引导基线时需要),它会打印一条醒目的「本次运行不设下限」并把该事实写进 JSON 输出,
 * 不能靠「文件恰好不在」这种沉默的方式获得同样的效果。
 *
 * ⚠️ 2026-09-09 补齐(外部核查者 Luna P1):原来只挡「文件不存在」。空文件会让 JSON.parse
 * 抛未捕获异常(退 1、无诊断);`{}` 或缺 floors 字段会走 `?? {}` **静默变成没有任何下限**,
 * 于是「把基线清空成 {}」和「删掉基线」等效 —— 而删基线已经被挡住了,清空却没有。
 * 所以现在对基线做结构校验,任何一种不可用都带 reason code 退 78。
 * 下限值必须 ≥ 1:`{minTests:0,minPass:0}` 与没有下限等价,同样是绕过。
 */
const FLOORS_DISABLED = floorsPath === 'none'
let FLOORS = {}

function refuseFloors(reasonCode, lines) {
	console.error(`❌ 计数下限基线不可用,拒绝运行(fail-closed):${reasonCode}`)
	for (const l of lines) console.error(`   ${l}`)
	console.error('   这道门抓的是「删测试/清空测试文件把闸弄绿」。基线缺席或失效时它抓不到任何东西,')
	console.error('   而让它缺席/失效本身就是绕过它的手段,所以不能静默降级成告警。')
	console.error('   重建(只能从全绿运行生成): node scripts/acceptance/run-acceptance.mjs --floors=none --write-floors=scripts/acceptance/expected-counts.json')
	console.error('   明知无基线仍要跑(首次引导/临时诊断): 加 --floors=none')
	process.exit(78)
}

if (!FLOORS_DISABLED) {
	const fp = resolve(floorsPath)
	const shown = fp.startsWith(REPO_ROOT) ? relative(REPO_ROOT, fp) : fp
	if (!existsSync(fp)) refuseFloors('floors-missing-file', [`期望文件: ${shown}`, '文件不存在。'])
	const raw = readFileSync(fp, 'utf8')
	if (raw.trim() === '') refuseFloors('floors-empty-file', [`文件: ${shown}`, '文件是空的(0 字节或只有空白)。'])
	let parsed = null
	try {
		parsed = JSON.parse(raw)
	} catch (err) {
		refuseFloors('floors-invalid-json', [`文件: ${shown}`, `JSON 解析失败: ${err.message}`])
	}
	if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
		refuseFloors('floors-not-an-object', [`文件: ${shown}`, '顶层不是对象。'])
	}
	const f = parsed.floors
	if (f === undefined || f === null || typeof f !== 'object' || Array.isArray(f)) {
		refuseFloors('floors-missing-field', [`文件: ${shown}`, '缺少 `floors` 字段或它不是对象。以前这里会 `?? {}` 静默变成「没有任何下限」。'])
	}
	if (Object.keys(f).length === 0) {
		refuseFloors('floors-empty-object', [`文件: ${shown}`, '`floors` 是空对象 —— 一个下限都没有,等于没有这道门。'])
	}
	for (const [id, entry] of Object.entries(f)) {
		if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
			refuseFloors('floors-invalid-entry', [`文件: ${shown}`, `条目 ${id} 不是对象。`])
		}
		for (const k of ['minTests', 'minPass']) {
			const v = entry[k]
			if (!Number.isInteger(v) || v < 1) {
				refuseFloors('floors-invalid-entry', [`文件: ${shown}`, `条目 ${id}.${k} = ${JSON.stringify(v)},必须是 ≥ 1 的整数(0 或缺失与「没有下限」等价,是绕过手段)。`])
			}
		}
	}
	FLOORS = f
}

/** 路径落在仓内就用相对路径(保持终端输出与以前一致),否则用绝对路径(合成套件根)。 */
function gateCwd(absDir) {
	const rel = relative(REPO_ROOT, absDir)
	return rel !== '' && !rel.startsWith('..') ? rel : absDir
}

/**
 * 结构性失败闸:必需的东西压根不在,所以**没有子进程可跑**,但闸里必须留下一条显式失败。
 *
 * ⚠️ 这是本轮修的核心缺陷(外部核查者 Luna 实测):原来 defaultPlan 对「test/ 目录不存在」
 * 和「目录里没有 .mjs」都是 `continue` —— 于是「整个必需套件消失」变成「计划里没这一项」,
 * 闸没有任何东西可抓。Luna 实测:把全部插件的 test/ 挪走,tests=0、green=true、exit 0。
 * 现在缺席的必需套件会产出下面这条 verdict:'fail' 的条目,进 failedGates,让进程退非零。
 */
function structuralFailure(id, reason, detail) {
	return { id, cwd: '.', argv: [], kind: 'structural', required: true, reason, detail }
}

/**
 * 取某个必需套件的计数下限。
 * 基线里**没有**这个套件的条目 → 结构性失败:一个没有下限的必需套件等于没被这道门保护,
 * 而「往基线里少写一个条目」正是最省事的绕过方式(比删整个基线文件隐蔽得多)。
 */
function floorFor(id) {
	if (FLOORS_DISABLED) return { minTests: null, minPass: null }
	const f = FLOORS[id]
	if (!f) return { missing: true }
	return { minTests: f.minTests, minPass: f.minPass }
}

/** 默认计划:与 scripts/test-all.sh 同一个 glob(test/*.mjs),保证闸的范围一致。 */
function defaultPlan() {
	const codeGates = []
	for (const p of PLUGINS) {
		const pluginDir = join(PLUGINS_ROOT, p)
		const dir = join(pluginDir, 'test')
		if (!existsSync(dir)) {
			codeGates.push(structuralFailure(p, `missing-test-suite:${p}`,
				`必需套件的 test/ 目录不存在(期望 ${gateCwd(dir)})。必需套件缺席是失败,不是"计划里少一项"。`))
			continue
		}
		const files = readdirSync(dir).filter((f) => f.endsWith('.mjs')).sort()
		if (files.length === 0) {
			codeGates.push(structuralFailure(p, `empty-test-suite:${p}`,
				`必需套件的 test/ 目录存在但没有任何 .mjs(期望 ${gateCwd(dir)})。空套件是失败,不是"计划里少一项"。`))
			continue
		}
		const floor = floorFor(p)
		if (floor.missing) {
			codeGates.push(structuralFailure(p, `missing-floor-entry:${p}`,
				`计数下限基线里没有 ${p} 的条目 —— 这个必需套件没有下限保护,删测试抓不到。重建基线或补上该条目。`))
			continue
		}
		codeGates.push({
			id: p, plugin: p, cwd: gateCwd(pluginDir),
			argv: ['node', '--test', ...files.map((f) => join('test', f))],
			kind: 'node-test', required: true,
			minTests: floor.minTests ?? null, minPass: floor.minPass ?? null,
		})
	}
	if (withFrontend) {
		const floor = floorFor('frontend-verify')
		if (floor.missing) {
			codeGates.push(structuralFailure('frontend-verify', 'missing-floor-entry:frontend-verify',
				'计数下限基线里没有 frontend-verify 的条目。'))
		} else {
			codeGates.push({ id: 'frontend-verify', cwd: 'frontend', argv: ['npm', 'run', 'verify'], kind: 'node-test', required: true, minTests: floor.minTests ?? null, minPass: floor.minPass ?? null })
		}
	}

	// ---- 自检接进正式门(缺陷 3)----
	// 上一轮 927 个测试全绿、而自检自己 14 项里 13 项失败,原因就是这里压根没接。
	if (!selftestSuppressed) {
		if (!existsSync(SELFTEST_FILE)) {
			codeGates.push(structuralFailure('selftest', 'missing-selftest-file',
				`自检文件不存在(期望 ${gateCwd(SELFTEST_FILE)})。验收器的负控自检缺席 = 没人证明验收器不会谎报成功。`))
		} else {
			const floor = floorFor('selftest')
			if (floor.missing) {
				codeGates.push(structuralFailure('selftest', 'missing-floor-entry:selftest',
					'计数下限基线里没有 selftest 的条目 —— 删掉几条负控不会被抓到。'))
			} else {
				codeGates.push({
					id: 'selftest', cwd: '.', argv: ['node', '--test', gateCwd(SELFTEST_FILE)],
					kind: 'node-test', required: true,
					minTests: floor.minTests ?? null, minPass: floor.minPass ?? null,
				})
			}
		}
	}

	// ---- 隔离宿主依赖树的校验接进正式门 ----
	// 这两个脚本是别人的文件,这里只**调用**它们的 CLI,不碰源码。
	// 合成运行(--required-plugins/--plugins-root/--selftest-file)跳过:那种运行本来就不代表真实环境。
	if (!SYNTHETIC) {
		codeGates.push({
			id: 'host-modules-check', cwd: '.',
			argv: ['node', 'scripts/acceptance/prepare-host-modules.mjs', '--check'],
			kind: 'command', required: true,
			note: '只核验不安装:实测需要的裸包能不能从消费者角度解析。不就绪退 1。',
		})
		codeGates.push({
			id: 'host-tree', cwd: '.',
			argv: ['node', 'scripts/acceptance/verify-host-tree.mjs'],
			kind: 'command', required: true,
			note: '隔离宿主依赖树的逐字节内容校验:树的内容偏离「产出绿色结果的那份」就大声失败。',
		})
	}

	const advisory = noAdvisory ? [] : [{
		id: 'deploy-drift',
		cwd: '.',
		argv: ['zsh', 'scripts/deploy-plugins.sh', '--check'],
		kind: 'drift',
		note: '部署漂移是环境事实,不是代码缺陷:未部署的分支必然非零。只报,不参与退出码。',
	}]
	return { codeGates, advisory }
}

if (planPath === null && PLUGINS.length === 0) {
	console.error('❌ 必需套件清单为空,拒绝运行(fail-closed):empty-required-plugins')
	console.error('   --required-plugins= 把必需清单清空了。0 个必需套件的运行永远不能算通过。')
	process.exit(78)
}

const plan = planPath ? JSON.parse(readFileSync(resolve(planPath), 'utf8')) : defaultPlan()

if (printPlanOnly) {
	console.log(JSON.stringify({ plan, syntheticSeams: SYNTHETIC, recursionGuard: { sentinel: SELFTEST_SENTINEL, active: selftestSuppressed, selftestGateIncluded: plan.codeGates.some((g) => g.id === 'selftest') } }, null, 2))
	// 故意退非零:--print-plan 一个闸都没跑,任何 `... --print-plan && echo 通过` 都必须失败。
	console.error('PLAN-ONLY:只打印了计划,没有运行任何闸 —— 退出码 78,确保它永远不会被当成"通过"。')
	process.exit(78)
}

// 0 个代码闸的运行永远不能算通过(否则「让计划变空」就是最省事的假绿手段)。
if (!Array.isArray(plan.codeGates) || plan.codeGates.length === 0) {
	console.error('❌ 计划里没有任何代码闸,拒绝运行(fail-closed):empty-code-gates')
	console.error('   一个闸都不跑的运行不是"全过",是"什么都没验"。')
	process.exit(78)
}

/**
 * 本次运行的 HEAD,用来判断依赖面产物是不是在量当前这棵树。拿不到就返回 null。
 */
function currentHead() {
	const res = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' })
	return res.status === 0 ? String(res.stdout).trim() : null
}

/**
 * 快照还算不算数。
 * 有 inputsDigest 就按内容比(权威);没有的话是旧格式产物 —— 按 gitHead 退化比对,
 * 并且把「它连指纹都没有」当成陈旧,免得旧产物靠"缺字段"绕过这层判断。
 */
function surfaceStaleness(surface) {
	if (typeof surface.inputsDigest === 'string') {
		const now = surfaceInputsDigest(REPO_ROOT)
		return surface.inputsDigest === now
			? { stale: false, how: null }
			: { stale: true, how: `测量时的输入指纹 ${surface.inputsDigest.slice(0, 12)} ≠ 当前 ${now.slice(0, 12)}` }
	}
	const head = currentHead()
	if (head !== null && typeof surface.gitHead === 'string' && surface.gitHead !== head) {
		return { stale: true, how: `产物无输入指纹(旧格式),且测于 ${surface.gitHead.slice(0, 8)},与本次 HEAD 不同` }
	}
	return { stale: true, how: '产物没有输入指纹(旧格式),无法判断它测的是不是当前这棵树' }
}

/**
 * 依赖面体检:实测需要的包,从消费者角度能不能解析。
 *
 * 两条本轮补上的约束,都是踩过的坑:
 *
 * 1. **宿主环境集成要豁免。** 有些说明符在干净依赖树里解析不到是**预期**
 *    (swarm 在真实宿主上是同级插件,不是本仓的包依赖),它们在
 *    `host-integrations.json` 里逐条声明并被独立核验过降级路径。这里不豁免的话,
 *    预检会把「按设计优雅降级、实跑 exit 0」的套件判成缺依赖失败 —— 假红。
 *    豁免不等于不提:被豁免的说明符照样按名字打进输出,不许悄悄消失。
 *
 * 2. **陈旧的产物不许冒充当前树的结论。** 这份 JSON 是离线测出来的快照。本轮实测:
 *    一份 2026-09-08 测的产物(比 swarm 解耦还早、只认识 69 个套件、通篇没有 swarm)
 *    让预检报了「无缺失」—— 它描述的是一棵已经不存在的树,而输出看起来和真体检过一样。
 *
 *    判新旧按**内容**(inputsDigest),不按 gitHead:产物自己要被提交,一提交 HEAD 就变,
 *    按 HEAD 判的结果只会是「永远陈旧」—— 那等于把这层预检永久关掉,比不加还糟。
 *    内容指纹覆盖产物真正依赖的文件(各插件 test/ 与 lib/、宿主依赖树 package.json),
 *    一个字没改就仍然算数,提交多少次都不影响。
 *
 *    陈旧时不硬失败(它可能只是没重测),但**降级为参考**:不再据此判任何套件失败,
 *    并写明权威判定在 host-modules-check(完整静态导入图)那一闸。
 */
function preflight() {
	const surfaceFile = surfaceOverride ? resolve(surfaceOverride) : join(HERE, 'dependency-surface.json')
	if (!existsSync(surfaceFile)) return { available: false, surfaceFile, note: 'dependency-surface.json 不存在(先跑 measure-dependency-surface.mjs);不做包级预检', blockedPlugins: {} }
	const surface = JSON.parse(readFileSync(surfaceFile, 'utf8'))

	// 清单:读不了就当没有豁免(更严),不静默放行 —— 真正的 fail-closed 由
	// host-modules-check 那一闸负责,那里清单缺失/损坏是硬退 2。
	let exempt = new Set()
	let exemptNote = null
	try {
		const manifestFile = hostIntegrationsOverride ? resolve(hostIntegrationsOverride) : join(HERE, 'host-integrations.json')
		const manifest = loadHostIntegrations({ file: manifestFile, repoRoot: REPO_ROOT })
		exempt = new Set(manifest.integrations.map((entry) => entry.specifier))
	} catch (err) {
		exemptNote = `宿主集成清单不可用(${err.message.split('\n')[0]});本次不豁免任何说明符`
	}

	const { stale, how: staleHow } = surfaceStaleness(surface)

	const need = surface.summary?.externalToSuites ?? {}
	const blockedPlugins = {}
	const exempted = new Set()
	const resolved = []
	for (const [pkg, suiteIds] of Object.entries(need)) {
		for (const suiteId of suiteIds) {
			const plugin = suiteId.split('/')[0]
			let dir = join(REPO_ROOT, 'plugins', plugin, 'lib')
			if (!existsSync(dir)) dir = join(REPO_ROOT, 'plugins', plugin)
			let found = null
			let d = dir
			for (;;) {
				const cand = join(d, 'node_modules', pkg, 'package.json')
				if (existsSync(cand)) { found = relative(REPO_ROOT, join(d, 'node_modules', pkg)); break }
				const up = dirname(d)
				if (up === d) break
				d = up
			}
			if (found) resolved.push({ package: pkg, plugin, at: found })
			else if (exempt.has(pkg)) exempted.add(pkg)
			else (blockedPlugins[plugin] ??= new Set()).add(pkg)
		}
	}
	return {
		available: true,
		surfaceFile: relative(REPO_ROOT, surfaceFile),
		measuredAt: surface.generatedAt,
		measuredAtHead: surface.gitHead ?? null,
		stale,
		staleHow,
		exemptNote,
		exempted: [...exempted].sort(),
		resolved: [...new Map(resolved.map((r) => [`${r.plugin}|${r.package}`, r])).values()],
		// 陈旧的快照不据以判任何套件失败:它描述的可能是另一棵树。
		blockedPlugins: stale ? {} : Object.fromEntries(Object.entries(blockedPlugins).map(([k, v]) => [k, [...v].sort()])),
		staleBlocked: stale ? Object.fromEntries(Object.entries(blockedPlugins).map(([k, v]) => [k, [...v].sort()])) : {},
		hostPathSuites: surface.summary?.suitesRequiringHostPaths ?? [],
	}
}

const pre = preflight()
const env = neutralEnv()

console.log('== AgOS 离线验收(代码闸 / 部署漂移 分离)==')
console.log(`   repo: ${REPO_ROOT}`)
console.log(`   node: ${process.version}   日志: ${logDir}`)
console.log(`   语料: SESSION_MEMORY_CORPUS_DIR=${env.SESSION_MEMORY_CORPUS_DIR}(不存在 → 私有语料测试自报 skip)`)
console.log(`   供应商密钥: 已从子进程环境剔除(Z_AI_API_KEY/GLM_API_KEY/OPENAI_API_KEY/ANTHROPIC_API_KEY)`)
console.log(`   Fleet 历史: DSH_FLEET_RUNS_FILE=${env.DSH_FLEET_RUNS_FILE}(不存在 → 不读操作者真实批次历史)`)
if (pre.available) {
	const blocked = Object.keys(pre.blockedPlugins)
	console.log(`   依赖面预检: ${pre.resolved.length} 个 (插件,包) 对可解析;${blocked.length ? `❌ 缺依赖的插件: ${blocked.join(', ')}` : '无缺失'}`)
	if (pre.stale) {
		console.log(`   ⚠️  依赖面产物已陈旧(${pre.staleHow})—— 它描述的可能是另一棵树,`)
		console.log(`      故本次**不据此判任何套件失败**;权威判定见 host-modules-check(完整静态导入图)那一闸。`)
		const wouldBlock = Object.keys(pre.staleBlocked)
		if (wouldBlock.length) console.log(`      (若按这份陈旧快照,会被判缺依赖的是: ${wouldBlock.join(', ')} —— 仅供参考)`)
		console.log(`      重新测量: node scripts/acceptance/measure-dependency-surface.mjs`)
	}
	if (pre.exempted.length) {
		console.log(`   宿主环境集成(清单已声明,干净树里解析不到属预期,不判失败): ${pre.exempted.join(', ')}`)
	}
	if (pre.exemptNote) console.log(`   ⚠️  ${pre.exemptNote}`)
	if (pre.hostPathSuites.length) console.log(`   ⚠️  依赖 ~/.dsh 绝对路径的套件(装包解决不了): ${pre.hostPathSuites.join(', ')}`)
} else {
	console.log(`   依赖面预检: ${pre.note}`)
}
console.log(`   计数下限基线: ${FLOORS_DISABLED
	? '⚠️  已用 --floors=none 显式关闭 —— 本次运行不设下限,删测试抓不到'
	: `${Object.keys(FLOORS).length} 个闸有下限(抓删测试;缺基线文件/空基线/坏 JSON 都 fail-closed 退 78)`}`)
console.log(`   自检闸: ${selftestSuppressed
	? `⚠️  已被防递归哨兵 ${SELFTEST_SENTINEL}=1 排除 —— 本进程是自检自己 spawn 的子进程,不能再把自检放进计划`
	: plan.codeGates.some((g) => g.id === 'selftest') ? '在计划里(node --test scripts/acceptance/selftest.mjs)' : '不在计划里(自定义 --plan)'}`)
if (SYNTHETIC) {
	console.log('   ⚠️  合成运行:必需套件清单/根/自检文件被 --required-plugins / --plugins-root / --selftest-file 覆盖。')
	console.log('       本次结果 authoritative=false,不代表真实仓库状态;宿主依赖体检已跳过。')
}
console.log('')

function runGate(gate, channel) {
	const cwd = resolve(REPO_ROOT, gate.cwd)
	const logPath = join(logDir, `${gate.id}.txt`)
	const plugin = gate.plugin ?? (gate.cwd.startsWith('plugins/') ? gate.cwd.slice('plugins/'.length) : null)

	// 结构性失败:必需的东西压根不在,没有子进程可跑,但必须留下一条显式失败(不许从计划里消失)。
	if (gate.kind === 'structural') {
		const msg = [`structural-failure: ${gate.id}: ${gate.reason}`, `  ${gate.detail ?? ''}`].join('\n')
		mkdirSync(dirname(logPath), { recursive: true })
		writeFileSync(logPath, msg + '\n')
		console.log(`▸ ${gate.id}: ❌ FAIL (${gate.reason})`)
		console.log(`     原因: ${gate.detail ?? gate.reason}`)
		return {
			id: gate.id, channel, cwd: gate.cwd, argv: gate.argv, exitCode: 78, durationSeconds: 0,
			counts: null, verdict: 'fail', reason: gate.reason, structural: true,
			missingModules: [], required: gate.required !== false,
			log: relative(REPO_ROOT, logPath), logSha256: sha256(msg + '\n'), summary: [msg],
		}
	}

	// 预检拦截:实测需要的包缺了 → 直接判失败并说清缺什么,绝不跑成"跳过"。
	const missingForPlugin = plugin && pre.blockedPlugins[plugin] ? pre.blockedPlugins[plugin] : null
	if (channel === 'code' && missingForPlugin) {
		const msg = [
			`missing-host-modules: ${gate.id} 需要的宿主包解析不到:${missingForPlugin.join(', ')}`,
			`  这是**失败**,不是跳过。修:node scripts/acceptance/prepare-host-modules.mjs`,
		].join('\n')
		mkdirSync(dirname(logPath), { recursive: true })
		writeFileSync(logPath, msg + '\n')
		console.log(`▸ ${gate.id}: ❌ FAIL (missing-host-modules: ${missingForPlugin.join(', ')})`)
		return {
			id: gate.id, channel, cwd: gate.cwd, argv: gate.argv, exitCode: 78, durationSeconds: 0,
			counts: null, verdict: 'fail', reason: `missing-host-modules:${missingForPlugin.join(',')}`,
			missingModules: missingForPlugin, required: gate.required !== false,
			log: relative(REPO_ROOT, logPath), logSha256: sha256(msg + '\n'), summary: [msg],
		}
	}

	const timeoutMs = gate.timeoutMs ?? 900000
	const r = runCommand({ argv: gate.argv, cwd, env, logPath, timeoutMs })
	const counts = gate.kind === 'node-test' ? parseNodeTestCounts(r.output) : null
	const v = gate.kind === 'node-test'
		? verdictOf({ exitCode: r.exitCode, counts, spawnError: r.spawnError, minTests: gate.minTests ?? null, minPass: gate.minPass ?? null })
		: { verdict: r.exitCode === 0 ? 'pass' : 'fail', reason: r.exitCode === 0 ? 'ok' : `nonzero-exit:${r.exitCode}` }

	// 超时必须**看得出来是超时**。spawnSync 到点发 SIGTERM,而 node --test 会接住信号、
	// 自己退 1 —— 于是 res.status 是 1、res.signal 是 null,超时长得和一次普通失败一模一样
	// (实测:dsh-fleet 跑 900.02s 后报 `exit 1`,reason 只写 nonzero-exit:1)。
	// 判定不变(超时就是失败,绝不放绿、绝不提高超时),但诊断要说实话:被砍了 ≠ 断言失败。
	if (r.durationSeconds * 1000 >= timeoutMs - 100) {
		v.reason = `timeout-after:${timeoutMs}ms (真实退出码 ${r.exitCode};子进程可能把 SIGTERM 转成了普通退出码,别把它读成断言失败)`
		if (v.verdict === 'pass') v.verdict = 'fail'   // 恰好在超时点退 0 也不算过
	}
	const timedOut = r.durationSeconds * 1000 >= timeoutMs - 100
	const summary = r.output.split('\n').filter((l) => /^(?:ℹ|info)\s+(tests|pass|fail|cancelled|skipped|todo)\s+\d+|零漂移|漂移 \d+|verified:|✅|⚠️|❌/.test(l.trim())).slice(0, 40)

	const label = channel === 'advisory' ? 'ADVISORY' : v.verdict.toUpperCase()
	const icon = channel === 'advisory' ? 'ℹ️ ' : isGreen(v.verdict) ? '✅' : '❌'
	const countStr = counts ? ` pass ${counts.pass} / fail ${counts.fail} / skip ${counts.skipped} (tests ${counts.tests})` : ''
	console.log(`▸ ${gate.id}: ${icon} ${label} exit ${r.exitCode}${countStr}  ${r.durationSeconds}s`)
	if (channel === 'code' && !isGreen(v.verdict)) console.log(`     原因: ${v.reason}`)
	if (channel === 'advisory') console.log(`     ${gate.note ?? ''}  ← 不参与退出码,也不被吞`)

	return {
		id: gate.id, channel, cwd: gate.cwd, argv: gate.argv, exitCode: r.exitCode,
		durationSeconds: r.durationSeconds, timeoutMs, timedOut, counts, verdict: v.verdict, reason: v.reason,
		missingModules: detectMissingModules(r.output), required: gate.required !== false,
		log: relative(REPO_ROOT, logPath), logSha256: sha256(readFileSync(logPath)), summary,
		note: gate.note ?? null,
	}
}

const codeResults = plan.codeGates.map((g) => runGate(g, 'code'))
const advisoryResults = (plan.advisory ?? []).map((g) => runGate(g, 'advisory'))

// ---- 汇总:pass/fail/skip 三个数各自独立,skip 永不并入 pass ----
const totals = { tests: 0, pass: 0, fail: 0, skipped: 0, cancelled: 0 }
for (const r of codeResults) {
	if (!r.counts) continue
	totals.tests += r.counts.tests
	totals.pass += r.counts.pass
	totals.fail += r.counts.fail
	totals.skipped += r.counts.skipped
	totals.cancelled += r.counts.cancelled
}
const failedGates = codeResults.filter((r) => r.required && !isGreen(r.verdict))
const codeGateExit = failedGates.length === 0 ? 0 : 1

const out = {
	schema: 'agos-acceptance/results@1',
	generatedAt: new Date().toISOString(),
	repoRoot: REPO_ROOT,
	gitHead: runCommand({ argv: ['git', 'rev-parse', 'HEAD'], cwd: REPO_ROOT, timeoutMs: 20000 }).output.trim(),
	gitDirty: runCommand({ argv: ['git', 'status', '--porcelain'], cwd: REPO_ROOT, timeoutMs: 20000 }).output.trim().split('\n').filter(Boolean).length,
	// 合成接缝一旦用过,本次结果就不代表真实仓库状态。这个事实必须在 JSON 里,不能只在终端。
	authoritative: !SYNTHETIC,
	syntheticSeams: SYNTHETIC ? { requiredPlugins: pluginsOverride, pluginsRoot: pluginsRootOverride, selftestFile: selftestFileOverride } : null,
	requiredPlugins: PLUGINS,
	recursionGuard: {
		sentinel: SELFTEST_SENTINEL,
		active: selftestSuppressed,
		selftestGateIncluded: plan.codeGates.some((g) => g.id === 'selftest'),
		note: '自检 spawn 验收器时置哨兵=1,验收器据此不把自检放进计划。排除自检这件事不静默:见 active 字段。',
	},
	environment: {
		node: process.version, platform: process.platform,
		corpusDir: env.SESSION_MEMORY_CORPUS_DIR,
		corpusDirExists: existsSync(env.SESSION_MEMORY_CORPUS_DIR),
		providerKeysCleared: ['Z_AI_API_KEY', 'GLM_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY'],
		// 嵌套 node --test 卫生:验收器**自己**是否被 node --test 的上下文污染。
		// 自检是 `node --test` 跑的、又要 spawn 验收器,若把 NODE_TEST_CONTEXT 传下来,
		// 孙子进程的 node --test 会"skipping running files"、一个测试不跑却退 0 —— 最危险的假绿。
		// lib/exec.mjs neutralEnv 会为**子进程**剔除它;这两个字段记录**本进程**收到了什么,
		// 让自检能钉住「spawn 验收器时也已经清干净」。
		nodeTestContext: process.env.NODE_TEST_CONTEXT ?? null,
		nodeOptions: process.env.NODE_OPTIONS ?? null,
	},
	preflight: pre,
	codeGate: {
		exitCode: codeGateExit,
		green: codeGateExit === 0,
		totals,
		failedGates: failedGates.map((r) => ({ id: r.id, verdict: r.verdict, reason: r.reason, exitCode: r.exitCode })),
		suites: codeResults,
	},
	advisory: {
		note: '部署漂移等环境事实。真实退出码保留在下面,但**不参与**进程退出码。',
		results: advisoryResults,
	},
	processExitCode: codeGateExit,
}

console.log('')
console.log('== 汇总 ==')
console.log(`   代码闸: ${codeGateExit === 0 ? '✅ 绿' : `❌ 红(${failedGates.length} 个套件不过)`}`)
console.log(`   测试计数: pass ${totals.pass} / fail ${totals.fail} / skip ${totals.skipped}  (tests ${totals.tests})   ← skip 单列,不并入 pass`)
for (const r of failedGates) console.log(`     ❌ ${r.id}: ${r.verdict} (${r.reason})`)
for (const r of advisoryResults) console.log(`   ADVISORY ${r.id}: exit ${r.exitCode} —— 已记录,不影响代码闸`)
console.log(`   进程退出码 = 代码闸 = ${codeGateExit}`)

// --write-floors:只允许从**全绿**的一次运行生成计数下限,绝不把红的状态写成基线。
const writeFloors = opt('write-floors', null)
if (writeFloors) {
	if (codeGateExit !== 0) {
		console.error('   ❌ --write-floors 拒绝执行:本次运行不是全绿,不能把红状态固化成基线。')
		process.exit(codeGateExit)
	}
	// 合成运行是绿的没有任何意义:一棵 /tmp 里的假套件树也能全绿,而它写出的基线只含假套件,
	// 等于把真基线换成一份不设防的清单。可测性接缝不许变成"洗基线"的通道。
	if (SYNTHETIC) {
		console.error('   ❌ --write-floors 拒绝执行:本次是合成运行(用了 --required-plugins/--plugins-root/--selftest-file/--surface)。')
		console.error('      合成套件树全绿不代表任何东西,用它写基线等于把真基线换成一份不设防的清单。')
		process.exit(78)
	}
	const floors = {}
	for (const r of codeResults) {
		if (!r.counts) continue
		floors[r.id] = { minTests: r.counts.tests, minPass: r.counts.pass }
	}
	const fp = resolve(writeFloors)
	mkdirSync(dirname(fp), { recursive: true })
	writeFileSync(fp, JSON.stringify({
		schema: 'agos-acceptance/expected-counts@1',
		note: '计数下限基线:抓"删测试/清空测试文件把闸弄绿"。只从全绿运行生成。并发新增测试后应由 controller 重新生成。',
		generatedAt: new Date().toISOString(),
		gitHead: out.gitHead,
		gitDirtyFiles: out.gitDirty,
		floors,
	}, null, 2) + '\n')
	console.log(`   计数下限基线已写入: ${fp.startsWith(REPO_ROOT) ? relative(REPO_ROOT, fp) : fp}`)
}

if (jsonOut) {
	const p = resolve(jsonOut)
	mkdirSync(dirname(p), { recursive: true })
	writeFileSync(p, JSON.stringify(out, null, 2) + '\n')
	console.log(`   JSON: ${p.startsWith(REPO_ROOT) ? relative(REPO_ROOT, p) : p}`)
}
process.exit(codeGateExit)
