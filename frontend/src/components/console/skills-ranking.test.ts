import assert from 'node:assert/strict';
import test from 'node:test';
import type { SkillCatalogEntry } from './skills-model.ts';
import {
  LEXICAL_EVAL_COPY,
  RERANK_UNAVAILABLE_COPY,
  lexicalOverlap,
  rerankStatus,
  runLexicalTriggerEvals,
  shortlistSkills,
  suggestDescription,
  tokenize,
} from './skills-ranking.ts';

const catalog: SkillCatalogEntry[] = [
  { name: 'inbox-triage', description: '每当用户要清理收件箱或说 inbox 时使用本技能。', modelInvocable: true, category: 'functional / tools / methodology' },
  { name: 'playwright', description: '每当用户要浏览器自动化或说 playwright 时使用本技能。', modelInvocable: true, category: 'functional / tools / methodology' },
  { name: 'book-chaos', description: '每当讨论混沌或复杂度阅读时使用本技能。', modelInvocable: true, category: 'books' },
];

test('tokenize keeps latin words and CJK bigrams', () => {
  const tokens = tokenize('整理 Inbox 收件箱');
  assert.equal(tokens.includes('inbox'), true);
  assert.equal(tokens.includes('收件'), true);
  assert.equal(tokens.includes('件箱'), true);
});

test('shortlist is lexical overlap and empty query stays uncollected', () => {
  assert.deepEqual(shortlistSkills(catalog, ''), []);
  const hits = shortlistSkills(catalog, '帮我整理 inbox 收件箱');
  assert.equal(hits[0]?.name, 'inbox-triage');
  assert.equal(hits[0]?.method, 'lexical-overlap');
  assert.equal(hits.some((row) => row.name === 'book-chaos'), false);
});

test('lexical trigger evals do not claim model trigger rates', () => {
  const report = runLexicalTriggerEvals(
    '每当用户要清理收件箱或说 inbox 时使用本技能。',
    [
      { query: '整理我的收件箱', shouldTrigger: true },
      { query: 'inbox 里哪些要回', shouldTrigger: true },
      { query: '帮我改这段 React 组件的样式', shouldTrigger: false },
      { query: '把这篇论文做成读书笔记', shouldTrigger: false },
    ],
  );
  assert.equal(report.note, LEXICAL_EVAL_COPY);
  assert.equal(report.should.total, 2);
  assert.equal(report.shouldNot.total, 2);
  assert.equal(report.rows.every((row) => row.shouldTrigger === false || row.score > 0), true);
});

test('suggestDescription only adds should-trigger phrases that miss the current text', () => {
  const missed = suggestDescription(
    '每当用户提到 inbox 时使用本技能。',
    [
      { query: '整理收件箱里的订阅邮件', shouldTrigger: true },
      { query: '改 React 样式', shouldTrigger: false },
    ],
  );
  assert.equal(missed.changed, true);
  assert.match(missed.next, /整理收件箱里的订阅邮件/);
  assert.doesNotMatch(missed.next, /改 React 样式/);
  const already = suggestDescription(
    '每当用户要清理收件箱或说 inbox 时使用本技能。',
    [{ query: 'inbox', shouldTrigger: true }],
  );
  assert.equal(already.changed, false);
});

test('rerank stays unavailable without inventing a host model', () => {
  assert.deepEqual(rerankStatus(), { available: false, copy: RERANK_UNAVAILABLE_COPY });
  assert.equal(lexicalOverlap('', 'inbox'), 0);
});
