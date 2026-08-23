/**
 * LiveTranscript —— 真会话对话流(fold 驱动)。
 * V2 重设计时展示 mock 覆盖了真渲染(P0 退化),本组件把 ee475dc 的接线
 * 以独立组件形式嫁接回来:ChatPage 在有真后端时渲染本组件,无后端时保留
 * Gemini 的展示 mock 作为 demo 态。
 *
 * P0-3:连续的通用工具调用折叠成 Kimi 式时间线(ToolTimelineGroup),
 * 特化卡(TerminalCard / SwarmBatchCard / ApprovalPanel)保持卡形不动。
 *
 * P1-7:可选 prop `replayLimit` 做纯渲染层截断(fold 与 store 都不动),
 * 供 <ReplayScrubber> 回放;不传时行为与之前完全一致。
 * P1-8:会话完结时在流末给出「✓ 任务完成」+ 本轮真实产出的文件卡。
 */
import React, { useCallback, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Dot } from '@/components/ui/Dot';
import { Chip } from '@/components/ui/Chip';
import { ReasoningBlock } from '@/components/chat/ReasoningBlock';
import { TerminalCard } from '@/components/ui/TerminalCard';
import { SwarmBatchCard } from '@/components/chat/SwarmBatchCard';
import { ApprovalPanel } from '@/components/chat/ApprovalPanel';
import { TodoBar } from '@/components/chat/TodoBar';
import type { StateLamp } from '@/design-system/tokens';
import { agos, approvalRpc, conversationStore } from '@/stores/live';
import type { ConversationItem, FoldedConversation, ToolItem } from '@/fold/model';
import { RpcId } from '@/contract/api/rpc';
import type { OptimisticImageAttachment } from '@/components/chat/ImageAttachments';
import { extractMultimodalMessageId, stripImagePlaceholder, stripMultimodalMessageMarker } from '@/components/chat/CommandDeck';
import { MediaBlocks } from '@/components/chat/MediaBlocks';
import { mediaFromResultBlocks, mediaFromTool } from '@/components/chat/media-blocks';
import { EMPTY_YOLO, describeYoloDecision, groupYoloByCallId, parseYoloDecisionsPayload, yoloDecisionsUrl, yoloVerdictText, type YoloDecision, type YoloDecisionsPayload } from '@/components/chat/yolo-decisions';
import { fetchJsonResource, useResource } from '@/lib/useResource';
import '@/design-system/tool-timeline.css';
import '@/design-system/replay-scrubber.css';

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

const ToolTimelineRow: React.FC<{ tool: ToolItem, sessionId: string, yolo?: readonly YoloDecision[] }> = ({ tool, sessionId, yolo }) => {
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
  /* W2:产物媒体(图片/音频)不进折叠体,直接在行下常驻可见 —— 播放器/图片是结果本体。 */
  const mediaRefs = mediaFromTool(tool);

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
        <YoloChip rows={yolo} />
        {duration !== undefined && <span className="tl-dur u-num">{duration}</span>}
        <ChevronIcon />
      </button>
      {mediaRefs.length > 0 && (
        <div style={{ padding: '2px 12px 8px 36px' }}>
          <MediaBlocks refs={mediaRefs} sessionId={sessionId} />
        </div>
      )}
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

/** W11:权限裁决注解。台账行按 callId 挂到工具卡;同 callId 多行取最新。不是新事件,只是注解。 */
const YoloChip: React.FC<{ rows: readonly YoloDecision[] | undefined }> = ({ rows }) => {
  const last = rows?.at(-1);
  if (last === undefined) return null;
  const d = describeYoloDecision(last);
  return (
    <Chip variant={d.kind === 'delegate' ? 'amber' : last.outcome === 'rejected' ? 'red' : 'default'} style={{ marginLeft: '6px' }} data-yolo={d.kind}>
      {yoloVerdictText(last)}
    </Chip>
  );
};

const ToolTimelineGroup: React.FC<{ tools: readonly ToolItem[], keyPrefix: string, sessionId: string, yoloByCallId?: ReadonlyMap<string, YoloDecision[]> }> = ({ tools, keyPrefix, sessionId, yoloByCallId = EMPTY_YOLO }) => (
  <div className="tl-group">
    {tools.map((tool, i) => (
      <ToolTimelineRow key={`${keyPrefix}:${i}:${tool.callId}`} tool={tool} sessionId={sessionId} yolo={yoloByCallId.get(tool.callId)} />
    ))}
  </div>
);

/** 通用工具行(非 swarm、非 bash 特化卡)——这些才进时间线。 */
function isGenericToolItem(item: ConversationItem | undefined): item is ToolItem {
  if (item === undefined || item.kind !== 'tool') return false;
  if (item.swarm !== undefined && item.swarm.length > 0) return false;
  return item.name !== 'bash';
}

/* ==========================================================================
   P1-8 交付物语法:完结判定 + 本轮产出文件(纯函数,可测)
   ========================================================================== */

/** 会写文件的工具名特征。语料实测的真实工具名:write / edit(todo_write 是待办不是文件)。 */
const WRITE_TOOL_HINTS = ['write', 'edit', 'create', 'patch'] as const;

/** 是否为写文件类工具。todo_write / read / search 明确排除。 */
export function isFileWriteTool(name: string): boolean {
  const n = name.toLowerCase();
  if (n.includes('todo') || n.includes('read') || n.includes('search')) return false;
  return WRITE_TOOL_HINTS.some((hint) => n.includes(hint));
}

/** 写文件类工具的真实目标路径;不是写工具、参数解析不出路径,一律 undefined(禁止编造)。 */
export function writtenFilePath(source: ToolTitleSource): string | undefined {
  if (!isFileWriteTool(source.name)) return undefined;
  const args = parseArgsObject(source.argsRaw);
  if (args === undefined) return undefined;
  return readStringKey(args, PATH_KEYS);
}

export interface DeliverableSummary {
  /** 完结轮次(取自最后一条 assistant 的 turn)。 */
  readonly turn: number;
  /** 本轮 write/edit 类工具真实写入的路径,按首次出现去重排序;可能为空数组。 */
  readonly files: readonly string[];
}

/**
 * 完结判定:最后一条条目是「已收尾、有正文」的 assistant,且没有任何运行中的工具。
 * 满足才返回摘要;其余情况(仍在流式 / 末尾是工具或待决审批 / 空会话)一律 undefined。
 * 文件清单按 turn 收窄到本轮——语料实测同一会话可跨 80+ 轮写 81 个文件,
 * 不收窄会把整个会话的历史产出都倒在最后一轮下面。
 */
export function deriveDeliverables(items: readonly ConversationItem[]): DeliverableSummary | undefined {
  const last = items[items.length - 1];
  if (last === undefined || last.kind !== 'assistant') return undefined;
  if (last.streaming || last.text.trim() === '') return undefined;
  for (const item of items) {
    if (item.kind === 'tool' && item.status === 'running') return undefined;
  }
  const files: string[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    if (item.kind !== 'tool' || item.turn !== last.turn || item.status !== 'done') continue;
    const path = writtenFilePath(item);
    if (path === undefined || seen.has(path)) continue;
    seen.add(path);
    files.push(path);
  }
  return { turn: last.turn, files };
}

const CheckIcon: React.FC = () => (
  <svg className="dl-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <polyline points="4 12.5 9.5 18 20 6.5" />
  </svg>
);

const FileIcon: React.FC = () => (
  <svg className="dl-file-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
    <polyline points="14 3 14 8 19 8" />
  </svg>
);

const DeliverableBlock: React.FC<{
  summary: DeliverableSummary;
  onOpenFile?: (path: string) => void;
}> = ({ summary, onOpenFile }) => (
  <div className="message-wrap">
    <div className="dl-block">
      <div className="dl-done">
        <CheckIcon />
        <span>任务完成</span>
      </div>
      {summary.files.length > 0 && (
        <div className="dl-files" aria-label={`本轮产出文件 ${summary.files.length} 个`}>
          {summary.files.map((path) => {
            const name = pathTail(path) ?? path;
            const inner = (
              <>
                <FileIcon />
                <span className="dl-file-text">
                  <span className="dl-file-name">{name}</span>
                  <span className="dl-file-path">{path}</span>
                </span>
              </>
            );
            return onOpenFile === undefined
              ? <div className="dl-file" key={path} title={path}>{inner}</div>
              : (
                <button type="button" className="dl-file" key={path} title={`打开 ${path}`} onClick={() => onOpenFile(path)}>
                  {inner}
                </button>
              );
          })}
        </div>
      )}
    </div>
  </div>
);

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
  readOnly = false,
  yoloByCallId: ReadonlyMap<string, YoloDecision[]> = EMPTY_YOLO,
): React.ReactNode {
  if (item.kind === 'user') {
    if (item.sourceKind !== 'user') return null;
    /* W1+W5:用户消息里的图片块(attachment 引用)真渲染;有真图时收起 [图片 ×N] 占位。 */
    const userMedia = mediaFromResultBlocks(item.blocks);
    const hasRealImages = userMedia.some((m) => m.kind === 'image');
    const displayText = stripMultimodalMessageMarker(hasRealImages ? stripImagePlaceholder(item.text) : item.text);
    return (
      <div className="message-wrap" key={key}>
        <div className="message-user">
          <div className="message-user-header">
            <span style={{ fontWeight: 700, fontSize: '12.5px' }}>Leo</span>
            <span className="u-num" style={{ fontSize: '11px', color: 'var(--text-tertiary)' }}>
              {item.at > 0 ? new Date(item.at).toLocaleTimeString('zh-CN', { hour12: false }) : ''}
            </span>
          </div>
          {displayText !== '' && (
            <div style={{ fontSize: '14.5px', lineHeight: 1.7, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{displayText}</div>
          )}
          {userMedia.length > 0 && <MediaBlocks refs={userMedia} sessionId={sessionId} />}
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
                thinking={thinking}
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
      const judged = yoloByCallId.get(item.callId);
      return (
        <div className="message-wrap tl-enter" key={key}>
          {judged !== undefined && judged.length > 0 && (
            <div style={{ marginBottom: '4px', fontSize: '12px' }}><YoloChip rows={judged} /></div>
          )}
          <TerminalCard
            title="bash_exec"
            command={parseBashCommand(item.argsRaw)}
            output={(item.resultText ?? (item.status === 'running' ? '(运行中…)' : '')).slice(0, 8000)}
            duration={fmtDur(item.endAt !== undefined ? item.endAt - item.startAt : undefined)}
            running={item.status === 'running'}
            exitCode={item.status === 'running' ? undefined : item.status === 'failed' ? 1 : 0}
          />
        </div>
      );
    }
    return (
      <div className="message-wrap tl-enter" key={key}>
        <ToolTimelineGroup tools={[item]} keyPrefix={key} sessionId={sessionId} yoloByCallId={yoloByCallId} />
      </div>
    );
  }
  // approval
  if (item.outcome !== undefined) {
    // W11:有裁决行就说清「谁拒的、为什么」;没有就维持事件流里的结果,不发明。
    const judged = item.callId !== undefined ? yoloByCallId.get(item.callId)?.at(-1) : undefined;
    const verdict = judged === undefined ? undefined : describeYoloDecision(judged);
    return (
      <div className="message-wrap tl-enter" key={key}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '8px 12px', borderRadius: '8px', border: '1px solid var(--border-subtle)', fontSize: '12px', color: 'var(--text-secondary)' }}>
          <Dot state={item.outcome === 'rejected' ? 'failed' : 'done'} size={6} />
          <span data-yolo={verdict?.kind}>
            审批 {item.toolName ?? ''}:{item.outcome === 'allowed-once' ? '已放行(一次)' : item.outcome}
            {judged !== undefined ? ` · ${yoloVerdictText(judged)}` : ''}
          </span>
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
        readOnly={readOnly}
        onAllow={readOnly ? undefined : () => respond('allowed-once')}
        onReject={readOnly ? undefined : () => respond('rejected')}
      />
    </div>
  );
}

/** 会话已折叠出的条目总数(<ReplayScrubber total> 的数据源)。会话未打开时为 0。 */
export function useTranscriptItemCount(sessionId: string): number {
  const convo = useSyncExternalStore(
    conversationStore.subscribe,
    useCallback(() => conversationStore.getSnapshot(sessionId), [sessionId]),
  );
  return convo.snapshot?.items.length ?? 0;
}

export interface LiveTranscriptProps {
  sessionId: string;
  optimisticImageMessages?: readonly OptimisticImageMessage[];
  /** P1-7 回放:只渲染 items 的前 N 项。undefined = 全量(与改造前完全一致)。 */
  replayLimit?: number;
  /** P1-8:点击产出文件卡。不传则文件卡不可点。 */
  onOpenFile?: (path: string) => void;
  /** 远端 fold 快照。显式传 undefined 仍表示远端尚无轨迹，不可回退读本机会话。 */
  snapshotOverride?: FoldedConversation;
  /** 远端 run 没有 approval respond 通道。 */
  readOnly?: boolean;
}

/** 区分「没有 override」与「远端明确尚无 snapshot」。继承属性不算调用契约。 */
export function hasSnapshotOverride(props: LiveTranscriptProps): boolean {
  return Object.hasOwn(props, 'snapshotOverride');
}

interface TranscriptBodyProps extends LiveTranscriptProps {
  snapshot: FoldedConversation | undefined;
  phase: 'idle' | 'loading' | 'live' | 'error';
  error: string | undefined;
  /** W11 权限裁决注解(按 callId)。远端/回放不传 → 空 Map,渲染逐字节不变。 */
  yoloByCallId?: ReadonlyMap<string, YoloDecision[]>;
}

/** 纯渲染体：远端与本地共用，不订阅任何 store。 */
export const TranscriptBody: React.FC<TranscriptBodyProps> = ({
  sessionId,
  optimisticImageMessages = [],
  replayLimit,
  onOpenFile,
  snapshot,
  phase,
  error,
  readOnly = false,
  yoloByCallId = EMPTY_YOLO,
}) => {
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
  /* P1-7:纯渲染层截断。replayLimit 为 undefined 时 visibleCount === items.length,
     下面每一处边界都退化成原来的 items.length,行为逐字节一致。 */
  const visibleCount = replayLimit === undefined || !Number.isFinite(replayLimit)
    ? items.length
    : Math.max(0, Math.min(Math.floor(replayLimit), items.length));
  const isReplaying = visibleCount < items.length;
  const renderedItems: React.ReactNode[] = [];
  for (let index = 0; index < visibleCount; index += 1) {
    const item = items[index];
    if (isGenericToolItem(item)) {
      // 连续的通用工具调用合并成一条时间线(虚线连接、首尾不越界)。
      const run: ToolItem[] = [];
      let end = index;
      while (end < visibleCount) {
        const next = items[end];
        if (!isGenericToolItem(next)) break;
        run.push(next);
        end += 1;
      }
      renderedItems.push(
        <div className="message-wrap tl-enter" key={`${sessionId}:${index}:timeline`}>
          <ToolTimelineGroup tools={run} keyPrefix={`${sessionId}:${index}`} sessionId={sessionId} yoloByCallId={yoloByCallId} />
        </div>,
      );
      index = end - 1;
      continue;
    }
    if (item === undefined) continue;
    renderedItems.push(renderItem(item, `${sessionId}:${index}`, sessionId, imagesByItemIndex.get(index) ?? [], readOnly, yoloByCallId));
  }
  /* 回卷到历史某一步时,「发送中」的乐观气泡属于未来,不该出现在回放里。 */
  const pendingLocalMessages = isReplaying
    ? []
    : localMessages.filter((message) => !matchedLocalIds.has(message.id));
  /* P1-8:完结区按「可见条目」判定——回卷时自动消失,播回最新才重新出现。
     有待同步的乐观消息 = 新一轮已经开始,这一轮不算完结。 */
  const visibleItems = visibleCount === items.length ? items : items.slice(0, visibleCount);
  const deliverables = pendingLocalMessages.length > 0 ? undefined : deriveDeliverables(visibleItems);
  return (
    <>
      {phase === 'loading' && (
        <div style={{ padding: '32px', textAlign: 'center', color: 'var(--text-tertiary)', fontSize: '12.5px' }}>正在折叠会话历史…</div>
      )}
      {phase === 'error' && (
        <div style={{ padding: '32px', textAlign: 'center', color: 'var(--state-failed)', fontSize: '12.5px' }}>加载失败:{error}</div>
      )}
      {snapshot !== undefined && snapshot.todos.length > 0 && (
        <div className="message-wrap"><TodoBar todos={snapshot.todos.map((t) => ({ content: t.content, status: t.status as 'completed' | 'in_progress' | 'pending' }))} /></div>
      )}
      {renderedItems}
      {deliverables !== undefined && (
        <DeliverableBlock summary={deliverables} onOpenFile={onOpenFile} />
      )}
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
      {snapshot !== undefined && snapshot.items.length === 0 && phase === 'live' && (
        <div style={{ padding: '32px', textAlign: 'center', color: 'var(--text-tertiary)', fontSize: '12.5px' }}>
          {readOnly ? '远端轨迹目前没有可显示的对话条目。' : '空白会话——在下方输入第一条指令。'}
        </div>
      )}
    </>
  );
};

/** 本机会话订阅壳。hook 始终在自己的组件里调用，override 切换不会改变 hook 顺序。 */
const fetchYolo = async (url: string, signal: AbortSignal): Promise<YoloDecisionsPayload> =>
  parseYoloDecisionsPayload(await fetchJsonResource<unknown>(url, signal));

export const SubscribedTranscript: React.FC<LiveTranscriptProps> = (props) => {
  const { sessionId } = props;
  const convo = useSyncExternalStore(
    conversationStore.subscribe,
    useCallback(() => conversationStore.getSnapshot(sessionId), [sessionId]),
  );
  // W11:裁决台账只读 GET;不轮询(裁决只在审批时刻产生),条目数变了刷一次。
  const yolo = useResource<YoloDecisionsPayload>({ url: sessionId.trim() !== '' ? yoloDecisionsUrl(sessionId) : null, fetcher: fetchYolo, refreshOnFocus: true });
  // 裁决行写在 approval/decided 时刻,decided 不改条目数——用「已决审批数」当触发器。
  const decidedCount = convo.snapshot?.items.filter((i) => i.kind === 'approval' && i.outcome !== undefined).length ?? 0;
  const refresh = yolo.refresh;
  useLayoutEffect(() => { if (decidedCount > 0) refresh(); }, [decidedCount, refresh]);
  const yoloByCallId = useMemo(() => groupYoloByCallId(yolo.data?.items ?? []), [yolo.data]);
  return (
    <TranscriptBody
      {...props}
      snapshot={convo.snapshot}
      phase={convo.phase}
      error={convo.error}
      yoloByCallId={yoloByCallId}
    />
  );
};

export const LiveTranscript: React.FC<LiveTranscriptProps> = (props) => (
  hasSnapshotOverride(props)
    ? (
      <TranscriptBody
        {...props}
        snapshot={props.snapshotOverride}
        phase="live"
        error={undefined}
      />
    )
    : <SubscribedTranscript {...props} />
);
