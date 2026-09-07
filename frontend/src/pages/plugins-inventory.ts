export const INVENTORY_COPY = '只读投影。启停仍走 profile 的 package.json 与 cordis.patch.yml。';

export function pluginDriftCopy(drift: boolean | undefined): string {
  if (drift === undefined) return '漂移未采集';
  return drift ? '与仓有漂移' : '与仓零漂移';
}

export interface PluginInventoryRow {
  id: string;
  kind: 'agos' | 'host';
  present: boolean;
  drift?: boolean;
}

export interface PluginProfileView {
  name: string;
  path: string;
  present: boolean;
  bundles?: string[];
  cordisIds: string[];
  pluginCount: number;
  plugins: PluginInventoryRow[];
}

export interface PluginsInventory {
  at: number;
  copy: string;
  writable: false;
  repoPlugins?: string;
  currentProcess?: 'web' | 'desktop';
  agos: Array<{ id: string; web: boolean; desktop: boolean; drift?: boolean }>;
  profiles: PluginProfileView[];
}

export function currentProcessCopy(process: 'web' | 'desktop' | undefined): string {
  return process === undefined ? '当前进程未采集' : `当前进程 ${process}`;
}

function pluginRows(value: unknown): PluginInventoryRow[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((row) => {
    if (!row || typeof row !== 'object') return [];
    const item = row as Record<string, unknown>;
    if (typeof item.id !== 'string' || item.id === '') return [];
    return [{
      id: item.id,
      kind: item.kind === 'agos' ? 'agos' : 'host',
      present: item.present === true,
      ...(item.drift === undefined ? {} : { drift: item.drift === true }),
    }];
  });
}

export function parsePluginsInventory(value: unknown): PluginsInventory {
  if (!value || typeof value !== 'object') {
    throw new Error('插件清单响应不是对象');
  }
  const record = value as Record<string, unknown>;
  const profiles = Array.isArray(record.profiles)
    ? record.profiles.flatMap((row) => {
      if (!row || typeof row !== 'object') return [];
      const item = row as Record<string, unknown>;
      if (typeof item.name !== 'string') return [];
      return [{
        name: item.name,
        path: typeof item.path === 'string' ? item.path : '',
        present: item.present === true,
        bundles: Array.isArray(item.bundles)
          ? item.bundles.filter((id): id is string => typeof id === 'string')
          : undefined,
        cordisIds: Array.isArray(item.cordisIds)
          ? item.cordisIds.filter((id): id is string => typeof id === 'string')
          : [],
        pluginCount: Number(item.pluginCount) || 0,
        plugins: pluginRows(item.plugins),
      }];
    })
    : [];
  return {
    at: Number(record.at) || 0,
    copy: typeof record.copy === 'string' ? record.copy : INVENTORY_COPY,
    writable: false,
    repoPlugins: typeof record.repoPlugins === 'string' ? record.repoPlugins : undefined,
    currentProcess: record.currentProcess === 'web' || record.currentProcess === 'desktop'
      ? record.currentProcess
      : undefined,
    agos: Array.isArray(record.agos)
      ? record.agos.flatMap((row) => {
        if (!row || typeof row !== 'object') return [];
        const item = row as Record<string, unknown>;
        if (typeof item.id !== 'string') return [];
        return [{
          id: item.id,
          web: item.web === true,
          desktop: item.desktop === true,
          ...(item.drift === undefined ? {} : { drift: item.drift === true }),
        }];
      })
      : [],
    profiles,
  };
}
