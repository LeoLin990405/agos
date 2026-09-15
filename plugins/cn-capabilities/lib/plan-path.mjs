// Plan file path + open. GET /api/cn/plans、POST、plan_run 读/写必须走这里,
// 不能再自己拼 PLAN_DIR + basename 然后 readFile/writeFile(会跟软链)。
//
// 对照:
//   plugins/dsh-agos/lib/session-memory.mjs  readRaw / atomicWrite
//   plugins/dsh-agos/lib/index.js            session meta/log O_NOFOLLOW
//   plugins/dsh-fleet/lib/fleet-artifacts.mjs openLocalArtifactFile
//
// 规则:只认 plan-<数字>.json;拒绝目录逃逸、软链、非普通文件;
// 打开后用 fd.stat 对 dev/ino,挡住 lstat→open 之间的换叶(TOCTOU)。

import { constants as FS_CONSTANTS } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'

export const PLAN_NAME = /^plan-\d+\.json$/

const isDirectChild = (parent, child) => {
  const rel = relative(parent, child)
  return rel !== '' && rel !== '..' && !rel.startsWith('..' + sep) && !rel.includes(sep)
}

const fail = (code, message) => ({ ok: false, code, message })

const sameFile = (left, right) => (
  left && right
  && Number(left.dev) === Number(right.dev)
  && Number(left.ino) === Number(right.ino)
)

const requireNofollow = () => {
  if (typeof FS_CONSTANTS.O_NOFOLLOW !== 'number') {
    return fail('NO_NOFOLLOW', 'O_NOFOLLOW is unavailable')
  }
  return { ok: true, nofollow: FS_CONSTANTS.O_NOFOLLOW }
}

/**
 * Lexical only (no IO). Accepts basename or planDir/basename after path.resolve.
 * `../`, other directories, and non-plan names are ESCAPE / INVALID_NAME.
 */
export function resolvePlanPath(raw, planDir) {
  if (typeof planDir !== 'string' || planDir.length === 0) {
    return fail('INVALID_DIR', 'planDir required')
  }
  const root = resolve(planDir)
  const text = raw == null ? '' : String(raw)
  if (!text || text.includes('\0')) return fail('INVALID_NAME', 'plan path empty')
  const base = text.slice(text.lastIndexOf('/') + 1)
  if (!PLAN_NAME.test(base)) return fail('INVALID_NAME', 'name must be plan-<digits>.json')
  const full = join(root, base)
  if (!isDirectChild(root, full)) return fail('ESCAPE', 'plan path escaped planDir')
  // Only the basename or the exact planDir/basename string — same gate as
  // index.js planPathOk. `foo/../plan-1.json` must not sneak through resolve().
  const rawFull = planDir.endsWith('/') ? planDir + base : planDir + '/' + base
  if (text !== base && text !== full && text !== rawFull) return fail('ESCAPE', 'plan path escaped planDir')
  return { ok: true, path: full, name: base, planDir: root }
}

const inspectPlanDir = async (planDir) => {
  const lexical = resolve(planDir)
  let identity
  try {
    identity = await lstat(lexical)
  } catch (error) {
    if (error && error.code === 'ENOENT') return fail('ENOENT', 'planDir missing')
    throw error
  }
  if (identity.isSymbolicLink()) return fail('SYMLINK', 'planDir must not be a symlink')
  if (!identity.isDirectory()) return fail('NOT_REGULAR', 'planDir must be a directory')
  const real = await realpath(lexical)
  const after = await lstat(real)
  if (after.isSymbolicLink() || !after.isDirectory() || !sameFile(identity, after)) return fail('TOCTOU', 'planDir changed while resolving')
  return { ok: true, lexical, real, stat: identity }
}

const resolveFlags = (flags) => {
  const nf = requireNofollow()
  if (!nf.ok) return nf
  if (typeof flags === 'number') {
    return { ok: true, flags: (flags & ~FS_CONSTANTS.O_TRUNC) | nf.nofollow,
      truncate: (flags & FS_CONSTANTS.O_TRUNC) !== 0, createIfMissing: false }
  }
  if (flags === undefined || flags === 'r') {
    return { ok: true, flags: FS_CONSTANTS.O_RDONLY | nf.nofollow, createIfMissing: false }
  }
  if (flags === 'r+') {
    return { ok: true, flags: FS_CONSTANTS.O_RDWR | nf.nofollow, createIfMissing: false }
  }
  if (flags === 'w') {
    return {
      ok: true,
      flags: FS_CONSTANTS.O_WRONLY | nf.nofollow,
      truncate: true,
      createIfMissing: true,
      createFlags: FS_CONSTANTS.O_WRONLY | FS_CONSTANTS.O_CREAT | FS_CONSTANTS.O_EXCL | nf.nofollow,
    }
  }
  if (flags === 'wx') {
    const create = FS_CONSTANTS.O_WRONLY | FS_CONSTANTS.O_CREAT | FS_CONSTANTS.O_EXCL | nf.nofollow
    return { ok: true, flags: create, createIfMissing: true, createFlags: create }
  }
  return fail('INVALID_FLAGS', 'unsupported flags')
}

const closeQuiet = async (handle) => {
  if (!handle) return
  try { await handle.close() } catch {}
}

const inspectLeaf = async (absolute, { allowMissing }) => {
  let identity
  try {
    identity = await lstat(absolute)
  } catch (error) {
    if (allowMissing && error && error.code === 'ENOENT') return { ok: true, missing: true }
    if (error && error.code === 'ENOENT') return fail('ENOENT', 'plan file missing')
    throw error
  }
  if (identity.isSymbolicLink()) return fail('SYMLINK', 'plan file must not be a symlink')
  if (!identity.isFile() || identity.isDirectory()) return fail('NOT_REGULAR', 'plan file must be a regular file')
  if (identity.nlink !== 1) return fail('HARDLINK', 'plan file must not have other hard links')
  return { ok: true, missing: false, stat: identity }
}

/**
 * Open a plan file without following the leaf. Caller must close `handle`.
 * `{ path, planDir, flags }` — flags: 'r' | 'w' | 'wx' | number (O_NOFOLLOW is always OR'd).
 */
export async function openPlanFile({ path, planDir, flags = 'r' } = {}) {
  if (typeof planDir !== 'string' || planDir.length === 0) return fail('INVALID_DIR', 'planDir required')
  const named = resolvePlanPath(path, planDir)
  if (!named.ok) return named
  const dir = await inspectPlanDir(planDir)
  if (!dir.ok) return dir
  const absolute = join(dir.real, named.name)
  if (!isDirectChild(dir.real, absolute)) return fail('ESCAPE', 'plan path escaped planDir')
  const flag = resolveFlags(flags)
  if (!flag.ok) return flag

  const before = await inspectLeaf(absolute, { allowMissing: flag.createIfMissing || ((flag.flags & FS_CONSTANTS.O_EXCL) !== 0 && (flag.flags & FS_CONSTANTS.O_CREAT) !== 0) })
  if (!before.ok) return before

  let handle
  try {
    if (before.missing && flag.createIfMissing) {
      handle = await open(absolute, flag.createFlags)
    } else if (before.missing) {
      return fail('ENOENT', 'plan file missing')
    } else {
      handle = await open(absolute, flag.flags)
    }
  } catch (error) {
    if (error && (error.code === 'ELOOP' || error.code === 'EMLINK')) return fail('SYMLINK', 'plan file is a symlink')
    if (error && error.code === 'ENOENT') return fail('ENOENT', 'plan file missing')
    if (error && error.code === 'EEXIST') return fail('EEXIST', 'plan file already exists')
    throw error
  }

  try {
    const opened = await handle.stat()
    if (!opened.isFile() || opened.isDirectory() || opened.nlink !== 1) {
      await closeQuiet(handle)
      return fail('NOT_REGULAR', 'opened descriptor is not a regular file')
    }
    if (!before.missing && !sameFile(opened, before.stat)) {
      await closeQuiet(handle)
      return fail('TOCTOU', 'plan file changed while opening')
    }
    const afterDir = await inspectPlanDir(planDir)
    if (!afterDir.ok) {
      await closeQuiet(handle)
      return afterDir
    }
    if (afterDir.real !== dir.real || !sameFile(afterDir.stat, dir.stat)) {
      await closeQuiet(handle)
      return fail('TOCTOU', 'planDir changed while opening')
    }
    const afterLeaf = await inspectLeaf(absolute, { allowMissing: false })
    if (!afterLeaf.ok) {
      await closeQuiet(handle)
      return afterLeaf
    }
    if (!sameFile(opened, afterLeaf.stat)) {
      await closeQuiet(handle)
      return fail('TOCTOU', 'plan file changed while opening')
    }
    // Never truncate before all identity checks. A rejected race must leave
    // every possible replacement file byte-for-byte intact.
    if (flag.truncate) await handle.truncate(0)
    return { ok: true, handle, path: absolute, name: named.name, stat: opened }
  } catch (error) {
    await closeQuiet(handle)
    throw error
  }
}
