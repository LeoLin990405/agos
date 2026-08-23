// W17 影子选择器:零模型(select 全是桩)、零网络。
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  buildShadowCandidates, summarizeShadowTask, buildShadowInput, buildShadowRecord, shadowDecide,
  buildShadowLinkRecord, shadowLinks, fleetBatchStates, backfillShadowOutcomes, attachShadowLinks,
  SHADOW_MODE, SHADOW_LINK_EV, SHADOW_OUTCOME_SOURCE,
} from '../lib/shadow.js'
import { foldLedger, summarizeOutcomes, readLedgerLines } from '../lib/ledger.js'
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
  assert.match(ok.id, /^dec-\d+-[a-f0-9]{8}$/)
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

test('关联行与回填:fold 不把 shadow-link 当决策;批次全部 end 才算终态;ok 全真才 ok;已回填不重复', () => {
  const link = buildShadowLinkRecord({ ref: 'dec-1787000000000-abcdef12', batchId: 'b-f785f00d-8463-4369-9a02-4bf6dc7e3024' })
  assert.equal(link.ev, SHADOW_LINK_EV)
  assert.throws(() => buildShadowLinkRecord({ ref: 'x', batchId: 'b-1' }), /dec-/)
  assert.throws(() => buildShadowLinkRecord({ ref: 'dec-1-a', batchId: 'r-1' }), /b-/)
  const rows = [
    { id: 'dec-1787000000000-abcdef12', ts: 1, mode: 'shadow', role: 'implementer', pick: 'leo-01', taskType: 'fleet-dispatch', source: 'selector', outcome: null, shadow: { chosen: [], agreed: null } },
    { id: 'dec-1787000000000-abcdef13', ts: 2, mode: 'shadow', role: 'implementer', pick: null, taskType: 'fleet-dispatch', source: 'fallback', outcome: null, shadow: { chosen: [], agreed: null } },
    { id: 'dec-9', ts: 3, role: 'coder', pick: 'qwen3.8-max', taskType: 'coder', source: 'selector', outcome: null },
    link,
    { ev: 'shadow-link', ref: 'dec-1787000000000-abcdef13', batchId: 'b-22222222-0000-4000-8000-000000000000', at: 3 },
    { ev: 'annotate', ref: 'dec-9', note: 'n', at: 4 },
  ]
  const { decisions } = foldLedger(rows)
  assert.deepEqual(decisions.map((d) => d.id), ['dec-1787000000000-abcdef12', 'dec-1787000000000-abcdef13', 'dec-9'], 'ev 行不是决策')
  const links = shadowLinks(rows)
  assert.equal(links.get('dec-1787000000000-abcdef12'), 'b-f785f00d-8463-4369-9a02-4bf6dc7e3024')
  // 照 runs.jsonl 实测形状:dispatch 行带 host,end 行带 ok/exit
  const runs = [
    { ev: 'dispatch', batchId: 'b-f785f00d-8463-4369-9a02-4bf6dc7e3024', runId: 'r-1', host: 'knowledge-m4', at: 1 },
    { ev: 'dispatch', batchId: 'b-f785f00d-8463-4369-9a02-4bf6dc7e3024', runId: 'r-2', host: 'leo-01', at: 1 },
    { ev: 'end', batchId: 'b-f785f00d-8463-4369-9a02-4bf6dc7e3024', runId: 'r-1', ok: true, exit: 0, at: 2 },
    { ev: 'dispatch', batchId: 'b-22222222-0000-4000-8000-000000000000', runId: 'r-3', host: 'leo-01', at: 1 },
    { ev: 'end', batchId: 'b-22222222-0000-4000-8000-000000000000', runId: 'r-3', ok: false, exit: 1, at: 2 },
  ]
  const states = fleetBatchStates(runs)
  assert.deepEqual(states.get('b-f785f00d-8463-4369-9a02-4bf6dc7e3024'), { ended: false, ok: false, runs: 2, endedRuns: 1 }, 'r-2 还没 end → 未终态')
  assert.deepEqual(states.get('b-22222222-0000-4000-8000-000000000000'), { ended: true, ok: false, runs: 1, endedRuns: 1 })
  const fills = backfillShadowOutcomes({ decisions, links, batchStates: states })
  assert.equal(fills.length, 1)
  assert.equal(fills[0].ref, 'dec-1787000000000-abcdef13'); assert.equal(fills[0].result, 'fail'); assert.equal(fills[0].source, SHADOW_OUTCOME_SOURCE)
  // 回填后再算:该行 outcome 已填 → 不再产出
  const folded2 = foldLedger([...rows, ...fills])
  assert.equal(folded2.decisions[1].outcome, 'fail')
  assert.deepEqual(backfillShadowOutcomes({ decisions: folded2.decisions, links, batchStates: states }), [])
  // 非 shadow 决策即便挂了 link 也不回填
  assert.deepEqual(backfillShadowOutcomes({ decisions, links: new Map([['dec-9', 'b-22222222-0000-4000-8000-000000000000']]), batchStates: states }), [])
  const attached = attachShadowLinks(folded2.decisions, links)
  assert.equal(attached[0].batchRef, 'b-f785f00d-8463-4369-9a02-4bf6dc7e3024'); assert.equal(attached[2].batchRef, undefined)
  // 汇总:影子行单列,不进 (角色,模型) 格;后验也不吃机器
  const stats = summarizeOutcomes(folded2.decisions)
  assert.equal(stats.cells, 1, '只有 dec-9 的 coder/qwen 格')
  assert.deepEqual(stats.shadow, { total: 2, filled: 1, pending: 1, suggested: 1, agreed: 0 })
  assert.deepEqual(allocationStateFromLedger([...rows, ...fills]), [], 'fail 的影子行不进 Beta 后验')
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
  assert.equal(skipped.status, 200); assert.equal(skipped.body.skipped, true)
  assert.equal((await readFile(audit, 'utf8')).trim(), '', '候选空不写台账')

  const made = await call(routes.get('/api/agos/routes/shadow'), 'POST', '/api/agos/routes/shadow', { items: ['写 README'], hosts: HOSTS, chosen: ['leo-01'] })
  assert.equal(made.status, 200)
  assert.equal(made.body.mode, 'shadow'); assert.equal(made.body.source, 'fallback'); assert.equal(made.body.fallbackReason, 'NOT_CONFIGURED'); assert.equal(made.body.pick, null)
  assert.equal('task' in made.body, false)
  const id = made.body.id

  const bad = await call(routes.get('/api/agos/routes/shadow/link'), 'POST', '/api/agos/routes/shadow/link', { ref: id, batchId: 'nope' })
  assert.equal(bad.status, 400)
  const linked = await call(routes.get('/api/agos/routes/shadow/link'), 'POST', '/api/agos/routes/shadow/link', { ref: id, batchId: 'b-f785f00d-8463-4369-9a02-4bf6dc7e3024' })
  assert.equal(linked.status, 200); assert.equal(linked.body.ev, 'shadow-link')

  // 批次还没终态 → GET 不回填,但带 batchRef
  await writeFile(runsFile, JSON.stringify({ ev: 'dispatch', batchId: 'b-f785f00d-8463-4369-9a02-4bf6dc7e3024', runId: 'r-1', host: 'leo-01', at: 1 }) + '\n')
  let listed = await call(routes.get('/api/agos/routes'), 'GET', '/api/agos/routes?limit=10')
  assert.equal(listed.status, 200)
  const row = listed.body.decisions.find((d) => d.id === id)
  assert.equal(row.batchRef, 'b-f785f00d-8463-4369-9a02-4bf6dc7e3024'); assert.equal(row.outcome, null)
  assert.deepEqual(listed.body.stats.shadow, { total: 1, filled: 0, pending: 1, suggested: 0, agreed: 0 })
  assert.equal(listed.body.stats.cells, 0, '影子行不进 (角色,模型) 格')

  // 终态到了 → GET 回填 ok
  await writeFile(runsFile, [
    { ev: 'dispatch', batchId: 'b-f785f00d-8463-4369-9a02-4bf6dc7e3024', runId: 'r-1', host: 'leo-01', at: 1 },
    { ev: 'end', batchId: 'b-f785f00d-8463-4369-9a02-4bf6dc7e3024', runId: 'r-1', ok: true, exit: 0, at: 2 },
  ].map((r) => JSON.stringify(r)).join('\n') + '\n')
  listed = await call(routes.get('/api/agos/routes'), 'GET', '/api/agos/routes?limit=10')
  const filled = listed.body.decisions.find((d) => d.id === id)
  assert.equal(filled.outcome, 'ok'); assert.equal(filled.outcomeSource, 'fleet-end')
  assert.deepEqual(listed.body.stats.shadow, { total: 1, filled: 1, pending: 0, suggested: 0, agreed: 0 })
  const lines = readLedgerLines(audit)
  assert.equal(lines.filter((r) => r.kind === 'outcome').length, 1)
  // 再 GET 一次不重复回填
  await call(routes.get('/api/agos/routes'), 'GET', '/api/agos/routes?limit=10')
  assert.equal(readLedgerLines(audit).filter((r) => r.kind === 'outcome').length, 1)
})
