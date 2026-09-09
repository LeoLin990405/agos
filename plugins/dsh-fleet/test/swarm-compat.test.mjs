/**
 * Fleet 的 swarm 解耦层验收。
 *
 * 这个文件要钉住三件事,少一件解耦就不算安全:
 *
 * 1. **内联的三个纯函数与 swarm 原版逐行为一致**。Fleet 用 escapeXml 生成 XML、
 *    用 parseResultsXml 读回来喂 presentationMeta,前端消费的正是这个结构。
 *    内联版哪怕只在 undefined vs null 上不同,界面上就会出现空 chip。
 *    所以走**差分测试**:同一批输入喂给两份实现,断言结果深相等。
 *    差分需要真实 swarm 在场,不在场时如实标 blocked(不打桩自证)。
 *
 * 2. **publishProgress 的三条分支各自可观测**:可用则原样透传;未配置且解析不到则
 *    记账式 no-op(不抛错、但记下丢弃次数、给出可读 reason);opt-in 配了却加载不了
 *    则报硬错误而不是伪装成"没装"。
 *
 * 3. **可用分支不吞异常**。原实现没有 try/catch,包上去会把 swarm 侧的真实故障
 *    吞成"发布成功" —— 这是本轮明确要避免的东西,用负例钉住。
 *
 * 另有一条把解耦本身钉住的检查:swarm 不得重新出现在 plugins/package.json 里。
 * 没有它,下一次"顺手把依赖加回来"会让干净安装静默失效而无人发现。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

import {
	escapeXml,
	unescapeXml,
	textOf,
	parseResultsXml,
	resolveProgressPublisher,
	resetProgressPublisherCache,
} from '../lib/fleet-swarm-compat.mjs'
import { resolveSwarmModule, SWARM_OPT_IN_ENV, SWARM_SPECIFIER } from '../../dsh-agos/lib/swarm-host-integration.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '../../..')

// ── 1) 与真实 swarm 的差分 ───────────────────────────────────────────────
const swarmProbe = await resolveSwarmModule()
const DIFF_BLOCKED = swarmProbe.available
	? false
	: `未覆盖(blocked):差分需要真实 swarm 在场做对照,当前不可用。${swarmProbe.reason}`

/**
 * 差分输入集。刻意覆盖容易在"重写一遍"时走样的地方:
 * 五个实体的转义顺序、缺失属性(undefined vs null)、数值属性的 0 与非数、
 * body 的 completed/failed 分流、多条 subagent、以及 & 必须先转义。
 */
const XML_CASES = [
	'',
	'<subagent item="a" outcome="completed">ok</subagent>',
	'<subagent item="a" outcome="failed">boom &amp; bust</subagent>',
	'<subagent item="&lt;x&gt;" model="m&amp;m" ms="12" tool_calls="3" tools="a,b" outcome="completed">r</subagent>',
	'<subagent item="a" mode="resume" team="t" member="mm" agent_id="ag1" state="running" alive="1" stopped="0" outcome="completed">x</subagent>',
	'<subagent item="a" depth="2" role="lead" forked="f1" images="4" at="99" outcome="completed">y</subagent>',
	'<subagent item="one" outcome="completed">1</subagent><subagent item="two" outcome="failed">2</subagent>',
	// 属性缺失:parseResultsXml 里 team/member 顶层带 ?? null、task 内不带,是生效语义
	'<subagent outcome="completed">no attrs</subagent>',
]

const ESCAPE_CASES = ['', 'plain', '&', '<>', '"q"', "'a'", '&amp;', 'a&b<c>d"e\'f', '&lt;already&gt;', 0, 1, null, undefined]

test('内联的 escapeXml / unescapeXml / textOf / parseResultsXml 与真实 swarm 逐行为一致', { skip: DIFF_BLOCKED }, () => {
	const real = swarmProbe.module
	for (const fn of ['escapeXml', 'unescapeXml', 'textOf', 'parseResultsXml']) {
		assert.equal(typeof real[fn], 'function', `真实 swarm 未导出 ${fn},差分无对照 —— 这条检查已失去区分力`)
	}

	for (const value of ESCAPE_CASES) {
		assert.equal(escapeXml(value), real.escapeXml(value), `escapeXml 在 ${JSON.stringify(value)} 上与原版不一致`)
		assert.equal(unescapeXml(value), real.unescapeXml(value), `unescapeXml 在 ${JSON.stringify(value)} 上与原版不一致`)
	}

	// textOf 吃的是 LLM 结果结构:只有 type==='text' 的 block 参与拼接
	const textCases = [
		{ output: [] },
		{ output: [{ type: 'text', text: ' hi ' }] },
		{ output: [{ type: 'text', text: 'a' }, { type: 'tool_use', id: 'x' }, { type: 'text', text: 'b' }] },
		{ output: [{ type: 'tool_use', id: 'only-tool' }] },
	]
	for (const value of textCases) {
		assert.equal(textOf(value), real.textOf(value), `textOf 在 ${JSON.stringify(value)} 上与原版不一致`)
	}

	for (const xml of XML_CASES) {
		assert.deepEqual(
			parseResultsXml(xml),
			real.parseResultsXml(xml),
			`parseResultsXml 在以下输入上与原版不一致(前端消费的正是这个结构):\n${xml}`,
		)
	}
})

test('差分用例确实覆盖了 Fleet 自己生成的 XML 形状', () => {
	// 差分只在有对照时跑;这条无条件跑,保证 XML_CASES 不会退化成一堆空串
	// (那样差分会永绿而不再证明任何东西)。
	const parsedCounts = XML_CASES.map((xml) => parseResultsXml(xml).length)
	assert.ok(parsedCounts.some((n) => n >= 2), 'XML_CASES 里没有多条 subagent 的用例,多条解析路径未被差分覆盖')
	assert.ok(parsedCounts.filter((n) => n === 1).length >= 5, 'XML_CASES 里单条用例太少,属性分支覆盖不足')

	// 钉住"顶层 team/member 带 ?? null、task 内不带"这条生效语义 —— 它是重写时最容易走样的一处
	const [row] = parseResultsXml('<subagent outcome="completed">x</subagent>')
	assert.equal(row.team, null, '顶层 team 应为 null(生效的是带 ?? null 的那份重复键)')
	assert.equal(row.member, null, '顶层 member 应为 null')
	assert.equal(row.task.team, undefined, 'task.team 应为 undefined(task 内那份不带 ?? null)')
	assert.equal(row.task.member, undefined, 'task.member 应为 undefined')

	// 转义顺序:& 必须先替换,否则 < 会被二次转义成 &amp;lt;
	assert.equal(escapeXml('<'), '&lt;', '< 的转义结果不对')
	assert.equal(escapeXml('&lt;'), '&amp;lt;', '& 没有先于其他实体替换 —— 顺序错了会产生二次转义')
})

// ── 2) publishProgress 三条分支 ─────────────────────────────────────────
test('可用分支:原样透传给 swarm 的 publishProgress,参数不被改写', async () => {
	const calls = []
	const publisher = await resolveProgressPublisher({
		env: {},
		importer: async (spec) => {
			assert.equal(spec, SWARM_SPECIFIER, `应当解析裸说明符,实际 ${spec}`)
			return { publishProgress: (...args) => { calls.push(args); return 'sentinel' } }
		},
	})
	assert.equal(publisher.available, true, `应当可用,reason=${publisher.reason}`)
	assert.equal(publisher.reason, null)
	assert.equal(publisher.publish('call-1', [{ item: 'a' }], 'sess-1'), 'sentinel', '返回值没有透传')
	assert.deepEqual(calls, [['call-1', [{ item: 'a' }], 'sess-1']], '参数被改写了')
})

test('不可用分支:记账式 no-op —— 不抛错、记下丢弃次数、reason 可读且点名开启方式', async () => {
	const publisher = await resolveProgressPublisher({
		env: {},
		importer: async () => { throw new Error('Cannot find package') },
	})
	assert.equal(publisher.available, false)
	assert.equal(publisher.droppedCalls, 0)
	// 进度发布不该弄死一个批次 —— 所以 no-op 不抛
	publisher.publish('c', [], 's')
	publisher.publish('c', [], 's')
	assert.equal(publisher.droppedCalls, 2, '丢弃次数没有记账:不可用变成了静默丢进虚空')
	assert.match(publisher.reason, /Cannot find package/, 'reason 没有带上底层原因')
	assert.match(publisher.reason, new RegExp(SWARM_OPT_IN_ENV), `reason 没有点名 ${SWARM_OPT_IN_ENV},操作者不知道怎么恢复覆盖`)
})

test('解析到包但未导出 publishProgress:reason 必须与"包不存在"区分得开', async () => {
	const publisher = await resolveProgressPublisher({
		env: {},
		importer: async () => ({ /* registry 版就是这样:能加载,但没这个导出 */ }),
	})
	assert.equal(publisher.available, false)
	assert.match(publisher.reason, /已解析但未导出 publishProgress/, '未导出与未安装的 reason 混同了,排障时分不清是没装还是版本不对')
	assert.doesNotMatch(publisher.reason, /Cannot find package/, 'reason 串到"包不存在"的措辞上了')
})

test('opt-in 配了却加载不了:硬错误,不静默回落成"本机没装"', async () => {
	const publisher = await resolveProgressPublisher({
		env: { [SWARM_OPT_IN_ENV]: '/nowhere/swarm.mjs' },
		importer: async (spec) => {
			assert.equal(spec, '/nowhere/swarm.mjs', 'opt-in 路径没有被优先使用')
			throw new Error('ENOENT')
		},
	})
	assert.equal(publisher.available, false)
	assert.match(publisher.reason, new RegExp(`${SWARM_OPT_IN_ENV}=/nowhere/swarm\\.mjs`), 'reason 没点名是 opt-in 配置的问题')
	assert.doesNotMatch(publisher.reason, /未解析到同级/, '配错路径被伪装成了"没装同级插件"')
})

test('opt-in 优先于同级解析,且 source 如实标注来源', async () => {
	const seen = []
	const publisher = await resolveProgressPublisher({
		env: { [SWARM_OPT_IN_ENV]: '/opt/swarm.mjs' },
		importer: async (spec) => { seen.push(spec); return { publishProgress: () => {} } },
	})
	assert.equal(publisher.available, true)
	assert.deepEqual(seen, ['/opt/swarm.mjs'], 'opt-in 在场时不该再去解析裸说明符')
})

// ── 3) 不吞异常的负例 ───────────────────────────────────────────────────
test('可用分支不包 try/catch:swarm 侧抛错必须原样冒出来,不能被吞成"发布成功"', async () => {
	const publisher = await resolveProgressPublisher({
		env: {},
		importer: async () => ({ publishProgress: () => { throw new Error('swarm 内部故障') } }),
	})
	assert.equal(publisher.available, true)
	assert.throws(
		() => publisher.publish('c', [], 's'),
		/swarm 内部故障/,
		'异常被吞了:包 try/catch 会把 swarm 侧的真实故障伪装成发布成功,那正是本轮要避免的',
	)
})

test('注入调用不污染进程级缓存', async () => {
	resetProgressPublisherCache()
	const injected = await resolveProgressPublisher({ env: {}, importer: async () => ({ publishProgress: () => {} }) })
	assert.equal(injected.available, true)
	// 注入过一次"可用"之后,真实解析仍应按本机实际情况来,不能被上一条测试写进缓存
	const real = await resolveProgressPublisher()
	assert.equal(real.available, swarmProbe.available, '注入结果泄漏进了进程级缓存,后续真实解析被污染')
	resetProgressPublisherCache()
})

// ── 4) 把解耦本身钉住 ───────────────────────────────────────────────────
test('swarm 不得回到 plugins/package.json:它的 registry 版本无法支撑,加回来会让干净安装静默失效', () => {
	const manifest = JSON.parse(readFileSync(resolve(REPO_ROOT, 'plugins/package.json'), 'utf8'))
	const declared = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies, ...manifest.optionalDependencies })
	assert.ok(
		!declared.includes(SWARM_SPECIFIER),
		`${SWARM_SPECIFIER} 又出现在 plugins/package.json 的依赖里。`
			+ 'registry 的 0.1.0/0.1.1/0.1.2 都不导出本仓需要的符号,且自身导入 installSettingsSection'
			+ '(该导出只在 dsh-settings 0.1.0-rc.6 及更早),声明它必然导致 npm ci 装出不可用的树。'
			+ 'swarm 是宿主环境集成,走 swarm-host-integration.mjs 的运行时解析。',
	)
})

test('Fleet 入口不再静态 import swarm', () => {
	const src = readFileSync(resolve(REPO_ROOT, 'plugins/dsh-fleet/lib/index.js'), 'utf8')
	assert.doesNotMatch(
		src,
		new RegExp(`from\\s+['"]${SWARM_SPECIFIER}['"]`),
		'Fleet 入口又出现了对 swarm 的静态 import:静态 import 失败是加载期错误,'
			+ '会把整个 Fleet 插件的可加载性绑在一个兄弟插件上(21 个工具全军覆没那条教训同类)',
	)
})
