/**
 * 「本地代码门」这一层 = **调用**现有的 `scripts/acceptance/run-acceptance.mjs`,把它的
 * `agos-acceptance/results@1` JSON 翻译成 `integration-layer@1`。
 *
 * 为什么是适配而不是重写:现有验收器已经承载了代码闸/漂移分离、host-modules-check、
 * host-tree、自检接入、计数下限、诚实判定这一整套语义,还有 45 条负控守着它。再造一个
 * "矩阵版验收器"只会产生第二套会漂移的语义,而两套语义不一致时,人只会信让自己高兴的那套。
 * 所以这里只做两件事:原样跑它(默认不加任何改变语义的参数),以及**读懂它的自述**。
 *
 * 读懂自述里最关键的一条是 `authoritative`。验收器对 `--plan` / `--required-plugins` /
 * `--plugins-root` / `--selftest-file` / `--surface` / `--host-integrations` /
 * `AGOS_ACCEPTANCE_SELFTEST=1` / `--floors=none` 这些接缝的处理是:照跑、照给退出码,
 * 但把本次运行标成 `authoritative:false`。也就是说 **`--plan=<全绿的假计划>` 能让它退 0**。
 * 一个只看退出码的采集器会把这种运行当成"代码门通过" —— 矩阵必须看这个标志:
 * 非权威运行判 `blocked`(拿不到有效的代码门结论),绝不判 pass。
 */
import { existsSync, readFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { buildLayerResult, emptyCounts, platformInfo } from './layer-result.mjs'
import { sha256File } from './evidence.mjs'

export const ACCEPTANCE_SCHEMA = 'agos-acceptance/results@1'
export const ACCEPTANCE_SCRIPT = 'scripts/acceptance/run-acceptance.mjs'

/**
 * 默认 argv。**只加 `--json` / `--logdir` 这两个不改判定语义的参数**;
 * `--with-frontend` 之类由调用方通过 extra 显式追加,矩阵自己不替操作者做这个决定。
 */
export function defaultCodeGateArgv({ jsonOut, logDir, extra = [] }) {
	return ['node', ACCEPTANCE_SCRIPT, `--json=${jsonOut}`, `--logdir=${logDir}`, ...extra]
}

/** 代码门这层的模块来源 = 决定判定的那几个仓内文件的真实内容哈希(含计数下限基线)。 */
export function codeGateProvenance(repoRoot) {
	const files = [
		[ACCEPTANCE_SCRIPT, '被调用的验收器本体'],
		['scripts/acceptance/lib/exec.mjs', '诚实判定(verdictOf)与子进程执行层'],
		['scripts/acceptance/expected-counts.json', '计数下限基线 —— 它变了,同一份代码的判定就可能变'],
		['scripts/acceptance/selftest.mjs', '验收器负控自检,被接进默认计划'],
	]
	const out = []
	for (const [rel, note] of files) {
		const abs = join(repoRoot, rel)
		out.push({
			specifier: rel,
			resolvedPath: rel,
			version: null,
			sha256: sha256File(abs),
			origin: 'local-build',
			originNote: existsSync(abs) ? note : `${note}(文件不存在)`,
		})
	}
	return out
}

/**
 * 把验收器的 JSON 翻成一层结果。
 *
 * @returns `{ result, verdict, reason, acceptance }` —— result 是 integration-layer@1 对象。
 */
export function adaptAcceptanceResults({
	repoRoot, jsonPath, argv, cwd, exitCode, spawnError, startedAt, endedAt, timedOut, timeoutMs,
	sourceCommit, worktreeDigest, matrixLog,
}) {
	const base = {
		layer: 'code-gate',
		sourceCommit,
		worktreeDigest,
		command: argv,
		startedAt,
		endedAt,
		exitCode,
		platform: platformInfo(),
		moduleProvenance: codeGateProvenance(repoRoot),
		extra: { cwd, acceptanceJson: existsSync(jsonPath) ? jsonPath : null, spawnError: spawnError ?? null, timedOut: timedOut === true },
	}
	const logs = []
	// Keep malformed claims visible to verifyLogs; silently dropping them makes
	// incomplete evidence look complete.
	const pushLog = (p, sha) => logs.push({ path: p, sha256: sha })
	if (matrixLog) pushLog(matrixLog, sha256File(matrixLog))

	const fail = (reason, detail) => ({
		verdict: 'fail',
		reason,
		acceptance: null,
		result: buildLayerResult({ ...base, verdict: 'fail', counts: { ...emptyCounts(), fail: 1 }, logs, extra: { ...base.extra, failDetail: detail } }),
	})

	if (timedOut) {
		return fail(`timeout-after:${timeoutMs}ms`, `验收器被矩阵按 ${timeoutMs}ms 超时砍掉(真实退出码 ${exitCode};node --test 会把 SIGTERM 转成普通退出码,别读成断言失败)`)
	}
	if (spawnError) return fail('spawn-failed', String(spawnError))
	if (!existsSync(jsonPath)) {
		return fail('missing-acceptance-json', `验收器退出码 ${exitCode},但没有写出 ${jsonPath} —— 没有结果就不能有结论`)
	}
	const raw = readFileSync(jsonPath, 'utf8')
	if (raw.trim() === '') return fail('empty-acceptance-json', `${jsonPath} 是空的`)
	let acc = null
	try {
		acc = JSON.parse(raw)
	} catch (err) {
		return fail('invalid-acceptance-json', `${jsonPath} 解析失败: ${err.message}`)
	}
	if (acc === null || typeof acc !== 'object' || Array.isArray(acc)) return fail('invalid-acceptance-json', '顶层不是对象')
	if (acc.schema !== ACCEPTANCE_SCHEMA) {
		return fail('acceptance-schema-mismatch', `schema = ${JSON.stringify(acc.schema)},期望 ${ACCEPTANCE_SCHEMA}`)
	}
	const plain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
	const codeGate = acc.codeGate
	const advisory = acc.advisory
	if (!plain(codeGate) || !Array.isArray(codeGate.suites) || !Array.isArray(codeGate.failedGates)
		|| !plain(advisory) || !Array.isArray(advisory.results)
		|| codeGate.suites.some((v) => !plain(v)) || advisory.results.some((v) => !plain(v))) {
		return fail('invalid-acceptance-shape', 'codeGate/advisory 容器必须是对象，suites/failedGates/results 必须是数组，且每个条目必须是对象')
	}
	if (codeGate.suites.length === 0) {
		return fail('invalid-acceptance-shape', 'codeGate.suites 不能为空：没有任何验收 suite 日志就没有代码门证据')
	}

	const totals = acc.codeGate?.totals ?? null
	const invalidTotals = (t) => t === null || typeof t !== 'object' || Array.isArray(t)
		|| ['tests', 'pass', 'fail', 'skipped', 'cancelled'].some((k) => !Number.isInteger(t[k]) || t[k] < 0)
		|| (t.todo !== undefined && (!Number.isInteger(t.todo) || t.todo < 0))
		|| t.tests !== t.pass + t.fail + t.skipped + t.cancelled + (t.todo ?? 0)
	const counts = invalidTotals(totals)
		? emptyCounts()
		: { pass: totals.pass, fail: totals.fail, skip: totals.skipped + totals.cancelled + (totals.todo ?? 0), blocked: 0 }
	if (invalidTotals(totals)) {
		return fail('invalid-acceptance-totals', `codeGate.totals 必须含 tests/pass/fail/skipped/cancelled 五个非负整数(可选 todo),且 tests 必须等于结果之和: ${JSON.stringify(totals)}`)
	}
	if (totals.cancelled > 0) {
		return fail('cancelled-tests', `codeGate.totals.cancelled=${totals.cancelled} —— 被取消的测试不是普通 skip，不能形成通过结论`)
	}

	for (const suite of acc.codeGate?.suites ?? []) pushLog(suite.log, suite.logSha256)
	for (const adv of acc.advisory?.results ?? []) pushLog(adv.log, adv.logSha256)
	pushLog(relative(repoRoot, resolve(jsonPath)).startsWith('..') ? jsonPath : relative(repoRoot, resolve(jsonPath)), sha256File(jsonPath))
	const malformedLogs = logs.flatMap((entry, index) => {
		if (typeof entry.path !== 'string' || entry.path === '') return [{ code: 'log-entry-missing-path', index }]
		if (typeof entry.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(entry.sha256)) return [{ code: 'log-entry-bad-digest', index, path: entry.path }]
		return []
	})
	if (malformedLogs.length > 0) {
		return fail(`evidence-integrity:${malformedLogs.map((m) => m.code).join(',')}`, `验收器结果含不完整日志证据: ${JSON.stringify(malformedLogs)}`)
	}
	if (acc.codeGate.green === true && (totals.fail > 0 || acc.codeGate.failedGates.length > 0)) {
		return fail('contradictory-green-summary', `codeGate.green=true 与 fail=${totals.fail} 或 failedGates=${acc.codeGate.failedGates.length} 矛盾`)
	}

	const withLogs = { ...base, logs, extra: { ...base.extra, acceptanceGitHead: acc.gitHead ?? null, acceptanceGitDirty: acc.gitDirty ?? null } }

	// authoritative 先于退出码判:一次 `--plan=假计划` 的运行**退出码就是 0**,
	// 先看退出码就会在这里给出"代码门通过",而这个结论的依据是一棵合成的假套件树。
	if (acc.authoritative !== true) {
		const seams = acc.syntheticSeams ?? {}
		const used = Object.entries(seams).filter(([, v]) => v !== null && v !== false).map(([k, v]) => `${k}=${JSON.stringify(v)}`)
		const detail = used.length
			? `验收器自报 authoritative=false,合成接缝: ${used.join('、')}`
			: ' 验收器自报 authoritative=false(常见于 --floors=none:本次运行没有计数下限约束)'
		return {
			verdict: 'blocked',
			reason: 'non-authoritative-code-gate',
			acceptance: acc,
			result: buildLayerResult({
				...withLogs,
				verdict: 'blocked',
				counts: { ...counts, blocked: 1 },
				blockedReason: `${detail}。这样的运行不代表真实仓库状态,退出码 ${acc.processExitCode ?? exitCode} 也就不能算作代码门通过。`,
				recoveryCommand: ['node', ACCEPTANCE_SCRIPT, '--json=<out>', '--logdir=<dir>'],
			}),
		}
	}

	const green = acc.codeGate?.green === true && exitCode === 0
	if (!green) {
		const failed = (acc.codeGate?.failedGates ?? []).map((g) => `${g.id}:${g.verdict}(${g.reason})`)
		return {
			verdict: 'fail',
			reason: failed.length ? `failed-gates:${failed.length}` : `nonzero-exit:${exitCode}`,
			acceptance: acc,
			result: buildLayerResult({ ...withLogs, verdict: 'fail', counts, extra: { ...withLogs.extra, failedGates: failed } }),
		}
	}
	if (counts.pass === 0) {
		return {
			verdict: 'fail',
			reason: 'zero-passing-tests',
			acceptance: acc,
			result: buildLayerResult({ ...withLogs, verdict: 'fail', counts }),
		}
	}
	return {
		verdict: 'pass',
		reason: 'ok',
		acceptance: acc,
		result: buildLayerResult({ ...withLogs, verdict: 'pass', counts }),
	}
}
