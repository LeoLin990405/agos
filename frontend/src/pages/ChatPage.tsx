import React, { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { AppTopbar } from '@/components/layout/AppTopbar';
import { Dot } from '@/components/ui/Dot';
import { Chip } from '@/components/ui/Chip';
import { Button } from '@/components/ui/Button';
import { ReasoningBlock } from '@/components/chat/ReasoningBlock';
import { TerminalCard } from '@/components/ui/TerminalCard';
import { SwarmBatchCard } from '@/components/chat/SwarmBatchCard';
import { ApprovalPanel } from '@/components/chat/ApprovalPanel';
import { CommandDeck } from '@/components/chat/CommandDeck';
import type { StateLamp } from '@/design-system/tokens';
import {
  agos, approvalRpc, conversationStore, openConversation, refreshSessions,
  sendPrompt, sessionsStore, streamStore,
} from '@/stores/live';
import type { ConversationItem, ToolItem } from '@/fold/model';
import { RpcId } from '@/contract/api/rpc';

/** 会话行灯语:running 蓝、blank 灰、其余绿(列表面没有失败信息,不装懂)。 */
const rowState = (r: { running: boolean, blank: boolean }): StateLamp =>
  r.running ? 'running' : r.blank ? 'queued' : 'done';

const fmtAgo = (at: number): string => {
  const s = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (s < 60) return '刚刚';
  if (s < 3600) return `${Math.floor(s / 60)}分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)}小时前`;
  return `${Math.floor(s / 86400)}天前`;
};

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

/** 通用工具行:bash/swarm 之外的工具用紧凑台账形态。 */
const GenericToolRow: React.FC<{ tool: ToolItem }> = ({ tool }) => {
  const [open, setOpen] = useState(false);
  const st = TOOL_STATE[tool.status];
  return (
    <div style={{ border: '1px solid var(--border-subtle)', borderRadius: '8px', backgroundColor: 'var(--bg-layer-2)' }}>
      <div
        onClick={() => setOpen((v) => !v)}
        style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '8px 12px', cursor: 'pointer' }}
      >
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

function renderItem(item: ConversationItem, key: string, sessionId: string): React.ReactNode {
  if (item.kind === 'user') {
    if (item.sourceKind !== 'user') return null; // 系统注入(runtime context/skill catalog)不进对话面
    return (
      <div className="message-wrap" key={key}>
        <div className="message-user">
          <div className="message-user-header">
            <span style={{ fontWeight: 700, fontSize: '12.5px' }}>Leo</span>
            <span className="u-num" style={{ fontSize: '11px', color: 'var(--text-tertiary)' }}>
              {item.at > 0 ? new Date(item.at).toLocaleTimeString('zh-CN', { hour12: false }) : ''}
            </span>
          </div>
          <div style={{ fontSize: '13.5px', lineHeight: 1.6, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{item.text}</div>
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
            <div style={{ fontSize: '13.5px', lineHeight: 1.65, color: 'var(--text-primary)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{item.text}</div>
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
                state: st.lamp === 'done' ? 'done' : st.lamp,
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
            title={`bash_exec`}
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
    if (rpcId === undefined) return; // 冷历史里的悬挂审批:无活跃帧可回,只读展示
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

export const ChatPage: React.FC<{ onNavigateConsole?: () => void }> = ({ onNavigateConsole }) => {
  const sessions = useSyncExternalStore(sessionsStore.subscribe, sessionsStore.getSnapshot);
  const online = useSyncExternalStore(streamStore.subscribe, streamStore.getSnapshot);
  const [activeSessionId, setActiveSessionId] = useState<string | undefined>(undefined);
  const [filter, setFilter] = useState('');
  const convo = useSyncExternalStore(
    conversationStore.subscribe,
    useCallback(() => conversationStore.getSnapshot(activeSessionId), [activeSessionId]),
  );

  useEffect(() => {
    if (activeSessionId === undefined && sessions.rows.length > 0) {
      const first = sessions.rows[0];
      if (first !== undefined) { setActiveSessionId(first.sessionId); openConversation(first.sessionId); }
    }
  }, [sessions.rows, activeSessionId]);

  const select = (id: string) => { setActiveSessionId(id); openConversation(id); };
  const snapshot = convo.snapshot;
  const title = snapshot?.title ?? sessions.rows.find((r) => r.sessionId === activeSessionId)?.title ?? 'AgOS 对话甲板';
  const visibleRows = sessions.rows.filter((r) => filter === '' || r.title.includes(filter) || r.cwd.includes(filter));

  return (
    <div style={{ display: 'flex', flex: 1, height: '100vh', overflow: 'hidden' }}>
      {/* 会话侧栏(真数据) */}
      <aside style={{ width: '290px', flex: 'none', backgroundColor: 'var(--bg-layer-1)', borderRight: '1px solid var(--border-dim)', display: 'flex', flexDirection: 'column', height: '100%' }}>
        <div style={{ padding: '14px 16px', borderBottom: '1px solid var(--border-dim)', display: 'flex', flexDirection: 'column', gap: '12px' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span className="u-microlabel">会话矩阵 ({sessions.rows.length})</span>
            <Button variant="ghost" size="sm" onClick={() => { void refreshSessions(); }}>刷新</Button>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', backgroundColor: 'var(--bg-layer-2)', border: '1px solid var(--border-subtle)', borderRadius: '7px', padding: '6px 12px', gap: '8px' }}>
            <input
              type="text"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="搜索历史会话…"
              style={{ background: 'transparent', border: 'none', color: 'var(--text-primary)', fontSize: '12px', width: '100%', outline: 'none' }}
            />
          </div>
        </div>
        <div style={{ flex: 1, overflowY: 'auto', padding: '10px', display: 'flex', flexDirection: 'column', gap: '5px' }}>
          {visibleRows.length === 0 && (
            <div style={{ padding: '24px 12px', textAlign: 'center', fontSize: '12px', color: 'var(--text-tertiary)' }}>
              {sessions.error !== undefined ? `连接失败:${sessions.error.slice(0, 80)}` : sessions.loadedAt === 0 ? '正在连接 dsh…' : '暂无会话'}
            </div>
          )}
          {visibleRows.map((s) => (
            <div
              key={s.sessionId}
              onClick={() => select(s.sessionId)}
              style={{
                padding: '12px 14px', borderRadius: '8px', cursor: 'pointer',
                backgroundColor: activeSessionId === s.sessionId ? 'var(--bg-layer-2)' : 'transparent',
                border: activeSessionId === s.sessionId ? '1px solid var(--border-subtle)' : '1px solid transparent',
                boxShadow: activeSessionId === s.sessionId ? 'inset 2.5px 0 0 var(--state-running), var(--shadow-card)' : 'none',
                display: 'flex', flexDirection: 'column', gap: '6px',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0 }}>
                <Dot state={rowState(s)} />
                <span style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-primary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{s.title}</span>
              </div>
              <div style={{ fontSize: '11px', color: 'var(--text-tertiary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} className="u-num">{s.cwd}</div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: '10.5px', color: 'var(--text-tertiary)' }}>
                <span className="u-num">{s.turns} 轮 · {(s.tokens / 1000).toFixed(1)}k tok</span>
                <span className="u-num" style={s.running ? { color: 'var(--state-running)', fontWeight: 600 } : undefined}>{fmtAgo(s.updatedAt)}</span>
              </div>
            </div>
          ))}
        </div>
      </aside>

      {/* 舞台 */}
      <main className="app-stage">
        <AppTopbar
          title={title}
          badge={snapshot?.header !== undefined ? <Chip active>{snapshot.header.origin === 'subagent' ? '子代理会话' : snapshot.header.agentPreset ?? 'session'}</Chip> : undefined}
          rightActions={
            <>
              <div className="telemetry-pill">
                <span className="u-microlabel">事件</span>
                <span className="val u-num">{snapshot?.diagnostics.events ?? 0}</span>
              </div>
              <div className="telemetry-pill">
                <span className="u-microlabel">RPC 管道</span>
                <span className="val" style={{ color: online ? 'var(--state-done)' : 'var(--state-failed)', fontSize: '10.5px' }}>
                  {online ? '● ONLINE WS' : '○ OFFLINE'}
                </span>
              </div>
              <Button variant="primary" size="sm" onClick={onNavigateConsole}>控制台概览</Button>
            </>
          }
        />

        <div className="chat-scroll-view">
          {convo.phase === 'loading' && (
            <div style={{ padding: '32px', textAlign: 'center', color: 'var(--text-tertiary)', fontSize: '12.5px' }}>正在折叠会话历史…</div>
          )}
          {convo.phase === 'error' && (
            <div style={{ padding: '32px', textAlign: 'center', color: 'var(--state-failed)', fontSize: '12.5px' }}>加载失败:{convo.error}</div>
          )}
          {snapshot !== undefined && activeSessionId !== undefined &&
            snapshot.items.map((item, i) => renderItem(item, `${activeSessionId}:${i}`, activeSessionId))}
          {snapshot !== undefined && snapshot.items.length === 0 && convo.phase === 'live' && (
            <div style={{ padding: '32px', textAlign: 'center', color: 'var(--text-tertiary)', fontSize: '12.5px' }}>空白会话——在下方输入第一条指令。</div>
          )}
        </div>

        <CommandDeck
          onSend={(msg) => {
            if (activeSessionId === undefined || msg.trim() === '') return;
            void sendPrompt(activeSessionId, msg);
          }}
        />
      </main>
    </div>
  );
};
