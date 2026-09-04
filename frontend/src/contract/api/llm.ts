/**
 * llm domain contract — AgOS membrane, aligned to DSH 0.1.2-rc.1.
 *
 * 0.1.2 split the former llm.providers into two param-less reads the client
 * joins: listProviders (live/registered adapters) and listConfigurableProviders
 * (the configurable directory). The global model list is gone — models are
 * session-scoped now (session/modelCatalog).
 */

import type { RpcRequest, RpcResponse } from './rpc.ts'

/** One live provider route with a registered adapter. */
export interface LlmProviderInfo {
  id: string
  name: string
}

/** One configurable provider directory entry. */
export interface LlmConfigurableProvider {
  provider: string
  displayName: string
  settingsNs: string
  settingsPath: readonly string[]
  declared?: boolean
}

/** llm-domain unary methods (map keys llm/* of RpcMethodMap). */
export interface LlmApi {
  /** Live provider routes able to serve a request. */
  listProviders(request: RpcRequest<Record<string, never>>): Promise<RpcResponse<LlmProviderInfo[]>>

  /** The configurable-provider directory; the client joins it with listProviders for active state. */
  listConfigurableProviders(request: RpcRequest<Record<string, never>>): Promise<RpcResponse<LlmConfigurableProvider[]>>
}
