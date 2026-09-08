// W17 影子选择器:零模型(select 全是桩)、零网络。
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  buildShadowCandidates, summarizeShadowTask, buildShadowInput, buildShadowRecord, shadowDecide,
  buildShadowLinkRecord, shadowLinks, fleetBatchStates, fleetBatchRuns, hostOutcomeInBatch, shadowAdopted, backfillShadowOutcomes, attachShadowLinks, isShadowDecisionRef,
  SHADOW_MODE, SHADOW_LINK_EV, SHADOW_OUTCOME_SOURCE,
} from '../lib/shadow.js'
import { foldLedger, summarizeOutcomes, readLedgerLines } from '../lib/ledger.js'
import { entropyBitsOf, hasEntropyTail } from '../lib/ids.js'
import { allocationStateFromLedger } from '../lib/assemble.js'
import { apply } from '../lib/index.js'

// 照 2026-08-23 GET /api/fleet/hosts 实测形状
const HOSTS = [
  { name: 'local', kind: 'local', model: 'deepseek-v4-flash', tags: ['general'], maxConcurrency: 3, enabled: true, ok: true, inflight: 0 },
  { name: 'codex', kind: 'codex', model: '', tags: ['codex'], maxConcurrency: 1, enabled: true, ok: false, inflight: 0 },
  { name: 'agent-m4', kind: 'remote', model: 'deepseek-v4-flash', tags: ['general', 'tool-heavy', 'mac'], maxConcurrency: 4, enabled: true, ok: false, inflight: 0 },
  { name: 'leo-01', kind: 'remote', model: 'deepseek-v4-flash', tags: ['general', 'tool-heavy', 'linux', 'writable'], maxConcurrency: 6, enabled: true, ok: false, inflight: 0 },
  { name: 'knowledge-m4', kind: 'remote', model: 'deepseek-v4-flash', tags: ['general', 'tool-heavy', 'mac', 'writable', 'knowledge'], maxConcurrency: 4, enabled: true, ok: true, inflight: 1 },
  { name: 'disabled-x', kind: 'remote', enabled: false },
  { name: '../evil', kind: 'remote', enabled: true },
]

test('候选只收 remote&enabled、名字合规;description 摆出标签/并发/在途/可达;字符串候选不出现', () => {
  const c = buildShadowCandidates(HOSTS)
  assert.deepEqual(c.map((x) => x.id), ['agent-m4', 'leo-01', 'knowledge-m4'])
  assert.ok(c.every((x) => x.role === 'implementer' && typeof x.description === 'string'))
  assert.match(c[2].description, /标签 general,tool-heavy,mac,writable,knowledge · 并发上限 4 · 在途 1 · 可达$/)
  assert.match(c[1].description, /当前不可达/)
  assert.deepEqual(buildShadowCandidates(['leo-01']), [], '字符串候选直接丢(否则 allowed=[] 校验失效)')
  assert.deepEqual(buildShadowCandidates(undefined), [])
})

test('task 摘要:最多 32 项、每项截断、敏感项不进 prompt;候选为空 → input null(不调模型)', () => {
  const text = summarizeShadowTask(['跑一遍 docs 回归', 'token=abcdefgh12345678 写进 env', 'x'.repeat(1000)], { label: 'W1 冒烟', tag: 'writable' })
  assert.match(text, /^Homelab 派发:共 3 项任务\(批次「W1 冒烟」\),要求机器标签 writable。/)
  assert.match(text, /2\. \[含敏感内容,已略\]/)
  assert.ok(!text.includes('abcdefgh12345678'))
  assert.ok(text.split('\n')[3].length <= 250)
  assert.equal(buildShadowInput({ items: ['a'], hosts: [HOSTS[0], HOSTS[1]] }), null, '只有 local/codex 没有 remote → 不调')
  const input = buildShadowInput({ items: ['a'], hosts: HOSTS, chosen: ['leo-01'] })
  assert.equal(input.taskType, 'fleet-dispatch')
  assert.ok(!JSON.stringify(input).includes('chosen'), '用户勾选不进选择器输入')
})

test('buildShadowRecord:选择器成功 → mode shadow + agreed 三态;失败 → pick null(不编首台)且 fallbackReason', () => {
  const input = buildShadowInput({ items: ['a'], hosts: HOSTS })
  const ok = buildShadowRecord(input, { pick: 'leo-01', role: 'implementer', confidence: 0.7, reason: 'linux writable 并发 6', label: 'docs' }, { source: 'selector', chosen: ['leo-01', 'agent-m4'], tag: '', label: 'W1', items: ['a'] })
  assert.equal(ok.mode, SHADOW_MODE); assert.equal(ok.source, 'selector'); assert.equal(ok.pick, 'leo-01')
  assert.deepEqual(ok.candidates, ['agent-m4', 'leo-01', 'knowledge-m4'])
  assert.equal(ok.shadow.agreed, true); assert.equal(ok.taskType, 'fleet-dispatch'); assert.equal(ok.label, 'fleet-dispatch')
  // C2: the tail must carry real entropy, not a fixed 8 nibbles. Still a dec- id,
  // so shadow.js DEC_ID_RE and sanitize.js DECISION_ID keep matching.
  assert.match(ok.id, /^dec-\d+-[a-f0-9]+$/)
  assert.equal(hasEntropyTail(ok.id), true)
  assert.equal(entropyBitsOf(ok.id), 128)
  const disagree = buildShadowRecord(input, { pick: 'knowledge-m4', role: 'implementer', confidence: 0.5, reason: 'r' }, { source: 'selector', chosen: ['leo-01'] })
  assert.equal(disagree.shadow.agreed, false)
  const noChoice = buildShadowRecord(input, { pick: 'knowledge-m4', role: 'implementer', confidence: 0.5, reason: 'r' }, { source: 'selector', chosen: [] })
  assert.equal(noChoice.shadow.agreed, null, '没勾机器 = 交给调度器,不是 false')
  const failed = buildShadowRecord(input, null, { source: 'fallback', fallbackReason: 'BAD_OUTPUT', chosen: ['leo-01'] })
  assert.equal(failed.pick, null); assert.equal(failed.fallbackReason, 'BAD_OUTPUT'); assert.equal(failed.shadow.agreed, null)
  assert.equal(failed.reason, null)
})

test('shadowDecide:未配置/抛错/成功 三态各写一行;候选空不写不调;响应不含 task', async () => {
  const appended = []
  const append = (r) => appended.push(r)
  let calls = 0
  const body = { items: ['写一份 README'], hosts: HOSTS, chosen: ['leo-01'], tag: '', label: 'x' }
  const skipped = await shadowDecide({ items: ['a'], hosts: [] }, { select: () => { calls += 1 }, append })
  assert.deepEqual(skipped, { skipped: true, reason: 'NO_CANDIDATES', message: '没有可用的远端机器,未调用选择器' })
  assert.equal(calls, 0); assert.equal(appended.length, 0)
  const notConfigured = await shadowDecide(body, { select: undefined, append })
  assert.equal(notConfigured.source, 'fallback'); assert.equal(notConfigured.fallbackReason, 'NOT_CONFIGURED'); assert.equal(notConfigured.pick, null)
  const err = Object.assign(new Error('bad'), { code: 'BAD_OUTPUT', detail: { blockTypes: ['text'] } })
  const failed = await shadowDecide(body, { select: async () => { calls += 1; throw err }, append })
  assert.equal(failed.fallbackReason, 'BAD_OUTPUT'); assert.deepEqual(failed.fallbackDetail, { blockTypes: ['text'] }); assert.equal(failed.pick, null)
  const okRes = await shadowDecide(body, { select: async (input) => { calls += 1; assert.equal(input.candidates.length, 3); return { pick: 'knowledge-m4', role: 'implementer', confidence: 0.8, reason: '唯一可达且在途最少', label: 'docs' } }, append })
  assert.equal(okRes.pick, 'knowledge-m4'); assert.equal(okRes.shadow.agreed, false); assert.equal(okRes.source, 'selector')
  assert.equal('task' in okRes, false)
  assert.equal(calls, 2); assert.equal(appended.length, 3)
  assert.ok(appended.every((r) => r.mode === SHADOW_MODE))
})

test('关联行与回填:fold 不把 shadow-link 当决策;只看建议那台机器上的 run;reroute 以最终机器为准;cancel/reattach 也是终态;已回填不重复', () => {
  const link = buildShadowLinkRecord({ ref: 'dec-1787000000000-abcdef12', batchId: 'b-f785f00d-8463-4369-9a02-4bf6dc7e3024', hosts: ['knowledge-m4', 'leo-01', 'leo-01', '../x'] })
  assert.equal(link.ev, SHADOW_LINK_EV); assert.deepEqual(link.hosts, ['knowledge-m4', 'leo-01'])
  assert.throws(() => buildShadowLinkRecord({ ref: 'x', batchId: 'b-1' }), /dec-/)
  assert.throws(() => buildShadowLinkRecord({ ref: 'dec-1-a', batchId: 'r-1' }), /b-/)
  const B1 = 'b-f785f00d-8463-4369-9a02-4bf6dc7e3024'
  const B2 = 'b-22222222-0000-4000-8000-000000000000'
  const rows = [
    { id: 'dec-1787000000000-abcdef12', ts: 1, mode: 'shadow', role: 'implementer', pick: 'leo-01', taskType: 'fleet-dispatch', source: 'selector', outcome: null, shadow: { chosen: [], agreed: null } },
    { id: 'dec-1787000000000-abcdef13', ts: 2, mode: 'shadow', role: 'implementer', pick: null, taskType: 'fleet-dispatch', source: 'fallback', outcome: null, shadow: { chosen: [], agreed: null } },
    { id: 'dec-1787000000000-abcdef14', ts: 2, mode: 'shadow', role: 'implementer', pick: 'knowledge-m4', taskType: 'fleet-dispatch', source: 'selector', outcome: null, shadow: { chosen: [], agreed: null } },
    { id: 'dec-9', ts: 3, role: 'coder', pick: 'qwen3.8-max', taskType: 'coder', source: 'selector', outcome: null },
    link,
    { ev: 'shadow-link', ref: 'dec-1787000000000-abcdef13', batchId: B2, hosts: ['leo-01'], at: 3 },
    { ev: 'shadow-link', ref: 'dec-1787000000000-abcdef14', batchId: B2, hosts: ['leo-01'], at: 3 },
    { ev: 'annotate', ref: 'dec-9', note: 'n', at: 4 },
  ]
  const { decisions } = foldLedger(rows)
  assert.deepEqual(decisions.map((d) => d.id), ['dec-1787000000000-abcdef12', 'dec-1787000000000-abcdef13', 'dec-1787000000000-abcdef14', 'dec-9'], 'ev 行不是决策')
  const links = shadowLinks(rows)
  assert.deepEqual(links.get('dec-1787000000000-abcdef12'), { batchId: B1, hosts: ['knowledge-m4', 'leo-01'] })
  // 照 runs.jsonl 实测形状:dispatch 行带 host,end 行带 ok/exit;reroute 改机器;cancel 也是终态
  const runs = [
    { ev: 'dispatch', batchId: B1, runId: 'r-1', host: 'knowledge-m4', at: 1 },
    { ev: 'dispatch', batchId: B1, runId: 'r-2', host: 'leo-01', at: 1 },
    { ev: 'end', batchId: B1, runId: 'r-1', ok: false, exit: 1, at: 2 },
    { ev: 'end', batchId: B1, runId: 'r-2', ok: true, exit: 0, at: 2 },
    // B2:派发响应说 leo-01,唤醒失败改派 knowledge-m4,随后取消
    { ev: 'dispatch', batchId: B2, runId: 'r-3', host: 'leo-01', at: 1 },
    { ev: 'reroute', batchId: B2, runId: 'r-3', host: 'knowledge-m4', at: 2 },
    { ev: 'cancel', batchId: B2, runId: 'r-3', reason: 'user', at: 3 },
  ]
  const batchRuns = fleetBatchRuns(runs)
  assert.deepEqual(fleetBatchStates(runs).get(B1), { ended: true, ok: false, runs: 2, endedRuns: 2, hosts: ['knowledge-m4', 'leo-01'] })
  assert.deepEqual(hostOutcomeInBatch(batchRuns.get(B1), 'leo-01'), { present: true, ended: true, ok: true }, '同批 knowledge-m4 失败不归到 leo-01 头上')
  assert.deepEqual(hostOutcomeInBatch(batchRuns.get(B1), 'agent-m4'), { present: false, ended: false, ok: false })
  assert.deepEqual(hostOutcomeInBatch(batchRuns.get(B2), 'leo-01'), { present: false, ended: false, ok: false }, 'reroute 后 leo-01 上没有 run')
  assert.deepEqual(hostOutcomeInBatch(batchRuns.get(B2), 'knowledge-m4'), { present: true, ended: true, ok: false }, 'cancel 是终态,算 fail')
  const fills = backfillShadowOutcomes({ decisions, links, batchRuns })
  assert.deepEqual(fills.map((f) => [f.ref, f.result, f.source]), [
    ['dec-1787000000000-abcdef12', 'ok', SHADOW_OUTCOME_SOURCE],   // 建议 leo-01,leo-01 上的 run ok
    ['dec-1787000000000-abcdef14', 'fail', SHADOW_OUTCOME_SOURCE], // 建议 knowledge-m4,reroute 后真跑在它上面并被取消
  ], 'abcdef13 无 pick 不回填')
  const folded2 = foldLedger([...rows, ...fills])
  assert.equal(folded2.decisions[0].outcome, 'ok'); assert.equal(folded2.decisions[2].outcome, 'fail')
  assert.deepEqual(backfillShadowOutcomes({ decisions: folded2.decisions, links, batchRuns }), [], '已回填不重复')
  assert.deepEqual(backfillShadowOutcomes({ decisions, links: new Map([['dec-9', { batchId: B1, hosts: ['leo-01'] }]]), batchRuns }), [], '非 shadow 决策不回填')
  const attached = attachShadowLinks(folded2.decisions, links, batchRuns)
  assert.equal(attached[0].batchRef, B1); assert.equal(attached[0].adopted, true); assert.deepEqual(attached[0].actualHosts, ['knowledge-m4', 'leo-01'])
  assert.equal(attached[1].adopted, null, '无 pick 判不了')
  assert.deepEqual(attached[2].actualHosts, ['knowledge-m4'], 'actualHosts 以 runs.jsonl 最终机器为准,不信派发快照 leo-01')
  assert.equal(attached[2].adopted, true)
  assert.equal(attached[3].batchRef, undefined)
  // runs 里还没这个批次 → 退回快照
  assert.equal(shadowAdopted('leo-01', { batchId: 'b-x', hosts: ['leo-01'] }, undefined), true)
  assert.equal(shadowAdopted('leo-02', { batchId: 'b-x', hosts: ['leo-01'] }, undefined), false)
  // 汇总:影子行单列,不进 (角色,模型) 格;后验也不吃机器;pending 只算模型路由行
  const stats = summarizeOutcomes(folded2.decisions)
  assert.equal(stats.cells, 1, '只有 dec-9 的 coder/qwen 格')
  assert.equal(stats.pending, 1); assert.equal(stats.total, 4)
  assert.deepEqual(stats.shadow, { total: 3, filled: 2, pending: 1, suggested: 2, agreed: 0, filledOk: 1 })
  assert.deepEqual(allocationStateFromLedger([...rows, ...fills]), [], '影子行不进 Beta 后验')
  assert.equal(isShadowDecisionRef(rows, 'dec-1787000000000-abcdef12'), true); assert.equal(isShadowDecisionRef(rows, 'dec-9'), false)
})

test('W10 派生器不把影子行当 route 行(机器名不进 (kind,taskType,agent) 格)', async () => {
  const { deriveRouteRows } = await import('../lib/outcomes.js')
  const rows = deriveRouteRows([
    { id: 'dec-1', ts: 1, mode: 'shadow', role: 'implementer', pick: 'knowledge-m4', taskType: 'fleet-dispatch', source: 'selector', outcome: null },
    { id: 'dec-2', ts: 2, role: 'coder', pick: 'qwen3.8-max', taskType: 'coder', source: 'selector', outcome: null },
  ])
  assert.deepEqual(rows.map((r) => r.ref), ['dec-2'])
})

// ── apply() 真跑:路由注册、影子 POST 零模型(provider 空 → 未配置)、link、GET 回填 ──
function fakeCtx() {
  const routes = new Map()
  const ctx = {
    logger: () => ({ warn() {}, info() {} }),
    llm: undefined,
    inject(names, cb) {
      if (names.includes('webServer')) {
        cb({ get: (n) => (n === 'webServer' ? { register: (r) => { routes.set(r.path, r.handler); return () => routes.delete(r.path) } } : undefined) })
      }
    },
  }
  return { ctx, routes }
}
async function call(handler, method, url, body) {
  let status; let out
  const res = { statusCode: 0, setHeader() {}, writeHead(s) { status = s }, end(b) { out = b } }
  const listeners = {}
  const req = { method, url, headers: {}, on(ev, fn) { listeners[ev] = fn; return req }, destroy() {} }
  const p = handler(req, res)
  if (body !== undefined) { listeners.data?.(Buffer.from(JSON.stringify(body))); listeners.end?.() } else { listeners.end?.() }
  await p
  return { status, body: out ? JSON.parse(out) : undefined }
}

test('apply():POST /routes/shadow 未配置选择器时写 fallback 行(零模型);/shadow/link 追加关联;GET /routes 回填并带 batchRef 与 stats.shadow', async (t) => {
  const { taskFingerprint } = await import('../lib/task-fingerprint.mjs')
  const dir = await mkdtemp(join(tmpdir(), 'agos-shadow-'))
  const audit = join(dir, 'route-outcome.jsonl')
  const runsFile = join(dir, 'runs.jsonl')
  await writeFile(audit, '')
  process.env.DSH_FLEET_RUNS_FILE = runsFile
  t.after(() => { delete process.env.DSH_FLEET_RUNS_FILE })
  const { ctx, routes } = fakeCtx()
  apply(ctx, { auditFile: audit, provider: '', model: '' })
  await new Promise((r) => setTimeout(r, 20))
  for (const p of ['/api/agos/routes/shadow', '/api/agos/routes/shadow/link']) assert.ok(routes.has(p), p)

  assert.equal((await call(routes.get('/api/agos/routes/shadow'), 'GET', '/api/agos/routes/shadow')).status, 405)
  const skipped = await call(routes.get('/api/agos/routes/shadow'), 'POST', '/api/agos/routes/shadow', { items: ['a'], hosts: [] })
  assert.equal(skipped.status, 200); assert.equal(skipped.body.skipped, true); assert.equal(skipped.body.reason, 'NO_CANDIDATES')
  const noItems = await call(routes.get('/api/agos/routes/shadow'), 'POST', '/api/agos/routes/shadow', { items: ['  '], hosts: HOSTS })
  assert.equal(noItems.body.skipped, true); assert.equal(noItems.body.reason, 'NO_ITEMS')
  assert.equal((await readFile(audit, 'utf8')).trim(), '', '候选空/任务空都不写台账')

  const made = await call(routes.get('/api/agos/routes/shadow'), 'POST', '/api/agos/routes/shadow', { items: ['写 README'], hosts: HOSTS, chosen: ['leo-01'] })
  assert.equal(made.status, 200)
  assert.equal(made.body.mode, 'shadow'); assert.equal(made.body.source, 'fallback'); assert.equal(made.body.fallbackReason, 'NOT_CONFIGURED'); assert.equal(made.body.pick, null)
  assert.equal('task' in made.body, false)
  const id = made.body.id

  const batchId = 'b-f785f00d-8463-4369-9a02-4bf6dc7e3024'
  const secondBatchId = 'b-f785f00d-8463-4369-9a02-4bf6dc7e3025'
  const firstRun = { ev: 'dispatch', batchId, runId: 'r-1', host: 'leo-01', at: made.body.ts + 1, index: 1, taskFingerprint: taskFingerprint('写 README') }
  await writeFile(runsFile, JSON.stringify(firstRun) + '\n')
  const bad = await call(routes.get('/api/agos/routes/shadow/link'), 'POST', '/api/agos/routes/shadow/link', { ref: id, batchId: 'nope' })
  assert.equal(bad.status, 400)
  const linked = await call(routes.get('/api/agos/routes/shadow/link'), 'POST', '/api/agos/routes/shadow/link', { ref: id, batchId: 'b-f785f00d-8463-4369-9a02-4bf6dc7e3024', hosts: ['leo-01'] })
  assert.equal(linked.status, 200); assert.equal(linked.body.ev, 'shadow-link'); assert.deepEqual(linked.body.hosts, ['leo-01'])

  // 批次还没终态 → GET 不回填,但带 batchRef / actualHosts / adopted(回落行 pick null → adopted null)
  let listed = await call(routes.get('/api/agos/routes'), 'GET', '/api/agos/routes?limit=10')
  assert.equal(listed.status, 200)
  const row = listed.body.decisions.find((d) => d.id === id)
  assert.equal(row.batchRef, 'b-f785f00d-8463-4369-9a02-4bf6dc7e3024'); assert.equal(row.outcome, null); assert.equal(row.adopted, null); assert.deepEqual(row.actualHosts, ['leo-01'])
  assert.deepEqual(listed.body.stats.shadow, { total: 1, filled: 0, pending: 1, suggested: 0, agreed: 0, filledOk: 0 })
  assert.equal(listed.body.stats.cells, 0, '影子行不进 (角色,模型) 格')

  // 手工放一条「选择器成功且被采用」的影子行 + 关联,终态到了 → GET 回填 ok;回落行永远不回填
  const okId = 'dec-1787400000000-0badc0de'
  const { appendFile } = await import('node:fs/promises')
  await appendFile(audit, JSON.stringify({ id: okId, ts: 1787400000000, mode: 'shadow', taskType: 'fleet-dispatch', role: 'implementer', candidates: ['leo-01'], pick: 'leo-01', confidence: 0.7, reason: 'r', label: 'fleet-dispatch', source: 'selector', outcome: null, shadow: { chosen: ['leo-01'], agreed: true, tag: '', label: '', items: 1, taskFingerprints: [taskFingerprint('second task')] } }) + '\n')
  const secondRun = { ...firstRun, runId: 'r-2', batchId: secondBatchId, taskFingerprint: taskFingerprint('second task') }
  await appendFile(runsFile, JSON.stringify(secondRun) + '\n')
  const secondLink = await call(routes.get('/api/agos/routes/shadow/link'), 'POST', '/api/agos/routes/shadow/link', { ref: okId, batchId: secondBatchId, hosts: ['leo-01'] })
  assert.equal(secondLink.status, 200)
  await writeFile(runsFile, [
    firstRun, secondRun,
    { ev: 'end', batchId: secondBatchId, runId: 'r-2', ok: true, exit: 0, at: Date.now() },
  ].map((r) => JSON.stringify(r)).join('\n') + '\n')
  listed = await call(routes.get('/api/agos/routes'), 'GET', '/api/agos/routes?limit=10')
  const filled = listed.body.decisions.find((d) => d.id === okId)
  assert.equal(filled.outcome, 'ok'); assert.equal(filled.outcomeSource, 'fleet-end'); assert.equal(filled.adopted, true)
  assert.equal(listed.body.decisions.find((d) => d.id === id).outcome, null, '回落行不回填')
  // 手工胜负写到影子行 → 400
  const manual = await call(routes.get('/api/agos/routes/outcome'), 'POST', '/api/agos/routes/outcome', { ref: id, result: 'ok', source: 'manual' })
  assert.equal(manual.status, 400); assert.match(manual.body.error, /影子决策行只接受 fleet 终态回填/)
  assert.deepEqual(listed.body.stats.shadow, { total: 2, filled: 1, pending: 1, suggested: 1, agreed: 1, filledOk: 1 })
  const lines = readLedgerLines(audit)
  assert.equal(lines.filter((r) => r.kind === 'outcome').length, 1)
  // 再 GET 一次不重复回填
  await call(routes.get('/api/agos/routes'), 'GET', '/api/agos/routes?limit=10')
  assert.equal(readLedgerLines(audit).filter((r) => r.kind === 'outcome').length, 1)
})
