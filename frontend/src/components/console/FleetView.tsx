import React, { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { formatRelative } from '@/lib/time';
import {
  cancelFleetRun,
  dispatchFleet,
  fleetBatchesStore,
  fleetHostsStore,
  preflightFleetHosts,
  sleepFleetHost,
  wakeFleetHosts,
} from '@/stores/live';
import type { FleetBatch, FleetHost, FleetPowerNode, FleetRunStatus } from '@/stores/live';
import { BatchList } from '@/components/fleet/BatchList';
import { DispatchModal } from '@/components/fleet/DispatchModal';
import { HostPowerBadge } from '@/components/fleet/HostPowerBadge';
import { RemoteRunView } from '@/components/fleet/RemoteRunView';
import {
  executeFleetCostConfirmation,
  FLEET_FARM_HEADING,
  fleetFarmSource,
  fleetHostVisualState,
  fleetUncollectedCopy,
  type FleetCostConfirmation,
} from './fleet-model';
import './FleetView.css';

type FleetRun = NonNullable<FleetBatch['runs']>[number];

/** `/api/fleet/hosts` 把 SSH 探测放在请求路径上时,前端不能无限「正在读取」。 */
const HOSTS_PROBE_STALL_MS = 8_000;

export interface FleetViewProps {
  selectedBatchId?: string;
  onSelectBatch: (batchId: string | undefined) => void;
}

interface HostCardProps {
  host: FleetHost;
  power?: FleetPowerNode;
  busyAction?: string;
  actionError?: string;
  onWake: (host: string) => void;
  onPreflight: (host: string) => void;
  onSleep: (host: string) => void;
}

const HOST_RUN_LABEL: Record<FleetRunStatus, string> = {
  queued: '等待中',
  waking: '唤醒中',
  running: '运行中',
  detached: '已断连，等待重贴',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
  interrupted: '已中断',
  lost: '工作区丢失',
};

const HostCard: React.FC<HostCardProps> = ({
  host,
  power,
  busyAction,
  actionError,
  onWake,
  onPreflight,
  onSleep,
}) => {
  const visualState = fleetHostVisualState(host.ok, power);
  const reachable = visualState === 'reachable';
  const canWake = host.kind === 'remote' && power?.node !== null && power?.node !== undefined;
  const error = visualState === 'waking'
    ? power?.wakeError
    : host.error ?? power?.reachabilityError ?? power?.wakeError;
  const latestRun = host.runs.reduce<(typeof host.runs)[number] | undefined>((latest, run) => (
    latest === undefined || (run.startedAt ?? Number.NEGATIVE_INFINITY) > (latest.startedAt ?? Number.NEGATIVE_INFINITY)
      ? run
      : latest
  ), undefined);

  return (
    <article className={`fleet-view__host-card is-${visualState}`}>
      <div className="fleet-view__host-head">
        <div>
          <div className="fleet-view__node-title">
            <strong className="fleet-view__node-name">{host.name}</strong>
            <span className="fleet-view__tag">{host.kind}</span>
          </div>
          {host.model && <div className="fleet-view__model">{host.model}</div>}
        </div>
        <HostPowerBadge state={visualState} etaMs={power?.etaMs} error={error} />
      </div>

      {host.tags.length > 0 && (
        <div className="fleet-view__tags">
          {host.tags.map((tag) => <span key={tag} className="fleet-view__tag">{tag}</span>)}
        </div>
      )}

      {reachable ? (
        <>
        <div className="fleet-view__host-facts">
          <span>在飞 <strong className="u-num">{host.inflight}/{host.maxConcurrency}</strong></span>
          {host.version && <span>DSH <strong className="u-num">{host.version}</strong></span>}
          {host.wsFiles !== undefined && (
            <span>工作区文件 <strong className="u-num">{host.wsFiles === null ? '读不到' : host.wsFiles}</strong></span>
          )}
        </div>
        {host.maxConcurrency > 0 && (
          <div className="fleet-view__load" aria-hidden="true">
            <span className="viz-track fleet-view__load-track">
              <span
                className={`viz-fill${host.inflight > 0 ? '' : ' is-done'}`}
                style={{ ['--u-p' as string]: Math.min(1, host.inflight / host.maxConcurrency) }}
              />
            </span>
          </div>
        )}
        </>
      ) : (
        error && <div className="fleet-view__host-error">{error}</div>
      )}

      {reachable && latestRun && (
        <div className="fleet-view__latest-run">
          <span>最近运行 · {HOST_RUN_LABEL[latestRun.status]}</span>
          {latestRun.prompt && <strong>{latestRun.prompt}</strong>}
        </div>
      )}

      <div className="fleet-view__host-actions">
        {visualState === 'unreachable' && canWake && (
          <Button
            size="sm"
            variant="ghost"
            disabled={busyAction === `wake:${host.name}`}
            onClick={() => onWake(host.name)}
          >
            {busyAction === `wake:${host.name}` ? '请求唤醒中…' : '唤醒'}
          </Button>
        )}
        {visualState === 'unreachable' && !canWake && host.kind === 'remote' && (
          <span className="fleet-view__quiet">未配置唤醒路径</span>
        )}
        {reachable && power?.idleSleepEligible && !power.guarded && (
          <Button
            size="sm"
            variant="ghost"
            disabled={busyAction === `sleep:${host.name}`}
            onClick={() => onSleep(host.name)}
          >
            {busyAction === `sleep:${host.name}` ? '请求回睡中…' : '回睡'}
          </Button>
        )}
        {reachable && host.kind === 'remote' && (
          <Button
            size="sm"
            variant="ghost"
            className="fleet-view__cost-action"
            disabled={busyAction === `preflight:${host.name}`}
            onClick={() => onPreflight(host.name)}
          >
            {busyAction === `preflight:${host.name}` ? '预检中…' : '冒烟预检'}
          </Button>
        )}
      </div>

      {reachable && power?.idleSleepEligible && power.guarded && (
        <div className="fleet-view__guarded">
          回睡受电源护栏保护，请在运维终端执行
          <code>fleetpower off {host.name} --force</code>
        </div>
      )}
      {actionError && <div className="fleet-view__host-error" role="alert">{actionError}</div>}
      {reachable && host.probedAt > 0 && <div className="fleet-view__probe-time">SSH 探测于 {formatRelative(host.probedAt)}</div>}
    </article>
  );
};

export const FleetView: React.FC<FleetViewProps> = ({ selectedBatchId, onSelectBatch }) => {
  const hostsState = useSyncExternalStore(fleetHostsStore.subscribe, fleetHostsStore.getSnapshot);
  const batchesState = useSyncExternalStore(fleetBatchesStore.subscribe, fleetBatchesStore.getSnapshot);
  const [dispatchOpen, setDispatchOpen] = useState(false);
  const [selectedRunId, setSelectedRunId] = useState<string>();
  const [busyAction, setBusyAction] = useState<string>();
  const [actionError, setActionError] = useState<string>();
  const [hostErrors, setHostErrors] = useState<Record<string, string>>({});
  const [costConfirmation, setCostConfirmation] = useState<FleetCostConfirmation>();
  const [hostsWaitedMs, setHostsWaitedMs] = useState(0);

  const powerByHost = useMemo(
    () => new Map(hostsState.power.map((node) => [node.host, node])),
    [hostsState.power],
  );
  const selectedBatch = batchesState.batches.find((batch) => batch.batchId === selectedBatchId);
  const selectedRun = selectedBatch?.runs?.find((run) => run.runId === selectedRunId);
  const reachableCount = hostsState.hosts.filter((host) => host.ok).length;
  const hasHostData = hostsState.at > 0;
  const initialLoading = !hasHostData && (hostsState.phase === 'idle' || hostsState.phase === 'loading');
  const hostsProbeStalled = initialLoading && hostsWaitedMs >= HOSTS_PROBE_STALL_MS;

  useEffect(() => {
    if (!initialLoading) {
      setHostsWaitedMs(0);
      return undefined;
    }
    const started = Date.now();
    const handle = window.setInterval(() => {
      setHostsWaitedMs(Date.now() - started);
    }, 1_000);
    return () => window.clearInterval(handle);
  }, [initialLoading]);

  useEffect(() => {
    if (selectedRunId !== undefined && selectedBatch?.runs?.some((run) => run.runId === selectedRunId) !== true) {
      setSelectedRunId(undefined);
    }
  }, [selectedBatch, selectedRunId]);

  const runAction = async (key: string, action: () => Promise<void>, host?: string) => {
    setBusyAction(key);
    setActionError(undefined);
    if (host) setHostErrors((current) => ({ ...current, [host]: '' }));
    try {
      await action();
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      if (host) setHostErrors((current) => ({ ...current, [host]: message }));
      else setActionError(message);
    } finally {
      setBusyAction((current) => current === key ? undefined : current);
    }
  };

  const wakeHost = (host: string) => runAction(`wake:${host}`, async () => {
    const result = await wakeFleetHosts([host]);
    if (result.noWakePath.includes(host)) throw new Error(`${host} 未配置唤醒路径`);
  }, host);
  const preflightHost = (host: string) => runAction(`preflight:${host}`, async () => {
    const result = await preflightFleetHosts([host]);
    const row = result.hosts.find((candidate) => candidate.host === host);
    if (row === undefined) throw new Error('预检响应没有目标机器结果');
    if (!row.probe.ok) throw new Error(row.probe.error || 'SSH 预检未通过，后端未提供错误详情');
    if (!row.smoke.ok) throw new Error(row.smoke.error || row.smoke.code || 'headless 冒烟未通过，后端未提供错误详情');
  }, host);
  const sleepHost = (host: string) => void runAction(`sleep:${host}`, async () => {
    const result = await sleepFleetHost(host);
    if (!result.ok) throw new Error(result.error || '后端返回失败，但未提供错误详情');
  }, host);
  const cancelBatch = (batchId: string) => void runAction(batchId, async () => {
    const result = await cancelFleetRun({ batchId });
    if (result.skipped.length > 0) throw new Error(result.skipped.map((item) => `${item.runId}: ${item.reason}`).join('\n'));
  });
  const cancelRun = (run: FleetRun) => void runAction(run.runId, async () => {
    const result = await cancelFleetRun({ runId: run.runId, host: run.host });
    if (result.skipped.length > 0) throw new Error(result.skipped.map((item) => `${item.runId}: ${item.reason}`).join('\n'));
  });

  return (
    <section className="fleet-view surface-page" aria-labelledby="fleet-view-title">
      <header className="fleet-view__header">
        <div>
          <h2 id="fleet-view-title" className="fleet-view__heading">{FLEET_FARM_HEADING}</h2>
          <p className="fleet-view__source">
            {fleetFarmSource({
              hasHostData,
              hostCount: hostsState.hosts.length,
              reachableCount,
              stalled: hostsProbeStalled,
              error: hostsState.error,
            })}
          </p>
        </div>
        <div className="fleet-view__header-actions">
          <Button
            variant="ghost"
            size="sm"
            disabled={hostsState.phase === 'loading' || batchesState.phase === 'loading'}
            onClick={() => {
              fleetHostsStore.refresh();
              fleetBatchesStore.refresh();
            }}
          >
            {hostsState.phase === 'loading' ? '探测中…' : '刷新'}
          </Button>
          <Button variant="primary" size="sm" onClick={() => setDispatchOpen(true)}>派任务</Button>
        </div>
      </header>

      {(hostsState.phase === 'degraded' || batchesState.phase === 'degraded') && (
        <div className="fleet-view__notice" role="status">
          <span>
            数据更新已降级，当前保留上次成功结果。{hostsState.error ?? batchesState.error}
          </span>
          <Button size="sm" variant="ghost" onClick={() => { fleetHostsStore.refresh(); fleetBatchesStore.refresh(); }}>重试</Button>
        </div>
      )}

      {actionError && (
        <div className="fleet-view__notice" role="alert">
          <span>{actionError}</span>
          <Button size="sm" variant="ghost" onClick={() => setActionError(undefined)}>关闭</Button>
        </div>
      )}

      <div className="fleet-view__drill-grid">
        <section className="fleet-view__panel" aria-labelledby="fleet-rack-title">
          <div className="fleet-view__panel-head">
            <h3 id="fleet-rack-title">机架</h3>
            {hasHostData && <span className="u-num">{hostsState.hosts.length}</span>}
          </div>
          {initialLoading && !hostsProbeStalled && (
            <div className="fleet-view__empty" role="status">正在读取机器配置…</div>
          )}
          {hostsProbeStalled && (
            <div className="fleet-view__empty" role="alert">
              <span>/api/fleet/hosts 仍在等待 SSH 探测，机架配置尚未采集。</span>
              <Button size="sm" variant="ghost" onClick={() => fleetHostsStore.refresh()}>重试</Button>
            </div>
          )}
          {hostsState.phase === 'error' && !hasHostData && (
            <div className="fleet-view__empty" role="alert">
              <span>{fleetUncollectedCopy(hostsState.error)}</span>
              <Button size="sm" variant="ghost" onClick={() => fleetHostsStore.refresh()}>重试</Button>
            </div>
          )}
          {hasHostData && hostsState.hosts.length === 0 && (
            <div className="fleet-view__empty">未配置任何 Fleet 机器。</div>
          )}
          <div className="fleet-view__host-grid">
            {hostsState.hosts.map((host) => (
              <HostCard
                key={host.name}
                host={host}
                power={powerByHost.get(host.name)}
                busyAction={busyAction}
                actionError={hostErrors[host.name]}
                onWake={(name) => setCostConfirmation({ kind: 'wake', host: name })}
                onPreflight={(name) => setCostConfirmation({ kind: 'preflight', host: name })}
                onSleep={sleepHost}
              />
            ))}
          </div>
        </section>

        <section className="fleet-view__panel" aria-labelledby="fleet-batches-title">
          <div className="fleet-view__panel-head">
            <h3 id="fleet-batches-title">批次</h3>
            {batchesState.at > 0 && <span className="u-num">{batchesState.batches.length}</span>}
          </div>
          {batchesState.at === 0 && (batchesState.phase === 'idle' || batchesState.phase === 'loading') ? (
            <div className="fleet-view__empty" role="status">正在读取 Fleet 批次…</div>
          ) : batchesState.phase === 'error' && batchesState.at === 0 ? (
            <div className="fleet-view__empty" role="alert">
              <span>{fleetUncollectedCopy(batchesState.error)}</span>
              <Button size="sm" variant="ghost" onClick={() => fleetBatchesStore.refresh()}>重试</Button>
            </div>
          ) : (
            <BatchList
              batches={batchesState.batches}
              selectedBatchId={selectedBatchId}
              selectedRunId={selectedRunId}
              onSelectBatch={(batchId) => {
                onSelectBatch(batchId);
                if (batchId !== selectedBatchId) setSelectedRunId(undefined);
              }}
              onSelectRun={(run) => setSelectedRunId(run.runId)}
              onCancelBatch={cancelBatch}
              onCancelRun={cancelRun}
              cancelling={busyAction}
            />
          )}
        </section>
      </div>

      {selectedRun && (
        <aside className="fleet-view__live-drawer" aria-label={`${selectedRun.host} ${selectedRun.runId} 直播`}>
          <RemoteRunView
            host={selectedRun.host}
            runId={selectedRun.runId}
            onClose={() => setSelectedRunId(undefined)}
          />
        </aside>
      )}

      <DispatchModal
        open={dispatchOpen}
        hosts={hostsState.hosts}
        onClose={() => setDispatchOpen(false)}
        onDispatch={(request) => dispatchFleet(request)}
        onDispatched={(batchId) => {
          onSelectBatch(batchId);
          setSelectedRunId(undefined);
        }}
      />

      <Modal
        isOpen={costConfirmation !== undefined}
        onClose={() => setCostConfirmation(undefined)}
        title={costConfirmation?.kind === 'wake' ? '确认唤醒机器' : '确认模型冒烟预检'}
        footer={(
          <>
            <Button variant="ghost" onClick={() => setCostConfirmation(undefined)}>取消</Button>
            <Button
              variant="danger"
              onClick={() => {
                const confirmation = costConfirmation;
                setCostConfirmation(undefined);
                void executeFleetCostConfirmation(confirmation, {
                  wake: wakeHost,
                  preflight: preflightHost,
                });
              }}
            >
              确认执行
            </Button>
          </>
        )}
        maxWidth="520px"
      >
        <div className="fleet-view__cost-confirmation">
          <strong>{costConfirmation?.host}</strong>
          {costConfirmation?.kind === 'wake' ? (
            <p>
              唤醒机器后，若该机没有有效的冒烟缓存，系统会自动发起一次真实 headless 冒烟检查，
              <strong>会消耗模型额度</strong>。确认前不会发送唤醒请求。
            </p>
          ) : (
            <p>
              将请求在这台机器上执行一次真实 headless 冒烟检查，<strong>会消耗模型额度</strong>；
              若后端命中有效缓存，会返回缓存结果。确认前不会发送预检请求。
            </p>
          )}
        </div>
      </Modal>
    </section>
  );
};
