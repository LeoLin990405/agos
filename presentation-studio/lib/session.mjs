/**
 * Simultaneous interpretation session.
 *
 * Live captions follow the recognizer's interim hypothesis.
 * A clause is handed to translation when it is finished: a full stop,
 * a comma that is not a dangling fragment, or a pause on a complete tail.
 */

const HARD = /[。！？!?；;\n]/
const HOLD_END = /(?:是|的|在|把|被|和|跟|与|因为|所以|如果|虽然|百分之|就是|那个|呢)$/
const NEW_SENTENCE = /^(?:但是|所以|然后|而且|不过|可是|另外)/
const REPEAT_UNITS = ['那个', '就是', '今天', '我们', '嗯', '啊', '额']
const GLOSS = /^(?:that one|for,?|okay\.?|ia ve|dear all:?|chung-dake\.?)$/i

export function createSession() {
  return {
    partial: '',
    clauses: [],
    nextId: 1,
    provisionalSource: '',
    provisionalEnglish: '',
  }
}

function hanziCount(text) {
  return (String(text).match(/\p{Script=Han}/gu) || []).length
}

export function isHold(text) {
  const raw = String(text || '').trim()
  if (!raw) return true
  const core = raw.replace(/[。！？!?；;，,\s]+$/g, '').trim()
  if (!core) return true
  const compact = core.replace(/[，,\s]/g, '')
  if (/^(?:嗯|啊|额|呃|哦|噢|唔|那个|就是|呢)+$/.test(compact)) return true
  if (HOLD_END.test(core)) return true
  if (hanziCount(core) <= 4 && !HARD.test(raw)) return true
  return false
}

export function isFillerOnly(text) {
  const compact = String(text || '').replace(/[，,。！？!?\s；;、]+/g, '')
  if (!compact) return true
  return /^(?:嗯|啊|额|呃|哦|噢|唔|那个|就是|呢)+$/.test(compact)
}

/** Collapse immediate filler repeats before translation. Real verbs stay. */
export function normalizeMandarin(text) {
  let value = String(text || '').trim()
  for (const unit of REPEAT_UNITS) {
    const pattern = new RegExp(`(?:${unit}[，,、\\s]*){2,}`, 'g')
    value = value.replace(pattern, unit)
  }
  return value.replace(/\s+/g, ' ').trim()
}

export function isSpeakableEnglish(english) {
  const text = String(english || '').trim()
  if (!text) return false
  if (GLOSS.test(text)) return false
  if (/\p{Script=Han}/u.test(text)) return false
  return /[A-Za-z]{2,}/.test(text)
}

function isDigit(ch) {
  return typeof ch === 'string' && ch >= '0' && ch <= '9'
}

export function splitClauses(text) {
  const stable = []
  const chars = [...text]
  let buf = ''
  for (let i = 0; i < chars.length; i += 1) {
    const ch = chars[i]
    buf += ch
    if (ch === ',' && isDigit(chars[i - 1]) && isDigit(chars[i + 1])) continue
    if (HARD.test(ch)) {
      pushPiece(stable, buf)
      buf = ''
      continue
    }
    if (ch === '，' || ch === ',') {
      if (isHold(buf)) continue
      pushPiece(stable, buf)
      buf = ''
    }
  }
  return { stable, tail: buf.trim() }
}

function pushPiece(stable, buf) {
  const piece = buf.trim()
  if (piece && !/^[\s。！？!?；;，,\n]+$/.test(piece)) stable.push(piece)
}

export function committedMandarin(state) {
  return state.clauses.filter((clause) => !clause.provisional).map((clause) => clause.source).join('')
}

export function mandarinCaption(state) {
  return `${committedMandarin(state)}${state.partial}`.trim()
}

export function englishCaption(state) {
  const locked = state.clauses
    .filter((clause) => !clause.provisional && clause.english)
    .map((clause) => clause.english.trim())
    .filter(Boolean)
  if (state.provisionalEnglish) locked.push(state.provisionalEnglish.trim())
  return locked.join(' ').replace(/\s+/g, ' ').trim()
}

function lastClause(state) {
  for (let i = state.clauses.length - 1; i >= 0; i -= 1) {
    if (!state.clauses[i].provisional) return state.clauses[i]
  }
  return null
}

function pushClause(state, source) {
  const norm = source.replace(/\s+/g, ' ').trim()
  if (!norm) return null
  const clause = {
    id: state.nextId++,
    source: norm,
    english: '',
    spoken: false,
    provisional: false,
    context: null,
  }
  state.clauses.push(clause)
  return clause
}

function commonPrefixLength(a, b) {
  const left = [...a]
  const right = [...b]
  let index = 0
  const limit = Math.min(left.length, right.length)
  while (index < limit && left[index] === right[index]) index += 1
  return index
}

function carryProvisional(state, clause) {
  const source = state.provisionalSource
  const english = state.provisionalEnglish
  if (!source || !english || clause.english) return
  const stripped = clause.source.replace(/[。！？!?；;，,]$/u, '')
  if (clause.source === source || stripped === source) clause.english = english
}

/** Drop text the session has already committed, including a cumulative hypothesis. */
function unmatched(state, text) {
  const trimmed = text.trim()
  if (!trimmed) return { fresh: '', sliced: false }
  const committed = committedMandarin(state)
  if (!committed) return { fresh: trimmed, sliced: false }
  if (trimmed.startsWith(committed)) {
    return { fresh: trimmed.slice(committed.length).trim(), sliced: true }
  }
  let index = 0
  const left = [...committed]
  const right = [...trimmed]
  const limit = Math.min(left.length, right.length)
  while (index < limit && left[index] === right[index]) index += 1
  const fresh = right.slice(index).join('').trim()
  return { fresh, sliced: index > 0 }
}

/**
 * If the recognizer extends or revises the last unspoken clause, fold the
 * new text into that clause instead of speaking the leftover suffix.
 * Returns null when the text is not a revision.
 */
function tryRevise(state, trimmed, commitTail, stable) {
  const last = lastClause(state)
  if (!last || last.spoken) return null
  const prior = state.clauses
    .filter((clause) => !clause.provisional && clause !== last)
    .map((clause) => clause.source)
    .join('')
  let rest = trimmed
  if (prior) {
    if (!rest.startsWith(prior)) return null
    rest = rest.slice(prior.length).trim()
  }
  if (!rest) return ''
  const extendsLast = rest.startsWith(last.source)
  const prefix = commonPrefixLength(rest, last.source)
  const near = prefix >= 2 && prefix >= [...last.source].length - 2
  if (!extendsLast && !near) return null
  if (!extendsLast && NEW_SENTENCE.test(rest)) return null
  if (!extendsLast && last.source.startsWith(rest) && [...rest].length < [...last.source].length) {
    return state.partial
  }

  const { stable: parts, tail } = splitClauses(rest)
  if (parts.length === 0) {
    if (commitTail && isHold(rest)) return rest
    if (rest !== last.source) {
      last.source = rest
      last.english = ''
      carryProvisional(state, last)
      stable.push(last)
    }
    return ''
  }

  const [first, ...more] = parts
  if (first !== last.source) {
    last.source = first
    last.english = ''
    carryProvisional(state, last)
    stable.push(last)
  }
  for (const piece of more) {
    const clause = pushClause(state, piece)
    if (!clause) continue
    carryProvisional(state, clause)
    stable.push(clause)
  }
  if (commitTail && tail) {
    if (isHold(tail)) return tail
    const clause = pushClause(state, tail)
    if (clause) {
      carryProvisional(state, clause)
      stable.push(clause)
    }
    return ''
  }
  return tail
}

function commitFresh(state, fresh, commitTail, stable, sliced) {
  const last = lastClause(state)
  const { stable: parts, tail } = splitClauses(fresh)
  const pieces = parts.slice()
  if (commitTail && tail && !isHold(tail)) pieces.push(tail)
  for (const piece of pieces) {
    const clause = pushClause(state, piece)
    if (!clause) continue
    const core = piece.replace(/[。！？!?；;，,\s]+$/g, '')
    if (sliced && last?.spoken && hanziCount(core) <= 3 && !NEW_SENTENCE.test(core)) {
      clause.context = {
        source: last.source,
        english: last.english,
        spoken: true,
        fragment: true,
      }
    }
    carryProvisional(state, clause)
    stable.push(clause)
  }
  if (commitTail && tail && isHold(tail)) return tail
  return commitTail ? '' : tail
}

function absorb(state, text, commitTail, stable) {
  const trimmed = text.trim()
  if (!trimmed) return ''
  const revised = tryRevise(state, trimmed, commitTail, stable)
  if (revised !== null) return revised
  const { fresh, sliced } = unmatched(state, trimmed)
  if (!fresh) return ''
  return commitFresh(state, fresh, commitTail, stable, sliced)
}

/**
 * @param {{ finals?: string[], partial?: string }} update
 * finals are newly finalized chunks only. partial is the current interim hypothesis
 * and may repeat text that was already committed.
 */
export function ingest(state, update = {}) {
  const stable = []
  for (const chunk of update.finals ?? []) absorb(state, chunk, true, stable)
  const tail = absorb(state, update.partial ?? '', false, stable)
  state.partial = tail
  if (state.provisionalSource !== state.partial) {
    state.provisionalSource = ''
    state.provisionalEnglish = ''
  }
  return { stable, provisionalSource: state.partial }
}

/**
 * Promote a paused interim hypothesis so speech does not wait for a final result.
 * A dangling hold (short fragment, filler, or a word like 是/因为) stays in the tail.
 */
export function commitPartial(state, options = {}) {
  const tail = state.partial.trim()
  if (!tail) return []
  if (!options.force && isHold(tail)) return []
  const carried = state.provisionalSource === tail ? state.provisionalEnglish : ''
  state.partial = ''
  state.provisionalSource = ''
  state.provisionalEnglish = ''
  const clause = pushClause(state, tail)
  if (!clause) return []
  if (carried) clause.english = carried
  return [clause]
}

export function setProvisional(state, source, english) {
  if (!source || source !== state.partial) return false
  state.provisionalSource = source
  state.provisionalEnglish = english
  return true
}

export function setClauseEnglish(state, id, english) {
  const clause = state.clauses.find((item) => item.id === id)
  if (!clause) return false
  clause.english = english
  return true
}

/** Read a SpeechRecognition result list from resultIndex forward. */
export function readRecognitionResults(results, resultIndex = 0) {
  const finals = []
  let partial = ''
  const start = Math.max(0, resultIndex)
  for (let i = start; i < results.length; i += 1) {
    const item = results[i]
    const text = typeof item.transcript === 'string' ? item.transcript : item[0]?.transcript ?? ''
    if (item.isFinal) finals.push(text)
    else partial += text
  }
  return { finals, partial }
}
