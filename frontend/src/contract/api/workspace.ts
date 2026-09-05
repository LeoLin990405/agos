/**
 * workspace domain contract — AgOS membrane, aligned to DSH 0.1.2-rc.1.
 *
 * 0.1.2 removed the workspace.list unary; workspace state now rides the
 * workspace/follow stream (one baseline per generation, then increments). AgOS
 * consumes the archived-session set from that baseline. Types only — no unary
 * methods enter the RpcMethodMap.
 */

import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { Branded } from '@deepseek-ai/dsh-brand'

/** Wire-side workspace id brand (structurally matches the host brand string). */
export type WorkspaceId = Branded<'WorkspaceId'>

/** One workspace row carried by the follow stream. */
export interface WorkspaceView {
  workspaceId: WorkspaceId
  path: string
  title: string
  sessionIds: SessionId[]
  createdAt: string
  updatedAt: string
}

/** Complete reconnect baseline for workspace browser state. */
export interface WorkspaceBaseline {
  items: WorkspaceView[]
  archivedSessionIds: SessionId[]
}

/** One ordered workspace change after a generation's baseline. */
export type WorkspaceFollowIncrement =
  | { type: 'upsert'; workspace: WorkspaceView }
  | { type: 'remove'; workspaceId: WorkspaceId }
  | { type: 'order'; workspaceIds: WorkspaceId[] }
  | { type: 'archived'; archivedSessionIds: SessionId[] }

/** workspace/follow stream item; every generation starts with exactly one baseline. */
export type WorkspaceFollowFrame =
  | { type: 'baseline'; value: WorkspaceBaseline }
  | WorkspaceFollowIncrement
