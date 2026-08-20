/**
 * LiveTranscript —— 真会话对话流(fold 驱动)。
 * V2 重设计时展示 mock 覆盖了真渲染(P0 退化),本组件把 ee475dc 的接线
 * 以独立组件形式嫁接回来:ChatPage 在有真后端时渲染本组件,无后端时保留
 * Gemini 的展示 mock 作为 demo 态。
 *
 * P0-3:连续的通用工具调用折叠成 Kimi 式时间线(ToolTimelineGroup),
 * 特化卡(TerminalCard / SwarmBatchCard / ApprovalPanel)保持卡形不动。
 */
import React, { useCallback, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
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
import '@/design-system/tool-timeline.css';

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

/* ==========================================================================
   P0-3 工具行时间线:图标映射 + 标题生成(纯函数,可测)
   ========================================================================== */

export type ToolIconKind = 'terminal' | 'pencil' | 'doc' | 'search' | 'globe' | 'dot';

/** 工具名 → 语义图标。纯函数,便于测试。 */
export function toolIconKind(name: string): ToolIconKind {
  const n = name.toLowerCase();
  if (n.includes('bash') || n.includes('terminal') || n.includes('shell')) return 'terminal';
  if (n.includes('edit') || n.includes('write') || n.includes('create')) return 'pencil';
  if (n.includes('read') || n.includes('cat')) return 'doc';
  if (n.includes('search') || n.includes('grep') || n.includes('glob')) return 'search';
  if (n.includes('web') || n.includes('fetch')) return 'globe';
  return 'dot';
}

/** 标题生成的最小输入。ToolItem 结构上兼容(label/title 为可选)。 */
export interface ToolTitleSource {
  readonly name: string;
  readonly argsRaw: string;
  /** 事件自带的现成标题(当前 fold 模型未提供,留作前向兼容)。 */
  readonly label?: string;
  readonly title?: string;
}

const SUMMARY_MAX_CHARS = 24;
const LABEL_KEYS = ['label', 'title'] as const;
const COMMAND_KEYS = ['command', 'cmd'] as const;
const PATH_KEYS = ['file_path', 'filePath', 'notebook_path', 'file'] as const;
const QUERY_KEYS = ['pattern', 'query', 'q'] as const;
/** 泛化的 path 排在 pattern 之后:grep/glob 的 path 是搜索根,pattern 才是关键参数。 */
const DIR_KEYS = ['path', 'dir', 'cwd'] as const;
const URL_KEYS = ['url', 'uri'] as const;
const TEXT_KEYS = ['description', 'prompt', 'subagent_type'] as const;

function clampChars(text: string, max: number): string {
  const chars = Array.from(text);
  if (chars.length <= max) return text;
  return `${chars.slice(0, max - 1).join('')}…`;
}

function parseArgsObject(argsRaw: string): Record<string, unknown> | undefined {
  const trimmed = argsRaw.trim();
  if (trimmed === '') return undefined;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
    return parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function readStringKey(args: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = args[key];
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (trimmed !== '') return trimmed;
  }
  return undefined;
}

function pathTail(value: string): string | undefined {
  const segments = value.split(/[/\\]/).filter((s) => s !== '');
  return segments.length > 0 ? segments[segments.length - 1] : undefined;
}

/** 从真实参数里挑一段可读摘要:命令首词 / 路径末段 / 查询串。取不到返回 undefined(禁止编造)。 */
function argsSummary(args: Record<string, unknown>): string | undefined {
  const command = readStringKey(args, COMMAND_KEYS);
  if (command !== undefined) {
    const head = command.split(/\s+/)[0];
    if (head !== undefined && head !== '') return clampChars(head, SUMMARY_MAX_CHARS);
  }
  const path = readStringKey(args, PATH_KEYS);
  if (path !== undefined) {
    const tail = pathTail(path);
    if (tail !== undefined) return clampChars(tail, SUMMARY_MAX_CHARS);
  }
  const query = readStringKey(args, QUERY_KEYS);
  if (query !== undefined) return clampChars(query, SUMMARY_MAX_CHARS);
  const dir = readStringKey(args, DIR_KEYS);
  if (dir !== undefined) {
    const tail = pathTail(dir);
    if (tail !== undefined) return clampChars(tail, SUMMARY_MAX_CHARS);
  }
  const url = readStringKey(args, URL_KEYS);
  if (url !== undefined) return clampChars(url.replace(/^https?:\/\//, ''), SUMMARY_MAX_CHARS);
  const text = readStringKey(args, TEXT_KEYS);
  if (text !== undefined) return clampChars(text.split('\n')[0] ?? text, SUMMARY_MAX_CHARS);
  return undefined;
}

/**
 * 工具行语义标题。优先用事件自带 label/title,否则「工具名 · 关键参数摘要(≤24 字)」;
 * 参数里取不到东西就只显示工具名。全部取自真实字段,不生成任何虚构文案。
 */
export function toolRowTitle(source: ToolTitleSource): string {
  const direct = [source.label, source.title]
    .find((v) => typeof v === 'string' && v.trim() !== '');
  if (direct !== undefined) return clampChars(direct.trim(), 48);

  const args = parseArgsObject(source.argsRaw);
  if (args !== undefined) {
    const labelled = readStringKey(args, LABEL_KEYS);
    if (labelled !== undefined) return clampChars(labelled, 48);
  }

  const name = source.name.trim();
  if (name === '') return '(工具)';
  const summary = args === undefined ? undefined : argsSummary(args);
  return summary === undefined ? name : `${name} · ${summary}`;
}

const ToolIcon: React.FC<{ kind: ToolIconKind }> = ({ kind }) => {
  const common = {
    width: 16,
    height: 16,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.5,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
  };
  if (kind === 'terminal') {
    return (
      <svg {...common}>
        <rect x="3" y="4" width="18" height="16" rx="2" />
        <polyline points="7.5 9.5 10.5 12 7.5 14.5" />
        <line x1="13" y1="15" x2="17" y2="15" />
      </svg>
    );
  }
  if (kind === 'pencil') {
    return (
      <svg {...common}>
        <path d="M12 20h9" />
        <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7.5 18.5 3.5 19.5l1-4z" />
      </svg>
    );
  }
  if (kind === 'doc') {
    return (
      <svg {...common}>
        <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
        <polyline points="14 3 14 8 19 8" />
      </svg>
    );
  }
  if (kind === 'search') {
    return (
      <svg {...common}>
        <circle cx="11" cy="11" r="6.5" />
        <line x1="16" y1="16" x2="20.5" y2="20.5" />
      </svg>
    );
  }
  if (kind === 'globe') {
    return (
      <svg {...common}>
        <circle cx="12" cy="12" r="8.5" />
        <line x1="3.5" y1="12" x2="20.5" y2="12" />
        <path d="M12 3.5a13 13 0 0 1 0 17a13 13 0 0 1 0-17z" />
      </svg>
    );
  }
  return (
    <svg {...common}>
      <circle cx="12" cy="12" r="4" />
    </svg>
  );
};

const ChevronIcon: React.FC = () => (
  <svg
    className="tl-chevron"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.5}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden
  >
    <polyline points="9 5 16 12 9 19" />
  </svg>
);

const RESPONSE_LINE_LIMIT = 40;
const TEXT_HARD_CAP = 8000;

function prettyArgs(argsRaw: string): string {
  const trimmed = argsRaw.trim();
  if (trimmed === '') return '';
  try {
    return JSON.stringify(JSON.parse(trimmed) as unknown, null, 2).slice(0, TEXT_HARD_CAP);
  } catch {
    return trimmed.slice(0, TEXT_HARD_CAP);
  }
}

const ToolTimelineRow: React.FC<{ tool: ToolItem }> = ({ tool }) => {
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [bodyHeight, setBodyHeight] = useState(0);
  const innerRef = useRef<HTMLDivElement | null>(null);

  const st = TOOL_STATE[tool.status];
  const title = toolRowTitle(tool);
  const requestText = prettyArgs(tool.argsRaw);
  const responseText = (tool.resultText ?? '').slice(0, TEXT_HARD_CAP);
  const responseLines = responseText === '' ? [] : responseText.split('\n');
  const overflowing = responseLines.length > RESPONSE_LINE_LIMIT;
  const shownResponse = overflowing && !showAll
    ? responseLines.slice(0, RESPONSE_LINE_LIMIT).join('\n')
    : responseText;
  const duration = tool.endAt !== undefined ? fmtDur(tool.endAt - tool.startAt) : undefined;

  useLayoutEffect(() => {
    if (!open) return;
    const el = innerRef.current;
    if (el === null) return;
    setBodyHeight(el.scrollHeight);
  }, [open, showAll, requestText, shownResponse]);

  const toggle = (): void => {
    setMounted(true);
    setOpen((v) => !v);
  };

  const stateClass = tool.status === 'running' ? ' is-running' : tool.status === 'failed' ? ' is-failed' : ' is-done';

  return (
    <div className={`tl-item${stateClass}${open ? ' is-open' : ''}`}>
      <button
        type="button"
        className="tl-row"
        onClick={toggle}
        aria-expanded={open}
        aria-label={`${title}(${st.label})`}
        title={st.label}
      >
        <span className="tl-icon"><ToolIcon kind={toolIconKind(tool.name)} /></span>
        <span className="tl-title">{title}</span>
        {duration !== undefined && <span className="tl-dur u-num">{duration}</span>}
        <ChevronIcon />
      </button>
      <div className="tl-body" style={{ height: open ? `${bodyHeight}px` : 0 }}>
        {mounted && (
          <div className="tl-body-inner" ref={innerRef}>
            {requestText !== '' && (
              <div className="tl-card">
                <span className="tl-card-label">Request</span>
                <pre className="tl-pre">{requestText}</pre>
              </div>
            )}
            {responseText !== '' && (
              <div className="tl-card">
                <span className="tl-card-label">Response</span>
                <pre className="tl-pre">{shownResponse}</pre>
                {overflowing && !showAll && (
                  <button type="button" className="tl-more" onClick={() => setShowAll(true)}>
                    展开全部({responseLines.length} 行)
                  </button>
                )}
              </div>
            )}
            {requestText === '' && responseText === '' && (
              <div className="tl-empty">
                {tool.status === 'running' ? '运行中,暂无输出。' : '本次调用没有参数与返回内容。'}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

const ToolTimelineGroup: React.FC<{ tools: readonly ToolItem[], keyPrefix: string }> = ({ tools, keyPrefix }) => (
  <div className="tl-group">
    {tools.map((tool, i) => (
      <ToolTimelineRow key={`${keyPrefix}:${i}:${tool.callId}`} tool={tool} />
    ))}
  </div>
);

/** 通用工具行(非 swarm、非 bash 特化卡)——这些才进时间线。 */
function isGenericToolItem(item: ConversationItem | undefined): item is ToolItem {
  if (item === undefined || item.kind !== 'tool') return false;
  if (item.swarm !== undefined && item.swarm.length > 0) return false;
  return item.name !== 'bash';
}

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
    const thinking = item.streaming && item.text === '';
    return (
      <div className="message-wrap" key={key}>
        <div className="message-assistant">
          <div className="assistant-meta">
            <span style={{ fontWeight: 700, color: 'var(--state-running)', fontSize: '12px' }}>AgOS Agent</span>
            {item.model !== undefined && (<><span>·</span><Chip>{item.provider !== undefined ? `${item.provider}/${item.model}` : item.model}</Chip></>)}
            {item.streaming && (<><span>·</span><span className="u-num" style={{ color: 'var(--state-running)', fontSize: '11px' }}>流式中…</span></>)}
          </div>
          {item.reasoning !== '' && (
            <div className={`tl-reasoning${thinking ? ' is-thinking' : ''}`}>
              <ReasoningBlock
                duration=""
                tokens={`${item.reasoning.length} chars`}
                title={thinking ? '思考中…' : '思考已完成'}
              >
                <span style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{item.reasoning}</span>
              </ReasoningBlock>
            </div>
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
        <div className="message-wrap tl-enter" key={key}>
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
        <div className="message-wrap tl-enter" key={key}>
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
    return (
      <div className="message-wrap tl-enter" key={key}>
        <ToolTimelineGroup tools={[item]} keyPrefix={key} />
      </div>
    );
  }
  // approval
  if (item.outcome !== undefined) {
    return (
      <div className="message-wrap tl-enter" key={key}>
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
    <div className="message-wrap tl-enter" key={key}>
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
  const items: readonly ConversationItem[] = snapshot?.items ?? [];
  const renderedItems: React.ReactNode[] = [];
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (isGenericToolItem(item)) {
      // 连续的通用工具调用合并成一条时间线(虚线连接、首尾不越界)。
      const run: ToolItem[] = [];
      let end = index;
      while (end < items.length) {
        const next = items[end];
        if (!isGenericToolItem(next)) break;
        run.push(next);
        end += 1;
      }
      renderedItems.push(
        <div className="message-wrap tl-enter" key={`${sessionId}:${index}:timeline`}>
          <ToolTimelineGroup tools={run} keyPrefix={`${sessionId}:${index}`} />
        </div>,
      );
      index = end - 1;
      continue;
    }
    if (item === undefined) continue;
    renderedItems.push(renderItem(item, `${sessionId}:${index}`, sessionId, imagesByItemIndex.get(index) ?? []));
  }
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
