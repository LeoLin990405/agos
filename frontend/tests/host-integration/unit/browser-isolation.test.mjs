/**
 * Defect 4 regression: the suite must not borrow the operator's live profile,
 * and the browser it drives must not be able to leave this run's origins.
 *
 * `PLAYWRIGHT_MODULE` used to default to
 * `~/.dsh/profiles/web/node_modules/playwright-core/index.js`. Since nobody
 * passes the override, that default WAS the behaviour: every run reached into
 * the operator's live profile, contradicting the harness's own "never reads
 * ~/.dsh" contract and making the suite exist only on machines laid out that
 * way. Resolution now has to come from an explicit parameter or from this
 * repository's own dependency trees, and must otherwise refuse to run.
 *
 * The origin fence is checked twice: as a predicate over real parsed URLs, and
 * — when a browser is actually available — by pointing a real Chrome at a real
 * page that really tries to fetch a real off-origin server, then asking that
 * server whether it was ever contacted. The second one is skipped with a stated
 * reason when the dependency tree is not installed yet; it is not silently
 * dropped.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { realpathSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import {
  createOriginFence, IntegrationBlocked, isAllowedRequest, isLiveProfilePath,
  resolveBrowserExecutable, resolvePlaywrightModule,
} from '../../../scripts/host-integration/browser-source.mjs';
import { claimPorts } from '../../../scripts/host-integration/host-env.mjs';

const LIVE_PROFILE_PLAYWRIGHT = path.join(homedir(), '.dsh/profiles/web/node_modules/playwright-core/index.js')

let sandbox

// realpath: macOS hands out /var/... but resolves module paths to /private/var/...
before(async () => { sandbox = realpathSync(await mkdtemp(path.join(tmpdir(), 'agos-browser-source-'))) })
after(async () => { if (sandbox !== undefined) await rm(sandbox, { recursive: true, force: true }) })

/** Build a package tree that a `createRequire` anchor can resolve through. */
async function fakeDependencyTree(name) {
  const root = path.join(sandbox, name)
  const pkg = path.join(root, 'node_modules', 'playwright-core')
  await mkdir(pkg, { recursive: true })
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name, version: '0.0.0' }))
  await writeFile(path.join(pkg, 'package.json'), JSON.stringify({ name: 'playwright-core', version: '0.0.0', main: 'index.js' }))
  await writeFile(path.join(pkg, 'index.js'), 'module.exports = { chromium: {} }\n')
  return { anchor: path.join(root, 'package.json'), entry: path.join(pkg, 'index.js') }
}

describe('playwright resolution never silently borrows the live profile', () => {
  it('refuses to run at all when nothing isolated is available', () => {
    assert.throws(
      () => resolvePlaywrightModule({ env: {}, roots: [] }),
      (error) => {
        assert.ok(error instanceof IntegrationBlocked)
        assert.equal(error.blocked, true)
        assert.equal(error.reason, 'playwright-unavailable')
        assert.match(error.message, /blocked/)
        assert.match(error.message, /~\/\.dsh/)
        return true
      },
    )
  })

  it('rejects the OLD default — a live-profile path — even when asked for explicitly', () => {
    assert.throws(
      () => resolvePlaywrightModule({ env: { AGOS_PLAYWRIGHT_MODULE: LIVE_PROFILE_PLAYWRIGHT } }),
      (error) => {
        assert.equal(error.reason, 'playwright-live-profile')
        assert.match(error.message, /live/)
        return true
      },
    )
    assert.equal(isLiveProfilePath(LIVE_PROFILE_PLAYWRIGHT), true)
  })

  it('allows the live profile only when the operator opts in by name', async () => {
    // A stand-in live profile inside the sandbox. The real ~/.dsh is never
    // read — not even stat'd — by this suite.
    const standInProfile = path.join(sandbox, 'stand-in-dsh')
    const tree = await fakeDependencyTree(path.join('stand-in-dsh', 'profiles', 'web'))

    assert.throws(
      () => resolvePlaywrightModule({
        env: { AGOS_PLAYWRIGHT_MODULE: tree.entry },
        liveProfileRoot: standInProfile,
      }),
      (error) => {
        assert.equal(error.reason, 'playwright-live-profile')
        return true
      },
    )

    const opted = resolvePlaywrightModule({
      env: { AGOS_PLAYWRIGHT_MODULE: tree.entry, AGOS_ALLOW_LIVE_PROFILE: '1' },
      liveProfileRoot: standInProfile,
    })
    assert.equal(opted.modulePath, tree.entry)
    assert.deepEqual(opted.warnings, [`using the live profile by explicit opt-in: ${tree.entry}`])
  })

  it('never resolves THROUGH a repo anchor that lands in the live profile', async () => {
    const standInProfile = path.join(sandbox, 'anchored-dsh')
    const tree = await fakeDependencyTree(path.join('anchored-dsh', 'profiles', 'web'))
    assert.throws(
      () => resolvePlaywrightModule({ env: {}, roots: [tree.anchor], liveProfileRoot: standInProfile }),
      (error) => {
        assert.equal(error.reason, 'playwright-unavailable')
        assert.match(error.message, /live profile, refused/)
        return true
      },
    )
  })

  it('accepts an explicit isolated path', async () => {
    const tree = await fakeDependencyTree('explicit-tree')
    const resolved = resolvePlaywrightModule({ env: { AGOS_PLAYWRIGHT_MODULE: tree.entry } })
    assert.equal(resolved.modulePath, tree.entry)
    assert.equal(resolved.source, 'explicit')
  })

  it('resolves out of the repository\'s own dependency tree when one exists', async () => {
    const tree = await fakeDependencyTree('repo-tree')
    const resolved = resolvePlaywrightModule({ env: {}, roots: [tree.anchor] })
    assert.equal(resolved.modulePath, tree.entry)
    assert.match(resolved.source, /^repo:/)
  })

  it('with the real repository roots, never returns a live-profile path', () => {
    // Either it resolves inside the repo, or it refuses. What it must never do
    // is quietly hand back something inside ~/.dsh, which is what the previous
    // default did on every run.
    let resolved
    try {
      resolved = resolvePlaywrightModule({ env: {} })
    } catch (error) {
      assert.equal(error.blocked, true)
      assert.equal(error.reason, 'playwright-unavailable')
      return
    }
    assert.equal(isLiveProfilePath(resolved.modulePath), false, `resolved into the live profile: ${resolved.modulePath}`)
  })

  it('reports a missing browser as blocked rather than failing cryptically later', () => {
    assert.throws(
      () => resolveBrowserExecutable({ env: { AGOS_BROWSER_EXECUTABLE: '/nope/does/not/exist' } }),
      (error) => {
        assert.equal(error.blocked, true)
        assert.equal(error.reason, 'browser-missing')
        return true
      },
    )
  })
})

describe('the origin fence', () => {
  const allowed = ['http://127.0.0.1:39411', 'http://127.0.0.1:39412']

  it('permits this run\'s own origins, over http and over ws', () => {
    assert.equal(isAllowedRequest('http://127.0.0.1:39411/src/main.tsx', allowed), true)
    assert.equal(isAllowedRequest('http://127.0.0.1:39412/api/session/list', allowed), true)
    assert.equal(isAllowedRequest('ws://127.0.0.1:39412/api/remote.mux', allowed), true)
  })

  it('refuses everything else, including the same host on another port', () => {
    for (const url of [
      'https://fonts.googleapis.com/css2?family=Inter',
      'https://example.com/beacon',
      'http://127.0.0.1:39999/other-run',
      'http://localhost:39411/looks-close-but-is-a-different-authority',
      'chrome-extension://abcdef/background.js',
    ]) {
      assert.equal(isAllowedRequest(url, allowed), false, `${url} should be blocked`)
    }
  })

  it('lets through schemes that cannot leave the machine', () => {
    assert.equal(isAllowedRequest('data:text/css,body{}', allowed), true)
    assert.equal(isAllowedRequest('about:blank', allowed), true)
  })

  it('aborts a blocked request and records it', async () => {
    const blocked = []
    const fence = createOriginFence({ allowedOrigins: allowed, onBlock: (entry) => blocked.push(entry) })
    const calls = []
    const route = {
      continue: async () => { calls.push('continue') },
      abort: async (reason) => { calls.push(`abort:${reason}`) },
      request: () => ({ url: () => 'https://fonts.googleapis.com/css2', method: () => 'GET' }),
    }
    await fence(route)
    assert.deepEqual(calls, ['abort:blockedbyclient'])
    assert.equal(blocked.length, 1)
    assert.equal(blocked[0].url, 'https://fonts.googleapis.com/css2')

    calls.length = 0
    const ownRoute = {
      continue: async () => { calls.push('continue') },
      abort: async () => { calls.push('abort') },
      request: () => ({ url: () => 'http://127.0.0.1:39411/index.html', method: () => 'GET' }),
    }
    await fence(ownRoute)
    assert.deepEqual(calls, ['continue'])
    assert.equal(blocked.length, 1, 'an allowed request must not be recorded as blocked')
  })
})

/** Is a real browser available in this checkout? */
function browserAvailability() {
  try {
    const playwright = resolvePlaywrightModule({ env: process.env })
    const browser = resolveBrowserExecutable({ env: process.env })
    return { ok: true, playwright, browser }
  } catch (error) {
    return { ok: false, reason: String(error.message).split('\n')[0] }
  }
}

const availability = browserAvailability()

describe('a real browser cannot reach an external origin', { skip: availability.ok ? false : `no isolated browser yet: ${availability.reason}` }, () => {
  it('aborts the off-origin fetch before it reaches the network', async () => {
    const [allowedPort, externalPort] = await claimPorts(2, 41311)
    let externalHits = 0

    const external = createServer((_request, response) => {
      externalHits += 1
      response.writeHead(200, { 'access-control-allow-origin': '*' })
      response.end('beacon')
    })
    const origin = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html' })
      response.end(`<!doctype html><html><body><script>
        window.__result = 'pending';
        fetch('http://127.0.0.1:${externalPort}/beacon')
          .then(() => { window.__result = 'reached' })
          .catch(() => { window.__result = 'blocked' });
      </script></body></html>`)
    })
    await new Promise((resolve) => external.listen(externalPort, '127.0.0.1', resolve))
    await new Promise((resolve) => origin.listen(allowedPort, '127.0.0.1', resolve))

    const playwright = await import(availability.playwright.modulePath)
    const chromium = playwright.chromium ?? playwright.default?.chromium
    const browser = await chromium.launch({ headless: true, executablePath: availability.browser.executablePath })
    const blocked = []
    try {
      const context = await browser.newContext()
      await context.route('**/*', createOriginFence({
        allowedOrigins: [`http://127.0.0.1:${allowedPort}`],
        onBlock: (entry) => blocked.push(entry),
      }))
      const page = await context.newPage()
      await page.goto(`http://127.0.0.1:${allowedPort}/`, { waitUntil: 'domcontentloaded' })
      await page.waitForFunction(() => window.__result !== 'pending', undefined, { timeout: 15_000 })
      assert.equal(await page.evaluate(() => window.__result), 'blocked')
    } finally {
      await browser.close()
      await new Promise((resolve) => origin.close(resolve))
      await new Promise((resolve) => external.close(resolve))
    }

    assert.equal(externalHits, 0, 'the external server must never have been contacted')
    assert.ok(blocked.some((entry) => entry.url.includes(`:${externalPort}/beacon`)), JSON.stringify(blocked))
  })
})
