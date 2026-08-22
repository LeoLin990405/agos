/**
 * 轨迹面接入用的会话 id。
 *
 * handleSelectSession / openConversation 把传入的字符串原样当作 session.history
 * 与 conversations 的键。sessionsStore 的 sessionId 来自 session.list(权威名册);
 * ChatPage 父会话 chip 传的是 header.parentSession,形态是 `session-<uuid>`。
 * 依据是磁盘名册:~/.dsh/sessions/--Users-leo--/ 下的会话目录就叫 `session-<uuid>`。
 * ⚠️ 原来这里写的是「实测:带前缀打 session-memory 为 ready,裸 uuid 为 empty」——
 * 那个推论是假的。session-memory 的 status 只取决于有没有写过记忆文档
 * (dsh-agos/lib/session-memory.mjs:470),跟 id 形态无关:带前缀的真会话
 * session-fa1de481-… 打回来同样是 'empty'(2026-08-22 验收 P2 实测反例)。
 * 判定规则本身仍成立,但理由换成磁盘名册,别照着假理由往外推广。
 *
 * 因此只传载荷里的 rawId,且必须已经是带前缀的权威形态。缺席或不是
 * session- 前缀 → 不渲染按钮,不猜、不拼。
 */
export function traceJoinId(rawId: string | undefined): string | undefined {
  const id = String(rawId ?? '').trim()
  if (!id.startsWith('session-')) return undefined
  return id
}

export const TRACE_JOIN_COPY = '接入该会话'

export const TRACE_JOIN_COUNT_COPY = (n: number): string => `可接入 ${n} 条会话`
