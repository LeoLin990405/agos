import { normalizeRole } from './roles.js'

/** Static role table — used when the selector times out or is unconfigured. Not a quality label. */
export const STATIC_FALLBACK = Object.freeze({
  planner: { pick: 'glm-5.2', role: 'planner' },
  implementer: { pick: 'qwen3.8-max', role: 'implementer' },
  reviewer: { pick: 'minimax-m3', role: 'reviewer' },
  fixer: { pick: 'qwen3.8-max', role: 'fixer' },
  default: { pick: 'step-3.7-flash', role: 'implementer' },
})

export function fallbackPick(input) {
  const role = normalizeRole(input?.role) || normalizeRole(input?.taskType) || 'implementer'
  const row = STATIC_FALLBACK[role] || STATIC_FALLBACK.default
  const ids = Array.isArray(input?.candidates) ? input.candidates.map((c) => c.id) : []
  const pick = ids.includes(row.pick) ? row.pick : (ids[0] || row.pick)
  return {
    pick,
    role: row.role,
    confidence: 0,
    reason: 'selector unavailable or timed out; static table',
    alternates: ids.filter((id) => id !== pick).slice(0, 3),
    label: role,
  }
}
