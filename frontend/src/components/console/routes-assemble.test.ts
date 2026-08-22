import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  ASSEMBLE_COPY,
  ASSEMBLE_EMPTY_COPY,
  LIVE_DISPATCH_OFF_COPY,
  OUTCOME_CONFIRM_COPY,
  parseAssemblePlan,
} from './routes-assemble.ts';

test('parseAssemblePlan keeps dispatched=false and does not invent roles', () => {
  assert.equal(parseAssemblePlan(null), null);
  assert.equal(parseAssemblePlan({ roles: [] }), null);
  const plan = parseAssemblePlan({
    assemble: {
      id: 'asm-1',
      dispatched: true,
      note: ASSEMBLE_COPY,
      live: LIVE_DISPATCH_OFF_COPY,
      roles: [
        { role: 'planner', model: 'glm-5.2' },
        { role: 'implementer', model: 'qwen3.8-max' },
        { role: 'reviewer', model: 'minimax-m3' },
      ],
    },
  });
  assert.equal(plan?.dispatched, false);
  assert.equal(plan?.roles[2]?.model, 'minimax-m3');
});

test('RoutesView does not POST decide and keeps assemble as a proposal', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const view = readFileSync(join(here, 'RoutesView.tsx'), 'utf8');
  const api = readFileSync(join(here, 'routes-assemble.ts'), 'utf8');
  assert.doesNotMatch(view, /['"`]\/api\/agos\/routes\/decide['"`]/);
  assert.doesNotMatch(api, /['"`]\/api\/agos\/routes\/decide['"`]/);
  assert.match(view, /\/api\/agos\/routes\/assemble/);
  assert.match(api, /\/api\/agos\/routes\/outcome/);
  assert.match(view, /postRouteOutcome/);
  assert.match(view, /ASSEMBLE_COPY/);
  assert.match(view, /ASSEMBLE_EMPTY_COPY/);
  assert.match(view, /LIVE_DISPATCH_OFF_COPY/);
  assert.match(view, /assemble\.notes/);
  assert.match(view, /只报告/);
  assert.equal(ASSEMBLE_COPY, '组装提案，不是已派活');
  assert.equal(ASSEMBLE_EMPTY_COPY, '还没有组装提案');
  assert.equal(LIVE_DISPATCH_OFF_COPY, '未接入本跳会话换模');
  assert.equal(OUTCOME_CONFIRM_COPY, '确认回填人工胜负，不换当前会话模型');
});
