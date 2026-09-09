/**
 * Defect 5 (environment isolation) and the plugin-mount interface, both
 * exercised against a REAL spawned host process.
 *
 * The launcher under test is `scripts/host-integration/start-host.mjs`. It is
 * driven here against `fixtures/stub-dsh-host.mjs` — a separate, real process
 * that speaks the same launch protocol the pinned dsh host speaks (launch URL
 * with a one-process token, token→cookie exchange, `POST /api/session/list`).
 * That makes every claim below a runtime observation of a real child process
 * rather than a reading of the source:
 *
 * - the child records the environment it actually received, so "no credentials
 *   reach it", "DSH_HOME is the throwaway tree", and "HOME is untouched" are
 *   checked against what the kernel handed the process;
 * - the child prints its launch token SPLIT ACROSS TWO WRITES, so the log file
 *   is real evidence for the chunk-boundary redaction fix;
 * - the child reads the `--patch` overlay and only answers routes for the
 *   plugins the overlay really inserted, so `pluginStatus()` is answered by the
 *   host, not by the launcher's own bookkeeping.
 *
 * The parent environment is deliberately poisoned before the spawn (a synthetic
 * API key, a DSH_PROFILE pointing at live state, a NODE_OPTIONS preload). A
 * test that did not poison it would pass on a clean shell and prove nothing.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, realpathSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const STUB_HOST = fileURLToPath(new URL('./fixtures/stub-dsh-host.mjs', import.meta.url))

// Poison the parent environment BEFORE the launcher module reads it. These are
// synthetic values; none of them is a real credential.
const POISON = {
  DEEPSEEK_API_KEY: 'synthetic-key-must-not-reach-the-child-0001',
  AGOS_TEST_SESSION_KEY: 'synthetic-session-key-must-not-reach-0002',
  DSH_PROFILE: 'live-profile-must-not-be-inherited',
  DSH_CONFIG: path.join(homedir(), '.dsh/config.json'),
  NODE_OPTIONS: '--require /tmp/agos-should-never-be-preloaded.js',
}
for (const [key, value] of Object.entries(POISON)) process.env[key] = value

// The launcher resolves the dsh binary at module-evaluation time, and it
// spawns it with dsh's own flags — so the stand-in has to be a real executable
// that accepts them, not a script passed to node.
const { mkdtempSync, writeFileSync } = await import('node:fs')
const BIN_DIR = mkdtempSync(path.join(tmpdir(), 'agos-stub-bin-'))
const STUB_BIN = path.join(BIN_DIR, 'dsh')
writeFileSync(STUB_BIN, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(STUB_HOST)} "$@"\n`, { mode: 0o755 })
process.env.AGOS_DSH_BIN = STUB_BIN

// A high-entropy prefix: the reconstruction metric below asks how many leading
// characters survive, so a token starting with a word that appears in fixture
// paths would make the assertion meaningless.
const LAUNCH_TOKEN = 'Q7vKz3x9Lm2Pr8Ta5Wd1Nb6Yc4Hg0Fj7Qe'
const SHAPED_SECRET = 'sk-Wr4Ym9Qz2Xb7Nc5Vt8Lp1Kd3Rj6Gs'
process.env.AGOS_STUB_LAUNCH_VALUE = LAUNCH_TOKEN
process.env.AGOS_STUB_SHAPED_VALUE = SHAPED_SECRET
process.env.AGOS_STUB_FAIL_PLUGINS = 'plugin-that-fails-to-load'

const { startHost } = await import('../../../scripts/host-integration/start-host.mjs')
const { claimPorts, hostEnv, isolatedEnvNames, scrubbedEnvNames } = await import('../../../scripts/host-integration/host-env.mjs')
const { createRunRoot, disposeRunRoot, readManifest } = await import('../../../scripts/host-integration/run-registry.mjs')

let sandbox
let run
let host
let logPath
let childEnv

/** Longest prefix of `secret` recoverable from `text`. */
function longestRecoverablePrefix(text, secret) {
  let best = 0
  for (let length = 1; length <= secret.length; length += 1) {
    if (!text.includes(secret.slice(0, length))) break
    best = length
  }
  return best
}

/**
 * Longest CONTIGUOUS RUN of the secret recoverable from the text — the
 * reconstruction attack itself.
 *
 * ⚠️ Measuring only the prefix is not enough. A counter-proof on a throwaway
 * copy showed that reverting the redaction order leaks the token's TAIL
 * (`?token=[REDACTED]a7b8c9d0e1f2`) while every prefix check still reads zero.
 * The secrets above are deliberately word-free so that any run of 8 characters
 * found in the log is a leak rather than a coincidence.
 */
function longestRecoverableRun(text, secret) {
  let best = 0
  for (let start = 0; start < secret.length; start += 1) {
    for (let end = secret.length; end > start + best; end -= 1) {
      if (text.includes(secret.slice(start, end))) { best = end - start; break }
    }
  }
  return best
}

before(async () => {
  sandbox = await mkdtemp(path.join(tmpdir(), 'agos-host-isolation-'))
  run = await createRunRoot({ root: sandbox })
  const [hostPort, uiPort] = await claimPorts(2, 40311)
  const controlFile = path.join(run.dshHome, 'fake-control.json')
  await writeFile(controlFile, JSON.stringify({ toolLabel: 'synthetic-action' }) + '\n')
  logPath = path.join(sandbox, 'host.log')

  // A plugin entry that really exists on disk, so `mounted` is a fact.
  const realPluginEntry = path.join(sandbox, 'real-plugin.mjs')
  await writeFile(realPluginEntry, 'export const name = "loads-fine"\nexport function apply() {}\n')
  const failingPluginEntry = path.join(sandbox, 'failing-plugin.mjs')
  await writeFile(failingPluginEntry, 'throw new Error("this plugin explodes on load")\n')

  host = await startHost({
    dshHome: run.dshHome,
    workspace: run.workspace,
    hostPort,
    uiPort,
    controlFile,
    logPath,
    runDir: run.runDir,
    runId: run.runId,
    ownerToken: run.ownerToken,
    // A fixture host answers immediately; a smaller budget makes a broken
    // launch fail in seconds instead of sitting out the real host's budget.
    launchTimeoutMs: 15_000,
    cookieTimeoutMs: 15_000,
    readyTimeoutMs: 15_000,
    plugins: [
      {
        id: 'plugin-that-loads',
        entry: realPluginEntry,
        probe: { kind: 'unary', method: 'plugin/plugin-that-loads/ping' },
      },
      {
        id: 'plugin-that-fails-to-load',
        entry: failingPluginEntry,
        probe: { kind: 'unary', method: 'plugin/plugin-that-fails-to-load/ping' },
      },
      {
        id: 'plugin-with-a-missing-entry',
        entry: path.join(sandbox, 'does-not-exist.mjs'),
        probe: { kind: 'unary', method: 'plugin/plugin-with-a-missing-entry/ping' },
      },
      { id: 'plugin-without-a-probe', entry: realPluginEntry },
    ],
  })
  childEnv = JSON.parse(await readFile(path.join(run.dshHome, 'stub-env.json'), 'utf8'))
})

after(async () => {
  await host?.stop()
  if (run !== undefined) await disposeRunRoot(run)
  if (sandbox !== undefined) await rm(sandbox, { recursive: true, force: true })
  await rm(BIN_DIR, { recursive: true, force: true })
  for (const key of Object.keys(POISON)) delete process.env[key]
})

describe('the real child process runs in an isolated environment', () => {
  it('receives a throwaway DSH_HOME, never the live profile tree', () => {
    assert.equal(childEnv.env.DSH_HOME, run.dshHome)
    assert.ok(run.dshHome.startsWith(sandbox), 'DSH_HOME must live inside the run sandbox')
    assert.equal(run.dshHome.startsWith(path.join(homedir(), '.dsh')), false)
    // macOS resolves /var to /private/var for the child's cwd.
    assert.equal(realpathSync(childEnv.cwd), realpathSync(run.workspace), 'the host runs in the throwaway workspace')
    // Proof the child really used it: it wrote its evidence file there.
    assert.equal(existsSync(path.join(run.dshHome, 'stub-env.json')), true)
  })

  it('receives no credential-shaped variable, including ones the parent had', () => {
    const leaked = Object.keys(childEnv.env)
      .filter((key) => /(API_?KEY|_TOKEN|SECRET|PASSWORD|CREDENTIAL|SESSION_KEY|COOKIE)/i.test(key))
    assert.deepEqual(leaked, [], `credential-shaped variables reached the child: ${leaked.join(', ')}`)
    assert.equal(childEnv.env.DEEPSEEK_API_KEY, undefined)
    assert.equal(childEnv.env.AGOS_TEST_SESSION_KEY, undefined)
    // And the values are gone too, not just the names.
    const serialized = JSON.stringify(childEnv.env)
    assert.equal(serialized.includes(POISON.DEEPSEEK_API_KEY), false)
    assert.equal(serialized.includes(POISON.AGOS_TEST_SESSION_KEY), false)
    // The parent really did hold them, so the assertion above had something to catch.
    assert.ok(scrubbedEnvNames().includes('DEEPSEEK_API_KEY'))
  })

  it('drops every inherited DSH_* variable, so DSH_HOME is not the only override', () => {
    assert.equal(childEnv.env.DSH_PROFILE, undefined, 'an inherited DSH_PROFILE would steer the host back at live state')
    assert.equal(childEnv.env.DSH_CONFIG, undefined)
    // Only the harness's own dsh variables survive.
    const dshVars = Object.keys(childEnv.env).filter((key) => key.startsWith('DSH_')).sort()
    assert.deepEqual(dshVars, ['DSH_HOME', 'DSH_PERMISSION_MODE', 'DSH_TELEMETRY_DISABLED'])
    assert.equal(childEnv.env.DSH_TELEMETRY_DISABLED, '1')
    assert.ok(isolatedEnvNames().includes('DSH_PROFILE'))
  })

  it('drops NODE_OPTIONS, so no operator preload is injected into the host', () => {
    assert.equal(childEnv.env.NODE_OPTIONS, undefined)
    assert.ok(isolatedEnvNames().includes('NODE_OPTIONS'))
  })

  it('leaves HOME and CODEX_HOME exactly as they were', () => {
    assert.equal(childEnv.env.HOME, process.env.HOME)
    assert.equal(childEnv.env.CODEX_HOME, process.env.CODEX_HOME)
  })

  it('no surviving variable points into the live ~/.dsh tree', () => {
    const live = path.join(homedir(), '.dsh')
    const pointing = Object.entries(childEnv.env)
      .filter(([, value]) => typeof value === 'string' && value.includes(live))
      .map(([key]) => key)
    assert.deepEqual(pointing, [], `these variables point at the live profile: ${pointing.join(', ')}`)
  })

  it('hostEnv is a pure function of the environment it is handed', () => {
    const built = hostEnv({ DSH_HOME: '/tmp/x' }, {
      PATH: '/usr/bin',
      HOME: '/Users/someone',
      OPENAI_API_KEY: 'synthetic',
      DSH_PROFILE: 'live',
      NODE_OPTIONS: '--require evil',
    })
    assert.deepEqual(Object.keys(built).sort(), ['DSH_HOME', 'DSH_TELEMETRY_DISABLED', 'HOME', 'PATH'])
    assert.equal(built.DSH_HOME, '/tmp/x')
  })
})

describe('the launcher never writes a recoverable secret to the log', () => {
  it('the split launch token is not reconstructible from the real log file', async () => {
    const log = await readFile(logPath, 'utf8')
    assert.equal(log.includes(LAUNCH_TOKEN), false, 'the launch token appeared verbatim in the log')
    const recovered = longestRecoverablePrefix(log, LAUNCH_TOKEN)
    assert.ok(recovered < 4, `${recovered} leading characters of the launch token survived in the log`)
    const run = longestRecoverableRun(log, LAUNCH_TOKEN)
    assert.ok(run < 8, `a ${run}-character run of the launch token survived in the log`)
    assert.match(log, /token=\[REDACTED\]\s/)
  })

  it('a never-registered secret is caught by its shape despite the split', async () => {
    const log = await readFile(logPath, 'utf8')
    assert.equal(log.includes(SHAPED_SECRET), false)
    assert.ok(longestRecoverablePrefix(log, SHAPED_SECRET) < 6, log)
    assert.ok(longestRecoverableRun(log, SHAPED_SECRET) < 8, log)
  })

  it('ordinary output, including Chinese, survives intact', async () => {
    const log = await readFile(logPath, 'utf8')
    assert.match(log, /宿主已就绪:合成中文日志行/)
    assert.match(log, /dsh listening/)
  })

  it('the log header records what was stripped', async () => {
    const log = await readFile(logPath, 'utf8')
    assert.match(log, /credential env vars stripped from child: .*DEEPSEEK_API_KEY/)
    assert.match(log, /inherited dsh\/node env dropped for isolation: .*NODE_OPTIONS/)
  })
})

describe('the run manifest records the host process identity', () => {
  it('stores pid, kernel start time and command line for the spawned host', async () => {
    const manifest = await readManifest(run.runDir)
    const entry = manifest.processes.find((process_) => process_.role === 'host')
    assert.ok(entry !== undefined, 'the host pid must be recorded for cleanup')
    assert.equal(entry.pid, host.child.pid)
    assert.match(entry.startedAt, /\d{2}:\d{2}:\d{2}/)
    assert.ok(entry.command.includes(run.runId), 'the recorded command line must name the runId')
  })
})

describe('plugin mounting and load verification', () => {
  it('reports per-plugin load state verified against the running host', async () => {
    const status = await host.pluginStatus()
    const byId = Object.fromEntries(status.map((entry) => [entry.id, entry]))

    assert.equal(byId['plugin-that-loads'].mounted, true)
    assert.equal(byId['plugin-that-loads'].loaded, true, byId['plugin-that-loads'].detail)

    // Mounted into the overlay, but the host did not bring its route up.
    assert.equal(byId['plugin-that-fails-to-load'].mounted, true)
    assert.equal(byId['plugin-that-fails-to-load'].loaded, false)
    assert.match(byId['plugin-that-fails-to-load'].detail, /404|not mounted/)

    // A missing entry is caught before the loader ever sees it.
    assert.equal(byId['plugin-with-a-missing-entry'].mounted, false)
    assert.equal(byId['plugin-with-a-missing-entry'].loaded, false)
    assert.match(byId['plugin-with-a-missing-entry'].detail, /entry does not exist/)

    // No probe means unverified — reported as null, never as a pass.
    assert.equal(byId['plugin-without-a-probe'].loaded, null)
    assert.match(byId['plugin-without-a-probe'].detail, /unverified/)
  })

  it('loadedPlugins() lists only the plugins that really answered', async () => {
    assert.deepEqual(await host.loadedPlugins(), ['plugin-that-loads'])
  })

  it('the overlay disables the paid provider and routes the loop at the fake one', async () => {
    const overlay = JSON.parse(await readFile(host.overlayPath, 'utf8'))
    const disabled = overlay.filter((entry) => entry.disabled === true).map((entry) => entry.id)
    assert.ok(disabled.includes('llm-deepseek'), 'the real provider adapter must be disabled')
    assert.ok(disabled.includes('web-search-deepseek'))
    assert.ok(disabled.includes('session-telemetry-otel'))
    const route = overlay.find((entry) => entry.id === 'agent-default-model')
    assert.deepEqual(route.config, { provider: 'agos-fake', model: 'agos-fake-1' })
    // The host really read this overlay: it says so on its own stdout.
    const log = await readFile(logPath, 'utf8')
    assert.match(log, /mounted plugins: .*plugin-that-loads/)
  })

  it('a plugin spec without an id or an entry is refused up front', async () => {
    const scratch = await createRunRoot({ root: sandbox })
    const [port, uiPort] = await claimPorts(2, 40511)
    await assert.rejects(
      () => startHost({
        dshHome: scratch.dshHome,
        workspace: scratch.workspace,
        hostPort: port,
        uiPort,
        controlFile: path.join(scratch.dshHome, 'c.json'),
        logPath: path.join(sandbox, 'refused.log'),
        launchTimeoutMs: 5_000,
        plugins: [{ id: 'no-entry-here' }],
      }),
      /needs an `entry`/,
    )
    await disposeRunRoot(scratch)
  })
})
