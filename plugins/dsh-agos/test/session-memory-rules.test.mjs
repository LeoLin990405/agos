// W20 的尺:标注语料 → extractSessionMemory → 与 label 比 → acceptEdit 门。零模型、零网络。
// 口径见 test/fixtures/session-memory-corpus/README.md。
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
  let pass = 0
  let imp5 = 0
  let imp5Persistent = 0
  const failures = []
  for (const row of rows) {
    const pred = predictKind(row)
    const persistent = row.label.scope === 'persistent'
    // 期望产出:persistent 才该被抽成该 kind;turn 与 null 的期望都是「不抽」。
    const want = persistent ? row.label.kind : null
    const ok = pred.kind === want
    if (ok) pass += 1
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
  return { total: rows.length, pass, prf, imp5, imp5Persistent, failures }
}

function corpusSha() {
  const h = createHash('sha256')
  for (const name of ['held-in.jsonl', 'held-out.jsonl', 'assistant.jsonl']) h.update(readFileSync(join(CORPUS, name)))
  return h.digest('hex')
}

const fmt = (s) => `${s.pass}/${s.total}`

test('W20 尺:语料三块各自可评分,并把指标打印出来(只看不进门)', () => {
  const held = { in: score(readJsonl('held-in.jsonl')), out: score(readJsonl('held-out.jsonl')), asst: score(readJsonl('assistant.jsonl')) }
  for (const [name, s] of Object.entries(held)) {
    const prf = Object.entries(s.prf).map(([k, v]) => `${k} P=${v.precision === null ? '-' : v.precision.toFixed(2)} R=${v.recall === null ? '-' : v.recall.toFixed(2)}`).join(' · ')
    console.log(`[W20 ${name}] pass ${fmt(s)} · ${prf} · imp5 ${s.imp5}(persistent&正确 ${s.imp5Persistent})`)
  }
  assert.ok(held.in.total > 0 && held.out.total > 0 && held.asst.total > 0)
})

test('W20 acceptEdit 门:语料没动;两侧 pass 不得下降;有提升须显式接受新基线', () => {
  const sha = corpusSha()
  const now = {
    in: score(readJsonl('held-in.jsonl')), out: score(readJsonl('held-out.jsonl')), asst: score(readJsonl('assistant.jsonl')),
  }
  const current = {
    inTotal: now.in.total, outTotal: now.out.total, inPass: now.in.pass, outPass: now.out.pass,
    assistant: { total: now.asst.total, pass: now.asst.pass },
    corpusSha256: sha,
  }
  if (process.env.SESSION_MEMORY_ACCEPT_BASELINE === '1') {
    writeFileSync(BASELINE, JSON.stringify({ ...current, rulesNote: process.env.SESSION_MEMORY_RULES_NOTE || '', acceptedAt: new Date().toISOString() }, null, 2) + '\n')
    console.log(`[W20] 基线已重写:in ${fmt(now.in)} out ${fmt(now.out)} asst ${fmt(now.asst)}`)
    return
  }
  assert.ok(existsSync(BASELINE), '没有基线:先 SESSION_MEMORY_ACCEPT_BASELINE=1 跑一次落盘')
  const base = JSON.parse(readFileSync(BASELINE, 'utf8'))
  if (base.corpusSha256 !== sha || base.inTotal !== current.inTotal || base.outTotal !== current.outTotal || base.assistant.total !== current.assistant.total) {
    throw new Error('语料变了(sha/total 与基线不符):先重跑基线再改规则,不要让语料与规则同时动')
  }
  const drops = []
  if (current.inPass < base.inPass) drops.push(`held-in ${base.inPass}→${current.inPass}`)
  if (current.outPass < base.outPass) drops.push(`held-out ${base.outPass}→${current.outPass}`)
  if (current.assistant.pass < base.assistant.pass) drops.push(`assistant ${base.assistant.pass}→${current.assistant.pass}`)
  assert.deepEqual(drops, [], `规则改动让尺的读数下降:${drops.join('; ')}\n失败样本(held-in 前 10):\n${now.in.failures.slice(0, 10).map((f) => `  ${f.id} want=${f.want} got=${f.got} · ${f.text}`).join('\n')}`)
  const gains = []
  if (current.inPass > base.inPass) gains.push(`held-in ${base.inPass}→${current.inPass}`)
  if (current.outPass > base.outPass) gains.push(`held-out ${base.outPass}→${current.outPass}`)
  if (current.assistant.pass > base.assistant.pass) gains.push(`assistant ${base.assistant.pass}→${current.assistant.pass}`)
  assert.deepEqual(gains, [], `尺的读数提升了(${gains.join('; ')}),但基线没更新:确认后用 SESSION_MEMORY_ACCEPT_BASELINE=1 SESSION_MEMORY_RULES_NOTE="…" node --test test/session-memory-rules.test.mjs 重写基线`)
})
