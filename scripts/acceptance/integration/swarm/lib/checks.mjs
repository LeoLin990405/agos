/**
 * 真实 swarm 集成检查集。
 *
 * 每一条都**实际调用真实模块的代码**——`runNormalizedBatch` 或 `SwarmScheduler`——
 * 然后看可观测结果。"函数存在"不算通过:导出表检查只是 M 组的前置,单独一条
 * `typeof === 'function'` 永远不能构成"集成通过"的证据。
 *
 * 两个执行层都是真实模块,报告里分开标,不混为一谈:
 *   layer='runNormalizedBatch' —— 批次入口端到端(cn-capabilities 的 plan_run 走的正是它)
 *   layer='SwarmScheduler'     —— 直接驱动调度器类
 *
 * 为什么有些检查非走 SwarmScheduler 不可:`runNormalizedBatch` 里 `timeoutMs` 取自
 * 模块级 `CURRENT_CONFIG()`(只有插件 `apply()` 跑过才有值),`onProgress` 则被批次入口
 * **覆盖**成固定实现。也就是说超时与限流退避这两项**无法**从批次入口注入。
 * 与其伪造一个 apply() 环境,不如直接驱动同一个真实类并如实标明层级。
 *
 * 断言只写公开契约承诺过的东西。并发部分的依据是模块自带的
 * `lib/types/core/scheduler.d.ts`:「Start up to 5 tasks immediately, then 1 more every
 * 700ms while queued work remains. An optional maxConcurrency caps the ramp.」
 * 契约没承诺的(比如"第 6 个一定在第 700ms 那一刻起")不断言。
 */
import assert from 'node:assert/strict'

import {
	makeGatedSubagents, makeHostCtx, makeExec, makeTasks, makeClock, waitUntil,
} from './harness.mjs'
import {
	diffAgainstReference, parseResultsXml as inlineParse,
} from '../../../../../plugins/dsh-fleet/lib/fleet-swarm-compat.mjs'
import { inspectSwarmExports } from '../../../../../plugins/dsh-agos/lib/swarm-host-integration.mjs'

/** 让已就绪的微任务跑完。多跑几轮是因为 spawnOneShot 链路里有多层 await。 */
const drain = async (rounds = 12) => { for (let i = 0; i < rounds; i += 1) await new Promise((r) => setImmediate(r)) }

/** 一批检查的定义。id 稳定,报告与削弱反证都按 id 对账。 */
export function buildChecks(swarm, { waitTimeoutMs = 5000 } = {}) {
	const checks = []
	const check = (id, layer, title, fn) => checks.push({ id, layer, title, fn })

	// ── M:模块契约(是 B–X 组的前置,不单独构成集成通过)────────────────────
	check('M1', 'module', '真实模块导出 AgOS 需要的全部符号,且类型正确', async () => {
		const shape = inspectSwarmExports(swarm)
		assert.deepEqual(shape.missing, [], `缺少导出:${shape.missing.join(', ')}`)
		assert.deepEqual(shape.wrongType, [], `导出类型不对:${JSON.stringify(shape.wrongType)}`)
	})

	check('M2', 'module', 'runNormalizedBatch 的形参与真实契约一致(ctx, exec, normalized, opts={})', async () => {
		// 形参数为 3:第四个 opts 带默认值,不计入 length。契约变了这里要先红。
		assert.equal(typeof swarm.runNormalizedBatch, 'function')
		assert.equal(swarm.runNormalizedBatch.length, 3, 'runNormalizedBatch 形参数变了,调用点的约定需要重新核对')
		assert.equal(swarm.runNormalizedBatch.constructor.name, 'AsyncFunction')
	})

	// ── B:runNormalizedBatch 成功路径 ─────────────────────────────────────
	check('B1', 'runNormalizedBatch', '三项全部成功:返回可解析 XML,collect 三件套齐全', async () => {
		const gate = makeGatedSubagents()
		const { exec } = makeExec({ callId: 'call-B1' })
		const collect = {}
		const snapshots = []
		const tasks = makeTasks(3)
		const running = swarm.runNormalizedBatch(makeHostCtx(gate.subagents), exec, { description: 'B1', tasks, maxConcurrency: 3 },
			{ collect, onRows: (rows) => snapshots.push(rows) })
		await gate.waitForStarted(3, waitTimeoutMs)
		gate.releaseAll()
		const xml = await running

		assert.equal(typeof xml, 'string', 'runNormalizedBatch 应当返回字符串(XML + 评估 markdown)')
		assert.match(xml, /<agent_swarm_result>/)
		assert.equal((xml.match(/<subagent /g) || []).length, 3, 'XML 行数与任务数不符')
		assert.equal((xml.match(/outcome="completed"/g) || []).length, 3)
		assert.deepEqual(collect.rows.map((r) => r.status), ['completed', 'completed', 'completed'])
		assert.equal(collect.meta.peakConcurrency, 3, '三项无上限并发时峰值应为 3')
		assert.equal(typeof collect.assessment.completion, 'number')
		assert.equal(collect.assessment.completion, 1, '全部完成时 completion 应为 1')
		assert.ok(snapshots.length >= 3, `onRows 只被调了 ${snapshots.length} 次,进度快照没有随状态变化推送`)
	})

	check('B2', 'runNormalizedBatch', '业务接线:提示词/模型/遥测确实穿过真实调度器到达子代理与结果行', async () => {
		const gate = makeGatedSubagents()
		const { exec } = makeExec({ callId: 'call-B2' })
		const collect = {}
		const tasks = makeTasks(2, { prefix: '业务项', model: { provider: 'qwen', model: 'qwen3.8-max' } })
		const running = swarm.runNormalizedBatch(makeHostCtx(gate.subagents), exec, { description: 'B2', tasks, maxConcurrency: 2 }, { collect })
		await gate.waitForStarted(2, waitTimeoutMs)
		for (const rec of gate.pending) rec.complete(`结论 ${rec.label}`)
		const xml = await running

		// 提示词原样到达(调度器不该改写它)
		assert.deepEqual(gate.started.map((r) => r.prompt).sort(), ['请处理 业务项-1', '请处理 业务项-2'])
		// 模型选择经 agentOptionsFor 变成 { provider, model }
		for (const rec of gate.started) assert.deepEqual(rec.agentOptions, { provider: 'qwen', model: 'qwen3.8-max' })
		assert.deepEqual([...new Set(gate.started.map((r) => r.provider))], ['spawn'], 'provider 名与真实契约不符')
		// 遥测经 readChildTelemetry 落进结果行,再经 renderSwarmResults 落进 XML
		for (const row of collect.rows) {
			assert.equal(row.toolCalls, 1, '子代理的 tool/call 没有被采集进结果行')
			assert.deepEqual(row.tools, [{ name: 'read_file', n: 1 }])
		}
		assert.match(xml, /tools="read_file×1"/)
		assert.match(xml, /model="qwen\/qwen3\.8-max"/)
		// 结果文本经 textOf 抽取后回到 XML body
		assert.match(xml, /结论 integration #1 \(coder\)/)
	})

	check('B3', 'runNormalizedBatch', 'XML 能被 Fleet 内联解析器读回(前端消费的正是这条通路)', async () => {
		const gate = makeGatedSubagents()
		const { exec } = makeExec({ callId: 'call-B3' })
		const running = swarm.runNormalizedBatch(makeHostCtx(gate.subagents), exec,
			{ description: 'B3', tasks: makeTasks(2), maxConcurrency: 2 }, {})
		await gate.waitForStarted(2, waitTimeoutMs)
		gate.releaseAll('带 & 与 <尖括号> 的结果')
		const xml = await running

		const viaInline = inlineParse(xml)
		const viaReal = swarm.parseResultsXml(xml)
		assert.equal(viaInline.length, 2)
		assert.deepEqual(viaInline, viaReal, '内联解析器与真实解析器读同一份真实 XML 得到了不同结构')
		assert.equal(viaInline[0].result, '带 & 与 <尖括号> 的结果', '转义/反转义往返丢失了原文')
		swarm.PROGRESS.delete('call-B3')
	})

	// ── F:失败与超时 ──────────────────────────────────────────────────────
	check('F1', 'runNormalizedBatch', '单项抛错只失败那一项,其余照常完成(失败隔离)', async () => {
		const gate = makeGatedSubagents()
		const { exec } = makeExec({ callId: 'call-F1' })
		const collect = {}
		const running = swarm.runNormalizedBatch(makeHostCtx(gate.subagents), exec,
			{ description: 'F1', tasks: makeTasks(3), maxConcurrency: 3 }, { collect })
		await gate.waitForStarted(3, waitTimeoutMs)
		gate.started[1].fail('子代理内部炸了')
		gate.started[0].complete('ok-1')
		gate.started[2].complete('ok-3')
		const xml = await running

		const byIndex = new Map(collect.rows.map((r) => [r.task.index, r]))
		assert.equal(byIndex.get(1).status, 'completed')
		assert.equal(byIndex.get(3).status, 'completed')
		assert.equal(byIndex.get(2).status, 'failed', '抛错的那一项没有被记为 failed')
		assert.match(byIndex.get(2).error, /子代理内部炸了/, '失败原因没有透传')
		assert.equal(byIndex.get(2).state, 'not_started', 'start() 抛错属未启动,状态不该是 started')
		assert.match(xml, /failed: 1/)
		assert.equal(collect.assessment.completion, 2 / 3)
		swarm.PROGRESS.delete('call-F1')
	})

	check('F2', 'runNormalizedBatch', '子代理跑完但 stopReason 非 completed → failed,错误写明真实 stopReason', async () => {
		const gate = makeGatedSubagents()
		const { exec } = makeExec({ callId: 'call-F2' })
		const collect = {}
		const running = swarm.runNormalizedBatch(makeHostCtx(gate.subagents), exec,
			{ description: 'F2', tasks: makeTasks(2), maxConcurrency: 2 }, { collect })
		await gate.waitForStarted(2, waitTimeoutMs)
		gate.started[0].stop('max_tokens')
		gate.started[1].complete('ok')
		await running

		const failed = collect.rows.find((r) => r.task.index === 1)
		assert.equal(failed.status, 'failed')
		assert.equal(failed.state, 'started', '已启动才拿到 stopReason,状态应为 started')
		assert.match(failed.error, /subagent stopped: max_tokens/, '错误没有写明真实 stopReason')
		swarm.PROGRESS.delete('call-F2')
	})

	check('F3', 'SwarmScheduler', '每任务超时只失败挂死的那一项,兄弟任务照常完成', async () => {
		const clock = makeClock()
		const tasks = [{ index: 1, item: 'hang', prompt: 'p' }, { index: 2, item: 'ok', prompt: 'p' }]
		const spawn = (task, signal) => new Promise((resolve) => {
			if (task.item === 'hang') {
				signal.addEventListener('abort', () => resolve({ status: 'aborted', state: 'started', error: 'abort' }), { once: true })
				return
			}
			clock.setTimeout(() => resolve({ status: 'completed', state: 'started', result: 'ok' }), 100)
		})
		const scheduler = new swarm.SwarmScheduler(spawn, {
			now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, timeoutMs: 5000,
		})
		let done = false
		const running = scheduler.run(tasks, new AbortController().signal).then((r) => { done = true; return r })
		await clock.runUntil(() => done, { timeoutMs: waitTimeoutMs })
		const rows = await running

		assert.equal(rows[1].status, 'completed', '兄弟任务被超时项拖垮了')
		assert.equal(rows[0].status, 'failed')
		assert.match(rows[0].error, /timed out after 5000ms/)
	})

	check('F4', 'SwarmScheduler', '限流重试有上限:永远 429 不会无限 ping-pong,错误写明放弃重试', async () => {
		const clock = makeClock()
		const tasks = [{ index: 1, item: 'a', prompt: 'p' }, { index: 2, item: 'b', prompt: 'p' }]
		let calls = 0
		const spawn = () => new Promise((resolve) => {
			calls += 1
			clock.setTimeout(() => resolve({ status: 'failed', state: 'started', error: '429 Too Many Requests', rateLimited: true }), 50)
		})
		const scheduler = new swarm.SwarmScheduler(spawn, {
			now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, maxRateLimitRetries: 3,
		})
		let done = false
		const running = scheduler.run(tasks, new AbortController().signal).then((r) => { done = true; return r })
		await clock.runUntil(() => done, { timeoutMs: waitTimeoutMs })
		const rows = await running

		assert.ok(rows.every((r) => r.status === 'failed'), JSON.stringify(rows.map((r) => r.status)))
		assert.ok(rows.some((r) => /gave up after/.test(r.error || '')), `错误里没写明放弃重试:${JSON.stringify(rows.map((r) => r.error))}`)
		assert.ok(calls <= 2 * (3 + 1) + 2, `spawn 被调 ${calls} 次,重试上限没生效`)
	})

	// ── C:取消 ────────────────────────────────────────────────────────────
	check('C1', 'runNormalizedBatch', '取消:已完成保留、在飞标 started、从未启动标 not_started', async () => {
		const gate = makeGatedSubagents()
		const { exec, controller } = makeExec({ callId: 'call-C1' })
		const collect = {}
		const running = swarm.runNormalizedBatch(makeHostCtx(gate.subagents), exec,
			{ description: 'C1', tasks: makeTasks(5), maxConcurrency: 2 }, { collect })

		await gate.waitForStarted(2, waitTimeoutMs)
		gate.started[0].complete('第一项在取消前已完成')   // 这一项必须被保留
		await gate.waitForStarted(3, waitTimeoutMs)                        // 让出的槽位放第 3 项进来
		controller.abort()
		const xml = await running

		const byIndex = new Map(collect.rows.map((r) => [r.task.index, r]))
		assert.equal(byIndex.get(1).status, 'completed', '取消前已完成的结果被抹掉了')
		assert.equal(byIndex.get(1).result, '第一项在取消前已完成')
		for (const i of [2, 3]) {
			assert.equal(byIndex.get(i).status, 'aborted', `第 ${i} 项应为 aborted`)
			assert.equal(byIndex.get(i).state, 'started', `第 ${i} 项在飞,应标 started`)
		}
		for (const i of [4, 5]) {
			assert.equal(byIndex.get(i).status, 'aborted')
			assert.equal(byIndex.get(i).state, 'not_started', `第 ${i} 项从未启动,不该标 started`)
		}
		assert.match(byIndex.get(4).error, /manually interrupted/)
		assert.match(xml, /aborted: 4/)
		assert.match(xml, /<resume_hint>/, '有未完成项时应给出 resume 提示')
		assert.equal(gate.started.length, 3, '取消后不该再启动新的子代理')

		gate.releaseAll()   // 收尾:放行仍挂着的替身,避免留下未决 promise
		await drain()
		swarm.PROGRESS.delete('call-C1')
	})

	check('C2', 'SwarmScheduler', '取消后清理:定时器被清掉,run() 正常结算不吊死', async () => {
		const clock = makeClock()
		const tasks = makeTasks(6).map((t) => ({ index: t.index, item: t.item, prompt: t.prompt }))
		const controller = new AbortController()
		const spawn = (_task, signal) => new Promise((resolve) => {
			signal.addEventListener('abort', () => resolve({ status: 'aborted', state: 'started', error: 'aborted' }), { once: true })
		})
		const scheduler = new swarm.SwarmScheduler(spawn, {
			now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
			maxConcurrency: 2, initialLaunchLimit: 2,
		})
		let done = false
		const running = scheduler.run(tasks, controller.signal).then((r) => { done = true; return r })
		await drain()
		controller.abort()
		await clock.runUntil(() => done, { timeoutMs: waitTimeoutMs })
		const rows = await running

		assert.equal(rows.length, 6)
		assert.ok(rows.every((r) => r.status === 'aborted'), JSON.stringify(rows.map((r) => r.status)))
		assert.equal(clock.pendingTimers, 0, `取消后还剩 ${clock.pendingTimers} 个定时器没清 —— 会把进程吊住`)
	})

	// ── P:进度 ────────────────────────────────────────────────────────────
	check('P1', 'runNormalizedBatch', '默认路径把进度写进真实模块级 PROGRESS,progressResponse 读得到', async () => {
		const callId = 'call-P1-' + Date.now()
		const gate = makeGatedSubagents()
		const { exec } = makeExec({ callId, sessionId: 'sess-P1' })
		try {
			const running = swarm.runNormalizedBatch(makeHostCtx(gate.subagents), exec,
				{ description: 'P1', tasks: makeTasks(3), maxConcurrency: 3 }, {})  // 不给 onRows → 走真实 publishProgress
			await gate.waitForStarted(3, waitTimeoutMs)
			gate.releaseAll()
			await running

			const snapshot = swarm.PROGRESS.get(callId)
			assert.ok(snapshot, '真实 PROGRESS 表里没有本批次的快照 —— 前端 /api/swarm/progress 会是空的')
			assert.equal(snapshot.parentSessionId, 'sess-P1', '父会话 id 没有一起存(前端"停这一个"要用它鉴权)')
			assert.equal(snapshot.rows.length, 3, '快照不是完整有序集合')
			assert.deepEqual(snapshot.rows.map((r) => r.index), [1, 2, 3])
			assert.deepEqual(snapshot.rows.map((r) => r.status), ['completed', 'completed', 'completed'])

			const full = swarm.progressResponse()
			assert.ok(full.calls[callId], 'progressResponse() 看不到本批次')
			assert.equal(full.full, true)
			// since 用严格 at > cursor:用自己的 at 当游标,应当把自己排除
			assert.equal(swarm.progressResponse(snapshot.at).calls[callId], undefined, 'since 游标不是严格大于,前端会重复收到同一份')
		} finally {
			swarm.PROGRESS.delete(callId)
		}
	})

	check('P2', 'runNormalizedBatch', '给了 onRows 就不写全局 PROGRESS(调用方自己合并后再发布)', async () => {
		const callId = 'call-P2-' + Date.now()
		const gate = makeGatedSubagents()
		const { exec } = makeExec({ callId })
		try {
			const seen = []
			const running = swarm.runNormalizedBatch(makeHostCtx(gate.subagents), exec,
				{ description: 'P2', tasks: makeTasks(2), maxConcurrency: 2 }, { onRows: (rows) => seen.push(rows) })
			await gate.waitForStarted(2, waitTimeoutMs)
			gate.releaseAll()
			await running

			assert.ok(seen.length > 0, 'onRows 从未被调用')
			assert.equal(swarm.PROGRESS.get(callId), undefined,
				'给了 onRows 却仍然写了全局 PROGRESS —— 分波调用方(plan_run)的合并进度会被单波快照覆盖')
			assert.deepEqual(seen.at(-1).map((r) => r.status), ['completed', 'completed'])
		} finally {
			swarm.PROGRESS.delete(callId)
		}
	})

	check('P3', 'module', 'publishProgress 的 at 严格递增(同毫秒内多次也不相等)', async () => {
		const ids = ['p3-a', 'p3-b', 'p3-c', 'p3-d', 'p3-e']
		try {
			const ats = ids.map((id) => { swarm.publishProgress(id, [{ index: 1, status: 'queued' }], 's'); return swarm.PROGRESS.get(id).at })
			for (let i = 1; i < ats.length; i += 1) {
				assert.ok(ats[i] > ats[i - 1], `at 没有严格递增(${ats.join(', ')}) —— 前端 since 轮询会漏掉快照`)
			}
			swarm.publishProgress('', [{ index: 1 }], 's')
			assert.equal(swarm.PROGRESS.has(''), false, '空 callId 不该建快照')
		} finally {
			for (const id of ids) swarm.PROGRESS.delete(id)
		}
	})

	check('P4', 'runNormalizedBatch', 'STOPPED 里的 agentId 在进度行上标 stopped', async () => {
		const callId = 'call-P4-' + Date.now()
		const gate = makeGatedSubagents()
		const { exec } = makeExec({ callId })
		swarm.STOPPED.add('agent-1')
		try {
			const seen = []
			const running = swarm.runNormalizedBatch(makeHostCtx(gate.subagents), exec,
				{ description: 'P4', tasks: makeTasks(2), maxConcurrency: 2 }, { onRows: (rows) => seen.push(rows) })
			await gate.waitForStarted(2, waitTimeoutMs)
			gate.releaseAll()
			await running

			const last = seen.at(-1)
			assert.equal(last.find((r) => r.index === 1).stopped, true, 'STOPPED 里的 agentId 没有被标成 stopped')
			assert.equal(last.find((r) => r.index === 2).stopped, false, '未被停的行不该标 stopped')
		} finally {
			swarm.STOPPED.delete('agent-1')
			swarm.PROGRESS.delete(callId)
		}
	})

	// ── N:并发(只断言公开契约承诺过的)──────────────────────────────────
	check('N1', 'runNormalizedBatch', 'maxConcurrency 是硬上限:在飞数从不超过它', async () => {
		const gate = makeGatedSubagents()
		const { exec } = makeExec({ callId: 'call-N1' })
		const collect = {}
		const running = swarm.runNormalizedBatch(makeHostCtx(gate.subagents), exec,
			{ description: 'N1', tasks: makeTasks(8), maxConcurrency: 3 }, { collect })

		await gate.waitForStarted(3, waitTimeoutMs)
		await drain()
		assert.equal(gate.started.length, 3, `上限 3,却启动了 ${gate.started.length} 个`)
		assert.equal(gate.active, 3)

		// 放掉一个 → 恰好补一个,不多不少
		gate.started[0].complete()
		await gate.waitForStarted(4, waitTimeoutMs)
		await drain()
		assert.equal(gate.started.length, 4, '槽位释放后补位数量不对')
		assert.ok(gate.peak <= 3, `峰值在飞 ${gate.peak} 超过了上限 3`)

		// 持续放行直到批次结算:releaseAll 只放当前在飞的那几个,补位进来的下一轮才轮到
		let finished = false
		const settled = running.then((value) => { finished = true; return value })
		while (!finished) { gate.releaseAll(); await drain(2) }
		await settled
		assert.equal(gate.started.length, 8, '并非全部任务都被启动过')
		assert.equal(collect.rows.filter((r) => r.status === 'completed').length, 8)
		assert.equal(collect.meta.peakConcurrency, 3, 'swarmMeta 报的峰值与实际不符')
		swarm.PROGRESS.delete('call-N1')
	})

	check('N2', 'runNormalizedBatch', '渐进启动:先立刻起 initialLaunchLimit 个,其余按 launchInterval 逐个放行', async () => {
		// 用假时钟才能确定性地区分"立刻起的"与"等间隔起的"——真时钟下这是个赛跑。
		const clock = makeClock()
		const gate = makeGatedSubagents()
		const { exec } = makeExec({ callId: 'call-N2' })
		const collect = {}
		const running = swarm.runNormalizedBatch(makeHostCtx(gate.subagents), exec,
			{ description: 'N2', tasks: makeTasks(8), maxConcurrency: 0 },   // 0 = 不限并发,只受渐进启动节流
			{
				collect,
				schedulerOptions: {
					initialLaunchLimit: 5, launchIntervalMs: 700,
					now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
				},
			})

		await gate.waitForStarted(5, waitTimeoutMs)
		await drain()
		// 时钟没动过 → 契约说的 "up to 5 immediately" 必须恰好是 5,第 6 个不能偷跑
		assert.equal(gate.started.length, 5, `未推进时钟就起了 ${gate.started.length} 个,渐进启动没有生效`)

		// 推进时钟 → 第 6 个放行
		await clock.runUntil(() => gate.started.length >= 6, { timeoutMs: waitTimeoutMs })
		assert.ok(clock.now() >= 700, `第 6 个在 ${clock.now()}ms 就起了,早于契约的 700ms 间隔`)

		gate.releaseAll()
		await clock.runUntil(() => gate.started.length === 8, { timeoutMs: waitTimeoutMs })
		gate.releaseAll()
		await clock.runUntil(() => collect.rows !== undefined, { timeoutMs: waitTimeoutMs })
		await running
		assert.equal(collect.rows.filter((r) => r.status === 'completed').length, 8)
		assert.ok(collect.meta.peakConcurrency > 5, `峰值 ${collect.meta.peakConcurrency} 没有越过初始批量,渐进启动退化成了一换一`)
		swarm.PROGRESS.delete('call-N2')
	})

	// ── X:Fleet 内联实现与真实模块的 XML 差分 ────────────────────────────
	check('X1', 'xml-differential', 'Fleet 内联的四个 XML 函数与真实模块逐输入一致(含边界输入)', async () => {
		const { compared, mismatches, missing } = diffAgainstReference(swarm)
		assert.deepEqual(missing, [], `真实模块缺少 ${missing.join(', ')},差分无对照`)
		assert.ok(compared >= 120, `只比了 ${compared} 项,语料退化`)
		assert.deepEqual(mismatches, [],
			'内联实现与真实模块行为不一致:\n' + mismatches.map((m) => `  ${m.fn} @ ${m.input}\n    内联=${m.inline}\n    原版=${m.reference}`).join('\n'))
		return { compared }
	})

	check('X2', 'xml-differential', '对照不是自证:真实模块的函数与内联版不是同一个对象', async () => {
		// 有人把 AGOS_SWARM_MODULE 指到一份"再导出内联实现"的壳时,X1 会永远绿。
		// 这条把那种情况挡掉 —— 真 swarm 一定同时带调度器,而壳没有。
		const inline = await import('../../../../../plugins/dsh-fleet/lib/fleet-swarm-compat.mjs')
		for (const fn of ['escapeXml', 'unescapeXml', 'textOf', 'parseResultsXml']) {
			assert.notEqual(swarm[fn], inline[fn], `${fn} 与内联版是同一个函数对象:这是自证,不是差分`)
		}
		assert.equal(typeof swarm.runNormalizedBatch, 'function', '只有 XML 函数、没有调度器的东西是桩,不能当差分对照')
	})

	return checks
}

/** 逐条跑,收集结果。单条失败不影响其余 —— 一次运行要看到全部坏点,而不是第一个。 */
export async function runChecks(checks, { checkTimeoutMs = 30_000, stopOnTimeout = false } = {}) {
	const results = []
	for (const { id, layer, title, fn } of checks) {
		const startedAt = Date.now()
		let timer
		try {
			const timeout = new Promise((_, reject) => {
				timer = setTimeout(() => reject(new Error(`检查截止时间 ${checkTimeoutMs}ms 已到，检查未结算`)), checkTimeoutMs)
			})
			const extra = await Promise.race([fn(), timeout])
			results.push({ id, layer, title, status: 'pass', ms: Date.now() - startedAt, ...(extra ?? {}) })
		} catch (error) {
			results.push({
				id, layer, title, status: 'fail', ms: Date.now() - startedAt,
				error: `${error?.constructor?.name ?? 'Error'}: ${error?.message ?? error}`,
				stack: typeof error?.stack === 'string' ? error.stack.split('\n').slice(0, 6).join('\n') : null,
			})
		} finally {
			clearTimeout(timer)
		}
		if (stopOnTimeout && results.at(-1)?.error?.includes('截止时间')) break
	}
	return results
}
