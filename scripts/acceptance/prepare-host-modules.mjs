#!/usr/bin/env node
// A2:可复现的隔离依赖树 —— 核验 + (必要时)自带安装。
//
// 需求集以**静态导入图**为准(R3 修复):从每个插件的入口文件出发,递归跟随相对导入,
// 把途中所有裸模块说明符挖出来,逐个判能否解析。任何一个解析不到 → 指名道姓 + 非零退出。
// 能不能解析,按 Node 对裸规格的真实算法(从 import 所在目录逐级向上找
// node_modules/<pkg>/package.json)判定,而不是看谁的 package.json 写了什么。
//
// 为什么换掉旧口径:旧版只信 A1 的 dependency-surface.json,而那份清单是**运行时观测**
// 的 —— 跑 node --test 看它报哪个包找不到。Node 只报模块图里遇到的**第一个**未解析说明符
// 就退出,于是 dsh-fleet 只留下 schemastery 一条,而它在模块层还需要另外几个包
// (HANDOFF.md:176 已记为未修)。结果 --check 会在「套件其实都加载不了」的机器上报
// 「依赖面就绪」exit 0。静态全图扫描一次拿到全部说明符,不需要「跑一次修一个」的迭代。
// 白名单/黑名单一律不写死:swarm 之类的依赖是从源码扫出来的,上游拆除后本检查自动跟上。
//
// 硬安全不变量(违反即退出 2,绝不"尽力而为"):
//   1. 安装根的**真实路径**(realpath,解析全部祖先软链)必须落在允许的写入根内,
//      且不得落在 ~/.dsh 下、不得含受保护路径段、真实祖先必须属当前 uid。
//      ⚠️ 旧版只做 path.resolve() 的**词法**前缀检查,看不见祖先软链 —— 实测可沿
//      --prefix=<沙箱>/via/host-deps(via 是指向活 profile 的软链)穿透写入。见 lib/safe-write-root.mjs。
//   2. 绝不**穿过软链**安装(层根 / node_modules / package.json 是软链 → 拒)
//   3. 绝不覆盖已存在的 <target>/node_modules —— 并发的其他实现者可能正在装
//   4. --copy-from 只读复制,必须显式给路径;绝不默认、绝不软链、绝不把源目录当安装目标
//   5. 缺依赖 → 指名道姓的诊断 + 非零退出,绝不静默跳过、绝不假装通过
//
// ⚠️ 不变量 1 是 check-then-write,有 TOCTOU 残留窗口:检查通过到 npm 真正落盘之间,
//    祖先仍可被换成软链。本脚本做到「检查的对象 == 创建的对象」(mkdir 后按 dev+ino 与
//    realpath 复核),抓不到「创建之后、npm 写入期间」的替换。不声称完备。
//
// 用法:
//   node scripts/acceptance/prepare-host-modules.mjs --check            # 只核验,不写任何东西
//   node scripts/acceptance/prepare-host-modules.mjs                    # 不就绪才装(装到 scripts/acceptance/host-deps/)
//   node scripts/acceptance/prepare-host-modules.mjs --link             # 装完把 <target>/node_modules 软链到仓内安装根
//   node scripts/acceptance/prepare-host-modules.mjs --offline          # 不联网:要么已就绪,要么给 --copy-from
//   node scripts/acceptance/prepare-host-modules.mjs --copy-from=<dir>  # 显式操作员动作:从既有 node_modules 树只读复制
//   node scripts/acceptance/prepare-host-modules.mjs --strict-pins      # 版本与声明不一致也算不就绪
//   node scripts/acceptance/prepare-host-modules.mjs --strict-graph     # 未解析的相对导入也算不就绪
//   node scripts/acceptance/prepare-host-modules.mjs --graph-json=<f>   # 导出完整导入图(取证用)
//   node scripts/acceptance/prepare-host-modules.mjs --allow-write-root=<dir>  # 收窄允许写入根(可重复;给了就**替换**默认值)
import { existsSync, lstatSync, mkdirSync, writeFileSync, readFileSync, readdirSync, readlinkSync, symlinkSync, cpSync } from 'node:fs'
import { join, relative, resolve, dirname } from 'node:path'
import { homedir } from 'node:os'
import { REPO_ROOT, runCommand, isInside } from './lib/exec.mjs'
import { entryPointsOf, walkImportGraph, checkBareResolvable } from './lib/import-graph.mjs'
import { loadHostIntegrations, evaluateHostIntegrations, ManifestError } from './lib/host-integrations.mjs'
import {
	inspectWriteTarget, defaultAllowedRoots, defaultForbiddenRoots,
	assertSameObject, writeFileNoFollow,
} from './lib/safe-write-root.mjs'

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
const strictGraph = flag('strict-graph')
const copyFrom = opt('copy-from', null)
const registry = opt('registry', null)
const prefix = resolve(opt('prefix', join(REPO_ROOT, 'scripts/acceptance/host-deps')))
const jsonOut = opt('json', null)
const graphJsonOut = opt('graph-json', null)
// --allow-write-root 可重复;**给了就替换默认值**(仓根 + 系统临时目录),
// 这样自检能把允许范围收窄成一个具体沙箱,去证明「真实路径越界 → 拒」这条本身成立,
// 而不是靠 .dsh 这个名字侥幸命中。
const allowRootArgs = args.filter((a) => a.startsWith('--allow-write-root=')).map((a) => resolve(a.slice('--allow-write-root='.length)))
const ALLOWED_WRITE_ROOTS = allowRootArgs.length > 0 ? allowRootArgs : defaultAllowedRoots(REPO_ROOT)
// --repo-root 是可测性接缝(与已有的 --layers / --surface 同性质):
// 让自检能对 mkdtemp 里的合成插件树跑完整导入图扫描,精确控制"缺哪个包",
// 而不必污染真实仓库、也不必真的装包。默认就是本仓根。
const SCAN_ROOT = resolve(opt('repo-root', REPO_ROOT))
// 宿主环境集成清单。默认取仓里那份;--host-integrations= 供自检指向合成清单。
// 注意默认值是相对 SCAN_ROOT 解析的 —— 合成夹具可以自带一份自己的清单。
const HOST_INTEGRATIONS_FILE = opt('host-integrations', join(SCAN_ROOT, 'scripts/acceptance/host-integrations.json'))
const PLUGINS = ['dsh-agos', 'dsh-agos-router', 'dsh-mcp-bridge', 'cn-capabilities', 'dsh-fleet']
// 合成夹具的插件名不一定是上面这五个:--repo-root 下就地枚举 plugins/*/package.json。
function pluginDirs() {
	const base = join(SCAN_ROOT, 'plugins')
	if (SCAN_ROOT === REPO_ROOT) return PLUGINS.map((p) => join(base, p)).filter((d) => existsSync(d))
	if (!existsSync(base)) return []
	return readdirSync(base, { withFileTypes: true })
		.filter((e) => e.isDirectory() && existsSync(join(base, e.name, 'package.json')))
		.map((e) => join(base, e.name))
		.sort()
}

const report = {
	schema: 'agos-acceptance/host-modules-report@1',
	generatedAt: new Date().toISOString(),
	prefix: relative(REPO_ROOT, prefix),
	mode: copyFrom ? 'explicit-operator-copy' : offline ? 'offline' : checkOnly ? 'check-only' : 'registry-install',
	strictPins,
	strictGraph,
	measuredFrom: null,
	importGraph: null,
	writeTargetGuard: null,
	required: [],
	pinConformance: [],
	installs: [],
	diagnostics: [],
	ready: false,
}
const note = (level, message) => { report.diagnostics.push({ level, message }); (level === 'error' ? console.error : console.log)(`${level === 'error' ? '❌' : level === 'warn' ? '⚠️ ' : '  '} ${message}`) }
function flush() { if (jsonOut) { mkdirSync(dirname(resolve(jsonOut)), { recursive: true }); writeFileSync(resolve(jsonOut), JSON.stringify(report, null, 2) + '\n') } }
const die = (code, msg) => { note('error', msg); flush(); process.exit(code) }

// ---- 不变量 1:真实路径守卫,**在任何写入之前** ----
//
// 这里是修 P1 的地方。旧版只有下面这条词法检查:
//     if (isInside(prefix, DSH_HOME)) die(2, ...)
// isInside 用 path.resolve 折叠 `.`/`..` 后比字符串前缀,从不读文件系统,因此
// --prefix=<沙箱>/via/host-deps(via 是指向 ~/.dsh/profiles/web/node_modules 的软链)
// 会通过检查,而随后的 mkdirSync/writeFileSync 穿过软链落进活 profile。
// 保留这条词法检查当第一道闸(便宜、能挡最直白的写法),真正的判据是下面的 realpath 检查。
if (isInside(prefix, DSH_HOME)) die(2, `拒绝:安装根 ${prefix} 落在 ${DSH_HOME} 下。用户的活 DSH profile 只能当只读输入,绝不能当安装目标。`)

const guard = inspectWriteTarget({ target: prefix, allowedRoots: ALLOWED_WRITE_ROOTS, forbiddenRoots: defaultForbiddenRoots() })
report.writeTargetGuard = {
	declared: guard.declared,
	realTarget: guard.realTarget,
	realAncestor: guard.realAncestor,
	createdTail: guard.createdTail,
	symlinkTraversal: guard.symlinkTraversal,
	allowedRoots: ALLOWED_WRITE_ROOTS,
	violations: guard.violations,
	disclosures: guard.disclosures,
	// 诚实标注:这道闸在检查通过与 npm 落盘之间存在 TOCTOU 残留窗口。
	toctouCaveat: 'check-then-write:检查通过到 npm 真正写盘之间,祖先目录仍可被换成软链。'
		+ '本脚本仅保证「检查的对象 == mkdir 创建的对象」(dev+ino + realpath 复核),'
		+ '不保证 npm 写入期间路径不被替换。要关掉此窗口需 OS 级沙箱限定可写子路径。',
}
for (const d of guard.disclosures) note('info', d)
if (!guard.ok) {
	// 只要有一条越界就拒,且**在 mkdir/writeFile 之前**。--check 也拒:不变量不因模式打折。
	for (const v of guard.violations.slice(0, -1)) note('error', v)
	die(2, `拒绝:安装根未通过真实路径守卫。${guard.violations[guard.violations.length - 1]}`)
}

if (copyFrom && isInside(resolve(copyFrom), prefix)) die(2, `拒绝:--copy-from=${copyFrom} 落在安装根内,会自我复制。`)

/** 不变量 2 */
function assertNotSymlink(p, what) {
	let st = null
	try { st = lstatSync(p) } catch { return }
	if (st.isSymbolicLink()) die(2, `拒绝:${what} ${p} 是软链(→ ${readlinkSync(p)})。绝不穿过软链安装依赖。移除该软链或换 --prefix。`)
}

// 裸规格的解析改由 lib/import-graph.mjs 的 resolveBareFrom 承担(口径相同:从 import
// 所在目录逐级向上找 node_modules/<pkg>/package.json),这里不再保留第二份实现。

/** 各插件自己 package.json 声明的版本 = 权威期望值。 */
function declaredPins() {
	const pins = {}
	for (const dir of pluginDirs()) {
		const f = join(dir, 'package.json')
		if (!existsSync(f)) continue
		let j
		try { j = JSON.parse(readFileSync(f, 'utf8')) } catch { continue }
		for (const [k, v] of Object.entries(j.dependencies ?? {})) (pins[k] ??= []).push({ declaredBy: relative(SCAN_ROOT, dir), version: v })
	}
	return pins
}

// ---- 需求集:**完整静态导入图**(权威口径) ----
//
// 从每个插件的入口(package.json main/exports/bin、lib/index.js、test/*.mjs)出发,
// 递归跟随相对导入,收集全部裸说明符。这是权威需求集:它一次给出全图,
// 不像运行时观测那样每轮只暴露第一个缺包。
// 刻意不写任何包名白名单/黑名单 —— 上游拆掉某个依赖后,这里自动跟着变。
function scanImportGraph() {
	const roots = []
	const selfNames = new Map()
	const perPlugin = {}
	for (const dir of pluginDirs()) {
		const manifest = join(dir, 'package.json')
		if (existsSync(manifest)) {
			try {
				const j = JSON.parse(readFileSync(manifest, 'utf8'))
				if (j.name) selfNames.set(j.name, dir)
			} catch {}
		}
		const eps = entryPointsOf(dir)
		perPlugin[relative(SCAN_ROOT, dir)] = eps.map((e) => ({ file: relative(SCAN_ROOT, e.file), kind: e.kind, why: e.why }))
		roots.push(...eps)
	}
	const graph = walkImportGraph({ roots, repoRoot: SCAN_ROOT })
	const rows = checkBareResolvable(graph, { repoRoot: SCAN_ROOT, selfNames })
	return { roots, perPlugin, graph, rows, selfNames }
}

const scan = scanImportGraph()
report.importGraph = {
	method: '从插件入口文件出发的静态导入图遍历(自带最小 JS 词法器;注释与字符串里的 import 不计入)',
	claims: '证明「插件源码在模块层需要的每个裸包都能按 Node 解析算法解析到」。',
	doesNotClaim: '不证明已装包**自身**的传递依赖完整(那由 npm/锁文件负责);'
		+ '不证明运行时才决定的 import(变量) 能解析(见 dynamicNonLiteral);'
		+ '不证明包内导出的**符号**存在(如 dsh-kimicode-swarm 的四个具名导出 —— 那由套件与 verify-host-tree 负责)。',
	entryPointsByPlugin: scan.perPlugin,
	entryPointCount: scan.roots.length,
	filesWalked: scan.graph.files.length,
	filesParsed: scan.graph.files.filter((f) => f.parsed).length,
	bareSpecifierCount: scan.graph.bare.length,
	dynamicNonLiteral: scan.graph.dynamicNonLiteral,
	unresolvedRelative: scan.graph.unresolvedRelative,
	unparseable: scan.graph.unparseable,
	outOfTree: scan.graph.outOfTree,
	packages: scan.rows.map((r) => ({ package: r.package, specifiers: r.specifiers, importerCount: r.importerCount, resolvable: r.resolvable, missingFor: r.missingFor })),
}

let required = scan.rows.map((r) => ({
	package: r.package,
	consumers: [...new Set(r.perImporter.map((i) => `plugins/${i.file.split('/')[1]}`))],
	importerCount: r.importerCount,
	specifiers: r.specifiers,
	source: 'import-graph',
	importers: r.perImporter.map((i) => ({ file: i.file, line: i.line, specifier: i.specifier, rootKind: i.rootKind })),
}))

// dependency-surface.json 降级为**参考**:它是运行时观测,只能证伪不能证全。
// 保留它是为了把「静态图扫到但运行时没暴露」的差值显示出来 —— 那个差值就是本次修的缺陷。
if (existsSync(SURFACE)) {
	const surface = JSON.parse(readFileSync(SURFACE, 'utf8'))
	const observed = Object.keys(surface.summary?.externalToSuites ?? {}).sort()
	const staticPkgs = scan.rows.map((r) => r.package).sort()
	report.measuredFrom = {
		file: 'scripts/acceptance/dependency-surface.json',
		generatedAt: surface.generatedAt,
		gitHead: surface.gitHead,
		role: '参考,非判据。运行时观测每轮只暴露模块图里第一个未解析说明符,不能证明完整依赖面。',
		runtimeObservedPackages: observed,
		staticGraphPackages: staticPkgs,
		missedByRuntimeObservation: staticPkgs.filter((p) => !observed.includes(p)),
	}
	report.hostPathSuites = surface.summary?.suitesRequiringHostPaths ?? []
} else {
	note('info', 'dependency-surface.json 不存在 —— 不影响判定:需求集来自静态导入图,不来自那份清单。')
}

console.log('== A2 隔离宿主依赖树 ==')
console.log(`   模式: ${report.mode}   安装根: ${report.prefix}   钉住的宿主: ${LAYERS.pinnedHarness}`)
console.log(`   需求集来源: 完整静态导入图 —— ${scan.roots.length} 个入口 → 走了 ${scan.graph.files.length} 个文件 → ${scan.graph.bare.length} 个裸说明符`)
if (report.measuredFrom?.missedByRuntimeObservation?.length) {
	console.log(`   ⚠️  运行时观测(dependency-surface.json)漏掉了其中 ${report.measuredFrom.missedByRuntimeObservation.length} 个:${report.measuredFrom.missedByRuntimeObservation.join('、')}`)
	console.log('       ↑ 这正是旧口径会在「套件其实都加载不了」的机器上报就绪的原因。')
}
console.log('')

const pins = declaredPins()
// ---- 宿主环境集成清单(fail-closed 加载) ----
//
// 清单声明「这个说明符在干净依赖树里解析不到属预期」。它**不是**放行开关:
// 每条声明都会被独立核验(降级实现存在且真导出那个名字、消费点存在),
// 并且过一道安全阀(源码里是加载期导入形态 → 照旧算缺失)。见 lib/host-integrations.mjs。
//
// 加载失败一律 die(2):清单读不了 ≠ 没有宿主集成,只等于**无法判定**。
// 静默当成空清单会让「清单被误删」表现为「检查更严了」,那是最坏的一种失败模式 ——
// 它看起来像通过。
let hostManifest
try {
	hostManifest = loadHostIntegrations({ file: HOST_INTEGRATIONS_FILE, repoRoot: SCAN_ROOT })
} catch (err) {
	if (err instanceof ManifestError) die(2, `宿主集成清单不可用(fail-closed,不降级成空清单):\n  ${err.message.split('\n').join('\n  ')}`)
	throw err
}

/**
 * 重新判定全图里每个裸包能否解析。
 * 装完之后会再跑一次(所以是函数而不是一次性计算)。
 * 解析起点是**每个导入语句所在的目录**,不是"插件根/lib"这种近似 —— 分层安装下
 * 同一个包对不同消费者的可解析性本来就不同(schemastery 在 plugins/ 层,
 * dsh-agent 在 plugins/dsh-mcp-bridge/ 私有层)。
 */
function evaluate() {
	const rows = checkBareResolvable(scan.graph, { repoRoot: SCAN_ROOT, selfNames: scan.selfNames })
	// 宿主集成核验。注意这里传的是 rows(图的观测结果),但 evaluateHostIntegrations
	// **不依赖**说明符出现在 rows 里 —— 它对每条声明独立探测一次解析结果。
	// 因为消费点完全可以把说明符藏在变量后面(本仓就是:swarm-host-integration.mjs:57
	// 的 import(spec) 参数是函数形参,词法层定不了值),那样它在图里根本不出现。
	// 只做「过滤 graph 结果」的话,这种情况会让它从报告里悄悄消失 ——
	// 检查通过是因为**没看见**,而不是因为**看过且判定为预期缺席**。
	report.hostIntegrations = evaluateHostIntegrations({ manifest: hostManifest, rows, repoRoot: SCAN_ROOT })
	report.hostIntegrationsFile = hostManifest.path
	// 只有 verdict === 'absent-expected' 的才豁免。'violation'(安全阀触发/降级实现核不到)
	// 照旧算缺失;不在清单里的更是原样不变。
	const exempt = new Set(report.hostIntegrations.filter((h) => h.verdict === 'absent-expected').map((h) => h.specifier))
	report.required = rows.map((r) => {
		const meta = required.find((x) => x.package === r.package)
		return {
			package: r.package,
			specifiers: r.specifiers,
			consumers: meta?.consumers ?? [],
			importerCount: r.importerCount,
			source: 'import-graph',
			resolvable: r.resolvable,
			// 缺席但属清单声明的宿主集成、且过了安全阀 —— 不阻断,但**照旧出现在报告里**。
			hostIntegration: exempt.has(r.package),
			missingFor: r.missingFor,
			perConsumer: r.perImporter.map((i) => ({
				consumer: i.file, line: i.line, specifier: i.specifier, rootKind: i.rootKind,
				found: i.found, at: i.at, version: i.version, viaSymlink: i.viaSymlink, self: i.self ?? false,
			})),
		}
	})
	report.importGraph.packages = report.required.map((r) => ({
		package: r.package, specifiers: r.specifiers, importerCount: r.importerCount,
		resolvable: r.resolvable, missingFor: r.missingFor,
	}))
	report.pinConformance = []
	for (const r of report.required) {
		for (const d of pins[r.package] ?? []) {
			const resolvedVersions = [...new Set(r.perConsumer.filter((c) => c.found && c.version).map((c) => c.version))]
			for (const rv of resolvedVersions) {
				if (d.version !== rv) report.pinConformance.push({ package: r.package, declaredBy: d.declaredBy, declared: d.version, resolved: rv })
			}
		}
	}
	// 就绪判定:解析不到 **且** 不是已核验的宿主集成 → 不就绪。
	// 顺序很重要 —— exempt 只包含 verdict==='absent-expected' 的,
	// 安全阀触发(violation)的说明符不在里面,于是照旧阻断。
	return rows.every((r) => r.resolvable || exempt.has(r.package))
}

let resolvableAll = evaluate()

// ---- 图里需要、但没有任何层声明它 → 自动安装覆盖不到,必须明说 ----
//
// 换成完整导入图之后,需求集比 layers.json 的静态清单大(实测:图里 8 个,
// layers.json 只声明 2 个)。差集不能静默丢掉 —— 否则脚本会一边报"不就绪"
// 一边什么也装不了,而操作员看不出是缺层还是装失败。
// 注意:本脚本不改 layers.json(不在本次所有权范围内),只如实报出缺口。
{
	const declaredInLayers = new Set(LAYERS.layers.flatMap((l) => Object.keys(l.packages)))
	// 宿主集成不算「层覆盖不到的缺口」—— 它本来就不该由本脚本装,补层是错误建议。
	const unsatisfiable = report.required.filter((r) => !r.resolvable && !r.hostIntegration && !declaredInLayers.has(r.package))
	report.unsatisfiableByLayers = unsatisfiable.map((r) => ({ package: r.package, importerCount: r.importerCount, consumers: r.consumers }))
	if (unsatisfiable.length > 0) {
		note('warn', `完整导入图需要 ${unsatisfiable.length} 个包,但 ${relative(REPO_ROOT, resolve(argOf('layers', join(HERE, 'host-deps', 'layers.json'))))} 里没有任何层声明它们`
			+ ` —— 本脚本的自动安装覆盖不到,需要操作员补层或上游拆除依赖:${unsatisfiable.map((r) => r.package).join('、')}`)
	}
}

// ---- 不就绪 → 装(除非 --check) ----
if (!resolvableAll && !checkOnly) {
	for (const layer of LAYERS.layers) {
		const needed = Object.keys(layer.packages).filter((p) => report.required.some((r) => r.package === p && !r.resolvable && !r.hostIntegration))
		if (needed.length === 0) continue
		const layerRoot = join(prefix, layer.id)
		const layerNm = join(layerRoot, 'node_modules')
		assertNotSymlink(layerRoot, '层安装根')
		assertNotSymlink(layerNm, '层 node_modules')

		// 不变量 1(逐层复核):层根是 prefix 的子路径,但 prefix 通过检查**不等于**层根也通过 ——
		// prefix 到层根之间的任何一段都可能是软链。所以每一层在 mkdir 之前单独过一遍守卫。
		const layerGuard = inspectWriteTarget({ target: layerRoot, allowedRoots: ALLOWED_WRITE_ROOTS, forbiddenRoots: defaultForbiddenRoots() })
		if (!layerGuard.ok) {
			for (const v of layerGuard.violations.slice(0, -1)) note('error', v)
			die(2, `拒绝:层 ${layer.id} 的安装根未通过真实路径守卫(未写入任何东西)。${layerGuard.violations[layerGuard.violations.length - 1]}`)
		}
		mkdirSync(layerRoot, { recursive: true })
		// 尽力而为的 TOCTOU 收口:确认「刚创建的对象」就是「刚检查过的那个真实路径」。
		// 关不掉 npm 写入期间的替换窗口 —— 这一点在文件头与 report.writeTargetGuard.toctouCaveat 里写明。
		const same = assertSameObject(layerRoot, layerGuard.realTarget)
		if (!same.ok) die(2, `拒绝:层 ${layer.id} 创建后一致性复核失败。${same.reason}`)

		const deps = Object.fromEntries(needed.map((p) => [p, layer.packages[p]]))
		// O_NOFOLLOW:即使目录检查全过,<layerRoot>/package.json 本身也可能是指向别处的软链;
		// 普通 writeFileSync 会顺着它写出去,这里让内核在最后一段是软链时直接报错。
		writeFileNoFollow(join(layerRoot, 'package.json'), JSON.stringify({
			name: `agos-acceptance-host-deps-${layer.id}`, version: '0.0.0', private: true,
			description: `A2 隔离宿主依赖层 ${layer.id}`, dependencies: deps,
		}, null, 2) + '\n')
		const act = {
			layer: layer.id, target: layer.target, root: relative(REPO_ROOT, layerRoot), packages: deps,
			writeGuard: { realTarget: layerGuard.realTarget, symlinkTraversal: layerGuard.symlinkTraversal, identityConfirmed: same.ok },
		}

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
		const targetNm = join(SCAN_ROOT, layer.target, 'node_modules')
		if (doLink) {
			let exists = true
			try { lstatSync(targetNm) } catch { exists = false }
			if (exists) {
				note('warn', `--link 跳过:${layer.target}/node_modules 已存在(可能是并发的其他实现者装的),不覆盖`)
				act.link = 'skipped: target already exists'
			} else if (existsSync(layerNm)) {
				const rel = relative(join(SCAN_ROOT, layer.target), layerNm)
				const dest = resolve(join(SCAN_ROOT, layer.target), rel)
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
console.log(`-- 完整导入图:${report.required.length} 个裸模块说明符的解析结果 --`)
for (const r of report.required) {
	const resolved = r.perConsumer.filter((c) => c.found)
	const missing = r.perConsumer.filter((c) => !c.found)
	const versions = [...new Set(resolved.map((c) => c.version).filter(Boolean))]
	console.log(`   ${r.resolvable ? '✅' : r.hostIntegration ? '➖' : '❌'} ${r.package}${r.specifiers.length > 1 || r.specifiers[0] !== r.package ? `  (说明符: ${r.specifiers.join(', ')})` : ''}`
		+ (r.hostIntegration ? '  [宿主环境集成:缺席属预期,详见下方专节]' : ''))
	console.log(`        被 ${r.importerCount} 处导入${resolved.length ? `;解析到 ${resolved[0].at}${versions.length ? ` @ ${versions.join('/')}` : ''}${resolved[0].viaSymlink ? `  [经软链 ${resolved[0].viaSymlink}]` : ''}` : ''}`)
	// 缺包时**点名谁导入了它**:文件 + 行号,不让操作员再去猜。
	for (const c of missing.slice(0, 6)) {
		console.log(`        ❌ 解析不到 —— ${c.consumer}:${c.line} (${c.rootKind === 'test' ? '测试入口' : '运行时入口'}) 导入 '${c.specifier}'`)
	}
	if (missing.length > 6) console.log(`        …… 另有 ${missing.length - 6} 处导入同样解析不到(完整列表见 --graph-json)`)
}

// ---- 宿主环境集成:**永远**单独一节,不管解析到没有、不管图里有没有观测到 ----
//
// 「从输出里静默消失」是这层分类最危险的失败模式,所以这一节无条件打印。
console.log('')
console.log(`-- 宿主环境集成(清单:${report.hostIntegrationsFile};缺席属预期,但不豁免安全阀) --`)
if (report.hostIntegrations.length === 0) {
	console.log('   (清单为空:没有声明任何宿主环境集成)')
}
for (const h of report.hostIntegrations) {
	const mark = h.verdict === 'resolved' ? '✅' : h.verdict === 'absent-expected' ? '➖' : '❌'
	const state = h.verdict === 'resolved'
		? `解析到 ${h.resolvedAt}${h.version ? ` @ ${h.version}` : ''}`
		: h.verdict === 'absent-expected'
			? '未解析到 —— **属预期**,不阻断'
			: '声明不成立(见下)'
	console.log(`   ${mark} ${h.specifier}: ${state}`)
	console.log(`        为什么是宿主集成: ${h.why.length > 160 ? h.why.slice(0, 160) + '……(全文见清单)' : h.why}`)
	console.log(`        缺席时降级到: ${h.degradation.file} 的 ${h.degradation.export}()`
		+ `${h.degradationOk ? '  [已核验该文件确实导出此名]' : '  [⚠️ 核验失败]'}`)
	if (h.optInEnv) console.log(`        本机启用: 设 ${h.optInEnv} 指向一份可用模块`)
	if (h.consumers.length) console.log(`        消费点: ${h.consumers.join('、')}`)
	// 图观测到 / 没观测到,如实说。没观测到时必须讲清楚原因,不能让读者
	// 误以为"图确认了它是动态导入"。
	if (h.graphObserved) {
		const kinds = [...new Set(h.observedImporters.map((i) => i.kind))]
		console.log(`        静态图观测: ${h.observedImporters.length} 处导入,形态 ${kinds.join('、')}`)
	} else {
		console.log(`        静态图观测: **未观测到任何导入** —— 说明符藏在变量后面,词法层定不了值;`)
		console.log(`                    所以「它是动态形态」这点**图无法佐证**,本行依据的是上面已核验的降级实现。`)
	}
	for (const p of h.problems) console.log(`        ❌ ${p}`)
}
const hostIntegrationsOk = report.hostIntegrations.every((h) => h.verdict !== 'violation')

if (report.importGraph.dynamicNonLiteral.length) {
	console.log('')
	console.log(`-- 静态无法定值的动态导入(如实披露:本检查对这些点不成立) --`)
	for (const d of report.importGraph.dynamicNonLiteral.slice(0, 10)) console.log(`   ⚠️  ${d.file}:${d.line} ${d.kind} —— ${d.note}`)
}
if (report.importGraph.unresolvedRelative.length) {
	console.log('')
	console.log(`-- 未解析的**相对**导入(不是缺包;${strictGraph ? '--strict-graph 下算不就绪' : '默认只报不阻断'}) --`)
	for (const u of report.importGraph.unresolvedRelative.slice(0, 10)) console.log(`   ⚠️  ${u.from}:${u.line} → '${u.specifier}'${u.note ? ` (${u.note})` : ''}`)
}
if (report.importGraph.unparseable.length) {
	console.log('')
	console.log('-- 扫不动的文件(结论对这些文件不成立,如实标出) --')
	for (const u of report.importGraph.unparseable) console.log(`   ⚠️  ${u.file}: ${u.error}`)
}
if (report.hostPathSuites?.length) {
	console.log('')
	// 措辞校正(2026-09-09):这一节原先写「写死的绝对路径依赖」,复核后发现**不准确**,
	// 两点都不对,如实改掉:
	//   1. 位置不对 —— 路径不在测试文件里。dsh-agos-router/test/http-routes.test.mjs 的
	//      导入只有 node: 内置与 '../lib/index.js',全文没有任何绝对路径字面量。真正读盘的是
	//      它调的 apply() → lib/outcomes.js:211 readOutcomeSources(),失败点是 ~/.dsh/logs/civ/runs。
	//   2. 「写死」不对 —— 那条路径是 homedir() 推导出来的,且**认环境变量覆盖**
	//      (outcomes.js:211 DSH_CIV_HISTORY_DIR、:191 DSH_FLEET_RUNS_FILE/DSH_FLEET_LEDGER_PATH)。
	//      套件只是没设这些变量,于是回落到操作者真实 HOME。
	// 还有一点必须挑明:这一节的判据**不是本检查器得出的** —— 本检查器只做静态导入图,
	// 看不见运行时读盘。它来自 dependency-surface.json 的沙箱差分观测
	// (natural 通过、no-dsh 下 EPERM scandir '<HOME>/.dsh/logs/civ/runs')。
	console.log('-- 不是包依赖:运行时读宿主 $HOME/.dsh 树(装包解决不了) --')
	console.log(`   判据来源:dependency-surface.json 的沙箱差分(natural 通过 / no-dsh 下 EPERM),**非**本检查器的静态图。`)
	for (const s of report.hostPathSuites) {
		console.log(`   ⚠️  ${s}`)
		console.log(`        路径由 homedir() 推导、非字面量,且认 DSH_CIV_HISTORY_DIR 等覆盖变量;套件未设,故回落到真实 HOME。`)
		console.log(`        所有权属 Kimi(dsh-agos-router 测试),本轮不修。`)
	}
}
if (report.pinConformance.length) {
	console.log('')
	console.log('-- 版本与插件自己 package.json 声明不一致 --')
	for (const m of report.pinConformance) console.log(`   ⚠️  ${m.package}: ${m.declaredBy} 声明 ${m.declared},实际解析到 ${m.resolved}`)
}

const pinsOk = !strictPins || report.pinConformance.length === 0
const graphOk = !strictGraph || report.importGraph.unresolvedRelative.length === 0
report.ready = resolvableAll && pinsOk && graphOk && hostIntegrationsOk
const exemptCount = report.hostIntegrations.filter((h) => h.verdict === 'absent-expected').length
report.claims = {
	proves: report.ready
		? '插件源码完整导入图里的每个裸模块说明符都能按 Node 解析算法解析到,'
			+ `或属清单声明且已核验的宿主环境集成(${exemptCount} 个)。`
		: null,
	doesNotProve: report.importGraph.doesNotClaim,
}
console.log('')
if (report.ready) {
	const resolvedCount = report.required.filter((r) => r.resolvable).length
	console.log(`✅ 依赖面就绪:完整导入图里 ${resolvedCount}/${report.required.length} 个裸模块说明符可解析`
		+ (exemptCount ? `;另有 ${exemptCount} 个宿主环境集成缺席属预期(见上一节,已过安全阀)` : '')
		+ (report.pinConformance.length ? `(有 ${report.pinConformance.length} 处版本声明不一致,已记录,未用 --strict-pins 阻断)` : ''))
	console.log(`   本结论**不**涵盖:已装包自身的传递依赖、非字面量动态 import(${report.importGraph.dynamicNonLiteral.length} 处)、包内具名导出是否存在。`)
} else if (!hostIntegrationsOk) {
	const bad = report.hostIntegrations.filter((h) => h.verdict === 'violation')
	console.error(`❌ 宿主集成声明不成立:${bad.length} 条。清单声明缺席属预期,但核验没通过 —— 这**不是**豁免:`)
	for (const h of bad) {
		console.error(`     ${h.specifier}`)
		for (const p of h.problems) console.error(`         ↳ ${p}`)
		for (const i of h.loadBearingImporters.slice(0, 6)) {
			console.error(`         ↳ 加载期导入:${i.file}:${i.line} (${i.kind}) —— 这一处失败会让整个插件加载不了,`)
			console.error(`                       它注册的所有工具一起消失,不是「优雅降级」。`)
		}
	}
	console.error('   要么把这些导入改成动态可选形态(await import() + 显式不可用分支),')
	console.error(`   要么把它当普通包依赖装上,要么把它从 ${report.hostIntegrationsFile} 里去掉。`)
} else if (!resolvableAll) {
	const missing = report.required.filter((r) => !r.resolvable && !r.hostIntegration)
	console.error(`❌ 依赖面**未**就绪:完整导入图里 ${missing.length}/${report.required.length} 个裸包解析不到。缺的是具体这些包,不是"环境问题":`)
	for (const r of missing) {
		console.error(`     ${r.package}   —— 被 ${r.importerCount} 处导入,消费者:${r.consumers.join(', ')}`)
		for (const m of r.missingFor.slice(0, 4)) {
			console.error(`         ↳ ${m.file}:${m.line} 导入 '${m.specifier}'${m.rootKind === 'test' ? '(测试入口)' : ''}`)
		}
		if (r.missingFor.length > 4) console.error(`         ↳ …… 另有 ${r.missingFor.length - 4} 处(完整列表见 --graph-json)`)
	}
	console.error('   操作员可选(按可复现性排序):')
	console.error('     1) 联网从注册表装钉版:node scripts/acceptance/prepare-host-modules.mjs')
	console.error('     2) 换注册表:                --registry=https://registry.npmjs.org')
	console.error('     3) 离线、显式从既有依赖树只读复制(必须自己给路径,没有默认值):')
	console.error('        node scripts/acceptance/prepare-host-modules.mjs --offline --copy-from=<某个 node_modules 目录>')
	console.error(`        例:--copy-from=$HOME/.dsh/profiles/node_modules   ← 用户的活 profile,只读复制,绝不写入/软链`)
	console.error('   在此之前,依赖这些包的套件会被验收器报成 missing-host-modules 失败,不会被算作跳过或通过。')
} else if (!graphOk) {
	console.error(`❌ --strict-graph:有 ${report.importGraph.unresolvedRelative.length} 处相对导入解析不到(见上)。`)
} else {
	console.error(`❌ --strict-pins:有 ${report.pinConformance.length} 处版本与声明不一致(见上)。`)
}
if (graphJsonOut) {
	// 取证用:完整图落盘。脱敏到相对路径,不带操作员绝对路径。
	const p = resolve(graphJsonOut)
	mkdirSync(dirname(p), { recursive: true })
	writeFileSync(p, JSON.stringify({
		schema: 'agos-acceptance/import-graph@1',
		generatedAt: report.generatedAt,
		method: report.importGraph.method,
		claims: report.importGraph.claims,
		doesNotClaim: report.importGraph.doesNotClaim,
		entryPointsByPlugin: report.importGraph.entryPointsByPlugin,
		files: scan.graph.files.map((f) => ({ file: f.rel, kind: f.kind, parsed: f.parsed, specifiers: f.specifiers })),
		bare: report.importGraph.packages,
		unresolvedRelative: report.importGraph.unresolvedRelative,
		dynamicNonLiteral: report.importGraph.dynamicNonLiteral,
		unparseable: report.importGraph.unparseable,
		outOfTree: report.importGraph.outOfTree,
		hostIntegrationsFile: report.hostIntegrationsFile,
		hostIntegrations: report.hostIntegrations,
	}, null, 2) + '\n')
	console.log(`   完整导入图已写入 ${relative(REPO_ROOT, p)}`)
}
flush()
process.exit(report.ready ? 0 : 1)
