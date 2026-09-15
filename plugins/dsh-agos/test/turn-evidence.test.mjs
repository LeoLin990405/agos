import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'

import {
  MEMORY_UNCOLLECTED_COPY,
  PLUGINS_UNCOLLECTED_COPY,
  SKILLS_UNCOLLECTED_COPY,
  TURN_UNCOLLECTED_COPY,
  bindEvidencePatch,
  createTurnEvidenceStore,
  describeTurnEvidence,
  resolveHostTurnBind,
} from '../lib/turn-evidence.js'

test('empty store stays uncollected and does not invent zeros', () => {
  const store = createTurnEvidenceStore()
  const empty = describeTurnEvidence('sess-1', store, {})
  assert.equal(empty.collected, false)
  assert.equal(empty.copy, TURN_UNCOLLECTED_COPY)
  assert.equal(empty.memory.prepended, null)
  assert.equal(empty.memory.copy, MEMORY_UNCOLLECTED_COPY)
  assert.equal(empty.skills.served, null)
  assert.equal(empty.skills.copy, SKILLS_UNCOLLECTED_COPY)
  assert.equal(empty.plugins.profile, null)
  assert.equal(empty.plugins.copy, PLUGINS_UNCOLLECTED_COPY)
})

test('recorded pre-step keeps prepended 0 distinct from uncollected', () => {
  const store = createTurnEvidenceStore()
  store.record('sess-1', {
    memory: { enabled: true, prepended: 0, itemCount: 0 },
    skills: { trimmed: true, query: '整理 inbox', served: ['inbox-triage'] },
  }, new Date('2026-09-07T08:00:00.000Z'))
  const next = describeTurnEvidence('sess-1', store, {
    currentProcess: 'web',
    profiles: [{ name: 'web', plugins: [{ id: 'dsh-agos', kind: 'agos' }] }],
  })
  assert.equal(next.collected, true)
  assert.equal(next.memory.prepended, 0)
  assert.equal(next.memory.copy, '回注已启用，本跳 prepend 0 条')
  assert.deepEqual(next.skills.served, ['inbox-triage'])
  assert.equal(next.plugins.profile, 'web')
  assert.deepEqual(next.plugins.agosLoaded, ['dsh-agos'])
})

test('impressions stay listed and reserved is not relevance', () => {
  const store = createTurnEvidenceStore()
  store.record('sess-2', {
    memory: {
      enabled: true,
      prepended: 1,
      itemCount: 2,
      method: 'lexical+posterior',
      query: '3091',
      reserved: true,
      impressions: [{ id: 'aaaaaaaaaaaaaaaaaaaaaaaa', kind: 'constraint', text: '不要改 fold', method: 'constraint-reserve' }],
      copy: '本跳回注 1/2 · 词面短名单 · 含约束保送',
    },
  }, new Date('2026-09-07T08:01:00.000Z'))
  const reserved = describeTurnEvidence('sess-2', store, { currentProcess: 'web' })
  assert.equal(reserved.memory.reserved, true)
  assert.deepEqual(reserved.memory.impressions, [
    { id: 'aaaaaaaaaaaaaaaaaaaaaaaa', kind: 'constraint', text: '不要改 fold', method: 'constraint-reserve' },
  ])
  assert.equal(reserved.memory.impressions === null, false)
})

test('a later memory lane replaces impressions instead of merging the prior turn', () => {
  const store = createTurnEvidenceStore()
  store.record('sess-3', {
    memory: {
      enabled: true,
      prepended: 1,
      impressions: [{ id: 'aaaaaaaaaaaaaaaaaaaaaaaa', kind: 'constraint', text: '不要改 fold' }],
    },
    skills: { trimmed: true, query: '整理 inbox', served: ['inbox-triage'] },
  })
  store.record('sess-3', {
    memory: { enabled: false, prepended: 0, impressions: [], copy: '回注未启用：本跳没有 prepend' },
  })
  const next = describeTurnEvidence('sess-3', store, {})
  assert.deepEqual(next.memory.impressions, [])
  assert.equal(next.memory.enabled, false)
  assert.deepEqual(next.skills.served, ['inbox-triage'])
})

test('turn evidence ledger reloads the last row and does not invent a turn', async () => {
  const home = await mkdtemp(join(tmpdir(), 'agos-turn-ev-'))
  const first = createTurnEvidenceStore({ home })
  first.record('sess-4', {
    memory: { enabled: true, prepended: 1, query: 'fold', impressions: [{ id: 'aaaaaaaaaaaaaaaaaaaaaaaa', text: '不要改 fold' }] },
  }, new Date('2026-09-08T00:00:00.000Z'))
  first.record('sess-4', {
    memory: { enabled: true, prepended: 0, impressions: [], copy: '回注失败，本跳没有 prepend' },
  }, new Date('2026-09-08T00:01:00.000Z'))
  const reloaded = createTurnEvidenceStore({ home })
  const view = describeTurnEvidence('sess-4', reloaded, {})
  assert.equal(view.memory.prepended, 0)
  assert.deepEqual(view.memory.impressions, [])
  assert.equal(view.memory.copy, '回注失败，本跳没有 prepend')
  assert.equal(describeTurnEvidence('missing', reloaded, {}).collected, false)
})

test('host bind never invents a turn/step sequence', () => {
  const empty = resolveHostTurnBind({ sessionId: 'sess-1' })
  assert.equal(empty.sessionId, 'sess-1')
  assert.equal(empty.turn, null)
  assert.equal(empty.step, null)
  assert.equal(empty.bound, false)
  const store = createTurnEvidenceStore()
  store.record('sess-1', bindEvidencePatch({
    memory: { enabled: true, prepended: 1, itemCount: 1 },
  }, { sessionId: 'sess-1' }))
  const view = describeTurnEvidence('sess-1', store, {})
  assert.equal(view.collected, true)
  assert.equal(view.turn, null)
  assert.equal(view.step, null)
  assert.equal(store.get('sess-1').turn, undefined)
  const host = resolveHostTurnBind({ sessionId: 'sess-2', turn: 0, step: 'pre-step' })
  assert.equal(host.turn, 0)
  assert.equal(host.step, 'pre-step')
  assert.equal(host.bound, true)
})

test('cross-step evidence does not leak into another turn', () => {
  const store = createTurnEvidenceStore()
  store.record('sess-mix', {
    memory: { enabled: true, prepended: 1, itemCount: 1, copy: 'turn-1' },
  }, new Date('2026-09-08T01:00:00.000Z'), { turn: 1, step: 'pre-step' })
  store.record('sess-mix', {
    memory: { enabled: true, prepended: 2, itemCount: 4, copy: 'turn-2' },
  }, new Date('2026-09-08T01:01:00.000Z'), { turn: 2, step: 'pre-step' })
  const first = describeTurnEvidence('sess-mix', store, {}, { turn: 1, step: 'pre-step' })
  const second = describeTurnEvidence('sess-mix', store, {}, { turn: 2, step: 'pre-step' })
  const missing = describeTurnEvidence('sess-mix', store, {}, { turn: 3, step: 'pre-step' })
  assert.equal(first.collected, true)
  assert.equal(first.memory.copy, 'turn-1')
  assert.equal(first.turn, 1)
  assert.equal(second.memory.copy, 'turn-2')
  assert.equal(missing.collected, false)
  assert.equal(missing.observed, false)
  assert.equal(missing.memory.collected, false)
  assert.equal(missing.turn, 3)
  assert.equal(missing.copy, TURN_UNCOLLECTED_COPY)
})

test('persist failure stays observed but not collected or on-disk', async () => {
  const home = await mkdtemp(join(tmpdir(), 'agos-turn-ev-fail-'))
  const blocker = join(home, 'not-a-dir')
  await writeFile(blocker, 'nope')
  const store = createTurnEvidenceStore({ ledgerPath: join(blocker, 'nested', 'turn-evidence.jsonl') })
  const wrote = store.record('sess-fail', {
    memory: { enabled: true, prepended: 3, itemCount: 3 },
  }, new Date('2026-09-08T02:00:00.000Z'))
  assert.equal(wrote.observed, true)
  assert.equal(wrote.persisted, false)
  assert.ok(wrote.persistError)
  const view = describeTurnEvidence('sess-fail', store, {})
  assert.equal(view.observed, true)
  assert.equal(view.collected, false)
  assert.equal(view.persisted, false)
  assert.equal(view.durable, false)
  assert.equal(view.copy, TURN_UNCOLLECTED_COPY)
  assert.equal(view.memory.collected, false)
  assert.ok(view.persistError)
  assert.equal(store.get('sess-fail').memory.prepended, 3)
})

test('old ledger rows without persist/turn fields stay compatible', async () => {
  const home = await mkdtemp(join(tmpdir(), 'agos-turn-ev-old-'))
  const file = join(home, '.dsh', 'agos', 'turn-evidence.jsonl')
  await mkdir(join(home, '.dsh', 'agos'), { recursive: true })
  await writeFile(file, `${JSON.stringify({
    sessionId: 'sess-old',
    at: '2026-08-01T00:00:00.000Z',
    memory: { enabled: true, prepended: 1, itemCount: 2 },
  })}\n`)
  const store = createTurnEvidenceStore({ home })
  const view = describeTurnEvidence('sess-old', store, {})
  assert.equal(view.collected, true)
  assert.equal(view.persisted, true)
  assert.equal(view.durable, true)
  assert.equal(view.turn, null)
  assert.equal(view.step, null)
  assert.equal(view.memory.prepended, 1)
  assert.equal(view.memory.collected, true)
})

// ---------------------------------------------- 写侧分隔:记录永不粘在前一行上

test('write separator: a legal row without a trailing newline does not swallow the next record', async () => {
  // 合法记录但没有末尾换行(外部工具、被截断的同步写都可能留下这种尾巴):
  // 下一次 record 必须先补分隔符,两条记录重开进程后都在。
  const home = await mkdtemp(join(tmpdir(), 'agos-turn-ev-noeol-'))
  const file = join(home, '.dsh', 'agos', 'turn-evidence.jsonl')
  await mkdir(dirname(file), { recursive: true, mode: 0o700 })
  await writeFile(file, JSON.stringify({
    sessionId: 'sess-noeol', at: '2026-09-08T00:00:00.000Z', turn: 1, step: 'pre-step',
    memory: { enabled: true, prepended: 1, copy: 'no-eol-row' },
  }), { mode: 0o600 }) // 故意不写结尾换行
  const store = createTurnEvidenceStore({ home })
  const wrote = store.record('sess-noeol', {
    memory: { enabled: true, prepended: 2, copy: 'after-noeol' },
  }, new Date('2026-09-08T00:01:00.000Z'), { turn: 2, step: 'pre-step' })
  assert.equal(wrote.persisted, true)
  const reloaded = createTurnEvidenceStore({ home })
  assert.equal(describeTurnEvidence('sess-noeol', reloaded, {}, { turn: 1, step: 'pre-step' }).memory.copy, 'no-eol-row')
  assert.equal(describeTurnEvidence('sess-noeol', reloaded, {}, { turn: 2, step: 'pre-step' }).memory.copy, 'after-noeol')
  const lines = (await readFile(file, 'utf8')).split('\n').filter((line) => line.trim() !== '')
  assert.equal(lines.length, 2, '两行各自独立,前一行没有被后一行吞掉')
})

test('write separator: consecutive records never insert blank lines or duplicate separators', async () => {
  const home = await mkdtemp(join(tmpdir(), 'agos-turn-ev-contig-'))
  const store = createTurnEvidenceStore({ home })
  for (let index = 0; index < 5; index += 1) {
    const wrote = store.record('sess-contig', {
      memory: { enabled: true, prepended: index, copy: `row-${index}` },
    }, new Date('2026-09-08T00:00:00.000Z'), { turn: index, step: 'pre-step' })
    assert.equal(wrote.persisted, true)
  }
  const raw = await readFile(store.ledgerPath, 'utf8')
  assert.equal(raw.includes('\n\n'), false, '连续写入不许出现空行:分隔符只在文件尾不是换行时补一个')
  const lines = raw.split('\n').filter((line) => line.trim() !== '')
  assert.equal(lines.length, 5)
  for (const line of lines) assert.doesNotThrow(() => JSON.parse(line))
})

test('write separator: unreadable ledger tail refuses the write instead of appending blindly', async () => {
  // 尾部检查失败时绝不能「照常追加」—— 那正是原故障(粘行+假 persisted)的死法。
  // 必须如实报 persisted:false 并带真实错误码。修复的是检查,不是把失败藏起来。
  const home = await mkdtemp(join(tmpdir(), 'agos-turn-ev-eacces-'))
  const file = join(home, '.dsh', 'agos', 'turn-evidence.jsonl')
  await mkdir(dirname(file), { recursive: true, mode: 0o700 })
  await writeFile(file, `${JSON.stringify({
    sessionId: 'sess-lock', at: '2026-09-08T00:00:00.000Z', turn: 1, step: 'pre-step',
    memory: { enabled: true, prepended: 1, copy: 'first' },
  })}\n`, { mode: 0o600 })
  await chmod(file, 0o000) // 属主也读不了:tail 检查必然失败
  const store = createTurnEvidenceStore({ ledgerPath: file })
  const wrote = store.record('sess-lock', {
    memory: { enabled: true, prepended: 2, copy: 'must-not-land' },
  }, new Date('2026-09-08T00:01:00.000Z'), { turn: 2, step: 'pre-step' })
  assert.equal(wrote.observed, true)
  assert.equal(wrote.persisted, false, '无法证明可安全分隔的追加不许自称 persisted')
  assert.ok(wrote.persistError)
  await chmod(file, 0o600)
  const raw = await readFile(file, 'utf8')
  assert.equal(raw.includes('must-not-land'), false, '失败的写不许留下半行')
  const reloaded = createTurnEvidenceStore({ ledgerPath: file })
  assert.equal(describeTurnEvidence('sess-lock', reloaded, {}, { turn: 1, step: 'pre-step' }).memory.copy, 'first')
})

test('write separator: fsync mode writes the same line shape, including after a fragment', async () => {
  // 持久性口径:默认 append 只保证跨进程可见(页缓存),断电不保证;
  // fsync:true 是同一条记录外加一次落盘刷写。两种模式产出的行必须逐字节同形,
  // 分隔符逻辑也必须同样生效 —— 运维差异不许改变记录内容。
  const homeA = await mkdtemp(join(tmpdir(), 'agos-turn-ev-fsync-a-'))
  const homeB = await mkdtemp(join(tmpdir(), 'agos-turn-ev-fsync-b-'))
  for (const [home, fsync] of [[homeA, false], [homeB, true]]) {
    const file = join(home, 'ledger.jsonl')
    await mkdir(home, { recursive: true, mode: 0o700 })
    await writeFile(file, '{"sessionId":"sess-f","turn":1,"memory":{"enab', { mode: 0o600 }) // 无换行残片
    const store = createTurnEvidenceStore({ ledgerPath: file, fsync })
    const wrote = store.record('sess-f', {
      memory: { enabled: true, prepended: 1, copy: 'after-fragment' },
    }, new Date('2026-09-08T00:00:00.000Z'), { turn: 2, step: 'pre-step' })
    assert.equal(wrote.persisted, true, `fsync=${fsync}`)
    const reloaded = createTurnEvidenceStore({ ledgerPath: file })
    assert.equal(describeTurnEvidence('sess-f', reloaded, {}, { turn: 2, step: 'pre-step' }).memory.copy, 'after-fragment', `fsync=${fsync}`)
  }
  const [plain, synced] = await Promise.all([
    readFile(join(homeA, 'ledger.jsonl'), 'utf8'),
    readFile(join(homeB, 'ledger.jsonl'), 'utf8'),
  ])
  assert.equal(plain, synced, 'fsync 只改变持久性保证,不改变落盘字节')
  // 文件首次创建(ENOENT)时也必须走 fsync 路径:独立复核指出原先 ENOENT 分支
  // 直接 appendFileSync,fsync=true 的首条记录实际没有 fsync。
  const homeFirst = await mkdtemp(join(tmpdir(), 'agos-turn-ev-fsync-first-'))
  const firstFile = join(homeFirst, 'ledger.jsonl')
  const firstStore = createTurnEvidenceStore({ ledgerPath: firstFile, fsync: true })
  const first = firstStore.record('sess-f', {
    memory: { enabled: true, prepended: 1, copy: 'first-fsync' },
  }, new Date('2026-09-08T00:00:00.000Z'), { turn: 1, step: 'pre-step' })
  assert.equal(first.persisted, true)
  assert.equal(describeTurnEvidence('sess-f', createTurnEvidenceStore({ ledgerPath: firstFile }), {}, { turn: 1, step: 'pre-step' }).memory.copy, 'first-fsync')
})

test('write separator: two in-process stores appending one ledger keep every line whole', async () => {
  // 并发边界(进程内):两个 store 交替向同一账本写,重开后每条 bind 都独立可取。
  const home = await mkdtemp(join(tmpdir(), 'agos-turn-ev-interleave-'))
  const left = createTurnEvidenceStore({ home })
  const right = createTurnEvidenceStore({ home })
  for (let index = 0; index < 10; index += 1) {
    const wrote = index % 2 === 0
      ? left.record('sess-left', { memory: { enabled: true, prepended: index, copy: `l-${index}` } }, new Date(), { turn: index, step: 'pre-step' })
      : right.record('sess-right', { memory: { enabled: true, prepended: index, copy: `r-${index}` } }, new Date(), { turn: index, step: 'pre-step' })
    assert.equal(wrote.persisted, true)
  }
  const reloaded = createTurnEvidenceStore({ home })
  for (let index = 0; index < 10; index += 2) {
    assert.equal(describeTurnEvidence('sess-left', reloaded, {}, { turn: index, step: 'pre-step' }).memory.copy, `l-${index}`)
    assert.equal(describeTurnEvidence('sess-right', reloaded, {}, { turn: index + 1, step: 'pre-step' }).memory.copy, `r-${index + 1}`)
  }
})

test('write separator: real concurrent processes never glue lines together', async () => {
  // 并发边界(真子进程):两个 node 进程同时向同一账本各写 30 行。
  // 边界口径:每个 appendRecordLine 的追加是单次 write(2)(O_APPEND),行内不会被
  // 另一进程插断;tail 检查与追加之间若有人抢先补上了换行结尾,最坏多出一个空行
  // —— 空行在加载侧被跳过,不产生也不丢失证据。这里断言的是无损下界。
  const home = await mkdtemp(join(tmpdir(), 'agos-turn-ev-race-'))
  const file = join(home, 'turn-evidence.jsonl')
  const libUrl = pathToFileURL(join(import.meta.dirname, '..', 'lib', 'turn-evidence.js')).href
  const childScript = `
    import { createTurnEvidenceStore } from ${JSON.stringify(libUrl)}
    const store = createTurnEvidenceStore({ ledgerPath: process.env.LEDGER })
    for (let i = 0; i < 30; i += 1) {
      const r = store.record(process.env.SESSION, { memory: { enabled: true, prepended: i, copy: 'c' + process.env.SESSION + '-' + i } }, new Date(), { turn: i, step: 'pre-step' })
      if (r.persisted !== true) process.exit(3)
    }
  `
  const children = ['sess-race-a', 'sess-race-b'].map((session) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', childScript], {
      env: { ...process.env, LEDGER: file, SESSION: session },
      stdio: ['ignore', 'ignore', 'inherit'],
    })
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`child ${session} exit ${code}`))))
    child.on('error', reject)
  }))
  await Promise.all(children)
  const lines = (await readFile(file, 'utf8')).split('\n').filter((line) => line.trim() !== '')
  assert.equal(lines.length, 60, '60 行一行不少、一行不多')
  for (const line of lines) {
    assert.ok(line.startsWith('{') && line.endsWith('}'), `行被粘断或沾了残片:${line.slice(0, 40)}`)
    assert.doesNotThrow(() => JSON.parse(line))
  }
  const reloaded = createTurnEvidenceStore({ ledgerPath: file })
  for (const session of ['sess-race-a', 'sess-race-b']) {
    for (let index = 0; index < 30; index += 1) {
      const view = describeTurnEvidence(session, reloaded, {}, { turn: index, step: 'pre-step' })
      assert.equal(view.collected, true, `${session} turn ${index}`)
      assert.equal(view.memory.copy, `c${session}-${index}`)
    }
  }
})
