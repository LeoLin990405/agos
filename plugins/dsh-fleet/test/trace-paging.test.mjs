// 纯离线：假 ssh 返回固定 JSONL 分页，验证路由不用 seq 也不丢 session 首行。
import test from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tmp = mkdtempSync(join(tmpdir(), 'dsh-fleet-trace-paging-'))
const stubSsh = join(tmp, 'ssh')
const remoteHome = join(tmp, 'remote-home')
const commandLog = join(tmp, 'commands.log')
const traceDir = join(remoteHome, 'work', 'tasks', 'run-abc', '.trace', 'sid')
mkdirSync(traceDir, { recursive: true })
writeFileSync(join(traceDir, 'session.jsonl'), [
  '{"type":"session","version":0,"id":"sid"}',
  '{"type":"event","n":2}',
  '{"type":"event","n":3}',
  '{"type":"event","n":4}',
  '{"type":"event","n":5}',
].join('\n') + '\n')
writeFileSync(stubSsh, `#!/bin/sh
case " $* " in *" ControlMaster=auto "*" ControlPersist=60 "*) ;; *) printf 'missing ssh control options\\n' >&2; exit 98 ;; esac
while [ "$#" -gt 0 ]; do
  case "$1" in -o) shift 2 ;; *) host="$1"; shift; break ;; esac
done
cmd="$1"
printf '%s\\n---CMD---\\n' "$cmd" >> "$DSH_FLEET_TRACE_COMMAND_LOG"
case "$cmd" in
  *"find . -maxdepth 6"*)
    if [ "$DSH_FLEET_TRACE_MODE" = "unreachable" ]; then printf 'connection timed out\\n' >&2; exit 255; fi
    if [ "$DSH_FLEET_TRACE_MODE" = "missing" ]; then exit 0; fi
esac
HOME="$DSH_FLEET_TRACE_HOME" /bin/sh -c "$cmd"
`)
chmodSync(stubSsh, 0o755)
process.env.PATH = tmp + ':' + process.env.PATH
process.env.DSH_FLEET_SSH_STATE_DIR = join(tmp, 'ssh-state')
process.env.DSH_FLEET_TRACE_HOME = remoteHome
process.env.DSH_FLEET_TRACE_COMMAND_LOG = commandLog

const { apply, Config } = await import('../lib/index.js')

function makeHarness() {
  const routes = new Map()
  const webServer = { register(spec) { routes.set(spec.path, spec.handler); return () => routes.delete(spec.path) } }
  const ctx = {
    tools: { register: () => () => {} },
    commands: { register: () => () => {} },
    systemPrompt: { section: () => () => {} },
    subagents: { start: async () => { throw new Error('not used') } },
    get(name) { return name === 'webServer' ? webServer : undefined },
    inject(dependencies, callback) { assert.deepEqual(dependencies, ['webServer']); callback(ctx) },
  }
  apply(ctx, Config({ hosts: [{ name: 'fake', kind: 'remote', ssh: 'fake', tags: [], maxConcurrency: 1, enabled: true, workspace: '~/work' }] }))
  return routes.get('/api/fleet/trace')
}

async function request(handler, url, method = 'GET') {
  const response = {
    status: null,
    body: '',
    writeHead(status) { this.status = status },
    end(body) { this.body = body || '' },
  }
  await handler({ method, url }, response)
  return { status: response.status, body: JSON.parse(response.body) }
}

const handler = makeHarness()

test('trace starts at physical line 1 and returns paging metadata', async () => {
  const r = await request(handler, '/api/fleet/trace?host=fake&run=run-abc&from=1&max=2')
  assert.equal(r.status, 200)
  assert.deepEqual(r.body.lines, [
    '{"type":"session","version":0,"id":"sid"}',
    '{"type":"event","n":2}',
  ])
  assert.deepEqual({ from: r.body.from, nextFrom: r.body.nextFrom, total: r.body.total, truncated: r.body.truncated }, { from: 1, nextFrom: 3, total: 5, truncated: false })
  assert.equal(r.body.runs[0].runId, 'run-abc')
  assert.match(readFileSync(commandLog, 'utf8'), /find '\.\/run-abc\/\.trace'/, '显式 run 必须定向查找，不能依赖全局 head -200')
})

test('trace resumes by line number and exposes rotation condition', async () => {
  const page = await request(handler, '/api/fleet/trace?host=fake&run=run-abc&from=3&max=2')
  assert.deepEqual(page.body.lines, ['{"type":"event","n":3}', '{"type":"event","n":4}'])
  assert.equal(page.body.nextFrom, 5)
  assert.equal(page.body.truncated, false)

  const rotated = await request(handler, '/api/fleet/trace?host=fake&run=run-abc&from=10&max=2')
  assert.equal(rotated.body.total, 5)
  assert.equal(rotated.body.from, 10)
  assert.equal(rotated.body.nextFrom, 10)
  assert.equal(rotated.body.truncated, true)
  assert.deepEqual(rotated.body.lines, [])
  assert.ok(rotated.body.total < rotated.body.from - 1)
})

test('trace-not-created is a soft empty state and invalid input is rejected', async () => {
  process.env.DSH_FLEET_TRACE_MODE = 'missing'
  const empty = await request(handler, '/api/fleet/trace?host=fake&run=run-new')
  delete process.env.DSH_FLEET_TRACE_MODE
  assert.equal(empty.status, 200)
  assert.equal(empty.body.notice, 'trace-not-created')
  assert.deepEqual(empty.body.lines, [])
  assert.equal(empty.body.nextFrom, 1)

  assert.equal((await request(handler, '/api/fleet/trace?host=fake&run=../bad')).status, 400)
  assert.equal((await request(handler, '/api/fleet/trace?host=fake&run=' + 'a'.repeat(65))).status, 400)
  assert.equal((await request(handler, '/api/fleet/trace?host=fake&run=bad%20id')).status, 400)
  assert.equal((await request(handler, '/api/fleet/trace?host=fake&run=bad%0Aid')).status, 400)
  assert.equal((await request(handler, '/api/fleet/trace?host=fake&run=bad%3Bid')).status, 400)
  assert.equal((await request(handler, '/api/fleet/trace?host=fake&run=%24%28id%29')).status, 400)
  assert.equal((await request(handler, '/api/fleet/trace?host=fake&from=0')).status, 400)
  assert.equal((await request(handler, '/api/fleet/trace?host=fake&max=2001')).status, 400)
  assert.equal((await request(handler, '/api/fleet/trace?host=fake', 'POST')).status, 405)
})

test('unreachable worker is distinguished as 502', async () => {
  process.env.DSH_FLEET_TRACE_MODE = 'unreachable'
  const r = await request(handler, '/api/fleet/trace?host=fake&run=run-abc')
  delete process.env.DSH_FLEET_TRACE_MODE
  assert.equal(r.status, 502)
  assert.match(r.body.error, /timed out|ssh exit 255/)
})

test.after(() => {
  delete process.env.DSH_FLEET_TRACE_MODE
  delete process.env.DSH_FLEET_SSH_STATE_DIR
  delete process.env.DSH_FLEET_TRACE_HOME
  delete process.env.DSH_FLEET_TRACE_COMMAND_LOG
  try { rmSync(tmp, { recursive: true, force: true }) } catch {}
})
