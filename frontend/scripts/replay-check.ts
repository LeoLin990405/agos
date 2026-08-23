/**
 * fold 语料回放校验(P1 正确性背书,零模型):
 * 对 AGOS_CORPUS(默认 ~/.dsh/sessions-trash-20260820,392 条真实会话)逐条
 * 全量 fold,断言硬不变量。任何一条违反即非零退出。
 *
 * 不变量:
 *   I1 未注册事件类型恒空(词汇长了必须显式登记进 fold.ts)
 *   I2 孤儿工具结果恒 0(有 result 必有 call)
 *   I3 turnsEnded ≤ turnsStarted
 *   I4 快照可 JSON 序列化
 *   I5 流式收敛:非截断会话不得残留 streaming=true 的 assistant 条目
 *      (截断=最后事件不是 turn/end;截断会话允许)
 *   I6 工具结果的多模态块不丢(见下,W1)
 *   I7 subagent/descriptor 的 label 进 header.subagentLabel,且不再计进 ignored(W14):
 *      独立从原始 JSONL 扫 descriptor 行取 data.label(last-wins),与 fold 产物严格相等
 *   金标 G1:session-7a0959af(「只回答两个字:就绪」)若在语料中,
 *      折叠结果须为 1 user + 1 assistant(text=就绪,reasoning 非空)
 */
import { execFileSync } from 'node:child_process'
import { readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { foldJsonl } from '../src/fold/fold.ts'

const CORPUS = process.env.AGOS_CORPUS ?? join(homedir(), '.dsh', 'sessions-trash-20260820')
const failures: string[] = []
let sessions = 0
let events = 0
let ignoredTotal = 0
let danglingSessions = 0
const unknownAgg: Record<string, number> = {}

function* sessionFiles(root: string): Generator<string> {
  for (const dir of readdirSync(root, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue
    const level1 = join(root, dir.name)
    for (const entry of readdirSync(level1, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const file = join(level1, entry.name, 'session.jsonl.zstd')
      if (existsSync(file)) yield file
    }
  }
}

if (!existsSync(CORPUS)) {
  console.error(`语料目录不存在:${CORPUS}(可用 AGOS_CORPUS 覆盖)`)
  process.exit(2)
}

for (const file of sessionFiles(CORPUS)) {
  sessions += 1
  let jsonl: string
  try {
    jsonl = execFileSync('zstd', ['-dc', file], { maxBuffer: 256 * 1024 * 1024 }).toString('utf8')
  } catch (error) {
    failures.push(`${file}: 解压失败 ${String(error)}`)
    continue
  }
  const folded = foldJsonl(jsonl)
  events += folded.diagnostics.events
  for (const n of Object.values(folded.diagnostics.ignored)) ignoredTotal += n
  const short = folded.header?.sessionId ?? file

  // I6(W1):原始事件里含非 text 块的工具结果,fold 后必须有 resultBlocks;
  // 独立从原始 JSONL 重新数一遍,与 fold 产物对账,不共用 fold 的内部逻辑。
  {
    const expectBlocks = new Set<string>()
    for (const line of jsonl.split('\n')) {
      const t = line.trim()
      if (t === '' || !t.includes('"tool/result"')) continue
      try {
        const e = JSON.parse(t) as { data?: { message?: { content?: unknown } } }
        const content = e.data?.message?.content
        if (!Array.isArray(content)) continue
        for (const block of content) {
          if (typeof block !== 'object' || block === null) continue
          const b = block as Record<string, unknown>
          if (b['type'] !== 'tool-result' || typeof b['toolCallId'] !== 'string') continue
          const inner = b['content']
          if (Array.isArray(inner) && inner.some((x) => {
            return typeof x === 'object' && x !== null
              && (x as Record<string, unknown>)['type'] !== 'text'
          })) expectBlocks.add(b['toolCallId'])
        }
      } catch { /* 坏行由 fold 侧计 parseErrors */ }
    }
    if (expectBlocks.size > 0) {
      const withBlocks = new Set(
        folded.items
          .filter((i) => i.kind === 'tool' && i.resultBlocks !== undefined && i.resultBlocks.length > 0)
          .map((i) => (i.kind === 'tool' ? i.callId : '')),
      )
      for (const callId of expectBlocks) {
        if (!withBlocks.has(callId)) failures.push(`${short}: I6 工具结果的多模态块丢失 callId=${callId}`)
      }
    }
  }

  // I7(W14):descriptor 的 label 必须出现在 header.subagentLabel;独立重扫原始 JSONL,不复用 fold 逻辑。
  {
    let expectLabel: string | undefined
    let sawDescriptor = false
    for (const line of jsonl.split('\n')) {
      const t = line.trim()
      if (t === '' || !t.includes('"subagent/descriptor"')) continue
      try {
        const e = JSON.parse(t) as { type?: string; data?: { label?: unknown } }
        if (e.type !== 'subagent/descriptor') continue
        sawDescriptor = true
        if (typeof e.data?.label === 'string') expectLabel = e.data.label
      } catch { /* 坏行由 fold 侧计 parseErrors */ }
    }
    if (folded.header?.subagentLabel !== expectLabel) {
      failures.push(`${short}: I7 subagentLabel 不符 期望=${JSON.stringify(expectLabel)} 实际=${JSON.stringify(folded.header?.subagentLabel)}`)
    }
    if (sawDescriptor && folded.diagnostics.ignored['subagent/descriptor'] !== undefined) {
      failures.push(`${short}: I7 subagent/descriptor 仍被计进 ignored`)
    }
  }

  // I1
  for (const [type, n] of Object.entries(folded.diagnostics.unknown)) {
    unknownAgg[type] = (unknownAgg[type] ?? 0) + n
    failures.push(`${short}: 未注册事件类型 ${type} ×${n}`)
  }
  // I2
  if (folded.diagnostics.orphanToolResults > 0) {
    failures.push(`${short}: 孤儿工具结果 ×${folded.diagnostics.orphanToolResults}`)
  }
  // I3
  if (folded.turnsEnded > folded.turnsStarted) {
    failures.push(`${short}: turnsEnded(${folded.turnsEnded}) > turnsStarted(${folded.turnsStarted})`)
  }
  // I4
  try { JSON.stringify(folded) } catch (error) { failures.push(`${short}: 快照不可序列化 ${String(error)}`) }
  // I5
  const truncated = !/"type":\s*"turn\/end"[^\n]*$/.test(jsonl.trimEnd().split('\n').slice(-3).join('\n'))
  const streamingLeft = folded.items.filter((i) => i.kind === 'assistant' && i.streaming).length
  if (streamingLeft > 0 && !truncated) {
    failures.push(`${short}: 非截断会话残留 streaming assistant ×${streamingLeft}`)
  }
  if (folded.diagnostics.danglingToolCalls > 0) danglingSessions += 1

  // G1 金标
  if (short.includes('7a0959af')) {
    const users = folded.items.filter((i) => i.kind === 'user' && i.sourceKind === 'user')
    const assistants = folded.items.filter((i) => i.kind === 'assistant')
    const a0 = assistants[0]
    const ok = users.length === 1 && assistants.length === 1
      && a0 !== undefined && a0.kind === 'assistant' && a0.text === '就绪' && a0.reasoning.length > 0
    if (!ok) failures.push(`${short}: 金标 G1 失败 users=${users.length} assistants=${assistants.length} text=${a0?.kind === 'assistant' ? a0.text : '?'}`)
    else console.log(`金标 G1 ✓(${short}:1 user + 1 assistant「就绪」+ reasoning)`)
  }
}

console.log(`\n回放:${sessions} 会话 / ${events} 事件;ignored ${ignoredTotal};含挂起工具调用的会话 ${danglingSessions}(截断属正常)`)
if (failures.length > 0) {
  console.error(`\n✗ ${failures.length} 项违反:`)
  for (const f of failures.slice(0, 30)) console.error('  -', f)
  if (Object.keys(unknownAgg).length > 0) console.error('未注册类型汇总:', unknownAgg)
  process.exit(1)
}
console.log('✓ 全部不变量通过')
