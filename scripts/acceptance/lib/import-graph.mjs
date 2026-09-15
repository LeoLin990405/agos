// 从入口文件出发遍历**完整导入图**,把所有裸模块说明符(bare specifier)挖出来。
//
// 为什么需要:上一轮的依赖面是**运行时观测**的 —— 跑 node --test,看它报哪个包找不到。
// Node 只报模块图里遇到的**第一个**未解析说明符就退出,于是 dsh-fleet 只留下了
// schemastery 一条记录,而它在模块层还需要另外几个包(HANDOFF.md:176 已记为未修)。
// 结果 prepare-host-modules.mjs --check 会在「8 个套件其实都加载不了」的机器上
// 报「依赖面就绪」并 exit 0 —— 这正是审查者判定「不能证明完整依赖面」的原因。
//
// 修法:不靠运行时报错,直接静态遍历。从每个插件的入口(package.json 的 main/exports/bin、
// lib/index.js、test/*.mjs)出发,递归跟随**相对**导入,把途中所有裸说明符收集起来。
// 一次扫描拿到全图,而不是「跑一次修一个再跑」的迭代。
//
// 口径与边界(诚实声明):
//   · 用自带的最小 JS 词法器切 token,再在 token 流上匹配 import/export/require 形态。
//     不是完整 parser,但因为字符串与注释是先被词法器吃掉的,注释里或字符串里的
//     `from 'x'` **不会**被误当成导入 —— 这是纯正则做不到的。
//   · 只递归**相对/绝对**导入(插件自己的源码);裸说明符是叶子,只判「包根能否解析」,
//     不再往包内部走。也就是说:**不覆盖已装包自身的传递依赖**(那由 npm 保证)。
//   · 动态 import(变量) / require(变量) 无法静态定值,如实记为 dynamic-nonliteral 并披露,
//     不假装扫全了。
//   · 未解析的**相对**导入单独归类(unresolvedRelative),默认只报不阻断 —— 它可能是
//     .node 二进制或构建产物;要阻断用 --strict-graph。

import { existsSync, lstatSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { builtinModules } from 'node:module'

const BUILTINS = new Set(builtinModules)
const PARSEABLE = new Set(['.js', '.mjs', '.cjs'])
const FILE_EXTS = ['.js', '.mjs', '.cjs', '.json', '.node']
const INDEX_FILES = ['index.js', 'index.mjs', 'index.cjs', 'index.json']

// ---------------------------------------------------------------------------
// 最小 JS 词法器
// ---------------------------------------------------------------------------

const ID_START = /[A-Za-z_$]/
const ID_PART = /[A-Za-z0-9_$]/
// `/` 之前出现这些 token 时它是正则字面量的开头,而不是除号。
const REGEX_OK_AFTER_PUNCT = new Set(['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '^', '~', '<', '>', '=>', '===', '!==', '==', '!=', '&&', '||', '??'])
const REGEX_OK_AFTER_WORD = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'case', 'do', 'else', 'yield', 'await', 'throw'])

/**
 * 把源码切成 token。字符串/模板/正则/注释都在这一层被正确吃掉,
 * 所以下游匹配不会被注释里的示例代码或字符串里的 `from 'x'` 骗到。
 * 返回 [{ type: 'name'|'string'|'punct'|'num'|'regex'|'template', value, line }]
 */
export function tokenize(src) {
	const tokens = []
	let i = 0
	let line = 1
	const n = src.length
	// 模板字面量里的 ${} 需要嵌套计数:进 ${ 就回到普通词法,} 配平后回到模板。
	const templateStack = []
	let braceDepth = 0

	const lastSignificant = () => tokens[tokens.length - 1] ?? null
	const regexAllowed = () => {
		const t = lastSignificant()
		if (!t) return true
		if (t.type === 'name') return REGEX_OK_AFTER_WORD.has(t.value)
		if (t.type === 'punct') return REGEX_OK_AFTER_PUNCT.has(t.value)
		return false // string/num/regex/template 之后的 `/` 是除号
	}

	while (i < n) {
		const c = src[i]

		if (c === '\n') { line += 1; i += 1; continue }
		if (c === ' ' || c === '\t' || c === '\r' || c === '\f' || c === '\v') { i += 1; continue }

		// 注释
		if (c === '/' && src[i + 1] === '/') {
			while (i < n && src[i] !== '\n') i += 1
			continue
		}
		if (c === '/' && src[i + 1] === '*') {
			i += 2
			while (i < n && !(src[i] === '*' && src[i + 1] === '/')) { if (src[i] === '\n') line += 1; i += 1 }
			i += 2
			continue
		}
		// hashbang 只在第 1 个字节位置算注释
		if (c === '#' && i === 0 && src[i + 1] === '!') {
			while (i < n && src[i] !== '\n') i += 1
			continue
		}

		// 字符串
		if (c === '"' || c === "'") {
			const quote = c
			let val = ''
			i += 1
			while (i < n && src[i] !== quote) {
				if (src[i] === '\\') { val += src[i + 1] ?? ''; i += 2; continue }
				if (src[i] === '\n') line += 1
				val += src[i]
				i += 1
			}
			i += 1
			tokens.push({ type: 'string', value: val, line })
			continue
		}

		// 模板字面量
		if (c === '`') {
			i += 1
			let val = ''
			let sawSubstitution = false
			for (;;) {
				if (i >= n) break
				if (src[i] === '\\') { val += src[i + 1] ?? ''; i += 2; continue }
				if (src[i] === '`') { i += 1; break }
				if (src[i] === '$' && src[i + 1] === '{') {
					sawSubstitution = true
					templateStack.push(braceDepth)
					braceDepth += 1
					i += 2
					// 交回主循环处理 ${} 内部;模板剩余部分由 } 配平后继续。
					tokens.push({ type: sawSubstitution ? 'template' : 'string', value: val, line, dynamic: true })
					val = ''
					break
				}
				if (src[i] === '\n') line += 1
				val += src[i]
				i += 1
			}
			// 没有插值的模板等价于字符串字面量,可以当 specifier 用。
			if (!sawSubstitution) tokens.push({ type: 'string', value: val, line, fromTemplate: true })
			continue
		}

		// 正则字面量
		if (c === '/' && regexAllowed()) {
			let j = i + 1
			let inClass = false
			let closed = false
			while (j < n) {
				const d = src[j]
				if (d === '\\') { j += 2; continue }
				if (d === '\n') break
				if (d === '[') inClass = true
				else if (d === ']') inClass = false
				else if (d === '/' && !inClass) { closed = true; break }
				j += 1
			}
			if (closed) {
				j += 1
				while (j < n && ID_PART.test(src[j])) j += 1
				tokens.push({ type: 'regex', value: src.slice(i, j), line })
				i = j
				continue
			}
			// 没闭合 → 当除号处理,落到下面的 punct 分支
		}

		// 标识符 / 关键字
		if (ID_START.test(c)) {
			let j = i
			while (j < n && ID_PART.test(src[j])) j += 1
			tokens.push({ type: 'name', value: src.slice(i, j), line })
			i = j
			continue
		}

		// 数字(不需要精确,只要别把 . 和 e+ 切碎影响后续匹配)
		if (/[0-9]/.test(c)) {
			let j = i
			while (j < n && /[0-9a-fA-FxXoObBn._]/.test(src[j])) j += 1
			tokens.push({ type: 'num', value: src.slice(i, j), line })
			i = j
			continue
		}

		// 私有字段 #x
		if (c === '#' && ID_START.test(src[i + 1] ?? '')) {
			let j = i + 1
			while (j < n && ID_PART.test(src[j])) j += 1
			tokens.push({ type: 'name', value: src.slice(i, j), line })
			i = j
			continue
		}

		// 标点:先试多字符运算符,保证 `=>`/`===` 之类不被切碎(影响 regexAllowed 判断)
		let matched = null
		for (const op of ['>>>=', '...', '===', '!==', '**=', '<<=', '>>=', '&&=', '||=', '??=', '=>', '==', '!=', '<=', '>=', '&&', '||', '??', '?.', '++', '--', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '**', '<<', '>>']) {
			if (src.startsWith(op, i)) { matched = op; break }
		}
		const val = matched ?? c
		if (val === '{') braceDepth += 1
		if (val === '}') {
			braceDepth -= 1
			if (templateStack.length > 0 && templateStack[templateStack.length - 1] === braceDepth) {
				// ${} 结束 → 回到模板字面量继续扫描
				templateStack.pop()
				i += 1
				let tval = ''
				let sawSub = false
				for (;;) {
					if (i >= n) break
					if (src[i] === '\\') { tval += src[i + 1] ?? ''; i += 2; continue }
					if (src[i] === '`') { i += 1; break }
					if (src[i] === '$' && src[i + 1] === '{') {
						sawSub = true
						templateStack.push(braceDepth)
						braceDepth += 1
						i += 2
						break
					}
					if (src[i] === '\n') line += 1
					tval += src[i]
					i += 1
				}
				tokens.push({ type: 'template', value: tval, line, dynamic: true, sawSub })
				continue
			}
		}
		tokens.push({ type: 'punct', value: val, line })
		i += val.length
	}
	return tokens
}

/**
 * 收集同文件内 `const/let/var <名> = '<字面量>'` 的绑定,用于折叠
 * `import(SPECIFIER)` 这种「动态语法 + 静态值」的常见写法。
 *
 * 实测必要性:plugins/dsh-fleet/lib/fleet-swarm-compat.mjs 用
 *   export const SWARM_SPECIFIER = 'dsh-kimicode-swarm'
 *   await importer(SWARM_SPECIFIER)
 * 把 swarm 依赖从静态 import 改成了动态 import。不折叠这个常量,整条依赖就在
 * 静态图里凭空消失 —— 那正是「漏报缺包」的另一种形态。
 *
 * 边界(诚实声明):只折叠**同文件**内绑定到字符串字面量的标识符;
 * 不跨模块、不做数据流分析、不处理重新赋值与作用域遮蔽。折叠结果会标注来源,
 * 折叠不了的仍旧如实记为 dynamic-nonliteral。
 */
function collectStringConsts(tokens) {
	const binds = new Map()
	for (let i = 0; i < tokens.length - 3; i += 1) {
		const t = tokens[i]
		if (t.type !== 'name' || !['const', 'let', 'var'].includes(t.value)) continue
		const name = tokens[i + 1]
		const eq = tokens[i + 2]
		const val = tokens[i + 3]
		if (name?.type !== 'name') continue
		if (eq?.type !== 'punct' || eq.value !== '=') continue
		if (val?.type !== 'string') continue
		// 重复绑定同名标识符 → 不可信,撤销折叠(宁可报 nonliteral 也不报错值)
		if (binds.has(name.value) && binds.get(name.value) !== val.value) binds.set(name.value, null)
		else if (!binds.has(name.value)) binds.set(name.value, val.value)
	}
	return binds
}

/**
 * 在 token 流上找出所有导入形态。
 * 覆盖:import 'x' / import … from 'x' / export … from 'x' / import('x') /
 *       require('x') / require.resolve('x'),以及 import(<同文件字符串常量>)。
 * 仍然折叠不了的动态形态记为 dynamic-nonliteral(如实披露,不假装扫到了)。
 */
export function extractSpecifiers(src) {
	const tokens = tokenize(src)
	const found = []
	const dynamic = []
	const isStr = (t) => t && t.type === 'string'
	const consts = collectStringConsts(tokens)
	/** 动态导入的实参:字符串字面量直接用;单个标识符尝试常量折叠;其余放弃。 */
	const dynamicArg = (argIdx) => {
		const arg = tokens[argIdx]
		if (isStr(arg)) return { specifier: arg.value, folded: false, line: arg.line }
		const close = tokens[argIdx + 1]
		if (arg?.type === 'name' && close?.type === 'punct' && close.value === ')') {
			const v = consts.get(arg.value)
			if (typeof v === 'string' && v !== '') return { specifier: v, folded: true, via: arg.value, line: arg.line }
		}
		return null
	}

	for (let i = 0; i < tokens.length; i += 1) {
		const t = tokens[i]
		if (t.type !== 'name') continue

		if (t.value === 'import' || t.value === 'export') {
			const next = tokens[i + 1]
			if (!next) continue
			// import.meta / export.something → 不是导入说明符
			if (next.type === 'punct' && next.value === '.') continue
			// import('x') / import(SPEC) 动态导入
			if (t.value === 'import' && next.type === 'punct' && next.value === '(') {
				const a = dynamicArg(i + 2)
				if (a) found.push({ specifier: a.specifier, kind: a.folded ? `dynamic-import (折叠常量 ${a.via})` : 'dynamic-import', line: a.line })
				else dynamic.push({ kind: 'dynamic-import', line: next.line, note: '参数既不是字符串字面量,也不是同文件内绑定到字面量的标识符,静态无法定值' })
				continue
			}
			// import 'x'(仅副作用)
			if (t.value === 'import' && isStr(next)) {
				found.push({ specifier: next.value, kind: 'side-effect-import', line: next.line })
				continue
			}
			// import … from 'x' / export … from 'x':向前找同一语句里的 from
			let j = i + 1
			const limit = Math.min(tokens.length, i + 400)
			while (j < limit) {
				const tj = tokens[j]
				if (tj.type === 'punct' && tj.value === ';') break
				// 撞上下一条 import/export 说明这条语句没有 from(如 `export const x = 1`)
				if (tj.type === 'name' && (tj.value === 'import' || tj.value === 'export') && j > i + 1) break
				if (tj.type === 'name' && tj.value === 'from' && isStr(tokens[j + 1])) {
					found.push({ specifier: tokens[j + 1].value, kind: `${t.value}-from`, line: tokens[j + 1].line })
					break
				}
				j += 1
			}
			continue
		}

		if (t.value === 'require') {
			const next = tokens[i + 1]
			if (next && next.type === 'punct' && next.value === '(') {
				const a = dynamicArg(i + 2)
				if (a) found.push({ specifier: a.specifier, kind: a.folded ? `require (折叠常量 ${a.via})` : 'require', line: a.line })
				else dynamic.push({ kind: 'require', line: next.line, note: '参数既不是字符串字面量,也不是同文件内绑定到字面量的标识符,静态无法定值' })
				continue
			}
			// require.resolve('x')
			if (next && next.type === 'punct' && next.value === '.' && tokens[i + 2]?.value === 'resolve'
				&& tokens[i + 3]?.value === '(' && isStr(tokens[i + 4])) {
				found.push({ specifier: tokens[i + 4].value, kind: 'require.resolve', line: tokens[i + 4].line })
			}
		}
	}
	return { specifiers: found, dynamicNonLiteral: dynamic }
}

/**
 * 一个说明符的导入形态是不是**加载期**依赖(失败即整个模块加载不了)。
 *
 * 这是宿主集成安全阀的判据,口径 **fail-closed**:只有 `import()` 动态导入表达式
 * 算「可选形态」,其余一律算加载期依赖。
 *
 * 为什么这么严:
 *   · ESM 的 `import … from 'x'` / `import 'x'` / `export … from 'x'` 由语言语义保证
 *     在模块求值**之前**解析,失败就是加载期崩溃 —— 整个插件连同它注册的所有工具
 *     一起消失(AgOS 有过 webServer 硬依赖拖垮 21 个工具的教训)。这类**永远**不能
 *     被「宿主集成」这层分类豁免,否则分类就成了藏包的手段。
 *   · `require()` / `require.resolve()` 是否致命取决于它在不在函数体里、有没有被
 *     try 包住 —— 词法层判不准。判不准就按最坏情况算(load-bearing),
 *     宁可误报也不漏报。真要作为宿主集成,把它改成 `await import()`。
 */
export function isLoadBearingKind(kind) {
	return !String(kind).startsWith('dynamic-import')
}

// ---------------------------------------------------------------------------
// 导出名扫描(用于核验宿主集成清单声称的降级实现真的存在)
// ---------------------------------------------------------------------------

/**
 * 扫一个文件对外导出了哪些名字。
 * 覆盖 ESM 的 export function/class/const/let/var、export { A, B as C }、
 * export default,以及 CJS 的 exports.NAME = / module.exports.NAME =。
 * `export * from 'x'` 无法在不跟随目标的情况下定名,单独记在 starReexports 里如实披露。
 */
export function exportedNames(src) {
	const tokens = tokenize(src)
	const names = new Set()
	const starReexports = []
	for (let i = 0; i < tokens.length; i += 1) {
		const t = tokens[i]
		if (t.type === 'name' && t.value === 'export') {
			const a = tokens[i + 1]
			if (!a) continue
			if (a.type === 'name' && a.value === 'default') { names.add('default'); continue }
			if (a.type === 'punct' && a.value === '*') {
				starReexports.push({ line: a.line })
				continue
			}
			// export { A, B as C }
			if (a.type === 'punct' && a.value === '{') {
				let j = i + 2
				let last = null
				while (j < tokens.length && !(tokens[j].type === 'punct' && tokens[j].value === '}')) {
					const tj = tokens[j]
					if (tj.type === 'name' && tj.value === 'as') {
						// 下一个名字才是对外名
						const alias = tokens[j + 1]
						if (alias?.type === 'name') { names.delete(last); names.add(alias.value); last = alias.value }
						j += 2
						continue
					}
					if (tj.type === 'name') { names.add(tj.value); last = tj.value }
					j += 1
				}
				continue
			}
			// export [async] function NAME / export function* NAME / export class NAME
			let k = i + 1
			if (tokens[k]?.type === 'name' && tokens[k].value === 'async') k += 1
			if (tokens[k]?.type === 'name' && (tokens[k].value === 'function' || tokens[k].value === 'class')) {
				let m = k + 1
				if (tokens[m]?.type === 'punct' && tokens[m].value === '*') m += 1
				if (tokens[m]?.type === 'name') names.add(tokens[m].value)
				continue
			}
			// export const/let/var NAME
			if (tokens[k]?.type === 'name' && ['const', 'let', 'var'].includes(tokens[k].value)) {
				if (tokens[k + 1]?.type === 'name') names.add(tokens[k + 1].value)
				continue
			}
		}
		// CJS: exports.NAME = / module.exports.NAME =
		if (t.type === 'name' && (t.value === 'exports' || t.value === 'module')) {
			let base = i
			if (t.value === 'module' && tokens[i + 1]?.value === '.' && tokens[i + 2]?.value === 'exports') base = i + 2
			else if (t.value !== 'exports') continue
			if (tokens[base + 1]?.value === '.' && tokens[base + 2]?.type === 'name' && tokens[base + 3]?.value === '=') {
				names.add(tokens[base + 2].value)
			}
		}
	}
	return { names, starReexports }
}

// ---------------------------------------------------------------------------
// 解析
// ---------------------------------------------------------------------------

const isFile = (p) => { try { return statSync(p).isFile() } catch { return false } }
const isDir = (p) => { try { return statSync(p).isDirectory() } catch { return false } }

function readJson(p) {
	try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return null }
}

/** 把一个不带扩展名/指向目录的路径落到具体文件上(照 Node 的 CJS 宽松口径试)。 */
export function probeFile(base) {
	if (isFile(base)) return base
	for (const ext of FILE_EXTS) if (isFile(base + ext)) return base + ext
	if (isDir(base)) {
		const pj = join(base, 'package.json')
		if (isFile(pj)) {
			const j = readJson(pj)
			const main = typeof j?.main === 'string' ? j.main : null
			if (main) {
				const hit = probeFile(resolve(base, main))
				if (hit) return hit
			}
		}
		for (const f of INDEX_FILES) if (isFile(join(base, f))) return join(base, f)
	}
	return null
}

/** 裸说明符 → 包名 + 子路径。@scope/name 算两段。 */
export function splitBare(spec) {
	const parts = spec.split('/')
	if (spec.startsWith('@')) return { pkg: parts.slice(0, 2).join('/'), subpath: parts.slice(2).join('/') }
	return { pkg: parts[0], subpath: parts.slice(1).join('/') }
}

/**
 * Node 对裸说明符的真实解析:从 startDir 逐级向上找 node_modules/<pkg>/package.json。
 * 这里刻意**不**用 import.meta.resolve —— 那会受当前进程的解析缓存与 NODE_PATH 影响;
 * 逐级向上找目录是可复现的、与「装到哪一层」直接对应的口径。
 */
export function resolveBareFrom(startDir, pkg, stopAt = null) {
	let dir = resolve(startDir)
	for (;;) {
		const pkgDir = join(dir, 'node_modules', pkg)
		const manifest = join(pkgDir, 'package.json')
		if (isFile(manifest)) {
			const j = readJson(manifest)
			let viaSymlink = false
			try { viaSymlink = lstatSync(join(dir, 'node_modules')).isSymbolicLink() } catch {}
			return { found: true, dir: pkgDir, version: j?.version ?? null, viaSymlink }
		}
		if (stopAt && dir === resolve(stopAt)) break
		const up = dirname(dir)
		if (up === dir) break
		dir = up
	}
	return { found: false, dir: null, version: null, viaSymlink: false }
}

/** 找包含某文件的最近 package.json(用于自引用与 #imports)。 */
function enclosingPackage(file, stopAt) {
	let dir = dirname(resolve(file))
	for (;;) {
		const pj = join(dir, 'package.json')
		if (isFile(pj)) return { dir, manifest: pj, json: readJson(pj) }
		if (stopAt && dir === resolve(stopAt)) return null
		const up = dirname(dir)
		if (up === dir) return null
		dir = up
	}
}

/** 递归收集 exports/imports 映射里的字符串叶子。 */
function stringLeaves(node, out = []) {
	if (typeof node === 'string') { out.push(node); return out }
	if (Array.isArray(node)) { for (const v of node) stringLeaves(v, out); return out }
	if (node && typeof node === 'object') { for (const v of Object.values(node)) stringLeaves(v, out); return out }
	return out
}

/**
 * 列出一个包的入口文件。
 * kind:'runtime' 来自 package.json(main/exports/bin)与 lib/index.js;
 * kind:'test'    来自 test/*.mjs —— 验收真正跑的就是这些,它们的导入同样必须能解析。
 */
export function entryPointsOf(pkgDir, { includeTests = true } = {}) {
	const roots = []
	const push = (abs, kind, why) => {
		if (!abs) return
		const hit = probeFile(abs)
		if (hit && !roots.some((r) => r.file === hit)) roots.push({ file: hit, kind, why })
	}
	const j = readJson(join(pkgDir, 'package.json'))
	if (j) {
		if (typeof j.main === 'string') push(resolve(pkgDir, j.main), 'runtime', 'package.json main')
		for (const leaf of stringLeaves(j.exports)) if (leaf.startsWith('.')) push(resolve(pkgDir, leaf), 'runtime', 'package.json exports')
		if (typeof j.bin === 'string') push(resolve(pkgDir, j.bin), 'runtime', 'package.json bin')
		else for (const leaf of stringLeaves(j.bin)) push(resolve(pkgDir, leaf), 'runtime', 'package.json bin')
	}
	push(join(pkgDir, 'lib', 'index.js'), 'runtime', 'lib/index.js 约定')
	if (includeTests) {
		const testDir = join(pkgDir, 'test')
		if (isDir(testDir)) {
			for (const f of readdirSync(testDir).sort()) {
				if (f.endsWith('.mjs') || f.endsWith('.js') || f.endsWith('.cjs')) push(join(testDir, f), 'test', 'test/*.mjs(验收实际执行的套件)')
			}
		}
	}
	return roots
}

/**
 * 从若干入口出发遍历导入图。
 *
 * @param {object} o
 * @param {{file:string,kind:string,why?:string}[]} o.roots 入口文件
 * @param {string} o.repoRoot 相对路径展示用
 * @param {string} [o.boundary] 只递归这个目录内的文件(默认 repoRoot);出界的相对导入记为 out-of-tree
 * @returns 完整图 + 裸说明符汇总
 */
export function walkImportGraph({ roots, repoRoot, boundary = null }) {
	const bound = resolve(boundary ?? repoRoot)
	const visited = new Map()          // abs file -> { rel, kind, specifiers }
	const bare = new Map()             // 'pkg' -> { pkg, specifiers:Set, importers:[{file,line,spec,kind}] }
	const unresolvedRelative = []
	const dynamicNonLiteral = []
	const unparseable = []
	const outOfTree = []
	const queue = []

	const rel = (p) => relative(repoRoot, p) || '.'

	for (const r of roots) queue.push({ file: resolve(r.file), kind: r.kind, from: null })

	while (queue.length > 0) {
		const item = queue.shift()
		const file = item.file
		if (visited.has(file)) continue

		const ext = file.slice(file.lastIndexOf('.'))
		if (!PARSEABLE.has(ext)) { visited.set(file, { rel: rel(file), kind: item.kind, parsed: false, specifiers: [] }); continue }

		let src
		try { src = readFileSync(file, 'utf8') } catch (err) {
			unparseable.push({ file: rel(file), error: String(err.message ?? err) })
			visited.set(file, { rel: rel(file), kind: item.kind, parsed: false, specifiers: [] })
			continue
		}

		let extracted
		try { extracted = extractSpecifiers(src) } catch (err) {
			unparseable.push({ file: rel(file), error: `词法扫描失败: ${String(err.message ?? err)}` })
			visited.set(file, { rel: rel(file), kind: item.kind, parsed: false, specifiers: [] })
			continue
		}
		visited.set(file, { rel: rel(file), kind: item.kind, parsed: true, specifiers: extracted.specifiers })
		for (const d of extracted.dynamicNonLiteral) dynamicNonLiteral.push({ file: rel(file), ...d })

		for (const s of extracted.specifiers) {
			const spec = s.specifier
			if (spec === '') continue
			if (spec.startsWith('node:') || BUILTINS.has(spec)) continue

			// 包内 #imports
			if (spec.startsWith('#')) {
				const enc = enclosingPackage(file, bound)
				const leaves = enc?.json?.imports ? stringLeaves(enc.json.imports[spec] ?? enc.json.imports) : []
				let hit = null
				for (const leaf of leaves) {
					if (!leaf.startsWith('.')) continue
					hit = probeFile(resolve(enc.dir, leaf))
					if (hit) break
				}
				if (hit) queue.push({ file: hit, kind: item.kind, from: file })
				else unresolvedRelative.push({ from: rel(file), specifier: spec, line: s.line, kind: s.kind, note: 'package.json imports 里解析不到' })
				continue
			}

			if (spec.startsWith('.') || isAbsolute(spec)) {
				const base = isAbsolute(spec) ? spec : resolve(dirname(file), spec)
				const hit = probeFile(base)
				if (!hit) {
					// 相对路径**穿进 node_modules** 的导入(如 ../../node_modules/@x/y/lib/z.js)
					// 实质上就是对包 @x/y 的依赖,只是绕过了裸解析。归到该包名下,
					// 否则「装了包才解析得到」的事实会被记成一条无主的相对路径失败。
					const viaNm = /(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(spec.split(sep).join('/'))
					if (viaNm) {
						const pkg = viaNm[1]
						const entry = bare.get(pkg) ?? { pkg, specifiers: new Set(), importers: [] }
						entry.specifiers.add(spec)
						entry.importers.push({ file: rel(file), line: s.line, specifier: spec, subpath: '', kind: `${s.kind} (相对路径穿入 node_modules)`, rootKind: item.kind, fromDir: dirname(file) })
						bare.set(pkg, entry)
						continue
					}
					unresolvedRelative.push({ from: rel(file), specifier: spec, line: s.line, kind: s.kind })
					continue
				}
				// node_modules 内部不再递归:裸说明符是叶子,包内部由 npm 负责。
				if (hit.split(sep).includes('node_modules')) continue
				if (!hit.startsWith(bound + sep) && hit !== bound) { outOfTree.push({ from: rel(file), specifier: spec, resolvedTo: hit }); continue }
				queue.push({ file: hit, kind: item.kind, from: file })
				continue
			}

			// 裸说明符
			const { pkg, subpath } = splitBare(spec)
			const entry = bare.get(pkg) ?? { pkg, specifiers: new Set(), importers: [] }
			entry.specifiers.add(spec)
			entry.importers.push({ file: rel(file), line: s.line, specifier: spec, subpath, kind: s.kind, rootKind: item.kind, fromDir: dirname(file) })
			bare.set(pkg, entry)
		}
	}

	return {
		files: [...visited.entries()].map(([abs, v]) => ({ abs, ...v })),
		bare: [...bare.values()].map((b) => ({ ...b, specifiers: [...b.specifiers].sort() })).sort((a, b) => (a.pkg < b.pkg ? -1 : 1)),
		unresolvedRelative,
		dynamicNonLiteral,
		unparseable,
		outOfTree,
	}
}

/**
 * 对图里每个裸包判「能不能解析」。
 * 从**每一个导入它的文件所在目录**分别解析 —— 因为分层安装(plugins/ 层 vs
 * plugins/<name>/ 私有层)下,同一个包对不同消费者的可解析性是不一样的。
 */
export function checkBareResolvable(graph, { repoRoot, selfNames = new Map() } = {}) {
	const rows = []
	for (const b of graph.bare) {
		const perImporter = []
		for (const imp of b.importers) {
			// 包自引用:Node 允许包用自己的名字导入自己(前提是有 exports 字段)
			const selfDir = selfNames.get(b.pkg)
			if (selfDir && resolve(imp.fromDir).startsWith(resolve(selfDir))) {
				perImporter.push({ ...imp, found: true, self: true, at: relative(repoRoot, selfDir), version: null })
				continue
			}
			const r = resolveBareFrom(imp.fromDir, b.pkg)
			perImporter.push({
				...imp,
				fromDir: relative(repoRoot, imp.fromDir),
				found: r.found,
				at: r.found ? relative(repoRoot, r.dir) : null,
				version: r.version,
				viaSymlink: r.viaSymlink,
			})
		}
		const missingFor = perImporter.filter((p) => !p.found)
		rows.push({
			package: b.pkg,
			specifiers: b.specifiers,
			importerCount: b.importers.length,
			resolvable: missingFor.length === 0,
			missingFor: missingFor.map((m) => ({ file: m.file, line: m.line, specifier: m.specifier, kind: m.kind, rootKind: m.rootKind })),
			perImporter,
		})
	}
	return rows.sort((a, b) => (a.package < b.package ? -1 : 1))
}
