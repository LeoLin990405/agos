// Skill self-evolution: FuguNano Beta-Bernoulli + lexical bench.
// Outcomes are operator (or later session) verdicts. skill() calls are not ok/fail.
// Small-model rerank is opt-in and fail-closed. Catalog trim is fail-closed.
import { existsSync, readFileSync } from 'node:fs'
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import {
  ALLOCATE_KAPPA,
  ALLOCATE_POSTERIOR_COPY,
  ALLOCATE_UNLISTED_PRIOR,
  betaPrior,
  posteriorMean,
} from './allocate-kernel.js'
import { SKILL_RERANK_SYSTEM } from './agent-prompts.js'

export const EVOLVE_KAPPA = ALLOCATE_KAPPA
export const EVOLVE_UNLISTED_PRIOR = ALLOCATE_UNLISTED_PRIOR
export const SHORTLIST_K = 8
export const LEXICAL_METHOD = 'lexical-overlap'
export const POSTERIOR_METHOD_COPY = ALLOCATE_POSTERIOR_COPY
export const CALL_IS_NOT_VERDICT_COPY = 'skill() 调用不是胜负'
export const CATALOG_TRIM_OFF_COPY = '本跳目录裁剪未启用：宿主仍注入全量 catalog'
export const CATALOG_TRIM_ON_COPY = '本跳目录按短名单替换，失败回退全量'
export const RERANK_UNAVAILABLE_COPY = '小模型重排未采集：宿主没有推荐接口'
export const RERANK_FAIL_CLOSED_COPY = '小模型提案失败，已回退词面+后验'
export const RERANK_OPT_IN_COPY = '小模型只提案短名单，不写路由账本'
export { SKILL_RERANK_SYSTEM, betaPrior, posteriorMean }
export const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export function normalizeEvolveLabel(value) {
  const folded = String(value ?? '')
    .toLocaleLowerCase()
    .trim()
    .replace(/[^a-z0-9\u3400-\u9fff]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return folded === '' ? 'unlabeled' : folded
}

export function tokenize(text) {
  const lower = String(text ?? '').toLocaleLowerCase()
  const tokens = new Set()
  for (const word of lower.match(/[a-z0-9]+/g) ?? []) {
    if (word.length >= 2) tokens.add(word)
  }
  for (const run of lower.match(/[\u3400-\u9fff]+/g) ?? []) {
    for (const char of run) tokens.add(char)
    for (let index = 0; index < run.length - 1; index += 1) {
      tokens.add(run.slice(index, index + 2))
    }
  }
  return [...tokens]
}

export function lexicalOverlap(query, document) {
  const queryTokens = tokenize(query)
  if (queryTokens.length === 0) return 0
  const documentTokens = new Set(tokenize(document))
  let hit = 0
  for (const token of queryTokens) {
    if (documentTokens.has(token)) hit += 1
  }
  return hit / queryTokens.length
}

export function skillDocument(entry) {
  return [entry?.name, entry?.description, entry?.whenToUse, entry?.category].filter(Boolean).join('\n')
}

export function shortlistSkills(catalog, query, limit = SHORTLIST_K) {
  const needle = String(query ?? '').replace(/\s+/g, ' ').trim()
  if (needle === '') return []
  return (Array.isArray(catalog) ? catalog : [])
    .map((entry) => ({
      name: entry.name,
      score: lexicalOverlap(needle, skillDocument(entry)),
      method: LEXICAL_METHOD,
    }))
    .filter((row) => row.score > 0)
    .sort((left, right) => right.score - left.score || left.name.localeCompare(right.name))
    .slice(0, limit)
}

export function evidenceFor(state, label, skill) {
  let s = 0
  let f = 0
  for (const row of state) {
    if (row.label !== label || row.skill !== skill) continue
    if (row.result === 'ok') s += 1
    if (row.result === 'fail') f += 1
  }
  return { s, f }
}

export function blendShortlist(lexical, state, label, options = {}) {
  const kappa = options.kappa ?? EVOLVE_KAPPA
  const unlistedPrior = options.unlistedPrior ?? EVOLVE_UNLISTED_PRIOR
  const listSize = lexical.length
  const matchingLabel = state.filter((row) => row.label === label).length
  return lexical
    .map((hit, index) => {
      const prior = listSize > 0 ? betaPrior(index, listSize) : unlistedPrior
      const evidence = evidenceFor(state, label, hit.name)
      return {
        name: hit.name,
        lexical: hit.score,
        posterior: posteriorMean(prior, evidence, kappa),
        benchRank: index + 1,
        evidence,
        method: 'lexical+posterior',
      }
    })
    .sort((left, right) => {
      if (matchingLabel > 0) {
        const posteriorOrder = right.posterior - left.posterior
        if (posteriorOrder !== 0) return posteriorOrder
      }
      const lexicalOrder = right.lexical - left.lexical
      if (lexicalOrder !== 0) return lexicalOrder
      return left.name.localeCompare(right.name)
    })
}

export function proposeSkillEvolve(catalog, query, state, rawLabel = '', options = {}) {
  const needle = String(query ?? '').replace(/\s+/g, ' ').trim()
  const label = normalizeEvolveLabel(rawLabel || needle)
  const trimEnabled = options.catalogTrimEnabled === true
  const lexical = shortlistSkills(catalog, needle, options.limit ?? SHORTLIST_K)
  const hits = blendShortlist(lexical, state, label)
  return {
    query: needle,
    label,
    method: 'lexical+posterior',
    note: POSTERIOR_METHOD_COPY,
    hits,
    evidenceRows: state.length,
    matchingLabel: state.filter((row) => row.label === label).length,
    catalogTrim: {
      enabled: trimEnabled,
      copy: trimEnabled ? CATALOG_TRIM_ON_COPY : CATALOG_TRIM_OFF_COPY,
    },
    callNote: CALL_IS_NOT_VERDICT_COPY,
    rerank: options.rerank ?? { available: false, copy: RERANK_UNAVAILABLE_COPY },
  }
}

export function selectTrimNames(hits, maxEntries = SHORTLIST_K) {
  return hits.slice(0, maxEntries).map((hit) => hit.name)
}

export function trimCatalogEntries(entries, names) {
  if (!Array.isArray(names) || names.length === 0) return { ok: false, reason: 'empty-shortlist' }
  const wanted = new Set(names)
  const next = (Array.isArray(entries) ? entries : []).filter((entry) => entry && wanted.has(entry.name))
  if (next.length === 0) return { ok: false, reason: 'no-overlap' }
  return { ok: true, entries: next }
}

export function lastUserQuery(messages) {
  if (!Array.isArray(messages)) return ''
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (!message || typeof message !== 'object') continue
    const kind = message.source && message.source.kind
    if (kind === 'skill-catalog' || kind === 'skill-invocation' || kind === 'session-memory') continue
    if (message.role !== undefined && message.role !== 'user') continue
    const text = flattenMessageText(message.content).replace(/\s+/g, ' ').trim()
    if (text !== '') return text
  }
  return ''
}

function flattenMessageText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map((part) => {
    if (typeof part === 'string') return part
    if (part && typeof part === 'object' && typeof part.text === 'string') return part.text
    return ''
  }).join(' ')
}

export function rewriteCatalogDecision(decision, names) {
  if (!decision || decision.kind === 'reject' || !Array.isArray(decision.messages)) return decision
  const index = decision.messages.findIndex((message) => (
    message && message.source && message.source.kind === 'skill-catalog'
    && Array.isArray(message.source.entries)
  ))
  if (index === -1) return decision
  const current = decision.messages[index]
  const trimmed = trimCatalogEntries(current.source.entries, names)
  if (!trimmed.ok) return decision
  const nextMessage = {
    ...current,
    content: Array.isArray(current.content)
      ? current.content.map((part, partIndex) => (
        partIndex === 0 && part && typeof part === 'object'
          ? { ...part, text: renderTrimmedCatalog(trimmed.entries, current.source.update === true) }
          : part
      ))
      : current.content,
    source: { ...current.source, entries: trimmed.entries, trimmed: true },
  }
  const messages = decision.messages.slice()
  messages[index] = nextMessage
  return { ...decision, messages }
}

function renderTrimmedCatalog(entries, update) {
  const lines = entries.map((entry) => `- \`${entry.name}\`: ${String(entry.description ?? '')}`)
  const head = update
    ? 'The available skill catalog changed. This complete catalog replaces every earlier available-skills list in this session:'
    : 'A skill is a reusable set of task-specific instructions. The following skills are available in this session:'
  return [
    '<system-reminder>',
    head,
    '',
    '<available_skills>',
    ...lines,
    '</available_skills>',
    '',
    'This catalog is a fail-closed shortlist for this turn. Load a listed skill with the `skill` tool before following its instructions.',
    '</system-reminder>',
  ].join('\n')
}

export function parseSelectorSkillPick(text, allowedIds) {
  if (typeof text !== 'string' || text.trim() === '') return null
  const obj = extractJsonObject(text)
  if (!obj || typeof obj !== 'object') return null
  if (typeof obj.pick !== 'string' || obj.pick.trim() === '') return null
  const confidence = Number(obj.confidence)
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) return null
  const pick = obj.pick.trim()
  if (Array.isArray(allowedIds) && allowedIds.length > 0 && !allowedIds.includes(pick)) return null
  return {
    pick,
    confidence,
    reason: typeof obj.reason === 'string' ? obj.reason : '',
    label: typeof obj.label === 'string' ? obj.label.trim() : undefined,
  }
}

function extractFirstBalancedObject(text) {
  const start = text.indexOf('{')
  if (start === -1) return null
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i]
    if (inString) {
      if (escaped) { escaped = false; continue }
      if (ch === '\\') { escaped = true; continue }
      if (ch === '"') inString = false
      continue
    }
    if (ch === '"') { inString = true; continue }
    if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) return text.slice(start, i + 1)
    }
  }
  return null
}

function extractJsonObject(text) {
  const stripped = String(text).replace(/```(?:json)?/gi, '')
  let rest = stripped
  for (let guard = 0; guard < 8; guard += 1) {
    const candidate = extractFirstBalancedObject(rest)
    if (candidate === null) return null
    try {
      const parsed = JSON.parse(candidate)
      if (parsed && typeof parsed === 'object' && typeof parsed.pick === 'string') return parsed
    } catch { /* keep scanning */ }
    rest = rest.slice(rest.indexOf(candidate) + candidate.length)
  }
  return null
}

export function catalogTrimConfig(home = homedir()) {
  if (process.env.DSH_AGOS_CATALOG_TRIM === '0') return { enabled: false, maxEntries: SHORTLIST_K }
  if (process.env.DSH_AGOS_CATALOG_TRIM === '1') return { enabled: true, maxEntries: SHORTLIST_K }
  const path = join(home, '.dsh', 'agos', 'catalog-trim.json')
  if (!existsSync(path)) return { enabled: true, maxEntries: SHORTLIST_K }
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'))
    return {
      enabled: raw && raw.enabled !== false,
      maxEntries: Number.isInteger(raw && raw.maxEntries) && raw.maxEntries > 0
        ? Math.min(raw.maxEntries, 32)
        : SHORTLIST_K,
    }
  } catch {
    return { enabled: true, maxEntries: SHORTLIST_K }
  }
}

export async function writeCatalogTrimConfig(input, options = {}) {
  if (!input || input.confirm !== true) {
    return { ok: false, status: 400, code: 'CONFIRM_REQUIRED', error: '改目录裁剪需要 confirm:true' }
  }
  if (typeof input.enabled !== 'boolean') {
    return { ok: false, status: 400, code: 'INVALID_ENABLED', error: 'enabled 必须是布尔值' }
  }
  const home = options.home ?? homedir()
  const maxEntries = Number.isInteger(input.maxEntries) && input.maxEntries > 0
    ? Math.min(input.maxEntries, 32)
    : SHORTLIST_K
  const path = join(home, '.dsh', 'agos', 'catalog-trim.json')
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  await writeFile(path, JSON.stringify({ enabled: input.enabled, maxEntries }, null, 2) + '\n', { mode: 0o600 })
  return {
    ok: true,
    enabled: input.enabled,
    maxEntries,
    copy: input.enabled ? CATALOG_TRIM_ON_COPY : CATALOG_TRIM_OFF_COPY,
    path,
  }
}

export function createSkillEvolveStore(options = {}) {
  const home = options.home ?? homedir()
  const ledgerPath = options.ledgerPath ?? join(home, '.dsh', 'agos', 'skill-allocate.jsonl')
  const now = typeof options.now === 'function' ? options.now : () => new Date()

  const readState = async () => {
    try {
      const raw = await readFile(ledgerPath, 'utf8')
      const rows = []
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue
        let obj
        try { obj = JSON.parse(line) } catch { continue }
        if (!obj || obj.kind !== 'outcome') continue
        if (obj.result !== 'ok' && obj.result !== 'fail') continue
        if (typeof obj.skill !== 'string' || !NAME_RE.test(obj.skill)) continue
        rows.push({
          label: normalizeEvolveLabel(obj.label),
          skill: obj.skill,
          result: obj.result,
        })
      }
      return rows
    } catch (error) {
      if (error && error.code === 'ENOENT') return []
      throw error
    }
  }

  const recordOutcome = async (body) => {
    if (!body || body.confirm !== true) {
      return { ok: false, status: 400, code: 'CONFIRM_REQUIRED', error: '记录胜负需要 confirm:true' }
    }
    if (body.source !== 'operator' && body.source !== 'session-verdict') {
      return { ok: false, status: 400, code: 'SOURCE_REQUIRED', error: 'source 只能是 operator 或 session-verdict；skill() 调用不是胜负' }
    }
    const skill = typeof body.skill === 'string' ? body.skill.trim() : ''
    if (!NAME_RE.test(skill)) {
      return { ok: false, status: 400, code: 'INVALID_SKILL', error: 'skill 必须是 kebab 名' }
    }
    if (body.result !== 'ok' && body.result !== 'fail') {
      return { ok: false, status: 400, code: 'INVALID_RESULT', error: 'result 只能是 ok 或 fail' }
    }
    const label = normalizeEvolveLabel(body.label ?? '')
    const row = {
      kind: 'outcome',
      at: now().toISOString(),
      label,
      skill,
      result: body.result,
      source: body.source,
    }
    await mkdir(dirname(ledgerPath), { recursive: true, mode: 0o700 })
    await appendFile(ledgerPath, JSON.stringify(row) + '\n', { mode: 0o600 })
    return { ok: true, recorded: row }
  }

  const propose = async (input = {}) => {
    const state = await readState()
    const trim = catalogTrimConfig(home)
    return proposeSkillEvolve(
      input.catalog ?? [],
      input.query ?? '',
      state,
      input.label ?? '',
      {
        catalogTrimEnabled: trim.enabled,
        limit: trim.maxEntries,
        rerank: input.rerank,
      },
    )
  }

  return { ledgerPath, readState, recordOutcome, propose }
}

export async function applyOptionalRerank(report, rerank) {
  if (!rerank || typeof rerank !== 'function') {
    return { ...report, rerank: { available: false, copy: RERANK_UNAVAILABLE_COPY } }
  }
  const allowed = report.hits.map((hit) => hit.name)
  if (allowed.length === 0) {
    return { ...report, rerank: { available: false, copy: RERANK_UNAVAILABLE_COPY } }
  }
  try {
    const picked = await rerank({
      query: report.query,
      label: report.label,
      candidates: report.hits.map((hit) => ({ id: hit.name, lexical: hit.lexical, posterior: hit.posterior })),
    })
    const parsed = picked && typeof picked.pick === 'string'
      ? picked
      : parseSelectorSkillPick(typeof picked === 'string' ? picked : '', allowed)
    if (!parsed || !allowed.includes(parsed.pick)) {
      return { ...report, rerank: { available: true, ran: false, copy: RERANK_FAIL_CLOSED_COPY } }
    }
    const label = parsed.label ? normalizeEvolveLabel(parsed.label) : report.label
    return {
      ...report,
      label,
      rerank: {
        available: true,
        ran: true,
        pick: parsed.pick,
        confidence: parsed.confidence,
        reason: parsed.reason,
        copy: RERANK_OPT_IN_COPY,
      },
    }
  } catch {
    return { ...report, rerank: { available: true, ran: false, copy: RERANK_FAIL_CLOSED_COPY } }
  }
}

export function bindCatalogTrim(ctx, options = {}) {
  if (!ctx || typeof ctx.on !== 'function') return () => {}
  const home = options.home ?? homedir()
  const store = options.store ?? createSkillEvolveStore({ home })
  const catalogOf = typeof options.catalog === 'function' ? options.catalog : async () => []
  const evidence = options.evidence
  const resolveId = typeof options.sessionId === 'function'
    ? options.sessionId
    : (event) => {
      const agent = event && event.agent
      if (agent && typeof agent.id === 'string') return agent.id.trim()
      return typeof event?.sessionId === 'string' ? event.sessionId.trim() : ''
    }
  const handler = async (event, next) => {
    const decision = await next()
    const sessionId = resolveId(event)
    const trim = catalogTrimConfig(home)
    const record = (skills) => {
      if (sessionId !== '' && evidence && typeof evidence.record === 'function') {
        evidence.record(sessionId, { skills })
      }
    }
    if (!trim.enabled) {
      record({ trimmed: false, query: null, served: null, copy: '目录裁剪未启用' })
      return decision
    }
    try {
      const messages = event && event.messages
      const query = lastUserQuery(messages)
      if (query === '') {
        record({ trimmed: false, query: '', served: null, copy: '本跳没有可裁剪的用户问句' })
        return decision
      }
      const catalog = await catalogOf(event)
      const report = await store.propose({ query, catalog })
      const names = selectTrimNames(report.hits, trim.maxEntries)
      const nextDecision = rewriteCatalogDecision(decision, names)
      const catalogMessage = Array.isArray(nextDecision?.messages)
        ? nextDecision.messages.find((message) => message && message.source && message.source.kind === 'skill-catalog')
        : undefined
      const served = catalogMessage && catalogMessage.source && catalogMessage.source.trimmed === true
        && Array.isArray(catalogMessage.source.entries)
        ? catalogMessage.source.entries.map((entry) => entry.name).filter(Boolean)
        : null
      record({
        trimmed: served !== null,
        query,
        served,
        copy: served ? undefined : '本跳没有技能目录消息',
      })
      return nextDecision
    } catch {
      return decision
    }
  }
  const dispose = ctx.on('agent/pre-step', handler)
  return typeof dispose === 'function' ? dispose : () => {}
}
