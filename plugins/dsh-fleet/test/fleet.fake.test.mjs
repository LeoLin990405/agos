// 离线:用假 ctx + 假 ssh(把 PATH 指到一个 stub ssh 脚本)验 fleet_run 的调度与结果聚合,不碰真机。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tmp = mkdtempSync(join(tmpdir(), 'dsh-fleet-'))
process.env.DSH_FLEET_SSH_STATE_DIR = join(tmp, 'ssh-state')
// stub ssh:读 stdin 当 prompt,回 "OK[<host>] <prompt前20字>"。host = 最后一个非 -o 参数。
const stubSsh = join(tmp, 'ssh')
writeFileSync(stubSsh, `#!/usr/bin/env bash
host=""
while [ $# -gt 0 ]; do case "$1" in -o) shift 2;; *) host="$1"; shift; break;; esac; done
prompt="$(cat)"
if [ "$host" = "boom" ] && [ -n "$prompt" ]; then echo "explode" >&2; exit 3; fi
echo "OK[$host] \${prompt:0:20}"
exit 0
`)
chmodSync(stubSsh, 0o755)
process.env.PATH = tmp + ':' + process.env.PATH

const { apply, Config } = await import('../lib/index.js')

function fakeCtx() {
  const tools = new Map(); const commands = new Map()
  const ctx = {
    tools: { register: (t) => { tools.set(t.name, t); return () => tools.delete(t.name) } },
    commands: { register: (c) => { commands.set(c.name, c); return () => {} } },
    systemPrompt: { section: () => () => {} },
    subagents: { start: async (_p, o) => ({ id: 'local1', result: Promise.resolve({ stopReason: 'completed', output: [{ type: 'text', text: 'LOCAL:' + o.prompt[0].text.slice(0, 10) }] }), dispose: async () => {} }) },
    get: () => undefined, inject: () => {},
  }
  return { ctx, tools }
}
const exec = { agent: { session: { id: 's' }, id: 's' }, signal: new AbortController().signal, callId: 'c' }
const HOSTS = [
  { name: 'local', kind: 'local', model: 'x', tags: ['general'], maxConcurrency: 2, enabled: true },
  { name: 'w1', kind: 'remote', ssh: 'w1', model: 'x', tags: ['tool-heavy'], maxConcurrency: 2, enabled: true },
  { name: 'w2', kind: 'remote', ssh: 'w2', model: 'x', tags: ['tool-heavy'], maxConcurrency: 2, enabled: true },
]

let caseSeq = 0
function beginCase(t, hosts = HOSTS) {
  const dir = mkdtempSync(join(tmp, `case-${++caseSeq}-`))
  process.env.DSH_FLEET_LEDGER_PATH = join(dir, 'runs.jsonl')
  process.env.DSH_FLEET_SSH_STATE_DIR = join(dir, 'ssh-state')
  const { ctx, tools } = fakeCtx()
  const dispose = apply(ctx, Config({ hosts }))
  t.after(async () => {
    await dispose()
  })
  return { ctx, tools, dispose }
}

test('fleet_run dispatches remote items across w1/w2, aggregates', async (t) => {
  const { tools } = beginCase(t)
  const out = await tools.get('fleet_run').execute({ items: ['任务甲要做的事', '任务乙要做的事', '任务丙要做的事', '任务丁要做的事'] }, exec)
  assert.match(out, /<agent_swarm_result>/)
  const meta = tools.get('fleet_run').output.presentationMeta({ items: ['a','b','c','d'] }, out)
  assert.equal(meta.subagents.length, 4)
  assert.ok(meta.subagents.every((r) => r.status === 'completed'), 'all 4 完成')
  // 4 项散在 w1/w2(remote,include_local 默认 false → 不含 local)
  const hostsUsed = new Set(meta.subagents.map((r) => r.modelLabel))
  assert.ok(hostsUsed.has('w1') && hostsUsed.has('w2'), '两台机都派到了:' + [...hostsUsed])
  assert.equal(meta.fleet.total, '4'); assert.equal(meta.fleet.done, '4')
})

test('fleet_run include_local puts some work on the in-process host', async (t) => {
  const { tools } = beginCase(t)
  const out = await tools.get('fleet_run').execute({ items: ['x1','x2','x3','x4','x5','x6'], include_local: true }, exec)
  const meta = tools.get('fleet_run').output.presentationMeta({ items: [1,2,3,4,5,6] }, out)
  assert.equal(meta.subagents.length, 6)
  assert.ok(meta.subagents.some((r) => r.modelLabel === 'local'), 'local 也分到了活')
})

test('fleet_run tag filter restricts hosts', async (t) => {
  const { tools } = beginCase(t)
  const out = await tools.get('fleet_run').execute({ items: ['a','b'], tag: 'tool-heavy' }, exec)
  const meta = tools.get('fleet_run').output.presentationMeta({ items: ['a','b'] }, out)
  assert.ok(meta.subagents.every((r) => r.modelLabel === 'w1' || r.modelLabel === 'w2'))
})

test('fleet_run surfaces a host failure as a failed row, others still complete', async (t) => {
  const { tools } = beginCase(t, [{ name: 'boom', kind: 'remote', ssh: 'boom', tags: [], maxConcurrency: 1, enabled: true }, HOSTS[1]])
  const out = await tools.get('fleet_run').execute({ items: ['t1','t2','t3','t4'] }, exec)
  const meta = tools.get('fleet_run').output.presentationMeta({ items: ['t1','t2','t3','t4'] }, out)
  const boomRows = meta.subagents.filter((r) => r.modelLabel === 'boom')
  assert.ok(boomRows.length && boomRows.every((r) => r.status === 'failed'), 'boom 的行都失败')
  assert.ok(meta.subagents.some((r) => r.modelLabel === 'w1' && r.status === 'completed'), 'w1 仍成功')
})

test('fleet_hosts reports health via probe', async (t) => {
  const { tools } = beginCase(t)
  // probe 的 stub ssh 会回 "OK[w1] " —— 不是版本号,但 exit 0 且非 NO_DSH → ok:true(stub 不模拟 dsh --version)
  const r = await tools.get('fleet_hosts').execute({}, exec)
  assert.equal(r.hosts.length, 3)
  assert.ok(r.hosts.find((h) => h.name === 'local').ok, 'local 恒健康')
})

test.after(() => {
  delete process.env.DSH_FLEET_LEDGER_PATH
  delete process.env.DSH_FLEET_SSH_STATE_DIR
  try { rmSync(tmp, { recursive: true, force: true }) } catch {}
})
