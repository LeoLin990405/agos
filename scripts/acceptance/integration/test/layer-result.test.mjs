/**
 * 结果格式与证据完整性的单元测试。
 *
 * 这里守的是「消费端说了算」这条纪律:生产者是**可能出错的那一方**,所以自相矛盾的自述
 * 一律按坏的那一半判,格式不合格一律当成"没有结果"而不是"格式小问题"。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { LAYERS, LAYER_SCHEMA, buildLayerResult, digestDriftVerdict, emptyCounts, isLayerGreen, platformInfo, resolveVerdict, validateLayerResult } from '../lib/layer-result.mjs'
import { sha256, sha256File, verifyLogs } from '../lib/evidence.mjs'
import { tempRoot } from './helpers.mjs'

const good = (over = {}) => buildLayerResult({
	layer: 'swarm', verdict: 'pass',
	sourceCommit: 'a'.repeat(40), worktreeDigest: 'b'.repeat(64),
	command: ['node', 'x.mjs'], startedAt: '2026-09-09T00:00:00.000Z', endedAt: '2026-09-09T00:00:01.000Z',
	exitCode: 0, counts: { pass: 1, fail: 0, skip: 0, blocked: 0 }, logs: [],
	...over,
})

test('F1 正控:一份合格的结果没有任何校验错误', () => {
	assert.deepEqual(validateLayerResult(good(), { layer: 'swarm' }), [])
})

test('F2 platformInfo 四个字段都来自真实探测,没有硬编码常量', () => {
	const p = platformInfo()
	assert.equal(p.os, process.platform)
	assert.equal(p.arch, process.arch)
	assert.equal(p.node, process.version)
	assert.ok(typeof p.release === 'string' && p.release.length > 0)
})

test('F3 schema / layer 对不上都要报出来', () => {
	const codes = (r, layer) => validateLayerResult(r, { layer }).map((e) => e.code)
	assert.ok(codes({ ...good(), schema: 'other@1' }, 'swarm').includes('schema-mismatch'))
	assert.ok(codes(good({ layer: 'linux' }), 'swarm').includes('layer-mismatch'))
	assert.ok(codes({ ...good(), layer: 'nope' }, undefined).includes('layer-unknown'))
	assert.equal(LAYER_SCHEMA, 'agos-acceptance/integration-layer@1')
	assert.deepEqual(LAYERS, ['code-gate', 'swarm', 'linux', 'host-browser'])
})

test('F4 counts 必须四路齐全且非负整数 —— 少一路就等于某一类结局无处安放', () => {
	const codes = (counts) => validateLayerResult({ ...good(), counts }, { layer: 'swarm' }).map((e) => e.code)
	assert.ok(codes({ pass: 1, fail: 0, skip: 0 }).includes('counts-invalid'), 'blocked 缺失必须被抓')
	assert.ok(codes({ pass: 1, fail: 0, skip: 0, blocked: -1 }).includes('counts-invalid'))
	assert.ok(codes({ pass: 1.5, fail: 0, skip: 0, blocked: 0 }).includes('counts-invalid'))
})

test('F5 command 必须是 argv 数组,拼好的字符串不算', () => {
	const codes = (command) => validateLayerResult({ ...good(), command }, { layer: 'swarm' }).map((e) => e.code)
	assert.ok(codes('node x.mjs').includes('command-invalid'))
	assert.ok(codes([]).includes('command-invalid'))
	assert.ok(codes(['node', 3]).includes('command-invalid'))
})

test('F6 blocked 必须给具体原因和可复制的恢复命令', () => {
	const codes = (over) => validateLayerResult(good({ verdict: 'blocked', counts: { ...emptyCounts(), blocked: 1 }, ...over }), { layer: 'swarm' }).map((e) => e.code)
	assert.ok(codes({ blockedReason: '环境不支持', recoveryCommand: ['x'] }).includes('blocked-reason-too-vague'))
	assert.ok(codes({ blockedReason: null, recoveryCommand: ['x'] }).includes('blocked-reason-too-vague'))
	assert.ok(codes({ blockedReason: '本机没有任何容器运行时:探测过 docker/podman/lima/colima,均无可执行文件' }).includes('blocked-without-recovery'))
	assert.deepEqual(codes({
		blockedReason: '本机没有任何容器运行时:探测过 docker/podman/lima/colima,均无可执行文件',
		recoveryCommand: ['node', 'run-matrix.mjs', '--require=linux'],
	}), [])
})

test('F7 自相矛盾的自述按坏的那一半判', () => {
	assert.equal(resolveVerdict(good({ counts: { pass: 3, fail: 1, skip: 0, blocked: 0 } })).verdict, 'fail')
	assert.equal(resolveVerdict(good({ counts: { pass: 3, fail: 0, skip: 0, blocked: 2 } })).verdict, 'blocked')
	assert.equal(resolveVerdict(good({ counts: { pass: 0, fail: 0, skip: 5, blocked: 0 } })).verdict, 'fail')
	assert.equal(resolveVerdict(good({ verdict: 'skipped', counts: { pass: 0, fail: 0, skip: 1, blocked: 3 } })).verdict, 'blocked')
	// 正控:不矛盾的自述原样通过。
	const ok = resolveVerdict(good())
	assert.equal(ok.verdict, 'pass')
	assert.equal(ok.downgradedFrom, null)
})

test('F8 只有 pass 是绿', () => {
	assert.equal(isLayerGreen('pass'), true)
	for (const v of ['fail', 'blocked', 'skipped', 'empty', undefined]) assert.equal(isLayerGreen(v), false)
})

test('F9 工作树摘要对不上:稳定树判 fail,被并行改动的树判 blocked —— 两个分支都不是 pass', () => {
	const stable = digestDriftVerdict({ treeStable: true, declared: 'f'.repeat(64), matrix: 'a'.repeat(64), layer: 'swarm' })
	assert.equal(stable.verdict, 'fail')
	assert.match(stable.reason, /^stale-layer-result:worktree/)
	assert.equal(stable.recoveryCommand, null)

	const unstable = digestDriftVerdict({ treeStable: false, declared: 'f'.repeat(64), matrix: 'a'.repeat(64), layer: 'linux' })
	assert.equal(unstable.verdict, 'blocked')
	assert.match(unstable.reason, /^unattributable-worktree:linux/)
	// blocked 必须自带具体原因与恢复命令,否则它自己就过不了 F6 那道校验。
	assert.deepEqual(validateLayerResult(good({
		layer: 'linux', verdict: 'blocked', counts: { ...emptyCounts(), blocked: 1 },
		blockedReason: unstable.blockedReason, recoveryCommand: unstable.recoveryCommand,
	}), { layer: 'linux' }), [])
})

test('E1 日志哈希实测一致 → 通过;改一个字节 → mismatch 并同时给出声称值与实测值', () => {
	const dir = tempRoot('e1')
	const p = join(dir, 'a.log')
	writeFileSync(p, 'hello\n')
	const declared = sha256File(p)
	const okRes = verifyLogs([{ path: p, sha256: declared }], { baseDir: dir, repoRoot: dir })
	assert.deepEqual(okRes.mismatches, [])
	assert.equal(okRes.checked, 1)
	assert.equal(okRes.entries[0].match, true)

	writeFileSync(p, 'hello!\n')
	const bad = verifyLogs([{ path: p, sha256: declared }], { baseDir: dir, repoRoot: dir })
	assert.equal(bad.mismatches.length, 1)
	assert.equal(bad.mismatches[0].code, 'log-digest-mismatch')
	assert.equal(bad.mismatches[0].declared, declared)
	assert.equal(bad.mismatches[0].actual, sha256('hello!\n'))
})

test('E2 相对路径先按 baseDir 解、再按 repoRoot 解', () => {
	const base = tempRoot('e2base')
	const repo = tempRoot('e2repo')
	mkdirSync(join(repo, 'nested'), { recursive: true })
	writeFileSync(join(base, 'in-base.log'), 'B\n')
	writeFileSync(join(repo, 'nested', 'in-repo.log'), 'R\n')
	const r = verifyLogs([
		{ path: 'in-base.log', sha256: sha256('B\n') },
		{ path: 'nested/in-repo.log', sha256: sha256('R\n') },
	], { baseDir: base, repoRoot: repo })
	assert.deepEqual(r.mismatches, [])
	assert.equal(r.checked, 2)
})

test('E3 日志不存在 → log-missing,并把找过的路径都列出来(与"哈希对不上"分开)', () => {
	const dir = tempRoot('e3')
	const r = verifyLogs([{ path: 'nope.log', sha256: 'c'.repeat(64) }], { baseDir: dir, repoRoot: dir })
	assert.equal(r.mismatches[0].code, 'log-missing')
	assert.ok(r.mismatches[0].searched.length >= 1)
})

test('E4 哈希字段不是 64 位十六进制 → 直接判坏,不去猜它想表达什么', () => {
	const dir = tempRoot('e4')
	writeFileSync(join(dir, 'a.log'), 'x')
	for (const bad of [undefined, null, '', 'not-a-hash', 123, 'A'.repeat(64)]) {
		const r = verifyLogs([{ path: join(dir, 'a.log'), sha256: bad }], { baseDir: dir, repoRoot: dir })
		assert.equal(r.mismatches[0].code, 'log-entry-bad-digest', `${JSON.stringify(bad)} 应当被判坏`)
	}
})

test('E5 logs 不是数组 / 条目不是对象 / 缺 path → 各有各的错码', () => {
	const dir = tempRoot('e5')
	assert.equal(verifyLogs('x', { baseDir: dir, repoRoot: dir }).mismatches[0].code, 'logs-not-an-array')
	assert.equal(verifyLogs([null], { baseDir: dir, repoRoot: dir }).mismatches[0].code, 'log-entry-not-an-object')
	assert.equal(verifyLogs([{ sha256: 'd'.repeat(64) }], { baseDir: dir, repoRoot: dir }).mismatches[0].code, 'log-entry-missing-path')
})

test('E6 日志路径指向目录或符号链接 → 不当成普通文件放过', () => {
	const dir = tempRoot('e6')
	mkdirSync(join(dir, 'adir'), { recursive: true })
	const asDir = verifyLogs([{ path: join(dir, 'adir'), sha256: 'e'.repeat(64) }], { baseDir: dir, repoRoot: dir })
	assert.equal(asDir.mismatches[0].code, 'log-not-a-regular-file')
	writeFileSync(join(dir, 'real.log'), 'R\n')
	symlinkSync(join(dir, 'real.log'), join(dir, 'link.log'))
	const asLink = verifyLogs([{ path: join(dir, 'link.log'), sha256: sha256('R\n') }], { baseDir: dir, repoRoot: dir })
	assert.equal(asLink.mismatches[0].code, 'log-not-a-regular-file',
		'经符号链接的日志一律不认:链接可以在结果写完之后被改指向,而内容哈希看起来照样对')
})
