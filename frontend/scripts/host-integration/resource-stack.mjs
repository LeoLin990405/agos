/**
 * A LIFO stack of live resources with in-place unwinding.
 *
 * The bug this exists for. `createHarness` started a real host, then a Vite
 * server, then a browser, and returned a context whose `dispose()` shut them
 * all down. If any stage after the first threw — Vite failing to bind, the
 * playwright module missing, Chrome refusing to launch, or the caller
 * cancelling mid-way — the throw escaped before the context object existed, so
 * the caller had no handle to dispose and every resource created up to that
 * point leaked: a real dsh host still running, a temp DSH_HOME still on disk, a
 * Chrome process still resident. "Dispose it through the returned object" only
 * works on the path where an object is returned.
 *
 * So disposal cannot live on the returned value. Each stage registers its
 * disposer the instant its resource exists; a failure at stage N unwinds
 * N-1…1 in reverse order right there, before the error is rethrown. The
 * caller's `dispose()` on the success path runs exactly the same unwind.
 *
 * Cancellation is handled the same way, since an aborted bring-up leaks
 * identically to a failed one: the signal is checked before each stage and
 * again after each stage completes, because a resource that finished
 * initialising during the abort still has to be reclaimed.
 */

/** Raised when a bring-up is cancelled; carries the stage it died at. */
export class BringUpAborted extends Error {
  constructor(stage, cause) {
    super(`host-integration: bring-up cancelled at stage "${stage}"`)
    this.name = 'BringUpAborted'
    this.stage = stage
    if (cause !== undefined) this.cause = cause
  }
}

/**
 * A promise that rejects when the signal aborts, and detaches itself when the
 * race is over so a long bring-up does not accumulate listeners.
 * @param signal - the bring-up signal.
 * @param stage - the stage being raced, for the error message.
 * @returns a never-resolving, abort-rejecting promise.
 */
function abortRace(signal, stage) {
  return new Promise((_resolve, reject) => {
    if (signal.aborted) { reject(new BringUpAborted(stage, signal.reason)); return }
    signal.addEventListener('abort', () => reject(new BringUpAborted(stage, signal.reason)), { once: true })
  })
}

/**
 * Create a resource stack for one bring-up.
 * @param options.signal - optional AbortSignal; aborting unwinds everything.
 * @param options.onUnwind - called once per disposed stage, for the evidence log.
 * @returns the stack handle.
 */
export function createResourceStack({ signal, onUnwind } = {}) {
  /** @type {{stage: string, dispose: () => unknown}[]} */
  const entries = []
  let unwinding = false
  let unwound = false

  /** Dispose everything registered, newest first. Never throws. */
  const unwindAll = async (reason) => {
    if (unwinding || unwound) return []
    unwinding = true
    const disposed = []
    while (entries.length > 0) {
      const entry = entries.pop()
      try {
        await entry.dispose()
        disposed.push({ stage: entry.stage, ok: true })
      } catch (error) {
        // One stage failing to close must not strand the stages beneath it.
        disposed.push({ stage: entry.stage, ok: false, error: String(error?.message ?? error) })
      }
      onUnwind?.(disposed[disposed.length - 1], reason)
    }
    unwinding = false
    unwound = true
    return disposed
  }

  const checkAborted = async (stage) => {
    if (signal?.aborted !== true) return
    await unwindAll(`aborted at ${stage}`)
    throw new BringUpAborted(stage, signal.reason)
  }

  return {
    /** Stages currently holding a live resource, oldest first. */
    stages() { return entries.map((entry) => entry.stage) },

    /** True once the stack has been unwound. */
    get isUnwound() { return unwound },

    /**
     * Register a disposer for a resource that already exists.
     * @param stage - label used in the evidence log.
     * @param dispose - idempotent disposer.
     */
    adopt(stage, dispose) {
      entries.push({ stage, dispose })
    },

    /**
     * Run one bring-up stage.
     *
     * `acquire` receives a `register(stage, dispose)` callback so a stage that
     * creates several things (or fails halfway through creating them) can hand
     * each one over the moment it exists, rather than only on success.
     *
     * Three ways a stage ends, all of which have to reclaim what came before:
     * it throws, it is cancelled while running, or it never finishes at all. A
     * HUNG stage is the awkward one — waiting for it would hold every earlier
     * resource for the length of the hang — so the abort is raced against it
     * and the unwind runs immediately. Whatever the abandoned stage eventually
     * produces is disposed when it arrives, so even a late resource is
     * reclaimed rather than leaked.
     * @param stage - label for this stage.
     * @param acquire - async factory returning `{ value, dispose }`.
     * @returns the stage's value.
     */
    async use(stage, acquire) {
      await checkAborted(stage)
      const pending = (async () => acquire((subStage, dispose) => entries.push({ stage: subStage, dispose })))()
      // The stage's own rejection is handled below; this keeps the abandoned
      // branch from surfacing as an unhandled rejection.
      pending.catch(() => undefined)

      let created
      try {
        created = signal === undefined ? await pending : await Promise.race([pending, abortRace(signal, stage)])
      } catch (error) {
        if (signal?.aborted === true) {
          // Reclaim whatever the abandoned stage hands back later.
          void pending.then(
            (late) => { if (typeof late?.dispose === 'function') Promise.resolve(late.dispose()).catch(() => undefined) },
            () => undefined,
          )
        }
        await unwindAll(`failed at ${stage}`)
        throw error
      }
      if (typeof created?.dispose === 'function') entries.push({ stage, dispose: created.dispose })
      // The abort may have landed WHILE this stage was initialising. Its
      // disposer is registered now, so unwinding still reclaims it.
      await checkAborted(stage)
      return created?.value
    },

    /** Unwind everything (the success path's dispose is this same call). */
    unwindAll,
  }
}

/**
 * Combine an optional caller signal with a bring-up deadline.
 *
 * A bring-up that hangs (a host that never prints its launch URL, a browser
 * that never answers) leaks exactly like one that throws, so the timeout has
 * to reach the same unwinding path rather than leaving the caller to wait.
 * @param options.signal - the caller's signal, if any.
 * @param options.timeoutMs - deadline for the whole bring-up.
 * @returns the derived signal and a disposer that clears the timer.
 */
export function bringUpSignal({ signal, timeoutMs } = {}) {
  const controller = new AbortController()
  const forward = () => controller.abort(signal?.reason ?? new Error('bring-up cancelled by caller'))
  if (signal?.aborted === true) forward()
  signal?.addEventListener?.('abort', forward, { once: true })
  const timer = typeof timeoutMs === 'number' && timeoutMs > 0
    ? setTimeout(() => controller.abort(new Error(`bring-up exceeded ${timeoutMs}ms`)), timeoutMs)
    : undefined
  timer?.unref?.()
  return {
    signal: controller.signal,
    release() {
      if (timer !== undefined) clearTimeout(timer)
      signal?.removeEventListener?.('abort', forward)
    },
  }
}
