/** settings domain zod schemas — AgOS membrane, aligned to DSH 0.1.2-rc.1. */

import { z } from 'zod'
import type { RequestPayload, ResponseValue } from './rpc-map.ts'
import type { Wire } from './rpc.schema.ts'

/** settings/openSettingsDocument request payload (empty args). */
export const settingsOpenDocumentRequestSchema = z.object({}) satisfies z.ZodType<Wire<RequestPayload<'settings/openSettingsDocument'>>>

/** settings/openSettingsDocument response value. */
export const settingsOpenDocumentValueSchema = z.object({
  opened: z.literal(true),
}) satisfies z.ZodType<Wire<ResponseValue<'settings/openSettingsDocument'>>>
