/**
 * In-process probe for Fleet local (`kind === 'local'`) runs.
 *
 * This process's registry / live controller is the only evidence that a local
 * subagent is still executing. After a plugin or process restart those handles
 * are gone; the durable row is an unrecoverable orphan and must probe MISSING
 * (runtime maps that to `lost`) instead of remaining detached forever.
 *
 * Controller wiring (`plugins/dsh-fleet/lib/index.js` `probeRun`):
 *   import { probeLocalRun } from './local-probe.mjs'
 *   if (host.kind === 'local') return probeLocalRun({ run, liveSet: LIVE_RUNS })
 *
 * Optional extras if the starting window should also look live at the probe
 * layer (runtime already treats markStart as held):
 *   probeLocalRun({
 *     run,
 *     liveSet: LIVE_RUNS,
 *     controllerLookup: () => STARTING_RUNS.has(run.runId),
 *   })
 *
 * `afterRestart: true` ignores reconstructed AbortControllers and only trusts
 * `liveSet`. Pass it on hydrate/recovery probes so a new controller map cannot
 * keep historical local work reserved.
 */

const text = (value) => typeof value === 'string' ? value : String(value ?? '')

function heldByLiveSet(liveSet, run) {
  if (!liveSet || !run) return false
  const runId = text(run.runId)
  if (!runId) return false
  if (typeof liveSet === 'function') {
    try { return liveSet(run) === true } catch { return false }
  }
  if (typeof liveSet.has === 'function') {
    try { return liveSet.has(runId) === true } catch { return false }
  }
  return false
}

function heldByController(controllerLookup, run, afterRestart) {
  if (afterRestart || typeof controllerLookup !== 'function' || !run) return false
  try { return controllerLookup(run) === true } catch { return false }
}

export function probeLocalRun({ run, liveSet, controllerLookup, afterRestart } = {}) {
  const runId = text(run?.runId)
  if (!runId) return { ok: true, out: 'MISSING' }
  if (heldByLiveSet(liveSet, run) || heldByController(controllerLookup, run, afterRestart === true)) {
    return { ok: true, out: 'ALIVE' }
  }
  return { ok: true, out: 'MISSING' }
}
