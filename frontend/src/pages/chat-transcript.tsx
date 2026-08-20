/**
 * LiveTranscript —— 真会话对话流(fold 驱动)。
 * V2 重设计时展示 mock 覆盖了真渲染(P0 退化),本组件把 ee475dc 的接线
 * 以独立组件形式嫁接回来:ChatPage 在有真后端时渲染本组件,无后端时保留
 * Gemini 的展示 mock 作为 demo 态。
 */
import React, { useCallback, useState, useSyncExternalStore } from 'react';
import { Dot } from '@/components/ui/Dot';
import { Chip } from '@/components/ui/Chip';
import { ReasoningBlock } from '@/components/chat/ReasoningBlock';
import { TerminalCard } from '@/components/ui/TerminalCard';
import { SwarmBatchCard } from '@/components/chat/SwarmBatchCard';
import { ApprovalPanel } from '@/components/chat/ApprovalPanel';
import { TodoBar } from '@/components/chat/TodoBar';
import type { StateLamp } from '@/design-system/tokens';
import { agos, approvalRpc, conversationStore } from '@/stores/live';
import type { ConversationItem, ToolItem } from '@/fold/model';
import { RpcId } from '@/contract/api/rpc';
import type { OptimisticImageAttachment } from '@/components/chat/ImageAttachments';
import { extractMultimodalMessageId, stripMultimodalMessageMarker } from '@/components/chat/CommandDeck';

export interface OptimisticImageMessage {
  id: string;
  sessionId: string;
  text: string;
  images: OptimisticImageAttachment[];
  at: number;
}

const fmtDur = (ms: number | undefined): string =>
  ms === undefined ? '—' : ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;

const TOOL_STATE: Record<ToolItem['status'], { lamp: StateLamp, label: string }> = {
  running: { lamp: 'running', label: '处理中' },
  done: { lamp: 'done', label: '已完成' },
  failed: { lamp: 'failed', label: '未成功' },
};

const SWARM_STATE: Record<string, { lamp: StateLamp, label: string }> = {
  queued: { lamp: 'queued', label: '等待中' },
  running: { lamp: 'running', label: '处理中' },
  completed: { lamp: 'done', label: '已完成' },
  failed: { lamp: 'failed', label: '未成功' },
  aborted: { lamp: 'failed', label: '已中止' },
};

function parseBashCommand(argsRaw: string): string {
  try { return String((JSON.parse(argsRaw) as Record<string, unknown>)['command'] ?? argsRaw); }
  catch { return argsRaw.slice(0, 200); }
}

const GenericToolRow: React.FC<{ tool: ToolItem }> = ({ tool }) => {
  const [open, setOpen] = useState(false);
  const st = TOOL_STATE[tool.status];
  return (
    <div style={{ border: '1px solid var(--border-subtle)', borderRadius: '8px', backgroundColor: 'var(--bg-layer-2)' }}>
      <div onClick={() => setOpen((v) => !v)} style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '8px 12px', cursor: 'pointer' }}>
        <Dot state={st.lamp} size={6} />
        <span className="u-num" style={{ fontSize: '12px', fontWeight: 600 }}>{tool.name || '(工具)'}</span>
        <span style={{ flex: 1 }} />
        <span className="u-num" style={{ fontSize: '11px', color: 'var(--text-tertiary)' }}>
          {fmtDur(tool.endAt !== undefined ? tool.endAt - tool.startAt : undefined)}
        </span>
        <span style={{ fontSize: '10.5px', letterSpacing: '0.06em', color: tool.status === 'failed' ? 'var(--state-failed)' : tool.status === 'running' ? 'var(--state-running)' : 'var(--text-tertiary)' }}>
          {st.label}
        </span>
      </div>
      {open && tool.resultText !== undefined && tool.resultText !== '' && (
        <pre style={{ margin: 0, padding: '10px 12px', borderTop: '1px solid var(--border-dim)', fontSize: '11.5px', lineHeight: 1.55, whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: '260px', overflow: 'auto', color: 'var(--text-secondary)' }}>
          {tool.resultText.slice(0, 8000)}
        </pre>
      )}
    </div>
  );
};

const OptimisticImageStrip: React.FC<{ images: readonly OptimisticImageAttachment[] }> = ({ images }) => (
  <div className="user-attachments" aria-label={`已发送图片 ${images.length} 张`}>
    {images.map((image) => (
      <figure key={image.id} style={{ margin: 0, width: '92px' }}>
        <img
          src={image.url}
          alt={image.name}
          style={{ display: 'block', width: '92px', height: '72px', objectFit: 'cover', borderRadius: '8px', border: '1px solid var(--border-subtle)', background: 'var(--bg-layer-1)' }}
        />
        <figcaption title={image.name} style={{ marginTop: '4px', color: 'var(--text-tertiary)', fontSize: '10px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {image.name}
        </figcaption>
      </figure>
    ))}
  </div>
);

function renderItem(
  item: ConversationItem,
  key: string,
  sessionId: string,
  optimisticImages: readonly OptimisticImageAttachment[] = [],
): React.ReactNode {
  if (item.kind === 'user') {
    if (item.sourceKind !== 'user') return null;
    return (
      <div className="message-wrap" key={key}>
        <div className="message-user">
          <div className="message-user-header">
            <span style={{ fontWeight: 700, fontSize: '12.5px' }}>Leo</span>
            <span className="u-num" style={{ fontSize: '11px', color: 'var(--text-tertiary)' }}>
              {item.at > 0 ? new Date(item.at).toLocaleTimeString('zh-CN', { hour12: false }) : ''}
            </span>
          </div>
          <div style={{ fontSize: '14.5px', lineHeight: 1.7, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{stripMultimodalMessageMarker(item.text)}</div>
          {optimisticImages.length > 0 && <OptimisticImageStrip images={optimisticImages} />}
        </div>
      </div>
    );
  }
  if (item.kind === 'assistant') {
    if (item.text === '' && item.reasoning === '' && !item.streaming) return null;
    return (
      <div className="message-wrap" key={key}>
        <div className="message-assistant">
          <div className="assistant-meta">
            <span style={{ fontWeight: 700, color: 'var(--state-running)', fontSize: '12px' }}>AgOS Agent</span>
            {item.model !== undefined && (<><span>·</span><Chip>{item.provider !== undefined ? `${item.provider}/${item.model}` : item.model}</Chip></>)}
            {item.streaming && (<><span>·</span><span className="u-num" style={{ color: 'var(--state-running)', fontSize: '11px' }}>流式中…</span></>)}
          </div>
          {item.reasoning !== '' && (
            <ReasoningBlock duration="" tokens={`${item.reasoning.length} chars`}>
              <span style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{item.reasoning}</span>
            </ReasoningBlock>
          )}
          {item.text !== '' && (
            <div style={{ fontSize: '14.5px', lineHeight: 1.75, color: 'var(--text-primary)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{item.text}</div>
          )}
          {item.streaming && item.text === '' && item.reasoning === '' && (
            <div className="stream-live-indicator"><Dot state="running" /><span>思考中…</span><span className="stream-cursor" /></div>
          )}
        </div>
      </div>
    );
  }
  if (item.kind === 'tool') {
    const swarmRows = item.swarm;
    if (swarmRows !== undefined && swarmRows.length > 0) {
      const completed = swarmRows.filter((r) => r.status === 'completed').length;
      return (
        <div className="message-wrap" key={key}>
          <SwarmBatchCard
            batchId={item.callId.slice(-8)}
            title={item.name}
            completedCount={completed}
            totalCount={swarmRows.length}
            isRunning={item.status === 'running'}
            rows={swarmRows.map((r) => {
              const st = SWARM_STATE[r.status] ?? SWARM_STATE['queued'];
              return {
                idx: String(r.index).padStart(2, '0'),
                name: String(r.item ?? r.type ?? `#${r.index}`).slice(0, 60),
                role: String(r.type ?? ''),
                provider: String(r.model ?? ''),
                time: typeof r['elapsedMs'] === 'number' ? fmtDur(r['elapsedMs'] as number) : '--',
                state: st.lamp,
                stateLabel: st.label,
              };
            })}
          />
        </div>
      );
    }
    if (item.name === 'bash') {
      return (
        <div className="message-wrap" key={key}>
          <TerminalCard
            title="bash_exec"
            command={parseBashCommand(item.argsRaw)}
            output={(item.resultText ?? (item.status === 'running' ? '(运行中…)' : '')).slice(0, 8000)}
            duration={fmtDur(item.endAt !== undefined ? item.endAt - item.startAt : undefined)}
            exitCode={item.status === 'failed' ? 1 : 0}
          />
        </div>
      );
    }
    return <div className="message-wrap" key={key}><GenericToolRow tool={item} /></div>;
  }
  // approval
  if (item.outcome !== undefined) {
    return (
      <div className="message-wrap" key={key}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '8px 12px', borderRadius: '8px', border: '1px solid var(--border-subtle)', fontSize: '12px', color: 'var(--text-secondary)' }}>
          <Dot state={item.outcome === 'rejected' ? 'failed' : 'done'} size={6} />
          <span>审批 {item.toolName ?? ''}:{item.outcome === 'allowed-once' ? '已放行(一次)' : item.outcome}</span>
        </div>
      </div>
    );
  }
  const respond = (outcome: 'allowed-once' | 'rejected') => {
    const rpcId = approvalRpc.get(item.id);
    if (rpcId === undefined) return; // 冷历史悬挂审批:无活跃帧可回
    void agos.respond({
      type: 'client-response',
      rpcId: RpcId(rpcId),
      result: { ok: true, value: { sessionId, approvalId: item.id, outcome } },
    });
  };
  return (
    <div className="message-wrap" key={key}>
      <ApprovalPanel
        title={`特权操作审批请求:${item.toolName ?? '工具调用'}`}
        riskLevel="需人工决策"
        actionSummary={item.reason ?? item.callId ?? item.id}
        diffSnippet={[]}
        onAllow={() => respond('allowed-once')}
        onReject={() => respond('rejected')}
      />
    </div>
  );
}

export const LiveTranscript: React.FC<{
  sessionId: string;
  optimisticImageMessages?: readonly OptimisticImageMessage[];
}> = ({ sessionId, optimisticImageMessages = [] }) => {
  const convo = useSyncExternalStore(
    conversationStore.subscribe,
    useCallback(() => conversationStore.getSnapshot(sessionId), [sessionId]),
  );
  const snapshot = convo.snapshot;
  const localMessages = optimisticImageMessages.filter((message) => message.sessionId === sessionId);
  const matchedLocalIds = new Set<string>();
  const imagesByItemIndex = new Map<number, readonly OptimisticImageAttachment[]>();
  const localById = new Map(localMessages.map((message) => [message.id, message]));
  for (let index = 0; index < (snapshot?.items.length ?? 0); index += 1) {
    const item = snapshot?.items[index];
    if (item?.kind !== 'user' || item.sourceKind !== 'user') continue;
    const markerId = extractMultimodalMessageId(item.text);
    const local = markerId === undefined ? undefined : localById.get(markerId);
    if (local === undefined) continue;
    matchedLocalIds.add(local.id);
    imagesByItemIndex.set(index, local.images);
  }
  const renderedItems = snapshot?.items.map((item, index) => {
    return renderItem(item, `${sessionId}:${index}`, sessionId, imagesByItemIndex.get(index) ?? []);
  });
  const pendingLocalMessages = localMessages.filter((message) => !matchedLocalIds.has(message.id));
  return (
    <>
      {convo.phase === 'loading' && (
        <div style={{ padding: '32px', textAlign: 'center', color: 'var(--text-tertiary)', fontSize: '12.5px' }}>正在折叠会话历史…</div>
      )}
      {convo.phase === 'error' && (
        <div style={{ padding: '32px', textAlign: 'center', color: 'var(--state-failed)', fontSize: '12.5px' }}>加载失败:{convo.error}</div>
      )}
      {snapshot !== undefined && snapshot.todos.length > 0 && (
        <div className="message-wrap"><TodoBar todos={snapshot.todos.map((t) => ({ content: t.content, status: t.status as 'completed' | 'in_progress' | 'pending' }))} /></div>
      )}
      {renderedItems}
      {pendingLocalMessages.map((message) => (
        <div className="message-wrap" key={`optimistic:${message.id}`}>
          <div className="message-user" style={{ opacity: 0.9 }}>
            <div className="message-user-header">
              <span style={{ fontWeight: 700, fontSize: '12.5px' }}>Leo</span>
              <span className="u-num" style={{ fontSize: '11px', color: 'var(--state-running)' }}>发送中同步…</span>
            </div>
            <div style={{ fontSize: '14.5px', lineHeight: 1.7, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{stripMultimodalMessageMarker(message.text)}</div>
            <OptimisticImageStrip images={message.images} />
          </div>
        </div>
      ))}
      {snapshot !== undefined && snapshot.items.length === 0 && convo.phase === 'live' && (
        <div style={{ padding: '32px', textAlign: 'center', color: 'var(--text-tertiary)', fontSize: '12.5px' }}>空白会话——在下方输入第一条指令。</div>
      )}
    </>
  );
};
