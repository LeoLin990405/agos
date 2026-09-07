// Session-memory inject: fail-closed pre-step reminder. Empty stores do nothing.
// Default ON so extracted items can reach the next turn. DSH_AGOS_MEMORY_INJECT=0 disables.
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import { MEMORY_REMINDER_RULES } from './agent-prompts.js'
import {
  MEMORY_FALLBACK_METHOD,
  MEMORY_LEXICAL_METHOD,
  MEMORY_RESERVE_METHOD,
  createSessionMemoryRelevanceStore,
  lastUserQuery,
  proposeSessionMemory,
} from './session-memory-rank.js'

export const SESSION_MEMORY_KIND = 'session-memory'
export const INJECT_ENABLED_COPY = '下一跳会回注本会话已提炼条目'
export const INJECT_EMPTY_COPY = '回注已启用，本会话没有可回注条目'
export const INJECT_OFF_COPY = '回注未启用：仅观察，不进下一跳'
export const INJECT_UNREAD_COPY = '会话记忆读取失败，条目数未采集'
export const INJECT_METHOD_COPY = '会话记忆回注是便利投影，不是权威记忆'

function closedMemoryEvidence(patch = {}) {
  return {
    enabled: true,
    prepended: 0,
    itemCount: null,
    served: [],
    impressions: [],
    reserved: false,
    method: null,
    query: null,
    ...patch,
  }
}

function configPath(home = homedir()) {
  return join(home, '.dsh', 'agos', 'session-memory-inject.json')
}

export function sessionMemoryInjectConfig(home = homedir()) {
  if (process.env.DSH_AGOS_MEMORY_INJECT === '0') return { enabled: false }
  if (process.env.DSH_AGOS_MEMORY_INJECT === '1') return { enabled: true }
  const path = configPath(home)
  if (!existsSync(path)) return { enabled: true }
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'))
    return { enabled: raw && raw.enabled !== false }
  } catch {
    return { enabled: true }
  }
}

export async function writeSessionMemoryInjectConfig(input, options = {}) {
  if (!input || input.confirm !== true) {
    return { ok: false, status: 400, code: 'CONFIRM_REQUIRED', error: '改回注开关需要 confirm:true' }
  }
  if (typeof input.enabled !== 'boolean') {
    return { ok: false, status: 400, code: 'INVALID_ENABLED', error: 'enabled 必须是布尔值' }
  }
  const home = options.home ?? homedir()
  const path = configPath(home)
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  await writeFile(path, JSON.stringify({ enabled: input.enabled }, null, 2) + '\n', { mode: 0o600 })
  return { ok: true, enabled: input.enabled, path }
}

export function resolveSessionId(event) {
  if (!event || typeof event !== 'object') return ''
  const agent = event.agent
  if (agent && typeof agent.id === 'string' && agent.id.trim() !== '') return agent.id.trim()
  if (typeof event.sessionId === 'string' && event.sessionId.trim() !== '') return event.sessionId.trim()
  if (typeof event.agentId === 'string' && event.agentId.trim() !== '') return event.agentId.trim()
  const session = event.session
  if (session && typeof session.id === 'string' && session.id.trim() !== '') return session.id.trim()
  return ''
}

export function injectStatusCopy(enabled, itemCount) {
  if (!enabled) return INJECT_OFF_COPY
  if (itemCount === null || itemCount === undefined) return INJECT_UNREAD_COPY
  return itemCount > 0 ? INJECT_ENABLED_COPY : INJECT_EMPTY_COPY
}

export const REMINDER_WHY = {
  [MEMORY_LEXICAL_METHOD]: 'lexical+posterior shortlist',
  [MEMORY_RESERVE_METHOD]: 'reserved-constraint, not more relevant',
  [MEMORY_FALLBACK_METHOD]: 'importance fallback, not relevance',
}

export function reminderWhy(method) {
  return REMINDER_WHY[method] ?? 'why uncollected'
}

export function renderSessionMemoryReminder(items, sessionId, hits = []) {
  const whyById = new Map()
  const whyByText = new Map()
  for (const hit of Array.isArray(hits) ? hits : []) {
    if (!hit) continue
    const why = reminderWhy(hit.method)
    if (typeof hit.id === 'string' && hit.id !== '') whyById.set(hit.id, why)
    if (typeof hit.text === 'string' && hit.text.trim() !== '') whyByText.set(hit.text.trim(), why)
  }
  const rows = (Array.isArray(items) ? items : []).map((item) => {
    const text = String(item.text ?? '').replace(/\s+/g, ' ').trim()
    const why = (typeof item.id === 'string' && whyById.get(item.id))
      || whyByText.get(text)
      || reminderWhy(item && item.method)
    return `- [${item.kind} | ${why}] ${text}`
  })
  return [
    '<system-reminder>',
    `Session memory for this conversation (convenience projection, not authoritative). sessionId=${sessionId}.`,
    MEMORY_REMINDER_RULES,
    '',
    ...rows,
    '</system-reminder>',
  ].join('\n')
}

export function rewriteDecisionWithSessionMemory(decision, items, sessionId, hits = []) {
  if (!decision || !Array.isArray(decision.messages)) return decision
  const rows = Array.isArray(items) ? items.filter((item) => item && typeof item.text === 'string' && item.text.trim() !== '') : []
  if (rows.length === 0 || sessionId === '') return decision
  if (decision.messages.some((message) => message && message.source && message.source.kind === SESSION_MEMORY_KIND)) {
    return decision
  }
  const reminder = {
    role: 'user',
    source: {
      kind: SESSION_MEMORY_KIND,
      plugin: 'dsh-agos',
      sessionId,
      itemCount: rows.length,
      itemIds: rows.map((item) => item.id).filter((id) => typeof id === 'string'),
    },
    content: [{ type: 'text', text: renderSessionMemoryReminder(rows, sessionId, hits) }],
  }
  return { ...decision, messages: [reminder, ...decision.messages] }
}

export function bindSessionMemoryInject(ctx, options = {}) {
  if (!ctx || typeof ctx.on !== 'function') return () => {}
  const home = options.home ?? homedir()
  const store = options.store
  const rank = options.rank ?? createSessionMemoryRelevanceStore({ home })
  const evidence = options.evidence
  const handler = async (event, next) => {
    const decision = await next()
    const sessionId = resolveSessionId(event)
    const config = sessionMemoryInjectConfig(home)
    if (!config.enabled) {
      if (sessionId !== '' && evidence && typeof evidence.record === 'function') {
        evidence.record(sessionId, {
          memory: closedMemoryEvidence({
            enabled: false,
            copy: '回注未启用：本跳没有 prepend',
          }),
        })
      }
      return decision
    }
    if (!store || typeof store.get !== 'function') return decision
    try {
      if (sessionId === '') return decision
      const document = await store.get(sessionId)
      const items = document && Array.isArray(document.items) ? document.items : []
      const query = lastUserQuery(event && event.messages) || lastUserQuery(decision && decision.messages)
      const state = sessionId !== '' && rank && typeof rank.readState === 'function'
        ? await rank.readState(sessionId)
        : []
      const report = proposeSessionMemory(items, query, state)
      const staleNote = document.status === 'extracting'
        ? '抽取进行中，短名单来自上次确认内容'
        : document.status === 'degraded'
          ? '抽取失败，短名单来自上次确认内容'
          : ''
      const copy = staleNote === '' ? report.copy : `${report.copy} · ${staleNote}`
      const nextDecision = rewriteDecisionWithSessionMemory(decision, report.items, sessionId, report.hits)
      if (evidence && typeof evidence.record === 'function') {
        evidence.record(sessionId, {
          memory: {
            enabled: true,
            prepended: nextDecision === decision ? 0 : report.items.length,
            itemCount: items.length,
            served: report.items.map((item) => item.id),
            impressions: report.impressions,
            reserved: report.reserved === true,
            method: report.method,
            query,
            copy,
          },
        })
      }
      return nextDecision
    } catch {
      if (sessionId !== '' && evidence && typeof evidence.record === 'function') {
        evidence.record(sessionId, {
          memory: closedMemoryEvidence({
            error: 'inject-failed',
            copy: '回注失败，本跳没有 prepend',
          }),
        })
      }
      return decision
    }
  }
  const dispose = ctx.on('agent/pre-step', handler)
  return typeof dispose === 'function' ? dispose : () => {}
}

export function describeSessionMemoryInject(home = homedir(), itemCount = 0) {
  const config = sessionMemoryInjectConfig(home)
  return {
    enabled: config.enabled,
    itemCount,
    copy: injectStatusCopy(config.enabled, itemCount),
    method: INJECT_METHOD_COPY,
  }
}
