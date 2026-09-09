/**
 * Isolated autoresearch workspace.
 * Optimizations run in a temp clone pinned to a baseline SHA.
 * The caller's cwd, branch, index, and worktree are never written.
 */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, lstat, readlink, writeFile, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'

import { compareMetric, extractStructuredMetric } from './autoresearch-metrics.mjs'
import { chooseIsolationBackend, linuxVerificationSandbox, runSeatbeltSmoke } from './autoresearch-sandbox.mjs'

export { compareMetric, extractStructuredMetric }

export const DEFAULT_SOURCE_ALLOWLIST = Object.freeze([
  'src/**',
  'lib/**',
  'app/**',
  'pkg/**',
  'clis/**',
])

export const DEFAULT_PROTECTED_PATHS = Object.freeze([
  'test/**',
  'tests/**',
  '**/__tests__/**',
  '**/__fixtures__/**',
  '**/fixtures/**',
  '**/testdata/**',
  '**/golden/**',
  '**/*.test.*',
  '**/*.spec.*',
  '**/scorer.*',
  '**/score.*',
  '**/eval/**',
  '**/eval.*',
  '**/verify.*',
  '**/metrics.*',
])

const GIT_UNSET = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_COMMON_DIR',
  'GIT_PREFIX',
]

const MAX_OUTPUT = 4 * 1024 * 1024

const FINITE_METRIC = (value) => {
  const n = Number(value)
  return Number.isFinite(n) ? n : undefined
}

function gitEnv() {
  const env = { ...process.env }
  for (const key of GIT_UNSET) delete env[key]
  env.GIT_OPTIONAL_LOCKS = '0'
  return env
}

function evidenceCommand(command, exitCode) {
  return { command, exitCode: exitCode == null ? null : exitCode }
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function matchGlob(path, glob) {
  const normalized = String(path || '').replace(/\\/g, '/')
  const pattern = String(glob || '').replace(/\\/g, '/')
  let re = ''
  for (let i = 0; i < pattern.length; ) {
    if (pattern.startsWith('**/', i)) {
      re += '(?:.*/)?'
      i += 3
    } else if (pattern[i] === '*' && pattern[i + 1] === '*') {
      re += '.*'
      i += 2
    } else if (pattern[i] === '*') {
      re += '[^/]*'
      i += 1
    } else if (pattern[i] === '?') {
      re += '[^/]'
      i += 1
    } else {
      re += escapeRegExp(pattern[i])
      i += 1
    }
  }
  return new RegExp(`^${re}$`).test(normalized)
}

export function matchesAnyGlob(path, globs) {
  return (globs || []).some((glob) => matchGlob(path, glob))
}

function classifyPath(relPath, sourceAllowlist, protectedPaths) {
  const protectedHit = matchesAnyGlob(relPath, protectedPaths)
  const allowed = matchesAnyGlob(relPath, DEFAULT_SOURCE_ALLOWLIST) && matchesAnyGlob(relPath, sourceAllowlist)
  if (protectedHit) return 'protected'
  if (allowed) return 'source'
  return 'blocked'
}

function appendCapped(current, chunk) {
  if (current.length >= MAX_OUTPUT) return current
  const next = current + chunk
  return next.length > MAX_OUTPUT ? next.slice(0, MAX_OUTPUT) : next
}

function finishProc(state, resolve, payload) {
  if (state.done) return
  state.done = true
  clearTimeout(state.timer)
  clearTimeout(state.killTimer)
  if (state.signal && state.onAbort) state.signal.removeEventListener('abort', state.onAbort)
  resolve(payload)
}

function killProcessGroup(child, sig) {
  if (!child?.pid) return
  try {
    process.kill(-child.pid, sig)
  } catch {
    try { child.kill(sig) } catch { /* already gone */ }
  }
}

/**
 * `sandboxLauncher` is the platform-neutral form: the child is spawned as
 * `launcher.file [...launcher.before, command]`. `sandboxProfile` is the macOS
 * shorthand that expands to the same thing. Either one also means the child gets
 * exactly the supplied env, with nothing inherited from this process.
 */
export function execCommand(command, { cwd, signal, timeoutMs = 120000, env, sandboxProfile, sandboxLauncher } = {}) {
  const started = Date.now()
  const launcher = sandboxLauncher
    || (sandboxProfile ? { file: '/usr/bin/sandbox-exec', before: ['-p', sandboxProfile, '/bin/bash', '-c'] } : null)
  return new Promise((resolve) => {
    const state = { done: false, timer: null, killTimer: null, signal, onAbort: null }
    let stdout = ''
    let stderr = ''
    const child = spawn(launcher ? launcher.file : '/bin/bash',
      launcher ? [...launcher.before, String(command)] : ['-c', String(command)], {
      cwd,
      env: launcher ? env : { ...gitEnv(), ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    })

    const done = (exitCode, extra = {}) => finishProc(state, resolve, {
      command: String(command),
      exitCode: exitCode == null ? null : exitCode,
      stdout,
      stderr,
      text: (stdout + (stderr ? `\n${stderr}` : '')).trim(),
      elapsedMs: Date.now() - started,
      cancelled: extra.cancelled === true,
      signal: extra.signal || null,
      pid: child.pid ?? null,
    })

    state.onAbort = () => {
      killProcessGroup(child, 'SIGTERM')
      state.killTimer = setTimeout(() => killProcessGroup(child, 'SIGKILL'), 1500)
    }
    if (signal) {
      if (signal.aborted) state.onAbort()
      else signal.addEventListener('abort', state.onAbort, { once: true })
    }
    state.timer = setTimeout(() => {
      killProcessGroup(child, 'SIGTERM')
      state.killTimer = setTimeout(() => killProcessGroup(child, 'SIGKILL'), 1500)
    }, timeoutMs)

    child.stdout.on('data', (chunk) => { stdout = appendCapped(stdout, String(chunk)) })
    child.stderr.on('data', (chunk) => { stderr = appendCapped(stderr, String(chunk)) })
    child.on('error', (err) => done(null, { signal: err.message }))
    child.on('close', (code, sig) => {
      const cancelled = Boolean(signal?.aborted)
      done(code, { cancelled, signal: sig || (cancelled ? 'ABORT' : null) })
    })
  })
}

/**
 * Only an OS-enforced boundary is trusted. The backend is chosen by capability
 * detection, and a host that cannot supply one fails closed as
 * `verification-unavailable` rather than falling back to a weaker check.
 */
export async function verificationSandbox(evaluator, { platform = process.platform, probe } = {}) {
  const backend = chooseIsolationBackend(platform)
  if (!backend) {
    return {
      ok: false,
      reason: `verification-unavailable: no OS isolation backend for platform ${platform};`
        + ' macOS sandbox-exec or Linux namespaces required',
    }
  }
  if (backend === 'macos-seatbelt' && !await stat('/usr/bin/sandbox-exec').catch(() => null)) {
    return { ok: false, reason: 'verification-unavailable: macOS sandbox-exec is required' }
  }
  const root = await realpath(evaluator)
  const scratch = join(root, '.agos-verification-tmp')
  await mkdir(scratch, { recursive: true })
  const node = await realpath(process.execPath)
  const nodePrefix = dirname(dirname(node))
  if (backend === 'linux-namespaces') {
    return linuxVerificationSandbox({ evaluator: root, scratch, nodeBinDir: dirname(node), nodePrefix, probe, platform })
  }
  const quote = (s) => JSON.stringify(s)
  const libraryRoots = ['/usr/bin', '/usr/lib', '/usr/libexec', '/usr/share', '/System', '/bin', '/sbin',
    '/Library/Apple/System', '/opt/homebrew/Cellar', '/opt/homebrew/opt', '/usr/local/Cellar', '/usr/local/opt', nodePrefix]
  const readWhitelist = [...new Set([...libraryRoots, root])]
  const profile = '(version 1)\n(deny default)\n(allow process*)\n(allow sysctl-read)\n(allow mach-lookup)\n'
    + '(allow file-read-metadata)\n(allow file-read* (literal "/") (literal "/dev/null") (literal "/dev/urandom") (literal "/dev/random") '
    + readWhitelist.map((p) => '(subpath ' + quote(p) + ')').join(' ') + ')\n'
    + '(allow file-write* (subpath ' + quote(scratch) + ') (literal "/dev/null"))\n'
  // No inherited provider tokens, proxies, NODE_OPTIONS, BASH_ENV or HOME.
  const env = { PATH: dirname(node) + ':/usr/bin:/bin:/usr/sbin:/sbin', AGOS_VERIFY_SCRATCH: scratch,
    TMPDIR: scratch, TMP: scratch, TEMP: scratch, LANG: 'C.UTF-8', LC_ALL: 'C', TZ: 'UTC', OPENSSL_CONF: '/dev/null' }
  const launcher = { file: '/usr/bin/sandbox-exec', before: ['-p', profile, '/bin/bash', '-c'] }
  // The boundary is only trusted after a real in-sandbox smoke proves each property.
  const smoke = await runSeatbeltSmoke({ launcher, env, evaluator: root, scratch })
  if (!smoke.ok) return { ok: false, reason: smoke.reason }
  return {
    ok: true,
    profile,
    launcher,
    env,
    scratch,
    kind: 'macos-seatbelt',
    capabilities: ['seatbelt-profile', 'deny-default', ...smoke.checks.filter((c) => c.status === 'verified').map((c) => `verified:${c.name}`)],
    // Structured isolation manifest: independent per-dimension fields, never a
    // single merged boundary string. Every check names what was actually run.
    isolation: {
      backend: 'macos-seatbelt',
      readScope: { kind: 'profile-whitelist', paths: readWhitelist },
      writeScope: { kind: 'single-path', paths: [scratch] },
      network: { status: 'denied', enforcedBy: 'seatbelt deny-default (no socket allow rule)' },
      environment: { inherited: false, keys: Object.keys(env).sort(), enforcedBy: 'explicit env at spawn; nothing inherited' },
      processCleanup: { strategy: 'process-group kill on timeout/abort', enforcedBy: 'execCommand (backend-independent)' },
      seccomp: { available: false, applied: false },
      checks: smoke.checks,
    },
  }
}

export function gitCommand(cwd, args, { signal, timeoutMs = 60000 } = {}) {
  const started = Date.now()
  const argv = ['-C', cwd, ...args]
  const command = `git ${args.join(' ')}`
  return new Promise((resolve) => {
    const state = { done: false, timer: null, killTimer: null, signal, onAbort: null }
    let stdout = ''
    let stderr = ''
    const child = spawn('git', argv, {
      env: gitEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const done = (exitCode, extra = {}) => finishProc(state, resolve, {
      command,
      exitCode: exitCode == null ? null : exitCode,
      stdout: stdout.replace(/\s+$/, ''),
      stderr,
      text: (stdout + (stderr ? `\n${stderr}` : '')).replace(/\s+$/, ''),
      elapsedMs: Date.now() - started,
      cancelled: extra.cancelled === true,
      signal: extra.signal || null,
    })
    state.onAbort = () => {
      try { child.kill('SIGTERM') } catch { /* gone */ }
      state.killTimer = setTimeout(() => { try { child.kill('SIGKILL') } catch { /* gone */ } }, 1500)
    }
    if (signal) {
      if (signal.aborted) state.onAbort()
      else signal.addEventListener('abort', state.onAbort, { once: true })
    }
    state.timer = setTimeout(() => state.onAbort(), timeoutMs)
    child.stdout.on('data', (chunk) => { stdout = appendCapped(stdout, String(chunk)) })
    child.stderr.on('data', (chunk) => { stderr = appendCapped(stderr, String(chunk)) })
    child.on('error', (err) => done(null, { signal: err.message }))
    child.on('close', (code, sig) => done(code, {
      cancelled: Boolean(signal?.aborted),
      signal: sig || null,
    }))
  })
}

async function walkRelPaths(root) {
  const out = []
  const visit = async (dir, rel) => {
    const entries = await readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      if (!rel && entry.name === '.git') continue
      const childRel = rel ? `${rel}/${entry.name}` : entry.name
      const full = join(dir, entry.name)
      if (entry.isDirectory()) await visit(full, childRel)
      else out.push(childRel)
    }
  }
  await visit(root, '')
  return out.sort()
}

async function fileFingerprint(fullPath) {
  const info = await lstat(fullPath)
  if (info.isSymbolicLink()) {
    const target = await readlink(fullPath)
    return { kind: 'symlink', mode: info.mode, sha256: createHash('sha256').update(target).digest('hex'), size: info.size }
  }
  const buf = await readFile(fullPath)
  return {
    kind: 'file',
    mode: info.mode,
    size: buf.length,
    sha256: createHash('sha256').update(buf).digest('hex'),
  }
}

export async function snapshotWorktreeFiles(root) {
  const files = {}
  const listed = await gitCommand(root, ['ls-files', '-co', '--exclude-standard', '-z'])
  if (listed.exitCode !== 0) throw new Error('cannot enumerate source repository')
  for (const rel of new Set(listed.stdout.split('\0').filter(Boolean))) {
    if (!await lstat(join(root, rel)).catch(() => null)) continue
    files[rel] = await fileFingerprint(join(root, rel))
  }
  return files
}

function filesEqual(a, b) {
  const keysA = Object.keys(a || {})
  const keysB = Object.keys(b || {})
  if (keysA.length !== keysB.length) return false
  for (const key of keysA) {
    const left = a[key]
    const right = b[key]
    if (!right) return false
    if (left.kind !== right.kind || left.sha256 !== right.sha256 || left.size !== right.size || left.mode !== right.mode) return false
  }
  return true
}

async function snapshotMatchingFiles(root, globs) {
  const files = {}
  for (const rel of await walkRelPaths(root)) {
    if (matchesAnyGlob(rel, globs)) files[rel] = (await fileFingerprint(join(root, rel))).sha256
  }
  return files
}

function snapshotDelta(before, after) {
  const changed = []
  for (const key of new Set([...Object.keys(before || {}), ...Object.keys(after || {})])) {
    if ((before || {})[key] !== (after || {})[key]) changed.push(key)
  }
  return changed.sort()
}

export async function captureRepoEvidence(repo) {
  const head = await gitCommand(repo, ['rev-parse', 'HEAD'])
  const branch = await gitCommand(repo, ['symbolic-ref', '--quiet', '--short', 'HEAD'])
  const detached = await gitCommand(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])
  const status = await gitCommand(repo, ['status', '--porcelain=v1', '-uall'])
  const staged = await gitCommand(repo, ['diff', '--cached', '--binary'])
  const unstaged = await gitCommand(repo, ['diff', '--binary'])
  const index = await gitCommand(repo, ['ls-files', '-s'])
  const files = await snapshotWorktreeFiles(repo)
  return {
    cwd: process.cwd(),
    head: head.stdout,
    branch: branch.exitCode === 0 ? branch.stdout : `detached:${detached.stdout}`,
    statusPorcelain: status.stdout,
    stagedDiff: staged.stdout,
    unstagedDiff: unstaged.stdout,
    indexListing: index.stdout,
    files,
    commands: [head, branch, status, staged, unstaged, index].map((c) => evidenceCommand(c.command, c.exitCode)),
  }
}

export function evidenceEqual(a, b) {
  if (!a || !b) return false
  return a.head === b.head
    && a.branch === b.branch
    && a.statusPorcelain === b.statusPorcelain
    && a.stagedDiff === b.stagedDiff
    && a.unstagedDiff === b.unstagedDiff
    && a.indexListing === b.indexListing
    && filesEqual(a.files, b.files)
}

function porcelainPaths(text) {
  const paths = []
  for (const line of String(text || '').split(/\r?\n/)) {
    if (!line) continue
    if (line.length < 4 || line[2] !== ' ') continue
    const rest = line.slice(3)
    paths.push(rest.includes(' -> ') ? rest.split(' -> ').pop() : rest)
  }
  return paths
}

async function resetIsolated(dir, sha, signal) {
  const reset = await gitCommand(dir, ['reset', '--hard', sha], { signal })
  const clean = await gitCommand(dir, ['clean', '-fdx'], { signal })
  const after = await gitCommand(dir, ['rev-parse', 'HEAD'], { signal })
  const ok = reset.exitCode === 0 && clean.exitCode === 0 && after.exitCode === 0 && after.stdout === sha
  return { reset, clean, after, ok, shaAfter: after.stdout }
}

function iterationResult(fields) {
  return {
    status: fields.status,
    kept: fields.kept === true,
    rolledBack: fields.rolledBack === true,
    shaBefore: fields.shaBefore,
    shaAfter: fields.shaAfter,
    metric: fields.metric,
    baselineMetric: fields.baselineMetric,
    comparison: fields.comparison,
    protectedViolation: fields.protectedViolation === true,
    protectedChanged: fields.protectedChanged || [],
    allowlistViolation: fields.allowlistViolation === true,
    reason: fields.reason,
    commands: fields.commands || [],
  }
}

/**
 * @param {{ sourceRepo: string, baselineSha?: string, workRoot?: string, sourceAllowlist?: string[], protectedPaths?: string[] }} opts
 */
export async function createIsolatedAutoresearchWorkspace({
  sourceRepo,
  baselineSha,
  workRoot,
  sourceAllowlist,
  protectedPaths,
} = {}) {
  if (!sourceRepo) throw new Error('createIsolatedAutoresearchWorkspace requires sourceRepo')
  const resolvedSource = resolve(sourceRepo)
  const sourceStat = await stat(resolvedSource)
  if (!sourceStat.isDirectory()) throw new Error('sourceRepo is not a directory')

  const original = await captureRepoEvidence(resolvedSource)
  const parsed = await gitCommand(resolvedSource, ['rev-parse', baselineSha || 'HEAD'])
  if (parsed.exitCode !== 0 || !parsed.stdout) {
    return {
      ok: false,
      error: 'baseline-sha-missing',
      commands: [...original.commands, evidenceCommand(parsed.command, parsed.exitCode)],
      original,
    }
  }
  const baseline = parsed.stdout
  const ownsWorkRoot = !workRoot
  const root = workRoot ? resolve(workRoot) : await mkdtemp(join(tmpdir(), 'agos-autoresearch-'))
  await mkdir(root, { recursive: true })
  const isolatedDir = join(root, 'isolated')

  const clone = await gitCommand(root, [
    'clone',
    '--quiet',
    '--no-local',
    '--no-checkout',
    '-c', 'commit.gpgsign=false',
    '-c', 'user.email=agos-autoresearch@local',
    '-c', 'user.name=agos-autoresearch',
    resolvedSource,
    isolatedDir,
  ])
  if (clone.exitCode !== 0) {
    return {
      ok: false,
      error: 'clone-failed',
      commands: [evidenceCommand(clone.command, clone.exitCode)],
      original,
    }
  }

  const checkout = await gitCommand(isolatedDir, ['checkout', '--quiet', '--detach', baseline])
  if (checkout.exitCode !== 0) {
    return {
      ok: false,
      error: 'checkout-failed',
      commands: [evidenceCommand(clone.command, clone.exitCode), evidenceCommand(checkout.command, checkout.exitCode)],
      original,
    }
  }

  const trustedDir = join(root, 'trusted-baseline')
  const trustedClone = await gitCommand(root, ['clone', '--quiet', '--no-local', '--no-checkout', resolvedSource, trustedDir])
  const trustedCheckout = trustedClone.exitCode === 0
    ? await gitCommand(trustedDir, ['checkout', '--quiet', '--detach', baseline]) : trustedClone
  if (trustedCheckout.exitCode !== 0) {
    await rm(root, { recursive: true, force: true })
    return { ok: false, error: 'trusted-baseline-failed' }
  }

  const allow = Object.freeze([...(sourceAllowlist || DEFAULT_SOURCE_ALLOWLIST)])
  const prot = Object.freeze([...(protectedPaths || DEFAULT_PROTECTED_PATHS)])
  const isolatedHead = await gitCommand(isolatedDir, ['rev-parse', 'HEAD'])
  const afterCreate = await captureRepoEvidence(resolvedSource)

  return {
    ok: true,
    sourceRepo: resolvedSource,
    baselineSha: baseline,
    workRoot: root,
    isolatedDir,
    trustedDir,
    isolatedHead: isolatedHead.stdout,
    ownsWorkRoot,
    original,
    originalIntactAfterCreate: evidenceEqual(original, afterCreate),
    sourceAllowlist: allow,
    protectedPaths: prot,
    protectedSnapshot: await snapshotMatchingFiles(isolatedDir, prot),
    bestMetric: undefined,
    baselineMetric: undefined,
    commands: [clone, checkout, isolatedHead].map((c) => evidenceCommand(c.command, c.exitCode)),
  }
}

/** The model has no tools. Only a bounded, allowlisted patch crosses this boundary. */
export async function applyCandidatePatch(workspace, patch) {
  const text = String(patch || '').trim()
  if (!text || Buffer.byteLength(text) > 512 * 1024) return { ok: false, reason: 'invalid-patch-size' }
  const path = join(workspace.workRoot, 'proposal.patch')
  await writeFile(path, text + '\n')
  const summary = await gitCommand(workspace.isolatedDir, ['apply', '--numstat', '-z', path])
  if (summary.exitCode !== 0) return { ok: false, reason: 'invalid-patch' }
  const paths = summary.stdout.split('\0').filter(Boolean).map((row) => row.split('\t').slice(2).join('\t'))
  if (!paths.length || paths.some((p) => !p || p.startsWith('/') || p.split('/').some((x) => x === '..' || x === '.git')
      || classifyPath(p, workspace.sourceAllowlist, workspace.protectedPaths) !== 'source')) {
    return { ok: false, reason: 'patch-outside-source-allowlist' }
  }
  // Git apply itself rejects symlink traversal. Also reject symlink/mode patches;
  // candidates produce ordinary source bytes only.
  if (/^(?:new|old|deleted) (?:file )?mode (?!100644|100755)/m.test(text)
      || /^index [^\n]+ 120000/m.test(text)) return { ok: false, reason: 'patch-nonregular-file' }
  const check = await gitCommand(workspace.isolatedDir, ['apply', '--check', path])
  if (check.exitCode !== 0) return { ok: false, reason: 'patch-does-not-apply' }
  const applied = await gitCommand(workspace.isolatedDir, ['apply', path])
  return { ok: applied.exitCode === 0, reason: applied.exitCode === 0 ? undefined : 'patch-apply-failed' }
}

/** Supply source bytes, never a shell or filesystem capability, to the proposer. */
export async function candidateSourceContext(workspace, maxBytes = 192 * 1024) {
  const listing = await gitCommand(workspace.isolatedDir, ['ls-files', '-z'])
  if (listing.exitCode !== 0) throw new Error('source enumeration failed')
  let context = '', bytes = 0
  for (const rel of listing.stdout.split('\0').filter(Boolean)) {
    if (classifyPath(rel, workspace.sourceAllowlist, workspace.protectedPaths) !== 'source') continue
    const info = await lstat(join(workspace.isolatedDir, rel))
    if (!info.isFile() || info.nlink > 1) throw new Error('source context contains a nonregular or linked file')
    const content = await readFile(join(workspace.isolatedDir, rel), 'utf8')
    bytes += Buffer.byteLength(content)
    if (bytes > maxBytes) throw new Error('source context exceeds 192 KiB; narrow scope')
    context += '\n--- ' + rel + ' ---\n' + content
  }
  if (!context) throw new Error('no source files match scope')
  return context
}

/** Fresh baseline evaluator, plus candidate source diff. No candidate test/config files. */
async function verifyCandidate(workspace, verifyCmd, signal) {
  const failure = (reason) => ({ command: String(verifyCmd), exitCode: 1, stdout: '', stderr: reason, text: reason })
  if (workspace.verifyCmd !== undefined && String(verifyCmd) !== workspace.verifyCmd) return failure('verification-command-changed')
  if (!workspace.trustedDir) return failure('trusted-baseline-missing')
  const root = await mkdtemp(join(tmpdir(), 'agos-autoresearch-eval-'))
  try {
    const evaluator = join(root, 'repo')
    const cloned = await gitCommand(root, ['clone', '--quiet', '--no-local', workspace.trustedDir, evaluator], { signal })
    if (cloned.exitCode !== 0) return failure('evaluator-clone-failed')
    const diff = await gitCommand(workspace.isolatedDir, ['diff', '--binary', workspace.baselineSha, '--'], { signal })
    const names = await gitCommand(workspace.isolatedDir, ['diff', '--name-only', '-z', workspace.baselineSha, '--'], { signal })
    if (diff.exitCode !== 0 || names.exitCode !== 0) return failure('candidate-diff-failed')
    for (const rel of names.stdout.split('\0').filter(Boolean)) {
      if (classifyPath(rel, workspace.sourceAllowlist, workspace.protectedPaths) !== 'source') return failure('candidate-mutated-verification-materials')
      const info = await lstat(join(workspace.isolatedDir, rel)).catch(() => null)
      if (info && (!info.isFile() || info.nlink > 1)) return failure('candidate-nonregular-file')
    }
    if (diff.stdout) {
      const patch = join(root, 'source.patch')
      await writeFile(patch, diff.stdout + '\n')
      const applied = await gitCommand(evaluator, ['apply', patch], { signal })
      if (applied.exitCode !== 0) return failure('evaluator-source-apply-failed')
    }
    const sandbox = await verificationSandbox(evaluator)
    if (!sandbox.ok) return { ...failure(sandbox.reason), unavailable: true }
    workspace.verificationBoundary = sandbox.kind
    workspace.verificationCapabilities = sandbox.capabilities || [sandbox.kind]
    workspace.isolationManifest = sandbox.isolation || null
    const materials = async () => {
      const snapshot = {}
      for (const rel of await walkRelPaths(evaluator)) {
        if (rel.startsWith('.agos-verification-tmp/')) continue
        if (classifyPath(rel, workspace.sourceAllowlist, workspace.protectedPaths) !== 'source') {
          snapshot[rel] = await fileFingerprint(join(evaluator, rel))
        }
      }
      return snapshot
    }
    const before = await materials()
    const verified = await execCommand(verifyCmd, { cwd: evaluator, signal, sandboxLauncher: sandbox.launcher, env: sandbox.env })
    if (!filesEqual(before, await materials())) return failure('verification-materials-changed-during-evaluation')
    return verified
  } finally { await rm(root, { recursive: true, force: true }) }
}

/** Save an importable patch and provenance before the temporary clone is removed. */
export async function saveAutoresearchArtifacts(workspace, artifactDir, details = {}) {
  const diff = await gitCommand(workspace.isolatedDir, ['diff', '--binary', workspace.baselineSha, workspace.isolatedHead, '--'])
  if (diff.exitCode !== 0) throw new Error('cannot export accepted source diff')
  await mkdir(artifactDir, { recursive: true })
  const patchPath = join(artifactDir, 'accepted.patch')
  const manifestPath = join(artifactDir, 'manifest.json')
  await writeFile(patchPath, diff.stdout ? diff.stdout + '\n' : '')
  const originalNow = await captureRepoEvidence(workspace.sourceRepo)
  const manifest = { ...details, baselineSha: workspace.baselineSha, acceptedSha: workspace.isolatedHead,
    originalIntactAtExport: evidenceEqual(workspace.original, originalNow),
    baselineMetric: workspace.baselineMetric, bestMetric: workspace.bestMetric,
    sourceAllowlist: workspace.sourceAllowlist, verificationCommand: workspace.verifyCmd,
    verificationBoundary: workspace.verificationBoundary || 'unavailable',
    verificationCapabilities: workspace.verificationCapabilities || [],
    isolation: workspace.isolationManifest || null,
    patchSha256: createHash('sha256').update(await readFile(patchPath)).digest('hex'),
    at: new Date().toISOString() }
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
  return { patchPath, manifestPath }
}

export async function measureIsolatedBaseline({ workspace, verifyCmd, metricSpec, signal } = {}) {
  const commands = []
  if (!workspace?.isolatedDir) return { ok: false, status: 'child-failed', reason: 'no-workspace', commands }
  if (signal?.aborted) return { ok: false, status: 'cancelled', commands, rolledBack: false, kept: false }
  workspace.verifyCmd = String(verifyCmd)
  const verify = await verifyCandidate(workspace, verifyCmd, signal)
  commands.push(evidenceCommand(verify.command, verify.exitCode))
  if (verify.cancelled || signal?.aborted) return { ok: false, status: 'cancelled', commands, kept: false, rolledBack: false }
  if (verify.unavailable) return { ok: false, status: 'verification-unavailable', reason: verify.stderr, commands }
  if (verify.exitCode !== 0) return { ok: false, status: 'verify-failed', commands, exitCode: verify.exitCode }
  const extracted = extractStructuredMetric(verify.stdout, metricSpec)
  if (!extracted.ok) return { ok: false, status: 'metric-missing', commands, extract: extracted }
  workspace.baselineMetric = extracted.value
  workspace.bestMetric = extracted.value
  return { ok: true, status: 'ok', commands, metric: extracted.value, extract: extracted }
}

/**
 * @param {{
 *   workspace: object,
 *   verifyCmd: string,
 *   runCmd?: string,
 *   direction?: 'higher'|'lower',
 *   protectedPaths?: string[],
 *   sourceAllowlist?: string[],
 *   metricSpec?: object,
 *   signal?: AbortSignal,
 *   commitMessage?: string,
 *   baselineMetric?: number,
 * }} opts
 */
export async function runAutoresearchIteration({
  workspace,
  verifyCmd,
  runCmd,
  direction = 'higher',
  protectedPaths,
  sourceAllowlist,
  metricSpec,
  signal,
  commitMessage = 'autoresearch iteration',
  baselineMetric,
} = {}) {
  const commands = []
  const record = (result) => {
    commands.push(evidenceCommand(result.command, result.exitCode))
    return result
  }

  if (!workspace?.isolatedDir) {
    return iterationResult({ status: 'child-failed', reason: 'no-workspace', commands, shaBefore: null, shaAfter: null })
  }

  const isolatedDir = workspace.isolatedDir
  const shaBeforeCmd = await gitCommand(isolatedDir, ['rev-parse', 'HEAD'], { signal })
  record(shaBeforeCmd)
  // The last accepted SHA is owned by the controller, never by candidate code.
  const shaBefore = workspace.isolatedHead
  if (shaBeforeCmd.exitCode !== 0 || shaBeforeCmd.stdout !== shaBefore) {
    return iterationResult({ status: 'workspace-drift', reason: 'candidate-changed-head', shaBefore, shaAfter: shaBeforeCmd.stdout, commands })
  }
  const allow = sourceAllowlist || workspace.sourceAllowlist || DEFAULT_SOURCE_ALLOWLIST
  const prot = protectedPaths || workspace.protectedPaths || DEFAULT_PROTECTED_PATHS
  if (FINITE_METRIC(baselineMetric) !== undefined && !Number.isFinite(workspace.bestMetric)) {
    workspace.bestMetric = FINITE_METRIC(baselineMetric)
    if (!Number.isFinite(workspace.baselineMetric)) workspace.baselineMetric = workspace.bestMetric
  }
  const previous = FINITE_METRIC(workspace.bestMetric)

  const rollback = async (status, extra = {}) => {
    const hadCommit = extra.hadCommit === true
    const rb = await resetIsolated(isolatedDir, shaBefore)
    record(rb.reset)
    record(rb.clean)
    record(rb.after)
    return iterationResult({
      status,
      kept: false,
      rolledBack: hadCommit && rb.ok,
      shaBefore,
      shaAfter: rb.shaAfter,
      commands,
      metric: extra.metric,
      baselineMetric: extra.baselineMetric ?? previous,
      comparison: extra.comparison,
      protectedViolation: extra.protectedViolation,
      protectedChanged: extra.protectedChanged,
      allowlistViolation: extra.allowlistViolation,
      reason: extra.reason,
    })
  }

  if (signal?.aborted) {
    return iterationResult({ status: 'cancelled', shaBefore, shaAfter: shaBefore, commands, baselineMetric: previous })
  }

  if (!Number.isFinite(previous)) {
    const measured = await measureIsolatedBaseline({ workspace, verifyCmd, metricSpec, signal })
    commands.push(...measured.commands)
    if (!measured.ok) {
      return iterationResult({
        status: measured.status,
        shaBefore,
        shaAfter: shaBefore,
        commands,
        reason: 'baseline-required',
      })
    }
  }
  const best = FINITE_METRIC(workspace.bestMetric)

  if (runCmd) {
    const child = record(await execCommand(runCmd, { cwd: isolatedDir, signal }))
    if (child.cancelled || signal?.aborted) {
      return iterationResult({
        status: 'cancelled',
        shaBefore,
        shaAfter: shaBefore,
        commands,
        baselineMetric: best,
      })
    }
    if (child.exitCode !== 0) {
      const rb = await resetIsolated(isolatedDir, shaBefore, signal)
      record(rb.reset)
      record(rb.clean)
      record(rb.after)
      return iterationResult({
        status: 'child-failed',
        shaBefore,
        shaAfter: rb.shaAfter,
        commands,
        baselineMetric: best,
        reason: `runCmd exit ${child.exitCode}`,
      })
    }
  }

  const status = record(await gitCommand(isolatedDir, ['status', '--porcelain=v1', '-uall'], { signal }))
  const dirty = porcelainPaths(status.stdout)
  const protectedNow = await snapshotMatchingFiles(isolatedDir, prot)
  const protectedChanged = snapshotDelta(workspace.protectedSnapshot || {}, protectedNow)
  const dirtyProtected = dirty.filter((p) => classifyPath(p, allow, prot) === 'protected')
  const dirtyBlocked = dirty.filter((p) => classifyPath(p, allow, prot) === 'blocked')
  const dirtySource = dirty.filter((p) => classifyPath(p, allow, prot) === 'source')

  if (protectedChanged.length || dirtyProtected.length) {
    return rollback('protected-violation', {
      hadCommit: false,
      protectedViolation: true,
      protectedChanged: [...new Set([...protectedChanged, ...dirtyProtected])],
      baselineMetric: best,
      reason: 'candidate-mutated-verification-materials',
    })
  }
  if (dirtyBlocked.length) {
    return rollback('allowlist-violation', {
      hadCommit: false,
      allowlistViolation: true,
      baselineMetric: best,
      reason: `outside-allowlist:${dirtyBlocked.join(',')}`,
    })
  }
  if (!dirtySource.length) {
    return iterationResult({
      status: 'commit-failed',
      shaBefore,
      shaAfter: shaBefore,
      commands,
      baselineMetric: best,
      reason: 'no-allowlisted-changes',
    })
  }

  const add = record(await gitCommand(isolatedDir, ['add', '--', ...dirtySource], { signal }))
  if (add.cancelled || signal?.aborted) return rollback('cancelled', { hadCommit: false, baselineMetric: best })
  if (add.exitCode !== 0) return rollback('commit-failed', { hadCommit: false, baselineMetric: best, reason: 'git-add-failed' })

  const commit = record(await gitCommand(isolatedDir, ['commit', '-m', commitMessage], { signal }))
  if (commit.cancelled || signal?.aborted) return rollback('cancelled', { hadCommit: commit.exitCode === 0, baselineMetric: best })
  if (commit.exitCode !== 0) return rollback('commit-failed', { hadCommit: false, baselineMetric: best, reason: 'git-commit-failed' })

  const shaCommitted = record(await gitCommand(isolatedDir, ['rev-parse', 'HEAD'], { signal }))
  if (shaCommitted.exitCode !== 0) return rollback('commit-failed', { hadCommit: true, baselineMetric: best, reason: 'sha-after-commit-missing' })

  const verify = record(await verifyCandidate(workspace, verifyCmd, signal))
  if (verify.cancelled || signal?.aborted) {
    return rollback('cancelled', { hadCommit: true, baselineMetric: best })
  }
  if (verify.unavailable) return rollback('verification-unavailable', { hadCommit: true, baselineMetric: best, reason: verify.stderr })
  if (verify.exitCode !== 0) {
    return rollback('verify-failed', {
      hadCommit: true,
      baselineMetric: best,
      reason: `verify exit ${verify.exitCode}`,
    })
  }

  const extracted = extractStructuredMetric(verify.stdout, metricSpec)
  if (!extracted.ok) {
    return rollback('metric-missing', { hadCommit: true, baselineMetric: best, reason: extracted.error })
  }

  const comparison = compareMetric(extracted.value, best, direction)
  if (!comparison.improved) {
    return rollback('no-improvement', {
      hadCommit: true,
      metric: extracted.value,
      baselineMetric: best,
      comparison,
    })
  }

  workspace.bestMetric = extracted.value
  workspace.isolatedHead = shaCommitted.stdout
  return iterationResult({
    status: 'improved',
    kept: true,
    rolledBack: false,
    shaBefore,
    shaAfter: shaCommitted.stdout,
    metric: extracted.value,
    baselineMetric: best,
    comparison,
    commands,
  })
}

/**
 * @param {object} workspace
 * @returns {Promise<{ cleaned: boolean, originalIntact: boolean, isolatedHead: string|null, status?: string, commands: object[], cleanupError?: string }>}
 */
export async function disposeWorkspace(workspace) {
  const commands = []
  let isolatedHead = workspace?.isolatedHead ?? null
  if (workspace?.isolatedDir) {
    const head = await gitCommand(workspace.isolatedDir, ['rev-parse', 'HEAD']).catch(() => null)
    if (head) {
      commands.push(evidenceCommand(head.command, head.exitCode))
      if (head.exitCode === 0 && head.stdout) isolatedHead = head.stdout
    }
  }

  const target = workspace?.ownsWorkRoot ? workspace.workRoot : workspace?.isolatedDir
  let cleaned = false
  let cleanupError
  try {
    if (target) {
      await rm(target, { recursive: true, force: true })
      if (!workspace.ownsWorkRoot && workspace.trustedDir) await rm(workspace.trustedDir, { recursive: true, force: true })
      try {
        await stat(target)
        cleaned = false
        cleanupError = 'cleanup-target-still-exists'
      } catch {
        cleaned = true
      }
    } else {
      cleaned = true
    }
  } catch (err) {
    cleaned = false
    cleanupError = String(err && err.message ? err.message : err)
  }

  let originalIntact = false
  if (workspace?.sourceRepo && workspace?.original) {
    const current = await captureRepoEvidence(workspace.sourceRepo)
    commands.push(...current.commands)
    originalIntact = evidenceEqual(workspace.original, current)
      && current.cwd === workspace.original.cwd
      && process.cwd() === workspace.original.cwd
  }

  return {
    cleaned,
    originalIntact,
    isolatedHead,
    status: cleaned ? (originalIntact ? 'disposed' : 'original-drift') : 'cleanup-failed',
    cleanupError,
    commands,
  }
}
