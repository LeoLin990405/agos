// Skills console helpers: root union, shadowing, usage cache, catalog projection.
// Report-only — never mutates skill files.
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { mkdir, readdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { zstdDecompressSync } from 'node:zlib'

const execFileAsync = promisify(execFile)
const SCAN_CONCURRENCY = 4

/** DSH skill-filesystem ranks (user-level roots). Lower wins. */
export const USER_DSH_RANK = 400
export const USER_AGENTS_RANK = 500

/** Console audit ∪ DSH runtime user roots. Project roots are cwd-dependent and omitted here. */
export function defaultSkillRootDefs(home = homedir()) {
  return [
    {
      path: join(home, '.claude', 'skills'),
      source: 'console-claude',
      servedToModel: false,
      rank: null,
    },
    {
      path: join(home, '.dsh', 'skills'),
      source: 'user-dsh',
      servedToModel: true,
      rank: USER_DSH_RANK,
    },
    {
      path: join(home, '.agents', 'skills'),
      source: 'user-agents',
      servedToModel: true,
      rank: USER_AGENTS_RANK,
    },
  ]
}

const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const PATHS_GATE_HINTS = [
  'pdf', 'pptx', 'docx', 'xlsx', 'csv', 'svg', 'png', 'jpg', 'jpeg', 'webp',
  'playwright', 'puppeteer', 'browser', 'selenium', 'figma', 'video', 'audio',
  'ffmpeg', 'image', 'screenshot', 'markdown', 'html', 'css', 'typescript',
  'python', 'sql', 'jupyter',
]

export function categoryOf(name) {
  const pairs = [
    ['wdkns-series-', 'wdkns / series'],
    ['wdkns-child-', 'wdkns / child'],
    ['wdkns-up-', 'wdkns / up'],
    ['book-', 'books'],
    ['child-', 'concept children'],
  ]
  for (const [pref, cat] of pairs) {
    if (name.startsWith(pref)) return cat
  }
  if (name.endsWith('-meta') || name.includes('-meta-')) return 'meta-index'
  return 'functional / tools / methodology'
}

export function pathsGateCandidate(name) {
  const lower = String(name || '').toLowerCase()
  return PATHS_GATE_HINTS.some((hint) => lower === hint || lower.includes(hint))
}

function skillDirs(root) {
  if (!existsSync(root)) return []
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.') && !d.name.startsWith('_'))
      .filter((d) => existsSync(join(root, d.name, 'SKILL.md')))
      .map((d) => d.name)
  } catch {
    return []
  }
}

function bodyHash(text) {
  const norm = String(text).replace(/\s+/g, ' ').trim()
  return createHash('sha1').update(norm).digest('hex')
}

// YAML 块标量(`>` 折叠 / `|` 字面,可带 - + chomping)必须吃掉后续缩进行。
// 逐行正则只捕获同一行的剩余部分,于是 `description: >-` 会把描述存成字面量 ">-"。
// 实测本机 383 个 skill 里 306 个这么写描述(>- 291 / | 12 / > 3):目录页把 YAML
// 记号当描述画出来(数据零编造)、这 306 个按描述搜不到、索引预算也是从这些
// 2 字符的残缺描述算出来的,W5 的预算结论因此整个不成立(2026-08-21 验收 P0)。
const BLOCK_SCALAR_RX = /^[|>][-+]?\d*$/

function parseFrontmatter(raw) {
  if (!raw.startsWith('---')) return { fm: {}, body: raw }
  const parts = raw.split('---', 3)
  if (parts.length < 3) return { fm: {}, body: raw }
  const fm = {}
  const lines = parts[1].split('\n')
  for (let i = 0; i < lines.length; i += 1) {
    const m = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(lines[i])
    if (!m) continue
    const value = m[2].trim()
    if (BLOCK_SCALAR_RX.test(value)) {
      const folded = value.startsWith('>')
      const collected = []
      let j = i + 1
      for (; j < lines.length; j += 1) {
        const next = lines[j]
        if (next.trim() === '') { collected.push(''); continue }
        if (!/^[ \t]/.test(next)) break        // 回到零缩进 = 块结束
        if (/^[ \t]*[A-Za-z0-9_-]+:\s/.test(next) && !/^[ \t]{4,}/.test(next)) break
        collected.push(next.replace(/^[ \t]+/, ''))
      }
      while (collected.length && collected[collected.length - 1] === '') collected.pop()
      // 折叠标量:换行并成空格(空行才是真换行);字面标量:保留换行。
      fm[m[1]] = folded
        ? collected.reduce((acc, line) => (
          line === '' ? acc + '\n' : (acc === '' || acc.endsWith('\n') ? acc + line : acc + ' ' + line)
        ), '').trim()
        : collected.join('\n').trim()
      i = j - 1
      continue
    }
    fm[m[1]] = value.replace(/^["']|["']$/g, '')
  }
  return { fm, body: parts[2] }
}

function readSkillFile(root, name) {
  const path = join(root, name, 'SKILL.md')
  try {
    const raw = readFileSync(path, 'utf8')
    const { fm, body } = parseFrontmatter(raw)
    return {
      name,
      path,
      raw,
      hash: bodyHash(raw),
      description: String(fm.description || '').trim(),
      whenToUse: String(fm['when-to-use'] || fm.whenToUse || '').trim() || undefined,
      modelInvocable: !(
        fm['disable-model-invocation'] === 'true'
        || fm['disable-model-invocation'] === true
        || fm['user-invocable'] === 'false'
        || fm['user-invocable'] === false
      ),
      bodyChars: body.length,
      descChars: String(fm.description || '').length,
    }
  } catch {
    return null
  }
}

/** Cross-root shadowing: same name in multiple roots; winner = lowest DSH rank among servedToModel. */
export function analyzeShadowing(rootDefs, options = {}) {
  const read = options.readSkill || readSkillFile
  const byName = new Map()
  for (const def of rootDefs) {
    if (!existsSync(def.path)) continue
    for (const name of skillDirs(def.path)) {
      const skill = read(def.path, name)
      if (!skill) continue
      const list = byName.get(name) || []
      list.push({
        name,
        root: def.path,
        source: def.source,
        servedToModel: !!def.servedToModel,
        rank: def.rank,
        hash: skill.hash,
        description: skill.description,
        whenToUse: skill.whenToUse,
        modelInvocable: skill.modelInvocable,
        descChars: skill.descChars,
        bodyChars: skill.bodyChars,
      })
      byName.set(name, list)
    }
  }

  const shadowing = []
  const catalog = []
  for (const [name, copies] of byName) {
    const served = copies.filter((c) => c.servedToModel && c.rank != null)
    let winner = null
    if (served.length > 0) {
      winner = served.reduce((a, b) => (a.rank <= b.rank ? a : b))
    } else {
      winner = copies[0]
    }
    const hashes = new Set(copies.map((c) => c.hash))
    const drifted = hashes.size > 1
    if (copies.length > 1) {
      shadowing.push({
        name,
        winner: winner.root,
        winnerSource: winner.source,
        shadowed: copies.filter((c) => c.root !== winner.root).map((c) => ({
          root: c.root,
          source: c.source,
          servedToModel: c.servedToModel,
          rank: c.rank,
        })),
        drifted,
      })
    }
    catalog.push({
      name,
      description: winner.description,
      whenToUse: winner.whenToUse,
      modelInvocable: winner.modelInvocable,
      category: categoryOf(name),
      root: winner.root,
      source: winner.source,
      servedToModel: !!winner.servedToModel,
      shadowed: copies.length > 1,
      drifted: copies.length > 1 && drifted,
      pathsGateCandidate: pathsGateCandidate(name),
      descChars: winner.descChars,
      descTokensEstimate: Math.round(winner.descChars / 2.5),
    })
  }

  catalog.sort((a, b) => a.name.localeCompare(b.name))
  shadowing.sort((a, b) => a.name.localeCompare(b.name))
  const driftedCount = shadowing.filter((s) => s.drifted).length
  return {
    shadowing,
    catalog,
    consistency: {
      duplicateNames: shadowing.length,
      drifted: driftedCount,
      summary: shadowing.length === 0
        ? '各根无同名 skill'
        : `${shadowing.length} 个 skill 在多根重复，其中 ${driftedCount} 个内容不一致`,
    },
  }
}

export function estimateIndexBudget(catalog) {
  let chars = 0
  for (const row of catalog) {
    chars += (row.name || '').length + (row.description || '').length
  }
  const tokensEstimate = Math.round(chars / 2.5)
  const topExpensive = [...catalog]
    .sort((a, b) => (b.descChars || 0) - (a.descChars || 0))
    .slice(0, 20)
    .map((row) => ({
      name: row.name,
      descChars: row.descChars || 0,
      descTokensEstimate: row.descTokensEstimate || 0,
      suggestedCompressPct: 48,
    }))
  return {
    indexChars: chars,
    indexTokensEstimate: tokensEstimate,
    indexBudgetTarget: 1000,
    overshootFactor: tokensEstimate > 0 ? Number((tokensEstimate / 1000).toFixed(1)) : 0,
    topExpensiveDescriptions: topExpensive,
  }
}

function parseSkillArgs(argumentsValue) {
  if (argumentsValue == null) return null
  let args = argumentsValue
  if (typeof args === 'string') {
    try { args = JSON.parse(args) } catch { return null }
  }
  if (typeof args !== 'object' || args === null) return null
  const name = args.name
  return typeof name === 'string' && name.length > 0 ? name : null
}

/** Extract skill invocations from one session event object. */
/**
 * DSH 的 session.jsonl.zstd 是**多帧** zstd(逐事件追加,每次 append 一帧)。
 * node:zlib 的 zstdDecompressSync 只解第一帧就返回 —— 实测同一个文件
 * CLI `zstd -dc` 出 280 行,zstdDecompressSync 只出 2 行,且**不报错**。
 * 这正是使用率统计一直报 0 events 的原因(2026-08-21 验收实测)。
 * 上游 scripts/replay-check.ts 用的就是 CLI(execFileSync('zstd',['-dc',...])),
 * 那条路径能正确读满 392 会话 / 114949 事件,所以这里对齐它。
 * CLI 缺席时回落到单帧解压并在 meta 里标注,不静默给出偏低的数字。
 */
let zstdCliAvailable
export async function decompressSessionFile(file, compressed) {
  if (zstdCliAvailable === undefined) {
    try {
      await execFileAsync('zstd', ['--version'])
      zstdCliAvailable = true
    } catch { zstdCliAvailable = false }
  }
  if (zstdCliAvailable) {
    try {
      const { stdout } = await execFileAsync('zstd', ['-dc', file], { maxBuffer: 256 * 1024 * 1024 })
      return stdout
    } catch { /* 落到下面的单帧回退 */ }
  }
  return zstdDecompressSync(compressed)
}

async function mapPool(items, limit, worker) {
  const pending = new Set()
  const tasks = []
  for (const item of items) {
    const p = Promise.resolve(worker(item)).finally(() => pending.delete(p))
    pending.add(p)
    tasks.push(p)
    if (pending.size >= limit) await Promise.race(pending)
  }
  return Promise.all(tasks)
}

export function skillNamesFromEvent(obj) {
  const names = []
  if (!obj || typeof obj !== 'object') return names
  const data = obj.data
  if (!data || typeof data !== 'object') return names
  const time = typeof obj.time === 'number' ? obj.time : undefined

  const src = data.source
  if (src && typeof src === 'object' && src.kind === 'skill-invocation' && typeof src.name === 'string') {
    names.push({ name: src.name, at: time })
  }

  if (obj.type === 'tool/call' && data.name === 'skill') {
    const name = parseSkillArgs(data.arguments)
    if (name) names.push({ name, at: time })
  }

  return names
}

async function* walkSessionFiles(sessionsRoot, onRootError) {
  if (!existsSync(sessionsRoot)) return
  let projects
  try {
    projects = await readdir(sessionsRoot, { withFileTypes: true })
  } catch (err) {
    onRootError?.(sessionsRoot, err)
    return
  }
  for (const project of projects) {
    if (!project.isDirectory()) continue
    const projectPath = join(sessionsRoot, project.name)
    let sessions
    try { sessions = await readdir(projectPath, { withFileTypes: true }) } catch { continue }
    for (const session of sessions) {
      if (!session.isDirectory()) continue
      const file = join(projectPath, session.name, 'session.jsonl.zstd')
      if (existsSync(file)) yield file
    }
  }
}

/** Active sessions plus any sessions-trash-* / sessions-backup-* that still exist. */
export function discoverSessionRoots(dshHome) {
  const roots = []
  const active = join(dshHome, 'sessions')
  if (existsSync(active)) roots.push(active)
  let names = []
  try { names = readdirSync(dshHome) } catch { return roots }
  for (const name of names.sort()) {
    if (!/^sessions-(trash|backup)-/.test(name)) continue
    const path = join(dshHome, name)
    if (existsSync(path)) roots.push(path)
  }
  return roots
}

export async function scanSkillUsage(sessionsRoot, options = {}) {
  const roots = Array.isArray(sessionsRoot) ? sessionsRoot : [sessionsRoot]
  const usage = Object.create(null)
  const errors = []
  const fileList = []
  let events = 0
  for (const root of roots) {
    try {
      for await (const file of walkSessionFiles(root, (failedRoot, err) => {
        errors.push({ root: failedRoot, error: String(err && err.message ? err.message : err).slice(0, 200) })
      })) {
        fileList.push(file)
      }
    } catch (err) {
      errors.push({ root, error: String(err && err.message ? err.message : err).slice(0, 200) })
    }
  }

  const concurrency = Number.isFinite(options.concurrency) && options.concurrency > 0
    ? options.concurrency
    : SCAN_CONCURRENCY
  const decompress = options.decompress || decompressSessionFile

  await mapPool(fileList, concurrency, async (file) => {
    let raw
    try {
      const compressed = options.readFileSync
        ? options.readFileSync(file)
        : readFileSync(file)
      raw = await decompress(file, compressed)
    } catch {
      await new Promise((resolve) => setImmediate(resolve))
      return
    }
    for (const line of raw.toString('utf8').split('\n')) {
      if (!line || !line.includes('skill')) continue
      let obj
      try { obj = JSON.parse(line) } catch { continue }
      for (const hit of skillNamesFromEvent(obj)) {
        events += 1
        const cur = usage[hit.name] || { count: 0, lastAt: 0 }
        cur.count += 1
        if (typeof hit.at === 'number' && hit.at > cur.lastAt) cur.lastAt = hit.at
        usage[hit.name] = cur
      }
    }
    await new Promise((resolve) => setImmediate(resolve))
  })
  return { usage, files: fileList.length, events, at: Date.now(), roots, errors }
}

const USAGE_TTL_MS = 10 * 60 * 1000

export async function loadSkillUsageCached(options = {}) {
  const home = options.home || homedir()
  const agosDir = options.agosDir || join(home, '.dsh', 'agos')
  const cachePath = options.cachePath || join(agosDir, 'skill-usage.json')
  const dshHome = options.dshHome || join(home, '.dsh')
  const sessionsRoots = Array.isArray(options.sessionsRoots)
    ? options.sessionsRoots
    : options.sessionsRoot
      ? [options.sessionsRoot]
      : discoverSessionRoots(dshHome)
  const force = !!options.force
  const now = options.now ? options.now() : Date.now()

  if (!force && existsSync(cachePath)) {
    try {
      const cached = JSON.parse(readFileSync(cachePath, 'utf8'))
      // 无 roots 的旧缓存是只扫活跃目录的产物,必须重扫,不能当当前分母。
      if (cached && cached.at && now - cached.at < USAGE_TTL_MS && cached.usage && Array.isArray(cached.roots)) {
        return { ...cached, cache: 'hit' }
      }
    } catch { /* rebuild */ }
  }

  const scanned = await scanSkillUsage(sessionsRoots, options)
  const payload = {
    at: scanned.at,
    files: scanned.files,
    events: scanned.events,
    roots: scanned.roots,
    usage: scanned.usage,
    note: '从未用过是信号不是判决；分母是 usageMeta.roots 里实际扫到的会话根。',
    errors: scanned.errors,
  }
  try {
    await mkdir(agosDir, { recursive: true })
    await writeFile(cachePath, JSON.stringify(payload), 'utf8')
  } catch { /* cache best-effort */ }
  return { ...payload, cache: 'miss' }
}

export function annotateRootAudit(audit, def) {
  return {
    ...audit,
    source: def.source,
    servedToModel: !!def.servedToModel,
    rank: def.rank,
  }
}

export { NAME_RE, PATHS_GATE_HINTS, skillDirs, readSkillFile, bodyHash }
