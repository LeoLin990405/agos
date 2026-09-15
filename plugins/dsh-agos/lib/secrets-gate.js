// One secret classifier. Two dispositions: refuse persist, or redact for ledgers.
// Prefer false positives. Never keep a credential fragment.
// Scanners are linear / bounded: no unbounded prefix+suffix backtracking.

export const REDACTED = '«redacted»'
export const SECRET_REFUSE_COPY = '候选可能含敏感信息，已拒绝落盘'
export const SECRET_REDACT_COPY = '台账写入前已擦除密钥，路径仍保留'

const WS_RE = /\s/u
const SEPARATOR_EXTRA = new Set([':', '=', '/', ',', '，', '、', '是', '为', '用', '（', '('])

function isIdentChar(code) {
  return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 95
}

function isTokenChar(code) {
  return isIdentChar(code) || code === 43 || code === 47 || code === 61 || code === 45
}

function isSkBodyChar(code) {
  return isIdentChar(code) || code === 45
}

function isPadChar(code) {
  return code === 61 || code === 95 || code === 45
}

const KEYWORD_LEAVES = [
  'authorization',
  'credential',
  'api_key',
  'access_key',
  'api-key',
  'access-key',
  'api key',
  'access key',
  'apikey',
  'accesskey',
  'password',
  'passwd',
  'secret',
  'token',
  'cookie',
  'login',
  'auth',
  '密码',
  '口令',
  '密钥',
  '令牌',
  '凭据',
  '登录',
  '账号',
]

const ASSIGN_NEEDLES = ['password', 'secret', 'token', 'key']

// Bounded copies of the historical recognizers. Safe to .test() on long runs.
// Keyword mention is implemented as a linear scan; this regex stays bounded
// so other plugins that import SECRET_PATTERNS cannot reintroduce ReDoS.
export const SECRET_PATTERNS = [
  /-----BEGIN [A-Z ]{0,40}PRIVATE KEY-----/i,
  /(?:[A-Z0-9_]{0,64}(?:API_KEY|ACCESS_KEY|SECRET|TOKEN|PASSWORD|PASSWD|COOKIE|AUTHORIZATION)|api[ -]?key|access[ -]?key|secret|token|password|passwd|cookie|authorization|auth|credential|login|密码|口令|密钥|令牌|凭据|登录|账号)[\s:=/,，、是为用（(]{0,8}\S{3,256}/iu,
  /\b[a-z][a-z0-9+.-]{0,32}:\/\/[^\s:@/]{0,128}:[^\s@/]{3,256}@/iu,
  /\bbearer\s+[A-Za-z0-9._~+/=-]{12,256}/iu,
  /\b(?:sk|gh[opusr]|xox[baprs])-?[A-Za-z0-9_-]{16,256}\b/u,
  /\bAKIA[0-9A-Z]{16}\b/u,
  /\beyJ[A-Za-z0-9_-]{10,256}\.[A-Za-z0-9_-]{10,256}\.[A-Za-z0-9_-]{10,256}\b/u,
]

const STRUCTURAL_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/i,
  /\bbearer\s+[A-Za-z0-9._~+/=-]{12,}/iu,
  /\b(?:sk|gh[opusr]|xox[baprs])-?[A-Za-z0-9_-]{16,}\b/u,
  SECRET_PATTERNS[5],
]

function asciiFold(text, unicodeCase = false) {
  let out = ''
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i)
    // These are the two non-ASCII characters folded into [a-z] by /iu.
    // Unlike full toLowerCase(), both preserve UTF-16 offsets into the source.
    out += unicodeCase && code === 0x017F ? 's'
      : unicodeCase && code === 0x212A ? 'k'
        : code >= 65 && code <= 90 ? String.fromCharCode(code + 32) : text[i]
  }
  return out
}

function isWhitespaceAt(text, index) {
  const cp = text.codePointAt(index)
  if (cp === undefined) return false
  return WS_RE.test(String.fromCodePoint(cp))
}

function isSeparatorAt(text, index) {
  const cp = text.codePointAt(index)
  if (cp === undefined) return false
  const ch = String.fromCodePoint(cp)
  return WS_RE.test(ch) || SEPARATOR_EXTRA.has(ch)
}

function codePointSize(text, index) {
  const cp = text.codePointAt(index)
  return cp > 0xFFFF ? 2 : 1
}

function hasKeywordValue(text, end) {
  let index = end
  // The former {0,8} separator group could backtrack. Preserve every legal
  // split (including '=' as part of a short value) with constant bounded work.
  for (let separators = 0; separators <= 8; separators += 1) {
    let probe = index
    let nonSpace = 0
    while (probe < text.length && nonSpace < 3 && !isWhitespaceAt(text, probe)) {
      probe += codePointSize(text, probe)
      nonSpace += 1
    }
    if (nonSpace >= 3) return true
    if (separators === 8 || !isSeparatorAt(text, index)) break
    index += codePointSize(text, index)
  }
  return false
}

function hasKeywordCredential(text) {
  const folded = asciiFold(text, true)
  for (const keyword of KEYWORD_LEAVES) {
    let from = 0
    while (from <= folded.length - keyword.length) {
      const at = folded.indexOf(keyword, from)
      if (at === -1) break
      if (hasKeywordValue(text, at + keyword.length)) return true
      from = at + 1
    }
  }
  return false
}

function isSchemeChar(code) {
  return isIdentChar(code) && code !== 95 || code === 43 || code === 46 || code === 45
}

function hasUrlPassword(text) {
  const folded = asciiFold(text, true)
  let from = 0
  while (from < text.length) {
    const marker = text.indexOf('://', from)
    if (marker === -1) return false
    from = marker + 3
    let start = marker
    while (start > 0 && isSchemeChar(folded.charCodeAt(start - 1))) start -= 1
    let scheme = false
    for (let i = start; i < marker; i += 1) {
      const code = folded.charCodeAt(i)
      if (code >= 97 && code <= 122 && (i === 0 || !isIdentChar(folded.charCodeAt(i - 1)))) {
        scheme = true
        break
      }
    }
    if (!scheme) continue
    let userEnd = from
    while (userEnd < text.length && !isWhitespaceAt(text, userEnd) && !':@/'.includes(text[userEnd])) userEnd += 1
    if (text[userEnd] !== ':') continue
    let passEnd = userEnd + 1
    while (passEnd < text.length && !isWhitespaceAt(text, passEnd) && !'@/'.includes(text[passEnd])) passEnd += 1
    if (text[passEnd] === '@' && [...text.slice(userEnd + 1, passEnd)].length >= 3) return true
  }
  return false
}

function hasJwt(text) {
  // Split maximal JWT-character runs once. Searching a greedy first component
  // from every '-eyJ' near-match would rescan the same suffix quadratically.
  let index = 0
  while (index < text.length) {
    while (index < text.length && !isSkBodyChar(text.charCodeAt(index)) && text[index] !== '.') index += 1
    const start = index
    while (index < text.length && (isSkBodyChar(text.charCodeAt(index)) || text[index] === '.')) index += 1
    const parts = text.slice(start, index).split('.')
    let offset = start
    for (let part = 0; part + 2 < parts.length; part += 1) {
      const first = parts[part]
      if (parts[part + 1].length >= 10 && parts[part + 2].length >= 10) {
        let from = 0
        while (from <= first.length - 13) {
          const at = first.indexOf('eyJ', from)
          if (at === -1 || first.length - at < 13) break
          const absolute = offset + at
          if (absolute === 0 || !isIdentChar(text.charCodeAt(absolute - 1))) {
            const third = parts[part + 2]
            for (let end = 10; end <= third.length; end += 1) {
              if (isIdentChar(third.charCodeAt(end - 1)) !== isIdentChar(third.charCodeAt(end))) return true
            }
            break
          }
          from = at + 1
        }
      }
      offset += first.length + 1
    }
  }
  return false
}

function matchesSecretPattern(text) {
  if (hasKeywordCredential(text)) return true
  return hasUrlPassword(text) || hasJwt(text) || STRUCTURAL_PATTERNS.some((pattern) => {
    pattern.lastIndex = 0
    return pattern.test(text)
  })
}

function sampleHighEntropy(text, start, end) {
  const length = end - start
  if (length < 24) return false
  const classes = [/[a-z]/u, /[A-Z]/u, /[0-9]/u, /[+/_=-]/u]
    .reduce((sum, pattern) => {
      pattern.lastIndex = 0
      return sum + Number(pattern.test(text.slice(start, end)))
    }, 0)
  const frequencies = new Map()
  for (let i = start; i < end; i += 1) {
    const ch = text[i]
    frequencies.set(ch, (frequencies.get(ch) ?? 0) + 1)
  }
  const uniqueRatio = frequencies.size / length
  let entropy = 0
  for (const count of frequencies.values()) {
    const probability = count / length
    entropy -= probability * Math.log2(probability)
  }
  return (classes >= 3 && uniqueRatio >= 0.35)
    || (length >= 24 && entropy >= 3.5)
}

export function highEntropyToken(value) {
  const text = String(value)
  const length = text.length
  let i = 0
  while (i < length) {
    while (i < length && !isTokenChar(text.charCodeAt(i))) i += 1
    const start = i
    while (i < length && isTokenChar(text.charCodeAt(i))) i += 1
    if (i - start < 24) continue
    let end = i
    while (end > start && isPadChar(text.charCodeAt(end - 1))) end -= 1
    if (end - start >= 24 && sampleHighEntropy(text, start, end)) return true
  }
  return false
}

export function classifySecret(value) {
  const text = String(value ?? '')
  const reasons = []
  if (matchesSecretPattern(text)) reasons.push('pattern')
  if (highEntropyToken(text)) reasons.push('entropy')
  return { sensitive: reasons.length > 0, reasons }
}

export function isSensitiveText(value) {
  return classifySecret(value).sensitive
}

function matchEquals(text, start) {
  let index = start
  while (index < text.length && isWhitespaceAt(text, index)) index += codePointSize(text, index)
  if (text[index] !== '=') return null
  index += 1
  while (index < text.length && isWhitespaceAt(text, index)) index += codePointSize(text, index)
  return { end: index }
}

function matchAssignedValue(text, start) {
  if (text[start] === '"' || text[start] === "'") {
    const quote = text[start]
    for (let index = start + 1; index < text.length; index += 1) {
      if (text[index] === '\\') { index += 1; continue }
      if (text[index] === quote) return { end: index + 1 }
    }
    // An unterminated quoted credential has no safe trailing-text boundary.
    return { end: text.length }
  }
  let index = start
  while (index < text.length && !isWhitespaceAt(text, index)) index += 1
  if (index === start) return null
  return { end: index }
}

function findNextAssignNeedle(folded, from) {
  // Scan monotonically. Four independent indexOf calls at each hit rescan the
  // entire suffix for absent keywords, e.g. 'token '.repeat(n), and are O(n²).
  for (let at = from; at < folded.length; at += 1) {
    for (const needle of ASSIGN_NEEDLES) {
      if (folded.startsWith(needle, at)) return { index: at, length: needle.length }
    }
  }
  return null
}

function scrubAssignments(text) {
  const folded = asciiFold(text)
  let out = ''
  let i = 0
  while (i < text.length) {
    const hit = findNextAssignNeedle(folded, i)
    if (!hit) {
      out += text.slice(i)
      break
    }
    let start = hit.index
    while (start > i && isIdentChar(text.charCodeAt(start - 1))) start -= 1
    const afterKeyword = matchEquals(text, hit.index + hit.length)
    const value = afterKeyword ? matchAssignedValue(text, afterKeyword.end) : null
    if (!afterKeyword || !value) {
      out += text.slice(i, hit.index + 1)
      i = hit.index + 1
      continue
    }
    out += text.slice(i, start) + text.slice(start, afterKeyword.end) + REDACTED
    i = value.end
  }
  return out
}

function scrubSkTokens(text) {
  let out = ''
  let i = 0
  while (i < text.length) {
    const at = text.indexOf('sk-', i)
    if (at === -1) {
      out += text.slice(i)
      break
    }
    let end = at + 3
    while (end < text.length && isSkBodyChar(text.charCodeAt(end))) end += 1
    if (end - (at + 3) >= 16) {
      out += text.slice(i, at) + REDACTED
      i = end
    } else {
      out += text.slice(i, at + 1)
      i = at + 1
    }
  }
  return out
}

function scrubBearerTokens(text) {
  const folded = asciiFold(text)
  let out = ''
  let i = 0
  while (i < text.length) {
    const at = folded.indexOf('bearer', i)
    if (at === -1) {
      out += text.slice(i)
      break
    }
    let end = at + 6
    let spaces = 0
    while (end < text.length && isWhitespaceAt(text, end)) {
      end += codePointSize(text, end)
      spaces += 1
    }
    if (spaces === 0) {
      out += text.slice(i, at + 1)
      i = at + 1
      continue
    }
    const valueStart = end
    while (end < text.length && !isWhitespaceAt(text, end)) end += 1
    if (end === valueStart) {
      out += text.slice(i, valueStart)
      i = valueStart
      continue
    }
    out += text.slice(i, valueStart) + REDACTED
    i = end
  }
  return out
}

export function scrubString(value) {
  return scrubAssignments(scrubBearerTokens(scrubSkTokens(String(value))))
}

export function scrubSecrets(value, seen = new WeakSet()) {
  if (typeof value === 'string') return scrubString(value)
  if (value === null || typeof value !== 'object') return value
  if (seen.has(value)) return undefined
  seen.add(value)
  if (Array.isArray(value)) return value.map((item) => scrubSecrets(item, seen))
  const out = {}
  for (const [key, item] of Object.entries(value)) out[scrubString(key)] = scrubSecrets(item, seen)
  return out
}
