import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createServer } from 'node:net'

import { compareMetric, extractStructuredMetric } from '../lib/autoresearch-metrics.mjs'
import {
  captureRepoEvidence,
  createIsolatedAutoresearchWorkspace,
  disposeWorkspace,
  evidenceEqual,
  gitCommand,
  runAutoresearchIteration,
  measureIsolatedBaseline,
  applyCandidatePatch,
  saveAutoresearchArtifacts,
  verificationSandbox,
  execCommand,
} from '../lib/autoresearch-workspace.mjs'

const VERIFY = 'node test/score.mjs'
const AGOS_HINT = /\/agos(?:-cursor-hardening)?/

function assertCommandsTracked(result) {
  assert.ok(Array.isArray(result.commands), 'commands[] required')
  for (const item of result.commands) {
    assert.equal(typeof item.command, 'string')
    assert.ok(Object.prototype.hasOwnProperty.call(item, 'exitCode'))
  }
}

function assertByteIdentical(before, after, label) {
  assert.equal(after.head, before.head, `${label}: HEAD`)
  assert.equal(after.branch, before.branch, `${label}: branch`)
  assert.equal(after.statusPorcelain, before.statusPorcelain, `${label}: porcelain`)
  assert.equal(after.indexListing, before.indexListing, `${label}: index`)
  assert.equal(after.stagedDiff, before.stagedDiff, `${label}: staged diff`)
  assert.equal(after.unstagedDiff, before.unstagedDiff, `${label}: unstaged diff`)
  const keys = new Set([...Object.keys(before.files), ...Object.keys(after.files)])
  for (const key of keys) {
    assert.ok(before.files[key], `${label}: missing before ${key}`)
    assert.ok(after.files[key], `${label}: missing after ${key}`)
    assert.equal(after.files[key].sha256, before.files[key].sha256, `${label}: bytes ${key}`)
  }
}

async function gitOk(cwd, args) {
  const result = await gitCommand(cwd, args)
  assert.equal(result.exitCode, 0, `${result.command} failed: ${result.text}`)
  return result
}

async function makeTempRepo(t) {
  const root = await mkdtemp(join(tmpdir(), 'agos-ar-src-'))
  assert.ok(!AGOS_HINT.test(root) || root.startsWith(tmpdir()), 'must use a temp repo')
  t.after(() => rm(root, { recursive: true, force: true }))

  await gitOk(root, ['init', '-b', 'main'])
  await gitOk(root, ['config', 'user.email', 'autoresearch-test@local'])
  await gitOk(root, ['config', 'user.name', 'autoresearch-test'])
  await gitOk(root, ['config', 'commit.gpgsign', 'false'])

  await mkdir(join(root, 'src'), { recursive: true })
  await mkdir(join(root, 'test', 'fixtures'), { recursive: true })
  await writeFile(join(root, 'src/app.js'), 'export const n = 1\n')
  await writeFile(join(root, 'test/score.mjs'), [
    'import { readFileSync } from "node:fs"',
    'import { dirname, join } from "node:path"',
    'import { fileURLToPath } from "node:url"',
    'const root = join(dirname(fileURLToPath(import.meta.url)), "..")',
    'const src = readFileSync(join(root, "src/app.js"), "utf8")',
    'const n = Number((src.match(/export const n = (-?\\d+)/) || [])[1])',
    'if (!Number.isFinite(n)) { console.error("missing n"); process.exit(2) }',
    'console.log("METRIC=" + n)',
    '',
  ].join('\n'))
  await writeFile(join(root, 'test/assert.js'), 'export const mustHold = true\n')
  await writeFile(join(root, 'test/fixtures/data.json'), '{"keep":true}\n')

  await gitOk(root, ['add', '-A'])
  await gitOk(root, ['commit', '-m', 'baseline'])
  const head = (await gitOk(root, ['rev-parse', 'HEAD'])).stdout
  return { root, head }
}

async function dirtyOriginal(root) {
  await writeFile(join(root, 'src/app.js'), 'export const n = 1\nexport const staged = true\n')
  await gitOk(root, ['add', 'src/app.js'])
  await writeFile(join(root, 'src/app.js'), 'export const n = 1\nexport const staged = true\nexport const unstaged = true\n')
  await writeFile(join(root, 'src/staged-only.js'), 'export const stagedOnly = 1\n')
  await gitOk(root, ['add', 'src/staged-only.js'])
  await writeFile(join(root, 'untracked.txt'), 'keep-me-untracked\n')
  await writeFile(join(root, 'src/wip.js'), 'export const wip = 1\n')
}

async function openWorkspace(t, repo) {
  const cwd = process.cwd()
  const before = await captureRepoEvidence(repo.root)
  const workspace = await createIsolatedAutoresearchWorkspace({
    sourceRepo: repo.root,
    baselineSha: repo.head,
  })
  t.after(async () => {
    if (workspace?.isolatedDir) await disposeWorkspace(workspace).catch(() => {})
  })
  assert.equal(workspace.ok, true, workspace.error)
  assert.equal(workspace.baselineSha, repo.head)
  assert.equal(workspace.originalIntactAfterCreate, true)
  assert.equal(process.cwd(), cwd)
  assert.ok(!workspace.isolatedDir.startsWith(repo.root + '/'))
  assertCommandsTracked(workspace)
  return { workspace, before, cwd }
}

async function assertOriginalUntouched(repo, before, cwd, label) {
  assert.equal(process.cwd(), cwd, `${label}: cwd`)
  const after = await captureRepoEvidence(repo.root)
  assertByteIdentical(before, after, label)
  assert.equal(after.head, repo.head)
  assert.equal(after.branch, 'main')
  assert.ok(evidenceEqual(before, after))
  assert.equal(await readFile(join(repo.root, 'src/app.js'), 'utf8'), 'export const n = 1\nexport const staged = true\nexport const unstaged = true\n')
  assert.equal(await readFile(join(repo.root, 'untracked.txt'), 'utf8'), 'keep-me-untracked\n')
  assert.equal(await readFile(join(repo.root, 'src/wip.js'), 'utf8'), 'export const wip = 1\n')
  assert.equal(await readFile(join(repo.root, 'src/staged-only.js'), 'utf8'), 'export const stagedOnly = 1\n')
}

test('extractStructuredMetric accepts JSON / METRIC= / labeled field and never first number', () => {
  assert.equal(extractStructuredMetric('passed 12 of 15 tests').ok, false)
  assert.equal(extractStructuredMetric('score 9\nnoise 3').ok, false)
  assert.equal(extractStructuredMetric('{"ok":true}').ok, false)
  assert.equal(extractStructuredMetric('{"metric":null}').ok, false)
  assert.equal(extractStructuredMetric('{"metric":false}').ok, false)

  const json = extractStructuredMetric('noise 7\n{"metric": 12.5}\n', { kind: 'json-line' })
  assert.equal(json.ok, true)
  assert.equal(json.value, 12.5)
  assert.equal(json.kind, 'json-line')

  const named = extractStructuredMetric('{"pass":1,"score":8}', { field: 'score' })
  assert.equal(named.ok, true)
  assert.equal(named.value, 8)

  const metricEq = extractStructuredMetric('done\nMETRIC=3.25\n', { field: 'metric' })
  assert.equal(metricEq.ok, true)
  assert.equal(metricEq.value, 3.25)

  const labeled = extractStructuredMetric('latency: 42', { field: 'latency', kind: 'labeled-field' })
  assert.equal(labeled.ok, true)
  assert.equal(labeled.value, 42)

  const missing = extractStructuredMetric('METRIC=1', { field: 'score', kind: 'json-line' })
  assert.equal(missing.ok, false)
})

test('compareMetric requires explicit direction and treats equality as not improved', () => {
  assert.equal(compareMetric(2, 1, 'higher').improved, true)
  assert.equal(compareMetric(1, 1, 'higher').improved, false)
  assert.equal(compareMetric(0, 1, 'lower').improved, true)
  assert.equal(compareMetric(2, 1, 'lower').improved, false)
  assert.equal(compareMetric('x', 1, 'higher').comparable, false)
  assert.equal(compareMetric('x', 1, 'higher').improved, false)
})

test('staged + unstaged + untracked survive create, no-op, and dispose', async (t) => {
  const repo = await makeTempRepo(t)
  await dirtyOriginal(repo.root)
  const { workspace, before, cwd } = await openWorkspace(t, repo)
  await assertOriginalUntouched(repo, before, cwd, 'after-create')

  const empty = await runAutoresearchIteration({
    workspace,
    verifyCmd: VERIFY,
    direction: 'higher',
  })
  assert.equal(empty.status, 'commit-failed')
  assert.equal(empty.kept, false)
  assert.equal(empty.rolledBack, false)
  assert.equal(empty.reason, 'no-allowlisted-changes')
  assertCommandsTracked(empty)
  await assertOriginalUntouched(repo, before, cwd, 'after-empty-iter')

  const disposed = await disposeWorkspace(workspace)
  assert.equal(disposed.cleaned, true)
  assert.equal(disposed.originalIntact, true)
  assert.equal(disposed.isolatedHead, repo.head)
  assertCommandsTracked(disposed)
  await assertOriginalUntouched(repo, before, cwd, 'after-dispose')
})

test('commit failure is evidenced and does not mutate the original repo', async (t) => {
  const repo = await makeTempRepo(t)
  await dirtyOriginal(repo.root)
  const { workspace, before, cwd } = await openWorkspace(t, repo)
  await writeFile(join(workspace.isolatedDir, '.git/hooks/pre-commit'), '#!/bin/sh\nexit 1\n', { mode: 0o755 })

  const result = await runAutoresearchIteration({
    workspace,
    verifyCmd: VERIFY,
    runCmd: 'printf "export const n = 9\\n" > src/app.js',
    direction: 'higher',
  })
  assert.equal(result.status, 'commit-failed')
  assert.equal(result.kept, false)
  assert.equal(result.rolledBack, false)
  assert.equal(result.shaBefore, repo.head)
  assert.equal(result.shaAfter, repo.head)
  assert.ok(result.commands.some((c) => c.command.startsWith('git commit') && c.exitCode !== 0))
  assertCommandsTracked(result)
  const isolated = await gitCommand(workspace.isolatedDir, ['rev-parse', 'HEAD'])
  assert.equal(isolated.stdout, repo.head)
  await assertOriginalUntouched(repo, before, cwd, 'after-commit-failure')

  const disposed = await disposeWorkspace(workspace)
  assert.equal(disposed.cleaned, true)
  assert.equal(disposed.originalIntact, true)
})

test('no improvement rolls back isolated HEAD only', async (t) => {
  const repo = await makeTempRepo(t)
  await dirtyOriginal(repo.root)
  const { workspace, before, cwd } = await openWorkspace(t, repo)

  const result = await runAutoresearchIteration({
    workspace,
    verifyCmd: VERIFY,
    runCmd: 'printf "export const n = 1\\nexport const comment = \\"tweak\\"\\n" > src/app.js',
    direction: 'higher',
  })
  assert.equal(result.status, 'no-improvement')
  assert.equal(result.kept, false)
  assert.equal(result.rolledBack, true)
  assert.equal(result.metric, 1)
  assert.equal(result.baselineMetric, 1)
  assert.equal(result.shaBefore, repo.head)
  assert.equal(result.shaAfter, repo.head)
  assert.ok(result.commands.some((c) => c.command.startsWith('git commit') && c.exitCode === 0))
  assert.ok(result.commands.some((c) => c.command.startsWith('git reset --hard') && c.exitCode === 0))
  assertCommandsTracked(result)

  const isolatedHead = (await gitCommand(workspace.isolatedDir, ['rev-parse', 'HEAD'])).stdout
  assert.equal(isolatedHead, repo.head)
  const isolatedSrc = await readFile(join(workspace.isolatedDir, 'src/app.js'), 'utf8')
  assert.equal(isolatedSrc, 'export const n = 1\n')
  await assertOriginalUntouched(repo, before, cwd, 'after-no-improve')

  const disposed = await disposeWorkspace(workspace)
  assert.equal(disposed.cleaned, true)
  assert.equal(disposed.originalIntact, true)
  assert.equal(disposed.isolatedHead, repo.head)
})

test('improvement is kept in the isolated repo only', async (t) => {
  const repo = await makeTempRepo(t)
  await dirtyOriginal(repo.root)
  const { workspace, before, cwd } = await openWorkspace(t, repo)

  const result = await runAutoresearchIteration({
    workspace,
    verifyCmd: VERIFY,
    runCmd: 'printf "export const n = 2\\n" > src/app.js',
    direction: 'higher',
  })
  assert.equal(result.status, 'improved')
  assert.equal(result.kept, true)
  assert.equal(result.rolledBack, false)
  assert.equal(result.metric, 2)
  assert.equal(result.baselineMetric, 1)
  assert.equal(result.shaBefore, repo.head)
  assert.notEqual(result.shaAfter, repo.head)
  assert.ok(result.commands.some((c) => c.command.startsWith('git commit') && c.exitCode === 0))
  assert.ok(result.commands.every((c) => !c.command.startsWith('git reset --hard')))
  assertCommandsTracked(result)

  const isolatedHead = (await gitCommand(workspace.isolatedDir, ['rev-parse', 'HEAD'])).stdout
  assert.equal(isolatedHead, result.shaAfter)
  assert.equal(await readFile(join(workspace.isolatedDir, 'src/app.js'), 'utf8'), 'export const n = 2\n')
  assert.equal(await readFile(join(workspace.isolatedDir, 'test/assert.js'), 'utf8'), 'export const mustHold = true\n')
  assert.equal(await readFile(join(workspace.isolatedDir, 'test/fixtures/data.json'), 'utf8'), '{"keep":true}\n')
  await assertOriginalUntouched(repo, before, cwd, 'after-improve')

  const disposed = await disposeWorkspace(workspace)
  assert.equal(disposed.cleaned, true)
  assert.equal(disposed.originalIntact, true)
  assert.equal(disposed.isolatedHead, result.shaAfter)
  await assertOriginalUntouched(repo, before, cwd, 'after-improve-dispose')
})

test('cancel is trackable and does not claim rollback without a reset', async (t) => {
  const repo = await makeTempRepo(t)
  await dirtyOriginal(repo.root)
  const { workspace, before, cwd } = await openWorkspace(t, repo)
  assert.equal((await measureIsolatedBaseline({ workspace, verifyCmd: VERIFY })).ok, true)
  const ac = new AbortController()
  const pending = runAutoresearchIteration({
    workspace,
    verifyCmd: VERIFY,
    runCmd: 'node -e "setInterval(() => {}, 1000)"',
    direction: 'higher',
    signal: ac.signal,
  })
  setTimeout(() => ac.abort(), 80)
  const result = await pending
  assert.equal(result.status, 'cancelled')
  assert.equal(result.kept, false)
  assert.equal(result.rolledBack, false)
  assert.equal(result.shaBefore, repo.head)
  assert.equal(result.shaAfter, repo.head)
  assert.ok(result.commands.some((c) => c.command.includes('setInterval')))
  assertCommandsTracked(result)
  await assertOriginalUntouched(repo, before, cwd, 'after-cancel')

  const disposed = await disposeWorkspace(workspace)
  assert.equal(disposed.cleaned, true)
  assert.equal(disposed.originalIntact, true)
})

test('editing scorer, asserts, or fixtures is a protected violation', async (t) => {
  const repo = await makeTempRepo(t)
  await dirtyOriginal(repo.root)
  const { workspace, before, cwd } = await openWorkspace(t, repo)

  const scorer = await runAutoresearchIteration({
    workspace,
    verifyCmd: VERIFY,
    runCmd: 'printf "console.log(\\"METRIC=999\\")\\n" > test/score.mjs',
    direction: 'higher',
  })
  assert.equal(scorer.status, 'protected-violation')
  assert.equal(scorer.kept, false)
  assert.equal(scorer.protectedViolation, true)
  assert.ok(scorer.protectedChanged.includes('test/score.mjs'))
  assert.equal((await gitCommand(workspace.isolatedDir, ['rev-parse', 'HEAD'])).stdout, repo.head)
  assert.equal(await readFile(join(workspace.isolatedDir, 'test/score.mjs'), 'utf8'), await readFile(join(repo.root, 'test/score.mjs'), 'utf8'))

  const fixture = await runAutoresearchIteration({
    workspace,
    verifyCmd: VERIFY,
    runCmd: 'printf "{\\"keep\\":false}\\n" > test/fixtures/data.json && printf "export const n = 8\\n" > src/app.js',
    direction: 'higher',
  })
  assert.equal(fixture.status, 'protected-violation')
  assert.equal(fixture.kept, false)
  await assertOriginalUntouched(repo, before, cwd, 'after-protected')
})

const candidatePatch = 'diff --git a/src/app.js b/src/app.js\n--- a/src/app.js\n+++ b/src/app.js\n@@ -1 +1 @@\n-export const n = 1\n+export const n = 8\n'

test('accepted source patch is verified in baseline evaluator and survives workspace cleanup', async (t) => {
  const repo = await makeTempRepo(t)
  const { workspace } = await openWorkspace(t, repo)
  assert.equal((await measureIsolatedBaseline({ workspace, verifyCmd: VERIFY })).metric, 1)
  assert.equal((await applyCandidatePatch(workspace, candidatePatch)).ok, true)
  const iteration = await runAutoresearchIteration({ workspace, verifyCmd: VERIFY })
  assert.equal(iteration.status, 'improved')
  assert.equal(iteration.metric, 8)
  const artifacts = await saveAutoresearchArtifacts(workspace, join(repo.root, 'artifacts'), { iterations: [iteration] })
  await disposeWorkspace(workspace)
  assert.match(await readFile(artifacts.patchPath, 'utf8'), /\+export const n = 8/)
  const manifest = JSON.parse(await readFile(artifacts.manifestPath, 'utf8'))
  assert.equal(manifest.bestMetric, 8)
  assert.equal(manifest.baselineSha, repo.head)
  assert.equal(manifest.iterations[0].status, 'improved')
})

test('candidate cannot change verifier command or package scripts even with scope **', async (t) => {
  const repo = await makeTempRepo(t)
  const { workspace } = await openWorkspace(t, repo)
  workspace.sourceAllowlist = ['**']
  const packagePatch = 'diff --git a/package.json b/package.json\nnew file mode 100644\n--- /dev/null\n+++ b/package.json\n@@ -0,0 +1 @@\n+{"scripts":{"test":"echo METRIC=999"}}\n'
  assert.equal((await applyCandidatePatch(workspace, packagePatch)).ok, false)
  await measureIsolatedBaseline({ workspace, verifyCmd: VERIFY })
  await applyCandidatePatch(workspace, candidatePatch)
  const iteration = await runAutoresearchIteration({ workspace, verifyCmd: 'echo METRIC=999' })
  assert.equal(iteration.status, 'verify-failed')
  assert.equal(workspace.bestMetric, 1)
})

test('verification side effects cannot rewrite baseline scoring material and claim improvement', async (t) => {
  const repo = await makeTempRepo(t)
  const { workspace } = await openWorkspace(t, repo)
  const verifier = 'node test/score.mjs && node -e "const f=require(\'fs\');if(f.readFileSync(\'src/app.js\',\'utf8\').includes(\'n = 8\'))f.writeFileSync(\'test/fixtures/data.json\',\'changed\')"'
  assert.equal((await measureIsolatedBaseline({ workspace, verifyCmd: verifier })).metric, 1)
  await applyCandidatePatch(workspace, candidatePatch)
  const iteration = await runAutoresearchIteration({ workspace, verifyCmd: verifier })
  assert.equal(iteration.status, 'verify-failed')
  assert.equal(workspace.bestMetric, 1)
  assert.equal(await readFile(join(workspace.trustedDir, 'test/fixtures/data.json'), 'utf8'), '{"keep":true}\n')
})

test('production autoresearch uses a tool-free patch proposer and returns durable artifacts', async (t) => {
  const repo = await makeTempRepo(t)
  await dirtyOriginal(repo.root)
  const original = await captureRepoEvidence(repo.root)
  const artifactRoot = await mkdtemp(join(tmpdir(), 'agos-ar-results-'))
  t.after(() => rm(artifactRoot, { recursive: true, force: true }))
  const previous = process.env.DSH_CN_AUTORESEARCH_RESULT_DIR
  process.env.DSH_CN_AUTORESEARCH_RESULT_DIR = artifactRoot
  t.after(() => { if (previous === undefined) delete process.env.DSH_CN_AUTORESEARCH_RESULT_DIR; else process.env.DSH_CN_AUTORESEARCH_RESULT_DIR = previous })
  const { apply } = await import('../lib/index.js')
  const registry = new Map()
  let starts = 0, disposed = 0
  const subagents = { async start(kind, request) {
    starts++
    assert.equal(kind, 'spawn')
    assert.deepEqual(request.toolFilter, { allow: [] })
    assert.equal(request.agentOptions.cwd, undefined)
    assert.match(request.prompt[0].text, /export const n = 1/)
    return { result: Promise.resolve({ stopReason: 'completed', output: [{ type: 'text', text: candidatePatch }] }),
      async dispose() { disposed++ } }
  } }
  const off = apply({ tools: { register(tool) { registry.set(tool.name, tool); return () => registry.delete(tool.name) } },
    get(name) { return name === 'subagents' ? subagents : undefined }, inject() {}, on() { return () => {} } })
  t.after(off)
  const output = await registry.get('autoresearch').execute({ cwd: repo.root, goal: 'increase n', verify: VERIFY, iterations: 1 },
    { agent: { session: { id: 'fixture' } }, signal: new AbortController().signal })
  assert.equal(starts, 1)
  assert.equal(disposed, 1)
  assert.match(output.report, /最终 metric: 8/)
  const patchPath = output.report.match(/补丁: ([^\n]+)/)?.[1]
  const manifestPath = output.report.match(/验收记录: ([^\n]+)/)?.[1]
  assert.ok(patchPath && manifestPath, output.report)
  assert.match(await readFile(patchPath, 'utf8'), /\+export const n = 8/)
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  assert.equal(manifest.bestMetric, 8)
  assert.equal(evidenceEqual(original, await captureRepoEvidence(repo.root)), true)
  assert.equal(manifest.originalIntactAtExport, true)
})

test('real OS sandbox denies outside reads/writes, verifier writes, inherited secrets and network', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agos-seatbelt-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const evaluator = join(root, 'evaluation')
  await mkdir(evaluator)
  const outside = join(root, 'outside-sentinel.txt')
  const protectedFile = join(evaluator, 'score.mjs')
  await writeFile(outside, 'outside must survive')
  await writeFile(protectedFile, 'trusted score')
  process.env.AGOS_SYNTHETIC_SECRET = 'test-only-not-a-real-secret'
  t.after(() => { delete process.env.AGOS_SYNTHETIC_SECRET })
  const sandbox = await verificationSandbox(evaluator)
  if (process.platform !== 'darwin') {
    assert.equal(sandbox.ok, false)
    assert.match(sandbox.reason, /verification-unavailable/)
    return
  }
  assert.equal(sandbox.ok, true)
  const server = createServer((socket) => socket.end())
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const port = server.address().port
  const code = `const fs=require("node:fs"),net=require("node:net");
const r={};for(const [name,fn] of [["readOutside",()=>fs.readFileSync(${JSON.stringify(outside)})],["writeOutside",()=>fs.writeFileSync(${JSON.stringify(outside)},"bad")],["writeVerifier",()=>fs.writeFileSync(${JSON.stringify(protectedFile)},"bad")]]){try{fn();r[name]=false}catch(e){r[name]=["EPERM","EACCES"].includes(e.code)}}
r.envClean=process.env.AGOS_SYNTHETIC_SECRET===undefined;
fs.writeFileSync(process.env.TMPDIR+"/allowed.txt","scratch works");r.scratch=true;
const s=net.connect({host:"127.0.0.1",port:${port}});s.on("connect",()=>{r.network=false;s.destroy();console.log(JSON.stringify(r))});s.on("error",e=>{r.network=["EPERM","EACCES"].includes(e.code);console.log(JSON.stringify(r))});`
  const script = join(evaluator, 'probe.cjs')
  await writeFile(script, code)
  const result = await execCommand('node probe.cjs', { cwd: evaluator, env: sandbox.env, sandboxProfile: sandbox.profile, timeoutMs: 10000 })
  assert.equal(result.exitCode, 0, result.stderr)
  assert.deepEqual(JSON.parse(result.stdout), { readOutside: true, writeOutside: true, writeVerifier: true, envClean: true, scratch: true, network: true })
  assert.equal(await readFile(outside, 'utf8'), 'outside must survive')
  assert.equal(await readFile(protectedFile, 'utf8'), 'trusted score')
})
