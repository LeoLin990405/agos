import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

const EXPECTED_CODEX_SDK_VERSION = '0.147.0'
const DEFAULT_CODEX_WORKSPACE = '~/.dsh/workspaces/codex'
const RUN_ID_RE = /^[A-Za-z0-9_-]{1,64}$/

const errorText = (error) => String(error?.message ?? error ?? 'Codex SDK failed')
const isTimeoutReason = (reason) => {
  const value = String(reason?.code ?? reason?.message ?? reason ?? '').trim().toUpperCase()
  return value === 'TIMEOUT'
}

function expandCodexWorkspace(value = DEFAULT_CODEX_WORKSPACE, home = homedir()) {
  const raw = String(value || DEFAULT_CODEX_WORKSPACE).trim().replace(/\/+$/, '')
  if (!raw) throw new TypeError('Codex workspace is required')
  if (raw === '~') return resolve(home)
  if (raw.startsWith('~/')) return resolve(home, raw.slice(2))
  if (raw.startsWith('~')) throw new TypeError('Codex workspace only supports ~ or ~/ paths')
  if (!isAbsolute(raw)) throw new TypeError('Codex workspace must be absolute')
  return resolve(raw)
}

function codexProcessEnv(home = homedir(), source = process.env) {
  const path = [
    join(home, 'bin'), '/opt/homebrew/bin', '/opt/homebrew/sbin',
    join(home, '.npm-global', 'bin'), join(home, '.local', 'bin'),
    '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin', '/Library/Apple/usr/bin',
  ].join(':')
  const env = {
    HOME: home,
    CODEX_HOME: join(home, '.codex'),
    PATH: path,
    USER: String(source.USER || ''),
    LOGNAME: String(source.LOGNAME || source.USER || ''),
    SHELL: String(source.SHELL || '/bin/sh'),
    LANG: String(source.LANG || 'en_US.UTF-8'),
    NO_COLOR: '1',
  }
  for (const key of ['LC_ALL', 'LC_CTYPE', 'TERM']) {
    if (source[key]) env[key] = String(source[key])
  }
  return env
}

function codexConfig(runDir, home = homedir()) {
  const toolTmp = join(runDir, '.codex-tmp')
  return {
    shell_environment_policy: {
      inherit: 'none',
      ignore_default_excludes: false,
      set: {
        HOME: runDir,
        PATH: codexProcessEnv(home).PATH,
        TMPDIR: toolTmp,
        LANG: 'en_US.UTF-8',
        NO_COLOR: '1',
      },
    },
    sandbox_workspace_write: {
      network_access: false,
      exclude_tmpdir_env_var: true,
      exclude_slash_tmp: true,
    },
  }
}

function isWithin(parent, candidate) {
  const rel = relative(parent, candidate)
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel))
}

async function assertPlainDirectory(path, label, fsApi = fs) {
  const stat = await fsApi.lstat(path)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${label} must be a real directory`)
}

async function ensureCodexRunDir(workspace, runId, fsApi = fs) {
  if (!RUN_ID_RE.test(String(runId || ''))) throw new TypeError('invalid run id')
  const root = expandCodexWorkspace(workspace)
  await fsApi.mkdir(root, { recursive: true, mode: 0o700 })
  await assertPlainDirectory(root, 'Codex workspace', fsApi)
  const tasks = join(root, 'tasks')
  await fsApi.mkdir(tasks, { recursive: true, mode: 0o700 })
  await assertPlainDirectory(tasks, 'Codex tasks directory', fsApi)
  const runDir = join(tasks, runId)
  await fsApi.mkdir(runDir, { recursive: true, mode: 0o700 })
  await assertPlainDirectory(runDir, 'Codex run directory', fsApi)

  const [rootReal, tasksReal, runReal] = await Promise.all([
    fsApi.realpath(root), fsApi.realpath(tasks), fsApi.realpath(runDir),
  ])
  if (!isWithin(rootReal, tasksReal) || !isWithin(tasksReal, runReal)) {
    throw new Error('Codex run directory escaped its workspace')
  }
  return runReal
}

async function atomicWrite(path, value, fsApi = fs) {
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`
  try {
    await fsApi.writeFile(temporary, value, { encoding: 'utf8', mode: 0o600 })
    await fsApi.rename(temporary, path)
  } catch (error) {
    try { await fsApi.unlink(temporary) } catch {}
    throw error
  }
}

function createCodexHostRunner({
  loadSdk = () => import('@openai/codex-sdk'),
  fsApi = fs,
  scrubSecrets = (value) => String(value ?? ''),
  now = Date.now,
  home = homedir(),
} = {}) {
  let sdkPromise
  const workspaceOf = (host, fallback = DEFAULT_CODEX_WORKSPACE) =>
    expandCodexWorkspace(host?.workspace || fallback, home)
  const runDirOf = (host, runId, fallback = DEFAULT_CODEX_WORKSPACE) => {
    if (!RUN_ID_RE.test(String(runId || ''))) throw new TypeError('invalid run id')
    return join(workspaceOf(host, fallback), 'tasks', runId)
  }
  const sdk = async () => {
    if (!sdkPromise) sdkPromise = Promise.resolve(loadSdk())
    const loaded = await sdkPromise
    if (typeof loaded?.Codex !== 'function') throw new TypeError('Codex SDK does not export Codex')
    return loaded
  }

  const probe = async () => {
    try {
      await sdk()
      return { at: now(), ok: true, version: `codex-sdk ${EXPECTED_CODEX_SDK_VERSION}` }
    } catch (error) {
      return { at: now(), ok: false, error: scrubSecrets(errorText(error)).slice(0, 500) }
    }
  }

  const persistOutcome = async (runDir, { out = '', err = '', exit }) => {
    await atomicWrite(join(runDir, 'out.txt'), scrubSecrets(out), fsApi)
    await atomicWrite(join(runDir, 'err.txt'), scrubSecrets(err), fsApi)
    await atomicWrite(join(runDir, 'exit'), String(exit), fsApi)
  }

  const run = async (host, prompt, signal, assignment = {}) => {
    const t0 = now()
    const runId = assignment.runId
    const base = { host: host.name, runId, text: '', ms: 0 }
    if (signal?.aborted) return { ...base, ok: false, cancelled: true, error: '已取消（未启动）' }

    let runDir
    try {
      const workspace = workspaceOf(host, assignment.workspace || DEFAULT_CODEX_WORKSPACE)
      runDir = await ensureCodexRunDir(workspace, runId, fsApi)
      await fsApi.mkdir(join(runDir, '.codex-tmp'), { recursive: true, mode: 0o700 })
    } catch (error) {
      return { ...base, ok: false, error: scrubSecrets(errorText(error)), ms: now() - t0 }
    }

    const turnAbort = new AbortController()
    let abortKind = null
    const onAbort = () => {
      if (abortKind) return
      // The shared runtime uses the same controller for user cancellation and
      // its timeout watchdog. Preserve that distinction in the durable outcome.
      abortKind = isTimeoutReason(signal?.reason) ? 'timeout' : 'cancelled'
      try { turnAbort.abort(signal?.reason) } catch {}
    }
    if (signal) {
      signal.addEventListener('abort', onAbort, { once: true })
      // Close the check→listener race while the local run directory was being prepared.
      if (signal.aborted) onAbort()
    }
    const timeoutMs = Number(assignment.timeoutMs) > 0 ? Number(assignment.timeoutMs) : 0
    const timer = timeoutMs > 0 ? setTimeout(() => {
      if (abortKind) return
      abortKind = 'timeout'
      try { turnAbort.abort(new Error('TIMEOUT')) } catch {}
    }, timeoutMs) : null
    timer?.unref?.()

    try {
      if (abortKind) throw turnAbort.signal.reason || new Error(abortKind)
      const loaded = await sdk()
      if (abortKind) throw turnAbort.signal.reason || new Error(abortKind)
      const client = new loaded.Codex({
        env: codexProcessEnv(home),
        config: codexConfig(runDir, home),
      })
      const thread = client.startThread({
        ...(host.model ? { model: host.model } : {}),
        workingDirectory: runDir,
        sandboxMode: 'workspace-write',
        approvalPolicy: 'never',
        skipGitRepoCheck: true,
        networkAccessEnabled: false,
        webSearchMode: 'disabled',
      })
      const result = await thread.run(String(prompt ?? ''), { signal: turnAbort.signal })
      if (abortKind) throw turnAbort.signal.reason || new Error(abortKind)
      const text = scrubSecrets(result?.finalResponse ?? '')
      await persistOutcome(runDir, { out: text, err: '', exit: 0 })
      return { ...base, ok: true, text, error: '', exit: 0, ms: now() - t0, runDir }
    } catch (error) {
      const message = abortKind === 'timeout'
        ? `超时(${Math.round(timeoutMs / 1000)}s)`
        : abortKind === 'cancelled' ? '已取消' : scrubSecrets(errorText(error))
      const exit = abortKind === 'timeout' ? 124 : abortKind === 'cancelled' ? 130 : 1
      try { await persistOutcome(runDir, { out: '', err: message, exit }) } catch (persistError) {
        const combined = `${message}; failed to persist Codex outcome: ${errorText(persistError)}`
        return { ...base, ok: false, error: scrubSecrets(combined), exit, ms: now() - t0, runDir,
          ...(abortKind === 'timeout' ? { timedOut: true } : {}),
          ...(abortKind === 'cancelled' ? { cancelled: true } : {}) }
      }
      return { ...base, ok: false, error: message, exit, ms: now() - t0, runDir,
        ...(abortKind === 'timeout' ? { timedOut: true } : {}),
        ...(abortKind === 'cancelled' ? { cancelled: true } : {}) }
    } finally {
      if (timer) clearTimeout(timer)
      signal?.removeEventListener?.('abort', onAbort)
    }
  }

  return { probe, run, workspaceOf, runDirOf }
}

export {
  DEFAULT_CODEX_WORKSPACE,
  EXPECTED_CODEX_SDK_VERSION,
  codexConfig,
  codexProcessEnv,
  createCodexHostRunner,
  ensureCodexRunDir,
  expandCodexWorkspace,
  isWithin,
}
