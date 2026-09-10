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
 *
 * The former `linux-unshare` fallback has been REMOVED. It rebound the host `/`
 * read-only inside a mount namespace, which made its read scope the entire host
 * filesystem: $HOME, /etc and every credential stayed readable by candidate
 * code, and the old smoke test never probed that. A remount is not a read
 * whitelist. That backend may only return once it is rebuilt on an independent
 * root filesystem with a strict read whitelist AND carries runtime evidence from
 * a real Linux host. Until then it fails closed, never reports ok.
 */
import { spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { release, tmpdir } from 'node:os'
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

/** Read-only host roots the candidate may execute from. `/etc` and `$HOME` are excluded. */
export const READONLY_ROOT_CANDIDATES = Object.freeze([
  '/usr', '/bin', '/sbin', '/lib', '/lib64', '/lib32', '/libx32',
])

/**
 * Why the unshare fallback can never be selected. Kept as a named constant so the
 * decision logic and its tests assert the same sentence.
 */
export const DISABLED_UNSHARE_REASON = 'the linux-unshare backend is disabled: it remounts the entire host root filesystem read-only, so its read scope is the whole host ($HOME, /etc, credentials stay readable); it is not an isolation boundary and must never be reported as one'

/** Distinct exit codes so a failed smoke test names the property that did not hold. */
export const SMOKE_EXIT = Object.freeze({
  scratchNotWritable: 91,
  readonlyRootWritable: 92,
  outsideRootReadable: 93,
  networkEgress: 94,
  boundBindUnreadable: 95,
  boundBindWritable: 96,
  boundBindMutated: 97,
})

/**
 * Exact bytes of the in-scope sentinel. The probe compares content rather than
 * merely opening the path, so an empty placeholder that bubblewrap happened to
 * create while building intermediate directories cannot satisfy the control.
 */
export const BOUND_SENTINEL_LINE = 'agos-bound-sentinel'

/**
 * In-sandbox smoke script (bash). Verifies, from inside the real sandbox:
 *   91 — scratch is writable
 *   92 — the bound read-only roots stay read-only
 *   95 — POSITIVE CONTROL: a synthetic sentinel INSIDE a declared read-only bind is
 *        readable, with the expected bytes. Runs BEFORE the 93 probe on purpose.
 *   96 — that same in-scope sentinel rejects a write, so the read-only bind is
 *        proven read-only on a path this test owns (not only on /usr).
 *   93 — a synthetic host file OUTSIDE every bind is unreadable.
 *   94 — a live host loopback listener is unreachable (network namespace holds)
 *
 * Why 95 exists. On its own, 93 is vacuous under a bind whitelist: the file does
 * not exist in the namespace (ENOENT), and it also does not exist on a host that
 * has no sandbox at all yet never bound the path either. 95 and 93 are therefore a
 * PAIR, and only the pair discriminates. runLinuxSmoke builds both sentinels as
 * sibling files under one mkdtemp root and binds only the `bound/` subdirectory,
 * so the sole difference between them is bind membership:
 *   - real bind whitelist  -> 95 passes (in-scope readable), 93 passes (out-of-scope absent)
 *   - no sandbox at all    -> 95 passes, 93 FIRES (both siblings readable)
 *   - binds did not apply  -> 95 FIRES (in-scope unreadable), so a 93 pass is never
 *                             mistaken for isolation
 *   - host-root-bind shape -> 93 FIRES (the removed linux-unshare regression guard)
 *
 * AGOS_VERIFY_BOUND_SENTINEL / AGOS_VERIFY_OUTSIDE_SENTINEL / AGOS_VERIFY_NET_PROBE_PORT
 * are smoke-channel-only keys: they enter the sandbox argv/env whitelist ONLY for the
 * smoke launcher (see runLinuxSmoke's extendLauncher), never for a candidate run.
 */
const SMOKE_SCRIPT = [
  'set -u',
  'printf ok > "$AGOS_VERIFY_SCRATCH/.agos-smoke" 2>/dev/null || exit 91',
  'if printf x > /usr/.agos-smoke-should-fail 2>/dev/null; then rm -f /usr/.agos-smoke-should-fail; exit 92; fi',
  // `read` is a bash builtin: a missing coreutils binary cannot fake this control.
  'agos_bound=""',
  'read -r agos_bound < "$AGOS_VERIFY_BOUND_SENTINEL" 2>/dev/null || exit 95',
  `[ "$agos_bound" = "${BOUND_SENTINEL_LINE}" ] || exit 95`,
  'if printf x >> "$AGOS_VERIFY_BOUND_SENTINEL" 2>/dev/null; then exit 96; fi',
  'if cat "$AGOS_VERIFY_OUTSIDE_SENTINEL" >/dev/null 2>&1; then exit 93; fi',
  'if [ -n "${AGOS_VERIFY_NET_PROBE_PORT:-}" ]; then',
  '  if (exec 3<>"/dev/tcp/127.0.0.1/$AGOS_VERIFY_NET_PROBE_PORT") 2>/dev/null; then exit 94; fi',
  'fi',
  'exit 0',
].join('\n')

/** Manifest check status vocabulary. Every declared check MUST carry one of these. */
export const CHECK_STATUS = Object.freeze({
  verified: 'verified',
  unproven: 'unproven',
  unavailable: 'unavailable',
})

export const manifestCheck = (name, status, evidence = '') => ({ name, status, evidence: String(evidence) })

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
 * `binaries.unshare` is still observed so a rejection can name it precisely,
 * but no decision path selects it (see DISABLED_UNSHARE_REASON).
 * @returns {Promise<object>} a JSON-able capability report
 */
export async function probeLinuxIsolation(probe = systemProbe(), { platform = process.platform } = {}) {
  const report = {
    platform,
    proc: await probe.exists('/proc/self/status'),
    ns: {},
    sysctl: {},
    binaries: {},
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

  for (const root of READONLY_ROOT_CANDIDATES) {
    if (await probe.exists(root)) report.roots.push(root)
  }
  return report
}

/** `bubblewrap 0.8.0` / `0.8.0` -> `0.8.0`. Unrecognised output stays verbatim. */
const parseBwrapVersion = (stdout) => {
  const line = String(stdout || '').trim().split('\n')[0] || ''
  const match = line.match(/(\d+\.\d+(?:\.\d+)?)/)
  return match ? match[1] : (line || null)
}

/** `6.1.0-31-amd64` -> { major: 6, minor: 1 }. Unparsable releases give nulls. */
const parseKernelRelease = (text) => {
  const match = String(text || '').match(/^(\d+)\.(\d+)/)
  return match ? { major: Number(match[1]), minor: Number(match[2]) } : { major: null, minor: null }
}

/**
 * Extra Linux facts for a human-readable capability report: kernel identity, the
 * bubblewrap version actually on PATH, and the mount primitives bubblewrap needs
 * for `--proc` / `--dev` / tmpfs. OBSERVATIONAL ONLY — this augments a report from
 * {@link probeLinuxIsolation} and NO decision path consumes it: planLinuxIsolation
 * never reads these fields, so a distribution that reports them oddly cannot widen
 * or narrow the boundary. Safe on any platform: off Linux every read returns null
 * and no subprocess is spawned, because `report.binaries.bwrap` is null.
 * @param {object} probe injectable probe surface, see {@link systemProbe}
 * @param {object} report output of {@link probeLinuxIsolation}
 */
export async function probeLinuxRuntimeDetails(probe = systemProbe(), report = {}, { osRelease = release() } = {}) {
  const binaries = report.binaries || {}
  const filesystemsText = await probe.readText('/proc/filesystems')
  const hasFilesystem = (name) => (filesystemsText === null
    ? null
    : new RegExp(`(^|\\s)${name}\\s*$`, 'm').test(String(filesystemsText)))
  let bwrapVersion = null
  if (binaries.bwrap) {
    const probed = await probe.run(binaries.bwrap, ['--version'], { timeoutMs: 5000 })
    bwrapVersion = probed?.exitCode === 0 ? parseBwrapVersion(probed.stdout) : null
  }
  return {
    kernelRelease: osRelease || null,
    kernelVersion: (await probe.readText('/proc/version'))?.trim() || null,
    kernel: parseKernelRelease(osRelease),
    bwrapPath: binaries.bwrap || null,
    bwrapVersion,
    unsharePath: binaries.unshare || null,
    userns: {
      nsUserPresent: report.ns?.user === true,
      // A readable uid_map is the observable sign that the userns machinery exists;
      // bubblewrap writes this file when it maps the invoking uid into the sandbox.
      uidMapReadable: await probe.exists('/proc/self/uid_map'),
      maxUserNamespaces: report.sysctl?.maxUserNamespaces ?? null,
      unprivilegedUsernsClone: report.sysctl?.unprivilegedUsernsClone ?? null,
      apparmorRestrictUserns: report.sysctl?.apparmorRestrictUserns ?? null,
    },
    mount: {
      mntNamespace: report.ns?.mnt === true,
      mountinfoReadable: await probe.exists('/proc/self/mountinfo'),
      // What `--proc /proc`, `--dev /dev` and bubblewrap's tmpfs root need to exist.
      filesystems: { tmpfs: hasFilesystem('tmpfs'), proc: hasFilesystem('proc'), devtmpfs: hasFilesystem('devtmpfs') },
    },
  }
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
  // bubblewrap is the ONLY Linux backend. It exposes exactly the bound paths and
  // nothing else; the removed unshare backend rebound the whole host root.
  if (!binaries.bwrap) {
    if (binaries.unshare) return unavailable(`${DISABLED_UNSHARE_REASON}; bubblewrap (bwrap) is not on PATH`)
    return unavailable('linux isolation requires bubblewrap (bwrap); no conforming backend is on PATH')
  }
  const backend = 'linux-bubblewrap'

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
    // The in-scope positive control. Its failure means the bind whitelist never took
    // effect, which also means the out-of-scope probe below could only have passed
    // vacuously — so this must reject even though "outside was unreadable" held.
    if (smoke.exitCode === SMOKE_EXIT.boundBindUnreadable) {
      return unavailable(
        `linux isolation smoke test failed for ${backend}: the in-scope positive control failed — a synthetic sentinel inside a declared read-only bind was not readable with its expected bytes inside the sandbox, so the bind whitelist did not take effect and the out-of-scope read probe would only have passed vacuously`,
      )
    }
    if (smoke.exitCode === SMOKE_EXIT.boundBindWritable) {
      return unavailable(
        `linux isolation smoke test failed for ${backend}: a declared read-only bind accepted a write inside the sandbox (the in-scope sentinel was appendable)`,
      )
    }
    if (smoke.exitCode === SMOKE_EXIT.boundBindMutated) {
      return unavailable(
        `linux isolation smoke test failed for ${backend}: the in-scope sentinel changed on the host even though the sandbox reported success, so a write crossed the boundary`,
      )
    }
    if (smoke.exitCode === SMOKE_EXIT.outsideRootReadable) {
      // Discriminating only as the pair (95, 93): exit 95 above proves the in-scope
      // twin WAS readable, so an unreadable out-of-scope sibling is a real bind
      // whitelist rather than a path that was simply never bound. Also the
      // regression guard against "bind the host / read-only" backends (the removed
      // linux-unshare shape), where the file exists and is readable.
      return unavailable(
        `linux isolation smoke test failed for ${backend}: a synthetic file outside every bind was readable inside the sandbox while its in-scope sibling was also readable (host-root-bind regression guard; under bubblewrap this indicates an unexpected host-root bind, or no sandbox at all)`,
      )
    }
    if (smoke.exitCode === SMOKE_EXIT.networkEgress) {
      return unavailable(
        `linux isolation smoke test failed for ${backend}: a host loopback listener was reachable inside the sandbox (network isolation does not hold)`,
      )
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
      'bubblewrap',
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
 * network egress is removed by the kernel rather than by policy. Only the bound
 * roots and the evaluator exist inside; the host `/` is never mounted, which is
 * what keeps $HOME, /etc and credentials unreadable.
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
 * Build the launcher for a planned Linux backend.
 * `linux-unshare` is not a legal plan: the planner never emits it and the builder
 * refuses it, so a disabled backend cannot re-enter through a hand-built plan.
 * `execCommand` spawns `file` with `[...before, command]`.
 */
export function buildLinuxLauncher({ plan, evaluator, scratch, roots, env, binaries }) {
  if (plan?.backend === 'linux-bubblewrap') {
    return {
      file: binaries.bwrap,
      before: [...buildBubblewrapArgs({ evaluator, scratch, roots, env }), '--', '/bin/bash', '-c'],
    }
  }
  throw new Error(`unknown or disabled linux isolation backend: ${plan?.backend}`)
}

/**
 * Run the smoke test through the real launcher. Linux-only; never reached off-Linux.
 * Synthetic materials only, all created here under one fresh mkdtemp root:
 *   <materials>/bound/bound-sentinel.txt     — ro-bound; MUST be readable, MUST reject writes
 *   <materials>/outside/outside-sentinel.txt — never bound; MUST be unreadable
 * plus a live host loopback listener that must be unreachable inside.
 *
 * The two sentinels are deliberately siblings on the same filesystem so that bind
 * membership is the ONLY difference between them. That is what makes the pair
 * discriminating rather than vacuous — see the SMOKE_SCRIPT header.
 *
 * The three smoke keys (AGOS_VERIFY_BOUND_SENTINEL / AGOS_VERIFY_OUTSIDE_SENTINEL /
 * AGOS_VERIFY_NET_PROBE_PORT) must exist INSIDE the sandbox for the probe script to
 * read, and `bound/` must be in the bind list. A candidate-run launcher whitelists
 * only the plain env and the production roots, so `extendLauncher({ env, roots })`
 * rebuilds a smoke-only launcher carrying both additions. Candidate runs never
 * receive either: the launcher handed back from linuxVerificationSandbox is built
 * from the plain env and the production roots alone.
 */
export async function runLinuxSmoke({ probe, launcher, env, backend, timeoutMs = 15000, extendLauncher = null }) {
  const materials = await mkdtemp(join(tmpdir(), 'agos-linux-smoke-'))
  const boundDir = join(materials, 'bound')
  const outsideDir = join(materials, 'outside')
  await mkdir(boundDir, { recursive: true })
  await mkdir(outsideDir, { recursive: true })
  const boundSentinel = join(boundDir, 'bound-sentinel.txt')
  const boundContent = `${BOUND_SENTINEL_LINE}\n`
  const outsideSentinel = join(outsideDir, 'outside-sentinel.txt')
  // Mode 0600 owned by this uid: inside the sandbox bubblewrap maps the invoking uid
  // to itself, so file permissions permit the write and only the read-only MOUNT can
  // refuse it. A 96 pass therefore tests the bind, not the mode bits.
  await writeFile(boundSentinel, boundContent, { mode: 0o600 })
  await writeFile(outsideSentinel, 'synthetic-outside-secret\n', { mode: 0o600 })
  const server = createServer((socket) => socket.end())
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    const smokeVars = {
      AGOS_VERIFY_BOUND_SENTINEL: boundSentinel,
      AGOS_VERIFY_OUTSIDE_SENTINEL: outsideSentinel,
      AGOS_VERIFY_NET_PROBE_PORT: String(server.address().port),
    }
    const effectiveLauncher = extendLauncher
      ? extendLauncher({ env: smokeVars, roots: [boundDir] })
      : launcher
    const childEnv = { ...env, ...smokeVars }
    const result = await probe.run(effectiveLauncher.file, [...effectiveLauncher.before, SMOKE_SCRIPT], { timeoutMs, env: childEnv })
    // Host-side check: a sandbox that reports success while the host bytes moved is
    // the most dangerous shape, so it is caught here rather than trusted.
    const boundSentinelMutated = await readFile(boundSentinel, 'utf8').catch(() => null) !== boundContent
    const exitCode = result.exitCode === 0 && boundSentinelMutated
      ? SMOKE_EXIT.boundBindMutated
      : result.exitCode
    return { backend, exitCode, stderr: result.stderr, boundSentinelMutated }
  } finally {
    server.close()
    await rm(materials, { recursive: true, force: true })
  }
}

/**
 * In-sandbox smoke probe for the macOS Seatbelt backend (CommonJS, run by node
 * inside the sandbox). Reads nothing real: the sentinel is synthetic, the secret
 * is a decoy name, the loopback target is this test's own listener.
 */
const SEATBELT_SMOKE_SOURCE = [
  'const fs = require("node:fs"), net = require("node:net")',
  'const r = { checks: {} }',
  'const attempt = (name, fn) => { try { fn(); r.checks[name] = "allowed" } catch (e) { r.checks[name] = e.code || "denied" } }',
  'attempt("readOutside", () => { fs.readFileSync(process.env.AGOS_SMOKE_SENTINEL, "utf8") })',
  'attempt("writeOutside", () => { fs.writeFileSync(process.env.AGOS_SMOKE_SENTINEL, "x") })',
  'attempt("readInside", () => { fs.readdirSync(process.env.AGOS_SMOKE_EVALUATOR) })',
  'r.checks.envDecoy = process.env.AGOS_SMOKE_DECOY === undefined ? "absent" : "leaked"',
  'r.checks.scratchWritable = (() => { try { fs.writeFileSync(process.env.TMPDIR + "/seatbelt-smoke-write.txt", "ok"); return true } catch { return false } })()',
  'let finished = false',
  'function finish() { if (finished) return; finished = true; console.log(JSON.stringify(r)) }',
  'const socket = net.connect({ host: "127.0.0.1", port: Number(process.env.AGOS_SMOKE_PORT) })',
  'socket.on("connect", () => { r.checks.loopback = "allowed"; socket.destroy(); finish() })',
  'socket.on("error", (e) => { r.checks.loopback = e.code || "denied"; finish() })',
  'setTimeout(finish, 5000).unref()',
  '',
].join('\n')

const denied = (code) => code === 'EPERM' || code === 'EACCES'

/**
 * Runtime-verify a macOS Seatbelt sandbox before it is trusted. Spawns the real
 * launcher with a synthetic probe and demands every property of the boundary:
 * outside reads/writes denied, evaluator still readable (positive control), no
 * inherited environment, scratch writable, loopback denied. Any property that
 * does not hold fails closed as `verification-unavailable`.
 * @returns {Promise<{ok: true, checks: object[]} | {ok: false, reason: string}>}
 */
export async function runSeatbeltSmoke({ probe = systemProbe(), launcher, env, evaluator, scratch, timeoutMs = 15000 }) {
  const materials = await mkdtemp(join(tmpdir(), 'agos-seatbelt-smoke-'))
  const sentinel = join(materials, 'outside-sentinel.txt')
  const sentinelContent = 'synthetic-outside-secret\n'
  await writeFile(sentinel, sentinelContent, { mode: 0o600 })
  const server = createServer((socket) => socket.end())
  const fail = (reason) => unavailable(reason)
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    await writeFile(join(scratch, 'seatbelt-smoke.cjs'), SEATBELT_SMOKE_SOURCE)
    const childEnv = {
      ...env,
      AGOS_SMOKE_SENTINEL: sentinel,
      AGOS_SMOKE_PORT: String(server.address().port),
      AGOS_SMOKE_EVALUATOR: evaluator,
    }
    // The decoy lives only in the PARENT environment; the child is spawned with an
    // explicit env, so a leak would prove the sandbox handed parent state through.
    const previousDecoy = process.env.AGOS_SMOKE_DECOY
    process.env.AGOS_SMOKE_DECOY = 'synthetic-parent-decoy'
    let result
    try {
      result = await probe.run(launcher.file, [...launcher.before, 'node "$AGOS_VERIFY_SCRATCH/seatbelt-smoke.cjs"'], {
        timeoutMs, env: childEnv,
      })
    } finally {
      if (previousDecoy === undefined) delete process.env.AGOS_SMOKE_DECOY
      else process.env.AGOS_SMOKE_DECOY = previousDecoy
    }
    if (result.exitCode !== 0) {
      return fail(`macos seatbelt smoke probe exited ${result.exitCode}: ${String(result.stderr || '').trim() || 'no stderr'}`)
    }
    const line = String(result.stdout || '').trim().split('\n').filter(Boolean).at(-1)
    let parsed
    try {
      parsed = JSON.parse(line)
    } catch {
      return fail(`macos seatbelt smoke probe returned unparsable output: ${String(result.stdout).slice(0, 200)}`)
    }
    const checks = parsed.checks || {}
    if (!denied(checks.readOutside)) return fail(`macos seatbelt smoke: outside sentinel read was ${checks.readOutside}, expected EPERM/EACCES`)
    if (!denied(checks.writeOutside)) return fail(`macos seatbelt smoke: outside sentinel write was ${checks.writeOutside}, expected EPERM/EACCES`)
    if (checks.readInside !== 'allowed') return fail(`macos seatbelt smoke: evaluator unreadable (positive control failed): ${checks.readInside}`)
    if (checks.envDecoy !== 'absent') return fail('macos seatbelt smoke: parent environment leaked into the sandbox')
    if (checks.scratchWritable !== true) return fail('macos seatbelt smoke: scratch directory was not writable')
    if (!denied(checks.loopback)) return fail(`macos seatbelt smoke: loopback connect was ${checks.loopback}, expected EPERM/EACCES`)
    if (await readFile(sentinel, 'utf8') !== sentinelContent) return fail('macos seatbelt smoke: outside sentinel changed on the host')
    return {
      ok: true,
      checks: [
        manifestCheck('outside-read-denied', CHECK_STATUS.verified, `seatbelt smoke: readOutside=${checks.readOutside}`),
        manifestCheck('outside-write-denied', CHECK_STATUS.verified, `seatbelt smoke: writeOutside=${checks.writeOutside}`),
        manifestCheck('evaluator-readable', CHECK_STATUS.verified, 'positive control: readdir(evaluator) succeeded inside the sandbox'),
        manifestCheck('environment-allowlist', CHECK_STATUS.verified, 'parent decoy absent from sandbox env; env keys are explicit'),
        manifestCheck('scratch-writable', CHECK_STATUS.verified, 'seatbelt smoke wrote into AGOS_VERIFY_SCRATCH'),
        manifestCheck('loopback-denied', CHECK_STATUS.verified, `seatbelt smoke: loopback=${checks.loopback}`),
        manifestCheck('outside-unmodified', CHECK_STATUS.verified, 'host sentinel bytes unchanged after the smoke'),
        manifestCheck('process-group-cleanup', CHECK_STATUS.unproven,
          'backend-independent: execCommand kills the process group on timeout/abort; exercised by the darwin orphan-reaping suite test, not at sandbox build time'),
        manifestCheck('seccomp-filter', CHECK_STATUS.unavailable, 'seatbelt profile has no seccomp filter claim'),
      ],
    }
  } finally {
    server.close()
    await rm(materials, { recursive: true, force: true })
    await rm(join(scratch, 'seatbelt-smoke.cjs'), { force: true }).catch(() => {})
  }
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
  // actually hold its own boundary is rejected instead of used. The smoke launcher
  // is rebuilt with the smoke-channel keys added to the env whitelist and the
  // in-scope sentinel directory added to the ro bind list; the candidate `launcher`
  // above never carries either.
  report.smoke = await runLinuxSmoke({
    probe,
    launcher,
    env,
    backend: selection.backend,
    extendLauncher: ({ env: smokeEnv, roots: smokeRoots }) => buildLinuxLauncher({
      plan: selection,
      evaluator,
      scratch,
      roots: [...roots, ...(smokeRoots || [])],
      env: { ...env, ...smokeEnv },
      binaries: report.binaries,
    }),
  })
  const plan = planLinuxIsolation(report)
  if (!plan.ok) return plan

  const boundPaths = [...new Set([evaluator, ...roots])].sort()
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
    // Structured isolation manifest: independent per-dimension fields, never a
    // single merged boundary string. Every check names what was actually run.
    isolation: {
      backend: plan.backend,
      readScope: {
        kind: 'bind-whitelist',
        paths: boundPaths,
        note: 'bubblewrap mounts only these paths; the host / is never bound, so $HOME, /etc and credentials do not exist inside',
      },
      writeScope: { kind: 'single-path', paths: [scratch] },
      network: {
        status: 'denied',
        enforcedBy: 'kernel network namespace (bwrap --unshare-all)',
      },
      environment: {
        inherited: false,
        keys: Object.keys(env).sort(),
        enforcedBy: '--clearenv followed by explicit --setenv for each allowed key',
      },
      processCleanup: {
        strategy: 'process-group kill on timeout/abort',
        enforcedBy: 'execCommand (backend-independent)',
      },
      seccomp: { available: plan.seccompAvailable, applied: plan.seccompApplied },
      checks: [
        manifestCheck('scratch-writable', CHECK_STATUS.verified,
          `smoke exit 0 (a scratch failure would exit ${SMOKE_EXIT.scratchNotWritable})`),
        manifestCheck('bound-roots-read-only', CHECK_STATUS.verified,
          `smoke exit 0 (a writable /usr would exit ${SMOKE_EXIT.readonlyRootWritable})`),
        manifestCheck('bound-bind-readable', CHECK_STATUS.verified,
          `POSITIVE CONTROL: smoke exit 0 (an unreadable in-scope sentinel would exit ${SMOKE_EXIT.boundBindUnreadable}); a synthetic sentinel inside a declared read-only bind was read with its expected bytes from inside the sandbox, which is what gives outside-rootfs-unreadable its discriminating power`),
        manifestCheck('bound-bind-read-only', CHECK_STATUS.verified,
          `smoke exit 0 (an appendable in-scope sentinel would exit ${SMOKE_EXIT.boundBindWritable}, and host bytes moving would exit ${SMOKE_EXIT.boundBindMutated}); the write was refused by the read-only mount, not by permissions: the file is mode 0600 owned by the invoking uid, which bubblewrap maps to itself`),
        manifestCheck('outside-rootfs-unreadable', CHECK_STATUS.verified,
          `smoke exit 0 (a readable outside sentinel would exit ${SMOKE_EXIT.outsideRootReadable}). Discriminating ONLY as a pair with bound-bind-readable: the two sentinels are siblings under one mkdtemp root and only bound/ is in the bind list, so an unreadable out-of-scope twin next to a readable in-scope twin is a real bind whitelist and not merely a path that was never bound. Also the regression guard against host-root-bind backends (the removed linux-unshare shape)`),
        manifestCheck('network-egress-denied', CHECK_STATUS.verified,
          `smoke exit 0 (a reachable host listener would exit ${SMOKE_EXIT.networkEgress})`),
        manifestCheck('environment-allowlist', CHECK_STATUS.verified,
          'smoke executed with the explicit env; --clearenv precedes every --setenv in the launcher argv'),
        manifestCheck('process-group-cleanup', CHECK_STATUS.unproven,
          'execCommand kills the process group on timeout/abort; not exercised by this smoke and unproven on a non-Linux host'),
        manifestCheck('seccomp-filter', CHECK_STATUS.unavailable,
          'no BPF program is shipped, so none is claimed; namespaces are the boundary'),
      ],
    },
  }
}
