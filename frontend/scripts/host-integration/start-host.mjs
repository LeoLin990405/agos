/**
 * Boot a REAL pinned dsh host (0.1.2-rc.1) in complete isolation.
 *
 * What is real: the dsh CLI from the pinned global install, the `web` profile
 * composition, the agent loop, the session log on disk, the approval seam, the
 * api-gateway, and the /api + /api/remote.mux transport.
 *
 * What is isolated: DSH_HOME points at a throwaway directory inside this run's
 * own root, so the host's profile, sessions, storages and settings all live in
 * a temp tree and the user's ~/.dsh is neither read nor written. Every other
 * inherited `DSH_*` variable is dropped too (see hostEnv). HOME and CODEX_HOME
 * are untouched.
 *
 * What is faked: only the model provider and the tool body (see
 * fake-harness-plugin.mjs). The real DeepSeek adapter is disabled and every
 * credential-shaped environment variable is stripped, so no paid call is
 * reachable.
 *
 * Two seams other packages depend on:
 * - `plugins`: extra cordis plugins to mount into the throwaway host, for
 *   suites that need a real plugin's real routes (see PLUGIN MOUNTING below).
 * - `pluginStatus()`: what actually loaded, verified against the running host,
 *   so a caller can report `blocked` instead of guessing when a plugin is
 *   absent.
 */
import { spawn } from 'node:child_process';
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { existsSync, createWriteStream } from 'node:fs';
import path from 'node:path';
import {
  DSH_BIN, HARNESS_DIR, hostEnv, isolatedEnvNames, redact, registerSecret, scrubbedEnvNames, waitFor,
} from './host-env.mjs';
import { createRedactingWriter } from './redact-stream.mjs';
import { recordProcess } from './run-registry.mjs';

const PROFILE = 'web'
const FAKE_PROVIDER = 'agos-fake'
const FAKE_MODEL = 'agos-fake-1'

/**
 * PLUGIN MOUNTING — the interface other packages build on.
 *
 * @typedef {Object} HostPluginSpec
 * @property {string} id - loader id, unique within the overlay. This is the id
 *   the patch list targets and the id `pluginStatus()` reports under.
 * @property {string} [entry] - absolute path to the plugin entry module (the
 *   loader turns an absolute name into a file:// URL, so no installation is
 *   needed), or a bare package name resolvable from the throwaway profile.
 *   Omit together with `disabled: true` to switch a stock plugin off.
 * @property {Record<string, unknown>} [config] - loader config for the plugin.
 * @property {boolean} [disabled] - disable an already-composed plugin by id.
 * @property {HostPluginProbe} [probe] - how to VERIFY it really loaded. Absent
 *   means "cannot be verified", which is reported as `loaded: null` — never as
 *   a pass.
 *
 * @typedef {{kind: 'unary', method: string, args?: Record<string, unknown>}
 *         | {kind: 'http', path: string, method?: string, body?: unknown}
 *         | {kind: 'log', pattern: string}
 *         | {kind: 'none'}} HostPluginProbe
 *
 * @typedef {Object} HostPluginStatus
 * @property {string} id
 * @property {string} [entry]
 * @property {boolean} requested - it was asked for by the caller.
 * @property {boolean} mounted - its entry exists and reached the overlay.
 * @property {boolean|null} loaded - probe verdict; null when unverifiable.
 * @property {string} detail - the evidence behind `loaded`.
 */

/**
 * Materialize the throwaway profile: copy the fake plugin in beside the profile
 * root (so its @deepseek-ai imports resolve through the profile module
 * fallback) and write the `--patch` overlay that swaps the real provider out
 * and mounts whatever extra plugins the caller asked for.
 * @param options.dshHome - the run's throwaway DSH home.
 * @param options.plugins - extra plugins to mount.
 * @returns absolute paths of the overlay and the mounted plugin, plus the
 *   per-plugin mount record.
 */
async function writeProfileOverlay({ dshHome, plugins }) {
  const profileDir = path.join(dshHome, 'profiles', PROFILE)
  const pluginDir = path.join(profileDir, 'agos-harness')
  await mkdir(pluginDir, { recursive: true })
  const pluginPath = path.join(pluginDir, 'index.mjs')
  await copyFile(path.join(HARNESS_DIR, 'fake-harness-plugin.mjs'), pluginPath)

  // A loader patch list: id-targeted overrides plus one insert. The loader
  // converts an absolute plugin name to a file:// URL, so the harness plugin
  // mounts from the profile tree without any package installation.
  const inserts = [{ id: 'agos-fake-harness', name: pluginPath }]
  const overrides = [
    // No real provider adapter is registered at all.
    { id: 'llm-deepseek', disabled: true },
    // No outbound search/telemetry from a hermetic run.
    { id: 'web-search-deepseek', disabled: true },
    { id: 'session-telemetry-otel', disabled: true },
    // The loop's default route becomes the fake provider.
    { id: 'agent-default-model', config: { provider: FAKE_PROVIDER, model: FAKE_MODEL } },
  ]

  const mounts = []
  for (const spec of plugins) {
    if (typeof spec?.id !== 'string' || spec.id === '') {
      throw new Error('host-integration: every plugin spec needs an `id`')
    }
    if (spec.disabled === true) {
      overrides.push({ id: spec.id, disabled: true })
      mounts.push({ ...spec, mounted: false, detail: 'disabled by request' })
      continue
    }
    if (typeof spec.entry !== 'string' || spec.entry === '') {
      throw new Error(`host-integration: plugin ${spec.id} needs an \`entry\` (or \`disabled: true\`)`)
    }
    // An absolute entry that does not exist would fail deep inside the loader
    // with a message the caller cannot act on; say so here instead.
    const absolute = path.isAbsolute(spec.entry)
    if (absolute && !existsSync(spec.entry)) {
      mounts.push({ ...spec, mounted: false, detail: `entry does not exist: ${spec.entry}` })
      continue
    }
    inserts.push({ id: spec.id, name: spec.entry, ...(spec.config === undefined ? {} : { config: spec.config }) })
    mounts.push({ ...spec, mounted: true, detail: absolute ? 'entry file present, inserted into overlay' : 'bare specifier inserted into overlay' })
  }

  const overlay = [...overrides, { insert: inserts }]
  const overlayPath = path.join(dshHome, 'agos-harness-overlay.json')
  await writeFile(overlayPath, JSON.stringify(overlay, undefined, 2) + '\n')
  return { overlayPath, pluginPath, profileDir, mounts, overlay }
}

/**
 * Run one plugin probe against the live host.
 * @param probe - the probe descriptor.
 * @param wire - `{ base, cookieHeader, log }` for reaching the host.
 * @returns `{ loaded, detail }`.
 */
async function runProbe(probe, wire) {
  if (probe === undefined || probe.kind === 'none') {
    return { loaded: null, detail: 'no probe declared — load state unverified' }
  }
  try {
    if (probe.kind === 'log') {
      const matched = new RegExp(probe.pattern).test(wire.log())
      return { loaded: matched, detail: `host log ${matched ? 'matches' : 'does not match'} /${probe.pattern}/` }
    }
    const target = probe.kind === 'unary' ? `/api/${probe.method}` : probe.path
    const method = probe.kind === 'unary' ? 'POST' : (probe.method ?? 'GET')
    const body = probe.kind === 'unary'
      ? JSON.stringify({
        type: 'client-request',
        rpcId: crypto.randomUUID(),
        method: probe.method,
        payload: { args: probe.args ?? {} },
      })
      : (probe.body === undefined ? undefined : JSON.stringify(probe.body))
    const response = await fetch(new URL(target, wire.base), {
      method,
      headers: { 'content-type': 'application/json', cookie: wire.cookieHeader },
      ...(body === undefined ? {} : { body }),
    })
    // 404 is the signal that matters: the route the plugin would have mounted
    // is not there, so the plugin is not loaded.
    if (response.status === 404) return { loaded: false, detail: `${method} ${target} → 404 (route not mounted)` }
    if (!response.ok) return { loaded: false, detail: `${method} ${target} → HTTP ${response.status}` }
    if (probe.kind === 'unary') {
      const payload = await response.json().catch(() => undefined)
      if (payload?.result?.ok === true) return { loaded: true, detail: `${probe.method} answered ok` }
      return { loaded: false, detail: `${probe.method} answered ${JSON.stringify(payload?.result?.error ?? payload)}` }
    }
    return { loaded: true, detail: `${method} ${target} → HTTP ${response.status}` }
  } catch (error) {
    return { loaded: false, detail: `probe failed: ${String(error?.message ?? error)}` }
  }
}

/**
 * Start the host and wait until its /api surface answers.
 * @param options.dshHome - throwaway DSH home for this run.
 * @param options.workspace - throwaway cwd for the host.
 * @param options.hostPort - port the host binds.
 * @param options.uiPort - port the SPA origin binds (declared as a trusted host).
 * @param options.controlFile - the fake plugin's script file.
 * @param options.logPath - where the redacted host log is written.
 * @param options.plugins - extra plugins to mount (see {@link HostPluginSpec}).
 * @param options.runDir - the run root, when the caller wants the pid recorded.
 * @param options.runId - the run id, for process-identity checks at cleanup.
 * @param options.ownerToken - the run's token, required to write the manifest.
 * @param options.signal - abort the bring-up.
 * @returns the running host handle.
 */
export async function startHost(options) {
  const {
    dshHome, workspace, hostPort, uiPort, controlFile, logPath,
    plugins = [], runDir, runId, ownerToken, signal, register,
    // Bring-up budgets. The defaults are what a cold pinned host needs; a
    // fixture host answers in milliseconds and passes smaller ones so a broken
    // launch fails fast instead of sitting out the real budget.
    launchTimeoutMs = 90_000, cookieTimeoutMs = 60_000, readyTimeoutMs = 90_000,
  } = options

  const { overlayPath, pluginPath, mounts } = await writeProfileOverlay({ dshHome, plugins })
  await mkdir(path.dirname(logPath), { recursive: true })
  const logStream = createWriteStream(logPath, { flags: 'a' })

  const args = [
    '--profile', PROFILE,
    '--patch', overlayPath,
    '--port', String(hostPort),
    '--host', '127.0.0.1',
    '--no-open',
    // The browser reaches /api through the harness origin; the trust fence
    // must accept that authority explicitly.
    '--trusted-host', `127.0.0.1:${uiPort}`,
  ]

  const env = hostEnv({
    DSH_HOME: dshHome,
    AGOS_FAKE_SCRIPT: controlFile,
    // Keep the sandbox in its default posture so the approval seam really asks.
    DSH_PERMISSION_MODE: 'workspace-write',
  })

  const command = `${DSH_BIN} ${args.join(' ')}`
  logStream.write([
    `# AgOS host-integration — real pinned dsh host`,
    `# command: ${command}`,
    `# cwd: ${workspace}`,
    `# DSH_HOME: ${dshHome}`,
    `# credential env vars stripped from child: ${scrubbedEnvNames().join(', ') || '(none present)'}`,
    `# inherited dsh/node env dropped for isolation: ${isolatedEnvNames().join(', ') || '(none present)'}`,
    `# mounted plugins: ${mounts.map((mount) => `${mount.id}=${mount.mounted}`).join(', ') || '(harness fake only)'}`,
    `# DSH_TELEMETRY_DISABLED=1`,
    '',
  ].join('\n'))

  const child = spawn(DSH_BIN, args, {
    cwd: workspace,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  // The pid is recorded while we still hold the un-reaped child handle, so the
  // identity captured cannot belong to a recycled pid. Cleanup later refuses to
  // signal anything whose identity has drifted from this record.
  if (runDir !== undefined) {
    await recordProcess(runDir, { pid: child.pid, role: 'host', ownerToken }).catch(() => undefined)
  }

  // The host prints its root URL carrying a one-process launch token. That
  // token is a secret: it is captured for the auth exchange, registered for
  // redaction, and never written to an artifact in the clear.
  //
  // Detection reads a rolling window of raw output; EMISSION is what the
  // redacting writer holds back until a boundary proves the bytes are not part
  // of an unfinished secret. That ordering is the whole fix: the previous code
  // wrote each chunk as it arrived, so the first half of a token split across
  // two chunks reached the log before any complete token existed to match.
  const SCAN_WINDOW = 16 * 1024
  let launchToken
  let scan = ''
  let output = ''
  const writer = createRedactingWriter({
    redact,
    write: (text) => { output += text; logStream.write(text) },
    observe: (text) => {
      scan = (scan + text).slice(-SCAN_WINDOW)
      if (launchToken !== undefined) return
      // The trailing terminator is required: without it this matches the first
      // 8+ characters of a token that is still arriving, captures a PREFIX as
      // "the token", and then both the auth exchange (wrong value) and the
      // redaction (prefix registered, tail left in the clear) are wrong.
      const match = /[?&]token=([A-Za-z0-9._~-]{8,})[^A-Za-z0-9._~-]/.exec(scan)
      if (match !== null) { launchToken = match[1]; registerSecret(launchToken) }
    },
  })
  const record = (chunk) => writer.write(chunk)
  child.stdout.on('data', record)
  child.stderr.on('data', record)

  let exited
  const exit = new Promise((resolve) => {
    child.on('exit', (code, signal_) => {
      exited = { code, signal: signal_ }
      // Anything still held back is redacted and written now, so a crash tail
      // is never lost — and never leaks either.
      writer.flush()
      resolve({ code, signal: signal_ })
    })
  })

  /**
   * Stop the child and close the log.
   *
   * Memoized, so the three callers that can all legitimately fire — the
   * bring-up failure path, the resource stack's disposer, and the caller's own
   * `dispose()` — collapse into one shutdown instead of ending an already-ended
   * log stream.
   */
  let stopping
  const stop = () => {
    stopping ??= (async () => {
      if (exited === undefined) {
        child.kill('SIGTERM')
        const settled = await Promise.race([
          exit,
          new Promise((resolve) => setTimeout(() => resolve(undefined), 8000)),
        ])
        if (settled === undefined) {
          child.kill('SIGKILL')
          await exit
        }
      }
      writer.flush()
      await new Promise((resolve) => logStream.end(resolve))
      return exited
    })()
    return stopping
  }

  // Hand the process over BEFORE the readiness wait. A bring-up that is
  // cancelled or times out while waiting for the launch URL would otherwise
  // leave a live host with nobody holding a disposer for it.
  register?.('host-process', stop)

  const base = `http://127.0.0.1:${hostPort}`
  const authority = `127.0.0.1:${hostPort}`
  let cookieHeader
  try {
    await waitFor(() => {
      if (exited !== undefined) throw new Error(`host exited early (code=${exited.code} signal=${exited.signal})`)
      return launchToken !== undefined
    }, { timeoutMs: launchTimeoutMs, intervalMs: 200, label: 'host launch URL on stdout', signal })

    // Real launch-token exchange: GET /?token=… mints the authority-bound
    // signed browser-session cookie that every /api request must carry.
    cookieHeader = await waitFor(async () => {
      const response = await fetch(`${base}/?token=${launchToken}`, {
        redirect: 'manual',
        headers: { host: authority },
      })
      const setCookie = response.headers.getSetCookie?.() ?? []
      const pair = setCookie.map((entry) => entry.split(';', 1)[0]).find((entry) => entry.startsWith('dsh-auth-'))
      if (pair === undefined) return false
      registerSecret(pair.slice(pair.indexOf('=') + 1))
      return pair
    }, { timeoutMs: cookieTimeoutMs, intervalMs: 250, label: 'launch-token → session-cookie exchange', signal })

    await waitFor(async () => {
      if (exited !== undefined) throw new Error(`host exited early (code=${exited.code} signal=${exited.signal})`)
      // session/list is the cheapest real unary round trip on the 0.1.2 wire.
      const response = await fetch(new URL('/api/session/list', base), {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: cookieHeader },
        body: JSON.stringify({
          type: 'client-request',
          rpcId: crypto.randomUUID(),
          method: 'session/list',
          payload: { args: { _request: {} } },
        }),
      })
      if (!response.ok) return false
      const body = await response.json()
      return body?.result?.ok === true
    }, { timeoutMs: readyTimeoutMs, intervalMs: 250, label: 'host /api readiness', signal })
  } catch (error) {
    // The child is OURS and it is running; the throw must not leave it behind.
    await stop().catch(() => undefined)
    throw new Error(`${error.message}\n--- host log tail (redacted) ---\n${output.slice(-4000)}`)
  }

  let lastPluginStatus
  const handle = {
    child,
    base,
    authority,
    /** Signed browser-session cookie every /api request must present. */
    cookieHeader,
    command,
    overlayPath,
    pluginPath,
    logPath,
    provider: FAKE_PROVIDER,
    model: FAKE_MODEL,
    log: () => output,
    exit,

    /** The plugin specs this host was asked to mount. */
    requestedPlugins: plugins,

    /**
     * What actually loaded, verified against the RUNNING host.
     *
     * Each requested plugin is probed on the live wire; a 404 from the route it
     * would have mounted is reported as `loaded: false`, an undeclared probe as
     * `loaded: null`. Callers should treat anything other than `true` as
     * `blocked`, not as a pass.
     * @returns {Promise<HostPluginStatus[]>}
     */
    async pluginStatus() {
      const wire = { base, cookieHeader, log: () => output }
      const statuses = []
      for (const mount of mounts) {
        const { loaded, detail } = mount.mounted
          ? await runProbe(mount.probe, wire)
          : { loaded: false, detail: mount.detail }
        statuses.push({
          id: mount.id,
          entry: mount.entry,
          requested: true,
          mounted: mount.mounted,
          loaded,
          detail,
        })
      }
      lastPluginStatus = statuses
      return statuses
    },

    /**
     * Ids of plugins whose probe proved they are loaded.
     * @returns {Promise<string[]>}
     */
    async loadedPlugins() {
      return (await handle.pluginStatus()).filter((entry) => entry.loaded === true).map((entry) => entry.id)
    },

    /** The last status computed, without re-probing (evidence reports). */
    lastPluginStatus: () => lastPluginStatus,

    stop,
  }
  return handle
}
