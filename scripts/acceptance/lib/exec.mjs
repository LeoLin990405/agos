// 共享执行层:跑子进程、解析 node --test 摘要、算诚实判定。
// 设计约束(A 包硬要求):生产者退出码原样保留;0 测试不算过;skip 永不并入 pass;
// 缺依赖是带诊断的失败,不是 skip-as-pass。
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync, readFileSync, existsSync, realpathSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'

export const REPO_ROOT = realpathSync(resolve(dirname(new URL(import.meta.url).pathname), '..', '..', '..'))

/** node --test 摘要行:`ℹ pass 7`。整段没有摘要 → 返回 null(判定层据此拒绝算过)。 */
export function parseNodeTestCounts(text) {
	const keys = ['tests', 'suites', 'pass', 'fail', 'cancelled', 'skipped', 'todo']
	const counts = {}
	for (const line of text.split('\n')) {
		const m = /^(?:ℹ|info)\s+(tests|suites|pass|fail|cancelled|skipped|todo)\s+(\d+)\s*$/.exec(line.trim())
		if (m) counts[m[1]] = Number(m[2])
	}
	for (const k of keys) if (!(k in counts)) return null
	return counts
}

/** 抓 ESM/CJS 找不到包的报错,回报具体缺哪个裸包(诊断用,不猜)。 */
export function detectMissingModules(text) {
	const found = new Set()
	const patterns = [
		/Cannot find package '([^']+)'/g,
		/Cannot find module '([^']+)'/g,
		/Failed to resolve module specifier '([^']+)'/g,
	]
	for (const re of patterns) {
		let m
		while ((m = re.exec(text)) !== null) {
			const spec = m[1]
			// 只回报裸规格(非相对、非绝对、非 node:),相对路径缺失是别的毛病。
			if (!spec.startsWith('.') && !spec.startsWith('/') && !spec.startsWith('node:')) {
				const parts = spec.split('/')
				found.add(spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0])
			}
		}
	}
	return [...found].sort()
}

/**
 * 中性环境:默认不读私有语料、不带任何供应商密钥。
 * 语料变量指向一个**不存在**的临时路径(与上一轮同法),而不是删掉变量——
 * 删掉会让代码走 HOME 探测分支,指到不存在的路径才真的关掉。
 */
export function neutralEnv(extra = {}) {
	const env = { ...process.env }
	const absent = join(tmpdir(), 'agos-acceptance-absent-corpus')
	env.SESSION_MEMORY_CORPUS_DIR = absent
	// 同理指向不存在的路径,而不是删变量:dsh-agos-router/lib/outcomes.js:191 的兜底是
	// join(homedir(), '.dsh', 'logs', 'fleet', 'runs.jsonl') —— 删掉变量就会落到操作者
	// **真实的** Fleet 历史上,套件结果于是取决于这台机器上跑过什么批次。
	// (只是读、不会写:C 在 outcomes.js:26 特意避开 new FleetLedger,因为构造即 autoCompact
	//  重写文件,「纯读」会变成写。所以这条是可复现性与隐私问题,不是数据破坏问题。)
	// 实测:置为不存在路径后 dsh-agos-router 122/122、dsh-fleet 148/148 仍全绿,
	// 也就是说套件本来就不依赖私有历史 —— 这里只是把「事实上自足」变成「结构上自足」。
	env.DSH_FLEET_RUNS_FILE = join(tmpdir(), 'agos-acceptance-absent-fleet-runs.jsonl')
	for (const k of [
		'SESSION_MEMORY_ACCEPT_BASELINE',
		'SESSION_MEMORY_ACCEPT_CORPUS',
		'SESSION_MEMORY_ACCEPT_REGRESSIONS',
		'SESSION_MEMORY_RULES_NOTE',
		'Z_AI_API_KEY',
		'GLM_API_KEY',
		'Z_AI_MODE',
		'OPENAI_API_KEY',
		'ANTHROPIC_API_KEY',
		'NODE_PATH',
		// 必须剔:验收器自己可能是在 `node --test`(A4 自检)里被调起来的。
		// NODE_TEST_CONTEXT 一旦传给子进程,子进程的 node --test 会认为自己是嵌套调用,
		// 直接"skipping running files"——一个测试都不跑却退出 0。
		// 那正是最危险的假绿,所以在这里斩断。
		'NODE_TEST_CONTEXT',
		'NODE_OPTIONS',
	]) delete env[k]
	env.AGOS_ACCEPTANCE = '1'
	return { ...env, ...extra }
}

export function sha256(buf) {
	return createHash('sha256').update(buf).digest('hex')
}

/**
 * 跑一条命令,把 stdout+stderr 落盘,返回真实退出码。
 * 绝不因为解析不到摘要就改写退出码。
 */
export function runCommand({ argv, cwd, env, logPath, timeoutMs = 300000 }) {
	const started = Date.now()
	const res = spawnSync(argv[0], argv.slice(1), {
		cwd,
		env: env ?? neutralEnv(),
		encoding: 'utf8',
		timeout: timeoutMs,
		maxBuffer: 64 * 1024 * 1024,
	})
	const durationSeconds = Number(((Date.now() - started) / 1000).toFixed(2))
	const stdout = res.stdout ?? ''
	const stderr = res.stderr ?? ''
	const output = stdout + (stderr ? (stdout.endsWith('\n') || stdout === '' ? '' : '\n') + stderr : '')
	// spawn 层面的失败(命令不存在/超时)没有 status:必须是非零,不能当成 0。
	let exitCode = res.status
	let spawnError = null
	if (exitCode === null || exitCode === undefined) {
		spawnError = res.error ? String(res.error.message || res.error) : (res.signal ? `killed by signal ${res.signal}` : 'no exit status')
		exitCode = 126
	}
	if (logPath) {
		mkdirSync(dirname(logPath), { recursive: true })
		const header = [
			`# argv: ${JSON.stringify(argv)}`,
			`# cwd: ${cwd}`,
			`# exit: ${exitCode}${spawnError ? ` (spawn: ${spawnError})` : ''}`,
			`# duration_s: ${durationSeconds}`,
			'',
		].join('\n')
		writeFileSync(logPath, header + output)
	}
	return { argv, cwd, exitCode, spawnError, durationSeconds, output, logPath }
}

/**
 * 诚实判定。verdict:
 *   pass    退出 0 + 有摘要 + fail 0 + tests>0 + pass>0
 *   fail    退出非 0,或 fail>0,或压根没有摘要(测都没跑起来)
 *   empty   退出 0 但 tests 0 —— 明确**不算过**
 *   skipped 退出 0、有测试但一条都没真过(全 skip)—— 明确**不算过**
 */
export function verdictOf({ exitCode, counts, spawnError, minTests = null, minPass = null }) {
	if (spawnError) return { verdict: 'fail', reason: `spawn-failed: ${spawnError}` }
	if (exitCode !== 0) return { verdict: 'fail', reason: `nonzero-exit:${exitCode}` }
	if (counts === null) return { verdict: 'fail', reason: 'no-test-summary' }
	if (counts.fail > 0) return { verdict: 'fail', reason: `reported-failures:${counts.fail}` }
	if (counts.tests === 0) return { verdict: 'empty', reason: 'zero-tests-reported' }
	if (counts.pass === 0) return { verdict: 'skipped', reason: 'no-test-actually-passed' }
	// 计数下限闸:防"删测试/清空测试文件把闸弄绿"。
	// node --test 把一个**没注册任何测试**的文件本身算成 1 个通过的测试,
	// 所以光看 pass>0 抓不到被清空的套件 —— 只有对历史基线设下限才抓得到。
	if (minTests !== null && counts.tests < minTests) {
		return { verdict: 'fail', reason: `test-count-regression: tests ${counts.tests} < floor ${minTests}` }
	}
	if (minPass !== null && counts.pass < minPass) {
		return { verdict: 'fail', reason: `pass-count-regression: pass ${counts.pass} < floor ${minPass}` }
	}
	return { verdict: 'pass', reason: 'ok' }
}

/** 只有 pass 是绿。empty/skipped/fail 都不是。 */
export function isGreen(verdict) {
	return verdict === 'pass'
}

export function readJsonIfExists(p) {
	if (!existsSync(p)) return null
	try {
		return JSON.parse(readFileSync(p, 'utf8'))
	} catch {
		return null
	}
}

/** 路径是否落在某个前缀下(用于拒绝碰 ~/.dsh/profiles)。 */
export function isInside(child, parent) {
	const c = resolve(child)
	const p = resolve(parent)
	return c === p || c.startsWith(p.endsWith(sep) ? p : p + sep)
}
