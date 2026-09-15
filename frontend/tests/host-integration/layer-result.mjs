/**
 * The `agos-acceptance/integration-layer@1` result document for the
 * `host-browser` layer.
 *
 * The point of the schema is that a layer which could not be OBSERVED is
 * reported as such instead of being averaged into a green summary, so the two
 * rules that matter here are:
 *
 * - `verdict: "blocked"` is a third outcome. A machine with no Chrome, no
 *   Playwright in the repo tree, or no dsh CLI cannot observe this layer; that
 *   is not a product failure and must never be summarised as a pass either.
 * - every hash is computed from bytes on disk. Nothing in this file accepts a
 *   hash as an argument.
 */
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile)

/** sha256 of one file's bytes, or undefined when it is not there. */
export async function sha256File(file) {
  const bytes = await readFile(file).catch(() => undefined)
  if (bytes === undefined) return undefined
  return createHash('sha256').update(bytes).digest('hex')
}

/** `git rev-parse HEAD`, or null outside a repository. */
export async function gitHead(repoRoot) {
  const result = await run('git', ['rev-parse', 'HEAD'], { cwd: repoRoot }).catch(() => undefined)
  return result === undefined ? null : result.stdout.trim()
}

/**
 * A content digest of every TRACKED file in the worktree.
 *
 * Not `git rev-parse HEAD` and not the index: the requirement is that the
 * digest changes when the worktree is dirty, so it is computed from the bytes
 * actually on disk. Paths are hashed alongside their contents and processed in
 * sorted order, so the value depends on the tree and not on the order git
 * happened to list it in.
 *
 * Untracked files are excluded by definition — with several agents working in
 * one worktree, scratch files would otherwise make the digest meaningless.
 * @param repoRoot - the repository root.
 * @returns `{ digest, fileCount }`, or nulls outside a repository.
 */
export async function worktreeDigest(repoRoot) {
  const listed = await run('git', ['ls-files', '-z'], { cwd: repoRoot, maxBuffer: 64 * 1024 * 1024 }).catch(() => undefined)
  if (listed === undefined) return { digest: null, fileCount: null }
  const files = listed.stdout.split('\0').filter((entry) => entry !== '').sort()
  const hash = createHash('sha256')
  let counted = 0
  for (const file of files) {
    const bytes = await readFile(path.join(repoRoot, file)).catch(() => undefined)
    // A tracked file deleted from the worktree still has to change the digest,
    // so its absence is hashed too rather than skipped.
    hash.update(file).update('\0')
    hash.update(bytes === undefined ? 'ABSENT' : createHash('sha256').update(bytes).digest('hex'))
    hash.update('\n')
    counted += 1
  }
  return { digest: hash.digest('hex'), fileCount: counted }
}

/**
 * Turn the runner's own summary into the layer verdict.
 *
 * Ordering is the contract: a real failure outranks a block (a broken
 * assertion is not "uncovered"), a block outranks a pass (it was not
 * observed), and a run where nothing was reached is `skipped`.
 * @param counts - `{ pass, fail, skip, blocked }`.
 * @returns the verdict string.
 */
export function verdictFor(counts) {
  if (counts.fail > 0) return 'fail'
  if (counts.blocked > 0) return 'blocked'
  if (counts.pass > 0) return 'pass'
  return 'skipped'
}

/**
 * Build the layer document.
 *
 * @param options.counts - `{ pass, fail, skip, blocked }` from the runner.
 * @param options.command - the argv actually executed.
 * @param options.startedAt/endedAt - ISO timestamps.
 * @param options.exitCode - the process exit code this run will use.
 * @param options.repoRoot - repository root, for commit and digest.
 * @param options.moduleProvenance - where the real components came from.
 * @param options.logFiles - artifact paths to hash into `logs`.
 * @param options.blockedReason - required when the verdict is `blocked`.
 * @param options.recoveryCommand - a copyable command for a blocked run.
 * @returns the document, ready to serialise.
 */
export async function buildLayerResult(options) {
  const {
    counts, command, startedAt, endedAt, exitCode, repoRoot,
    moduleProvenance = [], logFiles = [], blockedReason = null, recoveryCommand = null,
    uncoveredLayers = [], scenarios = [],
  } = options
  const verdict = verdictFor(counts)
  if (verdict === 'blocked') {
    const reason = typeof blockedReason === 'string' && blockedReason.trim() !== ''
      ? blockedReason.trim()
      : `uncovered: ${uncoveredLayers.join('; ')}`
    if (reason.trim().length < 16) {
      throw new TypeError('blocked layer result requires a specific blockedReason or uncoveredLayers')
    }
    if (!Array.isArray(recoveryCommand) || recoveryCommand.length === 0
      || recoveryCommand.some((arg) => typeof arg !== 'string' || arg.trim() === '')) {
      throw new TypeError('blocked layer result requires a non-empty recoveryCommand argv')
    }
  }
  const { digest, fileCount } = await worktreeDigest(repoRoot)
  const logs = []
  for (const file of logFiles) {
    const sha256 = await sha256File(file)
    if (sha256 !== undefined) logs.push({ path: file, sha256 })
  }
  return {
    schema: 'agos-acceptance/integration-layer@1',
    layer: 'host-browser',
    verdict,
    sourceCommit: await gitHead(repoRoot),
    worktreeDigest: digest,
    worktreeFileCount: fileCount,
    command,
    startedAt,
    endedAt,
    exitCode,
    platform: {
      os: process.platform,
      release: (await import('node:os')).release(),
      arch: process.arch,
      node: process.version,
    },
    moduleProvenance,
    counts,
    // Required to be specific when the verdict is `blocked`, and null
    // otherwise — a non-null reason on a passing run would be misleading.
    blockedReason: verdict === 'blocked'
      ? (typeof blockedReason === 'string' && blockedReason.trim() !== ''
        ? blockedReason.trim()
        : `uncovered: ${uncoveredLayers.join('; ')}`)
      : null,
    recoveryCommand: verdict === 'blocked' ? recoveryCommand : null,
    uncoveredLayers,
    scenarios,
    logs,
  }
}

/**
 * Write `<logDir>/host-browser.json`.
 * @returns the path written and the document.
 */
export async function writeLayerResult(logDir, document) {
  const file = path.join(logDir, 'host-browser.json')
  await writeFile(file, JSON.stringify(document, undefined, 2) + '\n')
  return { file, document }
}
