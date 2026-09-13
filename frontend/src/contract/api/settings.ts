/**
 * settings domain contract — AgOS membrane, aligned to DSH 0.1.2-rc.1.
 * AgOS reads the redacted namespace directory (settings/describe) and opens the
 * local document (settings/openSettingsDocument). Path-addressed mutate is in
 * the membrane for the in-app editor; update/replace stay out (replace can wipe
 * secrets the wire never returned).
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

/**
 * One path-addressed edit carried by `settings/mutate`. `set` writes the
 * value at the path (creating intermediate objects); `unset` removes it. The
 * empty path addresses the section root.
 */
export type SettingsPathOpView =
  | { op: 'set'; path: string[]; value: unknown }
  | { op: 'unset'; path: string[] }

/** Settings-domain unary methods (map keys settings/* of RpcMethodMap). */
export interface SettingsApi {
  /** Describe every registered namespace (redacted layered values + serialized schema). */
  describe(request: RpcRequest<Record<string, never>>): Promise<RpcResponse<SettingsDescribeValue>>

  /** Materialize and hand the local settings document to the platform opener. */
  openSettingsDocument(request: RpcRequest<Record<string, never>>, signal: AbortSignal):
  Promise<RpcResponse<{ opened: true }>>

  /**
   * Apply path-addressed edits to one namespace's user section, resolved
   * against the section as stored — NOT against whatever the caller last
   * read. Names the field it means, so a secret the wire never returned
   * cannot be deleted as a side effect.
   */
  mutate(request: RpcRequest<{ ns: string; ops: SettingsPathOpView[]; expectedRevision?: number }>):
  Promise<RpcResponse<SettingsNamespaceView>>
}
