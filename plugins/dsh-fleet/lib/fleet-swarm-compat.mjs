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

/**
 * 差分语料 —— 内联版与真实 swarm 逐输入对比时喂的东西。
 *
 * 放在 lib 而不是 test 里,是因为它有**两个**消费者:单测
 * (test/swarm-compat.test.mjs)与集成层入口(scripts/acceptance/integration/swarm/)。
 * 各自抄一份的话,两边迟早覆盖不同的输入,而"集成层报差分通过"就不再等价于
 * "单测报差分通过"—— 那种偏差从两边的绿色上都看不出来。
 *
 * 选输入的原则是**挑重写时最容易走样的地方**,不是凑数量:
 *   转义顺序(& 必须最先)、未闭合/未知实体、控制字符与 NUL、多字节与孤立代理对、
 *   `]]>` 与 CDATA/注释/声明这些"看起来像 XML 但不是 subagent 行"的东西、
 *   属性缺失(undefined vs null 的分水岭)、数值属性喂非数、
 *   超长输入(正则回溯行为)、大小写与换行分隔的属性。
 */

/** escapeXml / unescapeXml 的输入。含非字符串 —— 两个函数都 String() 了,类型转换本身也要一致。 */
export const SCALAR_DIFF_CASES = Object.freeze([
	'', 'plain', '&', '&&&', '<', '>', '"', "'", '<>', '"q"', "'a'",
	'&amp;', '&amp;amp;', '&lt;already&gt;', 'a&b<c>d"e\'f',
	// 未知/残缺实体:unescapeXml 只认五个,其余必须原样留着
	'&#38;', '&nbsp;', '&unknown;', '&am', '&;', '&lt', 'lt;',
	// 控制字符与 NUL —— 转义表不含它们,必须原样穿过
	'\u0000', '\u0001\u0002', '\u007f', '\t\n\r',
	// 多字节、组合字符、孤立代理对(String() 与 replaceAll 在这里都可能走样)
	'中文多字节', '\u{1F600}\u{1F4A9}', 'e\u0301', '\uD83D', '\uDE00',
	// 看起来像 XML 的东西
	']]>', '<![CDATA[x]]>', '<?xml version="1.0"?>', '<!-- c -->',
	// 超长:& 的全量替换是 O(n),这里同时压回溯与性能
	'x'.repeat(100_000), '&'.repeat(20_000),
	// 非字符串:escapeXml 用 String(v)、unescapeXml 用 String(v ?? '') —— 两者在
	// null/undefined 上**故意不同**,差分必须把这个差异一并钉住
	0, 1, -0, NaN, Infinity, null, undefined, true, false,
])

/** textOf 的输入。它吃的是 LLM 结果结构,只有 type==='text' 的 block 参与拼接。 */
export const TEXT_OF_DIFF_CASES = Object.freeze([
	{ output: [] },
	{ output: [{ type: 'text', text: ' hi ' }] },
	{ output: [{ type: 'text', text: '' }] },
	{ output: [{ type: 'text', text: 'a' }, { type: 'tool_use', id: 'x' }, { type: 'text', text: 'b' }] },
	{ output: [{ type: 'tool_use', id: 'only-tool' }] },
	{ output: [{ type: 'text', text: '中文 \u{1F600}' }, { type: 'text', text: '\u0000' }] },
	// 缺字段 / 空洞元素 / 缺 output —— 原实现都没有防御性判空,内联版也不能"顺手加上"
	{ output: [{ type: 'text' }] },
	{ output: [{ type: 'text', text: null }] },
	{ output: [null] },
	{ output: [undefined] },
	{},
	{ output: null },
])

/** parseResultsXml 的输入。 */
export const XML_DIFF_CASES = Object.freeze([
	'',
	'<subagent >',
	'<subagent>no space</subagent>',                       // 正则要求 `<subagent ` 带空格 —— 这条**不该**匹配
	'<subagent item="a" outcome="completed">ok</subagent>',
	'<subagent item="a" outcome="failed">boom &amp; bust</subagent>',
	'<subagent item="a" outcome="completed">unclosed',      // 未闭合标签
	'<subagent item="a" outcome="completed">a]]>b</subagent>',
	'<subagent item="&amp;amp;" outcome="completed">&amp;lt;</subagent>',  // 嵌套实体
	'<subagent item="中文" outcome="completed">多字节 \u{1F600}</subagent>',
	'<subagent item="a" outcome="completed">\u0000\u0001</subagent>',      // 控制字符
	'<subagent item="a" outcome="weird">unknown outcome</subagent>',       // outcome 非法值 → 走 failed 分支
	'<subagent item="&lt;x&gt;" model="m&amp;m" ms="12" tool_calls="3" tools="a,b" outcome="completed">r</subagent>',
	'<subagent item="a" mode="resume" team="t" member="mm" agent_id="ag1" state="running" alive="1" stopped="0" outcome="completed">x</subagent>',
	'<subagent item="a" depth="2" role="lead" forked="f1" images="4" at="99" outcome="completed">y</subagent>',
	'<subagent item="one" outcome="completed">1</subagent><subagent item="two" outcome="failed">2</subagent>',
	// 属性缺失:team/member 顶层带 ?? null、task 内不带,是生效语义
	'<subagent outcome="completed">no attrs</subagent>',
	// 数值属性喂非数 —— `Number(x) || 0` 的回落行为
	'<subagent item="a" ms="abc" tool_calls="-3" depth="0" images="1e3" at="NaN" outcome="completed">n</subagent>',
	'<subagent item="outer" outcome="completed"><subagent item="inner" outcome="failed">i</subagent></subagent>', // 嵌套(懒匹配先收在内层)
	'<subagent item="a" outcome="completed">' + 'z'.repeat(50_000) + '</subagent>',
	'<subagent ' + 'item="a" '.repeat(2000) + 'outcome="completed">many</subagent>',
	'<SUBAGENT item="a" outcome="completed">case</SUBAGENT>',              // 大小写:正则不带 i,这条不该匹配
	'<subagent\nitem="a"\noutcome="completed">newline attrs</subagent>',   // [^>]* 吃换行
	'<subagent item="a" outcome="completed"></subagent>',
	'<subagent item="" outcome="">empty attrs</subagent>',
	'<![CDATA[<subagent item="a" outcome="completed">in cdata</subagent>]]>',
])

/** 稳定序列化 —— 差分要区分 undefined 与缺键,JSON.stringify 会把两者都吃掉。 */
function stableRepr(value) {
	if (value === undefined) return '«undefined»'
	if (typeof value === 'number' && Object.is(value, -0)) return '«-0»'
	if (typeof value === 'number' && Number.isNaN(value)) return '«NaN»'
	return JSON.stringify(value, (_key, v) => {
		if (v === undefined) return '«undefined»'
		if (typeof v === 'number' && Number.isNaN(v)) return '«NaN»'
		if (typeof v === 'number' && !Number.isFinite(v)) return `«${v > 0 ? 'Infinity' : '-Infinity'}»`
		return v
	})
}

function shortLabel(value) {
	if (typeof value === 'string') return value.length > 48 ? `string(len=${value.length}) ${JSON.stringify(value.slice(0, 24))}…` : JSON.stringify(value)
	return stableRepr(value).slice(0, 96)
}

/**
 * 把内联实现与一份**参照实现**逐输入对比。
 *
 * 抛出的异常也参与比对:原实现在 `textOf(null)` 这类输入上就是会抛,内联版
 * "顺手加个判空"同样是行为漂移 —— 所以异常类型与消息必须一致才算相同。
 *
 * @param {object} reference 参照模块(真实 swarm)。缺哪个函数就在 missing 里如实报,不静默跳过。
 * @returns {{compared: number, mismatches: Array, missing: string[]}}
 */
export function diffAgainstReference(reference) {
	const missing = []
	for (const name of ['escapeXml', 'unescapeXml', 'textOf', 'parseResultsXml']) {
		if (typeof reference?.[name] !== 'function') missing.push(name)
	}
	const mismatches = []
	let compared = 0
	const run = (fn, input) => {
		try { return { ok: true, value: stableRepr(fn(input)) } } catch (error) {
			return { ok: false, value: `${error?.constructor?.name ?? 'Error'}: ${error?.message ?? error}` }
		}
	}
	const compare = (fnName, ours, theirs, input) => {
		compared += 1
		const a = run(ours, input)
		const b = run(theirs, input)
		if (a.ok === b.ok && a.value === b.value) return
		mismatches.push({ fn: fnName, input: shortLabel(input), inline: `${a.ok ? '' : 'throws '}${a.value}`, reference: `${b.ok ? '' : 'throws '}${b.value}` })
	}

	if (!missing.includes('escapeXml')) for (const v of SCALAR_DIFF_CASES) compare('escapeXml', escapeXml, reference.escapeXml, v)
	if (!missing.includes('unescapeXml')) for (const v of SCALAR_DIFF_CASES) compare('unescapeXml', unescapeXml, reference.unescapeXml, v)
	if (!missing.includes('textOf')) for (const v of TEXT_OF_DIFF_CASES) compare('textOf', textOf, reference.textOf, v)
	if (!missing.includes('parseResultsXml')) for (const v of XML_DIFF_CASES) compare('parseResultsXml', parseResultsXml, reference.parseResultsXml, v)

	return { compared, mismatches, missing }
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
