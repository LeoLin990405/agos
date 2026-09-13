// Last pre-step evidence. Absence stays uncollected. Never invents zeros.
// Persist ≠ observe: a memory hit after a disk failure is not on-disk evidence.
import { appendFileSync, closeSync, existsSync, fstatSync, fsyncSync, mkdirSync, openSync, readFileSync, readSync, writeSync } from 'node:fs'
import { dirname, join } from 'node:path'

export const TURN_UNCOLLECTED_COPY = '本跳未采集'
export const TURN_COLLECTED_COPY = '本跳已记录 pre-step 投影'
export const MEMORY_UNCOLLECTED_COPY = '本跳回注未采集'
export const SKILLS_UNCOLLECTED_COPY = '本跳技能目录未采集'
export const PLUGINS_UNCOLLECTED_COPY = '当前进程未采集'

export const PERSIST_DISK = 'disk'
export const PERSIST_MEMORY = 'memory'
export const PERSIST_FAILED = 'failed'

function hasOwn(object, key) {
  return object != null && Object.prototype.hasOwnProperty.call(object, key)
}

function hostScalar(value) {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value
  if (typeof value === 'string' && value.trim() !== '') return value.trim()
  return null
}

function bindKey(sessionId, turn, step) {
  if (turn == null && step == null) return null
  return `${sessionId}\0${turn == null ? '' : String(turn)}\0${step == null ? '' : String(step)}`
}

function persistErrorCode(err) {
  if (err && typeof err.code === 'string' && err.code) return err.code
  if (err && typeof err.message === 'string' && err.message.trim() !== '') return err.message.trim()
  return 'PERSIST_FAILED'
}

/**
 * Append one complete `\n`-terminated record without gluing it onto a possible
 * crash fragment. A crash mid-append can leave the file without a trailing
 * newline; a plain append then concatenates our record onto the fragment and
 * BOTH lines fail to reload — while record() would have reported persisted.
 * The fix is write-side only: inspect the last byte and insert a separator
 * first. The fragment itself is never repaired or re-searched for JSON —
 * recovery from fragments would be inventing evidence (read side stays
 * "unparseable line = uncollected", see parseEvidenceLine).
 * If the tail cannot be inspected (and the file exists), the write is refused
 * with the real error instead of appending blindly — an append we could not
 * prove to be safely separated must not report persisted:true.
 *
 * Concurrency boundary: the tail check and the append are not atomic. If
 * another writer appends a complete line in between, we may add one extra
 * blank line — harmless, blank lines are skipped on load. The reverse window
 * (another writer crashes mid-append between our check and our append) can
 * still glue lines; that exposure predates this fix, each append is a single
 * write(2) so the window is narrow, and the next write's tail check separates
 * again after at most one lost line.
 */
function appendRecordLine(ledgerPath, line, fsync) {
  let prefix = ''
  let fd
  try {
    fd = openSync(ledgerPath, 'r')
  } catch (err) {
    if (!(err && err.code === 'ENOENT')) throw err
    // No file yet: nothing to separate from.
  }
  if (fd !== undefined) {
    try {
      const { size } = fstatSync(fd)
      if (size > 0) {
        const tail = Buffer.alloc(1)
        const read = readSync(fd, tail, 0, 1, size - 1)
        if (read !== 1) throw new Error('PERSIST_TAIL_UNREADABLE')
        if (tail[0] !== 0x0a) prefix = '\n'
      }
    } finally {
      closeSync(fd)
    }
  }
  // Plain appendFileSync only guarantees the write is visible to other
  // processes (kernel page cache): it survives a process crash, NOT a power
  // loss. The fsync option upgrades the same write to stable storage. It is
  // opt-in because it costs one device flush per pre-step row on a hot path.
  if (!fsync) {
    appendFileSync(ledgerPath, `${prefix}${line}\n`, { mode: 0o600 })
    return
  }
  const payload = Buffer.from(`${prefix}${line}\n`, 'utf8')
  let appendFd
  try {
    appendFd = openSync(ledgerPath, 'a', 0o600)
    // write(2) may write fewer bytes than requested (signal, ENOSPC edge).
    // A partial write followed by fsyncSync would be exactly the "half line
    // reported persisted" failure this module forbids — loop until drained.
    let written = 0
    while (written < payload.length) {
      const chunk = writeSync(appendFd, payload, written, payload.length - written)
      if (chunk === 0) throw new Error('PERSIST_WRITE_ZERO')
      written += chunk
    }
    fsyncSync(appendFd)
  } finally {
    if (appendFd !== undefined) closeSync(appendFd)
  }
}

/** Host-provable session/turn/step only. Missing stays null — never invents a sequence. */
export function resolveHostTurnBind(event) {
  if (!event || typeof event !== 'object') {
    return { sessionId: '', turn: null, step: null, bound: false }
  }
  const agent = event.agent
  const session = event.session
  let sessionId = ''
  if (agent && typeof agent.id === 'string' && agent.id.trim() !== '') sessionId = agent.id.trim()
  else if (typeof event.sessionId === 'string' && event.sessionId.trim() !== '') sessionId = event.sessionId.trim()
  else if (typeof event.agentId === 'string' && event.agentId.trim() !== '') sessionId = event.agentId.trim()
  else if (session && typeof session.id === 'string' && session.id.trim() !== '') sessionId = session.id.trim()
  const turn = hostScalar(event.turn)
    ?? hostScalar(event.turnId)
    ?? hostScalar(agent && agent.turn)
    ?? hostScalar(session && session.turn)
  const step = hostScalar(event.step)
    ?? hostScalar(event.stepId)
    ?? hostScalar(event.stepName)
    ?? hostScalar(agent && agent.step)
  return {
    sessionId,
    turn,
    step,
    bound: sessionId !== '' && (turn != null || step != null),
  }
}

export function bindEvidencePatch(patch, event) {
  const bind = resolveHostTurnBind(event)
  const next = patch && typeof patch === 'object' ? { ...patch } : {}
  if (bind.turn != null) next.turn = bind.turn
  if (bind.step != null) next.step = bind.step
  return next
}

function parseEvidenceLine(line) {
  if (typeof line !== 'string' || line.trim() === '') return null
  let obj
  try { obj = JSON.parse(line) } catch { return null }
  if (!obj || typeof obj.sessionId !== 'string' || obj.sessionId.trim() === '') return null
  const sessionId = obj.sessionId.trim()
  const { sessionId: _ignored, persist: _persist, persisted: _persisted, persistError: _err, durable: _durable, ...rest } = obj
  const turn = hostScalar(obj.turn)
  const step = hostScalar(obj.step)
  const row = { ...rest }
  if (turn != null) row.turn = turn
  else delete row.turn
  if (step != null) row.step = step
  else delete row.step
  // Loaded from disk: historical rows missing persist fields are durable, not invented.
  row.persist = PERSIST_DISK
  row.persisted = true
  row.durable = true
  return { sessionId, row }
}

function rememberRow(bySession, byBind, sessionId, row) {
  bySession.set(sessionId, row)
  const key = bindKey(sessionId, row.turn, row.step)
  if (key !== null) byBind.set(key, row)
}

function lookupRow(bySession, byBind, sessionId, bind) {
  const turn = hostScalar(bind && bind.turn)
  const step = hostScalar(bind && bind.step)
  if (turn != null || step != null) {
    return byBind.get(bindKey(sessionId, turn, step))
  }
  return bySession.get(sessionId)
}

export function createTurnEvidenceStore(options = {}) {
  const bySession = new Map()
  const byBind = new Map()
  const ledgerPath = options.ledgerPath
    ?? (options.home ? join(options.home, '.dsh', 'agos', 'turn-evidence.jsonl') : null)
  // fsync is opt-in: see appendRecordLine for what the default does and does
  // NOT guarantee (process-crash visibility vs power-loss durability).
  const fsync = options.fsync === true

  if (ledgerPath && existsSync(ledgerPath)) {
    let text = ''
    try { text = readFileSync(ledgerPath, 'utf8') } catch { text = '' }
    for (const line of text.split('\n')) {
      const parsed = parseEvidenceLine(line)
      if (parsed !== null) rememberRow(bySession, byBind, parsed.sessionId, parsed.row)
    }
  }

  return {
    ledgerPath,
    record(sessionId, patch, at = new Date(), bind) {
      const id = typeof sessionId === 'string' ? sessionId.trim() : ''
      if (id === '' || !patch || typeof patch !== 'object') {
        return { observed: false, persisted: false }
      }
      const turn = hostScalar(bind && bind.turn) ?? hostScalar(patch.turn)
      const step = hostScalar(bind && bind.step) ?? hostScalar(patch.step)
      const previous = (turn != null || step != null)
        ? (byBind.get(bindKey(id, turn, step)) ?? {})
        : (bySession.get(id) ?? {})
      const next = {
        ...previous,
        ...patch,
        memory: hasOwn(patch, 'memory') ? patch.memory : previous.memory,
        skills: hasOwn(patch, 'skills') ? patch.skills : previous.skills,
        at: at && typeof at.toISOString === 'function' ? at.toISOString() : new Date().toISOString(),
      }
      delete next.persistError
      if (turn != null) next.turn = turn
      else delete next.turn
      if (step != null) next.step = step
      else delete next.step
      if (ledgerPath) {
        try {
          mkdirSync(dirname(ledgerPath), { recursive: true, mode: 0o700 })
          const diskRow = { sessionId: id, ...next, persist: PERSIST_DISK, persisted: true, durable: true }
          delete diskRow.persistError
          appendRecordLine(ledgerPath, JSON.stringify(diskRow), fsync)
          // durable here means "written to the ledger file, reloadable by the
          // next process". It does NOT mean power-loss stable storage — that
          // requires the opt-in fsync option (see appendRecordLine).
          next.persist = PERSIST_DISK
          next.persisted = true
          next.durable = true
        } catch (err) {
          next.persist = PERSIST_FAILED
          next.persisted = false
          next.durable = false
          next.persistError = persistErrorCode(err)
        }
      } else {
        next.persist = PERSIST_MEMORY
        next.persisted = false
        next.durable = false
      }
      rememberRow(bySession, byBind, id, next)
      const result = { observed: true, persisted: next.persist === PERSIST_DISK }
      if (next.persistError) result.persistError = next.persistError
      return result
    },
    get(sessionId, bind) {
      const id = typeof sessionId === 'string' ? sessionId.trim() : ''
      if (id === '') return undefined
      return lookupRow(bySession, byBind, id, bind)
    },
  }
}

function memoryView(row) {
  if (!row || !row.memory) {
    return { collected: false, enabled: null, prepended: null, itemCount: null, copy: MEMORY_UNCOLLECTED_COPY }
  }
  const memory = row.memory
  const enabled = memory.enabled === true
  const prepended = Number.isSafeInteger(memory.prepended) ? memory.prepended : null
  const itemCount = Number.isSafeInteger(memory.itemCount) ? memory.itemCount : null
  const method = memory.method === 'lexical+posterior' || memory.method === 'importance-recency'
    ? memory.method
    : null
  const served = Array.isArray(memory.served)
    ? memory.served.filter((id) => typeof id === 'string' && id.trim() !== '')
    : null
  const impressions = Array.isArray(memory.impressions)
    ? memory.impressions.flatMap((row) => {
      if (!row || typeof row !== 'object') return []
      const text = typeof row.text === 'string' ? row.text.trim() : ''
      if (text === '') return []
      const method = row.method === 'lexical+posterior'
        || row.method === 'importance-recency'
        || row.method === 'constraint-reserve'
        ? row.method
        : null
      return [{
        id: typeof row.id === 'string' ? row.id : '',
        kind: typeof row.kind === 'string' ? row.kind : '',
        text,
        ...(method ? { method } : {}),
      }]
    })
    : null
  const query = typeof memory.query === 'string' ? memory.query : null
  const reserved = memory.reserved === true
  let copy = MEMORY_UNCOLLECTED_COPY
  if (memory.enabled === false) copy = '回注未启用：本跳没有 prepend'
  else if (typeof memory.copy === 'string' && memory.copy.trim() !== '') copy = memory.copy
  else if (enabled && prepended === 0) copy = '回注已启用，本跳 prepend 0 条'
  else if (enabled && method === 'lexical+posterior' && prepended !== null && itemCount !== null) {
    copy = `本跳回注 ${prepended}/${itemCount} · 词面短名单`
  } else if (enabled && prepended !== null) copy = `本跳回注 ${prepended} 条`
  return {
    collected: true,
    enabled: memory.enabled === true || memory.enabled === false ? memory.enabled : null,
    prepended,
    itemCount,
    method,
    served,
    impressions,
    reserved: enabled ? reserved : null,
    query,
    copy,
  }
}

function skillsView(row) {
  if (!row || !row.skills) {
    return { collected: false, trimmed: null, served: null, query: null, copy: SKILLS_UNCOLLECTED_COPY }
  }
  const skills = row.skills
  const served = Array.isArray(skills.served)
    ? skills.served.filter((name) => typeof name === 'string' && name.trim() !== '')
    : null
  let copy = SKILLS_UNCOLLECTED_COPY
  if (skills.query === '') copy = '本跳没有可裁剪的用户问句'
  else if (skills.trimmed === true && served) copy = `本跳进模型 ${served.length} 个技能`
  else if (skills.trimmed === false) copy = skills.copy ?? '本跳没有技能目录消息'
  return {
    collected: true,
    trimmed: skills.trimmed === true || skills.trimmed === false ? skills.trimmed : null,
    served,
    query: typeof skills.query === 'string' ? skills.query : null,
    copy,
  }
}

function displayCollected(row) {
  return row !== undefined && row.persist !== PERSIST_FAILED
}

export function describeTurnEvidence(sessionId, store, plugins, bind) {
  const id = typeof sessionId === 'string' ? sessionId.trim() : ''
  const queryTurn = hostScalar(bind && bind.turn)
  const queryStep = hostScalar(bind && bind.step)
  const row = id === '' || !store || typeof store.get !== 'function'
    ? undefined
    : store.get(id, bind)
  const collected = displayCollected(row)
  const display = collected ? row : undefined
  const persistFailed = row !== undefined && row.persist === PERSIST_FAILED
  const view = {
    sessionId: id,
    at: row && typeof row.at === 'string' ? row.at : null,
    collected,
    observed: row !== undefined,
    persisted: row !== undefined && row.persist === PERSIST_DISK,
    durable: row !== undefined && row.persist === PERSIST_DISK,
    turn: queryTurn ?? (row && row.turn != null ? row.turn : null),
    step: queryStep ?? (row && row.step != null ? row.step : null),
    copy: collected ? TURN_COLLECTED_COPY : TURN_UNCOLLECTED_COPY,
    memory: memoryView(display),
    skills: skillsView(display),
    plugins: {
      collected: profileCollected(plugins),
      profile: pluginProfile(plugins),
      agosLoaded: pluginAgosLoaded(plugins),
      copy: pluginCopy(plugins),
    },
  }
  if (persistFailed) view.persistError = row.persistError ?? 'PERSIST_FAILED'
  return view
}

function pluginProfile(plugins) {
  return plugins && (plugins.currentProcess === 'web' || plugins.currentProcess === 'desktop')
    ? plugins.currentProcess
    : null
}

function profileCollected(plugins) {
  return pluginProfile(plugins) !== null
}

function pluginAgosLoaded(plugins) {
  const profile = pluginProfile(plugins)
  const profileRow = profile && Array.isArray(plugins?.profiles)
    ? plugins.profiles.find((item) => item && item.name === profile)
    : undefined
  return profileRow && Array.isArray(profileRow.plugins)
    ? profileRow.plugins.filter((item) => item && item.kind === 'agos').map((item) => item.id)
    : null
}

function pluginCopy(plugins) {
  const profile = pluginProfile(plugins)
  return profile ? `当前进程 ${profile}` : PLUGINS_UNCOLLECTED_COPY
}
