// 离线：用 PATH 内的假 ssh 验 hosts 路由缓存与可选工作区计数，绝不连接真机。
import test from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tmp = mkdtempSync(join(tmpdir(), 'dsh-fleet-hosts-'))
process.env.DSH_FLEET_LEDGER_PATH = join(tmp, 'runs.jsonl')
process.env.DSH_FLEET_SSH_STATE_DIR = join(tmp, 'ssh-state')
const sshLog = join(tmp, 'ssh.log')
const stubSsh = join(tmp, 'ssh')
writeFileSync(stubSsh, `#!/bin/sh
printf 'call\\n' >> "$DSH_FLEET_SSH_LOG"
case "$*" in
  *"dsh --version"*) printf 'dsh-test-1.0\\n' ;;
  *"wc -l"*)
    if [ "$DSH_FLEET_WS_FAIL" = "1" ]; then printf 'count failed\\n' >&2; exit 23; fi
    printf '7\\n'
    ;;
  *) printf '\\n' ;;
esac
exit 0
`)
chmodSync(stubSsh, 0o755)
process.env.PATH = tmp + ':' + process.env.PATH
process.env.DSH_FLEET_SSH_LOG = sshLog

const { apply, Config } = await import('../lib/index.js')

function makeHarness() {
  const routes = new Map()
  const webServer = {
    register(spec) {
      routes.set(spec.path, spec.handler)
      return () => routes.delete(spec.path)
    },
  }
  const ctx = {
    tools: { register: () => () => {} },
    commands: { register: () => () => {} },
    systemPrompt: { section: () => () => {} },
    subagents: { start: async () => { throw new Error('not used') } },
    get(name) { return name === 'webServer' ? webServer : undefined },
    inject(dependencies, callback) {
      assert.deepEqual(dependencies, ['webServer'])
      return callback(ctx)
    },
  }
  apply(ctx, Config({
    hosts: [{
      name: 'fake-remote', kind: 'remote', ssh: 'fake-remote', model: 'fake',
      tags: ['test'], maxConcurrency: 1, enabled: true, workspace: '~/fake-workspace',
    }],
  }))
  return routes.get('/api/fleet/hosts')
}

async function request(handler, url, method = 'GET') {
  const response = {
    status: null,
    headers: null,
    body: '',
    writeHead(status, headers) { this.status = status; this.headers = headers },
    end(body) { this.body = body || '' },
  }
  await handler({ method, url }, response)
  return { status: response.status, body: JSON.parse(response.body) }
}

function sshCalls() {
  try { return readFileSync(sshLog, 'utf8').trim().split('\n').filter(Boolean).length } catch { return 0 }
}

test('hosts route caches probes for 60s, refresh bypasses cache, and ws count is opt-in', async () => {
  const handler = makeHarness()
  const realNow = Date.now
  let now = 1_000_000
  Date.now = () => now
  try {
    const [first, concurrent] = await Promise.all([
      request(handler, '/api/fleet/hosts'),
      request(handler, '/api/fleet/hosts'),
    ])
    assert.equal(first.status, 200)
    assert.equal(concurrent.status, 200)
    assert.equal(first.body.hosts[0].version, 'dsh-test-1.0')
    assert.equal(Object.hasOwn(first.body.hosts[0], 'wsFiles'), false)
    assert.equal(sshCalls(), 1, '冷缓存并发请求必须合并为一次健康探测')

    await request(handler, '/api/fleet/hosts')
    assert.equal(sshCalls(), 1, 'TTL 内不得重复健康探测')

    const withWorkspace = await request(handler, '/api/fleet/hosts?ws=1')
    assert.equal(withWorkspace.body.hosts[0].wsFiles, 7)
    assert.equal(sshCalls(), 2, 'ws=1 只额外做一次工作区计数')

    process.env.DSH_FLEET_WS_FAIL = '1'
    const unreadableWorkspace = await request(handler, '/api/fleet/hosts?ws=1')
    delete process.env.DSH_FLEET_WS_FAIL
    assert.equal(unreadableWorkspace.body.hosts[0].wsFiles, null)
    assert.equal(sshCalls(), 3, '工作区计数失败要保留 null 真值')

    await request(handler, '/api/fleet/hosts?refresh=1')
    assert.equal(sshCalls(), 4, 'refresh=1 强制重新探测但不隐式数文件')

    now += 59_999
    await request(handler, '/api/fleet/hosts')
    assert.equal(sshCalls(), 4, '60s TTL 未满时仍命中缓存')

    now += 1
    await request(handler, '/api/fleet/hosts')
    assert.equal(sshCalls(), 5, '缓存到期后重新探测')

    const rejected = await request(handler, '/api/fleet/hosts', 'POST')
    assert.equal(rejected.status, 405)
    assert.equal(sshCalls(), 5)
  } finally {
    Date.now = realNow
  }
})

test.after(() => {
  delete process.env.DSH_FLEET_LEDGER_PATH
  delete process.env.DSH_FLEET_SSH_STATE_DIR
  delete process.env.DSH_FLEET_SSH_LOG
  delete process.env.DSH_FLEET_WS_FAIL
  try { rmSync(tmp, { recursive: true, force: true }) } catch {}
})
