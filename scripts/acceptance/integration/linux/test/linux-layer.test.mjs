/**
 * Tests for the Linux isolation layer ENTRY (not for the sandbox itself).
 *
 * SCOPE NOTE — read before trusting anything here.
 * This host is macOS, so nothing in this file spawns bubblewrap and nothing here is
 * evidence that any kernel isolates anything. Every test is one of:
 *   (a) DECISION LOGIC over injected probes / injected process lists, or
 *   (b) CONTRACT SHAPE, asserting the JSON the entry writes.
 * The tests that matter most are the negative ones: the entry must go RED when the
 * production manifest stops probing a property, when a paired positive control is
 * missing, and when a reaping check's own positive control never fires. An entry
 * whose checks cannot fail is not a verification entry.
 *
 * Run: node --test scripts/acceptance/integration/linux/test/linux-layer.test.mjs
 * (Node v26 rejects a bare directory argument to --test; pass files or a glob.)
 */
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { buildCapabilityReport, blockedReasonFrom, recoveryCommandFor } from '../lib/capability-report.mjs'
import { CAPABLE_FILES, runEntrySelfCheck, stubProbe } from '../lib/entry-self-check.mjs'
import { loadProductionSandbox, repoRoot, worktreeDigest } from '../lib/evidence.mjs'
import {
  ASSERTION_CLASS,
  REQUIRED_COVERAGE,
  allBlocked,
  checkDegradedRefusal,
  checkProcessGroupReaping,
  checksFromManifest,
  countVerdicts,
  rollUpVerdict,
} from '../lib/runtime-checks.mjs'

const run = promisify(execFile)
const HERE = dirname(fileURLToPath(import.meta.url))
const ENTRY = resolve(HERE, '../run-linux-isolation.mjs')
const ROOT = repoRoot()

const { sandbox: lib, workspace } = await loadProductionSandbox(ROOT)

const tempDir = async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'agos-linux-layer-test-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

/** A sandbox result as the production module would return it for a capable stub host. */
async function stubSandbox(t, overrides = {}) {
  const evaluator = await tempDir(t)
  return workspace.verificationSandbox(evaluator, { platform: 'linux', probe: stubProbe(overrides) })
}

// ── the coverage list itself ──────────────────────────────────────────────────

test('all six required coverage items are declared, each with an assertion class', () => {
  assert.equal(REQUIRED_COVERAGE.length, 6)
  const classes = new Set(Object.values(ASSERTION_CLASS))
  for (const item of REQUIRED_COVERAGE) {
    assert.ok(classes.has(item.assertionClass), `${item.id}: unknown assertion class ${item.assertionClass}`)
    assert.match(item.requirement, /^\d\. /, `${item.id}: requirement must be numbered against the task list`)
  }
  assert.deepEqual(REQUIRED_COVERAGE.map((i) => i.requirement.slice(0, 2)), ['1.', '2.', '3.', '4.', '5.', '6.'])
})

test('every vacuous-class item declares the positive control that makes it discriminating', () => {
  const vacuous = REQUIRED_COVERAGE.filter((i) => i.assertionClass === ASSERTION_CLASS.vacuous)
  assert.ok(vacuous.length > 0, 'the trap class must be represented; item 3 belongs to it')
  for (const item of vacuous) {
    assert.equal(typeof item.pairedWith, 'string', `${item.id} must name its positive control`)
    assert.ok(item.pairedWith.length > 0)
  }
})

test('only item 3 is classified vacuous, and item 6 is the only decision-logic item', () => {
  const byClass = (cls) => REQUIRED_COVERAGE.filter((i) => i.assertionClass === cls).map((i) => i.id)
  assert.deepEqual(byClass(ASSERTION_CLASS.vacuous), ['outside-bind-unreadable'])
  assert.deepEqual(byClass(ASSERTION_CLASS.decision), ['verification-unavailable-when-degraded'])
  assert.deepEqual(byClass(ASSERTION_CLASS.runtime),
    ['scratch-writable', 'declared-readonly-bind', 'network-egress-denied', 'process-group-reaped'])
})

// ── the pairing gate: the core of this entry's judgement ──────────────────────

test('a capable stub manifest satisfies every manifest-backed item', async (t) => {
  const sandbox = await stubSandbox(t)
  assert.equal(sandbox.ok, true, sandbox.reason)
  const checks = checksFromManifest(sandbox)
  assert.deepEqual(checks.map((c) => c.verdict), ['pass', 'pass', 'pass', 'pass'])
  const outside = checks.find((c) => c.id === 'outside-bind-unreadable')
  assert.equal(outside.pairedControlSatisfied, true)
  assert.match(outside.pairedControlEvidence, /POSITIVE CONTROL/)
})

test('NEGATIVE: removing the positive control turns item 3 red, not green', async (t) => {
  const sandbox = await stubSandbox(t)
  const stripped = {
    ...sandbox,
    isolation: { ...sandbox.isolation, checks: sandbox.isolation.checks.filter((c) => c.name !== 'bound-bind-readable') },
  }
  const outside = checksFromManifest(stripped).find((c) => c.id === 'outside-bind-unreadable')
  assert.equal(outside.verdict, 'fail')
  assert.equal(outside.pairedControlSatisfied, false)
  assert.match(outside.evidence, /vacuously true/)
  assert.match(outside.evidence, /would also pass with no sandbox at all/)
})

test('NEGATIVE: downgrading the positive control to unproven also turns item 3 red', async (t) => {
  const sandbox = await stubSandbox(t)
  const downgraded = {
    ...sandbox,
    isolation: {
      ...sandbox.isolation,
      checks: sandbox.isolation.checks.map((c) => (c.name === 'bound-bind-readable' ? { ...c, status: 'unproven' } : c)),
    },
  }
  const outside = checksFromManifest(downgraded).find((c) => c.id === 'outside-bind-unreadable')
  assert.equal(outside.verdict, 'fail')
  assert.match(outside.evidence, /status=unproven/)
})

test('NEGATIVE: a manifest that stops declaring a check fails instead of passing silently', async (t) => {
  const sandbox = await stubSandbox(t)
  for (const removed of ['scratch-writable', 'network-egress-denied', 'bound-bind-read-only']) {
    const stripped = {
      ...sandbox,
      isolation: { ...sandbox.isolation, checks: sandbox.isolation.checks.filter((c) => c.name !== removed) },
    }
    const failing = checksFromManifest(stripped).filter((c) => c.verdict === 'fail')
    assert.ok(failing.length > 0, `removing ${removed} from the manifest must fail some coverage item`)
    assert.match(failing[0].evidence, /does not declare/)
    assert.match(failing[0].evidence, /an unprobed property cannot be reported as covered/)
  }
})

test('NEGATIVE: an empty manifest fails every manifest-backed item', () => {
  const checks = checksFromManifest({ isolation: { checks: [] } })
  assert.equal(checks.length, 4)
  for (const check of checks) assert.equal(check.verdict, 'fail', `${check.id} must not pass on an empty manifest`)
})

// ── the reaping check's branches (item 5), driven by fake host process lists ──

test('reaping check: an exact argv[0] marker seen then gone is the only passing shape', async (t) => {
  const evaluator = await tempDir(t)
  let polls = 0
  const observed = await checkProcessGroupReaping({
    sandbox: { env: {}, launcher: { file: '/bin/false', before: [] } },
    evaluator,
    marker: 'agos-linux-reap-unit',
    list: async () => (++polls <= 1 ? ['1 agos-linux-reap-unit sleep 45'] : []),
    execCommand: async () => ({ exitCode: 143, cancelled: false, timedOut: true, signal: 'SIGTERM' }),
    startupDeadlineMs: 200, reapDeadlineMs: 200, watchdogMs: 600,
  })
  assert.equal(observed.verdict, 'pass')
  assert.equal(observed.positiveControlSatisfied, true)
  assert.match(observed.evidence, /observed alive in the host \/proc/)
  assert.deepEqual(observed.observedPids, [1])
})

test('NEGATIVE: a launcher containing the marker as a script argument is not a started grandchild', async (t) => {
  const evaluator = await tempDir(t)
  let polls = 0
  const marker = 'agos-linux-reap-unit'
  const observed = await checkProcessGroupReaping({
    sandbox: { env: {}, launcher: { file: '/bin/false', before: [] } },
    evaluator,
    marker,
    list: async () => (++polls === 1
      ? [`4242 /usr/bin/bwrap -- /bin/bash -c ( exec -a ${marker} sleep 45 ) & wait`]
      : []),
    execCommand: async () => ({ exitCode: 143, cancelled: false, timedOut: true, signal: 'SIGTERM' }),
    startupDeadlineMs: 150, reapDeadlineMs: 150, watchdogMs: 600,
  })
  assert.equal(observed.verdict, 'fail')
  assert.equal(observed.positiveControlSatisfied, false)
  assert.match(observed.evidence, /POSITIVE CONTROL FAILED/)
})

test('NEGATIVE: a grandchild that never starts is reported as a vacuous control, not a pass', async (t) => {
  const evaluator = await tempDir(t)
  const observed = await checkProcessGroupReaping({
    sandbox: { env: {}, launcher: { file: '/bin/false', before: [] } },
    evaluator,
    marker: 'agos-linux-reap-unit',
    list: async () => ['1 /sbin/init'],
    execCommand: async () => ({ exitCode: 143, cancelled: false, timedOut: true, signal: 'SIGTERM' }),
    startupDeadlineMs: 150, reapDeadlineMs: 150, watchdogMs: 600,
  })
  assert.equal(observed.verdict, 'fail')
  assert.equal(observed.positiveControlSatisfied, false)
  assert.match(observed.evidence, /POSITIVE CONTROL FAILED/)
  // This is the whole point of the control: without it, "the marker is absent" would
  // have been true here too, and the check would have gone green on nothing at all.
  assert.match(observed.evidence, /a later absence would be vacuously true/)
})

test('reaping check passes in both timeout and abort modes only after observing the exact child', async (t) => {
  const evaluator = await tempDir(t)
  for (const mode of ['timeout', 'abort']) {
    let polls = 0
    const marker = `agos-linux-reap-${mode}`
    const observed = await checkProcessGroupReaping({
      sandbox: { env: {}, launcher: { file: '/bin/false', before: [] } },
      evaluator,
      marker,
      mode,
    list: async () => (++polls <= 1
      ? [{ pid: 4242, argv: [marker, 'sleep', '45'], argv0: marker, line: `4242 ${marker} sleep 45` }]
      : []),
      execCommand: async () => ({ exitCode: 143, cancelled: mode === 'abort', timedOut: mode === 'timeout', signal: 'SIGTERM' }),
      startupDeadlineMs: 150, reapDeadlineMs: 150, watchdogMs: 600,
    })
    assert.equal(observed.verdict, 'pass', `${mode}: ${observed.evidence}`)
    assert.equal(observed.positiveControlSatisfied, true)
    assert.deepEqual(observed.observedPids, [4242])
  }
})

test('NEGATIVE: a surviving grandchild, a success exit code and a hang all fail', async (t) => {
  const evaluator = await tempDir(t)
  const base = {
    sandbox: { env: {}, launcher: { file: '/bin/false', before: [] } },
    evaluator,
    marker: 'agos-linux-reap-unit',
    startupDeadlineMs: 200, reapDeadlineMs: 150, watchdogMs: 500,
  }
  const alive = ['1 agos-linux-reap-unit sleep 45']
  const survivor = await checkProcessGroupReaping({
    ...base, list: async () => alive, execCommand: async () => ({ exitCode: 143, timedOut: true }),
  })
  assert.equal(survivor.verdict, 'fail')
  assert.match(survivor.evidence, /survived/)

  let polls = 0
  const successful = await checkProcessGroupReaping({
    ...base, list: async () => (++polls <= 1 ? alive : []), execCommand: async () => ({ exitCode: 0, timedOut: true }),
  })
  assert.equal(successful.verdict, 'fail')
  assert.match(successful.evidence, /must never look successful/)

  const hung = await checkProcessGroupReaping({ ...base, list: async () => alive, execCommand: () => new Promise(() => {}) })
  assert.equal(hung.verdict, 'fail')
  assert.match(hung.evidence, /never settled/)
})

test('the reaping check refuses to interpolate an unsafe marker into a shell command', async (t) => {
  const evaluator = await tempDir(t)
  let spawned = false
  const observed = await checkProcessGroupReaping({
    sandbox: { env: {}, launcher: { file: '/bin/false', before: [] } },
    evaluator,
    marker: 'oops"; rm -rf /tmp/nope; echo "',
    list: async () => [],
    execCommand: async () => { spawned = true; return { exitCode: 0 } },
  })
  assert.equal(observed.verdict, 'fail')
  assert.match(observed.evidence, /refusing to build a command from marker/)
  assert.equal(spawned, false, 'nothing may be spawned once the marker has been rejected')
})

// ── item 6: degraded hosts are refused, never degraded ────────────────────────

test('DECISION LOGIC: each degraded host is refused with a reason naming what is missing', async (t) => {
  const evaluator = await tempDir(t)
  const observed = await checkDegradedRefusal({
    verificationSandbox: workspace.verificationSandbox,
    makeProbe: (overrides) => stubProbe(overrides),
    evaluator,
    cases: [
      { id: 'no-bwrap', probe: { binaries: {} }, expect: /requires bubblewrap \(bwrap\)/ },
      { id: 'unshare-only', probe: { binaries: { unshare: '/usr/bin/unshare' } }, expect: /linux-unshare backend is disabled/ },
      { id: 'positive-control-failed', probe: { smokeExit: lib.SMOKE_EXIT.boundBindUnreadable }, expect: /in-scope positive control failed/ },
    ],
  })
  assert.equal(observed.verdict, 'pass')
  assert.equal(observed.assertionClass, ASSERTION_CLASS.decision, 'item 6 must never be labelled runtime evidence')
  for (const c of observed.cases) assert.equal(c.refused, true, `${c.scenario}: ${c.reason}`)
  for (const c of observed.cases) assert.equal(c.handedBackLauncher, false)
})

test('NEGATIVE: a degraded host refused for the WRONG reason still fails item 6', async (t) => {
  const evaluator = await tempDir(t)
  const observed = await checkDegradedRefusal({
    verificationSandbox: workspace.verificationSandbox,
    makeProbe: (overrides) => stubProbe(overrides),
    evaluator,
    // bwrap really is missing here, but we demand a network reason; a check that
    // accepts any refusal at all would pass this and must not.
    cases: [{ id: 'mislabelled', probe: { binaries: {} }, expect: /loopback listener was reachable/ }],
  })
  assert.equal(observed.verdict, 'fail')
  assert.match(observed.evidence, /were not refused with a matching verification-unavailable reason/)
})

// ── capability report and blocked reporting ───────────────────────────────────

test('THIS HOST: the capability report names darwin as the blocker and does not crash', async () => {
  const report = await buildCapabilityReport(lib)
  assert.equal(report.platform.os, process.platform)
  if (process.platform === 'linux') return
  assert.ok(report.missing.includes('platform'))
  assert.ok(report.missing.includes('bubblewrap'))
  assert.equal(report.backend.selected, null, 'no linux backend may be selected off linux')
  assert.match(report.selection.reason, /^verification-unavailable: /)
  // Linux-only gates must be reported as NOT PROBED rather than as satisfied: an
  // absent sysctl means "not configured" on linux and "no such kernel" here.
  const userns = report.capabilities.find((c) => c.id === 'unprivileged-userns')
  assert.equal(userns.present, false)
  assert.equal(userns.probed, false)
  assert.match(userns.observed, /only has meaning on a linux kernel/)
})

test('a linux-capable stub host reports no missing capability and selects bubblewrap', async () => {
  const report = await buildCapabilityReport(lib, { probe: stubProbe(), platform: 'linux', osRelease: '6.1.0-31-amd64' })
  assert.deepEqual(report.missing, [], JSON.stringify(report.capabilities, null, 2))
  assert.equal(report.backend.selected, 'linux-bubblewrap')
  assert.equal(report.backend.bwrapVersion, '0.8.0')
  assert.equal(report.platform.release, '6.1.0-31-amd64')
  assert.match(report.platform.kernelVersion, /Linux version 6\.1\.0-synthetic/)
  for (const c of report.capabilities) assert.equal(c.probed, true)
})

test('an ancient kernel is named as the missing capability', async () => {
  const report = await buildCapabilityReport(lib, { probe: stubProbe(), platform: 'linux', osRelease: '3.2.0-4-amd64' })
  assert.ok(report.missing.includes('kernel-version'), JSON.stringify(report.missing))
  assert.match(report.capabilities.find((c) => c.id === 'kernel-version').observed, /3\.2\.0-4-amd64/)
})

test('a host missing tmpfs in /proc/filesystems is named specifically', async () => {
  const files = { ...CAPABLE_FILES, '/proc/filesystems': 'nodev\tproc\n\text4\n' }
  const report = await buildCapabilityReport(lib, { probe: stubProbe({ files }), platform: 'linux', osRelease: '6.1.0' })
  assert.ok(report.missing.includes('mount-primitives'))
  assert.match(report.capabilities.find((c) => c.id === 'mount-primitives').observed, /tmpfs=false/)
})

test('blockedReason names every missing capability and what was probed for it', async () => {
  const report = await buildCapabilityReport(lib)
  if (process.platform === 'linux') return
  const reason = blockedReasonFrom(report)
  for (const id of report.missing) assert.ok(reason.includes(id), `blockedReason must name ${id}`)
  assert.match(reason, /probed:/, 'a blocked reason without the observation is not actionable')
  assert.match(reason, /production planner: verification-unavailable/)
})

test('recoveryCommand is ONE flat copyable argv, as the layer contract requires', async () => {
  const report = await buildCapabilityReport(lib)
  const entryRelPath = 'scripts/acceptance/integration/linux/run-linux-isolation.mjs'
  const recovery = recoveryCommandFor(report, { entryRelPath })
  // The contract field is a single argv, not a list of lists: a consumer must be able
  // to spawn it directly without re-parsing anything.
  assert.ok(Array.isArray(recovery.command) && recovery.command.length > 0)
  assert.ok(recovery.command.every((a) => typeof a === 'string'), JSON.stringify(recovery.command))
  assert.equal(recovery.command[0], 'node')
  assert.ok(recovery.command.includes(entryRelPath))
  // Prerequisites live beside it, still as argv arrays, so nothing is lost.
  assert.ok(Array.isArray(recovery.steps) && recovery.steps.length > 0)
  for (const argv of recovery.steps) assert.ok(Array.isArray(argv) && argv.every((a) => typeof a === 'string'))
  if (process.platform === 'linux') return
  assert.ok(recovery.steps.some((argv) => argv.includes('bubblewrap')), 'installing bwrap is the first thing a reader needs')
})

test('a bwrap-less linux host gets the install step, not the whole clone recipe', async () => {
  const report = await buildCapabilityReport(lib, {
    probe: stubProbe({ binaries: {} }), platform: 'linux', osRelease: '6.1.0',
  })
  const recovery = recoveryCommandFor(report, { entryRelPath: 'x.mjs' })
  assert.deepEqual(recovery.steps[0], ['sudo', 'apt-get', 'install', '-y', 'bubblewrap'])
  assert.ok(!recovery.steps.some((argv) => argv.includes('clone')), 'the repo is already here; do not tell the reader to clone it')
})

test('a userns-blocked host is told NOT to change the host to satisfy the check', async () => {
  const files = { ...CAPABLE_FILES, '/proc/sys/user/max_user_namespaces': '0' }
  const report = await buildCapabilityReport(lib, { probe: stubProbe({ files }), platform: 'linux', osRelease: '6.1.0' })
  const text = recoveryCommandFor(report, { entryRelPath: 'x.mjs' }).steps.map((a) => a.join(' ')).join('\n')
  assert.match(text, /Do NOT change a shared or production host/)
})

// ── verdict roll-up: blocked never becomes pass ───────────────────────────────

test('blocked never rolls up to pass, and a single fail dominates', () => {
  const blocked = allBlocked('nothing runnable here')
  assert.equal(blocked.length, 6)
  assert.equal(rollUpVerdict(blocked), 'blocked')
  assert.deepEqual(countVerdicts(blocked), { pass: 0, fail: 0, skip: 0, blocked: 6 })

  assert.equal(rollUpVerdict([{ verdict: 'pass' }, { verdict: 'blocked' }]), 'blocked',
    'a partially blocked layer is blocked; merging it into pass is the exact failure the contract forbids')
  assert.equal(rollUpVerdict([{ verdict: 'pass' }, { verdict: 'fail' }, { verdict: 'blocked' }]), 'fail')
  assert.equal(rollUpVerdict([{ verdict: 'pass' }, { verdict: 'pass' }]), 'pass')
  assert.equal(rollUpVerdict([]), 'blocked', 'zero checks is not a pass')
})

test('allBlocked can exempt the one item that is runnable off linux', () => {
  const checks = allBlocked('reason', { except: ['verification-unavailable-when-degraded'] })
  assert.equal(checks.length, 5)
  assert.ok(!checks.some((c) => c.id === 'verification-unavailable-when-degraded'))
})

// ── entry self-check ─────────────────────────────────────────────────────────

test('the entry self-check passes here, and is labelled as not being runtime evidence', async (t) => {
  const evaluator = await tempDir(t)
  const selfCheck = await runEntrySelfCheck({
    lib,
    verificationSandbox: workspace.verificationSandbox,
    evaluator,
    checksFromManifest,
    checkProcessGroupReaping,
  })
  assert.equal(selfCheck.isRuntimeEvidence, false)
  assert.match(selfCheck.label, /NOT evidence that any kernel isolated anything/)
  assert.equal(selfCheck.counts.fail, 0, JSON.stringify(selfCheck.cases.filter((c) => !c.ok), null, 2))
  // Both halves must be present: an accept-everything entry would pass a self-check
  // that only ever asserts acceptance.
  assert.ok(selfCheck.cases.some((c) => c.id === 'usable-stub-accepted'))
  assert.ok(selfCheck.cases.filter((c) => c.id.startsWith('broken-stub-refused:')).length >= 8)
})

// ── worktree digest ──────────────────────────────────────────────────────────

test('worktreeDigest reads the real repo without writing to it', async () => {
  const digest = await worktreeDigest(ROOT)
  assert.match(digest.digest, /^[0-9a-f]{64}$/)
  assert.ok(digest.trackedFiles > 100, `expected a real repo, saw ${digest.trackedFiles} tracked files`)
  assert.equal(await worktreeDigest(ROOT).then((d) => d.digest), digest.digest, 'the digest must be stable')
})

/**
 * The dirty-sensitivity property is proven in a THROWAWAY repo, never in the shared
 * workspace. Other agents are editing this worktree concurrently, so a test that
 * mutates a tracked file here — even with a restore in a finally — can clobber their
 * work if it is interrupted. (It did: an earlier draft of this test truncated a
 * tracked file and hung, which is why the fixture below exists.)
 */
test('worktreeDigest moves when a tracked file goes dirty, and moves back when restored', async (t) => {
  const repo = await tempDir(t)
  const git = (...args) => run('git', ['-C', repo, ...args])
  await git('init', '--quiet')
  await git('config', 'user.email', 'agos-linux-layer@local')
  await git('config', 'user.name', 'agos-linux-layer')
  await git('config', 'commit.gpgsign', 'false')
  const tracked = join(repo, 'tracked.txt')
  const original = 'baseline bytes\n'
  await writeFile(tracked, original)
  await writeFile(join(repo, 'untracked.txt'), 'not tracked\n')
  await git('add', 'tracked.txt')
  await git('commit', '--quiet', '-m', 'baseline')

  const clean = await worktreeDigest(repo)
  assert.equal(clean.trackedFiles, 1, 'only tracked files count toward the digest')

  await writeFile(tracked, 'mutated bytes\n')
  const dirty = await worktreeDigest(repo)
  assert.notEqual(dirty.digest, clean.digest,
    'a dirty worktree MUST move the digest; that is this field\'s whole job in the contract')

  await writeFile(tracked, original)
  assert.equal((await worktreeDigest(repo)).digest, clean.digest, 'restoring the bytes must restore the digest')

  // An untracked file must NOT move it, and a deleted tracked file MUST.
  await writeFile(join(repo, 'another-untracked.txt'), 'still not tracked\n')
  assert.equal((await worktreeDigest(repo)).digest, clean.digest, 'untracked files are outside the digest by design')
  await rm(tracked)
  const deleted = await worktreeDigest(repo)
  assert.notEqual(deleted.digest, clean.digest, 'deleting a tracked file must move the digest')
  assert.equal(deleted.deletedTrackedFiles, 1)
})

// ── the entry, end to end ────────────────────────────────────────────────────

test('THE ENTRY: writes a contract-shaped linux.json and reports blocked on this host', async (t) => {
  const logdir = await tempDir(t)
  const { stdout } = await run('node', [ENTRY, '--logdir', logdir, '--quiet'], { cwd: ROOT, maxBuffer: 16 * 1024 * 1024 })
  const result = JSON.parse(await readFile(join(logdir, 'linux.json'), 'utf8'))

  assert.equal(result.schema, 'agos-acceptance/integration-layer@1')
  assert.equal(result.layer, 'linux')
  assert.ok(['pass', 'fail', 'blocked', 'skipped'].includes(result.verdict))
  assert.match(result.sourceCommit, /^[0-9a-f]{40}$/)
  assert.match(result.worktreeDigest, /^[0-9a-f]{64}$/)
  assert.ok(Array.isArray(result.command) && result.command[0] === 'node')
  assert.match(result.startedAt, /^\d{4}-\d{2}-\d{2}T/)
  assert.match(result.endedAt, /^\d{4}-\d{2}-\d{2}T/)
  assert.equal(typeof result.exitCode, 'number')
  assert.equal(result.platform.os, process.platform)
  assert.equal(result.platform.node, process.version)
  assert.equal(result.checks.length, 6 + (result.verdict === 'blocked' ? 0 : 1))

  // Every log hash must be the real hash of the bytes on disk. A hand-written or
  // stale hash is worse than none: it looks like evidence.
  assert.ok(result.logs.length >= 2)
  for (const log of result.logs) {
    const { createHash } = await import('node:crypto')
    assert.equal(createHash('sha256').update(await readFile(log.path)).digest('hex'), log.sha256, log.path)
  }

  // The self-check is reported separately and flagged, never folded into counts.
  assert.equal(result.selfCheck.isRuntimeEvidence, false)
  assert.equal(result.selfCheck.kind, 'entry-self-check')
  assert.ok(result.selfCheck.counts.pass > 0)
  assert.notEqual(result.counts.pass, result.selfCheck.counts.pass + result.counts.pass,
    'self-check passes must not be added into the runtime counts')

  if (process.platform === 'linux') return
  assert.equal(result.verdict, 'blocked', 'a host with no linux kernel must never report pass')
  assert.equal(result.countsByAssertionClass['runtime-evidence'].pass, 0,
    'no runtime evidence may be claimed on a host that cannot run bubblewrap')
  assert.ok(result.countsByAssertionClass['runtime-evidence'].blocked > 0)
  assert.equal(typeof result.blockedReason, 'string')
  assert.ok(result.blockedReason.length > 80, 'a blocked reason must be specific enough to act on')
  assert.ok(result.recoveryCommand.length > 0)
  assert.equal(result.exitCode, 0, 'a blocked environment is not a product-code failure by default')
  assert.match(stdout, /wrote .*linux\.json/)
})

/**
 * The shared matrix (owned by another agent) validates every layer result before it
 * will use it. Validating against THEIR checker rather than against a local copy of
 * the rules is the point: a private restatement of the contract would drift, and this
 * entry would look conformant while the orchestrator rejected it. An earlier draft
 * emitted `recoveryCommand` as an array of argv arrays and was downgraded for exactly
 * that reason.
 */
test('THE ENTRY: the result passes the shared matrix validator with zero errors', async (t) => {
  const validatorPath = join(ROOT, 'scripts/acceptance/integration/lib/layer-result.mjs')
  const validator = await import(validatorPath).catch(() => null)
  if (!validator?.validateLayerResult) {
    t.skip('the shared matrix validator is not present in this worktree; nothing to validate against')
    return
  }
  const logdir = await tempDir(t)
  await run('node', [ENTRY, '--logdir', logdir, '--quiet'], { cwd: ROOT, maxBuffer: 16 * 1024 * 1024 })
  const result = JSON.parse(await readFile(join(logdir, 'linux.json'), 'utf8'))
  const errors = validator.validateLayerResult(result, { layer: 'linux' })
  assert.deepEqual(errors, [], `matrix validator rejected this layer result: ${JSON.stringify(errors, null, 2)}`)

  // And the matrix must not have to downgrade our self-reported verdict.
  if (validator.resolveVerdict) {
    const resolved = validator.resolveVerdict(result)
    assert.equal(resolved.verdict, result.verdict,
      `the matrix resolved ${resolved.verdict} from a self-reported ${result.verdict}: ${resolved.reason}`)
    assert.ok(resolved.downgradedFrom == null, `the matrix downgraded us from ${resolved.downgradedFrom}`)
  }
})

test('THE ENTRY: --strict-blocked turns a blocked environment into a nonzero exit', async (t) => {
  if (process.platform === 'linux') return
  const logdir = await tempDir(t)
  const failed = await run('node', [ENTRY, '--logdir', logdir, '--quiet', '--strict-blocked'], { cwd: ROOT })
    .then(() => null, (err) => err)
  assert.ok(failed, '--strict-blocked must exit nonzero when the verdict is blocked')
  assert.equal(failed.code, 2)
  const result = JSON.parse(await readFile(join(logdir, 'linux.json'), 'utf8'))
  assert.equal(result.verdict, 'blocked')
  assert.equal(result.exitCode, 2, 'the recorded exit code must be the one the process actually used')
})

test('THE ENTRY: rejects an unknown flag instead of silently ignoring it', async () => {
  const failed = await run('node', [ENTRY, '--not-a-flag'], { cwd: ROOT }).then(() => null, (err) => err)
  assert.ok(failed)
  assert.match(String(failed.stderr), /unknown argument: --not-a-flag/)
})

test('THE ENTRY: records the production module it reused, with a real sha256', async (t) => {
  const logdir = await tempDir(t)
  await run('node', [ENTRY, '--logdir', logdir, '--quiet'], { cwd: ROOT })
  const result = JSON.parse(await readFile(join(logdir, 'linux.json'), 'utf8'))
  const sandboxModule = result.moduleProvenance.find((m) => m.specifier.endsWith('autoresearch-sandbox.mjs'))
  assert.ok(sandboxModule, 'the entry must record which production sandbox module it imported')
  const { createHash } = await import('node:crypto')
  assert.equal(createHash('sha256').update(await readFile(sandboxModule.resolvedPath)).digest('hex'), sandboxModule.sha256)
  assert.equal(sandboxModule.origin, 'local-source')
})
