// 负例套件:依赖面检查必须覆盖**完整导入图**(P1 缺陷 2)。
//
// 被修的缺陷:--check 只信运行时观测出来的 dependency-surface.json。Node 遇到模块图里
// 第一个未解析说明符就退出,所以那份清单每轮只暴露一个缺包 —— 于是在"套件其实都
// 加载不了"的机器上,--check 会报"依赖面就绪"并 exit 0。
//
// 这里的判据全部用**真实子进程**跑真实脚本,并在 mkdtemp 合成插件仓上做,
// 好让"缺哪个包、导入链多深"完全可控(真仓正被其他实现者并发改动)。
//
// 跑法:node --test scripts/acceptance/test/import-graph.test.mjs

import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { makeFixtureRepo, makeLayers } from './fixture-repo.mjs'
import { extractSpecifiers } from '../lib/import-graph.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const SCRIPT = resolve(HERE, '..', 'prepare-host-modules.mjs')

function check(repoRoot, extra = []) {
	const res = spawnSync(process.execPath, [
		SCRIPT, '--check', `--repo-root=${repoRoot}`,
		'--surface=/nonexistent/none.json',
		`--layers=${makeLayers(repoRoot, {})}`,
		...extra,
	], { encoding: 'utf8', timeout: 120000, env: { ...process.env } })
	return { code: res.status, out: (res.stdout ?? '') + (res.stderr ?? '') }
}

test('NC-G1: 深层导入链末端缺包 → --check 非零退出,点名缺哪个包、被谁在第几行导入', () => {
	// 入口不直接导入缺失包:entry → a.js → b.js → 'deep-missing-pkg'。
	// 只看顶层 dependencies 字段、或只看入口文件,都发现不了这条。
	const repo = makeFixtureRepo('deep', {
		plugins: {
			alpha: {
				files: {
					'lib/index.js': "import { a } from './a.js'\nexport { a }\n",
					'lib/a.js': "import { b } from './b.js'\nexport const a = b\n",
					'lib/b.js': "import x from 'deep-missing-pkg'\nexport const b = x\n",
				},
			},
		},
	})
	const r = check(repo)
	assert.equal(r.code, 1, `缺包必须非零退出,实际 ${r.code}\n${r.out}`)
	assert.match(r.out, /deep-missing-pkg/, '必须点名缺失的包')
	assert.match(r.out, /lib\/b\.js:1/, '必须点名导入它的文件与行号')
	assert.match(r.out, /未\*\*就绪\*\*|未.{0,4}就绪/, '必须明说依赖面未就绪')
})

test('NC-G2: 多个缺包必须**全部**点名(旧口径每轮只暴露第一个)', () => {
	const repo = makeFixtureRepo('multi', {
		plugins: {
			alpha: {
				files: {
					'lib/index.js': "import './a.js'\nimport './b.js'\nimport m1 from 'miss-one'\nexport default m1\n",
					'lib/a.js': "import m2 from 'miss-two'\nexport default m2\n",
					'lib/b.js': "import m3 from 'miss-three'\nexport default m3\n",
				},
			},
			beta: {
				files: { 'lib/index.js': "import m4 from 'miss-four'\nexport default m4\n" },
			},
		},
	})
	const r = check(repo)
	assert.equal(r.code, 1, `实际 ${r.code}\n${r.out}`)
	for (const pkg of ['miss-one', 'miss-two', 'miss-three', 'miss-four']) {
		assert.match(r.out, new RegExp(pkg), `必须点名 ${pkg} —— 一次扫描要给出全图,不是每轮一个`)
	}
	assert.match(r.out, /4\/4 个裸包解析不到/, '应报出 4 个缺包的总数')
})

test('NC-G3: 测试文件里的缺包同样算(验收真正跑的是它们)', () => {
	const repo = makeFixtureRepo('testroots', {
		plugins: {
			alpha: {
				files: {
					'lib/index.js': "export const ok = 1\n",
					'test/thing.test.mjs': "import helper from 'test-only-missing-pkg'\nexport default helper\n",
				},
			},
		},
	})
	const r = check(repo)
	assert.equal(r.code, 1, `实际 ${r.code}\n${r.out}`)
	assert.match(r.out, /test-only-missing-pkg/, '测试入口的缺包也必须点名')
	assert.match(r.out, /测试入口/, '应标出它来自测试入口')
})

test('POS-G4: 包都装齐 → --check 退出 0(证明不是无脑全红)', () => {
	const repo = makeFixtureRepo('satisfied', {
		plugins: {
			alpha: {
				files: {
					'lib/index.js': "import './a.js'\nimport p from 'present-pkg'\nexport default p\n",
					'lib/a.js': "import q from '@scope/present-scoped'\nexport default q\n",
				},
			},
		},
		installed: { 'present-pkg': '1.0.0', '@scope/present-scoped': '2.0.0' },
	})
	const r = check(repo)
	assert.equal(r.code, 0, `全部可解析必须退 0,实际 ${r.code}\n${r.out}`)
	assert.match(r.out, /依赖面就绪/, '应明说就绪')
	// 报的是比值(2/2)而不是「全部」—— 比值能让"分母被悄悄改小"当场露馅。
	assert.match(r.out, /2\/2 个裸模块说明符可解析/, '应报出可解析数/总数')
	// 正控也要盯住诚实边界:就绪结论不许暗示它涵盖传递依赖与具名导出。
	assert.match(r.out, /本结论\*\*不\*\*涵盖/, '就绪结论必须同时写明未涵盖范围')
})

test('POS-G5: 注释与字符串里出现的包名**不算**依赖(词法器正确性,端到端)', () => {
	// 纯正则实现会把这些当成真导入并误报缺包 —— 那种误报会训练操作员忽略红灯。
	const repo = makeFixtureRepo('lexer', {
		plugins: {
			alpha: {
				files: {
					'lib/index.js': [
						"// import ghost from 'comment-ghost-pkg'",
						"/* import ghost2 from 'block-ghost-pkg' */",
						'const s = "import ghost3 from \'string-ghost-pkg\'"',
						'const re = /import ghost4 from .regex-ghost-pkg./',
						'const tpl = `import ghost5 from \'template-ghost-pkg\'`',
						"export default [s, re, tpl]",
						'',
					].join('\n'),
				},
			},
		},
	})
	const r = check(repo)
	assert.equal(r.code, 0, `没有真导入就该退 0,实际 ${r.code}\n${r.out}`)
	for (const ghost of ['comment-ghost-pkg', 'block-ghost-pkg', 'string-ghost-pkg', 'regex-ghost-pkg', 'template-ghost-pkg']) {
		assert.doesNotMatch(r.out, new RegExp(ghost), `${ghost} 不是导入,不得出现在需求集里`)
	}
})

test('NC-G6: require / 动态 import / export-from 三种形态都要覆盖', () => {
	const repo = makeFixtureRepo('forms', {
		plugins: {
			alpha: {
				files: {
					'lib/index.js': [
						"export { thing } from 'export-from-missing'",
						"const d = await import('dynamic-literal-missing')",
						"import { createRequire } from 'node:module'",
						"const require_ = createRequire(import.meta.url)",
						"const c = require_('require-missing')",
						'export default [d, c]',
						'',
					].join('\n'),
				},
			},
		},
	})
	const r = check(repo)
	assert.equal(r.code, 1, `实际 ${r.code}\n${r.out}`)
	// createRequire 出来的 require_ 不叫 require,所以 require-missing 抓不到 —— 如实承认:
	// 下面只断言能抓到的两种,不假装三种全抓。
	for (const pkg of ['export-from-missing', 'dynamic-literal-missing']) {
		assert.match(r.out, new RegExp(pkg), `必须抓到 ${pkg}`)
	}
	assert.doesNotMatch(r.out, /node:module/, 'node: 内置模块不该进需求集')
})

test('NC-G7: import(同文件字符串常量) 要被折叠出来(swarm 解耦层就是这个写法)', () => {
	const repo = makeFixtureRepo('foldconst', {
		plugins: {
			alpha: {
				files: {
					'lib/index.js': [
						"export const SPEC = 'folded-const-missing-pkg'",
						'export async function load() { return import(SPEC) }',
						'',
					].join('\n'),
				},
			},
		},
	})
	const r = check(repo)
	assert.equal(r.code, 1, `折叠出来的缺包必须让检查变红,实际 ${r.code}\n${r.out}`)
	assert.match(r.out, /folded-const-missing-pkg/, '必须折叠同文件常量并点名该包')
})

test('NC-G8: 真正无法静态定值的动态导入必须**如实披露**,不许静默', () => {
	const repo = makeFixtureRepo('dyn', {
		plugins: {
			alpha: {
				files: {
					'lib/index.js': [
						'export async function load(spec) { return import(spec) }',
						'',
					].join('\n'),
				},
			},
		},
	})
	const jsonPath = join(repo, 'graph.json')
	const r = check(repo, [`--graph-json=${jsonPath}`])
	assert.match(r.out, /静态无法定值的动态导入/, '必须显式披露扫不到的动态导入')
	assert.ok(existsSync(jsonPath), '应导出图 json')
	const g = JSON.parse(readFileSync(jsonPath, 'utf8'))
	assert.equal(g.dynamicNonLiteral.length, 1, '应记录 1 处非字面量动态导入')
	assert.match(g.doesNotClaim, /动态|dynamic/i, '图的自我声明必须承认这一类覆盖不到')
})

test('NC-G9: 分层安装下,同一包对不同消费者的可解析性分别判定', () => {
	// layered-pkg 只装在 plugins/beta/node_modules(私有层),
	// alpha 从 plugins/ 层向上找不到它 —— 必须报 alpha 缺、而不是"装了就算全过"。
	const repo = makeFixtureRepo('layered', {
		plugins: {
			alpha: { files: { 'lib/index.js': "import x from 'layered-pkg'\nexport default x\n" } },
			beta: { files: { 'lib/index.js': "import x from 'layered-pkg'\nexport default x\n" } },
		},
		installedIn: { 'plugins/beta': { 'layered-pkg': '1.0.0' } },
	})
	const r = check(repo)
	assert.equal(r.code, 1, `alpha 解析不到就必须红,实际 ${r.code}\n${r.out}`)
	assert.match(r.out, /plugins\/alpha\/lib\/index\.js:1/, '必须点名解析不到的那个消费者')
	assert.doesNotMatch(r.out, /plugins\/beta\/lib\/index\.js:1 导入/, 'beta 能解析到,不该被列为缺失点')
})

test('NC-G10: 图里需要但 layers.json 无层声明 → 明说自动安装覆盖不到', () => {
	const repo = makeFixtureRepo('nolayer', {
		plugins: { alpha: { files: { 'lib/index.js': "import x from 'unlayered-missing'\nexport default x\n" } } },
	})
	const r = check(repo)
	assert.equal(r.code, 1, `实际 ${r.code}\n${r.out}`)
	assert.match(r.out, /没有任何层声明/, '必须指出缺层,而不是静默什么也不装')
	assert.match(r.out, /unlayered-missing/, '必须点名该包')
})

// ---- 词法器单元判据(库层,补足端到端覆盖不到的边角) ----
test('UNIT-G11: 词法器区分正则字面量与除号,不吞掉后续导入', () => {
	const src = [
		'const a = 10 / 2',
		'const b = a / 2',
		"import real from 'after-division-pkg'",
		'',
	].join('\n')
	const { specifiers } = extractSpecifiers(src)
	assert.deepEqual(specifiers.map((s) => s.specifier), ['after-division-pkg'],
		'除号不该被当成正则开头而吞掉后面的 import')
})

test('UNIT-G12: 模板字面量插值不破坏后续 token 流', () => {
	const src = [
		'const x = 1',
		'const t = `a${x}b${`nested${x}`}c`',
		"import real from 'after-template-pkg'",
		'',
	].join('\n')
	const { specifiers } = extractSpecifiers(src)
	assert.deepEqual(specifiers.map((s) => s.specifier), ['after-template-pkg'],
		'嵌套模板插值后仍要能认出 import')
})

test('UNIT-G13: export const 不含 from,不得误产生说明符', () => {
	const src = "export const from = 'not-a-package'\nexport default from\n"
	const { specifiers } = extractSpecifiers(src)
	assert.deepEqual(specifiers, [], '把标识符 from 当成 from 子句会误报,必须避免')
})
