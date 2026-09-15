/**
 * Portability of the harness's THREE external dependencies: the dsh CLI, the
 * browser binary, and the OS process table.
 *
 * Why this file exists. The suite's isolation rules were written and verified
 * on one macOS machine, and three of them had encoded that machine's layout as
 * if it were a fact about every machine:
 *
 * 1. the browser was looked for at four absolute paths, and an explicit
 *    override was only ever passed to `existsSync` — so a command NAME was
 *    rejected as a missing file, and PATH was never consulted;
 * 2. the dsh CLI was `$HOME/.npm-global/bin/dsh`, an npm prefix that is not
 *    npm's default and not what Homebrew, nvm or a distro package produces.
 *    Nothing checked it existed: the path was handed to `spawn`, so the
 *    symptom on any other machine was an ENOENT thrown from inside bring-up
 *    rather than a `blocked` verdict naming the missing binary;
 * 3. process identity came only from `ps -o pid=,pgid=,lstart=,command=`. That
 *    field set is fine on macOS AND on procps-ng, but where `ps` cannot answer
 *    at all (BusyBox, i.e. a stock Alpine image) identity returned undefined
 *    and the harness went on to record NOTHING — so `reapRun` would delete a
 *    run tree while its host was still running, and no message said so.
 *
 * Every case below runs on the machine at hand: the Linux-only triggers are
 * driven by injecting the platform and a stand-in PATH, never by pretending a
 * Linux box was available.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  IntegrationBlocked, isExecutableFile, locateExecutable, resolveDshBin,
} from '../../../scripts/host-integration/host-env.mjs';
import {
  browserCandidateNames, browserCandidatePaths, resolveBrowserExecutable,
} from '../../../scripts/host-integration/browser-source.mjs';
import {
  classifyRun, createRunRoot, identityBackend, procChildPids, procIdentity, processIdentity,
  processMatches, psIdentity, readManifest, recordProcess,
} from '../../../scripts/host-integration/run-registry.mjs';

let sandbox

before(async () => { sandbox = await mkdtemp(path.join(tmpdir(), 'agos-portability-')) })
after(async () => { if (sandbox !== undefined) await rm(sandbox, { recursive: true, force: true }) })

/** A directory holding one executable stub, for PATH resolution tests. */
async function binDir(name, contents = '#!/bin/sh\nexit 0\n') {
  const dir = await mkdtemp(path.join(sandbox, 'bin-'))
  const file = path.join(dir, name)
  await writeFile(file, contents)
  await chmod(file, 0o755)
  return { dir, file }
}

describe('locating an executable works the way a shell does', () => {
  it('finds a bare command name along PATH', async () => {
    const { dir, file } = await binDir('some-tool')
    assert.equal(locateExecutable('some-tool', { PATH: dir }), file)
  })

  it('does not treat a non-executable file as a command', async () => {
    const dir = await mkdtemp(path.join(sandbox, 'noexec-'))
    await writeFile(path.join(dir, 'not-runnable'), 'data')
    await chmod(path.join(dir, 'not-runnable'), 0o644)
    assert.equal(locateExecutable('not-runnable', { PATH: dir }), undefined)
    assert.equal(isExecutableFile(path.join(dir, 'not-runnable')), false)
  })

  it('does not treat a directory as a command', async () => {
    const dir = await mkdtemp(path.join(sandbox, 'dir-as-cmd-'))
    await mkdir(path.join(dir, 'subdir'))
    assert.equal(locateExecutable('subdir', { PATH: dir }), undefined)
  })

  it('takes anything carrying a separator as a path, not a PATH search', async () => {
    const { dir, file } = await binDir('by-path')
    // A name that exists on PATH but is spelled as a path must not resolve
    // through PATH — that would let `./x` mean `$PATH/x`.
    assert.equal(locateExecutable(file, { PATH: dir }), file)
    assert.equal(locateExecutable(path.join('nope', 'by-path'), { PATH: dir }), undefined)
  })

  it('rejects an explicit directory and a non-executable file before spawn', async () => {
    const dir = await mkdtemp(path.join(sandbox, 'explicit-dir-'))
    const file = path.join(sandbox, 'explicit-noexec')
    await writeFile(file, 'not executable')
    await chmod(file, 0o644)
    assert.equal(locateExecutable(dir, { PATH: '' }), undefined)
    assert.equal(locateExecutable(file, { PATH: '' }), undefined)
    assert.throws(() => resolveDshBin({ env: { AGOS_DSH_BIN: dir } }), (error) => {
      assert.equal(error.reason, 'dsh-missing')
      return true
    })
  })

  it('survives an unset or empty PATH', () => {
    assert.equal(locateExecutable('anything', {}), undefined)
    assert.equal(locateExecutable('anything', { PATH: '' }), undefined)
  })
})

describe('the browser is found on platforms other than the one this was written on', () => {
  it('REPRO: an override spelled as a command name used to be rejected outright', async () => {
    // Trigger: any environment that names the browser the way a package
    // manager or CI image does — `AGOS_BROWSER_EXECUTABLE=google-chrome` —
    // instead of by absolute path. The old code called `existsSync` on that
    // value, which is false for every bare name, and reported `blocked`.
    const { dir, file } = await binDir('google-chrome')
    const resolved = resolveBrowserExecutable({ env: { AGOS_BROWSER_EXECUTABLE: 'google-chrome', PATH: dir } })
    assert.equal(resolved.executablePath, file)
    assert.equal(resolved.source, 'explicit')
  })

  it('REPRO: a Linux box whose only browser is Google\'s own .deb layout', async () => {
    // Trigger: `google-chrome-stable` installed from Google's repository puts
    // the binary at /opt/google/chrome/chrome and exposes it as
    // /usr/bin/google-chrome-stable. The old four-entry list had neither, so a
    // machine with a perfectly good Chrome reported `browser-unavailable`.
    const { dir, file } = await binDir('google-chrome-stable')
    const resolved = resolveBrowserExecutable({
      platform: 'linux',
      // None of the well-known absolute paths exist on THIS machine, which is
      // the point: resolution has to reach the PATH step.
      env: { PATH: dir },
    })
    assert.equal(resolved.executablePath, file)
    assert.equal(resolved.source, 'path')
  })

  it('names the install paths a real Linux machine actually uses', () => {
    const linux = browserCandidatePaths('linux')
    for (const expected of [
      '/usr/bin/google-chrome',          // distro / alternatives symlink
      '/usr/bin/google-chrome-stable',   // Google's .deb
      '/opt/google/chrome/chrome',       // the binary that symlink points at
      '/usr/bin/chromium',               // Debian
      '/usr/bin/chromium-browser',       // Ubuntu / older distros
      '/snap/bin/chromium',              // snap
    ]) {
      assert.ok(linux.includes(expected), `linux candidates are missing ${expected}`)
    }
    assert.ok(browserCandidateNames('linux').includes('chromium-browser'))
  })

  it('keeps this machine resolving exactly as it did before', () => {
    // The macOS list is unchanged, in the same order, so the run that is
    // actually executed for evidence has not been re-pointed by this work.
    assert.deepEqual(browserCandidatePaths('darwin'), [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    ])
  })

  it('still refuses, loudly, when the machine really has no browser', async () => {
    const empty = await mkdtemp(path.join(sandbox, 'empty-path-'))
    assert.throws(
      () => resolveBrowserExecutable({ platform: 'linux', candidates: [], env: { PATH: empty } }),
      (error) => {
        assert.ok(error instanceof IntegrationBlocked)
        assert.equal(error.blocked, true)
        assert.equal(error.reason, 'browser-unavailable')
        // The report has to say what was tried, including the PATH step.
        assert.ok(error.tried.some((entry) => entry.startsWith('PATH: ')), JSON.stringify(error.tried))
        assert.match(error.message, /never downloads one/)
        return true
      },
    )
  })

  it('still refuses an override that names nothing at all', () => {
    assert.throws(
      () => resolveBrowserExecutable({ env: { AGOS_BROWSER_EXECUTABLE: '/nope/does/not/exist' } }),
      (error) => {
        assert.equal(error.blocked, true)
        assert.equal(error.reason, 'browser-missing')
        return true
      },
    )
  })

  it('rejects an explicit browser directory and non-executable file', async () => {
    const dir = await mkdtemp(path.join(sandbox, 'browser-dir-'))
    const file = path.join(sandbox, 'browser-noexec')
    await writeFile(file, 'not executable')
    await chmod(file, 0o644)
    for (const candidate of [dir, file]) {
      assert.throws(
        () => resolveBrowserExecutable({ env: { AGOS_BROWSER_EXECUTABLE: candidate } }),
        (error) => { assert.equal(error.reason, 'browser-missing'); return true },
      )
    }
  })

  it('accepts an explicit executable file', async () => {
    const { file } = await binDir('explicit-browser')
    const resolved = resolveBrowserExecutable({ env: { AGOS_BROWSER_EXECUTABLE: file } })
    assert.equal(resolved.executablePath, file)
    assert.equal(resolved.source, 'explicit')
  })
})

describe('the dsh CLI is found without assuming one npm prefix', () => {
  it('REPRO: an override that does not exist is now blocked, not an ENOENT later', () => {
    // Trigger: the old `DSH_BIN` was a plain string. Nothing verified it, so
    // the first sign of trouble was `spawn` failing after the profile overlay,
    // the log stream and the port claim had all been created.
    assert.throws(
      () => resolveDshBin({ env: { AGOS_DSH_BIN: '/nope/not/a/dsh' } }),
      (error) => {
        assert.ok(error instanceof IntegrationBlocked)
        assert.equal(error.reason, 'dsh-missing')
        return true
      },
    )
  })

  it('REPRO: a machine whose npm prefix is anywhere else resolves via PATH', async () => {
    // Trigger: npm's own default prefix is /usr/local, Homebrew uses
    // /opt/homebrew, nvm uses the node version's directory, and
    // `npm config set prefix` moves it anywhere. On all of those,
    // $HOME/.npm-global/bin/dsh does not exist.
    const { dir, file } = await binDir('dsh')
    const resolved = resolveDshBin({ env: { PATH: dir }, candidates: ['/nope/npm-global/bin/dsh'] })
    assert.equal(resolved.path, file)
    assert.equal(resolved.source, 'path')
  })

  it('accepts an override spelled as a command name', async () => {
    const { dir, file } = await binDir('dsh-pinned')
    const resolved = resolveDshBin({ env: { AGOS_DSH_BIN: 'dsh-pinned', PATH: dir } })
    assert.equal(resolved.path, file)
    assert.equal(resolved.source, 'explicit')
  })

  it('prefers the well-known install over whatever is on PATH', async () => {
    const wellKnown = await binDir('dsh')
    const onPath = await binDir('dsh')
    const resolved = resolveDshBin({ env: { PATH: onPath.dir }, candidates: [wellKnown.file] })
    assert.equal(resolved.path, wellKnown.file, 'the pinned install must win over PATH order')
    assert.equal(resolved.source, 'installed')
  })

  it('refuses with a recovery instruction when there is no dsh anywhere', async () => {
    const empty = await mkdtemp(path.join(sandbox, 'no-dsh-'))
    assert.throws(
      () => resolveDshBin({ env: { PATH: empty }, candidates: ['/nope/npm-global/bin/dsh'] }),
      (error) => {
        assert.equal(error.blocked, true)
        assert.equal(error.reason, 'dsh-unavailable')
        assert.match(error.message, /AGOS_DSH_BIN/)
        assert.match(error.message, /never installs one/)
        return true
      },
    )
  })

  it('resolves on THIS machine, so the evidence run is unaffected', () => {
    // Not a portability claim — a guard that the change above did not move the
    // binary the real run boots.
    const resolved = resolveDshBin({ env: {} })
    assert.ok(['installed', 'path'].includes(resolved.source), resolved.source)
    assert.ok(isExecutableFile(resolved.path), `${resolved.path} is not executable`)
  })
})

/**
 * One `/proc/<pid>/stat` line in the real kernel format.
 *
 * `comm` is deliberately the nastiest legal shape — spaces AND parentheses —
 * because that is what defeats a naive split, and a browser helper really is
 * named things like `Web Content`.
 */
function procStat({ pid, comm = 'node', ppid, pgrp, starttime }) {
  const after = [
    'S', ppid, pgrp, ppid, '0', '-1', '4194304', '12345', '0', '0', '0',
    '100', '20', '0', '0', '20', '0', '11', '0', starttime,
    '123456789', '5678', '18446744073709551615', '0', '0',
  ]
  return `${pid} (${comm}) ${after.join(' ')}\n`
}

/** Build a stand-in process table on disk. */
async function fakeProc(entries) {
  const root = await mkdtemp(path.join(sandbox, 'proc-'))
  for (const entry of entries) {
    const dir = path.join(root, String(entry.pid))
    await mkdir(dir, { recursive: true })
    await writeFile(path.join(dir, 'stat'), procStat(entry))
    await writeFile(path.join(dir, 'cmdline'), `${(entry.argv ?? ['node']).join('\0')}\0`)
  }
  // Real /proc also carries non-numeric entries; the scan must ignore them.
  await mkdir(path.join(root, 'self'), { recursive: true })
  await writeFile(path.join(root, 'sys'), 'not a pid dir')
  return root
}

describe('process identity has a backend for machines with no usable ps', () => {
  it('reads pgid, kernel start time and argv out of the process table', async () => {
    const procRoot = await fakeProc([
      { pid: 4242, comm: 'Web Content (tab)', ppid: 4000, pgrp: 4242, starttime: '987654', argv: ['/usr/bin/dsh', '--patch', '/tmp/run-abc/overlay.json'] },
    ])
    const identity = await procIdentity(4242, { procRoot })
    assert.deepEqual(identity, {
      pid: 4242,
      pgid: 4242,
      // Prefixed so it can never compare equal to a `ps` lstart string.
      startedAt: 'proc:987654',
      // NUL-separated argv rendered the way `ps` renders it, so the runId
      // substring rule reads identically whichever backend answered.
      command: '/usr/bin/dsh --patch /tmp/run-abc/overlay.json',
      backend: 'proc',
    })
    assert.ok(identity.command.includes('run-abc'), 'the runId check must still work on this backend')
  })

  it('returns undefined rather than a half-parsed identity', async () => {
    const procRoot = await fakeProc([{ pid: 7, ppid: 1, pgrp: 7, starttime: '11' }])
    assert.equal(await procIdentity(999_999, { procRoot }), undefined, 'absent pid')
    await writeFile(path.join(procRoot, '7', 'stat'), 'this is not a stat line\n')
    assert.equal(await procIdentity(7, { procRoot }), undefined, 'unparsable stat')
  })

  it('finds direct children by ppid, ignoring the non-numeric entries', async () => {
    const procRoot = await fakeProc([
      { pid: 100, ppid: 1, pgrp: 100, starttime: '1' },
      { pid: 101, ppid: 100, pgrp: 100, starttime: '2' },
      { pid: 102, ppid: 100, pgrp: 102, starttime: '3' },
      { pid: 103, ppid: 999, pgrp: 103, starttime: '4' },
    ])
    assert.deepEqual(await procChildPids(100, { procRoot }), [101, 102])
    assert.deepEqual(await procChildPids(555, { procRoot }), [])
  })

  it('reports which backend answered on this machine', async () => {
    const backend = await identityBackend()
    assert.equal(backend.ok, true)
    // macOS and procps both answer here; `none` is the dangerous state.
    assert.equal(backend.backend, 'ps')
  })

  it('a backend that changed under us fails CLOSED, with an accurate reason', async () => {
    // The two clocks are not comparable, so a recorded `/proc` identity must
    // never be judged against a live `ps` identity. Refusing is the safe
    // direction; the reason must not claim "pid reused", which is a different
    // and much more alarming fact.
    const live = await psIdentity(process.pid)
    assert.equal(live.backend, 'ps')
    const verdict = await processMatches({ ...live, backend: 'proc', startedAt: 'proc:12345' })
    assert.equal(verdict.ok, false)
    assert.match(verdict.reason, /identity backend changed/)
    assert.match(verdict.reason, /recorded via proc, now ps/)
  })
})

describe('REPRO: when no backend can answer, the failure is not silent', () => {
  // Trigger: a machine whose `ps` does not implement `-o lstart=` (BusyBox,
  // i.e. a stock Alpine image) and has no `/proc` the parser can read. Driven
  // here by putting a stub `ps`/`pgrep` first on PATH, which is how the child
  // process resolves them.
  let realPath
  before(async () => { realPath = process.env.PATH })
  after(() => { process.env.PATH = realPath })

  it('identity comes back undefined and the backend says so', async () => {
    const stub = await mkdtemp(path.join(sandbox, 'busybox-'))
    for (const name of ['ps', 'pgrep']) {
      const file = path.join(stub, name)
      await writeFile(file, '#!/bin/sh\necho "ps: unrecognized option: o" >&2\nexit 1\n')
      await chmod(file, 0o755)
    }
    process.env.PATH = stub
    try {
      // No /proc on this platform either, so BOTH backends are unavailable —
      // exactly the Alpine case.
      assert.equal(await psIdentity(process.pid), undefined)
      assert.equal(await processIdentity(process.pid), undefined)
      const backend = await identityBackend()
      assert.equal(backend.ok, false)
      assert.equal(backend.backend, 'none')
    } finally {
      process.env.PATH = realPath
    }
  })

  it('the run tree is still PRESERVED, not judged an orphan', async () => {
    // The dangerous direction. With no identity, the owner is written as
    // `unknown`, and an owner that cannot be identified must keep its run
    // directory: reaping it would be the cross-run deletion this registry
    // exists to prevent. Checked here because losing this on a new platform
    // would be silent as well.
    const stub = await mkdtemp(path.join(sandbox, 'busybox3-'))
    for (const name of ['ps', 'pgrep']) {
      const file = path.join(stub, name)
      await writeFile(file, '#!/bin/sh\nexit 1\n')
      await chmod(file, 0o755)
    }
    const root = await mkdtemp(path.join(sandbox, 'runs-'))
    process.env.PATH = stub
    try {
      const run = await createRunRoot({ root })
      assert.equal(run.manifest.owner.startedAt, 'unknown')

      // The mechanism behind the silent degradation: a process cannot be
      // recorded, so the manifest never names it and no cleanup can ever stop
      // it. `startHost` now writes a WARNING to the host log on this path.
      const recorded = await recordProcess(run.runDir, {
        pid: process.pid, role: 'host', ownerToken: run.ownerToken,
      })
      assert.equal(recorded, undefined, 'identity unavailable ⇒ nothing recorded')
      assert.deepEqual((await readManifest(run.runDir)).processes, [])

      const verdict = await classifyRun(run.runDir, { runId: 'someone-else', ownerToken: 'x' })
      assert.equal(verdict.state, 'active')
      assert.match(verdict.reason, /owner identity unavailable/)
    } finally {
      process.env.PATH = realPath
    }
  })

  it('and the /proc fallback rescues it when a process table IS readable', async () => {
    const stub = await mkdtemp(path.join(sandbox, 'busybox2-'))
    const file = path.join(stub, 'ps')
    await writeFile(file, '#!/bin/sh\nexit 1\n')
    await chmod(file, 0o755)
    const procRoot = await fakeProc([
      { pid: 31337, ppid: 1, pgrp: 31337, starttime: '424242', argv: ['dsh', '--patch', '/x/run-zzz/o.json'] },
    ])
    process.env.PATH = stub
    try {
      const identity = await processIdentity(31337, { procRoot })
      assert.equal(identity.backend, 'proc')
      assert.equal(identity.startedAt, 'proc:424242')
      assert.equal(identity.pgid, 31337)
    } finally {
      process.env.PATH = realPath
    }
  })
})
