/**
 * council 工具落盘形状。与 vision 路径同口径:
 * kind 必写;disagreements 是独立数组;verdict 不再 join 压分歧。
 * (TASK-018 W1:017 只修了 vision,评审路径仍在造「本条记录早于该字段」。)
 */

/** 仲裁把分歧写成对象数组时常用的文本字段,按这个顺序取第一个非空的。 */
const DISAGREEMENT_TEXT_KEYS = ['point', 'text', 'summary', 'detail', 'claim', 'issue', 'note', 'description']

/** 结构在、但读不出文本的分歧项。留下它是为了不让条数变成 0。 */
export const UNREADABLE_DISAGREEMENT = '(仲裁给出一条无法解析的分歧项)'

/**
 * 归一化分歧项。vision 与 review 共用。
 *
 * ⚠️ 原来是「非字符串项一律 continue 丢弃」。018 之后 consensus 改成由
 * disagreements.length 派生(index.js:1547),于是丢弃直接改写结论:仲裁返回
 * {consensus:false, disagreements:[{point:'…'},{point:'…'}]}(模型把分歧写成对象
 * 数组是常见形态,提示词只是要求字符串数组、没有强制)时,两条全被丢掉 →
 * length===0 → consensus 派生成 true → 台账落盘「各家一致」。仲裁明说不一致,
 * 界面上却写一致 —— 正是 018/019 一路在清的「凭空造出一个并不存在的结论」
 * (2026-08-22 验收 P1,离线跑 desktop 真源复现)。
 *
 * 现在:能读出文本的照读;读不出的留一条占位。**只有真正空的项才丢**
 * (null / undefined / 空串 / 全空白),那种项本来就不承载任何分歧。
 * 仍然不会出现「[object Object]」或「null」。
 */
export function normalizeDisagreementItems(raw) {
  if (!Array.isArray(raw)) return []
  const out = []
  for (const item of raw) {
    if (item === null || item === undefined) continue
    if (typeof item === 'string') {
      const text = item.trim()
      if (text) out.push(text)
      continue
    }
    if (typeof item === 'number' || typeof item === 'boolean') {
      out.push(String(item))
      continue
    }
    if (typeof item === 'object' && !Array.isArray(item)) {
      let picked = ''
      for (const key of DISAGREEMENT_TEXT_KEYS) {
        const v = item[key]
        if (typeof v === 'string' && v.trim()) { picked = v.trim(); break }
      }
      out.push(picked || UNREADABLE_DISAGREEMENT)
      continue
    }
    if (Array.isArray(item)) {
      const inner = normalizeDisagreementItems(item)
      out.push(inner.length ? inner.join(' / ') : UNREADABLE_DISAGREEMENT)
      continue
    }
    out.push(UNREADABLE_DISAGREEMENT)
  }
  return out
}

export function disagreementsFromParsed(parsed) {
  if (!parsed || !Array.isArray(parsed.disagreements)) return []
  return normalizeDisagreementItems(parsed.disagreements)
}

export function councilReviewVerdict({ arbOk, arbError, arbText, parsed, consensus, flagged }) {
  if (!arbOk) return '仲裁失败: ' + arbError
  if (!parsed) {
    return '⚠️ 仲裁未按 JSON 格式返回,以下为原文(本次不计入台账判定):\n' + arbText
  }
  const suspects = Array.isArray(flagged) ? flagged : []
  return (consensus ? '各家一致。' : '存在分歧。') +
    (suspects.length ? '疑似编造:' + suspects.join('、') + '(' + (parsed.reason || '') + ')\n' : '') +
    '结论:' + (parsed.conclusion || '')
}

export function buildCouncilReviewRecord({
  question,
  hadImages,
  arbiter,
  arbiterMetered,
  consensus,
  inconclusive,
  parsedOk,
  panelists,
  verdict,
  disagreements,
  flagged,
  time,
}) {
  return {
    kind: 'review',
    parsedOk: !!parsedOk,
    time: time || new Date().toISOString(),
    question: String(question || '').slice(0, 160),
    hadImages,
    arbiter,
    arbiterMetered,
    consensus,
    inconclusive: inconclusive === true,
    panelists,
    verdict: String(verdict || '').slice(0, 4000),
    disagreements: Array.isArray(disagreements) ? disagreements : [],
    flagged,
  }
}
