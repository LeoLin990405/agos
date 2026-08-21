export const MAX_DISPATCH_ITEMS = 32;
export const MAX_DISPATCH_ITEM_CHARS = 8_000;
export const MAX_DISPATCH_TIMEOUT_MINUTES = 60;

export interface DispatchFormValue {
  tasks: string;
  hosts: string[];
  tag: string;
  wake: boolean;
  timeoutMinutes: string;
  label: string;
}

export interface FleetDispatchRequest {
  items: string[];
  hosts?: string[];
  tag?: string;
  wake: boolean;
  timeoutMs?: number;
  label?: string;
}

export type DispatchFormResult =
  | { ok: true; request: FleetDispatchRequest }
  | { ok: false; error: string };

/** `/fleet` compatible input: one task per line, with `;;` as an inline separator. */
export function parseDispatchItems(source: string): string[] {
  return source
    .split(/\r?\n|;;/u)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function validateDispatchForm(value: DispatchFormValue): DispatchFormResult {
  const items = parseDispatchItems(value.tasks);
  if (items.length < 1) return { ok: false, error: '请至少填写一项任务。' };
  if (items.length > MAX_DISPATCH_ITEMS) {
    return { ok: false, error: `一次最多派发 ${MAX_DISPATCH_ITEMS} 项任务。` };
  }
  const oversized = items.findIndex((item) => item.length > MAX_DISPATCH_ITEM_CHARS);
  if (oversized >= 0) {
    return { ok: false, error: `第 ${oversized + 1} 项超过 ${MAX_DISPATCH_ITEM_CHARS} 字符。` };
  }

  const label = value.label.trim();
  if (label.length > 120) return { ok: false, error: '批次名称最多 120 字符。' };

  const timeoutText = value.timeoutMinutes.trim();
  let timeoutMs: number | undefined;
  if (timeoutText !== '') {
    const minutes = Number(timeoutText);
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > MAX_DISPATCH_TIMEOUT_MINUTES) {
      return { ok: false, error: `超时必须是 1–${MAX_DISPATCH_TIMEOUT_MINUTES} 分钟的整数。` };
    }
    timeoutMs = minutes * 60_000;
  }

  const hosts = [...new Set(value.hosts.map((host) => host.trim()).filter(Boolean))];
  const tag = value.tag.trim();
  return {
    ok: true,
    request: {
      items,
      ...(hosts.length > 0 ? { hosts } : {}),
      ...(tag ? { tag } : {}),
      wake: value.wake,
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      ...(label ? { label } : {}),
    },
  };
}

export interface DispatchTargetHost {
  name: string;
  model?: string;
}

export function describeDispatchTargets(
  selectedHostNames: string[],
  hosts: DispatchTargetHost[],
  tag: string,
): string {
  if (selectedHostNames.length === 0) {
    return tag.trim() ? `带 ${tag.trim()} 标签的可用远端机器` : '调度器选择的可用远端机器';
  }
  const byName = new Map(hosts.map((host) => [host.name, host]));
  return selectedHostNames.map((name) => {
    const model = byName.get(name)?.model?.trim();
    return model ? `${name}（${model}）` : name;
  }).join('、');
}
