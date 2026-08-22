/** Console studio draft. Writes only go to the model-facing DSH user root. */

export const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const SKILL_NAME_MAX = 64;
export const DESCRIPTION_MIN = 24;
export const DESCRIPTION_MAX = 1024;
export const BODY_MAX = 24_000;
export const EVAL_QUERY_MAX = 400;
export const EVAL_CASE_MAX = 40;
export const MODEL_ROOT_DISPLAY = '~/.dsh/skills';
export const CLAUDE_ROOT_DISPLAY = '~/.claude/skills';
export const PLUGIN_STUB_DISPLAY = '~/.dsh/agos/plugin-stubs';

export interface SkillStudioDraft {
  name: string;
  description: string;
  whenToUse: string;
  body: string;
  needsPlugin: boolean;
  pluginHint: string;
}

export interface TriggerEvalCase {
  query: string;
  shouldTrigger: boolean;
}

export interface TriggerEvalReport {
  errors: string[];
  should: number;
  shouldNot: number;
}

export function emptyStudioDraft(): SkillStudioDraft {
  return {
    name: '',
    description: '',
    whenToUse: '',
    body: '',
    needsPlugin: false,
    pluginHint: '',
  };
}

export function emptyTriggerEvals(): TriggerEvalCase[] {
  return [
    { query: '', shouldTrigger: true },
    { query: '', shouldTrigger: true },
    { query: '', shouldTrigger: false },
    { query: '', shouldTrigger: false },
  ];
}

export function normalizeSkillName(raw: string): string {
  return raw
    .trim()
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

export function validateSkillName(name: string): string | undefined {
  if (name === '') return '名称未采集。';
  if (name.length > SKILL_NAME_MAX) return `名称超过 ${SKILL_NAME_MAX} 字符。`;
  if (!SKILL_NAME_RE.test(name)) return '名称必须是小写 kebab-case。';
  return undefined;
}

function hasWhenCue(text: string): boolean {
  return /when|use when|触发|每当|使用本技能|在.*时/i.test(text);
}

export function validateDescription(description: string): string | undefined {
  const text = description.replace(/\s+/g, ' ').trim();
  if (text === '') return 'description 未采集。';
  if (text.length < DESCRIPTION_MIN) return `description 至少 ${DESCRIPTION_MIN} 字，并写清何时触发。`;
  if (text.length > DESCRIPTION_MAX) return `description 超过 librarian 上限 ${DESCRIPTION_MAX}。`;
  if (!hasWhenCue(text)) return 'description 必须写何时触发，不能只写功能简介。';
  return undefined;
}

export function validateDraft(draft: SkillStudioDraft): string[] {
  const errors: string[] = [];
  const nameError = validateSkillName(draft.name);
  if (nameError) errors.push(nameError);
  const descError = validateDescription(draft.description);
  if (descError) errors.push(descError);
  if (draft.body.length > BODY_MAX) errors.push(`正文超过 ${BODY_MAX} 字符。`);
  if (draft.needsPlugin && draft.pluginHint.trim() === '') {
    errors.push('勾选了需要插件动词，但插件提示名未采集。');
  }
  if (draft.pluginHint.trim() !== '' && validateSkillName(normalizeSkillName(draft.pluginHint))) {
    errors.push('插件提示名必须是小写 kebab-case。');
  }
  return errors;
}

export function renderSkillMarkdown(draft: SkillStudioDraft): string {
  const when = draft.whenToUse.trim();
  const plugin = draft.needsPlugin
    ? [
        '',
        '## 插件动词',
        '',
        `此技能需要宿主插件才能执行外部动作。脚手架在 \`${PLUGIN_STUB_DISPLAY}/${normalizeSkillName(draft.pluginHint)}/\`，未装进 profile。`,
        '不要把密钥写进本文件。',
        '',
      ].join('\n')
    : '';
  const body = draft.body.trim() === '' ? '把步骤、判断和失败回退写在这里。' : draft.body.trim();
  const front = [
    '---',
    `name: ${draft.name}`,
    'description: >-',
    `  ${draft.description.replace(/\s+/g, ' ').trim()}`,
    ...(when === '' ? [] : [`whenToUse: ${when}`]),
    '---',
    '',
    `# ${draft.name}`,
    '',
    body,
    plugin,
  ];
  return `${front.join('\n').trim()}\n`;
}

export function catalogCollision(name: string, catalogNames: readonly string[]): boolean {
  return catalogNames.includes(name);
}

export function validateTriggerEvals(cases: readonly TriggerEvalCase[]): TriggerEvalReport {
  const errors: string[] = [];
  const filled = cases
    .map((row) => ({ query: row.query.replace(/\s+/g, ' ').trim(), shouldTrigger: row.shouldTrigger }))
    .filter((row) => row.query !== '');
  if (filled.length > EVAL_CASE_MAX) errors.push(`评测条数超过 ${EVAL_CASE_MAX}。`);
  for (const row of filled) {
    if (row.query.length > EVAL_QUERY_MAX) errors.push('有一条评测问句过长。');
  }
  const should = filled.filter((row) => row.shouldTrigger).length;
  const shouldNot = filled.filter((row) => !row.shouldTrigger).length;
  if (filled.length === 0) {
    return { errors, should, shouldNot };
  }
  if (should < 2) errors.push('至少两条「该触发」。');
  if (shouldNot < 2) errors.push('至少两条「不该触发」。');
  if (filled.some((row) => !row.shouldTrigger && row.query.length < 8)) {
    errors.push('「不该触发」过短，近邻负例才有用。');
  }
  return { errors, should, shouldNot };
}

export function serializeTriggerEvals(skillName: string, cases: readonly TriggerEvalCase[]): {
  skill_name: string;
  evals: Array<{ prompt: string; should_trigger: boolean }>;
} {
  return {
    skill_name: skillName,
    evals: cases
      .map((row) => ({ prompt: row.query.replace(/\s+/g, ' ').trim(), should_trigger: row.shouldTrigger }))
      .filter((row) => row.prompt !== ''),
  };
}

export function parseTriggerEvals(value: unknown): TriggerEvalCase[] {
  if (typeof value !== 'object' || value === null || !('evals' in value) || !Array.isArray(value.evals)) {
    throw new Error('评测集缺少 evals 数组');
  }
  return value.evals.map((row) => {
    if (typeof row !== 'object' || row === null) throw new Error('评测条无效');
    const prompt = 'prompt' in row ? row.prompt : 'query' in row ? row.query : undefined;
    if (typeof prompt !== 'string') throw new Error('评测问句未采集');
    const flag = 'should_trigger' in row ? row.should_trigger : 'shouldTrigger' in row ? row.shouldTrigger : undefined;
    if (typeof flag !== 'boolean') throw new Error('该不该触发未采集');
    return { query: prompt, shouldTrigger: flag };
  });
}

export function modelRootPath(name: string): string {
  return `${MODEL_ROOT_DISPLAY}/${name}/SKILL.md`;
}

export function evalsPath(name: string): string {
  return `${MODEL_ROOT_DISPLAY}/${name}/evals/evals.json`;
}

export function pluginStubPath(pluginHint: string): string {
  return `${PLUGIN_STUB_DISPLAY}/${normalizeSkillName(pluginHint)}/`;
}
