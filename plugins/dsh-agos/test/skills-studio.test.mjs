import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createSkillDraft, normalizeSkillName, patchSkillDescription, readStudioSkill, replaceDescriptionFrontmatter, validateDraft } from '../lib/skills-studio.js'

const good = {
  name: 'inbox-triage',
  description: '每当用户要清理收件箱、分拣邮件或说 inbox 时使用本技能。',
  whenToUse: '清理收件箱',
  body: '先读标题，再决定归档或回复。',
  evals: [
    { prompt: '整理我的收件箱', should_trigger: true },
    { prompt: 'inbox 里哪些要回', should_trigger: true },
    { prompt: '帮我改这段 React 组件的样式', should_trigger: false },
    { prompt: '把这篇论文做成读书笔记', should_trigger: false },
  ],
}

test('normalizeSkillName folds spaces and never keeps a parent path', () => {
  assert.equal(normalizeSkillName(' Inbox Triage '), 'inbox-triage')
  assert.equal(normalizeSkillName('../etc/passwd'), 'etc-passwd')
})

test('createSkillDraft writes the DSH model root once and refuses overwrite', async () => {
  const home = await mkdtemp(join(tmpdir(), 'agos-studio-'))
  const first = await createSkillDraft(good, { home })
  assert.equal(first.ok, true)
  assert.equal(first.root, 'user-dsh')
  assert.equal(first.path.startsWith(join(home, '.dsh', 'skills', 'inbox-triage')), true)
  const text = await readFile(first.path, 'utf8')
  assert.match(text, /name: inbox-triage/)
  assert.doesNotMatch(text, /claude\/skills/)
  const evals = JSON.parse(await readFile(first.evalsPath, 'utf8'))
  assert.equal(evals.skill_name, 'inbox-triage')
  assert.equal(evals.evals.length, 4)

  const again = await createSkillDraft(good, { home })
  assert.equal(again.ok, false)
  assert.equal(again.status, 409)
  assert.equal(again.code, 'EXISTS')
})

test('createSkillDraft does not write the Claude user root', async () => {
  const home = await mkdtemp(join(tmpdir(), 'agos-studio-'))
  await mkdir(join(home, '.claude', 'skills'), { recursive: true })
  const result = await createSkillDraft(good, { home })
  assert.equal(result.ok, true)
  await assert.rejects(readFile(join(home, '.claude', 'skills', 'inbox-triage', 'SKILL.md')))
})

test('existing SKILL.md is not rewritten even if evals are new', async () => {
  const home = await mkdtemp(join(tmpdir(), 'agos-studio-'))
  const dir = join(home, '.dsh', 'skills', 'inbox-triage')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'SKILL.md'), '---\nname: inbox-triage\ndescription: old\n---\n')
  const result = await createSkillDraft(good, { home })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'EXISTS')
  assert.equal(await readFile(join(dir, 'SKILL.md'), 'utf8'), '---\nname: inbox-triage\ndescription: old\n---\n')
})

test('validateDraft refuses a description without a trigger cue', () => {
  const result = validateDraft({
    name: 'inbox-triage',
    description: '这是一个很长的功能简介但完全不说何时该用',
  })
  assert.equal(result.errors.some((item) => item.includes('何时触发')), true)
})

test('needsPlugin writes a stub outside profile plugins and does not mark it installed', async () => {
  const home = await mkdtemp(join(tmpdir(), 'agos-studio-'))
  const result = await createSkillDraft({
    ...good,
    name: 'mail-sort',
    needsPlugin: true,
    pluginHint: 'gmail-inbox',
  }, { home })
  assert.equal(result.ok, true)
  assert.equal(result.pluginInstalled, false)
  assert.equal(result.pluginStub.startsWith(join(home, '.dsh', 'agos', 'plugin-stubs', 'gmail-inbox')), true)
  const companion = JSON.parse(await readFile(join(result.pluginStub, 'companion.json'), 'utf8'))
  assert.equal(companion.installed, false)
  assert.equal(companion.skill, 'mail-sort')
  await assert.rejects(readFile(join(home, '.dsh', 'profiles', 'desktop', 'plugins', 'gmail-inbox', 'package.json')))
})

test('readStudioSkill and description patch stay on the model root', async () => {
  const home = await mkdtemp(join(tmpdir(), 'agos-studio-'))
  await createSkillDraft(good, { home })
  const loaded = await readStudioSkill('inbox-triage', { home })
  assert.equal(loaded.ok, true)
  assert.equal(loaded.evals.length, 4)
  const refused = await patchSkillDescription({
    name: 'inbox-triage',
    description: '每当用户要清理收件箱或说 inbox 时使用本技能。',
  }, { home })
  assert.equal(refused.code, 'UNCONFIRMED')
  const patched = await patchSkillDescription({
    name: 'inbox-triage',
    description: '每当用户要清理收件箱或说 inbox 时使用本技能。',
    confirm: true,
  }, { home })
  assert.equal(patched.ok, true)
  const text = await readFile(patched.path, 'utf8')
  assert.match(text, /每当用户要清理收件箱或说 inbox 时使用本技能/)
  assert.match(text, /先读标题/)
  const missing = await readStudioSkill('not-a-skill', { home })
  assert.equal(missing.status, 404)
})

test('replaceDescriptionFrontmatter keeps the body and refuses files without description', () => {
  const next = replaceDescriptionFrontmatter(
    '---\nname: inbox-triage\ndescription: >-\n  old text\n---\n\n# body\n',
    '每当用户要清理收件箱时使用本技能。',
  )
  assert.match(next, /每当用户要清理收件箱时使用本技能/)
  assert.match(next, /# body/)
  assert.equal(replaceDescriptionFrontmatter('# no frontmatter\n', 'x'), undefined)
})
