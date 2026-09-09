/**
 * Reap what the host-integration harness left behind — and NOTHING else.
 *
 * The harness disposes itself on a normal or failed run, but a hard kill
 * (SIGKILL of the runner, a crashed debug session) can orphan a host process
 * and its temp root.
 *
 * ⚠️ What this script used to do, and why it was dangerous. It matched on the
 * global prefix `agos-host-integration`: every process whose argv mentioned the
 * marker was signalled, and every temp directory carrying the prefix was
 * deleted. That is a correct description of "a harness run" and an incorrect
 * description of "an ABANDONED harness run". Two suites in parallel — CI plus a
 * developer, or two shells — meant the first one to finish killed the other's
 * live host and deleted its DSH_HOME while it was mid-scenario, and the victim
 * failed with an unexplainable transport error.
 *
 * Ownership is now read out of each run's manifest instead of guessed from a
 * name (see run-registry.mjs):
 *
 * - a run whose creating process is STILL ALIVE is active, and is skipped and
 *   named in the report — never touched;
 * - a run is only reaped once its owner is provably gone;
 * - a recorded pid is only signalled after pid + kernel start-time + argv all
 *   still match what was recorded at spawn, re-checked before every signal, so
 *   a recycled pid belonging to an unrelated program is never killed;
 * - a directory with no manifest yet (a run that is starting up right now looks
 *   exactly like that) is left alone until it is provably stale.
 *
 * Run: node scripts/host-integration/cleanup.mjs [--dry-run] [--root <dir>]
 */
import { tmpdir } from 'node:os';
import { classifyRun, cleanupRuns, listRunDirs } from './run-registry.mjs';

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const rootArg = args.indexOf('--root')
const root = rootArg === -1 ? tmpdir() : args[rootArg + 1]

if (dryRun) {
  const runDirs = await listRunDirs({ root })
  for (const runDir of runDirs) {
    const verdict = await classifyRun(runDir)
    console.log(`${verdict.state.padEnd(10)} ${runDir}  (${verdict.reason})`)
  }
  console.log(`\ndry run: ${runDirs.length} harness run root(s) under ${root}`)
} else {
  const report = await cleanupRuns({ root })
  for (const entry of report.reaped) {
    console.log(`reaped   ${entry.runDir}  (${entry.reason})`)
    for (const proc of entry.processes) {
      console.log(`   ${proc.sent ? `${proc.signal} → ${proc.pid}` : `skipped pid ${proc.pid}: ${proc.reason}`}`)
    }
  }
  for (const entry of report.skipped) {
    // Being explicit about what was NOT touched is the point: silence here is
    // indistinguishable from having deleted someone else's run.
    console.log(`skipped  ${entry.runDir}  (${entry.state}: ${entry.reason})`)
  }
  const killed = report.reaped.reduce((total, entry) => total + entry.processes.filter((proc) => proc.sent).length, 0)
  console.log(`\ncleanup done: ${report.reaped.length} run root(s) reaped, ${killed} signal(s) sent, `
    + `${report.skipped.length} live/unreadable run(s) left alone`)
}
