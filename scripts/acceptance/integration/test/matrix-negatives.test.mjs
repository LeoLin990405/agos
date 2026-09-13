/**
 * 矩阵负控:证明这个入口**没法**谎报「全部验证通过」。
 *
 * 每一条都是真子进程 —— 桩真的退非零、真的把自己挂住、真的在写完结果之后篡改日志。
 * 断言不看"源码里有这么一行",只看矩阵的真实退出码与它写出的 JSON 结论。
 *
 * 编号:
 *   N1 子检查非零退出        N2 超时              N3 结果缺失/为空/字段缺失
 *   N4 被要求的层 blocked     N5 日志哈希不匹配     N6 代码门 authoritative=false
 *   S  汇总语义(代码结论与集成覆盖分开报)         G 入口自身的护栏
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { FAKE_ACCEPTANCE, PRODUCER, hasRefusal, runMatrix, runWithFakeAcceptance, runWithProducer, tempRoot } from './helpers.mjs'

/** 所有负例共有的底线:退出码非 0,且两句话都不能说。 */
function assertRefusesToClaimSuccess(r, note) {
	assert.notEqual(r.exitCode, 0, `${note}: 退出码必须非 0,实测 ${r.exitCode}`)
	assert.ok(r.json, `${note}: 必须写出矩阵 JSON`)
	assert.equal(r.json.claims.allLayersPass, false, `${note}: allLayersPass 必须为 false`)
	assert.equal(r.json.claims.allVerified, false, `${note}: allVerified 必须为 false`)
	assert.match(r.json.claims.statement, /不能声称/, `${note}: statement 必须是拒绝口径`)
}

// ─────────────────────────── N1 子检查非零退出 ───────────────────────────

test('N1a 子检查非零退出且没写结果 → 该层 fail,矩阵退 1', () => {
	const r = runWithProducer({ tag: 'n1a', mode: 'nonzero' })
	assertRefusesToClaimSuccess(r, 'N1a')
	assert.equal(r.exitCode, 1)
	assert.equal(r.layerRecord.verdict, 'fail')
	assert.equal(r.layerRecord.reason, 'nonzero-exit:3')
	assert.equal(r.layerRecord.spawn.exitCode, 3)
	assert.equal(r.json.exitReason, 'required-layer-fail:swarm')
	assert.ok(hasRefusal(r.json, 'layer-fail', 'swarm'))
})

test('N1b 自称 pass 却退非零 → 按坏的那一半判 fail', () => {
	const r = runWithProducer({ tag: 'n1b', mode: 'pass-nonzero' })
	assertRefusesToClaimSuccess(r, 'N1b')
	assert.equal(r.layerRecord.verdict, 'fail')
	assert.equal(r.layerRecord.reason, 'pass-claimed-with-nonzero-exit:3')
	// 结果文件确实自称 pass —— 证明这条不是靠"生产者自己认错"过的。
	assert.equal(r.layerRecord.result.verdict, 'pass')
	assert.equal(r.layerRecord.result.counts.pass, 5)
})

// ─────────────────────────────── N2 超时 ───────────────────────────────

test('N2 子检查超时 → fail,且原因写明是超时不是断言失败', () => {
	const r = runWithProducer({ tag: 'n2', mode: 'hang', extraArgv: ['--layer-timeout=swarm=1500'], timeoutMs: 60000 })
	assertRefusesToClaimSuccess(r, 'N2')
	assert.equal(r.exitCode, 1)
	assert.equal(r.layerRecord.verdict, 'fail')
	assert.match(r.layerRecord.reason, /^timeout-after:1500ms/)
	assert.equal(r.layerRecord.spawn.timedOut, true)
})

// ──────────────────── N3 结果缺失 / 为空 / 字段缺失 ────────────────────

test('N3a 退 0 但没写结果 → missing-layer-result', () => {
	const r = runWithProducer({ tag: 'n3a', mode: 'no-result' })
	assertRefusesToClaimSuccess(r, 'N3a')
	assert.equal(r.layerRecord.spawn.exitCode, 0, '桩必须真的退 0,否则测的是 N1 不是 N3')
	assert.equal(r.layerRecord.verdict, 'fail')
	assert.equal(r.layerRecord.reason, 'missing-layer-result')
})

test('N3b 结果文件是 0 字节 → empty-layer-result', () => {
	const r = runWithProducer({ tag: 'n3b', mode: 'empty-result' })
	assertRefusesToClaimSuccess(r, 'N3b')
	assert.equal(r.layerRecord.reason, 'empty-layer-result')
})

test('N3c 结果文件只有空白 → 同样按空处理', () => {
	const r = runWithProducer({ tag: 'n3c', mode: 'whitespace-result' })
	assertRefusesToClaimSuccess(r, 'N3c')
	assert.equal(r.layerRecord.reason, 'empty-layer-result')
})

test('N3d 结果不是合法 JSON → invalid-layer-result-json', () => {
	const r = runWithProducer({ tag: 'n3d', mode: 'bad-json' })
	assertRefusesToClaimSuccess(r, 'N3d')
	assert.equal(r.layerRecord.reason, 'invalid-layer-result-json')
})

test('N3e 结果字段缺失 → 逐个字段点名,不当作"格式小问题"放过', () => {
	const r = runWithProducer({ tag: 'n3e', mode: 'missing-fields' })
	assertRefusesToClaimSuccess(r, 'N3e')
	assert.equal(r.layerRecord.verdict, 'fail')
	const codes = r.layerRecord.validationErrors.map((e) => e.code)
	for (const c of ['missing-field:sourceCommit', 'missing-field:worktreeDigest', 'missing-field:startedAt', 'missing-field:endedAt', 'missing-field:exitCode', 'command-invalid', 'platform-invalid', 'counts-invalid', 'logs-invalid']) {
		assert.ok(codes.includes(c), `期望校验错误码 ${c},实得 ${codes.join(',')}`)
	}
})

test('N3f command 写成拼好的字符串而不是 argv 数组 → 判不合格', () => {
	const r = runWithProducer({ tag: 'n3f', mode: 'command-as-string' })
	assertRefusesToClaimSuccess(r, 'N3f')
	assert.ok(r.layerRecord.validationErrors.some((e) => e.code === 'command-invalid'))
})

// ────────────────────────── N4 被要求的层 blocked ──────────────────────────

test('N4a 被要求的层 blocked → 绝不汇总成"整体集成通过",退 78', () => {
	const r = runWithProducer({ tag: 'n4a', mode: 'blocked' })
	assertRefusesToClaimSuccess(r, 'N4a')
	assert.equal(r.exitCode, 78)
	assert.equal(r.layerRecord.verdict, 'blocked')
	assert.equal(r.json.integration.verdict, 'blocked')
	assert.deepEqual(r.json.integration.coverage.blocked, ['swarm'])
	assert.deepEqual(r.json.integration.coverage.covered, [])
	assert.equal(r.json.claims.requiredLayersPass, false)
	assert.match(r.json.exitReason, /^required-layer-unavailable:swarm=blocked/)
	// blocked 单列,绝不并进 pass。
	assert.equal(r.json.totals.blocked, 1)
	assert.equal(r.json.totals.pass, 0)
	assert.ok(hasRefusal(r.json, 'layer-blocked', 'swarm'))
})

test('N4b 被要求的层压根没有入口 → blocked,且原因点名探测过哪些路径', () => {
	const root = tempRoot('n4b')
	// 探测根指向一个空的临时目录:这条负例要验的是"没有入口"这条分支,不能取决于
	// 别的代理这一刻有没有恰好把自己的入口落到默认位置(他们正在并行往同一个工作区写文件)。
	const r = runMatrix([
		`--logdir=${join(root, 'run')}`, `--json=${join(root, 'matrix.json')}`,
		'--require=linux', '--skip=code-gate', `--candidates-root=${join(root, 'empty')}`,
	])
	assertRefusesToClaimSuccess(r, 'N4b')
	assert.equal(r.exitCode, 78)
	const rec = r.json.layers.find((l) => l.layer === 'linux')
	assert.equal(rec.verdict, 'blocked')
	assert.equal(rec.ran, false)
	assert.match(rec.result.blockedReason, /scripts\/acceptance\/integration\/linux\/run\.mjs/)
	assert.match(rec.result.blockedReason, /完全没有被触达/)
	assert.ok(Array.isArray(rec.result.recoveryCommand) && rec.result.recoveryCommand.length > 0)
})

test('N4c blocked 但原因含糊("环境不支持")且没给恢复命令 → 判不合格', () => {
	const r = runWithProducer({ tag: 'n4c', mode: 'blocked-vague' })
	assertRefusesToClaimSuccess(r, 'N4c')
	const codes = r.layerRecord.validationErrors.map((e) => e.code)
	assert.ok(codes.includes('blocked-reason-too-vague'), codes.join(','))
	assert.ok(codes.includes('blocked-without-recovery'), codes.join(','))
	// 严重程度分档:自报 blocked 的层,文档不合格时仍判 blocked 而不是 fail ——
	// 否则编排方会凭一个字段的形状,把「这一层没被触达」造成「这一层失败了」。
	assert.equal(r.layerRecord.verdict, 'blocked')
	assert.equal(r.exitCode, 78)
	assert.match(r.layerRecord.result.blockedReason, /不合契约/)
	// 对照:同样不合格但自称 pass 的结果(N3e)判 fail —— 证明这不是"一律降级成 blocked"。
	const claimsPass = runWithProducer({ tag: 'n4c2', mode: 'missing-fields' })
	assert.equal(claimsPass.layerRecord.verdict, 'fail')
})

// ────────────────────────── N5 日志哈希不匹配 ──────────────────────────

test('N5a 结果写完之后日志被篡改 → 证据完整性失败,退 78', () => {
	const r = runWithProducer({ tag: 'n5a', mode: 'tamper-log' })
	assertRefusesToClaimSuccess(r, 'N5a')
	assert.equal(r.exitCode, 78)
	assert.equal(r.layerRecord.spawn.exitCode, 0, '桩必须真的退 0 —— 这条要证明的正是"退出码没问题也能被抓"')
	assert.equal(r.layerRecord.result.verdict, 'pass', '结果文件本身自称 pass')
	assert.equal(r.layerRecord.verdict, 'fail')
	assert.match(r.layerRecord.reason, /^evidence-integrity:log-digest-mismatch/)
	const mm = r.layerRecord.evidence.mismatches[0]
	assert.equal(mm.code, 'log-digest-mismatch')
	assert.notEqual(mm.declared, mm.actual)
	assert.ok(hasRefusal(r.json, 'evidence-integrity', 'swarm'))
	assert.match(r.json.exitReason, /^evidence-integrity:/)
})

test('N5b 哈希是手填的(与实测对不上)→ 同样被抓', () => {
	const r = runWithProducer({ tag: 'n5b', mode: 'hand-written-hash' })
	assertRefusesToClaimSuccess(r, 'N5b')
	assert.match(r.layerRecord.reason, /^evidence-integrity:log-digest-mismatch/)
	assert.equal(r.layerRecord.evidence.mismatches[0].declared, '0'.repeat(64))
})

test('N5c 声称的日志文件压根不存在 → log-missing(与"哈希对不上"分开报)', () => {
	const r = runWithProducer({ tag: 'n5c', mode: 'log-missing' })
	assertRefusesToClaimSuccess(r, 'N5c')
	assert.match(r.layerRecord.reason, /^evidence-integrity:log-missing/)
	assert.ok(Array.isArray(r.layerRecord.evidence.mismatches[0].searched))
})

// ──────────────────── N6 代码门 authoritative=false ────────────────────

test('N6a 验收器退 0、codeGate.green=true,但 authoritative=false → 不算代码门通过', () => {
	const r = runWithFakeAcceptance({ tag: 'n6a', mode: 'non-authoritative-green' })
	assertRefusesToClaimSuccess(r, 'N6a')
	assert.equal(r.exitCode, 78)
	// 先钉住替身确实给出了"看起来全绿"的输出:否则这条负例可能只是抓到了一次普通失败。
	const acc = JSON.parse(readFileSync(join(r.logDir, 'code-gate.acceptance.json'), 'utf8'))
	assert.equal(acc.authoritative, false)
	assert.equal(acc.codeGate.green, true)
	assert.equal(acc.processExitCode, 0)
	assert.equal(r.codeRecord.spawn.exitCode, 0, '验收器子进程真的退了 0')
	assert.equal(r.codeRecord.verdict, 'blocked')
	assert.equal(r.codeRecord.reason, 'non-authoritative-code-gate')
	assert.match(r.codeRecord.result.blockedReason, /authoritative=false/)
	assert.match(r.codeRecord.result.blockedReason, /plan=/)
	assert.equal(r.json.code.verdict, 'blocked')
	assert.equal(r.json.code.authoritativeRun, false)
	assert.ok(hasRefusal(r.json, 'layer-blocked', 'code-gate'))
})

test('N6b --floors=none 那种 authoritative=false(无合成接缝)同样不算通过', () => {
	const r = runWithFakeAcceptance({ tag: 'n6b', mode: 'floors-none-green' })
	assertRefusesToClaimSuccess(r, 'N6b')
	assert.equal(r.codeRecord.verdict, 'blocked')
	assert.equal(r.codeRecord.reason, 'non-authoritative-code-gate')
	assert.match(r.codeRecord.result.blockedReason, /floors=none|没有计数下限约束/)
})

test('N6c 权威且全绿的验收器 → 代码门判 pass(正控:上面两条不是"一律判红")', () => {
	const r = runWithFakeAcceptance({ tag: 'n6c', mode: 'authoritative-green' })
	assert.equal(r.json.code.verdict, 'pass')
	assert.equal(r.json.code.authoritativeRun, true)
	assert.equal(r.json.claims.requiredLayersPass, true)
	// 但这仍然是入口自检(用了 --code-gate-argv 接缝),所以不许说"全部验证通过",也不许退 0。
	assert.equal(r.json.claims.allVerified, false)
	assert.equal(r.json.authoritative, false)
	assert.equal(r.exitCode, 70)
	assert.equal(r.json.exitReason, 'synthetic-seams')
})

test('N6d 验收器真红 → 代码门判 fail,退 1', () => {
	const r = runWithFakeAcceptance({ tag: 'n6d', mode: 'red' })
	assertRefusesToClaimSuccess(r, 'N6d')
	assert.equal(r.exitCode, 1)
	assert.equal(r.json.code.verdict, 'fail')
	assert.equal(r.codeRecord.reason, 'failed-gates:1')
})

test('N6e 验收器退 0 但没写 JSON → missing-acceptance-json', () => {
	const r = runWithFakeAcceptance({ tag: 'n6e', mode: 'no-json' })
	assertRefusesToClaimSuccess(r, 'N6e')
	assert.equal(r.codeRecord.reason, 'missing-acceptance-json')
})

test('N6f 验收器全绿但一个测试都没跑 → zero-passing-tests', () => {
	const r = runWithFakeAcceptance({ tag: 'n6f', mode: 'zero-tests' })
	assertRefusesToClaimSuccess(r, 'N6f')
	assert.equal(r.codeRecord.reason, 'zero-passing-tests')
})

test('N6g 验收器记的闸日志哈希与磁盘对不上 → 代码门这层也走证据完整性', () => {
	const r = runWithFakeAcceptance({ tag: 'n6g', mode: 'tampered-gate-log' })
	assertRefusesToClaimSuccess(r, 'N6g')
	assert.equal(r.exitCode, 78)
	assert.match(r.codeRecord.reason, /^evidence-integrity:log-digest-mismatch/)
})

test('N6i suite 缺少日志哈希 → 证据不能被静默丢弃', () => {
	const r = runWithFakeAcceptance({ tag: 'n6i', mode: 'missing-suite-logsha' })
	assertRefusesToClaimSuccess(r, 'N6i')
	assert.match(r.codeRecord.reason, /evidence-integrity:log-entry-bad-digest/)
})

test('N6j suite 非法日志哈希 → 证据完整性失败', () => {
	const r = runWithFakeAcceptance({ tag: 'n6j', mode: 'invalid-suite-logsha' })
	assertRefusesToClaimSuccess(r, 'N6j')
	assert.match(r.codeRecord.reason, /evidence-integrity:log-entry-bad-digest/)
})

test('N6k 缺 tests 或 totals 自相矛盾 → 代码门失败', () => {
	for (const [tag, mode] of [['n6k', 'missing-tests'], ['n6l', 'inconsistent-totals']]) {
		const r = runWithFakeAcceptance({ tag, mode })
		assertRefusesToClaimSuccess(r, tag)
		assert.equal(r.codeRecord.reason, 'invalid-acceptance-totals')
	}
})

test('N6m green 与 fail/failedGates 矛盾 → adapter 失败', () => {
	const r = runWithFakeAcceptance({ tag: 'n6m', mode: 'green-with-fail' })
	assertRefusesToClaimSuccess(r, 'N6m')
	assert.equal(r.codeRecord.reason, 'contradictory-green-summary')
})

test('N6n cancelled 不可折成普通 skip 放行', () => {
	const r = runWithFakeAcceptance({ tag: 'n6n', mode: 'cancelled' })
	assertRefusesToClaimSuccess(r, 'N6n')
	assert.equal(r.codeRecord.reason, 'cancelled-tests')
})

test('N6o malformed codeGate/advisory 条目结构化失败', () => {
	const r = runWithFakeAcceptance({ tag: 'n6o', mode: 'malformed-containers' })
	assertRefusesToClaimSuccess(r, 'N6o')
	assert.equal(r.codeRecord.reason, 'invalid-acceptance-shape')
})

test('N6p green 但没有任何 code-gate suite → 缺少代码门证据', () => {
	const r = runWithFakeAcceptance({ tag: 'n6p', mode: 'green-no-suites' })
	assertRefusesToClaimSuccess(r, 'N6p')
	assert.equal(r.codeRecord.reason, 'invalid-acceptance-shape')
})

test('N6h schema 不对的验收器输出 → 不当成结果', () => {
	const r = runWithFakeAcceptance({ tag: 'n6h', mode: 'wrong-schema' })
	assertRefusesToClaimSuccess(r, 'N6h')
	assert.equal(r.codeRecord.reason, 'acceptance-schema-mismatch')
})

// ──────────────────────────── 自相矛盾的自述 ────────────────────────────

test('C1 自称 pass 但一条都没真过 → 降级为 fail', () => {
	const r = runWithProducer({ tag: 'c1', mode: 'pass-zero-counts' })
	assertRefusesToClaimSuccess(r, 'C1')
	assert.equal(r.layerRecord.verdict, 'fail')
	assert.match(r.layerRecord.reason, /pass-without-any-passing-check/)
})

test('C2 自称 pass 但 counts.blocked>0 → 降级为 blocked(blocked 不并入 pass)', () => {
	const r = runWithProducer({ tag: 'c2', mode: 'pass-with-blocked' })
	assertRefusesToClaimSuccess(r, 'C2')
	assert.equal(r.layerRecord.verdict, 'blocked')
	assert.equal(r.exitCode, 78)
})

test('C3 自称 pass 但 counts.fail>0 → 降级为 fail', () => {
	const r = runWithProducer({ tag: 'c3', mode: 'pass-with-fail' })
	assertRefusesToClaimSuccess(r, 'C3')
	assert.equal(r.layerRecord.verdict, 'fail')
})

test('C4 结果自称是另一层 → layer-mismatch', () => {
	const r = runWithProducer({ tag: 'c4', mode: 'wrong-layer' })
	assertRefusesToClaimSuccess(r, 'C4')
	assert.ok(r.layerRecord.validationErrors.some((e) => e.code === 'layer-mismatch'))
})

test('C5 结果量的是另一个提交 → stale-layer-result:commit', () => {
	const r = runWithProducer({ tag: 'c5', mode: 'stale-commit' })
	assertRefusesToClaimSuccess(r, 'C5')
	assert.match(r.layerRecord.reason, /^stale-layer-result:commit/)
})

test('C6b 生产者用 tracked 口径报摘要 → 不能因为和 porcelain 摘要不等就判红(R2 P1)', () => {
	const r = runWithProducer({ tag: 'c6b', mode: 'tracked-digest' })
	assert.equal(r.layerRecord.verdict, 'pass',
		`同一棵树的两种合法摘要必须都能归属。实际: ${r.layerRecord?.verdict} ${r.layerRecord?.reason}`)
	assert.equal(r.layerRecord.digestDrift, null)
	assert.equal(r.json.claims.requiredLayersPass, true)
})

test('C6 结果的工作树摘要对不上 → 绝不判 pass(树稳定判 fail,树被并行改动判 blocked)', () => {
	const r = runWithProducer({ tag: 'c6', mode: 'stale-worktree' })
	assertRefusesToClaimSuccess(r, 'C6')
	assert.notEqual(r.layerRecord.verdict, 'pass')
	assert.ok(r.layerRecord.digestDrift, '差异必须被记录下来,不能只体现在判定里')
	assert.equal(r.layerRecord.digestDrift.declared, 'f'.repeat(64))
	// 归属按该层的执行窗口判:矩阵在这一层跑之前/之后各量一次,声称值必须等于它亲自量到的
	// 某一个状态。这三个观测值也要如实进 JSON,否则"归属不上"就成了没法复核的断言。
	assert.equal(r.layerRecord.worktreeWindow.before.length, 64)
	assert.ok(r.layerRecord.digestDrift.observed.length >= 1)
	// 两个分支各自的形态由 F9 的纯函数测试逐一钉住;这里只保证真跑一遍时确实走到了其中之一。
	if (r.layerRecord.worktreeWindow.stable) {
		assert.equal(r.layerRecord.verdict, 'fail')
		assert.match(r.layerRecord.reason, /^stale-layer-result:worktree/)
	} else {
		assert.equal(r.layerRecord.verdict, 'blocked')
		assert.match(r.layerRecord.reason, /^unattributable-worktree/)
	}
})

// ───────────────────────────── S 汇总语义 ─────────────────────────────

test('S1 可选层缺席 ≠ 产品代码失败:代码门照常 pass,被要求的层全过', () => {
	const r = runWithFakeAcceptance({ tag: 's1', mode: 'authoritative-green', require: ['code-gate'] })
	assert.equal(r.json.code.verdict, 'pass', '可选集成层没跑,不许把产品代码结论变红')
	assert.equal(r.json.claims.requiredLayersPass, true)
	assert.deepEqual(r.json.integration.coverage.absent.sort(), ['host-browser', 'linux', 'swarm'])
	assert.deepEqual(r.json.integration.coverage.failed, [])
	assert.equal(r.json.integration.verdict, 'none')
	// 但"没跑"不等于"过了":仍然不能说全部验证通过。
	assert.equal(r.json.claims.allVerified, false)
	assert.equal(r.json.claims.allLayersPass, false)
	for (const l of ['swarm', 'linux', 'host-browser']) {
		assert.ok(hasRefusal(r.json, 'layer-not-covered', l), `${l} 应当以 layer-not-covered 出现在拒绝理由里`)
	}
	// 退出码只由"被要求的层"决定:这里唯一的非 0 理由是自检接缝,不是缺了可选层。
	assert.equal(r.json.exitReason, 'synthetic-seams')
})

test('S2 桩把四层都做成绿的 → 机械上全过,但因为是入口自检,仍不许说"全部验证通过"', () => {
	const root = tempRoot('s2')
	const logDir = join(root, 'run')
	const jsonOut = join(root, 'matrix.json')
	const layerArg = (layer) => `--layer-argv=${layer}=${JSON.stringify(['node', PRODUCER, '--mode=ok', `--layer=${layer}`, `--out=${join(logDir, `${layer}.json`)}`, `--logdir=${logDir}`])}`
	const r = runMatrix([
		`--logdir=${logDir}`, `--json=${jsonOut}`, '--all',
		`--code-gate-argv=${JSON.stringify(['node', FAKE_ACCEPTANCE, '--mode=authoritative-green', `--json=${join(logDir, 'code-gate.acceptance.json')}`, `--logdir=${join(logDir, 'code-gate-logs')}`])}`,
		layerArg('swarm'), layerArg('linux'), layerArg('host-browser'),
	])
	assert.equal(r.json.claims.allLayersPass, true, '四层机械上确实都 pass')
	assert.equal(r.json.claims.requiredLayersPass, true)
	assert.equal(r.json.integration.verdict, 'pass')
	assert.equal(r.json.claims.allVerified, false, '入口自检不得冒充真实集成 pass')
	assert.equal(r.json.authoritative, false)
	assert.ok(hasRefusal(r.json, 'synthetic-seams'))
	assert.equal(r.exitCode, 70, '全绿的自检也不给 0 —— 否则 `矩阵 --layer-argv=... && echo 通过` 就成立了')
	assert.match(r.output, /入口自检运行\(非权威\)/)
})

test('S3 只跑代码门时,集成层的 skip 计数不会被折进 pass', () => {
	const r = runWithProducer({ tag: 's3', mode: 'ok-with-skip' })
	assert.equal(r.layerRecord.verdict, 'pass')
	assert.equal(r.json.totals.pass, 2)
	assert.equal(r.json.totals.skip, 1)
	assert.equal(r.json.totals.blocked, 0)
})

test('S4 默认探测位置上有入口时会被发现并真的跑起来', () => {
	const root = tempRoot('s4')
	const fakeRoot = join(root, 'fake-repo')
	const shimDir = join(fakeRoot, 'scripts', 'acceptance', 'integration', 'swarm')
	mkdirSync(shimDir, { recursive: true })
	// 桩只收矩阵按注册方言传来的 `--logdir=<dir>`,自己推出契约规定的 `<logdir>/swarm.json`。
	writeFileSync(join(shimDir, 'run.mjs'), [
		"const dir = process.argv.slice(2).find((a) => a.startsWith('--logdir=')).slice('--logdir='.length)",
		"process.argv.push('--mode=ok', '--layer=swarm', `--out=${dir}/swarm.json`)",
		`await import(${JSON.stringify(pathToFileURL(PRODUCER).href)})`,
		'',
	].join('\n'))
	const logDir = join(root, 'run')
	const r = runMatrix([
		`--logdir=${logDir}`, `--json=${join(root, 'matrix.json')}`,
		'--require=swarm', '--skip=code-gate', `--candidates-root=${fakeRoot}`,
	])
	const rec = r.json.layers.find((l) => l.layer === 'swarm')
	assert.equal(rec.ran, true, '默认探测应当找到入口并真的跑它')
	assert.equal(rec.seam, null, '走默认探测路径的层不算被接缝指定')
	assert.equal(rec.verdict, 'pass')
	assert.equal(rec.argv[1], join(shimDir, 'run.mjs'))
	assert.ok(existsSync(join(logDir, 'swarm.json')), '入口应当按契约写到 <logdir>/<layer>.json')
	// --candidates-root 本身是接缝,所以这次运行照样非权威。
	assert.equal(r.json.authoritative, false)
	assert.equal(r.exitCode, 70)
})

// ───────────────────────── G 入口自身的护栏 ─────────────────────────

test('G1 --print-plan 退 78:一层都没跑的运行永远不能被读成通过', () => {
	const r = runMatrix(['--print-plan'])
	assert.equal(r.exitCode, 78)
	assert.match(r.stderr, /PLAN-ONLY/)
})

test('G1b --only 只跑点名的层,其余 skip;裸 --only 拒绝', () => {
	const planned = runMatrix(['--print-plan', '--only=swarm,linux'])
	assert.equal(planned.exitCode, 78)
	const plan = JSON.parse(planned.stdout).plan
	const by = Object.fromEntries(plan.map((l) => [l.layer, l]))
	assert.equal(by.swarm.run, true)
	assert.equal(by.linux.run, true)
	assert.equal(by['code-gate'].run, false)
	assert.equal(by['host-browser'].run, false)
	assert.equal(by.swarm.required, true)
	assert.equal(by['code-gate'].required, false)
	const bare = runMatrix(['--print-plan', '--only'])
	assert.equal(bare.exitCode, 78)
	assert.match(bare.stderr, /裸标志/)
})

test('G2 --require 为空 → 拒绝运行', () => {
	const r = runMatrix(['--require='])
	assert.equal(r.exitCode, 78)
	assert.match(r.stderr, /empty-require/)
})

test('G3 不认识的层名 → 拒绝运行,不静默忽略', () => {
	const r = runMatrix(['--require=swarn'])
	assert.equal(r.exitCode, 78)
	assert.match(r.stderr, /不认识/)
})

test('G4 同一层同时出现在 --require 与 --skip → 拒绝运行', () => {
	const r = runMatrix(['--require=swarm', '--skip=swarm'])
	assert.equal(r.exitCode, 78)
	assert.match(r.stderr, /不能同时成立/)
})

test('G5 日志目录已有内容 → 拒绝覆盖上一轮证据', () => {
	const root = tempRoot('g5')
	const logDir = join(root, 'run')
	mkdirSync(logDir, { recursive: true })
	writeFileSync(join(logDir, '上一轮的红日志.txt'), 'x')
	const empty = `--candidates-root=${join(root, 'empty')}`
	const r = runMatrix([`--logdir=${logDir}`, '--require=swarm', '--skip=code-gate', empty])
	assert.equal(r.exitCode, 78)
	assert.match(r.stderr, /避免覆盖上一轮证据/)
	const r2 = runMatrix([`--logdir=${logDir}`, `--json=${join(root, 'm.json')}`, '--require=swarm', '--skip=code-gate', empty, '--allow-existing-logdir'])
	assert.equal(r2.exitCode, 78, '显式允许覆盖后仍然因为 swarm 无入口而拒绝下结论')
	assert.equal(r2.json.layers.find((l) => l.layer === 'swarm').verdict, 'blocked')
})

test('G6 --layer-argv 必须是 JSON argv 数组,不能是拼好的命令行字符串', () => {
	const r = runMatrix(['--layer-argv=swarm=node /tmp/x.mjs'])
	assert.equal(r.exitCode, 78)
	assert.match(r.stderr, /JSON 字符串数组/)
})
