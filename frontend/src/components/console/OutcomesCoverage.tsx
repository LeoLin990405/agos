import React from 'react';
import { fetchJsonResource, useResource } from '@/lib/useResource';
import { coverageSummary, parseOutcomesPayload, type OutcomesPayload } from './outcomes-model';

// W10(TASK-017 第二档):五家台账 → 七字段结果行 + (taskType, agent) 覆盖表。只读 GET。
const fetchOutcomes = async (url: string, signal: AbortSignal): Promise<OutcomesPayload> =>
  parseOutcomesPayload(await fetchJsonResource<unknown>(url, signal));

export const OutcomesCoverage: React.FC = () => {
  const resource = useResource<OutcomesPayload>({ url: '/api/agos/routes/outcomes', fetcher: fetchOutcomes, intervalMs: 60_000 });
  const payload = resource.data;
  return (
    <section className="surface-section" aria-label="结果行覆盖">
      <h3 className="surface-h3">结果行覆盖（五家台账派生）</h3>
      <p className="surface-quiet">
        route / council / plan / civ / fleet 各自的「某个模型跑了一次任务」归一成七字段，不做语义合并：各家 taskType 词表互不对齐，合并就是编造。
        council 里被仲裁标「疑似编造」的记成失败；civ 没派任务的记成未采集；plan 的成功只表示子代理跑完，不表示目标达成。
      </p>
      {payload === undefined && resource.status !== 'error' && <p aria-live="polite" className="surface-quiet">正在读取结果行…</p>}
      {resource.status === 'error' && payload === undefined && (
        <p role="alert" className="surface-quiet surface-status--amber"><code>/api/agos/routes/outcomes</code> 未响应。</p>
      )}
      {payload && (
        <>
          <p className="surface-body">{coverageSummary(payload.grid)}</p>
          {payload.grid.cells.length === 0 ? (
            <p className="surface-quiet">还没有一条同时带 taskType、模型与结果的行。</p>
          ) : (
            <ul className="surface-list">
              {payload.grid.cells.map((c) => (
                <li key={`${c.taskType}:${c.agent}`} className="surface-row surface-row--inline">
                  <strong className="surface-strong">{c.taskType}</strong>
                  <code className="surface-code">{c.agent}</code>
                  <span className="u-num surface-quiet">成功 {c.ok} · 失败 {c.fail}</span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
};
