export interface CatalogTrimStatus {
  enabled: boolean;
  maxEntries: number;
  copy: string;
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  try {
    return await response.json() as Record<string, unknown>;
  } catch {
    return {};
  }
}

export async function fetchCatalogTrim(signal?: AbortSignal): Promise<CatalogTrimStatus> {
  const response = await fetch('/api/agos/skills/trim', { signal });
  const payload = await readJson(response);
  if (!response.ok) {
    throw new Error(typeof payload.error === 'string' ? payload.error : `HTTP ${response.status}`);
  }
  return {
    enabled: payload.enabled === true,
    maxEntries: Number.isInteger(payload.maxEntries) ? Number(payload.maxEntries) : 8,
    copy: typeof payload.copy === 'string' ? payload.copy : '目录裁剪状态未采集',
  };
}

export async function postCatalogTrim(
  enabled: boolean,
  signal?: AbortSignal,
): Promise<{ ok: true; enabled: boolean; copy: string } | { ok: false; error: string }> {
  const response = await fetch('/api/agos/skills/trim', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ enabled, confirm: true }),
    signal,
  });
  const payload = await readJson(response);
  if (!response.ok || payload.ok !== true) {
    return { ok: false, error: typeof payload.error === 'string' ? payload.error : `HTTP ${response.status}` };
  }
  return {
    ok: true,
    enabled: payload.enabled === true,
    copy: typeof payload.copy === 'string' ? payload.copy : '',
  };
}
