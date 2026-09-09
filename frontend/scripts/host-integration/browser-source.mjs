/**
 * Where the browser automation comes from, and where the browser may go.
 *
 * Two separate isolation holes, both closed here.
 *
 * 1. The playwright module used to DEFAULT to
 *    `~/.dsh/profiles/web/node_modules/playwright-core/index.js` — inside the
 *    operator's live profile. The harness's own contract says it never reads
 *    `~/.dsh`, and a default that silently borrows a live profile breaks that
 *    contract on the path nobody passes an override on (which is every path).
 *    It also means the suite only exists on machines that happen to have that
 *    profile laid out that way. Resolution is now: explicit parameter, else the
 *    repository's OWN dependency trees, else a loud `blocked` — never the live
 *    profile unless an operator opts in by name.
 *
 * 2. A real Chrome pointed at a real page will fetch whatever the page asks
 *    for: fonts from Google, telemetry, an analytics beacon. A hermetic suite
 *    must not depend on (or touch) the network, so every request whose origin
 *    is not one of this run's two throwaway origins is aborted, and the
 *    abort is counted so a test can assert it happened.
 */
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { FRONTEND_ROOT } from './host-env.mjs';

/** Thrown when the suite cannot run because no browser automation is available. */
export class IntegrationBlocked extends Error {
  constructor(message, details = {}) {
    super(message)
    this.name = 'IntegrationBlocked'
    /** Machine-readable so a runner can report `blocked` rather than `fail`. */
    this.blocked = true
    Object.assign(this, details)
  }
}

/** The live profile tree the harness must not quietly reach into. */
const LIVE_PROFILE_ROOT = path.join(homedir(), '.dsh')

/**
 * Dependency trees that belong to THIS repository, in resolution order.
 * `plugins/` is the pinned, reproducible host tree (see plugins/package.json);
 * `frontend/` is the SPA tree. Both are the repo's own, neither is the
 * operator's profile.
 */
function repoResolutionRoots() {
  const repoRoot = path.resolve(FRONTEND_ROOT, '..')
  return [
    path.join(FRONTEND_ROOT, 'package.json'),
    path.join(repoRoot, 'plugins', 'package.json'),
    path.join(repoRoot, 'package.json'),
  ]
}

/**
 * True when a path lives inside the operator's live `~/.dsh` tree.
 * @param candidate - the path to judge.
 * @param root - the live-profile root; injectable so the regressions can build
 *   a stand-in profile in a sandbox instead of reading the real one.
 */
export function isLiveProfilePath(candidate, root = LIVE_PROFILE_ROOT) {
  const resolved = path.resolve(candidate)
  const liveRoot = path.resolve(root)
  return resolved === liveRoot || resolved.startsWith(liveRoot + path.sep)
}

/**
 * Decide which playwright build the suite will drive, or refuse to run.
 *
 * @param options.explicit - an explicit module path (beats everything).
 * @param options.env - environment to read `AGOS_PLAYWRIGHT_MODULE` and the
 *   `AGOS_ALLOW_LIVE_PROFILE` opt-in from.
 * @param options.roots - override the repo trees searched (tests).
 * @param options.liveProfileRoot - override the live-profile root (tests build a
 *   stand-in profile rather than reading the operator's real one).
 * @returns `{ modulePath, source, warnings }`.
 * @throws {IntegrationBlocked} when nothing isolated is available.
 */
export function resolvePlaywrightModule({ explicit, env = process.env, roots, liveProfileRoot = LIVE_PROFILE_ROOT } = {}) {
  const warnings = []
  const requested = explicit ?? env.AGOS_PLAYWRIGHT_MODULE
  const allowLiveProfile = env.AGOS_ALLOW_LIVE_PROFILE === '1'
  const isLive = (candidate) => isLiveProfilePath(candidate, liveProfileRoot)

  if (typeof requested === 'string' && requested !== '') {
    if (isLive(requested) && !allowLiveProfile) {
      throw new IntegrationBlocked(
        'host-integration blocked: the requested Playwright module lives inside the operator\'s live '
        + `~/.dsh profile (${requested}). The harness does not read the live profile. Point `
        + 'AGOS_PLAYWRIGHT_MODULE at an isolated install, or set AGOS_ALLOW_LIVE_PROFILE=1 to state '
        + 'explicitly that borrowing the live profile is intended.',
        { reason: 'playwright-live-profile', requested },
      )
    }
    if (!existsSync(requested)) {
      throw new IntegrationBlocked(
        `host-integration blocked: AGOS_PLAYWRIGHT_MODULE points at ${requested}, which does not exist.`,
        { reason: 'playwright-missing', requested },
      )
    }
    if (isLive(requested)) warnings.push(`using the live profile by explicit opt-in: ${requested}`)
    return { modulePath: requested, source: 'explicit', warnings }
  }

  const attempts = []
  for (const anchor of roots ?? repoResolutionRoots()) {
    try {
      const modulePath = createRequire(anchor).resolve('playwright-core')
      if (isLive(modulePath)) { attempts.push(`${anchor} → live profile, refused`); continue }
      return { modulePath, source: `repo:${path.relative(path.resolve(FRONTEND_ROOT, '..'), anchor) || anchor}`, warnings }
    } catch (error) {
      attempts.push(`${anchor} → ${String(error?.code ?? error?.message ?? error)}`)
    }
  }

  throw new IntegrationBlocked(
    'host-integration blocked: no Playwright available. The harness will not borrow the operator\'s '
    + '~/.dsh profile. Install playwright-core into this repository\'s own dependency tree, or set '
    + 'AGOS_PLAYWRIGHT_MODULE to an isolated build.\n  tried:\n    ' + attempts.join('\n    '),
    { reason: 'playwright-unavailable', attempts },
  )
}

/**
 * Decide which browser binary to drive. Nothing is ever downloaded.
 * @param options.env - environment to read `AGOS_BROWSER_EXECUTABLE` from.
 * @returns `{ executablePath, source }`.
 * @throws {IntegrationBlocked} when no usable browser exists on the machine.
 */
export function resolveBrowserExecutable({ env = process.env } = {}) {
  const explicit = env.AGOS_BROWSER_EXECUTABLE
  if (typeof explicit === 'string' && explicit !== '') {
    if (!existsSync(explicit)) {
      throw new IntegrationBlocked(
        `host-integration blocked: AGOS_BROWSER_EXECUTABLE points at ${explicit}, which does not exist.`,
        { reason: 'browser-missing', requested: explicit },
      )
    }
    return { executablePath: explicit, source: 'explicit' }
  }
  const installed = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ]
  const found = installed.find((candidate) => existsSync(candidate))
  if (found === undefined) {
    throw new IntegrationBlocked(
      'host-integration blocked: no installed Chrome/Chromium found and the harness never downloads one. '
      + 'Set AGOS_BROWSER_EXECUTABLE.',
      { reason: 'browser-unavailable', tried: installed },
    )
  }
  return { executablePath: found, source: 'installed' }
}

/** Inline/document schemes that cannot perform a network fetch. */
const LOCAL_SCHEMES = new Set(['data:', 'blob:', 'about:'])

/**
 * Is this URL one the hermetic run is allowed to fetch?
 * @param url - the request URL as a string.
 * @param allowedOrigins - the run's own origins (SPA + host).
 * @returns true when the request may proceed.
 */
export function isAllowedRequest(url, allowedOrigins) {
  let parsed
  try { parsed = new URL(url) } catch { return false }
  if (LOCAL_SCHEMES.has(parsed.protocol)) return true
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:' && parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') {
    return false
  }
  // ws:// and http:// on the same authority are the same origin for this
  // purpose: the mux socket and the REST calls both speak to our own host.
  const authority = parsed.host
  return allowedOrigins.some((origin) => {
    try {
      const allowed = new URL(origin)
      if (allowed.host !== authority) return false
      // The mux deliberately upgrades http↔ws (and https↔wss) as the same
      // local authority. Do not let an HTTPS or WSS request bypass an HTTP
      // origin declaration: it is a different endpoint and can be external
      // even when the hostname happens to be loopback.
      const sameSchemeFamily = (allowed.protocol === 'http:' && parsed.protocol === 'ws:')
        || (allowed.protocol === 'ws:' && parsed.protocol === 'http:')
        || (allowed.protocol === 'https:' && parsed.protocol === 'wss:')
        || (allowed.protocol === 'wss:' && parsed.protocol === 'https:')
        || allowed.protocol === parsed.protocol
      return sameSchemeFamily
    } catch { return false }
  })
}

/**
 * Build the route handler that keeps a real browser inside this run.
 *
 * Every request the page makes is checked against the run's own origins;
 * anything else is aborted before it reaches the network and recorded, so a
 * test can prove the block happened rather than assume it.
 * @param options.allowedOrigins - the SPA origin and the host origin.
 * @param options.onBlock - called with `{ url, method }` for each abort.
 * @returns a playwright route handler.
 */
export function createOriginFence({ allowedOrigins, onBlock }) {
  return async (route, request) => {
    const target = (request ?? route.request()).url()
    if (isAllowedRequest(target, allowedOrigins)) {
      await route.continue()
      return
    }
    onBlock?.({ url: target, method: (request ?? route.request()).method?.() })
    // `blockedbyclient` is what a content blocker reports, so the page sees a
    // realistic failure rather than a hang.
    await route.abort('blockedbyclient')
  }
}
