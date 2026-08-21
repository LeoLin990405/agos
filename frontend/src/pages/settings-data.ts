import type { AgosClient } from '../api-client/index.ts'
import type {
  ConfigurableProviderView,
  CredentialView,
  ModelCatalogFailure,
  ModelProviderGroup,
  SettingsNamespaceView,
} from '../contract/api/index.ts'
import type { RequestPayload, ResponseValue, RpcMethodMap } from '../contract/api/rpc-map.ts'

type ReadClient = Pick<AgosClient, 'call'>

export interface SettingsReadSnapshot {
  writable: boolean
  hasDocument: boolean
  namespaces: SettingsNamespaceView[]
  credentials: Record<string, CredentialView>
  providers: ConfigurableProviderView[]
  modelGroups: ModelProviderGroup[]
  modelFailures: ModelCatalogFailure[]
}

export type SettingSource = 'user' | 'base' | 'default' | 'protected'

export interface SettingRow {
  path: string[]
  label: string
  description?: string
  source: SettingSource
  applies: SettingsNamespaceView['applies']
  value: unknown
  protected: boolean
  structured: boolean
}

type SchemaNode = Record<string, unknown>

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function readValue<K extends keyof RpcMethodMap>(
  client: ReadClient,
  method: K,
  payload: RequestPayload<K>,
  signal?: AbortSignal,
): Promise<ResponseValue<K>> {
  const response = await client.call(method, payload, signal)
  if (!response.result.ok) throw new Error(`${method}: ${response.result.error.message}`)
  return response.result.value
}

/**
 * Read the configuration plane without invoking any mutation or discovery
 * method. The Host performs secret redaction before settings.describe returns.
 */
export async function loadSettingsSnapshot(client: ReadClient, signal?: AbortSignal): Promise<SettingsReadSnapshot> {
  const [settings, providerDirectory, modelCatalog] = await Promise.all([
    readValue(client, 'settings.describe', {}, signal),
    readValue(client, 'llm.providers', {}, signal),
    readValue(client, 'llm.models', {}, signal),
  ])
  const refs = collectCredentialRefs(settings.namespaces)
  const credentials = refs.length === 0
    ? {}
    : (await readValue(client, 'credentials.describe', { refs }, signal)).credentials

  return {
    writable: settings.writable,
    hasDocument: settings.hasDocument,
    namespaces: settings.namespaces,
    credentials,
    providers: providerDirectory.providers,
    modelGroups: modelCatalog.groups,
    modelFailures: modelCatalog.failures,
  }
}

function hasPath(root: unknown, path: readonly string[]): boolean {
  let cursor = root
  for (const segment of path) {
    if (!isRecord(cursor) || !Object.prototype.hasOwnProperty.call(cursor, segment)) return false
    cursor = cursor[segment]
  }
  return true
}

function atPath(root: unknown, path: readonly string[]): unknown {
  let cursor = root
  for (const segment of path) {
    if (!isRecord(cursor)) return undefined
    cursor = cursor[segment]
  }
  return cursor
}

function schemaEnvelope(schema: unknown): { root: SchemaNode, refs: Record<string, unknown> } | undefined {
  if (!isRecord(schema)) return undefined
  const refs = isRecord(schema.refs) ? schema.refs : {}
  const root = dereference(schema.uid ?? schema, refs)
  return root === undefined ? undefined : { root, refs }
}

function dereference(value: unknown, refs: Record<string, unknown>): SchemaNode | undefined {
  if (typeof value === 'number' || typeof value === 'string') {
    const candidate = refs[String(value)]
    return isRecord(candidate) ? candidate : undefined
  }
  return isRecord(value) ? value : undefined
}

function nodeChildren(node: SchemaNode, refs: Record<string, unknown>): Record<string, SchemaNode> | undefined {
  if (node.type === 'object' && isRecord(node.dict)) {
    const output: Record<string, SchemaNode> = {}
    for (const [key, child] of Object.entries(node.dict)) {
      const resolved = dereference(child, refs)
      if (resolved !== undefined) output[key] = resolved
    }
    return output
  }
  if (node.type === 'intersect' && Array.isArray(node.list)) {
    const output: Record<string, SchemaNode> = {}
    for (const item of node.list) {
      const resolved = dereference(item, refs)
      if (resolved === undefined) continue
      Object.assign(output, nodeChildren(resolved, refs))
    }
    return output
  }
  if ((node.type === 'transform' || node.type === 'lazy') && node.inner !== undefined) {
    const resolved = dereference(node.inner, refs)
    return resolved === undefined ? undefined : nodeChildren(resolved, refs)
  }
  return undefined
}

function nodeMeta(node: SchemaNode): Record<string, unknown> {
  return isRecord(node.meta) ? node.meta : {}
}

function sourceAt(namespace: SettingsNamespaceView, path: readonly string[]): SettingSource {
  if (hasPath(namespace.user, path)) return 'user'
  if (hasPath(namespace.base, path)) return 'base'
  return 'default'
}

/** Fail-soft projection of schemastery's serialized `{ uid, refs }` envelope. */
export function deriveSettingRows(namespace: SettingsNamespaceView): SettingRow[] {
  const envelope = schemaEnvelope(namespace.schema)
  if (envelope === undefined) return []
  const secretPaths = new Map(namespace.secrets.map((secret) => [secret.path.join('\u0000'), secret.set]))
  const rows: SettingRow[] = []

  const visit = (node: SchemaNode, path: string[], depth: number): void => {
    if (depth > 8) return
    const meta = nodeMeta(node)
    if (meta.hidden === true) return
    const secretKey = path.join('\u0000')
    const protectedValue = path.length > 0 && (secretPaths.has(secretKey) || meta.role === 'secret')
    if (protectedValue) {
      const rawDescription = meta.description
      rows.push({
        path,
        label: path.join('.'),
        ...(typeof rawDescription === 'string' ? { description: rawDescription } : {}),
        source: 'protected',
        applies: namespace.applies,
        value: secretPaths.get(secretKey) === true,
        protected: true,
        structured: false,
      })
      return
    }
    const children = nodeChildren(node, envelope.refs)
    if (children !== undefined && Object.keys(children).length > 0) {
      for (const [key, child] of Object.entries(children)) visit(child, [...path, key], depth + 1)
      return
    }
    if (path.length === 0) return
    const rawDescription = meta.description
    rows.push({
      path,
      label: path.join('.'),
      ...(typeof rawDescription === 'string' ? { description: rawDescription } : {}),
      source: sourceAt(namespace, path),
      applies: namespace.applies,
      value: atPath(namespace.value, path),
      protected: false,
      structured: node.type === 'array' || node.type === 'dict' || node.type === 'tuple'
        || isRecord(atPath(namespace.value, path)) || Array.isArray(atPath(namespace.value, path)),
    })
  }

  visit(envelope.root, [], 0)
  return rows
}

function collectApiKeyEnv(value: unknown, refs: Set<string>): void {
  if (Array.isArray(value)) {
    for (const entry of value) collectApiKeyEnv(entry, refs)
    return
  }
  if (!isRecord(value)) return
  for (const [key, entry] of Object.entries(value)) {
    if (key === 'apiKeyEnv' && typeof entry === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(entry)) refs.add(entry)
    collectApiKeyEnv(entry, refs)
  }
}

/** Credential references are names, never credential values. */
export function collectCredentialRefs(namespaces: readonly SettingsNamespaceView[]): string[] {
  const refs = new Set<string>()
  for (const namespace of namespaces) {
    collectApiKeyEnv(namespace.value, refs)
    for (const row of deriveSettingRows(namespace)) {
      if (typeof row.value !== 'string') continue
      const envelope = schemaEnvelope(namespace.schema)
      if (envelope === undefined) continue
      let node: SchemaNode | undefined = envelope.root
      for (const segment of row.path) {
        const children: Record<string, SchemaNode> | undefined = node === undefined
          ? undefined
          : nodeChildren(node, envelope.refs)
        node = children?.[segment]
      }
      if (nodeMeta(node ?? {}).role === 'credential-ref' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(row.value)) refs.add(row.value)
    }
  }
  return [...refs].slice(0, 64)
}

export function formatSettingValue(value: unknown): string {
  if (value === undefined) return '未设置'
  if (value === null) return 'null'
  if (typeof value === 'string') return value === '' ? '空字符串' : value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return '无法序列化'
  }
}
