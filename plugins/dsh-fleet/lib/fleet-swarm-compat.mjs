/**
 * Fleet 对 dsh-kimicode-swarm 的解耦层。
 *
 * 为什么存在:原先 lib/index.js 顶部有一行
 *   import { publishProgress, parseResultsXml, escapeXml, textOf } from 'dsh-kimicode-swarm'
 * 这一行把整个仓的依赖可复现性锁死了 —— registry 上的 dsh-kimicode-swarm(0.1.0/0.1.1/0.1.2)
 * **一个都不导出**这四个符号(本轮 npm pack 三个版本逐一实测),能用的只有操作者从
 * ~/.dsh/profiles/desktop/plugins/kimicode-swarm-aligned 提供的本机构建产物。更糟的是
 * 三个 registry 版本自己都 `import { installSettingsSection } from '@deepseek-ai/dsh-settings'`,
 * 而该导出只存在于 dsh-settings 0.1.0-rc.6 及更早 —— 于是为了让这行 import 能加载,
 * 整棵树的 dsh-settings 必须从 pin 的 0.1.2-rc.1 降到 rc.6,而 rc.6 的 peer 属另一条线,
 * 与其余七个包的 ^0.1.2-rc.1 冲突。这就是上一轮 `npm ci` 无法复现出可用树的根因。
 *
 * 拆解依据是这四个符号的**真实性质不同**,不能一视同仁:
 *
 *   escapeXml / unescapeXml / textOf / parseResultsXml —— 纯函数,内联。
 *     特别是 parseResultsXml:Fleet 解析的 XML 是 **Fleet 自己** renderXml() 生成的
 *     (生产者 lib/index.js 的 renderXml,消费者同文件的 presentationMeta),swarm 只是
 *     恰好有个同形状的解析器被顺手复用。内联反而**消除**了契约漂移风险 —— 原先
 *     Fleet 的生成器和 swarm 的解析器可以各自独立演化而没人发现。
 *
 *   publishProgress —— **不是**纯函数,是真实的跨插件集成,不能内联。
 *     它写的是 swarm 模块级的 PROGRESS Map,由 swarm 自己的 progressResponse() 经
 *     /api/swarm/progress 路由喂前端(消费方已核实:frontend/src/stores/live.ts:689
 *     fetch('/api/swarm/progress') 读 calls,:808 用 state.progress?.calls)。
 *     内联一份实现只会让 Fleet 写进**自己**的 Map,swarm 的路由永远看不到,
 *     前端的 Fleet 进度就静默变空 —— 那是把可复现性换成静默功能回归,不划算。
 *
 * 所以 publishProgress 改成**运行时可选集成**:真实宿主上 swarm 本来就是同级插件
 * (已核实 ~/.dsh/profiles/{desktop,web}/ 均有 plugins/kimicode-swarm-aligned 与
 * node_modules/dsh-kimicode-swarm),运行时解析得到就照常发布,行为与原先逐字节一致;
 * 干净测试树里解析不到就**显式**记为不可用。关键区别在"显式":不可用时不假装发布过,
 * 调用方能读到 reason 并落一行日志,而不是静默丢进虚空。
 */

import { resolveSwarmModule, SWARM_SPECIFIER } from '../../dsh-agos/lib/swarm-host-integration.mjs'

export { SWARM_SPECIFIER }

/**
 * XML 属性值转义。忠实复制 swarm 的实现,包括 & 必须**第一个**替换这一点 ——
 * 顺序换了就会把 &lt; 二次转义成 &amp;lt;。
 */
export function escapeXml(value) {
	return String(value)
		.replaceAll('&', '&amp;')
		.replaceAll('"', '&quot;')
		.replaceAll("'", '&apos;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
}

/** escapeXml 的逆。只认这五个实体 —— 与 swarm 一致,不扩展成通用 XML 反转义。 */
export function unescapeXml(value) {
	const entities = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }
	return String(value ?? '').replace(/&(amp|lt|gt|quot|apos);/g, (_match, name) => entities[name])
}

/** 把 LLM 结果的 block 数组压成纯文本。 */
export function textOf(result) {
	return result.output.map((block) => (block.type === 'text' ? block.text : '')).join('').trim()
}

/**
 * 解析 renderXml() 产出的 <subagent …> 行。
 *
 * ⚠️ 忠实复制,不"顺手修好":swarm 的原实现在对象字面量里把 team / member 写了两遍
 * (task 内一次、顶层一次),JS 取后者,于是顶层实际生效的是 `attr(...) ?? null`,
 * 而 task 内的是不带 ?? null 的版本。前端消费的正是这个结构,把重复键"清理"成
 * 一份就会改变 undefined vs null 的取值,属于行为漂移。这里保留生效语义并写明来由。
 */
export function parseResultsXml(xml) {
	const rows = []
	const pattern = /<subagent ([^>]*)>([\s\S]*?)<\/subagent>/g
	let match
	while ((match = pattern.exec(xml)) !== null) {
		const attrs = match[1]
		const body = match[2]
		const attr = (name) => {
			const value = new RegExp(`${name}="([^"]*)"`).exec(attrs)?.[1]
			return value === undefined ? undefined : unescapeXml(value)
		}
		const status = attr('outcome') ?? 'failed'
		rows.push({
			task: {
				index: rows.length + 1,
				kind: attr('mode') === 'resume' ? 'resume' : 'spawn',
				item: attr('item'),
				prompt: '',
				type: undefined,
				model: undefined,
				team: attr('team'),
				member: attr('member'),
				resumeAgentId: undefined,
				description: '',
			},
			agentId: attr('agent_id'),
			status,
			state: attr('state'),
			modelLabel: attr('model'),
			toolCalls: Number(attr('tool_calls') ?? 0) || 0,
			toolList: attr('tools'),
			elapsedMs: Number(attr('ms') ?? 0) || 0,
			offsetMs: Number(attr('at') ?? 0) || 0,
			alive: attr('alive') === '1',
			stopped: attr('stopped') === '1',
			forked: attr('forked') ?? null,
			depth: Number(attr('depth') ?? 1) || 1,
			role: attr('role') ?? null,
			// 顶层 team/member:见函数注释,生效版本带 ?? null
			team: attr('team') ?? null,
			member: attr('member') ?? null,
			images: Number(attr('images') ?? 0) || 0,
			error: status === 'completed' ? undefined : unescapeXml(body.trim()),
			result: status === 'completed' ? unescapeXml(body.trim()) : undefined,
		})
	}
	return rows
}

/** 解析结果缓存。一个进程里 swarm 在不在是稳定事实,不必每批次重新 import。 */
let cachedPublisher

/** 供测试清空缓存 —— 生产代码不调用。 */
export function resetProgressPublisherCache() {
	cachedPublisher = undefined
}

/**
 * 解析进度发布通路。
 *
 * 返回 { available, reason, publish }:
 *   available=true  → publish 就是 swarm 的 publishProgress,行为与原先完全一致
 *   available=false → publish 是**记账式** no-op:不抛错(进度发布不该弄死一个批次),
 *                     但把丢弃次数记在 droppedCalls 上,并给出 reason。调用方据此
 *                     落一行日志。不可用时绝不声称发布成功。
 *
 * @param {object} [options]
 * @param {(specifier: string) => Promise<any>} [options.importer] 注入点,供测试模拟
 *   swarm 存在/缺失两种分支而无需真的装包。生产走默认动态 import。
 */
export async function resolveProgressPublisher(options = {}) {
	const injected = typeof options.importer === 'function' || options.env !== undefined
	// 注入时不走缓存:同一进程里的两条测试要能分别拿到"有"和"无"两种分支。
	if (!injected && cachedPublisher) return cachedPublisher

	const resolution = await resolveSwarmModule(options)
	if (!resolution.available) {
		const result = unavailable(resolution.reason)
		if (!injected) cachedPublisher = result
		return result
	}

	const fn = resolution.module && resolution.module.publishProgress
	if (typeof fn !== 'function') {
		// 解析到了包但没有这个导出 —— registry 版就是这样(三个版本实测均无)。
		// 这与"包不存在"是不同的失败,reason 要能区分,否则排障时分不清是没装还是版本不对。
		const result = unavailable(
			`${SWARM_SPECIFIER}(来源:${resolution.source})已解析但未导出 publishProgress`
				+ '(registry 版 0.1.0/0.1.1/0.1.2 均无此导出,真实宿主用的是对齐构建版)',
		)
		if (!injected) cachedPublisher = result
		return result
	}

	// 可用分支:直接透传,**不包 try/catch** —— 与拆解前逐字节同行为。
	// 包上去会把 swarm 侧的真实故障吞成"发布成功",那是本次修复要避免的东西。
	const result = { available: true, reason: null, droppedCalls: 0, publish: fn }
	if (!injected) cachedPublisher = result
	return result
}

function unavailable(reason) {
	const state = {
		available: false,
		reason,
		droppedCalls: 0,
		publish: (..._args) => {
			state.droppedCalls += 1
		},
	}
	return state
}
