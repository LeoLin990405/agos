import { homedir } from 'node:os'
import { defaultLedgerPath } from './ledger.js'

export const DEFAULTS = {
  provider: 'stepfun',
  model: 'step-3.7-flash',
  timeoutMs: 20000,
  // 2048 而不是 256/1024:thinking 型 provider 的 reasoning 块和正文共用这份预算,
  // 1024 实测会被 reasoning 整份吃光(finish:max-tokens + blockTypes:[reasoning] → NO_TEXT 回落,2026-08-24 现网)。
  maxTokens: 2048,
  concurrency: 2,
  systemPrompt: '',
}

export function normalizeConfig(raw) {
  const src = raw && typeof raw === 'object' ? raw : {}
  return {
    provider: typeof src.provider === 'string' ? src.provider : DEFAULTS.provider,
    model: typeof src.model === 'string' ? src.model : DEFAULTS.model,
    timeoutMs: Number.isInteger(src.timeoutMs) && src.timeoutMs > 0 ? src.timeoutMs : DEFAULTS.timeoutMs,
    maxTokens: Number.isInteger(src.maxTokens) && src.maxTokens > 0 ? src.maxTokens : DEFAULTS.maxTokens,
    concurrency: Number.isInteger(src.concurrency) && src.concurrency > 0 ? src.concurrency : DEFAULTS.concurrency,
    systemPrompt: typeof src.systemPrompt === 'string' ? src.systemPrompt : '',
    auditFile: typeof src.auditFile === 'string' && src.auditFile ? src.auditFile : defaultLedgerPath(homedir()),
  }
}
