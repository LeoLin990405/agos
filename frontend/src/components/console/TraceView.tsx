import React, { useEffect, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { TRACE_JOIN_COPY, TRACE_JOIN_COUNT_COPY, traceJoinId } from './trace-join';

/** 轨迹视图(把 dsh-trace-view 的时间流带回自有前端):/api/trace/sessions 真数据,
 *  每会话一行 LLM/工具耗时堆叠条 + 轮次/步数,一眼读出时间去哪了。 */
interface TraceRow {
  /**
   * 权威会话 id(带 `session-` 前缀)。载荷里本来就有,此前被解析丢弃。
   * 依据是磁盘名册:~/.dsh/sessions/--Users-leo--/ 下的目录就叫 `session-<uuid>`,
   * session.list 也按这个形态发号。
   * ⚠️ 不要拿 session-memory 的 status 当依据 —— 它只反映有没有写过记忆文档
   * (dsh-agos/lib/session-memory.mjs:470),与 id 形态无关;实测带前缀的真会话
   * session-fa1de48… 打回来也是 'empty'(2026-08-22 验收 P2)。
   */
  rawId: string;
  id: string;
  title: string;
  createdAt: number;
  cwd: string;
  model: string;
  turns: number;
  steps: number;
  llmMs: number;
  toolMs: number;
}

const fmtMs = (ms: number): string =>
  ms <= 0 ? '0s' : ms < 1000 ? `${ms}ms` : ms < 60_000 ? `${(ms / 1000).toFixed(1)}s` : `${(ms / 60_000).toFixed(1)}m`;

export const TraceView: React.FC<{ onSelectSession?: (id: string) => void }> = ({ onSelectSession }) => {
  const [rows, setRows] = useState<TraceRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  /**
   * 对话页的守卫(ChatPage.tsx:267-287)会把落在归档集里的 activeSessionId 弹回
   * 第一条可见会话。所以给归档行渲染「接入」按钮 = 点下去落到**另一条**会话 ——
   * 正是 W3 开头要治的那条病(2026-08-22 验收 P1,活数据实测 2 行里有 1 行归档)。
   * 拿不到 session-meta 时按空集处理:宁可多给一个可能弹走的按钮,也不静默隐藏真会话。
   */
  const [hiddenIds, setHiddenIds] = useState<ReadonlySet<string>>(new Set());

  useEffect(() => {
    let alive = true;
    const load = async (): Promise<void> => {
      try {
        const r = await fetch('/api/trace/sessions');
        if (!r.ok) return;
        const d = await r.json() as Record<string, unknown>[] | { sessions?: Record<string, unknown>[] };
        const list = Array.isArray(d) ? d : (d.sessions ?? []);
        if (!alive) return;
        setRows(list.map((it) => {
          const stats = (it['stats'] ?? {}) as Record<string, unknown>;
          return {
            rawId: String(it['rawId'] ?? ''),
            id: String(it['id'] ?? ''),
            title: String(it['title'] ?? '(未命名)'),
            createdAt: Number(it['createdAt'] ?? 0),
            cwd: String(it['cwd'] ?? ''),
            model: String(it['model'] ?? ''),
            turns: Number(stats['turns'] ?? 0),
            steps: Number(stats['steps'] ?? 0),
            llmMs: Number(stats['llmMs'] ?? 0),
            toolMs: Number(stats['toolMs'] ?? 0),
          };
        }).filter((x) => x.id !== ''));
        setLoaded(true);
      } catch { /* 后端缺席时保持空态 */ }
    };
    const loadMeta = async (): Promise<void> => {
      try {
        const r = await fetch('/api/agos/session-meta');
        if (!r.ok) return;
        const d = await r.json() as { archived?: unknown; hostArchived?: unknown };
        if (!alive) return;
        const ids = [d.archived, d.hostArchived]
          .flatMap((x) => (Array.isArray(x) ? x : []))
          .map((x) => String(x));
        setHiddenIds(new Set(ids));
      } catch { /* 后端缺席时按空集处理 */ }
    };
    void load();
    void loadMeta();
    const t = setInterval(() => { if (!document.hidden) { void load(); void loadMeta(); } }, 15_000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  /** 单一入口:哪一行可接入，由它说了算。按钮和下面那句计数读的是同一个判断。 */
  const joinIdOf = (r: TraceRow): string | undefined => {
    const id = traceJoinId(r.rawId);
    return id !== undefined && !hiddenIds.has(id) ? id : undefined;
  };
  const joinableCount = rows.filter((r) => joinIdOf(r) !== undefined).length;

  const maxTotal = Math.max(1, ...rows.map((r) => r.llmMs + r.toolMs));

  return (
    <div className="surface-page">
      <div>
        <h2 className="surface-title">会话轨迹与时间流 (Trace)</h2>
        <p className="surface-lede">
          数据源 /api/trace/sessions · 15s 轮询 · 条长相对本页最长会话，段内为 LLM / 工具耗时占比。
          {/* ⚠️ 原文是「这里的 id 来自投影缓存,与对话会话不是同一批」—— **那句是假的**:
              后端 dsh-trace-view/lib/index.js:45 就在跟 sessionPersistence.list() 取交集,
              返回的是权威名册的**子集**;实测 2 行 rawId 全部在磁盘会话目录里(2/2)。
              界面上说一句代码可证伪的假话,与它要清的「本条记录早于该字段」是同一个失败模式
              (2026-08-22 验收 P1)。*/}
          后端已与 sessionPersistence 名册取交集,所以这里每一行都是真实会话的子集。
          接入按钮只在该行带有权威 rawId(session- 前缀)、且该会话未被归档时出现 ——
          归档会话会被对话页的守卫弹回别处,那样等于落错会话。传出去的是 rawId 而不是裸 uuid。
        </p>
      </div>

      {/* ⚠️ 这里原来是一句和按钮标签一模一样的孤立「接入该会话」,只为让 OpenCLI extract
          抓得到正文(extract 读不到 <button> 文案)。它不说明任何事,而且删掉按钮它照样在,
          回归照绿 —— 等于没锁(2026-08-22 验收 P1)。改成由 joinIdOf 算出的计数:
          与按钮同源,数字变了就说明可接入集变了。按钮本身由 trace-join.test.ts 的源锁守住。 */}
      {joinableCount > 0 && (
        <p className="surface-body">
          {TRACE_JOIN_COUNT_COPY(joinableCount)}
        </p>
      )}

      {loaded && rows.length === 0 && (
        <div className="surface-empty">
          暂无会话轨迹。
        </div>
      )}

      {rows.length > 0 && (
        <div className="trace-scale" aria-hidden="true">
          <span className="u-num">0</span>
          <span className="trace-scale-rule" />
          <span className="u-num">{fmtMs(maxTotal)}</span>
        </div>
      )}

      <div className="surface-stack">
        {rows.map((r, index) => {
          const total = r.llmMs + r.toolMs;
          const llmFrac = total > 0 ? r.llmMs / total : 0;
          const joinId = joinIdOf(r);
          return (
            <div
              key={r.id}
              className="trace-row viz-enter"
              style={{ ['--i' as string]: index }}
            >
              <div className="trace-row-head">
                <span className="trace-title">
                  {r.title}
                </span>
                <span className="u-num trace-meta">
                  {r.turns} 轮 · {r.steps} 步 · {r.model}
                </span>
                {joinId !== undefined && (
                  <Button variant="ghost" size="sm" onClick={() => onSelectSession?.(joinId)}>
                    {TRACE_JOIN_COPY}
                  </Button>
                )}
              </div>
              <div className="trace-bar-row">
                <div className="viz-track trace-track" aria-hidden="true">
                  <div
                    className="trace-span"
                    style={{
                      ['--u-p' as string]: total / maxTotal,
                      ['--u-llm' as string]: llmFrac,
                    }}
                  >
                    <div className="trace-bar-llm" />
                    <div className="trace-bar-tool" />
                  </div>
                </div>
                <span className="u-num trace-meta">
                  {fmtMs(total)}
                </span>
                <span className="u-num trace-meta">
                  LLM {fmtMs(r.llmMs)} · 工具 {fmtMs(r.toolMs)}
                </span>
              </div>
            </div>
          );
        })}
      </div>

      <div className="trace-legend">
        <span><span className="trace-swatch is-llm" />LLM 推理</span>
        <span><span className="trace-swatch is-tool" />工具执行</span>
      </div>
    </div>
  );
};
