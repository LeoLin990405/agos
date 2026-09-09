/**
 * Defect 2 regression: a bring-up that fails part-way must leave nothing behind.
 *
 * `createHarness` used to hand disposal to the context object it returned, so a
 * failure at any stage after the first threw before that object existed: the
 * real dsh host it had already started kept running, its temp DSH_HOME stayed
 * on disk, its port stayed bound, and a launched Chrome stayed resident. There
 * was no handle to clean any of it up with.
 *
 * Each test here fails ONE stage and then asks the operating system what
 * survived. The resources are real — real spawned child processes, real bound
 * TCP ports, real directories — so "was it reclaimed" is answered by `kill -0`,
 * by re-binding the port, and by `existsSync`, not by a spy. Only the failure
 * itself is injected, through the documented `deps` seam; substituting the
 * pinned host and Chrome for cheap real processes is what lets every stage be
 * failed in turn without a full dependency tree.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHarness } from '../harness.mjs';
import { createRunRoot } from '../../../scripts/host-integration/run-registry.mjs';

let sandbox
let artifactDir
const strays = new Set()

before(async () => {
  sandbox = await mkdtemp(path.join(tmpdir(), 'agos-unwind-'))
  artifactDir = path.join(sandbox, 'artifacts')
})

after(async () => {
  for (const child of strays) { try { child.kill('SIGKILL') } catch { /* gone */ } }
  if (sandbox !== undefined) await rm(sandbox, { recursive: true, force: true })
})

/** Is this pid alive right now, according to the OS? */
function isAlive(pid) {
  try { process.kill(pid, 0); return true } catch { return false }
}

/** Wait for a real process to be gone. */
async function waitForExit(pid, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true
    await new Promise((resolve) => { setTimeout(resolve, 25) })
  }
  return false
}

/** Can this port be bound again? (proves the listener really let go) */
function portIsFree(port) {
  return new Promise((resolve) => {
    const probe = createServer()
    probe.once('error', () => resolve(false))
    probe.once('listening', () => probe.close(() => resolve(true)))
    probe.listen(port, '127.0.0.1')
  })
}

/**
 * A real, long-lived child process standing in for the host or the browser.
 *
 * It exits on its own after five minutes. These tests exist to prove nothing is
 * stranded, so a stand-in that outlives a runner killed mid-suite (a hard
 * timeout, a `kill -9`) would be the very leak under test — with no `after`
 * hook left to clean it up.
 */
async function spawnStandIn(label, dir) {
  const script = path.join(dir, `${label}.mjs`)
  await writeFile(script, 'setTimeout(() => process.exit(0), 300_000)\n')
  const child = spawn(process.execPath, [script], { stdio: 'ignore' })
  strays.add(child)
  return child
}

/**
 * Build a `deps` set whose stages are real resources, with exactly one stage
 * rigged to fail (or to hang).
 * @param options.failAt - stage name to fail at.
 * @param options.hangAt - stage that stalls far past the bring-up deadline.
 * @param options.hangMs - how long the stalled stage takes to finally answer.
 * @param options.skipRegister - stages that do NOT hand their resource over
 *   early, so the late-arrival path can be exercised.
 * @param options.abortAt - abort the caller's controller during this stage.
 * @param options.controller - the caller's AbortController.
 * @param options.throwAfterBrowserSpawn - fail after spawning an identifiable browser child.
 * @returns `{ deps, seen }` where `seen` collects the real resources created.
 */
function realDeps({ failAt, hangAt, hangMs = 1500, skipRegister = [], abortAt, controller, throwAfterBrowserSpawn = false } = {}) {
  const seen = { hostChild: undefined, browserChild: undefined, uiPort: undefined, runDir: undefined, contextClosed: false, pageClosed: false }

  /** Should this stage hand its resource over the moment it exists? */
  const handOver = (stage, register, label, dispose) => {
    if (skipRegister.includes(stage)) return
    register?.(label, dispose)
  }

  /** Fail (or stall, or abort) if this is the rigged stage. */
  const gate = async (stage) => {
    // A stage that stalls AFTER creating something is the leak-prone shape: the
    // resource exists, the caller has no handle, and nothing returns in time.
    // It answers eventually, which is what lets the late-arrival path be
    // observed rather than merely assumed.
    if (hangAt === stage) await new Promise((resolve) => { setTimeout(resolve, hangMs) })
    if (abortAt === stage) controller?.abort(new Error(`cancelled during ${stage}`))
    if (failAt !== stage) return
    throw new Error(`injected failure at ${stage}`)
  }

  const deps = {
    artifactDir,
    createRunRoot: async () => {
      const created = await createRunRoot({ root: sandbox })
      seen.runDir = created.runDir
      return created
    },
    startHost: async ({ hostPort, register }) => {
      const child = await spawnStandIn('stand-in-host', seen.runDir)
      seen.hostChild = child
      const stop = async () => {
        child.kill('SIGTERM')
        await waitForExit(child.pid, 5000)
        return { code: child.exitCode, signal: child.signalCode }
      }
      // The real startHost hands the process over here too, before it waits on
      // the launch URL.
      handOver('host', register, 'host-process', stop)
      await gate('host')
      return {
        child,
        base: `http://127.0.0.1:${hostPort}`,
        authority: `127.0.0.1:${hostPort}`,
        cookieHeader: 'dsh-auth-stub=stub',
        command: 'stand-in host',
        log: () => '',
        exit: new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal }))),
        pluginStatus: async () => [],
        loadedPlugins: async () => [],
        stop,
      }
    },
    startUiServer: async ({ uiPort, register }) => {
      const server = createServer(() => {})
      const stop = () => new Promise((resolve) => server.close(resolve))
      handOver('ui-server', register, 'ui-server-listener', stop)
      await new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(uiPort, '127.0.0.1', resolve)
      })
      seen.uiPort = uiPort
      await gate('ui-server')
      return { origin: `http://127.0.0.1:${uiPort}`, stop }
    },
    loadPlaywright: async () => {
      await gate('playwright-module')
      return { chromium: {}, modulePath: '(stand-in)', source: 'test', warnings: [] }
    },
    launchBrowser: async ({ register }) => {
      if (throwAfterBrowserSpawn) {
        const script = path.join(seen.runDir, 'chromium-standin.mjs')
        await writeFile(script, 'setTimeout(() => process.exit(0), 300_000)\n')
        const child = spawn(process.execPath, [script], { stdio: 'ignore' })
        seen.browserChild = child
        strays.add(child)
        await new Promise((resolve) => setTimeout(resolve, 50))
        throw new Error('injected launcher failure after browser spawn')
      }
      const child = await spawnStandIn('stand-in-browser', seen.runDir)
      seen.browserChild = child
      const close = async () => { child.kill('SIGTERM'); await waitForExit(child.pid, 5000) }
      handOver('browser', register, 'browser-process', close)
      await gate('browser')
      return {
        version: () => 'stand-in/1.0',
        close,
        newContext: async () => ({
          route: async () => undefined,
          addInitScript: async () => undefined,
          close: async () => { seen.contextClosed = true },
          newPage: async () => ({
            on: () => undefined,
            close: async () => { seen.pageClosed = true },
          }),
        }),
      }
    },
  }

  // The context and page stages live inside createHarness, so they are failed
  // by rigging the objects they are built from.
  if (failAt === 'browser-context' || failAt === 'page') {
    const inner = deps.launchBrowser
    deps.launchBrowser = async (args) => {
      const browser = await inner(args)
      const realNewContext = browser.newContext
      browser.newContext = async () => {
        if (failAt === 'browser-context') throw new Error('injected failure at browser-context')
        const context = await realNewContext()
        context.newPage = async () => { throw new Error('injected failure at page') }
        return context
      }
      return browser
    }
  }

  return { deps, seen }
}

/** Assert that nothing from a broken bring-up survived. */
async function assertFullyReclaimed(seen, { expectContextClosed = false, expectPageClosed = false } = {}) {
  if (seen.hostChild !== undefined) {
    assert.ok(await waitForExit(seen.hostChild.pid), 'the host process must not survive a failed bring-up')
  }
  if (seen.browserChild !== undefined) {
    assert.ok(await waitForExit(seen.browserChild.pid), 'the browser process must not survive a failed bring-up')
  }
  if (seen.uiPort !== undefined) {
    assert.equal(await portIsFree(seen.uiPort), true, 'the SPA port must be released')
  }
  if (seen.runDir !== undefined) {
    assert.equal(existsSync(seen.runDir), false, 'the throwaway run root must be removed')
  }
  if (expectContextClosed) assert.equal(seen.contextClosed, true, 'the browser context must be closed')
  if (expectPageClosed) assert.equal(seen.pageClosed, true, 'the page must be closed')
}

describe('createHarness unwinds every stage it already started', () => {
  it('a failure BETWEEN stages still reclaims what the previous stage created', async () => {
    // Not every step of the bring-up is a stage. The artifact directory, the
    // fake-provider control file and the port claim all sit between `run-root`
    // and `host`, outside any `stack.use`. A throw there never reaches the
    // stack's own error path, so the run root that stage 1 just created can
    // only be reclaimed by the unwind that wraps the whole bring-up.
    const blocker = path.join(sandbox, 'not-a-directory')
    await writeFile(blocker, 'a file, so mkdir below it fails with ENOTDIR\n')
    const { deps, seen } = realDeps({})
    deps.artifactDir = path.join(blocker, 'artifacts')
    await assert.rejects(
      () => createHarness({ deps }),
      (error) => error.code === 'ENOTDIR' || /ENOTDIR/.test(String(error)),
    )
    assert.ok(seen.runDir !== undefined, 'the run root really was created before the failure')
    assert.equal(existsSync(seen.runDir), false, 'the run root must be reclaimed even though no stage threw')
  })

  it('host stage fails → the run root is gone', async () => {
    const { deps, seen } = realDeps({ failAt: 'host' })
    await assert.rejects(() => createHarness({ deps }), /injected failure at host/)
    await assertFullyReclaimed(seen)
  })

  it('UI stage fails → the started host is stopped and the run root is gone', async () => {
    const { deps, seen } = realDeps({ failAt: 'ui-server' })
    await assert.rejects(() => createHarness({ deps }), /injected failure at ui-server/)
    assert.ok(seen.hostChild !== undefined, 'the host really was started before the failure')
    await assertFullyReclaimed(seen)
  })

  it('playwright resolution fails → host and SPA port are both released', async () => {
    const { deps, seen } = realDeps({ failAt: 'playwright-module' })
    await assert.rejects(() => createHarness({ deps }), /injected failure at playwright-module/)
    assert.ok(seen.uiPort !== undefined, 'the SPA server really was bound before the failure')
    await assertFullyReclaimed(seen)
  })

  it('browser launch fails → everything under it is released', async () => {
    const { deps, seen } = realDeps({ failAt: 'browser' })
    await assert.rejects(() => createHarness({ deps }), /injected failure at browser/)
    await assertFullyReclaimed(seen)
  })

  it('launcher throws after spawning browser → partial browser is reclaimed', async () => {
    const { deps, seen } = realDeps({ throwAfterBrowserSpawn: true })
    await assert.rejects(() => createHarness({ deps }), /launcher failure after browser spawn/)
    assert.ok(seen.browserChild !== undefined, 'the launcher really spawned a browser child')
    assert.ok(await waitForExit(seen.browserChild.pid), 'the partial browser must be killed before unwind returns')
    await assertFullyReclaimed(seen)
  })

  it('context creation fails → the launched browser process is killed too', async () => {
    const { deps, seen } = realDeps({ failAt: 'browser-context' })
    await assert.rejects(() => createHarness({ deps }), /injected failure at browser-context/)
    assert.ok(seen.browserChild !== undefined, 'the browser really was launched before the failure')
    await assertFullyReclaimed(seen)
  })

  it('page creation fails → the context is closed and the browser killed', async () => {
    const { deps, seen } = realDeps({ failAt: 'page' })
    await assert.rejects(() => createHarness({ deps }), /injected failure at page/)
    await assertFullyReclaimed(seen, { expectContextClosed: true })
  })

  it('cancelled mid-bring-up → the already-started stages are reclaimed', async () => {
    const controller = new AbortController()
    const { deps, seen } = realDeps({ abortAt: 'ui-server', controller })
    await assert.rejects(
      () => createHarness({ deps, signal: controller.signal }),
      (error) => error.name === 'BringUpAborted' || /cancelled/.test(String(error.message)),
    )
    assert.ok(seen.hostChild !== undefined, 'the host was started before the cancellation')
    await assertFullyReclaimed(seen)
  })

  it('a stage that stalls past the deadline is abandoned and its resource reclaimed', async () => {
    const { deps, seen } = realDeps({ hangAt: 'browser', hangMs: 4000 })
    const started = Date.now()
    await assert.rejects(
      () => createHarness({ deps, bringUpTimeoutMs: 400 }),
      (error) => error.name === 'BringUpAborted',
    )
    const elapsed = Date.now() - started
    assert.ok(elapsed < 3000, `the deadline must not wait for the stalled stage (took ${elapsed}ms)`)
    assert.ok(seen.browserChild !== undefined, 'the stalled stage really did spawn a process')
    await assertFullyReclaimed(seen)
  })

  it('a resource that arrives AFTER the bring-up was abandoned is still reclaimed', async () => {
    // The stalled stage does not hand its process over early, so the only way
    // the process can be reclaimed is by disposing the value it returns once it
    // finally answers — long after the harness gave up on it.
    const { deps, seen } = realDeps({ hangAt: 'browser', hangMs: 1200, skipRegister: ['browser'] })
    await assert.rejects(
      () => createHarness({ deps, bringUpTimeoutMs: 300 }),
      (error) => error.name === 'BringUpAborted',
    )
    assert.equal(isAlive(seen.browserChild.pid), true, 'the stalled process is still running when we give up')
    assert.ok(await waitForExit(seen.browserChild.pid), 'the late-arriving browser must be closed when it shows up')
    assert.equal(existsSync(seen.runDir), false)
  })

  it('a successful bring-up disposes through the same unwinder', async () => {
    const { deps, seen } = realDeps({})
    const harness = await createHarness({ deps })
    assert.equal(existsSync(seen.runDir), true)
    assert.equal(isAlive(seen.hostChild.pid), true)
    await harness.dispose()
    await assertFullyReclaimed(seen, { expectContextClosed: true, expectPageClosed: true })
  })
})
