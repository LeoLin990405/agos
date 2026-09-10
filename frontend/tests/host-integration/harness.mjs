/**
 * Harness for the AgOS real-host browser integration suite (package B).
 *
 * Brings up, for one run:
 * - a REAL pinned dsh host (0.1.2-rc.1) on a throwaway DSH_HOME and a free
 *   high port, with a fake model provider and fake tool and no credentials;
 * - the REAL AgOS SPA served by Vite, with `/api` relayed to that host so the
 *   production `createAgosClient({})` same-origin path is what runs;
 * - a REAL Chrome (already installed) driven by an already-installed
 *   playwright-core. Nothing is downloaded or installed.
 *
 * The only browser-side instrumentation is an init script that records page
 * errors and keeps references to the WebSocket instances the app itself
 * creates, so a test can drop a live socket. It does not replace, proxy, or
 * synthesize any frame: every socket is a real socket to the real host.
 *
 * ⚠️ Bring-up is a RESOURCE STACK, not a sequence. Every stage registers its
 * disposer the moment its resource exists, and a failure (or a cancellation)
 * at any stage unwinds the earlier stages in reverse right there, before the
 * error is rethrown. The previous version disposed through the context object
 * it returned, which meant that a host that started and a browser that then
 * failed to launch left the host, its temp tree and its ports behind — the
 * caller had nothing to call dispose on. See `scripts/host-integration/
 * resource-stack.mjs`.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  ARTIFACT_DIR, claimPorts, redact, waitFor,
} from '../../scripts/host-integration/host-env.mjs';
import {
  createOriginFence, resolveBrowserExecutable, resolvePlaywrightModule,
} from '../../scripts/host-integration/browser-source.mjs';
import { bringUpSignal, createResourceStack } from '../../scripts/host-integration/resource-stack.mjs';
import { childPids, createRunRoot, disposeRunRoot, identityBackend, killRecorded, processIdentity, recordProcess } from '../../scripts/host-integration/run-registry.mjs';
import { startHost } from '../../scripts/host-integration/start-host.mjs';

/**
 * Start the SPA origin.
 *
 * Imported lazily on purpose: `ui-server.mjs` pulls in Vite, so a static import
 * would make this module unloadable — and every regression in it unrunnable —
 * on a checkout whose `frontend/node_modules` is not installed yet. Deferring
 * it turns "Vite is missing" into a failure of the stage that needs Vite,
 * where the unwinder can reclaim the host that is already running.
 */
async function defaultStartUiServer(args) {
  const { startUiServer } = await import('../../scripts/host-integration/ui-server.mjs')
  return startUiServer(args)
}

/**
 * Records page errors and exposes the app's own live sockets to the test.
 * Injected before any app code runs.
 */
const INIT_SCRIPT = `(() => {
  const harness = { errors: [], sockets: [] };
  window.__agosHarness = harness;
  const Native = window.WebSocket;
  function Tracked(...args) {
    const socket = new Native(...args);
    harness.sockets.push(socket);
    return socket;
  }
  Tracked.prototype = Native.prototype;
  for (const key of ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED']) Tracked[key] = Native[key];
  window.WebSocket = Tracked;
  harness.openSocketCount = () => harness.sockets.filter((s) => s.readyState === Native.OPEN).length;
  // Only the app's own transport sockets may be dropped. The Vite dev-server
  // client also holds a socket, and closing THAT makes Vite reload the page —
  // which looks like a reconnect but is really a fresh document, so it would
  // fake a passing reconnect test.
  harness.dropOpenSockets = (pattern) => {
    const match = pattern ?? '/api/remote.mux';
    let dropped = 0;
    for (const socket of harness.sockets) {
      if (!String(socket.url).includes(match)) continue;
      if (socket.readyState === Native.OPEN || socket.readyState === Native.CONNECTING) {
        try { socket.close(4001, 'harness-forced-drop'); dropped += 1 } catch { /* already gone */ }
      }
    }
    return dropped;
  };
  harness.socketUrls = () => harness.sockets.map((s) => ({ url: String(s.url), readyState: s.readyState }));
  window.addEventListener('error', (event) => harness.errors.push(String(event.message)));
  window.addEventListener('unhandledrejection', (event) => harness.errors.push('unhandledrejection: ' + String(event.reason)));
})()`

/**
 * Load the playwright build this run will drive.
 *
 * Never the operator's `~/.dsh` profile: `resolvePlaywrightModule` searches the
 * repository's own dependency trees and refuses live-profile paths unless the
 * operator opts in by name. When nothing isolated exists it throws
 * `IntegrationBlocked`, which a runner should report as `blocked` rather than
 * as a product failure.
 * @returns the chromium namespace plus where it came from.
 */
async function defaultLoadPlaywright() {
  const { modulePath, source, warnings } = resolvePlaywrightModule()
  // playwright-core ships CJS: the named export exists on some builds, the
  // default namespace on others. Reuse whichever this install provides.
  const playwright = await import(modulePath)
  const chromium = playwright.chromium ?? playwright.default?.chromium
  if (chromium === undefined) throw new Error(`host-integration: no chromium export in ${modulePath}`)
  return { chromium, modulePath, source, warnings }
}

/**
 * Launch the already-installed browser. Nothing is downloaded.
 * @param options.chromium - the chromium namespace from the loaded module.
 * @returns the launched browser.
 */
async function defaultLaunchBrowser({ chromium, onResolved }) {
  const resolved = resolveBrowserExecutable()
  // Reported, not just used: which browser answered and HOW it was found is
  // the portability fact a reader of the result document needs (an override, a
  // well-known install path, or a PATH lookup).
  onResolved?.(resolved)
  return chromium.launch({ headless: true, executablePath: resolved.executablePath })
}

/** How long a browser gets to close politely before its group is signalled. */
const BROWSER_CLOSE_GRACE_MS = 2500

/** What a browser process looks like in an argv, for identifying the one we launched. */
const BROWSER_COMMAND = /chrom|firefox|webkit|headless_shell/i

/**
 * Find and record the browser Playwright just spawned.
 *
 * Playwright does not expose the pid of the browser it launches, so an
 * abandoned run would leave behind a browser that no manifest names and no
 * cleanup can identify. The pid is recovered by diffing our own direct children
 * across the launch, and then CONFIRMED against the process's argv — recording
 * a pid we merely guessed would put a stranger into the manifest that cleanup
 * later acts on.
 * @param run - the run handle (for runDir and ownerToken).
 * @param before - direct child pids captured before the launch.
 * @param log - the run transcript.
 * @returns the recorded identity, or undefined when no browser child was found.
 */
async function recordBrowserProcess(run, before, log) {
  const spawned = (await childPids()).filter((pid) => !before.has(pid))
  for (const pid of spawned) {
    const identity = await processIdentity(pid)
    if (identity === undefined || !BROWSER_COMMAND.test(identity.command)) continue
    const recorded = await recordProcess(run.runDir, { pid, role: 'browser', ownerToken: run.ownerToken })
    if (recorded !== undefined) {
      log(`browser pid ${recorded.pid} recorded (group ${recorded.pgid}${recorded.pgid === recorded.pid ? ', own group' : ', shared group'})`)
      return recorded
    }
  }
  // Not fatal: the browser is still closed through Playwright, and the origin
  // fence still applies. Only the orphan path loses a handle, so say so.
  log('browser pid not identified: an abandoned run would leave this browser for the OS to reap')
  return undefined
}

/**
 * Close a browser within a bounded time.
 *
 * `browser.close()` against an installed Google Chrome takes a measured 30
 * seconds: Playwright waits on the whole process tree, and Chrome's renderer
 * and GPU helpers outlive the parent. Thirty seconds is paid on every dispose
 * AND on every unwind of a failed bring-up, which turns a prompt reclamation
 * into a stall. So: ask politely, and if the browser has not gone by the grace
 * period, signal its process group and stop waiting. The profile is a
 * throwaway, so there is nothing for a graceful exit to preserve.
 * @param browser - the launched browser.
 * @param recorded - its recorded identity (pid + pgid), when known.
 */
async function closeBrowser(browser, recorded) {
  // Kept alive deliberately: once the group is signalled this settles on its
  // own, and an unobserved rejection here must not fail the run.
  const closing = Promise.resolve(browser.close()).then(() => 'closed', () => 'closed')
  if (recorded?.pid === undefined) { await closing; return }
  let timer
  const grace = new Promise((resolve) => { timer = setTimeout(() => resolve('grace expired'), BROWSER_CLOSE_GRACE_MS) })
  const first = await Promise.race([closing, grace])
  clearTimeout(timer)
  if (first === 'closed') return
  try { await killRecorded(recorded, 'SIGKILL') } catch { /* already gone */ }
}

/**
 * Bring the whole stack up.
 *
 * @param options.plugins - extra cordis plugins to mount into the throwaway
 *   host; see `HostPluginSpec` in `scripts/host-integration/start-host.mjs`.
 * @param options.signal - AbortSignal; cancelling unwinds every started stage.
 * @param options.bringUpTimeoutMs - deadline for the whole bring-up. A hung
 *   bring-up leaks exactly like a failed one, so it reaches the same unwinder.
 * @param options.deps - bring-up seams. Defaults are the real implementations;
 *   the unwinding regression substitutes real-but-cheap resources so it can
 *   fail each stage in turn and observe that the earlier ones were reclaimed.
 * @returns the harness context handed to every scenario, plus a disposer.
 */
export async function createHarness(options = {}) {
  const {
    plugins = [],
    signal: callerSignal,
    bringUpTimeoutMs = 300_000,
    deps = {},
  } = options
  const {
    createRunRoot: createRunRootImpl = createRunRoot,
    disposeRunRoot: disposeRunRootImpl = disposeRunRoot,
    startHost: startHostImpl = startHost,
    startUiServer: startUiServerImpl = defaultStartUiServer,
    loadPlaywright = defaultLoadPlaywright,
    launchBrowser = defaultLaunchBrowser,
    artifactDir = ARTIFACT_DIR,
  } = deps

  const runLog = []
  /** Append one redacted line to the run transcript. */
  const log = (message) => {
    const line = redact(`[${new Date().toISOString()}] ${message}`)
    runLog.push(line)
    console.log(line)
  }

  /**
   * Where the real components actually came from, for the layer result.
   *
   * Filled in as each is resolved, so a bring-up that fails half way still
   * reports what it managed to find — which is the interesting part when the
   * failure IS a missing component on an unfamiliar machine.
   */
  const provenance = {}

  const deadline = bringUpSignal({ signal: callerSignal, timeoutMs: bringUpTimeoutMs })
  const stack = createResourceStack({
    signal: deadline.signal,
    onUnwind: (entry, reason) => {
      const line = `[${new Date().toISOString()}] unwind ${entry.stage}: ${entry.ok ? 'released' : `FAILED ${entry.error}`}${reason ? ` (${reason})` : ''}`
      runLog.push(line)
      console.log(line)
    },
  })

  try {
    // 1. The run root. Everything else lives inside it, so reclaiming it is
    //    what makes a failed bring-up leave no temp tree behind.
    const run = await stack.use('run-root', async () => {
      const created = await createRunRootImpl()
      return { value: created, dispose: () => disposeRunRootImpl(created) }
    })

    await mkdir(artifactDir, { recursive: true })
    const hostLogPath = path.join(artifactDir, 'host.log')
    const runLogPath = path.join(artifactDir, 'run.log')
    const controlFile = path.join(run.dshHome, 'fake-control.json')
    await writeFile(controlFile, JSON.stringify({ toolLabel: 'synthetic-action' }) + '\n')

    const [hostPort, uiPort] = await claimPorts(2)

    // 2. The real pinned host. `register` lets a stage hand over a resource the
    //    moment it exists, so a stage that dies (or hangs) AFTER spawning
    //    something is still recoverable — the run manifest is the second line
    //    of defence for the same case.
    const host = await stack.use('host', async (register) => {
      const started = await startHostImpl({
        register,
        dshHome: run.dshHome,
        workspace: run.workspace,
        hostPort,
        uiPort,
        controlFile,
        logPath: hostLogPath,
        plugins,
        runDir: run.runDir,
        runId: run.runId,
        ownerToken: run.ownerToken,
        signal: deadline.signal,
      })
      return { value: started, dispose: () => started.stop() }
    })
    log(`real pinned host up: ${host.command}`)
    log(`run root ${run.runDir} (runId ${run.runId})`)
    provenance.dsh = host.dsh
    // Which process-table backend this machine has. Reported at bring-up
    // because "none" means nothing this run spawns can ever be reclaimed by a
    // later cleanup, and that has to be visible rather than inferred from a
    // leaked process days later.
    provenance.identity = await identityBackend()
    log(`process identity backend: ${provenance.identity.backend}`
      + `${provenance.identity.ok ? '' : ' — WARNING: spawned processes cannot be recorded or reaped'}`)

    // 3. The SPA origin.
    const ui = await stack.use('ui-server', async (register) => {
      const started = await startUiServerImpl({ uiPort, host, register })
      return { value: started, dispose: () => started.stop() }
    })
    log(`SPA origin up: ${ui.origin} (relaying /api to the real host)`)

    // 4. The playwright module. Resolution can legitimately fail (`blocked`);
    //    the host and the SPA above are reclaimed on the way out.
    const playwright = await stack.use('playwright-module', async () => ({ value: await loadPlaywright() }))
    log(`playwright: ${playwright.modulePath} (${playwright.source})`)
    provenance.playwright = { modulePath: playwright.modulePath, source: playwright.source }
    for (const warning of playwright.warnings ?? []) log(`playwright warning: ${warning}`)

    // 5. The browser process. Playwright does not hand back the pid of the
    //    browser it spawns, so it is discovered by diffing our own direct
    //    children around the launch and then recorded in the run manifest —
    //    otherwise an abandoned run leaks a headless browser that no cleanup
    //    can identify, and the origin fence would be the only thing standing
    //    between a stray browser and the network.
    const browser = await stack.use('browser', async (register) => {
      const before = new Set(await childPids())
      let launched
      try {
        launched = await launchBrowser({
          chromium: playwright.chromium,
          register,
          onResolved: (resolved) => { provenance.browser = resolved },
        })
      } catch (error) {
        // A launcher can create Chrome and then fail before returning its
        // Browser handle. Reclaim that partial resource before stage unwind.
        const recorded = await recordBrowserProcess(run, before, log)
        if (recorded !== undefined) await killRecorded(recorded, 'SIGKILL').catch(() => undefined)
        throw error
      }
      // Identify the new child by what it IS, not by the order it appeared in:
      // recording the wrong pid would put a stranger in the manifest, and the
      // manifest is what cleanup acts on.
      const recorded = await recordBrowserProcess(run, before, log)
      return { value: launched, dispose: () => closeBrowser(launched, recorded) }
    })

    const blockedRequests = []
    const allowedOrigins = [ui.origin, host.base]

    // 6. The browser context, fenced to this run's own two origins.
    const context = await stack.use('browser-context', async (register) => {
      const created = await browser.newContext({ viewport: { width: 1440, height: 960 } })
      register('browser-context', () => created.close())
      // Fence FIRST: a page created before the route exists could already have
      // issued an outbound request.
      await created.route('**/*', createOriginFence({
        allowedOrigins,
        onBlock: (blocked) => {
          blockedRequests.push(blocked)
          log(`blocked external request: ${blocked.method ?? 'GET'} ${blocked.url}`)
        },
      }))
      await created.addInitScript(INIT_SCRIPT)
      return { value: created }
    })

    // Script faults are failures. A missing optional plugin route is not: the
    // store documents /api/agos/*, /api/swarm/*, /api/memory/* as soft
    // dependencies ("absent plugin → absent group"), and a stock host mounts
    // none of them. Those are recorded separately so the report can show them
    // instead of hiding them inside a generic console-error bucket.
    const pageErrors = []
    const httpFailures = []

    /**
     * Every scenario gets its OWN page. Route handlers (`page.route`,
     * `page.routeWebSocket`) live on the page and there is no unroute for the
     * WebSocket kind, so reusing one page would leak scenario 6's emptied
     * opening snapshot into scenarios 7 and 8.
     */
    const attachPage = async () => {
      const fresh = await context.newPage()
      fresh.on('pageerror', (error) => pageErrors.push(String(error.message)))
      fresh.on('console', (message) => {
        if (message.type() !== 'error') return
        const text = message.text()
        if (/Failed to load resource/i.test(text)) return
        pageErrors.push(`console: ${text}`)
      })
      fresh.on('response', (response) => {
        const status = response.status()
        if (status < 400) return
        httpFailures.push({ url: new URL(response.url()).pathname, status })
      })
      fresh.on('requestfailed', (request) => {
        httpFailures.push({ url: new URL(request.url()).pathname, status: 'failed' })
      })
      return fresh
    }

    // 7. The first page.
    let page = await stack.use('page', async () => {
      const first = await attachPage()
      return { value: first, dispose: () => first.close() }
    })
    provenance.browserVersion = browser.version()
    log(`real browser up: ${provenance.browserVersion}`)

    /** One real unary call against the real host (test setup / assertions). */
    const unary = async (method, args) => {
      const rpcId = crypto.randomUUID()
      const response = await fetch(new URL(`/api/${method}`, host.base), {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: host.cookieHeader },
        body: JSON.stringify({ type: 'client-request', rpcId, method, payload: { args } }),
      })
      if (!response.ok) throw new Error(`HTTP ${response.status} for ${method}`)
      const body = await response.json()
      if (body.rpcId !== rpcId) throw new Error(`rpcId echo mismatch for ${method}`)
      if (body.result?.ok !== true) throw new Error(`${method} failed: ${JSON.stringify(body.result?.error)}`)
      return body.result.value
    }

    const ctx = {
      host,
      ui,
      /** The current scenario's page (replaced by `resetPage`). */
      get page() { return page },
      context,
      browser,
      workspace: run.workspace,
      dshHome: run.dshHome,
      runId: run.runId,
      runDir: run.runDir,
      pageErrors,
      httpFailures,
      /** External requests the origin fence aborted, for hermeticity assertions. */
      blockedRequests,
      allowedOrigins,
      /** Where the dsh CLI, playwright build and browser were found. */
      provenance,
      log,
      unary,
      waitFor,

      /**
       * PLUGIN INTERFACE.
       *
       * `requested` is what this run asked the host to mount; `status()`
       * re-probes the RUNNING host and reports, per plugin, whether its route
       * actually answers; `loaded()` is the id list that verified. A caller
       * that needs a plugin should report `blocked` when its id is missing
       * from `loaded()` rather than interpreting the resulting 404 as a
       * product defect.
       */
      plugins: {
        requested: plugins,
        status: () => host.pluginStatus(),
        loaded: () => host.loadedPlugins(),
      },

      /**
       * Discard this scenario's page and its route handlers, then hand back a
       * clean one. Called by the runner between scenarios so no interception
       * survives into the next test.
       */
      async resetPage() {
        pageErrors.length = 0
        httpFailures.length = 0
        const previous = page
        page = await attachPage()
        try { await previous.close() } catch { /* already gone */ }
      },

      /** Steer the fake model/tool between scenarios. */
      async setControl(patch) {
        await writeFile(controlFile, JSON.stringify(patch) + '\n')
      },

      /** Create a real session on the real host. */
      async createSession(title) {
        const { sessionId } = await unary('session/create', { request: { cwd: run.workspace } })
        if (title !== undefined) await unary('session/rename', { request: { sessionId, title } })
        return sessionId
      },

      /**
       * Read one session's real opening window straight from the host over a
       * short-lived real /api/remote.mux `session/follow` stream. Used for
       * host-side ground truth: `session/page` with `throughSeq: -1` is defined
       * as the EMPTY cut, so the cursor has to come from the snapshot itself.
       * @param sessionId - the session to inspect.
       * @returns cursor, window records and hasMore, as the host sent them.
       */
      async followSnapshot(sessionId) {
        const url = new URL('/api/remote.mux', host.base)
        url.protocol = 'ws:'
        const streamId = crypto.randomUUID()
        const socket = new WebSocket(url, { headers: { cookie: host.cookieHeader } })
        try {
          const snapshot = await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('follow snapshot timed out')), 30_000)
            socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('mux connect failed')) })
            socket.addEventListener('open', () => socket.send(JSON.stringify({
              type: 'open',
              streamId,
              endpoint: 'session/follow',
              payload: { args: { request: { address: { kind: 'session', sessionId } } } },
            })))
            socket.addEventListener('message', (event) => {
              const message = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data))
              if (message.streamId !== streamId) return
              if (message.type === 'error') { clearTimeout(timer); reject(new Error(JSON.stringify(message.error))); return }
              if (message.type === 'item' && message.value?.type === 'snapshot') {
                clearTimeout(timer)
                resolve(message.value)
              }
            })
          })
          return {
            cursor: snapshot.cursor,
            hasMore: snapshot.hasMore === true,
            records: snapshot.records,
            types: snapshot.records.map((record) => record.event?.type),
          }
        } finally {
          try { socket.close() } catch { /* already closed */ }
        }
      },

      /** Send a real prompt through the real agent loop. */
      async prompt(sessionId, text) {
        return unary('session/prompt', {
          request: {
            requestId: crypto.randomUUID(),
            sessionId,
            mode: 'steer',
            content: [{ type: 'text', text }],
            clientTimeZone: 'Asia/Shanghai',
          },
        })
      },

      /** Load the SPA fresh (each scenario starts from a clean page). */
      async openApp() {
        await page.goto(ui.origin, { waitUntil: 'domcontentloaded' })
        await page.locator('.app-container').waitFor({ timeout: 30_000 })
      },

      /** Click one session row in the real sidebar and wait for it to be current. */
      async selectSession(sessionId) {
        const row = page.locator(`[data-session-id="${sessionId}"] .session-row-open`)
        await row.waitFor({ timeout: 30_000 })
        await row.click()
        await page.locator(`[data-session-id="${sessionId}"] .session-row-open[aria-current="page"]`)
          .waitFor({ timeout: 30_000 })
      },

      /**
       * Read the REAL live store the app is using. Vite serves one module
       * instance per URL, so a dynamic import inside the page resolves to the
       * very singleton `App` imported — this observes production state, it does
       * not inject or replace any of it.
       * @param sessionId - session whose conversation snapshot is wanted.
       */
      async readStore(sessionId) {
        return page.evaluate(async (id) => {
          const live = await import('/src/stores/live.ts')
          const convo = live.conversationStore.getSnapshot(id)
          return {
            phase: convo.phase,
            error: convo.error,
            streamOnline: convo.streamOnline,
            historyIncomplete: convo.historyIncomplete,
            historyRetryable: convo.historyRetryable,
            historyLoading: convo.historyLoading,
            currentStep: convo.currentStep ?? null,
            itemCount: convo.snapshot?.items.length ?? 0,
            items: (convo.snapshot?.items ?? []).map((item) => ({
              kind: item.kind,
              id: item.id ?? null,
              callId: item.callId ?? null,
              outcome: item.outcome ?? null,
              turn: item.turn ?? null,
              step: item.step ?? null,
            })),
            activeSessionId: live.conversationStore.activeSessionId() ?? null,
            liveConnection: live.liveConnectionStore.getSnapshot(),
          }
        }, sessionId)
      },

      /**
       * Watch the REAL connection phase from INSIDE the page, two ways at once:
       * `notified` records what `liveConnectionStore.subscribe` delivers (what a
       * React consumer would actually re-render on), `sampled` is a 5ms poll of
       * `getSnapshot`. A cross-process poll from Node is far too coarse — the
       * reconnect can finish in a few milliseconds — and keeping both apart tells
       * us whether a phase was merely fast or genuinely never published.
       */
      async watchConnection() {
        await page.evaluate(async () => {
          const live = await import('/src/stores/live.ts')
          const notified = []
          const sampled = []
          const read = () => ({
            phase: live.liveConnectionStore.getSnapshot(),
            online: live.streamStore.getSnapshot(),
            at: Date.now(),
          })
          const push = (into) => {
            const next = read()
            const last = into[into.length - 1]
            if (last === undefined || last.phase !== next.phase || last.online !== next.online) into.push(next)
          }
          window.__agosConn?.stop()
          const unsubscribe = live.liveConnectionStore.subscribe(() => push(notified))
          // Tick accounting for the poller. Without it, "the poller never saw
          // the drop" is indistinguishable between two very different facts:
          // the phase was published for less than one interval, or the timer
          // was throttled and barely ran at all. Chrome throttles timers in
          // pages it considers background, so the second is a real possibility
          // and it must not be reported as the first.
          let ticks = 0
          const startedAt = Date.now()
          const timer = setInterval(() => { ticks += 1; push(sampled) }, 5)
          window.__agosConn = {
            notified,
            sampled,
            startedAt,
            ticksOf: () => ticks,
            stop() { unsubscribe(); clearInterval(timer) },
          }
          push(notified)
          push(sampled)
        })
      },

      /**
       * Both connection-phase trails recorded since `watchConnection`.
       * `documentAlive: false` means the page navigated/reloaded and wiped the
       * recorder — a reconnect observed across that boundary would be a NEW
       * document, not a recovered transport, so it must never count as a pass.
       */
      async connectionTrail() {
        return page.evaluate(() => ({
          documentAlive: window.__agosConn !== undefined,
          notified: window.__agosConn?.notified ?? [],
          sampled: window.__agosConn?.sampled ?? [],
          /** Poller ticks and elapsed ms, so a missed transient can be explained. */
          ticks: window.__agosConn?.ticksOf?.() ?? 0,
          watchedMs: window.__agosConn === undefined ? 0 : Date.now() - window.__agosConn.startedAt,
          sockets: window.__agosHarness.socketUrls(),
        }))
      },

      /** Read the real store's approval view for one call id. */
      async readApproval(callId, sessionId) {
        return page.evaluate(async ([call, session]) => {
          const live = await import('/src/stores/live.ts')
          const view = live.approvalView(call, session)
          return {
            status: view.status ?? null,
            error: view.error ?? null,
            busy: view.busy,
            decision: view.decision ?? null,
            canRetry: view.canRetry,
            hasWaterfall: live.hasApprovalWaterfall(call, session),
          }
        }, [callId, sessionId])
      },

      /** Save a screenshot as scenario evidence. */
      async screenshot(name) {
        const file = path.join(artifactDir, `${name}.png`)
        await page.screenshot({ path: file, fullPage: false })
        return file
      },

      /**
       * Tear the whole stack down. Same unwinder the failure path uses, so a
       * clean run and a broken run reclaim exactly the same things.
       */
      async dispose() {
        await writeFile(runLogPath, runLog.join('\n') + '\n').catch(() => undefined)
        await stack.unwindAll('dispose')
        deadline.release()
        log(`host stopped: code=${host.child?.exitCode} signal=${host.child?.signalCode}`)
        await writeFile(runLogPath, runLog.join('\n') + '\n').catch(() => undefined)
        return { code: host.child?.exitCode ?? null, signal: host.child?.signalCode ?? null }
      },
    }

    // The deadline covers BRING-UP, not the scenarios that follow. Releasing it
    // here keeps a long suite from being cancelled by the timer that was only
    // ever meant to stop a hung startup.
    deadline.release()
    return ctx
  } catch (error) {
    // `stack.use` already unwound on its own failure path; this catches
    // anything thrown BETWEEN stages (port claiming, control-file write) and
    // guarantees the same reclamation.
    await stack.unwindAll('bring-up failed outside a stage')
    deadline.release()
    throw error
  }
}
