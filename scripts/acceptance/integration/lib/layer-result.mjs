/**
 * 集成层结果格式 `agos-acceptance/integration-layer@1` —— 构造、校验、诚实降级。
 *
 * A(swarm)、B(linux)、C(host-browser)各自往 `<logdir>/<layer>.json` 写一份;矩阵读进来
 * 汇总。这个文件是三方共用的那份定义,所以生产端(`buildLayerResult`/`writeLayerResult`)
 * 与消费端(`validateLayerResult`/`resolveVerdict`)写在一起 —— 分成两份必然漂移。
 *
 * 三条判定纪律,与 `scripts/acceptance/lib/exec.mjs` 的 `verdictOf` 同源:
 *   1. `blocked` 是**第四种结局**,不是 pass 的变体,也不是 skip 的变体。它只能被"分列",
 *      不能被"合并"。
 *   2. 自相矛盾的结果按**坏的那一半**判。生产者说 pass 却报了 fail>0 / blocked>0 /
 *      一条都没真过 —— 这三种都不是 pass。判定权在消费端,因为生产者正是可能出错的那一方。
 *   3. 校验不通过的结果不叫"格式小问题",叫**没有结果**:一份字段缺失的 JSON 无法支撑
 *      任何结论,而它的存在会让人以为这一层跑过了。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { arch, platform, release } from 'node:os'

export const LAYER_SCHEMA = 'agos-acceptance/integration-layer@1'
export const LAYERS = ['code-gate', 'swarm', 'linux', 'host-browser']
export const VERDICTS = ['pass', 'fail', 'blocked', 'skipped']

/** 运行时身份。四个字段都来自真实探测,没有任何一个是常量。 */
export function platformInfo() {
	return { os: platform(), release: release(), arch: arch(), node: process.version }
}

export function emptyCounts() {
	return { pass: 0, fail: 0, skip: 0, blocked: 0 }
}

/**
 * 生产端助手:拼一份符合契约的结果对象。
 * 不做任何"补默认值让它看起来合法"的事 —— 缺什么就缺着,由 `validateLayerResult` 报出来。
 */
export function buildLayerResult(fields) {
	return {
		schema: LAYER_SCHEMA,
		layer: fields.layer,
		verdict: fields.verdict,
		sourceCommit: fields.sourceCommit,
		worktreeDigest: fields.worktreeDigest,
		command: fields.command,
		startedAt: fields.startedAt,
		endedAt: fields.endedAt,
		exitCode: fields.exitCode,
		platform: fields.platform ?? platformInfo(),
		moduleProvenance: fields.moduleProvenance ?? [],
		counts: { ...emptyCounts(), ...(fields.counts ?? {}) },
		blockedReason: fields.blockedReason ?? null,
		recoveryCommand: fields.recoveryCommand ?? null,
		logs: fields.logs ?? [],
		...(fields.extra ?? {}),
	}
}

export function writeLayerResult(path, result) {
	mkdirSync(dirname(path), { recursive: true })
	writeFileSync(path, JSON.stringify(result, null, 2) + '\n')
	return path
}

function isPlainObject(v) {
	return v !== null && typeof v === 'object' && !Array.isArray(v)
}

function isNonNegativeInt(v) {
	return Number.isInteger(v) && v >= 0
}

/**
 * 结构校验。返回错误码数组(空数组 = 合格),每条带人读得懂的 detail。
 *
 * `blocked` 的两条额外要求是本轮的硬要求「阻塞原因要具体,不是『环境不支持』这种」的
 * **机械化**版本:自然语言的"具体"没法判,但可以要求两件能被机器验的事 ——
 * 原因串足够长(≥ 16 字符,挡掉"不支持"/"n/a"这类),且必须附一条可复制的 `recoveryCommand`
 * argv。给不出恢复命令,基本就说明写的人自己也没定位到是什么挡住了。
 */
export function validateLayerResult(raw, { layer } = {}) {
	const errors = []
	const err = (code, detail) => errors.push({ code, detail })
	if (!isPlainObject(raw)) {
		err('not-an-object', `结果顶层不是对象: ${JSON.stringify(raw)}`)
		return errors
	}
	if (raw.schema !== LAYER_SCHEMA) err('schema-mismatch', `schema = ${JSON.stringify(raw.schema)},期望 ${LAYER_SCHEMA}`)
	if (!LAYERS.includes(raw.layer)) err('layer-unknown', `layer = ${JSON.stringify(raw.layer)},不在 ${LAYERS.join('/')} 之内`)
	else if (layer !== undefined && raw.layer !== layer) err('layer-mismatch', `结果自称 ${raw.layer},但它是作为 ${layer} 层采集的`)
	if (!VERDICTS.includes(raw.verdict)) err('verdict-invalid', `verdict = ${JSON.stringify(raw.verdict)},不在 ${VERDICTS.join('/')} 之内`)

	for (const [field, ok] of [
		['sourceCommit', typeof raw.sourceCommit === 'string' && raw.sourceCommit !== ''],
		['worktreeDigest', typeof raw.worktreeDigest === 'string' && raw.worktreeDigest !== ''],
		['startedAt', typeof raw.startedAt === 'string' && raw.startedAt !== ''],
		['endedAt', typeof raw.endedAt === 'string' && raw.endedAt !== ''],
		['exitCode', Number.isInteger(raw.exitCode)],
	]) {
		if (!ok) err(`missing-field:${field}`, `${field} 缺失或类型不对: ${JSON.stringify(raw[field])}`)
	}
	if (!Array.isArray(raw.command) || raw.command.length === 0 || !raw.command.every((a) => typeof a === 'string')) {
		err('command-invalid', `command 必须是非空的字符串 argv 数组(不是拼好的命令行字符串): ${JSON.stringify(raw.command)}`)
	}
	if (!isPlainObject(raw.platform) || ['os', 'release', 'arch', 'node'].some((k) => typeof raw.platform[k] !== 'string' || raw.platform[k] === '')) {
		err('platform-invalid', `platform 必须含 os/release/arch/node 四个非空字符串: ${JSON.stringify(raw.platform)}`)
	}
	if (raw.moduleProvenance !== undefined && !Array.isArray(raw.moduleProvenance)) {
		err('module-provenance-invalid', `moduleProvenance 必须是数组: ${JSON.stringify(raw.moduleProvenance)}`)
	}
	if (!isPlainObject(raw.counts) || ['pass', 'fail', 'skip', 'blocked'].some((k) => !isNonNegativeInt(raw.counts[k]))) {
		err('counts-invalid', `counts 必须含 pass/fail/skip/blocked 四个 ≥0 整数(四路分列,不合并): ${JSON.stringify(raw.counts)}`)
	}
	if (!Array.isArray(raw.logs)) err('logs-invalid', `logs 必须是数组: ${JSON.stringify(raw.logs)}`)

	if (raw.verdict === 'blocked') {
		const reason = raw.blockedReason
		if (typeof reason !== 'string' || reason.trim().length < 16) {
			err('blocked-reason-too-vague', `verdict=blocked 时 blockedReason 必须是 ≥16 字符的具体原因,当前 ${JSON.stringify(reason)} —— 「环境不支持」这类说法定位不到任何东西`)
		}
		if (!Array.isArray(raw.recoveryCommand) || raw.recoveryCommand.length === 0 || !raw.recoveryCommand.every((a) => typeof a === 'string')) {
			err('blocked-without-recovery', `verdict=blocked 时必须给可复制的 recoveryCommand argv,当前 ${JSON.stringify(raw.recoveryCommand)}`)
		}
	}
	return errors
}

/**
 * 消费端判定:结果自称的 verdict 与它自己的计数矛盾时,按坏的那一半算。
 * @returns `{ verdict, reason, downgradedFrom }`
 */
export function resolveVerdict(raw) {
	const claimed = raw.verdict
	const c = raw.counts ?? emptyCounts()
	if (claimed === 'pass') {
		if (c.fail > 0) return { verdict: 'fail', reason: `self-contradictory: 自称 pass 但 counts.fail=${c.fail}`, downgradedFrom: 'pass' }
		if (c.blocked > 0) return { verdict: 'blocked', reason: `self-contradictory: 自称 pass 但 counts.blocked=${c.blocked} —— blocked 不能并进 pass`, downgradedFrom: 'pass' }
		if (c.pass === 0) return { verdict: 'fail', reason: 'pass-without-any-passing-check: 自称 pass 但一条检查都没真过(counts.pass=0)', downgradedFrom: 'pass' }
	}
	if (claimed === 'skipped' && c.blocked > 0) {
		return { verdict: 'blocked', reason: `self-contradictory: 自称 skipped 但 counts.blocked=${c.blocked}`, downgradedFrom: 'skipped' }
	}
	return { verdict: claimed, reason: 'as-reported', downgradedFrom: null }
}

/** 只有 pass 是绿。fail / blocked / skipped 都不是。 */
export function isLayerGreen(verdict) {
	return verdict === 'pass'
}

/**
 * 层结果声称的工作树摘要与矩阵实测不一致时怎么判。
 *
 * 两种解释,判法不同,但**都不是 pass** —— 这是关键。摘要对不上意味着这份结论没法被钉到
 * 一棵确定的树上,而「钉不到哪棵树」的结论无法复现,也就无法反驳。
 *
 *   树在本次运行期间没变过 → 只剩一种解释:这份结果量的是**另一棵**树(复制来的旧结果、
 *     跑在别的 checkout 上、或者摘要是编的)。判 `fail`。
 *   树在本次运行期间被别的进程改过(并行代理同时在写同一个工作区)→ 不一致解释得通,
 *     不该判成"结果造假";但也不能当没事 —— 判 `blocked`,让操作者在安静的树上复跑。
 *
 * 之所以不走「不稳定就放过」:那等于把「只要有别的进程在写文件,摘要检查就自动关掉」
 * 写进设计,而这条件在本轮的并行工作区里天天成立。
 */
export function digestDriftVerdict({ treeStable, declared, matrix, layer }) {
	const short = (s) => (typeof s === 'string' ? s.slice(0, 16) : String(s))
	if (treeStable) {
		return {
			verdict: 'fail',
			reason: `stale-layer-result:worktree 声称 ${short(declared)}… ≠ 矩阵实测 ${short(matrix)}…(本次运行期间工作树没有变化,不一致只能是量了另一棵树)`,
			blockedReason: null,
			recoveryCommand: null,
		}
	}
	return {
		verdict: 'blocked',
		reason: `unattributable-worktree:${layer} 声称 ${short(declared)}… ≠ 矩阵实测 ${short(matrix)}…,且工作树在本次运行期间确实被改动过`,
		blockedReason: `${layer} 层的结果无法归属到一棵确定的工作树:它声称的摘要是 ${short(declared)}…,矩阵实测是 ${short(matrix)}…,而本次运行期间工作树被其他进程改动过(并行代理)。结论钉不到具体哪棵树上,因此不能算通过。`,
		recoveryCommand: ['node', 'scripts/acceptance/integration/run-matrix.mjs', `--require=${layer}`],
	}
}
