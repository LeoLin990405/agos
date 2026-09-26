/**
 * Demo fixtures — SAMPLE data only. Nothing here came from a real dsh host.
 * Shapes follow the frozen contract schemas (src/contract/api/*.schema.ts);
 * demo-fixtures.test.ts parses them through those schemas so drift fails CI.
 */

/** Fixed clock so screenshots are reproducible (2026-09-20 14:00 +08:00). */
export const DEMO_T0 = Date.UTC(2026, 8, 20, 6, 0, 0)
const min = (n: number): number => DEMO_T0 + n * 60_000
const sec = (n: number): number => DEMO_T0 + n * 1000

export const DEMO_TAG = '【示例数据】'
export const DEMO_HOME = '/demo/home'
export const DEMO_CWD = '/demo/home/work/agos'
const SOURCE = { provider: 'demo-fixture', model: 'sample-no-model' }

type Ev = { type: string, seq: number, time: number, data: unknown }
const text = (t: string) => [{ type: 'text', text: t }]

export interface DemoSession {
  sessionId: string
  title: string
  updatedAt: number
  running: boolean
  /** Records included in the opening snapshot. */
  records: Ev[]
  /** Events replayed after the snapshot, one every `liveIntervalMs` (running sessions only). */
  live: Ev[]
}

function seqd(events: Omit<Ev, 'seq'>[], start = 0): Ev[] {
  return events.map((e, i) => ({ ...e, seq: start + i }))
}

// ── session A: finished, with file / bash / generic tool cards ───────────────
const auditEvents = seqd([
  { type: 'session/title', time: min(0), data: { title: `${DEMO_TAG}审计 DESIGN.md「未采集」规则` } },
  { type: 'user/message', time: min(0), data: { id: 'demo-u1', content: text(`${DEMO_TAG}检查前端有没有违反 DESIGN.md 的「缺字段写未采集，不为好看编 KPI」。只报告，不改代码。`), source: { kind: 'user' } } },
  { type: 'turn/start', time: min(0), data: { turn: 1 } },
  { type: 'tool/call', time: sec(8), data: { turn: 1, step: 1, callId: 'demo-c1', name: 'read', arguments: JSON.stringify({ file_path: 'frontend/DESIGN.md' }) } },
  { type: 'tool/result', time: sec(9), data: { message: { content: [{ type: 'tool-result', toolCallId: 'demo-c1', content: text(`${DEMO_TAG}灯语: queued / running / done / failed。缺字段写「未采集」，不为好看编 KPI …`) }] } } },
  { type: 'tool/call', time: sec(14), data: { turn: 1, step: 2, callId: 'demo-c2', name: 'bash', arguments: JSON.stringify({ command: "rg -n \"toFixed\\(|\\?\\? 0\" src/components/console | wc -l" }) } },
  { type: 'tool/result', time: sec(16), data: { message: { content: [{ type: 'tool-result', toolCallId: 'demo-c2', content: text(`${DEMO_TAG}(示意输出) 3`) }] } } },
  { type: 'tool/call', time: sec(21), data: { turn: 1, step: 3, callId: 'demo-c3', name: 'grep', arguments: JSON.stringify({ pattern: '未采集', path: 'src' }) } },
  { type: 'tool/result', time: sec(22), data: { message: { content: [{ type: 'tool-result', toolCallId: 'demo-c3', content: text(`${DEMO_TAG}(示意输出) src/components/console/UsageBand.tsx · src/pages/console-live.tsx · …`) }] } } },
  { type: 'assistant/message', time: sec(40), data: { turn: 1, step: 4, message: { id: 'demo-a1', source: SOURCE, content: text(`${DEMO_TAG}这是一段内置样例回复，用来展示对话流的排版，不是模型输出。\n\n结论（示意）：\n1. 使用率带在分母缺席时显示「未采集」，符合规则。\n2. 有 3 处 \`?? 0\` 会把缺字段显示成 0，应改成缺席态。\n3. 没有发现为了好看而硬编码的 KPI。\n\n按你的要求，只报告，未改动任何文件。`) } } },
  { type: 'turn/end', time: sec(41), data: { turn: 1, reason: { kind: 'completed' } } },
])

// ── session B: "running" — the tail replays live so recordings show motion ──
const liveHead = seqd([
  { type: 'session/title', time: min(30), data: { title: `${DEMO_TAG}给记忆星图加时间层` } },
  { type: 'user/message', time: min(30), data: { id: 'demo-u2', content: text(`${DEMO_TAG}记忆星图按 supersedes / validUntil 画时间层，先列方案，别动冻结层。`), source: { kind: 'user' } } },
  { type: 'turn/start', time: min(30), data: { turn: 1 } },
])
const liveTail = seqd([
  { type: 'tool/call', time: min(30) + 5000, data: { turn: 1, step: 1, callId: 'demo-c4', name: 'read', arguments: JSON.stringify({ file_path: 'frontend/src/pages/memory-graph-model.ts' }) } },
  { type: 'tool/result', time: min(30) + 6000, data: { message: { content: [{ type: 'tool-result', toolCallId: 'demo-c4', content: text(`${DEMO_TAG}(示意) export function layoutStarmap(nodes, edges) { … }`) }] } } },
  { type: 'text-chunks', time: min(30) + 9000, data: { turn: 1, step: 2, texts: [`${DEMO_TAG}方案草稿（样例文本）：\n`] } },
  { type: 'text-chunks', time: min(30) + 10000, data: { turn: 1, step: 2, texts: ['1. 时间层只读 supersedes / validUntil 两个真字段；'] } },
  { type: 'text-chunks', time: min(30) + 11000, data: { turn: 1, step: 2, texts: ['缺字段的节点不画层，标「未采集」。\n'] } },
  { type: 'text-chunks', time: min(30) + 12000, data: { turn: 1, step: 2, texts: ['2. 改动只落在 pages/，不碰 stores/ fold/ api-client/ contract/。\n'] } },
  { type: 'text-chunks', time: min(30) + 13000, data: { turn: 1, step: 2, texts: ['3. 空闲时停 rAF，听 prefers-reduced-motion。'] } },
], liveHead.length)

export const DEMO_SESSIONS: DemoSession[] = [
  { sessionId: 'demo-live-starmap', title: `${DEMO_TAG}给记忆星图加时间层`, updatedAt: min(31), running: true, records: liveHead, live: liveTail },
  { sessionId: 'demo-audit-design', title: `${DEMO_TAG}审计 DESIGN.md「未采集」规则`, updatedAt: min(1), running: false, records: auditEvents, live: [] },
]

export function demoSessionById(id: string): DemoSession | undefined {
  return DEMO_SESSIONS.find((s) => s.sessionId === id)
}

export function demoSessionList(): { items: unknown[] } {
  return {
    items: DEMO_SESSIONS.map((s) => ({
      sessionId: s.sessionId,
      updatedAt: s.updatedAt,
      running: s.running,
      blank: false,
      cwd: DEMO_CWD,
      projections: { asOfSeq: s.records.length - 1, values: { title: s.title } },
    })),
  }
}

export function demoFollowSnapshot(s: DemoSession): unknown {
  const cursor = s.records.length - 1
  return {
    type: 'snapshot',
    header: { version: 1, id: s.sessionId, createdAt: s.records[0]?.time ?? DEMO_T0, cwd: DEMO_CWD },
    cursor,
    records: s.records.map((event) => ({ type: 'event', event })),
    hasMore: false,
    projections: { asOfSeq: cursor, values: { title: s.title } },
  }
}
