// Purely offline: shell commands run against a temporary local fixture and the
// HTTP surface uses injected local stubs. No invocation can reach ssh.
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdtempSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer, request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { test } from 'node:test'
import {
  ARTIFACT_MAX_BYTES,
  ARTIFACT_MAX_FILES,
  artifactLimitError,
  artifactRunDir,
  buildArtifactFileCommand,
  buildArtifactFileProbeCommand,
  buildArtifactManifestCommand,
  buildArtifactTgzCommand,
  contentDisposition,
  createArtifactHandlers,
  isExcludedArtifactPath,
  parseArtifactFileProbe,
  parseArtifactManifest,
  safeRelPath,
  validateRunId,
} from '../lib/fleet-artifacts.mjs'

const root = mkdtempSync(join(tmpdir(), 'dsh-fleet-artifacts-'))
const workspace = join(root, 'workspace with spaces')
const runId = 'run_2026-08-21'
const runDir = join(workspace, 'tasks', runId)
mkdirSync(join(runDir, 'nested'), { recursive: true })
mkdirSync(join(runDir, '.trace', 'session'), { recursive: true })
mkdirSync(join(runDir, 'nested', '.trace'), { recursive: true })
const text = Buffer.from('中文 UTF-8 report\n', 'utf8')
const binary = Buffer.from([0x41, 0x00, 0xff, 0x42])
writeFileSync(join(runDir, 'report.md'), text)
writeFileSync(join(runDir, 'nested', 'payload.bin'), binary)
writeFileSync(join(runDir, 'pid'), '123')
writeFileSync(join(runDir, 'exit'), '0')
writeFileSync(join(runDir, 'err.txt'), 'Bearer should-never-leak')
writeFileSync(join(runDir, '.trace', 'session', 'session.jsonl'), '{}\n')
writeFileSync(join(runDir, 'nested', '.trace', 'secret.jsonl'), 'Bearer hidden')
writeFileSync(join(runDir, 'nested', 'pid'), '456')
writeFileSync(join(root, 'outside.txt'), 'outside')
symlinkSync(join(root, 'outside.txt'), join(runDir, 'outside-link'))
symlinkSync(root, join(runDir, 'escape-dir'))

const runShell = (command) => execFileSync('/bin/sh', ['-c', command])

test('run id and relative path gates pin requests below one run', () => {
  for (const good of ['a', 'A_1-2', 'x'.repeat(64)]) assert.equal(validateRunId(good), true)
  for (const bad of ['', 'x'.repeat(65), '../run', 'a/b', 'white space', 'a\n']) assert.equal(validateRunId(bad), false)
  assert.equal(artifactRunDir('~/dsh-workspace/', 'r-1'), '~/dsh-workspace/tasks/r-1')

  for (const [raw, expected] of [
    ['report.md', 'report.md'], ['./a/b.txt', 'a/b.txt'], ['a..b', 'a..b'], ["it's.txt", "it's.txt"],
  ]) assert.equal(safeRelPath(raw), expected)
  for (const raw of ['/etc/passwd', '~/.ssh/id_rsa', '../x', 'a/../../x', 'C:\\x', 'D:/x', '', '.', 'a\0b', 'a\nb']) {
    assert.equal(safeRelPath(raw), null)
  }
  for (const path of ['pid', 'nested/pid', 'exit', 'err.txt', '.trace/x', 'a/.trace/x']) assert.equal(isExcludedArtifactPath(path), true)
  assert.equal(isExcludedArtifactPath('report.md'), false)
})

test('manifest is exact, NUL-aware, and excludes controls, trace, and symlinks', () => {
  const raw = runShell(buildArtifactManifestCommand({ workspace, runId })).toString('utf8')
  const parsed = parseArtifactManifest(raw, { host: 'fake', runId, runDir })
  assert.equal(parsed.ok, true)
  assert.equal(parsed.value.count, 2)
  assert.equal(parsed.value.totalBytes, text.length + binary.length)
  assert.equal(parsed.value.truncated, false)
  assert.deepEqual(parsed.value.excluded, ['pid', 'exit', 'err.txt', '.trace/**'])
  assert.deepEqual(parsed.value.files.map((file) => file.path).sort(), ['nested/payload.bin', 'report.md'])
  assert.equal(parsed.value.files.find((file) => file.path === 'report.md').binary, false, 'UTF-8 high bytes are text')
  assert.equal(parsed.value.files.find((file) => file.path === 'nested/payload.bin').binary, true, 'NUL marks binary')
})

test('missing and symlinked run directories are indistinguishable 404s', () => {
  const missing = runShell(buildArtifactManifestCommand({ workspace, runId: 'missing' })).toString('utf8')
  assert.deepEqual(parseArtifactManifest(missing), { ok: false, status: 404, error: 'run not found' })
  symlinkSync(runDir, join(workspace, 'tasks', 'linked-run'))
  const linked = runShell(buildArtifactManifestCommand({ workspace, runId: 'linked-run' })).toString('utf8')
  assert.deepEqual(parseArtifactManifest(linked), { ok: false, status: 404, error: 'run not found' })

  const linkedWorkspace = join(root, 'linked-workspace')
  symlinkSync(workspace, linkedWorkspace)
  const workspaceLink = runShell(buildArtifactManifestCommand({ workspace: linkedWorkspace, runId })).toString('utf8')
  assert.deepEqual(parseArtifactManifest(workspaceLink), { ok: false, status: 404, error: 'run not found' })

  const linkedTasksWorkspace = join(root, 'linked-tasks-workspace')
  mkdirSync(linkedTasksWorkspace)
  symlinkSync(join(workspace, 'tasks'), join(linkedTasksWorkspace, 'tasks'))
  const tasksLink = runShell(buildArtifactManifestCommand({ workspace: linkedTasksWorkspace, runId })).toString('utf8')
  assert.deepEqual(parseArtifactManifest(tasksLink), { ok: false, status: 404, error: 'run not found' })
})

test('file helpers accept only regular files with no symlink in any segment', () => {
  const goodProbe = runShell(buildArtifactFileProbeCommand({ workspace, runId, path: 'nested/payload.bin' })).toString('utf8')
  assert.deepEqual(parseArtifactFileProbe(goodProbe).value.size, binary.length)
  assert.deepEqual(runShell(buildArtifactFileCommand({ workspace, runId, path: 'nested/payload.bin' })), binary)

  const leafLink = runShell(buildArtifactFileProbeCommand({ workspace, runId, path: 'outside-link' })).toString('utf8')
  assert.deepEqual(parseArtifactFileProbe(leafLink), { ok: false, status: 404, error: 'artifact not found' })
  const segmentLink = runShell(buildArtifactFileProbeCommand({ workspace, runId, path: 'escape-dir/outside.txt' })).toString('utf8')
  assert.deepEqual(parseArtifactFileProbe(segmentLink), { ok: false, status: 404, error: 'artifact not found' })
  for (const path of ['pid', 'err.txt', '.trace/session/session.jsonl']) {
    assert.throws(() => buildArtifactFileCommand({ workspace, runId, path }), /invalid artifact path/)
  }
})

test('2001st detail is only a sentinel while the summary stays authoritative', () => {
  const details = Array.from({ length: 2001 }, (_, i) => `F\t1\t1\t0\t./f-${i}.txt`).join('\n')
  const parsed = parseArtifactManifest(`S\t2400\t9999\n${details}\n`, { host: 'h', runId: 'r', runDir: '/r' })
  assert.equal(parsed.ok, true)
  assert.equal(parsed.value.files.length, 2000)
  assert.equal(parsed.value.count, 2400)
  assert.equal(parsed.value.totalBytes, 9999)
  assert.equal(parsed.value.truncated, true)
})

test('archive limit is inclusive and reports truthful count and bytes', () => {
  assert.equal(artifactLimitError({ count: ARTIFACT_MAX_FILES, totalBytes: ARTIFACT_MAX_BYTES }), null)
  assert.deepEqual(artifactLimitError({ count: ARTIFACT_MAX_FILES + 1, totalBytes: 7 }), {
    error: 'artifact set too large', totalBytes: 7, count: 2001, hint: '用 /fleet/artifact/file 单取',
  })
  assert.equal(artifactLimitError({ count: 1, totalBytes: ARTIFACT_MAX_BYTES + 1 }).error, 'artifact set too large')
})

test('tgz contains regular artifacts only', () => {
  const archive = runShell(buildArtifactTgzCommand({ workspace, runId }))
  const listing = execFileSync('tar', ['-tzf', '-'], { input: archive }).toString('utf8').trim().split('\n').sort()
  assert.deepEqual(listing, ['./nested/payload.bin', './report.md'])
})

test('manifest and tgz consistently exclude newline-bearing names that cannot pass safeRelPath', () => {
  const oddRun = 'odd-run'
  const oddRunDir = join(workspace, 'tasks', oddRun)
  const oddName = 'line\n--checkpoint-action=exec=sh'
  mkdirSync(oddRunDir)
  writeFileSync(join(oddRunDir, oddName), 'safe')
  writeFileSync(join(oddRunDir, 'ok.txt'), 'kept')
  const manifest = parseArtifactManifest(runShell(buildArtifactManifestCommand({ workspace, runId: oddRun })).toString('utf8'))
  assert.equal(manifest.ok, true)
  assert.equal(manifest.value.count, 1)
  assert.equal(manifest.value.totalBytes, 4)
  assert.deepEqual(manifest.value.files.map((file) => file.path), ['ok.txt'])
  const archive = runShell(buildArtifactTgzCommand({ workspace, runId: oddRun }))
  const extractDir = join(root, 'odd-extract')
  mkdirSync(extractDir)
  execFileSync('tar', ['-xzf', '-', '-C', extractDir], { input: archive })
  assert.equal(readFileSync(join(extractDir, 'ok.txt'), 'utf8'), 'kept')
  assert.throws(() => readFileSync(join(extractDir, oddName)), /ENOENT/)
})

test('manifest hex encoding never folds repeated pathname bytes into od star notation', () => {
  const repeatedRun = 'repeated-run'
  const repeatedDir = join(workspace, 'tasks', repeatedRun)
  const repeatedName = 'a'.repeat(80)
  mkdirSync(repeatedDir)
  writeFileSync(join(repeatedDir, repeatedName), 'x')
  const raw = runShell(buildArtifactManifestCommand({ workspace, runId: repeatedRun })).toString('utf8')
  assert.doesNotMatch(raw, /\*/)
  const manifest = parseArtifactManifest(raw)
  assert.equal(manifest.ok, true)
  assert.equal(manifest.value.count, 1)
  assert.deepEqual(manifest.value.files.map((file) => file.path), [repeatedName])
})

test('Content-Disposition cannot inject headers and carries UTF-8 filename', () => {
  const header = contentDisposition('报告\r\nX-Evil: yes.md')
  assert.doesNotMatch(header, /[\r\n]/)
  assert.match(header, /^attachment; filename="[^"]+"; filename\*=UTF-8''/)
  assert.match(header, /%E6%8A%A5%E5%91%8A/)
})

const requestBody = (port, path, options = {}) => new Promise((resolve, reject) => {
  const req = request({ hostname: '127.0.0.1', port, path, method: options.method || 'GET', headers: options.headers || {} }, (res) => {
    const chunks = []
    res.on('data', (chunk) => chunks.push(chunk))
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }))
  })
  req.on('error', reject)
  req.end()
})

const listen = (handler) => new Promise((resolve) => {
  const server = createServer(handler)
  server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }))
})

const close = (server) => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))

const localSshRead = async (_host, command) => {
  try { return { ok: true, out: runShell(command).toString('utf8'), err: '', code: 0 } } catch (error) {
    return { ok: false, out: String(error.stdout || ''), err: String(error.stderr || error.message), code: error.status }
  }
}

const handlersWith = (overrides = {}) => createArtifactHandlers({
  hostsOf: () => [{ name: 'fake', kind: 'remote', ssh: 'unused' }],
  wsOf: () => workspace,
  sshRead: localSshRead,
  spawnSsh: (_host, command) => spawn('/bin/sh', ['-c', command], { stdio: ['ignore', 'pipe', 'pipe'] }),
  ...overrides,
})

test('HTTP handlers enforce GET, cross-site, 404, and stream file/tgz bytes', async (t) => {
  const handlers = handlersWith()
  const { server, port } = await listen((req, res) => {
    if (req.url.startsWith('/api/fleet/artifacts')) void handlers.manifestHandler(req, res)
    else void handlers.prefixHandler(req, res)
  })
  t.after(() => close(server))

  const manifest = await requestBody(port, `/api/fleet/artifacts?host=fake&run=${runId}`)
  assert.equal(manifest.status, 200)
  const manifestBody = JSON.parse(manifest.body)
  assert.equal(manifestBody.count, 2)
  assert.equal(manifestBody.host, 'fake', 'manifest host is the machine name, not a stringified host object')
  const method = await requestBody(port, `/api/fleet/artifacts?host=fake&run=${runId}`, { method: 'POST' })
  assert.equal(method.status, 405)
  assert.equal(method.headers.allow, 'GET')
  const crossSite = await requestBody(port, `/fleet/artifact/file?host=fake&run=${runId}&path=report.md`, {
    headers: { 'sec-fetch-site': 'cross-site' },
  })
  assert.equal(crossSite.status, 403)
  const noRoute = await requestBody(port, '/fleet/nope')
  assert.equal(noRoute.status, 404)
  const noHost = await requestBody(port, `/fleet/artifact/tgz?host=unknown&run=${runId}`)
  assert.equal(noHost.status, 404)
  const noFile = await requestBody(port, `/fleet/artifact/file?host=fake&run=${runId}&path=missing.txt`)
  assert.equal(noFile.status, 404)
  const traceArchive = await requestBody(port, `/fleet/artifact/tgz?host=fake&run=${runId}&include=trace`)
  assert.equal(traceArchive.status, 400, 'trace is explicitly forbidden instead of silently ignored')

  const file = await requestBody(port, `/fleet/artifact/file?host=fake&run=${runId}&path=nested%2Fpayload.bin`)
  assert.equal(file.status, 200)
  assert.equal(file.headers['content-type'], 'application/octet-stream')
  assert.deepEqual(file.body, binary)
  const tgz = await requestBody(port, `/fleet/artifact/tgz?host=fake&run=${runId}`)
  assert.equal(tgz.status, 200)
  assert.equal(tgz.headers['content-type'], 'application/gzip')
  const listing = execFileSync('tar', ['-tzf', '-'], { input: tgz.body }).toString('utf8')
  assert.match(listing, /report\.md/)
  assert.doesNotMatch(listing, /err\.txt|\.trace|(?:^|\/)pid$/m)
})

test('local hosts are a 400 rather than pretending the host is unknown', async (t) => {
  const handlers = handlersWith({ hostsOf: () => [{ name: 'local', kind: 'local' }] })
  const { server, port } = await listen((req, res) => { void handlers.manifestHandler(req, res) })
  t.after(() => close(server))
  const result = await requestBody(port, `/api/fleet/artifacts?host=local&run=${runId}`)
  assert.equal(result.status, 400)
})

test('tgz route returns 413 before spawning', async (t) => {
  let spawned = 0
  const handlers = handlersWith({
    sshRead: async () => ({ ok: true, out: `S\t${ARTIFACT_MAX_FILES + 1}\t42\n`, err: '', code: 0 }),
    spawnSsh: () => { spawned += 1; throw new Error('must not spawn') },
  })
  const { server, port } = await listen((req, res) => { void handlers.prefixHandler(req, res) })
  t.after(() => close(server))
  const result = await requestBody(port, `/fleet/artifact/tgz?host=fake&run=${runId}`)
  assert.equal(result.status, 413)
  assert.equal(JSON.parse(result.body).count, 2001)
  assert.equal(spawned, 0)
})

test('disconnect during preflight aborts the read and never starts a stream child', async (t) => {
  let resolveRead
  let seenSignal
  let spawned = 0
  let markReadStarted
  const readStarted = new Promise((resolve) => { markReadStarted = resolve })
  const handlers = handlersWith({
    sshRead: async (_host, _command, _timeout, options) => {
      seenSignal = options.signal
      markReadStarted()
      return new Promise((resolve) => { resolveRead = resolve })
    },
    spawnSsh: () => { spawned += 1; throw new Error('must not spawn') },
  })
  const { server, port } = await listen((req, res) => { void handlers.prefixHandler(req, res) })
  t.after(() => close(server))

  const client = request({ hostname: '127.0.0.1', port, path: `/fleet/artifact/file?host=fake&run=${runId}&path=report.md` })
  const disconnected = new Promise((resolve) => {
    client.on('error', resolve)
    client.on('close', resolve)
  })
  client.end()
  await readStarted
  const aborted = new Promise((resolve) => seenSignal.addEventListener('abort', resolve, { once: true }))
  client.destroy()
  await disconnected
  await Promise.race([aborted, new Promise((resolve) => setTimeout(resolve, 1000))])
  resolveRead({ ok: true, out: `OK\t1\t${text.length}\n`, err: '', code: 0 })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(seenSignal.aborted, true)
  assert.equal(spawned, 0)
})

test('client disconnect kills the injected ssh stream', async (t) => {
  let killedWith = null
  let resolveKilled
  const killed = new Promise((resolve) => { resolveKilled = resolve })
  class HangingChild extends EventEmitter {
    constructor() {
      super()
      this.stdout = new PassThrough()
      this.stderr = new PassThrough()
      setImmediate(() => this.stdout.write('x'))
    }
    kill(signal) { killedWith = signal; resolveKilled(); this.emit('close', null); return true }
  }
  const handlers = handlersWith({ spawnSsh: () => new HangingChild() })
  const { server, port } = await listen((req, res) => { void handlers.prefixHandler(req, res) })
  t.after(() => close(server))

  await new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port, path: `/fleet/artifact/file?host=fake&run=${runId}&path=report.md` })
    req.on('response', (res) => { res.destroy(); resolve() })
    req.on('error', reject)
    req.end()
  })
  await Promise.race([killed, new Promise((resolve) => setTimeout(resolve, 1000))])
  assert.equal(killedWith, 'SIGKILL')
})

test('a stream error after headers destroys the response and reports only scrubbed stderr', async (t) => {
  const reports = []
  class FailingChild extends EventEmitter {
    constructor() {
      super()
      this.stdout = new PassThrough()
      this.stderr = new PassThrough()
      setImmediate(() => {
        this.stdout.write('partial')
        setImmediate(() => this.stdout.emit('error', new Error('Bearer secret-stream-token')))
      })
    }
    kill() { return true }
  }
  const handlers = handlersWith({ spawnSsh: () => new FailingChild(), onStreamError: (entry) => reports.push(entry) })
  const { server, port } = await listen((req, res) => { void handlers.prefixHandler(req, res) })
  t.after(() => close(server))

  const result = await new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port, path: `/fleet/artifact/file?host=fake&run=${runId}&path=report.md` })
    req.on('response', (res) => {
      res.resume()
      res.on('aborted', () => resolve({ status: res.statusCode, aborted: true }))
      res.on('end', () => resolve({ status: res.statusCode, aborted: false }))
      res.on('error', () => resolve({ status: res.statusCode, aborted: true }))
    })
    req.on('error', reject)
    req.end()
  })
  assert.equal(result.status, 200)
  assert.equal(result.aborted, true)
  assert.equal(reports.length, 1)
  assert.match(reports[0].error, /Bearer «redacted»/)
  assert.doesNotMatch(reports[0].error, /secret-stream-token/)
})

test('stdout EOF waits for ssh close so a later non-zero exit still truncates the response', async (t) => {
  class NonzeroChild extends EventEmitter {
    constructor() {
      super()
      this.stdout = new PassThrough()
      this.stderr = new PassThrough()
      setImmediate(() => {
        this.stdout.end('partial')
        this.stderr.end('remote tar failed')
        setImmediate(() => this.emit('close', 7))
      })
    }
    kill() { return true }
  }
  const handlers = handlersWith({ spawnSsh: () => new NonzeroChild() })
  const { server, port } = await listen((req, res) => { void handlers.prefixHandler(req, res) })
  t.after(() => close(server))

  const aborted = await new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port, path: `/fleet/artifact/file?host=fake&run=${runId}&path=report.md` })
    req.on('response', (res) => {
      res.resume()
      res.on('aborted', () => resolve(true))
      res.on('error', () => resolve(true))
      res.on('end', () => resolve(false))
    })
    req.on('error', reject)
    req.end()
  })
  assert.equal(aborted, true)
})
