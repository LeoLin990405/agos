import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import z from '@deepseek-ai/schemastery'
import { normalizeConfig } from './config.js'

export const ROUTER_SETTINGS_NAMESPACE = settingsNamespace('agos-router')

export const RouterSettingsSchema = z.object({
  provider: z.string(),
  model: z.string(),
  systemPrompt: z.string(),
  timeoutMs: z.natural(),
  maxTokens: z.natural(),
  concurrency: z.natural(),
  assembleSampling: z.string(),
  posteriorHalfLifeDays: z.number(),
  auditFile: z.string(),
})

export function pruneEmpty(value) {
  const out = {}
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return out
  for (const key of Object.keys(value)) {
    const v = value[key]
    if (v === undefined || v === null || v === '') continue
    out[key] = v
  }
  return out
}

export function validateRouterSettings(value) {
  return normalizeConfig(pruneEmpty(value))
}

export function installRouterSettings(ctx, entry, hooks) {
  if (ctx.get('settings') === undefined) return
  installSettingsSection(ctx, ROUTER_SETTINGS_NAMESPACE, RouterSettingsSchema, entry, hooks)
}
