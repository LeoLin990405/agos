/**
 * The eight required scenarios, driven against a REAL pinned dsh host in a
 * REAL browser over the REAL 0.1.2 transport.
 *
 * `exercises` on every scenario is the honest label that travels into the
 * report. Read it as: which layer is genuinely exercised, and what — if
 * anything — the test injected. Where a scenario needs a condition the real
 * host will not produce on demand (a held HTTP response, an aborted POST, a
 * dropped socket), the injection is named explicitly and is always a fault
 * injected into a real connection, never a substitute for the host.
 */

const REAL = { host: 'real', browser: 'real', transport: 'real', store: 'real' }

/**
 * Optional AgOS plugin routes and third-party assets a stock pinned host does
 * not serve. `live.ts` swallows their failure by design, so a 404 here is the
 * documented degraded path, not a defect.
 */
const SOFT_ROUTES = /^\/(api\/(agos|swarm|memory|fleet|turn-evidence|yolo)\/|css2|fonts\/)/

/** Copy the production panel renders; asserting on it proves the real render path. */
const COPY = {
  pending: '正在提交审批，尚未生效',
  accepted: '请求已送达，等待宿主授权生效',
  allowed: '已放行:本次特权执行已授权',
  rejected: '已拒绝:本次特权执行已中止',
  sessionChanged: '已切换会话，本次提交不作用于当前会话',
  historyMore: '当前窗口不是完整会话，还有更早的历史。',
  loadEarlier: '加载更早的历史',
  allowOnce: '允许单次执行',
}

/**
 * Record every approval phase the REAL DOM actually passed through, together
 * with the copy rendered at that moment. The transcript replaces a decided
 * approval with a settled audit row, so `panels: 0` is a real terminal state
 * and is recorded as `gone`.
 */
async function installPhaseRecorder(page) {
  await page.evaluate(() => {
    const state = { steps: [] }
    window.__agosPhases = state
    const read = () => {
      const panels = [...document.querySelectorAll('[data-approval-phase]')]
      const entry = panels.length === 0
        ? 'gone'
        : panels.map((el) => {
          const phase = el.getAttribute('data-approval-phase')
          const decision = el.getAttribute('data-approval-decision')
          return decision === null ? phase : `${phase}:${decision}`
        }).join('|')
      const last = state.steps[state.steps.length - 1]
      if (last?.entry === entry) return
      state.steps.push({
        entry,
        text: panels.map((el) => el.textContent ?? '').join(' ⋯ '),
        settled: document.body.innerText.includes('已放行(一次)'),
      })
    }
    read()
    new MutationObserver(read).observe(document.body, {
      subtree: true, childList: true, attributes: true, characterData: true,
      attributeFilter: ['data-approval-phase', 'data-approval-decision'],
    })
  })
}

/** The recorded phase timeline. */
const readPhases = async (page) => {
  const state = await page.evaluate(() => window.__agosPhases ?? { steps: [] })
  return { steps: state.steps, entries: state.steps.map((step) => step.entry) }
}

/**
 * Assert the panel never claimed authorization before the host said so: no
 * recorded step may show 已放行 while its own phase is still pre-decision.
 */
function noPrematureGrant(steps) {
  return steps.every((step) => {
    if (!step.text.includes('已放行')) return true
    return /resolved/.test(step.entry)
  })
}

/** Wait until the real store holds a pending approval item, and return its callId. */
async function pendingApprovalCallId(ctx, sessionId) {
  return ctx.waitFor(async () => {
    const store = await ctx.readStore(sessionId)
    const item = store.items.find((entry) => entry.kind === 'approval' && entry.outcome === null)
    return item === undefined ? false : (item.callId ?? item.id)
  }, { timeoutMs: 45_000, intervalMs: 150, label: 'a pending approval item in the real store' })
}

/**
 * Drive one real turn to the point where the real host is asking for approval,
 * with the real panel on screen.
 * @returns the session id and the pending call id.
 */
async function arriveAtPendingApproval(ctx, { title }) {
  await ctx.setControl({ toolLabel: 'synthetic-action' })
  const sessionId = await ctx.createSession(title)
  await ctx.openApp()
  await ctx.selectSession(sessionId)
  await installPhaseRecorder(ctx.page)
  await ctx.prompt(sessionId, '请执行一次合成特权动作')
  await ctx.page.locator('.approval-panel').first().waitFor({ timeout: 45_000 })
  const callId = await pendingApprovalCallId(ctx, sessionId)
  return { sessionId, callId }
}

/**
 * Build a real session whose log outgrows the host's 50-message follow window,
 * so the real host itself answers `hasMore: true`.
 *
 * Turn completion is read from the host's own sessionStats projection, not
 * guessed from a timer: `session/page` with `throughSeq: -1` is the EMPTY cut
 * by definition and can never be used to observe growth.
 */
async function buildLongSession(ctx, { title, turns = 30 }) {
  await ctx.setControl({ noTool: true })
  const sessionId = await ctx.createSession(title)

  /** Host-reported completed turns for this session. */
  const turnCount = async () => {
    const list = await ctx.unary('session/list', { _request: {} })
    const row = list.items.find((item) => String(item.sessionId) === sessionId)
    const stats = row?.projections?.values?.sessionStats
    return { turns: Number(stats?.turns ?? 0), running: row?.running === true }
  }

  for (let index = 0; index < turns; index += 1) {
    await ctx.prompt(sessionId, `历史构建 ${index + 1}`)
    await ctx.waitFor(async () => {
      const state = await turnCount()
      return state.turns >= index + 1 && !state.running
    }, { timeoutMs: 30_000, intervalMs: 100, label: `turn ${index + 1} to complete on the real host` })
  }

  const snapshot = await ctx.followSnapshot(sessionId)
  const final = await turnCount()
  return {
    sessionId,
    hasMore: snapshot.hasMore,
    cursor: snapshot.cursor,
    windowRecords: snapshot.records.length,
    turns: final.turns,
  }
}

export const scenarios = [
  {
    id: '0-bringup',
    title: 'the real SPA loads against the real host and goes live',
    exercises: { ...REAL, note: 'no injection; pure bring-up of host + SPA + browser' },
    async run(ctx) {
      const sessionId = await ctx.createSession('bringup')
      await ctx.openApp()
      await ctx.selectSession(sessionId)

      const store = await ctx.waitFor(async () => {
        const snapshot = await ctx.readStore(sessionId)
        return snapshot.phase === 'live' ? snapshot : false
      }, { timeoutMs: 45_000, intervalMs: 200, label: 'session/follow to go live in the real store' })

      ctx.record(store.phase === 'live', `real session/follow reached phase=live in the browser store`)
      ctx.record(store.streamOnline === true, `real $events stream online in the browser (streamOnline=${store.streamOnline})`)
      ctx.record(store.liveConnection === 'online', `live connection phase=${store.liveConnection}`)

      const socketCount = await ctx.page.evaluate(() => window.__agosHarness.openSocketCount())
      ctx.record(socketCount >= 1, `${socketCount} real /api/remote.mux WebSocket(s) open from the page`)

      const rowVisible = await ctx.page.locator(`[data-session-id="${sessionId}"]`).isVisible()
      ctx.record(rowVisible, 'the session the real host created is listed in the real sidebar')
      ctx.record(ctx.pageErrors.length === 0, `script errors: ${JSON.stringify(ctx.pageErrors.slice(0, 3))}`)

      // A stock host mounts none of AgOS's optional plugin routes; the store
      // treats them as soft dependencies, so their absence must not break the
      // deck. Assert the only failing requests are those documented optionals.
      const unexpected = ctx.httpFailures.filter((failure) => !SOFT_ROUTES.test(failure.url))
      ctx.record(
        unexpected.length === 0,
        `every failing request is a documented optional route; unexpected=${JSON.stringify(unexpected)}`,
      )
      ctx.log(`   optional routes absent on a stock host (expected): ${JSON.stringify([...new Set(ctx.httpFailures.map((f) => `${f.url} ${f.status}`))])}`)
      return ctx.screenshot('0-bringup')
    },
  },

  {
    id: '1-approval-accepted-then-decision',
    title: 'approval request → HTTP accepted → host decision arrives',
    exercises: { ...REAL, note: 'no injection; natural ordering from the real host' },
    async run(ctx) {
      const { sessionId, callId } = await arriveAtPendingApproval(ctx, { title: 'scenario-1' })

      const before = await ctx.readApproval(callId, sessionId)
      ctx.record(before.hasWaterfall === true, 'the real approval/request waterfall is answerable (hasApprovalWaterfall)')
      const panel = ctx.page.locator('.approval-panel').first()
      const textBefore = await panel.innerText()
      ctx.record(!textBefore.includes(COPY.allowed), 'before any click the panel does not claim 已放行')

      await ctx.page.getByRole('button', { name: COPY.allowOnce, exact: true }).first().click()

      const resolved = await ctx.waitFor(async () => {
        const view = await ctx.readApproval(callId, sessionId)
        return view.status === 'resolved' ? view : false
      }, { timeoutMs: 45_000, intervalMs: 100, label: 'the host decision to resolve the approval' })

      ctx.record(resolved.decision === 'allowed-once', `host-evident decision = ${resolved.decision}`)
      const { steps, entries } = await readPhases(ctx.page)
      ctx.record(entries.includes('pending'), `observed phase timeline: ${JSON.stringify(entries)}`)
      ctx.record(noPrematureGrant(steps), 'no pre-decision phase ever rendered 已放行')

      // The transcript's terminal state for a decided approval is the settled
      // audit row, not a live panel: the pending panel must be gone and the
      // host's own outcome must be the thing on screen.
      await ctx.page.getByText('已放行(一次)', { exact: false }).first().waitFor({ timeout: 20_000 })
      ctx.record(true, 'the settled audit row renders the host outcome 已放行(一次)')
      ctx.record(
        await ctx.page.locator('.approval-panel').count() === 0,
        'no pending approval panel survives the decision',
      )

      // Host-side proof the grant was real: the fake tool only runs once allowed.
      const window = await ctx.waitFor(async () => {
        const snapshot = await ctx.followSnapshot(sessionId)
        return snapshot.types.includes('tool/result') ? snapshot : false
      }, { timeoutMs: 30_000, intervalMs: 200, label: 'the host log to carry the tool result' })
      ctx.record(window.types.includes('approval/decided'), `real host log types: ${JSON.stringify(window.types)}`)
      ctx.record(window.types.includes('tool/result'), 'real host executed the tool only after the grant')
      return ctx.screenshot('1-approval-accepted-then-decision')
    },
  },

  {
    id: '2-decision-before-http-response',
    title: 'host decision arrives BEFORE the HTTP response returns (ordering race)',
    exercises: {
      ...REAL,
      note: 'fault injected into a real connection: the real $events/result response is '
        + 'held by the test after the real host already processed it, so the decision '
        + 'provably wins the race. Request and response bytes are the host\'s own.',
    },
    async run(ctx) {
      const { sessionId, callId } = await arriveAtPendingApproval(ctx, { title: 'scenario-2' })

      let held
      let releaseGate
      const gate = new Promise((resolve) => { releaseGate = resolve })
      await ctx.page.route(
        (url) => url.pathname === '/api/$events/result',
        async (route) => {
          // Perform the REAL request: the host processes the decision here and
          // emits approval/decided on the real session/follow stream.
          const response = await route.fetch()
          held = true
          await gate
          await route.fulfill({ response })
        },
      )

      await ctx.page.getByRole('button', { name: COPY.allowOnce, exact: true }).first().click()
      await ctx.waitFor(() => held === true, { timeoutMs: 30_000, intervalMs: 50, label: 'the POST to reach the host' })

      // While the POST response is still held, the decision must already have
      // travelled the follow stream and resolved the panel.
      const duringHold = await ctx.waitFor(async () => {
        const view = await ctx.readApproval(callId, sessionId)
        return view.status === 'resolved' ? view : false
      }, { timeoutMs: 30_000, intervalMs: 100, label: 'the decision to resolve while the POST is held' })

      ctx.record(true, 'the host decision resolved the approval while the HTTP response was still in flight')
      ctx.record(duringHold.decision === 'allowed-once', `decision during hold = ${duringHold.decision}`)
      const during = await readPhases(ctx.page)
      ctx.record(
        noPrematureGrant(during.steps),
        `no pre-decision phase claimed 已放行: ${JSON.stringify(during.entries)}`,
      )
      const shot = await ctx.screenshot('2-decision-before-http-response')

      releaseGate()
      await ctx.page.unroute((url) => url.pathname === '/api/$events/result').catch(() => {})

      // The late HTTP acknowledgement must not downgrade the resolved state.
      await new Promise((resolve) => setTimeout(resolve, 750))
      const afterRelease = await ctx.readApproval(callId, sessionId)
      ctx.record(afterRelease.status === 'resolved', `after the late 200 the phase is still ${afterRelease.status}`)
      ctx.record(afterRelease.decision === 'allowed-once', `decision unchanged by the late 200: ${afterRelease.decision}`)
      const final = await readPhases(ctx.page)
      ctx.record(
        noPrematureGrant(final.steps),
        `terminal timeline after the late 200: ${JSON.stringify(final.entries)}`,
      )
      const window = await ctx.followSnapshot(sessionId)
      ctx.record(
        window.types.filter((type) => type === 'approval/decided').length === 1,
        `the real host recorded exactly one decision (${window.types.filter((t) => t === 'approval/decided').length})`,
      )
      return shot
    },
  },

  {
    id: '3-failure-then-retry',
    title: 'failure then retry',
    exercises: {
      ...REAL,
      note: 'fault injected into a real connection: the FIRST $events/result POST is '
        + 'aborted at the transport, so the real host never sees it and the real '
        + 'waterfall stays open; the retry is a genuine unmodified POST.',
    },
    async run(ctx) {
      const { sessionId, callId } = await arriveAtPendingApproval(ctx, { title: 'scenario-3' })

      let attempts = 0
      await ctx.page.route(
        (url) => url.pathname === '/api/$events/result',
        async (route) => {
          attempts += 1
          if (attempts === 1) { await route.abort('connectionreset'); return }
          await route.continue()
        },
      )

      const allow = ctx.page.getByRole('button', { name: COPY.allowOnce, exact: true }).first()
      await allow.click()

      const failed = await ctx.waitFor(async () => {
        const view = await ctx.readApproval(callId, sessionId)
        return view.status === 'error' ? view : false
      }, { timeoutMs: 30_000, intervalMs: 100, label: 'the transport failure to surface' })

      ctx.record(attempts === 1, `exactly one POST was attempted and aborted (attempts=${attempts})`)
      ctx.record(failed.canRetry === true, 'the failure is retryable')
      ctx.record(failed.decision === null, 'a failed submission claims no decision')
      const panelText = await ctx.page.locator('.approval-panel').first().innerText()
      ctx.record(!panelText.includes(COPY.allowed), 'the failed panel does not claim 已放行')
      ctx.record(/可重试/.test(panelText), `retryable copy is shown: ${panelText.split('\n').pop()?.trim()}`)
      const shot = await ctx.screenshot('3-failure-then-retry')

      await ctx.waitFor(async () => !(await allow.isDisabled()), { timeoutMs: 20_000, intervalMs: 100, label: 'the button to re-enable for retry' })
      await allow.click()

      const resolved = await ctx.waitFor(async () => {
        const view = await ctx.readApproval(callId, sessionId)
        return view.status === 'resolved' ? view : false
      }, { timeoutMs: 45_000, intervalMs: 100, label: 'the retry to be granted by the real host' })

      ctx.record(attempts === 2, `the retry issued a second POST (attempts=${attempts})`)
      ctx.record(resolved.decision === 'allowed-once', `retry produced a host-evident decision: ${resolved.decision}`)

      const window = await ctx.waitFor(async () => {
        const snapshot = await ctx.followSnapshot(sessionId)
        return snapshot.types.includes('approval/decided') ? snapshot : false
      }, { timeoutMs: 30_000, intervalMs: 200, label: 'the host log to carry the decision' })
      const decided = window.types.filter((type) => type === 'approval/decided')
      ctx.record(decided.length === 1, `the real host recorded exactly one decision (${decided.length}) — the aborted POST never reached it`)
      await ctx.page.unroute((url) => url.pathname === '/api/$events/result').catch(() => {})
      return shot
    },
  },

  {
    id: '4-stale-reply-after-session-switch',
    title: 'after switching sessions, a stale reply for the old session is rejected',
    exercises: {
      ...REAL,
      note: 'two real sessions, two real waterfalls. The first session\'s real '
        + '$events/result response is held by the test across the session switch so '
        + 'the reply lands late; nothing about either session is synthesized.',
    },
    async run(ctx) {
      await ctx.setControl({ toolLabel: 'synthetic-action' })
      const sessionA = await ctx.createSession('scenario-4-A')
      const sessionB = await ctx.createSession('scenario-4-B')
      await ctx.openApp()

      // Both sessions really ask for approval on the real host.
      await ctx.selectSession(sessionA)
      await ctx.prompt(sessionA, 'A 会话:请执行一次合成特权动作')
      await ctx.page.locator('.approval-panel').first().waitFor({ timeout: 45_000 })
      const callA = await pendingApprovalCallId(ctx, sessionA)
      await ctx.prompt(sessionB, 'B 会话:请执行一次合成特权动作')

      let arrived
      let releaseGate
      const gate = new Promise((resolve) => { releaseGate = resolve })
      await ctx.page.route(
        (url) => url.pathname === '/api/$events/result',
        async (route) => {
          arrived = true
          await gate
          await route.continue()
        },
      )

      await ctx.page.getByRole('button', { name: COPY.allowOnce, exact: true }).first().click()
      await ctx.waitFor(() => arrived === true, { timeoutMs: 30_000, intervalMs: 50, label: 'A\'s reply to be intercepted' })
      const submitted = await ctx.readApproval(callA, sessionA)
      ctx.record(submitted.status === 'pending', `A's reply is in flight (status=${submitted.status})`)

      // Switch to B while A's reply is still unresolved.
      await ctx.selectSession(sessionB)
      await ctx.page.locator('.approval-panel').first().waitFor({ timeout: 45_000 })
      const callB = await pendingApprovalCallId(ctx, sessionB)
      ctx.record(callB !== callA, `B has its own distinct approval (A=${String(callA).slice(0, 12)}… B=${String(callB).slice(0, 12)}…)`)
      const storeAfterSwitch = await ctx.readStore(sessionB)
      ctx.record(storeAfterSwitch.activeSessionId === sessionB, `the store's active session is B (${storeAfterSwitch.activeSessionId === sessionB})`)

      const bBeforeRelease = await ctx.readApproval(callB, sessionB)
      ctx.record(bBeforeRelease.status === 'idle', `B is untouched before the stale reply lands (status=${bBeforeRelease.status})`)

      // Release A's stale reply. It must resolve A only, never B.
      releaseGate()
      await ctx.page.unroute((url) => url.pathname === '/api/$events/result').catch(() => {})
      await new Promise((resolve) => setTimeout(resolve, 1200))

      const bAfterRelease = await ctx.readApproval(callB, sessionB)
      ctx.record(
        bAfterRelease.status === 'idle' && bAfterRelease.decision === null,
        `the stale reply for A did not authorize B (B status=${bAfterRelease.status}, decision=${bAfterRelease.decision})`,
      )
      const aUnderB = await ctx.readApproval(callA, sessionB)
      ctx.record(
        aUnderB.status === 'idle' && aUnderB.decision === null,
        `A's callId read under B's session is rejected as foreign (status=${aUnderB.status})`,
      )
      const bPanelText = await ctx.page.locator('.approval-panel').first().innerText()
      ctx.record(!bPanelText.includes(COPY.allowed), 'B\'s live panel never claims 已放行 from A\'s reply')

      const shot = await ctx.screenshot('4-stale-reply-after-session-switch')

      // A itself did get its decision from the real host.
      const windowA = await ctx.waitFor(async () => {
        const snapshot = await ctx.followSnapshot(sessionA)
        return snapshot.types.includes('approval/decided') ? snapshot : false
      }, { timeoutMs: 30_000, intervalMs: 200, label: 'A to be decided on the host' })
      ctx.record(true, `session A was decided on the real host (${windowA.types.filter((t) => t === 'approval/decided').length} decision)`)
      const windowB = await ctx.followSnapshot(sessionB)
      ctx.record(
        !windowB.types.includes('approval/decided'),
        `session B has no decision on the real host: ${JSON.stringify(windowB.types.filter((t) => t.startsWith('approval')))}`,
      )
      return shot
    },
  },

  {
    id: '5-connection-drop-and-reconnect',
    title: 'connection ready/follow failure and reconnect',
    exercises: {
      ...REAL,
      note: 'fault injected into a real connection: the page\'s own live mux sockets '
        + 'are closed by the test (close(), not a substituted transport). The drop, '
        + 'the reconnect, the new ready frame and the new follow snapshot are all real.',
    },
    async run(ctx) {
      const sessionId = await ctx.createSession('scenario-5')
      await ctx.openApp()
      await ctx.selectSession(sessionId)
      await ctx.waitFor(async () => (await ctx.readStore(sessionId)).phase === 'live',
        { timeoutMs: 45_000, intervalMs: 200, label: 'the first live follow' })

      const before = await ctx.readStore(sessionId)
      ctx.record(before.streamOnline === true && before.liveConnection === 'online',
        `online before the drop (streamOnline=${before.streamOnline}, phase=${before.liveConnection})`)

      // Subscribe BEFORE dropping: the offline phase can last less than one
      // poll interval, so it has to be observed as a published transition.
      await ctx.watchConnection()
      // Only the app's mux sockets are dropped, never the dev-server socket:
      // closing that one makes Vite reload the document, and a reload would
      // counterfeit this whole test (fresh store, fresh sockets, looks healthy).
      const dropped = await ctx.page.evaluate(() => window.__agosHarness.dropOpenSockets('/api/remote.mux'))
      ctx.record(dropped >= 1, `${dropped} real /api/remote.mux socket(s) force-closed`)

      const down = (entry) => entry.phase !== 'online' || entry.online === false
      const trail = await ctx.waitFor(async () => {
        const seen = await ctx.connectionTrail()
        if (!seen.documentAlive) throw new Error('the page reloaded: a reload is not a reconnect')
        return seen.notified.some(down) || seen.sampled.some(down) ? seen : false
      }, { timeoutMs: 30_000, intervalMs: 50, label: 'the store to observe the drop' })
      ctx.record(trail.documentAlive, 'the document survived the drop (this is a transport reconnect, not a page reload)')
      ctx.record(trail.notified.some(down),
        `the drop is DELIVERED to store subscribers: ${JSON.stringify(trail.notified.map((entry) => entry.phase))}`)
      ctx.record(trail.sampled.some(down),
        `the drop is visible in the store's own snapshot: ${JSON.stringify(trail.sampled.map((entry) => entry.phase))}`)
      const closedMux = trail.sockets.filter((entry) => entry.url.includes('/api/remote.mux') && entry.readyState >= 2)
      ctx.record(closedMux.length >= dropped, `${closedMux.length} mux socket(s) really reached CLOSING/CLOSED`)
      const shot = await ctx.screenshot('5-connection-drop-and-reconnect')

      // watchStream backs off then reopens against the real host: a new ready
      // frame and a fresh follow snapshot must restore the deck unaided.
      const recovered = await ctx.waitFor(async () => {
        const store = await ctx.readStore(sessionId)
        return store.streamOnline === true && store.liveConnection === 'online' && store.phase === 'live' ? store : false
      }, { timeoutMs: 60_000, intervalMs: 250, label: 'the automatic reconnect to the real host' })
      ctx.record(true, `reconnected unaided: liveConnection=${recovered.liveConnection}, follow phase=${recovered.phase}`)
      const full = await ctx.connectionTrail()
      const sequence = full.notified.map((entry) => entry.phase)
      const lastDown = full.notified.reduce((found, entry, index) => (down(entry) ? index : found), -1)
      ctx.record(lastDown >= 0 && full.notified.slice(lastDown + 1).some((entry) => entry.phase === 'online'),
        `subscribers were driven online→down→online: ${JSON.stringify(sequence)}`)
      ctx.record(full.documentAlive, 'the reconnect happened inside the SAME document')
      const openMux = full.sockets.filter((entry) => entry.url.includes('/api/remote.mux') && entry.readyState <= 1)
      ctx.record(full.sockets.filter((entry) => entry.url.includes('/api/remote.mux')).length > dropped
        && openMux.length >= 1,
        `the client opened NEW mux socket(s) to the real host (${openMux.length} live of `
        + `${full.sockets.filter((entry) => entry.url.includes('/api/remote.mux')).length} tracked)`)

      // A real turn after the reconnect proves the restored channel works.
      await ctx.setControl({ noTool: true })
      await ctx.prompt(sessionId, '重连后再发一条')
      const grew = await ctx.waitFor(async () => {
        const store = await ctx.readStore(sessionId)
        return store.itemCount > recovered.itemCount ? store : false
      }, { timeoutMs: 45_000, intervalMs: 200, label: 'a post-reconnect event to arrive' })
      ctx.record(grew.itemCount > recovered.itemCount,
        `live events flow again after reconnect (${recovered.itemCount} → ${grew.itemCount} items)`)
      return shot
    },
  },

  {
    id: '6-empty-window-still-pages',
    title: 'an EMPTY opening window still exposes earlier history (paging is not hidden)',
    exercises: {
      ...REAL,
      note: 'two halves. 6a is pure: a real >50-message session makes the real host '
        + 'answer hasMore=true and the paging affordance must be offered. 6b constructs '
        + 'the empty-window case the host will not produce on demand by emptying the '
        + 'opening snapshot\'s `records` array in transit while keeping the host\'s own '
        + 'hasMore — real host, real browser, real store, one field rewritten by the test.',
    },
    async run(ctx) {
      // ── 6a: real host, real hasMore, nothing injected ───────────────────────
      const { sessionId, hasMore, turns, windowRecords } = await buildLongSession(ctx, { title: 'scenario-6', turns: 30 })
      ctx.record(hasMore === true,
        `the real host reports hasMore=true after ${turns} real turns (window holds ${windowRecords} records)`)
      await ctx.openApp()
      await ctx.selectSession(sessionId)
      const live = await ctx.waitFor(async () => {
        const store = await ctx.readStore(sessionId)
        return store.phase === 'live' && store.historyIncomplete ? store : false
      }, { timeoutMs: 45_000, intervalMs: 200, label: 'the real incomplete-history window' })
      ctx.record(live.historyIncomplete === true, 'the real store marks the window incomplete')
      await ctx.page.getByText(COPY.historyMore, { exact: false }).waitFor({ timeout: 20_000 })
      const loadEarlier = ctx.page.getByRole('button', { name: COPY.loadEarlier, exact: true })
      ctx.record(await loadEarlier.isVisible(), '6a: the paging affordance is offered on a real truncated window')

      // ── 6b: the empty opening window, constructed in transit ────────────────
      await ctx.page.routeWebSocket(
        (url) => url.pathname === '/api/remote.mux',
        (client) => {
          const server = client.connectToServer()
          client.onMessage((message) => server.send(message))
          server.onMessage((message) => {
            let frame
            try { frame = JSON.parse(String(message)) } catch { client.send(message); return }
            // Empty ONLY the opening snapshot's records; hasMore, cursor,
            // header and projections stay exactly as the real host sent them.
            if (frame?.type === 'item' && frame.value?.type === 'snapshot' && Array.isArray(frame.value.records)) {
              frame.value.records = []
              frame.value.projections = { asOfSeq: frame.value.cursor, values: {} }
              client.send(JSON.stringify(frame))
              return
            }
            client.send(message)
          })
        },
      )

      await ctx.openApp()
      await ctx.selectSession(sessionId)
      const emptyWindow = await ctx.waitFor(async () => {
        const store = await ctx.readStore(sessionId)
        return store.phase === 'live' && store.itemCount === 0 ? store : false
      }, { timeoutMs: 45_000, intervalMs: 200, label: 'an empty opening window in the real store' })

      ctx.record(emptyWindow.itemCount === 0, 'the opening window renders zero transcript items')
      ctx.record(emptyWindow.historyIncomplete === true,
        `the host's own hasMore survived, so the window is still known-incomplete (${emptyWindow.historyIncomplete})`)
      const bannerVisible = await ctx.page.getByText(COPY.historyMore, { exact: false }).isVisible()
      ctx.record(bannerVisible, '6b: an EMPTY window still shows the incomplete-history banner')
      const emptyPager = ctx.page.getByRole('button', { name: COPY.loadEarlier, exact: true })
      ctx.record(await emptyPager.isVisible(), '6b: 加载更早的历史 is reachable, not hidden behind the empty state')
      const heroCount = await ctx.page.locator('.empty-state-hero, [class*="EmptyStateHero"]').count()
      ctx.record(heroCount === 0 || bannerVisible, 'the empty-state hero has not replaced the paging affordance')
      const shot = await ctx.screenshot('6-empty-window-still-pages')

      // Paging out of the empty window really refills it from the real host.
      await emptyPager.click()
      const refilled = await ctx.waitFor(async () => {
        const store = await ctx.readStore(sessionId)
        return store.itemCount > 0 ? store : false
      }, { timeoutMs: 45_000, intervalMs: 200, label: 'session/page to refill the empty window' })
      ctx.record(refilled.itemCount > 0, `paging out of the empty window recovered ${refilled.itemCount} items from the real host`)
      // The runner discards this page before the next scenario; there is no
      // unrouteWebSocket, so page disposal is what contains the rewrite.
      return shot
    },
  },

  {
    id: '7-paging-and-live-tail-merge',
    title: 'paging and live-tail concurrent merge',
    exercises: {
      ...REAL,
      note: 'no injection: a real session/page and a real live turn are deliberately '
        + 'overlapped against the real host, and the merged transcript is checked.',
    },
    async run(ctx) {
      const { sessionId, hasMore } = await buildLongSession(ctx, { title: 'scenario-7', turns: 30 })
      ctx.record(hasMore === true, 'the real host window is truncated, so paging is meaningful')
      await ctx.openApp()
      await ctx.selectSession(sessionId)
      const before = await ctx.waitFor(async () => {
        const store = await ctx.readStore(sessionId)
        return store.phase === 'live' && store.historyIncomplete ? store : false
      }, { timeoutMs: 45_000, intervalMs: 200, label: 'the live truncated window' })

      // Fire the older page and a live turn in the same tick so the page
      // response and fresh follow events race into the same fold rebuild.
      const pager = ctx.page.getByRole('button', { name: COPY.loadEarlier, exact: true })
      await Promise.all([
        pager.click(),
        ctx.prompt(sessionId, '并发:分页同时来一条实时事件'),
      ])

      const merged = await ctx.waitFor(async () => {
        const store = await ctx.readStore(sessionId)
        if (store.historyLoading) return false
        return store.itemCount > before.itemCount ? store : false
      }, { timeoutMs: 60_000, intervalMs: 200, label: 'the merged window to settle' })

      ctx.record(merged.itemCount > before.itemCount,
        `the merge grew the window (${before.itemCount} → ${merged.itemCount} items)`)

      // No duplication: every identified item appears once.
      const ids = merged.items.map((item) => item.id).filter((id) => id !== null)
      ctx.record(new Set(ids).size === ids.length,
        `no duplicated items after the concurrent merge (${ids.length} ids, ${new Set(ids).size} unique)`)

      // The live turn was not lost to the rebuild: its text is on screen.
      await ctx.page.getByText('并发:分页同时来一条实时事件', { exact: false }).first().waitFor({ timeout: 30_000 })
      ctx.record(true, 'the concurrent live message survived the page rebuild')

      // Ordering: turn/step pairs must be non-decreasing down the transcript.
      const positioned = merged.items.filter((item) => item.turn !== null && item.step !== null)
      const ordered = positioned.every((item, index) => index === 0
        || item.turn > positioned[index - 1].turn
        || (item.turn === positioned[index - 1].turn && item.step >= positioned[index - 1].step))
      ctx.record(ordered, `merged transcript stays seq/turn ordered across ${positioned.length} positioned items`)
      ctx.record(merged.historyLoading === false, 'the pager settled (no stuck loading state)')
      return ctx.screenshot('7-paging-and-live-tail-merge')
    },
  },

  {
    id: '8-history-evidence-does-not-leak',
    title: 'historical turn evidence does NOT leak into the latest hop',
    exercises: {
      ...REAL,
      note: 'no injection: older history is paged in from the real host and the '
        + 'current-hop position published by the real store is compared before/after.',
    },
    async run(ctx) {
      const { sessionId, hasMore } = await buildLongSession(ctx, { title: 'scenario-8', turns: 30 })
      ctx.record(hasMore === true, 'the real host window is truncated, so older turns exist to page in')
      await ctx.openApp()
      await ctx.selectSession(sessionId)

      const before = await ctx.waitFor(async () => {
        const store = await ctx.readStore(sessionId)
        return store.phase === 'live' && store.currentStep !== null ? store : false
      }, { timeoutMs: 45_000, intervalMs: 200, label: 'a current hop position from the real store' })
      ctx.record(before.currentStep !== null, `latest hop before paging: turn=${before.currentStep.turn} step=${before.currentStep.step}`)

      const positionedBefore = before.items.filter((item) => item.turn !== null)
      const maxTurnBefore = Math.max(...positionedBefore.map((item) => item.turn))
      ctx.record(before.currentStep.turn === maxTurnBefore,
        `the hop points at the newest turn in the window (${before.currentStep.turn} === ${maxTurnBefore})`)

      await ctx.page.getByRole('button', { name: COPY.loadEarlier, exact: true }).click()
      const after = await ctx.waitFor(async () => {
        const store = await ctx.readStore(sessionId)
        return !store.historyLoading && store.itemCount > before.itemCount ? store : false
      }, { timeoutMs: 60_000, intervalMs: 200, label: 'the older page to merge' })

      const oldestTurnAfter = Math.min(...after.items.filter((item) => item.turn !== null).map((item) => item.turn))
      ctx.record(oldestTurnAfter <= maxTurnBefore,
        `older turns really entered the window (oldest turn now ${oldestTurnAfter}, window ${before.itemCount} → ${after.itemCount})`)

      // The whole point: a fold rebuilt from older records must not republish an
      // older turn/step as the current hop.
      ctx.record(after.currentStep !== null, `hop after paging: turn=${after.currentStep?.turn} step=${after.currentStep?.step}`)
      ctx.record(
        after.currentStep?.turn === before.currentStep.turn && after.currentStep?.step === before.currentStep.step,
        'the current hop is unchanged by paging in historical turns',
      )
      const maxTurnAfter = Math.max(...after.items.filter((item) => item.turn !== null).map((item) => item.turn))
      ctx.record(after.currentStep?.turn === maxTurnAfter,
        `the hop still names the newest turn, not a historical one (${after.currentStep?.turn} === ${maxTurnAfter})`)

      const strip = ctx.page.locator('[aria-label="本跳证据"]')
      if (await strip.count() > 0) {
        const text = await strip.first().innerText()
        ctx.record(!/历史构建 1\b/.test(text), `the evidence strip does not name a paged-in historical turn: ${text.replace(/\s+/g, ' ').slice(0, 90)}`)
      }
      return ctx.screenshot('8-history-evidence-does-not-leak')
    },
  },
]
