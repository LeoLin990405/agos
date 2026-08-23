import React from 'react';
import { Chip } from '@/components/ui/Chip';
import { fetchJsonResource, useResource } from '@/lib/useResource';
import { ageLabel, isProviderStale, parseUsagePayload, providerAgeMs, usageSummaryText, type UsagePayload } from '@/lib/usage-providers';

// W13(TASK-017 第二档):全系统第一次让「花了多少 / 还剩多少」出现在界面上。只读 GET,60s 轮询。
// 陈旧度按家算、与数字同等醒目:kimi 实测 usedPct=0 但 capturedAt 是 85 天前,不标陈旧就是在说「kimi 还满额」。
const fetchUsage = async (url: string, signal: AbortSignal): Promise<UsagePayload> =>
  parseUsagePayload(await fetchJsonResource<unknown>(url, signal));

export const UsageBand: React.FC<{ enabled?: boolean }> = ({ enabled = true }) => {
  const resource = useResource<UsagePayload>({ url: '/api/usage/providers', enabled, intervalMs: 60_000, refreshOnFocus: true, fetcher: fetchUsage });
  const payload = resource.data;
  const atMs = payload ? Date.parse(payload.at) : Number.NaN;
  const respondedAt = resource.at ? new Date(resource.at).toLocaleString('zh-CN', { hour12: false }) : '未采集';
  return (
    <section className="surface-section" aria-label="额度台账">
      <h3 className="surface-h3">额度台账</h3>
      <p className="surface-quiet">
        来源 {payload?.source ?? '未采集'} · 响应于 {respondedAt}
        {payload ? ` · 后端全局 stale=${String(payload.stale)}（只看最新的一家，不代表每家；每家的陈旧度在各自格子里）` : ''}
      </p>
      {payload === undefined && resource.status !== 'error' && <p aria-live="polite" className="surface-quiet">正在读取额度台账…</p>}
      {resource.status === 'error' && payload === undefined && (
        <p role="alert" className="surface-quiet surface-status--amber"><code>/api/usage/providers</code> 未响应。</p>
      )}
      {payload?.error && (
        <p role="alert" className="surface-quiet surface-status--amber">额度源不可用：{payload.error}</p>
      )}
      {payload && payload.providers.length > 0 && (
        <ul className="surface-list">
          {payload.providers.map((p) => {
            const stale = isProviderStale(p, atMs);
            return (
              <li key={p.id} className="surface-row surface-row--inline">
                <strong className="surface-strong">{p.label}</strong>
                <span className="u-num surface-body">{usageSummaryText(p)}</span>
                <span className="surface-quiet">{ageLabel(providerAgeMs(p, atMs))}</span>
                {stale && <Chip variant="amber">陈旧</Chip>}
              </li>
            );
          })}
        </ul>
      )}
      {payload && payload.providers.length === 0 && !payload.error && <p className="surface-quiet">额度源里一家都没有。</p>}
    </section>
  );
};
