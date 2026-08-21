/**
 * W4 分歧视图(纯前端文本对照,零模型调用)。
 *
 * 口径:三家面板的答案按行对照——一行(归一化后)出现在严格多数(>n/2)家
 * = 共识行;否则 = 分歧行(高亮)。少于 2 家有效文本时不做任何标记(没有对照面,不猜)。
 * 太短的行(<6 个归一化字符)不参与判定:客套话/标点行标出来只是噪音。
 * 归一化 = 去全部空白 + 拉丁小写(中文里空白罕有语义;两侧同样处理,
 * 等值语义不变);不改原文展示,只改标记。
 */

export interface DivergenceMarkedLine {
  text: string;
  divergent: boolean;
}

const MIN_LINE_CHARS = 6;

export function normalizeAnswerLine(line: string): string {
  return line.replace(/\s+/g, '').toLowerCase();
}

/** 一行是否参与对照(空行/过短行不标)。 */
export function isComparableLine(normalized: string): boolean {
  return normalized.length >= MIN_LINE_CHARS;
}

/** 共识门槛:严格多数(2 家 → 2;3 家 → 2;4-5 家 → 3)。 */
export function consensusQuorum(count: number): number {
  return Math.max(2, Math.floor(count / 2) + 1);
}

/**
 * 逐家逐行打分歧标记。输入为各家答案全文(undefined/空串 = 该家无文本,不参与)。
 * 返回与输入等长的行数组;无对照面(<2 家)时全部 divergent=false。
 */
export function markDivergentLines(
  texts: readonly (string | undefined)[],
): DivergenceMarkedLine[][] {
  const usable = texts.filter((t): t is string => typeof t === 'string' && t.trim() !== '');
  const linesPerText = texts.map((t) => (t ?? '').split('\n'));
  if (usable.length < 2) {
    return linesPerText.map((lines) => lines.map((text) => ({ text, divergent: false })));
  }

  // 行 → 持有它的家数(每家只计一次)
  const holders = new Map<string, number>();
  const perTextNorm = linesPerText.map((lines) => lines.map(normalizeAnswerLine));
  for (const norms of perTextNorm) {
    const seen = new Set<string>();
    for (const n of norms) {
      if (!isComparableLine(n) || seen.has(n)) continue;
      seen.add(n);
      holders.set(n, (holders.get(n) ?? 0) + 1);
    }
  }

  const quorum = consensusQuorum(usable.length);
  return linesPerText.map((lines, textIndex) => lines.map((text, lineIndex) => {
    const n = perTextNorm[textIndex]?.[lineIndex] ?? normalizeAnswerLine(text);
    return {
      text,
      divergent: isComparableLine(n) && (holders.get(n) ?? 0) < quorum,
    };
  }));
}

/** 摘要数字:分歧行总数(供卡片眉题/台账徽标用)。 */
export function countDivergentLines(marked: readonly DivergenceMarkedLine[][]): number {
  let n = 0;
  for (const lines of marked) for (const line of lines) if (line.divergent) n += 1;
  return n;
}
