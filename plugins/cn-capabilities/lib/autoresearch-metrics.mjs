/**
 * Structured metric extraction for autoresearch.
 * Never take the first number from arbitrary command output.
 */

const FINITE = (value) => {
  if (typeof value !== 'number' && (typeof value !== 'string' || !value.trim())) return undefined
  const n = Number(value)
  return Number.isFinite(n) ? n : undefined
}

const escapeRegExp = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

function jsonPayload(line) {
  const text = String(line || '').trim()
  if (!text) return null
  const start = text.indexOf('{')
  if (start < 0) return null
  const end = text.lastIndexOf('}')
  if (end <= start) return null
  try {
    return JSON.parse(text.slice(start, end + 1))
  } catch {
    return null
  }
}

function fromJsonObject(obj, field) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return undefined
  if (!Object.prototype.hasOwnProperty.call(obj, field)) return undefined
  return FINITE(obj[field])
}

function extractJsonLine(text, field) {
  const lines = String(text || '').split(/\r?\n/)
  for (let i = lines.length - 1; i >= 0; i--) {
    const value = fromJsonObject(jsonPayload(lines[i]), field)
    if (value !== undefined) return { ok: true, value, kind: 'json-line', field }
  }
  const whole = fromJsonObject(jsonPayload(text), field)
  if (whole !== undefined) return { ok: true, value: whole, kind: 'json-line', field }
  return null
}

function extractLabeled(text, field, kind) {
  const name = escapeRegExp(field)
  const re = new RegExp(
    `(?:^|[\\s,;|])${name}\\s*[:=]\\s*(-?(?:\\d+(?:\\.\\d+)?|\\.\\d+)(?:[eE][+-]?\\d+)?)\\b`,
    'im',
  )
  const match = String(text || '').match(re)
  if (!match) return null
  const value = FINITE(match[1])
  return value === undefined ? null : { ok: true, value, kind, field }
}

/**
 * @param {string} text
 * @param {{ kind?: 'auto'|'json-line'|'metric-eq'|'labeled-field', field?: string, name?: string }} [spec]
 */
export function extractStructuredMetric(text, spec = {}) {
  const field = String(spec.field || spec.name || 'metric')
  const kind = spec.kind || 'auto'
  if (!field || /[\s=:]/.test(field)) {
    return { ok: false, value: undefined, kind: 'none', field, error: 'invalid-metric-field' }
  }

  let hit = null
  if (kind === 'json-line' || kind === 'auto') hit = extractJsonLine(text, field)
  if (!hit && (kind === 'metric-eq' || kind === 'auto')) hit = extractLabeled(text, field, 'metric-eq')
  if (!hit && (kind === 'labeled-field' || kind === 'auto')) hit = extractLabeled(text, field, 'labeled-field')

  return hit || { ok: false, value: undefined, kind: 'none', field, error: 'metric-missing' }
}

/**
 * @param {unknown} candidate
 * @param {unknown} baseline
 * @param {'higher'|'lower'} [direction]
 */
export function compareMetric(candidate, baseline, direction = 'higher') {
  const dir = direction === 'lower' ? 'lower' : 'higher'
  const a = FINITE(candidate)
  const b = FINITE(baseline)
  if (a === undefined || b === undefined) {
    return { improved: false, comparable: false, direction: dir, delta: undefined, candidate: a, baseline: b }
  }
  const delta = a - b
  const improved = dir === 'higher' ? a > b : a < b
  return { improved, comparable: true, direction: dir, delta, candidate: a, baseline: b }
}
