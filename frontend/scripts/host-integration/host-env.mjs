/**
 * Shared environment for the AgOS real-host integration harness (package B).
 *
 * Isolation contract, enforced here rather than by convention:
 * - the pinned host is booted with DSH_HOME pointed at a throwaway directory,
 *   so it never reads or writes ~/.dsh (the user's live profiles and sessions).
 *   DSH_HOME is the harness's own documented home override; HOME and
 *   CODEX_HOME are never touched.
 * - every credential-shaped variable is stripped from the child environment, so
 *   a real provider call cannot succeed even if some path attempted one.
 * - ports are claimed from a high range and probed for freeness before binding.
 */
import { createServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const HARNESS_ID = 'agos-host-integration'
export const FRONTEND_ROOT = fileURLToPath(new URL('../..', import.meta.url))
export const HARNESS_DIR = fileURLToPath(new URL('.', import.meta.url))
export const ARTIFACT_DIR = path.join(FRONTEND_ROOT, 'tests/host-integration/artifacts')

// 默认值一律从 $HOME 推导,不写死任何操作者的绝对路径。
//
// ⚠️ 2026-09-09:这两个常量原先的默认值是 '/Users/<操作者>/…' 字面量。审查者 2(P3-B)与
// 独立验证者(阻塞项 3)都点了它:有 env 覆盖所以能跑,但默认值使这套联测只在那一台机器上成立,
// 而「摆脱个人 DSH profile 依赖」正是本轮 A 包存在的理由 —— 默认值把它又请了回来。
// 改成 homedir() 推导后,同样的目录布局在任何 macOS 账户上都成立;布局不同的机器仍可用
// AGOS_DSH_BIN / AGOS_PLAYWRIGHT_MODULE 覆盖,而这两个 env 本来就是既有的逃生阀。
const HOME = homedir()

/** dsh CLI resolved from the pinned global install (UPSTREAM.pin: 0.1.2-rc.1). */
export const DSH_BIN = process.env.AGOS_DSH_BIN ?? path.join(HOME, '.npm-global/bin/dsh')

/**
 * Installed playwright-core reused read-only; never downloaded or installed.
 *
 * 注意这条默认值读的是操作者 live `web` profile 内部 —— 与本文件「从不读写 ~/.dsh」的
 * 声明相矛盾(审查者 2 原话)。改成 $HOME 推导只解决了「写死个人路径」,**没有**解决
 * 「默认去 live profile 里借 playwright」这件事本身;后者列为下一轮项,见 HANDOFF.md。
 */
export const PLAYWRIGHT_MODULE = process.env.AGOS_PLAYWRIGHT_MODULE
  ?? path.join(HOME, '.dsh/profiles/web/node_modules/playwright-core/index.js')

/** Already-installed Chrome; no browser download ever happens. */
export const BROWSER_EXECUTABLE = process.env.AGOS_BROWSER_EXECUTABLE
  ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

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

/**
 * Remove any credential value observed in this process's environment or
 * registered at runtime, plus anything that looks like a launch token, signed
 * cookie, or bearer/sk- key.
 * @param text - raw text to sanitize.
 * @returns the text with secrets replaced by a REDACTED marker.
 */
export function redact(text) {
  let out = String(text)
  for (const secret of secretValues) out = out.split(secret).join('[REDACTED]')
  return out
    .replace(/\b(sk-[A-Za-z0-9_-]{6,})/g, '[REDACTED]')
    .replace(/\b(Bearer\s+)[A-Za-z0-9._-]{8,}/gi, '$1[REDACTED]')
    .replace(/([?&]token=)[A-Za-z0-9._~-]{8,}/g, '$1[REDACTED]')
    .replace(/(dsh-auth-[A-Za-z0-9._~-]*=)[^;\s]{8,}/g, '$1[REDACTED]')
}

/**
 * Build the child environment for the pinned host: the caller's environment
 * minus every credential-shaped entry, plus the isolation overrides.
 * @param overrides - harness-owned variables to set on the child.
 * @returns a fresh environment object for spawn().
 */
export function hostEnv(overrides) {
  const env = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (CREDENTIAL_ENV_PATTERN.test(key)) continue
    env[key] = value
  }
  // Telemetry export is an outbound HTTPS call; a hermetic test makes none.
  env.DSH_TELEMETRY_DISABLED = '1'
  return { ...env, ...overrides }
}

/** Names of the credential variables that were removed, for the evidence log. */
export function scrubbedEnvNames() {
  return Object.keys(process.env).filter((key) => CREDENTIAL_ENV_PATTERN.test(key)).sort()
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

/** Create the throwaway DSH home and synthetic workspace for one run. */
export async function makeTempRoots() {
  const dshHome = await mkdtemp(path.join(tmpdir(), `${HARNESS_ID}-home-`))
  const workspace = await mkdtemp(path.join(tmpdir(), `${HARNESS_ID}-ws-`))
  return { dshHome, workspace }
}

/** Remove a throwaway directory, ignoring absence. */
export async function removeTemp(dir) {
  if (typeof dir !== 'string' || dir === '' || !dir.startsWith(tmpdir())) return
  await rm(dir, { recursive: true, force: true })
}

/** Wait until `check` returns truthy or the deadline passes. */
export async function waitFor(check, { timeoutMs = 30_000, intervalMs = 100, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs
  let lastError
  while (Date.now() < deadline) {
    try {
      const value = await check()
      if (value) return value
    } catch (error) { lastError = error }
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
  throw new Error(`host-integration: timed out waiting for ${label}${lastError ? `: ${String(lastError)}` : ''}`)
}
