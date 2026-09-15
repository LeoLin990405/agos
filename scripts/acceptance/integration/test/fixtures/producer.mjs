#!/usr/bin/env node
/**
 * 负控用的集成层入口桩。**只服务于 run-matrix 的入口自检**,不代表任何真实集成。
 *
 * 每种 `--mode=` 是一种真实的坏法(或正控),由真子进程演出来 —— 矩阵的五条负例都要求
 * 「真子进程负例,不是读源码论证」,所以这里没有任何 mock:退非零就是真的退非零,
 * 超时就是真的把自己挂住,篡改日志就是真的在写完结果之后再动那个文件。
 *
 * 用法(矩阵会自己拼前三个参数):
 *   node producer.mjs --mode=<mode> --layer=<layer> --out=<file.json> --logdir=<dir>
 */
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { REPO_ROOT } from '../../../lib/exec.mjs'
import { buildLayerResult, writeLayerResult } from '../../lib/layer-result.mjs'
import { sha256File } from '../../lib/evidence.mjs'
import { trackedWorktreeDigest, worktreeDigest } from '../../lib/worktree.mjs'

const args = process.argv.slice(2)
const opt = (n, d) => { const h = args.find((a) => a.startsWith(`--${n}=`)); return h ? h.slice(n.length + 3) : d }
const mode = opt('mode', 'ok')
const layer = opt('layer', 'swarm')
const out = opt('out', null)
const logdir = opt('logdir', null)
if (out === null || logdir === null) {
	console.error('桩需要 --out= 与 --logdir=')
	process.exit(2)
}

const wt = worktreeDigest(REPO_ROOT)
const startedAt = new Date().toISOString()

/** 真写一份日志,返回 `{path, sha256}`(哈希实测,不是编的)。 */
function writeLog(name, body) {
	mkdirSync(logdir, { recursive: true })
	const p = join(logdir, name)
	writeFileSync(p, body)
	return { path: p, sha256: sha256File(p) }
}

function base(fields) {
	return buildLayerResult({
		layer,
		sourceCommit: wt.head ?? 'unavailable',
		worktreeDigest: wt.digest,
		command: ['node', 'fixtures/producer.mjs', `--mode=${mode}`],
		startedAt,
		endedAt: new Date().toISOString(),
		exitCode: 0,
		moduleProvenance: [{
			specifier: 'fixtures/producer.mjs', resolvedPath: 'scripts/acceptance/integration/test/fixtures/producer.mjs',
			version: null, sha256: sha256File(new URL(import.meta.url).pathname), origin: 'local-build',
			originNote: '入口自检桩,不是真实模块来源',
		}],
		...fields,
	})
}

switch (mode) {
	// ---- 正控:一份合格的结果 ----
	case 'ok': {
		const log = writeLog(`${layer}-ok.log`, `桩:${layer} 三条检查全过\n`)
		writeLayerResult(out, base({ verdict: 'pass', counts: { pass: 3, fail: 0, skip: 0, blocked: 0 }, logs: [log] }))
		process.exit(0)
		break
	}
	case 'ok-with-skip': {
		const log = writeLog(`${layer}-skip.log`, `桩:${layer} 两过一跳\n`)
		writeLayerResult(out, base({ verdict: 'pass', counts: { pass: 2, fail: 0, skip: 1, blocked: 0 }, logs: [log] }))
		process.exit(0)
		break
	}

	// ---- 负例 1:子检查非零退出 ----
	case 'nonzero': {
		console.error('桩:内部检查失败,退 3,不写结果')
		process.exit(3)
		break
	}
	case 'pass-nonzero': {
		const log = writeLog(`${layer}-lie.log`, '桩:自称全过,但进程退 3\n')
		writeLayerResult(out, base({ verdict: 'pass', counts: { pass: 5, fail: 0, skip: 0, blocked: 0 }, logs: [log] }))
		process.exit(3)
		break
	}

	// ---- 负例 2:超时 ----
	case 'hang': {
		console.log('桩:开始一件永远做不完的事')
		setInterval(() => {}, 1000)
		break
	}

	// ---- 负例 3:结果缺失 / 为空 / 字段缺失 ----
	case 'no-result': {
		console.log('桩:退 0,但一个字都不写')
		process.exit(0)
		break
	}
	case 'empty-result': {
		mkdirSync(logdir, { recursive: true })
		writeFileSync(out, '')
		process.exit(0)
		break
	}
	case 'whitespace-result': {
		mkdirSync(logdir, { recursive: true })
		writeFileSync(out, '   \n\n')
		process.exit(0)
		break
	}
	case 'bad-json': {
		mkdirSync(logdir, { recursive: true })
		writeFileSync(out, '{"schema": "agos-acceptance/integration-layer@1", ')
		process.exit(0)
		break
	}
	case 'missing-fields': {
		mkdirSync(logdir, { recursive: true })
		writeFileSync(out, JSON.stringify({ schema: 'agos-acceptance/integration-layer@1', layer, verdict: 'pass' }, null, 2))
		process.exit(0)
		break
	}
	case 'command-as-string': {
		const log = writeLog(`${layer}-cmd.log`, '桩:command 写成了拼好的字符串\n')
		const r = base({ verdict: 'pass', counts: { pass: 1, fail: 0, skip: 0, blocked: 0 }, logs: [log] })
		r.command = 'node fixtures/producer.mjs --mode=command-as-string'
		writeFileSync(out, JSON.stringify(r, null, 2))
		process.exit(0)
		break
	}

	// ---- 负例 4:blocked ----
	case 'blocked': {
		const log = writeLog(`${layer}-blocked.log`, '桩:前置条件不在\n')
		writeLayerResult(out, base({
			verdict: 'blocked',
			counts: { pass: 0, fail: 0, skip: 0, blocked: 1 },
			blockedReason: `桩:${layer} 层需要的运行时在本机不存在(探测过 docker/podman/lima,均无可执行文件),因此本层未被触达`,
			recoveryCommand: ['node', 'scripts/acceptance/integration/run-matrix.mjs', `--require=${layer}`],
			logs: [log],
			exitCode: 78,
		}))
		process.exit(78)
		break
	}
	case 'blocked-vague': {
		const log = writeLog(`${layer}-vague.log`, '桩:含糊的阻塞原因\n')
		writeLayerResult(out, base({
			verdict: 'blocked',
			counts: { pass: 0, fail: 0, skip: 0, blocked: 1 },
			blockedReason: '环境不支持',
			logs: [log],
		}))
		process.exit(0)
		break
	}

	// ---- 负例 5:日志哈希对不上 ----
	case 'tamper-log': {
		const log = writeLog(`${layer}-tamper.log`, '桩:原始日志内容\n')
		writeLayerResult(out, base({ verdict: 'pass', counts: { pass: 4, fail: 0, skip: 0, blocked: 0 }, logs: [log] }))
		// 结果写完之后再动日志:结果 JSON 完好无损,而它指向的证据已经不是被判定的那一份。
		appendFileSync(log.path, '桩:结果写完之后被追加的一行\n')
		process.exit(0)
		break
	}
	case 'log-missing': {
		writeLayerResult(out, base({
			verdict: 'pass', counts: { pass: 4, fail: 0, skip: 0, blocked: 0 },
			logs: [{ path: join(logdir, `${layer}-never-written.log`), sha256: 'a'.repeat(64) }],
		}))
		process.exit(0)
		break
	}
	case 'hand-written-hash': {
		const log = writeLog(`${layer}-hand.log`, '桩:哈希是手填的\n')
		writeLayerResult(out, base({
			verdict: 'pass', counts: { pass: 4, fail: 0, skip: 0, blocked: 0 },
			logs: [{ path: log.path, sha256: '0'.repeat(64) }],
		}))
		process.exit(0)
		break
	}

	// ---- 自相矛盾的自述 ----
	case 'pass-zero-counts': {
		const log = writeLog(`${layer}-zero.log`, '桩:自称 pass,一条都没真过\n')
		writeLayerResult(out, base({ verdict: 'pass', counts: { pass: 0, fail: 0, skip: 7, blocked: 0 }, logs: [log] }))
		process.exit(0)
		break
	}
	case 'pass-with-blocked': {
		const log = writeLog(`${layer}-mix.log`, '桩:自称 pass,但有 blocked\n')
		writeLayerResult(out, base({ verdict: 'pass', counts: { pass: 6, fail: 0, skip: 0, blocked: 2 }, logs: [log] }))
		process.exit(0)
		break
	}
	case 'pass-with-fail': {
		const log = writeLog(`${layer}-mix2.log`, '桩:自称 pass,但有 fail\n')
		writeLayerResult(out, base({ verdict: 'pass', counts: { pass: 6, fail: 1, skip: 0, blocked: 0 }, logs: [log] }))
		process.exit(0)
		break
	}

	// ---- 树身份对不上 ----
	case 'stale-commit': {
		const log = writeLog(`${layer}-stale.log`, '桩:量的是另一个提交\n')
		const r = base({ verdict: 'pass', counts: { pass: 3, fail: 0, skip: 0, blocked: 0 }, logs: [log] })
		r.sourceCommit = '0123456789abcdef0123456789abcdef01234567'
		writeFileSync(out, JSON.stringify(r, null, 2))
		process.exit(0)
		break
	}
	case 'stale-worktree': {
		const log = writeLog(`${layer}-stale2.log`, '桩:量的是另一棵工作树\n')
		const r = base({ verdict: 'pass', counts: { pass: 3, fail: 0, skip: 0, blocked: 0 }, logs: [log] })
		r.worktreeDigest = 'f'.repeat(64)
		writeFileSync(out, JSON.stringify(r, null, 2))
		process.exit(0)
		break
	}
	case 'tracked-digest': {
		// 正控:生产者按契约口径(只哈希 tracked)报摘要。本仓几乎总是脏的、还有未跟踪文件,
		// 矩阵自己的 porcelain 摘要与它不相等 —— 修之前这会被误杀成 stale-layer-result。
		const log = writeLog(`${layer}-tracked.log`, '桩:用 tracked 口径报摘要\n')
		const r = base({ verdict: 'pass', counts: { pass: 3, fail: 0, skip: 0, blocked: 0 }, logs: [log] })
		r.worktreeDigest = trackedWorktreeDigest(REPO_ROOT).digest
		writeFileSync(out, JSON.stringify(r, null, 2))
		process.exit(0)
		break
	}
	case 'wrong-layer': {
		const log = writeLog(`${layer}-wrong.log`, '桩:结果自称是另一层\n')
		const r = base({ verdict: 'pass', counts: { pass: 3, fail: 0, skip: 0, blocked: 0 }, logs: [log] })
		r.layer = layer === 'swarm' ? 'linux' : 'swarm'
		writeFileSync(out, JSON.stringify(r, null, 2))
		process.exit(0)
		break
	}

	default:
		console.error(`桩:不认识的 --mode=${mode}`)
		process.exit(2)
}
