/**
 * AgosComputer /「AgOS 的电脑」右侧面板(P1-6,对标 Manus's computer)。
 *
 * 数据来源全部是既有 store,没有新增任何 fetch:
 * - conversationStore.getSnapshot(sessionId).snapshot  → fold 快照(items)
 * - swarmProgressStore.getSnapshot()                   → 运行中批次进度(复用 telemetry 轮询)
 *
 * 三个 tab 的内容都由本文件里的纯函数从快照派生(全部导出,便于单测):
 * ① 终端   selectTerminalEntries  bash/terminal 族工具的命令与输出,最新在下,自动滚到底
 * ② 文件   selectFileEntries      write/edit/read 族工具触及的文件路径去重 + 次数
 * ③ 子代理 selectSubagentBatches  本会话发起的 swarm 批次逐行(Wide Research 对位物)
 *
 * 拿不到数据就渲染一行安静的空态说明,绝不编造。
 */
import React, { useCallback, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Dot } from '@/components/ui/Dot';
import { SegmentedControl, type SegmentedOption } from '@/components/ui/SegmentedControl';
import { conversationStore, swarmProgressStore, type SwarmProgressSummary } from '@/stores/live';
import type { FoldedConversation, ToolItem } from '@/fold/model';
import '@/design-system/agos-computer.css';

/* ==========================================================================
   1. 参数解析小工具(与 chat-transcript 解耦,本文件自持,避免跨文件依赖)
   ========================================================================== */

const COMMAND_KEYS = ['command', 'cmd', 'script'] as const;
const PATH_KEYS = ['file_path', 'filePath', 'notebook_path', 'file', 'path'] as const;
const DETAIL_KEYS = ['command', 'cmd', 'file_path', 'filePath', 'file', 'pattern', 'query', 'url', 'description', 'path'] as const;

const DETAIL_MAX_CHARS = 28;
const OUTPUT_MAX_CHARS = 6000;
const COMMAND_MAX_CHARS = 2000;

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

/** 路径末段(展示用的「文件名」)。取不到返回整串。 */
export function pathTail(value: string): string {
  const segments = value.split(/[/\\]/).filter((s) => s !== '');
  const last = segments[segments.length - 1];
  return last === undefined || last === '' ? value : last;
}

/* ==========================================================================
   2. 工具分类(纯函数)
   ========================================================================== */

export type AgosToolClass = 'terminal' | 'file' | 'swarm' | 'other';

/** 工具名 → 面板归属。swarm 优先判定,避免被 exec/read 之类的子串抢走。 */
export function classifyTool(name: string): AgosToolClass {
  const n = name.toLowerCase();
  if (n.includes('swarm') || n.includes('subagent') || n.includes('fanout')) return 'swarm';
  if (n.includes('bash') || n.includes('terminal') || n.includes('shell') || n.includes('exec')) return 'terminal';
  if (n.includes('write') || n.includes('edit') || n.includes('read') || n.includes('create') || n.includes('notebook')) return 'file';
  return 'other';
}

function toolItems(snapshot: FoldedConversation | undefined): ToolItem[] {
  const out: ToolItem[] = [];
  for (const item of snapshot?.items ?? []) {
    if (item.kind === 'tool') out.push(item);
  }
  return out;
}

/* ==========================================================================
   3. header 副标题:当前正在干什么
   ========================================================================== */

export interface AgosActivity {
  toolName: string;
  /** 关键参数摘要(命令首词 / 文件名 / 查询串);取不到就是 undefined,不编造。 */
  detail: string | undefined;
}

/** 取会话里最后一个运行中的工具项。没有运行中的工具返回 undefined(header 写「空闲」)。 */
export function selectCurrentActivity(snapshot: FoldedConversation | undefined): AgosActivity | undefined {
  const tools = toolItems(snapshot);
  for (let i = tools.length - 1; i >= 0; i -= 1) {
    const tool = tools[i];
    if (tool === undefined || tool.status !== 'running') continue;
    const name = tool.name.trim();
    if (name === '') continue;
    const args = parseArgsObject(tool.argsRaw);
    const raw = args === undefined ? undefined : readStringKey(args, DETAIL_KEYS);
    let detail: string | undefined;
    if (raw !== undefined) {
      const firstLine = raw.split('\n')[0] ?? raw;
      const looksLikePath = firstLine.includes('/') && !firstLine.includes(' ');
      detail = clampChars(looksLikePath ? pathTail(firstLine) : firstLine, DETAIL_MAX_CHARS);
    }
    return { toolName: name, detail };
  }
  return undefined;
}

/** header 副标题文案。运行中写「正在用 X · Y」,否则写「空闲」。 */
export function activityLabel(activity: AgosActivity | undefined): string {
  if (activity === undefined) return '空闲';
  return activity.detail === undefined
    ? `正在用 ${activity.toolName}`
    : `正在用 ${activity.toolName} · ${activity.detail}`;
}

/* ==========================================================================
   4. tab ①:终端
   ========================================================================== */

export interface AgosTerminalEntry {
  callId: string;
  /** 命令原文(args.command / cmd);解析不到时退回原始参数串。 */
  command: string;
  /** 工具返回文本;运行中且尚无输出时是空串。 */
  output: string;
  /** 输出被截断时为 true(UI 明说,不假装完整)。 */
  truncated: boolean;
  status: ToolItem['status'];
  startAt: number;
  durationMs: number | undefined;
}

/** 该会话所有 bash/terminal 族工具,按事件顺序(最早在前,最新在后)。 */
export function selectTerminalEntries(snapshot: FoldedConversation | undefined): AgosTerminalEntry[] {
  const out: AgosTerminalEntry[] = [];
  for (const tool of toolItems(snapshot)) {
    if (classifyTool(tool.name) !== 'terminal') continue;
    const args = parseArgsObject(tool.argsRaw);
    const parsed = args === undefined ? undefined : readStringKey(args, COMMAND_KEYS);
    const command = parsed !== undefined
      ? clampChars(parsed, COMMAND_MAX_CHARS)
      : clampChars(tool.argsRaw.trim(), COMMAND_MAX_CHARS);
    const full = tool.resultText ?? '';
    out.push({
      callId: tool.callId,
      command,
      output: full.slice(0, OUTPUT_MAX_CHARS),
      truncated: full.length > OUTPUT_MAX_CHARS,
      status: tool.status,
      startAt: tool.startAt,
      durationMs: tool.endAt === undefined ? undefined : tool.endAt - tool.startAt,
    });
  }
  return out;
}

/* ==========================================================================
   5. tab ②:文件
   ========================================================================== */

export interface AgosFileEntry {
  /** 完整路径(真实参数原样)。 */
  path: string;
  /** 路径末段。 */
  tail: string;
  /** 该文件在本会话被工具触及的次数。 */
  count: number;
  /** 最近一次触及时间(排序用)。 */
  lastAt: number;
  /** 触及过该文件的工具名(去重,按首次出现顺序)。 */
  tools: string[];
}

/** 该会话所有 write/edit/read 族工具触及的文件路径,按最近触及时间倒序。 */
export function selectFileEntries(snapshot: FoldedConversation | undefined): AgosFileEntry[] {
  const map = new Map<string, AgosFileEntry>();
  for (const tool of toolItems(snapshot)) {
    if (classifyTool(tool.name) !== 'file') continue;
    const args = parseArgsObject(tool.argsRaw);
    if (args === undefined) continue;
    const path = readStringKey(args, PATH_KEYS);
    if (path === undefined) continue;
    const prev = map.get(path);
    if (prev === undefined) {
      map.set(path, { path, tail: pathTail(path), count: 1, lastAt: tool.startAt, tools: [tool.name] });
      continue;
    }
    prev.count += 1;
    prev.lastAt = Math.max(prev.lastAt, tool.startAt);
    if (!prev.tools.includes(tool.name)) prev.tools.push(tool.name);
  }
  return [...map.values()].sort((a, b) => b.lastAt - a.lastAt);
}

/* ==========================================================================
   6. tab ③:子代理(Wide Research 对位物)
   ========================================================================== */

export interface AgosSubagentBatch {
  callId: string;
  label: string;
  done: number;
  failed: number;
  total: number;
  running: boolean;
}

/**
 * 本会话的 swarm 批次。
 * 底本是 fold 快照里带 swarm 行的工具项(会话内真值,含已结清批次);
 * swarmProgressStore 只用来「刷新」callId 能对上的那些批次的实时计数,
 * 对不上的全局批次不入表(它们不属于本会话,展示出来等于编造归属)。
 */
export function selectSubagentBatches(
  snapshot: FoldedConversation | undefined,
  live: SwarmProgressSummary | undefined,
): AgosSubagentBatch[] {
  const order: string[] = [];
  const map = new Map<string, AgosSubagentBatch>();
  const sessionCallIds = new Set<string>();

  for (const tool of toolItems(snapshot)) {
    sessionCallIds.add(tool.callId);
    const rows = tool.swarm;
    if (rows === undefined || rows.length === 0) continue;
    let done = 0;
    let failed = 0;
    for (const row of rows) {
      if (row.status === 'completed') done += 1;
      else if (row.status === 'failed') failed += 1;
    }
    if (!map.has(tool.callId)) order.push(tool.callId);
    map.set(tool.callId, {
      callId: tool.callId,
      label: tool.name.trim() === '' ? tool.callId : tool.name,
      done,
      failed,
      total: rows.length,
      running: tool.status === 'running',
    });
  }

  for (const batch of live?.batches ?? []) {
    if (!sessionCallIds.has(batch.callId)) continue;
    const prev = map.get(batch.callId);
    if (prev === undefined) order.push(batch.callId);
    map.set(batch.callId, {
      callId: batch.callId,
      label: prev?.label ?? batch.label,
      done: batch.done,
      failed: batch.failed,
      total: batch.total,
      running: true,
    });
  }

  return order
    .map((id) => map.get(id))
    .filter((b): b is AgosSubagentBatch => b !== undefined);
}

/* ==========================================================================
   7. 组件
   ========================================================================== */

export type AgosComputerTab = 'terminal' | 'files' | 'subagents';

const TAB_OPTIONS: SegmentedOption<AgosComputerTab>[] = [
  { value: 'terminal', label: '终端' },
  { value: 'files', label: '文件' },
  { value: 'subagents', label: '子代理' },
];

const fmtDur = (ms: number | undefined): string =>
  ms === undefined ? '' : ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;

const CloseIcon: React.FC = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" aria-hidden>
    <line x1="6" y1="6" x2="18" y2="18" />
    <line x1="18" y1="6" x2="6" y2="18" />
  </svg>
);

const TerminalPane: React.FC<{ entries: readonly AgosTerminalEntry[] }> = ({ entries }) => {
  if (entries.length === 0) {
    return <p className="agc-empty">本会话还没有终端调用,跑过命令后这里会按时间接上。</p>;
  }
  return (
    <div className="agc-term">
      {entries.map((entry, i) => (
        <section className="agc-term-block" key={`${entry.callId}:${i}`}>
          <div className="agc-term-cmd">
            <span className="agc-term-prompt" aria-hidden>$</span>
            <span className="agc-term-cmd-text">{entry.command}</span>
          </div>
          {entry.output !== '' && <pre className="agc-term-out">{entry.output}</pre>}
          <div className="agc-term-meta">
            <Dot state={entry.status === 'running' ? 'running' : entry.status === 'failed' ? 'failed' : 'done'} size={5} />
            <span className={`agc-term-state${entry.status === 'running' ? ' is-running' : ''}`}>
              {entry.status === 'running' ? '运行中' : entry.status === 'failed' ? '未成功' : '已完成'}
            </span>
            {entry.durationMs !== undefined && <span className="u-num agc-term-dur">{fmtDur(entry.durationMs)}</span>}
            {entry.truncated && <span className="agc-term-dur">输出已截断</span>}
            {entry.output === '' && entry.status !== 'running' && <span className="agc-term-dur">无输出</span>}
          </div>
        </section>
      ))}
    </div>
  );
};

const FilesPane: React.FC<{ entries: readonly AgosFileEntry[] }> = ({ entries }) => {
  if (entries.length === 0) {
    return <p className="agc-empty">本会话还没有读写过文件,一旦有读写记录就会在这里去重列出。</p>;
  }
  return (
    <ul className="agc-files">
      {entries.map((entry) => (
        <li className="agc-file-row" key={entry.path}>
          <div className="agc-file-main">
            <div className="agc-file-tail" title={entry.path}>{entry.tail}</div>
            <div className="agc-file-path" title={entry.path}>{entry.path}</div>
          </div>
          <span className="u-num agc-file-count" title={entry.tools.join(' / ')}>{entry.count} 次</span>
        </li>
      ))}
    </ul>
  );
};

const SubagentsPane: React.FC<{ batches: readonly AgosSubagentBatch[] }> = ({ batches }) => {
  if (batches.length === 0) {
    return <p className="agc-empty">本会话没有分发过子代理批次,派活之后这里会逐批列出进度。</p>;
  }
  return (
    <table className="agc-table">
      <thead>
        <tr>
          <th scope="col">名称</th>
          <th scope="col">进度</th>
          <th scope="col">失败</th>
        </tr>
      </thead>
      <tbody>
        {batches.map((batch) => {
          const pct = batch.total === 0 ? 0 : Math.round((batch.done / batch.total) * 100);
          return (
            <tr className={batch.running ? 'is-running' : ''} key={batch.callId}>
              <td>
                <div className="agc-batch-name" title={batch.callId}>{batch.label}</div>
                <div className="u-num agc-batch-id">{batch.callId.slice(-8)}</div>
              </td>
              <td className="agc-cell-progress">
                <span className="u-num agc-batch-count">{batch.done}·{batch.total}</span>
                <span className="agc-meter" role="presentation">
                  <span className="agc-meter-fill" style={{ width: `${pct}%` }} />
                </span>
              </td>
              <td className={`u-num agc-cell-failed${batch.failed > 0 ? ' is-hot' : ''}`}>{batch.failed}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
};

export const AgosComputer: React.FC<{
  sessionId: string | undefined;
  onClose: () => void;
}> = ({ sessionId, onClose }) => {
  const [tab, setTab] = useState<AgosComputerTab>('terminal');
  const bodyRef = useRef<HTMLDivElement | null>(null);

  const convo = useSyncExternalStore(
    conversationStore.subscribe,
    useCallback(() => conversationStore.getSnapshot(sessionId), [sessionId]),
  );
  const live = useSyncExternalStore(swarmProgressStore.subscribe, swarmProgressStore.getSnapshot);
  const snapshot = convo.snapshot;

  const activity = useMemo(() => selectCurrentActivity(snapshot), [snapshot]);
  const terminal = useMemo(() => selectTerminalEntries(snapshot), [snapshot]);
  const files = useMemo(() => selectFileEntries(snapshot), [snapshot]);
  const batches = useMemo(() => selectSubagentBatches(snapshot, live), [snapshot, live]);

  // 终端语义:最新在下,内容增长时贴底。签名把流式增量也算进去。
  const termSignature = useMemo(
    () => terminal.reduce((n, e) => n + e.output.length + e.command.length, terminal.length),
    [terminal],
  );

  useLayoutEffect(() => {
    if (tab !== 'terminal') return;
    const el = bodyRef.current;
    if (el === null) return;
    el.scrollTop = el.scrollHeight;
  }, [tab, sessionId, termSignature]);

  // 切会话 / 切 tab 时,非终端 tab 回到顶部。
  useLayoutEffect(() => {
    if (tab === 'terminal') return;
    const el = bodyRef.current;
    if (el === null) return;
    el.scrollTop = 0;
  }, [tab, sessionId]);

  const label = activityLabel(activity);

  return (
    <aside className="agc" aria-label="AgOS 的电脑">
      <header className="agc-head">
        <div className="agc-head-text">
          <h2 className="agc-title">AgOS 的电脑</h2>
          <p className={`agc-status${activity !== undefined ? ' is-running' : ''}`} title={label} aria-live="polite">
            {label}
          </p>
        </div>
        <button type="button" className="agc-close" onClick={onClose} aria-label="收起 AgOS 的电脑">
          <CloseIcon />
        </button>
      </header>

      <div className="agc-tabs">
        <SegmentedControl options={TAB_OPTIONS} value={tab} onChange={setTab} />
      </div>

      <div className="agc-body" ref={bodyRef}>
        {tab === 'terminal' && <TerminalPane entries={terminal} />}
        {tab === 'files' && <FilesPane entries={files} />}
        {tab === 'subagents' && <SubagentsPane batches={batches} />}
      </div>
    </aside>
  );
};
