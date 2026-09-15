import type { AgosClient } from '../api-client/index.ts'
import type { SettingsNamespaceView, SettingsPathOpView } from '../contract/api/index.ts'
import type { SettingsReadSnapshot } from './settings-data.ts'

/** Permission's settings namespace on the host wire. */
export const PERMISSION_SETTINGS_NS = 'permission'

/** Default model selection for Agents created without an explicit model. */
export const AGENT_DEFAULT_MODEL_NS = 'agent-default-model'

/** Reserved not-a-preset key; never a write target. */
const CUSTOM_PERMISSION_PRESET = 'custom'

export interface PermissionDefaultOption {
  id: string
  label: string
}

export interface PermissionDefaultProjection {
  currentValue: string
  options: readonly PermissionDefaultOption[]
}

export interface DefaultModelProjection {
  provider: string
  model: string
  reasoningEffort: string
}

/** Path-addressed mutate built by this page. `expectedRevision` is always the ns we read. */
export interface SettingsMutateRequest {
  ns: string
  ops: SettingsPathOpView[]
  expectedRevision: number
}

export type PrepareMutateResult =
  | { ok: true, payload: SettingsMutateRequest }
  | { ok: false }

export interface SettingsWriteContext {
  writable: boolean
  namespaces: readonly SettingsNamespaceView[]
}

type SchemaNode = Record<string, unknown>

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function dereference(value: unknown, refs: Record<string, unknown>): SchemaNode | undefined {
  if (typeof value === 'number' || typeof value === 'string') {
    const candidate = refs[String(value)]
    return isRecord(candidate) ? candidate : undefined
  }
  return isRecord(value) ? value : undefined
}

function schemaEnvelope(schema: unknown): { root: SchemaNode, refs: Record<string, unknown> } | undefined {
  if (!isRecord(schema)) return undefined
  const refs = isRecord(schema.refs) ? schema.refs : {}
  const root = dereference(schema.uid ?? schema, refs)
  return root === undefined ? undefined : { root, refs }
}

function unwrap(node: SchemaNode, refs: Record<string, unknown>): SchemaNode | undefined {
  let current: SchemaNode | undefined = node
  for (let depth = 0; depth < 8; depth += 1) {
    if (current === undefined) return undefined
    if ((current.type === 'transform' || current.type === 'lazy') && current.inner !== undefined) {
      current = dereference(current.inner, refs)
      continue
    }
    return current
  }
  return current
}

function childAt(node: SchemaNode, key: string, refs: Record<string, unknown>): SchemaNode | undefined {
  const current = unwrap(node, refs)
  if (current === undefined) return undefined
  if (current.type === 'object' && isRecord(current.dict)) {
    return dereference(current.dict[key], refs)
  }
  if (current.type === 'intersect' && Array.isArray(current.list)) {
    for (const item of current.list) {
      const resolved = dereference(item, refs)
      if (resolved === undefined) continue
      const child = childAt(resolved, key, refs)
      if (child !== undefined) return child
    }
  }
  return undefined
}

function nodeAtPath(schema: unknown, path: readonly string[]): SchemaNode | undefined {
  const envelope = schemaEnvelope(schema)
  if (envelope === undefined) return undefined
  let node: SchemaNode | undefined = envelope.root
  for (const key of path) {
    if (node === undefined) return undefined
    node = childAt(node, key, envelope.refs)
  }
  return node === undefined ? undefined : unwrap(node, envelope.refs)
}

function pathsEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((segment, index) => segment === right[index])
}

function isSecretWritePath(namespace: SettingsNamespaceView, path: readonly string[]): boolean {
  if (namespace.secrets.some((secret) => pathsEqual(secret.path, path))) return true
  const meta = nodeAtPath(namespace.schema, path)?.meta
  return isRecord(meta) && meta.role === 'secret'
}

function constChoices(node: SchemaNode, refs: Record<string, unknown>): PermissionDefaultOption[] {
  const rawChoices = node.type === 'union'
    ? (Array.isArray(node.list) ? node.list : [])
    : [node]
  const options: PermissionDefaultOption[] = []
  for (const candidate of rawChoices) {
    const choice = dereference(candidate, refs)
    if (choice === undefined || choice.type !== 'const' || typeof choice.value !== 'string') continue
    if (choice.value === CUSTOM_PERMISSION_PRESET) continue
    const described = isRecord(choice.meta) ? choice.meta.description : undefined
    options.push({
      id: choice.value,
      label: typeof described === 'string' && described.length > 0 ? described : choice.value,
    })
  }
  return options
}

/**
 * Fail-soft read of the host's dynamic `defaultPreset` enum.
 * Missing or malformed descriptors are uncollected, never invented.
 */
export function parsePermissionDefault(view: SettingsNamespaceView | undefined): PermissionDefaultProjection | undefined {
  if (view === undefined) return undefined
  const value = (isRecord(view.value) ? view.value.defaultPreset : undefined)
  if (typeof value !== 'string') return undefined
  const envelope = schemaEnvelope(view.schema)
  if (envelope === undefined) return undefined
  const node = nodeAtPath(view.schema, ['defaultPreset'])
  if (node === undefined) return undefined
  const options = constChoices(node, envelope.refs)
  if (options.length === 0 || !options.some((option) => option.id === value)) return undefined
  return { currentValue: value, options }
}

/** Current provider/model from the namespace value. Absent strings stay uncollected. */
export function parseDefaultModel(view: SettingsNamespaceView | undefined): DefaultModelProjection | undefined {
  if (view === undefined || !isRecord(view.value)) return undefined
  const provider = view.value.provider
  const model = view.value.model
  if (typeof provider !== 'string' || typeof model !== 'string') return undefined
  const effort = view.value.reasoningEffort
  return {
    provider,
    model,
    reasoningEffort: typeof effort === 'string' ? effort : '',
  }
}

export function namespaceOf(
  namespaces: readonly SettingsNamespaceView[],
  ns: string,
): SettingsNamespaceView | undefined {
  return namespaces.find((entry) => entry.ns === ns)
}

export function preparePermissionMutate(
  context: SettingsWriteContext,
  preset: string,
): PrepareMutateResult {
  if (!context.writable) return { ok: false }
  const view = namespaceOf(context.namespaces, PERMISSION_SETTINGS_NS)
  if (view === undefined) return { ok: false }
  const parsed = parsePermissionDefault(view)
  if (parsed === undefined || preset === CUSTOM_PERMISSION_PRESET) return { ok: false }
  if (!parsed.options.some((option) => option.id === preset)) return { ok: false }
  const path = ['defaultPreset']
  if (isSecretWritePath(view, path)) return { ok: false }
  return {
    ok: true,
    payload: {
      ns: PERMISSION_SETTINGS_NS,
      ops: [{ op: 'set', path, value: preset }],
      expectedRevision: view.revision,
    },
  }
}

export function prepareDefaultModelMutate(
  context: SettingsWriteContext,
  input: { provider: string, model: string, reasoningEffort: string },
): PrepareMutateResult {
  if (!context.writable) return { ok: false }
  const view = namespaceOf(context.namespaces, AGENT_DEFAULT_MODEL_NS)
  if (view === undefined) return { ok: false }
  const provider = input.provider.trim()
  const model = input.model.trim()
  if (provider === '' || model === '') return { ok: false }
  const effort = input.reasoningEffort.trim()
  const ops: SettingsPathOpView[] = [
    { op: 'set', path: ['provider'], value: provider },
    { op: 'set', path: ['model'], value: model },
  ]
  if (effort === '') ops.push({ op: 'unset', path: ['reasoningEffort'] })
  else ops.push({ op: 'set', path: ['reasoningEffort'], value: effort })
  if (ops.some((op) => isSecretWritePath(view, op.path))) return { ok: false }
  return {
    ok: true,
    payload: {
      ns: AGENT_DEFAULT_MODEL_NS,
      ops,
      expectedRevision: view.revision,
    },
  }
}

/** Fold the host's redacted answer over the matching local namespace. */
export function replaceNamespaceView(
  snapshot: SettingsReadSnapshot,
  view: SettingsNamespaceView,
): SettingsReadSnapshot {
  let replaced = false
  const namespaces = snapshot.namespaces.map((entry) => {
    if (entry.ns !== view.ns) return entry
    replaced = true
    return view
  })
  return replaced ? { ...snapshot, namespaces } : snapshot
}

export async function callSettingsMutate(
  client: Pick<AgosClient, 'call'>,
  payload: SettingsMutateRequest,
): Promise<{ ok: true, view: SettingsNamespaceView } | { ok: false, message: string }> {
  const response = await client.call('settings/mutate', payload)
  if (!response.result.ok) return { ok: false, message: response.result.error.message }
  return { ok: true, view: response.result.value }
}
