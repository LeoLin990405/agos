// turn-evidence 账本的容量与保留边界审计。结论见
// docs/engineering/agos-round2-20260908/wiring/F-wiring.md 的 R2 节:账本是纯追加、
// 没有任何保留策略,而在本包能碰的文件里做不出可证明安全的压缩(web / desktop 两个进程
// 会算出同一个 home 下的同一个账本,dsh-agos 内没有跨进程锁)。所以本轮不加清理,
// 只把边界钉成测试 —— 将来谁要加清理,必须先让这些断言说话。
//
// 隐私:本文件所有落盘都在 mkdtemp(tmpdir()) 下。默认 store 不接 home、也没有
// homedir() 兜底,所以这里任何一条路径都到不了真实的 ~/.dsh 账本。
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, sep } from 'node:path'
import test from 'node:test'

import {
  TURN_UNCOLLECTED_COPY,
  createTurnEvidenceStore,
  describeTurnEvidence,
} from '../lib/turn-evidence.js'

const FIXED = 1787400000000
const at = (index) => new Date(FIXED + index * 1000)
const ledgerOf = (home) => join(home, '.dsh', 'agos', 'turn-evidence.jsonl')

/** 一条量级贴近生产的 pre-step 行:回注短名单 + 技能短名单,正文都是合成的。 */
function prestepPatch(index) {
  return {
    memory: {
      enabled: true,
      prepended: 2,
      itemCount: 4,
      method: 'lexical+posterior',
      query: `q-${index}`,
      impressions: [
        { id: 'a'.repeat(24), kind: 'constraint', text: '不要改 fold', method: 'constraint-reserve' },
        { id: 'b'.repeat(24), kind: 'fact', text: '端口是 3091', method: 'lexical+posterior' },
      ],
    },
    skills: { trimmed: true, query: `q-${index}`, served: ['inbox-triage', 'repo-deploy'] },
  }
}

async function ledgerLines(path) {
  return (await readFile(path, 'utf8')).split('\n').filter((line) => line.trim() !== '')
}

test('R2 容量:账本纯追加 —— 没有行数上限、没有轮转、没有去重', async () => {
  const home = await mkdtemp(join(tmpdir(), 'agos-turn-ev-capacity-'))
  const store = createTurnEvidenceStore({ home })
  assert.equal(store.ledgerPath, ledgerOf(home))
  const rows = 512
  for (let index = 0; index < rows; index += 1) {
    const wrote = store.record('sess-cap', prestepPatch(index), at(index), { turn: index, step: 'pre-step' })
    assert.equal(wrote.persisted, true)
  }
  const written = await ledgerLines(store.ledgerPath)
  assert.equal(written.length, rows, '每次 record 追加一行:既不截断也不压缩')
  assert.equal(JSON.parse(written[0]).memory.query, 'q-0', '第 1 行在 511 次后续写入之后仍在原处')
  assert.equal(JSON.parse(written[rows - 1]).memory.query, `q-${rows - 1}`)
  assert.deepEqual(await readdir(dirname(store.ledgerPath)), ['turn-evidence.jsonl'], '没有 .1 / .bak 之类的轮转兄弟文件')
  const bytes = (await stat(store.ledgerPath)).size
  console.log(`[F2-R2 容量] ${rows} 行 · ${bytes} 字节 · 平均 ${Math.round(bytes / rows)} 字节/行 · 无上限、无轮转、无 TTL`)
  // 单行体积是有界的(回注短名单 ≤ K 条、正文 ≤200 码点),所以增长由**行数**决定:
  // 每个 agent 的每一跳 pre-step 一行,永远。文件大小只受磁盘限制。
  assert.ok(bytes / rows < 4096, `平均行长 ${Math.round(bytes / rows)} 字节:单行有界,增长来自行数`)
})

test('R2 保留:只有每个 bind 的最后一行可读,被取代的行仍全部留在盘上', async () => {
  const home = await mkdtemp(join(tmpdir(), 'agos-turn-ev-supersede-'))
  const store = createTurnEvidenceStore({ home })
  store.record('sess-a', { memory: { enabled: true, prepended: 1, copy: 'turn-1 first' } }, at(0), { turn: 1, step: 'pre-step' })
  store.record('sess-a', { memory: { enabled: true, prepended: 2, copy: 'turn-1 retry' } }, at(1), { turn: 1, step: 'pre-step' })
  store.record('sess-a', { memory: { enabled: true, prepended: 3, copy: 'turn-2' } }, at(2), { turn: 2, step: 'pre-step' })
  store.record('sess-a', { memory: { enabled: true, prepended: 4, copy: 'unbound tail' } }, at(3))
  const onDisk = await ledgerLines(store.ledgerPath)
  assert.equal(onDisk.length, 4)

  // 重开进程后可读集合 = 每个 bind 的最后一行 ∪ 该会话的最后一行(无 bind 查询走这条)。
  // 这就是将来任何压缩必须原样保住的那一份;少保一条就是删了仍然有效的证据。
  const reloaded = createTurnEvidenceStore({ home })
  assert.equal(describeTurnEvidence('sess-a', reloaded, {}, { turn: 1, step: 'pre-step' }).memory.copy, 'turn-1 retry')
  assert.equal(describeTurnEvidence('sess-a', reloaded, {}, { turn: 2, step: 'pre-step' }).memory.copy, 'turn-2')
  assert.equal(describeTurnEvidence('sess-a', reloaded, {}).memory.copy, 'unbound tail')
  // 'turn-1 first' 对读侧已被取代,但今天没有任何东西会把它清掉。
  assert.equal(onDisk.some((line) => line.includes('turn-1 first')), true)
  assert.equal(onDisk.filter((line) => line.includes('sess-a')).length, 4)
})

test('R2 容量:进程内 bind 索引不淘汰,随跳数单调增长', () => {
  const store = createTurnEvidenceStore()
  assert.equal(store.ledgerPath, null, '不给 home 就没有账本路径:内存态不落盘')
  const binds = 512
  for (let index = 0; index < binds; index += 1) {
    const wrote = store.record('sess-mem', { memory: { enabled: true, prepended: index, copy: `t-${index}` } }, at(index), { turn: index, step: 'pre-step' })
    assert.equal(wrote.observed, true)
    assert.equal(wrote.persisted, false)
  }
  // 512 个 bind 全部仍可单独取回:没有 LRU、没有窗口、没有 TTL。
  // 长活进程的常驻内存因此是 O(该进程见过的不同 turn/step 数),不是 O(会话数)。
  let alive = 0
  for (let index = 0; index < binds; index += 1) {
    if (store.get('sess-mem', { turn: index, step: 'pre-step' })?.memory.copy === `t-${index}`) alive += 1
  }
  assert.equal(alive, binds)
  assert.equal(describeTurnEvidence('sess-mem', store, {}, { turn: 0, step: 'pre-step' }).persisted, false)
})

test('R2 容量:重开进程要回放整份文件,行数就是启动开销', async () => {
  const home = await mkdtemp(join(tmpdir(), 'agos-turn-ev-replay-'))
  const file = ledgerOf(home)
  await mkdir(dirname(file), { recursive: true, mode: 0o700 })
  const rows = 256
  let text = ''
  for (let index = 0; index < rows; index += 1) {
    text += `${JSON.stringify({
      sessionId: 'sess-replay',
      at: at(index).toISOString(),
      turn: index,
      step: 'pre-step',
      memory: { enabled: true, prepended: 1, copy: `t-${index}` },
    })}\n`
  }
  await writeFile(file, text, { mode: 0o600 })
  const store = createTurnEvidenceStore({ home })
  let replayed = 0
  for (let index = 0; index < rows; index += 1) {
    if (store.get('sess-replay', { turn: index, step: 'pre-step' })?.memory.copy === `t-${index}`) replayed += 1
  }
  assert.equal(replayed, rows, '构造器整文件 readFileSync + 逐行建索引:没有窗口、没有分页')
})

test('R2 保留:崩溃留下的半行只毁掉自己,写侧分隔让后续行不再被连坐', async () => {
  const home = await mkdtemp(join(tmpdir(), 'agos-turn-ev-torn-'))
  const file = ledgerOf(home)
  await mkdir(dirname(file), { recursive: true, mode: 0o700 })
  const good = `${JSON.stringify({
    sessionId: 'sess-torn', at: at(0).toISOString(), turn: 1, step: 'pre-step',
    memory: { enabled: true, prepended: 1, copy: 'before-tear' },
  })}\n`
  // 追加写到一半断电:最后一行没有结尾换行。
  await writeFile(file, `${good}{"sessionId":"sess-torn","turn":9001,"step":"pre-step","memory":{"enab`, { mode: 0o600 })
  const store = createTurnEvidenceStore({ home })
  assert.equal(describeTurnEvidence('sess-torn', store, {}, { turn: 1, step: 'pre-step' }).memory.copy, 'before-tear')
  const torn = describeTurnEvidence('sess-torn', store, {}, { turn: 9001, step: 'pre-step' })
  assert.equal(torn.collected, false, '半行被丢弃,不猜也不修:读侧永不从残片里找回 JSON')
  assert.equal(torn.copy, TURN_UNCOLLECTED_COPY)

  // 2026-09-09 修复(原 F-wiring.md R2-b 报的边界):写侧在追加前检查文件尾,
  // 不以换行结尾就先补一个分隔符 —— 半行残片之后的新记录不再被拼进去吃掉。
  // persisted:true 从此是可兑现的:下一进程能重新加载到这一行。
  const next = store.record('sess-torn', { memory: { enabled: true, prepended: 2, copy: 'after-tear' } }, at(1), { turn: 9002, step: 'pre-step' })
  assert.equal(next.persisted, true)
  const later = store.record('sess-torn', { memory: { enabled: true, prepended: 3, copy: 'recovered' } }, at(2), { turn: 9003, step: 'pre-step' })
  assert.equal(later.persisted, true)
  const reloaded = createTurnEvidenceStore({ home })
  assert.equal(describeTurnEvidence('sess-torn', reloaded, {}, { turn: 1, step: 'pre-step' }).memory.copy, 'before-tear')
  const afterTear = describeTurnEvidence('sess-torn', reloaded, {}, { turn: 9002, step: 'pre-step' })
  assert.equal(afterTear.collected, true, '写侧分隔之后,半行的下一行必须能重新加载 —— 否则 persisted:true 是假话')
  assert.equal(afterTear.memory.copy, 'after-tear')
  assert.equal(describeTurnEvidence('sess-torn', reloaded, {}, { turn: 9003, step: 'pre-step' }).memory.copy, 'recovered')
  // 半行自己仍然缺席:修复的是分隔,不是「恢复」—— 残片里的证据一个字都不许发明。
  assert.equal(describeTurnEvidence('sess-torn', reloaded, {}, { turn: 9001, step: 'pre-step' }).collected, false)
  // 分隔符只补在残片与新一行的边界;残片本身原样留在盘上(纯追加,不删不改)。
  const lines = await readFile(file, 'utf8')
  assert.equal(lines.includes('{"enab\n'), true, '残片之后必须正好一个换行分隔')
  assert.equal(lines.includes('\n\n'), false, '不许出现空行:连续写入不重复补分隔符')
})

test('R2 保留:本模块没有任何清理通道,现存有效证据不可能被删', async () => {
  const home = await mkdtemp(join(tmpdir(), 'agos-turn-ev-no-prune-'))
  const store = createTurnEvidenceStore({ home })
  assert.deepEqual(Object.keys(store).sort(), ['get', 'ledgerPath', 'record'])
  for (const name of ['prune', 'compact', 'rotate', 'clear', 'clean', 'delete', 'trim', 'evict', 'vacuum', 'truncate']) {
    assert.equal(name in store, false,
      `store 上出现了 ${name}():加清理必须同时给出明确的保留策略、跨进程安全性论证,并把本审计改写成对该策略的证明`
      + '(见 F-wiring.md R2)。在那之前不许有删除通道。')
  }
  // 反复重开 store 并继续写:每一轮之前写下的每个 bind 都还在,一条不少。
  const seen = []
  for (let round = 0; round < 5; round += 1) {
    const rotating = createTurnEvidenceStore({ home })
    rotating.record('sess-keep', { memory: { enabled: true, prepended: round, copy: `round-${round}` } }, at(round), { turn: round, step: 'pre-step' })
    seen.push(round)
    for (const index of seen) {
      assert.equal(describeTurnEvidence('sess-keep', rotating, {}, { turn: index, step: 'pre-step' }).memory.copy, `round-${index}`)
    }
  }
  assert.equal((await ledgerLines(ledgerOf(home))).length, 5)
})

test('R2 隐私:默认 store 没有账本路径,模块里也没有 homedir() 兜底', async () => {
  const store = createTurnEvidenceStore()
  assert.equal(store.ledgerPath, null)
  const wrote = store.record('sess-nohome', { memory: { enabled: true, prepended: 1 } }, at(0))
  assert.equal(wrote.observed, true)
  assert.equal(wrote.persisted, false, '没有路径就什么都不写,不许自己找一个家目录')
  const home = await mkdtemp(join(tmpdir(), 'agos-turn-ev-privacy-'))
  assert.ok(createTurnEvidenceStore({ home }).ledgerPath.startsWith(home + sep))
  assert.ok(ledgerOf(home).startsWith(tmpdir()))
  const source = await readFile(new URL('../lib/turn-evidence.js', import.meta.url), 'utf8')
  assert.equal(/homedir\(/.test(source), false,
    'turn-evidence 不许有 homedir() 兜底:那会让缺省构造直接写进个人目录,也会让测试误碰真账本')
})
