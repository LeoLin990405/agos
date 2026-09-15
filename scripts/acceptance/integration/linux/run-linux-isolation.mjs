#!/usr/bin/env node
/**
 * Linux isolation (bubblewrap) verification entry — integration layer `linux`.
 *
 * WHAT THIS IS
 *   A runnable entry that reuses the PRODUCTION sandbox (`linuxVerificationSandbox`
 *   in plugins/cn-capabilities/lib/autoresearch-sandbox.mjs), exercises the six
 *   properties the boundary must hold, and writes a machine-readable verdict to
 *   <logdir>/linux.json following the round-4 integration-layer contract.
 *
 * WHAT THIS IS NOT
 *   A second sandbox implementation. It builds no argv of its own and probes no
 *   capability the product does not probe; it imports the product's module and
 *   records that module's sha256 as provenance. A parallel implementation could
 *   pass while the shipped one fails, which is the one failure mode a verification
 *   entry must not have.
 *
 * ON A HOST WITH NO LINUX KERNEL
 *   It reports verdict "blocked" with a `blockedReason` naming every missing
 *   capability and what was probed for it, plus a `recoveryCommand` that can be
 *   pasted on a real Linux host. It does not crash, and it never reports a pass.
 *   `blocked` is a distinct verdict on purpose: it must never be summed into an
 *   "integration passed" conclusion.
 *
 * THREE ASSERTION CLASSES
 *   Every check carries `assertionClass`, and `countsByAssertionClass` in the result
 *   makes the split unmissable. See lib/runtime-checks.mjs for why the third class
 *   ("this file was unreadable" — trivially true when the path was never bound)
 *   needs a paired positive control before it counts as evidence at all.
 *
 * ENVIRONMENT DISCIPLINE
 *   Inherited HOME and CODEX_HOME are left exactly as they are — not overwritten,
 *   and not explicitly reset to their own values either. Isolation comes from
 *   mkdtemp plus the sandbox's own explicit env, never from editing this process's.
 *
 * USAGE
 *   node scripts/acceptance/integration/linux/run-linux-isolation.mjs [options]
 *     --logdir <dir>     where to write linux.json and the logs (default: a mkdtemp)
 *     --self-check-only  run only the entry self-check, skip host probing
 *     --strict-blocked   exit 2 instead of 0 when the verdict is blocked
 *     --quiet            do not echo the transcript to stdout
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'

import { blockedReasonFrom, buildCapabilityReport, recoveryCommandFor } from './lib/capability-report.mjs'
import { runEntrySelfCheck } from './lib/entry-self-check.mjs'
import { gitFacts, isoNow, loadProductionSandbox, repoRoot, sha256File, worktreeDigest } from './lib/evidence.mjs'
import {
  ASSERTION_CLASS,
  REQUIRED_COVERAGE,
  VERDICT,
  allBlocked,
  checkDegradedRefusal,
  checkProcessGroupReaping,
  checksFromManifest,
  countVerdicts,
  rollUpVerdict,
} from './lib/runtime-checks.mjs'

const SCHEMA = 'agos-acceptance/integration-layer@1'
const LAYER = 'linux'
const ENTRY_REL = 'scripts/acceptance/integration/linux/run-linux-isolation.mjs'

// Both `--logdir X` and `--logdir=X` are accepted, because this repository's other
// entries take the second form exclusively: `run-acceptance.mjs --json= --logdir=`,
// the matrix's `--require= --layer-producer=`, `measure-dependency-surface.mjs --out=`.
// This entry originally took only the space form, and the controller —— its first
// caller —— crashed it on the first invocation by typing the house style. It refused
// loudly rather than silently misbehaving, which is the right failure, but an entry
// that rejects the convention every other entry uses is a trap regardless.
// Unknown arguments still throw: the point is to accept the house style, not to
// start ignoring things.
function parseArgs(argv) {
  const options = { logdir: null, selfCheckOnly: false, strictBlocked: false, quiet: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const eq = arg.indexOf('=')
    const name = eq > 0 ? arg.slice(0, eq) : arg
    const inlineValue = eq > 0 ? arg.slice(eq + 1) : null

    if (name === '--logdir') {
      const value = inlineValue ?? argv[++i]
      // `--logdir` with nothing after it must not leave logdir null and carry on:
      // the run would produce no evidence file while still reporting a verdict.
      if (value === undefined || value === '') throw new Error('--logdir requires a path')
      options.logdir = value
    } else if (name === '--self-check-only') options.selfCheckOnly = true
    else if (name === '--strict-blocked') options.strictBlocked = true
    else if (name === '--quiet') options.quiet = true
    else if (name === '--help' || name === '-h') options.help = true
    else throw new Error(`unknown argument: ${arg}`)
  }
  return options
}

/** Transcript collector: everything printed is also saved, so the log is the run. */
function transcript(quiet) {
  const lines = []
  return {
    lines,
    log(...parts) {
      const line = parts.join(' ')
      lines.push(line)
      if (!quiet) console.log(line)
    },
    text: () => `${lines.join('\n')}\n`,
  }
}

/** The counts that matter: how much of each assertion class actually landed. */
function countsByAssertionClass(checks) {
  const out = {}
  for (const cls of Object.values(ASSERTION_CLASS)) out[cls] = { pass: 0, fail: 0, skip: 0, blocked: 0 }
  for (const check of checks) {
    const bucket = out[check.assertionClass]
    if (!bucket) continue
    if (check.verdict === VERDICT.pass) bucket.pass += 1
    else if (check.verdict === VERDICT.fail) bucket.fail += 1
    else if (check.verdict === VERDICT.blocked) bucket.blocked += 1
    else bucket.skip += 1
  }
  return out
}

/** Degraded-host scenarios for coverage item 6. Injected probes, never a real host. */
const DEGRADED_CASES = (SMOKE_EXIT, stubProbe) => [
  { id: 'no-bwrap-on-path', probe: { binaries: {} }, expect: /requires bubblewrap \(bwrap\)/ },
  { id: 'unshare-only-host', probe: { binaries: { unshare: '/usr/bin/unshare' } }, expect: /linux-unshare backend is disabled/ },
  { id: 'userns-capped-to-zero', probe: { files: { ...stubProbe.CAPABLE_FILES, '/proc/sys/user/max_user_namespaces': '0' } }, expect: /user\.max_user_namespaces=0/ },
  { id: 'smoke-positive-control-failed', probe: { smokeExit: SMOKE_EXIT.boundBindUnreadable }, expect: /in-scope positive control failed/ },
]

async function main() {
  const startedAt = isoNow()
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    console.log(await import('node:fs').then((fs) => fs.readFileSync(new URL(import.meta.url), 'utf8')
      .split('\n').filter((l) => l.startsWith(' *') || l.startsWith('/**')).join('\n')))
    return 0
  }
  const out = transcript(options.quiet)
  const root = repoRoot()
  const logdir = options.logdir ? options.logdir : await mkdtemp(join(tmpdir(), 'agos-linux-layer-logs-'))
  await mkdir(logdir, { recursive: true })

  out.log(`# AgOS integration layer: ${LAYER}`)
  out.log(`# started ${startedAt}`)
  out.log(`# repo ${root}`)
  out.log(`# logdir ${logdir}`)
  out.log('')

  const { sandbox: lib, workspace, provenance } = await loadProductionSandbox(root)
  out.log('## production modules reused (no parallel sandbox implementation)')
  for (const entry of provenance) out.log(`  ${entry.specifier}  sha256=${entry.sha256}  ${entry.bytes} bytes`)
  out.log('')

  const selfCheckModule = await import('./lib/entry-self-check.mjs')
  const evaluatorRoot = await mkdtemp(join(tmpdir(), 'agos-linux-layer-eval-'))
  let checks = []
  let capability = null
  let selfCheck = null

  try {
    // ── capability report ────────────────────────────────────────────────────
    capability = await buildCapabilityReport(lib)
    out.log('## capability report (this host, probed now)')
    out.log(`  platform: ${capability.platform.os} ${capability.platform.release} ${capability.platform.arch}, node ${capability.platform.node}`)
    out.log(`  uid: ${capability.uid}`)
    for (const row of capability.capabilities) {
      // `n/a` and `MISS` are different facts: not probed here versus probed and absent.
      out.log(`  [${row.present ? 'ok  ' : (row.probed ? 'MISS' : 'n/a ')}] ${row.id}: ${row.label}`)
      out.log(`         ${row.observed}`)
    }
    out.log(`  probe set for this platform: ${capability.backend.chosenProbeSet ?? 'none'}`)
    out.log(`  backend selected by the production planner: ${capability.backend.selected ?? 'none'}`)
    if (capability.backend.selectionReason) out.log(`  planner refusal: ${capability.backend.selectionReason}`)
    out.log('')

    // ── runtime checks ───────────────────────────────────────────────────────
    const runnable = process.platform === 'linux' && capability.selection.ok
    if (options.selfCheckOnly) {
      out.log('## runtime checks SKIPPED (--self-check-only)')
      checks = allBlocked('skipped by --self-check-only; this run makes no claim about any host capability')
    } else if (!runnable) {
      const reason = blockedReasonFrom(capability)
      out.log('## runtime checks BLOCKED')
      out.log(`  ${reason}`)
      out.log('')
      // Per-check evidence points at the layer-level blockedReason rather than
      // repeating it: the same paragraph six times buries the per-check verdicts.
      const short = `blocked on ${process.platform}: missing ${capability.missing.join(', ')}`
        + ' — see the layer blockedReason for what was probed for each'
      // Item 6 is decision logic and CAN run here; the rest genuinely cannot. Saying
      // so per item, instead of blanket-blocking, keeps the report honest in both
      // directions: no fake coverage, and no pretending a runnable branch is stuck.
      checks = allBlocked(short, { except: ['verification-unavailable-when-degraded'] })
      checks.push(await checkDegradedRefusal({
        verificationSandbox: workspace.verificationSandbox,
        makeProbe: (overrides) => selfCheckModule.stubProbe(overrides),
        evaluator: evaluatorRoot,
        cases: DEGRADED_CASES(lib.SMOKE_EXIT, selfCheckModule),
      }))
    } else {
      out.log('## runtime checks (real bubblewrap on a real linux kernel)')
      const sandbox = await workspace.verificationSandbox(evaluatorRoot)
      if (!sandbox.ok) {
        // Capabilities were present but the boundary failed its own smoke. That is a
        // FAILURE, not a blocked environment: the host could build a sandbox and the
        // sandbox did not hold.
        out.log(`  the production sandbox refused itself: ${sandbox.reason}`)
        checks = REQUIRED_COVERAGE.map((item) => ({
          id: item.id,
          requirement: item.requirement,
          assertionClass: item.assertionClass,
          verdict: item.id === 'verification-unavailable-when-degraded' ? VERDICT.pass : VERDICT.fail,
          evidence: `linuxVerificationSandbox refused to hand back a boundary on a host whose capabilities passed: ${sandbox.reason}`,
        }))
      } else {
        out.log(`  backend: ${sandbox.kind}, launcher: ${sandbox.launcher.file}`)
        out.log(`  read scope (${sandbox.isolation.readScope.kind}): ${sandbox.isolation.readScope.paths.join(', ')}`)
        out.log(`  write scope: ${sandbox.isolation.writeScope.paths.join(', ')}`)
        checks = checksFromManifest(sandbox)
        for (const mode of ['timeout', 'abort']) {
          const reap = await checkProcessGroupReaping({
            execCommand: workspace.execCommand,
            sandbox,
            evaluator: sandbox.scratch.replace(/\/\.agos-verification-tmp$/, ''),
            mode,
          })
          checks.push({ ...reap, id: `${reap.id}:${mode}` })
        }
        checks.push(await checkDegradedRefusal({
          verificationSandbox: workspace.verificationSandbox,
          makeProbe: (overrides) => selfCheckModule.stubProbe(overrides),
          evaluator: evaluatorRoot,
          cases: DEGRADED_CASES(lib.SMOKE_EXIT, selfCheckModule),
        }))
      }
    }
    for (const check of checks) {
      out.log(`  [${check.verdict.toUpperCase().padEnd(7)}] ${check.id}  (${check.assertionClass})`)
      out.log(`            ${check.requirement}`)
      out.log(`            ${check.evidence}`)
    }
    out.log('')

    // ── entry self-check ─────────────────────────────────────────────────────
    selfCheck = await runEntrySelfCheck({
      lib,
      verificationSandbox: workspace.verificationSandbox,
      evaluator: evaluatorRoot,
      checksFromManifest,
      checkProcessGroupReaping,
    })
    out.log('## entry self-check (SYNTHETIC STUBS — NOT runtime evidence)')
    out.log(`  ${selfCheck.label}`)
    for (const c of selfCheck.cases) out.log(`  [${c.ok ? 'ok  ' : 'FAIL'}] ${c.id}: ${c.detail}`)
    out.log(`  self-check counts: ${JSON.stringify(selfCheck.counts)}`)
    out.log('')
  } finally {
    await rm(evaluatorRoot, { recursive: true, force: true })
  }

  // ── assemble the contract result ──────────────────────────────────────────
  const counts = countVerdicts(checks)
  const byClass = countsByAssertionClass(checks)
  const verdict = selfCheck.counts.fail > 0 ? VERDICT.fail : rollUpVerdict(checks)
  const blocked = verdict === VERDICT.blocked
  const git = await gitFacts(root)
  const digest = await worktreeDigest(root)
  const recovery = recoveryCommandFor(capability, { entryRelPath: ENTRY_REL })
  const exitCode = verdict === VERDICT.fail ? 1 : (blocked && options.strictBlocked ? 2 : 0)

  out.log(`## verdict: ${verdict}`)
  out.log(`  runtime counts: ${JSON.stringify(counts)}`)
  out.log(`  by assertion class: ${JSON.stringify(byClass)}`)
  out.log(`  exit code: ${exitCode}`)

  const capabilityMarkdown = renderCapabilityMarkdown({ capability, checks, selfCheck, git, startedAt })
  const capabilityPath = join(logdir, 'linux-capability-report.md')
  const consolePath = join(logdir, 'linux-console.log')
  await writeFile(capabilityPath, capabilityMarkdown)
  await writeFile(consolePath, out.text())

  const result = {
    schema: SCHEMA,
    layer: LAYER,
    verdict,
    sourceCommit: git.sourceCommit,
    branch: git.branch,
    worktreeDigest: digest.digest,
    worktreeDigestNote: `sha256 over the CURRENT WORKTREE bytes of ${digest.trackedFiles} tracked files`
      + ` (${digest.deletedTrackedFiles} tracked-but-deleted); dirty=${git.dirty}, so uncommitted edits move this value`,
    command: ['node', ENTRY_REL, ...process.argv.slice(2)],
    startedAt,
    endedAt: isoNow(),
    exitCode,
    platform: {
      os: process.platform,
      release: capability.platform.release,
      arch: process.arch,
      node: process.version,
      kernelVersion: capability.platform.kernelVersion,
    },
    moduleProvenance: provenance,
    counts,
    countsNote: `${counts.pass} of ${checks.length} required properties passed, of which`
      + ` ${byClass[ASSERTION_CLASS.runtime].pass} carry real runtime evidence.`
      + ' A pass in the decision-logic class means the code decided correctly on an injected probe;'
      + ' it is NOT evidence that a kernel enforced anything. Read countsByAssertionClass, not counts.pass.',
    countsByAssertionClass: byClass,
    assertionClassLegend: {
      [ASSERTION_CLASS.runtime]: 'a real kernel refused something and the refusal was observed; obtainable only on linux with a working bwrap',
      [ASSERTION_CLASS.decision]: 'a planner/builder branch driven by an injected probe; runs anywhere, proves the code decides correctly, proves nothing about enforcement',
      [ASSERTION_CLASS.vacuous]: 'trivially true when the path was never bound, so counted only when its paired positive control passed in the same run',
    },
    blockedReason: blocked ? blockedReasonFrom(capability) : null,
    // Contract shape: recoveryCommand is ONE flat argv. The prerequisites that must
    // hold before it can produce a conclusion are published separately rather than
    // nested into that field, where a consumer would have to re-parse them.
    recoveryCommand: recovery.command,
    recoverySteps: recovery.steps,
    capabilityReport: capability,
    checks,
    selfCheck,
    logs: await Promise.all([capabilityPath, consolePath].map(async (path) => {
      const rel = relative(root, path)
      return {
        path,
        // Only meaningful when the log actually lives under the repo; a caller that
        // points --logdir at /tmp would otherwise get a `../../../..` string that
        // reads like a repo path and is not one.
        repoRelativePath: rel.startsWith('..') ? null : rel,
        sha256: await sha256File(path),
      }
    })),
  }
  const resultPath = join(logdir, `${LAYER}.json`)
  await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`)
  // Printed even under --quiet: when --logdir was omitted the logdir is a mkdtemp,
  // so these lines are the only way a caller can find the artifacts it just produced.
  for (const path of [resultPath, capabilityPath, consolePath]) console.log(`wrote ${path}`)
  return exitCode
}

function renderCapabilityMarkdown({ capability, checks, selfCheck, git, startedAt }) {
  const state = (c) => (c.present ? 'present' : (c.probed ? '**MISSING**' : 'not probed'))
  const row = (c) => `| ${c.id} | ${state(c)} | ${c.observed.replace(/\|/g, '\\|')} |`
  const checkRow = (c) => `| ${c.id} | ${c.verdict} | ${c.assertionClass} | ${String(c.evidence).replace(/\|/g, '\\|').slice(0, 400)} |`
  return [
    `# Linux isolation capability report (${startedAt})`,
    '',
    `- host: \`${capability.platform.os} ${capability.platform.release} ${capability.platform.arch}\`, node \`${capability.platform.node}\``,
    `- kernel version string: ${capability.platform.kernelVersion ? `\`${capability.platform.kernelVersion}\`` : '_not readable (no /proc)_'}`,
    `- uid: ${capability.uid}`,
    `- commit: \`${git.sourceCommit}\` on \`${git.branch}\`, dirty=${git.dirty}`,
    `- probe set for this platform: \`${capability.backend.chosenProbeSet ?? 'none'}\``,
    `- backend selected: \`${capability.backend.selected ?? 'none'}\``,
    `- bubblewrap: ${capability.backend.bwrapPath ? `\`${capability.backend.bwrapPath}\` version \`${capability.backend.bwrapVersion}\`` : '_absent_'}`,
    '',
    '## Capabilities',
    '',
    '| capability | state | probed |',
    '|---|---|---|',
    ...capability.capabilities.map(row),
    '',
    '## Required coverage',
    '',
    '| check | verdict | assertion class | evidence |',
    '|---|---|---|---|',
    ...checks.map(checkRow),
    '',
    '## Entry self-check (synthetic stubs, NOT runtime evidence)',
    '',
    `${selfCheck.counts.pass} of ${selfCheck.cases.length} cases behaved as required.`,
    '',
    ...selfCheck.cases.map((c) => `- \`${c.ok ? 'ok' : 'FAIL'}\` ${c.id}`),
    '',
  ].join('\n')
}

main().then((code) => process.exit(code), (err) => {
  console.error(`linux isolation layer entry crashed: ${err?.stack || err}`)
  process.exit(1)
})
