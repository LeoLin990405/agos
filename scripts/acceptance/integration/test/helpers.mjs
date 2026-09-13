/**
 * 负控测试的执行助手。
 *
 * 两条纪律:
 *   - **继承的 `HOME` / `CODEX_HOME` 一个字都不动**(连显式设回原值都不做)。子进程隔离靠
 *     `mkdtemp` 出来的日志目录与任务专用参数,不靠改这两个变量。
 *   - 必须剔掉 `NODE_TEST_CONTEXT` / `NODE_OPTIONS`:这些测试本身跑在 `node --test` 里,
 *     把它传给孙子进程会让嵌套的 `node --test` "skipping running files" —— 一个测试不跑却退 0,
 *     正是本仓一直在追的那类假绿。
 */
import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

export const HERE = dirname(new URL(import.meta.url).pathname)
export const INTEGRATION_DIR = resolve(HERE, '..')
export const REPO = resolve(INTEGRATION_DIR, '..', '..', '..')
export const MATRIX = join(INTEGRATION_DIR, 'run-matrix.mjs')
export const PRODUCER = join(HERE, 'fixtures', 'producer.mjs')
export const FAKE_ACCEPTANCE = join(HERE, 'fixtures', 'fake-acceptance.mjs')

/** 一个测试一个临时根:日志目录不共用,失败日志不会被下一条测试盖掉。 */
export function tempRoot(tag) {
	return mkdtempSync(join(tmpdir(), `agos-matrix-${tag}-`))
}

function childEnv() {
	const env = { ...process.env }
	delete env.NODE_TEST_CONTEXT
	delete env.NODE_OPTIONS
	return env
}

/** 把矩阵当真子进程跑。返回真实退出码、原样输出,以及它写出的 JSON(存在才读)。 */
export function runMatrix(argv, { cwd = REPO, timeoutMs = 120000 } = {}) {
	const res = spawnSync('node', [MATRIX, ...argv], {
		cwd, env: childEnv(), encoding: 'utf8', timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024,
	})
	const stdout = res.stdout ?? ''
	const stderr = res.stderr ?? ''
	const jsonArg = argv.find((a) => a.startsWith('--json='))
	const jsonPath = jsonArg ? jsonArg.slice('--json='.length) : null
	let json = null
	if (jsonPath && existsSync(jsonPath)) {
		try {
			json = JSON.parse(readFileSync(jsonPath, 'utf8'))
		} catch {
			json = null
		}
	}
	return {
		exitCode: res.status,
		signal: res.signal,
		stdout,
		stderr,
		output: stdout + stderr,
		json,
	}
}

const ALL_LAYERS = ['code-gate', 'swarm', 'linux', 'host-browser']

/**
 * 本次负例**不涉及**的层一律显式 --skip。
 *
 * 不这么做的话,矩阵会去默认位置探测 A/B/C 的真入口 —— 它们都已经落地了 —— 于是每条负例
 * 都会顺带跑一遍真 Linux 隔离检查和真宿主浏览器联测(实测:一次全量负控从 22 秒涨到 3 分钟
 * 还没跑完,而且会在别的代理正在改同一棵树时反复拉起浏览器)。负例要验的是矩阵的判定,
 * 不是别人的入口。
 */
function skipOthers(...active) {
	return ALL_LAYERS.filter((l) => !active.includes(l))
}

/** 用桩生产者驱动某一层的一次矩阵运行。返回 runMatrix 的结果加上该层的采集记录。 */
export function runWithProducer({ tag, layer = 'swarm', mode, extraArgv = [], require: req = [layer], timeoutMs }) {
	const root = tempRoot(tag)
	const logDir = join(root, 'run')
	const jsonOut = join(root, 'matrix.json')
	const argv = [
		`--logdir=${logDir}`,
		`--json=${jsonOut}`,
		`--require=${req.join(',')}`,
		`--skip=${skipOthers(layer).join(',')}`,
		`--layer-argv=${layer}=${JSON.stringify(['node', PRODUCER, `--mode=${mode}`, `--layer=${layer}`, `--out=${join(logDir, `${layer}.json`)}`, `--logdir=${logDir}`])}`,
		...extraArgv,
	]
	const r = runMatrix(argv, { timeoutMs })
	return { ...r, root, logDir, jsonOut, layerRecord: r.json?.layers?.find((l) => l.layer === layer) ?? null }
}

/** 用假验收器驱动一次代码门采集。 */
export function runWithFakeAcceptance({ tag, mode, extraArgv = [], require: req = ['code-gate'], skipIntegration = true }) {
	const root = tempRoot(tag)
	const logDir = join(root, 'run')
	const jsonOut = join(root, 'matrix.json')
	const argv = [
		`--logdir=${logDir}`,
		`--json=${jsonOut}`,
		`--require=${req.join(',')}`,
		`--code-gate-argv=${JSON.stringify(['node', FAKE_ACCEPTANCE, `--mode=${mode}`, `--json=${join(logDir, 'code-gate.acceptance.json')}`, `--logdir=${join(logDir, 'code-gate-logs')}`])}`,
		...(skipIntegration ? [`--candidates-root=${join(root, 'empty')}`] : []),
		...extraArgv,
	]
	const r = runMatrix(argv)
	return { ...r, root, logDir, jsonOut, codeRecord: r.json?.layers?.find((l) => l.layer === 'code-gate') ?? null }
}

/** 拒绝理由里有没有某个码(可选:限定层)。 */
export function hasRefusal(json, code, layer = undefined) {
	return (json?.claims?.refusals ?? []).some((r) => r.code === code && (layer === undefined || r.layer === layer))
}
