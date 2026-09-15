#!/usr/bin/env node
/**
 * `run-acceptance.mjs` 的负控替身,只用于驱动矩阵**采集代码门结果**那段逻辑。
 *
 * 存在的理由:真验收器要跑一千多个测试,分钟级;而这里要验的是矩阵怎么**读**它的自述,
 * 尤其是 `authoritative` 标志 —— 真验收器的 `--plan=<假计划>` 就能造出
 * 「退出码 0 + codeGate.green=true + authoritative=false」这种运行,一个只看退出码的
 * 采集器会把它当成代码门通过。这个替身把那种输出原样复现出来,让负例能秒级跑完。
 *
 * 输出严格是 `agos-acceptance/results@1` 的形状(字段名逐个对齐真验收器的 `out` 对象)。
 */
import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { sha256File } from '../../lib/evidence.mjs'

const args = process.argv.slice(2)
const opt = (n, d) => { const h = args.find((a) => a.startsWith(`--${n}=`)); return h ? h.slice(n.length + 3) : d }
const mode = opt('mode', 'authoritative-green')
const jsonOut = opt('json', null)
const logDir = opt('logdir', join(process.cwd(), 'fake-acceptance-logs'))

console.log(`== 假验收器(mode=${mode})==`)

function gateLog(id, body) {
	mkdirSync(logDir, { recursive: true })
	const p = join(logDir, `${id}.txt`)
	writeFileSync(p, body)
	return { log: p, logSha256: sha256File(p) }
}

function results({ authoritative, syntheticSeams, green, totals, failedGates = [], suites = [], exitCode }) {
	return {
		schema: 'agos-acceptance/results@1',
		generatedAt: new Date().toISOString(),
		repoRoot: process.cwd(),
		gitHead: 'fake-head',
		gitDirty: 0,
		authoritative,
		syntheticSeams,
		requiredPlugins: ['dsh-agos'],
		environment: { node: process.version, platform: process.platform },
		codeGate: { exitCode, green, totals, failedGates, suites },
		advisory: { note: '假的', results: [] },
		processExitCode: exitCode,
	}
}

function emit(payload, exitCode) {
	if (jsonOut !== null) {
		mkdirSync(join(jsonOut, '..'), { recursive: true })
		writeFileSync(jsonOut, JSON.stringify(payload, null, 2) + '\n')
	}
	console.log(`   假验收器退出码 = ${exitCode}`)
	process.exit(exitCode)
}

const greenTotals = { tests: 12, pass: 11, fail: 0, skipped: 1, cancelled: 0, todo: 0 }

switch (mode) {
	case 'authoritative-green': {
		const g = gateLog('dsh-agos', 'ℹ pass 11\nℹ fail 0\n')
		emit(results({
			authoritative: true, syntheticSeams: null, green: true, totals: greenTotals, exitCode: 0,
			suites: [{ id: 'dsh-agos', verdict: 'pass', ...g }],
		}), 0)
		break
	}
	// 核心负例:验收器自己说这次运行不权威,但退出码是 0、codeGate.green 是 true。
	case 'non-authoritative-green': {
		const g = gateLog('dsh-agos', 'ℹ pass 11\nℹ fail 0\n')
		emit(results({
			authoritative: false,
			syntheticSeams: { plan: '/tmp/fake-plan.json', requiredPlugins: null, pluginsRoot: null, selftestFile: null, surface: null, hostIntegrations: null, selftestSentinel: false },
			green: true, totals: greenTotals, exitCode: 0,
			suites: [{ id: 'fake-gate', verdict: 'pass', ...g }],
		}), 0)
		break
	}
	// 同族:`--floors=none` 也让 authoritative=false,但 syntheticSeams 是 null。
	case 'floors-none-green': {
		const g = gateLog('dsh-agos', 'ℹ pass 11\nℹ fail 0\n')
		emit(results({
			authoritative: false, syntheticSeams: null, green: true, totals: greenTotals, exitCode: 0,
			suites: [{ id: 'dsh-agos', verdict: 'pass', ...g }],
		}), 0)
		break
	}
	case 'red': {
		const g = gateLog('dsh-agos', 'ℹ pass 3\nℹ fail 2\n')
		emit(results({
			authoritative: true, syntheticSeams: null, green: false,
			totals: { tests: 5, pass: 3, fail: 2, skipped: 0, cancelled: 0, todo: 0 }, exitCode: 1,
			failedGates: [{ id: 'dsh-agos', verdict: 'fail', reason: 'reported-failures:2', exitCode: 1 }],
			suites: [{ id: 'dsh-agos', verdict: 'fail', ...g }],
		}), 1)
		break
	}
	case 'zero-tests': {
		const g = gateLog('dsh-agos', '(没有摘要)\n')
		emit(results({
			authoritative: true, syntheticSeams: null, green: true,
			totals: { tests: 0, pass: 0, fail: 0, skipped: 0, cancelled: 0, todo: 0 }, exitCode: 0,
			suites: [{ id: 'dsh-agos', verdict: 'pass', ...g }],
		}), 0)
		break
	}
	case 'missing-suite-logsha': {
		const g = gateLog('dsh-agos', 'ℹ pass 1\n')
		emit(results({ authoritative: true, syntheticSeams: null, green: true,
			totals: { tests: 1, pass: 1, fail: 0, skipped: 0, cancelled: 0, todo: 0 }, exitCode: 0,
			suites: [{ id: 'dsh-agos', verdict: 'pass', log: g.log }] }), 0)
		break
	}
	case 'invalid-suite-logsha': {
		const g = gateLog('dsh-agos', 'ℹ pass 1\n')
		emit(results({ authoritative: true, syntheticSeams: null, green: true,
			totals: { tests: 1, pass: 1, fail: 0, skipped: 0, cancelled: 0, todo: 0 }, exitCode: 0,
			suites: [{ id: 'dsh-agos', verdict: 'pass', log: g.log, logSha256: 'bad' }] }), 0)
		break
	}
	case 'missing-tests': {
		const g = gateLog('dsh-agos', 'ℹ pass 1\n')
		emit(results({ authoritative: true, syntheticSeams: null, green: true,
			totals: { pass: 1, fail: 0, skipped: 0, cancelled: 0, todo: 0 }, exitCode: 0,
			suites: [{ id: 'dsh-agos', verdict: 'pass', ...g }] }), 0)
		break
	}
	case 'inconsistent-totals': {
		const g = gateLog('dsh-agos', 'ℹ pass 1\n')
		emit(results({ authoritative: true, syntheticSeams: null, green: true,
			totals: { tests: 0, pass: 1, fail: 0, skipped: 0, cancelled: 0, todo: 0 }, exitCode: 0,
			suites: [{ id: 'dsh-agos', verdict: 'pass', ...g }] }), 0)
		break
	}
	case 'green-with-fail': {
		const g = gateLog('dsh-agos', 'ℹ pass 1\nℹ fail 1\n')
		emit(results({ authoritative: true, syntheticSeams: null, green: true,
			totals: { tests: 2, pass: 1, fail: 1, skipped: 0, cancelled: 0 }, exitCode: 0,
			failedGates: [{ id: 'dsh-agos', verdict: 'fail', reason: 'reported-failures:1' }],
			suites: [{ id: 'dsh-agos', verdict: 'fail', ...g }] }), 0)
		break
	}
	case 'cancelled': {
		const g = gateLog('dsh-agos', 'ℹ pass 1\nℹ cancelled 1\n')
		emit(results({ authoritative: true, syntheticSeams: null, green: true,
			totals: { tests: 2, pass: 1, fail: 0, skipped: 0, cancelled: 1 }, exitCode: 0,
			suites: [{ id: 'dsh-agos', verdict: 'pass', ...g }] }), 0)
		break
	}
	case 'malformed-containers': {
		const payload = results({ authoritative: true, syntheticSeams: null, green: true,
			totals: greenTotals, exitCode: 0 })
		payload.codeGate.suites = [null]
		emit(payload, 0)
		break
	}
	case 'green-no-suites': {
		emit(results({ authoritative: true, syntheticSeams: null, green: true,
			totals: greenTotals, exitCode: 0, suites: [] }), 0)
		break
	}
	case 'no-json': {
		console.log('   退 0,但不写 JSON')
		process.exit(0)
		break
	}
	case 'empty-json': {
		mkdirSync(join(jsonOut, '..'), { recursive: true })
		writeFileSync(jsonOut, '')
		process.exit(0)
		break
	}
	case 'wrong-schema': {
		mkdirSync(join(jsonOut, '..'), { recursive: true })
		writeFileSync(jsonOut, JSON.stringify({ schema: 'something-else@9', codeGate: { green: true } }, null, 2))
		process.exit(0)
		break
	}
	// 代码门这一层的证据完整性:JSON 里记的 logSha256 与磁盘上的日志对不上。
	case 'tampered-gate-log': {
		const g = gateLog('dsh-agos', 'ℹ pass 11\nℹ fail 0\n')
		const payload = results({
			authoritative: true, syntheticSeams: null, green: true, totals: greenTotals, exitCode: 0,
			suites: [{ id: 'dsh-agos', verdict: 'pass', ...g }],
		})
		if (jsonOut !== null) {
			mkdirSync(join(jsonOut, '..'), { recursive: true })
			writeFileSync(jsonOut, JSON.stringify(payload, null, 2) + '\n')
		}
		appendFileSync(g.log, '写完 JSON 之后被改的一行\n')
		process.exit(0)
		break
	}
	case 'hang': {
		console.log('   假验收器挂住不动')
		setInterval(() => {}, 1000)
		break
	}
	default:
		console.error(`不认识的 --mode=${mode}`)
		process.exit(2)
}
