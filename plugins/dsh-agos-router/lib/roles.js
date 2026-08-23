/** Closed role set — FuguNano planner|implementer|reviewer|fixer. Free text is not a cell key. */
export const CLOSED_ROLES = Object.freeze(['planner', 'implementer', 'reviewer', 'fixer'])

const ALIASES = Object.freeze({
  planner: 'planner',
  planning: 'planner',
  plan: 'planner',
  implementer: 'implementer',
  implement: 'implementer',
  coder: 'implementer',
  coding: 'implementer',
  sql: 'implementer',
  reviewer: 'reviewer',
  review: 'reviewer',
  'code-review': 'reviewer',
  fixer: 'fixer',
  fix: 'fixer',
})

export function normalizeRole(value) {
  if (typeof value !== 'string') return undefined
  const raw = value.trim().toLowerCase()
  if (!raw) return undefined
  if (CLOSED_ROLES.includes(raw)) return raw
  return ALIASES[raw]
}
