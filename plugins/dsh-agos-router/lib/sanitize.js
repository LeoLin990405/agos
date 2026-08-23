// Reuse AgOS session-memory secret/entropy gates. Do not fork a weaker regex.
import { isSensitiveMemoryText } from '../../dsh-agos/lib/session-memory.mjs'

export const TASK_PREVIEW_LIMIT = 80
export const REASON_LIMIT = 160

export function sanitizePreview(text, limit = TASK_PREVIEW_LIMIT) {
  if (typeof text !== 'string') return undefined
  const trimmed = text.replace(/\s+/gu, ' ').trim()
  if (!trimmed) return undefined
  if (isSensitiveMemoryText(trimmed)) return undefined
  const chars = [...trimmed]
  return chars.length <= limit ? trimmed : chars.slice(0, limit).join('')
}

/** 决策 id 本身长得像高熵,不能走 highEntropyToken;凭据串仍要丢。 */
const DECISION_ID = /^dec-\d+-[a-f0-9]+$/i

export function sanitizeOutcomeRef(text, limit = 80) {
  if (typeof text !== 'string') return undefined
  const trimmed = text.replace(/\s+/gu, ' ').trim()
  if (!trimmed) return undefined
  if (DECISION_ID.test(trimmed)) {
    return [...trimmed].length <= limit ? trimmed : undefined
  }
  return sanitizePreview(text, limit)
}
