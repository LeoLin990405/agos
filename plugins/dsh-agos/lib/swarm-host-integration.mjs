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
/**
 * 把指向**包目录**的 opt-in 值翻成它的 ESM 入口文件。
 *
 * 为什么需要:真实宿主上这份 swarm 是一个包目录
 * (`~/.dsh/profiles/<p>/node_modules/dsh-kimicode-swarm`),操作者按 optInEnv 的字面意思
 * 去指它是最自然的动作。但 ESM 的 `import('<目录>')` 不做目录解析,会抛
 * "Directory import ... is not supported" —— 于是一次配置正确的 opt-in 被报成加载失败。
 * 2026-09-09 本轮主控作为该入口第一个外部使用者就是这么撞上的。
 *
 * 只在**确实是目录且确实有 package.json** 时才改写,其余情况原值透传:
 * 裸说明符、已经指向文件的路径、不存在的路径都必须保持原有语义
 * (尤其"路径写错"仍要报硬错误,不能被这层悄悄吞掉)。
 *
 * 读 `exports['.']` 与 `main` 是照 node 自己的包解析顺序,不是自创规则。
 */
async function packageEntryIfDirectory(value) {
	// fs/path 走函数内动态 import,与本文件其余部分一致(它刻意不在加载期引入任何东西)。
	// 写成同步的 statSync 会是 ReferenceError,而下面的 catch 会把它吞成"原值透传" ——
	// 那样这个修复就成了一个静默无效的装饰。落地前实测过目录路径确实被翻成入口文件。
	const { stat, readFile } = await import('node:fs/promises')
	const { join } = await import('node:path')

	let manifestPath
	try {
		if (!(await stat(value)).isDirectory()) return value
		manifestPath = join(value, 'package.json')
		if (!(await stat(manifestPath)).isFile()) return value
	} catch {
		// 不存在 / 不可读 / 是裸说明符 —— 一律原样交给 import,让它给出原本的错误。
		return value
	}

	let manifest
	try {
		manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
	} catch {
		return value
	}

	const conditions = new Set(['node', 'import', 'default'])
	class NoMatchingCondition extends Error {}
	const resolveTarget = (target, trail = "exports['.']") => {
		if (typeof target === 'string' && target !== '') return target
		if (Array.isArray(target)) {
			for (let i = 0; i < target.length; i += 1) {
				try { return resolveTarget(target[i], `${trail}[${i}]`) } catch (error) {
					if (!(error instanceof NoMatchingCondition)) throw error
				}
			}
			throw new NoMatchingCondition(`${trail} 没有可用的 ESM 入口映射`)
		}
		if (target && typeof target === 'object') {
			// Node 条件 exports 按对象书写顺序匹配；不能固定 default/import 优先级。
			let matched = false
			for (const [condition, nested] of Object.entries(target)) {
				if (!conditions.has(condition)) continue
				matched = true
				try { return resolveTarget(nested, `${trail}.${condition}`) } catch (error) {
					if (!(error instanceof NoMatchingCondition)) throw error
				}
			}
			if (matched) throw new NoMatchingCondition(`${trail} 没有可用的匹配条件`)
			if (trail !== "exports['.']") throw new NoMatchingCondition(`${trail} 没有可用的匹配条件`)
			throw new Error(`${trail} 只包含不支持的条件(${Object.keys(target).join(', ')})`)
		}
		throw new Error(`${trail} 必须映射到字符串、条件对象或回退数组`)
	}
	const exportsField = manifest?.exports
	let entry
	if (typeof exportsField === 'string' || Array.isArray(exportsField)) entry = resolveTarget(exportsField)
	else if (exportsField && typeof exportsField === 'object' && Object.prototype.hasOwnProperty.call(exportsField, '.')) {
		entry = resolveTarget(exportsField['.'])
	} else if (exportsField && typeof exportsField === 'object') {
		entry = resolveTarget(exportsField)
	} else {
		entry = manifest?.main
	}
	if (typeof entry !== 'string' || entry === '') return value
	return join(value, entry)
}

export async function resolveSwarmModule(options = {}) {
	const env = options.env ?? process.env
	const importer = typeof options.importer === 'function' ? options.importer : (spec) => import(spec)

	const optIn = env[SWARM_OPT_IN_ENV]
	if (optIn) {
		try {
			return { available: true, module: await importer(await packageEntryIfDirectory(optIn)), source: 'opt-in', reason: null }
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

/**
 * AgOS 实际消费的导出,按消费者分组。
 *
 * 分组不是装饰:一份只缺 xml 组的 swarm 仍然能跑 plan_run,只是 Fleet 的差分没有对照;
 * 缺 scheduler 组则 plan_run 的执行阶段直接不可用。把"缺什么"报成一个布尔值,
 * 排障时就分不清这两种情况 —— 而它们的处置完全不同。
 *
 * ⚠️ registry 的 0.1.0/0.1.1/0.1.2 三版**一项都不导出**(本轮逐版 npm pack 复测:
 * 三版的 `export {}` 清单都只有 Config / SWARM_GUIDANCE / SWARM_SETTINGS_NAMESPACE /
 * apply / inject / renderSwarmResults 六项)。所以"解析到了包"绝不等于"能用"。
 */
export const SWARM_REQUIRED_EXPORTS = Object.freeze({
	scheduler: Object.freeze(['runNormalizedBatch', 'SwarmScheduler']),
	progress: Object.freeze(['publishProgress', 'PROGRESS', 'STOPPED']),
	xml: Object.freeze(['escapeXml', 'unescapeXml', 'textOf', 'parseResultsXml']),
})

/** `SWARM_REQUIRED_EXPORTS` 每一项期望的 typeof,用于把"名字在但类型不对"与"名字都没有"分开。 */
const EXPECTED_TYPEOF = { PROGRESS: 'object', STOPPED: 'object' }

/**
 * 逐符号检查一个已加载的 swarm 模块。
 *
 * 返回 `{ ok, groups, missing, wrongType }`:
 *   missing   —— 名字不存在(registry 版就是这样)
 *   wrongType —— 名字在但类型不对(比 missing 更隐蔽:桩模块最容易在这里露馅)
 *
 * 不抛错 —— 传进来的可能是任意对象,包括 null。判定失败要能被记录成 blockedReason,
 * 而不是把调用方炸掉。
 */
export function inspectSwarmExports(module) {
	const groups = {}
	const missing = []
	const wrongType = []
	for (const [group, names] of Object.entries(SWARM_REQUIRED_EXPORTS)) {
		const present = []
		for (const name of names) {
			const value = module == null ? undefined : module[name]
			const want = EXPECTED_TYPEOF[name] ?? 'function'
			if (value === undefined || value === null) missing.push(name)
			else if (typeof value !== want) wrongType.push({ name, want, got: typeof value })
			else present.push(name)
		}
		groups[group] = { required: [...names], present, ok: present.length === names.length }
	}
	return { ok: missing.length === 0 && wrongType.length === 0, groups, missing, wrongType }
}

/**
 * 解析 swarm 的**文件路径**(而不是加载它)。
 *
 * 为什么与 resolveSwarmModule 分开:provenance 要的是"这份字节从哪来",
 * 而 `import()` 只给对象、不给路径。两件事分开做还有一个好处 —— 路径解析失败
 * 与加载失败是不同的故障,报告里要分得开。
 *
 * data: / node: 这类没有文件实体的说明符如实返回 `path: null`,不编造路径。
 */
export async function locateSwarmModule(options = {}) {
	const env = options.env ?? process.env
	const rawSpecifier = env[SWARM_OPT_IN_ENV] || SWARM_SPECIFIER
	// 与 resolveSwarmModule 走同一次目录→入口归一,否则 opt-in 指向包目录时两者会分叉:
	// 加载成功了,来源判定却拿目录去做文件级取证,把一份证据充分的本地构建报成 origin:unknown。
	// provenance 是本轮最重要的诚实性产物,不能因为操作者写法不同而失真。
	let specifier
	try {
		specifier = await packageEntryIfDirectory(rawSpecifier)
	} catch (error) {
		return { specifier: rawSpecifier, source: env[SWARM_OPT_IN_ENV] ? 'opt-in' : 'sibling', url: null, path: null, error: `${(error && error.message) || error}` }
	}
	const source = env[SWARM_OPT_IN_ENV] ? 'opt-in' : 'sibling'
	const { pathToFileURL, fileURLToPath } = await import('node:url')
	const { isAbsolute } = await import('node:path')
	let url
	try {
		url = isAbsolute(specifier) ? pathToFileURL(specifier).href : import.meta.resolve(specifier)
	} catch (error) {
		return { specifier, source, url: null, path: null, error: `${(error && error.message) || error}` }
	}
	const path = url.startsWith('file:') ? fileURLToPath(url) : null
	return { specifier, source, url, path, error: null }
}

/**
 * 记录一份 swarm 的来源证据。
 *
 * 判定 origin 只用**离线可得的硬证据**,不猜:
 *
 *   `filesAllowlistViolation` —— package.json 的 `files` 白名单决定了 npm tarball 里
 *     能有什么。磁盘上出现白名单外的目录(本机那份有 `test/`)就**不可能**是解包的
 *     tarball,只能是有人在安装后覆盖进去的。这是最硬的一条,不需要联网。
 *   `lockfileClaim` —— 上层 node_modules/.package-lock.json 声称的 resolved/integrity。
 *     它描述的是**当初下载的东西**,不是磁盘现状;两者不一致正是"装完被覆盖"的指纹。
 *   `settingsImport` —— registry 三版都 `import … from "@deepseek-ai/dsh-settings"`,
 *     本机那份没有。补丁去掉了它,这也是整棵依赖树能干净 npm ci 的前提。
 *
 * origin 只有两个取值,且**都必须有证据**:
 *   'local-build' —— 上述任一条硬证据成立
 *   'registry'    —— 没有任何硬证据表明它被改过(注意:这是"未发现改动",
 *                    不等于"字节等于 registry"。要字节级结论得传 compareRegistry)
 *   'unknown'     —— 连 package.json 都读不到,什么都别断言
 */
export async function describeSwarmProvenance(options = {}) {
	const located = options.located ?? await locateSwarmModule(options)
	const base = {
		specifier: located.specifier,
		source: located.source,
		resolvedPath: located.path,
		resolvedUrl: located.url,
		version: null,
		sha256: null,
		origin: 'unknown',
		originNote: null,
		evidence: [],
	}
	if (located.error) return { ...base, originNote: `路径解析失败:${located.error}` }
	if (!located.path) {
		return { ...base, originNote: `说明符 ${located.specifier} 不是文件(${located.url});无文件实体可做来源审计` }
	}

	const { createHash } = await import('node:crypto')
	const { readFile, readdir, stat } = await import('node:fs/promises')
	const { dirname, join, relative, sep } = await import('node:path')

	let sha256 = null
	try { sha256 = createHash('sha256').update(await readFile(located.path)).digest('hex') } catch (error) {
		return { ...base, originNote: `无法读取 ${located.path}:${(error && error.message) || error}` }
	}

	// 从入口文件向上找 package.json —— 入口通常是 <pkg>/lib/index.js,不能假定层数。
	let packageDir = null
	let manifest = null
	for (let dir = dirname(located.path), i = 0; i < 6; i += 1) {
		try {
			manifest = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'))
			packageDir = dir
			break
		} catch { /* 继续向上 */ }
		const parent = dirname(dir)
		if (parent === dir) break
		dir = parent
	}
	if (!manifest || !packageDir) {
		return { ...base, sha256, originNote: `${located.path} 上方 6 层内没有 package.json,无法判定来源` }
	}

	const evidence = []

	// ① files 白名单违例 —— 最硬的一条
	const allowlist = Array.isArray(manifest.files) ? manifest.files : null
	const outsideAllowlist = []
	if (allowlist) {
		const allowedTop = new Set(allowlist.map((entry) => String(entry).replace(/^\.\//, '').split('/')[0]))
		for (const name of ['package.json', 'README', 'LICENSE', 'LICENCE', 'CHANGELOG']) allowedTop.add(name)
		let entries = []
		try { entries = await readdir(packageDir, { withFileTypes: true }) } catch { /* 目录读不到就跳过这条证据 */ }
		for (const entry of entries) {
			const top = entry.name
			if (allowedTop.has(top)) continue
			if ([...allowedTop].some((allowed) => top === allowed || top.startsWith(`${allowed}.`))) continue
			outsideAllowlist.push(entry.isDirectory() ? `${top}/` : top)
		}
	}
	if (outsideAllowlist.length > 0) {
		evidence.push({
			kind: 'filesAllowlistViolation',
			detail: `磁盘上存在 package.json "files" 白名单之外的条目:${outsideAllowlist.sort().join(', ')}`
				+ `(白名单:${allowlist.join(', ')})。npm tarball 不可能包含它们,`
				+ '所以这个目录在安装后被覆盖过。',
		})
	}

	// ② 上层 lockfile 的声称 vs 磁盘现状
	let lockfileClaim = null
	for (let dir = packageDir, i = 0; i < 6; i += 1) {
		const parent = dirname(dir)
		if (parent === dir) break
		if (parent.endsWith(`${sep}node_modules`)) {
			try {
				const lock = JSON.parse(await readFile(join(parent, '.package-lock.json'), 'utf8'))
				const key = `node_modules/${relative(parent, packageDir).split(sep).join('/')}`
				const entry = lock.packages?.[key]
				if (entry) lockfileClaim = { key, resolved: entry.resolved ?? null, integrity: entry.integrity ?? null, version: entry.version ?? null }
			} catch { /* 没有 lockfile 就没有这条证据 */ }
			break
		}
		dir = parent
	}
	if (lockfileClaim?.resolved) {
		evidence.push({
			kind: 'lockfileClaim',
			detail: `上层 .package-lock.json 声称本包来自 ${lockfileClaim.resolved}`
				+ `(integrity ${lockfileClaim.integrity ?? 'n/a'})。该记录描述的是**当初下载的 tarball**,`
				+ '不是磁盘现状;与其它证据冲突时以磁盘为准。',
		})
	}

	// ③ registry 三版都有的 dsh-settings 导入,本机那份被补丁去掉了
	try {
		const src = await readFile(located.path, 'utf8')
		const importsSettings = /from\s*["']@deepseek-ai\/dsh-settings["']/.test(src)
		const exportCount = (/^export\s*\{([^}]*)\}/m.exec(src)?.[1] ?? '').split(',').map((s) => s.trim()).filter(Boolean).length
		if (!importsSettings) {
			evidence.push({
				kind: 'settingsImportRemoved',
				detail: `入口未导入 @deepseek-ai/dsh-settings,而 registry 的 0.1.0/0.1.1/0.1.2 三版都导入它`
					+ '(那正是整棵依赖树装不出来的根因)。缺这行说明这份字节被打过补丁。',
			})
		}
		if (exportCount > 6) {
			evidence.push({
				kind: 'exportSurfaceWiderThanRegistry',
				detail: `入口导出 ${exportCount} 个符号,而 registry 三版都只导出 6 个。`,
			})
		}
	} catch { /* 读不到源码就跳过这两条 */ }

	// ④ 可选的字节级对照(要联网下载 tarball,由调用方显式开启)
	if (options.registryComparison) evidence.push(options.registryComparison)

	const comparison = options.registryComparison
	const hard = evidence.filter((e) => e.kind !== 'lockfileClaim' && e.kind !== 'registryComparison')
	if (comparison?.status === 'differs') hard.push(comparison)
	const origin = hard.length > 0 ? 'local-build'
		: comparison?.status === 'unavailable' ? 'unknown' : 'registry'
	const originNote = hard.length > 0
		? `按 ${hard.map((e) => e.kind).join(' / ')} 判定为本地构建产物。`
			+ (lockfileClaim?.resolved ? `注意 lockfile 仍记着 registry 来源(${lockfileClaim.resolved}),` +
				'两者不一致说明是"registry 安装后被本地产物覆盖"—— lockfile 对这份字节没有约束力。' : '')
			+ '目录内无 .git / 无 src / 无构建记录:**补丁与上游 commit 不可审计**,只有构建产物本身。'
			+ '代表性与审计边界见 docs/engineering/agos-round4-20260909/COVERAGE.md §2。'
		: comparison?.status === 'unavailable'
			? 'registry 对照不可用；没有足够证据判断来源，保持 unknown。'
			: comparison?.status === 'identical'
				? '字节级对照与 registry 相同；这证明等价，但不证明本地产物来源。'
				: '未发现任何被改动的硬证据。注意这只是"未发现改动",不等于字节等于 registry;'
					+ '要字节级结论请开 registry 对照。'

	return {
		specifier: located.specifier,
		source: located.source,
		resolvedPath: located.path,
		resolvedUrl: located.url,
		packageDir,
		name: manifest.name ?? null,
		version: manifest.version ?? null,
		sha256,
		origin,
		originNote,
		lockfileClaim,
		filesAllowlist: allowlist,
		outsideAllowlist,
		evidence,
	}
}
