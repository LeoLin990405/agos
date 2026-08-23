/**
 * W13 额度台账(GET /api/usage/providers,cn-capabilities 读 CodexBar 缓存)的解析与派生。纯函数,无 React。
 *
 * ⚠️ 顶层 `stale` 是**全局一个布尔**:只要最新的那一家在 30 分钟内就是 false(usage.mjs:232)。
 * 实测 2026-08-23:codex 2 分钟前、kimi/manus/stepfun **85 天前**,顶层 stale=false。
 * 把它标在每家身上就是渲染 85 天前的数字而不标陈旧 —— 数据零编造红线。所以按家陈旧度
 * 必须在这里用 `Date.parse(at) - Date.parse(raw.capturedAt)` 自算,用响应的 at 不用浏览器时钟。
 *
 * ⚠️ `remaining` 的单位每家不同:kimi=次数、manus/doubao=credits、minimax=秒、stepfun=百分比、
 * deepseek=CNY 字符串(后端测试锁死为字符串)。不统一成一个数;只在 raw 里真有单位时带单位显示。
 * glm 本次 raw.limits=[]、qwen 只有 raw.fiveHourRemaining —— 顶层三个字段全缺,就是「额度字段未采集」。
 *
 * join 键:选择器分组的 g.provider 是 DSH route id;后端 providers[].id 是 CodexBar 源 id。
 * 8 个 route id 里只有 3 个逐字相同,3 个改名,2 个(xiaomi-token-plan-sgp / longcat)CodexBar 没有来源。
 */
export interface UsageProvider {
  id: string
  label: string
  usedPct?: number
  remaining?: number | string
  resetAt?: string
  raw: Record<string, unknown> & { capturedAt?: string; remainingUnit?: string; currency?: string }
}

export interface UsagePayload {
  at: string
  stale: boolean
  source: string
  error?: string
  providers: UsageProvider[]
}

/** 与后端 usage.mjs:7 同值。 */
export const USAGE_STALE_MS = 30 * 60 * 1000

/** DSH route id → CodexBar 源 id;null = CodexBar 没有这一家的来源。未知 route id 不猜(undefined)。 */
export const USAGE_ALIAS: Readonly<Record<string, string | null>> = {
  stepfun: 'stepfun',
  qwen: 'qwen',
  doubao: 'doubao',
  'minimax-cn': 'minimax',
  'deepseek-official': 'deepseek',
  zhipu: 'glm',
  'xiaomi-token-plan-sgp': null,
  longcat: null,
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const optNum = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
const optStr = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined)

export function parseUsagePayload(value: unknown): UsagePayload {
  if (!isRecord(value) || typeof value.at !== 'string' || !Array.isArray(value.providers)) {
    throw new Error('额度响应缺少 at 或 providers')
  }
  const providers: UsageProvider[] = []
  for (const p of value.providers) {
    if (!isRecord(p) || typeof p.id !== 'string') continue
    const raw = isRecord(p.raw) ? (p.raw as UsageProvider['raw']) : {}
    providers.push({
      id: p.id,
      label: optStr(p.label) ?? p.id,
      usedPct: optNum(p.usedPct),
      remaining: optNum(p.remaining) ?? optStr(p.remaining),
      resetAt: optStr(p.resetAt),
      raw,
    })
  }
  return {
    at: value.at,
    stale: value.stale === true,
    source: optStr(value.source) ?? '来源未采集',
    error: optStr(value.error),
    providers,
  }
}

/** 这一家的数据距响应时刻多久;capturedAt 缺席或不可解析 → undefined。 */
export function providerAgeMs(p: UsageProvider, atMs: number): number | undefined {
  const captured = Date.parse(p.raw.capturedAt ?? '')
  if (!Number.isFinite(captured) || !Number.isFinite(atMs)) return undefined
  return Math.max(0, atMs - captured)
}

/** 按家陈旧:超过阈值,或根本没有采集时间。**不看顶层 stale。** */
export function isProviderStale(p: UsageProvider, atMs: number, thresholdMs: number = USAGE_STALE_MS): boolean {
  const age = providerAgeMs(p, atMs)
  return age === undefined || age > thresholdMs
}

export function ageLabel(ms: number | undefined): string {
  if (ms === undefined) return '采集时间未采集'
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 1) return '刚刚采集'
  if (minutes < 60) return `${minutes} 分钟前采集`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return `${hours} 小时前采集`
  return `${Math.floor(hours / 24)} 天前采集`
}

/** 一句只说数据里真有的东西:有 usedPct 说用了几成;否则 remaining 只在带单位时显示;否则「额度字段未采集」。 */
export function usageSummaryText(p: UsageProvider): string {
  if (p.usedPct !== undefined) return `已用 ${Math.round(p.usedPct)}%`
  if (p.remaining !== undefined) {
    const unit = p.raw.remainingUnit ?? p.raw.currency
    if (typeof unit === 'string' && unit !== '') return `剩余 ${formatRemaining(p.remaining)} ${unitLabel(unit)}`
    if (p.id === 'kimi' && typeof p.raw.limit === 'number') return `剩余 ${formatRemaining(p.remaining)} / ${p.raw.limit} 次`
    if (p.id === 'manus' && typeof p.raw.monthlyCredits === 'number') return `剩余 ${formatRemaining(p.remaining)} / ${p.raw.monthlyCredits} credits`
    if (p.id === 'doubao' && typeof p.raw.quota === 'number') return `剩余 ${formatRemaining(p.remaining)} / ${p.raw.quota}`
    return `剩余 ${formatRemaining(p.remaining)}（单位未采集）`
  }
  if (p.id === 'qwen' && typeof p.raw.fiveHourRemaining === 'number' && typeof p.raw.weeklyRemaining === 'number') {
    return `5 小时剩 ${p.raw.fiveHourRemaining} · 每周剩 ${p.raw.weeklyRemaining}`
  }
  return '额度字段未采集'
}

const formatRemaining = (v: number | string): string => (typeof v === 'number' ? String(Math.round(v * 100) / 100) : v)
const unitLabel = (u: string): string => (u === 'seconds' ? '秒' : u === 'percent' ? '%' : u)

export interface RouteUsage { provider: UsageProvider; stale: boolean; ageMs: number | undefined; summary: string }

/**
 * 给选择器分组用:route id → 这一家的额度(带按家陈旧度)。
 * 返回 null = CodexBar 没有这一家(显示「无额度源」);undefined = 未知 route id 或载荷还没到(什么都不显示)。
 */
export function usageForRoute(routeId: string, payload: UsagePayload | undefined): RouteUsage | null | undefined {
  if (payload === undefined) return undefined
  const alias = USAGE_ALIAS[routeId]
  if (alias === null) return null
  if (alias === undefined) return undefined
  const provider = payload.providers.find((p) => p.id === alias)
  if (provider === undefined) return undefined
  const atMs = Date.parse(payload.at)
  return { provider, stale: isProviderStale(provider, atMs), ageMs: providerAgeMs(provider, atMs), summary: usageSummaryText(provider) }
}
