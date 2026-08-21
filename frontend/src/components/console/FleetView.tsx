import React from 'react';
import { Button } from '@/components/ui/Button';
import { formatRelative } from '@/lib/time';
import { fetchJsonResource, useResource, type ResourceFetcher } from '@/lib/useResource';
import {
  deriveFleetRows,
  fleetRunState,
  parseFleetHosts,
  type FleetHostsPayload,
  type FleetRun,
} from './fleet-model';
import './FleetView.css';

const HOSTS_URL = '/api/fleet/hosts';

const fetchFleetHosts: ResourceFetcher<FleetHostsPayload> = async (url, signal) =>
  parseFleetHosts(await fetchJsonResource<unknown>(url, signal));

const reachabilityText = {
  reachable: '可达',
  unreachable: '不可达',
  unknown: '未探测',
} as const;

const runStateText = {
  running: '运行中',
  completed: '已完成',
  failed: '失败',
  unknown: '状态未采集',
} as const;

const RunSummary: React.FC<{ run?: FleetRun }> = ({ run }) => {
  if (run === undefined) return <span className="fleet-view__quiet">暂无运行记录</span>;
  const state = fleetRunState(run);
  return (
    <div className="fleet-view__run">
      <div className="fleet-view__run-head">
        <span>{runStateText[state]}</span>
        {run.runId && <span className="u-num">{run.runId}</span>}
        {run.startedAt !== undefined && <span>{formatRelative(run.startedAt)}</span>}
      </div>
      {run.prompt && <div className="fleet-view__run-prompt">{run.prompt}</div>}
      {state === 'failed' && run.error && <div className="fleet-view__run-error">{run.error}</div>}
    </div>
  );
};

export const FleetView: React.FC = () => {
  const fleet = useResource<FleetHostsPayload>({
    url: HOSTS_URL,
    intervalMs: 20_000,
    fetcher: fetchFleetHosts,
  });
  const rows = fleet.data === undefined ? [] : deriveFleetRows(fleet.data.hosts);
  const initialLoading = fleet.data === undefined && (fleet.status === 'idle' || fleet.status === 'loading');
  const isRefreshing = fleet.data !== undefined && fleet.status === 'loading';

  return (
    <section className="fleet-view" aria-labelledby="fleet-view-title">
      <header className="fleet-view__header">
        <div>
          <h2 id="fleet-view-title" className="fleet-view__heading">Fleet 机器</h2>
          <p className="fleet-view__source">数据源: <code>{HOSTS_URL}</code></p>
        </div>
        <Button
          variant="ghost"
          size="sm"
          disabled={fleet.status === 'loading'}
          onClick={() => fleet.refresh(`${HOSTS_URL}?refresh=1&ws=1`)}
        >
          {fleet.status === 'loading' ? '探测中…' : '重新探测'}
        </Button>
      </header>

      {fleet.status === 'degraded' && fleet.error && (
        <div className="fleet-view__notice" role="status">
          <span>
            机器数据已降级，保留上次成功结果
            {fleet.error.status !== undefined ? ` · HTTP ${fleet.error.status}` : ''}
            {fleet.at !== undefined ? ` · ${new Date(fleet.at).toLocaleString()}` : ''}
          </span>
          <Button size="sm" variant="ghost" onClick={() => fleet.refresh()}>重试</Button>
        </div>
      )}

      {initialLoading && <p className="fleet-view__quiet" role="status">正在读取机器配置…</p>}

      {fleet.status === 'error' && fleet.data === undefined && (
        <div className="fleet-view__empty" role="alert">
          <div><code>{HOSTS_URL}</code> 未返回机器数据。</div>
          {fleet.error && <div className="fleet-view__error">{fleet.error.message}</div>}
          <Button size="sm" variant="ghost" onClick={() => fleet.refresh()}>重试</Button>
        </div>
      )}

      {fleet.data !== undefined && rows.length === 0 && (
        <div className="fleet-view__empty">
          未配置任何机器。请在 DSH 设置中的 <code>fleet.hosts</code> 配置 Fleet 主机。
        </div>
      )}

      {rows.length > 0 && (
        <div className="telemetry-table-wrap fleet-view__table-wrap">
          {isRefreshing && <div className="fleet-view__quiet" role="status">正在重新探测…</div>}
          <table className="telemetry-table fleet-view__table">
            <thead>
              <tr>
                <th scope="col">机器</th>
                <th scope="col">可达性</th>
                <th scope="col">在飞 / 上限</th>
                <th scope="col">最近运行</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((host) => (
                <tr key={host.name} className="fleet-view__row">
                  <td className="fleet-view__node">
                    <div className="fleet-view__node-title">
                      <strong className="fleet-view__node-name">{host.name}</strong>
                      {host.kind && <span className="fleet-view__tag">{host.kind}</span>}
                    </div>
                    <div className="fleet-view__meta">
                      {host.ssh && <span>ssh {host.ssh}</span>}
                      {host.model && <span>{host.model}</span>}
                      {host.workspaceFiles !== undefined && <span>工作区文件 {host.workspaceFiles}</span>}
                    </div>
                    {Array.isArray(host.tags) && host.tags.length > 0 && (
                      <div className="fleet-view__tags">
                        {host.tags.map((tag) => <span key={tag} className="fleet-view__tag">{tag}</span>)}
                      </div>
                    )}
                  </td>
                  <td className="fleet-view__status">
                    <div className="fleet-view__title-row">
                      <span
                        className={`fleet-view__state-dot is-${host.reachability}`}
                        aria-hidden="true"
                      />
                      <span>{reachabilityText[host.reachability]}</span>
                    </div>
                    {host.version && <div className="fleet-view__version u-num">{host.version}</div>}
                    {host.at !== undefined && <div className="fleet-view__probe-time">探测于 {formatRelative(host.at)}</div>}
                    {host.ok === false && host.error && <div className="fleet-view__error">{host.error}</div>}
                  </td>
                  <td>
                    {host.concurrency !== undefined
                      ? <span className="fleet-view__concurrency">{host.concurrency}</span>
                      : <span className="fleet-view__quiet">未采集</span>}
                  </td>
                  <td><RunSummary run={host.latestRun} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
};
