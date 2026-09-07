// Last pre-step evidence. Absence stays uncollected. Never invents zeros.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export const TURN_UNCOLLECTED_COPY = '本跳未采集'
export const TURN_COLLECTED_COPY = '本跳已记录 pre-step 投影'
export const MEMORY_UNCOLLECTED_COPY = '本跳回注未采集'
export const SKILLS_UNCOLLECTED_COPY = '本跳技能目录未采集'
export const PLUGINS_UNCOLLECTED_COPY = '当前进程未采集'

function hasOwn(object, key) {
  return object != null && Object.prototype.hasOwnProperty.call(object, key)
}

function parseEvidenceLine(line) {
  if (typeof line !== 'string' || line.trim() === '') return null
  let obj
  try { obj = JSON.parse(line) } catch { return null }
  if (!obj || typeof obj.sessionId !== 'string' || obj.sessionId.trim() === '') return null
  const sessionId = obj.sessionId.trim()
  const { sessionId: _ignored, ...row } = obj
  return { sessionId, row }
}

export function createTurnEvidenceStore(options = {}) {
  const bySession = new Map()
  const ledgerPath = options.ledgerPath
    ?? (options.home ? join(options.home, '.dsh', 'agos', 'turn-evidence.jsonl') : null)

  if (ledgerPath && existsSync(ledgerPath)) {
    let text = ''
    try { text = readFileSync(ledgerPath, 'utf8') } catch { text = '' }
    for (const line of text.split('\n')) {
      const parsed = parseEvidenceLine(line)
      if (parsed !== null) bySession.set(parsed.sessionId, parsed.row)
    }
  }

  return {
    ledgerPath,
    record(sessionId, patch, at = new Date()) {
      const id = typeof sessionId === 'string' ? sessionId.trim() : ''
      if (id === '' || !patch || typeof patch !== 'object') return
      const previous = bySession.get(id) ?? {}
      const next = {
        ...previous,
        ...patch,
        memory: hasOwn(patch, 'memory') ? patch.memory : previous.memory,
        skills: hasOwn(patch, 'skills') ? patch.skills : previous.skills,
        at: at.toISOString(),
      }
      bySession.set(id, next)
      if (ledgerPath) {
        try {
          mkdirSync(dirname(ledgerPath), { recursive: true, mode: 0o700 })
          appendFileSync(ledgerPath, `${JSON.stringify({ sessionId: id, ...next })}\n`, { mode: 0o600 })
        } catch {
          // In-memory row stays; persist failure is not a collected turn.
        }
      }
    },
    get(sessionId) {
      const id = typeof sessionId === 'string' ? sessionId.trim() : ''
      if (id === '') return undefined
      return bySession.get(id)
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

export function describeTurnEvidence(sessionId, store, plugins) {
  const id = typeof sessionId === 'string' ? sessionId.trim() : ''
  const row = id === '' || !store || typeof store.get !== 'function' ? undefined : store.get(id)
  const profile = plugins && (plugins.currentProcess === 'web' || plugins.currentProcess === 'desktop')
    ? plugins.currentProcess
    : null
  const profileRow = profile && Array.isArray(plugins?.profiles)
    ? plugins.profiles.find((item) => item && item.name === profile)
    : undefined
  const agosLoaded = profileRow && Array.isArray(profileRow.plugins)
    ? profileRow.plugins.filter((item) => item && item.kind === 'agos').map((item) => item.id)
    : null
  return {
    sessionId: id,
    at: row && typeof row.at === 'string' ? row.at : null,
    collected: row !== undefined,
    copy: row ? TURN_COLLECTED_COPY : TURN_UNCOLLECTED_COPY,
    memory: memoryView(row),
    skills: skillsView(row),
    plugins: {
      collected: profile !== null,
      profile,
      agosLoaded,
      copy: profile ? `当前进程 ${profile}` : PLUGINS_UNCOLLECTED_COPY,
    },
  }
}
