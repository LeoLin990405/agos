/**
 * The six properties this layer must cover, and the assertion class each one
 * belongs to.
 *
 * THE THREE CLASSES, AND WHY THE DISTINCTION IS THE WHOLE POINT
 *
 *   runtime-evidence
 *     Only obtainable on a real Linux host with a working bubblewrap. A kernel
 *     actually refused something, and the refusal was observed.
 *
 *   decision-logic
 *     A branch of the planner or launcher builder, driven by an injected probe.
 *     Runs anywhere, including macOS. It proves the code decides correctly; it
 *     proves NOTHING about whether a kernel enforces anything.
 *
 *   vacuous-without-positive-control
 *     The trap. "The sandbox could not read file X" is TRIVIALLY TRUE whenever X
 *     was never bound into the sandbox — and equally true on a host with no
 *     sandbox at all that simply never had X in scope. Such an assertion goes
 *     green in an environment with zero isolation, so on its own it is worthless.
 *     Every check in this class MUST declare `pairedWith`, naming the positive
 *     control that makes it discriminating, and this module REFUSES to report it
 *     as covered unless that positive control is present and passing. The pairing
 *     used here: the in-scope and out-of-scope sentinels are sibling files under
 *     one mkdtemp root, and only the in-scope one is in the bind list, so bind
 *     membership is the only difference between them.
 *
 * Nothing in this file re-implements the sandbox. Items 1-4 read the manifest that
 * the production `linuxVerificationSandbox` smoke produced; item 5 drives the
 * production `execCommand` through the production launcher; item 6 drives the
 * production planner. If the product's boundary breaks, these checks break with it.
 */
import { randomUUID } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'

export const ASSERTION_CLASS = Object.freeze({
  runtime: 'runtime-evidence',
  decision: 'decision-logic',
  vacuous: 'vacuous-without-positive-control',
})

export const VERDICT = Object.freeze({
  pass: 'pass',
  fail: 'fail',
  blocked: 'blocked',
  skipped: 'skipped',
})

/**
 * The required coverage list from the task, pinned in code so a missing item is a
 * structural failure rather than a line nobody noticed was gone.
 * `manifestChecks` names the production manifest entries that carry the evidence.
 */
export const REQUIRED_COVERAGE = Object.freeze([
  {
    id: 'scratch-writable',
    requirement: '1. the scratch directory is writable inside the sandbox',
    assertionClass: ASSERTION_CLASS.runtime,
    manifestChecks: ['scratch-writable'],
  },
  {
    id: 'declared-readonly-bind',
    requirement: '2. a declared read-only bind is readable, and writes to it are refused',
    assertionClass: ASSERTION_CLASS.runtime,
    manifestChecks: ['bound-bind-readable', 'bound-bind-read-only', 'bound-roots-read-only'],
    note: 'the readable half is a genuine positive control: the sentinel is read back and its bytes compared, '
      + 'so an empty placeholder created while bubblewrap built intermediate directories cannot satisfy it. '
      + 'The write half is refused by the read-only mount and not by permissions, because the file is mode '
      + '0600 owned by the invoking uid, which bubblewrap maps to itself',
  },
  {
    id: 'outside-bind-unreadable',
    requirement: '3. a hand-made file OUTSIDE every bind is unreadable',
    assertionClass: ASSERTION_CLASS.vacuous,
    manifestChecks: ['outside-rootfs-unreadable'],
    pairedWith: 'bound-bind-readable',
    note: 'on its own this passes on a host with no sandbox whatsoever, so it is reported as covered ONLY '
      + 'when its paired positive control passed in the same smoke run',
  },
  {
    id: 'network-egress-denied',
    requirement: '4. the sandbox cannot reach a loopback listener the test started on the host',
    assertionClass: ASSERTION_CLASS.runtime,
    manifestChecks: ['network-egress-denied'],
    note: 'discriminating without a pairing of its own: the listener is live and the host CAN reach it, '
      + 'so an unreachable socket is a real network namespace and not an absent server',
  },
  {
    id: 'process-group-reaped',
    requirement: '5. on timeout and on cancellation the test subprocess is reaped',
    assertionClass: ASSERTION_CLASS.runtime,
    manifestChecks: ['process-group-cleanup'],
    note: 'the production manifest marks this unproven at sandbox-build time; this entry runs it for real '
      + 'and carries its own positive control that the marked grandchild started',
  },
  {
    id: 'verification-unavailable-when-degraded',
    requirement: '6. an insufficient host is refused as verification-unavailable, never degraded',
    assertionClass: ASSERTION_CLASS.decision,
    note: 'inherently decision logic: proving it needs a host MISSING a capability, and degrading a real '
      + 'host to manufacture that is exactly the kind of environment surgery this round forbids. Driven by '
      + 'injected capability probes instead, and therefore NOT runtime evidence',
  },
])

const result = (item, verdict, evidence, extra = {}) => ({
  id: item.id,
  requirement: item.requirement,
  assertionClass: item.assertionClass,
  ...(item.pairedWith ? { pairedWith: item.pairedWith } : {}),
  ...(item.note ? { note: item.note } : {}),
  verdict,
  evidence,
  ...extra,
})

/**
 * Read items 1-4 out of the manifest produced by the production smoke.
 * A manifest entry that is absent is NOT treated as "fine": an absent check means
 * the smoke no longer probes that property, which is indistinguishable from the
 * property no longer holding, so it fails.
 */
export function checksFromManifest(sandbox) {
  const manifest = sandbox?.isolation?.checks || []
  const byName = new Map(manifest.map((c) => [c.name, c]))
  const out = []
  for (const item of REQUIRED_COVERAGE) {
    if (item.id === 'process-group-reaped' || item.assertionClass === ASSERTION_CLASS.decision) continue
    const found = (item.manifestChecks || []).map((name) => [name, byName.get(name) || null])
    const absent = found.filter(([, check]) => check === null).map(([name]) => name)
    if (absent.length) {
      out.push(result(item, VERDICT.fail,
        `the production isolation manifest does not declare ${absent.join(', ')}, so this property is no longer probed at all; `
        + `an unprobed property cannot be reported as covered. Manifest declared: ${[...byName.keys()].join(', ') || 'nothing'}`))
      continue
    }
    const notVerified = found.filter(([, check]) => check.status !== 'verified')
    if (notVerified.length) {
      out.push(result(item, VERDICT.fail, notVerified
        .map(([name, check]) => `${name}: status=${check.status} — ${check.evidence}`).join(' | ')))
      continue
    }
    // The pairing gate. An out-of-scope "unreadable" claim is reported as covered
    // only when the in-scope twin was actually read in the same smoke run.
    if (item.pairedWith) {
      const control = byName.get(item.pairedWith)
      if (!control || control.status !== 'verified') {
        out.push(result(item, VERDICT.fail,
          `paired positive control ${item.pairedWith} is ${control ? `status=${control.status}` : 'absent from the manifest'}; `
          + 'without it, "the sandbox could not read the out-of-scope sentinel" is vacuously true and would also pass '
          + 'with no sandbox at all, so it must not be counted as isolation evidence',
          { pairedControlSatisfied: false }))
        continue
      }
      out.push(result(item, VERDICT.pass,
        found.map(([name, check]) => `${name}: ${check.evidence}`).join(' | '),
        { pairedControlSatisfied: true, pairedControlEvidence: control.evidence }))
      continue
    }
    out.push(result(item, VERDICT.pass, found.map(([name, check]) => `${name}: ${check.evidence}`).join(' | ')))
  }
  return out
}

/** Host-side view of every process command line. Crosses PID namespaces on purpose. */
export async function listProcessCommandlines() {
  const entries = await readdir('/proc').catch(() => [])
  const lines = []
  for (const name of entries) {
    if (!/^\d+$/.test(name)) continue
    const raw = await readFile(`/proc/${name}/cmdline`).catch(() => null)
    if (raw && raw.length) {
      // Keep the kernel-provided argv boundaries. Joining cmdline before matching
      // would make an argument containing the marker indistinguishable from argv[0].
      const argv = raw.toString('utf8').split('\0').filter((arg, index, all) => index < all.length - 1 || arg)
      lines.push({ pid: Number(name), argv, argv0: argv[0] || '', line: `${name} ${argv.join(' ')}` })
    }
  }
  return lines
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * `/proc/<pid>/cmdline` is NUL-separated argv. Real observations arrive as
 * structured records, so argv[0] is compared without any whitespace parsing.
 * String records remain a deliberately narrow fixture compatibility path for
 * injected tests; they require the marker immediately after the PID.
 */
function markerIdentity(line, marker) {
  if (line && typeof line === 'object') {
    if (!Number.isInteger(line.pid) || line.argv0 !== marker) return null
    return { pid: line.pid, argv0: line.argv0, line: line.line || `${line.pid} ${line.argv0}` }
  }
  const match = /^(\d+)\s+(\S+)(?:\s|$)/.exec(String(line))
  if (!match || match[2] !== marker) return null
  return { pid: Number(match[1]), argv0: match[2], line: String(line) }
}

async function pollFor(list, marker, { present, deadlineMs, intervalMs = 50 }) {
  const deadline = Date.now() + deadlineMs
  let last = []
  let identities = []
  do {
    last = await list()
    identities = last.map((line) => markerIdentity(line, marker)).filter(Boolean)
    if ((identities.length > 0) === present) {
      return { ok: true, matched: identities.map((i) => i.line), identities }
    }
    await wait(intervalMs)
  } while (Date.now() < deadline)
  identities = last.map((line) => markerIdentity(line, marker)).filter(Boolean)
  return { ok: false, matched: identities.map((i) => i.line), identities }
}

/**
 * Item 5, for real. A grandchild is started inside the sandbox with a unique marker
 * as its argv[0], then the run is ended by timeout or by abort, and the host is
 * asked whether the marked process is gone.
 *
 * The marker is read from the HOST's /proc on purpose: `--unshare-all` gives the
 * sandbox its own PID namespace, so a pid captured inside it (`$!`) is
 * namespace-local and means a different process — or nothing — on the host. A
 * namespace-local pid is therefore not usable as reaping evidence.
 *
 * POSITIVE CONTROL: the marked process must be OBSERVED ALIVE before the kill.
 * Without that, "the marker is absent afterwards" is satisfied by a grandchild that
 * never started, which is the same vacuous-assertion trap as class 3.
 */
export async function checkProcessGroupReaping({
  execCommand,
  sandbox,
  evaluator,
  mode = 'timeout',
  list = listProcessCommandlines,
  // Injectable so the entry self-check can drive the failure branches with a marker
  // its fake process lists can actually contain. Real runs always use a fresh uuid.
  marker = `agos-linux-reap-${randomUUID()}`,
  startupDeadlineMs = 8000,
  reapDeadlineMs = 8000,
  watchdogMs = 25000,
  timeoutMs = 1500,
} = {}) {
  const item = REQUIRED_COVERAGE.find((c) => c.id === 'process-group-reaped')
  // The marker is interpolated into a shell command, so it is constrained to a
  // character set that cannot carry quoting or metacharacters.
  if (!/^[a-z0-9-]+$/.test(marker)) return result(item, VERDICT.fail, `refusing to build a command from marker ${marker}`)
  // `exec -a` renames argv[0] so the host can find this specific process and no
  // other. `sleep 45` is short enough that a regression cannot strand it for long.
  const command = `( exec -a ${marker} sleep 45 ) & wait`
  const controller = mode === 'abort' ? new AbortController() : null
  const running = execCommand(command, {
    cwd: evaluator,
    env: sandbox.env,
    sandboxLauncher: sandbox.launcher,
    signal: controller?.signal,
    timeoutMs: mode === 'abort' ? watchdogMs : timeoutMs,
  })

  const started = await pollFor(list, marker, { present: true, deadlineMs: startupDeadlineMs })
  if (!started.ok) {
    controller?.abort()
    await Promise.race([running, wait(watchdogMs)])
    return result(item, VERDICT.fail,
      `POSITIVE CONTROL FAILED (mode=${mode}): the marked grandchild ${marker} never appeared in the host /proc within `
      + `${startupDeadlineMs}ms, so a later absence would be vacuously true and prove nothing about reaping`,
      { mode, marker, positiveControlSatisfied: false, observed: [] })
  }
  if (mode === 'abort') controller.abort()

  // A surviving grandchild holds the inherited stdio pipe open, so the promise would
  // never settle; bound the wait instead of hanging on it.
  const settled = await Promise.race([running, wait(watchdogMs).then(() => 'watchdog')])
  if (settled === 'watchdog') {
    return result(item, VERDICT.fail,
      `mode=${mode}: execCommand never settled within ${watchdogMs}ms, which means the process group was not reaped and `
      + 'the inherited stdio pipe is still held open by a survivor',
      { mode, marker, positiveControlSatisfied: true })
  }
  if (settled.exitCode === 0) {
    return result(item, VERDICT.fail,
      `mode=${mode}: a ${mode === 'abort' ? 'cancelled' : 'timed-out'} command reported exitCode 0; it must never look successful`,
      { mode, marker, positiveControlSatisfied: true, exitCode: settled.exitCode })
  }

  const endedAsExpected = mode === 'abort' ? settled.cancelled === true : settled.timedOut === true
  if (!endedAsExpected) {
    const expected = mode === 'abort' ? 'cancelled=true' : 'timedOut=true'
    return result(item, VERDICT.fail,
      `mode=${mode}: execCommand ended without the required ${expected} event; a nonzero exit code alone is not evidence of ${mode}`,
      { mode, marker, positiveControlSatisfied: true, exitCode: settled.exitCode,
        cancelled: settled.cancelled === true, timedOut: settled.timedOut === true })
  }

  const gone = await pollFor(list, marker, { present: false, deadlineMs: reapDeadlineMs })
  if (!gone.ok) {
    return result(item, VERDICT.fail,
      `mode=${mode}: the marked grandchild survived ${reapDeadlineMs}ms after the kill: ${gone.matched.join(' ; ')}`,
      { mode, marker, positiveControlSatisfied: true, survivors: gone.matched,
        survivorPids: gone.identities.map((identity) => identity.pid),
        observedPids: started.identities.map((identity) => identity.pid) })
  }
  return result(item, VERDICT.pass,
    `mode=${mode}: grandchild ${marker} was observed alive in the host /proc (PID(s) ${started.identities.map((identity) => identity.pid).join(', ')}; `
    + `positive control: ${started.matched.join(' ; ')}), `
    + `execCommand settled with exitCode=${settled.exitCode} cancelled=${settled.cancelled} signal=${settled.signal}, `
    + 'and the marker was gone from the host /proc afterwards',
    { mode, marker, positiveControlSatisfied: true, exitCode: settled.exitCode, cancelled: settled.cancelled,
      timedOut: settled.timedOut === true,
      observedPids: started.identities.map((identity) => identity.pid) })
}

/**
 * Item 6. DECISION LOGIC, and labelled as such: each case hands the production
 * `verificationSandbox` a fake capability probe that is missing exactly one thing,
 * and demands a `verification-unavailable` refusal that names it. This is the only
 * honest way to cover the requirement without degrading a real host.
 */
export async function checkDegradedRefusal({ verificationSandbox, makeProbe, evaluator, cases }) {
  const item = REQUIRED_COVERAGE.find((c) => c.id === 'verification-unavailable-when-degraded')
  const observed = []
  for (const scenario of cases) {
    const sandbox = await verificationSandbox(evaluator, { platform: 'linux', probe: makeProbe(scenario.probe) })
    const refused = sandbox.ok === false
      && /^verification-unavailable: /.test(String(sandbox.reason || ''))
      && scenario.expect.test(String(sandbox.reason || ''))
      && sandbox.launcher === undefined
    observed.push({
      scenario: scenario.id,
      refused,
      reason: sandbox.ok ? '(accepted the host)' : sandbox.reason,
      handedBackLauncher: sandbox.launcher !== undefined,
    })
  }
  const failures = observed.filter((o) => !o.refused)
  return result(item, failures.length ? VERDICT.fail : VERDICT.pass,
    failures.length
      ? `these degraded hosts were not refused with a matching verification-unavailable reason: ${JSON.stringify(failures)}`
      : `${observed.length} degraded hosts each refused as verification-unavailable with a reason naming the missing capability, `
        + `and none handed back a launcher: ${observed.map((o) => `${o.scenario} -> ${o.reason}`).join(' | ')}`,
    { cases: observed })
}

/** Every required item as `blocked`, with the same reason, for a host that cannot run any of it. */
export function allBlocked(reason, { except = [] } = {}) {
  return REQUIRED_COVERAGE.filter((item) => !except.includes(item.id))
    .map((item) => result(item, VERDICT.blocked, reason))
}

export function countVerdicts(checks) {
  const counts = { pass: 0, fail: 0, skip: 0, blocked: 0 }
  for (const check of checks) {
    if (check.verdict === VERDICT.pass) counts.pass += 1
    else if (check.verdict === VERDICT.fail) counts.fail += 1
    else if (check.verdict === VERDICT.blocked) counts.blocked += 1
    else counts.skip += 1
  }
  return counts
}

/**
 * Roll the per-check verdicts up to a layer verdict. `blocked` NEVER merges into
 * `pass`: a host that could not run the runtime checks has not verified anything,
 * and the whole value of this field is that it stays distinguishable.
 */
export function rollUpVerdict(checks) {
  if (checks.some((c) => c.verdict === VERDICT.fail)) return VERDICT.fail
  if (checks.some((c) => c.verdict === VERDICT.blocked)) return VERDICT.blocked
  if (checks.length === 0) return VERDICT.blocked
  return VERDICT.pass
}
