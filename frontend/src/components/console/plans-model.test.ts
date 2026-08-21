import assert from 'node:assert/strict';
import test from 'node:test';
import { derivePlanStatus, formatPlanSource, parsePlansPayload, recentPlans, type PlanRecord } from './plans-model.ts';

const plan = (name: string, dates: Partial<PlanRecord> = {}): PlanRecord => ({
  file: `/tmp/${name}`,
  name,
  goal: '',
  steps: [],
  ...dates,
});

test('derivePlanStatus follows executed, approved, edited, pending precedence', () => {
  assert.equal(derivePlanStatus(plan('plan-1.json', { executedAt: '2026-08-21', approvedAt: '2026-08-20', editedAt: '2026-08-19' })), 'executed');
  assert.equal(derivePlanStatus(plan('plan-2.json', { approvedAt: '2026-08-20', editedAt: '2026-08-19' })), 'approved');
  assert.equal(derivePlanStatus(plan('plan-3.json', { editedAt: '2026-08-19' })), 'edited');
  assert.equal(derivePlanStatus(plan('plan-4.json')), 'pending');
});

test('formatPlanSource never invents provenance when source is absent', () => {
  assert.equal(formatPlanSource(undefined), undefined);
  assert.equal(formatPlanSource(''), undefined);
  assert.equal(formatPlanSource('plan-mode'), '计划模式');
  assert.equal(formatPlanSource('plan_run'), 'plan_run');
});

test('recentPlans sorts by filename descending without mutating and caps at 20', () => {
  const input = Array.from({ length: 23 }, (_, index) => plan(`plan-${String(index).padStart(3, '0')}.json`));
  const before = input.map((item) => item.name);
  const result = recentPlans(input);

  assert.equal(result.length, 20);
  assert.equal(result[0]?.name, 'plan-022.json');
  assert.equal(result.at(-1)?.name, 'plan-003.json');
  assert.deepEqual(input.map((item) => item.name), before);
});

test('parsePlansPayload distinguishes a true empty archive from missing or malformed plans', () => {
  assert.deepEqual(parsePlansPayload({ plans: [] }).plans, []);
  assert.throws(() => parsePlansPayload({}), /缺少 plans 数组/);
  assert.throws(() => parsePlansPayload({ plans: null }), /缺少 plans 数组/);
  assert.throws(
    () => parsePlansPayload({ plans: [{ file: '/plan-1.json', name: 'plan-1.json', goal: 'goal' }] }),
    /无效的计划条目/,
  );
  assert.equal(parsePlansPayload({ plans: [plan('plan-1.json')] }).plans.length, 1);
});
