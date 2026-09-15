/**
 * 宿主环境集成清单 —— 加载、校验、以及**安全阀**。
 *
 * 解决的问题:有些说明符在干净依赖树里解析不到是**预期**的(它由宿主环境提供,
 * 不是本仓的包依赖)。但「预期缺席」这层分类一旦做松,就会变成藏包的手段 ——
 * 任何人只要往清单里加一行,检查器就闭嘴了。
 *
 * 所以这一层的设计前提是**不信任清单**,清单只是「声明」,声明的每一条都要被独立核验:
 *
 *   1. 清单本身可 review:一份 JSON,不是检查器源码里的硬编码数组。缺文件 / JSON 坏 /
 *      条目缺必填字段 → **fail-closed**,明确报错,绝不静默当成空清单。
 *   2. 声明的降级实现要**真的存在**:degradation.file 必须存在,且真的导出
 *      degradation.export。核不到 → 这条声明作废,该包照旧算缺失。
 *   3. **安全阀**:清单里的说明符如果在源码里是**加载期**导入形态
 *      (静态 `import … from` / `import 'x'` / `export … from`,以及判不准的 require)
 *      → 照旧报错并非零退出。理由见 isLoadBearingKind:静态 import 失败是加载期崩溃,
 *      整个插件连同它注册的所有工具一起消失。「宿主集成」只在**动态/可选**形态下成立。
 *   4. 不在清单里的说明符解析不到 → 行为完全不变,照旧非零退出。
 *
 * 还有一条容易被忽略的:宿主集成可能**从静态图里完全消失**(消费点把说明符藏在
 * 变量后面,词法层定不了值)。那样「过滤 graph 结果」的实现会让它悄悄没影 ——
 * 检查通过是因为**没看见**,不是因为**看过且判定为预期缺席**。所以本模块对每条
 * 声明都**独立探测**一次解析结果,不依赖它有没有出现在图里,并在报告里如实标注
 * 图是否观测到它(graphObserved)。
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve } from 'node:path'

import { exportedNames, isLoadBearingKind, resolveBareFrom } from './import-graph.mjs'

export const HOST_INTEGRATIONS_SCHEMA = 'agos-acceptance/host-integrations@1'

/** 每条声明的必填字段。缺任何一个 → fail-closed。 */
export const REQUIRED_FIELDS = ['specifier', 'why', 'degradation.file', 'degradation.export']

class ManifestError extends Error {}

function pick(obj, path) {
	return path.split('.').reduce((acc, k) => (acc == null ? acc : acc[k]), obj)
}

function nonEmptyString(v) {
	return typeof v === 'string' && v.trim().length > 0
}

/**
 * 读并校验清单。**fail-closed**:任何一步不满足都抛 ManifestError,
 * 调用方必须把它当硬失败,不能降级成「空清单」继续跑。
 *
 * @returns {{path: string, integrations: Array<object>}}
 */
export function loadHostIntegrations({ file, repoRoot }) {
	const abs = isAbsolute(file) ? file : resolve(repoRoot, file)
	const shown = relative(repoRoot, abs) || file

	if (!existsSync(abs)) {
		throw new ManifestError(
			`宿主集成清单不存在:${shown}\n`
			+ `  这是 fail-closed:清单缺失不等于「没有宿主集成」,只等于「无法判定」。\n`
			+ `  要声明没有任何宿主集成,请写一份 integrations 为空数组的清单。`,
		)
	}

	let raw
	try { raw = readFileSync(abs, 'utf8') } catch (err) {
		throw new ManifestError(`宿主集成清单读不出来:${shown} —— ${err.message ?? err}`)
	}

	let doc
	try { doc = JSON.parse(raw) } catch (err) {
		throw new ManifestError(`宿主集成清单 JSON 解析失败:${shown} —— ${err.message ?? err}`)
	}

	if (doc == null || typeof doc !== 'object' || Array.isArray(doc)) {
		throw new ManifestError(`宿主集成清单顶层必须是对象:${shown}`)
	}
	if (doc.schema !== HOST_INTEGRATIONS_SCHEMA) {
		throw new ManifestError(
			`宿主集成清单 schema 不认识:${shown}\n`
			+ `  期望 "${HOST_INTEGRATIONS_SCHEMA}",实际 ${JSON.stringify(doc.schema)}`,
		)
	}
	if (!Array.isArray(doc.integrations)) {
		throw new ManifestError(`宿主集成清单缺 integrations 数组:${shown}`)
	}

	const seen = new Map()
	doc.integrations.forEach((entry, i) => {
		const where = `${shown} integrations[${i}]`
		if (entry == null || typeof entry !== 'object' || Array.isArray(entry)) {
			throw new ManifestError(`${where} 必须是对象`)
		}
		for (const field of REQUIRED_FIELDS) {
			if (!nonEmptyString(pick(entry, field))) {
				throw new ManifestError(
					`${where} 缺必填字段 ${field}(或为空)\n`
					+ `  必填:${REQUIRED_FIELDS.join('、')} —— 少一项就无法 review 这条豁免是否成立。`,
				)
			}
		}
		if (entry.consumers != null) {
			if (!Array.isArray(entry.consumers) || entry.consumers.some((c) => !nonEmptyString(c))) {
				throw new ManifestError(`${where} 的 consumers 必须是非空字符串数组`)
			}
		}
		if (seen.has(entry.specifier)) {
			throw new ManifestError(`${where} 说明符重复:${entry.specifier}(已在 integrations[${seen.get(entry.specifier)}])`)
		}
		seen.set(entry.specifier, i)
	})

	return { path: shown, absPath: abs, integrations: doc.integrations }
}

/**
 * 核验每条声明,并对图里观测到的导入形态开安全阀。
 *
 * @param {object} args
 * @param {{integrations: Array<object>, path: string}} args.manifest
 * @param {Array<object>} args.rows  checkBareResolvable() 的结果
 * @param {string} args.repoRoot
 * @returns {Array<object>} 每条一行,verdict ∈ 'resolved' | 'absent-expected' | 'violation'
 */
export function evaluateHostIntegrations({ manifest, rows, repoRoot }) {
	const byPkg = new Map(rows.map((r) => [r.package, r]))

	return manifest.integrations.map((entry) => {
		const problems = []

		// --- 1. 声明的降级实现必须真的存在,且真的导出那个名字 ---
		const degFileAbs = resolve(repoRoot, entry.degradation.file)
		let degradationOk = false
		if (!existsSync(degFileAbs)) {
			problems.push(`声明的降级实现文件不存在:${entry.degradation.file}`)
		} else {
			let names
			try {
				names = exportedNames(readFileSync(degFileAbs, 'utf8'))
			} catch (err) {
				problems.push(`降级实现文件读不出来:${entry.degradation.file} —— ${err.message ?? err}`)
				names = null
			}
			if (names) {
				if (names.names.has(entry.degradation.export)) degradationOk = true
				else if (names.starReexports.length > 0) {
					problems.push(
						`降级实现 ${entry.degradation.file} 里找不到导出 ${entry.degradation.export};`
						+ `该文件有 export * 转导出,静态定不了名 —— 请把降级实现指到直接导出它的文件`,
					)
				} else {
					problems.push(`降级实现 ${entry.degradation.file} 并不导出 ${entry.degradation.export}`)
				}
			}
		}

		// --- 2. 声明的消费点(选填)必须存在 ---
		const missingConsumers = (entry.consumers ?? []).filter((c) => !existsSync(resolve(repoRoot, c)))
		if (missingConsumers.length > 0) problems.push(`声明的消费点不存在:${missingConsumers.join('、')}`)

		// --- 3. 独立探测解析结果,不依赖它有没有出现在静态图里 ---
		const probeDir = existsSync(degFileAbs) ? dirname(degFileAbs) : resolve(repoRoot)
		const probe = resolveBareFrom(probeDir, entry.specifier)

		// --- 4. 安全阀:图里观测到的导入形态 ---
		const row = byPkg.get(entry.specifier)
		const observed = row?.perImporter ?? []
		const loadBearing = observed.filter((imp) => !imp.found && isLoadBearingKind(imp.kind))
		if (loadBearing.length > 0) {
			problems.push(
				`安全阀触发:清单声明它是宿主集成(缺席属预期),但源码里有 ${loadBearing.length} 处是`
				+ `**加载期**导入形态 —— 这类失败会让整个插件加载不了,不是优雅降级`,
			)
		}

		const resolved = probe.found || (row?.resolvable === true)
		return {
			specifier: entry.specifier,
			why: entry.why,
			degradation: entry.degradation,
			degradationOk,
			optInEnv: entry.optInEnv ?? null,
			consumers: entry.consumers ?? [],
			resolved,
			resolvedAt: probe.found ? relative(repoRoot, probe.dir) : null,
			version: probe.version ?? null,
			graphObserved: row != null,
			observedImporters: observed.map((imp) => ({ file: imp.file, line: imp.line, kind: imp.kind, found: imp.found })),
			loadBearingImporters: loadBearing.map((imp) => ({ file: imp.file, line: imp.line, kind: imp.kind })),
			problems,
			verdict: problems.length > 0 ? 'violation' : resolved ? 'resolved' : 'absent-expected',
		}
	})
}

export { ManifestError }
