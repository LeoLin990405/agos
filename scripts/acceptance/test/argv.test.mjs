// Fail-closed argv:未知标志 / 裸取值项必须立刻退 78,且 --write 仍被认作改写标志。
//
// 跑法:node --test scripts/acceptance/test/argv.test.mjs

import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
	inspectArgv,
	UNKNOWN_ARGV_EXIT,
	VERIFY_HOST_TREE_ARGV,
	PREPARE_HOST_MODULES_ARGV,
	MEASURE_DEPENDENCY_SURFACE_ARGV,
	RUN_MATRIX_ARGV,
} from '../lib/argv.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '..', '..', '..')
const VERIFY = resolve(HERE, '..', 'verify-host-tree.mjs')
const PREPARE = resolve(HERE, '..', 'prepare-host-modules.mjs')
const MEASURE = resolve(HERE, '..', 'measure-dependency-surface.mjs')
const MATRIX = resolve(HERE, '..', 'integration', 'run-matrix.mjs')
const HOST_TREE_BASELINE = join(HERE, '..', 'host-tree-digests.json')
const SURFACE_BASELINE = join(HERE, '..', 'dependency-surface.json')

test('未知 --flag → unknown,消息点名该 token', () => {
	const r = inspectArgv(['--foo'], { flags: ['write'], opts: ['json'], allowPositionals: false })
	assert.equal(r.ok, false)
	assert.equal(r.kind, 'unknown')
	assert.equal(r.token, '--foo')
	assert.match(r.message, /--foo/)
})

test('只允许 --name=value 时,裸 --name → bare-opt,退同一类 78', () => {
	const r = inspectArgv(['--prefix'], { flags: ['check'], opts: ['prefix'], allowPositionals: false })
	assert.equal(r.ok, false)
	assert.equal(r.kind, 'bare-opt')
	assert.equal(r.token, '--prefix')
	assert.match(r.message, /需要显式值/)
	assert.match(r.message, /--prefix=<值>/)
})

test('空 --name= 与裸标志同类,拒绝', () => {
	const r = inspectArgv(['--json='], { flags: [], opts: ['json'], allowPositionals: false })
	assert.equal(r.ok, false)
	assert.equal(r.kind, 'empty-opt')
	assert.equal(r.token, '--json=')
})

test('位置参数默认不当未知;脚本声明没有位置参数时才拒', () => {
	assert.equal(inspectArgv(['host-deps'], { flags: ['check'] }).ok, true)
	const refused = inspectArgv(['host-deps'], { flags: ['check'], allowPositionals: false })
	assert.equal(refused.ok, false)
	assert.equal(refused.kind, 'positional')
	assert.equal(refused.token, 'host-deps')
})

test('verify-host-tree 的 --write 是已知裸标志,不被误伤', () => {
	const r = inspectArgv(['--write'], VERIFY_HOST_TREE_ARGV)
	assert.equal(r.ok, true, '--write 必须继续被认作故意的改写标志')
	assert.equal(inspectArgv(['--write', '--json=/tmp/report.json', '--repo-root=/tmp/x'], VERIFY_HOST_TREE_ARGV).ok, true)
})

test('verify-host-tree:--print / --write-floors / --write= 空值 / 未知 --foo 一律拒绝', () => {
	for (const token of ['--print', '--write-floors', '--write=', '--foo']) {
		const r = inspectArgv([token], VERIFY_HOST_TREE_ARGV)
		assert.equal(r.ok, false, `${token} 必须被拒`)
		assert.equal(r.token, token)
		assert.match(r.message, new RegExp(token.replace(/[?=]/g, '\\$&')))
	}
	assert.equal(inspectArgv(['--repo-root'], VERIFY_HOST_TREE_ARGV).kind, 'bare-opt')
})

test('prepare-host-modules:裸 --out / --prefix 拒绝;已知标志与可重复 --allow-write-root= 放行', () => {
	assert.equal(inspectArgv(['--out'], PREPARE_HOST_MODULES_ARGV).ok, false)
	assert.equal(inspectArgv(['--out'], PREPARE_HOST_MODULES_ARGV).kind, 'unknown')
	assert.equal(inspectArgv(['--prefix'], PREPARE_HOST_MODULES_ARGV).kind, 'bare-opt')
	assert.equal(inspectArgv([
		'--check', '--link', '--offline', '--strict-pins', '--strict-graph',
		'--copy-from=/tmp/a', '--prefix=/tmp/b',
		'--allow-write-root=/tmp/c', '--allow-write-root=/tmp/d',
	], PREPARE_HOST_MODULES_ARGV).ok, true)
})

function spawnScript(script, args) {
	return spawnSync(process.execPath, [script, ...args], {
		cwd: REPO_ROOT,
		encoding: 'utf8',
		timeout: 10_000,
		env: { ...process.env },
	})
}

test('spawn verify-host-tree --print:立刻退 78,点名 --print,不动 tracked 基准', () => {
	assert.ok(existsSync(HOST_TREE_BASELINE), '前提:tracked 基准应存在')
	const before = readFileSync(HOST_TREE_BASELINE)
	const r = spawnScript(VERIFY, ['--print'])
	assert.equal(r.status, UNKNOWN_ARGV_EXIT, `实际 ${r.status}\n${r.stderr}\n${r.stdout}`)
	assert.match(r.stderr, /无法识别的参数:--print/)
	assert.ok(!/已写入基准|内容与基准一致/.test(r.stdout),
		`应在任何校验/写入之前退出,实际 stdout:${r.stdout.slice(0, 200)}`)
	assert.deepEqual(readFileSync(HOST_TREE_BASELINE), before, 'host-tree-digests.json 必须一字未动')
})

test('spawn verify-host-tree --write --print:拒的是 --print,证明 --write 已被识别且未写盘', () => {
	const before = readFileSync(HOST_TREE_BASELINE)
	const r = spawnScript(VERIFY, ['--write', '--print'])
	assert.equal(r.status, UNKNOWN_ARGV_EXIT, `实际 ${r.status}\n${r.stderr}`)
	assert.match(r.stderr, /无法识别的参数:--print/)
	assert.doesNotMatch(r.stderr, /无法识别的参数:--write/)
	assert.ok(!/已写入基准/.test(r.stdout), '不得走到 --write 写盘')
	assert.deepEqual(readFileSync(HOST_TREE_BASELINE), before)
})

test('spawn prepare-host-modules 裸 --out / --prefix:立刻退 78,赶在任何写入之前', () => {
	for (const token of ['--out', '--prefix']) {
		const r = spawnScript(PREPARE, [token])
		assert.equal(r.status, UNKNOWN_ARGV_EXIT, `${token}:实际 ${r.status}\n${r.stderr}\n${r.stdout}`)
		assert.match(r.stderr, new RegExp(token), `${token} 必须被点名`)
		assert.ok(!/依赖面|安装根|真实路径守卫/.test(r.stdout + r.stderr),
			`${token} 应在读清单/守卫/安装之前退出`)
	}
})

test('measure-dependency-surface:--print / 裸 --out 拒绝;--no-shield 与 --out= 放行', () => {
	const print = inspectArgv(['--print'], MEASURE_DEPENDENCY_SURFACE_ARGV)
	assert.equal(print.ok, false)
	assert.equal(print.kind, 'unknown')
	assert.equal(print.token, '--print')
	assert.match(print.message, /无法识别的参数:--print/)

	const bareOut = inspectArgv(['--out'], MEASURE_DEPENDENCY_SURFACE_ARGV)
	assert.equal(bareOut.ok, false)
	assert.equal(bareOut.kind, 'bare-opt')
	assert.equal(bareOut.token, '--out')

	assert.equal(inspectArgv(['--no-shield'], MEASURE_DEPENDENCY_SURFACE_ARGV).ok, true)
	assert.equal(inspectArgv(['--out=/tmp/x.json', '--plugin=dsh-agos', '--logdir=/tmp/l', '--no-shield'], MEASURE_DEPENDENCY_SURFACE_ARGV).ok, true)
})

test('spawn measure-dependency-surface --print:立刻退 78,点名 --print,不动 tracked 基线', () => {
	assert.ok(existsSync(SURFACE_BASELINE), '前提:tracked 依赖面基线应存在')
	const before = readFileSync(SURFACE_BASELINE)
	const r = spawnScript(MEASURE, ['--print'])
	assert.equal(r.status, UNKNOWN_ARGV_EXIT, `实际 ${r.status}\n${r.stderr}\n${r.stdout}`)
	assert.match(r.stderr, /无法识别的参数:--print/)
	assert.ok(!/dependency surface:/.test(r.stdout),
		`应在任何测量/写盘之前退出,实际 stdout:${r.stdout.slice(0, 200)}`)
	assert.deepEqual(readFileSync(SURFACE_BASELINE), before, 'dependency-surface.json 必须一字未动')
})

test('spawn measure-dependency-surface 裸 --out:立刻退 78,不动 tracked 基线', () => {
	const before = readFileSync(SURFACE_BASELINE)
	const r = spawnScript(MEASURE, ['--out'])
	assert.equal(r.status, UNKNOWN_ARGV_EXIT, `实际 ${r.status}\n${r.stderr}\n${r.stdout}`)
	assert.match(r.stderr, /--out/)
	assert.deepEqual(readFileSync(SURFACE_BASELINE), before)
})

test('run-matrix:--print 拒绝;--print-plan 与含 = 的 --layer-producer= 放行', () => {
	const print = inspectArgv(['--print'], RUN_MATRIX_ARGV)
	assert.equal(print.ok, false)
	assert.equal(print.kind, 'unknown')
	assert.equal(print.token, '--print')
	assert.match(print.message, /无法识别的参数:--print/)

	assert.equal(inspectArgv(['--print-plan'], RUN_MATRIX_ARGV).ok, true,
		'--print-plan 是已知裸标志,不能被误伤成 --print')
	assert.equal(inspectArgv([
		'--all', '--allow-existing-logdir',
		'--only=swarm', '--require=code-gate', '--skip=linux',
		'--logdir=/tmp/m', '--json=/tmp/m.json',
		'--layer-producer=swarm=/tmp/x.mjs',
		'--layer-argv=linux=["node"]',
		'--layer-timeout=swarm=1500',
		'--code-gate-argv=["node"]',
		'--code-gate-extra=["--no-advisory"]',
		'--candidates-root=/tmp/root',
	], RUN_MATRIX_ARGV).ok, true)
})

test('spawn run-matrix --print:立刻退 78,一层都不拉起,不写 matrix.json', () => {
	const t0 = Date.now()
	const r = spawnScript(MATRIX, ['--print'])
	const elapsedMs = Date.now() - t0
	assert.equal(r.status, UNKNOWN_ARGV_EXIT, `实际 ${r.status}\n${r.stderr}\n${r.stdout}`)
	assert.match(r.stderr, /无法识别的参数:--print/)
	assert.ok(!/汇总|PLAN-ONLY|▸ code-gate|已覆盖/.test(r.stdout),
		`未知 --print 不得进入计划打印或层采集,实际 stdout:${r.stdout.slice(0, 300)}`)
	assert.ok(elapsedMs < 3000, `--print 若拉起 code-gate 就不会在 ${elapsedMs}ms 内退`)
})
