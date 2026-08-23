/**
 * W13 额度台账(GET /api/usage/providers,cn-capabilities 读 CodexBar 缓存)的解析与派生。纯函数,无 React。
 *
 * ⚠️ 顶层 `stale` 是**全局一个布尔**:只要最新的那一家在 30 分钟内就是 false(usage.mjs:232)。
 * ⚠️ `raw.capturedAt` **不是采集时间**:它是 CodexBar CFURL 缓存条目的 time_stamp(request_key UNIQUE,
 * 刷新只换 body 不更新时间戳),即条目**首次创建**时间。实测 claude 条目写 07-30 而 resetAt 在一小时内。
 * 第二档对抗验证抓到我第一版把它当采集时间显示「85 天前采集」——数据零编造红线。
 * 现在唯一可信的新鲜度上界是后端暴露的 `cacheMtime`(缓存文件最后一次写入);按家只显示「条目创建于 X」
 * 并明说它不是采集时间;「陈旧」只按 cacheMtime 判,且对所有来自缓存的家一视同仁。
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
  /** 缓存文件最后写入时刻(后端 stat);缺席 = 后端版本没给或文件不可读。 */
  cacheMtime?: string
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
    cacheMtime: optStr(value.cacheMtime),
    // 后端 error 串带绝对路径(CodexBar cache is unavailable: /Users/…);只留句子,不搬路径。
    error: optStr(value.error)?.replace(/:\s*\/.*$/, '').trim(),
    providers,
  }
}

/** 条目创建时刻距响应时刻多久(**不是采集时间**);capturedAt 缺席或不可解析 → undefined。 */
export function providerEntryAgeMs(p: UsageProvider, atMs: number): number | undefined {
  const captured = Date.parse(p.raw.capturedAt ?? '')
  if (!Number.isFinite(captured) || !Number.isFinite(atMs)) return undefined
  return Math.max(0, atMs - captured)
}

/** 整份缓存距最后一次写入多久;cacheMtime 缺席 → undefined(不知道,不猜)。 */
export function cacheAgeMs(payload: UsagePayload): number | undefined {
  const m = Date.parse(payload.cacheMtime ?? '')
  const at = Date.parse(payload.at)
  if (!Number.isFinite(m) || !Number.isFinite(at)) return undefined
  return Math.max(0, at - m)
}

/**
 * 陈旧度只能按整份缓存的最后写入判(按家没有采集时间可用);阈值与后端 usage.mjs:7 同值。
 * cacheMtime 缺席 → 'unknown',界面写「新鲜度未采集」,不标陈旧也不标新鲜。
 */
export function cacheFreshness(payload: UsagePayload, thresholdMs: number = USAGE_STALE_MS): 'fresh' | 'stale' | 'unknown' {
  const age = cacheAgeMs(payload)
  if (age === undefined) return 'unknown'
  return age > thresholdMs ? 'stale' : 'fresh'
}

const spanLabel = (ms: number): string => {
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 1) return '不到 1 分钟'
  if (minutes < 60) return `${minutes} 分钟`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return `${hours} 小时`
  return `${Math.floor(hours / 24)} 天`
}

/** 「缓存最后写入 N 前」——这才是能说的新鲜度。 */
export function cacheAgeLabel(payload: UsagePayload): string {
  const age = cacheAgeMs(payload)
  return age === undefined ? '缓存写入时间未采集' : `缓存最后写入 ${spanLabel(age)}前`
}

/** 「条目创建于 N 前（非采集时间）」——说清它是什么。 */
export function entryAgeLabel(ms: number | undefined): string {
  return ms === undefined ? '条目时间未采集' : `条目创建于 ${spanLabel(ms)}前（非采集时间）`
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
  // qwen 的两个 raw 字段来自 quota-config 的 standard 档:是**配额上限**,后端却命名成 *Remaining。不是剩余量。
  if (p.id === 'qwen' && typeof p.raw.fiveHourRemaining === 'number' && typeof p.raw.weeklyRemaining === 'number') {
    return `配额上限 5 小时 ${p.raw.fiveHourRemaining} · 每周 ${p.raw.weeklyRemaining}（非剩余量）`
  }
  return '额度字段未采集'
}

const formatRemaining = (v: number | string): string => (typeof v === 'number' ? String(Math.round(v * 100) / 100) : v)
const unitLabel = (u: string): string => (u === 'seconds' ? '秒' : u === 'percent' ? '%' : u)

export interface RouteUsage { provider: UsageProvider; freshness: 'fresh' | 'stale' | 'unknown'; summary: string }

/**
 * 给选择器分组用:route id → 这一家的额度(新鲜度是整份缓存的,按家没有)。
 * 返回 null = alias 表里这家没有 CodexBar 来源(显示「CodexBar 未对接」——这是 alias 表的事实,不是响应算出来的);
 * undefined = 未知 route id 或载荷还没到(什么都不显示)。
 */
export function usageForRoute(routeId: string, payload: UsagePayload | undefined): RouteUsage | null | undefined {
  if (payload === undefined) return undefined
  const alias = USAGE_ALIAS[routeId]
  if (alias === null) return null
  if (alias === undefined) return undefined
  const provider = payload.providers.find((p) => p.id === alias)
  if (provider === undefined) return undefined
  return { provider, freshness: cacheFreshness(payload), summary: usageSummaryText(provider) }
}
