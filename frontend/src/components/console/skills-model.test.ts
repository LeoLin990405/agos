import assert from 'node:assert/strict';
import test from 'node:test';
import {
  clipDescription,
  filterCatalog,
  filterSkillFindings,
  groupCatalogByCategory,
  mergeRpcCatalog,
  neverUsedCount,
  parseSkillsPayload,
  sortCatalog,
  type SkillCatalogEntry,
  type SkillFinding,
} from './skills-model.ts';

const findings: SkillFinding[] = [
  { sev: 'warn', check: 'frontmatter', skill: 'alpha/SKILL.md', msg: 'missing description' },
  { sev: 'error', check: 'links', skill: 'beta/SKILL.md', msg: 'broken reference' },
];

const catalog: SkillCatalogEntry[] = [
  { name: 'playwright', description: 'Browser automation', modelInvocable: true, category: 'functional / tools / methodology', pathsGateCandidate: true },
  { name: 'book-chaos', description: 'Complexity reading', modelInvocable: true, category: 'books' },
  { name: 'ask', description: 'Short helper', modelInvocable: false, category: 'functional / tools / methodology' },
];

test('filterSkillFindings searches true finding fields and preserves empty-query results', () => {
  assert.deepEqual(filterSkillFindings(findings, '').map((item) => item.skill), ['alpha/SKILL.md', 'beta/SKILL.md']);
  assert.deepEqual(filterSkillFindings(findings, 'BROKEN').map((item) => item.skill), ['beta/SKILL.md']);
  assert.deepEqual(filterSkillFindings(findings, 'frontmatter').map((item) => item.skill), ['alpha/SKILL.md']);
  assert.deepEqual(filterSkillFindings(findings, 'not-present'), []);
});

test('parseSkillsPayload distinguishes a true empty audit from missing or malformed roots', () => {
  assert.deepEqual(parseSkillsPayload({ roots: [], librarian: '/tool', at: 1 }).roots, []);
  assert.throws(() => parseSkillsPayload({ librarian: '/tool' }), /缺少 roots 数组/);
  assert.throws(() => parseSkillsPayload({ roots: {} }), /缺少 roots 数组/);
  assert.throws(() => parseSkillsPayload({ roots: [{ root: '/skills', skills: 2, counts: {} }] }), /审计字段不完整/);
  assert.equal(parseSkillsPayload({ roots: [{ root: '/skills', error: '读取失败' }] }).roots[0]?.error, '读取失败');
  const rich = parseSkillsPayload({
    roots: [{ root: '/a', skills: 1, counts: { warn: 0 }, findings: [], servedToModel: true }],
    shadowing: [],
    catalog: [],
    usage: { ask: { count: 2, lastAt: 1 } },
  });
  assert.equal(rich.roots[0]?.servedToModel, true);
  assert.equal(rich.usage?.ask?.count, 2);
});

test('catalog filter/sort/group and never-used signal', () => {
  assert.equal(clipDescription('a'.repeat(130)).length, 120);
  assert.deepEqual(filterCatalog(catalog, 'browser').map((r) => r.name), ['playwright']);
  const recent = sortCatalog(catalog, 'recent', { ask: { count: 3, lastAt: 100 }, playwright: { count: 1, lastAt: 50 } });
  assert.deepEqual(recent.map((r) => r.name), ['ask', 'playwright', 'book-chaos']);
  const never = sortCatalog(catalog, 'never', { ask: { count: 1, lastAt: 1 } });
  assert.deepEqual(never.map((r) => r.name), ['book-chaos', 'playwright', 'ask']);
  assert.equal(neverUsedCount(catalog, { ask: { count: 1, lastAt: 1 } }), 2);
  const groups = groupCatalogByCategory(catalog);
  assert.equal(groups[0]?.category, 'functional / tools / methodology');
  assert.equal(groups.some((g) => g.category === 'books'), true);
  const merged = mergeRpcCatalog(catalog, [{ name: 'ask', description: 'RPC desc', modelInvocable: true, whenToUse: 'when asking' }]);
  assert.equal(merged.find((r) => r.name === 'ask')?.modelInvocable, true);
  assert.equal(merged.find((r) => r.name === 'ask')?.whenToUse, 'when asking');
});
