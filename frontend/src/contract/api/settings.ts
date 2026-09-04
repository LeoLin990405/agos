/**
 * settings domain contract — AgOS membrane, aligned to DSH 0.1.2-rc.1.
 * AgOS consumes only settings/openSettingsDocument (hand the local settings
 * document to the platform text-editor opener); describe/update/replace/mutate
 * are omitted until a settings-editing surface needs them.
 */

import type { RpcRequest, RpcResponse } from './rpc.ts'

/** Settings-domain unary methods (map key settings/openSettingsDocument of RpcMethodMap). */
export interface SettingsApi {
  /** Materialize and hand the local settings document to the platform opener. */
  openSettingsDocument(request: RpcRequest<Record<string, never>>, signal: AbortSignal):
  Promise<RpcResponse<{ opened: true }>>
}
