/**
 * credentials domain contract — AgOS membrane, aligned to DSH 0.1.2-rc.1.
 * AgOS reads credential configured-state only (credentials/describe); it never
 * receives credential values, and the set/unset writes stay out of the membrane.
 */

import type { RpcRequest, RpcResponse } from './rpc.ts'

/** Configured state of one credential reference; the value itself never rides. */
export interface CredentialInfo {
  configured: boolean
  source?: string
  writable: boolean
}

/** Credentials-domain unary methods (map key credentials/describe of RpcMethodMap). */
export interface CredentialsApi {
  /** Describe the configured state of up to 64 credential references (names, never values). */
  describe(request: RpcRequest<string[]>): Promise<RpcResponse<Record<string, CredentialInfo>>>
}
