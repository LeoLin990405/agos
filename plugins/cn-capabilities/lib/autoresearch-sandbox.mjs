/**
 * OS-isolation backend selection for autoresearch verification.
 *
 * The only accepted verification boundary is one the kernel enforces. There is
 * deliberately no degraded mode: a cwd setting, a command-string allowlist or a
 * before/after hash comparison is not an isolation boundary, so when the required
 * primitives are absent the answer is `verification-unavailable` — never a weaker
 * check that can still report success.
 *
 * Backend selection is by explicit capability detection, never by
 * `process.platform` optimism: `process.platform === 'linux'` only decides which
 * probe set to run, and every probe must pass before a Linux sandbox is built.
 */
import { spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { access, readFile } from 'node:fs/promises'
import { delimiter, join } from 'node:path'

export const UNAVAILABLE = 'verification-unavailable'

export const unavailable = (reason) => ({ ok: false, reason: `${UNAVAILABLE}: ${reason}` })

/** Namespaces the Linux backend must be able to enter. All are mandatory. */
export const REQUIRED_NAMESPACES = Object.freeze({
  user: 'user',
  mnt: 'mount',
  net: 'network',
  pid: 'pid',
})

/** `unshare` flags the fallback backend depends on. A missing flag fails closed. */
export const REQUIRED_UNSHARE_FLAGS = Object.freeze([
  '--user',
  '--map-root-user',
  '--mount',
  '--net',
  '--pid',
  '--fork',
  '--mount-proc',
])

/** Read-only host roots the candidate may execute from. `/etc` and `$HOME` are excluded. */
export const READONLY_ROOT_CANDIDATES = Object.freeze([
  '/usr', '/bin', '/sbin', '/lib', '/lib64', '/lib32', '/libx32',
])

/** Distinct exit codes so a failed smoke test names the property that did not hold. */
export const SMOKE_EXIT = Object.freeze({
  scratchNotWritable: 91,
  readonlyRootWritable: 92,
})

const SMOKE_SCRIPT = [
  'set -u',
  'printf ok > "$AGOS_VERIFY_SCRATCH/.agos-smoke" 2>/dev/null || exit 91',
  'if printf x > /usr/.agos-smoke-should-fail 2>/dev/null; then rm -f /usr/.agos-smoke-should-fail; exit 92; fi',
  'exit 0',
].join('\n')

/** Probe surface. Every member is injectable so the decision logic is testable off-Linux. */
export function systemProbe(overrides = {}) {
  return {
    async readText(path) {
      return readFile(path, 'utf8').catch(() => null)
    },
    async exists(path) {
      return access(path, constants.F_OK).then(() => true, () => false)
    },
    async which(binary) {
      for (const dir of String(process.env.PATH || '').split(delimiter).filter(Boolean)) {
        const full = join(dir, binary)
        if (await access(full, constants.X_OK).then(() => true, () => false)) return full
      }
      return null
    },
    async run(file, args, { timeoutMs = 10000, env } = {}) {
      return new Promise((resolve) => {
        let stdout = ''
        let stderr = ''
        let settled = false
        const child = spawn(file, args, { stdio: ['ignore', 'pipe', 'pipe'], env, detached: true })
        const finish = (exitCode) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          resolve({ exitCode, stdout, stderr })
        }
        const timer = setTimeout(() => {
          try { process.kill(-child.pid, 'SIGKILL') } catch { try { child.kill('SIGKILL') } catch { /* gone */ } }
          finish(null)
        }, timeoutMs)
        child.stdout.on('data', (chunk) => { stdout += String(chunk) })
        child.stderr.on('data', (chunk) => { stderr += String(chunk) })
        child.on('error', (err) => { stderr += String(err && err.message ? err.message : err); finish(null) })
        child.on('close', (code) => finish(code))
      })
    },
    uid: typeof process.getuid === 'function' ? process.getuid() : null,
    ...overrides,
  }
}

// An absent sysctl is "not configured", never 0. `unprivileged_userns_clone` in
// particular only exists on Debian-derived kernels, so reading its absence as a
// disabled flag would reject every other distribution.
const numeric = (text) => {
  const raw = String(text ?? '').trim()
  if (!raw) return null
  const n = Number(raw)
  return Number.isFinite(n) ? n : null
}

/**
 * Gather raw Linux facts. This function only observes; it never decides.
 * @returns {Promise<object>} a JSON-able capability report
 */
export async function probeLinuxIsolation(probe = systemProbe(), { platform = process.platform } = {}) {
  const report = {
    platform,
    proc: await probe.exists('/proc/self/status'),
    ns: {},
    sysctl: {},
    binaries: {},
    unshareFlags: [],
    roots: [],
    seccomp: false,
    uid: probe.uid,
    smoke: null,
  }
  for (const key of Object.keys(REQUIRED_NAMESPACES)) {
    report.ns[key] = await probe.exists(`/proc/self/ns/${key}`)
  }
  report.sysctl.maxUserNamespaces = numeric(await probe.readText('/proc/sys/user/max_user_namespaces'))
  report.sysctl.unprivilegedUsernsClone = numeric(await probe.readText('/proc/sys/kernel/unprivileged_userns_clone'))
  report.sysctl.apparmorRestrictUserns = numeric(
    await probe.readText('/proc/sys/kernel/apparmor_restrict_unprivileged_userns'),
  )
  report.seccomp = /^Seccomp:/m.test(String(await probe.readText('/proc/self/status') || ''))

  report.binaries.bwrap = await probe.which('bwrap')
  report.binaries.unshare = await probe.which('unshare')
  report.binaries.mount = await probe.which('mount')

  if (report.binaries.unshare) {
    const help = await probe.run(report.binaries.unshare, ['--help'], { timeoutMs: 5000 })
    const text = `${help.stdout || ''}${help.stderr || ''}`
    report.unshareFlags = REQUIRED_UNSHARE_FLAGS.filter((flag) => text.includes(flag))
  }

  for (const root of READONLY_ROOT_CANDIDATES) {
    if (await probe.exists(root)) report.roots.push(root)
  }
  return report
}

/**
 * Decide whether a Linux OS boundary can be built. PURE: no I/O, no platform reads.
 * Every rejection names the specific missing capability.
 * @param {object} report output of {@link probeLinuxIsolation}
 * @param {{ requireSmoke?: boolean }} [options] `requireSmoke:false` selects a backend
 *   without demanding a smoke result, which is how the caller learns what to smoke-test.
 */
export function planLinuxIsolation(report, { requireSmoke = true } = {}) {
  if (!report || typeof report !== 'object') return unavailable('linux capability probe produced no report')
  if (report.platform !== 'linux') {
    return unavailable(`linux isolation requires a linux host (probed platform: ${report.platform || 'unknown'})`)
  }
  if (!report.proc) return unavailable('linux isolation requires procfs mounted at /proc')

  for (const [key, label] of Object.entries(REQUIRED_NAMESPACES)) {
    if (!report.ns?.[key]) {
      return unavailable(`linux isolation requires a ${label} namespace (/proc/self/ns/${key} missing)`)
    }
  }

  // Root already holds CAP_SYS_ADMIN, so the unprivileged-userns gates only apply below it.
  if (report.uid !== 0) {
    const sysctl = report.sysctl || {}
    if (sysctl.maxUserNamespaces === 0) {
      return unavailable('linux isolation requires unprivileged user namespaces (user.max_user_namespaces=0)')
    }
    if (sysctl.unprivilegedUsernsClone === 0) {
      return unavailable('linux isolation requires unprivileged user namespaces (kernel.unprivileged_userns_clone=0)')
    }
    if (sysctl.apparmorRestrictUserns === 1) {
      return unavailable(
        'linux isolation requires unprivileged user namespaces (kernel.apparmor_restrict_unprivileged_userns=1)',
      )
    }
  }

  const binaries = report.binaries || {}
  let backend = null
  if (binaries.bwrap) backend = 'linux-bubblewrap'
  else if (binaries.unshare && binaries.mount) backend = 'linux-unshare'
  else if (binaries.unshare) return unavailable('linux isolation via unshare requires mount(8) for read-only bind views')
  else return unavailable('linux isolation requires bubblewrap (bwrap) or unshare(1); neither is on PATH')

  if (backend === 'linux-unshare') {
    const missing = REQUIRED_UNSHARE_FLAGS.filter((flag) => !(report.unshareFlags || []).includes(flag))
    if (missing.length) {
      return unavailable(`linux isolation requires unshare(1) support for ${missing.join(', ')}`)
    }
  }

  if (!(report.roots || []).includes('/usr')) {
    return unavailable('linux isolation requires a readable /usr to bind read-only')
  }

  const smoke = report.smoke
  if (requireSmoke) {
    if (!smoke) return unavailable(`linux isolation smoke test did not run for ${backend}`)
    if (smoke.backend !== backend) {
      return unavailable(`linux isolation smoke test ran on ${smoke.backend || 'unknown'}, not the selected ${backend}`)
    }
    if (smoke.exitCode === SMOKE_EXIT.scratchNotWritable) {
      return unavailable(`linux isolation smoke test failed for ${backend}: scratch directory was not writable`)
    }
    if (smoke.exitCode === SMOKE_EXIT.readonlyRootWritable) {
      return unavailable(`linux isolation smoke test failed for ${backend}: /usr was writable inside the sandbox`)
    }
    if (smoke.exitCode !== 0) {
      const detail = String(smoke.stderr || '').trim().split('\n').pop() || 'no stderr'
      return unavailable(`linux isolation smoke test failed for ${backend} (exit ${smoke.exitCode}): ${detail}`)
    }
  }

  return {
    ok: true,
    backend,
    // Recorded only. Neither backend installs a filter here: bwrap's --seccomp needs a
    // compiled BPF program on a file descriptor, which this package does not ship. The
    // namespaces above are what actually enforce the boundary.
    seccompAvailable: report.seccomp === true,
    seccompApplied: false,
    capabilities: [
      ...Object.values(REQUIRED_NAMESPACES).map((label) => `${label}-namespace`),
      backend === 'linux-bubblewrap' ? 'bubblewrap' : 'unshare+mount',
      ...(report.seccomp === true ? ['seccomp-available'] : []),
    ],
  }
}

/** Minimal environment. No provider tokens, no proxies, no NODE_OPTIONS, no HOME. */
export function linuxSandboxEnv({ scratch, nodeBinDir }) {
  return {
    PATH: `${nodeBinDir}:/usr/bin:/bin:/usr/sbin:/sbin`,
    AGOS_VERIFY_SCRATCH: scratch,
    TMPDIR: scratch,
    TMP: scratch,
    TEMP: scratch,
    LANG: 'C.UTF-8',
    LC_ALL: 'C',
    TZ: 'UTC',
    OPENSSL_CONF: '/dev/null',
  }
}

/**
 * bubblewrap argv. `--unshare-all` covers user/ipc/pid/net/uts/cgroup/mount, so
 * network egress is removed by the kernel rather than by policy.
 * PURE: string construction only.
 */
export function buildBubblewrapArgs({ evaluator, scratch, roots, env }) {
  const args = [
    '--unshare-all',
    '--new-session',
    '--die-with-parent',
    '--clearenv',
    '--proc', '/proc',
    '--dev', '/dev',
  ]
  for (const root of roots || []) args.push('--ro-bind-try', root, root)
  args.push('--ro-bind', evaluator, evaluator)
  // Ordering matters: scratch lives inside the evaluator tree, so its writable bind
  // must be applied after the read-only bind that would otherwise cover it.
  args.push('--bind', scratch, scratch)
  for (const [key, value] of Object.entries(env || {})) args.push('--setenv', key, String(value))
  args.push('--chdir', evaluator)
  return args
}

/**
 * unshare argv plus the in-namespace prelude that turns the mount namespace into a
 * read-only view with a single writable subtree. PURE: string construction only.
 */
export function buildUnshareArgs({ evaluator, scratch }) {
  const prelude = [
    'set -eu',
    // Never propagate these mounts back to the host namespace.
    'mount --make-rslave /',
    'mount --bind / /',
    'mount -o remount,bind,ro /',
    'mount --bind "$AGOS_VERIFY_SCRATCH" "$AGOS_VERIFY_SCRATCH"',
    'mount -o remount,bind,rw,nosuid,nodev "$AGOS_VERIFY_SCRATCH"',
    `cd ${JSON.stringify(evaluator)}`,
    // The candidate command arrives as $1, never interpolated into this script.
    'exec /bin/bash -c "$1"',
  ].join('\n')
  return {
    args: [...REQUIRED_UNSHARE_FLAGS, '--', '/bin/bash', '-c', prelude, 'agos-verify'],
    prelude,
    scratch,
  }
}

/**
 * Build the launcher for a planned Linux backend.
 * `execCommand` spawns `file` with `[...before, command]`.
 */
export function buildLinuxLauncher({ plan, evaluator, scratch, roots, env, binaries }) {
  if (plan?.backend === 'linux-bubblewrap') {
    return {
      file: binaries.bwrap,
      before: [...buildBubblewrapArgs({ evaluator, scratch, roots, env }), '--', '/bin/bash', '-c'],
    }
  }
  if (plan?.backend === 'linux-unshare') {
    return { file: binaries.unshare, before: buildUnshareArgs({ evaluator, scratch }).args }
  }
  throw new Error(`unknown linux isolation backend: ${plan?.backend}`)
}

/** Run the smoke test through the real launcher. Linux-only; never reached off-Linux. */
export async function runLinuxSmoke({ probe, launcher, env, backend, timeoutMs = 15000 }) {
  const result = await probe.run(launcher.file, [...launcher.before, SMOKE_SCRIPT], { timeoutMs, env })
  return { backend, exitCode: result.exitCode, stderr: result.stderr }
}

/**
 * Which probe set applies to this host. Returns null when no OS boundary exists
 * for the platform at all, so the caller fails closed rather than guessing.
 */
export function chooseIsolationBackend(platform) {
  if (platform === 'darwin') return 'macos-seatbelt'
  if (platform === 'linux') return 'linux-namespaces'
  return null
}

/**
 * Full Linux path: probe -> plan -> build -> smoke -> re-plan with the smoke result.
 * Any failure returns `verification-unavailable` with the specific missing capability.
 */
export async function linuxVerificationSandbox({
  evaluator,
  scratch,
  nodeBinDir,
  nodePrefix,
  probe = systemProbe(),
  platform = process.platform,
} = {}) {
  const report = await probeLinuxIsolation(probe, { platform })
  // First pass selects a backend from capabilities alone; a rejection here is final.
  const selection = planLinuxIsolation(report, { requireSmoke: false })
  if (!selection.ok) return selection

  const roots = [...new Set([...(report.roots || []), ...(nodePrefix ? [nodePrefix] : [])])]
  const env = linuxSandboxEnv({ scratch, nodeBinDir })
  const launcher = buildLinuxLauncher({
    plan: selection,
    evaluator,
    scratch,
    roots,
    env,
    binaries: report.binaries,
  })
  // Second pass re-decides with the live smoke result, so a sandbox that cannot
  // actually hold its own boundary is rejected instead of used.
  report.smoke = await runLinuxSmoke({ probe, launcher, env, backend: selection.backend })
  const plan = planLinuxIsolation(report)
  if (!plan.ok) return plan

  return {
    ok: true,
    kind: plan.backend,
    launcher,
    env,
    scratch,
    roots,
    capabilities: plan.capabilities,
    seccompAvailable: plan.seccompAvailable,
    seccompApplied: plan.seccompApplied,
    report,
  }
}
