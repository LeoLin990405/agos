#!/usr/bin/env node
// A2:可复现的隔离依赖树 —— 核验 + (必要时)自带安装。
//
// 判据以**实测**为准:A1 的 dependency-surface.json 说哪些裸包真被套件需要,
// 就只核验那些;能不能解析,按 Node 对裸规格的真实算法(从 import 所在目录逐级向上找
// node_modules/<pkg>/package.json)判定,而不是看谁的 package.json 写了什么。
//
// 硬安全不变量(违反即退出 2,绝不"尽力而为"):
//   1. 安装根不得落在 ~/.dsh 下          —— 用户的活 profile 只能当只读输入
//   2. 绝不**穿过软链**安装(node_modules 是软链 → 拒)
//   3. 绝不覆盖已存在的 <target>/node_modules —— 并发的其他实现者可能正在装
//   4. --copy-from 只读复制,必须显式给路径;绝不默认、绝不软链、绝不把源目录当安装目标
//   5. 缺依赖 → 指名道姓的诊断 + 非零退出,绝不静默跳过、绝不假装通过
//
// 用法:
//   node scripts/acceptance/prepare-host-modules.mjs --check            # 只核验,不写任何东西
//   node scripts/acceptance/prepare-host-modules.mjs                    # 不就绪才装(装到 scripts/acceptance/host-deps/)
//   node scripts/acceptance/prepare-host-modules.mjs --link             # 装完把 <target>/node_modules 软链到仓内安装根
//   node scripts/acceptance/prepare-host-modules.mjs --offline          # 不联网:要么已就绪,要么给 --copy-from
//   node scripts/acceptance/prepare-host-modules.mjs --copy-from=<dir>  # 显式操作员动作:从既有 node_modules 树只读复制
//   node scripts/acceptance/prepare-host-modules.mjs --strict-pins      # 版本与声明不一致也算不就绪
import { existsSync, lstatSync, mkdirSync, writeFileSync, readFileSync, readlinkSync, symlinkSync, cpSync } from 'node:fs'
import { join, relative, resolve, dirname } from 'node:path'
import { homedir } from 'node:os'
import { REPO_ROOT, runCommand, isInside } from './lib/exec.mjs'

const HERE = dirname(new URL(import.meta.url).pathname)
const DSH_HOME = join(homedir(), '.dsh')
// --layers / --surface 是可测性接缝:让自检能注入合成清单去验证安全不变量与诊断路径。
const rawArgs = process.argv.slice(2)
const argOf = (n, d) => { const h = rawArgs.find((a) => a.startsWith(`--${n}=`)); return h ? h.slice(n.length + 3) : d }
const LAYERS = JSON.parse(readFileSync(resolve(argOf('layers', join(HERE, 'host-deps', 'layers.json'))), 'utf8'))
const SURFACE = resolve(argOf('surface', join(HERE, 'dependency-surface.json')))

const args = process.argv.slice(2)
const flag = (n) => args.includes(`--${n}`)
const opt = (n, d) => { const h = args.find((a) => a.startsWith(`--${n}=`)); return h ? h.slice(n.length + 3) : d }
const checkOnly = flag('check')
const doLink = flag('link')
const offline = flag('offline')
const strictPins = flag('strict-pins')
const copyFrom = opt('copy-from', null)
const registry = opt('registry', null)
const prefix = resolve(opt('prefix', join(REPO_ROOT, 'scripts/acceptance/host-deps')))
const jsonOut = opt('json', null)

const report = {
	schema: 'agos-acceptance/host-modules-report@1',
	generatedAt: new Date().toISOString(),
	prefix: relative(REPO_ROOT, prefix),
	mode: copyFrom ? 'explicit-operator-copy' : offline ? 'offline' : checkOnly ? 'check-only' : 'registry-install',
	strictPins,
	measuredFrom: null,
	required: [],
	pinConformance: [],
	installs: [],
	diagnostics: [],
	ready: false,
}
const note = (level, message) => { report.diagnostics.push({ level, message }); (level === 'error' ? console.error : console.log)(`${level === 'error' ? '❌' : level === 'warn' ? '⚠️ ' : '  '} ${message}`) }
function flush() { if (jsonOut) { mkdirSync(dirname(resolve(jsonOut)), { recursive: true }); writeFileSync(resolve(jsonOut), JSON.stringify(report, null, 2) + '\n') } }
const die = (code, msg) => { note('error', msg); flush(); process.exit(code) }

// ---- 不变量 1 ----
if (isInside(prefix, DSH_HOME)) die(2, `拒绝:安装根 ${prefix} 落在 ${DSH_HOME} 下。用户的活 DSH profile 只能当只读输入,绝不能当安装目标。`)
if (copyFrom && isInside(resolve(copyFrom), prefix)) die(2, `拒绝:--copy-from=${copyFrom} 落在安装根内,会自我复制。`)

/** 不变量 2 */
function assertNotSymlink(p, what) {
	let st = null
	try { st = lstatSync(p) } catch { return }
	if (st.isSymbolicLink()) die(2, `拒绝:${what} ${p} 是软链(→ ${readlinkSync(p)})。绝不穿过软链安装依赖。移除该软链或换 --prefix。`)
}

/** Node 对裸规格的真实解析:从 startDir 逐级向上找 node_modules/<pkg>。 */
function resolveBare(startDir, pkg) {
	let dir = resolve(startDir)
	for (;;) {
		const cand = join(dir, 'node_modules', pkg, 'package.json')
		if (existsSync(cand)) {
			let version = null
			try { version = JSON.parse(readFileSync(cand, 'utf8')).version } catch {}
			return { found: true, at: relative(REPO_ROOT, join(dir, 'node_modules', pkg)), version, viaSymlink: isSymlinkedNm(join(dir, 'node_modules')) }
		}
		const up = dirname(dir)
		if (up === dir) return { found: false, at: null, version: null, viaSymlink: false }
		dir = up
	}
}
function isSymlinkedNm(p) { try { return lstatSync(p).isSymbolicLink() ? readlinkSync(p) : false } catch { return false } }

/** 各插件自己 package.json 声明的版本 = 权威期望值。 */
function declaredPins() {
	const pins = {}
	for (const p of ['dsh-agos', 'dsh-agos-router', 'dsh-mcp-bridge', 'cn-capabilities', 'dsh-fleet']) {
		const f = join(REPO_ROOT, 'plugins', p, 'package.json')
		if (!existsSync(f)) continue
		let j
		try { j = JSON.parse(readFileSync(f, 'utf8')) } catch { continue }
		for (const [k, v] of Object.entries(j.dependencies ?? {})) (pins[k] ??= []).push({ declaredBy: `plugins/${p}`, version: v })
	}
	return pins
}

// ---- 需求集:实测优先,没有实测结果就退回 layers.json 的静态清单 ----
let required = []
if (existsSync(SURFACE)) {
	const surface = JSON.parse(readFileSync(SURFACE, 'utf8'))
	report.measuredFrom = { file: 'scripts/acceptance/dependency-surface.json', generatedAt: surface.generatedAt, gitHead: surface.gitHead }
	for (const [pkg, suiteIds] of Object.entries(surface.summary?.externalToSuites ?? {})) {
		const consumers = [...new Set(suiteIds.map((id) => `plugins/${id.split('/')[0]}`))]
		required.push({ package: pkg, consumers, suiteCount: suiteIds.length, source: 'measured' })
	}
	// 实测出的 host-path 依赖(绝对路径进 ~/.dsh)不是包问题,单独报。
	report.hostPathSuites = surface.summary?.suitesRequiringHostPaths ?? []
} else {
	note('warn', 'dependency-surface.json 不存在 —— 先跑 measure-dependency-surface.mjs。暂用 layers.json 的静态清单。')
	for (const l of LAYERS.layers) for (const pkg of Object.keys(l.packages)) required.push({ package: pkg, consumers: [l.target], suiteCount: null, source: 'layers.json-fallback' })
}

console.log('== A2 隔离宿主依赖树 ==')
console.log(`   模式: ${report.mode}   安装根: ${report.prefix}   钉住的宿主: ${LAYERS.pinnedHarness}`)
console.log(`   需求集来源: ${report.measuredFrom ? `实测 (${report.measuredFrom.file})` : 'layers.json 静态清单'}`)
console.log('')

const pins = declaredPins()
function evaluate() {
	report.required = []
	report.pinConformance = []
	for (const r of required) {
		const perConsumer = r.consumers.map((c) => {
			// import 语句住在 plugins/<name>/lib 里,解析就从那儿起步。
			const from = join(REPO_ROOT, c, 'lib')
			return { consumer: c, ...resolveBare(existsSync(from) ? from : join(REPO_ROOT, c), r.package) }
		})
		const resolvable = perConsumer.every((c) => c.found)
		report.required.push({ ...r, resolvable, perConsumer })
		const declared = pins[r.package] ?? []
		// 去重:同一个 (包, 声明者, 声明值, 解析值) 只报一行,不按消费者重复刷屏。
		for (const d of declared) {
			const resolvedVersions = [...new Set(perConsumer.filter((c) => c.found).map((c) => c.version))]
			for (const rv of resolvedVersions) {
				if (d.version !== rv) report.pinConformance.push({ package: r.package, declaredBy: d.declaredBy, declared: d.version, resolved: rv })
			}
		}
	}
	return report.required.every((r) => r.resolvable)
}

let resolvableAll = evaluate()

// ---- 不就绪 → 装(除非 --check) ----
if (!resolvableAll && !checkOnly) {
	for (const layer of LAYERS.layers) {
		const needed = Object.keys(layer.packages).filter((p) => report.required.some((r) => r.package === p && !r.resolvable))
		if (needed.length === 0) continue
		const layerRoot = join(prefix, layer.id)
		const layerNm = join(layerRoot, 'node_modules')
		assertNotSymlink(layerRoot, '层安装根')
		assertNotSymlink(layerNm, '层 node_modules')
		mkdirSync(layerRoot, { recursive: true })
		const deps = Object.fromEntries(needed.map((p) => [p, layer.packages[p]]))
		writeFileSync(join(layerRoot, 'package.json'), JSON.stringify({
			name: `agos-acceptance-host-deps-${layer.id}`, version: '0.0.0', private: true,
			description: `A2 隔离宿主依赖层 ${layer.id}`, dependencies: deps,
		}, null, 2) + '\n')
		const act = { layer: layer.id, target: layer.target, root: relative(REPO_ROOT, layerRoot), packages: deps }

		if (copyFrom) {
			const src = resolve(copyFrom)
			if (!existsSync(src)) die(3, `--copy-from=${src} 不存在。请给一个真实的 node_modules 目录。`)
			if (!lstatSync(src).isDirectory()) die(3, `--copy-from=${src} 不是目录。`)
			console.log('')
			console.log('╔════════════════════════════════════════════════════════════════════════════════╗')
			console.log('║ 显式操作员动作:从既有依赖树**只读复制**(非默认行为、非软链、不写回源目录)   ║')
			console.log('╚════════════════════════════════════════════════════════════════════════════════╝')
			console.log(`   来源: ${src}`)
			if (isInside(src, DSH_HOME)) console.log('   ⚠️  该路径在用户的活 DSH profile 内 —— 只读取,绝不写入、绝不软链到它')
			console.log(`   去向: ${relative(REPO_ROOT, layerNm)}`)
			mkdirSync(layerNm, { recursive: true })
			const copied = []
			for (const p of needed) {
				const from = join(src, p)
				if (!existsSync(from)) { note('warn', `--copy-from 源缺 ${p};下面的核验会把它报成失败,不会当成跳过`); continue }
				const to = join(layerNm, p)
				mkdirSync(dirname(to), { recursive: true })
				cpSync(from, to, { recursive: true, dereference: true })
				copied.push(p)
				console.log(`   复制 ${p}`)
			}
			act.action = `explicit-operator-copy from ${src}`
			act.copied = copied
		} else if (offline) {
			act.action = 'offline: no install attempted'
			note('warn', `--offline 且层 ${layer.id} 不就绪。缺:${needed.join(', ')}。给 --copy-from=<node_modules 目录> 或去掉 --offline。`)
		} else {
			const argv = ['npm', 'install', '--no-audit', '--no-fund', '--omit=dev']
			if (registry) argv.push(`--registry=${registry}`)
			const logPath = join(prefix, `${layer.id}-install.log`)
			console.log(`▸ 层 ${layer.id}:npm install ${needed.join(' ')} → ${relative(REPO_ROOT, layerRoot)}`)
			const r = runCommand({ argv, cwd: layerRoot, logPath, timeoutMs: 900000 })
			act.action = 'npm install'
			act.argv = argv
			act.exitCode = r.exitCode
			act.durationSeconds = r.durationSeconds
			act.log = relative(REPO_ROOT, logPath)
			if (r.exitCode !== 0) {
				note('error', `层 ${layer.id} npm install 退出 ${r.exitCode}${/ERESOLVE/.test(r.output) ? ' —— 依赖树冲突 ERESOLVE。绝不用 --force / --legacy-peer-deps 掩盖。' : ''};日志 ${act.log}`)
			}
		}

		// 不变量 3 + --link
		const targetNm = join(REPO_ROOT, layer.target, 'node_modules')
		if (doLink) {
			let exists = true
			try { lstatSync(targetNm) } catch { exists = false }
			if (exists) {
				note('warn', `--link 跳过:${layer.target}/node_modules 已存在(可能是并发的其他实现者装的),不覆盖`)
				act.link = 'skipped: target already exists'
			} else if (existsSync(layerNm)) {
				const rel = relative(join(REPO_ROOT, layer.target), layerNm)
				const dest = resolve(join(REPO_ROOT, layer.target), rel)
				if (isInside(dest, DSH_HOME)) die(2, '内部错误:软链目标竟落在 ~/.dsh,已中止')
				symlinkSync(rel, targetNm)
				note('info', `🔗 ${layer.target}/node_modules → ${rel}(指向本脚本的隔离安装根;已断言不在 ~/.dsh 下)`)
				act.link = rel
			}
		}
		report.installs.push(act)
	}
	resolvableAll = evaluate()
}

// ---- 结果 ----
console.log('')
console.log('-- 实测需求的解析结果 --')
for (const r of report.required) {
	for (const c of r.perConsumer) {
		console.log(`   ${r.resolvable ? '✅' : '❌'} ${r.package}  从 ${c.consumer}/lib 解析 → ${c.found ? `${c.at} @ ${c.version}${c.viaSymlink ? `  [经软链 ${c.viaSymlink}]` : ''}` : '解析不到'}`)
	}
}
if (report.hostPathSuites?.length) {
	console.log('')
	console.log('-- 不是包依赖,而是写死的绝对路径依赖(装包解决不了) --')
	for (const s of report.hostPathSuites) console.log(`   ⚠️  ${s}`)
}
if (report.pinConformance.length) {
	console.log('')
	console.log('-- 版本与插件自己 package.json 声明不一致 --')
	for (const m of report.pinConformance) console.log(`   ⚠️  ${m.package}: ${m.declaredBy} 声明 ${m.declared},实际解析到 ${m.resolved}`)
}

const pinsOk = !strictPins || report.pinConformance.length === 0
report.ready = resolvableAll && pinsOk
console.log('')
if (report.ready) {
	console.log('✅ 依赖面就绪:实测需要的裸包全部可解析' + (report.pinConformance.length ? `(有 ${report.pinConformance.length} 处版本声明不一致,已记录,未用 --strict-pins 阻断)` : ''))
} else if (!resolvableAll) {
	const missing = report.required.filter((r) => !r.resolvable)
	console.error('❌ 依赖面**未**就绪。缺的是具体这些包,不是"环境问题":')
	for (const r of missing) {
		console.error(`     ${r.package}   —— ${r.suiteCount ?? '?'} 个套件需要,消费者:${r.consumers.join(', ')}`)
	}
	console.error('   操作员可选(按可复现性排序):')
	console.error('     1) 联网从注册表装钉版:node scripts/acceptance/prepare-host-modules.mjs')
	console.error('     2) 换注册表:                --registry=https://registry.npmjs.org')
	console.error('     3) 离线、显式从既有依赖树只读复制(必须自己给路径,没有默认值):')
	console.error('        node scripts/acceptance/prepare-host-modules.mjs --offline --copy-from=<某个 node_modules 目录>')
	console.error(`        例:--copy-from=$HOME/.dsh/profiles/node_modules   ← 用户的活 profile,只读复制,绝不写入/软链`)
	console.error('   在此之前,依赖这些包的套件会被验收器报成 missing-host-modules 失败,不会被算作跳过或通过。')
} else {
	console.error(`❌ --strict-pins:有 ${report.pinConformance.length} 处版本与声明不一致(见上)。`)
}
flush()
process.exit(report.ready ? 0 : 1)
