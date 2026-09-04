/** agent-presets domain zod schemas — AgOS membrane, aligned to DSH 0.1.2-rc.1. */

import { z } from 'zod'
import type { RequestPayload, ResponseValue } from './rpc-map.ts'
import type { Wire } from './rpc.schema.ts'
import type { AgentPresetEntry } from './agent-presets.ts'

/** AgentPresetEntry row of agentPresets/list. */
export const agentPresetEntrySchema = z.object({
  id: z.string().min(1),
  trust: z.union([z.literal('system'), z.literal('user')]),
  isDefault: z.boolean(),
  name: z.string().optional(),
  description: z.string().optional(),
  broken: z.string().min(1).optional(),
}) satisfies z.ZodType<Wire<AgentPresetEntry>>

/** agentPresets/list request payload. */
export const agentPresetListRequestSchema = z.object({}) satisfies z.ZodType<Wire<RequestPayload<'agentPresets/list'>>>

/** agentPresets/list response value (AgentPresetRoster). */
export const agentPresetListValueSchema = z.object({
  presets: z.array(agentPresetEntrySchema),
  authorable: z.boolean(),
}) satisfies z.ZodType<Wire<ResponseValue<'agentPresets/list'>>>
