/**
 * Evidence primitives for the Linux isolation layer result: git facts, worktree
 * digest, module provenance and log hashing.
 *
 * Every hash here is COMPUTED from bytes on disk. Nothing is hand-written or
 * carried over from a previous round, because a hash that was typed instead of
 * measured is worse than no hash: it looks like evidence and is not.
 */
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { digestTrackedFilesAsync } from '../../lib/tracked-digest.mjs'

const run = promisify(execFile)

/** This file lives at scripts/acceptance/integration/linux/lib/, five levels below the root. */
export const repoRoot = () => resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..')

/** The production module this layer reuses. There is deliberately no second copy of it. */
export const PRODUCTION_SANDBOX_MODULE = 'plugins/cn-capabilities/lib/autoresearch-sandbox.mjs'
export const PRODUCTION_WORKSPACE_MODULE = 'plugins/cn-capabilities/lib/autoresearch-workspace.mjs'

export const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex')

export async function sha256File(path) {
  return sha256(await readFile(path))
}

async function git(root, args) {
  try {
    const { stdout } = await run('git', ['-C', root, ...args], { maxBuffer: 64 * 1024 * 1024 })
    return { ok: true, stdout }
  } catch (err) {
    return { ok: false, stdout: '', error: String(err?.message || err) }
  }
}

/**
 * Digest of every TRACKED file's CURRENT WORKTREE bytes.
 *
 * Worktree bytes, not index or commit bytes, is the load-bearing choice: the
 * contract requires the digest to move when the tree is dirty, and a digest built
 * from `git ls-tree` or `ls-files -s` would be identical for a clean checkout and
 * for one with uncommitted edits — exactly the case this field exists to catch.
 * A tracked-but-deleted path folds in as an explicit `<deleted>` marker so a
 * deletion moves the digest too.
 */
export async function worktreeDigest(root) {
  const listed = await git(root, ['ls-files', '-z'])
  if (!listed.ok) return { digest: null, trackedFiles: 0, note: `git ls-files failed: ${listed.error}` }
  const paths = listed.stdout.split('\0').filter(Boolean).sort()
  let missing = 0
  const digest = await digestTrackedFilesAsync(paths, async (rel) => {
    const full = join(root, rel)
    const info = await stat(full).catch(() => null)
    if (!info?.isFile()) { missing += 1; return null }
    return readFile(full)
  })
  return { digest, trackedFiles: paths.length, deletedTrackedFiles: missing }
}

/** HEAD, branch and porcelain status, so a reader can place this result in history. */
export async function gitFacts(root) {
  const head = await git(root, ['rev-parse', 'HEAD'])
  const branch = await git(root, ['rev-parse', '--abbrev-ref', 'HEAD'])
  const status = await git(root, ['status', '--porcelain'])
  return {
    sourceCommit: head.ok ? head.stdout.trim() : null,
    branch: branch.ok ? branch.stdout.trim() : null,
    dirty: status.ok ? status.stdout.trim().length > 0 : null,
    statusPorcelain: status.ok ? status.stdout : null,
  }
}

/**
 * Load the production sandbox module and record where it came from. The entry
 * imports the SAME file the product ships; recording its path, size and sha256 is
 * how a reader confirms this layer reused production logic instead of shipping a
 * parallel sandbox implementation that could pass while the product's fails.
 */
export async function loadProductionSandbox(root = repoRoot()) {
  const provenance = []
  const loaded = {}
  for (const [key, rel] of [['sandbox', PRODUCTION_SANDBOX_MODULE], ['workspace', PRODUCTION_WORKSPACE_MODULE]]) {
    const full = join(root, rel)
    loaded[key] = await import(pathToFileURL(full).href)
    const bytes = await readFile(full)
    provenance.push({
      specifier: rel,
      resolvedPath: full,
      version: null,
      sha256: sha256(bytes),
      bytes: bytes.length,
      origin: 'local-source',
      originNote: 'in-repo production module, imported by the entry; this layer adds no second sandbox implementation',
    })
  }
  return { ...loaded, provenance }
}

export const isoNow = () => new Date().toISOString()
