import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer, request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import test from 'node:test'

import { createCodexHostRunner } from '../lib/fleet-codex.mjs'
import { createArtifactHandlers } from '../lib/fleet-artifacts.mjs'
import { apply, Config } from '../lib/index.js'

const waitUntil = async (predicate, message, timeoutMs = 3000) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await predicate()
    if (value) return value
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  assert.fail(message)
}

const jsonRequest = async (handler, { method = 'GET', url = '/', body } = {}) => {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))])
  req.method = method
  req.url = url
  req.headers = body === undefined ? {} : { 'content-type': 'application/json' }
  const res = {
    status: null, headers: {}, text: '',
    writeHead(status, headers = {}) { this.status = status; this.headers = headers },
    end(value = '') { this.text += String(value); this.writableEnded = true },
  }
  await handler(req, res)
  return { status: res.status, headers: res.headers, body: res.text ? JSON.parse(res.text) : null }
}

const httpGet = (port, path) => new Promise((resolve, reject) => {
  const req = httpRequest({ host: '127.0.0.1', port, path }, (res) => {
    const chunks = []
    res.on('data', (chunk) => chunks.push(chunk))
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }))
  })
  req.on('error', reject)
  req.end()
})

test('Codex adapter pins safe thread options, persists final output, and forwards abort', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-fleet-codex-adapter-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const calls = []
  let blockingSignal
  class FakeCodex {
    constructor(options) { calls.push(['client', options]) }
    startThread(options) {
      calls.push(['thread', options])
      return {
        run(prompt, { signal }) {
          calls.push(['run', prompt, signal])
          if (prompt === 'BLOCK' || prompt === 'TIMEOUT') {
            blockingSignal = signal
            return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted by fake SDK')), { once: true }))
          }
          return Promise.resolve({ finalResponse: 'FINAL sk-abcdefghijklmnop', items: [], usage: null })
        },
      }
    }
  }
  const runner = createCodexHostRunner({
    loadSdk: async () => ({ Codex: FakeCodex }),
    scrubSecrets: (value) => String(value).replace(/sk-[A-Za-z0-9_-]+/g, '«redacted»'),
  })
  const host = { name: 'codex', kind: 'codex', model: 'gpt-test', workspace: root }
  const completed = await runner.run(host, 'SHORT', new AbortController().signal, { runId: 'r-ok', timeoutMs: 1000 })
  assert.equal(completed.ok, true)
  assert.equal(completed.text, 'FINAL «redacted»')
  assert.equal(readFileSync(join(root, 'tasks', 'r-ok', 'out.txt'), 'utf8'), 'FINAL «redacted»')
  assert.equal(readFileSync(join(root, 'tasks', 'r-ok', 'exit'), 'utf8'), '0')
  assert.deepEqual(calls.find(([kind]) => kind === 'thread')[1], {
    model: 'gpt-test', workingDirectory: realpathSync(join(root, 'tasks', 'r-ok')),
    sandboxMode: 'workspace-write', approvalPolicy: 'never', skipGitRepoCheck: true,
    networkAccessEnabled: false, webSearchMode: 'disabled',
  })
  const clientOptions = calls.find(([kind]) => kind === 'client')[1]
  assert.equal(clientOptions.env.HOME.length > 0, true)
  assert.equal(Object.hasOwn(clientOptions.env, 'OPENAI_API_KEY'), false)
  assert.equal(clientOptions.config.shell_environment_policy.inherit, 'none')
  assert.equal(clientOptions.config.shell_environment_policy.set.HOME, realpathSync(join(root, 'tasks', 'r-ok')))
  assert.equal(clientOptions.config.sandbox_workspace_write.network_access, false)

  const controller = new AbortController()
  const pending = runner.run(host, 'BLOCK', controller.signal, { runId: 'r-cancel', timeoutMs: 1000 })
  await waitUntil(() => blockingSignal, 'fake SDK did not receive a signal')
  controller.abort('user cancel')
  const cancelled = await pending
  assert.equal(blockingSignal.aborted, true)
  assert.equal(cancelled.cancelled, true)
  assert.equal(cancelled.exit, 130)
  assert.equal(readFileSync(join(root, 'tasks', 'r-cancel', 'exit'), 'utf8'), '130')

  const timedOut = await runner.run(host, 'TIMEOUT', new AbortController().signal, { runId: 'r-timeout', timeoutMs: 10 })
  assert.equal(timedOut.timedOut, true)
  assert.equal(timedOut.exit, 124)
  assert.equal(readFileSync(join(root, 'tasks', 'r-timeout', 'exit'), 'utf8'), '124')

  blockingSignal = null
  const runtimeTimeout = new AbortController()
  const runtimePending = runner.run(host, 'TIMEOUT', runtimeTimeout.signal, { runId: 'r-runtime-timeout', timeoutMs: 1000 })
  await waitUntil(() => blockingSignal, 'fake SDK did not receive the runtime timeout signal')
  runtimeTimeout.abort('TIMEOUT')
  const runtimeTimedOut = await runtimePending
  assert.equal(runtimeTimedOut.timedOut, true)
  assert.equal(runtimeTimedOut.cancelled, undefined)
  assert.equal(runtimeTimedOut.exit, 124)
})

test('Codex local artifact root rejects symlinked workspace, tasks, and run directories', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-fleet-codex-root-gates-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const workspace = join(root, 'workspace')
  const runId = 'r-safe'
  mkdirSync(join(workspace, 'tasks', runId), { recursive: true })
  writeFileSync(join(workspace, 'tasks', runId, 'out.txt'), 'ok')
  const linkedWorkspace = join(root, 'linked-workspace')
  symlinkSync(workspace, linkedWorkspace)
  const linkedTasksWorkspace = join(root, 'linked-tasks-workspace')
  mkdirSync(linkedTasksWorkspace)
  symlinkSync(join(workspace, 'tasks'), join(linkedTasksWorkspace, 'tasks'))
  symlinkSync(join(workspace, 'tasks', runId), join(workspace, 'tasks', 'r-linked'))
  const hosts = [
    { name: 'workspace-link', kind: 'codex', workspace: linkedWorkspace },
    { name: 'tasks-link', kind: 'codex', workspace: linkedTasksWorkspace },
    { name: 'run-link', kind: 'codex', workspace },
  ]
  let sshCalls = 0
  const handlers = createArtifactHandlers({
    hostsOf: () => hosts,
    wsOf: (host) => host.workspace,
    sshRead: async () => { sshCalls++; throw new Error('ssh forbidden') },
    spawnSsh: () => { sshCalls++; throw new Error('ssh forbidden') },
  })
  for (const [host, run] of [['workspace-link', runId], ['tasks-link', runId], ['run-link', 'r-linked']]) {
    const response = await jsonRequest(handlers.manifestHandler, { url: `/api/fleet/artifacts?host=${host}&run=${run}` })
    assert.equal(response.status, 404)
    assert.equal(response.body.error, 'run not found')
  }
  assert.equal(sshCalls, 0)
})

test('Codex is opt-in, then uses the shared runtime and exposes local artifacts without ssh', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-fleet-codex-integration-'))
  const workspace = join(root, 'codex-workspace')
  process.env.DSH_FLEET_LEDGER_PATH = join(root, 'runs.jsonl')
  process.env.DSH_FLEET_SSH_STATE_DIR = join(root, 'ssh-state')
  let starts = 0
  let aborts = 0
  let releaseSlowAbort
  class FakeCodex {
    startThread(options) {
      return {
        run(prompt, { signal }) {
          starts += 1
          assert.equal(options.workingDirectory.startsWith(realpathSync(join(workspace, 'tasks')) + '/'), true)
          if (prompt === 'BLOCK' || prompt === 'BLOCK-SLOW-CANCEL') {
            return new Promise((_resolve, reject) => signal.addEventListener('abort', () => {
              aborts += 1
              if (prompt === 'BLOCK-SLOW-CANCEL') releaseSlowAbort = () => reject(new Error('cancelled'))
              else reject(new Error('cancelled'))
            }, { once: true }))
          }
          return Promise.resolve({ finalResponse: `CODEX:${prompt}`, items: [], usage: null })
        },
      }
    }
  }
  const codexRunner = createCodexHostRunner({ loadSdk: async () => ({ Codex: FakeCodex }) })
  const routes = new Map()
  const tools = new Map()
  const providers = []
  const webServer = {
    register(spec) { const key = `${spec.kind}:${spec.path}`; routes.set(key, spec.handler); return () => routes.delete(key) },
  }
  const ctx = {
    tools: { register(tool) { tools.set(tool.name, tool); return () => tools.delete(tool.name) } },
    commands: { register: () => () => {} },
    systemPrompt: { section: () => () => {} },
    subagents: { registerProvider(provider) { providers.push(provider.name) }, list: () => [] },
    get(name) { return name === 'webServer' ? webServer : undefined },
    inject(_dependencies, callback) { const cleanup = callback(ctx); return () => cleanup?.() },
  }
  const dispose = apply(ctx, Config({
    hosts: [{ name: 'codex', kind: 'codex', model: '', tags: ['codex'], maxConcurrency: 1, enabled: true, workspace }],
    globalMaxConcurrency: 1,
    powerNodes: {},
  }), { codexRunner })
  let disposed = false
  t.after(async () => {
    if (!disposed) await dispose()
    delete process.env.DSH_FLEET_LEDGER_PATH
    delete process.env.DSH_FLEET_SSH_STATE_DIR
    rmSync(root, { recursive: true, force: true })
  })

  const dispatch = routes.get('exact:/api/fleet/dispatch')
  const batch = routes.get('exact:/api/fleet/batch')
  const cancel = routes.get('exact:/api/fleet/cancel')
  assert.equal(typeof dispatch, 'function')
  assert.deepEqual(providers, [], 'Codex must not register a fleet:* provider auto-offload bypass')

  const implicit = await jsonRequest(dispatch, { method: 'POST', body: { items: ['MUST-NOT-RUN'], wake: false } })
  assert.equal(implicit.status, 503)
  assert.equal(starts, 0, 'default UI allocation must not spend Codex quota')
  await assert.rejects(() => tools.get('fleet_run').execute(
    { items: ['MUST-NOT-RUN'] },
    { agent: undefined, signal: new AbortController().signal, callId: 'implicit-tool' },
  ), /没有可用的机/)
  assert.equal(starts, 0, 'default fleet_run allocation must not spend Codex quota')

  const accepted = await jsonRequest(dispatch, {
    method: 'POST', body: { items: ['SHORT'], hosts: ['codex'], wake: false },
  })
  assert.equal(accepted.status, 202)
  assert.equal(accepted.body.runs[0].kind, 'codex')
  const runId = accepted.body.runs[0].runId
  const detail = await waitUntil(async () => {
    const value = await jsonRequest(batch, { url: `/api/fleet/batch?id=${accepted.body.batchId}` })
    return value.body?.runs?.[0]?.status === 'completed' ? value : null
  }, 'Codex batch did not complete')
  assert.equal(detail.body.runs[0].kind, 'codex')
  assert.equal(detail.body.runs[0].resultText, 'CODEX:SHORT')

  const server = createServer((req, res) => {
    const handler = req.url.startsWith('/api/fleet/artifacts')
      ? routes.get('exact:/api/fleet/artifacts')
      : routes.get('prefix:/fleet')
    void handler(req, res)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const port = server.address().port
  const manifest = await httpGet(port, `/api/fleet/artifacts?host=codex&run=${runId}`)
  assert.equal(manifest.status, 200)
  assert.deepEqual(JSON.parse(manifest.body).files.map((file) => file.path), ['out.txt'])
  const file = await httpGet(port, `/fleet/artifact/file?host=codex&run=${runId}&path=out.txt`)
  assert.equal(file.status, 200)
  assert.equal(file.body.toString('utf8'), 'CODEX:SHORT')
  const outside = join(root, 'outside.txt')
  writeFileSync(outside, 'must not escape')
  symlinkSync(outside, join(workspace, 'tasks', runId, 'outside-link'))
  symlinkSync(root, join(workspace, 'tasks', runId, 'escape-dir'))
  const guardedManifest = await httpGet(port, `/api/fleet/artifacts?host=codex&run=${runId}`)
  assert.deepEqual(JSON.parse(guardedManifest.body).files.map((entry) => entry.path), ['out.txt'])
  assert.equal((await httpGet(port, `/fleet/artifact/file?host=codex&run=${runId}&path=outside-link`)).status, 404)
  assert.equal((await httpGet(port, `/fleet/artifact/file?host=codex&run=${runId}&path=escape-dir%2Foutside.txt`)).status, 404)
  const archive = await httpGet(port, `/fleet/artifact/tgz?host=codex&run=${runId}`)
  assert.equal(archive.status, 200)
  assert.deepEqual(execFileSync('tar', ['-tzf', '-'], { input: archive.body }).toString('utf8').trim().split('\n'), ['./out.txt'])

  const live = await jsonRequest(dispatch, {
    method: 'POST', body: { items: ['BLOCK'], tag: 'codex', wake: false },
  })
  assert.equal(live.status, 202)
  await waitUntil(async () => {
    const value = await jsonRequest(batch, { url: `/api/fleet/batch?id=${live.body.batchId}` })
    return value.body?.runs?.[0]?.status === 'running'
  }, 'blocking Codex run did not start')
  const cancelled = await jsonRequest(cancel, {
    method: 'POST', body: { runId: live.body.runs[0].runId, host: 'codex' },
  })
  assert.equal(cancelled.status, 200)
  assert.equal(cancelled.body.skipped[0].reason, 'controller')
  await waitUntil(async () => {
    const value = await jsonRequest(batch, { url: `/api/fleet/batch?id=${live.body.batchId}` })
    return value.body?.runs?.[0]?.status === 'cancelled'
  }, 'Codex cancellation was not confirmed')
  assert.equal(aborts, 1, 'runtime cancellation must abort the SDK signal once')

  const orphan = await jsonRequest(dispatch, {
    method: 'POST', body: { items: ['BLOCK-SLOW-CANCEL'], hosts: ['codex'], wake: false },
  })
  assert.equal(orphan.status, 202)
  await waitUntil(async () => {
    const value = await jsonRequest(batch, { url: `/api/fleet/batch?id=${orphan.body.batchId}` })
    return value.body?.runs?.[0]?.status === 'running'
  }, 'Codex run for dispose did not start')
  let disposeSettled = false
  const disposing = dispose().then(() => { disposeSettled = true })
  await waitUntil(() => releaseSlowAbort, 'dispose did not abort the live SDK turn')
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(disposeSettled, false, 'dispose must await the SDK runner terminal settlement')
  releaseSlowAbort()
  await disposing
  disposed = true
  assert.equal(aborts, 2, 'plugin dispose must abort and await the live SDK turn')
  const events = readFileSync(process.env.DSH_FLEET_LEDGER_PATH, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
  assert.equal(events.some((event) => event.ev === 'cancel' && event.runId === orphan.body.runs[0].runId), true)
})
