/**
 * Simultaneous interpretation session.
 *
 * Live captions follow the recognizer's interim hypothesis.
 * A clause is handed to translation and speech as soon as it ends with
 * punctuation, or as soon as the recognizer finalizes it — not when the
 * whole take ends.
 */

const BOUNDARY = /[。！？!?；;\n，,]/

export function createSession() {
  return {
    partial: '',
    clauses: [],
    nextId: 1,
    provisionalSource: '',
    provisionalEnglish: '',
  }
}

export function splitClauses(text) {
  const stable = []
  let buf = ''
  for (const ch of text) {
    buf += ch
    if (BOUNDARY.test(ch)) {
      const piece = buf.trim()
      if (piece && !/^[\s。！？!?；;，,\n]+$/.test(piece)) stable.push(piece)
      buf = ''
    }
  }
  return { stable, tail: buf.trim() }
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

function pushClause(state, source) {
  const norm = source.replace(/\s+/g, ' ').trim()
  if (!norm) return null
  const clause = { id: state.nextId++, source: norm, english: '', spoken: false, provisional: false }
  state.clauses.push(clause)
  return clause
}

/** Drop text the session has already committed, including a cumulative hypothesis. */
function unmatched(state, text) {
  const trimmed = text.trim()
  if (!trimmed) return ''
  const committed = committedMandarin(state)
  if (!committed) return trimmed
  if (trimmed.startsWith(committed)) return trimmed.slice(committed.length).trim()
  let index = 0
  const limit = Math.min(committed.length, trimmed.length)
  while (index < limit && committed[index] === trimmed[index]) index += 1
  return trimmed.slice(index).trim()
}

function absorb(state, text, commitTail, stable) {
  const fresh = unmatched(state, text)
  if (!fresh) return ''
  const { stable: parts, tail } = splitClauses(fresh)
  for (const piece of parts) {
    const clause = pushClause(state, piece)
    if (clause) stable.push(clause)
  }
  if (commitTail && tail) {
    const clause = pushClause(state, tail)
    if (clause) stable.push(clause)
    return ''
  }
  return tail
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

/** Promote a paused interim hypothesis so speech does not wait for a final result. */
export function commitPartial(state) {
  const tail = state.partial.trim()
  const carried = state.provisionalSource === tail ? state.provisionalEnglish : ''
  state.partial = ''
  state.provisionalSource = ''
  state.provisionalEnglish = ''
  if (!tail) return []
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
