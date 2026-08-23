// W20 尺的挖矿器:从归档语料挖「候选句 + 说话人来源」,供人工标注。不是测试(node --test 不匹配本文件)。
// 用法:node test/fixtures/session-memory-corpus/mine.mjs [归档根] > pool.jsonl
// 每行:{ text, role:'user'|'assistant', channel:'rpc'|'bare'|'model', depth, origin, n(出现次数), sample(sessionId 前 8) }
// 来源判定与 extractSessionMemory 同口径:user/message 的 data.source.kind==='user';rpcId 在 = 浏览器/RPC 通道。
// 切分与敏感过滤直接复用 session-memory.mjs 导出的同一实现,保证「语料里的句」就是「规则看到的句」。
import { execFileSync } from 'node:child_process'
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { isSensitiveMemoryText, splitCandidatesForCorpus } from '../../../lib/session-memory.mjs'

const root = process.argv[2] || join(homedir(), '.dsh', 'sessions-trash-20260820')
const files = []
function walk(d) {
  for (const n of readdirSync(d)) {
    const p = join(d, n)
    let s
    try { s = statSync(p) } catch { continue }
    if (s.isDirectory()) walk(p)
    else if (n === 'session.jsonl.zstd' || n === 'session.jsonl') files.push(p)
  }
}
walk(root)

const REJECT_LEAD = /(不可行|行不通|已排除|放弃|不采用|改用|退回|回退到|失败了|不支持|无法使用|reverted|abandon|not viable|doesn't work|did not work)/iu
const pool = new Map()
const add = (key, row) => {
  const cur = pool.get(key)
  if (cur) { cur.n += 1; return }
  pool.set(key, { ...row, n: 1 })
}
for (const f of files) {
  let txt
  try {
    txt = f.endsWith('.zstd')
      ? execFileSync('zstd', ['-dc', '--', f], { maxBuffer: 512 * 1024 * 1024 }).toString('utf8')
      : execFileSync('cat', [f], { maxBuffer: 512 * 1024 * 1024 }).toString('utf8')
  } catch { continue }
  let header = {}
  let sessionId = ''
  for (const line of txt.split('\n')) {
    if (!line.trim()) continue
    let e
    try { e = JSON.parse(line) } catch { continue }
    // 头行形状(实测):{"type":"session","id","cwd","delegationDepth",origin?,parentSession?}
    if (e.type === 'session') { header = e; sessionId = e.id || sessionId; continue }
    const depth = Number.isInteger(header.delegationDepth) ? header.delegationDepth : undefined
    const origin = typeof header.origin === 'string' ? header.origin : undefined
    if (e.type === 'user/message' && e.data?.source?.kind === 'user') {
      const channel = 'rpcId' in e.data.source ? 'rpc' : 'bare'
      const t = (e.data.content || []).filter((p) => p && p.type === 'text').map((p) => p.text).join('\n')
      for (const s of splitCandidatesForCorpus(t)) {
        if (isSensitiveMemoryText(s)) continue
        add(`u|${channel}|${s}`, { text: s, role: 'user', channel, depth, origin, sample: String(sessionId).replace(/^session-/, '').slice(0, 8) })
      }
    } else if (e.type === 'assistant/message' && e.data?.message?.source?.kind === 'model') {
      if (depth !== 0) continue
      const t = (e.data.message.content || []).filter((p) => p && p.type === 'text').map((p) => p.text).join('\n')
      for (const s of splitCandidatesForCorpus(t)) {
        if (!REJECT_LEAD.test(s) || isSensitiveMemoryText(s)) continue
        add(`a|${s}`, { text: s, role: 'assistant', channel: 'model', depth, origin, sample: String(sessionId).replace(/^session-/, '').slice(0, 8) })
      }
    }
  }
}
for (const row of pool.values()) process.stdout.write(JSON.stringify(row) + '\n')
process.stderr.write(`files ${files.length} pool ${pool.size}\n`)
