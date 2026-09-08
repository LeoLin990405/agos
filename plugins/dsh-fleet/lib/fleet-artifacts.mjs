import { spawn } from 'node:child_process'
import { constants as fsConstants, promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, sep } from 'node:path'
import { scrubString } from '../../dsh-agos/lib/secrets-gate.js'

const RUN_ID_RE = /^[A-Za-z0-9_-]{1,64}$/
const ARTIFACT_MAX_BYTES = 512 * 1024 * 1024
const ARTIFACT_MAX_FILES = 2000
const ARTIFACT_DETAIL_SENTINEL = ARTIFACT_MAX_FILES + 1
const EXCLUDED_ARTIFACTS = Object.freeze(['pid', 'exit', 'err.txt', '.trace/**'])
const CODEX_INTERNAL_ARTIFACTS = Object.freeze(['.codex-tmp/**'])

const validateRunId = (value) => typeof value === 'string' && RUN_ID_RE.test(value)

// Keep this in lockstep with dsh-fleet's workspace path gate. Returning a
// canonical relative path makes every later shell fragment quote one known form.
const safeRelPath = (raw) => {
  const path = String(raw ?? '').trim()
  if (!path || /[\0\r\n]/.test(path)) return null
  if (path.startsWith('/') || path.startsWith('~')) return null
  if (/^[A-Za-z]:[\\/]/.test(path)) return null
  const parts = path.split('/').filter((part) => part !== '' && part !== '.')
  if (!parts.length || parts.some((part) => part === '..')) return null
  return parts.join('/')
}

const isExcludedArtifactPath = (raw) => {
  const path = safeRelPath(raw)
  if (!path) return true
  const parts = path.split('/')
  return parts.includes('.trace') || parts.some((part) => part === 'pid' || part === 'exit' || part === 'err.txt')
}

const isExcludedCodexArtifactPath = (raw) => {
  const path = safeRelPath(raw)
  return !path || isExcludedArtifactPath(path) || path.split('/').includes('.codex-tmp')
}

const shq = (value) => "'" + String(value).replace(/'/g, "'\\''") + "'"

const shellWorkspacePath = (workspace) => {
  const value = String(workspace ?? '').trim().replace(/\/+$/, '')
  if (!value) throw new TypeError('workspace is required')
  if (value === '~') return '"$HOME"'
  if (value.startsWith('~/')) return '"$HOME"/' + shq(value.slice(2))
  return shq(value)
}

const artifactRunDir = (workspace, runId) => {
  if (!validateRunId(runId)) throw new TypeError('invalid run id')
  const base = String(workspace ?? '').trim().replace(/\/+$/, '')
  if (!base) throw new TypeError('workspace is required')
  return `${base}/tasks/${runId}`
}

const runDirPrelude = (workspace, runId, { stream = false } = {}) => {
  if (!validateRunId(runId)) throw new TypeError('invalid run id')
  const missing = stream ? 'exit 9' : "printf 'E\\tRUN_NOT_FOUND\\n'; exit 0"
  const root = shellWorkspacePath(workspace)
  return [
    `[ -d ${root} ] && [ ! -L ${root} ] || { ${missing}; }`,
    `cd ${root} 2>/dev/null || { ${missing}; }`,
    `workspace_phys=$(pwd -P) || { ${missing}; }`,
    `[ -d tasks ] && [ ! -L tasks ] || { ${missing}; }`,
    `cd tasks 2>/dev/null || { ${missing}; }`,
    `tasks_phys=$(pwd -P) || { ${missing}; }`,
    `[ \"$tasks_phys\" = \"$workspace_phys/tasks\" ] || { ${missing}; }`,
    `[ -d ${shq(runId)} ] && [ ! -L ${shq(runId)} ] || { ${missing}; }`,
    `cd ${shq(runId)} 2>/dev/null || { ${missing}; }`,
    `run_phys=$(pwd -P) || { ${missing}; }`,
    `[ \"$run_phys\" = \"$tasks_phys/${runId}\" ] || { ${missing}; }`,
  ].join('; ')
}

// The control files live at the run root, while .trace may contain credentials
// in provider errors. Excluding matching basenames at every depth is deliberately
// stricter than the old workspace browser.
const artifactFind = "find . -maxdepth 6 -type f -not -name .trace -not -path '*/.trace/*' -not -name pid -not -name exit -not -name err.txt 2>/dev/null"

const dualStatShell = [
  `if size=$(stat -c '%s' \"$f\" 2>/dev/null); then mtime=$(stat -c '%Y' \"$f\" 2>/dev/null || printf 0)`,
  `elif size=$(stat -f '%z' \"$f\" 2>/dev/null); then mtime=$(stat -f '%m' \"$f\" 2>/dev/null || printf 0)`,
  `else size=0; mtime=0; fi`,
].join('; ')

// find -exec passes each pathname as an argv element, so embedded whitespace is
// never a record separator. CR/LF names cannot pass safeRelPath over HTTP and are
// therefore excluded consistently from the manifest and archive artifact set.
const artifactWorkerPrelude = `nl=$(printf '\\nx'); nl=\${nl%x}; cr=$(printf '\\rx'); cr=\${cr%x}`
const artifactWorkerGuard = `case \"$f\" in *\"$nl\"*|*\"$cr\"*) continue ;; esac`

const buildArtifactManifestCommand = ({ workspace, runId }) => {
  const prelude = runDirPrelude(workspace, runId)
  // Two passes are intentional: the first produces an exact summary even when
  // there are >2000 files; the second emits only 2001 details (the last is a
  // truncation sentinel). The existing GNU/BSD dual-stat strategy is preserved.
  const summaryWorker = `${artifactWorkerPrelude}; for f do ${artifactWorkerGuard}; ${dualStatShell}; printf '%s\\n' \"$size\"; done`
  const detailsWorker = `${artifactWorkerPrelude}; for f do ${artifactWorkerGuard}; ${dualStatShell}; ` +
    `if head -c 4096 \"$f\" 2>/dev/null | od -An -v -tu1 | grep -Eq '(^|[[:space:]])0([[:space:]]|$)'; then binary=1; else binary=0; fi; ` +
    `hex=$(printf '%s' \"$f\" | od -An -v -tx1 | tr -d ' \\n'); ` +
    `printf 'H\\t%s\\t%s\\t%s\\t%s\\n' \"$mtime\" \"$size\" \"$binary\" \"$hex\"; done`
  const summary = `${artifactFind} -exec sh -c ${shq(summaryWorker)} sh {} + | ` +
    `awk '{ count += 1; bytes += $1 } END { printf \"S\\t%d\\t%.0f\\n\", count, bytes }'`
  // NUL, not high-bit bytes, is the binary signal. UTF-8 Chinese text remains text.
  // Hex encoding keeps every pathname on exactly one protocol line.
  const details = `${artifactFind} -exec sh -c ${shq(detailsWorker)} sh {} + | head -n ${ARTIFACT_DETAIL_SENTINEL}`
  return `${prelude}; LC_ALL=C; export LC_ALL; ${summary}; ${details}`
}

const parseArtifactManifest = (output, { host, runId, runDir } = {}) => {
  const lines = String(output ?? '').split('\n').filter(Boolean)
  if (lines.some((line) => line === 'E\tRUN_NOT_FOUND')) {
    return { ok: false, status: 404, error: 'run not found' }
  }
  let count = null
  let totalBytes = null
  const details = []
  for (const line of lines) {
    const fields = line.split('\t')
    if (fields[0] === 'S' && fields.length >= 3) {
      const parsedCount = Number(fields[1])
      const parsedBytes = Number(fields[2])
      if (Number.isSafeInteger(parsedCount) && parsedCount >= 0 && Number.isSafeInteger(parsedBytes) && parsedBytes >= 0) {
        count = parsedCount
        totalBytes = parsedBytes
      }
      continue
    }
    if ((fields[0] !== 'F' && fields[0] !== 'H') || fields.length < 5) continue
    let rawPath
    if (fields[0] === 'H') {
      const hex = fields[4]
      if (!/^(?:[0-9a-fA-F]{2})+$/.test(hex)) continue
      rawPath = Buffer.from(hex, 'hex').toString('utf8')
    } else {
      rawPath = fields.slice(4).join('\t')
    }
    const path = safeRelPath(rawPath.replace(/^\.\//, ''))
    const mtime = Number(fields[1])
    const size = Number(fields[2])
    if (!path || isExcludedArtifactPath(path) || !Number.isFinite(mtime) || !Number.isSafeInteger(size) || size < 0) continue
    details.push({ path, size, mtime: Number.isFinite(mtime) ? mtime : 0, binary: fields[3] === '1' })
  }
  if (count === null || totalBytes === null) return { ok: false, status: 502, error: 'invalid artifact manifest' }
  const sentinel = details.length >= ARTIFACT_DETAIL_SENTINEL
  return {
    ok: true,
    value: {
      host: String(host?.name ?? host ?? ''),
      runId: String(runId ?? ''),
      runDir: String(runDir ?? ''),
      files: details.slice(0, ARTIFACT_MAX_FILES),
      totalBytes,
      count,
      truncated: count > ARTIFACT_MAX_FILES || sentinel,
      excluded: [...EXCLUDED_ARTIFACTS],
    },
  }
}

const artifactLimitError = (manifest) => {
  const count = Number(manifest?.count) || 0
  const totalBytes = Number(manifest?.totalBytes) || 0
  if (count <= ARTIFACT_MAX_FILES && totalBytes <= ARTIFACT_MAX_BYTES) return null
  return {
    error: 'artifact set too large',
    totalBytes,
    count,
    hint: '用 /fleet/artifact/file 单取',
  }
}

const pathSegmentGuard = (path) => {
  const safe = safeRelPath(path)
  if (!safe || isExcludedArtifactPath(safe)) throw new TypeError('invalid artifact path')
  // Disable globbing before splitting only on '/'. Every segment, including the
  // leaf, is checked so a symlink cannot escape the pinned run directory.
  return `p=${shq(safe)}; set -f; oldifs=$IFS; IFS=/; set -- $p; IFS=$oldifs; cur=.; ` +
    `for seg do cur=\"$cur/$seg\"; [ ! -L \"$cur\" ] || { printf 'E\\tUNSAFE_PATH\\n'; exit 0; }; done`
}

const buildArtifactFileProbeCommand = ({ workspace, runId, path }) => {
  const safe = safeRelPath(path)
  return `${runDirPrelude(workspace, runId)}; ${pathSegmentGuard(safe)}; ` +
    `[ -f \"$p\" ] || { printf 'E\\tFILE_NOT_FOUND\\n'; exit 0; }; f=$p; ${dualStatShell}; ` +
    `printf 'OK\\t%s\\t%s\\n' \"$mtime\" \"$size\"`
}

const parseArtifactFileProbe = (output) => {
  const line = String(output ?? '').trim().split('\n')[0] || ''
  if (line === 'E\tRUN_NOT_FOUND' || line === 'E\tFILE_NOT_FOUND') return { ok: false, status: 404, error: 'artifact not found' }
  if (line === 'E\tUNSAFE_PATH') return { ok: false, status: 404, error: 'artifact not found' }
  const fields = line.split('\t')
  const mtime = Number(fields[1])
  const size = Number(fields[2])
  if (fields[0] !== 'OK' || !Number.isFinite(mtime) || !Number.isSafeInteger(size) || size < 0) {
    return { ok: false, status: 502, error: 'invalid artifact metadata' }
  }
  return { ok: true, value: { mtime, size } }
}

const buildArtifactFileCommand = ({ workspace, runId, path }) => {
  const safe = safeRelPath(path)
  return `${runDirPrelude(workspace, runId, { stream: true })}; ${pathSegmentGuard(safe)}; ` +
    `[ -f \"$p\" ] || exit 9; exec cat -- \"$p\"`
}

const buildArtifactTgzCommand = ({ workspace, runId }) => {
  // Both GNU tar and bsdtar support -T -. Feeding only find -type f results
  // avoids archiving symlink entries or internal control files. NUL-delimited
  // names prevent a newline-bearing filename from injecting tar -T options.
  const archiveWorker = `${artifactWorkerPrelude}; for f do ${artifactWorkerGuard}; printf '%s\\000' \"$f\"; done`
  return `${runDirPrelude(workspace, runId, { stream: true })}; ` +
    `${artifactFind} -exec sh -c ${shq(archiveWorker)} sh {} + | tar -czf - --null -T -`
}

const safeDownloadFilename = (raw, fallback = 'artifact') => {
  const cleaned = String(raw ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[\\/]/g, '-')
    .replace(/[";]/g, '_')
    .trim()
  return (cleaned || fallback).slice(0, 180)
}

const contentDisposition = (raw, fallback) => {
  const filename = safeDownloadFilename(raw, fallback)
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_')
  const encoded = encodeURIComponent(filename).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`
}

const isCrossSite = (req) => String(req?.headers?.['sec-fetch-site'] ?? '').toLowerCase() === 'cross-site'

const inside = (root, candidate) => {
  const rel = relative(root, candidate)
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + sep))
}

const localRunRoot = async (target, fsApi = fs) => {
  try {
    const workspaceStat = await fsApi.lstat(target.workspace)
    if (!workspaceStat.isDirectory() || workspaceStat.isSymbolicLink()) return null
    const workspaceReal = await fsApi.realpath(target.workspace)
    const tasks = join(target.workspace, 'tasks')
    const tasksStat = await fsApi.lstat(tasks)
    if (!tasksStat.isDirectory() || tasksStat.isSymbolicLink()) return null
    const tasksReal = await fsApi.realpath(tasks)
    if (tasksReal !== join(workspaceReal, 'tasks')) return null
    const run = join(tasks, target.runId)
    const runStat = await fsApi.lstat(run)
    if (!runStat.isDirectory() || runStat.isSymbolicLink()) return null
    const runReal = await fsApi.realpath(run)
    if (runReal !== join(tasksReal, target.runId) || !inside(tasksReal, runReal)) return null
    return runReal
  } catch { return null }
}

const localArtifactFile = async (target, rawPath, fsApi = fs) => {
  const path = safeRelPath(rawPath)
  if (!path || isExcludedCodexArtifactPath(path)) return null
  const runReal = await localRunRoot(target, fsApi)
  if (!runReal) return null
  let current = runReal
  const parts = path.split('/')
  for (let index = 0; index < parts.length; index++) {
    current = join(current, parts[index])
    let stat
    try { stat = await fsApi.lstat(current) } catch { return null }
    if (stat.isSymbolicLink()) return null
    if (index < parts.length - 1 && !stat.isDirectory()) return null
    if (index === parts.length - 1 && !stat.isFile()) return null
  }
  try {
    const real = await fsApi.realpath(current)
    if (!inside(runReal, real)) return null
    const stat = await fsApi.lstat(real)
    if (!stat.isFile() || stat.isSymbolicLink()) return null
    return { path, absolute: real, runReal, stat }
  } catch { return null }
}

const sameFile = (left, right) => Number(left?.dev) === Number(right?.dev) && Number(left?.ino) === Number(right?.ino)

const openLocalArtifactFile = async (target, rawPath, fsApi = fs) => {
  const before = await localArtifactFile(target, rawPath, fsApi)
  if (!before) return null
  let handle
  try {
    handle = await fsApi.open(before.absolute, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0))
    const opened = await handle.stat()
    if (!opened.isFile() || !sameFile(opened, before.stat)) { await handle.close(); return null }
    // Revalidate every parent after open. If a directory was swapped to a
    // symlink between validation and open, the canonical leaf or inode differs.
    const after = await localArtifactFile(target, rawPath, fsApi)
    if (!after || after.absolute !== before.absolute || !sameFile(opened, after.stat)) { await handle.close(); return null }
    return { ...after, stat: opened, handle }
  } catch {
    try { await handle?.close() } catch {}
    return null
  }
}

const localFileBinary = async (path, fsApi = fs) => {
  const handle = await fsApi.open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0))
  try {
    const bytes = Buffer.allocUnsafe(4096)
    const read = await handle.read(bytes, 0, bytes.length, 0)
    return bytes.subarray(0, read.bytesRead).includes(0)
  } finally { await handle.close() }
}

const localArtifactManifest = async (target, { signal, fsApi = fs } = {}) => {
  const runReal = await localRunRoot(target, fsApi)
  if (!runReal) return { ok: false, status: 404, error: 'run not found' }
  const details = []
  let count = 0
  let totalBytes = 0
  const walk = async (directory, prefix = '', depth = 0) => {
    if (signal?.aborted) throw signal.reason || new Error('aborted')
    if (depth >= 6) return
    const entries = await fsApi.readdir(directory, { withFileTypes: true })
    for (const entry of entries) {
      if (signal?.aborted) throw signal.reason || new Error('aborted')
      if (entry.isSymbolicLink()) continue
      const path = prefix ? `${prefix}/${entry.name}` : entry.name
      if (!safeRelPath(path) || isExcludedCodexArtifactPath(path)) continue
      const absolute = join(directory, entry.name)
      const stat = await fsApi.lstat(absolute)
      if (stat.isSymbolicLink()) continue
      if (stat.isDirectory()) { await walk(absolute, path, depth + 1); continue }
      if (!stat.isFile()) continue
      count += 1
      totalBytes += stat.size
      if (details.length < ARTIFACT_DETAIL_SENTINEL) {
        details.push({ path, size: stat.size, mtime: Math.floor(stat.mtimeMs / 1000), binary: await localFileBinary(absolute, fsApi) })
      }
    }
  }
  await walk(runReal)
  return {
    ok: true,
    value: {
      host: String(target.host?.name ?? target.host ?? ''),
      runId: String(target.runId ?? ''),
      runDir: runReal,
      files: details.slice(0, ARTIFACT_MAX_FILES),
      totalBytes,
      count,
      truncated: count > ARTIFACT_MAX_FILES || details.length >= ARTIFACT_DETAIL_SENTINEL,
      excluded: [...EXCLUDED_ARTIFACTS, ...CODEX_INTERNAL_ARTIFACTS],
    },
  }
}

const sendJson = (res, status, body, extraHeaders = {}) => {
  if (res.headersSent) {
    try { res.destroy() } catch {}
    return
  }
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...extraHeaders,
  })
  res.end(JSON.stringify(body))
}

const defaultScrubSecrets = (value) => scrubString(value)

const createArtifactHandlers = ({ hostsOf, wsOf, sshRead, spawnSsh, spawnLocal = spawn, onStreamError, scrubSecrets = defaultScrubSecrets } = {}) => {
  if (typeof hostsOf !== 'function' || typeof wsOf !== 'function' || typeof sshRead !== 'function' || typeof spawnSsh !== 'function') {
    throw new TypeError('hostsOf, wsOf, sshRead and spawnSsh are required')
  }

  const resolveTarget = (url) => {
    const hostName = url.searchParams.get('host') || ''
    const runId = url.searchParams.get('run') || ''
    const host = hostsOf().find((candidate) => candidate.name === hostName)
    if (!host) return { ok: false, status: 404, error: 'no such host' }
    if (host.kind === 'local') return { ok: false, status: 400, error: 'local has no remote artifacts' }
    if (!validateRunId(runId)) return { ok: false, status: 400, error: 'invalid run id' }
    const workspace = wsOf(host)
    return { ok: true, host, runId, workspace, runDir: artifactRunDir(workspace, runId) }
  }

  const readManifest = async (target, { signal } = {}) => {
    if (target.host.kind === 'codex') {
      try { return await localArtifactManifest(target, { signal }) }
      catch (error) { return { ok: false, status: signal?.aborted ? 499 : 502, error: scrubSecrets(error?.message ?? error) } }
    }
    let reply
    try {
      reply = await sshRead(target.host, buildArtifactManifestCommand(target), 30000, { signal })
    } catch (error) {
      return { ok: false, status: 502, error: scrubSecrets(error?.message ?? error) }
    }
    if (!reply?.ok) return { ok: false, status: 502, error: scrubSecrets(reply?.err || `ssh exit ${reply?.code ?? '?'}`) }
    return parseArtifactManifest(reply.out, target)
  }

  const manifestHandler = async (req, res) => {
    try {
      if (isCrossSite(req)) { sendJson(res, 403, { error: 'cross-site request rejected' }); return }
      if (req.method !== 'GET') { sendJson(res, 405, { error: 'GET only' }, { allow: 'GET' }); return }
      const target = resolveTarget(new URL(req.url, 'http://fleet.local'))
      if (!target.ok) { sendJson(res, target.status, { error: target.error }); return }
      const manifest = await readManifest(target)
      if (!manifest.ok) { sendJson(res, manifest.status, { error: manifest.error }); return }
      sendJson(res, 200, manifest.value)
    } catch (error) {
      if (res.headersSent) { try { res.destroy(error) } catch {}; return }
      sendJson(res, 500, { error: scrubSecrets(error?.message ?? error) })
    }
  }

  const stream = (req, res, target, command, headers, kind) => {
    let child
    try {
      child = spawnSsh(target.host, command)
    } catch (error) {
      sendJson(res, 502, { error: scrubSecrets(error?.message ?? error) })
      return
    }
    let responseFinished = false
    let childClosed = false
    let stderr = ''
    let failureHandled = false
    const report = (error) => {
      if (typeof onStreamError === 'function') {
        try { onStreamError({ host: target.host.name, runId: target.runId, kind, error: scrubSecrets(error).slice(0, 2000) }) } catch {}
      }
    }
    const failStream = (error) => {
      if (failureHandled) return
      failureHandled = true
      report(error)
      if (res.headersSent) { try { res.destroy(error instanceof Error ? error : undefined) } catch {} }
      else sendJson(res, 502, { error: 'ssh stream failed' })
    }
    res.once('finish', () => { responseFinished = true })
    res.once('close', () => {
      if (responseFinished || childClosed) return
      try { child.kill('SIGKILL') } catch {}
    })
    child.stderr?.on('data', (chunk) => { if (stderr.length < 2000) stderr += String(chunk).slice(0, 2000 - stderr.length) })
    child.once('error', (error) => { failStream(error?.message ?? error) })
    child.stdout.once('error', (error) => { failStream(error?.message ?? error) })
    child.once('close', (code) => {
      childClosed = true
      if (code === 0) {
        if (!res.destroyed && !responseFinished) res.end()
        return
      }
      if (!responseFinished) failStream(stderr || `ssh exit ${code}`)
      else report(stderr || `ssh exit ${code}`)
    })
    res.writeHead(200, { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...headers })
    // Do not let stdout EOF finish a clean HTTP response before the ssh exit
    // status is known. A later non-zero close must still truncate/destroy it.
    child.stdout.pipe(res, { end: false })
  }

  const streamLocalFile = (req, res, target, file, headers) => {
    let source
    try {
      source = file.handle.createReadStream({
        autoClose: true,
        start: 0,
        end: Math.max(0, Number(file.stat.size) - 1),
      })
    } catch (error) {
      try { void file.handle.close() } catch {}
      sendJson(res, 502, { error: scrubSecrets(error?.message ?? error) }); return
    }
    let finished = false
    res.once('finish', () => { finished = true })
    res.once('close', () => { if (!finished) source.destroy() })
    source.once('error', (error) => {
      try { onStreamError?.({ host: target.host.name, runId: target.runId, kind: 'file', error: scrubSecrets(error?.message ?? error).slice(0, 2000) }) } catch {}
      if (res.headersSent) { try { res.destroy(error) } catch {} }
      else sendJson(res, 502, { error: 'artifact stream failed' })
    })
    res.writeHead(200, {
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'content-length': String(file.stat.size),
      ...headers,
    })
    source.pipe(res)
  }

  const streamLocalTgz = async (req, res, target, manifest, headers) => {
    const snapshotPrefix = join(tmpdir(), 'dsh-fleet-artifact-snapshot-')
    let snapshot
    const cleanup = async () => {
      if (!snapshot || !snapshot.startsWith(snapshotPrefix)) return
      try {
        const stat = await fs.lstat(snapshot)
        if (stat.isDirectory() && !stat.isSymbolicLink()) await fs.rm(snapshot, { recursive: true, force: true })
      } catch {}
    }
    const paths = []
    let actualBytes = 0
    try {
      snapshot = await fs.mkdtemp(snapshotPrefix)
      for (const detail of manifest.files) {
        const file = await openLocalArtifactFile(target, detail.path)
        if (!file) throw new Error('artifact set changed')
        actualBytes += Number(file.stat.size) || 0
        if (paths.length + 1 > ARTIFACT_MAX_FILES || actualBytes > ARTIFACT_MAX_BYTES) {
          try { await file.handle.close() } catch {}
          const error = new Error('artifact set too large'); error.statusCode = 413; throw error
        }
        const destination = join(snapshot, file.path)
        await fs.mkdir(dirname(destination), { recursive: true, mode: 0o700 })
        const output = await fs.open(destination, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600)
        try {
          let offset = 0
          const buffer = Buffer.allocUnsafe(64 * 1024)
          while (offset < file.stat.size) {
            const wanted = Math.min(buffer.length, file.stat.size - offset)
            const read = await file.handle.read(buffer, 0, wanted, offset)
            if (!read.bytesRead) break
            await output.write(buffer, 0, read.bytesRead, offset)
            offset += read.bytesRead
          }
        } finally {
          await Promise.allSettled([file.handle.close(), output.close()])
        }
        paths.push('./' + file.path)
      }
    } catch (error) {
      await cleanup()
      sendJson(res, Number(error?.statusCode) || 404, { error: error?.statusCode === 413 ? 'artifact set too large' : 'artifact set changed' })
      return
    }
    let child
    try {
      child = spawnLocal('tar', ['-czf', '-', '--null', '-T', '-'], { cwd: snapshot, stdio: ['pipe', 'pipe', 'pipe'] })
    } catch (error) { await cleanup(); sendJson(res, 502, { error: scrubSecrets(error?.message ?? error) }); return }
    let responseFinished = false
    let childClosed = false
    let failureHandled = false
    let stderr = ''
    const fail = (error) => {
      if (failureHandled) return
      failureHandled = true
      try { onStreamError?.({ host: target.host.name, runId: target.runId, kind: 'tgz', error: scrubSecrets(error).slice(0, 2000) }) } catch {}
      if (res.headersSent) { try { res.destroy(error instanceof Error ? error : undefined) } catch {} }
      else sendJson(res, 502, { error: 'artifact stream failed' })
    }
    res.once('finish', () => { responseFinished = true; void cleanup() })
    res.once('close', () => { if (!responseFinished && !childClosed) { try { child.kill('SIGKILL') } catch {} }; void cleanup() })
    child.stderr?.on('data', (chunk) => { if (stderr.length < 2000) stderr += String(chunk).slice(0, 2000 - stderr.length) })
    child.stdin?.once('error', (error) => fail(error))
    child.stdout?.once('error', (error) => fail(error))
    child.once('error', (error) => fail(error))
    child.once('close', (code) => {
      childClosed = true
      void cleanup()
      if (code === 0) { if (!res.destroyed && !responseFinished) res.end(); return }
      fail(stderr || `tar exit ${code}`)
    })
    res.writeHead(200, { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...headers })
    child.stdout.pipe(res, { end: false })
    child.stdin.end(paths.map((path) => path + '\0').join(''))
  }

  const prefixHandler = async (req, res) => {
    const preflightAbort = new AbortController()
    let clientClosed = false
    const markClientClosed = () => {
      if (res.writableEnded) return
      clientClosed = true
      preflightAbort.abort()
    }
    req.once('aborted', markClientClosed)
    res.once('close', markClientClosed)
    try {
      if (isCrossSite(req)) { sendJson(res, 403, { error: 'cross-site request rejected' }); return }
      const url = new URL(req.url, 'http://fleet.local')
      if (url.pathname !== '/fleet/artifact/file' && url.pathname !== '/fleet/artifact/tgz') {
        sendJson(res, 404, { error: 'not found' })
        return
      }
      if (req.method !== 'GET') { sendJson(res, 405, { error: 'GET only' }, { allow: 'GET' }); return }
      const target = resolveTarget(url)
      if (!target.ok) { sendJson(res, target.status, { error: target.error }); return }
      if (url.searchParams.has('include') && url.searchParams.get('include') !== '0') {
        sendJson(res, 400, { error: 'trace artifacts are not downloadable' })
        return
      }

      if (url.pathname === '/fleet/artifact/file') {
        const path = safeRelPath(url.searchParams.get('path'))
        if (!path || isExcludedArtifactPath(path)) { sendJson(res, 400, { error: 'invalid artifact path' }); return }
        if (target.host.kind === 'codex') {
          const file = await openLocalArtifactFile(target, path)
          if (clientClosed || res.destroyed) { try { await file?.handle?.close() } catch {}; return }
          if (!file) { sendJson(res, 404, { error: 'artifact not found' }); return }
          const basename = path.split('/').at(-1) || 'artifact'
          streamLocalFile(req, res, target, file, {
            'content-type': 'application/octet-stream',
            'content-disposition': contentDisposition(basename, 'artifact'),
          })
          return
        }
        const probe = await sshRead(target.host, buildArtifactFileProbeCommand({ ...target, path }), 15000, { signal: preflightAbort.signal })
        if (clientClosed || res.destroyed) return
        if (!probe?.ok) { sendJson(res, 502, { error: scrubSecrets(probe?.err || `ssh exit ${probe?.code ?? '?'}`) }); return }
        const metadata = parseArtifactFileProbe(probe.out)
        if (!metadata.ok) { sendJson(res, metadata.status, { error: metadata.error }); return }
        const basename = path.split('/').at(-1) || 'artifact'
        stream(req, res, target, buildArtifactFileCommand({ ...target, path }), {
          'content-type': 'application/octet-stream',
          'content-disposition': contentDisposition(basename, 'artifact'),
        }, 'file')
        return
      }

      const manifest = await readManifest(target, { signal: preflightAbort.signal })
      if (clientClosed || res.destroyed) return
      if (!manifest.ok) { sendJson(res, manifest.status, { error: manifest.error }); return }
      const tooLarge = artifactLimitError(manifest.value)
      if (tooLarge) { sendJson(res, 413, tooLarge); return }
      if (target.host.kind === 'codex') {
        await streamLocalTgz(req, res, target, manifest.value, {
          'content-type': 'application/gzip',
          'content-disposition': contentDisposition(`${target.host.name}-${target.runId}.tgz`, 'artifacts.tgz'),
        })
        return
      }
      stream(req, res, target, buildArtifactTgzCommand(target), {
        'content-type': 'application/gzip',
        'content-disposition': contentDisposition(`${target.host.name}-${target.runId}.tgz`, 'artifacts.tgz'),
      }, 'tgz')
    } catch (error) {
      if (res.headersSent) { try { res.destroy(error) } catch {}; return }
      sendJson(res, 500, { error: scrubSecrets(error?.message ?? error) })
    }
  }

  return { manifestHandler, prefixHandler, readManifest }
}

export {
  ARTIFACT_DETAIL_SENTINEL,
  ARTIFACT_MAX_BYTES,
  ARTIFACT_MAX_FILES,
  EXCLUDED_ARTIFACTS,
  RUN_ID_RE,
  artifactLimitError,
  artifactRunDir,
  buildArtifactFileCommand,
  buildArtifactFileProbeCommand,
  buildArtifactManifestCommand,
  buildArtifactTgzCommand,
  contentDisposition,
  createArtifactHandlers,
  isCrossSite,
  isExcludedArtifactPath,
  parseArtifactFileProbe,
  parseArtifactManifest,
  safeDownloadFilename,
  safeRelPath,
  validateRunId,
}
