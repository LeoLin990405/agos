import type { SkillStudioDraft, TriggerEvalCase } from './skills-studio-model';
import { serializeTriggerEvals } from './skills-studio-model';

export interface StudioWriteSuccess {
  created: true;
  name: string;
  path: string;
  evalsPath?: string;
  pluginStub?: string;
  pluginInstalled: false;
  root: 'user-dsh';
}

export interface StudioWriteFailure {
  created: false;
  error: string;
  code?: string;
  status: number;
}

export interface StudioSkillRecord {
  name: string;
  description: string;
  whenToUse: string;
  body: string;
  evals: TriggerEvalCase[];
  path: string;
  evalsPath?: string;
  pluginHint?: string;
  pluginStub?: string;
  root: 'user-dsh';
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  try {
    return await response.json() as Record<string, unknown>;
  } catch {
    return {};
  }
}

export async function postSkillDraft(
  draft: SkillStudioDraft,
  evals: readonly TriggerEvalCase[],
  signal?: AbortSignal,
): Promise<StudioWriteSuccess | StudioWriteFailure> {
  const response = await fetch('/api/agos/skills/draft', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: draft.name,
      description: draft.description,
      whenToUse: draft.whenToUse,
      body: draft.body,
      needsPlugin: draft.needsPlugin,
      pluginHint: draft.pluginHint,
      evals: serializeTriggerEvals(draft.name, evals).evals,
    }),
    signal,
  });
  const payload = await readJson(response);
  if (!response.ok || payload.created !== true) {
    return {
      created: false,
      status: response.status,
      code: typeof payload.code === 'string' ? payload.code : undefined,
      error: typeof payload.error === 'string' ? payload.error : `HTTP ${response.status}`,
    };
  }
  return {
    created: true,
    name: typeof payload.name === 'string' ? payload.name : draft.name,
    path: typeof payload.path === 'string' ? payload.path : '',
    evalsPath: typeof payload.evalsPath === 'string' ? payload.evalsPath : undefined,
    pluginStub: typeof payload.pluginStub === 'string' ? payload.pluginStub : undefined,
    pluginInstalled: false,
    root: 'user-dsh',
  };
}

export async function getStudioSkill(
  name: string,
  signal?: AbortSignal,
): Promise<StudioSkillRecord | StudioWriteFailure> {
  const response = await fetch(`/api/agos/skills/studio?name=${encodeURIComponent(name)}`, { signal });
  const payload = await readJson(response);
  if (!response.ok) {
    return {
      created: false,
      status: response.status,
      code: typeof payload.code === 'string' ? payload.code : undefined,
      error: typeof payload.error === 'string' ? payload.error : `HTTP ${response.status}`,
    };
  }
  const evals = Array.isArray(payload.evals)
    ? payload.evals.flatMap((row) => {
      if (typeof row !== 'object' || row === null) return [];
      const query = 'query' in row && typeof row.query === 'string' ? row.query : '';
      const shouldTrigger = 'shouldTrigger' in row && row.shouldTrigger === true;
      if (query === '') return [];
      return [{ query, shouldTrigger }];
    })
    : [];
  return {
    name: typeof payload.name === 'string' ? payload.name : name,
    description: typeof payload.description === 'string' ? payload.description : '',
    whenToUse: typeof payload.whenToUse === 'string' ? payload.whenToUse : '',
    body: typeof payload.body === 'string' ? payload.body : '',
    evals,
    path: typeof payload.path === 'string' ? payload.path : '',
    evalsPath: typeof payload.evalsPath === 'string' ? payload.evalsPath : undefined,
    pluginHint: typeof payload.pluginHint === 'string' ? payload.pluginHint : undefined,
    pluginStub: typeof payload.pluginStub === 'string' ? payload.pluginStub : undefined,
    root: 'user-dsh',
  };
}

export async function postSkillDescription(
  name: string,
  description: string,
  signal?: AbortSignal,
): Promise<{ ok: true; path: string } | StudioWriteFailure> {
  const response = await fetch('/api/agos/skills/description', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, description, confirm: true }),
    signal,
  });
  const payload = await readJson(response);
  if (!response.ok) {
    return {
      created: false,
      status: response.status,
      code: typeof payload.code === 'string' ? payload.code : undefined,
      error: typeof payload.error === 'string' ? payload.error : `HTTP ${response.status}`,
    };
  }
  return { ok: true, path: typeof payload.path === 'string' ? payload.path : '' };
}

export async function getSkillEvolve(
  query: string,
  label = '',
  signal?: AbortSignal,
): Promise<Record<string, unknown> | StudioWriteFailure> {
  const params = new URLSearchParams({ query });
  if (label.trim() !== '') params.set('label', label.trim());
  const response = await fetch(`/api/agos/skills/evolve?${params.toString()}`, { signal });
  const payload = await readJson(response);
  if (!response.ok) {
    return {
      created: false,
      status: response.status,
      code: typeof payload.code === 'string' ? payload.code : undefined,
      error: typeof payload.error === 'string' ? payload.error : `HTTP ${response.status}`,
    };
  }
  return payload;
}

export async function postSkillOutcome(
  input: { label: string; skill: string; result: 'ok' | 'fail'; source?: 'operator' | 'session-verdict' },
  signal?: AbortSignal,
): Promise<{ ok: true } | StudioWriteFailure> {
  const response = await fetch('/api/agos/skills/evolve', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      action: 'record',
      label: input.label,
      skill: input.skill,
      result: input.result,
      source: input.source ?? 'operator',
      confirm: true,
    }),
    signal,
  });
  const payload = await readJson(response);
  if (!response.ok || payload.ok !== true) {
    return {
      created: false,
      status: response.status,
      code: typeof payload.code === 'string' ? payload.code : undefined,
      error: typeof payload.error === 'string' ? payload.error : `HTTP ${response.status}`,
    };
  }
  return { ok: true };
}

export async function postSkillRerank(
  query: string,
  label = '',
  signal?: AbortSignal,
): Promise<Record<string, unknown> | StudioWriteFailure> {
  const response = await fetch('/api/agos/skills/evolve', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      action: 'propose',
      query,
      label,
      rerank: true,
      confirm: true,
    }),
    signal,
  });
  const payload = await readJson(response);
  if (!response.ok) {
    return {
      created: false,
      status: response.status,
      code: typeof payload.code === 'string' ? payload.code : undefined,
      error: typeof payload.error === 'string' ? payload.error : `HTTP ${response.status}`,
    };
  }
  return payload;
}
