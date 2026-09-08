/**
 * Boot a REAL pinned dsh host (0.1.2-rc.1) in complete isolation.
 *
 * What is real: the dsh CLI from the pinned global install, the `web` profile
 * composition, the agent loop, the session log on disk, the approval seam, the
 * api-gateway, and the /api + /api/remote.mux transport.
 *
 * What is isolated: DSH_HOME points at a throwaway directory, so the host's
 * profile, sessions, storages and settings all live in a temp tree and the
 * user's ~/.dsh is neither read nor written. HOME and CODEX_HOME are untouched.
 *
 * What is faked: only the model provider and the tool body (see
 * fake-harness-plugin.mjs). The real DeepSeek adapter is disabled and every
 * credential-shaped environment variable is stripped, so no paid call is
 * reachable.
 */
import { spawn } from 'node:child_process';
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import {
  DSH_BIN, HARNESS_DIR, hostEnv, redact, registerSecret, scrubbedEnvNames, waitFor,
} from './host-env.mjs';

const PROFILE = 'web'
const FAKE_PROVIDER = 'agos-fake'
const FAKE_MODEL = 'agos-fake-1'

/**
 * Materialize the throwaway profile: copy the fake plugin in beside the profile
 * root (so its @deepseek-ai imports resolve through the profile module
 * fallback) and write the `--patch` overlay that swaps the real provider out.
 * @param options - the run's temp roots and control-file location.
 * @returns absolute paths of the overlay and the mounted plugin.
 */
async function writeProfileOverlay({ dshHome }) {
  const profileDir = path.join(dshHome, 'profiles', PROFILE)
  const pluginDir = path.join(profileDir, 'agos-harness')
  await mkdir(pluginDir, { recursive: true })
  const pluginPath = path.join(pluginDir, 'index.mjs')
  await copyFile(path.join(HARNESS_DIR, 'fake-harness-plugin.mjs'), pluginPath)

  // A loader patch list: id-targeted overrides plus one insert. The loader
  // converts an absolute plugin name to a file:// URL, so the harness plugin
  // mounts from the profile tree without any package installation.
  const overlay = [
    // No real provider adapter is registered at all.
    { id: 'llm-deepseek', disabled: true },
    // No outbound search/telemetry from a hermetic run.
    { id: 'web-search-deepseek', disabled: true },
    { id: 'session-telemetry-otel', disabled: true },
    // The loop's default route becomes the fake provider.
    { id: 'agent-default-model', config: { provider: FAKE_PROVIDER, model: FAKE_MODEL } },
    { insert: [{ id: 'agos-fake-harness', name: pluginPath }] },
  ]
  const overlayPath = path.join(dshHome, 'agos-harness-overlay.json')
  await writeFile(overlayPath, JSON.stringify(overlay, undefined, 2) + '\n')
  return { overlayPath, pluginPath, profileDir }
}

/**
 * Start the host and wait until its /api surface answers.
 * @param options - ports, temp roots, artifact paths and control file.
 * @returns the running host handle.
 */
export async function startHost(options) {
  const {
    dshHome, workspace, hostPort, uiPort, controlFile, logPath,
  } = options

  const { overlayPath, pluginPath } = await writeProfileOverlay({ dshHome })
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
    `# DSH_TELEMETRY_DISABLED=1`,
    '',
  ].join('\n'))

  const child = spawn(DSH_BIN, args, {
    cwd: workspace,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  // The host prints its root URL carrying a one-process launch token. That
  // token is a secret: it is captured for the auth exchange, registered for
  // redaction, and never written to an artifact in the clear.
  let launchToken
  let raw = ''
  let output = ''
  const record = (chunk) => {
    raw += chunk.toString('utf8')
    if (launchToken === undefined) {
      const match = /[?&]token=([A-Za-z0-9._~-]{8,})/.exec(raw)
      if (match !== null) { launchToken = match[1]; registerSecret(launchToken) }
    }
    const text = redact(chunk.toString('utf8'))
    output += text
    logStream.write(text)
  }
  child.stdout.on('data', record)
  child.stderr.on('data', record)

  let exited
  const exit = new Promise((resolve) => {
    child.on('exit', (code, signal) => { exited = { code, signal }; resolve({ code, signal }) })
  })

  const base = `http://127.0.0.1:${hostPort}`
  const authority = `127.0.0.1:${hostPort}`
  let cookieHeader
  try {
    await waitFor(() => {
      if (exited !== undefined) throw new Error(`host exited early (code=${exited.code} signal=${exited.signal})`)
      return launchToken !== undefined
    }, { timeoutMs: 90_000, intervalMs: 200, label: 'host launch URL on stdout' })

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
    }, { timeoutMs: 60_000, intervalMs: 250, label: 'launch-token → session-cookie exchange' })

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
    }, { timeoutMs: 90_000, intervalMs: 250, label: 'host /api readiness' })
  } catch (error) {
    child.kill('SIGKILL')
    throw new Error(`${error.message}\n--- host log tail (redacted) ---\n${output.slice(-4000)}`)
  }

  return {
    child,
    base,
    authority,
    /** Signed browser-session cookie every /api request must present. */
    cookieHeader,
    command,
    overlayPath,
    pluginPath,
    provider: FAKE_PROVIDER,
    model: FAKE_MODEL,
    log: () => output,
    exit,
    async stop() {
      if (exited !== undefined) return exited
      child.kill('SIGTERM')
      const settled = await Promise.race([
        exit,
        new Promise((resolve) => setTimeout(() => resolve(undefined), 8000)),
      ])
      if (settled === undefined) {
        child.kill('SIGKILL')
        await exit
      }
      logStream.end()
      return exited
    },
  }
}
