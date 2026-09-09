#!/usr/bin/env node
// A1:实测每个插件测试套件的真实依赖面,不靠猜。
//
// ⚠️ 这份产物**不能**用来证明「依赖面完整」(R3 降级说明,原为 P1 缺陷)。
//
// 原因是方法本身的:本脚本靠**运行时观测** —— 跑 node --test,看它报哪个包找不到。
// 而 Node 遇到模块图里**第一个**未解析说明符就抛 ERR_MODULE_NOT_FOUND 退出,
// 后面的说明符压根没被求值过。所以每个套件每轮只暴露**一个**缺包:
// dsh-fleet 因此只留下 @deepseek-ai/schemastery 一条记录,而它在模块层还需要
// dsh-tools、dsh-llm 等(实测:静态全图 8 个包,本方法只观测到 2 个)。
// 后果:曾让 prepare-host-modules.mjs --check 在「套件其实都加载不了」的机器上
// 报「依赖面就绪」并 exit 0(HANDOFF.md:169/176 已记录,本轮已修)。
//
// 权威的完整依赖面改由**静态导入图**给出:
//   scripts/acceptance/lib/import-graph.mjs + prepare-host-modules.mjs --check
// 从各插件入口递归跟随相对导入,一次拿到全部裸说明符,不需要「跑一次修一个」的迭代。
//
// 本脚本仍然有独立价值,但价值不在「列全依赖」:
//   · 它区分「缺包」与「依赖 ~/.dsh 下的绝对路径」—— 后者装包解决不了,静态图看不出来;
//   · 它给出每个套件在真实环境里的**通过/失败**事实与日志;
//   · 它用 Seatbelt 拒读来模拟缺失,非破坏性,不动其他实现者的依赖树。
// 换句话说:本脚本能**证伪**(某套件确实跑不起来),不能**证全**(依赖就这些)。
//
// 两种模式各跑一遍每个套件文件:
//   natural  —— 仓里零 node_modules(当前真实状态),宿主 profile 可读
//   shielded —— 同上,外加 macOS Seatbelt 拒读/拒写 ~/.dsh
//
// 两模式之差就是"这个套件到底要不要宿主的东西":
//   hermetic     两模式都过 → 仓内自足,零外部依赖
//   host-path    natural 过、shielded 挂 → 依赖 ~/.dsh 下的**绝对路径**(node_modules 解析给不了)
//   host-modules natural 就挂在 MODULE_NOT_FOUND → 需要具体的裸包
//   broken       别的原因挂
//
// 用法:node scripts/acceptance/measure-dependency-surface.mjs [--out=<file>] [--plugin=<name>] [--no-shield]
import { writeFileSync, mkdirSync, existsSync, readdirSync, lstatSync, readlinkSync } from 'node:fs'
import { surfaceInputsDigest } from './lib/surface-inputs.mjs'
import { join, relative, dirname } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { REPO_ROOT, runCommand, parseNodeTestCounts, detectMissingModules, neutralEnv, verdictOf } from './lib/exec.mjs'

const PLUGINS = ['dsh-agos', 'dsh-agos-router', 'dsh-mcp-bridge', 'cn-capabilities', 'dsh-fleet']

const DSH_HOME = join(process.env.HOME ?? '/nonexistent', '.dsh')
// 三张 Seatbelt 画像。关键点:插件树里可能**已经**被别的实现者装好了 node_modules,
// 所以"零 node_modules"不能靠删目录来测(那会毁掉别人的工作),只能靠拒读来测。
const SB = {
	'no-dsh': join(tmpdir(), 'agos-acceptance-sb-no-dsh.sb'),
	'no-host-modules': join(tmpdir(), 'agos-acceptance-sb-no-host-modules.sb'),
	// 方法自身的对照组:一条限制都不加的沙箱。
	// 有些套件自己就要起 Seatbelt(cn-capabilities 的 autoresearch 验证器),
	// 套在另一个沙箱里必然坏 —— 那是**测量伪影**,不是真依赖。
	// 只要"零限制沙箱"下也挂,本方法对该套件的结论就不可信,必须如实标出来。
	permissive: join(tmpdir(), 'agos-acceptance-sb-permissive.sb'),
}

const args = process.argv.slice(2)
const opt = (name, dflt) => {
	const hit = args.find((a) => a.startsWith(`--${name}=`))
	return hit ? hit.slice(name.length + 3) : dflt
}
const outPath = opt('out', join(REPO_ROOT, 'scripts/acceptance/dependency-surface.json'))
const onlyPlugin = opt('plugin', null)
const useShield = !args.includes('--no-shield')
const logDir = opt('logdir', join(tmpdir(), 'agos-acceptance-surface-logs'))

/** 仓内所有 node_modules 目录(拒读它们 = 模拟"零 node_modules",且不动任何人的文件)。 */
function repoNodeModulesPaths() {
	const out = []
	for (const rel of ['node_modules', 'plugins/node_modules', ...['dsh-agos', 'dsh-agos-router', 'dsh-mcp-bridge', 'cn-capabilities', 'dsh-fleet'].map((p) => `plugins/${p}/node_modules`)]) {
		out.push(join(REPO_ROOT, rel))
	}
	return out
}

/** 写两张画像:no-dsh 只挡宿主 profile;no-host-modules 连仓内 node_modules 一起挡。 */
function writeShieldProfiles() {
	const denyDsh = [
		`(deny file-read* (subpath ${JSON.stringify(DSH_HOME)}))`,
		`(deny file-write* (subpath ${JSON.stringify(DSH_HOME)}))`,
	]
	const denyNm = repoNodeModulesPaths().map((p) => `(deny file-read* (subpath ${JSON.stringify(p)}))`)
	mkdirSync(dirname(SB['no-dsh']), { recursive: true })
	writeFileSync(SB['no-dsh'], ['(version 1)', '(allow default)', ...denyDsh, ''].join('\n'))
	writeFileSync(SB['no-host-modules'], ['(version 1)', '(allow default)', ...denyDsh, ...denyNm, ''].join('\n'))
	writeFileSync(SB.permissive, ['(version 1)', '(allow default)', ''].join('\n'))
}

function shieldAvailable() {
	if (!useShield) return false
	if (!existsSync('/usr/bin/sandbox-exec')) return false
	writeShieldProfiles()
	for (const f of Object.values(SB)) {
		const probe = runCommand({ argv: ['/usr/bin/sandbox-exec', '-f', f, '/usr/bin/true'], cwd: REPO_ROOT, timeoutMs: 20000 })
		if (probe.exitCode !== 0) return false
	}
	return true
}

function nodeModulesState() {
	const out = {}
	for (const p of ['node_modules', 'plugins/node_modules', 'frontend/node_modules']) {
		const abs = join(REPO_ROOT, p)
		if (!existsSync(abs)) { out[p] = 'absent'; continue }
		const st = lstatSync(abs)
		out[p] = st.isSymbolicLink() ? `symlink -> ${readlinkSync(abs)}` : 'real-directory'
	}
	return out
}

function suiteFiles(plugin) {
	const dir = join(REPO_ROOT, 'plugins', plugin, 'test')
	if (!existsSync(dir)) return []
	// 与 scripts/test-all.sh 同一个 glob:test/*.mjs(含非 .test.mjs 的 bench)
	return readdirSync(dir).filter((f) => f.endsWith('.mjs')).sort()
}

function measure(plugin, file, mode) {
	const cwd = join(REPO_ROOT, 'plugins', plugin)
	const base = ['node', '--test', join('test', file)]
	const argv = mode === 'natural' ? base : ['/usr/bin/sandbox-exec', '-f', SB[mode], ...base]
	const logPath = join(logDir, mode, plugin, `${file}.txt`)
	const r = runCommand({ argv, cwd, env: neutralEnv(), logPath, timeoutMs: 240000 })
	const counts = parseNodeTestCounts(r.output)
	const v = verdictOf({ exitCode: r.exitCode, counts, spawnError: r.spawnError })
	return {
		mode,
		argv,
		exitCode: r.exitCode,
		durationSeconds: r.durationSeconds,
		counts,
		verdict: v.verdict,
		reason: v.reason,
		missingModules: detectMissingModules(r.output),
		log: relative(REPO_ROOT, logPath),
		errorExcerpt: v.verdict === 'pass' ? null : excerpt(r.output),
	}
}

function excerpt(text) {
	const lines = text.split('\n')
	const interesting = lines.filter((l) =>
		/Cannot find (package|module)|ERR_MODULE_NOT_FOUND|not permitted|EPERM|Error:|✖|deny/.test(l))
	const pick = (interesting.length ? interesting : lines.filter((l) => l.trim() !== '')).slice(0, 6)
	return pick.map((l) => l.slice(0, 300))
}

function classify(natural, noDsh, noHostModules, permissive) {
	if (natural.verdict !== 'pass') return natural.missingModules.length > 0 ? 'host-modules' : 'broken'
	if (!noDsh || !noHostModules) return 'hermetic-unshielded'   // 盾不可用,只知道 natural 过
	if (noHostModules.verdict === 'pass') return 'hermetic'      // 连 node_modules 都不用
	// 走到这里说明"加了盾就挂"。先排除伪影:零限制沙箱下也挂 → 本方法测不了这个套件。
	if (permissive && permissive.verdict !== 'pass') return 'sandbox-incompatible'
	if (noDsh.verdict !== 'pass') return 'host-path'             // 装包解决不了:依赖 ~/.dsh
	return 'host-modules'                                        // 要 node_modules 里的宿主包
}

const shieldPath = shieldAvailable() ? SB : null
if (useShield && !shieldPath) {
	console.error('⚠️  Seatbelt 不可用:只跑 natural 模式,host-path 类无法区分(会标 hermetic-unshielded)')
}

const suites = []
const plugins = onlyPlugin ? [onlyPlugin] : PLUGINS
for (const plugin of plugins) {
	for (const file of suiteFiles(plugin)) {
		const id = `${plugin}/${file}`
		process.stderr.write(`… ${id} `)
		const natural = measure(plugin, file, 'natural')
		const noDsh = shieldPath ? measure(plugin, file, 'no-dsh') : null
		const noHostModules = shieldPath ? measure(plugin, file, 'no-host-modules') : null
		// 只对"natural 过、加盾挂"的套件跑对照组(便宜,且只有这些套件的结论需要担保)
		const needsControl = shieldPath && natural.verdict === 'pass'
			&& (noDsh?.verdict !== 'pass' || noHostModules?.verdict !== 'pass')
		const permissive = needsControl ? measure(plugin, file, 'permissive') : null
		const cls = classify(natural, noDsh, noHostModules, permissive)
		// 缺哪些裸包:以"拒读 node_modules"那一轮的报错为准(那才是"零依赖树"下的真实缺口)
		const externals = [...new Set([...(noHostModules?.missingModules ?? []), ...natural.missingModules])].sort()
		process.stderr.write(`${cls} (natural ${natural.exitCode}${noDsh ? ` / no-dsh ${noDsh.exitCode}` : ''}${noHostModules ? ` / no-host-modules ${noHostModules.exitCode}` : ''})\n`)
		suites.push({
			id,
			plugin,
			file: `test/${file}`,
			cwd: `plugins/${plugin}`,
			classification: cls,
			requiredExternals: cls === 'hermetic' ? [] : externals,
			hostPathDependency: cls === 'host-path',
			modes: { natural, 'no-dsh': noDsh, 'no-host-modules': noHostModules, permissive },
			methodCaveat: cls === 'sandbox-incompatible'
				? 'This suite launches its own macOS Seatbelt sandbox, so it also fails under a zero-denial outer sandbox. The shield cannot measure it; treat its dependency surface as UNVERIFIED by this method and read the natural-mode result only.'
				: null,
		})
	}
}

const byClass = {}
for (const s of suites) (byClass[s.classification] ??= []).push(s.id)

const externals = {}
for (const s of suites) for (const m of s.requiredExternals) (externals[m] ??= []).push(s.id)

const manifest = {
	schema: 'agos-acceptance/dependency-surface@1',
	generatedAt: new Date().toISOString(),
	repoRoot: REPO_ROOT,
	gitHead: runCommand({ argv: ['git', 'rev-parse', 'HEAD'], cwd: REPO_ROOT, timeoutMs: 20000 }).output.trim(),
	// 输入指纹:本份快照测的是**这些文件的这个内容**。验收器据此判断它还算不算数 ——
	// 比 gitHead 管用,因为产物自己要被提交,一提交 HEAD 就变、按 HEAD 判会永远陈旧。
	inputsDigest: surfaceInputsDigest(REPO_ROOT),
	environment: {
		node: process.version,
		platform: process.platform,
		nodeModules: nodeModulesState(),
		seatbeltShield: shieldPath ? { available: true, profiles: SB, deniesDshHome: DSH_HOME, deniesRepoNodeModules: repoNodeModulesPaths().map((p) => relative(REPO_ROOT, p)) } : { available: false },
	},
	method: {
		note: 'Dependency trees are NOT removed to measure — other implementers may own them. Absence is simulated with macOS Seatbelt read-denial, which is non-destructive and reproducible regardless of what is installed.',
		// 机读版的能力边界声明,防止下游把这份清单当成「完整依赖面」使用。
		proves: 'Per-suite pass/fail in the real environment, and whether a suite needs absolute paths under ~/.dsh (which installing packages cannot fix).',
		doesNotProve: 'NOT a complete dependency surface. Node aborts at the FIRST unresolved specifier in the module graph, so each suite reveals at most one missing package per run. The authoritative complete surface comes from static import-graph traversal: scripts/acceptance/lib/import-graph.mjs via `prepare-host-modules.mjs --check`.',
		authoritativeSurface: 'scripts/acceptance/prepare-host-modules.mjs --check (static import graph)',
		modes: {
			natural: 'node --test test/<file> in the plugin cwd, no sandbox — the environment exactly as it is',
			'no-dsh': 'same, wrapped in /usr/bin/sandbox-exec denying read+write of ~/.dsh',
			'no-host-modules': 'same, additionally denying read of every node_modules directory in the repo (simulates a zero-dependency checkout)',
		},
		classification: {
			hermetic: 'passes with no ~/.dsh and no node_modules at all — needs nothing outside the repo source',
			'host-modules': 'needs bare host packages from a node_modules tree',
			'host-path': 'passes naturally but fails without ~/.dsh — depends on a hardcoded absolute path, which installing packages cannot fix',
			broken: 'fails in the natural environment for some other reason',
			'hermetic-unshielded': 'passes naturally; Seatbelt unavailable so the stronger claims could not be checked',
			'sandbox-incompatible': 'passes naturally but fails even under a ZERO-DENIAL outer sandbox — it launches its own Seatbelt sandbox, so this measurement method cannot classify it. Reported as unverified rather than guessed.',
		},
	},
	summary: {
		totalSuites: suites.length,
		byClassification: Object.fromEntries(Object.entries(byClass).map(([k, v]) => [k, v.length])),
		suitesRequiringHostModules: suites.filter((s) => s.classification === 'host-modules').map((s) => s.id),
		suitesRequiringHostPaths: suites.filter((s) => s.classification === 'host-path').map((s) => s.id),
		requiredExternalsBySuite: Object.fromEntries(
			suites.filter((s) => s.requiredExternals.length).map((s) => [s.id, s.requiredExternals])),
		externalToSuites: externals,
	},
	suites,
}

/**
 * 落盘前把绝对路径换成占位符。
 *
 * 这份清单是**交付物**(验收入口读它做依赖面预检),而它的内容里有两类绝对路径:
 *   1. repoRoot 与 seatbelt 规则里的 ~/.dsh —— 我们自己写进去的;
 *   2. errorExcerpt —— 子进程真实报错原文,里面必然带绝对路径(ERR_MODULE_NOT_FOUND、EPERM)。
 * 第二类是重点:它不是我们格式化出来的,是照抄的,所以「记得脱敏」这种纪律挡不住它。
 *
 * 独立验证者(阻塞项 3)实测本文件有 18 处操作者绝对路径。占位符替换放在**写盘这一层**,
 * 而不是各个采集点,正是因为采集点会不断增加而这一层只有一个。
 * 替换只动路径前缀,错误码、模块名、类别判定一字不动。
 */
function deidentify(text) {
	return text
		.split(REPO_ROOT).join('<REPO_ROOT>')
		.split(homedir()).join('<HOME>')
}

mkdirSync(dirname(outPath), { recursive: true })
writeFileSync(outPath, deidentify(JSON.stringify(manifest, null, 2)) + '\n')
console.log(`\n== dependency surface: ${suites.length} suites ==`)
for (const [k, v] of Object.entries(byClass)) console.log(`  ${k}: ${v.length}`)
if (Object.keys(externals).length) {
	console.log('  externals actually required:')
	for (const [m, ids] of Object.entries(externals)) console.log(`    ${m} <- ${ids.length} suite(s)`)
} else {
	console.log('  externals actually required: none observed')
}
console.log(`written: ${relative(REPO_ROOT, outPath)}`)
