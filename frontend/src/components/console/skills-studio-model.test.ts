import assert from 'node:assert/strict';
import test from 'node:test';
import {
  catalogCollision,
  emptyTriggerEvals,
  modelRootPath,
  normalizeSkillName,
  parseTriggerEvals,
  renderSkillMarkdown,
  serializeTriggerEvals,
  validateDescription,
  validateDraft,
  validateSkillName,
  validateTriggerEvals,
  type SkillStudioDraft,
} from './skills-studio-model.ts';

function draft(partial: Partial<SkillStudioDraft> = {}): SkillStudioDraft {
  return {
    name: 'inbox-triage',
    description: '每当用户要清理收件箱、分拣邮件或说 inbox 时使用本技能。',
    whenToUse: '清理收件箱',
    body: '先读标题，再决定归档或回复。',
    needsPlugin: false,
    pluginHint: '',
    ...partial,
  };
}

test('skill names fold to kebab and reject leftover punctuation', () => {
  assert.equal(normalizeSkillName(' Inbox Triage '), 'inbox-triage');
  assert.equal(normalizeSkillName('../etc/passwd'), 'etc-passwd');
  assert.equal(validateSkillName('inbox-triage'), undefined);
  assert.equal(validateSkillName('Inbox'), '名称必须是小写 kebab-case。');
  assert.equal(validateSkillName(''), '名称未采集。');
});

test('description requires a when-to-trigger cue and stays inside librarian budget', () => {
  assert.match(validateDescription('短') ?? '', /至少/);
  assert.match(validateDescription('这是一个很长的功能简介但完全不说何时该用') ?? '', /何时触发/);
  assert.equal(validateDescription('每当用户提到收件箱分拣或说 inbox 时使用本技能。'), undefined);
});

test('renderSkillMarkdown writes the model-facing file shape and does not invent a plugin', () => {
  const text = renderSkillMarkdown(draft({ needsPlugin: true, pluginHint: 'gmail-inbox' }));
  assert.match(text, /^---\nname: inbox-triage\n/);
  assert.match(text, /description: >-/);
  assert.match(text, /plugin-stubs\/gmail-inbox/);
  assert.match(text, /未装进 profile/);
  assert.match(text, /gmail-inbox/);
  assert.doesNotMatch(text, /~\/\.claude\/skills/);
});

test('validateDraft refuses a plugin checkbox without a kebab hint', () => {
  const errors = validateDraft(draft({ needsPlugin: true, pluginHint: '' }));
  assert.equal(errors.includes('勾选了需要插件动词，但插件提示名未采集。'), true);
});

test('catalogCollision is exact name membership', () => {
  assert.equal(catalogCollision('ask', ['ask', 'pdf']), true);
  assert.equal(catalogCollision('ask-more', ['ask', 'pdf']), false);
});

test('trigger evals require both polarities and reject tiny negatives', () => {
  assert.deepEqual(validateTriggerEvals(emptyTriggerEvals()), { errors: [], should: 0, shouldNot: 0 });
  const thin = validateTriggerEvals([
    { query: '整理我的收件箱', shouldTrigger: true },
    { query: 'inbox 里哪些要回', shouldTrigger: true },
    { query: 'hi', shouldTrigger: false },
    { query: '写斐波那契', shouldTrigger: false },
  ]);
  assert.equal(thin.errors.includes('「不该触发」过短，近邻负例才有用。'), true);
  const ok = validateTriggerEvals([
    { query: '整理我的收件箱', shouldTrigger: true },
    { query: 'inbox 里哪些要回', shouldTrigger: true },
    { query: '帮我改这段 React 组件的样式', shouldTrigger: false },
    { query: '把这篇论文做成读书笔记', shouldTrigger: false },
  ]);
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.should, 2);
  assert.equal(ok.shouldNot, 2);
});

test('eval serialize/parse keeps should_trigger and rejects a missing array', () => {
  const payload = serializeTriggerEvals('inbox-triage', [
    { query: '整理收件箱', shouldTrigger: true },
    { query: '', shouldTrigger: false },
  ]);
  assert.deepEqual(payload, {
    skill_name: 'inbox-triage',
    evals: [{ prompt: '整理收件箱', should_trigger: true }],
  });
  assert.deepEqual(parseTriggerEvals(payload), [{ query: '整理收件箱', shouldTrigger: true }]);
  assert.throws(() => parseTriggerEvals({}), /缺少 evals 数组/);
});

test('write targets stay on the DSH model root', () => {
  assert.equal(modelRootPath('inbox-triage'), '~/.dsh/skills/inbox-triage/SKILL.md');
});
