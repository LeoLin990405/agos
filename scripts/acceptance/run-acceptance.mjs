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
//   node scripts/acceptance/run-acceptance.mjs                       # 插件代码闸 + 漂移(advisory)
//   node scripts/acceptance/run-acceptance.mjs --with-frontend       # 加上 frontend npm run verify
//   node scripts/acceptance/run-acceptance.mjs --plan=<file.json>    # 自定义计划(A4 自检用)
//   node scripts/acceptance/run-acceptance.mjs --no-advisory         # 不跑漂移检查
//   node scripts/acceptance/run-acceptance.mjs --json=<out> --logdir=<dir>
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, relative, resolve, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { REPO_ROOT, runCommand, parseNodeTestCounts, detectMissingModules, neutralEnv, verdictOf, isGreen, sha256 } from './lib/exec.mjs'

const HERE = dirname(new URL(import.meta.url).pathname)
const PLUGINS = ['dsh-agos', 'dsh-agos-router', 'dsh-mcp-bridge', 'cn-capabilities', 'dsh-fleet']

const args = process.argv.slice(2)
const flag = (n) => args.includes(`--${n}`)
const opt = (n, d) => { const h = args.find((a) => a.startsWith(`--${n}=`)); return h ? h.slice(n.length + 3) : d }
const planPath = opt('plan', null)
const withFrontend = flag('with-frontend')
const noAdvisory = flag('no-advisory')
const logDir = resolve(opt('logdir', join(tmpdir(), 'agos-acceptance-logs')))
const jsonOut = opt('json', null)
const surfaceOverride = opt('surface', null)   // A4 自检注入合成依赖面用
const floorsPath = opt('floors', join(HERE, 'expected-counts.json'))
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
 */
const FLOORS_DISABLED = floorsPath === 'none'
let FLOORS = {}
if (!FLOORS_DISABLED) {
	const fp = resolve(floorsPath)
	if (!existsSync(fp)) {
		console.error('❌ 计数下限基线缺失,拒绝运行(fail-closed)。')
		console.error(`   期望文件: ${fp.startsWith(REPO_ROOT) ? relative(REPO_ROOT, fp) : fp}`)
		console.error('   这道门抓的是「删测试/清空测试文件把闸弄绿」。基线缺席时它抓不到任何东西,')
		console.error('   而缺席本身就是绕过它的手段,所以不能静默降级成告警。')
		console.error('   重建(只能从全绿运行生成): node scripts/acceptance/run-acceptance.mjs --floors=none --write-floors=scripts/acceptance/expected-counts.json')
		console.error('   明知无基线仍要跑(首次引导/临时诊断): 加 --floors=none')
		process.exit(78)
	}
	FLOORS = JSON.parse(readFileSync(fp, 'utf8')).floors ?? {}
}

/** 默认计划:与 scripts/test-all.sh 同一个 glob(test/*.mjs),保证闸的范围一致。 */
function defaultPlan() {
	const codeGates = []
	for (const p of PLUGINS) {
		const dir = join(REPO_ROOT, 'plugins', p, 'test')
		if (!existsSync(dir)) continue
		const files = readdirSync(dir).filter((f) => f.endsWith('.mjs')).sort()
		if (files.length === 0) continue
		const floor = FLOORS[p] ?? {}
		codeGates.push({ id: p, cwd: `plugins/${p}`, argv: ['node', '--test', ...files.map((f) => join('test', f))], kind: 'node-test', required: true, minTests: floor.minTests ?? null, minPass: floor.minPass ?? null })
	}
	if (withFrontend) {
		const floor = FLOORS['frontend-verify'] ?? {}
		codeGates.push({ id: 'frontend-verify', cwd: 'frontend', argv: ['npm', 'run', 'verify'], kind: 'node-test', required: true, minTests: floor.minTests ?? null, minPass: floor.minPass ?? null })
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

const plan = planPath ? JSON.parse(readFileSync(resolve(planPath), 'utf8')) : defaultPlan()

/** 依赖面体检:实测需要的包,从消费者角度能不能解析。 */
function preflight() {
	const surfaceFile = surfaceOverride ? resolve(surfaceOverride) : join(HERE, 'dependency-surface.json')
	if (!existsSync(surfaceFile)) return { available: false, surfaceFile, note: 'dependency-surface.json 不存在(先跑 measure-dependency-surface.mjs);不做包级预检', blockedPlugins: {} }
	const surface = JSON.parse(readFileSync(surfaceFile, 'utf8'))
	const need = surface.summary?.externalToSuites ?? {}
	const blockedPlugins = {}
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
			if (found) { resolved.push({ package: pkg, plugin, at: found }) } else { (blockedPlugins[plugin] ??= new Set()).add(pkg) }
		}
	}
	return {
		available: true,
		surfaceFile: relative(REPO_ROOT, surfaceFile),
		measuredAt: surface.generatedAt,
		resolved: [...new Map(resolved.map((r) => [`${r.plugin}|${r.package}`, r])).values()],
		blockedPlugins: Object.fromEntries(Object.entries(blockedPlugins).map(([k, v]) => [k, [...v].sort()])),
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
	if (pre.hostPathSuites.length) console.log(`   ⚠️  依赖 ~/.dsh 绝对路径的套件(装包解决不了): ${pre.hostPathSuites.join(', ')}`)
} else {
	console.log(`   依赖面预检: ${pre.note}`)
}
console.log(`   计数下限基线: ${FLOORS_DISABLED
	? '⚠️  已用 --floors=none 显式关闭 —— 本次运行不设下限,删测试抓不到'
	: `${Object.keys(FLOORS).length} 个闸有下限(抓删测试;缺基线文件会 fail-closed 退 78)`}`)
console.log('')

function runGate(gate, channel) {
	const cwd = resolve(REPO_ROOT, gate.cwd)
	const logPath = join(logDir, `${gate.id}.txt`)
	const plugin = gate.cwd.startsWith('plugins/') ? gate.cwd.slice('plugins/'.length) : null

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

	const r = runCommand({ argv: gate.argv, cwd, env, logPath, timeoutMs: gate.timeoutMs ?? 900000 })
	const counts = gate.kind === 'node-test' ? parseNodeTestCounts(r.output) : null
	const v = gate.kind === 'node-test'
		? verdictOf({ exitCode: r.exitCode, counts, spawnError: r.spawnError, minTests: gate.minTests ?? null, minPass: gate.minPass ?? null })
		: { verdict: r.exitCode === 0 ? 'pass' : 'fail', reason: r.exitCode === 0 ? 'ok' : `nonzero-exit:${r.exitCode}` }
	const summary = r.output.split('\n').filter((l) => /^(?:ℹ|info)\s+(tests|pass|fail|cancelled|skipped|todo)\s+\d+|零漂移|漂移 \d+|verified:|✅|⚠️|❌/.test(l.trim())).slice(0, 40)

	const label = channel === 'advisory' ? 'ADVISORY' : v.verdict.toUpperCase()
	const icon = channel === 'advisory' ? 'ℹ️ ' : isGreen(v.verdict) ? '✅' : '❌'
	const countStr = counts ? ` pass ${counts.pass} / fail ${counts.fail} / skip ${counts.skipped} (tests ${counts.tests})` : ''
	console.log(`▸ ${gate.id}: ${icon} ${label} exit ${r.exitCode}${countStr}  ${r.durationSeconds}s`)
	if (channel === 'code' && !isGreen(v.verdict)) console.log(`     原因: ${v.reason}`)
	if (channel === 'advisory') console.log(`     ${gate.note ?? ''}  ← 不参与退出码,也不被吞`)

	return {
		id: gate.id, channel, cwd: gate.cwd, argv: gate.argv, exitCode: r.exitCode,
		durationSeconds: r.durationSeconds, counts, verdict: v.verdict, reason: v.reason,
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
	environment: {
		node: process.version, platform: process.platform,
		corpusDir: env.SESSION_MEMORY_CORPUS_DIR,
		corpusDirExists: existsSync(env.SESSION_MEMORY_CORPUS_DIR),
		providerKeysCleared: ['Z_AI_API_KEY', 'GLM_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY'],
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
