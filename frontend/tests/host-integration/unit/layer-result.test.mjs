/**
 * The `agos-acceptance/integration-layer@1` document the host layer emits.
 *
 * Three properties are load-bearing for whoever aggregates the layers, and all
 * three are things a document could plausibly get wrong while still looking
 * well-formed:
 *
 * 1. `blocked` must never be reachable from a passing run and must always
 *    carry a specific reason, because the aggregation rule is that a blocked
 *    layer cannot be summed into "integration passed".
 * 2. `worktreeDigest` must change when a tracked file changes. A digest that
 *    only tracks the commit would report a dirty tree as if it were the
 *    committed one, which is the exact failure mode that makes an evidence
 *    file untrustworthy.
 * 3. every hash is computed from bytes. Nothing may be supplied by a caller.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  buildLayerResult, sha256File, verdictFor, worktreeDigest, writeLayerResult,
} from '../../host-integration/layer-result.mjs';
import { recoveryArgvForScenario } from '../../host-integration/recovery-argv.mjs';

const run = promisify(execFile)
let sandbox

before(async () => { sandbox = await mkdtemp(path.join(tmpdir(), 'agos-layer-result-')) })
after(async () => { if (sandbox !== undefined) await rm(sandbox, { recursive: true, force: true }) })

describe('the verdict ordering is the aggregation contract', () => {
  it('a real failure outranks a block', () => {
    assert.equal(verdictFor({ pass: 8, fail: 1, skip: 0, blocked: 3 }), 'fail')
  })

  it('a block outranks a pass — it was not observed, so it is not coverage', () => {
    assert.equal(verdictFor({ pass: 8, fail: 0, skip: 0, blocked: 1 }), 'blocked')
  })

  it('all passing is a pass', () => {
    assert.equal(verdictFor({ pass: 9, fail: 0, skip: 0, blocked: 0 }), 'pass')
  })

  it('nothing reached is skipped, never a pass', () => {
    assert.equal(verdictFor({ pass: 0, fail: 0, skip: 9, blocked: 0 }), 'skipped')
    assert.equal(verdictFor({ pass: 0, fail: 0, skip: 0, blocked: 0 }), 'skipped')
  })
})

describe('the worktree digest actually tracks the worktree', () => {
  let repo

  before(async () => {
    repo = await mkdtemp(path.join(sandbox, 'repo-'))
    const git = (...args) => run('git', args, { cwd: repo })
    await git('init', '-q')
    await git('config', 'user.email', 'harness@example.invalid')
    await git('config', 'user.name', 'harness')
    await writeFile(path.join(repo, 'tracked.txt'), 'original\n')
    await writeFile(path.join(repo, 'other.txt'), 'other\n')
    await git('add', '.')
    await git('commit', '-q', '-m', 'seed')
  })

  it('is stable for an unchanged tree', async () => {
    const first = await worktreeDigest(repo)
    const second = await worktreeDigest(repo)
    assert.equal(first.digest, second.digest)
    assert.equal(first.fileCount, 2)
  })

  it('CHANGES when a tracked file is edited but not committed', async () => {
    const clean = await worktreeDigest(repo)
    await writeFile(path.join(repo, 'tracked.txt'), 'edited in the worktree\n')
    const dirty = await worktreeDigest(repo)
    assert.notEqual(dirty.digest, clean.digest, 'a dirty worktree must not digest as the clean one')
    // …and back again, so the digest is a function of content, not of history.
    await writeFile(path.join(repo, 'tracked.txt'), 'original\n')
    assert.equal((await worktreeDigest(repo)).digest, clean.digest)
  })

  it('CHANGES when a tracked file is deleted from the worktree', async () => {
    const clean = await worktreeDigest(repo)
    await rm(path.join(repo, 'other.txt'))
    const missing = await worktreeDigest(repo)
    assert.notEqual(missing.digest, clean.digest)
    // Still counted: a deleted tracked file is a change, not an absence.
    assert.equal(missing.fileCount, 2)
    await writeFile(path.join(repo, 'other.txt'), 'other\n')
  })

  it('ignores untracked scratch files, so parallel agents do not perturb it', async () => {
    const clean = await worktreeDigest(repo)
    await writeFile(path.join(repo, 'scratch.log'), 'someone else was here\n')
    assert.equal((await worktreeDigest(repo)).digest, clean.digest)
    await rm(path.join(repo, 'scratch.log'))
  })

  it('reports nulls outside a repository instead of inventing a digest', async () => {
    const bare = await mkdtemp(path.join(sandbox, 'not-a-repo-'))
    assert.deepEqual(await worktreeDigest(bare), { digest: null, fileCount: null })
  })
})

describe('hashes come from bytes', () => {
  it('matches an independently computed sha256', async () => {
    const file = path.join(sandbox, 'hashed.txt')
    const bytes = Buffer.from('the quick brown fox\n')
    await writeFile(file, bytes)
    assert.equal(await sha256File(file), createHash('sha256').update(bytes).digest('hex'))
  })

  it('is undefined for a file that is not there — never a placeholder', async () => {
    assert.equal(await sha256File(path.join(sandbox, 'absent')), undefined)
  })
})

describe('the document', () => {
  const base = {
    command: ['node', 'tests/host-integration/run.mjs'],
    startedAt: '2026-09-09T00:00:00.000Z',
    endedAt: '2026-09-09T00:01:00.000Z',
    repoRoot: undefined,
  }

  it('states the schema and layer, and carries the real platform', async () => {
    const document = await buildLayerResult({
      ...base,
      repoRoot: sandbox,
      counts: { pass: 9, fail: 0, skip: 0, blocked: 0 },
      exitCode: 0,
    })
    assert.equal(document.schema, 'agos-acceptance/integration-layer@1')
    assert.equal(document.layer, 'host-browser')
    assert.equal(document.verdict, 'pass')
    assert.equal(document.platform.os, process.platform)
    assert.equal(document.platform.arch, process.arch)
    assert.equal(document.platform.node, process.version)
    // A passing run must not carry a blocked reason or a recovery command:
    // both would suggest something was uncovered when nothing was.
    assert.equal(document.blockedReason, null)
    assert.equal(document.recoveryCommand, null)
  })

  it('requires a specific reason and a recovery command when blocked', async () => {
    const document = await buildLayerResult({
      ...base,
      repoRoot: sandbox,
      counts: { pass: 0, fail: 0, skip: 9, blocked: 1 },
      exitCode: 0,
      blockedReason: 'no installed Chrome/Chromium found',
      recoveryCommand: ['env', 'AGOS_BROWSER_EXECUTABLE=/abs/chrome', 'node', 'tests/host-integration/run.mjs'],
    })
    assert.equal(document.verdict, 'blocked')
    assert.match(document.blockedReason, /Chrome/)
    assert.deepEqual(document.recoveryCommand[0], 'env')
  })

  it('falls back to naming the uncovered layers rather than a null reason', async () => {
    const document = await buildLayerResult({
      ...base,
      repoRoot: sandbox,
      counts: { pass: 8, fail: 0, skip: 0, blocked: 1 },
      exitCode: 0,
      uncoveredLayers: ['8-history-evidence-does-not-leak: turn-evidence plugin'],
      recoveryCommand: ['node', 'tests/host-integration/run.mjs', '--only', '8-history-evidence-does-not-leak'],
    })
    assert.equal(document.verdict, 'blocked')
    assert.match(document.blockedReason, /turn-evidence plugin/)
  })

  it('rejects blocked output with neither a concrete reason nor recovery argv', async () => {
    await assert.rejects(() => buildLayerResult({
      ...base,
      repoRoot: sandbox,
      counts: { pass: 8, fail: 0, skip: 0, blocked: 1 },
      exitCode: 0,
    }), /blocked layer result requires a specific blockedReason/)
    await assert.rejects(() => buildLayerResult({
      ...base,
      repoRoot: sandbox,
      counts: { pass: 8, fail: 0, skip: 0, blocked: 1 },
      exitCode: 0,
      blockedReason: 'plugin route unavailable',
    }), /blocked layer result requires a non-empty recoveryCommand/)
  })

  it('rejects a blocked reason shorter than the matrix contract', async () => {
    await assert.rejects(() => buildLayerResult({
      ...base,
      repoRoot: sandbox,
      counts: { pass: 8, fail: 0, skip: 0, blocked: 1 },
      exitCode: 0,
      blockedReason: 'too short',
      recoveryCommand: ['node', 'tests/host-integration/run.mjs'],
    }), /specific blockedReason/)
  })

  it('normalizes an existing --only before adding the blocked scenario', () => {
    assert.deepEqual(
      recoveryArgvForScenario(['node', 'run.mjs', '--only', 'old-a,old-b', '--logdir=x'], 'new-case'),
      ['node', 'run.mjs', '--logdir=x', '--only', 'new-case'],
    )
    assert.deepEqual(
      recoveryArgvForScenario(['node', 'run.mjs', '--only=old-a'], 'new-case'),
      ['node', 'run.mjs', '--only', 'new-case'],
    )
  })

  it('hashes the logs it lists and silently lists none it cannot read', async () => {
    const real = path.join(sandbox, 'run.log')
    await writeFile(real, 'a log line\n')
    const document = await buildLayerResult({
      ...base,
      repoRoot: sandbox,
      counts: { pass: 1, fail: 0, skip: 0, blocked: 0 },
      exitCode: 0,
      logFiles: [real, path.join(sandbox, 'never-written.log')],
    })
    assert.equal(document.logs.length, 1)
    assert.equal(document.logs[0].path, real)
    assert.equal(document.logs[0].sha256, await sha256File(real))
  })

  it('writes to <logdir>/host-browser.json', async () => {
    const logDir = await mkdtemp(path.join(sandbox, 'logs-'))
    const document = await buildLayerResult({
      ...base,
      repoRoot: sandbox,
      counts: { pass: 1, fail: 0, skip: 0, blocked: 0 },
      exitCode: 0,
    })
    const written = await writeLayerResult(logDir, document)
    assert.equal(written.file, path.join(logDir, 'host-browser.json'))
    const reread = JSON.parse(await readFile(written.file, 'utf8'))
    assert.equal(reread.schema, 'agos-acceptance/integration-layer@1')
    assert.equal(reread.layer, 'host-browser')
  })
})
