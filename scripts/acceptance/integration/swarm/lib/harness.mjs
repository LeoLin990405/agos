/**
 * 宿主侧替身 —— 喂给**真实** swarm 调度器的假 ctx / 假子代理 / 假时钟。
 *
 * ⚠️ 这里假的是**宿主**(DSH 的 subagents 服务、agents 注册表、jobs 面板、时钟),
 * 不是 swarm。被验的那一半始终是真实模块里的 `runNormalizedBatch` / `SwarmScheduler`。
 * 这个区分是本层全部结论的前提:桩掉调度器就只是在测自己写的桩,那种"通过"没有任何意义。
 *
 * 为什么必须用替身而不是真跑:真子代理要调供应商模型 —— 花钱、要凭据、不可复现,
 * 而且模型输出的随机性会把调度器本身的行为埋掉。任务书也明确禁止调真实供应商模型。
 * 替身只做本地假执行:立刻(或按我们的指令)返回一段固定文本。
 *
 * 真实契约(读 lib/index.js 得到,不是猜的):
 *   spawnOneShot 走 `ctx.subagents.start(provider, { label, prompt, parent, signal, agentOptions })`
 *   → 拿到 `run`,要求 `run.id` 与 `run.result`(Promise<{stopReason, output}>);
 *     `run.localAgent.session.ownEvents()` 是遥测来源(tool/call、step/start、data.usage)。
 *   provider 名固定为 "spawn";只有 `task.host` 非 local 时才查 `ctx.subagents.list()`。
 *   `ctx.get('jobs')` 缺席是软失败(整段包在 try/catch 里),批次照跑。
 */

/** 到期或超时前反复让出事件循环,直到 pred 成立。用于"等到 N 个子代理已启动"这类同步点。 */
export async function waitUntil(pred, { timeoutMs = 5000, what = 'condition' } = {}) {
	const deadline = Date.now() + timeoutMs
	for (;;) {
		if (pred()) return
		if (Date.now() > deadline) throw new Error(`waitUntil 超时(${timeoutMs}ms):${what}`)
		await new Promise((resolve) => setImmediate(resolve))
	}
}

/**
 * 闸门式子代理替身。
 *
 * 每次 `start()` 记一条在飞记录并**挂住**,直到调用方显式放行 —— 于是"同时有几个在跑"
 * 是我们说了算的确定事实,而不是靠 sleep 去赌时序。并发上限、渐进启动、取消时的
 * started/not_started 分流,都要靠这个才能确定性地观察。
 */
export function makeGatedSubagents({ providers = ['spawn'] } = {}) {
	const started = []          // 全部启动记录(按启动顺序)
	const pending = []          // 尚未放行的记录
	let active = 0
	let peak = 0

	const subagents = {
		list: () => [...providers],
		start: async (provider, opts) => {
			const index = started.length + 1
			const prompt = (opts.prompt || []).map((part) => part?.text ?? '').join('\n')
			let settle
			const gate = new Promise((resolve) => { settle = resolve })
			const record = {
				index, provider, label: opts.label, prompt,
				agentOptions: opts.agentOptions, signal: opts.signal,
				startedAt: Date.now(), settled: false,
			}
			active += 1
			if (active > peak) peak = active
			started.push(record)
			pending.push(record)

			// 放行方式有三种,对应调度器要区分的三种结局
			record.complete = (text = `done #${index}`, telemetry) => settle({ kind: 'completed', text, telemetry })
			record.stop = (stopReason) => settle({ kind: 'stopped', stopReason })
			record.fail = (message) => settle({ kind: 'threw', message })

			const outcome = await gate
			active -= 1
			record.settled = true
			const at = pending.indexOf(record)
			if (at >= 0) pending.splice(at, 1)

			if (outcome.kind === 'threw') throw new Error(outcome.message)

			const events = outcome.telemetry ?? [
				{ type: 'tool/call', data: { name: 'read_file', usage: { inputTokens: 100, outputTokens: 50 } } },
				{ type: 'step/start', data: {} },
			]
			return {
				id: `agent-${index}`,
				result: outcome.kind === 'stopped'
					? Promise.resolve({ stopReason: outcome.stopReason, output: [{ type: 'text', text: '' }] })
					: Promise.resolve({ stopReason: 'completed', output: [{ type: 'text', text: outcome.text }] }),
				localAgent: {
					session: {
						get events() { throw new Error('Session.events is private in DSH 0.1.2') },
						ownEvents: () => events,
					},
				},
				dispose: async () => {},
			}
		},
	}

	return {
		subagents,
		started,
		get pending() { return [...pending] },
		get active() { return active },
		get peak() { return peak },
		/** 等到至少 n 个子代理已经启动(不要求已结算)。 */
		waitForStarted: (n, timeoutMs) => waitUntil(() => started.length >= n, { timeoutMs, what: `至少 ${n} 个子代理启动(当前 ${started.length})` }),
		/** 放行全部在飞任务;后续新启动的不受影响。 */
		releaseAll: (text) => { for (const record of [...pending]) record.complete(text) },
	}
}

/**
 * 假 ctx。
 *
 * `get` 只认真实调度器会问的那几样。**不给 jobs** —— 它是软依赖(缺席时批次照跑),
 * 给了反而要连带实现 wait/read/start 的语义,那部分不是本层要验的东西。
 */
export function makeHostCtx(subagents, { services = {} } = {}) {
	return {
		subagents,
		get: (name) => (name === 'subagents' ? subagents : services[name]),
	}
}

/** 假 exec。runNormalizedBatch 从这里取 callId(进度表的键)、agent(父会话)与 signal。 */
export function makeExec({ callId = 'call-integration-1', sessionId = 'sess-integration', controller = new AbortController() } = {}) {
	return {
		exec: {
			agent: { session: { id: sessionId, snapshotEvents: () => [] }, id: sessionId },
			signal: controller.signal,
			callId,
		},
		controller,
	}
}

/** 造一批已归一化的任务。字段名照真实 normalizeSwarmArgs 的产物,不自创。 */
export function makeTasks(count, { prefix = 'item', model = { provider: 'fake-provider', model: 'fake-model' }, type = 'coder' } = {}) {
	return Array.from({ length: count }, (_, i) => ({
		index: i + 1,
		kind: 'spawn',
		item: `${prefix}-${i + 1}`,
		prompt: `请处理 ${prefix}-${i + 1}`,
		type,
		model,
		resumeAgentId: undefined,
		description: `integration #${i + 1} (${type})`,
	}))
}

/**
 * 假时钟 —— 与真实模块自带的 test/scheduler.fake-clock.test.mjs 同法。
 *
 * 用它才能在毫秒级不真等的前提下,确定性地观察渐进启动(700ms 一个)、
 * 限流退避(3s/6s/12s)、以及每任务超时。真等的话一场用例要跑几分钟,
 * 而且在慢机器上会变成随机失败。
 */
export function makeClock() {
	let now = 0
	let seq = 0
	const timers = []
	const stats = { setCalls: 0, zeroDelay: 0, clearCalls: 0 }
	return {
		now: () => now,
		setTimeout: (fn, ms) => {
			stats.setCalls += 1
			if (ms <= 0) stats.zeroDelay += 1
			const id = ++seq
			timers.push({ at: now + Math.max(0, ms), fn, id })
			return id
		},
		clearTimeout: (id) => {
			stats.clearCalls += 1
			const i = timers.findIndex((t) => t.id === id)
			if (i >= 0) timers.splice(i, 1)
		},
		/**
		 * 推进到下一个 timer,直到 pred 成立。
		 *
		 * 除了步数上限还有**真实时间**上限:pred 永远不成立时(入口自检拿坏桩跑就是这种),
		 * 光靠 maxSteps 要空转十几秒才退出 —— 自检因此从秒级变成分钟级。
		 */
		async runUntil(pred, { maxSteps = 200_000, timeoutMs = 10_000 } = {}) {
			const deadline = Date.now() + timeoutMs
			for (let i = 0; i < maxSteps; i += 1) {
				await Promise.resolve(); await Promise.resolve()
				if (pred()) return
				if (Date.now() > deadline) throw new Error(`runUntil 超时(${timeoutMs}ms):条件始终不成立`)
				if (timers.length === 0) {
					await new Promise((resolve) => setImmediate(resolve))
					if (pred()) return
					if (timers.length === 0) continue
				}
				timers.sort((a, b) => a.at - b.at)
				const t = timers.shift()
				now = Math.max(now, t.at)
				t.fn()
			}
			throw new Error('runUntil: 超过 maxSteps')
		},
		stats,
		get pendingTimers() { return timers.length },
	}
}
