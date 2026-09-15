// `/api/fleet/ws?path=…`(40KB 预览)的**判决透出**测试。
//
// 为什么单独一份:这条路由在 lib/index.js 里,而 E 那一轮只改了 fleet-artifacts.mjs,
// 明确交回来说「index.js 我没碰,它会把拒绝吞成空的 200」。原因是那行写的是
//     sshRead(h, '(' + buildArtifactFileCommand(target) + ') | head -c 40000')
// 管道的退出码是 **head 的**,所以远端 `exit 9`(拒绝)传不出来 —— 操作者拿到
// 200 + 空 content,分不清「产物本来是空的」和「产物被安全守卫拒了」。
// 不泄漏根外内容(字节那趟本来就绑描述符),但它不诚实。
//
// 这份文件从**真实路由 handler** 走,stub ssh 用 /bin/sh 真跑生成的命令,
// 打在临时目录搭的假远端树上。只读合成根外 sentinel,不连真机、不读真实文件。

import test from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, linkSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tmp = mkdtempSync(join(tmpdir(), 'dsh-fleet-ws-verdict-'))
process.env.DSH_FLEET_LEDGER_PATH = join(tmp, 'runs.jsonl')
process.env.DSH_FLEET_SSH_STATE_DIR = join(tmp, 'ssh-state')

// ── 假远端树 ──────────────────────────────────────────────────────────────
// workspace/tasks/<runId>/ 下放产物;sentinel 放在 workspace **之外**,
// 只有守卫失效时才可能被读到 —— 它是「泄漏了没有」的唯一判据。
const workspace = join(tmp, 'remote-ws')
const RUN = 'run-abcdef0123456789'
const runDir = join(workspace, 'tasks', RUN)
mkdirSync(runDir, { recursive: true })
writeFileSync(join(runDir, 'legit.txt'), 'legit preview body\n')
const sentinel = join(tmp, 'outside-sentinel.txt')
writeFileSync(sentinel, 'AGOS-SENTINEL-OUTSIDE-ROOT\n')

// 预埋两种攻击:符号链接指向根外,以及硬链接到根外内容(nlink>1)。
symlinkSync(sentinel, join(runDir, 'via-symlink.txt'))
linkSync(sentinel, join(runDir, 'via-hardlink.txt'))

// stub ssh:把命令交给真 /bin/sh 执行。远端行为因此是真的 —— 守卫、fstat、
// 判决行全部实际跑过,而不是由测试假装返回。
const stubSsh = join(tmp, 'ssh')
writeFileSync(stubSsh, '#!/bin/sh\n'
  + '# 参数尾部是要在"远端"执行的命令;前面是 ssh 自己的选项与 host。\n'
  + 'cmd=""\n'
  + 'for a in "$@"; do cmd="$a"; done\n'
  + 'exec /bin/sh -c "$cmd"\n')
chmodSync(stubSsh, 0o755)
process.env.PATH = tmp + ':' + process.env.PATH

const { apply, Config } = await import('../lib/index.js')

/** 真实路由表:走 index.js 的 apply,不重实现路由逻辑。 */
function bootRoutes() {
  const routes = new Map()
  const webServer = {
    register(spec) { routes.set(spec.path, spec.handler); return () => routes.delete(spec.path) },
  }
  const ctx = {
    tools: { register: () => () => {} },
    commands: { register: () => () => {} },
    systemPrompt: { section: () => () => {} },
    subagents: { start: async () => { throw new Error('not used') } },
    get(name) { return name === 'webServer' ? webServer : undefined },
    inject(_deps, callback) { return callback(ctx) },
  }
  apply(ctx, Config({
    hosts: [{
      name: 'fake-remote', kind: 'remote', ssh: 'fake-remote', model: 'fake',
      tags: ['test'], maxConcurrency: 1, enabled: true, workspace,
    }],
  }))
  const handler = routes.get('/api/fleet/ws')
  assert.equal(typeof handler, 'function', 'missing /api/fleet/ws route')
  return handler
}

async function preview(handler, path) {
  const url = `/api/fleet/ws?host=fake-remote&run=${RUN}&path=${encodeURIComponent(path)}`
  const response = {
    status: null,
    body: '',
    writeHead(status) { this.status = status },
    end(body) { this.body = body || '' },
  }
  await handler({ method: 'GET', url }, response)
  return { status: response.status, body: response.body ? JSON.parse(response.body) : undefined }
}

// ── 正控:合法产物照旧读到 ──────────────────────────────────────────────────

test('合法产物:预览返回 200 与真实内容(判决透出不是"一律拒绝"式假修复)', async () => {
  const r = await preview(bootRoutes(), 'legit.txt')
  assert.equal(r.status, 200, `合法读被误拒:${JSON.stringify(r.body)}`)
  assert.equal(r.body.content, 'legit preview body\n')
  assert.equal(r.body.runId, RUN)
})

// ── 拒绝必须是状态码,不是空的 200 ─────────────────────────────────────────

test('硬链接到根外内容:409 且点明理由,而不是 200 + 空 content', async () => {
  const r = await preview(bootRoutes(), 'via-hardlink.txt')
  // 旧写法(管进 head)在这里给的是 200 + content:''。那是本条要钉死的行为。
  assert.equal(r.status, 409, `拒绝被吞成 ${r.status}:${JSON.stringify(r.body)}`)
  assert.match(r.body.error, /artifact refused/)
  assert.match(r.body.error, /hard-links/, '要说出是哪条守卫拒的')
  assert.equal(r.body.content, undefined, '拒绝的响应里不许带 content 字段')
})

test('符号链接指向根外:404,同样不是空的 200', async () => {
  const r = await preview(bootRoutes(), 'via-symlink.txt')
  assert.equal(r.status, 404, `拒绝被吞成 ${r.status}:${JSON.stringify(r.body)}`)
  assert.equal(r.body.content, undefined)
})

test('根外 sentinel 从不出现在任何预览响应里', async () => {
  const handler = bootRoutes()
  for (const path of ['legit.txt', 'via-symlink.txt', 'via-hardlink.txt', 'absent.txt']) {
    const r = await preview(handler, path)
    assert.ok(!JSON.stringify(r).includes('AGOS-SENTINEL'),
      `${path} 的响应里出现了根外内容:${JSON.stringify(r)}`)
  }
})

test('预览是单次远端执行 —— 没有 probe 可以被抢在中间替换', async () => {
  // 旧写法是 probe + read 两趟 SSH,两趟之间叶子可被替换。计数走 stub ssh 的调用日志。
  const log = join(tmp, 'ssh-count.log')
  writeFileSync(log, '')
  const counting = join(tmp, 'ssh')
  writeFileSync(counting, '#!/bin/sh\n'
    + `printf 'call\\n' >> ${JSON.stringify(log)}\n`
    + 'cmd=""\n'
    + 'for a in "$@"; do cmd="$a"; done\n'
    + 'exec /bin/sh -c "$cmd"\n')
  chmodSync(counting, 0o755)
  const r = await preview(bootRoutes(), 'legit.txt')
  assert.equal(r.status, 200)
  const calls = (await import('node:fs')).readFileSync(log, 'utf8').split('\n').filter(Boolean).length
  assert.equal(calls, 1, `预览应当只有一次远端执行,实际 ${calls} 次`)
})

test('预览确实被截断到 40000 字节(上限作用在已持有的描述符上)', async () => {
  // 造一个大于上限的产物:内容必须被截断,而不是整份读回来,也不是被判失败。
  writeFileSync(join(runDir, 'big.txt'), 'x'.repeat(50_000))
  const r = await preview(bootRoutes(), 'big.txt')
  assert.equal(r.status, 200, `大产物被误拒:${JSON.stringify(r.body)}`)
  assert.equal(r.body.content.length, 40_000, `应截断到 40000,实际 ${r.body.content.length}`)
})
