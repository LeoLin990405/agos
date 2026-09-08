/**
 * Linux OS-isolation backend: SELECTION and FAIL-CLOSED decision logic.
 *
 * SCOPE NOTE — read before trusting anything here.
 * This host is macOS with no container runtime and no Linux VM, so the Linux
 * executor's RUNTIME behaviour is NOT exercised by this file and is NOT verified.
 * Every Linux test below is one of:
 *   (a) DECISION LOGIC, driven by an injected fake capability probe, or
 *   (b) STATIC, asserting the argv/env we would hand to the kernel.
 * No test in this file spawns bwrap or unshare, and none may be read as evidence
 * that the Linux sandbox actually isolates anything.
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  REQUIRED_NAMESPACES,
  REQUIRED_UNSHARE_FLAGS,
  SMOKE_EXIT,
  buildBubblewrapArgs,
  buildLinuxLauncher,
  buildUnshareArgs,
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
  binaries: { bwrap: '/usr/bin/bwrap', unshare: '/usr/bin/unshare', mount: '/usr/bin/mount' },
  unshareFlags: [...REQUIRED_UNSHARE_FLAGS],
  roots: ['/usr', '/bin', '/lib', '/lib64'],
  seccomp: true,
  uid: 1000,
  smoke: { backend: 'linux-bubblewrap', exitCode: 0, stderr: '' },
  ...overrides,
})

/** Injected probe. Records every run() so we can prove no real process was spawned. */
function fakeProbe({
  files = null,
  binaries = { bwrap: '/usr/bin/bwrap', unshare: '/usr/bin/unshare', mount: '/usr/bin/mount' },
  uid = 1000,
  unshareHelp = REQUIRED_UNSHARE_FLAGS.join(' '),
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
      if (args.includes('--help')) return { exitCode: 0, stdout: unshareHelp, stderr: '' }
      return { exitCode: smoke.exitCode, stdout: '', stderr: smoke.stderr || '' }
    },
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
  assert.match(none.reason, /requires bubblewrap \(bwrap\) or unshare\(1\); neither is on PATH/)

  const noMount = planLinuxIsolation(capableReport({ binaries: { unshare: '/usr/bin/unshare' } }))
  assert.equal(noMount.ok, false)
  assert.match(noMount.reason, /requires mount\(8\) for read-only bind views/)
})

test('unshare missing any required flag fails closed and names the flags', () => {
  for (const flag of REQUIRED_UNSHARE_FLAGS) {
    const plan = planLinuxIsolation(capableReport({
      binaries: { unshare: '/usr/bin/unshare', mount: '/usr/bin/mount' },
      unshareFlags: REQUIRED_UNSHARE_FLAGS.filter((f) => f !== flag),
      smoke: { backend: 'linux-unshare', exitCode: 0, stderr: '' },
    }))
    assert.equal(plan.ok, false, `${flag} must be mandatory`)
    assert.match(plan.reason, new RegExp(`requires unshare\\(1\\) support for .*${flag.replace(/-/g, '\\-')}`))
  }
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

  const crashed = planLinuxIsolation(capableReport({
    smoke: { backend: 'linux-bubblewrap', exitCode: 1, stderr: 'bwrap: No permissions to creating new namespace' },
  }))
  assert.equal(crashed.ok, false)
  assert.match(crashed.reason, /exit 1.*No permissions to creating new namespace/)
})

test('bubblewrap is preferred, unshare is the fallback, and requireSmoke:false only selects', () => {
  const bwrap = planLinuxIsolation(capableReport())
  assert.equal(bwrap.ok, true)
  assert.equal(bwrap.backend, 'linux-bubblewrap')

  const unshare = planLinuxIsolation(capableReport({
    binaries: { unshare: '/usr/bin/unshare', mount: '/usr/bin/mount' },
    smoke: { backend: 'linux-unshare', exitCode: 0 },
  }))
  assert.equal(unshare.ok, true)
  assert.equal(unshare.backend, 'linux-unshare')

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

test('STATIC: unshare argv requests every namespace and remounts the world read-only', () => {
  const evaluator = '/eval/repo'
  const scratch = '/eval/repo/.agos-verification-tmp'
  const { args, prelude } = buildUnshareArgs({ evaluator, scratch })
  for (const flag of REQUIRED_UNSHARE_FLAGS) assert.ok(args.includes(flag), `missing ${flag}`)
  assert.match(prelude, /mount --make-rslave \//, 'must not propagate mounts back to the host')
  assert.match(prelude, /mount -o remount,bind,ro \//)
  assert.match(prelude, /remount,bind,rw,nosuid,nodev "\$AGOS_VERIFY_SCRATCH"/)
  assert.match(prelude, new RegExp(`cd ${JSON.stringify(evaluator)}`))
})

test('STATIC: the candidate command is passed as an argument, never spliced into the prelude', () => {
  const scratch = '/eval/repo/.agos-verification-tmp'
  const launcher = buildLinuxLauncher({
    plan: { backend: 'linux-unshare' },
    evaluator: '/eval/repo',
    scratch,
    roots: ['/usr'],
    env: linuxSandboxEnv({ scratch, nodeBinDir: '/opt/node/bin' }),
    binaries: { unshare: '/usr/bin/unshare' },
  })
  assert.equal(launcher.file, '/usr/bin/unshare')
  assert.match(launcher.before.at(-2), /exec \/bin\/bash -c "\$1"/)
  assert.equal(launcher.before.at(-1), 'agos-verify', '$0 placeholder so the command lands in $1')

  // execCommand appends the command as one argv element; a hostile command is data, not script.
  const hostile = 'true"; rm -rf /; echo "'
  const argv = [...launcher.before, hostile]
  assert.equal(argv.at(-1), hostile)
  assert.ok(!argv.slice(0, -1).some((arg) => arg.includes('rm -rf')))
})

test('an unknown backend throws instead of quietly building a weaker launcher', () => {
  assert.throws(
    () => buildLinuxLauncher({ plan: { backend: 'linux-chroot' }, evaluator: '/e', scratch: '/e/s', roots: [], env: {}, binaries: {} }),
    /unknown linux isolation backend: linux-chroot/,
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
  const smoke = probe.calls.find((call) => !call.args.includes('--help'))
  assert.equal(smoke.file, '/usr/bin/bwrap')
  assert.ok(smoke.args.includes('--unshare-all'))
  assert.match(smoke.args.at(-1), /AGOS_VERIFY_SCRATCH/)
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

test('DECISION LOGIC: a fake linux host with no bwrap and no unshare is refused, not degraded', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agos-sbx-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const probe = fakeProbe({ binaries: {} })
  const sandbox = await verificationSandbox(root, { platform: 'linux', probe })
  assert.equal(sandbox.ok, false)
  assert.match(sandbox.reason, /neither is on PATH/)
  assert.equal(probe.calls.length, 0, 'nothing may be executed once the capability check has failed')
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

test('THIS HOST: the real probe finds no linux isolation, so the linux path stays unproven', async () => {
  const report = await probeLinuxIsolation(systemProbe())
  assert.equal(report.platform, process.platform)
  if (process.platform === 'linux') return // a real Linux runner would need the runtime suite instead

  const plan = planLinuxIsolation(report)
  assert.equal(plan.ok, false)
  assert.match(plan.reason, /linux isolation requires a linux host/)
  // Recorded so the absence is visible in test output rather than assumed.
  assert.equal(report.binaries.bwrap, null, 'no bubblewrap on this host')
  assert.equal(report.proc, false, 'no procfs on this host')
})

test('THIS HOST: darwin still selects the seatbelt backend and hands back a launcher', async (t) => {
  if (process.platform !== 'darwin') return
  const root = await mkdtemp(join(tmpdir(), 'agos-sbx-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const sandbox = await verificationSandbox(root)
  assert.equal(sandbox.ok, true)
  assert.equal(sandbox.kind, 'macos-seatbelt')
  assert.equal(sandbox.launcher.file, '/usr/bin/sandbox-exec')
  assert.deepEqual(sandbox.launcher.before.slice(0, 1), ['-p'])
  assert.deepEqual(sandbox.launcher.before.slice(-2), ['/bin/bash', '-c'])
  assert.equal(sandbox.launcher.before[1], sandbox.profile)
})
