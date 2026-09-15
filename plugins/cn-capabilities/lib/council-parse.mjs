/**
 * 仲裁 JSON 的抽取与结构判定。vision / review 共用。
 *
 * 根因(index.js ~1624-1648 + 旧 disagreementsFromParsed):
 *   parseVerdict 接受任意 JSON 对象 → {} 算 parsed
 *   disagreements 缺席被当成 []
 *   consensus = !!parsed && disagreements.length === 0  → {} 变成「各家一致」
 *   parsedOk: !!parsed → {} 变成 parsedOk=true
 *
 * 空 disagreements 只在「完整且类型正确的仲裁结构」里才表示同意。
 * 评委模型 / 人数阈值 / 工具权限 / 「各家一致」文案都不在这里改。
 */

import {
  disagreementsFromParsed,
  validateCouncilFields,
} from './council-record.js'

/** 与现网 review / vision 路径同一门槛:少于两份有效答案就无从比对。 */
export const MIN_VALID_PANELISTS = 2

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

const escapeCtrlInStrings = (s) => {
  let o = ''
  let inStr = false
  let esc = false
  for (const ch of s) {
    if (!inStr) { if (ch === '"') inStr = true; o += ch; continue }
    if (esc) { o += ch; esc = false; continue }
    if (ch === '\\') { o += ch; esc = true; continue }
    if (ch === '"') { inStr = false; o += ch; continue }
    if (ch === '\n') { o += '\\n'; continue }
    if (ch === '\r') continue
    if (ch === '\t') { o += '\\t'; continue }
    o += ch
  }
  return o
}

/** 抠第一个平衡的 {...}。数括号时跳过字符串,失败再逃一次串内裸换行。 */
export function extractFirstJsonObject(raw) {
  if (raw == null) return null
  const t = String(raw).replace(/```(?:json)?/gi, '')
  const i = t.indexOf('{')
  if (i < 0) return null
  let depth = 0
  let inStr = false
  let esc = false
  for (let j = i; j < t.length; j++) {
    const ch = t[j]
    if (inStr) {
      if (esc) esc = false
      else if (ch === '\\') esc = true
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') { inStr = true; continue }
    if (ch === '{') depth++
    else if (ch === '}' && --depth === 0) {
      const slice = t.slice(i, j + 1)
      try { return JSON.parse(slice) } catch {}
      try { return JSON.parse(escapeCtrlInStrings(slice)) } catch { return null }
    }
  }
  return null
}

/**
 * @param {unknown} raw 仲裁原文(可带围栏/前后废话)
 * @returns {{ parsed: object | null, raw: string, ok: boolean, reason: string | undefined }}
 */
export function parseCouncilVerdict(raw) {
  const rawText = raw == null ? '' : String(raw)
  if (!rawText.trim()) {
    return { parsed: null, raw: rawText, ok: false, reason: 'empty' }
  }
  const value = extractFirstJsonObject(rawText)
  if (value === null) {
    return { parsed: null, raw: rawText, ok: false, reason: 'parse_failure' }
  }
  if (!isPlainObject(value)) {
    return { parsed: null, raw: rawText, ok: false, reason: 'not_object' }
  }
  return { parsed: value, raw: rawText, ok: true, reason: undefined }
}

export function countValidPanelists(panelists) {
  if (!Array.isArray(panelists)) return 0
  let n = 0
  for (const p of panelists) {
    if (isPlainObject(p) && p.ok === true) n++
  }
  return n
}

function fail(reason, extra) {
  return {
    parsedOk: false,
    consensus: false,
    inconclusive: true,
    disagreements: [],
    reason,
    ...extra,
  }
}

/**
 * @param {{ parsed: unknown, panelists?: unknown, kind?: 'review' | 'vision', parseReason?: string }} input
 * @returns {{
 *   parsedOk: boolean,
 *   consensus: boolean,
 *   inconclusive: boolean,
 *   disagreements: string[],
 *   reason: string | undefined,
 *   kind: 'review' | 'vision',
 *   validPanelistCount: number,
 *   missing: string[],
 *   wrong: string[],
 * }}
 */
export function evaluateCouncilStructure({ parsed, panelists, kind, parseReason } = {}) {
  const validPanelistCount = countValidPanelists(panelists)
  const fields = validateCouncilFields(parsed, kind)
  const extra = {
    kind: fields.kind,
    validPanelistCount,
    missing: fields.missing,
    wrong: fields.wrong,
  }

  if (!isPlainObject(parsed)) {
    return fail(parseReason || (parsed == null ? 'parse_failure' : 'not_object'), extra)
  }
  if (!fields.ok) {
    return fail(fields.reason, extra)
  }
  if (validPanelistCount < MIN_VALID_PANELISTS) {
    const items = disagreementsFromParsed(parsed)
    return {
      parsedOk: false,
      consensus: false,
      inconclusive: true,
      disagreements: Array.isArray(items) ? items : [],
      reason: 'too_few_panelists',
      ...extra,
    }
  }

  const disagreements = disagreementsFromParsed(parsed)
  // schema 已要求 disagreements 是数组;这里再守一次,缺席仍当失败而不是同意。
  if (!Array.isArray(disagreements)) {
    return fail('missing_fields', { ...extra, missing: extra.missing.includes('disagreements') ? extra.missing : ['disagreements', ...extra.missing] })
  }
  return {
    parsedOk: true,
    consensus: disagreements.length === 0,
    inconclusive: false,
    disagreements,
    reason: undefined,
    ...extra,
  }
}
