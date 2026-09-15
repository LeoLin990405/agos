import React, { useEffect, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { fetchJsonResource, useResource } from '@/lib/useResource';
import { TRACE_JOIN_COPY, TRACE_JOIN_COUNT_COPY, traceJoinId } from './trace-join';
import {
  parseTraceSessions,
  TRACE_EMPTY_COPY,
  TRACE_LOADING_COPY,
  traceUncollectedCopy,
  type TraceRow,
} from './trace-model';

/** 轨迹视图(把 dsh-trace-view 的时间流带回自有前端):/api/trace/sessions 真数据,
 *  每会话一行 LLM/工具耗时堆叠条 + 轮次/步数,一眼读出时间去哪了。 */

const fmtMs = (ms: number): string =>
  ms <= 0 ? '0s' : ms < 1000 ? `${ms}ms` : ms < 60_000 ? `${(ms / 1000).toFixed(1)}s` : `${(ms / 60_000).toFixed(1)}m`;

const fetchTraceSessions = async (url: string, signal: AbortSignal): Promise<TraceRow[]> =>
  parseTraceSessions(await fetchJsonResource<unknown>(url, signal));

export const TraceView: React.FC<{ onSelectSession?: (id: string) => void }> = ({ onSelectSession }) => {
  const resource = useResource<TraceRow[]>({
    url: '/api/trace/sessions',
    intervalMs: 15_000,
    refreshOnFocus: true,
    fetcher: fetchTraceSessions,
  });
  const rows = resource.data ?? [];
  const collected = resource.data !== undefined;
  const isBusy = resource.status === 'idle' || resource.status === 'loading';
  /**
   * 对话页的守卫(ChatPage.tsx:267-287)会把落在归档集里的 activeSessionId 弹回
   * 第一条可见会话。所以给归档行渲染「接入」按钮 = 点下去落到**另一条**会话 ——
   * 正是 W3 开头要治的那条病(2026-08-22 验收 P1,活数据实测 2 行里有 1 行归档)。
   * 拿不到 session-meta 时按空集处理:宁可多给一个可能弹走的按钮,也不静默隐藏真会话。
   */
  const [hiddenIds, setHiddenIds] = useState<ReadonlySet<string>>(new Set());

  useEffect(() => {
    let alive = true;
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
    void loadMeta();
    const t = setInterval(() => { if (!document.hidden) void loadMeta(); }, 15_000);
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
      <header className="surface-header">
        <div>
          <h2 className="surface-title">会话轨迹与时间流 (Trace)</h2>
          <p className="surface-lede">
            数据源 <code>/api/trace/sessions</code>
            {collected ? (
              <>
                {' '}· 15s 轮询 · 条长相对本页最长会话，段内为 LLM / 工具耗时占比。
                {/* ⚠️ 原文是「这里的 id 来自投影缓存,与对话会话不是同一批」—— **那句是假的**:
                    后端 dsh-trace-view/lib/index.js:45 就在跟 sessionPersistence.list() 取交集,
                    返回的是权威名册的**子集**;实测 2 行 rawId 全部在磁盘会话目录里(2/2)。
                    界面上说一句代码可证伪的假话,与它要清的「本条记录早于该字段」是同一个失败模式
                    (2026-08-22 验收 P1)。*/}
                后端已与 sessionPersistence 名册取交集,所以这里每一行都是真实会话的子集。
                接入按钮只在该行带有权威 rawId(session- 前缀)、且该会话未被归档时出现 ——
                归档会话会被对话页的守卫弹回别处,那样等于落错会话。传出去的是 rawId 而不是裸 uuid。
              </>
            ) : (
              <> · 插件缺席或接口失败时写未采集，不装成健康空页。</>
            )}
          </p>
        </div>
        <Button size="sm" disabled={isBusy} onClick={() => resource.refresh()}>
          {isBusy ? '读取中…' : '刷新'}
        </Button>
      </header>

      {(resource.status === 'idle' || resource.status === 'loading') && !collected && (
        <p aria-live="polite" className="surface-quiet">{TRACE_LOADING_COPY}</p>
      )}

      {resource.status === 'error' && resource.error && !collected && (
        <div role="alert" className="surface-section surface-alert">
          <p>{traceUncollectedCopy(resource.error.status, resource.error.message)}</p>
          <Button size="sm" onClick={() => resource.refresh()}>重试</Button>
        </div>
      )}

      {resource.status === 'degraded' && resource.error && collected && (
        <div role="status" className="surface-status">
          暂时无法更新，保留 {resource.at ? new Date(resource.at).toLocaleString() : '上次'} 的结果：
          {traceUncollectedCopy(resource.error.status, resource.error.message)}
        </div>
      )}

      {/* ⚠️ 这里原来是一句和按钮标签一模一样的孤立「接入该会话」,只为让 OpenCLI extract
          抓得到正文(extract 读不到 <button> 文案)。它不说明任何事,而且删掉按钮它照样在,
          回归照绿 —— 等于没锁(2026-08-22 验收 P1)。改成由 joinIdOf 算出的计数:
          与按钮同源,数字变了就说明可接入集变了。按钮本身由 trace-join.test.ts 的源锁守住。 */}
      {collected && joinableCount > 0 && (
        <p className="surface-body">
          {TRACE_JOIN_COUNT_COPY(joinableCount)}
        </p>
      )}

      {collected && rows.length === 0 && (
        <div className="surface-empty">
          {TRACE_EMPTY_COPY}
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

      {rows.length > 0 && (
        <div className="trace-legend">
          <span><span className="trace-swatch is-llm" />LLM 推理</span>
          <span><span className="trace-swatch is-tool" />工具执行</span>
        </div>
      )}
    </div>
  );
};
