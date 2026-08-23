import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib'
import test from 'node:test'

import {
  analyzeShadowing,
  categoryOf,
  estimateIndexBudget,
  decompressSessionFile,
  discoverSessionRoots,
  loadSkillUsageCached,
  scanSkillUsage,
  skillNamesFromEvent,
} from '../lib/skills-console.js'

test('categoryOf matches librarian seven-bucket taxonomy', () => {
  assert.equal(categoryOf('book-chaos'), 'books')
  assert.equal(categoryOf('child-scale'), 'concept children')
  assert.equal(categoryOf('networks-meta'), 'meta-index')
  assert.equal(categoryOf('ask'), 'functional / tools / methodology')
})

test('analyzeShadowing picks lower DSH rank as winner and flags drift', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agos-shadow-'))
  const dsh = join(root, 'dsh')
  const agents = join(root, 'agents')
  const claude = join(root, 'claude')
  for (const dir of [dsh, agents, claude]) await mkdir(dir, { recursive: true })

  async function put(base, name, body) {
    const dir = join(base, name)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: Use when testing ${body}\n---\n\n# ${body}\n`)
  }

  await put(dsh, 'shared', 'dsh-copy')
  await put(agents, 'shared', 'agents-copy') // drifted
  await put(claude, 'shared', 'dsh-copy') // same as dsh
  await put(agents, 'only-agents', 'agents-only')
  await put(claude, 'only-claude', 'claude-only')

  const { shadowing, catalog, consistency } = analyzeShadowing([
    { path: claude, source: 'console-claude', servedToModel: false, rank: null },
    { path: dsh, source: 'user-dsh', servedToModel: true, rank: 400 },
    { path: agents, source: 'user-agents', servedToModel: true, rank: 500 },
  ])

  const shared = shadowing.find((s) => s.name === 'shared')
  assert.ok(shared)
  assert.equal(shared.winner, dsh)
  assert.equal(shared.drifted, true)
  assert.equal(consistency.duplicateNames, 1)
  assert.equal(consistency.drifted, 1)

  const row = catalog.find((c) => c.name === 'shared')
  assert.equal(row?.source, 'user-dsh')
  assert.equal(row?.servedToModel, true)
  assert.equal(catalog.find((c) => c.name === 'only-claude')?.servedToModel, false)
  assert.match(consistency.summary, /1 个 skill 在多根重复/)
})

test('skillNamesFromEvent reads tool/call arguments and skill-invocation source', () => {
  assert.deepEqual(
    skillNamesFromEvent({
      type: 'tool/call',
      time: 100,
      data: { name: 'skill', arguments: '{"name":"fail-log-guide"}' },
    }),
    [{ name: 'fail-log-guide', at: 100 }],
  )
  assert.deepEqual(
    skillNamesFromEvent({
      type: 'user/message',
      time: 200,
      data: { source: { kind: 'skill-invocation', name: 'ask' } },
    }),
    [{ name: 'ask', at: 200 }],
  )
  assert.deepEqual(skillNamesFromEvent({ type: 'tool/call', data: { name: 'bash' } }), [])
})

test('loadSkillUsageCached scans session.jsonl.zstd and writes cache', async () => {
  const home = await mkdtemp(join(tmpdir(), 'agos-usage-'))
  const sessionsRoot = join(home, 'sessions')
  const sessionDir = join(sessionsRoot, 'proj', 'session-1')
  await mkdir(sessionDir, { recursive: true })
  const lines = [
    JSON.stringify({ type: 'tool/call', time: 1000, data: { name: 'skill', arguments: '{"name":"alpha"}' } }),
    JSON.stringify({ type: 'tool/call', time: 2000, data: { name: 'skill', arguments: '{"name":"alpha"}' } }),
    JSON.stringify({ type: 'user/message', time: 3000, data: { source: { kind: 'skill-invocation', name: 'beta' } } }),
  ].join('\n')
  await writeFile(join(sessionDir, 'session.jsonl.zstd'), zstdCompressSync(Buffer.from(lines)))

  const agosDir = join(home, 'agos')
  const first = await loadSkillUsageCached({
    home,
    sessionsRoot,
    agosDir,
    cachePath: join(agosDir, 'skill-usage.json'),
    force: true,
  })
  assert.equal(first.cache, 'miss')
  assert.equal(first.usage.alpha.count, 2)
  assert.equal(first.usage.alpha.lastAt, 2000)
  assert.equal(first.usage.beta.count, 1)

  const second = await loadSkillUsageCached({
    home,
    sessionsRoot,
    agosDir,
    cachePath: join(agosDir, 'skill-usage.json'),
    force: false,
    now: () => first.at + 1000,
  })
  assert.equal(second.cache, 'hit')
  assert.equal(second.usage.alpha.count, 2)
  assert.ok(Array.isArray(first.roots))
})

test('discoverSessionRoots includes trash and backup, scanSkillUsage sums them', async () => {
  const home = await mkdtemp(join(tmpdir(), 'agos-usage-roots-'))
  const dshHome = join(home, '.dsh')
  const activeDir = join(dshHome, 'sessions', 'proj', 'live-1')
  const trashDir = join(dshHome, 'sessions-trash-20260820', 'proj', 'old-1')
  await mkdir(activeDir, { recursive: true })
  await mkdir(trashDir, { recursive: true })
  const live = JSON.stringify({ type: 'tool/call', time: 1, data: { name: 'skill', arguments: '{"name":"live-skill"}' } })
  const old = JSON.stringify({ type: 'tool/call', time: 2, data: { name: 'skill', arguments: '{"name":"old-skill"}' } })
  await writeFile(join(activeDir, 'session.jsonl.zstd'), zstdCompressSync(Buffer.from(live)))
  await writeFile(join(trashDir, 'session.jsonl.zstd'), zstdCompressSync(Buffer.from(old)))

  const roots = discoverSessionRoots(dshHome)
  assert.equal(roots.length, 2)
  assert.ok(roots.some((root) => root.endsWith('sessions')))
  assert.ok(roots.some((root) => root.includes('sessions-trash-20260820')))

  const scanned = await loadSkillUsageCached({
    home,
    dshHome,
    agosDir: join(home, 'agos'),
    cachePath: join(home, 'agos', 'skill-usage.json'),
    force: true,
  })
  assert.equal(scanned.files, 2)
  assert.equal(scanned.events, 2)
  assert.equal(scanned.usage['live-skill']?.count, 1)
  assert.equal(scanned.usage['old-skill']?.count, 1)
})

test('CLI decompress sums two zstd frames; zlib only sees the first', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agos-zstd-frames-'))
  const frame1 = execFileSync('zstd', ['-c'], { input: 'line-a\nline-b\n' })
  const frame2 = execFileSync('zstd', ['-c'], { input: 'line-c\n' })
  const multi = Buffer.concat([frame1, frame2])
  const file = join(dir, 'session.jsonl.zstd')
  await writeFile(file, multi)
  const cli = await decompressSessionFile(file, multi)
  assert.equal(cli.toString('utf8').trim().split('\n').length, 3)
  const zlibOnly = zstdDecompressSync(multi).toString('utf8').trim().split('\n')
  assert.equal(zlibOnly.length, 2)
})

test('walkSessionFiles records an unreadable root and still scans the others', async () => {
  const home = await mkdtemp(join(tmpdir(), 'agos-root-err-'))
  const good = join(home, 'sessions', 'proj', 's1')
  await mkdir(good, { recursive: true })
  const live = JSON.stringify({ type: 'tool/call', time: 1, data: { name: 'skill', arguments: '{"name":"kept"}' } })
  await writeFile(join(good, 'session.jsonl.zstd'), zstdCompressSync(Buffer.from(live)))
  const broken = join(home, 'not-a-dir')
  await writeFile(broken, 'not a directory')
  const scanned = await scanSkillUsage([join(home, 'sessions'), broken])
  assert.equal(scanned.usage.kept?.count, 1)
  assert.equal(scanned.errors.length, 1)
  assert.equal(scanned.errors[0].root, broken)
})

test('scanSkillUsage yields the event loop between files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agos-yield-'))
  const proj = join(root, 'proj')
  await mkdir(proj, { recursive: true })
  const line = JSON.stringify({ type: 'tool/call', time: 1, data: { name: 'skill', arguments: '{"name":"x"}' } })
  const buf = zstdCompressSync(Buffer.from(line))
  for (let i = 0; i < 16; i += 1) {
    const dir = join(proj, `session-${i}`)
    await mkdir(dir)
    await writeFile(join(dir, 'session.jsonl.zstd'), buf)
  }
  let ticks = 0
  const timer = setInterval(() => { ticks += 1 }, 10)
  await scanSkillUsage(root, {
    concurrency: 1,
    decompress: async () => {
      const start = Date.now()
      while (Date.now() - start < 25) { /* sync-heavy decompress */ }
      return buf
    },
  })
  clearInterval(timer)
  assert.ok(ticks >= 4, `expected event-loop ticks during scan, got ${ticks}`)
})

test('estimateIndexBudget reports overshoot vs 1000-token target', () => {
  const catalog = Array.from({ length: 10 }, (_, i) => ({
    name: `skill-${i}`,
    description: 'x'.repeat(500),
    modelInvocable: true,
    category: 'functional / tools / methodology',
    descChars: 500,
    descTokensEstimate: Math.round(500 / 2.5),
  }))
  const budget = estimateIndexBudget(catalog)
  assert.ok(budget.indexTokensEstimate > 1000)
  assert.equal(budget.topExpensiveDescriptions.length, 10)
  assert.equal(budget.topExpensiveDescriptions[0].suggestedCompressPct, 48)
})
