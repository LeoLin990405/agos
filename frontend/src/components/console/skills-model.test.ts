import assert from 'node:assert/strict';
import test from 'node:test';
import { filterSkillFindings, parseSkillsPayload, type SkillFinding } from './skills-model.ts';

const findings: SkillFinding[] = [
  { sev: 'warn', check: 'frontmatter', skill: 'alpha/SKILL.md', msg: 'missing description' },
  { sev: 'error', check: 'links', skill: 'beta/SKILL.md', msg: 'broken reference' },
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
});
