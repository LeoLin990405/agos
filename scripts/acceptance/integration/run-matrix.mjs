#!/usr/bin/env node
/**
 * 集成验证矩阵 —— 四层的共用入口与汇总。
 *
 *   code-gate     本地代码门。**调用**现有的 scripts/acceptance/run-acceptance.mjs,
 *                 默认不加任何改变其语义的参数,并检查它自报的 `authoritative` 标志。
 *   swarm         真实 swarm 集成(A 的入口)。
 *   linux         Linux sandbox(B 的入口)。
 *   host-browser  宿主浏览器联测(C 的入口)。
 *
 * 这个入口不重新实现任何一层的判定。它做的是四件采集不了就没法反驳的事:
 *   1. 每层记下**这棵树是哪棵树**(sourceCommit + 工作树摘要,脏树摘要必变);
 *   2. 每层记下**真实执行的 argv 数组**、平台、运行时、模块来源、起止时间、退出码;
 *   3. 每层的 pass/fail/skip/**blocked** 四路**分列**,日志哈希由矩阵**重算**后核对;
 *   4. 汇总时把「产品代码结论」与「集成覆盖状态」**分开报**。
 *
 * 汇总的两条硬语义(是一对,必须同时成立):
 *   - 显式要求了某一层而它 unavailable(blocked / 没有入口 / 结果缺失)→ **绝不**汇总成
 *     「整体集成通过」。blocked 不是 pass 的变体。
 *   - 某个**可选**层缺席 → **绝不**报成产品代码失败。代码结论照常是它自己的结论,
 *     只是「全部验证通过」这句话不成立 —— 后者由 claims.allVerified 单独承担。
 *
 * 退出码:
 *   0   权威运行,且**被要求**的每一层都 pass
 *   1   被要求的某一层 fail(含超时、结果缺失/为空/字段缺失、自称 pass 却退非零)
 *   70  用了桩/接缝(--layer-producer / --layer-argv / --code-gate-argv):本次是入口自检,
 *       不是真实集成。绿也不给 0,免得 `... && echo 全部通过` 把自检当成验收。
 *   78  拒绝下结论:被要求的层 blocked 或没有入口、证据完整性对不上(日志哈希不匹配)、
 *       参数/日志目录不合法、--print-plan。
 *
 * 用法:
 *   node scripts/acceptance/integration/run-matrix.mjs
 *   node scripts/acceptance/integration/run-matrix.mjs --require=code-gate,swarm
 *   node scripts/acceptance/integration/run-matrix.mjs --only=swarm,linux    # 只要这些层:要求它们,其余 skip
 *   node scripts/acceptance/integration/run-matrix.mjs --all --logdir=/tmp/agos-matrix/run-1
 *   node scripts/acceptance/integration/run-matrix.mjs --print-plan          # 只打印计划,退 78
 *
 * `--require` **不是**「只跑这些层」。有入口的层照样采集;它只改「谁必须过」。
 * 字面 `--require=swarm,linux` 仍会拉起代码门和宿主 9 场景。只要那两层、别的不跑,用 `--only`。
 *
 * 接缝(仅供本入口自检;一旦使用,本次运行 authoritative=false 且退出码不可能是 0):
 *   --layer-producer=<layer>=<script.mjs>
 *   --layer-argv=<layer>=<JSON argv 数组>
 *   --code-gate-argv=<JSON argv 数组>
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { REPO_ROOT, neutralEnv, runCommand } from '../lib/exec.mjs'
import { LAYERS, buildLayerResult, digestDriftVerdict, emptyCounts, platformInfo, resolveVerdict, validateLayerResult } from './lib/layer-result.mjs'
import { sha256File, verifyLogs } from './lib/evidence.mjs'
import { trackedWorktreeDigest, worktreeDigest } from './lib/worktree.mjs'
import { adaptAcceptanceResults, defaultCodeGateArgv } from './lib/code-gate-adapter.mjs'

const EXIT_OK = 0
const EXIT_LAYER_FAIL = 1
const EXIT_SYNTHETIC = 70
const EXIT_REFUSE = 78

const INTEGRATION_LAYERS = ['swarm', 'linux', 'host-browser']
const DEFAULT_TIMEOUT_MS = { 'code-gate': 3600000, swarm: 900000, linux: 900000, 'host-browser': 900000 }

/**
 * 各层入口的默认探测位置与**各自的参数方言**。
 *
 * 方言必须逐个登记,不能统一发明一套:三个入口是三个代理独立写的,实测
 * swarm 用 `--logdir=<dir>`、linux 与 host-browser 用 `--logdir <dir>`(空格式),
 * 而且三者都对未知参数直接抛错。矩阵最初多传了自己发明的 `--layer=` / `--out=`,
 * 结果 swarm 入口以 `未知参数 --layer=swarm` 退非零 —— 一次纯粹由编排方造出来的假红。
 *
 * 三个入口都按契约把结果写到 `<logdir>/<layer>.json`,所以矩阵**只**需要把顶层日志目录
 * 交给它们,别的一概不传。探测过哪些路径会逐条写进 blockedReason ——「环境不支持」
 * 定位不到任何东西,「探测过 X 与 Y,都不存在」可以直接照着修。
 */
const PRODUCER_REGISTRY = {
	swarm: [
		{ path: 'scripts/acceptance/integration/swarm/run.mjs', args: (logDir) => [`--logdir=${logDir}`] },
	],
	linux: [
		{ path: 'scripts/acceptance/integration/linux/run-linux-isolation.mjs', args: (logDir) => ['--logdir', logDir] },
		{ path: 'scripts/acceptance/integration/linux/run.mjs', args: (logDir) => [`--logdir=${logDir}`] },
	],
	'host-browser': [
		{ path: 'frontend/tests/host-integration/run.mjs', args: (logDir) => ['--logdir', logDir] },
		{ path: 'scripts/acceptance/integration/host-browser/run.mjs', args: (logDir) => [`--logdir=${logDir}`] },
	],
}

const args = process.argv.slice(2)
const flag = (n) => args.includes(`--${n}`)
const opt = (n, d) => { const h = args.find((a) => a.startsWith(`--${n}=`)); return h ? h.slice(n.length + 3) : d }
const optAll = (n) => args.filter((a) => a.startsWith(`--${n}=`)).map((a) => a.slice(n.length + 3))

function die(code, lines) {
	for (const l of lines) console.error(l)
	process.exit(code)
}

/** `<layer>=<value>` 形式的可重复参数。层名不认识就直接退 78,不静默丢弃。 */
function parsePerLayer(name) {
	const out = {}
	for (const raw of optAll(name)) {
		const eq = raw.indexOf('=')
		if (eq <= 0) die(EXIT_REFUSE, [`❌ --${name} 需要 <layer>=<值> 形式,收到: ${raw}`])
		const layer = raw.slice(0, eq)
		if (!LAYERS.includes(layer)) die(EXIT_REFUSE, [`❌ --${name} 的层名 ${JSON.stringify(layer)} 不认识,可用: ${LAYERS.join('/')}`])
		out[layer] = raw.slice(eq + 1)
	}
	return out
}

function parseJsonArgv(text, what) {
	let v = null
	try {
		v = JSON.parse(text)
	} catch (err) {
		die(EXIT_REFUSE, [`❌ ${what} 需要 JSON 字符串数组(argv),解析失败: ${err.message}`, `   收到: ${text}`])
	}
	if (!Array.isArray(v) || v.length === 0 || !v.every((a) => typeof a === 'string')) {
		die(EXIT_REFUSE, [`❌ ${what} 需要非空的 JSON 字符串数组(argv,不是拼好的命令行): ${text}`])
	}
	return v
}

const runId = new Date().toISOString().replace(/[:.]/g, '-')
const logDir = resolve(opt('logdir', join(tmpdir(), 'agos-integration-matrix', runId)))
const jsonOut = resolve(opt('json', join(logDir, 'matrix.json')))
const allowExistingLogdir = flag('allow-existing-logdir')
const printPlanOnly = flag('print-plan')

const onlyCsv = opt('only', null)
if (args.includes('--only')) {
	die(EXIT_REFUSE, ['❌ --only 需要 --only=<layer>[,<layer>…] 形式,裸标志会被静默忽略所以直接拒绝。'])
}
if (onlyCsv !== null) {
	if (flag('all') || opt('require', null) !== null || opt('skip', '') !== '') {
		die(EXIT_REFUSE, ['❌ --only 不能和 --all / --require / --skip 同时用。', '   --only 的含义就是「要求这些层、其余 skip」。'])
	}
}

const requireCsv = onlyCsv !== null ? onlyCsv : (flag('all') ? LAYERS.join(',') : opt('require', 'code-gate'))
const required = requireCsv.split(',').map((s) => s.trim()).filter(Boolean)
for (const l of required) {
	if (!LAYERS.includes(l)) die(EXIT_REFUSE, [`❌ --require/--only 里的层名 ${JSON.stringify(l)} 不认识,可用: ${LAYERS.join('/')}`])
}
if (required.length === 0) {
	die(EXIT_REFUSE, [
		'❌ --require/--only 为空,拒绝运行:empty-require',
		'   一层都不要求的运行不是「全过」,是「什么都没验」—— 那正是本矩阵要挡的那类结论。',
	])
}

const skipCsv = onlyCsv !== null ? LAYERS.filter((l) => !required.includes(l)).join(',') : opt('skip', '')
const skipped = skipCsv.split(',').map((s) => s.trim()).filter(Boolean)
for (const l of skipped) {
	if (!LAYERS.includes(l)) die(EXIT_REFUSE, [`❌ --skip 里的层名 ${JSON.stringify(l)} 不认识`])
	if (required.includes(l)) {
		die(EXIT_REFUSE, [`❌ ${l} 同时出现在 --require 与 --skip 里。`, '   「我要求它」和「我不跑它」不能同时成立 —— 这种组合只会产出一个自相矛盾的结论。'])
	}
}

const producerOverride = parsePerLayer('layer-producer')
const argvOverrideRaw = parsePerLayer('layer-argv')
const argvOverride = Object.fromEntries(Object.entries(argvOverrideRaw).map(([k, v]) => [k, parseJsonArgv(v, `--layer-argv=${k}`)]))
const timeoutOverride = Object.fromEntries(Object.entries(parsePerLayer('layer-timeout')).map(([k, v]) => {
	const n = Number(v)
	if (!Number.isInteger(n) || n <= 0) die(EXIT_REFUSE, [`❌ --layer-timeout=${k}=${v} 必须是正整数毫秒`])
	return [k, n]
}))
const codeGateArgvOverride = opt('code-gate-argv', null)
const codeGateExtra = opt('code-gate-extra', null)
// 默认入口的探测根。默认就是仓根;改掉它是为了让「探测到了入口」这条分支能被负控实际走到
// (A/B 的 swarm/ linux/ 子目录不属于本入口的所有权,不能为了测试往那里放桩文件)。
const candidatesRoot = resolve(opt('candidates-root', REPO_ROOT))

// 接缝清单。这些开关让本入口能被自己的负控测试驱动(用桩代替真实的 A/B/C 入口),
// 代价是本次运行不代表真实集成 —— 所以它必须写进 JSON、打在终端,并且**封死 0 退出码**。
// 契约第 4 条:「入口自检必须标明是入口自检,不得冒充真实集成 pass」。
const seams = []
for (const [k, v] of Object.entries(producerOverride)) seams.push(`--layer-producer=${k}=${v}`)
for (const [k, v] of Object.entries(argvOverrideRaw)) seams.push(`--layer-argv=${k}=${v}`)
if (codeGateArgvOverride !== null) seams.push('--code-gate-argv')
if (candidatesRoot !== REPO_ROOT) seams.push(`--candidates-root=${candidatesRoot}`)
const SYNTHETIC = seams.length > 0

const matrixArgv = ['node', 'scripts/acceptance/integration/run-matrix.mjs', ...args]

/**
 * 一层的执行计划:怎么跑、跑不跑、为什么。
 *
 * 生产者拿到的 `--logdir` 就是矩阵这一轮的**顶层**日志目录,`--out` 指向
 * `<logdir>/<layer>.json` —— 与任务表里的契约「每个集成层入口写一份 JSON 到
 * `<logdir>/<layer>.json`」逐字一致。给生产者一个别的子目录会让「按契约写」的入口
 * 把结果落在矩阵不看的地方,矩阵再报 missing-layer-result,是纯粹自造的假红。
 */
function planLayer(layer) {
	const isRequired = required.includes(layer)
	const resultPath = join(logDir, `${layer}.json`)
	const timeoutMs = timeoutOverride[layer] ?? DEFAULT_TIMEOUT_MS[layer] ?? 900000
	if (skipped.includes(layer)) {
		return { layer, required: isRequired, run: false, why: 'explicitly-skipped', resultPath, timeoutMs, probed: [] }
	}
	if (layer === 'code-gate') {
		const argv = codeGateArgvOverride !== null
			? parseJsonArgv(codeGateArgvOverride, '--code-gate-argv')
			: defaultCodeGateArgv({
				jsonOut: join(logDir, 'code-gate.acceptance.json'),
				logDir: join(logDir, 'code-gate-logs'),
				extra: codeGateExtra === null ? [] : parseJsonArgv(codeGateExtra, '--code-gate-extra'),
			})
		return { layer, required: isRequired, run: true, kind: 'code-gate', argv, resultPath, timeoutMs, probed: [] }
	}
	const candidates = PRODUCER_REGISTRY[layer].map((c) => ({ ...c, abs: resolve(candidatesRoot, c.path) }))
	const probed = candidates.map((c) => c.abs)
	if (argvOverride[layer]) {
		return { layer, required: isRequired, run: true, kind: 'producer', argv: argvOverride[layer], resultPath, timeoutMs, probed, seam: 'layer-argv' }
	}
	const explicit = producerOverride[layer]
	if (explicit !== undefined) {
		const abs = resolve(REPO_ROOT, explicit)
		if (!existsSync(abs)) return { layer, required: isRequired, run: false, why: 'producer-missing', producer: abs, resultPath, timeoutMs, probed }
		const dialect = PRODUCER_REGISTRY[layer]?.[0]?.args ?? ((dir) => [`--logdir=${dir}`])
		return {
			layer, required: isRequired, run: true, kind: 'producer', probed, seam: 'layer-producer',
			argv: ['node', abs, ...dialect(logDir)], resultPath, timeoutMs,
		}
	}
	const found = candidates.find((c) => existsSync(c.abs)) ?? null
	if (found === null) {
		return { layer, required: isRequired, run: false, why: 'no-producer-registered', producer: null, resultPath, timeoutMs, probed }
	}
	return {
		layer, required: isRequired, run: true, kind: 'producer', probed,
		argv: ['node', found.abs, ...found.args(logDir)],
		resultPath, timeoutMs,
	}
}

const plan = LAYERS.map(planLayer)

if (printPlanOnly) {
	console.log(JSON.stringify({ plan, required, skipped, syntheticSeams: SYNTHETIC ? seams : null, logDir }, null, 2))
	console.error('PLAN-ONLY:只打印了计划,一层都没跑 —— 退出码 78,确保它永远不会被读成「通过」。')
	process.exit(EXIT_REFUSE)
}

// 日志目录一轮一个,不覆盖失败日志。目录已有内容就拒绝跑:上一轮的红日志被这一轮盖掉之后,
// 「我复跑了一次」和「我把证据换掉了」在磁盘上长得一模一样。
if (existsSync(logDir) && readdirSync(logDir).length > 0 && !allowExistingLogdir) {
	die(EXIT_REFUSE, [
		`❌ 日志目录已有内容,拒绝运行(避免覆盖上一轮证据): ${logDir}`,
		'   换一个目录,或显式加 --allow-existing-logdir(那样就是你自己决定覆盖)。',
	])
}
mkdirSync(logDir, { recursive: true })

const startedAt = new Date().toISOString()
const wtStart = worktreeDigest(REPO_ROOT)
const wtStartTracked = trackedWorktreeDigest(REPO_ROOT)
const env = neutralEnv()

console.log('== AgOS 集成验证矩阵(四层分列)==')
console.log(`   repo: ${REPO_ROOT}`)
console.log(`   sourceCommit: ${wtStart.head ?? '(不可用)'}`)
console.log(`   worktreeDigest: ${wtStart.digest.slice(0, 24)}…  (脏文件 ${wtStart.dirtyFiles ?? '?'} 个)`)
console.log(`   node: ${process.version}   日志: ${logDir}`)
console.log(`   要求通过的层: ${required.join(', ')}${skipped.length ? `   显式跳过: ${skipped.join(', ')}` : ''}`)
if (SYNTHETIC) {
	console.log(`   ⚠️  入口自检运行(非权威):接缝 ${seams.join('、')}`)
	console.log('       结果 authoritative=false,不代表任何真实集成;退出码封死为非 0。')
}
console.log('')

/** 跑一层并把它变成一条采集记录。判定权在这里,不在生产者手上。 */
function collectLayer(spec) {
	const base = {
		layer: spec.layer,
		required: spec.required,
		ran: spec.run === true,
		argv: spec.argv ?? null,
		timeoutMs: spec.timeoutMs,
		resultPath: spec.resultPath,
		probed: spec.probed.map((p) => (p.startsWith(REPO_ROOT) ? relative(REPO_ROOT, p) : p)),
		seam: spec.seam ?? null,
		evidence: { logs: [], mismatches: [] },
		digestDrift: null,
		validationErrors: [],
	}

	if (!spec.run) {
		// 没有入口 ≠ 失败。这里只如实说「这一层没被触达」,以及触达它需要什么。
		// 被要求 → blocked(拿不到结论);没被要求 → skipped(它本来就不在本次范围里)。
		const probedShown = base.probed.length ? base.probed.join(' 、 ') : '(无候选路径)'
		const blockedReason = spec.why === 'explicitly-skipped'
			? `本次运行用 --skip=${spec.layer} 显式排除了这一层,因此它没有被触达。`
			: `没有找到 ${spec.layer} 层的入口:探测过 ${probedShown},均不存在(--layer-producer 也没有指定)。这一层在本次运行中**完全没有被触达**,不是「跑过了没问题」。`
		const recoveryCommand = spec.why === 'explicitly-skipped'
			? ['node', 'scripts/acceptance/integration/run-matrix.mjs', `--require=${spec.layer}`]
			: ['node', 'scripts/acceptance/integration/run-matrix.mjs', `--require=${spec.layer}`, `--layer-producer=${spec.layer}=<入口脚本路径>`]
		const verdict = spec.required ? 'blocked' : 'skipped'
		const result = buildLayerResult({
			layer: spec.layer,
			verdict,
			sourceCommit: wtStart.head ?? 'unavailable',
			worktreeDigest: wtStart.digest,
			command: ['(未执行)'],
			startedAt, endedAt: new Date().toISOString(), exitCode: 0,
			counts: { ...emptyCounts(), blocked: verdict === 'blocked' ? 1 : 0 },
			blockedReason: verdict === 'blocked' ? blockedReason : null,
			recoveryCommand: verdict === 'blocked' ? recoveryCommand : null,
			extra: { notRunReason: spec.why, note: blockedReason },
		})
		const icon = verdict === 'blocked' ? '⛔' : '·'
		console.log(`▸ ${spec.layer}: ${icon} ${verdict.toUpperCase()} (${spec.why})`)
		console.log(`     ${blockedReason}`)
		return { ...base, verdict, reason: spec.why, result }
	}

	const spawnLog = join(logDir, `${spec.layer}.spawn.log`)
	const t0 = new Date().toISOString()
	// 每一层单独夹一次工作树摘要。只在矩阵启动时量一次是不够的:本轮有五个代理并行写同一个
	// 工作区,生产者在自己启动的那一刻量到的摘要与矩阵几分钟前量到的本就可能不同,而那是
	// 环境事实,不是"这份结果量了另一棵树"。用**这一层执行窗口**的前后两次实测来归属,
	// 既保住了"结果必须能钉到一棵树上",又不会因为别人在隔壁存了个文件就造出假红。
	const wtBefore = worktreeDigest(REPO_ROOT)
	const wtBeforeTracked = trackedWorktreeDigest(REPO_ROOT)
	const r = runCommand({ argv: spec.argv, cwd: REPO_ROOT, env, logPath: spawnLog, timeoutMs: spec.timeoutMs })
	const wtAfter = worktreeDigest(REPO_ROOT)
	const wtAfterTracked = trackedWorktreeDigest(REPO_ROOT)
	const t1 = new Date().toISOString()
	base.worktreeWindow = { before: wtBefore.digest, after: wtAfter.digest, stable: wtBefore.digest === wtAfter.digest }
	// 超时判定与验收器同法:spawnSync 到点发 SIGTERM,而 node --test 会接住信号自己退 1,
	// 于是「被砍」和「断言失败」长得一模一样。跑满时长就按超时报,别把它读成断言失败。
	const timedOut = r.durationSeconds * 1000 >= spec.timeoutMs - 100 || /killed by signal/.test(r.spawnError ?? '')
	base.spawn = {
		exitCode: r.exitCode,
		spawnError: r.spawnError,
		durationSeconds: r.durationSeconds,
		timedOut,
		log: relative(REPO_ROOT, spawnLog).startsWith('..') ? spawnLog : relative(REPO_ROOT, spawnLog),
		logSha256: sha256File(spawnLog),
	}
	base.startedAt = t0
	base.endedAt = t1

	if (spec.kind === 'code-gate') {
		const adapted = adaptAcceptanceResults({
			repoRoot: REPO_ROOT,
			jsonPath: spec.argv.map((a) => (a.startsWith('--json=') ? a.slice('--json='.length) : null)).find(Boolean) ?? join(logDir, 'code-gate.acceptance.json'),
			argv: spec.argv, cwd: REPO_ROOT,
			exitCode: r.exitCode, spawnError: r.spawnError,
			startedAt: t0, endedAt: t1, timedOut, timeoutMs: spec.timeoutMs,
			sourceCommit: wtStart.head ?? 'unavailable', worktreeDigest: wtStart.digest,
			matrixLog: spawnLog,
		})
		writeFileSync(spec.resultPath, JSON.stringify(adapted.result, null, 2) + '\n')
		const ev = verifyLogs(adapted.result.logs, { baseDir: logDir, repoRoot: REPO_ROOT })
		base.evidence = ev
		let verdict = adapted.verdict
		let reason = adapted.reason
		const consumerVerdict = resolveVerdict(adapted.result)
		if (consumerVerdict.downgradedFrom !== null) {
			verdict = consumerVerdict.verdict
			reason = consumerVerdict.reason
		}
		if (ev.mismatches.length > 0) {
			verdict = 'fail'
			reason = `evidence-integrity:${ev.mismatches.map((m) => m.code).join(',')}`
		}
		printLayer(spec.layer, verdict, reason, adapted.result, ev, r)
		return { ...base, verdict, reason, result: adapted.result, acceptance: adapted.acceptance ? { authoritative: adapted.acceptance.authoritative, exitCode: adapted.acceptance.processExitCode, gitHead: adapted.acceptance.gitHead } : null }
	}

	// ---- 生产者层(swarm / linux / host-browser)----
	if (!existsSync(spec.resultPath)) {
		const reason = timedOut ? `timeout-after:${spec.timeoutMs}ms` : (r.exitCode === 0 ? 'missing-layer-result' : `nonzero-exit:${r.exitCode}`)
		const detail = timedOut
			? `入口跑满 ${spec.timeoutMs}ms 被砍(真实退出码 ${r.exitCode}),没有写出结果`
			: `入口退出码 ${r.exitCode},但 ${spec.resultPath} 不存在 —— 没有结果就不能有结论`
		return failedLayer(base, spec, reason, detail, r, t0, t1)
	}
	const rawText = readFileSync(spec.resultPath, 'utf8')
	if (rawText.trim() === '') return failedLayer(base, spec, 'empty-layer-result', `${spec.resultPath} 是空的(0 字节或只有空白)`, r, t0, t1)
	let parsed = null
	try {
		parsed = JSON.parse(rawText)
	} catch (err) {
		return failedLayer(base, spec, 'invalid-layer-result-json', `${spec.resultPath} 解析失败: ${err.message}`, r, t0, t1)
	}
	const errors = validateLayerResult(parsed, { layer: spec.layer })
	base.validationErrors = errors
	if (errors.length > 0) {
		// 不合格的结果一律**不可能是 pass**。但严重程度分两档,而且这个区分是实测逼出来的:
		// linux 层如实自报 blocked,只是 recoveryCommand 写成了「多条命令的数组」而非契约要求的
		// 单条 argv。把这种情况判成 fail,等于让编排方凭一个字段的形状造出一次"集成层失败",
		// 而实际发生的事情是"这一层压根没被触达"。
		//   自称 pass / fail / 说不清 → fail(pass 的自述不可信;fail 的自述照单接受)
		//   自称 blocked / skipped   → blocked(它本来就没验成,不制造假红)
		const claimed = parsed.verdict
		const code = `invalid-layer-result:${errors.map((e) => e.code).join(',')}`
		const detail = errors.map((e) => e.detail).join(' | ')
		if (claimed === 'blocked' || claimed === 'skipped') {
			const result = buildLayerResult({
				layer: spec.layer, verdict: 'blocked',
				sourceCommit: wtStart.head ?? 'unavailable', worktreeDigest: wtStart.digest,
				command: Array.isArray(parsed.command) ? parsed.command : spec.argv,
				startedAt: t0, endedAt: t1, exitCode: r.exitCode,
				counts: { ...emptyCounts(), blocked: 1 },
				blockedReason: `${spec.layer} 层自报 ${claimed},但结果文档不合契约(${code}),因此既不能算通过、也不能据以判定产品代码有问题。原始自报原因: ${typeof parsed.blockedReason === 'string' ? parsed.blockedReason : '(未给)'}`,
				recoveryCommand: ['node', 'scripts/acceptance/integration/run-matrix.mjs', `--require=${spec.layer}`],
				extra: { validationErrors: errors, rawVerdict: claimed, rawResult: parsed },
			})
			console.log(`▸ ${spec.layer}: ⛔ BLOCKED exit ${r.exitCode}  ${r.durationSeconds}s`)
			console.log(`     原因: ${code}`)
			console.log(`     ${detail}`)
			return { ...base, verdict: 'blocked', reason: code, result, rawResult: parsed }
		}
		return failedLayer(base, spec, code, detail, r, t0, t1, parsed)
	}

	const ev = verifyLogs(parsed.logs, { baseDir: logDir, repoRoot: REPO_ROOT })
	base.evidence = ev

	const resolved = resolveVerdict(parsed)
	let verdict = resolved.verdict
	let reason = resolved.downgradedFrom ? resolved.reason : 'as-reported'

	if (timedOut) {
		verdict = 'fail'
		reason = `timeout-after:${spec.timeoutMs}ms (真实退出码 ${r.exitCode};子进程可能把 SIGTERM 转成了普通退出码,别读成断言失败)`
	} else if (r.exitCode !== 0 && verdict === 'pass') {
		// 自称 pass 却退非零:两个自述互相打脸,按坏的那一半算。
		verdict = 'fail'
		reason = `pass-claimed-with-nonzero-exit:${r.exitCode}`
	} else if (r.exitCode !== 0 && verdict === 'skipped') {
		verdict = 'fail'
		reason = `skipped-claimed-with-nonzero-exit:${r.exitCode}`
	}
	if (ev.mismatches.length > 0) {
		verdict = 'fail'
		reason = `evidence-integrity:${ev.mismatches.map((m) => m.code).join(',')}`
	}
	if (parsed.sourceCommit !== (wtStart.head ?? 'unavailable')) {
		verdict = 'fail'
		reason = `stale-layer-result:commit ${parsed.sourceCommit} ≠ ${wtStart.head}`
	} else {
		// 归属:声称的摘要必须等于矩阵在这一层执行窗口里**亲自量到**的某一个状态。
		// 观测集合同时含两种算法 —— porcelain(矩阵自己的记录)与 tracked(A/B/C 契约口径)。
		// 只认前者会把一次真实的 host-browser 9/9 判成 stale-layer-result:worktree:
		// 两边描述的是同一棵树,哈希函数不同,声称值永远不在观测里。
		const observed = [
			wtStart.digest, wtBefore.digest, wtAfter.digest,
			wtStartTracked.digest, wtBeforeTracked.digest, wtAfterTracked.digest,
		]
		if (!observed.includes(parsed.worktreeDigest)) {
			base.digestDrift = { declared: parsed.worktreeDigest, matrix: wtBefore.digest, observed: [...new Set(observed)], windowStable: base.worktreeWindow.stable }
			// 已经因为更严重的原因判红的层不再改写理由:证据被篡改是比"树归属不上"更重的问题,
			// 把它重贴成摘要漂移会让读者以为只是并发写文件闹的。
			if (verdict === 'pass') {
				const d = digestDriftVerdict({ treeStable: base.worktreeWindow.stable, declared: parsed.worktreeDigest, matrix: wtBefore.digest, layer: spec.layer })
				verdict = d.verdict
				reason = d.reason
				base.digestDrift.resolution = d.verdict
				if (d.blockedReason !== null) {
					parsed.blockedReason = d.blockedReason
					parsed.recoveryCommand = d.recoveryCommand
				}
			} else {
				base.digestDrift.resolution = `已按更严重的原因判 ${verdict},摘要漂移仅记录`
			}
		}
	}

	printLayer(spec.layer, verdict, reason, parsed, ev, r)
	return { ...base, verdict, reason, result: parsed, downgradedFrom: resolved.downgradedFrom ?? null }
}

function failedLayer(base, spec, reason, detail, r, t0, t1, parsed = null) {
	const result = buildLayerResult({
		layer: spec.layer, verdict: 'fail',
		sourceCommit: wtStart.head ?? 'unavailable', worktreeDigest: wtStart.digest,
		command: spec.argv, startedAt: t0, endedAt: t1, exitCode: r.exitCode,
		counts: { ...emptyCounts(), fail: 1 },
		extra: { failReason: reason, failDetail: detail, producerResultPresent: parsed !== null },
	})
	console.log(`▸ ${spec.layer}: ❌ FAIL exit ${r.exitCode}  ${r.durationSeconds}s`)
	console.log(`     原因: ${reason}`)
	console.log(`     ${detail}`)
	return { ...base, verdict: 'fail', reason, result, rawResult: parsed }
}

function printLayer(layer, verdict, reason, result, ev, r) {
	const c = result.counts ?? emptyCounts()
	const icon = verdict === 'pass' ? '✅' : verdict === 'blocked' ? '⛔' : verdict === 'skipped' ? '·' : '❌'
	console.log(`▸ ${layer}: ${icon} ${verdict.toUpperCase()} exit ${r.exitCode}  pass ${c.pass} / fail ${c.fail} / skip ${c.skip} / blocked ${c.blocked}  ${r.durationSeconds}s`)
	if (verdict !== 'pass') console.log(`     原因: ${reason}`)
	if (result.blockedReason) console.log(`     阻塞: ${result.blockedReason}`)
	if (Array.isArray(result.recoveryCommand) && result.recoveryCommand.length) console.log(`     恢复: ${result.recoveryCommand.join(' ')}`)
	if (ev.mismatches.length) for (const m of ev.mismatches) console.log(`     ⚠️  证据: ${m.code} ${m.path ?? ''} ${m.detail}`)
	else if (ev.checked > 0) console.log(`     证据: ${ev.checked} 份日志哈希由矩阵重算并核对一致`)
}

const collected = plan.map(collectLayer)

const endedAt = new Date().toISOString()
const wtEnd = worktreeDigest(REPO_ROOT)
const treeStable = wtStart.digest === wtEnd.digest

// ---- 汇总:代码结论 与 集成覆盖 分开 ----
const byLayer = Object.fromEntries(collected.map((c) => [c.layer, c]))
const code = byLayer['code-gate']
const integration = INTEGRATION_LAYERS.map((l) => byLayer[l])

const totals = { pass: 0, fail: 0, skip: 0, blocked: 0 }
for (const c of collected) {
	const k = c.result?.counts ?? emptyCounts()
	totals.pass += k.pass
	totals.fail += k.fail
	totals.skip += k.skip
	totals.blocked += k.blocked
}

const coverage = {
	covered: integration.filter((c) => c.verdict === 'pass').map((c) => c.layer),
	failed: integration.filter((c) => c.verdict === 'fail').map((c) => c.layer),
	blocked: integration.filter((c) => c.verdict === 'blocked').map((c) => c.layer),
	absent: integration.filter((c) => c.verdict === 'skipped').map((c) => c.layer),
}
const integrationVerdict = coverage.failed.length ? 'fail'
	: coverage.blocked.length ? 'blocked'
		: coverage.covered.length === INTEGRATION_LAYERS.length ? 'pass'
			: coverage.covered.length ? 'partial' : 'none'

const integrityErrors = collected.flatMap((c) => c.evidence.mismatches.map((m) => ({ layer: c.layer, ...m })))

/** 拒绝说「全部验证通过」的每一条理由,逐条点名。空数组才允许说这句话。 */
const refusals = []
if (SYNTHETIC) refusals.push({ code: 'synthetic-seams', layer: null, detail: `本次用了入口自检接缝(${seams.join('、')}),结果不代表真实集成` })
for (const m of integrityErrors) refusals.push({ code: 'evidence-integrity', layer: m.layer, detail: `${m.code}: ${m.detail}` })
for (const c of collected) {
	if (c.verdict === 'pass') continue
	const kind = c.verdict === 'blocked' ? 'layer-blocked' : c.verdict === 'skipped' ? 'layer-not-covered' : 'layer-fail'
	refusals.push({ code: kind, layer: c.layer, required: c.required, detail: `${c.layer} = ${c.verdict}(${c.reason})` })
}

const allLayersPass = collected.every((c) => c.verdict === 'pass')
const allVerified = allLayersPass && !SYNTHETIC && integrityErrors.length === 0
const requiredNotPassing = collected.filter((c) => c.required && c.verdict !== 'pass')

let exitCode = EXIT_OK
let exitReason = 'all-required-layers-pass'
if (integrityErrors.length > 0) {
	exitCode = EXIT_REFUSE
	exitReason = `evidence-integrity:${integrityErrors.length}`
} else if (requiredNotPassing.some((c) => c.verdict === 'fail')) {
	exitCode = EXIT_LAYER_FAIL
	exitReason = `required-layer-fail:${requiredNotPassing.filter((c) => c.verdict === 'fail').map((c) => c.layer).join(',')}`
} else if (requiredNotPassing.length > 0) {
	exitCode = EXIT_REFUSE
	exitReason = `required-layer-unavailable:${requiredNotPassing.map((c) => `${c.layer}=${c.verdict}`).join(',')}`
} else if (SYNTHETIC) {
	exitCode = EXIT_SYNTHETIC
	exitReason = 'synthetic-seams'
}

const out = {
	schema: 'agos-acceptance/integration-matrix@1',
	generatedAt: endedAt,
	runId,
	repoRoot: REPO_ROOT,
	command: matrixArgv,
	startedAt,
	endedAt,
	platform: platformInfo(),
	sourceCommit: wtStart.head,
	worktree: {
		digest: wtStart.digest,
		digestAtEnd: wtEnd.digest,
		stableDuringRun: treeStable,
		dirtyFiles: wtStart.dirtyFiles,
		note: treeStable ? null : '本次运行期间工作树发生变化(并行代理在写文件);各层的摘要归属按该层执行窗口内实测到的状态判定,见 layers[].worktreeWindow 与 layers[].digestDrift',
	},
	authoritative: !SYNTHETIC,
	syntheticSeams: SYNTHETIC ? seams : null,
	requiredLayers: required,
	skippedLayers: skipped,
	logDir,
	// 产品代码结论:**只**看代码门。缺任何可选集成层都不许改动这里的值。
	code: {
		verdict: code.verdict,
		reason: code.reason,
		exitCode: code.spawn?.exitCode ?? null,
		authoritativeRun: code.acceptance?.authoritative ?? null,
		counts: code.result?.counts ?? emptyCounts(),
		note: '产品代码的结论只由代码门决定;集成层缺席不会、也不该把它变红。',
	},
	// 集成覆盖状态:与上面**分开**报。这里的 blocked 永远不会被折进 covered。
	integration: {
		verdict: integrationVerdict,
		coverage,
		note: 'blocked/absent 与 covered 分列。被要求的层 unavailable 时,integration.verdict 不可能是 pass。',
	},
	totals,
	claims: {
		// 「被要求的层是否都过了」与「四层是否都过了」是两句不同的话。前者决定退出码,
		// 后者决定能不能说「全部验证通过」。把它们并成一个字段,就等于要么把「可选层没跑」
		// 说成失败,要么把「只跑了代码门」说成全部通过 —— 本轮明令禁止的正是这两件事。
		requiredLayersPass: requiredNotPassing.length === 0,
		allLayersPass,
		allVerified,
		statement: allVerified
			? '四层全部实跑且全部通过'
			: '不能声称「全部验证通过」—— 理由见 refusals',
		refusals,
	},
	integrityErrors,
	layers: collected.map((c) => ({
		layer: c.layer, required: c.required, ran: c.ran, verdict: c.verdict, reason: c.reason,
		argv: c.argv, timeoutMs: c.timeoutMs, seam: c.seam,
		spawn: c.spawn ?? null,
		resultPath: c.resultPath,
		result: c.result,
		validationErrors: c.validationErrors,
		evidence: { checked: c.evidence.checked ?? 0, entries: c.evidence.entries ?? [], mismatches: c.evidence.mismatches },
		worktreeWindow: c.worktreeWindow ?? null,
		digestDrift: c.digestDrift,
	})),
	exitCode,
	exitReason,
}

mkdirSync(dirname(jsonOut), { recursive: true })
writeFileSync(jsonOut, JSON.stringify(out, null, 2) + '\n')

console.log('')
console.log('== 汇总(代码结论 与 集成覆盖 分开报)==')
console.log(`   产品代码(code-gate): ${code.verdict === 'pass' ? '✅ PASS' : code.verdict === 'blocked' ? '⛔ BLOCKED' : `❌ ${code.verdict.toUpperCase()}`} —— ${code.reason}`)
console.log(`     ↑ 这一行不受集成层缺席影响:可选层没跑不是产品代码的问题。`)
console.log(`   集成覆盖: ${integrationVerdict.toUpperCase()}  已覆盖 [${coverage.covered.join(', ') || '无'}]  失败 [${coverage.failed.join(', ') || '无'}]  阻塞 [${coverage.blocked.join(', ') || '无'}]  未触达 [${coverage.absent.join(', ') || '无'}]`)
console.log(`   计数合计: pass ${totals.pass} / fail ${totals.fail} / skip ${totals.skip} / blocked ${totals.blocked}   ← 四路分列,blocked 永不并入 pass`)
console.log('')
console.log(`   能否声称「全部验证通过」: ${allVerified ? '✅ 可以' : '❌ 不可以'}`)
for (const r of refusals) console.log(`     · ${r.code}${r.layer ? `[${r.layer}]` : ''}: ${r.detail}`)
console.log('')
console.log(`   JSON: ${jsonOut}`)
console.log(`   退出码 = ${exitCode} (${exitReason})`)
process.exit(exitCode)
