/**
 * 对话面模型 —— 自写 fold 的输出形状。
 *
 * 决策记录(2026-08-20,推翻 TASK-003 原「vendor fold」方案):上游 fold 是
 * 注册表驱动的框架(runtime/sessions 6k 行,节点定义散在各 ui-* 插件里),
 * vendor 它等于拖回我们刚决定不背的平台层。而事件词汇已被本机 392 条真实
 * 会话 / 11.5 万事件实测钉死(~40 类,会话面核心 ~15 类),自写归约器更小、
 * 更稳、完全归我们所有。正确性由语料回放(scripts/replay-check.ts)背书。
 */

/** 会话头(第一行,type:"session")。 */
export interface FoldedHeader {
  sessionId: string
  cwd: string | undefined
  createdAt: number | undefined
  origin: string // 'top' | 'subagent' | …
  parentSession: string | undefined
  delegationDepth: number
  agentPreset: string | undefined
}

export interface UserItem {
  kind: 'user'
  id: string | undefined
  text: string
  at: number
  /** data.source.kind:'user'=真人;'plugin'/'skill-catalog' 等=系统注入(UI 可折叠)。 */
  sourceKind: string
}

export interface AssistantItem {
  kind: 'assistant'
  id: string | undefined
  turn: number
  step: number
  /** 正文(text 块拼接)。 */
  text: string
  /** 思考链(reasoning 块拼接);无则空串。 */
  reasoning: string
  provider: string | undefined
  model: string | undefined
  at: number
  /** true = 仍在流式中(只有 chunk、还没收到最终 assistant/message)。 */
  streaming: boolean
}

export interface ToolItem {
  kind: 'tool'
  callId: string
  name: string
  /** 原始 JSON 串(tool/call.data.arguments);流式期为已累积的片段。 */
  argsRaw: string
  turn: number
  step: number
  startAt: number
  endAt: number | undefined
  status: 'running' | 'done' | 'failed'
  /** 结果文本(tool-result 嵌套 content 里的 text 拼接)。 */
  resultText: string | undefined
  /** swarm/progress 最新快照(仅 swarm 族调用有)。 */
  swarm: SwarmProgressRow[] | undefined
}

export interface SwarmProgressRow {
  index: number
  item: string | undefined
  type: string | undefined
  model: string | undefined
  status: string
  [k: string]: unknown
}

export interface ApprovalItem {
  kind: 'approval'
  id: string
  toolName: string | undefined
  callId: string | undefined
  reason: string | undefined
  at: number
  outcome: string | undefined // undefined = 待决
}

export type ConversationItem = UserItem | AssistantItem | ToolItem | ApprovalItem

export interface TodoEntry {
  content: string
  status: string
}

export interface FoldDiagnostics {
  events: number
  /** 未注册类型 → 计数(回放校验要求恒空)。 */
  unknown: Record<string, number>
  /** 已注册但按设计忽略的类型 → 计数。 */
  ignored: Record<string, number>
  parseErrors: number
  /** 有 call 无 result 的工具调用数(会话截断时允许>0)。 */
  danglingToolCalls: number
  /** 有 result 无 call 的孤儿结果(恒 0 才健康)。 */
  orphanToolResults: number
  compactionPrunes: number
}

export interface FoldedConversation {
  header: FoldedHeader | undefined
  title: string | undefined
  items: ConversationItem[]
  turnsStarted: number
  turnsEnded: number
  lastTurnEndReason: string | undefined
  todos: TodoEntry[]
  planMode: boolean
  sandboxMode: string | undefined
  approvalPolicy: string | undefined
  /** 队列(agent/inbox/spliced target=next-turn 的未消费插入)——不进 transcript。 */
  queuedUserTexts: string[]
  diagnostics: FoldDiagnostics
}
