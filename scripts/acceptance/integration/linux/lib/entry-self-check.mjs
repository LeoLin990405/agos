/**
 * ENTRY SELF-CHECK. Read this before reading its results anywhere.
 *
 * Everything in this file runs against SYNTHETIC STUBS on whatever host is handy,
 * including macOS. It answers exactly one question: "if the sandbox were broken,
 * would this entry notice?" It answers NOTHING about whether a kernel isolates
 * anything, and its passes are NOT runtime evidence. The layer result keeps these
 * counts in a separate `selfCheck` block for that reason: folding an entry
 * self-check into a runtime `pass` count is how an entry ends up certifying an
 * environment it never actually exercised.
 *
 * The shape is deliberately symmetric — a usable stub must be ACCEPTED, and each
 * deliberately broken stub must be REFUSED. A self-check with only the accepting
 * half proves nothing: an entry that accepts everything would pass it.
 */

/** Fully capable fictional Linux host, as the prober would see it. */
export const CAPABLE_FILES = Object.freeze({
  '/proc/self/status': 'Name:\tnode\nSeccomp:\t2\n',
  '/proc/self/ns/user': '', '/proc/self/ns/mnt': '', '/proc/self/ns/net': '', '/proc/self/ns/pid': '',
  '/proc/self/uid_map': '         0          0 4294967295\n',
  '/proc/self/mountinfo': '',
  '/proc/version': 'Linux version 6.1.0-synthetic (agos-self-check)\n',
  '/proc/filesystems': 'nodev\tproc\nnodev\ttmpfs\n\text4\n',
  '/proc/sys/user/max_user_namespaces': '15000',
  '/usr': '', '/bin': '', '/sbin': '', '/lib': '', '/lib64': '',
})

/**
 * Injected probe over synthetic facts. Records every run() so a self-check can
 * prove that nothing real was executed and that refusals happened BEFORE any spawn.
 */
export function stubProbe({
  files = CAPABLE_FILES,
  binaries = { bwrap: '/usr/bin/bwrap', unshare: '/usr/bin/unshare' },
  uid = 1000,
  smokeExit = 0,
  smokeStderr = '',
  versionStdout = 'bubblewrap 0.8.0\n',
} = {}) {
  const calls = []
  return {
    calls,
    uid,
    async readText(path) { return Object.prototype.hasOwnProperty.call(files, path) ? files[path] : null },
    async exists(path) { return Object.prototype.hasOwnProperty.call(files, path) },
    async which(binary) { return binaries[binary] || null },
    async run(file, args) {
      calls.push({ file, args })
      if (args.includes('--version')) return { exitCode: 0, stdout: versionStdout, stderr: '' }
      return { exitCode: smokeExit, stdout: '', stderr: smokeStderr }
    },
  }
}

const UNAVAILABLE = /^verification-unavailable: /

/**
 * Broken stubs, one per property. Each `expect` must appear in the refusal reason,
 * so a stub that is refused for the WRONG reason still fails the self-check.
 */
export const brokenStubs = (SMOKE_EXIT) => [
  { id: 'no-bwrap', probe: { binaries: {} }, expect: /requires bubblewrap \(bwrap\)/ },
  { id: 'unshare-only', probe: { binaries: { unshare: '/usr/bin/unshare' } }, expect: /linux-unshare backend is disabled/ },
  { id: 'scratch-not-writable', probe: { smokeExit: SMOKE_EXIT.scratchNotWritable }, expect: /scratch directory was not writable/ },
  { id: 'readonly-root-writable', probe: { smokeExit: SMOKE_EXIT.readonlyRootWritable }, expect: /\/usr was writable inside the sandbox/ },
  { id: 'positive-control-failed', probe: { smokeExit: SMOKE_EXIT.boundBindUnreadable }, expect: /in-scope positive control failed/ },
  { id: 'readonly-bind-writable', probe: { smokeExit: SMOKE_EXIT.boundBindWritable }, expect: /read-only bind accepted a write/ },
  { id: 'outside-bind-readable', probe: { smokeExit: SMOKE_EXIT.outsideRootReadable }, expect: /outside every bind was readable/ },
  { id: 'network-egress', probe: { smokeExit: SMOKE_EXIT.networkEgress }, expect: /loopback listener was reachable/ },
  {
    id: 'userns-blocked-by-apparmor',
    probe: { files: { ...CAPABLE_FILES, '/proc/sys/kernel/apparmor_restrict_unprivileged_userns': '1' } },
    expect: /apparmor_restrict_unprivileged_userns=1/,
  },
  { id: 'no-bindable-usr', probe: { files: Object.fromEntries(Object.entries(CAPABLE_FILES).filter(([k]) => k !== '/usr')) }, expect: /requires a readable \/usr to bind read-only/ },
]

const outcome = (id, ok, detail, extra = {}) => ({ id, ok, detail, ...extra })

/**
 * @param {object} deps production module exports plus the entry's own manifest reader
 * @returns {Promise<{isRuntimeEvidence: false, counts: object, cases: object[]}>}
 */
export async function runEntrySelfCheck({ lib, verificationSandbox, evaluator, checksFromManifest, checkProcessGroupReaping }) {
  const cases = []

  // ── the accepting half: a usable stub must be accepted ─────────────────────
  const usableProbe = stubProbe()
  const usable = await verificationSandbox(evaluator, { platform: 'linux', probe: usableProbe })
  cases.push(outcome('usable-stub-accepted', usable.ok === true && usable.kind === 'linux-bubblewrap',
    usable.ok ? `selected ${usable.kind}; launcher=${usable.launcher?.file}` : `refused: ${usable.reason}`))
  cases.push(outcome('usable-stub-executed-only-the-launcher',
    usableProbe.calls.length > 0 && usableProbe.calls.every((c) => c.file === '/usr/bin/bwrap'),
    `probe.run calls: ${usableProbe.calls.map((c) => c.file).join(', ') || 'none'}`))
  const manifestChecks = usable.ok ? checksFromManifest(usable) : []
  cases.push(outcome('usable-stub-satisfies-every-manifest-item',
    manifestChecks.length > 0 && manifestChecks.every((c) => c.verdict === 'pass'),
    manifestChecks.map((c) => `${c.id}=${c.verdict}`).join(', ') || 'no manifest checks produced'))

  // ── the refusing half: each broken stub must be refused, for its own reason ──
  for (const stub of brokenStubs(lib.SMOKE_EXIT)) {
    const probe = stubProbe(stub.probe)
    const sandbox = await verificationSandbox(evaluator, { platform: 'linux', probe })
    const refused = sandbox.ok === false
      && UNAVAILABLE.test(String(sandbox.reason || ''))
      && stub.expect.test(String(sandbox.reason || ''))
      && sandbox.launcher === undefined
    cases.push(outcome(`broken-stub-refused:${stub.id}`, refused,
      sandbox.ok ? 'ACCEPTED a deliberately broken stub' : String(sandbox.reason)))
  }

  // ── the entry's own pairing gate, tested by removing the positive control ────
  // This is about THIS ENTRY, not the product: if a future change deletes the
  // in-scope positive control from the smoke, item 3 must stop being reported as
  // covered instead of quietly staying green on a vacuous assertion.
  if (usable.ok) {
    const stripped = {
      ...usable,
      isolation: { ...usable.isolation, checks: usable.isolation.checks.filter((c) => c.name !== 'bound-bind-readable') },
    }
    const withoutControl = checksFromManifest(stripped)
    const outside = withoutControl.find((c) => c.id === 'outside-bind-unreadable')
    cases.push(outcome('pairing-gate-rejects-a-manifest-with-no-positive-control',
      outside?.verdict === 'fail' && outside?.pairedControlSatisfied === false,
      `outside-bind-unreadable verdict=${outside?.verdict}: ${outside?.evidence}`))

    const downgraded = {
      ...usable,
      isolation: {
        ...usable.isolation,
        checks: usable.isolation.checks.map((c) => (c.name === 'bound-bind-readable' ? { ...c, status: 'unproven' } : c)),
      },
    }
    const outsideDowngraded = checksFromManifest(downgraded).find((c) => c.id === 'outside-bind-unreadable')
    cases.push(outcome('pairing-gate-rejects-an-unproven-positive-control',
      outsideDowngraded?.verdict === 'fail',
      `outside-bind-unreadable verdict=${outsideDowngraded?.verdict}`))
  }

  // ── the reaping check's own branches, driven by fake host process lists ──────
  // Exercised on every platform, because the failure branches are the point: a
  // reaping check that cannot fail is not a check. The marker is injected so each
  // fake list can actually contain (or omit) the process under test; a real run
  // uses a fresh uuid instead.
  const fakeSandbox = { env: {}, launcher: { file: '/bin/false', before: [] } }
  const reaped = { exitCode: 143, cancelled: false, timedOut: true, signal: 'SIGTERM' }
  const marker = 'agos-linux-reap-selfcheck'
  const fast = { startupDeadlineMs: 150, reapDeadlineMs: 150, watchdogMs: 600 }

  for (const scenario of [
    {
      id: 'reaping-check-passes-when-the-marker-appears-then-disappears',
      // Alive on the first poll, gone on the next: the shape a working reap has.
      list: (() => { let n = 0; return async () => (++n <= 1 ? [`4242 ${marker} sleep 45`] : []) })(),
      execCommand: async () => reaped,
      want: (r) => r.verdict === 'pass' && r.positiveControlSatisfied === true,
    },
    {
      id: 'reaping-check-passes-in-abort-mode-after-the-marker-appears-then-disappears',
      mode: 'abort',
      list: (() => { let n = 0; return async () => (++n <= 1 ? [`4242 ${marker} sleep 45`] : []) })(),
      execCommand: async () => ({ ...reaped, cancelled: true }),
      want: (r) => r.verdict === 'pass' && r.mode === 'abort' && r.positiveControlSatisfied === true,
    },
    {
      id: 'reaping-check-rejects-a-launcher-that-only-contains-the-marker',
      list: async () => [`4242 /usr/bin/bwrap -- /bin/bash -c ( exec -a ${marker} sleep 45 ) & wait`],
      execCommand: async () => reaped,
      want: (r) => r.verdict === 'fail' && r.positiveControlSatisfied === false
        && /POSITIVE CONTROL FAILED/.test(r.evidence),
    },
    {
      id: 'reaping-check-rejects-timeout-without-a-timeout-event',
      list: (() => { let n = 0; return async () => (++n <= 1 ? [`4242 ${marker} sleep 45`] : []) })(),
      execCommand: async () => ({ exitCode: 143, cancelled: false, timedOut: false, signal: 'SIGTERM' }),
      want: (r) => r.verdict === 'fail' && /timedOut=true/.test(r.evidence),
    },
    {
      id: 'reaping-check-rejects-abort-without-cancel-event',
      mode: 'abort',
      list: (() => { let n = 0; return async () => (++n <= 1 ? [`4242 ${marker} sleep 45`] : []) })(),
      execCommand: async () => ({ exitCode: 143, cancelled: false, timedOut: false, signal: 'SIGTERM' }),
      want: (r) => r.verdict === 'fail' && /cancelled=true/.test(r.evidence),
    },
    {
      id: 'reaping-check-fails-when-its-positive-control-never-fires',
      // The grandchild never starts, so "the marker is absent" is vacuously true.
      list: async () => ['1 /sbin/init'],
      execCommand: async () => reaped,
      want: (r) => r.verdict === 'fail' && r.positiveControlSatisfied === false
        && /POSITIVE CONTROL FAILED/.test(r.evidence),
    },
    {
      id: 'reaping-check-fails-when-the-grandchild-survives',
      list: async () => [`4242 ${marker} sleep 45`],
      execCommand: async () => reaped,
      want: (r) => r.verdict === 'fail' && r.positiveControlSatisfied === true && /survived/.test(r.evidence),
    },
    {
      id: 'reaping-check-fails-when-a-killed-command-reports-success',
      list: (() => { let n = 0; return async () => (++n <= 1 ? [`4242 ${marker} sleep 45`] : []) })(),
      execCommand: async () => ({ exitCode: 0, cancelled: false, signal: null }),
      want: (r) => r.verdict === 'fail' && /must never look successful/.test(r.evidence),
    },
    {
      id: 'reaping-check-fails-when-execCommand-never-settles',
      // A survivor holds the stdio pipe open, so the promise hangs forever.
      list: async () => [`4242 ${marker} sleep 45`],
      execCommand: () => new Promise(() => {}),
      want: (r) => r.verdict === 'fail' && /never settled/.test(r.evidence),
    },
    {
      id: 'reaping-check-refuses-an-unsafe-marker',
      list: async () => [],
      execCommand: async () => reaped,
      marker: 'evil; rm -rf /',
      want: (r) => r.verdict === 'fail' && /refusing to build a command from marker/.test(r.evidence),
    },
  ]) {
    const observed = await checkProcessGroupReaping({
      sandbox: fakeSandbox,
      evaluator,
      marker: scenario.marker ?? marker,
      mode: scenario.mode,
      list: scenario.list,
      execCommand: scenario.execCommand,
      ...fast,
    })
    cases.push(outcome(scenario.id, scenario.want(observed) === true,
      `${observed.verdict}: ${String(observed.evidence).slice(0, 180)}`))
  }

  const counts = { pass: cases.filter((c) => c.ok).length, fail: cases.filter((c) => !c.ok).length, skip: 0, blocked: 0 }
  return {
    kind: 'entry-self-check',
    isRuntimeEvidence: false,
    label: 'ENTRY SELF-CHECK on synthetic stubs. Proves the entry refuses a broken sandbox and that its '
      + 'pairing and positive-control gates can fail. NOT evidence that any kernel isolated anything, and '
      + 'never to be merged into the runtime counts above.',
    counts,
    cases,
  }
}
