/**
 * settings domain contract — AgOS membrane, aligned to DSH 0.1.2-rc.1.
 * AgOS reads the redacted namespace directory (settings/describe) and opens the
 * local document (settings/openSettingsDocument). Mutation (update/replace/
 * mutate) stays out of the membrane until an in-app settings editor needs it.
 */

import type { RpcRequest, RpcResponse } from './rpc.ts'

/** One schema-declared secret slot inside a redacted namespace value. */
export interface SettingsSecretView {
  path: string[]
  set: boolean
}

/** Wire view of one registered namespace, always read under redactSecrets. */
export interface SettingsNamespaceView {
  ns: string
  schema: unknown
  value: unknown
  base?: unknown
  user?: unknown
  applies: 'live' | 'restart'
  secrets: SettingsSecretView[]
  revision: number
}

/** Every registered namespace with the deployment facts a config page renders. */
export interface SettingsDescribeValue {
  writable: boolean
  hasDocument: boolean
  namespaces: SettingsNamespaceView[]
}

/** Settings-domain unary methods (map keys settings/* of RpcMethodMap). */
export interface SettingsApi {
  /** Describe every registered namespace (redacted layered values + serialized schema). */
  describe(request: RpcRequest<Record<string, never>>): Promise<RpcResponse<SettingsDescribeValue>>

  /** Materialize and hand the local settings document to the platform opener. */
  openSettingsDocument(request: RpcRequest<Record<string, never>>, signal: AbortSignal):
  Promise<RpcResponse<{ opened: true }>>
}
