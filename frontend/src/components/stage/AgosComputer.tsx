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
import { conversationStore, swarmProgressStore } from '@/stores/live';
import {
  activityLabel,
  selectCurrentActivity,
  selectFileEntries,
  selectSubagentBatches,
  selectTerminalEntries,
  type AgosFileEntry,
  type AgosSubagentBatch,
  type AgosTerminalEntry,
} from './agos-computer-model';
import '@/design-system/agos-computer.css';

export * from './agos-computer-model';

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
