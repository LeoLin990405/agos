import { createHash } from 'node:crypto'

// Semantic labels for selector.route() clustering.
// FuguNano hashed the raw artifact; natural-language reviews almost never match.
// AgOS uses a closed verdict set + a short kebab class — never a content hash.

const VERDICT_ALIASES = new Map([
  ['allow', 'allow'],
  ['permit', 'allow'],
  ['approve', 'allow'],
  ['pass', 'allow'],
  ['放行', 'allow'],
  ['通过', 'allow'],
  // 评审语里最常见的几个,原表缺:「不同意」要能读成 deny,前提是「同意」在表里
  ['同意', 'allow'],
  ['批准', 'allow'],
  ['认可', 'allow'],
  ['deny', 'deny'],
  ['reject', 'deny'],
  ['block', 'deny'],
  ['拒绝', 'deny'],
  ['否决', 'deny'],
  ['驳回', 'deny'],
  ['反对', 'deny'],
  ['unsure', 'unsure'],
  ['unknown', 'unsure'],
  ['ambiguous', 'unsure'],
  ['存疑', 'unsure'],
  ['不确定', 'unsure'],
])

const CLASS_ALIASES = new Map([
  ['code-review', 'code-review'],
  ['review', 'code-review'],
  ['评审', 'code-review'],
  ['coding', 'coding'],
  ['implement', 'coding'],
  ['编码', 'coding'],
  ['planning', 'planning'],
  ['plan', 'planning'],
  ['规划', 'planning'],
  ['sql', 'sql'],
  ['docs', 'docs'],
  ['文档', 'docs'],
  ['research', 'research'],
  ['researching', 'research'],
])

/** 类标签长度上限。超过即判不可聚类(见 normalizeClass 里的说明)。 */
const MAX_CLASS_LABEL = 32

function fold(text) {
  return String(text ?? '')
    .trim()
    .toLowerCase()
    .replace(/[“”"'`]/g, '')
    .replace(/[\s_]+/g, ' ')
}

// 否定词。判词前面挂了否定就不能按原义读:「不建议合入」里含「建议」、
// 「do not approve」里含「approve」,按原样匹配会把反对读成同意(2026-08-22 验收 P1)。
const NEGATORS = new Set([
  'not', 'no', 'never', "don't", 'dont', 'cannot', "can't", 'without',
  '不', '别', '勿', '未', '非', '无', '不要', '不予', '不能', '不该', '不应', '不建议', '不同意',
])

// 切词:ASCII 标点 + **中文全角标点**。原来只切 /[\s,.;:|/]+/,
// 于是「放行,因为无风险」能命中而「放行,因为无风险」(全角逗号)命中不了 ——
// 中文正常书写用全角标点,那 6 条中文别名实际只在「光秃秃一个词」时才生效。
const TOKEN_SPLIT = /[\s,.;:|/、,。;:!?!?()()《》「」【】…—]+/u

/** 否定后的判词:allow → deny(明确反对);deny → unsure(双重否定语义不明,不猜) */
const NEGATED = { allow: 'deny', deny: 'unsure', unsure: 'unsure' }

export function normalizeVerdict(text) {
  const raw = fold(text)
  if (!raw) return undefined
  if (VERDICT_ALIASES.has(raw)) return VERDICT_ALIASES.get(raw)
  const tokens = raw.split(TOKEN_SPLIT).filter(Boolean)
  const hitIndex = tokens.findIndex((t) => VERDICT_ALIASES.has(t))
  if (hitIndex === -1) {
    // 中文常写成「不建议合入」这种黏连形式,切不出独立 token,按子串再找一遍。
    for (const [alias, verdict] of VERDICT_ALIASES) {
      if (!/^[\u4e00-\u9fff]+$/u.test(alias) || !raw.includes(alias)) continue
      const at = raw.indexOf(alias)
      const before = raw.slice(Math.max(0, at - 3), at)
      return [...NEGATORS].some((n) => /^[\u4e00-\u9fff]+$/u.test(n) && before.endsWith(n))
        ? NEGATED[verdict] : verdict
    }
    return undefined
  }
  const verdict = VERDICT_ALIASES.get(tokens[hitIndex])
  // 判词前两个 token 内出现否定词即翻转
  const negated = tokens.slice(Math.max(0, hitIndex - 2), hitIndex).some((t) => NEGATORS.has(t))
  return negated ? NEGATED[verdict] : verdict
}

export function normalizeClass(text) {
  const raw = fold(text)
  if (!raw) return undefined
  if (CLASS_ALIASES.has(raw)) return CLASS_ALIASES.get(raw)
  const kebab = raw.replace(/[^a-z0-9\u4e00-\u9fff]+/gu, '-').replace(/^-+|-+$/g, '')
  if (!kebab) return undefined
  if (CLASS_ALIASES.has(kebab)) return CLASS_ALIASES.get(kebab)
  // ⚠️ 原来这里 .slice(0, 32) 后再放行:两段**结论相反**的评审只要前 32 字符相同
  // 就会拿到同一个 label,被 route() 判成同簇 → TRUST_SPOT_CHECK/agreementShare 1,
  // 也就是**凭空编造出一个不存在的共识**(2026-08-22 验收 P0,撞「数据零编造」)。
  // 截断出来的前缀不是语义相等。改成:超长时用**规范化全文的哈希**当标签 ——
  // 精确相等语义(相同文本必同簇)、长度有界、且不可能凭前缀撞出假相等。
  // 与 FuguNano 那个 sha256 的区别:它哈的是**原始 artifact**(人人不同,恒 ESCALATE),
  // 这里哈的是 fold+kebab 之后的**规范化**文本,措辞相同即同簇。
  if (kebab.length > MAX_CLASS_LABEL) {
    return kebab.slice(0, 16) + '~' + createHash('sha256').update(kebab).digest('hex').slice(0, 12)
  }
  // ⚠️ 原来的放行闸 /^[a-z0-9]+(?:-[a-z0-9]+)*$/ 不含汉字,而上一行特意保留了
  // \u4e00-\u9fff —— 于是任何未精确命中别名表的中文一律落到 undefined,
  // 上一行的 CJK 字符类是死代码,「恒 ESCALATE」原样保留(验收 P0)。
  if (/^[a-z0-9\u4e00-\u9fff]+(?:-[a-z0-9\u4e00-\u9fff]+)*$/u.test(kebab)) return kebab
  return undefined
}

/** Prefer an explicit selector label, else a verdict word. Never use pick: a model id is not a task class. */
export function semanticLabel({ label, reason } = {}) {
  const fromLabel = normalizeClass(label) || normalizeVerdict(label)
  if (fromLabel) return fromLabel
  return normalizeVerdict(reason) || normalizeClass(reason)
}

export function candidatesForRoute(rows) {
  return rows.map((row) => ({
    agent: row.id || row.agent,
    verified: row.verified,
    label: semanticLabel(row),
  }))
}
