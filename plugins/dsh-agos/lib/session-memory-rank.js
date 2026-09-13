// Session-memory shortlist: same recsys loop as skills, no model recommend.
// Candidate = this session's store. Rank = lexical overlap + operator posterior.
// Empty query / no overlap falls back to importance, and says so.
import { appendFile, mkdir, open } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import { ALLOCATE_POSTERIOR_COPY, ALLOCATE_SHORTLIST_K } from './allocate-kernel.js'
import {
  EVOLVE_KAPPA,
  EVOLVE_UNLISTED_PRIOR,
  betaPrior,
  lastUserQuery,
  normalizeEvolveLabel,
  posteriorMean,
} from './skills-evolve.js'

export { lastUserQuery }

export const MEMORY_SHORTLIST_K = ALLOCATE_SHORTLIST_K
export const ITEM_ID_RE = /^[a-f0-9]{24}$/
export const MEMORY_LEXICAL_METHOD = 'lexical+posterior'
export const MEMORY_FALLBACK_METHOD = 'importance-recency'
export const MEMORY_RESERVE_METHOD = 'constraint-reserve'
export const MEMORY_RESERVE_COPY = '短名单含约束保送，不是把约束算成更相关'
export const MEMORY_POSTERIOR_COPY = ALLOCATE_POSTERIOR_COPY
export const MEMORY_LEXICAL_COPY = '词面短名单，不是模型推荐'
export const MEMORY_FALLBACK_QUERY_COPY = '本跳没有可排序的用户问句，按重要度回注'
export const MEMORY_FALLBACK_OVERLAP_COPY = '词面没有重合，按重要度回注'
// 空 store 是 not-collected(没有任何条目可供比较),不是 no-overlap(有条目但都不匹配)。
// 2026-09-09 前,两种情形共用 no-overlap,且空 store 的 note 也声称「按重要度回注」——
// 那是对一次并未发生的回注的断言。空 store 的文案只陈述「没有条目」,不许提回注成功。
export const MEMORY_FALLBACK_EMPTY_STORE_COPY = '会话记忆为空，本跳没有条目可回注，不是没有匹配'
export const MEMORY_SHORTLIST_COPY = '本跳回注按词面短名单，不是全量条目'
export const INJECT_IS_NOT_VERDICT_COPY = '回注曝光不是胜负'
export const RELEVANCE_UNCOLLECTED_COPY = '相关账本未采集'
export const SESSION_UNCOLLECTED_COPY = 'sessionId 未采集'
export const STORE_UNREAD_COPY = '会话记忆读取失败，不是空 store'

export function tokenizeMemoryQuery(text) {
  const lower = String(text ?? '').toLocaleLowerCase()
  const tokens = new Set()
  for (const word of lower.match(/[a-z0-9]+/g) ?? []) {
    if (word.length >= 2) tokens.add(word)
  }
  for (const run of lower.match(/[\u3400-\u9fff]{2,}/g) ?? []) tokens.add(run)
  return [...tokens]
}

export function memoryLexicalScore(query, document) {
  const tokens = tokenizeMemoryQuery(query)
  if (tokens.length === 0) return 0
  const hay = String(document ?? '').toLocaleLowerCase()
  let hit = 0
  for (const token of tokens) {
    if (hay.includes(token)) hit += 1
  }
  return hit / tokens.length
}

export function memoryDocument(item) {
  return [item?.kind, item?.text].filter(Boolean).join('\n')
}

export function usableMemoryItems(items) {
  return (Array.isArray(items) ? items : []).filter((item) => (
    item && typeof item.text === 'string' && item.text.trim() !== ''
  ))
}

export function shortlistMemoryItems(items, query, limit = MEMORY_SHORTLIST_K) {
  const needle = String(query ?? '').replace(/\s+/g, ' ').trim()
  if (needle === '') return []
  return usableMemoryItems(items)
    .map((item) => ({
      id: typeof item.id === 'string' ? item.id : '',
      kind: item.kind,
      text: item.text,
      importance: item.importance,
      createdAt: item.createdAt,
      score: memoryLexicalScore(needle, memoryDocument(item)),
    }))
    .filter((row) => row.score > 0)
    .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id) || left.text.localeCompare(right.text))
    .slice(0, limit)
}

export function clipImpressionText(text, limit = 40) {
  const trimmed = String(text ?? '').replace(/\s+/g, ' ').trim()
  const chars = [...trimmed]
  return chars.length <= limit ? trimmed : `${chars.slice(0, limit).join('')}…`
}

export function impressionMethod(method) {
  return method === MEMORY_LEXICAL_METHOD
    || method === MEMORY_FALLBACK_METHOD
    || method === MEMORY_RESERVE_METHOD
    ? method
    : null
}

export function memoryImpressions(items, hits = []) {
  const whyById = new Map()
  const whyByText = new Map()
  for (const hit of Array.isArray(hits) ? hits : []) {
    const method = impressionMethod(hit && hit.method)
    if (method === null) continue
    if (typeof hit.id === 'string' && hit.id !== '') whyById.set(hit.id, method)
    if (typeof hit.text === 'string' && hit.text.trim() !== '') whyByText.set(hit.text.trim(), method)
  }
  return (Array.isArray(items) ? items : [])
    .flatMap((item) => {
      const text = clipImpressionText(item && item.text)
      if (text === '') return []
      const method = (typeof item.id === 'string' && whyById.get(item.id))
        || whyByText.get(String(item.text ?? '').replace(/\s+/g, ' ').trim())
        || impressionMethod(item && item.method)
      return [{
        id: typeof item.id === 'string' ? item.id : '',
        kind: typeof item.kind === 'string' ? item.kind : '',
        text,
        ...(method ? { method } : {}),
      }]
    })
}

export function sameMemoryItem(left, right) {
  if (!left || !right) return false
  if (typeof left.id === 'string' && left.id !== '' && left.id === right.id) return true
  const leftId = typeof left.id === 'string' ? left.id : ''
  const rightId = typeof right.id === 'string' ? right.id : ''
  if (leftId !== '' || rightId !== '') return false
  return left.kind === right.kind && String(left.text ?? '').trim() === String(right.text ?? '').trim()
}

export function reserveConstraint(selected, items, limit = MEMORY_SHORTLIST_K) {
  const catalog = usableMemoryItems(items)
  const constraints = catalog.filter((item) => item.kind === 'constraint')
  if (constraints.length === 0) return { items: selected, reserved: false }
  if ((Array.isArray(selected) ? selected : []).some((item) => item && item.kind === 'constraint')) {
    return { items: selected, reserved: false }
  }
  const pick = rankByImportance(constraints, 1)[0]
  if (!pick) return { items: selected, reserved: false }
  const next = (Array.isArray(selected) ? selected : []).filter((item) => !sameMemoryItem(item, pick))
  if (next.length >= limit) next.pop()
  return { items: [pick, ...next], reserved: true, reservedId: typeof pick.id === 'string' ? pick.id : '' }
}

export function rankByImportance(items, limit = MEMORY_SHORTLIST_K) {
  return usableMemoryItems(items)
    .slice()
    .sort((left, right) => {
      const importance = (Number(right.importance) || 0) - (Number(left.importance) || 0)
      if (importance !== 0) return importance
      const rightAt = Date.parse(right.createdAt ?? '') || 0
      const leftAt = Date.parse(left.createdAt ?? '') || 0
      if (rightAt !== leftAt) return rightAt - leftAt
      return String(left.id).localeCompare(String(right.id))
    })
    .slice(0, limit)
}

function evidenceFor(state, label, itemId) {
  let s = 0
  let f = 0
  for (const row of state) {
    if (row.label !== label || row.itemId !== itemId) continue
    if (row.result === 'ok') s += 1
    if (row.result === 'fail') f += 1
  }
  return { s, f }
}

export function blendMemoryShortlist(lexical, state, label, options = {}) {
  const kappa = options.kappa ?? EVOLVE_KAPPA
  const unlistedPrior = options.unlistedPrior ?? EVOLVE_UNLISTED_PRIOR
  const listSize = lexical.length
  const matchingLabel = state.filter((row) => row.label === label).length
  return lexical
    .map((hit, index) => {
      const prior = listSize > 0 ? betaPrior(index, listSize) : unlistedPrior
      const evidence = evidenceFor(state, label, hit.id)
      return {
        id: hit.id,
        kind: hit.kind,
        text: hit.text,
        lexical: hit.score,
        posterior: posteriorMean(prior, evidence, kappa),
        benchRank: index + 1,
        evidence,
        method: MEMORY_LEXICAL_METHOD,
      }
    })
    .sort((left, right) => {
      if (matchingLabel > 0) {
        const posteriorOrder = right.posterior - left.posterior
        if (posteriorOrder !== 0) return posteriorOrder
      }
      const lexicalOrder = right.lexical - left.lexical
      if (lexicalOrder !== 0) return lexicalOrder
      return left.id.localeCompare(right.id)
    })
}

export function proposeSessionMemory(items, query, state, options = {}) {
  const needle = String(query ?? '').replace(/\s+/g, ' ').trim()
  const label = normalizeEvolveLabel(options.label || needle)
  const limit = options.limit ?? MEMORY_SHORTLIST_K
  const rows = Array.isArray(state) ? state : []
  const usable = usableMemoryItems(items).length
  const lexicalAll = shortlistMemoryItems(items, needle, limit)
  // fallback 三态:空 store 优先于一切 —— 条目本身不存在时,问句与词面比较都无从谈起,
  // 任何「按重要度回注」的说法都是对未发生行为的断言。
  const fallback = usable === 0
    ? 'empty-store'
    : !needle ? 'empty-query'
      : lexicalAll.length === 0 ? 'no-overlap'
        : null
  const lexical = fallback === null ? lexicalAll : []
  const queryCollected = needle !== ''
  const hits = fallback === null
    ? blendMemoryShortlist(lexical, rows, label, options)
    : rankByImportance(items, limit).map((item, index) => ({
      id: typeof item.id === 'string' ? item.id : '',
      kind: item.kind,
      text: item.text,
      lexical: 0,
      posterior: null,
      benchRank: index + 1,
      evidence: { s: 0, f: 0 },
      method: MEMORY_FALLBACK_METHOD,
    }))
  const catalog = usableMemoryItems(items)
  const selected = hits.flatMap((hit) => {
    const item = catalog.find((row) => (
      hit.id !== '' && row.id === hit.id
    ) || (
      hit.id === '' && row.text === hit.text
    ))
    return item === undefined ? [] : [item]
  })
  let copy = MEMORY_SHORTLIST_COPY
  if (fallback === 'empty-store') copy = MEMORY_FALLBACK_EMPTY_STORE_COPY
  else if (fallback === 'empty-query') copy = MEMORY_FALLBACK_QUERY_COPY
  else if (fallback === 'no-overlap') copy = MEMORY_FALLBACK_OVERLAP_COPY
  const reserved = fallback === null
    ? reserveConstraint(selected, items, limit)
    : { items: selected, reserved: false }
  const nextItems = reserved.items
  const reservedItem = reserved.reserved ? nextItems[0] : undefined
  const nextHits = reserved.reserved
    ? [
      {
        id: typeof reserved.reservedId === 'string' ? reserved.reservedId : '',
        kind: 'constraint',
        text: reservedItem?.text,
        lexical: 0,
        posterior: null,
        benchRank: 0,
        evidence: { s: 0, f: 0 },
        method: MEMORY_RESERVE_METHOD,
      },
      ...hits.filter((hit) => !sameMemoryItem(hit, reservedItem)),
    ]
    : hits
  if (nextItems.length > 0 && fallback === null) {
    copy = reserved.reserved
      ? `本跳回注 ${nextItems.length}/${usable} · 词面短名单 · 含约束保送`
      : `本跳回注 ${nextItems.length}/${usable} · 词面短名单`
  } else if (nextItems.length > 0 && fallback !== null) {
    copy = `${copy} ${nextItems.length} 条`
  }
  return {
    query: needle,
    label,
    queryCollected,
    fallback,
    reserved: reserved.reserved === true,
    // empty-store 没有任何排序发生过:method 是 null,不是 importance-recency。
    method: fallback === null ? MEMORY_LEXICAL_METHOD : fallback === 'empty-store' ? null : MEMORY_FALLBACK_METHOD,
    note: fallback === null && rows.some((row) => row.label === label)
      ? MEMORY_POSTERIOR_COPY
      : fallback === null ? MEMORY_LEXICAL_COPY : copy,
    copy,
    hits: nextHits,
    items: nextItems,
    impressions: memoryImpressions(nextItems, nextHits),
    itemCount: usableMemoryItems(items).length,
    evidenceRows: rows.length,
    matchingLabel: rows.filter((row) => row.label === label).length,
    callNote: INJECT_IS_NOT_VERDICT_COPY,
  }
}

export function describeUnreadSessionMemory(sessionId) {
  const id = typeof sessionId === 'string' ? sessionId.trim() : ''
  if (id === '') {
    return {
      sessionId: '',
      collected: false,
      itemsCollected: false,
      evidenceRows: null,
      itemCount: null,
      hits: [],
      queryCollected: false,
      method: null,
      copy: SESSION_UNCOLLECTED_COPY,
      note: SESSION_UNCOLLECTED_COPY,
      callNote: INJECT_IS_NOT_VERDICT_COPY,
    }
  }
  return {
    sessionId: id,
    collected: false,
    itemsCollected: false,
    evidenceRows: null,
    itemCount: null,
    hits: [],
    queryCollected: false,
    method: null,
    copy: STORE_UNREAD_COPY,
    note: STORE_UNREAD_COPY,
    callNote: INJECT_IS_NOT_VERDICT_COPY,
  }
}

export function describeSessionMemoryRelevance(sessionId, report) {
  const id = typeof sessionId === 'string' ? sessionId.trim() : ''
  if (id === '') {
    return {
      sessionId: '',
      collected: false,
      itemsCollected: false,
      evidenceRows: null,
      itemCount: null,
      copy: SESSION_UNCOLLECTED_COPY,
      queryCollected: false,
      hits: [],
      method: null,
      note: SESSION_UNCOLLECTED_COPY,
      callNote: INJECT_IS_NOT_VERDICT_COPY,
    }
  }
  const evidenceRows = report.evidenceRows
  return {
    sessionId: id,
    collected: true,
    itemsCollected: true,
    query: report.query,
    label: report.label,
    queryCollected: report.queryCollected,
    fallback: report.fallback,
    reserved: report.reserved === true,
    impressions: Array.isArray(report.impressions) ? report.impressions : [],
    method: report.method,
    note: report.note,
    copy: evidenceRows === 0 ? '相关账本 0 行' : `相关账本 ${evidenceRows} 行`,
    hits: report.hits,
    itemCount: report.itemCount,
    evidenceRows,
    matchingLabel: report.matchingLabel,
    callNote: report.callNote,
  }
}

export function parseRelevanceOutcomeLine(line) {
  if (typeof line !== 'string' || line.trim() === '') return null
  let obj
  try { obj = JSON.parse(line) } catch { return null }
  if (!obj || obj.kind !== 'outcome') return null
  if (obj.result !== 'ok' && obj.result !== 'fail') return null
  if (typeof obj.itemId !== 'string' || !ITEM_ID_RE.test(obj.itemId)) return null
  return {
    label: normalizeEvolveLabel(obj.label),
    itemId: obj.itemId,
    result: obj.result,
    sessionId: typeof obj.sessionId === 'string' ? obj.sessionId : '',
  }
}

export function createSessionMemoryRelevanceStore(options = {}) {
  const home = options.home ?? homedir()
  const ledgerPath = options.ledgerPath ?? join(home, '.dsh', 'agos', 'memory-relevance.jsonl')
  const now = typeof options.now === 'function' ? options.now : () => new Date()
  const bySession = new Map()
  let byteOffset = 0
  let leftover = ''

  const pushRow = (row) => {
    const list = bySession.get(row.sessionId) ?? []
    list.push(row)
    bySession.set(row.sessionId, list)
  }

  const resetIndex = () => {
    bySession.clear()
    byteOffset = 0
    leftover = ''
  }

  const ingestText = (text) => {
    const chunk = leftover + text
    const lines = chunk.split('\n')
    leftover = chunk.endsWith('\n') ? '' : String(lines.pop() ?? '')
    for (const line of lines) {
      const row = parseRelevanceOutcomeLine(line)
      if (row !== null) pushRow(row)
    }
  }

  const syncIndex = async () => {
    let handle
    try {
      handle = await open(ledgerPath, 'r')
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        resetIndex()
        return
      }
      throw error
    }
    try {
      const info = await handle.stat()
      if (info.size < byteOffset) resetIndex()
      if (info.size === byteOffset) return
      const length = info.size - byteOffset
      const buffer = Buffer.alloc(length)
      const read = await handle.read(buffer, 0, length, byteOffset)
      byteOffset = info.size
      ingestText(buffer.subarray(0, read.bytesRead).toString('utf8'))
    } finally {
      await handle.close()
    }
  }

  const readState = async (sessionId) => {
    await syncIndex()
    const id = typeof sessionId === 'string' ? sessionId.trim() : ''
    if (id === '') return [...bySession.values()].flat()
    return [...(bySession.get(id) ?? [])]
  }

  const recordOutcome = async (body) => {
    if (!body || body.confirm !== true) {
      return { ok: false, status: 400, code: 'CONFIRM_REQUIRED', error: '记录相关需要 confirm:true' }
    }
    if (body.source !== 'operator') {
      return { ok: false, status: 400, code: 'SOURCE_REQUIRED', error: 'source 只能是 operator；回注曝光不是胜负' }
    }
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : ''
    if (sessionId === '') {
      return { ok: false, status: 400, code: 'INVALID_SESSION', error: SESSION_UNCOLLECTED_COPY }
    }
    const itemId = typeof body.itemId === 'string' ? body.itemId.trim() : ''
    if (!ITEM_ID_RE.test(itemId)) {
      return { ok: false, status: 400, code: 'INVALID_ITEM', error: 'itemId 未采集' }
    }
    if (body.result !== 'ok' && body.result !== 'fail') {
      return { ok: false, status: 400, code: 'INVALID_RESULT', error: 'result 只能是 ok 或 fail' }
    }
    const label = normalizeEvolveLabel(body.label ?? body.query ?? '')
    const row = {
      kind: 'outcome',
      at: now().toISOString(),
      sessionId,
      itemId,
      label,
      result: body.result,
      source: 'operator',
    }
    await mkdir(dirname(ledgerPath), { recursive: true, mode: 0o700 })
    const line = JSON.stringify(row) + '\n'
    await appendFile(ledgerPath, line, { mode: 0o600 })
    await syncIndex()
    return { ok: true, recorded: row }
  }

  const propose = async (input = {}) => {
    const sessionId = typeof input.sessionId === 'string' ? input.sessionId.trim() : ''
    const state = sessionId === '' ? [] : await readState(sessionId)
    return proposeSessionMemory(input.items ?? [], input.query ?? '', state, {
      label: input.label,
      limit: input.limit,
    })
  }

  return { ledgerPath, readState, recordOutcome, propose }
}
