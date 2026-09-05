/** settings domain zod schemas — AgOS membrane, aligned to DSH 0.1.2-rc.1. */

import { z } from 'zod'
import type { RequestPayload, ResponseValue } from './rpc-map.ts'
import type { Wire } from './rpc.schema.ts'
import type { SettingsNamespaceView, SettingsSecretView } from './settings.ts'

/** One redacted secret slot. */
export const settingsSecretViewSchema = z.object({
  path: z.array(z.string()),
  set: z.boolean(),
}) satisfies z.ZodType<Wire<SettingsSecretView>>

/** SettingsNamespaceView row (schema/value/base/user stay wide JSON). */
export const settingsNamespaceViewSchema = z.object({
  ns: z.string().min(1),
  schema: z.unknown(),
  value: z.unknown(),
  base: z.unknown().optional(),
  user: z.unknown().optional(),
  applies: z.union([z.literal('live'), z.literal('restart')]),
  secrets: z.array(settingsSecretViewSchema),
  revision: z.number(),
}) satisfies z.ZodType<Wire<SettingsNamespaceView>>

/** settings/describe request payload (empty args). */
export const settingsDescribeRequestSchema = z.object({}) satisfies z.ZodType<Wire<RequestPayload<'settings/describe'>>>

/** settings/describe response value. */
export const settingsDescribeValueSchema = z.object({
  writable: z.boolean(),
  hasDocument: z.boolean(),
  namespaces: z.array(settingsNamespaceViewSchema),
}) satisfies z.ZodType<Wire<ResponseValue<'settings/describe'>>>

/** settings/openSettingsDocument request payload (empty args). */
export const settingsOpenDocumentRequestSchema = z.object({}) satisfies z.ZodType<Wire<RequestPayload<'settings/openSettingsDocument'>>>

/** settings/openSettingsDocument response value. */
export const settingsOpenDocumentValueSchema = z.object({
  opened: z.literal(true),
}) satisfies z.ZodType<Wire<ResponseValue<'settings/openSettingsDocument'>>>
