/**
 * agent-presets domain contract — AgOS membrane, aligned to DSH 0.1.2-rc.1.
 * Namespace pluralized (agentPresets/*). AgOS consumes the roster only; the
 * authoring calls (read/copy/deletePreset/openDocument/select) are omitted from
 * the membrane until a surface needs them.
 */

import type { RpcRequest, RpcResponse } from './rpc.ts'

/** One preset the deployment can compose a session's agent from. */
export interface AgentPresetEntry {
  readonly id: string
  readonly trust: 'system' | 'user'
  readonly isDefault: boolean
  readonly name?: string
  readonly description?: string
  /** Why this preset cannot compose a session; absent when it can. */
  readonly broken?: string
}

/** agent-preset-domain unary methods (map key agentPresets/* of RpcMethodMap). */
export interface AgentPresetsApi {
  /** Lists every preset the configured roots supply, with the deployment's authoring capability. */
  list(request: RpcRequest<Record<string, never>>):
  Promise<RpcResponse<{ presets: readonly AgentPresetEntry[]; authorable: boolean }>>
}
