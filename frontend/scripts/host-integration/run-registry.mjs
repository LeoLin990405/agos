/**
 * Run identity for the host-integration harness: who owns which temp tree and
 * which process, so cleanup can never touch someone else's live run.
 *
 * The problem this exists to solve. The previous cleanup matched on the global
 * prefix `agos-host-integration` — every process whose argv mentioned the
 * marker was SIGTERM'd and every temp directory carrying the prefix was
 * removed. Two suites in parallel (CI plus a local run, or two shells) meant
 * whichever finished first killed the other one's host and deleted its DSH_HOME
 * underneath it. The prefix says "a harness owns this"; it does not say "THIS
 * harness owns this", and reaping needs the second statement.
 *
 * Ownership is therefore recorded, not inferred, on three independent axes:
 *
 * 1. runId — one random id per run. It is embedded in the run directory name,
 *    so it also appears in the host's argv (the `--patch` overlay lives inside
 *    the run directory). A pid whose command line does not name our runId is
 *    not our host, whatever else it looks like.
 * 2. ownerToken — a random secret written into the run's manifest. A caller
 *    that wants to reap a specific run must present the matching token, so a
 *    mis-computed path cannot delete a stranger's tree.
 * 3. process identity — pid PLUS the kernel's start timestamp for that pid
 *    (`ps -o lstart=`) PLUS the requirement that the argv still names the
 *    runId. pids are recycled; a recycled pid gets a different start time and a
 *    different command line, so all three matching is what makes a signal safe.
 *    Identity is re-verified immediately before EVERY signal, not once up
 *    front, because the process can exit between the check and the kill.
 *
 * Reaping decisions follow from the owner process, not from a timeout: while
 * the process that created a run is still alive with a matching identity, that
 * run is ACTIVE and is skipped and reported, never reaped.
 */
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { randomUUID, randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { HARNESS_ID } from './host-env.mjs';

const run = promisify(execFile)

/** Every run directory this harness creates starts with this. */
export const RUN_PREFIX = `${HARNESS_ID}-run-`
/** Ownership manifest file inside a run directory. */
export const MANIFEST_NAME = 'owner.json'
/** Manifest schema version, so a future change can refuse an old layout. */
export const MANIFEST_VERSION = 1

/**
 * A run directory with no readable manifest is left alone until it is this
 * old. A run that is mid-`mkdtemp` has no manifest yet for a few milliseconds;
 * deleting it because it "looks abandoned" would be exactly the bug this file
 * exists to prevent. Ten minutes is far longer than the bring-up window.
 */
export const UNREADABLE_GRACE_MS = 10 * 60 * 1000

/** How long a SIGTERM'd host gets before SIGKILL. */
const TERM_GRACE_MS = 3000

/**
 * Ask the OS who a pid currently is.
 *
 * `ps -o lstart=` prints the process start time to the second. Two different
 * processes sharing a pid must then also share a start second AND a command
 * line for this to be fooled; combined with the runId check in
 * {@link processMatches} that is not reachable in practice.
 * @param pid - the pid to identify.
 * @returns identity, or undefined when the pid does not exist (or ps failed).
 */
export async function processIdentity(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return undefined
  const result = await run('ps', ['-o', 'pid=,pgid=,lstart=,command=', '-p', String(pid)]).catch(() => undefined)
  if (result === undefined) return undefined
  const line = result.stdout.split('\n').find((entry) => entry.trim() !== '')
  if (line === undefined) return undefined
  const match = /^\s*(\d+)\s+(\d+)\s+(\S{3}\s+\S{3}\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.*)$/.exec(line)
  if (match === null) return undefined
  // pgid is carried so a process that leads its own group (a browser and its
  // renderer/GPU helpers) can be reclaimed as a whole; see killRecorded.
  return { pid: Number(match[1]), pgid: Number(match[2]), startedAt: match[3].replace(/\s+/g, ' '), command: match[4] }
}

/**
 * Direct children of a process, as the OS reports them.
 *
 * Used to learn the pid of a process someone ELSE spawned on our behalf:
 * Playwright launches the browser as a direct child of this process but does
 * not expose its pid on the object it returns, so an orphaned run would leak a
 * headless browser that no manifest names. Diffing the child list around the
 * launch is what makes that pid recordable.
 * @param parentPid - the parent to inspect (defaults to this process).
 * @returns the child pids, or an empty array when pgrep finds none.
 */
export async function childPids(parentPid = process.pid) {
  const result = await run('pgrep', ['-P', String(parentPid)]).catch(() => undefined)
  if (result === undefined) return []
  return result.stdout.split('\n').map((line) => Number(line.trim())).filter((pid) => Number.isInteger(pid) && pid > 0)
}

/**
 * Signal a recorded process, taking its whole group when it leads one.
 *
 * A browser is a process TREE: killing only the parent leaves renderer and GPU
 * helpers behind, and Playwright's own `close()` then waits 30s for them before
 * giving up — measured, not assumed. Signalling the group reclaims the subtree
 * at once.
 *
 * Two guards make the group signal safe, and both must hold:
 * - the recorded pgid must equal the recorded pid, i.e. the process leads its
 *   OWN group, so the group is exactly that subtree and nothing else;
 * - that group must not be our own, so this can never signal the caller.
 * @param entry - a recorded identity (pid, and pgid when it was captured).
 * @param signal - the signal to send.
 * @returns what was signalled, for the evidence log.
 */
export async function killRecorded(entry, signal) {
  // This helper is also used by the launcher-error path, before the normal
  // signalRecorded gate runs. Refresh identity here so every caller gets the
  // same PID/start-time/argv protection immediately before signalling.
  const verdict = await processMatches(entry)
  if (!verdict.ok) return { pid: entry?.pid, signal, sent: false, reason: verdict.reason }
  const ownGroup = (await processIdentity(process.pid))?.pgid
  const leadsOwnGroup = Number.isInteger(entry?.pgid) && entry.pgid === entry.pid
  if (leadsOwnGroup && entry.pgid !== ownGroup) {
    try {
      process.kill(-entry.pgid, signal)
      return { pid: entry.pid, signal, sent: true, scope: 'group' }
    } catch {
      // The group may already be gone; fall through to the single-pid attempt.
    }
  }
  const refreshed = await processMatches(entry)
  if (!refreshed.ok) return { pid: entry?.pid, signal, sent: false, reason: refreshed.reason }
  process.kill(entry.pid, signal)
  return { pid: entry.pid, signal, sent: true, scope: 'process' }
}

/**
 * Does the pid still hold the identity we recorded?
 *
 * Always required: same pid, same kernel start timestamp, same command line.
 * A recycled pid gets a fresh start timestamp, so those three together are what
 * makes acting on a pid safe.
 *
 * `requireRunIdInCommand` adds a fourth condition and is the difference between
 * the two kinds of process this registry knows about:
 *
 * - processes the run SPAWNED (the host) live inside the run tree, so their
 *   argv names the run directory and therefore the runId. Before sending them
 *   a signal we demand that, because killing is irreversible and the extra
 *   condition costs nothing.
 * - the OWNER process (the test runner) existed before the run did, so its argv
 *   cannot name the runId. Demanding it there would classify every live run as
 *   an orphan — which is precisely the bug this file exists to prevent, and is
 *   how this check was first written.
 *
 * @param recorded - identity captured when the process was first seen.
 * @param options.runId - the run the process is supposed to belong to.
 * @param options.requireRunIdInCommand - demand the argv still names the runId.
 * @returns a verdict plus the identity actually observed.
 */
export async function processMatches(recorded, { runId, requireRunIdInCommand = false } = {}) {
  if (recorded === undefined || recorded === null) return { ok: false, reason: 'no recorded identity' }
  const live = await processIdentity(recorded.pid)
  if (live === undefined) return { ok: false, reason: 'pid is gone', live: undefined }
  if (live.startedAt !== recorded.startedAt) {
    return { ok: false, reason: `pid reused (started ${live.startedAt}, recorded ${recorded.startedAt})`, live }
  }
  if (typeof recorded.command === 'string' && recorded.command !== '' && live.command !== recorded.command) {
    return { ok: false, reason: 'pid reused (command line changed)', live }
  }
  if (requireRunIdInCommand && typeof runId === 'string' && runId !== '' && !live.command.includes(runId)) {
    return { ok: false, reason: 'command line no longer names this runId', live }
  }
  return { ok: true, live }
}

/** Absolute path of a run's manifest. */
function manifestPath(runDir) {
  return path.join(runDir, MANIFEST_NAME)
}

/**
 * Write the manifest atomically (temp file + rename), so a reader never sees a
 * half-written document and treats a live run as unreadable.
 * @param runDir - the run directory.
 * @param manifest - the full manifest to persist.
 */
async function persist(runDir, manifest) {
  const target = manifestPath(runDir)
  const staging = `${target}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  await writeFile(staging, JSON.stringify(manifest, undefined, 2) + '\n')
  await rename(staging, target)
}

/**
 * Create the throwaway tree for one run and stamp it with our identity.
 *
 * Everything for the run lives under a single directory, so ownership is a
 * property of one path rather than of a naming convention spread over several.
 * @param options.root - parent directory (defaults to the OS temp dir).
 * @returns the run handle: ids, paths, and the manifest as written.
 */
export async function createRunRoot({ root = tmpdir() } = {}) {
  const runId = `${Date.now().toString(36)}-${randomBytes(6).toString('hex')}`
  const ownerToken = randomBytes(24).toString('hex')
  const runDir = await mkdtemp(path.join(root, `${RUN_PREFIX}${runId}-`))
  const dshHome = path.join(runDir, 'home')
  const workspace = path.join(runDir, 'workspace')
  await mkdir(dshHome, { recursive: true })
  await mkdir(workspace, { recursive: true })

  const manifest = {
    harness: HARNESS_ID,
    version: MANIFEST_VERSION,
    runId,
    ownerToken,
    createdAt: new Date().toISOString(),
    // The process that created the run. While this is alive the run is ACTIVE
    // and no other cleanup may touch it.
    owner: (await processIdentity(process.pid)) ?? { pid: process.pid, startedAt: 'unknown', command: 'unknown' },
    processes: [],
  }
  await persist(runDir, manifest)
  return { runId, ownerToken, runDir, dshHome, workspace, manifest }
}

/**
 * Record a process this run spawned, so a later cleanup can identify it.
 *
 * Called with the pid of a process we are the parent of: the pid cannot be
 * recycled while we hold the un-reaped child handle, so the identity captured
 * here is guaranteed to describe the process we actually started.
 * @param runDir - the run directory.
 * @param options.pid - the spawned pid.
 * @param options.role - a label for the evidence log ("host", "ui", …).
 * @param options.ownerToken - the run's token; a mismatch is refused.
 * @returns the identity that was recorded, or undefined when ps could not see it.
 */
export async function recordProcess(runDir, { pid, role, ownerToken }) {
  const manifest = await readManifest(runDir)
  if (manifest === undefined) throw new Error(`run-registry: no manifest in ${runDir}`)
  if (manifest.ownerToken !== ownerToken) throw new Error('run-registry: owner token mismatch, refusing to record')
  const identity = await processIdentity(pid)
  if (identity === undefined) return undefined
  // Whether the argv names the runId is decided HERE, while the process is
  // provably ours (we are its parent and its pid cannot have been recycled
  // yet), and then demanded forever after. The host is launched with a
  // `--patch` path inside the run directory, so its argv does name the runId.
  // A browser launched by Playwright does not: its argv points at Playwright's
  // own random profile directory. Demanding the runId there would make the
  // browser permanently unreapable, so for those entries the identity rule is
  // pid + kernel start second + byte-exact argv, which the random profile path
  // in that argv already makes unique.
  const runIdInCommand = typeof manifest.runId === 'string' && identity.command.includes(manifest.runId)
  manifest.processes = [
    ...(manifest.processes ?? []).filter((entry) => entry.pid !== pid),
    { ...identity, role, runIdInCommand },
  ]
  await persist(runDir, manifest)
  return identity
}

/**
 * Read one run's manifest.
 * @param runDir - the run directory.
 * @returns the manifest, or undefined when absent/unparsable.
 */
export async function readManifest(runDir) {
  const text = await readFile(manifestPath(runDir), 'utf8').catch(() => undefined)
  if (text === undefined) return undefined
  try {
    const parsed = JSON.parse(text)
    return parsed?.harness === HARNESS_ID ? parsed : undefined
  } catch {
    return undefined
  }
}

/** All run directories currently present under `root`. */
export async function listRunDirs({ root = tmpdir() } = {}) {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => [])
  return entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(RUN_PREFIX))
    .map((entry) => path.join(root, entry.name))
    .sort()
}

/**
 * Decide what a run directory is, from the point of view of a cleanup that is
 * (optionally) running on behalf of `runId`.
 *
 * States:
 * - `self`         — this is our own run (runId and token both match).
 * - `active`       — the process that created it is still alive; hands off.
 * - `orphan`       — the owner is gone, so nothing is coming back for it.
 * - `unreadable`   — no usable manifest. Young ones are skipped (a run being
 *                    created right now looks exactly like this); old ones are
 *                    treated as orphans, since no live owner claims them.
 * @param runDir - the directory to classify.
 * @param options.runId - the caller's own runId, when it has one.
 * @param options.ownerToken - the caller's own token.
 * @returns the classification with the evidence behind it.
 */
export async function classifyRun(runDir, { runId, ownerToken } = {}) {
  const manifest = await readManifest(runDir)
  if (manifest === undefined) {
    const info = await stat(runDir).catch(() => undefined)
    const ageMs = info === undefined ? 0 : Date.now() - info.mtimeMs
    if (info !== undefined && ageMs > UNREADABLE_GRACE_MS) {
      return { runDir, state: 'orphan', reason: `no manifest and ${Math.round(ageMs / 60000)}min old`, manifest: undefined }
    }
    return { runDir, state: 'unreadable', reason: 'no readable manifest yet (may be starting up)', manifest: undefined }
  }
  if (runId !== undefined && manifest.runId === runId) {
    if (manifest.ownerToken !== ownerToken) {
      return { runDir, state: 'active', reason: 'runId matches but owner token does not', manifest }
    }
    return { runDir, state: 'self', reason: 'this run', manifest }
  }
  // A manifest without a trustworthy owner identity is ambiguous: the owner
  // may still be alive, or the file may have been truncated by an older
  // launcher. Treat it as active until an operator can inspect it; reaping an
  // unknown owner would recreate the original cross-run deletion hazard.
  const ownerIdentity = manifest.owner
  const knownText = (value) => typeof value === 'string'
    && value.trim() !== '' && value.trim().toLowerCase() !== 'unknown'
  if (!ownerIdentity || !Number.isSafeInteger(ownerIdentity.pid) || ownerIdentity.pid <= 0
    || !knownText(ownerIdentity.startedAt) || !knownText(ownerIdentity.command)) {
    return { runDir, state: 'active', reason: 'owner identity unavailable; left untouched', manifest }
  }
  // The owner is identified by pid + start time + argv equality, but NOT by the
  // runId: it started before the run existed.
  const owner = await processMatches(manifest.owner, { runId: manifest.runId, requireRunIdInCommand: false })
  if (owner.ok) {
    return { runDir, state: 'active', reason: `owner pid ${manifest.owner.pid} is alive`, manifest }
  }
  return { runDir, state: 'orphan', reason: `owner pid ${manifest.owner?.pid} ${owner.reason}`, manifest }
}

/**
 * Signal one recorded process, but only after proving it is still the process
 * we recorded.
 * @param entry - the recorded identity.
 * @param runId - the run allowed to signal it.
 * @param signal - the signal to send.
 * @returns what happened, for the evidence log.
 */
async function signalRecorded(entry, runId, signal) {
  // Killing is irreversible, so the strictest rule that CAN hold for this entry
  // applies. `runIdInCommand` was decided when the process was recorded and was
  // provably ours; an entry recorded before this field existed is treated as
  // naming the runId, which is the stricter reading.
  const demandRunId = entry?.runIdInCommand !== false
  const verdict = await processMatches(entry, { runId, requireRunIdInCommand: demandRunId })
  if (!verdict.ok) return { pid: entry?.pid, signal, sent: false, reason: verdict.reason }
  try {
    return await killRecorded(entry, signal)
  } catch (error) {
    return { pid: entry.pid, signal, sent: false, reason: String(error) }
  }
}

/**
 * Remove a directory, but only inside the temp root and only when it carries
 * the harness run prefix. Two independent guards, because this function is the
 * one that does irreversible work.
 * @param runDir - directory to delete.
 * @param options.root - the temp root it must live under.
 */
async function removeRunDir(runDir, { root = tmpdir() } = {}) {
  const resolved = path.resolve(runDir)
  if (!resolved.startsWith(path.resolve(root) + path.sep)) {
    throw new Error(`run-registry: refusing to remove ${resolved} (outside ${root})`)
  }
  if (!path.basename(resolved).startsWith(RUN_PREFIX)) {
    throw new Error(`run-registry: refusing to remove ${resolved} (not a harness run directory)`)
  }
  await rm(resolved, { recursive: true, force: true })
}

/**
 * Reap one run: stop the processes it recorded, then delete its tree.
 *
 * Refuses an ACTIVE run unless the caller owns it. Every kill is gated on a
 * fresh identity check, and the check is repeated before the escalation to
 * SIGKILL — the pid may have exited during the grace window and been handed to
 * an unrelated process in the meantime.
 * @param runDir - the run to reap.
 * @param options.runId - the caller's runId, when reaping its own run.
 * @param options.ownerToken - the caller's token.
 * @param options.root - temp root guard.
 * @returns a report of processes signalled and skipped.
 */
export async function reapRun(runDir, { runId, ownerToken, root = tmpdir() } = {}) {
  const verdict = await classifyRun(runDir, { runId, ownerToken })
  if (verdict.state === 'active' || verdict.state === 'unreadable') {
    return { runDir, reaped: false, state: verdict.state, reason: verdict.reason, processes: [] }
  }
  const manifest = verdict.manifest
  const recordedRunId = manifest?.runId
  const processes = []
  for (const entry of manifest?.processes ?? []) {
    processes.push(await signalRecorded(entry, recordedRunId, 'SIGTERM'))
  }
  if (processes.some((entry) => entry.sent)) {
    await new Promise((resolve) => { setTimeout(resolve, TERM_GRACE_MS) })
    for (const entry of manifest?.processes ?? []) {
      // Re-verify: a SIGTERM'd process that already exited must not have its
      // recycled pid SIGKILL'd.
      const escalation = await signalRecorded(entry, recordedRunId, 'SIGKILL')
      if (escalation.sent) processes.push(escalation)
    }
  }
  await removeRunDir(runDir, { root })
  return { runDir, reaped: true, state: verdict.state, reason: verdict.reason, runId: recordedRunId, processes }
}

/**
 * Sweep the temp root for runs nobody is coming back for.
 *
 * Anything still owned by a live process is skipped and reported by name — the
 * report is the point, since "I left your run alone" is the claim that has to
 * be checkable.
 * @param options.runId - the caller's own runId, if it wants its own run reaped too.
 * @param options.ownerToken - the caller's token.
 * @param options.root - temp root to sweep.
 * @returns reaped and skipped runs, with the reason for each decision.
 */
export async function cleanupRuns({ runId, ownerToken, root = tmpdir() } = {}) {
  const reaped = []
  const skipped = []
  for (const runDir of await listRunDirs({ root })) {
    const verdict = await classifyRun(runDir, { runId, ownerToken })
    if (verdict.state === 'active' || verdict.state === 'unreadable') {
      skipped.push({ runDir, state: verdict.state, reason: verdict.reason, runId: verdict.manifest?.runId })
      continue
    }
    reaped.push(await reapRun(runDir, { runId, ownerToken, root }))
  }
  return { reaped, skipped }
}

/**
 * Dispose our own run at the end of a normal test run.
 * @param handle - the value returned by {@link createRunRoot}.
 * @returns the reap report.
 */
export async function disposeRunRoot(handle) {
  if (handle?.runDir === undefined) return { runDir: undefined, reaped: false, reason: 'no run root' }
  return reapRun(handle.runDir, {
    runId: handle.runId,
    ownerToken: handle.ownerToken,
    root: path.dirname(handle.runDir),
  })
}

/** A fresh correlation id for one bring-up attempt (evidence logs only). */
export function newAttemptId() {
  return randomUUID()
}
