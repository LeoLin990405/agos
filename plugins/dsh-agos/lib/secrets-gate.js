// One secret classifier. Two dispositions: refuse persist, or redact for ledgers.
// Prefer false positives. Never keep a credential fragment.

export const REDACTED = '«redacted»'
export const SECRET_REFUSE_COPY = '候选可能含敏感信息，已拒绝落盘'
export const SECRET_REDACT_COPY = '台账写入前已擦除密钥，路径仍保留'

export const SECRET_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/i,
  /(?:[A-Z0-9_]*(?:API_KEY|ACCESS_KEY|SECRET|TOKEN|PASSWORD|PASSWD|COOKIE|AUTHORIZATION)|api[ -]?key|access[ -]?key|secret|token|password|passwd|cookie|authorization|auth|credential|login|密码|口令|密钥|令牌|凭据|登录|账号)[\s:=/,，、是为用（(]{0,8}\S{3,}/iu,
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]*:[^\s@/]{3,}@/iu,
  /\bbearer\s+[A-Za-z0-9._~+/=-]{12,}/iu,
  /\b(?:sk|gh[opusr]|xox[baprs])-?[A-Za-z0-9_-]{16,}\b/u,
  /\bAKIA[0-9A-Z]{16}\b/u,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/u,
]

export function highEntropyToken(value) {
  const tokens = String(value).match(/[A-Za-z0-9+/_=-]{24,}/gu) ?? []
  return tokens.some((token) => {
    const sample = token.replace(/[=_-]+$/u, '')
    if (sample.length < 24) return false
    const classes = [/[a-z]/u, /[A-Z]/u, /[0-9]/u, /[+/_=-]/u]
      .reduce((sum, pattern) => sum + Number(pattern.test(sample)), 0)
    const uniqueRatio = new Set(sample).size / sample.length
    const frequencies = new Map()
    for (const ch of sample) frequencies.set(ch, (frequencies.get(ch) ?? 0) + 1)
    let entropy = 0
    for (const count of frequencies.values()) {
      const probability = count / sample.length
      entropy -= probability * Math.log2(probability)
    }
    return (classes >= 3 && uniqueRatio >= 0.35)
      || (sample.length >= 24 && entropy >= 3.5)
  })
}

export function classifySecret(value) {
  const text = String(value ?? '')
  const reasons = []
  if (SECRET_PATTERNS.some((pattern) => pattern.test(text))) reasons.push('pattern')
  if (highEntropyToken(text)) reasons.push('entropy')
  return { sensitive: reasons.length > 0, reasons }
}

export function isSensitiveText(value) {
  return classifySecret(value).sensitive
}

export function scrubString(value) {
  return String(value)
    .replace(/sk-[A-Za-z0-9_-]{16,}/g, REDACTED)
    .replace(/(Bearer\s+)\S+/gi, `$1${REDACTED}`)
    .replace(/([A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD)\s*=\s*)(?:"[^"]*"|'[^']*'|\S+)/gi, `$1${REDACTED}`)
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
