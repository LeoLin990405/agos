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
  // RSI(FuguNano 路线):'mean'=后验均值贪心;'thompson'=一次高斯近似 Beta 采样(探索欠采样格)。
  // 默认 mean:零行为变化;采样属实盘行为变更,须显式配置开启,且 asm 行会如实标 ranking。
  assembleSampling: 'mean',
  // 读取期半衰期(天):0=关。衰减是「读的口径」不是改史——台账一字节不动,
  // 旧胜负按 2^(-age/halfLife) 加权(FuguNano 只有手动 decay --gamma,这里补上时间维)。
  posteriorHalfLifeDays: 0,
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
    assembleSampling: src.assembleSampling === 'thompson' ? 'thompson' : DEFAULTS.assembleSampling,
    posteriorHalfLifeDays: Number.isFinite(src.posteriorHalfLifeDays) && src.posteriorHalfLifeDays > 0
      ? src.posteriorHalfLifeDays : DEFAULTS.posteriorHalfLifeDays,
    auditFile: typeof src.auditFile === 'string' && src.auditFile ? src.auditFile : defaultLedgerPath(homedir()),
  }
}

/**
 * Pin the config for one dispatch at its start (auditFile drift, P2).
 *
 * A dispatch reads the proposal, then waits on up to three 45s model streams;
 * only afterwards do its callbacks append/read the ledger. If every callback
 * re-reads the live effectiveConfig(), a settings change landing mid-flight
 * silently redirects the trial's rows — verdict, outcome, dispatch record —
 * into a DIFFERENT ledger file. Callers must snapshot once at dispatch start
 * and close their ledger callbacks over the frozen snapshot:
 *
 *   const pin = pinDispatchConfig(effectiveConfig())
 *   ... append: (r) => appendLineAsync(pin.auditFile, r) ...
 *
 * The freeze is shallow+deep enough here: all values are primitives, so
 * Object.freeze makes the snapshot immutable for the whole dispatch.
 */
export function pinDispatchConfig(rawConfig) {
  return Object.freeze(normalizeConfig(rawConfig))
}
