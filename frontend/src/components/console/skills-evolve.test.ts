import assert from 'node:assert/strict';
import test from 'node:test';
import type { SkillCatalogEntry } from './skills-model.ts';
import {
  CALL_IS_NOT_VERDICT_COPY,
  CATALOG_TRIM_OFF_COPY,
  POSTERIOR_METHOD_COPY,
  applySkillOutcome,
  blendShortlist,
  lastUserQuery,
  normalizeEvolveLabel,
  parseEvolveReport,
  posteriorMean,
  proposeSkillEvolve,
  selectTrimNames,
  trimCatalogEntries,
} from './skills-evolve.ts';
import { shortlistSkills } from './skills-ranking.ts';

const catalog: SkillCatalogEntry[] = [
  { name: 'inbox-triage', description: '每当用户要清理收件箱或说 inbox 时使用本技能。', modelInvocable: true, category: 'functional / tools / methodology' },
  { name: 'playwright', description: '每当用户要浏览器自动化或说 playwright 时使用本技能。', modelInvocable: true, category: 'functional / tools / methodology' },
  { name: 'book-chaos', description: '每当讨论混沌或复杂度阅读时使用本技能。', modelInvocable: true, category: 'books' },
];

test('empty query does not invent an evolve shortlist', () => {
  const report = proposeSkillEvolve(catalog, '   ', []);
  assert.deepEqual(report.hits, []);
  assert.equal(report.note, POSTERIOR_METHOD_COPY);
  assert.equal(report.catalogTrim.enabled, false);
  assert.equal(report.catalogTrim.copy, CATALOG_TRIM_OFF_COPY);
});

test('cold start keeps lexical bench order', () => {
  const report = proposeSkillEvolve(catalog, '帮我整理 inbox 收件箱', []);
  assert.equal(report.hits[0]?.name, 'inbox-triage');
  assert.equal(report.hits[0]?.method, 'lexical+posterior');
  assert.equal(report.matchingLabel, 0);
});

test('posterior from the same label can promote a lower lexical hit', () => {
  const lexical = shortlistSkills(catalog, 'inbox 和 playwright');
  assert.ok(lexical.length >= 2);
  const promoted = blendShortlist(lexical, [
    { label: 'inbox', skill: lexical[1]!.name, result: 'ok' },
    { label: 'inbox', skill: lexical[1]!.name, result: 'ok' },
    { label: 'inbox', skill: lexical[0]!.name, result: 'fail' },
  ], 'inbox');
  assert.equal(promoted[0]?.name, lexical[1]!.name);
});

test('outcomes on another label do not reorder this query', () => {
  const lexical = shortlistSkills(catalog, '帮我整理 inbox 收件箱');
  const blended = blendShortlist(lexical, [
    { label: 'browser', skill: 'playwright', result: 'ok' },
    { label: 'browser', skill: 'playwright', result: 'ok' },
  ], 'inbox');
  assert.equal(blended[0]?.name, lexical[0]?.name);
});

test('one failure does not starve a listed skill', () => {
  const mean = posteriorMean(0.6, { s: 0, f: 1 });
  assert.ok(mean > 0.2);
  const next = applySkillOutcome([], { label: 'inbox', skill: 'inbox-triage', result: 'fail' });
  assert.equal(next.length, 1);
});

test('trim refuses to empty the catalog', () => {
  assert.deepEqual(trimCatalogEntries(catalog, []), { ok: false, reason: 'empty-shortlist' });
  assert.deepEqual(trimCatalogEntries(catalog, ['missing']), { ok: false, reason: 'no-overlap' });
  const trimmed = trimCatalogEntries(catalog, ['inbox-triage', 'missing']);
  assert.equal(trimmed.ok, true);
  if (trimmed.ok) assert.deepEqual(trimmed.entries.map((row) => row.name), ['inbox-triage']);
  assert.deepEqual(selectTrimNames([{ name: 'inbox-triage' } as never], 8), ['inbox-triage']);
});

test('parseEvolveReport keeps honesty fields and does not invent hits', () => {
  const parsed = parseEvolveReport({
    query: 'inbox',
    label: 'inbox',
    hits: [{ name: 'inbox-triage', lexical: 0.5, posterior: 0.6, benchRank: 1, evidence: { s: 1, f: 0 } }],
    evidenceRows: 1,
    matchingLabel: 1,
    catalogTrim: { enabled: false, copy: CATALOG_TRIM_OFF_COPY },
    rerank: { available: false, copy: '小模型重排未采集：宿主没有推荐接口' },
  });
  assert.equal(parsed.hits[0]?.name, 'inbox-triage');
  assert.equal(parsed.rerank?.available, false);
  assert.deepEqual(parseEvolveReport({ hits: [null, { name: '' }] }).hits, []);
});

test('last user query skips catalog injections', () => {
  assert.equal(lastUserQuery([
    { role: 'user', content: [{ type: 'text', text: '整理收件箱' }] },
    { role: 'user', source: { kind: 'skill-catalog' }, content: [{ type: 'text', text: 'available_skills' }] },
    { role: 'user', source: { kind: 'session-memory' }, content: [{ type: 'text', text: '不要改 fold' }] },
  ]), '整理收件箱');
  assert.equal(normalizeEvolveLabel(' Inbox Triage '), 'inbox-triage');
  assert.equal(CALL_IS_NOT_VERDICT_COPY.includes('不是胜负'), true);
});
