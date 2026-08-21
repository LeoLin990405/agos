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
