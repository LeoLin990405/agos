import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AUDIT_FINDINGS_CLEAR_COPY,
  AUDIT_FINDINGS_NO_MATCH_COPY,
  AUDIT_FINDINGS_UNCOLLECTED_COPY,
  auditFindingsEmptyCopy,
  clipDescription,
  collectedNeverUsedCount,
  filterCatalog,
  filterSkillFindings,
  groupCatalogByCategory,
  mergeRpcCatalog,
  neverUsedCount,
  parseSkillsPayload,
  SKILL_USAGE_NEVER_COPY,
  SKILL_USAGE_UNCOLLECTED_COPY,
  SKILLS_CATALOG_EMPTY_COPY,
  SKILLS_CATALOG_NO_MATCH_COPY,
  skillUsageHonesty,
  skillUsageKind,
  skillsCatalogEmptyCopy,
  sortCatalog,
  USAGE_SCAN_FAILED_COPY,
  usageDenominatorReady,
  usageSampleCopy,
  vanishedUsageSkills,
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
  assert.deepEqual(parseSkillsPayload({ roots: [], catalog: [], librarian: '/tool', at: 1 }).roots, []);
  assert.throws(() => parseSkillsPayload({ librarian: '/tool' }), /缺少 roots 数组/);
  assert.throws(() => parseSkillsPayload({ roots: {} }), /缺少 roots 数组/);
  assert.throws(() => parseSkillsPayload({ roots: [], librarian: '/tool' }), /缺少 catalog 数组/);
  assert.throws(() => parseSkillsPayload({ roots: [{ root: '/skills', skills: 2, counts: {} }] }), /审计字段不完整/);
  assert.equal(parseSkillsPayload({ roots: [{ root: '/skills', error: '读取失败' }], catalog: [] }).roots[0]?.error, '读取失败');
  assert.equal(parseSkillsPayload({ roots: [], error: 'librarian missing' }).error, 'librarian missing');
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

test('skillUsageHonesty does not treat a missing sample as never-used', () => {
  assert.equal(skillUsageHonesty(undefined), '使用次数未采集。');
  assert.equal(skillUsageHonesty({ count: 0, lastAt: 1 }), '当前样本下从未调用，不是删除判决。');
  assert.equal(skillUsageHonesty({ count: 4, lastAt: 1 }), '当前样本调用 4 次。');
  assert.equal(skillUsageHonesty(undefined, true), '当前样本下从未调用，不是删除判决。');
  assert.equal(skillUsageKind(undefined, false), 'uncollected');
  assert.equal(skillUsageKind(undefined, true), 'never');
  assert.equal(skillUsageKind({ count: 0, lastAt: 1 }, false), 'never');
  assert.notEqual(SKILL_USAGE_UNCOLLECTED_COPY, SKILL_USAGE_NEVER_COPY);
});

test('usage sample copy never paints a failed scan as 0 sessions / 0 calls', () => {
  assert.equal(usageSampleCopy(undefined), undefined);
  assert.equal(usageSampleCopy({ error: 'EACCES' }), USAGE_SCAN_FAILED_COPY);
  assert.notEqual(usageSampleCopy({ error: 'EACCES' }), '样本 0 会话 / 0 次调用');
  assert.equal(usageSampleCopy({ files: 6, events: 0, roots: ['/a'] }), '样本 6 会话 / 0 次调用');
  assert.equal(usageSampleCopy({ note: 'x' }), '样本 未采集 会话 / 未采集 次调用');
  assert.equal(collectedNeverUsedCount(catalog, {}, { error: 'scan failed' }), undefined);
  assert.equal(collectedNeverUsedCount(catalog, undefined, undefined), undefined);
  assert.equal(collectedNeverUsedCount(catalog, { ask: { count: 1, lastAt: 1 } }, { files: 6, roots: ['/a'] }), 2);
});

test('audit findings empty copy keeps uncollected / clear / no-match apart', () => {
  assert.equal(auditFindingsEmptyCopy(undefined, ''), AUDIT_FINDINGS_UNCOLLECTED_COPY);
  assert.equal(auditFindingsEmptyCopy([], ''), AUDIT_FINDINGS_CLEAR_COPY);
  assert.equal(auditFindingsEmptyCopy([], 'frontmatter'), AUDIT_FINDINGS_NO_MATCH_COPY);
  assert.equal(auditFindingsEmptyCopy(findings, ''), undefined);
  assert.notEqual(AUDIT_FINDINGS_UNCOLLECTED_COPY, AUDIT_FINDINGS_CLEAR_COPY);
  assert.equal(skillsCatalogEmptyCopy(''), SKILLS_CATALOG_EMPTY_COPY);
  assert.equal(skillsCatalogEmptyCopy('play'), SKILLS_CATALOG_NO_MATCH_COPY);
});

test('usageDenominatorReady is success-only', () => {
  assert.equal(usageDenominatorReady(undefined), false);
  assert.equal(usageDenominatorReady({ error: 'scan failed', files: 0, roots: [] }), false);
  assert.equal(usageDenominatorReady({ note: 'x' }), false);
  assert.equal(usageDenominatorReady({ files: 429, roots: ['/a'] }), true);
  assert.equal(usageDenominatorReady({ files: 10, roots: ['/a'], errors: [{ root: '/b', error: 'EACCES' }] }), true);
});

test('vanishedUsageSkills lists used names missing from catalog', () => {
  assert.deepEqual(
    vanishedUsageSkills(catalog, {
      ask: { count: 1, lastAt: 1 },
      'systems-science': { count: 2, lastAt: 2 },
      'gone-skill': { count: 0, lastAt: 0 },
    }),
    ['systems-science'],
  );
  assert.equal(neverUsedCount(catalog, { ask: { count: 1, lastAt: 1 }, 'systems-science': { count: 2, lastAt: 2 } }), 2);
});
