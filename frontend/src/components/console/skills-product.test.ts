import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { CALL_IS_NOT_VERDICT_COPY, POSTERIOR_METHOD_COPY } from './skills-evolve.ts';
import { SHORTLIST_METHOD_COPY } from './skills-ranking.ts';

const here = dirname(fileURLToPath(import.meta.url));

test('SkillsView and MemorySkillsDock keep honesty copy', () => {
  const view = readFileSync(join(here, 'SkillsView.tsx'), 'utf8');
  const dock = readFileSync(join(here, '../graph/MemorySkillsDock.tsx'), 'utf8');
  const studio = readFileSync(join(here, 'SkillsStudio.tsx'), 'utf8');
  assert.match(view, /SHORTLIST_METHOD_COPY/);
  assert.match(view, /POSTERIOR_METHOD_COPY/);
  assert.match(view, /CALL_IS_NOT_VERDICT_COPY/);
  assert.match(view, /在工作室打开/);
  assert.doesNotMatch(view, /['"`]\/api\/agos\/routes\/decide['"`]/);
  assert.match(dock, /SHORTLIST_METHOD_COPY/);
  assert.match(dock, /POSTERIOR_METHOD_COPY/);
  assert.match(dock, /打开工作室/);
  assert.match(studio, /skill\(\) 调用不是胜负|CALL_IS_NOT_VERDICT_COPY/);
  assert.match(studio, /未安装|未装进 profile/);
  assert.equal(SHORTLIST_METHOD_COPY, '词面短名单，不是模型推荐');
  assert.equal(POSTERIOR_METHOD_COPY, '经验后验，不是模型推荐');
  assert.equal(CALL_IS_NOT_VERDICT_COPY, 'skill() 调用不是胜负');
});
