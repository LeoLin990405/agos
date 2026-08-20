/** Shim for @deepseek-ai/dsh-session/types(P0 宽松版)。 */
import type { Branded } from '@deepseek-ai/dsh-brand'
export type SessionId = Branded<'session-id'>
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }
/** 与 sessions.schema.ts 的 sessionEventSchema 同形:严格信封 + 宽 data 直通。 */
export interface SessionEvent {
  type: string
  seq: number
  time: number
  data: unknown
  sourceEventSeqs?: number[]
  surfaceOp?: unknown
}
