/** credentials domain zod schemas — AgOS membrane, aligned to DSH 0.1.2-rc.1. */

import { z } from 'zod'
import type { RequestPayload, ResponseValue } from './rpc-map.ts'
import type { Wire } from './rpc.schema.ts'
import type { CredentialInfo } from './credentials.ts'

/** One credential's configured state (no value). */
export const credentialInfoSchema = z.object({
  configured: z.boolean(),
  source: z.string().optional(),
  writable: z.boolean(),
}) satisfies z.ZodType<Wire<CredentialInfo>>

/** credentials/describe request payload (a bare array of reference names). */
export const credentialsDescribeRequestSchema = z.array(z.string()).max(64) satisfies z.ZodType<Wire<RequestPayload<'credentials/describe'>>>

/** credentials/describe response value: ref → configured state. */
export const credentialsDescribeValueSchema = z.record(z.string(), credentialInfoSchema) satisfies z.ZodType<Wire<ResponseValue<'credentials/describe'>>>
