/**
 * Shared environment for the AgOS real-host integration harness (package B).
 *
 * Isolation contract, enforced here rather than by convention:
 * - the pinned host is booted with DSH_HOME pointed at a throwaway directory,
 *   so it never reads or writes ~/.dsh (the user's live profiles and sessions).
 *   DSH_HOME is the harness's own documented home override; HOME and
 *   CODEX_HOME are never touched.
 * - every OTHER inherited `DSH_*` variable is dropped as well. Overriding
 *   DSH_HOME alone is not isolation: an operator shell that exports DSH_PROFILE
 *   or DSH_CONFIG (or anything else the host consults) would steer the
 *   throwaway host back at live state, and the suite would silently stop
 *   testing what it claims to test. The harness re-adds only what it sets
 *   itself, so the child's dsh-facing environment is fully harness-authored.
 * - `NODE_OPTIONS` is dropped for the same reason: `--require` in an inherited
 *   value loads operator code into the host process.
 * - every credential-shaped variable is stripped from the child environment, so
 *   a real provider call cannot succeed even if some path attempted one.
 * - ports are claimed from a high range and probed for freeness before binding.
 *
 * Where the browser automation comes from is a separate isolation question and
 * lives in `browser-source.mjs`; this file deliberately no longer names a
 * default inside `~/.dsh`.
 */
import { createServer } from 'node:net';
import { rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const HARNESS_ID = 'agos-host-integration'
export const FRONTEND_ROOT = fileURLToPath(new URL('../..', import.meta.url))
export const HARNESS_DIR = fileURLToPath(new URL('.', import.meta.url))
export const ARTIFACT_DIR = path.join(FRONTEND_ROOT, 'tests/host-integration/artifacts')

// 默认值一律从 $HOME 推导,不写死任何操作者的绝对路径。
//
// ⚠️ 2026-09-09:这些常量原先的默认值是 '/Users/<操作者>/…' 字面量,上一轮改成了
// homedir() 推导 —— 但 PLAYWRIGHT_MODULE 的默认值仍然指进操作者 live `web` profile
// 内部,与本文件「从不读写 ~/.dsh」的声明直接冲突。本轮把它整条移到
// browser-source.mjs 的 resolvePlaywrightModule(),默认只在**本仓自己的依赖树**里找,
// 找不到就明确报 blocked;live profile 只在操作者显式 opt-in 时才可用。
const HOME = homedir()

/** The live profile tree the harness must never read from. */
export const LIVE_PROFILE_ROOT = path.join(HOME, '.dsh')

/**
 * dsh CLI resolved from the pinned global install (UPSTREAM.pin: 0.1.2-rc.1).
 * This is the CLI binary, not the profile tree: `~/.npm-global/bin` holds the
 * installed executable, `~/.dsh` holds the state the harness stays out of.
 */
export const DSH_BIN = process.env.AGOS_DSH_BIN ?? path.join(HOME, '.npm-global/bin/dsh')

/**
 * Environment variables that must never reach the host child. Credential names
 * are stripped so that a real paid model call is impossible by construction,
 * not merely unlikely: the fake adapter is the only registered provider, and
 * even a bug that reached the DeepSeek adapter would find no key.
 */
const CREDENTIAL_ENV_PATTERN = /(API_?KEY|_TOKEN|SECRET|PASSWORD|CREDENTIAL|SESSION_KEY|COOKIE)/i

/** Values scrubbed out of anything this harness writes to disk. */
const secretValues = new Set()

for (const [key, value] of Object.entries(process.env)) {
  if (CREDENTIAL_ENV_PATTERN.test(key) && typeof value === 'string' && value.length >= 8) {
    secretValues.add(value)
  }
}

/**
 * Register a secret discovered at runtime (the host's launch token and the
 * signed browser-session cookie it mints) so it is scrubbed from every artifact.
 * @param value - the secret literal to redact from now on.
 */
export function registerSecret(value) {
  if (typeof value === 'string' && value.length >= 8) secretValues.add(value)
}

/** How many secret literals are currently registered (evidence log only). */
export function registeredSecretCount() {
  return secretValues.size
}

/**
 * Remove any credential value observed in this process's environment or
 * registered at runtime, plus anything that looks like a launch token, signed
 * cookie, or bearer/sk- key.
 * @param text - raw text to sanitize.
 * @returns the text with secrets replaced by a REDACTED marker.
 */
export function redact(text) {
  // ⚠️ Shapes run BEFORE literals, and the order is load-bearing. A registered
  // literal can be a PREFIX of a longer real value (that is exactly what
  // happens when a token is observed mid-stream). Replacing the literal first
  // rewrites `?token=abcdef123456` into `?token=[REDACTED]123456`, which no
  // longer matches the `?token=…` shape — so the tail of the value survives in
  // the clear. Letting the greedy shape rule consume the whole run first makes
  // a partial registration harmless.
  let out = String(text)
    .replace(/\b(sk-[A-Za-z0-9_-]{6,})/g, '[REDACTED]')
    .replace(/\b(Bearer\s+)[A-Za-z0-9._-]{8,}/gi, '$1[REDACTED]')
    .replace(/([?&]token=)[A-Za-z0-9._~-]{8,}/g, '$1[REDACTED]')
    .replace(/(dsh-auth-[A-Za-z0-9._~-]*=)[^;\s]{8,}/g, '$1[REDACTED]')
  for (const secret of secretValues) out = out.split(secret).join('[REDACTED]')
  return out
}

/**
 * Build the child environment for the pinned host: the caller's environment
 * minus every credential-shaped entry, plus the isolation overrides.
 * @param overrides - harness-owned variables to set on the child.
 * @returns a fresh environment object for spawn().
 */
export function hostEnv(overrides, source = process.env) {
  const env = {}
  for (const [key, value] of Object.entries(source)) {
    if (CREDENTIAL_ENV_PATTERN.test(key)) continue
    // Every dsh-facing variable is harness-authored. An inherited DSH_PROFILE
    // or DSH_CONFIG would point the throwaway host back at live state and
    // quietly undo the DSH_HOME override.
    if (key.startsWith('DSH_')) continue
    // An inherited `--require` would load operator code into the host.
    if (key === 'NODE_OPTIONS') continue
    env[key] = value
  }
  // Telemetry export is an outbound HTTPS call; a hermetic test makes none.
  env.DSH_TELEMETRY_DISABLED = '1'
  return { ...env, ...overrides }
}

/** Names of the credential variables that were removed, for the evidence log. */
export function scrubbedEnvNames(source = process.env) {
  return Object.keys(source).filter((key) => CREDENTIAL_ENV_PATTERN.test(key)).sort()
}

/**
 * Inherited variables dropped for isolation (not secrecy), for the evidence log.
 * @param source - the environment that would have been inherited.
 * @returns the dropped names, sorted.
 */
export function isolatedEnvNames(source = process.env) {
  return Object.keys(source)
    .filter((key) => !CREDENTIAL_ENV_PATTERN.test(key) && (key.startsWith('DSH_') || key === 'NODE_OPTIONS'))
    .sort()
}

/**
 * Prove one TCP port is free by binding it and letting go.
 * @param port - the port to probe on 127.0.0.1.
 * @returns true when the bind succeeded.
 */
export function portIsFree(port) {
  return new Promise((resolve) => {
    const probe = createServer()
    probe.once('error', () => resolve(false))
    probe.once('listening', () => probe.close(() => resolve(true)))
    probe.listen(port, '127.0.0.1')
  })
}

/**
 * Claim `count` free ports from a high range chosen to avoid the user's own
 * running harness. Each port is verified free immediately before it is handed
 * out; the caller binds promptly.
 * @param count - how many ports to claim.
 * @param start - first candidate port.
 * @returns the claimed ports in ascending order.
 */
export async function claimPorts(count, start = 39411) {
  const claimed = []
  for (let port = start; port < start + 400 && claimed.length < count; port += 1) {
    if (await portIsFree(port)) claimed.push(port)
  }
  if (claimed.length < count) throw new Error(`host-integration: could not claim ${count} free ports from ${start}`)
  return claimed
}

/** Directory the harness creates all throwaway roots in. */
export function tempRoot() {
  return tmpdir()
}

/**
 * Remove a throwaway directory, ignoring absence.
 *
 * Guarded twice: the path must sit under the OS temp root AND must not be the
 * temp root itself. Run directories are reaped through `run-registry.mjs`,
 * which adds the ownership checks on top of these.
 */
export async function removeTemp(dir) {
  if (typeof dir !== 'string' || dir === '') return
  const resolved = path.resolve(dir)
  const root = path.resolve(tmpdir())
  if (resolved === root || !resolved.startsWith(root + path.sep)) return
  await rm(resolved, { recursive: true, force: true })
}

/**
 * Wait until `check` returns truthy or the deadline passes.
 *
 * An optional AbortSignal short-circuits the wait, so a cancelled bring-up
 * stops polling immediately instead of holding its resources for the rest of
 * the timeout while the unwinder waits on it.
 */
export async function waitFor(check, { timeoutMs = 30_000, intervalMs = 100, label = 'condition', signal } = {}) {
  const deadline = Date.now() + timeoutMs
  let lastError
  while (Date.now() < deadline) {
    if (signal?.aborted === true) throw new Error(`host-integration: cancelled while waiting for ${label}`)
    try {
      const value = await check()
      if (value) return value
    } catch (error) { lastError = error }
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
  throw new Error(`host-integration: timed out waiting for ${label}${lastError ? `: ${String(lastError)}` : ''}`)
}
