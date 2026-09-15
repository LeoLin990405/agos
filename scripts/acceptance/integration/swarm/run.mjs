#!/usr/bin/env node
/**
 * swarm 集成层入口 —— 真实 `dsh-kimicode-swarm` 在场时,把它真的跑起来。
 *
 * 用法:
 *   node scripts/acceptance/integration/swarm/run.mjs --logdir=<dir> [--json=<path>]
 *                                                    [--module=<spec>] [--compare-registry]
 *
 * 退出码(**0 只代表真实集成通过**,别的都不是):
 *   0 = pass     真实模块在场,全部集成检查通过
 *   1 = fail     真实模块在场,但检查跑红了 —— 这是代码问题
 *   2 = blocked  模块不在 / 不兼容 —— 这是环境问题,**不是** pass 也不是产品代码失败
 *
 * 为什么 blocked 不退 0:`node run.mjs && echo 通过` 这种用法太常见了。blocked 退 0
 * 会让"这台机器上根本没验"被读成"验过了"—— 那是本层最不该产生的错误结论。
 * 想容忍 blocked 的调用方显式判 `-eq 2` 即可,或者直接读结果 JSON 的 verdict。
 *
 * 两类结果**分开写、不合并**:
 *   `counts` / `checks`  —— 真实集成检查(必须有真模块才会有内容)
 *   `selfCheck`          —— **入口自检**,跑的是桩。它证明这个入口有区分力,
 *                           但**不构成任何真实集成证据**,所以永远不进 counts。
 *
 * 环境纪律:本入口**不动继承来的 HOME / CODEX_HOME**(连显式设回原值也不做)。
 * `--module` 只在传给解析器的那份 env 副本里覆盖 AGOS_SWARM_MODULE,不写 process.env。
 * registry 对照下载一律在 mkdtemp 里做,跑完即删,不碰任何共享 node_modules。
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { buildLayerResult, writeLayerResult, validateLayerResult, platformInfo } from '../lib/layer-result.mjs'
import { sha256File } from '../lib/evidence.mjs'
import { worktreeDigest } from '../lib/worktree.mjs'
import {
	resolveSwarmModule, describeSwarmProvenance, inspectSwarmExports,
	SWARM_OPT_IN_ENV, SWARM_SPECIFIER,
} from '../../../../plugins/dsh-agos/lib/swarm-host-integration.mjs'
import { buildChecks, runChecks } from './lib/checks.mjs'
import { runSelfCheck } from './lib/selfcheck.mjs'
import { classify, RECOVERY_COMMAND } from './lib/verdict.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '../../../..')
const LAYER = 'swarm'

/** Run checks behind a killable process boundary so a non-settling module cannot
 * prevent this entry from writing a fail result and exiting. */
function runChecksIsolated(specifier, { timeoutMs = 120_000 } = {}) {
	const child = spawnSync(process.execPath, [join(HERE, 'lib/checks-runner.mjs')], {
		env: { ...process.env, AGOS_SWARM_CHECK_MODULE: specifier },
		encoding: 'utf8', timeout: timeoutMs, killSignal: 'SIGKILL',
	})
	const timedOut = child.error?.code === 'ETIMEDOUT' || child.signal === 'SIGKILL'
	if (timedOut) return [{ id: 'RUNNER', layer: 'runner', title: 'swarm 检查 runner 截止时间', status: 'fail', ms: timeoutMs, error: `runner 超过 ${timeoutMs}ms 未结算，已 SIGKILL 终止子进程` }]
	if (child.error || child.status !== 0) return [{ id: 'RUNNER', layer: 'runner', title: 'swarm 检查 runner', status: 'fail', ms: timeoutMs, error: `runner 异常退出(exit=${child.status ?? 'unknown'}, signal=${child.signal ?? 'none'}):${String(child.stderr ?? '').trim()}` }]
	const line = String(child.stdout ?? '').trim().split('\n').filter(Boolean).at(-1)
	try {
		const message = JSON.parse(line ?? '')
		if (message?.type === 'result') return message.results
		if (message?.type === 'error') return [{ id: 'RUNNER', layer: 'runner', title: 'swarm 检查 runner', status: 'fail', ms: timeoutMs, error: message.error }]
	} catch { /* timeout/termination or malformed child output is reported below */ }
	return [{ id: 'RUNNER', layer: 'runner', title: 'swarm 检查 runner', status: 'fail', ms: timeoutMs, error: `runner 未产出结构化结果(exit=${child.status ?? 'unknown'}):${String(child.stderr ?? '').trim()}` }]
}

function parseArgs(argv) {
	const opts = { logDir: null, json: null, module: null, compareRegistry: false }
	for (const arg of argv) {
		if (arg.startsWith('--logdir=')) opts.logDir = resolve(arg.slice('--logdir='.length))
		else if (arg.startsWith('--json=')) opts.json = resolve(arg.slice('--json='.length))
		else if (arg.startsWith('--module=')) opts.module = arg.slice('--module='.length)
		else if (arg === '--compare-registry') opts.compareRegistry = true
		else if (arg === '--help' || arg === '-h') opts.help = true
		else throw new Error(`未知参数 ${arg}(支持:--logdir= --json= --module= --compare-registry)`)
	}
	return opts
}

/**
 * 与 registry 做**字节级**对照。只读下载,全程在 mkdtemp 里,跑完即删。
 *
 * 拿不到(离线/registry 上没这个版本)不是失败:如实记 `unavailable` 并写明原因。
 * 把"没对照成"说成"对照通过"才是失败。
 */
function compareWithRegistry({ name, version, entryRelative, localSha256 }) {
	if (!name || !version) return { kind: 'registryComparison', status: 'unavailable', detail: '本地 package.json 缺 name/version,无从下载对应版本做对照' }
	const tmp = mkdtempSync(join(tmpdir(), 'agos-swarm-registry-'))
	try {
		const pack = spawnSync('npm', ['pack', `${name}@${version}`, '--pack-destination', tmp], { encoding: 'utf8', timeout: 120_000 })
		if (pack.status !== 0) {
			return { kind: 'registryComparison', status: 'unavailable', detail: `npm pack ${name}@${version} 失败(离线或该版本不存在):${String(pack.stderr ?? '').trim().split('\n').slice(-2).join(' ')}` }
		}
		const tgz = String(pack.stdout ?? '').trim().split('\n').filter(Boolean).at(-1)
		const tarball = join(tmp, tgz)
		if (!existsSync(tarball)) return { kind: 'registryComparison', status: 'unavailable', detail: `npm pack 报成功但 ${tarball} 不存在` }
		const untar = spawnSync('tar', ['-xzf', tarball, '-C', tmp], { encoding: 'utf8', timeout: 120_000 })
		if (untar.status !== 0) return { kind: 'registryComparison', status: 'unavailable', detail: `解包失败:${String(untar.stderr ?? '').trim()}` }
		const registryEntry = join(tmp, 'package', entryRelative)
		const registrySha = sha256File(registryEntry)
		if (registrySha === null) {
			return { kind: 'registryComparison', status: 'differs', detail: `registry ${name}@${version} 的 tarball 里根本没有 ${entryRelative} —— 本地那份的入口在 registry 版里不存在` }
		}
		if (registrySha === localSha256) {
			return { kind: 'registryComparison', status: 'identical', registrySha256: registrySha, detail: `本地 ${entryRelative} 与 registry ${name}@${version} 逐字节相同` }
		}
		return {
			kind: 'registryComparison', status: 'differs', registrySha256: registrySha,
			detail: `本地 ${entryRelative} 的 sha256 ${localSha256} 与 registry ${name}@${version} 的 ${registrySha} 不同 —— `
				+ '字节级证实这份不是 registry 发布的那一份。',
		}
	} catch (error) {
		return { kind: 'registryComparison', status: 'unavailable', detail: `registry 对照异常:${(error && error.message) || error}` }
	} finally {
		try { rmSync(tmp, { recursive: true, force: true }) } catch { /* 临时目录清不掉不影响结论 */ }
	}
}

function renderChecksLog({ provenance, moduleState, shape, results, selfCheck, verdict }) {
	const lines = []
	lines.push(`# swarm 集成层原始日志`)
	lines.push(`generatedAt=${new Date().toISOString()}`)
	lines.push(`node=${process.version} platform=${process.platform}/${process.arch}`)
	lines.push('')
	lines.push('## 模块来源(provenance)')
	lines.push(`specifier      = ${provenance.specifier}`)
	lines.push(`source         = ${provenance.source}`)
	lines.push(`resolvedPath   = ${provenance.resolvedPath ?? '(无文件实体)'}`)
	lines.push(`name/version   = ${provenance.name ?? '?'} / ${provenance.version ?? '?'}`)
	lines.push(`sha256         = ${provenance.sha256 ?? '(未计算)'}`)
	lines.push(`origin         = ${provenance.origin}`)
	lines.push(`originNote     = ${provenance.originNote ?? ''}`)
	for (const item of provenance.evidence ?? []) lines.push(`evidence[${item.kind}] = ${item.detail}${item.status ? ` (status=${item.status})` : ''}`)
	lines.push('')
	lines.push('## 模块可用性')
	lines.push(`available = ${moduleState.available}`)
	if (moduleState.reason) lines.push(`reason    = ${moduleState.reason}`)
	if (shape) {
		lines.push(`exports.ok       = ${shape.ok}`)
		lines.push(`exports.missing  = ${JSON.stringify(shape.missing)}`)
		lines.push(`exports.wrongType= ${JSON.stringify(shape.wrongType)}`)
	}
	lines.push('')
	lines.push('## 入口自检(跑的是桩,不是真 swarm;不计入 counts)')
	lines.push(selfCheck.note)
	for (const c of selfCheck.cases) lines.push(`  [${c.status}] ${c.id} ${c.title}${c.error ? ` :: ${c.error}` : ''}${c.checksRun ? ` (以真实检查集合跑坏桩:${c.checksRun} 条,${c.checksFailed} 条变红)` : ''}`)
	lines.push('')
	lines.push('## 真实集成检查')
	if (results.length === 0) lines.push('  (未执行 —— 见上面的模块可用性)')
	for (const r of results) {
		lines.push(`  [${r.status}] ${r.id} <${r.layer}> ${r.title} (${r.ms}ms)`)
		if (r.error) lines.push(`      ${r.error}`)
		if (r.stack) for (const line of r.stack.split('\n').slice(1)) lines.push(`      ${line.trim()}`)
		if (r.compared !== undefined) lines.push(`      比对项数 = ${r.compared}`)
	}
	lines.push('')
	lines.push(`## verdict = ${verdict}`)
	return lines.join('\n') + '\n'
}

async function main() {
	const opts = parseArgs(process.argv.slice(2))
	if (opts.help) {
		console.log('用法: node scripts/acceptance/integration/swarm/run.mjs --logdir=<dir> [--json=<path>] [--module=<spec>] [--compare-registry]')
		return 0
	}
	if (!opts.logDir) throw new Error('必须给 --logdir=<dir>:原始日志一轮一目录保存,不覆盖历史失败日志')
	mkdirSync(opts.logDir, { recursive: true })
	const jsonPath = opts.json ?? join(opts.logDir, `${LAYER}.json`)

	const startedAt = new Date().toISOString()
	// argv 如实记录本次实际执行的命令(含 --module 覆盖),不是"标准用法"的样板
	const command = ['node', relative(REPO_ROOT, fileURLToPath(import.meta.url)), ...process.argv.slice(2)]

	// ⚠️ 只在传给解析器的 env **副本**里覆盖,不写 process.env —— 继承来的 HOME / CODEX_HOME
	// 一个都不碰。
	const env = opts.module ? { ...process.env, [SWARM_OPT_IN_ENV]: opts.module } : { ...process.env }

	// ── 入口自检:永远先跑,且与真实集成结果分开记 ────────────────────────
	const selfCheck = await runSelfCheck()

	// ── 解析 + 来源 ───────────────────────────────────────────────────────
	const moduleState = await resolveSwarmModule({ env })
	let provenance = await describeSwarmProvenance({ env })
	if (opts.compareRegistry && provenance.resolvedPath && provenance.packageDir) {
		const comparison = compareWithRegistry({
			name: provenance.name,
			version: provenance.version,
			entryRelative: relative(provenance.packageDir, provenance.resolvedPath),
			localSha256: provenance.sha256,
		})
		provenance = await describeSwarmProvenance({ env, registryComparison: comparison })
	}

	// ── 真实集成检查 ──────────────────────────────────────────────────────
	let shape = null
	let results = []
	if (moduleState.available) {
		shape = inspectSwarmExports(moduleState.module)
		// 缺导出就不跑了:跑下去只会得到一堆同源的 TypeError,把"不兼容"淹没在噪声里
		if (shape.ok) {
			const checkSpecifier = provenance.resolvedPath ?? opts.module ?? SWARM_SPECIFIER
			results = await runChecksIsolated(checkSpecifier)
		}
	}

	// selfCheck 进判定:自检红了,这份结果 JSON 就不许自称 pass/blocked(只改退出码不够 ——
	// 下游读的是 JSON)。
	const decision = classify({ moduleState, exports: shape, results, selfCheck })

	// ── 证据落盘:哈希实际计算,不手填 ────────────────────────────────────
	const checksLogPath = join(opts.logDir, `${LAYER}-checks.log`)
	writeFileSync(checksLogPath, renderChecksLog({ provenance, moduleState, shape, results, selfCheck, verdict: decision.verdict }))
	const rawResultsPath = join(opts.logDir, `${LAYER}-checks.json`)
	writeFileSync(rawResultsPath, JSON.stringify({ selfCheck, results, provenance, moduleAvailable: moduleState.available, moduleReason: moduleState.reason, exports: shape }, null, 2) + '\n')

	const tree = worktreeDigest(REPO_ROOT)
	const endedAt = new Date().toISOString()
	const exitCode = decision.verdict === 'pass' ? 0 : decision.verdict === 'fail' ? 1 : 2

	const result = buildLayerResult({
		layer: LAYER,
		verdict: decision.verdict,
		sourceCommit: tree.head ?? 'unavailable',
		worktreeDigest: tree.digest,
		command,
		startedAt,
		endedAt,
		exitCode,
		platform: platformInfo(),
		moduleProvenance: [{
			specifier: provenance.specifier ?? SWARM_SPECIFIER,
			resolvedPath: provenance.resolvedPath,
			version: provenance.version,
			sha256: provenance.sha256,
			origin: provenance.origin,
			originNote: provenance.originNote,
			resolutionSource: provenance.source,
			lockfileClaim: provenance.lockfileClaim ?? null,
			evidence: provenance.evidence ?? [],
		}],
		counts: decision.counts,
		blockedReason: decision.blockedReason,
		recoveryCommand: decision.recoveryCommand,
		// 仓内的日志记相对路径(便于跨机器比对),仓外的记绝对路径 —— 一个 `../..` 开头的
		// 相对路径对消费端毫无意义,而 --logdir 指到仓外是常态。
		logs: [checksLogPath, rawResultsPath].map((p) => {
			const rel = relative(REPO_ROOT, p)
			return { path: rel.startsWith('..') ? p : rel, sha256: sha256File(p) }
		}),
		extra: {
			// 入口自检单列。它**不是**真实集成证据,字段名与注释都写死这一点。
			selfCheck: { ...selfCheck, disclaimer: '入口自检使用桩模块,仅证明本入口有区分力;不得计入或呈现为真实集成通过。' },
			// 自检否决时,把否决理由摆到 extra 顶层:verdict=fail 而 blockedReason=null 的组合
			// 在别的分支里意味着"真实检查跑红了",两者必须能一眼区分开。
			...(decision.selfCheckFailure ? { selfCheckFailure: decision.selfCheckFailure } : {}),
			checks: results.map(({ stack, ...rest }) => rest),
			exportsInspected: shape,
		},
	})

	const errors = validateLayerResult(result, { layer: LAYER })
	if (errors.length > 0) {
		console.error('结果 JSON 不符合 integration-layer@1 契约,拒绝写出:')
		for (const e of errors) console.error(`  ${e.code}: ${e.detail}`)
		return 1
	}
	writeLayerResult(jsonPath, result)

	// ── 摘要 ──────────────────────────────────────────────────────────────
	const c = decision.counts
	console.log(`[swarm] verdict=${decision.verdict}  pass=${c.pass} fail=${c.fail} skip=${c.skip} blocked=${c.blocked}`)
	console.log(`[swarm] 模块来源: ${provenance.origin} @ ${provenance.resolvedPath ?? '(未解析到文件)'}${provenance.version ? ` (v${provenance.version})` : ''}`)
	if (provenance.sha256) console.log(`[swarm] sha256: ${provenance.sha256}`)
	console.log(`[swarm] 入口自检(桩,不计入集成结果): ${selfCheck.pass}/${selfCheck.total} 通过`)
	if (decision.blockedReason) {
		console.log(`[swarm] blocked: ${decision.blockedReason}`)
		console.log(`[swarm] 恢复: ${(decision.recoveryCommand ?? RECOVERY_COMMAND).join(' ')}`)
	}
	for (const r of results.filter((x) => x.status === 'fail')) console.log(`[swarm]   FAIL ${r.id} ${r.title}\n            ${r.error}`)
	console.log(`[swarm] 结果 JSON: ${jsonPath}`)
	if (!selfCheck.ok) {
		console.error(`[swarm] ${decision.selfCheckFailure}`)
		for (const c of selfCheck.cases.filter((x) => x.status !== 'pass')) {
			console.error(`[swarm]   SELFCHECK-FAIL ${c.id} ${c.title}\n            ${c.error}`)
		}
	}
	return exitCode
}

main().then((code) => { process.exitCode = code }, (error) => {
	console.error(`[swarm] 入口异常:${error?.stack ?? error}`)
	process.exitCode = 1
})
