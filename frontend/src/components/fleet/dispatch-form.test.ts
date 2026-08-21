import test from 'node:test';
import assert from 'node:assert/strict';
import {
  describeDispatchTargets,
  parseDispatchItems,
  validateDispatchForm,
} from './dispatch-form';

const base = {
  tasks: '第一项',
  hosts: [] as string[],
  tag: '',
  wake: true,
  timeoutMinutes: '',
  label: '',
};

test('parseDispatchItems accepts newline and ;; syntax and removes empty segments', () => {
  assert.deepEqual(
    parseDispatchItems(' 第一项\r\n第二项 ;; 第三项\n;;  '),
    ['第一项', '第二项', '第三项'],
  );
});

test('validateDispatchForm enforces item count and the 8000 character boundary', () => {
  assert.deepEqual(validateDispatchForm({ ...base, tasks: ' \n ;; ' }), {
    ok: false,
    error: '请至少填写一项任务。',
  });
  const tooMany = validateDispatchForm({ ...base, tasks: Array.from({ length: 33 }, (_, i) => `任务${i}`).join(';;') });
  assert.equal(tooMany.ok, false);
  if (!tooMany.ok) assert.match(tooMany.error, /最多派发 32 项/);
  assert.equal(validateDispatchForm({ ...base, tasks: 'x'.repeat(8_000) }).ok, true);
  const tooLong = validateDispatchForm({ ...base, tasks: 'x'.repeat(8_001) });
  assert.equal(tooLong.ok, false);
  if (!tooLong.ok) assert.match(tooLong.error, /超过 8000 字符/);
});

test('validateDispatchForm keeps host and tag intersection and converts an explicit timeout', () => {
  const result = validateDispatchForm({
    ...base,
    tasks: 'a;;b',
    hosts: ['leo-03', 'leo-03'],
    tag: ' tool-heavy ',
    wake: false,
    timeoutMinutes: '15',
    label: ' 回归 ',
  });
  assert.deepEqual(result, {
    ok: true,
    request: {
      items: ['a', 'b'],
      hosts: ['leo-03'],
      tag: 'tool-heavy',
      wake: false,
      timeoutMs: 900_000,
      label: '回归',
    },
  });
  const invalidTimeout = validateDispatchForm({ ...base, timeoutMinutes: '61' });
  assert.equal(invalidTimeout.ok, false);
  if (!invalidTimeout.ok) assert.match(invalidTimeout.error, /1–60/);
});

test('describeDispatchTargets never invents a host or model', () => {
  assert.equal(describeDispatchTargets([], [], ''), '调度器选择的可用远端机器');
  assert.equal(describeDispatchTargets([], [], 'gpu'), '带 gpu 标签的可用远端机器');
  assert.equal(
    describeDispatchTargets(['leo-03', 'unknown'], [{ name: 'leo-03', model: 'deepseek-v4-flash' }], ''),
    'leo-03（deepseek-v4-flash）、unknown',
  );
});
