/**
 * 缺陷 4 的负例套件:「宿主环境集成」这层分类不能变成藏包的手段。
 *
 * 每条都跑**真子进程** prepare-host-modules.mjs --check,断言退出码 + 输出,
 * 而不是 import 内部函数自说自话 —— 要证的正是「命令行行为是否被放宽了」。
 *
 * 全部在 mkdtemp 合成仓上跑(--repo-root 接缝),精确控制「缺哪个包、导入形态是什么、
 * 清单写成什么样」。真仓的依赖状态正被并发改动,拿它当基准的断言会随机变红。
 *
 * 判据分四组,对应主控提的四条:
 *   A. 清单外缺失 → 照旧非零(证明默认行为没被放宽)
 *   B. 清单内 + 动态形态 + 缺失 → 0,且报告里有专节
 *   C. 清单内 + **加载期**形态 + 缺失 → 非零(安全阀)
 *   D. 清单缺失/坏 JSON/缺必填字段 → fail-closed 硬失败,不当成空清单
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import assert from 'node:assert/strict'
import test from 'node:test'

import { makeFixtureRepo, makeLayers } from './fixture-repo.mjs'
import { exportedNames, isLoadBearingKind } from '../lib/import-graph.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const SCRIPT = resolve(HERE, '..', 'prepare-host-modules.mjs')
const SPEC = 'fixture-host-thing'

/** 跑 --check,返回 { code, out }。out 合并 stdout/stderr —— 断言要看的错误信息在 stderr。 */
function check(root, extra = []) {
	const layers = makeLayers(root, {})
	try {
		const out = execFileSync(process.execPath, [
			SCRIPT, '--check', `--repo-root=${root}`, `--layers=${layers}`,
			`--surface=${join(root, 'no-surface.json')}`, ...extra,
		], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
		return { code: 0, out }
	} catch (err) {
		return { code: err.status ?? -1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` }
	}
}

/** 一份合格的降级实现:文件存在、真导出声明的那个名字。 */
const DEGRADATION_SRC = `
export async function resolveThing() {
	try { return { available: true, module: await import('${SPEC}') } }
	catch (e) { return { available: false, module: null, reason: String(e && e.message) } }
}
`

function manifest(overrides = {}) {
	return {
		schema: 'agos-acceptance/host-integrations@1',
		integrations: [{
			specifier: SPEC,
			why: '夹具:registry 版本不导出所需符号,真实宿主上是同级插件。',
			degradation: { file: 'plugins/app/lib/degrade.mjs', export: 'resolveThing' },
			...overrides,
		}],
	}
}

/**
 * 合成仓:app 插件 + 一个降级实现 + 可控的消费形态。
 *
 * hostIntegrations 用 `in` 判断而不是默认参数:默认参数会把显式传入的"不写清单"
 * 语义悄悄替换成合格清单,那条负例就测了个寂寞。
 * 传 `null` = 不写清单文件(fixture-repo 的约定),正是 fail-closed 负例要的状态。
 */
function repo(label, opts) {
	const { consumerSrc, installed = {}, extraFiles = {} } = opts
	const hostIntegrations = 'hostIntegrations' in opts ? opts.hostIntegrations : manifest()
	return makeFixtureRepo(label, {
		plugins: {
			app: {
				files: {
					'lib/index.js': consumerSrc,
					'lib/degrade.mjs': DEGRADATION_SRC,
					...extraFiles,
				},
			},
		},
		installed,
		hostIntegrations,
	})
}

// ---------------------------------------------------------------------------
// A. 分类没有放宽默认行为
// ---------------------------------------------------------------------------

test('NEG-HI-A1: 清单外的包缺失 → 照旧非零退出(分类不改变默认行为)', () => {
	const root = repo('a1', { consumerSrc: `import x from 'totally-unlisted-pkg'\nexport default x\n` })
	const r = check(root)
	assert.equal(r.code, 1, '清单外的缺包必须照旧阻断')
	assert.match(r.out, /totally-unlisted-pkg/)
	assert.match(r.out, /依赖面\*\*未\*\*就绪/)
})

test('NEG-HI-A2: 清单内放行的同时,清单外的缺包仍然阻断(混合场景不能被一条豁免带偏)', () => {
	const root = repo('a2', {
		consumerSrc: `
const s = '${SPEC}'
export const load = async () => import(s)
import missing from 'another-unlisted-pkg'
export default missing
`,
	})
	const r = check(root)
	assert.equal(r.code, 1)
	assert.match(r.out, /another-unlisted-pkg/, '清单外的包必须被点名')
	// 且错误清单里不能把宿主集成也算成缺包
	const errBlock = r.out.slice(r.out.indexOf('依赖面**未**就绪'))
	assert.ok(!errBlock.includes(SPEC), '宿主集成不该出现在「缺的是具体这些包」列表里')
})

// ---------------------------------------------------------------------------
// B. 动态形态 → 缺席属预期
// ---------------------------------------------------------------------------

test('POS-HI-B1: 清单内 + 动态 import + 缺失 → exit 0,且报告里有专节', () => {
	const root = repo('b1', { consumerSrc: `export const load = async () => import('${SPEC}')\n` })
	const r = check(root)
	assert.equal(r.code, 0, `动态形态的宿主集成缺席应放行,实际:\n${r.out}`)
	assert.match(r.out, /-- 宿主环境集成\(清单:/, '必须有专门一节')
	assert.match(r.out, new RegExp(`${SPEC}: 未解析到 —— \\*\\*属预期\\*\\*`))
	assert.match(r.out, /缺席时降级到: plugins\/app\/lib\/degrade\.mjs 的 resolveThing\(\)/)
	assert.match(r.out, /已核验该文件确实导出此名/)
})

test('POS-HI-B2: 图里完全观测不到的宿主集成(说明符藏在变量后)→ 放行但如实说「图无法佐证」', () => {
	// 复刻真仓的形态:import(spec) 的参数是函数形参,词法层定不了值。
	const root = repo('b2', {
		consumerSrc: `
const importer = (s) => import(s)
export const load = () => importer(process.env.THING_MODULE ?? 'fallback-thing')
`,
	})
	const r = check(root)
	assert.equal(r.code, 0)
	assert.match(r.out, /未观测到任何导入/, '图没看见就必须明说没看见')
	assert.match(r.out, /图无法佐证/, '不能让读者误以为图确认了它是动态形态')
})

test('POS-HI-B3: 清单内的包**解析得到** → 报告显示 resolved,不是「预期缺席」', () => {
	const root = repo('b3', {
		consumerSrc: `export const load = async () => import('${SPEC}')\n`,
		installed: { [SPEC]: '9.9.9' },
	})
	const r = check(root)
	assert.equal(r.code, 0)
	assert.match(r.out, new RegExp(`✅ ${SPEC}: 解析到`))
	assert.match(r.out, /9\.9\.9/)
})

test('POS-HI-B4: 空清单是合法的,且不影响普通缺包判定', () => {
	const root = repo('b4', {
		consumerSrc: `import x from 'some-missing-pkg'\nexport default x\n`,
		hostIntegrations: { schema: 'agos-acceptance/host-integrations@1', integrations: [] },
	})
	const r = check(root)
	assert.equal(r.code, 1)
	assert.match(r.out, /清单为空:没有声明任何宿主环境集成/)
	assert.match(r.out, /some-missing-pkg/)
})

// ---------------------------------------------------------------------------
// C. 安全阀:加载期导入形态照旧非零
// ---------------------------------------------------------------------------

for (const [id, name, src] of [
	['NEG-HI-C1', '静态具名 import', `import { a } from '${SPEC}'\nexport default a\n`],
	['NEG-HI-C2', '静态默认 import', `import a from '${SPEC}'\nexport default a\n`],
	['NEG-HI-C3', '副作用 import', `import '${SPEC}'\nexport default 1\n`],
	['NEG-HI-C4', 'export … from 转导出', `export { a } from '${SPEC}'\n`],
	['NEG-HI-C5', '顶层 require', `const a = require('${SPEC}')\nmodule.exports = a\n`],
	['NEG-HI-C6', '折叠常量的顶层 require', `const S = '${SPEC}'\nconst a = require(S)\nmodule.exports = a\n`],
]) {
	test(`${id}: 安全阀 —— 清单内但源码是「${name}」且缺失 → 非零退出`, () => {
		const root = repo(id.toLowerCase(), { consumerSrc: src })
		const r = check(root)
		assert.equal(r.code, 1, `安全阀必须触发,实际 exit=${r.code}:\n${r.out}`)
		assert.match(r.out, /宿主集成声明不成立/)
		assert.match(r.out, /安全阀触发/)
		assert.match(r.out, /加载期导入/)
		assert.match(r.out, /整个插件加载不了/)
	})
}

test('POS-HI-C7: 加载期形态但包**装上了** → 不触发安全阀(阀针对的是「缺席还硬依赖」)', () => {
	const root = repo('c7', {
		consumerSrc: `import a from '${SPEC}'\nexport default a\n`,
		installed: { [SPEC]: '1.0.0' },
	})
	const r = check(root)
	assert.equal(r.code, 0, `包在就不该报,实际:\n${r.out}`)
})

test('NEG-HI-C8: 动态导入放行,但同一个包另有一处静态 import → 仍然非零', () => {
	// 关键场景:消费方大部分改成了动态,漏了一处静态。漏的那处照样是加载期崩溃。
	const root = repo('c8', {
		consumerSrc: `export const load = async () => import('${SPEC}')\n`,
		extraFiles: { 'lib/legacy.js': `import { old } from '${SPEC}'\nexport default old\n` },
	})
	// 让 legacy.js 进图
	const idx = join(root, 'plugins', 'app', 'lib', 'index.js')
	writeFileSync(idx, `import './legacy.js'\n` + readFileSync(idx, 'utf8'))
	const r = check(root)
	assert.equal(r.code, 1, `漏掉的那处静态 import 必须被抓到:\n${r.out}`)
	assert.match(r.out, /legacy\.js/)
})

// ---------------------------------------------------------------------------
// C'. 声明本身要能被核验(降级实现不能是空话)
// ---------------------------------------------------------------------------

test('NEG-HI-D1: 声明的降级实现文件不存在 → 声明作废,非零退出', () => {
	const root = repo('d1', {
		consumerSrc: `export const load = async () => import('${SPEC}')\n`,
		hostIntegrations: manifest({ degradation: { file: 'plugins/app/lib/nope.mjs', export: 'resolveThing' } }),
	})
	const r = check(root)
	assert.equal(r.code, 1)
	assert.match(r.out, /降级实现文件不存在/)
})

test('NEG-HI-D2: 降级实现存在但**不导出**声明的那个名字 → 非零退出', () => {
	const root = repo('d2', {
		consumerSrc: `export const load = async () => import('${SPEC}')\n`,
		hostIntegrations: manifest({ degradation: { file: 'plugins/app/lib/degrade.mjs', export: 'noSuchExport' } }),
	})
	const r = check(root)
	assert.equal(r.code, 1)
	assert.match(r.out, /并不导出 noSuchExport/)
})

test('NEG-HI-D3: 声明的消费点不存在 → 非零退出(清单不能引用已删掉的文件)', () => {
	const root = repo('d3', {
		consumerSrc: `export const load = async () => import('${SPEC}')\n`,
		hostIntegrations: manifest({ consumers: ['plugins/app/lib/ghost.js'] }),
	})
	const r = check(root)
	assert.equal(r.code, 1)
	assert.match(r.out, /声明的消费点不存在/)
})

// ---------------------------------------------------------------------------
// D. fail-closed:清单本身有问题时绝不静默当成空清单
// ---------------------------------------------------------------------------

const S1 = 'agos-acceptance/host-integrations@1'
const FAILCLOSED = [
	['NEG-HI-E1', '清单文件缺失', null, /宿主集成清单不存在/],
	['NEG-HI-E2', 'JSON 语法错', '{ "schema": "agos-acceptance/host-integrations@1", integrations: [ }', /JSON 解析失败/],
	['NEG-HI-E3', '顶层是数组', '[]', /顶层必须是对象/],
	['NEG-HI-E4', 'schema 不认识', { schema: 'something-else@9', integrations: [] }, /schema 不认识/],
	['NEG-HI-E5', '缺 integrations 数组', { schema: S1 }, /缺 integrations 数组/],
	['NEG-HI-E6', '条目缺 why', { schema: S1, integrations: [{ specifier: SPEC, degradation: { file: 'a', export: 'b' } }] }, /缺必填字段 why/],
	['NEG-HI-E7', '条目缺 degradation.export', { schema: S1, integrations: [{ specifier: SPEC, why: 'x', degradation: { file: 'a' } }] }, /缺必填字段 degradation\.export/],
	['NEG-HI-E8', '条目 why 是空串', { schema: S1, integrations: [{ specifier: SPEC, why: '   ', degradation: { file: 'a', export: 'b' } }] }, /缺必填字段 why/],
	['NEG-HI-E9', '说明符重复', { schema: S1, integrations: [
		{ specifier: SPEC, why: 'x', degradation: { file: 'a', export: 'b' } },
		{ specifier: SPEC, why: 'y', degradation: { file: 'a', export: 'b' } },
	] }, /说明符重复/],
	['NEG-HI-E10', 'consumers 不是字符串数组', { schema: S1, integrations: [{ specifier: SPEC, why: 'x', degradation: { file: 'a', export: 'b' }, consumers: [3] }] }, /consumers 必须是非空字符串数组/],
]

for (const [id, name, content, pattern] of FAILCLOSED) {
	test(`${id}: fail-closed —— ${name} → exit 2,明确报错,不当成空清单`, () => {
		const root = repo(id.toLowerCase(), {
			// 故意让仓里**没有**任何缺包:这样"静默当成空清单"会得到 exit 0,
			// 与"fail-closed"的 exit 2 区分得干干净净。测的就是这个差别。
			consumerSrc: `export default 1\n`,
			hostIntegrations: content,
		})
		const r = check(root)
		assert.equal(r.code, 2, `清单有问题必须硬失败(exit 2),实际 exit=${r.code}:\n${r.out}`)
		assert.match(r.out, /fail-closed/)
		assert.match(r.out, pattern)
	})
}

test('NEG-HI-E11: 清单坏掉时,不会因为「恰好没有缺包」而报就绪', () => {
	const root = repo('e11', { consumerSrc: `export default 1\n`, hostIntegrations: '{ bad json' })
	const r = check(root)
	assert.notEqual(r.code, 0)
	assert.ok(!r.out.includes('✅ 依赖面就绪'), '清单不可判定时绝不能报就绪')
})

// ---------------------------------------------------------------------------
// 单元:形态分类与导出名扫描(安全阀的两块判据本身)
// ---------------------------------------------------------------------------

test('UNIT-HI-1: isLoadBearingKind:只有 dynamic-import 算可选形态,其余 fail-closed', () => {
	for (const k of ['import-from', 'side-effect-import', 'export-from', 'require', 'require.resolve']) {
		assert.equal(isLoadBearingKind(k), true, `${k} 必须算加载期`)
	}
	assert.equal(isLoadBearingKind('dynamic-import'), false)
	assert.equal(isLoadBearingKind('dynamic-import (折叠常量 S)'), false)
	// 没见过的形态一律按最坏情况算
	assert.equal(isLoadBearingKind('some-future-kind'), true)
})

test('UNIT-HI-2: exportedNames 覆盖 ESM/CJS 各形态,且不被注释与字符串骗到', () => {
	const { names } = exportedNames(`
// export function commentedOut() {}
const s = "export const inString = 1"
export function a() {}
export async function b() {}
export function* c() {}
export class D {}
export const e = 1
export let f = 2
export { g, h as i }
export default 3
exports.j = 1
module.exports.k = 2
`)
	for (const n of ['a', 'b', 'c', 'D', 'e', 'f', 'g', 'i', 'default', 'j', 'k']) {
		assert.ok(names.has(n), `应识别导出 ${n},实际:${[...names].join(',')}`)
	}
	assert.ok(!names.has('commentedOut'), '注释里的不算')
	assert.ok(!names.has('inString'), '字符串里的不算')
	assert.ok(!names.has('h'), 'h as i 的对外名是 i,不是 h')
})

test('UNIT-HI-3: 仓里那份真清单本身合法,且指的降级实现真的存在并导出该名', (t) => {
	const repoRoot = resolve(HERE, '..', '..', '..')
	// 削弱反证的突变副本只拷 scripts/,没有 plugins/ —— 那种环境下本条不适用。
	// 不 skip 的话它会在每条突变里都变红,把「这条突变到底抓到了什么」淹掉。
	if (!existsSync(join(repoRoot, 'plugins'))) return t.skip('非完整工作树(突变副本),本条不适用')
	const file = join(repoRoot, 'scripts/acceptance/host-integrations.json')
	assert.ok(existsSync(file), '真清单必须在版本控制里')
	const doc = JSON.parse(readFileSync(file, 'utf8'))
	assert.equal(doc.schema, 'agos-acceptance/host-integrations@1')
	assert.ok(doc.integrations.length > 0)
	for (const e of doc.integrations) {
		const deg = join(repoRoot, e.degradation.file)
		assert.ok(existsSync(deg), `降级实现不存在:${e.degradation.file}`)
		assert.ok(exportedNames(readFileSync(deg, 'utf8')).names.has(e.degradation.export),
			`${e.degradation.file} 不导出 ${e.degradation.export}`)
		for (const c of e.consumers ?? []) assert.ok(existsSync(join(repoRoot, c)), `消费点不存在:${c}`)
	}
})
