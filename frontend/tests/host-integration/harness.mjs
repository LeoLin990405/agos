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
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  ARTIFACT_DIR, BROWSER_EXECUTABLE, PLAYWRIGHT_MODULE, claimPorts, makeTempRoots,
  redact, removeTemp, waitFor,
} from '../../scripts/host-integration/host-env.mjs';
import { startHost } from '../../scripts/host-integration/start-host.mjs';
import { startUiServer } from '../../scripts/host-integration/ui-server.mjs';

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
 * Bring the whole stack up.
 * @returns the harness context handed to every scenario, plus a disposer.
 */
export async function createHarness() {
  const roots = await makeTempRoots()
  const [hostPort, uiPort] = await claimPorts(2)
  const controlFile = path.join(roots.dshHome, 'fake-control.json')
  await writeFile(controlFile, JSON.stringify({ toolLabel: 'synthetic-action' }) + '\n')
  await mkdir(ARTIFACT_DIR, { recursive: true })
  const hostLogPath = path.join(ARTIFACT_DIR, 'host.log')
  const runLogPath = path.join(ARTIFACT_DIR, 'run.log')
  const runLog = []

  /** Append one redacted line to the run transcript. */
  const log = (message) => {
    const line = redact(`[${new Date().toISOString()}] ${message}`)
    runLog.push(line)
    console.log(line)
  }

  const host = await startHost({ ...roots, hostPort, uiPort, controlFile, logPath: hostLogPath })
  log(`real pinned host up: ${host.command}`)
  const ui = await startUiServer({ uiPort, host })
  log(`SPA origin up: ${ui.origin} (relaying /api to the real host)`)

  // playwright-core ships CJS: the named export exists on some builds, the
  // default namespace on others. Reuse whichever this install provides.
  const playwright = await import(PLAYWRIGHT_MODULE)
  const chromium = playwright.chromium ?? playwright.default?.chromium
  if (chromium === undefined) throw new Error(`host-integration: no chromium export in ${PLAYWRIGHT_MODULE}`)
  const browser = await chromium.launch({ headless: true, executablePath: BROWSER_EXECUTABLE })
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 } })
  await context.addInitScript(INIT_SCRIPT)
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

  let page = await attachPage()
  log(`real browser up: ${browser.version()}`)

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
    workspace: roots.workspace,
    dshHome: roots.dshHome,
    pageErrors,
    httpFailures,
    log,
    unary,
    waitFor,

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
      const { sessionId } = await unary('session/create', { request: { cwd: roots.workspace } })
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
        const timer = setInterval(() => push(sampled), 5)
        window.__agosConn = {
          notified,
          sampled,
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
      const file = path.join(ARTIFACT_DIR, `${name}.png`)
      await page.screenshot({ path: file, fullPage: false })
      return file
    },

    async dispose() {
      await writeFile(runLogPath, runLog.join('\n') + '\n')
      try { await context.close() } catch { /* closing */ }
      try { await browser.close() } catch { /* closing */ }
      await ui.stop()
      const stopped = await host.stop()
      log(`host stopped: code=${stopped?.code} signal=${stopped?.signal}`)
      await writeFile(runLogPath, runLog.join('\n') + '\n')
      await removeTemp(roots.dshHome)
      await removeTemp(roots.workspace)
      return stopped
    },
  }

  return ctx
}
