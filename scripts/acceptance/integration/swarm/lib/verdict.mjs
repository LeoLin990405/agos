/**
 * swarm 层的判定 —— 从"模块状态 + 逐条检查结果"到 verdict。
 *
 * 抽成纯函数是为了让**入口自检**能直接喂它各种组合而不必真跑一遍集成:
 * 判定逻辑本身是最该被负例打的地方,而它恰恰最难在真实运行里制造出来
 * (你没法让真模块"缺一个导出"给你看)。
 *
 * 三条纪律,与 `../lib/layer-result.mjs` 的 `resolveVerdict` 同源(那边是消费端复核,
 * 这边是生产端自律;两边都要过,才不会出现"生产端说 pass、消费端降级"的尴尬):
 *   1. 模块不可用 / 缺导出 → `blocked`,**不是** fail。区别是实打实的:
 *      fail 说"代码坏了",blocked 说"这台机器上没法验" —— 处置完全不同。
 *   2. 模块可用但检查跑红 → `fail`。这时候不许退回 blocked 装作"环境问题"。
 *   3. 一条检查都没跑过 → 绝不 pass。空集合的"零失败"是最廉价的假绿。
 *   4. 入口自检红了 → 整层 `fail`,盖过上面三条。自检红意味着这个入口自己
 *      分不清好坏,那它对真实模块给出的任何判定(包括 blocked)都不可信。
 */

export const RECOVERY_COMMAND = Object.freeze([
	'AGOS_SWARM_MODULE=/path/to/dsh-kimicode-swarm/lib/index.js',
	'node', 'scripts/acceptance/integration/swarm/run.mjs', '--logdir=<logdir>',
])

/**
 * @param {object} input
 * @param {{available: boolean, reason: string|null}} input.moduleState resolveSwarmModule 的结果
 * @param {{ok: boolean, missing: string[], wrongType: Array}|null} input.exports inspectSwarmExports 的结果
 * @param {Array<{id: string, status: 'pass'|'fail'}>} input.results 逐条检查结果
 * @param {{ok: boolean, pass: number, total: number}|null} [input.selfCheck] runSelfCheck 的结果;
 *        省略表示"本次没跑自检",不参与判定。传了且 `ok === false` 就一票否决。
 * @returns {{verdict: string, counts: object, blockedReason: string|null, recoveryCommand: string[]|null}}
 */
export function classify({ moduleState, exports: shape, results = [], selfCheck = null }) {
	const counts = { pass: 0, fail: 0, skip: 0, blocked: 0 }
	for (const r of results) {
		if (r.status === 'pass') counts.pass += 1
		else if (r.status === 'fail') counts.fail += 1
		else if (r.status === 'skip') counts.skip += 1
		else counts.blocked += 1
	}

	// ⓪ 自检红 → 一票否决,盖过下面所有分支。
	//
	//    这条是被削弱反证逼出来的:早先自检失败只改退出码,结果 JSON 里照样写 verdict=pass。
	//    把 classify 改成"有 fail 也判 pass"之后,进程确实 exit=1,但落盘的那份结果
	//    仍然自称通过 —— 而 TASKS.md 的契约里,下游读的正是这份 JSON,不是退出码。
	//    换句话说:那时候只要判定逻辑本身坏了,坏掉的判定就会被原样写进证据里。
	if (selfCheck && selfCheck.ok === false) {
		return {
			verdict: 'fail',
			counts,
			blockedReason: null,
			recoveryCommand: null,
			selfCheckFailure: `入口自检未通过(${selfCheck.pass ?? '?'}/${selfCheck.total ?? '?'})——`
				+ '本入口已被证明分不清好坏桩,它对真实模块给出的任何判定都不足采信。',
		}
	}

	// ① 模块根本不在 → blocked。整层记一个 blocked 计数,而不是把它算成 0 个检查。
	if (!moduleState?.available) {
		return {
			verdict: 'blocked',
			counts: { ...counts, blocked: Math.max(counts.blocked, 1) },
			blockedReason: `真实 swarm 模块不可用,集成层无法验证:${moduleState?.reason ?? '(解析器没有给出原因,这本身是个缺陷)'}`,
			recoveryCommand: [...RECOVERY_COMMAND],
		}
	}

	// ② 模块在但不兼容(registry 版就是这样:能加载,一个需要的符号都不导出)→ 仍是 blocked,
	//    但原因必须点名**缺了哪些**,不能与"没装"混同。
	if (shape && !shape.ok) {
		const missing = shape.missing.join(', ') || '(无)'
		const wrong = shape.wrongType.map((w) => `${w.name}(期望 ${w.want},实际 ${w.got})`).join(', ') || '(无)'
		return {
			verdict: 'blocked',
			counts: { ...counts, blocked: Math.max(counts.blocked, 1) },
			blockedReason: `解析到 swarm 模块但它与 AgOS 不兼容 —— 缺少导出:${missing};类型不对:${wrong}。`
				+ 'registry 的 0.1.0/0.1.1/0.1.2 三版都是这种情况(只导出 6 个符号),'
				+ '真实宿主用的是本地对齐构建版。',
			recoveryCommand: [...RECOVERY_COMMAND],
		}
	}

	// ③ 模块可用却一条都没跑 → 不是 pass。空集合的零失败是最廉价的假绿。
	if (results.length === 0) {
		return {
			verdict: 'blocked',
			counts: { ...counts, blocked: Math.max(counts.blocked, 1) },
			blockedReason: '模块可用,但一条集成检查都没有执行 —— 零失败在这里不构成通过,'
				+ '通常意味着检查集合构造失败或被过滤空了。',
			recoveryCommand: [...RECOVERY_COMMAND],
		}
	}

	// ④ 跑红了就是 fail。模块在场时不许退回 blocked 装成"环境问题"。
	if (counts.fail > 0) {
		return { verdict: 'fail', counts, blockedReason: null, recoveryCommand: null }
	}

	return { verdict: 'pass', counts, blockedReason: null, recoveryCommand: null }
}
