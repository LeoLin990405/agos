/**
 * fold —— SessionEvent 流 → 对话面 的归约器(增量,history 与 live 同一条路)。
 *
 * 权威规则(全部来自 392 条真实会话的载荷实测,见 model.ts 头注):
 * - 最终消息权威:`assistant/message` 携带完整 content(reasoning+text 块),
 *   **替换**同 (turn,step) 的流式累积;`*-chunks` 只服务直播中的部分渲染。
 * - 工具按 callId 配对:`tool/call`(name+arguments 全串)→ `tool/result`
 *   (message.content[].tool-result,isError 定 done/failed)。
 * - 审批:`approval/asked`(id/toolName/callId/reason)→ `approval/decided`(outcome)。
 * - `agent/inbox/spliced` 是队列态不是 transcript:user 内容入队,
 *   `user/message` 才是正史(实测两者并存,inbox 先行)。
 * - 未注册类型进 diagnostics.unknown —— 回放校验要求恒空,词汇长了就显式登记。
 * - `subagent/descriptor`(W14):每会话 ≤1 条、恒在 session 行之后(语料 256/256),
 *   data.label 进 header.subagentLabel;one-shot 的 label 可缺(26/256),缺就保持 undefined。
 *   原注释「谱系侧已有更好来源」不成立:/api/swarm/history 今天 records=[]。
 */
import type {
  ApprovalItem, AssistantItem, ConversationItem, FoldDiagnostics, FoldedConversation,
  FoldedHeader, ResultBlock, SwarmProgressRow, ToolItem, UserItem,
} from './model.ts'

/** 按设计忽略(计数但不产出)的事件类型 —— 显式登记,别让它们落进 unknown。 */
const IGNORED_TYPES = new Set([
  'request/header', 'request/context', // LLM 请求装配细节,非对话面
  'permission/preset',
  'session/end-seed',
  'session/title-llm-request',
  'web/deepseek-search-llm-request',
  'llm/retry', 'llm/retry-started',
  'tool-workflow/agent-start', 'tool-workflow/agent-end',
  'tool-workflow/run-start', 'tool-workflow/run-end',
  'command/run', 'command/done',
  'goal/change',
  'agent-preset/selected',
  'step/start', 'step/end', // 计时粒度,对话面用 turn 即可
  'assistant/chunk', // block-start/end 标记;文本增量在 *-chunks 里
  'compaction/start', 'compaction/summary', 'compaction/end', // prune 单独计数,过程事件忽略
])

interface StreamingBuf {
  turn: number
  step: number
  reasoning: string[]
  text: string[]
  at: number
}

type AnyEvent = Record<string, unknown>

const asObj = (v: unknown): Record<string, unknown> =>
  typeof v === 'object' && v !== null ? v as Record<string, unknown> : {}
const asStr = (v: unknown): string | undefined => typeof v === 'string' ? v : undefined
const asNum = (v: unknown): number | undefined => typeof v === 'number' ? v : undefined

/** content[] 里抽指定 type 块的 text 拼接。 */
function pickText(content: unknown, type: string): string {
  if (!Array.isArray(content)) return ''
  return content
    .filter((b): b is Record<string, unknown> => typeof b === 'object' && b !== null)
    .filter((b) => b['type'] === type && typeof b['text'] === 'string')
    .map((b) => b['text'] as string)
    .join('')
}

/**
 * content[] 里抽**非 text** 块的引用元信息(W1):image/audio 等块在归约层
 * 不再被丢弃。只留 {type, mediaType?, url?, path?, name?, attachment?} 引用,
 * 不搬运二进制;附件经 attachmentId 走 session.attachment RPC 取原件。
 * 本函数是纯增量:不改变 pickText 的任何行为(resultText 不变量所在)。
 */
function pickBlocks(content: unknown): ResultBlock[] {
  if (!Array.isArray(content)) return []
  const out: ResultBlock[] = []
  for (const raw of content) {
    const b = asObj(raw)
    const type = asStr(b['type'])
    if (type === undefined || type === 'text' || type === 'tool-result') continue
    const att = asObj(b['attachment'])
    const attachmentId = asStr(att['attachmentId'])
    out.push({
      type,
      mediaType: asStr(b['mediaType']),
      url: asStr(b['url']),
      path: asStr(b['path']),
      name: asStr(b['name']),
      attachment: attachmentId === undefined ? undefined : {
        attachmentId,
        mediaType: asStr(att['mediaType']),
        name: asStr(att['name']),
        width: asNum(att['width']),
        height: asNum(att['height']),
        bytes: asNum(att['bytes']),
      },
    })
  }
  return out
}

export interface Fold {
  /** 喂一行(已解析对象);坏行请在外层计 parseErrors 后跳过。 */
  apply(event: AnyEvent): void
  /** 当前快照(每次调用重建数组;items 内对象为内部引用,读用勿改)。 */
  snapshot(): FoldedConversation
  noteParseError(): void
}

export function createFold(): Fold {
  let header: FoldedHeader | undefined
  let title: string | undefined
  const items: ConversationItem[] = []
  const toolByCallId = new Map<string, ToolItem>()
  const approvalById = new Map<string, ApprovalItem>()
  /** (turn:step) → 流式累积中的 assistant 条目(收到最终消息即替换)。 */
  const streamingByStep = new Map<string, { buf: StreamingBuf, item: AssistantItem }>()
  const queuedUserTexts: string[] = []
  const startedTurns = new Set<number>()
  const endedTurns = new Set<number>()
  let lastTurnEndReason: string | undefined
  let todos: { content: string, status: string }[] = []
  let planMode = false
  let sandboxMode: string | undefined
  let approvalPolicy: string | undefined
  const diagnostics: FoldDiagnostics = {
    events: 0, unknown: {}, ignored: {}, parseErrors: 0,
    danglingToolCalls: 0, orphanToolResults: 0, compactionPrunes: 0,
  }

  const stepKey = (turn: unknown, step: unknown): string => `${asNum(turn) ?? 0}:${asNum(step) ?? 0}`

  function ensureStreaming(turn: number, step: number, at: number): { buf: StreamingBuf, item: AssistantItem } {
    const key = `${turn}:${step}`
    let entry = streamingByStep.get(key)
    if (entry === undefined) {
      const item: AssistantItem = {
        kind: 'assistant', id: undefined, turn, step,
        text: '', reasoning: '', provider: undefined, model: undefined, at, streaming: true,
      }
      entry = { buf: { turn, step, reasoning: [], text: [], at }, item }
      streamingByStep.set(key, entry)
      items.push(item)
    }
    return entry
  }

  function apply(event: AnyEvent): void {
    diagnostics.events += 1
    const type = asStr(event['type']) ?? '<untyped>'
    const at = asNum(event['time']) ?? asNum(event['time0']) ?? 0
    const data = asObj(event['data'])

    switch (type) {
      case 'session': {
        header = {
          sessionId: asStr(event['id']) ?? '',
          cwd: asStr(event['cwd']),
          createdAt: asNum(event['createdAt']),
          origin: asStr(event['origin']) ?? 'top',
          parentSession: asStr(event['parentSession']),
          delegationDepth: asNum(event['delegationDepth']) ?? 0,
          agentPreset: asStr(event['agentPreset']),
          // 必须是 undefined 而不是 null/'':JSON.stringify 会丢掉它,金标 G1 的折叠产物才能逐字不变。
          subagentLabel: undefined,
        }
        return
      }
      case 'session/title': {
        title = asStr(data['title']) ?? title
        return
      }
      case 'user/message': {
        const blocks = pickBlocks(data['content'])
        const item: UserItem = {
          kind: 'user', id: asStr(data['id']),
          text: pickText(data['content'], 'text'),
          at,
          sourceKind: asStr(asObj(data['source'])['kind']) ?? 'user',
          ...(blocks.length > 0 ? { blocks } : {}),
        }
        items.push(item)
        return
      }
      case 'agent/inbox/spliced': {
        // 队列态:removedCount 消费、inserted 入队;user 角色的插入记文本。
        const inserted = data['inserted']
        if (Array.isArray(inserted)) {
          for (const ins of inserted) {
            const o = asObj(ins)
            if (o['role'] === 'user') queuedUserTexts.push(pickText(o['content'], 'text'))
          }
        }
        const removed = asNum(data['removedCount']) ?? 0
        if (removed > 0) queuedUserTexts.splice(0, removed)
        return
      }
      case 'turn/start': { startedTurns.add(asNum(data['turn']) ?? 0); return }
      case 'turn/end': {
        // 同一 turn 可能收到多次 end(实测:interrupted 后又补 completed)→ 按集合去重
        endedTurns.add(asNum(data['turn']) ?? 0)
        lastTurnEndReason = asStr(asObj(data['reason'])['kind']) ?? lastTurnEndReason
        // 回合结束 = 不再有东西在流式中(中断的步保留已积累文本,streaming 归 false)
        for (const entry of streamingByStep.values()) entry.item.streaming = false
        streamingByStep.clear()
        return
      }
      case 'reasoning-chunks':
      case 'text-chunks': {
        const entry = ensureStreaming(asNum(data['turn']) ?? 0, asNum(data['step']) ?? 0, at)
        const texts = data['texts']
        if (Array.isArray(texts)) {
          const dst = type === 'reasoning-chunks' ? entry.buf.reasoning : entry.buf.text
          for (const t of texts) if (typeof t === 'string') dst.push(t)
          entry.item.reasoning = entry.buf.reasoning.join('')
          entry.item.text = entry.buf.text.join('')
        }
        return
      }
      case 'tool-call-chunks': {
        // 流式期先立占位工具条目,tool/call 到达后以全串权威覆盖。
        const callId = asStr(data['id'])
        if (callId === undefined) return
        let tool = toolByCallId.get(callId)
        if (tool === undefined) {
          tool = {
            kind: 'tool', callId, name: asStr(data['name']) ?? '', argsRaw: '',
            turn: asNum(data['turn']) ?? 0, step: asNum(data['step']) ?? 0,
            startAt: at, endAt: undefined, status: 'running', resultText: undefined, swarm: undefined,
          }
          toolByCallId.set(callId, tool)
          items.push(tool)
        }
        const args = data['args']
        if (Array.isArray(args)) tool.argsRaw += args.filter((a): a is string => typeof a === 'string').join('')
        return
      }
      case 'tool/call': {
        const callId = asStr(data['callId'])
        if (callId === undefined) return
        let tool = toolByCallId.get(callId)
        if (tool === undefined) {
          tool = {
            kind: 'tool', callId, name: '', argsRaw: '',
            turn: asNum(data['turn']) ?? 0, step: asNum(data['step']) ?? 0,
            startAt: at, endAt: undefined, status: 'running', resultText: undefined, swarm: undefined,
          }
          toolByCallId.set(callId, tool)
          items.push(tool)
        }
        tool.name = asStr(data['name']) ?? tool.name
        tool.argsRaw = asStr(data['arguments']) ?? tool.argsRaw // 全串权威
        return
      }
      case 'tool/result': {
        const message = asObj(data['message'])
        const content = message['content']
        let callId: string | undefined
        let text = ''
        let isError = false
        const blocks: ResultBlock[] = []
        if (Array.isArray(content)) {
          for (const block of content) {
            const b = asObj(block)
            if (b['type'] !== 'tool-result') continue
            callId = asStr(b['toolCallId']) ?? callId
            if (b['isError'] === true) isError = true
            text += pickText(b['content'], 'text')
            blocks.push(...pickBlocks(b['content']))
          }
        }
        if (callId === undefined) { diagnostics.orphanToolResults += 1; return }
        const tool = toolByCallId.get(callId)
        if (tool === undefined) { diagnostics.orphanToolResults += 1; return }
        tool.endAt = at
        tool.status = isError ? 'failed' : 'done'
        tool.resultText = text
        if (blocks.length > 0) tool.resultBlocks = blocks
        return
      }
      case 'assistant/message': {
        const message = asObj(data['message'])
        const turn = asNum(data['turn']) ?? 0
        const step = asNum(data['step']) ?? 0
        const source = asObj(message['source'])
        const key = `${turn}:${step}`
        const existing = streamingByStep.get(key)
        const item: AssistantItem = existing?.item ?? {
          kind: 'assistant', id: undefined, turn, step,
          text: '', reasoning: '', provider: undefined, model: undefined, at, streaming: true,
        }
        if (existing === undefined) items.push(item)
        item.id = asStr(message['id'])
        item.text = pickText(message['content'], 'text')
        item.reasoning = pickText(message['content'], 'reasoning')
        item.provider = asStr(source['provider'])
        item.model = asStr(source['model'])
        item.streaming = false
        streamingByStep.delete(key)
        return
      }
      case 'approval/asked': {
        const id = asStr(data['id'])
        if (id === undefined) return
        const item: ApprovalItem = {
          kind: 'approval', id,
          toolName: asStr(data['toolName']), callId: asStr(data['callId']),
          reason: asStr(data['reason']), at, outcome: undefined,
        }
        approvalById.set(id, item)
        items.push(item)
        return
      }
      case 'approval/decided': {
        const item = approvalById.get(asStr(data['id']) ?? '')
        if (item !== undefined) item.outcome = asStr(data['outcome'])
        return
      }
      case 'todo/write': {
        const list = data['todos']
        if (Array.isArray(list)) {
          todos = list.map((t) => {
            const o = asObj(t)
            return { content: asStr(o['content']) ?? '', status: asStr(o['status']) ?? '' }
          })
        }
        return
      }
      case 'swarm/progress': {
        const callId = asStr(data['callId'])
        const rows = data['subagents']
        if (callId !== undefined && Array.isArray(rows)) {
          const tool = toolByCallId.get(callId)
          if (tool !== undefined) tool.swarm = rows.map((r) => asObj(r) as unknown as SwarmProgressRow)
        }
        return
      }
      case 'subagent/descriptor': {
        const label = asStr(data['label'])
        if (header !== undefined && label !== undefined) header.subagentLabel = label
        return
      }
      case 'plan/mode': { planMode = true; return }
      case 'sandbox/mode': { sandboxMode = asStr(data['mode']) ?? sandboxMode; return }
      case 'approval/policy': { approvalPolicy = asStr(data['policy']) ?? approvalPolicy; return }
      case 'compaction/prune': { diagnostics.compactionPrunes += 1; return }
      default: {
        const bucket = IGNORED_TYPES.has(type) ? diagnostics.ignored : diagnostics.unknown
        bucket[type] = (bucket[type] ?? 0) + 1
      }
    }
    void stepKey // (保留辅助;当前未用作它途)
  }

  function snapshot(): FoldedConversation {
    let dangling = 0
    for (const tool of toolByCallId.values()) if (tool.status === 'running') dangling += 1
    diagnostics.danglingToolCalls = dangling
    return {
      header, title,
      items: [...items],
      turnsStarted: startedTurns.size, turnsEnded: endedTurns.size, lastTurnEndReason,
      todos: [...todos], planMode, sandboxMode, approvalPolicy,
      queuedUserTexts: [...queuedUserTexts],
      diagnostics: { ...diagnostics, unknown: { ...diagnostics.unknown }, ignored: { ...diagnostics.ignored } },
    }
  }

  return { apply, snapshot, noteParseError: () => { diagnostics.parseErrors += 1 } }
}

/** 便捷:整段 JSONL 文本 → 快照(history 全量重建用)。 */
export function foldJsonl(jsonl: string): FoldedConversation {
  const fold = createFold()
  for (const line of jsonl.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    try {
      fold.apply(JSON.parse(trimmed) as AnyEvent)
    } catch {
      fold.noteParseError()
    }
  }
  return fold.snapshot()
}
