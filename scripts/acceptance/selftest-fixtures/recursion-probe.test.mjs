#!/usr/bin/env node
// 防递归探针:站在「自检」的位置上,真的把验收器再 spawn 一遍,用来**实测**递归本身。
//
// 为什么要这个东西:正式门的默认计划里含自检(缺陷 3 的修法),而自检的每条负控都会把
// 验收器当子进程跑。子验收器若再把自检放进默认计划,就是无限递归。防递归靠哨兵
// AGOS_ACCEPTANCE_SELFTEST=1。光断言「计划里没有 selftest 这一项」证明不了递归会不会发生,
// 所以这里换成真实的分层 spawn,并数层数:
//
//   AGOS_RECURSION_PROBE_SENTINEL=0 → 本探针 spawn 验收器时**不带**哨兵
//                                     → 子验收器的默认计划又把本探针当自检跑 → 层数会涨
//   AGOS_RECURSION_PROBE_SENTINEL=1 → 带哨兵 → 子验收器不把自检放进计划 → 停在第 1 层
//
// AGOS_RECURSION_PROBE_MAX 是硬上限:即使真发生递归也不会跑飞(默认 3 层就停)。
// 每一层把自己的深度追加进 AGOS_RECURSION_PROBE_LOG,由 selftest.mjs 的 NC16 数行数。
//
// 本文件被验收器当作 `--selftest-file` 传入,所以它必须是个合法的 node --test 文件。
import test from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

test('recursion-probe: 记录本层深度,再按开关决定带不带哨兵去 spawn 验收器', () => {
	const log = process.env.AGOS_RECURSION_PROBE_LOG
	assert.ok(log, '探针必须拿到 AGOS_RECURSION_PROBE_LOG')
	const depth = Number(process.env.AGOS_RECURSION_PROBE_DEPTH ?? '0') + 1
	appendFileSync(log, `depth=${depth}\n`)

	const max = Number(process.env.AGOS_RECURSION_PROBE_MAX ?? '3')
	if (depth >= max) return   // 硬上限:真递归也不会跑飞

	const env = { ...process.env, AGOS_RECURSION_PROBE_DEPTH: String(depth) }
	// 与真自检同一套卫生:别把 node --test 的上下文传给验收器。
	delete env.NODE_TEST_CONTEXT
	delete env.NODE_OPTIONS
	if (process.env.AGOS_RECURSION_PROBE_SENTINEL === '1') env.AGOS_ACCEPTANCE_SELFTEST = '1'
	else delete env.AGOS_ACCEPTANCE_SELFTEST

	const argv = JSON.parse(process.env.AGOS_RECURSION_PROBE_ARGV)
	const r = spawnSync(process.execPath, [process.env.AGOS_RECURSION_PROBE_RUNNER, ...argv], {
		cwd: process.env.AGOS_RECURSION_PROBE_CWD,
		encoding: 'utf8',
		timeout: 180000,
		env,
	})
	assert.notEqual(r.status, null, `验收器必须真的跑起来(spawn 错误: ${r.error?.message ?? '无'})`)
})
