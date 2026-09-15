/**
 * Linux isolation capability report.
 *
 * This module OBSERVES and NAMES; it never decides whether the boundary is
 * acceptable. The decision is `planLinuxIsolation` in the production module, and
 * this file calls it rather than reimplementing its gates — a second copy of the
 * gate logic could pass while the product's copy fails, which is the one failure
 * mode a verification entry must not have.
 *
 * When a capability is missing the report says WHICH one and WHAT WAS PROBED, so a
 * `blocked` verdict is actionable rather than a shrug.
 */

/** Capability rows, in the order a reader should check them on a new host. */
const CAPABILITY_ROWS = [
  {
    id: 'platform',
    label: 'platform is linux',
    read: (r) => r.report.platform,
    ok: (r) => r.report.platform === 'linux',
    detail: (r) => `process.platform=${r.report.platform}; kernel release=${r.details.kernelRelease}`,
  },
  {
    id: 'procfs',
    label: 'procfs mounted at /proc',
    read: (r) => r.report.proc,
    ok: (r) => r.report.proc === true,
    detail: (r) => `/proc/self/status ${r.report.proc ? 'readable' : 'absent'}`,
  },
  {
    id: 'kernel-version',
    label: 'kernel new enough for unprivileged user namespaces (>= 3.8)',
    linuxOnly: true,
    read: (r) => r.details.kernelRelease,
    // Unprivileged userns landed in 3.8; every supported distribution is far past it.
    ok: (r) => r.details.kernel.major === null || r.details.kernel.major > 3
      || (r.details.kernel.major === 3 && r.details.kernel.minor >= 8),
    detail: (r) => `${r.details.kernelRelease || 'unknown'}${r.details.kernelVersion ? ` (${r.details.kernelVersion})` : ''}`,
  },
  {
    id: 'namespaces',
    label: 'user/mount/network/pid namespaces present',
    linuxOnly: true,
    read: (r) => r.report.ns,
    ok: (r) => ['user', 'mnt', 'net', 'pid'].every((k) => r.report.ns?.[k] === true),
    detail: (r) => ['user', 'mnt', 'net', 'pid']
      .map((k) => `/proc/self/ns/${k}=${r.report.ns?.[k] ? 'present' : 'absent'}`).join(', '),
  },
  {
    id: 'unprivileged-userns',
    label: 'unprivileged user namespaces permitted',
    // An absent sysctl means "not configured", which is permissive ON LINUX. Off
    // Linux every sysctl is absent for a different reason — the file simply does not
    // exist — so treating absence as permissive there would report a capability this
    // host cannot possibly have. `linuxOnly` blocks that.
    linuxOnly: true,
    read: (r) => r.details.userns,
    // uid 0 already holds CAP_SYS_ADMIN, so the sysctl gates do not apply to it.
    // This mirrors planLinuxIsolation; the authoritative decision stays there.
    ok: (r) => r.report.uid === 0 || (r.details.userns.maxUserNamespaces !== 0
      && r.details.userns.unprivilegedUsernsClone !== 0
      && r.details.userns.apparmorRestrictUserns !== 1),
    detail: (r) => `uid=${r.report.uid}, user.max_user_namespaces=${fmt(r.details.userns.maxUserNamespaces)}`
      + `, kernel.unprivileged_userns_clone=${fmt(r.details.userns.unprivilegedUsernsClone)}`
      + `, kernel.apparmor_restrict_unprivileged_userns=${fmt(r.details.userns.apparmorRestrictUserns)}`
      + `, /proc/self/uid_map ${r.details.userns.uidMapReadable ? 'readable' : 'absent'}`,
  },
  {
    id: 'bubblewrap',
    label: 'bubblewrap (bwrap) on PATH',
    linuxOnly: true,
    read: (r) => r.details.bwrapPath,
    ok: (r) => Boolean(r.details.bwrapPath),
    detail: (r) => (r.details.bwrapPath
      ? `${r.details.bwrapPath}, version ${r.details.bwrapVersion || 'unreported'}`
      : `not on PATH${r.details.unsharePath ? `; unshare IS present at ${r.details.unsharePath} but the linux-unshare backend is removed and must not come back` : ''}`),
  },
  {
    id: 'mount-primitives',
    label: 'mount primitives for --proc/--dev and a tmpfs root',
    linuxOnly: true,
    read: (r) => r.details.mount,
    ok: (r) => r.details.mount.mntNamespace === true && r.details.mount.filesystems.tmpfs === true
      && r.details.mount.filesystems.proc === true,
    detail: (r) => `mount namespace=${r.details.mount.mntNamespace}`
      + `, /proc/self/mountinfo ${r.details.mount.mountinfoReadable ? 'readable' : 'absent'}`
      + `, /proc/filesystems tmpfs=${fmt(r.details.mount.filesystems.tmpfs)}`
      + ` proc=${fmt(r.details.mount.filesystems.proc)} devtmpfs=${fmt(r.details.mount.filesystems.devtmpfs)}`,
  },
  {
    id: 'readonly-roots',
    // Not linuxOnly: /usr genuinely exists on macOS too, and reporting that honestly
    // is more useful than blanking it. It is simply not sufficient on its own.
    label: '/usr present to bind read-only',
    read: (r) => r.report.roots,
    ok: (r) => (r.report.roots || []).includes('/usr'),
    detail: (r) => `bindable roots: ${(r.report.roots || []).join(', ') || 'none'}`,
  },
]

const fmt = (value) => (value === null || value === undefined ? 'not-configured' : String(value))

/**
 * Probe this host and produce the capability report plus the production planner's
 * verdict on it.
 * @param {object} lib the production autoresearch-sandbox module
 * @param {{ probe?: object, platform?: string, osRelease?: string }} [options]
 */
export async function buildCapabilityReport(lib, { probe = lib.systemProbe(), platform = process.platform, osRelease } = {}) {
  const report = await lib.probeLinuxIsolation(probe, { platform })
  const details = await lib.probeLinuxRuntimeDetails(probe, report, osRelease === undefined ? {} : { osRelease })
  const context = { report, details }
  const isLinux = platform === 'linux'
  const capabilities = CAPABILITY_ROWS.map((row) => {
    // A Linux-only row on a non-Linux host was NOT probed, so it cannot be reported
    // as present. The distinction matters: several of these gates read "an absent
    // sysctl is permissive", which is right on Linux and meaningless anywhere else.
    if (row.linuxOnly && !isLinux) {
      return {
        id: row.id,
        label: row.label,
        present: false,
        probed: false,
        observed: `not probed: this gate only has meaning on a linux kernel, and process.platform is ${platform}`
          + ` (raw reads on this host: ${row.detail(context)})`,
      }
    }
    return { id: row.id, label: row.label, present: row.ok(context) === true, probed: true, observed: row.detail(context) }
  })
  // The authoritative gate. `requireSmoke:false` asks only "could a boundary be
  // built here"; the smoke result is a separate, later question.
  const selection = lib.planLinuxIsolation(report, { requireSmoke: false })
  return {
    platform: {
      os: platform,
      release: details.kernelRelease,
      arch: process.arch,
      node: process.version,
      kernelVersion: details.kernelVersion,
    },
    uid: report.uid,
    capabilities,
    missing: capabilities.filter((c) => !c.present).map((c) => c.id),
    backend: {
      chosenProbeSet: lib.chooseIsolationBackend(platform),
      selected: selection.ok ? selection.backend : null,
      selectionReason: selection.ok ? null : selection.reason,
      bwrapPath: details.bwrapPath,
      bwrapVersion: details.bwrapVersion,
    },
    // Kept verbatim so a reader can re-derive every row above from raw facts.
    raw: { report: { ...report, smoke: report.smoke ?? null }, details },
    selection,
  }
}

/**
 * One sentence naming every missing capability and what was probed for it. This is
 * the `blockedReason` in the layer result, so it must be specific enough to act on.
 */
export function blockedReasonFrom(capabilityReport) {
  const missing = capabilityReport.capabilities.filter((c) => !c.present)
  const planner = capabilityReport.selection.ok
    ? 'the production planner accepted the host'
    : `production planner: ${capabilityReport.selection.reason}`
  if (missing.length === 0) return planner
  const named = missing.map((c) => `${c.id} (${c.label}) — probed: ${c.observed}`).join('; ')
  return `linux isolation runtime cannot be exercised on this host. Missing ${missing.length} of `
    + `${capabilityReport.capabilities.length} required capabilities: ${named}. ${planner}`
}

/**
 * What a reader should run to get the conclusion this host could not produce.
 *
 * `command` is a SINGLE flat argv, because that is what the layer contract's
 * `recoveryCommand` field is and what the matrix validator checks: one copyable
 * argv, not a command line to be re-parsed and not a list of lists. The
 * prerequisites that have to be true first live in `steps`, which the entry
 * publishes as its own field so nothing is lost.
 */
export function recoveryCommandFor(capabilityReport, { entryRelPath }) {
  const missing = new Set(capabilityReport.missing)
  const command = ['node', entryRelPath, '--logdir', './linux-layer-logs']
  if (missing.has('platform')) {
    // No Linux kernel here at all. Installing a VM or container runtime is a system
    // service install, which this round forbids, so the recovery is "run it on a
    // Linux host", not "make this host Linux".
    return {
      command,
      steps: [
        ['#', 'on', 'any', 'x86_64/aarch64', 'Linux', 'host', 'with', 'an', 'unprivileged-userns', 'kernel', '(>=3.8):'],
        ['sudo', 'apt-get', 'install', '-y', 'bubblewrap'],
        ['bwrap', '--version'],
        ['git', 'clone', '<this-repo>', 'agos'],
        ['git', '-C', 'agos', 'checkout', 'fix/cursor-integration-20260909'],
        command,
      ],
    }
  }
  if (missing.has('bubblewrap')) {
    return { command, steps: [['sudo', 'apt-get', 'install', '-y', 'bubblewrap'], ['bwrap', '--version'], command] }
  }
  if (missing.has('unprivileged-userns')) {
    return {
      command,
      steps: [
        ['#', 'unprivileged', 'user', 'namespaces', 'are', 'disabled', 'by', 'kernel', 'policy', 'on', 'this', 'host.'],
        ['#', 'Do', 'NOT', 'change', 'a', 'shared', 'or', 'production', 'host', 'to', 'satisfy', 'this', 'check.'],
        ['#', 'Use', 'a', 'host', 'that', 'already', 'permits', 'it,', 'or', 'a', 'setuid', 'bwrap', 'build:'],
        ['ls', '-l', String(capabilityReport.backend.bwrapPath || '/usr/bin/bwrap')],
        command,
      ],
    }
  }
  return { command, steps: [command] }
}
