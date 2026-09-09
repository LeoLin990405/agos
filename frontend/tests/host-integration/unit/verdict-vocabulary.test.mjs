// 场景判定词汇:pass / fail / blocked / skipped 四种结局互不冒充。
//
// 为什么需要这份:上一轮 run.mjs 只有 pass 与 fail 两种结局,于是 scenario 8 在
// turn-evidence 路由 404(live.ts 按设计吞掉)时,那条证据条断言被
// `if (await strip.count() > 0)` 静默跳过,而场景凭其余判定报 PASS ——
// 报告因此声称「历史证据隔离已验」,而那次运行根本没挂证据插件。
// 一个能把「什么都没观测到」说成「已验证」的汇总口径,必须自己有负例守着。
//
// 这里不起真宿主:直接驱动 runner 的判定逻辑(以子进程跑一份注入了假 harness 与
// 假场景的 runner),断言四种结局与「未覆盖层」如实进汇总。

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const RUNNER = fileURLToPath(new URL('../run.mjs', import.meta.url))
const made = []
test.after(() => { for (const d of made) { try { rmSync(d, { recursive: true, force: true }) } catch {} } })

/**
 * 跑一份 runner,但把 harness 与 scenarios 换成注入的假件。
 * 用 --import 挂一个 loader hook 做模块替换,runner 源码一个字不改。
 */
function runScenarios(label, scenarioSource) {
	const dir = mkdtempSync(join(tmpdir(), `agos-verdict-${label}-`))
	made.push(dir)
	const artifacts = join(dir, 'artifacts')

	writeFileSync(join(dir, 'fake-scenarios.mjs'), scenarioSource)
	writeFileSync(join(dir, 'fake-harness.mjs'), `
export async function createHarness() {
	return {
		log() {},
		async resetPage() {},
		async screenshot(name) { return name + '.png' },
		async dispose() { return 0 },
		plugins: { requested: [], status: async () => [], loaded: async () => [] },
	}
}
`)
	// host-env 的 ARTIFACT_DIR 与 redact 也要可控:写到临时目录,脱敏保持真实实现。
	writeFileSync(join(dir, 'fake-host-env.mjs'), `
export const ARTIFACT_DIR = ${JSON.stringify(artifacts)}
export { redact } from ${JSON.stringify(fileURLToPath(new URL('../../../scripts/host-integration/host-env.mjs', import.meta.url)))}
`)
	writeFileSync(join(dir, 'hook.mjs'), `
import { register } from 'node:module'
import { pathToFileURL } from 'node:url'
register(pathToFileURL(${JSON.stringify(join(dir, 'resolver.mjs'))}))
`)
	writeFileSync(join(dir, 'resolver.mjs'), `
const MAP = {
	'./harness.mjs': ${JSON.stringify(join(dir, 'fake-harness.mjs'))},
	'./scenarios.mjs': ${JSON.stringify(join(dir, 'fake-scenarios.mjs'))},
	'../../scripts/host-integration/host-env.mjs': ${JSON.stringify(join(dir, 'fake-host-env.mjs'))},
}
export function resolve(specifier, context, next) {
	if (MAP[specifier] !== undefined) return next(MAP[specifier], context)
	return next(specifier, context)
}
`)
	// 产物目录要先存在(runner 只写文件,不建目录)
	spawnSync(process.execPath, ['-e', `require('node:fs').mkdirSync(${JSON.stringify(artifacts)},{recursive:true})`])

	const res = spawnSync(process.execPath, ['--import', join(dir, 'hook.mjs'), RUNNER], {
		encoding: 'utf8', timeout: 120_000, env: { ...process.env },
	})
	const file = join(artifacts, 'results.json')
	return {
		code: res.status,
		out: (res.stdout ?? '') + (res.stderr ?? ''),
		summary: existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : undefined,
	}
}

const scenario = (id, body) => `
	{
		id: ${JSON.stringify(id)},
		title: ${JSON.stringify(id)},
		exercises: { host: 'real', browser: 'real', transport: 'real', store: 'real' },
		async run(ctx) { ${body} },
	}`

const suite = (...bodies) => `export const scenarios = [${bodies.join(',')}\n]\n`

test('blocked 是独立结局:既不计入 passed,也不让退出码变红', () => {
	const r = runScenarios('blocked', suite(
		scenario('s-ok', `ctx.record(true, 'fine')`),
		scenario('s-blocked', `
			ctx.record(true, '其余判定成立');
			ctx.blocked('本跳证据条', '插件未在运行中的宿主上应答')`),
	))

	assert.equal(r.summary.passed, 1, 'blocked 不能算进 passed')
	assert.equal(r.summary.blocked, 1)
	assert.equal(r.summary.failed, 0)
	const s = r.summary.results.find((x) => x.id === 's-blocked')
	assert.equal(s.status, 'blocked', '有 block 的场景整体判 blocked,哪怕其余判定都过')
	assert.deepEqual(s.blocked, [{ layer: '本跳证据条', reason: '插件未在运行中的宿主上应答' }])
	// 未覆盖的层必须点名进汇总,否则读者无从得知缺了什么。
	assert.deepEqual(r.summary.uncoveredLayers, ['s-blocked: 本跳证据条'])
	assert.match(r.out, /1 passed, 0 failed, 1 blocked/)
	assert.match(r.out, /BLOCKED\s+s-blocked/)
	assert.match(r.out, /未覆盖的层/)
	assert.equal(r.code, 0, 'blocked 不是失败,退出码不因它变红')
})

test('真失败压过 blocked:断言坏了不叫「未覆盖」', () => {
	const r = runScenarios('failwins', suite(
		scenario('s-both', `
			ctx.record(false, '这条判定真的坏了');
			ctx.blocked('某层', '顺便还有一层没覆盖')`),
	))
	const s = r.summary.results[0]
	assert.equal(s.status, 'fail', '有失败判定时必须报 fail,不能被 blocked 盖住')
	assert.equal(r.summary.blocked, 0)
	assert.equal(r.summary.failed, 1)
	// 未覆盖的层照旧点名 —— 失败与未覆盖可以同时成立。
	assert.deepEqual(r.summary.uncoveredLayers, ['s-both: 某层'])
	assert.equal(r.code, 1)
})

test('只 block、一条判定都没有 → 仍是 blocked,不因「无判定」被判 fail', () => {
	const r = runScenarios('onlyblock', suite(
		scenario('s-nothing', `ctx.blocked('整层', '这台机器上根本到不了')`),
	))
	assert.equal(r.summary.results[0].status, 'blocked')
	assert.equal(r.summary.blocked, 1)
	assert.equal(r.summary.failed, 0)
})

test('既无判定也无 block → fail(空场景不许静默通过)', () => {
	const r = runScenarios('empty', suite(scenario('s-void', `return undefined`)))
	assert.equal(r.summary.results[0].status, 'fail')
	assert.match(r.summary.results[0].error, /recorded no checks/)
	assert.equal(r.code, 1)
})

test('抛错的场景是 fail,并且 blocked 计数不被污染', () => {
	const r = runScenarios('throw', suite(
		scenario('s-throw', `ctx.blocked('先记一层', '理由'); throw new Error('boom')`),
	))
	const s = r.summary.results[0]
	assert.equal(s.status, 'fail')
	assert.match(s.error, /boom/)
	assert.equal(r.summary.blocked, 0, '抛错场景不能同时被计成 blocked')
})

test('四种计数之和覆盖全部被选场景(选了就必须有结局)', () => {
	const r = runScenarios('reconcile', suite(
		scenario('a', `ctx.record(true, 'ok')`),
		scenario('b', `ctx.record(false, 'bad')`),
		scenario('c', `ctx.blocked('层', '理由')`),
	))
	const { passed, failed, blocked, skipped, selected, results } = r.summary
	assert.equal(passed + failed + blocked + skipped, selected.length,
		`四种结局之和必须等于被选场景数:${passed}+${failed}+${blocked}+${skipped} vs ${selected.length}`)
	assert.equal(results.length, selected.length)
})

test('汇总里的 blocked 理由经过脱敏(不把凭据写进产物)', () => {
	const r = runScenarios('redact', suite(
		scenario('s-secret', `
			ctx.record(true, 'ok');
			ctx.blocked('某层', 'token=sk-abcdefghijklmnopqrstuvwxyz0123456789 未生效')`),
	))
	const reason = r.summary.results[0].blocked[0].reason
	assert.doesNotMatch(reason, /sk-abcdefghijklmnopqrstuvwxyz/, 'blocked 理由必须走同一套脱敏')
	assert.match(reason, /某层|未生效/, '脱敏不该把可读信息全吃掉')
})
