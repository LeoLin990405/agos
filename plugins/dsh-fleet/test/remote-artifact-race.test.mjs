// Path-replacement races against the REMOTE (shell) artifact reader.
//
// Everything here is offline. "ssh" is /bin/sh running the command this module
// actually generates, against a temporary directory tree, so what is under test
// is the executed semantics of the shell — never the spelling of a command
// string. No host, no network, no power operation.
//
// The synchronisation points are the command's own child processes. A shim
// earlier on PATH than the real tool logs every invocation and, when its trigger
// matches, performs the replacement synchronously before exec'ing the real tool.
// That puts the swap at an exactly identified stage of the command's execution
// without a single setTimeout, and every test asserts the shim really fired —
// otherwise a green result could just mean the race window was never entered.
//
// Only a synthetic file outside the run root is ever the attacker's target, and
// its contents are asserted never to appear in a response.
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { promises as fsp } from 'node:fs'
import { createServer, request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  createArtifactHandlers,
  buildArtifactFileCommand,
  buildArtifactFileProbeCommand,
  parseArtifactFileProbe,
  parseArtifactStreamStatus,
} from '../lib/fleet-artifacts.mjs'

// Never read the operator's real fleet state, even transitively.
process.env.DSH_FLEET_RUNS_FILE = join(tmpdir(), `dsh-fleet-remote-race-runs-${process.pid}.json`)
process.env.DSH_FLEET_LEDGER_PATH = join(tmpdir(), `dsh-fleet-remote-race-ledger-${process.pid}.json`)

const SENTINEL = 'AGOS-SENTINEL-OUTSIDE-ROOT\n'
const INSIDE_TOP = 'legit output\n'
const INSIDE_NESTED = 'inside nested text\n'
const RUN_ID = 'r-remote-race'

const REAL = { stat: '/usr/bin/stat', tar: '/usr/bin/tar', mktemp: '/usr/bin/mktemp', cat: '/bin/cat' }
const GNU_STAT = '/opt/homebrew/opt/coreutils/libexec/gnubin/stat'

const fixture = async () => {
  const root = await fsp.realpath(await fsp.mkdtemp(join(tmpdir(), 'dsh-fleet-remote-race-')))
  const workspace = join(root, 'ws')
  const runDir = join(workspace, 'tasks', RUN_ID)
  await fsp.mkdir(join(runDir, 'sub'), { recursive: true })
  await fsp.writeFile(join(runDir, 'out.txt'), INSIDE_TOP)
  await fsp.writeFile(join(runDir, 'sub', 'f.txt'), INSIDE_NESTED)
  await fsp.writeFile(join(runDir, 'pid'), '123')
  await fsp.writeFile(join(runDir, 'err.txt'), 'Bearer never-served')
  await fsp.writeFile(join(root, 'SENTINEL.txt'), SENTINEL)
  const evil = join(root, 'evil')
  await fsp.mkdir(evil)
  await fsp.writeFile(join(evil, 'f.txt'), SENTINEL)
  const control = join(root, 'control')
  await fsp.mkdir(control, { recursive: true })
  return {
    root, workspace, runDir, evil, control,
    sentinel: join(root, 'SENTINEL.txt'),
    sub: join(runDir, 'sub'),
    nested: join(runDir, 'sub', 'f.txt'),
    shim: join(control, 'bin'),
    log: join(control, 'invocations.log'),
    fired: join(control, 'fired'),
    armed: join(control, 'armed'),
    proof: join(control, 'proof'),
    cleanup: () => fsp.rm(root, { recursive: true, force: true }),
  }
}

// A swap script, run synchronously from inside the shim. rename(2) is atomic, so
// the command under test can only ever observe one whole tree or the other. It
// also records what the attacked path resolves to at that instant, which is the
// evidence that the window really did point outside the run root.
const swapScript = async (box, { target, dest, kind }) => {
  const path = join(box.control, 'swap.sh')
  const t = JSON.stringify(target)
  const steps = kind === 'dir'
    // rename(2) refuses to put a non-directory over a directory, so the real
    // directory is moved aside first and the symlink takes its name.
    ? [`ln -s ${JSON.stringify(dest)} "$staged"`, `mv ${t} ${t}.moved`, `mv "$staged" ${t}`]
    : [
      kind === 'hardlink' ? `ln ${JSON.stringify(dest)} "$staged"` : `ln -s ${JSON.stringify(dest)} "$staged"`,
      `mv -f "$staged" ${t}`,
    ]
  await fsp.writeFile(path, [
    '#!/bin/sh',
    `staged=${t}.staged`,
    'rm -rf "$staged"',
    ...steps,
    // Proof that the swapped name now resolves outside the run root.
    `cat ${JSON.stringify(kind === 'dir' ? join(target, 'f.txt') : target)} > ${JSON.stringify(box.proof)} 2>&1 || true`,
    '',
  ].join('\n'), { mode: 0o755 })
  return path
}

// The find shim is the enumeration/read boundary made explicit: it performs the
// real enumeration, fires the swap, and only then runs the worker over the list
// that was already decided. That is precisely the interval in which the old
// pipeline let tar re-resolve each name.
// The archive is preceded by a manifest that also enumerates, so the swap is
// armed by mktemp — which only the archive command runs — and fires on the
// archive's own enumeration.
const installFindShim = async (box, { swap }) => {
  await installShim(box, { tool: 'mktemp', trigger: 'false', arm: true })
  await fsp.mkdir(box.shim, { recursive: true })
  await fsp.writeFile(join(box.shim, 'find'), [
    '#!/bin/sh',
    `printf 'find\\t%s\\t%s\\n' "$PWD" "$*" >> ${JSON.stringify(box.log)}`,
    `if [ ! -e ${JSON.stringify(box.armed)} ] || [ -e ${JSON.stringify(box.fired)} ]; then exec /usr/bin/find "$@"; fi`,
    `pre=${JSON.stringify(join(box.control, 'find-pre'))}`,
    `list=${JSON.stringify(join(box.control, 'find-list'))}`,
    ': > "$pre"',
    'worker=; seen=0; skip=0',
    // Split the predicate from the -exec payload. Every predicate argument this
    // module emits is a fixed literal with no newline, so a line-per-argument
    // handoff is faithful here.
    'for a in "$@"; do',
    '  if [ "$seen" = 1 ]; then',
    '    skip=$((skip + 1))',
    '    [ "$skip" = 3 ] && worker=$a',
    '    continue',
    '  fi',
    '  if [ "$a" = "-exec" ]; then seen=1; continue; fi',
    '  printf "%s\\n" "$a" >> "$pre"',
    'done',
    // Enumerate with the real find, so the candidate list is settled.
    'set --',
    'while IFS= read -r line; do set -- "$@" "$line"; done < "$pre"',
    '/usr/bin/find "$@" -print0 > "$list"',
    `${JSON.stringify(swap)} >> ${JSON.stringify(box.log)} 2>&1`,
    `: > ${JSON.stringify(box.fired)}`,
    // Now hand the already-decided list to the worker, exactly as -exec ... +
    // would have. xargs -0 appends the pathnames after the $0 placeholder.
    'exec /usr/bin/xargs -0 /bin/sh -c "$worker" sh < "$list"',
    '',
  ].join('\n'), { mode: 0o755 })
}

// tool: which command to intercept. trigger: a shell condition, inlined so the
// shim never needs eval. `arm` lets one hook enable another, which is how a swap
// is aimed at the archive phase rather than at the manifest that precedes it.
const installShim = async (box, { tool, trigger, swap = null, arm = false, fail = false, real = REAL[tool] }) => {
  await fsp.mkdir(box.shim, { recursive: true })
  await fsp.writeFile(join(box.shim, tool), [
    '#!/bin/sh',
    `printf '%s\\t%s\\t%s\\n' ${JSON.stringify(tool)} "$PWD" "$*" >> ${JSON.stringify(box.log)}`,
    ...(tool === 'tar'
      // Drain the NUL-separated member list first: the producer's decision is
      // then complete, and the swap lands strictly before tar reads any byte.
      ? [`list=${JSON.stringify(join(box.control, 'tar-list'))}`, 'cat > "$list"']
      : []),
    `if [ ! -e ${JSON.stringify(box.fired)} ] && ${trigger}; then`,
    `  : > ${JSON.stringify(box.fired)}`,
    ...(arm ? [`  : > ${JSON.stringify(box.armed)}`] : []),
    ...(swap ? [`  ${JSON.stringify(swap)} >> ${JSON.stringify(box.log)} 2>&1`] : []),
    'fi',
    ...(arm && !swap ? [`: > ${JSON.stringify(box.armed)}`] : []),
    fail ? 'exit 1' : (tool === 'tar' ? `exec ${real} "$@" < "$list"` : `exec ${real} "$@"`),
    '',
  ].join('\n'), { mode: 0o755 })
}

const fired = async (box) => { try { await fsp.stat(box.fired); return true } catch { return false } }
const proofOf = async (box) => { try { return await fsp.readFile(box.proof, 'utf8') } catch { return '' } }
const invocations = async (box) => {
  try { return (await fsp.readFile(box.log, 'utf8')).split('\n').filter(Boolean) } catch { return [] }
}

// The fake ssh: the generated command, executed by a real shell, with the shim
// directory ahead of the real tools on PATH.
const serve = async (t, box, { realStat = REAL.stat } = {}) => {
  const env = {
    ...process.env,
    PATH: `${box.shim}:/usr/bin:/bin:/usr/sbin:/sbin`,
    AGOS_REAL_STAT: realStat,
    LC_ALL: 'C',
  }
  const calls = { read: 0, spawn: 0, commands: [] }
  const refusals = []
  const handlers = createArtifactHandlers({
    hostsOf: () => [{ name: 'fake', kind: 'remote', ssh: 'never-connected' }],
    wsOf: () => box.workspace,
    sshRead: async (_host, command) => {
      calls.read += 1
      calls.commands.push(['read', command])
      return await new Promise((resolve) => {
        const child = spawn('/bin/sh', ['-c', command], { env, stdio: ['ignore', 'pipe', 'pipe'] })
        const out = []
        const err = []
        child.stdout.on('data', (chunk) => out.push(chunk))
        child.stderr.on('data', (chunk) => err.push(chunk))
        child.on('close', (code) => resolve({
          ok: code === 0,
          out: Buffer.concat(out).toString('utf8'),
          err: Buffer.concat(err).toString('utf8'),
          code,
        }))
      })
    },
    spawnSsh: (_host, command) => {
      calls.spawn += 1
      calls.commands.push(['spawn', command])
      return spawn('/bin/sh', ['-c', command], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    },
    onStreamError: (event) => refusals.push(event),
  })
  const server = createServer((req, res) => {
    if (req.url.startsWith('/api/fleet/artifacts')) void handlers.manifestHandler(req, res)
    else void handlers.prefixHandler(req, res)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const port = server.address().port
  const get = (path) => new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port, path }, (res) => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }))
      res.on('aborted', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks), aborted: true }))
    })
    req.on('error', reject)
    req.end()
  })
  return { get, calls, refusals, env }
}

const fileUrl = (path) => `/fleet/artifact/file?host=fake&run=${RUN_ID}&path=${encodeURIComponent(path)}`
const tgzUrl = () => `/fleet/artifact/tgz?host=fake&run=${RUN_ID}`
const manifestUrl = () => `/api/fleet/artifacts?host=fake&run=${RUN_ID}`

// The whole point of the sentinel: it is synthetic, it lives outside the run
// root, and no response may ever contain it in any form.
const assertNoSentinel = (response, label) => {
  assert.equal(response.body.includes(Buffer.from('AGOS-SENTINEL')), false,
    `${label} must never return content from outside the run root`)
}

const pwdIs = (path) => `[ "$PWD" = ${JSON.stringify(path)} ]`
const armedAnd = (condition) => (box) => `[ -e ${JSON.stringify(box.armed)} ] && ${condition}`

// ---------------------------------------------------------------------------
// 1. guard -> open (the window the old before/after stat could not close)
// ---------------------------------------------------------------------------


/**
 * 拒绝有没有**上报给操作者通道**（onStreamError），以及上报的是不是那条理由。
 *
 * 原先这里写的是 `refusals.at(-1)?.refused === true` —— 它断言的是「拒绝必须是最后
 * 一个事件」。那不是真属性:拒绝之后还有拆解。实测(整套件 + 8 路 CPU 负载,三跑复现两次)
 * 数组长这样 ——
 *   [{kind:'tgz', refused:true, error:'artifact refused: symlink'},
 *    {kind:'tgz',               error:'ssh exit null'}]
 * 第 0 条正是要断言的那条拒绝,第 1 条是清理阶段 ssh 子进程被杀留下的。机器一忙,
 * 拆解事件先落进数组,`at(-1)` 就读到它 —— 红的是排序耦合,产品一点问题没有。
 *
 * 换成「存在一条 refused:true 且理由匹配」:去掉的只是无意义的顺序耦合,
 * 判别力反而更强 —— 原来那条不看理由,现在看。
 */
function assertRefusalReported(refusals, reason, kind) {
  const reported = refusals.filter((event) => event?.refused === true)
  assert.ok(
    reported.length > 0,
    `拒绝必须上报到 onStreamError,实际一条都没有:${JSON.stringify(refusals)}`,
  )
  // reason 可省:有的路由(不可区分的 404)对内对外用同一句话,拒绝由 refused 标志承载。
  const matching = reason === undefined
    ? reported
    : reported.filter((event) => reason.test(String(event.error ?? '')))
  assert.ok(
    matching.length > 0,
    `上报的拒绝理由要匹配 ${reason},实际:${JSON.stringify(reported)}`,
  )
  if (kind !== undefined) {
    assert.ok(
      matching.some((event) => event.kind === kind),
      `拒绝要归到 kind=${kind} 这条路由上,实际:${JSON.stringify(matching)}`,
    )
  }
}

test('remote file route: leaf swapped to a symlink between the path guard and the open is refused', async (t) => {
  const box = await fixture()
  t.after(box.cleanup)
  const swap = await swapScript(box, { target: box.nested, dest: box.sentinel, kind: 'symlink' })
  // The descent is pure shell builtins, so the first child process executed with
  // the leaf's parent as its working directory is the descriptor-capability
  // probe — i.e. after the guard has pinned every directory and before the leaf
  // has been opened. That is exactly the interval the old code left open.
  await installShim(box, { tool: 'stat', trigger: pwdIs(box.sub), swap })
  const { get, calls, refusals } = await serve(t, box)

  const response = await get(fileUrl('sub/f.txt'))

  assert.equal(await fired(box), true, 'the swap must actually have fired at its sync point')
  assert.equal(await proofOf(box), SENTINEL, 'the swapped leaf really did resolve outside the run root')
  assert.equal((await fsp.lstat(box.nested)).isSymbolicLink(), true, 'the planted symlink is still in place')
  assertNoSentinel(response, 'file route')
  // A single requested path that turns out to be a symlink is deliberately the
  // same 404 as a path that was never there: a distinguishable answer would let
  // the route confirm the existence of names outside the run.
  assert.equal(response.status, 404)
  assert.equal(JSON.parse(response.body).error, 'artifact not found')
  // 对外是不可区分的 404(不做存在性预言机),但操作者通道里必须留下「这是一次拒绝」。
  // 这里**不**核对理由文案:本分支的设计就是对内对外都用同一句 'artifact not found',
  // 拒绝这一事实由 refused 标志承载 —— 硬要求一个 'artifact refused: …' 的理由,
  // 等于替代码规定了它没有也不该有的行为(我第一版就是这么写错的)。
  assertRefusalReported(refusals, undefined, 'file')
  // One remote execution, so there is no second unbound resolution to attack.
  assert.equal(calls.spawn, 1)
  assert.equal(calls.read, 0)
})

test('remote file route: leaf swapped to a hardlink between the path guard and the open is refused on link count', async (t) => {
  const box = await fixture()
  t.after(box.cleanup)
  const swap = await swapScript(box, { target: box.nested, dest: box.sentinel, kind: 'hardlink' })
  await installShim(box, { tool: 'stat', trigger: pwdIs(box.sub), swap })
  const { get, refusals } = await serve(t, box)

  const response = await get(fileUrl('sub/f.txt'))

  assert.equal(await fired(box), true, 'the swap must actually have fired at its sync point')
  assert.equal(await proofOf(box), SENTINEL, 'the substituted leaf really is the outside file')
  const substituted = await fsp.lstat(box.nested)
  assert.equal(substituted.isSymbolicLink(), false, 'a hardlink is indistinguishable from a regular file by type')
  assert.equal(substituted.nlink, 2, 'the link count read through the descriptor is the only signal')
  assertNoSentinel(response, 'file route')
  assert.equal(response.status, 409)
  assert.match(JSON.parse(response.body).error, /artifact refused: hard-links/)
  assertRefusalReported(refusals, /artifact refused: hard-links/)
})

test('remote file route: a leaf replaced after validation still serves the bytes that were validated', async (t) => {
  const box = await fixture()
  t.after(box.cleanup)
  const swap = await swapScript(box, { target: box.nested, dest: box.sentinel, kind: 'hardlink' })
  // `cat` is the last child process of the command, so this swap lands after
  // every check has passed and before a single byte is read. Reading the name
  // again here would serve the attacker's file; reading the held descriptor
  // cannot, which is the whole difference between this and the old code.
  await installShim(box, { tool: 'cat', trigger: 'true', swap })
  const { get } = await serve(t, box)

  const response = await get(fileUrl('sub/f.txt'))

  assert.equal(await fired(box), true, 'the swap must actually have fired at its sync point')
  assert.equal(await proofOf(box), SENTINEL, 'the leaf name really did point at the outside file during the read')
  assert.equal((await fsp.lstat(box.nested)).nlink, 2, 'the swap is still in place while the bytes are read')
  assertNoSentinel(response, 'file route')
  assert.equal(response.status, 200)
  assert.equal(response.body.toString('utf8'), INSIDE_NESTED, 'the descriptor, not the name, decided the bytes')
})

// ---------------------------------------------------------------------------
// 2. find -> tar
// ---------------------------------------------------------------------------

test('remote tgz route: a leaf hardlinked to outside content after enumeration cannot enter the archive', async (t) => {
  const box = await fixture()
  t.after(box.cleanup)
  const swap = await swapScript(box, { target: box.nested, dest: box.sentinel, kind: 'hardlink' })
  // tar's member list is drained in full before the swap runs, so the
  // enumeration is complete and the swap lands strictly before any archive byte
  // is read. Under the old pipeline tar re-opened each name at exactly this
  // point; now tar only ever sees copies already taken from validated
  // descriptors, so the swap can no longer reach the archive.
  await installShim(box, { tool: 'tar', trigger: 'true', swap })
  const { get } = await serve(t, box)

  const response = await get(tgzUrl())

  assert.equal(await fired(box), true, 'the swap must actually have fired at its sync point')
  assert.equal(await proofOf(box), SENTINEL, 'the substituted leaf really is the outside file')
  assert.equal((await fsp.lstat(box.nested)).nlink, 2, 'the swap is still in place while tar runs')
  assertNoSentinel(response, 'tgz route')
  assert.equal(response.status, 200)
  const members = execFileSync('tar', ['-tzf', '-'], { input: response.body }).toString('utf8').trim().split('\n').sort()
  assert.deepEqual(members, ['./out.txt', './sub/f.txt'])
  const archived = execFileSync('tar', ['-xOzf', '-', './sub/f.txt'], { input: response.body }).toString('utf8')
  assert.equal(archived, INSIDE_NESTED, 'the archived bytes came from the descriptor validated before the swap')
})

test('remote tgz route: a leaf swapped inside the archive worker fails the whole archive closed', async (t) => {
  const box = await fixture()
  t.after(box.cleanup)
  const swap = await swapScript(box, { target: box.nested, dest: box.sentinel, kind: 'symlink' })
  // mktemp runs once, after the run root is pinned and before find, so it arms
  // the stat trigger for the archive phase only. Without the arming the same
  // trigger would fire during the manifest preflight instead.
  await installShim(box, { tool: 'mktemp', trigger: 'false', arm: true })
  await installShim(box, { tool: 'stat', trigger: armedAnd(pwdIs(box.sub))(box), swap })
  const { get, refusals } = await serve(t, box)

  const response = await get(tgzUrl())

  assert.equal(await fired(box), true, 'the swap must actually have fired at its sync point')
  assert.equal(await proofOf(box), SENTINEL, 'the swapped leaf really did resolve outside the run root')
  const tools = (await invocations(box)).map((line) => line.split('\t')[0])
  assert.equal(tools.includes('mktemp'), true, 'the archive phase really did arm the trigger')
  assertNoSentinel(response, 'tgz route')
  assert.equal(response.status, 409)
  assert.match(JSON.parse(response.body).error, /artifact refused: symlink/)
  assertRefusalReported(refusals, /artifact refused: symlink/)
})

// ---------------------------------------------------------------------------
// 3. probe -> stream
// ---------------------------------------------------------------------------

test('remote file route: validation and bytes are one remote execution, so there is no probe to outrun', async (t) => {
  const box = await fixture()
  t.after(box.cleanup)
  const { get, calls } = await serve(t, box)

  const response = await get(fileUrl('sub/f.txt'))

  assert.equal(response.status, 200)
  assert.equal(response.body.toString('utf8'), INSIDE_NESTED)
  assert.equal(calls.read, 0, 'no separate metadata pass may resolve the path a second time')
  assert.equal(calls.spawn, 1, 'exactly one remote execution validates and emits the bytes')
  const command = calls.commands[0][1]
  assert.equal(command.includes('cat <&3'), true, 'the bytes are read from the descriptor that was validated')
})

test('remote file route: a swap landing between a metadata pass and the byte pass is refused by the byte pass itself', async (t) => {
  const box = await fixture()
  t.after(box.cleanup)
  const { env } = await serve(t, box)
  const run = (command) => new Promise((resolve) => {
    const child = spawn('/bin/sh', ['-c', command], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    const out = []
    child.stdout.on('data', (chunk) => out.push(chunk))
    child.on('close', (code) => resolve({ code, out: Buffer.concat(out) }))
  })
  const target = { workspace: box.workspace, runId: RUN_ID, path: 'sub/f.txt' }

  // Phase one, exactly as a two-phase caller would do it.
  const probe = await run(buildArtifactFileProbeCommand(target))
  const metadata = parseArtifactFileProbe(probe.out.toString('utf8'))
  assert.equal(metadata.ok, true)
  assert.equal(metadata.value.size, INSIDE_NESTED.length)

  // The swap that used to make phase two serve a different object than phase one
  // approved. This is a synchronous JS statement between the two executions, so
  // the ordering is a fact of the program, not a timing bet.
  const swap = await swapScript(box, { target: box.nested, dest: box.sentinel, kind: 'hardlink' })
  execFileSync('/bin/sh', [swap], { env })
  assert.equal(await proofOf(box), SENTINEL, 'phase two now names the outside file')

  // Phase two refuses on its own evidence rather than trusting phase one.
  const bytes = await run(buildArtifactFileCommand({ ...target, protocol: true }))
  const line = bytes.out.subarray(0, bytes.out.indexOf(0x0a)).toString('utf8')
  const status = parseArtifactStreamStatus(line)
  assert.equal(status.ok, false)
  assert.equal(status.status, 409)
  assert.match(status.error, /hard-links/)
  assert.equal(bytes.out.includes(Buffer.from('AGOS-SENTINEL')), false, 'no byte of the outside file was emitted')

  // And the non-protocol form used by the workspace preview refuses too.
  const plain = await run(buildArtifactFileCommand(target))
  assert.notEqual(plain.code, 0, 'a refusal is a non-zero exit for a plain sshRead consumer')
  assert.equal(plain.out.includes(Buffer.from('AGOS-SENTINEL')), false)
})

// ---------------------------------------------------------------------------
// 4. directory replacement (as distinct from leaf replacement)
// ---------------------------------------------------------------------------

test('remote tgz route: a directory component swapped between enumeration and the read is refused', async (t) => {
  const box = await fixture()
  t.after(box.cleanup)
  const swap = await swapScript(box, { target: box.sub, dest: box.evil, kind: 'dir' })
  // The worker still receives ./sub/f.txt, because that is what enumeration
  // produced, but sub/ is now a symlink into the attacker's tree. Under the old
  // pipeline tar resolved that name and archived the attacker's file.
  await installFindShim(box, { swap })
  const { get, refusals } = await serve(t, box)

  const response = await get(tgzUrl())

  assert.equal(await fired(box), true, 'the swap must actually have fired at its sync point')
  assert.equal(await proofOf(box), SENTINEL, 'the swapped directory really did resolve to the attacker tree')
  assert.equal((await fsp.lstat(box.sub)).isSymbolicLink(), true, 'the planted directory symlink is still in place')
  const enumerated = (await fsp.readFile(join(box.control, 'find-list'))).toString('utf8')
  assert.equal(enumerated.includes('./sub/f.txt'), true, 'enumeration really did decide the path before the swap')
  assertNoSentinel(response, 'tgz route')
  assert.equal(response.status, 409)
  assert.match(JSON.parse(response.body).error, /artifact refused: path-segment/)
  assertRefusalReported(refusals, /artifact refused: path-segment/)
})

test('remote tgz route: a leaf hardlinked to outside content between enumeration and the read is refused', async (t) => {
  const box = await fixture()
  t.after(box.cleanup)
  const swap = await swapScript(box, { target: box.nested, dest: box.sentinel, kind: 'hardlink' })
  await installFindShim(box, { swap })
  const { get, refusals } = await serve(t, box)

  const response = await get(tgzUrl())

  assert.equal(await fired(box), true, 'the swap must actually have fired at its sync point')
  assert.equal(await proofOf(box), SENTINEL, 'the substituted leaf really is the outside file')
  const enumerated = (await fsp.readFile(join(box.control, 'find-list'))).toString('utf8')
  assert.equal(enumerated.includes('./sub/f.txt'), true, 'enumeration really did decide the path before the swap')
  assertNoSentinel(response, 'tgz route')
  assert.equal(response.status, 409)
  assert.match(JSON.parse(response.body).error, /artifact refused: hard-links/)
  assertRefusalReported(refusals, /artifact refused: hard-links/)
})

test('remote file route: a directory component swapped after the descent cannot redirect the held read', async (t) => {
  const box = await fixture()
  t.after(box.cleanup)
  const swap = await swapScript(box, { target: box.sub, dest: box.evil, kind: 'dir' })
  // Fired once the shell already holds sub/ as its working directory. `cd` is a
  // chdir, so the swap cannot redirect what the rest of the command resolves —
  // the correct outcome here is the original bytes, not a refusal.
  await installShim(box, { tool: 'stat', trigger: pwdIs(box.sub), swap })
  const { get } = await serve(t, box)

  const response = await get(fileUrl('sub/f.txt'))

  assert.equal(await fired(box), true, 'the swap must actually have fired at its sync point')
  assert.equal(await proofOf(box), SENTINEL, 'the swapped name really did resolve to the attacker tree')
  assert.equal((await fsp.lstat(box.sub)).isSymbolicLink(), true, 'the planted directory symlink is still in place')
  assertNoSentinel(response, 'file route')
  assert.equal(response.status, 200)
  assert.equal(response.body.toString('utf8'), INSIDE_NESTED, 'the pinned directory still resolves the real artifact')
})

test('remote manifest: a leaf swapped during the walk fails the listing closed instead of reporting the swap', async (t) => {
  const box = await fixture()
  t.after(box.cleanup)
  const swap = await swapScript(box, { target: box.nested, dest: box.sentinel, kind: 'hardlink' })
  await installShim(box, { tool: 'stat', trigger: pwdIs(box.sub), swap })
  const { get, refusals } = await serve(t, box)

  const response = await get(manifestUrl())

  assert.equal(await fired(box), true, 'the swap must actually have fired at its sync point')
  assert.equal(await proofOf(box), SENTINEL, 'the substituted leaf really is the outside file')
  assertNoSentinel(response, 'manifest route')
  assert.equal(response.status, 409)
  assert.match(JSON.parse(response.body).error, /artifact refused: hard-links/)
  assertRefusalReported(refusals, /artifact refused: hard-links/, 'manifest')
})

// ---------------------------------------------------------------------------
// 5. symlink / hardlink planted before the request (no race at all)
// ---------------------------------------------------------------------------

test('remote routes: symlinks and hardlinks planted before the request never yield outside content', async (t) => {
  const box = await fixture()
  t.after(box.cleanup)
  await fsp.symlink(box.sentinel, join(box.runDir, 'leaf-link'))
  await fsp.symlink(box.root, join(box.runDir, 'escape-dir'))
  await fsp.link(box.sentinel, join(box.runDir, 'stolen.txt'))
  const { get } = await serve(t, box)

  // A symlinked leaf and a symlinked path segment are indistinguishable 404s.
  for (const path of ['leaf-link', 'escape-dir/SENTINEL.txt']) {
    const response = await get(fileUrl(path))
    assertNoSentinel(response, `file route ${path}`)
    assert.equal(response.status, 404, path)
    assert.equal(JSON.parse(response.body).error, 'artifact not found')
  }

  // A hardlink is a regular file by every test except its link count, and
  // realpath reports it under its inside name, so the link count is the only
  // thing that can refuse it.
  const stolen = await get(fileUrl('stolen.txt'))
  assertNoSentinel(stolen, 'file route stolen.txt')
  assert.equal(stolen.status, 409)
  assert.match(JSON.parse(stolen.body).error, /hard-links/)

  const manifest = await get(manifestUrl())
  assertNoSentinel(manifest, 'manifest route')
  assert.equal(manifest.status, 200)
  assert.deepEqual(JSON.parse(manifest.body).files.map((file) => file.path).sort(), ['out.txt', 'sub/f.txt'])

  const tgz = await get(tgzUrl())
  assertNoSentinel(tgz, 'tgz route')
  assert.equal(tgz.status, 200)
  const members = execFileSync('tar', ['-tzf', '-'], { input: tgz.body }).toString('utf8').trim().split('\n').sort()
  assert.deepEqual(members, ['./out.txt', './sub/f.txt'], 'neither the symlink nor the hardlink is archived')
})

// ---------------------------------------------------------------------------
// 6. legitimate reads (the control against a refuse-everything "fix")
// ---------------------------------------------------------------------------

test('remote routes: legitimate artifacts read, list and archive with no refusals at all', async (t) => {
  const box = await fixture()
  t.after(box.cleanup)
  await fsp.writeFile(join(box.runDir, 'payload.bin'), Buffer.from([0x41, 0x00, 0xff, 0x42]))
  await fsp.writeFile(join(box.runDir, 'chinese.md'), Buffer.from('中文 UTF-8 报告\n', 'utf8'))
  const { get, refusals } = await serve(t, box)

  const manifest = await get(manifestUrl())
  assert.equal(manifest.status, 200)
  const listing = JSON.parse(manifest.body)
  assert.deepEqual(listing.files.map((file) => file.path).sort(),
    ['chinese.md', 'out.txt', 'payload.bin', 'sub/f.txt'])
  assert.equal(listing.count, 4)
  assert.equal(listing.truncated, false)
  assert.equal(listing.files.find((file) => file.path === 'payload.bin').binary, true, 'NUL marks binary')
  assert.equal(listing.files.find((file) => file.path === 'chinese.md').binary, false, 'UTF-8 high bytes are text')
  assert.equal(listing.files.find((file) => file.path === 'sub/f.txt').size, INSIDE_NESTED.length)
  assert.equal(listing.files.every((file) => Number.isFinite(file.mtime) && file.mtime > 0), true)
  assert.equal(listing.totalBytes, INSIDE_TOP.length + INSIDE_NESTED.length + 4 + Buffer.byteLength('中文 UTF-8 报告\n'))

  const top = await get(fileUrl('out.txt'))
  assert.equal(top.status, 200)
  assert.equal(top.body.toString('utf8'), INSIDE_TOP)
  const nested = await get(fileUrl('sub/f.txt'))
  assert.equal(nested.status, 200)
  assert.equal(nested.body.toString('utf8'), INSIDE_NESTED)
  const binary = await get(fileUrl('payload.bin'))
  assert.equal(binary.status, 200)
  assert.deepEqual(binary.body, Buffer.from([0x41, 0x00, 0xff, 0x42]), 'a NUL-bearing artifact survives the descriptor read byte for byte')

  const tgz = await get(tgzUrl())
  assert.equal(tgz.status, 200)
  const members = execFileSync('tar', ['-tzf', '-'], { input: tgz.body }).toString('utf8').trim().split('\n').sort()
  assert.deepEqual(members, ['./chinese.md', './out.txt', './payload.bin', './sub/f.txt'])
  assert.equal(execFileSync('tar', ['-xOzf', '-', './sub/f.txt'], { input: tgz.body }).toString('utf8'), INSIDE_NESTED)

  // Control files stay excluded and a clean run refuses nothing.
  assert.equal((await get(fileUrl('pid'))).status, 400)
  assert.equal((await get(fileUrl('err.txt'))).status, 400)
  assert.deepEqual(refusals, [])
})

test('remote routes: the GNU stat branch reads legitimate artifacts and still refuses a swapped leaf', async (t) => {
  const box = await fixture()
  t.after(box.cleanup)
  let hasGnu = true
  try { await fsp.access(GNU_STAT) } catch { hasGnu = false }
  // The remote fleet is Linux, so the GNU format branch is the one that runs in
  // production. Skipping silently would leave it unverified.
  t.skip = !hasGnu
  if (!hasGnu) return

  const clean = await serve(t, box, { realStat: GNU_STAT })
  await installShim(box, { tool: 'stat', trigger: 'false', real: GNU_STAT })
  const good = await clean.get(fileUrl('sub/f.txt'))
  assert.equal(good.status, 200)
  assert.equal(good.body.toString('utf8'), INSIDE_NESTED)
  const manifest = await clean.get(manifestUrl())
  assert.equal(manifest.status, 200)
  assert.deepEqual(JSON.parse(manifest.body).files.map((file) => file.path).sort(), ['out.txt', 'sub/f.txt'])

  const swap = await swapScript(box, { target: box.nested, dest: box.sentinel, kind: 'hardlink' })
  await installShim(box, { tool: 'stat', trigger: pwdIs(box.sub), swap, real: GNU_STAT })
  const attacked = await clean.get(fileUrl('sub/f.txt'))
  assert.equal(await fired(box), true, 'the swap must actually have fired at its sync point')
  assertNoSentinel(attacked, 'file route under GNU stat')
  assert.equal(attacked.status, 409)
  assert.match(JSON.parse(attacked.body).error, /hard-links/)
})

// ---------------------------------------------------------------------------
// 7. missing remote capability is refused explicitly, never approximated
// ---------------------------------------------------------------------------

test('remote routes: a host that cannot stat an open descriptor is refused with the reason, not served weakly', async (t) => {
  const box = await fixture()
  t.after(box.cleanup)
  // A remote whose stat cannot report anything is a host on which a
  // descriptor-bound read is inexpressible. The only honest answers are "no",
  // and why. Approximating it with a pair of path stats is the original bug.
  await installShim(box, { tool: 'stat', trigger: 'false', fail: true })
  const { get, refusals } = await serve(t, box)

  const file = await get(fileUrl('sub/f.txt'))
  assertNoSentinel(file, 'file route')
  assert.equal(file.status, 500)
  assert.match(JSON.parse(file.body).error, /remote cannot guarantee descriptor-bound artifact reads/)

  const manifest = await get(manifestUrl())
  assert.equal(manifest.status, 500)
  assert.match(JSON.parse(manifest.body).error, /remote cannot guarantee descriptor-bound artifact reads/)

  const tgz = await get(tgzUrl())
  assert.equal(tgz.status, 500)
  assert.match(JSON.parse(tgz.body).error, /remote cannot guarantee descriptor-bound artifact reads/)

  const log = await invocations(box)
  assert.equal(log.length > 0, true, 'the capability probe really did run and really did fail')
  assert.equal(log.every((line) => line.startsWith('stat\t')), true)
  assert.equal(refusals.length >= 3, true, 'every refusal is reported to the operator')
  assert.equal(refusals.every((event) => event.refused === true), true)
})

// ---------------------------------------------------------------------------
// 8. the bounded preview read the workspace browser needs
// ---------------------------------------------------------------------------

// A caller wanting a prefix must get the cap applied to the held descriptor. The
// alternative — piping the command into `head` — hands back head's exit status,
// so a refusal arrives indistinguishable from a successful read of empty file.
test('remote file route: a bounded preview read caps the held descriptor and still reports refusals', async (t) => {
  const box = await fixture()
  t.after(box.cleanup)
  const long = 'A'.repeat(100) + '\n'
  await fsp.writeFile(box.nested, long)
  const { env } = await serve(t, box)
  const run = (command) => new Promise((resolve) => {
    const child = spawn('/bin/sh', ['-c', command], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    const out = []
    child.stdout.on('data', (chunk) => out.push(chunk))
    child.on('close', (code) => resolve({ code, out: Buffer.concat(out).toString('utf8') }))
  })
  const split = (out) => {
    const nl = out.indexOf('\n')
    return { verdict: parseArtifactStreamStatus(out.slice(0, nl)), body: out.slice(nl + 1) }
  }

  const capped = await run(buildArtifactFileCommand({
    workspace: box.workspace, runId: RUN_ID, path: 'sub/f.txt', protocol: true, limitBytes: 16,
  }))
  const good = split(capped.out)
  assert.equal(capped.code, 0)
  assert.equal(good.verdict.ok, true)
  assert.equal(good.verdict.size, long.length, 'the verdict reports the whole object, not the truncated read')
  assert.equal(good.body, long.slice(0, 16), 'exactly the requested prefix, taken from the descriptor')

  // Same bounded read, now with the leaf hardlinked to outside content between
  // the guard and the open. The cap must not cost the caller the refusal.
  const swap = await swapScript(box, { target: box.nested, dest: box.sentinel, kind: 'hardlink' })
  await installShim(box, { tool: 'stat', trigger: pwdIs(box.sub), swap })
  const attacked = await run(buildArtifactFileCommand({
    workspace: box.workspace, runId: RUN_ID, path: 'sub/f.txt', protocol: true, limitBytes: 16,
  }))
  assert.equal(await fired(box), true, 'the swap must actually have fired at its sync point')
  assert.equal(attacked.out.includes('AGOS-SENTINEL'), false, 'a bounded read must not leak outside content either')
  const bad = split(attacked.out)
  assert.equal(bad.verdict.ok, false)
  assert.equal(bad.verdict.status, 409)
  assert.match(bad.verdict.error, /hard-links/)
  assert.equal(bad.body, '', 'the refusal is declared and no byte follows it')
})
