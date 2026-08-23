import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, relative, resolve, sep } from 'node:path'

export const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
export const SKILL_NAME_MAX = 64
export const DESCRIPTION_MIN = 24
export const DESCRIPTION_MAX = 1024
export const BODY_MAX = 24_000
export const EVAL_QUERY_MAX = 400
export const EVAL_CASE_MAX = 40

export function normalizeSkillName(raw) {
  return String(raw ?? '')
    .trim()
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
}

function hasWhenCue(text) {
  return /when|use when|触发|每当|使用本技能|在.*时/i.test(text)
}

export function validateDraft(input) {
  const errors = []
  const name = normalizeSkillName(input?.name)
  if (name === '') errors.push('名称未采集。')
  else if (name.length > SKILL_NAME_MAX) errors.push(`名称超过 ${SKILL_NAME_MAX} 字符。`)
  else if (!SKILL_NAME_RE.test(name)) errors.push('名称必须是小写 kebab-case。')
  const description = String(input?.description ?? '').replace(/\s+/g, ' ').trim()
  if (description === '') errors.push('description 未采集。')
  else if (description.length < DESCRIPTION_MIN) errors.push(`description 至少 ${DESCRIPTION_MIN} 字，并写清何时触发。`)
  else if (description.length > DESCRIPTION_MAX) errors.push(`description 超过 librarian 上限 ${DESCRIPTION_MAX}。`)
  else if (!hasWhenCue(description)) errors.push('description 必须写何时触发，不能只写功能简介。')
  const body = String(input?.body ?? '')
  if (body.length > BODY_MAX) errors.push(`正文超过 ${BODY_MAX} 字符。`)
  const needsPlugin = input?.needsPlugin === true
  const pluginHint = normalizeSkillName(input?.pluginHint)
  if (needsPlugin && pluginHint === '') errors.push('勾选了需要插件动词，但插件提示名未采集。')
  if (pluginHint !== '' && !SKILL_NAME_RE.test(pluginHint)) errors.push('插件提示名必须是小写 kebab-case。')
  return { errors, name, description, body, needsPlugin, pluginHint, whenToUse: String(input?.whenToUse ?? '').trim() }
}

export function renderSkillMarkdown(draft) {
  const plugin = draft.needsPlugin
    ? [
        '',
        '## 插件动词',
        '',
        `此技能需要宿主插件才能执行外部动作。脚手架在 \`~/.dsh/agos/plugin-stubs/${draft.pluginHint}/\`，未装进 profile。`,
        '不要把密钥写进本文件。',
        '',
      ].join('\n')
    : ''
  const body = draft.body.trim() === '' ? '把步骤、判断和失败回退写在这里。' : draft.body.trim()
  return [
    '---',
    `name: ${draft.name}`,
    'description: >-',
    `  ${draft.description}`,
    ...(draft.whenToUse === '' ? [] : [`whenToUse: ${draft.whenToUse}`]),
    '---',
    '',
    `# ${draft.name}`,
    '',
    body,
    plugin,
  ].join('\n').trim() + '\n'
}

export function normalizeEvals(input) {
  const rows = Array.isArray(input) ? input : []
  const evals = []
  for (const row of rows) {
    if (typeof row !== 'object' || row === null) continue
    const prompt = typeof row.prompt === 'string' ? row.prompt : typeof row.query === 'string' ? row.query : ''
    const flag = typeof row.should_trigger === 'boolean'
      ? row.should_trigger
      : typeof row.shouldTrigger === 'boolean' ? row.shouldTrigger : undefined
    const query = prompt.replace(/\s+/g, ' ').trim()
    if (query === '' || typeof flag !== 'boolean') continue
    if (query.length > EVAL_QUERY_MAX) return { errors: ['有一条评测问句过长。'], evals: [] }
    evals.push({ prompt: query, should_trigger: flag })
  }
  if (evals.length > EVAL_CASE_MAX) return { errors: [`评测条数超过 ${EVAL_CASE_MAX}。`], evals: [] }
  const should = evals.filter((row) => row.should_trigger).length
  const shouldNot = evals.length - should
  const errors = []
  if (evals.length > 0 && should < 2) errors.push('至少两条「该触发」。')
  if (evals.length > 0 && shouldNot < 2) errors.push('至少两条「不该触发」。')
  if (evals.some((row) => !row.should_trigger && row.prompt.length < 8)) {
    errors.push('「不该触发」过短，近邻负例才有用。')
  }
  return { errors, evals }
}

const BLOCK_SCALAR_RX = /^[|>][-+]?\d*$/

export function replaceDescriptionFrontmatter(raw, description) {
  if (!String(raw).startsWith('---')) return undefined
  const end = raw.indexOf('\n---', 3)
  if (end < 0) return undefined
  const lines = raw.slice(4, end).split('\n')
  const out = []
  let found = false
  for (let i = 0; i < lines.length; i += 1) {
    const match = /^description:\s*(.*)$/.exec(lines[i])
    if (!match) {
      out.push(lines[i])
      continue
    }
    found = true
    out.push('description: >-')
    out.push(`  ${description}`)
    if (BLOCK_SCALAR_RX.test(match[1].trim())) {
      i += 1
      while (i < lines.length && (lines[i].trim() === '' || /^[ \t]/.test(lines[i]))) i += 1
      i -= 1
    }
  }
  if (!found) return undefined
  return `---\n${out.join('\n')}${raw.slice(end)}`
}

function pluginStubRoot(home, pluginHint) {
  const root = resolve(home, '.dsh', 'agos', 'plugin-stubs')
  const dir = resolve(root, pluginHint)
  const rel = relative(root, dir)
  if (rel.startsWith('..') || rel.includes(`..${sep}`) || rel === '') return undefined
  return { root, dir }
}

export function renderPluginStub(skillName, pluginHint, description) {
  const pkg = {
    name: `@dsh-local/${pluginHint}`,
    version: '0.0.0',
    private: true,
    type: 'module',
    description: `Companion stub for skill ${skillName}. Not installed into a profile.`,
    main: 'lib/index.js',
  }
  const index = [
    `// Companion stub for skill ${skillName}.`,
    '// Not installed. Copy into a profile plugins/ directory and add a file: dependency.',
    '// Do not put secrets here. Tools for the skill go in apply().',
    `export const name = ${JSON.stringify(`@dsh-local/${pluginHint}`)}`,
    'export function apply() {}',
    '',
  ].join('\n')
  const companion = {
    skill: skillName,
    plugin: pluginHint,
    installed: false,
    root: 'user-dsh',
    note: '未装进 profile，避免宿主加载未完成的插件',
    description,
  }
  const install = [
    `# ${pluginHint}`,
    '',
    `Companion for \`~/.dsh/skills/${skillName}\`.`,
    'This folder is a stub. It is not loaded by DSH until you add it to a profile package.json.',
    '',
  ].join('\n')
  return { pkg, index, companion, install }
}

export async function writePluginStub(home, skillName, pluginHint, description) {
  const target = pluginStubRoot(home, pluginHint)
  if (target === undefined) {
    return { ok: false, status: 400, code: 'INVALID_PATH', error: '插件脚手架路径非法。' }
  }
  await mkdir(join(target.dir, 'lib'), { recursive: true })
  const files = renderPluginStub(skillName, pluginHint, description)
  try {
    await writeFile(join(target.dir, 'package.json'), `${JSON.stringify(files.pkg, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
  } catch (error) {
    if (error && error.code === 'EEXIST') {
      return { ok: false, status: 409, code: 'STUB_EXISTS', error: '插件脚手架已存在，拒绝覆盖。' }
    }
    throw error
  }
  await writeFile(join(target.dir, 'lib', 'index.js'), files.index, { encoding: 'utf8', flag: 'wx' })
  await writeFile(join(target.dir, 'companion.json'), `${JSON.stringify(files.companion, null, 2)}\n`, { encoding: 'utf8' })
  await writeFile(join(target.dir, 'INSTALL.md'), files.install, { encoding: 'utf8' })
  return { ok: true, path: target.dir, installed: false }
}

function modelRoot(home, name) {
  const root = resolve(home, '.dsh', 'skills')
  const dir = resolve(root, name)
  const rel = relative(root, dir)
  if (rel.startsWith('..') || rel.includes(`..${sep}`) || rel === '') {
    return undefined
  }
  return { root, dir, file: join(dir, 'SKILL.md'), evalsFile: join(dir, 'evals', 'evals.json') }
}

export async function createSkillDraft(input, options = {}) {
  const home = options.home ?? homedir()
  const draft = validateDraft(input)
  if (draft.errors.length > 0) {
    return { ok: false, status: 400, code: 'INVALID_DRAFT', error: draft.errors.join(' ') }
  }
  const evals = normalizeEvals(input?.evals)
  if (evals.errors.length > 0) {
    return { ok: false, status: 400, code: 'INVALID_EVALS', error: evals.errors.join(' ') }
  }
  const target = modelRoot(home, draft.name)
  if (target === undefined) {
    return { ok: false, status: 400, code: 'INVALID_PATH', error: '写入路径非法。' }
  }
  if (existsSync(target.file)) {
    return { ok: false, status: 409, code: 'EXISTS', error: '已存在，拒绝覆盖。' }
  }
  let pluginStub
  if (draft.needsPlugin) {
    const stub = await writePluginStub(home, draft.name, draft.pluginHint, draft.description)
    if (!stub.ok) return stub
    pluginStub = stub.path
  }
  await mkdir(target.dir, { recursive: true })
  const markdown = renderSkillMarkdown(draft)
  try {
    await writeFile(target.file, markdown, { encoding: 'utf8', flag: 'wx' })
  } catch (error) {
    if (error && error.code === 'EEXIST') {
      return { ok: false, status: 409, code: 'EXISTS', error: '已存在，拒绝覆盖。' }
    }
    throw error
  }
  let evalsPath
  if (evals.evals.length > 0) {
    await mkdir(join(target.dir, 'evals'), { recursive: true })
    try {
      await writeFile(
        target.evalsFile,
        `${JSON.stringify({ skill_name: draft.name, evals: evals.evals }, null, 2)}\n`,
        { encoding: 'utf8', flag: 'wx' },
      )
      evalsPath = target.evalsFile
    } catch (error) {
      if (error && error.code === 'EEXIST') {
        return { ok: false, status: 409, code: 'EVALS_EXIST', error: '评测集已存在，拒绝覆盖。' }
      }
      throw error
    }
  }
  return {
    ok: true,
    name: draft.name,
    path: target.file,
    evalsPath,
    pluginStub,
    pluginInstalled: false,
    root: 'user-dsh',
  }
}

function readFrontmatterFields(raw) {
  if (!String(raw).startsWith('---')) return { fields: {}, body: raw }
  const end = raw.indexOf('\n---', 3)
  if (end < 0) return { fields: {}, body: raw }
  const lines = raw.slice(4, end).split('\n')
  const fields = {}
  for (let i = 0; i < lines.length; i += 1) {
    const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(lines[i])
    if (!match) continue
    const value = match[2].trim()
    if (BLOCK_SCALAR_RX.test(value)) {
      const collected = []
      let j = i + 1
      for (; j < lines.length; j += 1) {
        if (lines[j].trim() === '') { collected.push(''); continue }
        if (!/^[ \t]/.test(lines[j])) break
        collected.push(lines[j].replace(/^[ \t]+/, ''))
      }
      fields[match[1]] = collected.join(value.startsWith('>') ? ' ' : '\n').replace(/\s+/g, ' ').trim()
      i = j - 1
    } else {
      fields[match[1]] = value.replace(/^["']|["']$/g, '')
    }
  }
  return { fields, body: raw.slice(end + 5).trim() }
}

export async function readStudioSkill(name, options = {}) {
  const home = options.home ?? homedir()
  const normalized = normalizeSkillName(name)
  if (!SKILL_NAME_RE.test(normalized)) {
    return { ok: false, status: 400, code: 'INVALID_NAME', error: '名称必须是小写 kebab-case。' }
  }
  const target = modelRoot(home, normalized)
  if (target === undefined) {
    return { ok: false, status: 400, code: 'INVALID_PATH', error: '读取路径非法。' }
  }
  if (!existsSync(target.file)) {
    return { ok: false, status: 404, code: 'MISSING', error: '模型根没有这个技能。' }
  }
  const raw = await readFile(target.file, 'utf8')
  const parsed = readFrontmatterFields(raw)
  let evals = []
  if (existsSync(target.evalsFile)) {
    try {
      const payload = JSON.parse(await readFile(target.evalsFile, 'utf8'))
      evals = normalizeEvals(payload.evals).evals
    } catch {
      return { ok: false, status: 400, code: 'INVALID_EVALS', error: '评测集无法读取。' }
    }
  }
  const pluginHint = /plugin-stubs\/([a-z0-9-]+)\//.exec(raw)?.[1]
    ?? normalizeSkillName(parsed.fields.plugin || '')
  const stubDir = pluginHint ? pluginStubRoot(home, pluginHint)?.dir : undefined
  return {
    ok: true,
    name: normalized,
    description: String(parsed.fields.description ?? '').trim(),
    whenToUse: String(parsed.fields.whenToUse ?? '').trim(),
    body: parsed.body,
    evals: evals.map((row) => ({ query: row.prompt, shouldTrigger: row.should_trigger })),
    path: target.file,
    evalsPath: existsSync(target.evalsFile) ? target.evalsFile : undefined,
    pluginHint: pluginHint || undefined,
    pluginStub: stubDir && existsSync(stubDir) ? stubDir : undefined,
    root: 'user-dsh',
  }
}

export async function patchSkillDescription(input, options = {}) {
  const home = options.home ?? homedir()
  if (input?.confirm !== true) {
    return { ok: false, status: 400, code: 'UNCONFIRMED', error: '改 description 需要确认。' }
  }
  const draft = validateDraft({
    name: input?.name,
    description: input?.description,
  })
  if (draft.errors.length > 0) {
    return { ok: false, status: 400, code: 'INVALID_DRAFT', error: draft.errors.join(' ') }
  }
  const target = modelRoot(home, draft.name)
  if (target === undefined) {
    return { ok: false, status: 400, code: 'INVALID_PATH', error: '写入路径非法。' }
  }
  if (!existsSync(target.file)) {
    return { ok: false, status: 404, code: 'MISSING', error: '模型根没有这个技能。' }
  }
  const raw = await readFile(target.file, 'utf8')
  const next = replaceDescriptionFrontmatter(raw, draft.description)
  if (next === undefined) {
    return { ok: false, status: 400, code: 'NO_DESCRIPTION', error: '文件没有 description 字段。' }
  }
  await writeFile(target.file, next, { encoding: 'utf8' })
  return { ok: true, name: draft.name, path: target.file, root: 'user-dsh' }
}
