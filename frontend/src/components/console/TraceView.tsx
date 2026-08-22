import React, { useEffect, useState } from 'react';

/** 轨迹视图(把 dsh-trace-view 的时间流带回自有前端):/api/trace/sessions 真数据,
 *  每会话一行 LLM/工具耗时堆叠条 + 轮次/步数,一眼读出时间去哪了。 */
interface TraceRow {
  /**
   * 权威会话 id(带 `session-` 前缀)。载荷里本来就有,此前被解析丢弃。
   * 实测:裸 uuid 打 session-memory 返回 status:'empty',带前缀才 'ready' ——
   * 权威形态是带前缀的(2026-08-22 验收实测)。
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

export const TraceView: React.FC = () => {
  const [rows, setRows] = useState<TraceRow[]>([]);
  const [loaded, setLoaded] = useState(false);

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
    void load();
    const t = setInterval(() => { if (!document.hidden) void load(); }, 15_000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  const maxTotal = Math.max(1, ...rows.map((r) => r.llmMs + r.toolMs));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '18px' }}>
      <div>
        <h2 style={{ fontSize: '16px', fontWeight: 700 }}>会话轨迹与时间流 (Trace)</h2>
        <p style={{ fontSize: '12px', color: 'var(--text-tertiary)', marginTop: '2px' }}>
          数据源 /api/trace/sessions · 15s 轮询 · 条形 = LLM 推理与工具执行的耗时占比。
          {/* ⚠️ 原文是「这里的 id 来自投影缓存,与对话会话不是同一批」—— **那句是假的**:
              后端 dsh-trace-view/lib/index.js:45 就在跟 sessionPersistence.list() 取交集,
              返回的是权威名册的**子集**;实测 2 行 rawId 全部在磁盘会话目录里(2/2)。
              界面上说一句代码可证伪的假话,与它要清的「本条记录早于该字段」是同一个失败模式
              (2026-08-22 验收 P1)。*/}
          后端已与 sessionPersistence 名册取交集,所以这里每一行都是真实会话的子集。
        </p>
      </div>

      {loaded && rows.length === 0 && (
        <div style={{ padding: '40px', textAlign: 'center', color: 'var(--text-tertiary)', fontSize: '12.5px', border: '1px dashed var(--border-subtle)', borderRadius: '14px' }}>
          暂无会话轨迹。
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
        {rows.map((r) => {
          const total = r.llmMs + r.toolMs;
          const widthPct = Math.max(2, (total / maxTotal) * 100);
          const llmPct = total > 0 ? (r.llmMs / total) * 100 : 0;
          return (
            <div
              key={r.id}
              style={{
                display: 'flex', flexDirection: 'column', gap: '8px',
                padding: '13px 16px', borderRadius: '12px',
                backgroundColor: 'var(--bg-layer-1)', boxShadow: 'var(--shadow-card)',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'baseline', gap: '10px' }}>
                <span style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-primary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', flex: 1 }}>
                  {r.title}
                </span>
                <span className="u-num" style={{ fontSize: '11px', color: 'var(--text-tertiary)', flex: 'none' }}>
                  {r.turns} 轮 · {r.steps} 步 · {r.model}
                </span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                <div style={{ width: `${widthPct}%`, minWidth: '24px', height: '8px', borderRadius: '4px', overflow: 'hidden', display: 'flex', backgroundColor: 'var(--bg-layer-3)' }}>
                  <div style={{ width: `${llmPct}%`, backgroundColor: 'var(--state-running)' }} />
                  <div style={{ flex: 1, backgroundColor: 'var(--state-done)' }} />
                </div>
                <span className="u-num" style={{ fontSize: '11px', color: 'var(--text-secondary)', flex: 'none' }}>
                  {fmtMs(total)}
                </span>
                <span className="u-num" style={{ fontSize: '10.5px', color: 'var(--text-dimmed)', flex: 'none' }}>
                  LLM {fmtMs(r.llmMs)} · 工具 {fmtMs(r.toolMs)}
                </span>
              </div>
            </div>
          );
        })}
      </div>

      <div style={{ display: 'flex', gap: '14px', fontSize: '11px', color: 'var(--text-tertiary)' }}>
        <span><span style={{ display: 'inline-block', width: '9px', height: '9px', borderRadius: '3px', backgroundColor: 'var(--state-running)', marginRight: '5px' }} />LLM 推理</span>
        <span><span style={{ display: 'inline-block', width: '9px', height: '9px', borderRadius: '3px', backgroundColor: 'var(--state-done)', marginRight: '5px' }} />工具执行</span>
      </div>
    </div>
  );
};
