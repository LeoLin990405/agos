// W20 的尺:标注语料 → extractSessionMemory → 与 label 比 → acceptEdit 门。零模型、零网络。
// 口径与局限见 test/fixtures/session-memory-corpus/README.md。
//
// 对抗验证(2026-08-23)后重做的三点:
//   1) 不再假装有 held-in/held-out:294 句 rpc 里 194 句来自同一个会话,按会话切分做不出独立估计;
//      四个块各自报数(rpc / bare / known-misreports / assistant),bare 只证明来源门在。
//   2) 基线存每条 id 的通过集合:任何一条原来通过的样本变失败就红,不允许用别处的提升抵消。
//   3) 接受新基线的路径仍做语料 sha 校验(语料变了要另给 SESSION_MEMORY_ACCEPT_CORPUS=1),
//      必须带 SESSION_MEMORY_RULES_NOTE,且相对现有基线有单条回归时拒绝接受。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { extractSessionMemory } from '../lib/session-memory.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const CORPUS = join(here, 'fixtures', 'session-memory-corpus')
const BASELINE = join(CORPUS, 'baseline.json')
export const BLOCKS = ['rpc', 'bare', 'known-misreports', 'assistant']

function readJsonl(name) {
  return readFileSync(join(CORPUS, name), 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l))
}

/** 一行语料 → 一组宿主事件(turn/start + 一条消息),source 形状照归档原样。 */
export function eventsForRow(row) {
  const base = { seq: 1, time: 1787400000000 }
  if (row.role === 'assistant') {
    return [
      { type: 'turn/start', seq: 0, data: { turn: 1 } },
      { type: 'assistant/message', ...base, data: { turn: 1, message: { source: { kind: 'model', provider: 'deepseek-official' }, content: [{ type: 'text', text: row.text }] } } },
    ]
  }
  const source = row.channel === 'rpc' ? { kind: 'user', rpcId: 'corpus', clientTimeZone: 'Asia/Shanghai' } : { kind: 'user' }
  return [
    { type: 'turn/start', seq: 0, data: { turn: 1 } },
    { type: 'user/message', ...base, data: { role: 'user', source, content: [{ type: 'text', text: row.text }] } },
  ]
}

export function headerForRow(row) {
  return { delegationDepth: Number.isInteger(row.depth) ? row.depth : 0, ...(row.origin ? { origin: row.origin } : {}) }
}

export function predictKind(row) {
  const { items } = extractSessionMemory(eventsForRow(row), { now: () => new Date(1787400000000), header: headerForRow(row) })
  return { kind: items[0] ? items[0].kind : null, importance: items[0] ? items[0].importance : null }
}

export function score(rows) {
  const kinds = ['constraint', 'fact', 'preference', 'rejected']
  const per = Object.fromEntries(kinds.map((k) => [k, { tp: 0, fp: 0, fn: 0 }]))
  const passIds = []
  const failures = []
  let imp5 = 0
  let imp5Persistent = 0
  for (const row of rows) {
    const pred = predictKind(row)
    const persistent = row.label.scope === 'persistent'
    // 期望产出:persistent 才该被抽成该 kind;turn 与 null 的期望都是「不抽」。
    const want = persistent ? row.label.kind : null
    if (pred.kind === want) passIds.push(row.id)
    else failures.push({ id: row.id, text: row.text.slice(0, 60), want: row.label.kind ? `${row.label.kind}/${row.label.scope}` : 'null', got: pred.kind ?? 'null' })
    if (pred.importance === 5) { imp5 += 1; if (persistent && pred.kind === want) imp5Persistent += 1 }
    for (const k of kinds) {
      const p = pred.kind === k
      const w = want === k
      if (p && w) per[k].tp += 1
      else if (p && !w) per[k].fp += 1
      else if (!p && w) per[k].fn += 1
    }
  }
  const prf = Object.fromEntries(kinds.map((k) => {
    const { tp, fp, fn } = per[k]
    const precision = tp + fp === 0 ? null : tp / (tp + fp)
    const recall = tp + fn === 0 ? null : tp / (tp + fn)
    const f1 = precision === null || recall === null || precision + recall === 0 ? null : (2 * precision * recall) / (precision + recall)
    return [k, { tp, fp, fn, precision, recall, f1 }]
  }))
  return { total: rows.length, pass: passIds.length, passIds, prf, imp5, imp5Persistent, failures }
}

export function scoreAll() {
  return Object.fromEntries(BLOCKS.map((b) => [b, score(readJsonl(`${b}.jsonl`))]))
}

function corpusSha() {
  const h = createHash('sha256')
  for (const b of BLOCKS) h.update(readFileSync(join(CORPUS, `${b}.jsonl`)))
  return h.digest('hex')
}

const fmt = (s) => `${s.pass}/${s.total}`
const pr = (v) => `P=${v.precision === null ? '-' : v.precision.toFixed(2)} R=${v.recall === null ? '-' : v.recall.toFixed(2)}`

test('W20 尺:四个块各自可评分,并把指标打印出来(只看不进门)', () => {
  const all = scoreAll()
  for (const [name, s] of Object.entries(all)) {
    const prf = Object.entries(s.prf).filter(([, v]) => v.tp + v.fp + v.fn > 0).map(([k, v]) => `${k} ${pr(v)}`).join(' · ')
    console.log(`[W20 ${name}] pass ${fmt(s)}${prf ? ' · ' + prf : ''} · imp5 ${s.imp5}(persistent&正确 ${s.imp5Persistent})`)
  }
  for (const b of BLOCKS) assert.ok(all[b].total > 0, b)
})

test('W20 acceptEdit 门:语料没动;每条原来通过的样本不得变失败;有提升须显式接受新基线', () => {
  const sha = corpusSha()
  const now = scoreAll()
  const current = {
    corpusSha256: sha,
    blocks: Object.fromEntries(BLOCKS.map((b) => [b, { total: now[b].total, pass: now[b].pass, passIds: now[b].passIds }])),
  }
  const base = existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, 'utf8')) : null
  const corpusChanged = base === null || base.corpusSha256 !== sha || BLOCKS.some((b) => !base.blocks?.[b] || base.blocks[b].total !== current.blocks[b].total)

  // 相对基线:单条回归(原来过、现在不过)与新增通过
  const regressions = []
  const gains = []
  if (base !== null && !corpusChanged) {
    for (const b of BLOCKS) {
      const before = new Set(base.blocks[b].passIds)
      const after = new Set(current.blocks[b].passIds)
      for (const id of before) if (!after.has(id)) regressions.push(`${b}:${id}`)
      for (const id of after) if (!before.has(id)) gains.push(`${b}:${id}`)
    }
  }

  if (process.env.SESSION_MEMORY_ACCEPT_BASELINE === '1') {
    const note = process.env.SESSION_MEMORY_RULES_NOTE || ''
    assert.ok(note.trim() !== '', '接受新基线必须带 SESSION_MEMORY_RULES_NOTE(说明规则改了什么)')
    if (corpusChanged && base !== null) {
      assert.equal(process.env.SESSION_MEMORY_ACCEPT_CORPUS, '1', '语料变了(sha/total 与基线不符):要重算基线请同时给 SESSION_MEMORY_ACCEPT_CORPUS=1,不要让语料与规则同时动而不自知')
    }
    assert.deepEqual(regressions, [], `有单条回归,不接受为新基线:\n${regressions.map((r) => '  ' + r).join('\n')}`)
    writeFileSync(BASELINE, JSON.stringify({ ...current, rulesNote: note, acceptedAt: new Date().toISOString() }, null, 2) + '\n')
    console.log(`[W20] 基线已重写:${BLOCKS.map((b) => `${b} ${fmt(now[b])}`).join(' · ')}${gains.length ? ` · 新增通过 ${gains.length}` : ''}`)
    return
  }

  assert.ok(base !== null, '没有基线:先 SESSION_MEMORY_ACCEPT_BASELINE=1 SESSION_MEMORY_RULES_NOTE="…" 跑一次落盘')
  if (corpusChanged) throw new Error('语料变了(sha/total 与基线不符):先重跑基线(SESSION_MEMORY_ACCEPT_BASELINE=1 SESSION_MEMORY_ACCEPT_CORPUS=1)再改规则')
  const detail = regressions.map((r) => {
    const [b, id] = r.split(':')
    const f = now[b].failures.find((x) => x.id === id)
    return `  ${r} want=${f?.want} got=${f?.got} · ${f?.text}`
  }).join('\n')
  assert.deepEqual(regressions, [], `规则改动让原来通过的样本变失败(不允许用别处的提升抵消):\n${detail}`)
  assert.deepEqual(gains, [], `尺的读数提升了(${gains.length} 条新通过:${gains.slice(0, 8).join(', ')}${gains.length > 8 ? '…' : ''}),但基线没更新:确认后用 SESSION_MEMORY_ACCEPT_BASELINE=1 SESSION_MEMORY_RULES_NOTE="…" node --test test/session-memory-rules.test.mjs 重写基线`)
})
