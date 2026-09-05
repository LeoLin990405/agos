/** workspace domain zod schemas — AgOS membrane, aligned to DSH 0.1.2-rc.1 (follow frames). */

import { z } from 'zod'
import type { Wire } from './rpc.schema.ts'
import type { WorkspaceFollowFrame, WorkspaceId, WorkspaceView } from './workspace.ts'
import { sessionIdSchema } from './sessions.schema.ts'

/** WorkspaceId: one brand cast after non-empty string validation. */
export const workspaceIdSchema = z.string().min(1) as unknown as z.ZodType<WorkspaceId>

/** WorkspaceView row carried by follow baseline/upsert frames. */
export const workspaceViewSchema = z.object({
  workspaceId: workspaceIdSchema,
  path: z.string(),
  title: z.string(),
  sessionIds: z.array(sessionIdSchema),
  createdAt: z.string(),
  updatedAt: z.string(),
}) as unknown as z.ZodType<Wire<WorkspaceView>>

/** workspace/follow stream item: baseline | upsert | remove | order | archived. */
export const workspaceFollowFrameSchema = z.union([
  z.object({
    type: z.literal('baseline'),
    value: z.object({ items: z.array(workspaceViewSchema), archivedSessionIds: z.array(sessionIdSchema) }),
  }),
  z.object({ type: z.literal('upsert'), workspace: workspaceViewSchema }),
  z.object({ type: z.literal('remove'), workspaceId: workspaceIdSchema }),
  z.object({ type: z.literal('order'), workspaceIds: z.array(workspaceIdSchema) }),
  z.object({ type: z.literal('archived'), archivedSessionIds: z.array(sessionIdSchema) }),
]) as unknown as z.ZodType<Wire<WorkspaceFollowFrame>>
