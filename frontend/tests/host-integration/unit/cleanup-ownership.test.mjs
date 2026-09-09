/**
 * Defect 1 regression: cleanup must reap ONLY runs nobody owns.
 *
 * The old cleanup matched `agos-host-integration` as a global prefix, so a
 * second suite running in parallel had its host SIGTERM'd and its DSH_HOME
 * deleted mid-scenario. These tests build the exact collision — two real run
 * roots on disk, each with a real child process — and assert the reaper takes
 * one and leaves the other completely untouched.
 *
 * Nothing here is mocked. The victims and the survivors are real spawned
 * processes checked through the OS (`ps`, `kill -0`), and the directories are
 * real directories checked with the filesystem. A test that only asserted on
 * the report would pass even if the reaper had killed everything.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  classifyRun, cleanupRuns, createRunRoot, disposeRunRoot, processIdentity, processMatches, reapRun, recordProcess,
} from '../../../scripts/host-integration/run-registry.mjs';

const CLEANUP_CLI = fileURLToPath(new URL('../../../scripts/host-integration/cleanup.mjs', import.meta.url))

/** Every run root these tests create lives under one sandbox, never the shared tmpdir. */
let sandbox
/** Processes to make sure are gone even if an assertion fails. */
const spawned = new Set()

before(async () => {
  sandbox = await mkdtemp(path.join(tmpdir(), 'agos-cleanup-negative-'))
})

after(async () => {
  for (const child of spawned) { try { child.kill('SIGKILL') } catch { /* gone */ } }
  if (sandbox !== undefined) await rm(sandbox, { recursive: true, force: true })
})

/**
 * Start a real, long-lived child process whose command line names `runDir`
 * (and therefore the runId), exactly like the real host's `--patch` argument
 * does. This is the thing cleanup has to decide about.
 * @param runDir - the run root the process belongs to.
 * @returns the child handle.
 */
async function startStandInHost(runDir) {
  const script = path.join(runDir, 'stand-in-host.mjs')
  // Self-terminating: a runner killed mid-suite skips `after`, and a stand-in
  // that outlived it would be exactly the stray these tests are about.
  await writeFile(script, 'setTimeout(() => process.exit(0), 300_000)\n')
  const child = spawn(process.execPath, [script], { stdio: 'ignore' })
  spawned.add(child)
  // Wait until the OS can see it, so the recorded identity is the real one.
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await processIdentity(child.pid) !== undefined) return child
    await new Promise((resolve) => { setTimeout(resolve, 20) })
  }
  throw new Error(`stand-in host ${child.pid} never appeared in ps`)
}

/** True when the pid is alive right now, asked of the OS rather than of us. */
function isAlive(pid) {
  try { process.kill(pid, 0); return true } catch { return false }
}

/** Wait for a real process to actually disappear. */
async function waitForExit(pid, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true
    await new Promise((resolve) => { setTimeout(resolve, 50) })
  }
  return false
}

/**
 * Produce a process identity that is guaranteed dead: spawn something, record
 * who it was, wait for it to exit. Used to make a run look abandoned.
 */
async function deadIdentity() {
  const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' })
  const identity = await processIdentity(child.pid)
  await new Promise((resolve) => child.on('exit', resolve))
  await waitForExit(child.pid)
  return identity ?? { pid: child.pid, startedAt: 'Mon Jan  1 00:00:00 2001', command: 'exited' }
}

/** Rewrite a run's manifest so its owner looks dead (an abandoned run). */
async function orphan(runDir) {
  const manifestPath = path.join(runDir, 'owner.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  manifest.owner = await deadIdentity()
  await writeFile(manifestPath, JSON.stringify(manifest, undefined, 2))
  return manifest
}

describe('cleanup ownership', () => {
  it('reaps the abandoned run and leaves a concurrently ACTIVE run untouched', async () => {
    // Run A: abandoned. Its owner process is gone; its host is still running.
    const runA = await createRunRoot({ root: sandbox })
    const hostA = await startStandInHost(runA.runDir)
    await recordProcess(runA.runDir, { pid: hostA.pid, role: 'host', ownerToken: runA.ownerToken })
    await orphan(runA.runDir)

    // Run B: another suite, running right now. Its owner is THIS process, which
    // is unambiguously alive — the case the old cleanup destroyed.
    const runB = await createRunRoot({ root: sandbox })
    const hostB = await startStandInHost(runB.runDir)
    await recordProcess(runB.runDir, { pid: hostB.pid, role: 'host', ownerToken: runB.ownerToken })

    assert.equal((await classifyRun(runA.runDir)).state, 'orphan')
    assert.equal((await classifyRun(runB.runDir)).state, 'active')

    const report = await cleanupRuns({ root: sandbox })

    // The orphan is gone: process reaped, directory removed.
    assert.ok(await waitForExit(hostA.pid), 'the orphaned run\'s host process should have been reaped')
    assert.equal(existsSync(runA.runDir), false, 'the orphaned run root should have been removed')

    // The live run is untouched: still running, still on disk, still complete.
    assert.equal(isAlive(hostB.pid), true, 'the ACTIVE run\'s host process must survive cleanup')
    assert.equal(existsSync(runB.runDir), true, 'the ACTIVE run root must survive cleanup')
    assert.equal(existsSync(path.join(runB.runDir, 'owner.json')), true)
    assert.equal(existsSync(path.join(runB.runDir, 'home')), true)
    assert.equal(existsSync(path.join(runB.runDir, 'workspace')), true)

    // And cleanup says so, by name, rather than silently.
    assert.equal(report.reaped.length, 1)
    assert.equal(report.reaped[0].runDir, runA.runDir)
    const skipped = report.skipped.find((entry) => entry.runDir === runB.runDir)
    assert.ok(skipped !== undefined, 'the skipped ACTIVE run must be reported')
    assert.equal(skipped.state, 'active')
    assert.match(skipped.reason, /owner pid \d+ is alive/)

    hostB.kill('SIGKILL')
    await waitForExit(hostB.pid)
  })

  it('refuses to signal a recycled pid (identity drift), but still clears the tree', async () => {
    const run = await createRunRoot({ root: sandbox })
    // A real, unrelated live process that happens to hold the pid we recorded.
    const bystander = await startStandInHost(run.runDir)
    await recordProcess(run.runDir, { pid: bystander.pid, role: 'host', ownerToken: run.ownerToken })

    // Simulate the recycle: same pid, different kernel start time.
    const manifestPath = path.join(run.runDir, 'owner.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    manifest.processes[0].startedAt = 'Mon Jan  1 00:00:00 2001'
    manifest.owner = await deadIdentity()
    await writeFile(manifestPath, JSON.stringify(manifest, undefined, 2))

    const report = await reapRun(run.runDir, { root: sandbox })

    assert.equal(isAlive(bystander.pid), true, 'a pid whose identity drifted must NOT be signalled')
    assert.equal(report.processes.length, 1)
    assert.equal(report.processes[0].sent, false)
    assert.match(report.processes[0].reason, /pid reused/)
    assert.equal(existsSync(run.runDir), false, 'the abandoned tree is still cleared')

    bystander.kill('SIGKILL')
    await waitForExit(bystander.pid)
  })

  it('refuses to signal a pid whose command line no longer names the run', async () => {
    const run = await createRunRoot({ root: sandbox })
    // A real process outside the run tree: correct pid, correct start time,
    // wrong argv. This is what a pid recycled within the same second looks like.
    const stranger = spawn('/bin/sleep', ['120'], { stdio: 'ignore' })
    spawned.add(stranger)
    for (let attempt = 0; attempt < 100 && await processIdentity(stranger.pid) === undefined; attempt += 1) {
      await new Promise((resolve) => { setTimeout(resolve, 20) })
    }
    const identity = await processIdentity(stranger.pid)
    assert.ok(identity !== undefined)

    const manifestPath = path.join(run.runDir, 'owner.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    manifest.processes = [{ ...identity, role: 'host' }]
    manifest.owner = await deadIdentity()
    await writeFile(manifestPath, JSON.stringify(manifest, undefined, 2))

    const verdict = await processMatches(identity, { runId: manifest.runId, requireRunIdInCommand: true })
    assert.equal(verdict.ok, false)
    assert.match(verdict.reason, /command line no longer names this runId/)

    const report = await reapRun(run.runDir, { root: sandbox })
    assert.equal(isAlive(stranger.pid), true, 'an unrelated process must never be killed')
    assert.equal(report.processes[0].sent, false)

    stranger.kill('SIGKILL')
    await waitForExit(stranger.pid)
  })

  it('reaps a recorded process TREE, not just its root', async () => {
    // A browser is a process tree: killing only the parent strands the renderer
    // and GPU helpers, which then keep running (and keep the run's ports and
    // profile busy) after cleanup reported success. The recorded process leads
    // its own group, so the group is exactly that subtree.
    const run = await createRunRoot({ root: sandbox })
    const kidsFile = path.join(run.runDir, 'kids.json')
    const script = path.join(run.runDir, 'stand-in-tree.mjs')
    await writeFile(script, `
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
const kids = [spawn('/bin/sleep', ['300'], { stdio: 'ignore' }), spawn('/bin/sleep', ['300'], { stdio: 'ignore' })]
writeFileSync(${JSON.stringify(kidsFile)}, JSON.stringify(kids.map((k) => k.pid)))
setTimeout(() => process.exit(0), 300_000)
`)
    // `detached` makes the child a process-group leader, which is what the real
    // browser launch also produces.
    const tree = spawn(process.execPath, [script], { stdio: 'ignore', detached: true })
    spawned.add(tree)
    for (let attempt = 0; attempt < 200 && !existsSync(kidsFile); attempt += 1) {
      await new Promise((resolve) => { setTimeout(resolve, 25) })
    }
    const kidPids = JSON.parse(await readFile(kidsFile, 'utf8'))
    assert.equal(kidPids.length, 2)
    assert.ok(kidPids.every((pid) => isAlive(pid)), 'both helpers are running before the reap')

    const recorded = await recordProcess(run.runDir, { pid: tree.pid, role: 'browser', ownerToken: run.ownerToken })
    assert.equal(recorded.pgid, tree.pid, 'the stand-in leads its own process group')
    await orphan(run.runDir)

    const report = await reapRun(run.runDir, { root: sandbox })
    assert.equal(report.processes[0].sent, true)
    assert.equal(report.processes[0].scope, 'group', 'a group leader must be signalled as a group')
    assert.ok(await waitForExit(tree.pid), 'the recorded process must be gone')
    for (const pid of kidPids) {
      assert.ok(await waitForExit(pid), `helper ${pid} must not survive the reap`)
    }
  })

  it('a process whose argv cannot name the runId is still identified, and drift still refuses', async () => {
    // Playwright launches the browser with ITS own random profile path, so that
    // argv never mentions our runId. Demanding it would make the browser
    // permanently unreapable; the rule that applies instead is pid + kernel
    // start second + byte-exact argv, decided when we recorded it.
    const run = await createRunRoot({ root: sandbox })
    const outsider = spawn('/bin/sleep', ['300'], { stdio: 'ignore' })
    spawned.add(outsider)
    for (let attempt = 0; attempt < 100 && await processIdentity(outsider.pid) === undefined; attempt += 1) {
      await new Promise((resolve) => { setTimeout(resolve, 20) })
    }
    const recorded = await recordProcess(run.runDir, { pid: outsider.pid, role: 'browser', ownerToken: run.ownerToken })
    assert.equal(recorded !== undefined, true)

    const manifestPath = path.join(run.runDir, 'owner.json')
    const written = JSON.parse(await readFile(manifestPath, 'utf8'))
    assert.equal(written.processes[0].runIdInCommand, false, 'the argv genuinely does not name the runId')

    // Drift still protects it: same pid, different start second → no signal.
    const drifted = JSON.parse(JSON.stringify(written))
    drifted.processes[0].startedAt = 'Mon Jan  1 00:00:00 2001'
    drifted.owner = await deadIdentity()
    await writeFile(manifestPath, JSON.stringify(drifted, undefined, 2))
    const refused = await reapRun(run.runDir, { root: sandbox })
    assert.equal(refused.processes[0].sent, false)
    assert.match(refused.processes[0].reason, /pid reused/)
    assert.equal(isAlive(outsider.pid), true, 'a drifted browser entry must not be killed either')

    outsider.kill('SIGKILL')
    await waitForExit(outsider.pid)
  })

  it('leaves a directory with no manifest yet alone (a run that is starting up)', async () => {
    const halfBorn = await mkdtemp(path.join(sandbox, 'agos-host-integration-run-halfborn-'))
    const verdict = await classifyRun(halfBorn)
    assert.equal(verdict.state, 'unreadable')

    const report = await cleanupRuns({ root: sandbox })
    assert.equal(existsSync(halfBorn), true, 'a run root without a manifest yet must not be deleted')
    assert.ok(report.skipped.some((entry) => entry.runDir === halfBorn && entry.state === 'unreadable'))
    await rm(halfBorn, { recursive: true, force: true })
  })

  it('lets a run dispose itself, killing only its own recorded process', async () => {
    const mine = await createRunRoot({ root: sandbox })
    const host = await startStandInHost(mine.runDir)
    await recordProcess(mine.runDir, { pid: host.pid, role: 'host', ownerToken: mine.ownerToken })

    const neighbour = await createRunRoot({ root: sandbox })
    const neighbourHost = await startStandInHost(neighbour.runDir)
    await recordProcess(neighbour.runDir, { pid: neighbourHost.pid, role: 'host', ownerToken: neighbour.ownerToken })

    const report = await disposeRunRoot(mine)
    assert.equal(report.reaped, true)
    assert.ok(await waitForExit(host.pid))
    assert.equal(existsSync(mine.runDir), false)
    assert.equal(isAlive(neighbourHost.pid), true, 'disposing one run must not touch its neighbour')
    assert.equal(existsSync(neighbour.runDir), true)

    neighbourHost.kill('SIGKILL')
    await waitForExit(neighbourHost.pid)
    await rm(neighbour.runDir, { recursive: true, force: true })
  })

  it('will not delete a path outside the temp root or without the run prefix', async () => {
    /** Give a directory a manifest that classifies as an orphan, so only the path guards can stop the delete. */
    const makeReapable = async (dir) => {
      await writeFile(path.join(dir, 'owner.json'), JSON.stringify({
        harness: 'agos-host-integration',
        version: 1,
        runId: 'guard-test',
        ownerToken: 'guard',
        owner: await deadIdentity(),
        processes: [],
      }))
    }

    const wrongName = await mkdtemp(path.join(sandbox, 'not-a-run-'))
    await makeReapable(wrongName)
    assert.equal((await classifyRun(wrongName)).state, 'orphan')
    await assert.rejects(() => reapRun(wrongName, { root: sandbox }), /not a harness run directory/)
    assert.equal(existsSync(wrongName), true)

    const elsewhere = await mkdtemp(path.join(sandbox, 'agos-host-integration-run-elsewhere-'))
    await makeReapable(elsewhere)
    await assert.rejects(() => reapRun(elsewhere, { root: path.join(sandbox, 'nested') }), /outside/)
    assert.equal(existsSync(elsewhere), true)

    await rm(elsewhere, { recursive: true, force: true })
    await rm(wrongName, { recursive: true, force: true })
  })

  it('the shipped cleanup CLI makes the same decisions', async () => {
    const orphanRun = await createRunRoot({ root: sandbox })
    const orphanHost = await startStandInHost(orphanRun.runDir)
    await recordProcess(orphanRun.runDir, { pid: orphanHost.pid, role: 'host', ownerToken: orphanRun.ownerToken })
    await orphan(orphanRun.runDir)

    const liveRun = await createRunRoot({ root: sandbox })
    const liveHost = await startStandInHost(liveRun.runDir)
    await recordProcess(liveRun.runDir, { pid: liveHost.pid, role: 'host', ownerToken: liveRun.ownerToken })

    const output = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [CLEANUP_CLI, '--root', sandbox], { stdio: ['ignore', 'pipe', 'pipe'] })
      let text = ''
      child.stdout.on('data', (chunk) => { text += chunk })
      child.stderr.on('data', (chunk) => { text += chunk })
      child.on('error', reject)
      child.on('exit', (code) => resolve({ code, text }))
    })

    assert.equal(output.code, 0, output.text)
    assert.ok(await waitForExit(orphanHost.pid), output.text)
    assert.equal(existsSync(orphanRun.runDir), false)
    assert.equal(isAlive(liveHost.pid), true, `the CLI must not kill a live run:\n${output.text}`)
    assert.equal(existsSync(liveRun.runDir), true)
    assert.match(output.text, new RegExp(`skipped\\s+${liveRun.runDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))

    liveHost.kill('SIGKILL')
    await waitForExit(liveHost.pid)
    await rm(liveRun.runDir, { recursive: true, force: true })
  })
})
