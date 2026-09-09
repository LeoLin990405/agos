/**
 * swarm(dsh-kimicode-swarm)是**宿主环境集成**,不是本仓的包依赖 —— 单一解析策略。
 *
 * 为什么这么定性(本轮实测取得的事实,不是沿用旧结论):
 *
 * 1. registry 上的 dsh-kimicode-swarm 0.1.0 / 0.1.1 / 0.1.2 逐版 `npm pack` 检查:
 *    **一个都不导出** AgOS 需要的符号(publishProgress / parseResultsXml / escapeXml /
 *    textOf,以及 cn-capabilities 用的调度器 runNormalizedBatch)。
 * 2. 三个 registry 版本自身都 `import { installSettingsSection } from '@deepseek-ai/dsh-settings'`,
 *    而该导出只存在于 dsh-settings 0.1.0-rc.6 及更早。ESM 具名导入缺失是**加载期**
 *    SyntaxError,所以整棵树的 settings 必须降到 rc.6,而 rc.6 的 peer 属另一条线,
 *    与其余包的 ^0.1.2-rc.1 冲突 —— 这就是上一轮 `npm ci` 无法复现可用树的根因。
 * 3. 上游源码(github.com/hongyue0721/dsh-kimicode-swarm @ 311d6f42,version 0.1.2)
 *    确实带 src/ 与构建配置,但 `src/index.ts:12` **仍然**导入 installSettingsSection,
 *    照它构建只会把第 2 条的冲突原样带回来。
 * 4. 真实宿主上能用的那份是操作者放在各 profile 的 plugins/kimicode-swarm-aligned 下
 *    的**对齐构建产物**:它的 import 表里没有 dsh-settings(补丁去掉了),导出表比 registry
 *    版多约 30 个符号。但该目录只有 lib/ 打包产物,**没有 src/、没有 .git**,补丁本身不可得
 *    —— 既无可审查来源,也无可复现构建,不满足"确需保留就要有可审查来源"的门槛,
 *    因此不 vendor 进仓。
 *
 * 结论:swarm 在真实宿主上本来就是**同级插件**(已核实 ~/.dsh/profiles/{desktop,web}/
 * 均有 plugins/kimicode-swarm-aligned 与 node_modules/dsh-kimicode-swarm),运行时解析
 * 得到就用,解析不到就**显式**报不可用。它不进 plugins/package.json,于是那棵树
 * 可以由 `npm ci` 从公开 registry 干净复现。
 *
 * 覆盖率的代价如实记账:干净树上依赖真调度器的检查会报 blocked 而不是 pass。
 * 想在本机跑满覆盖,把 AGOS_SWARM_MODULE 指向一份可用的 swarm 即可(见下)。
 */

/** swarm 的裸说明符。集中一处,依赖面扫描器与测试都从这里取,不各自硬编码。 */
export const SWARM_SPECIFIER = 'dsh-kimicode-swarm'

/**
 * 显式 opt-in:指向一份可用 swarm 的模块路径(绝对路径或可解析说明符)。
 * 设了它就是操作者明确要求走这条集成 —— 于是加载失败是**硬错误**,
 * 不能降级成"未配置",否则配错路径会被静默当成没装。
 */
export const SWARM_OPT_IN_ENV = 'AGOS_SWARM_MODULE'

/**
 * 解析 swarm 模块。
 *
 * @returns {Promise<{available: boolean, module: any, source: 'opt-in'|'sibling'|null, reason: string|null}>}
 *   available=true  → module 可用,source 说明来自 opt-in 还是同级插件解析
 *   available=false → module 为 null,reason 是**可读且可区分**的原因:
 *                     "未配置且同级解析失败" 与 "opt-in 配了但加载失败" 必须分得开,
 *                     否则排障时分不清是没装还是路径写错。
 *
 * @param {object} [options]
 * @param {(specifier: string) => Promise<any>} [options.importer] 注入点,供测试模拟
 *   存在/缺失两种分支而无需真的装包。生产走默认动态 import。
 * @param {Record<string, string|undefined>} [options.env] 注入环境,默认 process.env。
 */
export async function resolveSwarmModule(options = {}) {
	const env = options.env ?? process.env
	const importer = typeof options.importer === 'function' ? options.importer : (spec) => import(spec)

	const optIn = env[SWARM_OPT_IN_ENV]
	if (optIn) {
		try {
			return { available: true, module: await importer(optIn), source: 'opt-in', reason: null }
		} catch (error) {
			// 显式配置了却加载不了 —— 不静默回落到同级解析,那会把"路径写错"
			// 伪装成"本机没装",操作者永远看不到自己配错了。
			return {
				available: false,
				module: null,
				source: null,
				reason: `${SWARM_OPT_IN_ENV}=${optIn} 指定的 swarm 加载失败:`
					+ `${(error && error.message) || error}`,
			}
		}
	}

	try {
		return { available: true, module: await importer(SWARM_SPECIFIER), source: 'sibling', reason: null }
	} catch (error) {
		return {
			available: false,
			module: null,
			source: null,
			reason: `未解析到同级 swarm 插件(${SWARM_SPECIFIER}):${(error && error.message) || error}`
				+ `。swarm 是宿主环境集成而非本仓依赖,干净依赖树里本就没有它;`
				+ `要在本机启用请设 ${SWARM_OPT_IN_ENV} 指向一份可用的 swarm 模块。`,
		}
	}
}
