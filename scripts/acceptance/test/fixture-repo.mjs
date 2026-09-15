// 合成插件仓夹具(只在 mkdtemp 里造,跑完删)。
//
// 为什么要合成仓:真仓的依赖状态正被其他实现者并发改动(装包、改锁文件、拆依赖),
// 拿真仓当断言基准的测试会随机变红,而那种红是噪音不是信号。
// 合成仓让"缺哪个包、被谁导入、导入链多深"完全可控,断言才有意义。
//
// prepare-host-modules.mjs 的 --repo-root 接缝就是为此存在的。

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { HOST_INTEGRATIONS_SCHEMA } from '../lib/host-integrations.mjs'

const made = []
process.on('exit', () => {
	for (const d of made) { try { rmSync(d, { recursive: true, force: true }) } catch {} }
})

function put(root, rel, content) {
	const p = join(root, rel)
	mkdirSync(dirname(p), { recursive: true })
	writeFileSync(p, content)
	return p
}

/**
 * 造一个插件仓:plugins/<name>/{package.json,lib/…,test/…}。
 *
 * @param {string} label mkdtemp 前缀
 * @param {object} spec  { plugins: { name: { files: {rel:content}, pkg?:object } }, installed?: {pkgName: version} }
 */
export function makeFixtureRepo(label, spec) {
	const root = mkdtempSync(join(tmpdir(), `agos-fx-${label}-`))
	made.push(root)
	for (const [name, def] of Object.entries(spec.plugins ?? {})) {
		const dir = join('plugins', name)
		put(root, join(dir, 'package.json'), JSON.stringify({
			name,
			version: '0.0.0',
			private: true,
			type: 'module',
			main: 'lib/index.js',
			...(def.pkg ?? {}),
		}, null, 2) + '\n')
		for (const [rel, content] of Object.entries(def.files ?? {})) put(root, join(dir, rel), content)
	}
	// 预装包:写进 plugins/node_modules/<pkg>/package.json,让裸解析真的能命中。
	for (const [pkg, version] of Object.entries(spec.installed ?? {})) {
		put(root, join('plugins', 'node_modules', pkg, 'package.json'),
			JSON.stringify({ name: pkg, version, main: 'index.js' }, null, 2) + '\n')
		put(root, join('plugins', 'node_modules', pkg, 'index.js'), 'export default {}\n')
	}
	// 插件私有层预装(复刻真实宿主的两层 node_modules 分隔)
	for (const [target, pkgs] of Object.entries(spec.installedIn ?? {})) {
		for (const [pkg, version] of Object.entries(pkgs)) {
			put(root, join(target, 'node_modules', pkg, 'package.json'),
				JSON.stringify({ name: pkg, version, main: 'index.js' }, null, 2) + '\n')
			put(root, join(target, 'node_modules', pkg, 'index.js'), 'export default {}\n')
		}
	}
	// 宿主集成清单。给 string 就原样写(用来造 JSON 语法错),给对象就序列化。
	//
	// 默认写一份 integrations 为空数组的清单:合成仓本来就没有宿主集成,而清单**缺失**
	// 是 fail-closed 退出 2(缺失 ≠ 没有集成,只等于无法判定)。默认不写会让所有
	// 「越过守卫、真要跑图」的用例都停在退出 2 上,断言到的就不是它们各自要测的东西。
	// 要专门测「清单缺失」这条负例,显式传 hostIntegrations: null。
	if (spec.hostIntegrations !== null) {
		const doc = spec.hostIntegrations ?? { schema: HOST_INTEGRATIONS_SCHEMA, integrations: [] }
		put(root, join('scripts', 'acceptance', 'host-integrations.json'),
			typeof doc === 'string' ? doc : JSON.stringify(doc, null, 2) + '\n')
	}
	if (spec.lock) put(root, join('plugins', 'package-lock.json'), JSON.stringify(spec.lock, null, 2) + '\n')
	if (spec.manifest) put(root, join('plugins', 'package.json'), JSON.stringify(spec.manifest, null, 2) + '\n')
	return root
}

/** 合成 layers.json;packages 决定"哪些缺包能被自动安装覆盖"。 */
export function makeLayers(root, packages, { id = 'plugins', target = 'plugins' } = {}) {
	const p = join(root, 'layers.json')
	writeFileSync(p, JSON.stringify({
		schema: 'agos-acceptance/host-dep-layers@1',
		pinnedHarness: 'test-fixture',
		layers: [{ id, target, servesSuites: 'fixture', packages, why: 'fixture' }],
	}, null, 2) + '\n')
	return p
}
