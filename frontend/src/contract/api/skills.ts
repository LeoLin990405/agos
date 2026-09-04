/**
 * skills domain contract — AgOS membrane, aligned to DSH 0.1.2-rc.1 (skills/list).
 * Read-only skill catalog addressed by session; skill invocation is an ordinary
 * session/prompt whose leading `/name` token the Host recognizes.
 */

import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { RpcRequest, RpcResponse } from './rpc.ts'

/** Skill catalog row (wire projection; provider/source vocabulary stays host-side). */
export interface SkillEntry {
  readonly name: string
  readonly description: string
  readonly whenToUse?: string
  /** False marks a user-only skill: invocable here, absent from the model catalog. */
  readonly modelInvocable: boolean
}

/** Skill-domain unary methods (map key skills/list of RpcMethodMap). */
export interface SkillsApi {
  list(request: RpcRequest<{ sessionId: SessionId }>): Promise<RpcResponse<{ skills: readonly SkillEntry[] }>>
}
