// AgOS memory desk: confirm-gated promote/void ledger. Not Fleet Memory.
import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const DESK_COPY = '只写入 AgOS 甲板账本，未写入 Fleet Memory 真源'
export const CIV_UNAVAILABLE_COPY = '宿主 civ memory_submit 未接线，未写入 Fleet Memory'
export const CIV_SUBMITTED_COPY = 'civ memory_submit 已接受，本条已进 Fleet Memory'
export const SLUG_RE = /^[a-z0-9]+(?:[_-][a-z0-9]+)*$/
export const FLEET_SLUG_RE = /^(user|feedback|project|reference|incident)_[a-z0-9]+(?:[_-][a-z0-9]+)*$/
const KINDS = new Set(['fact', 'constraint', 'preference', 'rejected'])
const FLEET_TYPES = new Set(['user', 'feedback', 'project', 'reference'])

function deskDir(home = homedir()) {
  return join(home, '.dsh', 'agos', 'memory-desk')
}

function promotePath(home) {
  return join(deskDir(home), 'promote.jsonl')
}

function voidPath(home) {
  return join(deskDir(home), 'void.jsonl')
}

function submitPath(home) {
  return join(deskDir(home), 'submit.jsonl')
}

export function normalizeDeskSlug(raw) {
  return String(raw ?? '')
    .trim()
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
}

async function readJsonl(path) {
  try {
    const raw = await readFile(path, 'utf8')
    const rows = []
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue
      try {
        const obj = JSON.parse(line)
        if (obj && typeof obj === 'object') rows.push(obj)
      } catch { /* skip broken line */ }
    }
    return rows
  } catch (error) {
    if (error && error.code === 'ENOENT') return []
    throw error
  }
}

export async function listMemoryDesk(options = {}) {
  const home = options.home ?? homedir()
  const [promotes, voids, submits] = await Promise.all([
    readJsonl(promotePath(home)),
    readJsonl(voidPath(home)),
    readJsonl(submitPath(home)),
  ])
  return {
    writtenTo: 'agos-desk',
    fleetMemory: false,
    copy: DESK_COPY,
    civAvailable: options.civAvailable === true || options.civAvailable === false
      ? options.civAvailable
      : undefined,
    promotes,
    voids,
    submits,
    promoteCount: promotes.length,
    voidCount: voids.length,
    submitCount: submits.length,
  }
}

export async function writeMemoryDesk(input, options = {}) {
  if (!input || input.confirm !== true) {
    return { ok: false, status: 400, code: 'CONFIRM_REQUIRED', error: '甲板记忆写入需要 confirm:true' }
  }
  const home = options.home ?? homedir()
  const now = typeof options.now === 'function' ? options.now() : new Date()
  const at = now.toISOString()

  if (input.action === 'promote') {
    const text = String(input.text ?? '').replace(/\s+/g, ' ').trim()
    const kind = String(input.kind ?? '')
    const sessionId = String(input.sessionId ?? '').trim()
    const itemId = String(input.itemId ?? '').trim()
    if (text === '' || [...text].length > 200) {
      return { ok: false, status: 400, code: 'INVALID_TEXT', error: '晋升正文未采集或超过 200 码点' }
    }
    if (!KINDS.has(kind)) {
      return { ok: false, status: 400, code: 'INVALID_KIND', error: 'kind 必须是 fact、constraint、preference 或 rejected' }
    }
    if (sessionId === '' || itemId === '') {
      return { ok: false, status: 400, code: 'INVALID_SOURCE', error: 'sessionId 与 itemId 未采集' }
    }
    const row = {
      kind: 'promote',
      at,
      sessionId,
      itemId,
      memoryKind: kind,
      text,
      writtenTo: 'agos-desk',
      fleetMemory: false,
    }
    await mkdir(deskDir(home), { recursive: true, mode: 0o700 })
    await appendFile(promotePath(home), JSON.stringify(row) + '\n', { mode: 0o600 })
    return { ok: true, recorded: row, copy: DESK_COPY }
  }

  if (input.action === 'void') {
    const raw = String(input.slug ?? '')
    if (raw.includes('/') || raw.includes('\\') || raw.includes('..')) {
      return { ok: false, status: 400, code: 'INVALID_SLUG', error: 'slug 必须是安全的记忆短名' }
    }
    const slug = normalizeDeskSlug(raw)
    if (!SLUG_RE.test(slug)) {
      return { ok: false, status: 400, code: 'INVALID_SLUG', error: 'slug 必须是安全的记忆短名' }
    }
    const row = {
      kind: 'void',
      at,
      slug,
      writtenTo: 'agos-desk',
      fleetMemory: false,
    }
    await mkdir(deskDir(home), { recursive: true, mode: 0o700 })
    await appendFile(voidPath(home), JSON.stringify(row) + '\n', { mode: 0o600 })
    return { ok: true, recorded: row, copy: DESK_COPY }
  }

  if (input.action === 'submit') {
    return submitDeskToCiv(input, { ...options, home, now: () => now, at })
  }

  return { ok: false, status: 400, code: 'INVALID_ACTION', error: 'action 只能是 promote、void 或 submit' }
}

export async function submitDeskToCiv(input, options = {}) {
  if (!input || input.confirm !== true) {
    return { ok: false, status: 400, code: 'CONFIRM_REQUIRED', error: '送真源需要 confirm:true' }
  }
  const invoke = options.invokeMemorySubmit
  if (typeof invoke !== 'function') {
    return { ok: false, status: 503, code: 'CIV_UNAVAILABLE', fleetMemory: false, copy: CIV_UNAVAILABLE_COPY }
  }
  const slug = String(input.slug ?? '').trim()
  const type = String(input.type ?? '').trim()
  const description = String(input.description ?? '').replace(/\s+/g, ' ').trim()
  const body = String(input.body ?? '').trim()
  if (!FLEET_SLUG_RE.test(slug)) {
    return { ok: false, status: 400, code: 'INVALID_SLUG', error: 'slug 必须以 user_/feedback_/project_/reference_/incident_ 开头' }
  }
  if (!FLEET_TYPES.has(type)) {
    return { ok: false, status: 400, code: 'INVALID_TYPE', error: 'type 必须是 user、feedback、project 或 reference' }
  }
  if (description === '' || [...description].length > 200) {
    return { ok: false, status: 400, code: 'INVALID_DESCRIPTION', error: 'description 未采集或超过 200 字' }
  }
  if (body === '') {
    return { ok: false, status: 400, code: 'INVALID_BODY', error: '正文未采集' }
  }
  let civ
  try {
    civ = await invoke({
      slug,
      type,
      description,
      body,
      links: Array.isArray(input.links) ? input.links.filter((item) => typeof item === 'string') : undefined,
      mode: input.mode === 'update' || input.mode === 'supersede' ? input.mode : 'create',
      supersedes: typeof input.supersedes === 'string' ? input.supersedes : undefined,
    })
  } catch (error) {
    return {
      ok: false,
      status: 502,
      code: 'CIV_REJECTED',
      fleetMemory: false,
      copy: CIV_UNAVAILABLE_COPY,
      error: error instanceof Error ? error.message : String(error),
    }
  }
  if (!civ || civ.ok !== true) {
    return {
      ok: false,
      status: 502,
      code: 'CIV_REJECTED',
      fleetMemory: false,
      copy: 'civ memory_submit 拒绝写入，甲板仍不是 Fleet Memory',
      civ,
    }
  }
  const home = options.home ?? homedir()
  const at = typeof options.at === 'string' ? options.at : (typeof options.now === 'function' ? options.now() : new Date()).toISOString()
  const row = {
    kind: 'submit',
    at,
    slug,
    type,
    sessionId: typeof input.sessionId === 'string' ? input.sessionId.trim() : undefined,
    itemId: typeof input.itemId === 'string' ? input.itemId.trim() : undefined,
    writtenTo: 'civ-memory-submit',
    fleetMemory: true,
  }
  await mkdir(deskDir(home), { recursive: true, mode: 0o700 })
  await appendFile(submitPath(home), JSON.stringify(row) + '\n', { mode: 0o600 })
  return { ok: true, recorded: row, copy: CIV_SUBMITTED_COPY, fleetMemory: true }
}

export function deskVoidedSlugs(voids) {
  return new Set((Array.isArray(voids) ? voids : [])
    .map((row) => typeof row?.slug === 'string' ? row.slug : '')
    .filter(Boolean))
}

function toolName(entry) {
  if (typeof entry === 'string') return entry
  if (entry && typeof entry.name === 'string') return entry.name
  if (entry && typeof entry.id === 'string') return entry.id
  return ''
}

function listToolNames(tools) {
  if (typeof tools.list === 'function') {
    try {
      const listed = tools.list()
      if (Array.isArray(listed)) return listed.map(toolName).filter(Boolean)
    } catch { /* absence stays uncollected */ }
  }
  if (Array.isArray(tools.names)) return tools.names.filter((name) => typeof name === 'string')
  return []
}

/**
 * Civ is available only when memory_submit is actually present.
 * A generic tools.invoke() is not evidence the tool exists.
 */
export function resolveMemorySubmitInvoker(tools) {
  if (!tools || typeof tools !== 'object') return undefined
  if (typeof tools.get === 'function') {
    let found
    try { found = tools.get('memory_submit') } catch { found = undefined }
    if (found && typeof found.execute === 'function') {
      return (args) => found.execute(args)
    }
    if (typeof found === 'function') {
      return (args) => found(args)
    }
    return undefined
  }
  const named = listToolNames(tools)
  const listed = named.includes('memory_submit')
  const has = typeof tools.has === 'function' ? tools.has('memory_submit') === true : false
  if ((listed || has) && typeof tools.invoke === 'function') {
    return (args) => tools.invoke('memory_submit', args)
  }
  return undefined
}
