// Fail-closed argv 检查:未知 `--token`、以及只允许 `--name=value` 时的裸 `--name`,
// 一律立刻退 78 并点名该 token。
//
// 同一类缺陷已经咬过两次:
//   · run-acceptance.mjs 裸 `--write-floors` 被静默忽略(NC19c)
//   · measure-dependency-surface.mjs `--print` 被吞掉后覆写 tracked 基线(NC21)
// 能改写 tracked 文件 / 安装根的脚本必须在任何写入之前拒绝无法识别的输入。
//
// 位置参数默认不当未知;脚本声明自己没有位置参数时才拒。

export const UNKNOWN_ARGV_EXIT = 78

/** verify-host-tree.mjs:--write 是故意的裸改写标志;其余取值项必须带 =。 */
export const VERIFY_HOST_TREE_ARGV = {
	flags: ['write'],
	opts: ['repo-root', 'baseline', 'lockfile', 'json'],
	allowPositionals: false,
}

/** prepare-host-modules.mjs:没有 --out;--prefix 等必须带 =。 */
export const PREPARE_HOST_MODULES_ARGV = {
	flags: ['check', 'link', 'offline', 'strict-pins', 'strict-graph'],
	opts: [
		'copy-from', 'registry', 'prefix', 'json', 'graph-json',
		'allow-write-root', 'layers', 'surface', 'repo-root', 'host-integrations',
	],
	allowPositionals: false,
}

/** measure-dependency-surface.mjs:默认 --out 是 tracked 基线;--print 不存在。 */
export const MEASURE_DEPENDENCY_SURFACE_ARGV = {
	flags: ['no-shield'],
	opts: ['out', 'plugin', 'logdir'],
	allowPositionals: false,
}

/**
 * run-matrix.mjs:--print-plan 是只打印计划的裸标志;--print 不存在。
 * `--layer-producer=swarm=/tmp/x.mjs` 这类取值含 `=`,inspectArgv 只按第一个 `=` 切开。
 */
export const RUN_MATRIX_ARGV = {
	flags: ['print-plan', 'all', 'allow-existing-logdir'],
	opts: [
		'only', 'require', 'skip', 'logdir', 'json',
		'layer-producer', 'layer-argv', 'layer-timeout',
		'code-gate-argv', 'code-gate-extra', 'candidates-root',
	],
	allowPositionals: false,
}

/**
 * 纯函数:对照 spec 检查 argv,不退出。
 *
 * @param {string[]} argv
 * @param {{ flags?: string[], opts?: string[], allowPositionals?: boolean }} [spec]
 * @returns {{ ok: true } | { ok: false, token: string, kind: 'unknown' | 'bare-opt' | 'empty-opt' | 'positional', message: string }}
 */
export function inspectArgv(argv, spec = {}) {
	const flags = new Set(spec.flags ?? [])
	const opts = new Set(spec.opts ?? [])
	const allowPositionals = spec.allowPositionals !== false

	for (const token of argv) {
		if (!token.startsWith('-')) {
			if (allowPositionals) continue
			return reject(token, 'positional', `❌ 无法识别的参数:${token}`)
		}
		if (!token.startsWith('--') || token === '--') {
			return reject(token, 'unknown', `❌ 无法识别的参数:${token}`)
		}
		const eq = token.indexOf('=')
		if (eq === -1) {
			const name = token.slice(2)
			if (flags.has(name)) continue
			if (opts.has(name)) {
				return reject(token, 'bare-opt', `❌ ${token} 需要显式值:--${name}=<值>`)
			}
			return reject(token, 'unknown', `❌ 无法识别的参数:${token}`)
		}
		const name = token.slice(2, eq)
		const value = token.slice(eq + 1)
		if (!opts.has(name)) {
			return reject(token, 'unknown', `❌ 无法识别的参数:${token}`)
		}
		if (value === '') {
			return reject(token, 'empty-opt', `❌ --${name}= 需要非空值:--${name}=<值>`)
		}
	}
	return { ok: true }
}

/**
 * 未知 / 裸取值项 / 空取值 → 点名 token 并 exit 78。
 * 必须在任何写入之前调用。
 */
export function assertKnownArgv(argv, spec = {}) {
	const result = inspectArgv(argv, spec)
	if (result.ok) return
	console.error(result.message)
	const legal = [
		...(spec.opts ?? []).map((n) => `--${n}=<值>`),
		...(spec.flags ?? []).map((n) => `--${n}`),
	]
	if (legal.length > 0) console.error(`   合法参数:${legal.join('  ')}`)
	console.error('   静默忽略未知参数后仍可能改写版本控制里的基线,所以必须立刻退 78。')
	process.exit(UNKNOWN_ARGV_EXIT)
}

function reject(token, kind, message) {
	return { ok: false, token, kind, message }
}
