// 负例套件:verify-host-tree.mjs 的诚实表述 + 版本一致性检查(P1 缺陷 3)。
//
// 被修的两点:
//   1. 旧版措辞暗示自己证明了树的可复现性。实际上它只比"当前树 vs 我自己记的摘要",
//      是自指的:对"这份内容是否等于 registry 干净安装的结果"零信息量。
//   2. 内容摘要**按定义**抓不到版本矛盾。实测反例:锁文件声明
//      @deepseek-ai/dsh-settings@0.1.2-rc.1,而磁盘/基准是 0.1.0-rc.6。
//      摘要一致 + 版本撒谎,旧版会全绿。
//
// 全部用**真实子进程**跑真实脚本,夹具在 mkdtemp 里(--repo-root / --baseline 接缝)。
//
// 跑法:node --test scripts/acceptance/test/verify-host-tree.test.mjs

import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, dirname, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SCRIPT = resolve(HERE, '..', 'verify-host-tree.mjs')

const made = []
process.on('exit', () => {
	for (const d of made) { try { rmSync(d, { recursive: true, force: true }) } catch {} }
})

/** 按脚本顶部写死的口径手算摘要 —— 独立复算,不调用脚本内部函数。 */
function treeDigest(files) {
	const stream = createHash('sha256')
	for (const rel of Object.keys(files).sort()) {
		const bytes = Buffer.from(files[rel])
		stream.update(`${rel}\0${bytes.length}\0${createHash('sha256').update(bytes).digest('hex')}\n`)
	}
	return stream.digest('hex')
}

/**
 * 造一棵夹具树。
 * @param {object} o
 * @param {string} o.installedVersion 磁盘上 package.json 写的版本
 * @param {string} o.lockVersion      锁文件声明的版本
 * @param {string} [o.baselineVersion] 基准记录的版本(默认同 installed)
 * @param {boolean} [o.corruptDigest] 是否让基准摘要与实际不符
 * @param {boolean} [o.installed=true] 是否真的把包放进树里
 */
function fixture(label, o) {
	const root = mkdtempSync(join(tmpdir(), `agos-vht-${label}-`))
	made.push(root)
	const PKG = '@deepseek-ai/dsh-settings'
	const dir = `plugins/node_modules/${PKG}`
	const files = {
		'package.json': JSON.stringify({ name: PKG, version: o.installedVersion, main: 'index.js' }, null, 2) + '\n',
		'index.js': 'export function installSettingsSection() {}\n',
	}
	if (o.installed !== false) {
		mkdirSync(join(root, dir), { recursive: true })
		for (const [rel, content] of Object.entries(files)) writeFileSync(join(root, dir, rel), content)
	}
	// 锁文件:只声明这一个包,版本由参数控制 —— 这就是"声明"一侧。
	mkdirSync(join(root, 'plugins'), { recursive: true })
	writeFileSync(join(root, 'plugins', 'package-lock.json'), JSON.stringify({
		name: 'fixture', lockfileVersion: 3,
		packages: {
			'': { name: 'fixture', dependencies: { [PKG]: o.lockVersion } },
			[`node_modules/${PKG}`]: { version: o.lockVersion, resolved: `https://registry.example/${PKG}/-/x.tgz` },
		},
	}, null, 2) + '\n')
	writeFileSync(join(root, 'plugins', 'package.json'), JSON.stringify({
		name: 'fixture', dependencies: { [PKG]: o.lockVersion },
	}, null, 2) + '\n')
	// 基准:摘要按实际内容算(除非要求弄坏),版本按参数记。
	const digest = o.corruptDigest ? 'deadbeef'.repeat(8) : treeDigest(files)
	const baseline = join(root, 'baseline.json')
	writeFileSync(baseline, JSON.stringify({
		note: 'fixture baseline',
		convention: 'sha256 over sorted lines of `<relpath>\\0<bytes>\\0<sha256(file)>\\n`, nested node_modules excluded',
		packages: [{
			name: PKG, dir, why: 'fixture', provenance: 'fixture',
			version: o.baselineVersion ?? o.installedVersion,
			fileCount: Object.keys(files).length, digest,
		}],
	}, null, 2) + '\n')
	return { root, baseline, PKG }
}

function run(f, extra = []) {
	const res = spawnSync(process.execPath, [
		SCRIPT, `--repo-root=${f.root}`, `--baseline=${f.baseline}`, ...extra,
	], { encoding: 'utf8', timeout: 120000, env: { ...process.env } })
	return { code: res.status, out: (res.stdout ?? '') + (res.stderr ?? '') }
}

// verify-host-tree 的 TRACKED 里还有 dsh-kimicode-swarm,夹具树里没有它。
// 夹具的基准只声明 settings,所以 swarm 会走 "基准里有但 TRACKED 里没有" 的反向检查……
// 实际上是 TRACKED 有、基准没有 → 报 baseline-out-of-sync。为了让断言只针对
// 版本一致性这一条,统一用 --json 报告里 settings 那一项做判据,退出码只看方向。
function entryFor(f, jsonPath, name) {
	const report = JSON.parse(readFileSync(jsonPath, 'utf8'))
	return {
		report,
		content: report.content.find((c) => c.name === name),
		version: report.versionConsistency.find((v) => v.name === name),
	}
}

test('NC-V1: 锁文件声明 0.1.2-rc.1 而实装 0.1.0-rc.6 → 非零退出并点名两个版本', () => {
	// 这就是 Luna 指出的那条真实矛盾,在夹具里原样复现。
	const f = fixture('mismatch', { installedVersion: '0.1.0-rc.6', lockVersion: '0.1.2-rc.1' })
	const jsonPath = join(f.root, 'report.json')
	const r = run(f, [`--json=${jsonPath}`])

	assert.notEqual(r.code, 0, `版本矛盾必须非零退出,实际 ${r.code}\n${r.out}`)
	assert.match(r.out, /版本声明与实际不一致/, '必须明说版本不一致')
	assert.match(r.out, /0\.1\.2-rc\.1/, '必须点名锁文件声明的版本')
	assert.match(r.out, /0\.1\.0-rc\.6/, '必须点名实际的版本')
	assert.match(r.out, new RegExp(f.PKG.replace('/', '\\/')), '必须点名是哪个包')

	const e = entryFor(f, jsonPath, f.PKG)
	assert.equal(e.content.verdict, 'matches-baseline', '内容摘要本身是一致的 —— 证明摘要抓不到版本矛盾')
	assert.equal(e.version.verdict, 'version-mismatch', '版本一致性这条必须判为不一致')
	assert.equal(e.version.lockfileVersion, '0.1.2-rc.1')
	assert.equal(e.version.installedVersion, '0.1.0-rc.6')
})

/**
 * 完整夹具:TRACKED 里的**两个**包都装好、摘要都对、锁文件都声明,
 * 只让其中一个的版本与锁文件不符。这样 contentBad=0,能干净地证明退出码 4 存在。
 */
function fullFixture(label, { swarmLock = '0.1.0', swarmInstalled = '0.1.0', settingsLock = '0.1.2-rc.1', settingsInstalled = '0.1.2-rc.1' } = {}) {
	const root = mkdtempSync(join(tmpdir(), `agos-vht-${label}-`))
	made.push(root)
	const specs = [
		{ name: 'dsh-kimicode-swarm', dir: 'plugins/node_modules/dsh-kimicode-swarm', lock: swarmLock, installed: swarmInstalled },
		{ name: '@deepseek-ai/dsh-settings', dir: 'plugins/node_modules/@deepseek-ai/dsh-settings', lock: settingsLock, installed: settingsInstalled },
	]
	const lockPackages = { '': { name: 'fixture', dependencies: {} } }
	const baselinePkgs = []
	for (const s of specs) {
		const files = {
			'package.json': JSON.stringify({ name: s.name, version: s.installed, main: 'index.js' }, null, 2) + '\n',
			'index.js': 'export default {}\n',
		}
		mkdirSync(join(root, s.dir), { recursive: true })
		for (const [rel, content] of Object.entries(files)) writeFileSync(join(root, s.dir, rel), content)
		lockPackages[''].dependencies[s.name] = s.lock
		lockPackages[`node_modules/${s.name}`] = { version: s.lock, resolved: `https://registry.example/${s.name}.tgz` }
		baselinePkgs.push({
			name: s.name, dir: s.dir, why: 'fixture', provenance: 'fixture',
			version: s.installed, fileCount: 2, digest: treeDigest(files),
		})
	}
	mkdirSync(join(root, 'plugins'), { recursive: true })
	writeFileSync(join(root, 'plugins', 'package-lock.json'),
		JSON.stringify({ name: 'fixture', lockfileVersion: 3, packages: lockPackages }, null, 2) + '\n')
	writeFileSync(join(root, 'plugins', 'package.json'),
		JSON.stringify({ name: 'fixture', dependencies: lockPackages[''].dependencies }, null, 2) + '\n')
	const baseline = join(root, 'baseline.json')
	writeFileSync(baseline, JSON.stringify({
		note: 'fixture baseline',
		convention: 'sha256 over sorted lines of `<relpath>\\0<bytes>\\0<sha256(file)>\\n`, nested node_modules excluded',
		packages: baselinePkgs,
	}, null, 2) + '\n')
	return { root, baseline, PKG: '@deepseek-ai/dsh-settings' }
}

test('NC-V2: 内容全对、仅版本矛盾 → 退出码 4(与内容漂移的 1 区分开)', () => {
	const f = fullFixture('code4', { settingsLock: '0.1.2-rc.1', settingsInstalled: '0.1.0-rc.6' })
	const jsonPath = join(f.root, 'r.json')
	const r = run(f, [`--json=${jsonPath}`])
	const report = JSON.parse(readFileSync(jsonPath, 'utf8'))

	const contentBad = report.content.filter((c) => !['matches-baseline', 'retired'].includes(c.verdict))
	assert.deepEqual(contentBad, [], `内容侧应当全对,实际 ${JSON.stringify(contentBad)}\n${r.out}`)
	assert.equal(r.code, 4, `内容全对、只有版本矛盾 → 必须退 4,实际 ${r.code}\n${r.out}`)
	assert.match(r.out, /版本一致性失败/, '必须明说是版本一致性失败')
	assert.match(r.out, /不能用锁文件论证/, '必须说清这条失败的含义')
	// 同一次运行里,另一个包版本是一致的 → 证明不是无脑全红。
	const swarm = report.versionConsistency.find((v) => v.name === 'dsh-kimicode-swarm')
	assert.equal(swarm.verdict, 'consistent', 'swarm 版本一致,不该被牵连报错')
})

test('POS-V2b: 两个包内容与版本都一致 → 退出 0', () => {
	const f = fullFixture('allgreen')
	const r = run(f)
	assert.equal(r.code, 0, `全一致必须退 0,实际 ${r.code}\n${r.out}`)
	assert.match(r.out, /内容与基准一致,且版本声明与锁文件一致/, '应明说两项都过')
	assert.match(r.out, /不\*\*证明\*\*|不.{0,2}构成/, '即便全绿也必须保留"不证明干净安装"的声明')
})

test('POS-V3: 版本一致 + 内容一致 → 该项判 consistent(证明不是无脑全红)', () => {
	const f = fixture('ok', { installedVersion: '0.1.2-rc.1', lockVersion: '0.1.2-rc.1' })
	const jsonPath = join(f.root, 'r.json')
	run(f, [`--json=${jsonPath}`])
	const e = entryFor(f, jsonPath, f.PKG)
	assert.equal(e.content.verdict, 'matches-baseline')
	assert.equal(e.version.verdict, 'consistent', `版本一致时不该报错,实际 ${JSON.stringify(e.version)}`)
})

test('NC-V4: 树没装时,退回用**基准记录的版本**比 —— 不让"没装"把这条检查静默失效', () => {
	// 上一轮漏掉版本矛盾的一个原因就是"树不在就跳过"。这里断言不跳过。
	const f = fixture('notinstalled', {
		installed: false, installedVersion: '0.1.0-rc.6',
		baselineVersion: '0.1.0-rc.6', lockVersion: '0.1.2-rc.1',
	})
	const jsonPath = join(f.root, 'r.json')
	const r = run(f, [`--json=${jsonPath}`])
	assert.notEqual(r.code, 0, '未安装 + 版本矛盾必须非零退出')
	const e = entryFor(f, jsonPath, f.PKG)
	// 树没装 → 内容报 missing;版本一致性仍应基于基准记录判出矛盾。
	assert.equal(e.content.verdict, 'missing', '内容侧应报缺失')
	assert.equal(e.version.verdict, 'version-mismatch', '版本侧必须仍能判出矛盾')
	assert.equal(e.version.actualFrom, '基准记录', '应说明比较用的是基准记录的版本')
})

test('NC-V5: 内容摘要漂移 → 退出 1 并点名期望/实际摘要', () => {
	const f = fixture('drift', {
		installedVersion: '0.1.2-rc.1', lockVersion: '0.1.2-rc.1', corruptDigest: true,
	})
	const r = run(f)
	assert.equal(r.code, 1, `内容漂移必须退 1,实际 ${r.code}\n${r.out}`)
	assert.match(r.out, /内容与基准不一致/, '必须明说内容漂移')
	assert.match(r.out, /deadbeef/, '必须打印期望摘要')
})

test('NC-V6: 输出必须写明"不证明等于 registry 干净安装"(诚实表述,不许暗示可复现性)', () => {
	const f = fixture('claims', { installedVersion: '0.1.2-rc.1', lockVersion: '0.1.2-rc.1' })
	const jsonPath = join(f.root, 'r.json')
	const r = run(f, [`--json=${jsonPath}`])

	assert.match(r.out, /不\*\*证明\*\*|不.{0,2}证明/, '输出里必须有"不证明"的表述')
	assert.match(r.out, /干净安装|npm ci/, '必须点明没证明的正是"干净安装"')
	assert.doesNotMatch(r.out, /可复现性证明|证明.{0,6}可复现/, '不得自称可复现性证明')

	const { report } = entryFor(f, jsonPath, f.PKG)
	assert.ok(Array.isArray(report.claims.proves) && report.claims.proves.length > 0, '机读报告必须列出证明了什么')
	assert.ok(Array.isArray(report.claims.doesNotProve) && report.claims.doesNotProve.length > 0, '机读报告必须列出没证明什么')
	assert.match(report.claims.doesNotProve.join(' '), /干净安装|npm ci/, '没证明的清单里必须含"干净安装"')
	assert.match(report.claims.doesNotProve.join(' '), /自指|循环/, '必须承认自记自校属自指')
	assert.match(report.claims.summary, /篡改检测器/, '定位必须是篡改检测器而非可复现性证明')
})

test('NC-V7: 锁文件不可读 → fail-closed 记为不一致,不当作通过', () => {
	const f = fixture('nolock', { installedVersion: '0.1.2-rc.1', lockVersion: '0.1.2-rc.1' })
	rmSync(join(f.root, 'plugins', 'package-lock.json'))
	const r = run(f, [`--lockfile=${join(f.root, 'plugins', 'package-lock.json')}`])
	assert.notEqual(r.code, 0, '锁文件缺失不得当成通过')
	assert.match(r.out, /锁文件不可读|无法判定/, '必须说明为何判不了')
})

test('NC-V8: 基准缺失 → fail-closed 退出 1', () => {
	const f = fixture('nobaseline', { installedVersion: '0.1.2-rc.1', lockVersion: '0.1.2-rc.1' })
	rmSync(f.baseline)
	const r = run(f)
	assert.equal(r.code, 1, '缺基准必须退 1')
	assert.match(r.out, /基准缺失/, '必须说明基准缺失')
})
