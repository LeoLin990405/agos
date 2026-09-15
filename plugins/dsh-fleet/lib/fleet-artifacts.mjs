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

const runDirPrelude = (workspace, runId, { missing = "printf 'E\\tRUN_NOT_FOUND\\n'; exit 0" } = {}) => {
  if (!validateRunId(runId)) throw new TypeError('invalid run id')
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
// -links 1 is the remote counterpart of the local nlink check: find -type f
// happily matches a hardlink, and a hardlink to a file outside the run root is
// indistinguishable from a regular artifact by every other test available here.
const artifactFind = "find . -maxdepth 6 -type f -links 1 -not -name .trace -not -path '*/.trace/*' -not -name pid -not -name exit -not -name err.txt 2>/dev/null"

// find -exec passes each pathname as an argv element, so embedded whitespace is
// never a record separator. CR/LF names cannot pass safeRelPath over HTTP and are
// therefore excluded consistently from the manifest and archive artifact set.
const artifactWorkerPrelude = `nl=$(printf '\\nx'); nl=\${nl%x}; cr=$(printf '\\rx'); cr=\${cr%x}`
const artifactWorkerGuard = `case \"$f\" in *\"$nl\"*|*\"$cr\"*) continue ;; esac`

// ---------------------------------------------------------------------------
// Remote (POSIX sh) artifact reads.
//
// POSIX sh has no O_NOFOLLOW, so the binding is assembled out of the three
// things it does give us, and every byte we emit comes from a descriptor that
// was validated while we held it:
//
//   * `cd` holds a directory. Once the shell has chdir'd into a component that
//     component cannot be redirected under it, so the descent pins every
//     directory with chdir + `pwd -P` and never re-resolves a path prefix.
//   * `exec 3< name` is exactly one open(). Every check after it reads the
//     object back through /dev/fd/3, which is an fstat of the object we hold —
//     not a second resolution of the name.
//   * `cat <&3` reads that same descriptor, so there is no window at all
//     between the last check and the first byte.
//
// Containment proof for the object on fd 3:
//   nlink == 1, read from the held object  -> it has exactly one name anywhere
//   lstat(leaf) is not a symlink and its
//     inode equals the held object's inode -> that one name is `leaf`
//   `leaf` was resolved inside a pinned dir-> that name is inside the run root
// So the bytes belong to an object whose only name is inside the run root. A
// swap landing after the open cannot change what fd 3 refers to, and a swap
// landing before it is caught by the inode comparison. Two stats of the same
// *name* would prove none of this, which is precisely why neither the size nor
// the identity is ever taken from a name that is then re-opened.
//
// The pre-open `[ -f ]` test is a liveness check only, never a security check:
// its job is to keep a FIFO from wedging the shell inside open().
//
// The device number is compared as well, but only on a host that proves it can
// report a descriptor's real device. On Linux /dev/fd/N is a procfs symlink and
// `stat -L` reaches the real inode, while on BSD/macOS /dev/fd is its own
// filesystem that reports its own st_dev. The probe measures this against the
// pinned directory rather than the requested path, so an attacker cannot steer
// which branch is taken.
// ---------------------------------------------------------------------------

// Refusal classes, shared by the shell fragments and the parsers. `missing` is
// an ordinary miss (or a benign vanish during a walk) and stays an
// indistinguishable 404; `tamper` and `capability` are reported for what they
// are, because an operator silently served a weaker guarantee is the bug.
const REMOTE_MISSING = 3
const REMOTE_TAMPER = 4
const REMOTE_CAPABILITY = 5
// A leaf that exists but is a symlink or is not a regular file. The two callers
// need opposite answers, which is why it is its own class: for a single
// requested path it is an indistinguishable 404, because a distinguishable one
// would turn the route into an existence oracle for names outside the run. For a
// candidate that `find -type f -links 1` just enumerated it is tampering, since
// the only way it can now be a symlink is that the tree changed underneath.
const REMOTE_NOT_REGULAR = 6

// The status line that precedes streamed bytes. Validation is complete before it
// is printed, so a refusal never reaches the client as a 200 that is later
// destroyed: bytes already on the wire cannot be recalled.
const ARTIFACT_STREAM_TAG = 'AGOS-ART'

const remoteFdLib = [
  // fstat of an already-open descriptor. -L matters on Linux, where /dev/fd/N is
  // a procfs symlink and both stat implementations lstat by default.
  `agos_fdstat() { stat -L -c '%d %i %h %s %Y' \"$1\" 2>/dev/null || stat -L -f '%d %i %l %z %m' \"$1\" 2>/dev/null; }`,
  // lstat of a name. Neither implementation dereferences by default, so a
  // symlink reports its own inode and cannot impersonate its target.
  `agos_lstat() { stat -c '%d %i' \"$1\" 2>/dev/null || stat -f '%d %i' \"$1\" 2>/dev/null; }`,
  // Can this host stat an open descriptor, and is the device it reports real?
  // The reference is the pinned directory, so the answer is not attacker-chosen.
  // Prints "<fd directory> <device usable 1|0>"; a non-zero return means the
  // host cannot express a descriptor-bound read at all.
  `agos_fdroot() { agos_dot=$(agos_lstat .) || return 1; ` +
    `exec 9< . 2>/dev/null || return 1; ` +
    `for agos_c in /dev/fd /proc/self/fd; do ` +
      `agos_v=$(agos_fdstat \"$agos_c/9\") || continue; ` +
      `case \"$agos_v\" in \"$agos_dot \"*) printf '%s 1' \"$agos_c\"; return 0 ;; esac; ` +
      `case \"\${agos_v#* }\" in \"\${agos_dot#* } \"*) printf '%s 0' \"$agos_c\"; return 0 ;; esac; ` +
    `done; return 1; }`,
  `agos_setup() { agos_r=$(agos_fdroot) || return ${REMOTE_CAPABILITY}; ` +
    `AGOS_FDROOT=\${agos_r%% *}; AGOS_DEVOK=\${agos_r##* }; }`,
  // Walk to the leaf's parent, holding every directory by chdir and proving the
  // directory we now hold is the one we named. Only the leaf is left as a name.
  `agos_descend() { set -f; agos_oldifs=$IFS; IFS=/; set -- $1; IFS=$agos_oldifs; ` +
    `agos_base=$(pwd -P) || return 1; AGOS_LEAF=; ` +
    `while [ $# -gt 0 ]; do agos_seg=$1; shift; ` +
      `if [ $# -eq 0 ]; then AGOS_LEAF=$agos_seg; break; fi; ` +
      `case \"$agos_seg\" in ''|.|..) return 1 ;; esac; ` +
      `[ -d \"$agos_seg\" ] && [ ! -L \"$agos_seg\" ] || return 1; ` +
      `cd \"$agos_seg\" 2>/dev/null || return 1; ` +
      `agos_p=$(pwd -P) || return 1; ` +
      `[ \"$agos_p\" = \"$agos_base/$agos_seg\" ] || return 1; ` +
      `agos_base=$agos_p; done; ` +
    `set +f; [ -n \"$AGOS_LEAF\" ]; }`,
  // The one open, then every check against the object it returned. On success fd
  // 3 holds the artifact and AGOS_SIZE/AGOS_MTIME describe that same object.
  `agos_open() { AGOS_WHY=; agos_leaf=$1; ` +
    // Liveness only: an open() on a FIFO blocks until a writer shows up, so the
    // shell must not be handed one. Security is decided after the open, below.
    `[ ! -L \"$agos_leaf\" ] || { AGOS_WHY=symlink; return ${REMOTE_NOT_REGULAR}; }; ` +
    `if [ -e \"$agos_leaf\" ]; then [ -f \"$agos_leaf\" ] || { AGOS_WHY=not-a-regular-file; return ${REMOTE_NOT_REGULAR}; }; ` +
      `else AGOS_WHY=missing; return ${REMOTE_MISSING}; fi; ` +
    `exec 3< \"$agos_leaf\" 2>/dev/null || { AGOS_WHY=missing; return ${REMOTE_MISSING}; }; ` +
    `[ -f \"$AGOS_FDROOT/3\" ] || { AGOS_WHY=not-a-regular-file; exec 3<&-; return ${REMOTE_TAMPER}; }; ` +
    `agos_info=$(agos_fdstat \"$AGOS_FDROOT/3\") || { AGOS_WHY=cannot-stat-open-descriptor; exec 3<&-; return ${REMOTE_CAPABILITY}; }; ` +
    `set -- $agos_info; AGOS_DEV=$1; AGOS_INO=$2; AGOS_NLINK=$3; AGOS_SIZE=$4; AGOS_MTIME=$5; ` +
    `case \"$AGOS_INO$AGOS_NLINK$AGOS_SIZE\" in ''|*[!0-9]*) AGOS_WHY=cannot-stat-open-descriptor; exec 3<&-; return ${REMOTE_CAPABILITY} ;; esac; ` +
    `[ \"$AGOS_NLINK\" = 1 ] || { AGOS_WHY=hard-links; exec 3<&-; return ${REMOTE_TAMPER}; }; ` +
    `[ ! -L \"$agos_leaf\" ] || { AGOS_WHY=symlink; exec 3<&-; return ${REMOTE_TAMPER}; }; ` +
    `agos_name=$(agos_lstat \"$agos_leaf\") || { AGOS_WHY=vanished; exec 3<&-; return ${REMOTE_TAMPER}; }; ` +
    `[ \"\${agos_name#* }\" = \"$AGOS_INO\" ] || { AGOS_WHY=replaced; exec 3<&-; return ${REMOTE_TAMPER}; }; ` +
    `if [ \"$AGOS_DEVOK\" = 1 ]; then agos_here=$(agos_lstat .) || { AGOS_WHY=cannot-stat-directory; exec 3<&-; return ${REMOTE_CAPABILITY}; }; ` +
      `[ \"\${agos_here%% *}\" = \"$AGOS_DEV\" ] || { AGOS_WHY=cross-device; exec 3<&-; return ${REMOTE_TAMPER}; }; fi; }`,
  // Refusal record for the aggregate routes. A benign miss is silent so a file
  // that legitimately vanished mid-walk does not fail the whole listing.
  `agos_record() { case \"$1\" in ${REMOTE_MISSING}) : ;; ` +
    `${REMOTE_CAPABILITY}) printf 'X\\tCAPABILITY\\t%s\\n' \"$2\" ;; ` +
    `*) printf 'X\\tTAMPER\\t%s\\n' \"$2\" ;; esac; }`,
].join('; ')

// Descend + open, for one path known at build time. Emits the refusal through
// the caller's own protocol so each route keeps its documented status mapping.
// Refusal actions carry no trailing separator; each call site punctuates.
const remoteOpenFragment = (safe, { onMissing, onTamper, onCapability }) => [
  remoteFdLib,
  `agos_descend ${shq(safe)} || { ${onMissing}; }`,
  `agos_setup || { ${onCapability}; }`,
  `agos_open \"$AGOS_LEAF\" || case $? in ` +
    `${REMOTE_MISSING}|${REMOTE_NOT_REGULAR}) ${onMissing} ;; ` +
    `${REMOTE_CAPABILITY}) ${onCapability} ;; ` +
    `*) ${onTamper} ;; esac`,
].join('; ')

// Per-candidate worker body shared by the manifest and the archive. find -exec
// hands over pathnames as argv, and each candidate is re-proved from the run
// root inside its own subshell so one file's chdir cannot affect the next.
const remoteWorker = (body) => `${remoteFdLib}; ${artifactWorkerPrelude}; for f do ${artifactWorkerGuard}; ` +
  `agos_rel=\${f#./}; ( agos_descend \"$agos_rel\" || { agos_record ${REMOTE_TAMPER} path-segment; exit 0; }; ` +
  `agos_setup || { agos_record ${REMOTE_CAPABILITY} cannot-stat-open-descriptor; exit 0; }; ` +
  `agos_open \"$AGOS_LEAF\" || { agos_record $? \"$AGOS_WHY\"; exit 0; }; ` +
  `${body} ); done`

const buildArtifactManifestCommand = ({ workspace, runId }) => {
  const prelude = runDirPrelude(workspace, runId)
  // Two passes are intentional: the first produces an exact summary even when
  // there are >2000 files; the second emits only 2001 details (the last is a
  // truncation sentinel). Both sizes now come from a validated descriptor, so a
  // name swapped after find cannot contribute either a size or a binary flag.
  const summaryWorker = remoteWorker(`printf '%s\\n' \"$AGOS_SIZE\"`)
  // NUL, not high-bit bytes, is the binary signal, and it is sniffed from fd 3
  // rather than by re-opening the name. UTF-8 Chinese text stays text.
  // Hex encoding keeps every pathname on exactly one protocol line.
  const detailsWorker = remoteWorker(
    `if head -c 4096 <&3 2>/dev/null | od -An -v -tu1 | grep -Eq '(^|[[:space:]])0([[:space:]]|$)'; then agos_bin=1; else agos_bin=0; fi; ` +
    `agos_hex=$(printf '%s' \"$agos_rel\" | od -An -v -tx1 | tr -d ' \\n'); ` +
    `printf 'H\\t%s\\t%s\\t%s\\t%s\\n' \"$AGOS_MTIME\" \"$AGOS_SIZE\" \"$agos_bin\" \"$agos_hex\"`,
  )
  // Refusal records must survive the summary's aggregation, so awk passes them
  // straight through instead of counting them as sizes.
  const summary = `${artifactFind} -exec sh -c ${shq(summaryWorker)} sh {} + | ` +
    `awk -F'\\t' '$1 == \"X\" { print; next } { count += 1; bytes += $1 } END { printf \"S\\t%d\\t%.0f\\n\", count, bytes }'`
  const details = `${artifactFind} -exec sh -c ${shq(detailsWorker)} sh {} + | head -n ${ARTIFACT_DETAIL_SENTINEL}`
  return `${prelude}; LC_ALL=C; export LC_ALL; ${summary}; ${details}`
}

const parseArtifactManifest = (output, { host, runId, runDir } = {}) => {
  const lines = String(output ?? '').split('\n').filter(Boolean)
  if (lines.some((line) => line === 'E\tRUN_NOT_FOUND')) {
    return { ok: false, status: 404, error: 'run not found' }
  }
  // A manifest is an aggregate, so one untrustworthy member makes the whole
  // listing untrustworthy: it fails closed rather than quietly dropping the
  // entry, which is what the local reader already does.
  const refusal = lines.find((line) => line.startsWith('X\t'))
  if (refusal) {
    const [, kind, why] = refusal.split('\t')
    if (kind === 'CAPABILITY') {
      return { ok: false, status: 500, capability: true, error: `remote cannot guarantee descriptor-bound artifact reads (${why || 'unknown'})` }
    }
    return { ok: false, status: 409, tamper: true, error: `artifact refused: ${why || 'replaced during validation'}` }
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

// Metadata only, but read back from a validated descriptor so the size and
// mtime describe the object a subsequent read would really open.
const buildArtifactFileProbeCommand = ({ workspace, runId, path }) => {
  const safe = safeRelPath(path)
  if (!safe || isExcludedArtifactPath(safe)) throw new TypeError('invalid artifact path')
  const open = remoteOpenFragment(safe, {
    onMissing: `printf 'E\\tFILE_NOT_FOUND\\n'; exit 0`,
    onTamper: `printf 'E\\tTAMPER\\t%s\\n' \"\${AGOS_WHY:-replaced}\"; exit 0`,
    onCapability: `printf 'E\\tCAPABILITY\\t%s\\n' \"\${AGOS_WHY:-cannot-stat-open-descriptor}\"; exit 0`,
  })
  return `${runDirPrelude(workspace, runId)}; ${open}; printf 'OK\\t%s\\t%s\\n' \"$AGOS_MTIME\" \"$AGOS_SIZE\"`
}

const parseArtifactFileProbe = (output) => {
  const line = String(output ?? '').trim().split('\n')[0] || ''
  const fields = line.split('\t')
  if (fields[0] === 'E') {
    if (fields[1] === 'CAPABILITY') {
      return { ok: false, status: 500, capability: true, error: `remote cannot guarantee descriptor-bound artifact reads (${fields[2] || 'unknown'})` }
    }
    if (fields[1] === 'TAMPER') {
      return { ok: false, status: 409, tamper: true, error: `artifact refused: ${fields[2] || 'replaced during validation'}` }
    }
    // RUN_NOT_FOUND and FILE_NOT_FOUND stay one indistinguishable 404 so the
    // route is not an existence oracle for paths outside the run.
    return { ok: false, status: 404, error: 'artifact not found' }
  }
  const mtime = Number(fields[1])
  const size = Number(fields[2])
  if (fields[0] !== 'OK' || !Number.isFinite(mtime) || !Number.isSafeInteger(size) || size < 0) {
    return { ok: false, status: 502, error: 'invalid artifact metadata' }
  }
  return { ok: true, value: { mtime, size } }
}

// `protocol` prefixes exactly one status line, so an HTTP caller can pick a
// status code while no artifact byte exists yet. Without it the command emits
// bytes only and signals every refusal by exiting non-zero, which is the
// contract a plain `sshRead` consumer already relies on.
// `limitBytes` caps the body remotely. A caller that instead pipes this command
// into `head` gets the pipeline's exit status, which is head's, so a refusal
// would arrive looking like a successful read of an empty file.
const buildArtifactFileCommand = ({ workspace, runId, path, protocol = false, limitBytes = 0 }) => {
  const safe = safeRelPath(path)
  if (!safe || isExcludedArtifactPath(safe)) throw new TypeError('invalid artifact path')
  const refuse = (kind) => protocol
    ? `printf '${ARTIFACT_STREAM_TAG}\\tERR\\t${kind}\\t%s\\n' \"\${AGOS_WHY:-${kind.toLowerCase()}}\"; exit 0`
    : `exit 9`
  const open = remoteOpenFragment(safe, {
    onMissing: refuse('NOT_FOUND'),
    onTamper: refuse('TAMPER'),
    onCapability: refuse('CAPABILITY'),
  })
  const header = protocol ? `printf '${ARTIFACT_STREAM_TAG}\\tOK\\t%s\\t%s\\n' \"$AGOS_SIZE\" \"$AGOS_MTIME\"; ` : ''
  const cap = Number.isSafeInteger(limitBytes) && limitBytes > 0 ? limitBytes : 0
  // The bytes come off fd 3 either way: reading a bounded prefix is a smaller
  // read of the same held object, not a second resolution of the name.
  const body = cap ? `head -c ${cap} <&3 || exit 9` : `cat <&3 || exit 9`
  return `${runDirPrelude(workspace, runId, { missing: refuse('NOT_FOUND') })}; ${open}; ${header}${body}`
}

// tar re-resolves every name it is handed, so it can never be the thing that
// opens an artifact. Each candidate is copied out of its own validated
// descriptor into a private staging tree, and only that tree — which is entirely
// ours — is handed to tar. Nothing reaches the client until every member has
// passed, because bytes already on the wire cannot be recalled by a later exit.
const buildArtifactTgzCommand = ({ workspace, runId, protocol = false }) => {
  const tab = `\"$(printf '\\t')\"`
  const refuse = (kind, why) => protocol
    ? `printf '${ARTIFACT_STREAM_TAG}\\tERR\\t${kind}\\t%s\\n' ${shq(why)}; exit 0`
    : `exit 9`
  const worker = remoteWorker(
    `agos_dest=$AGOS_STAGING/$agos_rel; mkdir -p \"\${agos_dest%/*}\" 2>/dev/null || { agos_record ${REMOTE_TAMPER} staging-failed; exit 0; }; ` +
    `cat <&3 > \"$agos_dest\" || { agos_record ${REMOTE_TAMPER} staging-failed; exit 0; }; ` +
    `printf '%s\\000' \"./$agos_rel\" >> \"$AGOS_STAGING/list\"; printf '%s\\n' \"$AGOS_SIZE\" >> \"$AGOS_STAGING/bytes\"`,
  )
  return [
    runDirPrelude(workspace, runId, { missing: refuse('NOT_FOUND', 'run-not-found') }),
    `LC_ALL=C; export LC_ALL`,
    `AGOS_STAGING=$(mktemp -d 2>/dev/null) || { ${refuse('CAPABILITY', 'no-mktemp')}; }`,
    `case \"$AGOS_STAGING\" in /*) ;; *) ${refuse('CAPABILITY', 'no-mktemp')} ;; esac`,
    `export AGOS_STAGING`,
    `trap 'rm -rf \"$AGOS_STAGING\"' EXIT HUP INT TERM`,
    `: > \"$AGOS_STAGING/list\"; : > \"$AGOS_STAGING/bytes\"`,
    // Worker records go to a file, not to stdout: find's exit status does not
    // reliably carry a -exec failure, and a refusal must not be able to reach
    // the client interleaved with archive bytes.
    `${artifactFind} -exec sh -c ${shq(worker)} sh {} + > \"$AGOS_STAGING/refused\" 2>/dev/null`,
    `if [ -s \"$AGOS_STAGING/refused\" ]; then agos_why=$(head -n 1 \"$AGOS_STAGING/refused\"); ` +
      `case \"$agos_why\" in *CAPABILITY*) ${refuse('CAPABILITY', 'cannot-stat-open-descriptor')} ;; ` +
      `*) ${protocol ? `printf '${ARTIFACT_STREAM_TAG}\\tERR\\tTAMPER\\t%s\\n' \"\${agos_why##*${tab}}\"; exit 0` : 'exit 9'} ;; esac; fi`,
    // Truthful about the cap even if the set grew after the manifest gate.
    `awk '{ s += $1 } END { if (s > ${ARTIFACT_MAX_BYTES}) exit 1 }' \"$AGOS_STAGING/bytes\" || { ${refuse('TOO_LARGE', 'artifact-set-too-large')}; }`,
    protocol ? `printf '${ARTIFACT_STREAM_TAG}\\tOK\\t-\\t-\\n'` : ':',
    `cat \"$AGOS_STAGING/list\" | tar -czf - -C \"$AGOS_STAGING\" --null -T -`,
  ].join('; ')
}

// The stream protocol's single status line. Bytes only ever follow an OK, so a
// refusal is still a clean JSON response with no headers written yet.
const parseArtifactStreamStatus = (line) => {
  const fields = String(line ?? '').split('\t')
  if (fields[0] !== ARTIFACT_STREAM_TAG) return { ok: false, status: 502, error: 'invalid artifact stream' }
  if (fields[1] === 'OK') return { ok: true, size: Number(fields[2]), mtime: Number(fields[3]) }
  const why = fields[3] || 'unknown'
  if (fields[2] === 'CAPABILITY') {
    return { ok: false, status: 500, capability: true, error: `remote cannot guarantee descriptor-bound artifact reads (${why})` }
  }
  if (fields[2] === 'TAMPER') return { ok: false, status: 409, tamper: true, error: `artifact refused: ${why}` }
  if (fields[2] === 'TOO_LARGE') return { ok: false, status: 413, error: 'artifact set too large' }
  return { ok: false, status: 404, error: 'artifact not found' }
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

// ---------------------------------------------------------------------------
// Local (Codex host) artifact reads.
//
// Every guarantee here is a syscall guarantee bound to a file object, never a
// comparison of two path strings resolved at two different instants:
//   * each component is opened with O_NOFOLLOW, so the kernel refuses a symlink
//     anywhere in the chain (ELOOP) instead of us lstat-ing and hoping
//   * non-leaf components add O_DIRECTORY, so a component swapped for a regular
//     file is ENOTDIR at open time rather than a surprise later
//   * size/mtime/mode come from fstat THROUGH the returned handle, and bytes are
//     read from that same handle. The leaf is never reopened by path
//   * nlink must be 1. realpath() reports a hardlink under its inside name, so
//     nlink is the only way to prove the inode has no name outside the run root
// ---------------------------------------------------------------------------

class ArtifactRefusal extends Error {
  constructor(reason, { status = 404, capability = false, tamper = false } = {}) {
    super(reason)
    this.name = 'ArtifactRefusal'
    this.reason = reason
    this.status = status
    this.capability = capability
    this.tamper = tamper
  }
}

const isArtifactRefusal = (error) => error instanceof ArtifactRefusal || error?.name === 'ArtifactRefusal'

// Fail closed. A platform that cannot express "open exactly this name, never a
// symlink" cannot be served safely, and quietly degrading to lstat-then-open is
// the whole class of bug this module exists to prevent.
const noFollowFlags = (constants = fsConstants) => {
  const missing = ['O_NOFOLLOW', 'O_DIRECTORY']
    .filter((name) => !Number.isInteger(constants?.[name]) || constants[name] === 0)
  if (missing.length) {
    throw new ArtifactRefusal(
      `platform cannot guarantee symlink-safe artifact reads (missing ${missing.join(', ')})`,
      { status: 500, capability: true },
    )
  }
  const read = Number(constants.O_RDONLY) || 0
  return {
    file: read | constants.O_NOFOLLOW,
    directory: read | constants.O_NOFOLLOW | constants.O_DIRECTORY,
  }
}

// Read the flags from the same fs surface that will issue the syscalls, so an
// injected or reduced surface is gated by the same fail-closed check.
const flagsFor = (fsApi) => noFollowFlags(fsApi?.constants ?? fsConstants)

const sameFile = (left, right) => Number(left?.dev) === Number(right?.dev) && Number(left?.ino) === Number(right?.ino)

const closeQuietly = async (...handles) => {
  await Promise.allSettled(handles.filter(Boolean).map((handle) => handle.close()))
}

// The name we resolved must still be its own canonical form and must still name
// the exact object we validated. A component swapped to a symlink fails the
// first check; a swap that was reverted fails the second.
const assertPinnedName = async (fsApi, path, pinned, label) => {
  let canonical
  try { canonical = await fsApi.realpath(path) }
  catch { throw new ArtifactRefusal(`${label} disappeared during validation`, { tamper: true }) }
  if (canonical !== path) throw new ArtifactRefusal(`${label} is not its own canonical path`, { tamper: true })
  let byName
  try { byName = await fsApi.lstat(path) }
  catch { throw new ArtifactRefusal(`${label} disappeared during validation`, { tamper: true }) }
  if (byName.isSymbolicLink() || !sameFile(byName, pinned)) {
    throw new ArtifactRefusal(`${label} was replaced during validation`, { tamper: true })
  }
}

// ELOOP means the component is a symlink and ENOTDIR means it is not a
// directory. Both decisions are made by the kernel inside this one open, not by
// a stat that something else could invalidate afterwards.
const openDirectoryHandle = async (fsApi, flags, path, label) => {
  let handle
  try { handle = await fsApi.open(path, flags.directory) }
  catch (error) { throw new ArtifactRefusal(`${label} is not a plain directory (${error?.code || 'EOPEN'})`) }
  try {
    const stat = await handle.stat()
    if (!stat.isDirectory()) throw new ArtifactRefusal(`${label} is not a directory`)
    return { handle, stat }
  } catch (error) {
    await closeQuietly(handle)
    throw error
  }
}

const openLocalRunRoot = async (target, fsApi = fs) => {
  const flags = flagsFor(fsApi)
  const runId = String(target?.runId ?? '')
  if (!validateRunId(runId)) throw new ArtifactRefusal('invalid run id')
  const workspace = String(target?.workspace ?? '').trim().replace(/\/+$/, '')
  if (!workspace) throw new ArtifactRefusal('workspace is required')

  let workspaceHandle
  let tasksHandle
  let runHandle
  try {
    workspaceHandle = await openDirectoryHandle(fsApi, flags, workspace, 'workspace')
    // The configured workspace may legitimately be a non-canonical spelling
    // (/var vs /private/var), so pin it by inode rather than by string. Every
    // path below is built from the canonical form and must stay canonical.
    let workspaceReal
    try { workspaceReal = await fsApi.realpath(workspace) }
    catch { throw new ArtifactRefusal('workspace disappeared during validation', { tamper: true }) }
    const workspaceByName = await fsApi.lstat(workspaceReal)
    if (workspaceByName.isSymbolicLink() || !sameFile(workspaceByName, workspaceHandle.stat)) {
      throw new ArtifactRefusal('workspace was replaced during validation', { tamper: true })
    }

    const tasksPath = join(workspaceReal, 'tasks')
    tasksHandle = await openDirectoryHandle(fsApi, flags, tasksPath, 'tasks directory')
    await assertPinnedName(fsApi, tasksPath, tasksHandle.stat, 'tasks directory')

    const runPath = join(tasksPath, runId)
    runHandle = await openDirectoryHandle(fsApi, flags, runPath, 'run directory')
    await assertPinnedName(fsApi, runPath, runHandle.stat, 'run directory')
    if (!inside(tasksPath, runPath)) throw new ArtifactRefusal('run directory escapes the tasks directory', { tamper: true })

    const root = { runReal: runPath, handle: runHandle.handle, stat: runHandle.stat }
    runHandle = null
    return root
  } finally {
    await closeQuietly(workspaceHandle?.handle, tasksHandle?.handle, runHandle?.handle)
  }
}

const openLocalArtifactFile = async (target, rawPath, fsApi = fs, { root = null } = {}) => {
  const flags = flagsFor(fsApi)
  const path = safeRelPath(rawPath)
  if (!path || isExcludedCodexArtifactPath(path)) throw new ArtifactRefusal('invalid artifact path')
  const runRoot = root ?? await openLocalRunRoot(target, fsApi)
  const chain = [{ path: runRoot.runReal, stat: runRoot.stat, label: 'run directory' }]
  const directories = []
  let handle
  try {
    const parts = path.split('/')
    let current = runRoot.runReal
    for (let index = 0; index < parts.length - 1; index++) {
      current = join(current, parts[index])
      const label = `artifact directory ${parts[index]}`
      const opened = await openDirectoryHandle(fsApi, flags, current, label)
      directories.push(opened.handle)
      await assertPinnedName(fsApi, current, opened.stat, label)
      chain.push({ path: current, stat: opened.stat, label })
    }
    const absolute = join(current, parts[parts.length - 1])
    try { handle = await fsApi.open(absolute, flags.file) }
    catch (error) { throw new ArtifactRefusal(`artifact is not a plain file (${error?.code || 'EOPEN'})`) }
    const stat = await handle.stat()
    if (!stat.isFile()) throw new ArtifactRefusal('artifact is not a regular file')
    if (Number(stat.nlink) !== 1) {
      throw new ArtifactRefusal(
        `artifact has ${Number(stat.nlink)} hard links, so it may alias content outside the run root`,
        { tamper: true },
      )
    }
    // Bind the opened object to the name we used, then re-verify every ancestor.
    // A directory swapped to a symlink and swapped back would pass the
    // descent-time checks but not this inode comparison.
    await assertPinnedName(fsApi, absolute, stat, 'artifact')
    if (!inside(runRoot.runReal, absolute)) throw new ArtifactRefusal('artifact escapes the run root', { tamper: true })
    for (const link of chain) await assertPinnedName(fsApi, link.path, link.stat, link.label)
    return { path, absolute, runReal: runRoot.runReal, stat, handle }
  } catch (error) {
    await closeQuietly(handle)
    throw error
  } finally {
    await closeQuietly(...directories)
    if (!root) await closeQuietly(runRoot.handle)
  }
}

// Read the sniff window from the handle we already validated. Reopening by path
// here was the manifest's TOCTOU: the second resolution could differ.
const handleBinary = async (handle) => {
  const bytes = Buffer.allocUnsafe(4096)
  const read = await handle.read(bytes, 0, bytes.length, 0)
  return bytes.subarray(0, read.bytesRead).includes(0)
}

const readLocalArtifactFile = async (target, rawPath, { maxBytes = 200000, fsApi = fs } = {}) => {
  const file = await openLocalArtifactFile(target, rawPath, fsApi)
  try {
    const size = Number(file.stat.size) || 0
    const limit = Math.min(size, Math.max(1, Number(maxBytes) || 200000))
    if (limit <= 0) return Buffer.alloc(0)
    const bytes = Buffer.allocUnsafe(limit)
    const read = await file.handle.read(bytes, 0, limit, 0)
    return bytes.subarray(0, read.bytesRead)
  } finally { await closeQuietly(file.handle) }
}

const localArtifactManifest = async (target, { signal, fsApi = fs } = {}) => {
  const flags = flagsFor(fsApi)
  let root
  try { root = await openLocalRunRoot(target, fsApi) }
  catch (error) {
    if (isArtifactRefusal(error) && !error.capability && !error.tamper) return { ok: false, status: 404, error: 'run not found' }
    throw error
  }
  const details = []
  let count = 0
  let totalBytes = 0
  const walk = async (directory, pinned, prefix, depth) => {
    if (signal?.aborted) throw signal.reason || new Error('aborted')
    if (depth >= 6) return
    // readdir resolves `directory` by path, so pin the name to the object we
    // opened on both sides of the listing.
    await assertPinnedName(fsApi, directory, pinned, 'artifact directory')
    const entries = await fsApi.readdir(directory, { withFileTypes: true })
    await assertPinnedName(fsApi, directory, pinned, 'artifact directory')
    for (const entry of entries) {
      if (signal?.aborted) throw signal.reason || new Error('aborted')
      if (entry.isSymbolicLink()) continue
      const path = prefix ? `${prefix}/${entry.name}` : entry.name
      if (!safeRelPath(path) || isExcludedCodexArtifactPath(path)) continue
      const absolute = join(directory, entry.name)
      if (entry.isDirectory()) {
        let opened
        try { opened = await openDirectoryHandle(fsApi, flags, absolute, 'artifact directory') }
        catch (error) {
          if (isArtifactRefusal(error) && !error.capability && !error.tamper) continue
          throw error
        }
        try { await walk(absolute, opened.stat, path, depth + 1) }
        finally { await closeQuietly(opened.handle) }
        continue
      }
      if (!entry.isFile()) continue
      // readdir is only a candidate generator. Every candidate must re-prove
      // itself through the same handle-bound opener the download path uses, and
      // its size/mtime/binary flag come from that handle's fstat — never from a
      // path lstat that a swap could have redirected.
      let file
      try { file = await openLocalArtifactFile(target, path, fsApi, { root }) }
      catch (error) {
        if (isArtifactRefusal(error) && !error.capability && !error.tamper) continue
        throw error
      }
      try {
        count += 1
        totalBytes += Number(file.stat.size) || 0
        if (details.length < ARTIFACT_DETAIL_SENTINEL) {
          details.push({
            path: file.path,
            size: file.stat.size,
            mtime: Math.floor(file.stat.mtimeMs / 1000),
            binary: await handleBinary(file.handle),
          })
        }
      } finally { await closeQuietly(file.handle) }
    }
  }
  try { await walk(root.runReal, root.stat, '', 0) }
  finally { await closeQuietly(root.handle) }
  return {
    ok: true,
    value: {
      host: String(target.host?.name ?? target.host ?? ''),
      runId: String(target.runId ?? ''),
      runDir: root.runReal,
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

const createArtifactHandlers = ({ hostsOf, wsOf, sshRead, spawnSsh, spawnLocal = spawn, onStreamError, scrubSecrets = defaultScrubSecrets, fsApi = fs } = {}) => {
  if (typeof hostsOf !== 'function' || typeof wsOf !== 'function' || typeof sshRead !== 'function' || typeof spawnSsh !== 'function') {
    throw new TypeError('hostsOf, wsOf, sshRead and spawnSsh are required')
  }

  // A refusal is never a 500-by-accident: capability gaps are reported verbatim
  // so an operator sees the platform reason, detected tampering gets its own
  // status and reason, and an ordinary miss stays an indistinguishable 404 so
  // the route is not an existence oracle for paths outside the run.
  const refusal = (target, kind, error) => {
    const reason = isArtifactRefusal(error) ? error.reason : String(error?.message ?? error)
    try {
      onStreamError?.({
        host: target?.host?.name ?? String(target?.host ?? ''),
        runId: target?.runId ?? '',
        kind,
        refused: true,
        error: scrubSecrets(reason).slice(0, 2000),
      })
    } catch {}
    if (!isArtifactRefusal(error)) return null
    if (error.capability) return { status: error.status, error: reason }
    if (error.tamper) return { status: 409, error: `artifact refused: ${reason}` }
    return { status: 404, error: 'artifact not found' }
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
      try { return await localArtifactManifest(target, { signal, fsApi }) }
      catch (error) {
        const refused = refusal(target, 'manifest', error)
        if (refused) return { ok: false, ...refused }
        return { ok: false, status: signal?.aborted ? 499 : 502, error: scrubSecrets(error?.message ?? error) }
      }
    }
    let reply
    try {
      reply = await sshRead(target.host, buildArtifactManifestCommand(target), 30000, { signal })
    } catch (error) {
      return { ok: false, status: 502, error: scrubSecrets(error?.message ?? error) }
    }
    if (!reply?.ok) return { ok: false, status: 502, error: scrubSecrets(reply?.err || `ssh exit ${reply?.code ?? '?'}`) }
    const parsed = parseArtifactManifest(reply.out, target)
    // A remote refusal is as reportable as a local one: an operator who is only
    // shown a status code cannot tell a tampered run from an empty one.
    if (!parsed.ok && (parsed.tamper || parsed.capability)) {
      try {
        onStreamError?.({
          host: target.host?.name ?? String(target.host ?? ''),
          runId: target.runId ?? '',
          kind: 'manifest',
          refused: true,
          error: scrubSecrets(parsed.error).slice(0, 2000),
        })
      } catch {}
    }
    return parsed
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

  // The remote command validates, then prints one status line, then streams. So
  // the status code is decided before a single artifact byte has been written to
  // the socket: a refusal is a clean 404/409/500 instead of a 200 that we would
  // have to destroy after the fact, and destroying it could not unsend bytes.
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
    let statusSeen = false
    let prefix = Buffer.alloc(0)
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
      if (code === 0 && statusSeen) {
        if (!res.destroyed && !responseFinished) res.end()
        return
      }
      if (!statusSeen && !res.headersSent) {
        // Exited without ever declaring a verdict: nothing was served, so this
        // can still be reported honestly rather than as a truncated 200.
        failureHandled = true
        report(stderr || `ssh exit ${code}`)
        sendJson(res, 502, { error: 'artifact stream failed' })
        return
      }
      if (!responseFinished) failStream(stderr || `ssh exit ${code}`)
      else report(stderr || `ssh exit ${code}`)
    })

    const begin = (status) => {
      statusSeen = true
      if (status.ok) {
        res.writeHead(200, { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...headers })
        return true
      }
      failureHandled = true
      try {
        onStreamError?.({
          host: target.host?.name ?? String(target.host ?? ''),
          runId: target.runId ?? '',
          kind,
          refused: true,
          error: scrubSecrets(status.error).slice(0, 2000),
        })
      } catch {}
      sendJson(res, status.status, { error: status.error })
      try { child.kill('SIGKILL') } catch {}
      return false
    }

    const onPrefix = (chunk) => {
      prefix = Buffer.concat([prefix, chunk])
      const newline = prefix.indexOf(0x0a)
      if (newline === -1) {
        // A status line is short and fixed-shape; anything longer is not one.
        if (prefix.length > 4096) { child.stdout.off('data', onPrefix); begin({ ok: false, status: 502, error: 'invalid artifact stream' }) }
        return
      }
      const rest = prefix.subarray(newline + 1)
      const status = parseArtifactStreamStatus(prefix.subarray(0, newline).toString('utf8'))
      // Pause before detaching so no chunk can be emitted into the gap between
      // this listener going away and pipe() taking over.
      child.stdout.pause()
      child.stdout.off('data', onPrefix)
      if (!begin(status)) return
      if (rest.length) res.write(rest)
      // Do not let stdout EOF finish a clean HTTP response before the ssh exit
      // status is known. A later non-zero close must still truncate/destroy it.
      child.stdout.pipe(res, { end: false })
    }
    child.stdout.on('data', onPrefix)
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
        const file = await openLocalArtifactFile(target, detail.path, fsApi)
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
      if (error?.statusCode === 413) { sendJson(res, 413, { error: 'artifact set too large' }); return }
      const refused = refusal(target, 'tgz', error)
      if (refused && refused.status !== 404) { sendJson(res, refused.status, { error: refused.error }); return }
      sendJson(res, 404, { error: 'artifact set changed' })
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
          let file
          try { file = await openLocalArtifactFile(target, path, fsApi) }
          catch (error) {
            const refused = refusal(target, 'file', error)
            if (!refused) throw error
            if (clientClosed || res.destroyed) return
            sendJson(res, refused.status, { error: refused.error })
            return
          }
          if (clientClosed || res.destroyed) { await closeQuietly(file.handle); return }
          const basename = path.split('/').at(-1) || 'artifact'
          streamLocalFile(req, res, target, file, {
            'content-type': 'application/octet-stream',
            'content-disposition': contentDisposition(basename, 'artifact'),
          })
          return
        }
        // One remote execution, not a probe followed by an unrelated read. The
        // two used to resolve the path independently, so nothing bound the
        // object the probe approved to the object whose bytes were served.
        if (clientClosed || res.destroyed) return
        const basename = path.split('/').at(-1) || 'artifact'
        stream(req, res, target, buildArtifactFileCommand({ ...target, path, protocol: true }), {
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
      stream(req, res, target, buildArtifactTgzCommand({ ...target, protocol: true }), {
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
  ArtifactRefusal,
  CODEX_INTERNAL_ARTIFACTS,
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
  isArtifactRefusal,
  isCrossSite,
  isExcludedArtifactPath,
  isExcludedCodexArtifactPath,
  localArtifactManifest,
  noFollowFlags,
  openLocalArtifactFile,
  openLocalRunRoot,
  parseArtifactFileProbe,
  parseArtifactManifest,
  parseArtifactStreamStatus,
  readLocalArtifactFile,
  safeDownloadFilename,
  safeRelPath,
  validateRunId,
}
