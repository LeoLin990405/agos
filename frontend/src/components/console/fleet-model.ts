export interface FleetRun {
  runId?: string;
  prompt?: string;
  startedAt?: number;
  endedAt?: number | null;
  ok?: boolean | null;
  error?: string | null;
}

export interface FleetHost {
  name: string;
  kind?: string;
  ssh?: string;
  model?: string;
  tags?: string[];
  maxConcurrency?: number;
  workspace?: string;
  workspaceDir?: string;
  at?: number;
  ok?: boolean;
  version?: string;
  error?: string;
  inflight?: number;
  currentTask?: string | null;
  runs?: FleetRun[];
  wsFiles?: number | null;
}

export interface FleetHostsPayload {
  hosts: FleetHost[];
}

export interface FleetHostRow extends FleetHost {
  reachability: 'reachable' | 'unreachable' | 'unknown';
  concurrency?: string;
  workspaceFiles?: string;
  latestRun?: FleetRun;
}

export interface FleetPowerLike {
  reachable: boolean;
  wakeState: string;
  etaMs: number;
  wakeError?: string | null;
}

export type FleetHostVisualState = 'reachable' | 'unreachable' | 'waking';
export type FleetRunLampStatus =
  | 'queued' | 'waking' | 'running' | 'detached'
  | 'completed' | 'failed' | 'cancelled' | 'interrupted' | 'lost';
export type FleetBatchLampStatus = 'running' | 'completed' | 'failed' | 'cancelled';
export type FleetLamp = 'queued' | 'running' | 'done' | 'failed';

export function fleetRunLamp(status: FleetRunLampStatus): FleetLamp {
  if (status === 'completed') return 'done';
  if (status === 'failed' || status === 'cancelled' || status === 'interrupted' || status === 'lost') return 'failed';
  if (status === 'queued') return 'queued';
  return 'running';
}

export function fleetBatchLamp(status: FleetBatchLampStatus): FleetLamp {
  if (status === 'completed') return 'done';
  if (status === 'failed' || status === 'cancelled') return 'failed';
  return 'running';
}

export interface FleetCostConfirmation {
  kind: 'wake' | 'preflight';
  host: string;
}

export async function executeFleetCostConfirmation(
  confirmation: FleetCostConfirmation | undefined,
  handlers: Record<FleetCostConfirmation['kind'], (host: string) => Promise<void>>,
): Promise<boolean> {
  if (confirmation === undefined) return false;
  await handlers[confirmation.kind](confirmation.host);
  return true;
}

/** Power snapshots are intent only; reachability remains the host SSH probe truth. */
export function fleetHostVisualState(hostOk: boolean, power?: FleetPowerLike): FleetHostVisualState {
  if (['requested', 'probing', 'waking'].includes(power?.wakeState ?? '')) return 'waking';
  return hostOk ? 'reachable' : 'unreachable';
}

/** Reject malformed route payloads instead of silently presenting an empty fleet. */
export function parseFleetHosts(value: unknown): FleetHostsPayload {
  if (typeof value !== 'object' || value === null || !Array.isArray((value as { hosts?: unknown }).hosts)) {
    throw new Error('/api/fleet/hosts 返回缺少 hosts 数组');
  }
  const hosts = (value as { hosts: unknown[] }).hosts;
  if (hosts.some((host) => typeof host !== 'object' || host === null || typeof (host as { name?: unknown }).name !== 'string')) {
    throw new Error('/api/fleet/hosts 返回了无效机器条目');
  }
  return { hosts: hosts as FleetHost[] };
}

export function deriveFleetRows(hosts: FleetHost[]): FleetHostRow[] {
  return hosts.map((host) => {
    let workspaceFiles: string | undefined;
    if (Object.hasOwn(host, 'wsFiles')) {
      workspaceFiles = host.wsFiles === null ? '读不到' : String(host.wsFiles);
    }

    const latestRun = Array.isArray(host.runs)
      ? host.runs.reduce<FleetRun | undefined>((latest, run) => {
          if (latest === undefined) return run;
          return (run.startedAt ?? Number.NEGATIVE_INFINITY) > (latest.startedAt ?? Number.NEGATIVE_INFINITY)
            ? run
            : latest;
        }, undefined)
      : undefined;

    return {
      ...host,
      reachability: host.ok === true ? 'reachable' : host.ok === false ? 'unreachable' : 'unknown',
      concurrency:
        typeof host.inflight === 'number' && typeof host.maxConcurrency === 'number'
          ? `${host.inflight}/${host.maxConcurrency}`
          : undefined,
      workspaceFiles,
      latestRun,
    };
  });
}

export function fleetRunState(run: FleetRun): 'running' | 'completed' | 'failed' | 'unknown' {
  if (run.endedAt === null) return 'running';
  if (run.ok === true) return 'completed';
  if (run.ok === false) return 'failed';
  return 'unknown';
}

/** 页面标题只说功能面。农场名必须来自采集结果，禁止写死 Homelab。 */
export const FLEET_FARM_HEADING = '机器与机架';

export function fleetPluginAbsent(error?: string): boolean {
  if (!error) return false;
  const text = error.trim();
  return /\bHTTP\s+404\b/i.test(text) || /^not found$/i.test(text) || /^404\b/.test(text);
}

export function fleetFarmSource(input: {
  hasHostData: boolean;
  hostCount: number;
  reachableCount: number;
  stalled: boolean;
  error?: string;
}): string {
  if (input.hasHostData) return `已配置 ${input.hostCount} · 可达 ${input.reachableCount}`;
  if (fleetPluginAbsent(input.error)) return '未采集';
  if (input.stalled) return 'SSH 探测未返回，机架配置尚未采集';
  if (input.error) return input.error;
  return '等待 SSH 探测结果';
}

export function fleetUncollectedCopy(error?: string): string {
  if (fleetPluginAbsent(error)) {
    const http = error?.match(/HTTP\s+(\d+)/i);
    return http ? `未采集：HTTP ${http[1]}` : '未采集';
  }
  return error || '机器数据暂不可用。';
}
