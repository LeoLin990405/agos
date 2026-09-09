/**
 * Linux OS-isolation backend: SELECTION and FAIL-CLOSED decision logic.
 *
 * SCOPE NOTE — read before trusting anything here.
 * This host is macOS with no container runtime and no Linux VM, so the Linux
 * executor's RUNTIME behaviour is NOT exercised by this file and is NOT verified.
 * Every Linux test below is one of:
 *   (a) DECISION LOGIC, driven by an injected fake capability probe, or
 *   (b) STATIC, asserting the argv/env we would hand to the kernel.
 * No test in this file spawns bwrap, and none may be read as evidence
 * that the Linux sandbox actually isolates anything.
 *
 * The `linux-unshare` fallback has been REMOVED from the lib: it rebound the
 * host `/` read-only, so its read scope was the entire host filesystem. The
 * tests below pin that removal: an unshare-only host must fail closed with the
 * host-read-scope reason, and no exported builder may produce an unshare launcher.
 */
import assert from 'node:assert/strict'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import * as sandboxModule from '../lib/autoresearch-sandbox.mjs'
import {
  REQUIRED_NAMESPACES,
  SMOKE_EXIT,
  buildBubblewrapArgs,
  buildLinuxLauncher,
  chooseIsolationBackend,
  linuxSandboxEnv,
  linuxVerificationSandbox,
  planLinuxIsolation,
  probeLinuxIsolation,
  systemProbe,
} from '../lib/autoresearch-sandbox.mjs'
import { verificationSandbox } from '../lib/autoresearch-workspace.mjs'

const UNAVAILABLE = /^verification-unavailable: /

/** A fully capable Linux host, as the prober would report it. Purely fictional. */
const capableReport = (overrides = {}) => ({
  platform: 'linux',
  proc: true,
  ns: { user: true, mnt: true, net: true, pid: true },
  sysctl: { maxUserNamespaces: 15000, unprivilegedUsernsClone: 1, apparmorRestrictUserns: 0 },
  binaries: { bwrap: '/usr/bin/bwrap', unshare: '/usr/bin/unshare' },
  roots: ['/usr', '/bin', '/lib', '/lib64'],
  seccomp: true,
  uid: 1000,
  smoke: { backend: 'linux-bubblewrap', exitCode: 0, stderr: '' },
  ...overrides,
})

/** Injected probe. Records every run() so we can prove no real bwrap was spawned. */
function fakeProbe({
  files = null,
  binaries = { bwrap: '/usr/bin/bwrap', unshare: '/usr/bin/unshare' },
  uid = 1000,
  smoke = { exitCode: 0, stderr: '' },
} = {}) {
  const present = files || {
    '/proc/self/status': 'Name:\tnode\nSeccomp:\t2\n',
    '/proc/self/ns/user': '', '/proc/self/ns/mnt': '', '/proc/self/ns/net': '', '/proc/self/ns/pid': '',
    '/proc/sys/user/max_user_namespaces': '15000',
    '/usr': '', '/bin': '', '/sbin': '', '/lib': '', '/lib64': '',
  }
  const calls = []
  return {
    calls,
    uid,
    async readText(path) { return Object.prototype.hasOwnProperty.call(present, path) ? present[path] : null },
    async exists(path) { return Object.prototype.hasOwnProperty.call(present, path) },
    async which(binary) { return binaries[binary] || null },
    async run(file, args) {
      calls.push({ file, args })
      return { exitCode: smoke.exitCode, stdout: '', stderr: smoke.stderr || '' }
    },
  }
}

const MANIFEST_STATUSES = new Set(['verified', 'unproven', 'unavailable'])

/** Every manifest check must be named, status-tagged with the shared vocabulary, and evidenced. */
function assertManifestChecks(checks) {
  assert.ok(Array.isArray(checks) && checks.length > 0, 'manifest checks required')
  const names = new Set()
  for (const check of checks) {
    assert.equal(typeof check.name, 'string')
    assert.ok(check.name.length > 0)
    assert.ok(!names.has(check.name), `duplicate check ${check.name}`)
    names.add(check.name)
    assert.ok(MANIFEST_STATUSES.has(check.status), `${check.name}: invalid status ${check.status}`)
    assert.equal(typeof check.evidence, 'string')
  }
}

// ── backend selection ────────────────────────────────────────────────────────

test('backend is chosen per platform and unknown platforms get no backend at all', () => {
  assert.equal(chooseIsolationBackend('darwin'), 'macos-seatbelt')
  assert.equal(chooseIsolationBackend('linux'), 'linux-namespaces')
  for (const platform of ['win32', 'freebsd', 'sunos', 'aix', undefined]) {
    assert.equal(chooseIsolationBackend(platform), null, `${platform} must not get a backend`)
  }
})

test('a platform with no OS boundary fails closed and names the platform', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agos-sbx-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const result = await verificationSandbox(root, { platform: 'win32' })
  assert.equal(result.ok, false)
  assert.match(result.reason, UNAVAILABLE)
  assert.match(result.reason, /no OS isolation backend for platform win32/)
  assert.equal(result.launcher, undefined, 'a rejected host must not hand back a launcher')
})

// ── fail-closed decision logic (pure, no I/O) ────────────────────────────────

test('planLinuxIsolation refuses a non-linux report instead of trusting the caller', () => {
  for (const platform of ['darwin', 'win32', undefined]) {
    const plan = planLinuxIsolation(capableReport({ platform }))
    assert.equal(plan.ok, false)
    assert.match(plan.reason, /linux isolation requires a linux host/)
  }
  assert.equal(planLinuxIsolation(null).ok, false)
})

test('every missing namespace fails closed and names that specific namespace', () => {
  for (const [key, label] of Object.entries(REQUIRED_NAMESPACES)) {
    const ns = { user: true, mnt: true, net: true, pid: true, [key]: false }
    const plan = planLinuxIsolation(capableReport({ ns }))
    assert.equal(plan.ok, false, `${key} namespace must be mandatory`)
    assert.match(plan.reason, UNAVAILABLE)
    assert.match(plan.reason, new RegExp(`requires a ${label} namespace`))
    assert.match(plan.reason, new RegExp(`/proc/self/ns/${key} missing`))
  }
})

test('missing procfs fails closed', () => {
  const plan = planLinuxIsolation(capableReport({ proc: false }))
  assert.equal(plan.ok, false)
  assert.match(plan.reason, /requires procfs mounted at \/proc/)
})

test('each unprivileged-userns gate fails closed with its own sysctl name', () => {
  const cases = [
    [{ maxUserNamespaces: 0, unprivilegedUsernsClone: 1, apparmorRestrictUserns: 0 }, /user\.max_user_namespaces=0/],
    [{ maxUserNamespaces: 15000, unprivilegedUsernsClone: 0, apparmorRestrictUserns: 0 }, /kernel\.unprivileged_userns_clone=0/],
    [{ maxUserNamespaces: 15000, unprivilegedUsernsClone: 1, apparmorRestrictUserns: 1 }, /apparmor_restrict_unprivileged_userns=1/],
  ]
  for (const [sysctl, expected] of cases) {
    const plan = planLinuxIsolation(capableReport({ sysctl }))
    assert.equal(plan.ok, false)
    assert.match(plan.reason, UNAVAILABLE)
    assert.match(plan.reason, expected)
  }
})

test('root already holds CAP_SYS_ADMIN so the unprivileged-userns gates do not apply to it', () => {
  const sysctl = { maxUserNamespaces: 0, unprivilegedUsernsClone: 0, apparmorRestrictUserns: 1 }
  assert.equal(planLinuxIsolation(capableReport({ sysctl, uid: 1000 })).ok, false)
  assert.equal(planLinuxIsolation(capableReport({ sysctl, uid: 0 })).ok, true)
})

test('a host with no isolation binary fails closed rather than degrading', () => {
  const none = planLinuxIsolation(capableReport({ binaries: {} }))
  assert.equal(none.ok, false)
  assert.match(none.reason, /requires bubblewrap \(bwrap\)/)
})

test('linux-unshare is never selected: an unshare-only host fails closed naming the host read scope', () => {
  const unshareOnly = planLinuxIsolation(capableReport({ binaries: { unshare: '/usr/bin/unshare' } }))
  assert.equal(unshareOnly.ok, false)
  assert.match(unshareOnly.reason, /linux-unshare backend is disabled/)
  assert.match(unshareOnly.reason, /read scope is the whole host/)
  assert.match(unshareOnly.reason, /\$HOME, \/etc, credentials stay readable/)
  assert.equal(unshareOnly.backend, undefined, 'a disabled backend must never be handed back')
})

test('linux-unshare is removed, not merely deprioritised: no exported builder can produce it', () => {
  assert.equal(sandboxModule.buildUnshareArgs, undefined, 'the unshare argv builder must be gone')
  assert.equal(sandboxModule.REQUIRED_UNSHARE_FLAGS, undefined, 'unshare flag requirements must be gone')
  assert.throws(
    () => buildLinuxLauncher({
      plan: { backend: 'linux-unshare' },
      evaluator: '/e',
      scratch: '/e/s',
      roots: ['/usr'],
      env: {},
      binaries: { unshare: '/usr/bin/unshare' },
    }),
    /unknown or disabled linux isolation backend: linux-unshare/,
  )
})

test('a host without a bindable /usr fails closed', () => {
  const plan = planLinuxIsolation(capableReport({ roots: ['/bin'] }))
  assert.equal(plan.ok, false)
  assert.match(plan.reason, /requires a readable \/usr to bind read-only/)
})

test('the smoke test is mandatory and each failure mode is reported distinctly', () => {
  const missing = planLinuxIsolation(capableReport({ smoke: null }))
  assert.equal(missing.ok, false)
  assert.match(missing.reason, /smoke test did not run for linux-bubblewrap/)

  const mismatched = planLinuxIsolation(capableReport({ smoke: { backend: 'linux-unshare', exitCode: 0 } }))
  assert.equal(mismatched.ok, false)
  assert.match(mismatched.reason, /ran on linux-unshare, not the selected linux-bubblewrap/)

  const noScratch = planLinuxIsolation(capableReport({
    smoke: { backend: 'linux-bubblewrap', exitCode: SMOKE_EXIT.scratchNotWritable },
  }))
  assert.equal(noScratch.ok, false)
  assert.match(noScratch.reason, /scratch directory was not writable/)

  const leaky = planLinuxIsolation(capableReport({
    smoke: { backend: 'linux-bubblewrap', exitCode: SMOKE_EXIT.readonlyRootWritable },
  }))
  assert.equal(leaky.ok, false)
  assert.match(leaky.reason, /\/usr was writable inside the sandbox/)

  const outsideRead = planLinuxIsolation(capableReport({
    smoke: { backend: 'linux-bubblewrap', exitCode: SMOKE_EXIT.outsideRootReadable },
  }))
  assert.equal(outsideRead.ok, false)
  assert.match(outsideRead.reason, /outside every bind was readable/)

  const netLeak = planLinuxIsolation(capableReport({
    smoke: { backend: 'linux-bubblewrap', exitCode: SMOKE_EXIT.networkEgress },
  }))
  assert.equal(netLeak.ok, false)
  assert.match(netLeak.reason, /loopback listener was reachable/)

  const crashed = planLinuxIsolation(capableReport({
    smoke: { backend: 'linux-bubblewrap', exitCode: 1, stderr: 'bwrap: No permissions to creating new namespace' },
  }))
  assert.equal(crashed.ok, false)
  assert.match(crashed.reason, /exit 1.*No permissions to creating new namespace/)
})

test('bubblewrap is the only linux backend, and requireSmoke:false only selects', () => {
  const bwrap = planLinuxIsolation(capableReport())
  assert.equal(bwrap.ok, true)
  assert.equal(bwrap.backend, 'linux-bubblewrap')

  const selectOnly = planLinuxIsolation(capableReport({ smoke: null }), { requireSmoke: false })
  assert.equal(selectOnly.ok, true)
  assert.equal(selectOnly.backend, 'linux-bubblewrap')
})

test('seccomp is reported as available but never claimed as an applied filter', () => {
  const withSeccomp = planLinuxIsolation(capableReport({ seccomp: true }))
  assert.equal(withSeccomp.seccompAvailable, true)
  assert.equal(withSeccomp.seccompApplied, false, 'no BPF program is shipped, so none may be claimed')
  assert.ok(withSeccomp.capabilities.includes('seccomp-available'))

  const without = planLinuxIsolation(capableReport({ seccomp: false }))
  assert.equal(without.ok, true, 'seccomp is defence in depth, not a precondition')
  assert.equal(without.seccompAvailable, false)
  assert.ok(!without.capabilities.includes('seccomp-available'))
})

// ── static argv / env construction ───────────────────────────────────────────

test('STATIC: bubblewrap argv unshares everything and exposes exactly one writable path', () => {
  const evaluator = '/eval/repo'
  const scratch = '/eval/repo/.agos-verification-tmp'
  const env = linuxSandboxEnv({ scratch, nodeBinDir: '/opt/node/bin' })
  const args = buildBubblewrapArgs({ evaluator, scratch, roots: ['/usr', '/lib'], env })

  for (const flag of ['--unshare-all', '--new-session', '--die-with-parent', '--clearenv']) {
    assert.ok(args.includes(flag), `missing ${flag}`)
  }
  assert.deepEqual(args.slice(args.indexOf('--proc'), args.indexOf('--proc') + 2), ['--proc', '/proc'])

  // The only read-write bind is scratch; the evaluator itself is read-only.
  const writable = args.reduce((acc, arg, i) => (arg === '--bind' ? [...acc, args[i + 1]] : acc), [])
  assert.deepEqual(writable, [scratch])
  assert.ok(args.includes('--ro-bind'))
  assert.equal(args[args.indexOf('--ro-bind') + 1], evaluator)

  // Ordering matters: scratch lives inside the evaluator, so its rw bind must come after.
  assert.ok(args.indexOf('--bind') > args.indexOf('--ro-bind'), 'rw scratch bind must follow the ro evaluator bind')
  assert.deepEqual(args.slice(-2), ['--chdir', evaluator])
})

test('STATIC: the sandbox env carries no HOME, no tokens and no proxy inheritance', () => {
  const scratch = '/eval/repo/.agos-verification-tmp'
  const env = linuxSandboxEnv({ scratch, nodeBinDir: '/opt/node/bin' })
  assert.deepEqual(Object.keys(env).sort(), [
    'AGOS_VERIFY_SCRATCH', 'LANG', 'LC_ALL', 'OPENSSL_CONF', 'PATH', 'TEMP', 'TMP', 'TMPDIR', 'TZ',
  ])
  for (const banned of ['HOME', 'NODE_OPTIONS', 'BASH_ENV', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY']) {
    assert.equal(env[banned], undefined, `${banned} must not be handed to the candidate`)
  }
  assert.equal(env.TMPDIR, scratch)
  assert.match(env.PATH, /^\/opt\/node\/bin:/)

  // Every variable is passed through --setenv after --clearenv, so a polluted parent
  // environment cannot reach the child even if the caller passes one.
  const args = buildBubblewrapArgs({ evaluator: '/eval/repo', scratch, roots: ['/usr'], env })
  assert.ok(args.indexOf('--clearenv') < args.indexOf('--setenv'))
  for (const key of Object.keys(env)) assert.ok(args.includes(key), `${key} must be re-set explicitly`)
})

test('STATIC: the launcher argv exposes the read whitelist and nothing else', () => {
  // Every path the sandbox can see is enumerated; there is no host-root bind.
  const evaluator = '/eval/repo'
  const scratch = '/eval/repo/.agos-verification-tmp'
  const env = linuxSandboxEnv({ scratch, nodeBinDir: '/opt/node/bin' })
  const roots = ['/usr', '/lib', '/opt/node']
  const args = buildBubblewrapArgs({ evaluator, scratch, roots, env })
  const bound = []
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--ro-bind' || args[i] === '--ro-bind-try' || args[i] === '--bind') bound.push(args[i + 1])
  }
  assert.deepEqual(new Set(bound), new Set([...roots, evaluator, scratch]))
  assert.ok(!bound.includes('/'), 'the host root must never be bound')
  assert.ok(!args.some((arg) => typeof arg === 'string' && (arg === '$HOME' || arg === '/etc' || arg.startsWith('/root'))),
    'no private host path may appear in the bind list')
})

test('STATIC: the candidate command is passed as an argument, never spliced into argv', () => {
  const scratch = '/eval/repo/.agos-verification-tmp'
  const launcher = buildLinuxLauncher({
    plan: { backend: 'linux-bubblewrap' },
    evaluator: '/eval/repo',
    scratch,
    roots: ['/usr'],
    env: linuxSandboxEnv({ scratch, nodeBinDir: '/opt/node/bin' }),
    binaries: { bwrap: '/usr/bin/bwrap' },
  })
  assert.equal(launcher.file, '/usr/bin/bwrap')
  assert.deepEqual(launcher.before.slice(-3), ['--', '/bin/bash', '-c'])

  // execCommand appends the command as one argv element; a hostile command is data, not script.
  const hostile = 'true"; rm -rf /; echo "'
  const argv = [...launcher.before, hostile]
  assert.equal(argv.at(-1), hostile)
  assert.ok(!argv.slice(0, -1).some((arg) => arg.includes('rm -rf')))
})

test('STATIC: candidate launcher argv never whitelists smoke-channel keys; smoke launcher does', () => {
  const scratch = '/eval/repo/.agos-verification-tmp'
  const env = linuxSandboxEnv({ scratch, nodeBinDir: '/opt/node/bin' })
  const candidate = buildBubblewrapArgs({ evaluator: '/eval/repo', scratch, roots: ['/usr'], env })
  for (const key of ['AGOS_VERIFY_OUTSIDE_SENTINEL', 'AGOS_VERIFY_NET_PROBE_PORT']) {
    assert.ok(!candidate.includes(key), `${key} must never appear in a candidate launcher`)
  }
  // AGOS_VERIFY_SCRATCH is a legitimate candidate whitelist key (scratch location).
  assert.ok(candidate.includes('AGOS_VERIFY_SCRATCH'))

  // Only the smoke rebuild, with the two keys merged into the env map, whitelists them.
  const smoke = buildBubblewrapArgs({
    evaluator: '/eval/repo', scratch, roots: ['/usr'],
    env: { ...env, AGOS_VERIFY_OUTSIDE_SENTINEL: '/tmp/sentinel', AGOS_VERIFY_NET_PROBE_PORT: '1' },
  })
  for (const key of ['AGOS_VERIFY_OUTSIDE_SENTINEL', 'AGOS_VERIFY_NET_PROBE_PORT']) {
    assert.ok(smoke.includes('--setenv') && smoke.includes(key), `smoke launcher must whitelist ${key}`)
  }
})

test('an unknown backend throws instead of quietly building a weaker launcher', () => {
  assert.throws(
    () => buildLinuxLauncher({ plan: { backend: 'linux-chroot' }, evaluator: '/e', scratch: '/e/s', roots: [], env: {}, binaries: {} }),
    /unknown or disabled linux isolation backend: linux-chroot/,
  )
})

// ── end-to-end decision logic through the production entry point ─────────────

test('DECISION LOGIC: a fully capable fake linux host selects bubblewrap and smoke-tests it', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agos-sbx-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const probe = fakeProbe()
  const sandbox = await verificationSandbox(root, { platform: 'linux', probe })

  assert.equal(sandbox.ok, true)
  assert.equal(sandbox.kind, 'linux-bubblewrap')
  assert.equal(sandbox.launcher.file, '/usr/bin/bwrap')
  assert.ok(sandbox.launcher.before.includes('--unshare-all'))
  assert.deepEqual(sandbox.launcher.before.slice(-3), ['--', '/bin/bash', '-c'])
  assert.equal(sandbox.seccompApplied, false)
  assert.ok(sandbox.capabilities.includes('network-namespace'))

  // The smoke test went through the launcher we just built, not some other command.
  // probe.calls may also include the smoke's own host-side helpers, but every
  // recorded call must be the bwrap launcher — nothing else may execute.
  assert.ok(probe.calls.length >= 1, 'the smoke must have run through the launcher')
  for (const call of probe.calls) assert.equal(call.file, '/usr/bin/bwrap')
  const smokeArgv = probe.calls.at(-1).args
  assert.ok(smokeArgv.includes('--unshare-all'))
  assert.match(smokeArgv.at(-1), /AGOS_VERIFY_SCRATCH/)

  // P1 invariant: the smoke-channel keys entered the SANDBOX through the smoke
  // launcher's argv whitelist (--setenv), so `set -u` in the probe can read them.
  // The candidate launcher handed back from verificationSandbox must NOT carry
  // them: they are verification-channel-only and never granted to candidate runs.
  // (AGOS_VERIFY_SCRATCH stays in the candidate whitelist by design.)
  for (const key of ['AGOS_VERIFY_OUTSIDE_SENTINEL', 'AGOS_VERIFY_NET_PROBE_PORT']) {
    assert.ok(smokeArgv.includes('--setenv') && smokeArgv.includes(key),
      `smoke launcher argv must whitelist ${key} via --setenv`)
    assert.ok(!sandbox.launcher.before.includes(key),
      `candidate launcher argv must never contain ${key}`)
  }

  // Structured manifest: independent per-dimension fields, every check named and
  // status-tagged. Only smoke-derived claims may be 'verified' on this fake host.
  const iso = sandbox.isolation
  assert.equal(iso.backend, 'linux-bubblewrap')
  assert.equal(iso.readScope.kind, 'bind-whitelist')
  assert.ok(iso.readScope.paths.includes('/usr') && iso.readScope.paths.includes(await realpath(root)))
  assert.ok(!iso.readScope.paths.includes('/'), 'read scope must never be the host root')
  assert.deepEqual(iso.writeScope.paths, [sandbox.scratch])
  assert.equal(iso.network.status, 'denied')
  assert.equal(iso.environment.inherited, false)
  assert.deepEqual(iso.environment.keys, Object.keys(sandbox.env).sort())
  assert.equal(iso.seccomp.applied, false)
  assertManifestChecks(iso.checks)
  const byName = Object.fromEntries(iso.checks.map((c) => [c.name, c.status]))
  assert.equal(byName['scratch-writable'], 'verified')
  assert.equal(byName['bound-roots-read-only'], 'verified')
  assert.equal(byName['outside-rootfs-unreadable'], 'verified')
  assert.equal(byName['network-egress-denied'], 'verified')
  assert.equal(byName['process-group-cleanup'], 'unproven')
  assert.equal(byName['seccomp-filter'], 'unavailable')
})

test('DECISION LOGIC: a fake linux host whose smoke test leaks /usr is refused', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agos-sbx-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const probe = fakeProbe({ smoke: { exitCode: SMOKE_EXIT.readonlyRootWritable } })
  const sandbox = await verificationSandbox(root, { platform: 'linux', probe })
  assert.equal(sandbox.ok, false)
  assert.match(sandbox.reason, UNAVAILABLE)
  assert.match(sandbox.reason, /\/usr was writable inside the sandbox/)
  assert.equal(sandbox.launcher, undefined)
})

test('DECISION LOGIC: a fake linux host whose smoke test reads outside the binds is refused', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agos-sbx-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const probe = fakeProbe({ smoke: { exitCode: SMOKE_EXIT.outsideRootReadable } })
  const sandbox = await verificationSandbox(root, { platform: 'linux', probe })
  assert.equal(sandbox.ok, false)
  assert.match(sandbox.reason, /outside every bind was readable/)
})

test('DECISION LOGIC: a fake linux host whose smoke test reaches the host network is refused', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agos-sbx-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const probe = fakeProbe({ smoke: { exitCode: SMOKE_EXIT.networkEgress } })
  const sandbox = await verificationSandbox(root, { platform: 'linux', probe })
  assert.equal(sandbox.ok, false)
  assert.match(sandbox.reason, /loopback listener was reachable/)
})

test('DECISION LOGIC: a fake linux host with no bwrap and no unshare is refused, not degraded', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agos-sbx-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const probe = fakeProbe({ binaries: {} })
  const sandbox = await verificationSandbox(root, { platform: 'linux', probe })
  assert.equal(sandbox.ok, false)
  assert.match(sandbox.reason, /requires bubblewrap \(bwrap\)/)
  assert.equal(probe.calls.length, 0, 'nothing may be executed once the capability check has failed')
})

test('DECISION LOGIC: a fake linux host with only unshare is refused with the host-read-scope reason', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agos-sbx-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const probe = fakeProbe({ binaries: { unshare: '/usr/bin/unshare' } })
  const sandbox = await verificationSandbox(root, { platform: 'linux', probe })
  assert.equal(sandbox.ok, false)
  assert.match(sandbox.reason, UNAVAILABLE)
  assert.match(sandbox.reason, /linux-unshare backend is disabled/)
  assert.match(sandbox.reason, /read scope is the whole host/)
  assert.equal(probe.calls.length, 0, 'a disabled backend must never reach the smoke stage')
})

test('DECISION LOGIC: userns blocked by AppArmor is refused even though every binary is present', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agos-sbx-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const probe = fakeProbe({
    files: {
      '/proc/self/status': 'Seccomp:\t2\n',
      '/proc/self/ns/user': '', '/proc/self/ns/mnt': '', '/proc/self/ns/net': '', '/proc/self/ns/pid': '',
      '/proc/sys/user/max_user_namespaces': '15000',
      '/proc/sys/kernel/apparmor_restrict_unprivileged_userns': '1',
      '/usr': '', '/bin': '',
    },
  })
  const sandbox = await verificationSandbox(root, { platform: 'linux', probe })
  assert.equal(sandbox.ok, false)
  assert.match(sandbox.reason, /apparmor_restrict_unprivileged_userns=1/)
})

// ── this host, stated honestly ───────────────────────────────────────────────

test('THIS HOST: the real probe finds no linux isolation, so the linux path stays unproven', async (t) => {
  const report = await probeLinuxIsolation(systemProbe())
  assert.equal(report.platform, process.platform)
  if (process.platform === 'linux') {
    t.skip('on a linux host the bubblewrap runtime smoke in verificationSandbox owns the evidence; this probe-only test is for non-linux hosts')
    return
  }

  const plan = planLinuxIsolation(report)
  assert.equal(plan.ok, false)
  assert.match(plan.reason, /linux isolation requires a linux host/)
  // Recorded so the absence is visible in test output rather than assumed.
  assert.equal(report.binaries.bwrap, null, 'no bubblewrap on this host')
  assert.equal(report.proc, false, 'no procfs on this host')
})

test('THIS HOST: darwin selects seatbelt, smoke-verifies it, and reports a structured manifest', async (t) => {
  if (process.platform !== 'darwin') {
    t.skip('real seatbelt smoke evidence requires a darwin host; on this host no sandboxed runtime check can execute')
    return
  }
  const root = await mkdtemp(join(tmpdir(), 'agos-sbx-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const sandbox = await verificationSandbox(root)
  assert.equal(sandbox.ok, true, sandbox.reason)
  assert.equal(sandbox.kind, 'macos-seatbelt')
  assert.equal(sandbox.launcher.file, '/usr/bin/sandbox-exec')
  assert.deepEqual(sandbox.launcher.before.slice(0, 1), ['-p'])
  assert.deepEqual(sandbox.launcher.before.slice(-2), ['/bin/bash', '-c'])
  assert.equal(sandbox.launcher.before[1], sandbox.profile)

  // REAL SUBPROCESS EVIDENCE (darwin only): every check below ran inside the
  // actual sandbox-exec boundary against synthetic materials.
  const iso = sandbox.isolation
  assert.equal(iso.backend, 'macos-seatbelt')
  assert.equal(iso.readScope.kind, 'profile-whitelist')
  assert.ok(iso.readScope.paths.includes(await realpath(root)), 'evaluator realpath must be in the read whitelist')
  assert.ok(!iso.readScope.paths.includes('/'))
  assert.deepEqual(iso.writeScope.paths, [sandbox.scratch])
  assert.equal(iso.network.status, 'denied')
  assert.equal(iso.environment.inherited, false)
  assertManifestChecks(iso.checks)
  const byName = Object.fromEntries(iso.checks.map((c) => [c.name, c.status]))
  for (const name of ['outside-read-denied', 'outside-write-denied', 'evaluator-readable',
    'environment-allowlist', 'scratch-writable', 'loopback-denied', 'outside-unmodified']) {
    assert.equal(byName[name], 'verified', `${name} must be runtime-verified on darwin`)
  }
  assert.equal(byName['process-group-cleanup'], 'unproven',
    'process cleanup is backend-independent and is exercised by the orphan-reaping test, not here')
})
