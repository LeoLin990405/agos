#!/usr/bin/env node
/**
 * 元证明:把矩阵**故意改坏**,证明上面那些负控不是空转。
 *
 * 一套负控最容易犯的错是"它其实什么都没守着" —— 断言恰好总为真、或者被守的分支根本没被走到。
 * 唯一能反驳这件事的办法是**削弱实现**,然后看是否真的有测试变红,以及变红的是不是该变红的那条。
 *
 * 全部在 `mkdtemp` 出来的副本上做:仓里的源码一个字节都不动(本轮还有四个代理在同一个
 * 工作区并行写文件,在原地改坏源码等于给别人埋雷)。副本里 `git init` + 一次提交,
 * 好让工作树摘要那部分逻辑在副本里也是真的在跑,而不是走"不是 git 仓"的降级分支。
 *
 * 用法:  node scripts/acceptance/integration/mutation-check.mjs
 * 退出码:全部突变都被抓到 → 0;有任何一条改坏了却没人变红 → 1。
 */
import { cpSync, mkdtempSync, readFileSync, realpathSync, writeFileSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const HERE = dirname(new URL(import.meta.url).pathname)
const REPO = resolve(HERE, '..', '..', '..')

/**
 * 每条突变:改哪个文件、把什么换成什么、期望哪些测试变红。
 * `from` 必须在文件里**恰好出现一次** —— 出现 0 次说明实现改过而这张表没跟上(那才是最危险的:
 * 突变悄悄没生效,元证明就变成了走过场);出现多次说明定位不够精确。
 */
const MUTATIONS = [
	{
		id: 'M1', what: '日志哈希对不上时不再报错(证据完整性闸失效)',
		file: 'scripts/acceptance/integration/lib/evidence.mjs',
		from: '\t\tif (actual !== declared) {', to: '\t\tif (false) {',
		files: ['test/matrix-negatives.test.mjs', 'test/layer-result.test.mjs'], pattern: '^(N5a|N5b|E1) ',
		expect: ['N5a', 'N5b', 'E1'],
	},
	{
		id: 'M2', what: '日志文件不存在时静默放过',
		file: 'scripts/acceptance/integration/lib/evidence.mjs',
		from: "\t\t\tmismatches.push({ code: 'log-missing'", to: "\t\t\t;[].push({ code: 'log-missing'",
		files: ['test/matrix-negatives.test.mjs', 'test/layer-result.test.mjs'], pattern: '^(N5c|E3) ',
		expect: ['N5c', 'E3'],
	},
	{
		id: 'M3', what: '自相矛盾的自述不再降级(自称 pass 就算 pass)',
		file: 'scripts/acceptance/integration/lib/layer-result.mjs',
		from: "\tif (claimed === 'pass') {", to: "\tif (false) {",
		files: ['test/matrix-negatives.test.mjs', 'test/layer-result.test.mjs'], pattern: '^(C1|C2|C3|F7) ',
		expect: ['C1', 'C2', 'C3', 'F7'],
	},
	{
		id: 'M4', what: 'blocked 不再要求具体原因与恢复命令',
		file: 'scripts/acceptance/integration/lib/layer-result.mjs',
		from: "\tif (raw.verdict === 'blocked') {", to: '\tif (false) {',
		files: ['test/matrix-negatives.test.mjs', 'test/layer-result.test.mjs'], pattern: '^(N4c|F6) ',
		expect: ['N4c', 'F6'],
	},
	{
		id: 'M5', what: 'counts 不再要求四路齐全(blocked 一路可以消失)',
		file: 'scripts/acceptance/integration/lib/layer-result.mjs',
		from: "['pass', 'fail', 'skip', 'blocked'].some((k) => !isNonNegativeInt(raw.counts[k]))",
		to: "['pass', 'fail', 'skip'].some((k) => !isNonNegativeInt(raw.counts[k]))",
		files: ['test/layer-result.test.mjs'], pattern: '^F4 ',
		expect: ['F4'],
	},
	{
		id: 'M6', what: '工作树摘要不再逐文件展开未跟踪目录(-uall → 默认)',
		file: 'scripts/acceptance/integration/lib/worktree.mjs',
		from: "['status', '--porcelain=v1', '-uall', '-z']", to: "['status', '--porcelain=v1', '-z']",
		files: ['test/worktree.test.mjs'], pattern: '^W5 ',
		expect: ['W5'],
	},
	{
		id: 'M7', what: '验收器自报 authoritative=false 时照样算代码门通过',
		file: 'scripts/acceptance/integration/lib/code-gate-adapter.mjs',
		from: '\tif (acc.authoritative !== true) {', to: '\tif (false) {',
		files: ['test/matrix-negatives.test.mjs'], pattern: '^(N6a|N6b) ',
		expect: ['N6a', 'N6b'],
	},
	{
		id: 'M8', what: '子检查超时不再被识别成超时',
		file: 'scripts/acceptance/integration/run-matrix.mjs',
		from: '\tconst timedOut = r.durationSeconds * 1000 >= spec.timeoutMs - 100 || /killed by signal/.test(r.spawnError ?? \'\')',
		to: '\tconst timedOut = false',
		files: ['test/matrix-negatives.test.mjs'], pattern: '^N2 ',
		expect: ['N2'],
	},
	{
		id: 'M9', what: '结果文件缺失时不再判红(当成没这回事)',
		file: 'scripts/acceptance/integration/run-matrix.mjs',
		from: '\tif (!existsSync(spec.resultPath)) {', to: '\tif (false) {',
		files: ['test/matrix-negatives.test.mjs'], pattern: '^N3a ',
		expect: ['N3a'],
	},
	{
		id: 'M10', what: '自称 pass 却退非零时不再降级',
		file: 'scripts/acceptance/integration/run-matrix.mjs',
		from: "\t} else if (r.exitCode !== 0 && verdict === 'pass') {", to: '\t} else if (false) {',
		files: ['test/matrix-negatives.test.mjs'], pattern: '^N1b ',
		expect: ['N1b'],
	},
	{
		id: 'M11', what: '被要求的层 blocked 时退出码给 0',
		file: 'scripts/acceptance/integration/run-matrix.mjs',
		from: '} else if (requiredNotPassing.length > 0) {\n\texitCode = EXIT_REFUSE',
		to: '} else if (requiredNotPassing.length > 0) {\n\texitCode = EXIT_OK',
		files: ['test/matrix-negatives.test.mjs'], pattern: '^(N4a|N4b) ',
		expect: ['N4a', 'N4b'],
	},
	{
		id: 'M12', what: '用了自检接缝的运行也可以自称"全部验证通过"',
		file: 'scripts/acceptance/integration/run-matrix.mjs',
		from: 'const allVerified = allLayersPass && !SYNTHETIC && integrityErrors.length === 0',
		to: 'const allVerified = allLayersPass',
		files: ['test/matrix-negatives.test.mjs'], pattern: '^(S2|N6c) ',
		// 只有 S2 守着这条。N6c 里的 `allVerified === false` 在这条突变下**照样成立** ——
		// 它那次运行有三层是 skipped,`allLayersPass` 本来就是 false,所以它的绿是"另一个原因"
		// 给的,不是 SYNTHETIC 这一项给的。第一版表里把 N6c 也列进期望,实测没红;
		// 诚实的收法是改表,不是给 N6c 硬塞一条它本不负责的断言。
		expect: ['S2'],
	},
	{
		id: 'M13', what: '结果自称的提交对不上也照样采信',
		file: 'scripts/acceptance/integration/run-matrix.mjs',
		from: "\tif (parsed.sourceCommit !== (wtStart.head ?? 'unavailable')) {", to: '\tif (false) {',
		files: ['test/matrix-negatives.test.mjs'], pattern: '^C5 ',
		expect: ['C5'],
	},
	{
		id: 'M14', what: '工作树摘要归属不上时静默放过',
		file: 'scripts/acceptance/integration/run-matrix.mjs',
		from: '\t\tif (!observed.includes(parsed.worktreeDigest)) {', to: '\t\tif (false) {',
		files: ['test/matrix-negatives.test.mjs'], pattern: '^C6 ',
		expect: ['C6'],
	},
	{
		id: 'M15', what: '日志目录已有内容时照样覆盖',
		file: 'scripts/acceptance/integration/run-matrix.mjs',
		from: 'if (existsSync(logDir) && readdirSync(logDir).length > 0 && !allowExistingLogdir) {',
		to: 'if (false) {',
		files: ['test/matrix-negatives.test.mjs'], pattern: '^G5 ',
		expect: ['G5'],
	},
]

/** 造一份可独立运行的副本:integration/ 全量 + 它依赖的 scripts/acceptance/lib/。 */
function makeCopy() {
	const dst = realpathSync(mkdtempSync(join(tmpdir(), 'agos-matrix-mut-')))
	cpSync(join(REPO, 'scripts', 'acceptance', 'lib'), join(dst, 'scripts', 'acceptance', 'lib'), { recursive: true })
	cpSync(HERE, join(dst, 'scripts', 'acceptance', 'integration'), { recursive: true })
	for (const argv of [['init', '-q', '-b', 'main'], ['config', 'user.email', 'mutation@example.invalid'], ['config', 'user.name', 'mutation'], ['config', 'commit.gpgsign', 'false'], ['add', '-A'], ['commit', '-q', '-m', 'copy']]) {
		const res = spawnSync('git', argv, { cwd: dst, encoding: 'utf8' })
		if (res.status !== 0) throw new Error(`git ${argv.join(' ')} 在副本里失败: ${res.stderr}`)
	}
	return dst
}

function runTests(root, files, pattern) {
	const env = { ...process.env }
	delete env.NODE_TEST_CONTEXT
	delete env.NODE_OPTIONS
	const argv = ['--test']
	if (pattern) argv.push(`--test-name-pattern=${pattern}`)
	for (const f of files) argv.push(join('scripts', 'acceptance', 'integration', f))
	const res = spawnSync('node', argv, { cwd: root, env, encoding: 'utf8', timeout: 600000, maxBuffer: 64 * 1024 * 1024 })
	const out = (res.stdout ?? '') + (res.stderr ?? '')
	// `✖ failing tests:` 是 node --test 的小标题,不是一条测试名 —— 混进来会让"变红了几条"虚高。
	const failed = [...out.matchAll(/^✖ (\S+)/gm)].map((m) => m[1]).filter((n) => n !== 'failing')
	const passed = [...out.matchAll(/^✔ (\S+)/gm)].map((m) => m[1])
	return { exitCode: res.status, failed: [...new Set(failed)], passed: [...new Set(passed)], out }
}

const rows = []
let bad = 0

// 先证明副本本身是绿的 —— 否则后面每条突变"变红"都可能只是副本坏了。
const baseRoot = makeCopy()
const baseline = runTests(baseRoot, ['test/matrix-negatives.test.mjs', 'test/layer-result.test.mjs', 'test/worktree.test.mjs'], null)
console.log(`基线(未突变的副本): 退出码 ${baseline.exitCode},通过 ${baseline.passed.length},失败 ${baseline.failed.length}`)
if (baseline.exitCode !== 0) {
	console.error('❌ 副本本身就不是绿的,后面的突变证据都不成立。')
	console.error(baseline.out.split('\n').slice(-40).join('\n'))
	process.exit(1)
}
rmSync(baseRoot, { recursive: true, force: true })

for (const m of MUTATIONS) {
	const root = makeCopy()
	const target = join(root, m.file)
	const src = readFileSync(target, 'utf8')
	const hits = src.split(m.from).length - 1
	if (hits !== 1) {
		console.log(`▸ ${m.id} ❌ 定位串在 ${m.file} 里出现 ${hits} 次(必须恰好 1 次)—— 突变没生效,元证明不成立`)
		rows.push({ id: m.id, ok: false, note: `锚点出现 ${hits} 次` })
		bad += 1
		rmSync(root, { recursive: true, force: true })
		continue
	}
	writeFileSync(target, src.replace(m.from, m.to))
	const r = runTests(root, m.files, m.pattern)
	const caught = m.expect.filter((name) => r.failed.some((f) => f === name || f.startsWith(name)))
	const missed = m.expect.filter((name) => !caught.includes(name))
	const ok = r.exitCode !== 0 && missed.length === 0
	if (!ok) bad += 1
	console.log(`▸ ${m.id} ${ok ? '✅ 被抓' : '❌ 没被抓'} ${m.what}`)
	console.log(`     退出码 ${r.exitCode};变红: ${r.failed.join(', ') || '(无)'}${missed.length ? `;期望变红却没红: ${missed.join(', ')}` : ''}`)
	rows.push({ id: m.id, ok, what: m.what, exitCode: r.exitCode, failed: r.failed, missed })
	rmSync(root, { recursive: true, force: true })
}

console.log('')
console.log(`== 元证明汇总: ${rows.filter((r) => r.ok).length}/${rows.length} 条突变被抓 ==`)
if (bad > 0) {
	console.error(`❌ ${bad} 条突变没有被任何测试抓到 —— 对应的负控目前什么都没守着。`)
	process.exit(1)
}
console.log('✅ 每一条削弱都至少让一条指定的负控变红。')
