/** llm domain zod schemas — AgOS membrane, aligned to DSH 0.1.2-rc.1. */

import { z } from 'zod'
import type { RequestPayload, ResponseValue } from './rpc-map.ts'
import type { Wire } from './rpc.schema.ts'
import type { LlmConfigurableProvider, LlmProviderInfo } from './llm.ts'

/** One live provider route. */
export const llmProviderInfoSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
}) satisfies z.ZodType<Wire<LlmProviderInfo>>

/** One configurable provider directory entry. */
export const llmConfigurableProviderSchema = z.object({
  provider: z.string().min(1),
  displayName: z.string(),
  settingsNs: z.string(),
  settingsPath: z.array(z.string()),
  declared: z.boolean().optional(),
}) satisfies z.ZodType<Wire<LlmConfigurableProvider>>

/** llm/listProviders request payload (empty args). */
export const llmListProvidersRequestSchema = z.object({}) satisfies z.ZodType<Wire<RequestPayload<'llm/listProviders'>>>

/** llm/listProviders response value. */
export const llmListProvidersValueSchema = z.array(llmProviderInfoSchema) satisfies z.ZodType<Wire<ResponseValue<'llm/listProviders'>>>

/** llm/listConfigurableProviders request payload (empty args). */
export const llmListConfigurableProvidersRequestSchema = z.object({}) satisfies z.ZodType<Wire<RequestPayload<'llm/listConfigurableProviders'>>>

/** llm/listConfigurableProviders response value. */
export const llmListConfigurableProvidersValueSchema = z.array(llmConfigurableProviderSchema) satisfies z.ZodType<Wire<ResponseValue<'llm/listConfigurableProviders'>>>
