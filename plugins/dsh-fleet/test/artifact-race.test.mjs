// Path-replacement races against the local (Codex host) artifact reader.
//
// Everything here is offline: real temp directories, real symlink/hardlink
// syscalls, and the real HTTP handlers from lib/fleet-artifacts.mjs. sshRead and
// spawnSsh are stubs that throw, so no invocation can reach a network host.
//
// There is no setTimeout anywhere. Each swap is executed synchronously inside
// the very syscall the reader uses as its check, through an injected fs surface,
// so the swap is guaranteed to land after that check and before the next use.
// Every test also asserts that its sync point actually fired and records what
// the attacked path resolved to at that instant, so a passing assertion is
// evidence of an executed race and not of a no-op.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { promises as fsp } from 'node:fs'
import { createServer, request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  ArtifactRefusal,
  createArtifactHandlers,
  noFollowFlags,
} from '../lib/fleet-artifacts.mjs'

const SECRET = 'BEGIN OPENSSH PRIVATE KEY outside-the-run-root\n'
const INSIDE_NESTED = 'inside nested text\n'
const INSIDE_TOP = 'legit output\n'
const RUN_ID = 'r-race'

// evil/f.txt shadows the legitimate nested name and carries a NUL, so a
// successful read would also flip the manifest's binary flag.
const EVIL_NESTED = Buffer.from('OUTSIDE\u0000BYTES\n', 'utf8')

const fixture = async () => {
  const root = await fsp.mkdtemp(join(tmpdir(), 'dsh-fleet-artifact-race-'))
  const workspace = join(root, 'ws')
  const runDir = join(workspace, 'tasks', RUN_ID)
  await fsp.mkdir(join(runDir, 'sub'), { recursive: true })
  await fsp.writeFile(join(runDir, 'out.txt'), INSIDE_TOP)
  await fsp.writeFile(join(runDir, 'sub', 'f.txt'), INSIDE_NESTED)
  await fsp.writeFile(join(runDir, 'pid'), '123')
  await fsp.writeFile(join(runDir, 'err.txt'), 'Bearer never-served')
  await fsp.writeFile(join(root, 'OUTSIDE-SECRET.txt'), SECRET)
  const evil = join(root, 'evil')
  await fsp.mkdir(evil)
  await fsp.writeFile(join(evil, 'f.txt'), EVIL_NESTED)
  await fsp.writeFile(join(evil, 'EXTRA-OUTSIDE.txt'), 'x'.repeat(4242))
  // macOS resolves the temp root through /private, and the reader works in
  // canonical paths, so hook matching has to use canonical paths too.
  const runReal = await fsp.realpath(runDir)
  return {
    root, workspace, evil,
    evilReal: await fsp.realpath(evil),
    runReal,
    secretPath: join(root, 'OUTSIDE-SECRET.txt'),
    sub: join(runReal, 'sub'),
    nested: join(runReal, 'sub', 'f.txt'),
    cleanup: () => fsp.rm(root, { recursive: true, force: true }),
  }
}

// An ordered list of sync points. Each step fires at most once and only when the
// phase, method and first argument all match, so the reader's own syscalls are
// the clock. `pending()` is what proves the race was exercised.
const sequencer = (steps) => {
  let index = 0
  const fired = []
  const fire = async (phase, method, args) => {
    const step = steps[index]
    if (!step || step.phase !== phase || step.method !== method || String(args[0]) !== step.path) return
    index += 1
    fired.push(`${phase}:${method}:${step.label}`)
    await step.run()
  }
  return { fire, fired, pending: () => steps.length - index }
}

const hookedFs = (sequence) => {
  const surface = { ...fsp, constants: fsp.constants }
  for (const method of ['open', 'lstat', 'realpath', 'readdir']) {
    const original = fsp[method].bind(fsp)
    surface[method] = async (...args) => {
      await sequence.fire('before', method, args)
      const result = await original(...args)
      await sequence.fire('after', method, args)
      return result
    }
  }
  return surface
}

// Swap primitives. rename() is atomic, so the reader can never observe a
// half-applied swap; it sees either the legitimate object or the attacker's.
const plantDirSymlink = async (target, destination) => {
  const staged = `${target}.staged-link`
  await fsp.symlink(destination, staged)
  await fsp.rename(target, `${target}.moved`)
  await fsp.rename(staged, target)
}

const revertDirSymlink = async (target) => {
  await fsp.unlink(target)
  await fsp.rename(`${target}.moved`, target)
}

const replaceWithSymlink = async (target, destination) => {
  const staged = `${target}.staged-link`
  await fsp.symlink(destination, staged)
  await fsp.rename(staged, target)
}

const replaceWithHardlink = async (target, destination) => {
  const staged = `${target}.staged-hard`
  await fsp.link(destination, staged)
  await fsp.rename(staged, target)
}

// What does this path resolve to right now, through an unhooked fs? Recorded at
// swap time to prove the attacked window really pointed outside the run root.
const peek = async (path) => {
  try { return (await fsp.readFile(path)).toString('utf8') } catch (error) { return `<${error.code}>` }
}

const serve = async (t, { workspace, fsApi }) => {
  const refusals = []
  const handlers = createArtifactHandlers({
    hostsOf: () => [{ name: 'codex', kind: 'codex', workspace }],
    wsOf: (host) => host.workspace,
    sshRead: async () => { throw new Error('ssh is forbidden in this suite') },
    spawnSsh: () => { throw new Error('ssh is forbidden in this suite') },
    onStreamError: (event) => refusals.push(event),
    ...(fsApi ? { fsApi } : {}),
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
    })
    req.on('error', reject)
    req.end()
  })
  return { get, refusals, handlers }
}

const fileUrl = (path) => `/fleet/artifact/file?host=codex&run=${RUN_ID}&path=${encodeURIComponent(path)}`
const manifestUrl = () => `/api/fleet/artifacts?host=codex&run=${RUN_ID}`

const assertNoOutsideContent = (response, label) => {
  const body = response.body.toString('utf8')
  assert.equal(body.includes('OPENSSH'), false, `${label} must never return content from outside the run root`)
  assert.equal(body.includes('OUTSIDE'), false, `${label} must never return content from outside the run root`)
  assert.equal(body.includes('EXTRA-OUTSIDE'), false, `${label} must never name content from outside the run root`)
}

test('a directory component swapped for an outside symlink between check and open is refused', async (t) => {
  const box = await fixture()
  t.after(box.cleanup)
  let resolvedDuringSwap = null
  const sequence = sequencer([
    {
      // The reader's last check on sub/ is the lstat inside assertPinnedName.
      // Swapping here lands the symlink strictly between that check and the
      // open of sub/f.txt, which is the window O_NOFOLLOW cannot close because
      // O_NOFOLLOW only constrains the final component.
      phase: 'after', method: 'lstat', path: box.sub, label: 'dir-check-done',
      run: async () => {
        await plantDirSymlink(box.sub, box.evil)
        resolvedDuringSwap = await peek(box.nested)
      },
    },
  ])
  const { get, refusals } = await serve(t, { workspace: box.workspace, fsApi: hookedFs(sequence) })

  const response = await get(fileUrl('sub/f.txt'))

  assert.equal(sequence.pending(), 0, 'the swap must actually have fired at its sync point')
  assert.equal(resolvedDuringSwap, EVIL_NESTED.toString('utf8'), 'the swapped window really did resolve outside the run root')
  assert.equal((await fsp.lstat(box.sub)).isSymbolicLink(), true, 'the planted symlink is still in place')
  assertNoOutsideContent(response, 'file route')
  assert.equal(response.status, 409)
  assert.match(JSON.parse(response.body).error, /canonical/)
  assert.equal(refusals.at(-1)?.refused, true)
  assert.match(refusals.at(-1)?.error, /canonical/)
})

test('a directory component swapped and reverted around the open is caught by the handle inode', async (t) => {
  const box = await fixture()
  t.after(box.cleanup)
  let openedOutside = null
  const sequence = sequencer([
    {
      phase: 'after', method: 'lstat', path: box.sub, label: 'dir-check-done',
      run: () => plantDirSymlink(box.sub, box.evil),
    },
    {
      // The strongest form of the attack: the kernel has already resolved
      // sub/f.txt through the planted symlink and handed back a descriptor on
      // the outside file, and the attacker restores the real directory before
      // any post-open validation can look at the path again. Only an inode
      // comparison against the descriptor can detect this.
      phase: 'after', method: 'open', path: box.nested, label: 'leaf-open-done',
      run: async () => {
        openedOutside = await fsp.realpath(box.nested)
        await revertDirSymlink(box.sub)
      },
    },
  ])
  const { get, refusals } = await serve(t, { workspace: box.workspace, fsApi: hookedFs(sequence) })

  const response = await get(fileUrl('sub/f.txt'))

  assert.equal(sequence.pending(), 0, 'both sync points must actually have fired')
  assert.equal(openedOutside, join(box.evilReal, 'f.txt'), 'the descriptor really was opened on outside content')
  assert.equal((await fsp.lstat(box.sub)).isSymbolicLink(), false, 'the attacker restored the real directory')
  assert.equal(await peek(box.nested), INSIDE_NESTED, 'the path looks legitimate again after the revert')
  assertNoOutsideContent(response, 'file route')
  assert.equal(response.status, 409)
  assert.match(JSON.parse(response.body).error, /replaced during validation/)
  assert.match(refusals.at(-1)?.error, /replaced during validation/)
})

test('the target file replaced by a symlink to outside content mid-operation is refused by the kernel', async (t) => {
  const box = await fixture()
  t.after(box.cleanup)
  let resolvedDuringSwap = null
  const sequence = sequencer([
    {
      phase: 'after', method: 'lstat', path: box.sub, label: 'dir-check-done',
      run: async () => {
        await replaceWithSymlink(box.nested, box.secretPath)
        resolvedDuringSwap = await peek(box.nested)
      },
    },
  ])
  const { get, refusals } = await serve(t, { workspace: box.workspace, fsApi: hookedFs(sequence) })

  const response = await get(fileUrl('sub/f.txt'))

  assert.equal(sequence.pending(), 0, 'the swap must actually have fired at its sync point')
  assert.equal(resolvedDuringSwap, SECRET, 'the swapped leaf really did resolve to outside content')
  assert.equal((await fsp.lstat(box.nested)).isSymbolicLink(), true, 'the leaf is a symlink at read time')
  assertNoOutsideContent(response, 'file route')
  assert.equal(response.status, 404)
  assert.equal(JSON.parse(response.body).error, 'artifact not found')
  // ELOOP is the kernel refusing the open, not a string comparison of ours.
  assert.match(refusals.at(-1)?.error, /ELOOP/)
})

test('a hardlink to an outside file substituted mid-operation is refused on link count', async (t) => {
  const box = await fixture()
  t.after(box.cleanup)
  let resolvedDuringSwap = null
  const sequence = sequencer([
    {
      phase: 'after', method: 'lstat', path: box.sub, label: 'dir-check-done',
      run: async () => {
        await replaceWithHardlink(box.nested, box.secretPath)
        resolvedDuringSwap = await peek(box.nested)
      },
    },
  ])
  const { get, refusals } = await serve(t, { workspace: box.workspace, fsApi: hookedFs(sequence) })

  const response = await get(fileUrl('sub/f.txt'))

  assert.equal(sequence.pending(), 0, 'the swap must actually have fired at its sync point')
  assert.equal(resolvedDuringSwap, SECRET, 'the substituted leaf really is the outside file')
  const substituted = await fsp.lstat(box.nested)
  assert.equal(substituted.isSymbolicLink(), false, 'a hardlink is indistinguishable from a regular file by type')
  assert.equal(substituted.nlink, 2, 'link count is the only signal available')
  assertNoOutsideContent(response, 'file route')
  assert.equal(response.status, 409)
  assert.match(JSON.parse(response.body).error, /hard links/)
  assert.match(refusals.at(-1)?.error, /hard links/)
})

test('a hardlink planted before the request escapes neither the file route nor the manifest', async (t) => {
  const box = await fixture()
  t.after(box.cleanup)
  // No race at all: realpath() reports a hardlink under its inside name, so
  // every path-based check agrees this file is inside the run root.
  await fsp.link(box.secretPath, join(box.runReal, 'stolen.txt'))
  assert.equal(await fsp.realpath(join(box.runReal, 'stolen.txt')), join(box.runReal, 'stolen.txt'))
  assert.equal(await peek(join(box.runReal, 'stolen.txt')), SECRET)
  const { get } = await serve(t, { workspace: box.workspace })

  const file = await get(fileUrl('stolen.txt'))
  assertNoOutsideContent(file, 'file route')
  assert.equal(file.status, 409)
  assert.match(JSON.parse(file.body).error, /hard links/)

  // The manifest is an aggregate, so a tampered member makes the whole listing
  // untrustworthy: it fails closed rather than quietly omitting the entry.
  const manifest = await get(manifestUrl())
  assertNoOutsideContent(manifest, 'manifest route')
  assert.equal(manifest.status, 409)
  assert.match(JSON.parse(manifest.body).error, /hard links/)

  const tgz = await get(`/fleet/artifact/tgz?host=codex&run=${RUN_ID}`)
  assert.equal(tgz.status, 409)
  assertNoOutsideContent(tgz, 'tgz route')
})

test('a foreign listing injected around readdir cannot enter the manifest', async (t) => {
  const box = await fixture()
  t.after(box.cleanup)
  let listedOutside = null
  const sequence = sequencer([
    {
      // readdir resolves sub/ by path, so plant the symlink immediately before
      // it and restore the real directory immediately after. Both of the
      // reader's pins on sub/ therefore see the legitimate inode while the
      // listing itself comes from the attacker's tree.
      phase: 'before', method: 'readdir', path: box.sub, label: 'listing-window-open',
      run: () => plantDirSymlink(box.sub, box.evil),
    },
    {
      phase: 'after', method: 'readdir', path: box.sub, label: 'listing-window-closed',
      run: async () => {
        listedOutside = (await fsp.readdir(box.sub)).sort()
        await revertDirSymlink(box.sub)
      },
    },
  ])
  const { get } = await serve(t, { workspace: box.workspace, fsApi: hookedFs(sequence) })

  const response = await get(manifestUrl())

  assert.equal(sequence.pending(), 0, 'both sync points must actually have fired')
  assert.deepEqual(listedOutside, ['EXTRA-OUTSIDE.txt', 'f.txt'], 'readdir really did list the attacker tree')
  assertNoOutsideContent(response, 'manifest route')
  assert.equal(response.status, 200)
  const manifest = JSON.parse(response.body)
  // readdir is only a candidate generator now. Every candidate re-proves itself
  // through the handle-bound opener, so the injected name is dropped and the
  // surviving entry's size and binary flag come from the inside file.
  assert.deepEqual(manifest.files.map((file) => file.path).sort(), ['out.txt', 'sub/f.txt'])
  const nested = manifest.files.find((file) => file.path === 'sub/f.txt')
  assert.equal(nested.size, INSIDE_NESTED.length, 'size comes from the validated handle, not the foreign lstat')
  assert.equal(nested.binary, false, 'the binary flag is sniffed through the validated handle')
  assert.equal(manifest.count, 2)
  assert.equal(manifest.totalBytes, INSIDE_TOP.length + INSIDE_NESTED.length)
})

test('a directory swap left in place during the walk fails the whole manifest closed', async (t) => {
  const box = await fixture()
  t.after(box.cleanup)
  const sequence = sequencer([
    {
      phase: 'before', method: 'readdir', path: box.sub, label: 'listing-window-open',
      run: () => plantDirSymlink(box.sub, box.evil),
    },
  ])
  const { get, refusals } = await serve(t, { workspace: box.workspace, fsApi: hookedFs(sequence) })

  const response = await get(manifestUrl())

  assert.equal(sequence.pending(), 0, 'the swap must actually have fired at its sync point')
  assert.equal((await fsp.lstat(box.sub)).isSymbolicLink(), true, 'the planted symlink is still in place')
  assertNoOutsideContent(response, 'manifest route')
  assert.equal(response.status, 409)
  assert.match(JSON.parse(response.body).error, /canonical/)
  assert.equal(refusals.at(-1)?.refused, true)
})

test('legitimate artifacts still read, list, and archive with no false refusals', async (t) => {
  const box = await fixture()
  t.after(box.cleanup)
  const { get, refusals } = await serve(t, { workspace: box.workspace })

  const manifest = await get(manifestUrl())
  assert.equal(manifest.status, 200)
  const listing = JSON.parse(manifest.body)
  assert.deepEqual(listing.files.map((file) => file.path).sort(), ['out.txt', 'sub/f.txt'])
  assert.equal(listing.count, 2)
  assert.equal(listing.totalBytes, INSIDE_TOP.length + INSIDE_NESTED.length)
  assert.equal(listing.truncated, false)
  assert.equal(listing.files.every((file) => file.binary === false), true)
  assert.equal(listing.files.every((file) => Number.isFinite(file.mtime) && file.mtime > 0), true)

  const top = await get(fileUrl('out.txt'))
  assert.equal(top.status, 200)
  assert.equal(top.body.toString('utf8'), INSIDE_TOP)
  assert.equal(top.headers['content-length'], String(INSIDE_TOP.length))

  const nested = await get(fileUrl('sub/f.txt'))
  assert.equal(nested.status, 200)
  assert.equal(nested.body.toString('utf8'), INSIDE_NESTED)

  const tgz = await get(`/fleet/artifact/tgz?host=codex&run=${RUN_ID}`)
  assert.equal(tgz.status, 200)
  const names = execFileSync('tar', ['-tzf', '-'], { input: tgz.body }).toString('utf8').trim().split('\n').sort()
  assert.deepEqual(names, ['./out.txt', './sub/f.txt'])

  // Control files stay excluded, and a clean run logs no refusals at all.
  assert.equal((await get(fileUrl('pid'))).status, 400)
  assert.equal((await get(fileUrl('err.txt'))).status, 400)
  assert.deepEqual(refusals, [])
})

test('a binary artifact is still detected as binary through the validated handle', async (t) => {
  const box = await fixture()
  t.after(box.cleanup)
  await fsp.writeFile(join(box.runReal, 'payload.bin'), Buffer.from([0x41, 0x00, 0xff, 0x42]))
  await fsp.writeFile(join(box.runReal, 'chinese.md'), Buffer.from('中文 UTF-8 报告\n', 'utf8'))
  const { get } = await serve(t, { workspace: box.workspace })

  const manifest = JSON.parse((await get(manifestUrl())).body)
  assert.equal(manifest.files.find((file) => file.path === 'payload.bin').binary, true, 'NUL marks binary')
  assert.equal(manifest.files.find((file) => file.path === 'chinese.md').binary, false, 'UTF-8 high bytes are text')
})

test('a platform without O_NOFOLLOW or O_DIRECTORY fails closed with the reason, never a weaker check', async (t) => {
  const box = await fixture()
  t.after(box.cleanup)
  // Static assertion: the running kernel cannot have these flags removed, so the
  // gate is exercised by handing the reader an fs surface that does not offer
  // them. It is still the real code path, and it still refuses before any open.
  assert.throws(() => noFollowFlags({ O_RDONLY: 0 }), (error) => {
    assert.equal(error instanceof ArtifactRefusal, true)
    assert.equal(error.capability, true)
    assert.equal(error.status, 500)
    assert.match(error.reason, /missing O_NOFOLLOW, O_DIRECTORY/)
    return true
  })
  assert.throws(() => noFollowFlags({ O_RDONLY: 0, O_NOFOLLOW: 256 }), /missing O_DIRECTORY/)
  assert.doesNotThrow(() => noFollowFlags({ O_RDONLY: 0, O_NOFOLLOW: 256, O_DIRECTORY: 1048576 }))

  let opens = 0
  const blind = {
    ...fsp,
    constants: { O_RDONLY: 0 },
    open: async (...args) => { opens += 1; return fsp.open(...args) },
  }
  const { get, refusals } = await serve(t, { workspace: box.workspace, fsApi: blind })

  for (const [label, url] of [['file', fileUrl('out.txt')], ['manifest', manifestUrl()], ['tgz', `/fleet/artifact/tgz?host=codex&run=${RUN_ID}`]]) {
    const response = await get(url)
    assert.equal(response.status, 500, `${label} must fail closed`)
    assert.match(JSON.parse(response.body).error, /platform cannot guarantee symlink-safe artifact reads/)
  }
  assert.equal(opens, 0, 'nothing may be opened once the capability gate has refused')
  assert.equal(refusals.length, 3)
  assert.equal(refusals.every((event) => event.refused === true), true)
})

test('symlinked workspace, tasks, and run directories remain indistinguishable 404s', async (t) => {
  const box = await fixture()
  t.after(box.cleanup)
  const linkedWorkspace = join(box.root, 'linked-workspace')
  await fsp.symlink(box.workspace, linkedWorkspace)
  const linkedTasksWorkspace = join(box.root, 'linked-tasks-workspace')
  await fsp.mkdir(linkedTasksWorkspace)
  await fsp.symlink(join(box.workspace, 'tasks'), join(linkedTasksWorkspace, 'tasks'))
  await fsp.symlink(box.runReal, join(box.workspace, 'tasks', 'r-linked'))
  await fsp.symlink(box.secretPath, join(box.runReal, 'outside-link'))
  await fsp.symlink(box.root, join(box.runReal, 'escape-dir'))

  let sshCalls = 0
  const handlers = createArtifactHandlers({
    hostsOf: () => [
      { name: 'workspace-link', kind: 'codex', workspace: linkedWorkspace },
      { name: 'tasks-link', kind: 'codex', workspace: linkedTasksWorkspace },
      { name: 'codex', kind: 'codex', workspace: box.workspace },
    ],
    wsOf: (host) => host.workspace,
    sshRead: async () => { sshCalls += 1; throw new Error('ssh forbidden') },
    spawnSsh: () => { sshCalls += 1; throw new Error('ssh forbidden') },
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
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }))
    })
    req.on('error', reject)
    req.end()
  })

  for (const [host, run] of [['workspace-link', RUN_ID], ['tasks-link', RUN_ID], ['codex', 'r-linked']]) {
    const response = await get(`/api/fleet/artifacts?host=${host}&run=${run}`)
    assert.equal(response.status, 404, `${host}/${run}`)
    assert.equal(JSON.parse(response.body).error, 'run not found')
  }
  // A symlinked leaf and a symlinked path segment stay 404, and neither appears
  // in the manifest.
  assert.equal((await get(fileUrl('outside-link'))).status, 404)
  assert.equal((await get(fileUrl('escape-dir/OUTSIDE-SECRET.txt'))).status, 404)
  const manifest = JSON.parse((await get(manifestUrl())).body)
  assert.deepEqual(manifest.files.map((file) => file.path).sort(), ['out.txt', 'sub/f.txt'])
  assert.equal(sshCalls, 0, 'a codex host must never reach ssh')
})
